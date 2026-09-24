import type { CSSProperties } from "react";

/**
 * Formatação de valores para ECRÃ (páginas financeiras / marketing).
 *
 * Só apresentação — nunca usar para cálculos ou exportações. Os valores
 * compactos ("1,2 M €") só aparecem quando o espaço é curto e vêm sempre
 * acompanhados do valor completo (title / tooltip / sr-only).
 */

const EUR = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" });
const EUR0 = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const NUM1 = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
const NUM2 = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 2 });

/** Espaços não separáveis: o Recharts não parte "600 mil €" em linhas. */
const nb = (s: string) => s.replace(/ /g, "\u00a0");

function toNum(v: number | string | null | undefined): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/** Valor completo: "1 234 567,89 €". */
export function eurFull(v: number | string | null | undefined): string {
  return EUR.format(toNum(v));
}

/**
 * Valor compacto para espaços curtos: "1,23 M €", "554,7 mil €", "950 €".
 * Abaixo de 10 000 € devolve o valor sem casas decimais (continua exato à
 * unidade); o valor completo deve ir num title/tooltip.
 */
export function eurCompact(v: number | string | null | undefined): string {
  const n = toNum(v);
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e9) return `${sign}${NUM2.format(a / 1e9)} mil M €`;
  if (a >= 1e6) return `${sign}${NUM2.format(a / 1e6)} M €`;
  if (a >= 1e4) return `${sign}${NUM1.format(a / 1e3)} mil €`;
  return EUR0.format(n);
}

/** Rótulos de eixo de gráficos: "0 €", "850 €", "15 mil €", "1,2 M €". */
export function eurAxis(v: number | string | null | undefined): string {
  const n = toNum(v);
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e6) return nb(`${sign}${NUM1.format(a / 1e6)} M €`);
  if (a >= 1e3) return nb(`${sign}${NUM1.format(a / 1e3)} mil €`);
  return nb(`${sign}${Math.round(a)} €`);
}

/** Números inteiros grandes para eixos (sem moeda): "12 mil", "1,2 M". */
export function numAxis(v: number | string | null | undefined): string {
  const n = toNum(v);
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e6) return nb(`${sign}${NUM1.format(a / 1e6)} M`);
  if (a >= 1e4) return nb(`${sign}${NUM1.format(a / 1e3)} mil`);
  return `${sign}${NUM1.format(a)}`;
}

/**
 * Paleta de séries do design system Multipark (tokens --chart-1..5), com
 * navy e slate como 6.ª/7.ª cor para categorias longas. Funciona em SVG
 * (fill/stroke) e acompanha o modo escuro.
 */
export const CHART_PALETTE = [
  "var(--chart-1)",
  "var(--chart-4)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-5)",
  "var(--secondary-foreground)",
  "var(--muted-foreground)",
];

/** Estilo comum das tooltips do Recharts (tokens do tema). */
export const CHART_TOOLTIP_STYLE: CSSProperties = {
  background: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  fontSize: "12px",
};

/** Ticks dos eixos (tamanho legível + cor do tema). */
export const AXIS_TICK = { fontSize: 11, fill: "var(--muted-foreground)" } as const;

/** Linhas da tooltip em cor de texto (a cor da série fica no marcador). */
export const CHART_TOOLTIP_ITEM: CSSProperties = { color: "var(--popover-foreground)" };
