/**
 * Cidade de um colaborador — Lisboa / Porto / Faro.
 *
 * NÃO existe coluna `city` em `employees` (verificado no schema). Em vez de
 * inventar dados, esta resolução usa, por ordem de fiabilidade, o que já está
 * guardado:
 *
 *   1. `employees.projectId` → sobe a árvore de `projects` até ao nó com
 *      `level = 'city'`. É a hierarquia canónica da app (grupo → cidade →
 *      marca → parque, ver `seedHierarchy` em db.ts) e já é usada assim pelo
 *      Extras-Dia (`getLisbonProjectIds`).
 *   2. `driver_applications.city` — cidade que a pessoa escreveu na candidatura
 *      do website multidriver (texto livre), ligada por `employeeId`.
 *   3. `employees.address` — última tentativa: procura o nome da cidade no
 *      endereço da ficha.
 *
 * Quem não bater em nenhuma fonte fica `null` ("sem cidade") — é informação
 * honesta e visível na UI, ao contrário de um palpite.
 *
 * A parte pura (`matchCityKey`, `resolveCityFromProjects`) é testável sem BD.
 */

import { inArray } from "drizzle-orm";
import { getDb } from "./db";
import { driverApplications, employees, projects } from "../drizzle/schema";
// Vocabulário de cidades (chaves, etiquetas e reconhecimento de texto) vive em
// shared/city.ts — o filtro da UI e esta derivação TÊM de usar o mesmo.
import { matchCityKey, type CityKey, type CitySource } from "../shared/city";

export type { CityKey, CitySource };

export interface ProjectNode {
  id: number;
  parentId: number | null;
  name: string;
  level: string | null;
}

/**
 * Sobe a árvore a partir de `projectId` até encontrar um nó `level='city'` cujo
 * nome seja uma das cidades conhecidas. PURA.
 *
 * Se a árvore não tiver nó de cidade (hierarquias antigas/planas), tenta o
 * NOME do próprio projeto ("Airpark Faro" → faro) antes de desistir.
 * Protegida contra ciclos e árvores mal formadas (limite de saltos).
 */
export function resolveCityFromProjects(
  byId: Map<number, ProjectNode>,
  projectId: number | null | undefined,
): CityKey | null {
  if (projectId == null) return null;
  const seen = new Set<number>();
  let node = byId.get(projectId);
  let fallback: CityKey | null = null;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    if (node.level === "city") {
      const key = matchCityKey(node.name);
      if (key) return key;
    }
    fallback = fallback ?? matchCityKey(node.name);
    node = node.parentId != null ? byId.get(node.parentId) : undefined;
  }
  return fallback;
}

/** Carrega a tabela `projects` indexada por id (tabela pequena, sem cache). */
async function loadProjectIndex(): Promise<Map<number, ProjectNode>> {
  const db = await getDb();
  if (!db) return new Map();
  const rows = await db
    .select({
      id: projects.id,
      parentId: projects.parentId,
      name: projects.name,
      level: projects.level,
    })
    .from(projects);
  return new Map(rows.map((r) => [r.id, r as ProjectNode]));
}

export interface EmployeeCity {
  city: CityKey | null;
  source: CitySource | null;
}

/**
 * Resolve a cidade de um conjunto de colaboradores já carregados.
 *
 * Recebe as fichas (id + projectId + address) para não voltar a lê-las da BD —
 * quem chama (o overview dos extras) já as tem em mãos. Faz no máximo duas
 * queries adicionais: `projects` (tabela pequena) e, só para quem ficou sem
 * cidade, as candidaturas do website.
 */
export async function resolveEmployeeCities(
  people: { id: number; projectId: number | null; address?: string | null }[],
): Promise<Map<number, EmployeeCity>> {
  const out = new Map<number, EmployeeCity>();
  if (people.length === 0) return out;

  const index = await loadProjectIndex();
  const unresolved: number[] = [];
  for (const p of people) {
    const city = resolveCityFromProjects(index, p.projectId);
    if (city) out.set(p.id, { city, source: "project" });
    else {
      out.set(p.id, { city: null, source: null });
      unresolved.push(p.id);
    }
  }
  if (unresolved.length === 0) return out;

  // Fonte 2 — cidade escrita na candidatura do website.
  const db = await getDb();
  if (db) {
    const apps = await db
      .select({ employeeId: driverApplications.employeeId, city: driverApplications.city })
      .from(driverApplications)
      .where(inArray(driverApplications.employeeId, unresolved));
    for (const a of apps) {
      if (a.employeeId == null) continue;
      const key = matchCityKey(a.city);
      if (key && !out.get(a.employeeId)?.city) {
        out.set(a.employeeId, { city: key, source: "application" });
      }
    }
  }

  // Fonte 3 — morada da ficha.
  for (const p of people) {
    if (out.get(p.id)?.city) continue;
    const key = matchCityKey(p.address ?? null);
    if (key) out.set(p.id, { city: key, source: "address" });
  }

  return out;
}

/**
 * Igual à anterior, mas vai buscar as fichas à BD a partir dos ids. É esta que
 * o overview dos extras usa (precisa da `address`, que a lista de extras não
 * carrega).
 */
export async function resolveCitiesForEmployeeIds(ids: number[]): Promise<Map<number, EmployeeCity>> {
  if (ids.length === 0) return new Map();
  const db = await getDb();
  if (!db) return new Map();
  const rows = await db
    .select({ id: employees.id, projectId: employees.projectId, address: employees.address })
    .from(employees)
    .where(inArray(employees.id, ids));
  return resolveEmployeeCities(rows);
}
