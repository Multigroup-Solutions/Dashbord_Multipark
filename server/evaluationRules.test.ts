import { describe, expect, it } from "vitest";
import {
  EVALUATION_POINTS,
  actionPoints,
  applyAdjustments,
  emptyDayMetrics,
  normalisationHours,
  perHour,
  perHourMetrics,
  scoreOf,
  sumMetrics,
  type DayMetrics,
} from "../shared/evaluationRules";
import {
  operationalDayRangeUtc,
  operationalSlotFromLocal,
  operationalSlotOf,
} from "../shared/lisbonDay";

const m = (over: Partial<DayMetrics>): DayMetrics => ({ ...emptyDayMetrics(), ...over });

describe("regras do dono (pontos)", () => {
  it("os pontos são os definidos", () => {
    expect(EVALUATION_POINTS).toMatchObject({
      movement: 2, pickupOrDelivery: 3, firstMoveAfterPickup: 5,
      speeding: -10, delay: -5, confirmedComplaint: -20, accidentOrDamage: -600,
    });
  });

  it("+5 do levar ao parque SUBSTITUI os +2 desse movimento", () => {
    // 3 movimentos, 1 deles o 1.º após recolha; 1 recolha + 1 entrega
    const day = m({ movements: 3, parkingMoves: 1, recolhas: 1, entregas: 1 });
    expect(actionPoints(day)).toBe(2 * 2 + 5 + 2 * 3);
    const s = scoreOf(day);
    const line = (k: string) => s.lines.find((l) => l.key === k)!;
    expect(line("movement")).toMatchObject({ count: 2, points: 2, subtotal: 4 });
    expect(line("firstMoveAfterPickup")).toMatchObject({ count: 1, subtotal: 5 });
    expect(line("pickupOrDelivery")).toMatchObject({ count: 2, subtotal: 6 });
    expect(s.totalPoints).toBe(15);
  });

  it("negativos: velocidade, atrasos, reclamações e acidentes; o total pode ser negativo", () => {
    const s = scoreOf(m({ entregas: 2, speedingEvents: 1, delays: 2, complaints: 1, accidents: 1 }));
    expect(s.positivePoints).toBe(6);
    expect(s.negativePoints).toBe(10 + 10 + 20 + 600);
    expect(s.totalPoints).toBe(6 - 640);
    expect(s.lines.map((l) => l.key)).toEqual([
      "movement", "pickupOrDelivery", "firstMoveAfterPickup", "speeding", "delay", "confirmedComplaint", "accidentOrDamage",
    ]);
  });

  it("é linear: a pontuação da soma é a soma das pontuações", () => {
    const a = m({ movements: 4, parkingMoves: 2, recolhas: 2, delays: 1 });
    const b = m({ entregas: 5, speedingEvents: 2, movements: 1 });
    expect(scoreOf(sumMetrics([a, b])).totalPoints).toBe(scoreOf(a).totalPoints + scoreOf(b).totalPoints);
  });
});

describe("normalização por hora", () => {
  it("usa o ponto; sem ponto, a escala; sem horas → null (não zero)", () => {
    expect(normalisationHours({ hoursWorked: 8, scheduledHours: 12 })).toBe(8);
    expect(normalisationHours({ hoursWorked: 0, scheduledHours: 12 })).toBe(12);
    expect(perHour(10, 0)).toBeNull();
    expect(perHour(10, 4)).toBe(2.5);
  });

  it("ações, pontos das ações e pontuação por hora", () => {
    const day = m({ hoursWorked: 5, actions: 10, entregas: 10, weightedActions: 30 });
    const ph = perHourMetrics(day);
    expect(ph).toEqual({ hours: 5, actionsPerHour: 2, weightedPerHour: 6, pointsPerHour: 6 });
  });
});

describe("ajustes manuais", () => {
  const base = m({ movements: 2, recolhas: 1, actions: 3, speedingEvents: 1, hoursWorked: 8 });
  base.weightedActions = actionPoints(base);

  it("não alteram o calculado e ignoram anulados/métricas desconhecidas", () => {
    const copy = { ...base };
    const out = applyAdjustments(base, [
      { metric: "speedingEvents", delta: -1 },
      { metric: "delays", delta: 5, voidedAt: "2026-09-20 10:00:00" },
      { metric: "naoExiste", delta: 3 },
    ]);
    expect(base).toEqual(copy);
    expect(out.speedingEvents).toBe(0);
    expect(out.delays).toBe(0);
    expect(scoreOf(out).totalPoints - scoreOf(base).totalPoints).toBe(10);
  });

  it("ajustar partes das ações acerta o total e os pontos das ações", () => {
    const out = applyAdjustments(base, [{ metric: "entregas", delta: 2 }, { metric: "parkingMoves", delta: 1 }]);
    expect(out.actions).toBe(5);
    expect(out.parkingMoves).toBe(1);
    expect(out.weightedActions).toBe(actionPoints(out));
    expect(out.weightedActions).toBe(2 + 5 + 3 * 3);
  });

  it("contagens nunca ficam negativas; levar ao parque nunca passa os movimentos; pontos diretos podem", () => {
    const out = applyAdjustments(base, [
      { metric: "movements", delta: -5 }, { metric: "parkingMoves", delta: 3 }, { metric: "bonusPoints", delta: -7 },
    ]);
    expect(out.movements).toBe(0);
    expect(out.parkingMoves).toBe(0);
    expect(out.bonusPoints).toBe(-7);
    const s = scoreOf(out);
    expect(s.lines.find((l) => l.key === "manual")?.subtotal).toBe(-7);
  });
});

describe("dia operacional (03h→03h Lisboa, noite 15h–03h)", () => {
  it("madrugada até às 03h é a noite do dia anterior", () => {
    expect(operationalSlotFromLocal("2026-09-24", 2)).toEqual({ day: "2026-09-23", shift: "night" });
    expect(operationalSlotFromLocal("2026-09-24", 3)).toEqual({ day: "2026-09-24", shift: "morning" });
    expect(operationalSlotFromLocal("2026-09-24", 14)).toEqual({ day: "2026-09-24", shift: "morning" });
    expect(operationalSlotFromLocal("2026-09-24", 15)).toEqual({ day: "2026-09-24", shift: "night" });
  });

  it("instantes UTC em horário de verão (Lisboa = UTC+1)", () => {
    // 01:30 UTC = 02:30 Lisboa → noite do dia 23
    expect(operationalSlotOf("2026-09-24 01:30:00")).toEqual({ day: "2026-09-23", shift: "night" });
    // 02:00 UTC = 03:00 Lisboa → manhã do dia 24
    expect(operationalSlotOf("2026-09-24 02:00:00")).toEqual({ day: "2026-09-24", shift: "morning" });
    // 14:00 UTC = 15:00 Lisboa → noite do dia 24
    expect(operationalSlotOf("2026-09-24 14:00:00")).toEqual({ day: "2026-09-24", shift: "night" });
  });

  it("intervalo UTC do dia operacional, também na mudança de hora", () => {
    expect(operationalDayRangeUtc("2026-09-24")).toMatchObject({ start: "2026-09-24 02:00:00", end: "2026-09-25 02:00:00" });
    // 25 out 2026: volta à hora de inverno às 01:00 UTC → 03:00 Lisboa = 03:00 UTC
    expect(operationalDayRangeUtc("2026-10-25")).toMatchObject({ start: "2026-10-25 03:00:00", end: "2026-10-26 03:00:00" });
    // 29 mar 2026: hora de verão às 01:00 UTC → 03:00 Lisboa = 02:00 UTC
    expect(operationalDayRangeUtc("2026-03-29")).toMatchObject({ start: "2026-03-29 02:00:00" });
    expect(operationalSlotOf("2026-10-25 02:30:00")).toEqual({ day: "2026-10-24", shift: "night" });
  });

});

describe("migração 0099", async () => {
  const { MIGRATION_0099_STATEMENTS, IDEMPOTENT_ERROR_CODES_0099 } = await import("./migrations/migration_0099");
  it("idempotente: tabelas IF NOT EXISTS, códigos ignorados, sem UPDATE nem subqueries", () => {
    for (const code of ["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]) expect(IDEMPOTENT_ERROR_CODES_0099.has(code)).toBe(true);
    for (const s of MIGRATION_0099_STATEMENTS) {
      if (/^\s*CREATE TABLE/i.test(s)) expect(s).toMatch(/IF NOT EXISTS/);
      expect(s).not.toMatch(/\bUPDATE\b/i);
      expect(s).not.toMatch(/\(\s*SELECT/i);
    }
    expect(MIGRATION_0099_STATEMENTS.some((s) => s.includes("uq_employee_day_metrics"))).toBe(true);
  });
});
