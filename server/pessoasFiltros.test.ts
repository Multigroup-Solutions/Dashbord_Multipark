/**
 * Jorge, 14 out 2026 — Condutores e agentes (Pessoas):
 *  - Condutores e Agentes só a supervisor, back office, admin e super admin; Desempenho só o super admin;
 *  - procurar pelo nome e filtros por parâmetros (coluna ≥ / ≤ valor);
 *  - o Desempenho escolhe as colunas (as que estão a zero para toda a gente escondem-se).
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { condutoresTabs } from "../shared/condutoresAccess";
import { foldName, matchesSearch, parseRuleValue, passesRules, upsertRule, type MetricRule } from "../shared/peopleFilters";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("quem vê Condutores, Agentes e Desempenho", () => {
  // 14 out 2026 (2.º pedido do Jorge): o back office também vê Condutores e Agentes. A regra é o módulo
  // `condutores_agentes` (shared/access.ts → shared/condutoresAccess.ts); os testes completos estão em
  // server/condutoresAcesso.test.ts. Aqui só o resumo, para quem procura por este ficheiro.
  it("Condutores e Agentes: supervisor, back office, admin e super admin; os outros não", () => {
    for (const r of ["supervisor", "backoffice", "admin", "super_admin"]) expect(condutoresTabs({ role: r })).toContain("drivers");
    for (const r of ["user", "extra", "condutor", "team_leader", "frontoffice", "", null]) expect(condutoresTabs({ role: r as any })).toEqual([]);
    expect(condutoresTabs(null)).toEqual([]);
  });
  it("Desempenho: só o super admin", () => {
    expect(condutoresTabs({ role: "super_admin" })).toContain("performance");
    for (const r of ["admin", "backoffice", "supervisor", "team_leader"]) expect(condutoresTabs({ role: r })).not.toContain("performance");
  });
  it("o servidor recusa as consultas a quem não tem o módulo", () => {
    const r = src("server/routers.ts");
    for (const name of ["checkoutDrivers", "movementPeople", "agentPeople", "agentHistory"]) {
      const i = r.indexOf(`${name}: protectedProcedure`);
      expect(i).toBeGreaterThan(0);
      expect(r.slice(i, i + 1200)).toContain('requireAccess(ctx.user, "condutores_agentes", "view");');
    }
  });
  it("já não há uma segunda regra por papéis (shared/peopleTabsAccess.ts saiu)", () => {
    expect(existsSync(new URL("../shared/peopleTabsAccess.ts", import.meta.url))).toBe(false);
    expect(src("client/src/components/DashboardLayout.tsx")).toContain('path: "/pessoas/condutores-agentes", module: "condutores_agentes" }');
    expect(src("server/rhRouter.ts")).toContain("canOpenAgent: canAccess(ctx.user, 'condutores_agentes', 'view')");
  });
});

describe("procurar pelo nome", () => {
  it("sem acentos nem maiúsculas, por palavras", () => {
    expect(foldName("  João   ALVES ")).toBe("joao alves");
    expect(matchesSearch("joao alv", "João Alves")).toBe(true);
    expect(matchesSearch("alves joão", "João Alves")).toBe(true);
    expect(matchesSearch("joão silva", "João Alves")).toBe(false);
    expect(matchesSearch("", "qualquer")).toBe(true);
    expect(matchesSearch("ag12", "Pedro", null, "AG12")).toBe(true);
  });
});

describe("filtros por parâmetros", () => {
  const rows = [
    { name: "A", perHour: 12, hours: 40 },
    { name: "B", perHour: 8, hours: 10 },
    { name: "C", perHour: null as number | null, hours: 2 },
  ];
  const get = (r: (typeof rows)[number], k: string) => (r as any)[k] as number | null;
  it("todas as regras ao mesmo tempo; sem valor não passa", () => {
    const rules: MetricRule[] = [{ key: "perHour", op: "gte", value: 8 }, { key: "hours", op: "lte", value: 20 }];
    expect(rows.filter((r) => passesRules(r, rules, get)).map((r) => r.name)).toEqual(["B"]);
    expect(rows.filter((r) => passesRules(r, [{ key: "perHour", op: "lte", value: 100 }], get)).map((r) => r.name)).toEqual(["A", "B"]);
    expect(rows.filter((r) => passesRules(r, [], get))).toHaveLength(3);
  });
  it("valores escritos com vírgula; lixo não vale", () => {
    expect(parseRuleValue("4,5")).toBe(4.5);
    expect(parseRuleValue(" 10 ")).toBe(10);
    expect(parseRuleValue("-2")).toBe(-2);
    expect(parseRuleValue("")).toBeNull();
    expect(parseRuleValue("abc")).toBeNull();
    expect(parseRuleValue("1e9")).toBeNull();
  });
  it("a mesma coluna e o mesmo sinal substituem a regra anterior", () => {
    const a = upsertRule([], { key: "perHour", op: "gte", value: 8 });
    const b = upsertRule(a, { key: "perHour", op: "gte", value: 10 });
    const c = upsertRule(b, { key: "perHour", op: "lte", value: 20 });
    expect(c).toEqual([{ key: "perHour", op: "gte", value: 10 }, { key: "perHour", op: "lte", value: 20 }]);
  });
});

describe("os ecrãs usam a barra de filtros", () => {
  it("Desempenho: pesquisa, parâmetros, colunas e a tabela sem largura mínima fixa", () => {
    const c = src("client/src/components/people/PeoplePerformancePanel.tsx");
    expect(c).toContain("<PeopleFilterBar");
    expect(c).toContain("matchesSearch(search, r.name, r.position)");
    expect(c).toContain("passesRules(r, rules,");
    expect(c).toContain("onShown={chooseCols} onToggleShown={toggleCol} onResetShown={() => chooseCols(null)}");
    expect(c).toContain("const next: ColChoices = { ...colChoices, [k]: show };");
    // só as escolhas explícitas ficam guardadas; as outras colunas seguem a omissão (com valor no período)
    expect(c).toContain("colChoices[k] ?? ((d?.people ?? []) as Person[]).some((p) => (p.totals[k] ?? 0) !== 0)");
    expect(c).not.toContain("min-w-[900px]");
  });
  it("Condutores e Agentes: a pesquisa vale para os dois", () => {
    const c = src("client/src/components/people/MovementPeoplePanel.tsx");
    expect(c).toContain("<PeopleFilterBar search={q} onSearch={setQ}");
    expect(c).toContain("matchesSearch(q, r.name, r.agentName, ...r.agentUserIds)");
    // as mudanças de lugar aparecem nos condutores e nos agentes, e abrem o detalhe
    expect(c).toContain('spotChanges: ["SPOT_CHANGE"]');
    expect(c).toMatch(/\{num\(r, "spotChanges", "Mudanças de lugar"\)\}<\/td>\s*\{mode === "drivers"/);
  });
});
