/**
 * Pesquisa de reservas AO VIVO na BD da Multipark (só leitura) — substitui as
 * pesquisas na cópia `multipark_bookings` (Jorge, 29 set 2026: "pesquisas e
 * ligações a reservas"). A cópia do webhook fica sempre, mas deixa de ser lida.
 *
 * Só reservas dos nossos clientes (parques nossos + vendas nossas no
 * marketplace) e só das cidades de quem pede. As linhas vêm no formato que a
 * cópia usava (bookingNumber, clientFirstName, licensePlate…) com o `id` =
 * id da Multipark (texto) e o `projectId` pelo parque (árvore de projetos).
 *
 * Regras de read.ts: SQL parametrizado, construtores PUROS, LIMIT sempre.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, cityAliases, likeContains, normalizePlate } from "./read";
import { OUR_SALE } from "./partners";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export const BOOKING_SEARCH_MAX = 100;

/** O que se procura; os critérios juntam-se com OU. */
export interface BookingSearchCriteria {
  /** texto livre: n.º, id, matrícula, email, telefone ou nome */
  text?: string | null;
  /** id da Multipark ou n.º (allocation), exatos */
  ref?: string | null;
  plate?: string | null;
  email?: string | null;
  /** telefone (qualquer formato): compara os últimos 9 dígitos */
  phone?: string | null;
  /** nome completo (contém) */
  name?: string | null;
  ids?: readonly string[] | null;
}

export interface LiveBookingRow {
  id: string; externalId: string; bookingNumber: string | null; status: string | null;
  parkId: string | null; parkName: string | null; city: string | null; projectId: number | null;
  checkIn: string | null; checkOut: string | null; bookingCreatedAt: string | null; totalPrice: number | null;
  clientFirstName: string | null; clientLastName: string | null; clientEmail: string | null; clientPhone: string | null;
  licensePlate: string | null;
}

const ts = (col: string) => `to_char(${col}, 'YYYY-MM-DD HH24:MI:SS')`;
const digits = (s: string) => s.replace(/\D+/g, "");
const phoneExpr = `right(regexp_replace(COALESCE(c."phoneNumber", ''), '[^0-9]', '', 'g'), 9)`;
const plateExpr = `regexp_replace(upper(COALESCE(v."licensePlate", '')), '[^A-Z0-9]', '', 'g')`;
const nameExpr = `concat_ws(' ', c."firstName", c."lastName")`;

/** Condições (OU) para os critérios; [] = nada a procurar. PURA. */
export function searchConditions(c: BookingSearchCriteria, p: ParamList): string[] {
  const out: string[] = [];
  const ref = String(c.ref ?? "").trim().replace(/^#+/, "").slice(0, 128);
  if (ref) { const r = p.add(ref); out.push(`b."id" = ${r}`, `b."allocation" = ${r}`); }
  const plate = normalizePlate(String(c.plate ?? ""));
  if (plate.length >= 4) out.push(`${plateExpr} = ${p.add(plate)}`);
  const email = String(c.email ?? "").trim().toLowerCase();
  if (email.includes("@")) out.push(`lower(trim(c."email")) = ${p.add(email)}`);
  const phone9 = digits(String(c.phone ?? "")).slice(-9);
  if (phone9.length === 9) out.push(`${phoneExpr} = ${p.add(phone9)}`);
  const name = String(c.name ?? "").trim().replace(/\s+/g, " ");
  if (name.length >= 4) out.push(`${nameExpr} ILIKE ${p.add(likeContains(name))}`);
  const ids = [...new Set((c.ids ?? []).map((x) => String(x ?? "").trim()).filter(Boolean))].slice(0, 500);
  if (ids.length) out.push(`b."id" IN (${ids.map((x) => p.add(x)).join(", ")})`);
  const text = String(c.text ?? "").trim().replace(/^#+/, "").slice(0, 100);
  if (text.length >= 2) {
    const like = p.add(likeContains(text));
    const t = p.add(text);
    out.push(`b."id" = ${t}`, `b."allocation" ILIKE ${like}`, `c."email" ILIKE ${like}`, `${nameExpr} ILIKE ${like}`);
    const tp = normalizePlate(text);
    if (tp.length >= 3 && /\d/.test(tp)) out.push(`${plateExpr} LIKE ${p.add(`%${tp}%`)}`);
    const td = digits(text);
    if (td.length >= 6 && td.length === text.replace(/[\s+().-]/g, "").length) out.push(`${phoneExpr} LIKE ${p.add(`%${td.slice(-9)}`)}`);
  }
  return out;
}

/** Reservas que cumprem os critérios, nos nossos parques/vendas e nas cidades (undefined = todas). PURA. */
export function buildBookingSearchSql(c: BookingSearchCriteria, o: { ourParkIds: readonly string[]; cities?: readonly string[]; limit?: number }): { sql: string; params: SqlParam[] } | null {
  const p = new ParamList();
  const conds = searchConditions(c, p);
  if (!conds.length) return null;
  const parks = o.ourParkIds.length ? `b."parkId" IN (${o.ourParkIds.map((id) => p.add(id)).join(", ")})` : "FALSE";
  let city = "TRUE";
  if (o.cities !== undefined) {
    const aliases = cityAliases([...o.cities]);
    city = aliases.length ? `lower(trim(pk."city")) IN (${aliases.map((a) => p.add(a)).join(", ")})` : "FALSE";
  }
  const limit = Math.max(1, Math.min(BOOKING_SEARCH_MAX, Math.trunc(o.limit ?? 20)));
  const sql = [
    `SELECT b."id" AS id, NULLIF(b."allocation", '') AS code, b."status"::text AS status, b."parkId" AS park_id, pk."name" AS park_name, pk."city" AS city,`,
    `       ${ts(`b."checkIn"`)} AS check_in, ${ts(`b."checkOut"`)} AS check_out, ${ts(`b."createdAt"`)} AS created_at, b."bookingPrice" AS total,`,
    `       c."firstName" AS first_name, c."lastName" AS last_name, NULLIF(c."email", '') AS email, NULLIF(c."phoneNumber", '') AS phone, v."licensePlate" AS plate`,
    `  FROM "Booking" b`,
    `  LEFT JOIN "Park" pk ON pk."id" = b."parkId"`,
    `  LEFT JOIN "Client" c ON c."id" = COALESCE(b."customerId", b."clientId")`,
    `  LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
    ` WHERE (${parks} OR ${OUR_SALE}) AND ${city} AND (${conds.join(" OR ")})`,
    ` ORDER BY b."checkIn" DESC NULLS LAST, b."id"`,
    ` LIMIT ${p.add(limit)}`,
  ].join("\n");
  return { sql, params: p.values };
}

const str = (v: unknown) => (v == null || v === "" ? null : String(v));

export function mapLiveBookingRow(r: Record<string, unknown>, projectOf: (parkId: string | null) => number | null = () => null): LiveBookingRow {
  const parkId = str(r.park_id);
  const total = r.total == null ? null : Number(r.total);
  return {
    id: String(r.id ?? ""), externalId: String(r.id ?? ""), bookingNumber: str(r.code), status: str(r.status),
    parkId, parkName: str(r.park_name), city: str(r.city), projectId: projectOf(parkId),
    checkIn: str(r.check_in), checkOut: str(r.check_out), bookingCreatedAt: str(r.created_at), totalPrice: Number.isFinite(total) ? total : null,
    clientFirstName: str(r.first_name), clientLastName: str(r.last_name), clientEmail: str(r.email)?.toLowerCase() ?? null,
    clientPhone: str(r.phone), licensePlate: str(r.plate),
  };
}

/**
 * Pesquisa ao vivo. `cities`: as de quem pede (scopedCityNamesLive); sem
 * pedido (crons, webhooks) = todas. Lança se a BD da Multipark falhar.
 */
export async function searchLiveBookings(c: BookingSearchCriteria, o: { cities?: readonly string[]; limit?: number } = {}, query: Query = multiparkDbQuery): Promise<LiveBookingRow[]> {
  const { loadLiveContext } = await import("../finance/liveBookings");
  const ctx = await loadLiveContext();
  const built = buildBookingSearchSql(c, { ourParkIds: [...ctx.ourParks.keys()], cities: o.cities, limit: o.limit });
  if (!built) return [];
  const rows = await query<Record<string, unknown>>(built.sql, built.params);
  return rows.map((r) => mapLiveBookingRow(r, (id) => (id ? ctx.ourParks.get(id) ?? null : null)));
}

/** Âmbito de cidade do pedido (undefined = todas). */
export async function requestCities(): Promise<string[] | undefined> {
  const { scopedCityNamesLive } = await import("../cityScope");
  return scopedCityNamesLive();
}

/** Uma reserva pelo id da Multipark ou pelo n.º, nas cidades de quem pede. */
export async function liveBookingByRef(ref: string, o: { cities?: readonly string[] | "request" } = {}, query: Query = multiparkDbQuery): Promise<LiveBookingRow | null> {
  const r = String(ref ?? "").trim().replace(/^#+/, "");
  if (!r) return null;
  const cities = o.cities === "request" ? await requestCities() : o.cities;
  const rows = await searchLiveBookings({ ref: r }, { cities, limit: 5 }, query);
  return rows.find((x) => x.id === r) ?? rows.find((x) => x.bookingNumber === r) ?? null;
}
