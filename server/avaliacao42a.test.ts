/**
 * Lote 42a — Avaliação: o TL como condutor e como TL, o supervisor com a
 * equipa do dia (extras a mais/a menos), "Mês" em vez de "4 semanas" e o
 * filtro de cidade/marca a mudar mesmo os números.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cityTeamTotals, coverageBalance, hoursLabel, teamLeaderTotals, teamScore, type TeamDayInput } from "../shared/evaluationTeam";
import { RECOMPUTE_WINDOW_DAYS } from "../shared/evaluationRules";
import { buildAgentHistoryAggSql, buildAgentBookingPhasesSql, buildAgentOccurrenceAggSql, buildAgentReviewAggSql, movementWindow } from "./multiparkDb/movements";
import { cityScope } from "./cityScope";
import { resolveCityAccess } from "./cityAccess";
import { scopedDayCities } from "./evaluationEngine";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("42a: a equipa", () => {
  it("pontos da equipa: soma e média por pessoa", () => {
    expect(teamScore([{ totalPoints: 23, totalActions: 10 }, { totalPoints: 9, totalActions: 4 }, { totalPoints: -5, totalActions: 0 }]))
      .toEqual({ people: 3, points: 27, avgPoints: 9, actions: 14, avgActions: 4.7 });
    expect(teamScore([])).toEqual({ people: 0, points: 0, avgPoints: 0, actions: 0, avgActions: 0 });
  });

  it("extras a menos / a mais / certos face à previsão, hora a hora", () => {
    const needed = Array.from({ length: 27 }, (_, h) => (h >= 6 && h < 10 ? 3 : h >= 10 && h < 14 ? 2 : 0));
    // 2 pessoas das 6 às 14: faltam 1×4 h de manhã (6–10)
    const short = coverageBalance(needed, [{ startHour: 6, endHour: 14 }, { startHour: 6, endHour: 14 }]);
    expect(short.verdict).toBe("a_menos");
    expect(short.shortPersonHours).toBe(4);
    expect(hoursLabel(short.shortHours)).toBe("06h–10h");
    // 4 pessoas das 6 às 14: sobram 1×4 + 2×4 = 12 h·pessoa
    const over = coverageBalance(needed, Array.from({ length: 4 }, () => ({ startHour: 6, endHour: 14 })));
    expect(over.verdict).toBe("a_mais");
    expect(over.overPersonHours).toBe(12);
    // à justa (mandado para casa às 10 conta até às 10)
    const ok = coverageBalance(needed, [{ startHour: 6, endHour: 14 }, { startHour: 6, endHour: 14 }, { startHour: 6, endHour: 14, sentHomeHour: 10 }]);
    expect(ok.verdict).toBe("certo");
    expect(coverageBalance(Array(27).fill(0), [{ startHour: 6, endHour: 14 }]).verdict).toBe("sem_previsao");
  });

  it("o TL no mês: a equipa dele nos dias em que foi TL; a cidade sem os TL", () => {
    const d = (o: Partial<TeamDayInput> & { employeeId: number }): TeamDayInput => ({ employeeName: `P${o.employeeId}`, day: "2026-10-01", city: "lisbon", shift: "morning", isTeamLeader: false, points: 10, actions: 5, ...o });
    const rows = [
      d({ employeeId: 1, employeeName: "Márcia", isTeamLeader: true, points: 0, actions: 0 }),
      d({ employeeId: 2, points: 23 }), d({ employeeId: 3, points: 17 }),
      d({ employeeId: 4, shift: "night", points: 50 }), // outro turno: não é da equipa dela
      d({ employeeId: 5, city: "porto", points: 8 }),
      d({ employeeId: 1, employeeName: "Márcia", day: "2026-10-02", isTeamLeader: true, points: 6, actions: 2 }),
      d({ employeeId: 2, day: "2026-10-02", points: 10 }),
    ];
    const [m] = teamLeaderTotals(rows);
    expect(m).toMatchObject({ employeeId: 1, tlDays: 2, ownPoints: 6, teamPoints: 50, teamPersonDays: 3, avgTeamPoints: 16.7 });
    const cities = cityTeamTotals(rows);
    expect(cities.find((c) => c.city === "lisbon")).toMatchObject({ days: 2, personDays: 4, points: 100, avgPoints: 25 });
    expect(cities.find((c) => c.city === "porto")).toMatchObject({ personDays: 1, points: 8 });
  });
});

describe("42a: filtros de cidade e marca", () => {
  const nodes = [
    { id: 48, name: "Multipark", level: "group", parentId: null },
    { id: 49, name: "Lisboa", level: "city", parentId: 48 },
    { id: 50, name: "Porto", level: "city", parentId: 48 },
    { id: 65, name: "Parque Porto", level: "project", parentId: 50 },
  ];
  it("a cidade escolhida vira a cidade da escala do dia", () => {
    expect(scopedDayCities()).toBeUndefined();
    cityScope.run(resolveCityAccess(50, nodes as any), () => expect(scopedDayCities()).toEqual(["porto"]));
    cityScope.run(resolveCityAccess(49, nodes as any), () => expect(scopedDayCities()).toEqual(["lisbon"]));
  });

  it("a marca filtra os movimentos vivos pelos parques dela (as 4 leituras)", () => {
    const f = { window: movementWindow("2026-10-01", "2026-10-31"), byDay: false, parkIds: ["park-a", "park-b"] };
    for (const build of [buildAgentHistoryAggSql, buildAgentBookingPhasesSql, buildAgentOccurrenceAggSql, buildAgentReviewAggSql]) {
      const q = build(f);
      expect(q.sql).toMatch(/p\."id" IN \(\$\d+, \$\d+\)/);
      expect(q.params).toContain("park-a");
      expect(build({ ...f, parkIds: [] }).sql).toContain("FALSE");
      expect(build({ ...f, parkIds: undefined }).sql).not.toContain(`p."id" IN`);
    }
  });

  it("as rotas do mês recebem o filtro do topo; ranking e equipas contam a cidade do dia", () => {
    const r = read("server/evaluationRouter.ts");
    expect(r).toContain("ranking: protectedProcedure.input(filteredRangeSchema)");
    expect(r).toContain("rankingOnly: true, dayCityAware: true");
    expect(r).toContain("liveMovements: protectedProcedure.input(filteredRangeSchema)");
    expect(r).toContain("parkIds: await brandParkIds(input.projectId)");
    expect(r).toContain("teams: protectedProcedure.input(filteredRangeSchema)");
    const e = read("server/evaluationEngine.ts");
    expect(e).toContain("OR (${employeeDayMetrics.city} IS NULL AND ${employeeScope(employeeDayMetrics.employeeId)})");
    const c = read("client/src/pages/AvaliacaoPage.tsx");
    expect(c).toContain("trpc.evaluation.ranking.useQuery({ from, to, projectId })");
    expect(c).toContain("trpc.evaluation.liveMovements.useQuery({ from, to, projectId }");
    expect(c).toContain("trpc.evaluation.teams.useQuery({ from, to, projectId }");
  });
});

describe("42a: Mês em vez de 4 semanas", () => {
  it("separador Mês, o mês atual por omissão, ?tab=semanas ainda funciona; o cron cobre o mês", () => {
    const c = read("client/src/pages/AvaliacaoPage.tsx");
    expect(c).toContain('<TabsTrigger value="mes">Mês</TabsTrigger>');
    expect(c).toContain('askedRaw === "semanas" ? "mes" : askedRaw');
    expect(c).toContain("useState(thisMonth)");
    expect(c).toContain(">Este mês</Button>");
    expect(c.replace(/\(antes "4 semanas"; 42a\)/, "")).not.toMatch(/4 semanas/);
    expect(RECOMPUTE_WINDOW_DAYS).toBe(31);
    expect(read("server/cronSchedule.ts")).toContain("Avaliação (recálculo do último mês)");
  });
});

describe("42a: o dia — supervisor e TL", () => {
  it("rota dayTeam só de leitura e com a mesma guarda do dia", () => {
    const r = read("server/routers.ts");
    const i = r.indexOf("dayTeam: protectedProcedure");
    const block = r.slice(i, i + 700);
    expect(block).toContain('requireAccess(ctx.user, "avaliacao_operacional", "view")');
    expect(block).toContain("dayTeamByCity(input.date)");
    const t = read("server/evaluationTeamDay.ts");
    expect(t).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(t).toContain('u.role === "supervisor" && !u.personalOnly');
  });

  it("o TL aparece como condutor e como TL; o nome abre a ficha; o topo tem os pontos da equipa", () => {
    const c = read("client/src/components/evaluation/DayEvaluationTab.tsx");
    expect(c).toContain('assignment.isTeamLeader ? "como condutor" : "pontos"');
    expect(c).toContain("Como team leader — a equipa");
    expect(c).toContain("openEmployee(assignment.employeeId)");
    expect(c).toContain("Pontos da equipa");
    expect(c).toContain("<DayTeamSupervision date={date} projectId={projectId} />");
    const s = read("server/multiparkEvaluation.ts");
    expect(s).toContain("totalPoints: team.points, avgPoints: team.avgPoints, avgActions: team.avgActions");
  });
});
