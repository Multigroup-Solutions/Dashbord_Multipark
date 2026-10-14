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
  getAdjustment: async () => null,
  getDispute: async () => state.dispute,
  recomputeRange: async () => ({ written: 0, removed: 0, source: "multipark", notice: null, skipped: false }),
  resolveDispute: async () => true, voidAdjustment: async () => undefined,
}));
vi.mock("./notify", () => ({ notify: async () => undefined }));

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

const caller = (role: string, id = 1) => appRouter.createCaller({ user: { id, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const m = (over: Partial<DayMetrics>): DayMetrics => ({ ...emptyDayMetrics(), ...over });
/** Uma linha antiga (antes da tarefa 62): 3 atrasos, dos quais 2 eram entregas atrasadas → 1 atraso ao trabalho. */
const OLD = m({ delays: 3, lateServices: 2, entregas: 4 });

beforeEach(() => { state.adjustments = []; state.disputes = []; state.dispute = null; });

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
