/**
 * Lote 42b — Condutores e agentes: lista por pessoa (as contas de agente da
 * mesma ficha somam), condutores = quem mexeu em carros, km do GPS, filtro de
 * cidade e marca, detalhe ao clicar no número e ficha ao clicar no nome.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const summaries = vi.fn();
vi.mock("./multiparkDb/movements", async (orig) => ({
  ...(await orig<object>()),
  getAgentMovementSummaries: (...a: any[]) => summaries(...a),
}));
vi.mock("./evaluationIdentity", () => ({
  loadEvaluationIdentity: async () => ({
    identity: {
      agent: (id: string, name: string | null) =>
        id === "a1" || id === "a2" ? { kind: "colaborador", key: "emp:7", employeeId: 7, name: "Ana Silva" }
        : id === "sys" ? { kind: "ignorado" }
        : { kind: "por_ligar", key: `ag:${id}`, employeeId: null, name: name ?? id },
    },
    employees: [],
  }),
}));
const execs: string[] = [];
vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: any) => {
      const { MySqlDialect } = await import("drizzle-orm/mysql-core");
      const c = new MySqlDialect().sqlToQuery(q);
      execs.push(c.sql);
      if (c.sql.includes("FROM daily_driver_history")) return [[{ employeeId: 7, km: 2 }]];
      if (c.sql.includes("FROM driver_day_shares")) return [[{ employeeId: 7, km: 40.25 }]];
      return [[]];
    },
  }),
}));

import { loadMovementPeople } from "./movementPeople";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const s = (o: any) => ({ agentUserId: "x", agentName: null, day: null, total: 0, byType: {}, recolhas: 0, entregas: 0, movements: 0, spotChanges: 0, bookings: 0, firstAt: null, lastAt: null, platforms: [], checkInsSigned: 0, checkOutsSigned: 0, occurrencesCreated: 0, occurrencesResolved: 0, reviews: 0, reviewsLow: 0, reviewAvg: null, ...o });

describe("42b: uma linha por pessoa", () => {
  it("as contas da mesma ficha somam, os de sistema saem, km do GPS; condutores = quem mexeu em carros", async () => {
    summaries.mockResolvedValue({ available: true, data: [
      s({ agentUserId: "a1", agentName: "Ana", total: 10, recolhas: 3, entregas: 2, movements: 4, byType: { CHECK_IN: 3 } }),
      s({ agentUserId: "a2", agentName: "Ana S", total: 5, recolhas: 1, entregas: 1, movements: 1 }),
      s({ agentUserId: "sys", agentName: "system", total: 99, recolhas: 9 }),
      s({ agentUserId: "bo1", agentName: "Back Office", total: 30 }), // só alterações/reservas
    ] });
    const all = await loadMovementPeople({ from: "2026-10-01", to: "2026-10-07", cities: ["Lisboa"], parkIds: ["p1"] });
    expect(all.available).toBe(true);
    if (!all.available) return;
    const ana = all.rows.find((r) => r.employeeId === 7)!;
    expect(ana).toMatchObject({ name: "Ana Silva", recolhas: 4, entregas: 3, movements: 5, total: 15, km: 42.3 });
    expect(ana.agentUserIds.sort()).toEqual(["a1", "a2"]);
    expect(all.rows.some((r) => r.name === "system")).toBe(false);
    expect(all.rows.find((r) => r.name === "Back Office")).toMatchObject({ kind: "por_ligar", km: null });
    // o filtro chega à leitura da Multipark
    expect(summaries.mock.calls[0][0]).toMatchObject({ startDay: "2026-10-01", endDay: "2026-10-07", byDay: false, cities: ["Lisboa"], parkIds: ["p1"] });
    const drivers = await loadMovementPeople({ from: "2026-10-01", to: "2026-10-07", drivers: true });
    expect(drivers.available && drivers.rows.map((r) => r.name)).toEqual(["Ana Silva"]);
    expect(execs.some((q) => /INSERT|UPDATE|DELETE/.test(q))).toBe(false);
  });

  it("sem a Multipark diz porquê (não é lista vazia)", async () => {
    summaries.mockResolvedValue({ available: false, reason: "BD da Multipark indisponível.", code: "CONNECT_FAILED" });
    expect(await loadMovementPeople({ from: "2026-10-01", to: "2026-10-07" })).toEqual({ available: false, reason: "BD da Multipark indisponível.", code: "CONNECT_FAILED" });
  });
});

describe("42b: rotas e página", () => {
  it("rota: Críticas (como a página), no máximo 62 dias, filtro de cidade e marca", () => {
    const r = read("server/routers.ts");
    const i = r.indexOf("movementPeople: protectedProcedure");
    const block = r.slice(i, i + 1400);
    expect(block).toContain('requireAccess(ctx.user, "criticas", "view")');
    expect(block).toContain("days > 62");
    expect(block).toContain("cities: scopedCityNamesLive(), parkIds: await brandParkIdsFor(input.projectId)");
    // o detalhe também de agentes sem ficha (só nas cidades de quem vê — getAgentHistoryFromDb usa scopedCityNamesLive)
    expect(r).toContain("agentUserIds: z.array(z.string().min(1).max(128)).min(1).max(10).optional()");
    expect(read("server/db.ts")).toMatch(/getAgentHistoryFromDb[\s\S]{0,2500}scopedCityNamesLive\(\)/);
  });

  it("lista primeiro; nome → ficha; número → detalhe; ligações e tirar da lista para quem gere o RH", () => {
    const c = read("client/src/components/people/MovementPeoplePanel.tsx");
    expect(c).toContain("trpc.reviews.movementPeople.useQuery({ startDate: start, endDate: end, projectId, drivers: mode === \"drivers\" }");
    expect(c).toContain("openEmployee(r.employeeId)");
    expect(c).toContain("setDetail({ employeeId: r.employeeId, agentUserIds: r.agentUserIds");
    expect(c).toContain('label="Km (GPS)"');
    expect(c).toContain("<PersonLinksDialog");
    expect(c).toContain("trpc.multipark.ignoreAgent.useMutation");
    expect(c).toContain('can(user as any, "rh", "manage")');
    const p = read("client/src/pages/CondutoresAgentesPage.tsx");
    expect(p).toContain('<MovementPeoplePanel mode="drivers" />');
    expect(p).toContain('<MovementPeoplePanel mode="agents" initialDetail={initial} />');
  });
});
