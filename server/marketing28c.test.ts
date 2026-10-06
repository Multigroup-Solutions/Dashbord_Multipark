/**
 * P3 lote 28c — Marketing (Jorge, 6 out 2026): "nos anúncios: Google, Meta,
 * gasto total, conversões, custo por conversão e reservas"; nas reservas conta
 * "tudo o que vem via net — tudo o que não seja parceiros"; e as duas medidas
 * lado a lado (conversões das plataformas e reservas reais), também por parque.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildMarketingBookingsSql, mapMarketingBookingRow, type MarketingBookingRow } from "./multiparkDb/marketingBookings";
import { assertReadOnlySql } from "./multiparkDb/client";
import { toMarketingBooking } from "./marketingLive";

const live = vi.hoisted(() => ({ bookings: [] as any[], fail: false }));
vi.mock("./db", async (original) => ({ ...(await original<object>()), getDb: async () => ({ execute: async () => [[], []] }) }));
vi.mock("./marketingSql", async (original) => ({ ...(await original<object>()), marketingProjectIds: async () => null }));
vi.mock("./finance/rates", async (original) => ({ ...(await original<object>()), vatRateForPeriod: async () => 0.23 }));
vi.mock("./integrations/googleAds/oauth", () => ({ getConnection: async () => null }));
vi.mock("./marketingLive", async (original) => ({
  ...(await original<object>()),
  loadMarketingBookings: async () => { if (live.fail) throw new Error("Multipark em baixo"); return live.bookings; },
}));

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const ctx = { ourParks: new Map<string, number | null>([["pA", 10]]), aliases: new Map<string, string>() };
const row = (o: Partial<MarketingBookingRow>): MarketingBookingRow => ({ id: "b", createdAt: "2026-09-10 09:00:00", day: "2026-09-10", parkId: "pA", status: "BOOKED", origin: "API", originUrl: null, partnerId: null, partnerName: null, paymentMethod: null, paymentSource: null, campaignName: null, discountCode: null, total: 50, hasEmail: true, newClient: true, ...o });

describe("28c — reservas 'via net' = tudo o que não é parceiro", () => {
  it("o SQL lê a origem do pagamento (agregador), só leitura", () => {
    const { sql } = buildMarketingBookingsSql({ start: "2026-08-31 23:00:00", end: "2026-09-30 23:00:00", parkIds: ["pA"], internalDomains: ["multipark.pt"] });
    expect(sql).toContain(`NULLIF(b."paymentSource"::text, '') AS pay_src`);
    expect(sql).toContain("d.pay_src AS payment_source");
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(mapMarketingBookingRow({ id: "b1", payment_source: "PARKOS" }).paymentSource).toBe("PARKOS");
    expect(mapMarketingBookingRow({ id: "b1", payment_source: "" }).paymentSource).toBeNull();
  });

  it("site, telefone e Marketplace contam; parceiro (id, origem de parceiro ou agregador a cobrar) não", () => {
    const via = (o: Partial<MarketingBookingRow>) => toMarketingBooking(row(o), ctx as any)!.viaNet;
    expect(via({})).toBe(true);
    expect(via({ origin: "GENERAL_FORM" })).toBe(true);
    expect(via({ origin: "PHONE" })).toBe(true);
    expect(via({ origin: "MARKETPLACE" })).toBe(true);
    expect(via({ partnerId: "p1", partnerName: "Parkos" })).toBe(false);
    expect(via({ origin: "PARTNER_API" })).toBe(false);
    expect(via({ paymentSource: "PARKVIA" })).toBe(false);
    expect(via({ paymentSource: "stripe" })).toBe(true);
  });
});

describe("28c — números do Marketing: conversões das plataformas e reservas via net lado a lado", () => {
  const ads: any = {
    totals: { cost: 300, conversions: 30, impressions: 10000, clicks: 600, cpc: 0.5, ctr: 0.06 },
    byProvider: { google_ads: 200, meta: 100, other: 0 },
    byProviderTotals: { google_ads: { conversions: 22, conversionValue: 900, costPerConversion: 9.09, roasGoogle: 4.5 }, meta: { conversions: 8, conversionValue: 0, costPerConversion: 12.5, roasGoogle: null } },
    meta: { hasDataInPeriod: true }, coverage: { apiDays: 30, legacyDays: 0, status: "ok" }, budgetEstimate: 0, unmappedCampaigns: 0,
    byDay: [], byCampaign: [], nationalShares: [], currencyExcluded: [],
  };
  const b = (o: any) => ({ id: "x", day: "2026-09-10", origin: "API", total: 100, viaNet: true, hasOriginUrl: false, hasClickId: false, adAttribution: "unknown", adCampaignExternalId: null, ...o });

  it("Google e Meta à parte, custo por conversão das plataformas e por reserva via net", async () => {
    live.fail = false;
    live.bookings = [
      b({ hasOriginUrl: true, hasClickId: true, adAttribution: "google_paid" }),
      b({ hasOriginUrl: true }),
      b({ origin: "PHONE" }),
      b({ viaNet: false, total: 80 }), // parceiro: não conta nas via net
    ];
    const { getMarketingStats } = await import("./integrations/googleAds/marketingStats");
    const s: any = await getMarketingStats({ from: "2026-09-01", to: "2026-09-30" }, ads);
    expect(s).toMatchObject({ spendGoogle: 200, spendMeta: 100, spend: 300, conversionsGoogle: 22, conversionsMeta: 8, conversionsPlatforms: 30, costPerConversionPlatforms: 10 });
    expect(s).toMatchObject({ bookingsTotal: 4, bookingsWeb: 3, revenueWeb: 300, webWithLink: 2, bookingsAttributed: 1, costPerWebBooking: 100 });
  });

  it("Multipark em baixo: conversões e custo por conversão ficam; reservas via net a null (nunca 0)", async () => {
    live.fail = true;
    const { getMarketingStats } = await import("./integrations/googleAds/marketingStats");
    const s: any = await getMarketingStats({ from: "2026-09-01", to: "2026-09-30" }, ads);
    expect(s.costPerConversionPlatforms).toBe(10);
    expect(s).toMatchObject({ bookingsWeb: null, revenueWeb: null, webWithLink: null, costPerWebBooking: null });
    live.fail = false;
  });

  it("por marca e por marca/cidade: conversões por plataforma, valor, impressões, cliques e via net", () => {
    const stats = src("server/integrations/googleAds/marketingStats.ts");
    expect(stats).toContain(`if (c.provider === "meta") row.conversionsMeta += c.conversions;`);
    expect(stats).toContain("row.conversionValue += c.conversionValue; row.impressions += c.impressions; row.clicks += c.clicks;");
    expect(stats).toContain("if (b.viaNet) { r.web++; r.revWeb += b.total; if (b.hasOriginUrl) r.webLink++; }");
    expect(stats).toContain("c.bookingsWeb += r.web; c.revenueWeb += r.revWeb; c.webWithLink += r.webLink;");
  });
});

describe("28c — ecrãs", () => {
  it("Anúncios: por marca, Google · Meta · gasto · conversões · custo/conv. · reservas via net · ligadas", () => {
    const page = src("client/src/pages/MarketingGoogleAdsPage.tsx");
    for (const h of ["Conv. Google", "Conv. Meta", "Custo / conv.", "Valor conv.", "Reservas via net", "Valor via net", "Com link", "Ligadas", "Valor ligadas"]) expect(page, h).toContain(`>${h}</th>`);
    // por parque/cidade: impressões somadas e as reservas via net ao lado das conversões
    expect(page).toContain("g.impressions += Number(r.impressions ?? 0)");
    expect(page).toContain("num(g.stats.bookingsWeb ?? 0)");
    expect(page).toContain("linkPct(g.stats.bookingsWeb ?? 0, g.stats.webWithLink ?? 0)");
  });

  it("Dashboard e cartão do Financeiro: conversões (Google + Meta) e reservas via net separadas", () => {
    const dash = src("client/src/components/marketing/MarketingDashboardPanel.tsx");
    expect(dash).toContain(`label="Conversões (Google + Meta)"`);
    expect(dash).toContain(`label="Reservas via net"`);
    expect(dash).toContain("eur(st.costPerConversionPlatforms, 2)");
    expect(dash).not.toContain("adResultsMeasure");
    const card = src("client/src/components/marketing/MarketingSummaryCard.tsx");
    expect(card).toContain(`label="Conversões (Google + Meta)"`);
    expect(card).toContain("reservas via net:");
    expect(src("docs/ajuda/marketing.md")).toContain("**Reservas via net**");
  });
});
