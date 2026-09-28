/**
 * "Pressão" do Extras-Dia — o script que corre (trabalho `extras-pressure` do
 * agendador, diário a partir das 04:45 de Lisboa; à mão em
 * /api/cron/extras-pressure). Lê os últimos 60 dias da BD da Multipark
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
  buildPressureChunks, buildPressureLoadSql, buildPressureSlotsSql, mapPressureLoadRow, mapPressureSlotRow, pressureWindow,
  type PressureChunk, type PressureWindow,
} from "./multiparkDb/pressure";
import { addDays, lisbonDayOf } from "../shared/lisbonDay";
import { PRESSURE_WINDOW_DAYS, type PressureLoadRow, type PressureSlot } from "../shared/extrasPressure";

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
  replaceGroup(windowEnd: string, chunk: Pick<PressureChunk, "key" | "label">, slots: PressureSlot[], loads: PressureLoadRow[], computedAt: string): Promise<void>;
  /** Marca a janela como completa e apaga as antigas. */
  finish(windowEnd: string, computedAt: string): Promise<void>;
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
  async replaceGroup(windowEnd, chunk, slots, loads, computedAt) {
    const db = await dashboardDb();
    await db.execute(sql`DELETE FROM ops_pressure_stats WHERE windowEnd = ${windowEnd} AND parkGroup = ${chunk.key}`);
    const label = chunk.label.slice(0, 80);
    const values = [
      ...slots.map((s) => sql`(${windowEnd}, ${PRESSURE_WINDOW_DAYS}, ${chunk.key}, ${label}, 'slot', ${s.weekday}, ${s.hour}, 0, 0, ${s.days},
        ${s.checkinsDone}, ${s.checkoutsDone}, ${s.checkinsStarted}, ${s.checkoutsStarted}, ${s.concurrencyAvg}, ${s.concurrencyMax},
        ${s.deliveryN}, ${s.deliveryP50}, ${s.deliveryP75}, ${s.deliveryP90}, ${s.pickupN}, ${s.pickupP50}, ${s.pickupP75}, ${computedAt})`),
      ...loads.map((l) => sql`(${windowEnd}, ${PRESSURE_WINDOW_DAYS}, ${chunk.key}, ${label}, 'load', 0, 0, ${l.loadBucket}, ${l.rush ? 1 : 0}, 0,
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
  async finish(windowEnd, computedAt) {
    const db = await dashboardDb();
    await db.execute(sql`DELETE FROM ops_pressure_stats WHERE windowEnd = ${windowEnd} AND parkGroup = ${PRESSURE_DONE_GROUP}`);
    await db.execute(sql`INSERT INTO ops_pressure_stats (windowEnd, windowDays, parkGroup, groupLabel, kind, computedAt)
      VALUES (${windowEnd}, ${PRESSURE_WINDOW_DAYS}, ${PRESSURE_DONE_GROUP}, 'janela completa', 'done', ${computedAt})`);
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
}): Promise<PressureRunResult> {
  const t0 = Date.now();
  const now = o.now ?? t0;
  const windowEnd = o.windowEnd ?? defaultWindowEnd(now);
  const w: PressureWindow = pressureWindow(windowEnd);
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
      const a = buildPressureSlotsSql(w, chunk.parkIds);
      const slots = (await query(a.sql, a.params)).map((r) => mapPressureSlotRow(chunk.key, w, r)).filter((x): x is PressureSlot => !!x);
      const b = buildPressureLoadSql(w, chunk.parkIds);
      const loads = (await query(b.sql, b.params)).map((r) => mapPressureLoadRow(chunk.key, r)).filter((x): x is PressureLoadRow => !!x);
      await store.replaceGroup(windowEnd, chunk, slots, loads, computedAt);
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
    await store.finish(windowEnd, computedAt);
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
}

const numOrNull = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Linha de ops_pressure_stats → célula ou escalão. PURA. */
export function mapStoredRow(r: Record<string, unknown>): { slot?: PressureSlot; load?: PressureLoadRow } {
  const group = String(r.parkGroup ?? "");
  if (r.kind === "slot") {
    return {
      slot: {
        group, weekday: Number(r.weekday), hour: Number(r.hour), days: Number(r.days ?? 0),
        checkinsDone: Number(r.checkinsDone ?? 0), checkoutsDone: Number(r.checkoutsDone ?? 0),
        checkinsStarted: Number(r.checkinsStarted ?? 0), checkoutsStarted: Number(r.checkoutsStarted ?? 0),
        concurrencyAvg: numOrNull(r.concurrencyAvg), concurrencyMax: numOrNull(r.concurrencyMax),
        deliveryN: Number(r.deliveryN ?? 0), deliveryP50: numOrNull(r.deliveryP50), deliveryP75: numOrNull(r.deliveryP75), deliveryP90: numOrNull(r.deliveryP90),
        pickupN: Number(r.pickupN ?? 0), pickupP50: numOrNull(r.pickupP50), pickupP75: numOrNull(r.pickupP75),
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
export async function getPressureView(allowedGroups?: (key: string) => boolean): Promise<PressureView> {
  const empty: PressureView = { available: false, windowEnd: null, windowStart: null, windowDays: PRESSURE_WINDOW_DAYS, computedAt: null, groups: [], slots: [], loads: [] };
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
  const rows = rowsOf(await db.execute(sql`SELECT parkGroup, groupLabel, kind, weekday, hour, loadBucket, rush, days,
      checkinsDone, checkoutsDone, checkinsStarted, checkoutsStarted, concurrencyAvg, concurrencyMax,
      deliveryN, deliveryP50, deliveryP75, deliveryP90, pickupN, pickupP50, pickupP75
    FROM ops_pressure_stats WHERE windowEnd = ${windowEnd} AND kind IN ('slot', 'load') ORDER BY id LIMIT 20000`));
  const groups = new Map<string, string>();
  const slots: PressureSlot[] = [];
  const loads: PressureLoadRow[] = [];
  for (const r of rows) {
    const key = String(r.parkGroup ?? "");
    if (allowedGroups && !allowedGroups(key)) continue;
    if (!groups.has(key)) groups.set(key, String(r.groupLabel ?? key));
    const m = mapStoredRow(r);
    if (m.slot) slots.push(m.slot);
    if (m.load) loads.push(m.load);
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
  };
}
