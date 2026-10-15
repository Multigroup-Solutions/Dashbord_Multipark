/**
 * Plano 64 (C3): as despesas do período por categoria, a partir das MESMAS
 * linhas que o motor soma nos custos (`details.expenses` de computeFinance):
 * não canceladas nem eliminadas, até hoje (as datadas no futuro só entram no
 * Fecho previsto), sem as categorias "excluir da margem" (salários, extras —
 * já contados pelo pessoal e pelo ponto) e com os anúncios Google/Meta. A
 * escolha das despesas é só do motor: aqui só se agrupa.
 *
 *  - `net`   = s/ IVA — soma `fin.costs.expensesNet` (os "Custos s/ IVA");
 *  - `gross` = c/ IVA — o valor da despesa; soma `fin.costs.expenses`.
 *
 * Sem categoria → "Sem categoria". PURA.
 */
export interface ExpenseCategoryRow {
  categoryName: string | null;
  /** valor da despesa (c/ IVA) */
  totalAmount: number;
  /** sem IVA (taxa da categoria; 0 % em autoliquidação) */
  totalNet: number;
}

export function expensesByCategory(rows: readonly ExpenseCategoryRow[], base: "net" | "gross"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of rows) {
    const k = e.categoryName ?? "Sem categoria";
    out[k] = (out[k] ?? 0) + (base === "gross" ? e.totalAmount : e.totalNet);
  }
  return out;
}
