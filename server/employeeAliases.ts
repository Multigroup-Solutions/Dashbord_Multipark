/**
 * Contas e agentes EXTRA de uma ficha (migração 0081). A pessoa é a ficha:
 * pode entrar com o email profissional e com o pessoal, e pode ter mais do que
 * um agente Multipark. O principal continua em employees.userId /
 * multiparkAgentUserId — aqui ficam os restantes.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r) as any[]) ?? [];

/** Ficha de um utilizador que é conta EXTRA (null se não for). */
export async function employeeIdForAliasUser(userId: number): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const [r] = rowsOf(await db.execute(sql`SELECT employeeId FROM employee_accounts WHERE userId = ${userId} LIMIT 1`));
    return r ? Number(r.employeeId) : null;
  } catch {
    return null; // tabela ainda não criada
  }
}

/**
 * Junta `userId` como conta extra da ficha. A conta extra herda o role e o
 * estado da conta principal (a mesma pessoa tem as mesmas permissões).
 */
export async function addAccountAlias(employeeId: number, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const [emp] = rowsOf(await db.execute(sql`SELECT userId FROM employees WHERE id = ${employeeId} LIMIT 1`));
  if (!emp) throw new Error("Ficha não encontrada");
  if (Number(emp.userId) === userId) return; // já é a principal
  const [other] = rowsOf(await db.execute(sql`SELECT id, fullName FROM employees WHERE userId = ${userId} AND isActive = 1 AND id <> ${employeeId} LIMIT 1`));
  if (other) throw new Error(`Essa conta já é a principal da ficha ${other.fullName} (#${other.id}).`);
  await db.execute(sql`INSERT INTO employee_accounts (userId, employeeId) VALUES (${userId}, ${employeeId})
                        ON DUPLICATE KEY UPDATE employeeId = VALUES(employeeId)`);
  if (emp.userId) {
    await db.execute(sql`UPDATE users a JOIN users p ON p.id = ${Number(emp.userId)}
                            SET a.role = p.role, a.department = COALESCE(a.department, p.department)
                          WHERE a.id = ${userId}`);
  }
}

export async function removeAccountAlias(userId: number): Promise<void> {
  const db = await getDb();
  if (db) await db.execute(sql`DELETE FROM employee_accounts WHERE userId = ${userId}`);
}

/** Junta um agente Multipark extra à ficha (tira-o de onde estivesse). */
export async function addAgentAlias(employeeId: number, agentUserId: string, agentName: string | null): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  await db.execute(sql`INSERT INTO employee_agents (agentUserId, employeeId, agentName) VALUES (${agentUserId}, ${employeeId}, ${agentName})
                        ON DUPLICATE KEY UPDATE employeeId = VALUES(employeeId), agentName = VALUES(agentName)`);
}

export async function removeAgentAlias(agentUserId: string): Promise<void> {
  const db = await getDb();
  if (db) await db.execute(sql`DELETE FROM employee_agents WHERE agentUserId = ${agentUserId}`);
}

export interface AgentAlias { agentUserId: string; employeeId: number; agentName: string | null }

export async function listAgentAliases(): Promise<AgentAlias[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    return rowsOf(await db.execute(sql`SELECT agentUserId, employeeId, agentName FROM employee_agents`)).map((r) => ({
      agentUserId: String(r.agentUserId), employeeId: Number(r.employeeId), agentName: r.agentName ? String(r.agentName) : null,
    }));
  } catch {
    return [];
  }
}

export interface EmployeeAliasList {
  accounts: { userId: number; email: string | null; name: string | null }[];
  agents: AgentAlias[];
}

/** Todas as contas/agentes extra (para o ecrã Ligações). */
export async function listAllAliases(): Promise<{ accounts: { userId: number; employeeId: number; email: string | null }[]; agents: AgentAlias[] }> {
  const db = await getDb();
  if (!db) return { accounts: [], agents: [] };
  let accounts: { userId: number; employeeId: number; email: string | null }[] = [];
  try {
    accounts = rowsOf(await db.execute(sql`SELECT a.userId, a.employeeId, u.email FROM employee_accounts a LEFT JOIN users u ON u.id = a.userId`)).map((r) => ({
      userId: Number(r.userId), employeeId: Number(r.employeeId), email: r.email ? String(r.email) : null,
    }));
  } catch { /* tabela ainda não criada */ }
  return { accounts, agents: await listAgentAliases() };
}
