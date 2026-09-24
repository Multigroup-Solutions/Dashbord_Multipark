/**
 * CLIENTES (CRM leve) — pedido Jorge 24 set 2026.
 *
 * Identidade = EMAIL normalizado (LOWER/TRIM, ver shared/email.ts). Não há
 * tabela nova: cada cliente é o agregado das suas reservas em
 * `multipark_bookings` (sincronizadas da API a cada 15 min). Assim fica sempre
 * certo sem sync extra; se um dia pesar, passa-se a uma tabela materializada
 * com a MESMA forma de saída.
 *
 * Desempenho (medido 24 set: 67k reservas, 31k emails): o agregado leve
 * demora ~0,5 s e fica em CACHE 5 min por âmbito; pesquisa, segmentos,
 * ordenação e paginação são feitos em memória. Nome/telefone/último parque
 * só se vão buscar para as linhas da página.
 *
 * Métricas: nº reservas, canceladas, total gasto (totalPrice das NÃO
 * canceladas — fonte única da faturação), média, primeira/última estadia,
 * próxima reserva, frequência (dias médios entre estadias), cidades.
 * Segmentos: novo (1 reserva), recorrente (≥3), vip (top 10% em gasto, só
 * particulares), em risco (recorrente sem vir há 12 meses e sem reserva
 * futura), parceiro (maioria das reservas via parceiro/Pro — agências).
 * Emails de domínios da casa (multipark/airpark/redpark/skypark) ficam fora.
 *
 * Âmbito de cidade: as reservas passam por `projectScope`, como tudo o resto.
 */
import { sql, type SQL } from "drizzle-orm";
import { projectScope, scopedProjectIds } from "./cityScope";
import { normalizeEmail } from "../shared/email";

export type ClientSegment = "new" | "recurring" | "vip" | "at_risk" | "partner" | "shared";
export type ClientSort = "lastCheckIn" | "totalSpent" | "bookings" | "firstCheckIn" | "name";

export interface ClientRow {
  email: string;
  name: string | null;
  phone: string | null;
  bookings: number;
  cancelled: number;
  completed: number;
  /** reservas via parceiro / Pro */
  partnerBookings: number;
  totalSpent: number | null;
  avgSpend: number | null;
  firstCheckIn: string | null;
  lastCheckIn: string | null;
  nextCheckIn: string | null;
  /** dias médios entre estadias (≥2 estadias) */
  frequencyDays: number | null;
  cities: string[];
  lastPark: string | null;
  segments: ClientSegment[];
}

export interface ListClientsQuery {
  search?: string | null;
  segment?: ClientSegment | "all" | null;
  sort?: ClientSort;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  /** filtro global (cidade/marca) já expandido para ids de projeto */
  projectIds?: number[] | null;
}

export const RECURRING_MIN = 3;
export const AT_RISK_MONTHS = 12;
export const VIP_TOP_SHARE = 0.10;
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Domínios da casa: staff e contas de teste, não são clientes. */
export const INTERNAL_EMAIL_DOMAINS = ["multipark.pt", "airpark.pt", "redpark.pt", "skypark.pt", "multigroup.pt"];

function rows<T = any>(r: any): T[] {
  return (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as T[];
}

/** "lisbon"/"Lisboa" → "Lisboa"; o resto capitalizado. */
export function normalizeCity(raw: string | null | undefined): string | null {
  const c = (raw ?? "").trim().toLowerCase();
  if (!c) return null;
  if (c === "lisbon" || c === "lisboa") return "Lisboa";
  if (c === "porto" || c === "oporto") return "Porto";
  if (c === "faro") return "Faro";
  return c.charAt(0).toUpperCase() + c.slice(1);
}

// ─── Agregado leve (cacheado) ────────────────────────────────────────────────
interface AggRow {
  email: string;
  bookings: number;
  cancelled: number;
  completed: number;
  partnerBookings: number;
  /** nomes diferentes nas reservas — muitos = email genérico de balcão */
  distinctNames: number;
  totalSpent: number | null;
  firstCheckIn: string | null;
  lastCheckIn: string | null;
  nextCheckIn: string | null;
  cities: string[];
}

const NOT_CANCELLED = sql`UPPER(COALESCE(b.status, '')) NOT LIKE '%CANCEL%'`;

function baseWhere(projectIds?: number[] | null): SQL {
  const scope = projectScope(sql`b.projectId`);
  const proj = projectIds && projectIds.length
    ? sql` AND b.projectId IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  const internal = sql.join(INTERNAL_EMAIL_DOMAINS.map((d) => sql`${d}`), sql`, `);
  return sql`b.clientEmail IS NOT NULL AND b.clientEmail LIKE '%@%'
      AND SUBSTRING_INDEX(LOWER(TRIM(b.clientEmail)), '@', -1) NOT IN (${internal})
      AND ${scope}${proj}`;
}

function aggregateSql(projectIds?: number[] | null): SQL {
  return sql`
    SELECT
      LOWER(TRIM(b.clientEmail)) AS email,
      COUNT(*) AS bookings,
      SUM(UPPER(COALESCE(b.status, '')) LIKE '%CANCEL%') AS cancelled,
      SUM(${NOT_CANCELLED}) AS completed,
      SUM(b.partnerId IS NOT NULL OR COALESCE(b.pro, 0) = 1) AS partnerBookings,
      COUNT(DISTINCT NULLIF(LOWER(TRIM(CONCAT_WS(' ', b.clientFirstName, b.clientLastName))), '')) AS distinctNames,
      SUM(CASE WHEN ${NOT_CANCELLED} THEN b.totalPrice END) AS totalSpent,
      MIN(CASE WHEN ${NOT_CANCELLED} THEN b.checkIn END) AS firstCheckIn,
      MAX(CASE WHEN ${NOT_CANCELLED} AND b.checkIn <= NOW() THEN b.checkIn END) AS lastCheckIn,
      MIN(CASE WHEN ${NOT_CANCELLED} AND b.checkIn > NOW() THEN b.checkIn END) AS nextCheckIn,
      GROUP_CONCAT(DISTINCT LOWER(NULLIF(TRIM(b.city), '')) SEPARATOR ',') AS cities
    FROM multipark_bookings b
    WHERE ${baseWhere(projectIds)}
    GROUP BY LOWER(TRIM(b.clientEmail))`;
}

const cache = new Map<string, { at: number; rows: AggRow[] }>();

function cacheKey(projectIds?: number[] | null): string {
  return JSON.stringify({ scope: scopedProjectIds() ?? "all", projectIds: projectIds ?? null });
}

/** Limpa a cache (testes / após sync manual). */
export function invalidateClientsCache(): void { cache.clear(); }

async function loadAggregate(db: any, projectIds?: number[] | null): Promise<AggRow[]> {
  const key = cacheKey(projectIds);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  const raw = rows(await db.execute(aggregateSql(projectIds)));
  const out: AggRow[] = raw.map((r) => ({
    email: String(r.email),
    bookings: Number(r.bookings ?? 0),
    cancelled: Number(r.cancelled ?? 0),
    completed: Number(r.completed ?? 0),
    partnerBookings: Number(r.partnerBookings ?? 0),
    distinctNames: Number(r.distinctNames ?? 0),
    totalSpent: r.totalSpent != null ? Number(r.totalSpent) : null,
    firstCheckIn: (r.firstCheckIn as string | null) ?? null,
    lastCheckIn: (r.lastCheckIn as string | null) ?? null,
    nextCheckIn: (r.nextCheckIn as string | null) ?? null,
    cities: [...new Set(String(r.cities ?? "").split(",").map(normalizeCity).filter((c): c is string => !!c))],
  }));
  cache.set(key, { at: Date.now(), rows: out });
  return out;
}

// ─── Regras (puras, testáveis) ───────────────────────────────────────────────
export function isPartner(a: Pick<AggRow, "bookings" | "partnerBookings">): boolean {
  return a.bookings > 0 && a.partnerBookings / a.bookings > 0.5;
}

/** Email genérico (balcão/placeholder): muitas pessoas diferentes no mesmo email. */
export const SHARED_MIN_NAMES = 5;
export function isShared(a: Pick<AggRow, "bookings" | "distinctNames" | "partnerBookings">): boolean {
  return !isPartner(a) && a.bookings >= 10 && a.distinctNames >= SHARED_MIN_NAMES;
}

/** Limiar VIP: gasto no percentil 90 entre particulares (nem parceiros nem emails genéricos) com gasto > 0. */
export function computeVipThreshold(all: AggRow[]): number {
  const spends = all.filter((a) => !isPartner(a) && !isShared(a) && (a.totalSpent ?? 0) > 0).map((a) => a.totalSpent as number).sort((x, y) => y - x);
  if (!spends.length) return Number.POSITIVE_INFINITY;
  const idx = Math.max(0, Math.min(spends.length - 1, Math.floor(spends.length * VIP_TOP_SHARE)));
  return spends[idx] > 0 ? spends[idx] : Number.POSITIVE_INFINITY;
}

export function segmentsOf(a: AggRow, vip: number, now = Date.now()): ClientSegment[] {
  const out: ClientSegment[] = [];
  const partner = isPartner(a);
  const shared = isShared(a);
  if (partner) out.push("partner");
  if (shared) out.push("shared");
  if (a.bookings === 1) out.push("new");
  if (a.completed >= RECURRING_MIN) out.push("recurring");
  if (!partner && !shared && a.totalSpent != null && Number.isFinite(vip) && a.totalSpent >= vip) out.push("vip");
  const cutoff = now - AT_RISK_MONTHS * 30.44 * 86_400_000;
  if (a.completed >= RECURRING_MIN && !a.nextCheckIn && (!a.lastCheckIn || new Date(a.lastCheckIn).getTime() < cutoff)) out.push("at_risk");
  return out;
}

export function frequencyDaysOf(a: Pick<AggRow, "completed" | "firstCheckIn" | "lastCheckIn">): number | null {
  if (a.completed < 2 || !a.firstCheckIn || !a.lastCheckIn) return null;
  const days = (new Date(a.lastCheckIn).getTime() - new Date(a.firstCheckIn).getTime()) / 86_400_000;
  return days > 0 ? Math.round(days / (a.completed - 1)) : null;
}

export function toClientRow(a: AggRow, vip: number, ident?: { name?: string | null; phone?: string | null; lastPark?: string | null }): ClientRow {
  return {
    email: a.email,
    name: ident?.name || null,
    phone: ident?.phone || null,
    bookings: a.bookings, cancelled: a.cancelled, completed: a.completed, partnerBookings: a.partnerBookings,
    totalSpent: a.totalSpent,
    avgSpend: a.totalSpent != null && a.completed > 0 ? a.totalSpent / a.completed : null,
    firstCheckIn: a.firstCheckIn, lastCheckIn: a.lastCheckIn, nextCheckIn: a.nextCheckIn,
    frequencyDays: frequencyDaysOf(a),
    cities: a.cities,
    lastPark: ident?.lastPark || null,
    segments: segmentsOf(a, vip),
  };
}

// ─── Identidade (nome/telefone/último parque) só para as linhas pedidas ─────
async function loadIdentities(db: any, emails: string[]): Promise<Map<string, { name: string | null; phone: string | null; lastPark: string | null }>> {
  const out = new Map<string, { name: string | null; phone: string | null; lastPark: string | null }>();
  if (!emails.length) return out;
  const list = sql.join(emails.map((e) => sql`${e}`), sql`, `);
  const raw = rows(await db.execute(sql`
    SELECT LOWER(TRIM(b.clientEmail)) AS email,
           NULLIF(TRIM(CONCAT_WS(' ', b.clientFirstName, b.clientLastName)), '') AS name,
           NULLIF(TRIM(b.clientPhone), '') AS phone,
           NULLIF(TRIM(b.parkName), '') AS parkName
    FROM multipark_bookings b
    WHERE LOWER(TRIM(b.clientEmail)) IN (${list})
    ORDER BY b.checkIn DESC`));
  for (const r of raw) {
    const e = String(r.email);
    const cur = out.get(e) ?? { name: null, phone: null, lastPark: null };
    if (!cur.name && r.name) cur.name = String(r.name);
    if (!cur.phone && r.phone) cur.phone = String(r.phone);
    if (!cur.lastPark && r.parkName) cur.lastPark = String(r.parkName);
    out.set(e, cur);
  }
  return out;
}

/** Emails cujas reservas têm nome ou telefone a bater com a pesquisa. */
async function searchIdentityEmails(db: any, term: string): Promise<Set<string>> {
  const pat = `%${term.toLowerCase()}%`;
  const digits = term.replace(/\D+/g, "");
  const phoneCond = digits.length >= 3 ? sql` OR REPLACE(REPLACE(b.clientPhone, ' ', ''), '+', '') LIKE ${`%${digits}%`}` : sql``;
  const raw = rows(await db.execute(sql`
    SELECT DISTINCT LOWER(TRIM(b.clientEmail)) AS email
    FROM multipark_bookings b
    WHERE b.clientEmail LIKE '%@%' AND (LOWER(CONCAT_WS(' ', b.clientFirstName, b.clientLastName)) LIKE ${pat}${phoneCond})`));
  return new Set(raw.map((r) => String(r.email)));
}

// ─── Lista ───────────────────────────────────────────────────────────────────
export async function listClients(db: any, q: ListClientsQuery): Promise<{ rows: ClientRow[]; total: number; page: number; pageSize: number; vipThreshold: number | null }> {
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, q.pageSize ?? 50));
  const all = await loadAggregate(db, q.projectIds);
  const vip = computeVipThreshold(all);

  let filtered = all;
  const search = q.search?.trim().toLowerCase();
  if (search) {
    const byIdentity = await searchIdentityEmails(db, search);
    filtered = filtered.filter((a) => a.email.includes(search) || byIdentity.has(a.email));
  }
  if (q.segment && q.segment !== "all") {
    const seg = q.segment;
    filtered = filtered.filter((a) => segmentsOf(a, vip).includes(seg));
  }

  const sort = q.sort ?? "lastCheckIn";
  const dir = q.dir === "asc" ? 1 : -1;
  const key = (a: AggRow): number | null => {
    switch (sort) {
      case "totalSpent": return a.totalSpent;
      case "bookings": return a.bookings;
      case "firstCheckIn": return a.firstCheckIn ? new Date(a.firstCheckIn).getTime() : null;
      case "name": return null;   // ordenado abaixo pelo email (o nome vem só para a página)
      default: return a.lastCheckIn ? new Date(a.lastCheckIn).getTime() : null;
    }
  };
  const sorted = [...filtered].sort((x, y) => {
    if (sort === "name") return x.email.localeCompare(y.email) * dir;
    const kx = key(x), ky = key(y);
    if (kx == null && ky == null) return x.email.localeCompare(y.email);
    if (kx == null) return 1;            // sem valor fica sempre no fim
    if (ky == null) return -1;
    return kx === ky ? x.email.localeCompare(y.email) : (kx < ky ? -1 : 1) * dir;
  });

  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize);
  const ident = await loadIdentities(db, pageRows.map((a) => a.email));
  return {
    rows: pageRows.map((a) => toClientRow(a, vip, ident.get(a.email))),
    total: sorted.length,
    page, pageSize,
    vipThreshold: Number.isFinite(vip) ? vip : null,
  };
}

// ─── Stats (tiles) ───────────────────────────────────────────────────────────
export interface ClientsStats {
  clients: number;
  recurring: number;
  vip: number;
  atRisk: number;
  partners: number;
  /** clientes cuja PRIMEIRA estadia foi nos últimos 30 dias */
  newLast30d: number;
  /** clientes com reserva futura */
  upcoming: number;
  vipThreshold: number | null;
}

export function computeStats(all: AggRow[], now = Date.now()): ClientsStats {
  const vip = computeVipThreshold(all);
  const since30 = now - 30 * 86_400_000;
  const s: ClientsStats = { clients: all.length, recurring: 0, vip: 0, atRisk: 0, partners: 0, newLast30d: 0, upcoming: 0, vipThreshold: Number.isFinite(vip) ? vip : null };
  for (const a of all) {
    const segs = segmentsOf(a, vip, now);
    if (segs.includes("recurring")) s.recurring++;
    if (segs.includes("vip")) s.vip++;
    if (segs.includes("at_risk")) s.atRisk++;
    if (segs.includes("partner")) s.partners++;
    if (a.firstCheckIn) { const t = new Date(a.firstCheckIn).getTime(); if (t >= since30 && t <= now) s.newLast30d++; }
    if (a.nextCheckIn) s.upcoming++;
  }
  return s;
}

export async function clientsStats(db: any, projectIds?: number[] | null): Promise<ClientsStats> {
  return computeStats(await loadAggregate(db, projectIds));
}

// ─── Ficha ───────────────────────────────────────────────────────────────────
export interface ClientProfile extends ClientRow {
  /** outros nomes/telefones/matrículas vistos nas reservas */
  names: string[];
  phones: string[];
  plates: string[];
  nifs: string[];
  parks: { parkName: string; city: string | null; bookings: number; spent: number }[];
  bookings_list: {
    id: number; externalId: string; bookingNumber: string | null; status: string | null;
    parkName: string | null; city: string | null; checkIn: string | null; checkOut: string | null;
    licensePlate: string | null; totalPrice: string | null; parkingType: string | null; campaignName: string | null;
    deliveryService: number | null; partnerName: string | null;
  }[];
}

const SEP = "|~|";
const SEP_LIT = sql.raw(`'${SEP}'`);

export async function getClientProfile(db: any, rawEmail: string): Promise<ClientProfile | null> {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  const all = await loadAggregate(db, null);
  const agg = all.find((a) => a.email === email);
  if (!agg) return null;
  const vip = computeVipThreshold(all);
  const scope = projectScope(sql`b.projectId`);
  const [parks, list, ids] = await Promise.all([
    db.execute(sql`
      SELECT COALESCE(NULLIF(TRIM(b.parkName), ''), '—') AS parkName, LOWER(NULLIF(TRIM(b.city), '')) AS city,
             COUNT(*) AS bookings,
             COALESCE(SUM(CASE WHEN ${NOT_CANCELLED} THEN b.totalPrice END), 0) AS spent
      FROM multipark_bookings b
      WHERE LOWER(TRIM(b.clientEmail)) = ${email} AND ${scope}
      GROUP BY COALESCE(NULLIF(TRIM(b.parkName), ''), '—'), LOWER(NULLIF(TRIM(b.city), ''))
      ORDER BY bookings DESC, spent DESC`),
    db.execute(sql`
      SELECT b.id, b.externalId, b.bookingNumber, b.status, b.parkName, b.city, b.checkIn, b.checkOut,
             b.licensePlate, b.totalPrice, b.parkingType, b.campaignName, b.deliveryService, b.partnerName
      FROM multipark_bookings b
      WHERE LOWER(TRIM(b.clientEmail)) = ${email} AND ${scope}
      ORDER BY b.checkIn DESC
      LIMIT 300`),
    db.execute(sql`
      SELECT
        GROUP_CONCAT(DISTINCT NULLIF(TRIM(CONCAT_WS(' ', b.clientFirstName, b.clientLastName)), '') SEPARATOR ${SEP_LIT}) AS names,
        GROUP_CONCAT(DISTINCT NULLIF(TRIM(b.clientPhone), '') SEPARATOR ${SEP_LIT}) AS phones,
        GROUP_CONCAT(DISTINCT NULLIF(UPPER(REPLACE(TRIM(b.licensePlate), ' ', '')), '') SEPARATOR ${SEP_LIT}) AS plates,
        GROUP_CONCAT(DISTINCT NULLIF(TRIM(b.clientNif), '') SEPARATOR ${SEP_LIT}) AS nifs
      FROM multipark_bookings b
      WHERE LOWER(TRIM(b.clientEmail)) = ${email} AND ${scope}`),
  ]);
  const i = rows(ids)[0] ?? {};
  const split = (v: any) => (v ? String(v).split(SEP).filter(Boolean) : []);
  const bookings_list = rows(list).map((b) => ({
    id: Number(b.id), externalId: String(b.externalId), bookingNumber: b.bookingNumber ?? null, status: b.status ?? null,
    parkName: b.parkName ?? null, city: normalizeCity(b.city), checkIn: b.checkIn ?? null, checkOut: b.checkOut ?? null,
    licensePlate: b.licensePlate ?? null, totalPrice: b.totalPrice != null ? String(b.totalPrice) : null,
    parkingType: b.parkingType ?? null, campaignName: b.campaignName ?? null,
    deliveryService: b.deliveryService != null ? Number(b.deliveryService) : null, partnerName: b.partnerName ?? null,
  }));
  // nome/telefone/último parque: da reserva mais recente
  const latest = bookings_list[0];
  const names = split(i.names);
  const base = toClientRow(agg, vip, { name: names[0] ?? null, phone: split(i.phones)[0] ?? null, lastPark: latest?.parkName ?? null });
  return {
    ...base,
    names, phones: split(i.phones), plates: split(i.plates), nifs: split(i.nifs),
    parks: rows(parks).map((p) => ({ parkName: String(p.parkName), city: normalizeCity(p.city), bookings: Number(p.bookings ?? 0), spent: Number(p.spent ?? 0) })),
    bookings_list,
  };
}

/** Sem permissão de totais financeiros: esconde gasto e média (lista e ficha). */
export function stripTotals<T extends { totalSpent: number | null; avgSpend: number | null }>(row: T): T {
  return { ...row, totalSpent: null, avgSpend: null };
}
