/**
 * Categorias de despesa — nomes certos e a lista do formulário (Jorge, 14 out 2026).
 *
 * As despesas guardam a categoria pelo ID (`expenses.categoryId`), por isso
 * corrigir o NOME de uma categoria não mexe em nenhuma despesa: só muda o que
 * se lê. Nada se apaga nem se junta: se o nome certo já existir noutra
 * categoria, a errada fica como está (e diz-se porquê).
 *
 *  - `fixCategoryName`: corrige palavra a palavra os acentos em falta / erros
 *    óbvios (Combustivel → Combustível, Manutencao → Manutenção, …), mantendo
 *    as maiúsculas da palavra. Só palavras SEM ambiguidade (nunca "e"/"é").
 *  - `planCategoryFixes`: o que mudar na tabela (renomear por id; acrescentar
 *    "Sinistros" se ainda não existir).
 *  - `orderExpenseCategories`: a ordem de sempre (alfabética, sem contar
 *    acentos nem maiúsculas — a mesma do `ORDER BY name` da BD).
 * PURAS.
 */
import { matchKey } from "./textKey";

/**
 * Palavra (sem acentos, minúsculas) → forma certa (minúsculas).
 * A chave é comparada SEM acentos: "Manutençao" e "Manutencão" também se corrigem.
 */
export const CATEGORY_WORD_FIXES: Readonly<Record<string, string>> = {
  acessorios: "acessórios",
  administracao: "administração",
  agencia: "agência",
  agencias: "agências",
  agua: "água",
  alimentacao: "alimentação",
  anuncios: "anúncios",
  bancaria: "bancária",
  bancarias: "bancárias",
  bancario: "bancário",
  bancarios: "bancários",
  cafe: "café",
  comissao: "comissão",
  comissoes: "comissões",
  combustivel: "combustível",
  combustiveis: "combustíveis",
  comunicacao: "comunicação",
  comunicacoes: "comunicações",
  condominio: "condomínio",
  construcao: "construção",
  consumiveis: "consumíveis",
  credito: "crédito",
  debito: "débito",
  deslocacao: "deslocação",
  deslocacoes: "deslocações",
  devolucoes: "devoluções",
  electricidade: "eletricidade",
  eletrico: "elétrico",
  electrico: "elétrico",
  eletricos: "elétricos",
  emprestimos: "empréstimos",
  escritorio: "escritório",
  formacao: "formação",
  formacoes: "formações",
  gas: "gás",
  gasoleo: "gasóleo",
  gestao: "gestão",
  honorarios: "honorários",
  hoteis: "hotéis",
  imoveis: "imóveis",
  indemnizacao: "indemnização",
  indemnizacoes: "indemnizações",
  informatica: "informática",
  inspecao: "inspeção",
  inspeccao: "inspeção",
  inspecoes: "inspeções",
  instalacoes: "instalações",
  juridico: "jurídico",
  juridicos: "jurídicos",
  licenca: "licença",
  licencas: "licenças",
  locacao: "locação",
  logistica: "logística",
  manutencao: "manutenção",
  manutencoes: "manutenções",
  manuntencao: "manutenção",
  mecanica: "mecânica",
  operacao: "operação",
  operacoes: "operações",
  patrocinios: "patrocínios",
  pecas: "peças",
  premios: "prémios",
  prestacao: "prestação",
  prestacoes: "prestações",
  promocoes: "promoções",
  reclamacoes: "reclamações",
  refeicoes: "refeições",
  remuneracoes: "remunerações",
  reparacao: "reparação",
  reparacoes: "reparações",
  residuos: "resíduos",
  restauracao: "restauração",
  salarios: "salários",
  saude: "saúde",
  seguranca: "segurança",
  servico: "serviço",
  servicos: "serviços",
  subscricao: "subscrição",
  subscricoes: "subscrições",
  taxis: "táxis",
  telecomunicacoes: "telecomunicações",
  telemoveis: "telemóveis",
  telemovel: "telemóvel",
  trafego: "tráfego",
  transferencias: "transferências",
  utilitarios: "utilitários",
  veiculo: "veículo",
  veiculos: "veículos",
  vigilancia: "vigilância",
};

const WORD = /[\p{L}]+/gu;
const fold = (w: string) => w.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function withCaseOf(original: string, fixed: string): string {
  if (original.length > 1 && original === original.toUpperCase()) return fixed.toUpperCase();
  if (original[0] && original[0] === original[0].toUpperCase()) return fixed[0].toUpperCase() + fixed.slice(1);
  return fixed;
}

/** Nome com os acentos/erros corrigidos (e espaços a mais tirados). PURA. */
export function fixCategoryName(name: string | null | undefined): string {
  const clean = String(name ?? "").replace(/\s+/g, " ").trim();
  return clean.replace(WORD, (w) => {
    const fixed = CATEGORY_WORD_FIXES[fold(w)];
    return fixed ? withCaseOf(w, fixed) : w;
  });
}

/** A categoria nova pedida pelo Jorge (14 out 2026). */
export const SINISTROS_CATEGORY = { name: "Sinistros", department: "Operacional", color: "#b91c1c" } as const;

export interface CategoryRow { id: number; name: string | null }

export interface CategoryFixPlan {
  renames: Array<{ id: number; from: string; to: string }>;
  /** Nome certo já usado por OUTRA categoria — fica como está (não se junta nem apaga). */
  skipped: Array<{ id: number; from: string; to: string }>;
  addSinistros: boolean;
}

/** O que corrigir na tabela das categorias. PURA. */
export function planCategoryFixes(rows: ReadonlyArray<CategoryRow>): CategoryFixPlan {
  const plan: CategoryFixPlan = { renames: [], skipped: [], addSinistros: false };
  // Nomes exatos (com acentos, sem maiúsculas) que vão existir depois das mudanças
  const taken = new Map<string, number>();
  for (const r of rows) {
    const n = String(r.name ?? "").trim().toLowerCase();
    if (n && !taken.has(n)) taken.set(n, r.id);
  }
  for (const r of rows) {
    const from = String(r.name ?? "");
    const to = fixCategoryName(from);
    if (!to || to === from) continue;
    const owner = taken.get(to.toLowerCase());
    if (owner != null && owner !== r.id) { plan.skipped.push({ id: r.id, from, to }); continue; }
    plan.renames.push({ id: r.id, from, to });
    taken.set(to.toLowerCase(), r.id);
  }
  const keys = new Set(rows.map((r) => matchKey(r.name)));
  plan.addSinistros = !keys.has("sinistros") && !keys.has("sinistro");
  return plan;
}

/** A ordem de sempre: alfabética sem contar acentos nem maiúsculas (= ORDER BY name da BD). PURA. */
export function orderExpenseCategories<T extends { id: number; name: string | null }>(cats: ReadonlyArray<T>): T[] {
  return [...cats].sort((a, b) =>
    String(a.name ?? "").localeCompare(String(b.name ?? ""), "pt", { sensitivity: "base" }) || a.id - b.id);
}
