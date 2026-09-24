import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  load: vi.fn(),
  list: vi.fn(),
  profile: vi.fn(),
  stats: vi.fn(),
  denied: false,
}));
vi.mock("./cityAccess", async original => ({ ...(await original<object>()), loadCityAccess: f.load }));
vi.mock("./db", async original => ({
  ...(await original<object>()),
  getDb: async () => ({ execute: async () => [[], []] }),
  getUserPermissionOverrides: async () => (f.denied ? { "finance.view_totals": "deny" } : {}),
}));
vi.mock("./clientsCrm", async original => ({
  ...(await original<object>()),
  listClients: f.list,
  getClientProfile: f.profile,
  clientsStats: f.stats,
  countBookingsWithoutEmail: async () => 4,
}));

import { appRouter } from "./routers";
import { cityScope } from "./cityScope";

const caller = (role = "backoffice") =>
  appRouter.createCaller({ user: { id: 123, role }, req: { headers: {} }, res: {} } as any);
const row = { email: "ana@x.pt", totalSpent: 500, avgSpend: 100, segments: ["recurring", "vip"] };

beforeEach(() => {
  vi.clearAllMocks();
  f.denied = false;
  f.load.mockResolvedValue({ all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false });
  f.list.mockImplementation(async () => ({ rows: [row], total: 1, page: 1, pageSize: 50, vipThreshold: 300, scope: cityScope.getStore() }));
  f.stats.mockResolvedValue({ clients: 1, recurring: 1, vip: 1, atRisk: 0, partners: 0, newLast30d: 0, upcoming: 0, vipThreshold: 300 });
  f.profile.mockImplementation(async () => ({ ...row, parks: [{ parkName: "P", city: null, bookings: 1, spent: 50 }], bookings_list: [{ id: 1, totalPrice: "50" }] }));
});

describe("CRM — rotas e permissões", () => {
  it("sem filtro mantém a cidade da conta", async () => {
    const r: any = await caller().clients.list({});
    expect(r.scope).toMatchObject({ projectIds: [50, 65] });
  });

  it("recusa outra cidade antes de consultar", async () => {
    await expect(caller().clients.list({ projectId: 49 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller().clients.profile({ email: "ana@x.pt", projectId: 49 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.list).not.toHaveBeenCalled();
    expect(f.profile).not.toHaveBeenCalled();
  });

  it("extras não veem clientes", async () => {
    await expect(caller("extra").clients.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.list).not.toHaveBeenCalled();
  });

  it.each(["frontoffice", "backoffice"])("sem totais (%s): sem gasto, sem VIP e sem ordenar por gasto", async (role) => {
    f.denied = true;
    await expect(caller(role).clients.list({ sort: "totalSpent" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(role).clients.list({ segment: "vip" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const l = await caller(role).clients.list({});
    expect(l.canSeeTotals).toBe(false);
    expect(l.rows[0]).toMatchObject({ totalSpent: null, avgSpend: null, segments: ["recurring"] });
    const s = await caller(role).clients.stats({});
    expect(s).toMatchObject({ canSeeTotals: false, vip: null, vipThreshold: null, bookingsWithoutEmail: 4 });
    const p: any = await caller(role).clients.profile({ email: "ana@x.pt" });
    expect(p).toMatchObject({ canSeeTotals: false, totalSpent: null, segments: ["recurring"] });
    expect(p.parks[0].spent).toBe(0);
    expect(p.bookings_list[0].totalPrice).toBeNull();
  });

  it("com totais vê tudo", async () => {
    const l = await caller("backoffice").clients.list({ sort: "totalSpent", segment: "vip" });
    expect(l.rows[0]).toMatchObject({ totalSpent: 500, segments: ["recurring", "vip"] });
    expect(await caller().clients.stats({})).toMatchObject({ canSeeTotals: true, vip: 1 });
  });
});
