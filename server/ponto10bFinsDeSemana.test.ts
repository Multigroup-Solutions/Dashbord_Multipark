/**
 * Plano 63, passo 10b — exceções por data ao horário fixo e o ecrã Fins de
 * semana (§10.2, §10.3 `dayPlan`, §10.6). Jorge (15 out 2026): "cada
 * funcionário tem o seu horário fixo, sempre o mesmo; o fim de semana é
 * rotativo; se a pessoa tem horário e não pica, é falta."
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const state = vi.hoisted(() => ({
  schedules: [] as any[],
  leaves: [] as any[],
  overrides: [] as any[],
  overrideQueries: 0,
  escala: [] as number[],
  checkIns: new Set<number>(),
  inserted: [] as any[],
  /** a ficha de quem pede (Perfil → O meu horário) e o horário dela (todas as linhas, como a leitura do ecrã) */
  me: null as any,
  personSchedules: [] as any[],
  /** exceções gravadas pelo router (plano 63, 10b + 11) */
  savedOverrides: [] as any[],
}));

const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./db", async (original) => {
  const { extrasDiaAssignments, timeRecords, employeePenalties, scheduleOverrides } = await import("../drizzle/schema");
  const dialect = new MySqlDialect();
  const db = {
    execute: async (q: any) => {
      const t = dialect.sqlToQuery(q).sql;
      if (t.includes("FROM schedules s JOIN employees e")) return [state.schedules];
      if (t.includes("FROM schedules WHERE employeeId IN")) return [state.personSchedules];
      if (t.includes("FROM employee_leaves")) {
        // a BD a fazer o filtro que a consulta pede (plano 63, passo 11: approvedLeaveSql / fullDayLeaveSql)
        const approvedOnly = t.includes("`status` = 'approved' AND `leaveType` <> 'unavailable'");
        const fullDay = t.includes("`hours` IS NULL");
        return [state.leaves.filter((l) => (!approvedOnly || ((l.status ?? "approved") === "approved" && l.leaveType !== "unavailable")) && (!fullDay || l.hours == null))];
      }
      if (t.includes("FROM schedule_overrides o JOIN employees e")) { state.overrideQueries++; return [state.overrides]; }
      return [[]];
    },
    select: () => ({
      from: (table: any) => ({
        where: (cond: any) => {
          if (table === extrasDiaAssignments) return Promise.resolve(state.escala.map((employeeId) => ({ employeeId })));
          if (table === timeRecords) {
            const emp = Number(dialect.sqlToQuery(cond).params[0]);
            return { limit: async () => (state.checkIns.has(emp) ? [{ id: 1 }] : []) };
          }
          return Promise.resolve([]);
        },
      }),
    }),
    insert: (table: any) => ({
      values: async (v: any) => {
        if (table === scheduleOverrides) { state.savedOverrides.push(v); return [{ insertId: 500 + state.savedOverrides.length }]; }
        if (table !== employeePenalties) throw new Error("tabela inesperada");
        state.inserted.push(v);
      },
    }),
    update: () => ({ set: () => ({ where: async () => [{ affectedRows: 0 }] }) }),
    transaction: async (fn: any) => fn(db),
  };
  const orig = await original<any>();
  return {
    ...orig,
    getDb: async () => db,
    getUserPermissionOverrides: async () => ({}),
    getUserModuleOverrides: async () => ({}),
    getEmployeeByUserId: async (userId: number) => (state.me && (state.me.userId == null || state.me.userId === userId) ? { employee: state.me } : null),
    getEmployeeById: async (id: number) => (state.me && state.me.id === id ? { employee: state.me } : orig.getEmployeeById(id)),
    logActivity: async () => undefined,
  };
});
vi.mock("./personIdentity", () => ({ agentIdsOfEmployee: async () => ({ agentUserIds: [] }) }));
vi.mock("./notify", () => ({ notify: async () => undefined }));

import { detectFixedScheduleNoShows } from "./rhService";
import { computeEmployeeDays, scheduledStartUtcMs, type EngineInput } from "./evaluationCore";
import { buildEvaluationIdentity } from "./evaluationIdentity";
import { activeOverrideOn, dayPlan, fixedScheduledStarts, OVERRIDE_REASONS, workRowOn, type FixedScheduleRow, type ScheduleOverrideRow } from "../shared/workSchedule";
import { addDays, lisbonWallTimeUtcMs, operationalDayOf } from "../shared/lisbonDay";
import { correctionRange } from "../shared/terminalWatch";
import { hoursOfHhmm, ptHolidayOf, type LeaveRow } from "../shared/workSchedule";
import {
  boardWarnings, compensationMap, compensationMatches, compensationServing, dayLabelPt, defaultDutyHours, isValidDay, needsCompensation, planCompensations, planOf,
  proposeCompensationDay, rotationPattern, rotationTargets, saturdayOnOrAfter, saturdaysFrom, warningText, weekendBoard, workRuns, type PersonSchedule,
} from "../shared/weekendRotation";
import { AUTOMATION_FLAGS, automationFlagDefault, automationFlagSuperAdminOnly } from "../shared/appSettings";
import { kindDef } from "../shared/notificationRouting";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { expectedHoursFromSchedule } from "./payroll/compute";
import { MIGRATION_0725_STATEMENTS, IDEMPOTENT_ERROR_CODES_0725 } from "./migrations/migration_0725";
import { WEEKENDS_FLAG, WEEKENDS_NOTIFY_FLAG, canMarkScheduleOverride, loadActiveOverridesForReaders, loadSchedulesAndLeaves, overrideNoticeText, todayLisbon } from "./scheduleOverrides";
import { appRouter } from "./routers";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");
const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());

// Novembro de 2026: Lisboa = UTC. 2 nov = segunda, 4 = quarta, 6 = sexta, 7 = sábado, 8 = domingo.
const row = (employeeId: number, weekday: number, startTime: string, endTime: string, o: Partial<FixedScheduleRow> = {}): FixedScheduleRow =>
  ({ employeeId, weekday, startTime, endTime, isWorkDay: true, ...o });
const weekdays = (employeeId: number, startTime = "09:00", endTime = "18:00") => [1, 2, 3, 4, 5].map((wd) => row(employeeId, wd, startTime, endTime));
const ov = (employeeId: number, day: string, kind: "work" | "off", o: Partial<ScheduleOverrideRow> = {}): ScheduleOverrideRow =>
  ({ employeeId, day, kind, startTime: kind === "work" ? "09:00" : null, endTime: kind === "work" ? "18:00" : null, reason: kind === "work" ? "weekend" : "compensation", ...o });

beforeEach(() => {
  state.schedules = []; state.leaves = []; state.overrides = []; state.overrideQueries = 0; state.escala = []; state.checkIns = new Set(); state.inserted = [];
  state.me = null; state.personSchedules = []; state.savedOverrides = [];
  process.env.FINS_DE_SEMANA = "on";
});
afterEach(() => { delete process.env.FINS_DE_SEMANA; delete process.env.FINS_DE_SEMANA_AVISO; });

describe("dayPlan — Extras-Dia > exceção > horário fixo", () => {
  const base = { schedules: weekdays(2) };
  it("a ordem: escala, depois a exceção da data, depois o horário fixo; nada sem horário", () => {
    expect(dayPlan({ ...base, calendarDay: "2026-11-02", inEscala: true, overrides: [ov(2, "2026-11-02", "off")] })).toEqual({ kind: "escala" });
    expect(dayPlan({ ...base, calendarDay: "2026-11-02", overrides: [ov(2, "2026-11-02", "work", { startTime: "13:00", endTime: "22:00" })] }))
      .toMatchObject({ kind: "work", source: "override", startTime: "13:00", endTime: "22:00" });
    expect(dayPlan({ ...base, calendarDay: "2026-11-02" })).toMatchObject({ kind: "work", source: "fixed", startTime: "09:00", endTime: "18:00" });
    expect(dayPlan({ ...base, calendarDay: "2026-11-07" })).toMatchObject({ kind: "none", reason: "no_schedule" });
  });
  it("uma folga por exceção tira o dia fixo", () => {
    expect(dayPlan({ ...base, calendarDay: "2026-11-02", overrides: [ov(2, "2026-11-02", "off")] })).toMatchObject({ kind: "none", reason: "override_off" });
  });
  it("feriado sem exceção → nada; com exceção 'trabalha' → conta (feriado de serviço)", () => {
    expect(dayPlan({ ...base, calendarDay: "2026-12-08" })).toMatchObject({ kind: "none", reason: "holiday" });
    expect(dayPlan({ ...base, calendarDay: "2026-12-08", overrides: [ov(2, "2026-12-08", "work", { reason: "holiday" })] })).toMatchObject({ kind: "work", source: "override" });
  });
  it("férias, fora do contrato e os modos 2/3 tiram também a exceção", () => {
    const o = [ov(2, "2026-11-07", "work")];
    expect(dayPlan({ ...base, calendarDay: "2026-11-07", overrides: o, leaves: [{ employeeId: 2, fromDate: "2026-11-07", toDate: "2026-11-08" }] })).toMatchObject({ reason: "leave" });
    expect(dayPlan({ ...base, calendarDay: "2026-11-07", overrides: o, contractEnd: "2026-11-06" })).toMatchObject({ reason: "out_of_contract" });
    expect(dayPlan({ ...base, calendarDay: "2026-11-07", overrides: o, pontoMode: "exempt" })).toMatchObject({ reason: "mode" });
    expect(dayPlan({ ...base, calendarDay: "2026-11-07", overrides: o, pontoMode: "always_on" })).toMatchObject({ reason: "mode" });
    expect(dayPlan({ ...base, calendarDay: "2026-11-07", overrides: o, pontoMode: "fixed" })).toMatchObject({ kind: "work" });
  });
  it("canceladas não contam; duas ativas no mesmo dia (dados antigos) → ganha a mais recente", () => {
    expect(activeOverrideOn([ov(2, "2026-11-07", "work", { id: 5, cancelledAt: "2026-11-01 10:00:00" })], "2026-11-07")).toBeNull();
    expect(activeOverrideOn([ov(2, "2026-11-07", "work", { id: 9 }), ov(2, "2026-11-07", "off", { id: 4 })], "2026-11-07")).toMatchObject({ id: 9, kind: "work" });
  });
  it("[R2] duplicados: duas linhas de quarta (ids 7 e 9) → usa a 7, venha pela ordem que vier", () => {
    const dup = [row(2, 3, "11:00", "20:00", { id: 9 }), row(2, 3, "08:00", "17:00", { id: 7 })];
    expect(workRowOn(dup, 3)).toMatchObject({ id: 7, startTime: "08:00" });
    expect(dayPlan({ calendarDay: "2026-11-04", schedules: dup })).toMatchObject({ startTime: "08:00" });
  });
  it("duplicados com uma folga e um dia de trabalho → ganha o de trabalho (o que a Avaliação e as faltas leem, e o que a folha conta)", () => {
    // a consulta dos leitores só traz isWorkDay = 1: a linha 9; o quadro e o Perfil leem as duas e têm de dizer o mesmo
    const dup = [row(2, 3, "00:00", "00:00", { id: 7, isWorkDay: false }), row(2, 3, "08:00", "17:00", { id: 9 }), row(2, 3, "10:00", "19:00", { id: 12 })];
    expect(workRowOn(dup, 3)).toMatchObject({ id: 9 });
    expect(dayPlan({ calendarDay: "2026-11-04", schedules: dup })).toMatchObject({ kind: "work", startTime: "08:00" });
    expect(fixedScheduledStarts("2026-11-04", "2026-11-04", dup).map((f) => iso(f.startMs))).toEqual(["2026-11-04T08:00:00.000Z"]);
    expect(fixedScheduledStarts("2026-11-04", "2026-11-04", dup.filter((r) => r.isWorkDay))).toEqual(fixedScheduledStarts("2026-11-04", "2026-11-04", dup));
    // só folgas nesse dia → folga
    expect(dayPlan({ calendarDay: "2026-11-04", schedules: [row(2, 3, "08:00", "17:00", { id: 3, isWorkDay: 0 as any })] })).toMatchObject({ kind: "none", reason: "day_off" });
  });
});

describe("atraso (−5) pela hora do dayPlan", () => {
  const identity = buildEvaluationIdentity({ employees: [{ id: 2, fullName: "Rui Escritório", userId: 11, multiparkAgentName: null, multiparkAgentUserId: null }], agentAliases: [], accountAliases: [] });
  const input = (o: Partial<EngineInput>): EngineInput => ({
    startDay: "2026-11-02", endDay: "2026-11-02", identity, employees: new Map(),
    actions: [], ponto: [], assignments: [], incidents: [], complaints: [], speedAlerts: [], penalties: [], rate: () => 10, tlWorkingDaysPerMonth: 15, ...o,
  });
  const ci = (at: string) => ({ id: Math.random(), employeeId: 2, type: "check_in" as const, recordedAt: at });
  const delays = (o: Partial<EngineInput>) => computeEmployeeDays(input(o)).rows.find((r) => r.employeeId === 2)?.metrics.delays ?? 0;

  it("07–17: entrada às 07:05 → −5; às 07:04:59 → nada", () => {
    const fixedSchedules = weekdays(2, "07:00", "17:00");
    expect(delays({ fixedSchedules, ponto: [ci("2026-11-02 07:05:00")] })).toBe(1);
    expect(delays({ fixedSchedules, ponto: [ci("2026-11-02 07:04:59")] })).toBe(0);
  });
  it("11–20 numa quarta → hora 11:00", () => {
    expect(fixedScheduledStarts("2026-11-04", "2026-11-04", [row(2, 3, "11:00", "20:00")]).map((f) => iso(f.startMs))).toEqual(["2026-11-04T11:00:00.000Z"]);
  });
  it("sábado de serviço 09–18 (exceção): atrasado às 09:10 → −5; folga por exceção numa segunda → sem atraso", () => {
    const day = { startDay: "2026-11-07", endDay: "2026-11-07" };
    expect(delays({ ...day, fixedSchedules: weekdays(2), scheduleOverrides: [ov(2, "2026-11-07", "work")], ponto: [ci("2026-11-07 09:10:00")] })).toBe(1);
    expect(delays({ ...day, fixedSchedules: weekdays(2), ponto: [ci("2026-11-07 09:10:00")] })).toBe(0);
    expect(delays({ fixedSchedules: weekdays(2), scheduleOverrides: [ov(2, "2026-11-02", "off")], ponto: [ci("2026-11-02 09:30:00")] })).toBe(0);
  });
  it("feriado de serviço (exceção 'trabalha' a 8 dez) → o atraso conta; sem a exceção, não", () => {
    const day = { startDay: "2026-12-08", endDay: "2026-12-08", fixedSchedules: weekdays(2), ponto: [ci("2026-12-08 09:30:00")] };
    expect(delays(day)).toBe(0);
    expect(delays({ ...day, scheduleOverrides: [ov(2, "2026-12-08", "work", { reason: "holiday" })] })).toBe(1);
  });
  it("só com exceções (sem horário fixo nenhum) também há hora de entrada", () => {
    expect(delays({ startDay: "2026-11-07", endDay: "2026-11-07", scheduleOverrides: [ov(2, "2026-11-07", "work")], ponto: [ci("2026-11-07 09:06:00")] })).toBe(1);
  });
  it("[R2] escala do Extras-Dia (mesmo só proposta) no dia de uma exceção → o atraso lê a escala, como hoje", () => {
    const esc = { assignmentDate: "2026-11-07", employeeId: 2, personName: "Rui Escritório", level: "1", isTeamLeader: false, shift: "morning" as const, city: "lisbon", startHour: 10, endHour: 16, sentHomeHour: null };
    // exceção às 09:00, escala às 10:00, entrou às 09:30 → a tempo (vale a escala)
    expect(delays({ startDay: "2026-11-07", endDay: "2026-11-07", fixedSchedules: weekdays(2), scheduleOverrides: [ov(2, "2026-11-07", "work")], assignments: [esc], ponto: [ci("2026-11-07 09:30:00")] })).toBe(0);
  });
  it("sem exceções = o resultado de hoje", () => {
    const sch = [...weekdays(2), row(2, 6, "10:00", "14:00"), row(2, 0, "01:30", "09:00")];
    for (const [a, b] of [["2026-10-01", "2026-10-31"], ["2026-11-01", "2026-12-31"]]) {
      expect(fixedScheduledStarts(a, b, sch, [], [])).toEqual(fixedScheduledStarts(a, b, sch));
    }
    const legacy = fixedScheduledStarts("2026-11-02", "2026-11-08", sch);
    expect(legacy.map((f) => f.calendarDay)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
    expect(legacy.every((f) => f.source === "fixed")).toBe(true);
  });
});

// ─── Sem exceções e com o interruptor desligado, nada muda (prova com a regra de antes, tal e qual) ───

/** fixedScheduledStarts do main antes do passo 10b (copiado tal e qual), para comparar. */
function legacyFixedScheduledStarts(startDay: string, endDay: string, schedules: readonly FixedScheduleRow[], leaves: readonly LeaveRow[] = []) {
  const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();
  const within = (day: string, from?: string | null, to?: string | null) => (!from || day >= String(from).slice(0, 10)) && (!to || day <= String(to).slice(0, 10));
  const byEmp = new Map<number, FixedScheduleRow[]>();
  for (const s of schedules) {
    if (!s.employeeId || s.isWorkDay === false || Number(s.isWorkDay) === 0) continue;
    const list = byEmp.get(s.employeeId) ?? [];
    list.push(s);
    byEmp.set(s.employeeId, list);
  }
  const leavesOf = new Map<number, LeaveRow[]>();
  for (const l of leaves) leavesOf.set(l.employeeId, [...(leavesOf.get(l.employeeId) ?? []), l]);
  const out: Array<{ employeeId: number; calendarDay: string; day: string; startMs: number; endMs: number | null }> = [];
  for (let cal = addDays(startDay, -1); cal <= addDays(endDay, 1); cal = addDays(cal, 1)) {
    const wd = weekdayOf(cal);
    for (const [emp, list] of byEmp) {
      const s = list.find((x) => Number(x.weekday) === wd);
      if (!s) continue;
      const h = hoursOfHhmm(s.startTime);
      if (h == null) continue;
      if (!within(cal, s.contractStart, s.contractEnd)) continue;
      if (ptHolidayOf(cal, s.city)) continue;
      if ((leavesOf.get(emp) ?? []).some((l) => cal >= l.fromDate && cal <= l.toDate)) continue;
      const startMs = lisbonWallTimeUtcMs(cal, h);
      const day = operationalDayOf(startMs);
      if (day < startDay || day > endDay) continue;
      const he = hoursOfHhmm(s.endTime ?? null);
      const endMs = he == null ? null : lisbonWallTimeUtcMs(he > h ? cal : addDays(cal, 1), he);
      out.push({ employeeId: emp, calendarDay: cal, day, startMs, endMs });
    }
  }
  return out;
}

describe("sem exceções = exatamente o mesmo que antes do 10b (2 000 horários ao acaso)", () => {
  // gerador reprodutível
  const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const TIMES = ["07:00", "09:00", "11:00", "08:30", "23:00", "22:30", "01:30", "02:15", "00:00", "03:00", "9h", "", "25:00", "08:30:00", "7:05"];
  const ENDS = [...TIMES, null, "17:00", "20:00", "07:00"];
  // à volta das mudanças da hora, dos feriados nacionais e municipais, da Páscoa e de meses normais
  const STARTS = ["2026-03-26", "2027-03-25", "2026-10-22", "2027-10-28", "2026-06-10", "2026-06-22", "2026-09-05", "2026-12-06", "2027-03-24", "2026-11-02", "2026-04-01", "2026-12-23"];
  const strip = (xs: ReturnType<typeof fixedScheduledStarts>) => xs.map(({ source: _s, ...x }) => x);

  it("mesmas entradas e saídas, pela mesma ordem (com folgas, duplicados, horas inválidas, contratos, férias, cidades e a mudança da hora)", () => {
    const r = rng(20261015);
    let compared = 0, nonEmpty = 0;
    for (let n = 0; n < 2000; n++) {
      const emps = 1 + Math.floor(r() * 4);
      const rows: FixedScheduleRow[] = [];
      const leaves: LeaveRow[] = [];
      let nextId = 1;
      const start = pick(r, STARTS);
      const end = addDays(start, Math.floor(r() * 10));
      for (let e = 1; e <= emps; e++) {
        const contractStart = r() < 0.3 ? addDays(start, Math.floor(r() * 6) - 2) : null;
        const contractEnd = r() < 0.3 ? addDays(start, Math.floor(r() * 10)) : null;
        const city = pick(r, ["lisbon", "porto", "faro", null] as const);
        const nRows = Math.floor(r() * 10);
        for (let k = 0; k < nRows; k++) {
          rows.push({ id: nextId++, employeeId: e, weekday: Math.floor(r() * 7), startTime: pick(r, TIMES), endTime: pick(r, ENDS), isWorkDay: pick(r, [true, true, true, false, 1, 0] as const) as any, contractStart, contractEnd, city });
        }
        if (r() < 0.4) { const f = addDays(start, Math.floor(r() * 8) - 2); leaves.push({ employeeId: e, fromDate: f, toDate: addDays(f, Math.floor(r() * 4)) }); }
      }
      // os leitores leem por ORDER BY s.id; sem ids, a ordem da lista
      const shuffled = [...rows].sort(() => r() - 0.5);
      const byId = [...shuffled].sort((a, b) => Number(a.id) - Number(b.id));
      const noIds = shuffled.map(({ id: _id, ...x }) => x);
      for (const input of [byId, noIds]) {
        const before = legacyFixedScheduledStarts(start, end, input, leaves);
        expect(strip(fixedScheduledStarts(start, end, input, leaves))).toEqual(before);
        expect(strip(fixedScheduledStarts(start, end, input, leaves, []))).toEqual(before);
        // só as linhas de trabalho (o que a consulta dos leitores traz) dá o mesmo
        expect(strip(fixedScheduledStarts(start, end, input.filter((x) => !(x.isWorkDay === false || Number(x.isWorkDay) === 0)), leaves))).toEqual(before);
        compared++;
        if (before.length) nonEmpty++;
      }
    }
    expect(compared).toBe(4000);
    expect(nonEmpty).toBeGreaterThan(2000);
  });

  it("a Avaliação (atraso −5) com exceções vazias = sem exceções, num mês inteiro com a mudança da hora", () => {
    const identity = buildEvaluationIdentity({ employees: [2, 3].map((id) => ({ id, fullName: `P${id}`, userId: id + 10, multiparkAgentName: null, multiparkAgentUserId: null })), agentAliases: [], accountAliases: [] });
    const ponto = [] as EngineInput["ponto"];
    for (let d = "2026-10-01"; d <= "2026-10-31"; d = addDays(d, 1)) {
      ponto.push({ id: ponto.length + 1, employeeId: 2, type: "check_in", recordedAt: `${d} 06:0${d.endsWith("5") ? 6 : 2}:00` });
      ponto.push({ id: ponto.length + 1, employeeId: 3, type: "check_in", recordedAt: `${d} 00:3${d.endsWith("3") ? 7 : 1}:00` });
    }
    const fixedSchedules = [...weekdays(2, "07:00", "17:00"), row(3, 0, "01:30", "09:00"), row(3, 6, "01:30", "09:00")];
    const base: EngineInput = { startDay: "2026-10-01", endDay: "2026-10-31", identity, employees: new Map(), actions: [], ponto, assignments: [], incidents: [], complaints: [], speedAlerts: [], penalties: [], rate: () => 10, tlWorkingDaysPerMonth: 15, fixedSchedules };
    const a = computeEmployeeDays(base), b = computeEmployeeDays({ ...base, scheduleOverrides: [] });
    expect(b.rows).toEqual(a.rows);
    expect(a.rows.reduce((n, x) => n + (x.metrics.delays ?? 0), 0)).toBeGreaterThan(0);
  });
});

describe("noite, e a exceção pelo dia de calendário da entrada", () => {
  it("noite 23–07: a hora de entrada é a do próprio dia (sexta 23:00 → dia operacional de sexta)", () => {
    const [f] = fixedScheduledStarts("2026-11-06", "2026-11-06", [row(2, 5, "23:00", "07:00")]);
    expect(f).toMatchObject({ calendarDay: "2026-11-06", day: "2026-11-06" });
    expect(iso(f.startMs)).toBe("2026-11-06T23:00:00.000Z");
    expect(iso(f.endMs)).toBe("2026-11-07T07:00:00.000Z");
  });
  it("[R2] folga no sábado com turno fixo de sexta 23:00–07:00 → a sexta conta, o sábado não", () => {
    const sch = [row(2, 5, "23:00", "07:00"), row(2, 6, "23:00", "07:00")];
    const out = fixedScheduledStarts("2026-11-06", "2026-11-07", sch, [], [ov(2, "2026-11-07", "off", { reason: "weekend" })]);
    expect(out.map((f) => f.calendarDay)).toEqual(["2026-11-06"]);
    expect(fixedScheduledStarts("2026-11-06", "2026-11-07", sch).map((f) => f.calendarDay)).toEqual(["2026-11-06", "2026-11-07"]);
  });
  it("exceção 'trabalha' de noite (saída ≤ entrada) acaba no dia seguinte", () => {
    const [f] = fixedScheduledStarts("2026-11-07", "2026-11-07", [], [], [ov(2, "2026-11-07", "work", { startTime: "22:00", endTime: "06:00" })]);
    expect(f).toMatchObject({ source: "override", calendarDay: "2026-11-07", day: "2026-11-07" });
    expect(iso(f.endMs)).toBe("2026-11-08T06:00:00.000Z");
  });
});

describe("mudança da hora", () => {
  it("horário às 01:30 de domingo, 25 out 2026 → a 1.ª ocorrência (01:30 de verão = 00:30 UTC), dia operacional de sábado", () => {
    expect(iso(lisbonWallTimeUtcMs("2026-10-25", 1.5))).toBe("2026-10-25T00:30:00.000Z");
    const [f] = fixedScheduledStarts("2026-10-24", "2026-10-24", [row(2, 0, "01:30", "09:00")]);
    expect(f).toMatchObject({ calendarDay: "2026-10-25", day: "2026-10-24" });
    expect(iso(f.startMs)).toBe("2026-10-25T00:30:00.000Z");
  });
  it("28 mar 2027 às 01:30 (hora que não existe) → 02:30 de verão (01:30 UTC), e não 00:30", () => {
    expect(iso(lisbonWallTimeUtcMs("2027-03-28", 1.5))).toBe("2027-03-28T01:30:00.000Z");
    expect(iso(lisbonWallTimeUtcMs("2027-03-28", 1))).toBe("2027-03-28T01:00:00.000Z");
    // as horas que existem ficam iguais
    expect(iso(lisbonWallTimeUtcMs("2027-03-28", 0.5))).toBe("2027-03-28T00:30:00.000Z");
    expect(iso(lisbonWallTimeUtcMs("2027-03-28", 2))).toBe("2027-03-28T01:00:00.000Z");
    expect(iso(lisbonWallTimeUtcMs("2027-03-28", 3))).toBe("2027-03-28T02:00:00.000Z");
    expect(iso(lisbonWallTimeUtcMs("2026-10-25", 2))).toBe("2026-10-25T02:00:00.000Z");
    // escala do Extras-Dia com startHour 25 no sábado 27 mar 2027 → 02:00 de verão (01:00 UTC)
    expect(iso(scheduledStartUtcMs("2027-03-27", 25))).toBe("2027-03-28T01:00:00.000Z");
  });
  it("correção das horas do terminal: um troço escrito dentro da hora que não existe nunca vira 23 h; o resto fica igual", () => {
    // "01:30–02:00" a 28 mar 2027 (essa meia hora não existe): vazio, e não até ao dia seguinte
    expect(correctionRange("2027-03-27 23:40:00", "01:30", "02:00")).toEqual({ from: "2027-03-28 01:30:00", until: "2027-03-28 01:30:00" });
    // à volta, igual
    expect(correctionRange("2027-03-27 23:40:00", "00:30", "03:00")).toEqual({ from: "2027-03-28 00:30:00", until: "2027-03-28 02:00:00" });
    expect(correctionRange("2027-03-27 21:00:00", "22:30", "01:00")).toEqual({ from: "2027-03-27 22:30:00", until: "2027-03-28 01:00:00" });
    // 25 out 2026 (dia de 25 h): 01:30 é a 1.ª (de verão), como antes
    expect(correctionRange("2026-10-25 00:10:00", "01:30", "01:50")).toEqual({ from: "2026-10-25 00:30:00", until: "2026-10-25 00:50:00" });
    expect(correctionRange("2026-10-24 22:00:00", "23:00", "03:00")).toEqual({ from: "2026-10-24 22:00:00", until: "2026-10-25 03:00:00" });
  });
  it("sem −5 a quem chega às 02:30 nesse domingo (antes dava −5 falso); às 02:35 já é atraso", () => {
    // 28 mar 2027 é domingo de Páscoa (feriado): só há horário com uma exceção "trabalha" (feriado de serviço)
    const identity = buildEvaluationIdentity({ employees: [{ id: 2, fullName: "Rui", userId: 11, multiparkAgentName: null, multiparkAgentUserId: null }], agentAliases: [], accountAliases: [] });
    const base = (o: Partial<EngineInput>, at: string): EngineInput => ({
      startDay: "2027-03-27", endDay: "2027-03-27", identity, employees: new Map(), actions: [], assignments: [], incidents: [], complaints: [], speedAlerts: [], penalties: [], rate: () => 10, tlWorkingDaysPerMonth: 15,
      ponto: [{ id: 1, employeeId: 2, type: "check_in", recordedAt: at }], ...o,
    });
    const delays = (o: Partial<EngineInput>, at: string) => computeEmployeeDays(base(o, at)).rows.find((r) => r.employeeId === 2)?.metrics.delays ?? 0;
    const holidayDuty = { fixedSchedules: [row(2, 0, "01:30", "09:00")], scheduleOverrides: [ov(2, "2027-03-28", "work", { startTime: "01:30", endTime: "09:00", reason: "holiday" })] };
    expect(fixedScheduledStarts("2027-03-27", "2027-03-27", holidayDuty.fixedSchedules)).toEqual([]); // Páscoa sem exceção: nada
    expect(delays(holidayDuty, "2027-03-28 01:30:00")).toBe(0); // 02:30 de Lisboa
    expect(delays(holidayDuty, "2027-03-28 01:35:00")).toBe(1);
    // escala do Extras-Dia no sábado com startHour 25 (01:00, que não existe → 02:00 de verão)
    const esc = { assignmentDate: "2027-03-27", employeeId: 2, personName: "Rui", level: "1", isTeamLeader: false, shift: "night" as const, city: "lisbon", startHour: 25, endHour: 30, sentHomeHour: null };
    expect(delays({ assignments: [esc] }, "2027-03-28 01:00:00")).toBe(0); // 02:00 de Lisboa: a horas
    expect(delays({ assignments: [esc] }, "2027-03-28 01:05:00")).toBe(1);
  });
});

describe("possíveis faltas (RH_FALTAS_HORARIO) com as exceções", () => {
  // sábado 7 nov 2026
  const sched = (employeeId: number, weekday: number, o: Record<string, unknown> = {}) => ({ id: employeeId * 10 + weekday, employeeId, weekday, startTime: "09:00", endTime: "18:00", isWorkDay: 1, contractStart: null, contractEnd: null, ...o });
  const ovRow = (employeeId: number, kind: "work" | "off", o: Record<string, unknown> = {}) => ({ id: employeeId, employeeId, day: "2026-11-07", kind, startTime: kind === "work" ? "09:00" : null, endTime: kind === "work" ? "18:00" : null, reason: "weekend", contractStart: null, contractEnd: null, ...o });
  it("sábado de serviço 09–18 sem entrada → possível falta (mesmo sem sábado no horário fixo)", async () => {
    state.schedules = [sched(2, 1)];
    state.overrides = [ovRow(2, "work")];
    const r = await detectFixedScheduleNoShows("2026-11-07");
    expect(r).toMatchObject({ scanned: 1, created: 1 });
    expect(state.inserted[0]).toMatchObject({ employeeId: 2, points: 0, status: "pending", relatedId: 20261107 });
    expect(state.inserted[0].notes).toContain("exceção por data 09:00–18:00");
  });
  it("sábado no horário fixo com a exceção 'folga' → nada; sem a exceção → falta (como hoje)", async () => {
    state.schedules = [sched(3, 6)];
    state.overrides = [ovRow(3, "off")];
    expect(await detectFixedScheduleNoShows("2026-11-07")).toMatchObject({ scanned: 0, created: 0 });
    state.overrides = [];
    expect(await detectFixedScheduleNoShows("2026-11-07")).toMatchObject({ scanned: 1, created: 1 });
  });
  it("de serviço e picou → nada; na escala do Extras-Dia → salta (a escala tem a sua regra)", async () => {
    state.overrides = [ovRow(2, "work"), ovRow(4, "work", { id: 4 })];
    state.checkIns = new Set([2]);
    state.escala = [4];
    const r = await detectFixedScheduleNoShows("2026-11-07");
    expect(r.skipped).toMatchObject({ check_in: 1, escala: 1 });
    expect(r.created).toBe(0);
  });
  it("FINS_DE_SEMANA desligado: as exceções nem se leem — fica tudo como antes", async () => {
    delete process.env.FINS_DE_SEMANA;
    state.schedules = [sched(3, 6)];
    state.overrides = [ovRow(3, "off"), ovRow(2, "work")];
    const r = await detectFixedScheduleNoShows("2026-11-07");
    expect(state.overrideQueries).toBe(0);
    expect(r).toMatchObject({ scanned: 1, created: 1 });
    expect(state.inserted.map((x) => x.employeeId)).toEqual([3]);
  });
  it("os leitores (Avaliação e faltas) usam a mesma leitura, por ordem de id, e o horário por id", () => {
    for (const f of ["server/evaluationEngine.ts", "server/rhService.ts"]) {
      const s = src(f);
      expect(s).toContain("loadActiveOverridesForReaders(db, addDays(");
      expect(s).toMatch(/SELECT s\.id, s\.employeeId, s\.weekday/);
      expect(s).toMatch(/AND COALESCE\(e\.contractType, ''\) <> 'extra'\s+ORDER BY s\.id/);
    }
    expect(src("server/evaluationEngine.ts")).toContain("scheduleOverrides,");
  });
  it("loadActiveOverridesForReaders: desligado → [] sem ir à BD; ligado → só as ativas de fichas ativas (não extras)", async () => {
    const calls: string[] = [];
    const fake = { execute: async (q: any) => { calls.push(new MySqlDialect().sqlToQuery(q).sql); return [[{ id: 1, employeeId: 2, day: "2026-11-07", kind: "work", startTime: "09:00", endTime: "18:00", reason: "weekend" }]]; } };
    delete process.env.FINS_DE_SEMANA;
    expect(await loadActiveOverridesForReaders(fake, "2026-11-06", "2026-11-08")).toEqual([]);
    expect(calls).toEqual([]);
    process.env.FINS_DE_SEMANA = "on";
    expect(await loadActiveOverridesForReaders(fake, "2026-11-06", "2026-11-08")).toMatchObject([{ id: 1, employeeId: 2, day: "2026-11-07", kind: "work" }]);
    expect(calls[0]).toMatch(/o\.activeFlag = 1/);
    expect(calls[0]).toMatch(/e\.isActive = 1 AND COALESCE\(e\.position, ''\) <> 'extra' AND COALESCE\(e\.contractType, ''\) <> 'extra'/);
    expect(calls[0]).toMatch(/ORDER BY o\.id/);
    // tabela ainda por criar → [] (sem rebentar a Avaliação nem as faltas)
    expect(await loadActiveOverridesForReaders({ execute: async () => { throw new Error("Table 'schedule_overrides' doesn't exist"); } }, "2026-11-06", "2026-11-08")).toEqual([]);
  });
});

describe("fins de semana: quadro, horas por omissão, folga de compensação e avisos", () => {
  const person = (employeeId: number, name: string, o: Partial<PersonSchedule> = {}): PersonSchedule =>
    ({ employeeId, name, schedules: weekdays(employeeId), overrides: [], leaves: [], ...o });

  it("datas: sábados a partir de um dia, rótulos e validação", () => {
    expect(saturdayOnOrAfter("2026-10-15")).toBe("2026-10-17");
    expect(saturdayOnOrAfter("2026-10-17")).toBe("2026-10-17");
    expect(saturdaysFrom("2026-10-15", 3)).toEqual(["2026-10-17", "2026-10-24", "2026-10-31"]);
    expect(saturdaysFrom("2026-10-15", 99)).toHaveLength(26);
    expect(dayLabelPt("2026-10-24")).toBe("sáb 24 out");
    expect(isValidDay("2026-02-30")).toBe(false);
    expect(isValidDay("2026-2-3")).toBe(false);
    expect(isValidDay("2026-11-07")).toBe(true);
  });
  it("as horas por omissão são as do horário da pessoa nesse dia; sem ele, 09:00–18:00", () => {
    expect(defaultDutyHours([row(2, 6, "10:00", "16:00")], "2026-11-07")).toEqual({ startTime: "10:00", endTime: "16:00" });
    expect(defaultDutyHours(weekdays(2), "2026-11-07")).toEqual({ startTime: "09:00", endTime: "18:00" });
    expect(defaultDutyHours([row(2, 6, "10:00", "16:00", { isWorkDay: false })], "2026-11-07")).toEqual({ startTime: "09:00", endTime: "18:00" });
  });
  it("folga de compensação: o dia útil mais perto no MESMO mês; noutro mês só se não houver", () => {
    const ana = person(2, "Ana");
    // sábado 7 nov → sexta 6 (antes) ou segunda 9 (depois): a sexta está a 1 dia
    expect(proposeCompensationDay(ana, "2026-11-07")).toEqual({ day: "2026-11-06", sameMonth: true });
    // domingo 8 nov → segunda 9
    expect(proposeCompensationDay(ana, "2026-11-08")).toEqual({ day: "2026-11-09", sameMonth: true });
    // sábado 31 out → sexta 30 out (mesmo mês); domingo 1 nov → segunda 2 nov
    expect(proposeCompensationDay(ana, "2026-10-31")).toEqual({ day: "2026-10-30", sameMonth: true });
    expect(proposeCompensationDay(ana, "2026-11-01")).toEqual({ day: "2026-11-02", sameMonth: true });
    // sábado 1 ago 2026: a sexta 31 jul é noutro mês → segunda 3 ago
    expect(proposeCompensationDay(ana, "2026-08-01")).toEqual({ day: "2026-08-03", sameMonth: true });
    // domingo 31 jan 2027 com a semana anterior toda tomada → segunda 1 fev (noutro mês, com aviso)
    const taken = new Set(["2027-01-25", "2027-01-26", "2027-01-27", "2027-01-28", "2027-01-29"]);
    expect(proposeCompensationDay(ana, "2027-01-31", taken)).toEqual({ day: "2027-02-01", sameMonth: false });
    // nunca num feriado nem num dia sem horário fixo: o Rui só trabalha às terças; 1 e 8 dez 2026 são feriados
    const rui = person(3, "Rui", { schedules: [row(3, 2, "09:00", "18:00")] });
    expect(proposeCompensationDay(rui, "2026-12-06")).toBeNull();
    expect(proposeCompensationDay(rui, "2026-12-13")).toEqual({ day: "2026-12-15", sameMonth: true });
  });
  it("só precisa de compensação o dia que o horário fixo não tinha", () => {
    const sabFixo = person(2, "Ana", { schedules: [...weekdays(2), row(2, 6, "10:00", "14:00")], overrides: [ov(2, "2026-11-07", "work", { id: 1 })] });
    expect(needsCompensation(sabFixo, "2026-11-07")).toBe(false);
    const sabExtra = person(3, "Rui", { overrides: [ov(3, "2026-11-07", "work", { id: 2 })] });
    expect(needsCompensation(sabExtra, "2026-11-07")).toBe(true);
    expect(compensationMatches({ ...sabExtra, overrides: [...sabExtra.overrides, ov(3, "2026-11-09", "off", { id: 3 })] }, ["2026-11-07"]).get("2026-11-07")).toBe("2026-11-09");
  });
  it("folgas de compensação: os pares mais perto primeiro — um serviço antigo sem folga não rouba a do sábado ao lado", () => {
    // domingo 1 nov de serviço sem folga; sábado 7 nov de serviço com a folga na sexta 6
    const ana = person(2, "Ana", { overrides: [ov(2, "2026-11-01", "work", { id: 1 }), ov(2, "2026-11-07", "work", { id: 2 }), ov(2, "2026-11-06", "off", { id: 3 })] });
    const m = compensationMatches(ana, ["2026-11-01", "2026-11-07"]);
    expect(m.get("2026-11-07")).toBe("2026-11-06");
    expect(m.get("2026-11-01")).toBeNull();
    expect(compensationServing(ana, "2026-11-07")).toBe("2026-11-06");
    expect(compensationMap(ana, "2026-10-25", "2026-11-14")).toEqual(new Map([["2026-11-01", null], ["2026-11-07", "2026-11-06"]]));
    // marcar o domingo 1 nov agora não reaproveita a sexta 6 (já serve o sábado 7): propõe outra
    expect(planCompensations(ana, ["2026-11-01"], "2026-10-15")).toEqual({ compensations: [{ forDay: "2026-11-01", day: "2026-11-02", sameMonth: true }], without: [] });
  });
  it("planCompensations: o mesmo mês, nunca no passado, nunca em dia com exceção, nada para quem já tinha o dia no horário fixo", () => {
    const ana = person(2, "Ana", { overrides: [ov(2, "2026-11-07", "work", { id: 1 }), ov(2, "2026-11-08", "work", { id: 2 })] });
    expect(planCompensations(ana, ["2026-11-07", "2026-11-08"], "2026-10-15")).toEqual({
      compensations: [{ forDay: "2026-11-07", day: "2026-11-06", sameMonth: true }, { forDay: "2026-11-08", day: "2026-11-09", sameMonth: true }], without: [],
    });
    // hoje é sábado 7 nov: a sexta 6 já passou → segunda 9 e terça 10
    expect(planCompensations(ana, ["2026-11-07", "2026-11-08"], "2026-11-07").compensations.map((c) => c.day)).toEqual(["2026-11-09", "2026-11-10"]);
    // a sexta 6 já tem uma troca marcada → não serve
    const comTroca = { ...ana, overrides: [...ana.overrides, ov(2, "2026-11-06", "work", { id: 3, reason: "swap", startTime: "13:00", endTime: "22:00" })] };
    expect(planCompensations(comTroca, ["2026-11-07"], "2026-10-15").compensations[0].day).toBe("2026-11-09");
    // quem já tem o sábado no horário fixo não precisa de folga
    const sabFixo = person(3, "Rui", { schedules: [...weekdays(3), row(3, 6, "10:00", "14:00")], overrides: [ov(3, "2026-11-07", "work", { id: 4 })] });
    expect(planCompensations(sabFixo, ["2026-11-07"], "2026-10-15")).toEqual({ compensations: [], without: [] });
    // com a folga já marcada, marcar outra vez não duplica
    const comFolga = { ...ana, overrides: [...ana.overrides, ov(2, "2026-11-06", "off", { id: 5 }), ov(2, "2026-11-09", "off", { id: 6 })] };
    expect(planCompensations(comFolga, ["2026-11-07", "2026-11-08"], "2026-10-15").compensations).toEqual([]);
  });
  it("quadro: quem está de serviço (marcado ou pelo horário fixo), quem tem folga, e a folga de compensação", () => {
    const ana = person(2, "Ana", { overrides: [ov(2, "2026-11-07", "work", { id: 1 }), ov(2, "2026-11-09", "off", { id: 2 })] });
    const rui = person(3, "Rui", { schedules: [...weekdays(3), row(3, 0, "10:00", "16:00")], overrides: [ov(3, "2026-11-15", "off", { id: 3, reason: "weekend" })] });
    const [w1, w2] = weekendBoard([ana, rui], ["2026-11-07", "2026-11-14"], "lisbon");
    expect(w1.days[0].onDuty).toMatchObject([{ employeeId: 2, source: "override", needsCompensation: true, compensationDay: "2026-11-09" }]);
    expect(w1.days[1].onDuty).toMatchObject([{ employeeId: 3, source: "fixed", startTime: "10:00", needsCompensation: false }]);
    expect(w2.days[0].onDuty).toEqual([]);
    expect(w2.days[1].off).toMatchObject([{ employeeId: 3, reason: "weekend" }]);
  });
  it("aviso: fim de semana sem ninguém", () => {
    const w = boardWarnings([person(2, "Ana", { overrides: [ov(2, "2026-11-07", "work", { id: 1 })] })], ["2026-11-07"], "lisbon");
    expect(w).toEqual([{ kind: "no_one", day: "2026-11-08" }]);
    expect(warningText(w[0])).toBe("dom 8 nov: ninguém de serviço.");
  });
  it("aviso: 7 dias seguidos sem folga (seg a sáb + domingo de serviço)", () => {
    const ana = person(2, "Ana", { overrides: [ov(2, "2026-11-07", "work", { id: 1 }), ov(2, "2026-11-08", "work", { id: 2 })] });
    expect(workRuns(ana, "2026-11-01", "2026-11-15")).toEqual([{ from: "2026-11-02", to: "2026-11-13", days: 12 }]);
    const w = boardWarnings([ana], ["2026-11-07"], "lisbon").filter((x) => x.kind === "seven_days");
    expect(w).toMatchObject([{ employeeId: 2, from: "2026-11-02", to: "2026-11-13" }]);
    expect(warningText(w[0])).toMatch(/12 dias seguidos sem folga/);
    // com uma folga de compensação a meio já não há 7 seguidos
    const comFolga = { ...ana, overrides: [...ana.overrides, ov(2, "2026-11-06", "off", { id: 3 }), ov(2, "2026-11-09", "off", { id: 4 })] };
    expect(boardWarnings([comFolga], ["2026-11-07"], "lisbon").filter((x) => x.kind === "seven_days")).toEqual([]);
  });
  it("aviso: folga de compensação noutro mês", () => {
    const ana = person(2, "Ana", { overrides: [ov(2, "2026-10-31", "work", { id: 1 }), ov(2, "2026-11-02", "off", { id: 2 })] });
    const w = boardWarnings([ana], ["2026-10-31"], "lisbon").filter((x) => x.kind === "comp_other_month");
    expect(w).toEqual([{ kind: "comp_other_month", employeeId: 2, name: "Ana", day: "2026-10-31", compensationDay: "2026-11-02" }]);
    expect(warningText(w[0])).toMatch(/noutro mês/);
  });
  it("Repetir a rotação: A, B, C → A, B, C, A… com as mesmas horas; só as marcações de fim de semana", () => {
    const people = [
      person(2, "Ana", { overrides: [ov(2, "2026-11-07", "work", { id: 1, startTime: "08:00", endTime: "16:00" }), ov(2, "2026-11-08", "work", { id: 2 })] }),
      person(3, "Rui", { overrides: [ov(3, "2026-11-14", "work", { id: 3 }), ov(3, "2026-11-10", "off", { id: 4 })] }),
      person(4, "Sara", { overrides: [ov(4, "2026-11-21", "work", { id: 5 }), ov(4, "2026-11-22", "work", { id: 6, reason: "swap" })] }),
    ];
    const pattern = rotationPattern(people, ["2026-11-07", "2026-11-14", "2026-11-21"]);
    expect(pattern.map((w) => w.map((e) => `${e.employeeId}/${e.offset}`))).toEqual([["2/0", "2/1"], ["3/0"], ["4/0"]]);
    const t = rotationTargets(pattern, "2026-11-21", 4);
    expect(t.map((x) => x.saturday)).toEqual(["2026-11-28", "2026-12-05", "2026-12-12", "2026-12-19"]);
    expect(t.map((x) => x.entries.map((e) => `${e.employeeId}@${e.day}`))).toEqual([
      ["2@2026-11-28", "2@2026-11-29"], ["3@2026-12-05"], ["4@2026-12-12"], ["2@2026-12-19", "2@2026-12-20"],
    ]);
    expect(t[0].entries[0]).toMatchObject({ startTime: "08:00", endTime: "16:00", kind: "work" });
    expect(rotationTargets([], "2026-11-21", 4)).toEqual([]);
  });
});

describe("quem marca (supervisor da cidade, RH, administradores)", () => {
  const v = (role: string, o: Record<string, unknown> = {}) => ({ id: 1, role, employeeId: 50, scopeProjectIds: [10], ...o });
  const e = (o: Record<string, unknown> = {}) => ({ id: 7, projectId: 10, role: "frontoffice", position: null, ...o });
  it("super admin e admin sim; o admin nunca numa ficha de super admin", () => {
    expect(canMarkScheduleOverride(v("super_admin"), e({ role: "super_admin" }))).toBe(true);
    expect(canMarkScheduleOverride(v("admin"), e())).toBe(true);
    expect(canMarkScheduleOverride(v("admin"), e({ role: "super_admin" }))).toBe(false);
  });
  it("ninguém marca o próprio horário — nem o super admin nem o admin", () => {
    for (const role of ["super_admin", "admin", "backoffice", "supervisor"]) {
      expect(canMarkScheduleOverride(v(role), e({ id: 50, role })), role).toBe(false);
    }
  });
  it("back office (o RH) em todas as cidades; supervisor só na sua; nunca na própria ficha nem a admins", () => {
    expect(canMarkScheduleOverride(v("backoffice", { scopeProjectIds: null }), e({ projectId: 99 }))).toBe(true);
    expect(canMarkScheduleOverride(v("supervisor"), e())).toBe(true);
    expect(canMarkScheduleOverride(v("supervisor"), e({ projectId: 99 }))).toBe(false);
    expect(canMarkScheduleOverride(v("supervisor"), e({ id: 50 }))).toBe(false);
    expect(canMarkScheduleOverride(v("backoffice"), e({ role: "admin" }))).toBe(false);
    expect(canMarkScheduleOverride(v("supervisor"), e({ role: null, position: "team_leader" }))).toBe(true);
  });
  it("team leader, front office e os outros não", () => {
    for (const role of ["team_leader", "frontoffice", "extra", "condutor", "user"]) expect(canMarkScheduleOverride(v(role), e()), role).toBe(false);
  });
});

describe("interruptores, migração, aviso e ajuda", () => {
  it("FINS_DE_SEMANA e FINS_DE_SEMANA_AVISO: no catálogo, desligados, só o super admin muda", () => {
    for (const name of [WEEKENDS_FLAG, WEEKENDS_NOTIFY_FLAG]) {
      expect(AUTOMATION_FLAGS.some((f) => f.name === name), name).toBe(true);
      expect(automationFlagDefault(name), name).toBe(false);
      expect(automationFlagSuperAdminOnly(name), name).toBe(true);
    }
    expect(WEEKENDS_FLAG).toBe("FINS_DE_SEMANA");
    expect(WEEKENDS_NOTIFY_FLAG).toBe("FINS_DE_SEMANA_AVISO");
  });
  it("0725: só cria a tabela, idempotente, uma ativa por pessoa e dia (por colunas), e registada por ordem crescente", () => {
    expect(MIGRATION_0725_STATEMENTS).toHaveLength(1);
    const ddl = MIGRATION_0725_STATEMENTS[0];
    expect(ddl).toMatch(/^CREATE TABLE IF NOT EXISTS `schedule_overrides`/);
    expect(ddl).toContain("UNIQUE KEY `uq_schedule_overrides_active` (`employeeId`, `day`, `activeFlag`)");
    expect(ddl).toContain("`activeFlag` TINYINT NULL DEFAULT 1");
    expect(ddl).toContain("`cancelledAt` TIMESTAMP NULL");
    expect(ddl).not.toMatch(/DROP|DELETE|TRUNCATE/i);
    expect([...IDEMPOTENT_ERROR_CODES_0725]).toEqual(["ER_TABLE_EXISTS_ERROR"]);
    expect(SCHEMA_MIGRATION_IDS).toContain("0725");
    expect(SCHEMA_MIGRATION_IDS.indexOf("0725")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0685"));
    expect(OVERRIDE_REASONS).toEqual(["weekend", "holiday", "compensation", "swap", "other"]);
  });
  it("cancelar nunca apaga (só UPDATE com cancelledAt), e fica no registo de atividade", () => {
    const s = src("server/scheduleOverrides.ts");
    expect(s).not.toMatch(/\.delete\(|DELETE FROM/);
    expect(s).toContain('action: "schedule_override_set"');
    expect(s).toContain('action: "schedule_override_cancel"');
  });
  it("o aviso à pessoa: tipo pessoal, só de hoje para a frente e com os dois interruptores", () => {
    expect(kindDef("my_schedule_override")).toMatchObject({ personal: true, module: "ficha" });
    const t = overrideNoticeText([{ day: "2026-11-08", kind: "work", startTime: "09:00", endTime: "18:00" }, { day: "2026-11-07", kind: "work", startTime: "09:00", endTime: "18:00" }, { day: "2026-11-09", kind: "off", reason: "compensation" }]);
    expect(t.title).toBe("Estás de serviço: sáb 7 nov, dom 8 nov");
    expect(t.body.split("\n")[2]).toBe("seg 9 nov: folga (compensação)");
    expect(overrideNoticeText([{ day: "2026-11-07", kind: "work", cancelled: true }]).title).toBe("O teu horário mudou");
    const s = src("server/scheduleOverrides.ts");
    expect(s).toMatch(/!\(await flagOn\(WEEKENDS_FLAG\)\) \|\| !\(await flagOn\(WEEKENDS_NOTIFY_FLAG\)\)/);
    expect(s).toContain("c.day >= today");
  });
  it("a ajuda fala do ecrã, das exceções, do Perfil e dos interruptores", () => {
    expect(src("docs/ajuda/rh-ponto.md")).toMatch(/## Fins de semana e exceções por data/);
    expect(src("docs/ajuda/perfil.md")).toMatch(/O meu horário/);
    expect(src("docs/ajuda/definicoes.md")).toMatch(/RH: fins de semana e exceções por data/);
  });
});

// Integração 10a + 10b: UMA regra para a linha que conta (workRowOn), em todos os leitores.
describe("a linha que conta é a mesma em todos os leitores (10a + 10b)", () => {
  // sábado 7 nov 2026 (Lisboa = UTC): uma FOLGA de id baixo (3) e uma linha de TRABALHO de id alto (9), 10:00–16:00
  const mixed = (): FixedScheduleRow[] => [
    row(2, 6, "00:00", "00:00", { id: 3, isWorkDay: false }),
    row(2, 6, "10:00", "16:00", { id: 9 }),
  ];
  const onlyOff = (): FixedScheduleRow[] => [row(2, 6, "10:00", "16:00", { id: 3, isWorkDay: false }), row(2, 6, "11:00", "17:00", { id: 9, isWorkDay: 0 as any })];
  const sat = "2026-11-07";
  const ci = (at: string) => ({ id: Math.random(), employeeId: 2, type: "check_in" as const, recordedAt: at });

  it("folga de id baixo + trabalho de id alto → dia de trabalho (10:00–16:00) na ficha, Avaliação, faltas, folha, quadro e Perfil", async () => {
    const rows = mixed();
    // a regra única
    expect(workRowOn(rows, 6)).toMatchObject({ id: 9, startTime: "10:00" });
    expect(dayPlan({ calendarDay: sat, schedules: rows })).toMatchObject({ kind: "work", source: "fixed", startTime: "10:00", endTime: "16:00" });
    // ficha → Horário: o ecrã mostra a linha do workRowOn
    expect(src("client/src/pages/HRPage.tsx")).toContain("const s = workRowOn(schedules, d) ?? schedules.find(x => x.weekday === d);");
    // Avaliação e faltas (fixedScheduledStarts): com todas as linhas = só as de trabalho (o que a consulta delas traz)
    expect(fixedScheduledStarts(sat, sat, rows).map((f) => iso(f.startMs))).toEqual(["2026-11-07T10:00:00.000Z"]);
    expect(fixedScheduledStarts(sat, sat, rows.filter((r) => r.isWorkDay))).toEqual(fixedScheduledStarts(sat, sat, rows));
    // Avaliação: entrada às 10:10 → atraso (−5); às 10:00 → nada
    const identity = buildEvaluationIdentity({ employees: [{ id: 2, fullName: "Rui Escritório", userId: 11, multiparkAgentName: null, multiparkAgentUserId: null }], agentAliases: [], accountAliases: [] });
    const delays = (at: string) => computeEmployeeDays({
      startDay: sat, endDay: sat, identity, employees: new Map(), actions: [], ponto: [ci(at)], assignments: [], incidents: [], complaints: [], speedAlerts: [], penalties: [], rate: () => 10, tlWorkingDaysPerMonth: 15, fixedSchedules: rows,
    }).rows.find((r) => r.employeeId === 2)?.metrics.delays ?? 0;
    expect(delays("2026-11-07 10:10:00")).toBe(1);
    expect(delays("2026-11-07 10:00:00")).toBe(0);
    // faltas: a consulta só traz isWorkDay = 1 (a linha 9) → possível falta com a hora dela
    state.schedules = rows.filter((r) => r.isWorkDay).map((r) => ({ ...r, isWorkDay: 1, contractStart: null, contractEnd: null }));
    expect(await detectFixedScheduleNoShows(sat)).toMatchObject({ scanned: 1, created: 1 });
    expect(state.inserted[0].notes).toContain("horário 10:00–16:00");
    // folha de ordenados: 6 h esperadas nesse sábado (a linha de trabalho; a folga não tapa)
    expect(expectedHoursFromSchedule(rows.map((r) => ({ ...r, endTime: String(r.endTime), isWorkDay: r.isWorkDay ? 1 : 0 })), sat, sat)).toBe(6);
    // quadro dos Fins de semana: de serviço pelo horário fixo, com as horas da linha de trabalho; horas por omissão iguais
    const person: PersonSchedule = { employeeId: 2, name: "Rui", schedules: rows, overrides: [], leaves: [] };
    expect(planOf(person, sat)).toMatchObject({ kind: "work", startTime: "10:00", endTime: "16:00" });
    expect(weekendBoard([person], [sat])[0].days[0].onDuty).toMatchObject([{ employeeId: 2, startTime: "10:00", endTime: "16:00", source: "fixed" }]);
    expect(defaultDutyHours(rows, sat)).toEqual({ startTime: "10:00", endTime: "16:00" });
    // Perfil → O meu horário: o sábado é de trabalho, 10:00–16:00
    state.me = { id: 2, fullName: "Rui", position: "backoffice", contractType: null, projectId: null, isActive: 1, contractStart: null, contractEnd: null, userId: 11 };
    state.personSchedules = rows.map((r) => ({ ...r, isWorkDay: r.isWorkDay ? 1 : 0 }));
    const mine = await appRouter.createCaller({ user: { id: 11, role: "backoffice", name: "Rui" }, req: { headers: {} }, res: {} } as any).rh.weekends.mine();
    expect(mine).toMatchObject({ enabled: true, employeeId: 2 });
    expect((mine as any).fixed.find((f: any) => f.weekday === 6)).toEqual({ weekday: 6, isWorkDay: true, startTime: "10:00", endTime: "16:00" });
  });

  it("só folgas nesse dia → folga em todos (sem entrada, sem horas, fora do quadro, 09:00–18:00 por omissão)", async () => {
    const rows = onlyOff();
    expect(workRowOn(rows, 6)).toBeUndefined();
    expect(dayPlan({ calendarDay: sat, schedules: rows })).toMatchObject({ kind: "none", reason: "day_off" });
    expect(fixedScheduledStarts(sat, sat, rows)).toEqual([]);
    expect(expectedHoursFromSchedule(rows.map((r) => ({ ...r, endTime: String(r.endTime), isWorkDay: 0 })), sat, sat)).toBeNull();
    const person: PersonSchedule = { employeeId: 2, name: "Rui", schedules: rows, overrides: [], leaves: [] };
    expect(weekendBoard([person], [sat])[0].days[0].onDuty).toEqual([]);
    expect(defaultDutyHours(rows, sat)).toEqual({ startTime: "09:00", endTime: "18:00" });
    state.me = { id: 2, fullName: "Rui", position: "backoffice", contractType: null, projectId: null, isActive: 1, contractStart: null, contractEnd: null, userId: 11 };
    state.personSchedules = rows.map((r) => ({ ...r, isWorkDay: 0 }));
    const mine = await appRouter.createCaller({ user: { id: 11, role: "backoffice", name: "Rui" }, req: { headers: {} }, res: {} } as any).rh.weekends.mine();
    expect((mine as any).fixed.find((f: any) => f.weekday === 6)).toEqual({ weekday: 6, isWorkDay: false, startTime: null, endTime: null });
  });

  it("ninguém escolhe a linha de outra maneira: os ecrãs dos Fins de semana usam o workRowOn", () => {
    expect(src("shared/workSchedule.ts")).not.toMatch(/export function fixedRowOn/);
    for (const f of ["shared/weekendRotation.ts", "server/rhWeekendsRouter.ts"]) {
      expect(src(f)).not.toContain("fixedRowOn");
      expect(src(f)).toContain("workRowOn(");
    }
  });
});

describe("router rh.weekends", () => {
  const caller = (role: string, id = 1) => appRouter.createCaller({ user: { id, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
  it("desligado: o estado diz que não, a ficha não mostra nada e marcar é recusado", async () => {
    delete process.env.FINS_DE_SEMANA;
    expect(await caller("admin").rh.weekends.status()).toEqual({ enabled: false, notifyEnabled: false, canManage: false });
    expect(await caller("admin").rh.weekends.forEmployee({ employeeId: 7 })).toMatchObject({ enabled: false, items: [] });
    expect(await caller("admin").rh.weekends.mine()).toEqual({ enabled: false });
    await expect(caller("admin").rh.weekends.set({ employeeId: 7, day: "2026-11-07", kind: "off", reason: "weekend" })).rejects.toThrow(/desligados/);
    await expect(caller("admin").rh.weekends.board({ city: "lisbon" })).rejects.toThrow(/desligados/);
  });
  it("ligado: o ecrã é do supervisor, do back office e dos administradores", async () => {
    expect(await caller("supervisor").rh.weekends.status()).toMatchObject({ enabled: true, canManage: true });
    expect(await caller("backoffice").rh.weekends.status()).toMatchObject({ enabled: true, canManage: true });
    expect(await caller("team_leader").rh.weekends.status()).toMatchObject({ enabled: true, canManage: false });
    expect(await caller("extra").rh.weekends.status()).toMatchObject({ canManage: false });
    await expect(caller("frontoffice").rh.weekends.board({ city: "lisbon" })).rejects.toThrow();
  });
  it("validação: datas e horas a sério; 'trabalha' pede entrada e saída diferentes; Pôr de serviço só ao fim de semana", async () => {
    await expect(caller("admin").rh.weekends.set({ employeeId: 7, day: "2026-2-30", kind: "off", reason: "weekend" })).rejects.toThrow(/Data inválida/);
    await expect(caller("admin").rh.weekends.set({ employeeId: 7, day: "2026-11-07", kind: "work", startTime: "9h", endTime: "18:00", reason: "weekend" })).rejects.toThrow(/HH:MM/);
    await expect(caller("admin").rh.weekends.set({ employeeId: 7, day: "2026-11-07", kind: "work", reason: "weekend" })).rejects.toThrow(/entrada e de saída/);
    await expect(caller("admin").rh.weekends.set({ employeeId: 7, day: "2026-11-07", kind: "work", startTime: "09:00", endTime: "09:00", reason: "weekend" })).rejects.toThrow(/não podem ser iguais/);
    await expect(caller("admin").rh.weekends.markDuty({ employeeId: 7, days: ["2026-11-09"], startTime: "09:00", endTime: "18:00" })).rejects.toThrow(/só sábados e domingos/);
    await expect(caller("admin").rh.weekends.repeatRotation({ city: "lisbon", patternFrom: "2026-11-09", patternTo: "2026-11-14", weeks: 4 })).rejects.toThrow(/de um sábado a outro sábado/);
    const far = saturdayOnOrAfter("2090-01-01");
    await expect(caller("admin").rh.weekends.repeatRotation({ city: "lisbon", patternFrom: far, patternTo: far, weeks: 4 })).rejects.toThrow(/um ano para a frente/);
  });
});

// ─── 10b + mapa de férias (11): só as ausências APROVADAS de dia inteiro ────
describe("exceções por data e férias (11): só as ausências aprovadas de dia inteiro tiram o dia e bloqueiam \"pôr de serviço\"", () => {
  const caller = (role: string, id = 1) => appRouter.createCaller({ user: { id, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
  // um sábado daqui a uma semana ou mais, sem feriado no sábado nem no domingo (os feriados tiram o horário fixo)
  const sat = saturdaysFrom(addDays(todayLisbon(), 7), 12).find((d) => !ptHolidayOf(d) && !ptHolidayOf(addDays(d, 1)))!;
  const leave = (o: Record<string, unknown>) => ({ employeeId: 2, leaveType: "vacation", fromDate: sat, toDate: addDays(sat, 1), hours: null, ...o });
  const rui = { id: 2, fullName: "Rui", position: "backoffice", contractType: "permanent", projectId: null, isActive: 1, contractStart: null, contractEnd: null, userId: 11 };
  const ruiSchedules = () => [1, 2, 3, 4, 5, 6].map((weekday, i) => ({ id: i + 1, employeeId: 2, weekday, startTime: "09:00", endTime: "18:00", isWorkDay: 1 }));

  it("loadSchedulesAndLeaves: aprovadas de dia inteiro sim; pedidas, recusadas, canceladas, de parte do dia e a indisponibilidade não", async () => {
    state.leaves = [
      leave({ status: "approved" }),
      leave({ status: "requested", fromDate: addDays(sat, 7), toDate: addDays(sat, 7) }),
      leave({ status: "rejected", fromDate: addDays(sat, 14), toDate: addDays(sat, 14) }),
      leave({ status: "cancelled", fromDate: addDays(sat, 21), toDate: addDays(sat, 21) }),
      leave({ status: "approved", leaveType: "other", hours: "2.00", fromDate: addDays(sat, 28), toDate: addDays(sat, 28) }),
      leave({ status: "approved", leaveType: "unavailable", fromDate: addDays(sat, 35), toDate: addDays(sat, 35) }),
    ];
    const { leaves } = await loadSchedulesAndLeaves([2], sat, addDays(sat, 40));
    expect(leaves).toEqual([{ employeeId: 2, fromDate: sat, toDate: addDays(sat, 1) }]);
  });
  it("Perfil → O meu horário: um pedido por aprovar não tira o sábado; as férias aprovadas tiram (dayPlan \"leave\")", async () => {
    state.me = rui;
    state.personSchedules = ruiSchedules();
    state.leaves = [leave({ status: "requested" })];
    const asked = await appRouter.createCaller({ user: { id: 11, role: "backoffice", name: "Rui" }, req: { headers: {} }, res: {} } as any).rh.weekends.mine();
    expect((asked as any).weekends.find((w: any) => w.day === sat)).toMatchObject({ work: { startTime: "09:00", endTime: "18:00" }, reason: null });
    state.leaves = [leave({ status: "approved" })];
    const approved = await appRouter.createCaller({ user: { id: 11, role: "backoffice", name: "Rui" }, req: { headers: {} }, res: {} } as any).rh.weekends.mine();
    expect((approved as any).weekends.find((w: any) => w.day === sat)).toMatchObject({ work: null, reason: "leave" });
  });
  it("pôr de serviço num dia de férias APROVADAS → recusado; com um pedido por aprovar (ou recusado) → marca", async () => {
    state.me = rui;
    state.personSchedules = ruiSchedules();
    state.leaves = [leave({ status: "approved" })];
    await expect(caller("admin").rh.weekends.set({ employeeId: 2, day: sat, kind: "work", startTime: "09:00", endTime: "18:00", reason: "weekend" }))
      .rejects.toThrow(/está de férias ou de baixa/);
    await expect(caller("admin").rh.weekends.markDuty({ employeeId: 2, days: [sat], startTime: "09:00", endTime: "18:00" })).rejects.toThrow(/está de férias ou de baixa/);
    expect(state.savedOverrides).toEqual([]);
    state.leaves = [leave({ status: "requested" }), leave({ status: "rejected", fromDate: addDays(sat, 1), toDate: addDays(sat, 1) })];
    await caller("admin").rh.weekends.set({ employeeId: 2, day: sat, kind: "work", startTime: "09:00", endTime: "18:00", reason: "weekend" });
    expect(state.savedOverrides).toEqual([expect.objectContaining({ employeeId: 2, day: sat, kind: "work", startTime: "09:00", endTime: "18:00" })]);
  });
  it("possíveis faltas: uma exceção \"trabalha\" num dia com um pedido de férias por aprovar → falta; com férias aprovadas → não", async () => {
    state.schedules = [];
    state.overrides = [{ id: 1, employeeId: 2, day: sat, kind: "work", startTime: "09:00", endTime: "18:00", reason: "weekend", contractStart: null, contractEnd: null }];
    state.leaves = [leave({ status: "requested" })];
    expect(await detectFixedScheduleNoShows(sat)).toMatchObject({ scanned: 1, created: 1 });
    state.inserted = [];
    state.leaves = [leave({ status: "approved" })];
    expect(await detectFixedScheduleNoShows(sat)).toMatchObject({ scanned: 0, created: 0 });
  });
});
