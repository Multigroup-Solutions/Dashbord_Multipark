/**
 * Tempos de entrega e de recolha (plano 62, P7) — as leituras da BD da
 * Multipark (SÓ LEITURA) para o trabalho `service-times`. Construtores de SQL
 * e mapeadores PUROS; quem corre é server/serviceTimesJob.ts.
 *
 * Regras (§6.2, auditor r2):
 *  - UMA leitura sequencial da "History" por corrida (não tem índice em
 *    "actionTime" nem em "bookingId"): os tipos precisos, a janela inteira
 *    (os MOVEMENT até 48 h depois do check-in e os "por arrumar" vêm nesta
 *    mesma leitura). NUNCA uma 2.ª leitura da History por `bookingId IN (…)`;
 *  - o resto por chave primária (Booking, Agent por userId, Driver por
 *    bookingId, que tem índice), em lotes de ≤ HISTORY_MAX_IDS ids;
 *  - sem CTE com junções; SQL sem barras invertidas (a guarda recusa-as) e as
 *    palavras proibidas só entre aspas;
 *  - do snapshot só três chaves; do modifiedFields só o que interessa,
 *    extraído no próprio Postgres (o estado de/para de um UPDATE, as garagens
 *    de um MOVEMENT): o texto inteiro nunca sai;
 *  - telefones só em memória (para cruzar com as chamadas), nunca gravados.
 */
import { type SqlParam } from "./client";
import { ParamList } from "./read";
import { movementKindSql } from "./movements";
import { HISTORY_MAX_IDS } from "./historyLive";
import { MOVEMENT_PATTERNS } from "../../shared/multiparkMovements";
import type { MovementKind } from "../../shared/multiparkMovements";
import type { ServiceEvent } from "../../shared/serviceTimes";

/** Os tipos da History que os ciclos usam (UPDATE só os que mexem no estado). */
export const SERVICE_HISTORY_TYPES = ["CHECKING_IN", "CHECK_IN", "MOVEMENT", "PENDING_CHECKOUT", "CHECKING_OUT", "CHECK_OUT", "CANCEL", "UPDATE"] as const;
/** Teto de linhas de uma leitura (3 dias ≈ 10–20 mil; um bloco de 7 dias do preenchimento para trás ≈ 40 mil). */
export const SERVICE_HISTORY_MAX_ROWS = 120_000;

const MF = `COALESCE(h."modifiedFields"::text, '')`;
/** Valor `from`/`to` de uma chave do modifiedFields, com as maiúsculas originais (sem aspas; ''/null → NULL). */
const sideSql = (key: string, side: "from" | "to") =>
  `NULLIF(NULLIF(trim(btrim(substring(${MF} from '${MOVEMENT_PATTERNS.side(key, side)}'), '"')), ''), 'null')`;
const tsMs = (col: string) => `to_char(${col}, 'YYYY-MM-DD HH24:MI:SS.MS')`;

/**
 * A leitura da History (uma por corrida): tipos precisos, janela [from, to)
 * em UTC, LIMIT. UPDATE só com "status" no modifiedFields. PURA.
 */
export function buildServiceHistorySql(o: { fromUtc: string; toUtc: string; limit?: number }): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const from = p.add(o.fromUtc), to = p.add(o.toUtc);
  const types = SERVICE_HISTORY_TYPES.map((t) => p.add(t)).join(", ");
  const statusLike = p.add('%"status"%');
  const limit = p.add(Math.min(Math.max(Math.floor(o.limit ?? SERVICE_HISTORY_MAX_ROWS), 1), SERVICE_HISTORY_MAX_ROWS));
  const type = `upper(h."changeType"::text)`;
  const sql = [
    `SELECT h."id" AS id, h."bookingId" AS booking_id, ${type} AS change_type, ${tsMs(`h."actionTime"`)} AS action_time,`,
    `       h."userId" AS agent_user_id, NULLIF(h."agentName", '') AS agent_name, NULLIF(h."platform"::text, '') AS platform,`,
    `       h."lat" AS lat, h."lng" AS lng,`,
    `       CASE WHEN ${type} = 'UPDATE' THEN upper(${sideSql("status", "from")}) END AS status_from,`,
    `       CASE WHEN ${type} = 'UPDATE' THEN upper(COALESCE(${sideSql("status", "to")}, h."snapshot"->>'status')) END AS status_to,`,
    `       CASE WHEN ${type} = 'MOVEMENT' THEN ${movementKindSql(MF)} END AS move_kind,`,
    `       CASE WHEN ${type} = 'MOVEMENT' THEN ${sideSql("garageName", "from")} END AS garage_from,`,
    `       CASE WHEN ${type} = 'MOVEMENT' THEN ${sideSql("garageName", "to")} END AS garage_to,`,
    `       h."snapshot"->>'arrivedAtDeliveryAt' AS snap_arrived,`,
    `       h."snapshot"->>'baggageWaitingAt' AS snap_baggage`,
    `  FROM "History" h`,
    ` WHERE h."actionTime" >= ${from}::timestamp AND h."actionTime" < ${to}::timestamp`,
    `   AND ${type} IN (${types})`,
    `   AND (${type} <> 'UPDATE' OR h."modifiedFields"::text LIKE ${statusLike})`,
    ` ORDER BY h."actionTime", h."id"`,
    ` LIMIT ${limit}`,
  ].join("\n");
  return { sql, params: p.values };
}

/** Instante "YYYY-MM-DD HH:MM:SS(.mmm)" UTC (ou ISO) → ms. PURA. */
export function utcTextMs(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  const s = String(v).trim();
  const withT = s.includes("T") ? s : s.replace(" ", "T");
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(withT) ? withT : `${withT}Z`);
  return Number.isFinite(ms) ? ms : null;
}

const str = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());
const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const MOVE_KINDS = new Set(["inicio", "arrumar", "lugar", "parques", "antigo"]);

/** Linha da leitura → ServiceEvent (null sem id/reserva/instante). PURA. */
export function mapServiceHistoryRow(r: Record<string, unknown>): ServiceEvent | null {
  const id = str(r.id), bookingId = str(r.booking_id), at = utcTextMs(r.action_time);
  if (!id || !bookingId || at == null) return null;
  const type = String(r.change_type ?? "").trim().toUpperCase();
  const lat = num(r.lat), lng = num(r.lng);
  const ev: ServiceEvent = {
    id, bookingId, type, at,
    agentUserId: str(r.agent_user_id), agentName: str(r.agent_name), platform: str(r.platform),
    lat: lat != null && lat !== 0 ? lat : null, lng: lng != null && lng !== 0 ? lng : null,
    snapArrivedAt: utcTextMs(r.snap_arrived), snapBaggageAt: utcTextMs(r.snap_baggage),
  };
  if (type === "UPDATE") { ev.statusFrom = str(r.status_from)?.toUpperCase() ?? null; ev.statusTo = str(r.status_to)?.toUpperCase() ?? null; }
  if (type === "MOVEMENT") {
    const k = str(r.move_kind);
    ev.moveKind = k && MOVE_KINDS.has(k) ? (k as MovementKind) : "antigo";
    ev.garageFrom = str(r.garage_from);
    ev.garageTo = str(r.garage_to);
  }
  return ev;
}

/** Ids em lotes de ≤ HISTORY_MAX_IDS (sem repetidos nem vazios). PURA. */
export function idBatches(ids: Iterable<string | null | undefined>, size = HISTORY_MAX_IDS): string[][] {
  const clean = Array.from(new Set([...ids].map((x) => String(x ?? "").trim()).filter(Boolean)));
  const out: string[][] = [];
  for (let i = 0; i < clean.length; i += size) out.push(clean.slice(i, i + size));
  return out;
}

/** Reservas por id (chave primária), com o telefone do cliente (por id, em memória). PURA. */
export function buildServiceBookingsSql(ids: readonly string[]): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const list = ids.map((x) => p.add(x)).join(", ");
  return {
    sql: [
      `SELECT b."id" AS id, b."parkId" AS park_id, b."status"::text AS status, NULLIF(b."deliveryType", '') AS delivery_type,`,
      `       NULLIF(b."allocation"::text, '') AS code, b."parkingType"::text AS parking_type, c."phoneNumber" AS client_phone`,
      `  FROM "Booking" b LEFT JOIN "Client" c ON c."id" = b."clientId"`,
      ` WHERE b."id" IN (${list || "NULL"})`,
    ].join("\n"),
    params: p.values,
  };
}

/** Condutores adicionais da reserva (só o telefone; "Driver" tem índice em "bookingId"). PURA. */
export function buildServiceDriverPhonesSql(ids: readonly string[]): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const list = ids.map((x) => p.add(x)).join(", ");
  return { sql: `SELECT d."bookingId" AS booking_id, d."phoneNumber" AS phone FROM "Driver" d WHERE d."bookingId" IN (${list || "NULL"})`, params: p.values };
}

/** Agentes (uma linha por pessoa e parque, com o papel). PURA. */
export function buildServiceAgentsSql(userIds: readonly string[]): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const list = userIds.map((x) => p.add(x)).join(", ");
  return { sql: `SELECT a."userId" AS user_id, a."parkId" AS park_id, a."role"::text AS role FROM "Agent" a WHERE a."userId" IN (${list || "NULL"})`, params: p.values };
}

/** Parques (todos; a tabela é pequena), com o centro. PURA. */
export function buildServiceParksSql(): { sql: string; params: SqlParam[] } {
  return {
    sql: `SELECT p."id" AS id, p."name" AS name, p."city" AS city, NULLIF(p."address", '') AS address, NULLIF(p."firebaseBrand", '') AS firebase_brand, p."listingType"::text AS listing_type, p."lat" AS lat, p."lng" AS lng FROM "Park" p ORDER BY p."name" LIMIT 1000`,
    params: [],
  };
}

export interface ServiceBookingRow { id: string; parkId: string | null; status: string | null; deliveryType: string | null; code: string | null; parkingType: string | null; clientPhone: string | null }
export function mapServiceBookingRow(r: Record<string, unknown>): ServiceBookingRow | null {
  const id = str(r.id);
  if (!id) return null;
  return { id, parkId: str(r.park_id), status: str(r.status), deliveryType: str(r.delivery_type), code: str(r.code), parkingType: str(r.parking_type), clientPhone: str(r.client_phone) };
}
