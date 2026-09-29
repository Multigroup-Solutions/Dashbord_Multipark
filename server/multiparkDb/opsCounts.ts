/**
 * Contagens de reservas AO VIVO (só leitura) para os resumos de Operações e o
 * Painel: quantas reservas e quanto valem, por dia de Lisboa × parque, para
 * cada acontecimento (criada, entrada, saída, cancelada). Substitui as contas
 * sobre a cópia `multipark_bookings` (29 set 2026, reservas ao vivo parte B).
 *
 * Valor = soma das linhas "BookingPricing" (senão o "bookingPrice"), como a
 * cópia. As compras online por acabar (PENDING) nunca contam.
 * Regras de read.ts: SQL parametrizado, construtor PURO, LIMIT sempre.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList } from "./read";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

/**
 * created: criadas não canceladas · createdAll: todas as criadas ·
 * checkin / checkout: com entrada / saída no período, não canceladas ·
 * cancelled: canceladas no período (data do cancelamento mais recente).
 */
export type OpsEvent = "created" | "createdAll" | "checkin" | "checkout" | "cancelled";
export const OPS_EVENTS: readonly OpsEvent[] = ["created", "createdAll", "checkin", "checkout", "cancelled"];
export const OPS_COUNTS_LIMIT = 50_000;

export interface OpsCountRow { event: OpsEvent; day: string; parkId: string; count: number; revenue: number }

const lisbonDay = (col: string) => `to_char((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Lisbon', 'YYYY-MM-DD')`;

/** Um acontecimento: SELECT de (event, id, day, park_id, price). PURA. */
function eventSelect(e: OpsEvent, p: ParamList, start: string, end: string, parks: string): string {
  const range = (col: string) => `${col} >= ${p.add(start)}::timestamp AND ${col} < ${p.add(end)}::timestamp`;
  const notPending = `b."status"::text <> 'PENDING'`;
  const notCancelled = `b."status"::text NOT IN ('CANCELLED', 'PENDING')`;
  const sel = (col: string) => `SELECT '${e}'::text AS event, b."id" AS id, ${lisbonDay(col)} AS day, b."parkId" AS park_id, b."bookingPrice" AS price FROM "Booking" b`;
  switch (e) {
    case "created": return `${sel(`b."createdAt"`)} WHERE ${parks} AND ${notCancelled} AND ${range(`b."createdAt"`)}`;
    case "createdAll": return `${sel(`b."createdAt"`)} WHERE ${parks} AND ${notPending} AND ${range(`b."createdAt"`)}`;
    case "checkin": return `${sel(`b."checkIn"`)} WHERE ${parks} AND ${notCancelled} AND ${range(`b."checkIn"`)}`;
    case "checkout": return `${sel(`b."checkOut"`)} WHERE ${parks} AND ${notCancelled} AND ${range(`b."checkOut"`)}`;
    case "cancelled":
      return `SELECT 'cancelled'::text AS event, b."id" AS id, ${lisbonDay("cx.at")} AS day, b."parkId" AS park_id, b."bookingPrice" AS price FROM "Booking" b`
        + ` JOIN LATERAL (SELECT x."createdAt" AS at FROM "Cancellation" x WHERE x."bookingId" = b."id" ORDER BY x."createdAt" DESC LIMIT 1) cx ON TRUE`
        + ` WHERE ${parks} AND b."status"::text = 'CANCELLED' AND ${range("cx.at")}`;
  }
}

/** Contagens por acontecimento × dia × parque em [start, end) UTC. PURA. */
export function buildOpsCountsSql(o: { events: readonly OpsEvent[]; start: string; end: string; parkIds: readonly string[] }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  if (!o.events.length) throw new Error("Sem acontecimentos.");
  const p = new ParamList();
  const parks = `b."parkId" IN (${o.parkIds.map((id) => p.add(id)).join(", ")})`;
  const parts = [...new Set(o.events)].map((e) => eventSelect(e, p, o.start, o.end, parks));
  const sql = [
    `WITH d AS (${parts.join("\n  UNION ALL\n  ")}),`,
    `bp AS (SELECT y."bookingId" AS id, SUM(y."total") AS total FROM "BookingPricing" y WHERE y."bookingId" IN (SELECT DISTINCT d.id FROM d) GROUP BY y."bookingId")`,
    `SELECT d.event, d.day, d.park_id, count(*) AS n, SUM(COALESCE(bp.total, d.price, 0)) AS revenue`,
    `FROM d LEFT JOIN bp ON bp.id = d.id`,
    `GROUP BY 1, 2, 3`,
    `ORDER BY 1, 2, 3`,
    `LIMIT ${p.add(OPS_COUNTS_LIMIT)}`,
  ].join("\n");
  return { sql, params: p.values };
}

export function mapOpsCountRow(r: Record<string, unknown>): OpsCountRow {
  const rev = Number(r.revenue ?? 0);
  return {
    event: String(r.event) as OpsEvent, day: String(r.day ?? "").slice(0, 10), parkId: String(r.park_id ?? ""),
    count: Math.round(Number(r.n ?? 0)) || 0, revenue: Number.isFinite(rev) ? Math.round(rev * 100) / 100 : 0,
  };
}

/** Lança se a BD da Multipark falhar (quem chama mostra o erro). */
export async function readOpsCounts(o: { events: readonly OpsEvent[]; start: string; end: string; parkIds: readonly string[] }, query: Query = multiparkDbQuery): Promise<OpsCountRow[]> {
  if (!o.parkIds.length) return [];
  const { sql, params } = buildOpsCountsSql(o);
  return (await query<Record<string, unknown>>(sql, params)).map(mapOpsCountRow);
}

/** Total de reservas (sem compras por acabar) destes parques. PURA. */
export function buildBookingTotalSql(parkIds: readonly string[]): { sql: string; params: SqlParam[] } {
  if (!parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const sql = `SELECT count(*) AS n FROM "Booking" b WHERE b."parkId" IN (${parkIds.map((id) => p.add(id)).join(", ")}) AND b."status"::text <> 'PENDING' LIMIT ${p.add(1)}`;
  return { sql, params: p.values };
}

export async function readBookingTotal(parkIds: readonly string[], query: Query = multiparkDbQuery): Promise<number> {
  if (!parkIds.length) return 0;
  const { sql, params } = buildBookingTotalSql(parkIds);
  return Number((await query<{ n: unknown }>(sql, params))[0]?.n ?? 0) || 0;
}
