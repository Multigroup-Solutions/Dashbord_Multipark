/**
 * Avaliação da triagem das reclamações (tipo + prioridade) — plano MPV F6b,
 * T1. No mesmo padrão do "Testar a triagem" dos emails
 * (server/mailTriageEval.ts): casos FIXOS
 * (server/fixtures/complaintTriageCorpus.ts) pelo MESMO pedido de produção
 * (`classifyComplaintText`, com o fornecedor configurado) e o mesmo
 * mapeamento. Serve para decidir o raciocínio "minimal" da
 * `complaint_triage` (scripts/eval-complaint-triage.ts --compare). NÃO
 * escreve nada nas reclamações: só o registo do custo da IA.
 */
import { COMPLAINT_TRIAGE_CORPUS, type ComplaintTriageCase } from "./fixtures/complaintTriageCorpus";
import { mapComplaintPriority, mapComplaintType } from "../shared/commsAi";
import type { AiThinkingLevel } from "../shared/aiFeatures";
import type { ThinkingRun } from "../shared/aiThinkingEval";

/** Metas: tipo certo em 80 %, prioridade certa em 80 % e nenhuma urgente abaixo de "alta". */
export const COMPLAINT_TRIAGE_TARGETS = { type: 0.8, priority: 0.8, maxMissedUrgent: 0 } as const;

export type ComplaintClassify = (c: ComplaintTriageCase) => Promise<{ type: unknown; priority: unknown; model?: string }>;

export interface ComplaintEvalRow {
  id: string;
  expectedTypes: readonly string[];
  type: string | null;
  expectedPriorities: readonly string[];
  priority: string | null;
  urgent: boolean;
  typeOk: boolean;
  priorityOk: boolean;
  error?: string;
}

/** Um caso pelo caminho de produção. A IA falhou → conta como errado. Nunca lança. */
export async function evalComplaintCase(c: ComplaintTriageCase, classify: ComplaintClassify): Promise<ComplaintEvalRow & { model?: string }> {
  const base = { id: c.id, expectedTypes: c.types, expectedPriorities: c.priorities, urgent: !!c.urgent };
  try {
    const r = await classify(c);
    const type = mapComplaintType(r.type);
    const priority = mapComplaintPriority(r.priority);
    return { ...base, type, priority, typeOk: c.types.includes(type), priorityOk: c.priorities.includes(priority), model: r.model };
  } catch (err: any) {
    return { ...base, type: null, priority: null, typeOk: false, priorityOk: false, error: String(err?.code ?? err?.message ?? "erro").slice(0, 80) };
  }
}

export interface ComplaintEvalMetrics extends ThinkingRun {
  typeAccuracy: number;
  priorityAccuracy: number;
  /** Urgentes que saíram "medium"/"low" (ou a IA falhou). */
  missedUrgent: number;
}

/** Contas e se passa as metas. PURA. */
export function complaintEvalMetrics(rows: readonly ComplaintEvalRow[]): ComplaintEvalMetrics {
  const total = rows.length;
  const correct = rows.filter((r) => r.typeOk && r.priorityOk).length;
  const typeAccuracy = total ? rows.filter((r) => r.typeOk).length / total : 0;
  const priorityAccuracy = total ? rows.filter((r) => r.priorityOk).length / total : 0;
  const missedUrgent = rows.filter((r) => r.urgent && r.priority !== "urgent" && r.priority !== "high").length;
  const failed = rows.filter((r) => r.error).length;
  return {
    total, correct, failed, typeAccuracy, priorityAccuracy, missedUrgent,
    passes: total > 0 && typeAccuracy >= COMPLAINT_TRIAGE_TARGETS.type && priorityAccuracy >= COMPLAINT_TRIAGE_TARGETS.priority && missedUrgent <= COMPLAINT_TRIAGE_TARGETS.maxMissedUrgent,
  };
}

/**
 * Corre o conjunto (ou os primeiros `limit`). `thinkingLevel`: "env" = o de
 * hoje (sem as Definições), outro = esse nível; omisso = como a produção.
 */
export async function evalComplaintTriage(
  opts: { thinkingLevel?: AiThinkingLevel | "env"; concurrency?: number; limit?: number } = {},
  deps: { classify?: ComplaintClassify; corpus?: readonly ComplaintTriageCase[] } = {},
): Promise<{ rows: ComplaintEvalRow[]; metrics: ComplaintEvalMetrics; model: string | null }> {
  const all = deps.corpus ?? COMPLAINT_TRIAGE_CORPUS;
  const corpus = opts.limit ? all.slice(0, Math.max(1, opts.limit)) : all;
  const thinking = opts.thinkingLevel
    ? { thinkingFromCaller: true, ...(opts.thinkingLevel !== "env" ? { thinkingLevel: opts.thinkingLevel } : {}) }
    : {};
  const classify: ComplaintClassify = deps.classify ?? (async (c) => {
    const { classifyComplaintText } = await import("./complaintTriage");
    const r = await classifyComplaintText({ clientName: c.clientName, subject: c.subject, body: c.body, knownBooking: false }, thinking);
    return { type: r.output.type, priority: r.output.priority, model: r.model };
  });
  const out: Array<ComplaintEvalRow & { model?: string }> = new Array(corpus.length);
  const width = Math.max(1, Math.min(6, opts.concurrency ?? 4));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, corpus.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= corpus.length) return;
      out[i] = await evalComplaintCase(corpus[i], classify);
    }
  }));
  const model = out.find((r) => r?.model)?.model ?? null;
  const rows = out.map(({ model: _m, ...r }) => r);
  return { rows, metrics: complaintEvalMetrics(rows), model };
}
