/**
 * Filtros do Anual (P2.3 — 2 out 2026). PUROS.
 */

/** Primeiro ano com dados (histórico importado). */
export const ANNUAL_FIRST_YEAR = 2016;

/**
 * Anos a escolher: do próximo ao primeiro com histórico. Antes o ano era um
 * campo de texto que pedia o cálculo a cada tecla ("2025" → anos 2, 20, 202 e
 * 2025; os três primeiros davam erro).
 */
export function yearOptions(current: number): number[] {
  const out: number[] = [];
  for (let y = current + 1; y >= ANNUAL_FIRST_YEAR; y--) out.push(y);
  return out;
}

/** "De" nunca depois de "Até" (antes ficava tudo a zero): acompanha o que mudou. */
export function normalizeMonthRange(from: number, to: number, changed: "from" | "to"): { from: number; to: number } {
  if (from <= to) return { from, to };
  return changed === "from" ? { from, to: from } : { from: to, to };
}
