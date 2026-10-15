/**
 * Tempos de entrega e de recolha — as LEITURAS dos ecrãs (só leitura):
 *  - a tabela `service_times` (a NOSSA BD), por dias operacionais e cidades;
 *  - sem linhas para o dia (trabalho desligado ou dia por calcular), o
 *    cálculo AO VIVO com as mesmas regras (server/serviceTimesJob.ts →
 *    computeServiceRowsLive: uma leitura da History da Multipark, sem GPS,
 *    sem gravar nada), com as proteções de carga descritas em dayServiceRows
 *    (cache por dia partilhada, um cálculo de cada vez, prazo do pedido);
 *  - as definições que os ecrãs usam (portão, meta, alvo do T2).
 * As contas e o portão estão em server/serviceTimesAgg.ts (PURO).
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { SETTINGS } from "../shared/appSettings";
import { matchCityKey } from "../shared/city";
import { addDays, operationalDayOf } from "../shared/lisbonDay";
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

/** Teto de uma leitura da tabela (linhas). */
export const SERVICE_ROWS_LIMIT = 250_000;

/** As colunas que as contas por condutor usam (DriverRowLike): nada de instantes, garagens nem notas. */
export const DRIVER_ROW_COLUMNS = [
  "kind", "cityKey", "terminalClass", "outcome",
  "startEmployeeId", "deliverEmployeeId", "driverEmployeeId", "checkInEmployeeId", "p2EmployeeId", "parkedEmployeeId",
  "queueMs", "queueStatus", "transitMs", "transitStatus", "ourMs", "ourStatus", "customerMs", "customerStatus",
  "terminalMs", "terminalStatus", "toFirstGarageMs", "p2Ms", "p2Status", "toParkedMs", "parkedStatus", "t2LateMs", "t2Status",
] as const;
/** As colunas das grelhas da Pressão e da Semana (sem as fichas). */
export const GRID_ROW_COLUMNS = [
  "kind", "cityKey", "terminalClass", "outcome", "refHour", "totalMs",
  "queueMs", "queueStatus", "transitMs", "transitStatus", "ourMs", "ourStatus", "customerMs", "customerStatus",
  "terminalMs", "terminalStatus", "toFirstGarageMs", "p2Ms", "p2Status", "toParkedMs", "parkedStatus", "t2LateMs", "t2Status",
] as const;

export interface ServiceRowsRead { rows: ServiceRow[]; truncated: boolean }

/**
 * Linhas não anuladas da tabela nos dias operacionais [fromDay, toDay], nas
 * cidades pedidas (null = todas). Só as colunas dos ecrãs (nada pessoal) — ou
 * só as `columns` pedidas (as outras vêm null).
 *
 * Auditoria do #389: lê-se dos dias MAIS RECENTES para trás (ORDER BY opDay
 * DESC), para que, se o teto cortar, se percam os dias mais antigos e nunca os
 * de hoje; as linhas voltam por ordem crescente e `truncated` diz se cortou
 * (o ecrã avisa).
 */
export async function loadServiceRowsInfo(o: { fromDay: string; toDay: string; cityKeys: readonly string[] | null; kind?: "entrega" | "recolha"; bookingId?: string; limit?: number; columns?: readonly string[] }): Promise<ServiceRowsRead> {
  const db = await getDb();
  if (!db) return { rows: [], truncated: false };
  if (o.cityKeys && !o.cityKeys.length) return { rows: [], truncated: false };
  const want = o.columns ? new Set(o.columns) : null;
  const cols = sql.raw([
    ...PLAIN_COLUMNS.filter((c) => !want || want.has(c)).map((c) => `\`${c}\``),
    ...TS_COLUMNS.filter((c) => !want || want.has(c)).map((c) => `DATE_FORMAT(\`${c}\`, '%Y-%m-%d %H:%i:%s.%f') AS \`${c}\``),
    "DATE_FORMAT(`opDay`, '%Y-%m-%d') AS `opDay`",
    ...(!want || want.has("computedAt") ? ["DATE_FORMAT(`computedAt`, '%Y-%m-%d %H:%i:%s') AS `computedAt`"] : []),
  ].join(", "));
  const cities = o.cityKeys ? sql`AND cityKey IN (${sql.join(o.cityKeys.map((c) => sql`${c}`), sql`, `)})` : sql``;
  // o índice (kind, opDay, cityKey) começa pelo tipo
  const kind = o.kind ? sql`AND kind = ${o.kind}` : sql`AND kind IN ('entrega', 'recolha')`;
  const booking = o.bookingId ? sql`AND bookingId = ${o.bookingId}` : sql``;
  const limit = Math.max(1, Math.min(o.limit ?? SERVICE_ROWS_LIMIT, SERVICE_ROWS_LIMIT));
  try {
    // uma a mais para saber se cortou
    const res = await db.execute(sql`SELECT ${cols} FROM service_times
      WHERE opDay >= ${o.fromDay} AND opDay <= ${o.toDay} AND voidedAt IS NULL ${cities} ${kind} ${booking}
      ORDER BY opDay DESC, id DESC LIMIT ${sql.raw(String(limit + 1))}`);
    const raw = rowsOf(res);
    const truncated = raw.length > limit;
    const rows = raw.slice(0, limit).map(serviceRowFromDb).reverse();
    if (truncated) console.warn(`[tempos] leitura da tabela cortada em ${limit} linhas (${o.fromDay}…${o.toDay}): ficam os dias mais recentes`);
    return { rows, truncated };
  } catch (err: any) {
    // tabela ainda por criar (arranque a meio da migração 0685): como se estivesse vazia
    console.warn("[tempos] leitura da tabela:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
    return { rows: [], truncated: false };
  }
}

/** As linhas (sem o aviso do corte) — ver loadServiceRowsInfo. */
export async function loadServiceRows(o: Parameters<typeof loadServiceRowsInfo>[0]): Promise<ServiceRow[]> {
  return (await loadServiceRowsInfo(o)).rows;
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

/*
 * CARGA NA BD DA MULTIPARK (auditoria final da fase 3). A "History" não tem
 * índices: cada leitura é sequencial (segundos; até 25 s com a BD carregada).
 * O cálculo ao vivo faz UMA dessas leituras por dia pedido (mais umas leituras
 * por chave: reservas, telefones, agentes, parques). Por isso:
 *  1. guarda-se por DIA (todas as cidades; cada pedido filtra as suas), na
 *     memória da instância, partilhado por todos os utilizadores: 5 min para
 *     o dia de hoje, 15 min para ontem e 60 min para os dias mais antigos
 *     (sem GPS ao vivo, um dia fechado quase não muda);
 *  2. pedidos ao mesmo tempo para o MESMO dia esperam pelo mesmo cálculo
 *     (uma leitura, não uma por pessoa);
 *  3. no máximo UM cálculo ao vivo de cada vez por instância (a pool da
 *     Multipark tem 2 ligações por instância: a outra fica livre para os
 *     outros ecrãs). Um pedido de outro dia espera a vez até 12 s; depois
 *     devolve "indisponível" com o motivo (o ecrã diz para tentar daqui a pouco);
 *  4. uma falha (Multipark em baixo ou lenta) fica guardada 60 s: não se
 *     insiste a cada clique;
 *  5. quem chama passa o prazo que ainda tem (a função da Vercel morre aos
 *     60 s); com menos de 12 s não se começa nenhuma leitura.
 * A Pressão, a Semana, os tempos por condutor e o cartão da cobertura NÃO
 * calculam ao vivo: só leem a nossa tabela (zero leituras à Multipark).
 */
export const LIVE_CACHE_TODAY_MS = 5 * 60_000;
export const LIVE_CACHE_YESTERDAY_MS = 15 * 60_000;
export const LIVE_CACHE_OLDER_MS = 60 * 60_000;
export const LIVE_FAILURE_CACHE_MS = 60_000;
export const LIVE_MAX_CONCURRENT = 1;
export const LIVE_QUEUE_WAIT_MS = 12_000;
export const LIVE_MIN_BUDGET_MS = 12_000;
/** Prazo por omissão de um cálculo ao vivo (quem chama pode dar menos). */
export const LIVE_DEFAULT_BUDGET_MS = 35_000;
const LIVE_CACHE_MAX_DAYS = 20;

/** Quanto tempo o cálculo ao vivo de um dia fica guardado (hoje 5 min, ontem 15, antes 60). PURA. */
export function liveCacheTtlMs(date: string, nowMs: number): number {
  const today = operationalDayOf(nowMs);
  if (date >= today) return LIVE_CACHE_TODAY_MS;
  if (date === addDays(today, -1)) return LIVE_CACHE_YESTERDAY_MS;
  return LIVE_CACHE_OLDER_MS;
}

type LiveOutcome = { ok: true; rows: ServiceRow[]; truncated: boolean; at: number } | { ok: false; error: string; busy?: boolean };
/** O cálculo de um dia (injetável nos testes): UMA leitura da History, só leitura, sem gravar. */
export type LiveCompute = (date: string, deadlineAt: number) => Promise<{ ok: true; rows: ServiceRow[]; truncated: boolean } | { ok: false; error: string }>;

const liveCache = new Map<string, { at: number; value: { rows: ServiceRow[]; truncated: boolean } }>();
const liveFailures = new Map<string, { at: number; error: string }>();
const liveInflight = new Map<string, Promise<LiveOutcome>>();
let liveRunning = 0;
const liveWaiters: Array<() => void> = [];
/** Leituras ao vivo começadas (para os testes e para o log). */
let liveStarted = 0;

/** Só para os testes. */
export function clearServiceLiveCache(): void {
  liveCache.clear();
  liveFailures.clear();
  liveInflight.clear();
  liveRunning = 0;
  liveWaiters.length = 0;
  liveStarted = 0;
}
/** Só para os testes: quantos cálculos ao vivo começaram. */
export function serviceLiveStarted(): number {
  return liveStarted;
}

function acquireLiveSlot(waitMs: number): Promise<boolean> {
  if (liveRunning < LIVE_MAX_CONCURRENT) { liveRunning++; return Promise.resolve(true); }
  if (waitMs <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const wake = () => { clearTimeout(timer); liveRunning++; resolve(true); };
    const timer = setTimeout(() => {
      const i = liveWaiters.indexOf(wake);
      if (i >= 0) liveWaiters.splice(i, 1);
      resolve(false);
    }, waitMs);
    liveWaiters.push(wake);
  });
}
function releaseLiveSlot(): void {
  liveRunning = Math.max(0, liveRunning - 1);
  const next = liveWaiters.shift();
  if (next) next();
}

const defaultLiveCompute: LiveCompute = async (date, deadlineAt) => {
  const [{ computeServiceRowsLive }, { realServiceTimesDeps }] = await Promise.all([import("./serviceTimesJob"), import("./serviceTimesDeps")]);
  const r = await computeServiceRowsLive(await realServiceTimesDeps(), { from: date, to: date, deadlineAt });
  return r.ok ? { ok: true, rows: r.rows.map(serviceRowFromJob), truncated: r.truncated } : r;
};

async function runLive(date: string, budgetMs: number, compute: LiveCompute): Promise<LiveOutcome> {
  const t0 = Date.now();
  const got = await acquireLiveSlot(Math.min(LIVE_QUEUE_WAIT_MS, budgetMs - LIVE_MIN_BUDGET_MS));
  if (!got) return { ok: false, busy: true, error: "a calcular os tempos de outro dia" };
  try {
    const left = budgetMs - (Date.now() - t0);
    if (left < LIVE_MIN_BUDGET_MS) return { ok: false, busy: true, error: "sem tempo para os calcular neste pedido" };
    liveStarted++;
    const r = await compute(date, Date.now() + left);
    const at = Date.now();
    if (!r.ok) {
      liveFailures.set(date, { at, error: r.error });
      return { ok: false, error: r.error };
    }
    liveFailures.delete(date);
    if (liveCache.size >= LIVE_CACHE_MAX_DAYS) {
      const oldest = [...liveCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) liveCache.delete(oldest[0]);
    }
    liveCache.set(date, { at, value: { rows: r.rows, truncated: r.truncated } });
    return { ok: true, rows: r.rows, truncated: r.truncated, at };
  } catch (err: any) {
    const error = String(err?.message ?? err).slice(0, 160);
    liveFailures.set(date, { at: Date.now(), error });
    return { ok: false, error };
  } finally {
    releaseLiveSlot();
  }
}

const utcText = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/**
 * As linhas de UM dia operacional: as da tabela; sem nenhuma (nas cidades
 * pedidas), as calculadas agora com as mesmas regras (sem GPS), com as
 * proteções de carga acima. `deadlineMs` = o tempo que quem chama ainda tem.
 * Nunca lança.
 */
export async function dayServiceRows(date: string, o: { cityKeys: readonly string[] | null; nowMs?: number; deadlineMs?: number; compute?: LiveCompute }): Promise<DayServiceRows> {
  // auditoria do #389: sem cidades no âmbito, ou um dia que ainda não começou, não há nada a ler
  // nem a calcular (nem a tabela, nem a Multipark)
  const nothing = (reason: string): DayServiceRows => ({ source: "tabela", rows: [], computedAt: null, truncated: false, reason });
  if (o.cityKeys && !o.cityKeys.length) return nothing("sem cidades no teu acesso");
  if (date > operationalDayOf(o.nowMs ?? Date.now())) return nothing("o dia ainda não começou");
  const inScope = (r: ServiceRow) => !o.cityKeys || o.cityKeys.includes(r.cityKey ?? "");
  const read = await loadServiceRowsInfo({ fromDay: date, toDay: date, cityKeys: o.cityKeys });
  const stored = read.rows.filter(inScope);
  if (stored.length) {
    const computedAt = stored.reduce<string | null>((m, r) => (r.computedAt && (!m || r.computedAt > m) ? r.computedAt : m), null);
    return { source: "tabela", rows: stored, computedAt, truncated: read.truncated, reason: null };
  }
  const unavailable = (reason: string): DayServiceRows => ({ source: "indisponivel", rows: [], computedAt: null, truncated: false, reason });
  const now = o.nowMs ?? Date.now();
  const hit = liveCache.get(date);
  if (hit && now - hit.at < liveCacheTtlMs(date, now)) return { source: "ao_vivo", rows: hit.value.rows.filter(inScope), computedAt: utcText(hit.at), truncated: hit.value.truncated, reason: null };
  const failed = liveFailures.get(date);
  if (failed && now - failed.at < LIVE_FAILURE_CACHE_MS) return unavailable(failed.error);
  const budget = Math.min(o.deadlineMs ?? LIVE_DEFAULT_BUDGET_MS, LIVE_DEFAULT_BUDGET_MS);
  if (budget < LIVE_MIN_BUDGET_MS) return unavailable("sem tempo para os calcular neste pedido");
  try {
    let p = liveInflight.get(date);
    if (!p) {
      p = runLive(date, budget, o.compute ?? defaultLiveCompute);
      liveInflight.set(date, p);
      const mine = p;
      void p.finally(() => { if (liveInflight.get(date) === mine) liveInflight.delete(date); });
    }
    // quem se junta a um cálculo já em curso não espera mais do que o seu prazo
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([
      p,
      new Promise<LiveOutcome>((resolve) => { timer = setTimeout(() => resolve({ ok: false, busy: true, error: "ainda a calcular" }), budget); }),
    ]).finally(() => clearTimeout(timer));
    if (!r.ok) return unavailable(r.error);
    return { source: "ao_vivo", rows: r.rows.filter(inScope), computedAt: utcText(r.at), truncated: r.truncated, reason: null };
  } catch (err: any) {
    return unavailable(String(err?.message ?? err).slice(0, 160));
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
