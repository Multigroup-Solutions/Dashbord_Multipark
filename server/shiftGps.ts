/**
 * GPS dentro do turno — Passagem de turno → Resumo do dia (Jorge, 12 out 2026).
 *
 * Lê os pontos do Zello guardados na recolha (o MESMO GeoJSON do "Trajeto" do
 * Histórico Diário; só leitura, no servidor — o ficheiro é privado) e
 * reparte-os por quem tinha o PDA com a regra da recolha (server/zelloGps.ts →
 * splitByHolder): numa linha partida, os check-ins de PDA e, fora deles, o
 * dono do Zello; numa linha inteira, a pessoa da linha. As contas (parado no
 * turno, velocidade máxima numa entrega, excessos) são as de
 * shared/shiftDayReview.ts → gpsWindowStats.
 *
 * Custo: um ficheiro por Zello e por dia, só das pessoas pedidas. Ficam em
 * memória (por linha e recolha) e lêem-se 6 de cada vez, com prazo: o que não
 * chegar a tempo conta como falhado (o ecrã marca "incompleto"), nunca como 0.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { employeeScope } from "./cityScope";
import { gpsPointsFromGeoJson } from "./zelloGps";
import { zelloKey } from "../shared/zelloKey";
import { addDays, lisbonDayOf } from "../shared/lisbonDay";
import { gpsWindowStats, mergeGpsStats, type GpsWindowStats, type TimeWindow, type WindowPoint } from "../shared/shiftDayReview";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r) as any[]) ?? [];

/** Uma linha do Histórico Diário (um Zello num dia) com quem nos interessa nela. */
export interface GpsSource {
  id: number;
  zello: string;
  day: string;
  geoJsonUrl: string | null;
  collectedAt: string | null;
  rowEmployeeId: number | null;
  /** partida por check-ins de PDA (tem partes em driver_day_shares) */
  split: boolean;
  employeeIds: Set<number>;
}

/** Os pontos de uma pessoa num ficheiro: os pontos todos e "é dela neste instante?". */
export interface HeldPoints { day: string; points: WindowPoint[]; mine: (tsSec: number) => boolean }

/** Dias de Lisboa tocados pelas janelas. PURA. */
export function daysOfWindows(windows: readonly TimeWindow[]): string[] {
  const out = new Set<string>();
  for (const w of windows) {
    if (!(w.endMs > w.startMs)) continue;
    let d = lisbonDayOf(w.startMs);
    const last = lisbonDayOf(w.endMs - 1);
    for (let i = 0; i < 4 && d <= last; i++, d = addDays(d, 1)) out.add(d);
  }
  return [...out].sort();
}

/**
 * Quem tinha o Zello num instante, numa linha partida: o check-in de PDA
 * nesse instante e, fora deles, o dono do Zello (43b). A mesma regra da
 * recolha (splitByHolder). PURA.
 */
export function holderAtFn(intervals: ReadonlyArray<{ employeeId: number; start: number; end: number }>, fallbackEmployeeId: number | null): (tsSec: number) => number | null {
  return (tsSec) => {
    const ms = tsSec * 1000;
    for (const i of intervals) if (ms >= i.start && ms < i.end) return i.employeeId;
    return fallbackEmployeeId;
  };
}

/** Fichas pedidas que estão no âmbito de cidade de quem pede. */
export async function scopedEmployeeIds(ids: readonly number[]): Promise<number[]> {
  const db = await getDb();
  const clean = Array.from(new Set(ids.filter((x) => Number.isSafeInteger(x) && x > 0))).slice(0, 300);
  if (!db || !clean.length) return [];
  const rows = rowsOf(await db.execute(sql`SELECT e.id FROM employees e
    WHERE e.id IN (${sql.join(clean.map((x) => sql`${x}`), sql`, `)}) AND ${employeeScope(sql`e.id`)}`));
  return rows.map((r) => Number(r.id));
}

/** As linhas do Histórico Diário destas pessoas nestes dias (partes, linhas inteiras e o Zello fixo). */
export async function gpsSourcesFor(employeeIds: readonly number[], days: readonly string[]): Promise<GpsSource[]> {
  const db = await getDb();
  if (!db || !employeeIds.length || !days.length) return [];
  const ids = sql.join(employeeIds.map((x) => sql`${x}`), sql`, `);
  const dayList = sql.join(days.map((d) => sql`${d}`), sql`, `);
  const out = new Map<number, GpsSource>();
  const add = (r: any, emp: number, split: boolean) => {
    const id = Number(r.id);
    let s = out.get(id);
    if (!s) {
      s = { id, zello: String(r.zelloUsername ?? ""), day: String(r.day), geoJsonUrl: r.geoJsonUrl ? String(r.geoJsonUrl) : null, collectedAt: r.collectedAt ? String(r.collectedAt) : null, rowEmployeeId: r.rowEmployeeId != null ? Number(r.rowEmployeeId) : null, split, employeeIds: new Set() };
      out.set(id, s);
    }
    s.split = s.split || split;
    s.employeeIds.add(emp);
  };
  const cols = sql`h.id, h.zelloUsername, DATE_FORMAT(h.date, '%Y-%m-%d') AS day, h.geoJsonUrl, DATE_FORMAT(h.collectedAt, '%Y-%m-%d %H:%i:%s') AS collectedAt, h.employeeId AS rowEmployeeId`;
  // 1. partes (PDA partilhado partido por quem o tinha)
  try {
    for (const r of rowsOf(await db.execute(sql`SELECT DISTINCT s.employeeId AS emp, ${cols}
        FROM driver_day_shares s JOIN daily_driver_history h ON h.id = s.historyId
       WHERE s.day IN (${dayList}) AND s.employeeId IN (${ids}) AND ${employeeScope(sql`s.employeeId`)}`))) add(r, Number(r.emp), true);
  } catch { /* tabela das partes ainda por criar */ }
  // 2. linhas inteiras da pessoa (sem partes)
  for (const r of rowsOf(await db.execute(sql`SELECT h.employeeId AS emp, ${cols}
      FROM daily_driver_history h
     WHERE DATE(h.date) IN (${dayList}) AND h.employeeId IN (${ids}) AND ${employeeScope(sql`h.employeeId`)}
       AND NOT EXISTS (SELECT 1 FROM driver_day_shares s WHERE s.historyId = h.id)`))) add(r, Number(r.emp), false);
  // 3. o Zello fixo da pessoa (43b): numa linha partida, fica com o que o PDA fez fora dos check-ins
  const { fixedZelloOwners } = await import("./db");
  const owners = await fixedZelloOwners().catch(() => new Map<string, number>());
  const wanted = new Set(employeeIds);
  const owned = new Map<string, number>();
  for (const [k, emp] of owners) if (wanted.has(emp)) owned.set(k, emp);
  if (owned.size) {
    try {
      for (const r of rowsOf(await db.execute(sql`SELECT ${cols} FROM daily_driver_history h
          WHERE DATE(h.date) IN (${dayList}) AND EXISTS (SELECT 1 FROM driver_day_shares s WHERE s.historyId = h.id)`))) {
        const emp = owned.get(zelloKey(r.zelloUsername));
        if (emp != null) add(r, emp, true);
      }
    } catch { /* sem partes */ }
  }
  return [...out.values()].sort((a, b) => a.id - b.id);
}

// ─── Pontos (com memória) ───────────────────────────────────────────────────

const POINTS_CACHE_MAX = 150;
const POINTS_TTL_MS = 30 * 60_000;
const pointsCache = new Map<string, { at: number; points: WindowPoint[] }>();

/** Esquece os pontos guardados em memória (testes). */
export function resetGpsPointsCache(): void { pointsCache.clear(); }

async function loadPoints(src: GpsSource): Promise<WindowPoint[]> {
  if (!src.geoJsonUrl) return [];
  const key = `${src.id}|${src.collectedAt ?? ""}|${src.geoJsonUrl}`;
  const hit = pointsCache.get(key);
  if (hit && Date.now() - hit.at < POINTS_TTL_MS) {
    pointsCache.delete(key); pointsCache.set(key, hit); // LRU
    return hit.points;
  }
  const { storageReadableUrl } = await import("./storageSign");
  const res = await fetch(await storageReadableUrl(src.geoJsonUrl), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const points = gpsPointsFromGeoJson(await res.json()).map((p) => ({ ts: p.ts, speed: p.speed, accurate: p.accurate }));
  pointsCache.set(key, { at: Date.now(), points });
  while (pointsCache.size > POINTS_CACHE_MAX) pointsCache.delete(pointsCache.keys().next().value as string);
  return points;
}

/** Corre `fn` sobre a lista, `limit` de cada vez. */
async function pool<T>(items: readonly T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const run = async () => { while (i < items.length) { const x = items[i++]; await fn(x); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

export interface HeldPointsResult {
  byEmp: Map<number, HeldPoints[]>;
  /** ficheiros que não se leram (erro ou prazo), por pessoa */
  failed: Map<number, number>;
  /** dias com recolha GPS feita (alguma linha) */
  collectedDays: Set<string>;
}

/**
 * Os pontos de cada pessoa nos dias pedidos (por pessoa: os dias que lhe
 * interessam), já com "é dela neste instante?". Lê cada ficheiro uma vez.
 */
export async function heldPointsFor(daysByEmp: ReadonlyMap<number, readonly string[]>, o: { deadlineAt: number }): Promise<HeldPointsResult> {
  const result: HeldPointsResult = { byEmp: new Map(), failed: new Map(), collectedDays: new Set() };
  const emps = [...daysByEmp.keys()];
  const allDays = Array.from(new Set([...daysByEmp.values()].flat())).sort();
  if (!emps.length || !allDays.length) return result;
  const db = await getDb();
  if (!db) return result;
  for (const r of rowsOf(await db.execute(sql`SELECT DISTINCT DATE_FORMAT(date, '%Y-%m-%d') AS d FROM daily_driver_history
      WHERE DATE(date) IN (${sql.join(allDays.map((d) => sql`${d}`), sql`, `)})`))) result.collectedDays.add(String(r.d));
  const sources = (await gpsSourcesFor(emps, allDays))
    .map((s) => ({ ...s, employeeIds: new Set([...s.employeeIds].filter((e) => daysByEmp.get(e)?.includes(s.day))) }))
    .filter((s) => s.employeeIds.size > 0);
  if (!sources.length) return result;
  const { pdaIntervalsForDay, fixedZelloOwners } = await import("./db");
  const splitDays = Array.from(new Set(sources.filter((s) => s.split).map((s) => s.day)));
  const intervalsByDay = new Map(await Promise.all(splitDays.map(async (d) => [d, await pdaIntervalsForDay(d)] as const)));
  const owners = splitDays.length ? await fixedZelloOwners().catch(() => new Map<string, number>()) : new Map<string, number>();
  await pool(sources, 6, async (src) => {
    let points: WindowPoint[];
    try {
      if (Date.now() > o.deadlineAt) throw new Error("prazo");
      points = await loadPoints(src);
    } catch (err) {
      console.warn(`[shiftGps] ${src.zello} ${src.day}:`, String((err as Error)?.message ?? err).slice(0, 120));
      for (const e of src.employeeIds) result.failed.set(e, (result.failed.get(e) ?? 0) + 1);
      return;
    }
    const holderAt = src.split
      ? holderAtFn(intervalsByDay.get(src.day)?.get(zelloKey(src.zello)) ?? [], owners.get(zelloKey(src.zello)) ?? null)
      : null;
    for (const e of src.employeeIds) {
      const mine = holderAt ? (ts: number) => holderAt(ts) === e : () => src.rowEmployeeId === e;
      result.byEmp.set(e, [...(result.byEmp.get(e) ?? []), { day: src.day, points, mine }]);
    }
  });
  return result;
}

/** As contas do GPS de uma pessoa dentro das janelas (todos os ficheiros dela). PURA. */
export function heldStats(held: readonly HeldPoints[] | undefined, windows: readonly TimeWindow[], threshold: number | null, minPoints?: number): GpsWindowStats {
  return mergeGpsStats((held ?? []).map((h) => gpsWindowStats(h.points, windows, { threshold, mine: h.mine, minPoints })));
}
