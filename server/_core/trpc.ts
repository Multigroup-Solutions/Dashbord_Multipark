import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

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

  const user = await applyPermissionElevation(ctx.user);

  return next({
    ctx: {
      ...ctx,
      user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
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
