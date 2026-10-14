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
import { LATE_AFTER_REQUEST_MINUTES, LATE_SERVICE_MAX_MINUTES, LATE_SERVICE_MINUTES } from "../../shared/evaluationRules";
import { MOVEMENT_CHANGE_TYPES, MOVEMENT_GARAGE_KEYS, MOVEMENT_PATTERNS, MOVEMENT_SPOT_KEYS, displayChangeType, type MovementChangeType } from "../../shared/multiparkMovements";

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

// ─── Que movimento foi: os MESMOS padrões de shared/multiparkMovements.ts (classifyMovement) ─
/** Os padrões POSIX partilhados (também usados pelo classifyMovement em JS). */
export const MOVEMENT_SQL_PATTERNS = MOVEMENT_PATTERNS;

/** Valor `from`/`to` normalizado (sem aspas, aparado, minúsculas; ''/null → NULL) — igual ao placeValue do JS. */
const placeSideSql = (col: string, keys: readonly string[], side: "from" | "to") =>
  `COALESCE(${keys.map((k) => `NULLIF(NULLIF(lower(trim(btrim(substring(${col} from '${MOVEMENT_PATTERNS.side(k, side)}'), '"'))), ''), 'null')`).join(", ")})`;

/**
 * Tipo de uma linha MOVEMENT pelo modifiedFields (texto COMPLETO, nunca o
 * cortado): 'inicio' (status → MOVING, sem garagem/lugar), 'arrumar' (sem
 * garagem de origem), 'lugar' (mesma garagem), 'parques' (garagens
 * diferentes) ou 'antigo' (sem dados). `col` tem de ser texto não nulo
 * (COALESCE(…, '')). A mesma árvore do classifyMovement. PURA.
 */
export function movementKindSql(col: string): string {
  const P = MOVEMENT_PATTERNS, G = MOVEMENT_GARAGE_KEYS, S = MOVEMENT_SPOT_KEYS;
  const hasG = `${col} ~ '${P.hasKey(G)}'`, hasS = `${col} ~ '${P.hasKey(S)}'`;
  const plain = (keys: readonly string[]) => `${col} ~ '${P.plainKey(keys)}'`;
  const moving = `${col} ~* '${P.moving}'`;
  const gf = placeSideSql(col, G, "from"), gt = placeSideSql(col, G, "to"), sf = placeSideSql(col, S, "from");
  return [
    `CASE`,
    ` WHEN NOT (${hasG} OR ${hasS}) THEN CASE WHEN ${moving} THEN 'inicio' ELSE 'antigo' END`,
    ` WHEN ${plain(G)} OR ${plain(S)} THEN 'antigo'`,
    ` WHEN ${hasG} THEN CASE WHEN ${gf} IS NULL THEN 'arrumar' WHEN ${gf} <> COALESCE(${gt}, '') THEN 'parques' ELSE 'lugar' END`,
    ` WHEN ${sf} IS NULL THEN 'arrumar'`,
    ` ELSE 'lugar'`,
    `END`,
  ].join("");
}

/** Hora marcada da entrega numa linha CHECK_OUT (`modifiedFields.checkOut.from`) como texto ISO; NULL se não houver. */
export const scheduledCheckOutTextSql = (col: string) => `substring(${col} from '${MOVEMENT_PATTERNS.checkOutFrom}')`;
/** O texto → timestamp UTC sem fuso, só se for uma data válida (pg_input_is_valid: Postgres ≥ 16; a Multipark está no 17). */
export const scheduledCheckOutAtSql = (txt: string) =>
  `CASE WHEN pg_input_is_valid(${txt}, 'timestamptz') THEN (${txt}::timestamptz AT TIME ZONE 'UTC') END`;

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
 *  - cada MOVEMENT classifica-se pelo modifiedFields (movementKindSql; Jorge,
 *    14 out 2026): o INÍCIO (status → MOVING) não conta; o fim sem garagem de
 *    origem é "levar ao parque"; a mesma garagem é "mudança de lugar"
 *    (`spot_changes`, não é movimento); garagens diferentes é "movimento entre
 *    parques". `moves` = levar ao parque + entre parques (+ os antigos);
 *  - formato antigo (sem garagem/lugar): "levar ao parque" = MOVEMENT cuja ação
 *    anterior da MESMA reserva (recolha/entrega/movimento/cancelamento, sem os
 *    inícios) foi uma recolha (CHECK_IN);
 *  - entrega atrasada (shared/evaluationRules.ts): com o 1.º PENDING_CHECKOUT
 *    (desde a entrega anterior) antes/à hora MARCADA, ou sem pedido: CHECK_OUT
 *    depois da marcada + LATE_SERVICE_MINUTES; com o pedido DEPOIS da marcada,
 *    ou sem hora marcada: depois do pedido + LATE_AFTER_REQUEST_MINUTES. Menos
 *    de LATE_SERVICE_MAX_MINUTES. Hora marcada = modifiedFields.checkOut.from;
 *  - os INÍCIOS de movimento ficam fora de todas as contagens (não são ações).
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
  const lateTol = params.add(LATE_SERVICE_MINUTES);
  const lateMax = params.add(LATE_SERVICE_MAX_MINUTES);
  const lateReq = params.add(LATE_AFTER_REQUEST_MINUTES);
  const cats = `('CHECK_IN', 'CHECK_OUT', 'MOVEMENT', 'CANCEL')`;
  const inSeq = `(k.ct IN ${cats} AND k.mk IS DISTINCT FROM 'inicio')`;
  // pedido depois da hora marcada (voo atrasado) ou sem hora marcada: pedido + LATE_AFTER_REQUEST_MINUTES (viagem incluída); senão marcada + LATE_SERVICE_MINUTES
  const byRequest = `(x.pending_at IS NOT NULL AND (x.sched_at IS NULL OR x.pending_at > x.sched_at))`;
  const late = (b: string, tol: string) => `(x.at - ${b} > ${tol}::int * interval '1 minute' AND x.at - ${b} < ${lateMax}::int * interval '1 minute')`;
  const sql = [
    `WITH h AS (`,
    `  SELECT h."id" AS id, h."bookingId" AS booking_id, h."userId" AS user_id,`,
    `         COALESCE(NULLIF(h."agentName", ''), NULLIF(ag."name", '')) AS agent_name,`,
    `         upper(h."changeType"::text) AS ct, h."actionTime" AS at, COALESCE(h."modifiedFields", '') AS mf`,
    `    FROM "History" h`,
    `    LEFT JOIN "Booking" b ON b."id" = h."bookingId"`,
    `    LEFT JOIN "Agent" ag ON ag."userId" = h."userId" AND ag."parkId" = b."parkId"`,
    `   WHERE h."actionTime" >= ${lb}::timestamp AND h."actionTime" < ${to}::timestamp`,
    `), k AS MATERIALIZED (`, // o tipo de cada MOVEMENT calcula-se uma vez (sem MATERIALIZED o Postgres recopia a expressão)
    `  SELECT h.id, h.booking_id, h.user_id, h.agent_name, h.ct, h.at,`,
    `         CASE WHEN h.ct = 'MOVEMENT' THEN ${movementKindSql("h.mf")} END AS mk,`,
    `         CASE WHEN h.ct = 'CHECK_OUT' THEN ${scheduledCheckOutTextSql("h.mf")} END AS sched_txt`,
    `    FROM h`,
    `), seq AS (`,
    `  SELECT k.*, ${scheduledCheckOutAtSql("k.sched_txt")} AS sched_at,`,
    `         CASE WHEN ${inSeq} THEN lag(k.ct) OVER (PARTITION BY k.booking_id, ${inSeq} ORDER BY k.at, k.id) END AS prev_cat,`,
    `         COALESCE(sum(CASE WHEN k.ct = 'CHECK_OUT' THEN 1 ELSE 0 END) OVER (PARTITION BY k.booking_id ORDER BY k.at, k.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS deliveries_before`,
    `    FROM k`,
    `), seq2 AS (`,
    `  SELECT s.*, min(s.at) FILTER (WHERE s.ct = 'PENDING_CHECKOUT') OVER (PARTITION BY s.booking_id, s.deliveries_before) AS pending_at`,
    `    FROM seq s`,
    `)`,
    `SELECT x.user_id, max(x.agent_name) AS agent_name, ${opDaySql("x.at")} AS day, ${opShiftSql("x.at")} AS shift, x.ct AS change_type, ${lisbonHourSql("x.at")} AS hour,`,
    `       count(*) AS n,`,
    `       count(*) FILTER (WHERE x.ct = 'MOVEMENT' AND (x.mk = 'arrumar' OR (x.mk = 'antigo' AND x.prev_cat = 'CHECK_IN'))) AS parking_moves,`,
    `       count(*) FILTER (WHERE x.ct = 'MOVEMENT' AND x.mk IN ('arrumar', 'parques', 'antigo')) AS moves,`,
    `       count(*) FILTER (WHERE x.ct = 'MOVEMENT' AND x.mk = 'lugar') AS spot_changes,`,
    `       count(*) FILTER (WHERE x.ct = 'CHECK_OUT' AND CASE WHEN ${byRequest} THEN ${late("x.pending_at", lateReq)}`,
    `                          WHEN x.sched_at IS NOT NULL THEN ${late("x.sched_at", lateTol)} ELSE FALSE END) AS late_deliveries,`,
    `       count(*) FILTER (WHERE x.ct = 'CHECK_OUT' AND x.sched_at IS NULL) AS deliveries_without_schedule`,
    `  FROM seq2 x`,
    // 14 out 2026: o início de um movimento não é uma ação (nem conta nas ações, por hora ou por tipo)
    ` WHERE x.at >= ${from}::timestamp AND x.mk IS DISTINCT FROM 'inicio'`,
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
  lateDeliveries: number;
  /** MOVEMENT que contam como movimento (levar ao parque + entre parques + antigos). Sem isto, todos os `n`. */
  moves?: number;
  /** MOVEMENT na mesma garagem (mudança de lugar) — não são movimentos. */
  spotChanges?: number;
  /** CHECK_OUT sem hora marcada legível: o atraso mediu-se só pelo PENDING_CHECKOUT. */
  deliveriesWithoutSchedule?: number;
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
    lateDeliveries: int(r.late_deliveries),
    ...(r.moves !== undefined ? { moves: int(r.moves) } : {}),
    ...(r.spot_changes !== undefined ? { spotChanges: int(r.spot_changes) } : {}),
    ...(r.deliveries_without_schedule !== undefined ? { deliveriesWithoutSchedule: int(r.deliveries_without_schedule) } : {}),
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
    const lookbackFrom = operationalDayRangeUtc(addDays(startDay, -3), startDay).start;
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

/** Movimentos por agente: contagens por tipo, reservas, 1.ª/última ação, plataformas. PURA. */
export function buildAgentHistoryAggSql(f: AggregateFilters): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  // dentro: o que só depende da History (janela e agentes) — o tipo do MOVEMENT calcula-se UMA vez por linha
  const inner = [
    `h."actionTime" >= ${params.add(f.window.from)}::timestamp`,
    `h."actionTime" < ${params.add(f.window.to)}::timestamp`,
  ];
  const ids = idList(f.userIds, params, `h."userId"`);
  if (ids) inner.push(ids);
  // fora: parque/cidade e (14 out 2026) sem os inícios de movimento — não são ações (nem no total, nem nos movimentos, nem nas reservas)
  const outer = [`h.mk IS DISTINCT FROM 'inicio'`];
  const city = cityCondition(f.cities, params);
  if (city) outer.push(city);
  const park = parkCondition(f.parkIds, params);
  if (park) outer.push(park);
  const dayCol = f.byDay ? `, ${opDaySql(`h."actionTime"`)} AS day` : `, NULL AS day`;
  const perType = MOVEMENT_CHANGE_TYPES.map((t) => `count(*) FILTER (WHERE h."changeType"::text = '${t}') AS ${typeAlias(t)}`);
  const sql = [
    `SELECT h."userId" AS user_id, max(COALESCE(NULLIF(h."agentName", ''), NULLIF(ag."name", ''))) AS agent_name${dayCol},`,
    `       count(*) AS total,`,
    `       ${perType.join(",\n       ")},`,
    // Jorge, 14 out 2026: cada MOVEMENT pelo modifiedFields (movementKindSql). A mesma garagem é mudança de
    // lugar (não é movimento); o resto (levar ao parque, entre parques, antigos) é movimento.
    `       count(*) FILTER (WHERE h.mk IN ('arrumar', 'parques', 'antigo')) AS moves,`,
    `       count(*) FILTER (WHERE h.mk = 'lugar') AS spot_changes,`,
    `       count(DISTINCT h."bookingId") AS bookings,`,
    `       ${ts(`min(h."actionTime")`)} AS first_at,`,
    `       ${ts(`max(h."actionTime")`)} AS last_at,`,
    `       string_agg(DISTINCT NULLIF(h."platform", ''), ',') AS platforms`,
    `  FROM (`,
    `    SELECT h."userId", h."agentName", h."changeType", h."bookingId", h."actionTime", h."platform",`,
    `           CASE WHEN h."changeType"::text = 'MOVEMENT' THEN ${movementKindSql(`COALESCE(h."modifiedFields", '')`)} END AS mk`,
    `      FROM "History" h`,
    `     WHERE ${inner.join(" AND ")}`,
    // OFFSET 0: o Postgres não "puxa" a subconsulta, por isso o tipo (13 regex) calcula-se uma vez por linha
    `    OFFSET 0`,
    `  ) h`,
    `  LEFT JOIN "Booking" b ON b."id" = h."bookingId"`,
    `  LEFT JOIN "Park" p ON p."id" = b."parkId"`,
    `  LEFT JOIN "Agent" ag ON ag."userId" = h."userId" AND ag."parkId" = b."parkId"`,
    ` WHERE ${outer.join(" AND ")}`,
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
  /** MOVEMENT que são movimentos: levar ao parque + entre parques (sem os inícios nem as mudanças de lugar). */
  movements: number;
  /** MOVEMENT na mesma garagem (mudança de lugar). */
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
    s.recolhas = s.byType.CHECK_IN ?? 0;
    s.entregas = s.byType.CHECK_OUT ?? 0;
    // sem a coluna `moves` (leituras antigas/testes): todas as linhas MOVEMENT
    s.movements = r.moves !== undefined ? s.movements + int(r.moves) : s.byType.MOVEMENT ?? 0;
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
    `       left(h."modifiedFields", 300) AS modified_fields, left(h."remarks", 300) AS remarks,`,
    // 14 out 2026: o tipo do MOVEMENT sobre o texto COMPLETO (o mostrado vem cortado a 300)
    `       CASE WHEN upper(h."changeType"::text) = 'MOVEMENT' THEN ${movementKindSql(`COALESCE(h."modifiedFields", '')`)} END AS move_kind`,
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
  changeType: string;
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
  /** 14 out 2026: tipo do MOVEMENT (inicio/arrumar/lugar/parques/antigo); null nas outras ações. */
  moveKind: string | null;
}

export function mapAgentMovementRow(r: Record<string, unknown>): AgentMovement {
  return {
    id: String(r.id ?? ""),
    actionTime: toIsoUtc(r.action_time),
    // o início do movimento e a mudança de lugar com o seu nome (MOVEMENT_START / SPOT_CHANGE): o detalhe bate com os totais
    changeType: displayChangeType(String(r.change_type ?? "?").toUpperCase(), str(r.move_kind)),
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
    moveKind: str(r.move_kind),
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
    return { rows: rows.slice(0, limit).map(mapAgentMovementRow), truncated: rows.length > limit };
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
