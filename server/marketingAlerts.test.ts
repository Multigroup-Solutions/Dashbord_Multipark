import { describe, expect, it } from "vitest";
import { computeMarketingAlerts, type AlertsInput } from "../shared/marketingAlerts";

const base: AlertsInput = {
  windowCampaigns: [],
  attribution: { siteBookings: 100, withOriginUrl: 90, withClickId: 20, attributed: 20 },
  windowSpend: 1000, monthSpend: 1000, prevMonthSpend: 2000,
  dayOfMonth: 15, daysInMonth: 30, unmappedCampaigns: 0, coverage: { status: "ok" },
};
const codes = (i: Partial<AlertsInput>) => computeMarketingAlerts({ ...base, ...i }).map((a) => a.code);

describe("alertas do marketing", () => {
  it("tudo normal → sem alertas", () => expect(codes({})).toEqual([]));

  it("campanha a gastar sem conversões nem reservas; abaixo de 50 € ou com resultados não conta", () => {
    const r = computeMarketingAlerts({ ...base, windowCampaigns: [
      { name: "Airpark - Faro", accountName: "Airpark", cost: 180, conversions: 0, attributedBookings: 0 },
      { name: "Pequena", accountName: null, cost: 30, conversions: 0, attributedBookings: 0 },
      { name: "Boa", accountName: null, cost: 400, conversions: 3, attributedBookings: 0 },
      { name: "Com reservas", accountName: null, cost: 400, conversions: 0, attributedBookings: 2 },
    ] });
    expect(r.map((a) => a.title)).toEqual(["Campanha a gastar sem resultados: Airpark - Faro"]);
    expect(r[0].level).toBe("critical");
  });

  it("atribuição partida: alerta próprio e as reservas atribuídas não servem de prova", () => {
    const r = codes({
      attribution: { siteBookings: 100, withOriginUrl: 90, withClickId: 0, attributed: 0 },
      windowCampaigns: [{ name: "X", accountName: null, cost: 100, conversions: 0, attributedBookings: 0 }],
    });
    expect(r).toEqual(["attribution_broken", "campaign_no_results"]);
  });

  it("ritmo: projeção ≥ 120% do mês passado; nos primeiros dias não alerta", () => {
    expect(codes({ monthSpend: 1300, prevMonthSpend: 2000 })).toEqual(["month_pace"]);   // 1300/15×30 = 2600 = 130%
    expect(codes({ monthSpend: 1100, prevMonthSpend: 2000 })).toEqual([]);                // 110%
    expect(codes({ monthSpend: 1300, prevMonthSpend: 2000, dayOfMonth: 3 })).toEqual([]);
    expect(codes({ monthSpend: 1300, prevMonthSpend: 0 })).toEqual([]);
  });

  it("campanhas por associar e recolha parada; críticos primeiro", () => {
    const r = computeMarketingAlerts({ ...base, unmappedCampaigns: 4, coverage: { status: "stale" },
      windowCampaigns: [{ name: "Y", accountName: null, cost: 90, conversions: 0, attributedBookings: 0 }] });
    expect(r.map((a) => a.code)).toEqual(["campaign_no_results", "sync_stale", "campaigns_unmapped"]);
  });
});
