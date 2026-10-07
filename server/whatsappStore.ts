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
import { and, eq, isNotNull, sql, type SQLWrapper } from "drizzle-orm";
import type { getDb } from "./db";
import { whatsappConversations, whatsappMessages, whatsappPendingStatuses } from "../drizzle/schema";
import { messageDisplayBody } from "../shared/whatsappTemplate";

export type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** Transação ou ligação normal — as duas têm a mesma API de query. */
export type DbLike = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

export type MessageStatus = "sent" | "delivered" | "read" | "failed";
/**
 * Estado de uma linha de saída: + 'pending' (a enviar), 'unknown' (sem
 * confirmação da Meta, 0350) e 'accepted' (D33, 0445: a Meta aceitou o pedido,
 * mas ainda não disse que a mensagem saiu — só o webhook 'sent' faz "Enviado").
 */
export type OutboundStatus = MessageStatus | "pending" | "unknown" | "accepted";

/** A Meta aceitou o envio (o que antes se gravava logo como 'sent'). */
export const ACCEPTED_STATUS = "accepted" as const;

/** Estados de saída em que a mensagem saiu (ou foi aceite) e ainda não falhou. PURA. */
export function isOutboundOk(status: string | null | undefined): boolean {
  return status === "accepted" || status === "sent" || status === "delivered" || status === "read";
}

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
/** Antes de qualquer status da Meta: a enviar / sem resposta (0) e aceite (0.5, D33). */
const PRE_STATUS_RANK: Record<string, number> = { pending: 0, unknown: 0, accepted: 0.5 };

/**
 * Status a gravar dado o atual e o recebido; null = não mexer. PURA.
 * Não regride (delivered não sobrepõe read); `failed` ganha sempre e é final.
 * Aceite → enviado → entregue → lido (D33).
 */
export function nextStatus(current: string | null | undefined, incoming: MessageStatus): MessageStatus | null {
  const cur = current ?? "pending";
  if (cur === "failed") return null;
  if (incoming === "failed") return "failed";
  const curRank = PRE_STATUS_RANK[cur] ?? STATUS_RANK[cur as MessageStatus] ?? 0;
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

/**
 * Números marcados "sem WhatsApp" (2× 131026 seguidos, 0375): não recebem
 * templates até a pessoa escrever. Lidos 1× por envio, como o opt-out.
 */
export async function unreachablePhones(db: DbLike): Promise<Set<string>> {
  const rows = await db
    .select({ phoneE164: whatsappConversations.phoneE164 })
    .from(whatsappConversations)
    .where(isNotNull(whatsappConversations.unreachableAt));
  return new Set(rows.map((r) => r.phoneE164));
}

// ─── Status pendentes ───────────────────────────────────────────────────────

/** O que vem com um status além do texto do erro (0375). */
export interface StatusExtra {
  /** `errors[0].code` (131026, 131049, …). */
  errorCode?: number | null;
  errorTitle?: string | null;
  /** `pricing.category` (UTILITY / MARKETING …). */
  category?: string | null;
}

/** Aplica um status a uma linha existente respeitando a progressão. */
export async function applyStatusToMessage(
  db: DbLike,
  row: { id: number; status: string },
  status: MessageStatus,
  errorDetail: string | null,
  extra: StatusExtra = {},
): Promise<boolean> {
  const next = nextStatus(row.status, status);
  if (!next) return false;
  const category = extra.category ? { category: extra.category } : {};
  await db
    .update(whatsappMessages)
    .set(
      next === "failed"
        ? { status: "failed", errorDetail, errorCode: extra.errorCode ?? null, errorTitle: extra.errorTitle ?? null, ...category }
        : { status: next, ...category },
    )
    .where(eq(whatsappMessages.id, row.id));
  return true;
}

/** Guarda um status de uma mensagem que ainda não existe (mantém o "maior"). */
export async function stashPendingStatus(
  db: DbLike,
  waMessageId: string,
  status: MessageStatus,
  errorDetail: string | null,
  extra: StatusExtra = {},
): Promise<void> {
  const rows = await db
    .select({ status: whatsappPendingStatuses.status })
    .from(whatsappPendingStatuses)
    .where(eq(whatsappPendingStatuses.waMessageId, waMessageId))
    .limit(1);
  const failedExtra = { errorCode: extra.errorCode ?? null, errorTitle: extra.errorTitle ?? null };
  if (!rows.length) {
    await db
      .insert(whatsappPendingStatuses)
      .values({ waMessageId, status, errorDetail, ...failedExtra, category: extra.category ?? null })
      // Corrida com outro webhook do mesmo id: 'failed' nunca é sobreposto.
      .onDuplicateKeyUpdate({ set: { status: sql`IF(${whatsappPendingStatuses.status} = 'failed', 'failed', ${status})` } });
    return;
  }
  const next = nextStatus(rows[0].status, status);
  if (next) {
    await db
      .update(whatsappPendingStatuses)
      .set(
        next === "failed"
          ? { status: next, errorDetail, ...failedExtra, ...(extra.category ? { category: extra.category } : {}) }
          : { status: next, errorDetail: null, ...(extra.category ? { category: extra.category } : {}) },
      )
      .where(eq(whatsappPendingStatuses.waMessageId, waMessageId));
  }
}

/** Depois de uma linha de saída mudar de estado: política 131026/131049 (nunca lança). */
async function afterStatusApplied(db: DbLike, messageId: number, next: MessageStatus, errorCode: number | null, errorDetail: string | null): Promise<void> {
  try {
    const { onOutboundStatusChanged } = await import("./whatsappFailurePolicy");
    await onOutboundStatusChanged(db as Db, { messageId, next, errorCode, errorDetail });
  } catch (err: any) {
    console.warn("[WhatsApp] política de falha não correu:", String(err?.message ?? err).slice(0, 160));
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
    const p = pending[0];
    const status = p.status as MessageStatus;
    const changed = await applyStatusToMessage(db, rows[0], status, p.errorDetail ?? null, {
      errorCode: p.errorCode ?? null,
      errorTitle: p.errorTitle ?? null,
      category: p.category ?? null,
    });
    await db.delete(whatsappPendingStatuses).where(eq(whatsappPendingStatuses.waMessageId, waMessageId));
    // O 'failed' que chegou antes da linha também passa pela política (0375).
    if (changed) await afterStatusApplied(db, rows[0].id, status, p.errorCode ?? null, p.errorDetail ?? null);
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
  /** 'accepted' = a Meta aceitou (D33); o webhook passa-a a enviado/entregue/lido. */
  status: "accepted" | "failed";
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
      ...(row.status === "accepted" ? { awaitingSince: null, slaAlertedAt: null } : {}),
    })
    .where(eq(whatsappConversations.id, row.conversationId));
  await reconcilePendingStatus(db, row.waMessageId);
}

// ─── Saída sem duplicar (17a) ───────────────────────────────────────────────
//
// A Meta não tem chave de idempotência. Por isso a linha é gravada ANTES de
// chamar a Meta ('pending'), com o código único do envio quando vem de uma
// pessoa (`clientRequestId`). Repetir o mesmo pedido (duplo clique, rede que
// cai e o ecrã volta a tentar) encontra a linha e NÃO volta a enviar. Sem
// resposta da Meta → 'unknown' (pode ter saído), nunca 'failed'.

/** O pedido repetido com o mesmo código: o que dizer sem voltar a enviar. PURA. */
export function duplicateRequestOutcome(existing: { status: string; waMessageId: string | null; errorDetail?: string | null }):
  | { kind: "sent"; waMessageId: string | null }
  | { kind: "in_doubt"; error: string }
  | { kind: "retry" } {
  if (existing.status === "failed") return { kind: "retry" };
  if (existing.status === "pending" || existing.status === "unknown") {
    return {
      kind: "in_doubt",
      error: existing.status === "pending"
        ? "Este envio já está a ser feito — espera um pouco antes de tentar outra vez."
        : "Este envio já foi feito e a Meta não confirmou se chegou. Vê na conversa antes de reenviar.",
    };
  }
  return { kind: "sent", waMessageId: existing.waMessageId };
}

function isDuplicateKey(err: unknown): boolean {
  const e = err as any;
  const code = e?.code ?? e?.cause?.code;
  const errno = e?.errno ?? e?.cause?.errno;
  return code === "ER_DUP_ENTRY" || errno === 1062;
}

export interface ReserveRow {
  conversationId: number;
  type: "text" | "template";
  body: string | null;
  templateName?: string | null;
  sentById?: number | null;
  broadcastId?: number | null;
  clientRequestId?: string | null;
  /** 0375: língua e categoria do template enviado. */
  language?: string | null;
  category?: string | null;
  /** 0550: cidade do registo de templates dos motoristas (LISBOA/PORTO). */
  city?: string | null;
  /** 0375: JSON para a nova tentativa de uma mensagem de equipa (ver whatsappFailurePolicy). */
  sendPayload?: string | null;
}

export type ReserveResult =
  | { reserved: true; id: number }
  | { reserved: false; existing: { id: number; conversationId: number; status: string; waMessageId: string | null; errorDetail: string | null } };

/**
 * Grava a mensagem como 'pending' antes de a mandar. Com o mesmo
 * `clientRequestId` já gravado: só volta a reservar se o envio anterior FALHOU
 * de certeza ('failed'); senão devolve a linha existente (não envia).
 */
export async function reserveOutboundMessage(db: DbLike, row: ReserveRow): Promise<ReserveResult> {
  const now = nowStr();
  try {
    const res = await db.insert(whatsappMessages).values({
      conversationId: row.conversationId,
      direction: "out",
      waMessageId: null,
      type: row.type,
      body: row.body,
      templateName: row.templateName ?? null,
      status: "pending",
      sentById: row.sentById ?? null,
      broadcastId: row.broadcastId ?? null,
      clientRequestId: row.clientRequestId ?? null,
      language: row.language ?? null,
      category: row.category ?? null,
      city: row.city ?? null,
      sendPayload: row.sendPayload ?? null,
      waTimestamp: now,
    });
    return { reserved: true, id: Number((res as any)?.[0]?.insertId ?? 0) };
  } catch (err) {
    if (!row.clientRequestId || !isDuplicateKey(err)) throw err;
    const [existing] = await db
      .select({ id: whatsappMessages.id, conversationId: whatsappMessages.conversationId, status: whatsappMessages.status, waMessageId: whatsappMessages.waMessageId, errorDetail: whatsappMessages.errorDetail })
      .from(whatsappMessages)
      .where(eq(whatsappMessages.clientRequestId, row.clientRequestId))
      .limit(1);
    if (!existing) throw err;
    if (existing.conversationId === row.conversationId && existing.status === "failed") {
      // Falhou de certeza → este pedido fica com a linha (só um ganha a corrida).
      const upd = await db
        .update(whatsappMessages)
        .set({ status: "pending", errorDetail: null, type: row.type, body: row.body, templateName: row.templateName ?? null, city: row.city ?? null, broadcastId: row.broadcastId ?? null, sentById: row.sentById ?? null, waTimestamp: now })
        .where(and(eq(whatsappMessages.id, existing.id), eq(whatsappMessages.status, "failed")));
      if (Number((upd as any)?.[0]?.affectedRows ?? 0) === 1) return { reserved: true, id: existing.id };
      return { reserved: false, existing: { ...existing, status: "pending" } };
    }
    return { reserved: false, existing };
  }
}

/** Fecha a linha reservada com o resultado da Meta e atualiza a conversa. */
export async function finishOutboundMessage(
  db: DbLike,
  id: number,
  row: { conversationId: number; type: "text" | "template"; body: string | null; templateName?: string | null },
  res: { ok: true; waMessageId: string } | { ok: false; error: string; uncertain?: boolean; code?: number },
): Promise<OutboundStatus> {
  // D33: a Meta aceitar o pedido não é "Enviado" — fica 'accepted' até o webhook dizer 'sent'.
  const status: OutboundStatus = res.ok ? ACCEPTED_STATUS : res.uncertain ? "unknown" : "failed";
  const errorCode = !res.ok && typeof res.code === "number" ? res.code : null;
  await db
    .update(whatsappMessages)
    .set(res.ok ? { status: ACCEPTED_STATUS, waMessageId: res.waMessageId, errorDetail: null } : { status: status as "unknown" | "failed", errorDetail: res.error, errorCode })
    .where(eq(whatsappMessages.id, id));
  const now = nowStr();
  const p = previewFields({ body: row.body, type: row.type, templateName: row.templateName, direction: "out" });
  await db
    .update(whatsappConversations)
    .set({
      lastMessageAt: sqlLaterTs(whatsappConversations.lastMessageAt, now),
      lastPreview: p.lastPreview,
      lastDirection: p.lastDirection,
      lastType: p.lastType,
      ...(res.ok ? { awaitingSince: null, slaAlertedAt: null } : {}),
    })
    .where(eq(whatsappConversations.id, row.conversationId));
  if (res.ok) await reconcilePendingStatus(db, res.waMessageId);
  // Raro, mas a Meta pode recusar logo com 131026/131049: mesma política do webhook.
  else if (status === "failed" && errorCode != null) await afterStatusApplied(db, id, "failed", errorCode, res.error);
  return status;
}
