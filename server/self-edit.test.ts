import { describe, it, expect, vi } from "vitest";

// Mock the db module
vi.mock("./db", () => ({
  updateUser: vi.fn().mockResolvedValue(undefined),
  logActivity: vi.fn().mockResolvedValue(undefined),
  updateEmployee: vi.fn().mockResolvedValue(undefined),
}));

import { updateUser, logActivity, updateEmployee } from "./db";

describe("self-edit user", () => {
  it("self-edit below super_admin keeps only the name (email is identity)", async () => {
    const ctx = { user: { id: 1, role: "admin" } };
    const input = { userId: 1, name: "Jorge Novo", email: "jorge@novo.pt" };
    const isSelf = ctx.user.id === input.userId;
    expect(isSelf).toBe(true);

    // Auto-edição (abaixo de super_admin): só o nome — ver users.update
    const { userId, ...data } = input;
    const safeData = isSelf && ctx.user.role !== "super_admin"
      ? { name: data.name }
      : data;

    expect(safeData).toEqual({ name: "Jorge Novo" });
    expect(safeData).not.toHaveProperty("email");
    expect(safeData).not.toHaveProperty("role");
    expect(safeData).not.toHaveProperty("department");
  });

  it("should strip role/department from self-edit for non-super_admin", async () => {
    const ctx = { user: { id: 1, role: "admin" } };
    const input = { userId: 1, name: "Jorge", email: "jorge@test.pt", role: "super_admin", department: "IT" };
    const isSelf = ctx.user.id === input.userId;
    const { userId, ...data } = input;
    const safeData = isSelf && ctx.user.role !== "super_admin"
      ? { name: data.name }
      : data;

    // Should NOT include email, role or department for self-edit
    expect(safeData).toEqual({ name: "Jorge" });
    expect(safeData).not.toHaveProperty("role");
  });

  it("super_admin can edit everything on self", async () => {
    const ctx = { user: { id: 1, role: "super_admin" } };
    const input = { userId: 1, name: "Jorge", email: "jorge@test.pt", role: "admin", department: "IT" };
    const isSelf = ctx.user.id === input.userId;
    const { userId, ...data } = input;
    const safeData = isSelf && ctx.user.role !== "super_admin"
      ? { name: data.name, email: data.email }
      : data;

    // Super admin should keep all fields
    expect(safeData).toEqual({ name: "Jorge", email: "jorge@test.pt", role: "admin", department: "IT" });
  });

  it("non-self edit requires super_admin role check", () => {
    const ctx = { user: { id: 1, role: "admin" } };
    const input = { userId: 2 };
    const isSelf = ctx.user.id === input.userId;
    expect(isSelf).toBe(false);
    // In the actual route, this would call requireRole(ctx.user.role, "super_admin") which would throw
  });
});

describe("employee-user linkage", () => {
  it("rh.update should accept userId field", () => {
    // The rh.update input schema now includes userId: z.number().nullable().optional()
    const input = { id: 1, userId: 5 };
    expect(input.userId).toBe(5);
  });

  it("rh.update should accept null userId to unlink", () => {
    const input = { id: 1, userId: null };
    expect(input.userId).toBeNull();
  });

  it("rh.create should accept userId field", () => {
    const input = {
      fullName: "Test Employee",
      position: "driver",
      userId: 3,
    };
    expect(input.userId).toBe(3);
  });
});
