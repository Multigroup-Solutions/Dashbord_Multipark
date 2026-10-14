/**
 * Tarefa 62 (Fase 1, P2): atraso ao trabalho a partir de 5 min (−5, no máximo
 * 1 por dia) e o fim da "entrega atrasada" na Avaliação — em todos os sítios
 * que mostram atrasos (ecrã, CSV, Sheets, assistente) o número é o dos
 * atrasos ao trabalho (`lateArrivalsOf`), nunca o `delays` em bruto das linhas
 * antigas; ajustes e contestações da regra retirada recusados; a ordem dos
 * candidatos da escala automática muda só pelo fator "avaliação".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  adjustments: [] as any[],
  disputes: [] as any[],
  dispute: null as any,
  adjustment: null as any,
  closed: { ok: true, closedUntil: null } as { ok: true; closedUntil: string | null } | { ok: false },
  closers: [] as number[],
  saved: [] as any[],
  recomputed: [] as string[][],
  voided: [] as number[],
}));

const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({ execute: async () => [[]] }),
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  getEmployeeByUserId: async (userId: number) => (userId === 1 ? { employee: { id: 7, fullName: "Eu Próprio", projectId: 49 } } : null),
  getEmployeeById: async (id: number) => ({ employee: { id, projectId: 49, userId: null } }),
  logActivity: async () => undefined,
}));
vi.mock("./evaluationEngine", () => ({
  currentOperationalDay: () => "2026-10-14",
  loadEvaluatedDays: async () => [],
  listDisputes: async () => [],
  createDispute: async (x: any) => { state.disputes.push(x); return 1; },
  createAdjustment: async (x: any) => { state.adjustments.push(x); return 1; },
  getAdjustment: async () => state.adjustment,
  getDispute: async () => state.dispute,
  recomputeRange: async (s: string, e: string) => { state.recomputed.push([s, e]); return { written: 1, removed: 0, source: "multipark", notice: null, skipped: false }; },
  resolveDispute: async () => true, voidAdjustment: async (id: number) => { state.voided.push(id); },
}));
vi.mock("./notify", () => ({ notify: async () => undefined }));
vi.mock("./evaluationClose", async (original) => ({
  ...(await original<object>()),
  readEvaluationClosedUntil: async () => state.closed,
  readEvaluationClosers: async () => state.closers,
}));
vi.mock("./appSettings", async (original) => ({
  ...(await original<object>()),
  setSetting: async (key: string, value: unknown, userId: number) => { state.saved.push({ key, value, userId }); return { changed: true, value }; },
}));

import { appRouter } from "./routers";
import { computeEmployeeDays, type EngineInput } from "./evaluationCore";
import { buildEvaluationIdentity } from "./evaluationIdentity";
import { emptyDayMetrics, lateArrivalsOf, scoreOf, sumMetrics, type DayMetrics } from "../shared/evaluationRules";
import { EVAL_FLAGS, EVAL_RULE_FIELDS, RANKING_CSV_HEADERS, rankingCsv, sanitizeEvalSavedView, filterRanking } from "../shared/evaluationFilters";
import { explanationHash } from "./aiOps/evaluationExplain";
import { rankCandidates, type ScheduleCandidate } from "../shared/extrasSchedule";
import { SHEET_REPORTS } from "./google/sheetsExport";
import { STAFF_TOOLS } from "./assistant/tools";
import { PERF_METRICS, GROUP_VIEW } from "../shared/peoplePerformance";
import { fixedScheduledStarts, hoursOfHhmm } from "../shared/workSchedule";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");

const caller = (role: string, id = 1) => appRouter.createCaller({ user: { id, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const m = (over: Partial<DayMetrics>): DayMetrics => ({ ...emptyDayMetrics(), ...over });
/** Uma linha antiga (antes da tarefa 62): 3 atrasos, dos quais 2 eram entregas atrasadas → 1 atraso ao trabalho. */
const OLD = m({ delays: 3, lateServices: 2, entregas: 4 });

beforeEach(() => {
  state.adjustments = []; state.disputes = []; state.dispute = null; state.adjustment = null;
  state.closed = { ok: true, closedUntil: null }; state.closers = []; state.saved = []; state.recomputed = []; state.voided = [];
});

describe("atraso ao trabalho a partir de 5 min (motor, com o ponto e a escala)", () => {
  const identity = buildEvaluationIdentity({ employees: [{ id: 1, fullName: "Ana Silva", userId: 10, multiparkAgentName: null, multiparkAgentUserId: null }], agentAliases: [], accountAliases: [] });
  const input = (checkIn: string, assignments = [{ startHour: 3, endHour: 11 }]): EngineInput => ({
    startDay: "2026-11-02", endDay: "2026-11-02", identity,
    employees: new Map([[1, { id: 1, position: "extra", contractType: "extra", extraLevel: 1, monthlySalary: null, projectId: 1 }]]),
    actions: [], incidents: [], complaints: [], speedAlerts: [], penalties: [], rate: () => 10, tlWorkingDaysPerMonth: 15,
    ponto: [{ id: 1, employeeId: 1, type: "check_in", recordedAt: checkIn }],
    assignments: assignments.map((a) => ({ assignmentDate: "2026-11-02", employeeId: 1, personName: "Ana Silva", level: "1", isTeamLeader: false, shift: "morning" as const, city: "lisbon", startHour: a.startHour, endHour: a.endHour, sentHomeHour: null })),
  });
  // 2 nov 2026: Lisboa = UTC (hora de inverno) → 03:00 de Lisboa = 03:00 UTC
  const delaysAt = (checkIn: string, a?: Array<{ startHour: number; endHour: number }>) => computeEmployeeDays(input(checkIn, a)).rows[0].metrics.delays;
  it("03:04:59 → 0; 03:05:00 → 1 (−5); 03:10 → 1", () => {
    expect(delaysAt("2026-11-02 03:04:59")).toBe(0);
    expect(delaysAt("2026-11-02 03:05:00")).toBe(1);
    expect(delaysAt("2026-11-02 03:10:00")).toBe(1);
    const r = computeEmployeeDays(input("2026-11-02 03:05:00")).rows[0];
    expect(scoreOf(r.metrics).lines.find((l) => l.key === "delay")).toMatchObject({ count: 1, points: -5, subtotal: -5 });
  });
  it("duas linhas na escala no mesmo dia, as duas atrasadas → 1", () => {
    expect(delaysAt("2026-11-02 05:30:00", [{ startHour: 3, endHour: 8 }, { startHour: 5, endHour: 11 }])).toBe(1);
  });
  it("a soma do mês não tem entregas atrasadas (nem nas linhas antigas pesa a entrega)", () => {
    const month = sumMetrics([OLD, m({ delays: 1 }), m({ entregas: 2 })]);
    const s = scoreOf(month);
    expect(s.lines.map((l) => l.key)).not.toContain("lateDelivery");
    expect(s.lines.find((l) => l.key === "delay")).toMatchObject({ count: 2, subtotal: -10 });
    expect(lateArrivalsOf(month)).toBe(2);
  });
});

describe("atrasos à vista: linha antiga com delays 3 e lateServices 2 → 'Atrasos ao trabalho' = 1", () => {
  const row = { employeeId: 7, employeeName: "Ana", days: 1, metrics: OLD, score: scoreOf(OLD), perHour: { actionsPerHour: null, pointsPerHour: null }, openDisputes: 0, adjustments: 0, cities: [], brand: null, teamLeader: null, position: "extra", tlDays: 0 } as any;
  it("no CSV do ranking (sem a coluna das entregas atrasadas)", () => {
    expect(RANKING_CSV_HEADERS).toContain("Atrasos ao trabalho");
    expect(RANKING_CSV_HEADERS).not.toContain("Entregas atrasadas");
    const csv = rankingCsv([row], { rankOf: () => 1 }).split("\n");
    const head = csv[0].split(";"), line = csv[1].split(";");
    expect(line[head.indexOf("Atrasos ao trabalho")]).toBe("1");
  });
  it("nos filtros (regra e 'só com') e no ecrã", () => {
    expect(EVAL_FLAGS.map((f) => f.id)).not.toContain("lateServices");
    expect(EVAL_RULE_FIELDS.find((f) => f.id === "delays")!.get(row)).toBe(1);
    expect(EVAL_RULE_FIELDS.map((f) => f.id)).not.toContain("lateServices");
    expect(filterRanking([row], { groups: { flags: ["delays"] } } as any)).toHaveLength(1);
    expect(filterRanking([{ ...row, metrics: m({ delays: 2, lateServices: 2 }) }], { groups: { flags: ["delays"] } } as any)).toHaveLength(0);
  });
  it("um filtro guardado com 'Entregas atrasadas' perde só essa parte", () => {
    const { view, dropped } = sanitizeEvalSavedView({ groups: { flags: ["lateServices", "speeding"] }, rules: { match: "all", items: [{ field: "lateServices", op: "gte", value: 1 }, { field: "delays", op: "gte", value: 1 }] } });
    expect(dropped).toBe(2);
    expect(view.groups?.flags).toEqual(["speeding"]);
    expect(view.rules?.items.map((i) => i.field)).toEqual(["delays"]);
  });
  it("no Sheets", async () => {
    const call = vi.fn(async () => [row]);
    const tabs = await SHEET_REPORTS.avaliacoes.load(call, { from: "2026-09-01", to: "2026-09-30" }, Date.now() + 60_000);
    const [header, first] = tabs[0].rows as any[][];
    expect(first[header.indexOf("Atrasos ao trabalho")]).toBe(1);
    expect(header).toContain("Entregas atrasadas (regra antiga)");
  });
  it("no assistente (minha_avaliacao): só atrasosTrabalho", async () => {
    const tool = STAFF_TOOLS.find((t) => t.name === "minha_avaliacao")!;
    const ctx: any = { today: "2026-10-14", user: { id: 1, role: "extra" }, call: async () => ({ employee: { id: 7 }, totals: { days: 1, metrics: OLD, score: scoreOf(OLD), perHour: {} }, disputes: [] }) };
    const out: any = await tool.run({}, ctx);
    expect(out.metricas.atrasosTrabalho).toBe(1);
    expect(out.metricas).not.toHaveProperty("entregasAtrasadas");
    expect(out.metricas).not.toHaveProperty("atrasosEntrada");
  });
  it("no Desempenho: a coluna 'Entregas atrasadas' saiu das abas; os atrasos chamam-se 'Atrasos ao trabalho'", () => {
    expect(PERF_METRICS.delays.label).toBe("Atrasos ao trabalho");
    for (const g of Object.values(GROUP_VIEW)) expect(g.columns).not.toContain("lateDeliveries");
  });
});

describe("a regra retirada não se ajusta nem se contesta (o servidor recusa)", () => {
  it("ajuste de lateServices recusado", async () => {
    await expect(caller("supervisor", 2).evaluation.adjust({ employeeId: 8, day: "2026-10-10", metric: "lateServices", delta: -1, reason: "entrega a tempo" }))
      .rejects.toThrow(/regra saiu da avaliação/);
    expect(state.adjustments).toEqual([]);
  });
  it("contestação de lateServices recusada (a de outra métrica passa)", async () => {
    await expect(caller("extra", 1).evaluation.disputes.create({ day: "2026-10-10", metric: "lateServices", comment: "não me atrasei na entrega" }))
      .rejects.toThrow(/regra saiu da avaliação/);
    await expect(caller("extra", 1).evaluation.disputes.create({ day: "2026-10-10", metric: "delays", comment: "entrei a horas, o ponto falhou" }))
      .resolves.toEqual({ id: 1 });
    expect(state.disputes).toHaveLength(1);
  });
  it("aceitar uma contestação com ajuste de lateServices recusado", async () => {
    state.dispute = { id: 3, employeeId: 8, day: "2026-10-10", status: "open", metric: "lateServices", createdByUserId: 9 };
    await expect(caller("supervisor", 2).evaluation.disputes.resolve({ id: 3, accept: true, resolution: "aceite", adjustment: { metric: "lateServices", delta: -1 } }))
      .rejects.toThrow(/regra saiu da avaliação/);
    expect(state.adjustments).toEqual([]);
  });
});

describe("consequências que se veem", () => {
  it("a explicação da pontuação refaz-se (o hash das linhas muda sem a entrega atrasada)", () => {
    const now = scoreOf(OLD);
    const before = [...now.lines, { key: "lateDelivery" as any, label: "Entrega atrasada", points: -5, count: 2, subtotal: -10 }];
    expect(explanationHash(now.lines, now.totalPoints)).not.toBe(explanationHash(before, now.totalPoints - 10));
  });
  it("a escala automática: a ordem muda só pelo fator 'avaliação' (procura, custo e equidade iguais)", () => {
    const cand = (id: number, evalScore: number): ScheduleCandidate => ({ id, fullName: `Extra ${id}`, level: "junior" as any, levelLabel: "Júnior", hourlyRate: 4.5, windows: [{ from: 8, to: 14 }], evalScore, recentDays: 0, noShows: 0, declines: 0 });
    const remaining = Array.from({ length: 30 }, (_, h) => (h >= 8 && h < 11 ? 1 : 0));
    // A tinha 2 entregas atrasadas/dia (−10) com as regras antigas; sem elas sobe acima de B
    const before = rankCandidates([cand(1, 20 - 10), cand(2, 15)], remaining);
    const after = rankCandidates([cand(1, 20), cand(2, 15)], remaining);
    expect(before.map((r) => r.candidate.id)).toEqual([2, 1]);
    expect(after.map((r) => r.candidate.id)).toEqual([1, 2]);
    const f = (rs: typeof before, id: number) => rs.find((r) => r.candidate.id === id)!.factors;
    for (const id of [1, 2]) {
      const { eval: _a, total: _b, ...restBefore } = f(before, id);
      const { eval: _c, total: _d, ...restAfter } = f(after, id);
      expect(restAfter).toEqual(restBefore);
    }
  });
});

describe("P2d — fecho mensal no servidor", () => {
  it("quem fecha: o super admin e as contas da lista (Q10); os outros não", async () => {
    await expect(caller("super_admin", 3).evaluation.setClosedUntil({ closedUntil: "2026-09-30" })).resolves.toMatchObject({ closedUntil: "2026-09-30" });
    state.closers = [5];
    await expect(caller("admin", 5).evaluation.setClosedUntil({ closedUntil: "2026-09-30" })).resolves.toMatchObject({ closedUntil: "2026-09-30" });
    await expect(caller("admin", 6).evaluation.setClosedUntil({ closedUntil: "2026-09-30" })).rejects.toThrow(/Só o super admin e as pessoas autorizadas/);
    expect(state.saved).toEqual([
      { key: "evaluation.closedUntil", value: "2026-09-30", userId: 3 },
      { key: "evaluation.closedUntil", value: "2026-09-30", userId: 5 },
    ]);
    // reabrir = data nula (ou mais cedo); nunca hoje nem o futuro
    await expect(caller("super_admin", 3).evaluation.setClosedUntil({ closedUntil: null })).resolves.toMatchObject({ closedUntil: null });
    await expect(caller("super_admin", 3).evaluation.setClosedUntil({ closedUntil: "2026-10-14" })).rejects.toThrow(/até ontem/);
    expect(await caller("admin", 5).evaluation.closure()).toMatchObject({ closedUntil: null, canClose: true });
    expect(await caller("admin", 6).evaluation.closure()).toMatchObject({ canClose: false });
  });
  it("dia fechado: ajuste, anular ajuste, contestar e aceitar com ajuste recusados; aceitar sem ajuste e recusar continuam", async () => {
    state.closed = { ok: true, closedUntil: "2026-09-30" };
    await expect(caller("supervisor", 2).evaluation.adjust({ employeeId: 8, day: "2026-09-20", metric: "delays", delta: -1, reason: "ponto avariado" })).rejects.toThrow(/fechada até 30\/09\/2026/);
    await expect(caller("supervisor", 2).evaluation.adjust({ employeeId: 8, day: "2026-10-02", metric: "delays", delta: -1, reason: "ponto avariado" })).resolves.toEqual({ id: 1 });
    state.adjustment = { id: 4, employeeId: 8, day: "2026-09-20" };
    await expect(caller("supervisor", 2).evaluation.voidAdjustment({ id: 4 })).rejects.toThrow(/fecho mensal/);
    expect(state.voided).toEqual([]);
    await expect(caller("extra", 1).evaluation.disputes.create({ day: "2026-09-20", metric: "delays", comment: "entrei a horas, o ponto falhou" })).rejects.toThrow(/fecho mensal/);
    state.dispute = { id: 3, employeeId: 8, day: "2026-09-20", status: "open", metric: "delays", createdByUserId: 9 };
    await expect(caller("supervisor", 2).evaluation.disputes.resolve({ id: 3, accept: true, resolution: "aceite", adjustment: { metric: "delays", delta: -1 } })).rejects.toThrow(/fecho mensal/);
    await expect(caller("supervisor", 2).evaluation.disputes.resolve({ id: 3, accept: true, resolution: "aceite, sem mexer nos números" })).resolves.toMatchObject({ success: true });
    expect(state.adjustments.map((a) => a.day)).toEqual(["2026-10-02"]);
  });
  it("Recalcular: tudo fechado → recusa; a meio → só os dias abertos; nula → como hoje", async () => {
    state.closed = { ok: true, closedUntil: "2026-09-30" };
    await expect(caller("supervisor", 2).evaluation.recompute({ from: "2026-09-01", to: "2026-09-30" })).rejects.toThrow(/Nada foi recalculado/);
    const r = await caller("supervisor", 2).evaluation.recompute({ from: "2026-09-25", to: "2026-10-03" });
    expect(state.recomputed).toEqual([["2026-10-01", "2026-10-03"]]);
    expect(r.notice).toMatch(/fechados \(fecho mensal\)/);
    state.closed = { ok: true, closedUntil: null }; state.recomputed = [];
    await caller("supervisor", 2).evaluation.recompute({ from: "2026-09-25", to: "2026-10-03" });
    expect(state.recomputed).toEqual([["2026-09-25", "2026-10-01"], ["2026-10-02", "2026-10-03"]]);
  });
  it("o fecho não se leu: não se escreve", async () => {
    state.closed = { ok: false };
    await expect(caller("supervisor", 2).evaluation.adjust({ employeeId: 8, day: "2026-10-02", metric: "delays", delta: -1, reason: "ponto avariado" })).rejects.toThrow(/Não deu para ler o fecho/);
    await expect(caller("supervisor", 2).evaluation.recompute({ from: "2026-10-01", to: "2026-10-03" })).rejects.toThrow(/Não deu para ler o fecho/);
    expect(state.adjustments).toEqual([]);
  });
});

describe("Q8 — o atraso conta para todos os que têm horário (escala ou horário fixo do RH)", () => {
  // 2 nov 2026 (segunda-feira; Lisboa = UTC): horário fixo das 09:00
  const identity = buildEvaluationIdentity({ employees: [{ id: 1, fullName: "Ana Silva", userId: 10, multiparkAgentName: null, multiparkAgentUserId: null }, { id: 2, fullName: "Rui Escritório", userId: 11, multiparkAgentName: null, multiparkAgentUserId: null }], agentAliases: [], accountAliases: [] });
  const base = (o: Partial<EngineInput>): EngineInput => ({
    startDay: "2026-11-02", endDay: "2026-11-02", identity, employees: new Map(),
    actions: [], ponto: [], assignments: [], incidents: [], complaints: [], speedAlerts: [], penalties: [], rate: () => 10, tlWorkingDaysPerMonth: 15, ...o,
  });
  const segunda = (employeeId: number, startTime = "09:00") => ({ employeeId, weekday: 1, startTime, endTime: "18:00", isWorkDay: true });
  const ci = (employeeId: number, at: string) => ({ id: Math.random(), employeeId, type: "check_in" as const, recordedAt: at });
  const delays = (out: ReturnType<typeof computeEmployeeDays>, emp: number) => out.rows.find((r) => r.employeeId === emp)?.metrics.delays ?? 0;

  it("horas da semana pelo horário: 09:04:59 não; 09:05 já é (−5); sem entrada não é atraso", () => {
    expect(fixedScheduledStarts("2026-11-02", "2026-11-02", [segunda(2)]).map((f) => f.startMs)).toEqual([Date.parse("2026-11-02T09:00:00Z")]);
    expect(delays(computeEmployeeDays(base({ fixedSchedules: [segunda(2)], ponto: [ci(2, "2026-11-02 09:04:59")] })), 2)).toBe(0);
    const out = computeEmployeeDays(base({ fixedSchedules: [segunda(2)], ponto: [ci(2, "2026-11-02 09:05:00")] }));
    expect(delays(out, 2)).toBe(1);
    expect(scoreOf(out.rows[0].metrics).totalPoints).toBe(-5);
    expect(computeEmployeeDays(base({ fixedSchedules: [segunda(2)] })).rows).toHaveLength(0);
  });
  it("dia livre, férias/baixa e fora do contrato: sem hora de entrada", () => {
    expect(fixedScheduledStarts("2026-11-02", "2026-11-02", [{ ...segunda(2), isWorkDay: false }])).toEqual([]);
    expect(fixedScheduledStarts("2026-11-02", "2026-11-02", [segunda(2)], [{ employeeId: 2, fromDate: "2026-11-01", toDate: "2026-11-05" }])).toEqual([]);
    expect(fixedScheduledStarts("2026-11-02", "2026-11-02", [{ ...segunda(2), contractEnd: "2026-10-31" }])).toEqual([]);
    expect(fixedScheduledStarts("2026-11-02", "2026-11-02", [{ ...segunda(2), weekday: 2 }])).toEqual([]);
  });
  it("entrada às 01:00 de terça é ainda do dia operacional de segunda", () => {
    const f = fixedScheduledStarts("2026-11-02", "2026-11-02", [{ employeeId: 2, weekday: 2, startTime: "01:00", isWorkDay: 1 }]);
    expect(f).toMatchObject([{ calendarDay: "2026-11-03", day: "2026-11-02" }]);
    expect(hoursOfHhmm("08:30:00")).toBe(8.5);
    expect(hoursOfHhmm("25:00")).toBeNull();
  });
  it("nos dias com escala do Extras-Dia vale a escala; no máximo 1 por dia", () => {
    const esc = { assignmentDate: "2026-11-02", employeeId: 1, personName: "Ana Silva", level: "1", isTeamLeader: false, shift: "morning" as const, city: "lisbon", startHour: 10, endHour: 16, sentHomeHour: null };
    // horário fixo às 09:00, escala às 10:00, entrou às 09:30 → a tempo pela escala (não conta pelo horário)
    expect(delays(computeEmployeeDays(base({ fixedSchedules: [segunda(1)], assignments: [esc], ponto: [ci(1, "2026-11-02 09:30:00")] })), 1)).toBe(0);
    // entrou às 10:20: atrasado pela escala → 1 (e não 2)
    expect(delays(computeEmployeeDays(base({ fixedSchedules: [segunda(1)], assignments: [esc], ponto: [ci(1, "2026-11-02 10:20:00")] })), 1)).toBe(1);
  });
  it("o motor lê os horários das fichas ativas e as férias/baixas", () => {
    const eng = src("server/evaluationEngine.ts");
    expect(eng).toMatch(/FROM schedules s JOIN employees e ON e\.id = s\.employeeId\s+WHERE e\.isActive = 1 AND s\.isWorkDay = 1/);
    expect(eng).toContain("FROM employee_leaves");
  });
});
