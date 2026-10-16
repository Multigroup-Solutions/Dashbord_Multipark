/**
 * Plano 64, PR F — Marketing, rótulos e Ocorrências pela fonte atual.
 *  - F3 (P8 = sim): na Avaliação, a tabela antiga `incidents` só conta antes de LEGACY_INCIDENTS_UNTIL_DAY
 *    (= LIVE_ACTIONS_SINCE, 2 mar 2026); informativo — os pontos da avaliação não mudam.
 *  - F4 fica de fora (Jorge, 15 out 2026, P9 = não): o Cruzamento de condutores dos Perdidos fica como estava.
 *  - F1/F5/F6/F7/F8: rótulos e linhas no ecrã (verificados no código-fonte; a paridade do F6 com o Painel
 *    está em server/plano64fMarca.test.ts).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { computeEmployeeDays } from "./evaluationCore";
import { buildEvaluationIdentity } from "./evaluationIdentity";
import { LIVE_ACTIONS_SINCE } from "./multiparkDb/activityLive";
import { ACCIDENTS_FROM_DAY, LEGACY_INCIDENTS_UNTIL_DAY, legacyIncidentCounts, scoreOf } from "../shared/evaluationRules";

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

  it("Igual: os acidentes confirmados contam como antes (desde ACCIDENTS_FROM_DAY)", () => {
    expect(ACCIDENTS_FROM_DAY).toBe("2026-10-03");
    const out = base("2026-10-01", "2026-10-05", { confirmedAccidents: [{ employeeId: 5, day: "2026-10-05" }, { employeeId: 5, day: "2026-10-02" }] });
    expect(out.rows.map((r) => [r.day, r.metrics.accidents, r.metrics.incidentsAgainst])).toEqual([["2026-10-05", 1, 1]]);
  });
});

// ─── F4 fora (P9 = não) ──────────────────────────────────────────────────────

describe("F4 fica de fora (P9 = não): o Cruzamento de condutores não muda", () => {
  it("a coluna Ocorrências continua a ler só a tabela antiga, sem os acidentes confirmados", () => {
    const caseOps = src("server/caseOps.ts");
    expect(caseOps).toContain("FROM incidents i");
    expect(caseOps).not.toContain("evaluation_accidents");
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
