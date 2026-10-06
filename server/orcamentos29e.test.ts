/**
 * P3 lote 29e — Orçamentos do Google Ads pela regra (Jorge, 6 out 2026): "o
 * orçamento para o Google Ads será sempre 20 % da faturação do mês anterior da
 * mesma marca e cidade, sem ser o Marketplace. O Marketplace será só sobre os
 * 20 % que realmente ficam: reserva de 100 € → 20 € → investimos 4 €."
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUDGET_RULE_PCT, MARKETPLACE_BUDGET_RULE_PCT, buildRuleBudgets, previousMonth } from "../shared/marketingBudgetRule";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const nodes = [
  { id: 1, name: "Lisboa", level: "city", parentId: null },
  { id: 2, name: "Porto", level: "city", parentId: null },
  { id: 10, name: "Airpark", level: "brand", parentId: 1 },
  { id: 11, name: "Redpark", level: "brand", parentId: 1 },
  { id: 12, name: "Marketplace", level: "brand", parentId: 1 },
  { id: 20, name: "Airpark", level: "brand", parentId: 2 },
  { id: 22, name: "Marketplace", level: "brand", parentId: 2 },
];

describe("29e — a regra 20 %", () => {
  it("20 % da faturação sem IVA do mês anterior de cada marca/cidade", () => {
    expect(BUDGET_RULE_PCT).toBe(20);
    expect(MARKETPLACE_BUDGET_RULE_PCT).toBe(20);
    const rows = buildRuleBudgets({ nodes, revenueByBrandNode: new Map([[10, 10_000], [11, 2_500.5], [20, 0]]), marketplaceByCity: new Map() });
    expect(rows).toEqual([
      { projectId: 10, label: "Airpark Lisboa", kind: "brand", base: 10_000, pct: 20, amount: 2_000 },
      { projectId: 11, label: "Redpark Lisboa", kind: "brand", base: 2_500.5, pct: 20, amount: 500.1 },
    ]); // Airpark Porto sem faturação → sem orçamento
  });

  it("Marketplace: 20 % do que lhe ficou (100 € de reserva → 20 € → 4 €), no nó Marketplace da cidade", () => {
    const rows = buildRuleBudgets({ nodes, revenueByBrandNode: new Map([[12, 99_999]]), marketplaceByCity: new Map([["Lisboa", 20], ["Oporto", 50], ["Faro", 30]]) });
    // a faturação "da marca Marketplace" nunca conta como marca; Faro sem nó → nada
    expect(rows).toEqual([
      { projectId: 12, label: "Marketplace Lisboa", kind: "marketplace", base: 20, pct: 20, amount: 4 },
      { projectId: 22, label: "Marketplace Porto", kind: "marketplace", base: 50, pct: 20, amount: 10 },
    ]);
  });

  it("mês anterior", () => {
    expect(previousMonth("2026-10")).toBe("2026-09");
    expect(previousMonth("2027-01")).toBe("2026-12");
  });
});

describe("29e — onde entra", () => {
  it("a faturação é a das reservas concluídas, sem IVA, sem as do Marketplace; o Marketplace pelas comissões", () => {
    const s = src("server/marketingBudgetRule.ts");
    expect(s).toContain(`loadLiveBookingAgg("delivered"`);
    expect(s).toContain("if (r.campaign === MARKETPLACE_CAMPAIGN) continue;");
    expect(s).toContain("r.total / (1 + vat)");
    expect(s).toContain("billing.data.marketplace");
    expect(s).not.toMatch(/insert|update|delete/i); // nunca grava
  });

  it("os Orçamentos mostram a regra no Google Ads; um orçamento à mão para a mesma marca/cidade manda", () => {
    const b = src("server/marketingBudgets.ts");
    expect(b).toContain("if (manualGoogle.has(r.projectId)) continue;");
    expect(b).toContain(`source: "regra"`);
    expect(b).toContain(`provider: "google_ads", amount: r.amount`);
    const ui = src("client/src/components/marketing/MarketingBudgetsPanel.tsx");
    expect(ui).toContain("Regra 20 %");
    expect(ui).toContain("a regra 20 % dava");
    expect(ui).toContain(`{r.source === "manual" && <Button size="icon" variant="ghost" title="Arquivar"`); // a regra não se arquiva
  });
});
