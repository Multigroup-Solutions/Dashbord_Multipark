/**
 * "Estado do parque" para a Passagem de turno, lido AO VIVO da BD da
 * Multipark (BD 2) — sem passar pelas nossas cópias (multipark_bookings /
 * multipark_booking_history / incidents). Segue as regras de read.ts e
 * dayBookings.ts: SQL parametrizado, construtores e mapeadores PUROS, LIMIT
 * sempre e nunca lança (`{ available:false, reason }`).
 *
 * O que lê (só dos parques das cidades pedidas — "Park".city):
 *   1. carros no parque AGORA por parque/garagem/lugar (estado CHECKING_IN,
 *      CHECKED_IN, MOVING, PENDING_CHECKOUT, CHECKING_OUT) — os que não
 *      estão em CHECKED_IN são as operações "em curso";
 *   2. próximas recolhas (checkIn) e entregas (checkOut) numa janela (por
 *      omissão as próximas 8h), com voo e ETA do voo e valor por pagar;
 *   3. ocorrências por resolver ("Occurrence".resolved = false);
 *   4. caixa por fechar: reservas com movimento na janela do turno ainda
 *      sem cashierClosed / cashValidated / driverValidated;
 *   5. bloqueios de disponibilidade ("ParkAvailabilityBlock") e horário
 *      ("OperatingHours") de um dia (por omissão amanhã). Estas duas leituras
 *      são opcionais: se falharem, o resto continua.
 *
 * Colunas usadas (docs/multipark-db/schema.md):
 *   Booking: id, allocation, status, parkId, parkingType, checkIn, checkOut,
 *     checkInDate, checkOutDate, clientId, customerId, vehicleId, garageId,
 *     spotId, externalGarage, externalRow, externalSpot, departingFlight,
 *     departingFlightEta, returnFlight, returnFlightEta, deliveryType,
 *     bookingPrice, paymentMethod, checkInDriverName, checkOutDriverName,
 *     cashierClosed, cashValidated, driverValidated, checkingInAt, movingAt,
 *     pendingCheckoutAt, checkingOutAt, arrivedAtDeliveryAt, baggageWaitingAt
 *   Client: firstName, lastName · BookingVehicle: licensePlate
 *   Garage: name · Spot: row, spot, garageId · BookingPricing: total, amountPaid
 *   Occurrence: id, title, priority, resolved, createdAt, agentName, parkId,
 *     bookingId, remarks
 *   ParkAvailabilityBlock: id, parkId, scope, weekday, dayOfMonth, startDate,
 *     endDate, startTime, endTime, appliesTo, label
 *   OperatingHours: parkId, day, openTime, closeTime
 */
import { multiparkDbQuery, redactSecrets, type SqlParam } from "./client";
import { ParamList, safeMultiparkRead, toIsoUtc, type MultiparkRead } from "./read";
import { buildParksSql, mapParks, type DayPark } from "./dayBookings";
import { excludeParks } from "../../shared/reservasDoDia";
import { classifyAllocation } from "../spotClassification";
import { addDays, lisbonDayOf } from "../../shared/lisbonDay";

export const SHIFT_STATE_IN_PARK_LIMIT = 2000;
export const SHIFT_STATE_UPCOMING_LIMIT = 1000;
export const SHIFT_STATE_OCCURRENCES_LIMIT = 200;
export const SHIFT_STATE_CASH_LIMIT = 500;
export const SHIFT_STATE_DEFAULT_WINDOW_HOURS = 8;

/** Estados em que o carro está (ou está a entrar/sair) no parque. */
export const IN_PARK_LIVE_STATUSES = ["CHECKING_IN", "CHECKED_IN", "MOVING", "PENDING_CHECKOUT", "CHECKING_OUT"] as const;
/** Estados com movimento feito (para a caixa do turno). */
const CASH_STATUSES = ["CHECKED_IN", "MOVING", "PENDING_CHECKOUT", "CHECKING_OUT", "CHECKED_OUT"] as const;

const sqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const ts = (expr: string) => `to_char(${expr}, 'YYYY-MM-DD HH24:MI:SS')`;
const statusList = (list: readonly string[]) => list.map((s) => `'${s}'`).join(", ");
const GARAGE = `COALESCE(g."name", sg."name", NULLIF(b."externalGarage", ''))`;
const SPOT = `COALESCE(NULLIF(concat_ws(' ', NULLIF(s."row", ''), NULLIF(s."spot", '')), ''), NULLIF(concat_ws(' ', NULLIF(b."externalRow", ''), NULLIF(b."externalSpot", '')), ''))`;
const JOINS = [
  `LEFT JOIN "Client" c ON c."id" = COALESCE(b."customerId", b."clientId")`,
  `LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
  `LEFT JOIN "Garage" g ON g."id" = b."garageId"`,
  `LEFT JOIN "Spot" s ON s."id" = b."spotId"`,
  `LEFT JOIN "Garage" sg ON sg."id" = s."garageId"`,
].join("\n");
const PRICING = `LEFT JOIN LATERAL (SELECT SUM(y."total") AS total, SUM(y."amountPaid") AS paid FROM "BookingPricing" y WHERE y."bookingId" = b."id") bp ON true`;
const lim = (p: ParamList, n: number, max: number) => p.add(Math.min(Math.max(Math.floor(n), 1), max));
const parkIn = (p: ParamList, parkIds: string[]) => {
  if (!parkIds.length) throw new Error("Sem parques.");
  return parkIds.map((id) => p.add(id)).join(", ");
};

// ─── Construtores de SQL (PUROS) ────────────────────────────────────────────

/** Carros no parque agora (e operações em curso). Índice ("parkId", status). PURA. */
export function buildInParkSql(parkIds: string[], limit = SHIFT_STATE_IN_PARK_LIMIT + 1): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const parks = parkIn(p, parkIds);
  const l = lim(p, limit, SHIFT_STATE_IN_PARK_LIMIT + 1);
  const sql = [
    `SELECT b."id" AS id, NULLIF(b."allocation", '') AS code, b."status"::text AS status, b."parkId" AS park_id,`,
    `  b."parkingType"::text AS parking_type, ${ts(`b."checkIn"`)} AS check_in, ${ts(`b."checkOut"`)} AS check_out,`,
    `  v."licensePlate" AS plate, c."firstName" AS client_first_name, c."lastName" AS client_last_name,`,
    `  ${GARAGE} AS garage, ${SPOT} AS spot,`,
    `  NULLIF(b."returnFlight", '') AS return_flight, ${ts(`b."returnFlightEta"`)} AS return_flight_eta,`,
    `  ${ts(`b."checkingInAt"`)} AS checking_in_at, ${ts(`b."movingAt"`)} AS moving_at,`,
    `  ${ts(`b."pendingCheckoutAt"`)} AS pending_checkout_at, ${ts(`b."checkingOutAt"`)} AS checking_out_at,`,
    `  ${ts(`b."arrivedAtDeliveryAt"`)} AS arrived_at_delivery_at, ${ts(`b."baggageWaitingAt"`)} AS baggage_waiting_at`,
    `FROM "Booking" b`,
    JOINS,
    `WHERE b."parkId" IN (${parks}) AND b."status" IN (${statusList(IN_PARK_LIVE_STATUSES)})`,
    `ORDER BY b."checkOut"`,
    `LIMIT ${l}`,
  ].join("\n");
  return { sql, params: p.values };
}

/**
 * Recolhas (kind "checkin", pelo checkIn) ou entregas ("checkout", pelo
 * checkOut) em [startMs, endMs). Pré-filtro com 1 dia de folga nas colunas
 * indexadas …Date. Canceladas fora. PURA.
 */
export function buildUpcomingSql(kind: "checkin" | "checkout", parkIds: string[], startMs: number, endMs: number, limit = SHIFT_STATE_UPCOMING_LIMIT + 1): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const parks = parkIn(p, parkIds);
  const s = p.add(sqlTs(startMs));
  const e = p.add(sqlTs(endMs));
  const ws = p.add(sqlTs(startMs - 86_400_000));
  const we = p.add(sqlTs(endMs + 86_400_000));
  const l = lim(p, limit, SHIFT_STATE_UPCOMING_LIMIT + 1);
  const at = kind === "checkin" ? `b."checkIn"` : `b."checkOut"`;
  const dateCol = kind === "checkin" ? `b."checkInDate"` : `b."checkOutDate"`;
  const flight = kind === "checkin" ? `b."departingFlight"` : `b."returnFlight"`;
  const eta = kind === "checkin" ? `b."departingFlightEta"` : `b."returnFlightEta"`;
  const sql = [
    `SELECT b."id" AS id, NULLIF(b."allocation", '') AS code, b."status"::text AS status, b."parkId" AS park_id,`,
    `  b."parkingType"::text AS parking_type, ${ts(at)} AS at,`,
    `  v."licensePlate" AS plate, c."firstName" AS client_first_name, c."lastName" AS client_last_name,`,
    `  NULLIF(${flight}, '') AS flight, ${ts(eta)} AS flight_eta, NULLIF(b."deliveryType", '') AS delivery_type,`,
    `  ${GARAGE} AS garage, ${SPOT} AS spot,`,
    `  COALESCE(bp.total, b."bookingPrice") AS price, bp.paid AS paid`,
    `FROM "Booking" b`,
    JOINS,
    PRICING,
    `WHERE b."parkId" IN (${parks})`,
    `  AND ${dateCol} >= ${ws}::timestamp AND ${dateCol} < ${we}::timestamp`,
    `  AND ${at} >= ${s}::timestamp AND ${at} < ${e}::timestamp`,
    // Compras online ainda por pagar (PENDING) CONTAM: vão ser recolhidas na
    // mesma e a equipa tem de as ver (Jorge, 2 out 2026). Só as canceladas saem.
    `  AND b."status"::text <> 'CANCELLED'`,
    `ORDER BY ${at}`,
    `LIMIT ${l}`,
  ].join("\n");
  return { sql, params: p.values };
}

/** Ocorrências por resolver (mais recentes primeiro). PURA. */
export function buildOpenOccurrencesSql(parkIds: string[], limit = SHIFT_STATE_OCCURRENCES_LIMIT + 1): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const parks = parkIn(p, parkIds);
  const l = lim(p, limit, SHIFT_STATE_OCCURRENCES_LIMIT + 1);
  const sql = [
    `SELECT o."id" AS id, o."title" AS title, o."priority"::text AS priority, ${ts(`o."createdAt"`)} AS created_at,`,
    `  NULLIF(o."agentName", '') AS agent_name, o."parkId" AS park_id, NULLIF(o."remarks", '') AS remarks,`,
    `  NULLIF(bk."allocation", '') AS booking_code, v."licensePlate" AS plate`,
    `FROM "Occurrence" o`,
    `LEFT JOIN "Booking" bk ON bk."id" = o."bookingId"`,
    `LEFT JOIN "BookingVehicle" v ON v."id" = bk."vehicleId"`,
    `WHERE o."parkId" IN (${parks}) AND o."resolved" = false`,
    `ORDER BY o."createdAt" DESC`,
    `LIMIT ${l}`,
  ].join("\n");
  return { sql, params: p.values };
}

/**
 * Caixa do turno: reservas com recolha ou entrega em [startMs, endMs) que
 * ainda têm cashierClosed / cashValidated / driverValidated por fazer. PURA.
 */
export function buildCashOpenSql(parkIds: string[], startMs: number, endMs: number, limit = SHIFT_STATE_CASH_LIMIT + 1): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const parks = parkIn(p, parkIds);
  const s = p.add(sqlTs(startMs));
  const e = p.add(sqlTs(endMs));
  const ws = p.add(sqlTs(startMs - 86_400_000));
  const we = p.add(sqlTs(endMs + 86_400_000));
  const l = lim(p, limit, SHIFT_STATE_CASH_LIMIT + 1);
  const sql = [
    `SELECT b."id" AS id, NULLIF(b."allocation", '') AS code, b."status"::text AS status, b."parkId" AS park_id,`,
    `  ${ts(`b."checkIn"`)} AS check_in, ${ts(`b."checkOut"`)} AS check_out, v."licensePlate" AS plate,`,
    `  NULLIF(b."paymentMethod", '') AS payment_method, NULLIF(b."checkInDriverName", '') AS check_in_driver,`,
    `  NULLIF(b."checkOutDriverName", '') AS check_out_driver,`,
    `  b."cashierClosed" AS cashier_closed, b."cashValidated" AS cash_validated, b."driverValidated" AS driver_validated,`,
    `  bp.paid AS paid`,
    `FROM "Booking" b`,
    `LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
    PRICING,
    `WHERE b."parkId" IN (${parks}) AND b."status" IN (${statusList(CASH_STATUSES)})`,
    `  AND (`,
    `    (b."checkInDate" >= ${ws}::timestamp AND b."checkInDate" < ${we}::timestamp AND b."checkIn" >= ${s}::timestamp AND b."checkIn" < ${e}::timestamp)`,
    `    OR (b."status" = 'CHECKED_OUT' AND b."checkOutDate" >= ${ws}::timestamp AND b."checkOutDate" < ${we}::timestamp AND b."checkOut" >= ${s}::timestamp AND b."checkOut" < ${e}::timestamp)`,
    `  )`,
    `  AND (b."cashierClosed" = false OR b."cashValidated" = false OR b."driverValidated" = false)`,
    `ORDER BY b."checkOut"`,
    `LIMIT ${l}`,
  ].join("\n");
  return { sql, params: p.values };
}

/** Bloqueios de disponibilidade dos parques (tabela pequena; o filtro do dia é PURO). PURA. */
export function buildBlocksSql(parkIds: string[]): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const parks = parkIn(p, parkIds);
  return {
    sql: `SELECT a."id" AS id, a."parkId" AS park_id, a."scope"::text AS scope, a."weekday" AS weekday, a."dayOfMonth" AS day_of_month, a."startDate" AS start_date, a."endDate" AS end_date, a."startTime" AS start_time, a."endTime" AS end_time, a."appliesTo"::text AS applies_to, NULLIF(a."label", '') AS label FROM "ParkAvailabilityBlock" a WHERE a."parkId" IN (${parks}) LIMIT 1000`,
    params: p.values,
  };
}

/** Horário dos parques (tabela pequena; o filtro do dia é PURO). PURA. */
export function buildOperatingHoursSql(parkIds: string[]): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const parks = parkIn(p, parkIds);
  return {
    sql: `SELECT h."parkId" AS park_id, h."day" AS day, h."openTime" AS open_time, h."closeTime" AS close_time FROM "OperatingHours" h WHERE h."parkId" IN (${parks}) LIMIT 1000`,
    params: p.values,
  };
}

// ─── Tipos ──────────────────────────────────────────────────────────────────

export type LivePhase = "checking_in" | "in_park" | "moving" | "pending_checkout" | "baggage_waiting" | "at_delivery" | "checking_out";

export const LIVE_PHASE_LABELS: Record<LivePhase, string> = {
  checking_in: "A fazer check-in",
  in_park: "No parque",
  moving: "Em movimento",
  pending_checkout: "Entrega pendente",
  baggage_waiting: "À espera das malas",
  at_delivery: "No local de entrega",
  checking_out: "A fazer check-out",
};

export interface LiveCar {
  id: string;
  code: string | null;
  status: string;
  phase: LivePhase;
  /** Desde quando está na fase atual (ISO) — null em "No parque". */
  phaseSince: string | null;
  parkId: string;
  parkName: string | null;
  garage: string | null;
  spot: string | null;
  plate: string | null;
  clientName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  /** Lugar coberto (produto COVERED ou allocation 5000–7999). */
  covered: boolean;
  /** 44b: tipo de lugar — o do lugar onde está (allocation) ou, sem ele, o do produto reservado. */
  spotType: LiveSpotType;
  movingAt: string | null;
  returnFlight: string | null;
  returnFlightEta: string | null;
  /** Ainda no parque depois da hora prevista de saída. */
  overdue: boolean;
}

export interface LiveUpcoming {
  id: string;
  code: string | null;
  kind: "checkin" | "checkout";
  at: string | null;
  status: string;
  /** Já feita (recolha já recebida / entrega já feita). */
  done: boolean;
  parkId: string;
  parkName: string | null;
  plate: string | null;
  clientName: string | null;
  flight: string | null;
  flightEta: string | null;
  deliveryType: string | null;
  covered: boolean;
  garage: string | null;
  spot: string | null;
  toPay: number | null;
}

export interface LiveOccurrence {
  id: string;
  title: string;
  priority: string | null;
  createdAt: string | null;
  agentName: string | null;
  parkName: string | null;
  bookingCode: string | null;
  plate: string | null;
  remarks: string | null;
}

export interface LiveCashRow {
  id: string;
  code: string | null;
  status: string;
  parkName: string | null;
  plate: string | null;
  at: string | null;
  driver: string | null;
  paymentMethod: string | null;
  paid: number | null;
  cashierClosed: boolean;
  cashValidated: boolean;
  driverValidated: boolean;
}

export interface LiveBlock {
  id: string;
  parkName: string | null;
  scope: string;
  appliesTo: string;
  startTime: string | null;
  endTime: string | null;
  label: string | null;
}

export interface LiveHours { parkName: string | null; day: string; openTime: string; closeTime: string }

/** 44b: tipos de lugar (Booking.parkingType / allocation). */
export type LiveSpotType = "uncovered" | "covered" | "indoor" | "vip" | "unknown";
export const LIVE_SPOT_TYPE_LABELS: Record<LiveSpotType, string> = {
  uncovered: "Descoberto", covered: "Coberto", indoor: "Interior", vip: "VIP", unknown: "Sem tipo",
};
const SPOT_TYPE_ORDER: LiveSpotType[] = ["uncovered", "covered", "indoor", "vip", "unknown"];

/** Tipo de lugar: o lugar onde está (allocation) manda; sem ele, o produto reservado (parkingType). PURA. */
export function liveSpotTypeOf(parkingType: unknown, code: string | null): LiveSpotType {
  const byAllocation = classifyAllocation(code).spotType;
  if (byAllocation !== "unknown") return byAllocation;
  const t = String(parkingType ?? "").trim().toUpperCase();
  if (t === "COVERED") return "covered";
  if (t === "UNCOVERED") return "uncovered";
  if (t === "INDOOR") return "indoor";
  if (t === "VIP") return "vip";
  return "unknown";
}

export interface SpotTypeCount { type: LiveSpotType; label: string; total: number; byPark: Array<{ parkName: string; count: number }> }

/**
 * 44b (Jorge, 7 out 2026: "dividido só por cobertos, descobertos… do que por
 * parques — fica mais confuso"): carros no parque (fase "No parque") por tipo
 * de lugar, na cidade escolhida; dentro de cada tipo, quantos em cada parque.
 * Só os tipos com carros. PURA.
 */
export function summarizeBySpotType(cars: LiveCar[]): SpotTypeCount[] {
  const by = new Map<LiveSpotType, Map<string, number>>();
  for (const c of cars) {
    if (c.phase !== "in_park") continue;
    const m = by.get(c.spotType) ?? new Map<string, number>();
    const park = c.parkName ?? "?";
    m.set(park, (m.get(park) ?? 0) + 1);
    by.set(c.spotType, m);
  }
  return SPOT_TYPE_ORDER.filter((t) => by.has(t)).map((type) => {
    const m = by.get(type)!;
    const byPark = [...m.entries()].map(([parkName, count]) => ({ parkName, count })).sort((a, b) => b.count - a.count || a.parkName.localeCompare(b.parkName, "pt"));
    return { type, label: LIVE_SPOT_TYPE_LABELS[type], total: byPark.reduce((s, x) => s + x.count, 0), byPark };
  });
}

export interface ParkGarageCount { garage: string; count: number }
export interface ParkInParkSummary { parkId: string; parkName: string; total: number; garages: ParkGarageCount[] }

export interface ShiftStateOptions {
  /** Cidades (Park.city); undefined = todas. */
  cities?: string[];
  /** "Parques que a operação não faz" (Definições → operations.excludedParks): ficam de fora. */
  excludedParkIds?: readonly string[];
  nowMs?: number;
  /** Janela das próximas recolhas/entregas (omissão: agora → +8h). */
  upcoming?: { startMs: number; endMs: number };
  /** Janela da caixa do turno (omissão: últimas 12h até agora). */
  cash?: { startMs: number; endMs: number };
  /** Dia de Lisboa dos bloqueios/horário (omissão: amanhã). */
  blocksDay?: string;
}

export interface ShiftState {
  generatedAt: string;
  parks: Array<{ id: string; name: string; label: string }>;
  upcomingWindow: { start: string; end: string };
  cashWindow: { start: string; end: string };
  blocksDay: string;
  inPark: { total: number; byPark: ParkInParkSummary[]; byType: SpotTypeCount[]; cars: LiveCar[]; overdue: number; truncated: boolean };
  /** Operações em curso (tudo o que não é "No parque"). */
  inProgress: LiveCar[];
  upcoming: { checkins: LiveUpcoming[]; checkouts: LiveUpcoming[]; truncated: boolean };
  occurrences: { list: LiveOccurrence[]; truncated: boolean };
  cash: { total: number; notCashierClosed: number; notCashValidated: number; notDriverValidated: number; list: LiveCashRow[]; truncated: boolean };
  /** null = a leitura falhou (tabela opcional). */
  blocks: LiveBlock[] | null;
  hours: LiveHours[] | null;
}

// ─── Mapeadores (PUROS) ─────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type ParkRef = Pick<DayPark, "name">;

/** Fase de uma reserva no parque (a mais específica primeiro). PURA. */
export function livePhaseOf(r: { status: string | null; baggageWaitingAt?: string | null; arrivedAtDeliveryAt?: string | null }): LivePhase {
  const st = String(r.status ?? "").toUpperCase();
  if (st === "CHECKING_IN") return "checking_in";
  if (st === "MOVING") return "moving";
  if (st === "CHECKING_OUT") return "checking_out";
  if (st === "PENDING_CHECKOUT") return r.baggageWaitingAt ? "baggage_waiting" : r.arrivedAtDeliveryAt ? "at_delivery" : "pending_checkout";
  return "in_park";
}

const isCovered = (parkingType: unknown, code: string | null) =>
  String(parkingType ?? "").toUpperCase() === "COVERED" || classifyAllocation(code).spotType === "covered";

export function mapLiveCar(r: Row, park: ParkRef | undefined, nowMs: number): LiveCar {
  const code = str(r.code);
  const status = str(r.status) ?? "";
  const baggageWaitingAt = toIsoUtc(r.baggage_waiting_at);
  const arrivedAtDeliveryAt = toIsoUtc(r.arrived_at_delivery_at);
  const phase = livePhaseOf({ status, baggageWaitingAt, arrivedAtDeliveryAt });
  const since: Record<LivePhase, string | null> = {
    checking_in: toIsoUtc(r.checking_in_at),
    in_park: null,
    moving: toIsoUtc(r.moving_at),
    pending_checkout: toIsoUtc(r.pending_checkout_at),
    baggage_waiting: baggageWaitingAt,
    at_delivery: arrivedAtDeliveryAt,
    checking_out: toIsoUtc(r.checking_out_at),
  };
  const checkOut = toIsoUtc(r.check_out);
  return {
    id: String(r.id ?? ""),
    code,
    status,
    phase,
    phaseSince: since[phase],
    parkId: String(r.park_id ?? ""),
    parkName: park?.name ?? null,
    garage: str(r.garage),
    spot: str(r.spot),
    plate: str(r.plate),
    clientName: name(r),
    checkIn: toIsoUtc(r.check_in),
    checkOut,
    covered: isCovered(r.parking_type, code),
    spotType: liveSpotTypeOf(r.parking_type, code),
    movingAt: toIsoUtc(r.moving_at),
    returnFlight: str(r.return_flight),
    returnFlightEta: toIsoUtc(r.return_flight_eta),
    overdue: phase === "in_park" && checkOut != null && Date.parse(checkOut) < nowMs,
  };
}

export function mapLiveUpcoming(kind: "checkin" | "checkout", r: Row, park: ParkRef | undefined): LiveUpcoming {
  const code = str(r.code);
  const status = str(r.status) ?? "";
  const st = status.toUpperCase();
  const price = num(r.price);
  const paid = num(r.paid);
  return {
    id: String(r.id ?? ""),
    code,
    kind,
    at: toIsoUtc(r.at),
    status,
    done: kind === "checkin" ? !["BOOKED", "PENDING", "CHECKING_IN"].includes(st) : st === "CHECKED_OUT",
    parkId: String(r.park_id ?? ""),
    parkName: park?.name ?? null,
    plate: str(r.plate),
    clientName: name(r),
    flight: str(r.flight),
    flightEta: toIsoUtc(r.flight_eta),
    deliveryType: str(r.delivery_type),
    covered: isCovered(r.parking_type, code),
    garage: str(r.garage),
    spot: str(r.spot),
    toPay: price != null ? Math.max(0, Math.round((price - (paid ?? 0)) * 100) / 100) : null,
  };
}

export function mapLiveOccurrence(r: Row, park: ParkRef | undefined): LiveOccurrence {
  return {
    id: String(r.id ?? ""),
    title: str(r.title) ?? "Ocorrência",
    priority: str(r.priority),
    createdAt: toIsoUtc(r.created_at),
    agentName: str(r.agent_name),
    parkName: park?.name ?? null,
    bookingCode: str(r.booking_code),
    plate: str(r.plate),
    remarks: str(r.remarks),
  };
}

export function mapLiveCash(r: Row, park: ParkRef | undefined): LiveCashRow {
  const status = str(r.status) ?? "";
  const out = status.toUpperCase() === "CHECKED_OUT";
  return {
    id: String(r.id ?? ""),
    code: str(r.code),
    status,
    parkName: park?.name ?? null,
    plate: str(r.plate),
    at: toIsoUtc(out ? r.check_out : r.check_in),
    driver: str(out ? r.check_out_driver : r.check_in_driver),
    paymentMethod: str(r.payment_method),
    paid: num(r.paid),
    cashierClosed: bool(r.cashier_closed),
    cashValidated: bool(r.cash_validated),
    driverValidated: bool(r.driver_validated),
  };
}

/** Carros no parque (fase "No parque" e em curso) por parque → garagem. PURA. */
export function summarizeInPark(cars: LiveCar[], parks: Array<{ id: string; name: string }>): ParkInParkSummary[] {
  const byPark = new Map<string, Map<string, number>>();
  for (const c of cars) {
    const g = byPark.get(c.parkId) ?? new Map<string, number>();
    const key = c.garage ?? "Sem garagem";
    g.set(key, (g.get(key) ?? 0) + 1);
    byPark.set(c.parkId, g);
  }
  return parks
    .filter((p) => byPark.has(p.id))
    .map((p) => {
      const g = byPark.get(p.id)!;
      const garages = [...g.entries()].map(([garage, count]) => ({ garage, count })).sort((a, b) => b.count - a.count || a.garage.localeCompare(b.garage, "pt"));
      return { parkId: p.id, parkName: p.name, total: garages.reduce((s, x) => s + x.count, 0), garages };
    });
}

const WEEKDAY_NAMES: string[][] = [
  ["0", "7", "sunday", "sun", "domingo", "dom"],
  ["1", "monday", "mon", "segunda", "segunda-feira", "seg"],
  ["2", "tuesday", "tue", "terca", "terca-feira", "ter"],
  ["3", "wednesday", "wed", "quarta", "quarta-feira", "qua"],
  ["4", "thursday", "thu", "quinta", "quinta-feira", "qui"],
  ["5", "friday", "fri", "sexta", "sexta-feira", "sex"],
  ["6", "saturday", "sat", "sabado", "sabado", "sab"],
];
const plain = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
/** Dia da semana (0 = domingo) de um dia "YYYY-MM-DD". PURA. */
export function weekdayOf(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

/**
 * Bloqueios que se aplicam ao dia. Convenção assumida para `weekday`:
 * 0 = domingo … 6 = sábado (como Date.getDay). PURA.
 */
export function blocksForDay(rows: Row[], day: string, parkName: (id: string) => string | null): LiveBlock[] {
  const wd = weekdayOf(day);
  const dom = Number(day.slice(8, 10));
  const out: LiveBlock[] = [];
  for (const r of rows) {
    const scope = String(r.scope ?? "").toUpperCase();
    const start = str(r.start_date)?.slice(0, 10) ?? null;
    const end = str(r.end_date)?.slice(0, 10) ?? null;
    const applies =
      scope === "ALL_DAYS" ? true
      : scope === "WEEKDAY" ? num(r.weekday) === wd
      : scope === "DAY_OF_MONTH" ? num(r.day_of_month) === dom
      : scope === "DATE" ? start === day
      : scope === "DATE_RANGE" ? start != null && start <= day && (end == null || day <= end)
      : false;
    if (!applies) continue;
    out.push({
      id: String(r.id ?? ""),
      parkName: parkName(String(r.park_id ?? "")),
      scope,
      appliesTo: String(r.applies_to ?? "BOTH").toUpperCase(),
      startTime: str(r.start_time),
      endTime: str(r.end_time),
      label: str(r.label),
    });
  }
  return out;
}

/** Horário do dia (o campo `day` pode vir em inglês, PT ou número). PURA. */
export function hoursForDay(rows: Row[], day: string, parkName: (id: string) => string | null): LiveHours[] {
  const names = WEEKDAY_NAMES[weekdayOf(day)];
  return rows
    .filter((r) => names.includes(plain(r.day)) || plain(r.day) === day)
    .map((r) => ({ parkName: parkName(String(r.park_id ?? "")), day: String(r.day ?? ""), openTime: String(r.open_time ?? ""), closeTime: String(r.close_time ?? "") }));
}

// ─── Leitura (nunca lança) ──────────────────────────────────────────────────

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

const emptyState = (base: Pick<ShiftState, "generatedAt" | "upcomingWindow" | "cashWindow" | "blocksDay">): ShiftState => ({
  ...base,
  parks: [],
  inPark: { total: 0, byPark: [], byType: [], cars: [], overdue: 0, truncated: false },
  inProgress: [],
  upcoming: { checkins: [], checkouts: [], truncated: false },
  occurrences: { list: [], truncated: false },
  cash: { total: 0, notCashierClosed: 0, notCashValidated: 0, notDriverValidated: 0, list: [], truncated: false },
  blocks: [],
  hours: [],
});

/** Estado do parque AO VIVO para a passagem de turno (só os parques das `cities`, sem os excluídos). */
export async function getMultiparkShiftState(opts: ShiftStateOptions = {}, query: Query = multiparkDbQuery): Promise<MultiparkRead<ShiftState>> {
  return safeMultiparkRead("estado do parque (passagem de turno)", async () => {
    const nowMs = opts.nowMs ?? Date.now();
    const up = opts.upcoming ?? { startMs: nowMs, endMs: nowMs + SHIFT_STATE_DEFAULT_WINDOW_HOURS * 3_600_000 };
    const cw = opts.cash ?? { startMs: nowMs - 12 * 3_600_000, endMs: nowMs };
    const blocksDay = opts.blocksDay ?? addDays(lisbonDayOf(nowMs), 1);
    const base = {
      generatedAt: new Date(nowMs).toISOString(),
      upcomingWindow: { start: new Date(up.startMs).toISOString(), end: new Date(up.endMs).toISOString() },
      cashWindow: { start: new Date(cw.startMs).toISOString(), end: new Date(cw.endMs).toISOString() },
      blocksDay,
    };
    const ps = buildParksSql();
    const parks = excludeParks(mapParks(await query(ps.sql, ps.params), opts.cities), opts.excludedParkIds);
    if (!parks.length) return emptyState(base);
    const ids = parks.map((p) => p.id);
    const byId = new Map(parks.map((p) => [p.id, p]));
    const parkOf = (r: Row) => byId.get(String(r.park_id ?? ""));
    const parkName = (id: string) => byId.get(id)?.name ?? null;
    const run = (b: { sql: string; params: SqlParam[] }) => query<Row>(b.sql, b.params);
    const optional = async (b: { sql: string; params: SqlParam[] }): Promise<Row[] | null> => {
      try { return await run(b); } catch (err) {
        console.warn("[multiparkDb/shiftState] leitura opcional falhou:", redactSecrets(err).slice(0, 160));
        return null;
      }
    };

    const [inParkRows, ciRows, coRows, occRows, cashRows, blockRows, hourRows] = await Promise.all([
      run(buildInParkSql(ids)),
      run(buildUpcomingSql("checkin", ids, up.startMs, up.endMs)),
      run(buildUpcomingSql("checkout", ids, up.startMs, up.endMs)),
      run(buildOpenOccurrencesSql(ids)),
      run(buildCashOpenSql(ids, cw.startMs, cw.endMs)),
      optional(buildBlocksSql(ids)),
      optional(buildOperatingHoursSql(ids)),
    ]);

    const cars = inParkRows.slice(0, SHIFT_STATE_IN_PARK_LIMIT).map((r) => mapLiveCar(r, parkOf(r), nowMs));
    const cash = cashRows.slice(0, SHIFT_STATE_CASH_LIMIT).map((r) => mapLiveCash(r, parkOf(r)));
    return {
      ...base,
      parks: parks.map((p) => ({ id: p.id, name: p.name, label: p.label })),
      inPark: {
        total: cars.length,
        byPark: summarizeInPark(cars, parks),
        byType: summarizeBySpotType(cars),
        cars,
        overdue: cars.filter((c) => c.overdue).length,
        truncated: inParkRows.length > SHIFT_STATE_IN_PARK_LIMIT,
      },
      inProgress: cars.filter((c) => c.phase !== "in_park"),
      upcoming: {
        checkins: ciRows.slice(0, SHIFT_STATE_UPCOMING_LIMIT).map((r) => mapLiveUpcoming("checkin", r, parkOf(r))),
        checkouts: coRows.slice(0, SHIFT_STATE_UPCOMING_LIMIT).map((r) => mapLiveUpcoming("checkout", r, parkOf(r))),
        truncated: ciRows.length > SHIFT_STATE_UPCOMING_LIMIT || coRows.length > SHIFT_STATE_UPCOMING_LIMIT,
      },
      occurrences: {
        list: occRows.slice(0, SHIFT_STATE_OCCURRENCES_LIMIT).map((r) => mapLiveOccurrence(r, parkOf(r))),
        truncated: occRows.length > SHIFT_STATE_OCCURRENCES_LIMIT,
      },
      cash: {
        total: cash.length,
        notCashierClosed: cash.filter((c) => !c.cashierClosed).length,
        notCashValidated: cash.filter((c) => !c.cashValidated).length,
        notDriverValidated: cash.filter((c) => !c.driverValidated).length,
        list: cash,
        truncated: cashRows.length > SHIFT_STATE_CASH_LIMIT,
      },
      blocks: blockRows == null ? null : blocksForDay(blockRows, blocksDay, parkName),
      hours: hourRows == null ? null : hoursForDay(hourRows, blocksDay, parkName),
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
function name(r: Row): string | null {
  return [str(r.client_first_name), str(r.client_last_name)].filter(Boolean).join(" ") || null;
}
