/**
 * P3 lote 37c/37d — Desempenho por pessoa: cobranças (Jorge, 6 out 2026:
 * "guarda quem regista as cobranças de parceiros"; "os Pro ficam numa coluna
 * à parte junto com as avenças"). As cobranças são registadas na Multipark,
 * que já guarda quem as registou:
 *   - "EntitySettlement": pagamentos marcados por um agente (source AGENT) a
 *     um parceiro, a um cliente Pro ou a uma avença → "recordedByUserId";
 *   - "PartnerCreditEntry": créditos de parceiro lançados → "createdByUserId".
 * Parceiros (acertos + créditos) → "Cobranças de parceiros"; Pro e avenças →
 * "Cobranças de Pro e avenças". Conta por agente e dia operacional, pela hora
 * em que ficou registado ("createdAt"). Duas leituras separadas: uma que
 * falhe não apaga a outra. Só leitura, com parâmetros e LIMIT.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList } from "./read";
import { MAX_AGENT_IDS, opDaySql } from "./movements";
import type { PerfMetric } from "../../shared/peoplePerformance";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;
export const PERF_PARTNER_CHARGES_LIMIT = 50_000;
/** Contas cobradas à parte (conta corrente) e a coluna onde cada uma conta. */
export const SETTLEMENT_METRIC = {
  PARTNER: "partnerCharges",
  PRO_CLIENT: "proPlanCharges",
  CLIENT_PLAN: "proPlanCharges",
} as const satisfies Record<string, PerfMetric>;
export type PartnerChargeKind = "settlements" | "credits";
export interface ChargeRow { userId: string; day: string; n: number; metric: PerfMetric }

/** PURA. `from`/`to` = "YYYY-MM-DD HH:MM:SS" UTC (as datas da Multipark não têm fuso). */
export function buildPartnerChargesSql(kind: PartnerChargeKind, o: { userIds: readonly string[]; from: string; to: string }): { sql: string; params: SqlParam[] } {
  const ids = [...new Set(o.userIds.map((x) => String(x ?? "").trim()).filter(Boolean))].slice(0, MAX_AGENT_IDS);
  if (!ids.length) throw new Error("Sem agentes.");
  const p = new ParamList();
  const [t, author] = kind === "settlements" ? [`"EntitySettlement" s`, `s."recordedByUserId"`] : [`"PartnerCreditEntry" s`, `s."createdByUserId"`];
  const where = [
    `${author} IN (${ids.map((x) => p.add(x)).join(", ")})`,
    `s."createdAt" >= ${p.add(o.from)}::timestamp AND s."createdAt" < ${p.add(o.to)}::timestamp`,
  ];
  if (kind === "settlements") {
    where.push(`s."entityType"::text IN (${Object.keys(SETTLEMENT_METRIC).map((x) => p.add(x)).join(", ")})`);
    where.push(`s."source"::text = ${p.add("AGENT")}`);
  }
  const sql = [
    `SELECT ${author} AS user_id, ${opDaySql(`s."createdAt"`)} AS day, ${kind === "settlements" ? `s."entityType"::text` : `'PARTNER'`} AS entity_type, count(*) AS n`,
    `  FROM ${t}`,
    ` WHERE ${where.join("\n   AND ")}`,
    ` GROUP BY 1, 2, 3`,
    ` LIMIT ${p.add(PERF_PARTNER_CHARGES_LIMIT)}`,
  ].join("\n");
  return { sql, params: p.values };
}

/** Por agente, dia e coluna: quantas cobranças (ou créditos de parceiro) registou. */
export async function readPartnerCharges(kind: PartnerChargeKind, o: { userIds: readonly string[]; fromMs: number; toMs: number }, query: Query = multiparkDbQuery): Promise<ChargeRow[]> {
  const all = [...new Set(o.userIds.filter(Boolean))];
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const out: ChargeRow[] = [];
  for (let i = 0; i < all.length; i += MAX_AGENT_IDS) {
    const { sql, params } = buildPartnerChargesSql(kind, { userIds: all.slice(i, i + MAX_AGENT_IDS), from: fmt(o.fromMs), to: fmt(o.toMs) });
    for (const r of await query<Record<string, unknown>>(sql, params)) {
      const metric = SETTLEMENT_METRIC[String(r.entity_type ?? "") as keyof typeof SETTLEMENT_METRIC];
      if (!metric) continue;
      out.push({ userId: String(r.user_id ?? ""), day: String(r.day ?? ""), n: Number(r.n ?? 0) || 0, metric });
    }
  }
  return out;
}
