/**
 * Atividade do Dia e catálogo de agentes lidos AO VIVO da BD da Multipark
 * (BD 2). Desde o PR #141 a cópia local `multipark_booking_history` deixou de
 * ser alimentada: a Atividade do Dia (/operacional), a gaveta de cada pessoa,
 * "Agentes por ligar", o id do agente pelo nome e as ligações automáticas
 * passam a ler daqui. A cópia local fica só como recurso (dias antes de
 * LIVE_ACTIONS_SINCE, ou BD da Multipark indisponível — com aviso).
 *
 * Regras de read.ts: SQL parametrizado, construtores e mapeadores PUROS
 * (testados em activityLive.test.ts), LIMIT sempre, nunca lança.
 *
 * Colunas usadas (docs/multipark-db/schema.md):
 *   History: id, userId, agentName, changeType, actionTime, bookingId
 *   Booking: id, parkId, allocation, vehicleId · BookingVehicle: licensePlate
 *   Park: id, name, city · Agent: userId, parkId, name, isActive, role, updatedAt
 *   AgentInvite: email, createdAgentId, acceptedBy, updatedAt
 *
 * Tempo: a BD grava UTC sem fuso; as janelas chegam já em UTC
 * ("YYYY-MM-DD HH:MM:SS", [from, to)) — a Atividade usa o dia CIVIL de Lisboa
 * (lisbonDayRangeUtc), não o operacional da Avaliação.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, cityAliases, safeMultiparkRead, toIsoUtc, type MultiparkRead } from "./read";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

/**
 * Primeiro dia (Lisboa) lido ao vivo. Antes disto, as ações vêm da cópia
 * local `multipark_booking_history`.
 */
export const LIVE_ACTIONS_SINCE = "2026-03-02";

/** Teto das linhas (agente × tipo × minuto) da Atividade. */
export const ACTIVITY_ROW_LIMIT = 200_000;
export const ACTIVITY_DETAIL_LIMIT = 500;
export const AGENT_LIST_LIMIT = 5_000;
/** Janela do catálogo de agentes vistos (dias). */
export const AGENTS_SEEN_DAYS = 180;
const MAX_IDS = 200;

const ts = (col: string) => `to_char(${col}, 'YYYY-MM-DD HH24:MI:SS')`;
/** Nome do agente: o do History, senão o do "Agent" nesse parque. */
const AGENT_NAME = `COALESCE(NULLIF(h."agentName", ''), NULLIF(ag."name", ''))`;
const JOINS = [
  `  LEFT JOIN "Booking" b ON b."id" = h."bookingId"`,
  `  LEFT JOIN "Park" p ON p."id" = b."parkId"`,
  `  LEFT JOIN "Agent" ag ON ag."userId" = h."userId" AND ag."parkId" = b."parkId"`,
];

function cityCondition(cities: string[] | undefined, params: ParamList): string | null {
  if (cities === undefined) return null;
  const aliases = cityAliases(cities);
  return aliases.length ? `lower(trim(p."city")) IN (${aliases.map((c) => params.add(c)).join(", ")})` : `FALSE`;
}

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

// ─── 1. Ações da Atividade (agente × tipo × minuto) ─────────────────────────

/**
 * Ações de todos os agentes em [from, to), agregadas ao minuto (chega para
 * o turno: no horário / fora do horário). PURA.
 */
export function buildActivityActionsSql(opts: { from: string; to: string; cities?: string[]; limit?: number }): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const conds = [
    `h."actionTime" >= ${params.add(opts.from)}::timestamp`,
    `h."actionTime" < ${params.add(opts.to)}::timestamp`,
  ];
  const city = cityCondition(opts.cities, params);
  if (city) conds.push(city);
  const sql = [
    `SELECT h."userId" AS user_id, ${AGENT_NAME} AS agent_name, upper(h."changeType"::text) AS change_type,`,
    `       ${ts(`date_trunc('minute', h."actionTime")`)} AS at, count(*) AS n`,
    `  FROM "History" h`,
    ...JOINS,
    ` WHERE ${conds.join(" AND ")}`,
    ` GROUP BY 1, 2, 3, 4`,
    ` ORDER BY 4`,
    ` LIMIT ${params.add(Math.max(1, Math.min(opts.limit ?? ACTIVITY_ROW_LIMIT, ACTIVITY_ROW_LIMIT)))}`,
  ].join("\n");
  return { sql, params: params.values };
}

export interface ActivityActionRow {
  agentUserId: string | null;
  agentName: string | null;
  changeType: string;
  /** ISO UTC (minuto). */
  actionTime: string;
  n: number;
}

export function mapActivityActionRow(r: Record<string, unknown>): ActivityActionRow | null {
  const at = toIsoUtc(r.at);
  if (!at) return null;
  return { agentUserId: str(r.user_id), agentName: str(r.agent_name), changeType: String(r.change_type ?? "").toUpperCase(), actionTime: at, n: Math.max(1, int(r.n)) };
}

export async function getActivityActionsLive(
  opts: { from: string; to: string; cities?: string[] },
  query: Query = multiparkDbQuery,
): Promise<MultiparkRead<{ rows: ActivityActionRow[]; truncated: boolean }>> {
  return safeMultiparkRead("atividade do dia (ações)", async () => {
    const { sql, params } = buildActivityActionsSql(opts);
    const raw = await query(sql, params);
    const rows = raw.map(mapActivityActionRow).filter((x): x is ActivityActionRow => !!x);
    return { rows, truncated: raw.length >= ACTIVITY_ROW_LIMIT };
  });
}

// ─── 2. Detalhe (gaveta): as ações de uma pessoa num dia ─────────────────────

/** Ações por ids de agente e/ou nomes (minúsculas), com reserva/matrícula/parque. PURA. */
export function buildActivityDetailSql(opts: {
  from: string; to: string; userIds?: string[]; names?: string[]; cities?: string[]; limit?: number;
}): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const conds = [
    `h."actionTime" >= ${params.add(opts.from)}::timestamp`,
    `h."actionTime" < ${params.add(opts.to)}::timestamp`,
  ];
  const ids = Array.from(new Set((opts.userIds ?? []).map((s) => String(s ?? "").trim()).filter(Boolean))).slice(0, MAX_IDS);
  const names = Array.from(new Set((opts.names ?? []).map((s) => String(s ?? "").trim().toLowerCase()).filter(Boolean))).slice(0, MAX_IDS);
  const who: string[] = [];
  if (ids.length) who.push(`h."userId" IN (${ids.map((i) => params.add(i)).join(", ")})`);
  if (names.length) who.push(`lower(trim(${AGENT_NAME})) IN (${names.map((n) => params.add(n)).join(", ")})`);
  conds.push(who.length ? `(${who.join(" OR ")})` : "FALSE");
  const city = cityCondition(opts.cities, params);
  if (city) conds.push(city);
  const sql = [
    `SELECT h."bookingId" AS booking_id, h."changeType"::text AS change_type, ${ts(`h."actionTime"`)} AS action_time,`,
    `       ${AGENT_NAME} AS agent_name, v."licensePlate" AS plate, NULLIF(b."allocation", '') AS booking_code, p."name" AS park_name`,
    `  FROM "History" h`,
    ...JOINS,
    `  LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
    ` WHERE ${conds.join(" AND ")}`,
    ` ORDER BY h."actionTime", h."id"`,
    ` LIMIT ${params.add(Math.max(1, Math.min(opts.limit ?? ACTIVITY_DETAIL_LIMIT, ACTIVITY_DETAIL_LIMIT)))}`,
  ].join("\n");
  return { sql, params: params.values };
}

/** Mesmo formato da gaveta antiga (cópia local). PURA. */
export function mapActivityDetailRow(r: Record<string, unknown>) {
  return {
    bookingExternalId: String(r.booking_id ?? ""),
    changeType: String(r.change_type ?? "").toUpperCase(),
    actionTime: toIsoUtc(r.action_time) ?? String(r.action_time ?? ""),
    agentName: str(r.agent_name),
    licensePlate: str(r.plate),
    bookingNumber: str(r.booking_code),
    parkName: str(r.park_name),
  };
}
export type ActivityDetailRow = ReturnType<typeof mapActivityDetailRow>;

export async function getActivityDetailLive(
  opts: { from: string; to: string; userIds?: string[]; names?: string[]; cities?: string[] },
  query: Query = multiparkDbQuery,
): Promise<MultiparkRead<ActivityDetailRow[]>> {
  return safeMultiparkRead("atividade do dia (detalhe)", async () => {
    if (!(opts.userIds ?? []).some((x) => String(x ?? "").trim()) && !(opts.names ?? []).some((x) => String(x ?? "").trim())) return [];
    const { sql, params } = buildActivityDetailSql(opts);
    return (await query(sql, params)).map(mapActivityDetailRow);
  });
}

// ─── 3. Catálogo de agentes (History recente + "Agent") ─────────────────────

/**
 * Um agente por "userId": nomes do History (mais usado primeiro) e do
 * "Agent", email do convite, contagens desde `since`. Entram os que têm
 * ações desde `since` e os ativos no "Agent" (menos os só-parceiro). PURA.
 */
export function buildLiveAgentsSql(opts: { since: string; limit?: number }): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const since = params.add(opts.since);
  const sql = [
    `WITH hn AS (`,
    `  SELECT h."userId" AS uid, NULLIF(trim(h."agentName"), '') AS name, count(*) AS n,`,
    `         count(*) FILTER (WHERE h."changeType"::text = 'CHECK_IN') AS checkins,`,
    `         count(*) FILTER (WHERE h."changeType"::text = 'CHECK_OUT') AS checkouts,`,
    `         count(*) FILTER (WHERE h."changeType"::text = 'MOVEMENT') AS movements,`,
    `         min(h."actionTime") AS first_at, max(h."actionTime") AS last_at`,
    `    FROM "History" h`,
    `   WHERE h."actionTime" >= ${since}::timestamp AND h."userId" IS NOT NULL AND h."userId" <> ''`,
    `   GROUP BY 1, 2`,
    `), act AS (`,
    `  SELECT uid, sum(n) AS total, sum(checkins) AS checkins, sum(checkouts) AS checkouts, sum(movements) AS movements,`,
    `         min(first_at) AS first_at, max(last_at) AS last_at,`,
    `         array_remove(array_agg(name ORDER BY n DESC, name), NULL) AS names`,
    `    FROM hn GROUP BY uid`,
    `), ag AS (`,
    `  SELECT a."userId" AS uid,`,
    `         (array_agg(NULLIF(trim(a."name"), '') ORDER BY a."isActive" DESC, a."updatedAt" DESC))[1] AS name,`,
    `         bool_or(a."isActive") AS active, bool_and(a."role"::text = 'PARTNER') AS partner_only`,
    `    FROM "Agent" a GROUP BY a."userId"`,
    `)`,
    `SELECT COALESCE(act.uid, ag.uid) AS user_id, act.names AS history_names, ag.name AS agent_name,`,
    `       COALESCE(ag.active, false) AS active, COALESCE(act.total, 0) AS total, COALESCE(act.checkins, 0) AS checkins,`,
    `       COALESCE(act.checkouts, 0) AS checkouts, COALESCE(act.movements, 0) AS movements,`,
    `       ${ts("act.first_at")} AS first_at, ${ts("act.last_at")} AS last_at,`,
    `       (SELECT i."email" FROM "AgentInvite" i LEFT JOIN "Agent" a2 ON a2."id" = i."createdAgentId"`,
    `         WHERE (a2."userId" = COALESCE(act.uid, ag.uid) OR i."acceptedBy" = COALESCE(act.uid, ag.uid)) AND i."email" <> ''`,
    `         ORDER BY i."updatedAt" DESC LIMIT 1) AS email`,
    `  FROM act FULL OUTER JOIN ag ON ag.uid = act.uid`,
    ` WHERE act.uid IS NOT NULL OR (ag.active AND NOT ag.partner_only)`,
    ` ORDER BY total DESC, user_id`,
    ` LIMIT ${params.add(Math.max(1, Math.min(opts.limit ?? AGENT_LIST_LIMIT, AGENT_LIST_LIMIT)))}`,
  ].join("\n");
  return { sql, params: params.values };
}

export interface LiveAgent {
  agentUserId: string;
  /** Nome canónico: o mais usado no History, senão o do "Agent". */
  agentName: string | null;
  /** Todos os nomes (mais usado primeiro). */
  agentNames: string[];
  email: string | null;
  active: boolean;
  total: number;
  checkins: number;
  checkouts: number;
  movements: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

function pgArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean);
  const s = String(v ?? "").trim();
  if (!s || s === "{}") return [];
  // "{a,\"b c\"}" (driver sem conversão de arrays)
  return s.replace(/^\{|\}$/g, "").match(/"((?:[^"\\]|\\.)*)"|[^,]+/g)?.map((x) => x.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1").trim()).filter((x) => x && x !== "NULL") ?? [];
}

export function mapLiveAgentRow(r: Record<string, unknown>): LiveAgent | null {
  const id = str(r.user_id);
  if (!id) return null;
  const names = Array.from(new Set([...pgArray(r.history_names), ...(str(r.agent_name) ? [str(r.agent_name)!] : [])]));
  const email = str(r.email);
  return {
    agentUserId: id,
    agentName: names[0] ?? null,
    agentNames: names,
    email: email ? email.toLowerCase() : null,
    active: r.active === true || r.active === "t" || r.active === 1 || r.active === "true",
    total: int(r.total), checkins: int(r.checkins), checkouts: int(r.checkouts), movements: int(r.movements),
    firstSeen: toIsoUtc(r.first_at), lastSeen: toIsoUtc(r.last_at),
  };
}

/** "YYYY-MM-DD HH:MM:SS" UTC de há `days` dias. */
export function sinceUtc(days: number, nowMs: number = Date.now()): string {
  return new Date(nowMs - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

/** Catálogo vivo de agentes (últimos AGENTS_SEEN_DAYS dias + ativos). Nunca lança. */
export async function listLiveAgents(
  opts: { days?: number; nowMs?: number } = {},
  query: Query = multiparkDbQuery,
): Promise<MultiparkRead<LiveAgent[]>> {
  return safeMultiparkRead("agentes (catálogo)", async () => {
    const { sql, params } = buildLiveAgentsSql({ since: sinceUtc(opts.days ?? AGENTS_SEEN_DAYS, opts.nowMs) });
    return (await query(sql, params)).map(mapLiveAgentRow).filter((x): x is LiveAgent => !!x);
  });
}

/**
 * Id do agente para um nome: o "userId" mais usado com esse nome no History
 * recente; senão, um "Agent" com esse nome. PURA.
 */
export function buildAgentIdForNameSql(name: string, since: string): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const n = params.add(String(name ?? "").trim().toLowerCase().slice(0, 256));
  const s = params.add(since);
  const sql = [
    `SELECT x.user_id FROM (`,
    `  SELECT h."userId" AS user_id, count(*) AS n`,
    `    FROM "History" h`,
    ...JOINS.map((j) => `  ${j}`),
    `   WHERE h."actionTime" >= ${s}::timestamp AND h."userId" IS NOT NULL AND h."userId" <> ''`,
    `     AND lower(trim(${AGENT_NAME})) = ${n}`,
    `   GROUP BY 1`,
    `  UNION ALL`,
    `  SELECT a."userId", 0 FROM "Agent" a WHERE lower(trim(a."name")) = ${n}`,
    `) x GROUP BY x.user_id ORDER BY sum(x.n) DESC, x.user_id LIMIT 1`,
  ].join("\n");
  return { sql, params: params.values };
}

/**
 * Nome canónico de cada agente: o mais usado no History recente, senão o do
 * "Agent" (a linha ativa mais recente). PURA.
 */
export function buildAgentCanonicalNamesSql(userIds: string[], since: string): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const ids = Array.from(new Set(userIds.map((s) => String(s ?? "").trim()).filter(Boolean))).slice(0, MAX_IDS);
  const inList = ids.length ? ids.map((i) => params.add(i)).join(", ") : null;
  const s = params.add(since);
  const sql = [
    `SELECT x.user_id, (array_agg(x.name ORDER BY x.rank, x.n DESC, x.name))[1] AS name FROM (`,
    `  SELECT h."userId" AS user_id, NULLIF(trim(h."agentName"), '') AS name, count(*) AS n, 0 AS rank`,
    `    FROM "History" h`,
    `   WHERE ${inList ? `h."userId" IN (${inList})` : "FALSE"} AND h."actionTime" >= ${s}::timestamp AND NULLIF(trim(h."agentName"), '') IS NOT NULL`,
    `   GROUP BY 1, 2`,
    `  UNION ALL`,
    `  SELECT a."userId", NULLIF(trim(a."name"), ''), 0, CASE WHEN a."isActive" THEN 1 ELSE 2 END`,
    `    FROM "Agent" a WHERE ${inList ? `a."userId" IN (${inList})` : "FALSE"} AND NULLIF(trim(a."name"), '') IS NOT NULL`,
    `) x GROUP BY x.user_id`,
    ` LIMIT ${params.add(MAX_IDS)}`,
  ].join("\n");
  return { sql, params: params.values };
}

export async function getAgentNamesLive(userIds: string[], query: Query = multiparkDbQuery, nowMs?: number): Promise<MultiparkRead<Map<string, string>>> {
  return safeMultiparkRead("agentes (nomes)", async () => {
    const out = new Map<string, string>();
    if (!userIds.some((x) => String(x ?? "").trim())) return out;
    const { sql, params } = buildAgentCanonicalNamesSql(userIds, sinceUtc(AGENTS_SEEN_DAYS, nowMs));
    for (const r of await query(sql, params)) {
      const id = str(r.user_id), name = str(r.name);
      if (id && name) out.set(id, name);
    }
    return out;
  });
}

export async function findAgentIdForNameLive(name: string, query: Query = multiparkDbQuery, nowMs?: number): Promise<MultiparkRead<string | null>> {
  return safeMultiparkRead("agentes (id pelo nome)", async () => {
    if (!String(name ?? "").trim()) return null;
    const { sql, params } = buildAgentIdForNameSql(name, sinceUtc(AGENTS_SEEN_DAYS, nowMs));
    const [r] = await query(sql, params);
    return str(r?.user_id);
  });
}
