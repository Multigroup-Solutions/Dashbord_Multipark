import { describe, expect, it } from "vitest";
import { bookingOwed, lisbonMonth, monthLabel, multiparkBookingUrl, multiparkProUrl, parseMpPeriodKey, summarizeLedger, type LedgerRowIn } from "../../shared/crmPro";

describe("Pro — meses", () => {
  it("mês de Lisboa (a BD grava UTC)", () => {
    expect(lisbonMonth("2026-08-31 23:30:00")).toBe("2026-09"); // verão: UTC+1
    expect(lisbonMonth("2026-12-31 23:30:00")).toBe("2026-12"); // inverno: UTC+0
    expect(lisbonMonth("2026-03-01T00:00:00.000Z")).toBe("2026-03");
    expect(lisbonMonth(null)).toBeNull();
    expect(lisbonMonth("lixo")).toBeNull();
  });
  it("período dos acertos da Multipark em vários formatos", () => {
    expect(parseMpPeriodKey("2026-08")).toBe("2026-08");
    expect(parseMpPeriodKey("2026-8")).toBe("2026-08");
    expect(parseMpPeriodKey("2026-08-01_2026-08-31")).toBe("2026-08");
    expect(parseMpPeriodKey("08/2026")).toBe("2026-08");
    expect(parseMpPeriodKey("202608")).toBe("2026-08");
    expect(parseMpPeriodKey("2026-13")).toBeNull();
    expect(parseMpPeriodKey("")).toBeNull();
  });
  it("rótulo do mês", () => {
    expect(monthLabel("2026-08")).toBe("agosto 2026");
  });
});

describe("Pro — o que cada reserva deve", () => {
  it("soma das linhas de preço (já com desconto); sem linhas, o preço da reserva", () => {
    expect(bookingOwed({ pricingLines: 3, pricingTotal: 85, bookingPrice: 100, paid: 0, cancelled: false })).toBe(85);
    expect(bookingOwed({ pricingLines: 0, pricingTotal: null, bookingPrice: 100, paid: 0, cancelled: false })).toBe(100);
  });
  it("cancelada não deixa dívida", () => {
    expect(bookingOwed({ pricingLines: 2, pricingTotal: 60, bookingPrice: 60, paid: 0, cancelled: true })).toBe(0);
    expect(bookingOwed({ pricingLines: 2, pricingTotal: 60, bookingPrice: 60, paid: 20, cancelled: true })).toBe(20);
  });
});

describe("Pro — resumo da conta corrente", () => {
  const now = new Date("2026-09-27T10:00:00Z");
  const rows: LedgerRowIn[] = [
    // julho: 2 reservas, pago a 22 ago
    { kind: "booking", entryAt: "2026-07-03 08:00:00", periodKey: "2026-07", debit: 600, credit: 0 },
    { kind: "booking", entryAt: "2026-07-20 08:00:00", periodKey: "2026-07", debit: 506, credit: 0 },
    { kind: "payment", entryAt: "2026-08-22 10:00:00", periodKey: "2026-07", debit: 0, credit: 1106, method: "transferência" },
    { kind: "settlement", entryAt: "2026-08-22 10:00:00", periodKey: "", mpPeriodKey: "2026-07", debit: 0, credit: 0, method: "transferência" },
    // agosto: por pagar
    { kind: "booking", entryAt: "2026-08-10 08:00:00", periodKey: "2026-08", debit: 1284.5, credit: 0 },
    // setembro: em curso
    { kind: "booking", entryAt: "2026-09-02 08:00:00", periodKey: "2026-09", debit: 312, credit: 0 },
    { kind: "booking", entryAt: "2026-09-15 08:00:00", periodKey: "2026-09", debit: 300, credit: 0 },
    // marca de cobrança online: não conta
    { kind: "online", entryAt: "2026-09-01 09:00:00", periodKey: "2026-08", debit: 0, credit: 0, infoAmount: 99 },
    // reserva que deixou de ser Pro: não conta
    { kind: "booking", entryAt: "2026-06-01 08:00:00", periodKey: "2026-06", debit: 50, credit: 0, goneAt: "2026-09-01 00:00:00" },
  ];
  const s = summarizeLedger(rows, now);
  it("saldo, em dívida e mês corrente", () => {
    expect(s.balance).toBe(1896.5);
    expect(s.due).toBe(1284.5);
    expect(s.dueMonths).toBe(1);
    expect(s.oldestDue).toBe("2026-08");
    expect(s.currentMonthDebit).toBe(612);
    expect(s.currentMonthBookings).toBe(2);
  });
  it("pago no ano, último pagamento e prazo médio (dias depois do fim do mês)", () => {
    expect(s.paidThisYear).toBe(1106);
    expect(s.lastPaidAt).toBe("2026-08-22 10:00:00");
    expect(s.avgPayDays).toBe(21); // 1 ago → 22 ago
  });
  it("estado de cada mês e acerto da Multipark", () => {
    const by = Object.fromEntries(s.months.map((m) => [m.periodKey, m]));
    expect(by["2026-07"]).toMatchObject({ status: "paid", pending: 0, settledAt: "2026-08-22 10:00:00", settledMethod: "transferência" });
    expect(by["2026-08"]).toMatchObject({ status: "due", pending: 1284.5 });
    expect(by["2026-09"]).toMatchObject({ status: "open", bookings: 2 });
    expect(by["2026-06"]).toBeUndefined();
    expect(s.months.map((m) => m.periodKey)).toEqual(["2026-09", "2026-08", "2026-07"]);
  });
  it("mês dado como pago pela Multipark não é dívida, mesmo com valor por lançar nas reservas", () => {
    const c = summarizeLedger([
      { kind: "booking", entryAt: "2026-06-02 08:00:00", periodKey: "2026-06", debit: 300, credit: 0 },
      { kind: "payment", entryAt: "2026-07-05 08:00:00", periodKey: "2026-06", debit: 0, credit: 250 },
      { kind: "settlement", entryAt: "2026-07-05 08:00:00", periodKey: "", mpPeriodKey: "2026-06", debit: 0, credit: 0, method: "TRANSFER" },
      // cobrança online concluída também dá o mês como pago
      { kind: "booking", entryAt: "2026-05-02 08:00:00", periodKey: "2026-05", debit: 80, credit: 0 },
      { kind: "online", entryAt: "2026-06-01 09:00:00", periodKey: "2026-05", debit: 0, credit: 0, infoAmount: 80, status: "COMPLETED" },
      // cobrança online falhada não
      { kind: "booking", entryAt: "2026-04-02 08:00:00", periodKey: "2026-04", debit: 40, credit: 0 },
      { kind: "online", entryAt: "2026-05-01 09:00:00", periodKey: "2026-04", debit: 0, credit: 0, infoAmount: 40, status: "FAILED" },
    ], now);
    const by = Object.fromEntries(c.months.map((m) => [m.periodKey, m]));
    expect(by["2026-06"]).toMatchObject({ status: "paid", settledGap: 50, pending: 50 });
    expect(by["2026-05"]).toMatchObject({ status: "paid", settledGap: 80, settledMethod: "cobrança online" });
    expect(by["2026-04"]).toMatchObject({ status: "due", settledAt: null });
    expect(c.due).toBe(40);
    expect(c.balance).toBe(170); // o saldo bruto não muda
  });
  it("correção negativa do pago entra no pago do ano, não no último pagamento", () => {
    const c = summarizeLedger([
      { kind: "booking", entryAt: "2026-07-01 08:00:00", periodKey: "2026-07", debit: 50, credit: 0 },
      { kind: "payment", entryAt: "2026-07-05 08:00:00", periodKey: "2026-07", debit: 0, credit: 50 },
      { kind: "paid_undated", entryAt: "2026-07-03 08:00:00", periodKey: "2026-07", debit: 0, credit: -20 },
    ], now);
    expect(c.paidThisYear).toBe(30);
    expect(c.lastPaidAt).toBe("2026-07-05 08:00:00");
    expect(c.due).toBe(20);
  });
  it("pago a mais fica como crédito", () => {
    const c = summarizeLedger([
      { kind: "booking", entryAt: "2026-05-02 08:00:00", periodKey: "2026-05", debit: 100, credit: 0 },
      { kind: "payment", entryAt: "2026-06-05 08:00:00", periodKey: "2026-05", debit: 0, credit: 120 },
    ], now);
    expect(c.months[0].status).toBe("credit");
    expect(c.balance).toBe(-20);
    expect(c.due).toBe(0);
  });
});

describe("Pro — links para a Multipark", () => {
  it("domínio multipark.pt e caminhos da app de agentes", () => {
    expect(multiparkProUrl("cl1")).toBe("https://multipark.pt/pt-PT/agent/pros/cl1");
    expect(multiparkBookingUrl("bk 1")).toBe("https://multipark.pt/pt-PT/agent/booking/bk%201");
  });
});
