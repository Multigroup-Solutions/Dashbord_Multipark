/**
 * P3 lote 37b — Desempenho por pessoa: voos de regresso registados na
 * Multipark (alterações à reserva que mexeram no voo de regresso), por
 * agente e dia operacional. Só leitura, com parâmetros e LIMIT.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList } from "./read";
import { MAX_AGENT_IDS, opDaySql } from "./movements";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;
export const PERF_RETURN_FLIGHTS_LIMIT = 50_000;

/** PURA. `from`/`to` = "YYYY-MM-DD HH:MM:SS" UTC (o History não tem fuso). */
export function buildReturnFlightsSql(o: { userIds: readonly string[]; from: string; to: string }): { sql: string; params: SqlParam[] } {
  const ids = [...new Set(o.userIds.map((x) => String(x ?? "").trim()).filter(Boolean))].slice(0, MAX_AGENT_IDS);
  if (!ids.length) throw new Error("Sem agentes.");
  const p = new ParamList();
  const sql = [
    `SELECT h."userId" AS user_id, ${opDaySql(`h."actionTime"`)} AS day, count(*) AS n`,
    `  FROM "History" h`,
    ` WHERE h."userId" IN (${ids.map((x) => p.add(x)).join(", ")})`,
    `   AND h."actionTime" >= ${p.add(o.from)}::timestamp AND h."actionTime" < ${p.add(o.to)}::timestamp`,
    `   AND h."changeType"::text = 'UPDATE' AND h."modifiedFields" ILIKE '%returnFlight%'`,
    ` GROUP BY 1, 2`,
    ` LIMIT ${p.add(PERF_RETURN_FLIGHTS_LIMIT)}`,
  ].join("\n");
  return { sql, params: p.values };
}

/** Por agente e dia: quantas vezes registou/alterou o voo de regresso. */
export async function readReturnFlights(o: { userIds: readonly string[]; fromMs: number; toMs: number }, query: Query = multiparkDbQuery): Promise<Array<{ userId: string; day: string; n: number }>> {
  const all = [...new Set(o.userIds.filter(Boolean))];
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const out: Array<{ userId: string; day: string; n: number }> = [];
  for (let i = 0; i < all.length; i += MAX_AGENT_IDS) {
    const { sql, params } = buildReturnFlightsSql({ userIds: all.slice(i, i + MAX_AGENT_IDS), from: fmt(o.fromMs), to: fmt(o.toMs) });
    for (const r of await query<Record<string, unknown>>(sql, params)) {
      out.push({ userId: String(r.user_id ?? ""), day: String(r.day ?? ""), n: Number(r.n ?? 0) || 0 });
    }
  }
  return out;
}
