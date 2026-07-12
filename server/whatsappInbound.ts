/**
 * Processamento do webhook entrante da WhatsApp Cloud API (Fase 3).
 *
 * Decisão do Jorge (ajuste #2): PROCESS-THEN-ACK — o parse e a escrita na BD
 * correm ANTES de responder 200 à Meta. Se algo falhar, o chamador (a rota em
 * whatsappWebhook.ts) responde 5xx e a Meta faz retry — nunca perdemos
 * mensagens em silêncio. A dedup por `waMessageId` (unique) torna os retries
 * idempotentes.
 *
 * As funções de parse (`parseWebhookPayload` e auxiliares) são puras e
 * testáveis sem Express nem BD.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { employees, whatsappConversations, whatsappMessages } from "../drizzle/schema";
import { normalizePhoneE164 } from "../shared/phone";

export type MessageStatus = "sent" | "delivered" | "read" | "failed";

export interface ParsedInboundMessage {
  waMessageId: string;
  from: string; // dígitos da Meta (sem "+")
  timestamp: string | null; // 'YYYY-MM-DD HH:MM:SS' (UTC)
  type: string; // text | image | audio | ...
  body: string; // texto, ou representação mínima ("[imagem]", caption, ...)
}

export interface ParsedStatusUpdate {
  waMessageId: string;
  status: MessageStatus;
  timestamp: string | null;
  errorDetail: string | null;
}

export interface ParsedWebhook {
  messages: ParsedInboundMessage[];
  statuses: ParsedStatusUpdate[];
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
 * Representação mínima do corpo de uma mensagem entrante. Para não-texto NÃO
 * descarregamos media nesta fase — guardamos o caption (se existir) ou um
 * marcador tipo "[imagem]". Decisão registada na memória (Fase 3).
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
    case "location":
      return "[localização]";
    case "contacts":
      return "[contacto]";
    case "button":
      return String(m?.button?.text ?? "[botão]");
    case "interactive": {
      const i = m?.interactive;
      return String(
        i?.button_reply?.title ?? i?.list_reply?.title ?? "[resposta interativa]",
      );
    }
    default:
      return `[${type}]`;
  }
}

/** Percorre entry[].changes[].value.{messages,statuses} de forma defensiva. */
export function parseWebhookPayload(payload: any): ParsedWebhook {
  const messages: ParsedInboundMessage[] = [];
  const statuses: ParsedStatusUpdate[] = [];

  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      if (!value) continue;

      const msgs = Array.isArray(value.messages) ? value.messages : [];
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
        });
      }

      const sts = Array.isArray(value.statuses) ? value.statuses : [];
      for (const s of sts) {
        const waMessageId = s?.id;
        const status = s?.status;
        if (!waMessageId || !isMessageStatus(status)) continue;
        let errorDetail: string | null = null;
        const errs = Array.isArray(s?.errors) ? s.errors : [];
        if (errs.length) {
          const e = errs[0];
          const code = e?.code;
          const title = e?.title || e?.message || e?.error_data?.details || "erro";
          errorDetail = code != null ? `${title} (código ${code})` : String(title);
        }
        statuses.push({
          waMessageId: String(waMessageId),
          status,
          timestamp: parseMetaTimestamp(s?.timestamp),
          errorDetail,
        });
      }
    }
  }

  return { messages, statuses };
}

function isMessageStatus(v: unknown): v is MessageStatus {
  return v === "sent" || v === "delivered" || v === "read" || v === "failed";
}

/** Ordem de progressão para não regredir o status de uma mensagem outbound. */
const STATUS_RANK: Record<MessageStatus, number> = { sent: 1, delivered: 2, read: 3, failed: 0 };

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

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Mapa E.164 → employeeId, para associar a conversa a um extra. */
async function buildEmployeePhoneMap(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: employees.id, phone: employees.phone })
    .from(employees)
    .where(isNotNull(employees.phone));
  const map = new Map<string, number>();
  for (const r of rows) {
    const e164 = r.phone ? normalizePhoneE164(r.phone) : null;
    if (e164 && !map.has(e164)) map.set(e164, r.id);
  }
  return map;
}

async function handleInbound(db: Db, m: ParsedInboundMessage, empMap: Map<string, number>): Promise<boolean> {
  // Dedup: retry da Meta com id já visto → no-op.
  const existing = await db
    .select({ id: whatsappMessages.id })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.waMessageId, m.waMessageId))
    .limit(1);
  if (existing.length) return false;

  const phoneE164 = metaFromToE164(m.from) || `+${m.from}`;
  const employeeId = empMap.get(phoneE164) ?? null;
  const ts = m.timestamp ?? nowStr();

  // Upsert da conversa: abre a janela 24h (lastInboundAt), incrementa unread.
  await db
    .insert(whatsappConversations)
    .values({ phoneE164, employeeId, lastInboundAt: ts, lastMessageAt: ts, unreadCount: 1 })
    .onDuplicateKeyUpdate({
      set: {
        lastInboundAt: ts,
        lastMessageAt: ts,
        unreadCount: sql`${whatsappConversations.unreadCount} + 1`,
        employeeId: sql`COALESCE(${whatsappConversations.employeeId}, ${employeeId})`,
      },
    });

  const conv = await db
    .select({ id: whatsappConversations.id })
    .from(whatsappConversations)
    .where(eq(whatsappConversations.phoneE164, phoneE164))
    .limit(1);
  const conversationId = conv[0].id;

  await db.insert(whatsappMessages).values({
    conversationId,
    direction: "in",
    waMessageId: m.waMessageId,
    // O enum só tem text|template; media entrante fica como 'text' com body "[imagem]".
    type: "text",
    body: m.body,
    // Mensagens entrantes não têm ciclo de status de entrega nosso; 'delivered'
    // = "recebida por nós" (a UI só mostra status nas mensagens OUT).
    status: "delivered",
    waTimestamp: ts,
  });
  return true;
}

async function handleStatus(db: Db, s: ParsedStatusUpdate): Promise<boolean> {
  const rows = await db
    .select({ id: whatsappMessages.id, status: whatsappMessages.status })
    .from(whatsappMessages)
    .where(and(eq(whatsappMessages.waMessageId, s.waMessageId), eq(whatsappMessages.direction, "out")))
    .limit(1);
  if (!rows.length) return false; // status para mensagem desconhecida → no-op

  const current = rows[0].status as MessageStatus;
  if (s.status === "failed") {
    await db
      .update(whatsappMessages)
      .set({ status: "failed", errorDetail: s.errorDetail })
      .where(eq(whatsappMessages.id, rows[0].id));
    return true;
  }
  // Não regride (delivered não sobrepõe read).
  if ((STATUS_RANK[s.status] ?? 0) > (STATUS_RANK[current] ?? 0)) {
    await db.update(whatsappMessages).set({ status: s.status }).where(eq(whatsappMessages.id, rows[0].id));
    return true;
  }
  return false;
}

/**
 * Processa um payload de webhook: escreve mensagens entrantes e atualiza
 * statuses. Lança se a BD estiver indisponível ou se uma escrita falhar (o
 * chamador responde 5xx → Meta faz retry).
 */
export async function processInboundWebhook(payload: any): Promise<{ processed: number; deduped: number; statuses: number }> {
  const parsed = parseWebhookPayload(payload);
  if (!parsed.messages.length && !parsed.statuses.length) {
    return { processed: 0, deduped: 0, statuses: 0 };
  }

  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível ao processar webhook WhatsApp.");

  const empMap = parsed.messages.length ? await buildEmployeePhoneMap(db) : new Map<string, number>();

  let processed = 0;
  let deduped = 0;
  for (const m of parsed.messages) {
    const written = await handleInbound(db, m, empMap);
    if (written) processed++;
    else deduped++;
  }

  let statuses = 0;
  for (const s of parsed.statuses) {
    if (await handleStatus(db, s)) statuses++;
  }

  return { processed, deduped, statuses };
}
