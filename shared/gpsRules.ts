/**
 * Regras ÚNICAS do GPS do Zello partilhadas entre a recolha (servidor) e as
 * contas feitas sobre os pontos guardados (Resumo do dia: parado no turno,
 * velocidade máxima numa entrega). Antes viviam só em server/zelloGps.ts,
 * que as reexporta — mudar aqui muda em todo o lado.
 */

/** Acima disto é ruído (não há condutores a 150 km/h num parque). */
export const MAX_PLAUSIBLE_KMH = 150;
/** Abaixo disto (km/h) o condutor está parado — "horas de movimento" = o resto. */
export const STOPPED_SPEED_KMH = 2;
/** Dois pontos com mais do que isto (s) entre eles: o Zello esteve desligado/sem sinal — o troço não conta. */
export const MAX_SEGMENT_GAP_S = 3600;

// ─── Limite de velocidade (Jorge, 14 out 2026) ──────────────────────────────
// Sem um limite marcado como padrão em `speed_limits` (Operacional → velocidade),
// vale este: 120 km/h com 10 % de tolerância → limiar 132 km/h. Antes, sem
// limite, os "Dias acima do limite" e os excessos ficavam sempre a 0 (a recolha
// usava 999 km/h). Nota: acima de MAX_PLAUSIBLE_KMH (150) os pontos são ruído e
// não entram na velocidade máxima — um dia a 149 pode ser ruído junto ao teto.

/** km/h por omissão quando não há limite padrão na tabela. */
export const DEFAULT_SPEED_LIMIT_KMH = 120;
/** Tolerância (%) por omissão. */
export const DEFAULT_SPEED_TOLERANCE_PERCENT = 10;

/** Limiar (km/h) a partir do limite padrão da tabela, ou do de omissão. PURA. */
export function speedThresholdKmh(limit: { maxSpeed: number | string | null; tolerancePercent?: number | string | null } | null | undefined): number {
  const max = Number(limit?.maxSpeed);
  if (limit && Number.isFinite(max) && max > 0) {
    const tol = Number(limit.tolerancePercent ?? 0);
    return Math.round(max * (1 + (Number.isFinite(tol) ? tol : 0) / 100) * 100) / 100;
  }
  return Math.round(DEFAULT_SPEED_LIMIT_KMH * (1 + DEFAULT_SPEED_TOLERANCE_PERCENT / 100) * 100) / 100;
}
