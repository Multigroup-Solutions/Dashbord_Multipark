/**
 * P3 lote 29f — Marketing nas contas (Jorge, 6 out 2026): "no caso das
 * despesas de marketing, o que deve lá ficar é o gasto aqui nos anúncios, por
 * projeto; quando entra a fatura — que representa sempre 60 ou 90 dias para
 * trás, mas está lá a data de consumo — trocamos os valores que estão no
 * Google Ads pelo valor da fatura. Até lá, vai lá estar o valor do marketing."
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { adCostCategory, adPlatformOf, allocateAdCosts, validConsumptionPeriod } from "../shared/adInvoices";

const metrics = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock("./integrations/googleAds/adMetrics", () => ({
  getAdMetrics: vi.fn(async (f: any) => {
    metrics.calls.push(f);
    // período da fatura (todos os projetos): a Google gastou 1000 € em julho–agosto
    if (f.projectIds === null && f.from === "2026-07-01") return { byProvider: { google_ads: 1000, meta: 0 } };
    return {
      byDayProjectProvider: [
        { date: "2026-08-30", projectId: 10, provider: "google_ads", cost: 100 },
        { date: "2026-08-31", projectId: 11, provider: "google_ads", cost: 50 },
        { date: "2026-09-01", projectId: 10, provider: "google_ads", cost: 40 },
        { date: "2026-08-31", projectId: 10, provider: "meta", cost: 30 },
      ],
    };
  }),
}));

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("29f — fatura do Google/Meta", () => {
  it("plataforma pelo NIF ou pelo fornecedor", () => {
    expect(adPlatformOf("Google Ireland Limited", null)).toBe("google_ads");
    expect(adPlatformOf("Qualquer", "IE6388047V")).toBe("google_ads");
    expect(adPlatformOf("Meta Platforms Ireland", null)).toBe("meta");
    expect(adPlatformOf("x", "9692928F")).toBe("meta");
    expect(adPlatformOf("Facebook", null)).toBe("meta");
    expect(adPlatformOf("Agência Criativa", "509999999")).toBeNull();
  });

  it("período de consumo: os dois dias, de ≤ até, até 1 ano", () => {
    expect(validConsumptionPeriod("2026-07-01", "2026-08-31")).toBe(true);
    expect(validConsumptionPeriod("2026-08-31", "2026-07-01")).toBe(false);
    expect(validConsumptionPeriod("2026-07-01", null)).toBe(false);
    expect(validConsumptionPeriod("2025-01-01", "2026-06-01")).toBe(false);
  });
});

describe("29f — o gasto dos anúncios até chegar a fatura; no período dela, a fatura", () => {
  const spend = [
    { date: "2026-08-30", projectId: 10, provider: "google_ads", cost: 100 },
    { date: "2026-08-31", projectId: 11, provider: "google_ads", cost: 50 },
    { date: "2026-09-01", projectId: 10, provider: "google_ads", cost: 40 },
    { date: "2026-08-31", projectId: 10, provider: "meta", cost: 30 },
    { date: "2026-08-31", projectId: 10, provider: "other", cost: 9 },
  ];
  const inv = { id: 7, provider: "google_ads" as const, periodFrom: "2026-07-01", periodTo: "2026-08-31", amount: 1100, projectId: 1 };

  it("sem fatura: o gasto das plataformas (o legado 'other' não entra)", () => {
    const r = allocateAdCosts({ from: "2026-08-30", to: "2026-09-01", spend, invoices: [], periodSpend: new Map() });
    expect(r.map((x) => [x.date, x.projectId, x.provider, x.cost, x.source])).toEqual([
      ["2026-08-30", 10, "google_ads", 100, "plataforma"], ["2026-08-31", 11, "google_ads", 50, "plataforma"],
      ["2026-09-01", 10, "google_ads", 40, "plataforma"], ["2026-08-31", 10, "meta", 30, "plataforma"],
    ]);
  });

  it("com fatura do Google (julho–agosto): nesses dias o Google vale a fatura, na proporção do gasto; a Meta e setembro ficam", () => {
    // gasto do Google em jul–ago (todos os projetos) = 1000 € → fator 1,1
    const r = allocateAdCosts({ from: "2026-08-30", to: "2026-09-01", spend, invoices: [inv], periodSpend: new Map([[7, 1000]]) });
    const g = r.filter((x) => x.provider === "google_ads");
    expect(g.map((x) => [x.date, x.projectId, Math.round(x.cost * 100) / 100, x.source])).toEqual([
      ["2026-08-30", 10, 110, "fatura"], ["2026-08-31", 11, 55, "fatura"], ["2026-09-01", 10, 40, "plataforma"],
    ]);
    expect(r.find((x) => x.provider === "meta")).toMatchObject({ cost: 30, source: "plataforma" });
  });

  it("fatura sem gasto no período: reparte-se pelos dias no projeto da despesa (só no âmbito)", () => {
    const v = { ...inv, periodFrom: "2026-09-01", periodTo: "2026-09-10", amount: 100, projectId: 99 };
    const r = allocateAdCosts({ from: "2026-09-01", to: "2026-09-05", spend: [], invoices: [v], periodSpend: new Map([[7, 0]]) });
    expect(r).toHaveLength(5);
    expect(r.every((x) => x.projectId === 99 && x.cost === 10 && x.source === "fatura")).toBe(true);
    expect(allocateAdCosts({ from: "2026-09-01", to: "2026-09-05", spend: [], invoices: [v], periodSpend: new Map(), inScope: () => false })).toEqual([]);
  });

  it("nome nas despesas da Faturação", () => {
    expect(adCostCategory({ provider: "google_ads", source: "fatura" })).toBe("Anúncios Google Ads — fatura");
    expect(adCostCategory({ provider: "meta", source: "plataforma" })).toBe("Anúncios Meta — gasto da plataforma (à espera da fatura)");
  });
});

describe("29f — leitura (faturas + gasto) e o motor", () => {
  it("loadAdCosts: fatura com período substitui; sem período fica no aviso; base = gasto total do período", async () => {
    const { loadAdCosts } = await import("./finance/adCosts");
    const rows = [
      { id: 7, supplier: "Google Ireland Limited", supplierNif: "IE6388047V", amount: "1100.00", projectId: 1, consumptionFrom: "2026-07-01", consumptionTo: "2026-08-31", day: "2026-09-03" },
      { id: 8, supplier: "Meta Platforms Ireland", supplierNif: null, amount: "250.00", projectId: 1, consumptionFrom: null, consumptionTo: null, day: "2026-09-01" },
    ];
    const db = { select: () => ({ from: () => ({ where: async () => rows }) }) };
    const r = await loadAdCosts(db, { from: "2026-08-30", to: "2026-09-01", projectIds: null });
    expect(metrics.calls.some((c) => c.from === "2026-07-01" && c.to === "2026-08-31" && c.projectIds === null)).toBe(true);
    expect(Math.round(r.totals.invoice * 100) / 100).toBe(165); // (100 + 50) × 1,1
    expect(r.totals.platform).toBe(70); // Google em setembro 40 + Meta 30
    expect(r.invoicesWithoutPeriod).toEqual([{ id: 8, supplier: "Meta Platforms Ireland", amount: 250, day: "2026-09-01" }]);
  });

  it("o motor: faturas do Google/Meta fora das despesas normais; anúncios entram como despesa por projeto", async () => {
    const { adInvoiceSql } = await import("./finance/adCosts");
    const q = new MySqlDialect().sqlToQuery(adInvoiceSql());
    expect(q.sql).toContain("REGEXP");
    expect(q.params).toEqual(expect.arrayContaining(["IE6388047V", "6388047V", "IE9692928F"]));
    const e = src("server/finance/engine.ts");
    expect(e).toContain("expConds.push(notAdInvoiceSql());");
    expect(e).toContain("const ad = await loadAdCosts(db, { from, to, projectIds: projectIds ?? null });");
    expect(e).toContain("categoryName: adCostCategory(r),");
  });

  it("despesa: período de consumo validado; formulário só para faturas do Google/Meta; migração só acrescenta", () => {
    const r = src("server/expensesRouter.ts");
    expect(r).toContain("...consumptionPeriodOrBadRequest(input.consumptionFrom, input.consumptionTo),");
    expect(src("client/src/pages/ExpensesPage.tsx")).toContain("{isAdPlatformInvoice(form.supplier, form.supplierNif) && (");
    expect(src("server/migrations/migration_0475.ts")).not.toMatch(/DROP|DELETE/);
    expect(src("client/src/pages/InvoicesPage.tsx")).toContain("sem período de consumo");
  });
});
