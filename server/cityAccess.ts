export const MISSING_COST_CENTRE_MESSAGE = 'Sem centro de custos atribuído. O acesso às cidades fica indisponível até à atribuição.';
export interface ProjectNode { id: number; name: string; level: string; parentId: number | null }
export interface CityAccess { all: boolean; defaultCityId: number | null; cityName?: string; cityIds: number[]; projectIds: number[]; missingCostCenter: boolean }

export function isPersonalAccessPath(path: string): boolean {
  return ['auth.me', 'auth.logout', 'permissions.mine', 'permissions.catalog', 'permissions.myCityAccess', 'projects.list',
    'rh.me', 'rh.timeRecords.myStatus'].includes(path) || path.startsWith('notifications.');
}

/** Rejeita filtros explícitos fora da cidade, mesmo que sejam enviados sem a interface. */
export function hasForeignCityFilter(access: CityAccess, input: unknown): boolean {
  if (access.all || !input || typeof input !== 'object') return false;
  const value = input as Record<string, unknown>;
  const normalizeCity = (s: string) => ({ lisbon: 'lisboa', oporto: 'porto' }[s.toLowerCase()] ?? s.toLowerCase());
  if (typeof value.city === 'string' && value.city && normalizeCity(value.city) !== normalizeCity(access.cityName ?? '')) return true;
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
  if (['multipark.bookings', 'multipark.kpis', 'multipark.snapshots'].includes(path)) return { ...raw, city: access.cityName };
  if (['multipark.bookingStats', 'multipark.localBookingsByAction', 'multipark.operationsSummary', 'rh.list'].includes(path)) {
    return { ...raw, projectId: raw.projectId ?? access.defaultCityId };
  }
  return input;
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

export async function loadCityAccess(userId: number): Promise<CityAccess> {
  const { getDb } = await import('./db');
  const { employees, projects } = await import('../drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const db = await getDb();
  if (!db) throw new Error('Não foi possível verificar o centro de custos. Tenta novamente.');
  const [people, nodes] = await Promise.all([
    db.select({ projectId: employees.projectId }).from(employees).where(eq(employees.userId, userId)),
    db.select({ id: projects.id, name: projects.name, level: projects.level, parentId: projects.parentId }).from(projects),
  ]);
  // Uma conta ligada a várias fichas diferentes exige reconciliação.
  const ids = [...new Set(people.map(p => p.projectId))];
  return resolveCityAccess(ids.length === 1 ? ids[0] : null, nodes);
}
