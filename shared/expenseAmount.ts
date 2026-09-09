/**
 * Normalização ÚNICA de valores monetários das despesas (cliente + servidor).
 *
 * Aceita o que as pessoas escrevem e o que a IA devolve: "45,90", "45.90 €",
 * "1.234,56", "1 234,56", "1234.5". Devolve sempre uma string decimal com
 * PONTO e no máximo 2 casas ("1234.56"), ou null se não for um valor válido
 * e positivo. Nunca arredonda: "1.999" é inválido (3 casas), não "2.00".
 */
export function parseExpenseAmount(input: string | number | null | undefined): string | null {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  // símbolos e espaços (inclui NBSP dos separadores de milhares)
  s = s.replace(/[€$£]/g, "").replace(/[\s ]/g, "");
  if (!s) return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // O ÚLTIMO separador é o decimal; o outro é de milhares.
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    // "1,234" é ambíguo (milhares PT-BR vs. decimal com 3 casas): tratamos a
    // vírgula como decimal — 3 casas falha a validação, que é o comportamento
    // seguro (pede-se para corrigir em vez de gravar 1234 ou 1.23).
    s = s.replace(",", ".");
  } else if (hasDot) {
    // "1.234.567" (só pontos, vários) = milhares; "12.50" = decimal
    const parts = s.split(".");
    if (parts.length > 2) s = parts.join("");
  }

  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}

/** Soma decimal segura para valores "12.34" (evita 0.1+0.2). */
export function sumAmounts(values: Array<string | number | null | undefined>): number {
  let cents = 0;
  for (const v of values) {
    if (v == null || v === "") continue;
    const n = Number(String(v).replace(",", "."));
    if (!Number.isFinite(n)) continue;
    cents += Math.round(n * 100);
  }
  return cents / 100;
}
