import { describe, expect, it } from "vitest";
import { assertReadOnlySql, type SqlParam } from "./client";
import {
  addHistory, bookingPage, collectPrices, csvCell, emptyPriceState, historyPage,
  makePeriod, price, priceChanges, renderCsv, resultRow, type BookingRow, type HistoryRow,
} from "./initialBookingPrice";

const booking: BookingRow = {
  id: "b1", allocation: "123", park_id: "p1", park_name: "Parque", city: "Lisboa",
  created_at: "2026-05-01T00:00:00.000Z", status: "CANCELLED", currency: "EUR",
  current_price: 100, original_price_field: 80,
};
const history = (overrides: Partial<HistoryRow> = {}): HistoryRow => ({
  id: "h1", booking_id: "b1", change_type: "CREATED", action_time: "2026-05-01T00:00:00.000Z",
  snapshot_price: 45, modified_fields: "{}", ...overrides,
});
const calculate = (...rows: HistoryRow[]) => {
  const state = emptyPriceState();
  rows.forEach(row => addHistory(state, row));
  return resultRow(booking, state);
};
const period = makePeriod("2026-05-01", undefined, new Date("2026-09-29T12:00:00Z"));

describe("creation-price evidence", () => {
  it("uses CREATED, not the current or originalBookingPrice column", () => {
    const result = calculate(history());
    expect(result).toMatchObject({ booking_price_inicial: 45, verificacao: "CONFIRMADO_NO_CREATED",
      booking_price_atual: 100, original_booking_price_campo: 80, estado_reserva: "CANCELLED" });
  });
  it("preserves zero", () => {
    expect(calculate(history({ snapshot_price: 0 })).booking_price_inicial).toBe(0);
  });
  it("reads creation price from modifiedFields when the snapshot is missing", () => {
    expect(calculate(history({ snapshot_price: null, modified_fields: '{"bookingPrice":{"from":0,"to":45.5}}' }))
      .booking_price_inicial).toBe(45.5);
  });
  it("does not silently pick a value when the creation sources disagree", () => {
    expect(calculate(history({ modified_fields: '{"bookingPrice":{"to":55}}' })))
      .toMatchObject({ booking_price_inicial: null, verificacao: "CONFLITO_NO_CREATED" });
  });
  it("finds the earliest CREATED even when pages arrive in ID order", () => {
    const later = history({ id: "a", action_time: "2026-06-01T00:00:00.000Z", snapshot_price: 90 });
    expect(calculate(later, history())).toMatchObject({ booking_price_inicial: 45, registos_created: 2 });
  });
  it("does not replace an empty first CREATED with a later duplicate", () => {
    expect(calculate(history({ snapshot_price: null }), history({ id: "h2", action_time: "2026-05-02T00:00:00.000Z" })))
      .toMatchObject({ booking_price_inicial: null, verificacao: "CREATED_SEM_PRECO", primeiro_preco_observado: 45 });
  });
  it("flags conflicting same-time events in either input order", () => {
    const a = history();
    const b = history({ id: "h2", snapshot_price: 50 });
    for (const rows of [[a, b], [b, a]]) expect(calculate(...rows))
      .toMatchObject({ booking_price_inicial: null, verificacao: "CONFLITO_NO_CREATED" });
  });
  it("keeps a first-change before-value as an unconfirmed candidate", () => {
    expect(calculate(history({ change_type: "UPDATE", snapshot_price: 65,
      modified_fields: '{"bookingPrice":{"from":45,"to":65}}' })))
      .toMatchObject({ booking_price_inicial: null, verificacao: "SEM_REGISTO_CREATED",
        primeiro_preco_observado: 45, fonte_primeiro_preco: "modifiedFields.bookingPrice.from" });
  });
  it("returns reservations without history instead of dropping them", () => {
    expect(calculate()).toMatchObject({ booking_price_inicial: null, primeiro_preco_observado: null,
      verificacao: "SEM_HISTORICO", registos_historico: 0 });
  });
  it("does not turn invalid/missing values into zero or use the current price", () => {
    for (const value of [null, undefined, false, true, "", " ", "NaN", "12,50", "€12", Infinity, {}, []]) {
      expect(price(value)).toBeNull();
      expect(calculate(history({ snapshot_price: value, modified_fields: "{broken" })).booking_price_inicial).toBeNull();
    }
    expect(price("4.5e1")).toBe(45);
  });
  it.each([
    ['{"bookingPrice":{"oldValue":45,"newValue":50}}'],
    ['{"bookingPrice":[45,50]}'],
    ['[{"field":"status","to":"BOOKED"},{"field":"bookingPrice","from":45,"to":50}]'],
    ["bookingPrice: 45 -> 50"],
  ])("supports known changes format %s", raw => {
    expect(priceChanges(raw)).toEqual([{ from: 45, to: 50 }]);
  });
});

describe("selection and pagination", () => {
  it("starts at Lisbon midnight on May 1, not UTC midnight", () => {
    expect(period.startUtc).toBe("2026-04-30 23:00:00.000");
    expect(period.endUtc).toBe("2026-09-29 12:00:00.000");
    expect(makePeriod("2026-05-01", "2026-05-31", new Date("2026-09-29Z")).endUtc).toBe("2026-05-31 23:00:00.000");
  });
  it("rejects impossible and reversed dates", () => {
    expect(() => makePeriod("2026-02-30")).toThrow("Data inválida");
    expect(() => makePeriod("2026-05-01", "2026-04-30")).toThrow("anterior");
    expect(() => makePeriod("2026-13-01")).toThrow("Data inválida");
  });
  it("uses parameterised read-only queries, all statuses, and creation dates", () => {
    for (const q of [bookingPage(period, "id'quote", 2000), historyPage(period, "id'quote", 2000)]) {
      expect(() => assertReadOnlySql(q.sql)).not.toThrow();
      expect(q.sql).toContain('b."createdAt" >= $1::timestamp');
      expect(q.sql).not.toMatch(/checkIn|OFFSET|status.*=|id'quote/);
      expect(q.params[2]).toBe("id'quote");
    }
  });
  it("reads every history page and emits one row per reservation, including missing history", async () => {
    const replies = [
      [booking, { ...booking, id: "b2" }], [],
      [history({ id: "h1", change_type: "UPDATE", snapshot_price: 99, action_time: "2026-06-01T00:00:00.000Z" }),
        history({ id: "h2", change_type: "UPDATE", snapshot_price: 90, action_time: "2026-05-02T00:00:00.000Z" })],
      [history({ id: "h3" })],
    ];
    const calls: SqlParam[][] = [];
    const db = { async query<T>(_sql: string, params: SqlParam[] = []): Promise<T[]> { calls.push(params); return replies.shift() as T[]; } };
    const result = await collectPrices(db, period, 2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].booking_price_inicial).toBe(45);
    expect(result.rows[1].verificacao).toBe("SEM_HISTORICO");
    expect(result.histories).toBe(3);
    expect(calls.map(c => c[2])).toEqual(["", "b2", "", "h2"]);
    expect(replies).toHaveLength(0);
  });
  it("propagates page errors so a partial export cannot be called complete", async () => {
    let calls = 0;
    const db = { async query<T>(): Promise<T[]> { if (++calls === 1) return [booking] as T[]; throw new Error("DB indisponível"); } };
    await expect(collectPrices(db, period)).rejects.toThrow("DB indisponível");
  });
  it("avoids reading history for an empty cohort", async () => {
    let calls = 0;
    const result = await collectPrices({ async query<T>(): Promise<T[]> { calls++; return []; } }, period);
    expect(result.rows).toEqual([]);
    expect(calls).toBe(1);
  });
});

describe("CSV", () => {
  it("escapes quotes, separators, newlines and spreadsheet formulas", () => {
    expect(csvCell('A;"B"\nC')).toBe('"A;""B""\nC"');
    expect(csvCell("=HYPERLINK(1)")).toBe('"\'=HYPERLINK(1)"');
    expect(csvCell(-5)).toBe('"-5"');
    expect(csvCell(0)).toBe('"0"');
    expect(csvCell(null)).toBe('""');
    expect(renderCsv([])).toContain('"booking_price_inicial"');
    expect(renderCsv([calculate(history())])).toMatch(/^\uFEFF/);
  });
});
