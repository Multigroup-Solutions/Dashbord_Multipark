/**
 * Plano 64 (C3): as despesas do período por categoria (c/ IVA, do
 * `invoices.financeSummary`) → o que o Financeiro mostra. PURA.
 *
 *  - `total` leva TODAS as categorias: uma nota de crédito maior do que as
 *    despesas da categoria no período deixa-a com saldo negativo, e esse saldo
 *    desconta (o total bate com os custos do motor, ao cêntimo);
 *  - `slices` = as categorias com saldo positivo, da maior para a menor — as
 *    únicas que um donut ou uma barra conseguem desenhar;
 *  - `outside` = as de saldo negativo, que ficam fora do gráfico e o ecrã diz
 *    quais são (senão as fatias somavam mais do que o total, sem explicação).
 *
 * Valores ao cêntimo (o motor soma em vírgula flutuante: um saldo de
 * 0,0000000001 € não é uma fatia).
 */
export interface CategorySlice {
  name: string;
  value: number;
}

const cents = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;

export function categorySlices(byCategory: Readonly<Record<string, number>> | null | undefined): {
  total: number;
  slices: CategorySlice[];
  outside: CategorySlice[];
} {
  const raw = Object.entries(byCategory ?? {});
  const total = cents(raw.reduce((s, [, v]) => s + (Number(v) || 0), 0));
  const rows = raw.map(([name, v]) => ({ name, value: cents(v) }));
  const slices = rows.filter((c) => c.value > 0).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "pt"));
  const outside = rows.filter((c) => c.value < 0).sort((a, b) => a.value - b.value || a.name.localeCompare(b.name, "pt"));
  return { total, slices, outside };
}
