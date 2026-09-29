/**
 * Marketing — leitura AO VIVO da BD da Multipark (só leitura), em vez da
 * cópia `multipark_bookings` (Jorge, 28 set 2026).
 *
 * Duas leituras:
 *   1. RESERVAS criadas no período (sem canceladas), uma linha por reserva,
 *      com o que o marketing precisa: dia de Lisboa da criação, parque,
 *      origem, link de origem ("originUrl", de onde sai a atribuição
 *      Google/Meta), valor, parceiro/método/campanha, se o cliente tem email
 *      (fora os da casa) e se é a 1.ª reserva desse email (cliente novo);
 *   2. CLIENTES (por email, todo o histórico dos parques pedidos): 1.ª
 *      reserva (quando, origem, link, parceiro/campanha), n.º de reservas, n.º
 *      no período e valor realizado — para o "quanto vale um cliente de cada
 *      canal".
 * O email NUNCA sai da BD deles: só como md5 (chave de cliente) ou booleano.
 * Datas em UTC ("timestamp without time zone"); dia = o de Lisboa.
 * Regras de read.ts: SQL parametrizado, construtor PURO, LIMIT sempre.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList } from "./read";

export const MARKETING_BOOKINGS_LIMIT = 100_000;
export const MARKETING_CLIENTS_LIMIT = 200_000;

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export interface MarketingReadSpec {
  /** Instantes UTC "YYYY-MM-DD HH:MM:SS" — [start, end) (lisbonDayRangeUtc). */
  start: string;
  end: string;
  parkIds: string[];
  /** Domínios de email da casa (não contam como cliente). */
  internalDomains: readonly string[];
}

const lisbonDay = (col: string) => `to_char((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Lisbon', 'YYYY-MM-DD')`;
const ts = (col: string) => `to_char(${col}, 'YYYY-MM-DD HH24:MI:SS')`;
const clientOf = (b: string, c: string) => `LEFT JOIN "Client" ${c} ON ${c}."id" = COALESCE(${b}."customerId", ${b}."clientId")`;
/** Email normalizado do cliente, só se for um email de fora da casa (senão NULL). */
function emailExpr(p: ParamList, c: string, domains: readonly string[]): string {
  const doms = domains.length ? domains.map((d) => p.add(d.toLowerCase())).join(", ") : "''";
  return `CASE WHEN ${c}."email" LIKE '%@%' AND split_part(lower(trim(${c}."email")), '@', 2) NOT IN (${doms}) THEN lower(trim(${c}."email")) END`;
}

/** Reservas criadas no período (sem canceladas). PURA. */
export function buildMarketingBookingsSql(spec: MarketingReadSpec): { sql: string; params: SqlParam[] } {
  if (!spec.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const parks = spec.parkIds.map((id) => p.add(id)).join(", ");
  const s = p.add(spec.start);
  const e = p.add(spec.end);
  const em = emailExpr(p, "c", spec.internalDomains);
  const lim = p.add(MARKETING_BOOKINGS_LIMIT);
  const sql = [
    `WITH d AS (`,
    `  SELECT b."id" AS id, b."createdAt" AS created_at, b."parkId" AS park_id, b."status"::text AS status, b."origin"::text AS origin,`,
    `    NULLIF(trim(b."originUrl"), '') AS origin_url, b."partnerId" AS partner_id, NULLIF(b."paymentMethod", '') AS pm, b."campaignId" AS campaign_id,`,
    `    b."bookingPrice" AS price, ${em} AS em`,
    `  FROM "Booking" b`,
    `  ${clientOf("b", "c")}`,
    `  WHERE b."parkId" IN (${parks}) AND b."status"::text <> 'CANCELLED'`,
    `    AND b."createdAt" >= ${s}::timestamp AND b."createdAt" < ${e}::timestamp`,
    `  ORDER BY b."createdAt", b."id"`,
    `  LIMIT ${lim}`,
    `),`,
    `bp AS (SELECT y."bookingId" AS id, SUM(y."total") AS total, string_agg(DISTINCT NULLIF(y."paymentMethod", ''), ', ') AS pm`,
    `  FROM "BookingPricing" y WHERE y."bookingId" IN (SELECT d.id FROM d) GROUP BY y."bookingId"),`,
    // 1.ª reserva (não cancelada) de cada email, em todo o histórico destes parques
    `fb AS (SELECT lower(trim(c2."email")) AS em, MIN(x."createdAt") AS first_at FROM "Booking" x`,
    `  JOIN "Client" c2 ON c2."id" = COALESCE(x."customerId", x."clientId")`,
    `  WHERE x."parkId" IN (${parks}) AND x."status"::text <> 'CANCELLED' AND lower(trim(c2."email")) IN (SELECT d.em FROM d WHERE d.em IS NOT NULL)`,
    `  GROUP BY 1)`,
    `SELECT d.id, ${ts("d.created_at")} AS created_at, ${lisbonDay("d.created_at")} AS day, d.park_id, d.status, d.origin, d.origin_url,`,
    `  d.partner_id, NULLIF(pa."name", '') AS partner_name, COALESCE(d.pm, bp.pm) AS payment_method,`,
    `  NULLIF(ca."name", '') AS campaign_name, NULLIF(ca."discountCode", '') AS discount_code, COALESCE(bp.total, d.price) AS total,`,
    `  (d.em IS NOT NULL) AS has_email, (d.em IS NULL OR fb.first_at IS NULL OR d.created_at <= fb.first_at) AS new_client`,
    `FROM d`,
    `LEFT JOIN bp ON bp.id = d.id`,
    `LEFT JOIN fb ON fb.em = d.em`,
    `LEFT JOIN "Partner" pa ON pa."id" = d.partner_id`,
    `LEFT JOIN "Campaign" ca ON ca."id" = d.campaign_id`,
    `ORDER BY d.created_at, d.id`,
  ].join("\n");
  return { sql, params: p.values };
}

/** Estados em que o carro entrou (valor realizado do cliente). */
export const VISITED = ["CHECKED_IN", "CHECKING_OUT", "PENDING_CHECKOUT", "CHECKED_OUT"] as const;

/** Clientes (por email) de todo o histórico destes parques; período só para contar. PURA. */
export function buildMarketingClientsSql(spec: MarketingReadSpec): { sql: string; params: SqlParam[] } {
  if (!spec.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const parks = spec.parkIds.map((id) => p.add(id)).join(", ");
  const em = emailExpr(p, "c", spec.internalDomains);
  const s = p.add(spec.start);
  const e = p.add(spec.end);
  const visited = VISITED.map((v) => p.add(v)).join(", ");
  const lim = p.add(MARKETING_CLIENTS_LIMIT);
  const sql = [
    `WITH x AS (`,
    `  SELECT ${em} AS em, b."id" AS id, b."createdAt" AS created_at, b."status"::text AS status, b."origin"::text AS origin,`,
    `    NULLIF(trim(b."originUrl"), '') AS url, b."partnerId" AS partner_id, NULLIF(b."paymentMethod", '') AS pm, b."campaignId" AS campaign_id, b."bookingPrice" AS price`,
    `  FROM "Booking" b`,
    `  ${clientOf("b", "c")}`,
    `  WHERE b."parkId" IN (${parks}) AND b."status"::text <> 'CANCELLED'`,
    `),`,
    `y AS (SELECT * FROM x WHERE x.em IS NOT NULL),`,
    `f AS (SELECT DISTINCT ON (y.em) y.em, y.created_at, y.origin, y.url, y.partner_id, y.pm, y.campaign_id FROM y ORDER BY y.em, y.created_at, y.id),`,
    `bp AS (SELECT z."bookingId" AS id, SUM(z."total") AS total FROM "BookingPricing" z`,
    `  WHERE z."bookingId" IN (SELECT y.id FROM y WHERE y.status IN (${visited})) GROUP BY z."bookingId"),`,
    `a AS (SELECT y.em, count(*) AS n, count(*) FILTER (WHERE y.created_at >= ${s}::timestamp AND y.created_at < ${e}::timestamp) AS pn,`,
    `  SUM(CASE WHEN y.status IN (${visited}) THEN COALESCE(bp.total, y.price) END) AS value`,
    `  FROM y LEFT JOIN bp ON bp.id = y.id GROUP BY y.em)`,
    `SELECT md5(a.em) AS client_key, ${ts("f.created_at")} AS first_at, f.origin AS first_origin, f.url AS first_url,`,
    `  f.partner_id AS first_partner_id, NULLIF(pa."name", '') AS first_partner_name, f.pm AS first_payment_method,`,
    `  NULLIF(ca."name", '') AS first_campaign_name, NULLIF(ca."discountCode", '') AS first_discount_code,`,
    `  a.n AS bookings, a.pn AS period_bookings, a.value`,
    `FROM a JOIN f ON f.em = a.em`,
    `LEFT JOIN "Partner" pa ON pa."id" = f.partner_id`,
    `LEFT JOIN "Campaign" ca ON ca."id" = f.campaign_id`,
    `LIMIT ${lim}`,
  ].join("\n");
  return { sql, params: p.values };
}

// ─── Mapeadores ─────────────────────────────────────────────────────────────

export interface MarketingBookingRow {
  id: string;
  createdAt: string;
  day: string;
  parkId: string;
  status: string | null;
  origin: string | null;
  originUrl: string | null;
  partnerId: string | null;
  partnerName: string | null;
  paymentMethod: string | null;
  campaignName: string | null;
  discountCode: string | null;
  total: number;
  hasEmail: boolean;
  newClient: boolean;
}

export interface MarketingClientRow {
  clientKey: string;
  firstAt: string;
  firstOrigin: string | null;
  firstUrl: string | null;
  firstPartnerId: string | null;
  firstPartnerName: string | null;
  firstPaymentMethod: string | null;
  firstCampaignName: string | null;
  firstDiscountCode: string | null;
  bookings: number;
  periodBookings: number;
  value: number;
}

const txt = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());
const money = (v: unknown) => { const x = Number(v ?? 0); return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0; };
const bool = (v: unknown) => v === true || v === 1 || v === "1" || v === "t" || v === "true";
const int = (v: unknown) => Math.round(Number(v ?? 0)) || 0;

export function mapMarketingBookingRow(r: Record<string, unknown>): MarketingBookingRow {
  return {
    id: String(r.id ?? ""), createdAt: String(r.created_at ?? ""), day: String(r.day ?? "").slice(0, 10), parkId: String(r.park_id ?? ""),
    status: txt(r.status), origin: txt(r.origin), originUrl: txt(r.origin_url), partnerId: txt(r.partner_id), partnerName: txt(r.partner_name),
    paymentMethod: txt(r.payment_method), campaignName: txt(r.campaign_name), discountCode: txt(r.discount_code), total: money(r.total),
    hasEmail: bool(r.has_email), newClient: r.new_client == null ? true : bool(r.new_client),
  };
}

export function mapMarketingClientRow(r: Record<string, unknown>): MarketingClientRow {
  return {
    clientKey: String(r.client_key ?? ""), firstAt: String(r.first_at ?? ""), firstOrigin: txt(r.first_origin), firstUrl: txt(r.first_url),
    firstPartnerId: txt(r.first_partner_id), firstPartnerName: txt(r.first_partner_name), firstPaymentMethod: txt(r.first_payment_method),
    firstCampaignName: txt(r.first_campaign_name), firstDiscountCode: txt(r.first_discount_code),
    bookings: int(r.bookings), periodBookings: int(r.period_bookings), value: money(r.value),
  };
}

export async function readMarketingBookings(spec: MarketingReadSpec, query: Query = multiparkDbQuery): Promise<MarketingBookingRow[]> {
  const { sql, params } = buildMarketingBookingsSql(spec);
  return (await query<Record<string, unknown>>(sql, params)).map(mapMarketingBookingRow);
}

export async function readMarketingClients(spec: MarketingReadSpec, query: Query = multiparkDbQuery): Promise<MarketingClientRow[]> {
  const { sql, params } = buildMarketingClientsSql(spec);
  return (await query<Record<string, unknown>>(sql, params)).map(mapMarketingClientRow);
}
