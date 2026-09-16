import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { requireGlobalCityAccess } from '../../cityScope';
import { config } from './config';
import { connection, disconnect, saveConnection } from './oauth';
import { locations, mapLocation, pendingReviews, refreshLocations, resolvePending, syncReviews } from './service';
import { safeError } from './domain';

const admin = protectedProcedure.use(async ({ ctx, next }) => {
  if (!['admin', 'super_admin'].includes(ctx.user.role)) throw new TRPCError({ code: 'FORBIDDEN' });
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
    .mutation(async ({ input }) => { await mapLocation(input.id, input.projectId, input.selected); return { ok: true }; }),
  sync: admin.mutation(() => syncReviews()),
  reconcile: admin.input(z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), existingId: z.number().int().positive().nullable() }))
    .mutation(({ ctx, input }) => resolvePending(input.key, input.existingId, ctx.user.id)),
  disconnect: admin.mutation(async () => { await disconnect(); return { ok: true }; }),
});
