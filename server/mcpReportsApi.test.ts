import { describe, expect, it } from "vitest";
import { dedupeDriverDays, parseRange, summarizeCounts, summarizeDrivers, type CountRow, type DriverDayRow } from "./mcpReportsApi";

describe("parseRange", () => {
  it("aceita um intervalo válido", () => {
    expect(parseRange("2026-10-01", "2026-10-07")).toEqual({ from: "2026-10-01", to: "2026-10-07" });
  });
  it("exige from e to", () => {
    expect(parseRange(undefined, "2026-10-07")).toEqual({ error: "from e to (AAAA-MM-DD) são obrigatórios" });
    expect(parseRange("2026-10-01", "")).toEqual({ error: "from e to (AAAA-MM-DD) são obrigatórios" });
  });
  it("rejeita formato errado e datas impossíveis", () => {
    expect("error" in parseRange("01/10/2026", "2026-10-07")).toBe(true);
    expect("error" in parseRange("2026-13-01", "2026-13-02")).toBe(true);
  });
  it("rejeita from depois de to", () => {
    expect("error" in parseRange("2026-10-08", "2026-10-07")).toBe(true);
  });
  it("limita a 366 dias", () => {
    expect("error" in parseRange("2025-01-01", "2026-01-02")).toBe(true);
    expect("error" in parseRange("2026-01-01", "2026-12-31")).toBe(false);
  });
});

const row = (o: Partial<CountRow>): CountRow => ({
  parkId: "p1", parkName: "Airpark", city: "lisbon", day: "2026-10-01",
  receivedCash: 0, expensesCash: 0, expectedCash: 0, countedAmount: 0, difference: 0, ...o,
});

describe("summarizeCounts", () => {
  it("soma o período, por dia e por cidade", () => {
    const s = summarizeCounts([
      row({ parkId: "a", day: "2026-10-01", receivedCash: 500, expensesCash: 20, expectedCash: 480, countedAmount: 470, difference: -10 }),
      row({ parkId: "b", day: "2026-10-01", city: "porto", receivedCash: 300, expectedCash: 300, countedAmount: 300, difference: 0 }),
      row({ parkId: "a", day: "2026-10-02", receivedCash: 100, expectedCash: 100, countedAmount: 105.5, difference: 5.5 }),
    ]);
    expect(s.total).toMatchObject({ received: 900, expenses: 20, expected: 880, counted: 875.5, difference: -4.5, counts: 3, countsWithDifference: 2, daysWithDifference: 2 });
    expect(s.byDay.map((d) => [d.day, d.difference, d.daysWithDifference])).toEqual([["2026-10-01", -10, 1], ["2026-10-02", 5.5, 1]]);
    const lisboa = s.byCity.find((c) => c.city === "lisbon")!;
    expect(lisboa).toMatchObject({ counts: 2, difference: -4.5, countsWithDifference: 2, daysWithDifference: 2 });
    expect(s.byCity.find((c) => c.city === "porto")).toMatchObject({ counts: 1, difference: 0, daysWithDifference: 0 });
  });
  it("diferenças que se anulam no mesmo dia não contam como dia com diferença", () => {
    const s = summarizeCounts([row({ parkId: "a", difference: 10 }), row({ parkId: "b", difference: -10 })]);
    expect(s.total.countsWithDifference).toBe(2);
    expect(s.total.daysWithDifference).toBe(0);
  });
  it("arredonda a dois decimais sem erros de vírgula flutuante", () => {
    const s = summarizeCounts([row({ difference: 0.1 }), row({ parkId: "b", difference: 0.2 })]);
    expect(s.total.difference).toBe(0.3);
  });
  it("cidade desconhecida fica agrupada à parte", () => {
    const s = summarizeCounts([row({ city: null, difference: 1 })]);
    expect(s.byCity[0].city).toBe("(sem cidade)");
  });
  it("sem linhas dá zeros", () => {
    const s = summarizeCounts([]);
    expect(s.total.counts).toBe(0);
    expect(s.byDay).toEqual([]);
  });
});

const drv = (o: Partial<DriverDayRow>): DriverDayRow => ({
  key: "e1", employeeId: 1, name: "Ana", day: "2026-10-01", collectionPass: "final",
  totalKm: 0, hoursWorked: 0, hoursStopped: 0, totalHoursOnline: 0, avgSpeed: 0, maxSpeed: 0, speedViolations: 0, avgBattery: 0, minBattery: 0, ...o,
});

describe("dedupeDriverDays", () => {
  it("a recolha final substitui a provisória do mesmo condutor e dia", () => {
    const out = dedupeDriverDays([drv({ collectionPass: "sameday", hoursWorked: 5 }), drv({ collectionPass: "final", hoursWorked: 7 })]);
    expect(out).toHaveLength(1);
    expect(out[0].hoursWorked).toBe(7);
  });
  it("mantém a provisória quando ainda não há final", () => {
    const out = dedupeDriverDays([drv({ collectionPass: "sameday", hoursWorked: 5 })]);
    expect(out[0].collectionPass).toBe("sameday");
  });
  it("condutores e dias diferentes não se misturam", () => {
    const out = dedupeDriverDays([drv({}), drv({ day: "2026-10-02" }), drv({ key: "e2", employeeId: 2, name: "Rui" })]);
    expect(out).toHaveLength(3);
  });
});

describe("summarizeDrivers", () => {
  it("resume horas, km, velocidades e bateria por condutor", () => {
    const s = summarizeDrivers([
      drv({ day: "2026-10-01", totalKm: 40, hoursWorked: 8, hoursStopped: 1, avgSpeed: 30, maxSpeed: 90, speedViolations: 2, minBattery: 20 }),
      drv({ day: "2026-10-02", totalKm: 60, hoursWorked: 6, hoursStopped: 2, avgSpeed: 40, maxSpeed: 110, speedViolations: 1, minBattery: 12 }),
      drv({ key: "e2", employeeId: 2, name: "Rui", totalKm: 10, hoursWorked: 0 }),
    ]);
    const ana = s.find((x) => x.name === "Ana")!;
    expect(ana).toMatchObject({ days: 2, totalKm: 100, hoursWorked: 14, hoursStopped: 3, avgHoursPerDay: 7, kmPerHour: 7.14, avgSpeed: 35, maxSpeed: 110, speedViolations: 3, minBattery: 12 });
    expect(s[0].name).toBe("Ana");
    expect(s.find((x) => x.name === "Rui")).toMatchObject({ kmPerHour: null, avgSpeed: 0, minBattery: null });
  });
});
