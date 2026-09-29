import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("./client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./client")>();
  return { ...real, multiparkDbQuery: (...args: any[]) => queryMock(...args) };
});

import { MultiparkDbError, assertReadOnlySql } from "./client";
import {
  MAX_AGENT_IDS,
  buildAgentBookingPhasesSql,
  buildAgentHistoryAggSql,
  buildAgentIdsByNameSql,
  buildAgentMovementDetailSql,
  buildAgentNamesSql,
  buildAgentOccurrenceAggSql,
  buildAgentReviewAggSql,
  buildEngineActionCountsSql,
  buildEngineOccurrenceCountsSql,
  findAgentIdsByName,
  getAgentDayMovements,
  getAgentMovementSummaries,
  getEngineLiveInputs,
  mapAgentMovementRow,
  mapEngineActionCountRow,
  mergeAgentAggregates,
  movementWindow,
  opDaySql,
  opShiftSql,
  sumAgentSummaries,
  type AggregateFilters,
} from "./movements";
import { MOVEMENT_CHANGE_TYPES, movementLabel, movementPhase } from "../../shared/multiparkMovements";

const ENV = "DATABASE_URL_MULTIPARK";
let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env[ENV]; queryMock.mockReset(); });
afterEach(() => { if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv; });

const w = movementWindow("2026-09-01", "2026-09-28");
const f = (over: Partial<AggregateFilters> = {}): AggregateFilters => ({ window: w, byDay: false, ...over });

describe("janela e expressões", () => {
  it("dias operacionais de Lisboa → UTC (verão: 03h Lisboa = 02h UTC)", () => {
    expect(movementWindow("2026-09-10")).toEqual({ startDay: "2026-09-10", endDay: "2026-09-10", from: "2026-09-10 02:00:00", to: "2026-09-11 02:00:00" });
    expect(movementWindow("2026-01-10").from).toBe("2026-01-10 03:00:00");
    expect(() => movementWindow("2026-09-10", "2026-09-01")).toThrow();
    expect(() => movementWindow("10/09/2026")).toThrow();
  });

  it("dia e turno operacionais calculados no Postgres com o fuso de Lisboa", () => {
    expect(opDaySql(`h."actionTime"`)).toBe(`to_char(((h."actionTime") AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Lisbon' - interval '3 hours', 'YYYY-MM-DD')`);
    expect(opShiftSql("x.at")).toContain(">= 3 AND");
    expect(opShiftSql("x.at")).toContain("< 15 THEN 'morning' ELSE 'night'");
  });
});

describe("motor — contagens agregadas", () => {
  it("History com janela na coluna crua, sequência para trás e só conta de `from` em diante", () => {
    const { sql, params } = buildEngineActionCountsSql({ lookbackFrom: "2026-08-29 02:00:00", from: w.from, to: w.to });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`h."actionTime" >= $1::timestamp AND h."actionTime" < $2::timestamp`);
    expect(sql).toContain(`WHERE x.at >= $3::timestamp`);
    // levar ao parque: movimento logo a seguir a uma recolha, na mesma reserva
    expect(sql).toContain(`x.ct = 'MOVEMENT' AND x.prev_cat = 'CHECK_IN'`);
    expect(sql).toContain(`PARTITION BY h.booking_id, (h.ct IN ('CHECK_IN', 'CHECK_OUT', 'MOVEMENT', 'CANCEL'))`);
    // entrega atrasada: desde o 1.º pedido de entrega depois da entrega anterior
    expect(sql).toContain(`min(s.at) FILTER (WHERE s.ct = 'PENDING_CHECKOUT') OVER (PARTITION BY s.booking_id, s.deliveries_before)`);
    expect(sql).toMatch(/GROUP BY x\.user_id, 3, 4, x\.ct/);
    expect(params.slice(0, 5)).toEqual(["2026-08-29 02:00:00", w.to, w.from, 15, 600]);
  });

  it("linha → contagem", () => {
    expect(mapEngineActionCountRow({ user_id: "u1", agent_name: " Ana ", day: "2026-09-02", shift: "morning", change_type: "movement", n: "4", parking_moves: "1", late_deliveries: null }))
      .toEqual({ agentUserId: "u1", agentName: "Ana", day: "2026-09-02", shift: "morning", changeType: "MOVEMENT", n: 4, parkingMoves: 1, lateDeliveries: 0 });
    expect(mapEngineActionCountRow({ user_id: null, day: "2026-09-02", shift: "x", change_type: null, n: 1 }).shift).toBe("night");
  });

  it("ocorrências da app por agente e dia", () => {
    const { sql, params } = buildEngineOccurrenceCountsSql({ from: w.from, to: w.to });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`FROM "Occurrence" o`);
    expect(sql).toContain(`o."createdAt" >= $1::timestamp AND o."createdAt" < $2::timestamp`);
    expect(params.slice(0, 2)).toEqual([w.from, w.to]);
  });

  it("getEngineLiveInputs: duas leituras; sem BD → indisponível sem lançar", async () => {
    process.env[ENV] = "postgres://ro@db/mp";
    queryMock.mockResolvedValueOnce([{ user_id: "u1", agent_name: "Ana", day: "2026-09-02", shift: "night", change_type: "CHECK_IN", n: 2, parking_moves: 0, late_deliveries: 0 }]);
    queryMock.mockResolvedValueOnce([{ user_id: "u1", agent_name: "Ana", day: "2026-09-02", n: 1 }]);
    const r = await getEngineLiveInputs("2026-09-02", "2026-09-02");
    expect(r.available).toBe(true);
    if (r.available) {
      expect(r.data.actions).toHaveLength(1);
      expect(r.data.occurrences).toEqual([{ agentUserId: "u1", agentName: "Ana", day: "2026-09-02", n: 1 }]);
    }
    // a sequência começa 3 dias antes
    expect(queryMock.mock.calls[0][1][0]).toBe("2026-08-30 02:00:00");

    delete process.env[ENV];
    const off = await getEngineLiveInputs("2026-09-02", "2026-09-02");
    expect(off).toMatchObject({ available: false, code: "NOT_CONFIGURED" });

    process.env[ENV] = "postgres://ro@db/mp";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    queryMock.mockRejectedValueOnce(new MultiparkDbError("canceling statement due to statement timeout [57014]", "QUERY_FAILED"));
    expect(await getEngineLiveInputs("2026-09-02", "2026-09-02")).toMatchObject({ available: false, code: "TIMEOUT" });
    warn.mockRestore();
  });
});

describe("agregados por agente", () => {
  it("History: uma coluna por tipo, reservas, 1.ª/última ação, só leitura", () => {
    const { sql, params } = buildAgentHistoryAggSql(f());
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    for (const t of MOVEMENT_CHANGE_TYPES) expect(sql).toContain(`count(*) FILTER (WHERE h."changeType"::text = '${t}') AS t_${t.toLowerCase()}`);
    expect(sql).toContain(`count(DISTINCT h."bookingId") AS bookings`);
    expect(sql).toContain(`GROUP BY h."userId"\n`);
    expect(sql).toContain(`NULL AS day`);
    expect(params).toEqual([w.from, w.to, 10_000]);
  });

  it("por dia, com cidades e agentes — tudo parametrizado", () => {
    const evil = `x'); DROP TABLE "History"; --`;
    const { sql, params } = buildAgentHistoryAggSql(f({ byDay: true, cities: ["Lisboa"], userIds: ["u1", evil, "u1", " "] }));
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).not.toContain("DROP");
    expect(sql).toContain(`h."userId" IN ($3, $4)`);
    expect(sql).toContain(`lower(trim(p."city")) IN ($5, $6)`);
    expect(sql).toContain(`GROUP BY h."userId", 3`);
    expect(params).toEqual([w.from, w.to, "u1", evil, "lisboa", "lisbon", 10_000]);
  });

  it("âmbito vazio ou sem agentes → FALSE; ids limitados", () => {
    expect(buildAgentHistoryAggSql(f({ cities: [] })).sql).toContain("AND FALSE");
    expect(buildAgentHistoryAggSql(f({ userIds: [] })).sql).toContain("AND FALSE");
    const many = Array.from({ length: MAX_AGENT_IDS + 50 }, (_, i) => `u${i}`);
    expect(buildAgentHistoryAggSql(f({ userIds: many })).params).toHaveLength(2 + MAX_AGENT_IDS + 1);
  });

  it("fases assinadas na reserva, ocorrências e avaliações", () => {
    const phases = buildAgentBookingPhasesSql(f({ cities: ["Porto"] }));
    expect(phases.sql).toContain(`b."checkInDriverId" AS user_id, b."checkIn" AS at`);
    expect(phases.sql).toContain(`SELECT b."checkOutDriverId", b."checkOut"`);
    expect(phases.sql).toContain(`b."status"::text <> 'CANCELLED'`);
    const occ = buildAgentOccurrenceAggSql(f({ byDay: true }));
    expect(occ.sql).toContain(`o."resolvedById" IS NOT NULL AND o."resolvedAt" >= $1::timestamp`);
    expect(occ.sql).toContain(`GROUP BY x.user_id, 3`);
    const rev = buildAgentReviewAggSql(f({ userIds: ["u1"] }));
    expect(rev.sql).toContain(`FROM "BookingReview" r`);
    expect(rev.sql).toContain(`(VALUES (b."checkInDriverId"), (b."checkOutDriverId"))`);
    expect(rev.sql).toContain(`d.user_id IN ($3)`);
    for (const b of [phases, occ, rev, buildAgentNamesSql(["u1"]), buildAgentIdsByNameSql("Ana")]) expect(() => assertReadOnlySql(b.sql)).not.toThrow();
  });

  it("junta as leituras numa linha por agente (nome do Agent quando falta)", () => {
    const rows = mergeAgentAggregates({
      history: [{ user_id: "u1", agent_name: null, day: null, total: "9", t_check_in: 3, t_movement: 4, t_check_out: 2, spot_changes: 1, bookings: 5, first_at: "2026-09-02 07:00:00", last_at: "2026-09-02 18:30:00", platforms: "MOBILE,WEB" }],
      phases: [{ user_id: "u1", day: null, check_ins: 2, check_outs: 1 }, { user_id: "u2", day: null, check_ins: 1, check_outs: 0 }],
      occurrences: [{ user_id: "u1", agent_name: "Ana S.", day: null, created: 1, resolved: 2 }],
      reviews: [{ user_id: "u1", day: null, reviews: 2, avg_rating: "4.5", low_reviews: 0 }],
      names: [{ user_id: "u2", name: "Rui" }],
    });
    expect(rows).toHaveLength(2);
    const u1 = rows.find((r) => r.agentUserId === "u1")!;
    expect(u1).toMatchObject({
      agentName: "Ana S.", total: 9, recolhas: 3, movements: 4, entregas: 2, spotChanges: 1, bookings: 5,
      firstAt: "2026-09-02T07:00:00.000Z", lastAt: "2026-09-02T18:30:00.000Z", platforms: ["MOBILE", "WEB"],
      checkInsSigned: 2, checkOutsSigned: 1, occurrencesCreated: 1, occurrencesResolved: 2, reviews: 2, reviewAvg: 4.5,
    });
    expect(u1.byType).toEqual({ CHECK_IN: 3, MOVEMENT: 4, CHECK_OUT: 2 });
    expect(rows.find((r) => r.agentUserId === "u2")).toMatchObject({ agentName: "Rui", total: 0, checkInsSigned: 1 });
  });

  it("soma as contas de agente da mesma pessoa", () => {
    const [a, b] = mergeAgentAggregates({
      history: [
        { user_id: "u1", total: 3, t_check_in: 3, bookings: 3, first_at: "2026-09-02 09:00:00", last_at: "2026-09-02 10:00:00" },
        { user_id: "u9", total: 1, t_movement: 1, bookings: 1, first_at: "2026-09-02 08:00:00", last_at: "2026-09-02 08:00:00" },
      ],
      phases: [], occurrences: [],
      reviews: [{ user_id: "u1", reviews: 1, avg_rating: 5 }, { user_id: "u9", reviews: 3, avg_rating: 3 }],
    });
    const s = sumAgentSummaries([a, b])!;
    expect(s.agentUserIds.sort()).toEqual(["u1", "u9"]);
    expect(s).toMatchObject({ total: 4, recolhas: 3, movements: 1, bookings: 4, reviews: 4, reviewAvg: 3.5, firstAt: "2026-09-02T08:00:00.000Z", lastAt: "2026-09-02T10:00:00.000Z" });
    expect(sumAgentSummaries([])).toBeNull();
  });

  it("getAgentMovementSummaries: quatro leituras (+ nomes em falta) e degrada sem BD", async () => {
    process.env[ENV] = "postgres://ro@db/mp";
    queryMock
      .mockResolvedValueOnce([{ user_id: "u1", agent_name: null, total: 2, t_check_in: 2, bookings: 2 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ user_id: "u1", name: "Ana Silva" }]);
    const r = await getAgentMovementSummaries({ startDay: "2026-09-01", endDay: "2026-09-28", cities: ["Lisboa"] });
    expect(queryMock).toHaveBeenCalledTimes(5);
    expect(r.available && r.data[0].agentName).toBe("Ana Silva");
    for (const [sql] of queryMock.mock.calls) expect(() => assertReadOnlySql(sql)).not.toThrow();

    delete process.env[ENV];
    expect(await getAgentMovementSummaries({ startDay: "2026-09-01" })).toMatchObject({ available: false, code: "NOT_CONFIGURED" });
  });
});

describe("detalhe do dia", () => {
  it("lista ordenada, com LIMIT+1 e teto", () => {
    const { sql, params } = buildAgentMovementDetailSql({ window: movementWindow("2026-09-02"), userIds: ["u1"], cities: ["Faro"], limit: 5000 });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`ORDER BY h."actionTime", h."id"`);
    expect(sql).toContain(`h."userId" IN ($3)`);
    expect(params.at(-1)).toBe(1001);
    expect(buildAgentMovementDetailSql({ window: w, userIds: [] }).sql).toContain("AND FALSE");
  });

  it("linha → movimento e leitura com truncagem", async () => {
    expect(mapAgentMovementRow({ id: "h1", action_time: "2026-09-02 07:05:00", change_type: "check_in", user_id: "u1", booking_code: "A12", plate: "AA-00-BB" }))
      .toMatchObject({ id: "h1", actionTime: "2026-09-02T07:05:00.000Z", changeType: "CHECK_IN", bookingCode: "A12", plate: "AA-00-BB", parkName: null });
    process.env[ENV] = "postgres://ro@db/mp";
    queryMock.mockResolvedValueOnce([{ id: "1" }, { id: "2" }, { id: "3" }]);
    const r = await getAgentDayMovements({ day: "2026-09-02", userIds: ["u1"], limit: 2 });
    expect(r).toMatchObject({ available: true, data: { truncated: true } });
    expect(r.available && r.data.rows).toHaveLength(2);
    const none = await getAgentDayMovements({ day: "2026-09-02", userIds: [] });
    expect(none).toEqual({ available: true, data: { rows: [], truncated: false } });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("ids pelo nome do agente", async () => {
    process.env[ENV] = "postgres://ro@db/mp";
    queryMock.mockResolvedValueOnce([{ user_id: "u1" }, { user_id: null }]);
    expect(await findAgentIdsByName("  Ana SILVA ")).toEqual({ available: true, data: ["u1"] });
    expect(queryMock.mock.calls[0][1][0]).toBe("ana silva");
  });
});

describe("vocabulário", () => {
  it("rótulos e fases", () => {
    expect(movementLabel("check_in")).toBe("Recolha (check-in)");
    expect(movementLabel("XPTO")).toBe("XPTO");
    expect(movementPhase("PENDING_CHECKOUT")).toBe("checkout");
    expect(movementPhase("MOVEMENT")).toBe("move");
    expect(movementPhase(null)).toBe("other");
  });
});
