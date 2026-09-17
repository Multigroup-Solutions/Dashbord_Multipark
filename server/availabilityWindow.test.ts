import { describe, expect, it } from "vitest";
import {
  coversOnDay,
  dayWindows,
  formatHourWindow,
  isAvailableOnDay,
  matchesAvailabilityWindow,
  mergeWindows,
  toExtendedWindow,
  type AvailabilityDayLike,
} from "../shared/availabilityWindow";

const day = (
  iso: string,
  patch: Partial<Omit<AvailabilityDayLike, "day">> = {},
): AvailabilityDayLike => ({ day: iso, morning: false, night: false, fromHour: null, toHour: null, ...patch });

// Semana de 14 a 20 de setembro de 2026 (segunda a domingo).
const WEEK = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"];

describe("toExtendedWindow", () => {
  it("mantém janelas dentro do mesmo dia", () => {
    expect(toExtendedWindow(8, 18)).toEqual({ from: 8, to: 18 });
  });
  it("estende para o dia seguinte quando às <= das", () => {
    expect(toExtendedWindow(18, 2)).toEqual({ from: 18, to: 26 });
    expect(toExtendedWindow(8, 8)).toEqual({ from: 8, to: 32 }); // 24h
  });
});

describe("dayWindows", () => {
  it("sem nada marcado → sem janelas", () => {
    expect(dayWindows(day("2026-09-14"))).toEqual([]);
  });
  it("manhã = 03h–15h, noite = 15h–03h(+1)", () => {
    expect(dayWindows(day("x", { morning: true }))).toEqual([{ from: 3, to: 15 }]);
    expect(dayWindows(day("x", { night: true }))).toEqual([{ from: 15, to: 27 }]);
  });
  it("manhã + noite fundem-se numa janela contínua (senão 10h–18h falhava)", () => {
    expect(dayWindows(day("x", { morning: true, night: true }))).toEqual([{ from: 3, to: 27 }]);
  });
  it("horas indicadas mandam sobre os turnos (são a janela exata)", () => {
    expect(dayWindows(day("x", { morning: true, night: true, fromHour: 9, toHour: 13 }))).toEqual([{ from: 9, to: 13 }]);
    expect(dayWindows(day("x", { fromHour: 22, toHour: 6 }))).toEqual([{ from: 22, to: 30 }]);
  });
  it("com só uma das horas, valem os turnos (uma hora sozinha não é janela)", () => {
    expect(dayWindows(day("x", { morning: true, fromHour: 9, toHour: null }))).toEqual([{ from: 3, to: 15 }]);
    expect(dayWindows(day("x", { fromHour: 9, toHour: null }))).toEqual([]);
  });
});

describe("mergeWindows", () => {
  it("funde sobreposições e contactos, ordena, deixa buracos", () => {
    expect(mergeWindows([{ from: 15, to: 27 }, { from: 3, to: 15 }])).toEqual([{ from: 3, to: 27 }]);
    expect(mergeWindows([{ from: 3, to: 8 }, { from: 10, to: 12 }])).toEqual([{ from: 3, to: 8 }, { from: 10, to: 12 }]);
    expect(mergeWindows([])).toEqual([]);
  });
});

describe("coversOnDay", () => {
  const days = [
    day(WEEK[0], { night: true }), // segunda: 15h → 03h de terça
    day(WEEK[1]), // terça: nada
    day(WEEK[2], { fromHour: 8, toHour: 20 }), // quarta: 08h–20h
  ];
  it("cobre dentro da janela do próprio dia", () => {
    expect(coversOnDay(days, 2, { from: 8, to: 18 })).toBe(true);
    expect(coversOnDay(days, 2, { from: 8, to: 20 })).toBe(true);
    expect(coversOnDay(days, 2, { from: 7, to: 18 })).toBe(false);
    expect(coversOnDay(days, 2, { from: 12, to: 21 })).toBe(false);
  });
  it("a madrugada é coberta pela noite do dia ANTERIOR", () => {
    expect(coversOnDay(days, 1, { from: 0, to: 2 })).toBe(true); // terça 00h–02h ← noite de segunda
    expect(coversOnDay(days, 1, { from: 0, to: 4 })).toBe(false); // termina depois das 03h
    expect(coversOnDay(days, 1, { from: 8, to: 12 })).toBe(false); // terça de dia: nada
  });
  it("no primeiro dia da semana não há dia anterior para consultar", () => {
    expect(coversOnDay(days, 0, { from: 0, to: 2 })).toBe(false);
  });
  it("índice fora da semana nunca cobre", () => {
    expect(coversOnDay(days, 7, { from: 8, to: 10 })).toBe(false);
  });
});

describe("matchesAvailabilityWindow", () => {
  const extra = WEEK.map((iso, i) =>
    i === 1 ? day(iso, { morning: true }) : i === 4 ? day(iso, { fromHour: 18, toHour: 1 }) : day(iso),
  );

  it("com dia escolhido só esse dia conta", () => {
    expect(matchesAvailabilityWindow(extra, WEEK[1], 8, 12)).toBe(true); // terça manhã
    expect(matchesAvailabilityWindow(extra, WEEK[2], 8, 12)).toBe(false); // quarta nada
    expect(matchesAvailabilityWindow(extra, WEEK[1], 8, 18)).toBe(false); // manhã acaba às 15h
  });

  it("sem dia, basta um dia qualquer da semana cobrir o pedido", () => {
    expect(matchesAvailabilityWindow(extra, null, 8, 12)).toBe(true);
    expect(matchesAvailabilityWindow(extra, null, 19, 0)).toBe(true); // sexta 18h–01h cobre 19h–00h
    expect(matchesAvailabilityWindow(extra, null, 19, 2)).toBe(false); // mas não até às 02h
    expect(matchesAvailabilityWindow(extra, null, 16, 20)).toBe(false); // ninguém à tarde
  });

  it("um dia fora da semana carregada nunca casa", () => {
    expect(matchesAvailabilityWindow(extra, "2026-09-21", 8, 12)).toBe(false);
  });

  it("quem não marcou nada nunca aparece", () => {
    expect(matchesAvailabilityWindow(WEEK.map((iso) => day(iso)), null, 8, 12)).toBe(false);
  });
});

describe("isAvailableOnDay", () => {
  const extra = [day(WEEK[0], { night: true }), day(WEEK[1]), day(WEEK[2], { fromHour: 8, toHour: 12 })];
  it("verdadeiro com turno ou com horas, falso sem nada ou fora da semana", () => {
    expect(isAvailableOnDay(extra, WEEK[0])).toBe(true);
    expect(isAvailableOnDay(extra, WEEK[2])).toBe(true);
    expect(isAvailableOnDay(extra, WEEK[1])).toBe(false);
    expect(isAvailableOnDay(extra, "2026-09-21")).toBe(false);
  });
});

describe("formatHourWindow", () => {
  it("rótulo com zero à esquerda e marca de dia seguinte", () => {
    expect(formatHourWindow(8, 18)).toBe("08h–18h");
    expect(formatHourWindow(18, 2)).toBe("18h–02h (dia seguinte)");
  });
});
