/**
 * P3 lote 29f — Marketing nas contas (regra em shared/adInvoices.ts).
 *
 * O motor da Faturação passa a contar os ANÚNCIOS como despesa de marketing
 * por dia × projeto: o gasto das plataformas (Google Ads / Meta, das APIs) até
 * chegar a fatura; nos dias do PERÍODO DE CONSUMO de uma fatura, a fatura.
 * As faturas do Google/Meta deixam de contar como despesa normal (senão o
 * mesmo gasto contava duas vezes); sem período de consumo ficam num aviso.
 */
import { and, gte, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import { expenses } from "../../drizzle/schema";
import { AD_PLATFORM_NIFS } from "../../shared/marketingRules";
import { adPlatformOf, allocateAdCosts, validConsumptionPeriod, type AdCostRow, type AdInvoice } from "../../shared/adInvoices";

const nifList = AD_PLATFORM_NIFS.flatMap((n) => [n, n.slice(2)]);

/** A despesa é fatura do Google/Meta (mesma regra que isAdPlatformInvoice, em SQL). */
export function adInvoiceSql(): SQL {
  const nif = sql`UPPER(REPLACE(REPLACE(REPLACE(COALESCE(${expenses.supplierNif}, ''), ' ', ''), '.', ''), '-', ''))`;
  return sql`(${nif} IN (${sql.join(nifList.map((n) => sql`${n}`), sql`, `)}) OR LOWER(COALESCE(${expenses.supplier}, '')) REGEXP '(^|[^a-z])(google|meta platforms|facebook|instagram)([^a-z]|$)')`;
}

export interface AdCostsResult {
  rows: AdCostRow[];
  /** faturas do Google/Meta com data no período mas sem período de consumo (não contam) */
  invoicesWithoutPeriod: Array<{ id: number; supplier: string | null; amount: number; day: string }>;
  totals: { platform: number; invoice: number };
}

/**
 * Lê as faturas do Google/Meta e o gasto das plataformas e devolve o custo de
 * marketing por dia × projeto no período (no âmbito `projectIds`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadAdCosts(db: any, o: { from: string; to: string; projectIds: number[] | null }): Promise<AdCostsResult> {
  const fromStr = `${o.from} 00:00:00`, toStr = `${o.to} 23:59:59`;
  const live = sql`${expenses.status} <> 'cancelled' AND ${expenses.deletedAt} IS NULL`;
  const rows: any[] = await db.select({
    id: expenses.id, supplier: expenses.supplier, supplierNif: expenses.supplierNif, amount: expenses.amount, projectId: expenses.projectId,
    consumptionFrom: expenses.consumptionFrom, consumptionTo: expenses.consumptionTo, day: sql<string>`DATE(${expenses.expenseDate})`,
  }).from(expenses).where(and(live, adInvoiceSql(), or(
    and(isNotNull(expenses.consumptionFrom), isNotNull(expenses.consumptionTo), lte(expenses.consumptionFrom, o.to), gte(expenses.consumptionTo, o.from)),
    and(gte(expenses.expenseDate, fromStr), lte(expenses.expenseDate, toStr)),
  )!));
  const invoices: AdInvoice[] = [];
  const invoicesWithoutPeriod: AdCostsResult["invoicesWithoutPeriod"] = [];
  for (const r of rows ?? []) {
    const provider = adPlatformOf(r.supplier, r.supplierNif);
    if (!provider) continue;
    const pf = r.consumptionFrom ? String(r.consumptionFrom).slice(0, 10) : null;
    const pt = r.consumptionTo ? String(r.consumptionTo).slice(0, 10) : null;
    if (pf && pt && validConsumptionPeriod(pf, pt)) {
      if (pf <= o.to && pt >= o.from) invoices.push({ id: Number(r.id), provider, periodFrom: pf, periodTo: pt, amount: Number(r.amount ?? 0), projectId: r.projectId == null ? null : Number(r.projectId) });
    } else {
      const day = String(r.day ?? "").slice(0, 10);
      if (day >= o.from && day <= o.to) invoicesWithoutPeriod.push({ id: Number(r.id), supplier: r.supplier ?? null, amount: Number(r.amount ?? 0), day });
    }
  }
  const { getAdMetrics } = await import("../integrations/googleAds/adMetrics");
  const ads = await getAdMetrics({ from: o.from, to: o.to, projectIds: o.projectIds });
  // Base da proporção de cada fatura: o gasto TOTAL dessa plataforma no período dela (todos os projetos)
  const periodSpend = new Map<number, number>();
  for (const v of invoices) {
    const m = await getAdMetrics({ from: v.periodFrom, to: v.periodTo, projectIds: null });
    periodSpend.set(v.id, Number(m?.byProvider?.[v.provider] ?? 0));
  }
  const scope = o.projectIds ? new Set(o.projectIds) : null;
  const out = allocateAdCosts({
    from: o.from, to: o.to,
    spend: (ads as any)?.byDayProjectProvider ?? [],
    invoices, periodSpend,
    inScope: (pid) => !scope || (pid != null && scope.has(pid)),
  });
  const totals = { platform: 0, invoice: 0 };
  for (const r of out) { if (r.source === "fatura") totals.invoice += r.cost; else totals.platform += r.cost; }
  return { rows: out, invoicesWithoutPeriod, totals };
}

/** Condição para TIRAR as faturas do Google/Meta das despesas normais (contam via loadAdCosts). */
export function notAdInvoiceSql(): SQL {
  return sql`NOT ${adInvoiceSql()}`;
}
