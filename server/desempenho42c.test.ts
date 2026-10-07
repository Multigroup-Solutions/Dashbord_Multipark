/**
 * Lote 42c — Desempenho (Jorge, 7 out 2026): o nome abre a ficha e o número
 * o detalhe; todos os cabeçalhos ordenam; a tabela dos pontos; a equipa do
 * TL e do supervisor (movimentos, custo, sem Zello, horas paradas, extras a
 * mais/a menos); extras sem nada saem; "km sem movimentos"; o TL pela escala
 * (o extra que passou a chefe de turno); cidade e marca do topo.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  emptyTotals, kmWithoutMoves, rosterGroup, teamDayPoints, workPoints, GROUP_VIEW, PERF_METRICS, TEAM_COLUMNS, TEAM_POINT_WEIGHTS,
} from "../shared/peoplePerformance";
import { cityScope } from "./cityScope";
import { resolveCityAccess } from "./cityAccess";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("42c — regras puras", () => {
  it("o TL pela escala: condutor/extra que foi TL em pelo menos metade dos dias escalados", () => {
    expect(rosterGroup("drivers", { days: 3, tlDays: 2 })).toBe("teamleaders");
    expect(rosterGroup("drivers", { days: 4, tlDays: 2 })).toBe("teamleaders");
    expect(rosterGroup("drivers", { days: 5, tlDays: 2 })).toBe("drivers");
    expect(rosterGroup("drivers", { days: 0, tlDays: 0 })).toBe("drivers");
    expect(rosterGroup("drivers", undefined)).toBe("drivers");
    // o escritório e a supervisão não mudam pela escala
    expect(rosterGroup("office", { days: 2, tlDays: 2 })).toBe("office");
    expect(rosterGroup(null, { days: 2, tlDays: 2 })).toBeNull();
  });

  it("km sem movimentos = utilizador do Zello e agente da Multipark em fichas diferentes", () => {
    expect(kmWithoutMoves({ km: 50, recolhas: 0, entregas: 0, movements: 0 })).toBe(true);
    expect(kmWithoutMoves({ km: 50, recolhas: 1, entregas: 0, movements: 0 })).toBe(false);
    expect(kmWithoutMoves({ km: 0, recolhas: 0, entregas: 0, movements: 0 })).toBe(false);
  });

  it("pontos da equipa por pessoa: movimentos +1, sem Zello −20, hora parada −2 (o tamanho não conta)", () => {
    expect(TEAM_POINT_WEIGHTS).toEqual({ actionsPerPerson: 1, noZelloPerPerson: -20, stoppedHoursPerPerson: -2 });
    expect(teamDayPoints({ people: 3, actions: 18, noZello: 1, hoursStopped: 3 })).toBe(-2.7);
    expect(teamDayPoints({ people: 6, actions: 36, noZello: 2, hoursStopped: 6 })).toBe(-2.7); // o dobro da equipa, o mesmo
    expect(teamDayPoints({ people: 0, actions: 10, noZello: 0, hoursStopped: 0 })).toBe(0);
  });

  it("a equipa entra nos pontos do TL e do supervisor; as métricas existem", () => {
    for (const k of TEAM_COLUMNS) expect(PERF_METRICS[k]).toBeTruthy();
    expect(GROUP_VIEW.teamleaders.weights.teamPoints).toBe(1);
    expect(GROUP_VIEW.supervision.weights.teamPoints).toBe(1);
    expect(GROUP_VIEW.drivers.weights.teamPoints).toBeUndefined();
    const t = emptyTotals();
    t.evalPoints = 6; t.teamPoints = -2.7;
    expect(workPoints("teamleaders", t)).toBe(3.3);
    expect(PERF_METRICS.teamNoZello.bad).toBe(true);
    expect(PERF_METRICS.teamHoursStopped.bad).toBe(true);
  });
});

// ─── BD simulada ─────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("./dayActivity", () => ({ speedThreshold: async () => 100 }));
vi.mock("./notify", () => ({ loadCandidatesFromDb: async () => [{ id: 50, role: "supervisor", cities: ["lisbon"] }] }));
vi.mock("./extraRates", () => ({ loadExtraRates: async () => ({ junior: 5, senior: 6 }), rateFor: (r: Record<string, number>, l: string) => r[l] ?? 5 }));
vi.mock("./extrasAutomation", () => ({ addDaysIso: (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10) }));
vi.mock("./extrasSchedule", () => ({ forecastIncompleteReason: () => null }));
// previsão: 4 condutores das 08h às 16h
vi.mock("./extrasDia", () => ({
  TL_WORKING_DAYS_PER_MONTH: 15,
  getExtrasDiaForecast: async () => ({ hourly: Array.from({ length: 27 }, (_, hour) => ({ hour, driversNeeded: hour >= 8 && hour < 16 ? 4 : 0 })) }),
}));

const metric = (employeeId: number, day: string, city: string | null, o: Record<string, number> = {}) => ({
  employeeId, day, city, hoursWorked: 8, scheduledHours: 0, actions: 0, recolhas: 0, entregas: 0, movements: 0, parkingMoves: 0, cancels: 0, otherActions: 0,
  weightedActions: 0, speedingEvents: 0, delays: 0, lateServices: 0, complaints: 0, accidents: 0, incidentsReported: 0, incidentsAgainst: 0, penaltyPoints: 0, actionsByType: "{}", ...o,
});
const METRICS = [
  metric(1, "2026-10-05", "lisbon", { recolhas: 5, entregas: 4, movements: 3 }), // Ana
  metric(5, "2026-10-05", "lisbon", { recolhas: 3, entregas: 3 }), // Carlos, sem GPS
  metric(4, "2026-10-05", "lisbon"), // Rui: só horas e km
  metric(3, "2026-10-05", "lisbon", { recolhas: 1, entregas: 1 }), // Paulo (TL), sem GPS
  metric(5, "2026-10-08", "porto", { recolhas: 2 }), // Carlos fez um dia no Porto
];
const asg = (day: string, employeeId: number, isTeamLeader = 0, level: string | null = "junior") => ({ day, city: "lisbon", shift: "morning", employeeId, isTeamLeader, level, startHour: 8, endHour: 16, sentHomeHour: null });

vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: any) => {
      const flat = (c: any): string => (c?.queryChunks ? c.queryChunks.map(flat).join("") : Array.isArray(c?.value) ? c.value.join("") : typeof c === "string" ? c : "");
      const text = flat(q);
      h.texts.push(text);
      if (/FROM employees e LEFT JOIN users/.test(text)) {
        // com cidade escolhida a ficha de toda a gente é de Lisboa (fora do Porto)
        const inScope = /CASE WHEN/.test(text) ? 0 : 1;
        return [[
          { id: 1, fullName: "Ana", position: "driver", contractType: "permanent", isActive: 1, userId: null, photoUrl: null, role: null, inScope },
          { id: 2, fullName: "Zé Sem Nada", position: "extra", contractType: "extra", isActive: 1, userId: null, photoUrl: null, role: null, inScope },
          { id: 3, fullName: "Paulo", position: "extra", contractType: "extra", isActive: 1, userId: null, photoUrl: null, role: null, inScope },
          { id: 4, fullName: "Rui", position: "driver", contractType: "permanent", isActive: 1, userId: null, photoUrl: null, role: null, inScope },
          { id: 5, fullName: "Carlos", position: "extra", contractType: "extra", isActive: 1, userId: null, photoUrl: null, role: null, inScope },
          { id: 6, fullName: "Sofia", position: "supervisor", contractType: "permanent", isActive: 1, userId: 50, photoUrl: null, role: "supervisor", inScope },
        ]];
      }
      if (/SELECT id, monthlySalary FROM employees/.test(text)) return [[{ id: 3, monthlySalary: 1500 }]];
      if (/FROM employee_accounts/.test(text)) return [[]];
      if (/multiparkAgentUserId FROM employees/.test(text)) return [[]];
      if (/FROM employee_agents/.test(text)) return [[]];
      if (/FROM employee_day_metrics/.test(text)) {
        // o filtro de cidade (city IN …) — só os dias do Porto ou sem cidade
        return [/city IN/.test(text) ? METRICS.filter((m) => m.city === "porto" || m.city == null) : METRICS];
      }
      if (/FROM employee_metric_adjustments/.test(text)) return [[]];
      if (/FROM daily_driver_history/.test(text)) return [[]];
      if (/FROM driver_day_shares/.test(text)) return [[
        { employeeId: 1, day: "2026-10-05", km: 84, maxSpeed: 90, minutes: 480, movingMinutes: 420 }, // 1 h parada
        { employeeId: 4, day: "2026-10-05", km: 50, maxSpeed: 80, minutes: 480, movingMinutes: 360 }, // 2 h paradas
      ]];
      if (/FROM extras_dia_assignments/.test(text) && /assignmentDate AS day/.test(text)) return [[
        asg("2026-10-05", 3, 1, null), asg("2026-10-05", 1), asg("2026-10-05", 5), asg("2026-10-05", 4),
        asg("2026-10-06", 3, 1, null),
        asg("2026-10-07", 3),
      ]];
      return [[]];
    },
  }),
}));

describe("42c — condutores e extras", () => {
  it("quem não tem nada sai; km sem movimentos assinalado; o extra que foi TL na escala passa para os team leaders", async () => {
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    const r = await loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "drivers" });
    expect(r.people.map((p) => p.name).sort()).toEqual(["Ana", "Carlos", "Rui"]);
    expect(r.people.find((p) => p.name === "Rui")!.kmNoMoves).toBe(true);
    expect(r.people.find((p) => p.name === "Ana")!.kmNoMoves).toBe(false);
    expect(r.cities).toBeNull();
  });
});

describe("42c — a equipa", () => {
  it("TL: o turno dele (sem ele) — pessoas, movimentos, custo com o TL, sem Zello, horas paradas, pontos por pessoa", async () => {
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    const r = await loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "teamleaders" });
    expect(r.people.map((p) => p.name)).toEqual(["Paulo"]);
    const p = r.people[0];
    expect(p.byRoster).toBe(true);
    // dia 5: Ana 12 + Carlos 6 + Rui 0; Carlos mexeu sem GPS; 1 h + 2 h paradas; 3 × 8 h × 5 € + o TL (1500 € ÷ 15) — dia 6 só o TL
    expect(p.totals).toMatchObject({ tlDays: 2, teamDays: 2, teamPersonDays: 3, teamActions: 18, teamNoZello: 1, teamHoursStopped: 3, teamCost: 320, teamPoints: -2.7, teamShortHours: 0 });
    // como condutor (1 recolha + 1 entrega = 6 pontos da avaliação) + como TL (a equipa)
    expect(p.totals.evalPoints).toBe(6);
    expect(p.points).toBe(3.3);
    expect(r.notes.join(" ")).toMatch(/Team leaders pela escala/);
  });

  it("supervisor: todos os escalados das cidades da conta (TL incluídos); extras a menos face à previsão na semana", async () => {
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    const r = await loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "supervision" });
    expect(r.people.map((p) => p.name)).toEqual(["Sofia"]);
    // dia 5: 4 pessoas, 20 movimentos, Paulo e Carlos sem Zello, 3 h paradas, 220 €; dia 6: o TL (100 €); dia 7: Paulo como extra (40 €)
    // previsão 4 × 8 h por dia: faltam 1×8 (dia 5), 4×8 (dia 6, ninguém a não ser o TL) e 3×8 (dia 7)
    expect(r.people[0].totals).toMatchObject({ teamDays: 3, teamPersonDays: 6, teamActions: 20, teamNoZello: 2, teamHoursStopped: 3, teamCost: 360, teamShortHours: 64, teamOverHours: 0, teamPoints: -6.5 });
  });

  it("supervisor no mês: sem a previsão (lida dia a dia) — e diz porquê", async () => {
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    const r = await loadPeoplePerformance({ period: "month", anchor: "2026-10-06", group: "supervision" });
    expect(r.people[0].totals.teamShortHours).toBe(0);
    expect(r.notes.join(" ")).toMatch(/escolhe Dia ou Semana/);
  });
});

describe("42c — cidade e marca do topo", () => {
  const nodes = [
    { id: 48, name: "Multipark", level: "group", parentId: null },
    { id: 49, name: "Lisboa", level: "city", parentId: 48 },
    { id: 50, name: "Porto", level: "city", parentId: 48 },
  ];
  it("Porto: conta só o dia feito no Porto; quem só trabalhou em Lisboa não aparece", async () => {
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    const r = await cityScope.run(resolveCityAccess(50, nodes as any), () => loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "drivers" }));
    expect(r.cities).toEqual(["porto"]);
    expect(r.people.map((p) => p.name)).toEqual(["Carlos"]);
    expect(r.people[0].totals).toMatchObject({ recolhas: 2, entregas: 0 }); // o dia 5 (Lisboa) não conta
    expect(r.notes.join(" ")).toMatch(/Cidade escolhida/);
  });

  it("Porto: o supervisor que também cobre o Porto conta (com a ficha noutra cidade); a equipa é só a do Porto", async () => {
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    const porto = await cityScope.run(resolveCityAccess(50, nodes as any), () => loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "supervision" }));
    // a Sofia só cobre Lisboa (mock) → fora do Porto
    expect(porto.people.map((p) => p.name)).toEqual([]);
    const lisboa = await cityScope.run(resolveCityAccess(49, nodes as any), () => loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "supervision" }));
    expect(lisboa.people.map((p) => p.name)).toEqual(["Sofia"]);
    expect(lisboa.people[0].totals).toMatchObject({ teamDays: 3, teamActions: 20 });
  });

  it("a rota aceita o filtro do topo e o ecrã manda-o", () => {
    expect(src("server/evaluationRouter.ts")).toMatch(/peoplePerformance: protectedProcedure\.input\(z\.object\(\{[\s\S]{0,400}projectId: z\.number\(\)\.int\(\)\.optional\(\)/);
    const c = src("client/src/components/people/PeoplePerformancePanel.tsx");
    expect(c).toContain("trpc.evaluation.peoplePerformance.useQuery({ period, anchor, group, projectId: projectId ?? undefined }");
  });
});

describe("42c — ecrã", () => {
  const c = src("client/src/components/people/PeoplePerformancePanel.tsx");
  it("o nome abre a ficha; o resto da linha, o detalhe", () => {
    expect(c).toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); openEmployee\(r\.employeeId\); \}\}/);
    expect(c).toContain('onClick={() => setOpen(r)} title="Ver o detalhe"');
  });
  it("todos os cabeçalhos ordenam (Th) — nenhum <th> solto nas tabelas de pessoas", () => {
    expect(c).toContain("k={`totals.${k}`}");
    const tables = c.slice(c.indexOf("Toda a gente"), c.indexOf("function PointsTable"));
    expect(tables).not.toMatch(/<th[ >]/);
  });
  it("a tabela dos pontos e a equipa do TL e do supervisor", () => {
    expect(c).toContain("Como se contam os pontos desta aba");
    expect(c).toContain("EVALUATION_RULES.map");
    expect(c).toContain("{TEAM_GROUPS.includes(group) && <TeamTable");
    expect(c).toContain("km sem movimentos");
    expect(c).toContain("<PersonLinksDialog");
  });
});
