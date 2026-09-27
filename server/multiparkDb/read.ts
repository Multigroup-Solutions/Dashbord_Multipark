/**
 * Camada de LEITURA direta da BD da Multipark (BD 2) para as páginas do
 * dashboard — sem copiar para a nossa BD (ver docs/multipark-db/plano-duas-bd.md).
 *
 * Regras desta camada:
 *   - só SQL parametrizado (`$1, $2…`, Postgres/Prisma com "camelCase" entre
 *     aspas); os construtores de SQL são PUROS e testados;
 *   - linhas → objetos nossos por mapeadores pequenos e tipados (PUROS);
 *   - LIMIT sempre (paginação por limit/offset, com teto);
 *   - NUNCA lança: sem DATABASE_URL_MULTIPARK, sem ligação, erro ou tempo
 *     esgotado → `{ available: false, reason }` e a página mostra um aviso.
 *
 * 1.ª entidade: ocorrências ("Occurrence"). Colunas usadas (schema.md):
 *   Occurrence: id, title, priority, resolved, createdAt, userId, agentName,
 *               lat, lng, bookingId, parkId, remarks, attachment, resolvedAt,
 *               resolvedById, resolvedByName
 *   Booking: id, allocation (= n.º da reserva que mostramos), vehicleId
 *   BookingVehicle: licensePlate
 *   Park: id, name, city
 *   Agent: userId, parkId, name (recurso quando o nome não vem na ocorrência)
 */
import { MultiparkDbError, isMultiparkDbConfigured, multiparkDbQuery, redactSecrets, type SqlParam } from "./client";

// ─── Resultado com degradação ───────────────────────────────────────────────

export type MultiparkReadUnavailableCode = "NOT_CONFIGURED" | "CONNECT_FAILED" | "TIMEOUT" | "QUERY_FAILED";

export type MultiparkRead<T> =
  | { available: true; data: T }
  | { available: false; code: MultiparkReadUnavailableCode; reason: string };

/** Erro → motivo curto (PT-PT) para o aviso da página. PURA. */
export function describeReadFailure(err: unknown): { code: MultiparkReadUnavailableCode; reason: string } {
  const code = err instanceof MultiparkDbError ? err.code : undefined;
  const msg = String((err as any)?.message ?? err ?? "");
  if (code === "NOT_CONFIGURED") {
    return { code: "NOT_CONFIGURED", reason: "A ligação à BD da Multipark não está configurada (DATABASE_URL_MULTIPARK)." };
  }
  if (/statement timeout|canceling statement|query read timeout|timeout exceeded|timed out|ETIMEDOUT|57014/i.test(msg)) {
    return { code: "TIMEOUT", reason: "A BD da Multipark demorou demasiado a responder. Tenta de novo daqui a pouco." };
  }
  if (code === "CONNECT_FAILED" || code === "BAD_URL") {
    return { code: "CONNECT_FAILED", reason: "Sem ligação à BD da Multipark neste momento." };
  }
  return { code: "QUERY_FAILED", reason: "Não foi possível ler a BD da Multipark neste momento." };
}

/**
 * Corre uma leitura e devolve `{ available:false, reason }` em vez de lançar.
 * O detalhe técnico (já sem segredos) só vai para o log do servidor.
 */
export async function safeMultiparkRead<T>(label: string, fn: () => Promise<T>): Promise<MultiparkRead<T>> {
  if (!isMultiparkDbConfigured()) return { available: false, ...describeReadFailure(new MultiparkDbError("não definida", "NOT_CONFIGURED")) };
  try {
    return { available: true, data: await fn() };
  } catch (err) {
    console.warn(`[multiparkDb/read] ${label} falhou:`, redactSecrets(err).slice(0, 240));
    return { available: false, ...describeReadFailure(err) };
  }
}

// ─── Ajudantes puros ────────────────────────────────────────────────────────

/** Acumula parâmetros e devolve o marcador `$n` de cada um. */
export class ParamList {
  readonly values: SqlParam[] = [];
  add(v: SqlParam): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/** Texto para `ILIKE '%…%'` com % e _ escapados. PURA. */
export function likeContains(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Só letras e números, em maiúsculas (matrículas "AA-00-BB" = "AA00BB"). PURA. */
export function normalizePlate(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Nomes de cidade (com os sinónimos lisbon/oporto) em minúsculas. PURA. */
export function cityAliases(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const n = String(raw ?? "").trim().toLowerCase();
    if (!n) continue;
    if (n === "lisboa" || n === "lisbon") { out.add("lisboa"); out.add("lisbon"); }
    else if (n === "porto" || n === "oporto") { out.add("porto"); out.add("oporto"); }
    else out.add(n);
  }
  return [...out];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Timestamp "sem fuso" do Postgres (UTC) → ISO com Z. PURA. */
export function toIsoUtc(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const s = String(v).trim();
  const withT = s.includes("T") ? s : s.replace(" ", "T");
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(withT) ? withT : `${withT}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

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

// ─── Ocorrências ────────────────────────────────────────────────────────────

export const OCCURRENCE_PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export type OccurrencePriority = (typeof OCCURRENCE_PRIORITIES)[number];

export const OCCURRENCE_LIST_DEFAULT_LIMIT = 50;
export const OCCURRENCE_LIST_MAX_LIMIT = 200;
export const OCCURRENCE_MAX_OFFSET = 5_000;

export interface OccurrenceFilters {
  /** Dia de Lisboa "YYYY-MM-DD" (inclusive). */
  dateFrom?: string;
  /** Dia de Lisboa "YYYY-MM-DD" (inclusive). */
  dateTo?: string;
  parkId?: string;
  /** Tipo = "title" (os tipos configurados em Park.occurrenceTypes). */
  type?: string;
  priority?: OccurrencePriority;
  resolved?: boolean;
  /** N.º da reserva (allocation), id da reserva, matrícula, tipo ou notas. */
  search?: string;
  /** Âmbito de cidade do utilizador (Park.city). undefined = todas; [] = nenhuma. */
  cities?: string[];
}

export interface OccurrenceListOptions extends OccurrenceFilters {
  limit?: number;
  offset?: number;
}

export interface MultiparkOccurrence {
  id: string;
  title: string;
  priority: OccurrencePriority | null;
  resolved: boolean;
  createdAt: string | null;
  resolvedAt: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  resolvedById: string | null;
  resolvedByName: string | null;
  remarks: string | null;
  lat: number | null;
  lng: number | null;
  /** Texto guardado em Occurrence.attachment (URL ou caminho interno da app). */
  attachment: string | null;
  /** Só quando `attachment` já é um URL http(s) abrível. */
  attachmentUrl: string | null;
  bookingId: string | null;
  bookingCode: string | null;
  plate: string | null;
  parkId: string | null;
  parkName: string | null;
  parkCity: string | null;
}

/** Aliases que as consultas devolvem (nomes nossos). */
export type OccurrenceRow = Partial<Record<
  | "id" | "title" | "priority" | "resolved" | "created_at" | "resolved_at"
  | "created_by_user_id" | "created_by_name" | "resolved_by_id" | "resolved_by_name"
  | "remarks" | "lat" | "lng" | "attachment" | "booking_id" | "booking_code" | "plate"
  | "park_id" | "park_name" | "park_city",
  unknown
>>;

const OCCURRENCE_SELECT = [
  `o."id" AS id`,
  `o."title" AS title`,
  `o."priority"::text AS priority`,
  `o."resolved" AS resolved`,
  `to_char(o."createdAt", 'YYYY-MM-DD HH24:MI:SS') AS created_at`,
  `to_char(o."resolvedAt", 'YYYY-MM-DD HH24:MI:SS') AS resolved_at`,
  `o."userId" AS created_by_user_id`,
  `COALESCE(NULLIF(o."agentName", ''), NULLIF(ag."name", '')) AS created_by_name`,
  `o."resolvedById" AS resolved_by_id`,
  `COALESCE(NULLIF(o."resolvedByName", ''), NULLIF(ar."name", '')) AS resolved_by_name`,
  `o."remarks" AS remarks`,
  `o."lat" AS lat`,
  `o."lng" AS lng`,
  `NULLIF(o."attachment", '') AS attachment`,
  `o."bookingId" AS booking_id`,
  `NULLIF(b."allocation", '') AS booking_code`,
  `v."licensePlate" AS plate`,
  `o."parkId" AS park_id`,
  `p."name" AS park_name`,
  `p."city" AS park_city`,
].join(", ");

const OCCURRENCE_FROM = [
  `"Occurrence" o`,
  `LEFT JOIN "Park" p ON p."id" = o."parkId"`,
  `LEFT JOIN "Booking" b ON b."id" = o."bookingId"`,
  `LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
  // Agent é único por (userId, parkId): nome de quem criou / resolveu.
  `LEFT JOIN "Agent" ag ON ag."userId" = o."userId" AND ag."parkId" = o."parkId"`,
  `LEFT JOIN "Agent" ar ON ar."userId" = o."resolvedById" AND ar."parkId" = o."parkId"`,
].join("\n");

/**
 * WHERE das ocorrências (sem a palavra WHERE; "TRUE" se não houver filtros).
 * Datas: dias de Lisboa convertidos em instantes UTC (a BD grava UTC).
 * PURA (menos a conversão de dia, que é determinística).
 */
export function buildOccurrenceWhere(f: OccurrenceFilters, params: ParamList, lisbonMidnightUtc: (day: string) => string): string {
  const conds: string[] = [];
  if (f.dateFrom && DAY_RE.test(f.dateFrom)) conds.push(`o."createdAt" >= ${params.add(lisbonMidnightUtc(f.dateFrom))}::timestamp`);
  if (f.dateTo && DAY_RE.test(f.dateTo)) conds.push(`o."createdAt" < ${params.add(lisbonMidnightUtc(nextDay(f.dateTo)))}::timestamp`);
  if (f.parkId?.trim()) conds.push(`o."parkId" = ${params.add(f.parkId.trim())}`);
  if (f.type?.trim()) conds.push(`o."title" = ${params.add(f.type.trim())}`);
  if (f.priority && (OCCURRENCE_PRIORITIES as readonly string[]).includes(f.priority)) conds.push(`o."priority"::text = ${params.add(f.priority)}`);
  if (f.resolved !== undefined) conds.push(`o."resolved" = ${params.add(f.resolved)}`);
  if (f.cities !== undefined) {
    const aliases = cityAliases(f.cities);
    conds.push(aliases.length ? `lower(trim(p."city")) IN (${aliases.map((c) => params.add(c)).join(", ")})` : `FALSE`);
  }
  const q = f.search?.trim().slice(0, 100);
  if (q) {
    const like = params.add(likeContains(q));
    const parts = [
      `b."allocation" ILIKE ${like}`,
      `v."licensePlate" ILIKE ${like}`,
      `o."title" ILIKE ${like}`,
      `o."remarks" ILIKE ${like}`,
      `o."bookingId" = ${params.add(q)}`,
    ];
    const plate = normalizePlate(q);
    if (plate.length >= 3) parts.push(`regexp_replace(upper(v."licensePlate"), '[^A-Z0-9]', '', 'g') LIKE ${params.add(`%${plate}%`)}`);
    conds.push(`(${parts.join(" OR ")})`);
  }
  return conds.length ? conds.join(" AND ") : "TRUE";
}

function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Limite/offset seguros. PURA. */
export function clampPage(limit?: number, offset?: number): { limit: number; offset: number } {
  const l = Math.floor(Number(limit ?? OCCURRENCE_LIST_DEFAULT_LIMIT));
  const o = Math.floor(Number(offset ?? 0));
  return {
    limit: Number.isFinite(l) ? Math.min(Math.max(l, 1), OCCURRENCE_LIST_MAX_LIMIT) : OCCURRENCE_LIST_DEFAULT_LIMIT,
    offset: Number.isFinite(o) ? Math.min(Math.max(o, 0), OCCURRENCE_MAX_OFFSET) : 0,
  };
}

/** SQL da lista (mais recentes primeiro). PURA. */
export function buildOccurrenceListSql(opts: OccurrenceListOptions, lisbonMidnightUtc: (day: string) => string): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const where = buildOccurrenceWhere(opts, params, lisbonMidnightUtc);
  const { limit, offset } = clampPage(opts.limit, opts.offset);
  const sql = [
    `SELECT ${OCCURRENCE_SELECT}`,
    `FROM ${OCCURRENCE_FROM}`,
    `WHERE ${where}`,
    `ORDER BY o."createdAt" DESC, o."id" DESC`,
    `LIMIT ${params.add(limit)} OFFSET ${params.add(offset)}`,
  ].join("\n");
  return { sql, params: params.values };
}

/** SQL das contagens (total, abertas, resolvidas, por prioridade). PURA. */
export function buildOccurrenceStatsSql(f: OccurrenceFilters, lisbonMidnightUtc: (day: string) => string): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const where = buildOccurrenceWhere(f, params, lisbonMidnightUtc);
  const sql = [
    `SELECT count(*) AS total,`,
    ` count(*) FILTER (WHERE NOT o."resolved") AS open,`,
    ` count(*) FILTER (WHERE o."resolved") AS resolved,`,
    ` count(*) FILTER (WHERE o."priority"::text = 'HIGH') AS high,`,
    ` count(*) FILTER (WHERE o."priority"::text = 'HIGH' AND NOT o."resolved") AS high_open,`,
    ` count(*) FILTER (WHERE o."priority"::text = 'MEDIUM' OR o."priority" IS NULL) AS medium,`,
    ` count(*) FILTER (WHERE o."priority"::text = 'LOW') AS low`,
    `FROM ${OCCURRENCE_FROM}`,
    `WHERE ${where}`,
  ].join("\n");
  return { sql, params: params.values };
}

/** SQL das contagens por tipo ou por parque (para os filtros e o gráfico). PURA. */
export function buildOccurrenceGroupSql(by: "type" | "park", f: OccurrenceFilters, lisbonMidnightUtc: (day: string) => string, limit = 60): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const where = buildOccurrenceWhere(f, params, lisbonMidnightUtc);
  const cols = by === "type" ? `o."title" AS key, o."title" AS label, NULL AS city` : `o."parkId" AS key, p."name" AS label, p."city" AS city`;
  const group = by === "type" ? `o."title"` : `o."parkId", p."name", p."city"`;
  const sql = [
    `SELECT ${cols}, count(*) AS n`,
    `FROM ${OCCURRENCE_FROM}`,
    `WHERE ${where}`,
    `GROUP BY ${group}`,
    `ORDER BY n DESC, label`,
    `LIMIT ${params.add(Math.min(Math.max(Math.floor(limit), 1), 200))}`,
  ].join("\n");
  return { sql, params: params.values };
}

/** SQL de uma ocorrência pelo id. PURA. */
export function buildOccurrenceByIdSql(id: string, cities?: string[]): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const idP = params.add(id);
  const scope = buildOccurrenceWhere({ cities }, params, () => "");
  return {
    sql: [`SELECT ${OCCURRENCE_SELECT}`, `FROM ${OCCURRENCE_FROM}`, `WHERE o."id" = ${idP} AND ${scope}`, `LIMIT 1`].join("\n"),
    params: params.values,
  };
}

/** Linha → ocorrência. PURA. */
export function mapOccurrenceRow(r: OccurrenceRow): MultiparkOccurrence {
  const priority = str(r.priority)?.toUpperCase() ?? null;
  const attachment = str(r.attachment);
  return {
    id: String(r.id ?? ""),
    title: str(r.title) ?? "Ocorrência",
    priority: priority && (OCCURRENCE_PRIORITIES as readonly string[]).includes(priority) ? (priority as OccurrencePriority) : null,
    resolved: bool(r.resolved),
    createdAt: toIsoUtc(r.created_at),
    resolvedAt: toIsoUtc(r.resolved_at),
    createdByUserId: str(r.created_by_user_id),
    createdByName: str(r.created_by_name),
    resolvedById: str(r.resolved_by_id),
    resolvedByName: str(r.resolved_by_name),
    remarks: str(r.remarks),
    lat: num(r.lat),
    lng: num(r.lng),
    attachment,
    attachmentUrl: attachment && /^https?:\/\//i.test(attachment) ? attachment : null,
    bookingId: str(r.booking_id),
    bookingCode: str(r.booking_code),
    plate: str(r.plate),
    parkId: str(r.park_id),
    parkName: str(r.park_name),
    parkCity: str(r.park_city),
  };
}

export interface OccurrenceStats {
  total: number;
  open: number;
  resolved: number;
  high: number;
  highOpen: number;
  medium: number;
  low: number;
}

/** Linha das contagens → números. PURA. */
export function mapOccurrenceStatsRow(r: Record<string, unknown> | undefined): OccurrenceStats {
  const n = (k: string) => num(r?.[k]) ?? 0;
  return { total: n("total"), open: n("open"), resolved: n("resolved"), high: n("high"), highOpen: n("high_open"), medium: n("medium"), low: n("low") };
}

export interface OccurrenceGroup { key: string; label: string; city: string | null; count: number }

export function mapOccurrenceGroupRow(r: Record<string, unknown>): OccurrenceGroup {
  return { key: String(r.key ?? ""), label: str(r.label) ?? String(r.key ?? "—"), city: str(r.city), count: num(r.n) ?? 0 };
}

// ─── Leituras (nunca lançam) ────────────────────────────────────────────────

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

async function defaultLisbonMidnightUtc(): Promise<(day: string) => string> {
  const { lisbonMidnightUtcMs } = await import("../../shared/lisbonDay");
  return (day: string) => new Date(lisbonMidnightUtcMs(day)).toISOString().slice(0, 19).replace("T", " ");
}

export interface OccurrencePage {
  rows: MultiparkOccurrence[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** Lista paginada (pede limit+1 para saber se há mais). */
export async function listMultiparkOccurrences(opts: OccurrenceListOptions = {}, query: Query = multiparkDbQuery): Promise<MultiparkRead<OccurrencePage>> {
  return safeMultiparkRead("ocorrências (lista)", async () => {
    const page = clampPage(opts.limit, opts.offset);
    const { sql, params } = buildOccurrenceListSql({ ...opts, limit: page.limit + 1, offset: page.offset }, await defaultLisbonMidnightUtc());
    const rows = await query<OccurrenceRow>(sql, params);
    return { rows: rows.slice(0, page.limit).map(mapOccurrenceRow), limit: page.limit, offset: page.offset, hasMore: rows.length > page.limit };
  });
}

export interface OccurrenceStatsResult extends OccurrenceStats {
  byType: OccurrenceGroup[];
  byPark: OccurrenceGroup[];
}

/** Contagens + por tipo + por parque (com os mesmos filtros). */
export async function getMultiparkOccurrenceStats(f: OccurrenceFilters = {}, query: Query = multiparkDbQuery): Promise<MultiparkRead<OccurrenceStatsResult>> {
  return safeMultiparkRead("ocorrências (contagens)", async () => {
    const midnight = await defaultLisbonMidnightUtc();
    const s = buildOccurrenceStatsSql(f, midnight);
    const t = buildOccurrenceGroupSql("type", f, midnight);
    // Parques: sem o filtro de parque, para a lista do filtro não encolher a um.
    const p = buildOccurrenceGroupSql("park", { ...f, parkId: undefined }, midnight);
    const totals = await query(s.sql, s.params);
    const byType = await query(t.sql, t.params);
    const byPark = await query(p.sql, p.params);
    return { ...mapOccurrenceStatsRow(totals[0]), byType: byType.map(mapOccurrenceGroupRow), byPark: byPark.map(mapOccurrenceGroupRow) };
  });
}

/** Uma ocorrência (null se não existir ou estiver fora do âmbito de cidade). */
export async function getMultiparkOccurrence(id: string, cities?: string[], query: Query = multiparkDbQuery): Promise<MultiparkRead<MultiparkOccurrence | null>> {
  return safeMultiparkRead("ocorrência", async () => {
    const { sql, params } = buildOccurrenceByIdSql(id, cities);
    const rows = await query<OccurrenceRow>(sql, params);
    return rows[0] ? mapOccurrenceRow(rows[0]) : null;
  });
}
