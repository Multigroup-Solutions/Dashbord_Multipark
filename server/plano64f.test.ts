/**
 * Plano 64, PR F — Marketing, rótulos e Ocorrências pela fonte atual.
 *  - F3: na Avaliação, a tabela antiga `incidents` só conta antes de LEGACY_INCIDENTS_UNTIL_DAY
 *    (= LIVE_ACTIONS_SINCE, 2 mar 2026); informativo — os pontos não mudam.
 *  - F4: no Cruzamento de condutores (Perdidos), as ocorrências contra o condutor são os acidentes
 *    confirmados pelo TL desde ACCIDENTS_FROM_DAY (a regra da Avaliação); a antiga só antes disso.
 *  - F1/F5/F6/F7: rótulos e linhas no ecrã (verificados no código-fonte).
 * A BD é uma imitação: nada de BD real.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; params: unknown[] }>,
  attached: [] as any[],
  legacy: [] as any[],
  accidents: [] as any[],
}));

/** Texto e parâmetros de um `sql` do drizzle (com os `sql` encaixados lá dentro). */
function flat(q: any): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const walk = (x: any): string => {
    if (x && Array.isArray(x.queryChunks)) return x.queryChunks.map(walk).join("");
    if (x && Array.isArray(x.value)) return x.value.join(""); // StringChunk
    params.push(x);
    return "?";
  };
  return { text: walk(q), params };
}

vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({
    execute: async (q: any) => {
      const f = flat(q);
      state.queries.push(f);
      if (f.text.includes("lost_found_attached_drivers")) return [state.attached];
      if (f.text.includes("FROM incidents i")) return [state.legacy];
      if (f.text.includes("FROM evaluation_accidents a")) return [state.accidents];
      return [[]];
    },
  }),
}));
vi.mock("./multiparkDb/historyLive", () => ({ readLiveHistory: async () => [], readLiveHistoryByAgent: async () => [] }));
vi.mock("./personIdentity", () => ({ employeesForAgentIds: async () => new Map() }));

import { computeEmployeeDays } from "./evaluationCore";
import { buildEvaluationIdentity } from "./evaluationIdentity";
import { LIVE_ACTIONS_SINCE } from "./multiparkDb/activityLive";
import { getDriverCrossRef } from "./caseOps";
import { cityScope } from "./cityScope";
import { ACCIDENTS_FROM_DAY, LEGACY_INCIDENTS_UNTIL_DAY, accidentCounts, legacyIncidentCounts, scoreOf } from "../shared/evaluationRules";
import { crossRefOccurrenceWindows, driverOccurrenceCounts } from "../shared/driverOccurrences";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// ─── F3 ──────────────────────────────────────────────────────────────────────

describe("F3 — Avaliação: a tabela antiga das ocorrências só antes de 2 mar 2026", () => {
  const identity = buildEvaluationIdentity({
    employees: [{ id: 1, fullName: "Gelson Manuel Leão Sousa", userId: 10, multiparkAgentName: null, multiparkAgentUserId: "mp-1" }],
    agentAliases: [], accountAliases: [],
  });
  const base = (startDay: string, endDay: string, extra: Partial<Parameters<typeof computeEmployeeDays>[0]> = {}) => computeEmployeeDays({
    startDay, endDay, identity, employees: new Map(), actions: [], ponto: [], assignments: [], incidents: [],
    complaints: [], speedAlerts: [], penalties: [], rate: () => 0, tlWorkingDaysPerMonth: 22, ...extra,
  });
  /** Ocorrência antiga registada pelo utilizador 10 (ficha 1), contra a própria ficha, confirmada. */
  const legacy = (at: string) => ({ at, incidentType: "damage", reportedBy: 10, employeeId: 1, status: "open", driverConfirmed: 1 });

  it("o corte é o dia das ações ao vivo (LIVE_ACTIONS_SINCE)", () => {
    expect(LEGACY_INCIDENTS_UNTIL_DAY).toBe("2026-03-02");
    expect(LEGACY_INCIDENTS_UNTIL_DAY).toBe(LIVE_ACTIONS_SINCE);
    expect(legacyIncidentCounts("2026-03-01")).toBe(true);
    expect(legacyIncidentCounts("2026-03-02")).toBe(false);
  });

  it("antes do corte a ocorrência antiga conta (registou + atribuída)", () => {
    const out = base("2026-02-20", "2026-02-20", { incidents: [legacy("2026-02-20 10:00:00")] });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].metrics).toMatchObject({ incidentsReported: 1, incidentsAgainst: 1 });
  });

  it("num dia ≥ corte a ocorrência antiga é ignorada (não soma às da app)", () => {
    const out = base("2026-09-24", "2026-09-24", {
      incidents: [legacy("2026-09-24 10:00:00")],
      agentOccurrences: [{ agentUserId: "mp-1", agentName: "Gelson Sousa", day: "2026-09-24", n: 1 }],
    });
    expect(out.rows).toHaveLength(1);
    // só a da app ao vivo; a antiga já não soma (antes dava 2 registadas e 1 atribuída)
    expect(out.rows[0].metrics).toMatchObject({ incidentsReported: 1, incidentsAgainst: 0 });
  });

  it("a fronteira é o dia OPERACIONAL (03h de Lisboa)", () => {
    // 2 mar 02:30 UTC = 02:30 de Lisboa → ainda é o dia operacional 1 mar (conta)
    const before = base("2026-03-01", "2026-03-02", { incidents: [legacy("2026-03-02 02:30:00")] });
    expect(before.rows.map((r) => [r.day, r.metrics.incidentsReported])).toEqual([["2026-03-01", 1]]);
    // 2 mar 03:30 → dia operacional 2 mar (já não conta)
    const after = base("2026-03-01", "2026-03-02", { incidents: [legacy("2026-03-02 03:30:00")] });
    expect(after.rows).toHaveLength(0);
  });

  it("Igual: os pontos não mudam (as ocorrências são informativas)", () => {
    const actionCounts = [{ agentUserId: "mp-1", agentName: "Gelson Sousa", day: "2026-09-24", shift: "night" as const, changeType: "MOVEMENT", n: 3, parkingMoves: 1 }];
    const sem = base("2026-09-24", "2026-09-24", { actionCounts });
    const com = base("2026-09-24", "2026-09-24", { actionCounts, incidents: [legacy("2026-09-24 10:00:00")] });
    expect(scoreOf(com.rows[0].metrics)).toEqual(scoreOf(sem.rows[0].metrics));
    // e antes do corte, onde a antiga conta, também não mexe nos pontos
    const ac2 = [{ ...actionCounts[0], day: "2026-02-20" }];
    const sem2 = base("2026-02-20", "2026-02-20", { actionCounts: ac2 });
    const com2 = base("2026-02-20", "2026-02-20", { actionCounts: ac2, incidents: [legacy("2026-02-20 10:00:00")] });
    expect(com2.rows[0].metrics.incidentsReported).toBe(1);
    expect(scoreOf(com2.rows[0].metrics).totalPoints).toBe(scoreOf(sem2.rows[0].metrics).totalPoints);
    expect(com2.rows[0].metrics.accidents).toBe(0);
  });

  it("Igual: os acidentes confirmados contam como antes (a mesma regra, agora numa função)", () => {
    expect(accidentCounts({ day: ACCIDENTS_FROM_DAY })).toBe(true);
    expect(accidentCounts({ day: "2026-10-02" })).toBe(false);
    expect(accidentCounts({ day: "2026-10-05", voidedAt: "2026-10-06 10:00:00" })).toBe(false);
    const out = base("2026-10-01", "2026-10-05", { confirmedAccidents: [{ employeeId: 5, day: "2026-10-05" }, { employeeId: 5, day: "2026-10-02" }] });
    expect(out.rows.map((r) => [r.day, r.metrics.accidents, r.metrics.incidentsAgainst])).toEqual([["2026-10-05", 1, 1]]);
  });
});

// ─── F4 ──────────────────────────────────────────────────────────────────────

describe("F4 — Cruzamento de condutores: ocorrências contra o condutor pela fonte da Avaliação", () => {
  it("as janelas: a antiga até ao início do dia operacional do corte; os acidentes a partir dele", () => {
    expect(ACCIDENTS_FROM_DAY).toBe("2026-10-03");
    // todo antes: só a antiga, com a janela de sempre (igual a antes)
    expect(crossRefOccurrenceWindows("2026-09-01", "2026-09-30")).toEqual({
      legacy: { start: "2026-08-31 23:00:00", end: "2026-09-30 23:00:00" }, accidents: null,
    });
    // a cavalo: a antiga até 3 out 03:00 de Lisboa (02:00 UTC), os acidentes de 3 out em diante
    expect(crossRefOccurrenceWindows("2026-09-20", "2026-10-10")).toEqual({
      legacy: { start: "2026-09-19 23:00:00", end: "2026-10-03 02:00:00" }, accidents: { fromDay: "2026-10-03", toDay: "2026-10-10" },
    });
    // todo depois: só os acidentes
    expect(crossRefOccurrenceWindows("2026-10-05", "2026-10-10")).toEqual({ legacy: null, accidents: { fromDay: "2026-10-05", toDay: "2026-10-10" } });
  });

  it("um acidente confirmado conta para o condutor; um anulado (desfeito) não conta", () => {
    const w = crossRefOccurrenceWindows("2026-10-01", "2026-10-31");
    const out = driverOccurrenceCounts(new Map([[5, 2]]), [
      { employeeId: 5, day: "2026-10-05", voidedAt: null },
      { employeeId: 6, day: "2026-10-06", voidedAt: "2026-10-07 10:00:00" },
      { employeeId: 7, day: "2026-10-02", voidedAt: null }, // antes do corte: não conta
      { employeeId: null, day: "2026-10-08", voidedAt: null },
    ], w);
    expect(Object.fromEntries(out)).toEqual({ 5: 3 });
  });

  it("período todo depois do corte: as antigas não entram (mesmo que venham)", () => {
    const w = crossRefOccurrenceWindows("2026-10-05", "2026-10-10");
    expect(Object.fromEntries(driverOccurrenceCounts(new Map([[5, 4]]), [], w))).toEqual({});
  });

  describe("getDriverCrossRef (BD imitada)", () => {
    beforeEach(() => {
      state.queries = [];
      state.attached = [
        { caseId: 1, employeeId: 5, name: "Rui", caseDescription: "Óculos", caseStatus: "new", caseCreatedAt: "2026-10-04 10:00:00", casePlate: null, bookingRef: null, employeeName: "Rui Costa" },
        { caseId: 2, employeeId: 6, name: "Ana", caseDescription: "Carteira", caseStatus: "new", caseCreatedAt: "2026-10-05 10:00:00", casePlate: null, bookingRef: null, employeeName: "Ana Lima" },
      ];
      state.legacy = [{ employeeId: 5, n: 2 }];
      state.accidents = [
        { employeeId: 5, day: "2026-10-05", voidedAt: null },
        { employeeId: 6, day: "2026-10-06", voidedAt: "2026-10-07 10:00:00" },
      ];
    });

    it("a cavalo do corte: antigas até 3 out 03:00 + acidentes ativos desde 3 out", async () => {
      const r = await getDriverCrossRef({ from: "2026-09-20", to: "2026-10-10" });
      const byEmp = Object.fromEntries(r.rows.map((x) => [x.employeeId, x.incidents]));
      expect(byEmp).toEqual({ 5: 3, 6: 0 });
      const legacyQ = state.queries.find((q) => q.text.includes("FROM incidents i"))!;
      expect(legacyQ.params).toContain("2026-09-19 23:00:00");
      expect(legacyQ.params).toContain("2026-10-03 02:00:00");
      expect(legacyQ.params).not.toContain("2026-10-10 23:00:00");
      const accQ = state.queries.find((q) => q.text.includes("FROM evaluation_accidents a"))!;
      expect(accQ.params).toEqual(expect.arrayContaining(["2026-10-03", "2026-10-10"]));
    });

    it("Igual: um período todo antes do corte lê a antiga como sempre e não lê os acidentes", async () => {
      const r = await getDriverCrossRef({ from: "2026-09-01", to: "2026-09-30" });
      expect(Object.fromEntries(r.rows.map((x) => [x.employeeId, x.incidents]))).toEqual({ 5: 2, 6: 0 });
      const legacyQ = state.queries.find((q) => q.text.includes("FROM incidents i"))!;
      expect(legacyQ.params).toEqual(expect.arrayContaining(["2026-08-31 23:00:00", "2026-09-30 23:00:00"]));
      expect(state.queries.some((q) => q.text.includes("evaluation_accidents"))).toBe(false);
    });

    it("um período todo depois do corte não lê a tabela antiga", async () => {
      const r = await getDriverCrossRef({ from: "2026-10-04", to: "2026-10-10" });
      expect(state.queries.some((q) => q.text.includes("FROM incidents i"))).toBe(false);
      expect(Object.fromEntries(r.rows.map((x) => [x.employeeId, x.incidents]))).toEqual({ 5: 1, 6: 0 });
    });

    it("cidade: quem só vê Lisboa lê os acidentes dos parques de Lisboa (pelo nome da cidade)", async () => {
      const access = { all: false, defaultCityId: 1, cityName: "Lisboa", cityNames: ["Lisboa"], cityIds: [1], projectIds: [1, 11], missingCostCenter: false };
      await cityScope.run(access as any, () => getDriverCrossRef({ from: "2026-10-04", to: "2026-10-10" }));
      const accQ = state.queries.find((q) => q.text.includes("FROM evaluation_accidents a"))!;
      expect(accQ.text).toMatch(/LOWER\(TRIM\(a\.parkCity\)\) IN/);
      expect(accQ.params).toEqual(expect.arrayContaining(["lisboa", "lisbon"]));
    });

    it("'Sem cidade' só para quem vê todas: só os acidentes sem cidade do parque", async () => {
      await getDriverCrossRef({ from: "2026-10-04", to: "2026-10-10", noProject: true });
      const accQ = state.queries.find((q) => q.text.includes("FROM evaluation_accidents a"))!;
      expect(accQ.text).toMatch(/a\.parkCity IS NULL OR TRIM\(a\.parkCity\) = ''/);
    });
  });
});

// ─── Rótulos (F1, F5, F6, F7, F8) ───────────────────────────────────────────

describe("rótulos e linhas no ecrã", () => {
  it("F1: o gráfico e a tabela por dia dizem 'Conversões (Google + Meta)', como o cartão", () => {
    const panel = src("client/src/components/marketing/MarketingDashboardPanel.tsx");
    expect(panel).not.toContain('"Conversões Google"');
    expect(panel).not.toContain(">Conversões Google<");
    expect(panel).toContain('name="Conversões (Google + Meta)"');
    expect(panel).toContain(">Conversões (Google + Meta)</TableHead>");
  });

  it("F5: o rodapé da Caixa já não fala de sincronização", () => {
    const caixa = src("client/src/pages/CaixaPage.tsx");
    expect(caixa).not.toContain("sincronização Multipark");
    expect(caixa).toContain("Dados que a BD da Multipark não tem");
  });

  it("F6: a tabela por marca tem a linha 'Sem marca' e soma-a no total", () => {
    const page = src("client/src/pages/MarketingGoogleAdsPage.tsx");
    expect(page).toContain(">Sem marca</td>");
    expect(page).toMatch(/const sum = \(k: string\) => rows\.reduce\(.*\) \+ Number\(noBrand\?\.\[k\] \?\? 0\)/);
    const stats = src("server/integrations/googleAds/marketingStats.ts");
    expect(stats).toContain("withoutBrand: bookingsError ? null : withoutBrand");
  });

  it("F7: Dashboards → Marketing mostra os avisos do topo de /marketing", () => {
    const dash = src("client/src/pages/DashboardsPage.tsx");
    expect(dash).toContain("<MarketingTopAlerts /><MarketingDashboardPanel />");
    const page = src("client/src/pages/MarketingPage.tsx");
    expect(page).toMatch(/export function MarketingTopAlerts\(\)[\s\S]*<SyncHealthBanner \/>[\s\S]*<AnomalyAlerts domain="marketing" \/>/);
  });

  it("F8: o comentário dos Canais diz Google + Meta", () => {
    expect(src("server/marketingChannels.ts")).not.toContain("custo = gasto do Google Ads)");
    expect(src("server/marketingChannels.ts")).toContain("Google Ads + Meta");
  });
});
