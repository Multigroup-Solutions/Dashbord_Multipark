/**
 * Tempos por condutor (Q7, Jorge 14 out 2026: "se durante 6 meses os colegas
 * entregam todos entre 13 e 17 min e ele entrega sempre com 20 a 30, é
 * importante saber"). Em Condutores e agentes → condutor e no Desempenho:
 * médias e percentis de UM condutor por semana, mês e 6 meses — Fila,
 * Trânsito, Cliente, no terminal e P2 — ao lado dos colegas da MESMA cidade e
 * do MESMO tipo de serviço (T1, T2, VIP, Outro), e a evolução para o gráfico.
 * Só informação: NÃO dá pontos. Abaixo do n mínimo: "sem dados suficientes"
 * (nunca 0). Os tempos com GPS passam pelo portão (§8.1) por cidade e período,
 * sempre com `{ gate, isSuperAdmin }` — as contas são as de shared/serviceTimes.ts
 * (driverTimeStats / driverTimeSeries).
 */
import { sql } from "drizzle-orm";
import { addDays } from "../shared/lisbonDay";
import {
  DRIVER_METRICS, DRIVER_STATS_MIN_N, driverPeriodRange, driverTimeSeries, driverTimeStats,
  type DriverMetric, type DriverStat, type GpsGate,
} from "../shared/serviceTimes";
import type { ServiceRow } from "./serviceTimesAgg";

/** Os tempos do ecrã (Q7). */
export const DRIVER_SCREEN_METRICS: readonly DriverMetric[] = ["fila", "transito", "cliente", "terminal", "p2"];
export type DriverPeriod = "semana" | "mes" | "6meses";
export const DRIVER_PERIODS: readonly DriverPeriod[] = ["semana", "mes", "6meses"];
/** Semanas no gráfico semanal (≈ 6 meses). */
export const DRIVER_SERIES_WEEKS = 26;

export interface DriverMetricView {
  metric: DriverMetric;
  label: string;
  kind: "entrega" | "recolha";
  gps: boolean;
  /** Por período: as linhas DESTE condutor, uma por cidade e tipo de serviço (com os colegas ao lado). */
  periods: Record<DriverPeriod, DriverStat[]>;
  /** Evolução (o p50 do condutor e o dos colegas nas mesmas cidades e tipos), com o mesmo n mínimo. */
  monthly: ReturnType<typeof driverTimeSeries>;
  weekly: ReturnType<typeof driverTimeSeries>;
}
export interface DriverTimesView {
  employeeId: number;
  refDay: string;
  ranges: Record<DriverPeriod, { fromDay: string; toDay: string }>;
  minN: number;
  metrics: DriverMetricView[];
  /** Tem algum tempo como condutor nos 6 meses? */
  hasRows: boolean;
}

/**
 * As contas de um condutor (PURA): para cada tempo e período, as linhas dele
 * por (cidade, tipo de serviço) com os colegas (sem ele) e a evolução. O
 * portão aplica-se aqui, sempre com `{ gate, isSuperAdmin }`.
 */
export function driverTimesView(rows: readonly ServiceRow[], o: { employeeId: number; refDay: string; gate: GpsGate | null | undefined; isSuperAdmin: boolean; minN?: number }): DriverTimesView {
  const gpsGate = { gate: o.gate, isSuperAdmin: o.isSuperAdmin };
  const ranges = Object.fromEntries(DRIVER_PERIODS.map((p) => [p, driverPeriodRange(p, o.refDay)])) as DriverTimesView["ranges"];
  const minN = o.minN ?? DRIVER_STATS_MIN_N;
  const weeklyFrom = addDays(o.refDay, -(DRIVER_SERIES_WEEKS * 7 - 1));
  let hasRows = false;
  const metrics = DRIVER_SCREEN_METRICS.map((metric): DriverMetricView => {
    const def = DRIVER_METRICS[metric];
    const periods = Object.fromEntries(DRIVER_PERIODS.map((p) => [p,
      driverTimeStats(rows, { metric, fromDay: ranges[p].fromDay, toDay: ranges[p].toDay, minN, byServiceType: true, gpsGate }).filter((s) => s.employeeId === o.employeeId),
    ])) as DriverMetricView["periods"];
    if (periods["6meses"].length) hasRows = true;
    return {
      metric, label: def.label, kind: def.kind, gps: def.gps, periods,
      // o mesmo mínimo nos pontos do gráfico (dele e dos colegas) que nas linhas da tabela
      monthly: driverTimeSeries(rows, { metric, employeeId: o.employeeId, fromDay: ranges["6meses"].fromDay, toDay: o.refDay, bucket: "mes", minN, gpsGate }),
      weekly: driverTimeSeries(rows, { metric, employeeId: o.employeeId, fromDay: weeklyFrom, toDay: o.refDay, bucket: "semana", minN, gpsGate }),
    };
  });
  return { employeeId: o.employeeId, refDay: o.refDay, ranges, minN, metrics, hasRows };
}

// ─── Leitura ────────────────────────────────────────────────────────────────

const rowsOf = (r: unknown): any[] => { const x = Array.isArray(r) ? r[0] : (r as any)?.rows ?? r; return Array.isArray(x) ? x : []; };
const EMP_COLUMNS = ["startEmployeeId", "deliverEmployeeId", "driverEmployeeId", "checkInEmployeeId", "p2EmployeeId", "parkedEmployeeId"] as const;
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; rows: ServiceRow[] }>();

/** As cidades em que o condutor tem tempos no período (pelos índices de cada condutor). */
async function citiesOf(employeeId: number, fromDay: string, toDay: string): Promise<string[]> {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) return [];
  try {
    const parts = EMP_COLUMNS.map((c) => sql`SELECT DISTINCT cityKey FROM service_times WHERE ${sql.raw(`\`${c}\``)} = ${employeeId} AND opDay >= ${fromDay} AND opDay <= ${toDay} AND voidedAt IS NULL`);
    const res = await db.execute(sql`${sql.join(parts, sql` UNION `)}`);
    return [...new Set(rowsOf(res).map((r) => String(r.cityKey ?? "")).filter(Boolean))];
  } catch {
    return [];
  }
}

/**
 * Os tempos de um condutor (Condutores e agentes; Desempenho). Lê as linhas
 * das cidades dele (dentro do âmbito de quem pede) nos últimos 6 meses — as
 * dele e as dos colegas — e faz as contas. Nunca lança.
 */
export async function getDriverTimes(o: { employeeId: number; refDay: string; cityKeys: readonly string[] | null; isSuperAdmin: boolean }): Promise<DriverTimesView & { available: boolean; name: string | null }> {
  const { loadServiceRows, loadServiceViewSettings, employeeNames } = await import("./serviceTimesRead");
  const fromDay = driverPeriodRange("6meses", o.refDay).fromDay;
  const weeklyFrom = addDays(o.refDay, -(DRIVER_SERIES_WEEKS * 7 - 1));
  const from = weeklyFrom < fromDay ? weeklyFrom : fromDay;
  const [mine, st, names] = await Promise.all([citiesOf(o.employeeId, from, o.refDay), loadServiceViewSettings(), employeeNames([o.employeeId])]);
  const cities = mine.filter((c) => !o.cityKeys || o.cityKeys.includes(c)).sort();
  let rows: ServiceRow[] = [];
  if (cities.length) {
    const key = `${from}|${o.refDay}|${cities.join(",")}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) rows = hit.rows;
    else {
      rows = await loadServiceRows({ fromDay: from, toDay: o.refDay, cityKeys: cities });
      if (cache.size > 4) cache.clear();
      cache.set(key, { at: Date.now(), rows });
    }
  }
  const view = driverTimesView(rows, { employeeId: o.employeeId, refDay: o.refDay, gate: st.gate, isSuperAdmin: o.isSuperAdmin });
  return { ...view, available: rows.length > 0, name: names[o.employeeId] ?? null };
}
