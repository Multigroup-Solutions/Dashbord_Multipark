/**
 * FONTE ÚNICA das métricas de anúncios para todos os consumidores (Marketing,
 * dashboards, relatórios).
 *
 * Regra de precedência por DIA: se a API tem dados nesse dia, usa-se só a API;
 * caso contrário usa-se a importação antiga (campaign_daily_stats, CSV/email),
 * identificada como "legacy". Nunca se somam as duas para o mesmo dia.
 * O orçamento é um indicador SEPARADO — nunca substitui o gasto.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb, getProjects } from "../../db";
import { adAccounts, adCampaigns, adDailyMetrics, campaignDailyStats, campaigns } from "../../../drizzle/schema";
import { brandNameForProject, nationalSharesForBrand } from "../../../shared/adCampaignMapping";
import { GOOGLE_ADS_PROVIDER } from "./config";
import { addTotals, coverageFor, derivedRatios, emptyTotals, microsToAmount, type Coverage, type MetricTotals } from "./metrics";
import { lastSuccessfulSyncAt } from "./sync";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface AdMetricsFilters { from: string; to: string; projectIds?: number[] | null; today?: string }

export interface AdMetricsResult {
  totals: MetricTotals & ReturnType<typeof derivedRatios>;
  byDay: Array<{ date: string; source: "api" | "legacy"; cost: number; impressions: number; clicks: number; conversions: number; conversionValue: number }>;
  byCampaign: Array<{ key: string; name: string; accountName: string | null; campaignId: number | null; accountId: number | null; source: "api" | "legacy"; projectId: number | null; national?: boolean; allocated?: boolean; cost: number; impressions: number; clicks: number; conversions: number; conversionValue: number; budgetPerDay: number | null }>;
  /** gasto NACIONAL repartido pelas cidades da marca (uma entrada por campanha × nó marca-cidade) */
  nationalShares: Array<{ key: string; accountId: number; projectId: number; cost: number; impressions: number; clicks: number; conversions: number; conversionValue: number }>;
  coverage: Coverage;
  /** orçamento diário × dias (campanhas ativas) — INDICADOR, não gasto */
  budgetEstimate: number;
  unmappedCampaigns: number;   // campanhas da API por associar (sem marca/cidade e não nacionais)
  apiConnected: boolean;
}

function lisbonToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export async function getAdMetrics(f: AdMetricsFilters): Promise<AdMetricsResult> {
  if (!ISO.test(f.from) || !ISO.test(f.to)) throw new Error("datas inválidas");
  const db = await getDb();
  const today = f.today ?? lisbonToday();
  const empty: AdMetricsResult = {
    totals: { ...emptyTotals(), ...derivedRatios(emptyTotals()) }, byDay: [], byCampaign: [], nationalShares: [],
    coverage: coverageFor(f.from, f.to, new Set(), new Set(), null, today), budgetEstimate: 0, unmappedCampaigns: 0, apiConnected: false,
  };
  if (!db || f.projectIds?.length === 0) return empty;
  const projectFilter = f.projectIds && f.projectIds.length ? f.projectIds : null;

  // ── API (fonte oficial) ───────────────────────────────────────────────────
  // Cidade de uma campanha = a marca/cidade ESCOLHIDA para a campanha (nunca a
  // da conta: "Airpark - Brand" contava em Lisboa só porque a conta AirPark
  // está associada a Airpark Lisboa). NACIONAL (Jorge, 16 set 2026): mostra-se
  // como nacional, mas o gasto é REPARTIDO pelas cidades da marca (peso = gasto
  // de cidade dessa marca no período; sem pesos, partes iguais). Por associar
  // (sem escolha) não vai a nenhuma cidade. O filtro de cidade aplica-se em JS
  // depois da repartição, para as frações do nacional contarem na cidade.
  const apiConds: any[] = [eq(adDailyMetrics.provider, GOOGLE_ADS_PROVIDER), eq(adDailyMetrics.source, "api"), gte(adDailyMetrics.date, f.from), lte(adDailyMetrics.date, f.to)];
  const apiRowsAll = await db.select({
    date: adDailyMetrics.date, campaignExternalId: adDailyMetrics.campaignExternalId, accountId: adDailyMetrics.accountId,
    campaignDbId: adCampaigns.id, campaignName: adCampaigns.name, campaignStatus: adCampaigns.status, budgetMicros: adCampaigns.budgetMicros, accountName: adAccounts.name,
    projectId: adCampaigns.projectId, scope: adCampaigns.scope, accountProjectId: adAccounts.projectId,
    costMicros: adDailyMetrics.costMicros, impressions: adDailyMetrics.impressions, clicks: adDailyMetrics.clicks,
    conversions: adDailyMetrics.conversions, conversionValueMicros: adDailyMetrics.conversionValueMicros,
  }).from(adDailyMetrics)
    .leftJoin(adCampaigns, and(eq(adCampaigns.provider, adDailyMetrics.provider), eq(adCampaigns.accountId, adDailyMetrics.accountId), eq(adCampaigns.externalId, adDailyMetrics.campaignExternalId)))
    .leftJoin(adAccounts, eq(adAccounts.id, adDailyMetrics.accountId))
    .where(and(...apiConds));

  // 1ª passagem: peso de cada nó marca-cidade = gasto das campanhas de cidade
  const allProjects = (await getProjects()).map((p) => ({ id: p.id, name: p.name, level: String(p.level), parentId: p.parentId ?? null }));
  const cityWeights = new Map<number, number>();
  for (const r of apiRowsAll) {
    if (r.projectId != null && r.scope !== "national") cityWeights.set(Number(r.projectId), (cityWeights.get(Number(r.projectId)) ?? 0) + Number(r.costMicros));
  }
  // frações por campanha nacional (cache por marca da conta)
  const sharesByBrand = new Map<string, Array<{ projectId: number; fraction: number }>>();
  const sharesFor = (accountProjectId: number | null): Array<{ projectId: number; fraction: number }> => {
    const brand = brandNameForProject(accountProjectId, allProjects);
    if (!brand) return [];
    let s = sharesByBrand.get(brand);
    if (!s) { s = nationalSharesForBrand(brand, allProjects, cityWeights); sharesByBrand.set(brand, s); }
    return s;
  };
  // fração de cada linha que conta para o filtro de cidade (1 sem filtro)
  const filterSet = projectFilter ? new Set(projectFilter) : null;
  const fractionOf = (r: (typeof apiRowsAll)[number]): number => {
    if (!filterSet) return 1;
    if (r.scope === "national") return sharesFor(r.accountProjectId ?? null).filter((s) => filterSet.has(s.projectId)).reduce((a, s) => a + s.fraction, 0);
    return r.projectId != null && filterSet.has(Number(r.projectId)) ? 1 : 0;
  };
  const apiRows = apiRowsAll.map((r) => ({ r, fraction: fractionOf(r) })).filter((x) => x.fraction > 0);
  const nationalShares: AdMetricsResult["nationalShares"] = [];
  const nationalShareMap = new Map<string, AdMetricsResult["nationalShares"][number]>();

  // ── Legado (campaign_daily_stats) — só dias sem API ──────────────────────
  const legConds: any[] = [gte(campaignDailyStats.date, `${f.from} 00:00:00`), lte(campaignDailyStats.date, `${f.to} 23:59:59`)];
  if (projectFilter) legConds.push(inArray(campaigns.projectId, projectFilter));
  const legacyRows = await db.select({
    date: sql<string>`DATE(${campaignDailyStats.date})`, campaignId: campaignDailyStats.campaignId, campaignName: campaigns.name, projectId: campaigns.projectId,
    spend: campaignDailyStats.spend, impressions: campaignDailyStats.impressions, clicks: campaignDailyStats.clicks, conversions: campaignDailyStats.conversions, conversionValue: campaignDailyStats.conversionValue,
  }).from(campaignDailyStats).leftJoin(campaigns, eq(campaigns.id, campaignDailyStats.campaignId)).where(and(...legConds));

  const apiDays = new Set(apiRowsAll.map((r) => String(r.date).slice(0, 10)));
  const legacyDays = new Set<string>();
  const byDayMap = new Map<string, AdMetricsResult["byDay"][number]>();
  const byCampaignMap = new Map<string, AdMetricsResult["byCampaign"][number]>();
  let totals = emptyTotals();
  let unmapped = 0;
  const unmappedSet = new Set<string>();

  for (const { r, fraction } of apiRows) {
    const day = String(r.date).slice(0, 10);
    const full = { costMicros: Number(r.costMicros), impressions: Number(r.impressions), clicks: Number(r.clicks), conversions: Number(r.conversions), conversionValueMicros: Number(r.conversionValueMicros) };
    const t = fraction === 1 ? full : { costMicros: Math.round(full.costMicros * fraction), impressions: Math.round(full.impressions * fraction), clicks: Math.round(full.clicks * fraction), conversions: full.conversions * fraction, conversionValueMicros: Math.round(full.conversionValueMicros * fraction) };
    totals = addTotals(totals, t);
    // repartição do nacional pelas cidades (para a UI mostrar "nacional repartido" por cidade)
    if (r.scope === "national") {
      for (const s of sharesFor(r.accountProjectId ?? null)) {
        if (filterSet && !filterSet.has(s.projectId)) continue;
        const k = `${r.accountId}:${r.campaignExternalId}:${s.projectId}`;
        const e = nationalShareMap.get(k) ?? { key: `api:${r.accountId}:${r.campaignExternalId}`, accountId: r.accountId, projectId: s.projectId, cost: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
        e.cost += microsToAmount(full.costMicros) * s.fraction; e.impressions += full.impressions * s.fraction; e.clicks += full.clicks * s.fraction; e.conversions += full.conversions * s.fraction; e.conversionValue += microsToAmount(full.conversionValueMicros) * s.fraction;
        nationalShareMap.set(k, e);
      }
    }
    const d = byDayMap.get(day) ?? { date: day, source: "api" as const, cost: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
    d.cost += microsToAmount(t.costMicros); d.impressions += t.impressions; d.clicks += t.clicks; d.conversions += t.conversions; d.conversionValue += microsToAmount(t.conversionValueMicros);
    byDayMap.set(day, d);
    const key = `api:${r.accountId}:${r.campaignExternalId}`;
    const c = byCampaignMap.get(key) ?? { key, name: r.campaignName ?? r.campaignExternalId, accountName: r.accountName ?? null, campaignId: r.campaignDbId ?? null, accountId: r.accountId, source: "api" as const, projectId: r.projectId == null ? null : Number(r.projectId), cost: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0, budgetPerDay: r.budgetMicros != null ? microsToAmount(r.budgetMicros) : null };
    c.cost += microsToAmount(t.costMicros); c.impressions += t.impressions; c.clicks += t.clicks; c.conversions += t.conversions; c.conversionValue += microsToAmount(t.conversionValueMicros);
    byCampaignMap.set(key, c);
    if (r.scope === "national") { c.national = true; if (fraction < 1) c.allocated = true; }
    if (r.projectId == null && r.scope !== "national" && !unmappedSet.has(key)) { unmappedSet.add(key); unmapped++; }
  }
  nationalShares.push(...nationalShareMap.values());
  for (const r of legacyRows) {
    const day = String(r.date).slice(0, 10);
    if (apiDays.has(day)) continue;     // API prevalece nesse dia
    legacyDays.add(day);
    const t = { costMicros: Math.round(Number(r.spend ?? 0) * 1_000_000), impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0), conversions: Number(r.conversions ?? 0), conversionValueMicros: Math.round(Number(r.conversionValue ?? 0) * 1_000_000) };
    totals = addTotals(totals, t);
    const d = byDayMap.get(day) ?? { date: day, source: "legacy" as const, cost: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
    d.cost += Number(r.spend ?? 0); d.impressions += t.impressions; d.clicks += t.clicks; d.conversions += t.conversions; d.conversionValue += Number(r.conversionValue ?? 0);
    byDayMap.set(day, d);
    const key = `legacy:${r.campaignId}`;
    const c = byCampaignMap.get(key) ?? { key, name: r.campaignName ?? `#${r.campaignId}`, accountName: null, campaignId: null, accountId: null, source: "legacy" as const, projectId: r.projectId ?? null, cost: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0, budgetPerDay: null };
    c.cost += Number(r.spend ?? 0); c.impressions += t.impressions; c.clicks += t.clicks; c.conversions += t.conversions; c.conversionValue += Number(r.conversionValue ?? 0);
    byCampaignMap.set(key, c);
  }

  // Orçamento (indicador separado): campanhas ATIVAS da API com orçamento diário
  let budgetEstimate = 0;
  const days = byDayMap.size ? Math.floor((Date.UTC(+f.to.slice(0, 4), +f.to.slice(5, 7) - 1, +f.to.slice(8, 10)) - Date.UTC(+f.from.slice(0, 4), +f.from.slice(5, 7) - 1, +f.from.slice(8, 10))) / 86400000) + 1 : 0;
  if (days > 0) {
    const activeConds: any[] = [eq(adCampaigns.provider, GOOGLE_ADS_PROVIDER), eq(adCampaigns.status, "ENABLED")];
    if (projectFilter) activeConds.push(inArray(adCampaigns.projectId, projectFilter));
    const act = await db.select({ b: sql<string>`COALESCE(SUM(${adCampaigns.budgetMicros}), 0)` }).from(adCampaigns).leftJoin(adAccounts, eq(adAccounts.id, adCampaigns.accountId)).where(and(...activeConds));
    budgetEstimate = microsToAmount(Number(act[0]?.b ?? 0)) * days;
  }

  const lastSync = await lastSuccessfulSyncAt();
  const coverage = coverageFor(f.from, f.to, apiDays, legacyDays, lastSync ? lastSync.replace(" ", "T") + "Z" : null, today);
  return {
    totals: { ...totals, ...derivedRatios(totals) },
    byDay: Array.from(byDayMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    byCampaign: Array.from(byCampaignMap.values()).sort((a, b) => b.cost - a.cost),
    nationalShares,
    coverage, budgetEstimate, unmappedCampaigns: unmapped, apiConnected: apiRowsAll.length > 0 || lastSync != null,
  };
}
