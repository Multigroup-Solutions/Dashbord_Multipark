import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Sem BD nos testes: o middleware de cidades (centro de custos) dá acesso total.
vi.mock("./cityAccess", async original => ({
  ...await original<object>(),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));
// Criar utilizador escreve na BD; aqui só interessa a regra de acesso do router.
// Contas conhecidas nos testes (sem BD): 1 e 3 são super_admin, 2 é backoffice.
const fakeUsers: Record<number, { id: number; role: string; isActive: number; email: string }> = {
  1: { id: 1, role: "super_admin", isActive: 1, email: "chefe@multipark.pt" },
  2: { id: 2, role: "backoffice", isActive: 1, email: "bo@multipark.pt" },
  3: { id: 3, role: "super_admin", isActive: 1, email: "outro@multipark.pt" },
};
const superCount = { n: 2 };
vi.mock("./db", async original => ({
  ...await original<object>(),
  createManualUser: async (data: { name: string; email: string; role: string }) => ({ id: 1, ...data }),
  getUserById: async (id: number) => fakeUsers[id],
  getUserByEmail: async (email: string) => Object.values(fakeUsers).find(u => u.email === email.trim().toLowerCase()),
  countActiveSuperAdmins: async () => superCount.n,
  updateUser: async () => undefined,
  updateUserRole: async () => undefined,
  toggleUserActive: async () => undefined,
  logActivity: async () => undefined,
}));

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createCtx(overrides: Partial<AuthenticatedUser> = {}): TrpcContext {
  const user: AuthenticatedUser = {
    id: 99,
    openId: "test-user",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    ...overrides,
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

describe("users", () => {
  it("list is accessible to admin users", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "admin" }));
    const result = await caller.users.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("list is blocked for regular users", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "user" }));
    await expect(caller.users.list()).rejects.toThrow();
  });

  it("list is blocked for extra users", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "extra" }));
    await expect(caller.users.list()).rejects.toThrow();
  });

  it("create is accessible to super_admin", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "super_admin" }));
    const result = await caller.users.create({
      name: "Novo User",
      email: "novo@test.com",
      role: "backoffice",
      department: "Operações",
    });
    expect(result).toBeDefined();
    expect(result?.name).toBe("Novo User");
    expect(result?.email).toBe("novo@test.com");
    expect(result?.role).toBe("backoffice");
  });

  // Modelo de acessos (shared/access.ts): admin gere contas ABAIXO dele.
  it("create: admin cria contas abaixo dele, mas não admin", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "admin" }));
    await expect(
      caller.users.create({ name: "Test", email: "t@t.com", role: "user" })
    ).resolves.toBeDefined();
    await expect(
      caller.users.create({ name: "Test", email: "t2@t.com", role: "admin" })
    ).rejects.toThrow();
  });

  it("create is blocked for team_leader/condutor/extra", async () => {
    for (const role of ["team_leader", "condutor", "extra"]) {
      const caller = appRouter.createCaller(createCtx({ role }));
      await expect(
        caller.users.create({ name: "Test", email: "t@t.com", role: "user" })
      ).rejects.toThrow();
    }
  });

  it("create rejects invalid email", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "super_admin" }));
    await expect(
      caller.users.create({ name: "Test", email: "not-an-email", role: "user" })
    ).rejects.toThrow();
  });

  it("update is accessible to super_admin", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "super_admin" }));
    const result = await caller.users.update({
      userId: 1,
      name: "Updated Name",
      department: "TI",
    });
    expect(result).toEqual({ success: true });
  });

  it("update is blocked for admin", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "admin" }));
    await expect(
      caller.users.update({ userId: 1, name: "Hack" })
    ).rejects.toThrow();
  });

  it("toggleActive is accessible to super_admin", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "super_admin" }));
    const result = await caller.users.toggleActive({ userId: 2, isActive: false });
    expect(result).toEqual({ success: true });
  });

  it("toggleActive prevents self-deactivation", async () => {
    const caller = appRouter.createCaller(createCtx({ id: 1, role: "super_admin" }));
    await expect(
      caller.users.toggleActive({ userId: 1, isActive: false })
    ).rejects.toThrow("Não podes desativar a tua própria conta");
  });

  it("toggleActive: admin não mexe num super_admin; team_leader não mexe em ninguém", async () => {
    const admin = appRouter.createCaller(createCtx({ role: "admin" }));
    await expect(
      admin.users.toggleActive({ userId: 3, isActive: false })
    ).rejects.toThrow();
    const tl = appRouter.createCaller(createCtx({ role: "team_leader" }));
    await expect(
      tl.users.toggleActive({ userId: 2, isActive: false })
    ).rejects.toThrow();
  });

  it("toggleActive accepts an optional reason + notes", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "super_admin" }));
    const result = await caller.users.toggleActive({
      userId: 2,
      isActive: false,
      reason: "roubou",
      notes: "Faltou dinheiro na caixa",
    });
    expect(result).toEqual({ success: true });
  });

  it("toggleActive rejects a reason outside the vocabulary", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "super_admin" }));
    await expect(
      caller.users.toggleActive({ userId: 2, isActive: false, reason: "porque_sim" as any })
    ).rejects.toThrow();
  });

  it("toggleActive requires the free text when the reason is \"outro\"", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "super_admin" }));
    await expect(
      caller.users.toggleActive({ userId: 2, isActive: false, reason: "outro" })
    ).rejects.toThrow(/"Outro"/);
  });

  it("toggleActive rejects notes longer than the column", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "super_admin" }));
    await expect(
      caller.users.toggleActive({ userId: 2, isActive: false, notes: "x".repeat(2001) })
    ).rejects.toThrow();
  });

  it("updateRole is accessible to super_admin", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "super_admin" }));
    const result = await caller.users.updateRole({ userId: 2, role: "team_leader" });
    expect(result).toEqual({ success: true });
  });

  it("updateRole rejects a role outside the enum", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "super_admin" }));
    await expect(caller.users.updateRole({ userId: 2, role: "god" as any })).rejects.toThrow();
  });

  it("a super_admin cannot demote themselves", async () => {
    const caller = appRouter.createCaller(createCtx({ id: 1, role: "super_admin" }));
    await expect(caller.users.updateRole({ userId: 1, role: "admin" })).rejects.toThrow(/próprio role/);
    await expect(caller.users.update({ userId: 1, role: "admin" })).rejects.toThrow(/próprio role/);
  });

  it("cannot demote or deactivate the LAST active super_admin", async () => {
    superCount.n = 1;
    try {
      const caller = appRouter.createCaller(createCtx({ id: 99, role: "super_admin" }));
      await expect(caller.users.updateRole({ userId: 3, role: "admin" })).rejects.toThrow(/último super_admin/);
      await expect(caller.users.toggleActive({ userId: 3, isActive: false })).rejects.toThrow(/último super_admin/);
    } finally {
      superCount.n = 2;
    }
    const caller = appRouter.createCaller(createCtx({ id: 99, role: "super_admin" }));
    await expect(caller.users.updateRole({ userId: 3, role: "admin" })).resolves.toEqual({ success: true });
  });

  it("self-edit of email is rejected below super_admin; name still works", async () => {
    const caller = appRouter.createCaller(createCtx({ id: 2, role: "backoffice", email: "bo@multipark.pt" }));
    await expect(caller.users.update({ userId: 2, email: "novo@gmail.com" })).rejects.toThrow(/super_admin/);
    await expect(caller.users.update({ userId: 2, name: "Novo Nome", email: "BO@multipark.pt" })).resolves.toEqual({ success: true });
  });

  it("super_admin email change checks case-insensitive uniqueness", async () => {
    const caller = appRouter.createCaller(createCtx({ id: 99, role: "super_admin" }));
    await expect(caller.users.update({ userId: 2, email: "Chefe@Multipark.pt" })).rejects.toThrow(/Já existe outra conta/);
    await expect(caller.users.update({ userId: 2, email: "livre@multipark.pt" })).resolves.toEqual({ success: true });
  });

  it("reviews.checkoutDrivers / agentHistory exigem frontoffice+", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "extra" }));
    await expect(caller.reviews.checkoutDrivers({ startDate: "2026-09-01", endDate: "2026-09-02" })).rejects.toThrow(/não autorizado/);
    await expect(caller.reviews.agentHistory({ startDate: "2026-09-01", endDate: "2026-09-02", agentName: "x" })).rejects.toThrow(/não autorizado/);
  });

  it("updateRole is blocked for admin", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "admin" }));
    await expect(
      caller.users.updateRole({ userId: 2, role: "super_admin" })
    ).rejects.toThrow();
  });
});
