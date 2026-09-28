/**
 * Conferência de caixa — leitura AO VIVO da BD da Multipark (só leitura).
 *
 * Mesmas regras de read.ts: SQL parametrizado, construtores e mapeadores
 * PUROS, LIMIT sempre, nunca lança (`safeMultiparkRead`). Âmbito de cidade por
 * Park.city em todas as leituras.
 *
 * Uma consulta dá, por reserva: os campos de dinheiro da "Booking" (só as
 * chaves pedidas, via `jsonb_each(to_jsonb(b))`, para não trazer dados
 * pessoais e não rebentar se uma coluna faltar), a soma das linhas
 * ("BookingPricing": n.º, total, pago) e dos pagamentos
 * ("BookingPricingPayment": soma e métodos distintos). As filhas são lidas
 * só para as reservas escolhidas (`bookingId IN (SELECT … FROM d)`), pelos
 * índices existentes. A "History" NÃO é lida em lote (não tem índice por
 * bookingId): só na ficha, uma reserva de cada vez.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, cityAliases, toIsoUtc } from "./read";
import type { DayBounds } from "./dayBookings";
import type { LiveFinance } from "../cashCheck/rules";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;
type J = Record<string, any>;

export const CASH_CHECK_PAGE_MAX = 200;

/** Chaves da "Booking" que interessam à caixa (nada pessoal). */
export const BOOKING_MONEY_KEYS = [
  "id", "allocation", "parkId", "status", "checkIn", "checkOut", "checkInDate", "checkOutDate", "createdAt", "updatedAt", "currency",
  "bookingPrice", "originalBookingPrice", "parkingPrice", "deliveryPrice", "discountAmount", "discountApplied",
  "paymentMethod", "paymentSource", "paymentBy", "campaignId", "partnerId", "partnerAmountDue", "partnerAmountPaid",
  "partnerContributedAmount", "pro", "proClientId",
  "cashierClosed", "cashierClosedAt", "cashierClosedByName", "cashierClosedById",
  "cashValidated", "cashValidatedAt", "cashValidatedByName", "cashValidatedById",
  "driverValidated", "driverValidatedAt", "driverValidatedByName", "driverValidatedById",
] as const;

/** Condição "parque da reserva nas cidades" (undefined = todas). PURA. */
function parkCityScope(p: ParamList, cities: string[] | undefined): string {
  if (cities === undefined) return "TRUE";
  const aliases = cityAliases(cities);
  if (!aliases.length) return "FALSE";
  return `b."parkId" IN (SELECT sp."id" FROM "Park" sp WHERE lower(trim(sp."city")) IN (${aliases.map((c) => p.add(c)).join(", ")}))`;
}

export type LiveSelector =
  | { kind: "ids"; ids: string[] }
  | { kind: "checkout"; bounds: DayBounds; parkIds: string[]; after?: string | null; limit: number };

/**
 * SQL da leitura de dinheiro: por ids, ou pelas saídas de um dia de Lisboa
 * nestes parques (paginado por id: `after` = último id da página anterior). PURA.
 */
export function buildLiveFinanceSql(sel: LiveSelector, cities?: string[]): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  let where: string;
  let lim: string;
  if (sel.kind === "ids") {
    if (!sel.ids.length) throw new Error("Sem reservas.");
    const ids = sel.ids.slice(0, 1000);
    where = `b."id" IN (${ids.map((i) => p.add(i)).join(", ")})`;
    lim = p.add(ids.length);
  } else {
    if (!sel.parkIds.length) throw new Error("Sem parques.");
    const parks = sel.parkIds.map((i) => p.add(i)).join(", ");
    const s = p.add(sel.bounds.start);
    const e = p.add(sel.bounds.end);
    const ws = p.add(sel.bounds.wideStart);
    const we = p.add(sel.bounds.wideEnd);
    where = [
      `b."parkId" IN (${parks})`,
      `AND b."checkOutDate" >= ${ws}::timestamp AND b."checkOutDate" < ${we}::timestamp`,
      `AND b."checkOut" >= ${s}::timestamp AND b."checkOut" < ${e}::timestamp`,
      sel.after ? `AND b."id" > ${p.add(sel.after)}` : "",
    ].filter(Boolean).join("\n    ");
    lim = p.add(Math.min(Math.max(Math.floor(sel.limit), 1), CASH_CHECK_PAGE_MAX + 1));
  }
  const scope = parkCityScope(p, cities);
  const keys = BOOKING_MONEY_KEYS.map((k) => p.add(k)).join(", ");
  const sql = [
    `WITH d AS (`,
    `  SELECT b."id" FROM "Booking" b`,
    `  WHERE ${where}`,
    `    AND ${scope}`,
    `  ORDER BY b."id"`,
    `  LIMIT ${lim}`,
    `),`,
    `bp AS (SELECT y."bookingId" AS booking_id, count(*) AS n, SUM(y."total") AS total, SUM(y."amountPaid") AS paid FROM "BookingPricing" y WHERE y."bookingId" IN (SELECT d."id" FROM d) GROUP BY y."bookingId"),`,
    `pp AS (SELECT y."bookingId" AS booking_id, count(*) AS n, SUM(z."amount") AS amount, string_agg(DISTINCT NULLIF(z."paymentMethod"::text, ''), '|') AS methods`,
    `  FROM "BookingPricingPayment" z JOIN "BookingPricing" y ON y."id" = z."pricingId" WHERE y."bookingId" IN (SELECT d."id" FROM d) GROUP BY y."bookingId")`,
    `SELECT (SELECT jsonb_object_agg(kv.key, kv.value) FROM jsonb_each(to_jsonb(b)) kv WHERE kv.key IN (${keys})) AS booking,`,
    `  pk."name" AS park_name, bp.n AS lines_n, bp.total AS lines_total, bp.paid AS lines_paid,`,
    `  pp.n AS payments_n, pp.amount AS payments_total, pp.methods AS payment_methods`,
    `FROM d`,
    `JOIN "Booking" b ON b."id" = d."id"`,
    `LEFT JOIN "Park" pk ON pk."id" = b."parkId"`,
    `LEFT JOIN bp ON bp.booking_id = b."id"`,
    `LEFT JOIN pp ON pp.booking_id = b."id"`,
    `ORDER BY b."id"`,
  ].join("\n");
  return { sql, params: p.values };
}

function obj(v: unknown): J {
  if (v == null) return {};
  if (typeof v === "string") { try { const o = JSON.parse(v); return o && typeof o === "object" ? o : {}; } catch { return {}; } }
  return typeof v === "object" ? (v as J) : {};
}
function str(v: unknown): string | null {
  if (v == null || typeof v === "object") return null;
  const s = String(v).trim();
  return s ? s : null;
}
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "t" || v === "true";
}
const boolOrNull = (v: unknown) => (v == null ? null : bool(v));

/** Linha → dinheiro da reserva agora. PURA. */
export function mapLiveFinanceRow(r: J): LiveFinance {
  const b = obj(r.booking);
  const v = (k: "cashierClosed" | "cashValidated" | "driverValidated") => ({
    done: bool(b[k]), at: toIsoUtc(b[`${k}At`]), by: str(b[`${k}ByName`]) ?? str(b[`${k}ById`]),
  });
  const linesCount = Number(r.lines_n ?? 0) || 0;
  const paymentsCount = Number(r.payments_n ?? 0) || 0;
  return {
    id: String(b.id ?? ""),
    code: str(b.allocation),
    parkId: str(b.parkId),
    parkName: str(r.park_name),
    status: str(b.status),
    checkIn: toIsoUtc(b.checkIn),
    checkOut: toIsoUtc(b.checkOut),
    updatedAt: toIsoUtc(b.updatedAt),
    currency: str(b.currency) ?? "EUR",
    bookingPrice: num(b.bookingPrice),
    originalBookingPrice: num(b.originalBookingPrice),
    parkingPrice: num(b.parkingPrice),
    deliveryPrice: num(b.deliveryPrice),
    discountAmount: num(b.discountAmount),
    discountApplied: boolOrNull(b.discountApplied),
    paymentMethod: str(b.paymentMethod),
    paymentSource: str(b.paymentSource),
    paymentBy: str(b.paymentBy),
    campaignId: str(b.campaignId),
    partnerId: str(b.partnerId),
    partnerAmountDue: num(b.partnerAmountDue),
    partnerAmountPaid: num(b.partnerAmountPaid),
    partnerContributedAmount: num(b.partnerContributedAmount),
    pro: bool(b.pro),
    proClientId: str(b.proClientId),
    linesCount,
    linesTotal: linesCount ? num(r.lines_total) : null,
    linesPaid: linesCount ? num(r.lines_paid) : null,
    paymentsCount,
    paymentsTotal: paymentsCount ? num(r.payments_total) : null,
    paymentMethods: String(r.payment_methods ?? "").split("|").map((x) => x.trim()).filter(Boolean).sort(),
    cashierClosed: v("cashierClosed"),
    cashValidated: v("cashValidated"),
    driverValidated: v("driverValidated"),
  };
}

/** Dinheiro destas reservas (por id), agora. Lança — quem chama embrulha. */
export async function readLiveFinanceByIds(ids: string[], cities: string[] | undefined, query: Query = multiparkDbQuery): Promise<LiveFinance[]> {
  if (!ids.length) return [];
  const { sql, params } = buildLiveFinanceSql({ kind: "ids", ids }, cities);
  return (await query<J>(sql, params)).map(mapLiveFinanceRow);
}

/** Uma página das saídas do dia (id > after). Lança — quem chama embrulha. */
export async function readLiveCheckoutPage(bounds: DayBounds, parkIds: string[], after: string | null, pageSize: number, cities: string[] | undefined, query: Query = multiparkDbQuery): Promise<{ rows: LiveFinance[]; nextCursor: string | null }> {
  const size = Math.min(Math.max(Math.floor(pageSize), 1), CASH_CHECK_PAGE_MAX);
  const { sql, params } = buildLiveFinanceSql({ kind: "checkout", bounds, parkIds, after, limit: size + 1 }, cities);
  const all = (await query<J>(sql, params)).map(mapLiveFinanceRow);
  const rows = all.slice(0, size);
  return { rows, nextCursor: all.length > size ? rows[rows.length - 1]?.id ?? null : null };
}
