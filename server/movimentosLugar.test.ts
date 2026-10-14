/**
 * Movimento × mudança de lugar (Jorge, 14 out 2026: "os movimentos, para os
 * pontos, eram os que tocavam no parque. As mudanças de lugar não contam como
 * movimentos; contam como interações").
 *
 * A Multipark grava toda a deslocação como MOVEMENT; o tipo deduz-se da ação
 * anterior da MESMA reserva (shared/multiparkMovements.ts → moveKindsOf, e o
 * mesmo em SQL em server/multiparkDb/movements.ts). Estes testes provam:
 *  - a regra (levar ao parque, tirar para a entrega, mudança de lugar);
 *  - que o motor da avaliação tira as mudanças de lugar dos movimentos e dos
 *    pontos, mas deixa-as nas ações — pelas linhas soltas e pelas contagens;
 *  - que os agregados (Condutores e agentes, Avaliação → Mês) e os detalhes
 *    separam as mudanças de lugar (deixam de dar sempre 0);
 *  - que o SQL tem a mesma regra que o JS.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MOVE_KIND_LABELS, SPOT_CHANGE_KEY, actionKeyOf, canonicalChangeType, movementLabel, movementPhase, moveKindsOf, moveTouchesPark,
} from "../shared/multiparkMovements";
import { actionPoints, applyAdjustments, emptyDayMetrics, scoreOf, METRIC_KEYS } from "../shared/evaluationRules";
import { actionRowsToCounts, computeEmployeeDays, markSpotChanges, type ActionRow, type EngineInput } from "./evaluationCore";
import { buildEvaluationIdentity } from "./evaluationIdentity";
import {
  buildAgentHistoryAggSql, buildBookingSequenceSql, buildEngineActionCountsSql, mergeAgentAggregates, moveIsSpotSql, movementWindow, readMoveKinds,
  sumAgentSummaries, withMoveKinds, MOVE_PARK_CATS_SQL, MOVE_SEQ_CATS_SQL,
} from "./multiparkDb/movements";
import { buildActivityActionsSql } from "./multiparkDb/activityLive";
import { assertReadOnlySql } from "./multiparkDb/client";
import { MIGRATION_0670_STATEMENTS, IDEMPOTENT_ERROR_CODES_0670 } from "./migrations/migration_0670";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");
let seq = 0;
const a = (bookingId: string, changeType: string, actionTime: string) => ({ id: `h${String(++seq).padStart(4, "0")}`, bookingId, changeType, actionTime });

describe("a regra (moveKindsOf)", () => {
  it("1.º movimento depois da recolha = levar ao parque; os seguintes com o carro no parque = mudança de lugar", () => {
    const rows = [
      a("B1", "CHECK_IN", "2026-10-01 08:00:00"),
      a("B1", "MOVEMENT", "2026-10-01 08:10:00"), // levar ao parque
      a("B1", "MOVEMENT", "2026-10-01 15:00:00"), // muda de lugar
      a("B1", "MOVEMENT", "2026-10-02 09:00:00"), // muda outra vez
    ];
    const k = moveKindsOf(rows);
    expect([...k.values()]).toEqual(["park", "spot", "spot"]);
  });

  it("1.º movimento depois do pedido (ou do início) da entrega = tirar do parque; uma 2.ª deslocação já é mudança de lugar", () => {
    const rows = [
      a("B2", "CHECK_IN", "2026-10-01 08:00:00"),
      a("B2", "MOVEMENT", "2026-10-01 08:10:00"),
      a("B2", "PENDING_CHECKOUT", "2026-10-03 10:00:00"),
      a("B2", "MOVEMENT", "2026-10-03 10:05:00"), // sai do parque para a entrega
      a("B2", "MOVEMENT", "2026-10-03 10:07:00"), // mexe outra vez (não volta a contar)
      a("B2", "CHECKING_OUT", "2026-10-03 10:20:00"),
      a("B2", "CHECK_OUT", "2026-10-03 10:30:00"),
      a("B3", "CHECKING_OUT", "2026-10-03 11:00:00"),
      a("B3", "MOVEMENT", "2026-10-03 11:01:00"), // início da entrega → sai do parque
    ];
    const k = moveKindsOf(rows);
    expect(rows.filter((r) => r.changeType === "MOVEMENT").map((r) => k.get(r.id))).toEqual(["park", "exit", "spot", "exit"]);
  });

  it("sem nada antes na reserva (o carro já estava no parque) = mudança de lugar; ordem pelo instante, não pela lista", () => {
    const rows = [a("B4", "MOVEMENT", "2026-10-02 09:00:00"), a("B4", "CHECK_IN", "2026-10-02 08:00:00")];
    expect(moveKindsOf(rows).get(rows[0].id)).toBe("park"); // a recolha veio antes no tempo
    const only = [a("B5", "MOVEMENT", "2026-10-02 09:00:00")];
    expect(moveKindsOf(only).get(only[0].id)).toBe("spot");
    // UPDATE/CREATED no meio não mudam nada; a recolha continua a valer
    const mid = [a("B6", "CHECK_IN", "2026-10-02 08:00:00"), a("B6", "UPDATE", "2026-10-02 08:01:00"), a("B6", "MOVEMENT", "2026-10-02 08:05:00")];
    expect(moveKindsOf(mid).get(mid[2].id)).toBe("park");
    // reservas diferentes não se misturam
    const two = [a("B7", "CHECK_IN", "2026-10-02 08:00:00"), a("B8", "MOVEMENT", "2026-10-02 08:05:00")];
    expect(moveKindsOf(two).get(two[1].id)).toBe("spot");
  });

  it("um cancelamento ou uma entrega fecham o ciclo", () => {
    const rows = [a("B9", "CHECK_IN", "2026-10-02 08:00:00"), a("B9", "CANCEL", "2026-10-02 08:01:00"), a("B9", "MOVEMENT", "2026-10-02 08:05:00")];
    expect(moveKindsOf(rows).get(rows[2].id)).toBe("spot");
    const out = [a("B10", "PENDING_CHECKOUT", "2026-10-02 08:00:00"), a("B10", "CHECK_OUT", "2026-10-02 08:20:00"), a("B10", "MOVEMENT", "2026-10-02 09:00:00")];
    expect(moveKindsOf(out).get(out[2].id)).toBe("spot");
  });

  it("nomes antigos da API/cópia local (MOVE, CHECKIN…) seguem a mesma regra", () => {
    expect(canonicalChangeType("move")).toBe("MOVEMENT");
    expect(canonicalChangeType("CHECKIN")).toBe("CHECK_IN");
    const rows = [a("B11", "CHECKIN", "2026-10-02 08:00:00"), a("B11", "MOVE", "2026-10-02 08:05:00")];
    expect(moveKindsOf(rows).get(rows[1].id)).toBe("park");
  });

  it("rótulos e chave SPOT_CHANGE", () => {
    expect(actionKeyOf("MOVEMENT", "spot")).toBe(SPOT_CHANGE_KEY);
    expect(actionKeyOf("MOVEMENT", "exit")).toBe("MOVEMENT");
    expect(actionKeyOf("MOVEMENT", null)).toBe("MOVEMENT");
    expect(actionKeyOf("CHECK_IN", "spot")).toBe("CHECK_IN");
    expect(movementLabel(SPOT_CHANGE_KEY)).toBe("Mudança de lugar");
    expect(movementPhase(SPOT_CHANGE_KEY)).toBe("move");
    expect(MOVE_KIND_LABELS.park).toBe("Levar ao parque");
    expect(moveTouchesPark("park") && moveTouchesPark("exit") && !moveTouchesPark("spot")).toBe(true);
  });
});

describe("avaliação: a mudança de lugar é ação, não movimento nem pontos", () => {
  const identity = buildEvaluationIdentity({
    employees: [{ id: 1, fullName: "Ana Silva", userId: 10, multiparkAgentName: "Ana", multiparkAgentUserId: null }],
    agentAliases: [], accountAliases: [],
  });
  const act = (bookingExternalId: string, changeType: string, actionTime: string, agentName = "Ana"): ActionRow =>
    ({ bookingExternalId, changeType, actionTime, agentUserId: null, agentName });
  const base: EngineInput = {
    startDay: "2026-10-01", endDay: "2026-10-01", identity,
    employees: new Map([[1, { id: 1, position: "driver", contractType: null, extraLevel: null, monthlySalary: null, projectId: 1 }]]),
    actions: [
      act("B1", "CHECK_IN", "2026-10-01 08:00:00"),
      act("B1", "MOVEMENT", "2026-10-01 08:10:00"), // levar ao parque +5
      act("B1", "MOVEMENT", "2026-10-01 10:00:00"), // mudança de lugar (0)
      act("B2", "MOVEMENT", "2026-10-01 11:00:00"), // mudança de lugar (0)
      act("B3", "PENDING_CHECKOUT", "2026-10-01 12:00:00", "Cliente"),
      act("B3", "MOVEMENT", "2026-10-01 12:05:00"), // tirar do parque +2
      act("B3", "CHECK_OUT", "2026-10-01 12:10:00"), // entrega +3
    ],
    ponto: [], assignments: [], incidents: [], complaints: [], speedAlerts: [], penalties: [],
    rate: () => 10, tlWorkingDaysPerMonth: 15,
  };

  it("pelas linhas soltas: 6 ações, 2 movimentos (1 levar ao parque), 2 mudanças de lugar, pontos 5 + 2 + 3", () => {
    expect(markSpotChanges(base.actions)).toEqual(new Set([2, 3]));
    const m = computeEmployeeDays(base).rows[0].metrics;
    expect(m).toMatchObject({ actions: 6, recolhas: 1, entregas: 1, movements: 2, parkingMoves: 1, spotChanges: 2 });
    expect(m.weightedActions).toBe(5 + 2 + 3 + 3);
    expect(scoreOf(m).lines.find((l) => l.key === "movement")).toMatchObject({ count: 1, subtotal: 2 });
    expect(computeEmployeeDays(base).rows[0].actionsByType).toEqual({ CHECK_IN: 1, MOVEMENT: 2, SPOT_CHANGE: 2, CHECK_OUT: 1 });
  });

  it("pelas contagens agregadas (BD da Multipark) dá o mesmo", () => {
    const counts = actionRowsToCounts(base.actions);
    expect(counts.filter((c) => c.changeType === "MOVEMENT").reduce((s, c) => s + (c.spotMoves ?? 0), 0)).toBe(2);
    const fromRows = computeEmployeeDays(base).rows[0];
    const fromCounts = computeEmployeeDays({ ...base, actions: [], actionCounts: counts }).rows[0];
    expect(fromCounts.metrics).toEqual(fromRows.metrics);
    expect(fromCounts.actionsByType).toEqual(fromRows.actionsByType);
  });

  it("antes (sem a separação) estas 2 mudanças de lugar davam +4 pontos de movimento", () => {
    const old = { ...emptyDayMetrics(), recolhas: 1, entregas: 1, movements: 4, parkingMoves: 1 };
    const now = computeEmployeeDays(base).rows[0].metrics;
    expect(actionPoints(old) - now.weightedActions).toBe(4);
  });

  it("agentes sem ficha também separam (operacional do dia)", () => {
    const u = computeEmployeeDays({ ...base, actions: base.actions.map((x) => (x.agentName === "Ana" ? { ...x, agentName: "Zé Sem Ficha" } : x)) }).unresolved.get("2026-10-01")!;
    const z = u.get("agent:zesemficha")!;
    expect(z).toMatchObject({ actions: 6, movements: 2, spotChanges: 2, parkingMoves: 1 });
  });

  it("a métrica nova existe, guarda-se e não se ajusta à mão; um ajuste nas ações não mexe nela", () => {
    expect(METRIC_KEYS).toContain("spotChanges");
    const m = { ...emptyDayMetrics(), actions: 3, movements: 1, spotChanges: 2 };
    expect(applyAdjustments(m, [{ metric: "movements", delta: 1 }])).toMatchObject({ movements: 2, spotChanges: 2, actions: 4 });
    const eng = src("server/evaluationEngine.ts");
    expect(eng).toContain("parkingMoves: m.parkingMoves, spotChanges: m.spotChanges");
    expect(eng).toMatch(/"parkingMoves", "spotChanges",/);
  });

  it("migração 0670: só acrescenta a coluna, idempotente, registada no fim", () => {
    expect(MIGRATION_0670_STATEMENTS).toEqual(["ALTER TABLE `employee_day_metrics` ADD COLUMN `spotChanges` INT NOT NULL DEFAULT 0 AFTER `parkingMoves`"]);
    expect(IDEMPOTENT_ERROR_CODES_0670.has("ER_DUP_FIELDNAME")).toBe(true);
    expect(SCHEMA_MIGRATION_IDS[SCHEMA_MIGRATION_IDS.length - 1]).toBe("0670");
    expect(src("drizzle/schema.ts")).toContain("spotChanges: int().default(0).notNull(),");
  });
});

describe("SQL: a mesma regra (motor, agregados, Atividade do dia)", () => {
  const w = movementWindow("2026-09-01");
  it("motor: lag entre recolha/entrega/movimento/cancelamento E entre todas (com o pedido e o início da entrega)", () => {
    const { sql } = buildEngineActionCountsSql({ lookbackFrom: "2026-08-29 02:00:00", from: w.from, to: w.to });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(MOVE_PARK_CATS_SQL).toBe("('CHECK_IN', 'CHECK_OUT', 'MOVEMENT', 'CANCEL')");
    expect(MOVE_SEQ_CATS_SQL).toBe("('CHECK_IN', 'CHECK_OUT', 'MOVEMENT', 'CANCEL', 'PENDING_CHECKOUT', 'CHECKING_OUT')");
    expect(sql).toContain(`CASE WHEN h.ct IN ${MOVE_SEQ_CATS_SQL} THEN lag(h.ct) OVER (PARTITION BY h.booking_id, (h.ct IN ${MOVE_SEQ_CATS_SQL}) ORDER BY h.at, h.id) END AS prev_any`);
    expect(sql).toContain(`count(*) FILTER (WHERE x.ct = 'MOVEMENT' AND ${moveIsSpotSql("x.prev_cat", "x.prev_any")}) AS spot_moves`);
    expect(moveIsSpotSql("p", "q")).toBe("(p IS DISTINCT FROM 'CHECK_IN' AND (q IS NULL OR q NOT IN ('PENDING_CHECKOUT', 'CHECKING_OUT')))");
  });

  it("o SQL decide como o JS em todas as combinações da ação anterior", () => {
    // simula o CASE do SQL com os dois "anteriores" e compara com moveKindsOf
    const sqlKind = (prevPark: string | null, prevAny: string | null) => prevPark === "CHECK_IN" ? "park"
      : !(prevPark !== "CHECK_IN" && (prevAny == null || !["PENDING_CHECKOUT", "CHECKING_OUT"].includes(prevAny))) ? "exit" : "spot";
    const types = ["CHECK_IN", "CHECK_OUT", "MOVEMENT", "CANCEL", "PENDING_CHECKOUT", "CHECKING_OUT"];
    for (const t1 of [null, ...types]) for (const t2 of [null, ...types]) {
      const rows = [t1, t2].filter((x): x is string => !!x).map((t, i) => a("BX", t, `2026-10-01 08:0${i}:00`));
      const mv = a("BX", "MOVEMENT", "2026-10-01 09:00:00");
      const kinds = moveKindsOf([...rows, mv]);
      const parkSeq = rows.filter((r) => ["CHECK_IN", "CHECK_OUT", "MOVEMENT", "CANCEL"].includes(r.changeType));
      const prevPark = parkSeq.length ? parkSeq[parkSeq.length - 1].changeType : null;
      const prevAny = rows.length ? rows[rows.length - 1].changeType : null;
      expect({ t1, t2, kind: kinds.get(mv.id) }).toEqual({ t1, t2, kind: sqlKind(prevPark, prevAny) });
    }
  });

  it("agregados por agente: deixaram de procurar UPDATE com spot/garage (que dava sempre 0)", () => {
    const { sql } = buildAgentHistoryAggSql({ window: w, byDay: false });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).not.toMatch(/ILIKE '%spot%'/);
    expect(sql).toContain(`LEFT JOIN seq sq ON sq.id = h."id"`);
    expect(sql).toContain(`count(*) FILTER (WHERE h."changeType"::text = 'MOVEMENT' AND ${moveIsSpotSql("sq.prev_cat", "sq.prev_any")}) AS spot_changes`);
  });

  it("Atividade do dia: a mudança de lugar chega como SPOT_CHANGE (cai nas outras ações)", () => {
    const { sql } = buildActivityActionsSql({ from: "2026-09-26 23:00:00", to: "2026-09-27 23:00:00" });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain("THEN 'SPOT_CHANGE'");
    expect(src("server/dayActivity.ts")).not.toMatch(/SPOT_CHANGE: "movements"/);
  });
});

describe("Condutores e agentes / Avaliação → Mês: as mudanças de lugar aparecem (já não são sempre 0)", () => {
  it("o resumo separa: MOVEMENT tocam no parque, SPOT_CHANGE à parte, e o total (ações) não muda", () => {
    const [s] = mergeAgentAggregates({
      history: [{ user_id: "u1", total: 10, t_check_in: 2, t_movement: 6, t_check_out: 2, spot_changes: 4, bookings: 4 }],
      phases: [], occurrences: [], reviews: [],
    });
    expect(s).toMatchObject({ total: 10, recolhas: 2, entregas: 2, movements: 2, spotChanges: 4 });
    expect(s.byType).toEqual({ CHECK_IN: 2, MOVEMENT: 2, SPOT_CHANGE: 4, CHECK_OUT: 2 });
    const [all] = mergeAgentAggregates({ history: [{ user_id: "u2", total: 3, t_movement: 3, spot_changes: 3 }], phases: [], occurrences: [], reviews: [] });
    expect(all).toMatchObject({ movements: 0, spotChanges: 3 });
    expect(all.byType).toEqual({ SPOT_CHANGE: 3 });
    expect(sumAgentSummaries([s, all])).toMatchObject({ movements: 2, spotChanges: 7, total: 13 });
  });

  it("detalhe: lê a sequência das reservas e marca cada MOVEMENT; sem MOVEMENT não lê; se a leitura falha fica como estava", async () => {
    const q = vi.fn(async () => [
      { id: "x1", booking_id: "B1", change_type: "CHECK_IN", action_time: "2026-10-01 08:00:00" },
      { id: "m1", booking_id: "B1", change_type: "MOVEMENT", action_time: "2026-10-01 08:10:00" },
      { id: "m2", booking_id: "B1", change_type: "MOVEMENT", action_time: "2026-10-01 12:00:00" },
    ]);
    const rows = [
      { id: "m1", bookingId: "B1", changeType: "MOVEMENT", actionTime: "2026-10-01T08:10:00.000Z" },
      { id: "m2", bookingId: "B1", changeType: "MOVEMENT", actionTime: "2026-10-01 12:00:00" },
      { id: "c1", bookingId: "B1", changeType: "UPDATE", actionTime: "2026-10-01 12:30:00" },
    ];
    const kinds = await readMoveKinds(rows, q as any);
    expect(q).toHaveBeenCalledTimes(1);
    const [sql, params] = (q.mock.calls[0] as unknown) as [string, unknown[]];
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(params.slice(0, 3)).toEqual(["B1", "2026-09-28 08:10:00", "2026-10-01 12:00:01"]);
    expect(withMoveKinds(rows, kinds).map((r) => [r.changeType, r.moveKind])).toEqual([["MOVEMENT", "park"], [SPOT_CHANGE_KEY, "spot"], ["UPDATE", null]]);
    const none = vi.fn();
    expect(await readMoveKinds([rows[2]], none as any)).toEqual(new Map());
    expect(none).not.toHaveBeenCalled();
    expect(await readMoveKinds(rows, (async () => { throw new Error("x"); }) as any)).toBeNull();
    expect(withMoveKinds(rows, null).map((r) => r.changeType)).toEqual(["MOVEMENT", "MOVEMENT", "UPDATE"]);
  });

  it("a leitura da sequência é só leitura e limitada", () => {
    const { sql, params } = buildBookingSequenceSql({ bookingIds: ["B1", "B1", " "], from: "2026-09-28 00:00:00", to: "2026-10-01 00:00:00" });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`h."bookingId" IN ($1)`);
    expect(params[params.length - 1]).toBe(20_000);
    expect(buildBookingSequenceSql({ bookingIds: [], from: "a", to: "b" }).sql).toContain("FALSE");
  });

  it("o ecrã mostra a coluna Mudanças de lugar nos Condutores e nos Agentes, clicável, e os condutores incluem quem só mudou carros de lugar", () => {
    const p = src("client/src/components/people/MovementPeoplePanel.tsx");
    expect(p).toContain("spotChanges: [SPOT_CHANGE_KEY]");
    expect(p).toContain('<Th k="spotChanges" label={spotLabel}');
    expect(p).toContain('num(r, "spotChanges", spotLabel)');
    expect(src("server/movementPeople.ts")).toContain("x.recolhas + x.entregas + x.movements + x.spotChanges > 0");
    expect(src("client/src/components/evaluation/MonthEvaluationTab.tsx")).toContain(">Mudanças de lugar</th>");
  });
});
