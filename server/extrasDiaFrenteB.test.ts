/**
 * Frente B do Extras-dia (Jorge, 7 out 2026):
 *  - pedido 7: UMA leitura da disponibilidade (semântica de calendário) para a
 *    grelha/filtro, a escala automática e os candidatos — e o indicador de
 *    pessoal "precisas N · escalados M · disponíveis por escalar K";
 *  - pedido 8: "Avisar este turno" com o texto de cada pessoa, canais, só
 *    confirmados, idempotente por linha/versão/canal;
 *  - pedido 4: notas do dia de trabalho (Pressão).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  availabilityCellDisplay,
  describeWindows,
  matchesAvailabilityWindow,
  operationalDayWindows,
  windowsAroundDay,
  inWindows,
  type AvailabilityDayLike,
} from "../shared/availabilityWindow";
import { planSchedule, remainingNeed, type ScheduleCandidate } from "../shared/extrasSchedule";
import {
  describeStaffingGap,
  describeStaffingHour,
  staffingByHour,
  staffingGaps,
  staffingHourState,
} from "../shared/extrasStaffing";
import {
  canArchiveDayNote,
  cellToOperational,
  dayNoteHourLabel,
  isDayNoteHour,
  normalizeDayNoteBody,
  notesForCell,
  sortDayNotes,
} from "../shared/extrasDayNotes";
import {
  noticeEmailAddress,
  noticeOutcome,
  planShiftNotice,
  shiftNoticeSubject,
  type NoticePerson,
  type NoticeRow,
} from "../shared/shiftNotice";
import { coverageGaps } from "./extrasAutomation";
import { mapWebsiteDay } from "./webIntake";
import { addDays } from "../shared/lisbonDay";

const row = (day: string, o: Partial<Omit<AvailabilityDayLike, "day">> = {}): AvailabilityDayLike =>
  ({ day, morning: false, night: false, fromHour: null, toHour: null, ...o });
const MON = "2026-10-05"; // segunda
const TUE = "2026-10-06";
const SUN = "2026-10-04";
const need = (spec: Record<number, number>) => Array.from({ length: 27 }, (_, h) => spec[h] ?? 0);

// ─── Pedido 7: semântica de calendário única ────────────────────────────────

describe("dia operacional = calendário (03h de D → 03h de D+1)", () => {
  it("'terça 00h–03h' é a noite de segunda (24–27), não a de terça", () => {
    const days = [row(TUE, { fromHour: 0, toHour: 3 })];
    expect(operationalDayWindows(days, MON)).toEqual([{ from: 24, to: 27 }]);
    expect(operationalDayWindows(days, TUE)).toEqual([]);
  });
  it("uma linha que atravessa a meia-noite continua em D+1 até ao fim; para lá das 03h é do dia seguinte", () => {
    expect(operationalDayWindows([row(MON, { fromHour: 18, toHour: 3 })], MON)).toEqual([{ from: 18, to: 27 }]);
    const late = [row(SUN, { fromHour: 22, toHour: 6 })];
    expect(operationalDayWindows(late, SUN)).toEqual([{ from: 22, to: 27 }]);
    expect(operationalDayWindows(late, MON)).toEqual([{ from: 3, to: 6 }]);
  });
  it("'02h–10h' na segunda: 03–10 na segunda e 02–03 (hora 26) no domingo", () => {
    const days = [row(MON, { fromHour: 2, toHour: 10 })];
    expect(operationalDayWindows(days, MON)).toEqual([{ from: 3, to: 10 }]);
    expect(operationalDayWindows(days, SUN)).toEqual([{ from: 26, to: 27 }]);
  });
  it("manhã de D + madrugada de D+1 = duas janelas; noite de D + madrugada de D+1 fundem-se", () => {
    expect(operationalDayWindows([row(MON, { morning: true }), row(TUE, { fromHour: 1, toHour: 3 })], MON)).toEqual([{ from: 3, to: 15 }, { from: 25, to: 27 }]);
    expect(operationalDayWindows([row(MON, { night: true }), row(TUE, { fromHour: 0, toHour: 2 })], MON)).toEqual([{ from: 15, to: 27 }]);
  });
  it("a ordem das linhas não importa (procura-se pela data)", () => {
    const days = [row(TUE, { fromHour: 0, toHour: 3 }), row(MON, { fromHour: 20, toHour: 23 })];
    expect(operationalDayWindows(days, MON)).toEqual(operationalDayWindows(days.slice().reverse(), MON));
  });
  it("o filtro da grelha vê a madrugada do dia seguinte num pedido que atravessa a meia-noite", () => {
    const days = [row(MON), row(TUE, { fromHour: 0, toHour: 3 })];
    expect(matchesAvailabilityWindow(days, MON, 22, 2)).toBe(true);
    expect(windowsAroundDay(days, MON)).toEqual([{ from: 24, to: 27 }]);
  });
  it("texto das janelas", () => {
    expect(describeWindows([{ from: 18, to: 25 }])).toBe("18h–01h");
    expect(describeWindows([{ from: 3, to: 15 }, { from: 20, to: 27 }])).toBe("03h–15h e 20h–03h");
  });
});

describe("propriedade: o filtro da grelha e a escala concordam em TODAS as horas", () => {
  // Para cada linha possível (dia D−1, D ou D+1; das 0–23 às 0–23, ou só turnos),
  // e cada hora operacional h de D: a escala diz "pode" ⇔ o filtro "disponível
  // das h às h+1" no dia de calendário certo diz que sim.
  const D = MON;
  const rowsFor = (marked: AvailabilityDayLike) => [-1, 0, 1, 2].map((n) => {
    const day = addDays(D, n);
    return day === marked.day ? marked : row(day);
  });
  const check = (marked: AvailabilityDayLike) => {
    const days = rowsFor(marked);
    const windows = operationalDayWindows(days, D);
    for (let h = 3; h < 27; h++) {
      const calendarDay = h >= 24 ? addDays(D, 1) : D;
      const hc = h % 24;
      const byFilter = matchesAvailabilityWindow(days, calendarDay, hc, hc + 1);
      const byScheduler = inWindows(windows, h);
      if (byFilter !== byScheduler) throw new Error(`${JSON.stringify(marked)} hora ${h}: filtro ${byFilter}, escala ${byScheduler}`);
    }
  };
  it("linhas com horas (24 × 24 × 3 dias)", () => {
    let n = 0;
    for (const offset of [-1, 0, 1]) {
      for (let from = 0; from < 24; from++) {
        for (let to = 0; to < 24; to++) { check(row(addDays(D, offset), { fromHour: from, toHour: to })); n++; }
      }
    }
    expect(n).toBe(24 * 24 * 3);
  });
  it("só turnos, e uma hora sozinha", () => {
    for (const offset of [-1, 0, 1]) {
      const day = addDays(D, offset);
      for (const o of [{ morning: true }, { night: true }, { morning: true, night: true }]) check(row(day, o));
      for (let h = 0; h < 24; h++) { check(row(day, { fromHour: h })); check(row(day, { toHour: h })); }
    }
  });
});

describe("slots do site que acabam à 01h: horas reais, não 'Noite 15h–03h'", () => {
  it("'18H-01H' guarda 18→01 e a janela acaba às 25 (01h)", () => {
    const m = mapWebsiteDay(["18H-01H"], "")!;
    expect(m).toMatchObject({ night: true, fromHour: 18, toHour: 1 });
    const days = [row(MON, { morning: !!m.morning, night: !!m.night, fromHour: m.fromHour ?? null, toHour: m.toHour ?? null })];
    expect(operationalDayWindows(days, MON)).toEqual([{ from: 18, to: 25 }]);
  });
  it("a célula mostra as horas e não a lua quando há horas", () => {
    expect(availabilityCellDisplay({ morning: false, night: true, fromHour: 18, toHour: 1 })).toEqual({ morning: false, night: false, hours: "18h–01h" });
    expect(availabilityCellDisplay({ morning: false, night: true, fromHour: null, toHour: null })).toEqual({ morning: false, night: true, hours: null });
    expect(availabilityCellDisplay({ morning: true, night: false, fromHour: 9, toHour: null })).toEqual({ morning: true, night: false, hours: null });
    expect(availabilityCellDisplay({ morning: false, night: false, fromHour: 9, toHour: null }).hours).toBe("09h–03h");
  });
});

// ─── Pedido 7: o exemplo do Jorge e o indicador ─────────────────────────────

describe("regressão: precisas 2 às 02h e há 2 pessoas até às 03h", () => {
  const needed = need({ 26: 2 });
  it("escaladas até às 03h (fim 27) → sem falta", () => {
    const rows = [{ employeeId: 1, startHour: 20, endHour: 27 }, { employeeId: 2, startHour: 22, endHour: 27 }];
    expect(coverageGaps(needed, rows)).toEqual([]);
    expect(remainingNeed(needed, rows)[26]).toBe(0);
    expect(staffingGaps(staffingByHour({ needed, rows, candidates: [] }), [])).toEqual([]);
  });
  it("disponíveis até às 03h (por escalar) → 'faltam escalar', com os nomes; a proposta automática cobre as 02h", () => {
    // Ana marcou segunda 20h–03h; Rui marcou terça 00h–03h (a madrugada de segunda).
    const ana = [row(MON, { fromHour: 20, toHour: 3 })];
    const rui = [row(TUE, { fromHour: 0, toHour: 3 })];
    const candidates = [
      { id: 1, name: "Ana Sousa", windows: operationalDayWindows(ana, MON) },
      { id: 2, name: "Rui Lopes", windows: operationalDayWindows(rui, MON) },
    ];
    const hours = staffingByHour({ needed, rows: [], candidates });
    const gaps = staffingGaps(hours, candidates);
    expect(gaps).toEqual([{ fromHour: 26, toHour: 27, missing: 2, available: [{ id: 1, name: "Ana Sousa" }, { id: 2, name: "Rui Lopes" }] }]);
    expect(describeStaffingGap(gaps[0])).toBe("Faltam escalar 2 às 02h (há 2 disponíveis: Ana, Rui)");
    const plan = planSchedule({
      needed,
      existing: [],
      candidates: candidates.map((c): ScheduleCandidate => ({
        id: c.id, fullName: c.name, level: "junior", levelLabel: "Júnior", hourlyRate: 4.5, windows: c.windows,
        evalScore: null, recentDays: 0, noShows: 0, declines: 0,
      })),
    });
    expect(plan.gaps).toEqual([]);
    expect(plan.picks.every((p) => p.startHour <= 26 && 26 < p.endHour)).toBe(true);
  });
  it("ninguém disponível → 'falta gente'", () => {
    const gaps = staffingGaps(staffingByHour({ needed, rows: [], candidates: [] }), []);
    expect(describeStaffingGap(gaps[0])).toBe("Falta gente às 02h (faltam 2; ninguém disponível)");
  });
  it("mandado para casa às 02h deixa de contar às 02h; o TL nunca conta", () => {
    expect(coverageGaps(needed, [{ startHour: 20, endHour: 27, sentHomeHour: 26 }, { startHour: 20, endHour: 27 }])).toEqual([{ hour: 26, needed: 2, have: 1 }]);
    const hours = staffingByHour({ needed, rows: [{ employeeId: 9, isTeamLeader: true, startHour: 15, endHour: 27 }, { employeeId: 1, startHour: 20, endHour: 27 }], candidates: [] });
    expect(hours.find((h) => h.hour === 26)).toMatchObject({ needed: 2, scheduled: 1 });
  });
});

describe("indicador por hora", () => {
  const candidates = [
    { id: 1, name: "Ana", windows: [{ from: 6, to: 12 }] },
    { id: 2, name: "Bruno", windows: [{ from: 8, to: 15 }] },
    { id: 3, name: "Carla", windows: [{ from: 6, to: 15 }] },
  ];
  it("disponíveis por escalar = quem pode e ainda não está no dia (em qualquer cidade)", () => {
    const hours = staffingByHour({
      needed: need({ 8: 3 }),
      rows: [{ employeeId: 3, startHour: 6, endHour: 14 }],
      candidates,
      alreadyScheduled: new Set([2]),
    });
    const h8 = hours.find((h) => h.hour === 8)!;
    expect(h8).toEqual({ hour: 8, needed: 3, scheduled: 1, availableIds: [1] });
    expect(describeStaffingHour(h8)).toBe("precisas 3 (além do TL) · escalados 1 · disponíveis por escalar 1");
    expect(describeStaffingGap(staffingGaps(hours, candidates)[0])).toBe("Faltam escalar 2 às 08h (só há 1 disponível: Ana)");
  });
  it("horas seguidas com a mesma falta e os mesmos disponíveis juntam-se", () => {
    const hours = staffingByHour({ needed: need({ 9: 1, 10: 1, 11: 1, 12: 1 }), rows: [], candidates });
    const gaps = staffingGaps(hours, candidates);
    expect(gaps.map((g) => [g.fromHour, g.toHour, g.available.map((a) => a.id)])).toEqual([[9, 12, [1, 2, 3]], [12, 13, [2, 3]]]);
    expect(describeStaffingGap(gaps[0])).toBe("Falta escalar 1 das 09h às 12h (há 3 disponíveis: Ana, Bruno, Carla)");
  });
  it("estado de cada hora (para a cor)", () => {
    expect(staffingHourState({ needed: 0, scheduled: 0, availableIds: [] })).toBe("idle");
    expect(staffingHourState({ needed: 2, scheduled: 2, availableIds: [] })).toBe("ok");
    expect(staffingHourState({ needed: 2, scheduled: 1, availableIds: [4] })).toBe("fillable");
    expect(staffingHourState({ needed: 2, scheduled: 1, availableIds: [] })).toBe("short");
  });
});

// ─── Pedido 8: avisar este turno ────────────────────────────────────────────

describe("aviso de trabalho do turno", () => {
  const D = "2026-09-25"; // sexta
  const person = (o: Partial<NoticePerson> & { id: number }): NoticePerson => ({
    fullName: `Pessoa ${o.id}`, isExtra: true, email: null, personalEmail: `p${o.id}@gmail.com`, phoneE164: "+351910000000",
    noAutoEmail: false, noAutoWhatsapp: false, whatsappOptedOut: false, ...o,
  });
  const r = (o: Partial<NoticeRow> & { id: number }): NoticeRow => ({
    version: 1, employeeId: o.id, personName: `Pessoa ${o.id}`, status: "confirmed", startHour: 18, endHour: 27, sentHomeHour: null, ...o,
  });
  const base = {
    date: D, city: "lisbon", meetingPoint: "Parque P1",
    channels: ["whatsapp", "email"] as ("whatsapp" | "email")[],
    configured: { whatsapp: true, email: true },
    log: [],
  };

  it("assunto e texto com as horas da pessoa (atravessa a meia-noite; saída antecipada; dois turnos)", () => {
    expect(shiftNoticeSubject(D, [{ startHour: 18, endHour: 27 }])).toBe("Aviso de trabalho — sexta 25/09, 18h–03h");
    const plan = planShiftNotice({
      ...base,
      rows: [r({ id: 1, startHour: 22, endHour: 27 }), r({ id: 2, startHour: 15, endHour: 23, sentHomeHour: 20 }), r({ id: 3, employeeId: 1, startHour: 6, endHour: 10 })],
      people: new Map([[1, person({ id: 1, fullName: "Ana Sousa" })], [2, person({ id: 2, fullName: "Rui Lopes" })]]),
    });
    const ana = plan.people.find((p) => p.employeeId === 1)!;
    expect(ana.text).toBe("sexta 25/09, das 06h às 10h e das 22h às 03h · Lisboa · ponto de encontro: Parque P1");
    expect(ana.subject).toBe("Aviso de trabalho — sexta 25/09, 06h–10h e 22h–03h");
    expect(plan.people.find((p) => p.employeeId === 2)!.text).toBe("sexta 25/09, das 15h às 20h · Lisboa · ponto de encontro: Parque P1");
  });

  it("só confirmados recebem; as propostas ficam assinaladas e não recebem", () => {
    const plan = planShiftNotice({ ...base, rows: [r({ id: 1 }), r({ id: 2, status: "proposed", startHour: 15, endHour: 20 })], people: new Map([[1, person({ id: 1 })], [2, person({ id: 2 })]]) });
    expect(plan.people.map((p) => p.employeeId)).toEqual([1]);
    expect(plan.proposals).toEqual([{ assignmentId: 2, personName: "Pessoa 2", hours: "15h–20h" }]);
    expect(plan.toSend).toEqual({ whatsapp: 1, email: 1 });
  });

  it("email de trabalho ou pessoal; 'Não enviar' e STOP respeitados; funcionário fica de fora", () => {
    expect(noticeEmailAddress({ email: "ana@multipark.pt", personalEmail: "ana@gmail.com" })).toBe("ana@multipark.pt");
    expect(noticeEmailAddress({ email: "", personalEmail: "ana@gmail.com" })).toBe("ana@gmail.com");
    expect(noticeEmailAddress({ email: "sem-arroba", personalEmail: null })).toBeNull();
    const plan = planShiftNotice({
      ...base,
      rows: [1, 2, 3, 4].map((id) => r({ id })),
      people: new Map([
        [1, person({ id: 1, noAutoEmail: true })],
        [2, person({ id: 2, personalEmail: null, whatsappOptedOut: true })],
        [3, person({ id: 3, isExtra: false })],
        [4, person({ id: 4, phoneE164: null, noAutoWhatsapp: false })],
      ]),
    });
    const by = (id: number) => plan.people.find((p) => p.employeeId === id)!.channels;
    expect(by(1).email).toMatchObject({ action: "skip", kind: "opted_out" });
    expect(by(1).whatsapp).toEqual({ action: "send" });
    expect(by(2).email).toMatchObject({ action: "skip", kind: "no_contact" });
    expect(by(2).whatsapp).toMatchObject({ action: "skip", kind: "opted_out", reason: "pediu STOP no WhatsApp" });
    expect(by(3).whatsapp).toMatchObject({ action: "skip", kind: "not_extra" });
    expect(by(4).whatsapp).toMatchObject({ action: "skip", kind: "no_contact" });
    expect(by(4).email).toEqual({ action: "send" });
  });

  it("o email vai mesmo sem WhatsApp configurado; um canal desligado fica 'off'", () => {
    const plan = planShiftNotice({ ...base, configured: { whatsapp: false, email: true }, rows: [r({ id: 1 })], people: new Map([[1, person({ id: 1 })]]) });
    expect(plan.people[0].channels).toEqual({ whatsapp: { action: "skip", kind: "not_configured", reason: "WhatsApp não configurado" }, email: { action: "send" } });
    const onlyEmail = planShiftNotice({ ...base, channels: ["email"], rows: [r({ id: 1 })], people: new Map([[1, person({ id: 1 })]]) });
    expect(onlyEmail.people[0].channels.whatsapp).toEqual({ action: "off" });
    expect(onlyEmail.toSend).toEqual({ whatsapp: 0, email: 1 });
  });

  it("idempotente por linha/versão/canal: avisado não recebe outra vez; a linha alterada (versão nova) volta a receber", () => {
    const log = [
      { assignmentId: 1, version: 1, kind: "scheduled" as const, channel: "email" as const, status: "sent", attempts: 1 },
      { assignmentId: 1, version: 1, kind: "scheduled" as const, channel: "whatsapp" as const, status: "sent", attempts: 1 },
    ];
    const people = new Map([[1, person({ id: 1 })]]);
    const again = planShiftNotice({ ...base, log, rows: [r({ id: 1 })], people });
    expect(again.people[0].channels.email).toMatchObject({ action: "skip", kind: "already" });
    expect(again.toSend).toEqual({ whatsapp: 0, email: 0 });
    const changed = planShiftNotice({ ...base, log, rows: [r({ id: 1, version: 2, startHour: 19 })], people });
    expect(changed.toSend).toEqual({ whatsapp: 1, email: 1 });
    // falhado com menos de 3 tentativas: volta a tentar
    const failed = planShiftNotice({ ...base, log: [{ ...log[0], status: "failed", attempts: 1 }], rows: [r({ id: 1 })], people });
    expect(failed.people[0].channels.email).toEqual({ action: "send" });
  });

  it("resultado por pessoa: o pior estado das linhas da versão atual", () => {
    const log = [
      { assignmentId: 1, version: 1, kind: "scheduled" as const, channel: "email" as const, status: "sent", attempts: 1, detail: null },
      { assignmentId: 2, version: 3, kind: "scheduled" as const, channel: "email" as const, status: "failed", attempts: 1, detail: "falhou o envio do email" },
      { assignmentId: 2, version: 2, kind: "scheduled" as const, channel: "email" as const, status: "sent", attempts: 1, detail: null },
    ];
    expect(noticeOutcome([{ id: 1, version: 1 }, { id: 2, version: 3 }], log, "email")).toEqual({ status: "failed", detail: "falhou o envio do email" });
    expect(noticeOutcome([{ id: 1, version: 1 }], log, "email")).toEqual({ status: "sent", detail: null });
    expect(noticeOutcome([{ id: 1, version: 1 }], log, "whatsapp")).toBeNull();
  });
});

// ─── Pedido 4: notas do dia ─────────────────────────────────────────────────

describe("notas do dia de trabalho", () => {
  const note = (id: number, workDate: string, hour: number | null, createdAt = "2026-10-01 10:00:00") => ({ id, workDate, hour, createdAt });
  it("corpo obrigatório, limpo e com limite; hora operacional 03h–02h(+1)", () => {
    expect(normalizeDayNoteBody("  2 extras faltaram \r\n ")).toEqual({ ok: true, body: "2 extras faltaram" });
    expect(normalizeDayNoteBody("   ")).toMatchObject({ ok: false });
    expect(normalizeDayNoteBody("x".repeat(2001))).toMatchObject({ ok: false });
    expect([2, 3, 26, 27, 3.5].map(isDayNoteHour)).toEqual([false, true, true, false, false]);
    expect(dayNoteHourLabel(26)).toBe("02h (madrugada)");
    expect(dayNoteHourLabel(18)).toBe("18h");
  });
  it("arquivar: o autor ou admin+ (um supervisor não arquiva a nota de outro)", () => {
    expect(canArchiveDayNote({ id: 5, role: "team_leader" }, { authorId: 5 })).toBe(true);
    expect(canArchiveDayNote({ id: 6, role: "supervisor" }, { authorId: 5 })).toBe(false);
    expect(canArchiveDayNote({ id: 6, role: "backoffice" }, { authorId: 5 })).toBe(false);
    expect(canArchiveDayNote({ id: 6, role: "admin" }, { authorId: 5 })).toBe(true);
    expect(canArchiveDayNote({ id: 6, role: "super_admin" }, { authorId: 5 })).toBe(true);
  });
  it("célula do mapa → dia operacional: 00h–02h são a noite do dia anterior", () => {
    expect(cellToOperational(4, 1)).toEqual({ weekday: 3, hour: 25 }); // quinta 01h → quarta 25
    expect(cellToOperational(1, 0)).toEqual({ weekday: 7, hour: 24 }); // segunda 00h → domingo
    expect(cellToOperational(5, 18)).toEqual({ weekday: 5, hour: 18 });
  });
  it("detalhe da célula: mesmo dia da semana, do dia todo ou dessa hora, só as últimas datas", () => {
    const notes = [
      note(1, "2026-10-02", null), // sexta, dia todo
      note(2, "2026-10-02", 18), // sexta 18h
      note(3, "2026-10-02", 9), // sexta 09h (outra hora)
      note(4, "2026-09-25", 18), // sexta anterior
      note(5, "2026-10-01", 18), // quinta 18h
      note(6, "2026-10-01", 25), // quinta, madrugada (sexta 01h no relógio)
      note(7, "2026-09-04", null), note(8, "2026-09-11", null), note(9, "2026-09-18", null), // sextas antigas
    ];
    // 4 datas mais recentes: 02/10 (dia todo, 18h), 25/09, 18/09, 11/09 — a de 04/09 fica de fora; a das 09h não é desta hora
    expect(notesForCell(notes, 5, 18).map((n) => n.id)).toEqual([1, 2, 4, 9, 8]);
    expect(notesForCell(notes, 5, 1).map((n) => n.id)).toEqual([6]); // sexta 01h = noite de quinta (hora 25)
    expect(notesForCell(notes, 4, 18).map((n) => n.id)).toEqual([5]);
    expect(notesForCell(notes, 5, 18, 1).map((n) => n.id)).toEqual([1, 2]);
  });
  it("as notas de um dia: as do dia todo primeiro, depois por hora e pela ordem em que foram escritas", () => {
    const sorted = sortDayNotes([note(3, MON, 20, "2026-10-05 09:00:00"), note(1, MON, null, "2026-10-05 11:00:00"), note(2, MON, 20, "2026-10-05 08:00:00")]);
    expect(sorted.map((n) => n.id)).toEqual([1, 2, 3]);
  });
});

// ─── Permissões e âmbito (router) ───────────────────────────────────────────

// Utilizador da cidade de Lisboa (as cidades vêm do centro de custos).
const LISBOA = vi.hoisted(() => ({ all: false, defaultCityId: 1 as number | null, cityName: "Lisboa" as string | null, cityNames: ["Lisboa"], cityIds: [1], projectIds: [1], missingCostCenter: false }));
const state = vi.hoisted(() => ({
  access: { ...LISBOA } as { all: boolean; defaultCityId: number | null; cityName: string | null; cityNames: string[]; cityIds: number[]; projectIds: number[]; missingCostCenter: boolean },
  added: [] as any[],
  archived: [] as any[],
  note: { id: 9, city: "lisbon", workDate: "2026-10-05", authorId: 77, archivedAt: null as string | null },
  previews: [] as any[],
  sends: [] as any[],
}));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => state.access,
  loadCityAccessParts: async () => ({ access: state.access, base: state.access, all: state.access }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  logActivity: async () => {},
  // Centros de custos (para o pedido com `city` escolher a cidade certa, como em produção).
  getProjects: async () => [{ id: 1, name: "Lisboa", level: "city", parentId: null }, { id: 2, name: "Porto", level: "city", parentId: null }],
  resolveProjectIds: async (root: number) => [root],
}));
vi.mock("./extrasDayNotes", async (original) => ({
  ...(await original<object>()),
  listDayNotes: async () => [],
  addDayNote: async (input: any) => { state.added.push(input); return { id: 1 }; },
  getDayNote: async () => state.note,
  archiveDayNote: async (id: number, viewer: any) => { state.archived.push({ id, viewer }); return { archived: true }; },
}));
vi.mock("./extrasDiaShift", async (original) => ({
  ...(await original<object>()),
  previewShiftNotice: async (...args: any[]) => { state.previews.push(args); return { people: [] }; },
  sendShiftNotice: async (input: any) => { state.sends.push(input); return { people: [] }; },
  getStaffingReport: async () => ({ hours: [], gaps: [] }),
}));

const { appRouter } = await import("./routers");
const caller = (role: string, id = 77) => appRouter.createCaller({ user: { id, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);

describe("permissões: notas do dia e avisar este turno", () => {
  beforeEach(() => {
    state.access = { ...LISBOA };
    state.added = []; state.archived = []; state.previews = []; state.sends = [];
  });
  it("ler: quem vê o Extras-dia (condutor sim, extra não)", async () => {
    await expect(caller("condutor").extrasDia.dayNotes.list({ city: "lisbon", from: MON, to: MON })).resolves.toEqual([]);
    await expect(caller("extra").extrasDia.dayNotes.list({ city: "lisbon", from: MON, to: MON })).rejects.toThrow(/não autorizado/i);
  });
  it("intervalo de datas limitado", async () => {
    await expect(caller("supervisor").extrasDia.dayNotes.list({ city: "lisbon", from: "2026-01-01", to: MON })).rejects.toThrow(/Intervalo/);
    await expect(caller("supervisor").extrasDia.dayNotes.list({ city: "lisbon", from: MON, to: SUN })).rejects.toThrow(/Intervalo/);
  });
  it("escrever: quem edita o Extras-dia; o autor é sempre quem está ligado", async () => {
    await expect(caller("condutor").extrasDia.dayNotes.add({ city: "lisbon", workDate: MON, body: "x" })).rejects.toThrow(/não autorizado/i);
    await caller("team_leader", 31).extrasDia.dayNotes.add({ city: "lisbon", workDate: MON, hour: 26, body: "Muito trânsito" });
    expect(state.added).toEqual([{ city: "lisbon", workDate: MON, hour: 26, body: "Muito trânsito", authorId: 31 }]);
    await expect(caller("team_leader").extrasDia.dayNotes.add({ city: "lisbon", workDate: MON, hour: 2, body: "x" })).rejects.toThrow();
  });
  it("fora das cidades do utilizador: não lê, não escreve, não arquiva", async () => {
    state.access = { ...LISBOA, defaultCityId: 2, cityName: "Porto", cityNames: ["Porto"], cityIds: [2], projectIds: [2] };
    await expect(caller("supervisor").extrasDia.dayNotes.list({ city: "lisbon", from: MON, to: MON })).rejects.toThrow();
    await expect(caller("supervisor").extrasDia.dayNotes.add({ city: "lisbon", workDate: MON, body: "x" })).rejects.toThrow();
    await expect(caller("supervisor").extrasDia.dayNotes.archive({ id: 9 })).rejects.toThrow(/cidade/);
    expect(state.added).toEqual([]);
    expect(state.archived).toEqual([]);
    await expect(caller("supervisor").extrasDia.dayNotes.list({ city: "porto", from: MON, to: MON })).resolves.toEqual([]);
  });
  it("arquivar passa quem pediu (a regra autor/admin+ é aplicada com ele)", async () => {
    await caller("supervisor", 12).extrasDia.dayNotes.archive({ id: 9 });
    expect(state.archived).toEqual([{ id: 9, viewer: { id: 12, role: "supervisor" } }]);
  });
  it("avisar e pré-visualizar: só quem edita; canais por omissão = WhatsApp e email", async () => {
    await expect(caller("condutor").extrasDia.notifyPreview({ date: MON, city: "lisbon", shift: "night" })).rejects.toThrow(/não autorizado/i);
    await expect(caller("condutor").extrasDia.notify({ date: MON, city: "lisbon", shift: "night" })).rejects.toThrow(/não autorizado/i);
    await caller("supervisor").extrasDia.notifyPreview({ date: MON, city: "lisbon", shift: "night" });
    expect(state.previews[0]).toEqual([MON, "lisbon", "night", ["whatsapp", "email"]]);
    await caller("supervisor", 40).extrasDia.notify({ date: MON, city: "lisbon", shift: "morning", channels: ["email"] });
    expect(state.sends[0]).toEqual({ date: MON, city: "lisbon", shift: "morning", channels: ["email"], userId: 40 });
  });
  it("indicador de pessoal: quem vê o Extras-dia", async () => {
    await expect(caller("condutor").extrasDia.staffing({ date: MON, city: "lisbon" })).resolves.toMatchObject({ gaps: [] });
    await expect(caller("extra").extrasDia.staffing({ date: MON, city: "lisbon" })).rejects.toThrow(/não autorizado/i);
  });
});
