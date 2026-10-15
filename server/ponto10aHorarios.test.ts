/**
 * Plano 63, passo 10a — Horários por rever e dispensas (antes de ligar as
 * faltas automáticas, RH_FALTAS_HORARIO):
 *  - a lista só de leitura (sem horário, duplicados, horas inválidas, sem
 *    picar há 14 dias, fim de semana no horário fixo);
 *  - "apagar" um dia do horário passa a folga (nada se apaga); o upsert muda
 *    todas as linhas do dia, só aceita "HH:MM" e fica no registo de atividade;
 *  - rh.noShowSkip (fora das faltas automáticas até uma data);
 *  - a dispensa com motivo (Férias/Baixa/Justificada criam a ausência desse dia);
 *  - as regras que já estão em produção ficam iguais (0 pontos, só ontem,
 *    a escala do Extras-Dia — também a só proposta — tira a falta do horário).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const state = vi.hoisted(() => ({
  schedules: [] as any[],
  leaves: [] as any[],
  escala: [] as number[],
  checkIns: new Set<number>(),
  inserted: [] as any[],
  skips: [] as any[],
  skipUpdatedAt: null as string | null,
  saved: [] as any[],
  conflict: false,
  upserts: [] as any[],
  dayOffs: [] as any[],
  before: [] as any[],
  logs: [] as any[],
  manageDenied: false,
}));

vi.mock("./db", async (original) => {
  const { extrasDiaAssignments, timeRecords, employeePenalties, employeeLeaves, employees } = await import("../drizzle/schema");
  const dialect = new MySqlDialect();
  const params = (cond: any) => (cond ? dialect.sqlToQuery(cond).params : []);
  const resultFor = (table: any, cols: any, cond: any): any[] => {
    const p = params(cond);
    if (table === extrasDiaAssignments) return state.escala.map((employeeId) => ({ employeeId }));
    if (table === timeRecords) return state.checkIns.has(Number(p[0])) ? [{ id: 1 }] : [];
    if (table === employeePenalties) {
      if (cols && "total" in cols) return [{ total: 0 }];
      return state.inserted.filter((x) => x.id === Number(p[0]));
    }
    if (table === employeeLeaves) return state.leaves.filter((l) => l.employeeId === Number(p[0]));
    if (table === employees) return [];
    return [];
  };
  const db = {
    execute: async (q: any) => {
      const t = dialect.sqlToQuery(q).sql;
      if (t.includes("FROM schedules s JOIN employees e")) return [state.schedules];
      if (t.includes("FROM employee_leaves")) return [state.leaves];
      if (t.includes("FROM `employee_penalties` WHERE id")) {
        const id = Number(dialect.sqlToQuery(q).params[0]);
        return [state.inserted.filter((x) => x.id === id).map((x) => ({ employeeId: x.employeeId }))];
      }
      return [[]];
    },
    select: (cols?: any) => ({
      from: (table: any) => ({
        where: (cond: any) => {
          const r = () => resultFor(table, cols, cond);
          return { limit: async () => r(), then: (ok: any, ko: any) => Promise.resolve(r()).then(ok, ko) };
        },
      }),
    }),
    insert: (table: any) => ({
      values: async (v: any) => {
        if (table === employeePenalties) {
          if (state.inserted.some((x) => x.employeeId === v.employeeId && x.reason === v.reason && x.relatedId === v.relatedId)) throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
          state.inserted.push({ ...v, id: state.inserted.length + 1 });
          return [{ insertId: state.inserted.length }];
        }
        if (table === employeeLeaves) {
          state.leaves.push({ ...v, id: 100 + state.leaves.length });
          return [{ insertId: 100 + state.leaves.length - 1 }];
        }
        throw new Error("tabela inesperada");
      },
    }),
    update: (table: any) => ({
      set: (patch: any) => ({
        where: async (cond: any) => {
          if (table !== employeePenalties) return;
          const id = Number(params(cond)[0]);
          const row = state.inserted.find((x) => x.id === id);
          if (row) Object.assign(row, patch);
        },
      }),
    }),
  };
  return {
    ...(await original<object>()),
    getDb: async () => db,
    getUserModuleOverrides: async () => ({}),
    getUserPermissionOverrides: async () => ({}),
    getEmployeeByUserId: async () => null,
    logActivity: async (x: any) => { state.logs.push(x); },
    upsertSchedule: async (x: any) => { state.upserts.push(x); return { before: state.before }; },
    setScheduleDayOff: async (employeeId: number, weekday: number) => { state.dayOffs.push({ employeeId, weekday }); return { before: state.before }; },
  };
});
vi.mock("./personIdentity", () => ({ agentIdsOfEmployee: async () => ({ agentUserIds: [] }) }));
vi.mock("./multiparkDb/movements", () => ({ getAgentMovementSummaries: async () => ({ available: true, data: [] }) }));
vi.mock("./appSettings", async (original) => {
  const orig = await original<typeof import("./appSettings")>();
  return {
    ...orig,
    getSetting: async (key: string) => (key === "rh.noShowSkip" ? state.skips : null),
    getSettingFresh: async (key: string) => (key === "rh.noShowSkip" ? { value: state.skips, invalid: false, updatedAt: state.skipUpdatedAt, updatedByName: null } : null),
    setSetting: async (key: string, value: unknown, userId: number, opts: any) => {
      if (state.conflict) throw new orig.SettingConflictError({ updatedAt: "2026-10-15 09:00:00", updatedByName: "Outra" });
      state.saved.push({ key, value, userId, opts });
      state.skips = value as any[];
      return { changed: true, value };
    },
  };
});
const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./rhGuards", async (original) => ({
  ...(await original<object>()),
  assertCanManageEmployee: async () => {
    if (state.manageDenied) {
      const { TRPCError } = await import("@trpc/server");
      throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para gerir esta ficha." });
    }
  },
}));

import { detectFixedScheduleNoShows, dismissFixedNoShow, FIXED_NO_SHOW_NOTE_PREFIX } from "./rhService";
import { changeNoShowSkip } from "./scheduleReview";
import { appRouter } from "./routers";
import { fixedScheduledStarts } from "../shared/workSchedule";
import { expectedHoursFromSchedule } from "./payroll/compute";
import {
  canonicalHhmm, fixedNoShowDay, fixedNoShowDismissPlan, isHhmm, LOST_PUNCH_TAG, noShowSkipFor, noShowSkipSchema, scheduleDayToSave,
  scheduleReview, withNoShowSkip, withoutNoShowSkip,
} from "../shared/scheduleReview";
import { SETTINGS } from "../shared/appSettings";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");
const caller = (role = "super_admin", id = 1) => appRouter.createCaller({ user: { id, role, name: "Camila" }, req: { headers: {} }, res: {} } as any);
/** horário fixo 09:00–18:00 em todos os dias da semana */
const allWeek = (employeeId: number) => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ employeeId, weekday, startTime: "09:00", endTime: "18:00", isWorkDay: 1, contractStart: null, contractEnd: null }));

beforeEach(() => {
  Object.assign(state, {
    schedules: [], leaves: [], escala: [], checkIns: new Set(), inserted: [], skips: [], skipUpdatedAt: null, saved: [], conflict: false,
    upserts: [], dayOffs: [], before: [], logs: [], manageDenied: false,
  });
});

// ─── Lista "Horários por rever" (pura) ──────────────────────────────────────
describe("Horários por rever (só leitura)", () => {
  const today = "2026-10-15";
  const emp = (id: number, fullName: string, lastCheckInDay: string | null = "2026-10-14") => ({ id, fullName, projectId: 49, lastCheckInDay });
  const row = (id: number, employeeId: number, weekday: number, startTime = "09:00", endTime = "18:00", isWorkDay = 1) => ({ id, employeeId, weekday, startTime, endTime, isWorkDay });

  it("sem horário → listado (sem linhas, ou só folgas)", () => {
    const r = scheduleReview({ today, employees: [emp(1, "Ana"), emp(2, "Bruno"), emp(3, "Carla")], schedules: [row(1, 2, 1, "09:00", "18:00", 0), row(2, 3, 1)] });
    expect(r.noSchedule.map((p) => p.fullName)).toEqual(["Ana", "Bruno"]);
  });
  it("dia duplicado → listado, com a linha que a Avaliação e as faltas usam (a mais antiga)", () => {
    const r = scheduleReview({ today, employees: [emp(1, "Ana")], schedules: [row(9, 1, 3, "10:00", "19:00"), row(7, 1, 3, "09:00", "18:00"), row(8, 1, 1)] });
    expect(r.duplicates).toEqual([expect.objectContaining({ employeeId: 1, weekday: 3, usedRowId: 7, differ: true, rows: [{ id: 7, label: "09:00–18:00" }, { id: 9, label: "10:00–19:00" }] })]);
  });
  it("horas inválidas: texto que não se lê e entrada igual à saída (só nos dias de trabalho)", () => {
    const r = scheduleReview({ today, employees: [emp(1, "Ana")], schedules: [row(1, 1, 1, "9h", "18:00"), row(2, 1, 2, "08:00", "08:00"), row(3, 1, 3, "08:30:00", "17:00"), row(4, 1, 4, "x", "y", 0)] });
    expect(r.invalidTimes.map((x) => [x.weekday, x.problem])).toEqual([[1, "invalid"], [2, "same"]]);
  });
  it("com horário e sem entrada no ponto há 14 dias (ou nunca) → listado; quem picou há 14 dias não", () => {
    const r = scheduleReview({
      today, employees: [emp(1, "Ana", "2026-10-01"), emp(2, "Bruno", null), emp(3, "Carla", "2026-10-01"), emp(4, "Duarte", "2026-09-30")],
      schedules: [row(1, 1, 1), row(2, 2, 1), row(3, 3, 1, "09:00", "18:00", 0), row(4, 4, 1)],
      skips: [{ employeeId: 4, until: "2026-10-31", reason: "Impressão digital" }],
    });
    // Ana picou a 1 out (há 14 dias: no limite, não entra); Carla não tem horário (vai para "sem horário")
    expect(r.noClockIn.map((x) => [x.fullName, x.daysSince, x.skipUntil])).toEqual([["Bruno", null, null], ["Duarte", 15, "2026-10-31"]]);
  });
  it("sábado ou domingo no horário fixo → listado (o fim de semana roda)", () => {
    const r = scheduleReview({ today, employees: [emp(1, "Ana"), emp(2, "Bruno")], schedules: [row(1, 1, 6), row(2, 1, 0), row(3, 1, 1), row(4, 2, 6, "09:00", "13:00", 0), row(5, 2, 2)] });
    expect(r.weekendFixed.map((x) => [x.fullName, x.weekdays])).toEqual([["Ana", [6, 0]]]);
  });
  it("o servidor só lê (query), para quem gere o RH, nas cidades de quem vê", () => {
    const r = src("server/rhRouter.ts");
    const block = r.slice(r.indexOf("    review: protectedProcedure.query("), r.indexOf("    setNoShowSkip:"));
    expect(block).toContain('requireAccess(ctx.user, "rh", "manage")');
    const s = src("server/scheduleReview.ts");
    const load = s.slice(s.indexOf("export async function loadScheduleReview"), s.indexOf("export const NO_SHOW_SKIP_MAX_DAYS"));
    expect(load).toContain("projectScope(sql`e.projectId`)");
    expect(load).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(load).not.toMatch(/setSetting|\.insert\(|\.update\(|\.delete\(/);
  });
});

// ─── O horário: folga em vez de apagar, HH:MM, todas as linhas, registo ─────
describe("Gravar o horário", () => {
  it("só HH:MM nos dias de trabalho e entrada ≠ saída; na folga as horas não se leem (\"00:00\")", () => {
    expect(isHhmm("07:00")).toBe(true);
    expect(isHhmm("7:00")).toBe(false);
    expect(isHhmm("07:00:00")).toBe(false);
    expect(isHhmm("24:00")).toBe(false);
    expect(scheduleDayToSave({ startTime: "9h", endTime: "18:00", isWorkDay: true })).toMatchObject({ ok: false, error: expect.stringMatching(/Hora de entrada inválida/) });
    expect(scheduleDayToSave({ startTime: "09:00", endTime: "", isWorkDay: true })).toMatchObject({ ok: false, error: expect.stringMatching(/Hora de saída inválida/) });
    expect(scheduleDayToSave({ startTime: "08:00", endTime: "08:00", isWorkDay: true })).toMatchObject({ ok: false });
    expect(scheduleDayToSave({ startTime: "23:00", endTime: "07:00", isWorkDay: true })).toEqual({ ok: true, startTime: "23:00", endTime: "07:00", isWorkDay: 1 });
    expect(scheduleDayToSave({ startTime: "9h", endTime: "", isWorkDay: false })).toEqual({ ok: true, startTime: "00:00", endTime: "00:00", isWorkDay: 0 });
    expect(canonicalHhmm("8:30:00")).toBe("08:30");
    expect(canonicalHhmm("9h")).toBeNull();
  });
  it("upsert: recusa \"9h\" sem gravar; grava HH:MM e o antes → depois fica no registo (todas as linhas do dia)", async () => {
    await expect(caller().rh.schedules.upsert({ employeeId: 5, weekday: 3, startTime: "9h", endTime: "18:00", isWorkDay: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.upserts).toEqual([]);
    state.before = [{ id: 7, startTime: "09:00", endTime: "18:00", isWorkDay: 1 }, { id: 9, startTime: "10:00", endTime: "19:00", isWorkDay: 1 }];
    const r = await caller().rh.schedules.upsert({ employeeId: 5, weekday: 3, startTime: "08:00", endTime: "17:00", isWorkDay: true });
    expect(r).toEqual({ success: true, rows: 2 });
    expect(state.upserts).toEqual([{ employeeId: 5, weekday: 3, startTime: "08:00", endTime: "17:00", isWorkDay: 1 }]);
    expect(state.logs).toEqual([expect.objectContaining({ action: "update", entity: "schedule", entityId: 5, details: "Horário Qua: 09:00–18:00 / 10:00–19:00 → 08:00–17:00 (2 linhas desse dia acertadas)" })]);
  });
  it("gravar sem mudar nada não escreve no registo", async () => {
    state.before = [{ id: 7, startTime: "08:00", endTime: "17:00", isWorkDay: 1 }];
    await caller().rh.schedules.upsert({ employeeId: 5, weekday: 3, startTime: "08:00", endTime: "17:00", isWorkDay: true });
    expect(state.logs).toEqual([]);
  });
  it("delete → isWorkDay = 0 (folga); nada se apaga; fica no registo", async () => {
    state.before = [{ id: 7, startTime: "09:00", endTime: "18:00", isWorkDay: 1 }];
    const r = await caller().rh.schedules.delete({ employeeId: 5, weekday: 6 });
    expect(r).toEqual({ success: true, dayOff: true });
    expect(state.dayOffs).toEqual([{ employeeId: 5, weekday: 6 }]);
    expect(state.logs[0]).toMatchObject({ entity: "schedule", details: "Horário Sáb: 09:00–18:00 → folga" });
    const db = src("server/db.ts");
    expect(db).not.toMatch(/\.delete\(schedules\)/);
    const off = db.slice(db.indexOf("export async function setScheduleDayOff"), db.indexOf("export async function upsertSchedule"));
    expect(off).toContain(".set({ isWorkDay: 0 })");
  });
  it("o upsert da BD muda TODAS as linhas desse dia (sem LIMIT 1) e cria uma só se não houver nenhuma", () => {
    const db = src("server/db.ts");
    const up = db.slice(db.indexOf("export async function upsertSchedule"), db.indexOf("// ─── RH: TIME RECORDS"));
    expect(up).not.toContain(".limit(1)");
    expect(up).toMatch(/\.update\(schedules\)[\s\S]*\.where\(and\(eq\(schedules\.employeeId, data\.employeeId\), eq\(schedules\.weekday, data\.weekday\)\)\)/);
  });
  it("só quem gere a ficha grava o horário", async () => {
    state.manageDenied = true;
    await expect(caller("frontoffice").rh.schedules.upsert({ employeeId: 5, weekday: 3, startTime: "08:00", endTime: "17:00", isWorkDay: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("frontoffice").rh.schedules.delete({ employeeId: 5, weekday: 3 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.upserts).toEqual([]);
    expect(state.dayOffs).toEqual([]);
  });
  it("duplicados: duas linhas de quarta (ids 7 e 9) → a Avaliação e as faltas usam a 7, venha a ordem que vier", () => {
    const quarta = (id: number, startTime: string) => ({ id, employeeId: 2, weekday: 3, startTime, endTime: "18:00", isWorkDay: 1 });
    // 4 nov 2026 é quarta-feira (Lisboa = UTC)
    for (const list of [[quarta(9, "10:00"), quarta(7, "09:00")], [quarta(7, "09:00"), quarta(9, "10:00")]]) {
      expect(fixedScheduledStarts("2026-11-04", "2026-11-04", list).map((f) => f.startMs)).toEqual([Date.parse("2026-11-04T09:00:00Z")]);
    }
    // as consultas da Avaliação e das faltas trazem o id, por ordem
    expect(src("server/evaluationEngine.ts")).toMatch(/SELECT s\.id, s\.employeeId[\s\S]*ORDER BY s\.id`/);
    expect(src("server/rhService.ts")).toMatch(/SELECT s\.id, s\.employeeId[\s\S]*ORDER BY s\.id`/);
  });
  it("folha: um horário só com folgas conta como sem horário (as 176 h), como quando os dias apagados desapareciam", () => {
    const folga = (weekday: number) => ({ weekday, startTime: "09:00", endTime: "18:00", isWorkDay: 0 });
    expect(expectedHoursFromSchedule([0, 1, 2, 3, 4, 5, 6].map(folga), "2026-09-01", "2026-09-30")).toBeNull();
    expect(expectedHoursFromSchedule([], "2026-09-01", "2026-09-30")).toBeNull();
    // um dia posto em folga = um dia que não existe (setembro de 2026: 4 sábados)
    const semana = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "17:00", isWorkDay: 1 }));
    expect(expectedHoursFromSchedule([...semana, folga(6)], "2026-09-01", "2026-09-30")).toBe(expectedHoursFromSchedule(semana, "2026-09-01", "2026-09-30"));
    expect(expectedHoursFromSchedule(semana, "2026-09-01", "2026-09-30")).toBe(22 * 8);
  });
});

// ─── rh.noShowSkip ──────────────────────────────────────────────────────────
describe("rh.noShowSkip (fora das faltas automáticas até uma data)", () => {
  it("definição em Pessoas, lista vazia por omissão; uma linha por pessoa (fica a última)", () => {
    const def = (SETTINGS as any)["rh.noShowSkip"];
    expect(def).toMatchObject({ group: "pessoas", defaultValue: [], wiring: "live" });
    const parsed = noShowSkipSchema.parse([{ employeeId: 4, until: "2026-10-31", reason: "a" }, { employeeId: 4, until: "2026-11-30", reason: "b" }]);
    expect(parsed).toEqual([{ employeeId: 4, until: "2026-11-30", reason: "b" }]);
    expect(noShowSkipSchema.safeParse([{ employeeId: 4, until: "2026-1-5", reason: "x" }]).success).toBe(false);
    expect(noShowSkipSchema.safeParse([{ employeeId: 4, until: "2026-11-30", reason: "" }]).success).toBe(false);
  });
  it("o \"até\" conta; pôr de novo substitui e deixa cair as que já acabaram; tirar", () => {
    const list = [{ employeeId: 4, until: "2026-10-31", reason: "x" }];
    expect(noShowSkipFor(list, 4, "2026-10-31")).not.toBeNull();
    expect(noShowSkipFor(list, 4, "2026-11-01")).toBeNull();
    expect(noShowSkipFor(list, 5, "2026-10-30")).toBeNull();
    const next = withNoShowSkip([...list, { employeeId: 6, until: "2026-10-01", reason: "velho" }], { employeeId: 4, until: "2026-12-31", reason: "y" }, "2026-10-15");
    expect(next).toEqual([{ employeeId: 4, until: "2026-12-31", reason: "y" }]);
    expect(withoutNoShowSkip(next, 4)).toEqual([]);
  });
  it("pessoa na lista até 31 out → sem falta automática a 30 e 31 out; com falta a 2 nov (1 nov é feriado)", async () => {
    state.schedules = allWeek(4);
    state.skips = [{ employeeId: 4, until: "2026-10-31", reason: "Ainda pica na impressão digital" }];
    expect(await detectFixedScheduleNoShows("2026-10-30")).toMatchObject({ scanned: 1, created: 0, excluded: 1 });
    expect(await detectFixedScheduleNoShows("2026-10-31")).toMatchObject({ scanned: 1, created: 0, excluded: 1 });
    expect(await detectFixedScheduleNoShows("2026-11-01")).toMatchObject({ scanned: 0, created: 0 });
    expect(await detectFixedScheduleNoShows("2026-11-02")).toMatchObject({ scanned: 1, created: 1, excluded: 0 });
    expect(state.inserted).toEqual([expect.objectContaining({ employeeId: 4, points: 0, status: "pending", relatedId: 20261102 })]);
  });
  it("pôr e tirar: valida a data, grava com o updatedAt lido e fica no registo", async () => {
    const now = Date.parse("2026-10-15T10:00:00Z");
    await expect(changeNoShowSkip({ id: 3 }, { employeeId: 4, until: "2026-10-14", reason: "x" }, now)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(changeNoShowSkip({ id: 3 }, { employeeId: 4, until: "2027-12-31", reason: "x" }, now)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(changeNoShowSkip({ id: 3 }, { employeeId: 4, until: "2026-10-31", reason: " " }, now)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.saved).toEqual([]);
    state.skipUpdatedAt = "2026-10-10 08:00:00";
    await changeNoShowSkip({ id: 3 }, { employeeId: 4, until: "2026-10-31", reason: "Impressão digital" }, now);
    expect(state.saved[0]).toMatchObject({ key: "rh.noShowSkip", userId: 3, opts: { expectedUpdatedAt: "2026-10-10 08:00:00" }, value: [expect.objectContaining({ employeeId: 4, until: "2026-10-31", reason: "Impressão digital", byUserId: 3 })] });
    expect(state.logs[0]).toMatchObject({ entity: "no_show_skip", entityId: 4, details: expect.stringContaining("até 2026-10-31") });
    await changeNoShowSkip({ id: 3 }, { employeeId: 4, until: null }, now);
    expect(state.skips).toEqual([]);
    state.conflict = true;
    await expect(changeNoShowSkip({ id: 3 }, { employeeId: 5, until: "2026-10-31", reason: "x" }, now)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("só quem gere a ficha da pessoa a põe ou tira da lista", async () => {
    state.manageDenied = true;
    await expect(caller("frontoffice").rh.schedules.setNoShowSkip({ employeeId: 4, until: "2026-12-31", reason: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.saved).toEqual([]);
  });
});

// ─── Dispensa com motivo ────────────────────────────────────────────────────
describe("Possíveis faltas (horário fixo): dispensa com motivo", () => {
  const reviewer = { id: 9, role: "super_admin" };
  const pendingOn = async (day: string) => {
    state.schedules = allWeek(4);
    await detectFixedScheduleNoShows(day);
    return state.inserted[state.inserted.length - 1];
  };

  it("o dia: o das notas (dia de calendário da entrada); sem ele, o do relatedId", () => {
    expect(fixedNoShowDay({ notes: `${FIXED_NO_SHOW_NOTE_PREFIX} Possível falta em 2026-11-03 (horário 01:00–09:00)`, relatedId: 20261102 })).toBe("2026-11-03");
    expect(fixedNoShowDay({ notes: "", relatedId: 20261102 })).toBe("2026-11-02");
  });
  it("Férias → cria a ausência aprovada desse dia e dispensa; no dia seguinte, a mesma pessoa e o mesmo dia não voltam a dar falta", async () => {
    const p = await pendingOn("2026-11-02");
    const r = await dismissFixedNoShow(p.id, "vacation", reviewer);
    expect(r).toMatchObject({ day: "2026-11-02", leaveType: "vacation", points: 0, blocked: false });
    expect(r.leaveId).toBeGreaterThan(0);
    expect(state.leaves).toEqual([expect.objectContaining({ employeeId: 4, leaveType: "vacation", fromDate: "2026-11-02", toDate: "2026-11-02", createdById: 9, notes: expect.stringContaining(`#${p.id}`) })]);
    expect(state.inserted[0]).toMatchObject({ status: "dismissed", reviewedById: 9, notes: expect.stringContaining("Dispensada: Férias") });
    // correr outra vez para esse dia (ou no dia seguinte): a ausência tira-o
    expect(await detectFixedScheduleNoShows("2026-11-02")).toMatchObject({ scanned: 0, created: 0 });
    expect(state.inserted).toHaveLength(1);
  });
  it("Baixa → ausência sick; Justificada → ausência other; já havia ausência → não cria outra", async () => {
    const a = await pendingOn("2026-11-02");
    await dismissFixedNoShow(a.id, "sick", reviewer);
    const b = await pendingOn("2026-11-03");
    await dismissFixedNoShow(b.id, "justified", reviewer, "consulta médica");
    expect(state.leaves.map((l) => [l.leaveType, l.fromDate])).toEqual([["sick", "2026-11-02"], ["other", "2026-11-03"]]);
    expect(state.leaves[1].notes).toContain("consulta médica");
    const c = await pendingOn("2026-11-04");
    state.leaves.push({ employeeId: 4, leaveType: "vacation", fromDate: "2026-11-04", toDate: "2026-11-06" });
    const r = await dismissFixedNoShow(c.id, "vacation", reviewer);
    expect(r).toMatchObject({ leaveId: null, leaveAlready: true });
    expect(state.leaves).toHaveLength(3);
  });
  it("\"Picou noutro sistema / picagem perdida\" → só dispensa, marcada para a verificação do ponto (passo 0)", async () => {
    const p = await pendingOn("2026-11-02");
    const r = await dismissFixedNoShow(p.id, "lost_punch", reviewer);
    expect(r.leaveId).toBeNull();
    expect(state.leaves).toEqual([]);
    expect(state.inserted[0].status).toBe("dismissed");
    expect(state.inserted[0].notes).toContain(LOST_PUNCH_TAG);
  });
  it("só as do horário fixo ainda por validar; nunca apaga nada", async () => {
    const p = await pendingOn("2026-11-02");
    await dismissFixedNoShow(p.id, "lost_punch", reviewer);
    await expect(dismissFixedNoShow(p.id, "vacation", reviewer)).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/já foi revista/) });
    expect(fixedNoShowDismissPlan({ id: 1, employeeId: 4, reason: "no_show_extra_dia", status: "pending", notes: "x" }, "vacation", { notePrefix: FIXED_NO_SHOW_NOTE_PREFIX })).toMatchObject({ ok: false });
    expect(state.leaves).toEqual([]);
    const s = src("server/rhService.ts");
    const fn = s.slice(s.indexOf("export async function dismissFixedNoShow"), s.indexOf("// ─── Ponto: revisão de registos suspeitos"));
    expect(fn).not.toMatch(/\.delete\(/);
  });
  it("Férias/Baixa/Justificada pedem quem gere a ficha (como lançar a ausência); antes de criar nada", async () => {
    const p = await pendingOn("2026-11-02");
    state.manageDenied = true;
    await expect(caller("frontoffice").rh.penalties.dismissFixed({ id: p.id, reason: "vacation" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.leaves).toEqual([]);
    expect(state.inserted[0].status).toBe("pending");
  });
  it("quem não pode rever pontos (team leader) não dispensa", async () => {
    const p = await pendingOn("2026-11-02");
    await expect(dismissFixedNoShow(p.id, "lost_punch", { id: 3, role: "team_leader" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.inserted[0].status).toBe("pending");
  });
});

// ─── O que está em produção fica igual ──────────────────────────────────────
describe("regras já em produção (tarefa 62) ficam iguais", () => {
  it("0 pontos, pendente, uma por pessoa e dia; o interruptor continua desligado e só corre para ontem", async () => {
    state.schedules = allWeek(2);
    await detectFixedScheduleNoShows("2026-11-02");
    expect(state.inserted[0]).toMatchObject({ points: 0, status: "pending", reason: "other" });
    const c = src("server/cronJobs.ts");
    expect(c).toContain("const f = await detectFixedScheduleNoShows(yesterday);");
  });
  it("escala proposta (não confirmada) do Extras-Dia num funcionário com horário fixo: a falta do horário salta-o e o atraso lê a escala, como hoje", async () => {
    state.schedules = allWeek(2);
    state.escala = [2];
    expect(await detectFixedScheduleNoShows("2026-11-02")).toMatchObject({ scanned: 1, created: 0, skipped: { escala: 1, check_in: 0, multipark: 0 } });
    // nenhuma das duas leituras da escala filtra pelo estado (proposta ou confirmada)
    const rh = src("server/rhService.ts");
    const det = rh.slice(rh.indexOf("export async function detectFixedScheduleNoShows"), rh.indexOf("export async function listPendingPenalties"));
    expect(det).toMatch(/\.where\(and\(eq\(extrasDiaAssignments\.assignmentDate, dateStr\), isNotNull\(extrasDiaAssignments\.employeeId\)\)\)/);
    expect(src("server/evaluationEngine.ts")).toMatch(/FROM extras_dia_assignments\s+WHERE assignmentDate >= \$\{startDay\} AND assignmentDate <= \$\{endDay\}`/);
  });
  it("o interruptor descreve a lista \"Fora das faltas automáticas\" e o \"só ontem\"", async () => {
    const { AUTOMATION_FLAGS, automationFlagDefault } = await import("../shared/appSettings");
    const f = AUTOMATION_FLAGS.find((x) => x.name === "RH_FALTAS_HORARIO")!;
    expect(f.description).toContain("Fora das faltas automáticas");
    expect(f.description).toContain("só para ONTEM");
    expect(automationFlagDefault("RH_FALTAS_HORARIO")).toBe(false);
  });
});

// ─── Ecrãs ──────────────────────────────────────────────────────────────────
describe("ecrãs", () => {
  it("RH → Horários por rever: só para quem gere o RH, com as listas e as possíveis faltas do horário fixo", () => {
    const hr = src("client/src/pages/HRPage.tsx");
    expect(hr).toMatch(/\{canManageRh && \(\s+<DropdownMenuItem onClick=\{\(\) => setShowScheduleReview\(true\)\}>/);
    const page = src("client/src/pages/ScheduleReviewPage.tsx");
    expect(page).toContain("trpc.rh.schedules.review.useQuery");
    expect(page).toContain("<PendingNoShowsPanel onlyFixed");
    for (const t of ["Funcionários sem horário", "Dias duplicados", "Horas inválidas", "Sábado ou domingo no horário fixo", "Fora das faltas automáticas"]) expect(page).toContain(t);
  });
  it("ficha → Horário: \"Pôr folga\" em vez do caixote do lixo", () => {
    const hr = src("client/src/pages/HRPage.tsx");
    const tab = hr.slice(hr.indexOf("function SchedulesTab"), hr.indexOf("// ─── RESUMO DO MÊS"));
    expect(tab).toContain("Pôr folga");
    expect(tab).not.toContain("Trash2");
  });
  it("Possíveis faltas: Dispensar com motivo nas do horário fixo", () => {
    const d = src("client/src/pages/RhDashboardPage.tsx");
    expect(d).toContain("trpc.rh.penalties.dismissFixed.useMutation");
    for (const r of ["lost_punch", "vacation", "sick", "justified"]) expect(d).toContain(`reason: "${r}"`);
  });
});
