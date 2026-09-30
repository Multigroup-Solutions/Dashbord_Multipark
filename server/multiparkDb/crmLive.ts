/**
 * CRM — leituras AO VIVO da BD da Multipark (só leitura). Substituem a cópia
 * `multipark_bookings` no CRM (fase 1, Jorge 29 set 2026): na nossa BD fica
 * só o que é do CRM (fichas, contactos, carros, ligação reserva → ficha e um
 * RESUMO por ficha) — nenhuma cópia de reservas.
 *
 * "Os nossos clientes" (Jorge: "o CRM é para todos os nossos clientes,
 * independentemente de onde venham"): reservas dos NOSSOS parques + as que
 * nós vendemos noutros parques (marketplace). As compras online por acabar
 * (PENDING) não contam.
 *
 * Regras de read.ts: SQL parametrizado, construtores PUROS, LIMIT sempre.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, likeContains } from "./read";
import { OUR_SALE } from "./partners";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export const CRM_LIVE_MAX_IDS = 1000;
export const CRM_RULE_MAX_BOOKINGS = 50_000;

const ts = (col: string) => `to_char(${col}, 'YYYY-MM-DD HH24:MI:SS')`;
/** Cliente da reserva (quem viajou/reservou). */
const CLIENT_JOIN = `LEFT JOIN "Client" c ON c."id" = COALESCE(b."customerId", b."clientId")`;

/** Reserva de um cliente nosso: parque nosso ou venda nossa noutro parque; sem compras por acabar. PURA. */
export function ourClientBookingSql(p: ParamList, ourParkIds: readonly string[]): string {
  const parks = ourParkIds.length ? `b."parkId" IN (${ourParkIds.map((id) => p.add(id)).join(", ")})` : "FALSE";
  return `(${parks} OR ${OUR_SALE}) AND b."status"::text <> 'PENDING'`;
}

// ─── Carga das fichas (crm-sync): reservas alteradas desde o cursor ─────────

export interface CrmCursor { at: string; id: string }

/**
 * Reservas alteradas depois do cursor ("updatedAt", id), com o cliente, o
 * carro e o parceiro. 2 min de folga (uma gravação a meio não fica para trás). PURA.
 */
const CRM_BATCH_SELECT = [
  `SELECT b."id" AS id, c."firstName" AS first_name, c."lastName" AS last_name, c."email" AS email, c."phoneNumber" AS phone,`,
  `       c."nif" AS nif, v."licensePlate" AS plate, v."brand" AS brand, v."model" AS model, v."color" AS color, v."vehicleType"::text AS vehicle_type,`,
  `       b."partnerId" AS partner_id, NULLIF(pa."name", '') AS partner_name, COALESCE(b."pro", false) AS pro, b."origin"::text AS origin,`,
  `       ${ts(`COALESCE(b."createdAt", b."checkIn")`)} AS seen_at, to_char(b."updatedAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS cursor_at`,
  `  FROM "Booking" b`,
  `  ${CLIENT_JOIN}`,
  `  LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
  `  LEFT JOIN "Partner" pa ON pa."id" = b."partnerId"`,
];

/** As mesmas colunas do lote, só para as reservas dadas (as do webhook). PURA. */
export function buildCrmRowsByIdsSql(o: { ids: readonly string[]; ourParkIds: readonly string[] }): { sql: string; params: SqlParam[] } {
  const ids = [...new Set(o.ids.filter(Boolean))].slice(0, CRM_LIVE_MAX_IDS);
  if (!ids.length) throw new Error("Sem reservas.");
  const p = new ParamList();
  const list = ids.map((id) => p.add(id)).join(", ");
  const ours = ourClientBookingSql(p, o.ourParkIds);
  return {
    sql: [...CRM_BATCH_SELECT, ` WHERE b."id" IN (${list})`, `   AND ${ours}`, ` LIMIT ${p.add(ids.length)}`].join("\n"),
    params: p.values,
  };
}

export function buildCrmBatchSql(o: { cursor: CrmCursor; limit: number; ourParkIds: readonly string[] }): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const at = p.add(o.cursor.at);
  const id = p.add(o.cursor.id);
  const ours = ourClientBookingSql(p, o.ourParkIds);
  const lim = p.add(Math.min(Math.max(Math.floor(o.limit), 1), 3000));
  const sql = [
    ...CRM_BATCH_SELECT,
    ` WHERE (b."updatedAt", b."id") > (${at}::timestamp, ${id})`,
    `   AND b."updatedAt" < (now() AT TIME ZONE 'UTC') - interval '2 minutes'`,
    `   AND ${ours}`,
    ` ORDER BY b."updatedAt", b."id"`,
    ` LIMIT ${lim}`,
  ].join("\n");
  return { sql, params: p.values };
}

export interface CrmBatchRow {
  id: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null; nif: string | null;
  plate: string | null; brand: string | null; model: string | null; color: string | null; vehicleType: string | null;
  partnerId: string | null; partnerName: string | null; pro: boolean; origin: string | null; seenAt: string | null; cursorAt: string;
}

const s = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());
const b = (v: unknown) => v === true || v === 1 || v === "1" || v === "t" || v === "true";
const n = (v: unknown) => { const x = Number(v ?? 0); return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0; };

export function mapCrmBatchRow(r: Record<string, unknown>): CrmBatchRow {
  return {
    id: String(r.id ?? ""), firstName: s(r.first_name), lastName: s(r.last_name), email: s(r.email), phone: s(r.phone), nif: s(r.nif),
    plate: s(r.plate), brand: s(r.brand), model: s(r.model), color: s(r.color), vehicleType: s(r.vehicle_type),
    partnerId: s(r.partner_id), partnerName: s(r.partner_name), pro: b(r.pro), origin: s(r.origin), seenAt: s(r.seen_at),
    cursorAt: String(r.cursor_at ?? ""),
  };
}

// ─── Factos de reservas (métricas da ficha e lista da ficha) ────────────────

/** As reservas pedidas (por id), com o que a ficha mostra e o resumo precisa. PURA. */
export function buildCrmBookingFactsSql(ids: readonly string[]): { sql: string; params: SqlParam[] } {
  const clean = [...new Set(ids.map((x) => String(x ?? "").trim()).filter(Boolean))].slice(0, CRM_LIVE_MAX_IDS);
  if (!clean.length) throw new Error("Sem reservas.");
  const p = new ParamList();
  const list = clean.map((x) => p.add(x)).join(", ");
  const sql = [
    `SELECT b."id" AS id, NULLIF(b."allocation"::text, '') AS code, b."status"::text AS status,`,
    `       ${ts(`b."checkIn"`)} AS check_in, ${ts(`b."checkOut"`)} AS check_out, ${ts(`b."createdAt"`)} AS created_at, ${ts(`cx.at`)} AS cancelled_at,`,
    `       pk."name" AS park_name, pk."city" AS city, b."origin"::text AS origin, b."partnerId" AS partner_id, NULLIF(pa."name", '') AS partner_name,`,
    `       COALESCE(b."pro", false) AS pro, v."licensePlate" AS plate, NULLIF(b."returnFlight", '') AS return_flight, NULLIF(b."departingFlight", '') AS departing_flight,`,
    `       NULLIF(b."deliveryType", '') AS delivery_type, NULLIF(b."checkInDriverName", '') AS checkin_agent, NULLIF(b."checkOutDriverName", '') AS checkout_agent,`,
    `       COALESCE(NULLIF(b."paymentMethod", ''), bp.pm) AS payment_method,`,
    `       COALESCE(bp.total, b."bookingPrice") AS total, bp.paid AS paid, GREATEST(COALESCE(bp.total, b."bookingPrice") - COALESCE(bp.paid, 0), 0) AS remaining`,
    `  FROM "Booking" b`,
    `  LEFT JOIN "Park" pk ON pk."id" = b."parkId"`,
    `  LEFT JOIN "Partner" pa ON pa."id" = b."partnerId"`,
    `  LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
    `  LEFT JOIN LATERAL (SELECT SUM(y."total") AS total, SUM(y."amountPaid") AS paid, string_agg(DISTINCT NULLIF(y."paymentMethod", ''), ', ') AS pm`,
    `    FROM "BookingPricing" y WHERE y."bookingId" = b."id") bp ON TRUE`,
    `  LEFT JOIN LATERAL (SELECT x."createdAt" AS at FROM "Cancellation" x WHERE x."bookingId" = b."id" ORDER BY x."createdAt" DESC LIMIT 1) cx ON TRUE`,
    ` WHERE b."id" IN (${list})`,
    ` LIMIT ${p.add(clean.length)}`,
  ].join("\n");
  return { sql, params: p.values };
}

export interface CrmBookingFact {
  id: string; code: string | null; status: string | null; checkIn: string | null; checkOut: string | null; createdAt: string | null;
  cancelledAt: string | null; parkName: string | null; city: string | null; origin: string | null; partnerId: string | null;
  partnerName: string | null; pro: boolean; plate: string | null; flight: string | null; deliveryType: string | null;
  checkinAgent: string | null; checkoutAgent: string | null; paymentMethod: string | null; total: number; paid: number | null; remaining: number;
}

export function mapCrmBookingFact(r: Record<string, unknown>): CrmBookingFact {
  return {
    id: String(r.id ?? ""), code: s(r.code), status: s(r.status), checkIn: s(r.check_in), checkOut: s(r.check_out), createdAt: s(r.created_at),
    cancelledAt: s(r.cancelled_at), parkName: s(r.park_name), city: s(r.city), origin: s(r.origin), partnerId: s(r.partner_id),
    partnerName: s(r.partner_name), pro: b(r.pro), plate: s(r.plate), flight: s(r.return_flight) ?? s(r.departing_flight),
    deliveryType: s(r.delivery_type), checkinAgent: s(r.checkin_agent), checkoutAgent: s(r.checkout_agent), paymentMethod: s(r.payment_method),
    total: n(r.total), paid: r.paid == null ? null : n(r.paid), remaining: n(r.remaining),
  };
}

/** Factos de muitas reservas (em blocos de 1000). Lança se a BD da Multipark falhar. */
export async function readCrmBookingFacts(ids: readonly string[], query: Query = multiparkDbQuery): Promise<CrmBookingFact[]> {
  const uniq = [...new Set(ids.filter(Boolean))];
  const out: CrmBookingFact[] = [];
  for (let i = 0; i < uniq.length; i += CRM_LIVE_MAX_IDS) {
    const { sql, params } = buildCrmBookingFactsSql(uniq.slice(i, i + CRM_LIVE_MAX_IDS));
    out.push(...(await query<Record<string, unknown>>(sql, params)).map(mapCrmBookingFact));
  }
  return out;
}

// ─── Emails genéricos (usados por muitos nomes diferentes) ──────────────────

/** Emails de reservas nossas com ≥ `minNames` nomes diferentes (balcão, agregador). PURA. */
export function buildGenericEmailsSql(o: { minNames: number; ourParkIds: readonly string[] }): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const ours = ourClientBookingSql(p, o.ourParkIds);
  const min = p.add(o.minNames);
  return {
    sql: [
      `SELECT lower(trim(c."email")) AS email`,
      `  FROM "Booking" b ${CLIENT_JOIN}`,
      ` WHERE c."email" LIKE '%@%' AND ${ours}`,
      ` GROUP BY 1`,
      ` HAVING count(DISTINCT lower(trim(concat_ws(' ', c."firstName", c."lastName")))) >= ${min}`,
      ` LIMIT 20000`,
    ].join("\n"),
    params: p.values,
  };
}

// ─── Filtros da lista que dependem das reservas ─────────────────────────────

export type BookingRuleFilter =
  | { kind: "date"; col: "checkIn" | "checkOut"; from?: string; to?: string }
  | { kind: "status"; op: "is" | "is_not" | "contains"; value: string }
  | { kind: "flight"; op: "is" | "is_not" | "contains"; value: string }
  | { kind: "ref"; value: string };

/** Ids das reservas (nossas) que cumprem um filtro — o CRM cruza com as ligações. PURA. */
export function buildBookingIdsForFilterSql(f: BookingRuleFilter, ourParkIds: readonly string[]): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const conds = [ourClientBookingSql(p, ourParkIds)];
  const text = (col: string, op: string, value: string) => {
    const v = value.trim().toLowerCase();
    if (op === "is") return `lower(trim(${col})) = ${p.add(v)}`;
    if (op === "is_not") return `(${col} IS NULL OR lower(trim(${col})) <> ${p.add(v)})`;
    return `${col} ILIKE ${p.add(likeContains(value.trim()))}`;
  };
  switch (f.kind) {
    case "date": {
      const col = f.col === "checkIn" ? `b."checkIn"` : `b."checkOut"`;
      if (f.from) conds.push(`${col} >= ${p.add(f.from)}::timestamp`);
      if (f.to) conds.push(`${col} < ${p.add(f.to)}::timestamp`);
      break;
    }
    case "status": conds.push(text(`b."status"::text`, f.op, f.value)); break;
    case "flight": conds.push(`(${text(`b."returnFlight"`, f.op, f.value)} OR ${text(`b."departingFlight"`, f.op, f.value)})`); break;
    case "ref": {
      const r = p.add(f.value.trim());
      conds.push(`(b."id" = ${r} OR b."allocation"::text = ${r})`);
      break;
    }
  }
  return {
    sql: `SELECT b."id" AS id FROM "Booking" b WHERE ${conds.join(" AND ")} LIMIT ${p.add(CRM_RULE_MAX_BOOKINGS)}`,
    params: p.values,
  };
}

export async function readBookingIdsForFilter(f: BookingRuleFilter, ourParkIds: readonly string[], query: Query = multiparkDbQuery): Promise<string[]> {
  const { sql, params } = buildBookingIdsForFilterSql(f, ourParkIds);
  return (await query<Record<string, unknown>>(sql, params)).map((r) => String(r.id ?? "")).filter(Boolean);
}

// ─── Reservas nos próximos dias (pedir o email à chegada) ───────────────────

/** Reservas nossas com entrada em [now, now + days), sem canceladas. PURA. */
export function buildUpcomingBookingsSql(o: { days: number; ourParkIds: readonly string[] }): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const ours = ourClientBookingSql(p, o.ourParkIds);
  const days = p.add(Math.max(1, Math.min(14, Math.floor(o.days))));
  return {
    sql: [
      `SELECT b."id" AS id, NULLIF(b."allocation"::text, '') AS code, ${ts(`b."checkIn"`)} AS check_in, pk."name" AS park_name, pk."city" AS city, v."licensePlate" AS plate`,
      `  FROM "Booking" b LEFT JOIN "Park" pk ON pk."id" = b."parkId" LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
      ` WHERE b."checkIn" >= (now() AT TIME ZONE 'UTC') AND b."checkIn" < (now() AT TIME ZONE 'UTC') + make_interval(days => ${days})`,
      `   AND b."status"::text <> 'CANCELLED' AND ${ours}`,
      ` ORDER BY b."checkIn" LIMIT 2000`,
    ].join("\n"),
    params: p.values,
  };
}

export interface UpcomingBooking { id: string; code: string | null; checkIn: string | null; parkName: string | null; city: string | null; plate: string | null }

export async function readUpcomingBookings(o: { days: number; ourParkIds: readonly string[] }, query: Query = multiparkDbQuery): Promise<UpcomingBooking[]> {
  const { sql, params } = buildUpcomingBookingsSql(o);
  return (await query<Record<string, unknown>>(sql, params)).map((r) => ({
    id: String(r.id ?? ""), code: s(r.code), checkIn: s(r.check_in), parkName: s(r.park_name), city: s(r.city), plate: s(r.plate),
  }));
}

// ─── Opções dos filtros (parques, cidades, parceiros, canais) ───────────────

/** Contagens por parque/cidade, parceiro e canal das reservas nossas. PURA. */
export function buildCrmFilterOptionsSql(ourParkIds: readonly string[]): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const ours = ourClientBookingSql(p, ourParkIds);
  return {
    sql: [
      `SELECT 'park' AS kind, pk."name" AS v, max(pk."city") AS city, count(*) AS n FROM "Booking" b JOIN "Park" pk ON pk."id" = b."parkId" WHERE ${ours} GROUP BY pk."name"`,
      `UNION ALL SELECT 'partner', NULLIF(pa."name", ''), NULL, count(*) FROM "Booking" b JOIN "Partner" pa ON pa."id" = b."partnerId" WHERE ${ours} GROUP BY pa."name"`,
      `UNION ALL SELECT 'channel', b."origin"::text, NULL, count(*) FROM "Booking" b WHERE ${ours} GROUP BY b."origin"`,
      `LIMIT 1000`,
    ].join("\n"),
    params: p.values,
  };
}

export interface CrmFilterOptionRow { kind: "park" | "partner" | "channel"; value: string; city: string | null; n: number }

export async function readCrmFilterOptions(ourParkIds: readonly string[], query: Query = multiparkDbQuery): Promise<CrmFilterOptionRow[]> {
  const { sql, params } = buildCrmFilterOptionsSql(ourParkIds);
  return (await query<Record<string, unknown>>(sql, params))
    .map((r) => ({ kind: String(r.kind) as CrmFilterOptionRow["kind"], value: String(r.v ?? "").trim(), city: s(r.city), n: Math.round(Number(r.n ?? 0)) || 0 }))
    .filter((r) => r.value);
}
