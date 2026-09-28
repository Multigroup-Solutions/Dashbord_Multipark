import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ load: vi.fn(), overrides: vi.fn(), live: vi.fn(), memory: vi.fn(), timeline: vi.fn() }));
vi.mock("./cityAccess", async (original) => ({ ...(await original<object>()), loadCityAccess: f.load }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({ execute: async () => [[]] }),
  getUserPermissionOverrides: f.overrides,
}));
vi.mock("./multiparkDb/read", async (original) => ({
  ...(await original<object>()),
  safeMultiparkRead: async (_l: string, fn: () => Promise<unknown>) => ({ available: true, data: await fn() }),
}));
vi.mock("./multiparkDb/cashCheck", async (original) => ({ ...(await original<object>()), readLiveFinanceByIds: f.live }));
vi.mock("./multiparkDb/bookingFile", async (original) => ({ ...(await original<object>()), getBookingFileTimeline: f.timeline }));
vi.mock("./webhookMemory", async (original) => ({ ...(await original<object>()), listMemoryForBookings: f.memory }));

import { appRouter } from "./routers";
import { cashCheckAllowed } from "./cashCheck/access";
import { onlyMemoryDivergence, memoryCheckout } from "./cashCheckRouter";
import { buildLiveFinanceSql, mapLiveFinanceRow, BOOKING_MONEY_KEYS } from "./multiparkDb/cashCheck";
import { lisbonDayBounds } from "./multiparkDb/dayBookings";

const caller = (role = "super_admin") => appRouter.createCaller({ user: { id: 7, role }, req: { headers: {} }, res: {} } as any);

beforeEach(() => {
  vi.clearAllMocks();
  f.load.mockResolvedValue({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false });
  f.overrides.mockResolvedValue({});
  f.live.mockResolvedValue([mapLiveFinanceRow({ booking: { id: "bk", status: "CHECKED_OUT", bookingPrice: "0", paymentMethod: "Dinheiro" }, lines_n: 1, lines_total: 30, lines_paid: 0 })]);
  f.memory.mockResolvedValue(new Map([["bk", [{ id: 1, deliveryId: "d1", bookingId: "bk", eventType: "BOOKING_CREATED", receivedAt: "2026-09-27T10:00:00.000Z", status: "BOOKED", bookingPrice: 45, paymentMethod: "Dinheiro" }]]]));
  f.timeline.mockResolvedValue({ available: true, data: { entries: [
    { id: "h:1", at: "2026-09-28T14:02:00.000Z", who: "Agente X", kindLabel: "Alteração", platform: "PDA", source: "history", changes: [{ field: "bookingPrice", label: "Preço", from: "45", to: "0" }, { field: "remarks", label: "Notas", from: null, to: "x" }] },
    { id: "h:2", at: "2026-09-28T13:00:00.000Z", who: "Agente Y", kindLabel: "Alteração", platform: "PDA", source: "history", changes: [{ field: "spotId", label: "Lugar", from: "1", to: "2" }] },
  ], missing: [] } });
});

describe("conferência de caixa: quem pode", () => {
  it("porta = Faturação (ver) + totais financeiros", () => {
    expect(cashCheckAllowed({ id: 1, role: "super_admin" })).toBe(true);
    expect(cashCheckAllowed({ id: 1, role: "super_admin" }, { "finance.view_totals": "deny" })).toBe(false);
    expect(cashCheckAllowed({ id: 1, role: "admin" })).toBe(false);
    expect(cashCheckAllowed({ id: 1, role: "backoffice" }, { "finance.view_totals": "grant" })).toBe(false);
    expect(cashCheckAllowed(null)).toBe(false);
  });
  it("sem permissão: FORBIDDEN e nada é lido", async () => {
    for (const role of ["admin", "supervisor", "backoffice", "frontoffice"]) {
      await expect(caller(role).cashCheck.booking({ id: "bk" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).cashCheck.day({ parkIds: ["p1"], day: "2026-09-28" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await caller(role).cashCheck.access()).allowed).toBe(false);
    }
    f.overrides.mockResolvedValue({ "finance.view_totals": "deny" });
    await expect(caller().cashCheck.booking({ id: "bk" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.live).not.toHaveBeenCalled();
    expect(f.memory).not.toHaveBeenCalled();
  });
  it("com permissão: era / é, divergências e só as alterações de dinheiro da História", async () => {
    expect((await caller().cashCheck.access()).allowed).toBe(true);
    const r = await caller().cashCheck.booking({ id: "bk" });
    expect(r.divergences.map((d) => d.code)).toEqual(expect.arrayContaining(["price_zeroed", "paid_mismatch"]));
    expect(r.rows.find((x) => x.key === "bookingPrice")).toMatchObject({ first: "45,00 €", live: "0,00 €", changed: true });
    expect(r.history).toHaveLength(1);
    expect(r.history[0].changes).toEqual([{ field: "bookingPrice", label: "Preço", from: "45", to: "0" }]);
  });
});

describe("só na memória", () => {
  const b = lisbonDayBounds("2026-09-28");
  const ctx = { startMs: b.startMs, endMs: b.endMs, allowedParkIds: new Set(["p1"]) };
  it("apagada, mudou de dia ou de parque; na lista do dia não repete", () => {
    expect(onlyMemoryDivergence(null, 2, ctx)?.detail).toContain("já não devolve");
    const moved = mapLiveFinanceRow({ booking: { id: "bk", parkId: "p1", status: "BOOKED", checkOut: "2026-09-30 10:00:00" } });
    expect(onlyMemoryDivergence(moved, 1, ctx)?.detail).toContain("a saída agora é 2026-09-30 10:00");
    const otherPark = mapLiveFinanceRow({ booking: { id: "bk", parkId: "p2", checkOut: "2026-09-28 12:00:00" }, park_name: "Outro" });
    expect(onlyMemoryDivergence(otherPark, 1, ctx)?.detail).toContain("o parque agora é Outro");
    const same = mapLiveFinanceRow({ booking: { id: "bk", parkId: "p1", checkOut: "2026-09-28 12:00:00" } });
    expect(onlyMemoryDivergence(same, 1, ctx)).toBeNull();
  });
  it("a saída da memória é a do último retrato que a trouxe", () => {
    expect(memoryCheckout([
      { id: 1, receivedAt: "2026-09-27T10:00:00.000Z", checkOut: "2026-09-28T10:00:00.000Z" },
      { id: 2, receivedAt: "2026-09-27T11:00:00.000Z", checkOut: "2026-09-29T10:00:00.000Z" },
      { id: 3, receivedAt: "2026-09-27T12:00:00.000Z", checkOut: null },
    ] as any)).toBe("2026-09-29T10:00:00.000Z");
  });
});

describe("leitura ao vivo (SQL)", () => {
  it("saídas do dia: parametrizado, paginado por id, com LIMIT e âmbito de cidade", () => {
    const { sql, params } = buildLiveFinanceSql({ kind: "checkout", bounds: lisbonDayBounds("2026-09-28"), parkIds: ["p1", "p2"], after: "bk-9", limit: 101 }, ["Lisboa"]);
    expect(sql).toContain(`b."checkOut" >= $3::timestamp`);
    expect(sql).toMatch(/AND b\."id" > \$\d+/);
    expect(sql).toMatch(/LIMIT \$\d+/);
    expect(sql).toContain(`lower(trim(sp."city")) IN`);
    expect(sql).toContain(`"BookingPricingPayment"`);
    expect(params).toEqual(expect.arrayContaining(["p1", "p2", "bk-9", 101, "lisboa", "lisbon"]));
    expect(sql).not.toMatch(/'\s*p1\s*'/);
  });
  it("só os campos de dinheiro da Booking (nada pessoal)", () => {
    for (const k of ["taxNumber", "taxName", "clientId", "customerId", "checkinSignature", "remarks"]) expect(BOOKING_MONEY_KEYS as readonly string[]).not.toContain(k);
    const { sql } = buildLiveFinanceSql({ kind: "ids", ids: ["a"] });
    expect(sql).toContain("jsonb_each(to_jsonb(b))");
    expect(sql).not.toContain(`"Client"`);
  });
  it("mapeia linhas, pagamentos e caixa", () => {
    const l = mapLiveFinanceRow({
      booking: { id: "bk", bookingPrice: "45.5", pro: true, cashierClosed: true, cashierClosedAt: "2026-09-28 20:00:00", cashierClosedByName: "Rita" },
      lines_n: "2", lines_total: "45.50", lines_paid: "20", payments_n: 2, payments_total: "20", payment_methods: "Multibanco|Dinheiro",
    });
    expect(l).toMatchObject({ bookingPrice: 45.5, pro: true, linesCount: 2, linesTotal: 45.5, paymentsTotal: 20, paymentMethods: ["Dinheiro", "Multibanco"] });
    expect(l.cashierClosed).toEqual({ done: true, at: "2026-09-28T20:00:00.000Z", by: "Rita" });
  });
});
