/**
 * "Correção de caixa" — ciclo de vida dos casos (PURO).
 *
 * Um caso = uma reserva (ou agente, ou parque) × uma regra. Estados:
 *   aberto → em_analise → justificado | perda_aceite (fechados por uma pessoa,
 *   com explicação obrigatória — fase 3) · corrigido_na_multipark (a regra
 *   deixou de disparar depois de alguém ter dito que corrigiu) ·
 *   resolvido_sozinho (a regra deixou de disparar numa varredura).
 * A varredura nunca apaga: abre, atualiza, reabre (se o detalhe mudou num caso
 * fechado, ou se volta a disparar num resolvido) e resolve sozinho.
 */
import type { Finding, SweepSeverity } from "./sweepRules";

export const CASE_STATES = ["aberto", "em_analise", "justificado", "perda_aceite", "corrigido_na_multipark", "resolvido_sozinho"] as const;
export type CaseState = (typeof CASE_STATES)[number];
export const OPEN_STATES: readonly CaseState[] = ["aberto", "em_analise"];
export const CLOSED_BY_PERSON: readonly CaseState[] = ["justificado", "perda_aceite"];

export interface ExistingCase { id: number; code: string; state: CaseState; detail: string | null; severity: string }

export type CaseAction =
  | { kind: "open"; finding: Finding }
  | { kind: "update"; caseId: number; finding: Finding; detailChanged: boolean }
  | { kind: "reopen"; caseId: number; finding: Finding; from: CaseState }
  | { kind: "resolve"; caseId: number; state: "resolvido_sozinho" | "corrigido_na_multipark" };

/** Severidades que abrem casos (as informativas ficam só nos retratos). */
export const CASE_SEVERITIES: readonly SweepSeverity[] = ["critical", "high", "medium"];

/**
 * O que fazer aos casos de UM sujeito, dado o que as regras dizem agora.
 * `evaluated` = códigos que esta varredura consegue avaliar para o sujeito
 * (um caso de um código não avaliado nunca se resolve sozinho). PURA.
 */
export function planCaseActions(existing: readonly ExistingCase[], findings: readonly Finding[], evaluated: ReadonlySet<string> | "all"): CaseAction[] {
  const out: CaseAction[] = [];
  const byCode = new Map(existing.map((c) => [c.code, c]));
  const firing = new Set<string>();
  for (const f of findings) {
    if (!CASE_SEVERITIES.includes(f.severity)) continue;
    firing.add(f.code);
    const c = byCode.get(f.code);
    if (!c) { out.push({ kind: "open", finding: f }); continue; }
    const detailChanged = (c.detail ?? "") !== f.detail;
    if (OPEN_STATES.includes(c.state)) out.push({ kind: "update", caseId: c.id, finding: f, detailChanged });
    else if (c.state === "resolvido_sozinho" || c.state === "corrigido_na_multipark") out.push({ kind: "reopen", caseId: c.id, finding: f, from: c.state });
    else if (detailChanged) out.push({ kind: "reopen", caseId: c.id, finding: f, from: c.state });
  }
  for (const c of existing) {
    if (firing.has(c.code)) continue;
    if (evaluated !== "all" && !evaluated.has(c.code)) continue;
    if (OPEN_STATES.includes(c.state)) out.push({ kind: "resolve", caseId: c.id, state: c.state === "em_analise" ? "corrigido_na_multipark" : "resolvido_sozinho" });
  }
  return out;
}

/** Texto do evento de cada ação (histórico do caso). PURA. */
export function actionNote(a: CaseAction): { action: string; note: string } {
  switch (a.kind) {
    case "open": return { action: "aberto", note: a.finding.detail };
    case "update": return { action: "atualizado", note: a.finding.detail };
    case "reopen": return { action: "reaberto", note: `Estava "${a.from}". ${a.finding.detail}` };
    case "resolve": return { action: a.state, note: a.state === "corrigido_na_multipark" ? "A varredura confirmou que a Multipark já não tem a divergência." : "A regra deixou de disparar na varredura." };
  }
}
