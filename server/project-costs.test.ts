import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Sem BD nos testes: o middleware de cidades (centro de custos) dá acesso total.
vi.mock("./cityAccess", async original => ({
  ...await original<object>(),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createCtx(role: string = "user"): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: role as any,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

describe("projects.costs", () => {
  it("returns an array when called without filters", async () => {
    const ctx = createCtx("admin");
    const caller = appRouter.createCaller(ctx);
    const result = await caller.projects.costs();
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns an array when called with year filter", async () => {
    const ctx = createCtx("admin");
    const caller = appRouter.createCaller(ctx);
    const result = await caller.projects.costs({ year: 2026 });
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns an array when called with year + month filter", async () => {
    const ctx = createCtx("admin");
    const caller = appRouter.createCaller(ctx);
    const result = await caller.projects.costs({ year: 2026, month: 1 });
    expect(Array.isArray(result)).toBe(true);
  });

  it("each item has required cost fields", async () => {
    const ctx = createCtx("admin");
    const caller = appRouter.createCaller(ctx);
    const result = await caller.projects.costs();
    if (result.length > 0) {
      const item = result[0];
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("name");
      expect(item).toHaveProperty("level");
      expect(item).toHaveProperty("budget");
      expect(item).toHaveProperty("expenses");
      expect(item).toHaveProperty("salaryCost");
      expect(item).toHaveProperty("totalCost");
      expect(item).toHaveProperty("remaining");
      expect(item).toHaveProperty("percentUsed");
      expect(item).toHaveProperty("managerName");
      expect(item).toHaveProperty("employeeCount");
      expect(item).toHaveProperty("expenseCount");
      expect(typeof item.budget).toBe("number");
      expect(typeof item.expenses).toBe("number");
      expect(typeof item.salaryCost).toBe("number");
      expect(typeof item.totalCost).toBe("number");
      expect(typeof item.remaining).toBe("number");
      expect(typeof item.percentUsed).toBe("number");
    }
  });

  it("totalCost equals expenses + salaryCost for each item", async () => {
    const ctx = createCtx("admin");
    const caller = appRouter.createCaller(ctx);
    const result = await caller.projects.costs();
    for (const item of result) {
      expect(item.totalCost).toBeCloseTo(item.expenses + item.salaryCost, 2);
    }
  });

  it("remaining equals budget - totalCost for each item", async () => {
    const ctx = createCtx("admin");
    const caller = appRouter.createCaller(ctx);
    const result = await caller.projects.costs();
    for (const item of result) {
      expect(item.remaining).toBeCloseTo(item.budget - item.totalCost, 2);
    }
  });

  it("rejects unauthenticated calls", async () => {
    const ctx: TrpcContext = {
      user: null,
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: { clearCookie: () => {} } as TrpcContext["res"],
    };
    const caller = appRouter.createCaller(ctx);
    await expect(caller.projects.costs()).rejects.toThrow();
  });
});
