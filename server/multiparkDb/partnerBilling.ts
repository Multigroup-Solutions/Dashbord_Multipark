/**
 * FATURAÇÃO DE PARCEIROS a partir da BD da Multipark (passo 2 — decisão do
 * dono, 29 set 2026: "fica tudo por lá"). Só leitura; regras de read.ts.
 *
 * Contam as reservas CONCLUÍDAS (CHECKED_OUT) com SAÍDA no período (mês =
 * mês da saída, hora de Lisboa), como a Faturação já fazia:
 *   - parceiros (agências/agregadores, nossos parques) por empresa
 *     ("Partner".userId): valor = o que o parceiro recebeu do cliente
 *     (partnerContributedAmount, senão o preço); A FATURAR = o NOSSO =
 *     partnerAmountDue gravado (sem ele, pela taxa gravada na reserva);
 *     "sem devido" = reservas sem o valor gravado;
 *   - Pro por cliente ("ProClient".clientId, ou o cliente da reserva Pro):
 *     A FATURAR = preço das reservas (o Pro paga no fim do mês);
 *   - avenças por plano ("ClientPlan".id): só contagem (a avença é o preço do plano);
 *   - MARKETPLACE (parques de terceiros em que vendemos): por parque, a
 *     COMISSÃO GRAVADA em cada reserva ("commissionAmount") — acabou o 80/20
 *     fixo: cada parque tem a sua (25 %, menos nos parques de rua…).
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { ParamList, safeMultiparkRead, type MultiparkRead } from "./read";
import { buildParksSql, mapParks } from "./dayBookings";

type Row = Record<string, unknown>;
type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export const BILLING_ROWS_LIMIT = 5000;
const DONE = `b."status"::text = 'CHECKED_OUT'`;
const VALUE = `COALESCE(b."partnerContributedAmount", b."bookingPrice")`;
const OURS = `COALESCE(b."partnerAmountDue", CASE
    WHEN b."partnerFeeType"::text = 'PERCENTAGE' AND b."partnerFeeValue" IS NOT NULL THEN ${VALUE} * (1 - b."partnerFeeValue" / 100.0)
    WHEN b."partnerFeeType"::text = 'FIXED' AND b."partnerFeeValue" IS NOT NULL THEN ${VALUE} - b."partnerFeeValue"
  END)`;
const OUR_SALE = `(b."origin"::text = 'MARKETPLACE' OR COALESCE(b."commissionAmount", 0) > 0)`;

/**
 * Uma só leitura (UNION ALL) com `kind` = partner | pro | plan | market.
 * `ourParks` = os nossos (parceiros, Pro, avenças); `thirdParks` = marketplace. PURA.
 */
export function buildPartnerBillingSql(o: { ourParks: readonly string[]; thirdParks: readonly string[]; start: string; end: string }): { sql: string; params: SqlParam[] } {
  const p = new ParamList();
  const start = p.add(o.start), end = p.add(o.end);
  const inPeriod = `b."checkOut" >= ${start}::timestamp AND b."checkOut" < ${end}::timestamp AND ${DONE}`;
  const parts: string[] = [];
  if (o.ourParks.length) {
    const ours = o.ourParks.map((id) => p.add(id)).join(", ");
    const where = `b."parkId" IN (${ours}) AND ${inPeriod}`;
    parts.push(
      [`SELECT 'partner' AS kind, pa."userId" AS key, max(NULLIF(pa."name", '')) AS name, count(*) AS n,`,
        `  SUM(${VALUE}) AS value, SUM(${OURS}) AS ours, count(*) FILTER (WHERE b."partnerAmountDue" IS NULL) AS missing, NULL::numeric AS commission`,
        `  FROM "Booking" b JOIN "Partner" pa ON pa."id" = b."partnerId" WHERE ${where} GROUP BY pa."userId"`].join("\n"),
      [`SELECT 'pro' AS kind, COALESCE(pc."clientId", b."clientId") AS key, max(NULLIF(pc."name", '')) AS name, count(*) AS n,`,
        `  SUM(b."bookingPrice") AS value, NULL::numeric AS ours, 0 AS missing, NULL::numeric AS commission`,
        `  FROM "Booking" b LEFT JOIN "ProClient" pc ON pc."id" = b."proClientId"`,
        `  WHERE ${where} AND b."clientPlanId" IS NULL AND (b."proClientId" IS NOT NULL OR b."pro" = true) GROUP BY 2`].join("\n"),
      [`SELECT 'plan' AS kind, b."clientPlanId" AS key, NULL AS name, count(*) AS n,`,
        `  SUM(b."bookingPrice") AS value, NULL::numeric AS ours, 0 AS missing, NULL::numeric AS commission`,
        `  FROM "Booking" b WHERE ${where} AND b."clientPlanId" IS NOT NULL GROUP BY 2`].join("\n"),
    );
  }
  if (o.thirdParks.length) {
    const third = o.thirdParks.map((id) => p.add(id)).join(", ");
    parts.push([`SELECT 'market' AS kind, b."parkId" AS key, NULL AS name, count(*) AS n,`,
      `  SUM(b."bookingPrice") AS value, NULL::numeric AS ours, count(*) FILTER (WHERE b."commissionAmount" IS NULL) AS missing, SUM(b."commissionAmount") AS commission`,
      `  FROM "Booking" b WHERE b."parkId" IN (${third}) AND ${inPeriod} AND ${OUR_SALE} GROUP BY 2`].join("\n"));
  }
  if (!parts.length) throw new Error("Sem parques.");
  return { sql: `${parts.join("\nUNION ALL\n")}\nLIMIT ${p.add(BILLING_ROWS_LIMIT)}`, params: p.values };
}

export interface BillingStats { n: number; value: number; ours: number | null; missing: number; name: string | null }
export interface MarketplaceBilling { parkId: string; parkName: string; city: string | null; bookings: number; value: number; commission: number; missing: number; rate: number | null }
export interface PartnerBillingLive {
  partners: Map<string, BillingStats>;
  pros: Map<string, BillingStats>;
  plans: Map<string, BillingStats>;
  marketplace: MarketplaceBilling[];
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Linhas → mapas por entidade + marketplace por parque. PURA. */
export function mapPartnerBilling(rows: Row[], parkName: Map<string, { name: string; city: string | null }>): PartnerBillingLive {
  const out: PartnerBillingLive = { partners: new Map(), pros: new Map(), plans: new Map(), marketplace: [] };
  for (const r of rows) {
    const key = String(r.key ?? "").trim();
    if (!key) continue;
    const kind = String(r.kind ?? "");
    const st: BillingStats = { n: Math.round(num(r.n)), value: round2(num(r.value)), ours: r.ours == null ? null : round2(num(r.ours)), missing: Math.round(num(r.missing)), name: r.name == null ? null : String(r.name) };
    if (kind === "partner") out.partners.set(key, st);
    else if (kind === "pro") out.pros.set(key, st);
    else if (kind === "plan") out.plans.set(key, st);
    else if (kind === "market") {
      const park = parkName.get(key);
      const commission = round2(num(r.commission));
      out.marketplace.push({ parkId: key, parkName: park?.name ?? key, city: park?.city ?? null, bookings: st.n, value: st.value, commission, missing: st.missing, rate: st.value > 0 ? Math.round((commission / st.value) * 1000) / 10 : null });
    }
  }
  out.marketplace.sort((a, b) => b.commission - a.commission || a.parkName.localeCompare(b.parkName, "pt"));
  return out;
}

/** Leitura (nunca lança). `cities` undefined = todas. `start`/`end` em UTC. */
export async function readPartnerBillingLive(o: { start: string; end: string; cities?: string[] }, query: Query = multiparkDbQuery): Promise<MultiparkRead<PartnerBillingLive>> {
  return safeMultiparkRead("faturação de parceiros", async () => {
    const parks = mapParks(await query(buildParksSql().sql), o.cities);
    const ourParks = parks.filter((x) => x.ours).map((x) => x.id);
    const thirdParks = parks.filter((x) => !x.ours).map((x) => x.id);
    if (!ourParks.length && !thirdParks.length) return { partners: new Map(), pros: new Map(), plans: new Map(), marketplace: [] };
    const { sql, params } = buildPartnerBillingSql({ ourParks, thirdParks, start: o.start, end: o.end });
    return mapPartnerBilling(await query(sql, params), new Map(parks.map((x) => [x.id, { name: x.name, city: x.cityName }])));
  });
}
