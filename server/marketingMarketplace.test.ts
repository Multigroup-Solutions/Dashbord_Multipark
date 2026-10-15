/**
 * Jorge (7 out 2026): "continuamos a não encontrar as reservas do Marketplace"
 * — o Marketing só lia os parques nossos; as vendas pelo multipark.pt ficavam
 * de fora (terceiros) ou na marca do parque (nossos).
 * Jorge (8 out 2026): "têm que aparecer TODAS as reservas feitas no
 * marketplace, seja de que parque for" — todas as dos terceiros, também os
 * parques sem cidade reconhecida ("Marketplace (sem cidade)", com aviso).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildMarketplaceParkInfo, buildMarketplaceParks, buildOurParks, marketplaceNodesByCity, type LiveContext } from "./finance/liveBookings";
import { buildMarketingBookingsSql, type MarketingBookingRow } from "./multiparkDb/marketingBookings";
import { assertReadOnlySql } from "./multiparkDb/client";
import { marketplaceParksFor, summarizeMarketplace, toMarketingBooking, unplacedMarketplaceParks } from "./marketingLive";

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
    // sem cidade: ENTRA (nó null = "Marketplace (sem cidade)"), nunca fica de fora
    expect(m.has("nc")).toBe(true);
    expect(m.get("nc")).toBeNull();
  });
  it("8 out 2026: cidade pela terra à volta ou pela morada (Prior Velho → Lisboa, Maia → Porto); nosso com 'Prior Velho' é nosso", () => {
    const parks = [
      { id: "pv", name: "Parque X", city: "Prior Velho", firebaseBrand: null, listingType: null },
      { id: "mo", name: "Parque Y", city: "Moscavide", firebaseBrand: null, listingType: null },
      { id: "ma", name: "Parque Z", city: "", address: "Rua de Lisboa 10, 4470-000 Maia", firebaseBrand: null, listingType: null },
      { id: "ownpv", name: "Airpark", city: "Prior Velho", firebaseBrand: "airpark", listingType: null },
    ];
    const m = buildMarketplaceParks(parks, () => undefined, nodes);
    expect(m.get("pv")).toBe(20);
    expect(m.get("mo")).toBe(20);
    expect(m.get("ma")).toBe(30);
    expect(m.has("ownpv")).toBe(false);
    const seen: Array<string | null | undefined> = [];
    const ours = buildOurParks(parks, ({ city }) => { seen.push(city); return city === "Lisboa" ? 11 : undefined; });
    expect([...ours.entries()]).toEqual([["ownpv", 11]]);
    expect(seen).toEqual(["Lisboa"]); // o centro procura-se pela cidade reconhecida
  });
  it("operado por nós: os da lista do dono e os das Definições não; os outros sim", () => {
    const info = buildMarketplaceParkInfo([
      { id: "tp", name: "Top Parking Porto", city: "Porto", firebaseBrand: null, listingType: null },
      { id: "rp", name: "Readypark", city: "Lisboa", firebaseBrand: null, listingType: null },
      { id: "bp", name: "Boardingpark", city: "Lisboa", firebaseBrand: null, listingType: null },
      { id: "own", name: "Airpark", city: "Lisboa", firebaseBrand: "airpark", listingType: null },
    ], ["bp"]);
    expect(info.get("tp")).toMatchObject({ operated: false });
    expect(info.get("rp")).toMatchObject({ operated: true });
    expect(info.get("bp")).toMatchObject({ operated: false });
    expect(info.has("own")).toBe(false);
  });
});

describe("SQL: terceiros com TODAS as reservas; nossos 'só Marketplace' só com origem MARKETPLACE", () => {
  const base = { start: "2026-10-01 00:00:00", end: "2026-10-08 00:00:00", internalDomains: ["multipark.pt"] };
  it("as três listas, só leitura", () => {
    const { sql, params } = buildMarketingBookingsSql({ ...base, parkIds: ["own"], marketplaceParkIds: ["rp"], marketplaceOnlyParkIds: ["own2"] });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    // Jorge (8 out 2026): "TODAS as reservas feitas no marketplace" — o parque de terceiros entra inteiro, sem a condição da comissão
    expect(sql).not.toMatch(/commissionAmount", 0\) > 0/);
    expect(sql).toMatch(/b\."parkId" IN \(\$1, \$2\)/);
    expect(params.slice(0, 2)).toEqual(["own", "rp"]);
    expect(sql).toMatch(/\(b\."parkId" IN \(\$3\) AND b\."origin"::text = 'MARKETPLACE'\)/);
    expect(params[2]).toBe("own2");
    expect(sql).toContain(`b."commissionAmount" AS commission`);
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
    marketplaceParks: new Map<string, number | null>([["rp", 21], ["px", 30], ["nc", null]]),
    marketplaceParkInfo: new Map([
      ["rp", { name: "Readypark", city: "Lisboa", operated: true }],
      ["px", { name: "Parque X", city: "Porto", operated: true }],
      ["nc", { name: "Top Parking", city: "Albergaria", operated: false }],
    ]),
    marketplaceNodeByCity: new Map([["lisboa", 20], ["porto", 30]]),
    parkCity: new Map([["own", "lisboa"]]),
  };
  const row = (o: Partial<MarketingBookingRow>): MarketingBookingRow => ({ id: "b", createdAt: "2026-10-05 09:00:00", day: "2026-10-05", parkId: "own", status: "BOOKED", origin: "API", originUrl: null, partnerId: null, partnerName: null, paymentMethod: null, campaignName: null, discountCode: null, total: 80, hasEmail: true, newClient: true, ...o });
  it("sem a opção: terceiros fora, nossos no parque — mas a etiqueta Marketplace e 'operado' vêm sempre", () => {
    expect(toMarketingBooking(row({ parkId: "rp", origin: "MARKETPLACE" }), ctx)).toBeNull();
    expect(toMarketingBooking(row({ origin: "MARKETPLACE" }), ctx)).toMatchObject({ projectId: 11, marketplace: true, operated: true });
    expect(toMarketingBooking(row({ origin: "API" }), ctx)).toMatchObject({ projectId: 11, marketplace: false, operated: true });
  });
  it("com a opção: terceiros no nó do Marketplace, via net, com a comissão", () => {
    const b = toMarketingBooking(row({ parkId: "rp", origin: "MARKETPLACE", commission: 9.5 }), ctx, { marketplace: true })!;
    expect(b).toMatchObject({ projectId: 21, viaNet: true, marketplace: true, operated: true, commission: 9.5 });
  });
  it("com a opção: TODAS as reservas dos terceiros (origem API, sem comissão) são do Marketplace", () => {
    const b = toMarketingBooking(row({ parkId: "px", origin: "API", commission: null }), ctx, { marketplace: true })!;
    expect(b).toMatchObject({ projectId: 30, marketplace: true, commission: null });
  });
  it("com a opção: parque de terceiros SEM cidade entra como 'Marketplace (sem cidade)' (sem centro) e com a etiqueta 'não operado'", () => {
    const b = toMarketingBooking(row({ parkId: "nc", origin: "API" }), ctx, { marketplace: true })!;
    expect(b).toMatchObject({ projectId: null, marketplace: true, operated: false });
    expect(unplacedMarketplaceParks(ctx)).toEqual([{ id: "nc", name: "Top Parking", city: "Albergaria", operated: false }]);
  });
  it("com a opção: nosso parque vindo pelo multipark.pt → Marketplace da cidade; o resto fica no parque", () => {
    expect(toMarketingBooking(row({ origin: "MARKETPLACE" }), ctx, { marketplace: true })).toMatchObject({ projectId: 20, marketplace: true, viaNet: true });
    expect(toMarketingBooking(row({ origin: "API" }), ctx, { marketplace: true })).toMatchObject({ projectId: 11, marketplace: false });
  });
  it("âmbito: filtro no Marketplace Lisboa lê os terceiros dele e os nossos da cidade só pelo Marketplace; os sem cidade só sem filtro", () => {
    expect(marketplaceParksFor(ctx, [20, 21])).toEqual({ third: ["rp"], marketplaceOnly: ["own"] });
    expect(marketplaceParksFor(ctx, [11])).toEqual({ third: [], marketplaceOnly: [] });
    // sem filtro nem âmbito: TODOS, incluindo o parque sem cidade (antes ficava de fora)
    expect(marketplaceParksFor(ctx)).toEqual({ third: ["rp", "px", "nc"], marketplaceOnly: [] });
    // com âmbito de cidade, uma reserva sem centro não se vê (como qualquer outra sem centro)
    expect(marketplaceParksFor(ctx, null, [20, 21, 30]).third).toEqual(["rp", "px"]);
  });
  it("resumo do Marketplace: operado / não operado / sem cidade", () => {
    const list = [
      toMarketingBooking(row({ parkId: "rp", total: 100 }), ctx, { marketplace: true })!,
      toMarketingBooking(row({ parkId: "nc", total: 40 }), ctx, { marketplace: true })!,
      toMarketingBooking(row({ origin: "MARKETPLACE", total: 60 }), ctx, { marketplace: true })!,
      toMarketingBooking(row({ origin: "API", total: 999 }), ctx, { marketplace: true })!,
    ];
    expect(summarizeMarketplace(list)).toEqual({
      bookings: 3, revenue: 200,
      operated: { bookings: 2, revenue: 160 }, notOperated: { bookings: 1, revenue: 40 }, withoutCity: { bookings: 1, revenue: 40 },
    });
  });
  it("ligado nos Anúncios, totais, Canais e clientes, ROAS por campanha e alertas", () => {
    expect(readFileSync("server/integrations/googleAds/marketingStats.ts", "utf8").match(/loadMarketingBookings\([^)]*\{ marketplace: true \}\)/g)?.length).toBe(2);
    expect(readFileSync("server/marketingCampaignRoas.ts", "utf8")).toMatch(/\{ marketplace: true \}/);
    expect(readFileSync("server/marketingAlertsService.ts", "utf8")).toMatch(/\{ marketplace: true \}/);
    // 8 out 2026: os Canais e clientes também (reservas e clientes)
    const ch = readFileSync("server/marketingChannels.ts", "utf8");
    expect(ch).toMatch(/loadMarketingBookings\([^)]*\{ marketplace: true \}\)/);
    expect(ch).toMatch(/loadMarketingClients\([^)]*\{ marketplace: true \}\)/);
    // a receita, a Caixa e o CRM continuam só com os parques nossos
    expect(readFileSync("server/finance/liveBookings.ts", "utf8")).toMatch(/if \(!ctx\.ourParks\.has\(r\.parkId\)\) continue;/);
  });
});
