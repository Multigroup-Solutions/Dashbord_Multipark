/**
 * Chamadas de voz do WhatsApp dentro do dashboard (WhatsApp Business Calling
 * API, set 2026).
 *
 * Fluxo — chamada RECEBIDA:
 *   1. webhook `calls` → `connect` (USER_INITIATED) com a oferta SDP → linha
 *      em whatsapp_calls (status `ringing`, dedup pelo id `wacid.…`);
 *   2. quem tem o WhatsApp (editar) na cidade da conversa vê o toque em
 *      qualquer página (polling curto `whatsapp.calls.incoming`);
 *   3. "Atender": o PRIMEIRO a carregar fica com a chamada (UPDATE condicional
 *      `ringing → answering`); os outros veem "atendida por X";
 *   4. o browser cria a resposta SDP (WebRTC) → servidor faz `pre_accept` e
 *      `accept` na Meta → `connected`; a oferta SDP é apagada;
 *   5. `terminate` (webhook ou "Desligar") → `ended`; não atendida → `missed`
 *      (aviso `whatsapp_missed_call` à equipa da cidade + lista "por devolver").
 *
 * Fluxo — chamada FEITA por nós (devolver):
 *   1. sem autorização válida → pedido interativo `call_permission_request`
 *      (janela de 24 h aberta) ou template (WHATSAPP_CALL_PERMISSION_TEMPLATE);
 *      a resposta chega no webhook (mensagem `call_permission_reply`);
 *   2. com autorização → oferta SDP do browser → `connect` → a resposta SDP
 *      chega no webhook (`connect` BUSINESS_INITIATED) e o browser vai buscá-la
 *      (`whatsapp.calls.state`); estados RINGING/ACCEPTED/REJECTED → terminate.
 *
 * Nunca se regista SDP nem números completos (maskPhone). O parse do webhook e
 * a lógica do serviço são testáveis sem BD (repositório injetável).
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { maskPhone } from "../shared/maskPhone";
import {
  ANSWERING_STALE_MS, CONNECTED_STALE_MS, DIALING_STALE_MS, MAX_CONNECTED_CALLS_24H, RING_TIMEOUT_MS, RING_VISIBLE_MS,
  UNANSWERED_REVOKE, UNANSWERED_WARN, appendRequestTime, canRequestPermission, dbUtcMs, effectivePermission, isLiveCallStatus,
  permissionFromReply, statusAfterMetaStatus, statusAfterTerminate, toDbUtc,
  type CallDirection, type CallStatus, type PermissionRow, type PermissionStatus,
} from "../shared/whatsappCalls";

// ─── Parse do webhook (PURO) ────────────────────────────────────────────────

export type CallWebhookEvent =
  | { kind: "connect"; callId: string; direction: CallDirection; phone: string; sdpType: string | null; sdp: string | null; timestamp: string | null; profileName: string | null }
  | { kind: "terminate"; callId: string; direction: CallDirection; phone: string; status: string | null; durationSec: number | null; timestamp: string | null; error: string | null; profileName: string | null }
  | { kind: "status"; callId: string; status: string; phone: string; timestamp: string | null }
  | { kind: "permission_reply"; phone: string; waMessageId: string | null; response: string; isPermanent: boolean; expirationTimestamp: number | null; source: string | null; timestamp: string | null };

function metaTs(ts: unknown): string | null {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return toDbUtc(n * 1000);
}

function directionOf(d: unknown): CallDirection {
  return String(d ?? "").toUpperCase() === "BUSINESS_INITIATED" ? "out" : "in";
}

/**
 * Eventos de chamada de um payload do webhook: `value.calls[]` (connect /
 * terminate), `value.statuses[]` com `type: "call"` (RINGING/ACCEPTED/REJECTED)
 * e `value.messages[]` interativas `call_permission_reply`. Eventos de OUTRO
 * phone_number_id são ignorados (mesma regra das mensagens). PURA.
 */
export function parseCallWebhook(payload: any, expectedPhoneNumberId?: string | null): { events: CallWebhookEvent[]; ignored: number } {
  const events: CallWebhookEvent[] = [];
  let ignored = 0;
  const expected = (expectedPhoneNumberId ?? "").trim() || null;
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value;
      if (!value) continue;
      const phoneNumberId = value?.metadata?.phone_number_id != null ? String(value.metadata.phone_number_id) : null;
      const calls = Array.isArray(value.calls) ? value.calls : [];
      const statuses = (Array.isArray(value.statuses) ? value.statuses : []).filter((s: any) => String(s?.type ?? "") === "call");
      const replies = (Array.isArray(value.messages) ? value.messages : []).filter(
        (m: any) => m?.type === "interactive" && m?.interactive?.type === "call_permission_reply",
      );
      if (expected && phoneNumberId && phoneNumberId !== expected) {
        ignored += calls.length + statuses.length + replies.length;
        continue;
      }
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const nameOf = (waId: string | null): string | null => {
        const c = contacts.find((x: any) => String(x?.wa_id ?? "") === String(waId ?? "")) ?? (contacts.length === 1 ? contacts[0] : null);
        const n = c?.profile?.name;
        return typeof n === "string" && n.trim() ? n.trim().slice(0, 128) : null;
      };
      const fallbackWaId = contacts[0]?.wa_id != null ? String(contacts[0].wa_id) : "";

      for (const c of calls) {
        const callId = c?.id ? String(c.id) : "";
        if (!callId) continue;
        const direction = directionOf(c?.direction);
        // Recebida: o cliente é o `from`; feita por nós: o cliente é o `to`.
        const phone = String((direction === "in" ? c?.from : c?.to) ?? fallbackWaId ?? "");
        const event = String(c?.event ?? "").toLowerCase();
        if (event === "connect") {
          events.push({
            kind: "connect", callId, direction, phone,
            sdpType: c?.session?.sdp_type ? String(c.session.sdp_type) : null,
            sdp: typeof c?.session?.sdp === "string" ? c.session.sdp : null,
            timestamp: metaTs(c?.timestamp), profileName: nameOf(phone),
          });
        } else if (event === "terminate") {
          const st = Array.isArray(c?.status) ? c.status.map(String).join(",") : c?.status != null ? String(c.status) : null;
          let durationSec: number | null = Number.isFinite(Number(c?.duration)) ? Math.max(0, Math.round(Number(c.duration))) : null;
          if (durationSec == null && Number(c?.start_time) > 0 && Number(c?.end_time) >= Number(c?.start_time)) durationSec = Number(c.end_time) - Number(c.start_time);
          const errs = Array.isArray(value.errors) ? value.errors : Array.isArray(c?.errors) ? c.errors : [];
          const e = errs[0];
          events.push({
            kind: "terminate", callId, direction, phone, status: st, durationSec,
            timestamp: metaTs(c?.timestamp),
            error: e ? `${e?.message ?? e?.title ?? "erro"}${e?.code != null ? ` (código ${e.code})` : ""}`.slice(0, 200) : null,
            profileName: nameOf(phone),
          });
        }
      }
      for (const s of statuses) {
        if (!s?.id || !s?.status) continue;
        events.push({ kind: "status", callId: String(s.id), status: String(s.status).toUpperCase(), phone: String(s?.recipient_id ?? ""), timestamp: metaTs(s?.timestamp) });
      }
      for (const m of replies) {
        const r = m?.interactive?.call_permission_reply ?? {};
        const exp = Number(r?.expiration_timestamp);
        events.push({
          kind: "permission_reply", phone: String(m?.from ?? ""), waMessageId: m?.id ? String(m.id) : null,
          response: String(r?.response ?? "").toLowerCase(), isPermanent: r?.is_permanent === true || r?.is_permanent === "true",
          expirationTimestamp: Number.isFinite(exp) && exp > 0 ? exp : null,
          source: r?.response_source ? String(r.response_source) : null, timestamp: metaTs(m?.timestamp),
        });
      }
    }
  }
  return { events, ignored };
}

// ─── Repositório (injetável) ────────────────────────────────────────────────

export interface CallRow {
  id: number;
  callId: string;
  conversationId: number | null;
  phoneE164: string;
  direction: CallDirection;
  status: string;
  sdpOffer: string | null;
  sdpAnswer: string | null;
  projectId: number | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  answeredByUserId: number | null;
  startedByUserId: number | null;
  missed: number;
  callbackDoneAt: string | null;
  metaStatus: string | null;
  endReason?: string | null;
}

export type NewCallRow = Pick<CallRow, "callId" | "phoneE164" | "direction" | "status" | "startedAt"> & Partial<CallRow>;

export interface CallRepo {
  /** Garante a conversa do número e devolve-a com a cidade (ficha → lead → reserva). */
  ensureConversation(phoneE164: string, profileName: string | null): Promise<{ conversationId: number; projectId: number | null }>;
  /** INSERT … sem duplicar (`callId` único). true = linha nova. */
  insertCall(row: NewCallRow): Promise<boolean>;
  /** Cria ou completa uma chamada nossa (sem mexer no estado se já existir). */
  upsertOutbound(row: NewCallRow): Promise<void>;
  getByCallId(callId: string): Promise<CallRow | null>;
  getById(id: number): Promise<CallRow | null>;
  /** UPDATE condicional (`status IN from`) — a base do "o primeiro ganha". */
  transition(id: number, from: readonly string[], set: Partial<CallRow>, opts?: { startedAfter?: string }): Promise<boolean>;
  markCallbacksDone(phoneE164: string, userId: number | null, at: string): Promise<number>;
  getPermission(phoneE164: string): Promise<PermissionRow | null>;
  savePermission(phoneE164: string, patch: Partial<PermissionRow> & { respondedAt?: string | null; requestedByUserId?: number | null }): Promise<void>;
  userName(userId: number | null | undefined): Promise<string | null>;
  countConnectedOutboundSince(phoneE164: string, since: string): Promise<number>;
  /** Estados das últimas chamadas feitas por nós a este número (mais recente primeiro). */
  recentOutboundStatuses(phoneE164: string, limit: number): Promise<string[]>;
  hasLiveCall(phoneE164: string): Promise<boolean>;
  /** Chamadas vivas mais antigas do que os prazos (varrimento). */
  listStale(nowMs: number): Promise<CallRow[]>;
  /** Marca o aviso de chamada perdida (1× por chamada). true = fui eu. */
  claimMissedNotice(id: number, at: string): Promise<boolean>;
  /**
   * Atividade na conversa: resumo da lista e, quando o cliente liga ou atende
   * (`inbound`), a janela de 24 h abre/renova (regra da Meta). `needsAttention`
   * (perdida) = por ler + por responder.
   */
  touchConversation(conversationId: number, patch: { at: string; preview: string; inbound: boolean; needsAttention?: boolean }): Promise<void>;
}

export interface CallApi {
  callAction(action: "pre_accept" | "accept" | "reject" | "terminate", callId: string, sdp?: string | null): Promise<{ ok: true } | { ok: false; error: string; code?: number }>;
  connectCall(toE164: string, sdpOffer: string, bizOpaque?: string | null): Promise<{ ok: true; callId: string } | { ok: false; error: string; code?: number }>;
}

export interface CallDeps {
  repo: CallRepo;
  api: CallApi;
  now?: () => number;
  notifyMissed?: (call: CallRow) => Promise<void>;
}

const nowOf = (d: CallDeps) => (d.now ? d.now() : Date.now());

/** `from` da Meta (dígitos) → E.164 (mesma normalização das mensagens). */
async function toE164(digits: string): Promise<string> {
  const { metaFromToE164 } = await import("./whatsappInbound");
  return metaFromToE164(digits) || (digits ? `+${String(digits).replace(/\D/g, "")}` : "");
}

// ─── Processamento do webhook ───────────────────────────────────────────────

export interface CallWebhookResult {
  connects: number;
  terminates: number;
  statuses: number;
  permissions: number;
  deduped: number;
  /** Chamadas recebidas perdidas neste payload (aviso depois do 200). */
  missed: number[];
}

/**
 * Aplica os eventos de chamada. Idempotente (dedup por `callId`, transições
 * condicionais). Lança se a BD falhar → a rota responde 5xx e a Meta repete.
 */
export async function applyCallEvents(events: CallWebhookEvent[], deps: CallDeps): Promise<CallWebhookResult> {
  const out: CallWebhookResult = { connects: 0, terminates: 0, statuses: 0, permissions: 0, deduped: 0, missed: [] };
  const { repo } = deps;
  const now = nowOf(deps);
  const nowS = toDbUtc(now);
  for (const ev of events) {
    if (ev.kind === "connect") {
      const phone = await toE164(ev.phone);
      if (!phone) continue;
      if (ev.direction === "in") {
        const conv = await repo.ensureConversation(phone, ev.profileName);
        const inserted = await repo.insertCall({
          callId: ev.callId, phoneE164: phone, direction: "in", status: "ringing",
          conversationId: conv.conversationId, projectId: conv.projectId,
          sdpOffer: ev.sdpType === "offer" || !ev.sdpType ? ev.sdp : null,
          startedAt: ev.timestamp ?? nowS,
        });
        if (inserted) {
          out.connects++;
          await repo.touchConversation(conv.conversationId, { at: ev.timestamp ?? nowS, preview: "📞 Chamada recebida", inbound: true });
          console.log(`[WhatsAppCalls] chamada recebida de ${maskPhone(phone)} (a tocar)`);
        } else out.deduped++;
      } else {
        // Resposta SDP da chamada feita por nós (pode chegar antes de o
        // `connect` da API ter gravado a linha → upsert).
        await repo.upsertOutbound({
          callId: ev.callId, phoneE164: phone, direction: "out", status: "dialing", startedAt: ev.timestamp ?? nowS,
          sdpAnswer: ev.sdpType === "answer" || !ev.sdpType ? ev.sdp : null,
        });
        out.connects++;
      }
    } else if (ev.kind === "status") {
      let row = await repo.getByCallId(ev.callId);
      if (!row) {
        const phone = await toE164(ev.phone);
        if (!phone) continue;
        const mapped = statusAfterMetaStatus("dialing", ev.status) ?? "dialing";
        await repo.upsertOutbound({ callId: ev.callId, phoneE164: phone, direction: "out", status: mapped, startedAt: ev.timestamp ?? nowS, metaStatus: ev.status, ...(mapped === "connected" ? { answeredAt: ev.timestamp ?? nowS } : {}) });
        out.statuses++;
        continue;
      }
      const next = statusAfterMetaStatus(row.status, ev.status);
      if (!next) { out.deduped++; continue; }
      const set: Partial<CallRow> = { status: next, metaStatus: ev.status };
      if (next === "connected") set.answeredAt = row.answeredAt ?? ev.timestamp ?? nowS;
      if (next === "rejected") Object.assign(set, { endedAt: ev.timestamp ?? nowS, sdpOffer: null, sdpAnswer: null });
      if (await repo.transition(row.id, [row.status], set)) {
        out.statuses++;
        if (next === "connected" && row.direction === "out") {
          await repo.markCallbacksDone(row.phoneE164, row.startedByUserId, nowS);
          // O cliente atendeu a nossa chamada → a janela de 24 h renova (Meta).
          if (row.conversationId) await repo.touchConversation(row.conversationId, { at: ev.timestamp ?? nowS, preview: "📞 Chamada efetuada", inbound: true });
        }
      }
    } else if (ev.kind === "terminate") {
      let row = await repo.getByCallId(ev.callId);
      if (!row) {
        // Nunca vimos o `connect` (perdido/antigo): regista na mesma, já terminada.
        const phone = await toE164(ev.phone);
        if (!phone) continue;
        const conv = ev.direction === "in" ? await repo.ensureConversation(phone, ev.profileName) : null;
        await repo.insertCall({
          callId: ev.callId, phoneE164: phone, direction: ev.direction, status: ev.direction === "in" ? "ringing" : "dialing",
          conversationId: conv?.conversationId ?? null, projectId: conv?.projectId ?? null, startedAt: ev.timestamp ?? nowS,
        });
        row = await repo.getByCallId(ev.callId);
        if (!row) continue;
      }
      // Até 2 tentativas: outro pedido pode ter mudado o estado entretanto.
      for (let attempt = 0; attempt < 2 && row; attempt++) {
        if (!isLiveCallStatus(row.status)) { out.deduped++; break; }
        const final = statusAfterTerminate(row.status, row.direction, ev.status);
        const endedAt = ev.timestamp ?? nowS;
        let durationSec = final === "ended" ? ev.durationSec : null;
        if (final === "ended" && durationSec == null && row.answeredAt) {
          const a = dbUtcMs(row.answeredAt);
          const e = dbUtcMs(endedAt);
          if (a != null && e != null) durationSec = Math.max(0, Math.round((e - a) / 1000));
        }
        const set: Partial<CallRow> = {
          status: final, endedAt, durationSec, sdpOffer: null, sdpAnswer: null, metaStatus: ev.status,
          missed: row.direction === "in" && final === "missed" ? 1 : 0,
          ...(ev.error ? { endReason: ev.error } : {}),
        };
        if (await repo.transition(row.id, [row.status], set)) {
          out.terminates++;
          if (row.direction === "in" && final === "missed") {
            out.missed.push(row.id);
            if (row.conversationId) await repo.touchConversation(row.conversationId, { at: endedAt, preview: "📞 Chamada perdida", inbound: false, needsAttention: true });
          }
          break;
        }
        row = await repo.getById(row.id);
      }
    } else if (ev.kind === "permission_reply") {
      const phone = await toE164(ev.phone);
      if (!phone) continue;
      const p = permissionFromReply({ response: ev.response, isPermanent: ev.isPermanent, expirationTimestamp: ev.expirationTimestamp }, now);
      await repo.savePermission(phone, { status: p.status, expiresAt: p.expiresAt, isPermanent: p.isPermanent ? 1 : 0, respondedAt: ev.timestamp ?? nowS });
      out.permissions++;
      console.log(`[WhatsAppCalls] autorização de ${maskPhone(phone)}: ${p.status}`);
    }
  }
  return out;
}

// ─── Atender / recusar / desligar ───────────────────────────────────────────

export type ClaimResult =
  | { ok: true; call: CallRow; sdpOffer: string }
  | { ok: false; reason: "answered" | "gone" | "expired"; message: string; answeredByName?: string | null };

/**
 * "Atender": o PRIMEIRO a carregar fica com a chamada — UPDATE condicional
 * `ringing → answering` (só uma linha afetada ganha). Os outros recebem
 * "atendida por X". Chamada a tocar há demasiado tempo → perdida.
 */
export async function claimCall(id: number, userId: number, deps: CallDeps): Promise<ClaimResult> {
  const { repo } = deps;
  const now = nowOf(deps);
  const row = await repo.getById(id);
  if (!row || row.direction !== "in") return { ok: false, reason: "gone", message: "Chamada não encontrada." };
  const cutoff = toDbUtc(now - RING_TIMEOUT_MS);
  const won = row.status === "ringing" && !!row.sdpOffer
    && await repo.transition(id, ["ringing"], { status: "answering", answeredByUserId: userId, answeredAt: toDbUtc(now) }, { startedAfter: cutoff });
  if (won) {
    const fresh = (await repo.getById(id)) ?? row;
    return { ok: true, call: fresh, sdpOffer: row.sdpOffer! };
  }
  const cur = (await repo.getById(id)) ?? row;
  if (cur.answeredByUserId && cur.answeredByUserId !== userId && cur.status !== "ringing") {
    const name = await repo.userName(cur.answeredByUserId);
    const verb = cur.status === "rejected" ? "recusada" : "atendida";
    return { ok: false, reason: "answered", message: `Chamada ${verb} por ${name ?? "outra pessoa"}.`, answeredByName: name };
  }
  if (cur.status === "ringing") return { ok: false, reason: "expired", message: "A chamada já deixou de tocar." };
  return { ok: false, reason: "gone", message: "A chamada já terminou." };
}

/** O browser não conseguiu (microfone negado, etc.) → volta a tocar para os outros. */
export async function releaseCall(id: number, userId: number, deps: CallDeps): Promise<boolean> {
  const row = await deps.repo.getById(id);
  if (!row || row.answeredByUserId !== userId || row.status !== "answering") return false;
  return deps.repo.transition(id, ["answering"], { status: "ringing", answeredByUserId: null, answeredAt: null });
}

/** Resposta SDP do browser → pre_accept + accept na Meta. */
export async function answerCall(id: number, userId: number, sdpAnswer: string, deps: CallDeps): Promise<{ ok: true } | { ok: false; error: string }> {
  const { repo, api } = deps;
  const row = await repo.getById(id);
  if (!row || row.status !== "answering" || row.answeredByUserId !== userId) return { ok: false, error: "Esta chamada já não está contigo." };
  const pre = await api.callAction("pre_accept", row.callId, sdpAnswer);
  if (!pre.ok) {
    await repo.transition(id, ["answering"], { status: "failed", endedAt: toDbUtc(nowOf(deps)), sdpOffer: null, endReason: pre.error.slice(0, 200) });
    await api.callAction("reject", row.callId).catch(() => undefined);
    return { ok: false, error: `Não foi possível atender: ${pre.error}` };
  }
  const acc = await api.callAction("accept", row.callId, sdpAnswer);
  if (!acc.ok) {
    await repo.transition(id, ["answering"], { status: "failed", endedAt: toDbUtc(nowOf(deps)), sdpOffer: null, endReason: acc.error.slice(0, 200) });
    await api.callAction("terminate", row.callId).catch(() => undefined);
    return { ok: false, error: `Não foi possível atender: ${acc.error}` };
  }
  // `answering → connected`; se a Meta já mandou terminate entretanto, fica como está.
  await repo.transition(id, ["answering"], { status: "connected", answeredAt: toDbUtc(nowOf(deps)), sdpOffer: null });
  return { ok: true };
}

/** "Recusar" (só enquanto toca). */
export async function rejectCall(id: number, userId: number, deps: CallDeps): Promise<{ ok: true } | { ok: false; error: string }> {
  const { repo, api } = deps;
  const row = await repo.getById(id);
  if (!row || row.direction !== "in") return { ok: false, error: "Chamada não encontrada." };
  const won = await repo.transition(id, ["ringing"], { status: "rejected", answeredByUserId: userId, endedAt: toDbUtc(nowOf(deps)), sdpOffer: null });
  if (!won) {
    const cur = await repo.getById(id);
    const name = cur?.answeredByUserId && cur.answeredByUserId !== userId ? await repo.userName(cur.answeredByUserId) : null;
    return { ok: false, error: name ? `Chamada já atendida por ${name}.` : "A chamada já não está a tocar." };
  }
  const res = await api.callAction("reject", row.callId);
  return res.ok ? { ok: true } : { ok: false, error: `Recusada no dashboard, mas a Meta respondeu: ${res.error}` };
}

/** "Desligar" — só quem está na chamada (ou super admin). */
export async function hangupCall(id: number, user: { id: number; role: string }, deps: CallDeps): Promise<{ ok: true } | { ok: false; error: string }> {
  const { repo, api } = deps;
  const row = await repo.getById(id);
  if (!row) return { ok: false, error: "Chamada não encontrada." };
  const mine = row.answeredByUserId === user.id || row.startedByUserId === user.id || user.role === "super_admin";
  if (!mine) return { ok: false, error: "Só quem está na chamada a pode desligar." };
  if (!isLiveCallStatus(row.status)) return { ok: true };
  const res = await api.callAction("terminate", row.callId);
  const now = nowOf(deps);
  const final: CallStatus = row.status === "connected" ? "ended" : row.direction === "out" ? "missed" : "failed";
  let durationSec: number | null = null;
  if (final === "ended" && row.answeredAt) {
    const a = dbUtcMs(row.answeredAt);
    if (a != null) durationSec = Math.max(0, Math.round((now - a) / 1000));
  }
  await repo.transition(id, [row.status], { status: final, endedAt: toDbUtc(now), durationSec, sdpOffer: null, sdpAnswer: null });
  return res.ok || res.code === 138002 ? { ok: true } : { ok: false, error: `Desligado no dashboard; a Meta respondeu: ${res.error}` };
}

/** Estado da chamada (polling da UI durante a chamada). Só o dono recebe a resposta SDP. */
export async function callState(id: number, userId: number, deps: CallDeps) {
  const row = await deps.repo.getById(id);
  if (!row) return null;
  const mine = row.answeredByUserId === userId || row.startedByUserId === userId;
  return {
    id: row.id,
    status: row.status as CallStatus,
    direction: row.direction,
    answeredAt: row.answeredAt,
    endedAt: row.endedAt,
    durationSec: row.durationSec,
    sdpAnswer: mine && row.direction === "out" && isLiveCallStatus(row.status) ? row.sdpAnswer : null,
    answeredByName: row.answeredByUserId && !mine ? await deps.repo.userName(row.answeredByUserId) : null,
  };
}

// ─── Ligar ao cliente (chamada feita por nós) ──────────────────────────────

export interface PermissionInfo {
  status: PermissionStatus;
  expiresAt: string | null;
  valid: boolean;
  canRequest: boolean;
  requestBlockedReason: string | null;
  connectedLast24h: number;
  unansweredStreak: number;
  warning: string | null;
  source: "meta" | "local";
}

/** Autorização (Meta quando responde; senão a guardada) + limites. */
export async function permissionInfo(
  phoneE164: string,
  deps: CallDeps & { remote?: (phone: string) => Promise<{ ok: true; data: { status: string; expiresAt: number | null; canRequest: boolean | null } } | { ok: false; error: string }> },
): Promise<PermissionInfo> {
  const { repo } = deps;
  const now = nowOf(deps);
  const local = await repo.getPermission(phoneE164);
  let eff = effectivePermission(local, now);
  let source: PermissionInfo["source"] = "local";
  let remoteCanRequest: boolean | null = null;
  if (deps.remote) {
    const r = await deps.remote(phoneE164).catch(() => null);
    if (r && r.ok) {
      source = "meta";
      remoteCanRequest = r.data.canRequest;
      if (r.data.status === "permanent" || r.data.status === "temporary") {
        const expiresAt = r.data.expiresAt ? toDbUtc(r.data.expiresAt) : null;
        eff = { status: r.data.status as PermissionStatus, expiresAt, valid: r.data.status === "permanent" || (r.data.expiresAt ?? 0) > now };
        if (!local || local.status !== r.data.status || local.expiresAt !== expiresAt) {
          await repo.savePermission(phoneE164, { status: r.data.status, expiresAt, isPermanent: r.data.status === "permanent" ? 1 : 0 }).catch(() => undefined);
        }
      } else if (eff.valid) {
        // A Meta diz que já não há (revogada / 4 chamadas sem resposta).
        eff = { status: "none", expiresAt: null, valid: false };
        await repo.savePermission(phoneE164, { status: "none", expiresAt: null, isPermanent: 0 }).catch(() => undefined);
      }
    }
  }
  const limit = canRequestPermission(local?.requestTimes ?? null, now);
  let canRequest = !eff.valid && limit.ok && remoteCanRequest !== false;
  let reason: string | null = eff.valid ? null : !limit.ok ? limit.reason : remoteCanRequest === false ? "A Meta não permite enviar outro pedido de autorização agora (limite de 1 por 24 h / 2 por 7 dias)." : null;
  if (eff.status === "permanent") { canRequest = false; reason = null; }
  const connectedLast24h = await repo.countConnectedOutboundSince(phoneE164, toDbUtc(now - 86_400_000));
  const recent = await repo.recentOutboundStatuses(phoneE164, UNANSWERED_REVOKE);
  let unansweredStreak = 0;
  for (const s of recent) { if (s === "missed") unansweredStreak++; else break; }
  const warning = unansweredStreak >= UNANSWERED_WARN
    ? `${unansweredStreak} chamadas seguidas sem resposta: à ${UNANSWERED_REVOKE}.ª a Meta retira a autorização do cliente.`
    : null;
  return { status: eff.status, expiresAt: eff.expiresAt, valid: eff.valid, canRequest, requestBlockedReason: reason, connectedLast24h, unansweredStreak, warning, source };
}

/** Pode ligar agora? Mensagem PT-PT se não. PURA. */
export function callBlockedReason(p: Pick<PermissionInfo, "valid" | "connectedLast24h">, liveCall: boolean): string | null {
  if (liveCall) return "Já há uma chamada em curso com este cliente.";
  if (!p.valid) return "O cliente ainda não autorizou chamadas (ou a autorização expirou). Pede autorização primeiro.";
  if (p.connectedLast24h >= MAX_CONNECTED_CALLS_24H) return `Limite da Meta: ${MAX_CONNECTED_CALLS_24H} chamadas ligadas em 24 h para este cliente.`;
  return null;
}

/** "Ligar": valida autorização/limites e faz `connect` com a oferta SDP do browser. */
export async function startCall(
  input: { conversationId: number; phoneE164: string; projectId: number | null; sdpOffer: string; userId: number },
  deps: CallDeps & { permission: PermissionInfo },
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const { repo, api } = deps;
  const live = await repo.hasLiveCall(input.phoneE164);
  const blocked = callBlockedReason(deps.permission, live);
  if (blocked) return { ok: false, error: blocked };
  const r = await api.connectCall(input.phoneE164, input.sdpOffer, `u${input.userId}`);
  if (!r.ok) {
    if (r.code === 138006) await repo.savePermission(input.phoneE164, { status: "none", expiresAt: null, isPermanent: 0 }).catch(() => undefined);
    return { ok: false, error: r.error };
  }
  const nowS = toDbUtc(nowOf(deps));
  await repo.upsertOutbound({
    callId: r.callId, phoneE164: input.phoneE164, direction: "out", status: "dialing", startedAt: nowS,
    conversationId: input.conversationId, projectId: input.projectId, startedByUserId: input.userId, answeredByUserId: input.userId,
  });
  const row = await repo.getByCallId(r.callId);
  if (!row) return { ok: false, error: "Chamada iniciada mas não foi possível registá-la." };
  console.log(`[WhatsAppCalls] chamada feita para ${maskPhone(input.phoneE164)}`);
  return { ok: true, id: row.id };
}

/** Regista um pedido de autorização enviado (limites 1/24 h e 2/7 dias). */
export async function notePermissionRequested(phoneE164: string, userId: number, deps: CallDeps): Promise<void> {
  const now = nowOf(deps);
  const local = await deps.repo.getPermission(phoneE164);
  const eff = effectivePermission(local, now);
  await deps.repo.savePermission(phoneE164, {
    ...(eff.valid ? {} : { status: "requested" }),
    lastRequestAt: toDbUtc(now),
    requestTimes: appendRequestTime(local?.requestTimes ?? null, now),
    requestedByUserId: userId,
  });
}

// ─── Varrimento (chamadas presas) ───────────────────────────────────────────

/** Estado final de uma chamada viva que passou o prazo; null = ainda dentro. PURA. */
export function staleOutcome(row: Pick<CallRow, "status" | "direction" | "startedAt" | "answeredAt">, now: number): CallStatus | null {
  const started = dbUtcMs(row.startedAt) ?? 0;
  const answered = dbUtcMs(row.answeredAt) ?? started;
  if (row.status === "ringing" && row.direction === "in") return now - started >= RING_TIMEOUT_MS + 15_000 ? "missed" : null;
  if (row.status === "answering") return now - answered >= ANSWERING_STALE_MS ? "failed" : null;
  if ((row.status === "dialing" || row.status === "ringing") && row.direction === "out") return now - started >= DIALING_STALE_MS ? "missed" : null;
  if (row.status === "connected") return now - answered >= CONNECTED_STALE_MS ? "ended" : null;
  return null;
}

/** Fecha chamadas sem "terminate" da Meta (webhook perdido). Devolve as perdidas recebidas. */
export async function sweepStaleCalls(deps: CallDeps): Promise<{ closed: number; missed: number[] }> {
  const now = nowOf(deps);
  const out = { closed: 0, missed: [] as number[] };
  for (const row of await deps.repo.listStale(now)) {
    const final = staleOutcome(row, now);
    if (!final) continue;
    const set: Partial<CallRow> = { status: final, endedAt: toDbUtc(now), sdpOffer: null, sdpAnswer: null, missed: row.direction === "in" && final === "missed" ? 1 : 0 };
    if (final === "ended" && row.answeredAt) set.durationSec = Math.max(0, Math.round((now - (dbUtcMs(row.answeredAt) ?? now)) / 1000));
    if (await deps.repo.transition(row.id, [row.status], set)) {
      out.closed++;
      if (row.direction === "in" && final === "missed") {
        out.missed.push(row.id);
        if (row.conversationId) await deps.repo.touchConversation(row.conversationId, { at: toDbUtc(now), preview: "📞 Chamada perdida", inbound: false, needsAttention: true });
      }
    }
  }
  return out;
}

// ═══ Implementação real (BD + Meta) ═════════════════════════════════════════

async function dbOrThrow() {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  return db;
}

const affected = (res: unknown): number => Number((res as any)?.[0]?.affectedRows ?? (res as any)?.affectedRows ?? 0);

function isDupEntry(err: any): boolean {
  const code = err?.code ?? err?.cause?.code;
  return code === "ER_DUP_ENTRY" || err?.errno === 1062 || err?.cause?.errno === 1062;
}

/** Colunas que o serviço pode mudar (lista branca — nada vindo de fora). */
const SETTABLE: ReadonlyArray<keyof CallRow | "endReason"> = [
  "status", "sdpOffer", "sdpAnswer", "answeredAt", "endedAt", "durationSec", "answeredByUserId", "startedByUserId",
  "missed", "callbackDoneAt", "metaStatus", "conversationId", "projectId", "endReason",
];
function pickSet(set: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SETTABLE) if (k in set) out[k] = (set as any)[k];
  return out;
}

export function createDbCallRepo(): CallRepo {
  return {
    async ensureConversation(phoneE164, profileName) {
      const db = await dbOrThrow();
      const { whatsappConversations } = await import("../drizzle/schema");
      await db
        .insert(whatsappConversations)
        .values({ phoneE164, statusChangedAt: toDbUtc(Date.now()), ...(profileName ? { profileName } : {}) })
        .onDuplicateKeyUpdate({ set: profileName ? { profileName } : { phoneE164: sql`${whatsappConversations.phoneE164}` } });
      const [conv] = await db
        .select({ id: whatsappConversations.id, employeeId: whatsappConversations.employeeId, bookingCheckedAt: whatsappConversations.bookingCheckedAt })
        .from(whatsappConversations)
        .where(eq(whatsappConversations.phoneE164, phoneE164))
        .limit(1);
      if (!conv) throw new Error("Conversa não criada.");
      if (conv.employeeId == null && !conv.bookingCheckedAt) {
        const { matchBookingCity } = await import("./whatsappInbound");
        await matchBookingCity(db, conv.id, phoneE164);
      }
      return { conversationId: conv.id, projectId: await conversationProjectId(conv.id) };
    },
    async insertCall(row) {
      const db = await dbOrThrow();
      const { whatsappCalls } = await import("../drizzle/schema");
      try {
        await db.insert(whatsappCalls).values({ ...(pickSet(row as any) as any), callId: row.callId, phoneE164: row.phoneE164, direction: row.direction, status: row.status, startedAt: row.startedAt });
        return true;
      } catch (err) {
        if (isDupEntry(err)) return false;
        throw err;
      }
    },
    async upsertOutbound(row) {
      const db = await dbOrThrow();
      const { whatsappCalls } = await import("../drizzle/schema");
      const attach: Record<string, unknown> = {};
      for (const k of ["conversationId", "projectId", "startedByUserId", "answeredByUserId", "sdpAnswer"] as const) {
        if ((row as any)[k] != null) attach[k] = (row as any)[k];
      }
      await db
        .insert(whatsappCalls)
        .values({ ...(pickSet(row as any) as any), callId: row.callId, phoneE164: row.phoneE164, direction: "out", status: row.status, startedAt: row.startedAt })
        .onDuplicateKeyUpdate({ set: Object.keys(attach).length ? attach : { callId: sql`${whatsappCalls.callId}` } });
    },
    async getByCallId(callId) {
      const db = await dbOrThrow();
      const { whatsappCalls } = await import("../drizzle/schema");
      const [r] = await db.select().from(whatsappCalls).where(eq(whatsappCalls.callId, callId)).limit(1);
      return (r as any) ?? null;
    },
    async getById(id) {
      const db = await dbOrThrow();
      const { whatsappCalls } = await import("../drizzle/schema");
      const [r] = await db.select().from(whatsappCalls).where(eq(whatsappCalls.id, id)).limit(1);
      return (r as any) ?? null;
    },
    async transition(id, from, set, opts) {
      const db = await dbOrThrow();
      const { whatsappCalls } = await import("../drizzle/schema");
      const values = pickSet(set as any);
      if (!Object.keys(values).length || !from.length) return false;
      const res = await db
        .update(whatsappCalls)
        .set(values as any)
        .where(and(
          eq(whatsappCalls.id, id),
          inArray(whatsappCalls.status, [...from]),
          ...(opts?.startedAfter ? [sql`${whatsappCalls.startedAt} > ${opts.startedAfter}`] : []),
        ));
      return affected(res) > 0;
    },
    async markCallbacksDone(phoneE164, userId, at) {
      const db = await dbOrThrow();
      const { whatsappCalls } = await import("../drizzle/schema");
      const res = await db
        .update(whatsappCalls)
        .set({ callbackDoneAt: at, callbackByUserId: userId })
        .where(and(eq(whatsappCalls.phoneE164, phoneE164), eq(whatsappCalls.direction, "in"), inArray(whatsappCalls.status, ["missed", "rejected"]), isNull(whatsappCalls.callbackDoneAt)));
      return affected(res);
    },
    async getPermission(phoneE164) {
      const db = await dbOrThrow();
      const { whatsappCallPermissions } = await import("../drizzle/schema");
      const [r] = await db.select().from(whatsappCallPermissions).where(eq(whatsappCallPermissions.phoneE164, phoneE164)).limit(1);
      return (r as any) ?? null;
    },
    async savePermission(phoneE164, patch) {
      const db = await dbOrThrow();
      const { whatsappCallPermissions } = await import("../drizzle/schema");
      const set: Record<string, unknown> = {};
      for (const k of ["status", "expiresAt", "isPermanent", "lastRequestAt", "requestTimes", "respondedAt", "requestedByUserId"] as const) {
        if (k in patch) set[k] = (patch as any)[k] === true ? 1 : (patch as any)[k] === false ? 0 : (patch as any)[k];
      }
      await db.insert(whatsappCallPermissions).values({ phoneE164, ...(set as any) }).onDuplicateKeyUpdate({ set: Object.keys(set).length ? set : { phoneE164 } });
    },
    async userName(userId) {
      if (!userId) return null;
      const db = await dbOrThrow();
      const { users } = await import("../drizzle/schema");
      const [u] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
      return u ? (u.name?.trim() || u.email || `Utilizador #${userId}`) : null;
    },
    async countConnectedOutboundSince(phoneE164, since) {
      const db = await dbOrThrow();
      const [rows] = (await db.execute(sql`SELECT COUNT(*) AS n FROM whatsapp_calls WHERE phoneE164 = ${phoneE164} AND direction = 'out' AND answeredAt IS NOT NULL AND status IN ('connected','ended') AND startedAt >= ${since}`)) as any;
      return Number((rows as any[])?.[0]?.n ?? 0);
    },
    async recentOutboundStatuses(phoneE164, limit) {
      const db = await dbOrThrow();
      const { whatsappCalls } = await import("../drizzle/schema");
      const rows = await db
        .select({ status: whatsappCalls.status })
        .from(whatsappCalls)
        .where(and(eq(whatsappCalls.phoneE164, phoneE164), eq(whatsappCalls.direction, "out")))
        .orderBy(desc(whatsappCalls.startedAt))
        .limit(limit);
      return rows.map((r) => r.status);
    },
    async hasLiveCall(phoneE164) {
      const db = await dbOrThrow();
      const { whatsappCalls } = await import("../drizzle/schema");
      const since = toDbUtc(Date.now() - CONNECTED_STALE_MS);
      const rows = await db
        .select({ id: whatsappCalls.id })
        .from(whatsappCalls)
        .where(and(eq(whatsappCalls.phoneE164, phoneE164), inArray(whatsappCalls.status, ["answering", "dialing", "connected"]), sql`${whatsappCalls.startedAt} >= ${since}`))
        .limit(1);
      return rows.length > 0;
    },
    async listStale(nowMs) {
      const db = await dbOrThrow();
      const { whatsappCalls } = await import("../drizzle/schema");
      const ringCut = toDbUtc(nowMs - RING_TIMEOUT_MS - 15_000);
      const otherCut = toDbUtc(nowMs - Math.min(ANSWERING_STALE_MS, DIALING_STALE_MS));
      const connCut = toDbUtc(nowMs - CONNECTED_STALE_MS);
      const rows = await db
        .select()
        .from(whatsappCalls)
        .where(sql`(
          (${whatsappCalls.status} = 'ringing' AND ${whatsappCalls.startedAt} < ${ringCut})
          OR (${whatsappCalls.status} IN ('answering','dialing') AND ${whatsappCalls.startedAt} < ${otherCut})
          OR (${whatsappCalls.status} = 'connected' AND COALESCE(${whatsappCalls.answeredAt}, ${whatsappCalls.startedAt}) < ${connCut})
        )`)
        .limit(100);
      return rows as any;
    },
    async touchConversation(conversationId, patch) {
      const db = await dbOrThrow();
      const { whatsappConversations } = await import("../drizzle/schema");
      const { sqlLaterTs } = await import("./whatsappStore");
      const set: Record<string, unknown> = {
        lastMessageAt: sqlLaterTs(whatsappConversations.lastMessageAt, patch.at),
        lastPreview: patch.preview.slice(0, 160),
        lastDirection: "in",
        lastType: "text",
      };
      if (patch.inbound) set.lastInboundAt = sqlLaterTs(whatsappConversations.lastInboundAt, patch.at);
      if (patch.needsAttention) {
        set.unreadCount = sql`${whatsappConversations.unreadCount} + 1`;
        set.awaitingSince = sql`COALESCE(${whatsappConversations.awaitingSince}, ${patch.at})`;
        // Perdida reabre a conversa resolvida (como uma mensagem nova).
        set.status = sql`IF(${whatsappConversations.status} = 'resolvido', 'aberto', ${whatsappConversations.status})`;
      }
      await db.update(whatsappConversations).set(set as any).where(eq(whatsappConversations.id, conversationId));
    },
    async claimMissedNotice(id, at) {
      const db = await dbOrThrow();
      const { whatsappCalls } = await import("../drizzle/schema");
      const res = await db.update(whatsappCalls).set({ missedNotifiedAt: at }).where(and(eq(whatsappCalls.id, id), isNull(whatsappCalls.missedNotifiedAt)));
      return affected(res) > 0;
    },
  };
}

/** Cidade da conversa: ficha → lead mais recente com cidade → reserva (igual aos avisos de SLA). */
export async function conversationProjectId(conversationId: number): Promise<number | null> {
  const db = await dbOrThrow();
  const [rows] = (await db.execute(sql`
    SELECT COALESCE(e.projectId,
      (SELECT l.projectId FROM extra_leads l WHERE l.phoneE164 = c.phoneE164 COLLATE utf8mb4_unicode_ci AND l.projectId IS NOT NULL ORDER BY l.id DESC LIMIT 1),
      c.bookingProjectId) AS projectId
      FROM whatsapp_conversations c LEFT JOIN employees e ON e.id = c.employeeId
     WHERE c.id = ${conversationId} LIMIT 1`)) as any;
  const v = (rows as any[])?.[0]?.projectId;
  return v == null ? null : Number(v);
}

export function realCallApi(): CallApi {
  return {
    async callAction(action, callId, sdp) {
      const { callAction } = await import("./whatsappCallsApi");
      const r = await callAction(action, callId, sdp);
      return r.ok ? { ok: true } : r;
    },
    async connectCall(to, sdp, biz) {
      const { connectCall } = await import("./whatsappCallsApi");
      return connectCall(to, sdp, biz);
    },
  };
}

export function realCallDeps(): CallDeps {
  return { repo: createDbCallRepo(), api: realCallApi(), notifyMissed: notifyMissedCall };
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC) → "14:32" em Lisboa. PURA. */
export function formatLisbonTime(dbUtc: string | null | undefined): string {
  const ms = dbUtcMs(dbUtc);
  if (ms == null) return "?";
  return new Date(ms).toLocaleTimeString("pt-PT", { timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit" });
}

/** Aviso "Chamada perdida" à equipa da cidade da conversa (1× por chamada). */
export async function notifyMissedCall(call: CallRow): Promise<void> {
  try {
    const repo = createDbCallRepo();
    if (!(await repo.claimMissedNotice(call.id, toDbUtc(Date.now())))) return;
    const name = await conversationName(call.conversationId, call.phoneE164);
    const { notify } = await import("./notify");
    await notify({
      kind: "whatsapp_missed_call",
      projectId: call.projectId,
      title: `Chamada perdida no WhatsApp: ${name}`,
      body: `${name} ligou às ${formatLisbonTime(call.startedAt)} e ninguém atendeu. Devolve a chamada na conversa (botão Ligar).`,
      link: call.conversationId ? `/whatsapp?c=${call.conversationId}` : "/whatsapp",
      entity: { type: "whatsapp_call", id: call.id },
    });
  } catch (err: any) {
    console.warn("[WhatsAppCalls] aviso de chamada perdida falhou:", String(err?.message ?? err).slice(0, 160));
  }
}

async function conversationName(conversationId: number | null, phoneE164: string): Promise<string> {
  if (!conversationId) return phoneE164;
  try {
    const db = await dbOrThrow();
    const [rows] = (await db.execute(sql`
      SELECT COALESCE(NULLIF(TRIM(e.fullName), ''),
        (SELECT ln.fullName FROM extra_leads ln WHERE ln.phoneE164 = c.phoneE164 COLLATE utf8mb4_unicode_ci ORDER BY ln.id DESC LIMIT 1),
        NULLIF(TRIM(c.profileName), ''), c.phoneE164) AS name
        FROM whatsapp_conversations c LEFT JOIN employees e ON e.id = c.employeeId WHERE c.id = ${conversationId} LIMIT 1`)) as any;
    return String((rows as any[])?.[0]?.name ?? phoneE164);
  } catch {
    return phoneE164;
  }
}

/** Webhook: parse + aplica. Devolve o resultado (o aviso das perdidas corre depois do 200). */
export async function processCallWebhook(payload: any): Promise<CallWebhookResult & { ignored: number }> {
  const parsed = parseCallWebhook(payload, process.env.WHATSAPP_PHONE_NUMBER_ID);
  if (!parsed.events.length) return { connects: 0, terminates: 0, statuses: 0, permissions: 0, deduped: 0, missed: [], ignored: parsed.ignored };
  const r = await applyCallEvents(parsed.events, realCallDeps());
  return { ...r, ignored: parsed.ignored };
}

/** Avisos das chamadas perdidas (depois do 200 à Meta). Nunca lança. */
export async function notifyMissedByIds(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const repo = createDbCallRepo();
  for (const id of ids) {
    try {
      const row = await repo.getById(id);
      if (row) await notifyMissedCall(row);
    } catch { /* segue */ }
  }
}

let lastSweep = 0;
/** Varrimento com travão por processo (chamado pelo polling do toque e pelo cron). */
export async function sweepStaleCallsThrottled(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastSweep < 15_000) return;
  lastSweep = now;
  try {
    const deps = realCallDeps();
    const r = await sweepStaleCalls(deps);
    if (r.missed.length) await notifyMissedByIds(r.missed);
  } catch (err: any) {
    console.warn("[WhatsAppCalls] varrimento falhou:", String(err?.message ?? err).slice(0, 160));
  }
}



/** Interruptor WHATSAPP_CALLS (Definições → Automações; desligado por omissão). */
export async function whatsappCallsEnabled(): Promise<boolean> {
  const { ensureFeatureFlagOverrides, isFeatureEnabled } = await import("./_core/featureFlags");
  const { automationFlagDefault } = await import("../shared/appSettings");
  await ensureFeatureFlagOverrides();
  return isFeatureEnabled("WHATSAPP_CALLS", { defaultEnabled: automationFlagDefault("WHATSAPP_CALLS") });
}
