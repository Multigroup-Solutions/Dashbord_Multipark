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
