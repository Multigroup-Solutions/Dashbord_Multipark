/**
 * Âmbito e filtros das DESPESAS — regra única para lista, detalhe, totais,
 * comparação, Excel e documentos.
 *
 * Antes cada procedimento tinha a sua cópia (a lista filtrava por perfil, a
 * comparação não; o Excel não tinha requireRole; o filtro de cidade ignorava
 * marcas/projetos filhos). Agora:
 *   - `resolveExpenseVisibility(user)` diz O QUE o utilizador pode ver
 *     (tudo / as suas / as suas + centro de custos com descendentes / nada);
 *   - `expenseConditions(filters, vis)` traduz filtros + visibilidade em SQL;
 *   - `canSeeExpense(vis, row)` aplica a MESMA regra a uma linha (detalhe,
 *     documento).
 * Restrições individuais (deny `finance.view_totals`) prevalecem sobre o
 * perfil; um filtro visual nunca alarga o acesso — só o restringe.
 */
import { and, eq, gte, inArray, like, lte, or, sql, type SQL } from "drizzle-orm";
import { expenses } from "../drizzle/schema";
import { dayBounds } from "../shared/expensePeriods";

export type ExpenseVisibility =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "own"; userId: number }
  | { kind: "own_or_projects"; userId: number; projectIds: number[] };

export interface VisibilityDeps {
  /** deny explícito de uma permissão para o utilizador */
  denied: (userId: number, permission: string) => Promise<boolean>;
  /** centro de custos da ficha de RH do utilizador (supervisor) */
  employeeProjectId: (userId: number) => Promise<number | null>;
  /** centro + descendentes (marca global = id negativo) */
  resolveProjectIds: (projectId: number) => Promise<number[]>;
}

export async function resolveExpenseVisibility(
  user: { id: number; role: string },
  deps: VisibilityDeps,
): Promise<ExpenseVisibility> {
  const role = user.role;
  if (role === "super_admin" || role === "admin") {
    // Regra Jorge: com deny de totais, mesmo admin "vê as despesas que ele
    // meteu, mas não vê o total".
    if (await deps.denied(user.id, "finance.view_totals")) return { kind: "own", userId: user.id };
    return { kind: "all" };
  }
  if (role === "supervisor") {
    if (await deps.denied(user.id, "finance.view_totals")) return { kind: "own", userId: user.id };
    const pid = await deps.employeeProjectId(user.id);
    const projectIds = pid != null ? await deps.resolveProjectIds(pid) : [];
    return { kind: "own_or_projects", userId: user.id, projectIds };
  }
  if (role === "backoffice" || role === "team_leader") {
    // Inserem e acompanham as PRÓPRIAS; nunca totais da empresa.
    return { kind: "own", userId: user.id };
  }
  return { kind: "none" };
}

/** True se o utilizador pode ver totais/agregados do que o filtro devolve. */
export function canSeeAggregates(vis: ExpenseVisibility): boolean {
  return vis.kind === "all" || vis.kind === "own_or_projects";
}

export function canSeeExpense(
  vis: ExpenseVisibility,
  row: { insertedById: number; projectId: number | null },
): boolean {
  switch (vis.kind) {
    case "all": return true;
    case "none": return false;
    case "own": return row.insertedById === vis.userId;
    case "own_or_projects":
      return row.insertedById === vis.userId || (row.projectId != null && vis.projectIds.includes(row.projectId));
  }
}

/** Condição SQL da visibilidade; `null` = sem restrição. */
export function visibilityCondition(vis: ExpenseVisibility): SQL | null {
  switch (vis.kind) {
    case "all": return null;
    case "none": return sql`1 = 0`;
    case "own": return eq(expenses.insertedById, vis.userId);
    case "own_or_projects": {
      const own = eq(expenses.insertedById, vis.userId);
      if (vis.projectIds.length === 0) return own;
      return or(own, inArray(expenses.projectId, vis.projectIds)) as SQL;
    }
  }
}

export interface ExpenseListFilters {
  startDate?: string;      // YYYY-MM-DD (dia de calendário, inclusivo)
  endDate?: string;        // YYYY-MM-DD (inclusivo, dia inteiro)
  projectIds?: number[];   // centro escolhido + descendentes (já resolvidos)
  categoryId?: number;
  userId?: number;         // quem inseriu
  status?: string;
  search?: string;
  excludeCancelled?: boolean;
}

/** Traduz filtros + visibilidade em condições drizzle (AND). */
export function expenseConditions(filters: ExpenseListFilters, vis: ExpenseVisibility): SQL[] {
  const c: SQL[] = [];
  const { start, end } = dayBounds(filters.startDate, filters.endDate);
  if (start) c.push(gte(expenses.expenseDate, start));
  if (end) c.push(lte(expenses.expenseDate, end));
  if (filters.projectIds) {
    // Filtro por centro SEM correspondência (ex.: marca global sem nós) → nada,
    // nunca "tudo".
    c.push(filters.projectIds.length ? inArray(expenses.projectId, filters.projectIds) : sql`1 = 0`);
  }
  if (filters.categoryId) c.push(eq(expenses.categoryId, filters.categoryId));
  if (filters.userId) c.push(eq(expenses.insertedById, filters.userId));
  if (filters.status) c.push(eq(expenses.status, filters.status as any));
  else if (filters.excludeCancelled) c.push(sql`${expenses.status} <> 'cancelled'`);
  if (filters.search) {
    const term = `%${filters.search.trim()}%`;
    c.push(or(like(expenses.supplier, term), like(expenses.description, term), like(expenses.documentNumber, term)) as SQL);
  }
  const v = visibilityCondition(vis);
  if (v) c.push(v);
  return c;
}

export function whereAll(conds: SQL[]): SQL | undefined {
  return conds.length ? (and(...conds) as SQL) : undefined;
}
