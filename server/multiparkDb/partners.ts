/**
 * CRM fase 3 — PARCEIROS (agregadores e agências) e PARQUES em que somos o
 * agregador, lidos AO VIVO da BD da Multipark (só leitura; nada se copia —
 * Jorge: "faz só a parte do CRM; o operacional vem da BD deles").
 * Segue as regras de read.ts: SQL parametrizado, construtores e mapeadores
 * PUROS, LIMIT sempre, nunca lança.
 *
 * Modelo (Jorge, 27 set 2026 — memória parceiros-modelo-negocio):
 *   - agregadores cobram o cliente e ficam com a percentagem deles (25–30 %);
 *     no fim do mês mandamos-lhes o extrato e faturamos o resto (o NOSSO);
 *   - agências: pomos nós a percentagem e vão pagando;
 *   - a comissão deles é margem, não custo; o mês é o da ENTRADA do carro.
 * Na reserva (perfil 27 set): "partnerContributedAmount" = o que o parceiro
 * recebeu do cliente; "partnerAmountDue" = o que fica para nós (ex.: 402 €
 * a 25 % → 301,50 €); comissão deles = contribuído − devido.
 *
 * Um parceiro = uma empresa ("Partner".userId) com uma linha por parque
 * ("Partner".id, com a sua percentagem). Só contam os parceiros dos NOSSOS
 * parques; os parques que não são nossos (marketplace) são as "parcerias em
 * que nós agregamos" — com a nossa comissão ("commissionAmount").
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, cityAliases, safeMultiparkRead, type MultiparkRead } from "./read";
import { classifyPark, marketplaceOperated } from "../../shared/multiparkParks";
import { lisbonMonth } from "../../shared/crmPro";
import { MARKETPLACE_COMMISSIONED_SQL } from "./marketplaceSql";
import type { CityKey } from "../../shared/city";

const ts = (expr: string) => `to_char(${expr}, 'YYYY-MM-DD HH24:MI:SS')`;
/** Mês (Lisboa) da entrada — a BD grava UTC. */
const MONTH = `to_char((b."checkIn" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Lisbon', 'YYYY-MM')`;
/** Reserva que conta: nem cancelada nem pendente (PENDING = compra online por acabar). */
const LIVE = `b."status"::text NOT IN ('CANCELLED', 'PENDING')`;
const CANCELLED = `b."status"::text = 'CANCELLED'`;
/** Valor da reserva para o parceiro: o que ele recebeu; sem isso, o preço. */
const VALUE = `COALESCE(b."partnerContributedAmount", b."bookingPrice")`;
/**
 * O NOSSO: o devido gravado; sem ele, pela taxa gravada na reserva
 * (percentagem ou valor fixo). NULL = não se sabe (conta como incompleta).
 */
const OURS = `COALESCE(b."partnerAmountDue", CASE
    WHEN b."partnerFeeType"::text = 'PERCENTAGE' AND b."partnerFeeValue" IS NOT NULL THEN ${VALUE} * (1 - b."partnerFeeValue" / 100.0)
    WHEN b."partnerFeeType"::text = 'FIXED' AND b."partnerFeeValue" IS NOT NULL THEN ${VALUE} - b."partnerFeeValue"
  END)`;
/**
 * Reservas que NÓS levámos a um parque que não é nosso (marketplace, com a
 * nossa comissão) — o fragmento único de marketplaceSql.ts. Aqui serve a
 * comissão e os "clientes nossos" (CRM, pesquisa), não as listas do Marketplace.
 */
export const OUR_SALE = MARKETPLACE_COMMISSIONED_SQL;
export const PARTNER_ROWS_LIMIT = 5000;
export const RECENT_LIMIT = 200;

type Row = Record<string, unknown>;
type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

// ─── SQL (PURO) ─────────────────────────────────────────────────────────────

export function buildParksFullSql(): { sql: string; params: SqlParam[] } {
  return {
    sql: [
      `SELECT p."id" AS id, p."userId" AS owner_user_id, p."name" AS name, NULLIF(p."companyName", '') AS company_name,`,
      `  NULLIF(p."email", '') AS email, NULLIF(p."phoneNumber", '') AS phone, NULLIF(p."address", '') AS address, p."city" AS city,`,
      `  NULLIF(p."country", '') AS country, NULLIF(p."nif", '') AS nif, NULLIF(p."taxName", '') AS tax_name, NULLIF(p."taxAddress", '') AS tax_address,`,
      `  NULLIF(p."website", '') AS website, NULLIF(p."firebaseBrand", '') AS firebase_brand, p."listingType"::text AS listing_type,`,
      `  p."status"::text AS status, ${ts(`p."createdAt"`)} AS created_at, p."totalSpots" AS total_spots`,
      `FROM "Park" p ORDER BY p."name" LIMIT 500`,
    ].join("\n"),
    params: [],
  };
}

export function buildPartnersSql(): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const lim = p.add(PARTNER_ROWS_LIMIT);
  return {
    sql: [
      `SELECT pa."id" AS partner_id, pa."userId" AS user_id, pa."parkId" AS park_id, NULLIF(pa."name", '') AS name, pa."isActive" AS active,`,
      `  pa."feeType"::text AS fee_type, pa."feePercentage" AS fee_pct, pa."feeFixedValue" AS fee_fixed, pa."partnerType"::text AS partner_type,`,
      `  NULLIF(pa."taxName", '') AS tax_name, NULLIF(pa."taxNumber", '') AS tax_number, NULLIF(pa."taxAddress", '') AS tax_address,`,
      `  ${ts(`pa."createdAt"`)} AS created_at`,
      `FROM "Partner" pa ORDER BY pa."createdAt" LIMIT ${lim}`,
    ].join("\n"),
    params: p.values,
  };
}

/** Reservas de parceiros por (linha "Partner", mês de entrada) desde `since` (UTC). */
export function buildPartnerMonthsSql(since: string, partnerIds?: string[]): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const s = p.add(since);
  const only = partnerIds?.length ? `AND b."partnerId" IN (${partnerIds.map((id) => p.add(id)).join(", ")})` : `AND b."partnerId" IS NOT NULL`;
  const lim = p.add(50_000);
  return {
    sql: [
      `SELECT b."partnerId" AS partner_id, ${MONTH} AS month, count(*) FILTER (WHERE ${LIVE}) AS bookings, count(*) FILTER (WHERE ${CANCELLED}) AS cancelled,`,
      `  SUM(CASE WHEN ${LIVE} THEN ${VALUE} END) AS value,`,
      // comissão deles = valor − nosso (só onde o nosso se sabe)
      `  SUM(CASE WHEN ${LIVE} AND ${OURS} IS NOT NULL THEN ${VALUE} - ${OURS} END) AS commission,`,
      `  SUM(CASE WHEN ${LIVE} THEN ${OURS} END) AS ours,`,
      `  count(*) FILTER (WHERE ${LIVE} AND ${OURS} IS NULL) AS incomplete,`,
      `  SUM(CASE WHEN ${LIVE} THEN b."partnerAmountPaid" END) AS paid`,
      `FROM "Booking" b`,
      `WHERE b."checkIn" >= ${s}::timestamp ${only}`,
      `GROUP BY 1, 2`,
      `LIMIT ${lim}`,
    ].join("\n"),
    params: p.values,
  };
}

/** Reservas por (parque, mês de entrada) desde `since` — só os parques pedidos. */
export function buildParkMonthsSql(since: string, parkIds: string[]): { sql: string; params: SqlParam[] } {
  if (!parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const s = p.add(since);
  const parks = parkIds.map((id) => p.add(id)).join(", ");
  const lim = p.add(50_000);
  return {
    sql: [
      `SELECT b."parkId" AS park_id, ${MONTH} AS month, count(*) FILTER (WHERE ${LIVE}) AS bookings, count(*) FILTER (WHERE ${CANCELLED}) AS cancelled,`,
      `  SUM(CASE WHEN ${LIVE} THEN b."bookingPrice" END) AS value,`,
      `  SUM(CASE WHEN ${LIVE} THEN b."commissionAmount" END) AS commission`,
      `FROM "Booking" b`,
      // só as reservas que NÓS lhes levámos (o parque pode ter operação própria)
      `WHERE b."parkId" IN (${parks}) AND b."checkIn" >= ${s}::timestamp AND ${OUR_SALE}`,
      `GROUP BY 1, 2`,
      `LIMIT ${lim}`,
    ].join("\n"),
    params: p.values,
  };
}

/** Últimas reservas de um conjunto de linhas "Partner" ou de parques. */
export function buildRecentBookingsSql(by: { partnerIds?: string[]; parkIds?: string[] }, limit = RECENT_LIMIT): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const conds: string[] = [];
  if (by.partnerIds?.length) conds.push(`b."partnerId" IN (${by.partnerIds.map((id) => p.add(id)).join(", ")})`);
  // parque que não é nosso: só as reservas que nós levámos
  if (by.parkIds?.length) conds.push(`b."parkId" IN (${by.parkIds.map((id) => p.add(id)).join(", ")})`, OUR_SALE);
  if (!conds.length) throw new Error("Sem filtro.");
  // "últimas" = já entraram (as futuras vinham primeiro)
  // checkIn é UTC sem fuso: comparar com a hora UTC explícita (não depende do fuso da sessão)
  conds.push(`b."checkIn" <= (now() AT TIME ZONE 'UTC')`);
  const lim = p.add(Math.min(Math.max(Math.floor(limit), 1), RECENT_LIMIT));
  return {
    sql: [
      `SELECT b."id" AS id, NULLIF(b."allocation", '') AS code, b."status"::text AS status,`,
      `  ${ts(`b."checkIn"`)} AS check_in, ${ts(`b."checkOut"`)} AS check_out, b."parkId" AS park_id, b."partnerId" AS partner_id,`,
      `  b."bookingPrice" AS booking_price, ${VALUE} AS value, ${OURS} AS ours, b."partnerAmountPaid" AS paid,`,
      `  b."partnerFeeType"::text AS fee_type, b."partnerFeeValue" AS fee_value, b."commissionAmount" AS commission_amount, b."origin"::text AS origin,`,
      `  NULLIF(TRIM(CONCAT(c."firstName", ' ', c."lastName")), '') AS client_name, NULLIF(v."licensePlate", '') AS plate`,
      `FROM "Booking" b`,
      `LEFT JOIN "Client" c ON c."id" = COALESCE(b."customerId", b."clientId")`,
      `LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
      `WHERE ${conds.join(" AND ")}`,
      `ORDER BY b."checkIn" DESC`,
      `LIMIT ${lim}`,
    ].join("\n"),
    params: p.values,
  };
}

// ─── Mapeadores (PUROS) ─────────────────────────────────────────────────────

export interface ParkOut {
  id: string; name: string; companyName: string | null; email: string | null; phone: string | null; address: string | null;
  city: string | null; country: string | null; nif: string | null; taxName: string | null; taxAddress: string | null; website: string | null;
  status: string | null; listingType: string | null; ours: boolean; ownerUserId: string | null; createdAt: string | null; totalSpots: number | null;
  /** 8 out 2026: cidade reconhecida (resolveParkCity — "Prior Velho" → Lisboa); conta para o âmbito de cidade. */
  cityKey: CityKey | null;
  /** 8 out 2026: operado por nós (os nossos sempre; os de terceiros fora da lista do dono) — etiqueta da comissão. */
  operated: boolean;
}

export function mapParks(rows: Row[]): ParkOut[] {
  return rows.filter((r) => str(r.id)).map((r) => {
    const name = str(r.name) ?? String(r.id);
    const cls = classifyPark({ name, city: str(r.city), address: str(r.address), firebaseBrand: str(r.firebase_brand), listingType: str(r.listing_type) });
    return {
      id: String(r.id), name, companyName: str(r.company_name), email: str(r.email), phone: str(r.phone), address: str(r.address),
      city: str(r.city), country: str(r.country), nif: str(r.nif), taxName: str(r.tax_name), taxAddress: str(r.tax_address), website: str(r.website),
      status: str(r.status), listingType: str(r.listing_type), ours: cls.ours, ownerUserId: str(r.owner_user_id), createdAt: str(r.created_at),
      totalSpots: num(r.total_spots), cityKey: cls.city, operated: marketplaceOperated({ id: String(r.id), name, ours: cls.ours }),
    };
  });
}

/**
 * Cidade dentro do âmbito (undefined = todas; sem cidade só para quem vê
 * todas). `cityKey` = a cidade reconhecida do parque (resolveParkCity), para
 * um parque com "Prior Velho" na cidade ser visto por quem vê Lisboa. PURA.
 */
export function inCities(city: string | null | undefined, cities: string[] | undefined, cityKey?: CityKey | null): boolean {
  if (cities === undefined) return true;
  const allowed = new Set(cityAliases(cities));
  if (cityKey && allowed.has(cityKey)) return true;
  if (!city) return false;
  return allowed.has(city.trim().toLowerCase());
}

export type PartnerKind = "AGGREGATOR" | "AGENCY" | "PARTNER";
export interface PartnerParkOut { partnerId: string; parkId: string; parkName: string; city: string | null; feeType: string | null; feePct: number | null; feeFixed: number | null; active: boolean }
export interface PartnerOut {
  userId: string; name: string; type: PartnerKind; active: boolean; taxName: string | null; taxNumber: string | null; taxAddress: string | null;
  parks: PartnerParkOut[]; since: string | null;
}

const TYPE_ORDER: PartnerKind[] = ["AGGREGATOR", "AGENCY", "PARTNER"];

/**
 * Linhas "Partner" → uma empresa por userId, só com os NOSSOS parques dentro
 * do âmbito. PURA.
 */
export function groupPartners(rows: Row[], parks: ParkOut[], cities: string[] | undefined): PartnerOut[] {
  const parkOf = new Map(parks.map((p) => [p.id, p]));
  const out = new Map<string, PartnerOut & { types: Map<PartnerKind, number> }>();
  for (const r of rows) {
    const userId = str(r.user_id), partnerId = str(r.partner_id), parkId = str(r.park_id);
    if (!userId || !partnerId || !parkId) continue;
    const park = parkOf.get(parkId);
    if (!park || !park.ours || !inCities(park.city, cities, park.cityKey)) continue;
    let g = out.get(userId);
    if (!g) {
      g = { userId, name: "", type: "AGENCY", active: false, taxName: null, taxNumber: null, taxAddress: null, parks: [], since: null, types: new Map() };
      out.set(userId, g);
    }
    const t = (str(r.partner_type) ?? "AGENCY").toUpperCase() as PartnerKind;
    g.types.set(t, (g.types.get(t) ?? 0) + 1);
    if (!g.name) g.name = str(r.name) ?? "";
    g.taxName = g.taxName ?? str(r.tax_name);
    g.taxNumber = g.taxNumber ?? str(r.tax_number);
    g.taxAddress = g.taxAddress ?? str(r.tax_address);
    const created = str(r.created_at);
    if (created && (!g.since || created < g.since)) g.since = created;
    const active = bool(r.active);
    if (active) g.active = true;
    g.parks.push({ partnerId, parkId, parkName: park.name, city: park.city, feeType: str(r.fee_type), feePct: num(r.fee_pct), feeFixed: num(r.fee_fixed), active });
  }
  return [...out.values()].map(({ types, ...g }) => {
    // tipo mais frequente (empate: agregador > agência > parceiro)
    const type = [...types.entries()].sort((a, b) => b[1] - a[1] || TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]))[0]?.[0] ?? "AGENCY";
    return { ...g, type, name: g.name || g.taxName || "Parceiro sem nome", parks: g.parks.sort((a, b) => a.parkName.localeCompare(b.parkName, "pt")) };
  }).sort((a, b) => a.name.localeCompare(b.name, "pt"));
}

/** `bookings` = as que contam (sem canceladas nem pendentes); `incomplete` = sem o nosso nem taxa gravados. */
export interface MonthTotals { month: string; bookings: number; cancelled: number; value: number; commission: number; ours: number; paid: number; incomplete: number }

/** Linhas mensais (por linha Partner ou parque) → somadas por grupo e mês. PURA. */
export function sumMonths(rows: Row[], groupOf: (r: Row) => string | null): Map<string, MonthTotals[]> {
  const acc = new Map<string, Map<string, MonthTotals>>();
  for (const r of rows) {
    const g = groupOf(r), month = str(r.month);
    if (!g || !month) continue;
    const byMonth = acc.get(g) ?? new Map<string, MonthTotals>();
    acc.set(g, byMonth);
    const m = byMonth.get(month) ?? { month, bookings: 0, cancelled: 0, value: 0, commission: 0, ours: 0, paid: 0, incomplete: 0 };
    m.bookings += num(r.bookings) ?? 0;
    m.cancelled += num(r.cancelled) ?? 0;
    m.incomplete += num(r.incomplete) ?? 0;
    m.value = round(m.value + (num(r.value) ?? 0));
    m.commission = round(m.commission + (num(r.commission) ?? 0));
    m.ours = round(m.ours + (num(r.ours) ?? 0));
    m.paid = round(m.paid + (num(r.paid) ?? 0));
    byMonth.set(month, m);
  }
  return new Map([...acc.entries()].map(([g, byMonth]) => [g, [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month))]));
}

/** Totais de um conjunto de meses (este mês / últimos 12). PURA. */
export function totalsOf(months: MonthTotals[], from: string, to?: string): Omit<MonthTotals, "month"> {
  const t = { bookings: 0, cancelled: 0, value: 0, commission: 0, ours: 0, paid: 0, incomplete: 0 };
  for (const m of months) {
    if (m.month < from || (to && m.month > to)) continue;
    t.bookings += m.bookings; t.cancelled += m.cancelled; t.incomplete += m.incomplete;
    t.value = round(t.value + m.value); t.commission = round(t.commission + m.commission);
    t.ours = round(t.ours + m.ours); t.paid = round(t.paid + m.paid);
  }
  return t;
}

export interface RecentBooking {
  id: string; code: string | null; status: string | null; checkIn: string | null; checkOut: string | null; parkId: string | null;
  partnerId: string | null; price: number | null; value: number | null; commission: number | null; ours: number | null; paid: number | null;
  /** taxa do parceiro gravada na reserva: PERCENTAGE (%) ou FIXED (€) */
  feeType: string | null; feeValue: number | null;
  marketplaceCommission: number | null; origin: string | null; clientName: string | null; plate: string | null;
}

export function mapRecent(rows: Row[]): RecentBooking[] {
  return rows.filter((r) => str(r.id)).map((r) => {
    const value = num(r.value) ?? num(r.booking_price), ours = num(r.ours);
    return {
      id: String(r.id), code: str(r.code), status: str(r.status), checkIn: str(r.check_in), checkOut: str(r.check_out),
      parkId: str(r.park_id), partnerId: str(r.partner_id), price: roundN(num(r.booking_price)),
      value: roundN(value), commission: value != null && ours != null ? round(value - ours) : null,
      ours: roundN(ours), paid: roundN(num(r.paid)), feeType: str(r.fee_type), feeValue: num(r.fee_value),
      marketplaceCommission: roundN(num(r.commission_amount)),
      origin: str(r.origin), clientName: str(r.client_name), plate: str(r.plate),
    };
  });
}

// ─── Leituras (nunca lançam) ────────────────────────────────────────────────

/** Mês "AAAA-MM" de Lisboa de há `n` meses (1.º dia) e o instante UTC para o filtro. PURA. */
export function monthsAgo(n: number, now = new Date()): { month: string; since: string } {
  // a partir do mês de LISBOA (no fim do mês, a hora UTC ainda está no mês anterior)
  const [ly, lm] = (lisbonMonth(now) ?? now.toISOString().slice(0, 7)).split("-").map(Number);
  const d = new Date(Date.UTC(ly, lm - 1 - n, 1));
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  // 1 dia de folga (Lisboa está à frente de UTC): o mês certo vem do agrupamento
  const since = new Date(d.getTime() - 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  return { month, since };
}

/** Cache curta (90 s) das listas: cada tecla na procura voltava a ler a BD deles. */
const CACHE_MS = 90_000;
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, query: Query, fn: () => Promise<MultiparkRead<T>>): Promise<MultiparkRead<T>> {
  if (query !== multiparkDbQuery) return fn(); // testes
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as MultiparkRead<T>;
  const v = await fn();
  if (v.available) cache.set(key, { at: Date.now(), value: v });
  return v;
}

/** Parceiro visível a quem pede (âmbito de cidade)? — leitura leve, para autorizar. */
export async function readPartnerVisible(userId: string, cities: string[] | undefined, query: Query = multiparkDbQuery) {
  return safeMultiparkRead("parceiro (âmbito)", async () => {
    const parks = mapParks(await query(buildParksFullSql().sql));
    const pr = buildPartnersSql();
    return groupPartners(await query(pr.sql, pr.params), parks, cities).some((p) => p.userId === userId);
  });
}

/** Parque (que não é nosso) visível a quem pede? — leitura leve, para autorizar. */
export async function readParkVisible(parkId: string, cities: string[] | undefined, query: Query = multiparkDbQuery) {
  return safeMultiparkRead("parque (âmbito)", async () =>
    mapParks(await query(buildParksFullSql().sql)).some((p) => p.id === parkId && !p.ours && inCities(p.city, cities, p.cityKey)));
}

export async function readPartnersOverview(cities: string[] | undefined, query: Query = multiparkDbQuery) {
  return cached(`partners|${JSON.stringify(cities ?? null)}`, query, () => readPartnersOverviewNow(cities, query));
}

async function readPartnersOverviewNow(cities: string[] | undefined, query: Query) {
  return safeMultiparkRead("parceiros", async () => {
    const parks = mapParks(await query(buildParksFullSql().sql));
    const pr = buildPartnersSql();
    const partners = groupPartners(await query(pr.sql, pr.params), parks, cities);
    const { since } = monthsAgo(12);
    const ms = buildPartnerMonthsSql(since);
    const userOfPartner = new Map(partners.flatMap((p) => p.parks.map((x) => [x.partnerId, p.userId] as const)));
    const months = sumMonths(await query(ms.sql, ms.params), (r) => userOfPartner.get(String(r.partner_id ?? "")) ?? null);
    return { partners, months };
  });
}

export async function readPartnerDetail(userId: string, cities: string[] | undefined, query: Query = multiparkDbQuery) {
  return safeMultiparkRead("parceiro", async () => {
    const parks = mapParks(await query(buildParksFullSql().sql));
    const pr = buildPartnersSql();
    const partner = groupPartners(await query(pr.sql, pr.params), parks, cities).find((p) => p.userId === userId) ?? null;
    if (!partner) return null;
    const ids = partner.parks.map((p) => p.partnerId);
    const { since } = monthsAgo(24);
    const ms = buildPartnerMonthsSql(since, ids);
    const months = sumMonths(await query(ms.sql, ms.params), () => userId).get(userId) ?? [];
    const rb = buildRecentBookingsSql({ partnerIds: ids });
    const recent = mapRecent(await query(rb.sql, rb.params));
    return { partner, months, recent, parks };
  });
}

export async function readParksOverview(cities: string[] | undefined, query: Query = multiparkDbQuery) {
  return cached(`parks|${JSON.stringify(cities ?? null)}`, query, () => readParksOverviewNow(cities, query));
}

async function readParksOverviewNow(cities: string[] | undefined, query: Query) {
  return safeMultiparkRead("parques", async () => {
    const all = mapParks(await query(buildParksFullSql().sql));
    const parks = all.filter((p) => !p.ours && inCities(p.city, cities, p.cityKey));
    if (!parks.length) return { parks, months: new Map<string, MonthTotals[]>() };
    const { since } = monthsAgo(12);
    const ms = buildParkMonthsSql(since, parks.map((p) => p.id));
    const months = sumMonths(await query(ms.sql, ms.params), (r) => str(r.park_id));
    return { parks, months };
  });
}

export async function readParkDetail(parkId: string, cities: string[] | undefined, query: Query = multiparkDbQuery) {
  return safeMultiparkRead("parque", async () => {
    const park = mapParks(await query(buildParksFullSql().sql)).find((p) => p.id === parkId && !p.ours && inCities(p.city, cities, p.cityKey)) ?? null;
    if (!park) return null;
    const { since } = monthsAgo(24);
    const ms = buildParkMonthsSql(since, [parkId]);
    const months = sumMonths(await query(ms.sql, ms.params), () => parkId).get(parkId) ?? [];
    const rb = buildRecentBookingsSql({ parkIds: [parkId] });
    const recent = mapRecent(await query(rb.sql, rb.params));
    return { park, months, recent };
  });
}

// ─── Ajudantes ──────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "t" || v === "true";
}
const round = (n: number) => Math.round(n * 100) / 100;
const roundN = (n: number | null) => (n == null ? null : round(n));

export type { MultiparkRead };
