/**
 * Parcerias por cidade — leitura AO VIVO (só leitura): reservas dos nossos
 * parques por parque × parceiro × método × campanha, desde uma data. O
 * mapeamento para a nossa parceria (e o parque → centro) faz-se do nosso lado
 * (server/partnerPresence.ts), com a mesma regra da campanha do Financeiro.
 * Regras de read.ts: SQL parametrizado, construtor PURO, LIMIT sempre.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList } from "./read";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export const PARTNER_PRESENCE_LIMIT = 50_000;

export interface PartnerPresenceRow {
  parkId: string; partnerId: string | null; partnerName: string | null; paymentMethod: string | null;
  discountCode: string | null; campaignName: string | null; count: number; lastCheckIn: string | null;
}

/** PURA. `since`: instante UTC "YYYY-MM-DD HH:MM:SS" (entradas a partir daí). */
export function buildPartnerPresenceSql(o: { parkIds: readonly string[]; since: string }): { sql: string; params: SqlParam[] } {
  if (!o.parkIds.length) throw new Error("Sem parques.");
  const p = new ParamList();
  const sql = [
    `SELECT b."parkId" AS park_id, b."partnerId" AS partner_id, NULLIF(pa."name", '') AS partner_name, NULLIF(b."paymentMethod", '') AS payment_method,`,
    `       NULLIF(ca."discountCode", '') AS discount_code, NULLIF(ca."name", '') AS campaign_name,`,
    `       count(*) AS n, to_char(max(b."checkIn"), 'YYYY-MM-DD HH24:MI:SS') AS last_check_in`,
    `  FROM "Booking" b`,
    `  LEFT JOIN "Partner" pa ON pa."id" = b."partnerId"`,
    `  LEFT JOIN "Campaign" ca ON ca."id" = b."campaignId"`,
    ` WHERE b."parkId" IN (${o.parkIds.map((id) => p.add(id)).join(", ")})`,
    `   AND b."status"::text <> 'PENDING'`,
    `   AND b."checkIn" >= ${p.add(o.since)}::timestamp`,
    `   AND (b."partnerId" IS NOT NULL OR NULLIF(b."paymentMethod", '') IS NOT NULL OR b."campaignId" IS NOT NULL)`,
    ` GROUP BY 1, 2, 3, 4, 5, 6`,
    ` LIMIT ${p.add(PARTNER_PRESENCE_LIMIT)}`,
  ].join("\n");
  return { sql, params: p.values };
}

const s = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());

export function mapPartnerPresenceRow(r: Record<string, unknown>): PartnerPresenceRow {
  return {
    parkId: String(r.park_id ?? ""), partnerId: s(r.partner_id), partnerName: s(r.partner_name), paymentMethod: s(r.payment_method),
    discountCode: s(r.discount_code), campaignName: s(r.campaign_name), count: Math.round(Number(r.n ?? 0)) || 0, lastCheckIn: s(r.last_check_in),
  };
}

/** Lança se a BD da Multipark falhar. */
export async function readPartnerPresence(o: { parkIds: readonly string[]; since: string }, query: Query = multiparkDbQuery): Promise<PartnerPresenceRow[]> {
  if (!o.parkIds.length) return [];
  const { sql, params } = buildPartnerPresenceSql(o);
  return (await query<Record<string, unknown>>(sql, params)).map(mapPartnerPresenceRow);
}
