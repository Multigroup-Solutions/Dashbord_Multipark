import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Sem BD nos testes: o middleware de cidades (centro de custos) dá acesso total.
vi.mock("./cityAccess", async original => ({
  ...await original<object>(),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));

// ─── Mock db functions ─────────────────────────────────────────────────────
vi.mock("./db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getMultiparkBookings: vi.fn().mockResolvedValue([]),
    getMultiparkBookingStats: vi.fn().mockResolvedValue({
      total: 5, today: 1, thisWeek: 3, thisMonth: 5,
      byStatus: [{ name: "confirmed", count: 3 }],
      byParkingType: [{ name: "COVERED", count: 4 }],
    }),
    logActivity: vi.fn().mockResolvedValue(undefined),
  };
});

// ─── Context helpers ───────────────────────────────────────────────────────
type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAdminContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "admin-user",
    email: "admin@multipark.pt",
    name: "Admin User",
    loginMethod: "manus",
    role: "super_admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("multipark.reservasDoDia", () => {
  it("sem BD da Multipark configurada → aviso, sem lançar", async () => {
    const saved = process.env.DATABASE_URL_MULTIPARK;
    delete process.env.DATABASE_URL_MULTIPARK;
    try {
      const caller = appRouter.createCaller(createAdminContext());
      const r = await caller.multipark.reservasDoDia({ day: "2026-09-27" });
      expect(r).toMatchObject({ available: false, code: "NOT_CONFIGURED" });
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL_MULTIPARK = saved;
    }
  });

  it("recusa um dia mal escrito", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    await expect(caller.multipark.reservasDoDia({ day: "27/09/2026" })).rejects.toThrow();
  });
});

describe("multipark.opsList (listas por período)", () => {
  it("sem BD da Multipark configurada → aviso, sem lançar", async () => {
    const saved = process.env.DATABASE_URL_MULTIPARK;
    delete process.env.DATABASE_URL_MULTIPARK;
    try {
      const caller = appRouter.createCaller(createAdminContext());
      for (const kind of ["reservas", "entradas", "saidas", "cancelados"] as const) {
        const r = await caller.multipark.opsList({ kind, from: "2026-09-27", to: "2026-09-27", state: "qualquer" });
        expect(r).toMatchObject({ available: false, code: "NOT_CONFIGURED" });
      }
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL_MULTIPARK = saved;
    }
  });

  it("recusa períodos com mais de 62 dias, invertidos ou mal escritos", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    await expect(caller.multipark.opsList({ kind: "reservas", from: "2026-01-01", to: "2026-03-31" })).rejects.toThrow(/62/);
    await expect(caller.multipark.opsList({ kind: "reservas", from: "2026-09-30", to: "2026-09-01" })).rejects.toThrow();
    await expect(caller.multipark.opsList({ kind: "reservas", from: "27/09/2026", to: "2026-09-27" })).rejects.toThrow();
    await expect(caller.multipark.opsList({ kind: "outra" as any, from: "2026-09-27", to: "2026-09-27" })).rejects.toThrow();
  });
});
