/**
 * Inbox de WhatsApp (Fase 3): listagem de conversas, thread, marcar-lido e
 * resposta 1-a-1 (só dentro da janela de 24h).
 *
 * `deriveWindowState` é pura e testável — é a fonte única do estado da janela,
 * usada quer pela UI (para não duplicar lógica) quer pela validação server-side
 * do `reply`.
 */
import { projectVisible, scopedProjectIds } from "./extrasCityFilter";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "./db";
import { employees, users, whatsappConversations, whatsappMessages } from "../drizzle/schema";
import { sendTextMessage } from "./whatsapp";
import { firstNameOf } from "../shared/whatsappTemplate";
import { OPTED_OUT_ERROR, previewFields, recordOutboundMessage } from "./whatsappStore";
import type { ConversationStatus } from "../shared/whatsappConversation";

const WINDOW_MS = 24 * 60 * 60 * 1000;

export type WindowState = "awaiting_first_reply" | "open" | "expired";

export interface WindowInfo {
  windowState: WindowState;
  windowExpiresAt: string | null; // ISO (UTC), só quando 'open'
}

/**
 * Estado da janela de 24h a partir de `lastInboundAt`:
 *   - awaiting_first_reply: null → template enviado, nunca respondeu.
 *   - open: agora − lastInboundAt < 24h.
 *   - expired: já passaram 24h.
 * As timestamps da BD são wall-clock UTC ('YYYY-MM-DD HH:MM:SS' sem tz), por
 * isso são interpretadas como UTC (sufixo Z) para a matemática bater certo.
 */
export function deriveWindowState(lastInboundAt: string | null, now: Date = new Date()): WindowInfo {
  if (!lastInboundAt) return { windowState: "awaiting_first_reply", windowExpiresAt: null };
  const last = parseDbUtc(lastInboundAt);
  if (last == null) return { windowState: "expired", windowExpiresAt: null };
  const expires = last + WINDOW_MS;
  if (now.getTime() < expires) {
    return { windowState: "open", windowExpiresAt: new Date(expires).toISOString() };
  }
  return { windowState: "expired", windowExpiresAt: null };
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC) → epoch ms, ou null. Aceita já-ISO com Z/T. */
function parseDbUtc(s: string): number | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
  const t = new Date(withZ).getTime();
  return Number.isNaN(t) ? null : t;
}

// ─── Listagem de conversas ──────────────────────────────────────────────────

export interface ConversationRow {
  id: number;
  phoneE164: string;
  employeeId: number | null;
  name: string; // nome do extra ou o próprio número
  unreadCount: number;
  lastInboundAt: string | null;
  lastMessageAt: string | null;
  preview: string | null;
  previewDirection: "in" | "out" | null;
  /** Pediu para não receber mensagens (STOP). */
  optedOut: boolean;
  windowState: WindowState;
  windowExpiresAt: string | null;
  /** aberto/pendente/resolvido (0097). */
  status: ConversationStatus;
  assignedUserId: number | null;
  assignedName: string | null;
  /** 1.ª mensagem recebida ainda sem resposta (SLA); null = respondida. */
  awaitingSince: string | null;
  linkedBookingId: number | null;
  linkedClientEmail: string | null;
}

/**
 * Ordem da lista do inbox (pedido Jorge 2026-09-10) — regra ÚNICA, pura e
 * testável; a UI só agrupa, nunca reordena:
 *   1. Conversas com a janela ABERTA primeiro, da que tem MENOS tempo para
 *      responder para a que tem mais (`windowExpiresAt` ascendente) — quem está
 *      prestes a fechar fica no topo.
 *   2. Depois as que estão FORA da janela (`expired` e `awaiting_first_reply`),
 *      pela última mensagem trocada: mais recente primeiro, mais antiga no fim.
 * Empates: dentro do grupo aberto, última mensagem mais recente primeiro; no
 * fim, id decrescente para a ordem ser determinística. `lastMessageAt` nulo
 * (não deve acontecer — a conversa nasce com mensagem) vai para o fim.
 */
export function sortConversations<T extends Pick<ConversationRow, "id" | "windowState" | "windowExpiresAt" | "lastMessageAt">>(
  rows: readonly T[],
): T[] {
  const NULL_LAST = Number.POSITIVE_INFINITY;
  const expiresMs = (r: T) => (r.windowExpiresAt ? new Date(r.windowExpiresAt).getTime() : NULL_LAST);
  const lastMsgMs = (r: T) => (r.lastMessageAt ? (parseDbUtc(r.lastMessageAt) ?? -1) : -1);

  return [...rows].sort((a, b) => {
    const aOpen = a.windowState === "open" ? 0 : 1;
    const bOpen = b.windowState === "open" ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    if (aOpen === 0) {
      const byExpiry = expiresMs(a) - expiresMs(b);
      if (byExpiry !== 0) return byExpiry;
    }
    const byLastMsg = lastMsgMs(b) - lastMsgMs(a);
    if (byLastMsg !== 0) return byLastMsg;
    return b.id - a.id;
  });
}

// ─── Visibilidade por cidade ────────────────────────────────────────────────

/** O que se sabe de uma conversa para decidir a cidade. */
export interface ConversationCityFacts {
  employeeId: number | null;
  employeeProjectId: number | null;
  /** projectId de cada lead com este número (vazio = não é lead). */
  leadProjectIds: (number | null)[];
  /** Cidade inferida pelo telefone de uma reserva (só números soltos). */
  bookingProjectId: number | null;
}

/**
 * Cidade (ponto 10), regra ÚNICA — `visibilitySql` é a mesma coisa em SQL. PURA.
 *  - quem vê todas as cidades (`scope` undefined) vê tudo;
 *  - extra: pela cidade da ficha (ficha sem cidade → visível);
 *  - lead: se ALGUM lead com o número é da cidade (ou sem cidade);
 *  - número solto (sem ficha nem lead): só se uma reserva com o mesmo
 *    telefone (últimos 9 dígitos) for de uma cidade do utilizador — senão fica
 *    só para quem vê todas as cidades.
 */
export function conversationVisibleTo(c: ConversationCityFacts, scope: number[] | undefined): boolean {
  if (scope === undefined) return true;
  if (c.employeeId != null) return projectVisible(c.employeeProjectId, scope);
  if (c.leadProjectIds.length) return c.leadProjectIds.some((p) => projectVisible(p, scope));
  return c.bookingProjectId != null && scope.includes(c.bookingProjectId);
}

/** Mesma regra de `conversationVisibleTo`, em SQL (aplicada ANTES do LIMIT). */
export function visibilitySql(scope: number[] | undefined): SQL {
  if (scope === undefined) return sql`1 = 1`;
  if (!scope.length) return sql`1 = 0`;
  const inScope = (col: SQL) => sql`${col} IN (${sql.join(scope.map((id) => sql`${id}`), sql`, `)})`;
  return sql`(
    (${whatsappConversations.employeeId} IS NOT NULL AND (${employees.projectId} IS NULL OR ${inScope(sql`${employees.projectId}`)}))
    OR (${whatsappConversations.employeeId} IS NULL AND EXISTS (
      SELECT 1 FROM extra_leads vis_lead WHERE vis_lead.phoneE164 = ${whatsappConversations.phoneE164} COLLATE utf8mb4_unicode_ci
        AND (vis_lead.projectId IS NULL OR ${inScope(sql`vis_lead.projectId`)})))
    OR (${whatsappConversations.employeeId} IS NULL
      AND NOT EXISTS (SELECT 1 FROM extra_leads vis_any WHERE vis_any.phoneE164 = ${whatsappConversations.phoneE164} COLLATE utf8mb4_unicode_ci)
      AND ${inScope(sql`${whatsappConversations.bookingProjectId}`)})
  )`;
}

/** A conversa pertence às cidades do utilizador? (guarda da thread/resposta/lido) */
export async function conversationVisible(conversationId: number): Promise<boolean> {
  const scope = scopedProjectIds();
  if (scope === undefined) return true;
  const db = await getDb();
  if (!db) return false;
  const exists = await db
    .select({ id: whatsappConversations.id })
    .from(whatsappConversations)
    .where(eq(whatsappConversations.id, conversationId))
    .limit(1);
  if (!exists.length) return true; // inexistente → quem chama trata do "não encontrada"
  const rows = await db
    .select({ id: whatsappConversations.id })
    .from(whatsappConversations)
    .leftJoin(employees, eq(whatsappConversations.employeeId, employees.id))
    .where(and(eq(whatsappConversations.id, conversationId), visibilitySql(scope)))
    .limit(1);
  return rows.length > 0;
}

/** Nome do lead mais recente com o número da conversa (subquery escalar). */
const leadNameSql = sql<string | null>`(SELECT ln.fullName FROM extra_leads ln WHERE ln.phoneE164 = ${whatsappConversations.phoneE164} COLLATE utf8mb4_unicode_ci ORDER BY ln.id DESC LIMIT 1)`;

/**
 * Conversas antigas sem resumo (escritas antes da 0094 e não apanhadas pelo
 * backfill): calcula-o a partir da última mensagem e grava-o, 1× por conversa.
 */
async function fillMissingPreviews(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, ids: number[]): Promise<Map<number, ReturnType<typeof previewFields>>> {
  const out = new Map<number, ReturnType<typeof previewFields>>();
  if (!ids.length) return out;
  const [rows] = (await db.execute(sql`
    SELECT m.conversationId, m.body, m.type, m.templateName, m.mediaType, m.direction
      FROM whatsapp_messages m
      JOIN (SELECT conversationId, MAX(id) AS maxId FROM whatsapp_messages
             WHERE conversationId IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
             GROUP BY conversationId) t ON t.maxId = m.id`)) as any;
  for (const r of rows as any[]) {
    const p = previewFields({ body: r.body, type: r.type, templateName: r.templateName, mediaType: r.mediaType, direction: r.direction });
    out.set(Number(r.conversationId), p);
    await db.update(whatsappConversations).set(p).where(and(eq(whatsappConversations.id, Number(r.conversationId)), isNull(whatsappConversations.lastDirection)));
  }
  return out;
}

export async function listConversations(): Promise<ConversationRow[]> {
  const db = await getDb();
  if (!db) return [];

  // O filtro de cidade vai no WHERE, ANTES do LIMIT — senão quem só vê uma
  // cidade podia ficar com uma lista vazia porque as 300 mais recentes eram
  // de outra.
  const fullQuery = () => db
    .select({
      id: whatsappConversations.id,
      phoneE164: whatsappConversations.phoneE164,
      employeeId: whatsappConversations.employeeId,
      unreadCount: whatsappConversations.unreadCount,
      lastInboundAt: whatsappConversations.lastInboundAt,
      lastMessageAt: whatsappConversations.lastMessageAt,
      lastPreview: whatsappConversations.lastPreview,
      lastDirection: whatsappConversations.lastDirection,
      optedOutAt: whatsappConversations.optedOutAt,
      profileName: whatsappConversations.profileName,
      employeeName: employees.fullName,
      leadName: leadNameSql,
      status: whatsappConversations.status,
      assignedUserId: whatsappConversations.assignedUserId,
      assignedName: users.name,
      awaitingSince: whatsappConversations.awaitingSince,
      linkedBookingId: whatsappConversations.linkedBookingId,
      linkedClientEmail: whatsappConversations.linkedClientEmail,
    })
    .from(whatsappConversations)
    .leftJoin(employees, eq(whatsappConversations.employeeId, employees.id))
    .leftJoin(users, eq(whatsappConversations.assignedUserId, users.id))
    .where(visibilitySql(scopedProjectIds()))
    .orderBy(desc(whatsappConversations.lastMessageAt))
    .limit(300);

  // Rede de segurança: se a query completa falhar em produção (ex.: coluna da
  // 0097 em falta, JOIN a users), a caixa continua a mostrar as conversas com
  // os campos base — e o erro fica no log com a mensagem do MySQL.
  const baseQuery = () => db
    .select({
      id: whatsappConversations.id,
      phoneE164: whatsappConversations.phoneE164,
      employeeId: whatsappConversations.employeeId,
      unreadCount: whatsappConversations.unreadCount,
      lastInboundAt: whatsappConversations.lastInboundAt,
      lastMessageAt: whatsappConversations.lastMessageAt,
      lastPreview: whatsappConversations.lastPreview,
      lastDirection: whatsappConversations.lastDirection,
      optedOutAt: whatsappConversations.optedOutAt,
      profileName: whatsappConversations.profileName,
      employeeName: employees.fullName,
      leadName: sql<string | null>`NULL`,
      status: sql<ConversationStatus>`'aberto'`,
      assignedUserId: sql<number | null>`NULL`,
      assignedName: sql<string | null>`NULL`,
      awaitingSince: sql<string | null>`NULL`,
      linkedBookingId: sql<number | null>`NULL`,
      linkedClientEmail: sql<string | null>`NULL`,
    })
    .from(whatsappConversations)
    .leftJoin(employees, eq(whatsappConversations.employeeId, employees.id))
    .where(visibilitySql(scopedProjectIds()))
    .orderBy(desc(whatsappConversations.lastMessageAt))
    .limit(300);

  let convs: Awaited<ReturnType<typeof fullQuery>>;
  try {
    convs = await fullQuery();
  } catch (err: any) {
    console.error("[WhatsApp] listConversations falhou, a usar query base:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 500));
    convs = (await baseQuery()) as typeof convs;
  }

  const missing = convs.filter((c) => c.lastDirection == null && c.lastMessageAt != null).map((c) => c.id);
  const filled = await fillMissingPreviews(db, missing);

  // A query vem por `lastMessageAt` desc só para o cap de 300 apanhar as
  // conversas ativas; a ordem que a UI mostra é a de `sortConversations`.
  const rows: ConversationRow[] = convs.map((c) => {
    const w = deriveWindowState(c.lastInboundAt);
    const f = filled.get(c.id);
    return {
      id: c.id,
      phoneE164: c.phoneE164,
      employeeId: c.employeeId,
      name: conversationDisplayName(c),
      unreadCount: c.unreadCount,
      lastInboundAt: c.lastInboundAt,
      lastMessageAt: c.lastMessageAt,
      preview: (f?.lastPreview ?? c.lastPreview) || null,
      previewDirection: (f?.lastDirection ?? c.lastDirection) ?? null,
      optedOut: c.optedOutAt != null,
      windowState: w.windowState,
      windowExpiresAt: w.windowExpiresAt,
      status: c.status,
      assignedUserId: c.assignedUserId,
      assignedName: c.assignedName ?? null,
      awaitingSince: c.awaitingSince,
      linkedBookingId: c.linkedBookingId,
      linkedClientEmail: c.linkedClientEmail,
    };
  });
  return sortConversations(rows);
}

/** Nome a mostrar: ficha → lead → nome de perfil WhatsApp → número. PURA. */
export function conversationDisplayName(c: {
  employeeName?: string | null;
  leadName?: string | null;
  profileName?: string | null;
  phoneE164: string;
}): string {
  return c.employeeName?.trim() || c.leadName?.trim() || c.profileName?.trim() || c.phoneE164;
}

// ─── Thread de uma conversa ─────────────────────────────────────────────────

export interface ThreadMessage {
  id: number;
  direction: "in" | "out";
  type: "text" | "template" | "image" | "audio" | "document" | "video";
  body: string | null;
  templateName: string | null;
  /** Media recebida. O ficheiro é privado: a UI pede um URL assinado (whatsapp.mediaUrl). */
  mediaType: "image" | "audio" | "video" | "document" | "sticker" | null;
  /** Há ficheiro guardado? false com `mediaType` preenchido = download falhou (o cron re-tenta). */
  mediaAvailable: boolean;
  mediaMime: string | null;
  status: string;
  errorDetail: string | null;
  waTimestamp: string | null;
  createdAt: string;
}

export interface ConversationThread {
  conversationId: number;
  phoneE164: string;
  /** Ficha do colaborador associada (null = número sem ficha; o cabeçalho não fica clicável). */
  employeeId: number | null;
  name: string;
  /** Primeiro nome real do destinatário (ficha → lead → perfil); null = só temos o número. */
  recipientFirstName: string | null;
  /** Pediu para não receber mensagens (STOP). */
  optedOut: boolean;
  optedOutAt: string | null;
  windowState: WindowState;
  windowExpiresAt: string | null;
  status: ConversationStatus;
  assignedUserId: number | null;
  awaitingSince: string | null;
  unreadCount: number;
  linkedBookingId: number | null;
  linkedClientEmail: string | null;
  messages: ThreadMessage[];
}

export async function getConversationThread(conversationId: number, limit = 100): Promise<ConversationThread | null> {
  const db = await getDb();
  if (!db) return null;

  const convRows = await db
    .select({
      id: whatsappConversations.id,
      phoneE164: whatsappConversations.phoneE164,
      employeeId: whatsappConversations.employeeId,
      lastInboundAt: whatsappConversations.lastInboundAt,
      optedOutAt: whatsappConversations.optedOutAt,
      profileName: whatsappConversations.profileName,
      employeeName: employees.fullName,
      leadName: leadNameSql,
      status: whatsappConversations.status,
      assignedUserId: whatsappConversations.assignedUserId,
      awaitingSince: whatsappConversations.awaitingSince,
      unreadCount: whatsappConversations.unreadCount,
      linkedBookingId: whatsappConversations.linkedBookingId,
      linkedClientEmail: whatsappConversations.linkedClientEmail,
    })
    .from(whatsappConversations)
    .leftJoin(employees, eq(whatsappConversations.employeeId, employees.id))
    .where(eq(whatsappConversations.id, conversationId))
    .limit(1);
  if (!convRows.length) return null;
  const conv = convRows[0];

  const rows = await db
    .select({
      id: whatsappMessages.id,
      direction: whatsappMessages.direction,
      type: whatsappMessages.type,
      body: whatsappMessages.body,
      templateName: whatsappMessages.templateName,
      mediaType: whatsappMessages.mediaType,
      mediaKey: whatsappMessages.mediaKey,
      mediaUrl: whatsappMessages.mediaUrl,
      mediaMime: whatsappMessages.mediaMime,
      status: whatsappMessages.status,
      errorDetail: whatsappMessages.errorDetail,
      waTimestamp: whatsappMessages.waTimestamp,
      createdAt: whatsappMessages.createdAt,
    })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.conversationId, conversationId))
    .orderBy(desc(whatsappMessages.id))
    .limit(limit);

  const w = deriveWindowState(conv.lastInboundAt);
  const name = conversationDisplayName(conv);
  const realName = conv.employeeName || conv.leadName || conv.profileName;
  return {
    conversationId: conv.id,
    phoneE164: conv.phoneE164,
    employeeId: conv.employeeId,
    name,
    recipientFirstName: realName ? firstNameOf(realName) : null,
    optedOut: conv.optedOutAt != null,
    optedOutAt: conv.optedOutAt,
    windowState: w.windowState,
    windowExpiresAt: w.windowExpiresAt,
    status: conv.status,
    assignedUserId: conv.assignedUserId,
    awaitingSince: conv.awaitingSince,
    unreadCount: conv.unreadCount,
    linkedBookingId: conv.linkedBookingId,
    linkedClientEmail: conv.linkedClientEmail,
    // Nunca devolve o URL do storage: só se há ficheiro (o link assinado é pedido à parte).
    messages: rows
      .map(({ mediaKey, mediaUrl, ...m }) => ({ ...m, mediaAvailable: !!(mediaKey || mediaUrl) }) as ThreadMessage)
      .reverse(), // cronológico (antigo → recente)
  };
}

/**
 * URL ASSINADO (curta duração) do ficheiro de uma mensagem recebida. A guarda
 * de cidade é feita pela conversa da mensagem. null = mensagem sem ficheiro
 * ou fora do âmbito (quem chama responde "não encontrado").
 */
export async function getInboundMediaUrl(messageId: number): Promise<{ url: string; mime: string | null } | null> {
  const db = await getDb();
  if (!db) return null;
  const [m] = await db
    .select({
      conversationId: whatsappMessages.conversationId,
      mediaKey: whatsappMessages.mediaKey,
      mediaUrl: whatsappMessages.mediaUrl,
      mediaMime: whatsappMessages.mediaMime,
    })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.id, messageId))
    .limit(1);
  if (!m || !(m.mediaKey || m.mediaUrl)) return null;
  if (!(await conversationVisible(m.conversationId))) return null;
  const { storagePresignGet } = await import("./storage");
  const signed = await storagePresignGet(m.mediaKey || m.mediaUrl!, { fallbackUrl: m.mediaUrl, expiresSeconds: 600 });
  return signed.url ? { url: signed.url, mime: m.mediaMime } : null;
}

// ─── Marcar como lido ───────────────────────────────────────────────────────

export async function markConversationRead(conversationId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(whatsappConversations)
    .set({ unreadCount: 0 })
    .where(eq(whatsappConversations.id, conversationId));
}

/**
 * Marcar como NÃO lida (pedido do Jorge 2026-09-17): volta a pôr a conversa no
 * filtro "Não lidas" para ser retomada mais tarde. `unreadCount` é o mesmo
 * contador que o webhook incrementa; aqui garante-se pelo menos 1 sem nunca
 * BAIXAR um contador real (se entretanto chegaram 3 mensagens, ficam 3).
 * Devolve `false` quando a conversa não existe.
 */
export async function markConversationUnread(conversationId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const [result] = await db
    .update(whatsappConversations)
    .set({ unreadCount: sql`GREATEST(${whatsappConversations.unreadCount}, 1)` })
    .where(eq(whatsappConversations.id, conversationId));
  return Number((result as { affectedRows?: number }).affectedRows ?? 0) > 0;
}

// ─── Resposta 1-a-1 (texto livre, só janela aberta) ─────────────────────────

export interface ReplyResult {
  ok: boolean;
  waMessageId?: string;
  error?: string;
  /** O contacto pediu STOP — a UI pede confirmação e reenvia com `allowOptedOut`. */
  optedOut?: boolean;
}

/**
 * Texto livre para uma conversa (só com a janela de 24h aberta). Usado pela
 * resposta manual do inbox E pelas respostas automáticas.
 *
 * Opt-out: um contacto que pediu STOP não recebe nada automático. A resposta
 * manual só passa com `allowOptedOut` (a UI pede confirmação antes); a
 * confirmação do próprio STOP também usa esta via.
 */
export async function replyToConversation(
  conversationId: number,
  text: string,
  userId: number | null,
  opts: { allowOptedOut?: boolean } = {},
): Promise<ReplyResult> {
  const body = text.trim();
  if (!body) return { ok: false, error: "Mensagem vazia." };

  const db = await getDb();
  if (!db) return { ok: false, error: "Base de dados indisponível." };

  const rows = await db
    .select({
      id: whatsappConversations.id,
      phoneE164: whatsappConversations.phoneE164,
      lastInboundAt: whatsappConversations.lastInboundAt,
      optedOutAt: whatsappConversations.optedOutAt,
    })
    .from(whatsappConversations)
    .where(eq(whatsappConversations.id, conversationId))
    .limit(1);
  if (!rows.length) return { ok: false, error: "Conversa não encontrada." };
  const conv = rows[0];

  if (conv.optedOutAt && !opts.allowOptedOut) {
    return { ok: false, optedOut: true, error: OPTED_OUT_ERROR };
  }

  // Validação da janela NO SERVIDOR — a UI não é a fonte de verdade.
  const { windowState } = deriveWindowState(conv.lastInboundAt);
  if (windowState !== "open") {
    return {
      ok: false,
      error:
        windowState === "awaiting_first_reply"
          ? "Ainda sem resposta do contacto — só é possível escrever depois da primeira resposta. Inicia com um template."
          : "Janela de 24h fechada — inicia a conversa com um template.",
    };
  }

  const res = await sendTextMessage(conv.phoneE164, body);
  await recordOutboundMessage(db, {
    conversationId,
    waMessageId: res.ok ? res.waMessageId : null,
    type: "text",
    body,
    status: res.ok ? "sent" : "failed",
    errorDetail: res.ok ? null : res.error,
    sentById: userId,
  });

  return res.ok ? { ok: true, waMessageId: res.waMessageId } : { ok: false, error: res.error };
}
