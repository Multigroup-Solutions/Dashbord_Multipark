import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { and } from "drizzle-orm";

// ─── Mocks (BD / definições / fontes externas do motor) ──────────────────────
vi.mock("../appSettings", () => ({ getSetting: vi.fn(async () => null) }));

let fakeDb: any = null;
const payroll: any[] = [];
vi.mock("../db", () => ({
  getDb: vi.fn(async () => fakeDb),
  // centro 100 = cidade com as marcas 10 e 11
  resolveProjectIds: vi.fn(async (id: number) => (id === 100 ? [100, 10, 11] : [id])),
  toMysqlDateTime: (d: Date) => d.toISOString().slice(0, 19).replace("T", " "),
  getPayrollData: vi.fn(async () => payroll),
}));
vi.mock("../extraRates", async (orig) => {
  const m: any = await orig();
  return { ...m, loadExtraRates: vi.fn(async () => ({ ...m.DEFAULT_EXTRA_RATES })) };
});
const extrasRows: { assignments: any[]; ponto: any[] } = { assignments: [], ponto: [] };
const extrasQuery: any[] = [];
vi.mock("./extrasCost", async (orig) => {
  const m: any = await orig();
  return { ...m, loadExtrasCostRows: vi.fn(async (_db: any, q: any) => { extrasQuery.push(q); return extrasRows; }) };
});
const adMetrics = vi.fn(async () => ({ totals: { cost: 50 }, byCampaign: [] }));
vi.mock("../integrations/googleAds/adMetrics", () => ({ getAdMetrics: adMetrics }));

import { computeFinance, deliveredConditions, bookingLisbonDay, monthlyRowsFromTimeseries } from "./engine";
import { DEFAULT_FINANCE_RATES } from "./rates";
import { lisbonDayOf, lisbonDayRangeUtc } from "../../shared/lisbonDay";

const dialect = new MySqlDialect();
const render = (s: any) => (s ? dialect.sqlToQuery(s) : { sql: "", params: [] as unknown[] });

/**
 * BD falsa: cada select devolve linhas conforme os campos pedidos e o WHERE
 * (renderizado) — as reservas previstas distinguem-se por excluírem CANCELLED.
 */
interface Data {
  deliveries?: any[]; campaigns?: any[]; collected?: any[]; expenses?: any[]; forecast?: any[];
  partners?: any[]; aliases?: any[]; employees?: any[];
}
function makeFakeDb(data: Data) {
  const captured: { expenseFields?: any; deliveryWhere?: any; forecastWhere?: any } = {};
  const respond = (fields: Record<string, unknown>, where: any): any[] => {
    const k = Object.keys(fields ?? {});
    const has = (n: string) => k.includes(n);
    if (has("level") && has("parentId")) return [];                          // projetos
    if (has("parkingRevenue")) { captured.deliveryWhere = where; return data.deliveries ?? []; }
    if (has("campaign") && has("day")) {
      const w = render(where);
      if (w.params.includes("CANCELLED")) { captured.forecastWhere = where; return data.forecast ?? []; }
      return data.campaigns ?? [];
    }
    if (has("totalNet")) { captured.expenseFields = fields; return data.expenses ?? []; }
    if (has("supplier")) return [];                                           // pendentes
    if (has("campaignKey")) return data.partners ?? [];
    if (has("aliasValue")) return data.aliases ?? [];
    if (has("fullName")) return data.employees ?? [];
    if (has("employeeId") && has("effectiveFrom")) return [];
    if (has("total")) return [{ total: 7 }];                                  // marketing
    if (has("day") && has("totalRevenue")) return data.collected ?? [];      // recolhidos
    return [];
  };
  const db = {
    select(fields: Record<string, unknown>) {
      let where: any;
      const chain: any = {
        from: () => chain, leftJoin: () => chain, innerJoin: () => chain, groupBy: () => chain, orderBy: () => chain,
        where: (w: any) => { where = w; return chain; },
        then: (res: any, rej: any) => Promise.resolve(respond(fields, where)).then(res, rej),
      };
      return chain;
    },
    execute: async () => [[]],
  };
  return { db, captured };
}

const emp = (o: any = {}) => ({ id: 1, fullName: "Pessoa", projectId: null, contractType: "permanent", position: "driver", monthlySalary: 3100, isActive: 1, contractStart: "2025-01-01", contractEnd: null, deactivatedAt: null, updatedAt: "2026-01-01 00:00:00", ...o });

beforeEach(() => {
  extrasRows.assignments = []; extrasRows.ponto = []; extrasQuery.length = 0; payroll.length = 0;
  adMetrics.mockClear();
});

// ─── 1. Dias de Lisboa ───────────────────────────────────────────────────────
describe("dias de Lisboa no motor", () => {
  it("saída às 23:30 UTC de 31/07 é AGOSTO (período de Lisboa em UTC)", () => {
    const aug = lisbonDayRangeUtc("2026-08-01", "2026-08-31");
    const jul = lisbonDayRangeUtc("2026-07-01", "2026-07-31");
    expect(aug.start).toBe("2026-07-31 23:00:00");
    expect(jul.end).toBe("2026-07-31 23:00:00");
    const at = "2026-07-31 23:30:00";
    expect(at >= aug.start && at < aug.end).toBe(true);
    expect(at >= jul.start && at < jul.end).toBe(false);
    expect(lisbonDayOf(at)).toBe("2026-08-01");
  });
  it("filtro da receita realizada: CHECKED_OUT com saída em [início, fim) de Lisboa, parametrizado", () => {
    const q = render(sqlAnd(deliveredConditions("2026-08-01", "2026-08-31", [5])));
    expect(q.params).toEqual(expect.arrayContaining(["2026-07-31 23:00:00", "2026-08-31 23:00:00", "CHECKED_OUT", 5]));
    expect(q.sql).toContain("< ?");
    // dia de Lisboa no SQL: +1 h no verão (sem tabelas de fusos do MySQL)
    const d = render(bookingLisbonDay("checkOut", "2026-08-01", "2026-08-31"));
    expect(d.sql).toContain("INTERVAL 1 HOUR");
    expect(d.params).toEqual([]);   // literais → mesmo texto no SELECT e no GROUP BY
    // mudança de hora a meio (outubro): CASE por troço
    expect(render(bookingLisbonDay("checkIn", "2026-10-01", "2026-10-31")).sql).toContain("CASE WHEN");
  });
  it("ponto dos extras em dias de Lisboa: 23:30 UTC de 31/07 conta a 1/08", async () => {
    extrasRows.ponto = [{ recordedAt: "2026-07-31 23:30:00", hours: 8, level: 1, employeeId: 3, projectId: null }];
    fakeDb = makeFakeDb({}).db;
    const r = await computeFinance({ from: "2026-08-01", to: "2026-08-31", today: "2026-09-10", granularity: "day", rates: DEFAULT_FINANCE_RATES });
    expect(extrasQuery[0].pontoRange).toEqual({ start: "2026-07-31 23:00:00", endExclusive: "2026-08-31 23:00:00" });
    expect(r.costs.extrasDia).toBeGreaterThan(0);
    expect(r.timeseries.find((p) => p.extrasCost > 0)?.bucket).toBe("2026-08-01");
  });
});

const sqlAnd = (conds: any[]) => and(...conds);

// ─── 2. Comissões ────────────────────────────────────────────────────────────
describe("comissões: base sem IVA e sem comissão a dobrar", () => {
  const partners = [
    { id: 1, name: "Agência", campaignKey: "AG", commissionRate: 10, partnerType: "agregador", commissionBase: "net", notes: null, monthlyFee: 0, partnerStatus: "active", updatedAt: "2026-01-01", configuredAt: "2026-01-01" },
    { id: 2, name: "Top Parking", campaignKey: "TOP", commissionRate: 20, partnerType: "operacional", commissionBase: "net", notes: JSON.stringify({ operatesProjects: [10] }), monthlyFee: 0, partnerStatus: "active", updatedAt: "2026-01-01", configuredAt: "2026-01-01" },
    { id: 3, name: "Bruto", campaignKey: "BR", commissionRate: 10, partnerType: "agregador", commissionBase: "gross", notes: null, monthlyFee: 0, partnerStatus: "active", updatedAt: "2026-01-01", configuredAt: "2026-01-01" },
  ];
  const deliveries = [
    { day: "2026-08-10", projectId: 10, projectName: "Porto A", count: 2, totalRevenue: 246, parkingRevenue: 246, deliveryCharges: 0, extrasRevenue: 0 },
    { day: "2026-08-10", projectId: 11, projectName: "Porto B", count: 2, totalRevenue: 246, parkingRevenue: 246, deliveryCharges: 0, extrasRevenue: 0 },
  ];
  const campaigns = [
    { day: "2026-08-10", projectId: 10, projectName: "Porto A", campaign: "top", count: 1, totalRevenue: 123 },  // operado pelo próprio → sem venda
    { day: "2026-08-10", projectId: 11, projectName: "Porto B", campaign: "top", count: 1, totalRevenue: 123 },  // outro centro → cobra venda
    { day: "2026-08-10", projectId: 11, projectName: "Porto B", campaign: "ag", count: 1, totalRevenue: 123 },
    { day: "2026-08-10", projectId: 10, projectName: "Porto A", campaign: "br", count: 1, totalRevenue: 123 },
  ];
  it("venda e operacional sobre o valor SEM IVA; operacional não cobra venda no centro que opera", async () => {
    fakeDb = makeFakeDb({ deliveries, campaigns, partners }).db;
    const r = await computeFinance({ from: "2026-08-01", to: "2026-08-31", today: "2026-09-10", rates: DEFAULT_FINANCE_RATES });
    // Operacional: 20% de 246/1,23 = 40 (antes: 20% de 246 = 49,20)
    expect(r.costs.operationalCommissions).toBeCloseTo(40, 6);
    // Venda: top@11 20% de 100 = 20; ag 10% de 100 = 10; br (gross) 10% de 123 = 12,30; top@10 = 0
    expect(r.costs.salesCommissions).toBeCloseTo(20 + 10 + 12.3, 6);
    expect(r.quality.salesCommissionsCoveredByOperational).toEqual({ count: 1, revenueGross: 123 });
    const ag = r.details.salesCommissions.find((c) => c.partnerId === 1)!;
    expect(ag.revenueNet).toBeCloseTo(100, 6);
    expect(ag.commissionBase).toBe("net");
    expect(r.details.salesCommissions.find((c) => c.partnerId === 3)!.commissionBase).toBe("gross");
  });
});

// ─── 3. Despesas: excluídas da margem e autoliquidação ──────────────────────
describe("despesas: categorias excluídas e autoliquidação", () => {
  it("categoria 'excluir da margem' não soma aos custos e aparece no aviso", async () => {
    const expenses = [
      { day: "2026-08-05", projectId: null, projectName: null, categoryId: 1, categoryName: "Rendas", excluded: 0, count: 1, totalAmount: 500, totalNet: 500 },
      { day: "2026-08-05", projectId: null, projectName: null, categoryId: 2, categoryName: "Recursos Humanos", excluded: 1, count: 2, totalAmount: 3000, totalNet: 3000 },
    ];
    const { db } = makeFakeDb({ expenses });
    fakeDb = db;
    const r = await computeFinance({ from: "2026-08-01", to: "2026-08-31", today: "2026-09-10", rates: DEFAULT_FINANCE_RATES });
    expect(r.costs.expenses).toBe(500);
    expect(r.costs.expensesNet).toBe(500);
    expect(r.quality.excludedExpenses).toEqual({ count: 2, total: 3000, categories: [{ name: "Recursos Humanos", total: 3000 }] });
    expect(r.details.expenses.map((e) => e.categoryName)).toEqual(["Rendas"]);
    expect(r.details.expensesExcluded.map((e) => e.categoryName)).toEqual(["Recursos Humanos"]);
  });
  it("autoliquidação: IVA 0% no SQL do custo líquido (antes caía nos 23%)", async () => {
    const { db, captured } = makeFakeDb({});
    fakeDb = db;
    await computeFinance({ from: "2026-08-01", to: "2026-08-31", today: "2026-09-10", rates: DEFAULT_FINANCE_RATES });
    const q = render(captured.expenseFields.totalNet);
    expect(q.sql).toMatch(/CASE WHEN COALESCE\(`expense_categories`.`reverseCharge`, 0\) = 1 THEN 0 ELSE COALESCE\(`expense_categories`.`vatRate` \/ 100/);
    const ex = render(captured.expenseFields.excluded);
    expect(ex.sql).toContain("MAX(COALESCE(`expense_categories`.`excludeFromMargin`, 0))");
  });
});

// ─── 4. Pessoal: TSU nas provisões, período em curso e inativos ─────────────
describe("pessoal", () => {
  it("TSU sobre base + provisões de 13.º/14.º", async () => {
    fakeDb = makeFakeDb({ employees: [emp()] }).db;
    const r = await computeFinance({ from: "2026-08-01", to: "2026-08-31", today: "2026-09-10", rates: DEFAULT_FINANCE_RATES });
    expect(r.costs.salariesBase).toBeCloseTo(3100, 6);
    expect(r.costs.salariesProvisions).toBeCloseTo(3100 * 2 / 12, 6);
    expect(r.costs.employerTax).toBeCloseTo(3100 * (1 + 2 / 12) * 0.2375, 6);
  });

  it("período em curso: realizado cortado em hoje; fecho previsto soma a receita esperada e os custos do mês inteiro", async () => {
    const deliveries = [{ day: "2026-08-10", projectId: null, projectName: null, count: 1, totalRevenue: 1230, parkingRevenue: 1230, deliveryCharges: 0, extrasRevenue: 0 }];
    const forecast = [
      { day: "2026-08-20", projectId: null, projectName: null, campaign: null, count: 2, totalRevenue: 2460 },
      { day: "2026-08-12", projectId: null, projectName: null, campaign: null, count: 1, totalRevenue: 123 },   // estacionado, saída atrasada → conta hoje
    ];
    const { db, captured } = makeFakeDb({ deliveries, forecast, employees: [emp()] });
    fakeDb = db;
    const r = await computeFinance({ from: "2026-08-01", to: "2026-08-31", today: "2026-08-15", granularity: "day", rates: DEFAULT_FINANCE_RATES });
    expect(r.quality.isCurrentPeriod).toBe(true);
    // Realizado até hoje: 15 de 31 dias de salário
    expect(r.costs.salariesBase).toBeCloseTo(3100 * 15 / 31, 6);
    const perDay = (3100 / 31) * (1 + 2 / 12) * (1 + 0.2375);
    expect(r.margin.margin).toBeCloseTo(1000 - perDay * 15, 6);
    // Fecho previsto: receita esperada (2583 c/ IVA = 2100 s/ IVA) + custos dos 31 dias
    expect(r.forecast.revenue).toBeCloseTo(2583, 6);
    expect(r.forecast.revenueNet).toBeCloseTo(2100, 6);
    expect(r.forecast.from).toBe("2026-08-15");
    expect(r.projection.applies).toBe(true);
    expect(r.projection.revenueNet).toBeCloseTo(3100, 6);
    expect(r.projection.costsNet).toBeCloseTo(perDay * 31, 6);
    expect(r.projection.margin).toBeCloseTo(3100 - perDay * 31, 6);
    // saída atrasada entra no dia de hoje; custos futuros não entram na margem realizada
    expect(r.timeseries.find((p) => p.bucket === "2026-08-15")?.revenueForecast).toBeCloseTo(123, 6);
    const future = r.timeseries.find((p) => p.bucket === "2026-08-20")!;
    expect(future.totalCost).toBe(0);
    expect(future.costForecast).toBeCloseTo(perDay, 6);
    // previsão = saída prevista no período (não check-in), sem canceladas/entregues
    const w = render(captured.forecastWhere);
    expect(w.sql).toContain("`multipark_bookings`.`checkOut` >= ?");
    expect(w.params).toEqual(expect.arrayContaining(["2026-07-31 23:00:00", "2026-08-31 23:00:00", "CANCELLED", "CHECKED_OUT", "CHECKED_IN", "2026-08-14 23:00:00"]));
  });

  it("período fechado: sem previsão; Anual não mostra prejuízo em meses futuros", async () => {
    const { db, captured } = makeFakeDb({ employees: [emp()] });
    fakeDb = db;
    const closed = await computeFinance({ from: "2026-07-01", to: "2026-07-31", today: "2026-08-15", rates: DEFAULT_FINANCE_RATES });
    expect(captured.forecastWhere).toBeUndefined();
    expect(closed.projection.applies).toBe(false);
    expect(closed.projection.margin).toBeCloseTo(closed.margin.margin, 6);

    fakeDb = makeFakeDb({ employees: [emp()] }).db;
    const year = await computeFinance({ from: "2026-01-01", to: "2026-12-31", today: "2026-08-15", granularity: "month", rates: DEFAULT_FINANCE_RATES });
    const rows = monthlyRowsFromTimeseries(year);
    const nov = rows.find((m) => m.month === 11)!;
    expect(nov.status).toBe("future");
    expect(nov.totalCosts).toBe(0);
    expect(nov.profit).toBe(0);
    expect(nov.forecastCosts).toBeGreaterThan(0);   // custo previsto, não prejuízo realizado
    expect(rows.find((m) => m.month === 8)!.status).toBe("current");
    expect(rows.find((m) => m.month === 3)!.status).toBe("past");
  });

  it("inativo sem fim de contrato conta até à desativação e fica no aviso", async () => {
    const employees = [emp({ id: 5, fullName: "Saiu", isActive: 0, deactivatedAt: "2026-08-10 12:00:00" })];
    fakeDb = makeFakeDb({ employees }).db;
    const r = await computeFinance({ from: "2026-08-01", to: "2026-08-31", today: "2026-09-10", rates: DEFAULT_FINANCE_RATES });
    expect(r.costs.salariesBase).toBeCloseTo(3100 * 10 / 31, 6);   // antes: 0 (ignorado)
    expect(r.quality.inactiveWithoutContractEnd).toEqual([{ employeeId: 5, fullName: "Saiu", assumedEnd: "2026-08-10" }]);
    fakeDb = makeFakeDb({ employees }).db;
    const later = await computeFinance({ from: "2026-09-01", to: "2026-09-30", today: "2026-10-10", rates: DEFAULT_FINANCE_RATES });
    expect(later.costs.salariesBase).toBe(0);
    expect(later.quality.inactiveWithoutContractEnd).toEqual([]);   // já não pesa neste período
  });
});

// ─── 5. Qualidade ────────────────────────────────────────────────────────────
describe("qualidade", () => {
  it("reservas sem centro (valor e contagem) e marketing só a pedido", async () => {
    const deliveries = [
      { day: "2026-08-10", projectId: null, projectName: null, count: 3, totalRevenue: 300, parkingRevenue: 300, deliveryCharges: 0, extrasRevenue: 0 },
      { day: "2026-08-10", projectId: 10, projectName: "A", count: 1, totalRevenue: 100, parkingRevenue: 100, deliveryCharges: 0, extrasRevenue: 0 },
    ];
    fakeDb = makeFakeDb({ deliveries }).db;
    const r = await computeFinance({ from: "2026-08-01", to: "2026-08-31", today: "2026-09-10", rates: DEFAULT_FINANCE_RATES });
    expect(r.quality.bookingsWithoutProject).toEqual({ count: 3, total: 300 });
    expect(r.quality.marketingExcluded).toBeNull();
    expect(adMetrics).not.toHaveBeenCalled();
    fakeDb = makeFakeDb({ deliveries }).db;
    const withMkt = await computeFinance({ from: "2026-08-01", to: "2026-08-31", today: "2026-09-10", rates: DEFAULT_FINANCE_RATES, includeMarketingCoverage: true });
    expect(withMkt.quality.marketingExcluded).toEqual({ adSpend: 50, marketingExpenses: 7 });
  });
});
