/**
 * Escrita partilhada das mensagens WhatsApp (entrada e saída) — um só sítio
 * para as regras que antes estavam repetidas (e divergiam) em três ficheiros:
 *
 *  - o resumo da última mensagem guardado NA conversa (`lastPreview`,
 *    `lastDirection`, `lastType`) → a lista do inbox não lê mensagens;
 *  - timestamps da conversa só andam para a FRENTE (GREATEST) — um webhook
 *    atrasado ou fora de ordem não recua `lastInboundAt`/`lastMessageAt`;
 *  - status de entrega que chegou antes da linha outbound (tabela pendente)
 *    é aplicado quando a linha é gravada;
 *  - opt-out (STOP) consultado antes de qualquer envio automático.
 *
 * As partes puras (`previewFields`, `laterTimestamp`, `nextStatus`) são
 * testadas em whatsappStore.test.ts.
 */
import { eq, isNotNull, sql, type SQLWrapper } from "drizzle-orm";
import type { getDb } from "./db";
import { whatsappConversations, whatsappMessages, whatsappPendingStatuses } from "../drizzle/schema";
import { messageDisplayBody } from "../shared/whatsappTemplate";

export type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** Transação ou ligação normal — as duas têm a mesma API de query. */
export type DbLike = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

export type MessageStatus = "sent" | "delivered" | "read" | "failed";

// ─── Puras ──────────────────────────────────────────────────────────────────

export const PREVIEW_MAX = 120;

/** Resumo de uma mensagem para a conversa. PURA. */
export function previewFields(msg: {
  body?: string | null;
  type?: string | null;
  templateName?: string | null;
  mediaType?: string | null;
  direction: "in" | "out";
}): { lastPreview: string; lastDirection: "in" | "out"; lastType: string } {
  const text = messageDisplayBody(msg).replace(/\s+/g, " ").trim();
  return {
    lastPreview: text.slice(0, PREVIEW_MAX),
    lastDirection: msg.direction,
    lastType: String(msg.mediaType ?? msg.type ?? "text").slice(0, 16),
  };
}

/** 'YYYY-MM-DD HH:MM:SS' → comparável; null perde sempre. Semântica do SQL `sqlLaterTs`. PURA. */
export function laterTimestamp(current: string | null | undefined, incoming: string | null | undefined): string | null {
  if (!current) return incoming ?? null;
  if (!incoming) return current;
  return incoming > current ? incoming : current;
}

/**
 * `GREATEST` que não se deixa envenenar por NULL (no MySQL `GREATEST(NULL, x)`
 * é NULL). Mesmo resultado que `laterTimestamp`.
 */
export function sqlLaterTs(column: SQLWrapper, ts: string) {
  return sql`GREATEST(COALESCE(${column}, ${ts}), ${ts})`;
}

const STATUS_RANK: Record<MessageStatus, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * Status a gravar dado o atual e o recebido; null = não mexer. PURA.
 * Não regride (delivered não sobrepõe read); `failed` ganha sempre e é final.
 */
export function nextStatus(current: string | null | undefined, incoming: MessageStatus): MessageStatus | null {
  const cur = (current ?? "pending") as MessageStatus | "pending";
  if (cur === "failed") return null;
  if (incoming === "failed") return "failed";
  const curRank = cur === "pending" ? 0 : STATUS_RANK[cur] ?? 0;
  return STATUS_RANK[incoming] > curRank ? incoming : null;
}

function nowStr(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// ─── Opt-out ────────────────────────────────────────────────────────────────

/** Números (E.164) que pediram para não receber mensagens. */
export async function optedOutPhones(db: DbLike): Promise<Set<string>> {
  const rows = await db
    .select({ phoneE164: whatsappConversations.phoneE164 })
    .from(whatsappConversations)
    .where(isNotNull(whatsappConversations.optedOutAt));
  return new Set(rows.map((r) => r.phoneE164));
}

export const OPTED_OUT_ERROR = "Não quer mensagens (pediu STOP) — envio não feito.";

// ─── Status pendentes ───────────────────────────────────────────────────────

/** Aplica um status a uma linha existente respeitando a progressão. */
export async function applyStatusToMessage(
  db: DbLike,
  row: { id: number; status: string },
  status: MessageStatus,
  errorDetail: string | null,
): Promise<boolean> {
  const next = nextStatus(row.status, status);
  if (!next) return false;
  await db
    .update(whatsappMessages)
    .set(next === "failed" ? { status: "failed", errorDetail } : { status: next })
    .where(eq(whatsappMessages.id, row.id));
  return true;
}

/** Guarda um status de uma mensagem que ainda não existe (mantém o "maior"). */
export async function stashPendingStatus(db: DbLike, waMessageId: string, status: MessageStatus, errorDetail: string | null): Promise<void> {
  const rows = await db
    .select({ status: whatsappPendingStatuses.status })
    .from(whatsappPendingStatuses)
    .where(eq(whatsappPendingStatuses.waMessageId, waMessageId))
    .limit(1);
  if (!rows.length) {
    await db
      .insert(whatsappPendingStatuses)
      .values({ waMessageId, status, errorDetail })
      // Corrida com outro webhook do mesmo id: 'failed' nunca é sobreposto.
      .onDuplicateKeyUpdate({ set: { status: sql`IF(${whatsappPendingStatuses.status} = 'failed', 'failed', ${status})` } });
    return;
  }
  const next = nextStatus(rows[0].status, status);
  if (next) {
    await db
      .update(whatsappPendingStatuses)
      .set({ status: next, errorDetail: next === "failed" ? errorDetail : null })
      .where(eq(whatsappPendingStatuses.waMessageId, waMessageId));
  }
}

/** Depois de gravar uma linha outbound com `waMessageId`: aplica o status que chegou antes. */
export async function reconcilePendingStatus(db: DbLike, waMessageId: string | null | undefined): Promise<void> {
  if (!waMessageId) return;
  try {
    const pending = await db
      .select()
      .from(whatsappPendingStatuses)
      .where(eq(whatsappPendingStatuses.waMessageId, waMessageId))
      .limit(1);
    if (!pending.length) return;
    const rows = await db
      .select({ id: whatsappMessages.id, status: whatsappMessages.status })
      .from(whatsappMessages)
      .where(eq(whatsappMessages.waMessageId, waMessageId))
      .limit(1);
    if (!rows.length) return;
    await applyStatusToMessage(db, rows[0], pending[0].status as MessageStatus, pending[0].errorDetail ?? null);
    await db.delete(whatsappPendingStatuses).where(eq(whatsappPendingStatuses.waMessageId, waMessageId));
  } catch (err: any) {
    console.warn("[WhatsApp] reconciliar status pendente falhou:", String(err?.message ?? err).slice(0, 160));
  }
}

// ─── Saída ──────────────────────────────────────────────────────────────────

export interface OutboundRow {
  conversationId: number;
  waMessageId: string | null;
  type: "text" | "template";
  body: string | null;
  templateName?: string | null;
  status: "sent" | "failed";
  errorDetail?: string | null;
  sentById?: number | null;
  broadcastId?: number | null;
}

/**
 * Grava uma mensagem ENVIADA e atualiza a conversa (última mensagem + resumo).
 * Nunca toca em `lastInboundAt` nem em `unreadCount`. Enviada com sucesso →
 * limpa `awaitingSince` (a conversa fica respondida).
 */
export async function recordOutboundMessage(db: DbLike, row: OutboundRow): Promise<void> {
  const now = nowStr();
  await db.insert(whatsappMessages).values({
    conversationId: row.conversationId,
    direction: "out",
    waMessageId: row.waMessageId,
    type: row.type,
    body: row.body,
    templateName: row.templateName ?? null,
    status: row.status,
    errorDetail: row.errorDetail ?? null,
    sentById: row.sentById ?? null,
    broadcastId: row.broadcastId ?? null,
    waTimestamp: now,
  });
  const p = previewFields({ body: row.body, type: row.type, templateName: row.templateName, direction: "out" });
  await db
    .update(whatsappConversations)
    .set({
      lastMessageAt: sqlLaterTs(whatsappConversations.lastMessageAt, now),
      lastPreview: p.lastPreview,
      lastDirection: p.lastDirection,
      lastType: p.lastType,
      // Resposta enviada → a conversa deixa de estar "por responder" (SLA 0097).
      ...(row.status === "sent" ? { awaitingSince: null, slaAlertedAt: null } : {}),
    })
    .where(eq(whatsappConversations.id, row.conversationId));
  await reconcilePendingStatus(db, row.waMessageId);
}
