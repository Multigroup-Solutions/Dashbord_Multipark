import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { requireGlobalCityAccess } from '../../cityScope';
import { can } from '../../../shared/access';
import { config } from './config';
import { connection, disconnect, saveConnection } from './oauth';
import { locations, mapLocation, pendingReviews, refreshLocations, resolvePending, syncReviews } from './service';
import { safeError } from './domain';

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
      locations: await locations(), pending: await pendingReviews() };
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
    return { ok: true, revoked: r.revoked };
  }),
});
