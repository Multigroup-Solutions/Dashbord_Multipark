/**
 * P3 lote 18a — Tarefas. Decisões do Jorge (2 out 2026):
 *  - atrasos das tarefas automáticas → só os responsáveis e o supervisor da
 *    cidade, no sino, com interruptor próprio desligado (nada ao "utilizador
 *    de sistema", nada por email);
 *  - team leader: só a equipa, para ver, mudar o estado e editar;
 *  - "Eliminar" arquiva (nada se apaga) e as automáticas não renascem;
 *  - erro ≠ vazio; exceções por pessoa contam; responsáveis validados no servidor.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: null as any,
  flag: true,
  emails: [] as any[],
}));
vi.mock("./db", () => ({ getDb: async () => h.db, projectFilterConds: async () => [] }));
vi.mock("./_core/featureFlags", () => ({ isFeatureEnabled: () => h.flag }));
vi.mock("./mail/systemMail", () => ({ sendEmail: async (o: any) => { h.emails.push(o); return true; } }));

import { runTaskNotifications, shiftAssigneeIds, listTasks } from "./tasksService";
import {
  AUTOMATIC_TASK_SOURCES, canChangeTaskStatus, canEditTasks, isAutomaticTask, overdueAudience, taskSourceLink, teamTaskAccess,
} from "../shared/taskRules";
import { automationFlagDefault } from "../shared/appSettings";
import { kindDef } from "../shared/notificationRouting";
import { MIGRATION_0376_STATEMENTS } from "./migrations/migration_0376";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** BD a fingir: cada SELECT devolve o próximo resultado da fila; UPDATE afeta 1 linha. */
function fakeDb(queue: any[][]) {
  const updates: any[] = [];
  const chain = (kind: "select" | "update") => {
    const c: any = {};
    for (const m of ["from", "where", "orderBy", "limit", "innerJoin", "leftJoin", "groupBy"]) c[m] = () => c;
    c.set = (v: any) => { updates.push(v); return c; };
    c.then = (res: any, rej: any) => Promise.resolve(kind === "select" ? queue.shift() ?? [] : [{ affectedRows: 1 }]).then(res, rej);
    return c;
  };
  return { db: { select: () => chain("select"), update: () => chain("update") }, updates };
}

const past = "2026-10-01 00:00:00";
const now = new Date("2026-10-02T12:00:00Z");
const task = (o: Record<string, unknown>) => ({
  id: 1, title: "Lavar BMW", taskStatus: "todo", dueDate: past, dueHasTime: 0, notifiedOverdue: 0, createdById: 1,
  projectId: 10, sourceModule: "manual", ...o,
});

beforeEach(() => { h.flag = true; h.emails = []; h.db = null; });

describe("Avisos de atraso: quem é avisado", () => {
  it("manual: criador + gestores da hierarquia + responsáveis no sino, email ao criador (como sempre)", async () => {
    const f = fakeDb([[task({ createdById: 7 })], [], [{ id: 10, parentId: null, managerId: 77 }], [{ taskId: 1, userId: 55, fullName: "Ana" }], [{ email: "c@multipark.pt", name: "Carla", isActive: 1 }]]);
    h.db = f.db;
    const sent: number[] = [];
    const city: any[] = [];
    const r = await runTaskNotifications(now, async (n) => { sent.push(n.userId); }, { notifyCity: async (n) => { city.push(n); } });
    expect(r.overdue).toBe(1);
    expect(sent.sort()).toEqual([55, 7, 77].sort());
    expect(h.emails).toHaveLength(1);
    expect(city).toHaveLength(0);
  });
  it("automática com o interruptor ligado: responsáveis no sino + resumo da cidade; nada ao 'criador' (sistema) nem por email", async () => {
    const f = fakeDb([[task({ sourceModule: "template", createdById: 1 })], [], [{ id: 10, parentId: null, managerId: 77 }], [{ taskId: 1, userId: 55, fullName: "Ana" }]]);
    h.db = f.db;
    const sent: number[] = [];
    const city: any[] = [];
    const r = await runTaskNotifications(now, async (n) => { sent.push(n.userId); }, { notifyCity: async (n) => { city.push(n); }, autoNoticesOn: true });
    expect(r.overdue).toBe(1);
    expect(sent).toEqual([55]);
    expect(h.emails).toHaveLength(0);
    expect(city).toEqual([expect.objectContaining({ projectId: 10, title: "Tarefa automática em atraso: Lavar BMW", link: "/tarefas" })]);
  });
  it("automática com o interruptor desligado (omissão): fica marcada, ninguém é avisado", async () => {
    h.flag = false;
    const f = fakeDb([[task({ sourceModule: "service" })], [], [{ id: 10, parentId: null, managerId: 77 }], [{ taskId: 1, userId: 55, fullName: "Ana" }]]);
    h.db = f.db;
    const sent: number[] = [];
    const city: any[] = [];
    const r = await runTaskNotifications(now, async (n) => { sent.push(n.userId); }, { notifyCity: async (n) => { city.push(n); } });
    expect(r).toMatchObject({ overdue: 0, silenced: 1 });
    expect(sent).toEqual([]);
    expect(city).toEqual([]);
    expect(f.updates).toContainEqual({ notifiedOverdue: 1 });
    // Jorge (2 out 2026): ligado por omissão.
    expect(automationFlagDefault("TASKS_AUTO_OVERDUE")).toBe(true);
  });
  it("ligado: automática com o prazo passado há > 48 h fica marcada sem aviso (sem enxurrada ao ligar)", async () => {
    const old = task({ sourceModule: "service", dueDate: "2026-09-29 10:00:00", dueHasTime: 1 });
    const f = fakeDb([[old], [], [{ id: 10, parentId: null, managerId: 77 }], [{ taskId: 1, userId: 55, fullName: "Ana" }]]);
    h.db = f.db;
    const sent: number[] = [];
    const city: any[] = [];
    const r = await runTaskNotifications(now, async (n) => { sent.push(n.userId); }, { notifyCity: async (n) => { city.push(n); }, autoNoticesOn: true });
    expect(r).toMatchObject({ overdue: 0, silenced: 1 });
    expect(sent).toEqual([]);
    expect(city).toEqual([]);
    expect(f.updates).toContainEqual({ notifiedOverdue: 1 });
  });
  it("várias automáticas da mesma cidade → um resumo só", async () => {
    const f = fakeDb([[task({ id: 1, sourceModule: "service", title: "A" }), task({ id: 2, sourceModule: "service", title: "B" })], [], [], []]);
    h.db = f.db;
    const city: any[] = [];
    await runTaskNotifications(now, async () => {}, { notifyCity: async (n) => { city.push(n); }, autoNoticesOn: true });
    expect(city).toHaveLength(1);
    expect(city[0].title).toBe("2 tarefas automáticas em atraso");
    expect(city[0].body).toBe("• A\n• B");
  });
  it("regra pura: overdueAudience", () => {
    expect(overdueAudience({ sourceModule: "manual", createdById: 3, projectId: 1 }, [9, 3], true)).toEqual({ managers: [3, 9], emailCreator: true, assignees: true, citySupervisors: false });
    expect(overdueAudience({ sourceModule: "rh", createdById: 1, projectId: null }, [9], true)).toEqual({ managers: [], emailCreator: false, assignees: true, citySupervisors: false });
    expect(overdueAudience({ sourceModule: "availability", createdById: 1, projectId: 4 }, [9], false)).toEqual({ managers: [], emailCreator: false, assignees: false, citySupervisors: false });
    // 0545: + "lead" (candidaturas de condutores, Jorge 7 out 2026).
    expect([...AUTOMATIC_TASK_SOURCES]).toEqual(["availability", "template", "service", "rh", "lead"]);
    expect(isAutomaticTask({ sourceModule: "google_tasks" })).toBe(false);
  });
  it("tipo de notificação do supervisor: só supervisores, por cidade, no sino", () => {
    expect(kindDef("task_overdue_city")).toMatchObject({ roles: ["supervisor"], cityScoped: true, personal: false, module: "tarefas" });
  });
});

describe("Team leader: só a equipa", () => {
  const v = { userId: 100, team: new Set([1, 2, 3]) };
  it("vê se criou ou se algum responsável é da equipa; edita só se todos forem", () => {
    expect(teamTaskAccess(v, { createdById: 5, assigneeIds: [2, 9] })).toEqual({ see: true, edit: false });
    expect(teamTaskAccess(v, { createdById: 5, assigneeIds: [2, 3] })).toEqual({ see: true, edit: true });
    expect(teamTaskAccess(v, { createdById: 5, assigneeIds: [9] })).toEqual({ see: false, edit: false });
  });
  it("sem responsáveis (transversal): só se foi ele a criar", () => {
    expect(teamTaskAccess(v, { createdById: 5, assigneeIds: [] })).toEqual({ see: false, edit: false });
    expect(teamTaskAccess(v, { createdById: 100, assigneeIds: [null] })).toEqual({ see: true, edit: true });
  });
  it("o servidor aplica-o na lista, no detalhe, no estado e na pesquisa global", () => {
    const r = src("server/tasksRouter.ts");
    expect(r).toContain("if (team) f.team = team;");
    expect(r).toContain('throw new TRPCError({ code: "FORBIDDEN", message: "Esta tarefa não é da tua equipa." });');
    expect(r).toContain("await assertTeamEdit(u, prev, prevIds);");
    expect(src("server/globalSearch.ts")).toContain("if (team) mine = teamSeeCond(team,");
  });
});

describe("Exceções por pessoa contam (antes só o papel)", () => {
  it("supervisor com exceção 'só as suas' deixa de editar", () => {
    expect(canEditTasks({ role: "supervisor" })).toBe(true);
    expect(canEditTasks({ role: "supervisor", accessOverrides: { tarefas: { access: "own", actions: ["view", "edit"] } } })).toBe(false);
    expect(canChangeTaskStatus({ role: "supervisor", employeeId: 4, accessOverrides: { tarefas: { access: "own", actions: ["view", "edit"] } } }, { assigneeId: 4 })).toBe(true);
    expect(canEditTasks("frontoffice")).toBe(true);
  });
  it("o router usa o utilizador com as exceções", () => {
    const r = src("server/tasksRouter.ts");
    expect(r).toContain("const viewerOf = (ctx: { user: Viewer }): Viewer => withOverrides(ctx.user);");
    expect(r).not.toContain("canEditTasks(ctx.user.role)");
  });
});

describe("Nada se apaga: arquivar", () => {
  it("migração 0376: colunas de arquivo nas tarefas e nos modelos, depois da 0375 (WhatsApp)", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0376")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0375"));
    expect(MIGRATION_0376_STATEMENTS.every((s) => s.startsWith("ALTER TABLE") && s.includes("ADD COLUMN"))).toBe(true);
    expect(MIGRATION_0376_STATEMENTS).toHaveLength(4);
  });
  it("sem DELETE de tarefas, responsáveis, comentários ou modelos", () => {
    const svc = src("server/tasksService.ts");
    const r = src("server/tasksRouter.ts");
    for (const t of ["tasks", "taskAssignees", "taskComments", "taskTemplates"]) {
      expect(svc).not.toContain(`db.delete(${t})`);
      expect(r).not.toContain(`db.delete(${t})`);
    }
    expect(r).toContain("if (await archiveTask(input.id, ctx.user.id)) {");
    expect(r).toContain("await db.update(taskTemplates).set({ active: 0, archivedAt: nowMysql(), archivedById: ctx.user.id })");
  });
  it("arquivada sai das listas, dos avisos, da pesquisa e do Google; os geradores continuam a vê-la", () => {
    const svc = src("server/tasksService.ts");
    expect(svc).toContain("conds.push(notArchived());");
    expect(svc).toContain("sql`${tasks.taskStatus} <> 'done'`, notArchived(),");
    expect(svc).toContain("// Arquivadas incluídas: uma checklist arquivada hoje não volta a nascer.");
    expect(src("server/google/syncStore.ts")).toContain("AND t.archivedAt IS NULL");
    expect(src("server/google/syncStore.ts")).toContain("FROM tasks WHERE id IN (${inList(ids)}) AND archivedAt IS NULL");
    expect(src("server/globalSearch.ts")).toContain("AND t.archivedAt IS NULL AND ${mine}");
    const st = src("server/serviceTasks.ts");
    expect(st).toContain('taskStatus: r.archivedAt ? "done" : r.taskStatus');
    expect(st).toContain("isNull(tasks.archivedAt), gt(tasks.id, after)");
  });
  it("a ficha sem cidade (origem RH) abre a ficha", () => {
    expect(taskSourceLink("rh", 42, "rh:missing-city:42")).toBe("/rh?employeeId=42");
  });
});

describe("Erro ≠ vazio", () => {
  it("sem BD a lista lança (antes: [] que parecia 'sem tarefas')", async () => {
    h.db = null;
    await expect(listTasks({})).rejects.toThrow("Base de dados indisponível.");
  });
  it("sem ficha ligada → mensagem própria; a página mostra o erro com 'Tentar de novo'", () => {
    const r = src("server/tasksRouter.ts");
    expect(r).toContain('throw new TRPCError({ code: "PRECONDITION_FAILED", message: NO_EMPLOYEE_MSG });');
    const p = src("client/src/pages/TasksPage.tsx");
    expect(p).toContain('<QueryErrorNote error={listQ.error} onRetry={() => listQ.refetch()} retrying={listQ.isFetching} what="as tarefas" />');
    expect(p).toContain('what="os comentários"');
    expect(src("client/src/components/TaskTemplatesPanel.tsx")).toContain('what="as checklists"');
  });
  it("a automação acaba com erro quando uma parte falha e corre mesmo com os extras desligados", () => {
    expect(src("server/tasksService.ts")).toContain('if (errors.length) throw new Error(errors.join(" | ").slice(0, 400));');
    expect(src("server/extrasAutomation.ts")).toContain('["tasks", async () => (await import("./tasksService")).runTaskAutomation(now)],');
  });
});

describe("Checklists: responsáveis da escala", () => {
  it("prefere os confirmados; sem confirmados, os propostos; sem repetidos", () => {
    expect(shiftAssigneeIds([{ employeeId: 1, status: "proposed" }, { employeeId: 2, status: "confirmed" }, { employeeId: 2, status: "confirmed" }])).toEqual([2]);
    expect(shiftAssigneeIds([{ employeeId: 1, status: "proposed" }, { employeeId: 3, status: "proposed" }])).toEqual([1, 3]);
    expect(shiftAssigneeIds([{ employeeId: null }])).toEqual([]);
  });
});

describe("Responsáveis e centro de custos validados no servidor", () => {
  it("só fichas ativas no âmbito; quem não vê todas as cidades escolhe o centro de custos", () => {
    const r = src("server/tasksRouter.ts");
    expect(r).toContain("await assertAssignable(ids);");
    expect(r).toContain("await assertAssignable(next, prevIds);");
    expect(r).toContain('message: "Escolhe o centro de custos: sem ele a tarefa ficava visível a todas as cidades."');
  });
});
