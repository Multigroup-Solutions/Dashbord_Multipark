/**
 * Caixa, fase 4 (cruzar com o exterior) — leituras AO VIVO da BD da Multipark
 * para comparar com a InvoiceExpress, a Stripe e os extratos (banco, terminal
 * multibanco e parceiros). Só leitura; SQL parametrizado; LIMIT sempre.
 *
 *  1. Saídas de um intervalo nos nossos parques, com as faturas (`Billing`),
 *     os ids de pagamento online (`paymentIntentId` da reserva, das faturas e
 *     dos links) e o que a Multipark dá como pago.
 *  2. Reservas por `paymentIntentId` (reembolsos e disputas vistos na Stripe).
 *  3. Pagamentos registados num intervalo, por parque (extratos do terminal e
 *     do banco).
 *  4. Reservas por referência externa ou código (extratos dos parceiros).
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, toIsoUtc } from "./read";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;
type J = Record<string, any>;

export const EXTERNAL_BOOKINGS_LIMIT = 3000;
export const EXTERNAL_PAYMENTS_LIMIT = 20000;

const s = (v: unknown) => (v == null || v === "" ? null : String(v));
const n = (v: unknown) => { if (v == null || v === "") return null; const x = Number(v); return Number.isFinite(x) ? Math.round(x * 100) / 100 : null; };
const b = (v: unknown) => v === true || v === 1 || v === "1" || v === "t" || v === "true";
const arr = (v: unknown): J[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } }
  return [];
};

// ─── 1. Saídas com faturas e pagamentos online ─────────────────────────────

export interface ExternalBilling { id: string; invoiceExpressId: number | null; type: string | null; amount: number | null; emitted: boolean; paymentIntentId: string | null }
export interface ExternalLink { paymentIntentId: string; amount: number | null; received: number | null; status: string | null }
export interface ExternalBooking {
  id: string; code: string | null; parkId: string | null; status: string | null; checkOut: string | null;
  bookingPrice: number | null; paid: number | null; paymentSource: string | null;
  paymentIntentId: string | null; stripeChargeId: string | null;
  cancelled: boolean; refundedAmount: number | null;
  billing: ExternalBilling[]; links: ExternalLink[];
}

const EXTERNAL_SELECT = [
  `SELECT b."id" AS id, b."allocation" AS code, b."parkId" AS park_id, b."status"::text AS status, b."checkOut" AS check_out,`,
  `  b."bookingPrice" AS booking_price, b."paymentSource"::text AS payment_source,`,
  `  NULLIF(b."paymentIntentId", '') AS payment_intent_id, NULLIF(b."stripeChargeId", '') AS stripe_charge_id,`,
  `  (SELECT SUM(y."amountPaid") FROM "BookingPricing" y WHERE y."bookingId" = b."id") AS paid,`,
  `  cx.refunded_amount AS refunded_amount, (cx.id IS NOT NULL) AS cancelled,`,
  `  (SELECT json_agg(json_build_object('id', y."id", 'ix', y."invoiceExpressId", 'type', y."invoiceExpressType", 'amount', y."amount",`,
  `     'emitted', y."emited", 'pi', NULLIF(y."paymentIntentId", '')) ORDER BY y."createdAt") FROM "Billing" y WHERE y."bookingId" = b."id") AS billing,`,
  `  (SELECT json_agg(json_build_object('pi', y."paymentIntentId", 'amount', y."amountCents", 'received', y."amountReceivedCents", 'status', y."status"::text))`,
  `     FROM "BookingPaymentLink" y WHERE y."bookingId" = b."id") AS links`,
  `FROM "Booking" b`,
  `LEFT JOIN LATERAL (SELECT x."id", x."refundedAmount" AS refunded_amount FROM "Cancellation" x WHERE x."bookingId" = b."id" ORDER BY x."createdAt" DESC LIMIT 1) cx ON TRUE`,
].join("\n");

/** Saídas em [start, end) (UTC) nos parques dados. PURA. */
export function buildExternalCheckoutsSql(o: { parkIds: readonly string[]; start: string; end: string }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const sql = [
    EXTERNAL_SELECT,
    ` WHERE b."parkId" IN (${o.parkIds.map((id) => p.add(id)).join(", ")})`,
    `   AND b."checkOut" >= ${p.add(o.start)}::timestamp AND b."checkOut" < ${p.add(o.end)}::timestamp`,
    ` ORDER BY b."id" LIMIT ${p.add(EXTERNAL_BOOKINGS_LIMIT)}`,
  ].join("\n");
  return { sql, params: p.values };
}

/** Reservas que usam algum destes `paymentIntentId` (reserva, fatura ou link). PURA. */
export function buildBookingsByIntentSql(o: { parkIds: readonly string[]; intents: readonly string[] }): { sql: string; params: SqlParam[] } {
  const intents = [...new Set(o.intents.filter(Boolean))].slice(0, 500);
  if (!o.parkIds.length) throw new Error("Sem parques.");
  if (!intents.length) throw new Error("Sem pagamentos.");
  const p = new ParamList();
  const parks = o.parkIds.map((id) => p.add(id)).join(", ");
  const list = intents.map((x) => p.add(x)).join(", ");
  const sql = [
    EXTERNAL_SELECT,
    ` WHERE b."parkId" IN (${parks})`,
    `   AND (b."paymentIntentId" IN (${list})`,
    `     OR b."id" IN (SELECT y."bookingId" FROM "Billing" y WHERE y."paymentIntentId" IN (${list}))`,
    `     OR b."id" IN (SELECT y."bookingId" FROM "BookingPaymentLink" y WHERE y."paymentIntentId" IN (${list})))`,
    ` LIMIT ${p.add(intents.length * 3)}`,
  ].join("\n");
  return { sql, params: p.values };
}

export function mapExternalBookingRow(r: J): ExternalBooking {
  return {
    id: String(r.id ?? ""), code: s(r.code), parkId: s(r.park_id), status: s(r.status), checkOut: toIsoUtc(r.check_out),
    bookingPrice: n(r.booking_price), paid: n(r.paid), paymentSource: s(r.payment_source),
    paymentIntentId: s(r.payment_intent_id), stripeChargeId: s(r.stripe_charge_id),
    cancelled: b(r.cancelled), refundedAmount: n(r.refunded_amount),
    billing: arr(r.billing).map((x) => ({
      id: String(x.id ?? ""), invoiceExpressId: x.ix == null ? null : Number(x.ix), type: s(x.type), amount: n(x.amount), emitted: b(x.emitted), paymentIntentId: s(x.pi),
    })),
    links: arr(r.links).filter((x) => x.pi).map((x) => ({
      paymentIntentId: String(x.pi), amount: x.amount == null ? null : n(Number(x.amount) / 100), received: x.received == null ? null : n(Number(x.received) / 100), status: s(x.status),
    })),
  };
}

export async function readExternalCheckouts(o: { parkIds: readonly string[]; start: string; end: string }, query: Query = multiparkDbQuery): Promise<ExternalBooking[]> {
  if (!o.parkIds.length) return [];
  const { sql, params } = buildExternalCheckoutsSql(o);
  return (await query<J>(sql, params)).map(mapExternalBookingRow);
}

export async function readBookingsByIntent(o: { parkIds: readonly string[]; intents: readonly string[] }, query: Query = multiparkDbQuery): Promise<ExternalBooking[]> {
  if (!o.parkIds.length || !o.intents.some(Boolean)) return [];
  const { sql, params } = buildBookingsByIntentSql(o);
  return (await query<J>(sql, params)).map(mapExternalBookingRow);
}

// ─── 3. Pagamentos de um intervalo (extratos do terminal e do banco) ───────

export interface RecordedPayment { bookingId: string; code: string | null; parkId: string | null; amount: number; method: string | null; recordedAt: string | null }

/** Pagamentos registados em [start, end) (UTC) nos parques dados. PURA. */
export function buildPaymentsInWindowSql(o: { parkIds: readonly string[]; start: string; end: string }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const sql = [
    `SELECT b."id" AS booking_id, b."allocation" AS code, b."parkId" AS park_id, z."amount" AS amount, z."paymentMethod" AS method, z."recordedAt" AS recorded_at`,
    `  FROM "BookingPricingPayment" z JOIN "BookingPricing" y ON y."id" = z."pricingId" JOIN "Booking" b ON b."id" = y."bookingId"`,
    ` WHERE b."parkId" IN (${o.parkIds.map((id) => p.add(id)).join(", ")})`,
    `   AND z."recordedAt" >= ${p.add(o.start)}::timestamp AND z."recordedAt" < ${p.add(o.end)}::timestamp`,
    ` ORDER BY z."recordedAt", z."id" LIMIT ${p.add(EXTERNAL_PAYMENTS_LIMIT)}`,
  ].join("\n");
  return { sql, params: p.values };
}

export function mapRecordedPaymentRow(r: J): RecordedPayment {
  return { bookingId: String(r.booking_id ?? ""), code: s(r.code), parkId: s(r.park_id), amount: n(r.amount) ?? 0, method: s(r.method), recordedAt: toIsoUtc(r.recorded_at) };
}

export async function readPaymentsInWindow(o: { parkIds: readonly string[]; start: string; end: string }, query: Query = multiparkDbQuery): Promise<RecordedPayment[]> {
  if (!o.parkIds.length) return [];
  const { sql, params } = buildPaymentsInWindowSql(o);
  return (await query<J>(sql, params)).map(mapRecordedPaymentRow);
}

// ─── 4. Reservas por referência (extratos dos parceiros) ───────────────────

export interface PartnerDueRow { id: string; code: string | null; externalReference: string | null; parkId: string | null; partnerId: string | null; status: string | null; due: number | null; paidToUs: number | null }

/** Por referência externa (a do parceiro) ou código (allocation). PURA. */
export function buildPartnerDueSql(o: { parkIds: readonly string[]; refs: readonly string[] }): { sql: string; params: SqlParam[] } {
  const refs = [...new Set(o.refs.map((x) => x.trim()).filter(Boolean))].slice(0, 2000);
  if (!o.parkIds.length) throw new Error("Sem parques.");
  if (!refs.length) throw new Error("Sem referências.");
  const p = new ParamList();
  const parks = o.parkIds.map((id) => p.add(id)).join(", ");
  const list = refs.map((x) => p.add(x)).join(", ");
  const sql = [
    `SELECT b."id" AS id, b."allocation" AS code, NULLIF(b."externalReference", '') AS external_reference, b."parkId" AS park_id, b."partnerId" AS partner_id,`,
    `  b."status"::text AS status, b."partnerAmountDue" AS due, b."partnerAmountPaid" AS paid_to_us`,
    `  FROM "Booking" b WHERE b."parkId" IN (${parks}) AND (b."externalReference" IN (${list}) OR b."allocation" IN (${list}))`,
    ` LIMIT ${p.add(refs.length * 2)}`,
  ].join("\n");
  return { sql, params: p.values };
}

export function mapPartnerDueRow(r: J): PartnerDueRow {
  return {
    id: String(r.id ?? ""), code: s(r.code), externalReference: s(r.external_reference), parkId: s(r.park_id), partnerId: s(r.partner_id),
    status: s(r.status), due: n(r.due), paidToUs: n(r.paid_to_us),
  };
}

export async function readPartnerDue(o: { parkIds: readonly string[]; refs: readonly string[] }, query: Query = multiparkDbQuery): Promise<PartnerDueRow[]> {
  if (!o.parkIds.length || !o.refs.some((x) => x.trim())) return [];
  const { sql, params } = buildPartnerDueSql(o);
  return (await query<J>(sql, params)).map(mapPartnerDueRow);
}
