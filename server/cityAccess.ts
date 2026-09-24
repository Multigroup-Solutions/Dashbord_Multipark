export const MISSING_COST_CENTRE_MESSAGE = 'Sem centro de custos atribuído. O acesso às cidades fica indisponível até à atribuição.';
export interface ProjectNode { id: number; name: string; level: string; parentId: number | null }
export interface CityAccess { all: boolean; defaultCityId: number | null; cityName?: string; cityNames?: string[]; cityIds: number[]; projectIds: number[]; missingCostCenter: boolean }

export function isPersonalAccessPath(path: string): boolean {
  return ['auth.me', 'auth.logout', 'permissions.mine', 'permissions.catalog', 'permissions.myCityAccess', 'projects.list',
    'rh.me', 'rh.timeRecords.myStatus'].includes(path) || path.startsWith('notifications.');
}

/** Rejeita filtros explícitos fora da cidade, mesmo que sejam enviados sem a interface. */
export function hasForeignCityFilter(access: CityAccess, input: unknown): boolean {
  if (access.all || !input || typeof input !== 'object') return false;
  const value = input as Record<string, unknown>;
  const normalizeCity = (s: string) => ({ lisbon: 'lisboa', oporto: 'porto' }[s.toLowerCase()] ?? s.toLowerCase());
  if (typeof value.city === 'string' && value.city && !(access.cityNames ?? [access.cityName ?? '']).some(name => normalizeCity(value.city as string) === normalizeCity(name))) return true;
  for (const key of ['projectId', 'cityId']) {
    if (typeof value[key] === 'number' && !access.projectIds.includes(value[key])) return true;
  }
  for (const key of ['projectIds', 'cityIds']) {
    if (Array.isArray(value[key]) && (value[key] as unknown[]).some(id => typeof id !== 'number' || !access.projectIds.includes(id))) return true;
  }
  return false;
}

/** As consultas operacionais recebem sempre a cidade, mesmo sem filtro na página. */
export function scopeCityQuery(path: string, access: CityAccess, input: unknown): unknown {
  if (access.all) return input;
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (['extrasDia.forecast', 'extrasDia.bookingsInSlot', 'extrasDia.upsertAssignment'].includes(path)) {
    const name = access.cityName?.toLowerCase();
    return { ...raw, city: raw.city ?? (name === 'lisboa' ? 'lisbon' : name) };
  }
  if (['multipark.bookings', 'multipark.kpis', 'multipark.snapshots'].includes(path)) return { ...raw, city: raw.city ?? access.cityName };
  if (['multipark.bookingStats', 'multipark.localBookingsByAction', 'multipark.operationsSummary', 'multipark.extrasCostDaily',
    'multipark.adSpendDaily', 'services.multiparkExtras', 'rh.list'].includes(path)) {
    return { ...raw, projectId: raw.projectId ?? access.defaultCityId };
  }
  return input;
}

/** Extra cities are explicit grants. A missing/invalid cost centre still blocks
 * access; an admin role alone never grants additional cities. */
export function applyCityPermissions(base: CityAccess, projects: ProjectNode[], overrides: Record<string, string>): CityAccess {
  if (base.missingCostCenter) return base;
  const cityNodes = projects.filter(p => p.level === 'city');
  const keyFor = (name: string) => ({ lisboa: 'lisbon', lisbon: 'lisbon', porto: 'porto', faro: 'faro' }[name.trim().toLowerCase()]);
  const allowed = new Set(base.cityIds);
  if (overrides['city.all'] === 'grant') cityNodes.forEach(p => allowed.add(p.id));
  for (const p of cityNodes) {
    const key = keyFor(p.name);
    if (!key) continue;
    if (overrides[`city.extra.${key}`] === 'grant') allowed.add(p.id);
    // Denying an extra grant does not remove the cost centre's own city.
    if (overrides[`city.extra.${key}`] === 'deny' && p.id !== base.defaultCityId) allowed.delete(p.id);
  }
  const all = (base.all || overrides['city.all'] === 'grant') && allowed.size === cityNodes.length;
  const selected = cityNodes.filter(p => allowed.has(p.id));
  const ids = new Set(selected.flatMap(p => resolveCityAccess(p.id, projects).projectIds));
  return { ...base, all, cityIds: selected.map(p => p.id), cityNames: selected.map(p => p.name),
    projectIds: all ? projects.map(p => p.id) : [...ids] };
}

/** Narrow the authenticated scope to a requested city/project for reads. */
export async function selectedCityAccess(access: CityAccess, input: unknown): Promise<CityAccess> {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (typeof raw.projectId !== 'number' && typeof raw.cityId !== 'number' && typeof raw.city !== 'string') return access;
  if (!access.all && access.cityIds.length === 1 && (raw.projectId === access.defaultCityId || raw.city === access.cityName)) return access;
  const { getProjects, resolveProjectIds } = await import('./db');
  const nodes = await getProjects();
  const normalize = (s: string) => ({ lisbon: 'lisboa', oporto: 'porto' }[s.toLowerCase()] ?? s.toLowerCase());
  const root = typeof raw.projectId === 'number' ? raw.projectId : typeof raw.cityId === 'number' ? raw.cityId
    : nodes.find(p => p.level === 'city' && normalize(p.name) === normalize(String(raw.city)))?.id;
  if (root === undefined) return { ...access, all: false, projectIds: [], cityIds: [], cityNames: [] };
  const ids = (await resolveProjectIds(root)).filter(id => access.all || access.projectIds.includes(id));
  const roots = [...new Set(ids.flatMap(id => resolveCityAccess(id, nodes).cityIds))];
  const names = nodes.filter(p => roots.includes(p.id)).map(p => p.name);
  return { ...access, all: false, projectIds: ids, cityIds: roots, cityNames: names };
}

/** A função de trabalho não concede cidades. Só o centro de custos o faz. */
export function resolveCityAccess(projectId: number | null, projects: ProjectNode[]): CityAccess {
  const none: CityAccess = { all: false, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: true };
  const byId = new Map(projects.map(p => [p.id, p]));
  let node = projectId == null ? undefined : byId.get(projectId);
  if (!node) return none;
  if (node.level === 'group' && node.name.trim().toLowerCase() === 'multipark') {
    return { all: true, defaultCityId: null, cityIds: projects.filter(p => p.level === 'city').map(p => p.id), projectIds: projects.map(p => p.id), missingCostCenter: false };
  }
  const visited = new Set<number>();
  while (node && node.level !== 'city') {
    if (visited.has(node.id)) return none;
    visited.add(node.id);
    node = node.parentId == null ? undefined : byId.get(node.parentId);
  }
  if (!node) return none;
  const ids = new Set([node.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of projects) if (p.parentId != null && ids.has(p.parentId) && !ids.has(p.id)) { ids.add(p.id); changed = true; }
  }
  return { all: false, defaultCityId: node.id, cityName: node.name, cityIds: [node.id], projectIds: [...ids], missingCostCenter: false };
}

/**
 * Papéis NACIONAIS (frontoffice, backoffice, admin, super_admin — ver
 * shared/access.ts) veem todas as cidades. Continuam a precisar de centro de
 * custos válido, exceto o super_admin, que nunca fica trancado fora.
 * Os papéis de cidade (user…supervisor) ficam com o centro + grants.
 */
export function applyRoleScope(access: CityAccess, role: string | null | undefined, projects: ProjectNode[]): CityAccess {
  const national = ['frontoffice', 'backoffice', 'admin', 'super_admin'].includes(String(role ?? ''));
  if (!national) return access;
  if (access.missingCostCenter && role !== 'super_admin') return access;
  const cities = projects.filter(p => p.level === 'city');
  return { ...access, all: true, missingCostCenter: false, cityIds: cities.map(p => p.id), cityNames: cities.map(p => p.name),
    projectIds: projects.map(p => p.id) };
}

export async function loadCityAccess(userId: number, role?: string | null): Promise<CityAccess> {
  const { getDb, getUserPermissionOverrides } = await import('./db');
  const { employees, projects } = await import('../drizzle/schema');
  const { eq, or, sql } = await import('drizzle-orm');
  const db = await getDb();
  if (!db) throw new Error('Não foi possível verificar o centro de custos. Tenta novamente.');
  const [people, nodes, overrides] = await Promise.all([
    db.select({ id: employees.id, projectId: employees.projectId }).from(employees).where(or(
      eq(employees.userId, userId),
      sql`EXISTS (SELECT 1 FROM employee_accounts ea WHERE ea.employeeId = ${employees.id} AND ea.userId = ${userId})`,
    )),
    db.select({ id: projects.id, name: projects.name, level: projects.level, parentId: projects.parentId }).from(projects),
    getUserPermissionOverrides(userId),
  ]);
  // Uma conta ligada a várias fichas diferentes exige reconciliação.
  const base = applyCityPermissions(resolveCityAccess(people.length === 1 ? people[0].projectId : null, nodes), nodes, overrides);
  return applyRoleScope(base, role, nodes);
}
