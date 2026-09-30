import { describe, expect, it } from "vitest";
import { pontoShiftHours } from "../shared/pontoHours";
import { countableShifts, pairShifts } from "./payroll/shifts";
import { pairPonto } from "./evaluationCore";

// Registo de ponto aprovado com 0 h pagava as horas picadas (o 0 era lido como
// "sem valor"). Regra única em shared/pontoHours.ts para ordenado e avaliação.
describe("horas do turno (regra única)", () => {
  it("saída aprovada com 0 h → 0 h", () => {
    expect(pontoShiftHours({ outRec: { hoursWorked: "0.00", reviewStatus: "approved" }, realHours: 12 })).toBe(0);
  });
  it("saída aprovada sem correção → horas da saída (como antes)", () => {
    expect(pontoShiftHours({ outRec: { hoursWorked: "8.50", reviewStatus: "approved" }, realHours: 9 })).toBe(8.5);
  });
  it("entrada aprovada com horas corrigidas → a correção", () => {
    expect(pontoShiftHours({ inRec: { hoursWorked: "7.00", reviewStatus: "approved" }, outRec: { hoursWorked: "12.00", reviewStatus: "ok" }, realHours: 13 })).toBe(7);
  });
  it("entrada aprovada sem horas → segue a saída", () => {
    expect(pontoShiftHours({ inRec: { hoursWorked: null, reviewStatus: "approved" }, outRec: { hoursWorked: "6.25", reviewStatus: "ok" }, realHours: 6.3 })).toBe(6.25);
  });
  it("saída cortada às 12 h e não aprovada → 12 h (como antes)", () => {
    expect(pontoShiftHours({ outRec: { hoursWorked: "12.00", reviewStatus: "suspicious" }, realHours: 15 })).toBe(12);
  });
  it("0.00 sem aprovação → diferença real (como antes)", () => {
    expect(pontoShiftHours({ outRec: { hoursWorked: "0.00", reviewStatus: "ok" }, realHours: 0.004 })).toBe(0);
    expect(pontoShiftHours({ outRec: { hoursWorked: null, reviewStatus: "ok" }, realHours: 3.456 })).toBe(3.46);
  });
});

describe("folha: aprovado com 0 h não paga", () => {
  const recs = (outStatus: "ok" | "approved", hours: string) => [
    { id: 1, type: "check_in" as const, recordedAt: "2026-09-10 20:00:00" },
    { id: 2, type: "check_out" as const, recordedAt: "2026-09-11 08:00:00", hoursWorked: hours, reviewStatus: outStatus },
  ];
  it("turno de 12 h aprovado com 0 h → 0 h e sem noite", () => {
    const [s] = countableShifts(pairShifts(recs("approved", "0.00")).shifts);
    expect(s.hours).toBe(0);
    expect(s.split).toEqual({ normal: 0, night: 0, weekend: 0 });
  });
  it("turno normal continua igual", () => {
    const [s] = countableShifts(pairShifts(recs("ok", "12.00")).shifts);
    expect(s.hours).toBe(12);
    expect(s.split.night).toBeGreaterThan(0);
  });
  it("avaliação usa a mesma regra", () => {
    const [s] = pairPonto(recs("approved", "0.00").map((r) => ({ ...r, employeeId: 7 })));
    expect(s.hours).toBe(0);
  });
});
