/**
 * RH: quem está a ver e o que pode ver/fazer numa ficha (saiu do routers.ts a
 * 1 out 2026, P2 — só mudança de sítio). Usado pelo router `rh`, pela
 * disponibilidade dos extras, pelo /api/file e pelo Drive das fichas.
 * Regras puras em server/rhAccess.ts.
 */
import { TRPCError } from "@trpc/server";
import { scopedProjectIds, assertEmployeeAccess, cityScope } from './cityScope';
import { requireAccess } from "./_core/access";
import { canViewDocuments, canViewTimeAndSchedule, canEditPersonal, isOwn, CENTER_SCOPED_ROLES, type RhViewer, type EmployeeRef, isRhAdmin, canReadEmployeeRecord, canManageEmployee } from "./rhAccess";
import { getUserById, resolveProjectIds, getEmployeeById, getEmployeeByUserId } from "./db";

// ─── RH: quem está a ver (permissões por finalidade — server/rhAccess.ts) ────
export async function rhViewer(user: { id: number; role: string }): Promise<RhViewer> {
  const me = await getEmployeeByUserId(user.id);
  let scope: number[] | null = null;
  let scopeAll = false;
  // 41c: o supervisor gere a SUA CIDADE (as cidades do pedido: centro de
  // custos + permissões de cidade); fora de um pedido (sem âmbito), o centro
  // da ficha dele, como antes. O team leader fica no centro da ficha.
  const access = user.role === "supervisor" ? cityScope.getStore() : undefined;
  if (access) {
    if (access.all) scopeAll = true;
    else scope = access.projectIds;
  } else if ((CENTER_SCOPED_ROLES as readonly string[]).includes(user.role)) {
    const pid = me?.employee?.projectId ?? null;
    scope = pid != null ? await resolveProjectIds(pid) : [];
  }
  return { id: user.id, role: user.role, employeeId: me?.employee?.id ?? null, scopeProjectIds: scope, ...(scopeAll ? { scopeAll } : {}) };
}
/** Referência da ficha COM o role da conta associada (para proteger fichas de admin/super_admin). */
export async function rhEmployeeRef(employeeId: number): Promise<EmployeeRef | null> {
  const e = await getEmployeeById(employeeId);
  if (!e) return null;
  // 41c: o posto conta para quem não tem conta (o supervisor gere de team leader para baixo).
  return { id: e.employee.id, projectId: e.employee.projectId ?? null, role: await employeeAccountRole(e.employee.userId ?? null), position: e.employee.position ?? null };
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

/**
 * 41c: gerir a ficha (horário, ausências, ponto, ativar/desativar): o módulo
 * RH com "gerir", a ficha na cidade de quem pede, e canManageEmployee
 * (admin+, ou o supervisor nas fichas de quem está abaixo dele).
 */
export async function assertCanManageEmployee(user: { id: number; role: string }, employeeId: number, message = "Sem permissão para gerir esta ficha."): Promise<void> {
  requireAccess(user as any, "rh", "manage");
  await assertEmployeeAccess(employeeId);
  const viewer = await rhViewer(user);
  const ref = await rhEmployeeRefOrThrow(employeeId);
  if (!canManageEmployee(viewer, ref)) throw new TRPCError({ code: "FORBIDDEN", message });
}

/**
 * 41c: o que mexe em TODAS as cidades (varrimentos de identidade, listas de
 * todos os agentes, configuração geral, faltas de todo o país) fica com quem
 * gere o RH de todas as cidades — o supervisor gere a dele.
 */
export const NATIONAL_ONLY_MESSAGE = "Isto mexe em todas as cidades: é com quem gere o RH de todas as cidades (administrador).";
export function requireNationalRhManage(user: { id: number; role: string }): void {
  requireAccess(user as any, "rh", "manage");
  if (scopedProjectIds() !== undefined) throw new TRPCError({ code: "FORBIDDEN", message: NATIONAL_ONLY_MESSAGE });
}

/**
 * 41c: ligar/soltar um agente da Multipark tira-o a quem o tinha. Com âmbito
 * de cidade, só se quem o tem (ficha principal ou agente extra) for da tua
 * cidade — senão pede-se a um administrador.
 */
export async function assertAgentHoldersInScope(agent: { agentUserId?: string | null; agentName?: string | null }): Promise<void> {
  const allowed = scopedProjectIds();
  if (allowed === undefined) return;
  const { getDb } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
  const id = agent.agentUserId?.trim() || null, name = agent.agentName?.trim() || null;
  if (!id && !name) return;
  const rows = ((await db.execute(sql`
    SELECT e.id, e.projectId FROM employees e
     WHERE (${id} IS NOT NULL AND e.multiparkAgentUserId = ${id}) OR (${name} IS NOT NULL AND e.multiparkAgentName = ${name})
    UNION
    SELECT e.id, e.projectId FROM employee_agents a JOIN employees e ON e.id = a.employeeId
     WHERE ${id} IS NOT NULL AND a.agentUserId = ${id}
     LIMIT 20`)) as any)[0] as Array<{ id: number; projectId: number | null }> ?? [];
  if (rows.some((r) => r.projectId == null || !allowed.includes(Number(r.projectId)))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Este agente está ligado a uma ficha de outra cidade: pede a um administrador." });
  }
}

/** 41c: a ficha de um registo (ponto, ausência, penalização) — para o âmbito de cidade nas escritas por id. */
export async function employeeIdOfRecord(table: "time_records" | "employee_leaves" | "employee_penalties", id: number): Promise<number | null> {
  const { getDb } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
  const rows = ((await db.execute(sql`SELECT employeeId FROM ${sql.raw(`\`${table}\``)} WHERE id = ${id} LIMIT 1`)) as any)[0] as Array<{ employeeId: number | null }> ?? [];
  const v = rows[0]?.employeeId;
  return v == null ? null : Number(v);
}
