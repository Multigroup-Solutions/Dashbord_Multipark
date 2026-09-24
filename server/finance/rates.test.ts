import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// ─── Mocks (BD / definições / fontes externas do motor) ──────────────────────
const saved: { vat: unknown; tsu: unknown } = { vat: null, tsu: null };
vi.mock("../appSettings", () => ({
  getSetting: vi.fn(async (key: string) => (key === "finance.vat" ? saved.vat : key === "finance.tsu" ? saved.tsu : null)),
}));

let fakeDb: any = null;
vi.mock("../db", () => ({
  getDb: vi.fn(async () => fakeDb),
  resolveProjectIds: vi.fn(async (id: number) => [id]),
  toMysqlDateTime: (d: Date) => d.toISOString().slice(0, 19).replace("T", " "),
  getPayrollData: vi.fn(async () => []),
}));
vi.mock("../extraRates", async (orig) => {
  const m: any = await orig();
  return { ...m, loadExtraRates: vi.fn(async () => ({ ...m.DEFAULT_EXTRA_RATES })) };
});
vi.mock("./extrasCost", async (orig) => {
  const m: any = await orig();
  return { ...m, loadExtrasCostRows: vi.fn(async () => ({ assignments: [], ponto: [] })) };
});
vi.mock("../integrations/googleAds/adMetrics", () => ({
  getAdMetrics: vi.fn(async () => ({ totals: { cost: 0 }, byCampaign: [] })),
}));

import {
  DEFAULT_FINANCE_RATES, invalidateFinanceRatesCache, loadFinanceRates, makeFinanceRates,
  rateCaseSql, rateOn, resolveFinanceRates, splitByRate, vatRateForPeriod, financeRatesAt,
} from "./rates";
import { FINANCE_PARAMS } from "./rules";
import { computeFinance } from "./engine";

const VAT = [{ rate: 0.23, from: "2011-01-01" }, { rate: 0.2, from: "2026-01-15" }];
const TSU = [{ rate: 0.2375, from: "2011-01-01" }, { rate: 0.25, from: "2026-01-16" }];

beforeEach(() => {
  saved.vat = null; saved.tsu = null;
  invalidateFinanceRatesCache();
});

describe("taxas com data de efeito — resolução", () => {
  it("antes, no dia e entre datas de efeito", () => {
    expect(rateOn(VAT, "2010-12-31", 0.99)).toBe(0.99);  // antes da 1.ª → fallback
    expect(rateOn(VAT, "2011-01-01", 0.99)).toBe(0.23);  // no próprio dia
    expect(rateOn(VAT, "2020-06-30", 0.99)).toBe(0.23);  // entre datas
    expect(rateOn(VAT, "2026-01-14", 0.99)).toBe(0.23);
    expect(rateOn(VAT, "2026-01-15", 0.99)).toBe(0.2);   // no dia da mudança
    expect(rateOn(VAT, "2030-01-01", 0.99)).toBe(0.2);   // depois da última
  });

  it("lista desordenada: vale a data de efeito mais recente <= dia", () => {
    const list = [{ rate: 0.2, from: "2026-01-15" }, { rate: 0.23, from: "2011-01-01" }];
    expect(rateOn(list, "2026-01-20", 0)).toBe(0.2);
    expect(rateOn(list, "2025-01-20", 0)).toBe(0.23);
  });

  it("sem nada gravado → FINANCE_PARAMS", () => {
    expect(DEFAULT_FINANCE_RATES.vatOn("2026-01-20")).toBe(FINANCE_PARAMS.vatRate);
    expect(DEFAULT_FINANCE_RATES.tsuOn("2026-01-20")).toBe(FINANCE_PARAMS.tsuEmployerRate);
    const r = makeFinanceRates([], null);
    expect(r.vat).toBeNull();
    expect(r.vatOn("2026-01-20")).toBe(FINANCE_PARAMS.vatRate);
  });

  it("parte o período nas datas de efeito (e junta taxas iguais)", () => {
    expect(splitByRate(VAT, "2026-01-01", "2026-01-31", 0.23)).toEqual([
      { from: "2026-01-01", to: "2026-01-14", rate: 0.23 },
      { from: "2026-01-15", to: "2026-01-31", rate: 0.2 },
    ]);
    expect(splitByRate(VAT, "2026-02-01", "2026-02-28", 0.23)).toEqual([{ from: "2026-02-01", to: "2026-02-28", rate: 0.2 }]);
    expect(splitByRate(null, "2026-01-01", "2026-01-31", 0.23)).toEqual([{ from: "2026-01-01", to: "2026-01-31", rate: 0.23 }]);
    // nova data com a MESMA taxa → um só sub-período
    expect(splitByRate([{ rate: 0.23, from: "2011-01-01" }, { rate: 0.23, from: "2026-01-10" }], "2026-01-01", "2026-01-31", 0.5))
      .toEqual([{ from: "2026-01-01", to: "2026-01-31", rate: 0.23 }]);
    // período começa antes da 1.ª data → fallback até lá
    expect(splitByRate([{ rate: 0.2, from: "2026-01-10" }], "2026-01-01", "2026-01-31", 0.23)).toEqual([
      { from: "2026-01-01", to: "2026-01-09", rate: 0.23 },
      { from: "2026-01-10", to: "2026-01-31", rate: 0.2 },
    ]);
  });

  it("SQL: taxa por sub-período SEMPRE como parâmetro", () => {
    const dialect = new MySqlDialect();
    const day = sql`DATE(e.expenseDate)`;
    const one = dialect.sqlToQuery(rateCaseSql(day, [{ from: "2026-01-01", to: "2026-01-31", rate: 0.2 }], 0.23));
    expect(one.sql).toBe("?");
    expect(one.params).toEqual([0.2]);
    const two = dialect.sqlToQuery(rateCaseSql(day, splitByRate(VAT, "2026-01-01", "2026-01-31", 0.23), 0.23));
    expect(two.sql).toBe("(CASE WHEN DATE(e.expenseDate) < ? THEN ? ELSE ? END)");
    expect(two.params).toEqual(["2026-01-15", 0.23, 0.2]);
    expect(two.sql).not.toContain("0.2");
  });
});

describe("taxas gravadas — leitura, cache e período", () => {
  it("sem nada gravado → constantes; gravado → usa a lista", async () => {
    expect(await financeRatesAt("2026-01-20")).toEqual({ vatRate: 0.23, tsuEmployerRate: 0.2375 });
    saved.vat = VAT; saved.tsu = TSU;
    invalidateFinanceRatesCache();
    expect(await financeRatesAt("2026-01-20")).toEqual({ vatRate: 0.2, tsuEmployerRate: 0.25 });
    expect(await vatRateForPeriod("2026-01-01", "2026-01-10")).toBe(0.23);
    expect(await vatRateForPeriod("2026-01-01", "2026-01-31")).toBe(0.2); // ROAS: taxa do fim do período
  });

  it("cache de 60 s, invalidada ao gravar", async () => {
    await loadFinanceRates();
    saved.vat = VAT;
    expect((await loadFinanceRates()).vatOn("2026-02-01")).toBe(0.23); // ainda em cache
    invalidateFinanceRatesCache();
    expect((await loadFinanceRates()).vatOn("2026-02-01")).toBe(0.2);
  });

  it("resolveFinanceRates dá sub-períodos e a taxa do fim", async () => {
    saved.vat = VAT; saved.tsu = TSU;
    const r = await resolveFinanceRates("2026-01-01", "2026-01-31");
    expect(r.vatPeriods).toHaveLength(2);
    expect(r.tsuPeriods).toEqual([
      { from: "2026-01-01", to: "2026-01-15", rate: 0.2375 },
      { from: "2026-01-16", to: "2026-01-31", rate: 0.25 },
    ]);
    expect(r.vatAtEnd).toBe(0.2);
    expect(r.tsuAtEnd).toBe(0.25);
  });
});

// ─── Motor: totais com / sem taxas gravadas ──────────────────────────────────

/** BD falsa: cada select devolve linhas conforme os campos pedidos. */
function makeFakeDb() {
  const captured: { expenseFields?: any } = {};
  let multiparkPlainSelects = 0;
  const respond = (fields: Record<string, unknown>): any[] => {
    const k = Object.keys(fields ?? {});
    const has = (n: string) => k.includes(n);
    if (has("level") && has("parentId")) return [];                          // projetos
    if (has("parkingRevenue")) return [                                       // entregues
      { day: "2026-01-10", projectId: null, projectName: null, count: 1, totalRevenue: 1230, parkingRevenue: 1230, deliveryCharges: 0, extrasRevenue: 0 },
      { day: "2026-01-20", projectId: null, projectName: null, count: 1, totalRevenue: 1230, parkingRevenue: 1230, deliveryCharges: 0, extrasRevenue: 0 },
    ];
    if (has("campaign")) return [];
    if (has("totalNet")) { captured.expenseFields = fields; return []; }      // despesas
    if (has("supplier")) return [];                                           // pendentes
    if (has("campaignKey") || has("aliasValue")) return [];                   // parceiros
    if (has("fullName")) return [                                             // colaboradores
      { id: 1, fullName: "Pessoa", projectId: null, contractType: "fixed", position: "operador", monthlySalary: 3100, isActive: 1, contractStart: "2025-01-01", contractEnd: null },
    ];
    if (has("employeeId") && has("effectiveFrom")) return [];                 // histórico salarial
    if (has("total")) return [{ total: 0 }];                                  // marketing
    if (has("day") && has("totalRevenue")) {                                  // recolhidos, depois previsão
      multiparkPlainSelects++;
      return multiparkPlainSelects === 1 ? [{ day: "2026-01-20", projectId: null, projectName: null, count: 1, totalRevenue: 1230 }] : [];
    }
    return [];
  };
  const db = {
    select(fields: Record<string, unknown>) {
      const rows = respond(fields);
      const chain: any = {
        from: () => chain, leftJoin: () => chain, innerJoin: () => chain, where: () => chain, groupBy: () => chain, orderBy: () => chain,
        then: (res: any, rej: any) => Promise.resolve(rows).then(res, rej),
      };
      return chain;
    },
    execute: async () => [[]],
  };
  return { db, captured };
}

describe("motor de finanças usa as taxas das Definições", () => {
  const filters = { from: "2026-01-01", to: "2026-01-31", granularity: "month" as const, today: "2026-02-15" };

  it("sem nada gravado: totais iguais aos de sempre (FINANCE_PARAMS)", async () => {
    fakeDb = makeFakeDb().db;
    const r = await computeFinance(filters);
    expect(r.revenue.produced).toBe(2460);
    expect(r.revenue.producedNet).toBeCloseTo(2000, 6);
    expect(r.revenue.collectedNet).toBeCloseTo(1000, 6);
    expect(r.costs.employerTax).toBeCloseTo(3100 * 0.2375, 6);
    expect(r.params.vatRate).toBe(0.23);
    expect(r.params.tsuEmployerRate).toBe(0.2375);
    // mesmos números com as constantes injetadas explicitamente
    fakeDb = makeFakeDb().db;
    const same = await computeFinance({ ...filters, rates: DEFAULT_FINANCE_RATES });
    expect(same.margin).toEqual(r.margin);
  });

  it("com taxas gravadas: parte o período na data de efeito e os totais mudam", async () => {
    saved.vat = VAT; saved.tsu = TSU;
    invalidateFinanceRatesCache();
    const { db, captured } = makeFakeDb();
    fakeDb = db;
    const r = await computeFinance(filters);
    // receita: dia 10 a 23% (1000) + dia 20 a 20% (1025)
    expect(r.revenue.producedNet).toBeCloseTo(2025, 6);
    expect(r.revenue.collectedNet).toBeCloseTo(1025, 6);
    // TSU: 15 dias a 23,75% + 16 dias a 25% sobre 100 €/dia
    expect(r.costs.employerTax).toBeCloseTo(1500 * 0.2375 + 1600 * 0.25, 6);
    expect(r.params.vatRate).toBe(0.2);
    expect(r.params.vatPeriods).toEqual([
      { from: "2026-01-01", to: "2026-01-14", rate: 0.23 },
      { from: "2026-01-15", to: "2026-01-31", rate: 0.2 },
    ]);
    // série mensal coerente com os totais
    expect(r.timeseries.reduce((s, p) => s + p.producedNet, 0)).toBeCloseTo(2025, 6);
    // despesas sem IVA (SQL): taxa por sub-período como parâmetro
    const q = new MySqlDialect().sqlToQuery(captured.expenseFields.totalNet);
    expect(q.params).toEqual(expect.arrayContaining(["2026-01-15", 0.23, 0.2]));
    expect(q.sql).toContain("CASE WHEN");
  });
});
