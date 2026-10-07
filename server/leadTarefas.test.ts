// Candidaturas de condutores → tarefas (pedido 5), Jorge 7 out 2026: "criam tarefa
// automática (uma por candidatura) e são filtráveis".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LEAD_TASK_MAX_AGE_DAYS,
  isCandidaturaLead,
  leadIsResolved,
  leadTaskAction,
  leadTaskAssignees,
  leadTaskCloseComment,
  leadTaskCutoffMysql,
  leadTaskDescription,
  leadTaskDueMs,
  leadTaskKey,
  leadTaskTitle,
  parseLeadTaskKey,
  type LeadForTask,
} from "../shared/leadTasks";
import { AUTOMATIC_TASK_SOURCES, isAutomaticTask } from "../shared/taskRules";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const NOW = Date.UTC(2026, 9, 7, 10, 0, 0);
const lead = (p: Partial<LeadForTask> = {}): LeadForTask => ({
  id: 9, fullName: "Ana Lima", source: "site", status: "new", archivedAt: null, createdAt: "2026-10-07 08:00:00", ...p,
});

describe("Tarefa de candidatura: quando nasce", () => {
  it("uma por candidatura nova do site ou do email de recrutamento; os leads à mão não", () => {
    expect(leadTaskAction(lead(), null, NOW)).toBe("create");
    expect(leadTaskAction(lead({ source: "email", status: "contacted" }), null, NOW)).toBe("create");
    expect(leadTaskAction(lead({ status: "replied" }), null, NOW)).toBe("create");
    expect(leadTaskAction(lead({ source: "manual" }), null, NOW)).toBe("none");
    expect(isCandidaturaLead({ source: null })).toBe(false);
  });
  it("nunca para candidaturas já tratadas", () => {
    expect(leadTaskAction(lead({ status: "converted" }), null, NOW)).toBe("none");
    expect(leadTaskAction(lead({ status: "declined" }), null, NOW)).toBe("none");
    expect(leadTaskAction(lead({ archivedAt: "2026-10-07 09:00:00" }), null, NOW)).toBe("none");
  });
  it("sem enxurrada no 1.º deploy: só as que entraram nos últimos dias", () => {
    const edge = new Date(NOW - LEAD_TASK_MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    expect(leadTaskAction(lead({ createdAt: edge }), null, NOW)).toBe("create");
    const older = new Date(NOW - LEAD_TASK_MAX_AGE_DAYS * 86_400_000 - 1000).toISOString().slice(0, 19).replace("T", " ");
    expect(leadTaskAction(lead({ createdAt: older }), null, NOW)).toBe("none");
    expect(leadTaskCutoffMysql(NOW)).toBe(edge);
    expect(leadTaskAction(lead({ createdAt: "lixo" }), null, NOW)).toBe("none");
  });
  it("idempotente: com tarefa (mesmo arquivada ou concluída) não nasce outra", () => {
    expect(leadTaskAction(lead(), { taskStatus: "todo" }, NOW)).toBe("none");
    expect(leadTaskAction(lead(), { taskStatus: "done" }, NOW)).toBe("none");
    expect(leadTaskAction(lead(), { taskStatus: "todo", archivedAt: "2026-10-07 09:00:00" }, NOW)).toBe("none");
    expect(leadTaskKey(9)).toBe("lead:9");
    expect(parseLeadTaskKey("lead:9")).toBe(9);
    expect(parseLeadTaskKey("lead:x")).toBeNull();
    expect(parseLeadTaskKey("svc:1:2")).toBeNull();
  });
});

describe("Tarefa de candidatura: fecha sozinha", () => {
  it("ao converter, Sem interesse ou arquivar; só as abertas (aplicar 2× dá o mesmo)", () => {
    expect(leadTaskAction(lead({ status: "converted" }), { taskStatus: "todo" }, NOW)).toBe("close");
    expect(leadTaskAction(lead({ status: "declined" }), { taskStatus: "in_progress" }, NOW)).toBe("close");
    expect(leadTaskAction(lead({ archivedAt: "2026-10-07 09:00:00" }), { taskStatus: "todo" }, NOW)).toBe("close");
    expect(leadTaskAction(lead({ status: "converted" }), { taskStatus: "done" }, NOW)).toBe("none");
    expect(leadTaskAction(lead({ status: "converted" }), { taskStatus: "todo", archivedAt: "2026-10-07 09:00:00" }, NOW)).toBe("none");
    expect(leadTaskAction(lead({ status: "contacted" }), { taskStatus: "todo" }, NOW)).toBe("none");
    expect(leadIsResolved({ status: "replied" })).toBe(false);
  });
  it("deixa o motivo num comentário", () => {
    expect(leadTaskCloseComment({ status: "converted" })).toMatch(/convertido em extra/);
    expect(leadTaskCloseComment({ status: "declined" })).toMatch(/Sem interesse/);
    expect(leadTaskCloseComment({ status: "new", archivedAt: "x" })).toMatch(/arquivado/);
  });
});

describe("Tarefa de candidatura: responsável, prazo e texto", () => {
  it("quem criou o lead (ficha ativa), senão os supervisores da cidade, sem repetidos", () => {
    expect(leadTaskAssignees({ ownerEmployeeId: 5, supervisorEmployeeIds: [1, 2] })).toEqual([5]);
    expect(leadTaskAssignees({ ownerEmployeeId: null, supervisorEmployeeIds: [2, 1, 2] })).toEqual([2, 1]);
    expect(leadTaskAssignees({ ownerEmployeeId: null, supervisorEmployeeIds: [] })).toEqual([]);
    expect(leadTaskAssignees({ ownerEmployeeId: null, supervisorEmployeeIds: Array.from({ length: 15 }, (_, i) => i + 1) })).toHaveLength(10);
  });
  it("prazo = SLA do 1.º contacto (24 h); título e descrição", () => {
    expect(new Date(leadTaskDueMs("2026-10-07 08:00:00")).toISOString()).toBe("2026-10-08T08:00:00.000Z");
    expect(leadTaskTitle("  Ana Lima ")).toBe("Candidatura de condutor: Ana Lima");
    expect(leadTaskTitle("")).toBe("Candidatura de condutor: sem nome");
    const d = leadTaskDescription({ source: "site", phone: "+351912345678", email: "ana@x.pt", notes: "fins de semana" }, "Lisboa");
    expect(d).toContain("candidatura do site (Be a Driver) · Lisboa");
    expect(d).toContain("Telemóvel: +351912345678 · Email: ana@x.pt");
    expect(d).toContain("Notas: fins de semana");
    expect(leadTaskDescription({ source: "email" }, null)).toContain("email de recrutamento · sem cidade");
  });
  it("é uma tarefa automática (avisos de atraso como as outras automáticas)", () => {
    expect(AUTOMATIC_TASK_SOURCES).toContain("lead");
    expect(isAutomaticTask({ sourceModule: "lead" })).toBe(true);
  });
  it("ligada à automação horária, ao site e a cada mudança nos leads/candidaturas", () => {
    expect(src("server/tasksService.ts")).toContain("const l = await syncLeadTasks(now);");
    expect(src("server/extraLeadsSync.ts")).toContain("await syncLeadTasks(new Date(), { leadIds: [r.leadId] })");
    const r = src("server/routers.ts");
    expect(r.match(/afterLeadChange\(/g)?.length).toBeGreaterThanOrEqual(6);
    const lt = src("server/leadTasks.ts");
    expect(lt).toContain("NOT EXISTS (SELECT 1 FROM tasks lt WHERE lt.sourceModule");
    expect(lt).toContain('if (isDuplicateEntry(err)) { out.skipped++; continue; }');
    expect(lt).not.toMatch(/db\.delete\(|DELETE FROM/);
  });
});
