/**
 * Recolha automática do Google Ads (plano, fase C).
 *
 *  - hourly: últimos 7 dias (hoje provisório); nightly: 90 dias; monthly: o
 *    resto do histórico; initial/manual: tudo;
 *  - lock nomeado (sem execuções sobrepostas), uma conta de cada vez, uma
 *    falha numa conta não pára as outras;
 *  - RETOMÁVEL: cursor (conta, pedaço) gravado em integration_sync_runs; com
 *    `deadlineAt` (Vercel: 60 s) devolve done:false e a chamada seguinte continua;
 *  - VALIDA antes de substituir: uma resposta vazia para um intervalo que já
 *    tinha dados NÃO apaga nada (fica um aviso); erros de acesso não gravam zeros;
 *  - regista execução, contas, intervalo, linhas e erro — sem credenciais.
 */
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { adAccounts, adCampaigns, adConversionActionMetrics, adDailyMetrics, integrationSyncRuns } from "../../../drizzle/schema";
import { GOOGLE_ADS_PROVIDER, missingApiEnvs, readGoogleAdsConfig } from "./config";
import { getConnection, saveConnection } from "./oauth";
import { fetchCampaignDaily, fetchConversionActions, getCustomer, listAccessibleCustomers, listCustomerClients, GoogleAdsApiError } from "./client";
import { chunkRange, isProvisional, syncWindow, type SyncKind } from "./metrics";

const nowMysql = () => new Date().toISOString().slice(0, 19).replace("T", " ");
function lisbonToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export interface SyncResult {
  ok: boolean;
  done: boolean;
  runId: number | null;
  kind: SyncKind;
  status: "done" | "partial" | "failed" | "skipped";
  reason?: string;
  accountsTotal: number;
  accountsDone: number;
  rowsWritten: number;
  warnings: string[];
  range?: { from: string; to: string };
}

/** Descobre/atualiza as contas acessíveis (gestora + filhas). Não seleciona nenhuma. */
export async function refreshAccounts(): Promise<{ found: number; managers: number; error?: string }> {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const cfg = readGoogleAdsConfig();
  const ids = await listAccessibleCustomers();
  let found = 0, managers = 0;
  const seen = new Set<string>();
  const upsert = async (row: { customerId: string; name: string; currency: string | null; timezone: string | null; manager: boolean; status: string }, loginCustomerId: string | null) => {
    if (seen.has(row.customerId)) return;   // a mesma conta pode aparecer por várias gestoras: uma vez só
    seen.add(row.customerId);
    await db.insert(adAccounts).values({
      provider: GOOGLE_ADS_PROVIDER, customerId: row.customerId, loginCustomerId, name: row.name, currency: row.currency,
      timezone: row.timezone, isManager: row.manager ? 1 : 0, status: row.status,
    }).onDuplicateKeyUpdate({ set: { name: row.name, currency: row.currency, timezone: row.timezone, isManager: row.manager ? 1 : 0, status: row.status, loginCustomerId } });
    found++; if (row.manager) managers++;
  };
  for (const id of ids) {
    try {
      const me = await getCustomer(id, cfg.loginCustomerId ?? id);
      if (!me) continue;
      await upsert(me, null);
      if (me.manager) {
        const kids = await listCustomerClients(id);
        for (const k of kids) if (k.customerId !== id) await upsert(k, id);
      }
    } catch (err: any) {
      return { found, managers, error: String(err?.message ?? err).slice(0, 300) };
    }
  }
  return { found, managers };
}

async function acquireLock(db: NonNullable<Awaited<ReturnType<typeof getDb>>>): Promise<boolean> {
  const r = (await db.execute(sql`SELECT GET_LOCK('google_ads_sync', 0) AS ok`)) as any;
  return Number((Array.isArray(r[0]) ? r[0][0] : r[0])?.ok ?? 0) === 1;
}
async function releaseLock(db: NonNullable<Awaited<ReturnType<typeof getDb>>>) {
  try { await db.execute(sql`SELECT RELEASE_LOCK('google_ads_sync')`); } catch { /* ignore */ }
}

/**
 * Escreve um pedaço (conta × intervalo). Validação: se a API devolver 0 linhas
 * mas já existirem registos da API nesse intervalo, mantém-nos e avisa.
 */
async function writeChunk(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, account: { id: number; customerId: string; currency: string | null; loginCustomerId: string | null }, from: string, to: string, runId: number, today: string, warnings: string[]): Promise<number> {
  const cfg = readGoogleAdsConfig();
  const login = account.loginCustomerId ?? cfg.loginCustomerId ?? null;
  const rows = await fetchCampaignDaily(account.customerId, from, to, login);
  if (rows.length === 0) {
    const [ex] = await db.select({ n: sql<number>`COUNT(*)` }).from(adDailyMetrics)
      .where(and(eq(adDailyMetrics.provider, GOOGLE_ADS_PROVIDER), eq(adDailyMetrics.accountId, account.id), eq(adDailyMetrics.source, "api"), gte(adDailyMetrics.date, from), lte(adDailyMetrics.date, to)));
    if (Number(ex?.n ?? 0) > 0) warnings.push(`${account.customerId} ${from}→${to}: resposta vazia; mantidos ${ex?.n} registos anteriores`);
    return 0;
  }
  let actions: Awaited<ReturnType<typeof fetchConversionActions>> = [];
  try { actions = await fetchConversionActions(account.customerId, from, to, login); }
  catch (err: any) { warnings.push(`${account.customerId} ${from}→${to}: ações de conversão não recolhidas (${String(err?.message ?? err).slice(0, 120)})`); }

  let written = 0;
  await db.transaction(async (tx) => {
    // campanhas pelos IDs oficiais
    const seen = new Map<string, (typeof rows)[number]>();
    for (const r of rows) seen.set(r.campaignId, r);
    for (const r of seen.values()) {
      await tx.insert(adCampaigns).values({
        provider: GOOGLE_ADS_PROVIDER, accountId: account.id, externalId: r.campaignId, name: r.campaignName, status: r.campaignStatus,
        channelType: r.channelType, budgetMicros: r.budgetMicros, lastSeenAt: nowMysql(),
      }).onDuplicateKeyUpdate({ set: { name: r.campaignName, status: r.campaignStatus, channelType: r.channelType, budgetMicros: r.budgetMicros, lastSeenAt: nowMysql() } });
    }
    // substitui o intervalo (só origem API) e reinsere
    await tx.delete(adDailyMetrics).where(and(eq(adDailyMetrics.provider, GOOGLE_ADS_PROVIDER), eq(adDailyMetrics.accountId, account.id), eq(adDailyMetrics.source, "api"), gte(adDailyMetrics.date, from), lte(adDailyMetrics.date, to)));
    const values = rows.map((r) => ({
      provider: GOOGLE_ADS_PROVIDER, accountId: account.id, campaignExternalId: r.campaignId, date: r.date,
      costMicros: r.costMicros, currency: account.currency, impressions: r.impressions, clicks: r.clicks,
      conversions: r.conversions.toFixed(4), conversionValueMicros: r.conversionValueMicros, allConversions: r.allConversions.toFixed(4),
      source: "api" as const, isProvisional: isProvisional(r.date, today) ? 1 : 0, syncRunId: runId, collectedAt: nowMysql(),
    }));
    for (let i = 0; i < values.length; i += 500) {
      await tx.insert(adDailyMetrics).values(values.slice(i, i + 500)).onDuplicateKeyUpdate({ set: { costMicros: sql`VALUES(costMicros)`, impressions: sql`VALUES(impressions)`, clicks: sql`VALUES(clicks)`, conversions: sql`VALUES(conversions)`, conversionValueMicros: sql`VALUES(conversionValueMicros)`, allConversions: sql`VALUES(allConversions)`, isProvisional: sql`VALUES(isProvisional)`, syncRunId: runId, collectedAt: nowMysql() } });
    }
    written += values.length;
    if (actions.length) {
      await tx.delete(adConversionActionMetrics).where(and(eq(adConversionActionMetrics.provider, GOOGLE_ADS_PROVIDER), eq(adConversionActionMetrics.accountId, account.id), gte(adConversionActionMetrics.date, from), lte(adConversionActionMetrics.date, to)));
      const av = actions.map((a) => ({
        provider: GOOGLE_ADS_PROVIDER, accountId: account.id, campaignExternalId: a.campaignId, date: a.date, actionResource: a.actionResource,
        actionName: a.actionName, category: a.category, conversions: a.conversions.toFixed(4), valueMicros: a.valueMicros, syncRunId: runId, collectedAt: nowMysql(),
      }));
      for (let i = 0; i < av.length; i += 500) await tx.insert(adConversionActionMetrics).values(av.slice(i, i + 500)).onDuplicateKeyUpdate({ set: { conversions: sql`VALUES(conversions)`, valueMicros: sql`VALUES(valueMicros)`, syncRunId: runId } });
    }
  });
  return written;
}

export async function runGoogleAdsSync(opts: { kind: SyncKind; deadlineAt?: number; triggeredById?: number | null }): Promise<SyncResult> {
  const db = await getDb();
  const base: SyncResult = { ok: false, done: true, runId: null, kind: opts.kind, status: "skipped", accountsTotal: 0, accountsDone: 0, rowsWritten: 0, warnings: [] };
  if (!db) return { ...base, reason: "DB indisponível" };
  const missing = missingApiEnvs();
  if (missing.length) return { ...base, reason: `envs em falta: ${missing.join(", ")}` };
  const conn = await getConnection();
  if (!conn || conn.status === "disconnected" || !conn.refreshTokenEnc) return { ...base, reason: "Google Ads não está ligado" };

  const accounts = await db.select().from(adAccounts).where(and(eq(adAccounts.provider, GOOGLE_ADS_PROVIDER), eq(adAccounts.selected, 1), eq(adAccounts.isManager, 0)));
  if (accounts.length === 0) return { ...base, reason: "nenhuma conta publicitária selecionada" };

  if (!(await acquireLock(db))) return { ...base, reason: "já há uma recolha a correr" };
  const today = lisbonToday();
  const window = syncWindow(opts.kind, today);
  const chunks = chunkRange(window.from, window.to, opts.kind === "hourly" ? 7 : 31);
  const warnings: string[] = [];

  // retoma uma execução parcial recente do mesmo tipo
  let runId: number;
  let cursor = { accountIdx: 0, chunkIdx: 0 };
  let rowsWritten = 0;
  const prev = await db.select().from(integrationSyncRuns)
    .where(and(eq(integrationSyncRuns.provider, GOOGLE_ADS_PROVIDER), eq(integrationSyncRuns.kind, opts.kind), eq(integrationSyncRuns.status, "partial")))
    .orderBy(desc(integrationSyncRuns.id)).limit(1);
  const resumable = prev[0] && prev[0].rangeFrom === window.from && prev[0].rangeTo === window.to && (Date.now() - new Date(prev[0].startedAt).getTime()) < 6 * 3600_000;
  if (resumable) {
    runId = prev[0].id; rowsWritten = prev[0].rowsWritten;
    try { cursor = JSON.parse(prev[0].cursor ?? "{}"); } catch { /* recomeça */ }
    if (prev[0].warnings) warnings.push(...String(prev[0].warnings).split("\n").filter(Boolean));
    await db.update(integrationSyncRuns).set({ status: "running" }).where(eq(integrationSyncRuns.id, runId));
  } else {
    const ins = await db.insert(integrationSyncRuns).values({ provider: GOOGLE_ADS_PROVIDER, kind: opts.kind, status: "running", rangeFrom: window.from, rangeTo: window.to, accountsTotal: accounts.length, triggeredById: opts.triggeredById ?? null });
    runId = Number((ins as any)?.[0]?.insertId ?? 0);
  }

  let accountsDone = cursor.accountIdx;
  let failed = false;
  try {
    for (let ai = cursor.accountIdx; ai < accounts.length; ai++) {
      const acc = accounts[ai];
      let accountFailed = false;
      for (let ci = ai === cursor.accountIdx ? cursor.chunkIdx : 0; ci < chunks.length; ci++) {
        if (opts.deadlineAt && Date.now() > opts.deadlineAt) {
          await db.update(integrationSyncRuns).set({ status: "partial", cursor: JSON.stringify({ accountIdx: ai, chunkIdx: ci }), accountsDone, rowsWritten, warnings: warnings.join("\n") || null }).where(eq(integrationSyncRuns.id, runId));
          await releaseLock(db);
          return { ok: true, done: false, runId, kind: opts.kind, status: "partial", accountsTotal: accounts.length, accountsDone, rowsWritten, warnings, range: window };
        }
        const ch = chunks[ci];
        try {
          rowsWritten += await writeChunk(db, acc, ch.from, ch.to, runId, today, warnings);
        } catch (err: any) {
          accountFailed = true;
          const msg = String(err?.message ?? err).slice(0, 300);
          warnings.push(`${acc.customerId} ${ch.from}→${ch.to}: ${msg}`);
          await db.update(adAccounts).set({ lastError: msg }).where(eq(adAccounts.id, acc.id));
          if (err instanceof GoogleAdsApiError && (err.status === 401 || err.status === 403)) {
            // sem acesso: não vale a pena continuar esta conta
            break;
          }
        }
      }
      if (!accountFailed) await db.update(adAccounts).set({ lastSyncAt: nowMysql(), lastError: null }).where(eq(adAccounts.id, acc.id));
      accountsDone = ai + 1;
    }
  } catch (err: any) {
    failed = true;
    await db.update(integrationSyncRuns).set({ status: "failed", error: String(err?.message ?? err).slice(0, 1000), accountsDone, rowsWritten, warnings: warnings.join("\n") || null, finishedAt: nowMysql() }).where(eq(integrationSyncRuns.id, runId));
    await saveConnection({ lastCheckedAt: nowMysql() });
    await releaseLock(db);
    return { ok: false, done: true, runId, kind: opts.kind, status: "failed", reason: String(err?.message ?? err).slice(0, 300), accountsTotal: accounts.length, accountsDone, rowsWritten, warnings, range: window };
  }

  await db.update(integrationSyncRuns).set({ status: "done", cursor: null, accountsDone, rowsWritten, warnings: warnings.join("\n") || null, finishedAt: nowMysql() }).where(eq(integrationSyncRuns.id, runId));
  await saveConnection({ lastCheckedAt: nowMysql() });
  await releaseLock(db);
  return { ok: !failed, done: true, runId, kind: opts.kind, status: "done", accountsTotal: accounts.length, accountsDone, rowsWritten, warnings, range: window };
}

export async function listSyncRuns(limit = 20) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(integrationSyncRuns).where(eq(integrationSyncRuns.provider, GOOGLE_ADS_PROVIDER)).orderBy(desc(integrationSyncRuns.id)).limit(limit);
}

/** Última recolha concluída (para "última atualização" nos ecrãs). */
export async function lastSuccessfulSyncAt(): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select({ finishedAt: integrationSyncRuns.finishedAt }).from(integrationSyncRuns)
    .where(and(eq(integrationSyncRuns.provider, GOOGLE_ADS_PROVIDER), inArray(integrationSyncRuns.status, ["done"])))
    .orderBy(desc(integrationSyncRuns.id)).limit(1);
  return rows[0]?.finishedAt ?? null;
}

/** Sinal de atraso: dois ciclos horários seguidos sem sucesso. */
export async function isSyncStale(): Promise<boolean> {
  const last = await lastSuccessfulSyncAt();
  if (!last) return true;
  return Date.now() - new Date(last.replace(" ", "T") + "Z").getTime() > 2 * 3600_000;
}
