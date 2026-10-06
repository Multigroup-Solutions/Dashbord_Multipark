/**
 * P3 lote 29d — Caixa por dia (Jorge, 6 out 2026): "na caixa deve vir a caixa
 * por dia, a caixa que vem da Multipark: quem fechou, quem não fechou, quem
 * entregou, dividido por cidade, só os parques que nós operamos". Só leitura
 * da BD da Multipark (SELECT com parâmetros).
 *
 *  - Pagamentos registados no dia (dia de Lisboa), por parque e método
 *    ("BookingPricingPayment".recordedAt) — a mesma base da contagem da caixa.
 *  - Saídas do dia (CHECKED_OUT, "checkOut" no dia) por parque, condutor e o
 *    estado do dinheiro de cada reserva: o condutor entregou ao líder
 *    (driverValidated), o líder fechou a caixa (cashierClosed) e o back office
 *    conferiu (cashValidated), com quem e o valor pago.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList } from "./read";

type Query = typeof multiparkDbQuery;
type J = Record<string, unknown>;
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const s = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());
const b = (v: unknown) => v === true || v === "t" || v === "true" || v === 1 || v === "1";
const LIMIT = 5000;

/** Pagamentos registados em [start, end) (UTC) por parque e método. PURA. */
export function buildDayPaymentsSql(o: { parkIds: readonly string[]; start: string; end: string }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const sql = [
    `SELECT b."parkId" AS park_id, NULLIF(z."paymentMethod"::text, '') AS method, SUM(z."amount") AS amount, count(*) AS n`,
    `  FROM "BookingPricingPayment" z JOIN "BookingPricing" y ON y."id" = z."pricingId" JOIN "Booking" b ON b."id" = y."bookingId"`,
    ` WHERE b."parkId" IN (${o.parkIds.map((id) => p.add(id)).join(", ")})`,
    `   AND z."recordedAt" >= ${p.add(o.start)}::timestamp AND z."recordedAt" < ${p.add(o.end)}::timestamp`,
    ` GROUP BY 1, 2 LIMIT ${p.add(LIMIT)}`,
  ].join("\n");
  return { sql, params: p.values };
}

/** Saídas do dia por parque, condutor e estado do dinheiro (agrupadas). PURA. */
export function buildDayCheckoutsSql(o: { parkIds: readonly string[]; start: string; end: string }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const parks = o.parkIds.map((id) => p.add(id)).join(", ");
  const st = p.add(o.start), en = p.add(o.end);
  const sql = [
    `SELECT b."parkId" AS park_id, NULLIF(b."checkOutDriverName", '') AS driver, NULLIF(b."paymentMethod", '') AS method,`,
    `  b."driverValidated" AS driver_ok, NULLIF(b."driverValidatedByName", '') AS driver_by,`,
    `  b."cashierClosed" AS closed, NULLIF(b."cashierClosedByName", '') AS closed_by,`,
    `  b."cashValidated" AS validated, NULLIF(b."cashValidatedByName", '') AS validated_by,`,
    `  count(*) AS n, SUM(COALESCE(bp.paid, 0)) AS paid`,
    `FROM "Booking" b`,
    `LEFT JOIN LATERAL (SELECT SUM(y."amountPaid") AS paid FROM "BookingPricing" y WHERE y."bookingId" = b."id") bp ON true`,
    `WHERE b."parkId" IN (${parks}) AND b."status"::text = 'CHECKED_OUT'`,
    `  AND b."checkOut" >= ${st}::timestamp AND b."checkOut" < ${en}::timestamp`,
    `GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9`,
    `LIMIT ${p.add(LIMIT)}`,
  ].join("\n");
  return { sql, params: p.values };
}

export interface DayPaymentRow { parkId: string; method: string | null; amount: number; count: number }
export interface DayCheckoutRow {
  parkId: string; driver: string | null; method: string | null;
  driverOk: boolean; driverBy: string | null; closed: boolean; closedBy: string | null; validated: boolean; validatedBy: string | null;
  count: number; paid: number;
}

export const mapDayPayment = (r: J): DayPaymentRow => ({ parkId: String(r.park_id ?? ""), method: s(r.method), amount: n(r.amount), count: n(r.n) });
export const mapDayCheckout = (r: J): DayCheckoutRow => ({
  parkId: String(r.park_id ?? ""), driver: s(r.driver), method: s(r.method),
  driverOk: b(r.driver_ok), driverBy: s(r.driver_by), closed: b(r.closed), closedBy: s(r.closed_by), validated: b(r.validated), validatedBy: s(r.validated_by),
  count: n(r.n), paid: n(r.paid),
});

export async function readCashDay(o: { parkIds: readonly string[]; start: string; end: string }, query: Query = multiparkDbQuery): Promise<{ payments: DayPaymentRow[]; checkouts: DayCheckoutRow[] }> {
  if (!o.parkIds.length) return { payments: [], checkouts: [] };
  const a = buildDayPaymentsSql(o), c = buildDayCheckoutsSql(o);
  const [pay, out] = await Promise.all([query<J>(a.sql, a.params), query<J>(c.sql, c.params)]);
  return { payments: pay.map(mapDayPayment), checkouts: out.map(mapDayCheckout) };
}
