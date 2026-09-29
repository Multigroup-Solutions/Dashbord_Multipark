import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildBookingIdsForFilterSql, buildCrmBatchSql, buildCrmBookingFactsSql, buildCrmFilterOptionsSql, buildGenericEmailsSql,
  buildUpcomingBookingsSql, mapCrmBatchRow, readCrmBookingFacts, type CrmBookingFact,
} from "../multiparkDb/crmLive";
import { assertReadOnlySql } from "../multiparkDb/client";
import { parksJsonOf, summarizeBookings } from "./summary";
import { parseCursor } from "./sync";
import { MIGRATION_0245_STATEMENTS } from "../migrations/migration_0245";

const parks = ["pA", "pB"];

describe("CRM fase 1: leituras ao vivo na BD da Multipark", () => {
  it("lote do crm-sync: cursor (updatedAt, id), 2 min de folga, só clientes nossos (parques nossos + vendas no marketplace), sem PENDING", () => {
    const { sql, params } = buildCrmBatchSql({ cursor: { at: "2026-09-01 10:00:00.123", id: "ck1" }, limit: 1500, ourParkIds: parks });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`(b."updatedAt", b."id") > ($1::timestamp, $2)`);
    expect(sql).toContain(`interval '2 minutes'`);
    expect(sql).toContain(`b."parkId" IN ($3, $4)`);
    expect(sql).toContain(`b."origin"::text = 'MARKETPLACE'`);
    expect(sql).toContain(`b."status"::text <> 'PENDING'`);
    expect(sql).toContain(`ORDER BY b."updatedAt", b."id"`);
    expect(params).toEqual(["2026-09-01 10:00:00.123", "ck1", "pA", "pB", 1500]);
  });
  it("sem parques nossos: só as vendas no marketplace", () => {
    expect(buildCrmBatchSql({ cursor: { at: "1970-01-01 00:00:00", id: "" }, limit: 10, ourParkIds: [] }).sql).toContain("(FALSE OR");
  });
  it("mapeia a linha do lote", () => {
    const r = mapCrmBatchRow({ id: "b1", first_name: "Ana", last_name: "", email: "ana@x.pt", phone: "912", pro: "t", seen_at: "2026-09-01 10:00:00", cursor_at: "2026-09-01 10:00:00.500" });
    expect(r).toMatchObject({ id: "b1", firstName: "Ana", lastName: null, pro: true, cursorAt: "2026-09-01 10:00:00.500" });
  });
  it("cursor com id de texto (Multipark) e milissegundos", () => {
    expect(parseCursor("2026-09-01 10:00:00.123|clx9abc")).toEqual({ at: "2026-09-01 10:00:00.123", id: "clx9abc" });
    expect(parseCursor(null)).toEqual({ at: "1970-01-01 00:00:00", id: "" });
  });
  it("factos das reservas por id (em blocos) e leituras de apoio, todas só leitura com LIMIT", async () => {
    const f = buildCrmBookingFactsSql(["a", "a", "b"]);
    expect(f.params).toEqual(["a", "b", 2]);
    expect(() => assertReadOnlySql(f.sql)).not.toThrow();
    expect(() => buildCrmBookingFactsSql([])).toThrow();
    for (const q of [
      buildGenericEmailsSql({ minNames: 5, ourParkIds: parks }),
      buildUpcomingBookingsSql({ days: 3, ourParkIds: parks }),
      buildCrmFilterOptionsSql(parks),
      buildBookingIdsForFilterSql({ kind: "date", col: "checkIn", from: "2026-09-01 00:00:00", to: "2026-09-02 00:00:00" }, parks),
      buildBookingIdsForFilterSql({ kind: "ref", value: "29484" }, parks),
    ]) {
      expect(() => assertReadOnlySql(q.sql)).not.toThrow();
      expect(q.sql).toMatch(/LIMIT/);
    }
    const query = vi.fn(async (_q: string, p: unknown[]) => p.slice(0, -1).map((id) => ({ id, status: "CHECKED_OUT", total: "10" })));
    const ids = Array.from({ length: 1500 }, (_, i) => `b${i}`);
    expect(await readCrmBookingFacts(ids, query as any)).toHaveLength(1500);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("CRM fase 1: resumo da ficha (nenhuma reserva copiada)", () => {
  const f = (o: Partial<CrmBookingFact>): CrmBookingFact => ({
    id: "b", code: null, status: "CHECKED_OUT", checkIn: "2026-05-01 10:00:00", checkOut: null, createdAt: null, cancelledAt: null,
    parkName: "Airpark Lisboa", city: "Lisboa", origin: "API", partnerId: null, partnerName: null, pro: false, plate: "AA-00-BB",
    flight: null, deliveryType: null, checkinAgent: null, checkoutAgent: null, paymentMethod: null, total: 50, paid: 50, remaining: 0, ...o,
  });
  it("contagens, gasto, datas, cidades, parques, canais, parceiros e carros", () => {
    const s = summarizeBookings([
      f({ id: "1", checkIn: "2026-01-10 08:00:00" }),
      f({ id: "2", checkIn: "2026-06-10 08:00:00", city: "Oporto", parkName: "Redpark Porto", origin: "MARKETPLACE", partnerId: "p1", partnerName: "Parkos", total: 30 }),
      f({ id: "3", status: "CANCELLED", checkIn: "2026-12-01 08:00:00", total: 99 }),
      f({ id: "4", status: "BOOKED", checkIn: "2026-12-20 08:00:00", pro: true, plate: "aa00bb" }),
    ], "2026-09-29 12:00:00");
    expect(s).toMatchObject({
      bookings: 4, cancelled: 1, completed: 2, upcoming: 1, partnerBookings: 2, totalSpent: 80,
      firstVisit: "2026-01-10 08:00:00", lastVisit: "2026-06-10 08:00:00", nextCheckIn: "2026-12-20 08:00:00",
      cities: "Lisboa,Porto", cityKeys: "lisboa,porto", channels: "API,MARKETPLACE", partners: "Parkos", anyPro: true,
      preferredPark: "Airpark Lisboa",
    });
    expect(s.plates.get("AA00BB")).toBe(4);
    expect(JSON.parse(parksJsonOf(s.parks)!)[0]).toEqual({ park: "Airpark Lisboa", city: "Lisboa", bookings: 3 });
  });
  it("sem reservas: tudo a zero", () => {
    expect(summarizeBookings([], "2026-09-29 12:00:00")).toMatchObject({ bookings: 0, totalSpent: null, cityKeys: null, preferredPark: null });
  });
});

describe("CRM fase 1: sem a cópia, consentimentos e migração", () => {
  it("o CRM (server/crm) já não lê multipark_bookings", () => {
    for (const f of ["sync.ts", "queries.ts", "scope.ts", "review.ts"]) {
      const src = readFileSync(join(__dirname, f), "utf8").split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l)).join("\n");
      expect(src, f).not.toMatch(/multipark_bookings|multiparkBookings/);
    }
  });
  it("consentimentos ligados por defeito para quem tem reservas; o que foi desligado à mão fica", () => {
    const src = readFileSync(join(__dirname, "sync.ts"), "utf8");
    expect(src).toContain("consentEmail = COALESCE(consentEmail, 1)");
    expect(src).toMatch(/bookings > 0 AND \(consentEmail IS NULL/);
  });
  it("migração 0245: só acrescenta colunas do resumo e preenche cityKeys a partir das cidades", () => {
    expect(MIGRATION_0245_STATEMENTS.filter((s) => s.startsWith("ALTER TABLE `crm_clients` ADD COLUMN"))).toHaveLength(3);
    expect(MIGRATION_0245_STATEMENTS.join("\n")).toContain("SET `cityKeys` = LOWER(`cities`) WHERE `cityKeys` IS NULL");
    expect(readFileSync(join(__dirname, "..", "db.ts"), "utf8")).toContain('import("./migrations/migration_0245")');
  });
});
