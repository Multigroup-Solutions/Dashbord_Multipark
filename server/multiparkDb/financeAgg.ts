/**
 * Financeiro e Caixa — leitura AO VIVO da BD da Multipark (só leitura).
 *
 * Substitui as somas que o motor financeiro fazia sobre a cópia
 * `multipark_bookings` (Jorge, 28 set 2026: "o financeiro, a caixa e o
 * marketing passam a ler da Multipark"). Devolve AGREGADOS por dia de Lisboa ×
 * parque × parceiro × método × campanha — nunca reservas soltas nem dados
 * pessoais. O mapeamento parque → centro de custos e a campanha (parceiro)
 * fazem-se do nosso lado (server/finance/liveBookings.ts).
 *
 * Mesmos valores que a cópia tinha (server/multiparkDb/queries.ts):
 *   total     = soma das linhas "BookingPricing" (senão o "bookingPrice");
 *   pago      = soma do "amountPaid" das linhas;
 *   por pagar = total − pago (nunca negativo);
 *   extras    = soma do "price" dos "BookingExtraService".
 * Datas na BD em UTC ("timestamp without time zone"); o dia é o de Lisboa.
 *
 * Regras de read.ts: SQL parametrizado, construtor PURO, LIMIT sempre.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList } from "./read";
import { MARKETPLACE_ORIGIN_SQL } from "./marketplaceSql";

export type FinanceAggKind = "delivered" | "collected" | "forecast" | "noshow" | "cancelled" | "checkout_any" | "checkin_any";

/** Estados como o motor financeiro (server/finance/engine.ts). */
export const DELIVERED = ["CHECKED_OUT"] as const;
export const COLLECTED = ["CHECKED_IN", "CHECKING_OUT", "PENDING_CHECKOUT", "CHECKED_OUT"] as const;
export const PARKED = ["CHECKED_IN", "CHECKING_OUT", "PENDING_CHECKOUT"] as const;
/** Não contam para a receita esperada: canceladas, entregues e compras online por acabar. */
export const NOT_FORECAST = ["CANCELLED", "CHECKED_OUT", "PENDING"] as const;

export const FINANCE_AGG_LIMIT = 50_000;

export interface FinanceAggSpec {
  kind: FinanceAggKind;
  /** Instantes UTC "YYYY-MM-DD HH:MM:SS" — [start, end) (lisbonDayRangeUtc). */
  start: string;
  end: string;
  /** Só estes parques (os nossos). Vazio → erro (nunca "todos"). */
  parkIds: string[];
  /** forecast: início de hoje (UTC) — reservas que ainda entram. */
  todayStart?: string;
}

export interface FinanceAggRow {
  day: string;
  parkId: string;
  partnerId: string | null;
  partnerName: string | null;
  paymentMethod: string | null;
  campaignName: string | null;
  discountCode: string | null;
  count: number;
  total: number;
  parking: number;
  delivery: number;
  extras: number;
  paid: number;
  remaining: number;
  /** reservas com valor por pagar */
  owingCount: number;
  status: string | null;
  pro: boolean;
  discount: number;
  /** 28b: `Booking.origin = 'MARKETPLACE'` (veio pela campanha do Marketplace). */
  marketplace: boolean;
}

const lisbonDay = (col: string) => `to_char((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Lisbon', 'YYYY-MM-DD')`;
/** Folga da coluna "…Date" (índice por parque): o dia de calendário pode estar 1 dia ao lado da hora real. */
const WIDE_DAYS = 2;

function wide(p: ParamList, col: "checkInDate" | "checkOutDate", start: string, end: string): string {
  return `b."${col}" >= ${p.add(start)}::timestamp - interval '${WIDE_DAYS} days' AND b."${col}" < ${p.add(end)}::timestamp + interval '${WIDE_DAYS} days'`;
}
const inList = (p: ParamList, vals: readonly string[]) => vals.map((v) => p.add(v)).join(", ");

/** SQL dos agregados de um tipo de leitura. PURA. */
export function buildFinanceAggSql(spec: FinanceAggSpec): { sql: string; params: SqlParam[] } {
  if (!spec.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const parks = `b."parkId" IN (${inList(p, spec.parkIds)})`;
  let dayCol: string;
  const conds: string[] = [parks];
  let joinCancel = "";
  let paidOnly = false;
  const range = (col: string) => `${col} >= ${p.add(spec.start)}::timestamp AND ${col} < ${p.add(spec.end)}::timestamp`;
  switch (spec.kind) {
    case "delivered":
      dayCol = `b."checkOut"`;
      conds.push(`b."status"::text IN (${inList(p, DELIVERED)})`, wide(p, "checkOutDate", spec.start, spec.end), range(`b."checkOut"`));
      break;
    case "checkout_any":
      // Qualquer estado com saída no período (Diagnóstico da Faturação).
      dayCol = `b."checkOut"`;
      conds.push(wide(p, "checkOutDate", spec.start, spec.end), range(`b."checkOut"`));
      break;
    case "checkin_any":
      // Qualquer estado com entrada no período (relatório semanal de operações).
      dayCol = `b."checkIn"`;
      conds.push(wide(p, "checkInDate", spec.start, spec.end), range(`b."checkIn"`));
      break;
    case "collected":
      dayCol = `b."checkIn"`;
      conds.push(`b."status"::text IN (${inList(p, COLLECTED)})`, wide(p, "checkInDate", spec.start, spec.end), range(`b."checkIn"`));
      break;
    case "forecast": {
      if (!spec.todayStart) throw new Error("Falta o início de hoje.");
      dayCol = `b."checkOut"`;
      conds.push(
        `b."status"::text NOT IN (${inList(p, NOT_FORECAST)})`,
        wide(p, "checkOutDate", spec.start, spec.end), range(`b."checkOut"`),
        `(b."status"::text IN (${inList(p, PARKED)}) OR b."checkIn" >= ${p.add(spec.todayStart)}::timestamp)`,
      );
      break;
    }
    case "noshow":
      // BOOKED com entrada no período que já passou e nunca entrou; só as pagas.
      dayCol = `b."checkIn"`;
      conds.push(`b."status"::text = 'BOOKED'`, wide(p, "checkInDate", spec.start, spec.end), range(`b."checkIn"`));
      paidOnly = true;
      break;
    case "cancelled":
      // Canceladas no período (data do cancelamento mais recente); só as pagas.
      dayCol = `cx.at`;
      joinCancel = `JOIN LATERAL (SELECT x."createdAt" AS at FROM "Cancellation" x WHERE x."bookingId" = b."id" ORDER BY x."createdAt" DESC LIMIT 1) cx ON TRUE`;
      conds.push(`b."status"::text = 'CANCELLED'`, range(`cx.at`));
      paidOnly = true;
      break;
    default:
      throw new Error("Tipo de leitura desconhecido.");
  }
  const lim = p.add(FINANCE_AGG_LIMIT);
  const sql = [
    `WITH d AS (`,
    `  SELECT b."id" AS id, ${lisbonDay(dayCol)} AS day, b."parkId" AS park_id, b."partnerId" AS partner_id,`,
    `    NULLIF(b."paymentMethod", '') AS pm, b."campaignId" AS campaign_id, b."bookingPrice" AS price, b."parkingPrice" AS parking, b."deliveryPrice" AS delivery,`,
    `    b."status"::text AS status, COALESCE(b."pro", false) AS pro, COALESCE(b."discountApplied", b."discountAmount", 0) AS discount,`,
    // regra única nos parques NOSSOS (só estes se leem aqui): veio pelo Marketplace
    `    COALESCE(${MARKETPLACE_ORIGIN_SQL}, false) AS mkt`,
    `  FROM "Booking" b`,
    joinCancel ? `  ${joinCancel}` : "",
    `  WHERE ${conds.join("\n    AND ")}`,
    `),`,
    `bp AS (SELECT y."bookingId" AS id, SUM(y."total") AS total, SUM(y."amountPaid") AS paid, string_agg(DISTINCT NULLIF(y."paymentMethod", ''), ', ') AS pm`,
    `  FROM "BookingPricing" y WHERE y."bookingId" IN (SELECT d.id FROM d) GROUP BY y."bookingId"),`,
    `ex AS (SELECT e."bookingId" AS id, SUM(e."price") AS total FROM "BookingExtraService" e WHERE e."bookingId" IN (SELECT d.id FROM d) GROUP BY e."bookingId")`,
    `SELECT d.day, d.park_id, d.partner_id, NULLIF(pa."name", '') AS partner_name, COALESCE(d.pm, bp.pm) AS payment_method,`,
    `  NULLIF(ca."name", '') AS campaign_name, NULLIF(ca."discountCode", '') AS discount_code, d.status, d.pro, d.mkt,`,
    `  count(*) AS n, SUM(COALESCE(bp.total, d.price)) AS total, SUM(d.parking) AS parking, SUM(d.delivery) AS delivery,`,
    `  SUM(ex.total) AS extras, SUM(bp.paid) AS paid, SUM(GREATEST(COALESCE(bp.total, d.price) - COALESCE(bp.paid, 0), 0)) AS remaining,`,
    `  count(*) FILTER (WHERE COALESCE(bp.total, d.price) - COALESCE(bp.paid, 0) > 0.005) AS owing_n,`,
    `  SUM(d.discount) AS discount`,
    `FROM d`,
    `LEFT JOIN bp ON bp.id = d.id`,
    `LEFT JOIN ex ON ex.id = d.id`,
    `LEFT JOIN "Partner" pa ON pa."id" = d.partner_id`,
    `LEFT JOIN "Campaign" ca ON ca."id" = d.campaign_id`,
    paidOnly ? `WHERE COALESCE(bp.paid, 0) > 0` : "",
    `GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10`,
    `ORDER BY 1, 2`,
    `LIMIT ${lim}`,
  ].filter(Boolean).join("\n");
  return { sql, params: p.values };
}

const n = (v: unknown) => { const x = Number(v ?? 0); return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0; };
const s = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());

/** Linha → agregado. PURA. */
export function mapFinanceAggRow(r: Record<string, unknown>): FinanceAggRow {
  return {
    day: String(r.day ?? "").slice(0, 10),
    parkId: String(r.park_id ?? ""),
    partnerId: s(r.partner_id),
    partnerName: s(r.partner_name),
    paymentMethod: s(r.payment_method),
    campaignName: s(r.campaign_name),
    discountCode: s(r.discount_code),
    count: Math.round(Number(r.n ?? 0)) || 0,
    total: n(r.total),
    parking: n(r.parking),
    delivery: n(r.delivery),
    extras: n(r.extras),
    paid: n(r.paid),
    remaining: n(r.remaining),
    owingCount: Math.round(Number(r.owing_n ?? 0)) || 0,
    status: s(r.status),
    pro: r.pro === true || r.pro === "t" || r.pro === 1 || r.pro === "true",
    discount: n(r.discount),
    marketplace: r.mkt === true || r.mkt === "t" || r.mkt === 1 || r.mkt === "true",
  };
}

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

/** Agregados de um tipo de leitura. Lança (quem chama mostra o erro). */
export async function readFinanceAgg(spec: FinanceAggSpec, query: Query = multiparkDbQuery): Promise<FinanceAggRow[]> {
  const { sql, params } = buildFinanceAggSql(spec);
  return (await query<Record<string, unknown>>(sql, params)).map(mapFinanceAggRow);
}

/** Parques da Multipark (id, nome, cidade, marca) — para classificar e ligar ao centro. PURA. */
export function buildParksSql(): { sql: string; params: SqlParam[] } {
  return {
    sql: `SELECT p."id" AS id, p."name" AS name, p."city" AS city, NULLIF(p."address", '') AS address, NULLIF(p."firebaseBrand", '') AS firebase_brand, p."listingType"::text AS listing_type FROM "Park" p ORDER BY p."name" LIMIT 1000`,
    params: [],
  };
}

export interface MultiparkParkRow {
  id: string; name: string; city: string | null; firebaseBrand: string | null; listingType: string | null;
  /** 8 out 2026: morada (último recurso para a cidade — resolveParkCity). */
  address?: string | null;
}

export async function readParks(query: Query = multiparkDbQuery): Promise<MultiparkParkRow[]> {
  const { sql, params } = buildParksSql();
  return (await query<Record<string, unknown>>(sql, params)).map((r) => ({
    id: String(r.id ?? ""), name: String(r.name ?? ""), city: s(r.city), address: s(r.address), firebaseBrand: s(r.firebase_brand), listingType: s(r.listing_type),
  })).filter((p) => p.id);
}

// ─── Diagnóstico: maiores reservas entregues ────────────────────────────────

export const TOP_BOOKINGS_LIMIT = 20;

/** As maiores reservas entregues (CHECKED_OUT) com saída no período. PURA. */
export function buildTopDeliveredSql(spec: { start: string; end: string; parkIds: string[] }): { sql: string; params: SqlParam[] } {
  if (!spec.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const parks = inList(p, spec.parkIds);
  const sql = [
    `SELECT b."id" AS id, NULLIF(b."allocation"::text, '') AS code, b."parkId" AS park_id, b."status"::text AS status,`,
    `  COALESCE((SELECT SUM(y."total") FROM "BookingPricing" y WHERE y."bookingId" = b."id"), b."bookingPrice") AS total,`,
    `  to_char(b."checkOut", 'YYYY-MM-DD HH24:MI:SS') AS check_out`,
    `FROM "Booking" b`,
    `WHERE b."parkId" IN (${parks}) AND b."status"::text IN (${inList(p, DELIVERED)})`,
    `  AND ${wide(p, "checkOutDate", spec.start, spec.end)}`,
    `  AND b."checkOut" >= ${p.add(spec.start)}::timestamp AND b."checkOut" < ${p.add(spec.end)}::timestamp`,
    `ORDER BY 5 DESC NULLS LAST, b."id"`,
    `LIMIT ${p.add(TOP_BOOKINGS_LIMIT)}`,
  ].join("\n");
  return { sql, params: p.values };
}

export interface TopBookingRow { id: string; code: string | null; parkId: string; status: string | null; total: number; checkOut: string | null }

export async function readTopDelivered(spec: { start: string; end: string; parkIds: string[] }, query: Query = multiparkDbQuery): Promise<TopBookingRow[]> {
  const { sql, params } = buildTopDeliveredSql(spec);
  return (await query<Record<string, unknown>>(sql, params)).map((r) => ({
    id: String(r.id ?? ""), code: s(r.code), parkId: String(r.park_id ?? ""), status: s(r.status), total: n(r.total), checkOut: s(r.check_out),
  }));
}
