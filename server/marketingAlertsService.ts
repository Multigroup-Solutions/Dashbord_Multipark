/**
 * Dados dos alertas do Marketing (regras puras em shared/marketingAlerts.ts):
 * usado pela rota marketing.alerts e pelo email semanal.
 *
 *  - Janela das campanhas: últimos 14 dias (hoje incluído — é gasto real).
 *  - Ritmo do mês: gasto do dia 1 até ONTEM (hoje está a meio).
 *  - Saúde das recolhas (Google Ads sempre que ligado; Meta se configurada).
 *  - Orçamentos do mês corrente (ritmo por objetivo).
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { projectScope } from "./cityScope";
import { lisbonToday } from "../shared/expensePeriods";
import { addDays } from "../shared/lisbonDay";
import { computeMarketingAlerts, ALERT_WINDOW_DAYS, type SyncHealth } from "../shared/marketingAlerts";
import { inLisbonDaysSql, marketingProjectIds, notCancelledSql } from "./marketingSql";

const rowsOf = <T = any>(r: any): T[] => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as T[];

export async function adsSyncHealth(): Promise<SyncHealth[]> {
  const out: SyncHealth[] = [];
  const { getConnection } = await import("./integrations/googleAds/oauth");
  const { lastFinishedRun, lastSuccessfulSyncAt, isSyncStale } = await import("./integrations/googleAds/sync");
  const conn = await getConnection();
  if (conn && conn.status !== "disconnected") {
    const last = await lastFinishedRun("google_ads");
    out.push({ provider: "google_ads", connection: conn.status, lastRunStatus: last?.status ?? null, lastRunError: last?.error ?? null, stale: await isSyncStale(), lastSuccessAt: await lastSuccessfulSyncAt() });
  }
  const { isMetaConfigured, META_PROVIDER } = await import("./integrations/meta/config");
  if (isMetaConfigured()) {
    const { metaStatus } = await import("./integrations/meta/sync");
    const st = await metaStatus();
    const last = await lastFinishedRun(META_PROVIDER);
    out.push({ provider: "meta", connection: st.connection?.status ?? null, lastRunStatus: last?.status ?? null, lastRunError: last?.error ?? null, stale: st.stale, lastSuccessAt: st.lastSuccessfulSyncAt });
  }
  return out;
}

export async function computeAlertsFor(projectId?: number) {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const { getMarketingStats } = await import("./integrations/googleAds/marketingStats");
  const { getAdMetrics } = await import("./integrations/googleAds/adMetrics");
  const { listBudgetsWithPacing } = await import("./marketingBudgets");
  const today = lisbonToday();
  const [y, m] = today.split("-").map(Number);
  const monthStart = `${today.slice(0, 7)}-01`;
  const yesterday = addDays(today, -1);
  const prevEnd = addDays(monthStart, -1);
  const prevStart = `${prevEnd.slice(0, 7)}-01`;
  const windowFrom = addDays(today, -(ALERT_WINDOW_DAYS - 1));
  const projectIds = await marketingProjectIds(projectId);
  const [win, month, prev, health, budgets] = await Promise.all([
    getMarketingStats({ from: windowFrom, to: today, projectId }),
    yesterday >= monthStart ? getAdMetrics({ from: monthStart, to: yesterday, projectIds }) : Promise.resolve(null),
    getAdMetrics({ from: prevStart, to: prevEnd, projectIds }),
    adsSyncHealth(),
    listBudgetsWithPacing({ month: today.slice(0, 7), projectId, today }),
  ]);
  // Reservas ligadas por campanha (ID externo) na janela — mesma regra de cancelada/dia.
  const byExt = new Map<string, number>();
  const proj = projectIds ? (projectIds.length ? sql` AND b.projectId IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})` : sql` AND 1 = 0`) : sql``;
  const raw: any = await db.execute(sql`
    SELECT b.adCampaignExternalId AS ext, COUNT(*) AS n FROM multipark_bookings b
    WHERE b.adAttribution IN ('google_paid', 'meta_paid') AND b.adCampaignExternalId IS NOT NULL
      AND ${notCancelledSql(sql`b.status`)}
      AND ${inLisbonDaysSql(sql`b.bookingCreatedAt`, windowFrom, today)}
      AND ${projectScope(sql`b.projectId`)}${proj}
    GROUP BY b.adCampaignExternalId`);
  for (const r of rowsOf<any>(raw)) byExt.set(String(r.ext), Number(r.n ?? 0));
  const windowCampaigns = win.byCampaign.filter((c) => c.source === "api").map((c) => ({
    name: String(c.name), accountName: c.accountName ?? null, cost: Number(c.cost ?? 0), conversions: Number(c.conversions ?? 0),
    attributedBookings: c.externalId ? byExt.get(c.externalId) ?? 0 : 0,
  }));
  const alerts = computeMarketingAlerts({
    windowCampaigns,
    attribution: win.attributionQuality,
    windowSpend: win.spend,
    windowConversions: win.conversionsGoogle,
    monthSpend: month?.totals.cost ?? 0,
    prevMonthSpend: prev.totals.cost,
    dayOfMonth: Number(today.slice(8, 10)),
    daysInMonth: new Date(Date.UTC(y, m, 0)).getUTCDate(),
    unmappedCampaigns: (month ?? prev).unmappedCampaigns,
    coverage: win.coverage ?? null,
    syncHealth: health,
    budgets: budgets.map((b) => ({ label: b.label, amount: b.amount, spentToDate: b.spentToDate, pacing: b.pacing })),
  });
  return { generatedAt: new Date().toISOString(), windowFrom, alerts, syncHealth: health };
}
