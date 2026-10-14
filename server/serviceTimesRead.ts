/**
 * Tempos de entrega e de recolha — as LEITURAS dos ecrãs (só leitura):
 *  - a tabela `service_times` (a NOSSA BD), por dias operacionais e cidades;
 *  - sem linhas para o dia (trabalho desligado ou dia por calcular), o
 *    cálculo AO VIVO com as mesmas regras (server/serviceTimesJob.ts →
 *    computeServiceRowsLive: uma leitura da History da Multipark, sem GPS,
 *    sem gravar nada), guardado em memória 2 minutos;
 *  - as definições que os ecrãs usam (portão, meta, alvo do T2).
 * As contas e o portão estão em server/serviceTimesAgg.ts (PURO).
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { SETTINGS } from "../shared/appSettings";
import { matchCityKey } from "../shared/city";
import { DEFAULT_GPS_GATE, type GpsGate } from "../shared/serviceTimes";
import { utcTextMs } from "./multiparkDb/serviceRows";
import type { ServiceRow } from "./serviceTimesAgg";
import type { ServiceTimesRow } from "./serviceTimesJob";

const rowsOf = (r: unknown): any[] => { const x = Array.isArray(r) ? r[0] : (r as any)?.rows ?? r; return Array.isArray(x) ? x : []; };
const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const strOrNull = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

// ─── Definições dos ecrãs ───────────────────────────────────────────────────

export interface ServiceViewSettings { gate: GpsGate; targetMinutes: number; t2TargetMinutes: number }

/** O portão, a meta e o alvo do T2 (as omissões se a leitura falhar). */
export async function loadServiceViewSettings(): Promise<ServiceViewSettings> {
  try {
    const { getSetting } = await import("./appSettings");
    const [gate, target, t2] = await Promise.all([
      getSetting("serviceTimes.gpsGate").catch(() => null),
      getSetting("serviceTimes.targetMinutes").catch(() => null),
      getSetting("serviceTimes.pickupT2TargetMinutes").catch(() => null),
    ]);
    return {
      gate: (gate as GpsGate | null) ?? { ...DEFAULT_GPS_GATE },
      targetMinutes: Number(target ?? SETTINGS["serviceTimes.targetMinutes"].defaultValue),
      t2TargetMinutes: Number(t2 ?? SETTINGS["serviceTimes.pickupT2TargetMinutes"].defaultValue),
    };
  } catch {
    return { gate: { ...DEFAULT_GPS_GATE }, targetMinutes: SETTINGS["serviceTimes.targetMinutes"].defaultValue as number, t2TargetMinutes: SETTINGS["serviceTimes.pickupT2TargetMinutes"].defaultValue as number };
  }
}

/** Cidades (lisboa/porto/faro) do âmbito de quem pede; null = todas. */
export async function scopedServiceCityKeys(): Promise<string[] | null> {
  const { scopedCityNamesLive } = await import("./cityScope");
  const names = scopedCityNamesLive();
  if (names === undefined) return null;
  return [...new Set(names.map((n) => matchCityKey(n)).filter((k): k is NonNullable<typeof k> => !!k))];
}

// ─── A tabela ───────────────────────────────────────────────────────────────

const TS_COLUMNS = ["callAt", "requestAt", "startedAt", "arrivedAt", "deliveredAt", "checkInAt", "terminalExitAt"] as const;
const PLAIN_COLUMNS = [
  "kind", "bookingId", "bookingCode", "cityKey", "terminalClass", "outcome", "refHour", "startSource", "arrivedSource",
  "queueMs", "queueStatus", "transitMs", "transitStatus", "ourMs", "ourStatus", "customerMs", "customerStatus", "totalMs",
  "terminalMs", "terminalStatus", "terminalExitSource", "toFirstGarageMs", "firstGarage", "firstGarageRole", "p2Ms", "p2Status",
  "toParkedMs", "parkedStatus", "parkedGarage", "t2LateMs", "t2Status",
  "startEmployeeId", "deliverEmployeeId", "driverEmployeeId", "checkInEmployeeId", "p2EmployeeId", "parkedEmployeeId",
  "flags", "gpsPass", "calcVersion", "paramsHash",
] as const;
const NUM_COLUMNS = new Set<string>([
  "refHour", "queueMs", "transitMs", "ourMs", "customerMs", "totalMs", "terminalMs", "toFirstGarageMs", "p2Ms", "toParkedMs", "t2LateMs",
  "startEmployeeId", "deliverEmployeeId", "driverEmployeeId", "checkInEmployeeId", "p2EmployeeId", "parkedEmployeeId", "calcVersion",
]);

/** Linha lida da tabela (instantes como texto UTC) → ServiceRow. PURA. */
export function serviceRowFromDb(r: Record<string, unknown>): ServiceRow {
  const out: Record<string, unknown> = { opDay: String(r.opDay ?? "").slice(0, 10), voidedAt: r.voidedAt == null ? null : String(r.voidedAt), computedAt: strOrNull(r.computedAt) };
  for (const c of PLAIN_COLUMNS) out[c] = NUM_COLUMNS.has(c) ? numOrNull(r[c]) : strOrNull(r[c]);
  for (const c of TS_COLUMNS) out[c] = utcTextMs(r[c]);
  out.bookingId = String(r.bookingId ?? "");
  out.kind = String(r.kind ?? "");
  out.outcome = String(r.outcome ?? "");
  return out as unknown as ServiceRow;
}

/** Linha calculada pelo trabalho (ou ao vivo) → ServiceRow. PURA. */
export function serviceRowFromJob(r: ServiceTimesRow): ServiceRow {
  return serviceRowFromDb({ ...r } as unknown as Record<string, unknown>);
}

/**
 * Linhas não anuladas da tabela nos dias operacionais [fromDay, toDay], nas
 * cidades pedidas (null = todas). Só as colunas dos ecrãs (nada pessoal).
 */
export async function loadServiceRows(o: { fromDay: string; toDay: string; cityKeys: readonly string[] | null; kind?: "entrega" | "recolha"; bookingId?: string; limit?: number }): Promise<ServiceRow[]> {
  const db = await getDb();
  if (!db) return [];
  if (o.cityKeys && !o.cityKeys.length) return [];
  const cols = sql.raw([
    ...PLAIN_COLUMNS.map((c) => `\`${c}\``),
    ...TS_COLUMNS.map((c) => `DATE_FORMAT(\`${c}\`, '%Y-%m-%d %H:%i:%s.%f') AS \`${c}\``),
    "DATE_FORMAT(`opDay`, '%Y-%m-%d') AS `opDay`", "DATE_FORMAT(`computedAt`, '%Y-%m-%d %H:%i:%s') AS `computedAt`",
  ].join(", "));
  const cities = o.cityKeys ? sql`AND cityKey IN (${sql.join(o.cityKeys.map((c) => sql`${c}`), sql`, `)})` : sql``;
  // o índice (kind, opDay, cityKey) começa pelo tipo
  const kind = o.kind ? sql`AND kind = ${o.kind}` : sql`AND kind IN ('entrega', 'recolha')`;
  const booking = o.bookingId ? sql`AND bookingId = ${o.bookingId}` : sql``;
  const limit = Math.max(1, Math.min(o.limit ?? 250_000, 250_000));
  try {
    const res = await db.execute(sql`SELECT ${cols} FROM service_times
      WHERE opDay >= ${o.fromDay} AND opDay <= ${o.toDay} AND voidedAt IS NULL ${cities} ${kind} ${booking}
      ORDER BY opDay, id LIMIT ${sql.raw(String(limit))}`);
    return rowsOf(res).map(serviceRowFromDb);
  } catch (err: any) {
    // tabela ainda por criar (arranque a meio da migração 0685): como se estivesse vazia
    console.warn("[tempos] leitura da tabela:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
    return [];
  }
}

/** Linhas de uma reserva (todas as cidades: quem chama já confirmou o acesso à reserva). */
export async function loadBookingServiceRows(bookingId: string): Promise<ServiceRow[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    const cols = sql.raw([
      ...PLAIN_COLUMNS.map((c) => `\`${c}\``),
      ...TS_COLUMNS.map((c) => `DATE_FORMAT(\`${c}\`, '%Y-%m-%d %H:%i:%s.%f') AS \`${c}\``),
      "DATE_FORMAT(`opDay`, '%Y-%m-%d') AS `opDay`", "DATE_FORMAT(`computedAt`, '%Y-%m-%d %H:%i:%s') AS `computedAt`",
    ].join(", "));
    return rowsOf(await db.execute(sql`SELECT ${cols} FROM service_times WHERE bookingId = ${bookingId} AND voidedAt IS NULL ORDER BY anchorAt DESC LIMIT 20`)).map(serviceRowFromDb);
  } catch {
    return [];
  }
}

// ─── Um dia: a tabela ou, sem linhas, ao vivo ───────────────────────────────

export type DayRowsSource = "tabela" | "ao_vivo" | "indisponivel";
export interface DayServiceRows { source: DayRowsSource; rows: ServiceRow[]; computedAt: string | null; truncated: boolean; reason: string | null }

const LIVE_CACHE_MS = 2 * 60_000;
const liveCache = new Map<string, { at: number; value: { rows: ServiceRow[]; truncated: boolean } }>();

/** Só para os testes. */
export function clearServiceLiveCache(): void {
  liveCache.clear();
}

/**
 * As linhas de UM dia operacional: as da tabela; sem nenhuma (nas cidades
 * pedidas), as calculadas agora com as mesmas regras (sem GPS). Nunca lança.
 */
export async function dayServiceRows(date: string, o: { cityKeys: readonly string[] | null; nowMs?: number; deadlineMs?: number }): Promise<DayServiceRows> {
  const inScope = (r: ServiceRow) => !o.cityKeys || o.cityKeys.includes(r.cityKey ?? "");
  const stored = (await loadServiceRows({ fromDay: date, toDay: date, cityKeys: o.cityKeys })).filter(inScope);
  if (stored.length) {
    const computedAt = stored.reduce<string | null>((m, r) => (r.computedAt && (!m || r.computedAt > m) ? r.computedAt : m), null);
    return { source: "tabela", rows: stored, computedAt, truncated: false, reason: null };
  }
  const now = o.nowMs ?? Date.now();
  const hit = liveCache.get(date);
  if (hit && now - hit.at < LIVE_CACHE_MS) return { source: "ao_vivo", rows: hit.value.rows.filter(inScope), computedAt: new Date(hit.at).toISOString().slice(0, 19).replace("T", " "), truncated: hit.value.truncated, reason: null };
  try {
    const [{ computeServiceRowsLive }, { realServiceTimesDeps }] = await Promise.all([import("./serviceTimesJob"), import("./serviceTimesDeps")]);
    const deps = await realServiceTimesDeps();
    const r = await computeServiceRowsLive(deps, { from: date, to: date, deadlineAt: Date.now() + (o.deadlineMs ?? 35_000) });
    if (!r.ok) return { source: "indisponivel", rows: [], computedAt: null, truncated: false, reason: r.error };
    const rows = r.rows.map(serviceRowFromJob);
    if (liveCache.size > 20) liveCache.clear();
    liveCache.set(date, { at: now, value: { rows, truncated: r.truncated } });
    return { source: "ao_vivo", rows: rows.filter(inScope), computedAt: new Date(now).toISOString().slice(0, 19).replace("T", " "), truncated: r.truncated, reason: null };
  } catch (err: any) {
    return { source: "indisponivel", rows: [], computedAt: null, truncated: false, reason: String(err?.message ?? err).slice(0, 160) };
  }
}

/** Nomes das fichas (para o condutor de cada tempo). */
export async function employeeNames(ids: Iterable<number | null | undefined>): Promise<Record<number, string>> {
  const list = [...new Set([...ids].filter((x): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0))].slice(0, 2000);
  if (!list.length) return {};
  const db = await getDb();
  if (!db) return {};
  try {
    const rows = rowsOf(await db.execute(sql`SELECT id, fullName FROM employees WHERE id IN (${sql.join(list.map((x) => sql`${x}`), sql`, `)})`));
    return Object.fromEntries(rows.map((r) => [Number(r.id), String(r.fullName ?? "")]));
  } catch {
    return {};
  }
}
