/**
 * Tarefas — serviço (BD). Regras puras em shared/taskRules.ts.
 *
 *  - lista/estatísticas com âmbito de cidade + descendentes (projectFilterConds),
 *    filtro "as minhas" em SQL (join task_assignees) e concluídas antigas
 *    escondidas por omissão;
 *  - notificações agendadas (cron horário): atraso → criador + gestores da
 *    hierarquia (+ aviso in-app aos responsáveis); conclusão → criador;
 *  - origem: `closeTasksForSource(module, id)` fecha as tarefas ligadas quando
 *    o registo de origem fica resolvido;
 *  - disponibilidade a confirmar: 1 tarefa por pessoa × semana;
 *  - checklists recorrentes (task_templates) e comentários (task_comments).
 *
 * SQL sempre parametrizado; ONLY_FULL_GROUP_BY (só agregados/colunas agrupadas).
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, projectFilterConds } from "./db";
import { employeeScope, scopedProjectIds } from "./cityScope";
import { employees, projects, taskAssignees, taskComments, taskTemplates, tasks, users } from "../drizzle/schema";
import {
  TASK_HIDE_DONE_AFTER_DAYS,
  TASK_SOURCE_LABELS,
  availabilityTaskAssigneeEmail,
  availabilityTaskKey,
  availabilityTaskTitle,
  hierarchyManagerIds,
  isTaskOverdue,
  mondayOfDay,
  operationalDayOf,
  taskDeadlineMs,
  templateOccurrenceKey,
  templateOccurrencesFor,
  type TaskSourceModule,
  type TemplateShift,
} from "../shared/taskRules";
import { lisbonDayOf } from "../shared/lisbonDay";
import { handoverCityKey } from "../shared/shiftHandover";

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];
const mysqlNow = (ms: number = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

// ─── Âmbito ─────────────────────────────────────────────────────────────────

/** Tarefa sem projeto é transversal (visível a todos); com projeto tem de estar no âmbito. */
export function assertTaskScope(task: { projectId: number | null }): void {
  const ids = scopedProjectIds();
  if (ids !== undefined && task.projectId != null && !ids.includes(task.projectId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Esta tarefa não pertence às tuas cidades autorizadas." });
  }
}

/** Condição SQL "tarefa atribuída a esta pessoa" (coluna legada OU task_assignees). */
export function assignedToCond(employeeId: number): SQL {
  return sql`(${tasks.assigneeId} = ${employeeId} OR EXISTS (SELECT 1 FROM task_assignees ta_me
    WHERE ta_me.taskId = ${tasks.id} AND ta_me.employeeId = ${employeeId}))`;
}

// ─── Lista / estatísticas ───────────────────────────────────────────────────

export interface TaskListFilters {
  projectId?: number;
  status?: string;
  /** Só as tarefas desta pessoa (extras e "As minhas tarefas"). */
  employeeId?: number;
  /** Mostra concluídas há mais de 30 dias. */
  showOld?: boolean;
  /** Inclui sempre esta tarefa (link /tarefas?focus=id). */
  focusId?: number;
}

async function baseConds(f: TaskListFilters): Promise<SQL[]> {
  const conds: SQL[] = await projectFilterConds(tasks.projectId, f.projectId, { allowNull: true });
  if (f.status) conds.push(sql`${tasks.taskStatus} = ${f.status}`);
  if (f.employeeId != null) conds.push(assignedToCond(f.employeeId));
  return conds;
}

export async function listTasks(f: TaskListFilters = {}) {
  const db = await getDb();
  if (!db) return [];
  const conds = await baseConds(f);
  if (!f.showOld) {
    const cutoff = mysqlNow(Date.now() - TASK_HIDE_DONE_AFTER_DAYS * 86_400_000);
    const hide = sql`NOT (${tasks.taskStatus} = 'done' AND COALESCE(${tasks.completedAt}, ${tasks.updatedAt}) < ${cutoff})`;
    conds.push(f.focusId ? sql`(${hide} OR ${tasks.id} = ${f.focusId})` : hide);
  }
  const taskRows = await db
    .select({ task: tasks, projectName: projects.name })
    .from(tasks)
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(...conds))
    .orderBy(desc(tasks.updatedAt))
    .limit(2000);
  if (!taskRows.length) return [];
  const ids = taskRows.map((r) => r.task.id);
  const assigneeRows = await db
    .select({ taskId: taskAssignees.taskId, employeeId: taskAssignees.employeeId, fullName: employees.fullName })
    .from(taskAssignees)
    .innerJoin(employees, eq(employees.id, taskAssignees.employeeId))
    .where(inArray(taskAssignees.taskId, ids));
  const commentRows = rowsOf(await db.execute(sql`SELECT taskId, COUNT(*) AS n FROM task_comments
    WHERE taskId IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) GROUP BY taskId`).catch(() => [[]]));
  const byTask = new Map<number, Array<{ id: number; fullName: string }>>();
  for (const r of assigneeRows) {
    if (!byTask.has(r.taskId)) byTask.set(r.taskId, []);
    byTask.get(r.taskId)!.push({ id: r.employeeId, fullName: r.fullName });
  }
  const comments = new Map(commentRows.map((r) => [Number(r.taskId), Number(r.n)]));
  return taskRows.map((r) => ({
    ...r.task,
    projectName: r.projectName,
    assignees: byTask.get(r.task.id) ?? [],
    commentsCount: comments.get(r.task.id) ?? 0,
  }));
}

export async function taskStats(f: TaskListFilters = {}) {
  const empty = { total: 0, backlog: 0, todo: 0, inProgress: 0, review: 0, done: 0, overdue: 0 };
  const db = await getDb();
  if (!db) return empty;
  const conds = await baseConds({ ...f, status: undefined });
  const today = lisbonDayOf(Date.now());
  const now = mysqlNow();
  const overdueExpr = sql`(${tasks.taskStatus} <> 'done' AND ${tasks.dueDate} IS NOT NULL AND (
    (${tasks.dueHasTime} = 1 AND ${tasks.dueDate} <= ${now})
    OR (${tasks.dueHasTime} = 0 AND DATE(${tasks.dueDate}) < ${today})))`;
  const rows = await db
    .select({ status: tasks.taskStatus, n: sql<number>`COUNT(*)`, overdue: sql<number>`SUM(CASE WHEN ${overdueExpr} THEN 1 ELSE 0 END)` })
    .from(tasks)
    .where(and(...conds))
    .groupBy(tasks.taskStatus);
  const out = { ...empty };
  for (const r of rows) {
    const n = Number(r.n) || 0;
    out.total += n;
    out.overdue += Number(r.overdue) || 0;
    if (r.status === "backlog") out.backlog = n;
    else if (r.status === "todo") out.todo = n;
    else if (r.status === "in_progress") out.inProgress = n;
    else if (r.status === "review") out.review = n;
    else if (r.status === "done") out.done = n;
  }
  return out;
}

export async function getTaskWithAssignees(id: number) {
  const db = await getDb();
  if (!db) return null;
  const [t] = await db.select({ task: tasks, projectName: projects.name }).from(tasks)
    .leftJoin(projects, eq(projects.id, tasks.projectId)).where(eq(tasks.id, id)).limit(1);
  if (!t) return null;
  const a = await db.select({ id: taskAssignees.employeeId, fullName: employees.fullName, userId: employees.userId })
    .from(taskAssignees).innerJoin(employees, eq(employees.id, taskAssignees.employeeId))
    .where(eq(taskAssignees.taskId, id));
  return { ...t.task, projectName: t.projectName, assignees: a.map((x) => ({ id: x.id, fullName: x.fullName, userId: x.userId })) };
}

/** Pessoas que podem ser responsáveis (ativas, no âmbito de cidade; opcionalmente na árvore de um projeto). */
export async function assignableEmployees(projectIds?: number[] | null) {
  const db = await getDb();
  if (!db) return [];
  const conds: SQL[] = [sql`${employees.isActive} = 1`, employeeScope(employees.id)];
  if (projectIds && projectIds.length) conds.push(sql`(${employees.projectId} IS NULL OR ${inArray(employees.projectId, projectIds)})`);
  return db.select({ id: employees.id, fullName: employees.fullName, projectId: employees.projectId })
    .from(employees).where(and(...conds)).orderBy(employees.fullName).limit(3000);
}

export async function deleteTaskCascade(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.delete(taskAssignees).where(eq(taskAssignees.taskId, id));
  await db.delete(taskComments).where(eq(taskComments.taskId, id)).catch(() => undefined);
  await db.delete(tasks).where(eq(tasks.id, id));
}

// ─── Notificações ───────────────────────────────────────────────────────────

type Notify = (n: { userId: number; title: string; body: string; link: string }) => Promise<void>;

async function defaultNotify(n: { userId: number; title: string; body: string; link: string }) {
  const { createNotification } = await import("./complaintsExtended");
  await createNotification({ userId: n.userId, title: n.title, body: n.body, kind: "task", link: n.link });
}

async function emailUser(userId: number, subject: string, text: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const [u] = await db.select({ email: users.email, name: users.name, isActive: users.isActive }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u?.email || !u.isActive) return;
  const { sendEmail } = await import("./_core/notification");
  await sendEmail({ to: u.email, subject, text: `Olá ${u.name ?? ""},\n\n${text}` });
}

/**
 * Corre de hora a hora (extras-auto) e no botão "Verificar agora":
 *  - atraso (fim do dia de Lisboa / hora exata) → criador + gestores da
 *    hierarquia (in-app; email ao criador) + aviso in-app aos responsáveis;
 *  - concluída → criador (in-app + email), exceto se foi ele a concluir.
 * Cada tarefa só avisa 1× (notifiedOverdue/notifiedComplete).
 */
export async function runTaskNotifications(now: Date = new Date(), notify: Notify = defaultNotify): Promise<{ overdue: number; completed: number; details: string[] }> {
  const db = await getDb();
  const out = { overdue: 0, completed: 0, details: [] as string[] };
  if (!db) return out;
  const nowMs = now.getTime();
  // Pré-filtro barato em SQL (o prazo real ≥ dueDate); decisão final no helper puro.
  const candidates = await db.select().from(tasks).where(and(
    sql`${tasks.dueDate} IS NOT NULL`, sql`${tasks.dueDate} <= ${mysqlNow(nowMs)}`,
    sql`COALESCE(${tasks.notifiedOverdue}, 0) = 0`, sql`${tasks.taskStatus} <> 'done'`,
  )).limit(500);
  const overdue = candidates.filter((t) => isTaskOverdue(t, nowMs));
  const completed = await db.select().from(tasks).where(and(
    eq(tasks.taskStatus, "done"), sql`COALESCE(${tasks.notifiedComplete}, 0) = 0`,
  )).limit(500);
  if (!overdue.length && !completed.length) return out;

  // Hierarquia de projetos carregada UMA vez por corrida.
  const allProjects = await db.select({ id: projects.id, parentId: projects.parentId, managerId: projects.managerId }).from(projects);
  const ids = [...new Set([...overdue, ...completed].map((t) => t.id))];
  const assignees = ids.length ? await db.select({ taskId: taskAssignees.taskId, userId: employees.userId, fullName: employees.fullName })
    .from(taskAssignees).innerJoin(employees, eq(employees.id, taskAssignees.employeeId))
    .where(inArray(taskAssignees.taskId, ids)) : [];
  const byTask = new Map<number, typeof assignees>();
  for (const a of assignees) { if (!byTask.has(a.taskId)) byTask.set(a.taskId, []); byTask.get(a.taskId)!.push(a); }

  for (const t of overdue) {
    // Marca primeiro (claim): duas corridas em paralelo não avisam 2×.
    const res: any = await db.update(tasks).set({ notifiedOverdue: 1 }).where(and(eq(tasks.id, t.id), sql`COALESCE(${tasks.notifiedOverdue}, 0) = 0`));
    if (Number(res?.[0]?.affectedRows ?? res?.affectedRows ?? 1) === 0) continue;
    const link = `/tarefas?focus=${t.id}`;
    const people = byTask.get(t.id) ?? [];
    const names = people.map((p) => p.fullName).join(", ") || "sem responsável";
    const deadline = taskDeadlineMs(t);
    const when = deadline ? new Date(deadline - 1).toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" }) : "?";
    const body = `A tarefa "${t.title}" passou o prazo (${when}). Responsáveis: ${names}.`;
    const managers = new Set<number>([t.createdById, ...hierarchyManagerIds(allProjects, t.projectId)].filter((x): x is number => x != null));
    for (const userId of managers) {
      try { await notify({ userId, title: `Tarefa em atraso: ${t.title}`.slice(0, 255), body, link }); } catch (e) { console.warn("[tasks] notify overdue:", e); }
    }
    for (const p of people) {
      if (p.userId == null || managers.has(p.userId)) continue;
      try { await notify({ userId: p.userId, title: `A tua tarefa está em atraso: ${t.title}`.slice(0, 255), body: `Prazo: ${when}.`, link }); } catch (e) { console.warn("[tasks] notify overdue (resp.):", e); }
    }
    try { await emailUser(t.createdById, `Tarefa em atraso: ${t.title}`, `${body}\n\nAbrir: ${link}`); } catch (e) { console.warn("[tasks] email overdue:", e); }
    out.overdue++; out.details.push(`Em atraso: ${t.title}`);
  }

  for (const t of completed) {
    const res: any = await db.update(tasks).set({ notifiedComplete: 1 }).where(and(eq(tasks.id, t.id), sql`COALESCE(${tasks.notifiedComplete}, 0) = 0`));
    if (Number(res?.[0]?.affectedRows ?? res?.affectedRows ?? 1) === 0) continue;
    const completedBy = t.completedById;
    // Tarefas automáticas (origem resolvida/modelo) não geram alerta de conclusão.
    if (t.sourceModule && t.sourceModule !== "manual") { out.details.push(`Concluída (auto): ${t.title}`); continue; }
    if (completedBy != null && completedBy === t.createdById) continue;
    const people = (byTask.get(t.id) ?? []).map((p) => p.fullName).join(", ") || "sem responsável";
    const body = `A tarefa "${t.title}" foi concluída. Responsáveis: ${people}.`;
    const link = `/tarefas?focus=${t.id}`;
    try { await notify({ userId: t.createdById, title: `Tarefa concluída: ${t.title}`.slice(0, 255), body, link }); } catch (e) { console.warn("[tasks] notify done:", e); }
    try { await emailUser(t.createdById, `Tarefa concluída: ${t.title}`, `${body}\n\nAbrir: ${link}`); } catch (e) { console.warn("[tasks] email done:", e); }
    out.completed++; out.details.push(`Concluída: ${t.title}`);
  }
  return out;
}

// ─── Origem → fecho automático ──────────────────────────────────────────────

/**
 * Fecha (done) as tarefas abertas ligadas a um registo de origem. `key`
 * restringe (ex.: availability:<pessoa>:<semana>). Nunca lança.
 */
export async function closeTasksForSource(module: TaskSourceModule | string, id: number, key?: string | null): Promise<number> {
  try {
    const db = await getDb();
    if (!db) return 0;
    const conds: SQL[] = [sql`${tasks.sourceModule} = ${module}`, sql`${tasks.sourceId} = ${id}`, sql`${tasks.taskStatus} <> 'done'`];
    if (key) conds.push(sql`${tasks.sourceKey} = ${key}`);
    const res: any = await db.update(tasks)
      .set({ taskStatus: "done", completedAt: mysqlNow(), notifiedComplete: 0 })
      .where(and(...conds));
    return Number(res?.[0]?.affectedRows ?? res?.affectedRows ?? 0);
  } catch (err) {
    console.warn("[tasks] closeTasksForSource:", String((err as any)?.message ?? err).slice(0, 160));
    return 0;
  }
}

// ─── Disponibilidade a confirmar ────────────────────────────────────────────

/**
 * Resposta de disponibilidade que precisa de decisão humana: UMA tarefa por
 * pessoa × semana ("Disponibilidade a confirmar: <nome>"). Respostas seguintes
 * da mesma semana entram como comentário. Responsável: env
 * AVAILABILITY_TASK_ASSIGNEE_EMAIL (fallback: RH histórico).
 */
export async function upsertAvailabilityTask(input: {
  employeeId: number;
  day: string; // weekStart ou dia pedido
  detail: string;
}): Promise<{ taskId: number | null; created: boolean }> {
  const db = await getDb();
  if (!db) return { taskId: null, created: false };
  const key = availabilityTaskKey(input.employeeId, input.day);
  const weekStart = mondayOfDay(input.day.slice(0, 10));
  const { getSystemUserId, findEmployeeByEmailOrName } = await import("./db");
  const systemUser = await getSystemUserId();
  const [existing] = await db.select({ id: tasks.id }).from(tasks)
    .where(and(sql`${tasks.sourceKey} = ${key}`, sql`${tasks.taskStatus} <> 'done'`)).limit(1);
  if (existing) {
    await db.insert(taskComments).values({ taskId: existing.id, userId: systemUser, body: input.detail.slice(0, 5000) });
    await db.update(tasks).set({ updatedAt: mysqlNow() }).where(eq(tasks.id, existing.id));
    return { taskId: existing.id, created: false };
  }
  const [emp] = await db.select({ fullName: employees.fullName, projectId: employees.projectId }).from(employees).where(eq(employees.id, input.employeeId)).limit(1);
  const [res] = await db.insert(tasks).values({
    title: availabilityTaskTitle(emp?.fullName),
    description: `Semana de ${weekStart}. Resposta por email que precisa de confirmação humana (o sistema não marcou nada).\n\n${input.detail}`.slice(0, 20_000),
    projectId: emp?.projectId ?? null,
    createdById: systemUser,
    taskStatus: "todo",
    taskPriority: "medium",
    sourceModule: "availability",
    sourceId: input.employeeId,
    sourceKey: key,
  });
  const taskId = Number((res as any).insertId);
  try {
    const owner = await findEmployeeByEmailOrName(availabilityTaskAssigneeEmail(process.env));
    if (owner && taskId) {
      await db.insert(taskAssignees).values({ taskId, employeeId: owner.id });
      await db.update(tasks).set({ assigneeId: owner.id }).where(eq(tasks.id, taskId));
    }
  } catch { /* atribuição best-effort */ }
  return { taskId, created: true };
}

/** A disponibilidade da pessoa para a semana ficou registada → fecha a tarefa. */
export async function closeAvailabilityTasks(employeeId: number, weekStartOrDay: string): Promise<number> {
  return closeTasksForSource("availability", employeeId, availabilityTaskKey(employeeId, weekStartOrDay));
}

// ─── Comentários ────────────────────────────────────────────────────────────

export async function listTaskComments(taskId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select({ id: taskComments.id, body: taskComments.body, createdAt: taskComments.createdAt, userId: taskComments.userId, userName: users.name })
    .from(taskComments).leftJoin(users, eq(users.id, taskComments.userId))
    .where(eq(taskComments.taskId, taskId)).orderBy(taskComments.createdAt, taskComments.id).limit(500);
}

/** Novo comentário → aviso in-app aos responsáveis e ao criador (exceto o autor). */
export async function addTaskComment(taskId: number, author: { id: number; name: string | null }, body: string, notify: Notify = defaultNotify): Promise<{ id: number; notified: number }> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const text = body.trim().slice(0, 5000);
  const [res] = await db.insert(taskComments).values({ taskId, userId: author.id, body: text });
  const t = await getTaskWithAssignees(taskId);
  let notified = 0;
  if (t) {
    await db.update(tasks).set({ updatedAt: mysqlNow() }).where(eq(tasks.id, taskId));
    const targets = new Set<number>([t.createdById, ...t.assignees.map((a) => a.userId).filter((x): x is number => x != null)]);
    targets.delete(author.id);
    for (const userId of targets) {
      try {
        await notify({ userId, title: `Novo comentário: ${t.title}`.slice(0, 255), body: `${author.name ?? "Alguém"}: ${text.slice(0, 200)}`, link: `/tarefas?focus=${taskId}` });
        notified++;
      } catch (e) { console.warn("[tasks] notify comment:", e); }
    }
  }
  return { id: Number((res as any).insertId), notified };
}

// ─── Checklists recorrentes ─────────────────────────────────────────────────

export function parseEmployeeIds(raw: unknown): number[] {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return []; } }
  return Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50) : [];
}

export const TEMPLATE_ASSIGNEE_ROLES = ["shift_team_leader", "shift_all"] as const;
export const TEMPLATE_ASSIGNEE_ROLE_LABELS: Record<(typeof TEMPLATE_ASSIGNEE_ROLES)[number], string> = {
  shift_team_leader: "Team leader(s) escalado(s) no turno",
  shift_all: "Toda a equipa escalada no turno",
};

/**
 * Gera as tarefas do dia operacional de Lisboa a partir dos modelos ativos
 * (idempotente: UNIQUE templateId+templateDate+templateShift). Chamado de
 * hora a hora — a 1.ª corrida do dia cria, as seguintes não fazem nada (e
 * apanham modelos novos). Responsáveis: ids fixos e/ou a escala do turno.
 */
export async function generateTemplateTasks(now: Date = new Date()): Promise<{ date: string; created: number; skipped: number }> {
  const db = await getDb();
  const day = operationalDayOf(now.getTime());
  const out = { date: day, created: 0, skipped: 0 };
  if (!db) return out;
  const templates = await db.select().from(taskTemplates).where(eq(taskTemplates.active, 1));
  if (!templates.length) return out;
  const existing = await db.select({ templateId: tasks.templateId, templateShift: tasks.templateShift }).from(tasks)
    .where(and(sql`${tasks.templateId} IS NOT NULL`, sql`${tasks.templateDate} = ${day}`));
  const keys = existing.map((e) => templateOccurrenceKey(Number(e.templateId), day, String(e.templateShift)));
  const occ = templateOccurrencesFor(templates as any, day, keys);
  if (!occ.length) return out;
  const allProjects = await db.select({ id: projects.id, name: projects.name, level: projects.level, parentId: projects.parentId }).from(projects);
  const { getSystemUserId } = await import("./db");
  const systemUser = await getSystemUserId();
  for (const o of occ) {
    const t = templates.find((x) => x.id === o.templateId)!;
    const assigneeIds = new Set(parseEmployeeIds(t.assigneeEmployeeIds));
    if (t.assigneeRole && t.cityProjectId != null) {
      // Escala do turno da cidade (extras_dia_assignments: city lisbon|porto|faro, shift morning|night)
      let node = allProjects.find((p) => p.id === t.cityProjectId);
      while (node && node.level !== "city" && node.parentId != null) node = allProjects.find((p) => p.id === node!.parentId);
      const city = node ? handoverCityKey(node.name) : null;
      const shifts = o.shift === "manha" ? ["morning"] : o.shift === "noite" ? ["night"] : ["morning", "night"];
      if (city) {
        const rows = rowsOf(await db.execute(sql`SELECT DISTINCT employeeId FROM extras_dia_assignments
          WHERE assignmentDate = ${day} AND city = ${city} AND shift IN (${sql.join(shifts.map((s) => sql`${s}`), sql`, `)})
            AND employeeId IS NOT NULL ${t.assigneeRole === "shift_team_leader" ? sql`AND isTeamLeader = 1` : sql``}`).catch(() => [[]]));
        for (const r of rows) assigneeIds.add(Number(r.employeeId));
      }
    }
    const ids = [...assigneeIds];
    try {
      const [res] = await db.insert(tasks).values({
        title: t.title,
        description: t.description ?? null,
        projectId: t.cityProjectId ?? null,
        assigneeId: ids[0] ?? null,
        createdById: t.createdById ?? systemUser,
        taskStatus: "todo",
        taskPriority: (["low", "medium", "high", "urgent"].includes(t.priority) ? t.priority : "medium") as any,
        dueDate: mysqlNow(o.dueAtMs),
        dueHasTime: 1,
        sourceModule: "template",
        sourceId: t.id,
        templateId: t.id,
        templateDate: o.date,
        templateShift: o.shift as TemplateShift,
      });
      const taskId = Number((res as any).insertId);
      if (ids.length) await db.insert(taskAssignees).values(ids.map((employeeId) => ({ taskId, employeeId })));
      out.created++;
    } catch (err: any) {
      const code = err?.code ?? err?.cause?.code;
      if (code === "ER_DUP_ENTRY") { out.skipped++; continue; }
      throw err;
    }
  }
  return out;
}

/** Automação horária (chamada pelo extras-auto). TASKS_AUTOMATION=off desliga. */
export async function runTaskAutomation(now: Date = new Date()): Promise<Record<string, unknown>> {
  if (process.env.TASKS_AUTOMATION === "off") return { skipped: "TASKS_AUTOMATION=off" };
  const out: Record<string, unknown> = {};
  try { out.templates = await generateTemplateTasks(now); } catch (e: any) { out.templatesError = String(e?.message ?? e).slice(0, 200); }
  try { const r = await runTaskNotifications(now); out.notifications = { overdue: r.overdue, completed: r.completed }; } catch (e: any) { out.notificationsError = String(e?.message ?? e).slice(0, 200); }
  return out;
}

export { TASK_SOURCE_LABELS };
