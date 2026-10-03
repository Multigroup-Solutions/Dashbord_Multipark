/**
 * P3 lote 22c — decisões do Jorge (3 out) na Avaliação:
 *  - D10 a avaliação semanal antiga já não se gera no cron
 *  - D11 abrir um dia só mostra o que está guardado (não recalcula nem grava)
 *  - D15 acidente = −6000, só depois de o TL confirmar quem conduzia
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  me: null as any,
  team: null as Set<number> | null,
  logs: [] as any[],
  inserted: [] as any[],
  dup: false,
  row: null as any,
  updated: [] as any[],
  affected: 1,
  recomputed: [] as string[][],
  waited: 0,
  // evaluateDay
  assignments: [] as any[],
  stored: [] as any[],
  live: { available: true, data: [] as any[] } as any,
}));

vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({
    insert: () => ({ values: async (v: any) => { if (state.dup) throw Object.assign(new Error("Duplicate entry 'X' for key 'uq_eval_accidents_active'"), { code: "ER_DUP_ENTRY" }); state.inserted.push(v); return [{ insertId: 7 }]; } }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (state.row ? [state.row] : []) }) }) }),
    update: () => ({ set: (v: any) => ({ where: async () => { state.updated.push(v); return [{ affectedRows: state.affected }]; } }) }),
  }),
  getEmployeeByUserId: async () => state.me,
  logActivity: async (x: any) => { state.logs.push(x); },
}));
vi.mock("./cityScope", async (original) => ({ ...(await original<object>()), assertEmployeeAccess: async () => {} }));
vi.mock("./evaluationRouter", () => ({ evaluationTeamIds: async () => state.team }));
vi.mock("@vercel/functions", () => ({ waitUntil: (p: Promise<unknown>) => { state.waited += 1; return p; } }));
vi.mock("./evaluationEngine", async (original) => ({
  ...(await original<object>()),
  recomputeRange: async (s: string, e: string) => { state.recomputed.push([s, e]); return {} as any; },
  loadEvaluatedDays: async () => state.stored,
  currentOperationalDay: () => "2026-10-03",
}));
vi.mock("./extrasDia", async (original) => ({ ...(await original<object>()), listAssignments: async () => state.assignments }));
vi.mock("./evaluationIdentity", async (original) => {
  const real = await original<typeof import("./evaluationIdentity")>();
  const identity = real.buildEvaluationIdentity({
    employees: [
      { id: 1, fullName: "Gelson Manuel Leão Sousa", userId: 10, multiparkAgentName: null, multiparkAgentUserId: "mp-1" },
      { id: 2, fullName: "Rita Santos", userId: 20, multiparkAgentName: null, multiparkAgentUserId: "mp-2" },
    ],
    agentAliases: [], accountAliases: [],
  });
  return { ...real, loadEvaluationIdentity: async () => ({ identity, employees: [] }) };
});
vi.mock("./multiparkDb/movements", async (original) => ({
  ...(await original<object>()),
  getAgentMovementSummaries: async () => state.live,
}));

import { accidentCandidates, accidentDayOf, confirmAccident, voidAccident } from "./evaluationAccidents";
import { evaluateDay } from "./multiparkEvaluation";
import { computeEmployeeDays } from "./evaluationCore";
import { buildEvaluationIdentity } from "./evaluationIdentity";
import { EVALUATION_POINTS, emptyDayMetrics, looksLikeAccident, scoreOf } from "../shared/evaluationRules";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { MIGRATION_0425_STATEMENTS } from "./migrations/migration_0425";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const occ = (o: Partial<any> = {}) => ({
  id: "occ-1", title: "Acidente", priority: "HIGH", resolved: false, createdAt: "2026-10-02T21:30:00.000Z", resolvedAt: null,
  createdByUserId: "mp-9", createdByName: "TL", resolvedById: null, resolvedByName: null, remarks: "bateu no pilar", lat: null, lng: null,
  attachment: null, attachmentUrl: null, bookingId: "bk-1", bookingCode: "A123", plate: "AA-00-BB", parkId: "p1", parkName: "Airpark", parkCity: "Lisboa", ...o,
});
const tl = { id: 30, role: "team_leader", name: "Tiago TL" };

beforeEach(() => {
  state.me = null; state.team = null; state.logs = []; state.inserted = []; state.dup = false; state.row = null;
  state.updated = []; state.affected = 1; state.recomputed = []; state.waited = 0;
  state.assignments = []; state.stored = []; state.live = { available: true, data: [] };
});

describe("D10 avaliação semanal antiga", () => {
  it("o cron diário já não a gera (as semanas gravadas ficam)", () => {
    const cron = src("server/cronJobs.ts");
    expect(cron).not.toContain('step("weekly-evaluation"');
    expect(cron).not.toContain("generateWeeklyEvaluation");
  });
});

describe("D11 abrir um dia só mostra o guardado", () => {
  const asg = (o: Partial<any> = {}) => ({ id: 1, employeeId: 1, personName: "Gelson Manuel Leão Sousa", multiparkAgentName: null, isTeamLeader: false, shift: "morning", level: "junior", hoursBilled: 8, cost: 36, ...o });
  const stored = (o: Partial<any> = {}) => {
    const m = { ...emptyDayMetrics(), actions: 4, recolhas: 2, entregas: 2, weightedActions: 12, hoursWorked: 8, cost: 40 };
    return { employeeId: 1, employeeName: "Gelson", position: "extra", day: "2026-10-02", shift: "morning", city: "Lisboa", isTeamLeader: false,
      hoursSource: "ponto", actionsByType: { CHECK_IN: 2, CHECK_OUT: 2 }, computedAt: "2026-10-03 04:10:00", base: m, metrics: m, score: scoreOf(m), perHour: {} as any, adjustments: [], ...o };
  };

  it("lê os pontos guardados, não recalcula nem grava, e diz quando foi calculado", async () => {
    state.assignments = [asg()];
    state.stored = [stored()];
    const r = await evaluateDay("2026-10-02");
    expect(state.recomputed).toEqual([]);
    expect(r).toMatchObject({ source: "guardado", computedAt: "2026-10-03 04:10:00", notComputed: false, notice: null });
    expect(r.shifts[0].members[0]).toMatchObject({ totalActions: 4, weightedActions: 12, cost: 40 });
  });

  it("dia ainda sem cálculo → avisa (não inventa zeros calculados)", async () => {
    state.assignments = [asg()];
    const r = await evaluateDay("2026-10-02");
    expect(r.notComputed).toBe(true);
    expect(state.recomputed).toEqual([]);
  });

  it("sem ficha: ações lidas ao vivo; resumo vivo em baixo → aviso, pontos guardados ficam", async () => {
    state.assignments = [asg({ id: 2, employeeId: null, personName: "Zé Ninguém", multiparkAgentName: "Zé N." })];
    state.live = { available: true, data: [{ agentUserId: "mp-77", agentName: "Zé N.", day: null, total: 3, byType: { MOVEMENT: 1, CHECK_IN: 2 }, recolhas: 2, entregas: 0, movements: 1, spotChanges: 0, bookings: 2, firstAt: null, lastAt: null, platforms: [], checkInsSigned: 0, checkOutsSigned: 0, occurrencesCreated: 0, occurrencesResolved: 0, reviews: 0, reviewAvg: null, reviewsLow: 0 }] };
    const r = await evaluateDay("2026-10-02");
    expect(r.shifts[0].members[0]).toMatchObject({ totalActions: 3, recolhas: 2, movements: 1, weightedActions: 2 * 3 + 1 * 2 });
    state.live = { available: false, reason: "Sem ligação à BD da Multipark neste momento." };
    state.assignments = [asg()];
    state.stored = [stored()];
    const r2 = await evaluateDay("2026-10-02");
    expect(r2.notice).toContain("os pontos são os guardados");
    expect(r2.shifts[0].members[0].totalActions).toBe(4);
  });

  it("o ecrã diz que abrir não recalcula e tem 'Recalcular este dia' para quem gere", () => {
    const tab = src("client/src/components/evaluation/DayEvaluationTab.tsx");
    expect(tab).toContain("Abrir o dia não recalcula");
    expect(tab).toContain("recompute.mutate({ from: date, to: date })");
    expect(tab).not.toContain("A calcular o dia");
  });
});

describe("D15 acidente = −6000 com confirmação do TL", () => {
  it("a regra vale −6000 e o motor conta o acidente confirmado no dia dele", () => {
    expect(EVALUATION_POINTS.accidentOrDamage).toBe(-6000);
    const identity = buildEvaluationIdentity({ employees: [], agentAliases: [], accountAliases: [] });
    const out = computeEmployeeDays({
      startDay: "2026-10-01", endDay: "2026-10-02", identity, employees: new Map(), actions: [], ponto: [], assignments: [], incidents: [],
      complaints: [], speedAlerts: [], penalties: [], rate: () => 0, tlWorkingDaysPerMonth: 22,
      confirmedAccidents: [{ employeeId: 5, day: "2026-10-02" }, { employeeId: 5, day: "2026-09-30" }],
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ employeeId: 5, day: "2026-10-02" });
    expect(out.rows[0].metrics).toMatchObject({ accidents: 1, incidentsAgainst: 1 });
    expect(scoreOf(out.rows[0].metrics).totalPoints).toBe(-6000);
  });

  it("o motor lê só as confirmações ativas (desfeitas não contam)", () => {
    const engine = src("server/evaluationEngine.ts");
    expect(engine).toMatch(/FROM evaluation_accidents\s+WHERE voidedAt IS NULL/);
  });

  it("quem conduzia: últimas ações na reserva, mais recente primeiro, uma vez cada", () => {
    const identity = buildEvaluationIdentity({
      employees: [{ id: 1, fullName: "Gelson Manuel Leão Sousa", userId: 10, multiparkAgentName: null, multiparkAgentUserId: "mp-1" }],
      agentAliases: [], accountAliases: [],
    });
    const c = accidentCandidates([
      { agentUserId: "mp-1", agentName: "Gelson Sousa", changeType: "CHECK_IN", actionTime: "2026-10-02 18:00:00" },
      { agentUserId: "mp-7", agentName: "Sem Ficha", changeType: "MOVEMENT", actionTime: "2026-10-02 20:00:00" },
      { agentUserId: "mp-1", agentName: "Gelson Sousa", changeType: "MOVEMENT", actionTime: "2026-10-02 21:00:00" },
    ], identity);
    expect(c.map((x) => [x.employeeId, x.changeType])).toEqual([[1, "MOVEMENT"], [null, "MOVEMENT"]]);
  });

  it("o dia é o operacional (03h–03h de Lisboa)", () => {
    expect(accidentDayOf({ createdAt: "2026-10-03T01:30:00.000Z" })).toBe("2026-10-02"); // 02:30 em Lisboa
    expect(accidentDayOf({ createdAt: "2026-10-03T03:30:00.000Z" })).toBe("2026-10-03");
    expect(accidentDayOf({ createdAt: null })).toBeNull();
  });

  it("parece acidente → destaca o pedido (não conta sozinho)", () => {
    expect(looksLikeAccident({ title: "Acidente", remarks: null })).toBe(true);
    expect(looksLikeAccident({ title: "Outro", remarks: "o carro bateu no pilar" })).toBe(true);
    expect(looksLikeAccident({ title: "Vidro aberto", remarks: "fechado" })).toBe(false);
  });

  it("TL confirma: grava a linha ativa, regista e recalcula esse dia depois de responder", async () => {
    const r = await confirmAccident(tl, occ() as any, { employeeId: 1, note: "  câmara do parque  " });
    expect(r).toEqual({ id: 7, day: "2026-10-02" });
    expect(state.inserted[0]).toMatchObject({ occurrenceId: "occ-1", activeKey: "occ-1", employeeId: 1, day: "2026-10-02", note: "câmara do parque", confirmedById: 30, confirmedByName: "Tiago TL" });
    expect(state.logs[0]).toMatchObject({ action: "create", entity: "evaluation_accident", entityId: 7 });
    await vi.waitFor(() => expect(state.recomputed).toEqual([["2026-10-02", "2026-10-02"]]));
  });

  it("ninguém confirma um acidente seu; o TL só a equipa; condutor não confirma", async () => {
    state.me = { employee: { id: 1 } };
    await expect(confirmAccident(tl, occ() as any, { employeeId: 1 })).rejects.toThrow("acidente teu");
    state.me = null;
    state.team = new Set([2]);
    await expect(confirmAccident(tl, occ() as any, { employeeId: 1 })).rejects.toThrow("da tua equipa");
    await expect(confirmAccident({ id: 40, role: "condutor" }, occ() as any, { employeeId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.inserted).toEqual([]);
  });

  it("já confirmado por outra pessoa → CONFLICT (uma confirmação ativa por ocorrência)", async () => {
    state.dup = true;
    await expect(confirmAccident(tl, occ() as any, { employeeId: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("desfazer não apaga: marca quem, quando e porquê e liberta a ocorrência", async () => {
    state.row = { id: 7, occurrenceId: "occ-1", employeeId: 1, day: "2026-10-02", voidedAt: null };
    const r = await voidAccident({ id: 31, role: "supervisor", name: "Sofia" }, { id: 7, reason: "não era ele" });
    expect(r).toEqual({ day: "2026-10-02" });
    expect(state.updated[0]).toMatchObject({ voidedById: 31, voidedByName: "Sofia", voidReason: "não era ele", activeKey: null });
    expect(state.updated[0].voidedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    state.affected = 0;
    await expect(voidAccident({ id: 31, role: "supervisor" }, { id: 7, reason: "outra vez" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(src("server/evaluationAccidents.ts")).not.toMatch(/\.delete\(/);
  });

  it("migração 0425 no arranque, só cria a tabela (nada se apaga)", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0425");
    expect(MIGRATION_0425_STATEMENTS.every((s) => s.startsWith("CREATE TABLE IF NOT EXISTS `evaluation_accidents`"))).toBe(true);
    expect(MIGRATION_0425_STATEMENTS.join(" ")).toContain("UNIQUE KEY `uq_eval_accidents_active` (`activeKey`)");
  });

  it("a ocorrência mostra o painel e a lista marca os confirmados", () => {
    const page = src("client/src/pages/IncidentsPage.tsx");
    expect(page).toContain("<AccidentConfirmPanel occurrenceId={occ.id} />");
    expect(page).toContain("Acidente confirmado");
    expect(src("server/routers.ts")).toContain("accidentIds: [...accidents]");
  });
});
