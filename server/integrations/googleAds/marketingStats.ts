/**
 * Indicadores do Dashboard de Marketing — a partir da fonte única de métricas
 * (adMetrics.getAdMetrics) e das reservas REAIS da Multipark.
 *
 *  - Gasto = custo importado (API Google/Meta, senão legado). NUNCA orçamento
 *    × dias (isso é `budgetEstimate`, indicador separado). Separado por
 *    fornecedor: Google Ads, Meta e total.
 *  - Reservas: pela DATA DE CRIAÇÃO em dias de LISBOA (a coluna está em UTC),
 *    sem canceladas — a mesma regra e a mesma fronteira das Reservas &
 *    Operações (server/marketingSql.ts).
 *  - "Via anúncios" = adAttribution google_paid OU meta_paid (prova no link).
 *  - ROAS s/ IVA = receita ÷ (1 + IVA) ÷ gasto (FINANCE_PARAMS.vatRate). O
 *    ROAS que a Google reporta (valor de conversão ÷ gasto) mostra-se à parte.
 *  - "Outras despesas de marketing" = Despesas da categoria "Marketing" no
 *    período e âmbito (marketing_expenses não tinha caminho de escrita).
 */
import { projectScope } from '../../cityScope';
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { adAccounts, multiparkBookings, projects } from "../../../drizzle/schema";
import { brandNameForProject } from "../../../shared/adCampaignMapping";
import { roasNetOfVat } from "../../../shared/marketingRules";
import { lisbonDaySql } from "../../../shared/lisbonDay";
import { FINANCE_PARAMS } from "../../finance/rules";
import { inLisbonDaysSql, marketingProjectIds, notCancelledSql } from "../../marketingSql";
import { getAdMetrics, API_PROVIDERS, type AdMetricsResult } from "./adMetrics";
import { getConnection } from "./oauth";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** Origens em que a reserva é feita num site (onde o gclid/utm pode chegar) — ver shared/bookingOrigin.ts. */
export const SITE_ORIGINS = ["API", "GENERAL_FORM"];
const PAID = ["google_paid", "meta_paid"];
const rowsOf = <T = any>(r: any): T[] => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as T[];

export interface MarketingStatsFilters { from: string; to: string; projectId?: number }

/** Despesas da categoria "Marketing" (Despesas), no período e âmbito. */
export async function marketingCategoryExpenses(db: any, from: string, to: string, projectIds: number[] | null): Promise<number> {
  if (projectIds && !projectIds.length) return 0;
  const proj = projectIds ? sql` AND e.projectId IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
  const [m] = rowsOf<any>(await db.execute(sql`
    SELECT COALESCE(SUM(e.amount), 0) AS t
    FROM expenses e JOIN expense_categories c ON c.id = e.categoryId
    WHERE LOWER(TRIM(c.name)) = 'marketing' AND e.status <> 'cancelled'
      AND e.expenseDate >= ${`${from} 00:00:00`} AND e.expenseDate <= ${`${to} 23:59:59`}
      AND ${projectScope(sql`e.projectId`)}${proj}`));
  return Number(m?.t ?? 0);
}

export async function getMarketingStats(f: MarketingStatsFilters, preloadedAds?: AdMetricsResult) {
  if (!ISO.test(f.from) || !ISO.test(f.to)) throw new Error("Datas inválidas (AAAA-MM-DD)");
  const db = await getDb();
  const projectIds = await marketingProjectIds(f.projectId);
  const ads = preloadedAds ?? await getAdMetrics({ from: f.from, to: f.to, projectIds });
  const conn = await getConnection();
  const vat = FINANCE_PARAMS.vatRate;

  let bookingsTotal = 0, bookingsAttributed = 0, bookingsGoogle = 0, bookingsMeta = 0, revenueTotal = 0, revenueAttributed = 0, mktExpenses = 0;
  let bookingsByDay: Array<{ date: string; total: number; attributed: number }> = [];
  /** reservas ligadas por ID externo da campanha (Google ou Meta) */
  const attributedByCampaign: Record<string, number> = {};
  const attributionQuality = { siteBookings: 0, withOriginUrl: 0, withClickId: 0, attributed: 0 };
  if (db) {
    const conds: any[] = [
      notCancelledSql(multiparkBookings.status),
      inLisbonDaysSql(multiparkBookings.bookingCreatedAt, f.from, f.to),
      projectScope(multiparkBookings.projectId),
    ];
    if (projectIds) conds.push(projectIds.length ? inArray(multiparkBookings.projectId, projectIds) : sql`1 = 0`);
    const rows = await db.select({
      attr: multiparkBookings.adAttribution,
      n: sql<number>`COUNT(*)`,
      rev: sql<string>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    }).from(multiparkBookings).where(and(...conds)).groupBy(multiparkBookings.adAttribution);
    for (const r of rows) {
      const n = Number(r.n), rev = Number(r.rev);
      bookingsTotal += n; revenueTotal += rev;
      if (r.attr && PAID.includes(r.attr)) { bookingsAttributed += n; revenueAttributed += rev; }
      if (r.attr === "google_paid") bookingsGoogle += n;
      if (r.attr === "meta_paid") bookingsMeta += n;
    }
    // Por dia de LISBOA (a coluna está em UTC) — para o gráfico.
    const dayExpr = sql.raw(lisbonDaySql("multipark_bookings.bookingCreatedAt", f.from, f.to));
    const dayRows = await db.select({
      date: sql<string>`${dayExpr}`,
      n: sql<number>`COUNT(*)`,
      attributed: sql<number>`SUM(CASE WHEN ${multiparkBookings.adAttribution} IN ('google_paid', 'meta_paid') THEN 1 ELSE 0 END)`,
    }).from(multiparkBookings).where(and(...conds)).groupBy(sql`1`).orderBy(sql`1`);
    bookingsByDay = dayRows.map((r) => ({ date: String((r.date as any) instanceof Date ? (r.date as any).toISOString() : r.date).slice(0, 10), total: Number(r.n ?? 0), attributed: Number(r.attributed ?? 0) }));
    // Qualidade da atribuição (Google): das reservas feitas no SITE, quantas têm
    // link de origem, quantas trazem o clique do Google e quantas ficaram atribuídas.
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
    }).from(multiparkBookings).where(and(...conds, inArray(multiparkBookings.adAttribution, PAID as any), sql`${multiparkBookings.adCampaignExternalId} IS NOT NULL`))
      .groupBy(multiparkBookings.adCampaignExternalId);
    for (const r of campRows) if (r.ext) attributedByCampaign[String(r.ext)] = Number(r.n ?? 0);
    mktExpenses = await marketingCategoryExpenses(db, f.from, f.to, projectIds);
  }

  const spend = ads.totals.cost;
  const bookingsUnattributed = bookingsTotal - bookingsAttributed;
  const ratio = (num: number, den: number) => (den > 0 ? num / den : null);

  return {
    range: { from: f.from, to: f.to },
    connection: conn?.status ?? "disconnected",
    // Gasto (custo importado) por fornecedor e orçamento (indicador separado)
    spend,
    spendGoogle: ads.byProvider.google_ads,
    spendMeta: ads.byProvider.meta,
    spendOther: ads.byProvider.other,
    meta: ads.meta,
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
    bookingsTotal, bookingsAttributed, bookingsUnattributed, bookingsGoogle, bookingsMeta,
    revenueTotal, revenueAttributed,
    vatRate: vat,
    costPerAttributedBooking: ratio(spend, bookingsAttributed),
    /** ROAS das reservas ligadas, sem IVA */
    roasAttributedNet: roasNetOfVat(revenueAttributed, spend, vat),
    /** ROAS global (todas as reservas ÷ gasto), sem IVA — indicador, não atribuição */
    roasTotalNet: roasNetOfVat(revenueTotal, spend, vat),
    adCostPerBooking: ratio(spend, bookingsTotal),      // indicador GLOBAL — não atribui todas as reservas aos anúncios
    // Outros custos de marketing (Despesas, categoria Marketing), separados
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
  };
}

export interface BrandRow {
  brand: string;
  /** false = conta sem marca/cidade associada (aparece pelo nome da conta) */
  mapped: boolean;
  accounts: Array<{ id: number; name: string; provider: string }>;
  spend: number;
  spendGoogle: number;
  spendMeta: number;
  /** conversões contadas pela plataforma nas campanhas desta marca */
  conversions: number;
  bookings: number;
  attributed: number;
  revenue: number;
  /** valor das reservas que vieram pelos anúncios (gclid/fbclid/utm pago) */
  revenueAttributed: number;
  /** ROAS s/ IVA de todas as reservas da marca ÷ gasto */
  roasNet: number | null;
}

/**
 * Por marca: quanto se gastou por MARCA e quantas reservas Multipark houve
 * dessa marca no período — com o MESMO gasto do dashboard (getAdMetrics:
 * contas selecionadas, Google + Meta + legado, nacional repartido) e o MESMO
 * âmbito (cidades do utilizador ∩ projeto global escolhido). Com âmbito de
 * cidade, o gasto é o que foi imputado a essas cidades (nacional incluído
 * pela sua parte).
 */
export async function getSpendAndBookingsByBrand(f: { from: string; to: string; projectId?: number }, preloadedAds?: AdMetricsResult) {
  if (!ISO.test(f.from) || !ISO.test(f.to)) throw new Error("Datas inválidas (AAAA-MM-DD)");
  const db = await getDb();
  type CityRow = { projectId: number; spend: number; bookings: number; attributed: number; revenue: number; revenueAttributed: number };
  const empty = { range: { from: f.from, to: f.to }, accounts: [] as Array<{ id: number; name: string; provider: string }>, brands: [] as BrandRow[], byBrandCity: [] as CityRow[], bookingsWithoutBrand: 0, unassignedSpend: 0 };
  if (!db) return empty;
  const projectIds = await marketingProjectIds(f.projectId);
  const vat = FINANCE_PARAMS.vatRate;

  const allProjects = await db.select({ id: projects.id, name: projects.name, level: projects.level, parentId: projects.parentId }).from(projects);
  const accounts = await db.select({ id: adAccounts.id, name: adAccounts.name, projectId: adAccounts.projectId, provider: adAccounts.provider })
    .from(adAccounts).where(and(inArray(adAccounts.provider, [...API_PROVIDERS]), eq(adAccounts.selected, 1), eq(adAccounts.isManager, 0))).orderBy(adAccounts.name);
  const accountProject = new Map(accounts.map((a) => [a.id, a.projectId]));
  const ads = preloadedAds ?? await getAdMetrics({ from: f.from, to: f.to, projectIds });

  const bookingConds: any[] = [
    projectScope(multiparkBookings.projectId),
    notCancelledSql(multiparkBookings.status),
    inLisbonDaysSql(multiparkBookings.bookingCreatedAt, f.from, f.to),
  ];
  if (projectIds) bookingConds.push(projectIds.length ? inArray(multiparkBookings.projectId, projectIds) : sql`1 = 0`);
  const bookingRows = await db.select({
    projectId: multiparkBookings.projectId,
    n: sql<number>`COUNT(*)`,
    attributed: sql<number>`SUM(CASE WHEN ${multiparkBookings.adAttribution} IN ('google_paid', 'meta_paid') THEN 1 ELSE 0 END)`,
    rev: sql<string>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    revAttributed: sql<string>`COALESCE(SUM(CASE WHEN ${multiparkBookings.adAttribution} IN ('google_paid', 'meta_paid') THEN ${multiparkBookings.totalPrice} ELSE 0 END), 0)`,
  }).from(multiparkBookings).where(and(...bookingConds)).groupBy(multiparkBookings.projectId);

  const key = (name: string) => name.trim().toLowerCase();
  const brands = new Map<string, BrandRow>();
  const newRow = (brand: string, mapped: boolean): BrandRow => ({ brand, mapped, accounts: [], spend: 0, spendGoogle: 0, spendMeta: 0, conversions: 0, bookings: 0, attributed: 0, revenue: 0, revenueAttributed: 0, roasNet: null });
  if (!projectIds) {
    // sem âmbito: todas as contas aparecem (mesmo sem gasto no período)
    for (const a of accounts) {
      const brand = brandNameForProject(a.projectId, allProjects);
      const k = brand ? key(brand) : `conta:${a.id}`;
      const row = brands.get(k) ?? newRow(brand ?? (a.name ?? `Conta ${a.id}`), !!brand);
      row.accounts.push({ id: a.id, name: a.name ?? `Conta ${a.id}`, provider: a.provider });
      brands.set(k, row);
    }
  }
  // Gasto por CAMPANHA: marca = a do nó escolhido para a campanha; nacional ou
  // por associar → marca da conta; legado → marca do projeto da campanha antiga.
  for (const c of ads.byCampaign) {
    const chosen = !c.national && c.projectId != null ? c.projectId : null;
    const accProject = c.accountId != null ? accountProject.get(c.accountId) ?? null : null;
    const brand = brandNameForProject(chosen, allProjects) ?? brandNameForProject(accProject, allProjects);
    const k = brand ? key(brand) : c.accountId != null ? `conta:${c.accountId}` : "legado";
    const fallback = c.accountId != null ? (c.accountName ?? `Conta ${c.accountId}`) : "Sem marca (importações antigas)";
    const row = brands.get(k) ?? newRow(brand ?? fallback, !!brand);
    if (c.accountId != null && !row.accounts.some((a) => a.id === c.accountId)) {
      const a = accounts.find((x) => x.id === c.accountId);
      if (a) row.accounts.push({ id: a.id, name: a.name ?? `Conta ${a.id}`, provider: a.provider });
    }
    row.spend += c.cost;
    if (c.provider === "google_ads") row.spendGoogle += c.cost;
    if (c.provider === "meta") row.spendMeta += c.cost;
    row.conversions += c.conversions;
    brands.set(k, row);
  }
  // Nó marca (debaixo da cidade) de um projeto
  const byId = new Map(allProjects.map((p) => [p.id, p]));
  const brandNodeOf = (projectId: number | null): number | null => {
    if (projectId == null) return null;
    let node = byId.get(projectId); const seen = new Set<number>();
    while (node && node.level !== "brand") { if (seen.has(node.id) || node.parentId == null) return null; seen.add(node.id); node = byId.get(node.parentId); }
    return node ? node.id : null;
  };
  const byBrandCity = new Map<number, CityRow>();
  const cityRow = (node: number) => { const c = byBrandCity.get(node) ?? { projectId: node, spend: 0, bookings: 0, attributed: 0, revenue: 0, revenueAttributed: 0 }; byBrandCity.set(node, c); return c; };
  let unassignedSpend = 0;
  for (const d of ads.byDayProject) {
    const node = brandNodeOf(d.projectId);
    if (node == null) { unassignedSpend += d.cost; continue; }
    cityRow(node).spend += d.cost;
  }
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
      const c = cityRow(node);
      c.bookings += Number(r.n); c.attributed += Number(r.attributed ?? 0); c.revenue += Number(r.rev); c.revenueAttributed += Number(r.revAttributed ?? 0);
    }
  }
  for (const b of brands.values()) b.roasNet = roasNetOfVat(b.revenue, b.spend, vat);
  return {
    range: { from: f.from, to: f.to },
    accounts: accounts.map((a) => ({ id: a.id, name: a.name ?? `Conta ${a.id}`, provider: a.provider })),
    brands: Array.from(brands.values()).sort((a, b) => b.spend - a.spend || b.bookings - a.bookings),
    byBrandCity: Array.from(byBrandCity.values()),
    bookingsWithoutBrand,
    unassignedSpend,
    vatRate: vat,
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
    if (a.adAttribution !== "unknown") attributed++;
    await db.update(multiparkBookings).set({ ...attributionColumns(a), adAttributedAt: now }).where(eq(multiparkBookings.id, r.id));
  }
  const [rem] = await db.select({ n: sql<number>`COUNT(*)` }).from(multiparkBookings).where(and(sql`${multiparkBookings.originUrl} IS NOT NULL`, sql`${multiparkBookings.adAttribution} IS NULL`));
  return { scanned: rows.length, attributed, remaining: Number(rem?.n ?? 0) };
}
