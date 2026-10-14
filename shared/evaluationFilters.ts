/**
 * Avaliação → Mês: pesquisa e filtros do ranking "como no Odoo" (Jorge, 14 out
 * 2026: "não há sítio nenhum para pesquisar um condutor… tem de ser esse tipo de
 * filtro, para eu pôr alguns parâmetros e ver como estão os condutores").
 *
 * O MESMO padrão do CRM (shared/crmFilters.ts, docs/crm/desenho-crm.md → "Do
 * Odoo"):
 *  - barra única com facetas: escreve-se e propõe "procurar em Nome / Cidade /
 *    Marca / Posto / Equipa"; cada escolha vira um chip (mesmo campo → OU,
 *    campos diferentes → E);
 *  - filtros em grupos (OU dentro do grupo, E entre grupos): cidade, marca,
 *    posto, equipa e "só com…" (reclamações, acidentes, atrasos, velocidade…);
 *  - filtro personalizado com regras sobre as colunas e as métricas (≥, ≤, =,
 *    entre, tem, não tem), "todas" ou "pelo menos uma";
 *  - filtros guardados (com nome, um por omissão) e "agrupar por".
 *
 * O ranking do período é pequeno (uma linha por pessoa, já no âmbito de quem vê:
 * cidade, equipa do TL) — filtra-se no ecrã, na hora. A exportação para Sheets
 * aplica ESTAS funções no servidor, sobre o mesmo procedimento da página. PURO.
 */
import { z } from "zod";
import { matchKey, matchWords } from "./textKey";
import type { DayMetrics } from "./evaluationRules";

// ─── A linha do ranking (o que o filtro lê) ─────────────────────────────────

export interface EvalRankingRowLike {
  employeeId: number;
  employeeName: string;
  position: string | null;
  days: number;
  metrics: Partial<DayMetrics>;
  score: { totalPoints: number; positivePoints?: number; negativePoints?: number };
  perHour?: { hours?: number; actionsPerHour?: number | null; weightedPerHour?: number | null; pointsPerHour?: number | null } | null;
  adjustments?: number;
  openDisputes?: number;
  /** cidades (lisbon/porto/faro) onde trabalhou no período; sem escala, a da ficha */
  cities?: string[];
  /**
   * marca da ficha (nó "marca" do centro de custos). Os nós de marca são POR
   * CIDADE (o Airpark de Lisboa e o do Porto são nós diferentes): os filtros
   * e o agrupar usam o NOME (brandKey), não o id.
   */
  brand?: { id: number; name: string } | null;
  /** n.º (id) e nomes dos agentes Multipark da pessoa */
  agents?: string[];
  /** dias em que foi TL */
  tlDays?: number;
  /** o TL com quem mais trabalhou (mesmo dia, cidade e turno) */
  teamLeader?: { id: number; name: string } | null;
}

export const EVAL_CITY_LABELS: Record<string, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };
export const cityLabel = (c: string) => EVAL_CITY_LABELS[c] ?? c;

/** Posto no ranking (as posições do ranking + "foi TL"). */
export const EVAL_POSITIONS = [
  { id: "driver", label: "Condutor" },
  { id: "senior_driver", label: "Condutor sénior" },
  { id: "extra", label: "Extra" },
  { id: "tl", label: "Team leader (dias como TL)" },
] as const;
export type EvalPosition = (typeof EVAL_POSITIONS)[number]["id"];
export const positionLabel = (p: string | null | undefined) => EVAL_POSITIONS.find((x) => x.id === p)?.label ?? (p || "Sem posto");

/** A chave da marca para filtrar e agrupar: o nome normalizado ("Airpark" = "AIRPARK"), igual em todas as cidades. PURA. */
export const brandKey = (name: string | null | undefined) => matchKey(name);
const brandKeyOf = (r: EvalRankingRowLike) => (r.brand ? brandKey(r.brand.name) : "");

// ─── Pesquisa por facetas ───────────────────────────────────────────────────

export const EVAL_SEARCH_FIELDS = [
  { id: "name", label: "Nome ou n.º de agente" },
  { id: "city", label: "Cidade" },
  { id: "brand", label: "Marca" },
  { id: "position", label: "Posto" },
  { id: "team", label: "Equipa (TL)" },
] as const;
export type EvalSearchField = (typeof EVAL_SEARCH_FIELDS)[number]["id"];
export interface EvalSearch { field: EvalSearchField; text: string }

/**
 * Os textos de cada faceta de uma linha (o que a pesquisa compara), em PARTES
 * separadas: o nome, cada agente, cada cidade… — uma palavra procura-se em cada
 * parte, nunca na junção de duas ("Silva" + agente "12" não dá "a1"). PURA.
 */
export function searchHaystack(r: EvalRankingRowLike, field: EvalSearchField): string[] {
  switch (field) {
    case "name": return [r.employeeName, ...(r.agents ?? [])];
    case "city": return (r.cities ?? []).flatMap((c) => [cityLabel(c), c]);
    case "brand": return r.brand?.name ? [r.brand.name] : [];
    case "position": return [positionLabel(r.position), ...((r.tlDays ?? 0) > 0 ? ["team leader", "TL"] : [])];
    case "team": return r.teamLeader?.name ? [r.teamLeader.name] : [];
  }
}

/**
 * Pesquisa em partes: cada palavra da pergunta tem de aparecer numa das partes
 * (sem acentos, maiúsculas, apóstrofos nem traços — a regra de shared/textKey.ts:
 * "joao dalmeida" encontra "João d'Almeida"; "4711" encontra o agente 4711). PURA.
 */
export function partsMatch(parts: ReadonlyArray<string | null | undefined>, query: string | null | undefined): boolean {
  const words = matchWords(query);
  if (!words.length) return true;
  const keys = parts.map((p) => matchKey(p)).filter(Boolean);
  return words.every((w) => keys.some((k) => k.includes(w)));
}

/** Uma linha cumpre a pesquisa? (cada palavra tem de aparecer). PURA. */
export function matchesSearch(r: EvalRankingRowLike, s: EvalSearch): boolean {
  return partsMatch(searchHaystack(r, s.field), s.text);
}

/** Quantas linhas cada faceta encontra com este texto ("Procurar «ana» em Nome (3)"). PURA. */
export function facetCounts(rows: readonly EvalRankingRowLike[], text: string): Record<EvalSearchField, number> {
  const out = {} as Record<EvalSearchField, number>;
  for (const f of EVAL_SEARCH_FIELDS) out[f.id] = rows.filter((r) => matchesSearch(r, { field: f.id, text })).length;
  return out;
}

// ─── Grupos (OU dentro, E entre) ────────────────────────────────────────────

export const EVAL_FLAGS = [
  { id: "speeding", label: "Excessos de velocidade" },
  { id: "complaints", label: "Reclamações" },
  { id: "accidents", label: "Acidentes / danos" },
  { id: "delays", label: "Atrasos" },
  { id: "lateServices", label: "Entregas atrasadas" },
  { id: "disputes", label: "Contestações abertas" },
  { id: "adjusted", label: "Com ajustes" },
  { id: "negative", label: "Pontos negativos (total < 0)" },
] as const;
export type EvalFlag = (typeof EVAL_FLAGS)[number]["id"];

export interface EvalGroups {
  city?: string[];
  /** chave do nome da marca (brandKey: "airpark") — a mesma em todas as cidades */
  brand?: string[];
  position?: EvalPosition[];
  /** id do TL (texto) */
  team?: string[];
  /** "só com…" */
  flags?: EvalFlag[];
}
export const EVAL_GROUP_ORDER: (keyof EvalGroups)[] = ["city", "brand", "position", "team", "flags"];
export const EVAL_GROUP_LABELS: Record<keyof EvalGroups, string> = {
  city: "Cidade", brand: "Marca", position: "Posto", team: "Equipa", flags: "Só com…",
};
/** O prefixo de cada grupo nos chips e nas exportações ("Só com: Reclamações ou Acidentes"). */
export const EVAL_GROUP_CHIP_LABELS: Record<keyof EvalGroups, string> = { ...EVAL_GROUP_LABELS, flags: "Só com" };

const m = (r: EvalRankingRowLike, k: keyof DayMetrics) => Number(r.metrics?.[k] ?? 0) || 0;

export function hasFlag(r: EvalRankingRowLike, f: EvalFlag): boolean {
  switch (f) {
    case "speeding": return m(r, "speedingEvents") > 0;
    case "complaints": return m(r, "complaints") > 0;
    case "accidents": return m(r, "accidents") > 0;
    case "delays": return m(r, "delays") > 0;
    case "lateServices": return m(r, "lateServices") > 0;
    case "disputes": return (r.openDisputes ?? 0) > 0;
    case "adjusted": return (r.adjustments ?? 0) > 0;
    case "negative": return (r.score?.totalPoints ?? 0) < 0;
  }
}

/** A linha cumpre os grupos? Grupo vazio não filtra. PURA. */
export function matchesGroups(r: EvalRankingRowLike, g: EvalGroups | undefined): boolean {
  if (!g) return true;
  if (g.city?.length && !g.city.some((c) => (r.cities ?? []).includes(c))) return false;
  if (g.brand?.length && !(r.brand && g.brand.includes(brandKeyOf(r)))) return false;
  if (g.position?.length && !g.position.some((p) => (p === "tl" ? (r.tlDays ?? 0) > 0 : r.position === p))) return false;
  if (g.team?.length && !(r.teamLeader && g.team.includes(String(r.teamLeader.id)))) return false;
  if (g.flags?.length && !g.flags.some((f) => hasFlag(r, f))) return false;
  return true;
}

// ─── Regras sobre as colunas e as métricas ──────────────────────────────────

type Getter = (r: EvalRankingRowLike) => number | null;
const metric = (k: keyof DayMetrics): Getter => (r) => m(r, k);
const perHour = (k: "actionsPerHour" | "weightedPerHour" | "pointsPerHour"): Getter => (r) => {
  const v = r.perHour?.[k];
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
};

/** Campos das regras (os mesmos números do ranking, do CSV e da folha). */
export const EVAL_RULE_FIELDS: { id: string; label: string; get: Getter }[] = [
  { id: "points", label: "Pontos", get: (r) => Number(r.score?.totalPoints ?? 0) || 0 },
  { id: "positivePoints", label: "Pontos ganhos (+)", get: (r) => Number(r.score?.positivePoints ?? 0) || 0 },
  { id: "negativePoints", label: "Pontos perdidos (−)", get: (r) => Number(r.score?.negativePoints ?? 0) || 0 },
  { id: "hours", label: "Horas (ponto)", get: metric("hoursWorked") },
  { id: "days", label: "Dias", get: (r) => Number(r.days ?? 0) || 0 },
  { id: "actions", label: "Ações", get: metric("actions") },
  { id: "recEnt", label: "Recolhas + entregas", get: (r) => m(r, "recolhas") + m(r, "entregas") },
  { id: "recolhas", label: "Recolhas", get: metric("recolhas") },
  { id: "entregas", label: "Entregas", get: metric("entregas") },
  { id: "movements", label: "Movimentos", get: metric("movements") },
  { id: "parkingMoves", label: "Levar ao parque", get: metric("parkingMoves") },
  { id: "spotChanges", label: "Mudanças de lugar", get: metric("spotChanges") },
  { id: "delays", label: "Atrasos", get: metric("delays") },
  { id: "lateServices", label: "Entregas atrasadas", get: metric("lateServices") },
  { id: "speedingEvents", label: "Excessos de velocidade", get: metric("speedingEvents") },
  { id: "complaints", label: "Reclamações", get: metric("complaints") },
  { id: "accidents", label: "Acidentes / danos", get: metric("accidents") },
  { id: "cost", label: "Custo (€)", get: metric("cost") },
  { id: "actionsPerHour", label: "Ações por hora", get: perHour("actionsPerHour") },
  { id: "weightedPerHour", label: "Pontos das ações por hora", get: perHour("weightedPerHour") },
  { id: "pointsPerHour", label: "Pontos por hora", get: perHour("pointsPerHour") },
  { id: "weightedActions", label: "Pontos das ações", get: metric("weightedActions") },
  { id: "cancels", label: "Cancelamentos", get: metric("cancels") },
  { id: "incidentsReported", label: "Ocorrências reportadas", get: metric("incidentsReported") },
  { id: "incidentsAgainst", label: "Ocorrências atribuídas", get: metric("incidentsAgainst") },
  { id: "penaltyPoints", label: "Pontos de penalização (RH)", get: metric("penaltyPoints") },
  { id: "openDisputes", label: "Contestações abertas", get: (r) => Number(r.openDisputes ?? 0) || 0 },
  { id: "tlDays", label: "Dias como TL", get: (r) => Number(r.tlDays ?? 0) || 0 },
];

export const EVAL_RULE_OPS = [
  { id: "gte", label: "≥", arity: 1 },
  { id: "lte", label: "≤", arity: 1 },
  { id: "eq", label: "=", arity: 1 },
  { id: "between", label: "entre", arity: 2 },
  { id: "has", label: "tem", arity: 0 },
  { id: "not_has", label: "não tem", arity: 0 },
] as const;
export type EvalRuleOp = (typeof EVAL_RULE_OPS)[number]["id"];
export interface EvalRule { field: string; op: EvalRuleOp; value?: number | string | null; value2?: number | string | null }
export interface EvalRules { match: "all" | "any"; items: EvalRule[] }

/** "1,5" → 1.5; vazio/lixo → null. PURA. */
export function ruleNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Uma regra sobre uma linha. Regra incompleta (sem valor) ou campo desconhecido → não filtra. PURA. */
export function ruleHolds(r: EvalRankingRowLike, rule: EvalRule): boolean {
  const f = EVAL_RULE_FIELDS.find((x) => x.id === rule.field);
  if (!f) return true;
  const v = f.get(r);
  if (rule.op === "has") return v != null && v !== 0;
  if (rule.op === "not_has") return v == null || v === 0;
  const a = ruleNumber(rule.value);
  if (a == null) return true;
  if (v == null) return false;
  switch (rule.op) {
    case "gte": return v >= a;
    case "lte": return v <= a;
    case "eq": return round2(v) === round2(a);
    case "between": {
      const b = ruleNumber(rule.value2);
      if (b == null) return v >= a;
      return v >= Math.min(a, b) && v <= Math.max(a, b);
    }
  }
}

/** Regras completas (as que filtram de facto). PURA. */
export function usableRules(rules: EvalRules | null | undefined): EvalRule[] {
  return (rules?.items ?? []).filter((x) => EVAL_RULE_FIELDS.some((f) => f.id === x.field)
    && (x.op === "has" || x.op === "not_has" || ruleNumber(x.value) != null));
}

export function matchesRules(r: EvalRankingRowLike, rules: EvalRules | null | undefined): boolean {
  const items = usableRules(rules);
  if (!items.length) return true;
  return rules!.match === "any" ? items.some((x) => ruleHolds(r, x)) : items.every((x) => ruleHolds(r, x));
}

// ─── A vista (o que se filtra, guarda e exporta) ────────────────────────────

export const EVAL_GROUP_BY = [
  { id: "none", label: "Sem grupos" },
  { id: "city", label: "Cidade" },
  { id: "brand", label: "Marca" },
  { id: "position", label: "Posto" },
  { id: "team", label: "Equipa (TL)" },
] as const;
export type EvalGroupBy = (typeof EVAL_GROUP_BY)[number]["id"];

export interface EvalFilterView {
  /** o que se está a escrever na barra: procura no nome e no n.º de agente, na hora (E com o resto) */
  text?: string;
  searches?: EvalSearch[];
  groups?: EvalGroups;
  rules?: EvalRules | null;
}

/**
 * Pesquisas: o mesmo campo junta com OU, campos diferentes com E (como as
 * facetas do Odoo). O texto que se está a escrever (`live`) procura no nome
 * e no n.º de agente, na hora. PURA.
 */
export function matchesSearches(r: EvalRankingRowLike, searches: readonly EvalSearch[] | undefined, live?: string | null): boolean {
  if (live && matchWords(live).length && !matchesSearch(r, { field: "name", text: live })) return false;
  const byField = new Map<EvalSearchField, EvalSearch[]>();
  for (const s of searches ?? []) if (matchWords(s.text).length) byField.set(s.field, [...(byField.get(s.field) ?? []), s]);
  for (const list of byField.values()) if (!list.some((s) => matchesSearch(r, s))) return false;
  return true;
}

/** O ranking filtrado (texto E pesquisas E grupos E regras). Mantém a ordem. PURA. */
export function filterRanking<R extends EvalRankingRowLike>(rows: readonly R[], view: EvalFilterView | null | undefined): R[] {
  return rows.filter((r) => matchesSearches(r, view?.searches, view?.text) && matchesGroups(r, view?.groups) && matchesRules(r, view?.rules));
}

/** Há algum filtro a valer? PURA. */
export function isFilterActive(view: EvalFilterView | null | undefined): boolean {
  if (view?.text && matchWords(view.text).length) return true;
  if ((view?.searches ?? []).some((s) => matchWords(s.text).length)) return true;
  if (Object.values(view?.groups ?? {}).some((v) => Array.isArray(v) && v.length > 0)) return true;
  return usableRules(view?.rules).length > 0;
}

// ─── Totais, grupos e texto do filtro ───────────────────────────────────────

export interface RankingTotals<R> { people: number; hours: number; actions: number; cost: number; points: number; best: R | null }

/** Os cartões do topo (Horas, Ações, Custo, Melhor) sobre as linhas que se veem. PURA. */
export function rankingTotals<R extends EvalRankingRowLike>(rows: readonly R[]): RankingTotals<R> {
  let best: R | null = null;
  for (const r of rows) if (!best || r.score.totalPoints > best.score.totalPoints) best = r;
  return {
    people: rows.length,
    hours: round2(rows.reduce((s, r) => s + m(r, "hoursWorked"), 0)),
    actions: rows.reduce((s, r) => s + m(r, "actions"), 0),
    cost: round2(rows.reduce((s, r) => s + m(r, "cost"), 0)),
    points: round2(rows.reduce((s, r) => s + (Number(r.score.totalPoints) || 0), 0)),
    best,
  };
}

/** Chaves e rótulos de uma linha num "agrupar por" (uma pessoa pode estar em mais de uma cidade). PURA. */
export function groupKeysOf(r: EvalRankingRowLike, by: EvalGroupBy): { key: string; label: string }[] {
  switch (by) {
    case "none": return [{ key: "all", label: "Todos" }];
    case "city": {
      const c = r.cities ?? [];
      // a cidade principal (a 1.ª: mais dias) — cada pessoa só conta uma vez
      return [c.length ? { key: c[0], label: cityLabel(c[0]) } : { key: "", label: "Sem cidade" }];
    }
    case "brand": return [r.brand ? { key: brandKeyOf(r), label: r.brand.name } : { key: "", label: "Sem marca" }];
    case "position": return [{ key: r.position ?? "", label: positionLabel(r.position) }];
    case "team": return [r.teamLeader ? { key: String(r.teamLeader.id), label: r.teamLeader.name } : { key: "", label: "Sem equipa (TL)" }];
  }
}

export interface EvalRowGroup<R> { key: string; label: string; rows: R[]; totals: RankingTotals<R> }

/** Agrupa mantendo a ordem das linhas dentro de cada grupo; grupos por rótulo, "Sem …" no fim. PURA. */
export function groupRanking<R extends EvalRankingRowLike>(rows: readonly R[], by: EvalGroupBy): EvalRowGroup<R>[] {
  const map = new Map<string, { label: string; rows: R[] }>();
  for (const r of rows) {
    const [g] = groupKeysOf(r, by);
    const cur = map.get(g.key) ?? { label: g.label, rows: [] };
    cur.rows.push(r);
    map.set(g.key, cur);
  }
  return Array.from(map.entries())
    .map(([key, v]) => ({ key, label: v.label, rows: v.rows, totals: rankingTotals(v.rows) }))
    .sort((a, b) => (a.key === "" ? 1 : 0) - (b.key === "" ? 1 : 0) || a.label.localeCompare(b.label, "pt"));
}

/** Opções dos grupos a partir das linhas (marcas e equipas existem só no período). PURA. */
export function groupOptions(rows: readonly EvalRankingRowLike[]): Record<keyof EvalGroups, { value: string; label: string; n: number }[]> {
  const count = (pairs: { value: string; label: string }[]) => {
    const map = new Map<string, { value: string; label: string; n: number }>();
    for (const p of pairs) {
      const cur = map.get(p.value) ?? { ...p, n: 0 };
      cur.n += 1;
      map.set(p.value, cur);
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label, "pt"));
  };
  const cities = count(rows.flatMap((r) => (r.cities ?? []).map((c) => ({ value: c, label: cityLabel(c) }))));
  // uma marca = um nome (os nós são por cidade: o Airpark de Lisboa e o do Porto juntam-se)
  const brands = count(rows.flatMap((r) => (r.brand ? [{ value: brandKeyOf(r), label: r.brand.name }] : [])));
  const teams = count(rows.flatMap((r) => (r.teamLeader ? [{ value: String(r.teamLeader.id), label: r.teamLeader.name }] : [])));
  const positions = EVAL_POSITIONS.map((p) => ({ value: p.id as string, label: p.label, n: rows.filter((r) => matchesGroups(r, { position: [p.id] })).length }));
  const flags = EVAL_FLAGS.map((f) => ({ value: f.id as string, label: f.label, n: rows.filter((r) => hasFlag(r, f.id)).length }));
  return { city: cities, brand: brands, position: positions, team: teams, flags };
}

const fmtNumber = (v: unknown) => {
  const n = ruleNumber(v);
  return n == null ? String(v ?? "") : n.toLocaleString("pt-PT", { maximumFractionDigits: 2 });
};

/** "Pontos ≥ 500", "Pontos entre 100 e 200", "Reclamações: tem". PURA. */
export function evalRuleText(r: EvalRule): string {
  const f = EVAL_RULE_FIELDS.find((x) => x.id === r.field);
  const label = f?.label ?? r.field;
  const op = EVAL_RULE_OPS.find((o) => o.id === r.op);
  if (r.op === "has" || r.op === "not_has") return `${label}: ${op?.label ?? r.op}`;
  // "entre" sem o 2.º valor filtra como "≥" (ruleHolds) — e di-lo assim
  if (r.op === "between") return ruleNumber(r.value2) == null ? `${label} ≥ ${fmtNumber(r.value)}` : `${label} entre ${fmtNumber(r.value)} e ${fmtNumber(r.value2)}`;
  return `${label} ${op?.label ?? r.op} ${fmtNumber(r.value)}`;
}

/** Rótulo de um valor de grupo (marcas e equipas pelos nomes nas linhas). PURA. */
export function groupValueLabel(group: keyof EvalGroups, value: string, rows: readonly EvalRankingRowLike[] = []): string {
  switch (group) {
    case "city": return cityLabel(value);
    case "position": return positionLabel(value);
    case "flags": return EVAL_FLAGS.find((f) => f.id === value)?.label ?? value;
    case "brand": return rows.find((r) => r.brand && brandKeyOf(r) === value)?.brand?.name ?? value;
    case "team": return rows.find((r) => String(r.teamLeader?.id) === value)?.teamLeader?.name ?? `TL #${value}`;
  }
}

/** As partes do filtro em texto (chips, CSV e folha). PURA. */
export function filterParts(view: EvalFilterView | null | undefined, rows: readonly EvalRankingRowLike[] = []): string[] {
  const parts: string[] = [];
  if (view?.text && matchWords(view.text).length) parts.push(`Nome ou n.º de agente: «${view.text.trim()}»`);
  for (const s of view?.searches ?? []) {
    if (!matchWords(s.text).length) continue;
    parts.push(`${EVAL_SEARCH_FIELDS.find((f) => f.id === s.field)?.label ?? s.field}: «${s.text.trim()}»`);
  }
  for (const g of EVAL_GROUP_ORDER) {
    const vals = (view?.groups?.[g] ?? []) as string[];
    if (!vals.length) continue;
    parts.push(`${EVAL_GROUP_CHIP_LABELS[g]}: ${vals.map((v) => groupValueLabel(g, v, rows)).join(" ou ")}`);
  }
  const items = usableRules(view?.rules);
  if (items.length) parts.push(items.map(evalRuleText).join(view!.rules!.match === "any" ? " ou " : " e "));
  return parts;
}

/** "Cidade: Porto · Pontos ≥ 500 e Excessos de velocidade ≥ 1" (vazio sem filtro). PURA. */
export function describeFilter(view: EvalFilterView | null | undefined, rows: readonly EvalRankingRowLike[] = []): string {
  return filterParts(view, rows).join(" · ");
}

// ─── Esquemas (filtros guardados e exportação) ──────────────────────────────

/** Limites do filtro (o ecrã não deixa passar; o esquema recusa acima disto). */
export const EVAL_FILTER_LIMITS = { searches: 20, rules: 20 } as const;

const SEARCH_IDS = EVAL_SEARCH_FIELDS.map((f) => f.id) as [EvalSearchField, ...EvalSearchField[]];
const POSITION_IDS = EVAL_POSITIONS.map((p) => p.id) as [EvalPosition, ...EvalPosition[]];
const FLAG_IDS = EVAL_FLAGS.map((f) => f.id) as [EvalFlag, ...EvalFlag[]];
const OP_IDS = EVAL_RULE_OPS.map((o) => o.id) as [EvalRuleOp, ...EvalRuleOp[]];
const GROUP_BY_IDS = EVAL_GROUP_BY.map((g) => g.id) as [EvalGroupBy, ...EvalGroupBy[]];
const list = (max = 60) => z.array(z.string().max(160)).max(max).optional();
const ruleValue = z.union([z.number(), z.string().max(40)]).nullable().optional();

export const evalSearchSchema = z.object({ field: z.enum(SEARCH_IDS), text: z.string().max(200) });
export const evalRuleSchema = z.object({ field: z.string().max(40), op: z.enum(OP_IDS), value: ruleValue, value2: ruleValue });
export const evalGroupsSchema = z.object({
  city: list(), brand: list(), team: list(200),
  position: z.array(z.enum(POSITION_IDS)).max(10).optional(),
  flags: z.array(z.enum(FLAG_IDS)).max(20).optional(),
});
export const evalRulesSchema = z.object({ match: z.enum(["all", "any"]), items: z.array(evalRuleSchema).max(EVAL_FILTER_LIMITS.rules) });
/** O filtro (sem a ordem): é o que a exportação para Sheets aplica. */
export const evalFilterViewSchema = z.object({
  text: z.string().max(200).optional(),
  searches: z.array(evalSearchSchema).max(EVAL_FILTER_LIMITS.searches).optional(),
  groups: evalGroupsSchema.optional(),
  rules: evalRulesSchema.nullable().optional(),
});

const SORT_KEYS = ["points", "pointsPerHour", "actions", "actionsPerHour", "hours", "name", "recEnt", "movs", "delays", "incidents", "weightedPerHour"] as const;
export type EvalSortKey = (typeof SORT_KEYS)[number];
/** O que um filtro guardado da Avaliação guarda: o filtro + agrupar por, vista e ordem. */
export const evalSavedViewSchema = evalFilterViewSchema.extend({
  groupBy: z.enum(GROUP_BY_IDS).optional(),
  view: z.enum(["totals", "perHour"]).optional(),
  sort: z.object({ key: z.enum(SORT_KEYS), dir: z.union([z.literal(1), z.literal(-1)]) }).optional(),
});
export type EvalSavedView = z.infer<typeof evalSavedViewSchema>;
export const EVAL_SAVED_VIEW_MAX_CHARS = 20_000;

/**
 * Filtro guardado lido de volta: o que ainda vale aplica-se, o resto cai e
 * conta-se (como no CRM). Nunca lança — um filtro antigo não parte a página. PURA.
 */
export function sanitizeEvalSavedView(raw: unknown): { view: EvalSavedView; dropped: number } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let dropped = 0;
  const pick = <T,>(schema: z.ZodType<T>, v: unknown): T | undefined => {
    if (v === undefined) return undefined;
    const p = schema.safeParse(v);
    if (p.success) return p.data;
    dropped++;
    return undefined;
  };
  const view: EvalSavedView = {};
  const text = pick(z.string().max(200), o.text);
  if (text?.trim()) view.text = text;
  if (Array.isArray(o.searches)) {
    const searches = o.searches.slice(0, 20).flatMap((s) => {
      const p = evalSearchSchema.safeParse(s);
      if (p.success) return [p.data];
      dropped++;
      return [];
    });
    if (searches.length) view.searches = searches;
  } else if (o.searches !== undefined && o.searches !== null) dropped++;
  const g = (o.groups && typeof o.groups === "object" ? o.groups : {}) as Record<string, unknown>;
  const groups: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(g)) {
    const sch = (evalGroupsSchema.shape as Record<string, z.ZodTypeAny>)[k];
    if (!sch) { dropped++; continue; }
    const p = sch.safeParse(v);
    if (p.success) groups[k] = p.data; else dropped++;
  }
  view.groups = groups as EvalGroups;
  const r = (o.rules && typeof o.rules === "object" ? o.rules : null) as { match?: unknown; items?: unknown } | null;
  if (r) {
    const items = (Array.isArray(r.items) ? r.items : []).slice(0, 20);
    const good = items.flatMap((it) => {
      const p = evalRuleSchema.safeParse(it);
      if (p.success && EVAL_RULE_FIELDS.some((f) => f.id === p.data.field)) return [p.data];
      dropped++;
      return [];
    });
    view.rules = good.length ? { match: r.match === "any" ? "any" : "all", items: good } : null;
  } else view.rules = null;
  view.groupBy = pick(evalSavedViewSchema.shape.groupBy, o.groupBy);
  view.view = pick(evalSavedViewSchema.shape.view, o.view);
  view.sort = pick(evalSavedViewSchema.shape.sort, o.sort);
  return { view, dropped };
}

// ─── CSV do ranking (o que se vê: filtrado e pela ordem do ecrã) ────────────

export const RANKING_CSV_HEADERS = ["Pos", "Colaborador", "Dias", "Horas", "Ações", "Recolhas", "Entregas", "Movimentos", "Levar ao parque", "Atrasos", "Velocidade", "Reclamações", "Acidentes", "Pts+", "Pts−", "Total", "Ações/h", "Pontos/h", "Custo", "Cidade", "Marca", "Equipa (TL)"];

/**
 * CSV (";") das linhas dadas, pela ordem dada. Com filtro, as duas primeiras
 * linhas dizem-no ("Filtro: … (12 de 48 colaboradores)") — sem filtro, o CSV é
 * o de sempre. `rankOf` = posição no ranking do período (sem filtro). PURA.
 */
export function rankingCsv(rows: readonly EvalRankingRowLike[], o: { rankOf: (employeeId: number) => number | undefined; filter?: string | null; total?: number }): string {
  const cell = (v: unknown) => String(v ?? "").replace(/[;\r\n]+/g, ",");
  const lines = rows.map((r) => [
    o.rankOf(r.employeeId), r.employeeName, r.days, m(r, "hoursWorked"), m(r, "actions"), m(r, "recolhas"), m(r, "entregas"),
    m(r, "movements"), m(r, "parkingMoves"), m(r, "delays"), m(r, "speedingEvents"), m(r, "complaints"), m(r, "accidents"),
    r.score.positivePoints ?? "", r.score.negativePoints ?? "", r.score.totalPoints, r.perHour?.actionsPerHour ?? "", r.perHour?.pointsPerHour ?? "", m(r, "cost"),
    (r.cities ?? []).map(cityLabel).join(", "), r.brand?.name ?? "", r.teamLeader?.name ?? "",
  ].map(cell).join(";"));
  const head = o.filter ? [cell(`Filtro: ${o.filter} (${rows.length} de ${o.total ?? rows.length} colaboradores)`), ""] : [];
  return [...head, RANKING_CSV_HEADERS.join(";"), ...lines].join("\n");
}

/**
 * Pesquisa de uma pessoa nas outras abas da Avaliação (Dia, Contestações):
 * a mesma regra do ranking (nome, agente…; cada palavra tem de aparecer). PURA.
 */
export function personMatches(parts: ReadonlyArray<string | null | undefined>, query: string | null | undefined): boolean {
  return partsMatch(parts, query);
}
