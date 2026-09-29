/**
 * Triagem do inbox de WhatsApp (IA `lite`): intenção (reserva, alteração,
 * cancelamento, perdido/achado, reclamação, recrutamento/extra, outro) e
 * urgência de cada conversa → etiquetas e filtros no inbox; as urgentes
 * entram mais cedo no aviso de SLA (runWhatsappSlaAlerts).
 *
 * Debounce por conversa (shared/commsAi.ts `whatsappTriagePlan`): no máximo
 * UMA triagem a cada WHATSAPP_TRIAGE_DEBOUNCE_MINUTES; uma rajada de mensagens
 * dentro desse intervalo fica agendada (`aiTriageDueAt`) e é apanhada pela
 * mensagem seguinte depois do intervalo ou pelo cron horário (lote limitado).
 *
 * Nunca responde: a sugestão de resposta continua a pedido (aiAssist).
 */
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { whatsappConversations, whatsappMessages } from "../drizzle/schema";
import { getDb } from "./db";
import {
  WHATSAPP_TRIAGE_DEBOUNCE_MINUTES,
  mapWhatsappIntent,
  mapWhatsappUrgency,
  whatsappTriagePlan,
} from "../shared/commsAi";
import { isStopAiError } from "./complaintTriage";

const nowStr = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/**
 * Chamado a cada mensagem recebida (depois de gravada). Decide pelo debounce:
 * `true` = esta chamada ficou com a triagem (reserva atómica) e quem chama
 * deve correr `triageConversation` (em segundo plano); `false` = agendada ou
 * IA desligada. Nunca lança.
 */
export async function noteInboundForTriage(conversationId: number, nowMs: number = Date.now()): Promise<boolean> {
  try {
    const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
    if (!(await aiFeatureAvailableFresh("whatsapp_triage"))) return false;
    const db = await getDb();
    if (!db) return false;
    const [c] = await db
      .select({ aiTriagedAt: whatsappConversations.aiTriagedAt, aiTriageDueAt: whatsappConversations.aiTriageDueAt })
      .from(whatsappConversations).where(eq(whatsappConversations.id, conversationId)).limit(1);
    if (!c) return false;
    const plan = whatsappTriagePlan(c.aiTriagedAt, nowMs);
    if (plan.runNow) {
      // Reserva otimista: só ganha quem ainda vê o mesmo aiTriagedAt.
      const res = await db.update(whatsappConversations)
        .set({ aiTriagedAt: nowStr(nowMs), aiTriageDueAt: null })
        .where(and(
          eq(whatsappConversations.id, conversationId),
          c.aiTriagedAt ? eq(whatsappConversations.aiTriagedAt, c.aiTriagedAt) : sql`${whatsappConversations.aiTriagedAt} IS NULL`,
        ));
      return Number((res as any)?.[0]?.affectedRows ?? 0) > 0;
    }
    if (!c.aiTriageDueAt) {
      await db.update(whatsappConversations).set({ aiTriageDueAt: nowStr(plan.dueAtMs) }).where(eq(whatsappConversations.id, conversationId));
    }
    return false;
  } catch (err: any) {
    console.warn("[WhatsApp triagem] agendar falhou:", String(err?.message ?? err).slice(0, 160));
    return false;
  }
}

/** Últimas mensagens recebidas (texto), mais recentes no fim, cortadas. PURA. */
export function triageTranscript(msgs: { direction: "in" | "out"; body: string | null }[], maxChars: number): string {
  const lines: string[] = [];
  let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const text = String(m.body ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const line = `${m.direction === "in" ? "Cliente" : "Multipark"}: ${text}`;
    if (total + line.length > maxChars) break;
    total += line.length + 1;
    lines.unshift(line);
  }
  return lines.join("\n");
}

/**
 * Triagem de UMA conversa (já reservada por `noteInboundForTriage` ou pelo
 * varrimento). Nunca lança. Erro não "de paragem" → reagenda.
 */
export async function triageConversation(conversationId: number): Promise<{ ok: boolean; error?: string }> {
  const db = await getDb();
  if (!db) return { ok: false, error: "db" };
  const { runAi } = await import("./_core/ai/run");
  const { redactPii } = await import("./_core/ai/pii");
  const { aiErrorCode } = await import("./_core/ai/errors");
  const { WHATSAPP_TRIAGE_SYSTEM, WHATSAPP_INPUT_MAX, whatsappTriageSchema } = await import("./_core/ai/prompts/comms");
  const msgs = await db
    .select({ direction: whatsappMessages.direction, body: whatsappMessages.body })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.conversationId, conversationId))
    .orderBy(desc(whatsappMessages.id))
    .limit(8);
  const transcript = triageTranscript(msgs.reverse() as any, WHATSAPP_INPUT_MAX);
  if (!transcript || !msgs.some((m) => m.direction === "in")) return { ok: false, error: "empty" };
  const red = redactPii(transcript);
  try {
    const r = await runAi({
      feature: "whatsapp_triage",
      system: WHATSAPP_TRIAGE_SYSTEM,
      input: red.text,
      schema: whatsappTriageSchema,
      maxTokens: 120,
      timeoutMs: 15_000,
      retries: 1,
      entity: "whatsapp_conversation",
      entityId: conversationId,
    });
    await db.update(whatsappConversations).set({
      aiIntent: mapWhatsappIntent(r.output.intent),
      aiUrgency: mapWhatsappUrgency(r.output.urgency),
      aiTriagedAt: nowStr(),
    }).where(eq(whatsappConversations.id, conversationId));
    return { ok: true };
  } catch (err) {
    if (!isStopAiError(err)) {
      await db.update(whatsappConversations)
        .set({ aiTriageDueAt: nowStr(Date.now() + WHATSAPP_TRIAGE_DEBOUNCE_MINUTES * 60_000) })
        .where(eq(whatsappConversations.id, conversationId)).catch(() => {});
    }
    return { ok: false, error: aiErrorCode(err) };
  }
}

/** Corre em segundo plano as triagens reservadas no webhook (nunca lança). */
export async function runTriagesFor(conversationIds: number[]): Promise<void> {
  for (const id of [...new Set(conversationIds)].slice(0, 5)) {
    const r = await triageConversation(id);
    if (!r.ok && (r.error === "disabled" || r.error === "budget" || r.error === "not_configured")) break;
  }
}

/**
 * Varrimento (cron horário): conversas com triagem agendada e já vencida,
 * em lote limitado. Para no 1.º erro "de paragem".
 */
export async function runWhatsappTriageSweep(opts: { limit?: number; deadlineAt?: number; now?: Date } = {}): Promise<{ triaged: number; skipped?: string }> {
  const out: { triaged: number; skipped?: string } = { triaged: 0 };
  const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
  if (!(await aiFeatureAvailableFresh("whatsapp_triage"))) return { ...out, skipped: "disabled" };
  const db = await getDb();
  if (!db) return out;
  const now = opts.now ?? new Date();
  const deadlineAt = opts.deadlineAt ?? Date.now() + 30_000;
  const due = await db.select({ id: whatsappConversations.id }).from(whatsappConversations)
    .where(and(isNotNull(whatsappConversations.aiTriageDueAt), sql`${whatsappConversations.aiTriageDueAt} <= ${nowStr(now.getTime())}`))
    .orderBy(whatsappConversations.aiTriageDueAt)
    .limit(Math.max(1, Math.min(20, opts.limit ?? 10)));
  for (const { id } of due) {
    if (Date.now() + 16_000 > deadlineAt) { out.skipped = "deadline"; break; }
    const claim = await db.update(whatsappConversations).set({ aiTriageDueAt: null, aiTriagedAt: nowStr() })
      .where(and(eq(whatsappConversations.id, id), isNotNull(whatsappConversations.aiTriageDueAt)));
    if (!Number((claim as any)?.[0]?.affectedRows ?? 0)) continue;
    const r = await triageConversation(id);
    if (r.ok) out.triaged++;
    else if (r.error === "disabled" || r.error === "budget" || r.error === "not_configured") { out.skipped = r.error; break; }
  }
  return out;
}
