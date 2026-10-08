/**
 * Pesos do ranking do Desempenho (Jorge, 8 out 2026: "avança com os pesos do
 * ranking"):
 *  1. editáveis sem deploy — definição `perf.rankWeights` (sobreposições por
 *     aba e da equipa; 0 = não conta; ausente = omissão), validada;
 *  2. novas omissões: 1 ponto ≈ 5 minutos de trabalho (a escala da avaliação);
 *  3. o servidor calcula com os pesos em vigor e devolve-os ao ecrã;
 *  4. o ecrã: Editar pesos → Guardar / Repor omissões da aba / Cancelar.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  effectiveTeamWeights, effectiveWeights, emptyTotals, rankWeightsSchema, signedWeight, teamDayPoints, teamWeightOverridesOf, weightOverridesOf,
  withTabOverrides, workPoints, GROUP_VIEW, PERF_RANK_WEIGHTS_KEY, TEAM_POINT_WEIGHTS, UNWEIGHTED_METRICS,
} from "../shared/peoplePerformance";
import { SETTINGS, settingSuperAdminOnly, validateSetting } from "../shared/appSettings";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const errorsOf = (v: unknown) => {
  const r = rankWeightsSchema.safeParse(v);
  return r.success ? null : r.error.issues.map((i) => i.message).join(" ");
};

// ─── 1. A definição ──────────────────────────────────────────────────────────

describe("pesos — a definição perf.rankWeights", () => {
  it("está no catálogo das definições, ligada ao código, vazia por omissão e só o super admin a muda", () => {
    const d = SETTINGS[PERF_RANK_WEIGHTS_KEY];
    expect(d).toMatchObject({ key: "perf.rankWeights", label: "Pesos do ranking do Desempenho", wiring: "live", defaultValue: {} });
    expect(settingSuperAdminOnly(PERF_RANK_WEIGHTS_KEY)).toBe(true);
    expect(validateSetting(PERF_RANK_WEIGHTS_KEY, {})).toEqual({ ok: true, value: {} });
    expect(validateSetting(PERF_RANK_WEIGHTS_KEY, { office: { created: 3, callsMissed: 0 }, team: { noZelloPerPerson: -10 } }).ok).toBe(true);
    expect(validateSetting(PERF_RANK_WEIGHTS_KEY, { office: { inventada: 1 } }).ok).toBe(false);
  });

  it("só métricas que existem; horas e km nunca", () => {
    expect(errorsOf({ office: { inventada: 1 } })).toMatch(/Métrica desconhecida: inventada/);
    expect(errorsOf({ drivers: { hours: 1 } })).toMatch(/horas e km não dão pontos/);
    expect(errorsOf({ drivers: { km: 0.1 } })).toMatch(/horas e km não dão pontos/);
    expect(UNWEIGHTED_METRICS.has("hours") && UNWEIGHTED_METRICS.has("km")).toBe(true);
    // abas e pesos da equipa desconhecidos
    expect(errorsOf({ escritorio: { created: 1 } })).toMatch(/Aba desconhecida: escritorio/);
    expect(errorsOf({ team: { porPessoa: 1 } })).toMatch(/Peso da equipa desconhecido: porPessoa/);
    expect(errorsOf(null)).toMatch(/Tem de ser um objeto/);
  });

  it("números finitos entre −10 000 e 10 000, no máximo 1 casa decimal", () => {
    expect(errorsOf({ office: { created: 10_000 }, drivers: { overLimitDays: -10_000 } })).toBeNull();
    expect(errorsOf({ office: { created: 10_000.1 } })).toMatch(/entre −10 000 e 10 000/);
    expect(errorsOf({ office: { created: -10_001 } })).toMatch(/entre −10 000 e 10 000/);
    expect(errorsOf({ team: { actionsPerPerson: 20_000 } })).toMatch(/entre −10 000 e 10 000/);
    expect(errorsOf({ office: { created: 0.5, updated: 0.7, waMessages: -0.2 } })).toBeNull();
    expect(errorsOf({ office: { created: 0.25 } })).toMatch(/1 casa decimal/);
    expect(errorsOf({ office: { created: Number.POSITIVE_INFINITY } })).toMatch(/tem de ser um número/);
    expect(errorsOf({ office: { created: Number.NaN } })).toMatch(/tem de ser um número/);
    expect(errorsOf({ office: { created: "3" } })).toMatch(/tem de ser um número/);
    // 0,7 fica 0,7 (sem lixo de vírgula flutuante)
    expect(rankWeightsSchema.parse({ office: { updated: 0.1 + 0.6 } })).toEqual({ office: { updated: 0.7 } });
  });
});

// ─── 2. Pesos em vigor ───────────────────────────────────────────────────────

describe("pesos — omissões + sobreposições", () => {
  it("sem sobreposições = as omissões do código; as outras abas não mudam", () => {
    expect(effectiveWeights("office", {})).toEqual(GROUP_VIEW.office.weights);
    expect(effectiveWeights("office", null)).toEqual(GROUP_VIEW.office.weights);
    const o = { office: { created: 3 } };
    expect(effectiveWeights("office", o).created).toBe(3);
    expect(effectiveWeights("supervision", o)).toEqual(GROUP_VIEW.supervision.weights);
    // não mexe nas omissões
    expect(GROUP_VIEW.office.weights.created).toBe(2);
  });

  it("0 = não conta (fica 0, diferente de ausente = omissão); acrescentar uma métrica que não contava", () => {
    const w = effectiveWeights("office", { office: { created: 0, callsMissed: -1 } });
    expect(w.created).toBe(0);
    expect(w.callsMissed).toBe(-1);
    expect(w.emails).toBe(GROUP_VIEW.office.weights.emails);
    const t = emptyTotals();
    t.created = 4; t.emails = 2; t.callsMissed = 3;
    expect(workPoints("office", t)).toBe(4 * 2 + 2 * 1); // omissões: perdidas não contam
    expect(workPoints("office", t, w)).toBe(0 + 2 * 1 - 3);
  });

  it("ignora o que não pode contar, mesmo que chegue (horas, km, métricas desconhecidas)", () => {
    const w = effectiveWeights("drivers", { drivers: { hours: 5, km: 1, inventada: 9 } as any });
    expect(w).toEqual(GROUP_VIEW.drivers.weights);
    const t = emptyTotals();
    t.hours = 8; t.km = 100; t.evalPoints = 10;
    expect(workPoints("drivers", t, { evalPoints: 1, hours: 5, km: 1 })).toBe(10);
  });

  it("pontos da equipa com os pesos em vigor", () => {
    expect(effectiveTeamWeights({})).toEqual(TEAM_POINT_WEIGHTS);
    const tw = effectiveTeamWeights({ team: { noZelloPerPerson: -10 } });
    expect(tw).toEqual({ actionsPerPerson: 1, noZelloPerPerson: -10, stoppedHoursPerPerson: -2 });
    const day = { people: 3, actions: 18, noZello: 1, hoursStopped: 3 };
    expect(teamDayPoints(day)).toBe(-2.7); // omissões
    expect(teamDayPoints(day, tw)).toBe(0.7); // 6 − 3,3 − 2
    expect(teamDayPoints(day, { actionsPerPerson: 0, noZelloPerPerson: 0, stoppedHoursPerPerson: 0 })).toBe(0);
    expect(teamDayPoints({ people: 0, actions: 5, noZello: 0, hoursStopped: 0 }, tw)).toBe(0);
  });

  it("o editor grava só o que difere da omissão e junta às outras abas", () => {
    const edited = { ...GROUP_VIEW.office.weights, created: 3, callsMissed: 0, leadsActions: 0 };
    // callsMissed 0 sem omissão = já não contava → não se grava; leadsActions 0 = tirar → grava-se
    expect(weightOverridesOf("office", edited)).toEqual({ created: 3, leadsActions: 0 });
    expect(weightOverridesOf("office", { ...GROUP_VIEW.office.weights })).toEqual({});
    expect(teamWeightOverridesOf({ ...TEAM_POINT_WEIGHTS, stoppedHoursPerPerson: -1 })).toEqual({ stoppedHoursPerPerson: -1 });
    const all = { drivers: { overLimitDays: -5 }, office: { created: 9 }, team: { actionsPerPerson: 2 } };
    expect(withTabOverrides(all, "office", { created: 3 })).toEqual({ drivers: { overLimitDays: -5 }, office: { created: 3 }, team: { actionsPerPerson: 2 } });
    // repor a aba (vazio) tira-a; a equipa só muda quando vem
    expect(withTabOverrides(all, "office", {})).toEqual({ drivers: { overLimitDays: -5 }, team: { actionsPerPerson: 2 } });
    expect(withTabOverrides(all, "teamleaders", {}, {})).toEqual({ drivers: { overLimitDays: -5 }, office: { created: 9 } });
    expect(withTabOverrides(null, "drivers", {})).toEqual({});
    expect(all.office.created).toBe(9); // PURA
  });

  it("sinal dos pesos nas notas", () => {
    expect([signedWeight(1), signedWeight(-20), signedWeight(0.5), signedWeight(0)]).toEqual(["+1", "−20", "+0,5", "0"]);
  });
});

// ─── 3. Novas omissões (1 ponto ≈ 5 minutos) ─────────────────────────────────

describe("pesos — omissões de 8 out 2026 (1 ponto ≈ 5 min de trabalho)", () => {
  const OFFICE = {
    created: 2, updated: 0.5, returnFlights: 0.5, callsAnswered: 0.5, callsMade: 0.5, callMinutes: 0.2, callbacks: 1, emails: 1, waMessages: 0.2,
    complaintMsgs: 1, complaintsClosed: 2, reviewsReplied: 1, lostFound: 2, crmUpdates: 0.5, partnerAccounts: 1, partnerClosings: 6,
    partnerCharges: 1, proPlanCharges: 1, expenses: 1, expensesApproved: 0.5, cashCounts: 2, cashCorrections: 1, tasksDone: 1, leadsActions: 1,
  };
  it("escritório", () => expect(GROUP_VIEW.office.weights).toEqual(OFFICE));
  it("supervisão = o escritório + a equipa, os extras do dia e as passagens de turno", () => {
    expect(GROUP_VIEW.supervision.weights).toEqual({ ...OFFICE, teamPoints: 1, extrasDia: 0.5, handovers: 2 });
  });
  it("team leaders", () => {
    expect(GROUP_VIEW.teamleaders.weights).toEqual({
      evalPoints: 1, teamPoints: 1, checkingIn: 0.5, checkingOut: 0.5, updated: 0.5, returnFlights: 0.5, callsAnswered: 0.5, callsMade: 0.5,
      callMinutes: 0.2, waMessages: 0.2, cashCounts: 2, handovers: 2, extrasDia: 0.5, lostFound: 2, occurrences: 1,
    });
  });
  it("condutores e equipa ficam como estavam", () => {
    expect(GROUP_VIEW.drivers.weights).toEqual({ evalPoints: 1, overLimitDays: -10, occurrences: 1 });
    expect(TEAM_POINT_WEIGHTS).toEqual({ actionsPerPerson: 1, noZelloPerPerson: -20, stoppedHoursPerPerson: -2 });
  });
  it("perdidas, horas e km não contam em nenhuma aba; nenhum 0 explícito nas omissões", () => {
    for (const g of Object.values(GROUP_VIEW)) {
      expect(g.weights.callsMissed).toBeUndefined();
      expect(g.weights.hours).toBeUndefined();
      expect(g.weights.km).toBeUndefined();
      expect(Object.values(g.weights)).not.toContain(0);
      expect(rankWeightsSchema.safeParse({ office: g.weights }).success).toBe(true); // as omissões passam no próprio schema
    }
  });
});

// ─── 4. O servidor usa a definição (BD simulada) ─────────────────────────────

const h = vi.hoisted(() => ({ setting: null as null | { value: unknown; updatedAt: string; updatedByName: string } | "erro" }));
vi.mock("./dayActivity", () => ({ speedThreshold: async () => 100 }));
vi.mock("./notify", () => ({ loadCandidatesFromDb: async () => [] }));
vi.mock("./extraRates", () => ({ loadExtraRates: async () => ({ junior: 5 }), rateFor: (r: Record<string, number>, l: string) => r[l] ?? 5 }));
vi.mock("./extrasAutomation", () => ({ addDaysIso: (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10) }));
vi.mock("./extrasSchedule", () => ({ forecastIncompleteReason: () => null }));
vi.mock("./extrasDia", () => ({ TL_WORKING_DAYS_PER_MONTH: 15, getExtrasDiaForecast: async () => ({ hourly: [] }) }));

const metric = (employeeId: number, day: string, o: Record<string, number> = {}) => ({
  employeeId, day, city: "lisbon", hoursWorked: 8, scheduledHours: 0, actions: 0, recolhas: 0, entregas: 0, movements: 0, parkingMoves: 0, cancels: 0, otherActions: 0,
  weightedActions: 0, speedingEvents: 0, delays: 0, lateServices: 0, complaints: 0, accidents: 0, incidentsReported: 0, incidentsAgainst: 0, penaltyPoints: 0, actionsByType: "{}", ...o,
});
const asg = (day: string, employeeId: number, isTeamLeader = 0, level: string | null = "junior") => ({ day, city: "lisbon", shift: "morning", employeeId, isTeamLeader, level, startHour: 8, endHour: 16, sentHomeHour: null });

vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: any) => {
      const flat = (c: any): string => (c?.queryChunks ? c.queryChunks.map(flat).join("") : Array.isArray(c?.value) ? c.value.join("") : typeof c === "string" ? c : "");
      const text = flat(q);
      if (/FROM app_settings/.test(text)) {
        if (h.setting === "erro") throw new Error("ligação perdida");
        return [h.setting ? [{ value: JSON.stringify(h.setting.value), updatedAt: h.setting.updatedAt, updatedByName: h.setting.updatedByName }] : []];
      }
      if (/FROM employees e LEFT JOIN users/.test(text)) return [[
        { id: 1, fullName: "Ana", position: "driver", contractType: "permanent", isActive: 1, userId: null, photoUrl: null, role: null, inScope: 1 },
        { id: 3, fullName: "Paulo", position: "team_leader", contractType: "permanent", isActive: 1, userId: null, photoUrl: null, role: null, inScope: 1 },
        { id: 5, fullName: "Carlos", position: "extra", contractType: "extra", isActive: 1, userId: null, photoUrl: null, role: null, inScope: 1 },
      ]];
      if (/SELECT id, monthlySalary FROM employees/.test(text)) return [[{ id: 3, monthlySalary: 1500 }]];
      if (/FROM employee_day_metrics/.test(text)) return [[
        metric(1, "2026-10-05", { recolhas: 5, entregas: 4, movements: 3, incidentsReported: 2 }),
        metric(5, "2026-10-05", { recolhas: 3, entregas: 3 }),
        metric(3, "2026-10-05", { recolhas: 1, entregas: 1 }),
      ]];
      if (/FROM driver_day_shares/.test(text)) return [[
        { employeeId: 1, day: "2026-10-05", km: 84, maxSpeed: 131, minutes: 480, movingMinutes: 300 }, // 3 h paradas, acima do limite
      ]];
      if (/FROM extras_dia_assignments/.test(text) && /assignmentDate AS day/.test(text)) return [[asg("2026-10-05", 3, 1, null), asg("2026-10-05", 1), asg("2026-10-05", 5)]];
      return [[]];
    },
  }),
}));

describe("pesos — o servidor calcula com os pesos em vigor e devolve-os", () => {
  const round1 = (n: number) => Math.round(n * 10) / 10;

  it("sem nada gravado: omissões, e diz que são as do código", async () => {
    h.setting = null;
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    const r = await loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "drivers" });
    const ana = r.people.find((p) => p.name === "Ana")!;
    expect(ana.totals.evalPoints).toBeGreaterThan(0);
    expect(ana.totals.occurrences).toBe(2);
    expect(ana.totals.overLimitDays).toBeGreaterThan(0);
    expect(ana.points).toBe(round1(ana.totals.evalPoints - 10 * ana.totals.overLimitDays + ana.totals.occurrences));
    expect(r.rankWeights).toEqual({ weights: GROUP_VIEW.drivers.weights, team: TEAM_POINT_WEIGHTS, overrides: {}, updatedAt: null, updatedByName: null, readable: true });
  });

  it("com a definição: os pontos mudam logo (0 = não conta) e o ecrã recebe o que está em vigor", async () => {
    h.setting = { value: { drivers: { evalPoints: 2, occurrences: 0 }, office: { created: 5 } }, updatedAt: "2026-10-08 10:00:00", updatedByName: "Jorge" };
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    const r = await loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "drivers" });
    const ana = r.people.find((p) => p.name === "Ana")!;
    expect(ana.points).toBe(round1(2 * ana.totals.evalPoints - 10 * ana.totals.overLimitDays)); // as ocorrências deixaram de contar
    expect(r.rankWeights.weights).toEqual({ evalPoints: 2, overLimitDays: -10, occurrences: 0 });
    expect(r.rankWeights.overrides).toEqual({ drivers: { evalPoints: 2, occurrences: 0 }, office: { created: 5 } });
    expect(r.rankWeights).toMatchObject({ updatedAt: "2026-10-08 10:00:00", updatedByName: "Jorge", readable: true });
  });

  it("os pontos da equipa do TL também seguem a definição (e a nota diz os pesos em vigor)", async () => {
    h.setting = null;
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    const before = (await loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "teamleaders" })).people.find((p) => p.name === "Paulo")!;
    // equipa: Ana (12) + Carlos (6) = 18 movimentos, 2 pessoas, Carlos sem GPS, 3 h paradas
    expect(before.totals.teamPoints).toBe(teamDayPoints({ people: 2, actions: 18, noZello: 1, hoursStopped: 3 }));
    h.setting = { value: { team: { noZelloPerPerson: -4 }, teamleaders: { teamPoints: 2 } }, updatedAt: "2026-10-08 11:00:00", updatedByName: "Jorge" };
    const r = await loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "teamleaders" });
    const paulo = r.people.find((p) => p.name === "Paulo")!;
    const tp = teamDayPoints({ people: 2, actions: 18, noZello: 1, hoursStopped: 3 }, { actionsPerPerson: 1, noZelloPerPerson: -4, stoppedHoursPerPerson: -2 });
    expect(paulo.totals.teamPoints).toBe(tp);
    expect(paulo.points).toBe(round1(paulo.totals.evalPoints + 2 * tp));
    expect(r.notes.join(" ")).toMatch(/cada movimento \+1, quem mexeu carros sem Zello −4, cada hora parada −2/);
  });

  it("valor gravado inválido → omissões e um aviso; leitura que falha → omissões (nunca parte o ranking)", async () => {
    const { loadPeoplePerformance } = await import("./peoplePerformance");
    h.setting = { value: { drivers: { evalPoints: 0.25 } }, updatedAt: "2026-10-08 12:00:00", updatedByName: "Jorge" };
    const bad = await loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "drivers" });
    expect(bad.rankWeights.weights).toEqual(GROUP_VIEW.drivers.weights);
    expect(bad.rankWeights.updatedAt).toBe("2026-10-08 12:00:00"); // para quem gravar a seguir não pisar ninguém
    expect(bad.notes.join(" ")).toMatch(/pesos gravados do ranking já não são válidos/);
    h.setting = "erro";
    const off = await loadPeoplePerformance({ period: "week", anchor: "2026-10-06", group: "drivers" });
    expect(off.rankWeights.weights).toEqual(GROUP_VIEW.drivers.weights);
    expect(off.rankWeights.readable).toBe(false);
    const ana = off.people.find((p) => p.name === "Ana")!;
    expect(ana.points).toBe(round1(ana.totals.evalPoints - 10 * ana.totals.overLimitDays + ana.totals.occurrences));
    h.setting = null;
  });
});

// ─── 5. O ecrã ───────────────────────────────────────────────────────────────

describe("pesos — o ecrã do Desempenho", () => {
  const c = src("client/src/components/people/PeoplePerformancePanel.tsx");
  it("Editar pesos → Guardar (pela rota das Definições, com o updatedAt) / Repor omissões da aba / Cancelar; recarrega o ranking", () => {
    expect(c).toContain("Editar pesos");
    expect(c).toContain("Repor omissões da aba");
    expect(c).toContain("Cancelar");
    expect(c).toContain("trpc.settings.values.set.useMutation");
    expect(c).toContain("save.mutate({ key: PERF_RANK_WEIGHTS_KEY, value: next, expectedUpdatedAt: rw.updatedAt })");
    expect(c).toContain("utils.evaluation.peoplePerformance.invalidate()");
    expect(c).toContain("<PointsTable key={d.group} group={d.group} rw={d.rankWeights} />");
    expect(c).toContain("alterado");
    expect(c).toContain("Chamadas perdidas: aparecem mas não contam");
    expect(c).toContain("1 ponto ≈ 5 minutos de trabalho");
  });
  it("a gravação fica no histórico das Definições (quem e quando) e no registo de atividade", () => {
    const r = src("server/settingsRouter.ts");
    expect(r).toMatch(/if \(settingSuperAdminOnly\(input\.key\)\) requireSuperAdmin\(ctx\.user\.role\);/);
    expect(r).toMatch(/await log\(ctx\.user\.id, "update", "app_setting"/);
    expect(src("server/appSettings.ts")).toContain("INSERT INTO app_settings_audit (settingKey, oldValue, newValue, changedById)");
  });
});
