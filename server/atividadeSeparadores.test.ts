/**
 * Atividade diária — separadores novos (Jorge, 12 out 2026):
 *  1. Extras Dia → Pressão: o tempo por carro também só das entregas e só das
 *     recolhas (seletor Entregas / Recolhas / Juntas);
 *  2. "Semana": o quadro da Pressão para uma semana escolhida (domingo →
 *     sábado), dias operacionais × horas, entregas/recolhas, quantidade/tempo;
 *  3. "Resumo do dia" passou da Passagem de turno para a Atividade diária;
 *  4. "Avaliação do mês" = o MESMO componente do "Mês" da Avaliação;
 *  5. reclamações dos carros que SAÍRAM no dia.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ sql: [] as string[], params: [] as unknown[][], counts: [] as number[] }));
vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: any) => {
      // drizzle sql`` → texto + parâmetros (só o que o teste precisa). Os pedaços
      // aninhados (ex.: a condição única "conta como reclamação", plano 64 E7) entram no texto.
      const render = (chunks: any[]): string =>
        chunks.map((c) => (typeof c === "string" ? c : Array.isArray(c?.value) ? c.value.join("") : c && typeof c === "object" && Array.isArray(c.queryChunks) ? render(c.queryChunks) : "?")).join("");
      const text = render((q?.queryChunks ?? []) as any[]);
      state.sql.push(text);
      const params: unknown[] = [];
      const walk = (x: any) => {
        if (x == null) return;
        if (Array.isArray(x)) return x.forEach(walk);
        if (typeof x === "object" && "queryChunks" in x) return x.queryChunks.forEach(walk);
        if (typeof x === "object" && "value" in x && !Array.isArray(x.value)) return params.push(x.value);
        if (typeof x === "string" || typeof x === "number") return params.push(x);
      };
      walk(q?.queryChunks);
      state.params.push(params);
      return [[{ n: state.counts.shift() ?? 0 }], []];
    },
  }),
}));

import { assertReadOnlySql } from "./multiparkDb/client";
import { buildLiveHistoryBookingsSql, HISTORY_BOOKINGS_LIMIT } from "./multiparkDb/historyLive";
import { clearWeekActivityCache, getWeekActivity, weekBackgroundWindow } from "./weekActivity";
import { pressureWindowSince } from "./multiparkDb/pressure";
import { countComplaintsForRefs } from "./departedComplaints";
import { pressureDaySig } from "./pressureDays";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { MIGRATION_0615_STATEMENTS } from "./migrations/migration_0615";
import { hasCycleSplit, slotCycleOf, type PressureSlot } from "../shared/extrasPressure";
import {
  WEEK_HOURS, buildWeekGrids, durStats, opSlotToCalendar, weekCalendarDays, weekCellValue, weekOpDays, weekStartOf,
} from "../shared/weekActivity";
import { DEPARTED_COMPLAINTS_HINT, chunked, departedFromHistory, departedRefs } from "../shared/departedComplaints";
import { OPERATIONAL_TABS, canSeeEvaluationRanking, operationalAccess } from "../shared/operationalTabs";
import { lisbonLocalTimeUtcMs } from "../shared/shiftHandover";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const MIN = 60_000;

afterEach(() => { state.sql = []; state.params = []; state.counts = []; clearWeekActivityCache(); });

// ─── 1. Pressão: entregas / recolhas ─────────────────────────────────────────

describe("1 — Pressão: tempo por carro só das entregas ou só das recolhas", () => {
  const slot = (o: Partial<PressureSlot>): PressureSlot => ({
    group: "cidade_lisboa", weekday: 5, hour: 18, days: 4, checkinsDone: 0, checkoutsDone: 0, checkinsStarted: 0, checkoutsStarted: 0,
    concurrencyAvg: null, concurrencyMax: null, deliveryN: 0, deliveryP50: null, deliveryP75: null, deliveryP90: null, pickupN: 0, pickupP50: null, pickupP75: null, ...o,
  });
  it("cada célula dá o percentil da cidade do tipo escolhido (Juntas = o de sempre)", () => {
    const s = slot({ cycleN: 9, cycleP50: 40, cycleP75: 50, cycleOutN: 6, cycleOutP50: 42, cycleOutP75: 55, cycleOutP90: 61, cycleInN: 3, cycleInP50: 30, cycleInP75: 38 });
    expect(slotCycleOf(s, "all", 75)).toEqual({ n: 9, value: 50, p50: 40 });
    expect(slotCycleOf(s, "out", 75)).toEqual({ n: 6, value: 55, p50: 42 });
    expect(slotCycleOf(s, "out", 90)).toEqual({ n: 6, value: 61, p50: 42 });
    expect(slotCycleOf(s, "in", 75)).toEqual({ n: 3, value: 38, p50: 30 });
  });
  it("antes de o trabalho noturno reler os dias não há tempos separados (o seletor fica em Juntas)", () => {
    expect(hasCycleSplit([slot({ cycleN: 9 })])).toBe(false);
    expect(hasCycleSplit([slot({ cycleN: 9, cycleInN: 1 })])).toBe(true);
  });
  it("migração 0615: só acrescenta colunas (idempotente) e está registada a seguir à 0610", () => {
    expect(MIGRATION_0615_STATEMENTS.every((x) => /^ALTER TABLE `ops_pressure_stats` ADD COLUMN `cycle(Out|In)(N|P50|P60|P75|P85|P90)`/.test(x))).toBe(true);
    expect(MIGRATION_0615_STATEMENTS).toHaveLength(12);
    expect(MIGRATION_0615_STATEMENTS.join(" ")).not.toMatch(/DROP|DELETE|UPDATE /);
    // registada logo a seguir à 0610 (depois dela vêm outras, ex.: 0620 do plano 56)
    expect(SCHEMA_MIGRATION_IDS.indexOf("0615")).toBe(SCHEMA_MIGRATION_IDS.indexOf("0610") + 1);
  });
  it("o quadro tem o seletor Entregas / Recolhas / Juntas, com a mesma legenda e as mesmas regras", () => {
    const tab = src("client/src/pages/extrasDia/PressureTab.tsx");
    expect(tab).toContain('{ key: "out", label: "Entregas" }');
    expect(tab).toContain('{ key: "in", label: "Recolhas" }');
    expect(tab).toContain('{ key: "all", label: "Juntas" }');
    expect(tab).toContain("const c = slotCycleOf(s, cycleKind, pct);");
    expect(tab).toContain("return c.n >= MIN_SAMPLE ? c.value : null;");
    // a rampa da legenda é a mesma da Semana
    expect(tab).toContain('from "@/components/heatRamp"');
  });
  it("a página e o trabalho guardam/leem as colunas novas (e o recurso sem elas)", () => {
    const job = src("server/extrasPressure.ts");
    expect(job).toContain("cycleOutN = VALUES(cycleOutN)");
    expect(job).toContain("Sem as colunas da migração 0615");
    expect(job).toContain("pressureDaySig(chunk.parkIds, part)");
  });
});

// ─── 2. Semana ───────────────────────────────────────────────────────────────

describe("2 — Semana: domingo → sábado, dias operacionais × horas", () => {
  it("a semana começa no domingo; 7 dias operacionais e 8 dias de calendário (00–02h do último)", () => {
    expect(weekStartOf("2026-10-12")).toBe("2026-10-11"); // segunda → domingo anterior
    expect(weekStartOf("2026-10-11")).toBe("2026-10-11"); // domingo → o próprio
    expect(weekStartOf("2026-10-17")).toBe("2026-10-11"); // sábado
    expect(weekOpDays("2026-10-11")).toEqual(["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]);
    expect(weekCalendarDays("2026-10-11").at(-1)).toBe("2026-10-18");
    expect(() => weekStartOf("12/10/2026")).toThrow();
  });
  it("colunas pela ordem do dia operacional (03h … 23h, 00h, 01h, 02h); 00–02h são do dia seguinte", () => {
    expect(WEEK_HOURS).toHaveLength(24);
    expect(WEEK_HOURS.slice(0, 2)).toEqual([3, 4]);
    expect(WEEK_HOURS.slice(-3)).toEqual([0, 1, 2]);
    expect(opSlotToCalendar("2026-10-17", 1)).toEqual({ day: "2026-10-18", hour: 1 });
    expect(opSlotToCalendar("2026-10-17", 3)).toEqual({ day: "2026-10-17", hour: 3 });
  });
  it("durações: média, mediana, p75 (como o percentile_cont) e máximo, em minutos", () => {
    expect(durStats([10 * MIN, 20 * MIN, 30 * MIN, 40 * MIN])).toEqual({ n: 4, avg: 25, p50: 25, p75: 32.5, max: 40 });
    expect(durStats([])).toEqual({ n: 0, avg: null, p50: null, p75: null, max: null });
  });

  const group = {
    "2026-10-11": { h: { 18: { co: 3, ci: 2, cos: 4, cis: 2, del: [10 * MIN, 30 * MIN], pik: [5 * MIN] } } },
    // a madrugada de sábado para domingo (02h de dia 18) é ainda do SÁBADO operacional
    "2026-10-18": { h: { 2: { co: 1, ci: 0, cos: 1, cis: 0, del: [20 * MIN], pik: [] }, 9: { co: 50 } } },
    "2026-10-12": { h: { 18: { co: 1, ci: 4, del: [50 * MIN] } } },
  };
  const driver = {
    "2026-10-11": { h: { 18: { cyo: [40 * MIN, 50 * MIN], cyi: [30 * MIN], u: ["A", "B"] } } },
    "2026-10-12": { h: { 18: { cyo: [60 * MIN], cyi: [], u: ["B", "C"] } } },
  };
  const g = buildWeekGrids("2026-10-11", group, driver);
  const col = (h: number) => WEEK_HOURS.indexOf(h);
  it("entregas: entregues, pedidos, tempo por carro (só entregas) e pendente → entregue por célula", () => {
    const c = g.entregas.rows[0].cells[col(18)];
    expect(c).toMatchObject({ count: 3, requested: 4, people: 2 });
    expect(c.cycle).toMatchObject({ n: 2, avg: 45, p75: 47.5 });
    expect(c.wait).toMatchObject({ n: 2, avg: 20, p75: 25, max: 30 });
    expect(weekCellValue(c, "quantidade")).toBe(3);
    expect(weekCellValue(c, "tempo")).toBe(47.5);
    // 02h de domingo 18 → sábado 17 (última linha), última coluna
    expect(g.entregas.rows[6].day).toBe("2026-10-17");
    expect(g.entregas.rows[6].cells[col(2)]).toMatchObject({ count: 1 });
    // 09h de domingo 18 é da semana seguinte: não entra
    expect(g.entregas.total.count).toBe(3 + 1 + 1);
  });
  it("recolhas: recolhidos, recolhas começadas, tempo por carro só das recolhas e começada → feita", () => {
    const c = g.recolhas.rows[0].cells[col(18)];
    expect(c).toMatchObject({ count: 2, requested: 2 });
    expect(c.cycle).toMatchObject({ n: 1, p75: 30 });
    expect(c.wait).toMatchObject({ n: 1, p75: 5 });
    expect(weekCellValue(g.recolhas.rows[1].cells[col(18)], "tempo")).toBeNull(); // sem recolhas medidas
    expect(weekCellValue(g.recolhas.rows[2].cells[col(18)], "quantidade")).toBeNull(); // 0 → vazio
  });
  it("totais: somas e percentis sobre TODOS os casos (não a média das células); pessoas sem repetidos", () => {
    const h18 = g.entregas.hourTotals[col(18)];
    expect(h18.count).toBe(4);
    expect(h18.cycle).toMatchObject({ n: 3, p50: 50, p75: 55 }); // [40, 50, 60]
    expect(h18.people).toBe(3); // A, B, C
    expect(g.entregas.rows[0].total).toMatchObject({ count: 3 });
    expect(g.entregas.total.wait.n).toBe(4);
  });
  it("semana atual: as horas que ainda não chegaram ficam marcadas (não são zeros)", () => {
    const now = buildWeekGrids("2026-10-11", group, driver, { day: "2026-10-12", hour: 14 });
    expect(now.entregas.rows[1].cells[col(14)].future).toBeUndefined();
    expect(now.entregas.rows[1].cells[col(15)].future).toBe(true);
    expect(now.entregas.rows[1].future).toBe(false);
    expect(now.entregas.rows[2].future).toBe(true);
  });
});

describe("2 — Semana: leitura (dias guardados da Pressão ou uma leitura da semana)", () => {
  const PARKS = [
    { id: "L1", name: "Airpark Lisboa", city: "Lisboa", firebase_brand: null, listing_type: "ON_PLATFORM", status: "ACTIVE" },
    { id: "L2", name: "Skypark Lisboa", city: "Lisboa", firebase_brand: null, listing_type: "ON_PLATFORM", status: "ACTIVE" },
    { id: "P1", name: "Airpark Porto", city: "Porto", firebase_brand: null, listing_type: "ON_PLATFORM", status: "ACTIVE" },
  ];
  const NOW = lisbonLocalTimeUtcMs("2026-10-12", 14); // segunda 12 out, 14h
  const fakeQuery = () => vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM "Park"')) return PARKS;
    if (sql.includes("AS jobs")) return [{ d: "2026-10-11", hr: 18, jobs: 2, cyo: "2400000", cyi: "1800000", uids: ["A"] }];
    return [{ part: "h", d: "2026-10-11", hr: 18, ci_done: 1, co_done: 2, ci_started: 1, co_started: 2, del_ms: "600000", pik_ms: null }];
  });
  it("semana atual: UMA leitura da semana (grupo + condutores), só leitura, só os parques da cidade", async () => {
    const q = fakeQuery();
    const r = await getWeekActivity({ city: "lisbon", weekStart: "2026-10-12", now: NOW, query: q as any, stored: null, excludedParkIds: ["L2"], since: "2026-04-03", isConfigured: () => true });
    expect(r).toMatchObject({ available: true, weekStart: "2026-10-11", weekEnd: "2026-10-17", source: "ao vivo", parks: 1 });
    if (!r.available) throw new Error("x");
    expect(r.grids.entregas.rows[0].cells[WEEK_HOURS.indexOf(18)]).toMatchObject({ count: 2, cycle: { n: 1, p75: 40 } });
    expect(r.grids.recolhas.rows[0].cells[WEEK_HOURS.indexOf(18)]).toMatchObject({ count: 1, cycle: { n: 1, p75: 30 } });
    const reads = q.mock.calls.filter(([sql]) => !String(sql).includes('FROM "Park"'));
    expect(reads).toHaveLength(2);
    for (const [sql, params] of reads) {
      expect(() => assertReadOnlySql(String(sql))).not.toThrow();
      expect(params).toContain("L1");
      expect(params).not.toContain("L2"); // parque que a operação não faz
      expect(params).not.toContain("P1"); // outra cidade
      expect(params).toContain("2026-10-10 23:00:00"); // domingo 11 às 00h de Lisboa (início dos 8 dias)
      // reservas e 1.ª ação de cada tipo: a MESMA janela de fundo do trabalho noturno (desde extras.timesSince)
      expect(params).toContain(pressureWindowSince("2026-04-03", "2026-10-18").wideStart);
    }
  });
  it("semana passada guardada pelo cálculo da Pressão (as duas partes, assinatura de hoje): não lê a Multipark", async () => {
    const q = fakeQuery();
    const days = weekCalendarDays("2026-10-04");
    const load = vi.fn(async (_g: string, part: "group" | "driver", _f: string, _t: string, sig: string) => {
      expect(sig).toBe(pressureDaySig(["L1", "L2"], part));
      return days.map((day) => ({ day, payload: part === "group" ? { h: { 10: { co: 1, ci: 0, cis: 0, cos: 1, del: [], pik: [] } }, c: {} } : { h: {} } }));
    });
    const r = await getWeekActivity({ city: "lisbon", weekStart: "2026-10-07", now: NOW, query: q as any, stored: { load }, excludedParkIds: [], since: "2026-04-03", isConfigured: () => true });
    expect(r).toMatchObject({ available: true, weekStart: "2026-10-04", source: "guardado" });
    if (r.available) expect(r.grids.entregas.total.count).toBe(7); // dia 11 às 10h já é da semana seguinte
    expect(q.mock.calls.filter(([sql]) => !String(sql).includes('FROM "Park"'))).toHaveLength(0);
    expect(load).toHaveBeenCalledWith("cidade_lisboa", "driver", "2026-10-04", "2026-10-11", expect.any(String));
  });
  it("dias guardados incompletos → lê a semana da Multipark", async () => {
    const q = fakeQuery();
    const r = await getWeekActivity({ city: "lisbon", weekStart: "2026-10-04", now: NOW, query: q as any, stored: { load: async () => [] }, excludedParkIds: [], since: "2026-04-03", isConfigured: () => true });
    expect(r).toMatchObject({ available: true, source: "ao vivo" });
    expect(q.mock.calls.filter(([sql]) => !String(sql).includes('FROM "Park"'))).toHaveLength(2);
  });
  it("erro a ler ≠ zero: devolve o motivo; semana futura e sem ligação também", async () => {
    const q = vi.fn(async (sql: string) => { if (sql.includes('FROM "Park"')) return PARKS; throw new Error("canceling statement due to statement timeout"); });
    const r = await getWeekActivity({ city: "lisbon", weekStart: "2026-10-12", now: NOW, query: q as any, stored: null, excludedParkIds: [], since: "2026-04-03", isConfigured: () => true });
    expect(r).toMatchObject({ available: false, reason: expect.stringContaining("demorou demasiado") });
    expect(await getWeekActivity({ city: "lisbon", weekStart: "2026-10-19", now: NOW, query: q as any, stored: null, since: "2026-04-03", isConfigured: () => true })).toMatchObject({ available: false, reason: expect.stringContaining("ainda não começou") });
    expect(await getWeekActivity({ city: "lisbon", weekStart: "2026-10-12", now: NOW, query: q as any, since: "2026-04-03", isConfigured: () => false })).toMatchObject({ available: false, reason: expect.stringContaining("não está configurada") });
    const none = vi.fn(async (sql: string) => (sql.includes('FROM "Park"') ? PARKS.filter((p) => p.city === "Porto") : []));
    expect(await getWeekActivity({ city: "faro", weekStart: "2026-10-12", now: NOW, query: none as any, stored: null, excludedParkIds: [], isConfigured: () => true })).toMatchObject({ available: false, reason: expect.stringContaining("Sem parques") });
  });
  it("janela de fundo: a do trabalho noturno, e pelo menos 30 dias antes da semana", () => {
    expect(weekBackgroundWindow("2026-04-03", "2026-10-11", "2026-10-18")).toEqual(pressureWindowSince("2026-04-03", "2026-10-18"));
    expect(weekBackgroundWindow("2026-10-01", "2026-10-11", "2026-10-18").startDay).toBe("2026-09-11");
    expect(weekBackgroundWindow(null, "2026-10-11", "2026-10-18").startDay).toBe("2026-04-03");
  });
  it("o pedido: Atividade diária, cidade das do utilizador (o resto vem limitado pelo âmbito)", () => {
    const r = src("server/routers.ts");
    const block = r.slice(r.indexOf("weekActivity: protectedProcedure"), r.indexOf("weekActivity: protectedProcedure") + 1200);
    expect(block).toContain('requireAccess(ctx.user, "atividade_diaria", "view")');
    expect(block).toContain("city: z.enum(HANDOVER_CITIES)");
    expect(block).toContain("allowedHandoverCities({ all: false, cityNames: names }).includes(input.city)");
  });
  it("o separador: seletores de cidade, semana (◀ ▶ e data), Entregas/Recolhas e Quantidade/Tempo; scroll no telemóvel", () => {
    const t = src("client/src/components/operacoes/WeekActivityTab.tsx");
    expect(t).toContain("<CitySelect");
    expect(t).toContain('aria-label="Semana anterior"');
    expect(t).toContain('type="date"');
    expect(t).toContain("go(weekStartOf(e.target.value))");
    expect(t).toContain("Cada linha é um dia operacional (03:00 → 03:00)");
    expect(t).toContain('className="overflow-x-auto"');
    expect(t).toContain("trpc.multipark.weekActivity.useQuery");
  });
});

// ─── 3. Resumo do dia na Atividade diária ────────────────────────────────────

describe("3 — Resumo do dia: saiu da Passagem de turno, entrou na Atividade diária (mesma permissão)", () => {
  it("separador para quem tem 'Passagem — Resumo do dia' (supervisor e acima), não para o TL", () => {
    expect(operationalAccess({ role: "supervisor" } as any).tabs).toContain("resumo");
    expect(operationalAccess({ role: "admin" } as any).tabs).toContain("resumo");
    expect(operationalAccess({ role: "team_leader" } as any).tabs).not.toContain("resumo");
    expect(OPERATIONAL_TABS).toEqual(expect.arrayContaining(["resumo", "semana", "mes"]));
  });
  it("o componente mudou de sítio sem perder nada do #361 (gaveta, entregas lentas, cartões por TL, parado no turno)", () => {
    const tab = src("client/src/components/shiftDay/DaySummaryTab.tsx");
    for (const s of ["trpc.shiftHandover.supervisorDashboard.useQuery", "trpc.shiftHandover.peopleShiftGps.useQuery", "trpc.shiftHandover.compliance.useQuery",
      "<DriverDaySheet", "<SlowDeliveryDialog", "<HandoverShiftCard", "<DayTimesSection", "Quem trabalhou", "Horas paradas", "Excesso de velocidade", "Km da equipa"]) {
      expect(tab, s).toContain(s);
    }
    // 15 out 2026: as entregas mais lentas passaram para os tempos (pelo nosso tempo; com o portão fechado, pela Fila)
    expect(src("client/src/components/shiftDay/DayTimesSection.tsx")).toContain("Mais lentas");
    const op = src("client/src/pages/OperationalPage.tsx");
    expect(op).toContain('{has("resumo") && <TabsTrigger value="resumo">');
    expect(op).toContain("<DaySummaryTab />");
  });
  it("a Passagem de turno já não o tem: o separador antigo cai no normal e há a ligação", () => {
    const page = src("client/src/pages/ShiftHandoverPage.tsx");
    expect(page).not.toContain("SupervisorDashboard");
    expect(page).not.toContain('value="dashboard"');
    expect(page).toContain('const HANDOVER_TABS = ["preencher", "aovivo", "historico"] as const;');
    expect(page).toContain('(HANDOVER_TABS as readonly string[]).includes(rawTab) ? rawTab : "preencher"');
    expect(page).toContain('href="/operacional?tab=resumo"');
    expect(page).toContain("O Resumo do dia está agora em");
  });
});

// ─── 4. Avaliação do mês ─────────────────────────────────────────────────────

describe("4 — Avaliação do mês: o MESMO componente do 'Mês' da Avaliação, a mesma regra", () => {
  it("canRank: Avaliação para além do próprio (TL e acima; nunca o condutor/extra)", () => {
    expect(canSeeEvaluationRanking({ role: "team_leader" } as any)).toBe(true);
    expect(canSeeEvaluationRanking({ role: "supervisor" } as any)).toBe(true);
    expect(canSeeEvaluationRanking({ role: "condutor" } as any)).toBe(false);
    expect(canSeeEvaluationRanking({ role: "extra" } as any)).toBe(false);
    expect(operationalAccess({ role: "team_leader" } as any).tabs).toContain("mes");
    expect(operationalAccess({ role: "condutor" } as any)).toEqual({ tabs: [], ownSpeedOnly: true });
  });
  it("não há código duplicado: as duas páginas usam MonthEvaluationTab, e a Avaliação mantém o 'Mês'", () => {
    const aval = src("client/src/pages/AvaliacaoPage.tsx");
    expect(aval).toContain("<MonthEvaluationTab isSupervisor={isSupervisor} range={range} onRangeChange={setRange}");
    expect(aval).toContain("const canRank = canSeeEvaluationRanking(user as any);");
    expect(aval).not.toContain("function RankingView");
    const op = src("client/src/pages/OperationalPage.tsx");
    expect(op).toContain("<MonthEvaluationTab isSupervisor={evalSupervisor} />");
    const comp = src("client/src/components/evaluation/MonthEvaluationTab.tsx");
    for (const s of ["function RankingView", "function TeamsCard", "function LiveMovementsCard", "<RulesLegend />", "trpc.evaluation.ranking.useQuery"]) expect(comp, s).toContain(s);
  });
});

// ─── 5. Reclamações dos carros que saíram ───────────────────────────────────

describe("5 — Reclamações dos carros que SAÍRAM no dia", () => {
  it("referências: o id e o código de cada reserva, sem repetidos nem vazios", () => {
    expect(departedRefs([{ bookingId: "b1", bookingCode: "MP-1" }, { bookingId: "b1", bookingCode: "MP-1" }, { bookingId: "b2", bookingCode: null }, { bookingId: " ", bookingCode: "" }]))
      .toEqual(["b1", "MP-1", "b2"]);
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("do histórico do Resumo: só CHECK_OUT dentro do dia operacional (o pendente e o fora de horas não contam)", () => {
    const rows = [
      { changeType: "CHECK_OUT", actionTime: "2026-10-12 10:00:00", bookingExternalId: "a", bookingCode: "MP-a" },
      { changeType: "CHECK_OUT", actionTime: "2026-10-12 11:00:00", bookingExternalId: "a", bookingCode: "MP-a" },
      { changeType: "PENDING_CHECKOUT", actionTime: "2026-10-12 10:00:00", bookingExternalId: "b" },
      { changeType: "CHECK_OUT", actionTime: "2026-10-13 05:00:00", bookingExternalId: "c" }, // depois das 03h do dia seguinte
      { changeType: "CHECK_OUT", actionTime: "2026-10-12 01:59:59", bookingExternalId: "d" }, // antes das 03h
    ];
    expect(departedFromHistory(rows, "2026-10-12 02:00:00", "2026-10-13 02:00:00")).toEqual([{ bookingId: "a", bookingCode: "MP-a" }]);
  });
  it("leitura da Multipark: reservas diferentes com CHECK_OUT no período, só leitura, parametrizada, cidades e LIMIT", () => {
    const { sql, params } = buildLiveHistoryBookingsSql({ changeTypes: ["CHECK_OUT"], from: "2026-10-12 02:00:00", to: "2026-10-13 02:00:00", cities: ["Lisboa"] });
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain('SELECT DISTINCT h."bookingId" AS booking_id');
    expect(sql).toContain('upper(h."changeType"::text) IN ($');
    expect(sql).toContain('lower(trim(pk."city")) IN (');
    expect(sql).not.toContain("Lisboa");
    expect(params).toEqual(expect.arrayContaining(["CHECK_OUT", "2026-10-12 02:00:00", "2026-10-13 02:00:00", "lisboa", HISTORY_BOOKINGS_LIMIT]));
    expect(buildLiveHistoryBookingsSql({ cities: [] }).sql).toContain("FALSE");
  });
  it("contagem na nossa BD: pela referência, sem arquivadas nem convertidas, no âmbito; nada → 0 sem perguntar", async () => {
    expect(await countComplaintsForRefs([])).toBe(0);
    expect(state.sql).toHaveLength(0);
    state.counts = [2, 1];
    const refs = Array.from({ length: 1500 }, (_, i) => `b${i}`);
    expect(await countComplaintsForRefs(refs)).toBe(3);
    expect(state.sql).toHaveLength(2); // partes de 1000
    expect(state.sql[0]).toContain("complaints.reservationRef IN (");
    expect(state.sql[0]).toContain("complaints.archivedAt IS NULL AND complaints.complaint_status <> 'converted'");
    expect(state.params[0]).toContain("b0");
    expect(state.params[1]).toContain("b1499");
  });
  it("cartão com a dica da regra, na Atividade do Dia e no Resumo; erro ≠ zero", () => {
    expect(DEPARTED_COMPLAINTS_HINT).toContain("seja qual for o dia em que a reclamação chegou");
    const tab = src("client/src/components/shiftDay/DaySummaryTab.tsx");
    expect(tab).toContain("<DepartedComplaintsCard value={data.complaintsDeparted} />");
    expect(tab).toContain('{loading ? "…" : ok ? ok.complaints : "—"}');
    const op = src("client/src/pages/OperationalPage.tsx");
    expect(op).toContain("trpc.multipark.departedComplaints.useQuery");
    expect(op).toContain("<DepartedComplaintsCard");
    const dash = src("server/supervisorDay.ts");
    expect(dash).toContain("complaintsDeparted = { available: true, complaints: await countComplaintsForRefs(departedRefs(left))");
    const r = src("server/routers.ts");
    const block = r.slice(r.indexOf("departedComplaints: protectedProcedure"), r.indexOf("departedComplaints: protectedProcedure") + 900);
    expect(block).toContain('requireAccess(ctx.user, "atividade_diaria", "view")');
  });
});
