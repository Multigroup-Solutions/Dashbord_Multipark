/**
 * "Ocorrências contra o condutor" no Cruzamento de condutores (Perdidos e Achados) — plano 64, F4 (P9).
 *
 * A MESMA fonte da Avaliação para os acidentes: as ocorrências da app Multipark que um team leader
 * confirmou como acidente, com quem conduzia (`evaluation_accidents`, D15), a partir de
 * ACCIDENTS_FROM_DAY e só as ativas (`accidentCounts`). A tabela antiga `incidents` (ocorrências do
 * dashboard, já sem entradas novas) só conta ANTES desse dia — antes disto, o cruzamento só via a
 * antiga e as ocorrências novas faltavam.
 *
 * O corte é no início do dia operacional ACCIDENTS_FROM_DAY (03:00 de Lisboa), o mesmo dia operacional
 * com que os acidentes ficam gravados: nada fica de fora nem conta duas vezes. PURO (testado em
 * server/plano64f.test.ts).
 */
import { ACCIDENTS_FROM_DAY, accidentCounts } from "./evaluationRules";
import { lisbonDayRangeUtc, operationalDayRangeUtc } from "./lisbonDay";

export interface CrossRefOccurrenceWindows {
  /** Janela UTC [start, end) da tabela antiga; null quando o período é todo a partir do corte. */
  legacy: { start: string; end: string } | null;
  /** Dias operacionais [fromDay, toDay] dos acidentes confirmados; null quando o período é todo antes do corte. */
  accidents: { fromDay: string; toDay: string } | null;
}

/** As duas janelas de leitura de um período [from, to] (dias de Lisboa). PURA. */
export function crossRefOccurrenceWindows(from: string, to: string): CrossRefOccurrenceWindows {
  const { start, end } = lisbonDayRangeUtc(from, to);
  const cut = operationalDayRangeUtc(ACCIDENTS_FROM_DAY).start;
  const legacy = start < cut ? { start, end: end < cut ? end : cut } : null;
  const fromDay = from < ACCIDENTS_FROM_DAY ? ACCIDENTS_FROM_DAY : from;
  return { legacy, accidents: fromDay <= to ? { fromDay, toDay: to } : null };
}

export interface ConfirmedAccidentRow {
  employeeId: number | null;
  /** Dia operacional gravado na confirmação. */
  day: string;
  /** Preenchido quando a confirmação foi desfeita (deixa de contar; a linha fica). */
  voidedAt?: unknown;
}

/**
 * Ocorrências contra cada condutor: as antigas (já contadas por condutor na janela `legacy`) + os
 * acidentes confirmados que contam, dentro da janela `accidents`. PURA.
 */
export function driverOccurrenceCounts(
  legacyByEmployee: ReadonlyMap<number, number>,
  accidents: readonly ConfirmedAccidentRow[],
  windows: CrossRefOccurrenceWindows,
): Map<number, number> {
  const out = new Map<number, number>(windows.legacy ? legacyByEmployee : []);
  const w = windows.accidents;
  if (!w) return out;
  for (const a of accidents) {
    if (!a.employeeId || a.day < w.fromDay || a.day > w.toDay || !accidentCounts(a)) continue;
    out.set(a.employeeId, (out.get(a.employeeId) ?? 0) + 1);
  }
  return out;
}
