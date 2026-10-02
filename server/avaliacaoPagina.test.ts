/**
 * P3 lote 15b — Avaliação + Disponibilidade: as permissões são as da matriz
 * (iguais no ecrã e no servidor, com as permissões por utilizador), o team
 * leader só vê a equipa, a avaliação semanal antiga deixa de se apagar, a
 * semana da disponibilidade é sempre à segunda (Lisboa), o link do email é o
 * da app e cada gravação fica registada.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  overrides: {} as Record<string, unknown>,
  days: [] as any[],
  logs: [] as any[],
  recompute: { written: 2, removed: 0, source: "multipark", notice: null, skipped: false } as any,
  saved: [] as any[],
  sent: [] as any[],
  team: [{ id: 8 }] as any[],
}));

const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({ execute: async () => [state.team] }),
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => state.overrides,
  getEmployeeByUserId: async (userId: number) => (userId === 1 ? { employee: { id: 7, fullName: "Eu Próprio", projectId: 49 } } : null),
  getEmployeeById: async (id: number) => ({ employee: { id, projectId: 49, userId: null } }),
  logActivity: async (x: any) => { state.logs.push(x); },
}));
vi.mock("./evaluationEngine", () => ({
  currentOperationalDay: () => "2026-09-24",
  loadEvaluatedDays: async () => state.days,
  listDisputes: async () => [],
  createDispute: async () => 1,
  createAdjustment: async () => 1,
  getAdjustment: async () => null, getDispute: async () => null,
  recomputeRange: async () => state.recompute,
  resolveDispute: async () => true, voidAdjustment: async () => undefined,
}));
vi.mock("./extrasAvailability", async (original) => ({
  ...(await original<object>()),
  setMyAvailability: async (...a: any[]) => { state.saved.push(a); return { saved: 2, previous: ["2026-10-05 manhã"] }; },
  sendWeeklyAvailabilityRequest: async (opts: any) => { state.sent.push(opts); return { total: 0, sent: 0, failed: 0, noEmail: 0, recipients: [] }; },
}));

import { appRouter } from "./routers";
import { isPersonalAccessPath } from "./cityAccess";
import { mondayOf, nextMonday, availabilityLine } from "./extrasAvailability";
import { availabilityWeekFrom, currentMondayLisbon, isMondayIso } from "../shared/availabilityWeek";
import { MERGED_FICHA_REASON } from "./evaluationIdentity";
import { emptyDayMetrics, scoreOf } from "../shared/evaluationRules";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const caller = (role: string, id = 1) => appRouter.createCaller({ user: { id, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const range = { from: "2026-09-01", to: "2026-09-07" };
const day = (employeeId: number, name: string) => {
  const metrics = { ...emptyDayMetrics(), actions: 3 };
  return { employeeId, employeeName: name, position: "extra", day: "2026-09-02", metrics, base: metrics, score: scoreOf(metrics), perHour: {}, adjustments: [] };
};

beforeEach(() => {
  state.overrides = {}; state.logs = []; state.saved = []; state.sent = [];
  state.days = [day(8, "Ana da Equipa"), day(9, "Bruno de Outra Equipa")];
  state.recompute = { written: 2, removed: 0, source: "multipark", notice: null, skipped: false };
  state.team = [{ id: 8 }];
});
afterEach(() => { vi.useRealTimers(); });

describe("Avaliação: a matriz de acessos, igual no ecrã e no servidor", () => {
  it("front e backoffice gerem a avaliação (antes o servidor recusava o que o ecrã mostrava)", async () => {
    for (const role of ["frontoffice", "backoffice", "supervisor", "admin"]) {
      await expect(caller(role).evaluation.recompute(range)).resolves.toMatchObject({ written: 2, skipped: false });
    }
  });
  it("team leader vê mas não recalcula, não ajusta nem decide contestações", async () => {
    await expect(caller("team_leader").evaluation.recompute(range)).rejects.toThrow(/Acesso/);
    await expect(caller("team_leader").evaluation.adjust({ employeeId: 8, day: "2026-09-02", metric: "delays", delta: -1, reason: "teste" })).rejects.toThrow(/Acesso/);
    await expect(caller("team_leader").evaluation.disputes.list()).rejects.toThrow(/Acesso/);
  });
  it("…a não ser que tenha essa permissão por utilizador", async () => {
    state.overrides = { avaliacao: { access: "city", actions: ["view", "edit"] } };
    await expect(caller("team_leader").evaluation.recompute(range)).resolves.toMatchObject({ written: 2 });
  });
  it("team leader: o ranking e o detalhe são só da equipa", async () => {
    const rows = await caller("team_leader").evaluation.ranking(range);
    expect(rows.map((r) => r.employeeId)).toEqual([8]);
    await expect(caller("team_leader").evaluation.employeeDays({ ...range, employeeId: 9 })).rejects.toThrow(/equipa/);
    await expect(caller("team_leader").evaluation.employeeDays({ ...range, employeeId: 8 })).resolves.toBeTruthy();
  });
  it("supervisor vê a cidade toda", async () => {
    const rows = await caller("supervisor").evaluation.ranking(range);
    expect(rows.map((r) => r.employeeId).sort()).toEqual([8, 9]);
  });
  it("extra e condutor só a própria", async () => {
    for (const role of ["extra", "condutor"]) await expect(caller(role).evaluation.ranking(range)).rejects.toThrow();
  });
  it("BD da Multipark em baixo: o recálculo diz que não gravou nada", async () => {
    state.recompute = { written: 0, removed: 0, source: "copia", notice: "Sem ligação. Nada foi gravado: ficam os valores anteriores.", skipped: true };
    const r = await caller("supervisor").evaluation.recompute(range);
    expect(r).toMatchObject({ skipped: true, days: 0, written: 0 });
    expect(state.logs.at(-1)?.details).toMatch(/NÃO recalculada/);
  });
});

describe("Avaliação semanal antiga", () => {
  it("já não se gera, edita nem apaga pela API (sem ecrã; apagar era definitivo)", () => {
    const procs = Object.keys((appRouter as any)._def.procedures);
    expect(procs).toContain("performance.list");
    for (const p of ["performance.generate", "performance.update", "performance.delete"]) expect(procs).not.toContain(p);
    expect(src("server/db.ts")).not.toMatch(/export async function deletePerformanceEvaluation/);
  });
  it("a lista respeita a cidade de quem pede", () => {
    expect(src("server/db.ts")).toMatch(/const conditions: any\[\] = \[employeeScope\(performanceEvaluations\.employeeId\)\]/);
  });
});

describe("Fichas juntas não partem a ligação pelo nome", () => {
  it("a ficha que sai de uma junção fica de fora da identidade", () => {
    expect(MERGED_FICHA_REASON).toBe("ficha_duplicada");
    expect(src("server/employeeMerge.ts")).toContain("deactivationReason = 'ficha_duplicada'");
    expect(src("server/evaluationIdentity.ts")).toMatch(/\.filter\(\(e\) => e\.deactivationReason !== MERGED_FICHA_REASON\)/);
  });
});

describe("Disponibilidade: a semana começa à segunda, em Lisboa", () => {
  it("segunda-feira válida", () => {
    expect(isMondayIso("2026-10-05")).toBe(true);
    expect(isMondayIso("2026-10-07")).toBe(false);
    expect(isMondayIso("2026-02-30")).toBe(false);
  });
  it("domingo 23:30 UTC já é segunda em Lisboa (o servidor corre em UTC)", () => {
    const ms = Date.UTC(2026, 9, 4, 23, 30); // 2026-10-05 00:30 Lisboa
    expect(currentMondayLisbon(ms)).toBe("2026-10-05");
    vi.useFakeTimers(); vi.setSystemTime(ms);
    expect(mondayOf()).toBe("2026-10-05");
    expect(nextMonday()).toBe("2026-10-12");
  });
  it("o link de uma quarta abre a semana dessa segunda; sem link, a próxima semana", () => {
    const ms = Date.UTC(2026, 9, 2, 10); // sexta 2 out
    expect(availabilityWeekFrom("?week=2026-10-07", ms)).toBe("2026-10-05");
    expect(availabilityWeekFrom("?week=lixo", ms)).toBe("2026-10-05");
    expect(availabilityWeekFrom("", ms)).toBe("2026-10-05");
  });
  it("o servidor recusa semanas que não começam à segunda e mais de 7 dias", async () => {
    await expect(caller("extra").extrasAvailability.setMyWeek({ weekStart: "2026-10-07", days: [] })).rejects.toThrow(/segunda-feira/);
    const days = Array.from({ length: 8 }, (_, i) => ({ day: `2026-10-${String(5 + i).padStart(2, "0")}`, morning: true }));
    await expect(caller("extra").extrasAvailability.setMyWeek({ weekStart: "2026-10-05", days })).rejects.toThrow();
    expect(state.saved).toHaveLength(0);
  });
  it("cada gravação fica registada com o que havia antes", async () => {
    await caller("extra").extrasAvailability.setMyWeek({ weekStart: "2026-10-05", days: [{ day: "2026-10-06", night: true }] });
    expect(state.saved[0].slice(0, 2)).toEqual([7, "2026-10-05"]);
    expect(state.logs.at(-1)).toMatchObject({ action: "availability_set", entity: "extras_availability", entityId: 7 });
    expect(state.logs.at(-1).details).toContain("antes: 2026-10-05 manhã");
  });
  it("a gravação substitui a semana numa transação (nunca fica a meio)", () => {
    const fn = src("server/extrasAvailability.ts").split("export async function setMyAvailability")[1].split("export async function setEmployeeAvailability")[0];
    expect(fn).toMatch(/db\.transaction\(async \(tx\) => \{[\s\S]*tx\.delete\(extrasAvailability\)[\s\S]*tx\.insert\(extrasAvailability\)/);
    expect(availabilityLine({ day: "2026-10-06", morning: 1, night: 0, fromHour: 9, toHour: 17, note: "só até às 17" })).toBe("2026-10-06 manhã+9–17h (só até às 17)");
  });
  it("o link do email é sempre o da app, nunca o que o browser manda", async () => {
    const before = process.env.APP_URL;
    process.env.APP_URL = "https://dashboard.multipark.pt";
    try {
      await caller("supervisor").extrasAvailability.sendRequest({ weekStart: "2026-10-05", origin: "https://evil.example" });
      expect(state.sent[0].origin).toBe("https://dashboard.multipark.pt");
    } finally {
      if (before === undefined) delete process.env.APP_URL; else process.env.APP_URL = before;
    }
  });
  it("escolhidos à mão: quem está na lista, mesmo sem função 'extra'", () => {
    const fn = src("server/extrasAvailability.ts").split("export async function sendWeeklyAvailabilityRequest")[1];
    expect(fn).toMatch(/opts\.employeeIds && opts\.employeeIds\.length\s*\?\s*await listActiveEmployeesByIds\(opts\.employeeIds\)/);
  });
  it("a própria disponibilidade e avaliação funcionam sem centro de custos", () => {
    for (const p of ["extrasAvailability.myWeek", "extrasAvailability.setMyWeek", "extrasAvailability.weekHints", "evaluation.mine", "evaluation.disputes.create"]) {
      expect(isPersonalAccessPath(p)).toBe(true);
    }
    expect(isPersonalAccessPath("evaluation.ranking")).toBe(false);
  });
});

describe("Ecrãs: erro ≠ vazio e as mesmas regras do servidor", () => {
  const aval = src("client/src/pages/AvaliacaoPage.tsx");
  const dia = src("client/src/components/evaluation/DayEvaluationTab.tsx");
  const pessoas = src("client/src/pages/PessoasDashboard.tsx");
  const disp = src("client/src/pages/DisponibilidadePage.tsx");
  it("Avaliação sem escada de papéis própria", () => {
    expect(aval).not.toContain("ROLE_LEVEL");
    expect(aval).toContain(`can(user as any, "avaliacao", "edit")`);
    expect(dia).toContain(`can(user as any, "avaliacao", "edit")`);
    expect(src("server/evaluationRouter.ts")).not.toContain("ROLE_HIERARCHY");
  });
  it("o lápis do agente só para quem gere o RH", () => {
    expect(dia).toContain(`can(user as any, "rh", "manage")`);
    expect(dia).toContain("assignment.employeeId && canMapAgent");
  });
  it("erros com 'Tentar de novo' em vez de 'sem dados'", () => {
    for (const what of ["o ranking", "os movimentos", "a tua avaliação", "as contestações"]) expect(aval).toContain(`what="${what}"`);
    for (const what of ["a avaliação do dia", "a escala do dia"]) expect(dia).toContain(`what="${what}"`);
    expect(disp).toContain(`what="a tua disponibilidade"`);
    expect(pessoas).toContain(`what="a avaliação"`);
  });
  it("Pessoas lê o mesmo motor da Avaliação (a semana antiga nunca estava gerada)", () => {
    expect(pessoas).toContain("trpc.evaluation.ranking.useQuery");
    expect(pessoas).not.toContain("trpc.performance.list");
  });
  it("A minha disponibilidade não depende de uma leitura do servidor para saber a semana", () => {
    expect(disp).toContain("availabilityWeekFrom(window.location.search, Date.now())");
    expect(disp).not.toContain("weekHints.useQuery");
  });
});
