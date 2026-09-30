/**
 * Caixa, fase 2 (detetar) — leituras AO VIVO da BD da Multipark para a
 * varredura de 3 em 3 horas (server/cashSweep.ts). Só leitura.
 *
 *  1. Que reservas ver: dos NOSSOS parques, as alteradas desde a última
 *     varredura ("Booking".updatedAt, linhas "BookingPricing".updatedAt,
 *     pagamentos "BookingPricingPayment".recordedAt) + as ativas (dentro do
 *     parque ou a entrar/sair) + as que saíram nas últimas 48 h.
 *  2. Por reserva, o que as regras novas precisam além do dinheiro
 *     (cashCheck.ts): cancelamento/reembolso, faturas, crédito, links de
 *     pagamento online, disputa (só sim/não), extras feitos sem cobrança,
 *     pagamentos em dinheiro por validar, pro/avença.
 *  3. Permissões de dinheiro dos agentes dos nossos parques (retrato diário).
 *
 * Nada pessoal: só ids, valores, estados e nomes de agentes. Regras de
 * read.ts: SQL parametrizado, construtores PUROS, LIMIT sempre.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, toIsoUtc } from "./read";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;
type J = Record<string, any>;

export const SWEEP_IDS_LIMIT = 2000;
/** Estados "em curso" (o dinheiro ainda pode mexer). */
export const ACTIVE_STATUSES = ["CHECKING_IN", "CHECKED_IN", "MOVING", "PENDING_CHECKOUT", "CHECKING_OUT"] as const;
/** Saídas recentes ainda vistas em todas as varreduras. */
export const RECENT_CHECKOUT_HOURS = 48;

// ─── 1. Que reservas ver ────────────────────────────────────────────────────

/** PURA. `since`/`now`: instantes UTC "YYYY-MM-DD HH:MM:SS". */
export function buildSweepIdsSql(o: { parkIds: readonly string[]; since: string; now: string }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const parks = o.parkIds.map((id) => p.add(id)).join(", ");
  const since = p.add(o.since);
  const now = p.add(o.now);
  const active = ACTIVE_STATUSES.map((s) => p.add(s)).join(", ");
  const sql = [
    `SELECT DISTINCT b."id" AS id, b."parkId" AS park_id, b."updatedAt" AS updated_at FROM "Booking" b`,
    ` WHERE b."parkId" IN (${parks})`,
    `   AND (`,
    `     b."updatedAt" >= ${since}::timestamp`,
    `     OR b."status"::text IN (${active})`,
    `     OR (b."status"::text = 'CHECKED_OUT' AND b."checkOutDate" >= ${now}::timestamp - interval '${RECENT_CHECKOUT_HOURS + 24} hours'`,
    `         AND b."checkOut" >= ${now}::timestamp - interval '${RECENT_CHECKOUT_HOURS} hours')`,
    `     OR b."id" IN (SELECT y."bookingId" FROM "BookingPricing" y WHERE y."updatedAt" >= ${since}::timestamp)`,
    `     OR b."id" IN (SELECT y."bookingId" FROM "BookingPricingPayment" z JOIN "BookingPricing" y ON y."id" = z."pricingId" WHERE z."recordedAt" >= ${since}::timestamp)`,
    `   )`,
    // por ordem de alteração: se o LIMIT cortar, cortam-se as mais recentes e a
    // próxima corrida continua a partir da última lida (ver runCashSweep)
    ` ORDER BY b."updatedAt", b."id"`,
    ` LIMIT ${p.add(SWEEP_IDS_LIMIT)}`,
  ].join("\n");
  return { sql, params: p.values };
}

export async function readSweepIds(o: { parkIds: readonly string[]; since: string; now: string }, query: Query = multiparkDbQuery): Promise<Array<{ id: string; parkId: string; updatedAtMs: number }>> {
  if (!o.parkIds.length) return [];
  const { sql, params } = buildSweepIdsSql(o);
  return (await query<J>(sql, params)).map((r) => ({ id: String(r.id), parkId: String(r.park_id ?? ""), updatedAtMs: sweepUpdatedMs(r.updated_at) }));
}

/** "updatedAt" da Multipark (timestamp sem fuso, em UTC) → ms. PURA. */
export function sweepUpdatedMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const s = String(v ?? "").trim();
  return s ? Date.parse(`${s.replace(" ", "T").replace(/Z$/, "")}Z`) : NaN;
}

/** Reservas movimentadas nas últimas `hours` horas, por parque (saúde do webhook, R27). PURA. */
export function buildParkMovementSql(o: { parkIds: readonly string[]; since: string }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const sql = `SELECT b."parkId" AS park_id, count(*) AS n FROM "Booking" b WHERE b."parkId" IN (${o.parkIds.map((id) => p.add(id)).join(", ")})
    AND b."updatedAt" >= ${p.add(o.since)}::timestamp GROUP BY 1 LIMIT ${p.add(o.parkIds.length)}`;
  return { sql, params: p.values };
}

export async function readParkMovement(o: { parkIds: readonly string[]; since: string }, query: Query = multiparkDbQuery): Promise<Map<string, number>> {
  if (!o.parkIds.length) return new Map();
  const { sql, params } = buildParkMovementSql(o);
  return new Map((await query<J>(sql, params)).map((r) => [String(r.park_id), Number(r.n ?? 0) || 0]));
}

// ─── 2. O que as regras novas precisam ──────────────────────────────────────

export interface SweepExtras {
  id: string;
  clientPlanId: string | null;
  allowance: string | null;
  creditId: string | null;
  checkOutDriverName: string | null;
  /** Pediu fatura com NIF (só sim/não; o NIF não sai daqui). */
  hasNif: boolean;
  /** disputeEvents preenchido (só sim/não, nunca o conteúdo). */
  disputed: boolean;
  cancellation: { at: string | null; refund: boolean; refunded: boolean; refundedAmount: number | null; hasTransaction: boolean } | null;
  billing: { count: number; emitted: number; amount: number | null; creditNotes: number };
  credit: { count: number; value: number | null };
  paymentLinks: { failed: number; succeeded: number; received: number | null };
  extras: { done: number; doneUncharged: number };
  cash: { amount: number | null; firstAt: string | null };
}

/** Por reserva (ids): cancelamento, faturas, crédito, links, disputa, extras e dinheiro. PURA. */
export function buildSweepExtrasSql(ids: readonly string[]): { sql: string; params: SqlParam[] } {
  const clean = [...new Set(ids.filter(Boolean))].slice(0, 1000);
  if (!clean.length) throw new Error("Sem reservas.");
  const p = new ParamList();
  const list = clean.map((x) => p.add(x)).join(", ");
  const sql = [
    `WITH d AS (SELECT b."id" FROM "Booking" b WHERE b."id" IN (${list}))`,
    `SELECT b."id" AS id, b."clientPlanId"::text AS client_plan_id, b."allowance"::text AS allowance, b."creditId"::text AS credit_id,`,
    `  NULLIF(b."checkOutDriverName", '') AS checkout_driver, (NULLIF(trim(COALESCE(b."taxNumber", '')), '') IS NOT NULL) AS has_nif,`,
    `  (b."disputeEvents" IS NOT NULL AND b."disputeEvents"::text NOT IN ('null', '[]', '{}', '')) AS disputed,`,
    `  cx.at AS cx_at, cx.refund AS cx_refund, cx.refunded AS cx_refunded, cx.refunded_amount AS cx_refunded_amount, cx.has_tx AS cx_has_tx,`,
    `  bl.n AS billing_n, bl.emitted AS billing_emitted, bl.amount AS billing_amount, bl.credit_notes AS billing_credit_notes,`,
    `  cr.n AS credit_n, cr.value AS credit_value,`,
    `  pl.failed AS links_failed, pl.succeeded AS links_succeeded, pl.received AS links_received,`,
    `  ex.done AS extras_done, ex.uncharged AS extras_uncharged,`,
    `  ca.amount AS cash_amount, ca.first_at AS cash_first_at`,
    `FROM d JOIN "Booking" b ON b."id" = d."id"`,
    `LEFT JOIN LATERAL (SELECT x."createdAt" AS at, COALESCE(x."refund", false) AS refund, COALESCE(x."refunded", false) AS refunded,`,
    `  x."refundedAmount" AS refunded_amount, (NULLIF(x."refundTransactionId", '') IS NOT NULL) AS has_tx`,
    `  FROM "Cancellation" x WHERE x."bookingId" = b."id" ORDER BY x."createdAt" DESC LIMIT 1) cx ON TRUE`,
    `LEFT JOIN LATERAL (SELECT count(*) AS n, count(*) FILTER (WHERE COALESCE(y."emited", false)) AS emitted, SUM(y."amount") AS amount,`,
    `  count(*) FILTER (WHERE upper(COALESCE(y."invoiceExpressType"::text, '')) LIKE '%CREDIT%') AS credit_notes`,
    `  FROM "Billing" y WHERE y."bookingId" = b."id") bl ON TRUE`,
    `LEFT JOIN LATERAL (SELECT count(*) AS n, SUM(y."value") AS value FROM "Credit" y WHERE y."bookingId" = b."id") cr ON TRUE`,
    `LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE upper(y."status"::text) IN ('FAILED', 'CANCELED', 'CANCELLED')) AS failed,`,
    `  count(*) FILTER (WHERE upper(y."status"::text) IN ('SETTLED')) AS succeeded, SUM(y."amountReceivedCents") / 100.0 AS received`,
    `  FROM "BookingPaymentLink" y WHERE y."bookingId" = b."id") pl ON TRUE`,
    `LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE COALESCE(e."done", false)) AS done,`,
    `  count(*) FILTER (WHERE COALESCE(e."done", false) AND NOT EXISTS (SELECT 1 FROM "BookingPricing" q WHERE q."extraServiceId" = e."id" AND COALESCE(q."total", 0) > 0)`,
    `    AND COALESCE(e."price", 0) > 0) AS uncharged`,
    `  FROM "BookingExtraService" e WHERE e."bookingId" = b."id") ex ON TRUE`,
    `LEFT JOIN LATERAL (SELECT SUM(z."amount") AS amount, min(z."recordedAt") AS first_at`,
    `  FROM "BookingPricingPayment" z JOIN "BookingPricing" y ON y."id" = z."pricingId"`,
    `  WHERE y."bookingId" = b."id" AND (lower(COALESCE(z."paymentMethod"::text, '')) LIKE '%cash%' OR lower(COALESCE(z."paymentMethod"::text, '')) LIKE '%dinheiro%' OR lower(COALESCE(z."paymentMethod"::text, '')) LIKE '%numer%')) ca ON TRUE`,
    `LIMIT ${p.add(clean.length)}`,
  ].join("\n");
  return { sql, params: p.values };
}

const s = (v: unknown) => (v == null || v === "" ? null : String(v));
const n = (v: unknown) => { if (v == null || v === "") return null; const x = Number(v); return Number.isFinite(x) ? Math.round(x * 100) / 100 : null; };
const i = (v: unknown) => Math.round(Number(v ?? 0)) || 0;
const b = (v: unknown) => v === true || v === 1 || v === "1" || v === "t" || v === "true";

export function mapSweepExtrasRow(r: J): SweepExtras {
  return {
    id: String(r.id ?? ""),
    clientPlanId: s(r.client_plan_id), allowance: s(r.allowance), creditId: s(r.credit_id), checkOutDriverName: s(r.checkout_driver), hasNif: b(r.has_nif),
    disputed: b(r.disputed),
    cancellation: r.cx_at == null && r.cx_refund == null ? null : {
      at: toIsoUtc(r.cx_at), refund: b(r.cx_refund), refunded: b(r.cx_refunded), refundedAmount: n(r.cx_refunded_amount), hasTransaction: b(r.cx_has_tx),
    },
    billing: { count: i(r.billing_n), emitted: i(r.billing_emitted), amount: n(r.billing_amount), creditNotes: i(r.billing_credit_notes) },
    credit: { count: i(r.credit_n), value: n(r.credit_value) },
    paymentLinks: { failed: i(r.links_failed), succeeded: i(r.links_succeeded), received: n(r.links_received) },
    extras: { done: i(r.extras_done), doneUncharged: i(r.extras_uncharged) },
    cash: { amount: n(r.cash_amount), firstAt: toIsoUtc(r.cash_first_at) },
  };
}

export async function readSweepExtras(ids: readonly string[], query: Query = multiparkDbQuery): Promise<Map<string, SweepExtras>> {
  const out = new Map<string, SweepExtras>();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let k = 0; k < uniq.length; k += 1000) {
    const { sql, params } = buildSweepExtrasSql(uniq.slice(k, k + 1000));
    for (const r of await query<J>(sql, params)) { const m = mapSweepExtrasRow(r); out.set(m.id, m); }
  }
  return out;
}

// ─── 3. Permissões de dinheiro dos agentes (R26) ────────────────────────────

/** Permissões que mexem em dinheiro, caixa ou estado depois de fechado. */
export const MONEY_PERMISSIONS = [
  "allowEditBookingPrice", "allowEditPricingTotal", "allowEditPricingPaid", "allowEditPaymentMethod",
  "allowCreatePricingEntry", "allowDeletePricingEntry", "allowCashValidation", "allowDriverValidation", "allowCloseCashier",
  "allowCancelBooking", "allowChangeBookingStatusAfterDone", "allowMoveBookingToPartner", "allowMoveBookingToCampaign",
  "allowMoveBookingToAllowance", "allowEmitInvoice", "allowMarkExtraServiceAsDone", "allowCashboxView", "notifyOnPriceChange",
] as const;

export interface AgentPerms { agentId: string; parkId: string | null; name: string | null; role: string | null; perms: string[] }

/** Agentes dos parques dados, com as permissões de dinheiro que têm (só as chaves pedidas). PURA. */
export function buildAgentPermsSql(parkIds: readonly string[]): { sql: string; params: SqlParam[] } {
  if (!parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const keys = MONEY_PERMISSIONS.map((k) => p.add(k)).join(", ");
  const sql = [
    `SELECT a."id" AS id, a."parkId" AS park_id, NULLIF(a."name", '') AS name, a."role"::text AS role,`,
    `  (SELECT jsonb_object_agg(kv.key, kv.value) FROM jsonb_each(to_jsonb(a)) kv WHERE kv.key IN (${keys})) AS perms`,
    `FROM "Agent" a WHERE a."parkId" IN (${parkIds.map((id) => p.add(id)).join(", ")})`,
    `ORDER BY a."id" LIMIT ${p.add(5000)}`,
  ].join("\n");
  return { sql, params: p.values };
}

export function mapAgentPermsRow(r: J): AgentPerms {
  let perms: J = {};
  if (r.perms && typeof r.perms === "object") perms = r.perms;
  else if (typeof r.perms === "string") { try { perms = JSON.parse(r.perms); } catch { perms = {}; } }
  return {
    agentId: String(r.id ?? ""), parkId: s(r.park_id), name: s(r.name), role: s(r.role),
    perms: MONEY_PERMISSIONS.filter((k) => b(perms[k])),
  };
}

export async function readAgentPerms(parkIds: readonly string[], query: Query = multiparkDbQuery): Promise<AgentPerms[]> {
  if (!parkIds.length) return [];
  const { sql, params } = buildAgentPermsSql(parkIds);
  return (await query<J>(sql, params)).map(mapAgentPermsRow);
}

// ─── 4. Dinheiro recebido por parque (contagem da caixa, R24) ───────────────

/** Pagamentos em dinheiro registados em [start, end) (UTC) nos parques dados, por parque. PURA. */
export function buildCashReceivedSql(o: { parkIds: readonly string[]; start: string; end: string }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const sql = [
    `SELECT b."parkId" AS park_id, SUM(z."amount") AS amount, count(*) AS n`,
    `  FROM "BookingPricingPayment" z JOIN "BookingPricing" y ON y."id" = z."pricingId" JOIN "Booking" b ON b."id" = y."bookingId"`,
    ` WHERE b."parkId" IN (${o.parkIds.map((id) => p.add(id)).join(", ")})`,
    `   AND z."recordedAt" >= ${p.add(o.start)}::timestamp AND z."recordedAt" < ${p.add(o.end)}::timestamp`,
    `   AND (lower(COALESCE(z."paymentMethod"::text, '')) LIKE '%cash%' OR lower(COALESCE(z."paymentMethod"::text, '')) LIKE '%dinheiro%' OR lower(COALESCE(z."paymentMethod"::text, '')) LIKE '%numer%')`,
    ` GROUP BY 1 LIMIT ${p.add(o.parkIds.length)}`,
  ].join("\n");
  return { sql, params: p.values };
}

export async function readCashReceived(o: { parkIds: readonly string[]; start: string; end: string }, query: Query = multiparkDbQuery): Promise<Map<string, { amount: number; count: number }>> {
  if (!o.parkIds.length) return new Map();
  const { sql, params } = buildCashReceivedSql(o);
  return new Map((await query<J>(sql, params)).map((r) => [String(r.park_id), { amount: n(r.amount) ?? 0, count: i(r.n) }]));
}
