import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Sem BD nos testes: o middleware de cidades (centro de custos) dá acesso total.
vi.mock("./cityAccess", async original => ({
  ...await original<object>(),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));

// ─── Mock the multipark module ─────────────────────────────────────────────
vi.mock("./multipark", () => ({
  healthCheck: vi.fn().mockResolvedValue({ status: "ok", timestamp: "2026-03-03T12:00:00Z", version: "1.0.0" }),
  checkAvailability: vi.fn().mockResolvedValue({
    available: true,
    totalSpots: 1124,
    availableSpots: 1094,
    message: "1094 spot(s) available for the selected dates",
  }),
  listParks: vi.fn().mockResolvedValue({
    parks: [
      { id: "park1", name: "Skypark - Porto", address: "Av. do Aeroporto 294", lat: 41.238, lng: -8.667, featured: false },
    ],
  }),
  testConnection: vi.fn().mockResolvedValue({ ok: true, message: "API OK (v1.0.0)", version: "1.0.0" }),
}));

const repair = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./jobs/multiparkBookingSync", () => ({
  REPAIR_MAX_DAYS: 3,
  runRepairSync: repair.run,
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
    getSyncLogs: vi.fn().mockResolvedValue([]),
    createSyncLog: vi.fn().mockResolvedValue(undefined),
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

function createRegularContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 2,
    openId: "regular-user",
    email: "user@multipark.pt",
    name: "Regular User",
    loginMethod: "manus",
    role: "user",
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

describe("multipark.testConnection", () => {
  it("returns connection status for admin users", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.multipark.testConnection();
    expect(result).toEqual({ ok: true, message: "API OK (v1.0.0)", version: "1.0.0" });
  });

  it("rejects non-admin users", async () => {
    const caller = appRouter.createCaller(createRegularContext());
    await expect(caller.multipark.testConnection()).rejects.toThrow();
  });
});

describe("multipark.checkAvailability", () => {
  it("returns availability data with correct params", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.multipark.checkAvailability({
      checkIn: "2026-03-10",
      checkOut: "2026-03-15",
      vehicleType: "CAR",
      parkingType: "COVERED",
    });
    expect(result.available).toBe(true);
    expect(result.totalSpots).toBe(1124);
    expect(result.availableSpots).toBe(1094);
    expect(result.message).toContain("1094");
  });
});

describe("multipark.listParks", () => {
  it("returns list of parks", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.multipark.listParks();
    expect(result.parks).toHaveLength(1);
    expect(result.parks[0].name).toBe("Skypark - Porto");
    expect(result.parks[0].lat).toBeCloseTo(41.238, 2);
  });
});

describe("multipark.syncLogs", () => {
  it("returns sync log list", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.multipark.syncLogs();
    expect(result).toEqual([]);
  });
});

describe("multipark.triggerSync (Reparar período)", () => {
  const okResult = { success: true, processed: 4, created: 1, updated: 3, errors: [], enrichTargets: ["x"], partial: false,
    skippedJobs: 0, parkStatus: {}, parkErrors: [], totalMismatches: [] };

  it("repara até 3 dias e não devolve a lista de ids", async () => {
    repair.run.mockResolvedValueOnce({ busy: false, result: okResult, enriched: 0, historyFetched: 0 });
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.multipark.triggerSync({ startDate: "2026-09-08", endDate: "2026-09-10" });
    expect(result.success).toBe(true);
    expect(result.processed).toBe(4);
    expect(result.updated).toBe(3);
    expect(result).not.toHaveProperty("enrichTargets");
    expect(repair.run).toHaveBeenCalledWith(expect.objectContaining({ startDate: "2026-09-08", endDate: "2026-09-10", owner: "manual" }));
  });

  it("recusa mais de 3 dias", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    await expect(caller.multipark.triggerSync({ startDate: "2026-09-01", endDate: "2026-09-10" })).rejects.toThrow();
  });

  it("devolve 'já a correr' quando o trinco está ocupado", async () => {
    repair.run.mockResolvedValueOnce({ busy: true });
    const caller = appRouter.createCaller(createAdminContext());
    await expect(caller.multipark.triggerSync({ startDate: "2026-09-09", endDate: "2026-09-10" })).rejects.toThrow(/já a correr/);
  });

  it("recusa quem não tem acesso e o supervisor de cidade", async () => {
    await expect(appRouter.createCaller(createRegularContext()).multipark.triggerSync({ startDate: "2026-09-09", endDate: "2026-09-10" })).rejects.toThrow();
    const sup = createRegularContext();
    sup.user = { ...sup.user!, role: "supervisor" };
    await expect(appRouter.createCaller(sup).multipark.triggerSync({ startDate: "2026-09-09", endDate: "2026-09-10" })).rejects.toThrow(/nacional/);
  });
});
