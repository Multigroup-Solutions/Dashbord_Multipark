/**
 * Ligação direta a uma despesa (Jorge, 12 out 2026: "a despesa deve ir
 * imediatamente para as Despesas, com um link direto"). `/despesas?id=123`
 * abre o detalhe dessa despesa na página das Despesas. PURO.
 */

export function expenseLink(id: number): string {
  return `/despesas?id=${id}`;
}

/** "?id=123" → 123; sem `id` ou inválido → null. */
export function expenseIdFromSearch(search: string | null | undefined): number | null {
  const raw = new URLSearchParams(String(search ?? "")).get("id");
  if (!raw || !/^\d{1,10}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** A pesquisa sem o `id` (para não voltar a abrir a despesa ao recarregar). */
export function searchWithoutExpenseId(search: string | null | undefined): string {
  const p = new URLSearchParams(String(search ?? ""));
  p.delete("id");
  const s = p.toString();
  return s ? `?${s}` : "";
}
