import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import { buildWhere, colorVariants, liveDateRange, ruleSql, searchCond } from "./queries";
import { cityScope } from "../cityScope";
import { citiesOfCountry, citiesOfRegion, cityAliases, countryFromPhone, parseParks } from "../../shared/crmGeo";

const compile = (s: SQL) => new MySqlDialect().sqlToQuery(s);
const opts = { vipThreshold: 500, canSeeTotals: true };

describe("CRM — cores", () => {
  it("vermelho encontra também red/bordeaux", () => {
    expect(colorVariants("Vermelho")).toEqual(expect.arrayContaining(["vermelho", "red", "bordeaux"]));
    expect(colorVariants("prata")).toContain("silver");
    expect(colorVariants("fúcsia")).toEqual(["fúcsia"]);
  });
});

describe("CRM — regras", () => {
  it("gasto total só para quem vê totais", () => {
    expect(ruleSql({ field: "client.totalSpent", op: "gte", value: 100 }, { canSeeTotals: false })).toBeNull();
    expect(ruleSql({ field: "client.totalSpent", op: "gte", value: 100 }, { canSeeTotals: true })).not.toBeNull();
  });
  it("saída num dia = intervalo de Lisboa em UTC; as fichas vêm da Multipark ao vivo", () => {
    expect(liveDateRange("on", "2026-09-10")).toEqual({ from: "2026-09-09 23:00:00", to: "2026-09-10 23:00:00" });
    expect(liveDateRange("before", "2026-09-10")).toEqual({ to: "2026-09-09 23:00:00" });
    // sem resultado da leitura ao vivo → nenhuma ficha; com resultado → essas fichas
    expect(compile(ruleSql({ field: "booking.checkOut", op: "on", value: "2026-09-10" }, { canSeeTotals: false })!).sql).toBe("1 = 0");
    const q = compile(ruleSql({ field: "booking.checkOut", op: "on", value: "2026-09-10" }, { canSeeTotals: false }, [7, 9])!);
    expect(q.sql).toBe("c.id IN (?, ?)");
    expect(q.params).toEqual([7, 9]);
  });
  it("parque da reserva: pelo resumo da ficha (parksJson)", () => {
    const q = compile(ruleSql({ field: "booking.park", op: "is", value: "Airpark Lisboa" }, { canSeeTotals: false })!);
    expect(q.sql).toContain("c.parksJson LIKE ?");
    expect(q.params[0]).toBe('%"park":"Airpark Lisboa"%');
  });
  it("valores inválidos não geram filtro", () => {
    expect(ruleSql({ field: "booking.checkIn", op: "on", value: "10/09" }, { canSeeTotals: false })).toBeNull();
    expect(ruleSql({ field: "vehicle.color", op: "is", value: "" }, { canSeeTotals: false })).toBeNull();
    expect(ruleSql({ field: "campo.inexistente", op: "is", value: "x" }, { canSeeTotals: true })).toBeNull();
  });
});

describe("CRM — filtros de grupo e pesquisa", () => {
  it("cidade, região e país passam pelos nomes que as reservas trazem", () => {
    expect(cityAliases(["Lisboa"])).toEqual(expect.arrayContaining(["lisboa", "lisbon"]));
    expect(citiesOfRegion("Algarve")).toEqual(["faro"]);
    expect(citiesOfCountry("PT")).toEqual(expect.arrayContaining(["lisbon", "porto", "faro"]));
    const q = compile(buildWhere({ groups: { region: ["Norte"] } }, opts));
    expect(q.sql).toContain("CONCAT(',', COALESCE(c.cityKeys, ''), ',') LIKE ?");
    expect(q.params).toEqual(expect.arrayContaining(["%,porto,%", "%,oporto,%"]));
    expect(q.params).not.toContain("%,faro,%");
  });
  it("n.º de cliente pesquisa pelo id", () => {
    const q = compile(buildWhere({ search: { text: "10482", field: "number" } }, opts));
    expect(q.sql).toContain("c.id = ?");
    expect(q.params).toContain(10482);
  });
  it("pesquisa num campo sem sentido não devolve tudo", () => {
    const q = compile(buildWhere({ search: { text: "ab", field: "phone" } }, opts));
    expect(q.sql).toContain("1 = 0");
  });
  it("separador Pro inclui empresas", () => {
    expect(compile(buildWhere({ tab: "pro" }, opts)).sql).toContain("c.isPro = 1 OR c.kind = 'company'");
  });
  it("utilizador de cidade só vê fichas com reservas nas suas cidades (resumo cityKeys) ou criadas à mão sem reservas", () => {
    const q = cityScope.run({ all: false, projectIds: [50, 65], cityNames: ["Porto"] } as any, () => compile(buildWhere({}, opts)));
    expect(q.sql).toContain("sc.cityKeys");
    expect(q.sql).toContain("sc.bookings = 0 AND sc.source <> 'bookings'");
    expect(q.params).toEqual(expect.arrayContaining(["%,porto,%", "%,oporto,%"]));
    expect(q.sql).not.toContain("multipark_bookings");
    expect(compile(buildWhere({}, opts)).sql).not.toContain("sc.cityKeys");
  });
  it("canal e parceiro: pelo resumo da ficha; n.º de reserva: fichas vindas da Multipark", () => {
    const q = compile(buildWhere({ groups: { channel: ["MARKETPLACE"], partner: ["Parkos"] } }, opts));
    expect(q.params).toEqual(expect.arrayContaining(["%,MARKETPLACE,%", "%|Parkos|%"]));
    expect(compile(buildWhere({ search: { text: "12345", field: "booking" } }, opts)).sql).toContain("1 = 0");
    const r = compile(buildWhere({ search: { text: "12345", field: "booking" } }, { ...opts, live: { rules: new Map(), bookingSearch: [3] } }));
    expect(r.params).toContain(3);
  });
  it("fichas da carga sem reservas (lote interrompido) não aparecem", () => {
    expect(compile(buildWhere({}, opts)).sql).toContain("(c.bookings > 0 OR c.source <> 'bookings')");
  });
  it("VIP sem limiar (quem não vê totais) não filtra nada", () => {
    expect(compile(buildWhere({ groups: { segment: ["vip"] } }, { vipThreshold: null, canSeeTotals: false })).sql).toContain("1 = 0");
  });
  it("qualquer campo junta nome, email, telefone, matrícula, NIF e n.º", () => {
    const c = searchCond("all", "912345678")!;
    const q = compile(c);
    expect(q.sql).toContain("crm_client_phones");
    expect(q.sql).toContain("c.id = ?");
    expect(searchCond("phone", "ab")).toBeNull();
    expect(searchCond("name", "   ")).toBeNull();
  });
});

describe("CRM — geografia do cliente", () => {
  it("país pelo indicativo", () => {
    expect(countryFromPhone("+351912345678")).toBe("PT");
    expect(countryFromPhone("+34612345678")).toBe("ES");
    expect(countryFromPhone(null)).toBeNull();
  });
  it("parques usados vêm ordenados e tolera lixo", () => {
    expect(parseParks("not json")).toEqual([]);
    expect(parseParks(JSON.stringify([{ park: "Airpark Lisboa", city: "lisbon", bookings: 3 }]))[0]).toMatchObject({ park: "Airpark Lisboa", bookings: 3 });
  });
});
