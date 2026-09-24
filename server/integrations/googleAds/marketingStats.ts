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
import { adAccounts, adCampaigns, adDailyMetrics, marketingExpenses, multiparkBookings, projects } from "../../../drizzle/schema";
import { brandNameForProject } from "../../../shared/adCampaignMapping";
import { GOOGLE_ADS_PROVIDER } from "./config";
import { getAdMetrics } from "./adMetrics";
import { getConnection } from "./oauth";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** Origens em que a reserva é feita num site (onde o gclid/utm pode chegar) — ver shared/bookingOrigin.ts. */
export const SITE_ORIGINS = ["API", "GENERAL_FORM"];

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
  let bookingsByDay: Array<{ date: string; total: number; attributed: number }> = [];
  /** reservas ligadas (gclid) por ID externo da campanha Google */
  const attributedByCampaign: Record<string, number> = {};
  const attributionQuality = { siteBookings: 0, withOriginUrl: 0, withClickId: 0, attributed: 0 };
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
    // Por dia (data de criação, Lisboa = o que está na BD) — para o gráfico.
    const dayRows = await db.select({
      date: sql<string>`DATE_FORMAT(${multiparkBookings.bookingCreatedAt}, '%Y-%m-%d')`,
      n: sql<number>`COUNT(*)`,
      attributed: sql<number>`SUM(CASE WHEN ${multiparkBookings.adAttribution} = 'google_paid' THEN 1 ELSE 0 END)`,
    }).from(multiparkBookings).where(and(...conds))
      .groupBy(sql`DATE_FORMAT(${multiparkBookings.bookingCreatedAt}, '%Y-%m-%d')`)
      .orderBy(sql`DATE_FORMAT(${multiparkBookings.bookingCreatedAt}, '%Y-%m-%d')`);
    bookingsByDay = dayRows.map((r) => ({ date: String(r.date), total: Number(r.n ?? 0), attributed: Number(r.attributed ?? 0) }));
    // Qualidade da atribuição: das reservas feitas no SITE (as únicas que podem
    // trazer gclid/utm), quantas têm link de origem, quantas trazem o clique do
    // Google e quantas ficaram atribuídas. Se o link vem mas sem gclid, o site
    // (ou o auto-tagging do Google Ads) está a perder o identificador.
    const [q] = await db.select({
      site: sql<number>`COUNT(*)`,
      withUrl: sql<number>`SUM(CASE WHEN NULLIF(TRIM(${multiparkBookings.originUrl}), '') IS NOT NULL THEN 1 ELSE 0 END)`,
      withClick: sql<number>`SUM(CASE WHEN COALESCE(${multiparkBookings.gclid}, ${multiparkBookings.gbraid}, ${multiparkBookings.wbraid}) IS NOT NULL THEN 1 ELSE 0 END)`,
      attributed: sql<number>`SUM(CASE WHEN ${multiparkBookings.adAttribution} = 'google_paid' THEN 1 ELSE 0 END)`,
    }).from(multiparkBookings).where(and(...conds, inArray(multiparkBookings.origin, SITE_ORIGINS)));
    attributionQuality.siteBookings = Number(q?.site ?? 0);
    attributionQuality.withOriginUrl = Number(q?.withUrl ?? 0);
    attributionQuality.withClickId = Number(q?.withClick ?? 0);
    attributionQuality.attributed = Number(q?.attributed ?? 0);
    const campRows = await db.select({
      ext: multiparkBookings.adCampaignExternalId,
      n: sql<number>`COUNT(*)`,
    }).from(multiparkBookings).where(and(...conds, eq(multiparkBookings.adAttribution, "google_paid"), sql`${multiparkBookings.adCampaignExternalId} IS NOT NULL`))
      .groupBy(multiparkBookings.adCampaignExternalId);
    for (const r of campRows) if (r.ext) attributedByCampaign[String(r.ext)] = Number(r.n ?? 0);
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
    bookingsByDay,
    attributionQuality,
    attributedByCampaign,
    byCampaign: ads.byCampaign,
    nationalShares: ads.nationalShares,
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
  /** conversões contadas pela Google nas campanhas desta marca */
  conversions: number;
  bookings: number;
  attributed: number;
  revenue: number;
  /** valor das reservas que vieram pelos anúncios (gclid/utm pago) */
  revenueAttributed: number;
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
  const empty = { range: f, accounts: [] as Array<{ id: number; name: string }>, brands: [] as BrandRow[], byBrandCity: [] as Array<{ projectId: number; bookings: number; attributed: number; revenue: number; revenueAttributed: number }>, bookingsWithoutBrand: 0 };
  if (!db) return empty;

  const allProjects = await db.select({ id: projects.id, name: projects.name, level: projects.level, parentId: projects.parentId }).from(projects);
  const accounts = await db.select({ id: adAccounts.id, name: adAccounts.name, projectId: adAccounts.projectId })
    .from(adAccounts).where(and(eq(adAccounts.provider, GOOGLE_ADS_PROVIDER), eq(adAccounts.selected, 1))).orderBy(adAccounts.name);
  // Gasto por CAMPANHA (não por conta): a marca de uma campanha é a marca do nó
  // que lhe foi escolhido; só sem escolha (por associar) ou nacional é que cai
  // na marca da conta. Jorge, 16 set 2026: "identifiquei 2 campanhas da conta
  // Multipark como Airpark Faro e continuaram no Marketplace".
  const spendRows = await db.select({
    accountId: adDailyMetrics.accountId, campaignProjectId: adCampaigns.projectId, scope: adCampaigns.scope,
    cost: sql<string>`COALESCE(SUM(${adDailyMetrics.costMicros}), 0)`,
    conversions: sql<string>`COALESCE(SUM(${adDailyMetrics.conversions}), 0)`,
  }).from(adDailyMetrics)
    .leftJoin(adCampaigns, and(eq(adCampaigns.provider, adDailyMetrics.provider), eq(adCampaigns.accountId, adDailyMetrics.accountId), eq(adCampaigns.externalId, adDailyMetrics.campaignExternalId)))
    .where(and(eq(adDailyMetrics.provider, GOOGLE_ADS_PROVIDER), eq(adDailyMetrics.source, "api"), gte(adDailyMetrics.date, f.from), lte(adDailyMetrics.date, f.to)))
    .groupBy(adDailyMetrics.accountId, adCampaigns.projectId, adCampaigns.scope);
  const accountProject = new Map(accounts.map((a) => [a.id, a.projectId]));
  const bookingRows = await db.select({
    projectId: multiparkBookings.projectId,
    n: sql<number>`COUNT(*)`,
    attributed: sql<number>`SUM(CASE WHEN ${multiparkBookings.adAttribution} = 'google_paid' THEN 1 ELSE 0 END)`,
    rev: sql<string>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    revAttributed: sql<string>`COALESCE(SUM(CASE WHEN ${multiparkBookings.adAttribution} = 'google_paid' THEN ${multiparkBookings.totalPrice} ELSE 0 END), 0)`,
  }).from(multiparkBookings).where(and(
    projectScope(multiparkBookings.projectId),
    sql`${multiparkBookings.status} <> 'CANCELLED'`,
    gte(multiparkBookings.bookingCreatedAt, `${f.from} 00:00:00`),
    lte(multiparkBookings.bookingCreatedAt, `${f.to} 23:59:59`),
  )).groupBy(multiparkBookings.projectId);

  const key = (name: string) => name.trim().toLowerCase();
  const brands = new Map<string, BrandRow>();
  const newRow = (brand: string, mapped: boolean): BrandRow => ({ brand, mapped, accounts: [], spend: 0, conversions: 0, bookings: 0, attributed: 0, revenue: 0, revenueAttributed: 0 });
  for (const a of accounts) {
    const brand = brandNameForProject(a.projectId, allProjects);
    const k = brand ? key(brand) : `conta:${a.id}`;
    const row = brands.get(k) ?? newRow(brand ?? (a.name ?? `Conta ${a.id}`), !!brand);
    row.accounts.push({ id: a.id, name: a.name ?? `Conta ${a.id}` });
    brands.set(k, row);
  }
  for (const r of spendRows) {
    const accId = Number(r.accountId);
    if (!accountProject.has(accId)) continue;                    // conta não selecionada
    const chosen = r.scope !== "national" && r.campaignProjectId != null ? Number(r.campaignProjectId) : null;
    const brand = brandNameForProject(chosen, allProjects) ?? brandNameForProject(accountProject.get(accId) ?? null, allProjects);
    const k = brand ? key(brand) : `conta:${accId}`;
    const row = brands.get(k) ?? newRow(brand ?? `Conta ${accId}`, !!brand);
    row.spend += Number(r.cost) / 1_000_000;
    row.conversions += Number(r.conversions ?? 0);
    brands.set(k, row);
  }
  // Reservas por nó marca-cidade (para a lista por conta/cidade) e por marca
  const byBrandCity = new Map<number, { projectId: number; bookings: number; attributed: number; revenue: number; revenueAttributed: number }>();
  const brandNodeOf = (projectId: number | null): number | null => {
    if (projectId == null) return null;
    const byId = new Map(allProjects.map((p) => [p.id, p]));
    let node = byId.get(projectId); const seen = new Set<number>();
    while (node && node.level !== "brand") { if (seen.has(node.id) || node.parentId == null) return null; seen.add(node.id); node = byId.get(node.parentId); }
    return node ? node.id : null;
  };
  let bookingsWithoutBrand = 0;
  for (const r of bookingRows) {
    const brand = brandNameForProject(r.projectId ?? null, allProjects);
    if (!brand) { bookingsWithoutBrand += Number(r.n); continue; }
    const k = key(brand);
    const row = brands.get(k) ?? newRow(brand, true);
    row.bookings += Number(r.n); row.attributed += Number(r.attributed ?? 0); row.revenue += Number(r.rev); row.revenueAttributed += Number(r.revAttributed ?? 0);
    brands.set(k, row);
    const node = brandNodeOf(r.projectId ?? null);
    if (node != null) {
      const c = byBrandCity.get(node) ?? { projectId: node, bookings: 0, attributed: 0, revenue: 0, revenueAttributed: 0 };
      c.bookings += Number(r.n); c.attributed += Number(r.attributed ?? 0); c.revenue += Number(r.rev); c.revenueAttributed += Number(r.revAttributed ?? 0);
      byBrandCity.set(node, c);
    }
  }
  return {
    range: f,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name ?? `Conta ${a.id}` })),
    brands: Array.from(brands.values()).sort((a, b) => b.spend - a.spend || b.bookings - a.bookings),
    byBrandCity: Array.from(byBrandCity.values()),
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
