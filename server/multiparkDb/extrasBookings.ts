/**
 * Reservas do Extras-Dia lidas AO VIVO da BD da Multipark (BD 2): a previsão
 * (`getExtrasDiaForecast`) e o detalhe de um bloco de 20 min
 * (`getBookingsInSlot`) deixam de depender da nossa cópia `multipark_bookings`
 * (que só se enchia com o sync das futuras, `multipark-future`, que já não
 * corre sozinho). Segue as regras de read.ts / dayBookings.ts: SQL
 * parametrizado, construtores e mapeadores PUROS, LIMIT sempre e nunca lança
 * (`{ available:false, reason }` → o Extras-Dia volta à cópia e mostra aviso).
 *
 * Que reservas: as dos parques NOSSOS da cidade (shared/multiparkParks.ts —
 * marca Airpark/Redpark/Skypark + Lisboa/Porto/Faro), com entrada ou saída
 * dentro da janela, estado ≠ CANCELLED. (Não existe em main uma definição
 * "Parques que a operação não faz"; se vier a existir, filtra-se aqui.)
 *
 * Horas: "checkIn"/"checkOut" (hora do movimento, UTC na BD) → hora de parede
 * de Lisboa no Extras-Dia (como a cópia fazia com utcToLocal). O pré-filtro
 * em "checkInDate"/"checkOutDate" (±1 dia) usa os índices (parkId, …Date).
 *
 * Colunas usadas (docs/multipark-db/schema.md):
 *   Park: id, name, city, firebaseBrand, listingType, status
 *   Booking: id, allocation, status, checkIn, checkOut, checkInDate,
 *     checkOutDate, parkId, deliveryType, customerId, clientId, vehicleId
 *   Client: firstName, lastName · BookingVehicle: licensePlate
 *   BookingExtraService: bookingId, name, price (lavagens + valor dos extras)
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, safeMultiparkRead, toIsoUtc, type MultiparkRead } from "./read";
import { buildParksSql, mapParks, type DayPark } from "./dayBookings";
import { classifyAllocation, type SpotType } from "../spotClassification";

export const EXTRAS_LIVE_LIMIT = 5000;

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

/** Cidade do Extras-Dia → chave de cidade da classificação dos parques. */
export const EXTRA_CITY_KEY: Record<"lisbon" | "porto" | "faro", "lisboa" | "porto" | "faro"> = {
  lisbon: "lisboa",
  porto: "porto",
  faro: "faro",
};

const sqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** Parques NOSSOS de uma cidade (classificação única). PURA. */
export function cityParks(parks: DayPark[], city: "lisbon" | "porto" | "faro"): DayPark[] {
  const key = EXTRA_CITY_KEY[city];
  return parks.filter((p) => p.ours && p.city === key);
}

/**
 * SQL das reservas com entrada OU saída em [startMs, endMs) (UTC), só nos
 * parques dados, sem canceladas. Extras (nomes + soma) agregados por reserva
 * numa CTE só das reservas escolhidas. PURA.
 */
export function buildExtrasBookingsSql(startMs: number, endMs: number, parkIds: string[], limit = EXTRAS_LIVE_LIMIT): { sql: string; params: SqlParam[] } {
  if (!parkIds.length) throw new Error("Sem parques.");
  if (!(endMs > startMs)) throw new Error("Janela inválida.");
  const p = new ParamList();
  const parks = parkIds.map((id) => p.add(id)).join(", ");
  const s = p.add(sqlTs(startMs));
  const e = p.add(sqlTs(endMs));
  const ws = p.add(sqlTs(startMs - 86_400_000));
  const we = p.add(sqlTs(endMs + 86_400_000));
  const lim = p.add(Math.min(Math.max(Math.floor(limit), 1), EXTRAS_LIVE_LIMIT + 1));
  const sql = [
    `WITH d AS (`,
    `  SELECT b."id" FROM "Booking" b`,
    `  WHERE b."parkId" IN (${parks})`,
    `  AND b."status"::text <> 'CANCELLED'`,
    `  AND (`,
    `    (b."checkInDate" >= ${ws}::timestamp AND b."checkInDate" < ${we}::timestamp AND b."checkIn" >= ${s}::timestamp AND b."checkIn" < ${e}::timestamp)`,
    `    OR (b."checkOutDate" >= ${ws}::timestamp AND b."checkOutDate" < ${we}::timestamp AND b."checkOut" >= ${s}::timestamp AND b."checkOut" < ${e}::timestamp)`,
    `  )`,
    `  LIMIT ${lim}`,
    `),`,
    `ex AS (SELECT x."bookingId" AS booking_id, string_agg(x."name", ' | ') AS names, SUM(x."price") AS total FROM "BookingExtraService" x WHERE x."bookingId" IN (SELECT d."id" FROM d) GROUP BY x."bookingId")`,
    `SELECT`,
    `  b."id" AS id,`,
    `  NULLIF(b."allocation", '') AS code,`,
    `  to_char(b."checkIn", 'YYYY-MM-DD HH24:MI:SS') AS check_in,`,
    `  to_char(b."checkOut", 'YYYY-MM-DD HH24:MI:SS') AS check_out,`,
    `  b."parkId" AS park_id,`,
    `  NULLIF(b."deliveryType", '') AS delivery_type,`,
    `  c."firstName" AS client_first_name,`,
    `  c."lastName" AS client_last_name,`,
    `  v."licensePlate" AS plate,`,
    `  ex.names AS extra_names,`,
    `  ex.total AS extras_total`,
    `FROM d`,
    `JOIN "Booking" b ON b."id" = d."id"`,
    `LEFT JOIN "Client" c ON c."id" = COALESCE(b."customerId", b."clientId")`,
    `LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
    `LEFT JOIN ex ON ex.booking_id = b."id"`,
  ].join("\n");
  return { sql, params: p.values };
}

/** Reserva ao vivo, com as horas ainda em UTC (ISO). */
export interface LiveExtrasBooking {
  externalId: string;
  bookingNumber: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  licensePlate: string | null;
  checkInUtc: string | null;
  checkOutUtc: string | null;
  parkName: string | null;
  city: string | null;
  deliveryType: string | null;
  spotType: SpotType;
  extrasTotal: number;
  extraNames: string[];
}

/** Linha → reserva. PURA. */
export function mapExtrasBookingRow(r: Record<string, unknown>, park: Pick<DayPark, "name" | "cityName"> | undefined): LiveExtrasBooking {
  const code = str(r.code);
  const total = Number(r.extras_total ?? 0);
  return {
    externalId: String(r.id ?? ""),
    bookingNumber: code,
    clientFirstName: str(r.client_first_name),
    clientLastName: str(r.client_last_name),
    licensePlate: str(r.plate),
    checkInUtc: toIsoUtc(r.check_in),
    checkOutUtc: toIsoUtc(r.check_out),
    parkName: park?.name ?? null,
    city: park?.cityName ?? null,
    deliveryType: str(r.delivery_type),
    spotType: classifyAllocation(code).spotType,
    extrasTotal: Number.isFinite(total) ? Math.round(total * 100) / 100 : 0,
    extraNames: String(r.extra_names ?? "").split(" | ").map((s) => s.trim()).filter(Boolean),
  };
}

// ─── Parques em cache (tabela pequena, muda raramente) ──────────────────────

const PARKS_TTL_MS = 10 * 60_000;
let parksCache: { at: number; parks: DayPark[] } | null = null;

async function loadParks(query: Query, now: number): Promise<DayPark[]> {
  if (query === multiparkDbQuery && parksCache && now - parksCache.at < PARKS_TTL_MS) return parksCache.parks;
  const ps = buildParksSql();
  const parks = mapParks(await query(ps.sql, ps.params));
  if (query === multiparkDbQuery) parksCache = { at: now, parks };
  return parks;
}

// ─── Disjuntor: BD em baixo → cópia durante 1 min (sem esperar 5 s por pedido) ──

export const LIVE_BREAKER_MS = 60_000;
let breakerUntil = 0;
let breakerReason = "";

/** Só para testes. */
export function resetExtrasLiveState(): void {
  breakerUntil = 0;
  breakerReason = "";
  parksCache = null;
}

export interface LiveExtrasResult {
  bookings: LiveExtrasBooking[];
  parks: string[];
  truncated: boolean;
}

/**
 * Reservas dos parques nossos da cidade com entrada ou saída em
 * [startMs, endMs). Nunca lança. Depois de uma falha, durante LIVE_BREAKER_MS
 * responde logo "indisponível" (o Extras-Dia usa a cópia).
 */
export async function getLiveExtrasBookings(
  city: "lisbon" | "porto" | "faro",
  startMs: number,
  endMs: number,
  query: Query = multiparkDbQuery,
  now = Date.now(),
): Promise<MultiparkRead<LiveExtrasResult>> {
  if (query === multiparkDbQuery && now < breakerUntil) {
    return { available: false, code: "CONNECT_FAILED", reason: breakerReason || "BD da Multipark indisponível há pouco." };
  }
  const r = await safeMultiparkRead("reservas do Extras-Dia", async () => {
    const parks = cityParks(await loadParks(query, now), city);
    if (!parks.length) return { bookings: [], parks: [], truncated: false };
    const { sql, params } = buildExtrasBookingsSql(startMs, endMs, parks.map((p) => p.id), EXTRAS_LIVE_LIMIT + 1);
    const rows = await query(sql, params);
    const byId = new Map(parks.map((p) => [p.id, p]));
    return {
      bookings: rows.slice(0, EXTRAS_LIVE_LIMIT).map((row) => mapExtrasBookingRow(row, byId.get(String(row.park_id ?? "")))),
      parks: parks.map((p) => [p.name, p.cityName].filter(Boolean).join(" / ")).sort(),
      truncated: rows.length > EXTRAS_LIVE_LIMIT,
    };
  });
  if (!r.available && r.code !== "NOT_CONFIGURED" && query === multiparkDbQuery) {
    breakerUntil = now + LIVE_BREAKER_MS;
    breakerReason = r.reason;
  }
  return r;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
