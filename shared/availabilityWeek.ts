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

// ─── Intervalo de um pedido de disponibilidade ──────────────────────────────
// Um pedido é SEMPRE de uma semana de disponibilidade (segunda a domingo): é
// por semana que a disponibilidade se guarda e é a semana que o link do
// formulário abre. O intervalo pode ser a semana inteira ou parte dela (ex.:
// de quarta a domingo, para quem é aprovado a meio da semana).

/** Semana de HOJE em Lisboa, de segunda a domingo. */
export function currentWeekRangeLisbon(nowMs: number = Date.now()): { from: string; to: string } {
  const from = currentMondayLisbon(nowMs);
  return { from, to: addDays(from, 6) };
}

/**
 * Motivo para recusar o intervalo de um pedido de disponibilidade, ou null se
 * serve. Mesma regra no ecrã e no servidor. PURA.
 */
export function availabilityRangeError(from: string, to: string): string | null {
  if (!isIsoDay(from) || !isIsoDay(to)) return "Escolhe as duas datas do pedido.";
  if (from > to) return "A data inicial tem de ser igual ou anterior à final.";
  if (mondayOfDay(from) !== mondayOfDay(to)) {
    return "O pedido é para uma semana de disponibilidade (segunda a domingo): as duas datas têm de ser da mesma semana.";
  }
  return null;
}

/** "semana de 13/10 a 19/10" — o {{semana}} do template de disponibilidade. PURA. */
export function availabilityRangeLabel(from: string, to: string): string {
  const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  return `semana de ${ddmm(from)} a ${ddmm(to)}`;
}
