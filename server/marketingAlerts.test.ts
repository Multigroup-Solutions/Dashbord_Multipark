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
    expect(r[0].detail).toMatch(/Sugestão: pausar/);
    expect(r[0].items).toEqual([expect.stringContaining("Airpark - Faro (Airpark)")]);
  });

  it("atribuição partida: alerta próprio e as reservas atribuídas não servem de prova", () => {
    const r = codes({
      attribution: { siteBookings: 100, withOriginUrl: 90, withClickId: 0, attributed: 0 },
      windowCampaigns: [{ name: "X", accountName: null, cost: 100, conversions: 0, attributedBookings: 0 }],
    });
    expect(r).toEqual(["attribution_broken", "campaign_no_results"]);
  });

  it("ritmo: projeção ≥ 120% do mês passado, sem contar hoje; nos primeiros dias não alerta", () => {
    expect(codes({ monthSpend: 1300, prevMonthSpend: 2000 })).toEqual(["month_pace"]);   // até ontem: 1300/14×30 = 2786 = 139%
    expect(codes({ monthSpend: 1100, prevMonthSpend: 2000 })).toEqual([]);                // 1100/14×30 = 2357 = 118%
    // 1150 até ontem: 1150/14×30 = 2464 ≥ 2400 → alerta (contando hoje como dia inteiro dava 2300 e escondia-o)
    expect(codes({ monthSpend: 1150, prevMonthSpend: 2000, dayOfMonth: 15 })).toEqual(["month_pace"]);

    expect(codes({ monthSpend: 1300, prevMonthSpend: 2000, dayOfMonth: 3 })).toEqual([]);
    expect(codes({ monthSpend: 1300, prevMonthSpend: 0 })).toEqual([]);
  });

  it("campanhas por associar e recolha parada; críticos primeiro", () => {
    const r = computeMarketingAlerts({ ...base, unmappedCampaigns: 4, coverage: { status: "stale" },
      windowCampaigns: [{ name: "Y", accountName: null, cost: 90, conversions: 0, attributedBookings: 0 }] });
    expect(r.map((a) => a.code)).toEqual(["campaign_no_results", "sync_stale", "campaigns_unmapped"]);
  });

  it("recolha falhada / a pedir reautorização / parada → crítico com 'Religar'; sem duplicar o aviso de cobertura", () => {
    const r = computeMarketingAlerts({ ...base, coverage: { status: "stale" }, syncHealth: [
      { provider: "google_ads", connection: "reauth_required", lastRunStatus: "failed", stale: true, lastSuccessAt: null },
      { provider: "meta", connection: "connected", lastRunStatus: "partial", lastRunError: "1 de 2 conta(s) Meta falharam", stale: false, lastSuccessAt: "2026-09-20 05:00:00" },
    ] });
    expect(r.map((a) => a.code)).toEqual(["ads_sync_google_ads", "ads_sync_meta"]);
    expect(r[0]).toMatchObject({ level: "critical", title: "Google Ads precisa de ser religado", linkLabel: "Religar Google Ads", link: "/integracoes/google-ads" });
    expect(r[1].title).toBe("Recolha do Meta Ads com contas falhadas");
    // tudo bem → nada
    expect(codes({ syncHealth: [{ provider: "google_ads", connection: "connected", lastRunStatus: "done", stale: false, lastSuccessAt: "2026-09-24 05:00:00" }] })).toEqual([]);
    expect(codes({ syncHealth: [{ provider: "google_ads", connection: "connected", lastRunStatus: "done", stale: true, lastSuccessAt: "2026-09-20 05:00:00" }] })).toEqual(["ads_sync_google_ads"]);
  });

  it("orçamentos: acima de 110% e abaixo de 80% do esperado", () => {
    const r = computeMarketingAlerts({ ...base, budgets: [
      { label: "Airpark Lisboa", amount: 3000, spentToDate: 1800, pacing: { elapsedDays: 14, expected: 1400, ratio: 1800 / 1400, projected: 3857, status: "over" } },
      { label: "Redpark Porto", amount: 3000, spentToDate: 1400, pacing: { elapsedDays: 14, expected: 1400, ratio: 1, projected: 3000, status: "ok" } },
      { label: "Skypark Faro", amount: 3000, spentToDate: 700, pacing: { elapsedDays: 14, expected: 1400, ratio: 0.5, projected: 1500, status: "under" } },
    ] });
    expect(r.map((a) => a.code)).toEqual(["budget_over", "budget_under"]);
    expect(r[0].title).toMatch(/Airpark Lisboa: gasto acima do orçamento \(129% do esperado\)/);
  });
});
