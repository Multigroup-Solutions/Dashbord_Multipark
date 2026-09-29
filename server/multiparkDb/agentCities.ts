/**
 * Onde é que cada agente da Multipark costuma trabalhar: a cidade do parque
 * com mais ações dele no History dos últimos `days` dias. Só leitura; LIMIT.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList } from "./read";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export const AGENT_CITY_DAYS = 180;

/** PURA. `since` = "YYYY-MM-DD HH:MM:SS" UTC. */
export function buildAgentCitiesSql(o: { agentIds: readonly string[]; since: string }): { sql: string; params: SqlParam[] } {
  const ids = [...new Set(o.agentIds.filter(Boolean))].slice(0, 2000);
  if (!ids.length) throw new Error("Sem agentes.");
  const p = new ParamList();
  const list = ids.map((x) => p.add(x)).join(", ");
  const sql = [
    `SELECT h."userId" AS user_id, p."city" AS city, count(*) AS n`,
    `  FROM "History" h JOIN "Booking" b ON b."id" = h."bookingId" JOIN "Park" p ON p."id" = b."parkId"`,
    ` WHERE h."userId" IN (${list}) AND h."actionTime" >= ${p.add(o.since)}::timestamp AND p."city" IS NOT NULL AND p."city" <> ''`,
    ` GROUP BY 1, 2 LIMIT ${p.add(ids.length * 10)}`,
  ].join("\n");
  return { sql, params: p.values };
}

/** Agente → { cidade → nº de ações }. */
export async function readAgentCities(agentIds: readonly string[], nowMs = Date.now(), query: Query = multiparkDbQuery): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (!agentIds.some(Boolean)) return out;
  const since = new Date(nowMs - AGENT_CITY_DAYS * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const { sql, params } = buildAgentCitiesSql({ agentIds, since });
  for (const r of await query<Record<string, unknown>>(sql, params)) {
    const id = String(r.user_id ?? "");
    const m = out.get(id) ?? new Map<string, number>();
    m.set(String(r.city), (m.get(String(r.city)) ?? 0) + (Number(r.n ?? 0) || 0));
    out.set(id, m);
  }
  return out;
}
