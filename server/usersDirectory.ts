/**
 * Diretório de utilizadores paginado (página Utilizadores).
 *
 * Pedido do Jorge (set 2026): a página não pode abrir com TODAS as contas de
 * uma vez — abre com um resumo (contagens por papel e por cidade) e uma
 * página pequena (as 20 contas com atividade mais recente), e é ele que
 * escolhe o que vê com pesquisa e filtros. Tudo paginado no SERVIDOR.
 *
 * Regras que se mantêm:
 *   - o âmbito de cidades (`userScope`) aplica-se SEMPRE, a qualquer filtro;
 *   - a "cidade" de uma conta é a cidade das fichas RH ligadas
 *     (`employees.projectId` → nó `level='city'`, a mesma resolução de
 *     server/employeeCity.ts);
 *   - SQL parametrizado (nada do input entra no texto da query) e seguro com
 *     ONLY_FULL_GROUP_BY (o único GROUP BY agrupa pela coluna que seleciona).
 *
 * A parte pura (`buildUserDirectoryWhere`, `normalizeUserDirectoryPage`,
 * `cityProjectIdsFrom`) é testada sem BD em usersDirectory.test.ts.
 */

import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { employees, projects, users } from "../drizzle/schema";
import { projectScope, userScope } from "./cityScope";
import { resolveCityFromProjects, type ProjectNode } from "./employeeCity";
import { CITY_KEYS, type CityKey } from "../shared/city";
import { USER_ROLES } from "./userAdminRules";
import { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const USER_DIRECTORY_STATUS = ["active", "inactive"] as const;
export const USER_DIRECTORY_EMPLOYEE = ["with", "without"] as const;
/**
 * Último acesso. `never` = conta criada à mão que ainda não entrou (o
 * `lastSignedIn` dessas contas é a data de criação, por isso as restantes
 * opções excluem-nas — senão uma conta criada ontem contava como "ativa").
 */
export const USER_DIRECTORY_LAST_LOGIN = ["7d", "30d", "stale30", "stale90", "never"] as const;
export const USER_DIRECTORY_SORT = ["recent", "name", "created"] as const;
export const USER_DIRECTORY_CITY = [...CITY_KEYS, "none"] as const;

export const USER_DIRECTORY_DEFAULT_LIMIT = 20;
export const USER_DIRECTORY_MAX_LIMIT = 100;

export type UserDirectoryFilters = {
  search?: string | null;
  role?: (typeof USER_ROLES)[number] | null;
  city?: (typeof USER_DIRECTORY_CITY)[number] | null;
  status?: (typeof USER_DIRECTORY_STATUS)[number] | null;
  lastLogin?: (typeof USER_DIRECTORY_LAST_LOGIN)[number] | null;
  employee?: (typeof USER_DIRECTORY_EMPLOYEE)[number] | null;
};

export type UserDirectoryQuery = UserDirectoryFilters & {
  sort?: (typeof USER_DIRECTORY_SORT)[number] | null;
  limit?: number | null;
  offset?: number | null;
};

/** Ids de projeto de cada cidade (inclui toda a sub-árvore). PURA. */
export function cityProjectIdsFrom(nodes: ProjectNode[]): Record<CityKey, number[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = Object.fromEntries(CITY_KEYS.map((k) => [k, [] as number[]])) as Record<CityKey, number[]>;
  for (const node of nodes) {
    const city = resolveCityFromProjects(byId, node.id);
    if (city) out[city].push(node.id);
  }
  for (const k of CITY_KEYS) out[k].sort((a, b) => a - b);
  return out;
}

/** Limite/offset seguros (inteiros, dentro dos limites). PURA. */
export function normalizeUserDirectoryPage(limit?: number | null, offset?: number | null): { limit: number; offset: number } {
  const l = Number.isFinite(limit) ? Math.trunc(limit as number) : USER_DIRECTORY_DEFAULT_LIMIT;
  const o = Number.isFinite(offset) ? Math.trunc(offset as number) : 0;
  return {
    limit: Math.min(USER_DIRECTORY_MAX_LIMIT, Math.max(1, l)),
    offset: Math.max(0, o),
  };
}

/** Escapa os curingas do LIKE (`\`, `%`, `_`) — o texto é sempre literal. */
export function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const idList = (ids: number[]): SQL =>
  ids.length ? sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})` : sql`(NULL)`;

/** A conta tem alguma ficha (no âmbito do visitante) num destes projetos. */
function hasEmployeeIn(ids: number[]): SQL {
  if (!ids.length) return sql`1 = 0`;
  return sql`EXISTS (SELECT 1 FROM employees dir_emp WHERE dir_emp.userId = ${users.id}
    AND dir_emp.projectId IN ${idList(ids)} AND ${projectScope(sql`dir_emp.projectId`)})`;
}

const notManual = sql`(${users.loginMethod} IS NULL OR ${users.loginMethod} <> 'manual')`;

/**
 * WHERE do diretório: âmbito de cidades + filtros escolhidos. PURA dado o
 * mapa cidade → projetos (o âmbito vem do AsyncLocalStorage do pedido).
 */
export function buildUserDirectoryWhere(filters: UserDirectoryFilters, cityIds: Record<CityKey, number[]>): SQL {
  const conds: SQL[] = [userScope(users.id)];

  const search = (filters.search ?? "").trim().slice(0, 100);
  if (search) {
    const pattern = `%${escapeLike(search.toLowerCase())}%`;
    conds.push(sql`(LOWER(COALESCE(${users.name}, '')) LIKE ${pattern}
      OR LOWER(COALESCE(${users.email}, '')) LIKE ${pattern}
      OR EXISTS (SELECT 1 FROM employees dir_search WHERE dir_search.userId = ${users.id}
        AND LOWER(dir_search.fullName) LIKE ${pattern} AND ${projectScope(sql`dir_search.projectId`)}))`);
  }

  if (filters.role) conds.push(sql`${users.role} = ${filters.role}`);

  if (filters.status === "active") conds.push(sql`${users.isActive} = 1`);
  else if (filters.status === "inactive") conds.push(sql`${users.isActive} = 0`);

  if (filters.city === "none") {
    const all = CITY_KEYS.flatMap((k) => cityIds[k] ?? []);
    conds.push(sql`NOT (${hasEmployeeIn(all)})`);
  } else if (filters.city) {
    conds.push(hasEmployeeIn(cityIds[filters.city] ?? []));
  }

  if (filters.employee) {
    const linked = sql`EXISTS (SELECT 1 FROM employees dir_link WHERE dir_link.userId = ${users.id}
      AND ${projectScope(sql`dir_link.projectId`)})`;
    conds.push(filters.employee === "with" ? linked : sql`NOT (${linked})`);
  }

  switch (filters.lastLogin) {
    case "7d":
      conds.push(sql`${users.lastSignedIn} >= DATE_SUB(NOW(), INTERVAL ${7} DAY)`, notManual);
      break;
    case "30d":
      conds.push(sql`${users.lastSignedIn} >= DATE_SUB(NOW(), INTERVAL ${30} DAY)`, notManual);
      break;
    case "stale30":
      conds.push(sql`${users.lastSignedIn} < DATE_SUB(NOW(), INTERVAL ${30} DAY)`, notManual);
      break;
    case "stale90":
      conds.push(sql`${users.lastSignedIn} < DATE_SUB(NOW(), INTERVAL ${90} DAY)`, notManual);
      break;
    case "never":
      conds.push(sql`${users.loginMethod} = 'manual'`);
      break;
  }

  return and(...conds) as SQL;
}

/** ORDER BY estável (desempate por id, para a paginação nunca repetir linhas). */
export function userDirectoryOrder(sort: UserDirectoryQuery["sort"]): SQL[] {
  if (sort === "name") return [sql`LOWER(COALESCE(${users.name}, ${users.email}, '')) ASC`, asc(users.id)];
  if (sort === "created") return [desc(users.createdAt), desc(users.id)];
  return [desc(users.lastSignedIn), desc(users.id)];
}

// ── Acesso à BD ──────────────────────────────────────────────────────────────

async function loadCityProjectIds(db: Db) {
  const rows = await db
    .select({ id: projects.id, parentId: projects.parentId, name: projects.name, level: projects.level })
    .from(projects);
  return cityProjectIdsFrom(rows as ProjectNode[]);
}

/** Fichas RH ligadas às contas (só as das cidades do visitante). */
async function attachEmployees<T extends { id: number }>(db: Db, accounts: T[]) {
  if (!accounts.length) return [] as (T & { employees: { id: number; userId: number | null; fullName: string; isActive: number; projectName: string | null }[] })[];
  const links = await db
    .select({ id: employees.id, userId: employees.userId, fullName: employees.fullName, isActive: employees.isActive, projectName: projects.name })
    .from(employees)
    .leftJoin(projects, eq(projects.id, employees.projectId))
    .where(and(inArray(employees.userId, accounts.map((u) => u.id)), projectScope(employees.projectId)))
    .orderBy(desc(employees.isActive), asc(employees.id));
  const byUser = new Map<number, typeof links>();
  for (const person of links) {
    if (person.userId != null) byUser.set(person.userId, [...(byUser.get(person.userId) ?? []), person]);
  }
  return accounts.map((account) => ({ ...account, employees: byUser.get(account.id) ?? [] }));
}

export async function searchUserDirectory(input: UserDirectoryQuery) {
  const db = await getDb();
  const page = normalizeUserDirectoryPage(input.limit, input.offset);
  if (!db) return { rows: [], total: 0, ...page };
  const cityIds = await loadCityProjectIds(db);
  const where = buildUserDirectoryWhere(input, cityIds);
  const [countRow] = await db.select({ n: sql<number>`COUNT(*)` }).from(users).where(where);
  const accounts = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(...userDirectoryOrder(input.sort))
    .limit(page.limit)
    .offset(page.offset);
  return { rows: await attachEmployees(db, accounts), total: Number(countRow?.n ?? 0), ...page };
}

/** Contagens do resumo — sempre sobre o âmbito completo do visitante (sem filtros). */
export async function userDirectorySummary() {
  const db = await getDb();
  const empty = {
    total: 0, active: 0, inactive: 0, neverLoggedIn: 0,
    byRole: {} as Record<string, number>,
    byCity: { lisboa: 0, porto: 0, faro: 0, none: 0 } as Record<(typeof USER_DIRECTORY_CITY)[number], number>,
  };
  if (!db) return empty;
  const cityIds = await loadCityProjectIds(db);
  const scope = userScope(users.id);
  const allCity = CITY_KEYS.flatMap((k) => cityIds[k]);
  const [totals] = await db
    .select({
      total: sql<number>`COUNT(*)`,
      active: sql<number>`COALESCE(SUM(CASE WHEN ${users.isActive} = 1 THEN 1 ELSE 0 END), 0)`,
      never: sql<number>`COALESCE(SUM(CASE WHEN ${users.loginMethod} = 'manual' THEN 1 ELSE 0 END), 0)`,
      lisboa: sql<number>`COALESCE(SUM(CASE WHEN ${hasEmployeeIn(cityIds.lisboa)} THEN 1 ELSE 0 END), 0)`,
      porto: sql<number>`COALESCE(SUM(CASE WHEN ${hasEmployeeIn(cityIds.porto)} THEN 1 ELSE 0 END), 0)`,
      faro: sql<number>`COALESCE(SUM(CASE WHEN ${hasEmployeeIn(cityIds.faro)} THEN 1 ELSE 0 END), 0)`,
      none: sql<number>`COALESCE(SUM(CASE WHEN ${hasEmployeeIn(allCity)} THEN 0 ELSE 1 END), 0)`,
    })
    .from(users)
    .where(scope);
  // GROUP BY a própria coluna selecionada — seguro com ONLY_FULL_GROUP_BY.
  const roles = await db
    .select({ role: users.role, n: sql<number>`COUNT(*)` })
    .from(users)
    .where(scope)
    .groupBy(users.role);
  const total = Number(totals?.total ?? 0);
  const active = Number(totals?.active ?? 0);
  return {
    total,
    active,
    inactive: total - active,
    neverLoggedIn: Number(totals?.never ?? 0),
    byRole: Object.fromEntries(roles.map((r) => [r.role, Number(r.n)])) as Record<string, number>,
    byCity: {
      lisboa: Number(totals?.lisboa ?? 0),
      porto: Number(totals?.porto ?? 0),
      faro: Number(totals?.faro ?? 0),
      none: Number(totals?.none ?? 0),
    },
  };
}
