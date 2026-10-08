/**
 * 49c: leituras/escritas do "volta a entrar como utilizador" no login (regra
 * em shared/comeback.ts; aplicação em server/comebackLogin.ts). Separado para
 * os testes das rotas do login trocarem a BD. Nada se apaga.
 */
import { sql } from "drizzle-orm";
import type { LoginFicha } from "../shared/comeback";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];
const nowSql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

async function database() {
  const { getDb } = await import("./db");
  return getDb();
}

/** Fichas onde esta conta é a principal ou conta extra (employee_accounts). */
export async function loadLoginFichas(userId: number): Promise<LoginFicha[] | null> {
  const d = await database();
  if (!d) return null;
  const rows = rowsOf(await d.execute(sql`SELECT e.id, e.position, e.isActive, e.deactivationReason, e.blockedManually, e.blockedByDocs, e.blockedByPenalties, e.loginBlockedReason
      FROM employees e
     WHERE e.userId = ${userId}
        OR EXISTS (SELECT 1 FROM employee_accounts a WHERE a.employeeId = e.id AND a.userId = ${userId})`));
  return rows.map((r) => ({
    id: Number(r.id), position: r.position ?? null, isActive: Number(r.isActive), deactivationReason: r.deactivationReason ?? null,
    blockedManually: Number(r.blockedManually ?? 0), blockedByDocs: Number(r.blockedByDocs ?? 0), blockedByPenalties: Number(r.blockedByPenalties ?? 0),
    loginBlockedReason: r.loginBlockedReason ?? null,
  }));
}

/** A conta volta a abrir como UTILIZADOR (o motivo da conta limpa-se; o da ficha fica). */
export async function reactivateAccountAsUser(userId: number): Promise<void> {
  const d = await database();
  if (!d) return;
  await d.execute(sql`UPDATE users SET isActive = 1, role = 'user', deactivationReason = NULL, deactivationReasonOther = NULL,
      deactivationNotes = NULL, deactivatedAt = NULL, deactivatedById = NULL
    WHERE id = ${userId} AND isActive = 0 AND role IN ('user', 'extra', 'condutor')`);
}

/**
 * 41a → 49c: a ficha "Suspensa: sem atividade" passa a INATIVA (motivo
 * Inatividade), sai o bloqueio manual e a conta fica como utilizador.
 */
export async function convertSuspensionToInactive(employeeId: number, userId: number): Promise<void> {
  const d = await database();
  if (!d) return;
  await d.execute(sql`UPDATE employees SET isActive = 0, deactivationReason = 'inatividade', deactivationReasonOther = NULL,
      deactivationNotes = ${'Estava "Suspenso: sem atividade" (41a); passou a inativo ao voltar a entrar.'}, deactivatedAt = ${nowSql()}, deactivatedById = NULL,
      blockedManually = 0
    WHERE id = ${employeeId} AND isActive = 1 AND blockedManually = 1`);
  const { recomputeLoginBlocked } = await import("./rhService");
  await recomputeLoginBlocked(employeeId);
  await d.execute(sql`UPDATE users SET role = 'user' WHERE id = ${userId} AND role IN ('extra', 'condutor')`);
}

export async function logComeback(userId: number, employeeId: number, details: string): Promise<void> {
  try {
    const { logActivity } = await import("./db");
    await logActivity({ userId, action: "comeback_login", entity: "employee", entityId: employeeId, details, source: "ui" } as any);
  } catch { /* registo */ }
}
