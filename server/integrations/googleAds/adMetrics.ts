/**
 * FONTE ÚNICA das métricas de anúncios para todos os consumidores (Marketing:
 * dashboard, por marca, alertas, email semanal; Reservas & Operações;
 * Financeiro → marketingExcluded.adSpend). Mesmo número em todo o lado.
 *
 *  - Fornecedores da API: Google Ads (`google_ads`) e Meta (`meta`), na mesma
 *    tabela ad_daily_metrics. Só contas SELECIONADAS (e não gestoras) contam —
 *    a mesma regra em todos os ecrãs (antes o "Por marca" filtrava e o
 *    dashboard não).
 *  - Precedência por DIA E PLATAFORMA: se a API de uma plataforma tem dados
 *    nesse dia, as linhas antigas dessa plataforma (campaign_daily_stats:
 *    google_ads → Google; meta_ads/instagram → Meta) são ignoradas nesse dia.
 *    As de "other" contam sempre.
 *  - Legado deduplicado na leitura: um registo por (campanha, dia) — o mais
 *    recente (MAX(id)) — em vez de chave única destrutiva (ver migração 0093).
 *  - NACIONAL: mostra-se como nacional, mas o gasto é repartido pelas cidades
 *    da marca com pesos ESTÁVEIS: gasto de cidade da marca nos 28 dias que
 *    acabam em cada dia (rollingCityWeights) — a parte de uma cidade num dia
 *    não depende do período escolhido.
 *  - `byDayProject`: gasto por dia × nó (marca-cidade da campanha, ou fração
 *    do nacional); projectId null = sem cidade / nacional por atribuir. Somado
 *    dá SEMPRE o total (as Reservas & Operações usam isto numa só chamada).
 *  - O orçamento é um indicador SEPARADO — nunca substitui o gasto.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb, getProjects } from "../../db";
import { adAccounts, adCampaigns, adDailyMetrics } from "../../../drizzle/schema";
import { brandNameForProject, nationalSharesForBrand, rollingCityWeights, NATIONAL_WEIGHT_WINDOW_DAYS } from "../../../shared/adCampaignMapping";
import { GOOGLE_ADS_PROVIDER } from "./config";
import { addDays, addTotals, coverageFor, derivedRatios, emptyTotals, microsToAmount, type Coverage, type MetricTotals } from "./metrics";
import { lastSuccessfulSyncAt } from "./sync";

import { META_PROVIDER } from "../meta/config";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export { META_PROVIDER };
export const API_PROVIDERS = [GOOGLE_ADS_PROVIDER, META_PROVIDER] as const;
export type SpendProvider = "google_ads" | "meta" | "other";

export interface AdMetricsFilters { from: string; to: string; projectIds?: number[] | null; today?: string }

export interface AdCampaignRow {
  key: string; name: string; accountName: string | null; campaignId: number | null; accountId: number | null;
  source: "api" | "legacy"; provider: SpendProvider; status: string | null; externalId: string | null;
  projectId: number | null; national?: boolean; allocated?: boolean;
  cost: number; impressions: number; clicks: number; conversions: number; conversionValue: number; budgetPerDay: number | null;
}

export interface AdMetricsResult {
  totals: MetricTotals & ReturnType<typeof derivedRatios>;
  /** gasto por fornecedor (Google Ads, Meta = API + legado Meta/Instagram, outros = legado "other") */
  byProvider: Record<SpendProvider, number>;
  byDay: Array<{ date: string; source: "api" | "legacy"; cost: number; impressions: number; clicks: number; conversions: number; conversionValue: number }>;
  /** dia × nó; projectId null = sem cidade / nacional por atribuir. Σ = totals.cost */
  byDayProject: Array<{ date: string; projectId: number | null; cost: number }>;
  byCampaign: AdCampaignRow[];
  /** gasto NACIONAL repartido pelas cidades da marca (uma entrada por campanha × nó marca-cidade) */
  nationalShares: Array<{ key: string; accountId: number; projectId: number; cost: number; impressions: number; clicks: number; conversions: number; conversionValue: number }>;
  coverage: Coverage;
  /** Meta: último dia com dados (API ou legado) e se o período tem algum */
  meta: { lastDataDay: string | null; hasDataInPeriod: boolean };
  /** orçamento diário × dias (campanhas ativas) — INDICADOR, não gasto */
  budgetEstimate: number;
  unmappedCampaigns: number;   // campanhas da API por associar (sem marca/cidade e não nacionais)
  apiConnected: boolean;
}

/** Plataforma de uma linha legada → fornecedor. */
export function legacyProvider(platform: string | null | undefined): SpendProvider {
  const p = platform ?? "google_ads";
  if (p === "google_ads") return "google_ads";
  if (p === "meta_ads" || p === "instagram") return "meta";
  return "other";
}

/** Linha legada substituída pela API? Só se a API DESSA plataforma tem dados nesse dia. */
export function legacyOverriddenByApi(platform: string | null | undefined, day: string, apiDays: Set<string> | Map<string, Set<string>>): boolean {
  const provider = legacyProvider(platform);
  if (provider === "other") return false;
  if (apiDays instanceof Map) return apiDays.get(provider)?.has(day) ?? false;
  return provider === "google_ads" && apiDays.has(day);
}

function lisbonToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

const rowsOf = <T = any>(r: any): T[] => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as T[];

export async function getAdMetrics(f: AdMetricsFilters): Promise<AdMetricsResult> {
  if (!ISO.test(f.from) || !ISO.test(f.to)) throw new Error("datas inválidas");
  const today = f.today ?? lisbonToday();
  const empty: AdMetricsResult = {
    totals: { ...emptyTotals(), ...derivedRatios(emptyTotals()) }, byProvider: { google_ads: 0, meta: 0, other: 0 }, byDay: [], byDayProject: [], byCampaign: [], nationalShares: [],
    coverage: coverageFor(f.from, f.to, new Set(), new Set(), null, today), meta: { lastDataDay: null, hasDataInPeriod: false }, budgetEstimate: 0, unmappedCampaigns: 0, apiConnected: false,
  };
  if (f.projectIds?.length === 0) return empty;
  const db = await getDb();
  if (!db) return empty;
  const projectFilter = f.projectIds && f.projectIds.length ? f.projectIds : null;

  // ── API (fonte oficial) — desde (from − 27) para os pesos do nacional ────
  const weightsFrom = addDays(f.from, -(NATIONAL_WEIGHT_WINDOW_DAYS - 1));
  const apiRowsAll = await db.select({
    provider: adDailyMetrics.provider,
    date: adDailyMetrics.date, campaignExternalId: adDailyMetrics.campaignExternalId, accountId: adDailyMetrics.accountId,
    campaignDbId: adCampaigns.id, campaignName: adCampaigns.name, campaignStatus: adCampaigns.status, budgetMicros: adCampaigns.budgetMicros, accountName: adAccounts.name,
    projectId: adCampaigns.projectId, scope: adCampaigns.scope, accountProjectId: adAccounts.projectId,
    costMicros: adDailyMetrics.costMicros, impressions: adDailyMetrics.impressions, clicks: adDailyMetrics.clicks,
    conversions: adDailyMetrics.conversions, conversionValueMicros: adDailyMetrics.conversionValueMicros,
  }).from(adDailyMetrics)
    .innerJoin(adAccounts, and(eq(adAccounts.id, adDailyMetrics.accountId), eq(adAccounts.selected, 1), eq(adAccounts.isManager, 0)))
    .leftJoin(adCampaigns, and(eq(adCampaigns.provider, adDailyMetrics.provider), eq(adCampaigns.accountId, adDailyMetrics.accountId), eq(adCampaigns.externalId, adDailyMetrics.campaignExternalId)))
    .where(and(inArray(adDailyMetrics.provider, [...API_PROVIDERS]), eq(adDailyMetrics.source, "api"), gte(adDailyMetrics.date, weightsFrom), lte(adDailyMetrics.date, f.to)));

  // Pesos: dia → nó marca-cidade → gasto das campanhas de cidade (todas as plataformas)
  const allProjects = (await getProjects()).map((p) => ({ id: p.id, name: p.name, level: String(p.level), parentId: p.parentId ?? null }));
  const costByDay = new Map<string, Map<number, number>>();
  for (const r of apiRowsAll) {
    if (r.projectId == null || r.scope === "national") continue;
    const day = String(r.date).slice(0, 10);
    const m = costByDay.get(day) ?? new Map<number, number>();
    m.set(Number(r.projectId), (m.get(Number(r.projectId)) ?? 0) + Number(r.costMicros));
    costByDay.set(day, m);
  }
  const weightsCache = new Map<string, Map<number, number>>();
  const sharesCache = new Map<string, Array<{ projectId: number; fraction: number }>>();
  const sharesFor = (accountProjectId: number | null, day: string): Array<{ projectId: number; fraction: number }> => {
    const brand = brandNameForProject(accountProjectId, allProjects);
    if (!brand) return [];
    const k = `${brand}|${day}`;
    let s = sharesCache.get(k);
    if (!s) {
      let w = weightsCache.get(day);
      if (!w) { w = rollingCityWeights(costByDay, day); weightsCache.set(day, w); }
      s = nationalSharesForBrand(brand, allProjects, w);
      sharesCache.set(k, s);
    }
    return s;
  };

  const inRange = apiRowsAll.filter((r) => { const d = String(r.date).slice(0, 10); return d >= f.from && d <= f.to; });
  const filterSet = projectFilter ? new Set(projectFilter) : null;
  const fractionOf = (r: (typeof inRange)[number]): number => {
    if (!filterSet) return 1;
    if (r.scope === "national") return sharesFor(r.accountProjectId ?? null, String(r.date).slice(0, 10)).filter((s) => filterSet.has(s.projectId)).reduce((a, s) => a + s.fraction, 0);
    return r.projectId != null && filterSet.has(Number(r.projectId)) ? 1 : 0;
  };
  const apiRows = inRange.map((r) => ({ r, fraction: fractionOf(r) })).filter((x) => x.fraction > 0);
  const nationalShareMap = new Map<string, AdMetricsResult["nationalShares"][number]>();

  // ── Legado (campaign_daily_stats), deduplicado por (campanha, dia) ──────
  const legacyRows = rowsOf<any>(await db.execute(sql`
    SELECT DATE(s.date) AS d, s.campaignId AS campaignId, c.name AS campaignName, c.projectId AS projectId, c.platform AS platform,
           s.spend AS spend, s.impressions AS impressions, s.clicks AS clicks, s.conversions AS conversions, s.conversionValue AS conversionValue
    FROM campaign_daily_stats s
    JOIN (
      SELECT MAX(x.id) AS mx FROM campaign_daily_stats x
      WHERE x.date >= ${`${f.from} 00:00:00`} AND x.date <= ${`${f.to} 23:59:59`}
      GROUP BY x.campaignId, DATE(x.date)
    ) m ON m.mx = s.id
    LEFT JOIN campaigns c ON c.id = s.campaignId
    ${projectFilter ? sql`WHERE c.projectId IN (${sql.join(projectFilter.map((id) => sql`${id}`), sql`, `)})` : sql``}`));

  const apiDays = new Map<string, Set<string>>([[GOOGLE_ADS_PROVIDER, new Set()], [META_PROVIDER, new Set()]]);
  for (const r of inRange) apiDays.get(r.provider)?.add(String(r.date).slice(0, 10));
  const legacyDays = new Set<string>();
  const byDayMap = new Map<string, AdMetricsResult["byDay"][number]>();
  const byDayProject = new Map<string, { date: string; projectId: number | null; cost: number }>();
  const addDayProject = (date: string, projectId: number | null, cost: number) => {
    if (!cost) return;
    const k = `${date}|${projectId ?? ""}`;
    const e = byDayProject.get(k) ?? { date, projectId, cost: 0 };
    e.cost += cost; byDayProject.set(k, e);
  };
  const byCampaignMap = new Map<string, AdCampaignRow>();
  const byProvider: Record<SpendProvider, number> = { google_ads: 0, meta: 0, other: 0 };
  let totals = emptyTotals();
  const unmappedSet = new Set<string>();
  let metaDaysInPeriod = 0;
  const metaDaySet = new Set<string>();

  for (const { r, fraction } of apiRows) {
    const day = String(r.date).slice(0, 10);
    const provider: SpendProvider = r.provider === META_PROVIDER ? "meta" : "google_ads";
    const full = { costMicros: Number(r.costMicros), impressions: Number(r.impressions), clicks: Number(r.clicks), conversions: Number(r.conversions), conversionValueMicros: Number(r.conversionValueMicros) };
    const t = fraction === 1 ? full : { costMicros: Math.round(full.costMicros * fraction), impressions: Math.round(full.impressions * fraction), clicks: Math.round(full.clicks * fraction), conversions: full.conversions * fraction, conversionValueMicros: Math.round(full.conversionValueMicros * fraction) };
    totals = addTotals(totals, t);
    byProvider[provider] += microsToAmount(t.costMicros);
    if (provider === "meta") metaDaySet.add(day);
    if (r.scope === "national") {
      const shares = sharesFor(r.accountProjectId ?? null, day).filter((s) => !filterSet || filterSet.has(s.projectId));
      for (const s of shares) {
        const k = `${r.accountId}:${r.campaignExternalId}:${s.projectId}`;
        const e = nationalShareMap.get(k) ?? { key: `api:${r.accountId}:${r.campaignExternalId}`, accountId: r.accountId, projectId: s.projectId, cost: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
        e.cost += microsToAmount(full.costMicros) * s.fraction; e.impressions += full.impressions * s.fraction; e.clicks += full.clicks * s.fraction; e.conversions += full.conversions * s.fraction; e.conversionValue += microsToAmount(full.conversionValueMicros) * s.fraction;
        nationalShareMap.set(k, e);
        addDayProject(day, s.projectId, microsToAmount(full.costMicros) * s.fraction);
      }
      // marca sem cidades na árvore → o nacional fica por atribuir (só sem filtro)
      if (!shares.length && !filterSet) addDayProject(day, null, microsToAmount(full.costMicros));
    } else {
      addDayProject(day, r.projectId != null ? Number(r.projectId) : null, microsToAmount(t.costMicros));
    }
    const d = byDayMap.get(day) ?? { date: day, source: "api" as const, cost: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
    d.cost += microsToAmount(t.costMicros); d.impressions += t.impressions; d.clicks += t.clicks; d.conversions += t.conversions; d.conversionValue += microsToAmount(t.conversionValueMicros);
    byDayMap.set(day, d);
    const key = `api:${r.accountId}:${r.campaignExternalId}`;
    const c = byCampaignMap.get(key) ?? {
      key, name: r.campaignName ?? r.campaignExternalId, accountName: r.accountName ?? null, campaignId: r.campaignDbId ?? null, accountId: r.accountId,
      source: "api" as const, provider, status: r.campaignStatus ?? null, externalId: r.campaignExternalId,
      projectId: r.projectId == null ? null : Number(r.projectId), cost: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0,
      budgetPerDay: r.budgetMicros != null ? microsToAmount(r.budgetMicros) : null,
    };
    c.cost += microsToAmount(t.costMicros); c.impressions += t.impressions; c.clicks += t.clicks; c.conversions += t.conversions; c.conversionValue += microsToAmount(t.conversionValueMicros);
    byCampaignMap.set(key, c);
    if (r.scope === "national") { c.national = true; if (fraction < 1) c.allocated = true; }
    if (r.projectId == null && r.scope !== "national") unmappedSet.add(key);
  }

  for (const r of legacyRows) {
    const day = String(r.d instanceof Date ? r.d.toISOString() : r.d).slice(0, 10);
    if (legacyOverriddenByApi(r.platform, day, apiDays)) continue;     // a API dessa plataforma prevalece nesse dia
    const provider = legacyProvider(r.platform);
    if (provider === "google_ads") legacyDays.add(day);  // cobertura = Google
    if (provider === "meta") metaDaySet.add(day);
    const spend = Number(r.spend ?? 0);
    const t = { costMicros: Math.round(spend * 1_000_000), impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0), conversions: Number(r.conversions ?? 0), conversionValueMicros: Math.round(Number(r.conversionValue ?? 0) * 1_000_000) };
    totals = addTotals(totals, t);
    byProvider[provider] += spend;
    addDayProject(day, r.projectId != null ? Number(r.projectId) : null, spend);
    const d = byDayMap.get(day) ?? { date: day, source: "legacy" as const, cost: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
    d.cost += spend; d.impressions += t.impressions; d.clicks += t.clicks; d.conversions += t.conversions; d.conversionValue += Number(r.conversionValue ?? 0);
    byDayMap.set(day, d);
    const key = `legacy:${r.campaignId}`;
    const c = byCampaignMap.get(key) ?? { key, name: r.campaignName ?? `#${r.campaignId}`, accountName: null, campaignId: null, accountId: null, source: "legacy" as const, provider, status: null, externalId: null, projectId: r.projectId != null ? Number(r.projectId) : null, cost: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0, budgetPerDay: null };
    c.cost += spend; c.impressions += t.impressions; c.clicks += t.clicks; c.conversions += t.conversions; c.conversionValue += Number(r.conversionValue ?? 0);
    byCampaignMap.set(key, c);
  }
  metaDaysInPeriod = metaDaySet.size;

  // Meta: último dia com dados (API das contas selecionadas ou legado Meta/Instagram)
  let metaLast: string | null = null;
  try {
    const [a] = rowsOf<any>(await db.execute(sql`
      SELECT MAX(m.date) AS d FROM ad_daily_metrics m JOIN ad_accounts a ON a.id = m.accountId AND a.selected = 1
      WHERE m.provider = ${META_PROVIDER} AND m.source = 'api' AND m.costMicros > 0`));
    const [b] = rowsOf<any>(await db.execute(sql`
      SELECT MAX(DATE(s.date)) AS d FROM campaign_daily_stats s JOIN campaigns c ON c.id = s.campaignId
      WHERE c.platform IN ('meta_ads', 'instagram') AND s.spend > 0`));
    const norm = (v: any) => (v == null ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));
    const days = [norm(a?.d), norm(b?.d)].filter((x): x is string => !!x).sort();
    metaLast = days.length ? days[days.length - 1] : null;
  } catch { /* indicador opcional */ }

  // Orçamento (indicador separado): campanhas ATIVAS da API Google com orçamento diário
  let budgetEstimate = 0;
  const days = byDayMap.size ? Math.floor((Date.UTC(+f.to.slice(0, 4), +f.to.slice(5, 7) - 1, +f.to.slice(8, 10)) - Date.UTC(+f.from.slice(0, 4), +f.from.slice(5, 7) - 1, +f.from.slice(8, 10))) / 86400000) + 1 : 0;
  if (days > 0) {
    const activeConds: any[] = [eq(adCampaigns.provider, GOOGLE_ADS_PROVIDER), eq(adCampaigns.status, "ENABLED")];
    if (projectFilter) activeConds.push(inArray(adCampaigns.projectId, projectFilter));
    const act = await db.select({ b: sql<string>`COALESCE(SUM(${adCampaigns.budgetMicros}), 0)` }).from(adCampaigns)
      .innerJoin(adAccounts, and(eq(adAccounts.id, adCampaigns.accountId), eq(adAccounts.selected, 1))).where(and(...activeConds));
    budgetEstimate = microsToAmount(Number(act[0]?.b ?? 0)) * days;
  }

  const lastSync = await lastSuccessfulSyncAt();
  const coverage = coverageFor(f.from, f.to, apiDays.get(GOOGLE_ADS_PROVIDER)!, legacyDays, lastSync ? lastSync.replace(" ", "T") + "Z" : null, today);
  return {
    totals: { ...totals, ...derivedRatios(totals) },
    byProvider,
    byDay: Array.from(byDayMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    byDayProject: Array.from(byDayProject.values()).sort((a, b) => a.date.localeCompare(b.date)),
    byCampaign: Array.from(byCampaignMap.values()).sort((a, b) => b.cost - a.cost),
    nationalShares: Array.from(nationalShareMap.values()),
    coverage,
    meta: { lastDataDay: metaLast, hasDataInPeriod: metaDaysInPeriod > 0 },
    budgetEstimate, unmappedCampaigns: unmappedSet.size, apiConnected: apiRowsAll.length > 0 || lastSync != null,
  };
}
