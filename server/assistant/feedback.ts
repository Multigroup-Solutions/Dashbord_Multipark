/**
 * 👍/👎 do Multis e "Perguntas que falharam" (`assistant_feedback`, 0605).
 *
 *  - `giveFeedback`: só a respostas das conversas DA PRÓPRIA pessoa (o SQL
 *    junta a conversa pelo dono); mudar de ideias atualiza a mesma linha.
 *    Guarda cópia da pergunta e da resposta (as conversas apagam-se aos 30
 *    dias; esta tabela não tem purga).
 *  - `recordAutoFlag`: a marca automática (auto = 1) de uma resposta que não
 *    respondeu (shared/assistantFeedback.ts → detectUnanswered).
 *  - `listFailed`/`resolveFailed`/`unresolveFailed`: a lista dos admins.
 *
 * Nada se apaga: "Marcar como tratada" e "Desfazer" são UPDATEs.
 */
import { sql, type SQL } from "drizzle-orm";
import {
  FEEDBACK_ANSWER_MAX, FEEDBACK_COMMENT_MAX, FEEDBACK_QUESTION_MAX, feedbackSince, mergeFailedRows,
  type FeedbackReason, type FeedbackStatus,
} from "../../shared/assistantFeedback";
import { joinNames, mysqlNow, type ChatChannel } from "../_core/ai/chat/store";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const affectedOf = (res: unknown): number => Number(((Array.isArray(res) ? res[0] : res) as any)?.affectedRows ?? 0);

async function db(): Promise<any | null> {
  try {
    const { getDb } = await import("../db");
    return await getDb();
  } catch {
    return null;
  }
}

const clip = (s: string | null | undefined, n: number): string | null => {
  const t = String(s ?? "").trim();
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export type GiveFeedbackResult = { ok: true } | { ok: false; reason: "not_found" | "unavailable" };

/**
 * 👍 (1) ou 👎 (-1) de `userId` à resposta `messageId`. A resposta tem de ser
 * de uma conversa deste dono (`ownerKey`, canal da equipa); senão → not_found
 * (sem dizer se existe).
 */
export async function giveFeedback(input: {
  channel: ChatChannel;
  ownerKey: string;
  userId: number;
  messageId: number;
  rating: 1 | -1;
  reason?: FeedbackReason | null;
  comment?: string | null;
  now?: number;
}): Promise<GiveFeedbackResult> {
  const d = await db();
  if (!d) return { ok: false, reason: "unavailable" };
  const msg = rowsOf(await d.execute(sql`
    SELECT m.id, m.conversationId, m.content, m.tools, m.helpFiles, m.path
      FROM ai_chat_messages m
      JOIN ai_chat_conversations c ON c.id = m.conversationId
     WHERE m.id = ${input.messageId} AND m.role = 'assistant' AND c.channel = ${input.channel} AND c.ownerKey = ${input.ownerKey}
     LIMIT 1`))[0];
  if (!msg) return { ok: false, reason: "not_found" };
  const q = rowsOf(await d.execute(sql`
    SELECT content FROM ai_chat_messages
     WHERE conversationId = ${msg.conversationId} AND id < ${input.messageId} AND role = 'user'
     ORDER BY id DESC LIMIT 1`))[0];
  const now = mysqlNow(new Date(input.now ?? Date.now()));
  const reason = input.rating === -1 ? input.reason ?? null : null;
  const comment = input.rating === -1 ? clip(input.comment, FEEDBACK_COMMENT_MAX) : null;
  await d.execute(sql`
    INSERT INTO assistant_feedback
      (messageId, conversationId, userId, rating, reason, comment, question, answer, path, tools, helpFiles, auto, createdAt, updatedAt)
    VALUES (${input.messageId}, ${Number(msg.conversationId)}, ${input.userId}, ${input.rating}, ${reason}, ${comment},
      ${clip(q?.content, FEEDBACK_QUESTION_MAX)}, ${clip(msg.content, FEEDBACK_ANSWER_MAX)}, ${msg.path ?? null}, ${msg.tools ?? null}, ${msg.helpFiles ?? null}, 0, ${now}, ${now})
    ON DUPLICATE KEY UPDATE rating = VALUES(rating), reason = VALUES(reason), comment = VALUES(comment), updatedAt = VALUES(updatedAt)`);
  return { ok: true };
}

/** Marca automática (auto = 1) de uma resposta que não respondeu. Uma por resposta. Nunca lança. */
export async function recordAutoFlag(input: {
  messageId: number;
  conversationId: number | null;
  userId: number;
  question: string;
  answer: string;
  path?: string | null;
  tools?: string[];
  helpFiles?: string[];
  comment: string;
  now?: number;
}): Promise<boolean> {
  try {
    const d = await db();
    if (!d) return false;
    const now = mysqlNow(new Date(input.now ?? Date.now()));
    await d.execute(sql`
      INSERT INTO assistant_feedback
        (messageId, conversationId, userId, rating, reason, comment, question, answer, path, tools, helpFiles, auto, createdAt, updatedAt)
      VALUES (${input.messageId}, ${input.conversationId}, ${input.userId}, -1, 'sem_dados', ${clip(input.comment, FEEDBACK_COMMENT_MAX)},
        ${clip(input.question, FEEDBACK_QUESTION_MAX)}, ${clip(input.answer, FEEDBACK_ANSWER_MAX)}, ${input.path ? String(input.path).split("?")[0].slice(0, 200) : null},
        ${joinNames(input.tools)}, ${joinNames(input.helpFiles)}, 1, ${now}, ${now})
      ON DUPLICATE KEY UPDATE updatedAt = updatedAt`);
    return true;
  } catch {
    return false;
  }
}

/** As minhas avaliações (👍/👎, não as automáticas) das respostas pedidas. Nunca lança. */
export async function myRatings(userId: number, messageIds: number[]): Promise<Map<number, { rating: 1 | -1; reason: string | null }>> {
  const out = new Map<number, { rating: 1 | -1; reason: string | null }>();
  const ids = [...new Set(messageIds.filter((x) => Number.isInteger(x) && x > 0))].slice(0, 200);
  if (!ids.length) return out;
  try {
    const d = await db();
    if (!d) return out;
    const rows = rowsOf(await d.execute(sql`SELECT messageId, rating, reason FROM assistant_feedback
      WHERE userId = ${userId} AND auto = 0 AND messageId IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})`));
    for (const r of rows) out.set(Number(r.messageId), { rating: Number(r.rating) > 0 ? 1 : -1, reason: r.reason != null ? String(r.reason) : null });
  } catch { /* sem avaliações à vista; o chat continua */ }
  return out;
}

export interface FailedItem {
  id: number;
  messageId: number;
  createdAt: string;
  userId: number;
  userName: string | null;
  path: string | null;
  question: string | null;
  answer: string | null;
  reason: string | null;
  comment: string | null;
  tools: string[];
  helpFiles: string[];
  auto: boolean;
  alsoAuto: boolean;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolvedNote: string | null;
}

const list = (v: unknown) => (v ? String(v).split(",").map((x) => x.trim()).filter(Boolean) : []);

/**
 * "Perguntas que falharam" (só admins — verificado no router): 👎 da pessoa e
 * marcas automáticas do período, uma linha por resposta (a manual ganha à
 * automática). As automáticas de uma resposta a que a pessoa deu 👍 não
 * aparecem. Lança se a BD falhar (erro ≠ lista vazia).
 */
export async function listFailed(input: { days: number; reason?: FeedbackReason | null; status: FeedbackStatus; now?: number }): Promise<{
  items: FailedItem[]; counts: { up: number; down: number; auto: number; open: number }; truncated: boolean;
}> {
  const d = await db();
  if (!d) throw new Error("Base de dados indisponível.");
  const since = feedbackSince(input.days, input.now);
  const where: SQL[] = [
    sql`f.rating = -1`,
    sql`f.createdAt >= ${since}`,
    sql`(f.auto = 0 OR NOT EXISTS (SELECT 1 FROM assistant_feedback g WHERE g.messageId = f.messageId AND g.auto = 0 AND g.rating = 1))`,
  ];
  if (input.reason) where.push(sql`f.reason = ${input.reason}`);
  if (input.status === "open") where.push(sql`f.resolvedAt IS NULL`);
  if (input.status === "resolved") where.push(sql`f.resolvedAt IS NOT NULL`);
  const LIMIT = 300;
  const rows = rowsOf(await d.execute(sql`
    SELECT f.id, f.messageId, f.userId, u.name AS userName, f.reason, f.comment, f.question, f.answer, f.path, f.tools, f.helpFiles, f.auto,
           DATE_FORMAT(f.createdAt, '%Y-%m-%dT%H:%i:%sZ') AS createdAt,
           DATE_FORMAT(f.resolvedAt, '%Y-%m-%dT%H:%i:%sZ') AS resolvedAt, r.name AS resolvedByName, f.resolvedNote
      FROM assistant_feedback f
      LEFT JOIN users u ON u.id = f.userId
      LEFT JOIN users r ON r.id = f.resolvedById
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY f.createdAt DESC, f.id DESC
     LIMIT ${LIMIT}`));
  const items = mergeFailedRows(rows.map((r) => ({
    id: Number(r.id),
    messageId: Number(r.messageId),
    createdAt: String(r.createdAt ?? ""),
    userId: Number(r.userId),
    userName: r.userName != null ? String(r.userName) : null,
    path: r.path != null ? String(r.path) : null,
    question: r.question != null ? String(r.question) : null,
    answer: r.answer != null ? String(r.answer) : null,
    reason: r.reason != null ? String(r.reason) : null,
    comment: r.comment != null ? String(r.comment) : null,
    tools: list(r.tools),
    helpFiles: list(r.helpFiles),
    auto: Number(r.auto) === 1,
    resolvedAt: r.resolvedAt != null ? String(r.resolvedAt) : null,
    resolvedByName: r.resolvedByName != null ? String(r.resolvedByName) : null,
    resolvedNote: r.resolvedNote != null ? String(r.resolvedNote) : null,
  })));
  const c = rowsOf(await d.execute(sql`
    SELECT COALESCE(SUM(auto = 0 AND rating = 1), 0) AS up,
           COALESCE(SUM(auto = 0 AND rating = -1), 0) AS down,
           COALESCE(SUM(auto = 1), 0) AS autoCount,
           COALESCE(SUM(rating = -1 AND resolvedAt IS NULL), 0) AS openCount
      FROM assistant_feedback WHERE createdAt >= ${since}`))[0] ?? {};
  return {
    items,
    counts: { up: Number(c.up ?? 0), down: Number(c.down ?? 0), auto: Number(c.autoCount ?? 0), open: Number(c.openCount ?? 0) },
    truncated: rows.length >= LIMIT,
  };
}

async function messageIdOf(d: any, id: number): Promise<number | null> {
  const r = rowsOf(await d.execute(sql`SELECT messageId FROM assistant_feedback WHERE id = ${id} LIMIT 1`))[0];
  return r ? Number(r.messageId) : null;
}

/** "Marcar como tratada" (todas as linhas 👎 dessa resposta). UPDATE; nunca DELETE. */
export async function resolveFailed(id: number, byUserId: number, note: string | null, opts: { now?: number } = {}): Promise<boolean> {
  const d = await db();
  if (!d) return false;
  const messageId = await messageIdOf(d, id);
  if (messageId == null) return false;
  const res = await d.execute(sql`UPDATE assistant_feedback
    SET resolvedAt = ${mysqlNow(new Date(opts.now ?? Date.now()))}, resolvedById = ${byUserId}, resolvedNote = ${clip(note, FEEDBACK_COMMENT_MAX)}
    WHERE messageId = ${messageId} AND rating = -1 AND resolvedAt IS NULL`);
  const ok = affectedOf(res) > 0;
  if (ok) await log(byUserId, "assistant_feedback_resolve", id, note);
  return ok;
}

/** "Desfazer": volta a "por tratar". */
export async function unresolveFailed(id: number, byUserId: number): Promise<boolean> {
  const d = await db();
  if (!d) return false;
  const messageId = await messageIdOf(d, id);
  if (messageId == null) return false;
  const res = await d.execute(sql`UPDATE assistant_feedback SET resolvedAt = NULL, resolvedById = NULL, resolvedNote = NULL
    WHERE messageId = ${messageId} AND rating = -1 AND resolvedAt IS NOT NULL`);
  const ok = affectedOf(res) > 0;
  if (ok) await log(byUserId, "assistant_feedback_unresolve", id, null);
  return ok;
}

async function log(userId: number, action: string, id: number, note: string | null): Promise<void> {
  try {
    const { logActivity } = await import("../db");
    await logActivity({ userId, action, entity: "assistant_feedback", entityId: id, details: note ? JSON.stringify({ note }).slice(0, 1000) : null });
  } catch { /* o registo nunca parte a lista */ }
}
