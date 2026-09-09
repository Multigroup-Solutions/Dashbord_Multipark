/**
 * Paleta e estilos partilhados para gráficos Recharts.
 *
 * Todas as dashboards devem importar estas constantes em vez de hardcoded
 * hex values. Alinhado com as CSS vars definidas em client/src/index.css.
 */

// Cores Multipark — primary + accents coerentes
export const CHART_PRIMARY = "#1E5BFF";
export const CHART_BORDER = "#E2E8F5";
export const CHART_MUTED_FG = "#64748B";
export const CHART_BG = "#FFFFFF";

/** Paleta categórica — usa em Pie/Donut charts ou séries de barras. */
export const CHART_PALETTE = [
  "#1E5BFF", // primary (Multipark)
  "#10B981", // green
  "#F59E0B", // amber
  "#EC4899", // pink
  "#8B5CF6", // violet
  "#06B6D4", // cyan
  "#F97316", // orange
  "#84CC16", // lime
] as const;

/** Cores semânticas — positivo/negativo/aviso. */
export const CHART_SEMANTIC = {
  success: "#10B981",
  warning: "#F59E0B",
  danger: "#EF4444",
  info: CHART_PRIMARY,
  muted: "#94A3B8",
} as const;

/** Cores oficiais de plataformas — mantidas para reconhecimento visual. */
export const PLATFORM_COLORS = {
  google_ads: "#4285F4",
  meta_ads: "#1877F2",
  instagram: "#E4405F",
  other: CHART_MUTED_FG,
} as const;

/** Estilo padrão para <CartesianGrid />. */
export const chartGridStroke = CHART_BORDER;

/** Estilo padrão para ticks dos eixos. */
export const chartAxisTick = { fontSize: 11, fill: CHART_MUTED_FG };

/** Estilo partilhado para tooltips do Recharts. */
export const chartTooltipStyle = {
  background: CHART_BG,
  border: `1px solid ${CHART_BORDER}`,
  borderRadius: "8px",
  fontSize: "12px",
  boxShadow: "0 4px 12px -2px rgba(15, 23, 42, 0.08)",
};
