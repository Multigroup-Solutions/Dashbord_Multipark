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
  WHATSAPP_TRIAGE_MAX_FAILS,
  mapWhatsappIntent,
  mapWhatsappUrgency,
  type WhatsappIntent,
  whatsappTriageFailureCounts,
  whatsappTriagePlan,
} from "../shared/commsAi";
import { isStopAiError } from "./complaintTriage";
import { isStaffWhatsappConversation, whatsappTriageGate, whatsappUrgentByWords } from "../shared/commsAi";
import type { AiThinkingLevel } from "../shared/aiFeatures";

/** WA_TRIAGE_SKIP_STAFF (Definições → Automações), lido fresco. Nunca lança (falha → desligado = como até aqui). */
async function skipStaffOn(): Promise<boolean> {
  try {
    const { ensureFeatureFlagOverrides, isFeatureEnabled } = await import("./_core/featureFlags");
    const { automationFlagDefault } = await import("../shared/appSettings");
    await ensureFeatureFlagOverrides().catch(() => {});
    return isFeatureEnabled("WA_TRIAGE_SKIP_STAFF", { defaultEnabled: automationFlagDefault("WA_TRIAGE_SKIP_STAFF") });
  } catch {
    return false;
  }
}

const nowStr = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/**
 * Chamado a cada mensagem recebida (depois de gravada). Decide pelo debounce:
 * `true` = esta chamada ficou com a triagem (reserva atómica) e quem chama
 * deve correr `triageConversation` (em segundo plano); `false` = agendada ou
 * IA desligada. Nunca lança.
 */
export async function noteInboundForTriage(
  conversationId: number,
  nowMs: number = Date.now(),
  opts: { body?: string | null; availabilityAiRead?: boolean } = {},
): Promise<boolean> {
  try {
    const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
    if (!(await aiFeatureAvailableFresh("whatsapp_triage"))) return false;
    const db = await getDb();
    if (!db) return false;
    const [c] = await db
      .select({
        aiTriagedAt: whatsappConversations.aiTriagedAt, aiTriageDueAt: whatsappConversations.aiTriageDueAt, aiTriageFails: whatsappConversations.aiTriageFails,
        aiIntent: whatsappConversations.aiIntent, aiUrgency: whatsappConversations.aiUrgency, employeeId: whatsappConversations.employeeId,
        boxKey: whatsappConversations.boxKey, boxSource: whatsappConversations.boxSource,
      })
      .from(whatsappConversations).where(eq(whatsappConversations.id, conversationId)).limit(1);
    if (!c) return false;
    // Plano MPV F6b (W1, WA_TRIAGE_SKIP_STAFF): colaboradores e conversas já
    // lidas não voltam à IA — salvo palavra de urgência, sem intenção ou > 24 h.
    const urgentWords = whatsappUrgentByWords(opts.body);
    const gate = whatsappTriageGate({
      skipStaff: await skipStaffOn(), isStaff: isStaffWhatsappConversation(c), urgentWords,
      intent: c.aiIntent, lastTriagedAt: c.aiTriagedAt, nowMs, availabilityAiRead: opts.availabilityAiRead,
    });
    if (!gate.triage) {
      // A resposta de disponibilidade já foi lida pela IA dela: a urgência por palavras marca-se sem 2.ª leitura.
      if (urgentWords && c.aiUrgency !== "urgente") {
        await db.update(whatsappConversations).set({ aiUrgency: "urgente" }).where(eq(whatsappConversations.id, conversationId))
          .catch((e: any) => console.warn("[WhatsApp triagem] urgência por regra:", String(e?.message ?? e).slice(0, 120)));
      }
      return false;
    }
    // mensagem nova do cliente: as falhas anteriores deixam de contar (só escreve se havia falhas)
    if (Number(c.aiTriageFails ?? 0) > 0) {
      await db.update(whatsappConversations).set({ aiTriageFails: 0 }).where(eq(whatsappConversations.id, conversationId))
        .catch((e: any) => console.warn("[WhatsApp triagem] repor falhas:", String(e?.message ?? e).slice(0, 120)));
    }
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

/**
 * Caixa da conversa (Jorge, 8 out 2026): o encaminhador único da IA
 * (server/commsRouting.ts, interruptor AI_MAIL_ROUTING) usa ESTA triagem — não
 * há segunda chamada à IA. Conversa que já tem caixa (ou antiga) fica onde
 * está; nova → caixa do tema, ou Geral quando a IA não percebeu; recrutamento
 * em 1.º contacto → candidato. Nunca lança.
 */
async function routeAfterTriage(conversationId: number, triage: { intent: WhatsappIntent; confidence: number | null; reason: string | null }): Promise<void> {
  try {
    const { routeWhatsappConversation } = await import("./commsRouting");
    await routeWhatsappConversation(conversationId, triage);
  } catch (err: any) {
    console.warn("[WhatsApp triagem] caixa falhou:", conversationId, String(err?.message ?? err).slice(0, 160));
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
/** O que a IA leu de uma conversa (intenção, urgência, certeza). */
export interface WhatsappTriageReading {
  intent: WhatsappIntent;
  urgency: "urgente" | "normal";
  confidence: number | null;
  reason: string | null;
  model?: string;
}

/**
 * A leitura da IA de UMA conversa (o texto já cortado por `triageTranscript`):
 * o MESMO pedido para a produção e para a avaliação
 * (server/whatsappTriageEval.ts). `thinkingLevel` + `thinkingFromCaller` só na
 * avaliação (compara os níveis). Lança se a IA falhar.
 */
export async function classifyWhatsappTranscript(
  transcript: string,
  opts: { conversationId?: number | null; thinkingLevel?: AiThinkingLevel; thinkingFromCaller?: boolean } = {},
): Promise<WhatsappTriageReading> {
  const { runAi } = await import("./_core/ai/run");
  const { redactPii } = await import("./_core/ai/pii");
  const { WHATSAPP_TRIAGE_SYSTEM, whatsappTriageSchema } = await import("./_core/ai/prompts/comms");
  const red = redactPii(transcript);
  const r = await runAi({
    feature: "whatsapp_triage",
    system: WHATSAPP_TRIAGE_SYSTEM,
    input: red.text,
    schema: whatsappTriageSchema,
    // o Gemini 3 "pensa" e o raciocínio conta como saída: com 120 ficava sem
    // espaço para o JSON (resposta vazia → invalid_output em repetição)
    maxTokens: 600,
    timeoutMs: 20_000,
    retries: 1,
    entity: "whatsapp_conversation",
    entityId: opts.conversationId ?? null,
    ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    ...(opts.thinkingFromCaller ? { thinkingFromCaller: true } : {}),
  });
  const { normalizeConfidence } = await import("../shared/commsRouting");
  return {
    intent: mapWhatsappIntent(r.output.intent),
    urgency: mapWhatsappUrgency(r.output.urgency),
    confidence: normalizeConfidence(r.output.confidence),
    reason: r.output.reason ?? null,
    model: r.model,
  };
}

export async function triageConversation(conversationId: number): Promise<{ ok: boolean; error?: string }> {
  const db = await getDb();
  if (!db) return { ok: false, error: "db" };
  const { aiErrorCode } = await import("./_core/ai/errors");
  const { WHATSAPP_INPUT_MAX } = await import("./_core/ai/prompts/comms");
  const msgs = await db
    .select({ direction: whatsappMessages.direction, body: whatsappMessages.body })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.conversationId, conversationId))
    .orderBy(desc(whatsappMessages.id))
    .limit(8);
  const transcript = triageTranscript(msgs.reverse() as any, WHATSAPP_INPUT_MAX);
  if (!transcript || !msgs.some((m) => m.direction === "in")) return { ok: false, error: "empty" };
  try {
    const r = await classifyWhatsappTranscript(transcript, { conversationId });
    const intent = r.intent;
    await db.update(whatsappConversations).set({
      aiIntent: intent,
      aiUrgency: r.urgency,
      aiTriagedAt: nowStr(),
      aiTriageFails: 0,
    }).where(eq(whatsappConversations.id, conversationId));
    await routeAfterTriage(conversationId, { intent, confidence: r.confidence, reason: r.reason });
    return { ok: true };
  } catch (err) {
    if (!isStopAiError(err)) {
      // Uma só instrução. Falha que se repete igual (resposta inválida) conta e, à
      // WHATSAPP_TRIAGE_MAX_FAILS.ª, deixa de se reagendar (fica à mão); falha
      // passageira (timeout, 429, 5xx) reagenda sempre. A ordem do SET importa: o
      // IF lê o contador ANTES de subir.
      const due = nowStr(Date.now() + WHATSAPP_TRIAGE_DEBOUNCE_MINUTES * 60_000);
      const q = whatsappTriageFailureCounts(aiErrorCode(err))
        ? sql`UPDATE whatsapp_conversations SET aiTriageDueAt = IF(aiTriageFails + 1 < ${WHATSAPP_TRIAGE_MAX_FAILS}, ${due}, NULL), aiTriageFails = aiTriageFails + 1 WHERE id = ${conversationId}`
        : sql`UPDATE whatsapp_conversations SET aiTriageDueAt = ${due} WHERE id = ${conversationId}`;
      await db.execute(q).catch((e: any) => console.warn("[WhatsApp triagem] reagendar falhou:", conversationId, String(e?.message ?? e).slice(0, 120)));
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
    // uma triagem pode levar até 20 s (timeout do runAi) + gravar
    if (Date.now() + 21_000 > deadlineAt) { out.skipped = "deadline"; break; }
    const claim = await db.update(whatsappConversations).set({ aiTriageDueAt: null, aiTriagedAt: nowStr() })
      .where(and(eq(whatsappConversations.id, id), isNotNull(whatsappConversations.aiTriageDueAt)));
    if (!Number((claim as any)?.[0]?.affectedRows ?? 0)) continue;
    const r = await triageConversation(id);
    if (r.ok) out.triaged++;
    else if (r.error === "disabled" || r.error === "budget" || r.error === "not_configured") { out.skipped = r.error; break; }
  }
  return out;
}
