import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const state = vi.hoisted(() => ({ calls: [] as Array<[string, unknown[]]> }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityName: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getExpenseStats: async (...a: unknown[]) => { state.calls.push(["stats", a]); return null; },
  getUpcomingPayments: async (...a: unknown[]) => { state.calls.push(["upcoming", a]); return []; },
}));
import { appRouter } from "./routers";
import { isoWeekYearLisbon } from "../shared/caseRules";
import { withDraft } from "../shared/whatsappDrafts";

const root = resolve(import.meta.dirname, "..");

// P1 (1 out 2026): pequenos acertos.
beforeEach(() => { state.calls = []; });

describe("Financeiro: \"Pago\" e o filtro do painel", () => {
  const caller = () => appRouter.createCaller({ user: { id: 1, role: "super_admin" }, req: { headers: {} }, res: {} } as any);
  it("estatísticas e pagamentos próximos recebem o centro escolhido (antes ignorado)", async () => {
    await caller().expenses.stats({ projectId: 65 });
    await caller().expenses.upcomingPayments({ projectId: 65 });
    await caller().expenses.stats();
    expect(state.calls).toEqual([["stats", [{ projectId: 65 }]], ["upcoming", [7, { projectId: 65 }]], ["stats", [{ projectId: undefined }]]]);
  });
  it("\"Pago\" = pago no ano (do servidor), não total do ano − pendentes − atrasos de sempre", () => {
    const page = readFileSync(resolve(root, "client/src/pages/FinanceiroDashboard.tsx"), "utf8");
    expect(page).toContain("expenseStats?.paidYear?.total");
    expect(page).not.toMatch(/totalDespesasAnual\s*-\s*pendente\s*-\s*emAtraso/);
    expect(page).toContain("trpc.expenses.stats.useQuery({ projectId: filters.projectId }");
    const db = readFileSync(resolve(root, "server/db.ts"), "utf8");
    const fn = db.slice(db.indexOf("export async function getExpenseStats"), db.indexOf("export async function getUpcomingPayments"));
    expect(fn).toContain("projectFilterConds(expenses.projectId, opts.projectId)");
    expect(fn).not.toContain("projectScope(expenses.projectId)");
    const up = db.slice(db.indexOf("export async function getUpcomingPayments"), db.indexOf("export async function getUpcomingPayments") + 1500);
    expect(up).toContain("insertedBy: EXPENSE_PEOPLE_FIELDS.insertedBy");
  });
});

describe("Pessoas: semana ISO com o ano ISO", () => {
  it("1 jan 2027 é a semana 53 de 2026; 31 dez 2029 é a semana 1 de 2030", () => {
    expect(isoWeekYearLisbon("2027-01-01T12:00:00Z")).toEqual({ week: 53, year: 2026 });
    expect(isoWeekYearLisbon("2029-12-31T12:00:00Z")).toEqual({ week: 1, year: 2030 });
    expect(isoWeekYearLisbon("2026-10-01T12:00:00Z")).toEqual({ week: 40, year: 2026 });
  });
  it("o painel já não pede semanas: lê o motor da Avaliação nos últimos 7 dias operacionais (nunca o ano civil)", () => {
    const src = readFileSync(resolve(root, "client/src/pages/PessoasDashboard.tsx"), "utf8");
    expect(src).toContain("operationalDayOf(Date.now())");
    expect(src).toContain("trpc.evaluation.ranking.useQuery({ from: evalFrom, to: evalTo }");
    expect(src).not.toMatch(/currentYear\s*=\s*now\.getFullYear\(\)/);
  });
});

describe("WhatsApp: um rascunho por conversa (F11)", () => {
  it("a sugestão da IA vai para a conversa onde foi pedida, não para a aberta", () => {
    let d = withDraft({}, 1, "olá");
    d = withDraft(d, 2, "sugestão da IA"); // chegou depois de mudar para a 1
    expect(d).toEqual({ 1: "olá", 2: "sugestão da IA" });
  });
  it("limpar depois de enviar só mexe nessa conversa; vazio = sem rascunho; atualização por função", () => {
    let d = withDraft(withDraft({}, 1, "a"), 2, "b");
    d = withDraft(d, 1, "");
    expect(d).toEqual({ 2: "b" });
    d = withDraft(d, 2, (prev) => `${prev}\nresposta rápida`);
    expect(d[2]).toBe("b\nresposta rápida");
    const same = withDraft(d, 3, "");
    expect(same).toBe(d);
  });
  it("a página usa os rascunhos por conversa (a sugestão e o enviar escrevem na conversa do pedido)", () => {
    const src = readFileSync(resolve(root, "client/src/pages/WhatsAppInboxPage.tsx"), "utf8");
    expect(src).toContain("setDraft(v.conversationId, r.text)");
    expect(src).not.toMatch(/useState\(""\);\s*\n\s*const \[tplOpen/);
  });
});
