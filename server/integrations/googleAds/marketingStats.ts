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
 *  - ROAS s/ IVA = receita ÷ (1 + IVA) ÷ gasto, com o IVA das Definições em
 *    vigor no fim do período (finance/rates.ts → vatRateForPeriod). O
 *    ROAS que a Google reporta (valor de conversão ÷ gasto) mostra-se à parte.
 *  - "Outras despesas de marketing" = Despesas da categoria "Marketing" no
 *    período e âmbito, SEM as faturas do Google/Meta (19a: o gasto delas já
 *    vem das APIs — somá-las contava-o duas vezes). As faturas aparecem à
 *    parte (`adInvoicesInExpenses`), só como informação.
 *  - Reservas da Multipark em baixo (19a): o gasto (nosso) mostra-se na mesma
 *    e as reservas vêm a null com `bookingsError` — nunca 0 reservas.
 */
import { projectScope } from '../../cityScope';
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { adAccounts, projects } from "../../../drizzle/schema";
import { brandNameForProject } from "../../../shared/adCampaignMapping";
import { isAdPlatformInvoice, roasNetOfVat } from "../../../shared/marketingRules";
import { lisbonDaySql } from "../../../shared/lisbonDay";
import { vatRateForPeriod } from "../../finance/rates";
import { inLisbonDaysSql, marketingProjectIds, notCancelledSql } from "../../marketingSql";
import { getAdMetrics, API_PROVIDERS, type AdMetricsResult } from "./adMetrics";
import { getConnection } from "./oauth";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** Origens em que a reserva é feita num site (onde o gclid/utm pode chegar) — ver shared/bookingOrigin.ts. */
export const SITE_ORIGINS = ["API", "GENERAL_FORM"];
const PAID = ["google_paid", "meta_paid"];
const rowsOf = <T = any>(r: any): T[] => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as T[];

export interface MarketingStatsFilters { from: string; to: string; projectId?: number }

/**
 * Despesas da categoria "Marketing" (Despesas), no período e âmbito, separadas
 * em faturas das plataformas de anúncios (Google/Meta — já contam no gasto das
 * APIs) e outras (agências, impressos…). Só as outras entram no custo total.
 */
export async function marketingCategoryExpenses(db: any, from: string, to: string, projectIds: number[] | null): Promise<{ other: number; adInvoices: number }> {
  if (projectIds && !projectIds.length) return { other: 0, adInvoices: 0 };
  const proj = projectIds ? sql` AND e.projectId IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
  const rows = rowsOf<any>(await db.execute(sql`
    SELECT e.supplier, e.supplierNif, COALESCE(SUM(e.amount), 0) AS t
    FROM expenses e JOIN expense_categories c ON c.id = e.categoryId
    WHERE LOWER(TRIM(c.name)) = 'marketing' AND e.status <> 'cancelled'
      AND e.expenseDate >= ${`${from} 00:00:00`} AND e.expenseDate <= ${`${to} 23:59:59`}
      AND ${projectScope(sql`e.projectId`)}${proj}
    GROUP BY e.supplier, e.supplierNif`));
  let other = 0, adInvoices = 0;
  for (const r of rows) {
    const t = Number(r.t ?? 0);
    if (isAdPlatformInvoice(r.supplier, r.supplierNif)) adInvoices += t; else other += t;
  }
  return { other, adInvoices };
}

export async function getMarketingStats(f: MarketingStatsFilters, preloadedAds?: AdMetricsResult) {
  if (!ISO.test(f.from) || !ISO.test(f.to)) throw new Error("Datas inválidas (AAAA-MM-DD)");
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const projectIds = await marketingProjectIds(f.projectId);
  const ads = preloadedAds ?? await getAdMetrics({ from: f.from, to: f.to, projectIds });
  const conn = await getConnection();
  const vat = await vatRateForPeriod(f.from, f.to);

  let bookingsTotal = 0, bookingsAttributed = 0, bookingsGoogle = 0, bookingsMeta = 0, revenueTotal = 0, revenueAttributed = 0;
  let bookingsByDay: Array<{ date: string; total: number; attributed: number }> = [];
  /** reservas ligadas por ID externo da campanha (Google ou Meta) */
  const attributedByCampaign: Record<string, number> = {};
  const attributionQuality = { siteBookings: 0, withOriginUrl: 0, withClickId: 0, attributed: 0 };
  // Reservas AO VIVO da BD da Multipark (server/marketingLive.ts): criadas no
  // período, sem canceladas, atribuição Google/Meta a partir do link de origem.
  const { loadMarketingBookings } = await import("../../marketingLive");
  // 19a: a BD da Multipark em baixo não esconde o gasto (que é nosso) — as
  // reservas ficam "indisponíveis" (null), nunca 0.
  let bookingsError: string | null = null;
  const bookings = await loadMarketingBookings(f.from, f.to, projectIds).catch((err: any) => {
    bookingsError = String(err?.message ?? err).slice(0, 300);
    return [];
  });
  const byDay = new Map<string, { total: number; attributed: number }>();
  for (const b of bookings) {
    const paid = PAID.includes(b.adAttribution);
    bookingsTotal++; revenueTotal += b.total;
    if (paid) { bookingsAttributed++; revenueAttributed += b.total; }
    if (b.adAttribution === "google_paid") bookingsGoogle++;
    if (b.adAttribution === "meta_paid") bookingsMeta++;
    const d = byDay.get(b.day) ?? { total: 0, attributed: 0 };
    d.total++; if (paid) d.attributed++;
    byDay.set(b.day, d);
    // Qualidade da atribuição (Google): das reservas feitas no SITE, quantas têm
    // link de origem, quantas trazem o clique do Google e quantas ficaram atribuídas.
    if (b.origin && SITE_ORIGINS.includes(b.origin)) {
      attributionQuality.siteBookings++;
      if (b.hasOriginUrl) attributionQuality.withOriginUrl++;
      if (b.hasClickId) attributionQuality.withClickId++;
      if (b.adAttribution === "google_paid") attributionQuality.attributed++;
    }
    if (paid && b.adCampaignExternalId) attributedByCampaign[b.adCampaignExternalId] = (attributedByCampaign[b.adCampaignExternalId] ?? 0) + 1;
  }
  bookingsByDay = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
  const expensesSplit = await marketingCategoryExpenses(db, f.from, f.to, projectIds);
  const mktExpenses = expensesSplit.other;
  const bk = <T,>(v: T): T | null => (bookingsError ? null : v);

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
    // Google (da Google) — 19b: SÓ o Google (antes somava as conversões e o gasto da Meta)
    conversionsGoogle: ads.byProviderTotals.google_ads.conversions,
    conversionValueGoogle: ads.byProviderTotals.google_ads.conversionValue,
    costPerConversionGoogle: ads.byProviderTotals.google_ads.costPerConversion,
    roasGoogle: ads.byProviderTotals.google_ads.roasGoogle,
    /** conversões contadas pelas plataformas (Google + Meta + importações antigas) */
    conversionsPlatforms: ads.totals.conversions,
    // Reservas reais (Multipark), pela data de criação — null se a BD da Multipark não respondeu
    bookingsError,
    bookingsTotal: bk(bookingsTotal), bookingsAttributed: bk(bookingsAttributed), bookingsUnattributed: bk(bookingsUnattributed),
    bookingsGoogle: bk(bookingsGoogle), bookingsMeta: bk(bookingsMeta),
    revenueTotal: bk(revenueTotal), revenueAttributed: bk(revenueAttributed),
    vatRate: vat,
    costPerAttributedBooking: bookingsError ? null : ratio(spend, bookingsAttributed),
    /** ROAS das reservas ligadas, sem IVA */
    roasAttributedNet: bookingsError ? null : roasNetOfVat(revenueAttributed, spend, vat),
    /** ROAS global (todas as reservas ÷ gasto), sem IVA — indicador, não atribuição */
    roasTotalNet: bookingsError ? null : roasNetOfVat(revenueTotal, spend, vat),
    adCostPerBooking: bookingsError ? null : ratio(spend, bookingsTotal),      // indicador GLOBAL — não atribui todas as reservas aos anúncios
    // Outros custos de marketing (Despesas, categoria Marketing, SEM as faturas Google/Meta)
    mktExpenses,
    /** faturas Google/Meta lançadas nas Despesas → Marketing (não somadas: já estão no gasto) */
    adInvoicesInExpenses: expensesSplit.adInvoices,
    // Cobertura e qualidade
    coverage: ads.coverage,
    unmappedCampaigns: ads.unmappedCampaigns,
    byDay: ads.byDay,
    bookingsByDay,
    attributionQuality: bookingsError ? null : attributionQuality,
    attributedByCampaign,
    byCampaign: ads.byCampaign,
    nationalShares: ads.nationalShares,
    /** contas noutra moeda que não entraram nos totais (aviso) */
    currencyExcluded: ads.currencyExcluded,
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
  if (!db) throw new Error("Base de dados indisponível");
  const projectIds = await marketingProjectIds(f.projectId);
  const vat = await vatRateForPeriod(f.from, f.to);

  const allProjects = await db.select({ id: projects.id, name: projects.name, level: projects.level, parentId: projects.parentId }).from(projects);
  // 19b: todas as contas não gestoras (uma conta desselecionada continua a ter
  // gasto já recolhido, que conta na marca dela); só as selecionadas aparecem sem gasto.
  const accounts = await db.select({ id: adAccounts.id, name: adAccounts.name, projectId: adAccounts.projectId, provider: adAccounts.provider, selected: adAccounts.selected })
    .from(adAccounts).where(and(inArray(adAccounts.provider, [...API_PROVIDERS]), eq(adAccounts.isManager, 0))).orderBy(adAccounts.name);
  const accountProject = new Map(accounts.map((a) => [a.id, a.projectId]));
  const ads = preloadedAds ?? await getAdMetrics({ from: f.from, to: f.to, projectIds });

  // Reservas AO VIVO da BD da Multipark (server/marketingLive.ts), somadas por centro.
  const { loadMarketingBookings } = await import("../../marketingLive");
  const byProject = new Map<number | null, { projectId: number | null; n: number; attributed: number; rev: number; revAttributed: number }>();
  // 19a: Multipark em baixo → gasto por marca na mesma; reservas "indisponíveis".
  let bookingsError: string | null = null;
  const live = await loadMarketingBookings(f.from, f.to, projectIds).catch((err: any) => { bookingsError = String(err?.message ?? err).slice(0, 300); return []; });
  for (const b of live) {
    const r = byProject.get(b.projectId) ?? { projectId: b.projectId, n: 0, attributed: 0, rev: 0, revAttributed: 0 };
    const paid = b.adAttribution === "google_paid" || b.adAttribution === "meta_paid";
    r.n++; r.rev += b.total;
    if (paid) { r.attributed++; r.revAttributed += b.total; }
    byProject.set(b.projectId, r);
  }
  const bookingRows = [...byProject.values()];

  const key = (name: string) => name.trim().toLowerCase();
  const brands = new Map<string, BrandRow>();
  const newRow = (brand: string, mapped: boolean): BrandRow => ({ brand, mapped, accounts: [], spend: 0, spendGoogle: 0, spendMeta: 0, conversions: 0, bookings: 0, attributed: 0, revenue: 0, revenueAttributed: 0, roasNet: null });
  if (!projectIds) {
    // sem âmbito: todas as contas aparecem (mesmo sem gasto no período)
    for (const a of accounts) {
      if (!a.selected) continue;
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
  for (const b of brands.values()) b.roasNet = bookingsError ? null : roasNetOfVat(b.revenue, b.spend, vat);
  return {
    range: { from: f.from, to: f.to },
    accounts: accounts.map((a) => ({ id: a.id, name: a.name ?? `Conta ${a.id}`, provider: a.provider })),
    brands: Array.from(brands.values()).sort((a, b) => b.spend - a.spend || b.bookings - a.bookings),
    byBrandCity: Array.from(byBrandCity.values()),
    bookingsWithoutBrand,
    unassignedSpend,
    vatRate: vat,
    bookingsError,
  };
}
