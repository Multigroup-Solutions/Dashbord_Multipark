/**
 * Chamadas de voz do WhatsApp (WhatsApp Business Calling API) — regras PURAS
 * partilhadas entre servidor e cliente: estados, prazos, autorização do cliente
 * para a empresa ligar (limites da Meta) e o texto das entradas da conversa.
 *
 * Referência (Meta, set 2026):
 *  - chamadas recebidas: a Meta termina a chamada do lado do cliente ("Não
 *    atendida") se a empresa não responder em ~30–60 s;
 *  - autorização: temporária = 7 dias (168 h); permanente = sem fim (o cliente
 *    pode revogar); no máximo 1 pedido por 24 h e 2 por 7 dias; 100 chamadas
 *    ligadas por 24 h por cliente; 2 chamadas seguidas sem resposta → aviso ao
 *    cliente, 4 → a Meta revoga a autorização.
 */

export const CALL_STATUSES = ["ringing", "answering", "dialing", "connected", "ended", "missed", "rejected", "failed"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];
export type CallDirection = "in" | "out";

/** Estados em que a chamada ainda está viva (UI de chamada aberta). */
export const LIVE_CALL_STATUSES: readonly CallStatus[] = ["ringing", "answering", "dialing", "connected"];
export const isLiveCallStatus = (s: string | null | undefined): boolean => LIVE_CALL_STATUSES.includes(s as CallStatus);

export function isCallStatus(s: unknown): s is CallStatus {
  return typeof s === "string" && (CALL_STATUSES as readonly string[]).includes(s);
}

/** Chamada recebida a tocar há mais do que isto → perdida (a Meta desiste aos 30–60 s). */
export const RING_TIMEOUT_MS = 60_000;
/** Mostrar o toque só nos primeiros N ms (margem para o relógio / atraso do webhook). */
export const RING_VISIBLE_MS = 75_000;
/** Atendida no dashboard mas o browser nunca chegou a aceitar → falhada. */
export const ANSWERING_STALE_MS = 2 * 60_000;
/** Chamada nossa sem resposta do cliente → não atendida. */
export const DIALING_STALE_MS = 2 * 60_000;
/** Ligada sem "terminate" da Meta há demasiado tempo → dá-se por terminada. */
export const CONNECTED_STALE_MS = 4 * 3_600_000;

/** Autorização temporária (dias) e limites da Meta. */
export const TEMP_PERMISSION_DAYS = 7;
export const PERMISSION_REQUESTS_PER_24H = 1;
export const PERMISSION_REQUESTS_PER_7D = 2;
export const MAX_CONNECTED_CALLS_24H = 100;
export const UNANSWERED_WARN = 2;
export const UNANSWERED_REVOKE = 4;

export const CALL_STATUS_LABELS: Record<CallStatus, string> = {
  ringing: "A tocar",
  answering: "A atender",
  dialing: "A chamar",
  connected: "Em chamada",
  ended: "Terminada",
  missed: "Perdida",
  rejected: "Recusada",
  failed: "Falhou",
};

// ─── Datas (BD = 'YYYY-MM-DD HH:MM:SS' em UTC) ──────────────────────────────

/** 'YYYY-MM-DD HH:MM:SS' (UTC) ou ISO → epoch ms, ou null. PURA. */
export function dbUtcMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
  const t = new Date(withZ).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Date → 'YYYY-MM-DD HH:MM:SS' (UTC). PURA. */
export function toDbUtc(d: Date | number): string {
  return new Date(d).toISOString().slice(0, 19).replace("T", " ");
}

/** A chamada recebida já tocou demasiado tempo? PURA. */
export function isRingingExpired(startedAt: string | null | undefined, now: number, timeoutMs = RING_TIMEOUT_MS): boolean {
  const t = dbUtcMs(startedAt);
  return t == null || now - t >= timeoutMs;
}

/** Duração legível: "45 s", "3 min", "1 h 05 min". PURA. */
export function formatCallDuration(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")} min`;
}

/** Cronómetro da chamada em curso: "mm:ss" ou "h:mm:ss". PURA. */
export function formatCallTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

// ─── Estado final a partir dos eventos da Meta ──────────────────────────────

/**
 * Estado depois de um "terminate" da Meta. PURA.
 *  - recebida que nunca foi atendida → perdida (`missed`);
 *  - recebida recusada por nós continua recusada;
 *  - feita por nós e nunca atendida pelo cliente → perdida do lado dele
 *    (`missed`, mas não entra no "por devolver" — isso é só para recebidas);
 *  - atendida → terminada; a atender (browser não chegou a aceitar) → falhada.
 */
export function statusAfterTerminate(current: string, direction: CallDirection, metaStatus?: string | null): CallStatus {
  if (current === "rejected" || current === "failed" || current === "missed" || current === "ended") return current as CallStatus;
  if (current === "connected") return "ended";
  const ms = String(metaStatus ?? "").toLowerCase();
  if (direction === "out") {
    if (ms.includes("reject")) return "rejected";
    if (ms.includes("fail")) return "failed";
    return "missed";
  }
  if (current === "answering") return "failed";
  return "missed";
}

/** Estado depois de um "status" (RINGING/ACCEPTED/REJECTED) da Meta. PURA; null = não muda. */
export function statusAfterMetaStatus(current: string, metaStatus: string): CallStatus | null {
  const s = String(metaStatus).toUpperCase();
  if (!isLiveCallStatus(current)) return null; // terminada: nada volta atrás
  if (s === "ACCEPTED") return current === "connected" ? null : "connected";
  if (s === "REJECTED") return "rejected";
  if (s === "RINGING") return current === "dialing" ? "ringing" : null;
  return null;
}

// ─── Autorização do cliente para ligarmos ───────────────────────────────────

export type PermissionStatus = "none" | "requested" | "temporary" | "permanent" | "rejected";

export interface PermissionRow {
  status: string | null;
  expiresAt: string | null;
  isPermanent?: number | boolean | null;
  lastRequestAt?: string | null;
  requestTimes?: string | null;
}

/** Estado efetivo (temporária expirada → sem autorização). PURA. */
export function effectivePermission(row: PermissionRow | null | undefined, now: number): { status: PermissionStatus; expiresAt: string | null; valid: boolean } {
  if (!row) return { status: "none", expiresAt: null, valid: false };
  const st = String(row.status ?? "none") as PermissionStatus;
  if (st === "permanent" || row.isPermanent === 1 || row.isPermanent === true) return { status: "permanent", expiresAt: null, valid: true };
  if (st === "temporary") {
    const exp = dbUtcMs(row.expiresAt);
    if (exp != null && exp > now) return { status: "temporary", expiresAt: row.expiresAt, valid: true };
    return { status: "none", expiresAt: null, valid: false };
  }
  if (st === "requested" || st === "rejected") return { status: st, expiresAt: null, valid: false };
  return { status: "none", expiresAt: null, valid: false };
}

/** Datas dos pedidos (JSON) → epoch ms, só as dos últimos 7 dias. PURA. */
export function parseRequestTimes(json: string | null | undefined, now: number): number[] {
  let arr: unknown = [];
  try { arr = JSON.parse(json || "[]"); } catch { arr = []; }
  if (!Array.isArray(arr)) return [];
  const week = 7 * 86_400_000;
  return arr
    .map((x) => (typeof x === "number" ? x : dbUtcMs(String(x))))
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t) && now - t < week && t <= now + 60_000)
    .sort((a, b) => a - b);
}

/** Acrescenta um pedido (mantém só os últimos 7 dias; cabe na coluna). PURA. */
export function appendRequestTime(json: string | null | undefined, now: number): string {
  return JSON.stringify([...parseRequestTimes(json, now), now].slice(-5));
}

/** Pode pedir autorização agora? (1 por 24 h, 2 por 7 dias). PURA. */
export function canRequestPermission(json: string | null | undefined, now: number): { ok: true } | { ok: false; reason: string; retryAt: number } {
  const times = parseRequestTimes(json, now);
  const day = 86_400_000;
  const last24 = times.filter((t) => now - t < day);
  if (last24.length >= PERMISSION_REQUESTS_PER_24H) {
    const retryAt = last24[0] + day;
    return { ok: false, reason: `Já foi enviado um pedido de autorização nas últimas 24 h (limite da Meta). Podes voltar a pedir depois de ${fmtRetry(retryAt)}.`, retryAt };
  }
  if (times.length >= PERMISSION_REQUESTS_PER_7D) {
    const retryAt = times[times.length - PERMISSION_REQUESTS_PER_7D] + 7 * day;
    return { ok: false, reason: `Já foram enviados ${PERMISSION_REQUESTS_PER_7D} pedidos de autorização nos últimos 7 dias (limite da Meta). Podes voltar a pedir depois de ${fmtRetry(retryAt)}.`, retryAt };
  }
  return { ok: true };
}

function fmtRetry(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** Validade de uma autorização aceite (webhook). PURA. */
export function permissionFromReply(reply: { response?: string | null; isPermanent?: boolean | null; expirationTimestamp?: number | null }, now: number): { status: PermissionStatus; expiresAt: string | null; isPermanent: boolean } {
  if (String(reply.response ?? "").toLowerCase() !== "accept") return { status: "rejected", expiresAt: null, isPermanent: false };
  if (reply.isPermanent) return { status: "permanent", expiresAt: null, isPermanent: true };
  const exp = reply.expirationTimestamp && reply.expirationTimestamp > 0 ? reply.expirationTimestamp * 1000 : now + TEMP_PERMISSION_DAYS * 86_400_000;
  return { status: "temporary", expiresAt: toDbUtc(exp), isPermanent: false };
}

// ─── Linha da conversa ──────────────────────────────────────────────────────

export interface CallTimelineInput {
  direction: CallDirection;
  status: string;
  durationSec: number | null;
  answeredByName?: string | null;
  startedByName?: string | null;
  missed?: number | boolean | null;
}

/**
 * Texto da entrada na conversa (a hora vem formatada de fora, no fuso de quem
 * lê): "Chamada recebida 14:32 · 3 min · atendida por Ana". PURA.
 */
export function callTimelineLabel(c: CallTimelineInput, time: string): string {
  const who = (n?: string | null) => (n && n.trim() ? n.trim() : null);
  if (c.direction === "in") {
    if (c.status === "missed" || c.missed === 1 || c.missed === true) return `Chamada perdida ${time}`;
    if (c.status === "rejected") return `Chamada recusada ${time}${who(c.answeredByName) ? ` · por ${who(c.answeredByName)}` : ""}`;
    if (c.status === "failed") return `Chamada recebida ${time} · não foi possível ligar o áudio`;
    if (c.status === "ringing") return `Chamada a tocar ${time}`;
    if (c.status === "answering" || c.status === "connected") return `Chamada em curso ${time}${who(c.answeredByName) ? ` · atendida por ${who(c.answeredByName)}` : ""}`;
    const dur = c.durationSec != null ? ` · ${formatCallDuration(c.durationSec)}` : "";
    return `Chamada recebida ${time}${dur}${who(c.answeredByName) ? ` · atendida por ${who(c.answeredByName)}` : ""}`;
  }
  const by = who(c.startedByName) ? ` · por ${who(c.startedByName)}` : "";
  if (c.status === "missed") return `Chamada efetuada ${time} · não atendida${by}`;
  if (c.status === "rejected") return `Chamada efetuada ${time} · recusada pelo cliente${by}`;
  if (c.status === "failed") return `Chamada efetuada ${time} · falhou${by}`;
  if (isLiveCallStatus(c.status)) return `Chamada em curso ${time}${by}`;
  const dur = c.durationSec != null ? ` · ${formatCallDuration(c.durationSec)}` : "";
  return `Chamada efetuada ${time}${dur}${by}`;
}

// ─── Erros da Meta (chamadas) → PT-PT ───────────────────────────────────────

/** Mensagem legível para um erro da Calling API. PURA. */
export function describeCallError(code: number | undefined, message?: string | null): string {
  switch (code) {
    case 138000:
      return "As chamadas não estão ativas neste número (super admin: WhatsApp → Chamadas → Configuração, ou WhatsApp Manager).";
    case 138001:
      return "O cliente não pode receber chamadas do WhatsApp (sem WhatsApp, termos por aceitar ou app sem chamadas).";
    case 138002:
      return "Limite de chamadas em simultâneo da Meta atingido — tenta daqui a pouco.";
    case 138003:
      return "Já há uma chamada em curso com este cliente.";
    case 138004:
      return "Erro da Meta ao ligar a chamada — tenta outra vez.";
    case 138005:
      return "Limite de chamadas iniciadas atingido (Meta) — tenta mais tarde.";
    case 138006:
      return "O cliente não deu autorização para receber chamadas deste número (ou a autorização expirou). Pede autorização primeiro.";
    case 138007:
      return "A chamada não ligou (tempo esgotado).";
    case 138009:
      return "Limite de pedidos de autorização atingido (1 por 24 h, 2 por 7 dias).";
    case 138012:
      return "Limite de 100 chamadas ligadas em 24 h para este cliente atingido (Meta).";
    case 138013:
      return "Chamadas feitas pela empresa não estão disponíveis para este número/país.";
    case 138014:
      return "A Meta desativou temporariamente as chamadas deste número por baixa qualidade.";
    case 138015:
      return "A Meta não permite ativar chamadas neste número.";
    case 138017:
      return "O cliente já deu autorização permanente — não é preciso pedir.";
    case 138018:
      return "Faltam requisitos técnicos: subscrever o campo \"calls\" no webhook da app Meta.";
    case 138019:
    case 138020:
    case 138021:
    case 138022:
    case 138023:
      return "A app do cliente não conseguiu estabelecer o áudio (rede/firewall). Tenta outra vez.";
    case 131047:
      return "Janela de 24 h fechada — o pedido de autorização só pode ir num template aprovado.";
    case 190:
      return "Token de acesso do WhatsApp expirado ou inválido.";
    default:
      return (message && String(message).trim()) || "A Meta recusou o pedido.";
  }
}
