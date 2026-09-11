/**
 * PERMISSÕES DE RH POR FINALIDADE — regra única para fichas, documentos,
 * horário, ponto e ordenados.
 *
 *   - admin/super_admin: tudo;
 *   - supervisor: as fichas do seu centro de custos (com descendentes) e a sua;
 *   - frontoffice/team_leader/backoffice: listas OPERACIONAIS (nome, posto,
 *     nível, foto, centro, contacto) — sem dados pessoais sensíveis nem
 *     documentos de terceiros; a própria ficha completa;
 *   - extra/user: só a própria ficha, documentos, horário e ponto.
 * Dados sensíveis (NIF, NIB, morada, nascimento, nacionalidade, salário,
 * alimentação, motivo de bloqueio) só para admin+ ou o próprio.
 */
export type RhRole = string;

const RANK: Record<string, number> = { super_admin: 7, admin: 6, supervisor: 5, team_leader: 4, backoffice: 3, frontoffice: 2, extra: 1, user: 0 };
export const rank = (role: string) => RANK[role] ?? -1;

export interface RhViewer {
  id: number;
  role: string;
  /** ficha do próprio (se existir) */
  employeeId: number | null;
  /** centros (com descendentes) que um supervisor gere */
  scopeProjectIds: number[] | null;
}

export interface EmployeeRef { id: number; projectId: number | null }

export function isOwn(v: RhViewer, employeeId: number): boolean {
  return v.employeeId != null && v.employeeId === employeeId;
}

/** Pode ver a ficha (resumo operacional)? */
export function canViewEmployee(v: RhViewer, e: EmployeeRef): boolean {
  if (rank(v.role) >= RANK.admin) return true;
  if (isOwn(v, e.id)) return true;
  if (v.role === "supervisor") return e.projectId != null && (v.scopeProjectIds ?? []).includes(e.projectId);
  return rank(v.role) >= RANK.frontoffice;   // listas operacionais
}

/** Pode ver dados SENSÍVEIS (NIF, NIB, morada, nascimento, salário)? */
export function canViewSensitive(v: RhViewer, e: EmployeeRef): boolean {
  if (rank(v.role) >= RANK.admin) return true;
  return isOwn(v, e.id);
}

/** Pode ver/abrir documentos pessoais? admin+, o próprio, ou supervisor do centro. */
export function canViewDocuments(v: RhViewer, e: EmployeeRef): boolean {
  if (rank(v.role) >= RANK.admin) return true;
  if (isOwn(v, e.id)) return true;
  if (v.role === "supervisor") return e.projectId != null && (v.scopeProjectIds ?? []).includes(e.projectId);
  return false;
}

/** Pode ver horário e registos de ponto? admin+, o próprio, supervisor do centro, team_leader (operação). */
export function canViewTimeAndSchedule(v: RhViewer, e: EmployeeRef): boolean {
  if (canViewDocuments(v, e)) return true;
  return v.role === "team_leader";
}

// O MOTIVO/notas da desativação (0071) seguem a mesma regra do motivo de
// bloqueio: quem só vê a lista operacional vê "Inativo", nunca o porquê.
const SENSITIVE_FIELDS = ["nif", "nib", "address", "birthDate", "nationality", "monthlySalary", "mealAllowancePerDay", "loginBlockedReason", "docsWarningAt", "personalEmail", "personalPhone", "deactivationReason", "deactivationReasonOther", "deactivationNotes", "deactivatedById"] as const;

/** Remove campos sensíveis quando o visualizador não os pode ver. */
export function sanitizeEmployee<T extends Record<string, any>>(v: RhViewer, emp: T): T {
  if (canViewSensitive(v, { id: emp.id, projectId: emp.projectId ?? null })) return emp;
  const out: Record<string, any> = { ...emp };
  for (const f of SENSITIVE_FIELDS) if (f in out) out[f] = null;
  return out as T;
}

/** Aplica a lista: filtra o que não pode ver e limpa o sensível. */
export function sanitizeEmployeeRows<T extends { employee: Record<string, any> }>(v: RhViewer, rows: T[]): T[] {
  return rows
    .filter((r) => canViewEmployee(v, { id: r.employee.id, projectId: r.employee.projectId ?? null }))
    .map((r) => ({ ...r, employee: sanitizeEmployee(v, r.employee) }));
}

/** admin+ vê tudo — mesmo fichas que já não existem (listas vazias, checklists). */
export function isRhAdmin(v: RhViewer): boolean {
  return rank(v.role) >= RANK.admin;
}
