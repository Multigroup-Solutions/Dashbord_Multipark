/**
 * Conversas do chat na BD (migração 0130): ai_chat_conversations +
 * ai_chat_messages. Uma conversa pertence a um canal ("staff" | "public") e
 * a um dono (`ownerKey` = "user:<id>" ou, no chat público, "ip:<hash>").
 * Guarda-se o texto da pergunta/resposta e os NOMES das ferramentas usadas —
 * nunca os resultados das ferramentas.
 *
 * Retenção: CHAT_RETENTION_DAYS (30). As leituras ignoram o que é mais
 * antigo; `purgeOldChats` (daily-ops) apaga em lotes.
 */
import { sql } from "drizzle-orm";

export const CHAT_RETENTION_DAYS = 30;

export type ChatChannel = "staff" | "public";

export interface StoredMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  tools: string[];
  createdAt: string;
}

export interface ConversationSummary {
  id: number;
  title: string | null;
  updatedAt: string;
}

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const insertIdOf = (res: unknown): number => {
  const header = Array.isArray(res) ? res[0] : res;
  return Number((header as any)?.insertId ?? 0);
};

export const mysqlNow = (d: Date = new Date()) => d.toISOString().slice(0, 23).replace("T", " ");
const cutoff = (now: number, days = CHAT_RETENTION_DAYS) => mysqlNow(new Date(now - days * 86_400_000));

async function db(): Promise<any | null> {
  try {
    const { getDb } = await import("../../../db");
    return await getDb();
  } catch {
    return null;
  }
}

/** Conversa do dono (a pedida, se for dele e recente; senão a mais recente; senão uma nova). */
export async function resolveConversation(
  channel: ChatChannel,
  ownerKey: string,
  opts: { userId?: number | null; conversationId?: number | null; forceNew?: boolean; now?: number } = {},
): Promise<number | null> {
  const d = await db();
  if (!d) return null;
  const now = opts.now ?? Date.now();
  if (!opts.forceNew) {
    const byId = opts.conversationId
      ? sql` AND id = ${opts.conversationId}`
      : sql``;
    const row = rowsOf(await d.execute(sql`
      SELECT id FROM ai_chat_conversations
       WHERE channel = ${channel} AND ownerKey = ${ownerKey} AND updatedAt >= ${cutoff(now)}${byId}
       ORDER BY updatedAt DESC, id DESC LIMIT 1`))[0];
    if (row?.id) return Number(row.id);
    if (opts.conversationId) return null; // pedida mas não é dele (ou expirou)
  }
  const res = await d.execute(sql`
    INSERT INTO ai_chat_conversations (channel, ownerKey, userId, title, createdAt, updatedAt)
    VALUES (${channel}, ${ownerKey}, ${opts.userId ?? null}, NULL, ${mysqlNow(new Date(now))}, ${mysqlNow(new Date(now))})`);
  const id = insertIdOf(res);
  return id > 0 ? id : null;
}

/** Últimas `limit` mensagens de uma conversa do dono (mais antiga primeiro). */
export async function loadMessages(channel: ChatChannel, ownerKey: string, conversationId: number, limit = 40, now = Date.now()): Promise<StoredMessage[]> {
  const d = await db();
  if (!d) return [];
  const rows = rowsOf(await d.execute(sql`
    SELECT m.id, m.role, m.content, m.tools, DATE_FORMAT(m.createdAt, '%Y-%m-%dT%H:%i:%sZ') AS createdAt
      FROM ai_chat_messages m
      JOIN ai_chat_conversations c ON c.id = m.conversationId
     WHERE m.conversationId = ${conversationId} AND c.channel = ${channel} AND c.ownerKey = ${ownerKey}
       AND m.createdAt >= ${cutoff(now)}
     ORDER BY m.id DESC LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}`));
  return rows.reverse().map((r) => ({
    id: Number(r.id),
    role: r.role === "assistant" ? "assistant" : "user",
    content: String(r.content ?? ""),
    tools: r.tools ? String(r.tools).split(",").filter(Boolean) : [],
    createdAt: String(r.createdAt ?? ""),
  }));
}

/** Guarda a pergunta e a resposta (e atualiza o título/data da conversa). */
export async function appendExchange(
  conversationId: number,
  question: string,
  answer: string,
  opts: { tools?: string[]; now?: number } = {},
): Promise<void> {
  const d = await db();
  if (!d) return;
  const now = opts.now ?? Date.now();
  const t1 = mysqlNow(new Date(now));
  const t2 = mysqlNow(new Date(now + 1));
  const tools = [...new Set(opts.tools ?? [])].join(",").slice(0, 255) || null;
  await d.execute(sql`
    INSERT INTO ai_chat_messages (conversationId, role, content, tools, createdAt)
    VALUES (${conversationId}, 'user', ${question}, NULL, ${t1}), (${conversationId}, 'assistant', ${answer}, ${tools}, ${t2})`);
  const title = question.replace(/\s+/g, " ").trim().slice(0, 120);
  await d.execute(sql`
    UPDATE ai_chat_conversations SET updatedAt = ${t2}, title = COALESCE(title, ${title})
     WHERE id = ${conversationId}`);
}

/** Conversas recentes do dono (para o histórico). */
export async function listConversations(channel: ChatChannel, ownerKey: string, limit = 20, now = Date.now()): Promise<ConversationSummary[]> {
  const d = await db();
  if (!d) return [];
  const rows = rowsOf(await d.execute(sql`
    SELECT id, title, DATE_FORMAT(updatedAt, '%Y-%m-%dT%H:%i:%sZ') AS updatedAt
      FROM ai_chat_conversations
     WHERE channel = ${channel} AND ownerKey = ${ownerKey} AND updatedAt >= ${cutoff(now)} AND title IS NOT NULL
     ORDER BY updatedAt DESC, id DESC LIMIT ${Math.max(1, Math.min(50, Math.floor(limit)))}`));
  return rows.map((r) => ({ id: Number(r.id), title: r.title == null ? null : String(r.title), updatedAt: String(r.updatedAt ?? "") }));
}

/** Apaga uma conversa do dono. */
export async function deleteConversation(channel: ChatChannel, ownerKey: string, conversationId: number): Promise<boolean> {
  const d = await db();
  if (!d) return false;
  const row = rowsOf(await d.execute(sql`
    SELECT id FROM ai_chat_conversations WHERE id = ${conversationId} AND channel = ${channel} AND ownerKey = ${ownerKey} LIMIT 1`))[0];
  if (!row) return false;
  await d.execute(sql`DELETE FROM ai_chat_messages WHERE conversationId = ${conversationId}`);
  await d.execute(sql`DELETE FROM ai_chat_conversations WHERE id = ${conversationId}`);
  return true;
}

/** Retenção: apaga mensagens e conversas com mais de `days` dias, em lotes. */
export async function purgeOldChats(opts: { days?: number; deadlineAt?: number; now?: number } = {}): Promise<{ deleted: number; done: boolean }> {
  const d = await db();
  if (!d) return { deleted: 0, done: true };
  const now = opts.now ?? Date.now();
  const limit = cutoff(now, opts.days ?? CHAT_RETENTION_DAYS);
  const deadline = opts.deadlineAt ?? now + 10_000;
  let deleted = 0;
  for (;;) {
    const r = await d.execute(sql`DELETE FROM ai_chat_messages WHERE createdAt < ${limit} LIMIT 5000`);
    const n = Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
    deleted += n;
    if (n < 5000) break;
    if (Date.now() > deadline) return { deleted, done: false };
  }
  const r = await d.execute(sql`DELETE FROM ai_chat_conversations WHERE updatedAt < ${limit} LIMIT 5000`);
  deleted += Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
  return { deleted, done: true };
}
