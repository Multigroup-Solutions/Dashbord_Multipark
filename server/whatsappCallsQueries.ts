/**
 * Listas de chamadas do WhatsApp para a UI, sempre no âmbito de cidade do
 * utilizador (mesma regra das conversas — `visibilitySql` em whatsappInbox.ts):
 * toque (chamadas a tocar), linha do tempo da conversa e "Chamadas perdidas
 * por devolver".
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { RING_VISIBLE_MS, toDbUtc, type CallDirection, type CallStatus } from "../shared/whatsappCalls";
import { conversationProjectId } from "./whatsappCalls";
import { leadNameSql, visibilitySql } from "./whatsappInbox";

async function dbOrThrow() {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  return db;
}

const dbStr = (v: unknown): string | null => (v == null ? null : v instanceof Date ? toDbUtc(v) : String(v));

/** SQL do nome da conversa (ficha → lead → perfil WhatsApp → número). */
const convNameSql = sql`COALESCE(NULLIF(TRIM(employees.fullName), ''), ${leadNameSql},
  NULLIF(TRIM(whatsapp_conversations.profileName), ''), whatsapp_conversations.phoneE164)`;

/**
 * Âmbito de cidade: a MESMA regra das conversas (`visibilitySql` do inbox),
 * sobre `whatsapp_conversations` + `employees` (sem aliases).
 */
export const callScopeSql = (scope: number[] | undefined): SQL => visibilitySql(scope);

export interface IncomingCallView {
  id: number;
  conversationId: number | null;
  status: CallStatus;
  name: string;
  phoneE164: string;
  startedAt: string;
  answeredByUserId: number | null;
  answeredByName: string | null;
  bookingNumber: string | null;
  bookingClient: string | null;
}

/**
 * Chamadas recebidas a tocar (e as atendidas/recusadas há instantes, para
 * mostrar "atendida por X") visíveis ao utilizador. Leve quando não há nada:
 * primeiro um SELECT indexado sem JOIN; só com chamadas corre o resto.
 */
export async function listIncomingCalls(scope: number[] | undefined, nowMs = Date.now()): Promise<IncomingCallView[]> {
  const db = await dbOrThrow();
  const since = toDbUtc(nowMs - RING_VISIBLE_MS);
  const [probe] = (await db.execute(sql`SELECT id FROM whatsapp_calls WHERE status IN ('ringing','answering','connected','rejected') AND startedAt >= ${since} AND direction = 'in' LIMIT 1`)) as any;
  if (!(probe as any[])?.length) return [];
  const [rows] = (await db.execute(sql`
    SELECT k.id, k.conversationId, k.status, k.phoneE164, k.startedAt, k.answeredByUserId,
           ${convNameSql} AS name, u.name AS answeredByName,
           b.bookingNumber AS bookingNumber, TRIM(CONCAT(COALESCE(b.clientFirstName, ''), ' ', COALESCE(b.clientLastName, ''))) AS bookingClient
      FROM whatsapp_calls k
      JOIN whatsapp_conversations ON whatsapp_conversations.id = k.conversationId
      LEFT JOIN employees ON employees.id = whatsapp_conversations.employeeId
      LEFT JOIN users u ON u.id = k.answeredByUserId
      LEFT JOIN multipark_bookings b ON b.id = whatsapp_conversations.linkedBookingId
     WHERE k.direction = 'in' AND k.startedAt >= ${since}
       AND k.status IN ('ringing','answering','connected','rejected')
       AND ${callScopeSql(scope)}
     ORDER BY k.startedAt DESC LIMIT 10`)) as any;
  return (rows as any[]).map((r) => ({
    id: Number(r.id),
    conversationId: r.conversationId == null ? null : Number(r.conversationId),
    status: String(r.status) as CallStatus,
    name: String(r.name ?? r.phoneE164),
    phoneE164: String(r.phoneE164),
    startedAt: dbStr(r.startedAt)!,
    answeredByUserId: r.answeredByUserId == null ? null : Number(r.answeredByUserId),
    answeredByName: r.answeredByName ?? null,
    bookingNumber: r.bookingNumber ?? null,
    bookingClient: r.bookingClient && String(r.bookingClient).trim() ? String(r.bookingClient).trim() : null,
  }));
}

export interface ConversationCallView {
  id: number;
  direction: CallDirection;
  status: CallStatus;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  missed: boolean;
  answeredByName: string | null;
  startedByName: string | null;
  callbackDone: boolean;
}

/** Chamadas de uma conversa (linha do tempo). A visibilidade da conversa é verificada por quem chama. */
export async function listConversationCalls(conversationId: number, limit = 50): Promise<ConversationCallView[]> {
  const db = await dbOrThrow();
  const [rows] = (await db.execute(sql`
    SELECT k.id, k.direction, k.status, k.startedAt, k.answeredAt, k.endedAt, k.durationSec, k.missed, k.callbackDoneAt,
           ua.name AS answeredByName, us.name AS startedByName
      FROM whatsapp_calls k
      LEFT JOIN users ua ON ua.id = k.answeredByUserId
      LEFT JOIN users us ON us.id = k.startedByUserId
     WHERE k.conversationId = ${conversationId}
     ORDER BY k.startedAt DESC LIMIT ${limit}`)) as any;
  return (rows as any[]).map((r) => ({
    id: Number(r.id),
    direction: r.direction === "out" ? "out" : "in",
    status: String(r.status) as CallStatus,
    startedAt: dbStr(r.startedAt)!,
    answeredAt: dbStr(r.answeredAt),
    endedAt: dbStr(r.endedAt),
    durationSec: r.durationSec == null ? null : Number(r.durationSec),
    missed: Number(r.missed) === 1,
    answeredByName: r.answeredByName ?? null,
    startedByName: r.startedByName ?? null,
    callbackDone: r.callbackDoneAt != null,
  }));
}

export interface PendingCallbackView {
  id: number;
  conversationId: number | null;
  name: string;
  phoneE164: string;
  status: CallStatus;
  startedAt: string;
  attempts: number;
}

/** Agrupa por número (a mais recente primeiro) e conta as tentativas. PURA. */
export function groupPendingCallbacks<T extends { phoneE164: string }>(rows: readonly T[]): Array<T & { attempts: number }> {
  const byPhone = new Map<string, T & { attempts: number }>();
  for (const r of rows) {
    const cur = byPhone.get(r.phoneE164);
    if (cur) cur.attempts++;
    else byPhone.set(r.phoneE164, { ...r, attempts: 1 });
  }
  return [...byPhone.values()];
}

/** "Chamadas perdidas por devolver" (últimos 7 dias, no âmbito de cidade). */
export async function listPendingCallbacks(scope: number[] | undefined, nowMs = Date.now()): Promise<PendingCallbackView[]> {
  const db = await dbOrThrow();
  const since = toDbUtc(nowMs - 7 * 86_400_000);
  const [rows] = (await db.execute(sql`
    SELECT k.id, k.conversationId, k.status, k.phoneE164, k.startedAt, ${convNameSql} AS name
      FROM whatsapp_calls k
      JOIN whatsapp_conversations ON whatsapp_conversations.id = k.conversationId
      LEFT JOIN employees ON employees.id = whatsapp_conversations.employeeId
     WHERE k.direction = 'in' AND k.status IN ('missed','rejected') AND k.callbackDoneAt IS NULL AND k.startedAt >= ${since}
       AND ${callScopeSql(scope)}
     ORDER BY k.startedAt DESC LIMIT 300`)) as any;
  return groupPendingCallbacks(
    (rows as any[]).map((r) => ({
      id: Number(r.id), conversationId: r.conversationId == null ? null : Number(r.conversationId), name: String(r.name ?? r.phoneE164),
      phoneE164: String(r.phoneE164), status: String(r.status) as CallStatus, startedAt: dbStr(r.startedAt)!,
    })),
  );
}

/** Marca como devolvidas todas as perdidas pendentes do número desta chamada. */
export async function markCallbackDone(callId: number, userId: number): Promise<number> {
  const db = await dbOrThrow();
  const { whatsappCalls } = await import("../drizzle/schema");
  const [row] = await db.select({ phoneE164: whatsappCalls.phoneE164 }).from(whatsappCalls).where(eq(whatsappCalls.id, callId)).limit(1);
  if (!row) return 0;
  const { createDbCallRepo } = await import("./whatsappCalls");
  return createDbCallRepo().markCallbacksDone(row.phoneE164, userId, toDbUtc(Date.now()));
}

/** Contexto de uma conversa para ligar: número, cidade e janela de 24 h. */
export async function conversationCallContext(conversationId: number): Promise<{ phoneE164: string; projectId: number | null; lastInboundAt: string | null; optedOut: boolean } | null> {
  const db = await dbOrThrow();
  const { whatsappConversations } = await import("../drizzle/schema");
  const [c] = await db
    .select({ phoneE164: whatsappConversations.phoneE164, lastInboundAt: whatsappConversations.lastInboundAt, optedOutAt: whatsappConversations.optedOutAt })
    .from(whatsappConversations)
    .where(eq(whatsappConversations.id, conversationId))
    .limit(1);
  if (!c) return null;
  return { phoneE164: c.phoneE164, projectId: await conversationProjectId(conversationId), lastInboundAt: c.lastInboundAt ?? null, optedOut: !!c.optedOutAt };
}
