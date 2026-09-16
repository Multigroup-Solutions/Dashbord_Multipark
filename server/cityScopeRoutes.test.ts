import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ load: vi.fn(), queried: vi.fn(), recordProject: 49 }));
vi.mock('./cityAccess', async original => ({ ...await original<object>(), loadCityAccess: state.load }));
vi.mock('./db', async original => {
  const { cityScope } = await import('./cityScope');
  const snapshot = () => { state.queried(cityScope.getStore()); return []; };
  const chain: any = { from: () => chain, where: () => chain, limit: async () => [{ projectId: state.recordProject }] };
  return { ...await original<object>(), getUserPermissionOverrides: async () => ({}),
    getProjects: async () => [
      { id: 48, name: 'Multipark', level: 'group', parentId: null },
      { id: 49, name: 'Lisboa', level: 'city', parentId: 48 },
      { id: 50, name: 'Porto', level: 'city', parentId: 48 },
      { id: 65, name: 'Parque Porto', level: 'project', parentId: 50 },
    ], resolveProjectIds: async (id: number) => id === 50 ? [50, 65] : [id],
    getDb: async () => ({ select: () => chain }),
    getDayActivity: snapshot, getPartnershipAnalytics: snapshot, getPartnerships: snapshot,
    getAllDailyStats: snapshot, getMarketingExpenses: snapshot, listExpenses: snapshot,
    getEmployeeByUserId: async () => ({ employee: { id: 7, projectId: 50 } }),
    getEmployeeById: async (id: number) => ({ employee: { id, projectId: id === 7 ? 50 : 49, userId: null } }),
  };
});
vi.mock('./multiparkEvaluation', async () => {
  const { cityScope } = await import('./cityScope');
  return { evaluateDay: () => { state.queried(cityScope.getStore()); return {}; } };
});
vi.mock('./extrasAvailability', async original => ({ ...await original<object>(), getMyWeek: async () => ({ submitted: false, days: [] }) }));
import { appRouter } from './routers';
const caller = () => appRouter.createCaller({ user: { id: 123, role: 'admin' }, req: { headers: {} }, res: {} } as any);
const porto = { all: false, defaultCityId: 50, cityName: 'Porto', cityIds: [50], projectIds: [50, 65], missingCostCenter: false };
beforeEach(() => { state.load.mockReset().mockResolvedValue(porto); state.queried.mockClear(); state.recordProject = 49; });

describe('consultas dos módulos respeitam a autorização sem filtros do cliente', () => {
  it.each(['atividade', 'avaliacao', 'despesas', 'marketing', 'parcerias', 'catalogo'] as const)('%s recebe Porto no servidor', async module => {
    const c = caller();
    if (module === 'atividade') await c.multipark.dayActivity({ date: '2026-09-15' });
    if (module === 'avaliacao') await c.multipark.dayEvaluation({ date: '2026-09-15' });
    if (module === 'despesas') await c.expenses.list();
    if (module === 'marketing') await c.marketing.stats.all();
    if (module === 'parcerias') await c.partnerships.analytics({ from: '2026-09-01', to: '2026-09-15' });
    if (module === 'catalogo') await c.partnerships.list();
    expect(state.queried).toHaveBeenCalledWith(expect.objectContaining({ projectIds: [50, 65], all: false }));
  });
  it('filtra a seleção de Porto mesmo para quem tem acesso global', async () => {
    state.load.mockResolvedValue({ ...porto, all: true, projectIds: [48, 49, 50, 65] });
    await caller().multipark.dayActivity({ date: '2026-09-15', projectId: 50 });
    expect(state.queried).toHaveBeenCalledWith(expect.objectContaining({ projectIds: [50, 65], all: false }));
  });
  it('a autorização adicional permite selecionar outra cidade', async () => {
    state.load.mockResolvedValue({ ...porto, cityIds: [49, 50], cityNames: ['Lisboa', 'Porto'], projectIds: [49, 50, 65] });
    await caller().multipark.dayActivity({ date: '2026-09-15', projectId: 49 });
    expect(state.queried).toHaveBeenCalledWith(expect.objectContaining({ projectIds: [49] }));
  });
  it('rejeita uma cidade alheia e não consulta os dados', async () => {
    await expect(caller().multipark.dayActivity({ date: '2026-09-15', projectId: 49 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(state.queried).not.toHaveBeenCalled();
  });
  it('impede abrir ou mover uma despesa de Lisboa usando apenas o id', async () => {
    await expect(caller().expenses.byId({ id: 9 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().expenses.update({ id: 9, projectId: 50 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('impede abrir críticas de outra cidade e administrar a ligação global', async () => {
    await expect(caller().reviews.getById({ id: 9 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().integrations.googleBusiness.status()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().integrations.googleBusiness.sync()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('bloqueia custos e métricas de campanhas de outra cidade por identificador', async () => {
    await expect(caller().marketing.stats.byCampaign({ campaignId: 9 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().marketing.internalCampaigns.costs({ campaignType: 'internal', campaignId: 9 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('não expõe faturas globais nem permite importar campanhas globais com acesso local', async () => {
    await expect(caller().partnerships.listInvoices()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().marketing.importCampaignCsv({ csv: 'ficheiro de demonstração' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('a ficha e a disponibilidade exigem que a pessoa pertença à cidade autorizada', async () => {
    expect(await caller().rh.byId({ id: 7 })).toMatchObject({ employee: { id: 7, projectId: 50 } });
    await expect(caller().rh.byId({ id: 8 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await caller().rh.accountSummary({ employeeId: 7 })).toBeNull();
    expect(await caller().extrasAvailability.forEmployee({ employeeId: 7, weekStart: '2026-09-14' })).toMatchObject({ submitted: false });
    await expect(caller().rh.accountSummary({ employeeId: 8 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().extrasAvailability.forEmployee({ employeeId: 8, weekStart: '2026-09-14' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
