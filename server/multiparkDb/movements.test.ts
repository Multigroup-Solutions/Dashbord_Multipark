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
  movementKindSql,
  scheduledCheckOutTextSql,
  movementWindow,
  opDaySql,
  opShiftSql,
  sumAgentSummaries,
  type AggregateFilters,
} from "./movements";
import { MOVEMENT_CHANGE_TYPES, MOVEMENT_GARAGE_KEYS, MOVEMENT_PATTERNS, MOVEMENT_SPOT_KEYS, classifyMovement, movementLabel, movementPhase, placeValue, posixToJs, scheduledCheckOutMs, type MovementKind } from "../../shared/multiparkMovements";

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
    // 14 out 2026: cada MOVEMENT pelo modifiedFields; levar ao parque = fim sem garagem de origem, ou (formato antigo) o 1.º depois de uma recolha sem contar os inícios
    expect(sql).toContain(`CASE WHEN h.ct = 'MOVEMENT' THEN ${movementKindSql("h.mf")} END AS mk`);
    expect(sql).toContain(`x.ct = 'MOVEMENT' AND (x.mk = 'arrumar' OR (x.mk = 'antigo' AND x.prev_cat = 'CHECK_IN'))) AS parking_moves`);
    expect(sql).toContain(`x.ct = 'MOVEMENT' AND x.mk IN ('arrumar', 'parques', 'antigo')) AS moves`);
    expect(sql).toContain(`x.ct = 'MOVEMENT' AND x.mk = 'lugar') AS spot_changes`);
    expect(sql).toContain(`PARTITION BY k.booking_id, (k.ct IN ('CHECK_IN', 'CHECK_OUT', 'MOVEMENT', 'CANCEL') AND k.mk IS DISTINCT FROM 'inicio')`);
    // tarefa 62: a entrega atrasada saiu — nem hora marcada, nem pedido, nem late_deliveries (mais simples e barato)
    expect(sql).not.toMatch(/late_deliveries|deliveries_without_schedule|sched_|pending_at|deliveries_before|PENDING_CHECKOUT/);
    // os inícios de movimento não são ações
    expect(sql).toContain(`WHERE x.at >= $3::timestamp AND x.mk IS DISTINCT FROM 'inicio'`);
    expect(sql).toContain(`  FROM seq x`);
    expect(sql).not.toContain("\\"); // a guarda recusa barras invertidas
    expect(sql).toMatch(/GROUP BY x\.user_id, 3, 4, x\.ct/);
    expect(params.slice(0, 3)).toEqual(["2026-08-29 02:00:00", w.to, w.from]);
  });

  it("linha → contagem (com movimentos e mudanças de lugar; tarefa 62: as entregas atrasadas já não vêm)", () => {
    const r = mapEngineActionCountRow({ user_id: "u1", day: "2026-09-02", shift: "night", change_type: "MOVEMENT", n: 5, parking_moves: 1, late_deliveries: 3, moves: "2", spot_changes: "1", deliveries_without_schedule: 4 });
    expect(r).toMatchObject({ n: 5, parkingMoves: 1, moves: 2, spotChanges: 1 });
    expect(r).not.toHaveProperty("lateDeliveries");
    expect(r).not.toHaveProperty("deliveriesWithoutSchedule");
  });

  it("linha → contagem", () => {
    expect(mapEngineActionCountRow({ user_id: "u1", agent_name: " Ana ", day: "2026-09-02", shift: "morning", change_type: "movement", n: "4", parking_moves: "1", late_deliveries: null }))
      .toEqual({ agentUserId: "u1", agentName: "Ana", day: "2026-09-02", shift: "morning", changeType: "MOVEMENT", n: 4, parkingMoves: 1 });
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

// ─── 14 out 2026: o tipo de cada MOVEMENT — JS e SQL com OS MESMOS padrões ─
describe("14 out 2026 — que movimento foi (início · levar ao parque · mudança de lugar · entre parques)", () => {
  const samples: Array<[string, MovementKind]> = [
    ['{"_version":2,"status":{"from":"CHECKED_IN","to":"MOVING"}}', "inicio"],
    ['{"_version":2,"garageName":{"from":null,"to":"PD"},"spot":{"from":null,"to":"26 / 4"}}', "arrumar"],
    ['{"_version":2,"garageName":{"from":"PD","to":"PD"},"spot":{"from":"26 / 3","to":"70 / 1"}}', "lugar"],
    ['{"_version":2,"garageName":{"from":"PD FORA","to":"PD"},"spot":{"from":"4 / 1","to":"75 / 1"}}', "parques"],
    ['{"_version":2,"garageName":{"from":"PD","to":"COBERTO"},"spot":{"from":"72 / 2","to":"7 / 3"}}', "parques"],
    ['{"_version":2,"garageName":{"from":"PD","to":"PD FORA"}}', "parques"], // sem lugar (a atribuição falhou)
    ['{"_version":2,"garageName":{"from":" pd ","to":"PD"},"spot":{"from":"1","to":"2"}}', "lugar"],
    ['{"spot":{"from":"10","to":"11"}}', "lugar"],
    ['{"spot":{"from":10,"to":11}}', "lugar"], // números sem aspas
    ['{"spot":{"from":null,"to":12}}', "arrumar"],
    ['{"garageName":{"from":3,"to":4}}', "parques"],
    ['{"garageName":{"from":"","to":"PD"}}', "arrumar"], // vazio = sem origem
    ['{"garageName": { "to" : "PD" , "from" : "PD" } }', "lugar"], // espaços e ordem trocada
    ['{"garagem":"G2","lugar":"114","km":"45210"}', "antigo"], // cópia local: só o destino
    ['{"_version":2,"status":{"from":"MOVING","to":"CHECKED_IN"}}', "antigo"],
    ['{"garageName":{"from":"PD","to":"PD FO', "parques"], // JSON cortado: decide pelo que se lê, igual no SQL
    ["isto não é JSON", "antigo"],
    ["", "antigo"],
  ];
  it.each(samples)("%s → %s", (mf, kind) => {
    expect(classifyMovement(mf)).toBe(kind);
  });

  it("o SQL usa exatamente os mesmos padrões e a mesma normalização do JS (placeValue)", () => {
    const k = movementKindSql("mf");
    for (const pat of [MOVEMENT_PATTERNS.hasKey(MOVEMENT_GARAGE_KEYS), MOVEMENT_PATTERNS.hasKey(MOVEMENT_SPOT_KEYS), MOVEMENT_PATTERNS.plainKey(MOVEMENT_GARAGE_KEYS), MOVEMENT_PATTERNS.moving]) {
      expect(k).toContain(`'${pat}'`);
    }
    for (const key of [...MOVEMENT_GARAGE_KEYS, ...MOVEMENT_SPOT_KEYS]) {
      expect(k).toContain(`NULLIF(NULLIF(lower(trim(btrim(substring(mf from '${MOVEMENT_PATTERNS.side(key, "from")}'), '"'))), ''), 'null')`);
    }
    expect(k).toContain(`mf ~* '${MOVEMENT_PATTERNS.moving}'`); // sem distinguir maiúsculas, como o "i" do JS
    expect(placeValue('" PD "')).toBe("pd");
    expect(placeValue("null")).toBeNull();
    expect(placeValue('""')).toBeNull();
    expect(placeValue("12")).toBe("12");
    expect(MOVEMENT_GARAGE_KEYS).toEqual(["garageName", "garagem"]); // sem chaves especulativas (garage, spotId)
    expect(MOVEMENT_SPOT_KEYS).toEqual(["spot", "lugar"]);
  });

  it("o SQL do tipo passa a guarda (sem barras invertidas) e lê o texto COMPLETO (não o cortado)", () => {
    const k = movementKindSql(`COALESCE(h."modifiedFields", '')`);
    expect(k).not.toContain("\\");
    expect(() => assertReadOnlySql(`SELECT ${k} AS mk FROM "History" h`)).not.toThrow();
    // o detalhe (corta a 300) calcula o tipo sobre o texto inteiro
    const d = buildAgentMovementDetailSql({ window: w, userIds: ["u1"] }).sql;
    expect(d).toContain(`THEN ${movementKindSql(`COALESCE(h."modifiedFields", '')`)} END AS move_kind`);
    expect(() => assertReadOnlySql(d)).not.toThrow();
    // com um texto longo, o tipo depende do texto completo: uma garagem depois dos 1000 caracteres conta
    const long = `{"_version":2,"notes":"${"x".repeat(1200)}","garageName":{"from":"PD","to":"COBERTO"}}`;
    expect(classifyMovement(long)).toBe("parques");
    expect(classifyMovement(long.slice(0, 1000))).toBe("antigo"); // por isso o tipo NUNCA se tira do texto cortado
  });

  it("hora marcada da entrega: checkOut.from (não o checkOutDate)", () => {
    const mf = '{"_version":2,"status":{"from":"CHECKING_OUT","to":"CHECKED_OUT"},"checkOut":{"from":"2026-10-10T18:45:00.000Z","to":"2026-10-10T18:47:00.000Z"},"checkOutDate":{"from":"2026-10-09T00:00:00.000Z","to":"2026-10-10"}}';
    expect(posixToJs(MOVEMENT_PATTERNS.checkOutFrom).exec(mf)?.[1]).toBe("2026-10-10T18:45:00.000Z");
    expect(posixToJs(MOVEMENT_PATTERNS.checkOutFrom).exec('{"checkOutDate":{"from":"2026-10-09T00:00:00.000Z"}}')).toBeNull();
    // sem fuso = sem hora marcada (o JS e o SQL usam o mesmo padrão)
    expect(posixToJs(MOVEMENT_PATTERNS.checkOutFrom).exec('{"checkOut":{"from":"2026-10-10T18:45:00","to":"x"}}')).toBeNull();
    expect(posixToJs(MOVEMENT_PATTERNS.checkOutFrom).exec('{"checkOut":{"from":"2026-10-10T19:45:00+01:00","to":"x"}}')?.[1]).toBe("2026-10-10T19:45:00+01:00");
    expect(scheduledCheckOutMs('{"checkOut":{"from":"2026-10-10T18:45:00"}}')).toBeNull();
    expect(scheduledCheckOutMs('{"checkOut":{"from":"2026-10-10T19:45:00+01:00"}}')).toBe(Date.parse("2026-10-10T18:45:00Z"));
    expect(scheduledCheckOutTextSql("mf")).toBe(`substring(mf from '${MOVEMENT_PATTERNS.checkOutFrom}')`);
  });

  it("Condutores e agentes: movimentos e mudanças de lugar pelo tipo; os inícios ficam fora de tudo", () => {
    const { sql } = buildAgentHistoryAggSql(f());
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`count(*) FILTER (WHERE h.mk IN ('arrumar', 'parques', 'antigo')) AS moves`);
    expect(sql).toContain(`count(*) FILTER (WHERE h.mk = 'lugar') AS spot_changes`);
    expect(sql).toContain(`WHERE h.mk IS DISTINCT FROM 'inicio'`);
    // o tipo calcula-se UMA vez por linha (numa subconsulta), não uma vez por coluna
    expect(sql.split(movementKindSql(`COALESCE(h."modifiedFields", '')`)).length - 1).toBe(1);
    expect(sql).not.toContain(`'UPDATE' AND (h."modifiedFields" ILIKE`);
    const [r] = mergeAgentAggregates({ history: [{ user_id: "u1", total: 10, t_movement: 6, moves: 3, spot_changes: 1 }], phases: [], occurrences: [], reviews: [] });
    expect(r).toMatchObject({ movements: 3, spotChanges: 1, byType: { MOVEMENT: 6 } });
  });

  it("detalhe da Avaliação do dia: o início e a mudança de lugar com o seu nome (o resto como estava)", () => {
    const base = { id: "h", action_time: "2026-10-03 02:26:24", user_id: "u1" };
    expect(mapAgentMovementRow({ ...base, change_type: "MOVEMENT", move_kind: "inicio" })).toMatchObject({ changeType: "MOVEMENT_START", moveKind: "inicio" });
    expect(mapAgentMovementRow({ ...base, change_type: "MOVEMENT", move_kind: "lugar" })).toMatchObject({ changeType: "SPOT_CHANGE" });
    expect(mapAgentMovementRow({ ...base, change_type: "MOVEMENT", move_kind: "parques" })).toMatchObject({ changeType: "MOVEMENT" });
    expect(mapAgentMovementRow({ ...base, change_type: "check_out", move_kind: null })).toMatchObject({ changeType: "CHECK_OUT", moveKind: null });
    expect(movementLabel("MOVEMENT_START")).toBe("Início de movimento (não conta)");
    expect(movementLabel("SPOT_CHANGE")).toBe("Mudança de lugar");
    expect(movementPhase("SPOT_CHANGE")).toBe("move");
  });

  it("getAgentDayMovements (o agentHistorySummary): lê o tipo e devolve os rótulos", async () => {
    process.env[ENV] = "postgres://ro@db/mp";
    queryMock.mockResolvedValueOnce([
      { id: "1", action_time: "2026-10-03 02:26:24", change_type: "MOVEMENT", user_id: "u1", move_kind: "inicio" },
      { id: "2", action_time: "2026-10-03 02:40:40", change_type: "MOVEMENT", user_id: "u1", move_kind: "arrumar" },
      { id: "3", action_time: "2026-10-03 13:32:13", change_type: "MOVEMENT", user_id: "u1", move_kind: "lugar" },
    ]);
    const r = await getAgentDayMovements({ day: "2026-10-03", userIds: ["u1"] });
    expect(r.available && r.data.rows.map((x) => x.changeType)).toEqual(["MOVEMENT_START", "MOVEMENT", "SPOT_CHANGE"]);
  });
});
