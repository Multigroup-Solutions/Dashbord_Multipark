import { describe, expect, it } from "vitest";
import {
  complaintIsConfirmed,
  computeEmployeeDays,
  incidentIsAccident,
  isFlaggedPonto,
  isLateArrival,
  markLateDeliveries,
  markParkingMoves,
  pairPonto,
  scheduledStartUtcMs,
  type ActionRow,
  type EngineInput,
} from "./evaluationCore";
import { buildEvaluationIdentity } from "./evaluationIdentity";
import { scoreOf } from "../shared/evaluationRules";
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
  it("> 15 min entre o pedido (PENDING_CHECKOUT) e a entrega conta; ≤ 15 não", () => {
    const rows = [
      act("B1", "PENDING_CHECKOUT", "2026-09-24 10:00:00"),
      act("B1", "CHECK_OUT", "2026-09-24 10:16:00"),
      act("B2", "PENDING_CHECKOUT", "2026-09-24 10:00:00"),
      act("B2", "CHECK_OUT", "2026-09-24 10:15:00"),
      act("B3", "CHECK_OUT", "2026-09-24 11:00:00"), // sem pedido
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

  it("velocidade, reclamações confirmadas e acidentes vão para o dia certo", () => {
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
    expect(m).toMatchObject({ speedingEvents: 2, complaints: 1, accidents: 1, incidentsReported: 1, incidentsAgainst: 1, penaltyPoints: 4 });
    expect(scoreOf(m).totalPoints).toBe(-20 - 20 - 600);
  });

  it("agentes sem ficha ficam à parte (para a escala sem ficha no operacional)", () => {
    const out = computeEmployeeDays({ ...base, actions: [act("B9", "CHECK_OUT", "2026-09-24 10:00:00", "Zé Desconhecido")], ponto: [], assignments: [] });
    expect(out.rows).toHaveLength(0);
    expect(out.unresolved.get("2026-09-24")?.get("agent:zé desconhecido")).toMatchObject({ actions: 1, entregas: 1 });
  });
});
