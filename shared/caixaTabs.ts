/** 29c: separadores da página Financeiro → Caixa (/caixa). */
export const CAIXA_TABS = ["resumo", "correcao"] as const;
export type CaixaTab = (typeof CAIXA_TABS)[number];

/** ?tab= da Caixa (aceita o antigo "cash-check" dos alertas da Faturação). PURA. */
export function caixaTabFrom(search: string): CaixaTab {
  const t = new URLSearchParams(search).get("tab");
  if (t === "correcao" || t === "cash-check") return "correcao";
  return "resumo";
}
