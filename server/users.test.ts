import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

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

  it("create is blocked for admin (non-super_admin)", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "admin" }));
    await expect(
      caller.users.create({ name: "Test", email: "t@t.com", role: "user" })
    ).rejects.toThrow();
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

  it("toggleActive is blocked for non-super_admin", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "admin" }));
    await expect(
      caller.users.toggleActive({ userId: 2, isActive: false })
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

  it("updateRole is blocked for admin", async () => {
    const caller = appRouter.createCaller(createCtx({ role: "admin" }));
    await expect(
      caller.users.updateRole({ userId: 2, role: "super_admin" })
    ).rejects.toThrow();
  });
});
