/**
 * Inbox de WhatsApp (Fase 3): listagem de conversas, thread, marcar-lido e
 * resposta 1-a-1 (só dentro da janela de 24h).
 *
 * `deriveWindowState` é pura e testável — é a fonte única do estado da janela,
 * usada quer pela UI (para não duplicar lógica) quer pela validação server-side
 * do `reply`.
 */
import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { employees, whatsappConversations, whatsappMessages } from "../drizzle/schema";
import { sendTextMessage } from "./whatsapp";

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

function nowStr(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
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
  windowState: WindowState;
  windowExpiresAt: string | null;
}

export async function listConversations(): Promise<ConversationRow[]> {
  const db = await getDb();
  if (!db) return [];

  const convs = await db
    .select({
      id: whatsappConversations.id,
      phoneE164: whatsappConversations.phoneE164,
      employeeId: whatsappConversations.employeeId,
      unreadCount: whatsappConversations.unreadCount,
      lastInboundAt: whatsappConversations.lastInboundAt,
      lastMessageAt: whatsappConversations.lastMessageAt,
      employeeName: employees.fullName,
    })
    .from(whatsappConversations)
    .leftJoin(employees, eq(whatsappConversations.employeeId, employees.id))
    .orderBy(desc(whatsappConversations.lastMessageAt))
    .limit(300);

  const ids = convs.map((c) => c.id);
  const previewByConv = new Map<number, { body: string | null; direction: "in" | "out" }>();
  if (ids.length) {
    // Mensagens das conversas por ordem decrescente de id → a 1ª por conversa é
    // a mais recente (preview).
    const msgs = await db
      .select({
        conversationId: whatsappMessages.conversationId,
        body: whatsappMessages.body,
        direction: whatsappMessages.direction,
        id: whatsappMessages.id,
      })
      .from(whatsappMessages)
      .where(inArray(whatsappMessages.conversationId, ids))
      .orderBy(desc(whatsappMessages.id));
    for (const m of msgs) {
      if (!previewByConv.has(m.conversationId)) {
        previewByConv.set(m.conversationId, { body: m.body ?? null, direction: m.direction as "in" | "out" });
      }
    }
  }

  return convs.map((c) => {
    const w = deriveWindowState(c.lastInboundAt);
    const preview = previewByConv.get(c.id);
    return {
      id: c.id,
      phoneE164: c.phoneE164,
      employeeId: c.employeeId,
      name: c.employeeName ?? c.phoneE164,
      unreadCount: c.unreadCount,
      lastInboundAt: c.lastInboundAt,
      lastMessageAt: c.lastMessageAt,
      preview: preview?.body ?? null,
      previewDirection: preview?.direction ?? null,
      windowState: w.windowState,
      windowExpiresAt: w.windowExpiresAt,
    };
  });
}

// ─── Thread de uma conversa ─────────────────────────────────────────────────

export interface ThreadMessage {
  id: number;
  direction: "in" | "out";
  type: "text" | "template";
  body: string | null;
  templateName: string | null;
  status: string;
  errorDetail: string | null;
  waTimestamp: string | null;
  createdAt: string;
}

export interface ConversationThread {
  conversationId: number;
  phoneE164: string;
  name: string;
  windowState: WindowState;
  windowExpiresAt: string | null;
  messages: ThreadMessage[];
}

export async function getConversationThread(conversationId: number, limit = 100): Promise<ConversationThread | null> {
  const db = await getDb();
  if (!db) return null;

  const convRows = await db
    .select({
      id: whatsappConversations.id,
      phoneE164: whatsappConversations.phoneE164,
      lastInboundAt: whatsappConversations.lastInboundAt,
      employeeName: employees.fullName,
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
  return {
    conversationId: conv.id,
    phoneE164: conv.phoneE164,
    name: conv.employeeName ?? conv.phoneE164,
    windowState: w.windowState,
    windowExpiresAt: w.windowExpiresAt,
    messages: (rows as ThreadMessage[]).reverse(), // cronológico (antigo → recente)
  };
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

// ─── Resposta 1-a-1 (texto livre, só janela aberta) ─────────────────────────

export interface ReplyResult {
  ok: boolean;
  waMessageId?: string;
  error?: string;
}

export async function replyToConversation(
  conversationId: number,
  text: string,
  userId: number | null,
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
    })
    .from(whatsappConversations)
    .where(eq(whatsappConversations.id, conversationId))
    .limit(1);
  if (!rows.length) return { ok: false, error: "Conversa não encontrada." };
  const conv = rows[0];

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
  const now = nowStr();

  await db.insert(whatsappMessages).values({
    conversationId,
    direction: "out",
    waMessageId: res.ok ? res.waMessageId : null,
    type: "text",
    body,
    status: res.ok ? "sent" : "failed",
    errorDetail: res.ok ? null : res.error,
    sentById: userId,
    waTimestamp: now,
  });

  await db
    .update(whatsappConversations)
    .set({ lastMessageAt: now })
    .where(eq(whatsappConversations.id, conversationId));

  return res.ok ? { ok: true, waMessageId: res.waMessageId } : { ok: false, error: res.error };
}
