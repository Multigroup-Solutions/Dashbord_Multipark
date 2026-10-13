/** 29c: separadores da página Financeiro → Caixa (/caixa). */
export const CAIXA_TABS = ["dia", "confirmacao", "resumo", "correcao"] as const;
export type CaixaTab = (typeof CAIXA_TABS)[number];

/** ?tab= da Caixa (aceita o antigo "cash-check" dos alertas da Faturação). PURA. */
export function caixaTabFrom(search: string): CaixaTab {
  const t = new URLSearchParams(search).get("tab");
  if (t === "correcao" || t === "cash-check") return "correcao";
  if (t === "resumo" || t === "cash") return "resumo";
  // 13 out 2026: confirmação da caixa reserva a reserva (avisos de diferença no dia abrem aqui)
  if (t === "confirmacao") return "confirmacao";
  // 29d: abre na caixa do dia
  return "dia";
}
