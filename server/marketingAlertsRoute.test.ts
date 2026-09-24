import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ load: vi.fn(), execute: vi.fn() }));
vi.mock("./cityAccess", async original => ({ ...(await original<object>()), loadCityAccess: f.load }));
vi.mock("./db", async original => ({ ...(await original<object>()), getDb: async () => ({ execute: f.execute }) }));
vi.mock("./integrations/googleAds/marketingStats", () => ({
  getMarketingStats: async () => ({
    spend: 500,
    attributionQuality: { siteBookings: 100, withOriginUrl: 90, withClickId: 20, attributed: 20 },
    coverage: { status: "ok" },
    byCampaign: [
      { key: "api:3:111", name: "Sem nada", accountName: "Airpark", source: "api", cost: 120, conversions: 0 },
      { key: "api:3:222", name: "Com reservas", accountName: "Airpark", source: "api", cost: 300, conversions: 0 },
    ],
  }),
}));
vi.mock("./integrations/googleAds/adMetrics", () => ({ getAdMetrics: async () => ({ totals: { cost: 100 }, unmappedCampaigns: 0 }) }));

import { appRouter } from "./routers";
const caller = (role = "backoffice") =>
  appRouter.createCaller({ user: { id: 7, role }, req: { headers: {} }, res: {} } as any);

beforeEach(() => {
  vi.clearAllMocks();
  f.load.mockResolvedValue({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false });
  f.execute.mockResolvedValue([[{ ext: "222", n: 4 }], []]);
});

describe("marketing.alerts", () => {
  it("só backoffice+", async () => {
    await expect(caller("frontoffice").marketing.alerts({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("cruza a campanha com as reservas atribuídas pelo ID externo", async () => {
    const r = await caller().marketing.alerts({});
    expect(r.alerts.filter((a) => a.code === "campaign_no_results").map((a) => a.title)).toEqual(["Campanha a gastar sem resultados: Sem nada"]);
  });
});
