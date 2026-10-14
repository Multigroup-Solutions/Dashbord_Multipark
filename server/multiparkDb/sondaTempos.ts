/**
 * Plano 62, P0 — leituras da sonda dos tempos à BD da Multipark (SÓ LEITURA).
 *
 * Regras de read.ts: SQL parametrizado, construtores e mapeadores PUROS,
 * LIMIT sempre, sem barras invertidas, sem CTE com junções e com as palavras
 * da guarda (`set`, `start`, `do`…) só entre aspas. Todo o SQL daqui passa
 * `assertReadOnlySql` (testado).
 *
 * Por pedido (um dia operacional): UMA leitura da History (os tipos precisos,
 * a janela do dia − 6 h até + 48 h para os MOVEMENT; do `snapshot` só o
 * estado, o "Cheguei" e o "À espera das malas", nunca o retrato inteiro) e
 * leituras por chave: Booking, Agent, Client/Driver (só os telefones, que
 * ficam em memória), Park e Garage (tabelas pequenas).
 */
import { type SqlParam } from "./client";
import { ParamList } from "./read";
import { MOVEMENT_GARAGE_KEYS, MOVEMENT_PATTERNS, classifyMovement, placeValue, posixToJs } from "../../shared/multiparkMovements";
import type { ProbeEvent } from "../sondaTemposCompute";

/** Os tipos que a sonda lê da History. */
export const PROBE_HISTORY_TYPES = ["CHECKING_IN", "CHECK_IN", "MOVEMENT", "PENDING_CHECKOUT", "CHECKING_OUT", "CHECK_OUT", "CANCEL", "UPDATE"] as const;
/** Tipos que se leem até 48 h depois do dia (o resto só até ao fim do dia + 6 h). */
const LATE_TYPES = ["MOVEMENT", "UPDATE", "CANCEL"];
/** Teto de linhas por leitura da History. */
export const PROBE_HISTORY_LIMIT = 40_000;
/** Ids por leitura por chave (IN (…)). */
export const PROBE_IDS_PER_READ = 1000;

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");
const ts = (col: string) => `to_char(${col}, 'YYYY-MM-DD HH24:MI:SS.MS')`;

/** Parques com a posição (tabela pequena). PURA. */
export function buildProbeParksSql(): { sql: string; params: SqlParam[] } {
  return {
    sql: `SELECT p."id" AS id, p."name" AS name, p."city" AS city, NULLIF(p."address", '') AS address, NULLIF(p."firebaseBrand", '') AS firebase_brand, p."listingType"::text AS listing_type, p."status"::text AS status, p."lat" AS lat, p."lng" AS lng FROM "Park" p ORDER BY p."name" LIMIT 500`,
    params: [],
  };
}

/** Garagens (tabela pequena; ~21 linhas). PURA. */
export function buildProbeGaragesSql(): { sql: string; params: SqlParam[] } {
  return {
    sql: `SELECT g."name" AS name, g."parkingType"::text AS parking_type, g."parkId" AS park_id, left(g."mapLink", 600) AS map_link FROM "Garage" g ORDER BY g."name" LIMIT 500`,
    params: [],
  };
}

/**
 * A leitura da History do dia: [from, to) para MOVEMENT/UPDATE/CANCEL e
 * [from, coreTo) para o resto; UPDATE só quando muda o "status" (e só o
 * estado novo sai). As reservas pelos parques dados (semi-junção). PURA.
 */
export function buildProbeHistorySql(o: { parkIds: string[]; from: string; to: string; coreTo: string; limit?: number }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const parks = o.parkIds.map((id) => p.add(id)).join(", ");
  const from = p.add(o.from);
  const to = p.add(o.to);
  const core = p.add(o.coreTo);
  const limit = Math.min(Math.max(Math.floor(o.limit ?? PROBE_HISTORY_LIMIT) || 1, 1), PROBE_HISTORY_LIMIT);
  const statusTo = MOVEMENT_PATTERNS.side("status", "to");
  const sql = [
    `SELECT h."id" AS id, h."bookingId" AS booking_id, h."changeType"::text AS ct, ${ts(`h."actionTime"`)} AS at,`,
    `  h."userId" AS uid, NULLIF(h."agentName", '') AS agent_name, NULLIF(h."platform"::text, '') AS platform, h."lat" AS lat, h."lng" AS lng,`,
    `  (h."snapshot" IS NOT NULL) AS has_snapshot, h."snapshot"->>'status' AS snap_status,`,
    `  h."snapshot"->>'arrivedAtDeliveryAt' AS snap_arrived, h."snapshot"->>'baggageWaitingAt' AS snap_baggage,`,
    `  CASE WHEN h."changeType"::text = 'MOVEMENT' THEN left(h."modifiedFields", 4000) END AS move_fields,`,
    `  CASE WHEN h."changeType"::text = 'UPDATE' THEN substring(h."modifiedFields" from '${statusTo}') END AS update_to`,
    `FROM "History" h`,
    `WHERE h."actionTime" >= ${from}::timestamp AND h."actionTime" < ${to}::timestamp`,
    `  AND h."changeType"::text IN (${inList(PROBE_HISTORY_TYPES)})`,
    `  AND (h."actionTime" < ${core}::timestamp OR h."changeType"::text IN (${inList(LATE_TYPES)}))`,
    `  AND (h."changeType"::text <> 'UPDATE' OR position('"status"' in h."modifiedFields") > 0)`,
    `  AND h."bookingId" IN (SELECT b."id" FROM "Booking" b WHERE b."parkId" IN (${parks}))`,
    `ORDER BY h."actionTime", h."id"`,
    `LIMIT ${p.add(limit)}`,
  ].join("\n");
  return { sql, params: p.values };
}

const idsIn = (p: ParamList, ids: readonly string[]) => {
  const clean = Array.from(new Set(ids.map((x) => String(x ?? "").trim()).filter(Boolean))).slice(0, PROBE_IDS_PER_READ);
  return clean.length ? clean.map((x) => p.add(x)).join(", ") : null;
};

/** Reservas por id: parque, tipo de entrega e cliente (só o id). PURA. */
export function buildProbeBookingsSql(ids: readonly string[]): { sql: string; params: SqlParam[] } | null {
  const p = new ParamList();
  const list = idsIn(p, ids);
  if (!list) return null;
  return { sql: `SELECT b."id" AS id, b."parkId" AS park_id, NULLIF(b."deliveryType", '') AS delivery_type, b."clientId" AS client_id FROM "Booking" b WHERE b."id" IN (${list}) LIMIT ${p.add(PROBE_IDS_PER_READ)}`, params: p.values };
}

/** Agentes por utilizador: uma linha por (pessoa, parque) com o papel. PURA. */
export function buildProbeAgentsSql(userIds: readonly string[]): { sql: string; params: SqlParam[] } | null {
  const p = new ParamList();
  const list = idsIn(p, userIds);
  if (!list) return null;
  return { sql: `SELECT a."userId" AS uid, a."parkId" AS park_id, a."role"::text AS role FROM "Agent" a WHERE a."userId" IN (${list}) LIMIT 10000`, params: p.values };
}

/** Telefones dos clientes (só em memória). PURA. */
export function buildProbeClientPhonesSql(clientIds: readonly string[]): { sql: string; params: SqlParam[] } | null {
  const p = new ParamList();
  const list = idsIn(p, clientIds);
  if (!list) return null;
  return { sql: `SELECT c."id" AS id, c."phoneNumber" AS phone FROM "Client" c WHERE c."id" IN (${list}) LIMIT ${p.add(PROBE_IDS_PER_READ)}`, params: p.values };
}

/** Telefones dos condutores adicionais da reserva (só em memória). PURA. */
export function buildProbeDriverPhonesSql(bookingIds: readonly string[]): { sql: string; params: SqlParam[] } | null {
  const p = new ParamList();
  const list = idsIn(p, bookingIds);
  if (!list) return null;
  return { sql: `SELECT d."bookingId" AS booking_id, d."phoneNumber" AS phone FROM "Driver" d WHERE d."bookingId" IN (${list}) LIMIT 5000`, params: p.values };
}

/** A hora do Postgres (UTC), para o desvio do relógio (item 14). PURA. */
export function buildProbeClockSql(): { sql: string; params: SqlParam[] } {
  return { sql: `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS now_utc`, params: [] };
}

// ─── Mapeadores ─────────────────────────────────────────────────────────────

/** "YYYY-MM-DD HH:MM:SS(.mmm)" (UTC sem fuso) → ms; ISO com ou sem fuso; inválido → null. PURA. */
export function utcTextMs(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  const s = String(v).trim();
  const withT = s.includes("T") ? s : s.replace(" ", "T");
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(withT) ? withT : `${withT}Z`);
  return Number.isFinite(ms) ? ms : null;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const bool = (v: unknown) => v === true || v === 1 || v === "1" || v === "t" || v === "true";

const reCache = new Map<string, RegExp>();
const re = (pat: string) => { let r = reCache.get(pat); if (!r) { r = posixToJs(pat); reCache.set(pat, r); } return r; };
/** Garagem de/para de um MOVEMENT (os mesmos padrões do classifyMovement). PURA. */
export function movementGarages(text: string | null | undefined): { from: string | null; to: string | null } {
  const t = String(text ?? "");
  const side = (s: "from" | "to") => {
    for (const k of MOVEMENT_GARAGE_KEYS) {
      const v = placeValue(re(MOVEMENT_PATTERNS.side(k, s)).exec(t)?.[1]);
      if (v != null) return v;
    }
    return null;
  };
  return { from: side("from"), to: side("to") };
}

/** Uma linha da leitura da History → ProbeEvent (sem guardar o texto do modifiedFields). PURA. */
export function mapProbeHistoryRow(r: Record<string, unknown>): ProbeEvent | null {
  const id = str(r.id), bookingId = str(r.booking_id), type = str(r.ct)?.toUpperCase() ?? null;
  const atMs = utcTextMs(r.at);
  if (!id || !bookingId || !type || atMs == null) return null;
  let lat = num(r.lat), lng = num(r.lng);
  if (lat == null || lng == null || (lat === 0 && lng === 0) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { lat = null; lng = null; }
  const moveText = type === "MOVEMENT" ? String(r.move_fields ?? "") : null;
  const garages = moveText != null ? movementGarages(moveText) : { from: null, to: null };
  const upd = str(r.update_to);
  return {
    id, bookingId, type, atMs,
    uid: str(r.uid), agentName: str(r.agent_name), platform: str(r.platform),
    lat, lng,
    hasSnapshot: bool(r.has_snapshot),
    snapStatus: str(r.snap_status),
    snapArrivedMs: utcTextMs(r.snap_arrived),
    snapBaggageMs: utcTextMs(r.snap_baggage),
    moveKind: moveText != null ? classifyMovement(moveText) : null,
    garageFrom: garages.from,
    garageTo: garages.to,
    updateStatusTo: upd ? upd.replace(/^"+|"+$/g, "").trim().toUpperCase() || null : null,
  };
}
