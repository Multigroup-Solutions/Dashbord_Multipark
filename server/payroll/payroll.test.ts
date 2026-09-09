import { describe, expect, it } from "vitest";
import { pairShifts, splitShiftHours, countableShifts } from "./shifts";
import { computeEmployeeMonth, contractDaysInMonth, expectedHoursFromSchedule } from "./compute";

// Instantes em UTC; em setembro (verão) Lisboa = UTC+1.
const utc = (day: string, hh: string) => `${day} ${hh}:00`;
const rates = { extraRateByLevel: new Map([[1, 4.5], [2, 5], [3, 5.5], [4, 6]]), extraRateByName: new Map([["junior", 4.5], ["senior", 5], ["terminal", 5.5], ["master", 6]]) };
const base = (over: Partial<Parameters<typeof computeEmployeeMonth>[0]["employee"]> = {}) => ({
  id: 1, fullName: "Teste", position: "driver", extraLevel: null, isActive: 1, monthlySalary: 1000, mealAllowancePerDay: 6, contractStart: null, contractEnd: null, ...over,
});

describe("splitShiftHours — turno repartido pelos intervalos reais (Lisboa)", () => {
  it("20h→08h de um dia útil: 9 h noturnas (22–07) e 3 h normais", () => {
    // 2026-09-08 é terça. 20h Lisboa = 19:00Z; 08h Lisboa (dia 9) = 07:00Z
    const s = splitShiftHours(new Date("2026-09-08T19:00:00Z"), new Date("2026-09-09T07:00:00Z"));
    expect(s.night).toBeCloseTo(9, 2);
    expect(s.normal).toBeCloseTo(3, 2);
    expect(s.weekend).toBe(0);
    expect(s.days).toEqual(["2026-09-08", "2026-09-09"]);
  });
  it("sábado 23h→domingo 07h: tudo fim de semana (prevalece sobre a noite)", () => {
    const s = splitShiftHours(new Date("2026-09-12T22:00:00Z"), new Date("2026-09-13T06:00:00Z"));
    expect(s.weekend).toBeCloseTo(8, 2);
    expect(s.night).toBe(0);
  });
  it("sexta 20h→sábado 02h: 2 h normais, 2 h noite, 2 h fim de semana", () => {
    // 2026-09-11 sexta 20h = 19:00Z; sábado 02h = 01:00Z
    const s = splitShiftHours(new Date("2026-09-11T19:00:00Z"), new Date("2026-09-12T01:00:00Z"));
    expect(s.normal).toBeCloseTo(2, 2);
    expect(s.night).toBeCloseTo(2, 2);
    expect(s.weekend).toBeCloseTo(2, 2);
  });
});

describe("pairShifts", () => {
  it("emparelha, marca abertos, suspeitos e órfãos", () => {
    const { shifts, orphans } = pairShifts([
      { id: 1, type: "check_in", recordedAt: utc("2026-09-08", "07:00") },
      { id: 2, type: "check_out", recordedAt: utc("2026-09-08", "15:00"), hoursWorked: "8.00" },
      { id: 3, type: "check_out", recordedAt: utc("2026-09-09", "15:00"), hoursWorked: "8.00" },     // órfão
      { id: 4, type: "check_in", recordedAt: utc("2026-09-10", "07:00") },
      { id: 5, type: "check_out", recordedAt: utc("2026-09-11", "07:00"), hoursWorked: "12.00", notes: "[SUSPEITO] check-out esquecido — cortado a 12h" },
      { id: 6, type: "check_in", recordedAt: utc("2026-09-12", "07:00") },                          // aberto
    ]);
    expect(orphans.map((o) => o.id)).toEqual([3]);
    expect(shifts.map((s) => s.status)).toEqual(["ok", "suspicious", "open"]);
    expect(shifts[0].hours).toBe(8);
    expect(shifts[1].hours).toBe(12);
    expect(countableShifts(shifts)).toHaveLength(1);
  });
  it("saída cortada a 12h reparte só as 12 h a partir da entrada", () => {
    const { shifts } = pairShifts([
      { id: 1, type: "check_in", recordedAt: utc("2026-09-08", "19:00") },
      { id: 2, type: "check_out", recordedAt: utc("2026-09-10", "19:00"), hoursWorked: "12.00", reviewStatus: "approved" },
    ]);
    expect(shifts[0].status).toBe("approved");
    expect(shifts[0].split.night + shifts[0].split.normal + shifts[0].split.weekend).toBeCloseTo(12, 1);
  });
});

describe("computeEmployeeMonth — cenários da auditoria", () => {
  const shift = (inUtc: string, outUtc: string, extra: Partial<ReturnType<typeof pairShifts>["shifts"][number]> = {}) => {
    const { shifts } = pairShifts([{ id: 1, type: "check_in", recordedAt: inUtc }, { id: 2, type: "check_out", recordedAt: outUtc, hoursWorked: String((new Date(outUtc.replace(" ", "T") + "Z").getTime() - new Date(inUtc.replace(" ", "T") + "Z").getTime()) / 3600000) }]);
    return { ...shifts[0], ...extra };
  };

  it("turno 20h→08h paga 9 h noturnas (antes: 0) e conta 1 dia (o de entrada)", () => {
    const r = computeEmployeeMonth({ employee: base(), year: 2026, month: 9, shifts: [shift(utc("2026-09-08", "19:00"), utc("2026-09-09", "07:00"))], leaves: [], ...rates });
    expect(r.nightHours).toBeCloseTo(9, 2);
    expect(r.nightPayment).toBeCloseTo(9 * (1000 / 176) * 0.25, 2);
    expect(r.daysWorked).toBe(1);
    expect(r.mealAllowance).toBe(6);
  });
  it("contrato que começa no mês seguinte: 0 de base, sem provisões", () => {
    const r = computeEmployeeMonth({ employee: base({ contractStart: "2026-10-01" }), year: 2026, month: 9, shifts: [], leaves: [], ...rates });
    expect(r.inContract).toBe(false);
    expect(r.baseSalary).toBe(0);
    expect(r.thirteenthProvision).toBe(0);
    expect(r.totalPayment).toBe(0);
  });
  it("contrato a começar a meio do mês: base proporcional aos dias do mês", () => {
    const r = computeEmployeeMonth({ employee: base({ contractStart: "2026-09-16" }), year: 2026, month: 9, shifts: [], leaves: [], ...rates });
    expect(r.contractDays).toBe(15);
    expect(r.baseSalary).toBeCloseTo(1000 * 15 / 30, 2);
  });
  it("ausência não remunerada de um mês inteiro: base 0; férias não reduzem", () => {
    const unpaid = computeEmployeeMonth({ employee: base(), year: 2026, month: 9, shifts: [], leaves: [{ leaveType: "unpaid", fromDate: "2026-09-01", toDate: "2026-09-30" }], ...rates });
    expect(unpaid.baseSalary).toBe(0);
    expect(unpaid.unpaidDays).toBe(30);
    const vac = computeEmployeeMonth({ employee: base(), year: 2026, month: 9, shifts: [], leaves: [{ leaveType: "vacation", fromDate: "2026-09-01", toDate: "2026-09-10" }], ...rates });
    expect(vac.baseSalary).toBe(1000);
  });
  it("entrada sem saída: 0 h, 0 dias, 0 alimentação, fica em aviso", () => {
    const { shifts } = pairShifts([{ id: 1, type: "check_in", recordedAt: utc("2026-09-08", "07:00") }]);
    const r = computeEmployeeMonth({ employee: base(), year: 2026, month: 9, shifts, leaves: [], ...rates });
    expect(r.totalHours).toBe(0);
    expect(r.daysWorked).toBe(0);
    expect(r.mealAllowance).toBe(0);
    expect(r.openShifts).toBe(1);
  });
  it("turno suspeito não é pago até revisão; aprovado paga", () => {
    const s = shift(utc("2026-09-08", "07:00"), utc("2026-09-08", "19:00"));
    const susp = computeEmployeeMonth({ employee: base({ position: "extra", extraLevel: 2 }), year: 2026, month: 9, shifts: [{ ...s, status: "suspicious" }], leaves: [], ...rates });
    expect(susp.extraPayment).toBe(0);
    expect(susp.suspiciousHours).toBe(12);
    const ok = computeEmployeeMonth({ employee: base({ position: "extra", extraLevel: 2 }), year: 2026, month: 9, shifts: [{ ...s, status: "approved" }], leaves: [], ...rates });
    expect(ok.extraPayment).toBe(60);
  });
  it("extra nível 5 sem taxa: 0 € com aviso, em vez de cair em junior", () => {
    const s = shift(utc("2026-09-08", "07:00"), utc("2026-09-08", "15:00"));
    const r = computeEmployeeMonth({ employee: base({ position: "extra", extraLevel: 5 }), year: 2026, month: 9, shifts: [s], leaves: [], ...rates });
    expect(r.extraPayment).toBe(0);
    expect(r.warnings.some((w) => w.includes("nível de extra 5"))).toBe(true);
    const withRate = computeEmployeeMonth({ employee: base({ position: "extra", extraLevel: 5 }), year: 2026, month: 9, shifts: [s], leaves: [], extraRateByLevel: new Map([[5, 7]]), extraRateByName: new Map() });
    expect(withRate.extraPayment).toBe(56);
  });
  it("horas extra usam o horário individual quando existe", () => {
    const sched = [1, 2, 3, 4, 5].map((wd) => ({ weekday: wd, startTime: "09:00", endTime: "13:00", isWorkDay: 1 })); // 4 h/dia útil
    const exp = expectedHoursFromSchedule(sched, "2026-09-01", "2026-09-30");
    expect(exp).toBe(88); // 22 dias úteis × 4 h
    const shifts = [1, 2, 3, 4, 7, 8, 9, 10, 11, 14, 15].map((d) => shift(utc(`2026-09-${String(d).padStart(2, "0")}`, "08:00"), utc(`2026-09-${String(d).padStart(2, "0")}`, "18:00"))); // 11 × 10 h = 110 h
    const r = computeEmployeeMonth({ employee: base(), year: 2026, month: 9, shifts, leaves: [], schedules: sched, ...rates });
    expect(r.expectedHours).toBe(88);
    expect(r.overtimeHours).toBeCloseTo(22, 1);
  });
  it("fevereiro completo = salário mensal; dias de vínculo corretos", () => {
    expect(contractDaysInMonth(base(), 2026, 2).days).toBe(28);
    expect(contractDaysInMonth(base({ contractEnd: "2026-02-10" }), 2026, 2).days).toBe(10);
    const r = computeEmployeeMonth({ employee: base(), year: 2026, month: 2, shifts: [], leaves: [], ...rates });
    expect(r.baseSalary).toBe(1000);
  });
});
