import { describe, expect, it } from "vitest";
import { compareBooking, eraRows, memoryMoments, worstSeverity, type LiveFinance } from "./rules";
import type { MemorySnapshot } from "../webhookMemory";

let seq = 0;
function snap(p: Partial<MemorySnapshot>): MemorySnapshot {
  seq++;
  return {
    id: seq, deliveryId: `d${seq}`, bookingId: "bk", eventType: "BOOKING_UPDATED", receivedAt: `2026-09-28T10:${String(seq).padStart(2, "0")}:00.000Z`,
    sourceUpdatedAt: null, parkId: "p1", status: "BOOKED", checkIn: null, checkOut: "2026-09-28T17:00:00.000Z",
    bookingPrice: null, originalBookingPrice: null, parkingPrice: null, deliveryPrice: null, discountAmount: null, discountApplied: null,
    paidAmount: null, paymentMethod: null, paymentSource: null, paymentBy: null, campaignId: null, partnerId: null, partnerAmountDue: null,
    partnerAmountPaid: null, partnerContributedAmount: null, pro: null, proClientId: null, cashierClosed: null, cashValidated: null, driverValidated: null,
    ...p,
  };
}
const no = { done: false, at: null, by: null };
function live(p: Partial<LiveFinance> = {}): LiveFinance {
  return {
    id: "bk", code: "123", parkId: "p1", parkName: "Airpark", status: "CHECKED_OUT", checkIn: null, checkOut: "2026-09-28T17:00:00.000Z",
    updatedAt: null, currency: "EUR", bookingPrice: 45, originalBookingPrice: 45, parkingPrice: null, deliveryPrice: null, discountAmount: null,
    discountApplied: null, paymentMethod: "Dinheiro", paymentSource: null, paymentBy: null, campaignId: null, partnerId: null, partnerAmountDue: null,
    partnerAmountPaid: null, partnerContributedAmount: null, pro: false, proClientId: null,
    linesCount: 1, linesTotal: 45, linesPaid: 45, paymentsCount: 1, paymentsTotal: 45, paymentMethods: ["Dinheiro"],
    cashierClosed: no, cashValidated: no, driverValidated: no,
    ...p,
  };
}
const codes = (d: { code: string }[]) => d.map((x) => x.code);

describe("regras de divergência (era / é)", () => {
  const created = snap({ eventType: "BOOKING_CREATED", status: "BOOKED", bookingPrice: 45, paymentMethod: "Dinheiro" });
  const checkedIn = snap({ status: "CHECKED_IN", bookingPrice: 45, paymentMethod: "Dinheiro" });

  it("tudo igual → sem divergências", () => {
    expect(compareBooking([created, checkedIn], live())).toEqual([]);
  });

  it("o teste do dono: preço tirado, reposto, e sai a 0 € com 30 € numa linha", () => {
    const d = compareBooking([created, checkedIn], live({ bookingPrice: 0, linesTotal: 30, linesPaid: 0, paymentsCount: 0, paymentsTotal: null, paymentMethods: [] }));
    expect(codes(d)).toContain("price_zeroed");
    expect(codes(d)).toContain("paid_mismatch");
    expect(d.find((x) => x.code === "price_zeroed")!.detail).toContain("45,00 €");
    expect(d.find((x) => x.code === "price_zeroed")!.detail).toContain("Nenhum webhook avisou");
  });

  it("preço mudou depois do check-in (alta) vs só depois da criação (média)", () => {
    const after = compareBooking([created, checkedIn], live({ bookingPrice: 30, linesTotal: 30, linesPaid: 30, paymentsTotal: 30 }));
    expect(codes(after)).toContain("price_after_checkin");
    expect(after.find((x) => x.code === "price_after_checkin")!.severity).toBe("high");
    const beforeCheckin = compareBooking([created, snap({ status: "BOOKED", bookingPrice: 30 })], live({ status: "BOOKED", bookingPrice: 30, linesTotal: 30 }));
    expect(codes(beforeCheckin)).toEqual(["price_after_creation"]);
    expect(beforeCheckin[0].detail).not.toContain("Nenhum webhook");
  });

  it("linhas retiradas ou baixadas", () => {
    const d = compareBooking([created, checkedIn], live({ linesTotal: 20, linesPaid: 20, paymentsTotal: 20 }));
    expect(codes(d)).toContain("lines_below");
    const none = compareBooking([created, checkedIn], live({ linesCount: 0, linesTotal: null, linesPaid: null }));
    expect(codes(none)).toContain("lines_below");
  });

  it("método de pagamento mudou (ou ficou vazio)", () => {
    expect(codes(compareBooking([created], live({ status: "BOOKED", paymentMethod: "Multibanco" })))).toEqual(["method_changed"]);
    expect(codes(compareBooking([created], live({ status: "BOOKED", paymentMethod: "dinheiro " })))).toEqual([]);
    expect(codes(compareBooking([created], live({ status: "BOOKED", paymentMethod: null })))).toEqual(["method_changed"]);
  });

  it("pago ≠ esperado só depois de sair e nunca em Pro", () => {
    expect(codes(compareBooking([created], live({ paymentsTotal: 40 })))).toEqual(["paid_mismatch"]);
    expect(codes(compareBooking([created], live({ paymentsTotal: 40, status: "CHECKED_IN" })))).toEqual([]);
    expect(codes(compareBooking([created], live({ paymentsTotal: 0, pro: true })))).toEqual([]);
    // sem pagamentos registados usa o "pago" das linhas
    expect(codes(compareBooking([created], live({ paymentsCount: 0, paymentsTotal: null, linesPaid: 45 })))).toEqual([]);
  });

  it("caixa fechada com divergência é crítica", () => {
    const d = compareBooking([created, checkedIn], live({ bookingPrice: 30, linesTotal: 30, linesPaid: 30, paymentsTotal: 30, cashierClosed: { done: true, at: "2026-09-28T20:00:00.000Z", by: "Rita" } }));
    expect(codes(d)).toContain("cashier_closed_with_divergence");
    expect(worstSeverity(d)).toBe("critical");
    expect(d.find((x) => x.code === "cashier_closed_with_divergence")!.detail).toContain("Rita");
    // caixa fechada sem divergências não aparece
    expect(compareBooking([created, checkedIn], live({ cashierClosed: { done: true, at: null, by: null } }))).toEqual([]);
  });

  it("só de um lado", () => {
    expect(codes(compareBooking([], live()))).toEqual(["only_live"]);
    expect(codes(compareBooking([], live({ status: "CANCELLED" })))).toEqual([]);
    expect(codes(compareBooking([created], null))).toEqual(["only_memory"]);
    expect(compareBooking([], null)).toEqual([]);
  });

  it("cancelada depois de entrar", () => {
    expect(codes(compareBooking([created, checkedIn], live({ status: "CANCELLED" })))).toContain("cancelled_after_checkin");
  });

  it("momentos: 1.º, check-in, último, último método e maior preço", () => {
    const m = memoryMoments([checkedIn, created, snap({ status: "CHECKED_OUT", bookingPrice: 50, paymentMethod: null })]);
    expect(m.first?.eventType).toBe("BOOKING_CREATED");
    expect(m.checkin?.status).toBe("CHECKED_IN");
    expect(m.last?.status).toBe("CHECKED_OUT");
    expect(m.lastMethod).toBe("Dinheiro");
    expect(m.maxPrice).toBe(50);
  });

  it("tabela era / é marca só o que mudou e o que o webhook não traz", () => {
    const rows = eraRows([created, checkedIn], live({ bookingPrice: 30 }));
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.bookingPrice.changed).toBe(true);
    expect(by.bookingPrice.first).toBe("45,00 €");
    expect(by.bookingPrice.live).toBe("30,00 €");
    expect(by.paymentMethod.changed).toBe(false);
    expect(by.discountAmount.notInWebhook).toBe(true);
    expect(by.discountAmount.changed).toBe(false);
  });
});
