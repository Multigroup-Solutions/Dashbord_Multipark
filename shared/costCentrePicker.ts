/**
 * Centro de custos na Nova Despesa (Jorge, 14 out 2026): ao abrir, primeiro e
 * fixos os 5 do dia a dia — Multipark (grupo), Lisboa, Porto, Faro e
 * Marketplace; por baixo, a árvore toda (cidades → marcas → parques/projetos)
 * com setas para abrir, como nos Projetos. A pesquisa procura na árvore toda.
 *
 * O Marketplace é uma MARCA dentro de cada cidade (não há um nó nacional): se
 * houver um só, aparece "Marketplace"; se houver vários ao mesmo nível,
 * aparece um por cidade ("Marketplace · Lisboa", …). Os nós desativados não
 * aparecem (salvo o que já está escolhido, ao editar). PURAS.
 */
import { matchKey, textMatches } from "./textKey";

export interface CostCentreNode {
  id: number;
  name: string;
  level?: string | null;
  parentId?: number | null;
  isActive?: boolean | number | null;
}

/** Os fixos, por esta ordem. */
export const PINNED_COST_CENTRE_NAMES = ["Multipark", "Lisboa", "Porto", "Faro", "Marketplace"] as const;
const CITY_ORDER = ["lisboa", "porto", "faro"];

const isActive = (n: CostCentreNode) => (n.isActive === undefined || n.isActive === null ? true : !!n.isActive);
const byName = (a: CostCentreNode, b: CostCentreNode) => a.name.localeCompare(b.name, "pt", { sensitivity: "base" }) || a.id - b.id;

/** Nós que se podem escolher: ativos + o já escolhido (ao editar). */
export function selectableCostCentres<T extends CostCentreNode>(nodes: ReadonlyArray<T>, selectedId?: number | null): T[] {
  return nodes.filter((n) => isActive(n) || n.id === selectedId);
}

function childrenMap<T extends CostCentreNode>(nodes: ReadonlyArray<T>): { roots: T[]; kids: Map<number, T[]> } {
  const ids = new Set(nodes.map((n) => n.id));
  const kids = new Map<number, T[]>();
  const roots: T[] = [];
  for (const n of nodes) {
    if (n.parentId != null && ids.has(n.parentId) && n.parentId !== n.id) {
      if (!kids.has(n.parentId)) kids.set(n.parentId, []);
      kids.get(n.parentId)!.push(n);
    } else roots.push(n);
  }
  roots.sort(byName);
  for (const arr of kids.values()) arr.sort(byName);
  return { roots, kids };
}

/** Profundidade de cada nó (raiz = 0); ciclos/órfãos contam como raiz. */
export function costCentreDepths(nodes: ReadonlyArray<CostCentreNode>): Map<number, number> {
  const { roots, kids } = childrenMap(nodes);
  const depth = new Map<number, number>();
  const walk = (n: CostCentreNode, d: number) => {
    if (depth.has(n.id)) return;
    depth.set(n.id, d);
    for (const c of kids.get(n.id) ?? []) walk(c, d + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0);
  return depth;
}

/** "Lisboa › Airpark › Airpark Lisboa" (sem o grupo de topo, que é o de todos). */
export function costCentrePath(node: CostCentreNode, nodes: ReadonlyArray<CostCentreNode>): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parts: string[] = [];
  const seen = new Set<number>();
  let cur: CostCentreNode | undefined = node;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
  }
  if (parts.length > 1 && byId.get(firstAncestorId(node, byId))?.level === "group") parts.shift();
  return parts.join(" › ");
}

function firstAncestorId(node: CostCentreNode, byId: Map<number, CostCentreNode>): number {
  let cur: CostCentreNode = node;
  const seen = new Set<number>();
  while (cur.parentId != null && byId.has(cur.parentId) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parentId)!;
  }
  return cur.id;
}

export interface PinnedCostCentre { id: number; label: string; level: string | null }

/** Os fixos do topo (só os que existem e o utilizador vê). PURA. */
export function pinnedCostCentres(all: ReadonlyArray<CostCentreNode>): PinnedCostCentre[] {
  const nodes = all.filter(isActive);
  const depth = costCentreDepths(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: PinnedCostCentre[] = [];
  const push = (n: CostCentreNode | undefined, label?: string) => {
    if (n && !out.some((p) => p.id === n.id)) out.push({ id: n.id, label: label ?? n.name, level: n.level ?? null });
  };
  const named = (key: string) => nodes.filter((n) => matchKey(n.name) === key);
  const best = (list: CostCentreNode[], level: string) =>
    [...list].sort((a, b) => (a.level === level ? 0 : 1) - (b.level === level ? 0 : 1) || (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || a.id - b.id)[0];

  // Multipark: o grupo com esse nome; senão o primeiro grupo de topo
  push(best(named("multipark"), "group") ?? [...nodes].filter((n) => n.level === "group").sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || a.id - b.id)[0]);
  for (const city of CITY_ORDER) push(best(named(city), "city"));

  const mk = named("marketplace");
  if (mk.length) {
    const minD = Math.min(...mk.map((n) => depth.get(n.id) ?? 0));
    const top = mk.filter((n) => (depth.get(n.id) ?? 0) === minD);
    if (top.length === 1) push(top[0], "Marketplace");
    else {
      const parentName = (n: CostCentreNode) => (n.parentId != null ? byId.get(n.parentId)?.name ?? "" : "");
      const rank = (n: CostCentreNode) => { const i = CITY_ORDER.indexOf(matchKey(parentName(n))); return i < 0 ? CITY_ORDER.length : i; };
      top.sort((a, b) => rank(a) - rank(b) || parentName(a).localeCompare(parentName(b), "pt") || a.id - b.id)
        .forEach((n) => push(n, parentName(n) ? `Marketplace · ${parentName(n)}` : "Marketplace"));
    }
  }
  return out;
}

/** Abertos por omissão na árvore: o grupo e as cidades (mostram as marcas). PURA. */
export function defaultExpandedCostCentres(nodes: ReadonlyArray<CostCentreNode>): Set<number> {
  return new Set(nodes.filter((n) => n.level === "group" || n.level === "city").map((n) => n.id));
}

export interface CostCentreTreeRow<T extends CostCentreNode = CostCentreNode> { node: T; depth: number; hasChildren: boolean; open: boolean }

/** Linhas visíveis da árvore (pai antes dos filhos, por nome), dado o que está aberto. PURA. */
export function costCentreTreeRows<T extends CostCentreNode>(nodes: ReadonlyArray<T>, expanded: ReadonlySet<number>): CostCentreTreeRow<T>[] {
  const { roots, kids } = childrenMap(nodes);
  const out: CostCentreTreeRow<T>[] = [];
  const seen = new Set<number>();
  const walk = (n: T, d: number) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    const children = kids.get(n.id) ?? [];
    const open = expanded.has(n.id);
    out.push({ node: n, depth: d, hasChildren: children.length > 0, open });
    if (open) for (const c of children) walk(c, d + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** Pesquisa na árvore toda (nome ou caminho; sem acentos nem maiúsculas), pela ordem da árvore. PURA. */
export function searchCostCentres<T extends CostCentreNode>(nodes: ReadonlyArray<T>, query: string): Array<{ node: T; path: string }> {
  if (!query.trim()) return [];
  const all = new Set(nodes.map((n) => n.id));
  const rows = costCentreTreeRows(nodes, all);
  return rows
    .map((r) => ({ node: r.node, path: costCentrePath(r.node, nodes) }))
    .filter((r) => textMatches(`${r.path} ${r.node.name}`, query));
}
