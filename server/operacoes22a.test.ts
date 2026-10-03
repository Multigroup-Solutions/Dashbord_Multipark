/**
 * P3 lote 22a — Operações: as compras online por pagar (PENDING) contam nas
 * contas OPERACIONAIS até serem recolhidas/canceladas (D6), nunca no dinheiro;
 * o painel de Operações só precisa do módulo dos painéis (D5, só contagens).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildOpsCountsSql } from "./multiparkDb/opsCounts";
import { buildSource } from "./multiparkDb/opsLists";
import { ParamList } from "./multiparkDb/read";
import { countsOnly, summarizeBookingStats } from "./opsStatsLive";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const range = { start: "2026-10-01 23:00:00", end: "2026-10-02 23:00:00", parkIds: ["p1"] };

describe("22a — compras por pagar nas contas operacionais (D6)", () => {
  it("no dinheiro (por omissão) ficam de fora; nas contas operacionais entram", () => {
    const money = buildOpsCountsSql({ ...range, events: ["created", "checkin", "checkout", "createdAll"] }).sql;
    expect(money).toContain(`NOT IN ('CANCELLED', 'PENDING')`);
    expect(money).toContain(`<> 'PENDING'`);
    const ops = buildOpsCountsSql({ ...range, events: ["created", "checkin", "checkout", "createdAll"], includePending: true }).sql;
    expect(ops).not.toContain("PENDING");
    expect(ops).toContain(`b."status"::text <> 'CANCELLED'`);
  });
  it("listas operacionais: com includePending não há filtro de PENDING (o MCP mantém-no)", () => {
    const spec = (includePending: boolean) => ({ kind: "entradas" as const, parkIds: ["p1"], ourParkIds: ["p1"], includePending });
    const withPending = new ParamList();
    buildSource(spec(true), withPending, range.start, range.end, false);
    expect(withPending.values).not.toContain("PENDING");
    const without = new ParamList();
    buildSource(spec(false), without, range.start, range.end, false);
    expect(without.values).toContain("PENDING");
  });
  it("as rotas operacionais pedem as por pagar; o Financeiro e o MCP não", () => {
    const r = src("server/routers.ts");
    expect(r).toMatch(/getMultiparkOpsList\(\{ \.\.\.input, state, includePending: true \}/);
    expect(r).toMatch(/getOperationsSummary\(input, \{ includePending: true \}\)/);
    expect(src("server/mcpApi.ts")).not.toContain("includePending");
  });
});

describe("22a — painel de Operações só com contagens (D5)", () => {
  it("countsOnly tira a receita toda", () => {
    const stats = summarizeBookingStats([
      { event: "created", day: "2026-10-02", parkId: "p1", count: 3, revenue: 120 },
      { event: "checkin", day: "2026-10-02", parkId: "p1", count: 2, revenue: 80 },
    ], { total: 10, today: "2026-10-02", monthStart: "2026-10-01", periodFrom: "2026-10-01", periodTo: "2026-10-02", parkInfo: new Map([["p1", { name: "Airpark", city: "Lisboa" }]]) });
    const c = countsOnly(stats);
    expect(c).toMatchObject({ total: 10, reservasHoje: 3, checkinHoje: 2 });
    expect(JSON.stringify(c)).not.toMatch(/revenue|receita/);
  });
  it("a rota pede o módulo dos painéis (não os totais financeiros) e a página usa-a", () => {
    const r = src("server/routers.ts");
    const i = r.indexOf("opsBookingCounts: protectedProcedure");
    expect(i).toBeGreaterThan(0);
    const body = r.slice(i, i + 700);
    expect(body).toContain(`requireAccess(ctx.user, "dashboards", "view")`);
    expect(body).not.toContain("requireFinanceTotals");
    expect(src("client/src/pages/OperacoesDashboard.tsx")).toContain("trpc.multipark.opsBookingCounts.useQuery(");
  });
});
