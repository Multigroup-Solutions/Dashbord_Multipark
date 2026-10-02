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
import { isFeatureEnabled } from "./_core/featureFlags";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { getDb, projectFilterConds } from "./db";
import { employeeScope, scopedProjectIds } from "./cityScope";
import { employees, projects, taskAssignees, taskComments, taskTemplates, tasks, users } from "../drizzle/schema";
import {
  TASK_HIDE_DONE_AFTER_DAYS,
  TASK_SOURCE_LABELS,
  availabilityTaskAssigneeEmail,
  availabilityTaskKey,
  availabilityTaskTitle,
  TASK_LIST_LIMIT,
  hierarchyManagerIds,
  isAutomaticTask,
  isTaskOverdue,
  mondayOfDay,
  overdueAudience,
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
  /** Team leader: só as da equipa (ver `teamTaskAccess`). */
  team?: TeamFilter;
}

/** Team leader: quem é (users.id) e as fichas da equipa (ele incluído). */
export interface TeamFilter { userId: number; employeeIds: readonly number[] }

/** Arquivadas (0376) não aparecem em lado nenhum — só os geradores as veem. */
export const notArchived = (): SQL => sql`${tasks.archivedAt} IS NULL`;

/**
 * Condição SQL de `teamTaskAccess(...).see`: criada por ele, ou com algum
 * responsável da equipa (coluna legada ou task_assignees).
 */
export function teamSeeCond(
  team: TeamFilter,
  cols: { id: SQLWrapper; createdById: SQLWrapper; assigneeId: SQLWrapper } = { id: tasks.id, createdById: tasks.createdById, assigneeId: tasks.assigneeId },
): SQL {
  const ids = [...new Set(team.employeeIds)].filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) return sql`${cols.createdById} = ${team.userId}`;
  const list = sql.join(ids.map((i) => sql`${i}`), sql`, `);
  return sql`(${cols.createdById} = ${team.userId} OR ${cols.assigneeId} IN (${list}) OR EXISTS (SELECT 1 FROM task_assignees ta_team
    WHERE ta_team.taskId = ${cols.id} AND ta_team.employeeId IN (${list})))`;
}

/**
 * Team leader (alcance "below_city" nas Tarefas, com as exceções por pessoa):
 * a equipa = a ficha dele + as fichas abaixo dele na cidade. Outros → null.
 */
export async function teamFilterFor(user: { id: number; role: string; accessOverrides?: any }): Promise<TeamFilter | null> {
  const { scopeFor } = await import("../shared/access");
  if (scopeFor(user, "tarefas") !== "below_city") return null;
  const { employeeBelowCondition } = await import("./_core/access");
  const { projectScope } = await import("./cityScope");
  const db = await requireDb();
  const out = new Set<number>();
  const { getEmployeeByUserId } = await import("./db");
  const me = (await getEmployeeByUserId(user.id))?.employee?.id;
  if (me != null) out.add(me);
  const rows = rowsOf(await db.execute(sql`SELECT e.id FROM employees e WHERE ${projectScope(sql`e.projectId`)}
    AND ${await employeeBelowCondition(user, sql`e.id`)}`));
  for (const r of rows) out.add(Number(r.id));
  return { userId: user.id, employeeIds: [...out] };
}

const hideOldDone = (): SQL => {
  const cutoff = mysqlNow(Date.now() - TASK_HIDE_DONE_AFTER_DAYS * 86_400_000);
  return sql`NOT (${tasks.taskStatus} = 'done' AND COALESCE(${tasks.completedAt}, ${tasks.updatedAt}) < ${cutoff})`;
};

async function baseConds(f: TaskListFilters): Promise<SQL[]> {
  const conds: SQL[] = await projectFilterConds(tasks.projectId, f.projectId, { allowNull: true });
  conds.push(notArchived());
  if (f.status) conds.push(sql`${tasks.taskStatus} = ${f.status}`);
  if (f.employeeId != null) conds.push(assignedToCond(f.employeeId));
  if (f.team) conds.push(teamSeeCond(f.team));
  return conds;
}

/** BD em falta → erro (antes: lista vazia, que parecia "sem tarefas"). */
async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
  return db;
}

export async function listTasks(f: TaskListFilters = {}) {
  const db = await requireDb();
  const conds = await baseConds(f);
  if (!f.showOld) {
    const hide = hideOldDone();
    conds.push(f.focusId ? sql`(${hide} OR ${tasks.id} = ${f.focusId})` : hide);
  }
  const taskRows = await db
    .select({ task: tasks, projectName: projects.name })
    .from(tasks)
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(...conds))
    .orderBy(desc(tasks.updatedAt), desc(tasks.id))
    .limit(TASK_LIST_LIMIT);
  if (!taskRows.length) return [];
  const ids = taskRows.map((r) => r.task.id);
  const assigneeRows = await db
    .select({ taskId: taskAssignees.taskId, employeeId: taskAssignees.employeeId, fullName: employees.fullName })
    .from(taskAssignees)
    .innerJoin(employees, eq(employees.id, taskAssignees.employeeId))
    .where(inArray(taskAssignees.taskId, ids));
  const commentRows = rowsOf(await db.execute(sql`SELECT taskId, COUNT(*) AS n FROM task_comments
    WHERE taskId IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) GROUP BY taskId`));
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
  const db = await requireDb();
  const conds = await baseConds({ ...f, status: undefined });
  // Como a lista: as concluídas antigas só contam com "Mostrar antigas".
  if (!f.showOld) conds.push(hideOldDone());
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

/** Tarefa + responsáveis. Arquivada = não existe (null). */
export async function getTaskWithAssignees(id: number) {
  const db = await requireDb();
  const [t] = await db.select({ task: tasks, projectName: projects.name }).from(tasks)
    .leftJoin(projects, eq(projects.id, tasks.projectId)).where(and(eq(tasks.id, id), notArchived())).limit(1);
  if (!t) return null;
  const a = await db.select({ id: taskAssignees.employeeId, fullName: employees.fullName, userId: employees.userId })
    .from(taskAssignees).innerJoin(employees, eq(employees.id, taskAssignees.employeeId))
    .where(eq(taskAssignees.taskId, id));
  return { ...t.task, projectName: t.projectName, assignees: a.map((x) => ({ id: x.id, fullName: x.fullName, userId: x.userId })) };
}

/** Pessoas que podem ser responsáveis (ativas, no âmbito de cidade; opcionalmente na árvore de um projeto). */
export async function assignableEmployees(projectIds?: number[] | null) {
  const db = await requireDb();
  const conds: SQL[] = [sql`${employees.isActive} = 1`, employeeScope(employees.id)];
  if (projectIds && projectIds.length) conds.push(sql`(${employees.projectId} IS NULL OR ${inArray(employees.projectId, projectIds)})`);
  return db.select({ id: employees.id, fullName: employees.fullName, projectId: employees.projectId })
    .from(employees).where(and(...conds)).orderBy(employees.fullName).limit(3000);
}

/**
 * Os ids que NÃO podem ser responsáveis (inativos ou fora do âmbito de cidade
 * de quem pede). Os que a tarefa já tinha não contam — mantê-los é sempre
 * permitido (a ficha pode ter ficado inativa entretanto).
 */
export async function notAssignable(ids: ReadonlyArray<number | null | undefined>, keep: ReadonlyArray<number | null | undefined> = []): Promise<number[]> {
  const kept = new Set(keep.filter((x): x is number => x != null));
  const want = [...new Set(ids.filter((x): x is number => x != null && !kept.has(x)))];
  if (!want.length) return [];
  const db = await requireDb();
  const ok = await db.select({ id: employees.id }).from(employees)
    .where(and(inArray(employees.id, want), sql`${employees.isActive} = 1`, employeeScope(employees.id)));
  const good = new Set(ok.map((r) => r.id));
  return want.filter((id) => !good.has(id));
}

/**
 * "Eliminar" = ARQUIVAR (0376): a tarefa sai das listas, dos contadores, dos
 * avisos e do Google, mas a linha (responsáveis e comentários incluídos) fica,
 * e os geradores (checklists, serviços) não a voltam a criar. Idempotente.
 */
export async function archiveTask(id: number, byUserId: number): Promise<boolean> {
  const db = await requireDb();
  const res: any = await db.update(tasks).set({ archivedAt: mysqlNow(), archivedById: byUserId })
    .where(and(eq(tasks.id, id), notArchived()));
  return Number(res?.[0]?.affectedRows ?? res?.affectedRows ?? 0) > 0;
}

// ─── Notificações ───────────────────────────────────────────────────────────

type Notify = (n: { userId: number; title: string; body: string; link: string }) => Promise<void>;

async function defaultNotify(n: { userId: number; title: string; body: string; link: string }) {
  // Pessoal: só a pessoa indicada (criador, responsável, gestor da hierarquia).
  const { notify } = await import("./notify");
  await notify({ kind: "task", targetUserId: n.userId, title: n.title, body: n.body, link: n.link });
}

async function emailUser(userId: number, subject: string, text: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const [u] = await db.select({ email: users.email, name: users.name, isActive: users.isActive }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u?.email || !u.isActive) return;
  const { sendEmail } = await import("./mail/systemMail");
  await sendEmail({ to: u.email, subject, text: `Olá ${u.name ?? ""},\n\n${text}`, auto: { kind: "task_notice" } });
}

/** Aviso por cidade (supervisor) — `notify()` com o tipo `task_overdue_city`. */
type NotifyCity = (n: { projectId: number; title: string; body: string; link: string; entityId: string }) => Promise<void>;

async function defaultNotifyCity(n: { projectId: number; title: string; body: string; link: string; entityId: string }) {
  const { notify } = await import("./notify");
  await notify({ kind: "task_overdue_city", projectId: n.projectId, title: n.title, body: n.body, link: n.link, entity: { type: "task_overdue_city", id: n.entityId } });
}

/** Interruptor dos avisos de atraso das automáticas (lido fresco; ligado por omissão — Jorge, 2 out 2026). */
async function autoOverdueNoticesOn(): Promise<boolean> {
  const { automationFlagDefault } = await import("../shared/appSettings");
  return isFeatureEnabled("TASKS_AUTO_OVERDUE", { defaultEnabled: automationFlagDefault("TASKS_AUTO_OVERDUE") });
}

/**
 * Automáticas que passaram o prazo há mais do que isto ficam marcadas sem
 * aviso: ao ligar (ou no 1.º deploy) não chega uma enxurrada de atrasos velhos.
 */
export const AUTO_OVERDUE_NOTICE_MAX_AGE_MS = 48 * 3600_000;

export interface TaskNotificationsReport { overdue: number; completed: number; silenced: number; details: string[] }

/**
 * Corre de hora a hora (extras-auto) e no botão "Verificar agora":
 *  - atraso (fim do dia de Lisboa / hora exata) → quem `overdueAudience`
 *    disser: nas manuais, criador + gestores da hierarquia (in-app; email ao
 *    criador) + responsáveis; nas automáticas (P3 18a), só os responsáveis e
 *    um resumo por cidade ao supervisor, no sino, com TASKS_AUTO_OVERDUE
 *    ligado (por omissão) — desligado, ou com o prazo passado há > 48 h,
 *    ficam marcadas sem aviso;
 *  - concluída → criador (in-app + email), exceto se foi ele a concluir.
 * Cada tarefa só avisa 1× (notifiedOverdue/notifiedComplete). Arquivadas não avisam.
 */
export async function runTaskNotifications(
  now: Date = new Date(),
  notify: Notify = defaultNotify,
  deps: { notifyCity?: NotifyCity; autoNoticesOn?: boolean } = {},
): Promise<TaskNotificationsReport> {
  const db = await requireDb();
  const out: TaskNotificationsReport = { overdue: 0, completed: 0, silenced: 0, details: [] };
  const nowMs = now.getTime();
  // Pré-filtro barato em SQL (o prazo real ≥ dueDate); decisão final no helper puro.
  // Os mais antigos primeiro: com mais de 500, os que ficam para a hora seguinte são os mais recentes.
  const candidates = await db.select().from(tasks).where(and(
    sql`${tasks.dueDate} IS NOT NULL`, sql`${tasks.dueDate} <= ${mysqlNow(nowMs)}`,
    sql`COALESCE(${tasks.notifiedOverdue}, 0) = 0`, sql`${tasks.taskStatus} <> 'done'`, notArchived(),
  )).orderBy(tasks.dueDate, tasks.id).limit(500);
  const overdue = candidates.filter((t) => isTaskOverdue(t, nowMs));
  const completed = await db.select().from(tasks).where(and(
    eq(tasks.taskStatus, "done"), sql`COALESCE(${tasks.notifiedComplete}, 0) = 0`, notArchived(),
  )).limit(500);
  if (!overdue.length && !completed.length) return out;
  const autoOn = deps.autoNoticesOn ?? (overdue.some((t) => isAutomaticTask(t)) ? await autoOverdueNoticesOn() : false);
  const notifyCity = deps.notifyCity ?? defaultNotifyCity;

  // Hierarquia de projetos carregada UMA vez por corrida.
  const allProjects = await db.select({ id: projects.id, parentId: projects.parentId, managerId: projects.managerId }).from(projects);
  const ids = [...new Set([...overdue, ...completed].map((t) => t.id))];
  const assignees = ids.length ? await db.select({ taskId: taskAssignees.taskId, userId: employees.userId, fullName: employees.fullName })
    .from(taskAssignees).innerJoin(employees, eq(employees.id, taskAssignees.employeeId))
    .where(inArray(taskAssignees.taskId, ids)) : [];
  const byTask = new Map<number, typeof assignees>();
  for (const a of assignees) { if (!byTask.has(a.taskId)) byTask.set(a.taskId, []); byTask.get(a.taskId)!.push(a); }

  // Resumo por cidade (projeto) das automáticas em atraso, para o supervisor.
  const cityBatches = new Map<number, string[]>();
  for (const t of overdue) {
    // Marca primeiro (claim): duas corridas em paralelo não avisam 2×.
    const res: any = await db.update(tasks).set({ notifiedOverdue: 1 }).where(and(eq(tasks.id, t.id), sql`COALESCE(${tasks.notifiedOverdue}, 0) = 0`));
    if (Number(res?.[0]?.affectedRows ?? res?.affectedRows ?? 1) === 0) continue;
    const deadlineMs = taskDeadlineMs(t);
    const stale = isAutomaticTask(t) && deadlineMs != null && nowMs - deadlineMs > AUTO_OVERDUE_NOTICE_MAX_AGE_MS;
    const aud = overdueAudience(t, hierarchyManagerIds(allProjects, t.projectId), autoOn && !stale);
    if (!aud.assignees && !aud.managers.length) {
      // Automática com os avisos desligados: fica marcada (não avisa mais tarde em bloco).
      out.silenced++; out.details.push(`Em atraso (automática, sem aviso): ${t.title}`);
      continue;
    }
    const link = `/tarefas?focus=${t.id}`;
    const people = byTask.get(t.id) ?? [];
    const names = people.map((p) => p.fullName).join(", ") || "sem responsável";
    const when = deadlineMs ? new Date(deadlineMs - 1).toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" }) : "?";
    const body = `A tarefa "${t.title}" passou o prazo (${when}). Responsáveis: ${names}.`;
    const managers = new Set<number>(aud.managers);
    for (const userId of managers) {
      try { await notify({ userId, title: `Tarefa em atraso: ${t.title}`.slice(0, 255), body, link }); } catch (e) { console.warn("[tasks] notify overdue:", e); }
    }
    if (aud.assignees) {
      for (const p of people) {
        if (p.userId == null || managers.has(p.userId)) continue;
        try { await notify({ userId: p.userId, title: `A tua tarefa está em atraso: ${t.title}`.slice(0, 255), body: `Prazo: ${when}.`, link }); } catch (e) { console.warn("[tasks] notify overdue (resp.):", e); }
      }
    }
    if (aud.emailCreator) {
      try { await emailUser(t.createdById, `Tarefa em atraso: ${t.title}`, `${body}\n\nAbrir: ${link}`); } catch (e) { console.warn("[tasks] email overdue:", e); }
    }
    if (aud.citySupervisors && t.projectId != null) {
      if (!cityBatches.has(t.projectId)) cityBatches.set(t.projectId, []);
      cityBatches.get(t.projectId)!.push(t.title);
    }
    out.overdue++; out.details.push(`Em atraso: ${t.title}`);
  }
  const hourKey = mysqlNow(nowMs).slice(0, 13);
  for (const [projectId, titles] of cityBatches) {
    const n = titles.length;
    const shown = titles.slice(0, 5).map((x) => `• ${x}`).join("\n");
    try {
      await notifyCity({
        projectId,
        title: (n === 1 ? `Tarefa automática em atraso: ${titles[0]}` : `${n} tarefas automáticas em atraso`).slice(0, 255),
        body: `${shown}${n > 5 ? `\n… e mais ${n - 5}.` : ""}`,
        link: "/tarefas",
        entityId: `${projectId}:${hourKey}`,
      });
    } catch (e) { console.warn("[tasks] notify overdue (cidade):", e); }
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
  // Arquivada conta como fechada: a resposta seguinte da semana abre uma nova.
  const [existing] = await db.select({ id: tasks.id }).from(tasks)
    .where(and(sql`${tasks.sourceKey} = ${key}`, sql`${tasks.taskStatus} <> 'done'`, notArchived())).limit(1);
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
    // Responsável: Definições (availability.assigneeEmail) → env → omissão.
    let ownerEmail = availabilityTaskAssigneeEmail(process.env);
    try {
      const { getSetting } = await import("./appSettings");
      ownerEmail = (await getSetting("availability.assigneeEmail")) || ownerEmail;
    } catch { /* fica a env/omissão */ }
    const owner = await findEmployeeByEmailOrName(ownerEmail);
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
  const db = await requireDb();
  return db.select({ id: taskComments.id, body: taskComments.body, createdAt: taskComments.createdAt, userId: taskComments.userId, userName: users.name })
    .from(taskComments).leftJoin(users, eq(users.id, taskComments.userId))
    .where(eq(taskComments.taskId, taskId)).orderBy(taskComments.createdAt, taskComments.id).limit(500);
}

/**
 * Novo comentário → aviso in-app aos responsáveis e ao criador (exceto o autor).
 * Nas automáticas o "criador" é o utilizador de sistema (o 1.º super_admin):
 * esse não é avisado (P3 18a).
 */
export async function addTaskComment(
  taskId: number, author: { id: number; name: string | null }, body: string, notify: Notify = defaultNotify,
  systemUserId?: () => Promise<number>,
): Promise<{ id: number; notified: number }> {
  const db = await requireDb();
  const text = body.trim().slice(0, 5000);
  const [res] = await db.insert(taskComments).values({ taskId, userId: author.id, body: text });
  const t = await getTaskWithAssignees(taskId);
  let notified = 0;
  if (t) {
    await db.update(tasks).set({ updatedAt: mysqlNow() }).where(eq(tasks.id, taskId));
    const targets = new Set<number>([t.createdById, ...t.assignees.map((a) => a.userId).filter((x): x is number => x != null)]);
    if (isAutomaticTask(t)) {
      const sys = await (systemUserId ?? (async () => (await import("./db")).getSystemUserId()))().catch(() => null);
      if (sys != null && t.createdById === sys) targets.delete(sys);
    }
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
export async function generateTemplateTasks(now: Date = new Date()): Promise<{ date: string; created: number; skipped: number; failed: number; errors: string[] }> {
  const db = await requireDb();
  const day = operationalDayOf(now.getTime());
  const out = { date: day, created: 0, skipped: 0, failed: 0, errors: [] as string[] };
  const templates = await db.select().from(taskTemplates).where(and(eq(taskTemplates.active, 1), sql`${taskTemplates.archivedAt} IS NULL`));
  if (!templates.length) return out;
  // Arquivadas incluídas: uma checklist arquivada hoje não volta a nascer.
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
    try {
      if (t.assigneeRole && t.cityProjectId != null) {
        // Escala do turno da cidade (extras_dia_assignments: city lisbon|porto|faro, shift morning|night).
        // Falha a ler → NÃO cria (antes nascia sem responsável, em silêncio); a hora seguinte tenta de novo.
        let node = allProjects.find((p) => p.id === t.cityProjectId);
        while (node && node.level !== "city" && node.parentId != null) node = allProjects.find((p) => p.id === node!.parentId);
        const city = node ? handoverCityKey(node.name) : null;
        const shifts = o.shift === "manha" ? ["morning"] : o.shift === "noite" ? ["night"] : ["morning", "night"];
        if (city) {
          const rows = rowsOf(await db.execute(sql`SELECT employeeId, status FROM extras_dia_assignments
            WHERE assignmentDate = ${day} AND city = ${city} AND shift IN (${sql.join(shifts.map((s) => sql`${s}`), sql`, `)})
              AND employeeId IS NOT NULL ${t.assigneeRole === "shift_team_leader" ? sql`AND isTeamLeader = 1` : sql``}`));
          for (const id of shiftAssigneeIds(rows)) assigneeIds.add(id);
        }
      }
    } catch (err: any) {
      out.failed++; out.errors.push(`${t.title}: escala — ${String(err?.message ?? err).slice(0, 120)}`);
      continue;
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
      out.failed++; out.errors.push(`${t.title}: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  return out;
}

/**
 * Responsáveis a partir da escala do turno: os confirmados; sem nenhum
 * confirmado, os propostos (a escala ainda não foi fechada). PURA.
 */
export function shiftAssigneeIds(rows: ReadonlyArray<{ employeeId: unknown; status?: unknown }>): number[] {
  const valid = rows.filter((r) => Number.isInteger(Number(r.employeeId)) && Number(r.employeeId) > 0);
  const confirmed = valid.filter((r) => String(r.status ?? "confirmed") === "confirmed");
  return [...new Set((confirmed.length ? confirmed : valid).map((r) => Number(r.employeeId)))];
}

/**
 * Automação horária (chamada pelo extras-auto, com ou sem EXTRAS_AUTOMATION —
 * P3 18a: antes parava com o interruptor dos extras). TASKS_AUTOMATION=off
 * desliga. Uma parte falhada não impede a outra, mas a corrida acaba com
 * erro (antes ficava verde com `templatesError` lá dentro).
 */
export async function runTaskAutomation(now: Date = new Date()): Promise<Record<string, unknown>> {
  if (!isFeatureEnabled("TASKS_AUTOMATION")) return { skipped: "TASKS_AUTOMATION=off" };
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  try {
    const g = await generateTemplateTasks(now);
    out.templates = g;
    if (g.failed) errors.push(`checklists: ${g.errors.slice(0, 3).join("; ")}`);
  } catch (e: any) { errors.push(`checklists: ${String(e?.message ?? e).slice(0, 200)}`); }
  try {
    const r = await runTaskNotifications(now);
    out.notifications = { overdue: r.overdue, completed: r.completed, silenced: r.silenced };
  } catch (e: any) { errors.push(`avisos: ${String(e?.message ?? e).slice(0, 200)}`); }
  if (errors.length) throw new Error(errors.join(" | ").slice(0, 400));
  return out;
}

export { TASK_SOURCE_LABELS };
