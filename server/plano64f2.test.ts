/**
 * Plano 64, F2 — Marketing → Web & SEO pela fonte do Painel do Marketing:
 *  1. reservas do site: a MESMA leitura do Painel (loadMarketingBookings com
 *     `{ marketplace: true }` e o âmbito de cidade) e a mesma regra de "feita
 *     no site" (isSiteBooking); a marca Multipark inclui o Marketplace;
 *  2. o KPI do GA4 é "Eventos-chave GA4" (não são reservas) e há a lista dos
 *     eventos que o GA4 conta como tal (parte "allEvents" da recolha, só leitura);
 *  3. o funil diz que passos não chegam ao GA4;
 *  4. páginas de entrada: o nome da propriedade só com mais de uma propriedade;
 *  5. o dia de hoje vem marcado como parcial (e sem GA4 → null, não 0).
 * Com leitores FALSOS (nada de BD de produção nem APIs).
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  load: vi.fn(),
  scope: vi.fn(async (): Promise<number[] | null> => null),
  projects: [] as any[],
  ads: null as any,
  cfg: null as any,
  gaDaily: vi.fn(),
  dimCompare: vi.fn(),
}));
vi.mock("./marketingLive", async (original) => ({ ...(await original<object>()), loadMarketingBookings: h.load }));
vi.mock("./marketingSql", async (original) => ({ ...(await original<object>()), marketingProjectIds: h.scope }));
vi.mock("./db", async (original) => ({ ...(await original<object>()), getDb: async () => ({ execute: async () => [h.projects, []] }) }));
vi.mock("./finance/rates", async (original) => ({ ...(await original<object>()), vatRateForPeriod: async () => 0.23 }));
vi.mock("./integrations/googleAds/oauth", () => ({ getConnection: async () => null }));
vi.mock("./integrations/googleAds/adMetrics", async (original) => ({ ...(await original<object>()), getAdMetrics: async () => h.ads }));
vi.mock("./appSettings", async (original) => ({ ...(await original<object>()), getSetting: async (key: string) => (key === "marketing.webAnalytics" ? h.cfg : null) }));
vi.mock("./webAnalytics/queries", async (original) => ({ ...(await original<object>()), gaDaily: h.gaDaily, scDaily: async () => [], dimCompare: h.dimCompare }));
vi.mock("./webAnalytics/store", async (original) => {
  const o: any = await original();
  return { ...o, dbWebStore: { ...o.dbWebStore, getState: async () => null } };
});

import { bookingsByDay, adSpendByDay, webBrandOfBooking } from "./webAnalytics/queries";
import { gaDimRowsToStore } from "./webAnalytics/store";
import { webOverview } from "./webAnalytics/service";
import { getMarketingStats } from "./integrations/googleAds/marketingStats";
import { SITE_BOOKING_ORIGINS, isSiteBooking } from "../shared/bookingOrigin";
import {
  GA_DIMS, GA_PARTS, funnelMissing, gaDimRequest, isGa4AutoEvent, webAnalyticsConfigSchema, webBrandOfTreeBrand, webFactsText, webInsightFallback,
} from "../shared/webAnalytics";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Árvore: Lisboa (1) → Airpark (10) → parque 100; Lisboa → Marketplace (30) → parque de terceiros 300.
const PROJECTS = [
  { id: 1, name: "Lisboa", level: "city", parentId: null },
  { id: 10, name: "Airpark", level: "brand", parentId: 1 },
  { id: 30, name: "Marketplace", level: "brand", parentId: 1 },
  { id: 100, name: "Airpark Lisboa", level: "project", parentId: 10 },
  { id: 300, name: "Parque de terceiros Lisboa", level: "project", parentId: 30 },
];

const bk = (o: any) => ({
  id: "x", createdAt: "2026-10-13 09:00:00", day: "2026-10-13", projectId: 100, parkId: "pA", status: "BOOKED", origin: "API",
  hasPartner: false, viaNet: true, hasOriginUrl: false, hasClickId: false, adAttribution: "unknown", adCampaignExternalId: null,
  utmCampaign: null, campaign: null, campaignName: null, total: 50, hasEmail: true, newClient: true, marketplace: false, operated: true, ...o,
});
/** As reservas do período: nossas e do Marketplace, do site e não. */
const BOOKINGS = [
  bk({ id: "own-site", origin: "API", total: 50 }),                                                         // Airpark, site
  bk({ id: "own-phone", origin: "MANUAL", total: 40 }),                                                     // Airpark, telefone
  bk({ id: "mkt-third-site", day: "2026-10-14", projectId: 300, parkId: "t1", origin: "API", total: 100, value: 20, marketplace: true, parkOurs: false }),
  bk({ id: "mkt-own-origin", day: "2026-10-14", projectId: 30, origin: "MARKETPLACE", total: 60, marketplace: true }),   // nossa, veio pelo multipark.pt
  bk({ id: "mkt-unplaced-form", day: "2026-10-15", projectId: null, parkId: "t9", origin: "GENERAL_FORM", total: 80, value: 16, marketplace: true, parkOurs: false }),
];
const ADS: any = {
  totals: { cost: 30, conversions: 3, impressions: 1000, clicks: 60, cpc: 0.5, ctr: 0.06 },
  byProvider: { google_ads: 30, meta: 0, other: 0 },
  byProviderTotals: { google_ads: { conversions: 3, conversionValue: 0, costPerConversion: 10, roasGoogle: null }, meta: { conversions: 0, conversionValue: 0, costPerConversion: null, roasGoogle: null } },
  meta: { hasDataInPeriod: false }, coverage: { apiDays: 3, legacyDays: 0, status: "ok" }, budgetEstimate: 0, unmappedCampaigns: 0,
  byDay: [{ date: "2026-10-13", cost: 15, conversions: 1 }, { date: "2026-10-14", cost: 15, conversions: 2 }],
  byDayProject: [{ date: "2026-10-13", projectId: 30, cost: 10 }, { date: "2026-10-13", projectId: 100, cost: 5 }, { date: "2026-10-14", projectId: 30, cost: 15 }],
  byCampaign: [], nationalShares: [], currencyExcluded: [],
};
const FROM = "2026-10-13", TO = "2026-10-15";

beforeEach(() => {
  vi.clearAllMocks();
  h.projects = PROJECTS;
  h.ads = ADS;
  h.scope.mockResolvedValue(null);
  h.load.mockResolvedValue(BOOKINGS);
});

// ─── 1. reservas do site ────────────────────────────────────────────────────

describe("F2.1 — Web & SEO: as reservas do Painel do Marketing (com o Marketplace)", () => {
  it("bookingsByDay pede as reservas com { marketplace: true } e o âmbito de cidade do utilizador (marketingProjectIds)", async () => {
    await bookingsByDay(FROM, TO, null);
    expect(h.scope).toHaveBeenCalledWith(undefined);
    expect(h.load).toHaveBeenCalledWith(FROM, TO, null, { marketplace: true });
    h.scope.mockResolvedValueOnce([1, 10, 100]);
    await bookingsByDay(FROM, TO, null);
    expect(h.load).toHaveBeenLastCalledWith(FROM, TO, [1, 10, 100], { marketplace: true });
  });

  it("uma reserva do Marketplace feita no site entra (todas as marcas e na marca Multipark)", async () => {
    const all = await bookingsByDay(FROM, TO, null);
    expect(all.get("2026-10-14")).toMatchObject({ bookings: 2, siteBookings: 1 });
    expect(all.get("2026-10-15")).toMatchObject({ bookings: 1, siteBookings: 1 }); // Marketplace sem cidade, formulário
    const mp = await bookingsByDay(FROM, TO, "multipark");
    const sum = (m: Map<string, { siteBookings: number; bookings: number }>, k: "siteBookings" | "bookings") => [...m.values()].reduce((t, x) => t + x[k], 0);
    expect(sum(mp, "bookings")).toBe(3);      // as três do Marketplace
    expect(sum(mp, "siteBookings")).toBe(2);  // terceiros por API + sem cidade por formulário (a origem MARKETPLACE não é "site", como no Painel)
    const air = await bookingsByDay(FROM, TO, "airpark");
    expect(sum(air, "bookings")).toBe(2);
    expect(sum(air, "siteBookings")).toBe(1);
  });

  it("o valor é o do Marketing: parques de terceiros pela nossa comissão", async () => {
    const all = await bookingsByDay(FROM, TO, null);
    expect(all.get("2026-10-14")).toMatchObject({ siteRevenue: 20, revenue: 80 }); // 20 (comissão) + 60 (nossa, preço)
    expect(all.get("2026-10-13")).toMatchObject({ siteRevenue: 50, revenue: 90 });
  });

  it("Web & SEO e Painel do Marketing contam as MESMAS reservas do site para os mesmos dados (a mesma leitura e a mesma regra)", async () => {
    const web = await bookingsByDay(FROM, TO, null);
    const s: any = await getMarketingStats({ from: FROM, to: TO }, ADS);
    const webSite = [...web.values()].reduce((t, x) => t + x.siteBookings, 0);
    const webAll = [...web.values()].reduce((t, x) => t + x.bookings, 0);
    expect(s.attributionQuality.siteBookings).toBe(3);
    expect(webSite).toBe(s.attributionQuality.siteBookings);
    expect(webAll).toBe(s.bookingsTotal);
    // a mesma chamada nos dois ecrãs
    expect(h.load.mock.calls[0]).toEqual(h.load.mock.calls[1]);
    expect(h.load.mock.calls[1]).toEqual([FROM, TO, null, { marketplace: true }]);
  });

  it("regra única de 'feita no site' (shared/bookingOrigin.ts), usada pelos dois", () => {
    expect([...SITE_BOOKING_ORIGINS]).toEqual(["API", "GENERAL_FORM"]);
    expect(isSiteBooking("API")).toBe(true);
    expect(isSiteBooking("GENERAL_FORM")).toBe(true);
    expect(isSiteBooking("MARKETPLACE")).toBe(false);
    expect(isSiteBooking("MANUAL")).toBe(false);
    expect(isSiteBooking(null)).toBe(false);
    expect(src("server/integrations/googleAds/marketingStats.ts")).toContain("if (isSiteBooking(b.origin)) {");
    expect(src("server/webAnalytics/queries.ts")).toContain("if (isSiteBooking(b.origin)) {");
    expect(src("server/integrations/googleAds/marketingStats.ts")).not.toContain("SITE_ORIGINS = [");
    expect(src("server/webAnalytics/queries.ts")).not.toContain("SITE_BOOKING_ORIGINS = [");
  });

  it("marca: o nó Marketplace é a Multipark; sem centro, as do Marketplace também", () => {
    expect(webBrandOfTreeBrand("Marketplace")).toBe("multipark");
    expect(webBrandOfTreeBrand(" marketplace ")).toBe("multipark");
    expect(webBrandOfTreeBrand("Multipark")).toBe("multipark");
    expect(webBrandOfTreeBrand("Airpark")).toBe("airpark");
    expect(webBrandOfTreeBrand("Lisboa")).toBeNull();
    expect(webBrandOfTreeBrand(null)).toBeNull();
    const byProject = (id: number | null) => (id === 100 ? "airpark" as const : null);
    expect(webBrandOfBooking({ projectId: null, marketplace: true }, byProject)).toBe("multipark");
    expect(webBrandOfBooking({ projectId: null, marketplace: false }, byProject)).toBeNull();
    expect(webBrandOfBooking({ projectId: 100, marketplace: false }, byProject)).toBe("airpark");
  });

  it("gasto por marca: o da marca Multipark é o dos nós Marketplace", async () => {
    const mp = await adSpendByDay(FROM, TO, "multipark");
    expect(Object.fromEntries(mp.byDay)).toEqual({ "2026-10-13": 10, "2026-10-14": 15 });
    const air = await adSpendByDay(FROM, TO, "airpark");
    expect(Object.fromEntries(air.byDay)).toEqual({ "2026-10-13": 5 });
  });
});

// ─── Vista geral (2, 3, 5) ──────────────────────────────────────────────────

describe("F2 — vista geral do Web & SEO", () => {
  const gaRow = (day: string, sessions: number) => ({ day, sessions, totalUsers: sessions, newUsers: 0, engagedSessions: 0, keyEvents: sessions * 17, revenue: 0 });
  const dimRow = (value: string, cur: Record<string, number>, prev: Record<string, number> = {}) => ({ key: `:${value}`, value, sourceId: null, cur, prev, position: null, prevPosition: null });

  beforeEach(() => {
    h.cfg = webAnalyticsConfigSchema.parse({ enabled: true, ga4Properties: [{ propertyId: "1111", label: "Marketplace", brand: "multipark" }] });
    // GA4 recolhido até ontem (14/10): hoje não tem linha.
    h.gaDaily.mockImplementation(async (_ids: string[], from: string) => (from === FROM ? [gaRow("2026-10-13", 100), gaRow("2026-10-14", 200)] : [gaRow("2026-10-10", 90), gaRow("2026-10-11", 90), gaRow("2026-10-12", 90)]));
    h.dimCompare.mockImplementation(async (i: any) => {
      if (i.dim === "event") return { rows: [dimRow("purchase", { events: 12 }, { events: 10 })], total: 1 };
      if (i.dim === "allEvents") return { rows: [
        dimRow("page_view", { keyEvents: 5000, events: 5000 }, { keyEvents: 4000, events: 4000 }),
        dimRow("purchase", { keyEvents: 12, events: 12 }, { keyEvents: 10, events: 10 }),
        dimRow("scroll", { keyEvents: 0, events: 900 }),
      ], total: 3 };
      return { rows: [], total: 0 };
    });
  });

  const run = () => webOverview({ from: FROM, to: TO, brand: null, compare: "previous", now: Date.UTC(2026, 9, 15, 10, 0, 0) });

  it("hoje vem marcado como parcial; sem linha do GA4 → null (a linha pára, não cai a zero)", async () => {
    const o: any = await run();
    expect(o.series.map((r: any) => [r.day, r.partial, r.sessions])).toEqual([["2026-10-13", false, 100], ["2026-10-14", false, 200], ["2026-10-15", true, null]]);
    // as reservas de hoje contam (parciais); a conversão de hoje fica sem taxa (sem sessões)
    expect(o.series[2]).toMatchObject({ siteBookings: 1, conversionRate: null });
    expect(o.business.totals).toMatchObject({ siteBookings: 3, sessions: 300 });
    expect(o.business.totals.conversionRate).toBeCloseTo(3 / 300, 10);
  });

  it("eventos-chave por evento (o que o GA4 conta) e os eventos que o site envia", async () => {
    const o: any = await run();
    expect(o.allEventsCollected).toBe(true);
    expect(o.keyEventsByName).toEqual([
      { event: "page_view", keyEvents: 5000, prevKeyEvents: 4000, events: 5000 },
      { event: "purchase", keyEvents: 12, prevKeyEvents: 10, events: 12 },
    ]);
    expect(o.siteEvents).toEqual(["page_view", "scroll", "purchase"]);
    expect(h.dimCompare).toHaveBeenCalledWith(expect.objectContaining({ source: "ga", dim: "allEvents", ids: ["1111"] }));
  });

  it("funil: diz que passos não chegaram ao GA4 (só o purchase chega)", async () => {
    const o: any = await run();
    expect(o.funnel.map((f: any) => f.event)).toEqual(["purchase"]);
    expect(o.funnelEvents).toEqual(["view_item", "begin_checkout", "add_payment_info", "purchase"]);
    expect(o.funnelMissing).toEqual(["view_item", "begin_checkout", "add_payment_info"]);
    expect(funnelMissing(["a", "b", "c"], new Set(["b"]))).toEqual(["a", "c"]);
  });

  it("antes da 1.ª recolha dos eventos: lista vazia e allEventsCollected = false", async () => {
    h.dimCompare.mockImplementation(async () => ({ rows: [], total: 0 }));
    const o: any = await run();
    expect(o.allEventsCollected).toBe(false);
    expect(o.keyEventsByName).toEqual([]);
  });
});

// ─── 2. recolha dos eventos-chave (só leitura do GA4) ───────────────────────

describe("F2.2 — recolha: todos os eventos com os eventos-chave", () => {
  it("parte nova 'allEvents': sem o filtro do funil, com eventCount e keyEvents", () => {
    expect(GA_PARTS).toContain("allEvents");
    expect(GA_DIMS.allEvents.apiName).toBe("eventName");
    const r: any = gaDimRequest("allEvents", "2026-10-01", "2026-10-14", { funnelEvents: ["purchase"] });
    expect(r.metrics.map((m: any) => m.name)).toEqual(["eventCount", "keyEvents"]);
    expect(r.dimensions.map((d: any) => d.name)).toEqual(["date", "eventName"]);
    expect(r.dimensionFilter).toBeUndefined();
    // o pedido do funil continua igual
    const ev: any = gaDimRequest("event", "2026-10-01", "2026-10-14", { funnelEvents: ["purchase"] });
    expect(ev.dimensionFilter.filter.inListFilter.values).toEqual(["purchase"]);
  });

  it("gravação: os eventos-chave ficam sempre no top do dia, mesmo raros", () => {
    const rows = [
      ...Array.from({ length: 45 }, (_, i) => ({ day: "2026-10-14", dim: `ev_${i}`, m: { eventCount: 1000 - i, keyEvents: 0 } })),
      { day: "2026-10-14", dim: "purchase", m: { eventCount: 3, keyEvents: 3 } },
    ];
    const out = gaDimRowsToStore("allEvents", rows);
    expect(out).toHaveLength(GA_DIMS.allEvents.topN);
    expect(out[0]).toMatchObject({ dimValue: "purchase", keyEvents: 3, eventCount: 3 });
    expect(out.some((r) => r.dimValue === "ev_44")).toBe(false);
  });

  it("sem migração: o nome da dimensão cabe na coluna `dim` (VARCHAR(12))", () => {
    for (const d of Object.keys(GA_DIMS)) expect(d.length).toBeLessThanOrEqual(12);
  });

  it("eventos automáticos do GA4 assinalados (não são reservas)", () => {
    expect(isGa4AutoEvent("page_view")).toBe(true);
    expect(isGa4AutoEvent("user_engagement")).toBe(true);
    expect(isGa4AutoEvent("purchase")).toBe(false);
    expect(isGa4AutoEvent("begin_checkout")).toBe(false);
  });
});

// ─── 2. rótulos ─────────────────────────────────────────────────────────────

describe("F2.2 — rótulos: 'Eventos-chave GA4', nunca 'Conversões'", () => {
  const panel = src("client/src/components/marketing/MarketingWebPanel.tsx");

  it("KPI, canais e páginas de entrada dizem 'Eventos-chave GA4', com a explicação", () => {
    expect(panel).toContain(`label="Eventos-chave GA4"`);
    expect(panel).toContain(`keyEvents: "Eventos-chave GA4"`);
    expect(panel).toContain(`title={KEY_EVENTS_TIP}>Eventos-chave GA4</TableHead>`);
    expect(panel).toMatch(/KEY_EVENTS_TIP = ".*NÃO são reservas/);
    expect(panel).not.toContain(`label="Conversões (eventos-chave)"`);
    expect(panel).not.toContain(`keyEvents: "Conversões"`);
    expect(panel).not.toContain(`label: "Mais conversões"`);
  });

  it("o resumo semanal (IA e texto fixo) também não chama conversões aos eventos-chave", () => {
    const f = {
      from: "2026-10-06", to: "2026-10-12", ga: { sessions: 1000, prevSessions: 900, users: 800, prevUsers: 700, keyEvents: 17000, prevKeyEvents: 15000, revenue: 0, prevRevenue: 0 },
      channels: [], sc: null, gainers: [], losers: [], pagespeed: [], bookings: { siteBookings: 30, prevSiteBookings: 25 },
    };
    expect(webFactsText(f)).toMatch(/eventos-chave GA4 \(eventos marcados no GA4, não são reservas\)/);
    expect(webFactsText(f)).not.toMatch(/conversões/);
    expect(webInsightFallback(f)).toMatch(/eventos-chave GA4 \+13%/);
    expect(webInsightFallback(f)).not.toMatch(/conversões/);
    expect(src("server/webAnalytics/service.ts")).toContain("NÃO são reservas nem conversões");
  });
});

// ─── 4 e 5. páginas de entrada e dia de hoje no ecrã ────────────────────────

describe("F2.4/F2.5 — páginas de entrada e o dia de hoje no ecrã", () => {
  const panel = src("client/src/components/marketing/MarketingWebPanel.tsx");

  it("a etiqueta das páginas é o nome da propriedade GA4 (por linha), só com mais de uma propriedade na vista", () => {
    // o servidor dá o nome da propriedade de cada linha (não um valor fixo)
    expect(src("server/webAnalytics/router.ts")).toContain("sourceLabel: x.sourceId ? labels.get(x.sourceId) ?? x.sourceId : null");
    expect(panel).toContain(`dim="landing" title="Páginas de entrada" firstCol="Página" showSource={gaSources > 1}`);
    expect(panel).toContain("{showSource && r.sourceLabel &&");
  });

  it("o dia em curso aparece como 'hoje' com a marca de parcial nos dois gráficos por dia", () => {
    expect(panel).toContain(`label: r.partial ? TODAY_LABEL : shortDay(r.day)`);
    expect(panel.match(/<ReferenceLine [^>]*x=\{TODAY_LABEL\}/g)?.length).toBe(2);
  });

  it("a ajuda explica as reservas com o Marketplace, os eventos-chave, o funil e o dia de hoje", () => {
    const help = src("docs/ajuda/web-analytics.md");
    expect(help).toContain("**Eventos-chave GA4**");
    expect(help).toContain("**com o Marketplace**");
    expect(help).toContain("A marca **Multipark** inclui o **Marketplace**");
    expect(help).toContain("**Hoje** aparece como \"hoje\" (parcial)");
  });
});
