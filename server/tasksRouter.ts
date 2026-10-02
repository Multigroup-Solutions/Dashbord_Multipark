/**
 * Router tRPC `tasks` (Tarefas). Extraído de routers.ts.
 *
 *  - extras (e qualquer responsável) mudam o ESTADO das suas tarefas
 *    (`setStatus`); criar/editar/arquivar exige frontoffice+;
 *  - acessos com as exceções por pessoa (`withOverrides` — P3 18a: antes só
 *    o papel contava);
 *  - âmbito de cidade + descendentes na lista/estatísticas e verificação de
 *    âmbito em update/archive/setStatus/comentários;
 *  - team leader: só as tarefas da equipa, para ver e para mexer (Jorge, 18a);
 *  - responsáveis validados no servidor (ativos e no âmbito de cidade);
 *  - "Eliminar" arquiva (0376) — nada se apaga;
 *  - checklists recorrentes (modelos) e comentários por tarefa.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess, withOverrides } from "./_core/access";
import { roleRank } from "../shared/access";
import { assertProjectAccess, scopedProjectIds } from "./cityScope";
import { getDb, getEmployeeByUserId, getTaskById, getTaskAssignees, logActivity, resolveProjectIds, setTaskAssignees, createTask, updateTask } from "./db";
import { taskTemplates } from "../drizzle/schema";
import {
  TASK_SOURCE_LABELS,
  TASK_STATUSES,
  TEMPLATE_SHIFTS,
  canChangeTaskStatus,
  canEditTasks,
  dueDateFromDay,
  isAutomaticTask,
  taskUpdateSideEffects,
  teamTaskAccess,
  type TaskSourceModule,
} from "../shared/taskRules";
import {
  TEMPLATE_ASSIGNEE_ROLES,
  addTaskComment,
  archiveTask,
  assertTaskScope,
  assignableEmployees,
  getTaskWithAssignees,
  listTaskComments,
  listTasks,
  notAssignable,
  parseEmployeeIds,
  runTaskNotifications,
  taskStats,
  teamFilterFor,
} from "./tasksService";

type Viewer = { id: number; role: string; accessOverrides?: any };
const atLeast = (role: string, min: string) => roleRank(role) >= roleRank(min);
function requireRole(role: string, min: string) {
  if (!atLeast(role, min)) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
}
/** O utilizador com as exceções por pessoa (o `requireAccess` já as usava; o resto não). */
const viewerOf = (ctx: { user: Viewer }): Viewer => withOverrides(ctx.user);

/** Sem ficha ligada à conta não há "as minhas tarefas" — diz-se, em vez de lista vazia. */
export const NO_EMPLOYEE_MSG = "A tua conta não está ligada a uma ficha de colaborador: não há tarefas atribuídas a ti. Pede ao RH para ligar a ficha.";

/**
 * team_leader (alcance "below_city"): só atribui a si próprio e a quem está
 * abaixo dele na cidade.
 */
async function assertTeamAssignees(user: Viewer, employeeIds: Array<number | null | undefined>) {
  const ids = employeeIds.filter((x): x is number => x != null);
  if (!ids.length) return;
  const team = await teamFilterFor(user);
  if (!team) return;
  const set = new Set(team.employeeIds);
  if (ids.some(id => !set.has(id))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Só podes atribuir tarefas a ti e à tua equipa." });
  }
}

/** team_leader: editar/arquivar só as da equipa (todos os responsáveis; sem responsáveis, só as que criou). */
async function assertTeamEdit(user: Viewer, task: { createdById: number | null }, assigneeIds: Array<number | null | undefined>) {
  const team = await teamFilterFor(user);
  if (!team) return;
  if (!teamTaskAccess({ userId: user.id, team: new Set(team.employeeIds) }, { createdById: task.createdById, assigneeIds }).edit) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Só mexes nas tarefas da tua equipa (as que não têm responsáveis, só se foste tu a criar)." });
  }
}

/** Responsáveis: ativos e no âmbito de cidade de quem pede (os que a tarefa já tinha ficam). */
async function assertAssignable(ids: Array<number | null | undefined>, keep: Array<number | null | undefined> = []) {
  const bad = await notAssignable(ids, keep);
  if (bad.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Responsável inválido (ficha inativa ou fora das tuas cidades): #${bad.join(", #")}.` });
  }
}

/**
 * Quem não vê todas as cidades tem de escolher o centro de custos: sem ele a
 * tarefa ficava visível a todas as cidades (P3 18a).
 */
function assertProjectChosen(projectId: number | null | undefined) {
  if (projectId == null && scopedProjectIds() !== undefined) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Escolhe o centro de custos: sem ele a tarefa ficava visível a todas as cidades." });
  }
}

const uniqIds = (ids: ReadonlyArray<number | null | undefined>): number[] => [...new Set(ids.filter((x): x is number => x != null && x > 0))];
const nowMysql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

/**
 * Google Tasks/Calendário: depois de uma alteração, sincroniza já as pessoas
 * afetadas (best-effort, sem atrasar a resposta; o agendador repete o que
 * falhar — google-pending, 15 min — e o google-sync de 4 h é a rede de segurança).
 */
function googleSyncAfter(taskIds: number[]): void {
  import("./google/syncService").then((m) => m.scheduleGoogleTaskSync({ taskIds })).catch(() => undefined);
}

async function myEmployeeId(userId: number): Promise<number | null> {
  const me = await getEmployeeByUserId(userId);
  return me?.employee?.id ?? null;
}

/**
 * Tarefa + responsáveis, com âmbito de cidade, (para quem não edita) só as
 * suas e (team leader) só as da equipa. Arquivada = não encontrada.
 */
export async function loadTaskFor(ctx: { user: Viewer }, id: number) {
  const u = viewerOf(ctx);
  const task = await getTaskWithAssignees(id);
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Tarefa não encontrada." });
  assertTaskScope(task);
  const employeeId = await myEmployeeId(u.id);
  const view = { assigneeId: task.assigneeId, assigneeIds: task.assignees.map((a) => a.id) };
  const editor = canEditTasks(u);
  if (!editor && !canChangeTaskStatus({ ...u, employeeId }, view)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
  }
  const team = editor ? await teamFilterFor(u) : null;
  if (team && !teamTaskAccess({ userId: u.id, team: new Set(team.employeeIds) }, { createdById: task.createdById, assigneeIds: [task.assigneeId, ...view.assigneeIds] }).see) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Esta tarefa não é da tua equipa." });
  }
  return { task, employeeId, view };
}

const listInput = z.object({
  projectId: z.number().optional(),
  assigneeId: z.number().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  mine: z.boolean().optional(),
  showOld: z.boolean().optional(),
  focusId: z.number().int().positive().optional(),
}).optional();

const templateInput = z.object({
  title: z.string().trim().min(1).max(256),
  description: z.string().max(5000).nullable().optional(),
  cityProjectId: z.number().int().positive().nullable().optional(),
  shift: z.enum(TEMPLATE_SHIFTS),
  weekdaysMask: z.number().int().min(1).max(127),
  dueHour: z.number().int().min(0).max(23).nullable().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  assigneeRole: z.enum(TEMPLATE_ASSIGNEE_ROLES).nullable().optional(),
  assigneeEmployeeIds: z.array(z.number().int().positive()).max(50).optional(),
  active: z.boolean().default(true),
});

export const tasksRouter = router({
  list: protectedProcedure
    .input(listInput)
    .query(async ({ ctx, input }) => {
      const u = viewerOf(ctx);
      requireAccess(u, "tarefas", "view", { allowOwn: true });
      const f = { projectId: input?.projectId, status: input?.status, showOld: input?.showOld, focusId: input?.focusId } as any;
      // extra: só vê as tarefas atribuídas a si (filtro em SQL)
      if (!canEditTasks(u) || input?.mine) {
        const me = await myEmployeeId(u.id);
        if (me == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: NO_EMPLOYEE_MSG });
        f.employeeId = me;
      } else {
        if (input?.assigneeId) f.employeeId = input.assigneeId;
        const team = await teamFilterFor(u);
        if (team) f.team = team;
      }
      return listTasks(f);
    }),
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "tarefas", "view", { allowOwn: true });
      const { task } = await loadTaskFor(ctx, input.id);
      return task;
    }),
  stats: protectedProcedure
    .input(z.object({ projectId: z.number().optional(), mine: z.boolean().optional(), showOld: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const u = viewerOf(ctx);
      requireAccess(u, "tarefas", "view", { allowOwn: true });
      if (!canEditTasks(u) || input?.mine) {
        const me = await myEmployeeId(u.id);
        if (me == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: NO_EMPLOYEE_MSG });
        return taskStats({ projectId: input?.projectId, employeeId: me, showOld: input?.showOld });
      }
      const team = await teamFilterFor(u);
      return taskStats({ projectId: input?.projectId, showOld: input?.showOld, team: team ?? undefined });
    }),
  getAssignees: protectedProcedure
    .input(z.object({ taskId: z.number() }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "tarefas", "view", { allowOwn: true });
      await loadTaskFor(ctx, input.taskId);
      return getTaskAssignees(input.taskId);
    }),
  /** Responsáveis possíveis: ativos, no âmbito de cidade (e na árvore do projeto, se indicado). */
  assignable: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive().nullable().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const u = viewerOf(ctx);
      requireAccess(u, "tarefas", "edit");
      const ids = input?.projectId ? await resolveProjectIds(input.projectId) : null;
      const rows = await assignableEmployees(ids);
      const team = await teamFilterFor(u);
      if (!team) return rows;
      const set = new Set(team.employeeIds);
      return rows.filter(r => set.has(r.id));
    }),
  create: protectedProcedure
    .input(z.object({
      title: z.string().trim().min(1).max(256),
      description: z.string().max(20_000).optional(),
      projectId: z.number().optional(),
      assigneeId: z.number().optional(),
      assigneeIds: z.array(z.number()).max(50).optional(),
      priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const u = viewerOf(ctx);
      requireAccess(u, "tarefas", "edit");
      assertProjectChosen(input.projectId);
      if (input.projectId != null) assertProjectAccess(input.projectId);
      const ids = uniqIds(input.assigneeIds ?? [input.assigneeId]);
      await assertTeamAssignees(u, ids);
      await assertAssignable(ids);
      const primaryAssignee = ids[0] ?? null;
      const newId = await createTask({
        title: input.title,
        description: input.description ?? null,
        projectId: input.projectId ?? null,
        assigneeId: primaryAssignee,
        createdById: ctx.user.id,
        taskPriority: input.priority,
        dueDate: dueDateFromDay(input.dueDate?.slice(0, 10)),
        sourceModule: "manual",
      });
      if (ids.length) await setTaskAssignees(newId, ids);
      await logActivity({ userId: ctx.user.id, action: "create", entity: "task", entityId: newId, details: input.title });
      googleSyncAfter([newId]);
      return { id: newId };
    }),
  /**
   * "Criar tarefas a partir de texto" — passo 1: a IA PROPÕE (nada é criado).
   * Os responsáveis sugeridos saem só de quem a pessoa pode atribuir.
   */
  proposeFromText: protectedProcedure
    .input(z.object({ text: z.string().trim().min(10).max(6000), projectId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const u = viewerOf(ctx);
      requireAccess(u, "tarefas", "edit");
      if (input.projectId != null) assertProjectAccess(input.projectId);
      const ids = input.projectId ? await resolveProjectIds(input.projectId) : null;
      let candidates = await assignableEmployees(ids);
      const team = await teamFilterFor(u);
      if (team) {
        const set = new Set(team.employeeIds);
        candidates = candidates.filter((c) => set.has(c.id));
      }
      const { proposeTasksFromText } = await import("./aiOps/tasksFromText");
      const { lisbonDayOf } = await import("../shared/lisbonDay");
      const r = await proposeTasksFromText(input.text, {
        candidates: candidates.map((c: any) => ({ id: Number(c.id), fullName: String(c.fullName ?? c.name ?? "") })),
        today: lisbonDayOf(Date.now()), userId: ctx.user.id,
      });
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.reason });
      return { proposals: r.proposals };
    }),
  /** Passo 2: cria SÓ as tarefas que a pessoa confirmou (mesmos guardas do `create`). */
  createFromProposals: protectedProcedure
    .input(z.object({
      projectId: z.number().int().positive().nullable().optional(),
      tasks: z.array(z.object({
        title: z.string().trim().min(1).max(256),
        description: z.string().max(5000).nullable().optional(),
        assigneeId: z.number().int().positive().nullable().optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
      })).min(1).max(15),
    }))
    .mutation(async ({ ctx, input }) => {
      const u = viewerOf(ctx);
      requireAccess(u, "tarefas", "edit");
      assertProjectChosen(input.projectId);
      if (input.projectId != null) assertProjectAccess(input.projectId);
      const proposed = uniqIds(input.tasks.map((t) => t.assigneeId));
      await assertTeamAssignees(u, proposed);
      await assertAssignable(proposed);
      const ids: number[] = [];
      for (const t of input.tasks) {
        const id = await createTask({
          title: t.title,
          description: t.description ?? null,
          projectId: input.projectId ?? null,
          assigneeId: t.assigneeId ?? null,
          createdById: ctx.user.id,
          taskPriority: t.priority,
          dueDate: dueDateFromDay(t.dueDate ?? undefined),
          sourceModule: "manual",
        });
        if (t.assigneeId) await setTaskAssignees(id, [t.assigneeId]);
        await logActivity({ userId: ctx.user.id, action: "create", entity: "task", entityId: id, details: `${t.title} (a partir de texto)` });
        ids.push(id);
      }
      googleSyncAfter(ids);
      return { created: ids.length, ids };
    }),
  update: protectedProcedure
    .input(z.object({
      id: z.number(),
      title: z.string().trim().min(1).max(256).optional(),
      description: z.string().max(20_000).optional(),
      projectId: z.number().nullable().optional(),
      assigneeId: z.number().nullable().optional(),
      assigneeIds: z.array(z.number()).max(50).optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
      dueDate: z.string().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const u = viewerOf(ctx);
      requireAccess(u, "tarefas", "edit");
      const prev = await getTaskById(input.id);
      if (!prev || prev.archivedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Tarefa não encontrada." });
      assertTaskScope(prev);
      if (input.projectId != null) assertProjectAccess(input.projectId);
      // Tirar o centro de custos a uma tarefa que o tinha: só quem vê todas as cidades.
      if (input.projectId === null && prev.projectId != null) assertProjectChosen(null);
      const prevIds = uniqIds([prev.assigneeId, ...(await getTaskAssignees(input.id)).map((a: any) => a.assignee?.employeeId)]);
      await assertTeamEdit(u, prev, prevIds);
      const { id, dueDate, assigneeIds: rawAssigneeIds, status, priority, description, ...rest } = input;
      const assigneeIds = rawAssigneeIds === undefined ? undefined : uniqIds(rawAssigneeIds);
      if (assigneeIds !== undefined || input.assigneeId != null) {
        const next = assigneeIds ?? [input.assigneeId];
        await assertTeamAssignees(u, next);
        await assertAssignable(next, prevIds);
      }
      const data: any = { ...rest };
      // Descrição vazia apaga-a (antes não havia forma de a tirar).
      if (description !== undefined) data.description = description.trim() ? description : null;
      if (status !== undefined) data.taskStatus = status;
      if (priority !== undefined) data.taskPriority = priority;
      let nextDue: string | null | undefined;
      if (dueDate !== undefined) {
        nextDue = dueDate ? dueDateFromDay(dueDate.slice(0, 10)) : null;
        // A mesma data (só dia) não conta como alteração (mantém a hora de um modelo).
        if (nextDue && prev.dueDate && String(prev.dueDate).slice(0, 10) === nextDue.slice(0, 10)) nextDue = undefined;
        else data.dueDate = nextDue;
      }
      Object.assign(data, taskUpdateSideEffects(prev as any, { taskStatus: status, dueDate: nextDue }, nowMysql()));
      if (status === "done" && prev.taskStatus !== "done") data.completedById = ctx.user.id;
      if (assigneeIds !== undefined) data.assigneeId = assigneeIds[0] ?? null;
      await updateTask(id, data);
      if (assigneeIds !== undefined) await setTaskAssignees(id, assigneeIds);
      const changed = [
        input.title !== undefined && input.title !== prev.title ? "título" : null,
        description !== undefined && (description.trim() || null) !== (prev.description || null) ? "descrição" : null,
        input.projectId !== undefined && (input.projectId ?? null) !== (prev.projectId ?? null) ? "centro de custos" : null,
        assigneeIds !== undefined && assigneeIds.join(",") !== prevIds.join(",") ? "responsáveis" : null,
        status !== undefined && status !== prev.taskStatus ? `estado → ${status}` : null,
        priority !== undefined && priority !== prev.taskPriority ? `prioridade → ${priority}` : null,
        data.dueDate !== undefined ? `prazo → ${data.dueDate ? String(data.dueDate).slice(0, 10) : "sem prazo"}` : null,
      ].filter(Boolean);
      await logActivity({ userId: ctx.user.id, action: "update", entity: "task", entityId: id, details: `${prev.title}${changed.length ? `: ${changed.join(", ")}` : ""}`.slice(0, 500) });
      googleSyncAfter([id]);
      return { success: true };
    }),
  /** Mudar só o estado: editores ou qualquer responsável na sua própria tarefa. */
  setStatus: protectedProcedure
    .input(z.object({ id: z.number(), status: z.enum(TASK_STATUSES) }))
    .mutation(async ({ ctx, input }) => {
      const u = viewerOf(ctx);
      requireAccess(u, "tarefas", "edit", { allowOwn: true });
      const { task, employeeId, view } = await loadTaskFor(ctx, input.id);
      if (!canChangeTaskStatus({ ...u, employeeId }, view)) throw new TRPCError({ code: "FORBIDDEN", message: "Só podes mudar o estado das tuas tarefas." });
      if (task.taskStatus === input.status) return { success: true };
      const data: any = { taskStatus: input.status, ...taskUpdateSideEffects(task as any, { taskStatus: input.status }, nowMysql()) };
      if (input.status === "done") data.completedById = ctx.user.id;
      await updateTask(input.id, data);
      await logActivity({ userId: ctx.user.id, action: "status", entity: "task", entityId: input.id, details: input.status });
      googleSyncAfter([input.id]);
      return { success: true };
    }),
  /**
   * "Eliminar" = ARQUIVAR (0376): sai das listas, dos avisos e do Google; a
   * linha fica (com responsáveis e comentários) e as automáticas não voltam a
   * nascer. Fica no registo com o título.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const u = viewerOf(ctx);
      requireAccess(u, "tarefas", "edit");
      const prev = await getTaskById(input.id);
      if (!prev || prev.archivedAt) return { success: true };
      assertTaskScope(prev);
      await assertTeamEdit(u, prev, [prev.assigneeId, ...(await getTaskAssignees(input.id)).map((a: any) => a.assignee?.employeeId)]);
      if (await archiveTask(input.id, ctx.user.id)) {
        const origin = isAutomaticTask(prev) ? ` (${TASK_SOURCE_LABELS[prev.sourceModule as TaskSourceModule] ?? prev.sourceModule}; não volta a ser criada)` : "";
        await logActivity({ userId: ctx.user.id, action: "archive", entity: "task", entityId: input.id, details: `${prev.title}${origin}`.slice(0, 500) });
      }
      googleSyncAfter([input.id]);
      return { success: true };
    }),
  /** "Verificar agora": o mesmo passo que o cron horário corre. */
  checkNotifications: protectedProcedure
    .mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "tarefas", "manage");
      requireRole(ctx.user.role, "admin");
      const r = await runTaskNotifications(new Date());
      return { notified: r.overdue + r.completed, silenced: r.silenced, details: r.details };
    }),

  // ── Comentários ────────────────────────────────────────────────────────────
  comments: protectedProcedure
    .input(z.object({ taskId: z.number() }))
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "tarefas", "view", { allowOwn: true });
      await loadTaskFor(ctx, input.taskId);
      return listTaskComments(input.taskId);
    }),
  addComment: protectedProcedure
    .input(z.object({ taskId: z.number(), body: z.string().trim().min(1).max(5000) }))
    .mutation(async ({ ctx, input }) => {
      requireAccess(ctx.user, "tarefas", "view", { allowOwn: true });
      await loadTaskFor(ctx, input.taskId);
      return addTaskComment(input.taskId, { id: ctx.user.id, name: (ctx.user as any).name ?? null }, input.body);
    }),

  // ── Checklists recorrentes (modelos) ──────────────────────────────────────
  templates: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      requireAccess(ctx.user, "tarefas", "manage");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
      const rows = await db.select().from(taskTemplates).where(sql`${taskTemplates.archivedAt} IS NULL`).orderBy(taskTemplates.title).limit(500);
      return rows
        .filter((r) => { try { if (r.cityProjectId != null) assertProjectAccess(r.cityProjectId); return true; } catch { return false; } })
        .map((r) => ({ ...r, assigneeEmployeeIds: parseEmployeeIds(r.assigneeEmployeeIds) }));
    }),
    save: protectedProcedure
      .input(templateInput.extend({ id: z.number().int().positive().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "tarefas", "manage");
        assertProjectChosen(input.cityProjectId);
        if (input.cityProjectId != null) assertProjectAccess(input.cityProjectId);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
        const values = {
          title: input.title,
          description: input.description ?? null,
          cityProjectId: input.cityProjectId ?? null,
          shift: input.shift,
          weekdaysMask: input.weekdaysMask,
          dueHour: input.dueHour ?? null,
          priority: input.priority,
          assigneeRole: input.assigneeRole ?? null,
          assigneeEmployeeIds: JSON.stringify(input.assigneeEmployeeIds ?? []),
          active: input.active ? 1 : 0,
        };
        if (input.id) {
          const [prev] = await db.select().from(taskTemplates).where(and(eq(taskTemplates.id, input.id), sql`${taskTemplates.archivedAt} IS NULL`)).limit(1);
          if (!prev) throw new TRPCError({ code: "NOT_FOUND", message: "Modelo não encontrado." });
          if (prev.cityProjectId != null) assertProjectAccess(prev.cityProjectId);
          await assertAssignable(input.assigneeEmployeeIds ?? [], parseEmployeeIds(prev.assigneeEmployeeIds));
          await db.update(taskTemplates).set(values).where(eq(taskTemplates.id, input.id));
          await logActivity({ userId: ctx.user.id, action: "update", entity: "task_template", entityId: input.id, details: input.title });
          return { id: input.id };
        }
        await assertAssignable(input.assigneeEmployeeIds ?? []);
        const [res] = await db.insert(taskTemplates).values({ ...values, createdById: ctx.user.id });
        const id = Number((res as any).insertId);
        await logActivity({ userId: ctx.user.id, action: "create", entity: "task_template", entityId: id, details: input.title });
        return { id };
      }),
    /** "Eliminar" um modelo = arquivá-lo e desligá-lo (0376): as tarefas já geradas ficam; deixa de gerar novas. */
    delete: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        requireAccess(ctx.user, "tarefas", "manage");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
        const [prev] = await db.select().from(taskTemplates).where(and(eq(taskTemplates.id, input.id), sql`${taskTemplates.archivedAt} IS NULL`)).limit(1);
        if (!prev) return { success: true };
        if (prev.cityProjectId != null) assertProjectAccess(prev.cityProjectId);
        await db.update(taskTemplates).set({ active: 0, archivedAt: nowMysql(), archivedById: ctx.user.id }).where(eq(taskTemplates.id, input.id));
        await logActivity({ userId: ctx.user.id, action: "archive", entity: "task_template", entityId: input.id, details: prev.title });
        return { success: true };
      }),
    /** Gera já as tarefas de hoje (idempotente) — o cron horário faz o mesmo. */
    generateNow: protectedProcedure.mutation(async ({ ctx }) => {
      requireAccess(ctx.user, "tarefas", "manage");
      requireRole(ctx.user.role, "admin");
      const { generateTemplateTasks } = await import("./tasksService");
      return generateTemplateTasks(new Date());
    }),
  }),
});
