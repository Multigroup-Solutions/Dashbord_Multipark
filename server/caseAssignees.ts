/**
 * Responsável de um caso (reclamação, perdido) — Jorge, 3 out 2026: só de
 * TEAM LEADER para cima. Condutores e extras já não veem Reclamações,
 * Críticas, Ocorrências nem Perdidos (D19), por isso não podem tratar um caso
 * nem receber os avisos dele.
 *
 * O responsável é uma FICHA (16b); conta o papel mais alto das contas ligadas
 * a ela (a principal e as extra). Ficha sem conta → não pode ser responsável.
 */
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { roleRank, ROLE_LABELS, type Role } from "../shared/access";

export const CASE_ASSIGNEE_MIN_ROLE: Role = "team_leader";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];

/** O papel conta para responsável? PURA. */
export function isCaseAssigneeRole(role: string | null | undefined): boolean {
  return roleRank(role) >= roleRank(CASE_ASSIGNEE_MIN_ROLE);
}

/** Papel mais alto das contas (ativas) de cada ficha. */
async function topRoleByEmployee(employeeIds?: readonly number[]): Promise<Map<number, { fullName: string; isActive: boolean; projectId: number | null; role: string | null }>> {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível");
  const only = employeeIds?.length ? sql`AND e.id IN (${sql.join(employeeIds.map((i) => sql`${i}`), sql`, `)})` : sql``;
  const rows = rowsOf(await (d as any).execute(sql`
    SELECT e.id, e.fullName, e.isActive, e.projectId, u.role
      FROM employees e JOIN users u ON u.id = e.userId AND u.isActive = 1
     WHERE 1 = 1 ${only}
    UNION ALL
    SELECT e.id, e.fullName, e.isActive, e.projectId, u.role
      FROM employee_accounts a JOIN employees e ON e.id = a.employeeId JOIN users u ON u.id = a.userId AND u.isActive = 1
     WHERE 1 = 1 ${only}`));
  const out = new Map<number, { fullName: string; isActive: boolean; projectId: number | null; role: string | null }>();
  for (const r of rows) {
    const id = Number(r.id);
    const prev = out.get(id);
    if (!prev || roleRank(r.role) > roleRank(prev.role)) {
      out.set(id, { fullName: String(r.fullName ?? ""), isActive: Number(r.isActive) === 1, projectId: r.projectId != null ? Number(r.projectId) : null, role: r.role ?? null });
    }
  }
  return out;
}

/** Quem pode ser responsável (ficha ativa, conta de team leader ou acima), no âmbito de cidade dado. */
export async function caseAssigneeOptions(projectIds?: readonly number[]): Promise<Array<{ id: number; fullName: string; role: string; roleLabel: string }>> {
  const all = await topRoleByEmployee();
  const allowed = projectIds ? new Set(projectIds) : null;
  return Array.from(all.entries())
    .filter(([, p]) => p.isActive && isCaseAssigneeRole(p.role))
    // Nacionais (sem cidade na ficha) aparecem sempre; os de cidade só na cidade de quem atribui.
    .filter(([, p]) => !allowed || p.projectId == null || allowed.has(p.projectId))
    .map(([id, p]) => ({ id, fullName: p.fullName, role: String(p.role), roleLabel: ROLE_LABELS[p.role as Role] ?? String(p.role) }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "pt"));
}

/**
 * Recusa um responsável NOVO abaixo de team leader. O que já lá estava (mesmo
 * valor) não é recusado — guardar o prazo não obriga a trocar já a pessoa.
 */
export async function assertCaseAssignee(next: number | null | undefined, current: number | null | undefined): Promise<void> {
  if (next == null || next === current) return;
  const p = (await topRoleByEmployee([next])).get(next);
  if (!p || !isCaseAssigneeRole(p.role)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "O responsável tem de ser team leader ou acima (condutores e extras não veem os casos)." });
  }
}
