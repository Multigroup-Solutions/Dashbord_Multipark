/**
 * Jorge (7 out 2026, "põe de lado como o outro"): os alertas do Marketing ficam
 * de lado, pequenos, encolhíveis e cada um sai da lista (para quem o tira, até
 * ao fim do mês) — como os das Reservas (42d).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeMarketingAlerts, marketingAlertKey, splitHiddenAlerts } from "../shared/marketingAlerts";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("alertas do Marketing de lado e dispensáveis", () => {
  it("o alerta de orçamento tem uma chave que não muda com a percentagem", () => {
    const base = { dayOfMonth: 7, daysInMonth: 31, monthSpend: 0, prevMonthSpend: 0, windowCampaigns: [], unmappedCampaigns: 0 } as any;
    const day1 = computeMarketingAlerts({ ...base, budgets: [{ label: "Airpark Faro", amount: 4456, spentToDate: 1147, pacing: { elapsedDays: 6, expected: 863, ratio: 1.33, projected: 5926, status: "over" } }] });
    const day2 = computeMarketingAlerts({ ...base, budgets: [{ label: "Airpark Faro", amount: 4456, spentToDate: 1300, pacing: { elapsedDays: 7, expected: 1006, ratio: 1.29, projected: 5757, status: "over" } }] });
    const b1 = day1.find((a) => a.code === "budget_over")!, b2 = day2.find((a) => a.code === "budget_over")!;
    expect(b1.title).not.toBe(b2.title);
    expect(marketingAlertKey(b1)).toBe("budget_over:Airpark Faro");
    expect(marketingAlertKey(b2)).toBe(marketingAlertKey(b1));
    expect(marketingAlertKey({ code: "month_pace" })).toBe("month_pace");
  });

  it("tirados ficam escondidos só no mês em que foram tirados", () => {
    const alerts = [{ code: "budget_over", key: "budget_over:A" }, { code: "budget_under", key: "budget_under:B" }, { code: "month_pace" }];
    const r = splitHiddenAlerts(alerts, { "budget_over:A": "2026-10", month_pace: "2026-09" }, "2026-10");
    expect(r.shown.map(marketingAlertKey)).toEqual(["budget_under:B", "month_pace"]);
    expect(r.hidden.map(marketingAlertKey)).toEqual(["budget_over:A"]);
    // passar de "acima" para "abaixo" é outro alerta: volta a aparecer
    expect(splitHiddenAlerts([{ code: "budget_under", key: "budget_under:A" }], { "budget_over:A": "2026-10" }, "2026-10").shown).toHaveLength(1);
  });

  it("painel: alertas numa coluna de lado, encolhíveis, com X, Ver todos e Tirados → Repor", () => {
    const p = src("client/src/components/marketing/MarketingDashboardPanel.tsx");
    expect(p).toContain("lg:grid-cols-[minmax(0,1fr)_300px]");
    expect(p).toContain('<aside className="order-first min-w-0 lg:order-last lg:sticky lg:top-4">');
    expect(p).toContain('usePersistedState("alerts.marketing.collapsed", false)');
    expect(p).toContain('aria-label="Tirar da lista"');
    expect(p).toContain("Tirados (${hidden.length})");
    expect(p).toContain("Repor");
  });
});
