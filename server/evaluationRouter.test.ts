import { beforeEach, describe, expect, it, vi } from "vitest";

// "A minha avaliação" e o detalhe: o colaborador vem SEMPRE da sessão.
const state = vi.hoisted(() => ({ loaded: [] as any[], created: [] as any[], adjust: vi.fn() }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityName: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getEmployeeByUserId: async (userId: number) => (userId === 1 ? { employee: { id: 7, fullName: "Eu Próprio", projectId: 49 } } : null),
  getEmployeeById: async (id: number) => ({ employee: { id, projectId: 49, userId: null } }),
  logActivity: async () => undefined,
}));
vi.mock("./evaluationEngine", () => ({
  currentOperationalDay: () => "2026-09-24",
  loadEvaluatedDays: async (opts: any) => { state.loaded.push(opts); return []; },
  listDisputes: async () => [],
  createDispute: async (d: any) => { state.created.push(d); return 1; },
  createAdjustment: async (a: any) => { state.adjust(a); return 1; },
  getAdjustment: async () => null, getDispute: async () => null, recomputeRange: async () => ({}),
  resolveDispute: async () => true, voidAdjustment: async () => undefined,
}));
import { evaluationRouter } from "./evaluationRouter";

const caller = (role: string, id = 1) => evaluationRouter.createCaller({ user: { id, role, name: "X" }, req: { headers: {} }, res: {} } as any);
const range = { from: "2026-09-01", to: "2026-09-07" };
beforeEach(() => { state.loaded = []; state.created = []; state.adjust.mockClear(); });

describe("A minha avaliação (só os próprios dados, no servidor)", () => {
  it("mine usa a ficha da sessão", async () => {
    const r = await caller("extra").mine(range);
    expect(r.employee).toEqual({ id: 7, fullName: "Eu Próprio" });
    expect(state.loaded[0]).toMatchObject({ employeeIds: [7] });
  });
  it("sem ficha → vazio (nunca os dados de outra pessoa)", async () => {
    const r = await caller("extra", 2).mine(range);
    expect(r.employee).toBeNull();
    expect(state.loaded).toHaveLength(0);
  });
  it("extra não vê o detalhe de outra pessoa nem o ranking", async () => {
    await expect(caller("extra").employeeDays({ ...range, employeeId: 8 })).rejects.toThrow();
    await expect(caller("extra").ranking(range)).rejects.toThrow();
    await expect(caller("extra").employeeDays({ ...range, employeeId: 7 })).resolves.toBeTruthy();
  });
  it("contestar é sempre sobre a própria ficha", async () => {
    await caller("extra").disputes.create({ day: "2026-09-03", metric: "delays", comment: "Cheguei a horas" });
    expect(state.created[0]).toMatchObject({ employeeId: 7, day: "2026-09-03", metric: "delays" });
  });
  it("ninguém ajusta a própria avaliação; extra não ajusta", async () => {
    await expect(caller("supervisor").adjust({ employeeId: 7, day: "2026-09-03", metric: "delays", delta: -1, reason: "teste" })).rejects.toThrow(/própria/);
    await expect(caller("extra").adjust({ employeeId: 8, day: "2026-09-03", metric: "delays", delta: -1, reason: "teste" })).rejects.toThrow();
    await caller("supervisor").adjust({ employeeId: 8, day: "2026-09-03", metric: "delays", delta: -1, reason: "teste" });
    expect(state.adjust).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 8, metric: "delays", delta: -1, authorId: 1 }));
  });
});
