/**
 * Disponibilidade (hub de gestão) — estado de resposta e agrupamento por
 * cidade da tabela de extras.
 *
 * Pedido do Jorge (set 2026): a tabela mostrava toda a gente de uma vez ao
 * fazer scroll. Agora os extras aparecem em secções por cidade (fechadas,
 * menos a mais relevante), com filtro por estado e "mostrar mais". Estas
 * regras são puras e partilhadas para poderem ser testadas sem browser.
 */

import { CITY_KEYS, type CityKey } from "./city";

/**
 * Estado de um extra na semana:
 *   - `available`   → respondeu e marcou pelo menos um dia;
 *   - `unavailable` → respondeu mas sem nenhum dia (disse que não pode);
 *   - `no_answer`   → ainda não respondeu.
 */
export type AvailabilityStatus = "available" | "unavailable" | "no_answer";
export type AvailabilityStatusFilter = AvailabilityStatus | "all";

export const AVAILABILITY_STATUS_LABELS: Record<AvailabilityStatus, string> = {
  available: "Disponíveis",
  unavailable: "Indisponíveis",
  no_answer: "Sem resposta",
};

export function availabilityStatus(e: { responded: boolean; availableDays: number }): AvailabilityStatus {
  if (!e.responded) return "no_answer";
  return e.availableDays > 0 ? "available" : "unavailable";
}

export function matchesAvailabilityStatus(
  e: { responded: boolean; availableDays: number },
  filter: AvailabilityStatusFilter,
): boolean {
  return filter === "all" || availabilityStatus(e) === filter;
}

export function countAvailabilityStatuses(
  rows: { responded: boolean; availableDays: number }[],
): Record<AvailabilityStatusFilter, number> {
  const out: Record<AvailabilityStatusFilter, number> = { all: rows.length, available: 0, unavailable: 0, no_answer: 0 };
  for (const r of rows) out[availabilityStatus(r)]++;
  return out;
}

export type CityGroupKey = CityKey | "none";
export const CITY_GROUP_ORDER: CityGroupKey[] = [...CITY_KEYS, "none"];

export interface CityGroup<T> {
  key: CityGroupKey;
  rows: T[];
}

/**
 * Agrupa por cidade mantendo a ORDEM de entrada dentro de cada grupo (a
 * ordenação da tabela continua a valer). Grupos vazios não aparecem; a ordem
 * dos grupos é fixa: Lisboa, Porto, Faro, Sem cidade.
 */
export function groupByCity<T extends { city: CityKey | null }>(rows: T[]): CityGroup<T>[] {
  const buckets = new Map<CityGroupKey, T[]>();
  for (const r of rows) {
    const key: CityGroupKey = r.city ?? "none";
    const list = buckets.get(key);
    if (list) list.push(r);
    else buckets.set(key, [r]);
  }
  return CITY_GROUP_ORDER.filter((k) => buckets.has(k)).map((key) => ({ key, rows: buckets.get(key)! }));
}

/**
 * Secções abertas por defeito: só a mais relevante — a cidade escolhida no
 * filtro (se tiver gente), senão a maior. Com uma pesquisa ativa os
 * resultados são poucos e abrem-se todas as secções.
 */
export function defaultOpenGroups(
  groups: { key: CityGroupKey; rows: unknown[] }[],
  opts: { preferred?: CityGroupKey | null; searching?: boolean } = {},
): Set<CityGroupKey> {
  if (opts.searching) return new Set(groups.map((g) => g.key));
  const preferred = opts.preferred ? groups.find((g) => g.key === opts.preferred) : undefined;
  if (preferred) return new Set([preferred.key]);
  let best: { key: CityGroupKey; rows: unknown[] } | undefined;
  for (const g of groups) if (!best || g.rows.length > best.rows.length) best = g;
  return new Set(best ? [best.key] : []);
}

/** Tamanho de cada "página" das secções ("Mostrar mais"). */
export const AVAILABILITY_PAGE_SIZE = 25;

/** Linhas visíveis de uma secção com `shown` já pedidas (nunca negativo). */
export function visibleSlice<T>(rows: T[], shown: number): { visible: T[]; remaining: number } {
  const n = Math.max(0, Math.min(rows.length, Math.trunc(shown)));
  return { visible: rows.slice(0, n), remaining: rows.length - n };
}
