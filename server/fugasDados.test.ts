import { beforeEach, describe, expect, it, vi } from "vitest";

// Fugas de dados confirmadas no parecer (30 set 2026): o condutor que lia a
// ficha de RH de um colega pelas Despesas, emails pessoais na linha do tempo,
// um admin que se tornava super_admin ao ligar um login a uma ficha, e pontos
// (que bloqueiam o login) confirmados por quem os propôs.

const state = vi.hoisted(() => ({
  users: new Map<number, { id: number; role: string; isActive: number }>(),
  employees: new Map<number, { id: number; projectId: number; userId: number | null }>(),
  penalty: null as null | { id: number; employeeId: number; proposedById: number | null; notes: string | null; clearedAt: null; clearedById: null },
  created: 0,
}));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: false, defaultCityId: 49, cityName: "Lisboa", cityIds: [49], projectIds: [49], missingCostCenter: false }),
}));
vi.mock("./db", async (original) => {
  const chain: any = { from: () => chain, where: () => chain, set: () => chain, limit: async () => (state.penalty ? [state.penalty] : []) };
  return {
    ...(await original<object>()),
    getUserPermissionOverrides: async () => ({}),
    getProjects: async () => [{ id: 49, name: "Lisboa", level: "city", parentId: null }, { id: 50, name: "Porto", level: "city", parentId: null }],
    resolveProjectIds: async (id: number) => [id],
    getUserById: async (id: number) => state.users.get(id) ?? null,
    getEmployeeById: async (id: number) => (state.employees.has(id) ? { employee: state.employees.get(id) } : undefined),
    countActiveSuperAdmins: async () => [...state.users.values()].filter((u) => u.role === "super_admin" && u.isActive).length,
    projectExists: async () => true,
    categoryExists: async () => true,
    createExpense: async () => { state.created++; return [{ insertId: 1 }]; },
    getDb: async () => ({ select: () => chain, update: () => chain }),
  };
});
import { appRouter } from "./routers";
import { EXPENSE_PEOPLE_FIELDS } from "./db";
import { emailTimelineItem, TIMELINE_NO_ACCESS_TEXT } from "./mail/inbox";
import { linkRoleGuard } from "./userAdminRules";
import { penaltyReviewError } from "./rhAccess";

const caller = (id: number, role: string) => appRouter.createCaller({ user: { id, role }, req: { headers: {} }, res: {} } as any);

beforeEach(() => {
  state.users = new Map([[1, { id: 1, role: "super_admin", isActive: 1 }], [2, { id: 2, role: "admin", isActive: 1 }], [3, { id: 3, role: "condutor", isActive: 1 }], [4, { id: 4, role: "team_leader", isActive: 1 }], [5, { id: 5, role: "supervisor", isActive: 1 }]]);
  state.employees = new Map([[10, { id: 10, projectId: 49, userId: 3 }], [20, { id: 20, projectId: 50, userId: null }], [30, { id: 30, projectId: 49, userId: 1 }]]);
  state.penalty = null;
  state.created = 0;
});

describe("Despesas: comprador", () => {
  it("a lista só traz id e nome de quem comprou/registou (nunca a ficha de RH)", () => {
    expect(Object.keys(EXPENSE_PEOPLE_FIELDS.buyer).sort()).toEqual(["fullName", "id"]);
    expect(Object.keys(EXPENSE_PEOPLE_FIELDS.insertedBy).sort()).toEqual(["id", "name"]);
  });
  it("condutor não aponta a despesa a um colega de outra cidade", async () => {
    await expect(caller(3, "condutor").expenses.create({ amount: "10", expenseDate: "2026-09-30", projectId: 49, buyerId: 20 } as any))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.created).toBe(0);
  });
  it("comprador inexistente → recusa", async () => {
    await expect(caller(3, "condutor").expenses.create({ amount: "10", expenseDate: "2026-09-30", projectId: 49, buyerId: 999 } as any))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("Linha do tempo: emails que quem vê não pode abrir", () => {
  const m = { id: 5, threadId: 9, sentAt: "2026-09-30 10:00:00", direction: "in", fromName: "Ana", fromEmail: "ana@x.pt", subject: "Consulta", text: "Texto privado", snippet: null };
  it("sem acesso: sem assunto nem texto, sem link", () => {
    const it0 = emailTimelineItem(m, { label: "Email pessoal", canOpen: false, mailboxKey: null });
    expect(it0).toMatchObject({ subject: "", text: TIMELINE_NO_ACCESS_TEXT, link: null, who: "Ana", source: "Email pessoal" });
    expect(JSON.stringify(it0)).not.toContain("privado");
  });
  it("com acesso: como antes", () => {
    expect(emailTimelineItem(m, { label: "Geral", canOpen: true, mailboxKey: "geral" })).toMatchObject({ subject: "Consulta", text: "Texto privado", link: "/comunicacao?caixa=geral&t=9" });
  });
});

describe("Ligar um login a uma ficha", () => {
  const sa = (count = 2) => count;
  it("admin não se liga à ficha de um super_admin (herdava o papel)", () => {
    expect(linkRoleGuard({ actor: { id: 2, role: "admin" }, linked: { id: 2, role: "admin", isActive: 1 }, primaryRole: "super_admin", activeSuperAdminCount: sa() })).toMatch(/super_admin/);
  });
  it("admin não liga um super_admin a uma ficha de papel mais baixo (despromovia-o)", () => {
    expect(linkRoleGuard({ actor: { id: 2, role: "admin" }, linked: { id: 1, role: "super_admin", isActive: 1 }, primaryRole: "extra", activeSuperAdminCount: sa() })).not.toBeNull();
  });
  it("o último super_admin não é despromovido nem por outro super_admin", () => {
    expect(linkRoleGuard({ actor: { id: 7, role: "super_admin" }, linked: { id: 1, role: "super_admin", isActive: 1 }, primaryRole: "extra", activeSuperAdminCount: 1 })).toMatch(/último super_admin/);
  });
  it("casos normais passam (extra ligado à ficha de um condutor; conta principal)", () => {
    expect(linkRoleGuard({ actor: { id: 2, role: "admin" }, linked: { id: 8, role: "user", isActive: 1 }, primaryRole: "condutor", activeSuperAdminCount: sa() })).toBeNull();
    expect(linkRoleGuard({ actor: { id: 2, role: "admin" }, linked: { id: 8, role: "user", isActive: 1 }, primaryRole: null, activeSuperAdminCount: sa() })).toBeNull();
  });
  it("na rota: admin a ligar-se à ficha de um super_admin → FORBIDDEN", async () => {
    await expect(caller(2, "admin").identityLinks.linkUser({ employeeId: 30, userId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Pontos: quem confirma", () => {
  it("team leader não confirma nem anula", () => {
    expect(penaltyReviewError({ reviewer: { id: 4, role: "team_leader" }, proposedById: 9, decision: "confirmed" })).not.toBeNull();
    expect(penaltyReviewError({ reviewer: { id: 4, role: "team_leader" }, proposedById: 9, decision: "dismissed" })).not.toBeNull();
  });
  it("supervisor não confirma o que ele próprio propôs (pode anular)", () => {
    expect(penaltyReviewError({ reviewer: { id: 5, role: "supervisor" }, proposedById: 5, decision: "confirmed" })).toMatch(/propuseste/);
    expect(penaltyReviewError({ reviewer: { id: 5, role: "supervisor" }, proposedById: 5, decision: "dismissed" })).toBeNull();
    expect(penaltyReviewError({ reviewer: { id: 5, role: "supervisor" }, proposedById: 4, decision: "confirmed" })).toBeNull();
  });
  it("na rota do RH: team leader a confirmar → FORBIDDEN", async () => {
    state.penalty = { id: 1, employeeId: 10, proposedById: 5, notes: null, clearedAt: null, clearedById: null };
    await expect(caller(4, "team_leader").rh.penalties.review({ id: 1, decision: "confirmed" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
