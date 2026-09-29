import { describe, expect, it } from "vitest";
import {
  availabilityTaskAssigneeEmail,
  availabilityTaskKey,
  availabilityTaskTitle,
  canChangeTaskStatus,
  canEditTasks,
  dueDateFromDay,
  hierarchyManagerIds,
  isTaskOverdue,
  operationalDayOf,
  taskDeadlineMs,
  taskSourceLink,
  taskUpdateSideEffects,
  templateDueAtMs,
  templateOccurrencesFor,
  templateRunsOn,
  TASK_STATUS_LABELS,
} from "../shared/taskRules";
import { MIGRATION_0091_STATEMENTS, IDEMPOTENT_ERROR_CODES_0091 } from "./migrations/migration_0091";
import { parseEmployeeIds } from "./tasksService";

const iso = (ms: number) => new Date(ms).toISOString();

describe("prazo — fim do dia de Lisboa", () => {
  it("só data: atrasa à meia-noite de Lisboa do dia seguinte (verão, UTC+1)", () => {
    const d = taskDeadlineMs({ dueDate: "2026-07-10 00:00:00" })!;
    expect(iso(d)).toBe("2026-07-10T23:00:00.000Z");
    const t = { dueDate: "2026-07-10 00:00:00", taskStatus: "todo" };
    expect(isTaskOverdue(t, Date.parse("2026-07-10T22:59:59Z"))).toBe(false); // 23:59:59 em Lisboa
    expect(isTaskOverdue(t, Date.parse("2026-07-10T23:00:00Z"))).toBe(true);
  });
  it("inverno (UTC+0) e dia da mudança de hora", () => {
    expect(iso(taskDeadlineMs({ dueDate: "2026-01-15 00:00:00" })!)).toBe("2026-01-16T00:00:00.000Z");
    // 25 out 2026: a hora muda nessa madrugada; o fim do dia 25 é 26 00:00 WET
    expect(iso(taskDeadlineMs({ dueDate: "2026-10-25" })!)).toBe("2026-10-26T00:00:00.000Z");
  });
  it("com hora: o próprio instante; concluída nunca está em atraso; sem data → null", () => {
    expect(iso(taskDeadlineMs({ dueDate: "2026-07-10 14:00:00", dueHasTime: 1 })!)).toBe("2026-07-10T14:00:00.000Z");
    expect(isTaskOverdue({ dueDate: "2020-01-01 00:00:00", taskStatus: "done" }, Date.now())).toBe(false);
    expect(taskDeadlineMs({ dueDate: null })).toBeNull();
  });
  it("dueDateFromDay aceita só YYYY-MM-DD", () => {
    expect(dueDateFromDay("2026-09-24")).toBe("2026-09-24 00:00:00");
    expect(dueDateFromDay("24/09/2026")).toBeNull();
  });
});

describe("permissões", () => {
  const task = { assigneeId: 5, assigneeIds: [5, 9] };
  it("frontoffice+ edita; extra não", () => {
    expect(canEditTasks("frontoffice")).toBe(true);
    expect(canEditTasks("admin")).toBe(true);
    expect(canEditTasks("extra")).toBe(false);
    expect(canEditTasks("user")).toBe(false);
  });
  it("responsável (extra) muda o estado só das suas", () => {
    expect(canChangeTaskStatus({ role: "extra", employeeId: 9 }, task)).toBe(true);
    expect(canChangeTaskStatus({ role: "extra", employeeId: 5 }, { assigneeId: 5 })).toBe(true);
    expect(canChangeTaskStatus({ role: "extra", employeeId: 7 }, task)).toBe(false);
    expect(canChangeTaskStatus({ role: "extra", employeeId: null }, task)).toBe(false);
    expect(canChangeTaskStatus({ role: "user", employeeId: 9 }, task)).toBe(false);
    expect(canChangeTaskStatus({ role: "frontoffice", employeeId: null }, task)).toBe(true);
  });
});

describe("efeitos da atualização", () => {
  const now = "2026-09-24 10:00:00";
  it("concluir marca completedAt; reabrir limpa", () => {
    expect(taskUpdateSideEffects({ taskStatus: "todo", dueDate: null }, { taskStatus: "done" }, now)).toEqual({ completedAt: now, notifiedComplete: 0 });
    expect(taskUpdateSideEffects({ taskStatus: "done", dueDate: null }, { taskStatus: "in_progress" }, now)).toEqual({ completedAt: null, notifiedComplete: 0 });
    expect(taskUpdateSideEffects({ taskStatus: "todo", dueDate: null }, { taskStatus: "todo" }, now)).toEqual({});
  });
  it("mudar a data limite volta a permitir o aviso de atraso", () => {
    expect(taskUpdateSideEffects({ taskStatus: "todo", dueDate: "2026-09-20 00:00:00" }, { dueDate: "2026-09-30 00:00:00" }, now))
      .toEqual({ notifiedOverdue: 0, dueHasTime: 0 });
    expect(taskUpdateSideEffects({ taskStatus: "todo", dueDate: "2026-09-20 00:00:00" }, { dueDate: "2026-09-20 00:00:00" }, now)).toEqual({});
  });
});

describe("disponibilidade a confirmar — 1 tarefa por pessoa × semana", () => {
  it("chave igual para qualquer dia da mesma semana (segunda a domingo)", () => {
    const k = availabilityTaskKey(42, "2026-09-21");
    expect(k).toBe("availability:42:2026-09-21");
    expect(availabilityTaskKey(42, "2026-09-24")).toBe(k);
    expect(availabilityTaskKey(42, "2026-09-27")).toBe(k); // domingo
    expect(availabilityTaskKey(42, "2026-09-28")).not.toBe(k); // semana seguinte
    expect(availabilityTaskKey(43, "2026-09-24")).not.toBe(k); // outra pessoa
  });
  it("título e responsável configurável", () => {
    expect(availabilityTaskTitle("Ana Silva")).toBe("Disponibilidade a confirmar: Ana Silva");
    expect(availabilityTaskAssigneeEmail({ AVAILABILITY_TASK_ASSIGNEE_EMAIL: " rh@multipark.pt " })).toBe("rh@multipark.pt");
    expect(availabilityTaskAssigneeEmail({})).toBe("kamilafagundes@multipark.pt");
  });
  it("link para a origem", () => {
    expect(taskSourceLink("availability", 42, "availability:42:2026-09-21")).toBe("/extras-dia?date=2026-09-21");
    expect(taskSourceLink("complaint", 7)).toBe("/reclamacoes?id=7");
    expect(taskSourceLink("manual", 1)).toBeNull();
  });
});

describe("checklists recorrentes", () => {
  const tpl = (over: Partial<{ id: number; active: number; shift: string; weekdaysMask: number; dueHour: number | null }> = {}) =>
    ({ id: 1, active: 1, shift: "manha", weekdaysMask: 127, dueHour: null, ...over });
  it("máscara de dias (bit 0 = segunda)", () => {
    expect(templateRunsOn({ weekdaysMask: 1 }, "2026-09-21")).toBe(true); // segunda
    expect(templateRunsOn({ weekdaysMask: 1 }, "2026-09-22")).toBe(false);
    expect(templateRunsOn({ weekdaysMask: 64 }, "2026-09-27")).toBe(true); // domingo
  });
  it("gera 1 ocorrência por modelo × dia × turno e é idempotente", () => {
    const templates = [tpl(), tpl({ id: 2, shift: "noite" }), tpl({ id: 3, active: 0 }), tpl({ id: 4, weekdaysMask: 2 })];
    const first = templateOccurrencesFor(templates, "2026-09-21");
    expect(first.map((o) => o.key)).toEqual(["1|2026-09-21|manha", "2|2026-09-21|noite"]);
    const again = templateOccurrencesFor(templates, "2026-09-21", first.map((o) => o.key));
    expect(again).toEqual([]);
    // modelo duplicado na lista não gera 2×
    expect(templateOccurrencesFor([tpl(), tpl()], "2026-09-21")).toHaveLength(1);
  });
  it("prazo por turno (Lisboa)", () => {
    expect(iso(templateDueAtMs("2026-07-10", "manha", null))).toBe("2026-07-10T14:00:00.000Z"); // 15h
    expect(iso(templateDueAtMs("2026-07-10", "manha", 11))).toBe("2026-07-10T10:00:00.000Z");
    expect(iso(templateDueAtMs("2026-07-10", "noite", null))).toBe("2026-07-11T02:00:00.000Z"); // 03h do dia seguinte
    expect(iso(templateDueAtMs("2026-07-10", "noite", 1))).toBe("2026-07-11T00:00:00.000Z"); // 01h → madrugada seguinte
    expect(iso(templateDueAtMs("2026-07-10", "noite", 22))).toBe("2026-07-10T21:00:00.000Z");
  });
  it("dia operacional: antes das 03h de Lisboa ainda é o dia anterior", () => {
    expect(operationalDayOf(Date.parse("2026-07-10T01:30:00Z"))).toBe("2026-07-09"); // 02:30 Lisboa
    expect(operationalDayOf(Date.parse("2026-07-10T02:30:00Z"))).toBe("2026-07-10"); // 03:30 Lisboa
  });
  it("parseEmployeeIds ignora lixo e repetidos", () => {
    expect(parseEmployeeIds("[3, 3, \"4\", -1, \"x\"]")).toEqual([3, 4]);
    expect(parseEmployeeIds("nope")).toEqual([]);
  });
});

describe("gestores da hierarquia", () => {
  it("sobe até à raiz sem repetidos nem ciclos", () => {
    const projects = [
      { id: 1, parentId: null, managerId: 100 },
      { id: 2, parentId: 1, managerId: 200 },
      { id: 3, parentId: 2, managerId: 100 },
      { id: 4, parentId: 5, managerId: null },
      { id: 5, parentId: 4, managerId: 7 },
    ];
    expect(hierarchyManagerIds(projects, 3)).toEqual([100, 200]);
    expect(hierarchyManagerIds(projects, 4)).toEqual([7]);
    expect(hierarchyManagerIds(projects, null)).toEqual([]);
  });
});

describe("PT-PT e migração 0091", () => {
  it("backlog aparece como Por planear", () => {
    expect(TASK_STATUS_LABELS.backlog).toBe("Por planear");
  });
  it("idempotente", () => {
    for (const s of MIGRATION_0091_STATEMENTS.filter((x) => x.startsWith("CREATE TABLE"))) expect(s).toMatch(/IF NOT EXISTS/);
    expect(MIGRATION_0091_STATEMENTS.some((s) => s.includes("`task_templates`"))).toBe(true);
    expect(MIGRATION_0091_STATEMENTS.some((s) => s.includes("`task_comments`"))).toBe(true);
    expect(MIGRATION_0091_STATEMENTS.some((s) => s.includes("UNIQUE INDEX `tasks_template_run_uq`"))).toBe(true);
    expect(IDEMPOTENT_ERROR_CODES_0091.has("ER_DUP_FIELDNAME")).toBe(true);
    expect(IDEMPOTENT_ERROR_CODES_0091.has("ER_DUP_KEYNAME")).toBe(true);
  });
});
