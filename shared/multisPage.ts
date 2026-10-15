/**
 * Contexto da página para o Multis (plano MPV §3.1, F0b): o separador aberto
 * e o registo aberto (ex.: a reserva da ficha) vão com cada pergunta.
 *
 *  - O cliente (`useMultisPage({ tab, entity })`) diz o que está aberto; o
 *    widget manda `{ path, tab, entity }` em `assistant.status` e `assistant.ask`.
 *  - O servidor só aceita o `tab` da lista da página (as MESMAS constantes que
 *    as páginas usam) e o `entity` de um tipo conhecido com id inteiro > 0.
 *    Fora disso é ignorado (nunca dá erro). Nada disto dá acesso a nada: só
 *    acrescenta uma linha ao <contexto> do turno.
 *
 * PURO (partilhado servidor ↔ cliente).
 */
import { CAIXA_TABS } from "./caixaTabs";
import { CONDUTORES_TABS } from "./condutoresAccess";
import { OPERATIONAL_TABS } from "./operationalTabs";

/** Avaliação (/avaliacao). */
export const AVALIACAO_TABS = ["dia", "mes", "minha", "contestacoes"] as const;
export type AvaliacaoTab = (typeof AVALIACAO_TABS)[number];
/** Extras-Dia (/extras-dia). */
export const EXTRAS_DIA_TABS = ["dia", "pressao"] as const;
export type ExtrasDiaTab = (typeof EXTRAS_DIA_TABS)[number];
/** Despesas (/despesas). */
export const EXPENSES_TABS = ["lista", "resumo"] as const;
export type ExpensesTab = (typeof EXPENSES_TABS)[number];
/** Parcerias (/parcerias). */
export const PARTNERSHIPS_TABS = ["partners", "parks", "pro", "summary", "fecho", "analytics", "management"] as const;
export type PartnershipsTab = (typeof PARTNERSHIPS_TABS)[number];
/** Críticas (/criticas). */
export const GOOGLE_REVIEWS_TABS = ["dashboard", "list"] as const;
export type GoogleReviewsTab = (typeof GOOGLE_REVIEWS_TABS)[number];
/** Formação (/formacao). */
export const TRAINING_TABS = ["mine", "videos", "manuals", "faqs", "quiz", "career", "paths", "dashboard"] as const;
export type TrainingTab = (typeof TRAINING_TABS)[number];

/** Separadores aceites por página (caminho exato, sem "?…" nem "/" no fim). */
export const MULTIS_PAGE_TABS: Readonly<Record<string, readonly string[]>> = {
  "/operacional": OPERATIONAL_TABS,
  "/caixa": CAIXA_TABS,
  "/avaliacao": AVALIACAO_TABS,
  "/extras-dia": EXTRAS_DIA_TABS,
  "/despesas": EXPENSES_TABS,
  "/parcerias": PARTNERSHIPS_TABS,
  "/pessoas/condutores-agentes": CONDUTORES_TABS,
  "/criticas": GOOGLE_REVIEWS_TABS,
  "/formacao": TRAINING_TABS,
};

/** Tipos de registo que o Multis pode saber que estão abertos. */
export const MULTIS_ENTITY_TYPES = ["booking", "employee", "review", "complaint", "expense", "partner"] as const;
export type MultisEntityType = (typeof MULTIS_ENTITY_TYPES)[number];
export interface MultisEntity { type: MultisEntityType; id: number }

/** Nome do tipo de registo para o <contexto> (PT-PT). */
export const MULTIS_ENTITY_LABELS: Record<MultisEntityType, string> = {
  booking: "reserva",
  employee: "colaborador",
  review: "crítica",
  complaint: "reclamação",
  expense: "despesa",
  partner: "parceiro",
};

/**
 * "/despesas?x=1#a" → "/despesas"; "/formacao/" → "/formacao". Só caminhos
 * com letras, dígitos, "_", "-" e "/" (até 200 car.); o resto → "" (não vai
 * para o <contexto>). PURA.
 */
export function pagePathOf(path: unknown): string {
  const p = String(path ?? "").split(/[?#]/)[0].trim();
  if (!p || p.length > 200 || !/^\/[\w/-]*$/.test(p)) return "";
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** O separador, se for da lista desta página; senão null. PURA. */
export function validMultisTab(path: unknown, tab: unknown): string | null {
  if (typeof tab !== "string") return null;
  const t = tab.trim();
  const list = MULTIS_PAGE_TABS[pagePathOf(path)];
  return list && (list as readonly string[]).includes(t) ? t : null;
}

/** O registo aberto, se o tipo for conhecido e o id um inteiro > 0; senão null. PURA. */
export function validMultisEntity(entity: unknown): MultisEntity | null {
  if (!entity || typeof entity !== "object") return null;
  const e = entity as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type.trim() : "";
  const id = typeof e.id === "number" ? e.id : Number.NaN;
  if (!(MULTIS_ENTITY_TYPES as readonly string[]).includes(type)) return null;
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { type: type as MultisEntityType, id };
}

/** `{ path, tab, entity }` do widget → só o que é válido. PURA. */
export function sanitizeMultisPage(input: { path?: unknown; tab?: unknown; entity?: unknown } | null | undefined): { tab: string | null; entity: MultisEntity | null } {
  return { tab: validMultisTab(input?.path, input?.tab), entity: validMultisEntity(input?.entity) };
}
