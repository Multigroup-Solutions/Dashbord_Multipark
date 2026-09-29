/**
 * CLIENTES (CRM leve) — pedido Jorge 24 set 2026.
 *
 * Identidade = EMAIL normalizado (LOWER/TRIM, ver shared/email.ts). Não há
 * tabela nova: cada cliente é o agregado das suas reservas em
 * `multipark_bookings` (sincronizadas da API: webhooks + sync de hora a hora). Assim fica sempre
 * certo sem sync extra; se um dia pesar, passa-se a uma tabela materializada
 * com a MESMA forma de saída.
 *
 * Desempenho (medido 24 set: 67k reservas, 31k emails): o agregado leve
 * demora ~0,5 s e fica em CACHE 5 min por âmbito; pesquisa, segmentos,
 * ordenação e paginação são feitos em memória. Nome/telefone/último parque
 * só se vão buscar para as linhas da página.
 *
 * Métricas: nº reservas, canceladas, ESTADIAS (o carro entrou no parque:
 * CHECKED_IN…CHECKED_OUT, os mesmos estados "recebidos" do finance/engine),
 * total gasto e média (só estadias — reservas futuras e no-shows não contam),
 * primeira/última estadia, próxima reserva, frequência (dias médios entre
 * dias de estadia distintos), cidades.
 * Segmentos: novo (1 reserva não cancelada), recorrente (≥3 estadias), vip
 * (top 10% em gasto, só particulares), em risco (recorrente sem vir há 12
 * meses e sem reserva futura), parceiro (maioria via parceiro/Pro — agências).
 * Emails de domínios da casa (multipark/airpark/redpark/skypark) ficam fora.
 *
 * O CRM é a base de tudo o que já existe: a ficha junta as reclamações, os
 * perdidos & achados e as críticas do cliente — pelo email (normalizado) ou
 * pela referência de uma reserva dele — e avisa quando uma matrícula dele
 * também aparece nas reservas de outro email (outro cliente).
 *
 * Âmbito de cidade: TODAS as queries passam por `projectScope`, como o resto.
 */
import { sql, type SQL } from "drizzle-orm";
import { projectScope, scopedProjectIds } from "./cityScope";
import { normalizeEmail } from "../shared/email";

export type ClientSegment = "new" | "recurring" | "vip" | "at_risk" | "partner" | "shared";
export type ClientSort = "lastCheckIn" | "totalSpent" | "bookings" | "firstCheckIn";

export interface ClientRow {
  email: string;
  name: string | null;
  phone: string | null;
  bookings: number;
  cancelled: number;
  /** estadias: o carro entrou no parque */
  completed: number;
  /** reservas futuras não canceladas */
  upcoming: number;
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
  upcoming: number;
  /** dias distintos com estadia (base da frequência) */
  visitDays: number;
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
/** Estados em que o carro já entrou no parque (= COLLECTED_STATUSES do finance/engine). */
export const VISITED_STATUSES = ["CHECKED_IN", "CHECKING_OUT", "PENDING_CHECKOUT", "CHECKED_OUT"];
const VISITED = sql`UPPER(COALESCE(b.status, '')) IN (${sql.join(VISITED_STATUSES.map((v) => sql`${v}`), sql`, `)})`;
// checkIn guardado em UTC (a sync usa UTC_TIMESTAMP): NOW() dependia do fuso da sessão
const UPCOMING = sql`(${NOT_CANCELLED} AND b.checkIn > UTC_TIMESTAMP())`;

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
      SUM(${VISITED}) AS completed,
      SUM(${UPCOMING}) AS upcoming,
      COUNT(DISTINCT CASE WHEN ${VISITED} THEN DATE(b.checkIn) END) AS visitDays,
      SUM(b.partnerId IS NOT NULL OR COALESCE(b.pro, 0) = 1) AS partnerBookings,
      COUNT(DISTINCT NULLIF(LOWER(TRIM(CONCAT_WS(' ', b.clientFirstName, b.clientLastName))), '')) AS distinctNames,
      SUM(CASE WHEN ${VISITED} THEN b.totalPrice END) AS totalSpent,
      MIN(CASE WHEN ${VISITED} THEN b.checkIn END) AS firstCheckIn,
      MAX(CASE WHEN ${VISITED} THEN b.checkIn END) AS lastCheckIn,
      MIN(CASE WHEN ${UPCOMING} THEN b.checkIn END) AS nextCheckIn,
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
    upcoming: Number(r.upcoming ?? 0),
    visitDays: Number(r.visitDays ?? 0),
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
  if (a.bookings - a.cancelled === 1) out.push("new");
  if (a.completed >= RECURRING_MIN) out.push("recurring");
  if (!partner && !shared && a.totalSpent != null && Number.isFinite(vip) && a.totalSpent >= vip) out.push("vip");
  const cutoff = now - AT_RISK_MONTHS * 30.44 * 86_400_000;
  if (a.completed >= RECURRING_MIN && !a.nextCheckIn && (!a.lastCheckIn || new Date(a.lastCheckIn).getTime() < cutoff)) out.push("at_risk");
  return out;
}

/** Dias médios entre estadias: só estadias (nada de futuras), por dias distintos. */
export function frequencyDaysOf(a: Pick<AggRow, "visitDays" | "firstCheckIn" | "lastCheckIn">): number | null {
  if (a.visitDays < 2 || !a.firstCheckIn || !a.lastCheckIn) return null;
  const days = (new Date(a.lastCheckIn).getTime() - new Date(a.firstCheckIn).getTime()) / 86_400_000;
  return days > 0 ? Math.round(days / (a.visitDays - 1)) : null;
}

export function toClientRow(a: AggRow, vip: number, ident?: { name?: string | null; phone?: string | null; lastPark?: string | null }): ClientRow {
  return {
    email: a.email,
    name: ident?.name || null,
    phone: ident?.phone || null,
    bookings: a.bookings, cancelled: a.cancelled, completed: a.completed, upcoming: a.upcoming, partnerBookings: a.partnerBookings,
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
async function loadIdentities(db: any, emails: string[], projectIds?: number[] | null): Promise<Map<string, { name: string | null; phone: string | null; lastPark: string | null }>> {
  const out = new Map<string, { name: string | null; phone: string | null; lastPark: string | null }>();
  if (!emails.length) return out;
  const list = sql.join(emails.map((e) => sql`${e}`), sql`, `);
  const raw = rows(await db.execute(sql`
    SELECT LOWER(TRIM(b.clientEmail)) AS email,
           NULLIF(TRIM(CONCAT_WS(' ', b.clientFirstName, b.clientLastName)), '') AS name,
           NULLIF(TRIM(b.clientPhone), '') AS phone,
           NULLIF(TRIM(b.parkName), '') AS parkName
    FROM multipark_bookings b
    WHERE LOWER(TRIM(b.clientEmail)) IN (${list}) AND ${baseWhere(projectIds)}
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
async function searchIdentityEmails(db: any, term: string, projectIds?: number[] | null): Promise<Set<string>> {
  const pat = `%${term.toLowerCase()}%`;
  const digits = term.replace(/\D+/g, "");
  // "+351 912 345 678" e "912345678" são o mesmo: compara sem separadores e,
  // com 9+ dígitos, pelos últimos 9 (sem o indicativo)
  const needle = digits.length >= 9 ? digits.slice(-9) : digits;
  const phoneCond = digits.length >= 3 ? sql` OR REGEXP_REPLACE(COALESCE(b.clientPhone, ''), '[^0-9]', '') LIKE ${`%${needle}%`}` : sql``;
  const raw = rows(await db.execute(sql`
    SELECT DISTINCT LOWER(TRIM(b.clientEmail)) AS email
    FROM multipark_bookings b
    WHERE ${baseWhere(projectIds)} AND (LOWER(CONCAT_WS(' ', b.clientFirstName, b.clientLastName)) LIKE ${pat}${phoneCond}
      OR UPPER(REPLACE(REPLACE(b.licensePlate, ' ', ''), '-', '')) = ${plateKey(term)})`));
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
    const byIdentity = await searchIdentityEmails(db, search, q.projectIds);
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
      default: return a.lastCheckIn ? new Date(a.lastCheckIn).getTime() : null;
    }
  };
  const sorted = [...filtered].sort((x, y) => {
    const kx = key(x), ky = key(y);
    if (kx == null && ky == null) return x.email.localeCompare(y.email);
    if (kx == null) return 1;            // sem valor fica sempre no fim
    if (ky == null) return -1;
    return kx === ky ? x.email.localeCompare(y.email) : (kx < ky ? -1 : 1) * dir;
  });

  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize);
  const ident = await loadIdentities(db, pageRows.map((a) => a.email), q.projectIds);
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
/** Matrícula comparável: sem espaços/hífens, em maiúsculas ("aa-00-bb" = "AA 00 BB"). */
export function plateKey(raw: string | null | undefined): string {
  return (raw ?? "").replace(/[\s-]+/g, "").toUpperCase();
}
const PLATE_SQL = (col: SQL) => sql`UPPER(REPLACE(REPLACE(TRIM(${col}), ' ', ''), '-', ''))`;

export interface ClientInteraction {
  id: number;
  title: string;
  status: string;
  createdAt: string | null;
  /** como ficou ligado ao cliente */
  via: "email" | "reserva" | "reclamação";
  rating?: number;
}

export interface SharedPlate {
  plate: string;
  /** o outro cliente (email) que também usou esta matrícula */
  email: string;
  name: string | null;
  bookings: number;
  lastCheckIn: string | null;
}

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
  complaints: ClientInteraction[];
  lostFound: ClientInteraction[];
  reviews: ClientInteraction[];
  /** matrículas deste cliente que também aparecem em reservas de OUTRO email */
  sharedPlates: SharedPlate[];
}

const LIST_LIMIT = 50;

async function distinctValues(db: any, expr: SQL, email: string, projectIds?: number[] | null): Promise<string[]> {
  const raw = rows(await db.execute(sql`
    SELECT v FROM (
      SELECT ${expr} AS v, MAX(b.checkIn) AS lastAt
      FROM multipark_bookings b
      WHERE LOWER(TRIM(b.clientEmail)) = ${email} AND ${baseWhere(projectIds)}
      GROUP BY v
    ) t WHERE v IS NOT NULL AND v <> '' ORDER BY lastAt DESC LIMIT ${LIST_LIMIT}`));
  return raw.map((r) => String(r.v));
}

/**
 * Reclamações, perdidos e críticas do cliente. Liga-se pelo email normalizado
 * ou pela referência de uma reserva dele (nº de reserva / id externo); as
 * críticas também pela reclamação a que deram origem. Sempre com âmbito.
 */
async function loadInteractions(db: any, email: string, refs: string[]) {
  const refList = refs.length ? sql.join(refs.map((r) => sql`${r}`), sql`, `) : null;
  const byRef = (col: SQL) => (refList ? sql` OR TRIM(${col}) IN (${refList})` : sql``);
  const viaOf = (r: any): ClientInteraction["via"] => (String(r.email ?? "") === email ? "email" : "reserva");
  const [c, l] = await Promise.all([
    db.execute(sql`
      SELECT c.id, c.title, c.complaint_status AS status, c.createdAt, LOWER(TRIM(c.clientEmail)) AS email
      FROM complaints c
      WHERE (LOWER(TRIM(c.clientEmail)) = ${email}${byRef(sql`c.reservationRef`)}) AND ${projectScope(sql`c.projectId`)}
      ORDER BY c.createdAt DESC LIMIT ${LIST_LIMIT}`),
    db.execute(sql`
      SELECT l.id, CONCAT(l.itemType, ' — ', LEFT(l.description, 80)) AS title, l.status, l.createdAt, LOWER(TRIM(l.clientEmail)) AS email
      FROM lost_found_items l
      WHERE (LOWER(TRIM(l.clientEmail)) = ${email}${byRef(sql`l.bookingRef`)}) AND ${projectScope(sql`l.projectId`)}
      ORDER BY l.createdAt DESC LIMIT ${LIST_LIMIT}`),
  ]);
  const complaints: ClientInteraction[] = rows(c).map((r) => ({ id: Number(r.id), title: String(r.title ?? ""), status: String(r.status ?? ""), createdAt: r.createdAt ?? null, via: viaOf(r) }));
  const lostFound: ClientInteraction[] = rows(l).map((r) => ({ id: Number(r.id), title: String(r.title ?? ""), status: String(r.status ?? ""), createdAt: r.createdAt ?? null, via: viaOf(r) }));
  const complaintIds = complaints.map((x) => x.id);
  const byComplaint = complaintIds.length ? sql` OR g.complaintId IN (${sql.join(complaintIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
  const g = await db.execute(sql`
    SELECT g.id, g.rating, LEFT(COALESCE(g.reviewText, ''), 120) AS title, g.status, COALESCE(g.reviewDate, g.createdAt) AS createdAt,
           LOWER(TRIM(g.reviewerEmail)) AS email
    FROM google_reviews g
    WHERE (LOWER(TRIM(g.reviewerEmail)) = ${email}${byComplaint}) AND ${projectScope(sql`g.projectId`)}
    ORDER BY createdAt DESC LIMIT ${LIST_LIMIT}`);
  const reviews: ClientInteraction[] = rows(g).map((r) => ({
    id: Number(r.id), title: String(r.title ?? ""), status: String(r.status ?? ""), createdAt: r.createdAt ?? null,
    via: String(r.email ?? "") === email ? "email" : "reclamação", rating: Number(r.rating ?? 0),
  }));
  return { complaints, lostFound, reviews };
}

/** Outros emails (outros clientes) com reservas nas mesmas matrículas. */
async function loadSharedPlates(db: any, email: string, plates: string[], projectIds?: number[] | null): Promise<SharedPlate[]> {
  const keys = [...new Set(plates.map(plateKey).filter((k) => k.length >= 4))];
  if (!keys.length) return [];
  const raw = rows(await db.execute(sql`
    SELECT ${PLATE_SQL(sql`b.licensePlate`)} AS plate, LOWER(TRIM(b.clientEmail)) AS email,
           MAX(NULLIF(TRIM(CONCAT_WS(' ', b.clientFirstName, b.clientLastName)), '')) AS name,
           COUNT(*) AS bookings, MAX(b.checkIn) AS lastCheckIn
    FROM multipark_bookings b
    WHERE ${PLATE_SQL(sql`b.licensePlate`)} IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})
      AND LOWER(TRIM(b.clientEmail)) <> ${email} AND ${baseWhere(projectIds)}
    GROUP BY plate, email
    ORDER BY lastCheckIn DESC LIMIT ${LIST_LIMIT}`));
  return raw.map((r) => ({ plate: String(r.plate), email: String(r.email), name: r.name ?? null, bookings: Number(r.bookings ?? 0), lastCheckIn: r.lastCheckIn ?? null }));
}

export async function getClientProfile(db: any, rawEmail: string, projectIds?: number[] | null): Promise<ClientProfile | null> {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  const all = await loadAggregate(db, projectIds);
  const agg = all.find((a) => a.email === email);
  if (!agg) return null;
  const vip = computeVipThreshold(all);
  const where = sql`LOWER(TRIM(b.clientEmail)) = ${email} AND ${baseWhere(projectIds)}`;
  const [parks, list, refRows, names, phones, plates, nifs] = await Promise.all([
    // Agrupa por colunas de um derivado (não por expressões): o ONLY_FULL_GROUP_BY
    // (MariaDB e MySQL estrito) recusa "b.parkName isn't in GROUP BY" na forma direta.
    db.execute(sql`
      SELECT t.parkName, t.city, COUNT(*) AS bookings, COALESCE(SUM(t.spent), 0) AS spent
      FROM (
        SELECT COALESCE(NULLIF(TRIM(b.parkName), ''), '—') AS parkName, LOWER(NULLIF(TRIM(b.city), '')) AS city,
               CASE WHEN ${VISITED} THEN b.totalPrice END AS spent
        FROM multipark_bookings b
        WHERE ${where}
      ) t
      GROUP BY t.parkName, t.city
      ORDER BY bookings DESC, spent DESC`),
    db.execute(sql`
      SELECT b.id, b.externalId, b.bookingNumber, b.status, b.parkName, b.city, b.checkIn, b.checkOut,
             b.licensePlate, b.totalPrice, b.parkingType, b.campaignName, b.deliveryService, b.partnerName
      FROM multipark_bookings b
      WHERE ${where}
      ORDER BY b.checkIn DESC
      LIMIT 300`),
    // TODAS as referências (não só as 300 da lista) — é por elas que as
    // reclamações/perdidos sem email ficam ligados ao cliente.
    db.execute(sql`SELECT DISTINCT b.bookingNumber AS ref FROM multipark_bookings b WHERE ${where} AND b.bookingNumber IS NOT NULL
      UNION SELECT DISTINCT b.externalId AS ref FROM multipark_bookings b WHERE ${where}`),
    distinctValues(db, sql`NULLIF(TRIM(CONCAT_WS(' ', b.clientFirstName, b.clientLastName)), '')`, email, projectIds),
    distinctValues(db, sql`NULLIF(TRIM(b.clientPhone), '')`, email, projectIds),
    distinctValues(db, sql`NULLIF(${PLATE_SQL(sql`b.licensePlate`)}, '')`, email, projectIds),
    distinctValues(db, sql`NULLIF(TRIM(b.clientNif), '')`, email, projectIds),
  ]);
  const bookings_list = rows(list).map((b) => ({
    id: Number(b.id), externalId: String(b.externalId), bookingNumber: b.bookingNumber ?? null, status: b.status ?? null,
    parkName: b.parkName ?? null, city: normalizeCity(b.city), checkIn: b.checkIn ?? null, checkOut: b.checkOut ?? null,
    licensePlate: b.licensePlate ?? null, totalPrice: b.totalPrice != null ? String(b.totalPrice) : null,
    parkingType: b.parkingType ?? null, campaignName: b.campaignName ?? null,
    deliveryService: b.deliveryService != null ? Number(b.deliveryService) : null, partnerName: b.partnerName ?? null,
  }));
  const refs = [...new Set(rows(refRows).map((r) => String(r.ref ?? "").trim()).filter(Boolean))];
  const [interactions, sharedPlates] = await Promise.all([
    loadInteractions(db, email, refs),
    loadSharedPlates(db, email, plates, projectIds),
  ]);
  // nome/telefone/último parque: da reserva mais recente
  const base = toClientRow(agg, vip, { name: names[0] ?? null, phone: phones[0] ?? null, lastPark: bookings_list[0]?.parkName ?? null });
  return {
    ...base,
    names, phones, plates, nifs,
    parks: rows(parks).map((p) => ({ parkName: String(p.parkName), city: normalizeCity(p.city), bookings: Number(p.bookings ?? 0), spent: Number(p.spent ?? 0) })),
    bookings_list,
    ...interactions,
    sharedPlates,
  };
}

/** Reservas sem email (não dá para as anexar a um cliente) — só contagem, com âmbito. */
export async function countBookingsWithoutEmail(db: any, projectIds?: number[] | null): Promise<number> {
  const proj = projectIds && projectIds.length ? sql` AND b.projectId IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
  const r = rows(await db.execute(sql`
    SELECT COUNT(*) AS n FROM multipark_bookings b
    WHERE (b.clientEmail IS NULL OR b.clientEmail NOT LIKE '%@%') AND ${projectScope(sql`b.projectId`)}${proj}`))[0];
  return Number(r?.n ?? 0);
}

/** Sem permissão de totais financeiros: esconde gasto, média e o selo VIP (que é "top 10% em gasto"). */
export function stripTotals<T extends { totalSpent: number | null; avgSpend: number | null; segments: ClientSegment[] }>(row: T): T {
  return { ...row, totalSpent: null, avgSpend: null, segments: row.segments.filter((x) => x !== "vip") };
}
