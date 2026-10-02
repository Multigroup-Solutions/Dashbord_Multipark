/**
 * Semana da disponibilidade (extras): começa SEMPRE à segunda-feira, em dias
 * de Lisboa. As mesmas regras no ecrã e no servidor. PURO.
 */
import { addDays, lisbonDayOf } from "./lisbonDay";
import { mondayOfDay } from "./taskRules";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Dia ISO que existe no calendário ("2026-02-30" não). */
export function isIsoDay(s: string): boolean {
  return ISO_DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

/** Dia válido e segunda-feira. */
export function isMondayIso(s: string): boolean {
  return isIsoDay(s) && mondayOfDay(s) === s;
}

export const NOT_MONDAY_MESSAGE = "A semana da disponibilidade começa à segunda-feira.";

/** Segunda-feira da semana de HOJE em Lisboa (o servidor corre em UTC). */
export function currentMondayLisbon(nowMs: number = Date.now()): string {
  return mondayOfDay(lisbonDayOf(nowMs));
}

/**
 * Semana a mostrar em "A minha disponibilidade": a do link (?week=, levada à
 * segunda-feira dessa semana) ou a PRÓXIMA semana de Lisboa.
 */
export function availabilityWeekFrom(search: string, nowMs: number): string {
  const q = new URLSearchParams(search).get("week");
  if (q && isIsoDay(q)) return mondayOfDay(q);
  return addDays(currentMondayLisbon(nowMs), 7);
}
