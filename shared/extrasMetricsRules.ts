/**
 * Métricas dos extras — leitura do "Custo pago vs previsto" (44c, Jorge 7 out
 * 2026: "custo pago a −98 %"). O pago vem do ponto e o previsto da escala: se
 * os extras não picam o ponto, a diferença é PONTO EM FALTA, não poupança.
 * Compara-se só com a escala até ontem (o dia de hoje ainda não foi picado).
 */

/** Abaixo disto (horas de ponto ÷ horas escaladas até ontem) o ponto está em falta. */
export const PONTO_MIN_SHARE = 0.6;

export type PaidVsPlanned =
  | { kind: "no_schedule" }
  | { kind: "missing_ponto"; share: number }
  | { kind: "diff"; pct: number };

/** PURA. `plannedPastHours`: horas escaladas (sem TL) até ontem; `paidHours`: horas de ponto. */
export function paidVsPlanned(c: { paidHours: number; plannedPastHours: number; paid: number; plannedPast: number }): PaidVsPlanned {
  if (!(c.plannedPastHours > 0)) return { kind: "no_schedule" };
  const share = c.paidHours / c.plannedPastHours;
  if (share < PONTO_MIN_SHARE) return { kind: "missing_ponto", share };
  const base = c.plannedPast > 0 ? c.plannedPast : c.plannedPastHours;
  const top = c.plannedPast > 0 ? c.paid : c.paidHours;
  return { kind: "diff", pct: Math.round(((top - base) / base) * 100) };
}
