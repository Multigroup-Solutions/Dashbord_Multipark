/**
 * Ecrã "Ligações" do RH (Fase 4): o que ainda falta ligar entre fichas,
 * utilizadores e agentes Multipark, com sugestões aceites num clique. Usa a
 * mesma auditoria do script de reconciliação (server/identityReconcile.ts).
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { buildIdentityAudit, loadIdentitySnapshot } from "./identityReconcile";
import { scopedProjectIds } from "./cityScope";

const LIMIT = 150;

export interface LinksOverview {
  counts: { employeesActive: number; withUser: number; withAgent: number; users: number; agents: number };
  employeesWithoutUser: { employeeId: number; fullName: string; email: string; existingUserId: number | null }[];
  employeesNoEmail: { employeeId: number; fullName: string }[];
  usersWithoutEmployee: { userId: number; email: string | null; name: string | null; role: string }[];
  agentsToAttach: { agentUserId: string; agentName: string; actions: number; lastAction: string | null; suggestions: { employeeId: number; fullName: string }[] }[];
  agentsUnmatched: { agentUserId: string; agentName: string; email: string | null; actions: number; lastAction: string | null }[];
  conflicts: { kind: string; text: string }[];
}

export async function getLinksOverview(): Promise<LinksOverview> {
  const empty: LinksOverview = { counts: { employeesActive: 0, withUser: 0, withAgent: 0, users: 0, agents: 0 }, employeesWithoutUser: [], employeesNoEmail: [], usersWithoutEmployee: [], agentsToAttach: [], agentsUnmatched: [], conflicts: [] };
  const db = await getDb();
  if (!db) return empty;
  const snap = await loadIdentitySnapshot(db as any);
  const audit = buildIdentityAudit(snap);

  // Âmbito de cidade: quem só vê uma cidade só vê as fichas dela
  const scope = scopedProjectIds();
  let allowed: Set<number> | null = null;
  if (scope !== undefined) {
    const rows = ((await db.execute(sql`SELECT id, projectId FROM employees`)) as any)[0] as any[];
    allowed = new Set(rows.filter((r) => r.projectId != null && scope.includes(Number(r.projectId))).map((r) => Number(r.id)));
  }
  const inScope = (id: number) => !allowed || allowed.has(id);
  const empName = new Map(snap.employees.map((e) => [e.id, e.fullName]));
  const active = snap.employees.filter((e) => e.isActive === 1 && inScope(e.id));

  const out: LinksOverview = {
    counts: {
      employeesActive: active.length,
      withUser: active.filter((e) => e.userId).length,
      withAgent: active.filter((e) => e.multiparkAgentUserId || e.multiparkAgentName).length,
      users: snap.users.filter((u) => u.isActive === 1).length,
      agents: snap.agents.length,
    },
    employeesWithoutUser: audit.employeesWithoutUser
      .filter((e) => e.isActive === 1 && inScope(e.employeeId))
      .slice(0, LIMIT)
      .map((e) => ({ employeeId: e.employeeId, fullName: e.fullName, email: e.email, existingUserId: e.existingUserId })),
    employeesNoEmail: active.filter((e) => !e.userId && !e.email).slice(0, LIMIT).map((e) => ({ employeeId: e.id, fullName: e.fullName })),
    usersWithoutEmployee: allowed ? [] : audit.usersWithoutEmployee.slice(0, LIMIT),
    agentsToAttach: audit.agentsToAttach
      .map((a) => ({
        agentUserId: a.agentUserId,
        agentName: a.agentNames[0] ?? a.agentUserId,
        actions: a.actions,
        lastAction: a.lastAction,
        suggestions: a.emailMatchEmployeeIds.filter(inScope).map((id) => ({ employeeId: id, fullName: empName.get(id) ?? `#${id}` })),
      }))
      .filter((a) => a.suggestions.length > 0)
      .slice(0, LIMIT),
    agentsUnmatched: audit.agentsUnmatched
      .filter((a) => a.actions > 0)
      .sort((a, b) => b.actions - a.actions)
      .slice(0, LIMIT)
      .map((a) => ({ agentUserId: a.agentUserId, agentName: a.agentNames[0] ?? a.agentUserId, email: a.agentEmails[0] ?? null, actions: a.actions, lastAction: a.lastAction })),
    conflicts: [],
  };

  const name = (id: number) => `${empName.get(id) ?? "?"} (#${id})`;
  for (const g of audit.usersWithSeveralActiveEmployees) if (g.employeeIds.some(inScope)) out.conflicts.push({ kind: "Utilizador em várias fichas ativas", text: `Utilizador #${g.userId}: ${g.employeeIds.map(name).join(", ")}` });
  for (const g of audit.agentsLinkedToSeveralEmployees) if (g.employeeIds.some(inScope)) out.conflicts.push({ kind: "Agente em várias fichas ativas", text: `Agente ${g.agentUserId}: ${g.employeeIds.map(name).join(", ")}` });
  for (const g of audit.duplicateEmployees) if (g.rows.some((r) => r.isActive === 1 && inScope(r.id))) out.conflicts.push({ kind: "Fichas com o mesmo email", text: `${g.email}: ${g.rows.map((r) => name(r.id)).join(", ")}` });
  if (!allowed) for (const g of audit.duplicateUsers) out.conflicts.push({ kind: "Utilizadores com o mesmo email", text: `${g.email}: ${g.rows.map((u) => `#${u.id}${u.isActive ? "" : " (inativo)"}`).join(", ")}` });
  for (const m of audit.employeeUserEmailMismatch) if (inScope(m.employeeId)) out.conflicts.push({ kind: "Email da ficha ≠ email do utilizador", text: `${name(m.employeeId)}: ficha ${m.employeeEmail ?? "—"} · utilizador #${m.userId} ${m.userEmail ?? "—"}` });
  for (const d of audit.employeesDanglingUser) if (inScope(d.employeeId)) out.conflicts.push({ kind: "Ficha ligada a utilizador inexistente", text: `${name(d.employeeId)} → utilizador #${d.userId}` });
  out.conflicts = out.conflicts.slice(0, LIMIT);
  return out;
}

/** Liga uma ficha a um utilizador (sem roubar: o utilizador não pode estar noutra ficha ativa). */
export async function linkEmployeeToUser(employeeId: number, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const rows = ((await db.execute(sql`SELECT id, fullName FROM employees WHERE userId = ${userId} AND isActive = 1 AND id <> ${employeeId} LIMIT 1`)) as any)[0] as any[];
  if (rows?.[0]) throw new Error(`Esse utilizador já está na ficha ${rows[0].fullName} (#${rows[0].id}).`);
  await db.execute(sql`UPDATE employees SET userId = ${userId} WHERE id = ${employeeId}`);
}

/** Liga um agente Multipark (id + nome canónico) a uma ficha; tira-o de quem o tivesse. */
export async function linkAgentToEmployee(agentUserId: string, employeeId: number): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const top = ((await db.execute(sql`
    SELECT agentName, COUNT(*) AS n FROM multipark_booking_history
     WHERE agentUserId = ${agentUserId} AND agentName IS NOT NULL AND agentName <> ''
     GROUP BY agentName ORDER BY n DESC LIMIT 1`)) as any)[0] as any[];
  const agentName = top?.[0]?.agentName ? String(top[0].agentName) : agentUserId;
  await db.execute(sql`UPDATE employees SET multiparkAgentUserId = NULL WHERE multiparkAgentUserId = ${agentUserId}`);
  await db.execute(sql`UPDATE employees SET multiparkAgentName = NULL WHERE multiparkAgentName = ${agentName}`);
  await db.execute(sql`UPDATE employees SET multiparkAgentUserId = ${agentUserId}, multiparkAgentName = ${agentName.slice(0, 256)} WHERE id = ${employeeId}`);
  return agentName;
}
