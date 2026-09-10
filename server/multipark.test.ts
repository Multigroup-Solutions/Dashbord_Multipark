import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

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

vi.mock("./jobs/multiparkBookingSync", () => ({
  syncBookings: vi.fn().mockResolvedValue({ success: true, processed: 4, created: 1, updated: 3, errors: [], enrichTargets: [] }),
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
    getSnapshotKPIs: vi.fn().mockResolvedValue({
      totalBookings: 242, totalRevenue: 1244786, checkins: 50, checkouts: 30,
      cancelled: 10, reserved: 152,
      byPark: [{ name: "Airpark - Lisboa", bookings: 100, revenue: 600000, checkins: 20, checkouts: 15 }],
      byCity: [{ name: "Lisboa", bookings: 150, revenue: 800000 }],
      byDay: [{ date: "2026-03-01", bookings: 80, revenue: 400000, checkins: 20, checkouts: 10 }],
      campaigns: { "Parclick": 15, "Parkvia": 8 },
    }),
    getDailySnapshots: vi.fn().mockResolvedValue([
      { id: 1, snapshotDate: new Date("2026-03-01"), parkName: "Airpark - Lisboa", city: "Lisboa", totalBookings: 80, totalRevenue: 400000 },
    ]),
    upsertDailySnapshot: vi.fn().mockResolvedValue({ id: 1, action: "created" }),
    deleteSnapshotsByDateRange: vi.fn().mockResolvedValue(5),
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

describe("multipark.kpis", () => {
  it("returns aggregated KPIs", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.multipark.kpis({});
    expect(result.totalBookings).toBe(242);
    expect(result.totalRevenue).toBe(1244786);
    expect(result.checkins).toBe(50);
    expect(result.checkouts).toBe(30);
    expect(result.cancelled).toBe(10);
    expect(result.reserved).toBe(152);
    expect(result.byPark).toHaveLength(1);
    expect(result.byCity).toHaveLength(1);
    expect(result.byDay).toHaveLength(1);
    expect(result.campaigns).toHaveProperty("Parclick", 15);
  });

  it("accepts date filters", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.multipark.kpis({
      from: "2026-03-01",
      to: "2026-03-03T23:59:59.999Z",
      city: "Lisboa",
    });
    expect(result.totalBookings).toBe(242);
  });
});

describe("multipark.snapshots", () => {
  it("returns daily snapshots", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.multipark.snapshots({});
    expect(result).toHaveLength(1);
    expect(result[0].parkName).toBe("Airpark - Lisboa");
    expect(result[0].totalBookings).toBe(80);
  });
});

describe("multipark.syncLogs", () => {
  it("returns sync log list", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.multipark.syncLogs();
    expect(result).toEqual([]);
  });
});

describe("multipark.triggerSync", () => {
  it("triggers sync for admin users and returns success", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.multipark.triggerSync({ startDate: "2026-09-01", endDate: "2026-09-10" });
    expect(result.success).toBe(true);
    expect(result.processed).toBe(4);
    expect(result.updated).toBe(3);
  });

  it("rejects non-admin users", async () => {
    const caller = appRouter.createCaller(createRegularContext());
    await expect(caller.multipark.triggerSync({ startDate: "2026-09-01", endDate: "2026-09-10" })).rejects.toThrow();
  });
});

describe("multipark.importExcel", () => {
  it("rejects non-admin users", async () => {
    const caller = appRouter.createCaller(createRegularContext());
    await expect(
      caller.multipark.importExcel({ fileBase64: "dGVzdA==", filename: "test.xlsx" })
    ).rejects.toThrow();
  });
});
