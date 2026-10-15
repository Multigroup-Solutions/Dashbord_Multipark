/**
 * B2 das campanhas (Jorge, 8 out 2026 — "1 sim 2 sim 3 não"):
 *  1. via net de cada marca/cidade repartido pelas campanhas (conversões →
 *     cliques → gasto; nacionais pela sua parte);
 *  2. valor: parques nossos = preço inteiro; terceiros = só a nossa comissão;
 *  3. não contam como via net: pendentes, clientes Pro e avenças;
 *  4. alerta "sem resultados" = gasto, 0 via net E 0 ligadas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const live = vi.hoisted(() => ({ bookings: [] as any[], ads: null as any, projects: [] as any[] }));
vi.mock("./db", async (original) => ({ ...(await original<object>()), getDb: async () => ({ execute: async () => [[], []] }), getProjects: async () => live.projects }));
vi.mock("./marketingSql", async (original) => ({ ...(await original<object>()), marketingProjectIds: async () => null }));
vi.mock("./finance/rates", async (original) => ({ ...(await original<object>()), vatRateForPeriod: async () => 0.23 }));
vi.mock("./integrations/googleAds/oauth", () => ({ getConnection: async () => null }));
vi.mock("./integrations/googleAds/adMetrics", async (original) => ({ ...(await original<object>()), getAdMetrics: async () => live.ads }));
vi.mock("./marketingLive", async (original) => ({ ...(await original<object>()), loadMarketingBookings: async () => live.bookings }));

import {
  brandNodeResolver, fmtViaNet, isViaNet, marketingValueOf, splitBase, splitViaNet, thirdParkRates, viaNetExclusion, viaNetParticipants, viaNetPools,
  withMarketingValues, VIA_NET_SPLIT_EXPLAINER,
} from "../shared/viaNet";
import { buildMarketingBookingsSql, mapMarketingBookingRow, type MarketingBookingRow } from "./multiparkDb/marketingBookings";
import { assertReadOnlySql } from "./multiparkDb/client";
import { toMarketingBooking } from "./marketingLive";
import { computeMarketingAlerts } from "../shared/marketingAlerts";

// Árvore: Lisboa (city 1) → Airpark Lisboa (brand 10) → parque 100; Porto (city 2) → Airpark Porto (brand 20) → parque 200; Faro (3) → Airpark Faro (30)
const projects = [
  { id: 1, name: "Lisboa", level: "city", parentId: null }, { id: 2, name: "Porto", level: "city", parentId: null }, { id: 3, name: "Faro", level: "city", parentId: null },
  { id: 10, name: "Airpark", level: "brand", parentId: 1 }, { id: 20, name: "Airpark", level: "brand", parentId: 2 }, { id: 30, name: "Airpark", level: "brand", parentId: 3 },
  { id: 100, name: "Airpark Lisboa P1", level: "project", parentId: 10 }, { id: 200, name: "Airpark Porto P1", level: "project", parentId: 20 },
];
const nodeOf = brandNodeResolver(projects);

// ─── 3. que reservas contam ─────────────────────────────────────────────────

describe("via net: sem pendentes, Pro nem avenças", () => {
  const ctx = { ourParks: new Map<string, number | null>([["pA", 100]]), aliases: new Map<string, string>() };
  const row = (o: Partial<MarketingBookingRow>): MarketingBookingRow => ({ id: "b", createdAt: "2026-10-01 09:00:00", day: "2026-10-01", parkId: "pA", status: "BOOKED", origin: "API", originUrl: null, partnerId: null, partnerName: null, paymentMethod: null, paymentSource: null, campaignName: null, discountCode: null, total: 50, hasEmail: true, newClient: true, ...o });

  it("regra pura: pendente → Pro → avença; parceiro nunca conta", () => {
    expect(viaNetExclusion({ status: "PENDING" })).toBe("pending");
    expect(viaNetExclusion({ status: "pending", pro: true })).toBe("pending");
    expect(viaNetExclusion({ status: "BOOKED", pro: true, plan: true })).toBe("pro");
    expect(viaNetExclusion({ status: "CHECKED_IN", plan: true })).toBe("plan");
    expect(viaNetExclusion({ status: "CHECKED_OUT" })).toBeNull();
    expect(isViaNet("direto", null)).toBe(true);
    expect(isViaNet("marketplace", null)).toBe(true);
    expect(isViaNet("parceiro", null)).toBe(false);
    expect(isViaNet("direto", "pro")).toBe(false);
  });

  it("na reserva do Marketing: fica marcado o motivo (só quando não é parceiro)", () => {
    expect(toMarketingBooking(row({ status: "PENDING" }), ctx as any)).toMatchObject({ viaNet: false, viaNetOut: "pending" });
    expect(toMarketingBooking(row({ pro: true }), ctx as any)).toMatchObject({ viaNet: false, viaNetOut: "pro" });
    expect(toMarketingBooking(row({ plan: true }), ctx as any)).toMatchObject({ viaNet: false, viaNetOut: "plan" });
    expect(toMarketingBooking(row({ status: "CHECKED_OUT" }), ctx as any)).toMatchObject({ viaNet: true, viaNetOut: null });
    expect(toMarketingBooking(row({ partnerId: "p1", partnerName: "Parkos", status: "PENDING" }), ctx as any)).toMatchObject({ viaNet: false, viaNetOut: null });
  });

  it("o SQL lê Pro e avença como a Faturação de parceiros (só leitura)", () => {
    const { sql } = buildMarketingBookingsSql({ start: "2026-09-30 23:00:00", end: "2026-10-31 23:00:00", parkIds: ["pA"], internalDomains: ["multipark.pt"] });
    expect(sql).toContain(`(b."proClientId" IS NOT NULL OR COALESCE(b."pro", false)) AS pro, (b."clientPlanId" IS NOT NULL) AS plan`);
    expect(sql).toContain("d.commission, d.pro, d.plan");
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(mapMarketingBookingRow({ id: "x", pro: true, plan: "t" })).toMatchObject({ pro: true, plan: true });
    expect(mapMarketingBookingRow({ id: "x", pro: false, plan: null })).toMatchObject({ pro: false, plan: false });
  });
});

// ─── 2. quanto vale ─────────────────────────────────────────────────────────

describe("valor para o Marketing: nossos inteiro, terceiros só a nossa comissão", () => {
  it("nosso = preço inteiro (também com origem Marketplace); terceiro = comissão gravada", () => {
    expect(marketingValueOf({ parkId: "own", parkOurs: true, total: 80 }, new Map())).toMatchObject({ value: 80, valueBasis: "price" });
    expect(marketingValueOf({ parkId: "own", parkOurs: true, total: 80, commission: 16 }, new Map())).toMatchObject({ value: 80 });
    expect(marketingValueOf({ parkId: "t1", parkOurs: false, total: 100, commission: 25 }, new Map())).toMatchObject({ value: 25, valueBasis: "commission", commissionMissing: false });
  });

  it("terceiro sem comissão gravada → a taxa do parque no período (comissão ÷ valor das que a têm); sem nenhuma → 0, em falta", () => {
    const list = [
      { id: "a", parkId: "t1", parkOurs: false, total: 100, commission: 25 },
      { id: "b", parkId: "t1", parkOurs: false, total: 100, commission: 15 },
      { id: "c", parkId: "t1", parkOurs: false, total: 50, commission: null },
      { id: "d", parkId: "t2", parkOurs: false, total: 70, commission: null },
      { id: "e", parkId: "own", parkOurs: true, total: 60, commission: null },
    ];
    expect(thirdParkRates(list).get("t1")).toBeCloseTo(0.2, 6);
    expect(thirdParkRates(list).has("t2")).toBe(false);
    const out = withMarketingValues(list);
    expect(out.map((x) => [x.id, x.value, x.valueBasis])).toEqual([
      ["a", 25, "commission"], ["b", 15, "commission"], ["c", 10, "park_rate"], ["d", 0, "missing"], ["e", 60, "price"],
    ]);
    expect(out[3].commissionMissing).toBe(true);
    // não mexe na lista de entrada
    expect((list[2] as any).value).toBeUndefined();
  });
});

// ─── 1. repartição pelas campanhas ──────────────────────────────────────────

describe("via net repartido pelas campanhas da marca/cidade", () => {
  const camp = (key: string, projectId: number | null, o: Partial<{ conversions: number; clicks: number; cost: number; national: boolean }> = {}) => ({ key, projectId, conversions: 0, clicks: 0, cost: 0, ...o });

  it("nó marca-cidade de um projeto (parque → marca de cima)", () => {
    expect(nodeOf(100)).toBe(10);
    expect(nodeOf(10)).toBe(10);
    expect(nodeOf(1)).toBeNull();
    expect(nodeOf(null)).toBeNull();
  });

  it("pelas conversões da plataforma", () => {
    const parts = viaNetParticipants([camp("A", 10, { conversions: 3, clicks: 10, cost: 50 }), camp("B", 10, { conversions: 1, clicks: 90, cost: 50 })], [], nodeOf);
    const s = splitViaNet(new Map([[10, { bookings: 10, value: 400 }]]), parts);
    expect(s.baseByNode.get(10)).toBe("conversions");
    expect(s.byCampaign.get("A")).toEqual({ bookings: 7.5, value: 300, share: 0.75, base: "conversions" });
    expect(s.byCampaign.get("B")).toEqual({ bookings: 2.5, value: 100, share: 0.25, base: "conversions" });
  });

  it("sem conversões no grupo → pelos cliques; sem cliques → pelo gasto", () => {
    const byClicks = splitViaNet(new Map([[10, { bookings: 3, value: 90 }]]), viaNetParticipants([camp("A", 10, { clicks: 20, cost: 5 }), camp("B", 10, { clicks: 10, cost: 95 })], [], nodeOf));
    expect(byClicks.byCampaign.get("A")).toMatchObject({ bookings: 2, value: 60, base: "clicks" });
    expect(byClicks.byCampaign.get("B")).toMatchObject({ bookings: 1, value: 30, base: "clicks" });
    const byCost = splitViaNet(new Map([[10, { bookings: 4, value: 100 }]]), viaNetParticipants([camp("A", 10, { cost: 30 }), camp("B", 10, { cost: 10 })], [], nodeOf));
    expect(byCost.byCampaign.get("A")).toMatchObject({ bookings: 3, value: 75, base: "cost" });
    expect(splitBase([{ conversions: 0, clicks: 0, cost: 0 }])).toBeNull();
  });

  it("grupo sem campanhas → por repartir; campanha por associar fica de fora; grupo sem via net → 0", () => {
    const parts = viaNetParticipants([camp("A", 10, { conversions: 2 }), camp("U", null, { conversions: 5 }), camp("P", 20, { clicks: 4 })], [], nodeOf);
    expect(parts.map((p) => p.key)).toEqual(["A", "P"]);
    const s = splitViaNet(new Map([[10, { bookings: 2, value: 50 }], [30, { bookings: 5, value: 200 }]]), parts);
    expect(s.unassigned).toEqual({ bookings: 5, value: 200, nodes: [30] });
    expect(s.byCampaign.get("P")).toMatchObject({ bookings: 0, value: 0, base: "clicks" });
    expect(s.byCampaign.has("U")).toBe(false);
  });

  it("nacionais: entram em cada cidade pela sua parte (nationalShares), somadas; bases diferentes → 'mixed'", () => {
    const parts = viaNetParticipants(
      [camp("N", null, { national: true, conversions: 9, clicks: 99, cost: 99 }), camp("L", 10, { conversions: 1 }), camp("P", 20, { conversions: 0, clicks: 10 })],
      [{ key: "N", projectId: 10, conversions: 3, clicks: 30, cost: 30 }, { key: "N", projectId: 20, conversions: 0, clicks: 30, cost: 30 }],
      nodeOf,
    );
    // a linha da nacional não entra (só as partes)
    expect(parts.filter((p) => p.key === "N").map((p) => p.node)).toEqual([10, 20]);
    const s = splitViaNet(new Map([[10, { bookings: 8, value: 800 }], [20, { bookings: 4, value: 400 }]]), parts);
    // Lisboa: conversões N 3, L 1 → N 6, L 2. Porto: sem conversões → cliques N 30, P 10 → N 3, P 1
    expect(s.byCampaign.get("N")).toEqual({ bookings: 9, value: 900, share: 0.75, base: "mixed" });
    expect(s.byCampaign.get("L")).toMatchObject({ bookings: 2, value: 200, base: "conversions" });
    expect(s.byCampaign.get("P")).toMatchObject({ bookings: 1, value: 100, base: "clicks" });
  });

  it("frações a 1 casa com '≈'; o total do grupo bate certo", () => {
    const parts = viaNetParticipants([camp("A", 10, { conversions: 1 }), camp("B", 10, { conversions: 1 }), camp("C", 10, { conversions: 1 })], [], nodeOf);
    const s = splitViaNet(new Map([[10, { bookings: 1, value: 10 }]]), parts);
    expect(s.byCampaign.get("A")!.bookings).toBe(0.3);
    expect([...s.byCampaign.values()].reduce((t, v) => t + v.value, 0)).toBeCloseTo(10, 1);
    expect(fmtViaNet(0.3)).toBe("≈ 0,3");
    expect(fmtViaNet(2)).toBe("2");
    expect(fmtViaNet(7.46)).toBe("≈ 7,5");
    expect(fmtViaNet(null)).toBe("—");
    expect(VIA_NET_SPLIT_EXPLAINER).toMatch(/conversões da Google\/Meta; sem conversões, pelos cliques/);
  });

  it("piscinas: só via net, pelo valor do Marketing, por nó", () => {
    const { pools, withoutNode } = viaNetPools([
      { projectId: 100, viaNet: true, value: 25, total: 100 },
      { projectId: 100, viaNet: false, value: 50, total: 50 },
      { projectId: 10, viaNet: true, total: 40 },
      { projectId: null, viaNet: true, value: 5, total: 5 },
    ], nodeOf);
    expect(pools.get(10)).toEqual({ bookings: 2, value: 65 });
    expect(withoutNode).toEqual({ bookings: 1, value: 5 });
  });
});

// ─── no ecrã: ROAS por campanha e números do Marketing ──────────────────────

const ads = (o: any = {}) => ({
  totals: { cost: 300, conversions: 4, impressions: 1000, clicks: 100, cpc: 3, ctr: 0.1 },
  byProvider: { google_ads: 300, meta: 0, other: 0 },
  byProviderTotals: { google_ads: { conversions: 4, conversionValue: 0, costPerConversion: 75, roasGoogle: null }, meta: { conversions: 0, conversionValue: 0, costPerConversion: null, roasGoogle: null } },
  meta: { hasDataInPeriod: false }, coverage: { apiDays: 30, legacyDays: 0, status: "ok" }, budgetEstimate: 0, unmappedCampaigns: 0, byDay: [], byDayProject: [], currencyExcluded: [],
  byCampaign: [
    { key: "api:1:111", source: "api", provider: "google_ads", externalId: "111", campaignId: 1, name: "Airpark - Lisboa - PT", accountName: "Airpark", status: "ENABLED", projectId: 10, cost: 200, clicks: 60, conversions: 3, conversionValue: 0, impressions: 0 },
    { key: "api:1:222", source: "api", provider: "google_ads", externalId: "222", campaignId: 2, name: "Airpark - Lisboa - EN", accountName: "Airpark", status: "ENABLED", projectId: 10, cost: 100, clicks: 40, conversions: 1, conversionValue: 0, impressions: 0 },
  ],
  nationalShares: [],
  ...o,
});
const bk = (o: any) => ({ id: "x", day: "2026-10-01", projectId: 100, parkId: "own", parkOurs: true, origin: "API", total: 100, value: 100, viaNet: true, viaNetOut: null, hasOriginUrl: false, hasClickId: false, adAttribution: "unknown", adCampaignExternalId: null, utmCampaign: null, campaign: null, campaignName: null, marketplace: false, operated: true, ...o });

describe("ROAS por campanha: via net repartido e valor pela nossa comissão", () => {
  beforeEach(() => { live.projects = projects; });

  it("cada campanha traz via net, valor, parte e base; ligadas valem pela regra do valor", async () => {
    live.ads = ads();
    live.bookings = [
      bk({ id: "1" }), bk({ id: "2" }), bk({ id: "3" }),
      bk({ id: "4", parkId: "t1", parkOurs: false, total: 100, value: 25, marketplace: true, adAttribution: "google_paid", adCampaignExternalId: "111" }),
      bk({ id: "5", viaNet: false, viaNetOut: "pending" }),
    ];
    const { getCampaignRoas } = await import("./marketingCampaignRoas");
    const r: any = await getCampaignRoas({ from: "2026-10-01", to: "2026-10-31" });
    const a = r.rows.find((x: any) => x.key === "api:1:111");
    const b = r.rows.find((x: any) => x.key === "api:1:222");
    // 4 via net (3 × 100 + a do terceiro 25) repartidas 3:1 pelas conversões
    expect(a).toMatchObject({ viaNetBookings: 3, viaNetValue: 243.75, viaNetShare: 0.75, viaNetBase: "conversions" });
    expect(b).toMatchObject({ viaNetBookings: 1, viaNetValue: 81.25, viaNetShare: 0.25, viaNetBase: "conversions" });
    expect(a.roasViaNetNet).toBeCloseTo(243.75 / 1.23 / 200, 6);
    // a ligada (parque de terceiros) vale só a comissão
    expect(a).toMatchObject({ bookings: 1, revenue: 25 });
    expect(r.viaNetUnassigned).toMatchObject({ bookings: 0 });
  });

  it("dashboard: valor via net e ROAS com terceiros pela comissão; 'Valor das reservas' continua o preço; fora do via net contado", async () => {
    live.bookings = [
      bk({ id: "1" }),
      bk({ id: "2", parkId: "t1", parkOurs: false, total: 200, value: 50, marketplace: true }),
      bk({ id: "3", viaNet: false, viaNetOut: "pro" }),
      bk({ id: "4", viaNet: false, viaNetOut: "plan" }),
      bk({ id: "5", viaNet: false, viaNetOut: "pending" }),
      bk({ id: "6", parkId: "t2", parkOurs: false, total: 80, value: 0, commissionMissing: true, marketplace: true }),
    ];
    const { getMarketingStats } = await import("./integrations/googleAds/marketingStats");
    const s: any = await getMarketingStats({ from: "2026-10-01", to: "2026-10-31" }, ads() as any);
    expect(s).toMatchObject({ bookingsWeb: 3, revenueWeb: 150, viaNetExcluded: { pending: 1, pro: 1, plan: 1 }, viaNetCommissionMissing: 1 });
    expect(s.revenueTotal).toBe(100 + 200 + 100 + 100 + 100 + 80);
    expect(s.roasTotalNet).toBeCloseTo((100 + 50 + 100 + 100 + 100 + 0) / 1.23 / 300, 6);
  });
});

// ─── 4. alerta ──────────────────────────────────────────────────────────────

describe("alerta 'campanha sem resultados' = gasto, 0 via net E 0 ligadas", () => {
  const base = { attribution: { siteBookings: 100, withOriginUrl: 90, withClickId: 40, attributed: 40 }, windowSpend: 1000, windowConversions: 10, monthSpend: 0, prevMonthSpend: 0, dayOfMonth: 10, daysInMonth: 31, unmappedCampaigns: 0, coverage: null };
  const c = (name: string, o: any) => ({ name, accountName: null, cost: 200, conversions: 0, attributedBookings: 0, ...o });
  it("só dispara sem via net e sem ligadas; sem marca/cidade conta a regra das conversões", () => {
    const alerts = computeMarketingAlerts({
      ...base,
      windowCampaigns: [
        c("Sem nada", { viaNetBookings: 0 }),
        c("Com via net", { viaNetBookings: 1.5 }),
        c("Com conversões mas sem via net", { conversions: 4, viaNetBookings: 0 }),
        c("Com ligadas", { viaNetBookings: 0, attributedBookings: 2 }),
        c("Por associar sem conversões", { viaNetBookings: null }),
        c("Por associar com conversões", { conversions: 2, viaNetBookings: null }),
        c("Pequena", { cost: 20, viaNetBookings: 0 }),
      ],
    });
    const a = alerts.find((x) => x.code === "campaign_no_results")!;
    expect(a.items!.map((i) => i.split(" — ")[0])).toEqual(["Sem nada", "Com conversões mas sem via net", "Por associar sem conversões"]);
    expect(a.detail).toMatch(/sem reservas via net .* nem reservas ligadas/);
    expect(a.items!.find((i) => i.startsWith("Por associar"))).toMatch(/sem marca\/cidade: sem conversões/);
  });
  it("sem via net calculado (omisso) fica como antes", () => {
    const alerts = computeMarketingAlerts({ ...base, windowCampaigns: [c("X", {}), c("Y", { conversions: 1 })] });
    expect(alerts.find((x) => x.code === "campaign_no_results")!.items!.map((i) => i.split(" — ")[0])).toEqual(["X"]);
  });
});
