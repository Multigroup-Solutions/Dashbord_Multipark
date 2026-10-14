/**
 * Auditoria (14 out 2026) da pesquisa e dos filtros da Avaliação → Mês e do
 * "O meu perfil" no menu do computador — o que se tentou partir e ficou
 * corrigido:
 *  - filtros guardados ANTES de a migração 0665 correr (sem a coluna `page`):
 *    o CRM continua a ler, gravar e apagar; a Avaliação fica sem guardados e
 *    di-lo, sem partir;
 *  - ninguém altera nem apaga o filtro de outra pessoa (nem lhe tira o "abrir
 *    com este" ao tentar);
 *  - a marca é pelo nome (os nós de marca são por cidade);
 *  - a pesquisa compara cada parte (nome, cada agente, cada cidade), sem
 *    acentos nem maiúsculas, e nunca a junção de duas;
 *  - "entre" sem o 2.º valor, valores nulos, unidades e totais;
 *  - âmbito: o team leader só vê (e só lê as facetas de) a sua equipa; a
 *    folha só tira linhas, nunca acrescenta, e recusa filtros acima dos limites.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";

const compile = (s: SQL) => new MySqlDialect().sqlToQuery(s);
const state = vi.hoisted(() => ({
  days: [] as any[],
  handler: (_sql: string, _params: unknown[]): any[] => [],
  seen: [] as { sql: string; params: unknown[] }[],
  logs: [] as any[],
}));

const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
const access = vi.hoisted(() => ({ current: null as any }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => access.current ?? national,
  loadCityAccessParts: async () => ({ access: access.current ?? national, base: access.current ?? national, all: national }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({
    execute: async (q: SQL) => {
      const c = compile(q);
      state.seen.push(c);
      return [state.handler(c.sql, c.params)];
    },
  }),
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
  describeFilter, evalFilterViewSchema, evalRuleText, filterRanking, groupOptions, groupRanking, matchesSearch, partsMatch, personMatches,
  rankingTotals, ruleHolds, type EvalFilterView, type EvalRankingRowLike,
} from "../shared/evaluationFilters";
import { deleteFilterFor, isMissingPageColumn, listSavedFiltersFor, saveFilterFor } from "./savedFilters";
import { SHEET_REPORTS } from "./google/sheetsExport";
import { sheetExportInputSchema } from "../shared/drive";
import { emptyDayMetrics, perHourMetrics, scoreOf } from "../shared/evaluationRules";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const caller = (role: string, id = 1) => appRouter.createCaller({ user: { id, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);

beforeEach(() => {
  access.current = null;
  state.days = [];
  state.handler = () => [];
  state.seen = [];
  state.logs = [];
});

/** O erro do MySQL sem a coluna, como o drizzle o embrulha (o código vem em `cause`). */
function unknownPageColumn(): Error {
  const err: any = new Error("Failed query: SELECT … f.page …");
  err.cause = { code: "ER_BAD_FIELD_ERROR", errno: 1054, message: "Unknown column 'f.page' in 'where clause'" };
  return err;
}
/** A tabela como estava antes da 0665: qualquer SQL que fale da coluna `page` parte. */
const usesPage = (s: string) => /\bpage\b/.test(s.replace(/crm_saved_filters/g, ""));

// ─── 1. Antes de a migração 0665 correr ─────────────────────────────────────

describe("filtros guardados ANTES da migração 0665 (sem a coluna `page`)", () => {
  const legacyRow = { id: 3, userId: 1, name: "Pro de Lisboa", payloadJson: JSON.stringify({ groups: { city: ["Lisboa"] } }), shared: 0, isDefault: 1, ownerName: "Rita" };
  function oldTable() {
    const seen: { sql: string; params: unknown[] }[] = [];
    return {
      seen,
      execute: async (q: SQL) => {
        const c = compile(q);
        seen.push(c);
        if (usesPage(c.sql)) throw unknownPageColumn();
        if (c.sql.includes("SELECT f.id")) return [[legacyRow]];
        if (c.sql.includes("SELECT name, shared")) return [[{ name: "Pro de Lisboa", shared: 0 }]];
        if (c.sql.startsWith("SELECT id FROM crm_saved_filters")) return [[{ id: 3 }]];
        return [{ insertId: 77 }];
      },
    };
  }

  it("reconhece o erro (código do mysql2 direto ou embrulhado pelo drizzle); os outros erros não", () => {
    expect(isMissingPageColumn(unknownPageColumn())).toBe(true);
    expect(isMissingPageColumn({ code: "ER_BAD_FIELD_ERROR" })).toBe(true);
    expect(isMissingPageColumn(new Error("Unknown column 'page' in 'field list'"))).toBe(true);
    expect(isMissingPageColumn(new Error("ECONNRESET"))).toBe(false);
    expect(isMissingPageColumn(null)).toBe(false);
  });

  it("CRM: os filtros que já existem continuam a ler (a consulta de sempre)", async () => {
    const db = oldTable();
    const list = await listSavedFiltersFor(db, 1, "crm");
    expect(list).toEqual([expect.objectContaining({ id: 3, name: "Pro de Lisboa", isDefault: true, mine: true, payload: expect.objectContaining({ groups: expect.objectContaining({ city: ["Lisboa"] }) }) })]);
    const last = db.seen.at(-1)!;
    expect(last.sql).not.toMatch(/\bpage\b/);
    expect(last.sql).toMatch(/WHERE f\.userId = \? OR f\.shared = 1/);
  });

  it("CRM: guardar, alterar e apagar funcionam sem a coluna", async () => {
    const db = oldTable();
    await expect(saveFilterFor(db, 1, "crm", { name: "Novo", payload: { groups: { city: ["Porto"] } }, shared: false, isDefault: true })).resolves.toEqual({ id: 77 });
    const ins = db.seen.find((q) => q.sql.startsWith("INSERT INTO crm_saved_filters") && !usesPage(q.sql))!;
    expect(ins.sql).toMatch(/\(userId, name, payloadJson, shared, isDefault\)/);
    expect(db.seen.some((q) => q.sql === "UPDATE crm_saved_filters SET isDefault = 0 WHERE userId = ?")).toBe(true);
    await expect(saveFilterFor(db, 1, "crm", { id: 3, name: "Outro nome", payload: {}, shared: true, isDefault: false })).resolves.toEqual({ id: 3 });
    await expect(deleteFilterFor(db, 1, "crm", 3)).resolves.toBeUndefined();
    expect(db.seen.at(-1)!.sql).toBe("DELETE FROM crm_saved_filters WHERE id = ? AND userId = ?");
    expect(state.logs.at(-1)).toMatchObject({ action: "crm_filter_delete", entityId: 3 });
  });

  it("Avaliação: a lista sai vazia e guardar diz que ainda não dá (nunca escreve um filtro da Avaliação como se fosse do CRM)", async () => {
    const db = oldTable();
    await expect(listSavedFiltersFor(db, 1, "avaliacao")).resolves.toEqual([]);
    await expect(saveFilterFor(db, 1, "avaliacao", { name: "x", payload: {}, shared: false, isDefault: false })).rejects.toThrow(/ainda não estão disponíveis/);
    expect(db.seen.filter((q) => q.sql.startsWith("INSERT")).every((q) => usesPage(q.sql))).toBe(true);
    await expect(deleteFilterFor(db, 1, "avaliacao", 3)).rejects.toThrow(/ainda não estão disponíveis/);
    expect(db.seen.some((q) => q.sql.startsWith("DELETE") && !usesPage(q.sql))).toBe(false);
  });

  it("outro erro da BD não se esconde (não cai para a consulta antiga)", async () => {
    const db = { execute: async () => { throw new Error("ECONNRESET"); } };
    await expect(listSavedFiltersFor(db, 1, "crm")).rejects.toThrow(/ECONNRESET/);
  });

  it("pelos routers: crm.savedFilters lê; evaluation.savedFilters dá []; evaluation.saveFilter recusa com a mensagem", async () => {
    state.handler = (s) => {
      if (usesPage(s)) throw unknownPageColumn();
      if (s.includes("SELECT f.id")) return [legacyRow];
      return [];
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(caller("super_admin").crm.savedFilters()).resolves.toHaveLength(1);
    await expect(caller("supervisor").evaluation.savedFilters()).resolves.toEqual([]);
    await expect(caller("supervisor").evaluation.saveFilter({ name: "x", payload: {}, shared: false, isDefault: false }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/ainda não estão disponíveis/) });
    warn.mockRestore();
  });

  it("a migração 0665 está registada por ordem, depois da 0655 (a 0660 da formação entra entre as duas)", async () => {
    const { SCHEMA_MIGRATION_IDS } = await import("./migrations/index");
    expect(SCHEMA_MIGRATION_IDS).toContain("0665");
    expect(SCHEMA_MIGRATION_IDS.indexOf("0665")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0655"));
    expect([...SCHEMA_MIGRATION_IDS].sort()).toEqual([...SCHEMA_MIGRATION_IDS]);
    const m = await import("./migrations/migration_0665");
    // só acrescenta: nada de DROP, DELETE nem UPDATE aos filtros que existem
    expect(m.MIGRATION_0665_STATEMENTS.join(" ")).not.toMatch(/\b(DROP|DELETE|UPDATE|MODIFY|CHANGE)\b/i);
  });
});

// ─── 2. O filtro de outra pessoa ────────────────────────────────────────────

describe("ninguém mexe no filtro guardado de outra pessoa", () => {
  /** Tabela com o filtro 5 do utilizador 2 (partilhado). */
  function table() {
    const seen: { sql: string; params: unknown[] }[] = [];
    return {
      seen,
      execute: async (q: SQL) => {
        const c = compile(q);
        seen.push(c);
        if (c.sql.startsWith("SELECT id FROM crm_saved_filters") || c.sql.startsWith("SELECT name, shared")) {
          return [c.params[1] === 2 ? [{ id: 5, name: "Do Bruno", shared: 1 }] : []];
        }
        return [{ insertId: 0 }];
      },
    };
  }
  it("alterar o partilhado de outro: recusa, e NÃO tira o 'abrir com este' aos meus", async () => {
    const db = table();
    await expect(saveFilterFor(db, 1, "avaliacao", { id: 5, name: "Roubado", payload: {}, shared: true, isDefault: true })).rejects.toThrow(/só podes alterar os teus/);
    expect(db.seen.some((q) => q.sql.startsWith("UPDATE"))).toBe(false);
  });
  it("apagar o de outro: recusa e não apaga nada", async () => {
    const db = table();
    await expect(deleteFilterFor(db, 1, "avaliacao", 5)).rejects.toThrow(/não encontrado/);
    expect(db.seen.some((q) => q.sql.startsWith("DELETE"))).toBe(false);
  });
  it("o dono altera o seu", async () => {
    const db = table();
    await expect(saveFilterFor(db, 2, "avaliacao", { id: 5, name: "Do Bruno", payload: {}, shared: true, isDefault: false })).resolves.toEqual({ id: 5 });
    expect(db.seen.at(-1)!.sql).toMatch(/^UPDATE crm_saved_filters SET name = \?.*WHERE id = \? AND userId = \? AND page = \?$/s);
  });
  it("pelo router: o TL não altera nem apaga o de outro", async () => {
    state.handler = (s) => (s.startsWith("SELECT") ? [] : []);
    await expect(caller("team_leader", 1).evaluation.saveFilter({ id: 5, name: "x", payload: {}, shared: false, isDefault: false })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller("team_leader", 1).evaluation.deleteFilter({ id: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(state.seen.some((q) => q.sql.startsWith("UPDATE") || q.sql.startsWith("DELETE"))).toBe(false);
  });
});

// ─── 3. Regras, pesquisa, marca e totais ────────────────────────────────────

function row(id: number, name: string, o: Partial<EvalRankingRowLike> & { m?: Record<string, number>; pts?: number } = {}): EvalRankingRowLike {
  return {
    employeeId: id, employeeName: name, position: o.position ?? "driver", days: o.days ?? 10,
    metrics: { hoursWorked: 80, actions: 100, recolhas: 20, entregas: 20, cost: 500, ...(o.m ?? {}) },
    score: { totalPoints: o.pts ?? 0, positivePoints: Math.max(0, o.pts ?? 0), negativePoints: Math.max(0, -(o.pts ?? 0)) },
    perHour: o.perHour ?? { hours: 80, actionsPerHour: 1.25, weightedPerHour: 2, pointsPerHour: (o.pts ?? 0) / 80 },
    adjustments: o.adjustments ?? 0, openDisputes: o.openDisputes ?? 0,
    cities: o.cities ?? ["lisbon"], brand: o.brand ?? null, agents: o.agents ?? [], tlDays: o.tlDays ?? 0, teamLeader: o.teamLeader ?? null,
  };
}
const ids = (rs: EvalRankingRowLike[]) => rs.map((r) => r.employeeId);

describe("marca: pelo nome (os nós de marca são por cidade)", () => {
  // Airpark de Lisboa (nó 30) e Airpark do Porto (nó 41) são a MESMA marca
  const rows = [
    row(1, "Ana", { cities: ["lisbon"], brand: { id: 30, name: "Airpark" } }),
    row(2, "Bruno", { cities: ["porto"], brand: { id: 41, name: "Airpark" } }),
    row(3, "Carla", { cities: ["porto"], brand: { id: 42, name: "Redpark" } }),
    row(4, "Duarte", { cities: ["faro"] }),
  ];
  it("uma opção por marca, com as pessoas das várias cidades", () => {
    expect(groupOptions(rows).brand).toEqual([{ value: "airpark", label: "Airpark", n: 2 }, { value: "redpark", label: "Redpark", n: 1 }]);
  });
  it("filtrar e agrupar juntam as cidades", () => {
    expect(ids(filterRanking(rows, { groups: { brand: ["airpark"] } }))).toEqual([1, 2]);
    expect(groupRanking(rows, "brand").map((g) => [g.label, ids(g.rows)])).toEqual([["Airpark", [1, 2]], ["Redpark", [3]], ["Sem marca", [4]]]);
    expect(describeFilter({ groups: { brand: ["airpark"] } }, rows)).toBe("Marca: Airpark");
  });
  it("um filtro partilhado com uma marca que não está nas linhas: o nome, nunca o id de outra cidade", () => {
    expect(describeFilter({ groups: { brand: ["skypark"] } }, rows)).toBe("Marca: skypark");
    expect(filterRanking(rows, { groups: { brand: ["skypark"] } })).toEqual([]);
  });
});

describe("pesquisa: acentos, maiúsculas, n.º de agente e partes separadas", () => {
  const rows = [
    row(1, "João d'Almeida", { agents: ["4711", "joao.a"] }),
    row(2, "Ana Silva", { agents: ["12"] }),
    row(3, "Joana Lopes", { agents: ["120"], cities: ["lisbon", "porto"] }),
  ];
  it("'João' = 'joao' = 'JOAO' = 'João'", () => {
    for (const q of ["João", "joao", "JOAO", "jOãO", "joão d'almeida", "JOAO DALMEIDA"]) {
      expect(ids(filterRanking(rows, { text: q })), q).toEqual([1]);
    }
  });
  it("n.º de agente (o principal e os extra) e o agente pelo nome", () => {
    expect(ids(filterRanking(rows, { text: "4711" }))).toEqual([1]);
    expect(ids(filterRanking(rows, { text: "joao.a" }))).toEqual([1]);
    expect(ids(filterRanking(rows, { text: "12" }))).toEqual([2, 3]); // "contém", como no Odoo
    expect(ids(filterRanking(rows, { text: "120" }))).toEqual([3]);
    expect(ids(filterRanking(rows, { text: "silva 12" }))).toEqual([2]); // nome E agente
  });
  it("nunca junta duas partes ('Silva' + agente '12' não dá 'a1'; 'lisbon' + 'porto' não dá 'bonpo')", () => {
    expect(ids(filterRanking(rows, { text: "a1" }))).toEqual([]);
    expect(matchesSearch(rows[2], { field: "city", text: "bonpo" })).toBe(false);
    expect(matchesSearch(rows[2], { field: "city", text: "Lisboa" })).toBe(true);
    expect(partsMatch(["Ana", "Silva"], "nasi")).toBe(false);
    expect(partsMatch(["Ana Silva"], "nasi")).toBe(true); // dentro da mesma parte, a regra de sempre (textKey)
  });
  it("Dia e Contestações usam a mesma regra", () => {
    expect(personMatches(["Joana Lopes", "120"], "JOANA 120")).toBe(true);
    expect(personMatches(["Ana Silva", "12"], "a1")).toBe(false);
  });
  it("o campo da barra tem o limite do que se guarda e exporta", () => {
    expect(src("client/src/components/evaluation/RankingFilterBar.tsx")).toMatch(/<input id="aval-q"[^>]*maxLength=\{200\}/);
  });
});

describe("regras: entre, tem, não tem, nulos e unidades", () => {
  const r = row(1, "Ana", { pts: -200, m: { hoursWorked: 7.5, cost: 87.25, scheduledHours: 8 } });
  const semHoras = row(2, "Bruno", { m: { hoursWorked: 0, scheduledHours: 8 }, perHour: { hours: 8, actionsPerHour: null, weightedPerHour: null, pointsPerHour: null } });
  it("'entre' é inclusivo, aceita os valores trocados e com vírgula", () => {
    expect(ruleHolds(r, { field: "hours", op: "between", value: "7,5", value2: 8 })).toBe(true);
    expect(ruleHolds(r, { field: "hours", op: "between", value: 8, value2: "7,5" })).toBe(true);
    expect(ruleHolds(r, { field: "hours", op: "between", value: 7.6, value2: 8 })).toBe(false);
  });
  it("'entre' sem o 2.º valor filtra como ≥ — e o chip/CSV dizem-no", () => {
    expect(ruleHolds(r, { field: "cost", op: "between", value: 80 })).toBe(true);
    expect(evalRuleText({ field: "cost", op: "between", value: 80, value2: null })).toBe("Custo (€) ≥ 80");
    expect(evalRuleText({ field: "cost", op: "between", value: 80, value2: 100 })).toBe("Custo (€) entre 80 e 100");
  });
  it("pontos negativos: ≤, 'tem' (≠ 0) e 'Pontos perdidos' em positivo", () => {
    expect(ruleHolds(r, { field: "points", op: "lte", value: "-100" })).toBe(true);
    expect(ruleHolds(r, { field: "points", op: "has" })).toBe(true);
    expect(ruleHolds(r, { field: "negativePoints", op: "gte", value: 200 })).toBe(true);
  });
  it("unidades: horas do ponto (não as da escala) e custo em euros", () => {
    expect(ruleHolds(semHoras, { field: "hours", op: "not_has" })).toBe(true); // 8 h escaladas não contam como horas do ponto
    expect(ruleHolds(r, { field: "cost", op: "eq", value: "87,25" })).toBe(true);
    expect(ruleHolds(r, { field: "cost", op: "eq", value: 87.2 })).toBe(false);
  });
  it("por hora sem horas (nulo): não cumpre ≥ nem ≤ nem 'entre'; cumpre 'não tem'", () => {
    for (const op of ["gte", "lte", "eq"] as const) expect(ruleHolds(semHoras, { field: "actionsPerHour", op, value: 0 }), op).toBe(false);
    expect(ruleHolds(semHoras, { field: "actionsPerHour", op: "between", value: 0, value2: 100 })).toBe(false);
    expect(ruleHolds(semHoras, { field: "actionsPerHour", op: "not_has" })).toBe(true);
  });
});

describe("totais, 'Melhor' e posição com o filtro", () => {
  const rows = [row(1, "Ana", { pts: 900 }), row(2, "Bruno", { pts: 500, m: { speedingEvents: 1 } }), row(3, "Carla", { pts: 500, m: { speedingEvents: 2 } })];
  it("o 'Melhor' é o 1.º do filtro (empate: a ordem do ranking) e os totais só somam o que se vê", () => {
    const shown = filterRanking(rows, { groups: { flags: ["speeding"] } });
    const t = rankingTotals(shown);
    expect(t.best?.employeeName).toBe("Bruno");
    expect([t.people, t.points, t.hours, t.actions, t.cost]).toEqual([2, 1000, 160, 200, 1000]);
  });
});

// ─── 4. Âmbito: o ranking, as facetas e a folha ────────────────────────────

function evalDay(employeeId: number, name: string, day: string, o: { city?: string | null; shift?: string | null; tl?: boolean } = {}) {
  const metrics = { ...emptyDayMetrics(), actions: 3 };
  return { employeeId, employeeName: name, position: "driver", day, city: o.city ?? null, shift: o.shift ?? null, isTeamLeader: !!o.tl, metrics, base: metrics, score: scoreOf(metrics), perHour: perHourMetrics(metrics), adjustments: [] };
}
const range = { from: "2026-10-01", to: "2026-10-14" };

describe("âmbito: o team leader só vê (e só lê as facetas de) a sua equipa", () => {
  beforeEach(() => {
    state.days = [
      evalDay(8, "Ana da Equipa", "2026-10-02", { city: "porto", shift: "morning" }),
      evalDay(9, "Bruno de Outra Equipa", "2026-10-02", { city: "porto", shift: "morning" }),
      evalDay(31, "Zé TL", "2026-10-02", { city: "porto", shift: "morning", tl: true }),
    ];
    state.handler = (s) => {
      if (s.startsWith("SELECT e.id FROM employees e")) return [{ id: 8 }];
      if (s.includes("FROM employees WHERE id IN")) return [{ id: 8, projectId: null, multiparkAgentName: "ana", multiparkAgentUserId: "77" }];
      if (s.includes("employee_day_metrics")) return [{ employeeId: 31, fullName: "Zé TL", day: "2026-10-02", city: "porto", shift: "morning" }];
      return [];
    };
  });
  it("as linhas e as leituras das facetas são só da equipa; os dias de TL só dão nome à equipa", async () => {
    const rows = await caller("team_leader").evaluation.ranking(range);
    expect(rows.map((r) => r.employeeId)).toEqual([8]);
    expect(rows[0].teamLeader).toEqual({ id: 31, name: "Zé TL" });
    const facetReads = state.seen.filter((q) => q.sql.includes("WHERE id IN") || q.sql.includes("WHERE employeeId IN"));
    expect(facetReads.length).toBe(2);
    for (const q of facetReads) expect(q.params).toEqual([8]);
  });
  it("número fixo de leituras (sem N+1): o mesmo com 1 ou 60 pessoas", async () => {
    const count = async (n: number) => {
      state.days = Array.from({ length: n }, (_, i) => evalDay(100 + i, `P${i}`, "2026-10-02", { city: "porto", shift: "morning" }));
      state.seen = [];
      await caller("supervisor").evaluation.ranking(range);
      return state.seen.length;
    };
    expect(await count(60)).toBe(await count(1));
    expect(await count(60)).toBeLessThanOrEqual(4);
  });
  it("as facetas nunca leem a BD da Multipark", () => {
    const f = src("server/evaluationRankingFacets.ts");
    expect(f).not.toMatch(/multiparkDb|getMultiparkPool|multiparkQuery/);
  });
});

describe("âmbito de cidade: a cidade/marca do topo não abre outra cidade (ecrã e folha)", () => {
  it("supervisor de Lisboa a pedir o projeto do Porto: recusado no ranking e na exportação", async () => {
    access.current = { all: false, defaultCityId: 1, cityName: "Lisboa", cityNames: ["Lisboa"], cityIds: [1], projectIds: [1, 10, 11], missingCostCenter: false };
    await expect(caller("supervisor").evaluation.ranking({ ...range, projectId: 10 })).resolves.toEqual([]); // o seu: abre
    await expect(caller("supervisor").evaluation.ranking({ ...range, projectId: 20 })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/não pertence à cidade/) });
    await expect(caller("supervisor").googleDrive.sheets.export({ report: "avaliacoes", from: range.from, to: range.to, projectId: 20, filter: { text: "ana" } }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/não pertence à cidade/) });
  });
});

describe("Sheets: o filtro do cliente só tira linhas e tem limites", () => {
  const all = [row(1, "Ana", { pts: 900, cities: ["porto"] }), row(2, "Bruno", { pts: 100, cities: ["lisbon"] }), row(3, "Carla", { pts: 50, cities: ["faro"] })];
  const exportRows = async (filter: EvalFilterView) => {
    const input = sheetExportInputSchema.parse({ report: "avaliacoes", from: "2026-10-01", to: "2026-10-31", filter });
    const tabs = await SHEET_REPORTS.avaliacoes.load(async () => all, input, Date.now() + 60_000);
    return tabs[0].rows.slice(1).map((r) => r[0]);
  };
  it("qualquer filtro dá um subconjunto do que o procedimento devolveu (nunca acrescenta)", async () => {
    const names = all.map((r) => r.employeeName);
    const filters: EvalFilterView[] = [
      { rules: { match: "any", items: [{ field: "points", op: "gte", value: -1e9 }, { field: "inventado", op: "gte", value: 0 }] } },
      { groups: { city: ["porto", "madrid", "' OR 1=1 --"] } },
      { searches: [{ field: "name", text: "%" }] },
      { rules: { match: "all", items: [{ field: "__proto__", op: "has" }] } },
    ];
    for (const f of filters) for (const n of await exportRows(f)) expect(names).toContain(n);
    expect(await exportRows({ groups: { city: ["' OR 1=1 --"] } })).toEqual([]);
  });
  it("acima dos limites o pedido é recusado (zod)", () => {
    const base = { report: "avaliacoes", from: "2026-10-01", to: "2026-10-31" };
    const bad: unknown[] = [
      { searches: Array.from({ length: 21 }, () => ({ field: "name", text: "a" })) },
      { text: "x".repeat(201) },
      { rules: { match: "all", items: Array.from({ length: 21 }, () => ({ field: "points", op: "gte", value: 1 })) } },
      { rules: { match: "all", items: [{ field: "points", op: "drop table", value: 1 }] } },
      { groups: { team: Array.from({ length: 201 }, (_, i) => String(i)) } },
      { groups: { flags: ["inventado"] } },
      { rules: { match: "all", items: [{ field: "points", op: "gte", value: "9".repeat(41) }] } },
    ];
    for (const filter of bad) expect(sheetExportInputSchema.safeParse({ ...base, filter }).success, JSON.stringify(filter).slice(0, 60)).toBe(false);
    expect(evalFilterViewSchema.safeParse({ text: "x".repeat(200) }).success).toBe(true);
  });
});

// ─── 5. "O meu perfil": no computador, sem repetir no telemóvel ─────────────

describe("'O meu perfil' no menu da fotografia", () => {
  const layout = src("client/src/components/DashboardLayout.tsx");
  it("aparece uma vez no menu, só a partir de md (no telemóvel a barra de baixo já tem o Perfil)", () => {
    const start = layout.indexOf('aria-label="Menu da conta"');
    const menu = layout.slice(start, layout.indexOf("</DropdownMenuContent>", start));
    expect(menu.match(/O meu perfil/g)).toHaveLength(1);
    expect(menu).toContain('className="hidden cursor-pointer md:flex"');
    expect(src("client/src/components/MobileTabBar.tsx")).toContain('className="md:hidden fixed bottom-0');
  });
});
