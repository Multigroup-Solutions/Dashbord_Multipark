/**
 * Jorge (8 out 2026): "Têm que aparecer TODAS as reservas feitas no
 * marketplace, seja de que parque for; depois nós é que pomos para onde tiver
 * de ser — se o parque é operado por nós temos uma comissão, se não é, temos
 * outra."
 *
 * Uma regra só para "é Marketplace", um resolvedor só para a cidade do
 * parque, a etiqueta "operado por nós / não operado", os Canais e clientes
 * com o Marketplace e a dupla comissão (parceiro + Marketplace) desfeita.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isMarketplaceBooking, operatedLabel } from "../shared/marketplace";
import { classifyBookingChannel, classifyPark, marketplaceOperated, resolveParkCity } from "../shared/multiparkParks";
import { cityKeyFromAddress, cityKeyFromPlace } from "../shared/city";
import { channelOf, parseFirstBooking } from "../shared/marketingChannels";
import { MARKETPLACE_COMMISSIONED_SQL, MARKETPLACE_ORIGIN_SQL, marketplaceBookingSql } from "./multiparkDb/marketplaceSql";
import { OUR_SALE as PARTNERS_OUR_SALE } from "./multiparkDb/partners";
import { OUR_SALE as PARTNERSHIPS_OUR_SALE, mapLiveParks, buildParkTotalsSql, livePeriods } from "./multiparkDb/partnerships";
import { buildPartnerBillingSql } from "./multiparkDb/partnerBilling";
import { buildMarketingClientsSql } from "./multiparkDb/marketingBookings";
import { channelPredicate, mapOpsListRow } from "./multiparkDb/opsLists";
import { ParamList } from "./multiparkDb/read";
import { assertReadOnlySql } from "./multiparkDb/client";
import { mapParks as mapDayParks } from "./multiparkDb/dayBookings";
import { mapParks as mapCrmParks, inCities } from "./multiparkDb/partners";
import { buildChannels, mixFromBookings } from "./marketingChannels";
import { toMarketingClient } from "./marketingLive";
import { marketplaceBaseByCity } from "./marketingBudgetRule";
import { dayBucketOf } from "../shared/reservasDoDia";

describe("regra única: é uma reserva do Marketplace?", () => {
  it("parque de terceiros: TODAS (qualquer origem); parque nosso: só a origem MARKETPLACE", () => {
    for (const origin of ["API", "MANUAL", "GENERAL_FORM", "PARTNER_API", null, "MARKETPLACE"]) {
      expect(isMarketplaceBooking({ parkOurs: false, origin })).toBe(true);
    }
    expect(isMarketplaceBooking({ parkOurs: true, origin: "MARKETPLACE" })).toBe(true);
    expect(isMarketplaceBooking({ parkOurs: true, origin: " marketplace " })).toBe(true);
    for (const origin of ["API", "MANUAL", "PARTNER_API", null]) expect(isMarketplaceBooking({ parkOurs: true, origin })).toBe(false);
  });
  it("o canal da contabilidade (Reservas do dia, Operações, Ficha) é a mesma regra", () => {
    for (const parkOurs of [true, false]) {
      for (const origin of ["API", "MARKETPLACE", "PARTNER_DASHBOARD", null]) {
        for (const partnerId of [null, "P1"]) {
          const ch = classifyBookingChannel({ parkOurs, origin, partnerId }).channel;
          expect(ch === "marketplace").toBe(isMarketplaceBooking({ parkOurs, origin }));
        }
      }
    }
    // o balde das Reservas do dia (42d) segue o canal
    expect(dayBucketOf({ ours: false, brand: null, origin: "API", paymentSource: null, partnerId: null })).toBe("marketplace");
    expect(dayBucketOf({ ours: true, brand: "airpark", origin: "MARKETPLACE", paymentSource: null, partnerId: "P1" })).toBe("marketplace");
    expect(dayBucketOf({ ours: true, brand: "airpark", origin: "API", paymentSource: null, partnerId: null })).toBe("airpark");
  });
  it("SQL: o mesmo fragmento nas Operações; o 'com comissão' é só um e não mudou (valores faturados iguais)", () => {
    expect(marketplaceBookingSql(`b."parkId" IN ($1)`)).toBe(`(NOT (b."parkId" IN ($1)) OR b."origin"::text = 'MARKETPLACE')`);
    expect(MARKETPLACE_ORIGIN_SQL).toBe(`b."origin"::text = 'MARKETPLACE'`);
    // exatamente a expressão que estava copiada em partners, partnerBilling, partnerships e marketingBookings
    expect(MARKETPLACE_COMMISSIONED_SQL).toBe(`(b."origin"::text = 'MARKETPLACE' OR COALESCE(b."commissionAmount", 0) > 0)`);
    expect(PARTNERS_OUR_SALE).toBe(MARKETPLACE_COMMISSIONED_SQL);
    expect(PARTNERSHIPS_OUR_SALE).toBe(MARKETPLACE_COMMISSIONED_SQL);
    const p = new ParamList();
    expect(channelPredicate("marketplace", ["p1"], p)).toBe(`(NOT (b."parkId" IN ($1)) OR b."origin"::text = $2)`);
    expect(p.values.slice(0, 2)).toEqual(["p1", "MARKETPLACE"]);
  });
  it("a expressão da comissão já não está copiada pelo servidor (só em marketplaceSql.ts)", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const full = join(dir, f);
        if (statSync(full).isDirectory()) { if (f !== "node_modules") walk(full); continue; }
        if (full.endsWith(".ts") && !full.endsWith(".test.ts")) files.push(full);
      }
    };
    walk("server");
    const copies = files.filter((f) => readFileSync(f, "utf8").includes(`COALESCE(b."commissionAmount", 0) > 0`));
    expect(copies.map((f) => f.replace(/\\/g, "/"))).toEqual(["server/multiparkDb/marketplaceSql.ts"]);
  });
});

describe("cidade dos parques: um só resolvedor", () => {
  it("terras à volta dos aeroportos", () => {
    expect(cityKeyFromPlace("Prior Velho")).toBe("lisboa");
    expect(cityKeyFromPlace("Moscavide")).toBe("lisboa");
    expect(cityKeyFromPlace("Portela")).toBe("lisboa");
    expect(cityKeyFromPlace("Maia")).toBe("porto");
    expect(cityKeyFromPlace("Pedras Rubras")).toBe("porto");
    expect(cityKeyFromPlace("Moreira da Maia")).toBe("porto");
    expect(cityKeyFromPlace("Gambelas")).toBe("faro");
    expect(cityKeyFromPlace("Portimão")).toBe("faro"); // nunca Porto
  });
  it("morada: a terra mais perto do fim", () => {
    expect(cityKeyFromAddress("Rua de Lisboa 10, 4470-000 Maia")).toBe("porto");
    expect(cityKeyFromAddress("Rua do Porto 3, 2685-000 Prior Velho")).toBe("lisboa");
    expect(cityKeyFromAddress("Av. da Liberdade, 1250 Lisbon")).toBe("lisboa");
    expect(cityKeyFromAddress("Calle Mayor 1, Madrid")).toBeNull();
    expect(cityKeyFromAddress(null)).toBeNull();
  });
  it("resolveParkCity: cidade → terra da cidade → (só com a cidade vazia) nome → morada", () => {
    expect(resolveParkCity({ city: "Lisboa" })).toEqual({ city: "lisboa", source: "city" });
    expect(resolveParkCity({ city: "Prior Velho" })).toEqual({ city: "lisboa", source: "place" });
    expect(resolveParkCity({ city: "Maia", name: "Redpark" })).toEqual({ city: "porto", source: "place" });
    expect(resolveParkCity({ city: "", name: "Skypark Faro" })).toEqual({ city: "faro", source: "name" });
    expect(resolveParkCity({ city: null, name: "Parque X", address: "Rua A, 2685 Prior Velho" })).toEqual({ city: "lisboa", source: "address" });
    // a cidade escrita manda: "Madrid" nunca é corrigida pelo nome
    expect(resolveParkCity({ city: "Madrid", name: "Airpark Lisboa" })).toEqual({ city: null, source: null });
  });
  it("parque nosso com 'Prior Velho', 'Maia' ou 'Moscavide' na cidade é NOSSO (antes passava a terceiros)", () => {
    expect(classifyPark({ name: "Airpark", city: "Prior Velho" })).toMatchObject({ ours: true, key: "airpark_lisboa", citySource: "place" });
    expect(classifyPark({ name: "Redpark", city: "Maia" })).toMatchObject({ ours: true, key: "redpark_porto" });
    expect(classifyPark({ name: "Skypark", city: "Moscavide" })).toMatchObject({ ours: true, key: "skypark_lisboa" });
    expect(classifyPark({ name: "Airpark", city: "Prior Velho" }).reason).toContain('Lisboa (terra da cidade "Prior Velho")');
    expect(classifyPark({ name: "Airpark Lisboa", city: "Madrid" }).ours).toBe(false);
  });
  it("Reservas do dia / Operações / Faturação: a morada vem no SQL dos parques e o âmbito vê a cidade reconhecida", () => {
    const rows = [
      { id: "pv", name: "Airpark", city: "Prior Velho", firebase_brand: "airpark", listing_type: null, status: "ACTIVE" },
      { id: "ad", name: "Parque Y", city: null, address: "Rua B, 4470 Maia", firebase_brand: null, listing_type: null, status: "ACTIVE" },
    ];
    const lx = mapDayParks(rows, ["Lisboa"]);
    expect(lx.map((p) => [p.id, p.ours, p.city])).toEqual([["pv", true, "lisboa"]]);
    expect(mapDayParks(rows, ["Porto"]).map((p) => p.id)).toEqual(["ad"]);
    const crm = mapCrmParks([{ id: "pv", name: "Boardingpark", city: "Prior Velho", address: "Rua C" }]);
    expect(crm[0]).toMatchObject({ ours: false, cityKey: "lisboa", operated: true });
    expect(inCities("Prior Velho", ["Lisboa"], "lisboa")).toBe(true);
    expect(inCities("Prior Velho", ["Porto"], "lisboa")).toBe(false);
  });
  it("orçamento do Marketplace pela cidade reconhecida; os sem cidade à parte (aviso)", () => {
    const r = marketplaceBaseByCity([
      { parkName: "Boardingpark", cityKey: "lisboa", commission: 50 },
      { parkName: "Parque Maia", cityKey: "porto", commission: 20 },
      { parkName: "Parque Perdido", cityKey: null, commission: 12.5 },
      { parkName: "Parque Perdido", cityKey: null, commission: 2.5 },
      { parkName: "Sem comissão", cityKey: null, commission: null },
    ]);
    expect([...r.byCity.entries()]).toEqual([["Lisboa", 50], ["Porto", 20]]);
    expect(r.withoutCity).toEqual({ base: 15, parks: ["Parque Perdido"] });
  });
});

describe("operado por nós / não operado (só etiqueta)", () => {
  it("nossos sempre; lista do dono e Definições → não operado; o resto → operado", () => {
    expect(marketplaceOperated({ name: "Airpark Lisboa", ours: true })).toBe(true);
    expect(marketplaceOperated({ name: "Top Parking", ours: false })).toBe(false);
    expect(marketplaceOperated({ name: "Top Parking Porto", ours: false })).toBe(false);
    expect(marketplaceOperated({ id: "x", name: "Readypark", ours: false })).toBe(true);
    expect(marketplaceOperated({ id: "x", name: "Readypark", ours: false }, ["x"])).toBe(false);
    expect(marketplaceOperated({ id: "x", name: "Readypark", ours: false }, new Set(["x"]))).toBe(false);
    expect(operatedLabel(true)).toBe("Operado por nós");
    expect(operatedLabel(false)).toBe("Não operado");
  });
  it("Operações: cada linha diz se o parque é operado", () => {
    const park = { id: "tp", name: "Top Parking", cityName: "Porto", ...classifyPark({ name: "Top Parking", city: "Porto" }) };
    const row = mapOpsListRow("reservas", { id: "b1", park_id: "tp", status: "BOOKED", origin: "API" }, park);
    expect(row).toMatchObject({ channel: "marketplace", operated: false });
    const rp = { id: "rp", name: "Readypark", cityName: "Lisboa", ...classifyPark({ name: "Readypark", city: "Lisboa" }) };
    expect(mapOpsListRow("reservas", { id: "b2", park_id: "rp", status: "BOOKED" }, rp).operated).toBe(true);
    expect(mapOpsListRow("reservas", { id: "b2", park_id: "rp", status: "BOOKED" }, rp, new Set(["rp"])).operated).toBe(false);
  });
});

describe("Parcerias: todas as reservas do Marketplace contadas; o dinheiro igual", () => {
  const parks = mapDayParks([
    { id: "pk-al", name: "Airpark Lisboa", city: "Lisboa" },
    { id: "pk-x", name: "Top Parking", city: "Porto" },
  ]);
  it("SQL conta as vindas pelo Marketplace; a comissão continua só das vendas com comissão", () => {
    const { sql } = buildParkTotalsSql(["pk-al", "pk-x"], livePeriods(new Date("2026-10-08T10:00:00Z")));
    expect(sql).toContain(`count(*) FILTER (WHERE b."status"::text NOT IN ('CANCELLED', 'PENDING') AND b."origin"::text = 'MARKETPLACE') AS mkt_bookings`);
    expect(sql).toContain(`SUM(b."commissionAmount") FILTER (WHERE b."status"::text NOT IN ('CANCELLED', 'PENDING') AND ${MARKETPLACE_COMMISSIONED_SQL}) AS sale_commission`);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  });
  it("terceiros: 'todas' = todas as reservas; valor/nosso/parque das com comissão; nossos: as pelo Marketplace", () => {
    const r = mapLiveParks(parks, [
      { park_id: "pk-al", bookings: "10", value: "1000", partner_bookings: "4", mkt_bookings: "3" },
      { park_id: "pk-x", bookings: "7", value: "700", sale_bookings: "2", sale_value: "250", sale_commission: "30" },
    ]);
    expect(r.ours[0]).toMatchObject({ bookings: 10, marketplaceBookings: 3, operated: true });
    expect(r.third[0]).toMatchObject({ marketplaceBookings: 7, bookings: 2, value: 250, ourShare: 30, parkShare: 220, operated: false });
  });
});

describe("dupla comissão: reserva do Marketplace com parceiro conta só no Marketplace", () => {
  const { sql } = buildPartnerBillingSql({ ourParks: ["pk-al"], thirdParks: ["pk-x"], start: "2026-09-01 00:00:00", end: "2026-10-01 00:00:00" });
  const part = (kind: string) => sql.split("UNION ALL").find((x) => x.includes(`'${kind}' AS kind`))!;
  it("'partner' tira as vindas pelo Marketplace; 'market_own' fica com elas", () => {
    expect(part("partner")).toContain(`AND NOT COALESCE(b."origin"::text = 'MARKETPLACE', false)`);
    expect(part("market_own")).toContain(`AND b."origin"::text = 'MARKETPLACE'`);
    expect(part("market_own")).not.toContain("NOT COALESCE");
    // terceiros: a comissão gravada nas vendas com comissão (igual a antes)
    expect(part("market")).toContain(`AND ${MARKETPLACE_COMMISSIONED_SQL}`);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  });
});

describe("Canais e clientes com o Marketplace", () => {
  it("canal: a reserva do Marketplace (terceiros, qualquer origem) é Marketplace", () => {
    const none = () => false;
    expect(channelOf({ origin: "API", marketplace: true }, none)).toBe("marketplace");
    expect(channelOf({ origin: "MANUAL", campaign: "Verão", marketplace: true }, () => true)).toBe("marketplace");
    expect(channelOf({ origin: "API" }, none)).toBe("site");
    expect(channelOf({ origin: "MARKETPLACE" }, none)).toBe("marketplace");
  });
  it("mix guarda a marca Marketplace e os canais contam-na (cliente novo → anúncios)", () => {
    const mix = mixFromBookings([
      { origin: "API", adAttribution: "unknown", campaign: null, newClient: true, hasEmail: true, total: 80, marketplace: true },
      { origin: "API", adAttribution: "unknown", campaign: null, newClient: true, hasEmail: true, total: 50, marketplace: false },
    ]);
    expect(mix).toHaveLength(2);
    const r = buildChannels(mix, [], { from: "2026-10-01", to: "2026-10-08" }, 0, () => undefined);
    const ads = r.groups.find((g) => g.key === "anuncios")!;
    expect(ads.channels.map((c) => [c.key, c.bookings, c.revenue])).toEqual([["marketplace", 1, 80], ["site", 1, 50]]);
  });
  it("cliente cuja 1.ª reserva foi num parque de terceiros entra pelo Marketplace", () => {
    const base = { clientKey: "k", firstAt: "2026-10-02 09:00:00", firstOrigin: "API", firstUrl: null, firstPartnerId: null, firstPartnerName: null, firstPaymentMethod: null, firstCampaignName: null, firstDiscountCode: null, bookings: 1, periodBookings: 1, value: 0 };
    const ctx = { ourParks: new Map([["own", 11]]) };
    expect(parseFirstBooking(toMarketingClient({ ...base, firstParkId: "third" }, new Map(), ctx).first)!.origin).toBe("MARKETPLACE");
    expect(parseFirstBooking(toMarketingClient({ ...base, firstParkId: "own" }, new Map(), ctx).first)!.origin).toBe("API");
    // sem contexto, como antes
    expect(parseFirstBooking(toMarketingClient({ ...base, firstParkId: "third" }, new Map()).first)!.origin).toBe("API");
  });
  it("SQL dos clientes: terceiros todos, 'só Marketplace' pela origem, e o parque da 1.ª reserva", () => {
    const { sql, params } = buildMarketingClientsSql({ start: "2026-10-01 00:00:00", end: "2026-10-08 00:00:00", internalDomains: [], parkIds: ["own"], marketplaceParkIds: ["third"], marketplaceOnlyParkIds: ["own2"] });
    expect(sql).toContain(`(b."parkId" IN ($1, $2) OR (b."parkId" IN ($3) AND b."origin"::text = 'MARKETPLACE'))`);
    expect(params.slice(0, 3)).toEqual(["own", "third", "own2"]);
    expect(sql).toContain("f.park_id AS first_park_id");
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(() => buildMarketingClientsSql({ start: "a", end: "b", internalDomains: [], parkIds: [], marketplaceParkIds: ["third"] })).not.toThrow();
    expect(() => buildMarketingClientsSql({ start: "a", end: "b", internalDomains: [], parkIds: [] })).toThrow();
  });
});
