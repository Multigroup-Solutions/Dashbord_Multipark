import { describe, expect, it } from "vitest";
import {
  addDaysIso, availableWindow, coverageGaps, describeGaps, dueTasks, fmtWeek, fmtWorkDay, lisbonClock, planAutofill,
  type AutofillCandidate,
} from "./extrasAutomation";

describe("relógio de Lisboa e horários", () => {
  it("converte UTC para a hora de Lisboa (verão = UTC+1)", () => {
    expect(lisbonClock(new Date("2026-09-24T09:30:00Z"))).toEqual({ date: "2026-09-24", dow: 4, hour: 10 });
    expect(lisbonClock(new Date("2026-09-27T23:30:00Z"))).toEqual({ date: "2026-09-28", dow: 1, hour: 0 });
  });
  it("quinta ≥10h: pedido da semana seguinte; antes das 10h ainda não", () => {
    expect(dueTasks({ date: "2026-09-24", dow: 4, hour: 10 }).weeklyRequest).toBe("2026-09-28");
    expect(dueTasks({ date: "2026-09-24", dow: 4, hour: 9 }).weeklyRequest).toBeNull();
    expect(dueTasks({ date: "2026-09-25", dow: 5, hour: 12 }).weeklyRequest).toBeNull();
  });
  it("sábado ≥10h: lembrete para a mesma semana", () => {
    expect(dueTasks({ date: "2026-09-26", dow: 6, hour: 11 }).reminder).toBe("2026-09-28");
  });
  it("todos os dias ≥18h: aviso e cobertura de amanhã", () => {
    expect(dueTasks({ date: "2026-09-30", dow: 3, hour: 18 }).tomorrow).toBe("2026-10-01");
    expect(dueTasks({ date: "2026-09-30", dow: 3, hour: 17 }).tomorrow).toBeNull();
  });
  it("addDaysIso atravessa meses", () => expect(addDaysIso("2026-09-30", 2)).toBe("2026-10-02"));
});

describe("textos das mensagens", () => {
  it("dia do trabalho com horas da madrugada", () => {
    expect(fmtWorkDay("2026-09-25", 6, 14)).toBe("sexta 25/09, das 06h às 14h");
    expect(fmtWorkDay("2026-09-25", 15, 27)).toBe("sexta 25/09, das 15h às 03h");
  });
  it("semana", () => expect(fmtWeek("2026-09-28")).toBe("semana de 28/09 a 04/10"));
});

describe("cobertura", () => {
  const needed = Array.from({ length: 27 }, (_, h) => (h >= 6 && h < 9 ? 3 : h === 9 ? 1 : 0));
  it("horas com menos gente do que a previsão (mandado p/ casa conta)", () => {
    const gaps = coverageGaps(needed, [
      { startHour: 6, endHour: 14 },
      { startHour: 6, endHour: 14, sentHomeHour: 8 },
    ]);
    expect(gaps).toEqual([
      { hour: 6, needed: 3, have: 2 },
      { hour: 7, needed: 3, have: 2 },
      { hour: 8, needed: 3, have: 1 },
    ]);
    expect(describeGaps(gaps, 1)).toBe("06h (precisas 3, tens 2) e mais 2h");
  });
  it("tudo coberto → sem alertas", () => {
    expect(coverageGaps(needed, [{ startHour: 6, endHour: 10 }, { startHour: 6, endHour: 10 }, { startHour: 6, endHour: 10 }])).toEqual([]);
  });
});

describe("preencher a escala com disponíveis", () => {
  const cand = (id: number, name: string, availability: AutofillCandidate["availability"], cityMatch: boolean | null = true): AutofillCandidate =>
    ({ id, fullName: name, level: "junior", availability, cityMatch });
  const yes = (o: Partial<NonNullable<AutofillCandidate["availability"]>> = {}) => ({ status: "available", morning: true, night: false, fromHour: null, toHour: null, ...o });

  it("janela disponível por turno e horas", () => {
    expect(availableWindow(yes(), "morning")).toEqual({ from: 3, to: 15 });
    expect(availableWindow(yes(), "night")).toBeNull();
    expect(availableWindow(yes({ morning: false, fromHour: 10, toHour: 20 }), "morning")).toEqual({ from: 10, to: 15 });
    expect(availableWindow(yes({ fromHour: 13, toHour: 20 }), "morning")).toBeNull(); // só 2h no turno
    expect(availableWindow({ ...yes(), status: "no_response" }, "morning")).toBeNull();
  });

  it("já escalados cobrem os turnos maiores; cidade certa primeiro; outra cidade nunca", () => {
    const r = planAutofill(
      [{ startHour: 6, endHour: 14 }, { startHour: 7, endHour: 11 }, { startHour: 8, endHour: 12 }],
      1,
      [
        cand(1, "Ana", yes(), null),
        cand(2, "Bruno", yes(), false),
        cand(3, "Carla", yes()),
        cand(4, "Duarte", yes()),
      ],
      "morning",
      new Set([4]),
    );
    expect(r.picks.map((p) => [p.employeeId, p.startHour, p.endHour])).toEqual([[3, 7, 11], [1, 8, 12]]);
    expect(r.unfilled).toEqual([]);
  });

  it("encurta ao que a pessoa pode e deixa por preencher quando não há ninguém", () => {
    const r = planAutofill(
      [{ startHour: 6, endHour: 14 }, { startHour: 6, endHour: 10 }],
      0,
      [cand(1, "Ana", yes({ morning: false, fromHour: 9, toHour: 14 }))],
      "morning",
      new Set(),
    );
    expect(r.picks).toEqual([{ employeeId: 1, personName: "Ana", level: "junior", startHour: 9, endHour: 14 }]);
    expect(r.unfilled).toEqual([{ startHour: 6, endHour: 10 }]);
  });
});
