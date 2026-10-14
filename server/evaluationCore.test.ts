import { describe, expect, it } from "vitest";
import {
  actionRowsToCounts,
  complaintIsConfirmed,
  computeEmployeeDays,
  incidentIsAccident,
  isFlaggedPonto,
  isLateArrival,
  classifyDeliveries,
  isLateDelivery,
  markLateDeliveries,
  markParkingMoves,
  pairPonto,
  scheduledStartUtcMs,
  type ActionRow,
  type EngineInput,
} from "./evaluationCore";
import { buildEvaluationIdentity } from "./evaluationIdentity";
import { LATE_AFTER_REQUEST_MINUTES, scoreOf } from "../shared/evaluationRules";
import { utcMs } from "../shared/lisbonDay";

const act = (bookingExternalId: string, changeType: string, actionTime: string, agentName = "Gelson Sousa"): ActionRow =>
  ({ bookingExternalId, changeType, actionTime, agentUserId: null, agentName });

describe("levar ao parque (1.º movimento depois de uma recolha)", () => {
  it("só o 1.º movimento após a recolha, na mesma reserva", () => {
    const rows = [
      act("B1", "CHECK_IN", "2026-09-24 08:00:00"),
      act("B1", "MOVEMENT", "2026-09-24 08:20:00"), // levar ao parque
      act("B1", "MOVEMENT", "2026-09-24 09:00:00"), // movimento normal
      act("B2", "MOVEMENT", "2026-09-24 08:10:00"), // sem recolha antes
      act("B3", "CHECK_IN", "2026-09-24 10:00:00"),
      act("B3", "CHECK_OUT", "2026-09-24 10:05:00"), // entrega fecha o ciclo
      act("B3", "MOVEMENT", "2026-09-24 10:30:00"),
    ];
    expect([...markParkingMoves(rows)]).toEqual([1]);
  });

  it("ordena pelo tempo, não pela ordem das linhas", () => {
    const rows = [act("B1", "MOVEMENT", "2026-09-24 08:20:00"), act("B1", "CHECK_IN", "2026-09-24 08:00:00")];
    expect([...markParkingMoves(rows)]).toEqual([0]);
  });
});

describe("entregas atrasadas (serviço)", () => {
  it("sem hora marcada: > 30 min (LATE_AFTER_REQUEST_MINUTES) entre o pedido (PENDING_CHECKOUT) e a entrega conta; ≤ 30 não", () => {
    const rows = [
      act("B1", "PENDING_CHECKOUT", "2026-09-24 10:00:00"),
      act("B1", "CHECK_OUT", "2026-09-24 10:31:00"),
      act("B2", "PENDING_CHECKOUT", "2026-09-24 10:00:00"),
      act("B2", "CHECK_OUT", "2026-09-24 10:30:00"),
      act("B3", "CHECK_OUT", "2026-09-24 11:00:00"), // sem pedido nem hora marcada
      act("B4", "PENDING_CHECKOUT", "2026-09-24 01:00:00"),
      act("B4", "CHECK_OUT", "2026-09-24 12:00:00"), // > 10 h: outro pedido
    ];
    expect([...markLateDeliveries(rows)]).toEqual([1]);
  });
});

describe("ponto [SUSPEITO]", () => {
  it("suspeito/rejeitado/[SUSPEITO] não contam; aprovado conta", () => {
    expect(isFlaggedPonto({ notes: "[SUSPEITO] auto", reviewStatus: "ok" })).toBe(true);
    expect(isFlaggedPonto({ notes: "[SUSPEITO] auto", reviewStatus: "approved" })).toBe(false);
    expect(isFlaggedPonto({ notes: null, reviewStatus: "suspicious" })).toBe(true);
    expect(isFlaggedPonto({ notes: null, reviewStatus: "ok" })).toBe(false);
  });

  it("emparelha entradas/saídas; horas do registo de saída ou reais; turno pela ENTRADA", () => {
    const shifts = pairPonto([
      { id: 1, employeeId: 1, type: "check_in", recordedAt: "2026-09-24 14:00:00" },
      { id: 2, employeeId: 1, type: "check_out", recordedAt: "2026-09-25 01:30:00" }, // 02:30 Lisboa
      { id: 3, employeeId: 1, type: "check_in", recordedAt: "2026-09-25 14:00:00" },
      { id: 4, employeeId: 1, type: "check_out", recordedAt: "2026-09-25 20:00:00", hoursWorked: "12", notes: "[SUSPEITO] cortado" },
    ]);
    expect(shifts).toHaveLength(2);
    expect(shifts[0]).toMatchObject({ day: "2026-09-24", hours: 11.5, countable: true });
    expect(shifts[1]).toMatchObject({ day: "2026-09-25", hours: 12, countable: false });
  });
});

describe("atrasos no ponto", () => {
  it("hora da escala em Lisboa; ≥ 24 é o dia seguinte", () => {
    expect(scheduledStartUtcMs("2026-09-24", 15)).toBe(utcMs("2026-09-24 14:00:00"));
    expect(scheduledStartUtcMs("2026-09-24", 25)).toBe(utcMs("2026-09-25 00:00:00"));
  });
  it("atraso ao minuto; sem entrada não é atraso (é falta)", () => {
    const sched = scheduledStartUtcMs("2026-09-24", 15);
    expect(isLateArrival([sched + 40_000], sched)).toBe(false);
    expect(isLateArrival([sched + 61_000], sched)).toBe(true);
    expect(isLateArrival([sched - 600_000], sched)).toBe(false);
    expect(isLateArrival([], sched)).toBe(false);
  });
});

describe("reclamações e acidentes", () => {
  it("reclamação confirmada = com pontos e não convertida", () => {
    expect(complaintIsConfirmed({ penaltyPoints: 3, status: "closed" })).toBe(true);
    expect(complaintIsConfirmed({ penaltyPoints: 0, status: "closed" })).toBe(false);
    expect(complaintIsConfirmed({ penaltyPoints: 3, status: "converted" })).toBe(false);
  });
  it("acidente = ocorrência de dano com envolvimento confirmado", () => {
    expect(incidentIsAccident({ incidentType: "dano", employeeId: 1, driverConfirmed: 1, status: "open" })).toBe(true);
    expect(incidentIsAccident({ incidentType: "perdido", employeeId: 1, driverConfirmed: 1, status: "open" })).toBe(false);
  });
});

describe("motor (dia operacional completo)", () => {
  const identity = buildEvaluationIdentity({
    employees: [{ id: 1, fullName: "Gelson Manuel Leão Sousa", userId: 10, multiparkAgentName: null, multiparkAgentUserId: null }],
    agentAliases: [], accountAliases: [],
  });
  const base: EngineInput = {
    startDay: "2026-09-24", endDay: "2026-09-24", identity,
    employees: new Map([[1, { id: 1, position: "extra", contractType: "extra", extraLevel: 1, monthlySalary: null, projectId: 48 }]]),
    actions: [
      act("B1", "CHECK_IN", "2026-09-24 14:30:00"), // 15:30 Lisboa → noite
      act("B1", "MOVEMENT", "2026-09-24 14:50:00"), // levar ao parque (+5)
      act("B2", "MOVEMENT", "2026-09-25 00:30:00"), // 01:30 Lisboa → ainda dia 24, noite (+2)
      act("B3", "PENDING_CHECKOUT", "2026-09-24 20:00:00", "Cliente"),
      act("B3", "CHECK_OUT", "2026-09-24 20:40:00"), // entrega atrasada (+3, −5)
      act("B4", "MOVEMENT", "2026-09-25 02:30:00"), // 03:30 Lisboa → dia 25, fora
    ],
    ponto: [
      { id: 1, employeeId: 1, type: "check_in", recordedAt: "2026-09-24 14:10:00" }, // atrasado 10 min
      { id: 2, employeeId: 1, type: "check_out", recordedAt: "2026-09-25 01:10:00" },
      { id: 3, employeeId: 1, type: "check_in", recordedAt: "2026-09-24 03:00:00", notes: "[SUSPEITO]" },
      { id: 4, employeeId: 1, type: "check_out", recordedAt: "2026-09-24 06:00:00", notes: "[SUSPEITO]" },
    ],
    assignments: [{ assignmentDate: "2026-09-24", employeeId: null, personName: "Gelson Manuel Leão Sousa", level: "1", isTeamLeader: false, shift: "night", city: "lisboa", startHour: 15, endHour: 27, sentHomeHour: null }],
    incidents: [], complaints: [], speedAlerts: [], penalties: [],
    rate: () => 10, tlWorkingDaysPerMonth: 15,
  };

  it("junta ações, ponto (sem [SUSPEITO]), escala e atrasos na mesma pessoa/dia", () => {
    const out = computeEmployeeDays(base);
    expect(out.rows).toHaveLength(1);
    const r = out.rows[0];
    expect(r).toMatchObject({ employeeId: 1, day: "2026-09-24", shift: "night", hoursSource: "ponto" });
    const m = r.metrics;
    expect(m).toMatchObject({
      actions: 4, actionsNight: 4, actionsMorning: 0, recolhas: 1, entregas: 1, movements: 2, parkingMoves: 1,
      hoursWorked: 11, suspiciousHours: 3, scheduledHours: 12, delays: 2, lateServices: 1, cost: 110,
    });
    expect(m.weightedActions).toBe(5 + 2 + 3 + 3);
    expect(scoreOf(m).totalPoints).toBe(13 - 10);
  });

  it("contagens já agregadas (BD da Multipark) dão os mesmos números que as linhas soltas", () => {
    const fromRows = computeEmployeeDays(base);
    const counts = actionRowsToCounts(base.actions);
    expect(counts.find((c) => c.changeType === "MOVEMENT" && c.parkingMoves === 1)).toBeTruthy();
    const fromCounts = computeEmployeeDays({ ...base, actions: [], actionCounts: counts });
    expect(fromCounts.rows[0].metrics).toEqual(fromRows.rows[0].metrics);
    expect(fromCounts.rows[0].actionsByType).toEqual(fromRows.rows[0].actionsByType);
    expect(fromCounts.unresolved.get("2026-09-24")?.get("agent:cliente")?.actions).toBe(1);
  });

  it("contagens vivas: dia/turno, levar ao parque e entregas atrasadas vêm da BD; ocorrências da app contam como reportadas", () => {
    const out = computeEmployeeDays({
      ...base, actions: [], ponto: [], assignments: [],
      actionCounts: [
        { agentUserId: "mp-1", agentName: "Gelson Sousa", day: "2026-09-24", shift: "morning", changeType: "MOVEMENT", n: 3, parkingMoves: 1, lateDeliveries: 0 },
        { agentUserId: "mp-1", agentName: "Gelson Sousa", day: "2026-09-24", shift: "night", changeType: "CHECK_OUT", n: 2, parkingMoves: 0, lateDeliveries: 1 },
        { agentUserId: "mp-1", agentName: "Gelson Sousa", day: "2026-09-25", shift: "morning", changeType: "CHECK_IN", n: 5, parkingMoves: 0, lateDeliveries: 0 }, // fora do intervalo
        { agentUserId: "mp-2", agentName: "Outro Agente", day: "2026-09-24", shift: "night", changeType: "UPDATE", n: 4, parkingMoves: 0, lateDeliveries: 0 },
      ],
      agentOccurrences: [
        { agentUserId: "mp-1", agentName: "Gelson Sousa", day: "2026-09-24", n: 2 },
        { agentUserId: "mp-2", agentName: "Outro Agente", day: "2026-09-24", n: 9 }, // sem ficha: não conta
      ],
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].metrics).toMatchObject({ actions: 5, actionsMorning: 3, actionsNight: 2, movements: 3, parkingMoves: 1, entregas: 2, lateServices: 1, delays: 1, incidentsReported: 2 });
    expect(out.rows[0].actionsByType).toEqual({ MOVEMENT: 3, CHECK_OUT: 2 });
    expect(out.unresolved.get("2026-09-24")?.get("agent:outroagente")).toMatchObject({ actions: 4, byType: { UPDATE: 4 } });
  });

  it("velocidade e reclamações confirmadas vão para o dia certo; o dano antigo do dashboard já não é acidente", () => {
    const out = computeEmployeeDays({
      ...base,
      actions: [], ponto: [], assignments: [],
      speedAlerts: [{ id: 5, employeeId: 1, createdAt: "2026-09-24 10:00:00" }, { employeeId: null, createdAt: "2026-09-24 10:00:00" }],
      complaints: [
        { complaintId: 7, employeeId: 1, at: "2026-09-24 12:00:00", penaltyPoints: 2, status: "closed" },
        { complaintId: 7, employeeId: 1, at: "2026-09-24 12:00:00", penaltyPoints: 2, status: "closed" },
      ],
      incidents: [{ at: "2026-09-24 12:00:00", incidentType: "dano", reportedBy: 10, employeeId: 1, status: "open", driverConfirmed: 1 }],
      penalties: [
        { employeeId: 1, points: 2, reason: "complaint_investigation", relatedId: 7, createdAt: "2026-09-24 13:00:00" },
        { employeeId: 1, points: 1, reason: "speeding", relatedId: 5, createdAt: "2026-09-24 13:00:00" }, // o mesmo alerta
        { employeeId: 1, points: 1, reason: "speeding", relatedId: null, createdAt: "2026-09-24 13:00:00" },
      ],
    });
    const m = out.rows[0].metrics;
    // Jorge, 3 out: os acidentes antigos não contam — a ocorrência fica só informativa.
    expect(m).toMatchObject({ speedingEvents: 2, complaints: 1, accidents: 0, incidentsReported: 1, incidentsAgainst: 1, penaltyPoints: 4 });
    expect(scoreOf(m).totalPoints).toBe(-20 - 20);
  });

  it("agentes sem ficha ficam à parte (para a escala sem ficha no operacional)", () => {
    const out = computeEmployeeDays({ ...base, actions: [act("B9", "CHECK_OUT", "2026-09-24 10:00:00", "Zé Desconhecido")], ponto: [], assignments: [] });
    expect(out.rows).toHaveLength(0);
    expect(out.unresolved.get("2026-09-24")?.get("agent:zedesconhecido")).toMatchObject({ actions: 1, entregas: 1 });
  });
});

// ─── 14 out 2026 (Jorge): movimentos pelo modifiedFields, entregas pela hora marcada, 1 atraso à entrada por dia,
// excessos do Zello e reclamações confirmadas pelos pontos (de qualquer sinal) ─────────────────────────────
const mv = (bookingExternalId: string, actionTime: string, modifiedFields: string): ActionRow =>
  ({ bookingExternalId, changeType: "MOVEMENT", actionTime, agentUserId: null, agentName: "Gelson Sousa", modifiedFields });
const START = '{"_version":2,"status":{"from":"CHECKED_IN","to":"MOVING"}}';
const place = (gFrom: string | null, gTo: string, sFrom: string | null, sTo: string) =>
  JSON.stringify({ _version: 2, garageName: { from: gFrom, to: gTo }, spot: { from: sFrom, to: sTo } });
const ident1 = () => buildEvaluationIdentity({ employees: [{ id: 1, fullName: "Gelson Sousa", userId: 10, multiparkAgentName: null, multiparkAgentUserId: null }], agentAliases: [], accountAliases: [] });
const emptyInput = (startDay: string, endDay: string, identity: EngineInput["identity"]): EngineInput => ({
  startDay, endDay, identity, employees: new Map(), actions: [],
  ponto: [], assignments: [], incidents: [], complaints: [], speedAlerts: [], penalties: [], rate: () => 0, tlWorkingDaysPerMonth: 15,
});

describe("14 out 2026 — movimentos: início não conta; mesma garagem = mudança de lugar", () => {
  // o dia do Herlander (03/10) em pequeno: recolha + início + fim (arrumar), mudança de lugar e dois entre parques
  const rows: ActionRow[] = [
    act("B1", "CHECK_IN", "2026-10-03 02:26:13"),
    mv("B1", "2026-10-03 02:26:24", START), // 1 início: não conta
    mv("B1", "2026-10-03 02:40:40", place(null, "PD", null, "26 / 4")), // 2 levar ao parque
    mv("B2", "2026-10-03 13:32:13", place("PD", "PD", "26 / 3", "70 / 1")), // 3 mudança de lugar
    mv("B3", "2026-10-03 13:36:47", place("PD FORA", "PD", "4 / 1", "75 / 1")), // 4 entre parques
    mv("B4", "2026-10-03 12:13:53", START), // 5 início
    mv("B4", "2026-10-03 12:23:10", place("PD", "COBERTO", "72 / 2", "7 / 3")), // 6 entre parques
    act("B5", "CHECK_IN", "2026-10-03 09:00:00"),
    act("B5", "MOVEMENT", "2026-10-03 09:10:00"), // 8 formato antigo logo a seguir à recolha → levar ao parque
  ];

  it("classifyActionRows / markParkingMoves / actionRowsToCounts", () => {
    expect([...markParkingMoves(rows)].sort()).toEqual([2, 8]);
    const counts = actionRowsToCounts(rows).filter((c) => c.changeType === "MOVEMENT");
    const sum = (k: "n" | "moves" | "spotChanges" | "parkingMoves") => counts.reduce((s, c) => s + (c[k] ?? 0), 0);
    // os 2 inícios ficam fora de tudo (nem ações)
    expect({ n: sum("n"), moves: sum("moves"), spot: sum("spotChanges"), parking: sum("parkingMoves") }).toEqual({ n: 5, moves: 4, spot: 1, parking: 2 });
  });

  it("no motor: movimentos 4 (2 levar ao parque + 2 entre parques), 1 mudança de lugar (+1), os inícios fora", () => {
    const identity = ident1();
    const out = computeEmployeeDays({ ...emptyInput("2026-10-03", "2026-10-03", identity), actions: rows });
    const m = out.rows[0].metrics;
    expect(m).toMatchObject({ movements: 4, parkingMoves: 2, spotChanges: 1, recolhas: 2, actions: 2 + 5 });
    expect(out.rows[0].actionsByType.MOVEMENT).toBe(5); // sem os 2 inícios
    expect(out.rows[0].actionsByHour!.reduce((s, n) => s + n, 0)).toBe(7);
    expect(m.weightedActions).toBe(2 * 5 + 2 * 2 + 1 * 1 + 2 * 3);
    // as contagens agregadas (BD da Multipark) dão o mesmo
    const fromCounts = computeEmployeeDays({ ...emptyInput("2026-10-03", "2026-10-03", identity), actionCounts: actionRowsToCounts(rows) });
    expect(fromCounts.rows[0].metrics).toEqual(m);
  });
});

describe("14 out 2026 — entrega atrasada pela hora marcada (e pelo pedido + 30 quando o pedido vem depois)", () => {
  const outFields = (sched: string | null, at: string) => JSON.stringify({ _version: 2, status: { from: "CHECKING_OUT", to: "CHECKED_OUT" }, ...(sched ? { checkOut: { from: sched, to: at } } : {}) });
  const co = (b: string, at: string, sched: string | null): ActionRow => ({ ...act(b, "CHECK_OUT", at.replace("T", " ").slice(0, 19)), modifiedFields: outFields(sched, at) });

  it("regras com os casos reais e os de fronteira", () => {
    const rows: ActionRow[] = [
      // 24008 (10/10): pedido 18:27 antes da marcada 18:45, entregue 18:47 → NÃO é atraso (antes era)
      act("B1", "PENDING_CHECKOUT", "2026-10-10 18:27:43"), co("B1", "2026-10-10T18:47:43.000Z", "2026-10-10T18:45:00.000Z"),
      // 21013 (10/10): marcada 17:45, pedido 17:47 (depois), entregue 18:05 → 18 min do pedido: NÃO é atraso (≤ 30)
      act("B2", "PENDING_CHECKOUT", "2026-10-10 17:47:01"), co("B2", "2026-10-10T18:05:12.000Z", "2026-10-10T17:45:00.000Z"),
      // voo atrasado com viagem > 15 min: marcada 10:00, pedido 11:00, entregue 11:25 → NÃO é atraso
      act("B3", "PENDING_CHECKOUT", "2026-10-10 11:00:00"), co("B3", "2026-10-10T11:25:00.000Z", "2026-10-10T10:00:00.000Z"),
      // voo atrasado mas o condutor demorou: pedido 11:00, entregue 11:31 → atraso
      act("B7", "PENDING_CHECKOUT", "2026-10-10 11:00:00"), co("B7", "2026-10-10T11:31:00.000Z", "2026-10-10T10:00:00.000Z"),
      // sem pedido, marcada 12:00, entregue 12:30 → atraso; 12:15 → não
      co("B4", "2026-10-10T12:30:00.000Z", "2026-10-10T12:00:00.000Z"),
      co("B8", "2026-10-10T12:15:00.000Z", "2026-10-10T12:00:00.000Z"),
      // pedido à hora marcada: conta a marcada + 15 → 12:16 é atraso
      act("B9", "PENDING_CHECKOUT", "2026-10-10 12:00:00"), co("B9", "2026-10-10T12:16:00.000Z", "2026-10-10T12:00:00.000Z"),
      // sem hora marcada: pedido 13:00, entregue 13:20 → não (≤ 30); 13:31 → sim
      act("B5", "PENDING_CHECKOUT", "2026-10-10 13:00:00"), co("B5", "2026-10-10T13:20:00.000Z", null),
      act("B10", "PENDING_CHECKOUT", "2026-10-10 13:00:00"), co("B10", "2026-10-10T13:31:00.000Z", null),
      // hora marcada que não é data → cai no pedido + 30: 14:00 → 14:10 não é atraso
      act("B6", "PENDING_CHECKOUT", "2026-10-10 14:00:00"), { ...act("B6", "CHECK_OUT", "2026-10-10 14:10:00"), modifiedFields: '{"checkOut":{"from":"amanha","to":"x"}}' },
    ];
    const late = [...markLateDeliveries(rows)].map((i) => rows[i].bookingExternalId).sort();
    expect(late).toEqual(["B10", "B4", "B7", "B9"]);
    const { noSchedule } = classifyDeliveries(rows);
    expect([...noSchedule].map((i) => rows[i].bookingExternalId).sort()).toEqual(["B10", "B5", "B6"]);
    expect(LATE_AFTER_REQUEST_MINUTES).toBe(30);
  });

  it("isLateDelivery", () => {
    const at = (s: string) => utcMs(s);
    expect(isLateDelivery(at("2026-10-10 12:16:00"), at("2026-10-10 12:00:00"), null)).toBe(true);
    expect(isLateDelivery(at("2026-10-10 12:15:00"), at("2026-10-10 12:00:00"), null)).toBe(false);
    expect(isLateDelivery(at("2026-10-10 12:40:00"), at("2026-10-10 12:00:00"), at("2026-10-10 12:20:00"))).toBe(false); // 20 min do pedido
    expect(isLateDelivery(at("2026-10-10 12:51:00"), at("2026-10-10 12:00:00"), at("2026-10-10 12:20:00"))).toBe(true);
    expect(isLateDelivery(at("2026-10-10 12:51:00"), null, null)).toBe(false);
  });

  it("as entregas sem hora marcada chegam à avaliação do dia", () => {
    const rows = [act("B1", "PENDING_CHECKOUT", "2026-10-10 13:00:00"), co("B1", "2026-10-10T13:40:00.000Z", null)];
    const out = computeEmployeeDays({ ...emptyInput("2026-10-10", "2026-10-10", ident1()), actions: rows });
    expect(out.rows[0].metrics).toMatchObject({ entregas: 1, lateServices: 1, delays: 1, deliveriesWithoutSchedule: 1 });
  });
});

describe("14 out 2026 — no máximo 1 atraso à entrada por dia", () => {
  it("duas linhas na escala no mesmo dia, as duas atrasadas → 1", () => {
    const a = (startHour: number, endHour: number) => ({ assignmentDate: "2026-10-10", employeeId: 1, personName: "Gelson Sousa", level: "1", isTeamLeader: false, shift: "morning" as const, city: "lisbon", startHour, endHour, sentHomeHour: null });
    const out = computeEmployeeDays({
      ...emptyInput("2026-10-10", "2026-10-10", ident1()),
      ponto: [{ id: 1, employeeId: 1, type: "check_in", recordedAt: "2026-10-10 09:30:00" }],
      assignments: [a(8, 12), a(9, 14)],
    });
    expect(out.rows[0].metrics).toMatchObject({ delays: 1, lateServices: 0 });
    expect(scoreOf(out.rows[0].metrics).lines.find((l) => l.key === "delay")).toMatchObject({ count: 1, subtotal: -5 });
  });
});

describe("14 out 2026 — excessos de velocidade do Zello (1 por dia acima do limiar, sem contar a dobrar)", () => {
  const identity = buildEvaluationIdentity({ employees: [
    { id: 1, fullName: "Ana Silva", userId: 10, multiparkAgentName: null, multiparkAgentUserId: null },
    { id: 2, fullName: "Rui Costa", userId: 11, multiparkAgentName: null, multiparkAgentUserId: null },
  ], agentAliases: [], accountAliases: [] });
  it("dia com a máxima acima do limiar = 1; abaixo = 0; com alertas nesse dia ficam os alertas", () => {
    const out = computeEmployeeDays({
      ...emptyInput("2026-10-10", "2026-10-11", identity),
      speedThresholdKmh: 132,
      gpsDays: [
        { employeeId: 1, day: "2026-10-10", maxSpeed: 148.39 }, { employeeId: 1, day: "2026-10-10", maxSpeed: 140 }, // duas partes do PDA, 1 dia
        { employeeId: 1, day: "2026-10-11", maxSpeed: 131.9 },
        { employeeId: 2, day: "2026-10-10", maxSpeed: 140 },
      ],
      speedAlerts: [{ id: 7, employeeId: 2, createdAt: "2026-10-10 10:00:00" }, { id: 8, employeeId: 2, createdAt: "2026-10-10 11:00:00" }],
    });
    const get = (e: number, d: string) => out.rows.find((r) => r.employeeId === e && r.day === d)?.metrics.speedingEvents ?? 0;
    expect(get(1, "2026-10-10")).toBe(1);
    expect(get(1, "2026-10-11")).toBe(0);
    expect(get(2, "2026-10-10")).toBe(2); // os 2 alertas; o Zello não soma
  });
  it("sem limiar o GPS não conta", () => {
    expect(computeEmployeeDays({ ...emptyInput("2026-10-10", "2026-10-10", identity), gpsDays: [{ employeeId: 1, day: "2026-10-10", maxSpeed: 200 }] }).rows).toHaveLength(0);
  });
});

describe("14 out 2026 — reclamação confirmada pelos pontos (qualquer sinal) ou pelos pontos do condutor", () => {
  it("regra", () => {
    expect(complaintIsConfirmed({ penaltyPoints: -10, status: "closed" })).toBe(true); // a tabela base do ecrã é negativa
    expect(complaintIsConfirmed({ penaltyPoints: 0, status: "open", driverPenaltyPoints: -5 })).toBe(true);
    expect(complaintIsConfirmed({ penaltyPoints: 0, status: "closed", driverPenaltyPoints: 0 })).toBe(false);
    expect(complaintIsConfirmed({ penaltyPoints: -10, status: "converted", driverPenaltyPoints: 3 })).toBe(false);
  });
  it("uma vez por reclamação e condutor, −20 (nunca a dobrar, nunca positivo)", () => {
    const c = { complaintId: 5, employeeId: 1, at: "2026-10-10 10:00:00", penaltyPoints: -10, status: "closed", driverPenaltyPoints: -10 };
    const out = computeEmployeeDays({ ...emptyInput("2026-10-10", "2026-10-10", ident1()), complaints: [c, { ...c }] });
    expect(out.rows[0].metrics.complaints).toBe(1);
    expect(scoreOf(out.rows[0].metrics).lines.find((l) => l.key === "confirmedComplaint")).toMatchObject({ count: 1, subtotal: -20 });
  });
});

describe("14 out 2026 — excesso do Zello e alertas na fronteira das 03:00", () => {
  const identity = buildEvaluationIdentity({ employees: [{ id: 1, fullName: "Ana Silva", userId: 10, multiparkAgentName: null, multiparkAgentUserId: null }], agentAliases: [], accountAliases: [] });
  const run = (over: Partial<EngineInput>) => computeEmployeeDays({ ...emptyInput("2026-10-09", "2026-10-11", identity), speedThresholdKmh: 132, ...over });
  const ev = (out: ReturnType<typeof computeEmployeeDays>, d: string) => out.rows.find((r) => r.day === d)?.metrics.speedingEvents ?? 0;

  it("alerta às 02:30 de 10/10 (dia operacional 09/10) + GPS do dia de calendário 10/10 acima → conta 1 vez (no 09/10)", () => {
    const out = run({ speedAlerts: [{ id: 1, employeeId: 1, createdAt: "2026-10-10 01:30:00" }], gpsDays: [{ employeeId: 1, day: "2026-10-10", maxSpeed: 145 }] });
    expect(ev(out, "2026-10-09")).toBe(1);
    expect(ev(out, "2026-10-10")).toBe(0);
  });
  it("alerta às 03:10 de 10/10 (dia operacional 10/10) + GPS 10/10 → 1 no 10/10", () => {
    const out = run({ speedAlerts: [{ id: 1, employeeId: 1, createdAt: "2026-10-10 02:10:00" }], gpsDays: [{ employeeId: 1, day: "2026-10-10", maxSpeed: 145 }] });
    expect(ev(out, "2026-10-10")).toBe(1);
    expect(ev(out, "2026-10-09")).toBe(0);
  });
  it("alerta às 01:00 de 11/10 (dia operacional 10/10) + GPS de 11/10 → o GPS de 11/10 não soma", () => {
    const out = run({ speedAlerts: [{ id: 1, employeeId: 1, createdAt: "2026-10-11 00:00:00" }], gpsDays: [{ employeeId: 1, day: "2026-10-11", maxSpeed: 145 }] });
    expect(ev(out, "2026-10-10")).toBe(1);
    expect(ev(out, "2026-10-11")).toBe(0);
  });
  it("penalização RH de velocidade conta como alerta para o GPS", () => {
    const out = run({ penalties: [{ employeeId: 1, points: 5, reason: "speeding", relatedId: null, createdAt: "2026-10-10 01:30:00" }], gpsDays: [{ employeeId: 1, day: "2026-10-10", maxSpeed: 145 }] });
    expect(ev(out, "2026-10-09") + ev(out, "2026-10-10")).toBe(1);
  });
});
