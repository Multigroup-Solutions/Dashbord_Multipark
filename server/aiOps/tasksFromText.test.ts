/**
 * "Criar tarefas a partir de texto": a IA (simulada) só PROPÕE; as tarefas
 * só nascem no passo de confirmação, e só as confirmadas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  runAi: vi.fn(),
  available: vi.fn(async () => true),
  created: [] as any[],
  assignees: [] as any[],
}));

vi.mock("../_core/ai/run", () => ({ runAi: (...a: any[]) => h.runAi(...a) }));
vi.mock("../_core/ai/status", () => ({ aiFeatureAvailableFresh: (...a: any[]) => h.available(...a) }));
vi.mock("../cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityName: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));
vi.mock("../db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  getEmployeeByUserId: async () => ({ employee: { id: 1, fullName: "Eu" } }),
  logActivity: async () => undefined,
  resolveProjectIds: async (id: number) => [id],
  createTask: async (t: any) => { h.created.push(t); return 100 + h.created.length; },
  setTaskAssignees: async (id: number, ids: number[]) => { h.assignees.push([id, ids]); },
}));
vi.mock("../tasksService", async (original) => ({
  ...(await original<object>()),
  assignableEmployees: async () => [
    { id: 7, fullName: "Rui Costa", projectId: 1 },
    { id: 8, fullName: "Ana Martins", projectId: 1 },
    { id: 9, fullName: "Ana Sousa", projectId: 1 },
  ],
}));

import { tasksRouter } from "../tasksRouter";
import { matchAssignee, normalizeProposals, validDueDate } from "./tasksFromText";

const caller = (role: string) => tasksRouter.createCaller({ user: { id: 1, role, name: "X" }, req: { headers: {} }, res: {} } as any);

beforeEach(() => {
  h.runAi.mockReset();
  h.available.mockReset();
  h.available.mockImplementation(async () => true);
  h.created = [];
  h.assignees = [];
});

describe("tarefas a partir de texto", () => {
  it("correspondência de responsável no código (primeiro nome único ou nome completo)", () => {
    const c = [{ id: 7, fullName: "Rui Costa" }, { id: 8, fullName: "Ana Martins" }, { id: 9, fullName: "Ana Sousa" }];
    expect(matchAssignee("Rui", c)?.id).toBe(7);
    expect(matchAssignee("rui costa", c)?.id).toBe(7);
    expect(matchAssignee("Ana", c)).toBeNull(); // ambíguo
    expect(matchAssignee("Ana Sousa", c)?.id).toBe(9);
    expect(matchAssignee(null, c)).toBeNull();
  });

  it("limpa a proposta: títulos repetidos, prazos fora do intervalo, prioridade", () => {
    expect(validDueDate("2026-09-25", "2026-09-24")).toBe("2026-09-25");
    expect(validDueDate("2025-01-01", "2026-09-24")).toBeNull();
    expect(validDueDate("amanhã", "2026-09-24")).toBeNull();
    const out = normalizeProposals([
      { title: "Ligar ao cliente", assigneeHint: "Rui", dueDate: "2026-09-25", priority: "high" },
      { title: "ligar ao cliente", assigneeHint: null, dueDate: null, priority: "low" },
      { title: "Ok", assigneeHint: null, dueDate: null, priority: "low" },
      { title: "Repor rolos", assigneeHint: "Zé", dueDate: "2030-01-01", priority: "???" },
    ], [{ id: 7, fullName: "Rui Costa" }], "2026-09-24");
    expect(out).toEqual([
      { title: "Ligar ao cliente", description: null, assigneeHint: "Rui", suggestedAssigneeId: 7, suggestedAssigneeName: "Rui Costa", dueDate: "2026-09-25", priority: "high" },
      { title: "Repor rolos", description: null, assigneeHint: "Zé", suggestedAssigneeId: null, suggestedAssigneeName: null, dueDate: null, priority: "medium" },
    ]);
  });

  it("propor NÃO cria nada; confirmar cria só as confirmadas", async () => {
    h.runAi.mockResolvedValueOnce({ output: { tasks: [
      { title: "Ligar ao cliente da reclamação 123", description: null, assigneeHint: "Rui", dueDate: null, priority: "high" },
      { title: "Repor rolos do MB", description: null, assigneeHint: null, dueDate: null, priority: "medium" },
    ] } });
    const p = await caller("supervisor").proposeFromText({ text: "O Rui liga ao cliente da reclamação 123. Repor rolos do MB." });
    expect(p.proposals).toHaveLength(2);
    expect(p.proposals[0]).toMatchObject({ suggestedAssigneeId: 7, suggestedAssigneeName: "Rui Costa" });
    expect(h.created).toEqual([]);
    expect(h.runAi.mock.calls[0][0]).toMatchObject({ feature: "tasks_from_text" });
    // os nomes da equipa não vão para a IA
    expect(h.runAi.mock.calls[0][0].input).not.toMatch(/Martins|Sousa|Costa/);

    const r = await caller("supervisor").createFromProposals({ tasks: [{ title: p.proposals[0].title, assigneeId: 7, priority: "high", dueDate: "2026-09-25" }] });
    expect(r.created).toBe(1);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ title: "Ligar ao cliente da reclamação 123", assigneeId: 7, taskPriority: "high", dueDate: "2026-09-25 00:00:00", createdById: 1 });
    expect(h.assignees).toEqual([[101, [7]]]);
  });

  it("interruptor desligado → erro claro e nenhuma chamada", async () => {
    h.available.mockImplementation(async () => false);
    await expect(caller("supervisor").proposeFromText({ text: "Repor rolos do MB amanhã." })).rejects.toThrow(/desligada/);
    expect(h.runAi).not.toHaveBeenCalled();
  });

  it("quem não edita tarefas não propõe nem cria", async () => {
    await expect(caller("extra").proposeFromText({ text: "Repor rolos do MB amanhã." })).rejects.toThrow();
    await expect(caller("extra").createFromProposals({ tasks: [{ title: "x", priority: "low" }] })).rejects.toThrow();
    expect(h.created).toEqual([]);
  });
});
