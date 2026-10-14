/**
 * Avaliação → Mês: o que os filtros "como no Odoo" precisam de cada linha do
 * ranking (shared/evaluationFilters.ts) e que os dias guardados não trazem —
 * a cidade e a marca da ficha, os agentes Multipark (n.º e nome) e os dias de
 * TL do período (para a equipa de cada pessoa).
 *
 * Só leituras da NOSSA BD. Nunca lança: se falhar, o ranking sai sem estas
 * facetas (os filtros por cidade/marca/equipa ficam sem opções), nunca vazio.
 */
import { sql } from "drizzle-orm";
import type { TeamLeaderDay } from "../shared/evaluationTeam";

export interface EmployeeFacets {
  /** cidade da ficha (lisbon/porto/faro), pelo centro de custos */
  homeCity: string | null;
  brand: { id: number; name: string } | null;
  /** n.º (id) e nomes dos agentes Multipark */
  agents: string[];
}

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

export interface ProjectNode { id: number; parentId: number | null; level: string | null; name: string }

/** Sobe a árvore de centros de custos até ao nível pedido (o próprio nó conta). PURA. */
export function ancestorOfLevel(projectId: number | null | undefined, nodes: ReadonlyMap<number, ProjectNode>, level: string): ProjectNode | null {
  if (projectId == null) return null;
  let n = nodes.get(projectId);
  const seen = new Set<number>();
  while (n && n.level !== level && n.parentId != null && !seen.has(n.id)) { seen.add(n.id); n = nodes.get(n.parentId); }
  return n && n.level === level ? n : null;
}

/** Facetas de cada ficha (cidade e marca da ficha, agentes). PURA. */
export function buildEmployeeFacets(
  employees: ReadonlyArray<{ id: number; projectId: number | null; multiparkAgentName: string | null; multiparkAgentUserId: string | null }>,
  agents: ReadonlyArray<{ employeeId: number; agentUserId: string | null; agentName: string | null }>,
  projects: readonly ProjectNode[],
  opsCityOf: (name: string) => string | null,
): Map<number, EmployeeFacets> {
  const nodes = new Map(projects.map((p) => [p.id, p]));
  const out = new Map<number, EmployeeFacets>();
  for (const e of employees) {
    const city = ancestorOfLevel(e.projectId, nodes, "city");
    const brand = ancestorOfLevel(e.projectId, nodes, "brand");
    const names = [e.multiparkAgentUserId, e.multiparkAgentName];
    for (const a of agents) if (a.employeeId === e.id) names.push(a.agentUserId, a.agentName);
    out.set(e.id, {
      homeCity: city ? opsCityOf(city.name) : null,
      brand: brand ? { id: brand.id, name: brand.name } : null,
      agents: Array.from(new Set(names.map((x) => String(x ?? "").trim()).filter(Boolean))),
    });
  }
  return out;
}

type Executor = { execute: (q: any) => Promise<unknown> };

/** Fichas do ranking → facetas. Falha → mapa vazio. */
async function employeeFacetsFrom(db: Executor, employeeIds: readonly number[]): Promise<Map<number, EmployeeFacets>> {
  const ids = Array.from(new Set(employeeIds.filter((x) => Number.isInteger(x) && x > 0)));
  if (!ids.length) return new Map();
  try {
    const inIds = sql.join(ids.map((x) => sql`${x}`), sql`, `);
    const emps = await db.execute(sql`SELECT id, projectId, multiparkAgentName, multiparkAgentUserId FROM employees WHERE id IN (${inIds})`);
    const agents = await db.execute(sql`SELECT employeeId, agentUserId, agentName FROM employee_agents WHERE employeeId IN (${inIds})`).catch(() => [[]]);
    const projects = await db.execute(sql`SELECT id, parentId, level, name FROM projects`);
    const { opsCityOf } = await import("./aiOps/cities");
    const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
    return buildEmployeeFacets(
      rowsOf(emps).filter((r) => Number.isFinite(Number(r?.id))).map((r) => ({
        id: Number(r.id), projectId: num(r.projectId),
        multiparkAgentName: r.multiparkAgentName ?? null, multiparkAgentUserId: r.multiparkAgentUserId ?? null,
      })),
      rowsOf(agents).filter((r) => Number.isFinite(Number(r?.employeeId))).map((r) => ({
        employeeId: Number(r.employeeId), agentUserId: r.agentUserId ?? null, agentName: r.agentName ?? null,
      })),
      rowsOf(projects).filter((r) => Number.isFinite(Number(r?.id))).map((r) => ({
        id: Number(r.id), parentId: num(r.parentId), level: r.level ?? null, name: String(r.name ?? ""),
      })),
      (name) => opsCityOf(name),
    );
  } catch (err: any) {
    console.warn("[evaluation] facetas do ranking indisponíveis:", String(err?.message ?? err).slice(0, 160));
    return new Map();
  }
}

/** Dias de TL do período (todas as cidades — só servem para pôr nome à equipa de quem já se vê). Falha → []. */
async function teamLeaderDaysFrom(db: Executor, from: string, to: string): Promise<TeamLeaderDay[]> {
  try {
    const res = await db.execute(sql`SELECT m.employeeId, e.fullName, m.day, m.city, m.shift
      FROM employee_day_metrics m INNER JOIN employees e ON e.id = m.employeeId
      WHERE m.day >= ${from} AND m.day <= ${to} AND m.isTeamLeader = 1 AND m.city IS NOT NULL`);
    return rowsOf(res)
      .filter((r) => Number.isFinite(Number(r?.employeeId)) && r?.day && r?.city)
      .map((r) => ({ employeeId: Number(r.employeeId), employeeName: String(r.fullName ?? ""), day: String(r.day), city: String(r.city), shift: r.shift == null ? null : String(r.shift) }));
  } catch (err: any) {
    console.warn("[evaluation] dias de TL indisponíveis:", String(err?.message ?? err).slice(0, 160));
    return [];
  }
}

/**
 * O que os filtros do ranking precisam e os dias guardados não trazem: as
 * facetas de cada ficha e os dias de TL do período. Uma ligação, leituras em
 * série (poucas e pequenas). Nunca lança.
 */
export async function loadRankingFacets(employeeIds: readonly number[], from: string, to: string): Promise<{ employees: Map<number, EmployeeFacets>; tlDays: TeamLeaderDay[] }> {
  let db: Executor | null = null;
  try {
    const { getDb } = await import("./db");
    db = (await getDb()) as Executor | null;
  } catch (err: any) {
    console.warn("[evaluation] facetas do ranking indisponíveis:", String(err?.message ?? err).slice(0, 160));
  }
  if (!db) return { employees: new Map(), tlDays: [] };
  return { employees: await employeeFacetsFrom(db, employeeIds), tlDays: await teamLeaderDaysFrom(db, from, to) };
}

/** As cidades de uma pessoa no período: as dos dias (mais dias primeiro); sem nenhuma, a da ficha. PURA. */
export function citiesOfDays(days: ReadonlyArray<{ city: string | null }>, homeCity: string | null): string[] {
  const n = new Map<string, number>();
  for (const d of days) if (d.city) n.set(d.city, (n.get(d.city) ?? 0) + 1);
  const list = Array.from(n.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  return list.length ? list : homeCity ? [homeCity] : [];
}
