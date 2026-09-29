/**
 * Caixa, fase 4 (cruzar com o exterior) — leituras AO VIVO da BD da Multipark
 * para comparar com a InvoiceExpress, a Stripe e os extratos (banco, terminal
 * multibanco e parceiros). Só leitura; SQL parametrizado; LIMIT sempre.
 *
 *  1. Saídas de um intervalo nos nossos parques, com as faturas (`Billing`),
 *     os ids de pagamento online (`paymentIntentId` da reserva, das faturas e
 *     dos links) e o que a Multipark dá como pago.
 *  2. Reservas por `paymentIntentId` (reembolsos e disputas vistos na Stripe).
 *  3. Pagamentos registados num intervalo, por parque (multibanco do dia:
 *     talões e Viva Wallet).
 *  4. Devido de um mês por parceiro (agentes e agregadores) e por cliente Pro
 *     (recebimentos mensais, conferidos à mão).
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
  /** Método da reserva e o que os pagamentos registados dão como pago online (Stripe). */
  paymentMethod: string | null; onlinePaid: number | null;
  paymentIntentId: string | null; stripeChargeId: string | null;
  cancelled: boolean; refundedAmount: number | null;
  billing: ExternalBilling[]; links: ExternalLink[];
}

const EXTERNAL_SELECT = [
  `SELECT b."id" AS id, b."allocation" AS code, b."parkId" AS park_id, b."status"::text AS status, b."checkOut" AS check_out,`,
  `  b."bookingPrice" AS booking_price, b."paymentSource"::text AS payment_source, NULLIF(b."paymentMethod", '') AS payment_method,`,
  `  (SELECT SUM(z."amount") FROM "BookingPricingPayment" z JOIN "BookingPricing" y ON y."id" = z."pricingId" WHERE y."bookingId" = b."id"`,
  `     AND (lower(z."paymentMethod") LIKE '%online%' OR lower(z."paymentMethod") LIKE '%stripe%')) AS online_paid,`,
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
    paymentMethod: s(r.payment_method), onlinePaid: n(r.online_paid),
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

// ─── 4. Devido do mês (recebimentos mensais) ───────────────────────────────

export interface MonthDue { kind: "parceiro" | "pro"; entityId: string; name: string | null; partnerType: string | null; bookings: number; due: number }

/**
 * Por parceiro (nome + tipo: agência, agregador, parceiro) e por cliente Pro,
 * as reservas com saída em [start, end) nos parques dados, sem canceladas:
 * parceiros → soma de `partnerAmountDue`; Pro → soma de `bookingPrice` (o
 * que o cliente Pro paga no fim do mês). PURA.
 */
export function buildMonthDuesSql(o: { parkIds: readonly string[]; start: string; end: string }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const parks = o.parkIds.map((id) => p.add(id)).join(", ");
  const start = p.add(o.start), end = p.add(o.end);
  const where = `b."parkId" IN (${parks}) AND b."checkOut" >= ${start}::timestamp AND b."checkOut" < ${end}::timestamp AND b."status"::text NOT IN ('CANCELLED', 'CANCELED')`;
  const sql = [
    `SELECT 'parceiro' AS kind, COALESCE(NULLIF(pa."name", ''), pa."id") AS entity_id, max(pa."name") AS name, max(pa."partnerType"::text) AS partner_type,`,
    `  count(*) AS n, SUM(COALESCE(b."partnerAmountDue", 0)) AS due`,
    `  FROM "Booking" b JOIN "Partner" pa ON pa."id" = b."partnerId" WHERE ${where} GROUP BY 2`,
    `UNION ALL`,
    `SELECT 'pro' AS kind, pc."id" AS entity_id, max(pc."name") AS name, NULL AS partner_type, count(*) AS n, SUM(COALESCE(b."bookingPrice", 0)) AS due`,
    `  FROM "Booking" b JOIN "ProClient" pc ON pc."id" = b."proClientId" WHERE ${where} GROUP BY 2`,
    `LIMIT ${p.add(2000)}`,
  ].join("\n");
  return { sql, params: p.values };
}

export function mapMonthDueRow(r: J): MonthDue {
  return { kind: r.kind === "pro" ? "pro" : "parceiro", entityId: String(r.entity_id ?? ""), name: s(r.name), partnerType: s(r.partner_type), bookings: Math.round(Number(r.n ?? 0)) || 0, due: n(r.due) ?? 0 };
}

export async function readMonthDues(o: { parkIds: readonly string[]; start: string; end: string }, query: Query = multiparkDbQuery): Promise<MonthDue[]> {
  if (!o.parkIds.length) return [];
  const { sql, params } = buildMonthDuesSql(o);
  return (await query<J>(sql, params)).map(mapMonthDueRow);
}

// ─── 5. Em atraso (meses anteriores ainda por pagar) ───────────────────────

export const ARREARS_MONTHS = 12;
export interface MonthArrears { kind: "parceiro" | "pro"; entityId: string; bookings: number; arrears: number }

/**
 * Saídas em [start, end) (os 12 meses antes do mês escolhido) ainda por pagar
 * na Multipark: parceiros → `partnerAmountDue − partnerAmountPaid`; Pro →
 * preço − pago nas linhas. Só as reservas com valor em falta. PURA.
 */
export function buildMonthArrearsSql(o: { parkIds: readonly string[]; start: string; end: string }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const parks = o.parkIds.map((id) => p.add(id)).join(", ");
  const start = p.add(o.start), end = p.add(o.end);
  const where = `b."parkId" IN (${parks}) AND b."checkOut" >= ${start}::timestamp AND b."checkOut" < ${end}::timestamp AND b."status"::text NOT IN ('CANCELLED', 'CANCELED')`;
  const sql = [
    `SELECT 'parceiro' AS kind, COALESCE(NULLIF(pa."name", ''), pa."id") AS entity_id, count(*) AS n,`,
    `  SUM(COALESCE(b."partnerAmountDue", 0) - COALESCE(b."partnerAmountPaid", 0)) AS arrears`,
    `  FROM "Booking" b JOIN "Partner" pa ON pa."id" = b."partnerId"`,
    `  WHERE ${where} AND COALESCE(b."partnerAmountDue", 0) - COALESCE(b."partnerAmountPaid", 0) > 0.01 GROUP BY 2`,
    `UNION ALL`,
    `SELECT 'pro' AS kind, pc."id" AS entity_id, count(*) AS n, SUM(x.missing) AS arrears FROM (`,
    `  SELECT b."proClientId" AS pro_id, COALESCE(b."bookingPrice", 0) - COALESCE((SELECT SUM(y."amountPaid") FROM "BookingPricing" y WHERE y."bookingId" = b."id"), 0) AS missing`,
    `    FROM "Booking" b WHERE ${where} AND b."proClientId" IS NOT NULL) x`,
    `  JOIN "ProClient" pc ON pc."id" = x.pro_id WHERE x.missing > 0.01 GROUP BY 2`,
    `LIMIT ${p.add(2000)}`,
  ].join("\n");
  return { sql, params: p.values };
}

export async function readMonthArrears(o: { parkIds: readonly string[]; start: string; end: string }, query: Query = multiparkDbQuery): Promise<MonthArrears[]> {
  if (!o.parkIds.length) return [];
  const { sql, params } = buildMonthArrearsSql(o);
  return (await query<J>(sql, params)).map((r) => ({ kind: r.kind === "pro" ? "pro" : "parceiro", entityId: String(r.entity_id ?? ""), bookings: Math.round(Number(r.n ?? 0)) || 0, arrears: n(r.arrears) ?? 0 }));
}
