import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: async () => null, getDocumentChecklistForEmployee: vi.fn(), getPayrollData: vi.fn(), toMysqlDateTime: (d: Date) => d.toISOString().slice(0, 19).replace("T", " ") }));

import { DEFAULT_EXTRA_RATES, rateFor, ratesFromRows } from "./extraRates";
import { computeAssignmentCost } from "./extrasDia";
import { noShowWindow } from "./rhService";

describe("tarifas dos extras (fonte única)", () => {
  it("valores por defeito: júnior 4,5 · sénior 5 · terminal 5,5 · master 6", () => {
    expect(DEFAULT_EXTRA_RATES).toEqual({ junior: 4.5, senior: 5, terminal: 5.5, master: 6 });
  });
  it("a tabela manda — por nome ou pelo número do nível; linhas inválidas ignoradas", () => {
    const r = ratesFromRows([
      { level: 1, levelName: null, hourlyRate: "4.80" },
      { level: null, levelName: "Master", hourlyRate: 7 },
      { level: 2, levelName: "senior", hourlyRate: "0" },
    ]);
    expect(r).toMatchObject({ junior: 4.8, senior: 5, terminal: 5.5, master: 7 });
  });
  it("rateFor aceita nome da escala ou nível numérico da ficha; desconhecido → júnior", () => {
    const r = { ...DEFAULT_EXTRA_RATES, master: 6.5 };
    expect(rateFor(r, "master")).toBe(6.5);
    expect(rateFor(r, 4)).toBe(6.5);
    expect(rateFor(r, 3)).toBe(5.5);
    expect(rateFor(r, null)).toBe(4.5);
    expect(rateFor(r, 9)).toBe(4.5);
  });
  it("o custo da escala usa as tarifas vivas", () => {
    const row = { startHour: 8, endHour: 12, sentHomeHour: null, level: "senior" as const, isTeamLeader: false };
    expect(computeAssignmentCost(row)).toMatchObject({ hoursBilled: 4, cost: 20 });
    expect(computeAssignmentCost(row, { ...DEFAULT_EXTRA_RATES, senior: 6 })).toMatchObject({ cost: 24 });
  });
});

describe("janela da falta por turno", () => {
  it("turno de dia: 2 h antes do início até 1 h depois do fim", () => {
    const w = noShowWindow("2026-09-20", 8, 16);
    expect(w.from.toISOString()).toBe("2026-09-20T06:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-09-20T17:00:00.000Z");
  });
  it("turno da madrugada (startHour 25) cai no dia seguinte — já não dá falta falsa", () => {
    const w = noShowWindow("2026-09-20", 25, 30);
    expect(w.from.toISOString()).toBe("2026-09-20T23:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-09-21T07:00:00.000Z");
  });
  it("sem fim válido → 8 h de turno", () => {
    expect(noShowWindow("2026-09-20", 10, null).to.toISOString()).toBe("2026-09-20T19:00:00.000Z");
  });
});
