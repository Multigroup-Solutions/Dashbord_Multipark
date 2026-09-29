import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copyRowToSnapshot, COPY_ERA_EVENT } from "../webhookMemory";
import { compareWithCopyEra, dayRow } from "../cashCheckRouter";
import type { LiveFinance } from "./rules";

const root = join(__dirname, "..", "..");
const no = { done: false, at: null, by: null };
function live(p: Partial<LiveFinance> = {}): LiveFinance {
  return {
    id: "bk", code: "123", parkId: "p1", parkName: "Airpark", status: "CHECKED_OUT", checkIn: null, checkOut: "2026-09-20T17:00:00.000Z",
    updatedAt: null, currency: "EUR", bookingPrice: 45, originalBookingPrice: 45, parkingPrice: null, deliveryPrice: null, discountAmount: null,
    discountApplied: null, paymentMethod: "Dinheiro", paymentSource: null, paymentBy: null, campaignId: null, partnerId: null, partnerAmountDue: null,
    partnerAmountPaid: null, partnerContributedAmount: null, pro: false, proClientId: null,
    linesCount: 1, linesTotal: 45, linesPaid: 45, paymentsCount: 1, paymentsTotal: 45, paymentMethods: ["Dinheiro"],
    cashierClosed: no, cashValidated: no, driverValidated: no,
    ...p,
  };
}
const copyRow = (o: Record<string, unknown> = {}) => ({
  externalId: "bk", status: "CHECKED_OUT", parkId: "p1", checkIn: "2026-09-18 08:00:00", checkOut: "2026-09-20 17:00:00", totalPrice: "60.00",
  totalPaid: "45.00", paymentMethod: "Dinheiro", pro: 0, partnerId: null, syncedAt: "2026-09-21 03:00:00", sourceUpdatedAt: "2026-09-20 17:05:00",
  rawBookingPrice: "45", rawOriginalBookingPrice: null, ...o,
});

describe("era de recurso: a cópia antiga (antes de 28/09)", () => {
  it("o preço vem do JSON original da reserva; sem ele, do totalPrice", () => {
    expect(copyRowToSnapshot(copyRow())).toMatchObject({ eventType: COPY_ERA_EVENT, bookingPrice: 45, paidAmount: 45, paymentMethod: "Dinheiro", source: "copia", checkOut: "2026-09-20T17:00:00.000Z" });
    expect(copyRowToSnapshot(copyRow({ rawBookingPrice: null })).bookingPrice).toBe(60);
  });
  it("sem webhooks usa a cópia e marca cada divergência; com webhooks ignora a cópia", () => {
    const copy = copyRowToSnapshot(copyRow({ rawBookingPrice: "80", paymentMethod: "Multibanco" }));
    const r = compareWithCopyEra([], copy, live());
    expect(r.divergences.map((d) => d.code)).toContain("method_changed");
    expect(r.divergences.every((d) => d.detail.startsWith("[cópia antiga"))).toBe(true);
    expect(r.divergences.some((d) => d.code === "only_live")).toBe(false);
    const row = dayRow(live(), r.era, r.divergences);
    expect(row).toMatchObject({ eraSource: "copia", webhooks: 0 });
    // Sem cópia: como antes ("só na Multipark").
    expect(compareWithCopyEra([], null, live()).divergences.map((d) => d.code)).toEqual(["only_live"]);
  });
  it("só na comparação a pedido: a varredura (casos) nunca usa a cópia", () => {
    expect(readFileSync(join(root, "server/cashSweep.ts"), "utf8")).not.toContain("listCopyEraForBookings");
    const src = readFileSync(join(root, "server/webhookMemory.ts"), "utf8");
    const i = src.indexOf("listCopyEraForBookings");
    expect(src.slice(i)).not.toMatch(/UPDATE|DELETE|INSERT/);
  });
});
