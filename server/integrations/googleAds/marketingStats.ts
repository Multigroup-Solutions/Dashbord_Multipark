/**
 * Indicadores do Dashboard de Marketing (plano, secção 3) — a partir da fonte
 * única de métricas (adMetrics) e das reservas REAIS da Multipark.
 *
 *  - Gasto = custo importado (API, senão legado). NUNCA orçamento × dias
 *    (isso é `budgetEstimate`, indicador separado).
 *  - Reservas: pela DATA DE CRIAÇÃO, sem canceladas. Totais ≠ atribuídas:
 *    "atribuídas" = adAttribution = google_paid (prova no originUrl);
 *    "sem atribuição" continua a contar no total.
 *  - Conversões Google são da Google; não substituem reservas.
 *  - ROAS de reservas atribuídas (receita atribuída / gasto) ≠ ROAS reportado
 *    pela Google (valor de conversão / gasto). Sem denominador → null.
 *  - Datas de calendário (strings), sem conversão UTC.
 */
import { projectScope, scopedProjectIds } from '../../cityScope';
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb, resolveProjectIds } from "../../db";
import { adAccounts, adDailyMetrics, marketingExpenses, multiparkBookings, projects } from "../../../drizzle/schema";
import { brandNameForProject } from "../../../shared/adCampaignMapping";
import { GOOGLE_ADS_PROVIDER } from "./config";
import { getAdMetrics } from "./adMetrics";
import { getConnection } from "./oauth";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface MarketingStatsFilters { from: string; to: string; projectId?: number }

export async function getMarketingStats(f: MarketingStatsFilters) {
  if (!ISO.test(f.from) || !ISO.test(f.to)) throw new Error("Datas inválidas (AAAA-MM-DD)");
  const db = await getDb();
  const requestedIds = f.projectId ? await resolveProjectIds(f.projectId) : null;
  const allowedIds = scopedProjectIds();
  const projectIds = allowedIds ? (requestedIds ? requestedIds.filter(id => allowedIds.includes(id)) : allowedIds) : requestedIds;
  const ads = await getAdMetrics({ from: f.from, to: f.to, projectIds });
  const conn = await getConnection();

  let bookingsTotal = 0, bookingsAttributed = 0, revenueTotal = 0, revenueAttributed = 0, mktExpenses = 0;
  if (db) {
    const conds: any[] = [
      sql`${multiparkBookings.status} <> 'CANCELLED'`,
      gte(multiparkBookings.bookingCreatedAt, `${f.from} 00:00:00`),
      lte(multiparkBookings.bookingCreatedAt, `${f.to} 23:59:59`),
    ];
    if (projectIds) conds.push(projectIds.length ? inArray(multiparkBookings.projectId, projectIds) : sql`1 = 0`);
    const rows = await db.select({
      attributed: sql<number>`CASE WHEN ${multiparkBookings.adAttribution} = 'google_paid' THEN 1 ELSE 0 END`,
      n: sql<number>`COUNT(*)`,
      rev: sql<string>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    }).from(multiparkBookings).where(and(...conds)).groupBy(sql`CASE WHEN ${multiparkBookings.adAttribution} = 'google_paid' THEN 1 ELSE 0 END`);
    for (const r of rows) {
      const n = Number(r.n), rev = Number(r.rev);
      bookingsTotal += n; revenueTotal += rev;
      if (Number(r.attributed) === 1) { bookingsAttributed += n; revenueAttributed += rev; }
    }
    const mktConds: any[] = [gte(marketingExpenses.date, `${f.from} 00:00:00`), lte(marketingExpenses.date, `${f.to} 23:59:59`)];
    if (projectIds) mktConds.push(projectIds.length ? inArray(marketingExpenses.projectId, projectIds) : sql`1 = 0`);
    const [m] = await db.select({ t: sql<string>`COALESCE(SUM(${marketingExpenses.amount}), 0)` }).from(marketingExpenses).where(and(...mktConds));
    mktExpenses = Number(m?.t ?? 0);
  }

  const spend = ads.totals.cost;
  const bookingsUnattributed = bookingsTotal - bookingsAttributed;
  const ratio = (num: number, den: number) => (den > 0 ? num / den : null);

  return {
    range: { from: f.from, to: f.to },
    connection: conn?.status ?? "disconnected",
    // Gasto (custo importado) e orçamento (indicador separado)
    spend,
    spendSource: ads.coverage.apiDays > 0 ? (ads.coverage.legacyDays > 0 ? "mixed" : "api") : ads.coverage.legacyDays > 0 ? "legacy" : "none",
    budgetEstimate: ads.budgetEstimate,
    impressions: ads.totals.impressions,
    clicks: ads.totals.clicks,
    cpc: ads.totals.cpc,
    ctr: ads.totals.ctr,
    // Google (da Google)
    conversionsGoogle: ads.totals.conversions,
    conversionValueGoogle: ads.totals.conversionValue,
    costPerConversionGoogle: ads.totals.costPerConversion,
    roasGoogle: ads.totals.roasGoogle,
    // Reservas reais (Multipark), pela data de criação
    bookingsTotal, bookingsAttributed, bookingsUnattributed,
    revenueTotal, revenueAttributed,
    costPerAttributedBooking: ratio(spend, bookingsAttributed),
    roasAttributed: ratio(revenueAttributed, spend),
    adCostPerBooking: ratio(spend, bookingsTotal),      // indicador GLOBAL — não atribui todas as reservas aos anúncios
    // Outros custos de marketing (faturas), separados
    mktExpenses,
    // Cobertura e qualidade
    coverage: ads.coverage,
    unmappedCampaigns: ads.unmappedCampaigns,
    byDay: ads.byDay,
    byCampaign: ads.byCampaign,
    // compatibilidade com o ecrã antigo
    totalSpend: spend,
    spendEstimated: false,
    totalReservations: ads.totals.conversions,
    totalRevenue: ads.totals.conversionValue,
    costPerReservation: ads.totals.costPerConversion ?? 0,
    avgConversionValue: ads.totals.conversions > 0 ? ads.totals.conversionValue / ads.totals.conversions : 0,
    totalMktExpenses: mktExpenses,
    campaignCount: ads.byCampaign.length,
    totalImpressions: ads.totals.impressions,
    totalClicks: ads.totals.clicks,
  };
}

export interface BrandRow {
  brand: string;
  /** false = conta Google sem marca/cidade associada (aparece pelo nome da conta) */
  mapped: boolean;
  accounts: Array<{ id: number; name: string }>;
  spend: number;
  bookings: number;
  attributed: number;
  revenue: number;
}

/**
 * Página principal do Marketing (Jorge, 16 set 2026): quanto se gastou por
 * MARCA (= conta Google Ads; Multipark.pt e Multipark SA são a marca
 * Marketplace) e quantas reservas Multipark houve dessa marca no período.
 *
 * Marca de uma conta = nó `brand` a que a conta está associada (ou o nó marca
 * acima do parque). Marca de uma reserva = nó marca acima do parque da
 * reserva. Reservas por data de criação, sem canceladas, dentro do âmbito de
 * cidade do utilizador.
 */
export async function getSpendAndBookingsByBrand(f: { from: string; to: string }) {
  if (!ISO.test(f.from) || !ISO.test(f.to)) throw new Error("Datas inválidas (AAAA-MM-DD)");
  const db = await getDb();
  const empty = { range: f, accounts: [] as Array<{ id: number; name: string }>, brands: [] as BrandRow[], bookingsWithoutBrand: 0 };
  if (!db) return empty;

  const allProjects = await db.select({ id: projects.id, name: projects.name, level: projects.level, parentId: projects.parentId }).from(projects);
  const accounts = await db.select({ id: adAccounts.id, name: adAccounts.name, projectId: adAccounts.projectId })
    .from(adAccounts).where(and(eq(adAccounts.provider, GOOGLE_ADS_PROVIDER), eq(adAccounts.selected, 1))).orderBy(adAccounts.name);
  const spendRows = await db.select({ accountId: adDailyMetrics.accountId, cost: sql<string>`COALESCE(SUM(${adDailyMetrics.costMicros}), 0)` })
    .from(adDailyMetrics)
    .where(and(eq(adDailyMetrics.provider, GOOGLE_ADS_PROVIDER), eq(adDailyMetrics.source, "api"), gte(adDailyMetrics.date, f.from), lte(adDailyMetrics.date, f.to)))
    .groupBy(adDailyMetrics.accountId);
  const spendByAccount = new Map(spendRows.map((r) => [Number(r.accountId), Number(r.cost) / 1_000_000]));
  const bookingRows = await db.select({
    projectId: multiparkBookings.projectId,
    n: sql<number>`COUNT(*)`,
    attributed: sql<number>`SUM(CASE WHEN ${multiparkBookings.adAttribution} = 'google_paid' THEN 1 ELSE 0 END)`,
    rev: sql<string>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
  }).from(multiparkBookings).where(and(
    projectScope(multiparkBookings.projectId),
    sql`${multiparkBookings.status} <> 'CANCELLED'`,
    gte(multiparkBookings.bookingCreatedAt, `${f.from} 00:00:00`),
    lte(multiparkBookings.bookingCreatedAt, `${f.to} 23:59:59`),
  )).groupBy(multiparkBookings.projectId);

  const key = (name: string) => name.trim().toLowerCase();
  const brands = new Map<string, BrandRow>();
  for (const a of accounts) {
    const brand = brandNameForProject(a.projectId, allProjects);
    const k = brand ? key(brand) : `conta:${a.id}`;
    const row = brands.get(k) ?? { brand: brand ?? (a.name ?? `Conta ${a.id}`), mapped: !!brand, accounts: [], spend: 0, bookings: 0, attributed: 0, revenue: 0 };
    row.accounts.push({ id: a.id, name: a.name ?? `Conta ${a.id}` });
    row.spend += spendByAccount.get(a.id) ?? 0;
    brands.set(k, row);
  }
  let bookingsWithoutBrand = 0;
  for (const r of bookingRows) {
    const brand = brandNameForProject(r.projectId ?? null, allProjects);
    if (!brand) { bookingsWithoutBrand += Number(r.n); continue; }
    const k = key(brand);
    const row = brands.get(k) ?? { brand, mapped: true, accounts: [], spend: 0, bookings: 0, attributed: 0, revenue: 0 };
    row.bookings += Number(r.n); row.attributed += Number(r.attributed ?? 0); row.revenue += Number(r.rev);
    brands.set(k, row);
  }
  return {
    range: f,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name ?? `Conta ${a.id}` })),
    brands: Array.from(brands.values()).sort((a, b) => b.spend - a.spend || b.bookings - a.bookings),
    bookingsWithoutBrand,
  };
}

/** Preenche a atribuição das reservas já sincronizadas que têm originUrl (lotes). */
export async function backfillBookingAttribution(limit = 500): Promise<{ scanned: number; attributed: number; remaining: number }> {
  const db = await getDb();
  if (!db) return { scanned: 0, attributed: 0, remaining: 0 };
  const { attributionFromUrl, attributionColumns } = await import("./attribution");
  const rows = await db.select({ id: multiparkBookings.id, originUrl: multiparkBookings.originUrl }).from(multiparkBookings)
    .where(and(sql`${multiparkBookings.originUrl} IS NOT NULL`, sql`${multiparkBookings.adAttribution} IS NULL`)).limit(limit);
  let attributed = 0;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  for (const r of rows) {
    const a = attributionFromUrl(r.originUrl);
    if (a.adAttribution === "google_paid") attributed++;
    await db.update(multiparkBookings).set({ ...attributionColumns(a), adAttributedAt: now }).where(eq(multiparkBookings.id, r.id));
  }
  const [rem] = await db.select({ n: sql<number>`COUNT(*)` }).from(multiparkBookings).where(and(sql`${multiparkBookings.originUrl} IS NOT NULL`, sql`${multiparkBookings.adAttribution} IS NULL`));
  return { scanned: rows.length, attributed, remaining: Number(rem?.n ?? 0) };
}
