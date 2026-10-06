/**
 * Flags financeiros por omissão de uma categoria de despesa, pelo NOME (sem
 * maiúsculas nem acentos). Espelho da migração 0110 (que aplica o mesmo às
 * categorias que já existiam); usado ao criar categorias novas.
 *
 *  - excludeFromMargin: o custo já entra no motor por outra via — RH/salários
 *    (histórico salarial) e extras (ponto × tarifa). Contar a despesa também
 *    seria contar duas vezes. 29b (Jorge, 6 out 2026): a TSU / Segurança
 *    Social deixou de ser calculada nos custos — entra pelas Despesas quando é
 *    paga, por isso essas categorias CONTAM (já não se excluem).
 *  - reverseCharge: autoliquidação de IVA (Google/Meta, marketing) → IVA 0%.
 */
export function normalizeCategoryName(name: string | null | undefined): string {
  return String(name ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

const EXCLUDE_RE = /(salari|ordenado|recursos humanos|extras|(^|[^a-z])rh([^a-z]|$))/;
/** Categorias da TSU / Segurança Social (29b: têm de contar na margem). */
export const TSU_CATEGORY_RE = /(^|[^a-z])tsu([^a-z]|$)|seguranca social/;
export const isTsuCategory = (name: string | null | undefined): boolean => TSU_CATEGORY_RE.test(normalizeCategoryName(name));
const REVERSE_RE = /(marketing|publicidade|google|meta ads|facebook|anuncio)/;

export function defaultCategoryFlags(name: string | null | undefined): { excludeFromMargin: boolean; reverseCharge: boolean } {
  const n = normalizeCategoryName(name);
  return { excludeFromMargin: EXCLUDE_RE.test(n), reverseCharge: REVERSE_RE.test(n) };
}
