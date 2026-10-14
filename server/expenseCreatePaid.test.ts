import { beforeEach, describe, expect, it, vi } from "vitest";

// Nova Despesa (Jorge, 14 out 2026) — regras aplicadas NO SERVIDOR:
//  - admin/super admin com método → fica paga (vencimento, senão data da despesa);
//    qualquer outro papel fica sempre pendente, mesmo a enviar um método;
//  - "quem comprou" tem de ser team leader ou acima (só quando muda, ao editar);
//  - a lista de compradores só traz id e nome, por ordem alfabética.

const state = vi.hoisted(() => ({
  created: [] as any[],
  events: [] as any[],
  updated: [] as any[],
  users: new Map<number, { id: number; role: string; isActive: number }>(),
  employees: new Map<number, any>(),
  current: null as any,
}));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: 49, cityName: "Lisboa", cityIds: [49, 50], projectIds: [49, 50], missingCostCenter: false }),
}));
vi.mock("./notify", () => ({ notify: async () => undefined }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  getProjects: async () => [{ id: 49, name: "Lisboa", level: "city", parentId: null }, { id: 50, name: "Porto", level: "city", parentId: null }],
  resolveProjectIds: async (id: number) => [id],
  getUserById: async (id: number) => state.users.get(id) ?? null,
  getAllUsers: async () => [...state.users.values()],
  getEmployeeById: async (id: number) => (state.employees.has(id) ? { employee: state.employees.get(id) } : undefined),
  getAllEmployees: async () => [...state.employees.values()].filter((e) => e.isActive).map((employee) => ({ employee, project: null })),
  getExpenseById: async () => state.current,
  projectExists: async () => true,
  categoryExists: async () => true,
  createExpense: async (data: any) => { state.created.push(data); return [{ insertId: 7 }]; },
  updateExpense: async (_id: number, patch: any) => { state.updated.push(patch); },
  recordExpenseEvent: async (ev: any) => { state.events.push(ev); },
  logActivity: async () => undefined,
}));
import { appRouter } from "./routers";

const caller = (id: number, role: string) => appRouter.createCaller({ user: { id, role }, req: { headers: {} }, res: {} } as any);
const base = { amount: "45,90", expenseDate: "2026-01-01", projectId: 49 };

beforeEach(() => {
  state.created = []; state.events = []; state.updated = []; state.current = null;
  state.users = new Map([[1, { id: 1, role: "super_admin", isActive: 1 }], [2, { id: 2, role: "admin", isActive: 1 }], [3, { id: 3, role: "backoffice", isActive: 1 }], [4, { id: 4, role: "team_leader", isActive: 1 }], [5, { id: 5, role: "condutor", isActive: 1 }]]);
  state.employees = new Map([
    [10, { id: 10, fullName: "Rui Costa", projectId: 49, userId: 4, position: "team_leader", isActive: 1 }],
    [11, { id: 11, fullName: "Extra 12", projectId: 49, userId: null, position: "extra", isActive: 1 }],
    [12, { id: 12, fullName: "Carla Condutora", projectId: 49, userId: 5, position: "driver", isActive: 1 }],
    [13, { id: 13, fullName: "Ana Supervisora", projectId: 50, userId: null, position: "supervisor", isActive: 1 }],
  ]);
});

describe("Nova Despesa já paga — só admin e super admin", () => {
  it("admin com método e vencimento → paga no dia do vencimento (com evento 'paid')", async () => {
    const r = await caller(2, "admin").expenses.create({ ...base, paymentMethod: "transfer", paymentDueDate: "2026-01-10" });
    expect(r).toMatchObject({ status: "paid", paidAt: "2026-01-10" });
    expect(state.created[0]).toMatchObject({ status: "paid", paidAt: "2026-01-10 00:00:00", paymentMethod: "transfer" });
    expect(state.events.map((e) => e.type)).toEqual(["created", "paid"]);
    expect(state.events[1]).toMatchObject({ userId: 2, after: { status: "paid", paidAt: "2026-01-10" } });
  });
  it("super admin com método sem vencimento → paga na data da despesa", async () => {
    await caller(1, "super_admin").expenses.create({ ...base, paymentMethod: "card" });
    expect(state.created[0]).toMatchObject({ status: "paid", paidAt: "2026-01-01 00:00:00" });
  });
  it("admin sem método → pendente, como hoje", async () => {
    await caller(2, "admin").expenses.create({ ...base });
    expect(state.created[0]).toMatchObject({ status: "pending", paidAt: null, paymentMethod: null });
    expect(state.events.map((e) => e.type)).toEqual(["created"]);
  });
  it("backoffice / team leader com método → continua pendente (nunca pago por esta via)", async () => {
    await caller(3, "backoffice").expenses.create({ ...base, paymentMethod: "card", paymentDueDate: "2026-01-05" });
    await caller(4, "team_leader").expenses.create({ ...base, paymentMethod: "cash" });
    expect(state.created.map((c) => [c.status, c.paidAt, c.paymentMethod])).toEqual([["pending", null, "card"], ["pending", null, "cash"]]);
    expect(state.events.some((e) => e.type === "paid")).toBe(false);
  });
});

describe("Quem comprou — team leader e acima", () => {
  it("team leader aceita-se; extra e condutor recusam-se", async () => {
    await caller(2, "admin").expenses.create({ ...base, buyerId: 10 });
    expect(state.created).toHaveLength(1);
    await expect(caller(2, "admin").expenses.create({ ...base, buyerId: 11 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller(2, "admin").expenses.create({ ...base, buyerId: 12 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.created).toHaveLength(1);
  });
  it("ao editar, um comprador antigo que não muda não é revalidado", async () => {
    state.current = { expense: { id: 7, buyerId: 12, status: "pending", approvalStatus: "legacy", creditNoteOfId: null, notes: null }, category: null, project: null };
    await expect(caller(2, "admin").expenses.update({ id: 7, buyerId: 12, notes: "ok" })).resolves.toMatchObject({ success: true });
    await expect(caller(2, "admin").expenses.update({ id: 7, buyerId: 11 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("a lista: só team leader e acima, só id e nome, por ordem alfabética", async () => {
    const list = await caller(2, "admin").expenses.buyers();
    expect(list).toEqual([{ id: 13, fullName: "Ana Supervisora" }, { id: 10, fullName: "Rui Costa" }]);
  });
});

describe("Já paga com data futura — só com confirmação explícita", () => {
  it("admin com vencimento futuro e sem confirmação → recusa e não grava", async () => {
    await expect(caller(2, "admin").expenses.create({ ...base, paymentMethod: "transfer", paymentDueDate: "2099-11-30" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("30/11/2099") });
    expect(state.created).toHaveLength(0);
  });
  it("com confirmFuturePaid: true → grava paga nesse dia", async () => {
    await caller(2, "admin").expenses.create({ ...base, paymentMethod: "transfer", paymentDueDate: "2099-11-30", confirmFuturePaid: true });
    expect(state.created[0]).toMatchObject({ status: "paid", paidAt: "2099-11-30 00:00:00" });
  });
  it("sem método (pendente) o vencimento futuro não pede confirmação; outros papéis também não", async () => {
    await caller(2, "admin").expenses.create({ ...base, paymentDueDate: "2099-11-30" });
    await caller(3, "backoffice").expenses.create({ ...base, paymentMethod: "card", paymentDueDate: "2099-11-30" });
    expect(state.created.map((c) => c.status)).toEqual(["pending", "pending"]);
  });
});

describe("Quem comprou — conta desativada", () => {
  it("o papel de uma conta desativada não conta (condutor na ficha → recusa)", async () => {
    state.users.set(4, { id: 4, role: "team_leader", isActive: 0 });
    state.employees.set(10, { ...state.employees.get(10), position: "driver" });
    await expect(caller(2, "admin").expenses.create({ ...base, buyerId: 10 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await caller(2, "admin").expenses.buyers()).map((b) => b.id)).toEqual([13]);
  });
});
