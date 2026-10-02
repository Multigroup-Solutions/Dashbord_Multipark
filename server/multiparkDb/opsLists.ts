/**
 * Listas das Operações por PERÍODO — Reservas (criadas), Recolhas (check-in),
 * Entregas (check-out) e Cancelados — lidas AO VIVO da BD da Multipark (BD 2),
 * sem copiar nada. Regras de read.ts: SQL parametrizado, construtores e
 * mapeadores PUROS, LIMIT sempre e nunca lança (`{ available:false, reason }`).
 *
 * Três leituras por pedido:
 *   1. os parques ("Park", ~55 linhas), filtrados pelas cidades do utilizador
 *      (Park.city) e classificados (shared/multiparkParks.ts);
 *   2. os CONTADORES, agregados no Postgres (GROUP BY parque × estado × canal ×
 *      período): o período pedido e o anterior com a mesma duração, numa só
 *      passagem — poucas centenas de linhas mesmo com 62 dias;
 *   3. UMA página da lista (LIMIT/OFFSET, ordenada pela data da lista).
 *
 * A data de cada lista (dias de Lisboa → instantes UTC, a BD grava UTC):
 *   - Reservas:   Booking.createdAt           (índice parkId+createdAt)
 *   - Recolhas:   Booking.checkIn, pré-filtro em checkInDate com 1 dia de
 *                 folga (índice parkId+checkInDate); sem as canceladas
 *   - Entregas:   Booking.checkOut / checkOutDate (idem)
 *   - Cancelados: Cancellation.createdAt (índice createdAt), estado CANCELLED;
 *                 as canceladas SEM linha na Cancellation entram pela última
 *                 alteração (Booking.updatedAt, índice parkId+updatedAt) e
 *                 ficam marcadas como data aproximada.
 *
 * As compras online por acabar (PENDING) não entram em nenhuma lista — a
 * mesma regra do Dashboard das Operações (opsCounts.ts), da Faturação, do CRM
 * e dos Serviços.
 *
 * Colunas usadas (docs/multipark-db/schema.md):
 *   Park: id, name, city, firebaseBrand, listingType, status
 *   Booking: id, allocation, status, checkIn, checkOut, checkInDate,
 *     checkOutDate, createdAt, updatedAt, parkId, clientId, customerId,
 *     vehicleId, partnerId, deliveryType, parkingType, origin, paymentSource,
 *     bookingPrice, paymentMethod, pro, remarks, checkInDriverName,
 *     checkOutDriverName
 *   Client: firstName, lastName, email, phoneNumber
 *   BookingVehicle: licensePlate, brand, model, vehicleType
 *   Partner: name, partnerType
 *   BookingPricing: total, amountPaid (soma por reserva)
 *   Cancellation: createdAt, cancellationType, cancellationObs, refund,
 *     refunded, refundedAmount, refundedAt
 *   History: bookingId, changeType = CANCEL, agentName, userId, actionTime
 *     (quem cancelou — só para as reservas da página)
 *   Agent: userId, parkId, name (nome quando o History não o tem)
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, likeContains, normalizePlate, safeMultiparkRead, toIsoUtc, type MultiparkRead } from "./read";
import { buildParksSql, mapParks, type DayPark } from "./dayBookings";
import { AGGREGATOR_PAYMENT_SOURCES, PARTNER_ORIGINS, classifyBookingChannel, classifyPark, type BookingChannel } from "../../shared/multiparkParks";
import {
  ENTERED_STATUSES, OPS_LIST_MAX_DAYS, previousRange, rangeDays, summarizeOps,
  type OpsAggRow, type OpsListKind, type OpsListRow, type OpsListSummary, type OpsParkInfo,
} from "../../shared/opsLists";
import { lisbonDayRangeUtc } from "../../shared/lisbonDay";

export const OPS_LIST_PAGE_DEFAULT = 200;
export const OPS_LIST_PAGE_MAX = 500;
export const OPS_LIST_MAX_OFFSET = 10_000;
/** Teto de linhas do agregado (parque × estado × canal × período: na prática centenas). */
export const OPS_AGG_LIMIT = 20_000;

export interface OpsListInput {
  kind: OpsListKind;
  /** Dias de Lisboa "YYYY-MM-DD" (inclusive). */
  from: string;
  to: string;
  parkId?: string;
  channel?: BookingChannel | "";
  state?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

// ─── Período → limites UTC ──────────────────────────────────────────────────

export interface OpsBounds {
  from: string;
  to: string;
  days: number;
  /** "YYYY-MM-DD HH:MM:SS" UTC — período pedido [start, end). */
  start: string;
  end: string;
  /** Início do período anterior (mesma duração) — o agregado lê [prevStart, end). */
  prevFrom: string;
  prevTo: string;
  prevStart: string;
}

/** Limites do período (e do anterior). Lança se o período for inválido ou longo. PURA. */
export function opsBounds(from: string, to: string): OpsBounds {
  const days = rangeDays(from, to);
  if (!days) throw new Error(`Período inválido: ${from} → ${to}`);
  if (days > OPS_LIST_MAX_DAYS) throw new Error(`Período demasiado longo (${days} dias; máximo ${OPS_LIST_MAX_DAYS}).`);
  const cur = lisbonDayRangeUtc(from, to);
  const prev = previousRange(from, to);
  return { from, to, days, start: cur.start, end: cur.end, prevFrom: prev.from, prevTo: prev.to, prevStart: lisbonDayRangeUtc(prev.from, prev.to).start };
}

const shiftTs = (ts: string, days: number) =>
  new Date(Date.parse(`${ts.replace(" ", "T")}Z`) + days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");

// ─── Predicados (SQL escrito aqui; valores sempre como parâmetros) ─────────

interface SourceSpec {
  kind: OpsListKind;
  parkIds: string[];
  /** Parques NOSSOS entre `parkIds` (para o canal). */
  ourParkIds: string[];
  state?: string;
  search?: string;
  channel?: BookingChannel | "";
}

const inList = (p: ParamList, values: readonly string[]) => values.map((v) => p.add(v)).join(", ");

/**
 * Canal em SQL — as MESMAS regras de classifyBookingChannel (multiparkParks.ts):
 * Marketplace = parque não nosso OU origem MARKETPLACE; Parceiro = parceiro
 * ligado, origem de parceiro ou cobrada por agregador; Direto = o resto. PURA.
 */
export function channelPredicate(channel: BookingChannel, ourParkIds: string[], p: ParamList): string {
  const ours = ourParkIds.length ? `b."parkId" IN (${inList(p, ourParkIds)})` : "FALSE";
  const market = `(NOT (${ours}) OR b."origin"::text = ${p.add("MARKETPLACE")})`;
  const partner = `(NULLIF(b."partnerId", '') IS NOT NULL OR b."origin"::text IN (${inList(p, PARTNER_ORIGINS)}) OR COALESCE(b."paymentSource"::text, '') IN (${inList(p, AGGREGATOR_PAYMENT_SOURCES)}))`;
  if (channel === "marketplace") return market;
  if (channel === "parceiro") return `(NOT ${market} AND ${partner})`;
  return `(NOT ${market} AND NOT ${partner})`;
}

/** Filtro de estado de cada lista (null = nenhum). `hasCx`: há a linha Cancellation. PURA. */
export function statePredicate(kind: OpsListKind, state: string | undefined, p: ParamList, hasCx: boolean): string | null {
  if (!state || state === "all") return null;
  if (kind === "reservas") {
    if (state === "active") return `b."status"::text <> ${p.add("CANCELLED")}`;
    if (state === "cancelled") return `b."status"::text = ${p.add("CANCELLED")}`;
  }
  if (kind === "entradas") {
    if (state === "done") return `b."status"::text IN (${inList(p, ENTERED_STATUSES)})`;
    if (state === "pending") return `b."status"::text NOT IN (${inList(p, ENTERED_STATUSES)})`;
  }
  if (kind === "saidas") {
    if (state === "done") return `b."status"::text = ${p.add("CHECKED_OUT")}`;
    if (state === "pending") return `b."status"::text <> ${p.add("CHECKED_OUT")}`;
  }
  if (kind === "cancelados") {
    if (state === "refund") return hasCx ? `cx."refund"` : "FALSE";
    if (state === "norefund") return hasCx ? `NOT cx."refund"` : "TRUE";
  }
  return null;
}

/** Pesquisa: n.º (allocation), id, matrícula sem traços, nome ou email. PURA. */
export function searchPredicate(search: string, p: ParamList): string {
  const q = search.trim().slice(0, 100);
  const like = p.add(likeContains(q));
  const parts = [
    `b."allocation" ILIKE ${like}`,
    `b."id" = ${p.add(q)}`,
    `concat_ws(' ', c0."firstName", c0."lastName") ILIKE ${like}`,
    `c0."email" ILIKE ${like}`,
  ];
  const plate = normalizePlate(q);
  if (plate.length >= 2) parts.push(`regexp_replace(upper(COALESCE(v0."licensePlate", '')), '[^A-Z0-9]', '', 'g') LIKE ${p.add(`%${plate}%`)}`);
  return `(${parts.join(" OR ")})`;
}

/**
 * Reservas da lista no intervalo [startTs, endTs): colunas id, park_id, ev
 * (a data da lista), approx. Cancelados: duas partes (UNION ALL). PURA.
 */
export function buildSource(spec: SourceSpec, p: ParamList, startTs: string, endTs: string, withChannel: boolean): string {
  if (!spec.parkIds.length) throw new Error("Sem parques.");
  const q = spec.search?.trim() ?? "";
  const joinsFor = () => (q ? [
    `LEFT JOIN "Client" c0 ON c0."id" = COALESCE(b."customerId", b."clientId")`,
    `LEFT JOIN "BookingVehicle" v0 ON v0."id" = b."vehicleId"`,
  ] : []);
  const common = (hasCx: boolean): string[] => {
    const out = [`b."parkId" IN (${inList(p, spec.parkIds)})`];
    // Compras online por acabar nunca contam (nos cancelados o estado já é CANCELLED).
    if (spec.kind !== "cancelados") out.push(`b."status"::text <> ${p.add("PENDING")}`);
    const st = statePredicate(spec.kind, spec.state, p, hasCx);
    if (st) out.push(st);
    if (withChannel && spec.channel) out.push(channelPredicate(spec.channel, spec.ourParkIds, p));
    if (q) out.push(searchPredicate(q, p));
    return out;
  };
  const s = () => `${p.add(startTs)}::timestamp`;
  const e = () => `${p.add(endTs)}::timestamp`;
  const part = (select: string, from: string[], where: string[]) =>
    [`SELECT ${select}`, `FROM ${from.join("\n  ")}`, `WHERE ${where.join("\n  AND ")}`].join("\n");

  if (spec.kind === "reservas") {
    return part(`b."id" AS id, b."parkId" AS park_id, b."createdAt" AS ev, FALSE AS approx`, [`"Booking" b`, ...joinsFor()],
      [`b."createdAt" >= ${s()}`, `b."createdAt" < ${e()}`, ...common(false)]);
  }
  if (spec.kind === "entradas" || spec.kind === "saidas") {
    const col = spec.kind === "entradas" ? "checkIn" : "checkOut";
    return part(`b."id" AS id, b."parkId" AS park_id, b."${col}" AS ev, FALSE AS approx`, [`"Booking" b`, ...joinsFor()], [
      `b."${col}Date" >= ${p.add(shiftTs(startTs, -1))}::timestamp`,
      `b."${col}Date" < ${p.add(shiftTs(endTs, 1))}::timestamp`,
      `b."${col}" >= ${s()}`,
      `b."${col}" < ${e()}`,
      `b."status"::text <> ${p.add("CANCELLED")}`,
      ...common(false),
    ]);
  }
  // Cancelados
  const withCx = part(`b."id" AS id, b."parkId" AS park_id, cx."createdAt" AS ev, FALSE AS approx`,
    [`"Cancellation" cx`, `JOIN "Booking" b ON b."id" = cx."bookingId"`, ...joinsFor()],
    [`cx."createdAt" >= ${s()}`, `cx."createdAt" < ${e()}`, `b."status"::text = ${p.add("CANCELLED")}`, ...common(true)]);
  const noCx = part(`b."id" AS id, b."parkId" AS park_id, b."updatedAt" AS ev, TRUE AS approx`, [`"Booking" b`, ...joinsFor()], [
    `b."status"::text = ${p.add("CANCELLED")}`,
    `b."updatedAt" >= ${s()}`,
    `b."updatedAt" < ${e()}`,
    `NOT EXISTS (SELECT 1 FROM "Cancellation" c2 WHERE c2."bookingId" = b."id")`,
    ...common(false),
  ]);
  return `${withCx}\nUNION ALL\n${noCx}`;
}

// ─── Contadores ─────────────────────────────────────────────────────────────

/**
 * Agregado do período pedido E do anterior numa só leitura ([prevStart, end);
 * `cur` separa os dois). Sem o filtro de canal: o canal é calculado depois
 * (classificador único) para os botões mostrarem os três. PURA.
 */
export function buildOpsAggSql(spec: SourceSpec, bounds: OpsBounds): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const source = buildSource(spec, p, bounds.prevStart, bounds.end, false);
  const cur = p.add(bounds.start);
  const cx = spec.kind === "cancelados";
  const sql = [
    `WITH d AS (`,
    source,
    `),`,
    `bp AS (SELECT y."bookingId" AS booking_id, SUM(y."total") AS total, SUM(y."amountPaid") AS paid FROM "BookingPricing" y WHERE y."bookingId" IN (SELECT d."id" FROM d WHERE d.ev >= ${cur}::timestamp) GROUP BY y."bookingId")`,
    `SELECT`,
    `  d.park_id AS park_id,`,
    `  (d.ev >= ${cur}::timestamp) AS cur,`,
    `  b."status"::text AS status,`,
    `  b."origin"::text AS origin,`,
    `  b."paymentSource"::text AS payment_source,`,
    `  (NULLIF(b."partnerId", '') IS NOT NULL) AS has_partner,`,
    `  ${cx ? `NULLIF(cx."cancellationType", '')` : "NULL::text"} AS reason,`,
    `  count(*) AS n,`,
    `  SUM(COALESCE(bp.total, b."bookingPrice")) AS value,`,
    `  SUM(COALESCE(bp.paid, 0)) AS paid,`,
    `  SUM(GREATEST(COALESCE(bp.total, b."bookingPrice") - COALESCE(bp.paid, 0), 0)) AS to_pay,`,
    `  count(*) FILTER (WHERE d.approx) AS approx,`,
    `  ${cx ? `count(*) FILTER (WHERE cx."refund")` : "0"} AS refund,`,
    `  ${cx ? `SUM(COALESCE(cx."refundedAmount", 0))` : "0"} AS refunded`,
    `FROM d`,
    `JOIN "Booking" b ON b."id" = d."id"`,
    `LEFT JOIN bp ON bp.booking_id = d."id"`,
    ...(cx ? [`LEFT JOIN "Cancellation" cx ON cx."bookingId" = d."id"`] : []),
    `GROUP BY 1, 2, 3, 4, 5, 6, 7`,
    `LIMIT ${p.add(OPS_AGG_LIMIT)}`,
  ].join("\n");
  return { sql, params: p.values };
}

/** Linha do agregado → OpsAggRow. PURA. */
export function mapAggRow(r: Record<string, unknown>): OpsAggRow {
  return {
    parkId: String(r.park_id ?? ""),
    current: bool(r.cur),
    status: str(r.status) ?? "",
    origin: str(r.origin),
    paymentSource: str(r.payment_source),
    hasPartner: bool(r.has_partner),
    reason: str(r.reason),
    count: num(r.n) ?? 0,
    value: num(r.value) ?? 0,
    paid: num(r.paid) ?? 0,
    toPay: num(r.to_pay) ?? 0,
    approx: num(r.approx) ?? 0,
    refund: num(r.refund) ?? 0,
    refunded: num(r.refunded) ?? 0,
  };
}

// ─── Página da lista ────────────────────────────────────────────────────────

const ts = (expr: string) => `to_char(${expr}, 'YYYY-MM-DD HH24:MI:SS')`;

/** SQL de UMA página (limit+1 para saber se há mais), mais recentes primeiro. PURA. */
export function buildOpsListSql(spec: SourceSpec, bounds: OpsBounds, limit: number, offset: number): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const source = buildSource(spec, p, bounds.start, bounds.end, true);
  const lim = p.add(Math.min(Math.max(Math.floor(limit), 1), OPS_LIST_PAGE_MAX) + 1);
  const off = p.add(Math.min(Math.max(Math.floor(offset), 0), OPS_LIST_MAX_OFFSET));
  const cx = spec.kind === "cancelados";
  const cols = [
    `b."id" AS id`,
    `NULLIF(b."allocation", '') AS code`,
    `b."status"::text AS status`,
    `${ts("d.ev")} AS event_at`,
    `d.approx AS approx_date`,
    `${ts(`b."checkIn"`)} AS check_in`,
    `${ts(`b."checkOut"`)} AS check_out`,
    `${ts(`b."createdAt"`)} AS created_at`,
    `b."parkId" AS park_id`,
    `c."firstName" AS client_first_name`,
    `c."lastName" AS client_last_name`,
    `NULLIF(c."email", '') AS client_email`,
    `NULLIF(c."phoneNumber", '') AS client_phone`,
    `v."licensePlate" AS plate`,
    `NULLIF(v."brand", '') AS vehicle_brand`,
    `NULLIF(v."model", '') AS vehicle_model`,
    `v."vehicleType"::text AS vehicle_type`,
    `NULLIF(b."deliveryType", '') AS delivery_type`,
    `b."parkingType"::text AS parking_type`,
    `b."origin"::text AS origin`,
    `b."paymentSource"::text AS payment_source`,
    `NULLIF(b."partnerId", '') AS partner_id`,
    `pa."name" AS partner_name`,
    `pa."partnerType"::text AS partner_type`,
    `COALESCE(bp.total, b."bookingPrice") AS price`,
    `bp.paid AS paid`,
    `NULLIF(b."paymentMethod", '') AS payment_method`,
    `b."pro" AS pro`,
    `NULLIF(b."remarks", '') AS remarks`,
    `NULLIF(b."checkInDriverName", '') AS check_in_driver`,
    `NULLIF(b."checkOutDriverName", '') AS check_out_driver`,
    ...(cx ? [
      `${ts(`cx."createdAt"`)} AS cancelled_at`,
      `NULLIF(cx."cancellationType", '') AS cancel_type`,
      `NULLIF(cx."cancellationObs", '') AS cancel_obs`,
      `cx."refund" AS cancel_refund`,
      `cx."refunded" AS cancel_refunded`,
      `cx."refundedAmount" AS cancel_refunded_amount`,
      `${ts(`cx."refundedAt"`)} AS cancel_refunded_at`,
      `COALESCE(hc.agent, ag."name") AS cancelled_by`,
    ] : []),
  ].join(",\n  ");
  const sql = [
    `WITH d AS (`,
    `  SELECT z.* FROM (`,
    source,
    `  ) z`,
    `  ORDER BY z.ev DESC, z.id`,
    `  LIMIT ${lim} OFFSET ${off}`,
    `),`,
    `bp AS (SELECT y."bookingId" AS booking_id, SUM(y."total") AS total, SUM(y."amountPaid") AS paid FROM "BookingPricing" y WHERE y."bookingId" IN (SELECT d."id" FROM d) GROUP BY y."bookingId")`,
    ...(cx ? [
      // Quem cancelou: o último movimento CANCEL de cada reserva DESTA página.
      `, hc AS (SELECT DISTINCT ON (h."bookingId") h."bookingId" AS booking_id, NULLIF(h."agentName", '') AS agent, h."userId" AS user_id FROM "History" h WHERE h."changeType"::text = ${p.add("CANCEL")} AND h."bookingId" IN (SELECT d."id" FROM d) ORDER BY h."bookingId", h."actionTime" DESC)`,
    ] : []),
    `SELECT`,
    `  ${cols}`,
    `FROM d`,
    `JOIN "Booking" b ON b."id" = d."id"`,
    `LEFT JOIN "Client" c ON c."id" = COALESCE(b."customerId", b."clientId")`,
    `LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
    `LEFT JOIN "Partner" pa ON pa."id" = b."partnerId"`,
    `LEFT JOIN bp ON bp.booking_id = b."id"`,
    ...(cx ? [
      `LEFT JOIN "Cancellation" cx ON cx."bookingId" = b."id"`,
      `LEFT JOIN hc ON hc.booking_id = b."id"`,
      `LEFT JOIN LATERAL (SELECT a."name" FROM "Agent" a WHERE a."userId" = hc.user_id AND a."parkId" = b."parkId" LIMIT 1) ag ON TRUE`,
    ] : []),
    `ORDER BY d.ev DESC, d."id"`,
  ].join("\n");
  return { sql, params: p.values };
}

/** Linha → OpsListRow (com o grupo do parque e o canal). PURA. */
export function mapOpsListRow(kind: OpsListKind, r: Record<string, unknown>, park: Pick<DayPark, "name" | "cityName" | "key" | "label" | "ours"> | undefined): OpsListRow {
  const price = num(r.price);
  const paid = num(r.paid);
  const partnerId = str(r.partner_id);
  const partnerName = str(r.partner_name);
  const partnerType = str(r.partner_type);
  const origin = str(r.origin);
  const paymentSource = str(r.payment_source);
  const cls = park ?? { name: null, cityName: null, ...classifyPark({}) };
  const ch = classifyBookingChannel({ parkOurs: cls.ours, partnerId, partnerName, partnerType, origin, paymentSource });
  return {
    id: String(r.id ?? ""),
    code: str(r.code),
    status: str(r.status) ?? "",
    eventAt: toIsoUtc(r.event_at),
    approxDate: kind === "cancelados" && bool(r.approx_date),
    checkIn: toIsoUtc(r.check_in),
    checkOut: toIsoUtc(r.check_out),
    createdAt: toIsoUtc(r.created_at),
    parkId: String(r.park_id ?? ""),
    parkName: cls.name,
    parkCity: cls.cityName,
    groupKey: cls.key,
    groupLabel: cls.label,
    ours: cls.ours,
    clientName: [str(r.client_first_name), str(r.client_last_name)].filter(Boolean).join(" ") || null,
    clientEmail: str(r.client_email),
    clientPhone: str(r.client_phone),
    plate: str(r.plate),
    vehicleBrand: str(r.vehicle_brand),
    vehicleModel: str(r.vehicle_model),
    vehicleType: str(r.vehicle_type),
    deliveryType: str(r.delivery_type),
    parkingType: str(r.parking_type),
    origin,
    paymentSource,
    partnerId,
    partnerName,
    partnerType,
    channel: ch.channel,
    channelDetail: ch.detail,
    channelBadge: ch.badge,
    price,
    paid,
    toPay: price != null ? Math.max(0, Math.round((price - (paid ?? 0)) * 100) / 100) : null,
    paymentMethod: str(r.payment_method),
    pro: bool(r.pro),
    remarks: str(r.remarks),
    checkInDriverName: str(r.check_in_driver),
    checkOutDriverName: str(r.check_out_driver),
    cancellation: kind === "cancelados" ? {
      at: toIsoUtc(r.cancelled_at),
      type: str(r.cancel_type),
      obs: str(r.cancel_obs),
      refund: bool(r.cancel_refund),
      refunded: bool(r.cancel_refunded),
      refundedAmount: num(r.cancel_refunded_amount),
      refundedAt: toIsoUtc(r.cancel_refunded_at),
      by: str(r.cancelled_by),
    } : null,
  };
}

// ─── Leitura (nunca lança) ──────────────────────────────────────────────────

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export interface OpsListResult {
  kind: OpsListKind;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  parks: OpsParkInfo[];
  summary: OpsListSummary;
  rows: OpsListRow[];
  offset: number;
  limit: number;
  hasMore: boolean;
  /** O agregado bateu no teto (contadores podem estar incompletos). */
  aggTruncated: boolean;
}

/** Uma lista das Operações, só dos parques das cidades `cities` (undefined = todas). */
export async function getMultiparkOpsList(input: OpsListInput, cities?: string[], query: Query = multiparkDbQuery): Promise<MultiparkRead<OpsListResult>> {
  return safeMultiparkRead(`lista ${input.kind}`, async () => {
    const bounds = opsBounds(input.from, input.to);
    const limit = Math.min(Math.max(Math.floor(input.limit ?? OPS_LIST_PAGE_DEFAULT), 1), OPS_LIST_PAGE_MAX);
    const offset = Math.min(Math.max(Math.floor(input.offset ?? 0), 0), OPS_LIST_MAX_OFFSET);
    const ps = buildParksSql();
    const allParks = mapParks(await query(ps.sql, ps.params), cities);
    const parksOut: OpsParkInfo[] = allParks.map((p) => ({ id: p.id, name: p.name, cityName: p.cityName, key: p.key, label: p.label, ours: p.ours }));
    const parks = input.parkId ? allParks.filter((p) => p.id === input.parkId) : allParks;
    const base = { kind: input.kind, from: bounds.from, to: bounds.to, prevFrom: bounds.prevFrom, prevTo: bounds.prevTo, parks: parksOut, offset, limit };
    if (!parks.length) {
      return { ...base, summary: summarizeOps(input.kind, [], parksOut), rows: [], hasMore: false, aggTruncated: false };
    }
    const spec: SourceSpec = {
      kind: input.kind,
      parkIds: parks.map((p) => p.id),
      ourParkIds: parks.filter((p) => p.ours).map((p) => p.id),
      state: input.state,
      search: input.search?.trim() || undefined,
      channel: input.channel || "",
    };
    const agg = buildOpsAggSql(spec, bounds);
    const list = buildOpsListSql(spec, bounds, limit, offset);
    const [aggRows, listRows] = await Promise.all([query(agg.sql, agg.params), query(list.sql, list.params)]);
    const byId = new Map(parks.map((p) => [p.id, p]));
    return {
      ...base,
      summary: summarizeOps(input.kind, aggRows.map(mapAggRow), parksOut, spec.channel),
      rows: listRows.slice(0, limit).map((r) => mapOpsListRow(input.kind, r, byId.get(String(r.park_id ?? "")))),
      hasMore: listRows.length > limit,
      aggTruncated: aggRows.length >= OPS_AGG_LIMIT,
    };
  });
}

// ─── Ajudantes ──────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "t" || v === "true";
}
