/**
 * Lote 47c — Pressão do Extras-Dia: a BD da Multipark lê-se um dia × grupo de
 * cada vez e só os dias que faltam; os dias guardam-se na nossa BD
 * (ops_pressure_days) e juntam-se no mesmo formato de antes. A igualdade com
 * as leituras antigas da janela inteira prova-se num Postgres a sério em
 * extrasPressure.pg.test.ts (PRESSURE_PG_URL); aqui as regras puras, a corrida
 * e as ligações.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Driver do Postgres falso: regista o que a ligação manda (para ver os SET LOCAL).
const pgCalls = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("pg", () => {
  class FakeClient {
    async query(q: any) { pgCalls.list.push(typeof q === "string" ? q : q.text); return { rows: [{ ok: 1 }] }; }
    release() {}
  }
  class Pool {
    on() {}
    async connect() { return new FakeClient(); }
    async end() {}
  }
  return { default: { Pool }, Pool };
});

import { ANALYTICS_SETTINGS, assertReadOnlySql, closeMultiparkDb, multiparkDbQuery } from "./multiparkDb/client";
import {
  buildPressureCrewSql, buildPressureDaySql, buildPressureDriverDaySql, buildPressureDriverSlotsSql, buildPressureLoadSql, buildPressureSlotsSql,
  crewBandCase, mapPressureCrewRow, mapPressureDriverRow, mapPressureLoadRow, mapPressureSlotRow, pressureWindow, pressureWindowSince,
} from "./multiparkDb/pressure";
import {
  PRESSURE_DAYS_VERSION, combineDriverDays, combineGroupDays, crewBandIndex, driverDayPayloads, groupDayPayloads, missingPressureDays, msList,
  parseDayPayload, percentileCont, pressureDaySig, uidList, windowDayList, type DriverDayPayload, type GroupDayPayload,
} from "./pressureDays";
import {
  PRESSURE_RUN_READS_MS, formatPressureCursor, parsePressureCursor, parsePressureReprocess, parseReprocessParam, runExtrasPressure, type PressureDaysStore, type PressureStore,
} from "./extrasPressure";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { MIGRATION_0570_STATEMENTS } from "./migrations/migration_0570";
import { crewMeasureBands, percentile } from "../shared/extrasPressure";
import { DEFAULT_CREW_RULES } from "../shared/appSettings";
import { lisbonDayOf } from "../shared/lisbonDay";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const w = pressureWindowSince("2026-04-03", "2026-10-06");

describe("47c — leituras de UM dia na BD da Multipark", () => {
  it("leitura do grupo: só leitura, parametrizada, limitada ao dia (reservas da janela, eventos só do dia)", () => {
    const r = pressureWindow("2026-10-06", 1);
    const { sql, params } = buildPressureDaySql(w, r, ["p1", "p2"]);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).not.toContain("p1");
    // reservas da janela inteira (como antes) …
    expect(params).toContain(w.wideStart);
    // … mas só as que têm um instante NESTE dia entram nas contas
    expect(sql).toContain("rel AS (");
    expect(sql).toContain('AND h."bookingId" IN (SELECT rel.id FROM rel)');
    expect(sql).toContain("FROM bk JOIN rel ON rel.id = bk.id LEFT JOIN hi ON hi.bid = bk.id");
    expect(params).toEqual(expect.arrayContaining([r.start, r.end]));
    expect(params).not.toContain(w.start); // os eventos já não se contam na janela inteira
    // durações exatas ao milissegundo; sem percentis no Postgres (juntam-se os dias cá)
    expect(sql).toContain("round(extract(epoch from (ev.delivered - ev.co_requested)) * 1000)::bigint AS ms");
    expect(sql).not.toContain("percentile_cont");
    expect(sql).toMatch(/LIMIT 20000$/);
  });
  it("leitura por condutor: reservas com ações no dia (±1 dia para os vizinhos), sem TL no SQL", () => {
    const r = pressureWindow("2026-10-06", 1);
    const { sql, params } = buildPressureDriverDaySql(w, r, ["p1"]);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain("SELECT DISTINCT h.\"bookingId\" AS id FROM \"History\" h");
    expect(sql).toContain('AND h."bookingId" IN (SELECT rel.id FROM rel)');
    expect(params).toEqual(expect.arrayContaining([r.wideStart, r.wideEnd, r.start, r.end]));
    expect(sql).toContain("round(jb.gap * 60000)::bigint END AS cycle_ms");
    expect(sql).toContain("array_agg(DISTINCT ha.uid ORDER BY ha.uid) AS uids");
    // o TL aplica-se ao juntar os dias (lista de hoje): nenhum TL vai para a leitura
    expect(sql).toContain("bool_or(FALSE)");
    expect(params).toHaveLength(9);
  });
  it("as leituras antigas da janela inteira (referência dos testes) não mudaram", () => {
    for (const q of [buildPressureSlotsSql(w, ["p1"]), buildPressureLoadSql(w, ["p1"]), buildPressureDriverSlotsSql(w, ["p1"], ["tl"]), buildPressureCrewSql(w, ["p1"], crewMeasureBands(DEFAULT_CREW_RULES.lisbon), ["tl"])]) {
      expect(q.sql).not.toContain("rel AS (");
      expect(q.sql).not.toContain("_ms");
      expect(q.params).toContain(w.start);
    }
  });
});

describe("47c — leitura analítica (sem nested loops nem JIT)", () => {
  afterEach(async () => { await closeMultiparkDb(); delete process.env.DATABASE_URL_MULTIPARK; pgCalls.list = []; });
  it("só com analytics: SET LOCAL depois do tempo-limite, dentro da transação só de leitura", async () => {
    process.env.DATABASE_URL_MULTIPARK = "postgres://u:p@db.example:5432/mp?sslmode=disable";
    await multiparkDbQuery("SELECT 1", [], { analytics: true, timeoutMs: 30_000 });
    const i = pgCalls.list.indexOf("BEGIN READ ONLY");
    expect(pgCalls.list.slice(i, i + 5)).toEqual(["BEGIN READ ONLY", "SET LOCAL statement_timeout = 30000", ...ANALYTICS_SETTINGS, "SELECT 1"]);
    expect(pgCalls.list.at(-1)).toBe("ROLLBACK");
    pgCalls.list = [];
    await multiparkDbQuery("SELECT 2");
    expect(pgCalls.list.join(" | ")).not.toContain("enable_nestloop");
    expect(ANALYTICS_SETTINGS).toEqual(["SET LOCAL enable_nestloop = off", "SET LOCAL jit = off"]);
  });
  it("o trabalho pede leituras analíticas", () => {
    expect(src("server/extrasPressure.ts")).toContain("analytics: true }));");
  });
});

describe("47c — dias guardados: o que falta, assinatura e reprocessar", () => {
  const days = windowDayList({ startDay: "2026-09-28", endDay: "2026-10-04" });
  it("dias da janela, do primeiro ao último", () => {
    expect(days).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(windowDayList(w)).toHaveLength(187);
  });
  it("assinatura: versão + parques (ordem e repetidos não contam)", () => {
    expect(pressureDaySig(["b", "a", "a"])).toBe(pressureDaySig(["a", "b"]));
    expect(pressureDaySig(["a", "b"])).not.toBe(pressureDaySig(["a", "b", "c"]));
    expect(pressureDaySig(["a"])).toMatch(new RegExp(`^v${PRESSURE_DAYS_VERSION}:1:[0-9a-f]{16}$`));
  });
  it("lê-se só o que falta: sem linha, outra assinatura, ou reprocessar à mão (uma vez)", () => {
    const sig = pressureDaySig(["p1"]);
    const meta = new Map(days.map((d) => [d, { sig, computedAt: "2026-10-05 04:50:00" }]));
    expect(missingPressureDays(days, meta, sig)).toEqual([]);
    meta.delete("2026-10-01");
    meta.set("2026-10-03", { sig: "v0:1:velho", computedAt: "2026-10-05 04:50:00" });
    expect(missingPressureDays(days, meta, sig)).toEqual(["2026-10-01", "2026-10-03"]);
    const rp = { from: "2026-09-29", to: "2026-09-30", before: "2026-10-06 10:00:00" };
    expect(missingPressureDays(days, meta, sig, rp)).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-03"]);
    meta.set("2026-09-29", { sig, computedAt: "2026-10-06 10:00:05" }); // já relido depois do pedido
    expect(missingPressureDays(days, meta, sig, rp)).toEqual(["2026-09-30", "2026-10-01", "2026-10-03"]);
  });
  it("?reprocessar=… e o cursor que o leva às chamadas seguintes", () => {
    expect(parseReprocessParam("2026-09-01", "2026-10-07 09:00:00")).toEqual({ from: "2026-09-01", to: "2026-09-01", before: "2026-10-07 09:00:00" });
    expect(parseReprocessParam("2026-09-01..2026-09-30", "2026-10-07 09:00:00")).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    for (const bad of ["", "ontem", "2026-09-30..2026-09-01", "2026-13-01", "2026-09-01;DROP"]) expect(parseReprocessParam(bad, "2026-10-07 09:00:00")).toBeNull();
    const rp = { from: "2026-09-01", to: "2026-09-30", before: "2026-10-07 09:00:00" };
    const c = formatPressureCursor("2026-10-06", 2, rp);
    expect(parsePressureCursor(c, "2026-10-06")).toBe(2);
    expect(parsePressureReprocess(c, "2026-10-06")).toEqual(rp);
    expect(parsePressureReprocess(c, "2026-10-07")).toBeNull();
    expect(parsePressureReprocess(formatPressureCursor("2026-10-06", 2), "2026-10-06")).toBeNull();
    const api = src("server/_core/api-entry.ts");
    expect(api).toContain("parseReprocessParam(req.query.reprocessar");
    expect(api).toContain("extrasPressureCron({ deadlineAt: manualDeadline(), cursor, reprocess })");
  });
});

describe("47c — linhas de um dia → payload", () => {
  it("ms e agentes, de texto do pg ou de listas", () => {
    expect(msList("900000,1320000")).toEqual([900000, 1320000]);
    expect(msList([5, "7"])).toEqual([5, 7]);
    expect(msList(null)).toEqual([]);
    expect(uidList(["B", "A", "A", ""])).toEqual(["A", "B"]);
    expect(uidList("{A,B}")).toEqual(["A", "B"]);
    expect(uidList(null)).toEqual([]);
  });
  it("grupo: horas e carros em mãos; linhas de outro dia ignoradas; dia sem nada fica vazio", () => {
    const m = groupDayPayloads([
      { part: "h", d: "2026-10-05", hr: "18", ci_done: "3", co_done: "9", ci_started: "3", co_started: "8", del_ms: "900000,1320000", pik_ms: null },
      { part: "c", d: "2026-10-05", hk: "2026-10-04 23", n: "2" },
      { part: "c", d: "2026-10-05", hk: "2026-10-05 18", n: "5" },
      { part: "h", d: "2026-10-09", hr: 1, ci_done: 1 },
    ], ["2026-10-05", "2026-10-06"]);
    expect(m.get("2026-10-05")).toEqual({ h: { 18: { ci: 3, co: 9, cis: 3, cos: 8, del: [900000, 1320000], pik: [] } }, c: { "2026-10-04 23": 2, "2026-10-05 18": 5 } });
    expect(m.get("2026-10-06")).toEqual({ h: {}, c: {} });
    expect(m.has("2026-10-09")).toBe(false);
  });
  it("condutores: serviços, durações e quem agiu", () => {
    const m = driverDayPayloads([{ d: "2026-10-05", hr: 7, jobs: "2", cy: "2400000", dr: null, tp: "300000,600000", uids: ["A"] }], ["2026-10-05"]);
    expect(m.get("2026-10-05")).toEqual({ h: { 7: { jobs: 2, cy: [2400000], dr: [], tp: [300000, 600000], u: ["A"] } } });
  });
  it("payload guardado: JSON → objeto; lixo → vazio", () => {
    expect(parseDayPayload<GroupDayPayload>('{"h":{},"c":{"2026-10-05 01":1}}').c).toEqual({ "2026-10-05 01": 1 });
    expect(parseDayPayload<GroupDayPayload>("lixo")).toEqual({ h: {}, c: {} });
  });
});

describe("47c — juntar os dias (o mesmo que as leituras antigas)", () => {
  it("percentile_cont: a mesma fórmula do Postgres (e do percentil partilhado)", () => {
    let seed = 47;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let k = 0; k < 200; k++) {
      const v = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => Math.round(rnd() * 14_400_000) / 60_000).sort((a, b) => a - b);
      for (const q of [0.5, 0.6, 0.75, 0.85, 0.9]) expect(percentileCont(v, q)).toBe(percentile(v, q));
    }
    expect(percentileCont([], 0.5)).toBeNull();
    expect(percentileCont([10, 20, 30, 40], 0.75)).toBe(32.5);
  });
  it("grupo: contagens somam, percentis sobre todos os dias, carros em mãos por hora de relógio, carga da hora de cada dia", () => {
    // sexta 2 out e sexta 9 out, 18h (verão); concorrência das 18h de cada sexta e uma hora de quinta (23h, da véspera)
    const days: Array<{ day: string; payload: GroupDayPayload }> = [
      { day: "2026-10-02", payload: { h: { 18: { ci: 1, co: 2, cis: 1, cos: 2, del: [600000, 1200000], pik: [300000] } }, c: { "2026-10-02 18": 3, "2026-10-01 23": 1 } } },
      { day: "2026-10-09", payload: { h: { 18: { ci: 6, co: 6, cis: 5, cos: 6, del: [1800000], pik: [] } }, c: { "2026-10-09 18": 5 } } },
    ];
    const { slotRows, loadRows } = combineGroupDays(days);
    expect(slotRows).toEqual([
      { wd: 4, hr: 23, ci_done: 0, co_done: 0, ci_started: 0, co_started: 0, conc_sum: 1, conc_max: 1, del_n: 0, del_p50: null, del_p75: null, del_p90: null, pik_n: 0, pik_p50: null, pik_p75: null },
      { wd: 5, hr: 18, ci_done: 7, co_done: 8, ci_started: 6, co_started: 8, conc_sum: 8, conc_max: 5, del_n: 3, del_p50: 20, del_p75: 25, del_p90: 28, pik_n: 1, pik_p50: 5, pik_p75: 5 },
    ]);
    // 2 out: carga 3 → escalão 1 (ponta, 18h); 9 out: carga 12 → escalão 4
    expect(loadRows).toEqual([
      { lb: 1, rush: true, n: 2, p50: 15, p75: 17.5, p90: 19 },
      { lb: 4, rush: true, n: 1, p50: 30, p75: 30, p90: 30 },
    ]);
    const ww = pressureWindowSince("2026-10-01", "2026-10-09");
    expect(mapPressureSlotRow("g", ww, slotRows[1])).toMatchObject({ weekday: 5, hour: 18, deliveryP75: 25, concurrencyAvg: 4, concurrencyMax: 5 });
    expect(loadRows.map((r) => mapPressureLoadRow("g", r)?.loadBucket)).toEqual([1, 4]);
  });
  it("condutores: TL de hoje (+1 se nenhum TL agiu), escalão e hora cheia como no SQL", () => {
    const bands = crewMeasureBands(DEFAULT_CREW_RULES.lisbon);
    const days: Array<{ day: string; payload: DriverDayPayload }> = [
      // sexta 18h: A (TL) e B agiram; 3 serviços → 2 pessoas, hora cheia
      { day: "2026-10-02", payload: { h: { 18: { jobs: 3, cy: [2400000, 2700000], dr: [1200000], tp: [], u: ["A", "B"] } } } },
      // sexta seguinte 18h: só C (sem TL → +1 = 2 pessoas), 1 serviço → hora cheia (1 ≥ 1)
      { day: "2026-10-09", payload: { h: { 18: { jobs: 1, cy: [3000000], dr: [], tp: [600000], u: ["C"] }, 19: { jobs: 0, cy: [], dr: [], tp: [], u: ["C", "D"] } } } },
    ];
    const { driverRows, crewRows } = combineDriverDays(days, [" A "], bands);
    expect(driverRows).toEqual([
      { wd: 5, hr: 18, cy_n: 3, cy_p50: 45, cy_p60: 46, cy_p75: 47.5, cy_p85: 48.5, cy_p90: 49, dr_n: 1, dr_p50: 20, dr_p75: 20, dr_p90: 20, tp_n: 1, tp_p50: 10, tp_p75: 10, crew_avg: 2 },
      { wd: 5, hr: 19, cy_n: 0, cy_p50: null, cy_p60: null, cy_p75: null, cy_p85: null, cy_p90: null, dr_n: 0, dr_p50: null, dr_p75: null, dr_p90: null, tp_n: 0, tp_p50: null, tp_p75: null, crew_avg: 3 },
    ]);
    const band2 = crewBandIndex(2, bands);
    expect(crewRows).toEqual([{ band: band2, busy: true, n: 3, p50: 45, p60: 46, p75: 47.5, p85: 48.5, p90: 49 }]);
    expect(mapPressureCrewRow("cidade_lisboa", bands, crewRows[0])).toMatchObject({ bandLabel: "2", n: 3 });
    expect(mapPressureDriverRow(driverRows[0])).toMatchObject({ cycleN: 3, crewAvg: 2 });
    // sem TL conhecido: +1 em todas as horas
    expect(combineDriverDays(days, [], bands).driverRows[0].crew_avg).toBe(2.5);
  });
  it("escalão de pessoas = o CASE do SQL (crewBandCase)", () => {
    const bands = crewMeasureBands(DEFAULT_CREW_RULES.lisbon);
    const sqlCase = crewBandCase("x", bands);
    for (let n = 0; n <= 12; n++) {
      const m = new RegExp(`WHEN x >= (\\d+)(?: AND x <= (\\d+))? THEN (\\d+)`, "g");
      let want = 0;
      for (const [, min, max, idx] of sqlCase.matchAll(m)) if (!want && n >= Number(min) && (max === undefined || n <= Number(max))) want = Number(idx);
      expect(crewBandIndex(n, bands)).toBe(want);
    }
  });
});

describe("47c — corrida: lê só os dias que faltam", () => {
  const PARK_ROWS = [{ id: "p1", name: "Airpark Lisboa", city: "Lisboa", firebase_brand: null, listing_type: "ON_PLATFORM", status: "ACTIVE" }];
  const dayOfRead = (params: unknown[]) => lisbonDayOf(Date.parse(`${String(params[params.length - 2]).replace(" ", "T")}Z`));
  function setup() {
    const rows = new Map<string, { sig: string; computedAt: string; payload: unknown }>();
    const days: PressureDaysStore = {
      async meta(g, part, from, to) {
        const out = new Map<string, { sig: string; computedAt: string }>();
        for (const [k, v] of Array.from(rows)) { const [gg, pp, d] = k.split("|"); if (gg === g && pp === part && d >= from && d <= to) out.set(d, v); }
        return out;
      },
      async save(g, part, day, payload, sig, _e, computedAt) { rows.set(`${g}|${part}|${day}`, { sig, computedAt, payload }); },
      async load(g, part, from, to, sig) {
        return Array.from(rows).filter(([k, v]) => { const [gg, pp, d] = k.split("|"); return gg === g && pp === part && d >= from && d <= to && v.sig === sig; })
          .map(([k, v]) => ({ day: k.split("|")[2], payload: v.payload })).sort((a, b) => a.day.localeCompare(b.day));
      },
    };
    const written: string[] = [];
    const store: PressureStore = { async replaceGroup(_w, c) { written.push(c.key); }, async upsertDriver(_w, c) { written.push(`${c.key}:condutores`); }, async finish() {} };
    const q = vi.fn(async (sql: string, params: unknown[]) => (sql.includes('FROM "Park"') ? PARK_ROWS : []));
    return { rows, days, store, written, q };
  }
  const base = { since: "2026-09-25", windowEnd: "2026-10-04", isConfigured: () => true, teamLeaderAgentIds: [] as string[] };

  it("cada leitura é de um só dia × grupo; um dia sem movimento fica guardado (não se volta a ler)", async () => {
    const t = setup();
    const r = await runExtrasPressure({ ...base, deadlineAt: Date.now() + 60_000, query: t.q as any, store: t.store, days: t.days });
    // 3 pedaços (Lisboa, Airpark Lisboa, condutores de Lisboa) × 10 dias
    expect(r).toMatchObject({ ok: true, done: true, chunks: 3, daysRead: 30 });
    expect(t.written).toEqual(["cidade_lisboa", "airpark_lisboa", "cidade_lisboa:condutores"]);
    const reads = t.q.mock.calls.filter(([sql]) => !String(sql).includes('FROM "Park"'));
    for (const [sql, params] of reads) {
      const day = dayOfRead(params as unknown[]);
      const rr = pressureWindow(day, 1);
      expect(params).toEqual(expect.arrayContaining([rr.start, rr.end]));
      expect(String(sql)).toContain("rel AS (");
    }
    expect(t.rows.size).toBe(30);
    t.q.mockClear();
    await runExtrasPressure({ ...base, deadlineAt: Date.now() + 60_000, query: t.q as any, store: t.store, days: t.days });
    expect(t.q).toHaveBeenCalledTimes(1);
  });
  it("os parques do grupo mudaram (outra assinatura): os dias desse grupo voltam a ler-se", async () => {
    const t = setup();
    await runExtrasPressure({ ...base, deadlineAt: Date.now() + 60_000, query: t.q as any, store: t.store, days: t.days });
    for (const [k, v] of Array.from(t.rows)) if (k.endsWith("|2026-10-01")) t.rows.set(k, { ...v, sig: "v0:velho" });
    t.q.mockClear();
    const r = await runExtrasPressure({ ...base, deadlineAt: Date.now() + 60_000, query: t.q as any, store: t.store, days: t.days });
    expect(r.daysRead).toBe(3); // o dia 1 out de cada um dos 3 pedaços
  });
  it("reprocessar à mão: relê o intervalo uma vez (o pedido segue no cursor)", async () => {
    const t = setup();
    await runExtrasPressure({ ...base, deadlineAt: Date.now() + 60_000, query: t.q as any, store: t.store, days: t.days });
    t.q.mockClear();
    const reprocess = parseReprocessParam("2026-09-30..2026-10-02", new Date(Date.now() + 1000).toISOString().slice(0, 19).replace("T", " "))!;
    const r = await runExtrasPressure({ ...base, deadlineAt: Date.now() + 60_000, query: t.q as any, store: t.store, days: t.days, reprocess });
    expect(r.daysRead).toBe(3 * 3);
    // já relidos (guardados depois do pedido): uma 2.ª chamada com o mesmo pedido não lê nada
    const again = await runExtrasPressure({ ...base, deadlineAt: Date.now() + 60_000, query: t.q as any, store: t.store, days: t.days, cursor: formatPressureCursor(base.windowEnd, 0, { ...reprocess, before: "2000-01-01 00:00:00" }) });
    expect(again.daysRead).toBe(0);
  });
  it("um dia que falha a ler: o grupo não se escreve (erro ≠ zero) e os dias lidos ficam guardados", async () => {
    const t = setup();
    t.q.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM "Park"')) return PARK_ROWS;
      if (!sql.includes("AS jobs") && dayOfRead(params) === "2026-10-02") throw new Error("canceling statement due to statement timeout");
      return [];
    });
    const r = await runExtrasPressure({ ...base, deadlineAt: Date.now() + 60_000, query: t.q as any, store: t.store, days: t.days });
    expect(r.ok).toBe(false);
    expect(r.failed.map((f) => f.group)).toEqual(["cidade_lisboa", "airpark_lisboa"]);
    expect(t.written).toEqual(["cidade_lisboa:condutores"]);
    expect([...t.rows.keys()].filter((k) => k.startsWith("cidade_lisboa|group|"))).toHaveLength(7); // 25 set → 1 out
  });
});

describe("47c — o preenchimento inicial não tira o tick aos outros trabalhos", () => {
  it("só começa leituras nos primeiros 20 s; o resto fica para o tick seguinte", async () => {
    const parks = [{ id: "p1", name: "Airpark Lisboa", city: "Lisboa", firebase_brand: null, listing_type: "ON_PLATFORM", status: "ACTIVE" }];
    let now = 1_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const q = vi.fn(async (sql: string) => { now += 3_000; return sql.includes('FROM "Park"') ? parks : []; });
      const saved: string[] = [];
      const days: PressureDaysStore = { async meta() { return new Map(); }, async save(_g, _p, d) { saved.push(d); }, async load() { return []; } };
      const store: PressureStore = { async replaceGroup() {}, async upsertDriver() {}, async finish() {} };
      const r = await runExtrasPressure({ deadlineAt: now + 42_000, windowEnd: "2026-10-06", query: q as any, store, days, isConfigured: () => true, teamLeaderAgentIds: [] });
      expect(PRESSURE_RUN_READS_MS).toBe(20_000);
      // parques (3 s) + leituras de 3 s até passar dos 20 s → 6 dias; a corrida sai a meio, sem erro
      expect(r).toMatchObject({ ok: true, done: false, daysRead: 6, failed: [] });
      expect(now - 1_000_000).toBeLessThanOrEqual(PRESSURE_RUN_READS_MS + 3_000);
    } finally { spy.mockRestore(); }
  });
});

describe("47c — guardar: migração 0570 e espelho", () => {
  it("só cria a tabela (sem apagar nada) e está registada", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0570");
    expect(MIGRATION_0570_STATEMENTS).toHaveLength(1);
    expect(MIGRATION_0570_STATEMENTS[0]).toMatch(/^CREATE TABLE IF NOT EXISTS `ops_pressure_days`/);
    expect(MIGRATION_0570_STATEMENTS[0]).toContain("UNIQUE KEY `uq_ops_pressure_day` (`parkGroup`, `part`, `day`)");
    expect(src("drizzle/schema.ts")).toContain('export const opsPressureDays = mysqlTable("ops_pressure_days"');
  });
  it("um dia substitui-se a si próprio (chave única), nunca DELETE", () => {
    const s = src("server/extrasPressure.ts");
    const store = s.slice(s.indexOf("export const mysqlPressureDaysStore"), s.indexOf("// ─── Corrida"));
    expect(store).toContain("ON DUPLICATE KEY UPDATE");
    expect(store).not.toMatch(/\bDELETE\b/);
  });
});
