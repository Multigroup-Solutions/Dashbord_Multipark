/**
 * Lote 45e — Calendário (Jorge, 7 out 2026: "Calendário como o Google
 * Calendar, dentro da Comunicação" — um calendário nosso que lê a agenda da
 * pessoa). Sem rede nem BD: a API do Google Calendar e a conta são falsas.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { calendar_v3 } from "@googleapis/calendar";
import {
  CALENDAR_BUSY_TITLE, CALENDAR_MAX_GUESTS, addLocalMinutes, allDayLanes, calendarRangeError, createCalendarEventSchema, daySegments, eventWhenLabel,
  eventsOnDay, isAllDayLike, layoutDay, lisbonDayTimeToUtcMs, lisbonHHMM, lisbonWallMinutes, localMinutesBetween, monthGridDays, newCalendarEventBody,
  normalizeGuests, pickViewCalendars, plainDescription, readableTextOn, safeHttpsUrl, shiftAnchor, splitGuests, validateNewCalendarEvent, viewDays,
  viewEventOf, viewTitle, weekdayIndex, type CalendarViewEvent,
} from "../shared/calendarView";
import { GOOGLE_CALENDAR_DESCRIPTION } from "../shared/googleSync";
import { GOOGLE_FEATURE_SCOPES } from "../shared/mail";
import { wrapCalendar, type CalendarListEntryRead } from "./google/apis";
import { createMyCalendarEvent, myCalendarEvents, type CalendarViewApi, type CalendarViewDeps } from "./google/calendarView";

const src = (p: string) => readFileSync(p, "utf8");
const NOW = Date.parse("2026-10-07T10:00:00Z");
const httpErr = (status: number, data?: unknown) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

function ev(partial: Partial<CalendarViewEvent> & { start: string; end: string }): CalendarViewEvent {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2), calendarId: "primary@x", title: partial.title ?? "Evento", allDay: false, location: null, meetLink: null,
    htmlLink: null, color: "#039be5", busyOnly: false, declined: false, description: null, ...partial,
  };
}

// ─── Horas de Lisboa ────────────────────────────────────────────────────────

describe("horas de Lisboa", () => {
  it("dia + HH:MM de Lisboa → UTC (verão +1, inverno +0) e de volta", () => {
    expect(lisbonDayTimeToUtcMs("2026-10-07", "14:30")).toBe(Date.parse("2026-10-07T13:30:00Z"));
    expect(lisbonDayTimeToUtcMs("2026-11-02", "14:30")).toBe(Date.parse("2026-11-02T14:30:00Z"));
    expect(lisbonDayTimeToUtcMs("2026-02-30", "10:00")).toBeNull();
    expect(lisbonDayTimeToUtcMs("2026-10-07", "24:00")).toBeNull();
    expect(lisbonHHMM(Date.parse("2026-10-07T13:30:00Z"))).toBe("14:30");
    expect(lisbonHHMM(Date.parse("2026-12-01T23:05:00Z"))).toBe("23:05");
  });
  it("minutos de relógio mesmo no dia da mudança da hora (25 out 2026)", () => {
    expect(lisbonWallMinutes(Date.parse("2026-10-25T00:30:00Z"))).toBe(90); // 01:30 (+1)
    expect(lisbonWallMinutes(Date.parse("2026-10-25T01:30:00Z"))).toBe(90); // 01:30 (+0, a hora repetida)
    expect(lisbonWallMinutes(Date.parse("2026-10-25T10:00:00Z"))).toBe(600);
    expect(lisbonWallMinutes(Date.parse("2026-03-29T01:30:00Z"))).toBe(150); // 02:30 (já +1)
  });
  it("somar minutos ao relógio passa a meia-noite; diferença entre dois momentos", () => {
    expect(addLocalMinutes("2026-10-07", "23:30", 60)).toEqual({ day: "2026-10-08", time: "00:30" });
    expect(addLocalMinutes("2026-10-07", "09:00", 90)).toEqual({ day: "2026-10-07", time: "10:30" });
    expect(addLocalMinutes("2026-12-31", "23:00", 120)).toEqual({ day: "2027-01-01", time: "01:00" });
    expect(localMinutesBetween("2026-10-07", "23:30", "2026-10-08", "00:30")).toBe(60);
    expect(localMinutesBetween("2026-10-07", "09:00", "2026-10-07", "10:15")).toBe(75);
  });
});

// ─── Vistas e navegação ─────────────────────────────────────────────────────

describe("vistas Dia / Semana / Mês / Lista", () => {
  it("semana de segunda a domingo; mês com semanas completas; lista de 7 dias", () => {
    expect(weekdayIndex("2026-10-05")).toBe(0);
    expect(weekdayIndex("2026-10-11")).toBe(6);
    expect(viewDays("week", "2026-10-07")).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
    expect(viewDays("day", "2026-10-07")).toEqual(["2026-10-07"]);
    expect(viewDays("list", "2026-10-07")).toHaveLength(7);
    const m = monthGridDays("2026-10-19");
    expect(m[0]).toBe("2026-09-28");
    expect(m[m.length - 1]).toBe("2026-11-01");
    expect(m).toHaveLength(35);
    expect(monthGridDays("2026-03-10")).toHaveLength(42); // começa num domingo → 6 semanas
    for (const a of ["2026-01-15", "2026-02-01", "2026-03-31", "2027-08-01"]) expect(viewDays("month", a).length).toBeLessThanOrEqual(42);
  });
  it("‹ Hoje ›: um dia, uma semana, o mês seguinte (dia 1)", () => {
    expect(shiftAnchor("day", "2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftAnchor("week", "2026-10-07", -1)).toBe("2026-09-30");
    expect(shiftAnchor("month", "2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftAnchor("month", "2026-01-31", -1)).toBe("2025-12-01");
    expect(shiftAnchor("list", "2026-10-07", 1)).toBe("2026-10-14");
  });
  it("título como no Google: \"outubro 2026\"", () => {
    expect(viewTitle("month", "2026-10-07")).toBe("outubro 2026");
    expect(viewTitle("week", "2026-10-07")).toBe("outubro 2026");
    expect(viewTitle("week", "2026-09-30")).toBe("setembro – outubro 2026");
    expect(viewTitle("week", "2026-12-30")).toBe("dezembro 2026 – janeiro 2027");
    expect(viewTitle("day", "2026-10-07")).toBe("7 de outubro 2026");
  });
  it("intervalo pedido: dias reais, por ordem, no máximo 42", () => {
    expect(calendarRangeError("2026-10-05", "2026-10-11")).toBeNull();
    expect(calendarRangeError("2026-09-28", "2026-11-08")).toBeNull(); // 42 dias
    expect(calendarRangeError("2026-09-28", "2026-11-09")).toMatch(/No máximo 42 dias/);
    expect(calendarRangeError("2026-10-11", "2026-10-05")).toBe("Intervalo inválido.");
    expect(calendarRangeError("2026-02-30", "2026-03-01")).toBe("Dia inválido.");
  });
});

// ─── Grelha das horas ───────────────────────────────────────────────────────

describe("posição dos eventos na grelha", () => {
  it("evento das 22h às 2h fica em dois dias", () => {
    const e = ev({ start: "2026-10-07T21:00:00Z", end: "2026-10-08T01:00:00Z" }); // 22:00 → 02:00 Lisboa
    const s = daySegments(e, ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(s.map((x) => [x.day, x.startMin, x.endMin, x.continuesBefore, x.continuesAfter])).toEqual([
      ["2026-10-07", 1320, 1440, false, true],
      ["2026-10-08", 0, 120, true, false],
    ]);
  });
  it("evento de duração zero aparece no dia; o que acaba à meia-noite não passa para o dia seguinte", () => {
    const zero = ev({ start: "2026-10-07T08:00:00Z", end: "2026-10-07T08:00:00Z" });
    expect(daySegments(zero, ["2026-10-07"]).map((x) => [x.startMin, x.endMin])).toEqual([[540, 540]]);
    const late = ev({ start: "2026-10-07T21:00:00Z", end: "2026-10-07T23:00:00Z" }); // 22:00 → 00:00
    expect(daySegments(late, ["2026-10-07", "2026-10-08"]).map((x) => [x.day, x.startMin, x.endMin])).toEqual([["2026-10-07", 1320, 1440]]);
  });
  it("sobrepostos ficam lado a lado; o que começa quando o outro acaba reaproveita a coluna", () => {
    const out = layoutDay([
      { id: "A", startMin: 540, endMin: 600 },
      { id: "B", startMin: 570, endMin: 630 },
      { id: "C", startMin: 600, endMin: 660 },
      { id: "D", startMin: 720, endMin: 780 },
    ]);
    const by = Object.fromEntries(out.map((x) => [x.id, [x.col, x.cols]]));
    expect(by).toEqual({ A: [0, 2], B: [1, 2], C: [0, 2], D: [0, 1] });
  });
  it("eventos curtos ocupam o mínimo visível (não se escondem uns aos outros)", () => {
    const out = layoutDay([{ id: "a", startMin: 600, endMin: 605 }, { id: "b", startMin: 610, endMin: 615 }], 20);
    expect(out.map((x) => [x.id, x.col, x.cols])).toEqual([["a", 0, 2], ["b", 1, 2]]);
  });
  it("faixa do dia inteiro: barras atravessam dias e não se sobrepõem", () => {
    const week = viewDays("week", "2026-10-07");
    const viagem = ev({ id: "v", title: "Viagem", allDay: true, start: new Date(Date.parse("2026-10-03T23:00:00Z")).toISOString(), end: "2026-10-06T23:00:00.000Z" }); // 4–6 out
    const feriado = ev({ id: "f", title: "Folga", allDay: true, start: "2026-10-05T23:00:00.000Z", end: "2026-10-06T23:00:00.000Z" }); // 6 out
    const outro = ev({ id: "o", title: "Formação", allDay: true, start: "2026-10-07T23:00:00.000Z", end: "2026-10-08T23:00:00.000Z" }); // 8 out
    const bars = allDayLanes([outro, feriado, viagem], week);
    const by = Object.fromEntries(bars.map((b) => [b.event.id, [b.startCol, b.span, b.lane, b.continuesBefore]]));
    expect(by).toEqual({ v: [0, 2, 0, true], f: [1, 1, 1, false], o: [3, 1, 0, false] });
  });
  it("24 h ou mais vai para o dia inteiro; o dia mostra o dia inteiro primeiro", () => {
    const longo = ev({ id: "L", start: "2026-10-07T08:00:00Z", end: "2026-10-08T09:00:00Z" });
    const curto = ev({ id: "C", start: "2026-10-07T07:00:00Z", end: "2026-10-07T08:00:00Z" });
    expect(isAllDayLike(longo)).toBe(true);
    expect(isAllDayLike(curto)).toBe(false);
    expect(eventsOnDay([curto, longo], "2026-10-07").map((e) => e.id)).toEqual(["L", "C"]);
    expect(eventsOnDay([curto], "2026-10-08")).toEqual([]);
  });
  it("quando: hora de Lisboa e dia por extenso", () => {
    expect(eventWhenLabel(ev({ start: "2026-10-07T13:30:00Z", end: "2026-10-07T14:30:00Z" }))).toBe("quarta-feira, 7 de outubro · 14:30 – 15:30");
    expect(eventWhenLabel(ev({ allDay: true, start: "2026-10-06T23:00:00.000Z", end: "2026-10-07T23:00:00.000Z" }))).toBe("quarta-feira, 7 de outubro · dia inteiro");
  });
  it("texto legível sobre a cor do calendário", () => {
    expect(readableTextOn("#f6bf26")).toBe("#1f1f1f");
    expect(readableTextOn("#3f51b5")).toBe("#ffffff");
    expect(readableTextOn("lixo")).toBe("#ffffff");
  });
});

// ─── Calendários e eventos do Google ────────────────────────────────────────

describe("o que entra e como aparece", () => {
  const list: CalendarListEntryRead[] = [
    { id: "partilhado@x", summary: "Equipa", summaryOverride: null, description: null, backgroundColor: "#7bd148", primary: false, selected: true, hidden: false, accessRole: "reader" },
    { id: "escondido@x", summary: "Feriados", summaryOverride: null, description: null, backgroundColor: "#16a765", primary: false, selected: false, hidden: false, accessRole: "reader" },
    { id: "mp@group", summary: "Multipark", summaryOverride: null, description: GOOGLE_CALENDAR_DESCRIPTION, backgroundColor: "#9a9cff", primary: false, selected: false, hidden: false, accessRole: "owner" },
    { id: "joao@multipark.pt", summary: "joao@multipark.pt", summaryOverride: null, description: null, backgroundColor: "nada", primary: true, selected: true, hidden: false, accessRole: "owner" },
  ];
  it("visíveis no Google + principal + Multipark (principal primeiro)", () => {
    const c = pickViewCalendars(list);
    expect(c.map((x) => [x.id, x.primary, x.multipark])).toEqual([
      ["joao@multipark.pt", true, false], ["mp@group", false, true], ["partilhado@x", false, false],
    ]);
    expect(c[0].color).toBe("#039be5"); // cor inválida → a de omissão
    expect(pickViewCalendars([])[0]).toMatchObject({ id: "primary", primary: true });
    expect(pickViewCalendars([{ ...list[1], deleted: true, selected: true } as any])).toHaveLength(1);
  });
  it("privado de um calendário partilhado (sem detalhes) → \"Ocupado\", sem local, Meet nem link", () => {
    const priv = viewEventOf({ id: "p1", visibility: "private", start: { dateTime: "2026-10-07T10:00:00+01:00" }, end: { dateTime: "2026-10-07T11:00:00+01:00" }, htmlLink: "https://calendar.google.com/x" }, { id: "partilhado@x", color: "#7bd148", accessRole: "reader" })!;
    expect(priv).toMatchObject({ title: CALENDAR_BUSY_TITLE, busyOnly: true, location: null, meetLink: null, htmlLink: null, description: null });
    const fb = viewEventOf({ id: "p2", summary: "Consulta", location: "Hospital", start: { dateTime: "2026-10-07T10:00:00Z" }, end: { dateTime: "2026-10-07T11:00:00Z" } }, { id: "c", color: "#000", accessRole: "freeBusyReader" })!;
    expect(fb.title).toBe(CALENDAR_BUSY_TITLE);
    expect(fb.location).toBeNull();
    // o próprio evento sem título não é "Ocupado"
    expect(viewEventOf({ id: "p3", start: { dateTime: "2026-10-07T10:00:00Z" }, end: { dateTime: "2026-10-07T11:00:00Z" } }, { id: "c", color: "#000", accessRole: "owner" })!.title).toBe("(Sem título)");
  });
  it("dia inteiro, cor do evento, Meet, recusado, cancelado e local de trabalho", () => {
    const allDay = viewEventOf({ id: "d", summary: "Folga", start: { date: "2026-10-07" }, end: { date: "2026-10-08" } }, { id: "c", color: "#9a9cff" })!;
    expect(allDay).toMatchObject({ allDay: true, start: "2026-10-06T23:00:00.000Z", end: "2026-10-07T23:00:00.000Z", color: "#9a9cff" });
    const meet = viewEventOf({
      id: "m", summary: "Reunião", colorId: "11", start: { dateTime: "2026-10-07T14:00:00Z" }, end: { dateTime: "2026-10-07T15:00:00Z" },
      conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] }, htmlLink: "https://www.google.com/calendar/event?eid=1",
      attendees: [{ self: true, responseStatus: "declined" }], description: "<b>Ordem</b><br>1. Escala &amp; turnos",
    }, { id: "c", color: "#000" })!;
    expect(meet).toMatchObject({ color: "#d50000", meetLink: "https://meet.google.com/abc-defg-hij", declined: true, description: "Ordem\n1. Escala & turnos" });
    expect(viewEventOf({ id: "x", status: "cancelled", start: { dateTime: "2026-10-07T14:00:00Z" } }, { id: "c", color: "#000" })).toBeNull();
    expect(viewEventOf({ id: "w", eventType: "workingLocation", start: { date: "2026-10-07" } }, { id: "c", color: "#000" })).toBeNull();
    // links que não são https não vão para um href
    expect(viewEventOf({ id: "j", summary: "x", hangoutLink: "javascript:alert(1)", htmlLink: "http://x", start: { dateTime: "2026-10-07T14:00:00Z" }, end: { dateTime: "2026-10-07T15:00:00Z" } }, { id: "c", color: "#000" })).toMatchObject({ meetLink: null, htmlLink: null });
    expect(safeHttpsUrl("https://meet.google.com/a")).toBe("https://meet.google.com/a");
    expect(plainDescription("   ")).toBeNull();
  });
});

// ─── myEvents com API falsa ─────────────────────────────────────────────────

const CAL_SCOPES = GOOGLE_FEATURE_SCOPES.calendar.join(" ");

class FakeCalendarView implements CalendarViewApi {
  calls: Array<{ calendarId: string; timeMin: string; timeMax: string }> = [];
  inserted: Array<{ calendarId: string; body: calendar_v3.Schema$Event; opts: any }> = [];
  failOn = new Map<string, unknown>();
  constructor(public cals: CalendarListEntryRead[], public events: Record<string, calendar_v3.Schema$Event[]>) {}
  async listVisibleCalendars() { return this.cals; }
  async listEventsInRange(calendarId: string, p: { timeMin: string; timeMax: string }) {
    this.calls.push({ calendarId, timeMin: p.timeMin, timeMax: p.timeMax });
    if (this.failOn.has(calendarId)) throw this.failOn.get(calendarId);
    return { items: this.events[calendarId] ?? [], truncated: false };
  }
  async insertEvent(calendarId: string, body: calendar_v3.Schema$Event, opts?: any) {
    this.inserted.push({ calendarId, body, opts });
    return { ...body, id: "novo1", htmlLink: "https://www.google.com/calendar/event?eid=novo1", ...(body.conferenceData ? { hangoutLink: "https://meet.google.com/nov-oooo-ooo" } : {}) };
  }
}

const PRIMARY: CalendarListEntryRead = { id: "joao@multipark.pt", summary: "joao@multipark.pt", summaryOverride: null, description: null, backgroundColor: "#039be5", primary: true, selected: true, hidden: false, accessRole: "owner" };
const SHARED: CalendarListEntryRead = { id: "chefe@multipark.pt", summary: "Chefe", summaryOverride: null, description: null, backgroundColor: "#f83a22", primary: false, selected: true, hidden: false, accessRole: "reader" };

function deps(api: FakeCalendarView, account: Awaited<ReturnType<CalendarViewDeps["account"]>> | Error = { status: "connected", refreshTokenEnc: "enc", scopes: CAL_SCOPES, email: "joao@multipark.pt" }): CalendarViewDeps {
  return {
    account: async () => { if (account instanceof Error) throw account; return account; },
    api: async () => api,
    now: () => NOW,
    requestId: () => "req-1",
    link: () => "https://dashboard.multipark.pt/calendario",
  };
}

describe("myEvents (só a conta da própria pessoa)", () => {
  it("lê os calendários visíveis no intervalo de Lisboa; privado do partilhado → Ocupado; ordenados", async () => {
    const api = new FakeCalendarView([PRIMARY, SHARED], {
      [PRIMARY.id]: [{ id: "e2", summary: "Almoço", start: { dateTime: "2026-10-07T12:00:00Z" }, end: { dateTime: "2026-10-07T13:00:00Z" } }],
      [SHARED.id]: [{ id: "e1", visibility: "private", start: { dateTime: "2026-10-07T08:00:00Z" }, end: { dateTime: "2026-10-07T09:00:00Z" } }],
    });
    const r = await myCalendarEvents(7, "2026-10-05", "2026-10-11", deps(api));
    expect(r).toMatchObject({ enabled: true, reason: null, failedCalendars: [], truncated: false });
    expect(r.calendars.map((c) => c.id)).toEqual([PRIMARY.id, SHARED.id]);
    expect(r.events.map((e) => [e.id, e.title, e.calendarId])).toEqual([["e1", "Ocupado", SHARED.id], ["e2", "Almoço", PRIMARY.id]]);
    expect(api.calls[0]).toMatchObject({ timeMin: "2026-10-04T23:00:00.000Z", timeMax: "2026-10-11T23:00:00.000Z" });
    expect((r.calendars[0] as any).accessRole).toBeUndefined();
  });
  it("erro ≠ vazio: agenda vazia é enabled com zero eventos; erro no principal é reason \"error\"", async () => {
    const vazio = await myCalendarEvents(7, "2026-10-05", "2026-10-11", deps(new FakeCalendarView([PRIMARY], {})));
    expect(vazio).toMatchObject({ enabled: true, reason: null, events: [] });
    const api = new FakeCalendarView([PRIMARY, SHARED], {});
    api.failOn.set(PRIMARY.id, httpErr(500, { error: { message: "Backend Error" } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await myCalendarEvents(7, "2026-10-05", "2026-10-11", deps(api));
    warn.mockRestore();
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe("error");
    expect(r.error).toBeTruthy();
  });
  it("um calendário partilhado que falha não esconde os outros (fica em failedCalendars)", async () => {
    const api = new FakeCalendarView([PRIMARY, SHARED], { [PRIMARY.id]: [{ id: "e", summary: "A", start: { dateTime: "2026-10-07T12:00:00Z" }, end: { dateTime: "2026-10-07T13:00:00Z" } }] });
    api.failOn.set(SHARED.id, httpErr(404, { error: { message: "Not Found" } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await myCalendarEvents(7, "2026-10-05", "2026-10-11", deps(api));
    warn.mockRestore();
    expect(r).toMatchObject({ enabled: true, reason: null, failedCalendars: [{ id: SHARED.id, name: "Chefe" }] });
    expect(r.events).toHaveLength(1);
  });
  it("sem conta / sem Calendário / religar / BD em baixo — cada um o seu motivo", async () => {
    const api = new FakeCalendarView([PRIMARY], {});
    expect((await myCalendarEvents(7, "2026-10-05", "2026-10-11", deps(api, null))).reason).toBe("not_connected");
    expect((await myCalendarEvents(7, "2026-10-05", "2026-10-11", deps(api, { status: "disconnected", refreshTokenEnc: null, scopes: CAL_SCOPES }))).reason).toBe("not_connected");
    expect((await myCalendarEvents(7, "2026-10-05", "2026-10-11", deps(api, { status: "connected", refreshTokenEnc: "e", scopes: "https://www.googleapis.com/auth/gmail.modify" }))).reason).toBe("scope_missing");
    expect((await myCalendarEvents(7, "2026-10-05", "2026-10-11", deps(api, { status: "reauth_required", refreshTokenEnc: "e", scopes: CAL_SCOPES }))).reason).toBe("reauth_required");
    expect((await myCalendarEvents(7, "2026-10-05", "2026-10-11", deps(api, new Error("ECONNRESET")))).reason).toBe("error");
    expect(api.calls).toHaveLength(0);
  });
  it("autorização revogada a meio → reauth_required (não \"error\")", async () => {
    const api = new FakeCalendarView([PRIMARY], {});
    api.failOn.set(PRIMARY.id, Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } }));
    expect((await myCalendarEvents(7, "2026-10-05", "2026-10-11", deps(api))).reason).toBe("reauth_required");
  });
});

// ─── Novo evento ────────────────────────────────────────────────────────────

describe("createEvent", () => {
  const base = { title: "Reunião de equipa", startDay: "2026-10-08", endDay: "2026-10-08", startTime: "10:00", endTime: "11:00" };

  it("valida datas: fim depois do início, horas obrigatórias, datas reais, nem muito antigas nem muito longe", () => {
    const o = { nowMs: NOW };
    expect(validateNewCalendarEvent({ ...base, endTime: "09:00" }, o)).toEqual({ ok: false, error: "O fim tem de ser depois do início." });
    expect(validateNewCalendarEvent({ ...base, endDay: "2026-10-07" }, o)).toEqual({ ok: false, error: "O fim tem de ser depois do início." });
    expect(validateNewCalendarEvent({ ...base, startTime: undefined }, o)).toEqual({ ok: false, error: "Indica a hora de início e de fim." });
    expect(validateNewCalendarEvent({ ...base, startDay: "2026-02-30" }, o)).toEqual({ ok: false, error: "Data inválida." });
    expect(validateNewCalendarEvent({ ...base, startDay: "2024-01-01", endDay: "2024-01-01" }, o).ok).toBe(false);
    expect(validateNewCalendarEvent({ ...base, title: "  " }, o)).toEqual({ ok: false, error: "Indica o título." });
    expect(validateNewCalendarEvent({ ...base, allDay: true, startDay: "2026-10-01", endDay: "2026-11-15" }, o).ok).toBe(false);
    const ok = validateNewCalendarEvent({ ...base, guests: [] }, o);
    expect(ok.ok && [ok.value.startMs, ok.value.endMs]).toEqual([Date.parse("2026-10-08T09:00:00Z"), Date.parse("2026-10-08T10:00:00Z")]);
  });

  it("convidados: emails válidos, sem repetidos nem o próprio, no máximo 20", () => {
    expect(splitGuests("a@x.pt, b@y.pt;c@z.pt  d@w.pt")).toEqual(["a@x.pt", "b@y.pt", "c@z.pt", "d@w.pt"]);
    expect(normalizeGuests(["A@x.pt", "a@x.pt", "joao@multipark.pt", " b@y.pt "], "joao@multipark.pt")).toEqual({ ok: true, guests: ["a@x.pt", "b@y.pt"] });
    expect(normalizeGuests(["nao-e-email"])).toEqual({ ok: false, error: "Email de convidado inválido: nao-e-email" });
    const many = Array.from({ length: CALENDAR_MAX_GUESTS + 1 }, (_, i) => `p${i}@x.pt`);
    expect(normalizeGuests(many)).toEqual({ ok: false, error: "No máximo 20 convidados." });
    expect(createCalendarEventSchema.safeParse({ ...base, guests: many }).success).toBe(false);
    expect(createCalendarEventSchema.safeParse({ ...base, guests: many.slice(0, 20) }).success).toBe(true);
  });

  it("sem convidados: no principal, sem enviar convites, sem Meet; hora de Lisboa no corpo", async () => {
    const api = new FakeCalendarView([PRIMARY], {});
    const r = await createMyCalendarEvent(7, { ...base, guests: [] }, deps(api));
    expect(api.inserted).toHaveLength(1);
    const [{ calendarId, body, opts }] = api.inserted;
    expect(calendarId).toBe("primary");
    expect(opts).toEqual({ sendUpdates: "none" });
    expect(body).toMatchObject({
      summary: "Reunião de equipa", start: { dateTime: "2026-10-08T09:00:00.000Z", timeZone: "Europe/Lisbon" }, end: { dateTime: "2026-10-08T10:00:00.000Z", timeZone: "Europe/Lisbon" },
      source: { title: "Dashboard Multipark", url: "https://dashboard.multipark.pt/calendario" },
    });
    expect(body.attendees).toBeUndefined();
    expect(body.conferenceData).toBeUndefined();
    expect(r).toMatchObject({ eventId: "novo1", meetLink: null, guests: 0 });
  });

  it("com convidados e Meet: convites enviados (sendUpdates all) e conferenceDataVersion 1", async () => {
    const api = new FakeCalendarView([PRIMARY], {});
    const r = await createMyCalendarEvent(7, { ...base, guests: ["cliente@gmail.com", "JOAO@multipark.pt", "cliente@gmail.com"], withMeet: true }, deps(api));
    const [{ body, opts }] = api.inserted;
    expect(opts).toEqual({ conferenceDataVersion: 1, sendUpdates: "all" });
    expect(body.attendees).toEqual([{ email: "cliente@gmail.com" }]);
    expect(body.conferenceData).toEqual({ createRequest: { requestId: "req-1", conferenceSolutionKey: { type: "hangoutsMeet" } } });
    expect(r).toMatchObject({ meetLink: "https://meet.google.com/nov-oooo-ooo", guests: 1 });
  });

  it("dia inteiro: o fim vai exclusivo (dia a seguir ao último)", () => {
    const v = validateNewCalendarEvent({ title: "Férias", allDay: true, startDay: "2026-10-12", endDay: "2026-10-16" }, { nowMs: NOW });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const b = newCalendarEventBody(v.value, { requestId: "r" });
    expect(b.start).toEqual({ date: "2026-10-12" });
    expect(b.end).toEqual({ date: "2026-10-17" });
  });

  it("erros com a mensagem para o ecrã (sem conta, sem Calendário, datas, convidados)", async () => {
    const api = new FakeCalendarView([PRIMARY], {});
    await expect(createMyCalendarEvent(7, base, deps(api, null))).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(createMyCalendarEvent(7, base, deps(api, { status: "connected", refreshTokenEnc: "e", scopes: "x" }))).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "Ativa o Calendário na tua conta Google." });
    await expect(createMyCalendarEvent(7, { ...base, endTime: "09:00" }, deps(api))).rejects.toMatchObject({ code: "BAD_REQUEST", message: "O fim tem de ser depois do início." });
    await expect(createMyCalendarEvent(7, { ...base, guests: ["isto não"] }, deps(api))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(api.inserted).toHaveLength(0);
  });
});

// ─── Adaptador oficial e ligações ───────────────────────────────────────────

describe("API do Google e ligações", () => {
  it("events.list com instâncias expandidas, por hora, sem apagados, 250 por página, até ao limite de páginas", async () => {
    let n = 0;
    const list = vi.fn(async (_p: any) => ({ data: { items: [{ id: `e${++n}` }], nextPageToken: "mais" } }));
    const fake = { events: { list }, calendarList: { list: vi.fn(async (p: any) => ({ data: { items: [{ id: "a", summary: "A", selected: true, primary: true, accessRole: "owner", backgroundColor: "#fff" }] }, p })) } } as unknown as calendar_v3.Calendar;
    const api = wrapCalendar(fake, { deadlineAt: Date.now() + 10_000 });
    const r = await api.listEventsInRange("primary", { timeMin: "a", timeMax: "b", maxPages: 4 });
    expect(r.items).toHaveLength(4);
    expect(r.truncated).toBe(true);
    expect(list.mock.calls[0][0]).toMatchObject({ calendarId: "primary", timeMin: "a", timeMax: "b", singleEvents: true, orderBy: "startTime", showDeleted: false, maxResults: 250 });
    expect(list.mock.calls[1][0]).toMatchObject({ pageToken: "mais" });
    const cals = await api.listVisibleCalendars();
    expect(cals[0]).toMatchObject({ id: "a", primary: true, selected: true });
    expect((fake as any).calendarList.list.mock.calls[0][0].minAccessRole).toBeUndefined();
  });

  it("servidor: myEvents/createEvent no googleCalendar, com registo; âmbitos sem novidades", () => {
    const r = src("server/google/router.ts");
    expect(r).toMatch(/myEvents: protectedProcedure\.input\(z\.object\(\{ fromDay: day, toDay: day \}\)\)/);
    expect(r).toMatch(/const bad = calendarRangeError\(input\.fromDay, input\.toDay\);/);
    expect(r).toMatch(/createEvent: protectedProcedure\.input\(createCalendarEventSchema\)/);
    expect(r).toMatch(/entity: "google_calendar_event"/);
    const mail = src("shared/mail.ts");
    expect(mail).toMatch(/página Calendário da PRÓPRIA pessoa/);
    expect(mail).not.toMatch(/nunca o conteúdo\s*\/\/\s*dos eventos pessoais/);
    expect(CAL_SCOPES.split(" ")).toHaveLength(4);
  });

  it("cliente: rota /calendario junto das Tarefas; erro ≠ vazio; GoogleAccountCard; escolhas guardadas com try/catch", () => {
    const app = src("client/src/App.tsx");
    expect(app).toMatch(/<Route path="\/calendario">\s*\{\(\) => \(<DashboardLayout><CalendarioPage \/><\/DashboardLayout>\)\}/);
    expect(app.indexOf('<Route path="/calendario">')).toBeGreaterThan(app.indexOf('<Route path="/tarefas">'));
    const p = src("client/src/pages/CalendarioPage.tsx");
    expect(p).toContain("Não foi possível ler o calendário.");
    expect(p).toContain("Tentar de novo");
    expect(p).toMatch(/<GoogleAccountCard compact returnTo="\/calendario" features=\{\["gmail", "calendar"\]\} \/>/);
    expect(p).toMatch(/try \{ return window\.localStorage\.getItem\(key\); \} catch \{ return null; \}/);
    expect(p).toMatch(/try \{ window\.localStorage\.setItem\(key, value\); \} catch/);
    expect(p).toContain("Abrir no Google Calendar");
    const help = src("docs/ajuda/comunicacao.md");
    expect(help).toMatch(/rotas: \/comunicacao, \/comunicacao\/meu-email, \/calendario/);
    expect(help).toContain("**Calendário** (menu **Comunicação → Calendário**, em /calendario)");
  });
});
