import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// Custos por centro (Projetos → Custos, P2.3 — 2 out 2026): o motor reparte
// cada parcela do custo pelo centro onde a soma a faz. Duas garantias:
//   1. a soma de todos os centros (com "Por atribuir") = costs.totalNet;
//   2. cada centro com os descendentes = a Faturação filtrada nesse centro.

vi.mock("../appSettings", () => ({ getSetting: vi.fn(async () => null) }));

// Grupo 1 → cidade 100 (Lisboa) → marcas 10 e 11 (folhas)
const TREE: Record<number, number[]> = { 1: [1, 100, 10, 11], 100: [100, 10, 11] };
let fakeDb: any = null;
const payroll: any[] = [];
vi.mock("../db", () => ({
  getDb: vi.fn(async () => fakeDb),
  resolveProjectIds: vi.fn(async (id: number) => TREE[id] ?? [id]),
  toMysqlDateTime: (d: Date) => d.toISOString().slice(0, 19).replace("T", " "),
  getPayrollData: vi.fn(async () => payroll),
}));
vi.mock("../extraRates", async (orig) => {
  const m: any = await orig();
  return { ...m, loadExtraRates: vi.fn(async () => ({ ...m.DEFAULT_EXTRA_RATES })) };
});
const ponto: any[] = [];
vi.mock("./extrasCost", async (orig) => {
  const m: any = await orig();
  return {
    ...m,
    loadExtrasCostRows: vi.fn(async (_db: any, q: any) => ({
      assignments: [],
      ponto: q.projectIds ? ponto.filter((r) => q.projectIds.includes(r.projectId)) : ponto,
    })),
  };
});
const delivered: any[] = [];
vi.mock("./liveBookings", async (orig) => {
  const m: any = await orig();
  return {
    ...m,
    loadLiveBookingAgg: vi.fn(async (kind: string, _range: any, projectIds: number[] | undefined) =>
      kind !== "delivered" ? [] : projectIds ? delivered.filter((r) => projectIds.includes(r.projectId)) : delivered),
  };
});

import { computeFinance } from "./engine";
import { DEFAULT_FINANCE_RATES } from "./rates";

const dialect = new MySqlDialect();
const agg = (o: any) => ({ day: "2026-08-10", projectId: null, parkId: "pk", campaign: null, paymentMethod: null, count: 1, total: 0, parking: 0, delivery: 0, extras: 0, paid: 0, remaining: 0, owingCount: 0, ...o });
const emp = (o: any) => ({ fullName: "Pessoa", projectId: null, contractType: "permanent", position: "driver", monthlySalary: 0, isActive: 1, contractStart: "2025-01-01", contractEnd: null, deactivatedAt: null, updatedAt: "2026-01-01 00:00:00", ...o });

const projects = [
  { id: 1, name: "Grupo", parentId: null, level: "group" },
  { id: 100, name: "Lisboa", parentId: 1, level: "city" },
  { id: 10, name: "Marca A", parentId: 100, level: "brand" },
  { id: 11, name: "Marca B", parentId: 100, level: "brand" },
];
const employees = [
  emp({ id: 1, projectId: 100, monthlySalary: 3100 }),   // cidade → metade em cada marca
  emp({ id: 2, projectId: 10, monthlySalary: 2000 }),
  emp({ id: 3, projectId: null, monthlySalary: 1000 }),  // sem centro → por atribuir
  emp({ id: 4, projectId: 11, contractType: "extra" }),  // extra: paga-se pelo ponto
];
const expenses = [
  { day: "2026-08-03", projectId: 10, projectName: "Marca A", categoryId: 1, categoryName: "Manutenção", excluded: 0, count: 1, totalAmount: 123, totalNet: 100 },
  { day: "2026-08-04", projectId: 100, projectName: "Lisboa", categoryId: 1, categoryName: "Manutenção", excluded: 0, count: 1, totalAmount: 246, totalNet: 200 },
  { day: "2026-08-05", projectId: null, projectName: null, categoryId: 1, categoryName: "Manutenção", excluded: 0, count: 1, totalAmount: 61.5, totalNet: 50 },
  { day: "2026-08-06", projectId: 11, projectName: "Marca B", categoryId: 2, categoryName: "Salários", excluded: 1, count: 1, totalAmount: 900, totalNet: 900 },
];
const partners = [
  { id: 1, name: "Agência", campaignKey: "AG", commissionRate: 10, partnerType: "agregador", commissionBase: "net", notes: null, monthlyFee: 0, partnerStatus: "active", updatedAt: "2026-01-01", configuredAt: "2026-01-01" },
  { id: 2, name: "Top", campaignKey: "TOP", commissionRate: 20, partnerType: "operacional", commissionBase: "net", notes: JSON.stringify({ operatesProjects: [10] }), monthlyFee: 0, partnerStatus: "active", updatedAt: "2026-01-01", configuredAt: "2026-01-01" },
];

function makeFakeDb() {
  const respond = (fields: Record<string, unknown>, where: any): any[] => {
    const k = Object.keys(fields ?? {});
    const has = (n: string) => k.includes(n);
    if (has("level") && has("parentId")) return projects;
    if (has("totalNet")) {
      // o motor filtra as despesas pelos centros (inArray → parâmetros numéricos)
      const ids = (where ? dialect.sqlToQuery(where).params : []).filter((p): p is number => typeof p === "number");
      return ids.length ? expenses.filter((e) => e.projectId != null && ids.includes(e.projectId)) : expenses;
    }
    if (has("supplier")) return [];
    if (has("campaignKey")) return partners;
    if (has("aliasValue")) return [];
    if (has("fullName")) return employees;
    return [];
  };
  return {
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
}

const run = (projectId?: number) => computeFinance({ from: "2026-08-01", to: "2026-08-31", today: "2026-09-10", granularity: "month", rates: DEFAULT_FINANCE_RATES, projectId });

beforeEach(() => {
  fakeDb = makeFakeDb();
  payroll.length = 0;
  payroll.push(
    { employeeId: 2, isExtra: false, overtimePayment: 100, nightPayment: 0, weekendPayment: 0, mealAllowance: 50 },
    { employeeId: 1, isExtra: false, overtimePayment: 60, nightPayment: 20, weekendPayment: 0, mealAllowance: 0 },
  );
  ponto.length = 0;
  ponto.push(
    { recordedAt: "2026-08-05 10:00:00", hours: 8, level: 1, employeeId: 4, projectId: 11 },
    { recordedAt: "2026-08-06 10:00:00", hours: 4, level: 2, employeeId: 5, projectId: null },
  );
  delivered.length = 0;
  delivered.push(
    agg({ projectId: 10, campaign: "ag", total: 123, parking: 123 }),
    agg({ projectId: 11, campaign: "ag", total: 246, parking: 246 }),
    agg({ projectId: 10, total: 100, parking: 100 }),
  );
});

const byId = (r: Awaited<ReturnType<typeof run>>) => new Map(r.details.costsByProject.map((c) => [c.projectId, c]));
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

describe("custos por centro (motor das Finanças)", () => {
  it("a soma de todos os centros (com 'Por atribuir') é o custo total; cada parcela soma com o seu total", async () => {
    const r = await run();
    const rows = r.details.costsByProject;
    expect(sum(rows.map((c) => c.total))).toBeCloseTo(r.costs.totalNet, 6);
    expect(sum(rows.map((c) => c.expensesNet))).toBeCloseTo(r.costs.expensesNet, 6);
    expect(sum(rows.map((c) => c.expenses))).toBeCloseTo(r.costs.expenses, 6);
    expect(sum(rows.map((c) => c.salaries))).toBeCloseTo(r.costs.salaries, 6);
    expect(sum(rows.map((c) => c.employerTax))).toBeCloseTo(r.costs.employerTax, 6);
    expect(sum(rows.map((c) => c.extras))).toBeCloseTo(r.costs.extrasDia, 6);
    expect(sum(rows.map((c) => c.salesCommissions))).toBeCloseTo(r.costs.salesCommissions, 6);
    expect(sum(rows.map((c) => c.operationalCommissions))).toBeCloseTo(r.costs.operationalCommissions, 6);
    // houve de tudo (o teste não passa por estar tudo a zero)
    for (const k of ["expensesNet", "salaries", "employerTax", "extras", "salesCommissions", "operationalCommissions"] as const) {
      expect(r.costs[k === "extras" ? "extrasDia" : k], k).toBeGreaterThan(0);
    }
  });

  it("onde cai cada coisa: pessoal da cidade repartido pelas marcas, sem centro → por atribuir, excluídas da margem fora", async () => {
    const c = byId(await run());
    // salário da cidade (3100) repartido em partes iguais pelas folhas 10 e 11
    const e2 = (2000 * 14) / 12 + 150; // salário com provisões de 13.º/14.º + variável (horas extra 100 + alimentação 50)
    expect(c.get(10)!.salaries - e2).toBeCloseTo(c.get(11)!.salaries, 6);
    expect(c.get(100)?.salaries ?? 0).toBe(0);                 // a cidade não fica com pessoal (vai às folhas)
    expect(c.get(100)!.expensesNet).toBe(200);                  // a despesa fica no centro onde foi lançada
    expect(c.get(null)!.salaries).toBeGreaterThan(0);           // pessoa sem centro
    expect(c.get(null)!.extras).toBeGreaterThan(0);             // ponto de extra sem centro
    expect(c.get(null)!.expensesNet).toBe(50);
    expect(c.get(11)!.extras).toBeGreaterThan(0);
    expect(c.get(11)!.expensesNet).toBe(0);                     // categoria "excluir da margem" não soma
    expect(c.get(10)!.operationalCommissions).toBeGreaterThan(0); // operado pela Top
    expect(c.get(11)!.salesCommissions).toBeGreaterThan(0);
  });

  it("cada centro com os descendentes dá o mesmo que a Faturação filtrada nesse centro", async () => {
    const all = byId(await run());
    for (const pid of [1, 100, 10, 11]) {
      const filtered = await run(pid);
      const expected = sum((TREE[pid] ?? [pid]).map((id) => all.get(id)?.total ?? 0));
      expect(filtered.costs.totalNet, `centro ${pid}`).toBeCloseTo(expected, 6);
      expect(filtered.details.costsByProject.some((c) => c.projectId == null), `centro ${pid}`).toBe(false);
    }
  });
});
