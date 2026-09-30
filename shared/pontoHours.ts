/**
 * Horas de UM turno de ponto (entrada → saída) — regra única para o ordenado
 * (server/payroll/shifts.ts) e a avaliação (server/evaluationCore.ts). PURA.
 *
 * Por ordem:
 *  1. saída APROVADA com horas gravadas → essas horas, mesmo 0 (um supervisor
 *     que aprova com 0 h está a dizer "não se paga");
 *  2. entrada APROVADA com horas corrigidas (a entrada só tem `hoursWorked`
 *     quando alguém o corrigiu ao aprovar) → essas horas;
 *  3. horas da saída > 0 (ex.: saída cortada às 12 h) → essas horas;
 *  4. senão, a diferença real entre entrada e saída.
 * Antes, o 0 aprovado caía no passo 4 e pagava as horas picadas.
 */

export interface PontoHoursRecord {
  hoursWorked?: string | number | null;
  reviewStatus?: string | null;
}

const hoursOf = (r: PontoHoursRecord | null | undefined): number =>
  r?.hoursWorked == null || r.hoursWorked === "" ? NaN : Number(r.hoursWorked);

/** Horas que contam no turno (arredondadas a 2 casas). */
export function pontoShiftHours(o: { inRec?: PontoHoursRecord | null; outRec: PontoHoursRecord; realHours: number }): number {
  const real = Math.max(0, o.realHours);
  const out = hoursOf(o.outRec);
  const inn = hoursOf(o.inRec);
  let h: number;
  if (o.outRec.reviewStatus === "approved" && Number.isFinite(out) && out >= 0) h = out;
  else if (o.inRec?.reviewStatus === "approved" && Number.isFinite(inn) && inn >= 0) h = inn;
  else if (Number.isFinite(out) && out > 0) h = out;
  else h = real;
  return Math.round(h * 100) / 100;
}
