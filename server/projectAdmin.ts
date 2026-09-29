/**
 * Administração da árvore de Projetos com acesso à BD: cobertura de parques,
 * criação idempotente dos nós em falta, backfill de reservas sem projeto,
 * contagem de referências antes de desativar/apagar e diagnóstico (órfãos,
 * ciclos, nomes duplicados). As regras puras vivem em shared/projectTree.ts.
 */
import { sql } from "drizzle-orm";
import { projects } from "../drizzle/schema";
import { getDb } from "./db";
import { PARK_CONFIGS } from "./multipark";
import {
  PROJECT_REFERENCE_TABLES, createParkMatcher, duplicateSiblingNames, findOrphans, isNodeActive,
  nodesInCycles, parkCoverageRows, planMissingParkNodes, type ProjectTreeNode, type ReferenceCount,
} from "../shared/projectTree";

const rowsOf = (r: any) => (Array.isArray(r?.[0]) ? r[0] : r) as any[];

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("BD indisponível");
  return db;
}

export async function loadProjectNodes(): Promise<Array<ProjectTreeNode & { color: string | null }>> {
  const db = await requireDb();
  return db.select({ id: projects.id, name: projects.name, level: projects.level, parentId: projects.parentId,
    isActive: projects.isActive, color: projects.color }).from(projects);
}

const knownParks = () => PARK_CONFIGS.map(p => ({ name: p.name, city: p.city, closed: !!p.closed }));

/** Contagem de referências a um nó. Tabelas que ainda não existem contam 0. */
export async function countProjectReferences(projectId: number): Promise<ReferenceCount[]> {
  const db = await requireDb();
  return Promise.all(PROJECT_REFERENCE_TABLES.map(async t => {
    let count = 0;
    try {
      const r = rowsOf(await db.execute(sql`SELECT COUNT(*) AS n FROM ${sql.identifier(t.table)} WHERE projectId = ${projectId}`));
      count = Number(r[0]?.n ?? 0);
    } catch { /* tabela inexistente neste ambiente */ }
    return { table: t.table, label: t.label, count, config: !!t.config };
  }));
}

/** Reservas sem projeto, agrupadas por parque/cidade, com o que o matcher faria. */
async function nullBookingGroups(nodes: ProjectTreeNode[]) {
  const db = await requireDb();
  const rows = rowsOf(await db.execute(sql`
    SELECT parkName, city, COUNT(*) AS n FROM multipark_bookings
    WHERE projectId IS NULL GROUP BY parkName, city ORDER BY n DESC`));
  const match = createParkMatcher(nodes, knownParks());
  const byId = new Map(nodes.map(n => [n.id, n]));
  return rows.map(r => {
    const id = match({ parkName: r.parkName, city: r.city });
    return { parkName: r.parkName as string | null, city: r.city as string | null, count: Number(r.n),
      wouldMatch: id != null && id > 0 ? byId.get(id)?.name ?? null : id != null ? "(nó a criar)" : null };
  });
}

/** Nós virtuais (ids negativos) para simular o estado depois de criar os nós em falta. */
function simulateWithPlan(nodes: ProjectTreeNode[]): ProjectTreeNode[] {
  const { plan } = planMissingParkNodes(nodes, knownParks());
  const sim = [...nodes];
  let fake = -1;
  const brandIds = new Map<string, number>();
  for (const p of plan) {
    let brandId = p.brandNodeId;
    if (brandId == null) {
      const k = `${p.cityNodeId}|${p.brandName}`;
      if (!brandIds.has(k)) { brandIds.set(k, fake); sim.push({ id: fake--, name: p.brandName, level: "brand", parentId: p.cityNodeId, isActive: 1 }); }
      brandId = brandIds.get(k)!;
    }
    sim.push({ id: fake--, name: p.projectName, level: "project", parentId: brandId, isActive: 1 });
  }
  return sim;
}

export async function getParkCoverage() {
  const nodes = await loadProjectNodes();
  const parks = parkCoverageRows(nodes, knownParks());
  const { plan, skipped } = planMissingParkNodes(nodes, knownParks());
  const groups = await nullBookingGroups(simulateWithPlan(nodes));
  const nullTotal = groups.reduce((s, g) => s + g.count, 0);
  const matchableNow = await nullBookingGroups(nodes).then(gs => gs.filter(g => g.wouldMatch).reduce((s, g) => s + g.count, 0));
  const matchableAfter = groups.filter(g => g.wouldMatch).reduce((s, g) => s + g.count, 0);
  const byId = new Map(nodes.map(n => [n.id, n]));
  return {
    parks,
    missing: parks.filter(p => !p.projectId && !p.closed).length,
    plan: plan.map(p => ({ ...p, brandExists: p.brandNodeId != null, cityName: byId.get(p.cityNodeId)?.name ?? p.city })),
    skipped,
    nullBookings: { total: nullTotal, matchableNow, matchableAfter, groups: groups.slice(0, 50) },
    diagnostics: {
      orphans: findOrphans(nodes).map(n => ({ id: n.id, name: n.name, level: n.level, parentId: n.parentId, isActive: isNodeActive(n) })),
      cycles: nodesInCycles(nodes),
      duplicates: duplicateSiblingNames(nodes).map(d => ({ ...d, parentName: d.parentId != null ? byId.get(d.parentId)?.name ?? null : null })),
    },
  };
}

/**
 * Backfill de reservas → projeto com o matcher determinístico.
 * `includeIntermediate`: também re-arquiva reservas presas num nó que não é
 * level='project' (fallback antigo do sync). Idempotente.
 */
export async function backfillBookingProjects(opts: { includeIntermediate?: boolean } = {}) {
  const db = await requireDb();
  const nodes = await loadProjectNodes();
  const match = createParkMatcher(nodes, knownParks());
  const pending = rowsOf(await db.execute(opts.includeIntermediate
    ? sql`SELECT id, parkName, city FROM multipark_bookings
        WHERE parkName IS NOT NULL AND parkName <> ''
          AND (projectId IS NULL OR projectId IN (SELECT id FROM projects WHERE level <> 'project'))`
    : sql`SELECT id, parkName, city FROM multipark_bookings
        WHERE parkName IS NOT NULL AND parkName <> '' AND projectId IS NULL`));
  const byProject = new Map<number, number[]>();
  const unmatchedNames = new Map<string, number>();
  let unmatched = 0;
  for (const b of pending) {
    const pid = match({ parkName: b.parkName, city: b.city });
    if (pid) {
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid)!.push(Number(b.id));
    } else {
      unmatched++;
      const k = `${b.parkName}${b.city ? ` (${b.city})` : ""}`;
      unmatchedNames.set(k, (unmatchedNames.get(k) ?? 0) + 1);
    }
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  const updated: Array<{ projectId: number; project: string; bookings: number }> = [];
  for (const [pid, ids] of Array.from(byProject.entries())) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await db.execute(sql`UPDATE multipark_bookings SET projectId = ${pid}
        WHERE id IN (${sql.join(chunk.map(v => sql`${v}`), sql`, `)})`);
    }
    updated.push({ projectId: pid, project: byId.get(pid)?.name ?? String(pid), bookings: ids.length });
  }
  updated.sort((a, b) => b.bookings - a.bookings);
  return {
    pending: pending.length,
    matched: pending.length - unmatched,
    unmatched,
    unmatchedTop: Array.from(unmatchedNames.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, n]) => ({ name, bookings: n })),
    updated,
  };
}

/** Cria (idempotente) os nós de parque em falta e corre o backfill das reservas sem projeto. */
export async function createMissingParkNodes() {
  const db = await requireDb();
  const nodes = await loadProjectNodes();
  const { plan, skipped } = planMissingParkNodes(nodes, knownParks());
  const brandIds = new Map<string, number>();
  const created: Array<{ id: number; name: string; level: string }> = [];
  const OWN_COLORS: Record<string, string> = { airpark: "#ef4444", redpark: "#e11d48", skypark: "#8b5cf6" };
  for (const p of plan) {
    let brandId = p.brandNodeId;
    if (brandId == null) {
      const k = `${p.cityNodeId}|${p.brandName.toLowerCase()}`;
      if (!brandIds.has(k)) {
        const [row] = await db.insert(projects).values({ name: p.brandName, level: "brand", parentId: p.cityNodeId,
          color: OWN_COLORS[p.brandName.toLowerCase()] ?? "#64748b" } as any).$returningId();
        brandIds.set(k, row.id);
        created.push({ id: row.id, name: p.brandName, level: "brand" });
      }
      brandId = brandIds.get(k)!;
    }
    const color = nodes.find(n => n.id === brandId)?.color ?? OWN_COLORS[p.brandName.toLowerCase()] ?? "#64748b";
    const [row] = await db.insert(projects).values({ name: p.projectName, level: "project", parentId: brandId, color } as any).$returningId();
    created.push({ id: row.id, name: p.projectName, level: "project" });
  }
  try {
    const { invalidateProjectMatcherCache } = await import("./jobs/multiparkBookingSync");
    invalidateProjectMatcherCache();
  } catch { /* módulo do sync indisponível (testes) */ }
  const backfill = await backfillBookingProjects();
  return { created, skipped, backfill };
}
