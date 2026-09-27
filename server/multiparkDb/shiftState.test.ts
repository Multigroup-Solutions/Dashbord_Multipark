import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("./client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./client")>();
  return { ...real, multiparkDbQuery: (...args: any[]) => queryMock(...args) };
});

import { assertReadOnlySql } from "./client";
import {
  blocksForDay, buildBlocksSql, buildCashOpenSql, buildInParkSql, buildOpenOccurrencesSql, buildOperatingHoursSql, buildUpcomingSql,
  getMultiparkShiftState, hoursForDay, livePhaseOf, mapLiveCar, mapLiveUpcoming, summarizeInPark, weekdayOf,
} from "./shiftState";
import { cashWindowOf, draftPartsFromLive } from "../shiftHandoverDraft";

const ENV = "DATABASE_URL_MULTIPARK";
let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env[ENV]; queryMock.mockReset(); });
afterEach(() => { if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv; });

const NOW = Date.parse("2026-09-27T10:00:00Z");
const PARKS = [
  { id: "p1", name: "Airpark Lisboa", city: "Lisboa", firebase_brand: null, listing_type: "ON_PLATFORM", status: "ACTIVE" },
  { id: "p9", name: "Airpark Porto", city: "Porto", firebase_brand: null, listing_type: "ON_PLATFORM", status: "ACTIVE" },
];

describe("SQL do estado do parque", () => {
  it("todas as consultas são só de leitura, parametrizadas e com LIMIT", () => {
    const all = [
      buildInParkSql(["p1", "p2"]),
      buildUpcomingSql("checkin", ["p1"], NOW, NOW + 8 * 3_600_000),
      buildUpcomingSql("checkout", ["p1"], NOW, NOW + 8 * 3_600_000),
      buildOpenOccurrencesSql(["p1"]),
      buildCashOpenSql(["p1"], NOW - 3_600_000, NOW),
      buildBlocksSql(["p1"]),
      buildOperatingHoursSql(["p1"]),
    ];
    for (const q of all) {
      expect(() => assertReadOnlySql(q.sql)).not.toThrow();
      expect(q.sql).toMatch(/LIMIT/);
      expect(q.params).toContain("p1");
      expect(q.sql).not.toContain("'p1'");
    }
  });
  it("carros no parque: estados do parque e índice parkId+status", () => {
    const q = buildInParkSql(["p1", "p2"]);
    expect(q.sql).toContain(`b."parkId" IN ($1, $2)`);
    expect(q.sql).toContain(`'CHECKED_IN'`);
    expect(q.sql).toContain(`'PENDING_CHECKOUT'`);
    expect(q.sql).not.toContain(`'CHECKED_OUT'`);
  });
  it("próximas entregas: janela exata + pré-filtro com folga no checkOutDate, sem canceladas", () => {
    const q = buildUpcomingSql("checkout", ["p1"], NOW, NOW + 8 * 3_600_000);
    expect(q.params).toEqual(["p1", "2026-09-27 10:00:00", "2026-09-27 18:00:00", "2026-09-26 10:00:00", "2026-09-28 18:00:00", 1001]);
    expect(q.sql).toContain(`b."checkOutDate" >= $4::timestamp`);
    expect(q.sql).toContain(`b."returnFlightEta"`);
    expect(q.sql).toContain(`<> 'CANCELLED'`);
  });
  it("ocorrências: só por resolver", () => {
    expect(buildOpenOccurrencesSql(["p1"]).sql).toContain(`o."resolved" = false`);
  });
  it("caixa: só com fecho/validação em falta", () => {
    const q = buildCashOpenSql(["p1"], NOW - 3_600_000, NOW);
    expect(q.sql).toContain(`b."cashierClosed" = false`);
    expect(q.sql).toContain(`b."driverValidated" = false`);
  });
  it("sem parques → erro (a leitura não chega a correr)", () => {
    expect(() => buildInParkSql([])).toThrow();
  });
});

describe("mapeadores", () => {
  it("fase: malas e local de entrega dentro de PENDING_CHECKOUT", () => {
    expect(livePhaseOf({ status: "CHECKED_IN" })).toBe("in_park");
    expect(livePhaseOf({ status: "PENDING_CHECKOUT" })).toBe("pending_checkout");
    expect(livePhaseOf({ status: "PENDING_CHECKOUT", baggageWaitingAt: "2026-09-27T09:00:00.000Z" })).toBe("baggage_waiting");
    expect(livePhaseOf({ status: "PENDING_CHECKOUT", arrivedAtDeliveryAt: "2026-09-27T09:00:00.000Z" })).toBe("at_delivery");
    expect(livePhaseOf({ status: "MOVING" })).toBe("moving");
    expect(livePhaseOf({ status: "CHECKING_OUT" })).toBe("checking_out");
  });
  it("carro: garagem/lugar, coberto pela allocation, atrasado", () => {
    const c = mapLiveCar({ id: "b1", code: "15001", status: "CHECKED_IN", park_id: "p1", garage: "G1", spot: "A 12", plate: "AA-00-BB", client_first_name: "Ana", client_last_name: "Silva", check_out: "2026-09-27 08:00:00" }, { name: "Airpark Lisboa" }, NOW);
    expect(c).toMatchObject({ phase: "in_park", garage: "G1", spot: "A 12", covered: true, overdue: true, clientName: "Ana Silva", parkName: "Airpark Lisboa" });
    const d = mapLiveCar({ id: "b2", code: "10001", status: "PENDING_CHECKOUT", park_id: "p1", pending_checkout_at: "2026-09-27 09:30:00", parking_type: "UNCOVERED" }, undefined, NOW);
    expect(d).toMatchObject({ phase: "pending_checkout", phaseSince: "2026-09-27T09:30:00.000Z", covered: false, overdue: false });
  });
  it("próximas: por pagar e já feita", () => {
    const u = mapLiveUpcoming("checkout", { id: "b1", status: "CHECKED_IN", at: "2026-09-27 12:00:00", price: 50, paid: 20, flight: "TP123", flight_eta: "2026-09-27 11:20:00" }, undefined);
    expect(u).toMatchObject({ toPay: 30, done: false, flight: "TP123", flightEta: "2026-09-27T11:20:00.000Z" });
    expect(mapLiveUpcoming("checkin", { id: "b2", status: "CHECKED_IN" }, undefined).done).toBe(true);
    expect(mapLiveUpcoming("checkin", { id: "b3", status: "BOOKED" }, undefined).done).toBe(false);
  });
  it("resumo por parque → garagem", () => {
    const mk = (id: string, parkId: string, garage: string | null) => mapLiveCar({ id, status: "CHECKED_IN", park_id: parkId, garage }, undefined, NOW);
    const s = summarizeInPark([mk("1", "p1", "G1"), mk("2", "p1", "G1"), mk("3", "p1", null), mk("4", "p2", "X")], [{ id: "p1", name: "A" }, { id: "p2", name: "B" }, { id: "p3", name: "C" }]);
    expect(s).toEqual([
      { parkId: "p1", parkName: "A", total: 3, garages: [{ garage: "G1", count: 2 }, { garage: "Sem garagem", count: 1 }] },
      { parkId: "p2", parkName: "B", total: 1, garages: [{ garage: "X", count: 1 }] },
    ]);
  });
  it("bloqueios e horário do dia", () => {
    expect(weekdayOf("2026-09-28")).toBe(1); // segunda
    const rows = [
      { id: "a", park_id: "p1", scope: "ALL_DAYS", applies_to: "BOTH" },
      { id: "b", park_id: "p1", scope: "WEEKDAY", weekday: 1, applies_to: "CHECK_IN", start_time: "00:00", end_time: "06:00" },
      { id: "c", park_id: "p1", scope: "WEEKDAY", weekday: 2 },
      { id: "d", park_id: "p1", scope: "DATE", start_date: "2026-09-28" },
      { id: "e", park_id: "p1", scope: "DATE_RANGE", start_date: "2026-09-20", end_date: "2026-09-27" },
      { id: "f", park_id: "p1", scope: "DAY_OF_MONTH", day_of_month: 28 },
    ];
    expect(blocksForDay(rows, "2026-09-28", () => "Airpark").map((b) => b.id)).toEqual(["a", "b", "d", "f"]);
    const hours = hoursForDay([{ park_id: "p1", day: "MONDAY", open_time: "05:00", close_time: "23:00" }, { park_id: "p1", day: "Terça", open_time: "x", close_time: "y" }], "2026-09-28", () => "Airpark");
    expect(hours).toEqual([{ parkName: "Airpark", day: "MONDAY", openTime: "05:00", closeTime: "23:00" }]);
  });
});

describe("leitura (mock do multiparkDbQuery)", () => {
  it("sem DATABASE_URL_MULTIPARK → indisponível, sem consultas", async () => {
    delete process.env[ENV];
    const r = await getMultiparkShiftState({ cities: ["lisbon"], nowMs: NOW });
    expect(r.available).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("só os parques da cidade; junta tudo e bloqueios opcionais", async () => {
    process.env[ENV] = "postgres://u:p@h:5432/db";
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes(`FROM "Park"`)) return PARKS;
      if (sql.includes(`FROM "ParkAvailabilityBlock"`)) throw new Error("relation does not exist");
      if (sql.includes(`FROM "OperatingHours"`)) return [];
      if (sql.includes(`FROM "Occurrence"`)) return [{ id: "o1", title: "Vidro Aberto", priority: "HIGH", park_id: "p1", plate: "AA-00-BB" }];
      if (sql.includes(`"cashierClosed" = false`)) return [{ id: "b5", status: "CHECKED_OUT", park_id: "p1", cashier_closed: false, cash_validated: true, driver_validated: false }];
      if (sql.includes(`b."departingFlightEta"`)) return [{ id: "b7", status: "BOOKED", park_id: "p1", at: "2026-09-27 12:00:00" }];
      if (sql.includes(`b."checkOut" >=`)) return [];
      return [
        { id: "b1", status: "CHECKED_IN", park_id: "p1", garage: "G1", code: "15001", check_in: "2026-09-26 10:00:00" },
        { id: "b2", status: "PENDING_CHECKOUT", park_id: "p1", garage: "G1", pending_checkout_at: "2026-09-27 09:40:00", client_first_name: "Rui" },
      ];
    });
    const r = await getMultiparkShiftState({ cities: ["lisbon"], nowMs: NOW });
    expect(r.available).toBe(true);
    if (!r.available) return;
    const parkParams = queryMock.mock.calls.filter(([sql]) => !String(sql).includes(`FROM "Park"`)).map(([, params]) => params as unknown[]);
    for (const p of parkParams) { expect(p).toContain("p1"); expect(p).not.toContain("p9"); }
    expect(r.data.parks.map((p) => p.id)).toEqual(["p1"]);
    expect(r.data.inPark.total).toBe(2);
    expect(r.data.inPark.byPark[0].garages).toEqual([{ garage: "G1", count: 2 }]);
    expect(r.data.inProgress.map((c) => c.id)).toEqual(["b2"]);
    expect(r.data.upcoming.checkins.map((u) => u.id)).toEqual(["b7"]);
    expect(r.data.occurrences.list[0]).toMatchObject({ title: "Vidro Aberto", parkName: "Airpark Lisboa" });
    expect(r.data.cash).toMatchObject({ total: 1, notCashierClosed: 1, notCashValidated: 0, notDriverValidated: 1 });
    expect(r.data.blocks).toBeNull();
    expect(r.data.hours).toEqual([]);
    expect(r.data.blocksDay).toBe("2026-09-28");

    // O rascunho da passagem usa estas partes
    const parts = draftPartsFromLive(r.data);
    expect(parts.pendingDeliveries).toEqual([{ externalId: "b2", bookingNumber: null, plate: null, clientName: "Rui", since: "10:40" }]);
    expect(parts.ciRows[0].row).toMatchObject({ externalId: "b7", time: "13:00" });
    expect(parts.incidents[0]).toMatchObject({ id: "o1", severity: "high", plate: "AA-00-BB" });
    expect(parts.covered.find((c) => c.externalId === "b1")?.spotType).toBe("covered");
    expect(parts.summary).toMatchObject({ inPark: 2, inProgress: 1, cashNotClosed: 1, occurrencesOpen: 1, blocksTomorrow: null });
  });

  it("erro numa leitura obrigatória → indisponível (não lança)", async () => {
    process.env[ENV] = "postgres://u:p@h:5432/db";
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes(`FROM "Park"`)) return PARKS;
      throw new Error("canceling statement due to statement timeout");
    });
    const r = await getMultiparkShiftState({ cities: ["lisbon"], nowMs: NOW });
    expect(r).toMatchObject({ available: false, code: "TIMEOUT" });
  });

  it("cidade sem parques → estado vazio, só a leitura dos parques", async () => {
    process.env[ENV] = "postgres://u:p@h:5432/db";
    queryMock.mockResolvedValueOnce(PARKS);
    const r = await getMultiparkShiftState({ cities: ["faro"], nowMs: NOW });
    expect(r.available && r.data.parks).toEqual([]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe("janela da caixa do turno", () => {
  it("do início do turno até agora, nunca depois do fim nem antes do início", () => {
    const win = { startMs: 1000, endMs: 5000 };
    expect(cashWindowOf(win, 3000)).toEqual({ startMs: 1000, endMs: 3000 });
    expect(cashWindowOf(win, 9000)).toEqual({ startMs: 1000, endMs: 5000 });
    expect(cashWindowOf(win, 500)).toEqual({ startMs: 1000, endMs: 1000 });
  });
});
