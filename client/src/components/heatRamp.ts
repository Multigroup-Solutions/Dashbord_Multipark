/**
 * Rampa dos quadros "dia × hora" (Extras Dia → Pressão e Atividade diária →
 * Semana): 44a — um só tom, quatro degraus (claro → escuro), os números
 * escritos na célula. Um sítio só para os dois quadros terem a mesma legenda.
 */
import type { CSSProperties } from "react";

export const RAMP = ["#86b6ef", "#5598e7", "#256abf", "#104281"] as const;

/** Degrau da rampa de um valor (0 … 3). */
export const rampIndex = (v: number, max: number) => Math.min(RAMP.length - 1, Math.floor((v / max) * RAMP.length - 1e-9));

/** Cor de fundo e do texto de uma célula (sem valor ou ≤ 0 → sem cor). */
export function cellStyle(v: number | null, max: number): CSSProperties {
  if (v == null || v <= 0 || max <= 0) return {};
  const i = rampIndex(v, max);
  return { backgroundColor: RAMP[i], color: i >= 2 ? "#ffffff" : "#0f172a" };
}

/** Os degraus da legenda (de … até). */
export function rampLegend(max: number): Array<{ c: string; from: number; to: number }> {
  return max > 0 ? RAMP.map((c, i) => ({ c, from: (max * i) / RAMP.length, to: (max * (i + 1)) / RAMP.length })) : [];
}
