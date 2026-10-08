/**
 * Ativar / desativar uma FICHA com tudo o que vai com ela (saiu do
 * rh.setActive a 8 out 2026, 49c, para o "Pôr inativo" das sugestões usar a
 * mesma cascata):
 *
 *  - desativar: a conta principal e as contas extra ativas desativam-se com o
 *    mesmo motivo (dentro da tranca do último super_admin; a tua nunca);
 *  - ativar: a conta principal reativa-se e, se estava como "utilizador"
 *    (candidato aprovado, ou inativo que voltou), passa ao papel do posto
 *    (shared/comeback.ts → roleAfterActivation). O "Quer voltar" limpa-se.
 *
 * As permissões (quem pode, cidade) verificam-se ANTES, em quem chama.
 * Nada se apaga.
 */
import { TRPCError } from "@trpc/server";
import { getUserById, getEmployeeById, toggleUserActive, deactivationColumns, updateEmployee, countActiveSuperAdmins, logActivity } from "./db";
import { superAdminGuard } from "./userAdminRules";
import { guardedAccountChange } from "./superAdminLock";
import type { ResolvedDeactivation } from "../shared/deactivationReasons";

export interface DeactivateResult { cascadedUser: boolean; extraAccounts: number }

/**
 * Desativa a ficha + contas (mesma regra do ecrã Utilizadores: não te
 * desativas a ti próprio nem tiras o último super_admin). Lança FORBIDDEN
 * com a mensagem da guarda; nesse caso a ficha fica como estava.
 */
export async function deactivateEmployeeCascade(
  actor: { id: number },
  employeeId: number,
  deactivation: ResolvedDeactivation,
  opts: { logDetails?: string } = {},
): Promise<DeactivateResult> {
  const found = await getEmployeeById(employeeId);
  if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Colaborador não encontrado" });
  const meta = { ...deactivation, byUserId: actor.id };
  const userId = found.employee.userId;
  if (userId) {
    const acct = await getUserById(userId);
    const guard = acct ? superAdminGuard(actor.id, acct, null, await countActiveSuperAdmins()) : null;
    if (guard) throw new TRPCError({ code: "FORBIDDEN", message: guard });
    if (acct && acct.id === actor.id) throw new TRPCError({ code: "FORBIDDEN", message: "Não podes desativar a tua própria ficha." });
    // A conta desativa-se PRIMEIRO, dentro da tranca do último super_admin
    // (atómico); se a guarda recusar, a ficha fica como estava.
    if (acct) {
      const locked = await guardedAccountChange(userId, (t, n) => superAdminGuard(actor.id, t, null, n), (tx) => toggleUserActive(userId, false, meta, tx));
      if (locked) throw new TRPCError({ code: "FORBIDDEN", message: locked });
    }
  }
  // 41a: as contas EXTRA da pessoa também saem (a mesma guarda; a tua nunca)
  let extraOff = 0;
  const { activeExtraAccounts } = await import("./personIdentity");
  for (const xid of await activeExtraAccounts(employeeId).catch(() => [] as number[])) {
    if (xid === actor.id || xid === userId) continue;
    const locked = await guardedAccountChange(xid, (t, n) => superAdminGuard(actor.id, t, null, n), (tx) => toggleUserActive(xid, false, meta, tx));
    if (!locked) extraOff++;
  }
  await updateEmployee(employeeId, { isActive: 0, ...deactivationColumns(false, meta) } as any);
  await logActivity({
    userId: actor.id,
    action: "deactivate",
    entity: "employee",
    entityId: employeeId,
    details: opts.logDetails ?? `Desativado colaborador ${found.employee.fullName}${userId ? " + utilizador" : ""}${extraOff ? ` + ${extraOff} conta(s) extra` : ""} — ${deactivation.summary}`,
  });
  return { cascadedUser: !!userId, extraAccounts: extraOff };
}

export interface ActivateResult { cascadedUser: boolean; promotedRole: string | null }

/** Ativa a ficha + a conta principal; papel do posto se a conta estava como "utilizador". */
export async function activateEmployeeCascade(actor: { id: number }, employeeId: number): Promise<ActivateResult> {
  const found = await getEmployeeById(employeeId);
  if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "Colaborador não encontrado" });
  const wasCandidate = found.employee.deactivationReason === "candidato";
  await updateEmployee(employeeId, { isActive: 1, ...deactivationColumns(true, null), comebackRequestedAt: null } as any);
  const userId = found.employee.userId;
  if (userId) await toggleUserActive(userId, true, null);
  const promotedRole = await promoteRoleAfterActivation(actor, employeeId);
  await logActivity({
    userId: actor.id,
    action: "activate",
    entity: "employee",
    entityId: employeeId,
    details: `${wasCandidate ? "Candidato aprovado" : "Ativado"}: colaborador ${found.employee.fullName}${userId ? " + utilizador" : ""}${promotedRole ? ` (conta passou de Utilizador a ${promotedRole})` : ""}`,
  });
  return { cascadedUser: !!userId, promotedRole };
}

/**
 * Depois de ATIVAR uma ficha (aqui, na aprovação da candidatura ou ao
 * reativar a conta nos Utilizadores): a conta principal e as extra que estão
 * como "utilizador" passam ao papel do posto; limpa o "Quer voltar". Devolve o
 * papel novo (ou null). Nunca lança — uma falha fica no log do servidor.
 */
export async function promoteRoleAfterActivation(actor: { id: number }, employeeId: number): Promise<string | null> {
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return null;
    const { sql } = await import("drizzle-orm");
    const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r) as any[]) ?? [];
    const [e] = rowsOf(await db.execute(sql`SELECT id, fullName, position, userId, isActive FROM employees WHERE id = ${employeeId} LIMIT 1`));
    if (!e || Number(e.isActive) !== 1) return null;
    await db.execute(sql`UPDATE employees SET comebackRequestedAt = NULL WHERE id = ${employeeId} AND comebackRequestedAt IS NOT NULL`);
    const { roleForPosition } = await import("./identityReconcile");
    const { roleAfterActivation } = await import("../shared/comeback");
    const target = roleForPosition(String(e.position ?? ""));
    const accounts = rowsOf(await db.execute(sql`SELECT u.id, u.role FROM users u WHERE u.id = ${Number(e.userId ?? 0)} AND u.isActive = 1
      UNION ALL SELECT u.id, u.role FROM employee_accounts a JOIN users u ON u.id = a.userId WHERE a.employeeId = ${employeeId} AND u.isActive = 1`).catch(() => [[]]));
    let promoted: string | null = null;
    for (const a of accounts) {
      const next = roleAfterActivation(String(a.role ?? ""), target);
      if (!next) continue;
      await db.execute(sql`UPDATE users SET role = ${next} WHERE id = ${Number(a.id)} AND role = 'user'`);
      promoted = next;
      await logActivity({ userId: actor.id, action: "role_change", entity: "user", entityId: Number(a.id),
        details: `Papel: Utilizador → ${next} (ficha #${employeeId} ${e.fullName} ativada)` });
    }
    if (promoted) {
      const { invalidateLoginBlock } = await import("./loginBlock");
      invalidateLoginBlock();
    }
    return promoted;
  } catch (err: any) {
    console.warn(`[ativar ficha] papel do posto falhou para #${employeeId}:`, String(err?.message ?? err).slice(0, 160));
    return null;
  }
}
