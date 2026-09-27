/**
 * CRM — consultas (lista com filtros, contagens da pesquisa, opções, ficha).
 * Filtros: shared/crmFilters.ts. Âmbito de cidade do utilizador: uma ficha
 * só aparece se tiver pelo menos uma reserva nos projetos que ele vê.
 */
import { sql, type SQL } from "drizzle-orm";
import { projectScope, scopedProjectIds } from "../cityScope";
import { lisbonRangeUtc } from "../multiparkDb/diff";
import {
  cityAliases, cityLabel, citiesOfCountry, citiesOfRegion, CITY_INFO, COUNTRY_NAMES, parseParks, regionsList,
} from "../../shared/crmGeo";
import { plateKey } from "../../shared/crmIdentity";
import { RULE_FIELDS, segmentsOf, type CrmQuery, type CrmRule, type Segment } from "../../shared/crmFilters";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const inList = (vals: (string | number)[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
const like = (t: string) => `%${t.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
const DT = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d %H:%i:%s')`);
const utcNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 19).replace("T", " ");

// ─── Cores (pt ↔ en: as reservas trazem as duas) ───────────────────────────
const COLOR_SYNONYMS: string[][] = [
  ["vermelho", "vermelha", "red", "rojo", "rouge", "bordeaux", "bordô", "grená"],
  ["azul", "blue", "azul escuro", "azul-marinho", "navy"],
  ["preto", "preta", "black", "negro", "noir"],
  ["branco", "branca", "white", "blanco", "blanc"],
  ["cinzento", "cinzenta", "cinza", "grey", "gray", "gris", "prata", "prateado", "silver", "plata"],
  ["verde", "green", "vert"],
  ["amarelo", "amarela", "yellow", "amarillo", "jaune"],
  ["laranja", "orange", "naranja"],
  ["castanho", "castanha", "brown", "marrom", "marrón"],
  ["bege", "beige", "creme"],
  ["dourado", "gold", "dorado"],
];
export function colorVariants(v: string): string[] {
  const t = v.trim().toLowerCase();
  const g = COLOR_SYNONYMS.find((s) => s.includes(t));
  return g ?? [t];
}

// ─── Blocos do WHERE ────────────────────────────────────────────────────────

const bookingExists = (cond: SQL) => sql`EXISTS (SELECT 1 FROM crm_booking_links l JOIN multipark_bookings b ON b.externalId = l.bookingExternalId
  WHERE l.clientId = c.id AND l.role = 'traveler' AND ${cond})`;
const vehicleExists = (cond: SQL) => sql`EXISTS (SELECT 1 FROM crm_client_vehicles v WHERE v.clientId = c.id AND ${cond})`;

function textCond(col: SQL, op: string, value: string): SQL {
  const v = value.trim().toLowerCase();
  if (op === "is") return sql`LOWER(TRIM(${col})) = ${v}`;
  if (op === "is_not") return sql`(${col} IS NULL OR LOWER(TRIM(${col})) <> ${v})`;
  return sql`LOWER(${col}) LIKE ${like(v)}`;
}

function colorCond(op: string, value: string): SQL {
  const vars = colorVariants(value);
  const any = sql.join(vars.map((x) => (op === "is" ? sql`LOWER(TRIM(v.color)) = ${x}` : sql`LOWER(v.color) LIKE ${like(x)}`)), sql` OR `);
  return op === "is_not" ? sql`NOT ${vehicleExists(sql`(${any})`)}` : vehicleExists(sql`(${any})`);
}

function dateCond(col: SQL, op: string, value: unknown): SQL | null {
  const s = String(value ?? "").trim();
  if (op === "within_days" || op === "older_than_days") {
    const n = Math.max(0, Math.min(3650, Math.trunc(Number(s))));
    if (!Number.isFinite(n)) return null;
    return op === "within_days" ? sql`${col} >= ${daysAgo(n)}` : sql`${col} < ${daysAgo(n)}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const { start, end } = lisbonRangeUtc(s, s);
  if (op === "on") return sql`(${col} >= ${start} AND ${col} < ${end})`;
  if (op === "before") return sql`${col} < ${start}`;
  if (op === "after") return sql`${col} >= ${end}`;
  return null;
}

function numberCond(col: SQL, op: string, value: unknown): SQL | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (op === "gte") return sql`${col} >= ${n}`;
  if (op === "lte") return sql`${col} <= ${n}`;
  return sql`${col} = ${n}`;
}

export function ruleSql(r: CrmRule, opts: { canSeeTotals: boolean }): SQL | null {
  const def = RULE_FIELDS.find((f) => f.id === r.field);
  if (!def || (def.finance && !opts.canSeeTotals)) return null;
  const val = r.value == null ? "" : String(r.value);
  const yes = r.op !== "no";
  switch (r.field) {
    case "vehicle.color": return val ? colorCond(r.op, val) : null;
    case "vehicle.brand": return val ? (r.op === "is_not" ? sql`NOT ${vehicleExists(textCond(sql`v.brand`, "is", val))}` : vehicleExists(textCond(sql`v.brand`, r.op, val))) : null;
    case "vehicle.model": return val ? (r.op === "is_not" ? sql`NOT ${vehicleExists(textCond(sql`v.model`, "is", val))}` : vehicleExists(textCond(sql`v.model`, r.op, val))) : null;
    case "vehicle.plate": {
      const k = plateKey(val) || val.toUpperCase();
      return k ? (r.op === "is" ? vehicleExists(sql`v.plate = ${k}`) : r.op === "is_not" ? sql`NOT ${vehicleExists(sql`v.plate = ${k}`)}` : vehicleExists(sql`v.plate LIKE ${like(k)}`)) : null;
    }
    case "booking.checkIn": { const d = dateCond(sql`b.checkIn`, r.op, val); return d ? bookingExists(d) : null; }
    case "booking.checkOut": { const d = dateCond(sql`b.checkOut`, r.op, val); return d ? bookingExists(d) : null; }
    case "booking.park": return val ? (r.op === "is_not" ? sql`NOT ${bookingExists(textCond(sql`b.parkName`, "is", val))}` : bookingExists(textCond(sql`b.parkName`, r.op, val))) : null;
    case "booking.status": return val ? bookingExists(textCond(sql`b.status`, r.op === "is_not" ? "is_not" : r.op, val)) : null;
    case "booking.flight": return val ? bookingExists(sql`(${textCond(sql`b.returnFlight`, r.op, val)} OR ${textCond(sql`b.departingFlight`, r.op, val)})`) : null;
    case "client.bookings": return numberCond(sql`c.bookings`, r.op, val);
    case "client.completed": return numberCond(sql`c.completed`, r.op, val);
    case "client.totalSpent": return numberCond(sql`COALESCE(c.totalSpent, 0)`, r.op, val);
    case "client.lastVisit": return dateCond(sql`c.lastVisit`, r.op, val);
    case "client.firstVisit": return dateCond(sql`c.firstVisit`, r.op, val);
    case "client.upcoming": return yes ? sql`c.upcoming > 0` : sql`c.upcoming = 0`;
    case "client.zone": return val ? textCond(sql`c.zone`, r.op, val) : null;
    case "client.tags": return val ? textCond(sql`CONCAT(COALESCE(c.tagsJson, ''), ' ', COALESCE(c.notes, ''))`, r.op === "is" ? "contains" : r.op, val) : null;
    case "client.nif": return yes ? sql`(c.nif IS NOT NULL AND c.nif <> '')` : sql`(c.nif IS NULL OR c.nif = '')`;
    case "client.photo": return yes ? sql`c.photoUrl IS NOT NULL` : sql`c.photoUrl IS NULL`;
    case "relation.family": {
      const e = sql`EXISTS (SELECT 1 FROM crm_client_relations r WHERE r.kind = 'family' AND (r.clientId = c.id OR r.relatedClientId = c.id))`;
      return yes ? e : sql`NOT ${e}`;
    }
    case "relation.company":
      return val ? sql`EXISTS (SELECT 1 FROM crm_client_relations r JOIN crm_clients co ON co.id = r.relatedClientId
        WHERE r.clientId = c.id AND r.kind IN ('employee', 'manager') AND ${textCond(sql`co.displayName`, r.op, val)})` : null;
  }
  return null;
}

function segmentSql(s: Segment, vip: number | null): SQL {
  switch (s) {
    case "new": return sql`(c.bookings - c.cancelled) = 1`;
    case "recurring": return sql`c.completed >= 3`;
    case "vip": return vip == null ? sql`1 = 0` : sql`(c.isPro = 0 AND c.totalSpent >= ${vip} AND c.totalSpent > 0)`;
    case "at_risk": return sql`(c.completed >= 3 AND c.upcoming = 0 AND c.lastVisit < ${daysAgo(365)})`;
    case "partner": return sql`(c.bookings > 0 AND c.partnerBookings * 2 > c.bookings)`;
  }
}

export function buildWhere(q: CrmQuery, opts: { vipThreshold: number | null; canSeeTotals: boolean }): SQL {
  const parts: SQL[] = [sql`c.status = 'active'`];
  if (q.tab === "pro") parts.push(sql`(c.isPro = 1 OR c.kind = 'company')`);
  if (scopedProjectIds() !== undefined) parts.push(bookingExists(projectScope(sql`b.projectId`)));

  const s = q.search;
  const t = s?.text?.trim() ?? "";
  if (t) {
    const digits = t.replace(/\D/g, "");
    const byField: Record<string, () => SQL | null> = {
      name: () => sql`c.displayName LIKE ${like(t)}`,
      email: () => sql`EXISTS (SELECT 1 FROM crm_client_emails e WHERE e.clientId = c.id AND e.email LIKE ${like(t.toLowerCase())})`,
      phone: () => (digits.length >= 3 ? sql`EXISTS (SELECT 1 FROM crm_client_phones p WHERE p.clientId = c.id AND p.phone LIKE ${like(digits)})` : null),
      plate: () => { const k = plateKey(t) || t.replace(/[\s.\-]/g, "").toUpperCase(); return k ? vehicleExists(sql`v.plate LIKE ${like(k)}`) : null; },
      nif: () => (digits.length >= 3 ? sql`c.nif LIKE ${like(digits)}` : null),
      number: () => (/^\d+$/.test(digits) && digits.length ? sql`c.id = ${Number(digits)}` : null),
      booking: () => bookingExists(sql`(b.bookingNumber = ${t} OR b.externalId = ${t})`),
      carColor: () => colorCond("contains", t),
      carModel: () => vehicleExists(sql`CONCAT(COALESCE(v.brand, ''), ' ', COALESCE(v.model, '')) LIKE ${like(t)}`),
      tags: () => sql`CONCAT(COALESCE(c.tagsJson, ''), ' ', COALESCE(c.notes, '')) LIKE ${like(t)}`,
    };
    if (!s!.field || s!.field === "all") {
      const any = ["name", "email", "phone", "plate", "nif", "number"].map((k) => byField[k]()).filter(Boolean) as SQL[];
      parts.push(sql`(${sql.join(any, sql` OR `)})`);
    } else {
      const one = byField[s!.field]?.();
      parts.push(one ?? sql`1 = 0`);
    }
  }

  const g = q.groups ?? {};
  if (g.segment?.length) parts.push(sql`(${sql.join(g.segment.map((x) => segmentSql(x, opts.vipThreshold)), sql` OR `)})`);
  const cityIn = (aliases: string[]) => bookingExists(sql`LOWER(TRIM(b.city)) IN (${inList(aliases.length ? aliases : ["__nenhuma__"])})`);
  if (g.city?.length) parts.push(cityIn(cityAliases(g.city)));
  if (g.region?.length) parts.push(cityIn(g.region.flatMap(citiesOfRegion)));
  if (g.country?.length) parts.push(cityIn(g.country.flatMap(citiesOfCountry)));
  if (g.park?.length) parts.push(bookingExists(sql`b.parkName IN (${inList(g.park)})`));
  if (g.clientCountry?.length) parts.push(sql`c.country IN (${inList(g.clientCountry)})`);
  if (g.channel?.length) parts.push(sql`(c.originChannel IN (${inList(g.channel)}) OR ${bookingExists(sql`b.origin IN (${inList(g.channel)})`)})`);
  if (g.partner?.length) parts.push(bookingExists(sql`b.partnerName IN (${inList(g.partner)})`));
  if (g.kind?.length === 1) parts.push(g.kind[0] === "pro" ? sql`c.isPro = 1` : sql`c.isPro = 0`);
  if (g.alerts?.length) {
    const a = g.alerts.map((x) => (x === "noEmail" ? sql`c.noEmail = 1` : x === "genericEmail" ? sql`c.genericEmailOnly = 1`
      : sql`EXISTS (SELECT 1 FROM crm_merge_suggestions ms WHERE ms.status = 'pending' AND (ms.clientA = c.id OR ms.clientB = c.id))`));
    parts.push(sql`(${sql.join(a, sql` OR `)})`);
  }

  const rules = (q.rules?.items ?? []).map((r) => ruleSql(r, opts)).filter(Boolean) as SQL[];
  if (rules.length) parts.push(sql`(${sql.join(rules, q.rules!.match === "any" ? sql` OR ` : sql` AND `)})`);
  return sql.join(parts, sql` AND `);
}

function orderBy(q: CrmQuery, canSeeTotals: boolean): SQL {
  const dir = q.dir === "asc" ? sql.raw("ASC") : sql.raw("DESC");
  switch (q.sort) {
    case "name": return sql`c.displayName IS NULL, c.displayName ${q.dir === "desc" ? sql.raw("DESC") : sql.raw("ASC")}`;
    case "number": return sql`c.id ${dir}`;
    case "bookings": return sql`c.bookings ${dir}, c.id DESC`;
    case "firstVisit": return sql`c.firstVisit IS NULL, c.firstVisit ${dir}`;
    case "nextCheckIn": return sql`c.nextCheckIn IS NULL, c.nextCheckIn ${q.dir === "desc" ? sql.raw("DESC") : sql.raw("ASC")}`;
    case "totalSpent": return canSeeTotals ? sql`c.totalSpent IS NULL, c.totalSpent ${dir}` : sql`c.lastVisit IS NULL, c.lastVisit DESC`;
    default: return sql`c.lastVisit IS NULL, c.lastVisit ${dir}, c.id DESC`;
  }
}

// ─── VIP (10 % que mais gastam, só particulares) — cache 10 min ────────────
let vipCache: { at: number; value: number | null } | null = null;
export async function vipThreshold(db: any): Promise<number | null> {
  if (vipCache && Date.now() - vipCache.at < 10 * 60_000) return vipCache.value;
  const [n] = rowsOf(await db.execute(sql`SELECT COUNT(*) AS n FROM crm_clients WHERE status = 'active' AND isPro = 0 AND totalSpent > 0`));
  const count = Number(n?.n ?? 0);
  let value: number | null = null;
  if (count >= 10) {
    const [r] = rowsOf(await db.execute(sql`SELECT totalSpent FROM crm_clients WHERE status = 'active' AND isPro = 0 AND totalSpent > 0
      ORDER BY totalSpent DESC LIMIT 1 OFFSET ${sql.raw(String(Math.floor(count * 0.1)))}`));
    value = r ? Number(r.totalSpent) : null;
  }
  vipCache = { at: Date.now(), value };
  return value;
}

export interface CrmListRow {
  id: number; displayName: string | null; kind: string; isPro: boolean; photoUrl: string | null;
  primaryEmail: string | null; primaryPhone: string | null; country: string | null;
  bookings: number; completed: number; cancelled: number; upcoming: number; totalSpent: number | null;
  firstVisit: string | null; lastVisit: string | null; nextCheckIn: string | null;
  preferredPark: string | null; parks: { park: string; city: string | null; bookings: number }[]; cities: string[];
  segments: Segment[]; alerts: string[];
  vehicle: { plate: string; brand: string | null; model: string | null; color: string | null; photoUrl: string | null } | null;
}

export async function listClients(db: any, q: CrmQuery, opts: { canSeeTotals: boolean }) {
  const vip = await vipThreshold(db);
  const where = buildWhere(q, { vipThreshold: vip, canSeeTotals: opts.canSeeTotals });
  const limit = Math.max(1, Math.min(200, Math.trunc(q.limit ?? 24)));
  const offset = Math.max(0, Math.trunc(q.offset ?? 0));
  const [cnt] = rowsOf(await db.execute(sql`SELECT COUNT(*) AS n FROM crm_clients c WHERE ${where}`));
  const rows = rowsOf(await db.execute(sql`
    SELECT c.id, c.displayName, c.kind, c.isPro, c.photoUrl, c.primaryEmail, c.primaryPhone, c.country,
      c.bookings, c.completed, c.cancelled, c.upcoming, c.partnerBookings, c.totalSpent,
      ${DT("c.firstVisit")} AS firstVisit, ${DT("c.lastVisit")} AS lastVisit, ${DT("c.nextCheckIn")} AS nextCheckIn,
      c.preferredPark, c.parksJson, c.cities, c.noEmail, c.genericEmailOnly,
      EXISTS (SELECT 1 FROM crm_merge_suggestions ms WHERE ms.status = 'pending' AND (ms.clientA = c.id OR ms.clientB = c.id)) AS dup
    FROM crm_clients c WHERE ${where}
    ORDER BY ${orderBy(q, opts.canSeeTotals)}
    LIMIT ${sql.raw(String(limit))} OFFSET ${sql.raw(String(offset))}`));
  const ids = rows.map((r) => Number(r.id));
  const veh = new Map<number, any>();
  if (ids.length) {
    for (const v of rowsOf(await db.execute(sql`SELECT clientId, plateDisplay, plate, brand, model, color, photoUrl, bookings
      FROM crm_client_vehicles WHERE clientId IN (${inList(ids)}) ORDER BY bookings DESC, lastSeenAt DESC`))) {
      if (!veh.has(Number(v.clientId))) veh.set(Number(v.clientId), v);
    }
  }
  const out: CrmListRow[] = rows.map((r) => {
    const m = {
      bookings: Number(r.bookings), cancelled: Number(r.cancelled), completed: Number(r.completed), upcoming: Number(r.upcoming),
      partnerBookings: Number(r.partnerBookings), totalSpent: r.totalSpent == null ? null : Number(r.totalSpent),
      lastVisit: r.lastVisit ?? null, isPro: Number(r.isPro) === 1,
    };
    const alerts: string[] = [];
    if (Number(r.noEmail) === 1) alerts.push(Number(r.genericEmailOnly) === 1 ? "Email estranho" : "Sem email");
    if (Number(r.dup) === 1) alerts.push("Juntar?");
    const v = veh.get(Number(r.id));
    return {
      id: Number(r.id), displayName: r.displayName ?? null, kind: String(r.kind), isPro: m.isPro, photoUrl: r.photoUrl ?? null,
      primaryEmail: r.primaryEmail ?? null, primaryPhone: r.primaryPhone ?? null, country: r.country ?? null,
      bookings: m.bookings, completed: m.completed, cancelled: m.cancelled, upcoming: m.upcoming,
      totalSpent: opts.canSeeTotals ? m.totalSpent : null,
      firstVisit: r.firstVisit ?? null, lastVisit: r.lastVisit ?? null, nextCheckIn: r.nextCheckIn ?? null,
      preferredPark: r.preferredPark ?? null, parks: parseParks(r.parksJson),
      cities: String(r.cities ?? "").split(",").map((x) => cityLabel(x)).filter(Boolean) as string[],
      segments: segmentsOf(m, opts.canSeeTotals ? vip : null), alerts,
      vehicle: v ? { plate: v.plateDisplay || v.plate, brand: v.brand ?? null, model: v.model ?? null, color: v.color ?? null, photoUrl: v.photoUrl ?? null } : null,
    };
  });
  return { total: Number(cnt?.n ?? 0), offset, limit, rows: out, vipThreshold: opts.canSeeTotals ? vip : null };
}

/** Quantos clientes cada campo da pesquisa encontra (o menu "procurar em…"). */
export async function searchFacets(db: any, q: CrmQuery, text: string, opts: { canSeeTotals: boolean }) {
  const vip = await vipThreshold(db);
  const out: Record<string, number> = {};
  for (const field of ["name", "email", "phone", "plate", "nif", "number", "booking", "carColor", "carModel", "tags"] as const) {
    const where = buildWhere({ ...q, search: { text, field } }, { vipThreshold: vip, canSeeTotals: opts.canSeeTotals });
    const [r] = rowsOf(await db.execute(sql`SELECT COUNT(*) AS n FROM crm_clients c WHERE ${where}`));
    out[field] = Number(r?.n ?? 0);
  }
  return out;
}

/** Valores para os filtros de grupo (só o que existe nas reservas). */
export async function filterOptions(db: any) {
  const scope = projectScope(sql`b.projectId`);
  const parks = rowsOf(await db.execute(sql`SELECT b.parkName AS v, MAX(b.city) AS city, COUNT(*) AS n FROM multipark_bookings b
    WHERE b.parkName IS NOT NULL AND ${scope} GROUP BY b.parkName ORDER BY n DESC LIMIT 200`));
  const cities = rowsOf(await db.execute(sql`SELECT LOWER(TRIM(b.city)) AS v, COUNT(*) AS n FROM multipark_bookings b
    WHERE b.city IS NOT NULL AND ${scope} GROUP BY LOWER(TRIM(b.city)) ORDER BY n DESC`));
  const partners = rowsOf(await db.execute(sql`SELECT b.partnerName AS v, COUNT(*) AS n FROM multipark_bookings b
    WHERE b.partnerName IS NOT NULL AND b.partnerName <> '' AND b.partnerName <> 'Unknown User' AND ${scope}
    GROUP BY b.partnerName ORDER BY n DESC LIMIT 150`));
  const channels = rowsOf(await db.execute(sql`SELECT b.origin AS v, COUNT(*) AS n FROM multipark_bookings b
    WHERE b.origin IS NOT NULL AND ${scope} GROUP BY b.origin ORDER BY n DESC LIMIT 30`));
  const clientCountries = rowsOf(await db.execute(sql`SELECT country AS v, COUNT(*) AS n FROM crm_clients
    WHERE status = 'active' AND country IS NOT NULL GROUP BY country ORDER BY n DESC LIMIT 40`));
  const cityMap = new Map<string, number>();
  for (const c of cities) { const l = cityLabel(c.v); if (l) cityMap.set(l, (cityMap.get(l) ?? 0) + Number(c.n)); }
  return {
    cities: [...cityMap.entries()].map(([v, n]) => ({ value: v, label: v, n })),
    regions: regionsList().map((r) => ({ value: r, label: r })),
    countries: [...new Set(CITY_INFO.map((i) => i.country))].map((c) => ({ value: c, label: COUNTRY_NAMES[c] ?? c })),
    parks: parks.map((p) => ({ value: String(p.v), label: String(p.v), city: cityLabel(p.city), n: Number(p.n) })),
    partners: partners.map((p) => ({ value: String(p.v), label: String(p.v), n: Number(p.n) })),
    channels: channels.map((p) => ({ value: String(p.v), label: String(p.v), n: Number(p.n) })),
    clientCountries: clientCountries.map((p) => ({ value: String(p.v), label: COUNTRY_NAMES[String(p.v)] ?? String(p.v), n: Number(p.n) })),
  };
}

// ─── Ficha ──────────────────────────────────────────────────────────────────

/** Link para abrir a reserva na app da Multipark (endereço a confirmar com o Rafael). */
export const MULTIPARK_BOOKING_URL = "https://www.multipark.app/pt-PT/agent/booking/";

export async function getClientFile(db: any, id: number, opts: { canSeeTotals: boolean; canSeeIban: boolean }) {
  const [c] = rowsOf(await db.execute(sql`SELECT *, ${DT("firstVisit")} AS firstVisitS, ${DT("lastVisit")} AS lastVisitS,
    ${DT("nextCheckIn")} AS nextCheckInS, ${DT("lastSeenAt")} AS lastSeenAtS, DATE_FORMAT(birthDate, '%Y-%m-%d') AS birthDateS,
    ${DT("createdAt")} AS createdAtS FROM crm_clients WHERE id = ${id}`));
  if (!c) return null;
  if (c.status === "merged") return { redirectTo: Number(c.mergedInto) || null };
  if (scopedProjectIds() !== undefined) {
    const [ok] = rowsOf(await db.execute(sql`SELECT 1 AS ok FROM crm_booking_links l JOIN multipark_bookings b ON b.externalId = l.bookingExternalId
      WHERE l.clientId = ${id} AND ${projectScope(sql`b.projectId`)} LIMIT 1`));
    if (!ok) return null;
  }
  const emails = rowsOf(await db.execute(sql`SELECT id, email, isPrimary, generic, verified, source, ${DT("firstSeenAt")} AS firstSeenAt, ${DT("lastSeenAt")} AS lastSeenAt
    FROM crm_client_emails WHERE clientId = ${id} ORDER BY isPrimary DESC, generic ASC, lastSeenAt DESC`));
  const phones = rowsOf(await db.execute(sql`SELECT id, phone, isPrimary, whatsapp, label, source, ${DT("lastSeenAt")} AS lastSeenAt
    FROM crm_client_phones WHERE clientId = ${id} ORDER BY isPrimary DESC, lastSeenAt DESC`));
  const vehicles = rowsOf(await db.execute(sql`SELECT id, plate, plateDisplay, brand, model, color, vehicleType, photoUrl, lastKm, bookings,
    ${DT("firstSeenAt")} AS firstSeenAt, ${DT("lastSeenAt")} AS lastSeenAt FROM crm_client_vehicles WHERE clientId = ${id} ORDER BY bookings DESC, lastSeenAt DESC`));
  const relations = rowsOf(await db.execute(sql`
    SELECT r.id, r.kind, r.label, r.pays, r.clientId, r.relatedClientId,
      IF(r.clientId = ${id}, o2.displayName, o1.displayName) AS otherName,
      IF(r.clientId = ${id}, r.relatedClientId, r.clientId) AS otherId,
      IF(r.clientId = ${id}, o2.isPro, o1.isPro) AS otherPro,
      IF(r.clientId = ${id}, 'out', 'in') AS direction
    FROM crm_client_relations r
    LEFT JOIN crm_clients o1 ON o1.id = r.clientId LEFT JOIN crm_clients o2 ON o2.id = r.relatedClientId
    WHERE r.clientId = ${id} OR r.relatedClientId = ${id}`));
  const bookings = rowsOf(await db.execute(sql`
    SELECT b.externalId, b.bookingNumber, b.status, ${DT("b.checkIn")} AS checkIn, ${DT("b.checkOut")} AS checkOut,
      ${DT("COALESCE(b.bookingCreatedAt, b.syncedAt)")} AS createdAt, ${DT("b.cancelledAt")} AS cancelledAt,
      b.parkName, b.city, b.totalPrice, b.totalPaid, b.remainingToPay, b.paymentMethod, b.partnerName, b.pro, b.origin,
      b.licensePlate, b.returnFlight, b.departingFlight, b.deliveryType, b.checkinAgentName, b.checkoutAgentName, l.role
    FROM crm_booking_links l JOIN multipark_bookings b ON b.externalId = l.bookingExternalId
    WHERE l.clientId = ${id} AND ${projectScope(sql`b.projectId`)}
    ORDER BY b.checkIn DESC LIMIT 200`));
  const suggestions = rowsOf(await db.execute(sql`
    SELECT s.id, s.score, s.reasons, IF(s.clientA = ${id}, s.clientB, s.clientA) AS otherId, o.displayName AS otherName
    FROM crm_merge_suggestions s JOIN crm_clients o ON o.id = IF(s.clientA = ${id}, s.clientB, s.clientA)
    WHERE s.status = 'pending' AND (s.clientA = ${id} OR s.clientB = ${id}) ORDER BY s.score DESC LIMIT 10`));
  const merges = rowsOf(await db.execute(sql`
    SELECT e.id, e.mergedId, ${DT("e.mergedAt")} AS mergedAt, e.reason, u.name AS byName, o.displayName AS mergedName
    FROM crm_merge_events e LEFT JOIN users u ON u.id = e.mergedBy LEFT JOIN crm_clients o ON o.id = e.mergedId
    WHERE e.survivorId = ${id} AND e.undoneAt IS NULL ORDER BY e.mergedAt DESC LIMIT 20`));
  const log = rowsOf(await db.execute(sql`
    SELECT a.action, a.details, ${DT("a.createdAt")} AS at, u.name AS byName FROM activity_logs a LEFT JOIN users u ON u.id = a.userId
    WHERE a.entity = 'crm_client' AND a.entityId = ${id} ORDER BY a.createdAt DESC LIMIT 50`));

  const vip = await vipThreshold(db);
  const m = {
    bookings: Number(c.bookings), cancelled: Number(c.cancelled), completed: Number(c.completed), upcoming: Number(c.upcoming),
    partnerBookings: Number(c.partnerBookings), totalSpent: c.totalSpent == null ? null : Number(c.totalSpent),
    lastVisit: c.lastVisitS ?? null, isPro: Number(c.isPro) === 1,
  };
  // gasto por mês: média dos últimos 12 meses (estadias)
  const since = daysAgo(365);
  const last12 = bookings.filter((b) => String(b.checkIn ?? "") >= since && ["CHECKED_IN", "CHECKING_OUT", "PENDING_CHECKOUT", "CHECKED_OUT"].includes(String(b.status ?? "").toUpperCase()));
  const spent12 = last12.reduce((s, b) => s + (Number(b.totalPrice) || 0), 0);
  const next = bookings.filter((b) => b.checkIn && String(b.checkIn) > utcNow() && !String(b.status ?? "").toUpperCase().includes("CANCEL"))
    .sort((a, b) => String(a.checkIn).localeCompare(String(b.checkIn)))[0] ?? null;
  let tags: string[] = [];
  try { tags = JSON.parse(String(c.tagsJson ?? "[]")); } catch { tags = []; }
  const money = (x: unknown) => (opts.canSeeTotals ? (x == null ? null : Number(x)) : null);

  return {
    id: Number(c.id), kind: String(c.kind), status: String(c.status),
    displayName: c.displayName ?? null, firstName: c.firstName ?? null, lastName: c.lastName ?? null, photoUrl: c.photoUrl ?? null,
    primaryEmail: c.primaryEmail ?? null, primaryPhone: c.primaryPhone ?? null,
    nif: c.nif ?? null, taxName: c.taxName ?? null, taxAddress: c.taxAddress ?? null, address: c.address ?? null,
    zone: c.zone ?? null, gender: c.gender ?? null, ageBand: c.ageBand ?? null, birthDate: c.birthDateS ?? null,
    language: c.language ?? null, country: c.country ?? null, countryName: c.country ? COUNTRY_NAMES[c.country] ?? c.country : null,
    hasIban: !!c.ibanEnc, ibanMasked: opts.canSeeIban && c.ibanEnc ? await maskIban(String(c.ibanEnc)) : null,
    isPro: m.isPro, proDiscount: c.proDiscount == null ? null : Number(c.proDiscount),
    originPartnerName: c.originPartnerName ?? null, originChannel: c.originChannel ?? null,
    consentEmail: c.consentEmail == null ? null : Number(c.consentEmail) === 1,
    consentWhatsapp: c.consentWhatsapp == null ? null : Number(c.consentWhatsapp) === 1,
    consentSms: c.consentSms == null ? null : Number(c.consentSms) === 1,
    tags, notes: c.notes ?? null, createdAt: c.createdAtS ?? null,
    metrics: {
      bookings: m.bookings, completed: m.completed, cancelled: m.cancelled, upcoming: m.upcoming,
      totalSpent: money(m.totalSpent), spentPerMonth: opts.canSeeTotals ? Math.round((spent12 / 12) * 100) / 100 : null,
      avgPerStay: opts.canSeeTotals && m.completed ? Math.round(((m.totalSpent ?? 0) / m.completed) * 100) / 100 : null,
      firstVisit: c.firstVisitS ?? null, lastVisit: c.lastVisitS ?? null, nextCheckIn: c.nextCheckInS ?? null,
      preferredPark: c.preferredPark ?? null, parks: parseParks(c.parksJson),
    },
    segments: segmentsOf(m, opts.canSeeTotals ? vip : null),
    alerts: {
      noEmail: Number(c.noEmail) === 1, genericEmailOnly: Number(c.genericEmailOnly) === 1,
    },
    emails: emails.map((e) => ({ id: Number(e.id), email: String(e.email), isPrimary: Number(e.isPrimary) === 1, generic: Number(e.generic) === 1, source: e.source ?? null, lastSeenAt: e.lastSeenAt ?? null })),
    phones: phones.map((p) => ({ id: Number(p.id), phone: String(p.phone), isPrimary: Number(p.isPrimary) === 1, whatsapp: Number(p.whatsapp) === 1, label: p.label ?? null, lastSeenAt: p.lastSeenAt ?? null })),
    vehicles: vehicles.map((v) => ({ id: Number(v.id), plate: String(v.plateDisplay || v.plate), brand: v.brand ?? null, model: v.model ?? null, color: v.color ?? null, vehicleType: v.vehicleType ?? null, photoUrl: v.photoUrl ?? null, lastKm: v.lastKm == null ? null : Number(v.lastKm), bookings: Number(v.bookings), lastSeenAt: v.lastSeenAt ?? null })),
    relations: relations.map((r) => ({ id: Number(r.id), kind: String(r.kind), label: r.label ?? null, pays: Number(r.pays) === 1, otherId: Number(r.otherId), otherName: r.otherName ?? null, otherPro: Number(r.otherPro) === 1, direction: String(r.direction) })),
    bookings: bookings.map((b) => ({
      externalId: String(b.externalId), bookingNumber: b.bookingNumber ?? null, status: b.status ?? null,
      checkIn: b.checkIn ?? null, checkOut: b.checkOut ?? null, createdAt: b.createdAt ?? null, cancelledAt: b.cancelledAt ?? null,
      park: b.parkName ?? null, city: cityLabel(b.city), totalPrice: money(b.totalPrice), totalPaid: money(b.totalPaid),
      remainingToPay: money(b.remainingToPay), paymentMethod: b.paymentMethod ?? null, partnerName: b.partnerName && b.partnerName !== "Unknown User" ? b.partnerName : null,
      pro: Number(b.pro) === 1, origin: b.origin ?? null, plate: b.licensePlate ?? null, flight: b.returnFlight || b.departingFlight || null,
      deliveryType: b.deliveryType ?? null, checkinAgent: b.checkinAgentName ?? null, checkoutAgent: b.checkoutAgentName ?? null, role: String(b.role),
      multiparkUrl: MULTIPARK_BOOKING_URL + encodeURIComponent(String(b.externalId)),
    })),
    nextBooking: next ? { externalId: String(next.externalId), checkIn: next.checkIn, checkOut: next.checkOut, park: next.parkName ?? null, flight: next.returnFlight || next.departingFlight || null, totalPrice: money(next.totalPrice), remainingToPay: money(next.remainingToPay) } : null,
    suggestions: suggestions.map((s) => ({ id: Number(s.id), score: Number(s.score), reasons: String(s.reasons).split(",").filter(Boolean), otherId: Number(s.otherId), otherName: s.otherName ?? null })),
    merges: merges.map((e) => ({ id: Number(e.id), mergedId: Number(e.mergedId), mergedName: e.mergedName ?? null, mergedAt: e.mergedAt, reason: e.reason ?? null, byName: e.byName ?? null })),
    log: log.map((a) => ({ action: String(a.action), details: a.details ?? null, at: a.at, byName: a.byName ?? null })),
  };
}

async function maskIban(enc: string): Promise<string | null> {
  try {
    const { decryptSecret } = await import("../integrations/googleAds/crypto");
    const iban = decryptSecret(enc).replace(/\s+/g, "");
    return iban.length > 8 ? `${iban.slice(0, 4)} •••• •••• ${iban.slice(-4)}` : "••••";
  } catch { return "••••"; }
}

export function ruleFieldsFor(canSeeTotals: boolean) {
  return RULE_FIELDS.filter((f) => !f.finance || canSeeTotals);
}
