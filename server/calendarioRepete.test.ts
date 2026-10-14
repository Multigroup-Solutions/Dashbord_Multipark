/**
 * Calendário → Novo evento que se repete (Jorge, 14 out 2026). A regra RRULE
 * é montada no servidor a partir da escolha (frequência + fim) e do dia de
 * início; o browser nunca manda uma RRULE em texto. Sem rede nem BD.
 */
import { describe, expect, it } from "vitest";
import {
  CALENDAR_MAX_REPEAT_COUNT, buildCalendarRRule, calendarRepeatLabel, calendarRepeatNote, createCalendarEventSchema, describeCalendarRecurrence,
  newCalendarEventBody, rruleUtcBasic, validateNewCalendarEvent,
} from "../shared/calendarView";
import { GOOGLE_FEATURE_SCOPES } from "../shared/mail";
import { createMyCalendarEvent, type CalendarViewApi, type CalendarViewDeps } from "./google/calendarView";

const NOW = Date.parse("2026-10-07T10:00:00Z");
// 13 out 2026 é uma terça-feira.
const base = { title: "Reunião semanal", startDay: "2026-10-13", endDay: "2026-10-13", startTime: "10:00", endTime: "11:00" };

describe("regra RRULE", () => {
  it("todos os dias / todos os anos: só a frequência", () => {
    expect(buildCalendarRRule({ freq: "daily" }, { startDay: "2026-10-13", allDay: false })).toBe("RRULE:FREQ=DAILY");
    expect(buildCalendarRRule({ freq: "yearly", end: { kind: "never" } }, { startDay: "2026-10-13", allDay: true })).toBe("RRULE:FREQ=YEARLY");
  });

  it("semanal: BYDAY do dia da semana do início (terça → TU, domingo → SU)", () => {
    expect(buildCalendarRRule({ freq: "weekly" }, { startDay: "2026-10-13", allDay: false })).toBe("RRULE:FREQ=WEEKLY;BYDAY=TU");
    expect(buildCalendarRRule({ freq: "weekly" }, { startDay: "2026-10-18", allDay: false })).toBe("RRULE:FREQ=WEEKLY;BYDAY=SU");
    expect(buildCalendarRRule({ freq: "weekly" }, { startDay: "2026-10-12", allDay: true })).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO");
  });

  it("mensal: BYMONTHDAY do dia do início (dia 5; dia 31 fica 31 — os meses sem 31 não têm evento)", () => {
    expect(buildCalendarRRule({ freq: "monthly" }, { startDay: "2026-11-05", allDay: false })).toBe("RRULE:FREQ=MONTHLY;BYMONTHDAY=5");
    expect(buildCalendarRRule({ freq: "monthly" }, { startDay: "2026-10-31", allDay: false })).toBe("RRULE:FREQ=MONTHLY;BYMONTHDAY=31");
    expect(calendarRepeatNote("monthly", "2026-10-31")).toBe("Nos meses sem dia 31, não há evento.");
    expect(calendarRepeatNote("monthly", "2026-10-29")).toBe("Nos meses sem dia 29, não há evento.");
    expect(calendarRepeatNote("monthly", "2026-10-28")).toBeNull();
    expect(calendarRepeatNote("yearly", "2028-02-29")).toBe("Só nos anos bissextos.");
    expect(calendarRepeatNote("weekly", "2026-10-31")).toBeNull();
  });

  it("\"Termina em\" com horas: UNTIL no formato básico UTC, fim desse dia em Lisboa (verão +1, inverno +0)", () => {
    expect(rruleUtcBasic(Date.parse("2026-12-31T23:59:59.000Z"))).toBe("20261231T235959Z");
    // dezembro (inverno, UTC+0): 23:59:59 de Lisboa = 23:59:59Z
    expect(buildCalendarRRule({ freq: "weekly", end: { kind: "until", untilDay: "2026-12-29" } }, { startDay: "2026-10-13", allDay: false }))
      .toBe("RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261229T235959Z");
    // agosto (verão, UTC+1): 23:59:59 de Lisboa = 22:59:59Z
    expect(buildCalendarRRule({ freq: "daily", end: { kind: "until", untilDay: "2027-08-10" } }, { startDay: "2026-10-13", allDay: false }))
      .toBe("RRULE:FREQ=DAILY;UNTIL=20270810T225959Z");
  });

  it("\"Termina em\" num evento de dia inteiro: UNTIL é a data (como o Google faz)", () => {
    expect(buildCalendarRRule({ freq: "monthly", end: { kind: "until", untilDay: "2027-03-05" } }, { startDay: "2026-11-05", allDay: true }))
      .toBe("RRULE:FREQ=MONTHLY;BYMONTHDAY=5;UNTIL=20270305");
  });

  it("\"Termina após N vezes\": COUNT", () => {
    expect(buildCalendarRRule({ freq: "weekly", end: { kind: "count", count: 10 } }, { startDay: "2026-10-13", allDay: false }))
      .toBe("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10");
  });
});

describe("texto das opções", () => {
  it("a partir do dia de início, em português", () => {
    expect(calendarRepeatLabel("daily", "2026-10-13")).toBe("Todos os dias");
    expect(calendarRepeatLabel("weekly", "2026-10-13")).toBe("Todas as semanas à terça-feira");
    expect(calendarRepeatLabel("weekly", "2026-10-17")).toBe("Todas as semanas ao sábado");
    expect(calendarRepeatLabel("weekly", "2026-10-18")).toBe("Todas as semanas ao domingo");
    expect(calendarRepeatLabel("monthly", "2026-11-05")).toBe("Todos os meses no dia 5");
    expect(calendarRepeatLabel("yearly", "2026-10-14")).toBe("Todos os anos a 14 de outubro");
    expect(calendarRepeatLabel("weekly", "")).toBe("Todas as semanas");
    expect(describeCalendarRecurrence({ freq: "weekly", end: { kind: "until", untilDay: "2026-12-29" } }, "2026-10-13")).toBe("Todas as semanas à terça-feira · até 29/12/2026");
    expect(describeCalendarRecurrence({ freq: "daily", end: { kind: "count", count: 5 } }, "2026-10-13")).toBe("Todos os dias · 5 vezes");
  });
});

describe("validação (estrita: nunca uma RRULE do browser)", () => {
  it("o esquema só aceita a escolha: frequências conhecidas, fim never/until/count, nada de texto livre", () => {
    expect(createCalendarEventSchema.safeParse({ ...base, recurrence: { freq: "weekly" } }).success).toBe(true);
    expect(createCalendarEventSchema.safeParse({ ...base, recurrence: null }).success).toBe(true);
    expect(createCalendarEventSchema.safeParse({ ...base, recurrence: "RRULE:FREQ=SECONDLY" }).success).toBe(false);
    expect(createCalendarEventSchema.safeParse({ ...base, recurrence: { freq: "hourly" } }).success).toBe(false);
    expect(createCalendarEventSchema.safeParse({ ...base, recurrence: { freq: "weekly", rrule: "RRULE:FREQ=SECONDLY" } }).success).toBe(false);
    expect(createCalendarEventSchema.safeParse({ ...base, recurrence: { freq: "weekly", end: { kind: "until", untilDay: "2026-12-29;COUNT=9" } } }).success).toBe(false);
    expect(createCalendarEventSchema.safeParse({ ...base, recurrence: { freq: "weekly", end: { kind: "count", count: 1 } } }).success).toBe(false);
    expect(createCalendarEventSchema.safeParse({ ...base, recurrence: { freq: "weekly", end: { kind: "count", count: CALENDAR_MAX_REPEAT_COUNT + 1 } } }).success).toBe(false);
    expect(createCalendarEventSchema.safeParse({ ...base, recurrence: { freq: "weekly", end: { kind: "count", count: 2.5 } } }).success).toBe(false);
  });

  it("erros para o ecrã: fim antes do início, longe demais, vezes a menos, evento mais longo do que o intervalo", () => {
    const o = { nowMs: NOW };
    expect(validateNewCalendarEvent({ ...base, recurrence: { freq: "weekly", end: { kind: "until", untilDay: "2026-10-12" } } }, o))
      .toEqual({ ok: false, error: "A repetição tem de terminar depois do início." });
    expect(validateNewCalendarEvent({ ...base, recurrence: { freq: "weekly", end: { kind: "until", untilDay: "2031-10-14" } } }, o).ok).toBe(false);
    expect(validateNewCalendarEvent({ ...base, recurrence: { freq: "weekly", end: { kind: "until", untilDay: "2027-02-30" } } }, o))
      .toEqual({ ok: false, error: "Data inválida." });
    expect(validateNewCalendarEvent({ ...base, recurrence: { freq: "weekly", end: { kind: "count", count: 0 } } }, o))
      .toEqual({ ok: false, error: "Repete pelo menos 2 vezes." });
    expect(validateNewCalendarEvent({ ...base, recurrence: { freq: "hourly" } as any }, o)).toEqual({ ok: false, error: "Repetição inválida." });
    // dois dias inteiros, todos os dias → não dá
    expect(validateNewCalendarEvent({ title: "X", allDay: true, startDay: "2026-10-13", endDay: "2026-10-14", recurrence: { freq: "daily" } }, o).ok).toBe(false);
    expect(validateNewCalendarEvent({ title: "X", allDay: true, startDay: "2026-10-13", endDay: "2026-10-14", recurrence: { freq: "weekly" } }, o).ok).toBe(true);
    // um dia inteiro no dia da mudança da hora (25 out: 25 h) continua a poder repetir-se todos os dias
    expect(validateNewCalendarEvent({ title: "X", allDay: true, startDay: "2026-10-25", endDay: "2026-10-25", recurrence: { freq: "daily" } }, o).ok).toBe(true);
  });

  it("sem repetição: nada muda no corpo (sem recurrence, dia inteiro só com a data)", () => {
    const v = validateNewCalendarEvent({ title: "Férias", allDay: true, startDay: "2026-10-12", endDay: "2026-10-16" }, { nowMs: NOW });
    expect(v.ok && v.value.recurrence).toBeNull();
    if (!v.ok) return;
    const b = newCalendarEventBody(v.value, { requestId: "r" });
    expect(b.start).toEqual({ date: "2026-10-12" });
    expect((b as any).recurrence).toBeUndefined();
  });

  it("dia inteiro que se repete: recurrence + timeZone de Lisboa no início e no fim", () => {
    const v = validateNewCalendarEvent({ title: "Fecho do mês", allDay: true, startDay: "2026-11-05", endDay: "2026-11-05", recurrence: { freq: "monthly", end: { kind: "count", count: 12 } } }, { nowMs: NOW });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const b = newCalendarEventBody(v.value, { requestId: "r" });
    expect(b.start).toEqual({ date: "2026-11-05", timeZone: "Europe/Lisbon" });
    expect(b.end).toEqual({ date: "2026-11-06", timeZone: "Europe/Lisbon" });
    expect((b as any).recurrence).toEqual(["RRULE:FREQ=MONTHLY;BYMONTHDAY=5;COUNT=12"]);
  });
});

describe("createEvent com repetição", () => {
  const inserted: any[] = [];
  const api = {
    async listVisibleCalendars() { return []; },
    async listEventsInRange() { return { items: [], truncated: false }; },
    async insertEvent(calendarId: string, body: any, opts?: any) { inserted.push({ calendarId, body, opts }); return { ...body, id: "rep1", htmlLink: null }; },
  } as unknown as CalendarViewApi;
  const deps: CalendarViewDeps = {
    account: async () => ({ status: "connected", refreshTokenEnc: "enc", scopes: GOOGLE_FEATURE_SCOPES.calendar.join(" "), email: "joao@multipark.pt" }) as any,
    api: async () => api,
    now: () => NOW,
    requestId: () => "req-1",
    link: () => "https://dashboard.multipark.pt/calendario",
  };

  it("todas as terças até 29 dez: recurrence no events.insert, horas com timeZone de Lisboa", async () => {
    const r = await createMyCalendarEvent(7, { ...base, recurrence: { freq: "weekly", end: { kind: "until", untilDay: "2026-12-29" } } }, deps);
    const [{ calendarId, body }] = inserted;
    expect(calendarId).toBe("primary");
    expect(body.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261229T235959Z"]);
    expect(body.start).toEqual({ dateTime: "2026-10-13T09:00:00.000Z", timeZone: "Europe/Lisbon" });
    expect(body.end).toEqual({ dateTime: "2026-10-13T10:00:00.000Z", timeZone: "Europe/Lisbon" });
    expect(r.recurrenceLabel).toBe("Todas as semanas à terça-feira · até 29/12/2026");
  });
});
