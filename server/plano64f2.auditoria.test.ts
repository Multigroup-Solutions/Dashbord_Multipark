/**
 * Plano 64, F2 — auditoria: provas de ponta a ponta com a leitura REAL das
 * reservas do Marketing (loadMarketingBookings → toMarketingBooking → nó do
 * Marketplace → filtro de âmbito → cache). Falsos só a BD da Multipark (as
 * linhas, com a mesma regra do SQL: parques nossos todas, terceiros todas,
 * nossos "só Marketplace" só as de origem MARKETPLACE), o contexto dos parques,
 * a árvore de projetos e o gasto dos anúncios:
 *  1. Web & SEO == Painel do Marketing com os mesmos dados — todas as marcas,
 *     uma marca (o filtro "<marca> (todas as cidades)" do Painel) e a tabela
 *     por marca (reservas, valor e gasto);
 *  2. âmbito de cidade: um supervisor de Lisboa não vê reservas do Porto nem
 *     as do "Marketplace (sem cidade)";
 *  3. a cache das reservas (60 s) não passa a lista de um âmbito a outro.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adAccounts, projects } from "../drizzle/schema";
import type { CityAccess } from "./cityAccess";

const h = vi.hoisted(() => ({
  ctx: null as any,
  rows: [] as any[],
  reads: 0,
  ads: null as any,
  tree: [] as Array<{ id: number; name: string; level: string; parentId: number | null }>,
}));

vi.mock("./finance/liveBookings", async (original) => ({ ...(await original<object>()), loadLiveContext: async () => h.ctx }));
vi.mock("./multiparkDb/marketingBookings", async (original) => ({
  ...(await original<object>()),
  // A regra do SQL (buildMarketingBookingsSql, testado em marketingMarketplace.test.ts).
  readMarketingBookings: async (spec: { parkIds: string[]; marketplaceParkIds?: string[]; marketplaceOnlyParkIds?: string[] }) => {
    h.reads++;
    const own = new Set(spec.parkIds), third = new Set(spec.marketplaceParkIds ?? []), onlyMkt = new Set(spec.marketplaceOnlyParkIds ?? []);
    return h.rows.filter((r) => own.has(r.parkId) || third.has(r.parkId) || (onlyMkt.has(r.parkId) && r.origin === "MARKETPLACE"));
  },
}));
vi.mock("./db", async (original) => {
  /** O nó e os descendentes; negativo = a marca em todas as cidades (como resolveProjectIds). */
  const resolve = (id: number): number[] => {
    const anchors = id < 0 ? h.tree.filter((p) => { const a = h.tree.find((x) => x.id === -id)!; return p.level === a.level && p.name === a.name; }).map((p) => p.id) : [id];
    const out = new Set<number>();
    const add = (pid: number) => { if (out.has(pid)) return; out.add(pid); for (const p of h.tree) if (p.parentId === pid) add(p.id); };
    anchors.forEach(add);
    return [...out];
  };
  const fakeDb = {
    execute: async () => [h.tree, []],
    select: () => ({
      from: (t: unknown) => {
        const rows = t === projects ? h.tree : t === adAccounts ? [] : [];
        const q: any = Promise.resolve(rows);
        q.where = () => q;
        q.orderBy = async () => rows;
        return q;
      },
    }),
  };
  return { ...(await original<object>()), getDb: async () => fakeDb, resolveProjectIds: async (id: number) => resolve(id) };
});
vi.mock("./finance/rates", async (original) => ({ ...(await original<object>()), vatRateForPeriod: async () => 0.23 }));
vi.mock("./integrations/googleAds/oauth", () => ({ getConnection: async () => null }));
vi.mock("./integrations/googleAds/adMetrics", async (original) => ({ ...(await original<object>()), getAdMetrics: async () => h.ads }));

import { loadMarketingBookings, resetMarketingBookingsCache } from "./marketingLive";
import { adSpendByDay, bookingsByDay } from "./webAnalytics/queries";
import { getMarketingStats, getSpendAndBookingsByBrand } from "./integrations/googleAds/marketingStats";
import { cityScope } from "./cityScope";

// Lisboa (1) → Airpark (10) → Airpark Lisboa (100); Lisboa → Marketplace (30) → Readypark Lisboa (300)
// Porto (2)  → Airpark (20) → Airpark Porto (200);  Porto  → Marketplace (40)
const TREE = [
  { id: 1, name: "Lisboa", level: "city", parentId: null },
  { id: 2, name: "Porto", level: "city", parentId: null },
  { id: 10, name: "Airpark", level: "brand", parentId: 1 },
  { id: 20, name: "Airpark", level: "brand", parentId: 2 },
  { id: 30, name: "Marketplace", level: "brand", parentId: 1 },
  { id: 40, name: "Marketplace", level: "brand", parentId: 2 },
  { id: 100, name: "Airpark Lisboa", level: "project", parentId: 10 },
  { id: 200, name: "Airpark Porto", level: "project", parentId: 20 },
  { id: 300, name: "Readypark Lisboa", level: "project", parentId: 30 },
];
const CTX = {
  ourParks: new Map<string, number | null>([["pA", 100], ["pP", 200]]),
  aliases: new Map<string, string>(),
  marketplaceParks: new Map<string, number | null>([["t1", 300], ["t9", null]]),
  marketplaceParkInfo: new Map([["t1", { name: "Readypark", city: "Lisboa", operated: true }], ["t9", { name: "Sem Cidade", city: null, operated: false }]]),
  marketplaceNodeByCity: new Map([["lisboa", 30], ["porto", 40]]),
  parkCity: new Map<string, string | null>([["pA", "lisboa"], ["pP", "porto"]]),
};
const row = (id: string, parkId: string, origin: string, total: number, o: Record<string, unknown> = {}) => ({
  id, createdAt: "2026-10-13 10:00:00", day: "2026-10-13", parkId, status: "BOOKED", origin, originUrl: null,
  partnerId: null, partnerName: null, paymentMethod: null, paymentSource: null, campaignName: null, discountCode: null,
  total, hasEmail: true, newClient: true, commission: null, pro: false, plan: false, ...o,
});
const ROWS = [
  row("a1", "pA", "API", 50),                                                         // Airpark Lisboa, site
  row("a2", "pA", "MANUAL", 40),                                                      // Airpark Lisboa, telefone
  row("a3", "pA", "MARKETPLACE", 60, { day: "2026-10-14" }),                          // nossa pelo multipark.pt → Marketplace Lisboa
  row("p1", "pP", "GENERAL_FORM", 70),                                                // Airpark Porto, formulário
  row("p2", "pP", "MARKETPLACE", 30, { day: "2026-10-14" }),                          // nossa pelo multipark.pt → Marketplace Porto
  row("t1a", "t1", "API", 100, { commission: 20 }),                                   // terceiros Lisboa, site
  row("t1b", "t1", "MARKETPLACE", 80, { commission: 16, day: "2026-10-14" }),         // terceiros Lisboa, multipark.pt
  row("t9a", "t9", "GENERAL_FORM", 90, { commission: 18, day: "2026-10-14" }),        // terceiros sem cidade, formulário
];
const camp = (key: string, projectId: number, cost: number) => ({
  key, name: key, accountName: null, campaignId: null, accountId: 1, source: "api", provider: "google_ads", status: "ENABLED", externalId: key,
  projectId, cost, impressions: 100, clicks: 10, conversions: 1, conversionValue: 0, budgetPerDay: null,
});
const ADS: any = {
  totals: { cost: 25, conversions: 4, impressions: 400, clicks: 40, cpc: 0.6, ctr: 0.1 },
  byProvider: { google_ads: 25, meta: 0, other: 0 },
  byProviderTotals: { google_ads: { conversions: 4, conversionValue: 0, costPerConversion: 6.25, roasGoogle: null }, meta: { conversions: 0, conversionValue: 0, costPerConversion: null, roasGoogle: null } },
  meta: { hasDataInPeriod: false }, coverage: { apiDays: 2, legacyDays: 0, status: "ok" }, budgetEstimate: 0, unmappedCampaigns: 0,
  byDay: [{ date: "2026-10-13", cost: 15, conversions: 2 }, { date: "2026-10-14", cost: 10, conversions: 2 }],
  byDayProject: [
    { date: "2026-10-13", projectId: 30, cost: 10 }, { date: "2026-10-13", projectId: 100, cost: 5 },
    { date: "2026-10-14", projectId: 40, cost: 7 }, { date: "2026-10-14", projectId: 200, cost: 3 },
  ],
  byCampaign: [camp("c30", 30, 10), camp("c100", 100, 5), camp("c40", 40, 7), camp("c200", 200, 3)],
  nationalShares: [], currencyExcluded: [],
};
const FROM = "2026-10-13", TO = "2026-10-14";
const access = (projectIds: number[]): CityAccess => ({ all: false, defaultCityId: 1, cityIds: [1], projectIds, missingCostCenter: false });
const asUser = <T>(projectIds: number[] | null, fn: () => Promise<T>): Promise<T> =>
  projectIds ? cityScope.run(access(projectIds), fn) : fn();

const total = (m: Map<string, { bookings: number; siteBookings: number; revenue: number; siteRevenue: number }>) =>
  [...m.values()].reduce((t, x) => ({ bookings: t.bookings + x.bookings, siteBookings: t.siteBookings + x.siteBookings, revenue: t.revenue + x.revenue }), { bookings: 0, siteBookings: 0, revenue: 0 });

beforeEach(() => {
  resetMarketingBookingsCache();
  h.ctx = CTX;
  h.rows = ROWS;
  h.reads = 0;
  h.ads = ADS;
  h.tree = TREE;
});

describe("F2 (auditoria) — Web & SEO == Painel do Marketing, com a leitura real", () => {
  it("todas as marcas: as mesmas reservas e as mesmas 'feitas no site'", async () => {
    const web = total(await bookingsByDay(FROM, TO, null));
    const painel: any = await getMarketingStats({ from: FROM, to: TO }, ADS);
    expect(painel.bookingsTotal).toBe(8);
    expect(painel.attributionQuality.siteBookings).toBe(4); // a1, p1, t1a, t9a (as de origem MARKETPLACE não são "site")
    expect(web.bookings).toBe(painel.bookingsTotal);
    expect(web.siteBookings).toBe(painel.attributionQuality.siteBookings);
  });

  it("uma marca: Airpark == Painel filtrado por 'Airpark (todas as cidades)'", async () => {
    const web = total(await bookingsByDay(FROM, TO, "airpark"));
    const painel: any = await getMarketingStats({ from: FROM, to: TO, projectId: -10 }, ADS);
    expect(web).toMatchObject({ bookings: 3, siteBookings: 2 }); // a1, a2, p1 (a3/p2 vieram pelo multipark.pt → Marketplace)
    expect(web.bookings).toBe(painel.bookingsTotal);
    expect(web.siteBookings).toBe(painel.attributionQuality.siteBookings);
  });

  it("uma marca: Multipark == Painel filtrado por 'Marketplace (todas as cidades)' + as do Marketplace (sem cidade)", async () => {
    const web = total(await bookingsByDay(FROM, TO, "multipark"));
    const painel: any = await getMarketingStats({ from: FROM, to: TO, projectId: -30 }, ADS);
    expect(web).toMatchObject({ bookings: 5, siteBookings: 2 }); // a3, p2, t1a, t1b, t9a; site: t1a, t9a
    expect(painel.bookingsTotal).toBe(4);                        // sem o t9a (sem cidade fica fora de qualquer filtro de centro)
    expect(painel.marketplace.withoutCity.bookings).toBe(0);
    const all: any = await getMarketingStats({ from: FROM, to: TO }, ADS);
    expect(web.bookings).toBe(painel.bookingsTotal + all.marketplace.withoutCity.bookings);
    expect(web.siteBookings).toBe(painel.attributionQuality.siteBookings + 1);
  });

  it("tabela por marca do Marketing: as mesmas reservas e o mesmo gasto por marca; o valor é o total da reserva", async () => {
    const byBrand: any = await getSpendAndBookingsByBrand({ from: FROM, to: TO }, ADS);
    const row = (name: string) => byBrand.brands.find((b: any) => b.brand === name);
    const mp = total(await bookingsByDay(FROM, TO, "multipark")), air = total(await bookingsByDay(FROM, TO, "airpark"));
    expect(row("Marketplace")).toMatchObject({ bookings: mp.bookings, spend: 17 });
    expect(row("Airpark")).toMatchObject({ bookings: air.bookings, spend: 8 });
    // Jorge (15 out): o Web & SEO usa o valor TOTAL (o que o cliente paga), também nos terceiros;
    // o Marketing conta os terceiros só pela comissão → na marca Multipark o valor é diferente de propósito.
    expect(mp.revenue).toBe(60 + 30 + 100 + 80 + 90);
    expect(row("Marketplace").revenue).toBeCloseTo(60 + 30 + 20 + 16 + 18, 6);
    expect(row("Airpark").revenue).toBeCloseTo(air.revenue, 6); // parques nossos: o preço é o total nos dois
    expect(byBrand.bookingsWithoutBrand).toBe(0);
    const spend = async (b: string) => [...(await adSpendByDay(FROM, TO, b)).byDay.values()].reduce((t, x) => t + x, 0);
    expect(await spend("multipark")).toBe(row("Marketplace").spend);
    expect(await spend("airpark")).toBe(row("Airpark").spend);
    // "todas as marcas" soma cada gasto uma vez
    expect([...(await adSpendByDay(FROM, TO, null)).byDay.values()].reduce((t, x) => t + x, 0)).toBe(25);
  });
});

describe("F2 — receita do Web & SEO pelo valor total (decisão do Jorge, 15 out 2026)", () => {
  it("uma reserva de parque de terceiros entra pelo valor total, não pela comissão; as contagens não mudam", async () => {
    const byDay = await bookingsByDay(FROM, TO, null);
    const day13 = byDay.get("2026-10-13")!; // a1 (50, site), a2 (40), p1 (70, site), t1a (terceiros: total 100, comissão 20, site)
    expect(day13).toMatchObject({ bookings: 4, siteBookings: 3, siteRevenue: 50 + 70 + 100, revenue: 50 + 40 + 70 + 100 });
    const t1a = (await loadMarketingBookings(FROM, TO, null, { marketplace: true })).find((b) => b.id === "t1a")!;
    expect(t1a).toMatchObject({ total: 100, value: 20 }); // o Marketing usa o value (20); o Web & SEO o total (100)
  });
});

describe("F2 (auditoria) — âmbito de cidade", () => {
  const LISBOA = [1, 10, 30, 100, 300];

  it("um supervisor de Lisboa só vê Lisboa (nem Porto nem 'sem cidade'), igual no Web & SEO e no Painel", async () => {
    const ids = (await asUser(LISBOA, () => loadMarketingBookings(FROM, TO, LISBOA, { marketplace: true }))).map((b) => b.id).sort();
    expect(ids).toEqual(["a1", "a2", "a3", "t1a", "t1b"]);
    const web = total(await asUser(LISBOA, () => bookingsByDay(FROM, TO, null)));
    const painel: any = await asUser(LISBOA, () => getMarketingStats({ from: FROM, to: TO }, ADS));
    expect(web).toMatchObject({ bookings: 5, siteBookings: 2 });
    expect(web.bookings).toBe(painel.bookingsTotal);
    expect(web.siteBookings).toBe(painel.attributionQuality.siteBookings);
  });

  it("quem vê tudo (sem âmbito) vê as 8, com as do Porto e a sem cidade", async () => {
    const ids = (await loadMarketingBookings(FROM, TO, null, { marketplace: true })).map((b) => b.id).sort();
    expect(ids).toEqual(["a1", "a2", "a3", "p1", "p2", "t1a", "t1b", "t9a"]);
  });

  it("a cache (60 s) não passa a lista de um âmbito a outro com os mesmos parques", async () => {
    // Os dois leem só o parque pA; um vê o nó Marketplace de Lisboa (30), o outro não.
    const SEM_MKT = [1, 10, 100], COM_MKT = [1, 10, 100, 30];
    const idsOf = async (scope: number[]) => (await asUser(scope, () => loadMarketingBookings(FROM, TO, null, { marketplace: true }))).map((b) => b.id).sort();
    expect(await idsOf(SEM_MKT)).toEqual(["a1", "a2"]);
    expect(await idsOf(COM_MKT)).toEqual(["a1", "a2", "a3"]);
    resetMarketingBookingsCache();
    expect(await idsOf(COM_MKT)).toEqual(["a1", "a2", "a3"]);
    expect(await idsOf(SEM_MKT)).toEqual(["a1", "a2"]); // não herda a a3 do outro âmbito
    // no mesmo âmbito, a cache serve (uma leitura)
    const before = h.reads;
    await idsOf(SEM_MKT);
    expect(h.reads).toBe(before);
  });
});
