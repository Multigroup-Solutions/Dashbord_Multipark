/**
 * Tarefas de candidatura (BD). Regras puras em shared/leadTasks.ts.
 *
 *  - `syncLeadTasks`: cria a tarefa das candidaturas novas que ainda não a têm
 *    e fecha as das candidaturas já tratadas. Corre de hora a hora com as
 *    outras tarefas automáticas (`runTaskAutomation`) e logo a seguir a uma
 *    candidatura nova chegar pelo site;
 *  - `closeResolvedLeadTasks`: só o fecho — chamado depois de qualquer
 *    mudança nos leads/candidaturas (converter, Sem interesse, arquivar,
 *    aprovar/rejeitar a candidatura), para a tarefa fechar logo.
 * Idempotente: a chave única da 0545 (`leadSourceKey`) impede duas tarefas
 * para o mesmo lead, e o fecho só mexe nas abertas. Nunca lança para fora
 * dos ganchos (best-effort): uma falha aqui não estraga o lead.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "./db";
import { employees, extraLeads, projects, taskAssignees, taskComments, tasks, users } from "../drizzle/schema";
import {
  LEAD_TASK_CLOSED_STATUSES,
  LEAD_TASK_LEAD_SOURCES,
  LEAD_TASK_OPEN_STATUSES,
  LEAD_TASK_SOURCE,
  leadTaskAction,
  leadTaskAssignees,
  leadTaskCloseComment,
  leadTaskCutoffMysql,
  leadTaskDescription,
  leadTaskDueMs,
  leadTaskKey,
  leadTaskTitle,
} from "../shared/leadTasks";

const mysqlNow = (ms: number = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const affected = (res: any): number => Number(res?.[0]?.affectedRows ?? res?.affectedRows ?? 0);
const isDuplicateEntry = (err: any): boolean => (err?.code ?? err?.cause?.code) === "ER_DUP_ENTRY";

/** Máximo de tarefas criadas / fechadas por corrida (o resto fica para a seguinte). */
const LEAD_TASKS_BATCH = 200;

export interface LeadTasksReport { created: number; closed: number; skipped: number; failed: number; errors: string[] }

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Ficha ativa de quem criou o lead (leads à mão / futuras origens com dono). */
async function ownerEmployeeId(db: Db, userId: number | null): Promise<number | null> {
  if (userId == null || userId <= 0) return null;
  const [e] = await db.select({ id: employees.id }).from(employees)
    .where(and(eq(employees.userId, userId), sql`${employees.isActive} = 1`)).limit(1);
  return e?.id ?? null;
}

/** Fichas ativas dos supervisores (conta ativa) da cidade do lead e dos seus descendentes. */
async function citySupervisorEmployeeIds(db: Db, cityProjectId: number | null): Promise<number[]> {
  if (cityProjectId == null) return [];
  const { resolveProjectIds } = await import("./db");
  const ids = await resolveProjectIds(cityProjectId);
  if (!ids.length) return [];
  const rows = await db.select({ id: employees.id }).from(employees)
    .innerJoin(users, eq(users.id, employees.userId))
    .where(and(inArray(employees.projectId, ids), sql`${employees.isActive} = 1`, eq(users.role, "supervisor"), sql`${users.isActive} = 1`))
    .orderBy(employees.id);
  return rows.map((r) => r.id);
}

/**
 * Fecha as tarefas abertas das candidaturas já tratadas (convertidas, Sem
 * interesse, arquivadas), com um comentário a dizer porquê. Idempotente;
 * nunca lança. Devolve quantas fechou.
 */
export async function closeResolvedLeadTasks(opts: { leadIds?: readonly number[] } = {}): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const conds: SQL[] = [
      sql`${tasks.sourceModule} = ${LEAD_TASK_SOURCE}`, sql`${tasks.taskStatus} <> 'done'`, sql`${tasks.archivedAt} IS NULL`,
      sql`(${inArray(extraLeads.status, [...LEAD_TASK_CLOSED_STATUSES])} OR ${extraLeads.archivedAt} IS NOT NULL)`,
    ];
    if (opts.leadIds?.length) conds.push(inArray(extraLeads.id, [...opts.leadIds]));
    const rows = await db.select({ taskId: tasks.id, status: extraLeads.status, archivedAt: extraLeads.archivedAt })
      .from(tasks).innerJoin(extraLeads, eq(extraLeads.id, tasks.sourceId))
      .where(and(...conds)).limit(LEAD_TASKS_BATCH);
    if (!rows.length) return 0;
    const { getSystemUserId } = await import("./db");
    const systemUser = await getSystemUserId();
    let closed = 0;
    for (const r of rows) {
      // Fecho "reclamado": duas corridas ao mesmo tempo não comentam duas vezes.
      const res = await db.update(tasks)
        .set({ taskStatus: "done", completedAt: mysqlNow(), notifiedComplete: 1 })
        .where(and(eq(tasks.id, r.taskId), sql`${tasks.taskStatus} <> 'done'`));
      if (affected(res) === 0) continue;
      await db.insert(taskComments).values({ taskId: r.taskId, userId: systemUser, body: leadTaskCloseComment({ status: String(r.status), archivedAt: r.archivedAt }) });
      closed++;
    }
    return closed;
  } catch (err) {
    console.warn("[leadTasks] fechar tarefas de candidatura:", String((err as any)?.message ?? err).slice(0, 160));
    return 0;
  }
}

/**
 * Cria a tarefa das candidaturas abertas (site/email) que entraram nos
 * últimos dias e ainda não têm nenhuma (arquivada conta), e fecha as das
 * tratadas. `leadIds` limita a esses leads (gancho do site).
 */
export async function syncLeadTasks(now: Date = new Date(), opts: { leadIds?: readonly number[] } = {}): Promise<LeadTasksReport> {
  const out: LeadTasksReport = { created: 0, closed: 0, skipped: 0, failed: 0, errors: [] };
  const db = await getDb();
  if (!db) return out;
  const nowMs = now.getTime();
  out.closed = await closeResolvedLeadTasks(opts);

  const conds: SQL[] = [
    inArray(extraLeads.source, [...LEAD_TASK_LEAD_SOURCES]),
    inArray(extraLeads.status, [...LEAD_TASK_OPEN_STATUSES]),
    sql`${extraLeads.archivedAt} IS NULL`,
    sql`${extraLeads.createdAt} >= ${leadTaskCutoffMysql(nowMs)}`,
    sql`NOT EXISTS (SELECT 1 FROM tasks lt WHERE lt.sourceModule = ${LEAD_TASK_SOURCE} AND lt.sourceId = ${extraLeads.id})`,
  ];
  if (opts.leadIds?.length) conds.push(inArray(extraLeads.id, [...opts.leadIds]));
  const leads = await db.select({
    id: extraLeads.id, fullName: extraLeads.fullName, source: extraLeads.source, status: extraLeads.status,
    archivedAt: extraLeads.archivedAt, createdAt: extraLeads.createdAt, createdById: extraLeads.createdById,
    projectId: extraLeads.projectId, phone: extraLeads.phone, email: extraLeads.email, notes: extraLeads.notes,
  }).from(extraLeads).where(and(...conds)).orderBy(extraLeads.id).limit(LEAD_TASKS_BATCH);
  if (!leads.length) return out;

  const { getSystemUserId } = await import("./db");
  const systemUser = await getSystemUserId();
  const cityNames = new Map((await db.select({ id: projects.id, name: projects.name }).from(projects)).map((p) => [p.id, p.name]));
  const supervisorsBy = new Map<number, number[]>();
  for (const lead of leads) {
    if (leadTaskAction(lead as any, null, nowMs) !== "create") { out.skipped++; continue; }
    try {
      let supervisors: number[] = [];
      const owner = await ownerEmployeeId(db, lead.createdById ?? null);
      if (owner == null && lead.projectId != null) {
        if (!supervisorsBy.has(lead.projectId)) supervisorsBy.set(lead.projectId, await citySupervisorEmployeeIds(db, lead.projectId));
        supervisors = supervisorsBy.get(lead.projectId)!;
      }
      const ids = leadTaskAssignees({ ownerEmployeeId: owner, supervisorEmployeeIds: supervisors });
      const [res] = await db.insert(tasks).values({
        title: leadTaskTitle(lead.fullName),
        description: leadTaskDescription(lead, lead.projectId != null ? cityNames.get(lead.projectId) ?? null : null),
        projectId: lead.projectId ?? null,
        assigneeId: ids[0] ?? null,
        createdById: systemUser,
        taskStatus: "todo",
        taskPriority: "medium",
        dueDate: mysqlNow(leadTaskDueMs(lead.createdAt)),
        dueHasTime: 1,
        sourceModule: LEAD_TASK_SOURCE,
        sourceId: lead.id,
        sourceKey: leadTaskKey(lead.id),
      });
      const taskId = Number((res as any).insertId);
      if (taskId && ids.length) await db.insert(taskAssignees).values(ids.map((employeeId) => ({ taskId, employeeId })));
      out.created++;
    } catch (err: any) {
      // Chave única (0545): outra corrida (site + cron) criou-a ao mesmo tempo.
      if (isDuplicateEntry(err)) { out.skipped++; continue; }
      out.failed++;
      out.errors.push(`lead #${lead.id}: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  return out;
}

/** Gancho best-effort (nunca lança): depois de uma mudança nos leads/candidaturas. */
export async function afterLeadChange(leadIds?: readonly number[]): Promise<void> {
  try {
    await closeResolvedLeadTasks(leadIds?.length ? { leadIds } : {});
  } catch { /* já registado em closeResolvedLeadTasks */ }
}
