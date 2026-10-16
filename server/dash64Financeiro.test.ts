/**
 * Plano 64, PR C — Financeiro.
 *  C1 Total e Pago dizem "este ano" · C2 a barra é a dívida atual (pendente vs
 *  em atraso) · C3 as categorias seguem o PERÍODO e a base da Faturação (as
 *  mesmas despesas dos custos, sem salários), mas COM IVA (P3 do Jorge: "sim,
 *  mas COM IVA") · C4 os "Pagamentos nos próximos 7 dias" já não rebentam no
 *  Safari · C5 "Sem acesso" em vez de 0 € · C6 os donuts por cidade/marca
 *  pela função das contagens do PR B (todos os parques), com o valor.
 * O dinheiro não muda: o motor (engine.ts), liveBookings.ts, cash.ts e
 * financeAgg.ts ficam como estavam — as categorias c/ IVA saem da MESMA
 * corrida do motor que dá os "Custos s/ IVA".
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { format } from "date-fns";

const h = vi.hoisted(() => ({
  overrides: {} as Record<string, string>,
  modules: {} as Record<string, unknown>,
  expenseRows: [] as any[],
  adRows: [] as any[],
}));

const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [10], projectIds: [1, 10, 11], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));

/**
 * BD falsa para o motor: cada select responde pelos campos pedidos (como em
 * server/finance/engine.test.ts). As despesas são as linhas "dia × centro ×
 * categoria" que o motor agrega em SQL.
 */
const fakeDb = vi.hoisted(() => {
  const respond = (fields: Record<string, unknown>): any[] => {
    const k = Object.keys(fields ?? {});
    // despesas do período — uma lista nova por leitura (o motor junta-lhe os anúncios)
    if (k.includes("totalNet")) return h.expenseRows.map((r) => ({ ...r }));
    return []; // projetos, pendentes, parceiros, fichas, histórico salarial…
  };
  return {
    select(fields: Record<string, unknown>) {
      const chain: any = {
        from: () => chain, leftJoin: () => chain, innerJoin: () => chain, where: () => chain,
        groupBy: () => chain, orderBy: () => chain, limit: () => chain, offset: () => chain,
        then: (res: any, rej: any) => Promise.resolve(respond(fields)).then(res, rej),
      };
      return chain;
    },
    execute: async () => [[], []],
  };
});
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => fakeDb,
  getUserPermissionOverrides: async () => h.overrides,
  getUserModuleOverrides: async () => h.modules,
  getEmployeeByUserId: async () => null,
  getPayrollData: async () => [],
  resolveProjectIds: async (id: number) => [Math.abs(id)],
}));
vi.mock("./appSettings", async (original) => ({ ...(await original<object>()), getSetting: async () => null }));
vi.mock("./pontoTerminal", async (original) => ({ ...(await original<object>()), pontoTerminalEnabled: async () => false }));
vi.mock("./extraRates", async (original) => {
  const m: any = await original();
  return { ...m, loadExtraRates: async () => ({ ...m.DEFAULT_EXTRA_RATES }) };
});
vi.mock("./finance/extrasCost", async (original) => ({ ...(await original<object>()), loadExtrasCostRows: async () => ({ assignments: [], ponto: [] }) }));
// Reservas ao vivo: nenhumas (aqui só interessam as despesas).
vi.mock("./finance/liveBookings", async (original) => ({ ...(await original<object>()), loadLiveBookingAgg: async () => [] }));
// Anúncios (29f): entram nos custos como despesa, sem IVA (autoliquidação).
vi.mock("./finance/adCosts", async (original) => ({
  ...(await original<object>()),
  loadAdCosts: async () => ({ rows: h.adRows, totals: { platform: 0, invoice: 0 }, invoicesWithoutPeriod: [] }),
}));
// C6: o valor das reservas por cidade/marca sem a BD da Multipark (aqui só interessa a porta).
vi.mock("./opsStatsLive", async (original) => ({
  ...(await original<object>()),
  liveOpsBookingValues: async () => ({ byCity: [{ name: "Lisboa", bookings: 2, revenue: 246 }], byBrand: [{ name: "Airpark", bookings: 2, revenue: 246 }] }),
}));

import { appRouter } from "./routers";
import { computeFinance } from "./finance/engine";
import { expensesByCategory } from "./finance/expenseCategories";
import { SHEET_REPORTS, assertCanExportReport } from "./google/sheetsExport";
import { adCostCategory } from "../shared/adInvoices";
import { can } from "../shared/access";
import { daysUntil, lisbonToday, shortDayLabel } from "../shared/expensePeriods";
import { categorySlices } from "../shared/expenseCategorySlices";
import { failureNote, queryFailure, retryTransient } from "../client/src/lib/queryRetry";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const caller = (role: string) => appRouter.createCaller({ user: { id: 77, role, name: "Rita" }, req: { headers: {} }, res: {} } as any);
const forbidden = (message = "Sem permissão para ver totais financeiros.") => ({ data: { code: "FORBIDDEN" }, message });

/** Setembro de 2026, visto a 20 set (período em curso: as despesas datadas depois de hoje ficam de fora). */
const PERIOD = { from: "2026-09-01", to: "2026-09-30" };
const NOW = new Date("2026-09-20T10:00:00Z");

/**
 * Cada despesa tem um s/ IVA = 100 × 2^id (potências de 2 distintas): uma soma
 * diz EXATAMENTE que despesas entraram (os "ids"). c/ IVA = o valor da despesa.
 */
const exp = (id: number, o: { day: string; projectId: number | null; categoryName: string | null; gross: number; excluded?: 0 | 1 }) => ({
  day: o.day, projectId: o.projectId, projectName: o.projectId == null ? null : `Centro ${o.projectId}`, categoryId: null, categoryName: o.categoryName,
  excluded: o.excluded ?? 0, count: 1, totalAmount: o.gross, totalNet: 100 * 2 ** id,
});
const EXPENSES = [
  exp(0, { day: "2026-09-03", projectId: 10, categoryName: "Combustível", gross: 123 }),
  exp(1, { day: "2026-09-05", projectId: 11, categoryName: "Combustível", gross: 246 }), // outro centro, a mesma categoria
  exp(2, { day: "2026-09-06", projectId: 10, categoryName: "Salários", gross: 400, excluded: 1 }), // fora da margem (sem salários)
  exp(3, { day: "2026-09-25", projectId: 10, categoryName: "Rendas", gross: 984 }), // depois de hoje: só no Fecho previsto
  exp(4, { day: "2026-09-10", projectId: null, categoryName: null, gross: 1968 }), // sem categoria e sem centro
  exp(5, { day: "2026-09-12", projectId: 10, categoryName: "TSU", gross: 3200 }), // 29b: a TSU paga conta
];
/** id 6: o gasto do Google Ads (à espera da fatura) — s/ IVA = c/ IVA. */
const AD = { date: "2026-09-10", projectId: 10, provider: "google_ads" as const, source: "plataforma" as const, cost: 6400, invoiceId: null };
const AD_CATEGORY = adCostCategory(AD);
/** As que a Faturação conta nos custos: até hoje e sem as "excluir da margem". */
const COUNTED_IDS = [0, 1, 4, 5, 6];

/** Que despesas (ids) somam este s/ IVA. */
const idsOfNet = (net: number) => {
  const units = Math.round(net / 100);
  return Array.from({ length: 8 }, (_, i) => i).filter((i) => (units >> i) & 1);
};
const sum = (o: Record<string, number>) => Object.values(o).reduce((s, v) => s + v, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.overrides = {}; h.modules = {};
  h.expenseRows = EXPENSES.map((r) => ({ ...r }));
  h.adRows = [{ ...AD }];
});
afterEach(() => { vi.useRealTimers(); });

// ─── C3 ──────────────────────────────────────────────────────────────────────

describe("C3 — despesas por categoria: o período e o conjunto da Faturação, c/ IVA", () => {
  it("o motor conta nos custos exatamente as despesas até hoje, sem as de fora da margem, com os anúncios", async () => {
    const r = await computeFinance({ ...PERIOD, granularity: "month" });
    expect(r.quality.isCurrentPeriod).toBe(true);
    expect(idsOfNet(r.costs.expensesNet)).toEqual(COUNTED_IDS);
    // o motor guarda as mesmas linhas em details.expenses (c/ e s/ IVA)
    expect(idsOfNet(r.details.expenses.reduce((s, e) => s + e.totalNet, 0))).toEqual(COUNTED_IDS);
  });

  it("paridade: as categorias c/ IVA do Financeiro são as MESMAS despesas do motor (mesmos ids) e somam o bruto delas", async () => {
    const r = await computeFinance({ ...PERIOD, granularity: "month" });
    const s = await caller("admin").invoices.financeSummary(PERIOD);
    // o mesmo conjunto: os "Custos s/ IVA" e as categorias (s/ e c/ IVA) vêm das mesmas linhas
    expect(s.costs.expensesNet).toBe(r.costs.expensesNet);
    expect(idsOfNet(sum(s.expensesByCategory))).toEqual(COUNTED_IDS);
    expect(Object.keys(s.expensesByCategoryGross).sort()).toEqual(Object.keys(s.expensesByCategory).sort());
    // c/ IVA: Σ das categorias = Σ do valor (bruto) das mesmas despesas do período = o bruto do motor
    const grossOf = (id: number) => (id === 6 ? AD.cost : EXPENSES[id].totalAmount);
    expect(sum(s.expensesByCategoryGross)).toBe(COUNTED_IDS.reduce((t, id) => t + grossOf(id), 0));
    expect(sum(s.expensesByCategoryGross)).toBe(r.costs.expenses);
    expect(s.expensesByCategoryGross).toEqual({
      "Combustível": 123 + 246, // dois centros, uma fatia
      "Sem categoria": 1968,
      TSU: 3200,
      [AD_CATEGORY]: 6400, // autoliquidação: c/ IVA = s/ IVA
    });
    // sem salários (fora da margem) e sem a renda datada depois de hoje
    expect(s.expensesByCategoryGross).not.toHaveProperty("Salários");
    expect(s.expensesByCategoryGross).not.toHaveProperty("Rendas");
  });

  it("o s/ IVA por categoria (Exportar para Sheets) fica igual ao de antes", async () => {
    const r = await computeFinance({ ...PERIOD, granularity: "month" });
    const s = await caller("admin").invoices.financeSummary(PERIOD);
    const before = r.details.expenses.reduce((acc, e) => { const k = e.categoryName ?? "Sem categoria"; acc[k] = (acc[k] ?? 0) + e.totalNet; return acc; }, {} as Record<string, number>);
    expect(s.expensesByCategory).toEqual(before);
  });

  it("agrupar é só agrupar: s/ IVA ou c/ IVA das mesmas linhas, 'Sem categoria' sem nome", () => {
    const rows = [
      { categoryName: "Rendas", totalAmount: 123, totalNet: 100 },
      { categoryName: "Rendas", totalAmount: 61.5, totalNet: 50 },
      { categoryName: null, totalAmount: 10, totalNet: 10 },
    ];
    expect(expensesByCategory(rows, "gross")).toEqual({ Rendas: 184.5, "Sem categoria": 10 });
    expect(expensesByCategory(rows, "net")).toEqual({ Rendas: 150, "Sem categoria": 10 });
    expect(expensesByCategory([], "gross")).toEqual({});
  });

  it("a folha 'Despesas por categoria' (Exportar para Sheets) leva as duas colunas", async () => {
    const call = async () => ({ revenue: {}, costs: {}, margin: {}, monthly: [], expensesByCategory: { Rendas: 100 }, expensesByCategoryGross: { Rendas: 123 } });
    const tabs = await SHEET_REPORTS.financeiro.load(call, { from: PERIOD.from, to: PERIOD.to }, Date.now() + 60_000);
    expect(tabs.find((t) => t.name === "Despesas por categoria")?.rows).toEqual([["Categoria", "s/ IVA", "c/ IVA"], ["Rendas", 100, 123]]);
  });

  it("o ecrã: as categorias vêm do financeSummary (c/ IVA, período), não do Resumo das despesas (só o mês)", () => {
    const page = src("client/src/pages/FinanceiroDashboard.tsx");
    expect(page).toContain("fin?.expensesByCategoryGross");
    expect(page).not.toContain("expenseStats?.byCategory");
    expect(page).toContain(`"Despesas por categoria (período, c/ IVA, sem salários, como na Faturação)"`);
    expect(page).toContain("Por categoria — Top 5 (período, c/ IVA, sem salários)");
  });
});

// ─── C1 / C2 ─────────────────────────────────────────────────────────────────

describe("C1/C2 — o ano e a dívida atual dizem o que são", () => {
  const page = src("client/src/pages/FinanceiroDashboard.tsx");
  it("C1: Total e Pago passam a 'Este ano (c/ IVA)' e 'Pago este ano' (a mesma consulta do Despesas → Resumo)", () => {
    expect(page).toContain(`label="Este ano (c/ IVA)" value={totalDespesasAnual}`);
    expect(page).toContain(`label="Pago este ano" value={Math.max(0, pagoDespesas)}`);
    expect(page).not.toContain(">Total Despesas<");
  });
  it("C2: a barra é 'Dívida atual: pendente vs em atraso' — o pago do ano saiu", () => {
    expect(page).toContain("Dívida atual: pendente vs em atraso");
    const bar = page.slice(page.indexOf("const debtData = ["), page.indexOf("const totalDebt"));
    expect(bar).toContain(`name: "Pendente", value: pendente`);
    expect(bar).toContain(`name: "Em atraso", value: emAtraso`);
    expect(bar).not.toContain("pagoDespesas");
  });
});

// ─── C4 ──────────────────────────────────────────────────────────────────────

describe("C4 — Pagamentos nos próximos 7 dias: pelo dia de Lisboa, sem new Date do texto (Safari)", () => {
  it("o formatador do dia: texto → '20 out', sem passar por Date", () => {
    expect(shortDayLabel("2026-10-20 00:00:00")).toBe("20 out");
    expect(shortDayLabel("2026-10-20")).toBe("20 out");
    expect(shortDayLabel("2026-01-05 00:00:00")).toBe("05 jan");
    expect(shortDayLabel("2026-12-31")).toBe("31 dez");
    for (const bad of ["", null, undefined, "lixo", "2026-02-30", "2026-13-01"]) expect(shortDayLabel(bad)).toBeNull();
  });

  it("dá o mesmo que o date-fns ('dd MMM', pt) nos 12 meses", async () => {
    vi.useRealTimers();
    const { pt } = await import("date-fns/locale");
    for (let m = 1; m <= 12; m++) {
      const day = `2026-${String(m).padStart(2, "0")}-07`;
      expect(shortDayLabel(`${day} 00:00:00`)).toBe(format(new Date(`${day}T00:00:00`), "dd MMM", { locale: pt }));
    }
  });

  it("daysUntil nas fronteiras: hoje 0, amanhã 1, 7 dias, viragem de mês e de ano, mudança de hora, ontem −1", () => {
    expect(daysUntil("2026-10-15 00:00:00", "2026-10-15")).toBe(0);
    expect(daysUntil("2026-10-16 00:00:00", "2026-10-15")).toBe(1);
    expect(daysUntil("2026-10-22 00:00:00", "2026-10-15")).toBe(7);
    expect(daysUntil("2026-11-01 00:00:00", "2026-10-31")).toBe(1);
    expect(daysUntil("2027-01-01 00:00:00", "2026-12-31")).toBe(1);
    expect(daysUntil("2026-10-26 00:00:00", "2026-10-24")).toBe(2); // a hora muda a 25 out
    expect(daysUntil("2026-10-14 00:00:00", "2026-10-15")).toBe(-1);
    expect(daysUntil("", "2026-10-15")).toBeNull();
  });

  it("com o Date do Safari (que não lê 'AAAA-MM-DD HH:MM:SS'): o caminho antigo rebentava, o novo não", () => {
    vi.useRealTimers();
    const RealDate = Date;
    class SafariDate extends RealDate {
      constructor(...args: any[]) {
        const rejected = args.length === 1 && typeof args[0] === "string" && /^\d{4}-\d{2}-\d{2} \d/.test(args[0]);
        super(...((rejected ? [NaN] : args) as [any]));
      }
    }
    vi.stubGlobal("Date", SafariDate);
    try {
      const due = "2026-10-20 00:00:00"; // como vem da BD (timestamp mode 'string')
      // antes: format(new Date(expense.paymentDueDate), …) → RangeError no iPhone (o separador caía)
      expect(() => format(new Date(due), "dd MMM")).toThrow(RangeError);
      expect(Number.isNaN(new Date(due).getTime())).toBe(true);
      // agora: o dia sai do texto
      const dueDay = String(due).slice(0, 10);
      expect(shortDayLabel(dueDay)).toBe("20 out");
      expect(daysUntil(dueDay, "2026-10-15")).toBe(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("o 'hoje' é o dia de Lisboa (no verão, 23:30 UTC já é o dia seguinte)", () => {
    vi.useRealTimers();
    expect(lisbonToday(new Date("2026-07-31T23:30:00Z"))).toBe("2026-08-01"); // verão: UTC+1
    expect(lisbonToday(new Date("2026-10-31T23:30:00Z"))).toBe("2026-10-31"); // inverno: UTC+0
  });

  it("o ecrã conta pelo dia e formata o texto (como Despesas → Resumo, que usa o mesmo formatador)", () => {
    const page = src("client/src/pages/FinanceiroDashboard.tsx");
    expect(page).not.toContain("new Date(expense.paymentDueDate)");
    expect(page).toContain(`const dueDay = String(expense.paymentDueDate ?? "").slice(0, 10);`);
    expect(page).toContain("daysUntil(dueDay, today)");
    expect(page).toContain("const today = lisbonToday();");
    expect(page).toContain(`shortDayLabel(dueDay) ?? "—"`);
    const resumo = src("client/src/pages/ExpenseDashboard.tsx");
    expect(resumo).toContain(`shortDayLabel(dueDay) ?? "—"`);
    expect(resumo).not.toContain("new Date(`${dueDay}T00:00:00`)");
  });
});

// ─── C5 ──────────────────────────────────────────────────────────────────────

describe("C5 — 'Sem acesso' em vez de 0 €; as consultas já não dependem de isAdmin", () => {
  it("um FORBIDDEN do servidor dá 'Sem acesso'; outro erro dá 'não carregou'; sem o módulo, a consulta nem sai", () => {
    expect(queryFailure(forbidden())).toBe("forbidden");
    expect(failureNote("forbidden")).toBe("Sem acesso");
    expect(queryFailure({ data: { code: "INTERNAL_SERVER_ERROR" }, message: "BD" })).toBe("error");
    expect(failureNote("error")).toBe("Não carregou · tentar de novo");
    expect(queryFailure(null)).toBeNull();
    expect(queryFailure(null, false)).toBe("forbidden");
  });

  it("o financeSummary (que leva as categorias c/ IVA) recusa quem não tem os totais", async () => {
    // supervisor sem o Financeiro
    await expect(caller("supervisor").invoices.financeSummary(PERIOD)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // admin com o deny de finance.view_totals
    h.overrides = { "finance.view_totals": "deny" };
    await expect(caller("admin").invoices.financeSummary(PERIOD)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // e o valor das reservas por cidade/marca (C6) também
    await expect(caller("admin").multipark.opsBookingValues(PERIOD)).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.overrides = {};
    await expect(caller("supervisor").multipark.opsBookingValues(PERIOD)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("um supervisor com o Financeiro dado por pessoa e os totais vê os números (antes o ecrã dava-lhe 0 €)", async () => {
    h.modules = { financeiro: { access: "national", actions: ["view"] } };
    h.overrides = { "finance.view_totals": "grant" };
    const s = await caller("supervisor").invoices.financeSummary(PERIOD);
    expect(sum(s.expensesByCategoryGross)).toBeGreaterThan(0);
    // o ecrã pede as consultas a quem tem o módulo — não pelo papel
    expect(can({ role: "supervisor", accessOverrides: h.modules as any }, "financeiro", "view")).toBe(true);
  });

  it("o ecrã: sem isAdmin; consultas pelo módulo Financeiro; falha → '—' e 'Sem acesso' / 'tentar de novo'", () => {
    const page = src("client/src/pages/FinanceiroDashboard.tsx");
    expect(page).not.toContain("isAdmin");
    expect(page).toContain(`const seesFinance = can(user as any, "financeiro", "view");`);
    expect(page).toContain("const opts = { enabled: seesFinance, retry: retryTransient };");
    for (const q of [
      "trpc.invoices.financeSummary.useQuery(period, opts)",
      "trpc.multipark.opsBookingValues.useQuery(period, opts)",
      "trpc.expenses.stats.useQuery({ projectId: filters.projectId }, opts)",
      "trpc.expenses.upcomingPayments.useQuery({ projectId: filters.projectId }, opts)",
    ]) expect(page).toContain(q);
    for (const q of ["finQ", "expQ", "valuesQ", "upQ"]) expect(page).toContain(`queryFailure(${q}.error, seesFinance)`);
    // os cartões e os gráficos do motor (3 + evolução e categorias) e das despesas (2 grandes + 4 pequenos)
    // (+ a nota do Top 5 do bloco das despesas)
    expect(page.match(/failed=\{finFailed\}/g)).toHaveLength(6);
    expect(page.match(/failed=\{expFailed\}/g)).toHaveLength(6);
  });
});

// ─── C6 ──────────────────────────────────────────────────────────────────────

describe("C6 — os donuts por cidade/marca: todos os parques, pela função das contagens (com o valor)", () => {
  it("o ecrã pede o opsBookingValues (não o bookingStats) e diz que não é receita", () => {
    const page = src("client/src/pages/FinanceiroDashboard.tsx");
    expect(page).not.toContain("multipark.bookingStats");
    expect(page).toContain("Reservas criadas por cidade · todos os parques · valor c/ IVA (não é receita)");
    expect(page).toContain("Reservas criadas por marca · todos os parques · valor c/ IVA (não é receita)");
    expect(page).toContain("bookingValues?.byCity");
    expect(page).toContain("bookingValues?.byBrand");
    expect(page.match(/valuesFailed \? \(/g)).toHaveLength(2);
  });
  it("o procedimento é a mesma função das contagens, com a permissão dos totais", () => {
    const r = src("server/routers.ts");
    const at = r.slice(r.indexOf("opsBookingValues: protectedProcedure"), r.indexOf("opsBookingValues: protectedProcedure") + 600);
    expect(at).toContain(`await requireFinanceTotals(ctx.user, "financeiro", "view")`);
    expect(at).toContain("liveOpsBookingValues");
  });
});

// ─── "Igual": o dinheiro não muda ───────────────────────────────────────────

describe("igual — o motor, a Faturação, a Caixa e os entregues ficam como estavam", () => {
  it("os ficheiros de dinheiro não usam o agrupador novo (só o router o chama, sobre o resultado do motor)", () => {
    for (const f of ["server/finance/liveBookings.ts", "server/finance/engine.ts", "server/finance/cash.ts", "server/multiparkDb/financeAgg.ts"]) {
      expect(src(f), f).not.toMatch(/["'][./]*(finance\/)?expenseCategories["']/);
    }
    const r = src("server/routers.ts");
    const fs = r.slice(r.indexOf("financeSummary: protectedProcedure"), r.indexOf("deliveries: protectedProcedure"));
    expect(fs).toContain(`await requireFinanceTotals(ctx.user, "financeiro", "view");`);
    expect(fs.match(/computeFinance\(/g)).toHaveLength(1); // uma só corrida do motor
    expect(fs).toContain(`expensesByCategory(r.details.expenses, "net")`);
    expect(fs).toContain(`expensesByCategory(r.details.expenses, "gross")`);
  });
});

// ─── Auditoria do PR C ───────────────────────────────────────────────────────

/** O agrupamento de ANTES, copiado tal e qual de origin/main:server/routers.ts (invoices.financeSummary). */
const oldExpensesByCategory = (r: { details: { expenses: Array<{ categoryName: string | null; totalNet: number }> } }) =>
  r.details.expenses.reduce((acc, e) => { const k = e.categoryName ?? "Sem categoria"; acc[k] = (acc[k] ?? 0) + e.totalNet; return acc; }, {} as Record<string, number>);
/** A folha de ANTES, copiada de origin/main:server/google/sheetsExport.ts ("Despesas por categoria"). */
const oldR2 = (v: unknown) => Math.round((Number(v ?? 0) || 0) * 100) / 100;
const oldSheetRows = (f: any) => [["Categoria", "s/ IVA"], ...Object.entries(f.expensesByCategory ?? {}).map(([k, v]) => [k, oldR2(v)])];

/**
 * Despesas com cêntimos (a vírgula flutuante a sério): a mesma categoria em
 * vários centros e dias, as "fora da margem" (salários e extras), a TSU paga,
 * uma nota de crédito (negativa) maior do que as despesas da categoria no
 * período e uma renda datada depois de hoje.
 */
const row = (o: { day: string; projectId: number | null; categoryName: string | null; gross: number; net: number; excluded?: 0 | 1; count?: number }) => ({
  day: o.day, projectId: o.projectId, projectName: o.projectId == null ? null : `Centro ${o.projectId}`, categoryId: null, categoryName: o.categoryName,
  excluded: o.excluded ?? 0, count: o.count ?? 1, totalAmount: o.gross, totalNet: o.net,
});
const DECIMAL_EXPENSES = [
  row({ day: "2026-09-02", projectId: 10, categoryName: "Combustível", gross: 123.45, net: 100.37, count: 3 }),
  row({ day: "2026-09-04", projectId: 11, categoryName: "Combustível", gross: 0.1, net: 0.08 }),
  row({ day: "2026-09-04", projectId: 10, categoryName: "Combustível", gross: 0.2, net: 0.16 }),
  row({ day: "2026-09-05", projectId: 10, categoryName: "Limpeza", gross: 33.33, net: 27.1 }),
  row({ day: "2026-09-06", projectId: 11, categoryName: "Limpeza", gross: 66.67, net: 54.2 }),
  row({ day: "2026-09-07", projectId: 10, categoryName: "Salários", gross: 5000, net: 5000, excluded: 1 }),
  row({ day: "2026-09-07", projectId: 10, categoryName: "Extras", gross: 812.5, net: 812.5, excluded: 1 }),
  row({ day: "2026-09-08", projectId: 10, categoryName: "TSU", gross: 1187.63, net: 1187.63 }),
  // NC de uma fatura de agosto: neste período a categoria fica negativa
  row({ day: "2026-09-09", projectId: 10, categoryName: "Peças", gross: -246, net: -200 }),
  row({ day: "2026-09-10", projectId: null, categoryName: null, gross: 19.99, net: 16.25 }),
  row({ day: "2026-09-28", projectId: 10, categoryName: "Rendas", gross: 984, net: 800 }), // depois de hoje
];
const DECIMAL_AD = { date: "2026-09-11", projectId: 10, provider: "meta_ads" as const, source: "plataforma" as const, cost: 77.77, invoiceId: null };

describe("auditoria — o s/ IVA de antes fica igual ao bit (ordem e valores), com cêntimos", () => {
  beforeEach(() => {
    h.expenseRows = DECIMAL_EXPENSES.map((r) => ({ ...r }));
    h.adRows = [{ ...DECIMAL_AD }];
  });

  it("financeSummary.expensesByCategory = o reduce de antes: mesmas chaves, mesma ordem, mesmos números (Object.is)", async () => {
    const r = await computeFinance({ ...PERIOD, granularity: "month" });
    const s = await caller("admin").invoices.financeSummary(PERIOD);
    const before = oldExpensesByCategory(r);
    expect(Object.keys(s.expensesByCategory)).toEqual(Object.keys(before)); // a ordem (a folha usa-a)
    for (const [k, v] of Object.entries(before)) expect(Object.is(s.expensesByCategory[k], v), k).toBe(true);
    expect(Object.entries(s.expensesByCategory)).toStrictEqual(Object.entries(before));
  });

  it("a folha 'Despesas por categoria': as colunas A:B são as de antes (mesmas linhas, mesma ordem, mesmo arredondamento); só se junta a C", async () => {
    const s = await caller("admin").invoices.financeSummary(PERIOD);
    const tabs = await SHEET_REPORTS.financeiro.load(async () => s, PERIOD, Date.now() + 60_000);
    const now = tabs.find((t) => t.name === "Despesas por categoria")!.rows;
    const before = oldSheetRows(s);
    expect(now.map((r) => r.slice(0, 2))).toStrictEqual(before);
    expect(now.map((r) => r.length)).toEqual(now.map(() => 3));
    // a C é o c/ IVA da MESMA categoria, arredondado como a B
    for (const [k, , c] of now.slice(1)) expect(c).toBe(oldR2(s.expensesByCategoryGross[k as string]));
    // os outros separadores não mudam de forma
    expect(tabs.map((t) => t.name)).toEqual(["Resumo", "Mensal", "Despesas por categoria"]);
  });
});

describe("auditoria — paridade do C3 com cêntimos, notas de crédito e o que entra/sai", () => {
  beforeEach(() => {
    h.expenseRows = DECIMAL_EXPENSES.map((r) => ({ ...r }));
    h.adRows = [{ ...DECIMAL_AD }];
  });

  it("Σ c/ IVA das categorias = costs.expenses do motor e Σ s/ IVA = costs.expensesNet (ao cêntimo)", async () => {
    const r = await computeFinance({ ...PERIOD, granularity: "month" });
    const s = await caller("admin").invoices.financeSummary(PERIOD);
    expect(sum(s.expensesByCategoryGross)).toBeCloseTo(r.costs.expenses, 6);
    expect(sum(s.expensesByCategory)).toBeCloseTo(r.costs.expensesNet, 6);
    expect(s.costs.expensesNet).toBe(r.costs.expensesNet);
    // o total do ecrã (categorySlices) = o bruto do motor, ao cêntimo — com a NC a descontar
    expect(categorySlices(s.expensesByCategoryGross).total).toBe(Math.round(r.costs.expenses * 100) / 100);
  });

  it("o que entra e o que sai: entram as categorias da margem (com a TSU paga, a NC e os anúncios); saem salários, extras e o datado depois de hoje", async () => {
    const s = await caller("admin").invoices.financeSummary(PERIOD);
    expect(Object.keys(s.expensesByCategoryGross).sort()).toEqual(
      ["Combustível", "Limpeza", "Peças", "Sem categoria", "TSU", adCostCategory(DECIMAL_AD)].sort(),
    );
    for (const out of ["Salários", "Extras", "Rendas"]) expect(s.expensesByCategoryGross).not.toHaveProperty(out);
    expect(s.expensesByCategoryGross["Combustível"]).toBeCloseTo(123.45 + 0.1 + 0.2, 9);
    expect(s.expensesByCategoryGross["Peças"]).toBe(-246);
    expect(s.expensesByCategoryGross[adCostCategory(DECIMAL_AD)]).toBe(77.77); // anúncios: sem IVA (c/ = s/)
    expect(s.expensesByCategory[adCostCategory(DECIMAL_AD)]).toBe(77.77);
    // as que saem ficam onde sempre estiveram: "excluídas da margem" (salários + extras, c/ IVA)
    expect(s.excludedExpenses).toBeCloseTo(5000 + 812.5, 9);
  });

  it("o gráfico: só fatias positivas; a NC fica fora e é dita; o total diz a verdade (fatias + fora = total)", async () => {
    const s = await caller("admin").invoices.financeSummary(PERIOD);
    const { total, slices, outside } = categorySlices(s.expensesByCategoryGross);
    expect(outside).toEqual([{ name: "Peças", value: -246 }]);
    expect(slices.every((c) => c.value > 0)).toBe(true);
    expect(slices.map((c) => c.name)).toEqual(["TSU", "Combustível", "Limpeza", adCostCategory(DECIMAL_AD), "Sem categoria"]);
    const cents = (v: number) => Math.round(v * 100);
    expect(cents(slices.reduce((t, c) => t + c.value, 0)) + cents(outside.reduce((t, c) => t + c.value, 0))).toBe(cents(total));
    expect(total).toBeLessThan(slices.reduce((t, c) => t + c.value, 0)); // a NC desconta no total
  });

  it("categorySlices: cêntimos, empates por nome, um saldo de 1e-10 não é fatia, vazio dá zero", () => {
    // 10 + 10 + 0,0000000001 − 0,004 − 5,2 = 14,7960000001 → 14,80
    expect(categorySlices({ B: 10, A: 10, Z: 1e-10, N: -0.004, M: -5.2 })).toEqual({
      total: 14.8,
      slices: [{ name: "A", value: 10 }, { name: "B", value: 10 }],
      outside: [{ name: "M", value: -5.2 }],
    });
    expect(categorySlices(undefined)).toEqual({ total: 0, slices: [], outside: [] });
    expect(categorySlices({})).toEqual({ total: 0, slices: [], outside: [] });
  });

  it("o ecrã usa o categorySlices e diz as categorias que ficam fora do gráfico", () => {
    const page = src("client/src/pages/FinanceiroDashboard.tsx");
    expect(page).toContain("categorySlices(fin?.expensesByCategoryGross)");
    expect(page).toContain("fora do gráfico (saldo negativo, notas de crédito)");
  });
});

describe("auditoria — a porta dos euros (financeSummary, opsBookingValues, expenses.stats/upcomingPayments, Sheets)", () => {
  const PROCS: Array<[string, unknown]> = [
    ["invoices.financeSummary", PERIOD],
    ["multipark.opsBookingValues", PERIOD],
    ["expenses.stats", {}],
    ["expenses.upcomingPayments", {}],
  ];
  const run = async (role: string) => {
    const c: any = caller(role);
    const out: Record<string, string> = {};
    for (const [p, input] of PROCS) {
      const fn = p.split(".").reduce((o: any, k) => o[k], c);
      try { await fn(input); out[p] = "ok"; } catch (e: any) { out[p] = e.code ?? String(e); }
    }
    return out;
  };
  const all = (v: string) => Object.fromEntries(PROCS.map(([p]) => [p, v]));
  const MODULE = { financeiro: { access: "national", actions: ["view"] } };
  const sees = (role: string) => can({ role, accessOverrides: h.modules as any }, "financeiro", "view");

  it("admin vê; admin com o deny de finance.view_totals: FORBIDDEN nos 4 (o ecrã pede e mostra 'Sem acesso')", async () => {
    expect(await run("admin")).toEqual(all("ok"));
    h.overrides = { "finance.view_totals": "deny" };
    expect(await run("admin")).toEqual(all("FORBIDDEN"));
    expect(sees("admin")).toBe(true);
    expect(queryFailure({ data: { code: "FORBIDDEN" } }, sees("admin"))).toBe("forbidden");
  });

  it("supervisor sem o Financeiro: FORBIDDEN nos 4, mesmo com o grant dos totais — e o ecrã nem pede ('Sem acesso')", async () => {
    expect(await run("supervisor")).toEqual(all("FORBIDDEN"));
    h.overrides = { "finance.view_totals": "grant" };
    expect(await run("supervisor")).toEqual(all("FORBIDDEN"));
    expect(sees("supervisor")).toBe(false);
    expect(queryFailure(null, sees("supervisor"))).toBe("forbidden");
  });

  it("supervisor com o Financeiro dado por pessoa: vê (com ou sem o grant — o módulo traz os totais); com o deny: FORBIDDEN", async () => {
    h.modules = MODULE;
    expect(sees("supervisor")).toBe(true);
    expect(await run("supervisor")).toEqual(all("ok"));
    h.overrides = { "finance.view_totals": "grant" };
    expect(await run("supervisor")).toEqual(all("ok"));
    h.overrides = { "finance.view_totals": "deny" };
    expect(await run("supervisor")).toEqual(all("FORBIDDEN"));
  });

  it("backoffice e frontoffice sem o módulo: FORBIDDEN nos 4", async () => {
    for (const role of ["backoffice", "frontoffice"]) {
      expect(await run(role), role).toEqual(all("FORBIDDEN"));
      expect(sees(role), role).toBe(false);
    }
  });

  it("Exportar para Sheets: lê pelo MESMO financeSummary, com o utilizador do pedido — o deny dá FORBIDDEN (sem folha); exportar pede a ação 'exportar'", async () => {
    h.overrides = { "finance.view_totals": "deny" };
    const c: any = caller("admin");
    const call = (path: string, i?: unknown) => path.split(".").reduce((o: any, k) => o[k], c)(i);
    await expect(SHEET_REPORTS.financeiro.load(call, PERIOD, Date.now() + 60_000)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // o botão e o servidor pedem "exportar" do Financeiro: o admin tem; quem só tem "ver" não exporta
    expect(() => assertCanExportReport({ id: 1, role: "admin" }, "financeiro")).not.toThrow();
    expect(() => assertCanExportReport({ id: 2, role: "supervisor", accessOverrides: MODULE as any }, "financeiro")).toThrow(/exportar/);
    // o único caminho do Sheets para os euros é o financeSummary (que tem requireFinanceTotals)
    const sheets = src("server/google/sheetsExport.ts");
    const fin = sheets.slice(sheets.indexOf("financeiro: {"), sheets.indexOf("faturacao: {"));
    expect(fin.match(/call\("/g)).toHaveLength(1);
    expect(fin).toContain(`call("invoices.financeSummary"`);
  });

  it("retryTransient: um FORBIDDEN (ou UNAUTHORIZED/BAD_REQUEST) não se repete; um erro de BD repete até 2 vezes", () => {
    for (const code of ["FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"]) expect(retryTransient(0, { data: { code } }), code).toBe(false);
    expect(retryTransient(0, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(true);
    expect(retryTransient(1, new Error("rede"))).toBe(true);
    expect(retryTransient(2, { data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
  });
});
