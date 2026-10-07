/**
 * Jorge (7 out 2026): "continuamos a não encontrar as reservas do Marketplace"
 * — o Marketing só lia os parques nossos; as vendas pelo multipark.pt ficavam
 * de fora (terceiros) ou na marca do parque (nossos).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildMarketplaceParks, marketplaceNodesByCity, type LiveContext } from "./finance/liveBookings";
import { buildMarketingBookingsSql, type MarketingBookingRow } from "./multiparkDb/marketingBookings";
import { assertReadOnlySql } from "./multiparkDb/client";
import { marketplaceParksFor, toMarketingBooking } from "./marketingLive";

const nodes = [
  { id: 1, name: "Lisboa", level: "city", parentId: null },
  { id: 2, name: "Porto", level: "city", parentId: null },
  { id: 10, name: "Airpark", level: "brand", parentId: 1 },
  { id: 11, name: "Airpark Lisboa", level: "project", parentId: 10 },
  { id: 20, name: "Marketplace", level: "brand", parentId: 1 },
  { id: 21, name: "Readypark Lisboa", level: "project", parentId: 20 },
  { id: 30, name: "Marketplace", level: "brand", parentId: 2 },
  { id: 40, name: "Top-Parking Lisboa", level: "project", parentId: 1 },
];

describe("parques do Marketplace → nó Marketplace da cidade", () => {
  it("nó Marketplace de cada cidade", () => {
    expect(marketplaceNodesByCity(nodes)).toEqual(new Map([["lisboa", 20], ["porto", 30]]));
  });
  it("o nó do parque se estiver debaixo do Marketplace; senão o Marketplace da cidade; nossos ficam de fora", () => {
    const parks = [
      { id: "own", name: "Airpark", city: "Lisboa", firebaseBrand: "airpark", listingType: null },
      { id: "rp", name: "Readypark", city: "Lisboa", firebaseBrand: null, listingType: null },
      { id: "tp", name: "Top-Parking", city: "Lisboa", firebaseBrand: null, listingType: null },
      { id: "px", name: "Parque X", city: "Porto", firebaseBrand: null, listingType: null },
      { id: "nc", name: "Sem Cidade", city: null, firebaseBrand: null, listingType: null },
    ];
    const matcher = ({ parkName }: { parkName?: string | null }) => (parkName === "Readypark" ? 21 : parkName === "Top-Parking" ? 40 : parkName === "Airpark" ? 11 : undefined);
    const m = buildMarketplaceParks(parks, matcher, nodes);
    expect(m.has("own")).toBe(false);
    expect(m.get("rp")).toBe(21);
    expect(m.get("tp")).toBe(20); // pendurado na cidade → Marketplace Lisboa
    expect(m.get("px")).toBe(30);
    expect(m.get("nc")).toBeNull();
  });
});

describe("SQL: terceiros só com venda nossa; nossos 'só Marketplace' só com origem MARKETPLACE", () => {
  const base = { start: "2026-10-01 00:00:00", end: "2026-10-08 00:00:00", internalDomains: ["multipark.pt"] };
  it("as três listas, só leitura", () => {
    const { sql, params } = buildMarketingBookingsSql({ ...base, parkIds: ["own"], marketplaceParkIds: ["rp"], marketplaceOnlyParkIds: ["own2"] });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toMatch(/b\."origin"::text = 'MARKETPLACE' OR COALESCE\(b\."commissionAmount", 0\) > 0/);
    expect(sql).toMatch(/AND b\."origin"::text = 'MARKETPLACE'\)/);
    expect(sql).toContain(`b."commissionAmount" AS commission`);
    expect(params).toEqual(expect.arrayContaining(["own", "rp", "own2"]));
  });
  it("sem Marketplace fica igual a antes; sem parques nenhuns rebenta", () => {
    const { sql } = buildMarketingBookingsSql({ ...base, parkIds: ["own"] });
    expect(sql).not.toMatch(/commissionAmount", 0\) > 0/);
    expect(() => buildMarketingBookingsSql({ ...base, parkIds: [] })).toThrow();
    expect(() => buildMarketingBookingsSql({ ...base, parkIds: [], marketplaceParkIds: ["rp"] })).not.toThrow();
  });
});

describe("reservas do Marketing com o Marketplace", () => {
  const ctx: LiveContext = {
    ourParks: new Map([["own", 11]]), aliases: new Map(),
    marketplaceParks: new Map<string, number | null>([["rp", 21], ["px", 30]]),
    marketplaceNodeByCity: new Map([["lisboa", 20], ["porto", 30]]),
    parkCity: new Map([["own", "lisboa"]]),
  };
  const row = (o: Partial<MarketingBookingRow>): MarketingBookingRow => ({ id: "b", createdAt: "2026-10-05 09:00:00", day: "2026-10-05", parkId: "own", status: "BOOKED", origin: "API", originUrl: null, partnerId: null, partnerName: null, paymentMethod: null, campaignName: null, discountCode: null, total: 80, hasEmail: true, newClient: true, ...o });
  it("sem a opção: igual a antes (terceiros fora, nossos no parque)", () => {
    expect(toMarketingBooking(row({ parkId: "rp", origin: "MARKETPLACE" }), ctx)).toBeNull();
    expect(toMarketingBooking(row({ origin: "MARKETPLACE" }), ctx)!.projectId).toBe(11);
  });
  it("com a opção: terceiros no nó do Marketplace, via net, com a comissão", () => {
    const b = toMarketingBooking(row({ parkId: "rp", origin: "MARKETPLACE", commission: 9.5 }), ctx, { marketplace: true })!;
    expect(b).toMatchObject({ projectId: 21, viaNet: true, marketplace: true, commission: 9.5 });
  });
  it("com a opção: nosso parque vindo pelo multipark.pt → Marketplace da cidade; o resto fica no parque", () => {
    expect(toMarketingBooking(row({ origin: "MARKETPLACE" }), ctx, { marketplace: true })).toMatchObject({ projectId: 20, marketplace: true, viaNet: true });
    expect(toMarketingBooking(row({ origin: "API" }), ctx, { marketplace: true })).toMatchObject({ projectId: 11, marketplace: false });
  });
  it("âmbito: filtro no Marketplace Lisboa lê os terceiros dele e os nossos da cidade só pelo Marketplace", () => {
    expect(marketplaceParksFor(ctx, [20, 21])).toEqual({ third: ["rp"], marketplaceOnly: ["own"] });
    expect(marketplaceParksFor(ctx, [11])).toEqual({ third: [], marketplaceOnly: [] });
    expect(marketplaceParksFor(ctx)).toEqual({ third: ["rp", "px"], marketplaceOnly: [] });
  });
  it("ligado nos Anúncios, totais, ROAS por campanha e alertas", () => {
    expect(readFileSync("server/integrations/googleAds/marketingStats.ts", "utf8").match(/loadMarketingBookings\([^)]*\{ marketplace: true \}\)/g)?.length).toBe(2);
    expect(readFileSync("server/marketingCampaignRoas.ts", "utf8")).toMatch(/\{ marketplace: true \}/);
    expect(readFileSync("server/marketingAlertsService.ts", "utf8")).toMatch(/\{ marketplace: true \}/);
    // a receita, a Caixa e o CRM continuam só com os parques nossos
    expect(readFileSync("server/finance/liveBookings.ts", "utf8")).toMatch(/if \(!ctx\.ourParks\.has\(r\.parkId\)\) continue;/);
  });
});
