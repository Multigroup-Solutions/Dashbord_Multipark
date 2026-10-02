import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { can } from "../shared/access";
import { daysUntil, expenseStatsWindows, lisbonToday } from "../shared/expensePeriods";

// Aceitação das Despesas (P2.3, 2 out 2026).

const state = vi.hoisted(() => ({ listed: 0, access: null as any }));
vi.mock("./cityAccess", async (original) => ({ ...(await original<object>()), loadCityAccess: async () => state.access }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getEmployeeByUserId: async () => ({ employee: { projectId: 50 } }),
  resolveProjectIds: async (id: number) => (id === 50 ? [50, 65] : [id]),
  listExpenses: async () => { state.listed++; return []; },
}));

import { appRouter } from "./routers";

const root = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const porto = { all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false };
const national = { all: true, defaultCityId: null, cityName: null, cityIds: [], projectIds: [], missingCostCenter: false };

beforeEach(() => { state.listed = 0; state.access = national; });

describe("Despesas — Excel", () => {
  it("quem pode exportar não é só quem gere: supervisor e front/backoffice exportam sem 'gerir'", () => {
    for (const role of ["supervisor", "frontoffice", "backoffice"]) {
      expect(can({ role } as any, "despesas", "export"), role).toBe(true);
      expect(can({ role } as any, "despesas", "manage"), role).toBe(false);
    }
  });

  it("o servidor aceita o Excel do supervisor (o botão é que não aparecia); nome com o dia de Lisboa", async () => {
    state.access = porto;
    const caller = appRouter.createCaller({ user: { id: 9, role: "supervisor" }, req: { headers: {} }, res: {} } as any);
    const r = await caller.expenses.exportExcel({ startDate: "2026-10-01", endDate: "2026-10-31" });
    expect(state.listed).toBe(1);
    expect(r.count).toBe(0);
    expect(r.filename).toBe(`despesas-${lisbonToday()}.xlsx`);
  });

  it("a página mostra o Exportar a quem tem a ação export (com totais), não só a quem gere", () => {
    const src = read("client/src/pages/ExpensesPage.tsx");
    expect(src).toContain('const canExport = can(user, "despesas", "export");');
    expect(src).toMatch(/\{canExport && showTotals && \(\s*<DropdownMenuItem onClick=\{handleExport\}/);
    expect(read("server/expensesRouter.ts")).not.toMatch(/filename: `despesas-\$\{new Date\(\)\.toISOString/);
  });
});

describe("Despesas — separador Resumo", () => {
  it("só abre a quem tem o separador (o ?tab=resumo escondia a lista a quem não o tinha)", () => {
    const src = read("client/src/pages/ExpensesPage.tsx");
    expect(src).toContain("const canResumo = canManage && showTotals;");
    expect(src).toContain('const shownTab = canResumo ? tab : "lista";');
    expect(src).toContain('{shownTab === "resumo" && <ExpenseDashboard />}');
    expect(src).not.toMatch(/[^A-Za-z]tab === "(resumo|lista)"/);
  });

  it("erro ≠ zero: uma falha mostra o porquê e deixa tentar de novo", () => {
    const src = read("client/src/pages/ExpenseDashboard.tsx");
    expect(src).toMatch(/if \(statsError && !stats\) \{/);
    expect(src).toContain("Não foi possível carregar o resumo das despesas.");
    expect(src).toContain("Não foi possível carregar os próximos pagamentos.");
    expect(src).toMatch(/count < 2 && !\["FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"\]/);
  });

  it("vencimentos contados por dia, sem new Date(\"AAAA-MM-DD 00:00:00\") (inválido no Safari)", () => {
    const src = read("client/src/pages/ExpenseDashboard.tsx");
    expect(src).not.toContain("new Date(expense.paymentDueDate)");
    expect(src).toContain("daysUntil(dueDay, today)");
    expect(daysUntil("2026-10-05 00:00:00", "2026-10-02")).toBe(3);
    expect(daysUntil("2026-10-02 00:00:00", "2026-10-02")).toBe(0);
    expect(daysUntil("2026-10-03", "2026-10-02")).toBe(1);
    expect(daysUntil("2026-10-26", "2026-10-24")).toBe(2); // mudança de hora pelo meio
    expect(daysUntil("lixo", "2026-10-02")).toBeNull();
  });
});

describe("Despesas — janelas do Resumo têm fim", () => {
  it("dia, semana (segunda), mês, ano e tendência de 6 meses — fim exclusivo", () => {
    expect(expenseStatsWindows("2026-10-02")).toEqual({
      day: { start: "2026-10-02 00:00:00", end: "2026-10-03 00:00:00" },
      week: { start: "2026-09-28 00:00:00", end: "2026-10-05 00:00:00" },
      month: { start: "2026-10-01 00:00:00", end: "2026-11-01 00:00:00" },
      year: { start: "2026-01-01 00:00:00", end: "2027-01-01 00:00:00" },
      trend: { start: "2026-05-01 00:00:00", end: "2026-11-01 00:00:00" },
    });
    expect(expenseStatsWindows("2026-10-04").week).toEqual({ start: "2026-09-28 00:00:00", end: "2026-10-05 00:00:00" }); // domingo
    expect(expenseStatsWindows("2026-12-31").month.end).toBe("2027-01-01 00:00:00");
    expect(expenseStatsWindows("2027-01-15").trend).toEqual({ start: "2026-08-01 00:00:00", end: "2027-02-01 00:00:00" });
  });

  it("getExpenseStats usa as janelas com fim em todos os totais por data (despesas com data futura não entram)", () => {
    const db = read("server/db.ts");
    const fn = db.slice(db.indexOf("export async function getExpenseStats"), db.indexOf("export async function getUpcomingPayments"));
    expect(fn).toContain("const w = expenseStatsWindows(lisbonToday());");
    // o único "≥ início" é o do inWindow, sempre com "< fim"
    expect(fn.match(/gte\(expenses\.expenseDate/g)).toHaveLength(1);
    expect(fn).toContain("and(gte(expenses.expenseDate, win.start), lt(expenses.expenseDate, win.end))");
    expect(fn.match(/inWindow\(w\.(day|week|month|year|trend)\)/g)).toHaveLength(9);
  });
});

describe("Despesas — detalhe e recorrentes", () => {
  it("'Criado em' e o histórico são instantes UTC da BD → hora local (antes 1h atrasados no verão)", () => {
    const src = read("client/src/pages/ExpensesPage.tsx");
    expect(src).toContain('when(expense.createdAt, "dd MMM yyyy, HH:mm")');
    expect(src).toContain('when(ev.at, "dd MMM yyyy HH:mm")');
    expect(src).toContain("return new Date(utcMs(v));");
  });

  it("recorrentes: valor com a regra das despesas e erro de carga ≠ 'não há modelos'", () => {
    const src = read("client/src/components/ExpenseRecurringCompare.tsx");
    expect(src).toContain("parseExpenseAmount(f.amount)");
    expect(src).not.toContain('.replace(",", ".")), dayOfMonth');
    expect(src).toContain("Não foi possível carregar os modelos");
  });
});
