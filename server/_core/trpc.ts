import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { cityScope } from '../cityScope';

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

// Elevação por permissão (regra Jorge 2026-08-06): quem tem o grant
// extras_dia.team_leader passa a VER o que um team_leader vê — o role efetivo
// sobe para team_leader em todos os requireRole. Cache curto por utilizador
// para não custar uma query em cada chamada.
const ROLE_RANK: Record<string, number> = { super_admin: 7, admin: 6, supervisor: 5, team_leader: 4, backoffice: 3, frontoffice: 2, extra: 1, user: 0 };
const tlGrantCache = new Map<number, { value: boolean; expiresAt: number }>();
export function invalidatePermissionElevation(userId: number) { tlGrantCache.delete(userId); }
async function hasTeamLeaderGrant(userId: number): Promise<boolean> {
  const hit = tlGrantCache.get(userId);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  let value = false;
  try {
    const { getUserPermissionOverrides } = await import("../db");
    const ov = await getUserPermissionOverrides(userId);
    value = ov["extras_dia.team_leader"] === "grant";
  } catch { /* BD indisponível — sem elevação */ }
  tlGrantCache.set(userId, { value, expiresAt: Date.now() + 60_000 });
  return value;
}

/** Aplica a elevação a um user já carregado (usado também no auth.me, que é
 * publicProcedure e não passa por este middleware). */
export async function applyPermissionElevation<T extends { id: number; role: string }>(user: T): Promise<T> {
  if ((ROLE_RANK[user.role] ?? 0) < (ROLE_RANK["team_leader"] ?? 4) && await hasTeamLeaderGrant(user.id)) {
    return { ...user, role: "team_leader" };
  }
  return user;
}

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  // Bloqueio de login da ficha (docs/faltas/manual) — no servidor, não só na UI.
  const { loginBlockFor } = await import('../loginBlock');
  const blocked = await loginBlockFor(ctx.user);
  if (blocked) throw new TRPCError({ code: "FORBIDDEN", message: blocked });

  const user = await applyPermissionElevation(ctx.user);

  const { loadCityAccess, isPersonalAccessPath, hasForeignCityFilter, scopeCityQuery, selectedCityAccess, MISSING_COST_CENTRE_MESSAGE } = await import('../cityAccess');
  let requestAccess: Awaited<ReturnType<typeof loadCityAccess>> | undefined;
  let scopedInput: unknown;
  let scopeInput = false;
  if (!isPersonalAccessPath(opts.path)) {
    const access = await loadCityAccess(user.id);
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
    if (!ctx.user || (ROLE_RANK[ctx.user.role] ?? 0) < ROLE_RANK.admin) {
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
