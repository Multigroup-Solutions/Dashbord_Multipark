/**
 * RH: quem está a ver e o que pode ver/fazer numa ficha (saiu do routers.ts a
 * 1 out 2026, P2 — só mudança de sítio). Usado pelo router `rh`, pela
 * disponibilidade dos extras, pelo /api/file e pelo Drive das fichas.
 * Regras puras em server/rhAccess.ts.
 */
import { TRPCError } from "@trpc/server";
import { scopedProjectIds, assertEmployeeAccess } from './cityScope';
import { requireAccess } from "./_core/access";
import { canViewDocuments, canViewTimeAndSchedule, canEditPersonal, isOwn, CENTER_SCOPED_ROLES, type RhViewer, type EmployeeRef, isRhAdmin, canReadEmployeeRecord } from "./rhAccess";
import { getUserById, resolveProjectIds, getEmployeeById, getEmployeeByUserId } from "./db";

// ─── RH: quem está a ver (permissões por finalidade — server/rhAccess.ts) ────
export async function rhViewer(user: { id: number; role: string }): Promise<RhViewer> {
  const me = await getEmployeeByUserId(user.id);
  let scope: number[] | null = null;
  // supervisor, team_leader e frontoffice mexem nas fichas do SEU centro de
  // custos (com descendentes) — o centro da ficha, não a cidade inteira.
  if ((CENTER_SCOPED_ROLES as readonly string[]).includes(user.role)) {
    const pid = me?.employee?.projectId ?? null;
    scope = pid != null ? await resolveProjectIds(pid) : [];
  }
  return { id: user.id, role: user.role, employeeId: me?.employee?.id ?? null, scopeProjectIds: scope };
}
/** Referência da ficha COM o role da conta associada (para proteger fichas de admin/super_admin). */
export async function rhEmployeeRef(employeeId: number): Promise<EmployeeRef | null> {
  const e = await getEmployeeById(employeeId);
  if (!e) return null;
  return { id: e.employee.id, projectId: e.employee.projectId ?? null, role: await employeeAccountRole(e.employee.userId ?? null) };
}
export async function employeeAccountRole(userId: number | null): Promise<string | null> {
  if (userId == null) return null;
  const u = await getUserById(userId);
  return u?.role ?? null;
}
/** Ficha + o que o utilizador pode fazer nela; lança FORBIDDEN se não a pode ver. */
export async function rhEmployeeRefOrThrow(employeeId: number): Promise<EmployeeRef> {
  const ref = await rhEmployeeRef(employeeId);
  if (!ref) throw new TRPCError({ code: "NOT_FOUND", message: "Colaborador não encontrado" });
  return ref;
}
/** Âmbito de cidade nas escritas — a própria ficha passa sempre (pode nem ter centro). */
export async function assertEmployeeWriteScope(viewer: RhViewer, ref: EmployeeRef): Promise<void> {
  if (isOwn(viewer, ref.id)) return;
  await assertEmployeeAccess(ref.id);
}
/**
 * Leitura de registos de uma ficha (horas, férias, salário, penalizações):
 * a própria passa sempre; senão exige `minRole` e a ficha no âmbito de cidade
 * do pedido — também para admin (um admin limitado a uma cidade não lê
 * outra). Regra pura em rhAccess.canReadEmployeeRecord.
 */
export async function assertOwnOrScopedEmployee(user: { id: number; role: string }, employeeId: number, minRole: string): Promise<void> {
  const me = await getEmployeeByUserId(user.id);
  const viewer = { role: user.role, employeeId: me?.employee?.id ?? null };
  if (viewer.employeeId === employeeId) return;
  const target = await getEmployeeById(employeeId);
  const ok = canReadEmployeeRecord(viewer, { id: employeeId, projectId: target?.employee.projectId ?? null }, minRole, scopedProjectIds());
  if (!ok) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
}
/** Documentos: quem mexe nos dados pessoais da ficha; sem ficha, só admin+ (checklists vazias). */
export async function assertCanViewDocuments(user: { id: number; role: string }, employeeId: number, message: string): Promise<void> {
  const viewer = await rhViewer(user);
  // documentos de outra pessoa respeitam o módulo RH (incluindo um override "nenhum")
  if (!isOwn(viewer, employeeId)) requireAccess(user as any, "rh", "view");
  const ref = await rhEmployeeRef(employeeId);
  const allowed = ref ? canViewDocuments(viewer, ref) : isRhAdmin(viewer);
  if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message });
}
/** Registos de ponto (e fotos do ponto) de uma ficha: o próprio, admin de RH, ou quem vê tempos e escalas dela, dentro das cidades. */
export async function assertCanViewTimeRecords(user: { id: number; role: string }, employeeId: number): Promise<void> {
  const viewer = await rhViewer(user);
  const ref = await rhEmployeeRef(employeeId);
  if (!isRhAdmin(viewer) && (!ref || !canViewTimeAndSchedule(viewer, ref))) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
  if (!isOwn(viewer, employeeId)) await assertEmployeeAccess(employeeId);
}
export async function assertCanUploadDocuments(user: { id: number; role: string }, employeeId: number): Promise<void> {
  const viewer = await rhViewer(user);
  const ref = await rhEmployeeRefOrThrow(employeeId);
  if (!canEditPersonal(viewer, ref)) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para carregar documentos nesta ficha" });
  await assertEmployeeWriteScope(viewer, ref);
}
