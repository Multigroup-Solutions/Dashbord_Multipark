import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { cityScope } from '../cityScope';
import { ROLE_RANK, roleRank } from '../../shared/access';

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

// O grant `extras_dia.team_leader` NÃO sobe o papel efetivo (modelo de
// acessos, 24 set 2026): só torna a pessoa elegível como TL na escala do
// Extras-Dia (server/extrasDia.ts). O papel da conta é que decide os acessos.

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  // Bloqueio de login da ficha (docs/faltas/manual) — no servidor, não só na UI.
  const { loginBlockFor } = await import('../loginBlock');
  const blocked = await loginBlockFor(ctx.user);
  if (blocked) throw new TRPCError({ code: "FORBIDDEN", message: blocked });

  const user = ctx.user;

  const { loadCityAccess, isPersonalAccessPath, hasForeignCityFilter, scopeCityQuery, selectedCityAccess, MISSING_COST_CENTRE_MESSAGE } = await import('../cityAccess');
  let requestAccess: Awaited<ReturnType<typeof loadCityAccess>> | undefined;
  let scopedInput: unknown;
  let scopeInput = false;
  if (!isPersonalAccessPath(opts.path)) {
    const access = await loadCityAccess(user.id, user.role);
    if (access.missingCostCenter) throw new TRPCError({ code: 'FORBIDDEN', message: MISSING_COST_CENTRE_MESSAGE });
    const raw = await opts.getRawInput();
    if (hasForeignCityFilter(access, raw)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Este projeto não pertence à cidade do teu centro de custos.' });
    }
    scopedInput = scopeCityQuery(opts.path, access, raw);
    scopeInput = scopedInput !== raw;
    requestAccess = opts.type === 'query' || opts.path === 'expenses.recurring.generateMonth'
      ? await selectedCityAccess(access, scopedInput) : access;
  }

  const proceed = async () => {
    const { assertScopedOperation } = await import('../cityScopeGuards');
    await assertScopedOperation(opts.path, opts.type, scopedInput);
    return next({
      ...(scopeInput ? { getRawInput: async () => scopedInput } : {}),
      ctx: { ...ctx, user },
    });
  };
  return requestAccess ? cityScope.run(requestAccess, proceed) : proceed();
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    // Hierarquia: admin OU acima (super_admin incluído).
    if (!ctx.user || roleRank(ctx.user.role) < ROLE_RANK.admin) {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
