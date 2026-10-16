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
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  /** O âmbito de cidades de quem pede (null = nacional). */
  access: null as any,
  /** A definição "Parques que a operação não faz" falha a ler. */
  settingThrows: false,
  /** Só a leitura da tabela "Park" falha (a lista dos não operados fica vazia). */
  parksFail: false,
  /** Corre no MESMO contexto do pedido, quando a rota lê a lista (o teste "igual"). */
  onList: null as null | (() => Promise<void>),
}));

const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [10, 20], projectIds: [1, 10, 20], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => h.access ?? national,
  loadCityAccessParts: async () => ({ access: h.access ?? national, base: h.access ?? national, all: national }),
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
      if (h.parksFail && sql.includes(`FROM "Park" p`)) throw new real.MultiparkDbError("canceling statement due to statement timeout", "QUERY_FAILED");
      return h.mp(sql, params);
    },
  };
});
vi.mock("./appSettings", async (original) => ({
  ...(await original<object>()),
  getSetting: async (key: string) => {
    if (key !== "operations.excludedParks") return null;
    if (h.settingThrows) throw new Error("BD do dashboard sem resposta");
    return h.excluded;
  },
}));
// Regista o que cada leitura das Ocorrências recebe (e lê na mesma pelo leitor falso).
vi.mock("./multiparkDb/read", async (original) => {
  const real = await original<typeof import("./multiparkDb/read")>();
  return {
    ...real,
    getMultiparkOccurrenceStats: async (f: any, q?: any) => { h.occStats.push(f); return real.getMultiparkOccurrenceStats(f, q); },
    listMultiparkOccurrences: async (f: any, q?: any) => { h.occList.push(f); await h.onList?.(); return real.listMultiparkOccurrences(f, q); },
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
import { lisbonClockOf } from "./aiOps/cron";

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
  h.access = null; h.settingThrows = false; h.parksFail = false; h.onList = null;
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

  it("nota única por métrica, com os motivos sem repetir e a semana que falhou; sem falhas não há nota", () => {
    const fail = { ok: false as const, reason: "Sem ligação." };
    const ok = { ok: true as const, value: 3 };
    expect(unreadNote("Ocorrências", fail, fail)).toEqual(['Ocorrências por contar ("—", não é 0): Sem ligação.']);
    expect(unreadNote("Ocorrências", fail, { ok: false, reason: "Demorou." })).toEqual(['Ocorrências por contar ("—", não é 0): Sem ligação. Demorou.']);
    // só uma das semanas: a nota diz qual (o número da outra está lá)
    expect(unreadNote("Ocorrências", fail, ok)).toEqual(['Ocorrências da semana por contar ("—", não é 0): Sem ligação.']);
    expect(unreadNote("Ocorrências", ok, fail)).toEqual(['Ocorrências da semana anterior por contar ("—", não é 0): Sem ligação.']);
    expect(unreadNote("Ocorrências", ok, { ok: true, value: 0 })).toEqual([]);
    expect(fmtMetric(null, "n")).toBe("—");
  });

  it("a Multipark falha só na semana anterior: a semana leva o número, a anterior \"—\" e a nota diz qual", async () => {
    // a 1.ª leitura das contagens (as duas semanas partilham-na) responde; as ocorrências da anterior falham
    h.mp = async (sql, params) => {
      if (sql.includes(`"Occurrence" o`) && params[0] !== "2026-10-11 23:00:00") throw new Error("connection terminated unexpectedly");
      return healthy(sql, params);
    };
    const d = await buildWeeklyReportData("operacoes", MONDAY);
    expect(metric(d, /^Ocorrências novas/)).toMatchObject({ value: 7, prev: null });
    expect(metric(d, /^Entradas/)).toMatchObject({ value: 17, prev: 7 });
    expect(d.notes).toEqual(['Ocorrências da semana anterior por contar ("—", não é 0): Não foi possível ler a BD da Multipark neste momento.']);
    const mail = renderWeeklyEmail(d, weeklyFallback(d), "https://app");
    expect(mail.text.split("\n")).toContain("Ocorrências novas: 7");
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

// ─── Teste "igual": a página Ocorrências manda os MESMOS filtros que antes do H ─

/**
 * As linhas do filtro do `incidents.multipark` ANTES do H, tal e qual
 * (server/routers.ts:3364-3377 em 5b535f94 = origin/main de 15 out = 38872eee).
 */
const OLD_ROUTE_LINES = [
  `const { projectId: _p, limit, offset, resolved, status: statusIn, ...filters } = input ?? {};`,
  `const status = statusIn ?? (resolved === true ? "resolved" as const : resolved === false ? "open" as const : undefined);`,
  `const now = Date.now();`,
  `const settingIds = (await getSetting("operations.excludedParks").catch(() => null)) ?? [];`,
  `const excludedParkIds = [...new Set([...settingIds, ...(await getNotOperatedParkIds())])];`,
  `const f = { ...filters, status, autoCloseBefore: occurrenceAutoCloseCutoff(now), cities: scopedCityNames(), excludedParkIds };`,
  `const list = await listMultiparkOccurrences({ ...f, limit, offset });`,
  `const stats = await getMultiparkOccurrenceStats(f);`,
];

/** O código antigo de cima, transcrito (só sem os tipos), a correr no contexto do pedido. */
async function oldOccurrenceFilters(input: any): Promise<{ list: any; stats: any }> {
  const { getSetting } = await import("./appSettings");
  const { getNotOperatedParkIds } = await import("./multiparkDb/dayBookings");
  const { occurrenceAutoCloseCutoff } = await import("../shared/occurrenceAutoClose");
  // server/routers.ts:417-421 (scopedCityNames), igual antes e depois
  const scopedCityNames = (): string[] | undefined => {
    const a = cityScope.getStore();
    if (!a || a.all) return undefined;
    return a.cityNames ?? (a.cityName ? [a.cityName] : []);
  };
  const { projectId: _p, limit, offset, resolved, status: statusIn, ...filters } = input ?? {};
  const status = statusIn ?? (resolved === true ? "resolved" as const : resolved === false ? "open" as const : undefined);
  const now = Date.now();
  const settingIds = (await getSetting("operations.excludedParks").catch(() => null)) ?? [];
  const excludedParkIds = [...new Set([...settingIds, ...(await getNotOperatedParkIds())])];
  const f = { ...filters, status, autoCloseBefore: occurrenceAutoCloseCutoff(now), cities: scopedCityNames(), excludedParkIds };
  return { list: { ...f, limit, offset }, stats: f };
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OLD_ROUTERS = (() => {
  try {
    return execFileSync("git", ["show", "5b535f94:server/routers.ts"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; } // sem o histórico (CI com clone raso): a cópia de cima vale na mesma
})();

const LISBOA = { all: false, defaultCityId: 10, cityName: "Lisboa", cityNames: ["Lisboa"], cityIds: [10], projectIds: [10], missingCostCenter: false };
const PORTO = { all: false, defaultCityId: 20, cityName: "Porto", cityNames: ["Porto"], cityIds: [20], projectIds: [20], missingCostCenter: false };
const DUAS = { all: false, defaultCityId: 10, cityName: "Lisboa", cityNames: ["Lisboa", "Porto"], cityIds: [10, 20], projectIds: [10, 20], missingCostCenter: false };
const NENHUMA = { all: false, defaultCityId: 10, cityName: "Lisboa", cityNames: [] as string[], cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false };

describe("H1 — teste \"igual\": a página Ocorrências manda os MESMOS filtros que antes do H", () => {
  it.runIf(OLD_ROUTERS !== null)("a cópia de cima é o código antigo (git show 5b535f94:server/routers.ts)", () => {
    const block = OLD_ROUTERS!.split("multipark: protectedProcedure.input(z.object({\n      projectId")[1].split("parksHandled:")[0];
    for (const line of OLD_ROUTE_LINES) expect(block).toContain(line);
    // a rota de agora já não tem o filtro (vem do ajudante) e não mudou o resto
    const now = src("server/routers.ts").split("multipark: protectedProcedure.input(z.object({\n      projectId")[1].split("parksHandled:")[0];
    for (const line of [OLD_ROUTE_LINES[0], OLD_ROUTE_LINES[1], OLD_ROUTE_LINES[2], OLD_ROUTE_LINES[6], OLD_ROUTE_LINES[7]]) expect(now).toContain(line);
    for (const line of OLD_ROUTE_LINES.slice(3, 6)) expect(now).not.toContain(line);
  });

  const run = async (role: string, access: any, input: any) => {
    h.access = access;
    h.occList = []; h.occStats = [];
    let ref: { list: any; stats: any } | null = null;
    // a referência corre DENTRO do pedido (o mesmo âmbito de cidades e o mesmo instante)
    h.onList = async () => { ref = await oldOccurrenceFilters(input); };
    const out = await caller(role).incidents.multipark(input);
    expect(out.available).toBe(true);
    expect(h.occList).toHaveLength(1);
    expect(h.occStats).toHaveLength(1);
    expect(ref).not.toBeNull();
    // igual: os mesmos campos, pela mesma ordem, com os mesmos valores (undefined incluído)
    expect(h.occList[0]).toStrictEqual(ref!.list);
    expect(Object.keys(h.occList[0])).toEqual(Object.keys(ref!.list));
    expect(h.occStats[0]).toStrictEqual(ref!.stats);
    expect(Object.keys(h.occStats[0])).toEqual(Object.keys(ref!.stats));
    return { list: h.occList[0], stats: h.occStats[0] };
  };

  const WHO: Array<{ who: string; role: string; access: any; projectId?: number; cities: string[] | undefined }> = [
    { who: "admin nacional", role: "admin", access: null, cities: undefined },
    { who: "super admin nacional", role: "super_admin", access: null, cities: undefined },
    { who: "backoffice nacional", role: "backoffice", access: null, cities: undefined },
    { who: "admin com Lisboa no topo", role: "admin", access: null, projectId: 10, cities: ["Lisboa"] },
    { who: "admin com Porto no topo", role: "admin", access: null, projectId: 20, cities: ["Porto"] },
    { who: "supervisor de Lisboa", role: "supervisor", access: LISBOA, cities: ["Lisboa"] },
    { who: "team leader do Porto", role: "team_leader", access: PORTO, cities: ["Porto"] },
    { who: "supervisor com Lisboa e Porto", role: "supervisor", access: DUAS, cities: ["Lisboa", "Porto"] },
    { who: "supervisor com Lisboa e Porto, Porto no topo", role: "supervisor", access: DUAS, projectId: 20, cities: ["Porto"] },
    { who: "supervisor sem cidades", role: "supervisor", access: NENHUMA, cities: [] },
  ];
  const INPUTS: Array<{ what: string; input: any }> = [
    { what: "sem nada", input: undefined },
    { what: "vazio", input: {} },
    { what: "abertas", input: { status: "open" } },
    { what: "resolved:false (o assistente)", input: { resolved: false, limit: 10 } },
    { what: "fechadas sozinhas (o estado ganha ao resolved)", input: { status: "auto_closed", resolved: true } },
    { what: "todos os filtros", input: { resolved: true, dateFrom: "2026-10-12", dateTo: "2026-10-18", parkId: "pA", type: "Vidro aberto", priority: "HIGH", search: "AA-00", limit: 20, offset: 40 } },
  ];

  for (const w of WHO) {
    it(`${w.who}: os mesmos filtros em todas as formas de pedir`, async () => {
      for (const i of INPUTS) {
        const input = w.projectId ? { ...(i.input ?? {}), projectId: w.projectId } : i.input;
        const { stats } = await run(w.role, w.access, input);
        expect(stats.cities).toEqual(w.cities);
        expect(stats.excludedParkIds).toEqual(["pX", "pT"]);
        expect(stats.autoCloseBefore).toBe(occurrenceAutoCloseCutoff(NOW));
      }
    });
  }

  const SETTINGS: Array<{ what: string; set: () => void; parksFail: boolean; expected: string[] }> = [
    { what: "a definição com um parque", set: () => { h.excluded = ["pX"]; }, parksFail: false, expected: ["pX", "pT"] },
    { what: "a definição vazia", set: () => { h.excluded = []; }, parksFail: false, expected: ["pT"] },
    { what: "a definição por gravar (null)", set: () => { h.excluded = null; }, parksFail: false, expected: ["pT"] },
    { what: "a definição falha a ler", set: () => { h.settingThrows = true; }, parksFail: false, expected: ["pT"] },
    { what: "repetidos e o mesmo dos não operados", set: () => { h.excluded = ["pT", "pX", "pX"]; }, parksFail: false, expected: ["pT", "pX"] },
    { what: "a lista dos não operados falha a ler", set: () => { h.excluded = ["pX"]; }, parksFail: true, expected: ["pX"] },
    { what: "as duas falham", set: () => { h.settingThrows = true; }, parksFail: true, expected: [] },
  ];

  for (const [n, c] of SETTINGS.entries()) {
    it(`parques de fora — ${c.what}: o mesmo que antes`, async () => {
      // a lista dos não operados tem cache de 10 min no processo: cada caso começa sem ela
      vi.setSystemTime(NOW + (n + 1) * 11 * 60_000);
      c.set();
      h.parksFail = c.parksFail;
      for (const w of [WHO[0], WHO[5], WHO[8]]) {
        const input = w.projectId ? { status: "open", projectId: w.projectId } : { status: "open" };
        const { stats } = await run(w.role, w.access, input);
        expect(stats.excludedParkIds).toEqual(c.expected);
      }
    });
  }
});

// ─── A semana certa, também na mudança da hora ──────────────────────────────

describe("H1 — a semana: segunda a domingo de Lisboa, a anterior ao envio (também na mudança da hora de 25 out 2026)", () => {
  const DST_NOW = Date.parse("2026-10-26T07:30:00Z"); // segunda 26 out, 07:30 de Lisboa (já UTC+0)

  it("o relógio do cron: segunda 26 out é dia de relatório; a última meia hora de domingo ainda não", () => {
    expect(lisbonClockOf(new Date(DST_NOW))).toEqual({ date: "2026-10-26", dow: 1, hour: 7 });
    // 25 out, 23:30 UTC = 23:30 de domingo em Lisboa (a hora já mudou)
    expect(lisbonClockOf(new Date("2026-10-25T23:30:00Z"))).toMatchObject({ date: "2026-10-25", dow: 7 });
    // 18 out, 23:30 UTC = 00:30 de segunda 19 em Lisboa (ainda UTC+1)
    expect(lisbonClockOf(new Date("2026-10-18T23:30:00Z"))).toMatchObject({ date: "2026-10-19", dow: 1 });
  });

  it("segunda 26 out: a semana 19–25 out (o domingo tem 25 h) e a anterior 12–18; fora do prazo à meia-noite de domingo, não à hora do envio", async () => {
    vi.setSystemTime(DST_NOW);
    const rows = [
      row("checkin", "2026-10-19", "pA", 2), row("checkin", "2026-10-25", "pB", 5), row("checkout", "2026-10-25", "pA", 4),
      row("checkin", "2026-10-26", "pA", 9), row("checkout", "2026-10-26", "pA", 9), // hoje: não conta
      row("checkin", "2026-10-18", "pA", 3), row("checkout", "2026-10-12", "pT", 1), // a semana anterior
    ];
    h.mp = async (sql, params) => {
      if (sql.includes("AS revenue")) return rows;
      if (sql.includes(`"Occurrence" o`) && sql.includes("count(*) AS total")) return [{ total: params[0] === "2026-10-18 23:00:00" ? 5 : 3 }];
      return healthy(sql, params);
    };
    const d = await buildWeeklyReportData("operacoes", "2026-10-26");
    expect(d.range).toEqual({ from: "2026-10-19", to: "2026-10-25" });
    expect(d.prevRange).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(metric(d, /^Entradas/)).toMatchObject({ value: 7, prev: 3 });
    expect(metric(d, /^Saídas/)).toMatchObject({ value: 4, prev: 1 });
    expect(metric(d, /^Ocorrências novas/)).toMatchObject({ value: 5, prev: 3 });
    expect(d.notes).toEqual([]);
    // as contagens: uma leitura, do dia 1 às 00h de Lisboa (30 set, 23h UTC) ao fim de hoje (27 out, 00h UTC)
    const counts = h.mpCalls.filter((c) => c.sql.includes("AS revenue"));
    expect(counts).toHaveLength(1);
    expect(counts[0].params).toEqual(expect.arrayContaining(["2026-09-30 23:00:00", "2026-10-27 00:00:00"]));
    // ocorrências: [19 às 00h, 26 às 00h) de Lisboa = [18 às 23h UTC, 26 às 00h UTC)
    const occ = h.mpCalls.filter((c) => c.sql.includes(`"Occurrence" o`) && c.sql.includes("count(*) AS total"));
    expect(occ.map((c) => c.params.slice(0, 2))).toEqual([["2026-10-18 23:00:00", "2026-10-26 00:00:00"], ["2026-10-11 23:00:00", "2026-10-18 23:00:00"]]);
    // reclamações novas: a mesma janela
    const created = h.executed.filter((q) => /FROM complaints/.test(q.sql) && /createdAt >=/.test(q.sql));
    expect(created.map((q) => q.params)).toEqual([["2026-10-18 23:00:00", "2026-10-26 00:00:00"], ["2026-10-11 23:00:00", "2026-10-18 23:00:00"]]);
    // fora do prazo: no FIM de cada domingo (Lisboa), nunca às 07:30 do envio
    const late = h.executed.filter((q) => /FROM complaints/.test(q.sql) && !/createdAt >=/.test(q.sql));
    expect(late.map((q) => q.params[0])).toEqual(["2026-10-26 00:00:00", "2026-10-18 23:00:00"]);
    expect(late.flatMap((q) => q.params)).not.toContain("2026-10-26 07:30:00");
    // passagens e escala: os dias de calendário da semana
    const handovers = h.executed.filter((q) => /FROM shift_handovers/.test(q.sql));
    expect(handovers.map((q) => q.params)).toEqual([["2026-10-19", "2026-10-25"], ["2026-10-12", "2026-10-18"]]);
  });
});

// ─── Âmbito e envio ─────────────────────────────────────────────────────────

describe("H1 — âmbito e envio: nacional, só pelo cron, a quem tem o módulo nacional", () => {
  it("noutro âmbito as contagens leem os parques desse âmbito (a cache leva os parques: nunca serve o nacional)", async () => {
    await buildWeeklyReportData("operacoes", MONDAY);
    await cityScope.run(LISBOA as any, () => buildWeeklyReportData("operacoes", MONDAY));
    const counts = h.mpCalls.filter((c) => c.sql.includes("AS revenue"));
    expect(counts).toHaveLength(2);
    expect(counts[0].params).toEqual(expect.arrayContaining(["pA", "pP", "pM"]));
    expect(counts[1].params).toContain("pA");
    for (const porto of ["pP", "pM"]) expect(counts[1].params).not.toContain(porto);
  });

  it("só o cron (sem utilizador) faz o relatório; vai só a quem tem o módulo com alcance nacional, com o interruptor", () => {
    const serverDir = fileURLToPath(new URL(".", import.meta.url));
    const callers = (readdirSync(serverDir, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("generated"))
      .filter((f) => readFileSync(`${serverDir}/${f}`, "utf8").includes("buildWeeklyReportData"))
      .map((f) => f.split("\\").join("/"))
      .sort();
    expect(callers).toEqual(["aiOps/cron.ts", "aiOps/weeklyReports.ts"]);
    const cron = src("server/aiOps/cron.ts");
    expect(cron).toContain('if (isFeatureEnabled("WEEKLY_REPORTS")) {');
    expect(cron).toContain("const to = await nationalRecipients(WEEKLY_META[kind].module);");
    expect(cron).toContain("if (clock.dow === 1) {");
  });
});
