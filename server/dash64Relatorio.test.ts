/**
 * Plano 64, PR H — o relatório semanal de operações (o email de segunda)
 * pelas MESMAS contas dos dashboards:
 *  - Entradas / saídas: liveOpsBookingStats (todos os parques, as compras por
 *    pagar contam, as canceladas não) → checkinPeriodo / checkoutPeriodo;
 *  - Reclamações novas: countableComplaintSql (Suporte, Resumo do dia);
 *  - Fora do prazo: complaintSlaLateSql no fim da semana (cartão e briefing);
 *  - Ocorrências novas: getMultiparkOccurrenceStats com os filtros da página
 *    (occurrenceFiltersFor) — a tabela antiga `incidents` já não é lida.
 * Se a BD da Multipark falhar, a métrica vai como "—" com uma nota (nunca 0).
 * Leitores falsos: a BD da Multipark (multiparkDbQuery) e a nossa (getDb).
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const h = vi.hoisted(() => ({
  /** Leitor falso da BD da Multipark (null = falha a ligar). */
  mp: null as null | ((sql: string, params: unknown[]) => Promise<unknown[]>),
  mpCalls: [] as Array<{ sql: string; params: unknown[] }>,
  /** O que a nossa BD (MySQL) recebeu. */
  executed: [] as Array<{ sql: string; params: unknown[] }>,
  excluded: ["pX"] as string[] | null,
  /** Os filtros que cada leitura das Ocorrências recebeu. */
  occStats: [] as any[],
  occList: [] as any[],
}));

const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [10, 20], projectIds: [1, 10, 20], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  getProjects: async () => [
    { id: 1, level: "group", name: "Multipark", parentId: null, isActive: 1 },
    { id: 10, level: "city", name: "Lisboa", parentId: 1, isActive: 1 },
    { id: 20, level: "city", name: "Porto", parentId: 1, isActive: 1 },
  ],
  resolveProjectIds: async (id: number) => [id],
  getDb: async () => ({
    execute: async (q: unknown) => {
      const r = new MySqlDialect().sqlToQuery(q as any);
      h.executed.push(r);
      if (/FROM complaints/.test(r.sql) && /createdAt >=/.test(r.sql)) return [[{ n: 6 }], []];
      if (/FROM complaints/.test(r.sql)) return [[{ n: 2 }], []];
      if (/FROM shift_handovers/.test(r.sql)) return [[{ n: 9 }], []];
      if (/FROM \(SELECT DISTINCT assignmentDate/.test(r.sql)) return [[{ n: 12 }], []];
      return [[], []];
    },
  }),
}));
vi.mock("./multiparkDb/client", async (original) => {
  const real = await original<typeof import("./multiparkDb/client")>();
  return {
    ...real,
    multiparkDbQuery: async (sql: string, params: unknown[] = []) => {
      h.mpCalls.push({ sql, params });
      if (!h.mp) throw new real.MultiparkDbError("connect ECONNREFUSED 10.0.0.1:5432", "CONNECT_FAILED");
      return h.mp(sql, params);
    },
  };
});
vi.mock("./appSettings", async (original) => ({
  ...(await original<object>()),
  getSetting: async (key: string) => (key === "operations.excludedParks" ? h.excluded : null),
}));
// Regista o que cada leitura das Ocorrências recebe (e lê na mesma pelo leitor falso).
vi.mock("./multiparkDb/read", async (original) => {
  const real = await original<typeof import("./multiparkDb/read")>();
  return {
    ...real,
    getMultiparkOccurrenceStats: async (f: any, q?: any) => { h.occStats.push(f); return real.getMultiparkOccurrenceStats(f, q); },
    listMultiparkOccurrences: async (f: any, q?: any) => { h.occList.push(f); return real.listMultiparkOccurrences(f, q); },
  };
});

import { appRouter } from "./routers";
import { buildWeeklyReportData, fmtMetric, renderWeeklyEmail, unreadNote, weeklyFallback, weeklyFacts, type WeeklyReportData } from "./aiOps/weeklyReports";
import { occurrenceFiltersFor } from "./multiparkDb/occurrenceScope";
import { occurrenceAutoCloseCutoff } from "../shared/occurrenceAutoClose";
import { complaintSlaLateSql, countableComplaintSql } from "./departedComplaints";
import { liveOpsBookingStats, resetOpsCountsCache } from "./opsStatsLive";
import { opsEventStatuses, resetScopeParksCache, statusSqlLiteral } from "./multiparkDb/opsEvents";
import { lisbonDayRangeUtc } from "../shared/lisbonDay";
import { cityScope } from "./cityScope";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const render = (q: unknown) => new MySqlDialect().sqlToQuery(q as any);
const caller = (role: string) => appRouter.createCaller({ user: { id: 77, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const ENV = "DATABASE_URL_MULTIPARK";
/** Segunda, 19 out 2026, 08:00 de Lisboa: o relatório da semana 12–18 out (antes: 5–11 out). */
const NOW = Date.parse("2026-10-19T07:00:00Z");
const MONDAY = "2026-10-19";
const CUR = { from: "2026-10-12", to: "2026-10-18" };
const PREV = { from: "2026-10-05", to: "2026-10-11" };

const PARK_ROWS = [
  { id: "pA", name: "Airpark", city: "Lisboa" }, // nosso
  { id: "pB", name: "Boardingpark", city: "Prior Velho" }, // terceiro operado
  { id: "pT", name: "Top Parking", city: "Lisboa" }, // terceiro NÃO operado (lista por nome)
  { id: "pX", name: "Parque Excluído", city: "Lisboa" }, // excluído nas Definições
  { id: "pP", name: "Redpark", city: "Porto" }, // nosso (Porto)
  { id: "pM", name: "Porto Parking Plus", city: "Oporto" }, // terceiro (Porto)
];

/** Contagens (acontecimento × dia × parque) como o SQL de opsCounts as devolve. */
const row = (event: string, day: string, park_id: string, n: number) => ({ event, day, park_id, n, revenue: n * 50 });
const COUNT_ROWS = [
  // semana 12–18: entradas 2+3+1+4+0+5+2 = 17 (em parques nossos e do Marketplace); saídas 3+3 = 6
  row("checkin", "2026-10-12", "pA", 2), row("checkin", "2026-10-13", "pB", 3), row("checkin", "2026-10-14", "pT", 1),
  row("checkin", "2026-10-15", "pA", 4), row("checkin", "2026-10-17", "pM", 5), row("checkin", "2026-10-18", "pP", 2),
  row("checkout", "2026-10-13", "pA", 3), row("checkout", "2026-10-18", "pB", 3),
  // semana anterior: entradas 7, saídas 2
  row("checkin", "2026-10-05", "pA", 4), row("checkin", "2026-10-11", "pB", 3), row("checkout", "2026-10-09", "pT", 2),
  // fora das duas semanas (dia 1 e hoje): não contam
  row("checkin", "2026-10-01", "pA", 40), row("checkin", "2026-10-19", "pA", 30), row("checkout", "2026-10-19", "pA", 20),
  // criadas e canceladas não são entradas
  row("created", "2026-10-14", "pA", 9), row("cancelled", "2026-10-14", "pA", 8),
];

/** A BD da Multipark a responder: parques, contagens e ocorrências (7 na semana, 4 na anterior). */
const healthy = async (sql: string, params: unknown[]) => {
  if (sql.includes(`FROM "Park" p`)) return PARK_ROWS;
  if (sql.includes("AS revenue")) return COUNT_ROWS;
  if (sql.includes(`"Occurrence" o`) && sql.includes("count(*) AS total")) {
    // o 1.º parâmetro é o início do período (dia 12 às 00h de Lisboa = 11 às 23h UTC)
    return [{ total: params[0] === "2026-10-11 23:00:00" ? 7 : 4, open: 1, auto_closed: 0, resolved: 3 }];
  }
  return [];
};

const metric = (d: WeeklyReportData, label: RegExp) => d.metrics.find((m) => label.test(m.label))!;

let savedEnv: string | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  savedEnv = process.env[ENV];
  process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
  h.mp = healthy; h.mpCalls = []; h.executed = []; h.excluded = ["pX"]; h.occStats = []; h.occList = [];
  resetScopeParksCache(); resetOpsCountsCache();
});
afterEach(() => {
  vi.useRealTimers();
  if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv;
});

describe("H1 — Entradas e saídas: a função única das contagens dos dashboards", () => {
  it("as entradas = a soma das contagens de entrada dos 7 dias (todos os parques); as saídas idem", async () => {
    const d = await buildWeeklyReportData("operacoes", MONDAY);
    expect(d.range).toEqual(CUR);
    expect(d.prevRange).toEqual(PREV);
    const sum = (e: string, r: { from: string; to: string }) =>
      COUNT_ROWS.filter((x) => x.event === e && x.day >= r.from && x.day <= r.to).reduce((t, x) => t + x.n, 0);
    expect(metric(d, /^Entradas/)).toMatchObject({ value: sum("checkin", CUR), prev: sum("checkin", PREV) });
    expect(metric(d, /^Entradas/).value).toBe(17);
    expect(metric(d, /^Saídas/)).toMatchObject({ value: 6, prev: 2 });
    // o mesmo número que o painel dá para o mesmo período (Geral / Operações)
    resetOpsCountsCache();
    const s = await liveOpsBookingStats({ from: CUR.from, to: CUR.to });
    expect([s.checkinPeriodo, s.checkoutPeriodo]).toEqual([17, 6]);
    expect(d.notes).toEqual([]);
  });

  it("todos os parques (nossos e todo o Marketplace, de todas as cidades — o cron não tem utilizador), as compras por pagar contam, as canceladas não", async () => {
    await buildWeeklyReportData("operacoes", MONDAY);
    const counts = h.mpCalls.filter((c) => c.sql.includes("AS revenue"));
    // as duas semanas cabem na mesma leitura (o painel lê do dia 1 do mês até hoje): 1 só leitura
    expect(counts).toHaveLength(1);
    for (const id of ["pA", "pB", "pT", "pX", "pP", "pM"]) expect(counts[0].params).toContain(id);
    expect(counts[0].sql).toContain(statusSqlLiteral(opsEventStatuses("checkin", { includePending: true })));
    expect(counts[0].sql).not.toContain("PENDING");
    expect(opsEventStatuses("checkin", { includePending: true }).exclude).toContain("CANCELLED");
  });

  it("os rótulos dizem 'todos os parques'; já não lê a cópia dos parques nossos (loadLiveBookingAgg)", async () => {
    const d = await buildWeeklyReportData("operacoes", MONDAY);
    expect(d.metrics.map((m) => m.label)).toEqual(expect.arrayContaining(["Entradas (check-in) · todos os parques", "Saídas (check-out) · todos os parques"]));
    const w = src("server/aiOps/weeklyReports.ts");
    expect(w).toContain("liveOpsBookingStats({ from: r.from, to: r.to })");
    expect(w).toContain("s.checkinPeriodo, outs: s.checkoutPeriodo");
    expect(w).not.toContain("loadLiveBookingAgg");
    expect(w).not.toContain("checkin_any");
  });
});

describe("H1 — a Multipark falha → \"—\" com uma nota, nunca 0", () => {
  it("sem ligação: entradas, saídas e ocorrências vão como \"—\" (null); as da nossa BD ficam", async () => {
    h.mp = null;
    const d = await buildWeeklyReportData("operacoes", MONDAY);
    for (const re of [/^Entradas/, /^Saídas/, /^Ocorrências novas/]) {
      expect(metric(d, re)).toMatchObject({ value: null, prev: null });
    }
    expect(metric(d, /^Reclamações novas/)).toMatchObject({ value: 6, prev: 6 });
    expect(d.notes).toEqual([
      'Entradas e saídas por contar ("—", não é 0): Sem ligação à BD da Multipark neste momento.',
      'Ocorrências por contar ("—", não é 0): Sem ligação à BD da Multipark neste momento.',
    ]);
    const mail = renderWeeklyEmail(d, weeklyFallback(d), "https://app");
    const lines = mail.text.split("\n");
    expect(lines).toContain("Entradas (check-in) · todos os parques: —");
    expect(lines).toContain("Ocorrências novas: —");
    expect(mail.html).toContain("por contar");
    expect(mail.text).not.toMatch(/Entradas \(check-in\) · todos os parques: 0/);
    // a IA recebe a nota (não inventa um zero)
    expect(weeklyFacts(d)).toContain("Entradas e saídas por contar");
  });

  it("sem a ligação configurada: o mesmo \"—\" (a falha nunca vira 0)", async () => {
    delete process.env[ENV];
    h.mp = null;
    const d = await buildWeeklyReportData("operacoes", MONDAY);
    expect(metric(d, /^Ocorrências novas/).value).toBeNull();
    expect(metric(d, /^Entradas/).value).toBeNull();
    expect(d.notes.join(" ")).toContain("não está configurada");
  });

  it("contagens cortadas no teto (leitura incompleta) → \"—\", não um número a menos", async () => {
    const many = Array.from({ length: 50_000 }, (_, i) => row("checkin", "2026-10-12", `p${i}`, 1));
    h.mp = async (sql, params) => (sql.includes("AS revenue") ? many : healthy(sql, params));
    const d = await buildWeeklyReportData("operacoes", MONDAY);
    expect(metric(d, /^Entradas/).value).toBeNull();
    expect(d.notes[0]).toBe('Entradas e saídas por contar ("—", não é 0): A leitura veio incompleta (demasiadas linhas).');
    expect(metric(d, /^Ocorrências novas/).value).toBe(7);
  });

  it("nota única por métrica, com os motivos sem repetir; sem falhas não há nota", () => {
    const fail = { ok: false as const, reason: "Sem ligação." };
    expect(unreadNote("Ocorrências", [fail, fail])).toEqual(['Ocorrências por contar ("—", não é 0): Sem ligação.']);
    expect(unreadNote("Ocorrências", [{ ok: true, value: 3 }, { ok: true, value: 0 }])).toEqual([]);
    expect(fmtMetric(null, "n")).toBe("—");
  });
});

describe("H1 — Ocorrências: as da página Ocorrências, pelos mesmos filtros; a tabela `incidents` não é lida", () => {
  it("a tabela antiga `incidents` não é lida (nem no código)", async () => {
    await buildWeeklyReportData("operacoes", MONDAY);
    expect(h.executed.some((q) => /\bincidents\b/.test(q.sql))).toBe(false);
    expect(src("server/aiOps/weeklyReports.ts")).not.toMatch(/FROM incidents/);
  });

  it("ocorrências novas = o total da página para a semana (as criadas, por dia de Lisboa)", async () => {
    const d = await buildWeeklyReportData("operacoes", MONDAY);
    expect(metric(d, /^Ocorrências novas/)).toMatchObject({ value: 7, prev: 4 });
    expect(h.occStats.map((f) => [f.dateFrom, f.dateTo])).toEqual([[CUR.from, CUR.to], [PREV.from, PREV.to]]);
    // sem estado: o total conta todas as criadas (o fecho automático só separa as abertas)
    expect(h.occStats.every((f) => f.status === undefined && f.resolved === undefined)).toBe(true);
  });

  it("o ajudante dá os MESMOS filtros à página e ao relatório; a rota continua a mandar excludedParkIds e autoCloseBefore", async () => {
    await caller("admin").incidents.multipark({});
    const page = { list: h.occList[0], stats: h.occStats[0] };
    h.occStats = [];
    await buildWeeklyReportData("operacoes", MONDAY);
    const report = h.occStats[0];
    const scope = await occurrenceFiltersFor(NOW, undefined);
    // Definições ("pX") + os não operados pelo nome ("Top Parking")
    expect(scope).toEqual({ autoCloseBefore: occurrenceAutoCloseCutoff(NOW), cities: undefined, excludedParkIds: ["pX", "pT"] });
    for (const f of [page.list, page.stats, report]) {
      expect(f).toMatchObject({ autoCloseBefore: scope.autoCloseBefore, excludedParkIds: scope.excludedParkIds });
      expect(f.cities).toBeUndefined();
    }
    // e chegam ao SQL das duas (o parque excluído e o corte vão nos parâmetros)
    const occSql = h.mpCalls.filter((c) => c.sql.includes(`"Occurrence" o`) && c.sql.includes("count(*) AS total"));
    expect(occSql.length).toBeGreaterThanOrEqual(2);
    for (const c of occSql) {
      expect(c.sql).toContain(`o."parkId" NOT IN`);
      expect(c.params).toEqual(expect.arrayContaining(["pX", "pT", scope.autoCloseBefore]));
    }
  });

  it("com uma cidade no âmbito, o ajudante passa as cidades tal como a página as recebe", async () => {
    const lisboa = { all: false, defaultCityId: 10, cityName: "Lisboa", cityNames: ["Lisboa"], cityIds: [10], projectIds: [10], missingCostCenter: false };
    await cityScope.run(lisboa as any, () => buildWeeklyReportData("operacoes", MONDAY));
    expect(h.occStats[0].cities).toEqual(["Lisboa"]);
    expect((await occurrenceFiltersFor(NOW, ["Lisboa"])).cities).toEqual(["Lisboa"]);
  });

  it("a rota e o relatório chamam o mesmo ajudante (texto)", () => {
    const r = src("server/routers.ts");
    const block = r.split("multipark: protectedProcedure.input(z.object({\n      projectId")[1].split("parksHandled:")[0];
    expect(block).toContain('await import("./multiparkDb/occurrenceScope")');
    expect(block).toContain("...(await occurrenceFiltersFor(now, scopedCityNames()))");
    expect(block).not.toContain("getNotOperatedParkIds");
    const w = src("server/aiOps/weeklyReports.ts");
    expect(w).toContain("occurrenceFiltersFor(Date.now(), scopedCityNamesLive())");
    expect(w).toContain("getMultiparkOccurrenceStats({ ...scope, dateFrom: r.from, dateTo: r.to })");
  });
});

describe("H1 — Reclamações: a mesma condição do Suporte e do Resumo do dia", () => {
  it("novas: só as que contam (countableComplaintSql), criadas na semana (00h–24h de Lisboa)", async () => {
    await buildWeeklyReportData("operacoes", MONDAY);
    const countable = render(countableComplaintSql("complaints")).sql;
    const created = h.executed.filter((q) => /FROM complaints/.test(q.sql) && /createdAt >=/.test(q.sql));
    expect(created).toHaveLength(2);
    for (const q of created) expect(q.sql).toContain(countable);
    const u = lisbonDayRangeUtc(CUR.from, CUR.to);
    expect(created[0].params).toEqual([u.start, u.end]);
    // a mesma condição que o Resumo do dia usa
    expect(src("server/supervisorDay.ts")).toContain('AND ${countableComplaintSql("complaints")}');
  });

  it("fora do prazo no fim da semana: complaintSlaLateSql (só o slaDeadline, sem 'Aguarda cliente' nem o dueDate), como o briefing", async () => {
    const d = await buildWeeklyReportData("operacoes", MONDAY);
    const late = h.executed.filter((q) => /FROM complaints/.test(q.sql) && !/createdAt >=/.test(q.sql));
    expect(late).toHaveLength(2);
    const ref = render(complaintSlaLateSql("complaints", lisbonDayRangeUtc(CUR.from, CUR.to).end));
    expect(late[0].sql).toContain(render(countableComplaintSql("complaints")).sql);
    expect(late[0].sql).toContain(ref.sql);
    expect(late[0].params).toEqual(ref.params);
    expect(late[1].params[0]).toBe(lisbonDayRangeUtc(PREV.from, PREV.to).end);
    for (const q of late) {
      expect(q.sql).not.toContain("dueDate");
      expect(q.params).not.toContain("waiting_client");
    }
    expect(metric(d, /fora do prazo/)).toMatchObject({ value: 2, prev: 2 });
    expect(src("server/aiOps/briefing.ts")).toContain('${countableComplaintSql("complaints")} AND ${complaintSlaLateSql("complaints", end)}');
  });

  it("as passagens de turno não mudam", async () => {
    const d = await buildWeeklyReportData("operacoes", MONDAY);
    expect(metric(d, /^Passagens de turno/)).toMatchObject({ value: 0.75, prev: 0.75, unit: "pct" });
  });
});
