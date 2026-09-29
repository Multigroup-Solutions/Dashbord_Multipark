/**
 * Recolha Meta Ads → ad_daily_metrics (provider 'meta'), com as MESMAS
 * regras da recolha Google Ads (server/integrations/googleAds/sync.ts):
 *
 *  - daily: últimos 7 dias; monthly: mês anterior; initial/manual: 37 meses;
 *  - mutex em linha (integration_connections.syncLockAt, provider 'meta');
 *  - retomável com prazo (cursor em integration_sync_runs);
 *  - uma resposta vazia não apaga dados que já existiam (aviso);
 *  - estado honesto: todas as contas falharam → failed; algumas → partial;
 *  - NÃO configurada (sem META_ACCESS_TOKEN / META_AD_ACCOUNT_IDS) → não faz
 *    nada e devolve ok:true, skipped:'not_configured' (o cron fica verde).
 *  - lock, retoma, escrita e estado vêm do motor comum (../adsSyncRunner).
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { adAccounts, integrationConnections, integrationSyncRuns } from "../../../drizzle/schema";
import { type SyncKind } from "../googleAds/metrics";
import { isStaleSince } from "../../../shared/marketingRules";
import { META_PROVIDER, missingMetaEnvs, readMetaConfig, type MetaConfig } from "./config";
import { fetchMetaAccount, fetchMetaCampaigns, fetchMetaInsights, MetaApiError, type FetchLike } from "./insights";
import { mysqlAdsSyncStore, nowMysql, runAdsSync, type AdsAccountRef, type AdsSyncResult, type AdsSyncStore } from "../adsSyncRunner";

export type MetaSyncResult = AdsSyncResult;
type MetaCampaigns = Map<string, { name: string; status: string | null; dailyBudgetMicros: number | null }>;

/** Garante uma linha em ad_accounts por conta configurada (nova = selecionada). */
export async function ensureMetaAccounts(store: AdsSyncStore, cfg: MetaConfig, fetchImpl?: FetchLike): Promise<void> {
  for (const id of cfg.accountIds) {
    let info: Awaited<ReturnType<typeof fetchMetaAccount>> | null = null;
    try { info = await fetchMetaAccount(cfg, id, fetchImpl); } catch { info = null; }
    await store.upsertAccount(META_PROVIDER, {
      customerId: id, name: info?.name ?? `Meta ${id}`, currency: info?.currency ?? null, timezone: info?.timezone ?? null, status: info?.status ?? null,
    }, !!info);
  }
}

/**
 * Recolha com o motor comum (../adsSyncRunner). `store`/`fetchImpl` são
 * injetáveis (testes sem BD nem rede). As contas configuradas garantem-se UMA
 * vez por invocação, já com o lock.
 */
export async function runMetaAdsSync(opts: { kind: SyncKind; deadlineAt?: number; triggeredById?: number | null; fetchImpl?: FetchLike; store?: AdsSyncStore; today?: string }): Promise<MetaSyncResult> {
  const base: MetaSyncResult = { ok: true, done: true, runId: null, kind: opts.kind, status: "skipped", accountsTotal: 0, accountsDone: 0, rowsWritten: 0, warnings: [] };
  const cfg = readMetaConfig();
  const missing = missingMetaEnvs(cfg);
  if (missing.length) return { ...base, skipped: "not_configured", reason: `Meta Ads não configurada (${missing.join(", ")})` };
  let store = opts.store;
  if (!store) {
    const db = await getDb();
    if (!db) return { ...base, ok: false, status: "failed", reason: "DB indisponível" };
    store = mysqlAdsSyncStore(db);
  }
  const s = store;
  await s.saveConnection(META_PROVIDER, { lastCheckedAt: nowMysql() });

  const r = await runAdsSync<AdsAccountRef, MetaCampaigns>({
    provider: META_PROVIDER, label: "Meta", kind: opts.kind, deadlineAt: opts.deadlineAt, triggeredById: opts.triggeredById ?? null,
    store: s, today: opts.today,
    loadAccounts: async () => {
      await ensureMetaAccounts(s, cfg, opts.fetchImpl);
      return (await s.listSelectedAccounts(META_PROVIDER)).filter((a) => cfg.accountIds.includes(a.customerId));
    },
    beforeAccount: async (acc, warnings) => {
      try { return await fetchMetaCampaigns(cfg, acc.customerId, opts.fetchImpl); }
      catch (err: any) { warnings.push(`${acc.customerId}: estado das campanhas não recolhido (${String(err?.message ?? err).slice(0, 120)})`); return new Map(); }
    },
    fetchChunk: async (acc, from, to, campaigns) => {
      const rows = await fetchMetaInsights(cfg, acc.customerId, from, to, opts.fetchImpl);
      const seen = new Map<string, (typeof rows)[number]>();
      for (const row of rows) seen.set(row.campaignId, row);
      return {
        campaigns: Array.from(seen.values()).map((row) => {
          const c = campaigns?.get(row.campaignId);
          return { externalId: row.campaignId, name: c?.name ?? row.campaignName, status: c?.status ?? undefined, channelType: "META", budgetMicros: c?.dailyBudgetMicros ?? undefined };
        }),
        daily: rows.map((row) => ({ campaignExternalId: row.campaignId, date: row.date, costMicros: row.costMicros, impressions: row.impressions, clicks: row.clicks, conversions: row.conversions, conversionValueMicros: row.conversionValueMicros, allConversions: row.conversions })),
        actions: rows.flatMap((row) => row.actions.map((a) => ({ campaignExternalId: row.campaignId, date: row.date, actionResource: a.actionType, actionName: a.actionType, category: a.actionType, conversions: a.conversions, valueMicros: a.valueMicros }))),
      };
    },
    classifyError: (err) => (err instanceof MetaApiError && err.isAuth ? "auth" : "continue"),
  });

  if (r.status !== "skipped" && r.done) {
    await s.saveConnection(META_PROVIDER, r.authError
      ? { status: "reauth_required", lastError: `Token Meta inválido ou sem permissão: ${r.authError}`, lastCheckedAt: nowMysql() }
      : { status: r.status === "failed" ? "error" : "connected", lastError: r.status === "done" ? null : (r.reason ?? null), lastCheckedAt: nowMysql() });
  }
  return r;
}

export async function listMetaSyncRuns(limit = 20) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(integrationSyncRuns).where(eq(integrationSyncRuns.provider, META_PROVIDER)).orderBy(desc(integrationSyncRuns.id)).limit(limit);
}

export async function lastSuccessfulMetaSyncAt(): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select({ finishedAt: integrationSyncRuns.finishedAt }).from(integrationSyncRuns)
    .where(and(eq(integrationSyncRuns.provider, META_PROVIDER), eq(integrationSyncRuns.status, "done")))
    .orderBy(desc(integrationSyncRuns.id)).limit(1);
  return rows[0]?.finishedAt ?? null;
}

export async function metaStatus() {
  const cfg = readMetaConfig();
  const db = await getDb();
  const conn = db ? (await db.select().from(integrationConnections).where(eq(integrationConnections.provider, META_PROVIDER)).limit(1))[0] ?? null : null;
  const accounts = db ? await db.select().from(adAccounts).where(eq(adAccounts.provider, META_PROVIDER)).orderBy(adAccounts.name) : [];
  const last = await lastSuccessfulMetaSyncAt();
  return {
    configured: missingMetaEnvs(cfg).length === 0,
    missing: missingMetaEnvs(cfg),
    apiVersion: cfg.apiVersion,
    configuredAccountIds: cfg.accountIds,
    connection: conn ? { status: conn.status, lastError: conn.lastError, lastCheckedAt: conn.lastCheckedAt } : null,
    accounts,
    lastSuccessfulSyncAt: last,
    stale: missingMetaEnvs(cfg).length === 0 ? isStaleSince(last) : false,
  };
}
