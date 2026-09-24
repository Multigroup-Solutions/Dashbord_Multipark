/**
 * Verificação de acessos no servidor — aplica a matriz de shared/access.ts.
 *
 * requireAccess(user, módulo, ação) só deixa passar quem tem a ação no módulo.
 * Por defeito RECUSA quem só tem alcance "own" (o procedimento tem de filtrar
 * o que é do próprio e dizê-lo com `{ allowOwn: true }`). O alcance de cidade
 * continua a ser aplicado pelo middleware (cityScope) a quem não é nacional.
 *
 * Acesso EFETIVO = papel + overrides por utilizador (shared/access.ts →
 * grantFor). Os overrides vêm do próprio `user` (ctx.user leva-os, postos
 * pelo middleware) ou do contexto do pedido (server/_core/accessContext.ts):
 * uma consulta por pedido, nunca uma por verificação.
 */
import { TRPCError } from "@trpc/server";
import { activeOverride, can, grantFor, scopeFor, rolesBelow, type Access, type AccessOverrides, type Action, type ModuleId } from "../../shared/access";
import { adjustCityScope, requestOverrides } from "./accessContext";

export { can, scopeFor };

type U = { id?: number; role: string; accessOverrides?: AccessOverrides | null };

/** O utilizador com os overrides do pedido (se o objeto ainda não os trouxer). */
export function withOverrides<T extends U>(user: T): T {
  if (user.accessOverrides !== undefined) return user;
  const ov = requestOverrides(user.id);
  return ov ? { ...user, accessOverrides: ov } : user;
}

export function requireAccess(user: U | null | undefined, module: ModuleId, action: Action = "view", opts: { allowOwn?: boolean } = {}): Access {
  const u = user ? withOverrides(user) : null;
  const g = grantFor(u, module);
  if (!u || g.access === "none" || !g.actions.includes(action) || (g.access === "own" && !opts.allowOwn)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
  }
  adjustCityScope(u.id, g.access, activeOverride(u, module) != null);
  return g.access;
}

/** Só o próprio (alcance "own") — o chamador filtra pelo que é dele. */
export function isOwnOnly(user: U, module: ModuleId): boolean {
  return scopeFor(withOverrides(user), module) === "own";
}

/**
 * Contas ABAIXO de `user` na sua cidade (para "criadas por ele ou por quem
 * está abaixo"). Inclui sempre o próprio. A cidade vem do cityScope do pedido.
 */
export async function userIdsAtOrBelowInCity(user: { id: number; role: string }): Promise<number[]> {
  const below = rolesBelow(user.role);
  const { getDb } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const { projectScope } = await import("../cityScope");
  const db = await getDb();
  if (!db || below.length === 0) return [user.id];
  const [rows] = await db.execute(sql`SELECT DISTINCT u.id FROM users u
    JOIN employees e ON e.userId = u.id
    WHERE u.role IN (${sql.join(below.map(r => sql`${r}`), sql`, `)}) AND ${projectScope(sql`e.projectId`)}`) as any;
  return [...new Set([user.id, ...((rows as any[]) ?? []).map(r => Number(r.id))])];
}

/**
 * Condição SQL "ficha abaixo de quem vê" (sobre employees.id): conta com
 * role abaixo; sem conta, posto extra/driver/senior_driver (abaixo do TL).
 */
export async function employeeBelowCondition(user: { role: string }, employeeIdCol: import("drizzle-orm").SQLWrapper) {
  const { sql } = await import("drizzle-orm");
  const below = rolesBelow(user.role);
  if (below.length === 0) return sql`1 = 0`;
  const inList = sql.join(below.map(r => sql`${r}`), sql`, `);
  return sql`EXISTS (SELECT 1 FROM employees below_e LEFT JOIN users below_u ON below_u.id = below_e.userId
    WHERE below_e.id = ${employeeIdCol} AND (
      (below_u.id IS NOT NULL AND below_u.role IN (${inList}))
      OR (below_u.id IS NULL AND below_e.position IN ('extra', 'driver', 'senior_driver'))))`;
}
