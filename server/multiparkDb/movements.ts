/**
 * Movimentos dos agentes lidos AO VIVO da BD da Multipark (BD 2) — para a
 * Avaliação (docs/multipark-db/plano-duas-bd.md, B5). Não copia nada para a
 * nossa BD. Segue as regras de read.ts: SQL parametrizado, construtores e
 * mapeadores PUROS (testados em movements.test.ts), LIMIT nas listas e nunca
 * lança (`{ available:false, reason }`).
 *
 * O GPS NÃO vem daqui: onde deixaram os carros / por onde andaram continua a
 * vir do Zello (a nossa BD). Daqui vem QUEM fez O QUÊ e QUANDO.
 *
 * Colunas usadas (docs/multipark-db/schema.md):
 *   History: id, userId, agentName, changeType, actionTime, bookingId,
 *            modifiedFields, platform, remarks
 *   Booking: id, parkId, allocation, vehicleId, status, checkIn, checkOut,
 *            checkInDriverId, checkOutDriverId
 *   BookingVehicle: licensePlate · Park: id, name, city
 *   Agent: userId, parkId, name (nome quando o History não o tem)
 *   Occurrence: userId, agentName, createdAt, resolvedById, resolvedByName,
 *               resolvedAt, parkId
 *   BookingReview: bookingId, parkId, rating, createdAt
 *
 * Tudo agregado no Postgres (GROUP BY / window functions): 4 semanas de
 * histórico dão poucas centenas de linhas. O filtro no tempo é SEMPRE na
 * coluna crua (`h."actionTime" >= $a AND h."actionTime" < $b`) para poder
 * usar um índice — ⚠️ a "History" ainda só tem a PK (pedir à Multipark
 * CREATE INDEX ON "History" ("actionTime")); sem ele é uma leitura sequencial
 * de ~300 mil linhas, que ainda assim fica muito abaixo dos 15 s.
 *
 * Dias: dia OPERACIONAL de Lisboa (03h→03h; manhã 03h–15h, noite 15h–03h),
 * o mesmo da avaliação (shared/lisbonDay.ts). A BD grava UTC sem fuso.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, cityAliases, safeMultiparkRead, toIsoUtc, type MultiparkRead } from "./read";
import {
  OPERATIONAL_DAY_START_HOUR,
  OPERATIONAL_NIGHT_START_HOUR,
  addDays,
  operationalDayRangeUtc,
} from "../../shared/lisbonDay";
import { LATE_SERVICE_MAX_MINUTES, LATE_SERVICE_MINUTES } from "../../shared/evaluationRules";
import {
  MOVEMENT_CHANGE_TYPES, MOVE_EXIT_AFTER, MOVE_SEQ_PARK_TYPES, MOVE_SEQ_TYPES, SPOT_CHANGE_KEY, actionKeyOf, moveKindsOf,
  type MoveKind, type MovementChangeType,
} from "../../shared/multiparkMovements";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

/** Máximo de ids de agentes num filtro (IN ($1…$n)). */
export const MAX_AGENT_IDS = 200;
/** Teto das linhas agregadas (agente × dia) — 4 semanas × ~150 agentes. */
export const AGG_ROW_LIMIT = 10_000;
export const DETAIL_DEFAULT_LIMIT = 300;
export const DETAIL_MAX_LIMIT = 1000;

// ─── Expressões SQL (constantes nossas, nunca texto do utilizador) ───────────

/** Instante UTC (timestamp sem fuso) → hora de parede de Lisboa. */
export const lisbonLocal = (col: string) => `((${col}) AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Lisbon'`;
/** Dia operacional "YYYY-MM-DD" (antes das 03h conta para o dia anterior). */
export const opDaySql = (col: string) => `to_char(${lisbonLocal(col)} - interval '${OPERATIONAL_DAY_START_HOUR} hours', 'YYYY-MM-DD')`;
/** 49e: hora de RELÓGIO de Lisboa (0–23) — a atividade por hora do Desempenho. */
export const lisbonHourSql = (col: string) => `(extract(hour from ${lisbonLocal(col)}))::int`;
/** Turno operacional: manhã 03h–15h, noite 15h–03h. */
export const opShiftSql = (col: string) => {
  const h = `extract(hour from ${lisbonLocal(col)})`;
  return `CASE WHEN ${h} >= ${OPERATIONAL_DAY_START_HOUR} AND ${h} < ${OPERATIONAL_NIGHT_START_HOUR} THEN 'morning' ELSE 'night' END`;
};
const ts = (col: string) => `to_char(${col}, 'YYYY-MM-DD HH24:MI:SS')`;

// ─── Movimento × mudança de lugar (regra em shared/multiparkMovements.ts) ────
// O mesmo que `moveKindsOf`, em SQL: a ação anterior da MESMA reserva decide.
const sqlList = (xs: readonly string[]) => `(${xs.map((x) => `'${x}'`).join(", ")})`;
/** recolha, entrega, movimento, cancelamento (o "levar ao parque" de sempre) */
export const MOVE_PARK_CATS_SQL = sqlList(MOVE_SEQ_PARK_TYPES);
/** as mesmas + pedido de entrega e início da entrega */
export const MOVE_SEQ_CATS_SQL = sqlList(MOVE_SEQ_TYPES);
const MOVE_EXIT_AFTER_SQL = sqlList(MOVE_EXIT_AFTER);
/** A ação anterior (`prevPark` entre as primeiras, `prevAny` entre todas) faz deste MOVEMENT uma mudança de lugar? */
export const moveIsSpotSql = (prevPark: string, prevAny: string) =>
  `(${prevPark} IS DISTINCT FROM 'CHECK_IN' AND (${prevAny} IS NULL OR ${prevAny} NOT IN ${MOVE_EXIT_AFTER_SQL}))`;
/**
 * 14 out 2026: quando a entrega ficou feita para quem entregou — o carro no
 * local de entrega (Booking.arrivedAtDeliveryAt), se a app o registou entre o
 * pedido e este CHECK_OUT; senão o próprio CHECK_OUT (como o Extras → Pressão).
 */
export const DELIVERED_AT_SQL = `(CASE WHEN x.arrived_at IS NOT NULL AND x.arrived_at >= x.pending_at AND x.arrived_at <= x.at THEN x.arrived_at ELSE x.at END)`;
/** Dias de histórico lidos para trás para saber o que veio antes (uma recolha ou um pedido de entrega de dias antes). */
export const MOVE_LOOKBACK_DAYS = 3;
/**
 * CTE `seq` (id, prev_cat, prev_any) com as ações que decidem o tipo de cada
 * MOVEMENT, em [lb, to) — `lb` e `to` são marcadores já na ParamList. Junta-se
 * por `seq.id = h."id"`. Sem filtro de cidade: a sequência é da reserva.
 */
export function moveSeqCteSql(lb: string, to: string): string {
  const ct = `upper(s."changeType"::text)`;
  return [
    `seq AS (`,
    `  SELECT s."id" AS id,`,
    `         CASE WHEN ${ct} IN ${MOVE_PARK_CATS_SQL}`,
    `              THEN lag(${ct}) OVER (PARTITION BY s."bookingId", (${ct} IN ${MOVE_PARK_CATS_SQL}) ORDER BY s."actionTime", s."id") END AS prev_cat,`,
    `         lag(${ct}) OVER (PARTITION BY s."bookingId" ORDER BY s."actionTime", s."id") AS prev_any`,
    `    FROM "History" s`,
    `   WHERE s."actionTime" >= ${lb}::timestamp AND s."actionTime" < ${to}::timestamp`,
    `     AND ${ct} IN ${MOVE_SEQ_CATS_SQL}`,
    `)`,
  ].join("\n");
}
/** Início (UTC) da leitura da sequência para uma janela que começa em `fromUtc` ("YYYY-MM-DD HH:MM:SS"). PURA. */
export function moveLookbackFrom(fromUtc: string): string {
  const ms = Date.parse(`${String(fromUtc).replace(" ", "T").slice(0, 19)}Z`);
  return new Date(ms - MOVE_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

function cityCondition(cities: string[] | undefined, params: ParamList, col = `p."city"`): string | null {
  if (cities === undefined) return null;
  const aliases = cityAliases(cities);
  return aliases.length ? `lower(trim(${col})) IN (${aliases.map((c) => params.add(c)).join(", ")})` : `FALSE`;
}

/** 42a: só estes parques (Park.id) — o filtro de marca. undefined = todos; [] = nenhum. */
function parkCondition(parkIds: string[] | undefined, params: ParamList, col = `p."id"`): string | null {
  if (parkIds === undefined) return null;
  const clean = Array.from(new Set(parkIds.map((s) => String(s ?? "").trim()).filter(Boolean)));
  return clean.length ? `${col} IN (${clean.map((id) => params.add(id)).join(", ")})` : `FALSE`;
}

function idList(ids: string[] | undefined, params: ParamList, col: string): string | null {
  if (ids === undefined) return null;
  const clean = Array.from(new Set(ids.map((s) => String(s ?? "").trim()).filter(Boolean))).slice(0, MAX_AGENT_IDS);
  return clean.length ? `${col} IN (${clean.map((id) => params.add(id)).join(", ")})` : `FALSE`;
}

// ─── Janela de tempo ─────────────────────────────────────────────────────────

export interface MovementWindow {
  startDay: string;
  endDay: string;
  /** "YYYY-MM-DD HH:MM:SS" UTC — [from, to) */
  from: string;
  to: string;
}

/** Dias operacionais [startDay, endDay] → instantes UTC. PURA. */
export function movementWindow(startDay: string, endDay: string = startDay): MovementWindow {
  if (!DAY_RE.test(startDay) || !DAY_RE.test(endDay) || endDay < startDay) throw new Error(`Intervalo inválido: ${startDay}..${endDay}`);
  const r = operationalDayRangeUtc(startDay, endDay);
  return { startDay, endDay, from: r.start, to: r.end };
}

// ─── 1. Entradas do motor da avaliação ───────────────────────────────────────

/**
 * Contagens para o motor da avaliação, por (agente, dia operacional, turno,
 * changeType e — 49e — hora de Lisboa), com as MESMAS regras de evaluationCore.ts:
 *  - "levar ao parque" = MOVEMENT cuja ação anterior da MESMA reserva, entre
 *    recolha/entrega/movimento/cancelamento, foi uma recolha (CHECK_IN);
 *  - "mudança de lugar" (14 out 2026) = MOVEMENT que não leva ao parque nem
 *    tira do parque para a entrega (shared/multiparkMovements.ts): conta como
 *    ação, não como movimento — `spot_moves`;
 *  - entrega atrasada = entregue mais de LATE_SERVICE_MINUTES (e menos de
 *    LATE_SERVICE_MAX_MINUTES) depois do 1.º PENDING_CHECKOUT desde a entrega
 *    anterior da mesma reserva. 14 out 2026: "entregue" = o carro chegou ao
 *    local de entrega (Booking.arrivedAtDeliveryAt, quando a app o regista e
 *    cai entre o pedido e o CHECK_OUT) — senão o CHECK_OUT. É a mesma medida do
 *    Extras → Pressão (pressure.ts: "entregue = arrivedAtDeliveryAt → 1.º
 *    CHECK_OUT"): o tempo em que o cliente ainda estava nas malas não é atraso
 *    de quem entregou.
 * A sequência lê desde `lookbackFrom` (uma recolha de dias antes conta), mas
 * só se contam as ações de [from, to).
 * Sem âmbito de cidade: o motor calcula tudo (o âmbito aplica-se ao ler).
 * PURA.
 */
export function buildEngineActionCountsSql(opts: { lookbackFrom: string; from: string; to: string }): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const lb = params.add(opts.lookbackFrom);
  const to = params.add(opts.to);
  const from = params.add(opts.from);
  const late = params.add(LATE_SERVICE_MINUTES);
  const lateMax = params.add(LATE_SERVICE_MAX_MINUTES);
  const cats = MOVE_PARK_CATS_SQL;
  const seqCats = MOVE_SEQ_CATS_SQL;
  const sql = [
    `WITH h AS (`,
    `  SELECT h."id" AS id, h."bookingId" AS booking_id, h."userId" AS user_id,`,
    `         COALESCE(NULLIF(h."agentName", ''), NULLIF(ag."name", '')) AS agent_name,`,
    `         upper(h."changeType"::text) AS ct, h."actionTime" AS at, b."arrivedAtDeliveryAt" AS arrived_at`,
    `    FROM "History" h`,
    `    LEFT JOIN "Booking" b ON b."id" = h."bookingId"`,
    `    LEFT JOIN "Agent" ag ON ag."userId" = h."userId" AND ag."parkId" = b."parkId"`,
    `   WHERE h."actionTime" >= ${lb}::timestamp AND h."actionTime" < ${to}::timestamp`,
    `), seq AS (`,
    `  SELECT h.*,`,
    `         CASE WHEN h.ct IN ${cats} THEN lag(h.ct) OVER (PARTITION BY h.booking_id, (h.ct IN ${cats}) ORDER BY h.at, h.id) END AS prev_cat,`,
    `         CASE WHEN h.ct IN ${seqCats} THEN lag(h.ct) OVER (PARTITION BY h.booking_id, (h.ct IN ${seqCats}) ORDER BY h.at, h.id) END AS prev_any,`,
    `         COALESCE(sum(CASE WHEN h.ct = 'CHECK_OUT' THEN 1 ELSE 0 END) OVER (PARTITION BY h.booking_id ORDER BY h.at, h.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS deliveries_before`,
    `    FROM h`,
    `), seq2 AS (`,
    `  SELECT s.*, min(s.at) FILTER (WHERE s.ct = 'PENDING_CHECKOUT') OVER (PARTITION BY s.booking_id, s.deliveries_before) AS pending_at`,
    `    FROM seq s`,
    `)`,
    `SELECT x.user_id, max(x.agent_name) AS agent_name, ${opDaySql("x.at")} AS day, ${opShiftSql("x.at")} AS shift, x.ct AS change_type, ${lisbonHourSql("x.at")} AS hour,`,
    `       count(*) AS n,`,
    `       count(*) FILTER (WHERE x.ct = 'MOVEMENT' AND x.prev_cat = 'CHECK_IN') AS parking_moves,`,
    `       count(*) FILTER (WHERE x.ct = 'MOVEMENT' AND ${moveIsSpotSql("x.prev_cat", "x.prev_any")}) AS spot_moves,`,
    `       count(*) FILTER (WHERE x.ct = 'CHECK_OUT' AND x.pending_at IS NOT NULL`,
    `                          AND ${DELIVERED_AT_SQL} - x.pending_at > ${late}::int * interval '1 minute'`,
    `                          AND ${DELIVERED_AT_SQL} - x.pending_at < ${lateMax}::int * interval '1 minute') AS late_deliveries`,
    `  FROM seq2 x`,
    ` WHERE x.at >= ${from}::timestamp`,
    // 49e: também por hora de Lisboa (a avaliação guarda as ações por hora do dia); nunca há mais linhas do que ações
    ` GROUP BY x.user_id, 3, 4, x.ct, 6`,
    ` ORDER BY 3, x.user_id, x.ct, 6`,
    ` LIMIT ${params.add(AGG_ROW_LIMIT * 10)}`,
  ].join("\n");
  return { sql, params: params.values };
}

export interface EngineActionCount {
  agentUserId: string | null;
  agentName: string | null;
  day: string;
  shift: "morning" | "night";
  changeType: string;
  /** 49e: hora de relógio de Lisboa (0–23) destas ações; sem ela → não entra nas contagens por hora. */
  hour?: number;
  n: number;
  parkingMoves: number;
  /** 14 out 2026: destas `n` (MOVEMENT), quantas foram só mudanças de lugar (não contam como movimento) */
  spotMoves: number;
  lateDeliveries: number;
}

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Linha → contagem do motor. PURA. */
export function mapEngineActionCountRow(r: Record<string, unknown>): EngineActionCount {
  const hour = r.hour == null || r.hour === "" ? NaN : Number(r.hour);
  return {
    agentUserId: str(r.user_id),
    agentName: str(r.agent_name),
    day: String(r.day ?? ""),
    shift: r.shift === "morning" ? "morning" : "night",
    changeType: String(r.change_type ?? "?").toUpperCase(),
    ...(Number.isInteger(hour) && hour >= 0 && hour <= 23 ? { hour } : {}),
    n: int(r.n),
    parkingMoves: int(r.parking_moves),
    spotMoves: int(r.spot_moves),
    lateDeliveries: int(r.late_deliveries),
  };
}

/** Ocorrências da app criadas por cada agente, por dia operacional (motor). PURA. */
export function buildEngineOccurrenceCountsSql(opts: { from: string; to: string }): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const from = params.add(opts.from);
  const to = params.add(opts.to);
  const sql = [
    `SELECT o."userId" AS user_id, max(COALESCE(NULLIF(o."agentName", ''), NULLIF(ag."name", ''))) AS agent_name,`,
    `       ${opDaySql(`o."createdAt"`)} AS day, count(*) AS n`,
    `  FROM "Occurrence" o`,
    `  LEFT JOIN "Agent" ag ON ag."userId" = o."userId" AND ag."parkId" = o."parkId"`,
    ` WHERE o."createdAt" >= ${from}::timestamp AND o."createdAt" < ${to}::timestamp`,
    ` GROUP BY o."userId", 3`,
    ` LIMIT ${params.add(AGG_ROW_LIMIT)}`,
  ].join("\n");
  return { sql, params: params.values };
}

export interface EngineOccurrenceCount { agentUserId: string | null; agentName: string | null; day: string; n: number }

export function mapEngineOccurrenceCountRow(r: Record<string, unknown>): EngineOccurrenceCount {
  return { agentUserId: str(r.user_id), agentName: str(r.agent_name), day: String(r.day ?? ""), n: int(r.n) };
}

export interface EngineLiveInputs {
  actions: EngineActionCount[];
  occurrences: EngineOccurrenceCount[];
}

/**
 * Entradas vivas do motor para os dias operacionais [startDay, endDay]
 * (as ações com 3 dias de sequência para trás). Nunca lança.
 */
export async function getEngineLiveInputs(startDay: string, endDay: string, query: Query = multiparkDbQuery): Promise<MultiparkRead<EngineLiveInputs>> {
  return safeMultiparkRead("avaliação (movimentos)", async () => {
    const w = movementWindow(startDay, endDay);
    const lookbackFrom = operationalDayRangeUtc(addDays(startDay, -MOVE_LOOKBACK_DAYS), startDay).start;
    const a = buildEngineActionCountsSql({ lookbackFrom, from: w.from, to: w.to });
    const o = buildEngineOccurrenceCountsSql({ from: w.from, to: w.to });
    const actions = (await query(a.sql, a.params)).map(mapEngineActionCountRow);
    const occurrences = (await query(o.sql, o.params)).map(mapEngineOccurrenceCountRow);
    return { actions, occurrences };
  });
}

// ─── 2. Agregados por agente (dia ou período) ────────────────────────────────

export interface AggregateFilters {
  window: MovementWindow;
  /** true = uma linha por agente × dia operacional; false = por agente no período. */
  byDay: boolean;
  /** Âmbito de cidade (Park.city). undefined = todas; [] = nenhuma. */
  cities?: string[];
  /** 42a: só estes parques (filtro de marca). undefined = todos. */
  parkIds?: string[];
  /** Só estes agentes (History.userId). */
  userIds?: string[];
}

const typeAlias = (t: MovementChangeType) => `t_${t.toLowerCase()}`;

/**
 * Movimentos por agente: contagens por tipo, reservas, 1.ª/última ação,
 * plataformas. 14 out 2026: `spot_changes` = os MOVEMENT que são só mudanças
 * de lugar (a regra de shared/multiparkMovements.ts, pela ação anterior da
 * MESMA reserva — lida desde MOVE_LOOKBACK_DAYS antes, de qualquer agente).
 * Antes contava UPDATE com "spot"/"garage" no modifiedFields, que a Multipark
 * não grava (a mudança de lugar é um MOVEMENT): dava sempre 0. PURA.
 */
export function buildAgentHistoryAggSql(f: AggregateFilters): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const lookbackFrom = operationalDayRangeUtc(addDays(f.window.startDay, -MOVE_LOOKBACK_DAYS), f.window.startDay).start;
  const lb = params.add(lookbackFrom);
  const from = params.add(f.window.from);
  const to = params.add(f.window.to);
  const conds = [
    `h."actionTime" >= ${from}::timestamp`,
    `h."actionTime" < ${to}::timestamp`,
  ];
  const ids = idList(f.userIds, params, `h."userId"`);
  if (ids) conds.push(ids);
  const city = cityCondition(f.cities, params);
  if (city) conds.push(city);
  const park = parkCondition(f.parkIds, params);
  if (park) conds.push(park);
  const dayCol = f.byDay ? `, ${opDaySql(`h."actionTime"`)} AS day` : `, NULL AS day`;
  const perType = MOVEMENT_CHANGE_TYPES.map((t) => `count(*) FILTER (WHERE h."changeType"::text = '${t}') AS ${typeAlias(t)}`);
  const sql = [
    `WITH ${moveSeqCteSql(lb, to)}`,
    `SELECT h."userId" AS user_id, max(COALESCE(NULLIF(h."agentName", ''), NULLIF(ag."name", ''))) AS agent_name${dayCol},`,
    `       count(*) AS total,`,
    `       ${perType.join(",\n       ")},`,
    // 14 out 2026: mudanças de lugar = MOVEMENT que não leva ao parque nem tira para a entrega
    `       count(*) FILTER (WHERE h."changeType"::text = 'MOVEMENT' AND ${moveIsSpotSql("sq.prev_cat", "sq.prev_any")}) AS spot_changes,`,
    `       count(DISTINCT h."bookingId") AS bookings,`,
    `       ${ts(`min(h."actionTime")`)} AS first_at,`,
    `       ${ts(`max(h."actionTime")`)} AS last_at,`,
    `       string_agg(DISTINCT NULLIF(h."platform", ''), ',') AS platforms`,
    `  FROM "History" h`,
    `  LEFT JOIN seq sq ON sq.id = h."id"`,
    `  LEFT JOIN "Booking" b ON b."id" = h."bookingId"`,
    `  LEFT JOIN "Park" p ON p."id" = b."parkId"`,
    `  LEFT JOIN "Agent" ag ON ag."userId" = h."userId" AND ag."parkId" = b."parkId"`,
    ` WHERE ${conds.join(" AND ")}`,
    ` GROUP BY h."userId"${f.byDay ? ", 3" : ""}`,
    ` ORDER BY total DESC`,
    ` LIMIT ${params.add(AGG_ROW_LIMIT)}`,
  ].join("\n");
  return { sql, params: params.values };
}

/** Check-ins/check-outs assinados na reserva (Booking.checkInDriverId / checkOutDriverId). PURA. */
export function buildAgentBookingPhasesSql(f: AggregateFilters): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const from = params.add(f.window.from);
  const to = params.add(f.window.to);
  const outer: string[] = [];
  const ids = idList(f.userIds, params, `x.user_id`);
  if (ids) outer.push(ids);
  const city = cityCondition(f.cities, params);
  if (city) outer.push(city);
  const park = parkCondition(f.parkIds, params);
  if (park) outer.push(park);
  const sql = [
    `SELECT x.user_id${f.byDay ? `, ${opDaySql("x.at")} AS day` : `, NULL AS day`},`,
    `       count(*) FILTER (WHERE x.kind = 'in') AS check_ins,`,
    `       count(*) FILTER (WHERE x.kind = 'out') AS check_outs`,
    `  FROM (`,
    `    SELECT b."checkInDriverId" AS user_id, b."checkIn" AS at, 'in' AS kind, b."parkId" AS park_id`,
    `      FROM "Booking" b`,
    `     WHERE b."checkInDriverId" IS NOT NULL AND b."status"::text <> 'CANCELLED'`,
    `       AND b."checkIn" >= ${from}::timestamp AND b."checkIn" < ${to}::timestamp`,
    `    UNION ALL`,
    `    SELECT b."checkOutDriverId", b."checkOut", 'out', b."parkId"`,
    `      FROM "Booking" b`,
    `     WHERE b."checkOutDriverId" IS NOT NULL AND b."status"::text <> 'CANCELLED'`,
    `       AND b."checkOut" >= ${from}::timestamp AND b."checkOut" < ${to}::timestamp`,
    `  ) x`,
    `  LEFT JOIN "Park" p ON p."id" = x.park_id`,
    ` WHERE ${outer.length ? outer.join(" AND ") : "TRUE"}`,
    ` GROUP BY x.user_id${f.byDay ? ", 2" : ""}`,
    ` LIMIT ${params.add(AGG_ROW_LIMIT)}`,
  ].join("\n");
  return { sql, params: params.values };
}

/** Ocorrências criadas e resolvidas por cada agente. PURA. */
export function buildAgentOccurrenceAggSql(f: AggregateFilters): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const from = params.add(f.window.from);
  const to = params.add(f.window.to);
  const outer: string[] = [];
  const ids = idList(f.userIds, params, `x.user_id`);
  if (ids) outer.push(ids);
  const city = cityCondition(f.cities, params);
  if (city) outer.push(city);
  const park = parkCondition(f.parkIds, params);
  if (park) outer.push(park);
  const sql = [
    `SELECT x.user_id, max(x.agent_name) AS agent_name${f.byDay ? `, ${opDaySql("x.at")} AS day` : `, NULL AS day`},`,
    `       count(*) FILTER (WHERE x.kind = 'created') AS created,`,
    `       count(*) FILTER (WHERE x.kind = 'resolved') AS resolved`,
    `  FROM (`,
    `    SELECT o."userId" AS user_id, NULLIF(o."agentName", '') AS agent_name, o."createdAt" AS at, 'created' AS kind, o."parkId" AS park_id`,
    `      FROM "Occurrence" o`,
    `     WHERE o."createdAt" >= ${from}::timestamp AND o."createdAt" < ${to}::timestamp`,
    `    UNION ALL`,
    `    SELECT o."resolvedById", NULLIF(o."resolvedByName", ''), o."resolvedAt", 'resolved', o."parkId"`,
    `      FROM "Occurrence" o`,
    `     WHERE o."resolvedById" IS NOT NULL AND o."resolvedAt" >= ${from}::timestamp AND o."resolvedAt" < ${to}::timestamp`,
    `  ) x`,
    `  LEFT JOIN "Park" p ON p."id" = x.park_id`,
    ` WHERE ${outer.length ? outer.join(" AND ") : "TRUE"}`,
    ` GROUP BY x.user_id${f.byDay ? ", 3" : ""}`,
    ` LIMIT ${params.add(AGG_ROW_LIMIT)}`,
  ].join("\n");
  return { sql, params: params.values };
}

/**
 * Avaliações dos clientes (BookingReview) nas reservas em que o agente fez o
 * check-in ou o check-out (uma vez por agente, mesmo que tenha feito os dois).
 * O dia é o da avaliação. PURA.
 */
export function buildAgentReviewAggSql(f: AggregateFilters): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const conds = [
    `r."createdAt" >= ${params.add(f.window.from)}::timestamp`,
    `r."createdAt" < ${params.add(f.window.to)}::timestamp`,
  ];
  const ids = idList(f.userIds, params, `d.user_id`);
  if (ids) conds.push(ids);
  const city = cityCondition(f.cities, params);
  if (city) conds.push(city);
  const park = parkCondition(f.parkIds, params);
  if (park) conds.push(park);
  const sql = [
    `SELECT d.user_id${f.byDay ? `, ${opDaySql(`r."createdAt"`)} AS day` : `, NULL AS day`},`,
    `       count(*) AS reviews, avg(r."rating") AS avg_rating, count(*) FILTER (WHERE r."rating" <= 3) AS low_reviews`,
    `  FROM "BookingReview" r`,
    `  JOIN "Booking" b ON b."id" = r."bookingId"`,
    `  CROSS JOIN LATERAL (SELECT DISTINCT v.user_id FROM (VALUES (b."checkInDriverId"), (b."checkOutDriverId")) v(user_id) WHERE v.user_id IS NOT NULL) d`,
    `  LEFT JOIN "Park" p ON p."id" = r."parkId"`,
    ` WHERE ${conds.join(" AND ")}`,
    ` GROUP BY d.user_id${f.byDay ? ", 2" : ""}`,
    ` LIMIT ${params.add(AGG_ROW_LIMIT)}`,
  ].join("\n");
  return { sql, params: params.values };
}

/** Nomes dos agentes (Agent.name) para quem não tem nome nas outras tabelas. PURA. */
export function buildAgentNamesSql(userIds: string[]): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const ids = idList(userIds, params, `a."userId"`) ?? "FALSE";
  return {
    sql: `SELECT a."userId" AS user_id, max(NULLIF(a."name", '')) AS name FROM "Agent" a WHERE ${ids} GROUP BY a."userId"`,
    params: params.values,
  };
}

export interface AgentMovementSummary {
  agentUserId: string;
  agentName: string | null;
  /** Dia operacional (só quando byDay). */
  day: string | null;
  /** Todas as ações no History. */
  total: number;
  byType: Record<string, number>;
  /** CHECK_IN */
  recolhas: number;
  /** CHECK_OUT */
  entregas: number;
  /** MOVEMENT que toca no parque (levar ao parque ou tirar para a entrega) — 14 out 2026 */
  movements: number;
  /** MOVEMENT que é só mudança de lugar (conta em `total`, não em `movements`); em `byType` é SPOT_CHANGE */
  spotChanges: number;
  /** Reservas diferentes em que mexeu. */
  bookings: number;
  firstAt: string | null;
  lastAt: string | null;
  platforms: string[];
  /** Reservas em que ficou como condutor do check-in / check-out. */
  checkInsSigned: number;
  checkOutsSigned: number;
  occurrencesCreated: number;
  occurrencesResolved: number;
  reviews: number;
  reviewAvg: number | null;
  reviewsLow: number;
}

function emptySummary(agentUserId: string, day: string | null): AgentMovementSummary {
  return {
    agentUserId, agentName: null, day, total: 0, byType: {}, recolhas: 0, entregas: 0, movements: 0, spotChanges: 0,
    bookings: 0, firstAt: null, lastAt: null, platforms: [], checkInsSigned: 0, checkOutsSigned: 0,
    occurrencesCreated: 0, occurrencesResolved: 0, reviews: 0, reviewAvg: null, reviewsLow: 0,
  };
}

/**
 * Junta as quatro leituras numa linha por agente (× dia). PURA.
 * Agentes que só aparecem nas ocorrências/fases/avaliações também entram.
 */
export function mergeAgentAggregates(input: {
  history: Record<string, unknown>[];
  phases: Record<string, unknown>[];
  occurrences: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  names?: Record<string, unknown>[];
}): AgentMovementSummary[] {
  const out = new Map<string, AgentMovementSummary>();
  const get = (r: Record<string, unknown>): AgentMovementSummary | null => {
    const id = str(r.user_id);
    if (!id) return null;
    const day = str(r.day);
    const k = `${id}|${day ?? ""}`;
    let s = out.get(k);
    if (!s) { s = emptySummary(id, day); out.set(k, s); }
    return s;
  };
  for (const r of input.history) {
    const s = get(r);
    if (!s) continue;
    s.agentName = s.agentName ?? str(r.agent_name);
    s.total += int(r.total);
    for (const t of MOVEMENT_CHANGE_TYPES) {
      const n = int(r[typeAlias(t)]);
      if (n) s.byType[t] = (s.byType[t] ?? 0) + n;
    }
    s.spotChanges += int(r.spot_changes);
    s.bookings += int(r.bookings);
    const first = toIsoUtc(r.first_at), last = toIsoUtc(r.last_at);
    if (first && (!s.firstAt || first < s.firstAt)) s.firstAt = first;
    if (last && (!s.lastAt || last > s.lastAt)) s.lastAt = last;
    const plats = String(r.platforms ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    s.platforms = Array.from(new Set([...s.platforms, ...plats])).sort();
  }
  for (const r of input.phases) {
    const s = get(r);
    if (!s) continue;
    s.checkInsSigned += int(r.check_ins);
    s.checkOutsSigned += int(r.check_outs);
  }
  for (const r of input.occurrences) {
    const s = get(r);
    if (!s) continue;
    s.agentName = s.agentName ?? str(r.agent_name);
    s.occurrencesCreated += int(r.created);
    s.occurrencesResolved += int(r.resolved);
  }
  for (const r of input.reviews) {
    const s = get(r);
    if (!s) continue;
    const n = int(r.reviews);
    const avg = numOrNull(r.avg_rating);
    if (n > 0 && avg != null) {
      const prev = (s.reviewAvg ?? 0) * s.reviews;
      s.reviewAvg = Math.round(((prev + avg * n) / (s.reviews + n)) * 100) / 100;
    }
    s.reviews += n;
    s.reviewsLow += int(r.low_reviews);
  }
  // 14 out 2026: as mudanças de lugar saem dos movimentos (byType.MOVEMENT) para SPOT_CHANGE
  for (const s of out.values()) {
    const rawMoves = s.byType.MOVEMENT ?? 0;
    s.spotChanges = Math.min(s.spotChanges, rawMoves);
    if (s.spotChanges > 0) {
      if (rawMoves - s.spotChanges > 0) s.byType.MOVEMENT = rawMoves - s.spotChanges; else delete s.byType.MOVEMENT;
      s.byType[SPOT_CHANGE_KEY] = s.spotChanges;
    }
    s.recolhas = s.byType.CHECK_IN ?? 0;
    s.entregas = s.byType.CHECK_OUT ?? 0;
    s.movements = s.byType.MOVEMENT ?? 0;
  }
  const names = new Map<string, string>();
  for (const r of input.names ?? []) {
    const id = str(r.user_id), name = str(r.name);
    if (id && name) names.set(id, name);
  }
  for (const s of out.values()) if (!s.agentName) s.agentName = names.get(s.agentUserId) ?? null;
  return Array.from(out.values()).sort((a, b) =>
    (a.day ?? "") === (b.day ?? "") ? b.total - a.total || a.agentUserId.localeCompare(b.agentUserId) : (a.day ?? "") < (b.day ?? "") ? -1 : 1);
}

/**
 * Soma vários resumos (a mesma pessoa com várias contas de agente). PURA.
 * Devolve null quando a lista está vazia.
 */
export function sumAgentSummaries(list: AgentMovementSummary[]): (AgentMovementSummary & { agentUserIds: string[] }) | null {
  if (list.length === 0) return null;
  const out: AgentMovementSummary & { agentUserIds: string[] } = { ...emptySummary(list[0].agentUserId, list[0].day), agentUserIds: [] };
  let reviewSum = 0;
  for (const s of list) {
    out.agentUserIds.push(s.agentUserId);
    out.agentName = out.agentName ?? s.agentName;
    out.total += s.total;
    for (const [k, v] of Object.entries(s.byType)) out.byType[k] = (out.byType[k] ?? 0) + v;
    out.recolhas += s.recolhas;
    out.entregas += s.entregas;
    out.movements += s.movements;
    out.spotChanges += s.spotChanges;
    out.bookings += s.bookings;
    if (s.firstAt && (!out.firstAt || s.firstAt < out.firstAt)) out.firstAt = s.firstAt;
    if (s.lastAt && (!out.lastAt || s.lastAt > out.lastAt)) out.lastAt = s.lastAt;
    out.platforms = Array.from(new Set([...out.platforms, ...s.platforms])).sort();
    out.checkInsSigned += s.checkInsSigned;
    out.checkOutsSigned += s.checkOutsSigned;
    out.occurrencesCreated += s.occurrencesCreated;
    out.occurrencesResolved += s.occurrencesResolved;
    if (s.reviewAvg != null) reviewSum += s.reviewAvg * s.reviews;
    out.reviews += s.reviews;
    out.reviewsLow += s.reviewsLow;
  }
  out.agentUserIds = Array.from(new Set(out.agentUserIds));
  out.reviewAvg = out.reviews > 0 ? Math.round((reviewSum / out.reviews) * 100) / 100 : null;
  return out;
}

/** Ids de agente (Agent.userId) com este nome (sem distinguir maiúsculas). PURA. */
export function buildAgentIdsByNameSql(name: string): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const n = params.add(String(name ?? "").trim().toLowerCase().slice(0, 200));
  return {
    sql: `SELECT DISTINCT a."userId" AS user_id FROM "Agent" a WHERE lower(trim(a."name")) = ${n} LIMIT ${params.add(20)}`,
    params: params.values,
  };
}

/** Ids de agente por nome (para quem só tem o nome na escala). Nunca lança. */
export async function findAgentIdsByName(name: string, query: Query = multiparkDbQuery): Promise<MultiparkRead<string[]>> {
  return safeMultiparkRead("agentes (por nome)", async () => {
    if (!String(name ?? "").trim()) return [];
    const { sql, params } = buildAgentIdsByNameSql(name);
    return (await query(sql, params)).map((r) => str(r.user_id)).filter((x): x is string => !!x);
  });
}

export interface AgentSummaryOptions {
  startDay: string;
  endDay?: string;
  byDay?: boolean;
  cities?: string[];
  parkIds?: string[];
  userIds?: string[];
}

/** Agregados vivos por agente (× dia). Quatro leituras curtas. Nunca lança. */
export async function getAgentMovementSummaries(opts: AgentSummaryOptions, query: Query = multiparkDbQuery): Promise<MultiparkRead<AgentMovementSummary[]>> {
  return safeMultiparkRead("avaliação (agregados)", async () => {
    const f: AggregateFilters = { window: movementWindow(opts.startDay, opts.endDay ?? opts.startDay), byDay: !!opts.byDay, cities: opts.cities, parkIds: opts.parkIds, userIds: opts.userIds };
    const run = async (b: { sql: string; params: SqlParam[] }) => query(b.sql, b.params);
    const history = await run(buildAgentHistoryAggSql(f));
    const phases = await run(buildAgentBookingPhasesSql(f));
    const occurrences = await run(buildAgentOccurrenceAggSql(f));
    const reviews = await run(buildAgentReviewAggSql(f));
    let merged = mergeAgentAggregates({ history, phases, occurrences, reviews });
    const missing = Array.from(new Set(merged.filter((s) => !s.agentName).map((s) => s.agentUserId))).slice(0, MAX_AGENT_IDS);
    if (missing.length) {
      const names = await run(buildAgentNamesSql(missing));
      merged = mergeAgentAggregates({ history, phases, occurrences, reviews, names });
    }
    return merged;
  });
}

// ─── 3. Detalhe: os movimentos de um agente num dia ──────────────────────────

export interface MovementDetailFilters {
  window: MovementWindow;
  userIds: string[];
  cities?: string[];
  limit?: number;
}

/** Lista dos movimentos (mais antigos primeiro), com reserva, matrícula e parque. PURA. */
export function buildAgentMovementDetailSql(f: MovementDetailFilters): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const conds = [
    `h."actionTime" >= ${params.add(f.window.from)}::timestamp`,
    `h."actionTime" < ${params.add(f.window.to)}::timestamp`,
    idList(f.userIds, params, `h."userId"`) ?? "FALSE",
  ];
  const city = cityCondition(f.cities, params);
  if (city) conds.push(city);
  const limit = Math.min(Math.max(Math.floor(Number(f.limit ?? DETAIL_DEFAULT_LIMIT)) || DETAIL_DEFAULT_LIMIT, 1), DETAIL_MAX_LIMIT);
  const sql = [
    `SELECT h."id" AS id, ${ts(`h."actionTime"`)} AS action_time, h."changeType"::text AS change_type,`,
    `       h."userId" AS user_id, COALESCE(NULLIF(h."agentName", ''), NULLIF(ag."name", '')) AS agent_name,`,
    `       h."bookingId" AS booking_id, NULLIF(b."allocation", '') AS booking_code, v."licensePlate" AS plate,`,
    `       p."name" AS park_name, p."city" AS park_city, NULLIF(h."platform", '') AS platform,`,
    `       left(h."modifiedFields", 300) AS modified_fields, left(h."remarks", 300) AS remarks`,
    `  FROM "History" h`,
    `  LEFT JOIN "Booking" b ON b."id" = h."bookingId"`,
    `  LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
    `  LEFT JOIN "Park" p ON p."id" = b."parkId"`,
    `  LEFT JOIN "Agent" ag ON ag."userId" = h."userId" AND ag."parkId" = b."parkId"`,
    ` WHERE ${conds.join(" AND ")}`,
    ` ORDER BY h."actionTime", h."id"`,
    ` LIMIT ${params.add(limit + 1)}`,
  ].join("\n");
  return { sql, params: params.values };
}

export interface AgentMovement {
  id: string;
  actionTime: string | null;
  /** o tipo da History; 14 out 2026: um MOVEMENT que é só mudança de lugar vem como SPOT_CHANGE */
  changeType: string;
  /** só nos MOVEMENT: levar ao parque, tirar para a entrega ou mudança de lugar (null = não deu para saber) */
  moveKind?: MoveKind | null;
  agentUserId: string | null;
  agentName: string | null;
  bookingId: string | null;
  bookingCode: string | null;
  plate: string | null;
  parkName: string | null;
  parkCity: string | null;
  platform: string | null;
  modifiedFields: string | null;
  remarks: string | null;
}

export function mapAgentMovementRow(r: Record<string, unknown>): AgentMovement {
  return {
    id: String(r.id ?? ""),
    actionTime: toIsoUtc(r.action_time),
    changeType: String(r.change_type ?? "?").toUpperCase(),
    agentUserId: str(r.user_id),
    agentName: str(r.agent_name),
    bookingId: str(r.booking_id),
    bookingCode: str(r.booking_code),
    plate: str(r.plate),
    parkName: str(r.park_name),
    parkCity: str(r.park_city),
    platform: str(r.platform),
    modifiedFields: str(r.modified_fields),
    remarks: str(r.remarks),
  };
}

/** Movimentos de um agente (um ou mais ids) num dia operacional. Nunca lança. */
export async function getAgentDayMovements(
  opts: { day: string; userIds: string[]; cities?: string[]; limit?: number },
  query: Query = multiparkDbQuery,
): Promise<MultiparkRead<{ rows: AgentMovement[]; truncated: boolean }>> {
  return safeMultiparkRead("avaliação (movimentos do dia)", async () => {
    const limit = Math.min(Math.max(Math.floor(Number(opts.limit ?? DETAIL_DEFAULT_LIMIT)) || DETAIL_DEFAULT_LIMIT, 1), DETAIL_MAX_LIMIT);
    if (opts.userIds.length === 0) return { rows: [], truncated: false };
    const { sql, params } = buildAgentMovementDetailSql({ window: movementWindow(opts.day), userIds: opts.userIds, cities: opts.cities, limit });
    const rows = await query(sql, params);
    const list = rows.slice(0, limit).map(mapAgentMovementRow);
    // 14 out 2026: cada MOVEMENT diz se tocou no parque ou se foi só mudança de lugar
    const kinds = await readMoveKinds(list.map((m) => ({ id: m.id, bookingId: m.bookingId ?? "", changeType: m.changeType, actionTime: m.actionTime ?? "" })), query);
    return { rows: withMoveKinds(list, kinds), truncated: rows.length > limit };
  });
}

// ─── 3b. Movimento × mudança de lugar numa lista solta (detalhes) ────────────

/** Teto das linhas lidas para classificar os movimentos de uma lista. */
export const MOVE_SEQ_LIMIT = 20_000;
/** Reservas por leitura (IN (…)). */
export const MOVE_SEQ_BOOKINGS_PER_READ = 500;

/**
 * As ações que decidem o tipo de movimento (recolhas, entregas, movimentos,
 * cancelamentos, pedidos e inícios de entrega) destas reservas em [from, to).
 * Uma leitura da "History" (sem índice em bookingId: é sequencial, como as
 * outras). PURA.
 */
export function buildBookingSequenceSql(f: { bookingIds: string[]; from: string; to: string; limit?: number }): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const ids = Array.from(new Set(f.bookingIds.map((x) => String(x ?? "").trim()).filter(Boolean))).slice(0, MOVE_SEQ_BOOKINGS_PER_READ);
  const sql = [
    `SELECT h."id" AS id, h."bookingId" AS booking_id, upper(h."changeType"::text) AS change_type, ${ts(`h."actionTime"`)} AS action_time`,
    `  FROM "History" h`,
    ` WHERE ${ids.length ? `h."bookingId" IN (${ids.map((id) => params.add(id)).join(", ")})` : "FALSE"}`,
    `   AND h."actionTime" >= ${params.add(f.from)}::timestamp AND h."actionTime" < ${params.add(f.to)}::timestamp`,
    `   AND upper(h."changeType"::text) IN ${MOVE_SEQ_CATS_SQL}`,
    ` ORDER BY h."bookingId", h."actionTime", h."id"`,
    ` LIMIT ${params.add(Math.max(1, Math.min(f.limit ?? MOVE_SEQ_LIMIT, MOVE_SEQ_LIMIT)))}`,
  ].join("\n");
  return { sql, params: params.values };
}

const utcStamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const rowMs = (t: string) => {
  const v = String(t ?? "").trim();
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v) ? `${v.replace(" ", "T")}Z` : v);
  return Number.isFinite(ms) ? ms : NaN;
};

/**
 * Para as linhas de uma lista (de um agente), que tipo de movimento é cada
 * MOVEMENT — lê o que veio antes na mesma reserva (de qualquer agente, desde
 * MOVE_LOOKBACK_DAYS antes). Sem MOVEMENT não lê nada. null = a leitura
 * falhou (a lista fica como estava). Nunca lança.
 */
export async function readMoveKinds(
  rows: ReadonlyArray<{ id: string; bookingId: string; changeType: string | null; actionTime: string }>,
  query: Query = multiparkDbQuery,
): Promise<Map<string, MoveKind> | null> {
  const moves = rows.filter((r) => String(r.changeType ?? "").toUpperCase() === "MOVEMENT" && r.bookingId && Number.isFinite(rowMs(r.actionTime)));
  if (!moves.length) return new Map();
  try {
    const times = moves.map((r) => rowMs(r.actionTime));
    const from = utcStamp(Math.min(...times) - MOVE_LOOKBACK_DAYS * 86_400_000);
    const to = utcStamp(Math.max(...times) + 1000);
    const bookingIds = Array.from(new Set(moves.map((r) => r.bookingId)));
    const seq: Array<{ id: string; bookingId: string; changeType: string; actionTime: string }> = [];
    for (let i = 0; i < bookingIds.length; i += MOVE_SEQ_BOOKINGS_PER_READ) {
      const { sql, params } = buildBookingSequenceSql({ bookingIds: bookingIds.slice(i, i + MOVE_SEQ_BOOKINGS_PER_READ), from, to });
      for (const r of await query(sql, params)) {
        seq.push({ id: String(r.id ?? ""), bookingId: String(r.booking_id ?? ""), changeType: String(r.change_type ?? ""), actionTime: String(r.action_time ?? "") });
      }
    }
    return moveKindsOf(seq);
  } catch {
    return null;
  }
}

/** Põe o tipo de movimento em cada linha (a mudança de lugar passa a SPOT_CHANGE). PURA. */
export function withMoveKinds<T extends { id: string; changeType: string }>(rows: T[], kinds: Map<string, MoveKind> | null): Array<T & { moveKind: MoveKind | null }> {
  return rows.map((r) => {
    const kind = String(r.changeType).toUpperCase() === "MOVEMENT" ? kinds?.get(r.id) ?? null : null;
    return { ...r, changeType: actionKeyOf(r.changeType, kind), moveKind: kind };
  });
}

// ─── 4. Recolhas e entregas de agentes num intervalo (terminal no ponto) ─────
//
// Jorge, 7 out 2026: o troço de terminal fechado fora do aeroporto conta até à
// ÚLTIMA recolha ou entrega feita pelo extra (shared/pontoTerminal.ts
// resolveTerminalByLastService). As mesmas definições desta página:
//   recolha = ação CHECK_IN da History, entrega = ação CHECK_OUT (os
//   `recolhas`/`entregas` dos agregados acima), feita POR ELE — History.userId
//   é um dos agentes dele — ou assinada a ele na reserva
//   (Booking.checkInDriverId / checkOutDriverId, como buildAgentBookingPhasesSql).
// O instante é o da ação na History (UTC, sem fuso). Os agentes vêm da ligação
// explícita da ficha (por ID, nunca por nome).

/** Teto das linhas de recolhas/entregas numa leitura (7 dias × agentes do terminal). */
export const SERVICE_INSTANTS_LIMIT = 5_000;

export interface AgentServiceInstantsFilters {
  /** agentes (History.userId / Booking.check*DriverId) */
  userIds: string[];
  /** "YYYY-MM-DD HH:MM:SS" UTC, inclusive dos dois lados */
  from: string;
  to: string;
  limit?: number;
}

/** Recolhas (CHECK_IN) e entregas (CHECK_OUT) dos agentes no intervalo, as mais recentes primeiro. PURA. */
export function buildAgentServiceInstantsSql(f: AgentServiceInstantsFilters): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const from = params.add(f.from);
  const to = params.add(f.to);
  const clean = Array.from(new Set(f.userIds.map((s) => String(s ?? "").trim()).filter(Boolean))).slice(0, MAX_AGENT_IDS);
  // a mesma lista de $n nas três colunas (o Postgres aceita repetir marcadores)
  const ids = clean.length ? clean.map((id) => params.add(id)).join(", ") : null;
  const limit = Math.min(Math.max(Math.floor(Number(f.limit ?? SERVICE_INSTANTS_LIMIT)) || SERVICE_INSTANTS_LIMIT, 1), SERVICE_INSTANTS_LIMIT);
  const who = ids
    ? `(h."userId" IN (${ids})` +
      ` OR (h."changeType"::text = 'CHECK_IN' AND b."checkInDriverId" IN (${ids}))` +
      ` OR (h."changeType"::text = 'CHECK_OUT' AND b."checkOutDriverId" IN (${ids})))`
    : "FALSE";
  const sql = [
    `SELECT h."id" AS id, ${ts(`h."actionTime"`)} AS action_time, upper(h."changeType"::text) AS change_type,`,
    `       h."userId" AS user_id,`,
    `       CASE WHEN h."changeType"::text = 'CHECK_IN' THEN b."checkInDriverId" ELSE b."checkOutDriverId" END AS driver_id,`,
    `       NULLIF(b."allocation", '') AS booking_code`,
    `  FROM "History" h`,
    `  LEFT JOIN "Booking" b ON b."id" = h."bookingId"`,
    ` WHERE h."actionTime" >= ${from}::timestamp AND h."actionTime" <= ${to}::timestamp`,
    `   AND h."changeType"::text IN ('CHECK_IN', 'CHECK_OUT')`,
    `   AND ${who}`,
    ` ORDER BY h."actionTime" DESC, h."id" DESC`,
    ` LIMIT ${params.add(limit + 1)}`,
  ].join("\n");
  return { sql, params: params.values };
}

export interface AgentServiceInstant {
  /** UTC "YYYY-MM-DD HH:MM:SS" */
  at: string;
  /** "CHECK_IN" (recolha) | "CHECK_OUT" (entrega) */
  kind: string;
  /** quem registou a ação (History.userId) */
  agentUserId: string | null;
  /** quem ficou assinado na reserva (checkInDriverId / checkOutDriverId) */
  driverId: string | null;
  bookingCode: string | null;
}

/** Linha → recolha/entrega (sem instante → null). PURA. */
export function mapAgentServiceInstantRow(r: Record<string, unknown>): AgentServiceInstant | null {
  const at = str(r.action_time);
  if (!at) return null;
  return {
    at: at.slice(0, 19),
    kind: String(r.change_type ?? "").toUpperCase(),
    agentUserId: str(r.user_id),
    driverId: str(r.driver_id),
    bookingCode: str(r.booking_code),
  };
}

/** A ação é de algum destes agentes (registou-a ou ficou assinado)? PURA. */
export function serviceInstantBelongsTo(a: Pick<AgentServiceInstant, "agentUserId" | "driverId">, agentIds: ReadonlySet<string>): boolean {
  return (!!a.agentUserId && agentIds.has(a.agentUserId)) || (!!a.driverId && agentIds.has(a.driverId));
}

/**
 * Recolhas e entregas dos agentes no intervalo [from, to] (UTC). Nunca lança.
 * `truncated` = havia mais do que o teto (as mais antigas ficaram de fora).
 */
export async function getAgentServiceInstants(
  f: AgentServiceInstantsFilters,
  query: Query = multiparkDbQuery,
): Promise<MultiparkRead<{ rows: AgentServiceInstant[]; truncated: boolean }>> {
  return safeMultiparkRead("terminal no ponto (recolhas/entregas)", async () => {
    if (!f.userIds.some((x) => String(x ?? "").trim())) return { rows: [], truncated: false };
    const limit = Math.min(Math.max(Math.floor(Number(f.limit ?? SERVICE_INSTANTS_LIMIT)) || SERVICE_INSTANTS_LIMIT, 1), SERVICE_INSTANTS_LIMIT);
    const { sql, params } = buildAgentServiceInstantsSql({ ...f, limit });
    const raw = await query(sql, params);
    const rows = raw.slice(0, limit).map(mapAgentServiceInstantRow).filter((x): x is AgentServiceInstant => !!x);
    return { rows, truncated: raw.length > limit };
  });
}
