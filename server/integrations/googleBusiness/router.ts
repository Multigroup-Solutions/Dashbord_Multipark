import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { requireGlobalCityAccess } from '../../cityScope';
import { can } from '../../../shared/access';
import { config } from './config';
import { connection, disconnect, saveConnection } from './oauth';
import { locations, mapLocation, pendingReviews, refreshLocations, resolvePending, syncReviews } from './service';
import { safeError } from './domain';

/** 33a: estado da Windsor para o painel (sem a chave). */
async function windsorStatus() {
  const w = await import('./windsor');
  const [syncOn, replyOn, lastRun] = await Promise.all([w.windsorFlagOn('GBP_WINDSOR_SYNC'), w.windsorFlagOn('GBP_WINDSOR_REPLY'), w.windsorLastRun()]);
  return { configured: w.windsorConfigured(), syncOn, replyOn, lastRun };
}

const admin = protectedProcedure.use(async ({ ctx, next }) => {
  // Ligação à conta Google: gestão de Integrações (admin+ — shared/access.ts).
  if (!can(ctx.user, 'integracoes', 'manage')) throw new TRPCError({ code: 'FORBIDDEN' });
  requireGlobalCityAccess();
  return next();
});
export const googleBusinessRouter = router({
  status: admin.query(async () => {
    const c = config(), conn = await connection();
    return { status: conn?.status || 'disconnected', accountEmail: conn?.accountEmail || null,
      connectedAt: conn?.connectedAt || null, lastCheckedAt: conn?.lastCheckedAt || null,
      lastError: conn?.lastError || null, configured: !!(c.clientId && c.clientSecret),
      redirectUri: c.redirectUri, pushConfigured: !!(c.pushAudience && c.pushEmail && c.subscription),
      locations: await locations(), pending: await pendingReviews(), windsor: await windsorStatus() };
  }),
  // 33a: Google Business pela Windsor (segundo canal; mesmas tabelas e ecrã)
  discoverWindsor: admin.mutation(async ({ ctx }) => {
    const w = await import('./windsor');
    if (!w.windsorConfigured()) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Falta a chave da Windsor (WINDSOR_API_KEY) na Vercel.' });
    try {
      const r = await w.refreshLocationsFromWindsor();
      try {
        const { logActivity } = await import('../../db');
        await logActivity({ userId: ctx.user.id, action: 'discover', entity: 'google_business_locations', details: `Perfis Google pela Windsor: ${r.found} encontrados` });
      } catch { /* registo */ }
      return r;
    } catch (error) { throw new TRPCError({ code: 'BAD_REQUEST', message: w.windsorError(error) }); }
  }),
  syncWindsor: admin.mutation(async ({ ctx }) => {
    const w = await import('./windsor');
    const r = await w.syncReviewsFromWindsor({ manual: true });
    if (r.skipped === 'not_configured' || r.skipped === 'oauth') throw new TRPCError({ code: 'BAD_REQUEST', message: r.reason ?? 'Recolha pela Windsor indisponível.' });
    if (r.skipped === 'busy') throw new TRPCError({ code: 'CONFLICT', message: 'Já há uma recolha pela Windsor a correr. Tenta daqui a 1–2 minutos.' });
    try {
      const { logActivity } = await import('../../db');
      await logActivity({ userId: ctx.user.id, action: 'sync', entity: 'google_reviews', details: `Críticas pela Windsor: ${r.imported} importadas/atualizadas, ${r.pending} por conciliar${r.errors.length ? ` · erro: ${r.errors[0]}` : ''}` });
    } catch { /* registo */ }
    return r;
  }),
  discover: admin.mutation(async () => {
    try { return await refreshLocations(); }
    catch (error) { await saveConnection({ lastError: safeError(error) }); throw new TRPCError({ code: 'BAD_REQUEST', message: safeError(error) }); }
  }),
  map: admin.input(z.object({ id: z.number().int().positive(), projectId: z.number().int().positive().nullable(), selected: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await mapLocation(input.id, input.projectId, input.selected);
      // 19d: fica registado que perfil passou a importar críticas e para que parque
      try {
        const { logActivity } = await import('../../db');
        await logActivity({ userId: ctx.user.id, action: 'map', entity: 'google_business_locations', entityId: input.id,
          details: `Perfil Google #${input.id}: ${input.selected ? `importa críticas para o parque #${input.projectId}` : 'deixa de importar críticas'}` });
      } catch { /* registo */ }
      return { ok: true };
    }),
  sync: admin.mutation(() => syncReviews()),
  reconcile: admin.input(z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), existingId: z.number().int().positive().nullable() }))
    .mutation(({ ctx, input }) => resolvePending(input.key, input.existingId, ctx.user.id)),
  // 19d: só o super admin; revoga na Google, mantém os perfis escolhidos e fica registado.
  disconnect: admin.mutation(async ({ ctx }) => {
    if (ctx.user.role !== 'super_admin') throw new TRPCError({ code: 'FORBIDDEN', message: 'Só o super admin pode desligar o Google Business.' });
    const r = await disconnect();
    try {
      const { logActivity } = await import('../../db');
      await logActivity({ userId: ctx.user.id, action: 'disconnect', entity: 'integration_connections',
        details: `Google Business desligado${r.accountEmail ? ` (${r.accountEmail})` : ''}${r.revoked ? ' · token revogado na Google' : ' · não foi possível revogar o token na Google'} — perfis escolhidos mantidos` });
    } catch { /* registo */ }
    // D51: avisa os admins e o super admin (interruptor; nunca lança).
    const { notifyIntegrationDisconnected } = await import('../../integrationDisconnectNotify');
    await notifyIntegrationDisconnected({ integration: 'Google Business', byUserId: ctx.user.id, byName: ctx.user.name, accountEmail: r.accountEmail ?? null, revoked: r.revoked });
    return { ok: true, revoked: r.revoked };
  }),
});
