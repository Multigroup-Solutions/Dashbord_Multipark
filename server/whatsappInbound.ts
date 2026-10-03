/**
 * Processamento do webhook entrante da WhatsApp Cloud API (Fase 3).
 *
 * Decisão do Jorge (ajuste #2): PROCESS-THEN-ACK — o parse e a escrita na BD
 * correm ANTES de responder 200 à Meta. Se algo falhar, o chamador (a rota em
 * whatsappWebhook.ts) responde 5xx e a Meta faz retry — nunca perdemos
 * mensagens em silêncio. A dedup por `waMessageId` (unique) torna os retries
 * idempotentes.
 *
 * Escrita por mensagem, numa TRANSAÇÃO (planInbound descreve a ordem):
 *   1. garante a conversa (sem mexer em contadores);
 *   2. insere a mensagem — `waMessageId` é UNIQUE: duplicado (retry da Meta)
 *      → nada mais acontece (nem unread+1, nem automações);
 *   3. atualiza a conversa: unread+1, `lastInboundAt`/`lastMessageAt` só para
 *      a frente (GREATEST), resumo da última mensagem.
 * Depois do commit (fora da transação, porque fazem rede): download da media,
 * opt-out/opt-in, respostas automáticas e leads.
 *
 * Reações e tipos não suportados ficam guardados (para se verem) mas NÃO
 * contam como resposta: não abrem a janela, não contam como não lidas, não
 * disparam automações nem passam um lead a "Respondeu".
 *
 * As funções de parse e de planeamento são puras e testáveis sem Express nem BD.
 */
import { nextAwaitingSince, nextStatusOnInbound } from "../shared/whatsappConversation";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { employees, extraLeads, whatsappConversations, whatsappMessages, whatsappPendingStatuses } from "../drizzle/schema";
import { normalizePhoneE164 } from "../shared/phone";
import {
  baseMime,
  extensionForMime,
  mediaKindForMessageType,
  type WhatsAppMediaKind,
} from "../shared/whatsappMedia";
import { detectOptIntent, OPT_IN_CONFIRMATION, OPT_OUT_CONFIRMATION, optOutSourceForText, preferenceIntent, type OptIntent, type OptOutSource } from "../shared/whatsappOptOut";
import { maskPhone } from "../shared/maskPhone";
import { downloadMedia } from "./whatsapp";
import { storagePut } from "./storage";
import {
  applyStatusToMessage,
  isOutboundOk,
  laterTimestamp,
  previewFields,
  reconcilePendingStatus,
  stashPendingStatus,
  type Db,
  type MessageStatus,
} from "./whatsappStore";

export type { MessageStatus };

/** Referência à media entrante tal como vem no webhook (ainda sem descarregar). */
export interface ParsedInboundMedia {
  kind: WhatsAppMediaKind;
  /** id Meta — serve para descarregar (válido ~30 dias) */
  id: string;
  mime: string | null;
}

export interface ParsedInboundMessage {
  waMessageId: string;
  from: string; // dígitos da Meta (sem "+")
  timestamp: string | null; // 'YYYY-MM-DD HH:MM:SS' (UTC)
  type: string; // text | image | audio | ...
  body: string; // texto, ou representação mínima ("[imagem]", caption, ...)
  /** imagem/áudio/vídeo/documento enviados pela pessoa; null nos restantes tipos */
  media: ParsedInboundMedia | null;
  /** `metadata.phone_number_id` do evento (o nosso número que recebeu). */
  phoneNumberId: string | null;
  /** `contacts[].profile.name` para este `from`, quando vem. */
  profileName: string | null;
  /** `context.id`: wamid da NOSSA mensagem a que esta responde (botões de resposta rápida). */
  contextId: string | null;
  /** `button.payload` de uma resposta rápida de template. */
  buttonPayload: string | null;
}

export interface ParsedStatusUpdate {
  waMessageId: string;
  status: MessageStatus;
  timestamp: string | null;
  errorDetail: string | null;
  /** `errors[0].code` da Meta (131026, 131049, …) — 0375. */
  errorCode: number | null;
  /** `errors[0].title` da Meta. */
  errorTitle: string | null;
  /** `pricing.category` (marketing / utility / …) quando vem. */
  category: string | null;
}

/** D35: o cliente parou/retomou as promoções na app do WhatsApp (`user_preferences`). */
export interface ParsedPreference {
  from: string; // wa_id (dígitos)
  intent: OptIntent;
}

export interface ParsedWebhook {
  messages: ParsedInboundMessage[];
  statuses: ParsedStatusUpdate[];
  preferences: ParsedPreference[];
  /** Eventos ignorados por serem de OUTRO phone_number_id. */
  ignored: number;
}

// ─── Parsing (puro) ─────────────────────────────────────────────────────────

/** Epoch em segundos (string ou número) → 'YYYY-MM-DD HH:MM:SS' (UTC), ou null. */
export function parseMetaTimestamp(ts: unknown): string | null {
  if (ts == null) return null;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Texto de uma mensagem entrante. Para media guarda-se o caption (se existir)
 * ou um marcador tipo "[imagem]" — o ficheiro em si vai para o storage
 * privado (ver `storeInboundMedia`).
 */
export function messageBody(m: any): string {
  const type = String(m?.type ?? "unknown");
  switch (type) {
    case "text":
      return String(m?.text?.body ?? "");
    case "image":
      return String(m?.image?.caption ?? "[imagem]");
    case "video":
      return String(m?.video?.caption ?? "[vídeo]");
    case "document":
      return String(m?.document?.caption ?? m?.document?.filename ?? "[documento]");
    case "audio":
      return "[áudio]";
    case "voice":
      return "[mensagem de voz]";
    case "sticker":
      return "[sticker]";
    case "location": {
      // Guardar o conteúdo (17b): antes ficava só "[localização]" e quem
      // pedia "onde está?" para a recolha não via onde.
      const l = m?.location ?? {};
      const lat = Number(l.latitude);
      const lng = Number(l.longitude);
      const place = [l.name, l.address].filter((x: unknown) => typeof x === "string" && x.trim()).join(" — ");
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return place ? `[localização] ${place}` : "[localização]";
      return `[localização]${place ? ` ${place}` : ""}\nhttps://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
    }
    case "contacts": {
      const list: any[] = Array.isArray(m?.contacts) ? m.contacts : [];
      const lines = list.slice(0, 5).map((c) => {
        const name = String(c?.name?.formatted_name ?? c?.name?.first_name ?? "").trim();
        const phones = (Array.isArray(c?.phones) ? c.phones : []).map((p: any) => String(p?.phone ?? p?.wa_id ?? "").trim()).filter(Boolean);
        return [name, phones.join(", ")].filter(Boolean).join(": ");
      }).filter(Boolean);
      return lines.length ? `[contacto] ${lines.join(" · ")}` : "[contacto]";
    }
    case "reaction": {
      const emoji = m?.reaction?.emoji;
      return emoji ? `[reação ${emoji}]` : "[reação removida]";
    }
    case "unsupported":
      return "[mensagem não suportada]";
    case "button":
      return String(m?.button?.text ?? "[botão]");
    case "interactive": {
      const i = m?.interactive;
      // Resposta ao pedido de autorização para ligar (Calling API).
      if (i?.type === "call_permission_reply") {
        const r = i?.call_permission_reply;
        if (String(r?.response ?? "").toLowerCase() !== "accept") return "[Não autorizou chamadas]";
        return r?.is_permanent ? "[Autorizou chamadas (sem prazo)]" : "[Autorizou chamadas durante 7 dias]";
      }
      return String(
        i?.button_reply?.title ?? i?.list_reply?.title ?? "[resposta interativa]",
      );
    }
    default:
      return `[${type}]`;
  }
}

/**
 * Extrai a referência à media (imagem/áudio/nota de voz) de uma mensagem
 * Meta. O download é feito depois, em `handleInbound` — aqui é só parse. PURA.
 */
export function parseInboundMedia(m: any): ParsedInboundMedia | null {
  const kind = mediaKindForMessageType(m?.type);
  if (!kind) return null;
  const node = m?.[String(m.type)];
  const id = node?.id;
  if (!id) return null;
  return { kind, id: String(id), mime: node?.mime_type ? String(node.mime_type) : null };
}

/**
 * Percorre entry[].changes[].value.{messages,statuses} de forma defensiva.
 *
 * `expectedPhoneNumberId` (env WHATSAPP_PHONE_NUMBER_ID): eventos com
 * `metadata.phone_number_id` DIFERENTE são ignorados (a mesma app Meta pode ter
 * vários números; não queremos conversas do número de outra equipa aqui).
 * Sem metadata, aceita-se (payloads antigos/testes).
 */
export function parseWebhookPayload(payload: any, expectedPhoneNumberId?: string | null): ParsedWebhook {
  const messages: ParsedInboundMessage[] = [];
  const statuses: ParsedStatusUpdate[] = [];
  const preferences: ParsedPreference[] = [];
  let ignored = 0;
  const expected = (expectedPhoneNumberId ?? "").trim() || null;

  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      if (!value) continue;

      const phoneNumberId = value?.metadata?.phone_number_id != null ? String(value.metadata.phone_number_id) : null;
      const msgs = Array.isArray(value.messages) ? value.messages : [];
      const sts = Array.isArray(value.statuses) ? value.statuses : [];
      const prefs = Array.isArray(value.user_preferences) ? value.user_preferences : [];
      if (expected && phoneNumberId && phoneNumberId !== expected) {
        ignored += msgs.length + sts.length + prefs.length;
        continue;
      }
      for (const p of prefs) {
        const from = typeof p?.wa_id === "string" ? p.wa_id.replace(/\D/g, "") : "";
        const intent = preferenceIntent(p);
        if (from && intent) preferences.push({ from, intent });
      }

      const profileByWaId = new Map<string, string>();
      for (const c of Array.isArray(value.contacts) ? value.contacts : []) {
        const name = c?.profile?.name;
        if (c?.wa_id && typeof name === "string" && name.trim()) profileByWaId.set(String(c.wa_id), name.trim().slice(0, 128));
      }

      for (const m of msgs) {
        const waMessageId = m?.id;
        const from = m?.from;
        if (!waMessageId || !from) continue; // sem id/from não há nada a fazer
        messages.push({
          waMessageId: String(waMessageId),
          from: String(from),
          timestamp: parseMetaTimestamp(m?.timestamp),
          type: String(m?.type ?? "unknown"),
          body: messageBody(m),
          media: parseInboundMedia(m),
          phoneNumberId,
          profileName: profileByWaId.get(String(from)) ?? null,
          contextId: typeof m?.context?.id === "string" && m.context.id ? m.context.id : null,
          buttonPayload: typeof m?.button?.payload === "string" && m.button.payload ? m.button.payload : null,
        });
      }

      for (const s of sts) {
        const waMessageId = s?.id;
        const status = s?.status;
        if (!waMessageId || !isMessageStatus(status)) continue;
        let errorDetail: string | null = null;
        let errorCode: number | null = null;
        let errorTitle: string | null = null;
        const errs = Array.isArray(s?.errors) ? s.errors : [];
        if (errs.length) {
          const e = errs[0];
          const code = e?.code;
          const title = e?.title || e?.message || e?.error_data?.details || "erro";
          errorDetail = code != null ? `${title} (código ${code})` : String(title);
          const n = Number(code);
          errorCode = code != null && Number.isFinite(n) ? n : null;
          errorTitle = typeof e?.title === "string" && e.title.trim() ? e.title.trim().slice(0, 255) : null;
        }
        const pricingCategory = s?.pricing?.category;
        statuses.push({
          waMessageId: String(waMessageId),
          status,
          timestamp: parseMetaTimestamp(s?.timestamp),
          errorDetail,
          errorCode,
          errorTitle,
          category: typeof pricingCategory === "string" && pricingCategory.trim() ? pricingCategory.trim().toUpperCase().slice(0, 16) : null,
        });
      }
    }
  }

  return { messages, statuses, preferences, ignored };
}

function isMessageStatus(v: unknown): v is MessageStatus {
  return v === "sent" || v === "delivered" || v === "read" || v === "failed";
}

// ─── Planeamento (puro) ─────────────────────────────────────────────────────

/** Tipos que NÃO são uma resposta da pessoa (não abrem janela nem disparam nada). */
const NON_REPLY_TYPES = new Set(["reaction", "unsupported", "unknown", "system", "ephemeral", "request_welcome", "errors"]);

/** A mensagem conta como resposta (janela, não lidas, automações, lead "Respondeu")? PURA. */
export function countsAsReply(type: string): boolean {
  return !NON_REPLY_TYPES.has(type);
}

/** Tipos onde o texto pode ser um pedido STOP/INICIAR (não captions de media). */
const OPT_TEXT_TYPES = new Set(["text", "button", "interactive"]);

/** `type` a gravar em whatsapp_messages (enum da 0094). PURA. */
export function storedMessageType(mediaKind: WhatsAppMediaKind | null): "text" | "image" | "audio" | "document" | "video" {
  return mediaKind ?? "text";
}

export type InboundStep =
  | "ensure_conversation"
  | "insert_message"
  | "update_conversation"
  | "download_media"
  | "opt_out"
  | "opt_in"
  | "employee_automations"
  | "lead_replied"
  | "lead_stamp";

export interface InboundPlan {
  steps: InboundStep[];
  /** unread+1 */
  bumpUnread: boolean;
  /** lastInboundAt avança (abre a janela de 24h) */
  openWindow: boolean;
  optIntent: OptIntent | null;
}

/**
 * O que fazer com UMA mensagem recebida, por ordem. PURA — é a especificação
 * testada da escrita do webhook:
 *  - `duplicate` (o INSERT da mensagem bateu no UNIQUE) → só os passos até ao
 *    insert; nada de contadores, automações ou leads;
 *  - reação/tipo não suportado → guarda e atualiza a última mensagem, mais nada;
 *  - STOP/INICIAR → trata o opt-out/opt-in e NÃO dispara automações; o lead só
 *    fica com a hora da última mensagem (não passa a "Respondeu");
 *  - conversa já em opt-out → sem automações nem "Respondeu".
 */
export function planInbound(input: {
  duplicate: boolean;
  type: string;
  body: string;
  hasMedia: boolean;
  /** A conversa já estava em opt-out ANTES desta mensagem. */
  optedOut: boolean;
}): InboundPlan {
  const reply = countsAsReply(input.type);
  if (input.duplicate) return { steps: ["ensure_conversation", "insert_message"], bumpUnread: false, openWindow: false, optIntent: null };

  const optIntent = reply && OPT_TEXT_TYPES.has(input.type) ? detectOptIntent(input.body) : null;
  const steps: InboundStep[] = ["ensure_conversation", "insert_message", "update_conversation"];
  if (input.hasMedia) steps.push("download_media");
  if (!reply) return { steps, bumpUnread: false, openWindow: false, optIntent: null };

  if (optIntent === "opt_out") steps.push("opt_out");
  else if (optIntent === "opt_in") steps.push("opt_in");

  // Opt-in devolve os envios, mas a própria palavra "INICIAR" não é resposta a nada.
  const quiet = optIntent !== null || input.optedOut;
  if (quiet) steps.push("lead_stamp");
  else {
    if (!input.hasMedia && input.body.trim()) steps.push("employee_automations");
    steps.push("lead_replied");
  }
  return { steps, bumpUnread: true, openWindow: true, optIntent };
}

// ─── Orquestração (I/O) ─────────────────────────────────────────────────────

function nowStr(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/**
 * `from` da Meta (dígitos, sem "+") → E.164. Usa a mesma normalização do lado
 * de saída (para reconciliar com a conversa criada no broadcast); se não for
 * normalizável (número não-PT), cai para "+" + dígitos.
 */
export function metaFromToE164(from: string): string {
  const normalized = normalizePhoneE164(from);
  if (normalized) return normalized;
  const digits = String(from).replace(/\D/g, "");
  return digits ? "+" + digits : "";
}

/** Últimos 9 dígitos de um telefone (casamento com reservas). PURA. */
export function last9Digits(phone: string | null | undefined): string | null {
  const d = String(phone ?? "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : null;
}

// ── Mapa telefone → colaborador (cache de 5 min) ──
// Antes carregava TODAS as fichas em cada webhook. `employees.phone` é texto
// livre (a normalização E.164 não se faz em SQL), por isso o mapa é calculado
// em memória, mas no máximo 1× a cada 5 minutos por processo.
export const EMPLOYEE_PHONE_CACHE_MS = 5 * 60 * 1000;
let employeePhoneCache: { at: number; map: Map<string, number> } | null = null;

/** O cache ainda serve? PURA. */
export function cacheIsFresh(at: number | null | undefined, now: number, ttlMs = EMPLOYEE_PHONE_CACHE_MS): boolean {
  return at != null && now - at >= 0 && now - at < ttlMs;
}

async function employeeIdForPhone(db: Db, phoneE164: string): Promise<number | null> {
  const now = Date.now();
  if (!employeePhoneCache || !cacheIsFresh(employeePhoneCache.at, now)) {
    const rows = await db
      .select({ id: employees.id, phone: employees.phone })
      .from(employees)
      .where(isNotNull(employees.phone));
    const map = new Map<string, number>();
    for (const r of rows) {
      const e164 = r.phone ? normalizePhoneE164(r.phone) : null;
      if (e164 && !map.has(e164)) map.set(e164, r.id);
    }
    employeePhoneCache = { at: now, map };
  }
  return employeePhoneCache.map.get(phoneE164) ?? null;
}

/** Esquece o cache (ex.: testes, ou depois de mudar o telefone de uma ficha). */
export function invalidateEmployeePhoneCache(): void {
  employeePhoneCache = null;
}

function isDupEntry(err: any): boolean {
  const code = err?.code ?? err?.cause?.code;
  return code === "ER_DUP_ENTRY" || err?.errno === 1062 || err?.cause?.errno === 1062;
}

interface WrittenInbound {
  conversationId: number;
  messageId: number;
  phoneE164: string;
  employeeId: number | null;
  optedOut: boolean;
  bookingChecked: boolean;
  plan: InboundPlan;
}

/** Passos 1–3 numa transação. null = duplicado (nada mudou). */
async function writeInbound(db: Db, m: ParsedInboundMessage, phoneE164: string, employeeId: number | null): Promise<WrittenInbound | null> {
  const ts = m.timestamp ?? nowStr();
  return db.transaction(async (tx) => {
    // 1. Conversa existe (sem tocar em contadores/datas).
    await tx
      .insert(whatsappConversations)
      .values({ phoneE164, employeeId, statusChangedAt: nowStr() })
      .onDuplicateKeyUpdate({
        set: { employeeId: sql`COALESCE(${whatsappConversations.employeeId}, ${employeeId})` },
      });
    const [conv] = await tx
      .select({
        id: whatsappConversations.id,
        employeeId: whatsappConversations.employeeId,
        optedOutAt: whatsappConversations.optedOutAt,
        lastInboundAt: whatsappConversations.lastInboundAt,
        lastMessageAt: whatsappConversations.lastMessageAt,
        bookingCheckedAt: whatsappConversations.bookingCheckedAt,
        status: whatsappConversations.status,
        awaitingSince: whatsappConversations.awaitingSince,
      })
      .from(whatsappConversations)
      .where(eq(whatsappConversations.phoneE164, phoneE164))
      .limit(1)
      .for("update");

    // 2. Mensagem PRIMEIRO: o UNIQUE de waMessageId é a dedup.
    const mediaKind = m.media?.kind ?? null;
    let messageId: number;
    try {
      const res = await tx.insert(whatsappMessages).values({
        conversationId: conv.id,
        direction: "in",
        waMessageId: m.waMessageId,
        type: storedMessageType(mediaKind),
        body: m.body,
        mediaType: mediaKind,
        mediaId: m.media?.id ?? null,
        mediaMime: baseMime(m.media?.mime),
        phoneNumberId: m.phoneNumberId,
        // Mensagens entrantes não têm ciclo de entrega nosso; 'delivered' =
        // "recebida por nós" (a UI só mostra status nas mensagens OUT).
        status: "delivered",
        waTimestamp: ts,
      });
      messageId = Number((res as any)[0]?.insertId ?? (res as any).insertId);
    } catch (err) {
      if (isDupEntry(err)) return null; // retry da Meta → nada mais
      throw err;
    }

    // 3. Conversa: contadores e datas só para a frente.
    const plan = planInbound({
      duplicate: false,
      type: m.type,
      body: m.body,
      hasMedia: !!m.media,
      optedOut: !!conv.optedOutAt,
    });
    const newest = laterTimestamp(conv.lastMessageAt, ts) === ts;
    const p = previewFields({ body: m.body, type: storedMessageType(mediaKind), mediaType: mediaKind, direction: "in" });
    const set: Record<string, unknown> = {
      lastMessageAt: laterTimestamp(conv.lastMessageAt, ts),
      ...(newest ? { lastPreview: p.lastPreview, lastDirection: p.lastDirection, lastType: p.lastType } : {}),
      ...(m.profileName ? { profileName: m.profileName } : {}),
    };
    if (plan.openWindow) set.lastInboundAt = laterTimestamp(conv.lastInboundAt, ts);
    // Qualquer mensagem recebida prova que o número tem WhatsApp: acaba a série
    // de 131026 e a marca "sem WhatsApp" (os templates voltam) — 0375.
    set.undeliverableCount = 0;
    set.unreachableAt = null;
    if (plan.bumpUnread) set.unreadCount = sql`${whatsappConversations.unreadCount} + 1`;
    // Estado (0097): uma resposta verdadeira reabre a conversa resolvida/pendente
    // e marca-a "por responder" desde a 1.ª mensagem sem resposta (SLA).
    if (plan.bumpUnread) {
      const nextStatus = nextStatusOnInbound(conv.status, true);
      if (nextStatus !== conv.status) {
        set.status = nextStatus;
        set.statusChangedAt = nowStr();
        set.resolvedAt = null;
      }
      set.awaitingSince = nextAwaitingSince(conv.awaitingSince, ts, true);
    }
    await tx.update(whatsappConversations).set(set).where(eq(whatsappConversations.id, conv.id));

    return {
      conversationId: conv.id,
      messageId,
      phoneE164,
      employeeId: conv.employeeId ?? employeeId,
      optedOut: !!conv.optedOutAt,
      bookingChecked: !!conv.bookingCheckedAt,
      plan,
    };
  });
}

async function handleInbound(db: Db, m: ParsedInboundMessage, triage?: number[]): Promise<boolean> {
  const phoneE164 = metaFromToE164(m.from) || `+${m.from}`;
  const employeeId = await employeeIdForPhone(db, phoneE164);
  const w = await writeInbound(db, m, phoneE164, employeeId);
  if (!w) return false;
  const ts = m.timestamp ?? nowStr();
  const steps = new Set(w.plan.steps);

  // Tudo o resto é best-effort: a mensagem já está gravada; falhar aqui não
  // pode fazer a Meta repetir (o retry seria deduplicado e perdia-se na mesma).
  // Ordem (17b): primeiro o que é rápido e não pode perder-se (STOP, respostas
  // de disponibilidade, leads, triagem); o ficheiro (até ~45 s) e a cidade pela
  // reserva (até ~22 s) ficam no FIM — se a função morrer aos 60 s, o cron
  // re-tenta o ficheiro, mas um STOP perdido já não voltava.
  if (steps.has("opt_out") || steps.has("opt_in")) {
    await applyOptIntent(db, steps.has("opt_out") ? "opt_out" : "opt_in", w.conversationId, phoneE164, optOutSourceForText(m.body));
  }

  // Resposta de um colaborador a um pedido de disponibilidade / aviso de
  // escala ("sim" / "não"). Nunca lança.
  if (steps.has("employee_automations") && w.employeeId != null) {
    try {
      const { handleWhatsappReply, handleShiftNoticeButton } = await import("./extrasAutomation");
      // Botão "Confirmo"/"Não posso" do aviso de turno: liga pelo context.id
      // (o aviso exato a que respondeu). Tratado → não passa pela leitura do texto.
      const viaButton =
        m.type === "button" && m.contextId
          ? await handleShiftNoticeButton({
              employeeId: w.employeeId,
              conversationId: w.conversationId,
              contextId: m.contextId,
              text: m.body,
              payload: m.buttonPayload,
            })
          : false;
      if (!viaButton) await handleWhatsappReply({ employeeId: w.employeeId, conversationId: w.conversationId, body: m.body });
    } catch (err: any) {
      console.warn("[WhatsAppWebhook] automação falhou:", String(err?.message ?? err).slice(0, 160));
    }
  }

  // Mensagem de um LEAD de recrutamento (novo/contactado → "Respondeu",
  // aviso ao backoffice, link da candidatura 1×). Corre também quando o número
  // tem ficha (ex.: ex-extra inativo que voltou a ser lead). Nunca lança.
  if (steps.has("lead_replied") || steps.has("lead_stamp")) {
    const { handleLeadInbound } = await import("./extraLeadsSync");
    await handleLeadInbound({ phoneE164, conversationId: w.conversationId, at: ts, stampOnly: steps.has("lead_stamp") });
  }

  // Caixa por tema (17f): colaborador ou candidato → RH (salvo escolha à mão).
  // A caixa dos clientes vem da triagem por IA (abaixo).
  {
    const { assignBoxByRule } = await import("./whatsappInbox");
    await assignBoxByRule(w.conversationId);
  }

  // Triagem por IA (intenção + urgência), com debounce por conversa. Só
  // reserva aqui; a chamada à IA corre depois de responder à Meta.
  if (w.plan.bumpUnread && !w.optedOut && triage) {
    const { noteInboundForTriage } = await import("./whatsappTriage");
    if (await noteInboundForTriage(w.conversationId)) triage.push(w.conversationId);
  }
  // Lentos no fim (o ficheiro volta a ser tentado pelo cron se ficar a meio).
  if (steps.has("download_media") && m.media) {
    await fetchAndStoreMedia(db, w.messageId, m.waMessageId, m.media);
  }
  if (w.employeeId == null && !w.bookingChecked) {
    await matchBookingCity(db, w.conversationId, phoneE164);
  }
  return true;
}

/**
 * STOP → `optedOutAt` na conversa e nos leads com o número + UMA confirmação
 * (só se a janela estiver aberta — está, a pessoa acabou de escrever).
 * INICIAR → limpa. Repetir STOP não volta a responder.
 */
async function applyOptIntent(
  db: Db,
  intent: OptIntent,
  conversationId: number,
  phoneE164: string,
  source: OptOutSource = "stop",
  opts: { confirm?: boolean } = {},
): Promise<void> {
  try {
    const now = nowStr();
    const upd =
      intent === "opt_out"
        ? await db
            .update(whatsappConversations)
            .set({ optedOutAt: now, optOutSource: source })
            .where(and(eq(whatsappConversations.id, conversationId), isNull(whatsappConversations.optedOutAt)))
        : await db
            .update(whatsappConversations)
            .set({ optedOutAt: null, optOutSource: null })
            .where(and(eq(whatsappConversations.id, conversationId), isNotNull(whatsappConversations.optedOutAt)));
    const changed = Number((upd as any)[0]?.affectedRows ?? 0) > 0;
    await db
      .update(extraLeads)
      .set({ optedOutAt: intent === "opt_out" ? now : null })
      .where(
        and(
          eq(extraLeads.phoneE164, phoneE164),
          intent === "opt_out" ? isNull(extraLeads.optedOutAt) : isNotNull(extraLeads.optedOutAt),
        ),
      );
    if (!changed) return;
    console.log(`[WhatsAppWebhook] ${intent === "opt_out" ? "opt-out" : "opt-in"} (${source}) de ${maskPhone(phoneE164)}`);
    // O "Parar promoções" da própria app do WhatsApp já mostra a confirmação ao cliente.
    if (opts.confirm === false) return;
    const { replyToConversation } = await import("./whatsappInbox");
    await replyToConversation(conversationId, intent === "opt_out" ? OPT_OUT_CONFIRMATION : OPT_IN_CONFIRMATION, null, {
      allowOptedOut: true,
    });
  } catch (err: any) {
    console.warn("[WhatsAppWebhook] opt-out/opt-in falhou:", String(err?.message ?? err).slice(0, 160));
  }
}

/**
 * D35: "Parar promoções" / "Retomar" na própria app do WhatsApp
 * (`user_preferences`, marketing) conta como STOP / INICIAR — partilhado com o
 * be-multipark (que recebe o mesmo evento pelo reencaminhamento). Número sem
 * conversa: fica uma conversa resolvida e sem mensagens, só para o bloqueio
 * valer se alguém lhe escrever depois. Sem resposta ao cliente (a app da Meta
 * já confirma). Nunca lança.
 */
async function handlePreference(db: Db, p: ParsedPreference): Promise<void> {
  try {
    const phoneE164 = normalizePhoneE164(p.from) ?? `+${p.from}`;
    if (p.intent === "opt_out") {
      const now = nowStr();
      await db
        .insert(whatsappConversations)
        .values({ phoneE164, status: "resolvido", statusChangedAt: now })
        .onDuplicateKeyUpdate({ set: { phoneE164: sql`${whatsappConversations.phoneE164}` } });
    }
    const [c] = await db.select({ id: whatsappConversations.id }).from(whatsappConversations).where(eq(whatsappConversations.phoneE164, phoneE164)).limit(1);
    if (!c) return;
    await applyOptIntent(db, p.intent, c.id, phoneE164, "meta", { confirm: false });
  } catch (err: any) {
    console.warn("[WhatsAppWebhook] preferência de marketing falhou:", String(err?.message ?? err).slice(0, 160));
  }
}

/**
 * Número sem ficha: tenta a cidade pelo telefone de uma reserva (últimos 9
 * dígitos). Corre 1× por conversa (`bookingCheckedAt`); só serve a
 * visibilidade por cidade de números que também não são leads.
 */
export async function matchBookingCity(db: Db, conversationId: number, phoneE164: string): Promise<void> {
  const last9 = last9Digits(phoneE164);
  try {
    let projectId: number | null = null;
    if (last9) {
      // Ao vivo na Multipark: a reserva mais recente com este telefone → projeto do parque.
      const { searchLiveBookings } = await import("./multiparkDb/bookingSearch");
      const rows = await searchLiveBookings({ phone: last9 }, { limit: 5 });
      projectId = rows.find((r) => r.projectId != null)?.projectId ?? null;
    }
    await db
      .update(whatsappConversations)
      .set({ bookingProjectId: projectId, bookingCheckedAt: nowStr() })
      .where(eq(whatsappConversations.id, conversationId));
  } catch (err: any) {
    console.warn("[WhatsAppWebhook] cidade pela reserva falhou:", String(err?.message ?? err).slice(0, 160));
  }
}

/**
 * Descarrega a media da Meta e guarda-a no storage PRIVADO da app (a UI pede
 * um URL assinado — whatsapp.mediaUrl). Best-effort: se falhar, fica o
 * `mediaId` (a Meta mantém o ficheiro ~30 dias) e o cron horário re-tenta.
 * Nunca lança.
 */
async function fetchAndStoreMedia(db: Db, messageId: number, waMessageId: string, media: ParsedInboundMedia): Promise<boolean> {
  const dl = await downloadMedia(media.id);
  let stored: { key: string; mime: string | null } | null = null;
  // O motivo fica na mensagem (errorDetail das recebidas) para o ecrã o dizer (17a).
  let failure: string | null = null;
  // Demasiado grande não melhora a tentar outra vez: deixa de tentar já.
  let giveUp = false;
  if (!dl.ok) {
    console.warn(`[WhatsAppWebhook] media ${media.kind} ${media.id} não descarregada: ${dl.error}`);
    failure = dl.error.slice(0, 300);
    giveUp = /demasiado grande/i.test(dl.error);
  } else {
    const mime = baseMime(dl.mime ?? media.mime);
    // Nome derivado do id da mensagem (único) — sem caracteres soltos.
    const safeId = waMessageId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    const key = `whatsapp/inbound/${media.kind}/${safeId}.${extensionForMime(mime)}`;
    try {
      const put = await storagePut(key, dl.data, mime ?? "application/octet-stream");
      stored = { key: put.key, mime };
    } catch (err: any) {
      console.warn(`[WhatsAppWebhook] media ${media.id} não gravada no storage: ${err?.message ?? err}`);
      failure = "Não foi possível guardar o ficheiro.";
    }
  }
  try {
    await db
      .update(whatsappMessages)
      .set(
        stored
          ? { mediaKey: stored.key, mediaMime: stored.mime, mediaUrl: null, errorDetail: null }
          : { mediaAttempts: giveUp ? MEDIA_MAX_ATTEMPTS : sql`${whatsappMessages.mediaAttempts} + 1`, errorDetail: failure },
      )
      .where(eq(whatsappMessages.id, messageId));
  } catch (err: any) {
    console.warn("[WhatsAppWebhook] atualizar media falhou:", String(err?.message ?? err).slice(0, 160));
  }
  return !!stored;
}

async function handleStatus(db: Db, s: ParsedStatusUpdate): Promise<boolean> {
  const rows = await db
    .select({ id: whatsappMessages.id, status: whatsappMessages.status })
    .from(whatsappMessages)
    .where(and(eq(whatsappMessages.waMessageId, s.waMessageId), eq(whatsappMessages.direction, "out")))
    .limit(1);
  const extra = { errorCode: s.errorCode, errorTitle: s.errorTitle, category: s.category };
  if (!rows.length) {
    // A Meta pode mandar o status (sobretudo 'failed') antes de o envio ter
    // gravado a linha: guarda-se e o envio aplica-o quando grava.
    await stashPendingStatus(db, s.waMessageId, s.status, s.errorDetail, extra);
    return false;
  }
  const changed = await applyStatusToMessage(db, rows[0], s.status, s.errorDetail, extra);
  if (changed && s.status === "failed") {
    try { await afterOutboundFailed(db, rows[0].id, rows[0].status, s.errorDetail); }
    catch (err: any) { console.warn("[WhatsApp] corrigir contas do envio falhado:", String(err?.message ?? err).slice(0, 160)); }
  }
  // 131026 / 131049 (alternativa, "sem WhatsApp", nova tentativa) e entregue →
  // fim da série de 131026. Só na mudança: um status repetido não corre nada.
  if (changed) {
    const { onOutboundStatusChanged } = await import("./whatsappFailurePolicy");
    await onOutboundStatusChanged(db, { messageId: rows[0].id, next: s.status, errorCode: s.errorCode, errorDetail: s.errorDetail });
  }
  return changed;
}

/** Data do aviso de escala pela nota da difusão ("Aviso de escala AAAA-MM-DD"). PURA. */
export function scheduleNoticeDateFromNote(note: string | null | undefined): string | null {
  const m = String(note ?? "").match(/^Aviso de escala (\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * A Meta aceitou e só depois disse "falhou" (ex.: número sem WhatsApp, 17b):
 * a difusão deixa de contar a mensagem como enviada e, num aviso de escala, o
 * aviso passa a "falhou" — o Extras-Dia deixa de esperar um "sim" que nunca vem.
 * Não volta a tentar sozinho (attempts = 3).
 */
async function afterOutboundFailed(db: Db, messageId: number, prevStatus: string, errorDetail: string | null): Promise<void> {
  const [m] = await db
    .select({ broadcastId: whatsappMessages.broadcastId, employeeId: whatsappConversations.employeeId })
    .from(whatsappMessages)
    .innerJoin(whatsappConversations, eq(whatsappMessages.conversationId, whatsappConversations.id))
    .where(eq(whatsappMessages.id, messageId))
    .limit(1);
  if (!m?.broadcastId) return;
  // 'accepted' (D33) também contava como enviada na difusão.
  if (isOutboundOk(prevStatus)) {
    await db.execute(sql`UPDATE whatsapp_broadcasts SET sentCount = GREATEST(sentCount - 1, 0), failedCount = failedCount + 1 WHERE id = ${m.broadcastId}`);
  }
  if (m.employeeId == null) return;
  const [rows] = (await db.execute(sql`SELECT note FROM whatsapp_broadcasts WHERE id = ${m.broadcastId} LIMIT 1`)) as any;
  const date = scheduleNoticeDateFromNote((rows as any[])?.[0]?.note);
  if (!date) return;
  const why = `A Meta não entregou: ${String(errorDetail ?? "falhou").slice(0, 250)}`;
  await db.execute(sql`UPDATE extras_dia_notices SET status = 'failed', error = ${why}
     WHERE employeeId = ${m.employeeId} AND assignmentDate = ${date} AND status = 'sent' AND confirmedAt IS NULL AND declinedAt IS NULL`);
  await db.execute(sql`UPDATE extras_dia_notifications SET status = 'failed', detail = ${why}, attempts = GREATEST(attempts, 3)
     WHERE employeeId = ${m.employeeId} AND assignmentDate = ${date} AND kind = 'scheduled' AND channel = 'whatsapp' AND status = 'sent'`);
}

/**
 * Processa um payload de webhook: escreve mensagens entrantes e atualiza
 * statuses. Lança se a BD estiver indisponível ou se uma escrita falhar (o
 * chamador responde 5xx → Meta faz retry; a dedup torna o retry seguro).
 */
export async function processInboundWebhook(
  payload: any,
): Promise<{ processed: number; deduped: number; statuses: number; ignored: number; triage: number[] }> {
  const parsed = parseWebhookPayload(payload, process.env.WHATSAPP_PHONE_NUMBER_ID);
  const triage: number[] = [];
  if (!parsed.messages.length && !parsed.statuses.length && !parsed.preferences.length) {
    return { processed: 0, deduped: 0, statuses: 0, ignored: parsed.ignored, triage };
  }

  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível ao processar webhook WhatsApp.");

  let processed = 0;
  let deduped = 0;
  for (const m of parsed.messages) {
    const written = await handleInbound(db, m, triage);
    if (written) processed++;
    else deduped++;
  }

  let statuses = 0;
  for (const s of parsed.statuses) {
    if (await handleStatus(db, s)) statuses++;
  }

  for (const p of parsed.preferences) await handlePreference(db, p);

  return { processed, deduped, statuses, ignored: parsed.ignored, triage };
}

// ─── Manutenção (cron horário) ──────────────────────────────────────────────

export interface WhatsappMaintenanceResult {
  mediaRetried: number;
  mediaStored: number;
  pendingStatusesPurged: number;
  /** Estados pendentes aplicados a mensagens que já existiam (17b). */
  pendingStatusesApplied?: number;
  /** Novas tentativas de mensagens de equipa retidas por 131049 (0375). */
  retries?: { due: number; sent: number; failed: number; skipped: number };
}

/** Máximo de tentativas de download por mensagem, e lote por execução. */
export const MEDIA_MAX_ATTEMPTS = 5;
export const MEDIA_RETRY_BATCH = 20;

/**
 * Re-tenta descarregar media que falhou (a Meta guarda ~30 dias → só últimos
 * 25) em lote limitado, e limpa status pendentes com mais de 7 dias.
 */
export async function runWhatsappMaintenance(): Promise<WhatsappMaintenanceResult> {
  const out: WhatsappMaintenanceResult = { mediaRetried: 0, mediaStored: 0, pendingStatusesPurged: 0 };
  const db = await getDb();
  if (!db) return out;

  if (process.env.WHATSAPP_TOKEN) {
    const rows = await db
      .select({
        id: whatsappMessages.id,
        waMessageId: whatsappMessages.waMessageId,
        mediaId: whatsappMessages.mediaId,
        mediaType: whatsappMessages.mediaType,
        mediaMime: whatsappMessages.mediaMime,
      })
      .from(whatsappMessages)
      .where(
        and(
          eq(whatsappMessages.direction, "in"),
          isNotNull(whatsappMessages.mediaId),
          isNull(whatsappMessages.mediaKey),
          isNull(whatsappMessages.mediaUrl),
          sql`${whatsappMessages.mediaAttempts} < ${MEDIA_MAX_ATTEMPTS}`,
          sql`${whatsappMessages.createdAt} >= DATE_SUB(NOW(), INTERVAL 25 DAY)`,
        ),
      )
      .orderBy(sql`${whatsappMessages.id} DESC`)
      .limit(MEDIA_RETRY_BATCH);
    for (const r of rows) {
      const kind = r.mediaType as WhatsAppMediaKind | "sticker" | null;
      if (!r.mediaId || !r.waMessageId || !kind || kind === "sticker") continue;
      out.mediaRetried++;
      if (await fetchAndStoreMedia(db, r.id, r.waMessageId, { kind, id: r.mediaId, mime: r.mediaMime })) out.mediaStored++;
    }
  }

  // Chamadas de voz sem "terminate" da Meta (webhook perdido) → fechadas.
  try {
    const { sweepStaleCallsThrottled } = await import("./whatsappCalls");
    await sweepStaleCallsThrottled(true);
  } catch { /* nunca parte a manutenção */ }

  // Estados que chegaram antes da mensagem e ficaram por aplicar (corrida entre
  // o webhook e o fim do envio, 17b): aplica-os à mensagem que já existe ANTES
  // de limpar — senão um "falhou" perdia-se e a mensagem ficava "enviada".
  try {
    const stuck = await db
      .select({ waMessageId: whatsappPendingStatuses.waMessageId })
      .from(whatsappPendingStatuses)
      .where(sql`EXISTS (SELECT 1 FROM whatsapp_messages pm WHERE pm.waMessageId = ${whatsappPendingStatuses.waMessageId})`)
      .limit(200);
    for (const r of stuck) {
      await reconcilePendingStatus(db, r.waMessageId);
      out.pendingStatusesApplied = (out.pendingStatusesApplied ?? 0) + 1;
    }
  } catch (err: any) {
    console.warn("[WhatsApp] aplicar estados pendentes falhou:", String(err?.message ?? err).slice(0, 160));
  }

  const del = await db
    .delete(whatsappPendingStatuses)
    .where(sql`${whatsappPendingStatuses.receivedAt} < DATE_SUB(NOW(), INTERVAL 7 DAY)`);
  out.pendingStatusesPurged = Number((del as any)[0]?.affectedRows ?? 0);

  // Nova tentativa das mensagens de equipa retidas por 131049 há 24 h (0375).
  if (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    try {
      const { runWhatsappRetries } = await import("./whatsappFailurePolicy");
      out.retries = await runWhatsappRetries(db);
    } catch (err: any) {
      console.warn("[WhatsApp] novas tentativas (131049) falharam:", String(err?.message ?? err).slice(0, 160));
    }
  }
  return out;
}
