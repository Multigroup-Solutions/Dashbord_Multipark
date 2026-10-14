/**
 * Avaliação → Mês: pesquisa e filtros "como no Odoo" (Jorge, 14 out 2026) e o
 * "O meu perfil" no menu da fotografia (computador).
 *  - regras PURAS do filtro (pesquisa por facetas, grupos E/OU, regras sobre as
 *    métricas, totais, agrupar, filtros guardados);
 *  - o ranking traz as facetas (cidades, marca, agentes, equipa) sem partir;
 *  - filtros guardados na mesma tabela do CRM, separados por página;
 *  - CSV e Sheets levam o filtrado e dizem-no;
 *  - o menu do computador tem "O meu perfil" e o /perfil abre a todos.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";

const compile = (s: SQL) => new MySqlDialect().sqlToQuery(s);
const state = vi.hoisted(() => ({
  days: [] as any[],
  handler: (_sql: string): any[] => [],
  logs: [] as any[],
}));

const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({ execute: async (q: SQL) => [state.handler(compile(q).sql)] }),
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  getEmployeeByUserId: async () => null,
  logActivity: async (x: any) => { state.logs.push(x); },
}));
vi.mock("./evaluationEngine", () => ({
  currentOperationalDay: () => "2026-10-14",
  loadEvaluatedDays: async () => state.days,
  listDisputes: async () => [],
  createDispute: async () => 1, createAdjustment: async () => 1,
  getAdjustment: async () => null, getDispute: async () => null,
  recomputeRange: async () => ({ written: 0, removed: 0, source: "multipark", notice: null, skipped: false }),
  resolveDispute: async () => true, voidAdjustment: async () => undefined,
}));

import { appRouter } from "./routers";
import {
  describeFilter, facetCounts, filterParts, filterRanking, groupOptions, groupRanking, isFilterActive, matchesSearches, personMatches,
  rankingCsv, rankingTotals, ruleHolds, sanitizeEvalSavedView, evalSavedViewSchema, EVAL_FILTER_LIMITS, type EvalRankingRowLike,
} from "../shared/evaluationFilters";
import { mainTeamLeaders } from "../shared/evaluationTeam";
import { ancestorOfLevel, buildEmployeeFacets, citiesOfDays } from "./evaluationRankingFacets";
import { listSavedFiltersFor, saveFilterFor, deleteFilterFor } from "./savedFilters";
import { saveFilter as crmSaveFilter } from "./crm/edit";
import { SHEET_REPORTS } from "./google/sheetsExport";
import { exportSpreadsheetName, sheetExportInputSchema } from "../shared/drive";
import { decideRoute, isPersonalRoute } from "../shared/routeAccess";
import { emptyDayMetrics, perHourMetrics, scoreOf } from "../shared/evaluationRules";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** Linha do ranking para os testes (as métricas que importam). */
function row(id: number, name: string, o: Partial<EvalRankingRowLike> & { m?: Record<string, number>; pts?: number } = {}): EvalRankingRowLike {
  return {
    employeeId: id, employeeName: name, position: o.position ?? "driver", days: o.days ?? 10,
    metrics: { hoursWorked: 80, actions: 100, recolhas: 20, entregas: 20, cost: 500, ...(o.m ?? {}) },
    score: { totalPoints: o.pts ?? 0, positivePoints: Math.max(0, o.pts ?? 0), negativePoints: 0 },
    perHour: o.perHour ?? { hours: 80, actionsPerHour: 1.25, weightedPerHour: 2, pointsPerHour: (o.pts ?? 0) / 80 },
    adjustments: o.adjustments ?? 0, openDisputes: o.openDisputes ?? 0,
    cities: o.cities ?? ["lisbon"], brand: o.brand ?? null, agents: o.agents ?? [], tlDays: o.tlDays ?? 0, teamLeader: o.teamLeader ?? null,
  };
}

const ROWS: EvalRankingRowLike[] = [
  row(1, "João d'Almeida", { pts: 1458, agents: ["4711", "joao.a"], cities: ["porto"], brand: { id: 30, name: "Redpark" }, m: { speedingEvents: 2 }, teamLeader: { id: 9, name: "Rita TL" } }),
  row(2, "Ana Sousa", { pts: 620, cities: ["lisbon"], m: { complaints: 1 }, teamLeader: { id: 9, name: "Rita TL" } }),
  row(3, "Bruno Faria", { pts: 300, cities: ["faro"], position: "extra", m: { accidents: 1, cost: 120 } }),
  row(4, "Carla Lopes", { pts: -200, cities: ["porto", "lisbon"], position: "senior_driver", tlDays: 3, openDisputes: 1 }),
  row(5, "Duarte Ana", { pts: 510, cities: [], perHour: { hours: 0, actionsPerHour: null, weightedPerHour: null, pointsPerHour: null }, m: { hoursWorked: 0, speedingEvents: 1 } }),
];
const ids = (rs: EvalRankingRowLike[]) => rs.map((r) => r.employeeId);

// ─── 1. Pesquisa por facetas ────────────────────────────────────────────────

describe("pesquisa: barra única com facetas (como no Odoo)", () => {
  it("o que se escreve procura no nome e no n.º de agente, sem acentos nem maiúsculas", () => {
    expect(ids(filterRanking(ROWS, { text: "joao dalmeida" }))).toEqual([1]);
    expect(ids(filterRanking(ROWS, { text: "4711" }))).toEqual([1]);
    expect(ids(filterRanking(ROWS, { text: "ana" }))).toEqual([2, 5]);
    expect(ids(filterRanking(ROWS, { text: "  " }))).toEqual([1, 2, 3, 4, 5]);
  });
  it("'Procurar «x» em' conta quantas pessoas cada faceta encontra", () => {
    const c = facetCounts(ROWS, "porto");
    expect(c.city).toBe(2);
    expect(c.name).toBe(0);
    expect(facetCounts(ROWS, "rita").team).toBe(2);
    expect(facetCounts(ROWS, "redpark").brand).toBe(1);
    expect(facetCounts(ROWS, "extra").position).toBe(1);
    expect(facetCounts(ROWS, "team leader").position).toBe(1);
  });
  it("chips: mesmo campo → OU; campos diferentes → E; e o texto que se escreve junta com E", () => {
    expect(ids(filterRanking(ROWS, { searches: [{ field: "city", text: "Porto" }, { field: "city", text: "Faro" }] }))).toEqual([1, 3, 4]);
    expect(ids(filterRanking(ROWS, { searches: [{ field: "city", text: "Porto" }, { field: "name", text: "Carla" }] }))).toEqual([4]);
    expect(matchesSearches(ROWS[0], [{ field: "city", text: "Porto" }], "Carla")).toBe(false);
  });
});

// ─── 2. Grupos ──────────────────────────────────────────────────────────────

describe("grupos: OU dentro do grupo, E entre grupos", () => {
  it("cidade Porto ou Faro E só com (reclamações ou acidentes)", () => {
    expect(ids(filterRanking(ROWS, { groups: { city: ["porto", "faro"] } }))).toEqual([1, 3, 4]);
    expect(ids(filterRanking(ROWS, { groups: { city: ["porto", "faro"], flags: ["complaints", "accidents"] } }))).toEqual([3]);
  });
  it("posto (TL = teve dias como TL), marca, equipa e os 'só com'", () => {
    expect(ids(filterRanking(ROWS, { groups: { position: ["tl"] } }))).toEqual([4]);
    expect(ids(filterRanking(ROWS, { groups: { position: ["extra", "senior_driver"] } }))).toEqual([3, 4]);
    expect(ids(filterRanking(ROWS, { groups: { brand: ["30"] } }))).toEqual([1]);
    expect(ids(filterRanking(ROWS, { groups: { team: ["9"] } }))).toEqual([1, 2]);
    expect(ids(filterRanking(ROWS, { groups: { flags: ["speeding"] } }))).toEqual([1, 5]);
    expect(ids(filterRanking(ROWS, { groups: { flags: ["disputes"] } }))).toEqual([4]);
    expect(ids(filterRanking(ROWS, { groups: { flags: ["negative"] } }))).toEqual([4]);
  });
  it("as opções vêm das linhas, com quantas pessoas", () => {
    const o = groupOptions(ROWS);
    expect(o.city.map((x) => [x.label, x.n])).toEqual([["Faro", 1], ["Lisboa", 2], ["Porto", 2]]);
    expect(o.brand).toEqual([{ value: "30", label: "Redpark", n: 1 }]);
    expect(o.team).toEqual([{ value: "9", label: "Rita TL", n: 2 }]);
    expect(o.flags.find((f) => f.value === "speeding")?.n).toBe(2);
  });
});

// ─── 3. Regras ──────────────────────────────────────────────────────────────

describe("filtro personalizado: regras sobre as colunas e as métricas", () => {
  it("'pontos ≥ 500 E excessos de velocidade ≥ 1' e 'reclamações ≥ 1'", () => {
    expect(ids(filterRanking(ROWS, { rules: { match: "all", items: [{ field: "points", op: "gte", value: 500 }, { field: "speedingEvents", op: "gte", value: 1 }] } }))).toEqual([1, 5]);
    expect(ids(filterRanking(ROWS, { rules: { match: "all", items: [{ field: "complaints", op: "gte", value: "1" }] } }))).toEqual([2]);
  });
  it("todas vs pelo menos uma", () => {
    const items = [{ field: "complaints", op: "has" as const }, { field: "accidents", op: "has" as const }];
    expect(ids(filterRanking(ROWS, { rules: { match: "all", items } }))).toEqual([]);
    expect(ids(filterRanking(ROWS, { rules: { match: "any", items } }))).toEqual([2, 3]);
  });
  it("≤, =, entre (com vírgula e por qualquer ordem), tem e não tem", () => {
    expect(ruleHolds(ROWS[2], { field: "cost", op: "lte", value: 120 })).toBe(true);
    expect(ruleHolds(ROWS[1], { field: "points", op: "eq", value: "620,0" })).toBe(true);
    expect(ids(filterRanking(ROWS, { rules: { match: "all", items: [{ field: "points", op: "between", value: 600, value2: 300 }] } }))).toEqual([3, 5]);
    expect(ids(filterRanking(ROWS, { rules: { match: "all", items: [{ field: "tlDays", op: "has" }] } }))).toEqual([4]);
    expect(ids(filterRanking(ROWS, { rules: { match: "all", items: [{ field: "speedingEvents", op: "not_has" }] } }))).toEqual([2, 3, 4]);
  });
  it("por hora sem horas não cumpre ≥ nem 'tem'; regra sem valor ou campo desconhecido não filtra", () => {
    expect(ruleHolds(ROWS[4], { field: "pointsPerHour", op: "gte", value: 0 })).toBe(false);
    expect(ruleHolds(ROWS[4], { field: "pointsPerHour", op: "has" })).toBe(false);
    expect(ruleHolds(ROWS[4], { field: "pointsPerHour", op: "not_has" })).toBe(true);
    expect(filterRanking(ROWS, { rules: { match: "all", items: [{ field: "points", op: "gte", value: "" }] } })).toHaveLength(5);
    expect(filterRanking(ROWS, { rules: { match: "all", items: [{ field: "inventado", op: "gte", value: 1 }] } })).toHaveLength(5);
    expect(isFilterActive({ rules: { match: "all", items: [{ field: "points", op: "gte", value: "" }] } })).toBe(false);
  });
  it("as linhas do servidor (perHourMetrics) servem tal como vêm", () => {
    const metrics = { ...emptyDayMetrics(), hoursWorked: 10, actions: 20, speedingEvents: 1 };
    const score = scoreOf(metrics);
    const r = { employeeId: 7, employeeName: "Eva", position: "driver", days: 2, metrics, score, perHour: perHourMetrics(metrics, score) };
    expect(filterRanking([r], { rules: { match: "all", items: [{ field: "actionsPerHour", op: "gte", value: 2 }, { field: "speedingEvents", op: "gte", value: 1 }] } })).toHaveLength(1);
  });
});

// ─── 4. Totais, agrupar e texto do filtro ───────────────────────────────────

describe("os cartões do topo e o agrupar são do que se vê", () => {
  it("totais (horas, ações, custo) e o melhor só das linhas filtradas", () => {
    const shown = filterRanking(ROWS, { groups: { city: ["faro", "lisbon"] } });
    const t = rankingTotals(shown);
    expect(t.people).toBe(3);
    expect(t.cost).toBe(500 + 120 + 500);
    expect(t.best?.employeeName).toBe("Ana Sousa");
    expect(rankingTotals([]).best).toBeNull();
  });
  it("agrupar por cidade (a principal), por equipa e 'Sem …' no fim", () => {
    const g = groupRanking(ROWS, "city");
    expect(g.map((x) => [x.label, ids(x.rows)])).toEqual([["Faro", [3]], ["Lisboa", [2]], ["Porto", [1, 4]], ["Sem cidade", [5]]]);
    expect(g.find((x) => x.label === "Porto")?.totals.points).toBe(1258);
    expect(groupRanking(ROWS, "team").map((x) => x.label)).toEqual(["Rita TL", "Sem equipa (TL)"]);
  });
  it("o filtro em texto (chips, CSV, folha)", () => {
    const view = { text: "ana", groups: { city: ["porto"], flags: ["complaints" as const] }, rules: { match: "any" as const, items: [{ field: "points", op: "gte" as const, value: 500 }, { field: "speedingEvents", op: "gte" as const, value: 1 }] } };
    expect(filterParts(view, ROWS)).toEqual([
      "Nome ou n.º de agente: «ana»", "Cidade: Porto", "Só com: Reclamações", "Pontos ≥ 500 ou Excessos de velocidade ≥ 1",
    ]);
    expect(describeFilter({ groups: { brand: ["30"], team: ["9"] } }, ROWS)).toBe("Marca: Redpark · Equipa: Rita TL");
    expect(describeFilter({})).toBe("");
  });
});

// ─── 5. Filtros guardados ───────────────────────────────────────────────────

describe("filtros guardados: lidos de volta sem partir a página", () => {
  it("o que é válido aplica-se; o resto cai e conta-se", () => {
    const r = sanitizeEvalSavedView({
      text: "ana", searches: [{ field: "city", text: "Porto" }, { field: "inventado", text: "x" }],
      groups: { city: ["porto"], position: ["chefe"], novo: ["?"] },
      rules: { match: "any", items: [{ field: "points", op: "gte", value: 500 }, { field: "campo.velho", op: "gte", value: 1 }, { field: "accidents", op: "maior" }] },
      groupBy: "cidade", view: "perHour", sort: { key: "points", dir: -1 },
    });
    expect(r.view.text).toBe("ana");
    expect(r.view.searches).toEqual([{ field: "city", text: "Porto" }]);
    expect(r.view.groups).toEqual({ city: ["porto"] });
    expect(r.view.rules).toEqual({ match: "any", items: [{ field: "points", op: "gte", value: 500 }] });
    expect(r.view.groupBy).toBeUndefined();
    expect(r.view.view).toBe("perHour");
    expect(r.dropped).toBe(6);
  });
  it("lixo não parte", () => {
    expect(() => sanitizeEvalSavedView("nada")).not.toThrow();
    expect(sanitizeEvalSavedView(null).view).toEqual({ groups: {}, rules: null });
  });
});

/** BD falsa para os filtros guardados. */
function fakeDb(handler: (sqlText: string, params: unknown[]) => unknown[] = () => []) {
  const seen: { sql: string; params: unknown[] }[] = [];
  return { seen, execute: async (q: SQL) => { const c = compile(q); seen.push(c); return [handler(c.sql, c.params)]; } };
}

describe("filtros guardados: a mesma tabela do CRM, uma página de cada vez", () => {
  it("guardar na Avaliação: valida, grava a página e o 'abrir com este' só mexe nos da Avaliação", async () => {
    const db = fakeDb();
    await expect(saveFilterFor(db, 1, "avaliacao", { name: "x", payload: { rules: { match: "all", items: [{ field: "points", op: "maior" }] } }, shared: false, isDefault: false })).rejects.toThrow(/inválidos/);
    await saveFilterFor(db, 1, "avaliacao", { name: "Porto rápido", payload: { groups: { city: ["porto"] }, rules: { match: "all", items: [{ field: "speedingEvents", op: "gte", value: 1 }] }, groupBy: "team" }, shared: true, isDefault: true });
    const reset = db.seen.find((q) => q.sql.startsWith("UPDATE crm_saved_filters SET isDefault = 0"))!;
    expect(reset.sql).toMatch(/AND page = \?/);
    expect(reset.params).toEqual([1, "avaliacao"]);
    const ins = db.seen.find((q) => q.sql.includes("INSERT INTO crm_saved_filters"))!;
    expect(ins.sql).toMatch(/\(userId, name, payloadJson, shared, isDefault, page\)/);
    expect(ins.params.at(-1)).toBe("avaliacao");
    expect(JSON.parse(String(ins.params[2]))).toMatchObject({ groups: { city: ["porto"] }, groupBy: "team" });
  });
  it("o CRM continua igual, na página 'crm'", async () => {
    const db = fakeDb();
    await crmSaveFilter(db, 2, { name: "ok", payload: { groups: { city: ["Lisboa"] } }, shared: false, isDefault: false });
    const ins = db.seen.find((q) => q.sql.includes("INSERT INTO crm_saved_filters"))!;
    expect(ins.params.at(-1)).toBe("crm");
    expect(JSON.parse(String(ins.params[2]))).toEqual({ groups: { city: ["Lisboa"] } });
  });
  it("listar só a página pedida; apagar só o próprio e fica registado", async () => {
    const db = fakeDb((s) => (s.includes("SELECT f.id") ? [{ id: 4, userId: 1, name: "Meu", payloadJson: JSON.stringify({ groups: { flags: ["speeding", "velho"] } }), shared: 0, isDefault: 1, ownerName: "Rita" }]
      : s.includes("SELECT name, shared") ? [{ name: "Meu", shared: 1 }] : []));
    const list = await listSavedFiltersFor(db, 1, "avaliacao");
    expect(db.seen[0].sql).toMatch(/f\.page = \?/);
    expect(db.seen[0].params).toContain("avaliacao");
    expect(list[0]).toMatchObject({ id: 4, isDefault: true, mine: true, dropped: 1 });
    await deleteFilterFor(db, 1, "avaliacao", 4);
    expect(db.seen.at(-1)!.sql).toMatch(/DELETE FROM crm_saved_filters WHERE id = \? AND userId = \? AND page = \?/);
    expect(state.logs.at(-1)).toMatchObject({ action: "evaluation_filter_delete", entity: "evaluation_filter", entityId: 4 });
  });
  it("o esquema guarda também o agrupar, a vista e a ordem; acima dos limites recusa (o ecrã não deixa lá chegar)", () => {
    expect(evalSavedViewSchema.safeParse({ groupBy: "brand", view: "totals", sort: { key: "hours", dir: 1 } }).success).toBe(true);
    expect(evalSavedViewSchema.safeParse({ sort: { key: "hours", dir: 2 } }).success).toBe(false);
    const rule = { field: "points", op: "gte", value: 1 };
    expect(evalSavedViewSchema.safeParse({ rules: { match: "all", items: Array(EVAL_FILTER_LIMITS.rules).fill(rule) } }).success).toBe(true);
    expect(evalSavedViewSchema.safeParse({ rules: { match: "all", items: Array(EVAL_FILTER_LIMITS.rules + 1).fill(rule) } }).success).toBe(false);
    expect(src("client/src/components/evaluation/RankingFilterBar.tsx")).toContain("const { searches: MAX_SEARCHES, rules: MAX_RULES } = EVAL_FILTER_LIMITS;");
  });
  it("migração 0665: coluna page (por omissão 'crm') + índice, idempotente", async () => {
    const m = await import("./migrations/migration_0665");
    expect(m.MIGRATION_0665_STATEMENTS.join(" ")).toMatch(/ADD COLUMN `page` VARCHAR\(24\) NOT NULL DEFAULT 'crm'/);
    expect([...m.IDEMPOTENT_ERROR_CODES_0665]).toEqual(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
    expect(src("drizzle/schema.ts")).toContain("page: varchar({ length: 24 }).default('crm').notNull(),");
  });
});

// ─── 6. O ranking traz as facetas (e nunca parte) ───────────────────────────

const caller = (role: string, id = 1) => appRouter.createCaller({ user: { id, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const range = { from: "2026-10-01", to: "2026-10-14" };
function evalDay(employeeId: number, name: string, day: string, o: { city?: string | null; shift?: string | null; tl?: boolean; actions?: number } = {}) {
  const metrics = { ...emptyDayMetrics(), actions: o.actions ?? 3 };
  return { employeeId, employeeName: name, position: "driver", day, city: o.city ?? null, shift: o.shift ?? null, isTeamLeader: !!o.tl, metrics, base: metrics, score: scoreOf(metrics), perHour: perHourMetrics(metrics), adjustments: [] };
}

describe("evaluation.ranking: cidades, marca, agentes, dias de TL e equipa", () => {
  beforeEach(() => {
    state.days = [
      evalDay(8, "Ana", "2026-10-02", { city: "porto", shift: "morning" }),
      evalDay(8, "Ana", "2026-10-03", { city: "porto", shift: "morning" }),
      evalDay(8, "Ana", "2026-10-04", { city: "lisbon", shift: "night" }),
      evalDay(9, "Bruno", "2026-10-02", { city: "porto", shift: "morning", tl: true }),
      evalDay(10, "Carla", "2026-10-05"),
    ];
    state.handler = (s) => {
      if (s.includes("FROM employees WHERE id IN")) return [{ id: 8, projectId: 31, multiparkAgentName: "ana.s", multiparkAgentUserId: "4711" }, { id: 10, projectId: 20, multiparkAgentName: null, multiparkAgentUserId: null }];
      if (s.includes("FROM employee_agents")) return [{ employeeId: 8, agentUserId: "9001", agentName: "Ana Balcão" }];
      if (s.includes("FROM projects")) return [{ id: 20, parentId: 1, level: "city", name: "Lisboa" }, { id: 30, parentId: 20, level: "brand", name: "Redpark" }, { id: 31, parentId: 30, level: "project", name: "Redpark Lisboa" }];
      if (s.includes("employee_day_metrics")) return [
        { employeeId: 9, fullName: "Bruno", day: "2026-10-02", city: "porto", shift: "morning" },
        { employeeId: 12, fullName: "Zé TL", day: "2026-10-03", city: "porto", shift: "morning" },
        { employeeId: 13, fullName: "Outro TL", day: "2026-10-03", city: "faro", shift: "morning" },
      ];
      return [];
    };
  });
  it("cada linha traz o que os filtros precisam", async () => {
    const rows = await caller("supervisor").evaluation.ranking(range);
    const ana = rows.find((r) => r.employeeId === 8)!;
    expect(ana.cities).toEqual(["porto", "lisbon"]);
    expect(ana.brand).toEqual({ id: 30, name: "Redpark" });
    expect(ana.agents).toEqual(["4711", "ana.s", "9001", "Ana Balcão"]);
    expect(ana.tlDays).toBe(0);
    expect(ana.teamLeader).toEqual({ id: 9, name: "Bruno" }); // empate 1–1 com o Zé → pelo nome
    const bruno = rows.find((r) => r.employeeId === 9)!;
    expect(bruno.tlDays).toBe(1);
    expect(bruno.teamLeader).toEqual({ id: 9, name: "Bruno" }); // só foi TL → a própria equipa
    const carla = rows.find((r) => r.employeeId === 10)!;
    expect(carla.cities).toEqual(["lisbon"]); // sem escala → a cidade da ficha
    expect(carla.brand).toBeNull();
    expect(carla.teamLeader).toBeNull();
  });
  it("a BD a falhar nas facetas não parte o ranking (sai sem elas)", async () => {
    state.handler = () => { throw new Error("ECONNRESET"); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = await caller("supervisor").evaluation.ranking(range);
    warn.mockRestore();
    expect(rows.map((r) => r.employeeId).sort()).toEqual([10, 8, 9].sort());
    expect(rows.find((r) => r.employeeId === 8)).toMatchObject({ brand: null, agents: [], cities: ["porto", "lisbon"], teamLeader: null });
  });
  it("filtros guardados da Avaliação: só quem vê o ranking", async () => {
    state.handler = () => [];
    await expect(caller("supervisor").evaluation.savedFilters()).resolves.toEqual([]);
    for (const role of ["extra", "condutor"]) {
      await expect(caller(role).evaluation.savedFilters()).rejects.toThrow();
      await expect(caller(role).evaluation.saveFilter({ name: "x", payload: {}, shared: false, isDefault: false })).rejects.toThrow();
    }
  });
});

describe("as peças puras das facetas", () => {
  it("cidade e marca pela árvore dos centros de custos; agentes sem repetir", () => {
    const nodes = new Map([[1, { id: 1, parentId: null, level: "city", name: "Porto" }], [2, { id: 2, parentId: 1, level: "brand", name: "Skypark" }], [3, { id: 3, parentId: 2, level: "project", name: "P" }]]);
    expect(ancestorOfLevel(3, nodes, "brand")?.name).toBe("Skypark");
    expect(ancestorOfLevel(1, nodes, "brand")).toBeNull();
    const f = buildEmployeeFacets([{ id: 5, projectId: 3, multiparkAgentName: "x", multiparkAgentUserId: "x" }], [], [...nodes.values()], (n) => (n === "Porto" ? "porto" : null));
    expect(f.get(5)).toEqual({ homeCity: "porto", brand: { id: 2, name: "Skypark" }, agents: ["x"] });
  });
  it("cidades do período: mais dias primeiro; sem escala, a da ficha", () => {
    expect(citiesOfDays([{ city: "faro" }, { city: "porto" }, { city: "porto" }, { city: null }], "lisbon")).toEqual(["porto", "faro"]);
    expect(citiesOfDays([{ city: null }], "lisbon")).toEqual(["lisbon"]);
    expect(citiesOfDays([], null)).toEqual([]);
  });
  it("a equipa: o TL do mesmo dia, cidade e turno com quem mais trabalhou", () => {
    const d = (employeeId: number, day: string, city: string | null, shift: string | null, isTeamLeader = false) => ({ employeeId, employeeName: `P${employeeId}`, day, city, shift, isTeamLeader });
    const tl = (employeeId: number, day: string, city: string, shift: string) => ({ employeeId, employeeName: `TL${employeeId}`, day, city, shift });
    const m = mainTeamLeaders(
      [d(1, "a", "porto", "m"), d(1, "b", "porto", "m"), d(1, "c", "porto", "n"), d(2, "a", "porto", "n"), d(3, "a", null, null)],
      [tl(7, "a", "porto", "m"), tl(7, "b", "porto", "m"), tl(8, "c", "porto", "n"), tl(9, "a", "lisbon", "n")],
    );
    expect(m.get(1)).toEqual({ id: 7, name: "TL7" });
    expect(m.get(2)).toBeNull(); // TL de outra cidade não conta
    expect(m.get(3)).toBeNull();
  });
});

// ─── 7. Exportações levam o filtrado ────────────────────────────────────────

describe("CSV e Sheets: levam o que está filtrado e dizem-no", () => {
  it("CSV: só as linhas dadas, a posição do ranking e o filtro no topo", () => {
    const shown = filterRanking(ROWS, { groups: { flags: ["speeding"] } });
    const csv = rankingCsv(shown, { rankOf: (id) => id, filter: describeFilter({ groups: { flags: ["speeding"] } }, ROWS), total: ROWS.length });
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Filtro: Só com: Excessos de velocidade (2 de 5 colaboradores)");
    expect(lines[1]).toBe("");
    expect(lines[2].startsWith("Pos;Colaborador;Dias;Horas")).toBe(true);
    expect(lines.slice(3).map((l) => l.split(";")[1])).toEqual(["João d'Almeida", "Duarte Ana"]);
    expect(lines[3].split(";").slice(-3)).toEqual(["Porto", "Redpark", "Rita TL"]);
  });
  it("CSV sem filtro: o de sempre (cabeçalho na 1.ª linha)", () => {
    const csv = rankingCsv(ROWS, { rankOf: () => 1 });
    expect(csv.split("\n")[0].startsWith("Pos;Colaborador")).toBe(true);
    expect(csv.split("\n")).toHaveLength(6);
  });
  it("Sheets: o mesmo procedimento da página com a cidade/marca do topo; filtra com as mesmas regras e di-lo", async () => {
    const calls: any[] = [];
    const call = async (path: string, input: any) => { calls.push({ path, input }); return ROWS; };
    const filter = { groups: { city: ["porto"] }, rules: { match: "all" as const, items: [{ field: "points", op: "gte" as const, value: 500 }] } };
    const input = sheetExportInputSchema.parse({ report: "avaliacoes", from: "2026-10-01", to: "2026-10-31", projectId: 20, filter });
    const tabs = await SHEET_REPORTS.avaliacoes.load(call, input, Date.now() + 60_000);
    expect(calls[0]).toEqual({ path: "evaluation.ranking", input: { from: "2026-10-01", to: "2026-10-31", projectId: 20 } });
    expect(tabs[0].name).toBe("Ranking (filtrado)");
    expect(tabs[0].rows.slice(1).map((r) => r[0])).toEqual(["João d'Almeida"]);
    expect(tabs[0].note).toBeUndefined(); // filtrado não é "incompleto"
    expect(tabs[1].name).toBe("Filtro");
    expect(tabs[1].rows).toContainEqual(["Colaboradores", "1 de 5"]);
    expect(tabs[1].rows).toContainEqual(["Filtro", "Cidade: Porto"]);
    expect(tabs[1].rows).toContainEqual(["Filtro", "Pontos ≥ 500"]);
    expect(exportSpreadsheetName(input, "2026-10-14")).toBe("Avaliação individual (ranking) 2026-10-01 a 2026-10-31 (exportado 2026-10-14, filtrado)");
  });
  it("Sheets sem filtro: um separador 'Ranking' com todos, nome de sempre", async () => {
    const call = async () => ROWS;
    const input = sheetExportInputSchema.parse({ report: "avaliacoes", from: "2026-10-01", to: "2026-10-31" });
    const tabs = await SHEET_REPORTS.avaliacoes.load(call, input, Date.now() + 60_000);
    expect(tabs.map((t) => t.name)).toEqual(["Ranking"]);
    expect(tabs[0].rows).toHaveLength(1 + ROWS.length);
    expect(exportSpreadsheetName(input, "2026-10-14")).not.toMatch(/filtrado/);
  });
});

// ─── 8. O ecrã usa estas peças (e as do CRM) ────────────────────────────────

describe("ecrã: o Mês, o Dia e as Contestações", () => {
  const month = src("client/src/components/evaluation/MonthEvaluationTab.tsx");
  const bar = src("client/src/components/evaluation/RankingFilterBar.tsx");
  it("o ranking, os cartões e as exportações vêm das linhas filtradas", () => {
    expect(month).toContain("const shownRows = useMemo(() => filterRanking(rows, flt), [rows, flt]);");
    expect(month).toContain("const totals = useMemo(() => rankingTotals(shownRows), [shownRows]);");
    expect(month).toContain("rankingCsv(sorted, {");
    expect(month).toContain('input={{ report: "avaliacoes", from, to, projectId, ...(active ? { filter: filterOnly } : {}) }}');
    expect(month).not.toMatch(/🥇|🥈|🥉/);
  });
  it("a barra reutiliza as peças do CRM (grupos, regras, guardados, facetas, chips)", () => {
    for (const s of ["<FilterGroup", "<RulesEditor<EvalRule>", '<SavedFiltersMenu<EvalSavedView>', 'page="avaliacao"', "<FacetRow", "<FilterChips"]) expect(bar, s).toContain(s);
    expect(src("client/src/pages/CrmClientsPage.tsx")).toContain("<FilterChips chips={chips} onClear={clearAll} />");
  });
  it("Dia e Contestações: procurar pessoa com a mesma regra", () => {
    expect(src("client/src/components/evaluation/DayEvaluationTab.tsx")).toContain("personMatches([a?.personName, a?.multiparkAgentName");
    expect(src("client/src/pages/AvaliacaoPage.tsx")).toContain("personMatches([d.employeeName], who)");
    expect(personMatches(["Gelson Manuel Leão Sousa", "gelson.s"], "leao sousa")).toBe(true);
    expect(personMatches(["Gelson Sousa"], "ana")).toBe(false);
    expect(personMatches(["Gelson Sousa"], "")).toBe(true);
  });
});

// ─── 9. "O meu perfil" no menu do computador ────────────────────────────────

describe("menu da fotografia (computador): 'O meu perfil'", () => {
  const layout = src("client/src/components/DashboardLayout.tsx");
  const menu = layout.slice(layout.indexOf('aria-label="Menu da conta"'), layout.indexOf("</DropdownMenuContent>", layout.indexOf('aria-label="Menu da conta"')));
  it("está no menu do avatar, abre /perfil (o mesmo destino da barra do telemóvel) e mantém os outros itens", () => {
    expect(menu).toContain('<DropdownMenuItem onClick={() => navigate("/perfil")} className="cursor-pointer">');
    expect(menu).toContain("<span>O meu perfil</span>");
    expect(src("client/src/components/MobileTabBar.tsx")).toContain('navigate("/perfil")');
    for (const item of ["Dar entrada (check-in)", "Dar saída (check-out)", "Trocar foto", "<span>Sair</span>"]) expect(menu, item).toContain(item);
    // logo a seguir ao nome e ao estado; sem condição (todos os papéis)
    expect(menu.indexOf("O meu perfil")).toBeLessThan(menu.indexOf("Dar entrada (check-in)"));
    const before = menu.slice(0, menu.indexOf("O meu perfil"));
    expect(before.slice(before.lastIndexOf("<DropdownMenuSeparator />"))).not.toMatch(/&&\s*\(\s*$/);
  });
  it("o /perfil abre a todos os papéis (pessoal), com ou sem menu e sem centro de custos", () => {
    expect(isPersonalRoute("/perfil")).toBe(true);
    for (const lowRole of [true, false]) {
      expect(decideRoute({ path: "/perfil", allowedPaths: new Set(), allMenuPaths: new Set(["/perfil"]), lowRole, firstAllowed: "/rh" })).toEqual({ kind: "ok" });
    }
  });
});
