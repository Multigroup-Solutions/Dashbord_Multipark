/**
 * Árvore de Projetos (Grupo → Cidade → Marca → Projeto/parque) — regras
 * PURAS partilhadas entre servidor e cliente. Nada aqui toca na BD.
 *
 * - normalização e matcher de nomes de parque (sync de reservas + backfill);
 * - regras de nível/pai (criar/atualizar/mover);
 * - deteção de ciclos, órfãos e nomes duplicados;
 * - plano de nós em falta (PARK_CONFIGS sem nó correspondente);
 * - guarda de referências antes de desativar/apagar.
 */
import { CITY_LABELS, matchCityKey, type CityKey } from "./city";

export type ProjectLevel = "group" | "city" | "brand" | "project";

export interface ProjectTreeNode {
  id: number;
  name: string;
  level: string;
  parentId: number | null;
  isActive?: boolean | number | null;
}

export const isNodeActive = (n: Pick<ProjectTreeNode, "isActive">): boolean =>
  n.isActive === undefined || n.isActive === null ? true : !!n.isActive;

// ─── Nomes de parque ─────────────────────────────────────────────────────────

const CITY_WORDS = new Set(["lisboa", "lisbon", "porto", "oporto", "faro"]);

/** minúsculas, sem acentos; hífens, &, pontuação e espaços múltiplos → 1 espaço. */
export function normalizeParkName(raw: string | null | undefined): string {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Chave de comparação do parque SEM a cidade e sem espaços:
 * "Top-Parking Lisboa" = "top parking" = "TopParking" → "topparking". */
export function parkKey(raw: string | null | undefined): string {
  return normalizeParkName(raw).split(" ").filter(w => w && !CITY_WORDS.has(w)).join("");
}

/** Cidade (chave) de um nó — sobe até ao nó level='city'. Seguro com ciclos. */
export function cityKeyOfNode(id: number, byId: Map<number, ProjectTreeNode>): CityKey | null {
  const seen = new Set<number>();
  let node = byId.get(id);
  while (node && !seen.has(node.id)) {
    if (node.level === "city") return matchCityKey(node.name);
    seen.add(node.id);
    node = node.parentId == null ? undefined : byId.get(node.parentId);
  }
  return null;
}

export interface KnownPark { name: string; city: string; closed?: boolean }

/**
 * Matcher DETERMINÍSTICO reserva → nó de projeto (parque).
 * - só nós level='project' ATIVOS (atribuições novas nunca vão para nós fechados);
 * - cidade obrigatória (da coluna city ou do próprio parkName) — sem cidade
 *   não há match (nunca cai num nó de marca/cidade qualquer);
 * - compara nomes normalizados (acentos, hífens, &, espaços);
 * - desempate: nome exato do PARK_CONFIGS + cidade → nome igual ao da
 *   reserva → id mais baixo.
 */
export function createParkMatcher(nodes: ProjectTreeNode[], knownParks: KnownPark[] = []) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const index = new Map<string, ProjectTreeNode[]>(); // `${city}|${parkKey}` → nós
  for (const n of nodes) {
    if (n.level !== "project" || !isNodeActive(n)) continue;
    const city = cityKeyOfNode(n.id, byId);
    if (!city) continue;
    const ownCity = matchCityKey(n.name);
    if (ownCity && ownCity !== city) continue; // "Airpark Porto" pendurado em Lisboa: ambíguo, ignora
    const key = parkKey(n.name);
    if (!key) continue;
    const k = `${city}|${key}`;
    if (!index.has(k)) index.set(k, []);
    index.get(k)!.push(n);
  }
  for (const list of Array.from(index.values())) list.sort((a, b) => a.id - b.id);

  return (input: { parkName?: string | null; city?: string | null }): number | undefined => {
    if (!input.parkName) return undefined;
    const city = matchCityKey(input.city) ?? matchCityKey(input.parkName);
    if (!city) return undefined;
    const key = parkKey(input.parkName);
    if (!key) return undefined;
    const candidates = index.get(`${city}|${key}`);
    if (!candidates?.length) return undefined;
    if (candidates.length === 1) return candidates[0].id;
    const config = knownParks.find(p => matchCityKey(p.city) === city && parkKey(p.name) === key);
    const wanted = [
      config ? normalizeParkName(`${config.name} ${CITY_LABELS[city]}`) : null,
      normalizeParkName(`${input.parkName} ${matchCityKey(input.parkName) ? "" : CITY_LABELS[city]}`),
    ].filter(Boolean) as string[];
    for (const w of wanted) {
      const hit = candidates.find(c => normalizeParkName(c.name) === w);
      if (hit) return hit.id;
    }
    return candidates[0].id;
  };
}

export function findParkProjectId(
  input: { parkName?: string | null; city?: string | null },
  nodes: ProjectTreeNode[],
  knownParks: KnownPark[] = [],
): number | undefined {
  return createParkMatcher(nodes, knownParks)(input);
}

// ─── Regras de nível / pai ───────────────────────────────────────────────────

export const LEVEL_ORDER: ProjectLevel[] = ["group", "city", "brand", "project"];
export const CHILD_LEVEL: Record<string, ProjectLevel | undefined> = { group: "city", city: "brand", brand: "project" };

/** Níveis que um filho pode ter debaixo de um pai deste nível. Um projeto pode
 * ficar diretamente na cidade (exceção histórica do seed: "Lispark Lisboa",
 * "Top-Parking Lisboa"). */
export function allowedChildLevels(parentLevel: string | null): ProjectLevel[] {
  if (parentLevel === null) return ["group"];
  if (parentLevel === "group") return ["city"];
  if (parentLevel === "city") return ["brand", "project"];
  if (parentLevel === "brand") return ["project"];
  return [];
}

/** Devolve a mensagem de erro (PT-PT) ou null se a colocação é válida. */
export function validatePlacement(level: string, parent: ProjectTreeNode | null | undefined, parentIdRequested: number | null): string | null {
  if (parentIdRequested !== null && !parent) return "O nó pai não existe.";
  const allowed = allowedChildLevels(parent ? parent.level : null);
  if (allowed.includes(level as ProjectLevel)) return null;
  const labels: Record<string, string> = { group: "Grupo", city: "Cidade", brand: "Marca", project: "Projeto" };
  if (!parent) return `Um nó de nível ${labels[level] ?? level} tem de ter um pai.`;
  return `Um nó de nível ${labels[level] ?? level} não pode ficar dentro de ${labels[parent.level] ?? parent.level}.`
    + (allowed.length ? ` Permitido: ${allowed.map(l => labels[l]).join(" ou ")}.` : "");
}

/** true se pôr `id` debaixo de `newParentId` cria um ciclo. Termina sempre,
 * mesmo que a BD já tenha um ciclo (conjunto de visitados). */
export function wouldCreateCycle(id: number, newParentId: number | null, byId: Map<number, ProjectTreeNode>): boolean {
  if (newParentId === null) return false;
  const seen = new Set<number>();
  let cur: number | null = newParentId;
  while (cur !== null) {
    if (cur === id) return true;
    if (seen.has(cur)) return true; // ciclo pré-existente acima do destino: recusa
    seen.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}

/** Nome já usado por um irmão (case-insensitive, espaços aparados)? */
export function siblingNameConflict(name: string, parentId: number | null, nodes: ProjectTreeNode[], excludeId?: number): ProjectTreeNode | undefined {
  const n = name.trim().toLowerCase();
  return nodes.find(p => p.id !== excludeId && (p.parentId ?? null) === (parentId ?? null) && p.name.trim().toLowerCase() === n);
}

/** Grupos de irmãos com o mesmo nome (diagnóstico — dados antigos). */
export function duplicateSiblingNames(nodes: ProjectTreeNode[]): Array<{ parentId: number | null; name: string; ids: number[] }> {
  const groups = new Map<string, { parentId: number | null; name: string; ids: number[] }>();
  for (const p of nodes) {
    const k = `${p.parentId ?? "root"}|${p.name.trim().toLowerCase()}`;
    const g = groups.get(k) ?? { parentId: p.parentId ?? null, name: p.name.trim(), ids: [] };
    g.ids.push(p.id);
    groups.set(k, g);
  }
  return Array.from(groups.values()).filter(g => g.ids.length > 1);
}

/** Nós cujo parentId aponta para um nó que não existe. */
export function findOrphans<T extends ProjectTreeNode>(nodes: T[]): T[] {
  const ids = new Set(nodes.map(n => n.id));
  return nodes.filter(n => n.parentId != null && !ids.has(n.parentId));
}

/** Nós que estão num ciclo (nunca chegam à raiz). */
export function nodesInCycles(nodes: ProjectTreeNode[]): number[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const out: number[] = [];
  for (const n of nodes) {
    const seen = new Set<number>();
    let cur: ProjectTreeNode | undefined = n;
    while (cur && cur.parentId != null && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.parentId); }
    if (cur && seen.has(cur.id) && cur.id === n.id) out.push(n.id);
  }
  return out;
}

/**
 * Floresta visível: raízes são os nós cujo pai NÃO está na lista (não só
 * parentId=null) — um admin de cidade vê a sua cidade como raiz. Seguro com
 * ciclos (cada nó aparece no máximo uma vez).
 */
export function buildForest<T extends ProjectTreeNode>(nodes: T[]): Array<T & { children: any[] }> {
  const ids = new Set(nodes.map(n => n.id));
  const kids = new Map<number, T[]>();
  for (const n of nodes) {
    if (n.parentId != null && ids.has(n.parentId)) {
      if (!kids.has(n.parentId)) kids.set(n.parentId, []);
      kids.get(n.parentId)!.push(n);
    }
  }
  const placed = new Set<number>();
  const build = (n: T): T & { children: any[] } => {
    placed.add(n.id);
    return { ...n, children: (kids.get(n.id) ?? []).filter(c => !placed.has(c.id)).map(build) };
  };
  const roots = nodes.filter(n => n.parentId == null || !ids.has(n.parentId)).map(build);
  // Nós presos num ciclo nunca são alcançados a partir de uma raiz: mostra-os à parte.
  for (const n of nodes) if (!placed.has(n.id)) roots.push(build(n));
  return roots;
}

// ─── Parques em falta (PARK_CONFIGS sem nó) ─────────────────────────────────

/** Marcas próprias: o parque fica debaixo do nó de marca com o mesmo nome. */
export const OWN_BRANDS = ["Airpark", "Redpark", "Skypark"];
/** Parques de marketplace: ficam debaixo do nó "Marketplace" da cidade. */
export const MARKETPLACE_PARKS = ["Boardingpark", "Parkdirect", "Premium Park", "Readypark", "Stop & Fly Park", "Travelparking", "Viagensparking", "Top Parking"];
export const MARKETPLACE_BRAND = "Marketplace";

export interface MissingParkPlan {
  park: string;
  city: CityKey;
  cityNodeId: number;
  brandName: string;
  /** Nó de marca existente (ativo), ou null se tem de ser criado. */
  brandNodeId: number | null;
  projectName: string;
}

export interface ParkCoverageRow { park: string; city: string; closed: boolean; projectId: number | null; projectName: string | null }

export function parkCoverageRows(nodes: ProjectTreeNode[], parks: KnownPark[]): ParkCoverageRow[] {
  const match = createParkMatcher(nodes, parks);
  const byId = new Map(nodes.map(n => [n.id, n]));
  return parks.map(p => {
    const id = match({ parkName: p.name, city: p.city }) ?? null;
    return { park: p.name, city: p.city, closed: !!p.closed, projectId: id, projectName: id ? byId.get(id)?.name ?? null : null };
  });
}

/**
 * Plano idempotente: para cada parque ativo do PARK_CONFIGS sem nó, onde o
 * criar. Parques fechados não são criados. Parques cuja cidade não tem nó
 * level='city' ativo ficam em `skipped`.
 */
export function planMissingParkNodes(nodes: ProjectTreeNode[], parks: KnownPark[]): { plan: MissingParkPlan[]; skipped: Array<{ park: string; city: string; reason: string }> } {
  const plan: MissingParkPlan[] = [];
  const skipped: Array<{ park: string; city: string; reason: string }> = [];
  const coverage = parkCoverageRows(nodes, parks);
  const active = nodes.filter(isNodeActive);
  for (const row of coverage) {
    if (row.projectId) continue;
    if (row.closed) { skipped.push({ park: row.park, city: row.city, reason: "Parque fechado" }); continue; }
    const city = matchCityKey(row.city);
    const cityNode = city ? active.filter(n => n.level === "city" && matchCityKey(n.name) === city).sort((a, b) => a.id - b.id)[0] : undefined;
    if (!city || !cityNode) { skipped.push({ park: row.park, city: row.city, reason: "Cidade sem nó na árvore" }); continue; }
    const own = OWN_BRANDS.find(b => parkKey(b) === parkKey(row.park));
    const brandName = own ?? MARKETPLACE_BRAND;
    const brandNode = active
      .filter(n => n.level === "brand" && n.parentId === cityNode.id && parkKey(n.name) === parkKey(brandName))
      .sort((a, b) => a.id - b.id)[0];
    plan.push({ park: row.park, city, cityNodeId: cityNode.id, brandName, brandNodeId: brandNode?.id ?? null,
      projectName: `${row.park} ${CITY_LABELS[city]}` });
  }
  return { plan, skipped };
}

// ─── Referências antes de desativar / apagar ─────────────────────────────────

/** Tabelas que apontam para projects.id. `config` = configuração viva (tem de
 * ser movida antes de desativar); as restantes são histórico. */
export const PROJECT_REFERENCE_TABLES: Array<{ table: string; label: string; config?: boolean }> = [
  { table: "employees", label: "Colaboradores (centro de custos)", config: true },
  { table: "project_employees", label: "Colaboradores atribuídos", config: true },
  { table: "google_business_locations", label: "Locais Google Business", config: true },
  { table: "ad_accounts", label: "Contas de anúncios", config: true },
  { table: "ad_campaigns", label: "Campanhas de anúncios (mapeamento)", config: true },
  { table: "project_geofence", label: "Raio de picagem", config: true },
  { table: "expenses", label: "Despesas" },
  { table: "recurring_expenses", label: "Despesas recorrentes", config: true },
  { table: "expense_budgets", label: "Orçamentos de despesas", config: true },
  { table: "multipark_bookings", label: "Reservas" },
  { table: "google_reviews", label: "Reviews" },
  { table: "campaigns", label: "Campanhas de marketing" },
  { table: "internal_campaigns", label: "Campanhas internas" },
  { table: "marketing_expenses", label: "Despesas de marketing" },
  { table: "complaints", label: "Reclamações" },
  { table: "tasks", label: "Tarefas" },
  { table: "vehicles", label: "Veículos" },
  { table: "services", label: "Serviços" },
  { table: "invoices", label: "Faturas" },
  { table: "lost_found_items", label: "Perdidos e achados" },
  { table: "annual_reports", label: "Relatórios anuais" },
  { table: "incidents", label: "Incidentes" },
  { table: "partnership_transactions", label: "Transações de parceiros" },
  { table: "extra_leads", label: "Leads de extras" },
];

export interface ReferenceCount { table: string; label: string; count: number; config: boolean }

export interface DeleteCheck { canDeactivate: boolean; canHardDelete: boolean; reasons: string[] }

/**
 * Regras:
 * - DESATIVAR (soft delete, isActive=0): recusa com filhos ativos ou com
 *   configuração viva a apontar para o nó (colaboradores, locais Google,
 *   mapeamentos de anúncios, raio de picagem…). Histórico (despesas,
 *   reservas, reviews…) não impede — continua a contar nos relatórios.
 * - APAGAR DEFINITIVAMENTE: só sem filhos (ativos ou não) e com ZERO referências.
 */
export function evaluateDelete(input: { activeChildren: number; totalChildren: number; references: ReferenceCount[] }): DeleteCheck {
  const reasons: string[] = [];
  const configRefs = input.references.filter(r => r.config && r.count > 0);
  const anyRefs = input.references.filter(r => r.count > 0);
  if (input.activeChildren > 0) reasons.push(`Tem ${input.activeChildren} sub-nó(s) ativo(s) — desativa-os ou move-os primeiro.`);
  for (const r of configRefs) reasons.push(`${r.label}: ${r.count}`);
  const canDeactivate = input.activeChildren === 0 && configRefs.length === 0;
  const canHardDelete = input.totalChildren === 0 && anyRefs.length === 0;
  return { canDeactivate, canHardDelete, reasons };
}
