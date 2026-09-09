import { sumAmounts } from "./expenseAmount";

/**
 * Regra ÚNICA dos totais de despesas (KPIs da lista, resumo do Excel,
 * comparação de períodos): as CANCELADAS ficam FORA do total e são mostradas
 * à parte. Antes a lista somava-as e a comparação não — os dois ecrãs davam
 * números diferentes para o mesmo filtro.
 */
export interface ExpenseTotals {
  total: number;        // sem canceladas
  pending: number;
  paid: number;
  overdue: number;
  cancelled: number;    // só informativo
  count: number;        // sem canceladas
  cancelledCount: number;
}

export function expenseTotals(rows: Array<{ amount: string | number | null; status: string | null }>): ExpenseTotals {
  const by = (st: string) => rows.filter((r) => r.status === st);
  const live = rows.filter((r) => r.status !== "cancelled");
  return {
    total: sumAmounts(live.map((r) => r.amount)),
    pending: sumAmounts(by("pending").map((r) => r.amount)),
    paid: sumAmounts(by("paid").map((r) => r.amount)),
    overdue: sumAmounts(by("overdue").map((r) => r.amount)),
    cancelled: sumAmounts(by("cancelled").map((r) => r.amount)),
    count: live.length,
    cancelledCount: rows.length - live.length,
  };
}
