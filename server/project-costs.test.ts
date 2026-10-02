import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

// Projetos → Custos (P2.3 — 2 out 2026): custos do motor das Finanças (iguais
// à Faturação) vs. orçamento ANUAL. Antes: cálculo próprio com o salário de
// hoje, 1 mês de salários no "Ano inteiro", quem saiu a contar e pessoas em
// dois projetos a contar a dobrar.

const state = vi.hoisted(() => ({
  finance: null as any,
  financeCalls: [] as any[],
  projects: [] as any[],
  scoped: undefined as number[] | undefined,
  access: { all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false } as any,
}));

vi.mock("./cityAccess", async (original) => ({ ...(await original<object>()), loadCityAccess: async () => state.access }));
vi.mock("./cityScope", async (original) => ({ ...(await original<object>()), scopedProjectIds: () => state.scoped }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getProjects: async () => state.projects,
  getDb: async () => ({
    select: () => ({ from: () => ({ where: async () => [{ id: 7, name: "Gestora", email: "g@x.pt" }] }) }),
  }),
}));
vi.mock("./finance/engine", async (original) => ({
  ...(await original<object>()),
  computeFinance: async (f: any) => { state.financeCalls.push(f); return state.finance; },
}));

import { appRouter } from "./routers";
import { budgetForPeriod, projectCostsPeriod, projectCostsReport } from "./finance/projectCosts";

const cost = (projectId: number | null, o: any = {}) => ({ projectId, expensesNet: 0, expenses: 0, salaries: 0, employerTax: 0, extras: 0, salesCommissions: 0, operationalCommissions: 0, total: 0, ...o });
const node = (o: any) => ({ parentId: null, level: "project", color: "#000", managerId: null, budget: null, isActive: 1, ...o });

beforeEach(() => {
  state.financeCalls = [];
  state.scoped = undefined;
  state.access = { all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false };
  state.projects = [
    node({ id: 100, name: "Lisboa", level: "city", budget: "120000.00", managerId: 7 }),
    node({ id: 10, name: "Marca A", level: "brand", parentId: 100 }),
    node({ id: 11, name: "Marca B", level: "brand", parentId: 100, isActive: 0 }),
  ];
  state.finance = {
    quality: { isCurrentPeriod: false },
    costs: { expensesNet: 300, salaries: 5000, employerTax: 1187.5, extrasDia: 48, salesCommissions: 30, operationalCommissions: 16, totalNet: 6581.5 },
    details: {
      costsByProject: [
        cost(10, { expensesNet: 100, expenses: 123, salaries: 3000, employerTax: 712.5, operationalCommissions: 16, total: 3828.5 }),
        cost(11, { salaries: 1500, employerTax: 356.25, extras: 48, salesCommissions: 30, total: 1934.25 }),
        cost(100, { expensesNet: 200, expenses: 246, total: 200 }),
        cost(null, { salaries: 500, employerTax: 118.75, total: 618.75 }),
        cost(999, { expensesNet: 0, total: 0 }), // centro que já não está na árvore
      ],
    },
  };
});

describe("período e orçamento", () => {
  it("mês de calendário (fevereiro bissexto incluído) ou o ano inteiro", () => {
    expect(projectCostsPeriod(2026, 9)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(projectCostsPeriod(2028, 2)).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(projectCostsPeriod(2026, 12)).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(projectCostsPeriod(2026)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });
  it("o orçamento é anual: um mês conta 1/12", () => {
    expect(budgetForPeriod(120000)).toBe(120000);
    expect(budgetForPeriod(120000, 3)).toBe(10000);
  });
});

describe("projectCostsReport", () => {
  it("custos de cada nó vêm do motor (sem centro → Por atribuir) e os totais são os da Faturação", async () => {
    const r = await projectCostsReport({ year: 2026, month: 8, today: "2026-10-02" });
    expect(state.financeCalls).toEqual([{ from: "2026-08-01", to: "2026-08-31", today: "2026-10-02", granularity: "month" }]);
    const byId = new Map(r.rows.map((x) => [x.id, x]));
    expect(byId.get(10)).toMatchObject({ expenses: 100, expensesGross: 123, salaries: 3000, employerTax: 712.5, personnel: 3712.5, commissions: 16, totalCost: 3828.5 });
    expect(byId.get(11)).toMatchObject({ personnel: 1500 + 356.25 + 48, commissions: 30, isActive: false });
    expect(byId.get(100)).toMatchObject({ budgetAnnual: 120000, budget: 10000, managerName: "Gestora", totalCost: 200 });
    expect(r.unallocated).toMatchObject({ salaries: 500, personnel: 618.75, totalCost: 618.75 });
    expect(r.totals).toEqual({ expenses: 300, personnel: 5000 + 1187.5 + 48, commissions: 46, totalCost: 6581.5 });
    // a tabela (nós + Por atribuir) soma o total da Faturação
    expect(r.rows.reduce((s, x) => s + x.totalCost, 0) + r.unallocated.totalCost).toBeCloseTo(r.totals.totalCost, 6);
  });

  it("ano inteiro: orçamento anual inteiro", async () => {
    const r = await projectCostsReport({ year: 2026, today: "2026-10-02" });
    expect(state.financeCalls[0]).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
    expect(r.rows.find((x) => x.id === 100)!.budget).toBe(120000);
  });

  it("alcance de cidade: só os nós da cidade; o que não está na lista vai para Por atribuir", async () => {
    state.scoped = [100, 10];
    const r = await projectCostsReport({ year: 2026, month: 8, today: "2026-10-02" });
    expect(r.rows.map((x) => x.id).sort()).toEqual([10, 100]);
    expect(r.unallocated.totalCost).toBeCloseTo(1934.25 + 618.75, 6);
  });
});

describe("projects.costs (tRPC)", () => {
  const ctx = (role: string): TrpcContext => ({
    user: { id: 1, openId: "t", email: "t@x.pt", name: "T", loginMethod: "x", role: role as any, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  });
  it("admin recebe o relatório (nós, por atribuir, totais)", async () => {
    const r = await appRouter.createCaller(ctx("admin")).projects.costs({ year: 2026, month: 8 });
    expect(Object.keys(r).sort()).toEqual(["period", "rows", "totals", "unallocated"]);
    expect(r.period).toMatchObject({ year: 2026, month: 8 });
  });
  it("sem totais financeiros → recusa; sem sessão → recusa", async () => {
    await expect(appRouter.createCaller(ctx("supervisor")).projects.costs({ year: 2026 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(appRouter.createCaller({ ...ctx("admin"), user: null }).projects.costs()).rejects.toThrow();
  });
});

describe("página Projetos → Custos", () => {
  const page = () => readFileSync(resolve(import.meta.dirname, "..", "client/src/pages/ProjectCostsDashboard.tsx"), "utf8");
  it("erro ≠ zero, 'Por atribuir' na tabela, orçamento anual e a mesma regra na tabela e nos alertas", () => {
    const src = page();
    expect(src).toContain("{error && (!report || isPlaceholderData) ? (");
    expect(src).toContain("Não foi possível calcular os custos.");
    expect(src).toContain("Por atribuir");
    expect(src).toContain("Orçamento anual");
    expect(src).not.toContain("salaryCost");
    expect(src).toContain("data.map((d) => ({ d, v: viewOf(d) }))");
  });
  it("o editor dos nós diz que o orçamento é anual", () => {
    const src = readFileSync(resolve(import.meta.dirname, "..", "client/src/pages/ProjectsPage.tsx"), "utf8");
    expect(src).toContain("<Label>Orçamento anual (€)</Label>");
    expect(src).not.toContain("<Label>Budget (€)</Label>");
  });
  it("o cálculo antigo saiu (só há uma regra de custos)", () => {
    expect(readFileSync(resolve(import.meta.dirname, "db.ts"), "utf8")).not.toContain("export async function getProjectCosts");
  });
});
