/**
 * "Reservas do dia" lidas AO VIVO da BD da Multipark (BD 2) — sem copiar para
 * a nossa BD (ver docs/multipark-db/plano-duas-bd.md). Segue as regras de
 * read.ts: SQL parametrizado, construtores e mapeadores PUROS, LIMIT sempre e
 * nunca lança (`{ available:false, reason }`).
 *
 * Duas leituras por dia:
 *   1. os parques ("Park": id, name, city, address, firebaseBrand, listingType, status
 *      — ~55 linhas), filtrados pelas cidades do utilizador, SEM os "Parques
 *      que a operação não faz" (Definições → operations.excludedParks) e
 *      agrupados para a operação (marca nossa + cidade, ou o próprio parque);
 *   2. as reservas com entrada OU saída nesse dia de Lisboa, só desses parques.
 * A lista é operacional: o canal Direto/Parceiro/Marketplace (contabilidade)
 * não se calcula aqui.
 *
 * O dia: [00:00, 24:00) de Lisboa → instantes UTC (a BD grava UTC).
 *   - "checkIn"/"checkOut" = a hora do movimento (é o que a API manda como
 *     checkInDate/checkOutDate; ver queries.ts) → filtro exato;
 *   - "checkInDate"/"checkOutDate" (muitas vezes só o dia, 00:00) têm os
 *     índices ("parkId", "checkInDate") e ("parkId", "checkOutDate") → um
 *     pré-filtro com 1 dia de folga de cada lado deixa o Postgres usá-los.
 *
 * Colunas usadas (docs/multipark-db/schema.md):
 *   Park: id, name, city, address, firebaseBrand, listingType, status
 *   Booking: id, allocation, status, checkIn, checkOut, checkInDate, checkOutDate,
 *     checkInTime, checkOutTime, createdAt, parkId, clientId, customerId, vehicleId,
 *     partnerId, garageId, spotId, externalGarage, externalRow, externalSpot,
 *     departingFlight, departingFlightEta, returnFlight, returnFlightEta,
 *     deliveryType, deliveryLocation, origin, paymentSource, bookingPrice,
 *     paymentMethod, currency, pro, remarks, checkInDriverName, checkOutDriverName,
 *     customerCheckinEta, checkingInAt, movingAt, pendingCheckoutAt,
 *     checkingOutAt, arrivedAtDeliveryAt, baggageWaitingAt
 *   Client: firstName, lastName, email, phoneNumber
 *   BookingVehicle: licensePlate, brand, model, color, vehicleType
 *   Partner: name, partnerType
 *   Garage: name · Spot: row, spot, garageId
 *   Cancellation: createdAt, cancellationType, cancellationObs (única por reserva)
 *   BookingPricing: total, amountPaid (soma por reserva)
 *   BookingExtraService: done (contagem por reserva)
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, cityAliases, safeMultiparkRead, toIsoUtc, type MultiparkRead } from "./read";
import { classifyPark, isNotOperatedByName, type ParkClassification } from "../../shared/multiparkParks";
import { OTHER_PARK_GROUP_ORDER, excludeParks, operationalParkGroup, toDayMovements, type DayBooking, type DayMovement } from "../../shared/reservasDoDia";
import { addDays, lisbonMidnightUtcMs } from "../../shared/lisbonDay";

export const DAY_BOOKINGS_LIMIT = 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Dia de Lisboa → limites UTC ────────────────────────────────────────────

export interface DayBounds {
  day: string;
  /** "YYYY-MM-DD HH:MM:SS" UTC — [start, end). */
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  /** Folga de 1 dia para o pré-filtro nas colunas indexadas (…Date). */
  wideStart: string;
  wideEnd: string;
}

const sqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** Limites UTC do dia de Lisboa (verão: 23:00 UTC do dia anterior). PURA. */
export function lisbonDayBounds(day: string): DayBounds {
  if (!DAY_RE.test(day)) throw new Error(`Dia inválido: ${day}`);
  const startMs = lisbonMidnightUtcMs(day);
  const endMs = lisbonMidnightUtcMs(addDays(day, 1));
  return {
    day,
    start: sqlTs(startMs),
    end: sqlTs(endMs),
    startMs,
    endMs,
    wideStart: sqlTs(startMs - 86_400_000),
    wideEnd: sqlTs(endMs + 86_400_000),
  };
}

// ─── Parques ────────────────────────────────────────────────────────────────

export interface DayPark extends ParkClassification {
  id: string;
  name: string;
  cityName: string | null;
  firebaseBrand: string | null;
  status: string | null;
}

/** O que a página recebe de cada parque (lista de parques e "Classificação dos parques"). */
export type DayParkOut = Pick<DayPark, "id" | "name" | "cityName" | "key" | "label" | "ours" | "firebaseBrand" | "listingType" | "status" | "brandSource" | "citySource" | "reason"> & {
  /** Grupo operacional (Reservas do dia): "Airpark Lisboa" ou o nome do parque. */
  groupKey: string;
  groupLabel: string;
  groupOrder: number;
};

const parkOut = (p: DayPark): DayParkOut => {
  const g = operationalParkGroup(p);
  return {
    id: p.id, name: p.name, cityName: p.cityName, key: p.key, label: p.label, ours: p.ours,
    firebaseBrand: p.firebaseBrand, listingType: p.listingType, status: p.status,
    brandSource: p.brandSource, citySource: p.citySource, reason: p.reason,
    groupKey: g.key, groupLabel: g.label, groupOrder: g.order,
  };
};

/** SQL dos parques (tabela pequena). PURA. */
export function buildParksSql(): { sql: string; params: SqlParam[] } {
  return {
    // 8 out 2026: + a morada (último recurso para a cidade — resolveParkCity)
    sql: `SELECT p."id" AS id, p."name" AS name, p."city" AS city, NULLIF(p."address", '') AS address, NULLIF(p."firebaseBrand", '') AS firebase_brand, p."listingType"::text AS listing_type, p."status"::text AS status FROM "Park" p ORDER BY p."name" LIMIT 500`,
    params: [],
  };
}

/** Linhas dos parques → classificados e filtrados pelo âmbito de cidade. PURA. */
export function mapParks(rows: Array<Record<string, unknown>>, cities?: string[]): DayPark[] {
  const allowed = cities === undefined ? null : new Set(cityAliases(cities));
  const out: DayPark[] = [];
  for (const r of rows) {
    const id = str(r.id);
    if (!id) continue;
    const cityName = str(r.city);
    const name = str(r.name) ?? id;
    const firebaseBrand = str(r.firebase_brand);
    const cls = classifyPark({ name, city: cityName, address: str(r.address), firebaseBrand, listingType: str(r.listing_type) });
    // 42d: a cidade gravada no parque; sem ela (ou escrita de outra maneira), a da classificação (que lê o nome)
    if (allowed && !allowed.has(String(cityName ?? "").trim().toLowerCase()) && !(cls.city && allowed.has(cls.city))) continue;
    out.push({ id, name, cityName, firebaseBrand, status: str(r.status), ...cls });
  }
  return out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "pt"));
}

// ─── Reservas do dia ────────────────────────────────────────────────────────

const ts = (expr: string) => `to_char(${expr}, 'YYYY-MM-DD HH24:MI:SS')`;

const BOOKING_SELECT = [
  `b."id" AS id`,
  `NULLIF(b."allocation", '') AS code`,
  `b."status"::text AS status`,
  `${ts(`b."checkIn"`)} AS check_in`,
  `${ts(`b."checkOut"`)} AS check_out`,
  `NULLIF(b."checkInTime", '') AS check_in_time`,
  `NULLIF(b."checkOutTime", '') AS check_out_time`,
  `${ts(`b."createdAt"`)} AS created_at`,
  `b."parkId" AS park_id`,
  `c."firstName" AS client_first_name`,
  `c."lastName" AS client_last_name`,
  `NULLIF(c."email", '') AS client_email`,
  `NULLIF(c."phoneNumber", '') AS client_phone`,
  `v."licensePlate" AS plate`,
  `NULLIF(v."brand", '') AS vehicle_brand`,
  `NULLIF(v."model", '') AS vehicle_model`,
  `NULLIF(v."color", '') AS vehicle_color`,
  `v."vehicleType"::text AS vehicle_type`,
  `NULLIF(b."departingFlight", '') AS departing_flight`,
  `${ts(`b."departingFlightEta"`)} AS departing_flight_eta`,
  `NULLIF(b."returnFlight", '') AS return_flight`,
  `${ts(`b."returnFlightEta"`)} AS return_flight_eta`,
  `NULLIF(b."deliveryType", '') AS delivery_type`,
  `NULLIF(b."deliveryLocation", '') AS delivery_location`,
  `b."origin"::text AS origin`,
  `b."paymentSource"::text AS payment_source`,
  `b."partnerId" AS partner_id`,
  `pa."name" AS partner_name`,
  `pa."partnerType"::text AS partner_type`,
  `COALESCE(g."name", sg."name", NULLIF(b."externalGarage", '')) AS garage`,
  `COALESCE(NULLIF(concat_ws(' ', NULLIF(s."row", ''), NULLIF(s."spot", '')), ''), NULLIF(concat_ws(' ', NULLIF(b."externalRow", ''), NULLIF(b."externalSpot", '')), '')) AS spot`,
  `COALESCE(bp.total, b."bookingPrice") AS price`,
  `bp.paid AS paid`,
  `NULLIF(b."paymentMethod", '') AS payment_method`,
  `b."currency" AS currency`,
  `b."pro" AS pro`,
  `NULLIF(b."remarks", '') AS remarks`,
  `NULLIF(b."checkInDriverName", '') AS check_in_driver`,
  `NULLIF(b."checkOutDriverName", '') AS check_out_driver`,
  `${ts(`cx."createdAt"`)} AS cancelled_at`,
  `NULLIF(concat_ws(' — ', NULLIF(cx."cancellationType", ''), NULLIF(cx."cancellationObs", '')), '') AS cancel_reason`,
  `b."customerCheckinEta" AS customer_checkin_eta`,
  `${ts(`b."checkingInAt"`)} AS checking_in_at`,
  `${ts(`b."movingAt"`)} AS moving_at`,
  `${ts(`b."pendingCheckoutAt"`)} AS pending_checkout_at`,
  `${ts(`b."checkingOutAt"`)} AS checking_out_at`,
  `${ts(`b."arrivedAtDeliveryAt"`)} AS arrived_at_delivery_at`,
  `${ts(`b."baggageWaitingAt"`)} AS baggage_waiting_at`,
  `COALESCE(ex.n, 0) AS extras_count`,
  `COALESCE(ex.pending, 0) AS extras_pending`,
].join(",\n  ");

/**
 * SQL das reservas com entrada ou saída no dia, nos parques dados. Uma CTE
 * escolhe as reservas (índices por parque + data) e só depois se juntam as
 * linhas de preço e os extras DESSAS reservas. PURA.
 */
export function buildDayBookingsSql(bounds: DayBounds, parkIds: string[], limit = DAY_BOOKINGS_LIMIT): { sql: string; params: SqlParam[] } {
  if (!parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const parks = parkIds.map((id) => p.add(id)).join(", ");
  const s = p.add(bounds.start);
  const e = p.add(bounds.end);
  const ws = p.add(bounds.wideStart);
  const we = p.add(bounds.wideEnd);
  const lim = p.add(Math.min(Math.max(Math.floor(limit), 1), DAY_BOOKINGS_LIMIT + 1));
  const where = [
    `b."parkId" IN (${parks})`,
    `AND (`,
    `  (b."checkInDate" >= ${ws}::timestamp AND b."checkInDate" < ${we}::timestamp AND b."checkIn" >= ${s}::timestamp AND b."checkIn" < ${e}::timestamp)`,
    `  OR (b."checkOutDate" >= ${ws}::timestamp AND b."checkOutDate" < ${we}::timestamp AND b."checkOut" >= ${s}::timestamp AND b."checkOut" < ${e}::timestamp)`,
    `)`,
  ].join("\n");
  const sql = [
    `WITH d AS (`,
    `  SELECT b."id" FROM "Booking" b`,
    `  WHERE ${where}`,
    `  LIMIT ${lim}`,
    `),`,
    `bp AS (SELECT y."bookingId" AS booking_id, SUM(y."total") AS total, SUM(y."amountPaid") AS paid FROM "BookingPricing" y WHERE y."bookingId" IN (SELECT d."id" FROM d) GROUP BY y."bookingId"),`,
    `ex AS (SELECT x."bookingId" AS booking_id, count(*) AS n, count(*) FILTER (WHERE NOT x."done") AS pending FROM "BookingExtraService" x WHERE x."bookingId" IN (SELECT d."id" FROM d) GROUP BY x."bookingId")`,
    `SELECT`,
    `  ${BOOKING_SELECT}`,
    `FROM d`,
    `JOIN "Booking" b ON b."id" = d."id"`,
    `LEFT JOIN "Client" c ON c."id" = COALESCE(b."customerId", b."clientId")`,
    `LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
    `LEFT JOIN "Partner" pa ON pa."id" = b."partnerId"`,
    `LEFT JOIN "Garage" g ON g."id" = b."garageId"`,
    `LEFT JOIN "Spot" s ON s."id" = b."spotId"`,
    `LEFT JOIN "Garage" sg ON sg."id" = s."garageId"`,
    `LEFT JOIN "Cancellation" cx ON cx."bookingId" = b."id"`,
    `LEFT JOIN bp ON bp.booking_id = b."id"`,
    `LEFT JOIN ex ON ex.booking_id = b."id"`,
  ].join("\n");
  return { sql, params: p.values };
}

export type DayBookingRow = Record<string, unknown>;

/** Linha → reserva (com o grupo operacional do parque). PURA. */
export function mapDayBookingRow(r: DayBookingRow, park: Pick<DayPark, "id" | "name" | "cityName" | "key" | "label" | "ours" | "order"> & Partial<Pick<DayPark, "city" | "brand">> | undefined): DayBooking {
  const price = num(r.price);
  const paid = num(r.paid);
  const parkId = String(r.park_id ?? "");
  const group = park
    ? operationalParkGroup(park)
    : { key: `park:${parkId}`, label: "Parque desconhecido", ours: false, order: OTHER_PARK_GROUP_ORDER };
  const clientName = [str(r.client_first_name), str(r.client_last_name)].filter(Boolean).join(" ") || null;
  return {
    id: String(r.id ?? ""),
    code: str(r.code),
    status: str(r.status) ?? "",
    checkIn: toIsoUtc(r.check_in),
    checkOut: toIsoUtc(r.check_out),
    checkInTime: str(r.check_in_time),
    checkOutTime: str(r.check_out_time),
    createdAt: toIsoUtc(r.created_at),
    parkId,
    parkName: park?.name ?? null,
    parkCity: park?.cityName ?? null,
    cityKey: park?.city ?? null,
    brand: park?.brand ?? null,
    groupKey: group.key,
    groupLabel: group.label,
    groupOrder: group.order,
    ours: group.ours,
    clientName,
    clientEmail: str(r.client_email),
    clientPhone: str(r.client_phone),
    plate: str(r.plate),
    vehicleBrand: str(r.vehicle_brand),
    vehicleModel: str(r.vehicle_model),
    vehicleColor: str(r.vehicle_color),
    vehicleType: str(r.vehicle_type),
    departingFlight: str(r.departing_flight),
    departingFlightEta: toIsoUtc(r.departing_flight_eta),
    returnFlight: str(r.return_flight),
    returnFlightEta: toIsoUtc(r.return_flight_eta),
    deliveryType: str(r.delivery_type),
    deliveryLocation: str(r.delivery_location),
    extrasCount: num(r.extras_count) ?? 0,
    extrasPending: num(r.extras_pending) ?? 0,
    origin: str(r.origin),
    paymentSource: str(r.payment_source),
    partnerId: str(r.partner_id),
    partnerName: str(r.partner_name),
    partnerType: str(r.partner_type),
    garage: str(r.garage),
    spot: str(r.spot),
    price,
    paid,
    toPay: price != null ? Math.max(0, Math.round((price - (paid ?? 0)) * 100) / 100) : null,
    paymentMethod: str(r.payment_method),
    currency: str(r.currency) ?? "EUR",
    pro: bool(r.pro),
    remarks: str(r.remarks),
    checkInDriverName: str(r.check_in_driver),
    checkOutDriverName: str(r.check_out_driver),
    cancelledAt: toIsoUtc(r.cancelled_at),
    cancelReason: str(r.cancel_reason),
    customerCheckinEta: num(r.customer_checkin_eta),
    phases: {
      checkingInAt: toIsoUtc(r.checking_in_at),
      movingAt: toIsoUtc(r.moving_at),
      pendingCheckoutAt: toIsoUtc(r.pending_checkout_at),
      checkingOutAt: toIsoUtc(r.checking_out_at),
      arrivedAtDeliveryAt: toIsoUtc(r.arrived_at_delivery_at),
      baggageWaitingAt: toIsoUtc(r.baggage_waiting_at),
    },
  };
}

// ─── Leitura (nunca lança) ──────────────────────────────────────────────────

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export interface DayBookingsResult {
  day: string;
  startMs: number;
  endMs: number;
  parks: DayParkOut[];
  movements: DayMovement[];
  /** Houve mais reservas do que o limite (a lista está cortada). */
  truncated: boolean;
  limit: number;
  /** Parques do âmbito tirados da lista ("Parques que a operação não faz"). */
  excludedParks: number;
}

/**
 * Reservas do dia de Lisboa `day`, dos parques das cidades `cities`
 * (undefined = todas), sem os parques de `excludedParkIds` (Definições).
 */
export async function getMultiparkDayBookings(day: string, cities?: string[], excludedParkIds: readonly string[] = [], query: Query = multiparkDbQuery): Promise<MultiparkRead<DayBookingsResult>> {
  return safeMultiparkRead("reservas do dia", async () => {
    const bounds = lisbonDayBounds(day);
    const ps = buildParksSql();
    const inScope = mapParks(await query(ps.sql, ps.params), cities);
    const parks = excludeParks(inScope, excludedParkIds);
    const base = { day, startMs: bounds.startMs, endMs: bounds.endMs, limit: DAY_BOOKINGS_LIMIT, excludedParks: inScope.length - parks.length };
    const parksOut = parks.map(parkOut);
    if (!parks.length) return { ...base, parks: parksOut, movements: [], truncated: false };
    const { sql, params } = buildDayBookingsSql(bounds, parks.map((p) => p.id), DAY_BOOKINGS_LIMIT + 1);
    const rows = await query<DayBookingRow>(sql, params);
    const byId = new Map(parks.map((p) => [p.id, p]));
    const bookings = rows.slice(0, DAY_BOOKINGS_LIMIT).map((r) => mapDayBookingRow(r, byId.get(String(r.park_id ?? ""))));
    return {
      ...base,
      parks: parksOut,
      movements: toDayMovements(bookings, bounds.startMs, bounds.endMs),
      truncated: rows.length > DAY_BOOKINGS_LIMIT,
    };
  });
}

/**
 * "Classificação dos parques": todos os parques do âmbito com a classificação
 * calculada (para o Jorge confirmar). Uma leitura leve da tabela "Park".
 */
// 28a: ids dos parques que NÃO operamos pelo nome (lista do Jorge), para os
// filtros que só aceitam ids (SQL das Ocorrências). Cache de 10 min no processo.
const NOT_OPERATED_IDS_CACHE_MS = 10 * 60_000;
let notOperatedIdsCache: { at: number; ids: string[] } | null = null;

/** Ids dos parques fora pela lista de nomes. Só leitura; falha → [] (fica só a lista por id). Nunca lança. */
export async function getNotOperatedParkIds(query: Query = multiparkDbQuery): Promise<string[]> {
  if (notOperatedIdsCache && Date.now() - notOperatedIdsCache.at < NOT_OPERATED_IDS_CACHE_MS) return notOperatedIdsCache.ids;
  try {
    const ps = buildParksSql();
    const ids = mapParks(await query(ps.sql, ps.params)).filter((p) => isNotOperatedByName(p.name)).map((p) => p.id);
    notOperatedIdsCache = { at: Date.now(), ids };
    return ids;
  } catch (err: any) {
    console.warn("[multiparkDb] parques não operados:", String(err?.message ?? err).slice(0, 160));
    return [];
  }
}

export async function getMultiparkParkClassification(cities?: string[], query: Query = multiparkDbQuery): Promise<MultiparkRead<{ parks: DayParkOut[] }>> {
  return safeMultiparkRead("classificação dos parques", async () => {
    const ps = buildParksSql();
    return { parks: mapParks(await query(ps.sql, ps.params), cities).map(parkOut) };
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
