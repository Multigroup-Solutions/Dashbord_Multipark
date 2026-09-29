/**
 * Recolha automática do Google Ads (plano, fase C).
 *
 *  - hourly: últimos 7 dias (hoje provisório); nightly: 90 dias; monthly: o
 *    resto do histórico; initial/manual: tudo;
 *  - mutex em linha `syncLockAt` (sem execuções sobrepostas; não GET_LOCK), uma conta de cada vez, uma
 *    falha numa conta não pára as outras;
 *  - RETOMÁVEL: cursor (conta, pedaço) gravado em integration_sync_runs; com
 *    `deadlineAt` (Vercel: 60 s) devolve done:false e a chamada seguinte continua;
 *  - VALIDA antes de substituir: uma resposta vazia para um intervalo que já
 *    tinha dados NÃO apaga nada (fica um aviso); erros de acesso não gravam zeros;
 *  - regista execução, contas, intervalo, linhas e erro — sem credenciais;
 *  - estado HONESTO (24 set 2026): todas as contas falharam → failed; algumas
 *    → partial (terminada, com finishedAt); só "done" conta como recolha com
 *    sucesso. Ligação a pedir reautorização → failed logo à cabeça (ok:false),
 *    para o cron do GitHub ficar vermelho e abrir issue.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { adAccounts, integrationSyncRuns } from "../../../drizzle/schema";
import { GOOGLE_ADS_PROVIDER, missingApiEnvs, readGoogleAdsConfig } from "./config";
import { getConnection, saveConnection } from "./oauth";
import { fetchCampaignDaily, fetchConversionActions, getCustomer, listAccessibleCustomers, listCustomerClients, GoogleAdsApiError } from "./client";
import { type SyncKind } from "./metrics";
import { isStaleSince } from "../../../shared/marketingRules";
import { mysqlAdsSyncStore, nowMysql, runAdsSync, type AdsAccountRef, type AdsSyncResult } from "../adsSyncRunner";

export type SyncResult = AdsSyncResult;

/**
 * Descobre/atualiza as contas acessíveis (gestora + filhas). Não seleciona
 * nenhuma. Uma conta que falha (sem acesso, removida) NÃO pára as outras: o
 * erro fica na lista e segue-se para a próxima.
 */
export async function refreshAccounts(): Promise<{ found: number; managers: number; error?: string; errors?: string[] }> {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const cfg = readGoogleAdsConfig();
  const ids = await listAccessibleCustomers();
  let found = 0, managers = 0;
  const seen = new Set<string>();
  const errors: string[] = [];
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
      errors.push(`${id}: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
  return errors.length ? { found, managers, error: `${errors.length} conta(s) com erro — ${errors[0]}`.slice(0, 300), errors } : { found, managers };
}

/**
 * Recolha com o motor comum (../adsSyncRunner): lock em linha (try/finally),
 * retoma por cursor, validação de respostas vazias, estado honesto.
 * Sem ligação / sem contas / lock ocupado → skipped com ok:true (nada a fazer
 * não é falha). Reautorização necessária → failed (ok:false).
 */
export async function runGoogleAdsSync(opts: { kind: SyncKind; deadlineAt?: number; triggeredById?: number | null }): Promise<SyncResult> {
  const db = await getDb();
  const base: SyncResult = { ok: true, done: true, runId: null, kind: opts.kind, status: "skipped", accountsTotal: 0, accountsDone: 0, rowsWritten: 0, warnings: [] };
  if (!db) return { ...base, ok: false, status: "failed", reason: "DB indisponível" };
  const missing = missingApiEnvs();
  if (missing.length) return { ...base, skipped: "not_configured", reason: `envs em falta: ${missing.join(", ")}` };
  const conn = await getConnection();
  if (!conn || conn.status === "disconnected" || !conn.refreshTokenEnc) return { ...base, skipped: "not_connected", reason: "Google Ads não está ligado" };
  if (conn.status === "reauth_required") return { ...base, ok: false, status: "failed", reason: "Reautorização necessária: volta a ligar o Google Ads em Integrações" };

  const cfg = readGoogleAdsConfig();
  const r = await runAdsSync<AdsAccountRef>({
    provider: GOOGLE_ADS_PROVIDER, kind: opts.kind, deadlineAt: opts.deadlineAt, triggeredById: opts.triggeredById ?? null,
    store: mysqlAdsSyncStore(db),
    loadAccounts: async () => (await db.select().from(adAccounts).where(and(eq(adAccounts.provider, GOOGLE_ADS_PROVIDER), eq(adAccounts.selected, 1), eq(adAccounts.isManager, 0))))
      .map((a) => ({ id: a.id, customerId: a.customerId, currency: a.currency, loginCustomerId: a.loginCustomerId })),
    fetchChunk: async (acc, from, to, _ctx, warnings) => {
      const login = acc.loginCustomerId ?? cfg.loginCustomerId ?? null;
      const rows = await fetchCampaignDaily(acc.customerId, from, to, login);
      if (!rows.length) return { campaigns: [], daily: [], actions: null };
      let actions: Awaited<ReturnType<typeof fetchConversionActions>> = [];
      try { actions = await fetchConversionActions(acc.customerId, from, to, login); }
      catch (err: any) { warnings.push(`${acc.customerId} ${from}→${to}: ações de conversão não recolhidas (${String(err?.message ?? err).slice(0, 120)})`); }
      return {
        campaigns: rows.map((r) => ({ externalId: r.campaignId, name: r.campaignName, status: r.campaignStatus, channelType: r.channelType, budgetMicros: r.budgetMicros })),
        daily: rows.map((r) => ({ campaignExternalId: r.campaignId, date: r.date, costMicros: r.costMicros, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, conversionValueMicros: r.conversionValueMicros, allConversions: r.allConversions })),
        actions: actions.length ? actions.map((a) => ({ campaignExternalId: a.campaignId, date: a.date, actionResource: a.actionResource, actionName: a.actionName, category: a.category, conversions: a.conversions, valueMicros: a.valueMicros })) : null,
      };
    },
    // sem acesso à conta (401/403): não vale a pena continuar essa conta
    // token recusado pela Google (invalid_grant…) → a ligação já ficou marcada; pára a conta
    classifyError: (err) => ((err as any)?.oauthError ? "auth"
      : err instanceof GoogleAdsApiError && (err.status === 401 || err.status === 403) ? "stop_account" : "continue"),
  });
  if (r.status !== "skipped" && r.done) {
    try { await saveConnection({ lastCheckedAt: nowMysql() }); } catch { /* indicador */ }
  }
  return r;
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

/** Sinal de atraso: a recolha é diária → parada ao fim de 26 h sem sucesso (igual em todo o lado). */
export async function isSyncStale(): Promise<boolean> {
  return isStaleSince(await lastSuccessfulSyncAt());
}

/** Última execução terminada (qualquer estado) — para o alerta do Marketing. */
export async function lastFinishedRun(provider: string = GOOGLE_ADS_PROVIDER): Promise<{ status: string; error: string | null; finishedAt: string | null } | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select({ status: integrationSyncRuns.status, error: integrationSyncRuns.error, finishedAt: integrationSyncRuns.finishedAt }).from(integrationSyncRuns)
    .where(and(eq(integrationSyncRuns.provider, provider), inArray(integrationSyncRuns.status, ["done", "partial", "failed"]), sql`${integrationSyncRuns.finishedAt} IS NOT NULL`))
    .orderBy(desc(integrationSyncRuns.id)).limit(1);
  return rows[0] ?? null;
}
