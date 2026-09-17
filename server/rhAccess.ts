/**
 * PERMISSÕES DE RH POR FINALIDADE — regra única para fichas, documentos,
 * horário, ponto e ordenados.
 *
 * VER (listas operacionais: nome, posto, nível, foto, centro, contacto):
 *   - frontoffice e acima: toda a gente; extra/user: só a própria ficha.
 *
 * DADOS PESSOAIS (NIF, NIB, morada, nascimento, nacionalidade, contactos
 * pessoais, foto, documentos) — pedido Jorge 17 set 2026:
 *   - toda a gente mexe na PRÓPRIA ficha (é o próprio que mete e valida os
 *     seus dados), mas nunca no que é contratual;
 *   - team_leader, supervisor e frontoffice: as fichas do SEU centro de
 *     custos (com descendentes);
 *   - backoffice: todos os centros de custos;
 *   - admin: tudo menos fichas de super_admin;
 *   - super_admin: tudo.
 *   Fichas de admin/super_admin ficam fora do alcance de quem está abaixo.
 *
 * CONTRATUAL (posto, centro, tipo/datas de contrato, salário, subsídio,
 * conta associada, ativo/inativo, email de trabalho): só admin+ — e um admin
 * não toca na ficha de um super_admin.
 */
export type RhRole = string;

const RANK: Record<string, number> = { super_admin: 7, admin: 6, supervisor: 5, team_leader: 4, backoffice: 3, frontoffice: 2, extra: 1, user: 0 };
export const rank = (role: string) => RANK[role] ?? -1;

export interface RhViewer {
  id: number;
  role: string;
  /** ficha do próprio (se existir) */
  employeeId: number | null;
  /** centros (com descendentes) que supervisor/team_leader/frontoffice gerem */
  scopeProjectIds: number[] | null;
}

export interface EmployeeRef {
  id: number;
  projectId: number | null;
  /** role da conta associada à ficha (null/undefined = sem conta ou desconhecido) */
  role?: string | null;
}

/** Papéis cujo âmbito é o PRÓPRIO centro de custos (com descendentes). */
export const CENTER_SCOPED_ROLES = ["supervisor", "team_leader", "frontoffice"] as const;

export function isOwn(v: RhViewer, employeeId: number): boolean {
  return v.employeeId != null && v.employeeId === employeeId;
}

function inScope(v: RhViewer, e: EmployeeRef): boolean {
  return e.projectId != null && (v.scopeProjectIds ?? []).includes(e.projectId);
}

/** A ficha é de alguém admin+ com mais poder do que quem está a ver? */
export function isProtectedTarget(v: RhViewer, e: EmployeeRef): boolean {
  const target = rank(e.role ?? "");
  return target >= RANK.admin && rank(v.role) < target;
}

/** Pode ver a ficha (resumo operacional)? */
export function canViewEmployee(v: RhViewer, e: EmployeeRef): boolean {
  if (rank(v.role) >= RANK.admin) return true;
  if (isOwn(v, e.id)) return true;
  if (v.role === "supervisor") return inScope(v, e);
  return rank(v.role) >= RANK.frontoffice;   // listas operacionais
}

/** Pode ver E editar os dados PESSOAIS (NIF, NIB, morada, contactos, foto, documentos)? */
export function canEditPersonal(v: RhViewer, e: EmployeeRef): boolean {
  if (isOwn(v, e.id)) return true;
  if (isProtectedTarget(v, e)) return false;
  if (rank(v.role) >= RANK.admin) return true;
  if (v.role === "backoffice") return true;
  if ((CENTER_SCOPED_ROLES as readonly string[]).includes(v.role)) return inScope(v, e);
  return false;
}

/** Pode editar o CONTRATUAL (posto, centro, contrato, salário, conta, ativo)? admin+, nunca acima de si. */
export function canEditContract(v: RhViewer, e: EmployeeRef): boolean {
  if (rank(v.role) < RANK.admin) return false;
  return !isProtectedTarget(v, e);
}

/** Pode ver dados SENSÍVEIS de gestão (salário, subsídio, bloqueio, desativação)? admin+ (não protegido) ou o próprio. */
export function canViewSensitive(v: RhViewer, e: EmployeeRef): boolean {
  if (isOwn(v, e.id)) return true;
  return canEditContract(v, e);
}

/** Pode ver/abrir/carregar documentos pessoais? Quem pode mexer nos dados pessoais. */
export function canViewDocuments(v: RhViewer, e: EmployeeRef): boolean {
  return canEditPersonal(v, e);
}

/** Pode apagar um documento? admin+ (não protegido), ou quem o carregou e ainda pode mexer na ficha. */
export function canDeleteDocument(v: RhViewer, e: EmployeeRef, uploadedById: number | null | undefined): boolean {
  if (canEditContract(v, e)) return true;
  return uploadedById != null && uploadedById === v.id && canEditPersonal(v, e);
}

/** Pode ver horário e registos de ponto? quem vê documentos, ou team_leader (operação). */
export function canViewTimeAndSchedule(v: RhViewer, e: EmployeeRef): boolean {
  if (canViewDocuments(v, e)) return true;
  return v.role === "team_leader";
}

/** Campos da ficha que são DADOS PESSOAIS (o próprio e os gestores do centro editam). */
export const PERSONAL_FIELDS = ["fullName", "phone", "personalEmail", "personalPhone", "nif", "nib", "address", "birthDate", "nationality", "photoUrl", "photoKey"] as const;
/** Campos CONTRATUAIS / de gestão (só admin+). */
export const CONTRACT_FIELDS = ["email", "position", "extraLevel", "department", "projectId", "contractType", "contractStart", "contractEnd", "monthlySalary", "mealAllowancePerDay", "userId", "isActive"] as const;

// Sensível pessoal: escondido a quem só vê a lista operacional.
const PERSONAL_SENSITIVE = ["nif", "nib", "address", "birthDate", "nationality", "personalEmail", "personalPhone"] as const;
// Sensível de gestão: só admin+ (não protegido) ou o próprio. O MOTIVO/notas
// da desativação (0071) seguem a mesma regra do motivo de bloqueio: quem só
// vê a lista operacional vê "Inativo", nunca o porquê.
const ADMIN_SENSITIVE = ["monthlySalary", "mealAllowancePerDay", "loginBlockedReason", "docsWarningAt", "deactivationReason", "deactivationReasonOther", "deactivationNotes", "deactivatedById"] as const;

/** Remove campos sensíveis quando o visualizador não os pode ver. `role` é o da conta associada à ficha. */
export function sanitizeEmployee<T extends Record<string, any>>(v: RhViewer, emp: T, role?: string | null): T {
  const ref: EmployeeRef = { id: emp.id, projectId: emp.projectId ?? null, role: role ?? null };
  if (canViewSensitive(v, ref)) return emp;
  const out: Record<string, any> = { ...emp };
  for (const f of ADMIN_SENSITIVE) if (f in out) out[f] = null;
  if (!canEditPersonal(v, ref)) for (const f of PERSONAL_SENSITIVE) if (f in out) out[f] = null;
  return out as T;
}

/** Aplica a lista: filtra o que não pode ver e limpa o sensível. `roleOf` dá o role da conta de cada ficha. */
export function sanitizeEmployeeRows<T extends { employee: Record<string, any> }>(
  v: RhViewer,
  rows: T[],
  roleOf?: (emp: Record<string, any>) => string | null | undefined,
): T[] {
  return rows
    .filter((r) => canViewEmployee(v, { id: r.employee.id, projectId: r.employee.projectId ?? null }))
    .map((r) => ({ ...r, employee: sanitizeEmployee(v, r.employee, roleOf?.(r.employee) ?? null) }));
}

/** O que o visualizador pode fazer nesta ficha — vai para o cliente decidir a UI. */
export function employeeAccess(v: RhViewer, e: EmployeeRef) {
  return {
    isOwn: isOwn(v, e.id),
    canEditPersonal: canEditPersonal(v, e),
    canEditContract: canEditContract(v, e),
    canViewSensitive: canViewSensitive(v, e),
    canViewDocuments: canViewDocuments(v, e),
  };
}
export type EmployeeAccess = ReturnType<typeof employeeAccess>;

/** admin+ vê tudo — mesmo fichas que já não existem (listas vazias, checklists). */
export function isRhAdmin(v: RhViewer): boolean {
  return rank(v.role) >= RANK.admin;
}
