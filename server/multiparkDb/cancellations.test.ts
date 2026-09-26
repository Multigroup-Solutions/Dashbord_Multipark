import { describe, expect, it } from "vitest";
import { classify, lisbonRangeUtc, utcToLisbon, type OursRow, type TheirsRow } from "./cancellations";

const ours = (status: string): OursRow => ({
  id: "x", bookingNumber: null, status, park: null, city: null, checkIn: null, checkOut: null, createdAt: null,
  cancelledAt: null, cancelledAtApprox: false, detailErrorCode: null, totalPrice: null,
});
const theirs = (status: string): TheirsRow => ({
  id: "x", allocation: null, status, park: null, checkIn: null, checkOut: null, createdAt: null, updatedAt: null,
  cancelledAt: null, cancelType: null, refund: null, refunded: null, refundedAmount: null, price: null,
  cancelAgent: null, historyCancelAt: null,
});

describe("cancelamentos — datas", () => {
  it("dia de Lisboa no verão = 23:00 UTC da véspera", () => {
    expect(lisbonRangeUtc("2026-09-10", "2026-09-10")).toEqual({ start: "2026-09-09 23:00:00", end: "2026-09-10 23:00:00" });
  });
  it("atravessa a mudança de hora (25 out 2026)", () => {
    expect(lisbonRangeUtc("2026-10-24", "2026-10-25")).toEqual({ start: "2026-10-23 23:00:00", end: "2026-10-26 00:00:00" });
  });
  it("inverno = mesmo dia UTC", () => {
    expect(lisbonRangeUtc("2026-12-01", "2026-12-01")).toEqual({ start: "2026-12-01 00:00:00", end: "2026-12-02 00:00:00" });
  });
  it("rejeita datas inválidas", () => {
    expect(() => lisbonRangeUtc("10/09/2026", "2026-09-10")).toThrow();
    expect(() => lisbonRangeUtc("2026-09-11", "2026-09-10")).toThrow();
  });
  it("UTC → hora de Lisboa", () => {
    expect(utcToLisbon("2026-09-10 08:15:00")).toBe("2026-09-10 09:15");
    expect(utcToLisbon("2026-09-09 23:30:00")).toBe("2026-09-10 00:30");
    expect(utcToLisbon(null)).toBeNull();
  });
});

describe("cancelamentos — classificação", () => {
  it("cancelada no período dos dois lados", () => {
    expect(classify(ours("CANCELLED"), theirs("CANCELLED"), true, true)).toBe("cancelada_nos_dois");
  });
  it("nossa cancelada e a reserva já não existe deles", () => {
    expect(classify(ours("CANCELLED"), undefined, true, false)).toBe("so_nossa_desapareceu_deles");
  });
  it("nossa cancelada e deles ativa", () => {
    expect(classify(ours("CANCELLED"), theirs("BOOKED"), true, false)).toBe("so_nossa_ativa_deles");
  });
  it("nossa cancelada, deles cancelada noutro dia", () => {
    expect(classify(ours("CANCELLED"), theirs("CANCELLED"), true, false)).toBe("so_nossa_outra_data");
  });
  it("deles cancelada e nós sem a reserva", () => {
    expect(classify(undefined, theirs("CANCELLED"), false, true)).toBe("so_deles_falta_nossa");
  });
  it("deles cancelada e a nossa noutro estado", () => {
    expect(classify(ours("BOOKED"), theirs("CANCELLED"), false, true)).toBe("so_deles_nossa_nao_cancelada");
  });
  it("deles cancelada e a nossa cancelada noutro dia", () => {
    expect(classify(ours("CANCELLED"), theirs("CANCELLED"), false, true)).toBe("so_deles_nossa_outra_data");
  });
});
