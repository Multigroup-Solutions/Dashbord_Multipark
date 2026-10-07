import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  MANUAL_DAY_REASON,
  autoProposeBlockedReason,
  explainProposal,
  manualTouchLabel,
  marksManualDay,
  removedByHandOut,
  removedOutText,
} from "../shared/extrasSchedule";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { MIGRATION_0565_STATEMENTS } from "./migrations/migration_0565";

// A mão humana manda na escala (Jorge, 7 out 2026: "a Márcia tirou um dos
// condutores e o sistema foi e pôs outra vez"). O cron só faz a PRIMEIRA
// proposta de um dia intocado; depois de uma pessoa mexer, não muda mais nada;
// quem foi tirado à mão não volta a ser proposto para esse dia.

// ─── BD simulada (lê o SQL que o código manda) ──────────────────────────────

type Sched = { status: string; holdAuto: number; manualAt: number | null; manualById: number | null; manualWhat: string | null; proposedBy: string | null };
type Row = {
  id: number; assignmentDate: string; city: string; employeeId: number | null; personName: string; isTeamLeader: number;
  startHour: number; endHour: number; sentHomeHour: number | null; status: string; version: number; shift: string; source: string;
};
type Removed = { assignmentDate: string; city: string; employeeId: number | null; isTeamLeader: number; removedReason: string; removedById: number | null };

const fake = vi.hoisted(() => ({
  schedules: new Map<string, any>(),
  rows: [] as any[],
  removed: [] as any[],
  nextId: 100,
  sqls: [] as string[],
  upserts: [] as any[],
  candidates: [] as any[],
  needed: [] as number[],
  /** Corre enquanto o cron lê a previsão (uma pessoa mexe no dia a meio). */
  onForecast: null as null | (() => Promise<void>),
}));

const dialect = new MySqlDialect();
const key = (date: string, city: string) => `${date}|${city}`;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const select = (rows: any[]) => [rows, []];
const affected = (n: number) => [{ affectedRows: n }];

function whereRows(sqlText: string, params: unknown[]): Row[] {
  if (/WHERE id = \?$/.test(sqlText)) return fake.rows.filter((r) => r.id === params[params.length - 1]);
  const [date, city] = params.slice(-2) as string[];
  return fake.rows.filter((r) => r.assignmentDate === date && r.city === city && r.status === "proposed" && r.isTeamLeader === 0 && r.source === "auto");
}

async function exec(q: any): Promise<any> {
  const { sql: raw, params } = dialect.sqlToQuery(q);
  const s = norm(raw);
  fake.sqls.push(s);
  const p = params as any[];
  // Estado do dia (getScheduleState)
  if (/FROM extras_dia_schedules s LEFT JOIN users u/.test(s)) {
    const st: Sched | undefined = fake.schedules.get(key(p[0], p[1]));
    if (!st) return select([]);
    return select([{ status: st.status, holdAuto: st.holdAuto, proposedAt: null, proposedBy: st.proposedBy, confirmedAt: null, confirmedBy: null,
      gapsJson: null, summary: null, manualAtUnix: st.manualAt, manualById: st.manualById, manualWhat: st.manualWhat, manualByName: st.manualById ? "Márcia" : null }]);
  }
  // Sinais de mão humana sem marca (manualEvidence)
  if (/^SELECT \(SELECT COUNT\(\*\) FROM extras_dia_assignments WHERE/.test(s)) {
    const [d1, c1, d2, c2] = p;
    return select([{
      manualRows: fake.rows.filter((r) => r.assignmentDate === d1 && r.city === c1 && r.isTeamLeader === 0 && r.source === "manual").length,
      removedByHand: fake.removed.filter((r) => r.assignmentDate === d2 && r.city === c2 && r.isTeamLeader === 0 && r.removedReason === "removida").length,
    }]);
  }
  // Reserva do cron
  if (/^INSERT IGNORE INTO extras_dia_schedules \(assignmentDate, city, status, proposedBy, proposedAt\)/.test(s)) {
    if (fake.schedules.has(key(p[0], p[1]))) return affected(0);
    fake.schedules.set(key(p[0], p[1]), { status: "proposing", holdAuto: 0, manualAt: null, manualById: null, manualWhat: null, proposedBy: "auto" });
    return affected(1);
  }
  if (/^INSERT IGNORE INTO extras_dia_schedules \(assignmentDate, city, status\) VALUES/.test(s)) {
    if (fake.schedules.has(key(p[0], p[1]))) return affected(0);
    fake.schedules.set(key(p[0], p[1]), { status: "proposing", holdAuto: 0, manualAt: null, manualById: null, manualWhat: null, proposedBy: null });
    return affected(1);
  }
  if (/^SELECT status, \(manualAt IS NOT NULL\) AS manual FROM extras_dia_schedules/.test(s)) {
    const st = fake.schedules.get(key(p[0], p[1]));
    return select(st ? [{ status: st.status, manual: st.manualAt ? 1 : 0 }] : []);
  }
  // Marca "mexido à mão"
  if (/^INSERT INTO extras_dia_schedules \(assignmentDate, city, status, holdAuto, manualAt, manualById, manualWhat\)/.test(s)) {
    const k = key(p[0], p[1]);
    const st = fake.schedules.get(k) ?? { status: "hold", holdAuto: 0, manualAt: null, manualById: null, manualWhat: null, proposedBy: null };
    fake.schedules.set(k, { ...st, manualAt: 1_791_380_000, manualById: p[2], manualWhat: p[3] });
    return affected(1);
  }
  // Suspender
  if (/^INSERT INTO extras_dia_schedules \(assignmentDate, city, status, holdAuto\)/.test(s)) {
    const k = key(p[0], p[1]);
    const st = fake.schedules.get(k) ?? { status: "hold", holdAuto: 0, manualAt: null, manualById: null, manualWhat: null, proposedBy: null };
    fake.schedules.set(k, { ...st, holdAuto: p[2] });
    return affected(1);
  }
  // Fim da proposta
  if (/^UPDATE extras_dia_schedules SET status = 'proposed'/.test(s)) {
    const [date, city] = p.slice(-2);
    const st = fake.schedules.get(key(date, city));
    st.status = "proposed";
    st.proposedBy = p[0];
    if (/manualAt = NOW\(\)/.test(s)) { st.manualAt = 1_791_380_000; st.manualById = p[4]; st.manualWhat = p[5]; }
    return affected(1);
  }
  // Libertar a reserva
  if (/^DELETE FROM extras_dia_schedules/.test(s)) {
    const k = key(p[0], p[1]);
    const st = fake.schedules.get(k);
    if (st && st.status === "proposing" && !st.holdAuto && !st.manualAt) { fake.schedules.delete(k); return affected(1); }
    return affected(0);
  }
  if (/^UPDATE extras_dia_schedules SET status = 'hold'/.test(s)) {
    const st = fake.schedules.get(key(p[0], p[1]));
    if (st && st.status === "proposing") { st.status = "hold"; return affected(1); }
    return affected(0);
  }
  // Arquivo + saída da escala
  if (/^INSERT INTO extras_dia_assignments_removed/.test(s)) {
    const [reason, userId, ...rest] = p;
    const list = whereRows(s, rest);
    for (const r of list) fake.removed.push({ assignmentDate: r.assignmentDate, city: r.city, employeeId: r.employeeId, isTeamLeader: r.isTeamLeader, removedReason: reason, removedById: userId });
    return affected(list.length);
  }
  if (/^DELETE FROM extras_dia_assignments WHERE/.test(s)) {
    const list = new Set(whereRows(s, p));
    fake.rows = fake.rows.filter((r) => !list.has(r));
    return affected(list.size);
  }
  // Linhas propostas
  if (/^INSERT INTO extras_dia_assignments \(/.test(s)) {
    const [date, city, employeeId, personName, , shift, startHour, endHour] = p;
    fake.rows.push({ id: fake.nextId++, assignmentDate: date, city, employeeId, personName, isTeamLeader: 0, startHour, endHour, sentHomeHour: null, status: "proposed", version: 1, shift, source: "auto" });
    return affected(1);
  }
  if (/^SELECT id, assignmentDate, employeeId, personName, city, isTeamLeader, startHour, endHour, sentHomeHour, status, version, shift, source FROM extras_dia_assignments WHERE assignmentDate = \?/.test(s)) {
    return select(fake.rows.filter((r) => r.assignmentDate === p[0]));
  }
  if (/^SELECT id, assignmentDate, employeeId, personName, city, isTeamLeader, startHour, endHour, sentHomeHour, status, version, shift FROM extras_dia_assignments WHERE id = \?/.test(s)) {
    return select(fake.rows.filter((r) => r.id === p[0]));
  }
  if (/^SELECT DISTINCT employeeId FROM extras_dia_assignments_removed/.test(s)) {
    return select(Array.from(new Set(fake.removed
      .filter((r) => r.assignmentDate === p[0] && r.removedReason === "removida" && r.isTeamLeader === 0 && r.employeeId != null)
      .map((r) => r.employeeId))).map((employeeId) => ({ employeeId })));
  }
  return select([]); // histórico, avisos, etc.: vazio
}

vi.mock("./db", () => ({
  getDb: async () => ({
    execute: exec,
    transaction: async (fn: any) => fn({ execute: exec }),
    select: () => ({ from: () => ({ where: async () => fake.candidates.map((c: any) => ({ id: c.id, projectId: 1, address: null })) }) }),
  }),
  logActivity: vi.fn(async () => {}),
  getSystemUserId: async () => 1,
}));
vi.mock("./appSettings", () => ({ getSetting: async () => null }));
vi.mock("./_core/featureFlags", () => ({ isFeatureEnabled: () => true, ensureFeatureFlagOverrides: async () => {} }));
vi.mock("./notify", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("./google/pendingSync", () => ({ scheduleGoogleShiftSync: vi.fn(async () => {}) }));
vi.mock("./trainingPaths", () => ({ employeesMissingTraining: async () => new Set<number>() }));
vi.mock("./extraRates", () => ({ loadExtraRates: async () => ({}), rateFor: () => 5 }));
vi.mock("./employeeCity", () => ({
  resolveCitiesForEmployeeIds: async (ids: number[]) => new Map(ids.map((id) => [id, { city: "lisboa" }])),
  resolveEmployeeCities: async (people: Array<{ id: number }>) => new Map(people.map((p) => [p.id, { city: "lisboa" }])),
}));
vi.mock("./extrasDia", () => ({
  DRIVER_LEVELS: [{ id: "junior", label: "Júnior", hourlyRate: 4.5 }],
  getExtrasDiaForecast: async () => {
    const hook = fake.onForecast;
    fake.onForecast = null;
    if (hook) await hook();
    return {
    hourly: fake.needed.map((n: number) => ({ driversNeeded: n })),
    crewRuleText: "Lisboa: regra de teste",
    bookingsTruncated: false,
    bookingSource: "live",
    allocation: { cheapest: { shifts: [{ startHour: 8, endHour: 14 }, { startHour: 8, endHour: 14 }] } },
    };
  },
  listDriverCandidates: async () => fake.candidates,
  listAssignments: async (date: string, city?: string) =>
    fake.rows.filter((r: any) => r.assignmentDate === date && (!city || r.city === city)).map((r: any) => ({ ...r, isTeamLeader: r.isTeamLeader === 1 })),
  upsertAssignment: vi.fn(async (input: any) => {
    fake.upserts.push(input);
    fake.rows.push({ id: fake.nextId++, assignmentDate: input.assignmentDate, city: input.city, employeeId: input.employeeId, personName: input.personName, isTeamLeader: 0,
      startHour: input.startHour, endHour: input.endHour, sentHomeHour: null, status: "confirmed", version: 1, shift: input.shift, source: "manual" });
    return { id: fake.nextId - 1 };
  }),
}));

const DATE = "2099-10-08";
const person = (id: number, fullName: string) => ({
  id, fullName, position: "extra", suggestedLevel: "junior", availability: { status: "available", windows: [{ from: 8, to: 20 }] },
});
const picked = () => fake.rows.filter((r) => r.assignmentDate === DATE && r.city === "lisbon").map((r) => r.employeeId).sort();

beforeEach(() => {
  fake.schedules = new Map();
  fake.rows = [];
  fake.removed = [];
  fake.nextId = 100;
  fake.sqls = [];
  fake.upserts = [];
  fake.onForecast = null;
  fake.candidates = [person(11, "Ana"), person(12, "Rui"), person(13, "Zé")];
  // 2 condutores das 8h às 14h.
  fake.needed = Array.from({ length: 27 }, (_, h) => (h >= 8 && h < 14 ? 2 : 0));
});

// ─── Regras puras ───────────────────────────────────────────────────────────

describe("regra pura: o cron só faz a primeira proposta de um dia intocado", () => {
  it("dia sem estado e sem mão humana → pode propor", () => {
    expect(autoProposeBlockedReason({ state: null, manualRows: 0, removedByHand: 0 })).toBeNull();
  });
  it("mexido à mão (marca, condutor posto/alterado à mão ou tirado à mão) → nunca", () => {
    const manual = { atUnix: 1, byId: 7, byName: "Márcia", what: "tirou" };
    expect(autoProposeBlockedReason({ state: { status: "proposed", manual }, manualRows: 0, removedByHand: 0 })).toBe(MANUAL_DAY_REASON);
    expect(autoProposeBlockedReason({ state: null, manualRows: 1, removedByHand: 0 })).toBe(MANUAL_DAY_REASON);
    expect(autoProposeBlockedReason({ state: null, manualRows: 0, removedByHand: 2 })).toBe(MANUAL_DAY_REASON);
  });
  it("com estado (proposta, escala, suspensão) → não refaz", () => {
    expect(autoProposeBlockedReason({ state: { status: "proposed" }, manualRows: 0, removedByHand: 0 })).toBe("já tem proposta ou escala");
    expect(autoProposeBlockedReason({ state: { status: "confirmed" }, manualRows: 0, removedByHand: 0 })).toBe("já tem proposta ou escala");
    expect(autoProposeBlockedReason({ state: { status: "hold" }, manualRows: 0, removedByHand: 0 })).toBe("suspenso à mão");
  });
  it("o TL não marca o dia (a proposta nunca mexe nele); os condutores sim", () => {
    expect(marksManualDay({ isTeamLeader: 1 })).toBe(false);
    expect(marksManualDay({ isTeamLeader: true })).toBe(false);
    expect(marksManualDay({ isTeamLeader: 0 })).toBe(true);
    expect(marksManualDay({})).toBe(true);
  });
});

describe("regra pura: quem foi tirado à mão fica de fora", () => {
  it("fora = tirados à mão que não estão no dia (posto outra vez à mão → está lá)", () => {
    expect(removedByHandOut([11, 12, 11], new Set([12]))).toEqual([11]);
    expect(removedByHandOut([], new Set([1]))).toEqual([]);
  });
  it("texto do resumo", () => {
    expect(removedOutText(0)).toBeNull();
    expect(removedOutText(1)).toBe("1 tirado à mão fica de fora");
    expect(removedOutText(2)).toBe("2 tirados à mão ficam de fora");
    const txt = explainProposal({ date: DATE, city: "lisbon", capacityText: "x", peakDrivers: 2, peakHour: 8, picks: [], keptCount: 1, gaps: [], removedOutCount: 2 });
    expect(txt).toContain("2 tirados à mão ficam de fora.");
    expect(explainProposal({ date: DATE, city: "lisbon", capacityText: "x", peakDrivers: 2, peakHour: 8, picks: [], keptCount: 1, gaps: [] })).not.toContain("tirad");
  });
  it("selo: quem e a hora de Lisboa (noutro dia leva a data)", () => {
    const at = Date.UTC(2026, 9, 7, 14, 42) / 1000; // 15:42 em Lisboa (verão)
    expect(manualTouchLabel({ atUnix: at, byId: 7, byName: "Márcia", what: "tirou" }, new Date(Date.UTC(2026, 9, 7, 18, 0))))
      .toBe("Mexido à mão por Márcia às 15:42 — a proposta automática já não muda este dia");
    expect(manualTouchLabel({ atUnix: at, byId: null, byName: null, what: null }, new Date(Date.UTC(2026, 9, 9, 10, 0))))
      .toBe("Mexido à mão a 07/10 às 15:42 — a proposta automática já não muda este dia");
  });
});

// ─── Proposta, cron e preenchimento (BD simulada) ───────────────────────────

describe("o cron num dia intocado faz a primeira proposta como antes", () => {
  it("propõe, linhas 'auto' por confirmar, estado 'proposed' sem marca de mão", async () => {
    const { proposeSchedule } = await import("./extrasSchedule");
    const r = await proposeSchedule({ date: DATE, city: "lisbon", by: "auto", userId: null });
    expect(r.status).toBe("proposed");
    expect(r.proposed).toBe(2);
    expect(r.removedOut).toBe(0);
    expect(fake.rows.every((x) => x.source === "auto" && x.status === "proposed")).toBe(true);
    const st = fake.schedules.get(key(DATE, "lisbon"));
    expect(st.status).toBe("proposed");
    expect(st.proposedBy).toBe("auto");
    expect(st.manualAt).toBeNull();
  });
  it("a reserva é um INSERT IGNORE (com o FOUND_ROWS do mysql2 o ON DUPLICATE KEY UPDATE dava sempre 1 e o cron refazia tudo)", async () => {
    const { proposeSchedule } = await import("./extrasSchedule");
    await proposeSchedule({ date: DATE, city: "lisbon", by: "auto", userId: null });
    const claim = fake.sqls.find((s) => /proposedBy, proposedAt\)/.test(s))!;
    expect(claim).toMatch(/^INSERT IGNORE INTO extras_dia_schedules/);
    expect(claim).not.toMatch(/ON DUPLICATE KEY/);
  });
  it("na corrida seguinte não refaz a proposta (nem a substitui)", async () => {
    const { proposeSchedule } = await import("./extrasSchedule");
    await proposeSchedule({ date: DATE, city: "lisbon", by: "auto", userId: null });
    const ids = fake.rows.map((x) => x.id);
    const r = await proposeSchedule({ date: DATE, city: "lisbon", by: "auto", userId: null });
    expect(r).toMatchObject({ status: "skipped", reason: "já tem proposta ou escala" });
    expect(fake.rows.map((x) => x.id)).toEqual(ids);
  });
});

describe("a Márcia tira um condutor → o sistema já não o volta a pôr", () => {
  it("tirar marca o dia; o cron já não propõe nesse dia e quem saiu não volta", async () => {
    const { proposeSchedule, removeAssignment, getScheduleState } = await import("./extrasSchedule");
    await proposeSchedule({ date: DATE, city: "lisbon", by: "auto", userId: null });
    const [first] = fake.rows;
    await removeAssignment(first.id, 7);
    const st = await getScheduleState(DATE, "lisbon");
    expect(st?.manual).toMatchObject({ byId: 7, byName: "Márcia", what: "tirou" });
    expect(fake.removed).toEqual([expect.objectContaining({ employeeId: first.employeeId, removedReason: "removida" })]);

    const r = await proposeSchedule({ date: DATE, city: "lisbon", by: "auto", userId: null });
    expect(r).toMatchObject({ status: "skipped", reason: MANUAL_DAY_REASON });
    expect(picked()).not.toContain(first.employeeId);
    expect(fake.rows.length).toBe(1);
  });
  it("dia sem proposta com condutores postos à mão (sem marca, de antes) → o cron não propõe", async () => {
    const { proposeSchedule } = await import("./extrasSchedule");
    fake.rows.push({ id: 1, assignmentDate: DATE, city: "lisbon", employeeId: 11, personName: "Ana", isTeamLeader: 0, startHour: 8, endHour: 14, sentHomeHour: null, status: "confirmed", version: 1, shift: "morning", source: "manual" });
    const r = await proposeSchedule({ date: DATE, city: "lisbon", by: "auto", userId: null });
    expect(r).toMatchObject({ status: "skipped", reason: MANUAL_DAY_REASON });
    expect(fake.schedules.has(key(DATE, "lisbon"))).toBe(false);
  });
  it("dia sem proposta com alguém tirado à mão (sem marca, de antes) → o cron não propõe", async () => {
    const { proposeSchedule } = await import("./extrasSchedule");
    fake.removed.push({ assignmentDate: DATE, city: "lisbon", employeeId: 12, isTeamLeader: 0, removedReason: "removida", removedById: 7 });
    const r = await proposeSchedule({ date: DATE, city: "lisbon", by: "auto", userId: null });
    expect(r).toMatchObject({ status: "skipped", reason: MANUAL_DAY_REASON });
  });
  it("só o TL posto à mão não trava a proposta dos condutores (e o TL fica)", async () => {
    const { proposeSchedule } = await import("./extrasSchedule");
    fake.rows.push({ id: 1, assignmentDate: DATE, city: "lisbon", employeeId: 99, personName: "TL", isTeamLeader: 1, startHour: 7, endHour: 15, sentHomeHour: null, status: "confirmed", version: 1, shift: "morning", source: "manual" });
    const r = await proposeSchedule({ date: DATE, city: "lisbon", by: "auto", userId: null });
    expect(r.status).toBe("proposed");
    expect(fake.rows.some((x) => x.employeeId === 99)).toBe(true);
  });
  it("suspender marca o dia: o cron já não propõe (antes propunha um dia suspenso)", async () => {
    const { proposeSchedule, setScheduleHold } = await import("./extrasSchedule");
    await setScheduleHold(DATE, "lisbon", true, 7);
    expect(fake.schedules.get(key(DATE, "lisbon"))).toMatchObject({ status: "hold", holdAuto: 1, manualWhat: "suspendeu" });
    const r = await proposeSchedule({ date: DATE, city: "lisbon", by: "auto", userId: null });
    expect(r).toMatchObject({ status: "skipped", reason: MANUAL_DAY_REASON });
    expect(fake.rows.length).toBe(0);
  });
  it("tirar o TL não marca o dia", async () => {
    const { removeAssignment } = await import("./extrasSchedule");
    fake.rows.push({ id: 1, assignmentDate: DATE, city: "lisbon", employeeId: 99, personName: "TL", isTeamLeader: 1, startHour: 7, endHour: 15, sentHomeHour: null, status: "confirmed", version: 1, shift: "morning", source: "manual" });
    await removeAssignment(1, 7);
    expect(fake.schedules.has(key(DATE, "lisbon"))).toBe(false);
  });
  it("uma pessoa mexe enquanto o cron lê a previsão → o cron desiste e não apaga a marca", async () => {
    const mod = await import("./extrasSchedule");
    fake.onForecast = () => mod.markScheduleManual(DATE, "lisbon", 7, "pôs");
    const r = await mod.proposeSchedule({ date: DATE, city: "lisbon", by: "auto", userId: null });
    expect(r).toMatchObject({ status: "skipped", reason: MANUAL_DAY_REASON });
    expect(fake.rows.length).toBe(0);
    expect(fake.schedules.get(key(DATE, "lisbon"))).toMatchObject({ status: "hold", manualWhat: "pôs" });
  });
});

describe("proposta à mão e Preencher com disponíveis não voltam a pôr quem foi tirado", () => {
  it("Proposta automática (à mão) deixa de fora quem foi tirado e diz quantos", async () => {
    const { proposeSchedule, removeAssignment } = await import("./extrasSchedule");
    await proposeSchedule({ date: DATE, city: "lisbon", by: "auto", userId: null });
    const out = fake.rows.map((x) => x.employeeId as number);
    for (const x of [...fake.rows]) await removeAssignment(x.id, 7);
    const r = await proposeSchedule({ date: DATE, city: "lisbon", by: "manual", userId: 7 });
    expect(r.status).toBe("proposed");
    expect(r.removedOut).toBe(2);
    expect(r.summary).toContain("2 tirados à mão ficam de fora");
    for (const id of out) expect(picked()).not.toContain(id);
    // Só sobra quem não foi tirado (proposto sozinho, mesmo faltando gente).
    expect(picked()).toEqual([11, 12, 13].filter((id) => !out.includes(id)));
    expect(fake.schedules.get(key(DATE, "lisbon"))).toMatchObject({ status: "proposed", manualWhat: "refez a proposta", manualById: 7 });
  });
  it("posto outra vez à mão → fica (e não conta como 'de fora')", async () => {
    const { proposeSchedule } = await import("./extrasSchedule");
    fake.removed.push({ assignmentDate: DATE, city: "lisbon", employeeId: 11, isTeamLeader: 0, removedReason: "removida", removedById: 7 });
    fake.rows.push({ id: 1, assignmentDate: DATE, city: "lisbon", employeeId: 11, personName: "Ana", isTeamLeader: 0, startHour: 8, endHour: 14, sentHomeHour: null, status: "confirmed", version: 1, shift: "morning", source: "manual" });
    const r = await proposeSchedule({ date: DATE, city: "lisbon", by: "manual", userId: 7 });
    expect(r.removedOut).toBe(0);
    expect(fake.rows.filter((x) => x.employeeId === 11).length).toBe(1);
  });
  it("Preencher com disponíveis deixa de fora quem foi tirado e marca o dia como 'preencheu'", async () => {
    const { autofillShift } = await import("./extrasAutomation");
    fake.removed.push({ assignmentDate: DATE, city: "lisbon", employeeId: 11, isTeamLeader: 0, removedReason: "removida", removedById: 7 });
    const r = await autofillShift({ date: DATE, city: "lisbon", shift: "morning", createdById: 7 });
    expect(r.removedOut).toBe(1);
    expect(r.created.map((c) => c.employeeId)).not.toContain(11);
    expect(r.created.length).toBe(2);
    expect(fake.upserts.every((u) => u.manualWhat === "preencheu" && u.createdById === 7)).toBe(true);
  });
});

describe("cron (runScheduleAutomation)", () => {
  it("não propõe o dia mexido à mão; propõe os intocados", async () => {
    const { runScheduleAutomation, markScheduleManual } = await import("./extrasSchedule");
    const now = new Date(Date.UTC(2099, 9, 7, 14, 0)); // 15:00 em Lisboa, depois das 14h
    const tomorrow = "2099-10-08";
    await markScheduleManual(tomorrow, "lisbon", 7, "tirou");
    const report = await runScheduleAutomation(now);
    expect(report.skipped).toContain(`propose:${tomorrow}:lisbon (${MANUAL_DAY_REASON})`);
    expect(report.ran).toContain(`propose:${tomorrow}:porto`);
    expect(fake.rows.filter((r) => r.city === "lisbon").length).toBe(0);
  });
});

describe("todas as mudanças à mão marcam o dia", () => {
  const src = (f: string) => readFileSync(resolve(__dirname, "..", f), "utf8");
  it("pôr, alterar e mandar para casa (upsertAssignment), preencher, tirar, confirmar, suspender e refazer", () => {
    const dia = src("server/extrasDia.ts").split("export async function upsertAssignment")[1];
    expect(dia.match(/await markManualChange\(/g)?.length).toBe(2); // edição e linha nova
    expect(dia).toContain(`"mandou para casa" : "alterou"`);
    expect(dia).toContain(`input.manualWhat ?? "pôs"`);
    expect(src("server/extrasAutomation.ts")).toContain(`manualWhat: "preencheu"`);
    const sched = src("server/extrasSchedule.ts");
    expect(sched).toContain(`if (marksManualDay(row)) await markScheduleManual(row.assignmentDate.slice(0, 10), row.city, userId, "tirou")`);
    expect(sched).toContain(`await markScheduleManual(date, city, input.userId, "confirmou")`);
    expect(sched).toContain(`hold ? "suspendeu" : "retomou"`);
    expect(sched).toContain(`manualWhat = \${"refez a proposta" satisfies ManualWhat}`);
  });
});

describe("migração 0565", () => {
  it("só acrescenta colunas (sem UPDATE nem DELETE) e está registada", () => {
    expect(MIGRATION_0565_STATEMENTS.every((s) => /^ALTER TABLE `extras_dia_schedules` ADD COLUMN/.test(s))).toBe(true);
    expect(SCHEMA_MIGRATION_IDS).toContain("0565");
  });
});
