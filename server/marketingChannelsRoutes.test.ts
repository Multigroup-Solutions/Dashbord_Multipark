import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ load: vi.fn(), channels: vi.fn() }));
vi.mock("./cityAccess", async original => ({ ...(await original<object>()), loadCityAccess: f.load }));
vi.mock("./db", async original => ({ ...(await original<object>()), getDb: async () => ({ execute: async () => [[], []] }) }));
vi.mock("./integrations/googleAds/adMetrics", () => ({ getAdMetrics: async () => ({ totals: { cost: 120 } }) }));
vi.mock("./marketingChannels", () => ({ getChannels: f.channels }));

import { appRouter } from "./routers";
const caller = (role = "backoffice") =>
  appRouter.createCaller({ user: { id: 7, role }, req: { headers: {} }, res: {} } as any);

beforeEach(() => {
  vi.clearAllMocks();
  f.load.mockResolvedValue({ all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false });
  f.channels.mockResolvedValue({ ok: true });
});

describe("marketing.channels — permissões", () => {
  it("frontoffice e extras não veem", async () => {
    await expect(caller("frontoffice").marketing.channels({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("extra").marketing.channels({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.channels).not.toHaveBeenCalled();
  });
  it("outra cidade é recusada antes de consultar", async () => {
    await expect(caller().marketing.channels({ projectId: 49 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.channels).not.toHaveBeenCalled();
  });
  it("passa o gasto do Google Ads do período", async () => {
    await caller().marketing.channels({ from: "2026-09-01", to: "2026-09-30" });
    expect(f.channels).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ from: "2026-09-01", to: "2026-09-30", adSpend: 120 }));
  });
});
