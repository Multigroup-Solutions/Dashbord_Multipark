import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/mysql2';
import { loadCityAccess } from './cityAccess';

const state = vi.hoisted(() => ({ db: null as any, overrides: {} as Record<string, string> }));
vi.mock('./db', () => ({ getDb: async () => state.db, getUserPermissionOverrides: async () => state.overrides }));

const nodes = [
  { id: 48, name: 'Multipark', level: 'group', parentId: null },
  { id: 50, name: 'Porto', level: 'city', parentId: 48 },
  { id: 51, name: 'Faro', level: 'city', parentId: 48 },
  { id: 65, name: 'Parque Porto', level: 'project', parentId: 50 },
];
let queries: { sql: string; values: unknown[] }[];
let people: unknown[][];
let queryError: Error | undefined;

beforeEach(() => {
  queries = [];
  people = [[12, 50]];
  queryError = undefined;
  state.overrides = {};
  // Real Drizzle query generation; only the database transport is replaced.
  state.db = drizzle({ query: async (query: { sql: string }, values: unknown[]) => {
    queries.push({ sql: query.sql, values });
    if (query.sql.includes('from `employees`')) {
      if (queryError) throw queryError;
      return [people, []];
    }
    return [nodes.map(n => [n.id, n.name, n.level, n.parentId]), []];
  } } as any);
});

describe('city access for primary and alternate accounts', () => {
  it('looks up both account links and returns all projects in the linked city', async () => {
    expect(await loadCityAccess(123)).toMatchObject({ cityIds: [50], projectIds: [50, 65], all: false, missingCostCenter: false });
    const lookup = queries.find(q => q.sql.includes('from `employees`'))!;
    expect(lookup.sql).toContain('`employees`.`userId` = ?');
    expect(lookup.sql).toContain('EXISTS (SELECT 1 FROM employee_accounts ea WHERE ea.employeeId = `employees`.`id` AND ea.userId = ?)');
    expect(lookup.values).toEqual([123, 123]);
  });
  it.each([[], [[12, null]], [[12, 999]], [[12, 50], [13, 50]], [[12, 50], [13, 51]]].map(rows => ({ rows })))('blocks missing or ambiguous employee ownership: $rows', async ({ rows }) => {
    people = rows as unknown[][];
    state.overrides = { 'city.all': 'grant' };
    expect(await loadCityAccess(123)).toMatchObject({ cityIds: [], all: false, missingCostCenter: true });
  });
  it('preserves explicit city grants on a valid employee', async () => {
    state.overrides = { 'city.extra.faro': 'grant' };
    expect(await loadCityAccess(123)).toMatchObject({ cityIds: [50, 51], missingCostCenter: false });
  });
  it('super_admin sem ficha (sem centro de custos) vê todos os nós', async () => {
    people = [];
    expect(await loadCityAccess(123, 'super_admin')).toMatchObject({ all: true, missingCostCenter: false, cityIds: [50, 51], projectIds: [48, 50, 51, 65] });
    // Sem papel continua bloqueado (o papel é que alarga o âmbito).
    expect(await loadCityAccess(123)).toMatchObject({ all: false, missingCostCenter: true });
  });
  it('papel nacional que não é super_admin, sem ficha, continua bloqueado', async () => {
    people = [];
    expect(await loadCityAccess(123, 'backoffice')).toMatchObject({ all: false, missingCostCenter: true });
  });
  it('does not grant access when the account lookup fails', async () => {
    queryError = new Error('database unavailable');
    await expect(loadCityAccess(123)).rejects.toMatchObject({ cause: queryError });
  });
});
