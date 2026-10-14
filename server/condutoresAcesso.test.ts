/**
 * Pessoas → Condutores e agentes: quem vê (Jorge, 14 out 2026: "isto não
 * devia aparecer a toda a gente").
 *  - Condutores e Agentes: supervisor (cidade), back office, admin e super
 *    admin — módulo próprio `condutores_agentes`; front office, team leader,
 *    condutor, extra e user não;
 *  - Desempenho: só o super admin, pelo papel;
 *  - servidor (procedimentos), menu, separadores, URL direto, pesquisa global,
 *    "Abrir agente" do RH e o MCP (dashboard_query corre os mesmos
 *    procedimentos) seguem a mesma regra.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => null,
  getUserPermissionOverrides: async () => ({}),
  getUserModuleOverrides: async () => ({}),
  getEmployeeByUserId: async () => null,
  getCheckoutDriversFromDb: async () => [],
  getAgentHistoryFromDb: async () => ({ total: 0, period: { startDate: "", endDate: "" }, agentName: "", agentUserId: "", history: [] }),
}));
vi.mock("./movementPeople", () => ({
  loadMovementPeople: async () => ({ available: true, rows: [] }),
  brandParkIdsFor: async () => undefined,
}));
vi.mock("./personIdentity", async (original) => ({
  ...(await original<object>()),
  employeesWithAgents: async () => [],
}));
vi.mock("./peoplePerformance", () => ({
  loadPeoplePerformance: async () => ({ ok: true }),
}));

import { appRouter } from "./routers";
import { MATRIX, ROLES, can, scopeFor, type Role } from "../shared/access";
import { CONDUTORES_MODULE, condutoresTabs, initialCondutoresTab } from "../shared/condutoresAccess";
import { NAV_ENTRIES, matchNavigation } from "../shared/globalSearch";
import { decideRoute } from "../shared/routeAccess";

const root = resolve(import.meta.dirname, "..");
const src = (p: string) => readFileSync(resolve(root, p), "utf8");
const caller = (role: string, accessOverrides?: Record<string, unknown>) =>
  appRouter.createCaller({ user: { id: 1, role, name: "Rita", accessOverrides }, req: { headers: {} }, res: {} } as any);

const ALLOWED: Role[] = ["supervisor", "backoffice", "admin", "super_admin"];
const DENIED: Role[] = ["user", "extra", "condutor", "team_leader", "frontoffice"];

describe("matriz: módulo condutores_agentes", () => {
  it("só supervisor (cidade), back office, admin e super admin; mais ninguém", () => {
    expect(ROLES.filter((r) => can(r, CONDUTORES_MODULE, "view"))).toEqual(ALLOWED);
    expect(scopeFor("supervisor", CONDUTORES_MODULE)).toBe("city");
    for (const r of ["backoffice", "admin", "super_admin"] as Role[]) expect(scopeFor(r, CONDUTORES_MODULE)).toBe("national");
    for (const r of DENIED) expect(MATRIX[CONDUTORES_MODULE][r].access).toBe("none");
    // só ver (ligar/separar agentes continua a pedir "gerir RH")
    for (const r of ALLOWED) expect(MATRIX[CONDUTORES_MODULE][r].actions).toEqual(["view"]);
  });

  it("antes vinha das Críticas: o team leader e o front office continuam com as Críticas, mas já não com isto", () => {
    expect(can("team_leader", "criticas", "view")).toBe(true);
    expect(can("frontoffice", "criticas", "view")).toBe(true);
    expect(can("team_leader", CONDUTORES_MODULE, "view")).toBe(false);
    expect(can("frontoffice", CONDUTORES_MODULE, "view")).toBe(false);
  });
});

describe("cliente: separadores (shared/condutoresAccess.ts)", () => {
  it("super admin vê os três; admin, back office e supervisor só Condutores e Agentes", () => {
    expect(condutoresTabs({ role: "super_admin" })).toEqual(["drivers", "agents", "performance"]);
    for (const role of ["admin", "backoffice", "supervisor"]) expect(condutoresTabs({ role })).toEqual(["drivers", "agents"]);
  });
  it("front office, team leader, condutor, extra e sem sessão: nada (a página diz Sem acesso)", () => {
    for (const role of DENIED) expect(condutoresTabs({ role })).toEqual([]);
    expect(condutoresTabs(null)).toEqual([]);
  });
  it("uma permissão por pessoa dá ou tira o módulo, mas nunca o Desempenho", () => {
    const grant = { condutores_agentes: { access: "city", actions: ["view"] } } as any;
    const revoke = { condutores_agentes: { access: "none", actions: [] } } as any;
    expect(condutoresTabs({ role: "team_leader", accessOverrides: grant })).toEqual(["drivers", "agents"]);
    expect(condutoresTabs({ role: "supervisor", accessOverrides: revoke })).toEqual([]);
    expect(condutoresTabs({ role: "admin", accessOverrides: { condutores_agentes: { access: "national", actions: ["view", "edit", "export", "manage"] } } as any })).not.toContain("performance");
  });
  it("abre no separador pedido só se o vê (?ficha= → Agentes)", () => {
    expect(initialCondutoresTab(["drivers", "agents"], "agents")).toBe("agents");
    expect(initialCondutoresTab(["drivers", "agents"], "performance")).toBe("drivers");
    expect(initialCondutoresTab([], "drivers")).toBeNull();
  });
  it("a página usa a regra; o menu e a pesquisa global pedem o mesmo módulo", () => {
    const page = src("client/src/pages/CondutoresAgentesPage.tsx");
    expect(page).toContain("condutoresTabs(user as any)");
    expect(page).toContain("Sem acesso a esta página.");
    expect(page).toMatch(/has\("performance"\) && <TabsTrigger value="performance">/);
    expect(page).toMatch(/has\("performance"\) && <TabsContent value="performance"/);
    expect(page).not.toContain('"criticas"');
    const layout = src("client/src/components/DashboardLayout.tsx");
    expect(layout).toContain('{ icon: Car, label: "Condutores e agentes", path: "/pessoas/condutores-agentes", module: "condutores_agentes" }');
    const nav = NAV_ENTRIES.find((e) => e.path === "/pessoas/condutores-agentes");
    expect(nav?.modules).toEqual(["condutores_agentes"]);
    expect(matchNavigation("condutores", { role: "team_leader" } as any).some((e) => e.href === "/pessoas/condutores-agentes")).toBe(false);
    expect(matchNavigation("condutores", { role: "supervisor" } as any).some((e) => e.href === "/pessoas/condutores-agentes")).toBe(true);
  });
  it("URL direto: quem não tem o item no menu leva Sem acesso", () => {
    const allMenuPaths = new Set(["/pessoas/condutores-agentes", "/criticas"]);
    expect(decideRoute({ path: "/pessoas/condutores-agentes", allowedPaths: new Set(["/criticas"]), allMenuPaths, lowRole: false, firstAllowed: "/criticas" })).toEqual({ kind: "no_access" });
    expect(decideRoute({ path: "/pessoas/condutores-agentes?ficha=12", allowedPaths: new Set(["/pessoas/condutores-agentes"]), allMenuPaths, lowRole: false, firstAllowed: "/" })).toEqual({ kind: "ok" });
  });
});

describe("servidor: os procedimentos recusam quem não pode (e o MCP corre-os como quem criou a chave)", () => {
  const range = { startDate: "2026-10-01", endDate: "2026-10-07" };
  const calls = (role: string, o?: Record<string, unknown>) => {
    const c = caller(role, o);
    return [
      () => c.reviews.movementPeople({ ...range, drivers: true }),
      () => c.reviews.agentPeople(),
      () => c.reviews.agentHistory({ ...range, agentUserIds: ["u1"] }),
      () => c.reviews.checkoutDrivers(range),
    ];
  };
  it.each(DENIED)("%s: FORBIDDEN em todas as leituras de Condutores e agentes", async (role) => {
    for (const run of calls(role)) await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it.each(ALLOWED)("%s: lê", async (role) => {
    for (const run of calls(role)) await expect(run()).resolves.toBeDefined();
  });
  it("Desempenho: só o super admin, mesmo com o módulo dado por permissão", async () => {
    const input = { period: "month" as const, anchor: "2026-10-14", group: "drivers" as const };
    await expect(caller("super_admin").evaluation.peoplePerformance(input)).resolves.toEqual({ ok: true });
    for (const role of ["admin", "backoffice", "supervisor", "team_leader"]) {
      await expect(caller(role, { condutores_agentes: { access: "national", actions: ["view"] } }).evaluation.peoplePerformance(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
  it("as quatro leituras pedem o módulo novo (nenhuma ficou nas Críticas) e o 'Abrir agente' do RH também", () => {
    const r = src("server/routers.ts");
    const block = r.slice(r.indexOf("checkoutDrivers: protectedProcedure"), r.indexOf("// ─── FORMAÇÃO E APOIO"));
    expect(block.match(/requireAccess\(ctx\.user, "condutores_agentes", "view"\)/g)).toHaveLength(4);
    expect(block).not.toContain('"criticas"');
    expect(src("server/rhRouter.ts")).toContain("canOpenAgent: canAccess(ctx.user, 'condutores_agentes', 'view')");
    // o botão só aparece com canOpenAgent
    expect(src("client/src/components/EmployeeAccessAvailability.tsx")).toContain("d.canOpenAgent && d.agents.length > 0");
  });
});
