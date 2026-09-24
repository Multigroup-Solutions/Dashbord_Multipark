/**
 * Router tRPC `tasks` (Tarefas). Extraído de routers.ts.
 *
 *  - extras (e qualquer responsável) mudam o ESTADO das suas tarefas
 *    (`setStatus`); criar/editar/apagar exige frontoffice+;
 *  - âmbito de cidade + descendentes na lista/estatísticas e verificação de
 *    âmbito em update/delete/setStatus/comentários;
 *  - checklists recorrentes (modelos) e comentários por tarefa.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { assertProjectAccess } from "./cityScope";
import { getDb, getEmployeeByUserId, getTaskById, getTaskAssignees, logActivity, resolveProjectIds, setTaskAssignees, createTask, updateTask } from "./db";
import { taskTemplates } from "../drizzle/schema";
import {
  TASK_STATUSES,
  TEMPLATE_SHIFTS,
  canChangeTaskStatus,
  canEditTasks,
  dueDateFromDay,
  taskUpdateSideEffects,
} from "../shared/taskRules";
import {
  TEMPLATE_ASSIGNEE_ROLES,
  addTaskComment,
  assertTaskScope,
  assignableEmployees,
  deleteTaskCascade,
  getTaskWithAssignees,
  listTaskComments,
  listTasks,
  parseEmployeeIds,
  runTaskNotifications,
  taskStats,
} from "./tasksService";

const ROLE_HIERARCHY: Record<string, number> = { super_admin: 7, admin: 6, supervisor: 5, team_leader: 4, backoffice: 3, frontoffice: 2, extra: 1, user: 0 };
const atLeast = (role: string, min: string) => (ROLE_HIERARCHY[role] ?? -1) >= (ROLE_HIERARCHY[min] ?? 0);
function requireRole(role: string, min: string) {
  if (!atLeast(role, min)) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
}
const nowMysql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

async function myEmployeeId(userId: number): Promise<number | null> {
  const me = await getEmployeeByUserId(userId);
  return me?.employee?.id ?? null;
}

/** Tarefa + responsáveis, com âmbito de cidade e (para quem não edita) só as suas. */
async function loadTaskFor(ctx: { user: { id: number; role: string } }, id: number) {
  const task = await getTaskWithAssignees(id);
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Tarefa não encontrada." });
  assertTaskScope(task);
  const employeeId = await myEmployeeId(ctx.user.id);
  const view = { assigneeId: task.assigneeId, assigneeIds: task.assignees.map((a) => a.id) };
  if (!canEditTasks(ctx.user.role) && !canChangeTaskStatus({ role: ctx.user.role, employeeId }, view)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão" });
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
      requireRole(ctx.user.role, "extra");
      const f = { projectId: input?.projectId, status: input?.status, showOld: input?.showOld, focusId: input?.focusId } as any;
      // extra: só vê as tarefas atribuídas a si (filtro em SQL)
      if (!canEditTasks(ctx.user.role) || input?.mine) {
        const me = await myEmployeeId(ctx.user.id);
        if (me == null) return [];
        f.employeeId = me;
      } else if (input?.assigneeId) {
        f.employeeId = input.assigneeId;
      }
      return listTasks(f);
    }),
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "extra");
      const { task } = await loadTaskFor(ctx, input.id);
      return task;
    }),
  stats: protectedProcedure
    .input(z.object({ projectId: z.number().optional(), mine: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "extra");
      if (!canEditTasks(ctx.user.role) || input?.mine) {
        const me = await myEmployeeId(ctx.user.id);
        if (me == null) return { total: 0, backlog: 0, todo: 0, inProgress: 0, review: 0, done: 0, overdue: 0 };
        return taskStats({ projectId: input?.projectId, employeeId: me });
      }
      return taskStats({ projectId: input?.projectId });
    }),
  getAssignees: protectedProcedure
    .input(z.object({ taskId: z.number() }))
    .query(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "extra");
      await loadTaskFor(ctx, input.taskId);
      return getTaskAssignees(input.taskId);
    }),
  /** Responsáveis possíveis: ativos, no âmbito de cidade (e na árvore do projeto, se indicado). */
  assignable: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive().nullable().optional() }).optional())
    .query(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "frontoffice");
      const ids = input?.projectId ? await resolveProjectIds(input.projectId) : null;
      return assignableEmployees(ids);
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
      requireRole(ctx.user.role, "frontoffice");
      if (input.projectId != null) assertProjectAccess(input.projectId);
      const primaryAssignee = input.assigneeIds?.[0] ?? input.assigneeId ?? null;
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
      const ids = input.assigneeIds ?? (input.assigneeId ? [input.assigneeId] : []);
      if (ids.length) await setTaskAssignees(newId, ids);
      await logActivity({ userId: ctx.user.id, action: "create", entity: "task", entityId: newId, details: input.title });
      return { id: newId };
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
      requireRole(ctx.user.role, "frontoffice");
      const prev = await getTaskById(input.id);
      if (!prev) throw new TRPCError({ code: "NOT_FOUND", message: "Tarefa não encontrada." });
      assertTaskScope(prev);
      if (input.projectId != null) assertProjectAccess(input.projectId);
      const { id, dueDate, assigneeIds, status, priority, ...rest } = input;
      const data: any = { ...rest };
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
      await logActivity({ userId: ctx.user.id, action: "update", entity: "task", entityId: id, details: input.status ?? "" });
      return { success: true };
    }),
  /** Mudar só o estado: editores ou qualquer responsável na sua própria tarefa. */
  setStatus: protectedProcedure
    .input(z.object({ id: z.number(), status: z.enum(TASK_STATUSES) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "extra");
      const { task, employeeId, view } = await loadTaskFor(ctx, input.id);
      if (!canChangeTaskStatus({ role: ctx.user.role, employeeId }, view)) throw new TRPCError({ code: "FORBIDDEN", message: "Só podes mudar o estado das tuas tarefas." });
      if (task.taskStatus === input.status) return { success: true };
      const data: any = { taskStatus: input.status, ...taskUpdateSideEffects(task as any, { taskStatus: input.status }, nowMysql()) };
      if (input.status === "done") data.completedById = ctx.user.id;
      await updateTask(input.id, data);
      await logActivity({ userId: ctx.user.id, action: "status", entity: "task", entityId: input.id, details: input.status });
      return { success: true };
    }),
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "frontoffice");
      const prev = await getTaskById(input.id);
      if (!prev) return { success: true };
      assertTaskScope(prev);
      await deleteTaskCascade(input.id);
      await logActivity({ userId: ctx.user.id, action: "delete", entity: "task", entityId: input.id });
      return { success: true };
    }),
  /** "Verificar agora": o mesmo passo que o cron horário corre. */
  checkNotifications: protectedProcedure
    .mutation(async ({ ctx }) => {
      requireRole(ctx.user.role, "admin");
      const r = await runTaskNotifications(new Date());
      return { notified: r.overdue + r.completed, details: r.details };
    }),

  // ── Comentários ────────────────────────────────────────────────────────────
  comments: protectedProcedure
    .input(z.object({ taskId: z.number() }))
    .query(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "extra");
      await loadTaskFor(ctx, input.taskId);
      return listTaskComments(input.taskId);
    }),
  addComment: protectedProcedure
    .input(z.object({ taskId: z.number(), body: z.string().trim().min(1).max(5000) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.user.role, "extra");
      await loadTaskFor(ctx, input.taskId);
      return addTaskComment(input.taskId, { id: ctx.user.id, name: (ctx.user as any).name ?? null }, input.body);
    }),

  // ── Checklists recorrentes (modelos) ──────────────────────────────────────
  templates: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      requireRole(ctx.user.role, "supervisor");
      const db = await getDb();
      if (!db) return [];
      const rows = await db.select().from(taskTemplates).orderBy(taskTemplates.title).limit(500);
      return rows
        .filter((r) => { try { if (r.cityProjectId != null) assertProjectAccess(r.cityProjectId); return true; } catch { return false; } })
        .map((r) => ({ ...r, assigneeEmployeeIds: parseEmployeeIds(r.assigneeEmployeeIds) }));
    }),
    save: protectedProcedure
      .input(templateInput.extend({ id: z.number().int().positive().optional() }))
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "supervisor");
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
          const [prev] = await db.select().from(taskTemplates).where(eq(taskTemplates.id, input.id)).limit(1);
          if (!prev) throw new TRPCError({ code: "NOT_FOUND", message: "Modelo não encontrado." });
          if (prev.cityProjectId != null) assertProjectAccess(prev.cityProjectId);
          await db.update(taskTemplates).set(values).where(eq(taskTemplates.id, input.id));
          await logActivity({ userId: ctx.user.id, action: "update", entity: "task_template", entityId: input.id, details: input.title });
          return { id: input.id };
        }
        const [res] = await db.insert(taskTemplates).values({ ...values, createdById: ctx.user.id });
        const id = Number((res as any).insertId);
        await logActivity({ userId: ctx.user.id, action: "create", entity: "task_template", entityId: id, details: input.title });
        return { id };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        requireRole(ctx.user.role, "supervisor");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "BD indisponível" });
        const [prev] = await db.select().from(taskTemplates).where(eq(taskTemplates.id, input.id)).limit(1);
        if (!prev) return { success: true };
        if (prev.cityProjectId != null) assertProjectAccess(prev.cityProjectId);
        // As tarefas já geradas ficam (histórico); só deixa de gerar novas.
        await db.delete(taskTemplates).where(eq(taskTemplates.id, input.id));
        await logActivity({ userId: ctx.user.id, action: "delete", entity: "task_template", entityId: input.id, details: prev.title });
        return { success: true };
      }),
    /** Gera já as tarefas de hoje (idempotente) — o cron horário faz o mesmo. */
    generateNow: protectedProcedure.mutation(async ({ ctx }) => {
      requireRole(ctx.user.role, "admin");
      const { generateTemplateTasks } = await import("./tasksService");
      return generateTemplateTasks(new Date());
    }),
  }),
});
