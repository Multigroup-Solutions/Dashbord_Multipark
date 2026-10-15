/**
 * Avaliação da triagem do WhatsApp (intenção + urgência) — plano MPV F6b, T1.
 * No mesmo padrão do "Testar a triagem" dos emails (server/mailTriageEval.ts):
 * casos FIXOS (server/fixtures/whatsappTriageCorpus.ts) pelo MESMO caminho de
 * produção — o mesmo corte da conversa (`triageTranscript`), o MESMO pedido à
 * IA (`classifyWhatsappTranscript`, com o fornecedor configurado) e o mesmo
 * mapeamento. Serve para decidir o raciocínio "minimal" da `whatsapp_triage`
 * (scripts/eval-whatsapp-triage.ts --compare). NÃO escreve nada nas conversas:
 * só o registo do custo da IA.
 */
import { WHATSAPP_TRIAGE_CORPUS, type WhatsappTriageCase } from "./fixtures/whatsappTriageCorpus";
import { mapWhatsappIntent, mapWhatsappUrgency } from "../shared/commsAi";
import type { AiThinkingLevel } from "../shared/aiFeatures";
import type { ThinkingRun } from "../shared/aiThinkingEval";

/** Metas: intenção certa em 85 % e urgência certa em 85 % (sem perder mais de 1 urgente). */
export const WHATSAPP_TRIAGE_TARGETS = { intent: 0.85, urgency: 0.85, maxMissedUrgent: 1 } as const;

export type WhatsappClassify = (transcript: string) => Promise<{ intent: unknown; urgency: unknown; model?: string }>;

export interface WhatsappEvalRow {
  id: string;
  expectedIntents: readonly string[];
  intent: string | null;
  expectedUrgency: "urgente" | "normal";
  urgency: "urgente" | "normal" | null;
  intentOk: boolean;
  urgencyOk: boolean;
  error?: string;
}

/** O texto que a IA lê desta conversa (o mesmo corte da produção). */
export async function caseTranscript(c: WhatsappTriageCase): Promise<string> {
  const { triageTranscript } = await import("./whatsappTriage");
  const { WHATSAPP_INPUT_MAX } = await import("./_core/ai/prompts/comms");
  return triageTranscript(c.messages, WHATSAPP_INPUT_MAX);
}

/** Um caso pelo caminho de produção. A IA falhou → conta como errado. Nunca lança. */
export async function evalWhatsappCase(c: WhatsappTriageCase, classify: WhatsappClassify): Promise<WhatsappEvalRow & { model?: string }> {
  const base = { id: c.id, expectedIntents: c.intents, expectedUrgency: c.urgency };
  try {
    const r = await classify(await caseTranscript(c));
    const intent = mapWhatsappIntent(r.intent);
    const urgency = mapWhatsappUrgency(r.urgency);
    return { ...base, intent, urgency, intentOk: c.intents.includes(intent), urgencyOk: urgency === c.urgency, model: r.model };
  } catch (err: any) {
    return { ...base, intent: null, urgency: null, intentOk: false, urgencyOk: false, error: String(err?.code ?? err?.message ?? "erro").slice(0, 80) };
  }
}

export interface WhatsappEvalMetrics extends ThinkingRun {
  intentAccuracy: number;
  urgencyAccuracy: number;
  missedUrgent: number;
  falseUrgent: number;
}

/** Contas e se passa as metas. PURA. */
export function whatsappEvalMetrics(rows: readonly WhatsappEvalRow[]): WhatsappEvalMetrics {
  const total = rows.length;
  const correct = rows.filter((r) => r.intentOk).length;
  const urgencyRight = rows.filter((r) => r.urgencyOk).length;
  const missedUrgent = rows.filter((r) => r.expectedUrgency === "urgente" && r.urgency !== "urgente").length;
  const falseUrgent = rows.filter((r) => r.expectedUrgency === "normal" && r.urgency === "urgente").length;
  const failed = rows.filter((r) => r.error).length;
  const intentAccuracy = total ? correct / total : 0;
  const urgencyAccuracy = total ? urgencyRight / total : 0;
  return {
    total, correct, failed, intentAccuracy, urgencyAccuracy, missedUrgent, falseUrgent,
    passes: total > 0 && intentAccuracy >= WHATSAPP_TRIAGE_TARGETS.intent && urgencyAccuracy >= WHATSAPP_TRIAGE_TARGETS.urgency && missedUrgent <= WHATSAPP_TRIAGE_TARGETS.maxMissedUrgent,
  };
}

/**
 * Corre o conjunto (ou os primeiros `limit`), `concurrency` pedidos de cada
 * vez. `thinkingLevel`: "env" = o de hoje (sem as Definições), outro = esse
 * nível; omisso = como a produção (Definições incluídas).
 */
export async function evalWhatsappTriage(
  opts: { thinkingLevel?: AiThinkingLevel | "env"; concurrency?: number; limit?: number } = {},
  deps: { classify?: WhatsappClassify; corpus?: readonly WhatsappTriageCase[] } = {},
): Promise<{ rows: WhatsappEvalRow[]; metrics: WhatsappEvalMetrics; model: string | null }> {
  const all = deps.corpus ?? WHATSAPP_TRIAGE_CORPUS;
  const corpus = opts.limit ? all.slice(0, Math.max(1, opts.limit)) : all;
  const thinking = opts.thinkingLevel
    ? { thinkingFromCaller: true, ...(opts.thinkingLevel !== "env" ? { thinkingLevel: opts.thinkingLevel } : {}) }
    : {};
  const classify: WhatsappClassify = deps.classify ?? (async (t) => (await import("./whatsappTriage")).classifyWhatsappTranscript(t, thinking));
  const out: Array<WhatsappEvalRow & { model?: string }> = new Array(corpus.length);
  const width = Math.max(1, Math.min(6, opts.concurrency ?? 4));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, corpus.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= corpus.length) return;
      out[i] = await evalWhatsappCase(corpus[i], classify);
    }
  }));
  const model = out.find((r) => r?.model)?.model ?? null;
  const rows = out.map(({ model: _m, ...r }) => r);
  return { rows, metrics: whatsappEvalMetrics(rows), model };
}
