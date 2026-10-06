/**
 * P3 lote 32a — Rádio × Multipark: as ações (History) dos agentes de quem
 * falou no rádio, numa janela à volta das mensagens. Só leitura, com
 * parâmetros e LIMIT.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList } from "./read";
import type { MpAction } from "../../shared/radioCross";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;
export const RADIO_ACTIONS_LIMIT = 3_000;

/** PURA. `from`/`to` = "YYYY-MM-DD HH:MM:SS" UTC. */
export function buildRadioActionsSql(o: { agentIds: readonly string[]; from: string; to: string }): { sql: string; params: SqlParam[] } {
  const ids = [...new Set(o.agentIds.filter(Boolean))].slice(0, 300);
  if (!ids.length) throw new Error("Sem agentes.");
  const p = new ParamList();
  const sql = [
    `SELECT h."userId" AS user_id, h."changeType"::text AS change_type, to_char(h."actionTime", 'YYYY-MM-DD HH24:MI:SS') AS at,`,
    `       NULLIF(b."allocation", '') AS booking_code, v."licensePlate" AS plate, pk."name" AS park_name`,
    `  FROM "History" h`,
    `  LEFT JOIN "Booking" b ON b."id" = h."bookingId"`,
    `  LEFT JOIN "Park" pk ON pk."id" = b."parkId"`,
    `  LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
    ` WHERE h."userId" IN (${ids.map((x) => p.add(x)).join(", ")})`,
    `   AND h."actionTime" >= ${p.add(o.from)}::timestamp AND h."actionTime" < ${p.add(o.to)}::timestamp`,
    ` ORDER BY h."actionTime", h."id"`,
    ` LIMIT ${p.add(RADIO_ACTIONS_LIMIT)}`,
  ].join("\n");
  return { sql, params: p.values };
}

/** PURA. */
export function mapRadioAction(r: Record<string, unknown>): MpAction | null {
  const at = Date.parse(`${String(r.at ?? "").replace(" ", "T")}Z`);
  const userId = String(r.user_id ?? "");
  if (!userId || !Number.isFinite(at)) return null;
  const s = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());
  return { userId, at, changeType: String(r.change_type ?? ""), bookingCode: s(r.booking_code), plate: s(r.plate), park: s(r.park_name) };
}

export async function readRadioActions(o: { agentIds: readonly string[]; fromMs: number; toMs: number }, query: Query = multiparkDbQuery): Promise<MpAction[]> {
  if (!o.agentIds.some(Boolean)) return [];
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const { sql, params } = buildRadioActionsSql({ agentIds: o.agentIds, from: fmt(o.fromMs), to: fmt(o.toMs) });
  return (await query<Record<string, unknown>>(sql, params)).map(mapRadioAction).filter((x): x is MpAction => !!x);
}
