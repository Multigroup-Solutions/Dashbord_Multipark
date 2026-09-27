/**
 * MARKETPLACE — parques de terceiros em que NÓS somos o marketplace (vendemos
 * as reservas deles). Regra do dono (27 set 2026): o valor das reservas
 * divide-se 80 % para o parque e 20 % para nós. Uma constante única para, mais
 * tarde, passar a ser configurável por parque.
 */

/** A nossa parte do valor das reservas de um parque de terceiros (0–1). */
export const MARKETPLACE_COMMISSION = 0.2;

const cents = (n: number) => Math.round(n * 100) / 100;

/** Valor → { nossa parte, parte do parque }. `rate` por omissão = MARKETPLACE_COMMISSION. PURA. */
export function marketplaceSplit(value: number, rate: number = MARKETPLACE_COMMISSION): { ours: number; park: number } {
  const v = Number.isFinite(value) ? value : 0;
  const r = Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : MARKETPLACE_COMMISSION;
  const ours = cents(v * r);
  return { ours, park: cents(v - ours) };
}
