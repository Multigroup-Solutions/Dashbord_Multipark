/**
 * Flags financeiros por omissão de uma categoria de despesa, pelo NOME (sem
 * maiúsculas nem acentos). Espelho da migração 0110 (que aplica o mesmo às
 * categorias que já existiam); usado ao criar categorias novas.
 *
 *  - excludeFromMargin: o custo já entra no motor por outra via — RH/salários
 *    e TSU/Segurança Social (histórico salarial + TSU) e extras (ponto ×
 *    tarifa). Contar a despesa também seria contar duas vezes.
 *  - reverseCharge: autoliquidação de IVA (Google/Meta, marketing) → IVA 0%.
 */
export function normalizeCategoryName(name: string | null | undefined): string {
  return String(name ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

const EXCLUDE_RE = /(salari|ordenado|recursos humanos|tsu|seguranca social|extras|(^|[^a-z])rh([^a-z]|$))/;
const REVERSE_RE = /(marketing|publicidade|google|meta ads|facebook|anuncio)/;

export function defaultCategoryFlags(name: string | null | undefined): { excludeFromMargin: boolean; reverseCharge: boolean } {
  const n = normalizeCategoryName(name);
  return { excludeFromMargin: EXCLUDE_RE.test(n), reverseCharge: REVERSE_RE.test(n) };
}
