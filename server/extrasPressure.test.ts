import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("./multiparkDb/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./multiparkDb/client")>();
  return { ...real, multiparkDbQuery: (...args: any[]) => queryMock(...args) };
});

import { MultiparkDbError, assertReadOnlySql } from "./multiparkDb/client";
import {
  buildPressureChunks, buildPressureLoadSql, buildPressureSlotsSql, loadBucketCase, mapPressureLoadRow, mapPressureSlotRow, pressureWindow, rushCase,
} from "./multiparkDb/pressure";
import {
  EXTRAS_LIVE_LIMIT, buildExtrasBookingsSql, cityParks, getLiveExtrasBookings, mapExtrasBookingRow, resetExtrasLiveState,
} from "./multiparkDb/extrasBookings";
import { mapParks } from "./multiparkDb/dayBookings";
import {
  PRESSURE_CHUNK_MIN_MS, defaultWindowEnd, formatPressureCursor, mapStoredRow, parsePressureCursor, runExtrasPressure, type PressureStore,
} from "./extrasPressure";
import { filterRowsByField, liveToBookingRow, lisbonWallToUtcMs } from "./extrasDia";
import {
  LOAD_BUCKETS, describeLoadEffect, describeTightBlock, groupAllowedForCities, isRushHour, isoWeekday, loadBucketOf, loadComparison, percentile,
  pressureSummary, tightBlocks, tightHoursForDay, tightReason, tightThresholds, type PressureLoadRow, type PressureSlot,
} from "../shared/extrasPressure";
import { TICK_JOBS, isDue, emptyState, applyOutcome, cursorForRun, periodKeyFor, describeCadence, nextDueAt, type JobState } from "./cronSchedule";
import { MIGRATION_0235_STATEMENTS } from "./migrations/migration_0235";

const ENV = "DATABASE_URL_MULTIPARK";
let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env[ENV]; queryMock.mockReset(); resetExtrasLiveState(); });
afterEach(() => { if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv; });

const PARK_ROWS = [
  { id: "p1", name: "Airpark Lisboa", city: "Lisboa", firebase_brand: null, listing_type: "ON_PLATFORM", status: "ACTIVE" },
  { id: "p2", name: "Redpark Lisboa", city: "Lisboa", firebase_brand: null, listing_type: "ON_PLATFORM", status: "ACTIVE" },
  { id: "p3", name: "Skypark Porto", city: "Porto", firebase_brand: null, listing_type: "ON_PLATFORM", status: "ACTIVE" },
  { id: "p4", name: "Top Parking", city: "Lisboa", firebase_brand: null, listing_type: "DIRECTORY", status: "ACTIVE" },
];

const slot = (weekday: number, hour: number, patch: Partial<PressureSlot> = {}): PressureSlot => ({
  group: "cidade_lisboa", weekday, hour, days: 9, checkinsDone: 0, checkoutsDone: 0, checkinsStarted: 0, checkoutsStarted: 0,
  concurrencyAvg: null, concurrencyMax: null, deliveryN: 0, deliveryP50: null, deliveryP75: null, deliveryP90: null, pickupN: 0, pickupP50: null, pickupP75: null,
  ...patch,
});

// ─── SQL (construtores) ─────────────────────────────────────────────────────

describe("pressão — janela e pedaços", () => {
  it("60 dias de Lisboa até ontem, com a contagem de cada dia da semana", () => {
    const w = pressureWindow("2026-09-26");
    expect(w.startDay).toBe("2026-07-29");
    expect(w.start).toBe("2026-07-28 23:00:00");
    expect(w.end).toBe("2026-09-26 23:00:00");
    expect(w.wideStart).toBe("2026-07-27 23:00:00");
    expect(Object.values(w.weekdayDays).reduce((a, b) => a + b, 0)).toBe(60);
    expect(Math.max(...Object.values(w.weekdayDays)) - Math.min(...Object.values(w.weekdayDays))).toBeLessThanOrEqual(1);
    expect(defaultWindowEnd(Date.parse("2026-09-27T08:00:00Z"))).toBe("2026-09-26");
  });
  it("pedaços: cidades, marca + cidade, Marketplace (sem grupos vazios)", () => {
    const chunks = buildPressureChunks(mapParks(PARK_ROWS));
    expect(chunks.map((c) => c.key)).toEqual(["cidade_lisboa", "cidade_porto", "airpark_lisboa", "redpark_lisboa", "skypark_porto", "marketplace"]);
    expect(chunks[0].parkIds.sort()).toEqual(["p1", "p2"]);
    expect(chunks.at(-1)!.parkIds).toEqual(["p4"]);
  });
  it("SQL das células: só leitura, parametrizado, percentis no Postgres", () => {
    const w = pressureWindow("2026-09-26");
    const { sql, params } = buildPressureSlotsSql(w, ["p1", "p2"]);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain('b."parkId" IN ($1, $2)');
    expect(sql).toContain("percentile_cont(0.75) WITHIN GROUP");
    expect(sql).toContain('"pendingCheckoutAt"');
    expect(sql).toContain('"arrivedAtDeliveryAt"');
    expect(sql).toContain("'PENDING_CHECKOUT'");
    expect(sql).toContain("AT TIME ZONE 'Europe/Lisbon'");
    expect(sql).toContain("generate_series");
    expect(sql).not.toContain("p1");
    expect(params).toContain("2026-07-28 23:00:00");
    expect(sql).toMatch(/LIMIT 200$/);
  });
  it("SQL carga × entrega: escalões e horas de ponta são constantes nossas", () => {
    const { sql } = buildPressureLoadSql(pressureWindow("2026-09-26"), ["p1"]);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(loadBucketCase("x")).toBe("CASE WHEN x >= 16 THEN 5 WHEN x >= 11 THEN 4 WHEN x >= 7 THEN 3 WHEN x >= 4 THEN 2 WHEN x >= 1 THEN 1 ELSE 0 END");
    expect(rushCase("h")).toBe("((h >= 7 AND h < 10) OR (h >= 17 AND h < 20))");
    expect(() => buildPressureLoadSql(pressureWindow("2026-09-26"), [])).toThrow();
  });
  it("mapeadores: números do pg (texto) → células; média de concorrência pelos dias", () => {
    const w = pressureWindow("2026-09-26");
    const s = mapPressureSlotRow("g", w, { wd: "5", hr: "17", ci_done: "12", co_done: "40", ci_started: "11", co_started: "39", conc_sum: "90", conc_max: "14", del_n: "40", del_p50: "18.04", del_p75: "27.96", del_p90: "41", pik_n: "0", pik_p50: null, pik_p75: null })!;
    expect(s).toMatchObject({ weekday: 5, hour: 17, checkoutsDone: 40, concurrencyMax: 14, deliveryP75: 28, pickupP50: null });
    expect(s.concurrencyAvg).toBeCloseTo(90 / w.weekdayDays[5], 2);
    expect(mapPressureSlotRow("g", w, { wd: 0, hr: 3 })).toBeNull();
    expect(mapPressureLoadRow("g", { lb: 3, rush: true, n: "8", p50: 10, p75: 20, p90: null })).toMatchObject({ loadBucket: 3, rush: true, deliveryN: 8, deliveryP90: null });
    expect(mapPressureLoadRow("g", { lb: 0, rush: false, n: 3 })).toBeNull();
  });
});

// ─── Cursor e corrida ───────────────────────────────────────────────────────

function memStore() {
  const groups: string[] = [];
  const finished: string[] = [];
  const store: PressureStore = {
    async replaceGroup(_w, chunk) { groups.push(chunk.key); },
    async finish(w) { finished.push(w); },
  };
  return { store, groups, finished };
}

function answer(sql: string) {
  if (sql.includes('FROM "Park"')) return PARK_ROWS;
  if (sql.includes("AS lb")) return [{ lb: 2, rush: false, n: 6, p50: 12, p75: 18, p90: 25 }];
  return [{ wd: 5, hr: 18, ci_done: 3, co_done: 9, ci_started: 3, co_started: 9, conc_sum: 20, conc_max: 5, del_n: 9, del_p50: 15, del_p75: 22, del_p90: 30, pik_n: 3, pik_p50: 8, pik_p75: 10 }];
}

describe("pressão — cursor e retoma", () => {
  it("cursor só vale para a mesma janela", () => {
    const c = formatPressureCursor("2026-09-26", 3);
    expect(parsePressureCursor(c, "2026-09-26")).toBe(3);
    expect(parsePressureCursor(c, "2026-09-27")).toBe(0);
    expect(parsePressureCursor("lixo", "2026-09-26")).toBe(0);
    expect(parsePressureCursor(null, "2026-09-26")).toBe(0);
  });
  it("corre todos os pedaços e marca a janela como completa", async () => {
    const q = vi.fn(async (sql: string) => answer(sql));
    const m = memStore();
    const r = await runExtrasPressure({ deadlineAt: Date.now() + 60_000, windowEnd: "2026-09-26", query: q as any, store: m.store, isConfigured: () => true });
    expect(r).toMatchObject({ ok: true, done: true, chunks: 6, nextIndex: 6, cursor: null });
    expect(m.groups).toEqual(["cidade_lisboa", "cidade_porto", "airpark_lisboa", "redpark_lisboa", "skypark_porto", "marketplace"]);
    expect(m.finished).toEqual(["2026-09-26"]);
    expect(q).toHaveBeenCalledTimes(1 + 6 * 2);
  });
  it("sem tempo: para, devolve o cursor e retoma no pedaço seguinte", async () => {
    const q = vi.fn(async (sql: string) => answer(sql));
    const m = memStore();
    let now = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      // cada leitura "gasta" 5 s; prazo = 20 s → parques (5 s) + 1.º pedaço (10 s) cabem; o 2.º já não (sobram 5 s < 12 s)
      q.mockImplementation(async (sql: string) => { now += 5_000; return answer(sql); });
      const r1 = await runExtrasPressure({ deadlineAt: PRESSURE_CHUNK_MIN_MS + 8_000, windowEnd: "2026-09-26", query: q as any, store: m.store, isConfigured: () => true });
      expect(r1.done).toBe(false);
      expect(r1.processed).toEqual(["cidade_lisboa"]);
      expect(parsePressureCursor(r1.cursor, "2026-09-26")).toBe(1);
      now = 0;
      const r2 = await runExtrasPressure({ deadlineAt: 10_000_000, cursor: r1.cursor, windowEnd: "2026-09-26", query: q as any, store: m.store, isConfigured: () => true });
      expect(r2.done).toBe(true);
      expect(r2.processed[0]).toBe("cidade_porto");
      expect(m.finished).toEqual(["2026-09-26"]);
    } finally { spy.mockRestore(); }
  });
  it("um pedaço que falha não para os outros; a corrida fica vermelha", async () => {
    const q = vi.fn(async (sql: string, params: any[]) => {
      if (!sql.includes('FROM "Park"') && params.includes("p3")) throw new MultiparkDbError("canceling statement due to statement timeout", "QUERY_FAILED");
      return answer(sql);
    });
    const m = memStore();
    const r = await runExtrasPressure({ deadlineAt: Date.now() + 60_000, windowEnd: "2026-09-26", query: q as any, store: m.store, isConfigured: () => true });
    expect(r.ok).toBe(false);
    expect(r.done).toBe(true);
    expect(r.failed.map((f) => f.group)).toEqual(["cidade_porto", "skypark_porto"]);
    expect(r.error).toContain("demorou demasiado");
    expect(m.groups).toHaveLength(4);
  });
  it("parques que a operação não faz: ficam fora de todos os pedaços", async () => {
    const q = vi.fn(async (sql: string) => answer(sql));
    const m = memStore();
    const r = await runExtrasPressure({ deadlineAt: Date.now() + 60_000, windowEnd: "2026-09-26", query: q as any, store: m.store, isConfigured: () => true, excludedParkIds: ["p3"] });
    expect(r).toMatchObject({ ok: true, done: true, chunks: 4 });
    expect(m.groups).toEqual(["cidade_lisboa", "airpark_lisboa", "redpark_lisboa", "marketplace"]);
    expect(q.mock.calls.every(([, params]) => !(params ?? []).includes("p3"))).toBe(true);
  });
  it("sem BD da Multipark configurada: saltado, sem erro", async () => {
    const r = await runExtrasPressure({ deadlineAt: Date.now() + 60_000, windowEnd: "2026-09-26", query: vi.fn() as any, store: memStore().store, isConfigured: () => false });
    expect(r).toMatchObject({ ok: true, done: true });
    expect(r.skipped).toContain("DATABASE_URL_MULTIPARK");
  });
  it("parques ilegíveis: vermelho, com cursor para repetir", async () => {
    const q = vi.fn(async () => { throw new MultiparkDbError("ECONNREFUSED", "CONNECT_FAILED"); });
    const r = await runExtrasPressure({ deadlineAt: Date.now() + 60_000, windowEnd: "2026-09-26", query: q as any, store: memStore().store, isConfigured: () => true });
    expect(r).toMatchObject({ ok: false, done: false });
    expect(parsePressureCursor(r.cursor, "2026-09-26")).toBe(0);
  });
  it("linhas guardadas → células/escalões", () => {
    expect(mapStoredRow({ parkGroup: "g", kind: "slot", weekday: 5, hour: 17, days: 9, checkoutsDone: 3, deliveryP75: "22.5", concurrencyAvg: null }).slot).toMatchObject({ weekday: 5, deliveryP75: 22.5, concurrencyAvg: null });
    expect(mapStoredRow({ parkGroup: "g", kind: "load", loadBucket: 2, rush: 1, deliveryN: 7 }).load).toMatchObject({ loadBucket: 2, rush: true, deliveryN: 7 });
    expect(mapStoredRow({ kind: "done" })).toEqual({});
  });
});

// ─── Escalões, horas apertadas e resumo ─────────────────────────────────────

describe("pressão — regras puras", () => {
  it("escalões de carga e horas de ponta", () => {
    expect([0, 1, 3, 4, 6, 7, 10, 11, 15, 16, 40].map(loadBucketOf)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    expect(LOAD_BUCKETS).toHaveLength(5);
    expect([6, 7, 9, 10, 16, 17, 19, 20].map(isRushHour)).toEqual([false, true, true, false, false, true, true, false]);
  });
  it("percentil igual ao percentile_cont", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0.75)).toBeCloseTo(32.5);
    expect(percentile([], 0.5)).toBeNull();
  });
  it("top 20 % por volume ou por p75 (com amostra mínima)", () => {
    const slots = Array.from({ length: 10 }, (_, i) => slot(1, 8 + i, { checkoutsDone: (i + 1) * 9 }));
    slots.push(slot(3, 12, { checkoutsDone: 9, deliveryN: 20, deliveryP75: 60 }));
    slots.push(slot(3, 13, { checkoutsDone: 9, deliveryN: 2, deliveryP75: 90 })); // amostra pequena: não conta
    for (let i = 0; i < 4; i++) slots.push(slot(4, 10 + i, { checkoutsDone: 9, deliveryN: 10, deliveryP75: 15 }));
    const t = tightThresholds(slots);
    expect(tightReason(slots[9], t)).toEqual({ load: true, delivery: false });
    expect(tightReason(slots[0], t)).toBeNull();
    expect(tightReason(slots[10], t)).toEqual({ load: false, delivery: true });
    expect(tightReason(slots[11], t)).toBeNull();
  });
  it("horas apertadas do dia da escala: 24–26 são do dia seguinte", () => {
    expect(isoWeekday("2026-10-02")).toBe(5); // sexta
    const slots = [slot(5, 18, { checkoutsDone: 90 }), slot(6, 1, { checkoutsDone: 90 }), ...Array.from({ length: 8 }, (_, i) => slot(2, i + 8, { checkoutsDone: 9 }))];
    const m = tightHoursForDay(slots, "2026-10-02", [3, 18, 25]);
    expect([...m.keys()].sort()).toEqual([18, 25]);
  });
  it("resumo em português das horas mais apertadas", () => {
    const slots = [
      slot(5, 17, { checkoutsDone: 380, checkinsDone: 90, deliveryN: 300, deliveryP75: 28 }),
      slot(5, 18, { checkoutsDone: 380, checkinsDone: 90, deliveryN: 300, deliveryP75: 28 }),
      slot(5, 19, { checkoutsDone: 380, checkinsDone: 90, deliveryN: 300, deliveryP75: 28 }),
      ...Array.from({ length: 12 }, (_, i) => slot(2, i + 6, { checkoutsDone: 18 })),
    ];
    const blocks = tightBlocks(slots, 1);
    expect(blocks[0]).toMatchObject({ weekday: 5, fromHour: 17, toHour: 20 });
    expect(describeTightBlock(blocks[0], "Lisboa")).toBe("sextas 17–20h em Lisboa: 42 saídas/h, 10 chegadas/h, entrega p75 28 min");
    expect(pressureSummary([], "Lisboa")).toEqual([]);
  });
  it("carga × entrega: tabela por escalão e leitura em português", () => {
    const rows: PressureLoadRow[] = [
      { group: "g", loadBucket: 1, rush: false, deliveryN: 40, deliveryP50: 10, deliveryP75: 14, deliveryP90: 20 },
      { group: "g", loadBucket: 4, rush: true, deliveryN: 30, deliveryP50: 20, deliveryP75: 31, deliveryP90: 45 },
      { group: "g", loadBucket: 4, rush: false, deliveryN: 2, deliveryP50: 1, deliveryP75: 1, deliveryP90: 1 },
    ];
    const t = loadComparison(rows);
    expect(t).toHaveLength(5);
    expect(t[3]).toMatchObject({ label: "11–15", rush: { deliveryP75: 31 }, rest: { deliveryN: 2 } });
    const txt = describeLoadEffect(rows);
    expect(txt[0]).toBe("Com 1–3 carros/h a entrega fica em p75 14 min; com 11–15 carros/h sobe para 31 min.");
    expect(txt[1]).toContain("p75 31 min contra 14 min");
  });
  it("âmbito de cidade dos grupos", () => {
    expect(groupAllowedForCities("marketplace", null)).toBe(true);
    expect(groupAllowedForCities("marketplace", ["lisboa"])).toBe(false);
    expect(groupAllowedForCities("cidade_lisboa", ["lisboa"])).toBe(true);
    expect(groupAllowedForCities("airpark_porto", ["lisboa"])).toBe(false);
  });
});

// ─── Extras-Dia ao vivo ─────────────────────────────────────────────────────

describe("Extras-Dia — reservas ao vivo da BD Multipark", () => {
  it("SQL: parques da cidade, sem canceladas, pré-filtro nos índices, LIMIT", () => {
    const start = Date.parse("2026-09-26T23:00:00Z");
    const { sql, params } = buildExtrasBookingsSql(start, start + 3 * 86_400_000, ["p1", "p2"]);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain(`b."status"::text <> 'CANCELLED'`);
    expect(sql).toContain('b."checkInDate" >= $5::timestamp');
    expect(sql).toContain('"BookingExtraService"');
    expect(params.slice(0, 4)).toEqual(["p1", "p2", "2026-09-26 23:00:00", "2026-09-29 23:00:00"]);
    expect(params.at(-1)).toBe(EXTRAS_LIVE_LIMIT);
    expect(() => buildExtrasBookingsSql(start, start, ["p1"])).toThrow();
  });
  it("só os parques NOSSOS da cidade", () => {
    const parks = mapParks(PARK_ROWS);
    expect(cityParks(parks, "lisbon").map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    expect(cityParks(parks, "faro")).toEqual([]);
  });
  it("sem os parques que a operação não faz (Definições)", () => {
    const parks = mapParks(PARK_ROWS);
    expect(cityParks(parks, "lisbon", ["p2"]).map((p) => p.id)).toEqual(["p1"]);
    expect(cityParks(parks, "porto", ["p3"])).toEqual([]);
    expect(cityParks(parks, "porto", []).map((p) => p.id)).toEqual(["p3"]);
  });
  it("linha → reserva → linha do Extras-Dia (hora de Lisboa, lavagens, lugar)", () => {
    const b = mapExtrasBookingRow({ id: "bk1", code: "15123", check_in: "2026-09-27 16:40:00", check_out: "2026-10-03 07:05:00", delivery_type: "Terminal 2", client_first_name: "Ana", client_last_name: "Silva", plate: "AA-00-BB", extra_names: "Lavagem exterior | Carregamento", extras_total: "25.5" }, { name: "Airpark Lisboa", cityName: "Lisboa" });
    expect(b).toMatchObject({ externalId: "bk1", spotType: "covered", extrasTotal: 25.5, extraNames: ["Lavagem exterior", "Carregamento"], parkName: "Airpark Lisboa" });
    const row = liveToBookingRow(b, 0);
    expect(row.checkIn).toBe("2026-09-27 17:40:00"); // verão: UTC+1
    expect(row.checkOut).toBe("2026-10-03 08:05:00");
    expect(row.id).toBe(-1);
    expect(row.enrichedAt).not.toBeNull();
    expect(JSON.parse(row.rawJson!).extraServices[0].name).toBe("Lavagem exterior");
    const inDay = filterRowsByField([row], "checkIn", new Date(2026, 8, 27), new Date(2026, 8, 28));
    expect(inDay).toHaveLength(1);
    expect(filterRowsByField([row], "checkOut", new Date(2026, 8, 27), new Date(2026, 8, 28))).toHaveLength(0);
  });
  it("hora de parede de Lisboa → UTC", () => {
    expect(new Date(lisbonWallToUtcMs("2026-09-27 00:00:00")).toISOString()).toBe("2026-09-26T23:00:00.000Z");
    expect(new Date(lisbonWallToUtcMs("2026-12-01 10:30:00")).toISOString()).toBe("2026-12-01T10:30:00.000Z");
  });
  it("leitura: parques + reservas; BD em baixo → indisponível e disjuntor de 1 min", async () => {
    process.env[ENV] = "postgres://u:p@h/db";
    queryMock.mockImplementation(async (sql: string) => (sql.includes('FROM "Park"') ? PARK_ROWS : [{ id: "bk1", code: "15123", check_in: "2026-09-27 16:40:00", check_out: null, park_id: "p1" }]));
    const now = Date.parse("2026-09-27T10:00:00Z");
    const r = await getLiveExtrasBookings("lisbon", now, now + 86_400_000, undefined, now);
    expect(r.available && r.data.bookings[0]).toMatchObject({ externalId: "bk1", parkName: "Airpark Lisboa" });
    expect(r.available && r.data.parks).toEqual(["Airpark Lisboa / Lisboa", "Redpark Lisboa / Lisboa"]);

    resetExtrasLiveState();
    queryMock.mockReset();
    queryMock.mockRejectedValue(new MultiparkDbError("ECONNREFUSED", "CONNECT_FAILED"));
    const down = await getLiveExtrasBookings("lisbon", now, now + 1, undefined, now);
    expect(down.available).toBe(false);
    queryMock.mockClear();
    const again = await getLiveExtrasBookings("lisbon", now, now + 1, undefined, now + 30_000);
    expect(again.available).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });
  it("leitura: um parque excluído não entra no SQL; todos excluídos → sem leitura de reservas", async () => {
    process.env[ENV] = "postgres://u:p@h/db";
    resetExtrasLiveState();
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => (sql.includes('FROM "Park"') ? PARK_ROWS : []));
    const now = Date.parse("2026-09-27T10:00:00Z");
    const r = await getLiveExtrasBookings("lisbon", now, now + 86_400_000, undefined, now, ["p2"]);
    expect(r.available && r.data.parks).toEqual(["Airpark Lisboa / Lisboa"]);
    const bookingsCall = queryMock.mock.calls.find(([sql]) => !String(sql).includes('FROM "Park"'));
    expect(bookingsCall?.[1]).toContain("p1");
    expect(bookingsCall?.[1]).not.toContain("p2");
    queryMock.mockClear();
    const porto = await getLiveExtrasBookings("porto", now, now + 86_400_000, undefined, now, ["p3"]);
    expect(porto.available && porto.data).toEqual({ bookings: [], parks: [], truncated: false });
    expect(queryMock.mock.calls.every(([sql]) => String(sql).includes('FROM "Park"'))).toBe(true);
    resetExtrasLiveState();
  });
  it("sem DATABASE_URL_MULTIPARK → indisponível (a página usa a cópia)", async () => {
    delete process.env[ENV];
    const r = await getLiveExtrasBookings("lisbon", 0, 1);
    expect(r).toMatchObject({ available: false, code: "NOT_CONFIGURED" });
  });
});

// ─── Agendador ──────────────────────────────────────────────────────────────

describe("agendador — extras-pressure", () => {
  const spec = TICK_JOBS.find((j) => j.key === "extras-pressure")!;
  const at = (iso: string) => Date.parse(iso);
  const st = (patch: Partial<JobState> = {}): JobState => ({ ...emptyState("extras-pressure"), ...patch });
  it("diário a partir das 04:45 de Lisboa", () => {
    expect(describeCadence(spec.cadence)).toBe("diário a partir das 04:45");
    expect(isDue(spec, null, at("2026-09-27T03:40:00Z")).due).toBe(false); // 04:40 Lisboa
    expect(isDue(spec, null, at("2026-09-27T03:46:00Z")).due).toBe(true); // 04:46 Lisboa
    expect(isDue(spec, null, at("2026-12-01T04:46:00Z")).due).toBe(true); // inverno
    expect(new Date(nextDueAt(spec, null, at("2026-09-27T01:00:00Z"))!).toISOString()).toBe("2026-09-27T03:45:00.000Z");
  });
  it("a meio: retoma no mesmo dia com o cursor; feito → só amanhã", () => {
    const t = at("2026-09-27T03:50:00Z");
    const cursor = formatPressureCursor("2026-09-26", 3);
    const partial = applyOutcome(spec, st(), { ok: true, done: false, cursor, error: null, startedAt: t, finishedAt: t + 40_000 });
    const d = isDue(spec, partial, t + 5 * 60_000);
    expect(d).toMatchObject({ due: true, resume: true });
    expect(cursorForRun(partial, periodKeyFor(spec.cadence, t + 5 * 60_000))).toBe(cursor);
    const done = applyOutcome(spec, partial, { ok: true, done: true, cursor: null, error: null, startedAt: t + 5 * 60_000, finishedAt: t + 6 * 60_000 });
    expect(isDue(spec, done, t + 60 * 60_000).due).toBe(false);
    expect(isDue(spec, done, at("2026-09-28T03:46:00Z")).due).toBe(true);
  });
  it("tem função no agendador, endpoint manual e migração 0235 registada", async () => {
    const { JOB_RUNNERS } = await import("./cronScheduler");
    expect(typeof JOB_RUNNERS["extras-pressure"]).toBe("function");
    const api = readFileSync(resolve(__dirname, "_core", "api-entry.ts"), "utf8");
    expect(api).toContain('app.get("/api/cron/extras-pressure"');
    expect(SCHEMA_MIGRATION_IDS).toContain("0235");
    const all = MIGRATION_0235_STATEMENTS.join("\n");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS `ops_pressure_stats`");
    expect(all).toContain("UNIQUE KEY `uq_ops_pressure_cell` (`windowEnd`, `parkGroup`, `kind`, `weekday`, `hour`, `loadBucket`, `rush`)");
    expect(all).not.toMatch(/\bDROP\b|\bDELETE\b/i);
  });
});
