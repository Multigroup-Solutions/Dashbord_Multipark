/**
 * Plano 64, PR F (F6) — Anúncios → Por marca: a linha "Sem marca" entra no Total e o Total bate com o
 * Painel (as mesmas reservas, `loadMarketingBookings(..., { marketplace: true })`), sem contar nenhuma
 * reserva duas vezes. O gasto não muda. A BD é uma imitação.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";

const live = vi.hoisted(() => ({ bookings: [] as any[], projects: [] as any[] }));

/** `db.select().from(t)[.where().orderBy()]` que devolve as linhas da tabela imitada. */
const chain = (rows: any[]) => {
  const p: any = Promise.resolve(rows);
  p.where = () => p;
  p.orderBy = () => p;
  return p;
};
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({
    execute: async () => [[], []],
    select: () => ({ from: (t: any) => chain(getTableName(t) === "projects" ? live.projects : []) }),
  }),
}));
vi.mock("./marketingSql", async (original) => ({ ...(await original<object>()), marketingProjectIds: async () => null }));
vi.mock("./finance/rates", async (original) => ({ ...(await original<object>()), vatRateForPeriod: async () => 0.23 }));
vi.mock("./integrations/googleAds/oauth", () => ({ getConnection: async () => null }));
vi.mock("./marketingLive", async (original) => ({
  ...(await original<object>()),
  loadMarketingBookings: async () => live.bookings,
  loadUnplacedMarketplaceParks: async () => [],
}));

import { getMarketingStats, getSpendAndBookingsByBrand } from "./integrations/googleAds/marketingStats";

// Lisboa (1) → Airpark (10) → parque 100
const projects = [
  { id: 1, name: "Lisboa", level: "city", parentId: null },
  { id: 10, name: "Airpark", level: "brand", parentId: 1 },
  { id: 100, name: "Airpark Lisboa P1", level: "project", parentId: 10 },
];
const ads: any = {
  totals: { cost: 300, conversions: 4, impressions: 1000, clicks: 100, cpc: 3, ctr: 0.1 },
  byProvider: { google_ads: 300, meta: 0, other: 0 },
  byProviderTotals: { google_ads: { conversions: 4, conversionValue: 0, costPerConversion: 75, roasGoogle: null }, meta: { conversions: 0, conversionValue: 0, costPerConversion: null, roasGoogle: null } },
  meta: { hasDataInPeriod: false }, coverage: { apiDays: 30, legacyDays: 0, status: "ok" }, budgetEstimate: 0, unmappedCampaigns: 0, byDay: [], byDayProject: [], currencyExcluded: [],
  byCampaign: [
    { key: "api:1:111", source: "api", provider: "google_ads", externalId: "111", campaignId: 1, accountId: null, name: "Airpark - Lisboa - PT", status: "ENABLED", projectId: 10, cost: 300, clicks: 100, conversions: 4, conversionValue: 0, impressions: 1000 },
  ],
  nationalShares: [],
};
const bk = (o: any) => ({ id: "x", day: "2026-10-01", projectId: 100, parkId: "own", parkOurs: true, origin: "API", total: 100, value: 100, viaNet: true, viaNetOut: null, hasOriginUrl: false, hasClickId: false, adAttribution: "unknown", adCampaignExternalId: null, utmCampaign: null, campaign: null, campaignName: null, marketplace: false, operated: true, ...o });

describe("F6 — Anúncios por marca: 'Sem marca' no Total, que bate com o Painel", () => {
  beforeEach(() => {
    live.projects = projects;
    live.bookings = [
      bk({ id: "1", hasOriginUrl: true, adAttribution: "google_paid" }),
      bk({ id: "2" }),
      // parque sem marca na árvore (projeto desconhecido) e reserva sem projeto → "Sem marca"
      bk({ id: "3", projectId: 999, total: 40, value: 40, hasOriginUrl: true }),
      bk({ id: "4", projectId: null, total: 60, value: 60, adAttribution: "meta_paid" }),
      // não é via net (parceiro): entra nas reservas, não no via net
      bk({ id: "5", projectId: 999, viaNet: false, total: 70, value: 70 }),
      // Marketplace sem cidade → marca Marketplace (não "Sem marca")
      bk({ id: "6", projectId: null, marketplace: true, parkOurs: false, total: 50, value: 10 }),
    ];
  });

  it("a linha 'Sem marca' tem só as reservas sem marca; o Marketplace sem cidade fica na marca dele", async () => {
    const r: any = await getSpendAndBookingsByBrand({ from: "2026-10-01", to: "2026-10-31" }, ads);
    expect(r.bookingsWithoutBrand).toBe(3);
    expect(r.withoutBrand).toEqual({ bookings: 3, attributed: 1, revenue: 170, revenueAttributed: 60, bookingsWeb: 2, revenueWeb: 100, webWithLink: 1 });
    expect(r.brands.find((b: any) => b.brand === "Marketplace")).toMatchObject({ bookings: 1 });
  });

  it("Total (marcas + 'Sem marca') = Painel, sem dupla contagem; o gasto não muda", async () => {
    const r: any = await getSpendAndBookingsByBrand({ from: "2026-10-01", to: "2026-10-31" }, ads);
    const s: any = await getMarketingStats({ from: "2026-10-01", to: "2026-10-31" }, ads);
    // a mesma soma do cliente (MarketingGoogleAdsPage → BrandSummary)
    const sum = (k: string) => r.brands.reduce((t: number, b: any) => t + Number(b[k] ?? 0), 0) + Number(r.withoutBrand?.[k] ?? 0);
    expect(sum("bookings")).toBe(s.bookingsTotal);
    expect(sum("bookings")).toBe(live.bookings.length);
    expect(sum("bookingsWeb")).toBe(s.bookingsWeb);
    expect(sum("revenueWeb")).toBe(s.revenueWeb);
    expect(sum("webWithLink")).toBe(s.webWithLink);
    expect(sum("attributed")).toBe(s.bookingsAttributed);
    expect(sum("revenueAttributed")).toBe(s.revenueAttributed);
    // gasto: o mesmo (a linha 'Sem marca' não tem gasto)
    expect(sum("spend")).toBe(300);
    expect(s.spend).toBe(300);
  });

  it("BD da Multipark em baixo: 'Sem marca' a null (o ecrã mostra '—', nunca 0)", async () => {
    const mod = await import("./marketingLive");
    const spy = vi.spyOn(mod, "loadMarketingBookings").mockRejectedValueOnce(new Error("timeout"));
    const r: any = await getSpendAndBookingsByBrand({ from: "2026-10-01", to: "2026-10-31" }, ads);
    expect(r.bookingsError).toMatch(/timeout/);
    expect(r.withoutBrand).toBeNull();
    spy.mockRestore();
  });
});
