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
  if (path.startsWith('reviews.')) {
    if (input.id != null) await projectRecord(schema.googleReviews, input.id);
    if (path === 'reviews.create') assertProjectAccess(input.projectId);
    if (path === 'reviews.syncFromGmail') requireGlobalCityAccess();
  }
  if (path.startsWith('expenses.')) {
    if (input.id != null) await projectRecord(path.startsWith('expenses.recurring.') ? schema.recurringExpenses : schema.expenses, input.id);
    if (type === 'mutation' && (path.endsWith('.create') || input.projectId !== undefined)) assertProjectAccess(input.projectId);
  }
  if (path.startsWith('marketing.')) {
    if (type === 'mutation' && (path.endsWith('.create') || input.projectId !== undefined)) assertProjectAccess(input.projectId);
    // Orçamento: apagar por id só dentro das cidades autorizadas (o upsert já
    // passa pelo assertProjectAccess acima, via projectId).
    if (path === 'marketing.budgets.remove' && input.id != null) await projectRecord(schema.marketingBudgets as any, input.id);
  }
  // Árvore de Projetos: um admin de cidade só lê/cria/altera/move/desativa
  // nós dentro das suas cidades (o próprio nó, o pai novo e o destino).
  if (path.startsWith('projects.') && path !== 'projects.list') {
    if (input.id != null) assertProjectAccess(input.id);
    if (input.projectId != null) assertProjectAccess(input.projectId);
    if (path === 'projects.create') assertProjectAccess(input.parentId ?? null);
    if (path === 'projects.move') assertProjectAccess(input.newParentId ?? null);
    if (path === 'projects.assignEmployee' && input.employeeId != null) await assertEmployeeAccess(input.employeeId);
    if (['projects.parkCoverage', 'projects.createMissingParkNodes'].includes(path)) requireGlobalCityAccess();
  }
  // Partner master data has no city owner. Its mutation cannot safely be
  // delegated to one city.
  if (path.startsWith('partnerships.') && type === 'mutation') requireGlobalCityAccess();
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
