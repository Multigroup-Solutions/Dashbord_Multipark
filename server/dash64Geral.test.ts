/**
 * Plano 64, PR B — Geral e Operações: as contagens "contam tudo" (todos os
 * parques, nossos e todo o Marketplace, como as listas de Operações) e a
 * "Receita Hoje" passa a "Entregas hoje / este mês" COM IVA nos parques que
 * operamos (a mesma leitura dos entregues da Faturação).
 *  B0 uma regra de parques e de acontecimentos (opsEvents) · B1–B3 Reservas,
 *  Entradas, Saídas e Cancelados = as listas · B4 Entregas c/ IVA · B5–B8
 *  cartões do Geral · B9/B13 textos · B10–B12 por cidade, marca e dia ·
 *  B14 Resumo de /operacoes · B16 as listas seguem a cidade do topo.
 * O dinheiro não muda: a Faturação, a Caixa e o motor continuam só com os
 * parques nossos (testes "igual").
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const h = vi.hoisted(() => ({
  query: null as null | ((sql: string, params: unknown[]) => Promise<unknown[]>),
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  excluded: [] as string[] | null,
  ctx: null as any,
  levels: {} as Record<number, string>,
  overrides: {} as Record<string, string>,
}));

const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [10, 20], projectIds: [1, 10, 11, 12, 20, 21, 22], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));

const TREE = vi.hoisted(() => [
  { id: 1, level: "group", name: "Multipark", parentId: null, isActive: 1 },
  { id: 10, level: "city", name: "Lisboa", parentId: 1, isActive: 1 },
  { id: 11, level: "brand", name: "Marketplace", parentId: 10, isActive: 1 },
  { id: 12, level: "brand", name: "Airpark", parentId: 10, isActive: 1 },
  { id: 20, level: "city", name: "Porto", parentId: 1, isActive: 1 },
  { id: 21, level: "brand", name: "Marketplace", parentId: 20, isActive: 1 },
  { id: 22, level: "brand", name: "Redpark", parentId: 20, isActive: 1 },
]);
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => h.overrides,
  getUserModuleOverrides: async () => ({}),
  getProjects: async () => TREE,
  resolveProjectIds: async (id: number) => {
    const out: number[] = [];
    const add = (pid: number) => { out.push(pid); for (const n of TREE) if (n.parentId === pid) add(n.id); };
    add(Math.abs(id));
    return out;
  },
  getDb: async () => ({
    execute: async (q: unknown) => {
      const { sql, params } = new MySqlDialect().sqlToQuery(q as any);
      if (/SELECT level FROM projects/.test(sql)) return [[{ level: h.levels[Number(params[0])] ?? "" }], []];
      return [[], []];
    },
  }),
}));
vi.mock("./multiparkDb/client", async (original) => ({
  ...(await original<object>()),
  multiparkDbQuery: async (sql: string, params: unknown[] = []) => {
    h.calls.push({ sql, params });
    return h.query ? h.query(sql, params) : [];
  },
}));
vi.mock("./finance/liveBookings", async (original) => ({
  ...(await original<object>()),
  loadLiveContext: async () => h.ctx,
}));
vi.mock("./appSettings", async (original) => ({
  ...(await original<object>()),
  getSetting: async (key: string) => (key === "operations.excludedParks" ? h.excluded : null),
}));

import { appRouter } from "./routers";
import { cityScope } from "./cityScope";
import { ParamList } from "./multiparkDb/read";
import { buildOpsAggSql, buildOpsListSql, buildSource, getMultiparkOpsList, OPS_LIST_EVENT } from "./multiparkDb/opsLists";
import { buildOpsCountsSql, OPS_COUNTS_LIMIT, type OpsCountRow } from "./multiparkDb/opsCounts";
import {
  LATEST_CANCELLATION_JOIN, opsEventParts, opsEventStatuses, readScopeParks, resetScopeParksCache, statusSqlLiteral,
  type OpsEventId, type OpsStatusRule,
} from "./multiparkDb/opsEvents";
import { mapParks } from "./multiparkDb/dayBookings";
import { buildFinanceAggSql, FINANCE_AGG_LIMIT, type FinanceAggRow } from "./multiparkDb/financeAgg";
import { createLiveCache } from "./multiparkDb/liveCache";
import {
  brandParkSet, countsOnly, liveBookingStats, liveOperationsSummary, liveOpsBookingStats, liveOpsParkScope, liveParkScope,
  opsParkMeta, resetOpsCountsCache, summarizeBookingStats, summarizeOpsActions,
} from "./opsStatsLive";
import { liveDeliveries, operatedParkIds, resetDeliveriesCache, summarizeDeliveries } from "./finance/deliveries";
import { parkIdsFor, toLiveBookingAgg } from "./finance/liveBookings";
import { getHRStats } from "./db";
import { summarizeOps, type OpsAggRow, type OpsListKind } from "../shared/opsLists";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const caller = (role: string) => appRouter.createCaller({ user: { id: 77, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const ENV = "DATABASE_URL_MULTIPARK";
/** 15 out 2026, 10:00 de Lisboa. */
const NOW = Date.parse("2026-10-15T09:00:00Z");
const TODAY = "2026-10-15";

/** Parques da Multipark (tabela "Park"). */
const PARK_ROWS = [
  { id: "pA", name: "Airpark", city: "Lisboa" }, // nosso (Lisboa)
  { id: "pB", name: "Boardingpark", city: "Prior Velho" }, // terceiro operado (Lisboa pela terra)
  { id: "pT", name: "Top Parking", city: "Lisboa" }, // terceiro NÃO operado (lista do dono)
  { id: "pX", name: "Parque Excluído", city: "Lisboa" }, // terceiro excluído nas Definições
  { id: "pP", name: "Redpark", city: "Porto" }, // nosso (Porto)
  { id: "pM", name: "Porto Parking Plus", city: "Oporto" }, // terceiro (Porto)
];

/** O contexto do motor (liveBookings): nossos → centro; terceiros → nó Marketplace. */
const CTX = {
  ourParks: new Map<string, number | null>([["pA", 12], ["pP", 22]]),
  parkInfo: new Map([["pA", { name: "Airpark", city: "Lisboa" }], ["pP", { name: "Redpark", city: "Porto" }]]),
  aliases: new Map<string, string>(),
  marketplaceParks: new Map<string, number | null>([["pB", 11], ["pT", 11], ["pX", 11], ["pM", 21]]),
  marketplaceParkInfo: new Map([
    ["pB", { name: "Boardingpark", city: "Prior Velho", operated: true }],
    ["pT", { name: "Top Parking", city: "Lisboa", operated: false }],
    ["pX", { name: "Parque Excluído", city: "Lisboa", operated: false }],
    ["pM", { name: "Porto Parking Plus", city: "Oporto", operated: true }],
  ]),
  marketplaceNodeByCity: new Map([["lisboa", 11], ["porto", 21]]),
  parkCity: new Map<string, string | null>([["pA", "lisboa"], ["pP", "porto"]]),
};

const LISBOA = { all: false, defaultCityId: 10, cityName: "Lisboa", cityNames: ["Lisboa"], cityIds: [10], projectIds: [10, 11, 12], missingCostCenter: false };
const PORTO = { all: false, defaultCityId: 20, cityName: "Porto", cityNames: ["Porto"], cityIds: [20], projectIds: [20, 21, 22], missingCostCenter: false };

/** Põe os parâmetros no texto ($n → valor), para comparar predicados montados com listas de parâmetros diferentes. */
const inline = (sql: string, params: readonly unknown[]) =>
  sql.replace(/\$(\d+)/g, (_, n) => { const v = params[Number(n) - 1]; return typeof v === "number" ? String(v) : `'${String(v)}'`; });

const countsSqlCalls = () => h.calls.filter((c) => c.sql.includes("AS revenue"));

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env[ENV];
  process.env[ENV] = "postgres://ro:x@db.example.com:5432/mp";
  h.calls = [];
  h.query = async (sql) => (sql.includes(`FROM "Park" p`) ? PARK_ROWS : []);
  h.excluded = ["pX"];
  h.ctx = CTX;
  h.levels = { 1: "group", 10: "city", 11: "brand", 12: "brand", 20: "city", 21: "brand", 22: "brand" };
  h.overrides = {};
  resetScopeParksCache(); resetOpsCountsCache(); resetDeliveriesCache();
});
afterEach(() => { if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv; });

// ─── B0 ──────────────────────────────────────────────────────────────────────

describe("B0 — uma regra para os acontecimentos (listas = contagens)", () => {
  const start = "2026-10-14 23:00:00", end = "2026-10-15 23:00:00";
  const KIND: Record<OpsEventId, OpsListKind> = { created: "reservas", checkin: "entradas", checkout: "saidas", cancelled: "cancelados" };
  const listSql = (kind: OpsListKind, includePending: boolean, state?: string) => {
    const p = new ParamList();
    return inline(buildSource({ kind, parkIds: ["p1", "p2"], ourParkIds: ["p1"], includePending, state }, p, start, end, false), p.values);
  };
  const countsSql = (e: Parameters<typeof buildOpsCountsSql>[0]["events"][number], includePending: boolean) => {
    const q = buildOpsCountsSql({ events: [e], start, end, parkIds: ["p1", "p2"], includePending });
    return inline(q.sql, q.params);
  };
  const statusIn = (sql: string, rule: OpsStatusRule) => {
    if (rule.only) expect(sql).toContain(`b."status"::text = '${rule.only}'`);
    for (const s of rule.exclude) expect(sql).toContain(`b."status"::text <> '${s}'`);
  };

  for (const e of ["created", "checkin", "checkout", "cancelled"] as const) {
    for (const includePending of [true, false]) {
      it(`${e}${includePending ? " (com as por pagar)" : ""}: o mesmo predicado (texto e parâmetros) e os mesmos estados nas duas`, () => {
        const p = new ParamList();
        const preds = opsEventParts(e, p, start, end).map((part) => inline(part.where, p.values));
        // Reservas "ativas" (não canceladas) = a contagem "created"; todas = "createdAll".
        const list = listSql(KIND[e], includePending, e === "created" ? "active" : undefined);
        const counts = countsSql(e, includePending);
        for (const pred of preds) {
          expect(list).toContain(pred);
          expect(counts).toContain(pred);
        }
        expect(list).toContain(`b."parkId" IN ('p1', 'p2')`);
        expect(counts).toContain(`b."parkId" IN ('p1', 'p2')`);
        const rule = opsEventStatuses(e, { includePending });
        expect(counts).toContain(statusSqlLiteral(rule));
        statusIn(list, rule);
        if (includePending) { expect(list).not.toContain("'PENDING'"); expect(counts).not.toContain("PENDING"); }
      });
    }
  }

  it("todas as criadas (lista Reservas sem filtro) = a contagem createdAll", () => {
    const rule = opsEventStatuses("created", { includePending: true, withCancelled: true });
    expect(rule).toEqual({ only: null, exclude: [] });
    expect(listSql("reservas", true)).not.toMatch(/b\."status"::text <>/);
    expect(countsSql("createdAll", true)).toContain("AND TRUE AND");
  });

  it("parques: as listas e as contagens dão os MESMOS parques (nossos + Marketplace operado e não operado + excluído nas Definições)", async () => {
    const list = await cityScope.run(LISBOA as any, () => getMultiparkOpsList({ kind: "entradas", from: TODAY, to: TODAY }, ["Lisboa"], undefined, ["pX"]));
    const counts = await cityScope.run(LISBOA as any, () => liveOpsParkScope());
    expect(list.available).toBe(true);
    const listIds = list.available ? list.data.parks.map((p) => p.id).sort() : [];
    expect(listIds).toEqual(["pA", "pB", "pT", "pX"]);
    expect([...counts.parkIds].sort()).toEqual(listIds);
    // os de fora das cidades não entram
    expect(counts.parkIds).not.toContain("pP");
  });

  it("a marca do topo: só os parques dela (nossos pelo centro, Marketplace pelo nó)", async () => {
    expect([...brandParkSet(CTX, [12])]).toEqual(["pA"]);
    expect([...brandParkSet(CTX, [11])].sort()).toEqual(["pB", "pT", "pX"]);
    const airpark = await cityScope.run({ ...LISBOA, projectIds: [12] } as any, () => liveOpsParkScope(12));
    expect(airpark.parkIds).toEqual(["pA"]);
    // uma cidade no topo não corta por marca (a cidade já vem pelo âmbito)
    const city = await cityScope.run(LISBOA as any, () => liveOpsParkScope(10));
    expect(city.parkIds.sort()).toEqual(["pA", "pB", "pT", "pX"]);
  });

  it("os parques ficam 5 min em memória, mas o corte pelas cidades é de cada pedido", async () => {
    const lis = await readScopeParks(["Lisboa"]);
    const por = await readScopeParks(["Porto"]);
    expect(lis.map((p) => p.id).sort()).toEqual(["pA", "pB", "pT", "pX"]);
    expect(por.map((p) => p.id).sort()).toEqual(["pM", "pP"]);
    expect(h.calls.filter((c) => c.sql.includes(`FROM "Park" p`))).toHaveLength(1);
  });
});

// ─── B1–B3: Geral = listas de Operações ─────────────────────────────────────

interface FakeBooking { id: string; parkId: string; status: string; created: string; checkIn: string; checkOut: string; cancelled?: { day: string; row: boolean }; value: number }
const DAY_OF: Record<OpsEventId, (b: FakeBooking) => string | null> = {
  created: (b) => b.created, checkin: (b) => b.checkIn, checkout: (b) => b.checkOut,
  cancelled: (b) => (b.status === "CANCELLED" ? b.cancelled?.day ?? null : null),
};
const passes = (rule: OpsStatusRule, status: string) => (rule.only ? status === rule.only : !rule.exclude.includes(status));
/** O que o SQL das contagens devolveria (acontecimento × dia × parque). */
function toCountRows(bookings: FakeBooking[]): OpsCountRow[] {
  const out: OpsCountRow[] = [];
  for (const e of ["created", "checkin", "checkout", "cancelled"] as const) {
    const rule = opsEventStatuses(e, { includePending: true });
    for (const b of bookings) {
      const day = DAY_OF[e](b);
      if (day && passes(rule, b.status)) out.push({ event: e, day, parkId: b.parkId, count: 1, revenue: b.value });
    }
  }
  return out;
}
/** O que o agregado da lista devolveria para um dia. */
function toAggRows(kind: OpsListKind, bookings: FakeBooking[], day: string, state?: "active"): OpsAggRow[] {
  const e = OPS_LIST_EVENT[kind];
  const rule = opsEventStatuses(e, { includePending: true, withCancelled: kind === "reservas" });
  return bookings.filter((b) => DAY_OF[e](b) === day && passes(rule, b.status) && (state !== "active" || b.status !== "CANCELLED")).map((b) => ({
    parkId: b.parkId, current: true, status: b.status, origin: "API", paymentSource: null, hasPartner: false, reason: null,
    count: 1, value: b.value, paid: 0, toPay: b.value, approx: kind === "cancelados" && !b.cancelled?.row ? 1 : 0, refund: 0, refunded: 0,
  }));
}

describe("B1–B3 — Reservas, Entradas, Saídas e Cancelados do Geral = as listas de Operações", () => {
  const Y = "2026-10-14";
  const bookings: FakeBooking[] = [
    { id: "1", parkId: "pA", status: "BOOKED", created: TODAY, checkIn: TODAY, checkOut: "2026-10-20", value: 50 },
    { id: "2", parkId: "pA", status: "PENDING", created: TODAY, checkIn: "2026-10-18", checkOut: TODAY, value: 40 }, // por pagar: conta
    { id: "3", parkId: "pB", status: "CHECKED_IN", created: TODAY, checkIn: TODAY, checkOut: "2026-10-19", value: 30 }, // Marketplace operado
    { id: "4", parkId: "pT", status: "CHECKED_OUT", created: Y, checkIn: "2026-10-10", checkOut: TODAY, value: 20 }, // Marketplace não operado
    { id: "5", parkId: "pA", status: "CANCELLED", created: TODAY, checkIn: TODAY, checkOut: "2026-10-16", cancelled: { day: TODAY, row: true }, value: 60 },
    { id: "6", parkId: "pT", status: "CANCELLED", created: Y, checkIn: "2026-10-16", checkOut: "2026-10-17", cancelled: { day: TODAY, row: false }, value: 10 }, // sem linha Cancellation (≈)
    { id: "7", parkId: "pX", status: "BOOKED", created: TODAY, checkIn: Y, checkOut: TODAY, value: 15 }, // excluído nas Definições: conta na mesma
  ];
  const parks = mapParks(PARK_ROWS, ["Lisboa"]);
  const parkInfo = new Map(parks.map((p) => [p.id, opsParkMeta(p)]));
  const stats = summarizeBookingStats(toCountRows(bookings), { total: null, today: TODAY, monthStart: "2026-10-01", periodFrom: "2026-10-01", periodTo: TODAY, parkInfo });

  it("Reservas criadas hoje = Reservas → não canceladas; nossos = a divisão por parque das listas", () => {
    const all = summarizeOps("reservas", toAggRows("reservas", bookings, TODAY), parks);
    expect(stats.reservasHoje).toBe(all.active);
    expect(stats.reservasHoje).toBe(4); // 1, 2 (por pagar), 3 (Marketplace), 7 — a 5 foi cancelada
    const active = summarizeOps("reservas", toAggRows("reservas", bookings, TODAY, "active"), parks);
    expect(stats.reservasHojeNossos).toBe(active.ours);
    expect(stats.reservasHojeNossos).toBe(2);
  });

  it("Entradas e Saídas hoje = o total das Recolhas / Entregas do dia (canceladas fora, por pagar dentro)", () => {
    expect(stats.checkinHoje).toBe(summarizeOps("entradas", toAggRows("entradas", bookings, TODAY), parks).total);
    expect(stats.checkoutHoje).toBe(summarizeOps("saidas", toAggRows("saidas", bookings, TODAY), parks).total);
    expect([stats.checkinHoje, stats.checkoutHoje]).toEqual([2, 3]);
  });

  it("Cancelados hoje = a lista Cancelados (com as de data aproximada e as de todo o Marketplace)", () => {
    const c = summarizeOps("cancelados", toAggRows("cancelados", bookings, TODAY), parks);
    expect(stats.canceladosHoje).toBe(c.total);
    expect(c).toMatchObject({ total: 2, approx: 1 });
  });

  it("as contagens não levam dinheiro (countsOnly) e o Geral e as Operações chamam o mesmo procedimento", () => {
    const c = countsOnly(stats);
    expect(c).toMatchObject({ reservasHoje: 4, reservasHojeNossos: 2, checkinHoje: 2 });
    expect(JSON.stringify(c)).not.toMatch(/revenue|receita/);
    expect(src("client/src/pages/DashboardPage.tsx")).toContain("trpc.multipark.opsBookingCounts.useQuery(scope");
    expect(src("client/src/pages/OperacoesDashboard.tsx")).toContain("trpc.multipark.opsBookingCounts.useQuery(");
    expect(src("client/src/pages/DashboardPage.tsx")).not.toContain("multipark.bookingStats");
  });
});

describe("B3 — cancelada em: a linha Cancellation mais recente (senão a última alteração, ≈)", () => {
  const bounds = { start: "2026-10-14 23:00:00", end: "2026-10-15 23:00:00" };
  it("a lista e as contagens pedem a MESMA linha (a mais recente) e as sem linha", () => {
    const list = buildSource({ kind: "cancelados", parkIds: ["p1"], ourParkIds: ["p1"] }, new ParamList(), bounds.start, bounds.end, false);
    const counts = buildOpsCountsSql({ events: ["cancelled"], parkIds: ["p1"], ...bounds }).sql;
    for (const sql of [list, counts]) {
      expect(sql).toContain(LATEST_CANCELLATION_JOIN);
      expect(sql).toContain(`ORDER BY x."createdAt" DESC LIMIT 1`);
      expect(sql).toContain(`NOT EXISTS (SELECT 1 FROM "Cancellation" c2 WHERE c2."bookingId" = b."id")`);
    }
  });
  it("uma reserva conta UMA vez: o agregado e a página juntam só a linha da fonte (2 linhas → 1)", () => {
    const spec = { kind: "cancelados" as const, parkIds: ["p1"], ourParkIds: ["p1"] };
    const b = { from: "2026-10-15", to: "2026-10-15", days: 1, ...bounds, prevFrom: "2026-10-14", prevTo: "2026-10-14", prevStart: "2026-10-13 23:00:00" };
    for (const q of [buildOpsAggSql(spec, b), buildOpsListSql(spec, b, 50, 0)]) {
      expect(q.sql).toContain(`LEFT JOIN "Cancellation" cx ON cx."id" = d.cx_id`);
      expect(q.sql).not.toContain(`cx."bookingId" = d."id"`);
      expect(q.sql).not.toContain(`cx."bookingId" = b."id"`);
    }
    expect(buildSource(spec, new ParamList(), bounds.start, bounds.end, false)).toContain(`cx."id" AS cx_id`);
  });
});

// ─── B4: Entregas c/ IVA ────────────────────────────────────────────────────

describe("B4 — Entregas hoje / este mês, c/ IVA, nos parques que operamos", () => {
  it("parques: nosso + terceiro operado entram; não operado pelo nome, excluído nas Definições e nosso de outra cidade não", () => {
    expect(operatedParkIds(CTX, [10, 11, 12], ["pX"])).toEqual(["pA", "pB"]);
    // sem âmbito (nacional): todos os operados, também os de outras cidades e os sem centro
    const noCentre = { ...CTX, ourParks: new Map<string, number | null>([...CTX.ourParks, ["pZ", null]]) };
    expect(operatedParkIds(noCentre, undefined, ["pX"]).sort()).toEqual(["pA", "pB", "pM", "pP", "pZ"]);
    expect(operatedParkIds(CTX, [], [])).toEqual([]);
  });

  it("a MESMA leitura dos entregues da Faturação (o mesmo construtor e o mesmo kind), só com outra lista de parques", async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const r = await liveDeliveries({ projectId: 10 }, NOW, async (sql, params = []) => { seen.push({ sql, params }); return []; });
    expect(r).toMatchObject({ day: TODAY, today: { count: 0, gross: 0 }, month: { count: 0, gross: 0 } });
    expect(seen).toHaveLength(1);
    const expected = buildFinanceAggSql({ kind: "delivered", start: "2026-09-30 23:00:00", end: "2026-10-15 23:00:00", parkIds: ["pA", "pB"] });
    expect(seen[0]).toEqual(expected);
    expect(seen[0].sql).toContain(`b."status"::text IN (`);
    expect(seen[0].params).toContain("CHECKED_OUT");
  });

  it("valor = o que o motor soma (Σ total das linhas), c/ IVA; hoje separado do mês em memória", () => {
    const rows = [
      { day: TODAY, parkId: "pA", count: 2, total: 123 },
      { day: "2026-10-03", parkId: "pA", count: 1, total: 80.5 },
      { day: TODAY, parkId: "pP", count: 1, total: 10 },
    ] as FinanceAggRow[];
    const d = summarizeDeliveries(rows, TODAY);
    expect(d).toMatchObject({ today: { count: 3, gross: 133 }, month: { count: 4, gross: 213.5 } });
    // só parques nossos: o mesmo valor que o motor junta em "entregues" (toLiveBookingAgg → total)
    const engineSum = toLiveBookingAgg(rows.map((r) => ({ ...r, partnerId: null, partnerName: null, paymentMethod: null, campaignName: null, discountCode: null, parking: 0, delivery: 0, extras: 0, paid: 0, remaining: 0, owingCount: 0, status: "CHECKED_OUT", pro: false, discount: 0, marketplace: false })), CTX as any)
      .reduce((s, r) => s + r.total, 0);
    expect(d.month.gross).toBe(engineSum);
  });

  it("uma entrada de 246 € e uma saída de 123 € hoje → 123 € (a antiga Receita Hoje dava 246 €)", () => {
    const delivered = summarizeDeliveries([{ day: TODAY, count: 1, total: 123 }], TODAY);
    expect(delivered.today.gross).toBe(123);
    const old = summarizeBookingStats([
      { event: "checkin", day: TODAY, parkId: "pA", count: 1, revenue: 246 },
      { event: "checkout", day: TODAY, parkId: "pA", count: 1, revenue: 123 },
    ], { total: null, today: TODAY, monthStart: "2026-10-01", periodFrom: "2026-10-01", periodTo: TODAY, parkInfo: new Map() });
    expect(old.receitaHoje).toBe(246);
  });

  it("leitura no teto → erro (o cartão mostra '—'), nunca um valor cortado", async () => {
    const full = Array.from({ length: FINANCE_AGG_LIMIT }, () => ({ day: TODAY, park_id: "pA", n: 1, total: 1 }));
    await expect(liveDeliveries({}, NOW, async () => full)).rejects.toThrow(/Leitura incompleta/);
  });

  it("o procedimento pede o Financeiro + os totais; quem não os tem leva FORBIDDEN (o cartão diz 'Sem acesso')", async () => {
    h.query = async (sql) => (sql.includes("FROM \"Park\" p") ? PARK_ROWS : []);
    await expect(caller("supervisor").invoices.deliveries({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.overrides = { "finance.view_totals": "deny" };
    await expect(caller("admin").invoices.deliveries({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.overrides = {};
    await expect(caller("admin").invoices.deliveries({ projectId: 10 })).resolves.toMatchObject({ month: { count: 0 } });
  });
});

// ─── B10–B12 ────────────────────────────────────────────────────────────────

describe("B10–B12 — por cidade (resolvida), por marca (classificada) e por dia (com os dias a 0)", () => {
  const rows = [
    { id: "a", name: "Airpark", city: "Lisboa" },
    { id: "b", name: "Boardingpark", city: "Prior Velho" },
    { id: "c", name: "Redpark", city: "Oporto" },
    { id: "d", name: "Skypark Porto", city: "" },
    { id: "e", name: "Airpark Porto", city: "Porto" },
  ];
  const created = (parkId: string, n: number): OpsCountRow => ({ event: "created", day: TODAY, parkId, count: n, revenue: n * 10 });
  const counts = [created("a", 1), created("b", 2), created("c", 3), created("d", 4), created("e", 5)];
  const base = { total: null, today: TODAY, monthStart: "2026-10-01", periodFrom: TODAY, periodTo: TODAY };

  it("'Lisboa', 'Prior Velho', 'Oporto' e '' (pelo nome) → 2 fatias (eram 4)", () => {
    const parks = mapParks(rows);
    const s = summarizeBookingStats(counts, { ...base, parkInfo: new Map(parks.map((p) => [p.id, opsParkMeta(p)])) });
    expect(s.byCity.map((c) => c.name).sort()).toEqual(["Lisboa", "Porto"]);
    expect(s.byCity.find((c) => c.name === "Porto")).toMatchObject({ bookings: 12, revenue: 120 });
    // antes: a cidade escrita no parque
    const old = summarizeBookingStats(counts, { ...base, parkInfo: new Map(rows.map((r) => [r.id, { name: r.name, city: r.city }])) });
    expect(old.byCity.map((c) => c.name).sort()).toEqual(["Desconhecido", "Lisboa", "Oporto", "Porto", "Prior Velho"]);
  });

  it("por marca: a mesma marca em parques diferentes → 1 fatia; um terceiro → Marketplace", () => {
    const parks = mapParks(rows);
    const s = summarizeBookingStats(counts, { ...base, parkInfo: new Map(parks.map((p) => [p.id, opsParkMeta(p)])) });
    expect(Object.fromEntries(s.byBrand.map((b) => [b.name, b.bookings]))).toEqual({ Airpark: 6, Marketplace: 2, Redpark: 3, Skypark: 4 });
  });

  it("o Resumo agrupa pela cidade resolvida; o nome do parque continua com a cidade gravada", () => {
    const parks = mapParks(rows);
    const a = summarizeOpsActions(counts, new Map(parks.map((p) => [p.id, opsParkMeta(p)])));
    expect(a.creation.byCity.map((c) => c.name).sort()).toEqual(["Lisboa", "Porto"]);
    expect(a.creation.byPark.map((p) => p.name)).toContain("Boardingpark Prior Velho");
  });

  it("o MCP (parques nossos) também deixa de ter 'Prior Velho'/'Oporto' à parte: a cidade vem do contexto", async () => {
    h.ctx = { ...CTX, parkInfo: new Map([["pA", { name: "Airpark", city: "Prior Velho" }], ["pP", { name: "Redpark", city: "Oporto" }]]) };
    const { parkInfo } = await liveParkScope();
    expect(parkInfo.get("pA")).toMatchObject({ city: "Prior Velho", cityLabel: "Lisboa", ours: true });
    expect(parkInfo.get("pP")).toMatchObject({ city: "Oporto", cityLabel: "Porto" });
  });

  it("por dia: um período de 5 dias com 2 vazios → 5 pontos", () => {
    const s = summarizeBookingStats([
      { event: "created", day: "2026-10-11", parkId: "a", count: 2, revenue: 0 },
      { event: "checkin", day: "2026-10-13", parkId: "a", count: 1, revenue: 0 }, // sem criadas mas com entradas: aparece
      { event: "created", day: "2026-10-15", parkId: "a", count: 1, revenue: 0 },
    ], { total: null, today: TODAY, monthStart: "2026-10-01", periodFrom: "2026-10-11", periodTo: TODAY, parkInfo: new Map() });
    expect(s.byDay.map((d) => d.date)).toEqual(["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]);
    expect(s.byDay.map((d) => d.reservas)).toEqual([2, 0, 0, 0, 1]);
    expect(s.byDay[2].checkins).toBe(1);
    expect(s.checkinPeriodo).toBe(1);
  });
});

// ─── Leituras ao vivo: cache, âmbito e "—" ──────────────────────────────────

describe("contagens ao vivo — a cache leva os parques (o âmbito) na chave; uma falha nunca dá 0", () => {
  const countRow = (park_id: string, n: number) => ({ event: "created", day: TODAY, park_id, n, revenue: 0 });
  beforeEach(() => {
    h.query = async (sql, params) => {
      if (sql.includes(`FROM "Park" p`)) return PARK_ROWS;
      if (sql.includes("AS revenue")) return (params as string[]).filter((v) => typeof v === "string" && /^p[A-Z]$/.test(v)).map((id) => countRow(id, 1));
      return [];
    };
  });

  it("Lisboa e Porto são leituras diferentes; a mesma cidade no mesmo minuto é uma leitura só", async () => {
    const lis = await cityScope.run(LISBOA as any, () => liveOpsBookingStats(undefined, NOW));
    const por = await cityScope.run(PORTO as any, () => liveOpsBookingStats(undefined, NOW));
    await cityScope.run(LISBOA as any, () => liveOpsBookingStats(undefined, NOW));
    expect(countsSqlCalls()).toHaveLength(2);
    expect(lis.reservasHoje).toBe(4);
    expect(lis.reservasHojeNossos).toBe(1);
    expect(por.reservasHoje).toBe(2);
    const [first, second] = countsSqlCalls();
    expect(first.params).not.toContain("pP");
    expect(second.params).not.toContain("pA");
    expect(second.params).toEqual(expect.arrayContaining(["pP", "pM"]));
  });

  it("a BD da Multipark falha → lança (o cartão mostra '—'); a falha não fica na cache", async () => {
    h.query = async (sql) => { if (sql.includes(`FROM "Park" p`)) return PARK_ROWS; throw new Error("canceling statement due to statement timeout"); };
    await expect(cityScope.run(LISBOA as any, () => liveOpsBookingStats(undefined, NOW))).rejects.toThrow(/timeout/);
    h.query = async (sql) => (sql.includes(`FROM "Park" p`) ? PARK_ROWS : []);
    await expect(cityScope.run(LISBOA as any, () => liveOpsBookingStats(undefined, NOW))).resolves.toMatchObject({ reservasHoje: 0 });
  });

  it("contagens no teto → erro, nunca um número cortado", async () => {
    h.query = async (sql) => (sql.includes(`FROM "Park" p`) ? PARK_ROWS : sql.includes("AS revenue") ? Array.from({ length: OPS_COUNTS_LIMIT }, () => countRow("pA", 1)) : []);
    await expect(liveOpsBookingStats(undefined, NOW)).rejects.toThrow(/Leitura incompleta/);
  });

  it("LiveCache: a mesma chave partilha a promessa; uma falha sai da cache", async () => {
    const c = createLiveCache(60_000);
    let n = 0;
    const ok = () => Promise.resolve(++n);
    expect(await c.get("k", ok)).toBe(1);
    expect(await c.get("k", ok)).toBe(1);
    await expect(c.get("bad", () => Promise.reject(new Error("x")))).rejects.toThrow();
    await Promise.resolve();
    expect(await c.get("bad", ok)).toBe(2);
  });
});

// ─── B14 e B16 ──────────────────────────────────────────────────────────────

describe("B14 — o Resumo de /operacoes conta o mesmo universo que as listas", () => {
  it("parks: 'all' lê todos os parques (com o Marketplace); sem a opção, só os nossos (MCP)", async () => {
    await liveOperationsSummary({ startDate: TODAY, endDate: TODAY }, { includePending: true, parks: "all" });
    const all = countsSqlCalls().at(-1)!;
    expect(all.params).toEqual(expect.arrayContaining(["pA", "pB", "pT", "pX", "pP", "pM"]));
    expect(all.sql).not.toContain("PENDING");
    await liveOperationsSummary({ startDate: TODAY, endDate: TODAY });
    const ours = countsSqlCalls().at(-1)!;
    expect(ours.params).toEqual(expect.arrayContaining(["pA", "pP"]));
    expect(ours.params).not.toContain("pB");
    expect(ours.sql).toContain(`NOT IN ('CANCELLED', 'PENDING')`);
  });
  it("a rota pede todos os parques e o âmbito por omissão deixa de ser só a cidade do centro de custos", () => {
    const r = src("server/routers.ts");
    expect(r).toContain(`getOperationsSummary(input, { includePending: true, parks: "all" })`);
    const access = src("server/cityAccess.ts");
    expect(access).not.toMatch(/\['multipark\.bookingStats', 'multipark\.operationsSummary'/);
    // O assistente (reservas_resumo) chama este procedimento e passa a contar o mesmo; a descrição da
    // ferramenta fica como está: o v1 do assistente está congelado (assistant/mpvF3.test.ts).
    expect(src("server/assistant/tools.ts")).toContain(`ctx.call("multipark.operationsSummary"`);
  });
});

describe("B16 — as listas de Operações seguem a cidade/marca do topo", () => {
  const ids = (r: any) => (r.available ? r.parks.map((p: any) => p.id).sort() : r);
  const input = { kind: "entradas" as const, from: TODAY, to: TODAY };
  it("com Lisboa no topo os parques do Porto não entram; sem cidade, os mesmos de antes", async () => {
    expect(ids(await caller("admin").multipark.opsList({ ...input, projectId: 10 }))).toEqual(["pA", "pB", "pT", "pX"]);
    expect(ids(await caller("admin").multipark.opsList(input))).toEqual(["pA", "pB", "pM", "pP", "pT", "pX"]);
  });
  it("com uma marca no topo só os parques dela (a mesma regra das contagens)", async () => {
    expect(ids(await caller("admin").multipark.opsList({ ...input, projectId: 12 }))).toEqual(["pA"]);
    expect(ids(await caller("admin").multipark.opsList({ ...input, projectId: 11 }))).toEqual(["pB", "pT", "pX"]);
  });
  it("o ecrã manda a cidade do topo", () => {
    const list = src("client/src/components/operacoes/OpsList.tsx");
    expect(list).toContain("...(globalFilters.projectId !== undefined ? { projectId: globalFilters.projectId } : {}),");
    expect(list).toContain("No Dashboard das Operações e no Geral");
  });
});

// ─── B5–B9, B13: os cartões e os textos ─────────────────────────────────────

describe("B5–B9, B13 — cartões do Geral e textos", () => {
  const page = src("client/src/pages/DashboardPage.tsx");
  it("B5: despesas e entregas pedidas a quem tem o Financeiro; sem ele (ou FORBIDDEN) → 'Sem acesso', nunca 0 €", () => {
    expect(page).not.toContain("isAdmin");
    expect(page).toContain(`const seesFinance = can(user as any, "financeiro", "view");`);
    expect(page).toContain("trpc.expenses.stats.useQuery(scope, { enabled: seesFinance, retry: retryTransient })");
    expect(page).toContain("trpc.invoices.deliveries.useQuery(scope, { enabled: seesFinance, retry: retryTransient })");
    expect(page).toContain(`(seesFinance ? failOf(q) : "forbidden" as const)`);
    expect(page.match(/failed=\{financeFail\(/g)).toHaveLength(3);
  });
  it("B4: Entregas hoje (c/ IVA) · parques que operamos, com 'N carros · este mês'", () => {
    expect(page).toContain(`label="Entregas hoje (c/ IVA)"`);
    expect(page).toContain(`"00h–24h · parques que operamos"`);
    expect(page).toContain("carros · este mês:");
    expect(page).not.toContain("Receita Hoje");
  });
  it("B1–B3: os rótulos dizem o dia e que são todos os parques", () => {
    for (const l of ["Reservas criadas hoje", "Entradas hoje", "Saídas hoje", "Cancelados hoje"]) expect(page).toContain(`label="${l}"`);
    expect(page).toContain(`"00h–24h · todos os parques"`);
    expect(page).toContain("em parques nossos · ${fmtNum(reservasMarketplace)} em parques do Marketplace");
  });
  it("B6–B8: Reclamações abertas, Média Google e Colaboradores pelas consultas das páginas, com a cidade do topo", () => {
    expect(page).toContain("trpc.complaints.stats.useQuery(scope");
    expect(page).toContain("trpc.reviews.stats.useQuery(scope");
    expect(page).toContain("trpc.rh.stats.useQuery({ ...scope, skipHours: true }");
    expect(page).toContain(`label="Reclamações abertas"`);
    expect(page).toContain("complaintStats?.open");
    expect(page).toContain("funcionários · ");
    expect(page).not.toContain("efetivos");
  });
  it("B8: o Geral pede o rh.stats sem as horas; o RH e o Pessoas continuam a pedi-las", async () => {
    const fichas = [{ employee: { id: 1, isActive: 1, position: "driver", contractType: "permanent" } }, { employee: { id: 2, isActive: 1, position: "extra", contractType: "extra" } }];
    const withHours = await getHRStats(fichas, NOW);
    const without = await getHRStats(fichas, NOW, { skipHours: true });
    // as contagens são as mesmas; sem as horas não há leitura do ponto (nem erro dela)
    expect(without).toMatchObject({ totalActive: 2, staff: 1, extras: 1, monthlyHours: null, monthlyHoursError: null, monthlySuspiciousHours: null });
    expect({ ...withHours, monthlyHours: null, monthlyHoursError: null, monthlySuspiciousHours: null }).toEqual(without);
    // sem BD de testes, a leitura das horas é tentada e falha → o erro aparece (o RH mostra "—")
    expect(withHours.monthlyHoursError).toBeTruthy();
    const router = src("server/rhRouter.ts");
    expect(router).toContain("return getHRStats(rows, Date.now(), { skipHours: input?.skipHours });");
    for (const f of ["client/src/pages/HRPage.tsx", "client/src/pages/PessoasDashboard.tsx"]) expect(src(f), f).not.toContain("skipHours");
  });
  it("B9: o briefing diz que é a previsão da escala (03h–03h, parques que operamos)", () => {
    const card = src("client/src/components/aiOps/OpsBriefingCard.tsx");
    expect(card).toContain("previsão para a escala · dia operacional (03h–03h) · parques que operamos");
  });
  it("B13: o Dashboard das Operações já não fala nos totais do Financeiro nem só nos parques nossos", () => {
    const ops = src("client/src/pages/OperacoesDashboard.tsx");
    expect(ops).not.toContain("totais do Financeiro");
    expect(ops).not.toContain("parques nossos, sem compras online por acabar");
    expect(ops).toContain("todos os parques (nossos + Marketplace), com as compras por pagar");
  });
  it("os procedimentos: contagens só com Dashboards; o valor por cidade/marca só com os totais", () => {
    const r = src("server/routers.ts");
    const at = (name: string) => { const i = r.indexOf(`${name}: protectedProcedure`); return r.slice(i, r.indexOf("protectedProcedure", i + name.length + 30)); };
    expect(at("opsBookingCounts")).toContain(`requireAccess(ctx.user, "dashboards", "view")`);
    expect(at("opsBookingCounts")).not.toContain("requireFinanceTotals");
    expect(at("opsBookingValues")).toContain(`await requireFinanceTotals(ctx.user, "financeiro", "view")`);
    expect(at("opsBookingValues")).toContain("liveOpsBookingValues");
  });
});

// ─── "Igual": o dinheiro não muda ───────────────────────────────────────────

describe("igual — a Faturação, a Caixa, o motor e o MCP ficam como estavam", () => {
  it("a Faturação continua só com os parques nossos (os do Marketplace saem no toLiveBookingAgg)", () => {
    expect(parkIdsFor(CTX as any).sort()).toEqual(["pA", "pP"]);
    const row = (parkId: string) => ({ day: TODAY, parkId, partnerId: null, partnerName: null, paymentMethod: null, campaignName: null, discountCode: null, count: 1, total: 10, parking: 0, delivery: 0, extras: 0, paid: 0, remaining: 0, owingCount: 0, status: "CHECKED_OUT", pro: false, discount: 0, marketplace: false });
    expect(toLiveBookingAgg([row("pA"), row("pB"), row("pM")], CTX as any).map((r) => r.parkId)).toEqual(["pA"]);
  });

  it("o bookingStats (Financeiro, MCP, assistente) continua com os parques nossos e sem as por pagar", async () => {
    await liveBookingStats({}, NOW);
    const q = countsSqlCalls().at(-1)!;
    expect(q.params).toEqual(expect.arrayContaining(["pA", "pP"]));
    expect(q.params).not.toContain("pB");
    expect(q.sql).toContain(`NOT IN ('CANCELLED', 'PENDING')`);
  });

  it("o código das Entregas só LÊ (readFinanceAgg delivered) e nenhum ficheiro de dinheiro o usa", () => {
    const d = src("server/finance/deliveries.ts");
    expect(d).toContain(`readFinanceAgg({ kind: "delivered"`);
    expect(d).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
    for (const f of ["server/finance/liveBookings.ts", "server/finance/engine.ts", "server/finance/cash.ts", "server/multiparkDb/financeAgg.ts"]) {
      expect(src(f), f).not.toMatch(/(import\(|from )["'][./]*(finance\/)?deliveries["']|opsEvents|liveOpsBookingStats|opsStatsLive/);
    }
  });
});
