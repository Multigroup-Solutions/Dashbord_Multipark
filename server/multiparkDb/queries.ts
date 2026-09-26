/**
 * ÚNICO sítio com o conhecimento do esquema da BD Multipark: as consultas e o
 * mapeamento "nosso campo ← tabela.coluna deles".
 *
 * ESTADO: POR MAPEAR. O esquema ainda não foi visto (a BD só é acessível do
 * PC do Jorge). Os nomes `TODO_…` abaixo são MARCADORES, não nomes reais.
 * Enquanto `MULTIPARK_DB_MAPPED.<entidade>` for false, o DbSource recusa-se a
 * correr (erro "por mapear") — nada lê nem escreve.
 *
 * Como preencher (sessão seguinte — ver docs/multipark-db/README.md):
 *   1. `pnpm tsx scripts/multipark-db-schema.ts` → docs/multipark-db/schema.md;
 *   2. em cada `*_QUERY`: `from` (tabela + JOINs) e a expressão SQL de cada
 *      alias (ou `null` se não existir — fica NULL). Aspas conforme o motor:
 *      Postgres/Prisma usa "camelCase" entre aspas duplas; MySQL `acentos`;
 *   3. `cursorAt`/`cursorId`: coluna de "última alteração" (Prisma:
 *      "updatedAt") e a chave primária — o sync incremental avança por aqui;
 *   4. `DATE_MODE`: comparar o checkIn de algumas reservas vindas da API e da
 *      BD (ver README) e escolher "utc" ou "lisbon_wallclock";
 *   5. confirmar que o id dos movimentos é o MESMO que a API devolve em
 *      /bookings/:id/history (senão ficam duplicados na avaliação);
 *   6. pôr `MULTIPARK_DB_MAPPED.<entidade> = true` e correr `pnpm test`
 *      (os testes das funções de mapeamento usam linhas com estes aliases).
 *
 * As funções `map*Row` trabalham sobre os ALIASES (nomes nossos, estáveis):
 * mudar o esquema deles só mexe nas expressões SQL, não no mapeamento.
 * O `mapBookingRow` devolve o MESMO formato da API (/bookings/:id), por isso
 * a gravação em multipark_bookings reutiliza bookingToRecord +
 * applyBookingDetail de server/jobs/multiparkBookingSync.ts sem alterações.
 */
import type { BookingActionType, MultiparkBooking } from "../multipark";
import type { MultiparkDbEngine, SqlParam } from "./client";
import { placeholder } from "./client";

// ─── Estado do mapeamento ───────────────────────────────────────────────────

/** Passa a true por entidade depois de preenchida e testada. */
export const MULTIPARK_DB_MAPPED = {
  bookings: false,
  movements: false,
  drivers: false,
} as const;

export type MappedEntity = keyof typeof MULTIPARK_DB_MAPPED;

/**
 * Como interpretar as datas da BD deles ao gravar em multipark_bookings:
 *  - "utc": o instante real em UTC (se a API também já estiver em UTC);
 *  - "lisbon_wallclock": hora de Lisboa escrita como se fosse UTC — que é o
 *    que o parseBookingDate faz hoje com o "DD/MM/YYYY, HH:mm" da API.
 * TODO(mapeamento): confirmar comparando reservas (README, passo 4).
 */
export const DATE_MODE: "utc" | "lisbon_wallclock" = "utc";

// ─── Aliases (nomes NOSSOS; as funções de mapeamento leem estes) ────────────

export const BOOKING_ALIASES = [
  "id", "booking_number", "status",
  "check_in", "check_out", "check_in_time", "check_out_time", "created_at", "updated_at", "cancelled_at", "cancel_reason",
  "park_id", "park_name", "park_city", "parking_type", "vehicle_type",
  "client_first_name", "client_last_name", "client_email", "client_phone", "client_nif",
  "license_plate", "vehicle_brand", "vehicle_model", "vehicle_color",
  "currency", "total_price", "parking_price", "delivery_charges", "extras_total", "discount", "remaining_to_pay", "total_paid", "payment_method",
  "delivery_service", "delivery_type", "delivery_address", "pickup_address",
  "arrival_flight", "departure_flight", "return_flight", "departing_flight",
  "remarks", "notes", "origin", "origin_url",
  "partner_id", "partner_name", "campaign_id", "campaign_name", "discount_code", "pro", "allocation",
  "cash_validated_by_name", "driver_validated_by_name", "cashier_closed_by_name",
  "extra_services",
] as const;
export type BookingAlias = (typeof BOOKING_ALIASES)[number];
export type BookingRow = Partial<Record<BookingAlias | "cursor_at", unknown>>;

export const MOVEMENT_ALIASES = [
  "id", "booking_id", "change_type", "action_time",
  "agent_user_id", "agent_name", "agent_first_name", "agent_last_name", "agent_email",
  "remarks", "modified_fields", "platform",
] as const;
export type MovementAlias = (typeof MOVEMENT_ALIASES)[number];
export type MovementRow = Partial<Record<MovementAlias | "cursor_at", unknown>>;

export const DRIVER_ALIASES = [
  "id", "first_name", "last_name", "full_name", "email", "role", "active", "park_id", "city", "updated_at",
] as const;
export type DriverAlias = (typeof DRIVER_ALIASES)[number];
export type DriverRow = Partial<Record<DriverAlias, unknown>>;

// ─── Consultas (TODO: preencher depois de correr o script do esquema) ───────

export interface EntityQuery<A extends string> {
  /** Tabela principal com alias + JOINs (sem WHERE). */
  from: string;
  /** Expressão SQL de cada alias; null = não existe (fica NULL). */
  columns: Record<A, string | null>;
  /** Coluna de última alteração (cursor incremental). */
  cursorAt: string;
  /** Chave única e ordenável (desempate do cursor). */
  cursorId: string;
}

/**
 * Tabela de mapeamento das reservas: alias ← tabela.coluna deles.
 * O MultiparkBooking (formato da API) que sai daqui alimenta os campos de
 * multipark_bookings indicados no comentário (via bookingToRecord /
 * applyBookingDetail).
 */
export const BOOKING_QUERY: EntityQuery<BookingAlias> = {
  from: "TODO_bookings b", // ex. (Prisma/Postgres): "Booking" b LEFT JOIN "Park" p ON p."id" = b."parkId" LEFT JOIN "Client" c ON …
  cursorAt: "b.TODO_updatedAt",
  cursorId: "b.TODO_id",
  columns: {
    id: "b.TODO_id",                                   // → externalId (TEM de ser o mesmo id da API/webhook)
    booking_number: "b.TODO_bookingNumber",            // → bookingNumber
    status: "b.TODO_status",                           // → status (BOOKED, CHECKED_IN, CHECKED_OUT, CANCELLED, …)
    check_in: "b.TODO_checkIn",                        // → checkIn (DATE_MODE)
    check_out: "b.TODO_checkOut",                      // → checkOut
    check_in_time: null,                               // → checkInTime "HH:mm" (null = derivado de check_in)
    check_out_time: null,                              // → checkOutTime
    created_at: "b.TODO_createdAt",                    // → bookingCreatedAt
    updated_at: "b.TODO_updatedAt",                    // → sourceUpdatedAt (impede recuos)
    cancelled_at: "b.TODO_cancelledAt",                // → cancelledAt
    cancel_reason: "b.TODO_cancelReason",              // → cancelReason
    park_id: "TODO_park.id",                           // → parkId
    park_name: "TODO_park.name",                       // → parkName (+ projectId pelo matcher)
    park_city: "TODO_park.city",                       // → city
    parking_type: "b.TODO_parkingType",                // → parkingType
    vehicle_type: "TODO_vehicle.type",                 // → vehicleType
    client_first_name: "TODO_client.firstName",        // → clientFirstName
    client_last_name: "TODO_client.lastName",          // → clientLastName
    client_email: "TODO_client.email",                 // → clientEmail
    client_phone: "TODO_client.phoneNumber",           // → clientPhone
    client_nif: "TODO_client.nif",                     // → clientNif
    license_plate: "TODO_vehicle.licensePlate",        // → licensePlate
    vehicle_brand: "TODO_vehicle.brand",               // → vehicleBrand
    vehicle_model: "TODO_vehicle.model",               // → vehicleModel
    vehicle_color: "TODO_vehicle.color",               // → vehicleColor
    currency: null,                                    // → currency (null = EUR)
    total_price: "b.TODO_totalPrice",                  // → totalPrice
    parking_price: "b.TODO_parkingPrice",              // → parkingPrice
    delivery_charges: "b.TODO_deliveryCharges",        // → deliveryCharges
    extras_total: "b.TODO_extraServicesTotal",         // → extrasTotal
    discount: "b.TODO_discount",                       // → discount
    remaining_to_pay: "b.TODO_remainingToPay",         // → remainingToPay
    total_paid: "b.TODO_totalPaid",                    // → totalPaid
    payment_method: "b.TODO_paymentMethod",            // → paymentMethod (+ alias de parceiro)
    delivery_service: "b.TODO_deliveryService",        // → deliveryService
    delivery_type: "b.TODO_deliveryType",              // → deliveryType
    delivery_address: "b.TODO_deliveryAddress",        // → deliveryAddress
    pickup_address: "b.TODO_pickupAddress",            // → pickupAddress
    arrival_flight: "b.TODO_arrivalFlight",            // → arrivalFlight
    departure_flight: "b.TODO_departureFlight",        // → departureFlight
    return_flight: "b.TODO_returnFlight",              // → returnFlight
    departing_flight: "b.TODO_departingFlight",        // → departingFlight
    remarks: "b.TODO_remarks",                         // → remarks
    notes: "b.TODO_notes",                             // → notes
    origin: "b.TODO_origin",                           // → origin
    origin_url: "b.TODO_originUrl",                    // → originUrl (+ atribuição Google/Meta Ads)
    partner_id: "b.TODO_partnerId",                    // → partnerId (casa com partner_aliases)
    partner_name: "TODO_partner.name",                 // → partnerName
    campaign_id: "b.TODO_campaignId",                  // → campaignId
    campaign_name: "TODO_campaign.name",               // → campaignName
    discount_code: "b.TODO_discountCode",              // → campaign (fallback)
    pro: "b.TODO_pro",                                 // → pro
    allocation: "b.TODO_allocation",                   // → spotType/parkBrand (classifyAllocation)
    cash_validated_by_name: "b.TODO_cashValidatedByName",     // → cashValidatedByName
    driver_validated_by_name: "b.TODO_driverValidatedByName", // → driverValidatedByName
    cashier_closed_by_name: "b.TODO_cashierClosedByName",     // → cashierClosedByName
    extra_services: null,                              // → multipark_booking_extras (JSON: json_agg/JSON_ARRAYAGG de {id,name,description,price,done})
  },
};

/** Coluna de data de cada ação do report (/bookings/report?actionType=…). */
export const BOOKING_PERIOD_COLUMNS: Record<BookingActionType, string> = {
  creation: "b.TODO_createdAt",
  checkin: "b.TODO_checkIn",       // TODO: data prevista ou a do movimento CHECK_IN? (igual à API)
  checkout: "b.TODO_checkOut",
  cancelation: "b.TODO_cancelledAt",
};

/** Movimentos (check-in, check-out, mudanças de lugar, …) com quem e quando. */
export const MOVEMENT_QUERY: EntityQuery<MovementAlias> = {
  from: "TODO_booking_history h", // ex.: "BookingHistory" h LEFT JOIN "User" u ON u."id" = h."userId"
  cursorAt: "h.TODO_createdAt",
  cursorId: "h.TODO_id",
  columns: {
    id: "h.TODO_id",                       // → multipark_booking_history.historyId (MESMO id da API!)
    booking_id: "h.TODO_bookingId",        // → bookingExternalId
    change_type: "h.TODO_changeType",      // → changeType (CHECK_IN, CHECK_OUT, MOVEMENT, …)
    action_time: "h.TODO_actionTime",      // → actionTime
    agent_user_id: "h.TODO_userId",        // → agentUserId (liga à ficha via employee_agents)
    agent_name: null,                      // → agentName (null = nome + apelido)
    agent_first_name: "TODO_user.firstName",
    agent_last_name: "TODO_user.lastName",
    agent_email: "TODO_user.email",        // → agentEmail (anexa agente ↔ ficha por email)
    remarks: "h.TODO_remarks",             // → remarks
    modified_fields: "h.TODO_modifiedFields", // → modifiedFields (garagem, lugar, km)
    platform: "h.TODO_platform",           // → platform
  },
};

/** Condutores / utilizadores da app Multipark (agentes). */
export const DRIVER_QUERY: EntityQuery<DriverAlias> = {
  from: "TODO_users u", // ex.: "User" u WHERE role IN (…) — o filtro vai em DRIVER_FILTER
  cursorAt: "u.TODO_updatedAt",
  cursorId: "u.TODO_id",
  columns: {
    id: "u.TODO_id",               // → multipark_agents.agentUserId (= agentUserId do histórico)
    first_name: "u.TODO_firstName",
    last_name: "u.TODO_lastName",
    full_name: null,               // null = nome + apelido
    email: "u.TODO_email",         // → email (liga à ficha do colaborador)
    role: "u.TODO_role",           // → role
    active: "u.TODO_active",       // → active
    park_id: null,                 // → parkId (se existir)
    city: null,                    // → city (se existir)
    updated_at: "u.TODO_updatedAt",// → sourceUpdatedAt
  },
};
/** Filtro opcional (SQL) para ficar só com condutores/agentes. TODO. */
export const DRIVER_FILTER: string | null = null;

// ─── Construção do SQL (PURA) ───────────────────────────────────────────────

export interface BuiltQuery { sql: string; params: SqlParam[] }

function selectList<A extends string>(q: EntityQuery<A>): string {
  return (Object.entries(q.columns) as Array<[string, string | null]>)
    .map(([alias, expr]) => `${expr ?? "NULL"} AS ${alias}`)
    .join(",\n  ");
}

/** Texto do cursor com precisão total (µs), sempre em UTC (sessão em UTC). */
export function cursorText(engine: MultiparkDbEngine, expr: string): string {
  return engine === "postgres"
    ? `to_char(${expr}, 'YYYY-MM-DD HH24:MI:SS.US')`
    : `DATE_FORMAT(${expr}, '%Y-%m-%d %H:%i:%s.%f')`;
}

export interface SourceCursor { at: string; id: string }

/** Linhas alteradas depois do cursor (at, id), por ordem, até `limit`. PURA. */
export function changedSinceSql<A extends string>(engine: MultiparkDbEngine, q: EntityQuery<A>, since: SourceCursor, limit: number, extraWhere?: string | null): BuiltQuery {
  const p = (n: number) => placeholder(engine, n);
  const lim = Math.max(1, Math.min(1000, Math.trunc(limit)));
  // Cursor inicial (sem id): só a data, inclusive — um id vazio não é um
  // inteiro/uuid válido se a chave deles for desse tipo.
  if (!since.id) {
    return {
      sql: `SELECT\n  ${selectList(q)},\n  ${cursorText(engine, q.cursorAt)} AS cursor_at\nFROM ${q.from}\nWHERE ${q.cursorAt} >= ${p(1)}${extraWhere ? ` AND (${extraWhere})` : ""}\nORDER BY ${q.cursorAt}, ${q.cursorId}\nLIMIT ${lim}`,
      params: [since.at],
    };
  }
  const cond = engine === "postgres"
    ? `(${q.cursorAt} > ${p(1)} OR (${q.cursorAt} = ${p(1)} AND ${q.cursorId} > ${p(2)}))`
    : `(${q.cursorAt} > ${p(1)} OR (${q.cursorAt} = ${p(2)} AND ${q.cursorId} > ${p(3)}))`;
  const params: SqlParam[] = engine === "postgres" ? [since.at, since.id] : [since.at, since.at, since.id];
  return {
    sql: `SELECT\n  ${selectList(q)},\n  ${cursorText(engine, q.cursorAt)} AS cursor_at\nFROM ${q.from}\nWHERE ${cond}${extraWhere ? ` AND (${extraWhere})` : ""}\nORDER BY ${q.cursorAt}, ${q.cursorId}\nLIMIT ${lim}`,
    params,
  };
}

/** Uma linha pelo id. PURA. */
export function byIdSql<A extends string>(engine: MultiparkDbEngine, q: EntityQuery<A>, idExpr: string, id: string): BuiltQuery {
  return { sql: `SELECT\n  ${selectList(q)},\n  ${cursorText(engine, q.cursorAt)} AS cursor_at\nFROM ${q.from}\nWHERE ${idExpr} = ${placeholder(engine, 1)}\nLIMIT 2`, params: [id] };
}

/** Todas as linhas com `col` = valor, por ordem do cursor (ex.: movimentos de uma reserva). PURA. */
export function byColumnSql<A extends string>(engine: MultiparkDbEngine, q: EntityQuery<A>, colExpr: string, value: string, limit = 500): BuiltQuery {
  return { sql: `SELECT\n  ${selectList(q)},\n  ${cursorText(engine, q.cursorAt)} AS cursor_at\nFROM ${q.from}\nWHERE ${colExpr} = ${placeholder(engine, 1)}\nORDER BY ${q.cursorAt}, ${q.cursorId}\nLIMIT ${Math.max(1, Math.min(5000, limit))}`, params: [value] };
}

/** Reservas cuja data da ação cai em [from, to] (dias "AAAA-MM-DD", inclusive). PURA. */
export function bookingsByPeriodSql(engine: MultiparkDbEngine, from: string, to: string, action: BookingActionType): BuiltQuery {
  const col = BOOKING_PERIOD_COLUMNS[action];
  const p = (n: number) => placeholder(engine, n);
  return {
    sql: `SELECT\n  ${selectList(BOOKING_QUERY)},\n  ${cursorText(engine, BOOKING_QUERY.cursorAt)} AS cursor_at\nFROM ${BOOKING_QUERY.from}\nWHERE ${col} >= ${p(1)} AND ${col} < ${p(2)}\nORDER BY ${col}, ${BOOKING_QUERY.cursorId}`,
    params: [`${from} 00:00:00`, `${nextDay(to)} 00:00:00`],
  };
}

/** Todos os condutores (tabela pequena). PURA. */
export function driversSql(): BuiltQuery {
  return { sql: `SELECT\n  ${selectList(DRIVER_QUERY)}\nFROM ${DRIVER_QUERY.from}${DRIVER_FILTER ? `\nWHERE ${DRIVER_FILTER}` : ""}\nORDER BY ${DRIVER_QUERY.cursorId}\nLIMIT 5000`, params: [] };
}

function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ─── Mapeamento linha → formato nosso (PURAS, testadas com linhas-exemplo) ──

const text = (v: unknown, max = 512): string | undefined => {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, max) : undefined;
};
const num = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : undefined;
};
const bool = (v: unknown): boolean | undefined => {
  if (v == null) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (Buffer.isBuffer(v)) return v.length > 0 && v[0] !== 0;
  const s = String(v).trim().toLowerCase();
  if (["t", "true", "1", "yes", "y", "sim"].includes(s)) return true;
  if (["f", "false", "0", "no", "n", "nao", "não"].includes(s)) return false;
  return undefined;
};

const LISBON = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

/** Data da BD → instante (Date), ou null. Texto sem fuso = UTC (sessão em UTC). */
export function toInstant(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  const withZone = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(" ", "T")}Z` : /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Data da BD → texto que o parseBookingDate (bookingToRecord) entende, segundo
 * o DATE_MODE. "utc" → ISO com Z; "lisbon_wallclock" → "AAAA-MM-DD HH:MM:SS"
 * da hora de Lisboa (o parseBookingDate trata-a como UTC, como faz à API). PURA.
 */
export function toApiDate(v: unknown, mode: "utc" | "lisbon_wallclock" = DATE_MODE): string | undefined {
  const d = toInstant(v);
  if (!d) return undefined;
  if (mode === "utc") return d.toISOString();
  const p: Record<string, string> = {};
  for (const x of LISBON.formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
}

/** "HH:mm" da data (mesmo DATE_MODE). PURA. */
function hhmm(v: unknown, mode: "utc" | "lisbon_wallclock"): string | undefined {
  // ISO ("…T10:30:00.000Z") e "AAAA-MM-DD HH:MM:SS" têm a hora na mesma posição.
  return toApiDate(v, mode)?.slice(11, 16);
}

/** Data → "AAAA-MM-DD HH:MM:SS" UTC (formato das nossas colunas timestamp). PURA. */
export function toMysqlUtc(v: unknown): string | null {
  const d = toInstant(v);
  return d ? d.toISOString().slice(0, 19).replace("T", " ") : null;
}

function jsonArray(v: unknown): any[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : undefined; } catch { return undefined; }
  }
  return undefined;
}

function cursorOf(row: { cursor_at?: unknown; id?: unknown }): SourceCursor | null {
  const at = text(row.cursor_at, 40);
  const id = text(row.id, 128);
  return at && id ? { at, id } : null;
}

/**
 * Linha de reserva (aliases) → MultiparkBooking no formato da API
 * (/bookings/:id), para reutilizar bookingToRecord + applyBookingDetail. PURA.
 */
export function mapBookingRow(row: BookingRow, mode: "utc" | "lisbon_wallclock" = DATE_MODE): { booking: MultiparkBooking; cursor: SourceCursor | null } {
  const id = text(row.id, 128);
  if (!id) throw new Error("Linha de reserva sem id.");
  const clean = <T extends Record<string, unknown>>(o: T): T | undefined => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
    return Object.keys(out).length ? (out as T) : undefined;
  };
  const vehicleType = text(row.vehicle_type, 32);
  const booking: MultiparkBooking = {
    id,
    bookingNumber: text(row.booking_number, 64) ?? "",
    status: text(row.status, 64) ?? "",
    checkIn: toApiDate(row.check_in, mode) ?? "",
    checkOut: toApiDate(row.check_out, mode) ?? "",
    checkInTime: text(row.check_in_time, 8) ?? hhmm(row.check_in, mode) ?? "",
    checkOutTime: text(row.check_out_time, 8) ?? hhmm(row.check_out, mode),
    createdAt: toApiDate(row.created_at, mode),
    updatedAt: toApiDate(row.updated_at, mode) ?? "",
    cancelledAt: toApiDate(row.cancelled_at, mode),
    cancelReason: text(row.cancel_reason, 2000),
    parkId: text(row.park_id, 128),
    parkName: text(row.park_name, 128),
    park: row.park_id != null || row.park_name != null
      ? { id: text(row.park_id, 128) ?? "", name: text(row.park_name, 128) ?? "", city: text(row.park_city, 64) ?? "" }
      : undefined,
    parkingType: text(row.parking_type, 32),
    vehicleType,
    client: clean({
      firstName: text(row.client_first_name, 128), lastName: text(row.client_last_name, 128),
      email: text(row.client_email, 320), phoneNumber: text(row.client_phone, 64), nif: text(row.client_nif, 32),
    }) as MultiparkBooking["client"],
    vehicle: clean({
      licensePlate: text(row.license_plate, 32), brand: text(row.vehicle_brand, 64), model: text(row.vehicle_model, 64),
      color: text(row.vehicle_color, 32), type: vehicleType, vehicleType,
    }) as MultiparkBooking["vehicle"],
    pricing: clean({
      currency: text(row.currency, 8) ?? "EUR",
      totalPrice: num(row.total_price), parkingPrice: num(row.parking_price), deliveryCharges: num(row.delivery_charges),
      extraServicesTotal: num(row.extras_total), discount: num(row.discount), remainingToPay: num(row.remaining_to_pay),
      totalPaid: num(row.total_paid), paymentMethod: text(row.payment_method, 128),
    }) as MultiparkBooking["pricing"],
    deliveryService: bool(row.delivery_service),
    deliveryType: text(row.delivery_type, 64),
    deliveryAddress: text(row.delivery_address, 256),
    pickupAddress: text(row.pickup_address, 256),
    flightInfo: clean({ arrivalFlight: text(row.arrival_flight, 32), departureFlight: text(row.departure_flight, 32) }),
    returnFlight: text(row.return_flight, 32),
    departingFlight: text(row.departing_flight, 32),
    remarks: text(row.remarks, 512),
    notes: text(row.notes, 5000),
    origin: text(row.origin, 64),
    originUrl: text(row.origin_url, 512),
    partnerId: text(row.partner_id, 128),
    partnerName: text(row.partner_name, 256),
    campaignId: text(row.campaign_id, 128),
    campaignName: text(row.campaign_name, 256),
    discountCode: text(row.discount_code, 128),
    pro: bool(row.pro) ?? false,
    allocation: text(row.allocation, 32),
    cashValidatedByName: text(row.cash_validated_by_name, 256),
    driverValidatedByName: text(row.driver_validated_by_name, 256),
    cashierClosedByName: text(row.cashier_closed_by_name, 256),
    extraServices: jsonArray(row.extra_services),
  };
  for (const k of Object.keys(booking)) if ((booking as any)[k] === undefined) delete (booking as any)[k];
  return { booking, cursor: cursorOf(row) };
}

export interface SourceMovement {
  id: string;
  bookingId: string;
  changeType: string | null;
  /** "AAAA-MM-DD HH:MM:SS" UTC. */
  actionTime: string | null;
  agentUserId: string | null;
  agentName: string | null;
  agentEmail: string | null;
  remarks: string | null;
  /** JSON em texto (como a API). */
  modifiedFields: string | null;
  platform: string | null;
}

/** Tipos de movimento deles → os da API (CHECK_IN, CHECK_OUT, MOVEMENT, …). TODO se diferirem. */
export const CHANGE_TYPE_MAP: Record<string, string> = {};

/** Linha de movimento (aliases) → SourceMovement. PURA. */
export function mapMovementRow(row: MovementRow): { movement: SourceMovement; cursor: SourceCursor | null } {
  const id = text(row.id, 128);
  const bookingId = text(row.booking_id, 128);
  if (!id || !bookingId) throw new Error("Movimento sem id ou sem reserva.");
  const rawType = text(row.change_type, 32);
  const name = text(row.agent_name, 256) ?? ([text(row.agent_first_name, 128), text(row.agent_last_name, 128)].filter(Boolean).join(" ") || undefined);
  const mf = row.modified_fields;
  return {
    movement: {
      id,
      bookingId,
      changeType: rawType ? (CHANGE_TYPE_MAP[rawType] ?? rawType).slice(0, 32) : null,
      actionTime: toMysqlUtc(row.action_time),
      agentUserId: text(row.agent_user_id, 128) ?? null,
      agentName: name ?? null,
      agentEmail: text(row.agent_email, 320)?.toLowerCase() ?? null,
      remarks: text(row.remarks, 5000) ?? null,
      modifiedFields: mf == null || mf === "" ? null : typeof mf === "string" ? mf : JSON.stringify(mf),
      platform: text(row.platform, 32) ?? null,
    },
    cursor: cursorOf(row),
  };
}

export interface SourceDriver {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
  active: boolean;
  parkId: string | null;
  city: string | null;
  /** "AAAA-MM-DD HH:MM:SS" UTC. */
  updatedAt: string | null;
}

/** Linha de condutor (aliases) → SourceDriver (sem telefone: mínimo de dados pessoais). PURA. */
export function mapDriverRow(row: DriverRow): SourceDriver {
  const id = text(row.id, 128);
  if (!id) throw new Error("Condutor sem id.");
  const name = text(row.full_name, 256) ?? ([text(row.first_name, 128), text(row.last_name, 128)].filter(Boolean).join(" ") || null);
  return {
    id,
    name,
    email: text(row.email, 320)?.toLowerCase() ?? null,
    role: text(row.role, 64) ?? null,
    active: bool(row.active) ?? true,
    parkId: text(row.park_id, 128) ?? null,
    city: text(row.city, 64) ?? null,
    updatedAt: toMysqlUtc(row.updated_at),
  };
}
