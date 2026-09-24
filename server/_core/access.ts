/**
 * Verificação de acessos no servidor — aplica a matriz de shared/access.ts.
 *
 * requireAccess(user, módulo, ação) só deixa passar quem tem a ação no módulo.
 * Por defeito RECUSA quem só tem alcance "own" (o procedimento tem de filtrar
 * o que é do próprio e dizê-lo com `{ allowOwn: true }`). O alcance de cidade
 * continua a ser aplicado pelo middleware (cityScope) a quem não é nacional.
 */
import { TRPCError } from "@trpc/server";
import { can, grantFor, scopeFor, rolesBelow, type Access, type Action, type ModuleId } from "../../shared/access";

export { can, scopeFor };

type U = { id?: number; role: string };

export function requireAccess(user: U | null | undefined, module: ModuleId, action: Action = "view", opts: { allowOwn?: boolean } = {}): Access {
  const g = grantFor(user?.role, module);
  if (!user || g.access === "none" || !g.actions.includes(action) || (g.access === "own" && !opts.allowOwn)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
  }
  return g.access;
}

/** Só o próprio (alcance "own") — o chamador filtra pelo que é dele. */
export function isOwnOnly(user: U, module: ModuleId): boolean {
  return scopeFor(user.role, module) === "own";
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
