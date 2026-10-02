/**
 * Serviços extra das reservas para a página Serviços — AO VIVO da BD da
 * Multipark (reservas ao vivo, parte B, 29 set 2026). Antes vinham da cópia
 * `multipark_booking_extras`, preenchida pela releitura da API.
 *
 * Reservas não canceladas com saída no período, nos parques dados; uma linha
 * por "BookingExtraService". O "feito" marcado cá fica em `service_extra_done`
 * (a BD da Multipark é só de leitura) e junta-se do nosso lado.
 * Regras de read.ts: SQL parametrizado, construtor PURO, LIMIT sempre.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList } from "./read";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export const SERVICE_EXTRAS_LIMIT = 5000;

export interface ServiceExtraLine {
  lineId: string; bookingId: string; bookingNumber: string | null; status: string | null; checkOut: string | null;
  parkId: string; plate: string | null; clientName: string | null; serviceName: string | null; price: number; done: boolean;
}

/** PURA. `start`/`end`: instantes UTC [start, end). */
export function buildServiceExtrasSql(o: { start: string; end: string; parkIds: readonly string[] }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const parks = o.parkIds.map((id) => p.add(id)).join(", ");
  const s = p.add(o.start), e = p.add(o.end);
  const sql = [
    `SELECT e."id" AS line_id, e."name" AS service_name, e."price" AS price, e."done" AS done,`,
    `       b."id" AS booking_id, NULLIF(b."allocation", '') AS code, b."status"::text AS status,`,
    `       to_char(b."checkOut", 'YYYY-MM-DD HH24:MI:SS') AS check_out, b."parkId" AS park_id,`,
    `       NULLIF(v."licensePlate", '') AS plate, NULLIF(trim(concat_ws(' ', c."firstName", c."lastName")), '') AS client_name`,
    `  FROM "Booking" b`,
    `  JOIN "BookingExtraService" e ON e."bookingId" = b."id"`,
    `  LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
    `  LEFT JOIN "Client" c ON c."id" = COALESCE(b."customerId", b."clientId")`,
    ` WHERE b."parkId" IN (${parks})`,
    `   AND b."checkOutDate" >= ${s}::timestamp - interval '1 day' AND b."checkOutDate" < ${e}::timestamp + interval '1 day'`,
    `   AND b."checkOut" >= ${s}::timestamp AND b."checkOut" < ${e}::timestamp`,
    `   AND b."status"::text NOT IN ('CANCELLED', 'PENDING')`,
    ` ORDER BY b."checkOut" ASC, e."id" ASC`,
    ` LIMIT ${p.add(SERVICE_EXTRAS_LIMIT)}`,
  ].join("\n");
  return { sql, params: p.values };
}

const str = (v: unknown) => (v == null || v === "" ? null : String(v));
const bool = (v: unknown) => v === true || v === 1 || v === "1" || v === "t" || v === "true";

export function mapServiceExtraRow(r: Record<string, unknown>): ServiceExtraLine {
  const price = Number(r.price ?? 0);
  return {
    lineId: String(r.line_id ?? ""), bookingId: String(r.booking_id ?? ""), bookingNumber: str(r.code), status: str(r.status),
    checkOut: str(r.check_out), parkId: String(r.park_id ?? ""), plate: str(r.plate), clientName: str(r.client_name),
    serviceName: str(r.service_name), price: Number.isFinite(price) ? price : 0, done: bool(r.done),
  };
}

export async function readServiceExtras(o: { start: string; end: string; parkIds: readonly string[] }, query: Query = multiparkDbQuery): Promise<ServiceExtraLine[]> {
  if (!o.parkIds.length) return [];
  const { sql, params } = buildServiceExtrasSql(o);
  return (await query<Record<string, unknown>>(sql, params)).map(mapServiceExtraRow);
}

/** De que reserva é esta linha de serviço (para o "Feito" não marcar a linha de outra reserva). PURA. */
export function buildServiceLineBookingSql(lineId: string): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const sql = `SELECT e."bookingId" AS booking_id FROM "BookingExtraService" e WHERE e."id" = ${p.add(lineId)} LIMIT 1`;
  return { sql, params: p.values };
}

/** Id da reserva da linha, ou null se a linha não existir. Lança se a BD da Multipark falhar. */
export async function serviceLineBookingId(lineId: string, query: Query = multiparkDbQuery): Promise<string | null> {
  return (await serviceLine(lineId, query))?.bookingId ?? null;
}

/** A linha na Multipark: de que reserva é e se já está feita lá. PURA. */
export function buildServiceLineSql(lineId: string): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const sql = `SELECT e."bookingId" AS booking_id, e."done" AS done FROM "BookingExtraService" e WHERE e."id" = ${p.add(lineId)} LIMIT 1`;
  return { sql, params: p.values };
}

/** A linha (reserva + feito na Multipark), ou null se não existir. Lança se a BD da Multipark falhar. */
export async function serviceLine(lineId: string, query: Query = multiparkDbQuery): Promise<{ bookingId: string; done: boolean } | null> {
  const { sql, params } = buildServiceLineSql(lineId);
  const [r] = await query<Record<string, unknown>>(sql, params);
  return r?.booking_id == null ? null : { bookingId: String(r.booking_id), done: bool(r.done) };
}
