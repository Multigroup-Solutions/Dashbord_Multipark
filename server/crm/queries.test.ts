import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import { buildWhere, colorVariants, ruleSql } from "./queries";
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
  it("saída num dia = intervalo de Lisboa em UTC", () => {
    const q = compile(ruleSql({ field: "booking.checkOut", op: "on", value: "2026-09-10" }, { canSeeTotals: false })!);
    expect(q.sql).toContain("b.checkOut >=");
    expect(q.params).toContain("2026-09-09 23:00:00");
    expect(q.params).toContain("2026-09-10 23:00:00");
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
    expect(q.params).toEqual(expect.arrayContaining(["porto", "oporto"]));
    expect(q.params).not.toContain("faro");
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
  it("utilizador de cidade só vê fichas com reservas nos seus projetos", () => {
    const q = cityScope.run({ all: false, projectIds: [50, 65] } as any, () => compile(buildWhere({}, opts)));
    expect(q.sql).toContain("crm_booking_links");
    expect(q.params).toEqual(expect.arrayContaining([50, 65]));
    expect(compile(buildWhere({}, opts)).sql).not.toContain("crm_booking_links");
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
