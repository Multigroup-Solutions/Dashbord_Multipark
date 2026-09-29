/**
 * Histórico das reservas (tabela "History" da Multipark) AO VIVO — substitui a
 * cópia `multipark_booking_history`, congelada desde o #141 (27 set 2026).
 *
 * Uma só consulta com filtros opcionais (reserva, matrícula, agente, período,
 * tipo, texto, cidades) que devolve as linhas no MESMO formato da cópia
 * (bookingExternalId, historyId, changeType, actionTime "YYYY-MM-DD HH:MM:SS"
 * UTC, remarks, agentName, agentUserId, modifiedFields, platform) mais a
 * reserva (código, matrícula, parque, cidade, estado). Assim os ecrãs antigos
 * (Perdidos & Achados, Reclamações, Avaliações, Passagem de turno…) mudam só
 * a fonte, não as contas.
 *
 * ⚠️ A "History" não tem índices além da PK (pedido à Multipark: índices em
 * "actionTime" e "bookingId"). Com ~280 mil linhas lê-se em segundos; há
 * sempre LIMIT e, quando se pode, um período.
 * Regras de read.ts: SQL parametrizado, construtores PUROS, só leitura.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, cityAliases, likeContains, normalizePlate } from "./read";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export const HISTORY_MAX_LIMIT = 5000;
export const HISTORY_MAX_IDS = 1000;

export interface LiveHistoryFilters {
  bookingIds?: string[];
  /** matrícula: exata (normalizada) ou "contém" */
  plate?: { exact?: string; contains?: string };
  userIds?: string[];
  /** nome do agente: exato (sem maiúsculas) ou "contém" */
  agentName?: { exact?: string; contains?: string };
  /** instantes UTC "YYYY-MM-DD HH:MM:SS": [from, to) */
  from?: string;
  to?: string;
  changeTypes?: string[];
  /** reserva, matrícula, agente ou tipo "contém" */
  text?: string;
  /** Park.city (undefined = todas; [] = nenhuma) */
  cities?: string[];
  limit: number;
  order?: "asc" | "desc";
}

const ts = (col: string) => `to_char(${col}, 'YYYY-MM-DD HH24:MI:SS')`;
/** Matrícula da reserva normalizada (só letras e números, maiúsculas). */
const PLATE_NORM = `upper(regexp_replace(coalesce(v."licensePlate", ''), '[^A-Za-z0-9]', '', 'g'))`;

function ids(p: ParamList, list: string[] | undefined, col: string): string | null {
  if (list === undefined) return null;
  const clean = Array.from(new Set(list.map((s) => String(s ?? "").trim()).filter(Boolean))).slice(0, HISTORY_MAX_IDS);
  return clean.length ? `${col} IN (${clean.map((x) => p.add(x)).join(", ")})` : "FALSE";
}

/** Condições (WHERE) dos filtros. PURA. */
function whereOf(f: LiveHistoryFilters, p: ParamList): string {
  const c: string[] = [];
  const b = ids(p, f.bookingIds, `h."bookingId"`); if (b) c.push(b);
  const u = ids(p, f.userIds, `h."userId"`); if (u) c.push(u);
  if (f.plate?.exact) c.push(`${PLATE_NORM} = ${p.add(normalizePlate(f.plate.exact))}`);
  else if (f.plate?.contains) c.push(`${PLATE_NORM} LIKE ${p.add(likeContains(normalizePlate(f.plate.contains)))}`);
  if (f.agentName?.exact) c.push(`lower(trim(h."agentName")) = ${p.add(f.agentName.exact.trim().toLowerCase())}`);
  else if (f.agentName?.contains) c.push(`h."agentName" ILIKE ${p.add(likeContains(f.agentName.contains.trim()))}`);
  if (f.from) c.push(`h."actionTime" >= ${p.add(f.from)}::timestamp`);
  if (f.to) c.push(`h."actionTime" < ${p.add(f.to)}::timestamp`);
  if (f.changeTypes?.length) c.push(`upper(h."changeType"::text) IN (${f.changeTypes.map((t) => p.add(t.toUpperCase())).join(", ")})`);
  if (f.text?.trim()) {
    const t = p.add(likeContains(f.text.trim()));
    c.push(`(h."bookingId" ILIKE ${t} OR v."licensePlate" ILIKE ${t} OR h."agentName" ILIKE ${t} OR h."changeType"::text ILIKE ${t} OR b."allocation"::text ILIKE ${t})`);
  }
  if (f.cities !== undefined) {
    const al = cityAliases(f.cities);
    c.push(al.length ? `lower(trim(pk."city")) IN (${al.map((x) => p.add(x)).join(", ")})` : "FALSE");
  }
  return c.length ? c.join("\n   AND ") : "TRUE";
}

const FROM = [
  `  FROM "History" h`,
  `  LEFT JOIN "Booking" b ON b."id" = h."bookingId"`,
  `  LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
  `  LEFT JOIN "Park" pk ON pk."id" = b."parkId"`,
].join("\n");

/** Linhas do histórico com a reserva. PURA. */
export function buildLiveHistorySql(f: LiveHistoryFilters): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const where = whereOf(f, p);
  const limit = Math.min(Math.max(Math.floor(f.limit) || 1, 1), HISTORY_MAX_LIMIT);
  const dir = f.order === "asc" ? "ASC" : "DESC";
  const sql = [
    `SELECT h."id" AS history_id, h."bookingId" AS booking_id, h."changeType"::text AS change_type, ${ts(`h."actionTime"`)} AS action_time,`,
    `       left(h."remarks", 1000) AS remarks, NULLIF(h."agentName", '') AS agent_name, h."userId" AS agent_user_id,`,
    `       left(h."modifiedFields"::text, 1000) AS modified_fields, NULLIF(h."platform"::text, '') AS platform,`,
    `       NULLIF(b."allocation"::text, '') AS booking_code, v."licensePlate" AS plate, pk."name" AS park_name, pk."city" AS city,`,
    `       b."status"::text AS booking_status, ${ts(`b."checkIn"`)} AS check_in, ${ts(`b."checkOut"`)} AS check_out`,
    FROM,
    ` WHERE ${where}`,
    ` ORDER BY h."actionTime" ${dir}, h."id" ${dir}`,
    ` LIMIT ${p.add(limit)}`,
  ].join("\n");
  return { sql, params: p.values };
}

/** Contagens por agente (total, entradas, saídas, movimentos). PURA. */
export function buildLiveHistoryByAgentSql(f: Omit<LiveHistoryFilters, "limit" | "order"> & { limit?: number }): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const where = whereOf({ ...f, limit: 1 }, p);
  const sql = [
    `SELECT NULLIF(h."agentName", '') AS agent_name, max(h."userId") AS agent_user_id, count(*) AS total,`,
    `       count(*) FILTER (WHERE upper(h."changeType"::text) = 'CHECK_IN') AS checkins,`,
    `       count(*) FILTER (WHERE upper(h."changeType"::text) = 'CHECK_OUT') AS checkouts,`,
    `       count(*) FILTER (WHERE upper(h."changeType"::text) = 'MOVEMENT') AS movements`,
    FROM,
    ` WHERE ${where}`,
    ` GROUP BY 1`,
    ` ORDER BY 3 DESC`,
    ` LIMIT ${p.add(Math.min(Math.max(Math.floor(f.limit ?? 2000) || 1, 1), HISTORY_MAX_LIMIT))}`,
  ].join("\n");
  return { sql, params: p.values };
}

export interface LiveHistoryRow {
  historyId: string;
  bookingExternalId: string;
  changeType: string | null;
  /** UTC "YYYY-MM-DD HH:MM:SS" (como a cópia) */
  actionTime: string | null;
  remarks: string | null;
  agentName: string | null;
  agentUserId: string | null;
  /** não existe na BD da Multipark (os utilizadores vivem noutro sistema) */
  agentEmail: null;
  modifiedFields: string | null;
  platform: string | null;
  bookingCode: string | null;
  licensePlate: string | null;
  parkName: string | null;
  city: string | null;
  bookingStatus: string | null;
  checkIn: string | null;
  checkOut: string | null;
}

const s = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v));

export function mapLiveHistoryRow(r: Record<string, unknown>): LiveHistoryRow {
  return {
    historyId: String(r.history_id ?? ""), bookingExternalId: String(r.booking_id ?? ""), changeType: s(r.change_type),
    actionTime: s(r.action_time), remarks: s(r.remarks), agentName: s(r.agent_name), agentUserId: s(r.agent_user_id), agentEmail: null,
    modifiedFields: s(r.modified_fields), platform: s(r.platform), bookingCode: s(r.booking_code), licensePlate: s(r.plate),
    parkName: s(r.park_name), city: s(r.city), bookingStatus: s(r.booking_status), checkIn: s(r.check_in), checkOut: s(r.check_out),
  };
}

export interface LiveHistoryAgentRow { agentName: string | null; agentUserId: string | null; total: number; checkins: number; checkouts: number; movements: number }

export function mapLiveHistoryAgentRow(r: Record<string, unknown>): LiveHistoryAgentRow {
  const n = (v: unknown) => Math.round(Number(v ?? 0)) || 0;
  return { agentName: s(r.agent_name), agentUserId: s(r.agent_user_id), total: n(r.total), checkins: n(r.checkins), checkouts: n(r.checkouts), movements: n(r.movements) };
}

/** Histórico ao vivo. Lança se a BD da Multipark não responder (quem chama decide). */
export async function readLiveHistory(f: LiveHistoryFilters, query: Query = multiparkDbQuery): Promise<LiveHistoryRow[]> {
  const { sql, params } = buildLiveHistorySql(f);
  return (await query<Record<string, unknown>>(sql, params)).map(mapLiveHistoryRow);
}

export async function readLiveHistoryByAgent(f: Omit<LiveHistoryFilters, "limit" | "order"> & { limit?: number }, query: Query = multiparkDbQuery): Promise<LiveHistoryAgentRow[]> {
  const { sql, params } = buildLiveHistoryByAgentSql(f);
  return (await query<Record<string, unknown>>(sql, params)).map(mapLiveHistoryAgentRow);
}
