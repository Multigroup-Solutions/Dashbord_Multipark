import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFinanceAggSql, buildTopDeliveredSql, mapFinanceAggRow, readFinanceAgg, type FinanceAggRow } from "../multiparkDb/financeAgg";
import { assertReadOnlySql } from "../multiparkDb/client";
import { buildOurParks, campaignOf, toLiveBookingAgg } from "./liveBookings";

const range = { start: "2026-07-31 23:00:00", end: "2026-08-31 23:00:00" };

describe("financeiro ao vivo: SQL na BD da Multipark", () => {
  it("entregues: CHECKED_OUT, saída no período (UTC) com folga no índice, só os parques pedidos, dia de Lisboa", () => {
    const { sql, params } = buildFinanceAggSql({ kind: "delivered", ...range, parkIds: ["pA", "pB"] });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`b."parkId" IN ($1, $2)`);
    expect(sql).toContain(`b."checkOutDate" >= `);
    expect(sql).toContain(`b."checkOut" >= `);
    expect(sql).toContain(`AT TIME ZONE 'Europe/Lisbon'`);
    expect(sql).toContain(`COALESCE(bp.total, d.price)`);
    expect(sql).toMatch(/LIMIT \$\d+$/);
    expect(params).toEqual(expect.arrayContaining(["pA", "pB", "CHECKED_OUT", range.start, range.end]));
    expect(sql).not.toContain("WHERE COALESCE(bp.paid, 0) > 0");
  });
  it("recolhidos pela entrada; previsão sem canceladas/entregues/pendentes e só estacionados ou que ainda entram", () => {
    const c = buildFinanceAggSql({ kind: "collected", ...range, parkIds: ["pA"] });
    expect(c.sql).toContain(`b."checkIn" >= `);
    expect(c.params).toEqual(expect.arrayContaining(["CHECKED_IN", "CHECKING_OUT", "PENDING_CHECKOUT", "CHECKED_OUT"]));
    const f = buildFinanceAggSql({ kind: "forecast", ...range, parkIds: ["pA"], todayStart: "2026-08-14 23:00:00" });
    expect(f.sql).toContain("NOT IN");
    expect(f.params).toEqual(expect.arrayContaining(["CANCELLED", "CHECKED_OUT", "PENDING", "2026-08-14 23:00:00"]));
    expect(() => buildFinanceAggSql({ kind: "forecast", ...range, parkIds: ["pA"] })).toThrow();
  });
  it("no-shows e canceladas: só as pagas; canceladas pela data do cancelamento", () => {
    const n = buildFinanceAggSql({ kind: "noshow", ...range, parkIds: ["pA"] });
    expect(n.sql).toContain(`b."status"::text = 'BOOKED'`);
    expect(n.sql).toContain("WHERE COALESCE(bp.paid, 0) > 0");
    const x = buildFinanceAggSql({ kind: "cancelled", ...range, parkIds: ["pA"] });
    expect(x.sql).toContain(`FROM "Cancellation" x`);
    expect(x.sql).toContain(`cx.at >= `);
    expect(() => assertReadOnlySql(x.sql)).not.toThrow();
  });
  it("qualquer estado com saída/entrada no período (Diagnóstico e relatório semanal); agrupa por estado e pro", () => {
    const o = buildFinanceAggSql({ kind: "checkout_any", ...range, parkIds: ["pA"] });
    expect(o.sql).toContain(`b."checkOut" >= `);
    expect(o.sql).not.toContain(`b."status"::text IN`);
    expect(o.sql).toContain("GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9");
    expect(o.sql).toContain(`COALESCE(b."discountApplied", b."discountAmount", 0) AS discount`);
    const i = buildFinanceAggSql({ kind: "checkin_any", ...range, parkIds: ["pA"] });
    expect(i.sql).toContain(`b."checkIn" >= `);
    expect(() => assertReadOnlySql(i.sql)).not.toThrow();
  });
  it("maiores reservas entregues: só leitura, LIMIT 20, parques pedidos", () => {
    const t = buildTopDeliveredSql({ ...range, parkIds: ["pA"] });
    expect(() => assertReadOnlySql(t.sql)).not.toThrow();
    expect(t.params).toEqual(expect.arrayContaining(["pA", "CHECKED_OUT", 20]));
    expect(() => buildTopDeliveredSql({ ...range, parkIds: [] })).toThrow();
  });
  it("sem parques não há leitura (nunca 'todos')", () => {
    expect(() => buildFinanceAggSql({ kind: "delivered", ...range, parkIds: [] })).toThrow();
  });
  it("mapeia a linha (números arredondados ao cêntimo, vazios a null)", async () => {
    const raw = { day: "2026-08-10", park_id: "pA", partner_id: "", partner_name: null, payment_method: "MB Way", campaign_name: "Verão", discount_code: "", n: "3", total: "150.004", parking: 120, delivery: 30, extras: null, paid: "100", remaining: "50", owing_n: "1", status: "CHECKED_OUT", pro: "t", discount: "5" };
    expect(mapFinanceAggRow(raw)).toEqual({ day: "2026-08-10", parkId: "pA", partnerId: null, partnerName: null, paymentMethod: "MB Way", campaignName: "Verão", discountCode: null, count: 3, total: 150, parking: 120, delivery: 30, extras: 0, paid: 100, remaining: 50, owingCount: 1, status: "CHECKED_OUT", pro: true, discount: 5 });
    const query = vi.fn(async () => [raw]) as any;
    expect(await readFinanceAgg({ kind: "delivered", ...range, parkIds: ["pA"] }, query)).toHaveLength(1);
  });
});

describe("financeiro ao vivo: parques, centros e campanha", () => {
  const parks = [
    { id: "pA", name: "Airpark Lisboa", city: "Lisboa", firebaseBrand: "airpark", listingType: null },
    { id: "pB", name: "Redpark Porto", city: "Porto", firebaseBrand: null, listingType: null },
    { id: "pX", name: "Outro Parque", city: "Lisboa", firebaseBrand: "outro", listingType: "MARKETPLACE" },
  ];
  const matcher = ({ parkName }: { parkName?: string | null }) => (parkName === "Airpark Lisboa" ? 10 : undefined);
  it("só os nossos parques; sem centro fica null", () => {
    const m = buildOurParks(parks, matcher);
    expect([...m.entries()]).toEqual([["pA", 10], ["pB", null]]);
  });
  const row = (o: Partial<FinanceAggRow>): FinanceAggRow => ({ day: "2026-08-10", parkId: "pA", partnerId: null, partnerName: null, paymentMethod: null, campaignName: null, discountCode: null, count: 1, total: 10, parking: 10, delivery: 0, extras: 0, paid: 10, remaining: 0, owingCount: 0, status: "CHECKED_OUT", pro: false, discount: 0, ...o });
  it("campanha: alias do parceiro, depois do método, senão nome do parceiro / código / campanha", () => {
    const aliases = new Map([["multipark_partner_id:p-1", "Agência X"], ["payment_method:parkvia", "Parkvia"]]);
    expect(campaignOf(row({ partnerId: "P-1" }), aliases)).toBe("Agência X");
    expect(campaignOf(row({ paymentMethod: "Parkvia" }), aliases)).toBe("Parkvia");
    expect(campaignOf(row({ partnerName: "Unknown User", discountCode: "VERAO10" }), aliases)).toBe("VERAO10");
    expect(campaignOf(row({ campaignName: "Black Friday" }), aliases)).toBe("Black Friday");
    expect(campaignOf(row({}), aliases)).toBeNull();
  });
  it("agregados do marketplace ficam de fora; os nossos levam centro e campanha", () => {
    const ctx = { ourParks: new Map<string, number | null>([["pA", 10], ["pB", null]]), aliases: new Map() };
    const out = toLiveBookingAgg([row({ parkId: "pA", campaignName: "C" }), row({ parkId: "pB" }), row({ parkId: "pX" })], ctx);
    expect(out.map((r) => [r.parkId, r.projectId, r.campaign])).toEqual([["pA", 10, "C"], ["pB", null, null]]);
  });
});

// ─── Caixa sobre os agregados ao vivo ────────────────────────────────────────
const liveByKind: Record<string, any[]> = {};
const calls: Array<{ kind: string; range: any }> = [];
vi.mock("../db", () => ({ resolveProjectIds: vi.fn(async (id: number) => [id]) }));
vi.mock("./liveBookings", async (orig) => {
  const m: any = await orig();
  return { ...m, loadLiveBookingAgg: vi.fn(async (kind: string, r: any) => { calls.push({ kind, range: r }); return liveByKind[kind] ?? []; }) };
});

describe("caixa ao vivo", () => {
  beforeEach(() => { for (const k of Object.keys(liveByKind)) delete liveByKind[k]; calls.length = 0; });
  const a = (o: any) => ({ day: "2026-08-10", projectId: 10, parkId: "pA", campaign: null, paymentMethod: null, count: 1, total: 0, parking: 0, delivery: 0, extras: 0, paid: 0, remaining: 0, owingCount: 0, ...o });
  it("recebido por dia e método, por cobrar, no-shows pagos e canceladas pagas", async () => {
    liveByKind.delivered = [
      a({ paymentMethod: "Dinheiro", count: 2, paid: 60, remaining: 10, owingCount: 1 }),
      a({ day: "2026-08-11", paymentMethod: null, count: 1, paid: 40 }),
      a({ day: "2026-08-11", paymentMethod: "Dinheiro", count: 1, paid: 5 }),
    ];
    liveByKind.noshow = [a({ count: 1, paid: 20 })];
    liveByKind.cancelled = [a({ count: 2, paid: 30 })];
    const { computeCash } = await import("./cash");
    const r = await computeCash({ from: "2026-08-01", to: "2026-08-31", today: "2026-08-15" });
    expect(r.received.total).toBe(105);
    expect(r.received.count).toBe(4);
    expect(r.received.byDay).toEqual([{ day: "2026-08-10", total: 60 }, { day: "2026-08-11", total: 45 }]);
    expect(r.received.byMethod).toEqual([{ method: "Dinheiro", total: 65, count: 3 }, { method: "Sem método", total: 40, count: 1 }]);
    expect(r.toCollect).toEqual({ total: 10, count: 1 });
    expect(r.prepaidNoShows).toEqual({ total: 20, count: 1 });
    expect(r.cancelledPaid).toEqual({ total: 30, count: 2 });
    // no-shows só até ao início de hoje (Lisboa)
    expect(calls.find((c) => c.kind === "noshow")!.range).toEqual({ start: "2026-07-31 23:00:00", end: "2026-08-14 23:00:00" });
  });
  it("período todo no futuro: não pede no-shows", async () => {
    const { computeCash } = await import("./cash");
    await computeCash({ from: "2026-09-01", to: "2026-09-30", today: "2026-08-15" });
    expect(calls.some((c) => c.kind === "noshow")).toBe(false);
  });
});
