import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { assertEmployeeAccess, assertProjectAccess, cityNameScope, requireGlobalCityAccess, scopedProjectIds } from './cityScope';

/** Authorize the persisted owner before reads/writes addressed only by ID.
 * Checking the proposed projectId alone would allow moving a foreign record. */
export async function assertScopedOperation(path: string, type: string, raw: unknown): Promise<void> {
  if (scopedProjectIds() === undefined) return;
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const { getDb } = await import('./db');
  const schema = await import('../drizzle/schema');
  const projectRecord = async (table: { id: any; projectId: any }, id: number) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Não foi possível verificar a cidade.' });
    const [row] = await db.select({ projectId: table.projectId }).from(table as any).where(eq(table.id, id)).limit(1);
    assertProjectAccess(row?.projectId as number | null | undefined);
  };
  const campaign = (kind: string, id: number) => projectRecord(kind === 'ad' ? schema.campaigns : schema.internalCampaigns, id);
  if (path.startsWith('expenses.')) {
    if (input.id != null) await projectRecord(path.startsWith('expenses.recurring.') ? schema.recurringExpenses : schema.expenses, input.id);
    if (type === 'mutation' && (path.endsWith('.create') || input.projectId !== undefined)) assertProjectAccess(input.projectId);
  }
  if (path.startsWith('marketing.')) {
    if (['marketing.importCampaignCsv', 'marketing.stats.importGoogleAdsReport'].includes(path)) requireGlobalCityAccess();
    if (type === 'mutation' && (path.endsWith('.create') || input.projectId !== undefined)) assertProjectAccess(input.projectId);
    if (path.startsWith('marketing.campaigns.') && input.id != null) await projectRecord(schema.campaigns, input.id);
    if (path.startsWith('marketing.expenses.') && input.id != null) await projectRecord(schema.marketingExpenses, input.id);
    if (path.startsWith('marketing.stats.') && input.campaignId != null) await projectRecord(schema.campaigns, input.campaignId);
    if (path === 'marketing.stats.delete') {
      const db = await getDb();
      const [row] = db ? await db.select().from(schema.campaignDailyStats).where(eq(schema.campaignDailyStats.id, input.id)).limit(1) : [];
      if (!row) throw new TRPCError({ code: 'FORBIDDEN' });
      await projectRecord(schema.campaigns, row.campaignId);
    }
    if (path.startsWith('marketing.internalCampaigns.')) {
      if (input.campaignId != null) await campaign(input.campaignType, input.campaignId);
      if (['update', 'remove'].some(action => path.endsWith(`.${action}`))) await campaign(input.campaignType ?? 'internal', input.id);
      if (path.endsWith('.removeKey') || path.endsWith('.removeCost')) {
        const db = await getDb();
        const table = path.endsWith('.removeKey') ? schema.internalCampaignKeys : schema.internalCampaignCosts;
        const [row] = db ? await db.select().from(table).where(eq(table.id, input.keyId ?? input.id)).limit(1) : [];
        if (!row) throw new TRPCError({ code: 'FORBIDDEN' });
        await campaign(row.campaignType, row.campaignId);
      }
    }
  }
  // Partner master data and invoices have no city owner. Their mutation or
  // global financial totals cannot safely be delegated to one city.
  if (path.startsWith('partnerships.') && ((type === 'mutation' && path !== 'partnerships.addTransaction')
    || ['partnerships.dashboardStats', 'partnerships.listInvoices'].includes(path))) requireGlobalCityAccess();
  if (path === 'partnerships.addTransaction') assertProjectAccess(input.projectId);
  if (path === 'extrasDia.upsertAssignment' && input.employeeId) await assertEmployeeAccess(input.employeeId);
  if (['extrasDia.upsertAssignment', 'extrasDia.deleteAssignment'].includes(path) && input.id != null) {
    const db = await getDb();
    const table = schema.extrasDiaAssignments;
    const rows = db ? await db.select({ id: table.id }).from(table).where(and(eq(table.id, input.id), cityNameScope(table.city))).limit(1) : [];
    if (!rows.length) throw new TRPCError({ code: 'FORBIDDEN', message: 'Este turno pertence a outra cidade.' });
  }
  if (path === 'multipark.setMultiparkAgentMapping') await assertEmployeeAccess(input.employeeId);
  if (path.startsWith('users.') || ['permissions.forUser', 'permissions.setForUser'].includes(path)) {
    const id = input.userId ?? input.id;
    if (id != null) {
      const { loadCityAccess } = await import('./cityAccess');
      const target = await loadCityAccess(id);
      const allowed = scopedProjectIds()!;
      if (target.missingCostCenter || target.all || target.projectIds.some(pid => !allowed.includes(pid))) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Este utilizador tem acesso fora das tuas cidades autorizadas.' });
      }
    }
    if (path === 'permissions.setForUser' && input.permission.startsWith('city.') && input.mode === 'grant') requireGlobalCityAccess();
  }
}
