import { describe, expect, it } from "vitest";
import {
  dayWindows,
  formatHourWindow,
  isAvailableOnDay,
  matchesAvailabilityWindow,
  mergeWindows,
  overlapsOnDay,
  toExtendedWindow,
  windowCovers,
  windowsOverlap,
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
  it("manhã + noite fundem-se numa janela contínua", () => {
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

describe("windowsOverlap / windowCovers", () => {
  it("sobreposição parcial conta, tocar nas pontas não", () => {
    expect(windowsOverlap({ from: 5, to: 10 }, { from: 2, to: 10 })).toBe(true);
    expect(windowsOverlap({ from: 3, to: 15 }, { from: 14, to: 20 })).toBe(true);
    expect(windowsOverlap({ from: 3, to: 15 }, { from: 15, to: 20 })).toBe(false);
    expect(windowsOverlap({ from: 3, to: 8 }, { from: 10, to: 12 })).toBe(false);
  });
  it("cobertura total continua disponível como regra à parte", () => {
    expect(windowCovers({ from: 3, to: 15 }, { from: 5, to: 10 })).toBe(true);
    expect(windowCovers({ from: 5, to: 10 }, { from: 2, to: 10 })).toBe(false);
  });
});

describe("overlapsOnDay", () => {
  const days = [
    day(WEEK[0], { night: true }), // segunda: 15h → 03h de terça
    day(WEEK[1]), // terça: nada
    day(WEEK[2], { fromHour: 8, toHour: 20 }), // quarta: 08h–20h
  ];
  it("conta quem pode em parte do pedido, não só quem o cobre todo", () => {
    expect(overlapsOnDay(days, 2, { from: 8, to: 18 })).toBe(true);
    expect(overlapsOnDay(days, 2, { from: 2, to: 10 })).toBe(true); // só pode a partir das 8h — conta
    expect(overlapsOnDay(days, 2, { from: 12, to: 23 })).toBe(true); // só até às 20h — conta
    expect(overlapsOnDay(days, 2, { from: 20, to: 23 })).toBe(false); // começa quando a pessoa acaba
    expect(overlapsOnDay(days, 2, { from: 2, to: 8 })).toBe(false); // acaba quando a pessoa começa
  });
  it("a madrugada é servida pela noite do dia ANTERIOR", () => {
    expect(overlapsOnDay(days, 1, { from: 0, to: 2 })).toBe(true); // terça 00h–02h ← noite de segunda
    expect(overlapsOnDay(days, 1, { from: 0, to: 6 })).toBe(true); // até às 03h ainda pode
    expect(overlapsOnDay(days, 1, { from: 3, to: 6 })).toBe(false); // a noite acaba às 03h
    expect(overlapsOnDay(days, 1, { from: 8, to: 12 })).toBe(false); // terça de dia: nada
  });
  it("no primeiro dia da semana não há dia anterior para consultar", () => {
    expect(overlapsOnDay(days, 0, { from: 0, to: 2 })).toBe(false);
  });
  it("índice fora da semana nunca conta", () => {
    expect(overlapsOnDay(days, 7, { from: 8, to: 10 })).toBe(false);
  });
});

describe("matchesAvailabilityWindow", () => {
  const extra = WEEK.map((iso, i) =>
    i === 1 ? day(iso, { morning: true }) : i === 4 ? day(iso, { fromHour: 18, toHour: 1 }) : day(iso),
  );

  it("com dia escolhido só esse dia conta", () => {
    expect(matchesAvailabilityWindow(extra, WEEK[1], 8, 12)).toBe(true); // terça manhã
    expect(matchesAvailabilityWindow(extra, WEEK[2], 8, 12)).toBe(false); // quarta nada
    expect(matchesAvailabilityWindow(extra, WEEK[1], 8, 18)).toBe(true); // manhã até às 15h — sobrepõe
    expect(matchesAvailabilityWindow(extra, WEEK[1], 15, 18)).toBe(false); // começa quando a manhã acaba
  });

  it("alargar o pedido nunca faz desaparecer quem já contava (caso do Jorge: 5h–10h ⊂ 2h–10h)", () => {
    const seg5as10 = WEEK.map((iso, i) => (i === 0 ? day(iso, { fromHour: 5, toHour: 10 }) : day(iso)));
    const seg2as10 = WEEK.map((iso, i) => (i === 0 ? day(iso, { fromHour: 2, toHour: 10 }) : day(iso)));
    for (const person of [seg5as10, seg2as10]) {
      expect(matchesAvailabilityWindow(person, WEEK[0], 5, 10)).toBe(true);
      expect(matchesAvailabilityWindow(person, WEEK[0], 2, 10)).toBe(true);
    }
  });

  it("sem dia, basta um dia qualquer da semana ter sobreposição", () => {
    expect(matchesAvailabilityWindow(extra, null, 8, 12)).toBe(true);
    expect(matchesAvailabilityWindow(extra, null, 19, 0)).toBe(true); // sexta 18h–01h
    expect(matchesAvailabilityWindow(extra, null, 19, 2)).toBe(true); // sobrepõe até à 01h
    expect(matchesAvailabilityWindow(extra, null, 16, 17)).toBe(false); // ninguém entre as 15h e as 18h
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
