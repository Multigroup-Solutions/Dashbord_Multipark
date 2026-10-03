/**
 * "Pressão" do Extras-Dia — o script que corre (trabalho `extras-pressure` do
 * agendador, diário a partir das 04:45 de Lisboa; à mão em
 * /api/cron/extras-pressure). Lê a BD da Multipark desde `extras.timesSince`
 * (22d: 3 abr 2026; a janela cresce e nunca encolhe) — e, nas cidades, os
 * tempos por condutor (passos "driver", no fim)
 * (agregação no Postgres, server/multiparkDb/pressure.ts), um pedaço (grupo
 * de parques) de cada vez, e guarda o resultado na NOSSA BD
 * (ops_pressure_stats, migração 0235). Retomável: o cursor diz a janela
 * (dia final) e o próximo pedaço; um pedaço só arranca com tempo.
 *
 * Os "Parques que a operação não faz" (Definições → operations.excludedParks,
 * passados pelo cron) ficam fora de todos os grupos.
 *
 * A página lê sempre a última janela COMPLETA (a que tem a linha-marca
 * `_done`), por isso uma corrida a meio nunca mostra dados misturados.
 */
import { sql } from "drizzle-orm";
import { multiparkDbQuery, redactSecrets, type SqlParam } from "./multiparkDb/client";
import { describeReadFailure } from "./multiparkDb/read";
import { buildParksSql, mapParks } from "./multiparkDb/dayBookings";
import { excludeParks } from "../shared/reservasDoDia";
import {
  buildPressureChunks, buildPressureCrewSql, buildPressureDriverSlotsSql, buildPressureLoadSql, buildPressureSlotsSql,
  mapPressureCrewRow, mapPressureDriverRow, mapPressureLoadRow, mapPressureSlotRow, pressureWindowSince,
  type PressureChunk, type PressureWindow,
} from "./multiparkDb/pressure";
import { addDays, lisbonDayOf } from "../shared/lisbonDay";
import {
  PRESSURE_SINCE_DEFAULT, PRESSURE_WINDOW_DAYS, crewMeasureBands,
  type CrewMeasureBand, type CyclePercentile, type PressureCrewRow, type PressureLoadRow, type PressureSlot,
} from "../shared/extrasPressure";
import { DEFAULT_CREW_RULES, DEFAULT_TIMES_PERCENTILE, type CrewRulesMap, type TimesPercentileMap } from "../shared/appSettings";

type DriverRow = NonNullable<ReturnType<typeof mapPressureDriverRow>>;
/** Cidade do grupo (lisboa/porto/faro) → cidade do Extras-dia. */
const extraCityOf = (city: string | undefined): "lisbon" | "porto" | "faro" => (city === "porto" ? "porto" : city === "faro" ? "faro" : "lisbon");
/** Dias da janela. */
const windowDaysOf = (w: PressureWindow) => Object.values(w.weekdayDays).reduce((a, b) => a + b, 0);

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

/** Um pedaço só arranca com pelo menos isto até ao prazo (2 leituras ≤ 15 s cada, normalmente < 2 s). */
export const PRESSURE_CHUNK_MIN_MS = 12_000;
/** Janelas guardadas para trás (as mais antigas apagam-se). */
export const PRESSURE_KEEP_DAYS = 14;
/** Grupo-marca: a janela está completa. */
export const PRESSURE_DONE_GROUP = "_done";

// ─── Cursor ─────────────────────────────────────────────────────────────────

export interface PressureCursor { w: string; i: number }

/** Cursor → próximo pedaço (só vale para a mesma janela; outra janela = do início). PURA. */
export function parsePressureCursor(raw: string | null | undefined, windowEnd: string): number {
  if (!raw) return 0;
  try {
    const v = JSON.parse(raw);
    if (v && v.w === windowEnd && Number.isInteger(v.i) && v.i >= 0 && v.i < 1000) return v.i;
  } catch { /* cursor antigo/estragado → do início */ }
  return 0;
}

export function formatPressureCursor(windowEnd: string, nextIndex: number): string {
  return JSON.stringify({ w: windowEnd, i: nextIndex } satisfies PressureCursor);
}

/** Janela por omissão: acaba ontem (Lisboa). PURA. */
export function defaultWindowEnd(now: number): string {
  return addDays(lisbonDayOf(now), -1);
}

// ─── Gravação ───────────────────────────────────────────────────────────────

export interface PressureStore {
  /** Substitui as linhas de um grupo numa janela. */
  replaceGroup(windowEnd: string, chunk: Pick<PressureChunk, "key" | "label">, slots: PressureSlot[], loads: PressureLoadRow[], computedAt: string, windowDays?: number): Promise<void>;
  /** 22d: junta os tempos por condutor às células da cidade e substitui os escalões de pessoas. */
  upsertDriver(windowEnd: string, chunk: Pick<PressureChunk, "key" | "label">, w: PressureWindow, drivers: DriverRow[], crew: PressureCrewRow[], computedAt: string): Promise<void>;
  /** Marca a janela como completa e apaga as antigas. */
  finish(windowEnd: string, computedAt: string, windowDays?: number): Promise<void>;
}

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const utcNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");

async function dashboardDb() {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) throw new Error("BD do dashboard indisponível.");
  return db;
}

export const mysqlPressureStore: PressureStore = {
  async replaceGroup(windowEnd, chunk, slots, loads, computedAt, windowDays = PRESSURE_WINDOW_DAYS) {
    const db = await dashboardDb();
    await db.execute(sql`DELETE FROM ops_pressure_stats WHERE windowEnd = ${windowEnd} AND parkGroup = ${chunk.key}`);
    const label = chunk.label.slice(0, 80);
    const values = [
      ...slots.map((s) => sql`(${windowEnd}, ${windowDays}, ${chunk.key}, ${label}, 'slot', ${s.weekday}, ${s.hour}, 0, 0, ${s.days},
        ${s.checkinsDone}, ${s.checkoutsDone}, ${s.checkinsStarted}, ${s.checkoutsStarted}, ${s.concurrencyAvg}, ${s.concurrencyMax},
        ${s.deliveryN}, ${s.deliveryP50}, ${s.deliveryP75}, ${s.deliveryP90}, ${s.pickupN}, ${s.pickupP50}, ${s.pickupP75}, ${computedAt})`),
      ...loads.map((l) => sql`(${windowEnd}, ${windowDays}, ${chunk.key}, ${label}, 'load', 0, 0, ${l.loadBucket}, ${l.rush ? 1 : 0}, 0,
        0, 0, 0, 0, NULL, NULL,
        ${l.deliveryN}, ${l.deliveryP50}, ${l.deliveryP75}, ${l.deliveryP90}, 0, NULL, NULL, ${computedAt})`),
    ];
    for (let i = 0; i < values.length; i += 200) {
      await db.execute(sql`INSERT INTO ops_pressure_stats (windowEnd, windowDays, parkGroup, groupLabel, kind, weekday, hour, loadBucket, rush, days,
        checkinsDone, checkoutsDone, checkinsStarted, checkoutsStarted, concurrencyAvg, concurrencyMax,
        deliveryN, deliveryP50, deliveryP75, deliveryP90, pickupN, pickupP50, pickupP75, computedAt)
        VALUES ${sql.join(values.slice(i, i + 200), sql`, `)}`);
    }
  },
  async upsertDriver(windowEnd, chunk, w, drivers, crew, computedAt) {
    const db = await dashboardDb();
    const label = chunk.label.replace(/ \(condutores\)$/, " (todas as marcas)").slice(0, 80);
    const days = windowDaysOf(w);
    for (const d of drivers) {
      // A célula da cidade já existe (passo do grupo, antes): só os campos por condutor. Sem ela, cria-se.
      await db.execute(sql`INSERT INTO ops_pressure_stats (windowEnd, windowDays, parkGroup, groupLabel, kind, weekday, hour, loadBucket, rush, days,
          cycleN, cycleP50, cycleP60, cycleP75, cycleP85, cycleP90, driveN, driveP50, driveP75, driveP90, toParkN, toParkP50, toParkP75, crewAvg, computedAt)
        VALUES (${windowEnd}, ${days}, ${chunk.key}, ${label}, 'slot', ${d.weekday}, ${d.hour}, 0, 0, ${w.weekdayDays[d.weekday] ?? 0},
          ${d.cycleN}, ${d.cycleP50}, ${d.cycleP60}, ${d.cycleP75}, ${d.cycleP85}, ${d.cycleP90}, ${d.driveN}, ${d.driveP50}, ${d.driveP75}, ${d.driveP90},
          ${d.toParkN}, ${d.toParkP50}, ${d.toParkP75}, ${d.crewAvg}, ${computedAt})
        ON DUPLICATE KEY UPDATE cycleN = VALUES(cycleN), cycleP50 = VALUES(cycleP50), cycleP60 = VALUES(cycleP60), cycleP75 = VALUES(cycleP75),
          cycleP85 = VALUES(cycleP85), cycleP90 = VALUES(cycleP90), driveN = VALUES(driveN), driveP50 = VALUES(driveP50), driveP75 = VALUES(driveP75),
          driveP90 = VALUES(driveP90), toParkN = VALUES(toParkN), toParkP50 = VALUES(toParkP50), toParkP75 = VALUES(toParkP75), crewAvg = VALUES(crewAvg)`);
    }
    // Escalões: estatística derivada, refeita inteira em cada corrida.
    await db.execute(sql`DELETE FROM ops_pressure_stats WHERE windowEnd = ${windowEnd} AND parkGroup = ${chunk.key} AND kind = 'crew'`);
    for (const c of crew) {
      await db.execute(sql`INSERT INTO ops_pressure_stats (windowEnd, windowDays, parkGroup, groupLabel, kind, weekday, hour, loadBucket, rush, days,
          bandLabel, cycleN, cycleP50, cycleP60, cycleP75, cycleP85, cycleP90, computedAt)
        VALUES (${windowEnd}, ${days}, ${chunk.key}, ${label}, 'crew', 0, 0, ${c.band}, ${c.busy ? 1 : 0}, 0,
          ${c.bandLabel}, ${c.n}, ${c.p50}, ${c.p60}, ${c.p75}, ${c.p85}, ${c.p90}, ${computedAt})`);
    }
  },
  async finish(windowEnd, computedAt, windowDays = PRESSURE_WINDOW_DAYS) {
    const db = await dashboardDb();
    await db.execute(sql`DELETE FROM ops_pressure_stats WHERE windowEnd = ${windowEnd} AND parkGroup = ${PRESSURE_DONE_GROUP}`);
    await db.execute(sql`INSERT INTO ops_pressure_stats (windowEnd, windowDays, parkGroup, groupLabel, kind, computedAt)
      VALUES (${windowEnd}, ${windowDays}, ${PRESSURE_DONE_GROUP}, 'janela completa', 'done', ${computedAt})`);
    await db.execute(sql`DELETE FROM ops_pressure_stats WHERE windowEnd < ${addDays(windowEnd, -PRESSURE_KEEP_DAYS)}`);
  },
};

// ─── Corrida ────────────────────────────────────────────────────────────────

export interface PressureRunResult {
  ok: boolean;
  done: boolean;
  skipped?: string;
  error?: string;
  windowEnd: string;
  windowStart: string;
  chunks: number;
  processed: string[];
  failed: Array<{ group: string; error: string }>;
  nextIndex: number;
  cursor: string | null;
  slots: number;
  loadRows: number;
  ms: number;
}

/**
 * Corre os pedaços a partir do cursor até acabarem ou faltar tempo. Um pedaço
 * que falha (ex.: tempo esgotado na BD da Multipark) fica registado e segue-se
 * para o seguinte — a janela fica completa na mesma, com esse grupo em falta,
 * e a corrida sai vermelha. Nunca lança por causa da BD da Multipark.
 */
export async function runExtrasPressure(o: {
  deadlineAt: number;
  cursor?: string | null;
  now?: number;
  windowEnd?: string;
  query?: Query;
  store?: PressureStore;
  isConfigured?: () => boolean;
  /** "Parques que a operação não faz" (Definições): ficam fora de todos os grupos. */
  excludedParkIds?: readonly string[];
  /** 22d: início da medição (Definições → extras.timesSince). */
  since?: string | null;
  /** 22d: tabela máxima por cidade (D12) — dá os escalões de pessoas. */
  crewRules?: CrewRulesMap | null;
}): Promise<PressureRunResult> {
  const t0 = Date.now();
  const now = o.now ?? t0;
  const windowEnd = o.windowEnd ?? defaultWindowEnd(now);
  const w: PressureWindow = pressureWindowSince(o.since ?? PRESSURE_SINCE_DEFAULT, windowEnd);
  const windowDays = windowDaysOf(w);
  const crewRules = o.crewRules ?? DEFAULT_CREW_RULES;
  const query = o.query ?? multiparkDbQuery;
  const store = o.store ?? mysqlPressureStore;
  const base: PressureRunResult = { ok: true, done: true, windowEnd, windowStart: w.startDay, chunks: 0, processed: [], failed: [], nextIndex: 0, cursor: null, slots: 0, loadRows: 0, ms: 0 };
  const configured = o.isConfigured ?? (() => !!String(process.env.DATABASE_URL_MULTIPARK ?? "").trim());
  if (!configured()) return { ...base, skipped: "DATABASE_URL_MULTIPARK não está definida neste ambiente.", ms: Date.now() - t0 };

  let chunks: PressureChunk[];
  try {
    const ps = buildParksSql();
    chunks = buildPressureChunks(excludeParks(mapParks(await query(ps.sql, ps.params)), o.excludedParkIds));
  } catch (err) {
    const f = describeReadFailure(err);
    console.warn("[extras-pressure] parques:", redactSecrets(err).slice(0, 200));
    return { ...base, ok: false, done: false, error: f.reason, cursor: formatPressureCursor(windowEnd, parsePressureCursor(o.cursor, windowEnd)), ms: Date.now() - t0 };
  }
  let i = parsePressureCursor(o.cursor, windowEnd);
  const out: PressureRunResult = { ...base, chunks: chunks.length, nextIndex: i };
  const computedAt = utcNow();
  while (i < chunks.length) {
    if (o.deadlineAt - Date.now() < PRESSURE_CHUNK_MIN_MS) break;
    const chunk = chunks[i];
    try {
      if (chunk.kind === "driver") {
        const bands: CrewMeasureBand[] = crewMeasureBands(crewRules[extraCityOf(chunk.city)] ?? DEFAULT_CREW_RULES[extraCityOf(chunk.city)]);
        const d = buildPressureDriverSlotsSql(w, chunk.parkIds);
        const drivers = (await query(d.sql, d.params)).map(mapPressureDriverRow).filter((x): x is DriverRow => !!x);
        const k = buildPressureCrewSql(w, chunk.parkIds, bands);
        const crew = (await query(k.sql, k.params)).map((r) => mapPressureCrewRow(chunk.key, bands, r)).filter((x): x is PressureCrewRow => !!x);
        await store.upsertDriver(windowEnd, chunk, w, drivers, crew, computedAt);
        out.processed.push(`${chunk.key}:condutores`);
        i++;
        continue;
      }
      const a = buildPressureSlotsSql(w, chunk.parkIds);
      const slots = (await query(a.sql, a.params)).map((r) => mapPressureSlotRow(chunk.key, w, r)).filter((x): x is PressureSlot => !!x);
      const b = buildPressureLoadSql(w, chunk.parkIds);
      const loads = (await query(b.sql, b.params)).map((r) => mapPressureLoadRow(chunk.key, r)).filter((x): x is PressureLoadRow => !!x);
      await store.replaceGroup(windowEnd, chunk, slots, loads, computedAt, windowDays);
      out.processed.push(chunk.key);
      out.slots += slots.length;
      out.loadRows += loads.length;
    } catch (err) {
      const msg = err && (err as any).name === "MultiparkDbError" ? describeReadFailure(err).reason : redactSecrets(err).slice(0, 200);
      console.warn(`[extras-pressure] ${chunk.key}:`, redactSecrets(err).slice(0, 200));
      out.failed.push({ group: chunk.key, error: msg });
    }
    i++;
  }
  out.nextIndex = i;
  out.done = i >= chunks.length;
  if (out.done) {
    await store.finish(windowEnd, computedAt, windowDays);
    out.cursor = null;
  } else {
    out.cursor = formatPressureCursor(windowEnd, i);
  }
  if (out.failed.length) {
    out.ok = false;
    out.error = `Grupos com falha: ${out.failed.map((f) => `${f.group} (${f.error})`).join("; ").slice(0, 400)}`;
  }
  out.ms = Date.now() - t0;
  return out;
}

// ─── Leitura para a página ──────────────────────────────────────────────────

export interface PressureView {
  available: boolean;
  windowEnd: string | null;
  windowStart: string | null;
  windowDays: number;
  computedAt: string | null;
  groups: Array<{ key: string; label: string }>;
  slots: PressureSlot[];
  loads: PressureLoadRow[];
  /** 22d: condutor por carro por escalão de pessoas × hora cheia (cidades). */
  crew: PressureCrewRow[];
  /** 22d: por grupo-cidade — percentil usado e escalões com o máximo da tabela (D12). */
  cities: Record<string, { city: "lisbon" | "porto" | "faro"; percentile: CyclePercentile; bands: CrewMeasureBand[]; useMeasured?: boolean }>;
}

const numOrNull = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Linha de ops_pressure_stats → célula ou escalão. PURA. */
export function mapStoredRow(r: Record<string, unknown>): { slot?: PressureSlot; load?: PressureLoadRow; crew?: PressureCrewRow } {
  const group = String(r.parkGroup ?? "");
  if (r.kind === "crew") {
    return {
      crew: {
        group, band: Number(r.loadBucket ?? 0), bandLabel: String(r.bandLabel ?? ""), busy: Number(r.rush) === 1,
        n: Number(r.cycleN ?? 0), p50: numOrNull(r.cycleP50), p60: numOrNull(r.cycleP60), p75: numOrNull(r.cycleP75), p85: numOrNull(r.cycleP85), p90: numOrNull(r.cycleP90),
      },
    };
  }
  if (r.kind === "slot") {
    return {
      slot: {
        group, weekday: Number(r.weekday), hour: Number(r.hour), days: Number(r.days ?? 0),
        checkinsDone: Number(r.checkinsDone ?? 0), checkoutsDone: Number(r.checkoutsDone ?? 0),
        checkinsStarted: Number(r.checkinsStarted ?? 0), checkoutsStarted: Number(r.checkoutsStarted ?? 0),
        concurrencyAvg: numOrNull(r.concurrencyAvg), concurrencyMax: numOrNull(r.concurrencyMax),
        deliveryN: Number(r.deliveryN ?? 0), deliveryP50: numOrNull(r.deliveryP50), deliveryP75: numOrNull(r.deliveryP75), deliveryP90: numOrNull(r.deliveryP90),
        pickupN: Number(r.pickupN ?? 0), pickupP50: numOrNull(r.pickupP50), pickupP75: numOrNull(r.pickupP75),
        cycleN: Number(r.cycleN ?? 0), cycleP50: numOrNull(r.cycleP50), cycleP60: numOrNull(r.cycleP60), cycleP75: numOrNull(r.cycleP75),
        cycleP85: numOrNull(r.cycleP85), cycleP90: numOrNull(r.cycleP90),
        driveN: Number(r.driveN ?? 0), driveP50: numOrNull(r.driveP50), driveP75: numOrNull(r.driveP75), driveP90: numOrNull(r.driveP90),
        toParkN: Number(r.toParkN ?? 0), toParkP50: numOrNull(r.toParkP50), toParkP75: numOrNull(r.toParkP75), crewAvg: numOrNull(r.crewAvg),
      },
    };
  }
  if (r.kind === "load") {
    return {
      load: {
        group, loadBucket: Number(r.loadBucket), rush: Number(r.rush) === 1,
        deliveryN: Number(r.deliveryN ?? 0), deliveryP50: numOrNull(r.deliveryP50), deliveryP75: numOrNull(r.deliveryP75), deliveryP90: numOrNull(r.deliveryP90),
      },
    };
  }
  return {};
}

/** Última janela completa (ou, sem nenhuma completa, a mais recente). `groups` limita (âmbito de cidade). */
export async function getPressureView(allowedGroups?: (key: string) => boolean, o: { crewRules?: CrewRulesMap | null; percentiles?: TimesPercentileMap | null; useMeasured?: Partial<Record<"lisbon" | "porto" | "faro", boolean>> | null } = {}): Promise<PressureView> {
  const crewRules = o.crewRules ?? DEFAULT_CREW_RULES;
  const percentiles = o.percentiles ?? DEFAULT_TIMES_PERCENTILE;
  const cities: PressureView["cities"] = {};
  for (const [key, city] of [["cidade_lisboa", "lisbon"], ["cidade_porto", "porto"], ["cidade_faro", "faro"]] as const) {
    if (allowedGroups && !allowedGroups(key)) continue;
    cities[key] = { city, percentile: percentiles[city] as CyclePercentile, bands: crewMeasureBands(crewRules[city] ?? DEFAULT_CREW_RULES[city]), useMeasured: o.useMeasured?.[city] === true };
  }
  const empty: PressureView = { available: false, windowEnd: null, windowStart: null, windowDays: PRESSURE_WINDOW_DAYS, computedAt: null, groups: [], slots: [], loads: [], crew: [], cities };
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) return empty;
  let latest: any;
  try {
    latest = rowsOf(await db.execute(sql`SELECT DATE_FORMAT(windowEnd, '%Y-%m-%d') AS w, windowDays AS d, DATE_FORMAT(computedAt, '%Y-%m-%d %H:%i:%s') AS c
      FROM ops_pressure_stats WHERE parkGroup = ${PRESSURE_DONE_GROUP} ORDER BY windowEnd DESC LIMIT 1`))[0]
      ?? rowsOf(await db.execute(sql`SELECT DATE_FORMAT(windowEnd, '%Y-%m-%d') AS w, windowDays AS d, DATE_FORMAT(MAX(computedAt), '%Y-%m-%d %H:%i:%s') AS c
      FROM ops_pressure_stats GROUP BY windowEnd, windowDays ORDER BY windowEnd DESC LIMIT 1`))[0];
  } catch (err: any) {
    // Tabela ainda não criada (arranque sem a migração 0235).
    console.warn("[extras-pressure] leitura:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
    return empty;
  }
  if (!latest?.w) return empty;
  const windowEnd = String(latest.w);
  const windowDays = Number(latest.d ?? PRESSURE_WINDOW_DAYS) || PRESSURE_WINDOW_DAYS;
  let rows: any[];
  try {
    rows = rowsOf(await db.execute(sql`SELECT parkGroup, groupLabel, kind, weekday, hour, loadBucket, rush, days,
        checkinsDone, checkoutsDone, checkinsStarted, checkoutsStarted, concurrencyAvg, concurrencyMax,
        deliveryN, deliveryP50, deliveryP75, deliveryP90, pickupN, pickupP50, pickupP75,
        cycleN, cycleP50, cycleP60, cycleP75, cycleP85, cycleP90, driveN, driveP50, driveP75, driveP90, toParkN, toParkP50, toParkP75, crewAvg, bandLabel
      FROM ops_pressure_stats WHERE windowEnd = ${windowEnd} AND kind IN ('slot', 'load', 'crew') ORDER BY id LIMIT 20000`));
  } catch {
    // Sem as colunas da migração 0430 (arranque a meio): como antes.
    rows = rowsOf(await db.execute(sql`SELECT parkGroup, groupLabel, kind, weekday, hour, loadBucket, rush, days,
        checkinsDone, checkoutsDone, checkinsStarted, checkoutsStarted, concurrencyAvg, concurrencyMax,
        deliveryN, deliveryP50, deliveryP75, deliveryP90, pickupN, pickupP50, pickupP75
      FROM ops_pressure_stats WHERE windowEnd = ${windowEnd} AND kind IN ('slot', 'load') ORDER BY id LIMIT 20000`));
  }
  const groups = new Map<string, string>();
  const slots: PressureSlot[] = [];
  const loads: PressureLoadRow[] = [];
  const crew: PressureCrewRow[] = [];
  for (const r of rows) {
    const key = String(r.parkGroup ?? "");
    if (allowedGroups && !allowedGroups(key)) continue;
    if (!groups.has(key)) groups.set(key, String(r.groupLabel ?? key));
    const m = mapStoredRow(r);
    if (m.slot) slots.push(m.slot);
    if (m.load) loads.push(m.load);
    if (m.crew) crew.push(m.crew);
  }
  return {
    available: true,
    windowEnd,
    windowStart: addDays(windowEnd, -(windowDays - 1)),
    windowDays,
    computedAt: latest.c ? String(latest.c) : null,
    groups: Array.from(groups, ([key, label]) => ({ key, label })),
    slots,
    loads,
    crew,
    cities,
  };
}

// ─── 26c: escalões medidos para a escala ─────────────────────────────────────

const CREW_ROWS_CACHE_MS = 5 * 60_000;
let crewRowsCache: { at: number; rows: PressureCrewRow[] } | null = null;

/**
 * Escalões medidos (kind 'crew', todas as cidades) da última janela completa,
 * para a escala usar os tempos medidos (26c). Cache de 5 min no processo (a
 * previsão corre muitas vezes). Falha a ler / sem tabela / sem janela → []
 * (a escala usa a tabela). Nunca lança.
 */
export async function loadLatestCrewRows(): Promise<PressureCrewRow[]> {
  if (crewRowsCache && Date.now() - crewRowsCache.at < CREW_ROWS_CACHE_MS) return crewRowsCache.rows;
  let rows: PressureCrewRow[] = [];
  try {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (db) {
      const latest = rowsOf(await db.execute(sql`SELECT DATE_FORMAT(windowEnd, '%Y-%m-%d') AS w
        FROM ops_pressure_stats WHERE parkGroup = ${PRESSURE_DONE_GROUP} ORDER BY windowEnd DESC LIMIT 1`))[0];
      if (latest?.w) {
        const raw = rowsOf(await db.execute(sql`SELECT parkGroup, kind, loadBucket, rush, bandLabel, cycleN, cycleP50, cycleP60, cycleP75, cycleP85, cycleP90
          FROM ops_pressure_stats WHERE windowEnd = ${String(latest.w)} AND kind = 'crew' ORDER BY id LIMIT 500`));
        rows = raw.map((r) => mapStoredRow(r).crew).filter((c): c is PressureCrewRow => !!c);
      }
    }
  } catch (err: any) {
    console.warn("[extras-pressure] escalões medidos:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
    rows = [];
  }
  crewRowsCache = { at: Date.now(), rows };
  return rows;
}
