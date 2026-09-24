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
 */
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { adAccounts, adCampaigns, adConversionActionMetrics, adDailyMetrics, integrationConnections, integrationSyncRuns } from "../../../drizzle/schema";
import { chunkRange, isProvisional, normalizeSyncKind, syncWindow, type SyncKind } from "../googleAds/metrics";
import { finalSyncStatus, isStaleSince } from "../../../shared/marketingRules";
import { META_PROVIDER, missingMetaEnvs, readMetaConfig, type MetaConfig } from "./config";
import { fetchMetaAccount, fetchMetaCampaigns, fetchMetaInsights, MetaApiError, type FetchLike } from "./insights";

const nowMysql = () => new Date().toISOString().slice(0, 19).replace("T", " ");
function lisbonToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export interface MetaSyncResult {
  ok: boolean;
  done: boolean;
  runId: number | null;
  kind: SyncKind;
  status: "done" | "partial" | "failed" | "skipped";
  skipped?: "not_configured" | "locked" | "no_accounts";
  reason?: string;
  accountsTotal: number;
  accountsDone: number;
  rowsWritten: number;
  warnings: string[];
  range?: { from: string; to: string };
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function getMetaConnection(db: Db) {
  const rows = await db.select().from(integrationConnections).where(eq(integrationConnections.provider, META_PROVIDER)).limit(1);
  return rows[0] ?? null;
}
async function saveMetaConnection(db: Db, patch: Partial<typeof integrationConnections.$inferInsert>) {
  const ex = await getMetaConnection(db);
  if (ex) await db.update(integrationConnections).set(patch).where(eq(integrationConnections.id, ex.id));
  else await db.insert(integrationConnections).values({ provider: META_PROVIDER, status: "connected", ...patch });
}

const LOCK_TTL_MIN = 20;
async function acquireLock(db: Db): Promise<boolean> {
  const r = (await db.execute(sql`
    UPDATE integration_connections SET syncLockAt = NOW()
    WHERE provider = ${META_PROVIDER}
      AND (syncLockAt IS NULL OR syncLockAt < NOW() - INTERVAL ${sql.raw(String(LOCK_TTL_MIN))} MINUTE)
  `)) as any;
  const header = Array.isArray(r) ? r[0] : r;
  const got = Number(header?.affectedRows ?? 0) === 1;
  if (got) {
    await db.update(integrationSyncRuns)
      .set({ status: "failed", error: "interrompida (sem conclusão)", finishedAt: nowMysql() })
      .where(and(eq(integrationSyncRuns.provider, META_PROVIDER), eq(integrationSyncRuns.status, "running"),
        sql`${integrationSyncRuns.startedAt} < NOW() - INTERVAL ${sql.raw(String(LOCK_TTL_MIN))} MINUTE`));
  }
  return got;
}
async function releaseLock(db: Db) {
  try { await db.update(integrationConnections).set({ syncLockAt: null }).where(eq(integrationConnections.provider, META_PROVIDER)); } catch { /* ignore */ }
}

/** Garante uma linha em ad_accounts por conta configurada (nova = selecionada). */
export async function ensureMetaAccounts(db: Db, cfg: MetaConfig, fetchImpl?: FetchLike): Promise<void> {
  for (const id of cfg.accountIds) {
    let info: Awaited<ReturnType<typeof fetchMetaAccount>> | null = null;
    try { info = await fetchMetaAccount(cfg, id, fetchImpl); } catch { info = null; }
    await db.insert(adAccounts).values({
      provider: META_PROVIDER, customerId: id, name: info?.name ?? `Meta ${id}`, currency: info?.currency ?? null,
      timezone: info?.timezone ?? null, isManager: 0, status: info?.status ?? null, selected: 1,
    }).onDuplicateKeyUpdate({ set: info ? { name: info.name ?? `Meta ${id}`, currency: info.currency, timezone: info.timezone, status: info.status } : { status: sql`status` } });
  }
}

async function writeChunk(db: Db, cfg: MetaConfig, account: { id: number; customerId: string; currency: string | null }, from: string, to: string, runId: number, today: string, warnings: string[], campaigns: Map<string, { name: string; status: string | null; dailyBudgetMicros: number | null }>, fetchImpl?: FetchLike): Promise<number> {
  const rows = await fetchMetaInsights(cfg, account.customerId, from, to, fetchImpl);
  if (rows.length === 0) {
    const [ex] = await db.select({ n: sql<number>`COUNT(*)` }).from(adDailyMetrics)
      .where(and(eq(adDailyMetrics.provider, META_PROVIDER), eq(adDailyMetrics.accountId, account.id), eq(adDailyMetrics.source, "api"), gte(adDailyMetrics.date, from), lte(adDailyMetrics.date, to)));
    if (Number(ex?.n ?? 0) > 0) warnings.push(`${account.customerId} ${from}→${to}: resposta vazia; mantidos ${ex?.n} registos anteriores`);
    return 0;
  }
  let written = 0;
  await db.transaction(async (tx) => {
    const seen = new Map<string, (typeof rows)[number]>();
    for (const r of rows) seen.set(r.campaignId, r);
    for (const r of seen.values()) {
      const c = campaigns.get(r.campaignId);
      const name = c?.name ?? r.campaignName;
      await tx.insert(adCampaigns).values({
        provider: META_PROVIDER, accountId: account.id, externalId: r.campaignId, name, status: c?.status ?? null,
        channelType: "META", budgetMicros: c?.dailyBudgetMicros ?? null, lastSeenAt: nowMysql(),
      }).onDuplicateKeyUpdate({ set: { name, status: c?.status ?? sql`status`, budgetMicros: c?.dailyBudgetMicros ?? sql`budgetMicros`, lastSeenAt: nowMysql() } });
    }
    await tx.delete(adDailyMetrics).where(and(eq(adDailyMetrics.provider, META_PROVIDER), eq(adDailyMetrics.accountId, account.id), eq(adDailyMetrics.source, "api"), gte(adDailyMetrics.date, from), lte(adDailyMetrics.date, to)));
    const values = rows.map((r) => ({
      provider: META_PROVIDER, accountId: account.id, campaignExternalId: r.campaignId, date: r.date,
      costMicros: r.costMicros, currency: account.currency, impressions: r.impressions, clicks: r.clicks,
      conversions: r.conversions.toFixed(4), conversionValueMicros: r.conversionValueMicros, allConversions: r.conversions.toFixed(4),
      source: "api" as const, isProvisional: isProvisional(r.date, today) ? 1 : 0, syncRunId: runId, collectedAt: nowMysql(),
    }));
    for (let i = 0; i < values.length; i += 500) {
      await tx.insert(adDailyMetrics).values(values.slice(i, i + 500)).onDuplicateKeyUpdate({ set: { costMicros: sql`VALUES(costMicros)`, impressions: sql`VALUES(impressions)`, clicks: sql`VALUES(clicks)`, conversions: sql`VALUES(conversions)`, conversionValueMicros: sql`VALUES(conversionValueMicros)`, allConversions: sql`VALUES(allConversions)`, isProvisional: sql`VALUES(isProvisional)`, syncRunId: runId, collectedAt: nowMysql() } });
    }
    written += values.length;
    await tx.delete(adConversionActionMetrics).where(and(eq(adConversionActionMetrics.provider, META_PROVIDER), eq(adConversionActionMetrics.accountId, account.id), gte(adConversionActionMetrics.date, from), lte(adConversionActionMetrics.date, to)));
    const av = rows.flatMap((r) => r.actions.map((a) => ({
      provider: META_PROVIDER, accountId: account.id, campaignExternalId: r.campaignId, date: r.date, actionResource: a.actionType,
      actionName: a.actionType, category: a.actionType, conversions: a.conversions.toFixed(4), valueMicros: a.valueMicros, syncRunId: runId, collectedAt: nowMysql(),
    })));
    for (let i = 0; i < av.length; i += 500) await tx.insert(adConversionActionMetrics).values(av.slice(i, i + 500)).onDuplicateKeyUpdate({ set: { conversions: sql`VALUES(conversions)`, valueMicros: sql`VALUES(valueMicros)`, syncRunId: runId } });
  });
  return written;
}

export async function runMetaAdsSync(opts: { kind: SyncKind; deadlineAt?: number; triggeredById?: number | null; fetchImpl?: FetchLike }): Promise<MetaSyncResult> {
  const base: MetaSyncResult = { ok: true, done: true, runId: null, kind: opts.kind, status: "skipped", accountsTotal: 0, accountsDone: 0, rowsWritten: 0, warnings: [] };
  const cfg = readMetaConfig();
  const missing = missingMetaEnvs(cfg);
  if (missing.length) return { ...base, skipped: "not_configured", reason: `Meta Ads não configurada (${missing.join(", ")})` };
  const db = await getDb();
  if (!db) return { ...base, ok: false, status: "failed", reason: "DB indisponível" };

  await saveMetaConnection(db, { lastCheckedAt: nowMysql() });
  await ensureMetaAccounts(db, cfg, opts.fetchImpl);
  const accounts = (await db.select().from(adAccounts).where(and(eq(adAccounts.provider, META_PROVIDER), eq(adAccounts.selected, 1))))
    .filter((a) => cfg.accountIds.includes(a.customerId));
  if (accounts.length === 0) return { ...base, skipped: "no_accounts", reason: "nenhuma conta Meta selecionada" };
  if (!(await acquireLock(db))) return { ...base, skipped: "locked", reason: "já há uma recolha Meta a correr" };

  const today = lisbonToday();
  const window = syncWindow(opts.kind, today);
  const chunks = chunkRange(window.from, window.to, normalizeSyncKind(opts.kind) === "daily" ? 7 : 31);
  const warnings: string[] = [];
  let runId: number;
  let cursor: { accountIdx: number; chunkIdx: number; failed?: number; curFailed?: boolean } = { accountIdx: 0, chunkIdx: 0, failed: 0 };
  let rowsWritten = 0;
  const prev = await db.select().from(integrationSyncRuns)
    .where(and(eq(integrationSyncRuns.provider, META_PROVIDER), eq(integrationSyncRuns.kind, opts.kind), eq(integrationSyncRuns.status, "partial")))
    .orderBy(desc(integrationSyncRuns.id)).limit(1);
  const resumable = prev[0] && prev[0].cursor && !prev[0].finishedAt && prev[0].rangeFrom === window.from && prev[0].rangeTo === window.to && (Date.now() - new Date(prev[0].startedAt).getTime()) < 6 * 3600_000;
  if (resumable) {
    runId = prev[0].id; rowsWritten = prev[0].rowsWritten;
    try { cursor = JSON.parse(prev[0].cursor ?? "{}"); } catch { /* recomeça */ }
    if (prev[0].warnings) warnings.push(...String(prev[0].warnings).split("\n").filter(Boolean));
    await db.update(integrationSyncRuns).set({ status: "running" }).where(eq(integrationSyncRuns.id, runId));
  } else {
    const ins = await db.insert(integrationSyncRuns).values({ provider: META_PROVIDER, kind: opts.kind, status: "running", rangeFrom: window.from, rangeTo: window.to, accountsTotal: accounts.length, triggeredById: opts.triggeredById ?? null });
    runId = Number((ins as any)?.[0]?.insertId ?? 0);
  }

  let accountsDone = cursor.accountIdx;
  let accountsFailed = Number(cursor.failed ?? 0);
  let authError: string | null = null;
  try {
    for (let ai = cursor.accountIdx; ai < accounts.length; ai++) {
      const acc = accounts[ai];
      let accountFailed = ai === cursor.accountIdx ? Boolean(cursor.curFailed) : false;
      let campaigns = new Map<string, { name: string; status: string | null; dailyBudgetMicros: number | null }>();
      try { campaigns = await fetchMetaCampaigns(cfg, acc.customerId, opts.fetchImpl); }
      catch (err: any) { warnings.push(`${acc.customerId}: estado das campanhas não recolhido (${String(err?.message ?? err).slice(0, 120)})`); }
      for (let ci = ai === cursor.accountIdx ? cursor.chunkIdx : 0; ci < chunks.length; ci++) {
        if (opts.deadlineAt && Date.now() > opts.deadlineAt) {
          await db.update(integrationSyncRuns).set({ status: "partial", cursor: JSON.stringify({ accountIdx: ai, chunkIdx: ci, failed: accountsFailed, curFailed: accountFailed }), accountsDone, rowsWritten, warnings: warnings.join("\n") || null }).where(eq(integrationSyncRuns.id, runId));
          await releaseLock(db);
          return { ok: true, done: false, runId, kind: opts.kind, status: "partial", accountsTotal: accounts.length, accountsDone, rowsWritten, warnings, range: window };
        }
        const ch = chunks[ci];
        try {
          rowsWritten += await writeChunk(db, cfg, acc, ch.from, ch.to, runId, today, warnings, campaigns, opts.fetchImpl);
        } catch (err: any) {
          accountFailed = true;
          const msg = String(err?.message ?? err).slice(0, 300);
          warnings.push(`${acc.customerId} ${ch.from}→${ch.to}: ${msg}`);
          await db.update(adAccounts).set({ lastError: msg }).where(eq(adAccounts.id, acc.id));
          if (err instanceof MetaApiError && err.isAuth) { authError = msg; break; }
        }
      }
      if (!accountFailed) await db.update(adAccounts).set({ lastSyncAt: nowMysql(), lastError: null }).where(eq(adAccounts.id, acc.id));
      else accountsFailed++;
      accountsDone = ai + 1;
    }
  } catch (err: any) {
    await db.update(integrationSyncRuns).set({ status: "failed", error: String(err?.message ?? err).slice(0, 1000), accountsDone, rowsWritten, warnings: warnings.join("\n") || null, finishedAt: nowMysql() }).where(eq(integrationSyncRuns.id, runId));
    await releaseLock(db);
    return { ok: false, done: true, runId, kind: opts.kind, status: "failed", reason: String(err?.message ?? err).slice(0, 300), accountsTotal: accounts.length, accountsDone, rowsWritten, warnings, range: window };
  }

  const final = finalSyncStatus(accounts.length, accountsFailed);
  const error = final.status === "done" ? null : `${accountsFailed} de ${accounts.length} conta(s) Meta falharam`;
  await db.update(integrationSyncRuns).set({ status: final.status, cursor: null, accountsDone, rowsWritten, error, warnings: warnings.join("\n") || null, finishedAt: nowMysql() }).where(eq(integrationSyncRuns.id, runId));
  await saveMetaConnection(db, authError
    ? { status: "reauth_required", lastError: `Token Meta inválido ou sem permissão: ${authError}`, lastCheckedAt: nowMysql() }
    : { status: final.status === "failed" ? "error" : "connected", lastError: error, lastCheckedAt: nowMysql() });
  await releaseLock(db);
  return { ok: final.ok, done: true, runId, kind: opts.kind, status: final.status, reason: error ?? undefined, accountsTotal: accounts.length, accountsDone, rowsWritten, warnings, range: window };
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
  const conn = db ? await getMetaConnection(db) : null;
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
