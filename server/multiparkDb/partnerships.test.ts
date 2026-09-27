import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("./client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./client")>();
  return { ...real, multiparkDbQuery: (...args: any[]) => queryMock(...args) };
});

import { assertReadOnlySql } from "./client";
import { mapParks } from "./dayBookings";
import {
  buildParkTotalsSql, buildPartnerTotalsSql, groupLivePartners, hideLiveMoney, linkRecords, livePeriods, mapLiveParks, readPartnershipsLive,
} from "./partnerships";
import { buildPlansSql, buildProAccountsSql, buildProMonthsSql, hideProMoney, mapProLive, readProLive } from "./partnershipsPro";
import { MARKETPLACE_COMMISSION, marketplaceSplit } from "../../shared/marketplace";

const ENV = "DATABASE_URL_MULTIPARK";
let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env[ENV]; queryMock.mockReset(); });
afterEach(() => { if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv; });

const NOW = new Date("2026-09-27T12:00:00Z");
const per = livePeriods(NOW);
const parkRows = [
  { id: "pk-al", name: "Airpark Lisboa", city: "Lisboa", firebase_brand: "airpark", listing_type: "ON_PLATFORM", status: "ACTIVE" },
  { id: "pk-rp", name: "Redpark Porto", city: "Porto", firebase_brand: "redpark", status: "ACTIVE" },
  { id: "pk-x", name: "Parque do Zé", city: "Lisboa", status: "ACTIVE" },
];

describe("períodos (Lisboa)", () => {
  it("mês corrente e 12 meses, com limites UTC do verão/inverno", () => {
    expect(per.thisMonth).toBe("2026-09");
    expect(per.from12).toBe("2025-10");
    expect(per.monthStart).toBe("2026-08-31 23:00:00"); // 1 set 00:00 Lisboa (verão)
    expect(per.since12).toBe("2025-09-30 23:00:00");
    expect(per.until).toBe("2026-09-30 23:00:00");
    // fim do mês em UTC já é o mês seguinte em Lisboa
    expect(livePeriods(new Date("2026-01-31T23:30:00Z")).thisMonth).toBe("2026-01");
    expect(livePeriods(new Date("2026-03-31T23:30:00Z")).thisMonth).toBe("2026-04");
  });
});

describe("SQL", () => {
  it("todas as leituras passam na guarda só de leitura, com LIMIT e parâmetros", () => {
    const all = [
      buildPartnerTotalsSql(["pk-al"], per), buildParkTotalsSql(["pk-al", "pk-x"], per),
      buildProAccountsSql(["pk-al"]), buildPlansSql(["pk-al"]), buildProMonthsSql(["pk-al"], per),
    ];
    for (const b of all) {
      expect(() => assertReadOnlySql(b.sql)).not.toThrow();
      expect(b.sql).toMatch(/LIMIT \$\d+/);
      expect(b.sql).not.toContain("pk-al"); // ids só como parâmetro
    }
  });
  it("parceiros: nosso = partnerAmountDue; sem canceladas/pendentes; totais em SQL; só os parques pedidos", () => {
    const q = buildPartnerTotalsSql(["pk-al", "pk-rp"], per);
    expect(q.sql).toContain(`SUM(b."partnerAmountDue")`);
    expect(q.sql).toContain(`COALESCE(b."partnerContributedAmount", b."bookingPrice")`);
    expect(q.sql).toContain(`NOT IN ('CANCELLED', 'PENDING')`);
    expect(q.sql).toContain(`FILTER (WHERE`);
    expect(q.sql).toContain(`pa."parkId" IN ($4, $5)`);
    expect(q.params.slice(0, 5)).toEqual([per.since12, per.until, per.monthStart, "pk-al", "pk-rp"]);
  });
  it("parques de terceiros: só as reservas que nós levámos", () => {
    expect(buildParkTotalsSql(["pk-x"], per).sql).toContain(`(b."origin"::text = 'MARKETPLACE' OR COALESCE(b."commissionAmount", 0) > 0)`);
    expect(() => buildParkTotalsSql([], per)).toThrow();
  });
  it("pró e avenças: entrada e saída por mês de Lisboa; avença pela reserva com clientPlanId", () => {
    const s = buildProMonthsSql(["pk-al"], per).sql;
    expect(s).toContain(`'in' AS dir`);
    expect(s).toContain(`'out' AS dir`);
    expect(s).toContain(`AT TIME ZONE 'Europe/Lisbon'`);
    expect(s).toContain(`CASE WHEN b."clientPlanId" IS NOT NULL THEN 'plan' ELSE 'pro' END`);
  });
});

describe("mapeadores", () => {
  const parks = mapParks(parkRows);
  const ours = parks.filter((p) => p.ours);
  const rows = [
    { partner_id: "pa1", user_id: "u-parkos", park_id: "pk-al", name: "Parkos", partner_type: "AGGREGATOR", active: true, fee_type: "PERCENTAGE", fee_pct: 25, m_bookings: "3", m_value: "300", m_ours: "225", m_missing: "0", y_bookings: "40", y_value: "4000", y_ours: "2900", y_missing: "2" },
    { partner_id: "pa2", user_id: "u-parkos", park_id: "pk-rp", name: "Parkos", partner_type: "AGGREGATOR", active: false, fee_type: "PERCENTAGE", fee_pct: 30, m_bookings: "1", m_value: "100", m_ours: "70", m_missing: "0", y_bookings: "5", y_value: "500", y_ours: "350", y_missing: "0" },
    { partner_id: "pa3", user_id: "u-agencia", park_id: "pk-al", name: "Viagens Sol", partner_type: "AGENCY", active: true, fee_type: "FIXED", fee_fixed: 5, m_bookings: "0", y_bookings: "1", y_value: "50", y_ours: "45" },
    // parque que não é nosso: fica de fora
    { partner_id: "pa4", user_id: "u-x", park_id: "pk-x", name: "Outro", partner_type: "AGENCY", y_bookings: "9" },
  ];
  it("uma empresa por userId, com os totais somados e só nos nossos parques", () => {
    const g = groupLivePartners(rows, ours);
    expect(g.map((p) => p.userId)).toEqual(["u-parkos", "u-agencia"]);
    const parkos = g[0];
    expect(parkos).toMatchObject({ name: "Parkos", type: "AGGREGATOR", active: true });
    expect(parkos.parks.map((x) => [x.parkName, x.feePct])).toEqual([["Airpark Lisboa", 25], ["Redpark Porto", 30]]);
    expect(parkos.thisMonth).toEqual({ bookings: 4, value: 400, ours: 295, missing: 0 });
    expect(parkos.last12).toEqual({ bookings: 45, value: 4500, ours: 3250, missing: 2 });
    expect(g[1].parks[0]).toMatchObject({ feeType: "FIXED", feeFixed: 5 });
  });
  it("parques: nossos com todas as reservas; terceiros com a divisão 80/20 e a comissão gravada ao lado", () => {
    const r = mapLiveParks(parks, [
      { park_id: "pk-al", bookings: "10", value: "1000", partner_bookings: "4" },
      { park_id: "pk-x", bookings: "7", value: "700", sale_bookings: "2", sale_value: "250", sale_commission: "30" },
    ]);
    expect(r.ours.map((p) => p.id)).toEqual(["pk-al", "pk-rp"]);
    expect(r.ours[0]).toMatchObject({ bookings: 10, value: 1000, partnerBookings: 4, ourShare: null });
    expect(r.ours[1]).toMatchObject({ bookings: 0, value: 0 });
    expect(r.third).toEqual([expect.objectContaining({ id: "pk-x", bookings: 2, value: 250, ourShare: 50, parkShare: 200, commission: 30 })]);
  });
  it("ligação ao registo SÓ pelo id da Multipark (userId ou linha Partner), nunca pelo nome", () => {
    const g = groupLivePartners(rows, ours);
    const linked = linkRecords(g, [
      { id: 1, name: "Parkos", partnerType: "agregador", partnerStatus: "active", multiparkPartnerId: null },
      { id: 2, name: "Viagens Sol Lda", partnerType: "agencia_viagem", partnerStatus: "active", multiparkPartnerId: "PA3" },
    ]);
    expect(linked[0].record).toBeNull();
    expect(linked[1].record).toEqual({ id: 2, name: "Viagens Sol Lda", partnerType: "agencia_viagem", partnerStatus: "active" });
    expect(linkRecords(g, [{ id: 9, name: "x", partnerType: null, partnerStatus: null, multiparkPartnerId: "u-parkos" }])[0].record?.id).toBe(9);
  });
  it("sem totais financeiros: sem euros nem taxas", () => {
    const d = { partners: groupLivePartners(rows, ours), parks: mapLiveParks(parks, [{ park_id: "pk-x", sale_bookings: "1", sale_value: "100" }]) };
    const h = hideLiveMoney(d, false);
    expect(h.partners[0].thisMonth).toEqual({ bookings: 4, value: null, ours: null, missing: 0 });
    expect(h.partners[0].parks[0]).toMatchObject({ feeType: null, feePct: null, feeFixed: null });
    expect(h.parks.third[0]).toMatchObject({ bookings: 1, value: null, ourShare: null, parkShare: null, commission: null });
    expect(hideLiveMoney(d, true)).toBe(d);
  });
});

describe("marketplace", () => {
  it("20 % nosso, 80 % do parque (regra única)", () => {
    expect(MARKETPLACE_COMMISSION).toBe(0.2);
    expect(marketplaceSplit(123.45)).toEqual({ ours: 24.69, park: 98.76 });
    expect(marketplaceSplit(100, 0.25)).toEqual({ ours: 25, park: 75 });
    expect(marketplaceSplit(100, 7)).toEqual({ ours: 20, park: 80 }); // taxa inválida → a regra
  });
});

describe("pró e avenças (informativo)", () => {
  const parkName = new Map([["pk-al", "Airpark Lisboa"], ["pk-rp", "Redpark Porto"]]);
  const input = {
    accounts: [{ client_id: "cl-a", pro_name: "Pinto Lda", active: true, discount: 15, park_ids: "pk-al,pk-rp" }],
    plans: [{ plan_id: "cp-1", client_id: "cl-b", park_id: "pk-al", status: "ACTIVE", price: 90, cadence: "MONTHLY", allowance_name: "Mensal Lisboa", client_name: "Ana Sousa" }],
    months: [
      { kind: "pro", account: "cl-a", dir: "in", month: "2026-09", bookings: "2", value: "80" },
      { kind: "pro", account: "cl-a", dir: "out", month: "2026-09", bookings: "1", value: "40" },
      { kind: "pro", account: "cl-a", dir: "in", month: "2026-05", bookings: "3", value: "120" },
      { kind: "plan", account: "cp-1", dir: "in", month: "2026-08", bookings: "4", value: "0" },
      { kind: "pro", account: "cl-z", dir: "in", month: "2026-07", bookings: "1", value: "10" },
    ],
    parkName, thisMonth: "2026-09",
  };
  it("contas Pro e avenças, entradas/saídas por mês, este mês e 12 meses", () => {
    const r = mapProLive(input);
    expect(r.map((x) => `${x.kind}:${x.key}`)).toEqual(["pro:cl-a", "pro:cl-z", "plan:cp-1"]);
    const a = r[0];
    expect(a).toMatchObject({ name: "Pinto Lda", mpClientId: "cl-a", detail: "desconto 15 %", parks: ["Airpark Lisboa", "Redpark Porto"] });
    expect(a.thisMonth).toEqual({ inBookings: 2, inValue: 80, outBookings: 1, outValue: 40 });
    expect(a.last12).toEqual({ inBookings: 5, inValue: 200, outBookings: 1, outValue: 40 });
    expect(a.months.map((m) => m.month)).toEqual(["2026-09", "2026-05"]);
    expect(r[1]).toMatchObject({ name: "Pro sem registo ProClient", active: false });
    expect(r[2]).toMatchObject({ kind: "plan", mpClientId: "cl-b", name: "Ana Sousa", detail: "Mensal Lisboa · ACTIVE", price: 90, cadence: "MONTHLY", active: true });
    expect(r[2].last12.inBookings).toBe(4);
  });
  it("sem totais financeiros: sem euros nem preços", () => {
    const h = hideProMoney(mapProLive(input), false);
    expect(h[0].thisMonth).toEqual({ inBookings: 2, inValue: null, outBookings: 1, outValue: null });
    expect(h[0].months[0].inValue).toBeNull();
    expect(h[2].price).toBeNull();
  });
});

describe("leitura (com a BD simulada)", () => {
  it("sem DATABASE_URL_MULTIPARK → indisponível, sem consultas", async () => {
    delete process.env[ENV];
    expect(await readPartnershipsLive(undefined)).toMatchObject({ available: false, code: "NOT_CONFIGURED" });
    expect(await readProLive(undefined)).toMatchObject({ available: false, code: "NOT_CONFIGURED" });
    expect(queryMock).not.toHaveBeenCalled();
  });
  it("âmbito de cidade pelo Park.city: só os parques de Lisboa; parceiros só dos nossos", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock
      .mockResolvedValueOnce(parkRows)
      .mockResolvedValueOnce([{ partner_id: "pa1", user_id: "u1", park_id: "pk-al", name: "Parkos", partner_type: "AGGREGATOR", m_bookings: 1, y_bookings: 2 }])
      .mockResolvedValueOnce([{ park_id: "pk-x", sale_bookings: 1, sale_value: 100 }]);
    const r = await readPartnershipsLive(["Lisboa"], undefined, NOW);
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(queryMock.mock.calls[1][1]).toContain("pk-al");
    expect(queryMock.mock.calls[1][1]).not.toContain("pk-rp");
    expect(queryMock.mock.calls[2][1]).toEqual(expect.arrayContaining(["pk-al", "pk-x"]));
    expect(r.data.partners.map((p) => p.userId)).toEqual(["u1"]);
    expect(r.data.parks.third[0]).toMatchObject({ ourShare: 20, parkShare: 80 });
    expect(r.data).toMatchObject({ periods: { thisMonth: "2026-09" }, marketplaceRate: 0.2 });
  });
  it("erro na BD → indisponível (não lança)", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock.mockRejectedValueOnce(new Error("canceling statement due to statement timeout"));
    expect(await readPartnershipsLive(undefined)).toMatchObject({ available: false, code: "TIMEOUT" });
  });
  it("pró e avenças: três leituras só dos parques do âmbito", async () => {
    process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
    queryMock.mockResolvedValueOnce(parkRows).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const r = await readProLive(["Porto"], undefined, NOW);
    expect(r).toMatchObject({ available: true, data: { rows: [] } });
    expect(queryMock).toHaveBeenCalledTimes(4);
    for (const c of queryMock.mock.calls.slice(1)) expect(c[1]).toContain("pk-rp");
  });
});
