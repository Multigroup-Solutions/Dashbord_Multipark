/**
 * Inbox de WhatsApp — estado da conversa, atribuição e alertas (migração 0097).
 * PURO e partilhado cliente/servidor: a UI e o servidor usam as MESMAS regras
 * (lista, badge da sidebar, avisos por cidade).
 *
 * Estados:
 *  - aberto    → precisa de atenção (novo ou em curso);
 *  - pendente  → à espera de algo (do cliente, de outra equipa…) — não conta
 *                para o SLA de resposta;
 *  - resolvido → fechado. Uma nova mensagem do contacto REABRE (→ aberto).
 */
import { effectiveSlaMinutes } from "./commsAi";
import { CITY_KEYS, CITY_LABELS, type CityKey } from "./city";

export const CONVERSATION_STATUSES = ["aberto", "pendente", "resolvido"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const CONVERSATION_STATUS_LABELS: Record<ConversationStatus, string> = {
  aberto: "Aberta",
  pendente: "Pendente",
  resolvido: "Resolvida",
};

export function isConversationStatus(v: unknown): v is ConversationStatus {
  return typeof v === "string" && (CONVERSATION_STATUSES as readonly string[]).includes(v);
}

/**
 * Estado depois de uma mensagem RECEBIDA. Só uma resposta verdadeira (texto,
 * media — não reações/tipos não suportados) mexe no estado: resolvida ou
 * pendente voltam a "aberto" (o contacto escreveu → a bola está do nosso lado).
 */
export function nextStatusOnInbound(current: string | null | undefined, countsAsReply: boolean): ConversationStatus {
  const cur: ConversationStatus = isConversationStatus(current) ? current : "aberto";
  if (!countsAsReply) return cur;
  return "aberto";
}

/**
 * "Sem resposta desde": a 1.ª mensagem por responder mantém-se (COALESCE) até
 * sair uma resposta nossa. Recebida (resposta verdadeira) → fica a atual ou `ts`.
 */
export function nextAwaitingSince(current: string | null | undefined, ts: string, countsAsReply: boolean): string | null {
  if (!countsAsReply) return current ?? null;
  return current || ts;
}

// ─── SLA / janela ───────────────────────────────────────────────────────────

export const DEFAULT_SLA_MINUTES = 15;
/** A janela de 24h "está a fechar" com menos disto por usar. */
export const WINDOW_CLOSING_MS = 2 * 60 * 60 * 1000;

/** WHATSAPP_SLA_MINUTES → minutos (1..1440); inválido/vazio → 15. */
export function parseSlaMinutes(raw: string | null | undefined): number {
  const n = Number(String(raw ?? "").trim());
  if (!String(raw ?? "").trim() || !Number.isFinite(n) || n <= 0) return DEFAULT_SLA_MINUTES;
  return Math.min(1440, Math.max(1, Math.round(n)));
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC, sem tz) ou ISO → epoch ms; null se inválido. */
export function parseDbUtcMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
  const t = new Date(withZ).getTime();
  return Number.isNaN(t) ? null : t;
}

export interface AlertInput {
  status: string | null | undefined;
  /** 1.ª mensagem recebida ainda sem resposta nossa (null = respondida). */
  awaitingSince: string | null | undefined;
  unreadCount?: number | null;
  windowState: "awaiting_first_reply" | "open" | "expired";
  /** ISO, só com a janela aberta. */
  windowExpiresAt: string | null | undefined;
  optedOut?: boolean;
  /** Urgência da triagem por IA (0123): "urgente" entra no SLA mais cedo. */
  aiUrgency?: string | null;
}

export interface ConversationAlerts {
  /** Recebida e ainda sem resposta (conversa aberta). */
  unanswered: boolean;
  /** Minutos desde a 1.ª mensagem por responder (0 se respondida). */
  waitingMinutes: number;
  /** Sem resposta há mais do que o SLA. */
  overdue: boolean;
  /** Janela de 24h aberta com menos de 2h por usar (conversa não resolvida). */
  windowClosing: boolean;
  /** Minutos que restam na janela (null fora da janela). */
  windowMinutesLeft: number | null;
  /** Precisa de atenção: por ler, ou aberta e por responder (badge da sidebar). */
  needsAttention: boolean;
}

/** Alertas de UMA conversa. PURA. */
export function conversationAlerts(c: AlertInput, now: number, slaMinutes: number = DEFAULT_SLA_MINUTES): ConversationAlerts {
  const status: ConversationStatus = isConversationStatus(c.status) ? c.status : "aberto";
  const since = parseDbUtcMs(c.awaitingSince ?? null);
  const unanswered = status === "aberto" && since != null && !c.optedOut;
  const waitingMinutes = unanswered ? Math.max(0, Math.floor((now - since!) / 60_000)) : 0;
  const overdue = unanswered && waitingMinutes >= effectiveSlaMinutes(slaMinutes, c.aiUrgency);

  let windowMinutesLeft: number | null = null;
  if (c.windowState === "open" && c.windowExpiresAt) {
    const left = new Date(c.windowExpiresAt).getTime() - now;
    if (!Number.isNaN(left)) windowMinutesLeft = Math.max(0, Math.floor(left / 60_000));
  }
  const windowClosing =
    status !== "resolvido" && !c.optedOut && windowMinutesLeft != null && windowMinutesLeft * 60_000 < WINDOW_CLOSING_MS;

  const needsAttention = (status !== "resolvido" && (c.unreadCount ?? 0) > 0) || unanswered;
  return { unanswered, waitingMinutes, overdue, windowClosing, windowMinutesLeft, needsAttention };
}

/** "23 min", "2h 05m", "3 d" — tempo de espera legível. PURA. */
export function formatWaiting(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  return `${Math.floor(minutes / 1440)} d`;
}

// ─── Filtros da lista ───────────────────────────────────────────────────────

export type AssigneeFilter = "all" | "mine" | "unassigned";
export type StatusFilter = "active" | ConversationStatus | "all";

/** Filtro de atribuição + estado da lista (em AND). PURA. */
export function matchesInboxFilters(
  c: { status: string | null | undefined; assignedUserId: number | null | undefined; assignedCityKey?: string | null },
  f: { assignee: AssigneeFilter; status: StatusFilter; userId: number | null | undefined },
): boolean {
  if (f.assignee === "mine" && (f.userId == null || c.assignedUserId !== f.userId)) return false;
  // Atribuída a um grupo de cidade (D28) já tem responsável.
  if (f.assignee === "unassigned" && (c.assignedUserId != null || !!c.assignedCityKey)) return false;
  const status = isConversationStatus(c.status) ? c.status : "aberto";
  if (f.status === "all") return true;
  if (f.status === "active") return status !== "resolvido";
  return status === f.status;
}

// ─── Responsável: pessoa ou grupo de cidade (D28, Jorge 3 out 2026) ─────────

export const isCityKey = (v: unknown): v is CityKey => typeof v === "string" && (CITY_KEYS as readonly string[]).includes(v);

/** Nome do grupo de cidade ("Grupo Lisboa"). PURA. */
export function cityGroupLabel(cityKey: string | null | undefined): string | null {
  return isCityKey(cityKey) ? `Grupo ${CITY_LABELS[cityKey]}` : null;
}

/** Valor do seletor de responsável: "u:12" (pessoa), "c:lisboa" (grupo), "none". PURA. */
export function encodeAssignee(userId: number | null | undefined, cityKey: string | null | undefined): string {
  if (userId != null) return `u:${userId}`;
  if (isCityKey(cityKey)) return `c:${cityKey}`;
  return "none";
}

export type AssigneeChoice = { userId: number | null; cityKey: CityKey | null };

/** O contrário de `encodeAssignee`; valor desconhecido → null. PURA. */
export function decodeAssignee(v: string): AssigneeChoice | null {
  if (v === "none") return { userId: null, cityKey: null };
  const m = /^u:(\d+)$/.exec(v);
  if (m) return { userId: Number(m[1]), cityKey: null };
  const c = /^c:(\w+)$/.exec(v);
  if (c && isCityKey(c[1])) return { userId: null, cityKey: c[1] };
  return null;
}

// ─── Respostas rápidas ──────────────────────────────────────────────────────

/**
 * D29 (Jorge, 3 out 2026): respostas rápidas por cidade. `cityKey` null =
 * nacional; `userCities` null = a pessoa vê todas as cidades. Cada cidade vê as
 * suas + as nacionais; cada um só edita as da(s) sua(s) cidade(s) (as nacionais,
 * só quem vê todas). PURAS.
 */
export function quickReplyVisible(cityKey: string | null | undefined, userCities: readonly string[] | null): boolean {
  return cityKey == null || userCities == null || userCities.includes(cityKey);
}
export function quickReplyEditable(cityKey: string | null | undefined, userCities: readonly string[] | null): boolean {
  if (userCities == null) return true;
  return cityKey != null && userCities.includes(cityKey);
}

/** Substitui {{nome}} pelo primeiro nome do contacto (ou remove-o, sem nome). PURA. */
export function fillQuickReply(body: string, firstName: string | null | undefined): string {
  const name = (firstName ?? "").trim();
  return body
    .replace(/\{\{\s*nome\s*\}\}/gi, name)
    .replace(/[ \t]+([,.!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
