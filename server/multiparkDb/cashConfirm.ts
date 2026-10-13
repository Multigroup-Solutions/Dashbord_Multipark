/**
 * Confirmação da caixa reserva a reserva — leitura AO VIVO da BD da Multipark
 * (só leitura, SQL parametrizado, construtores e mapeadores PUROS).
 *
 * Universo de um dia da caixa (03:00 → 03:00) nos parques que operamos:
 *  - "checkout"  : CHECKED_OUT com saída (`checkOut`, data e hora) na janela;
 *  - "payment"   : reservas com algum pagamento registado na janela (pago no
 *                  check-in, antes, ainda no parque…);
 *  - "checkout_pending": saídas por concluir (CHECKING_OUT / PENDING_CHECKOUT)
 *                  com a saída na janela;
 *  - "cancelled" : canceladas NA JANELA (data do "Cancellation") que tiveram
 *                  check-in (`checkInDriverId`/`checkingInAt` preenchidos) —
 *                  nunca pelo `checkIn`, que é obrigatório e tem sempre a hora prevista.
 * Uma reserva entra uma vez, com o tipo mais forte (checkout > por concluir > cancelada > pagamento).
 *
 * Por reserva: os campos de dinheiro da "Booking" (só as chaves pedidas, via
 * jsonb — nada pessoal), as linhas, os pagamentos (com id, linha, método e
 * hora), o crédito, as taxas (`BookingFee`), os pagamentos online que a
 * Multipark lhe liga (links SETTLED, faturas que não são nota de crédito, PI da
 * reserva) e o reembolso do cancelamento.
 *
 * Falha fechado: LIMIT = máximo + 1; se vier o "+1", `truncated = true` e o dia
 * não fecha. Listas por reserva com o mesmo princípio (linhas/pagamentos a mais
 * → `truncated`).
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, toIsoUtc } from "./read";
import type { ConfirmBookingLive, ConfirmLine, ConfirmPayment, ConfirmValidation, InDay } from "../../shared/cashConfirm";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;
type J = Record<string, any>;

export const CONFIRM_BOOKINGS_MAX = 3000;
export const CONFIRM_LINES_MAX = 100;
export const CONFIRM_PAYMENTS_MAX = 200;

/** Chaves da "Booking" que a confirmação lê (nada pessoal). */
export const CONFIRM_BOOKING_KEYS = [
  "id", "allocation", "parkId", "status", "checkIn", "checkOut", "createdAt",
  "bookingPrice", "originalBookingPrice", "paymentMethod", "campaignId", "partnerId", "pro", "clientPlanId", "allowance",
  "checkOutDriverName", "checkInDriverId", "checkingInAt", "paymentIntentId", "stripeChargeId", "creditId", "bookingFeeId",
  "cashierClosed", "cashierClosedAt", "cashierClosedByName", "cashierClosedById",
  "cashValidated", "cashValidatedAt", "cashValidatedByName", "cashValidatedById",
  "driverValidated", "driverValidatedAt", "driverValidatedByName", "driverValidatedById",
] as const;

/** SQL do universo do dia com o detalhe de cada reserva. PURA. */
export function buildConfirmDaySql(o: { parkIds: readonly string[]; start: string; end: string }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const parks = o.parkIds.map((id) => p.add(id)).join(", ");
  const st = p.add(o.start), en = p.add(o.end);
  const keys = CONFIRM_BOOKING_KEYS.map((k) => p.add(k)).join(", ");
  const sql = [
    `WITH u AS (`,
    `  SELECT b."id" AS id, 1 AS rk FROM "Booking" b`,
    `   WHERE b."parkId" IN (${parks}) AND b."status"::text = 'CHECKED_OUT' AND b."checkOut" >= ${st}::timestamp AND b."checkOut" < ${en}::timestamp`,
    `  UNION ALL`,
    `  SELECT b."id", 2 FROM "Booking" b`,
    `   WHERE b."parkId" IN (${parks}) AND b."status"::text IN ('CHECKING_OUT', 'PENDING_CHECKOUT') AND b."checkOut" >= ${st}::timestamp AND b."checkOut" < ${en}::timestamp`,
    `  UNION ALL`,
    `  SELECT b."id", 3 FROM "Booking" b JOIN "Cancellation" cn ON cn."bookingId" = b."id"`,
    `   WHERE b."parkId" IN (${parks}) AND b."status"::text = 'CANCELLED' AND (b."checkInDriverId" IS NOT NULL OR b."checkingInAt" IS NOT NULL)`,
    `     AND cn."createdAt" >= ${st}::timestamp AND cn."createdAt" < ${en}::timestamp`,
    `  UNION ALL`,
    `  SELECT y."bookingId", 4 FROM "BookingPricingPayment" z JOIN "BookingPricing" y ON y."id" = z."pricingId" JOIN "Booking" b ON b."id" = y."bookingId"`,
    `   WHERE b."parkId" IN (${parks}) AND z."recordedAt" >= ${st}::timestamp AND z."recordedAt" < ${en}::timestamp`,
    `),`,
    `d AS (SELECT u.id, MIN(u.rk) AS rk FROM u GROUP BY u.id ORDER BY u.id LIMIT ${p.add(CONFIRM_BOOKINGS_MAX + 1)})`,
    `SELECT d.rk AS rk,`,
    `  (SELECT jsonb_object_agg(kv.key, kv.value) FROM jsonb_each(to_jsonb(b)) kv WHERE kv.key IN (${keys})) AS booking,`,
    `  pk."name" AS park_name,`,
    `  (SELECT coalesce(json_agg(x ORDER BY x.created, x.id), '[]'::json) FROM (SELECT y."id" AS id, y."description" AS description, y."category"::text AS category,`,
    `     y."total" AS total, y."amountPaid" AS paid, y."extraServiceId" AS extra, y."createdAt" AS created FROM "BookingPricing" y WHERE y."bookingId" = b."id"`,
    `     ORDER BY y."createdAt", y."id" LIMIT ${p.add(CONFIRM_LINES_MAX + 1)}) x) AS lines,`,
    `  (SELECT coalesce(json_agg(x ORDER BY x.at, x.id), '[]'::json) FROM (SELECT z."id" AS id, z."pricingId" AS pricing, z."amount" AS amount,`,
    `     NULLIF(z."paymentMethod"::text, '') AS method, z."recordedAt" AS at FROM "BookingPricingPayment" z JOIN "BookingPricing" y ON y."id" = z."pricingId"`,
    `     WHERE y."bookingId" = b."id" ORDER BY z."recordedAt", z."id" LIMIT ${p.add(CONFIRM_PAYMENTS_MAX + 1)}) x) AS payments,`,
    `  (SELECT c."value" FROM "Credit" c WHERE c."id" = b."creditId" OR c."bookingId" = b."id" ORDER BY (c."id" = b."creditId") DESC LIMIT 1) AS credit,`,
    `  (SELECT SUM(f."value") FROM "BookingFee" f WHERE f."bookingId" = b."id" OR f."id" = b."bookingFeeId") AS fees,`,
    `  (SELECT coalesce(json_agg(json_build_object('pi', l."paymentIntentId", 'amount', l."amountCents", 'received', l."amountReceivedCents")), '[]'::json)`,
    `     FROM "BookingPaymentLink" l WHERE l."bookingId" = b."id" AND l."status"::text = 'SETTLED' AND l."paymentIntentId" IS NOT NULL) AS links,`,
    `  (SELECT coalesce(json_agg(json_build_object('pi', y."paymentIntentId", 'amount', y."amount")), '[]'::json)`,
    `     FROM "Billing" y WHERE y."bookingId" = b."id" AND NULLIF(y."paymentIntentId", '') IS NOT NULL`,
    `       AND coalesce(y."invoiceExpressType", '') !~* 'credit') AS billing_pi,`,
    `  cx.refunded AS refunded, (cx.id IS NOT NULL) AS cancelled`,
    `FROM d`,
    `JOIN "Booking" b ON b."id" = d.id`,
    `LEFT JOIN "Park" pk ON pk."id" = b."parkId"`,
    `LEFT JOIN LATERAL (SELECT x."id", x."refundedAmount" AS refunded FROM "Cancellation" x WHERE x."bookingId" = b."id" ORDER BY x."createdAt" DESC LIMIT 1) cx ON TRUE`,
    `ORDER BY d.id`,
  ].join("\n");
  return { sql, params: p.values };
}

/** Nomes de parceiros (o método de pagamento de uma reserva de parceiro é o nome dele). PURA. */
export function buildPartnerNamesSql(): { sql: string; params: SqlParam[] } {
  return { sql: `SELECT p."name" AS name FROM "Partner" p WHERE NULLIF(p."name", '') IS NOT NULL LIMIT 1000`, params: [] };
}

function obj(v: unknown): J {
  if (v == null) return {};
  if (typeof v === "string") { try { const o = JSON.parse(v); return o && typeof o === "object" ? o : {}; } catch { return {}; } }
  return typeof v === "object" ? (v as J) : {};
}
const arr = (v: unknown): J[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [];
};
const str = (v: unknown): string | null => (v == null || typeof v === "object" || String(v).trim() === "" ? null : String(v).trim());
/** Número como está (sem arredondar — o motor arredonda ao cêntimo e assinala sub-cêntimos). */
const num = (v: unknown): number | null => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const bool = (v: unknown) => v === true || v === 1 || v === "1" || v === "t" || v === "true";

export type ConfirmKind = InDay;
const KIND: Record<number, ConfirmKind> = { 1: "checkout", 2: "checkout_pending", 3: "cancelled", 4: "payment_only" };

export interface ConfirmRow { kind: ConfirmKind; live: ConfirmBookingLive; truncated: boolean }

/** Linha → reserva. PURA. */
export function mapConfirmRow(r: J): ConfirmRow {
  const b = obj(r.booking);
  const v = (k: "cashierClosed" | "cashValidated" | "driverValidated"): ConfirmValidation => ({
    done: bool(b[k]), at: toIsoUtc(b[`${k}At`]), by: str(b[`${k}ByName`]), byId: str(b[`${k}ById`]),
  });
  const linesRaw = arr(r.lines), paysRaw = arr(r.payments);
  const lines: ConfirmLine[] = linesRaw.slice(0, CONFIRM_LINES_MAX).map((x) => ({
    id: String(x.id ?? ""), description: str(x.description), category: str(x.category), total: num(x.total), amountPaid: num(x.paid), extraServiceId: str(x.extra),
  }));
  const payments: ConfirmPayment[] = paysRaw.slice(0, CONFIRM_PAYMENTS_MAX).map((x) => ({
    id: String(x.id ?? ""), pricingId: str(x.pricing), amount: num(x.amount), method: str(x.method), recordedAt: toIsoUtc(x.at),
  }));
  const intents = new Map<string, number | null>();
  for (const l of arr(r.links)) if (l.pi) intents.set(String(l.pi), l.received != null ? Number(l.received) / 100 : l.amount != null ? Number(l.amount) / 100 : null);
  for (const x of arr(r.billing_pi)) if (x.pi && !intents.has(String(x.pi))) intents.set(String(x.pi), num(x.amount));
  const pi = str(b.paymentIntentId);
  if (pi && !intents.has(pi)) intents.set(pi, null);
  return {
    kind: KIND[Number(r.rk)] ?? "payment_only",
    truncated: linesRaw.length > CONFIRM_LINES_MAX || paysRaw.length > CONFIRM_PAYMENTS_MAX,
    live: {
      id: String(b.id ?? ""), code: str(b.allocation), parkId: String(b.parkId ?? ""), parkName: str(r.park_name), status: str(b.status),
      checkIn: toIsoUtc(b.checkIn), checkOut: toIsoUtc(b.checkOut), createdAt: toIsoUtc(b.createdAt),
      bookingPrice: num(b.bookingPrice), originalBookingPrice: num(b.originalBookingPrice),
      paymentMethod: str(b.paymentMethod), campaignId: str(b.campaignId), partnerId: str(b.partnerId),
      pro: bool(b.pro), clientPlanId: str(b.clientPlanId), allowance: bool(b.allowance),
      checkOutDriverName: str(b.checkOutDriverName), checkInDriverId: str(b.checkInDriverId), checkingInAt: toIsoUtc(b.checkingInAt),
      paymentIntentId: pi, stripeChargeId: str(b.stripeChargeId),
      credit: num(r.credit), fees: num(r.fees),
      cashierClosed: v("cashierClosed"), cashValidated: v("cashValidated"), driverValidated: v("driverValidated"),
      lines, payments,
      intents: [...intents].map(([id, expected]) => ({ id, expected })),
      cancelled: bool(r.cancelled), refunded: num(r.refunded),
    },
  };
}

export interface ConfirmDayRead { rows: ConfirmRow[]; truncated: boolean; partnerNames: string[] }

/** Universo do dia + nomes de parceiros. Lança — quem chama embrulha (safeMultiparkRead). */
export async function readConfirmDay(o: { parkIds: readonly string[]; start: string; end: string }, query: Query = multiparkDbQuery): Promise<ConfirmDayRead> {
  if (!o.parkIds.length) return { rows: [], truncated: false, partnerNames: [] };
  const a = buildConfirmDaySql(o), pn = buildPartnerNamesSql();
  const [raw, partners] = await Promise.all([query<J>(a.sql, a.params), query<J>(pn.sql, pn.params)]);
  const rows = raw.slice(0, CONFIRM_BOOKINGS_MAX).map(mapConfirmRow);
  return {
    rows,
    truncated: raw.length > CONFIRM_BOOKINGS_MAX || rows.some((x) => x.truncated),
    partnerNames: partners.map((x) => String(x.name ?? "").trim()).filter(Boolean),
  };
}
