/**
 * Motor COMUM da recolha de anúncios (Google Ads e Meta) → ad_daily_metrics.
 *
 * Antes, cada fornecedor tinha a sua cópia do lock, da retoma, do writeChunk
 * e do "hoje em Lisboa" — e as cópias já tinham divergido (o lock do Google
 * podia ficar preso se algo lançasse entre o acquire e o release). Aqui:
 *
 *  - mutex em linha (integration_connections.syncLockAt, por fornecedor),
 *    adquirido e SEMPRE libertado num try/finally;
 *  - as contas carregam-se DEPOIS do lock (o Meta garante as suas contas uma
 *    vez por invocação, já com o lock);
 *  - retomável: cursor (conta, pedaço) em integration_sync_runs; com prazo
 *    devolve done:false e a chamada seguinte continua;
 *  - uma resposta vazia não apaga dados que já existiam (aviso);
 *  - estado honesto: todas as contas falharam → failed; algumas → partial
 *    terminada (ok:false); lock ocupado / sem contas → skipped com ok:true.
 *
 * O acesso à BD está atrás de `AdsSyncStore` — os testes usam uma memória.
 */
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { adAccounts, adCampaigns, adConversionActionMetrics, adDailyMetrics, integrationConnections, integrationSyncRuns } from "../../drizzle/schema";
import { chunkRange, isProvisional, normalizeSyncKind, syncWindow, type SyncKind } from "./googleAds/metrics";
import { finalSyncStatus } from "../../shared/marketingRules";

export const nowMysql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

/** "AAAA-MM-DD" de hoje em Lisboa. */
export function lisbonToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export type AdsSyncStatus = "done" | "partial" | "failed" | "skipped";
export type AdsSkipReason = "not_configured" | "not_connected" | "locked" | "no_accounts" | "db_unavailable";

export interface AdsSyncResult {
  ok: boolean;
  done: boolean;
  runId: number | null;
  kind: SyncKind;
  status: AdsSyncStatus;
  skipped?: AdsSkipReason;
  reason?: string;
  accountsTotal: number;
  accountsDone: number;
  rowsWritten: number;
  warnings: string[];
  range?: { from: string; to: string };
  /** 1.º erro de autorização (token inválido/sem permissão), se houve */
  authError?: string | null;
}

export interface AdsAccountRef { id: number; customerId: string; currency: string | null; loginCustomerId?: string | null }

/** `undefined` num campo opcional = manter o valor que já está na BD. */
export interface CampaignUpsert { externalId: string; name: string; status?: string | null; channelType?: string | null; budgetMicros?: number | null }
export interface DailyMetricRow {
  campaignExternalId: string; date: string; costMicros: number; impressions: number; clicks: number;
  conversions: number; conversionValueMicros: number; allConversions: number;
}
export interface ConversionActionMetricRow {
  campaignExternalId: string; date: string; actionResource: string; actionName: string; category: string | null;
  conversions: number; valueMicros: number;
}
/** O que um pedaço (conta × intervalo) devolveu. `actions: null` = não mexer nas ações guardadas. */
export interface ChunkPayload { campaigns: CampaignUpsert[]; daily: DailyMetricRow[]; actions: ConversionActionMetricRow[] | null }

export interface RunPatch {
  status?: "running" | "partial" | "done" | "failed";
  cursor?: string | null;
  accountsDone?: number;
  rowsWritten?: number;
  warnings?: string | null;
  error?: string | null;
  finished?: boolean;
}

export interface AdsSyncStore {
  acquireLock(provider: string, ttlMin: number): Promise<boolean>;
  releaseLock(provider: string): Promise<void>;
  findResumableRun(provider: string, kind: SyncKind, range: { from: string; to: string }): Promise<{ id: number; rowsWritten: number; cursor: string | null; warnings: string | null } | null>;
  createRun(provider: string, kind: SyncKind, range: { from: string; to: string }, accountsTotal: number, triggeredById: number | null): Promise<number>;
  updateRun(id: number, patch: RunPatch): Promise<void>;
  setAccountResult(accountId: number, ok: boolean, error: string | null): Promise<void>;
  countApiRows(provider: string, accountId: number, from: string, to: string): Promise<number>;
  writeChunk(provider: string, account: AdsAccountRef, from: string, to: string, runId: number, today: string, payload: ChunkPayload): Promise<number>;
  // genéricos (ad_accounts / integration_connections) — usados pelo Meta
  listSelectedAccounts(provider: string): Promise<Array<AdsAccountRef & { isManager: number }>>;
  upsertAccount(provider: string, row: { customerId: string; name: string; currency: string | null; timezone: string | null; status: string | null }, known: boolean): Promise<void>;
  saveConnection(provider: string, patch: { status?: "connected" | "error" | "reauth_required" | "disconnected"; lastError?: string | null; lastCheckedAt?: string }): Promise<void>;
}

export const LOCK_TTL_MIN = 20;
const RESUME_MAX_MS = 6 * 3600_000;

export type ErrorClass = "auth" | "stop_account" | "continue";

export interface RunAdsSyncOptions<A extends AdsAccountRef, Ctx> {
  provider: string;
  /** rótulo nas mensagens ("Meta" → "2 de 3 conta(s) Meta falharam") */
  label?: string;
  kind: SyncKind;
  deadlineAt?: number;
  triggeredById?: number | null;
  store: AdsSyncStore;
  today?: string;
  /** Contas a recolher — chamado JÁ COM O LOCK. */
  loadAccounts(): Promise<A[]>;
  /** Preparação por conta (ex.: estado das campanhas Meta). Erros → aviso. */
  beforeAccount?(account: A, warnings: string[]): Promise<Ctx>;
  fetchChunk(account: A, from: string, to: string, ctx: Ctx | undefined, warnings: string[]): Promise<ChunkPayload>;
  /** auth → pára a conta e marca authError; stop_account → pára a conta; continue → próximo pedaço. */
  classifyError?(err: unknown): ErrorClass;
}

const msgOf = (err: unknown, n = 300) => String((err as any)?.message ?? err).slice(0, n);

export async function runAdsSync<A extends AdsAccountRef, Ctx = undefined>(o: RunAdsSyncOptions<A, Ctx>): Promise<AdsSyncResult> {
  const { store, provider, kind } = o;
  const label = o.label ? ` ${o.label}` : "";
  const base: AdsSyncResult = { ok: true, done: true, runId: null, kind, status: "skipped", accountsTotal: 0, accountsDone: 0, rowsWritten: 0, warnings: [] };

  if (!(await store.acquireLock(provider, LOCK_TTL_MIN))) return { ...base, skipped: "locked", reason: `já há uma recolha${label} a correr` };
  let runId: number | null = null;
  const warnings: string[] = [];
  let accountsTotal = 0, accountsDone = 0, rowsWritten = 0;
  const today = o.today ?? lisbonToday();
  const window = syncWindow(kind, today);
  try {
    const accounts = await o.loadAccounts();
    accountsTotal = accounts.length;
    if (accounts.length === 0) return { ...base, skipped: "no_accounts", reason: `nenhuma conta${label} selecionada` };
    const chunks = chunkRange(window.from, window.to, normalizeSyncKind(kind) === "daily" ? 7 : 31);

    // retoma uma execução parcial recente do mesmo tipo (só as paradas por falta
    // de tempo — cursor e sem fim; uma "partial" terminada já tem finishedAt)
    let cursor: { accountIdx: number; chunkIdx: number; failed?: number; curFailed?: boolean } = { accountIdx: 0, chunkIdx: 0, failed: 0 };
    const prev = await store.findResumableRun(provider, kind, window);
    if (prev) {
      runId = prev.id; rowsWritten = prev.rowsWritten;
      try { cursor = { ...cursor, ...JSON.parse(prev.cursor ?? "{}") }; } catch { /* recomeça */ }
      if (prev.warnings) warnings.push(...String(prev.warnings).split("\n").filter(Boolean));
      await store.updateRun(runId, { status: "running" });
    } else {
      runId = await store.createRun(provider, kind, window, accounts.length, o.triggeredById ?? null);
    }

    accountsDone = Math.min(cursor.accountIdx, accounts.length);
    let accountsFailed = Number(cursor.failed ?? 0);
    let authError: string | null = null;
    for (let ai = accountsDone; ai < accounts.length; ai++) {
      const acc = accounts[ai];
      let accountFailed = ai === cursor.accountIdx ? Boolean(cursor.curFailed) : false;
      let ctx: Ctx | undefined;
      if (o.beforeAccount) {
        try { ctx = await o.beforeAccount(acc, warnings); }
        catch (err) { warnings.push(`${acc.customerId}: preparação falhou (${msgOf(err, 120)})`); }
      }
      for (let ci = ai === cursor.accountIdx ? cursor.chunkIdx : 0; ci < chunks.length; ci++) {
        if (o.deadlineAt && Date.now() > o.deadlineAt) {
          await store.updateRun(runId, { status: "partial", cursor: JSON.stringify({ accountIdx: ai, chunkIdx: ci, failed: accountsFailed, curFailed: accountFailed }), accountsDone, rowsWritten, warnings: warnings.join("\n") || null });
          return { ok: true, done: false, runId, kind, status: "partial", accountsTotal, accountsDone, rowsWritten, warnings, range: window, authError };
        }
        const ch = chunks[ci];
        try {
          const payload = await o.fetchChunk(acc, ch.from, ch.to, ctx, warnings);
          if (payload.daily.length === 0) {
            const n = await store.countApiRows(provider, acc.id, ch.from, ch.to);
            if (n > 0) warnings.push(`${acc.customerId} ${ch.from}→${ch.to}: resposta vazia; mantidos ${n} registos anteriores`);
          } else {
            rowsWritten += await store.writeChunk(provider, acc, ch.from, ch.to, runId, today, payload);
          }
        } catch (err) {
          accountFailed = true;
          const msg = msgOf(err);
          warnings.push(`${acc.customerId} ${ch.from}→${ch.to}: ${msg}`);
          await store.setAccountResult(acc.id, false, msg);
          const cls = o.classifyError?.(err) ?? "continue";
          if (cls === "auth") { authError = authError ?? msg; break; }
          if (cls === "stop_account") break;
        }
      }
      if (!accountFailed) await store.setAccountResult(acc.id, true, null);
      else accountsFailed++;
      accountsDone = ai + 1;
    }

    const final = finalSyncStatus(accounts.length, accountsFailed);
    const error = final.status === "done" ? null : `${accountsFailed} de ${accounts.length} conta(s)${label} falharam`;
    await store.updateRun(runId, { status: final.status, cursor: null, accountsDone, rowsWritten, error, warnings: warnings.join("\n") || null, finished: true });
    return { ok: final.ok, done: true, runId, kind, status: final.status, reason: error ?? undefined, accountsTotal, accountsDone, rowsWritten, warnings, range: window, authError };
  } catch (err) {
    const msg = msgOf(err);
    if (runId != null) {
      try { await store.updateRun(runId, { status: "failed", error: msgOf(err, 1000), accountsDone, rowsWritten, warnings: warnings.join("\n") || null, finished: true }); }
      catch { /* o erro original é o que interessa */ }
    }
    return { ok: false, done: true, runId, kind, status: "failed", reason: msg, accountsTotal, accountsDone, rowsWritten, warnings, range: window };
  } finally {
    await store.releaseLock(provider);
  }
}

// ─── Implementação MySQL ────────────────────────────────────────────────────

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export function mysqlAdsSyncStore(db: Db): AdsSyncStore {
  return {
    async acquireLock(provider, ttlMin) {
      const r = (await db.execute(sql`
        UPDATE integration_connections SET syncLockAt = NOW()
        WHERE provider = ${provider}
          AND (syncLockAt IS NULL OR syncLockAt < NOW() - INTERVAL ${sql.raw(String(Math.max(1, Math.floor(ttlMin))))} MINUTE)
      `)) as any;
      const header = Array.isArray(r) ? r[0] : r;
      const got = Number(header?.affectedRows ?? 0) === 1;
      if (got) {
        // corridas "running" órfãs (invocação morreu sem fechar) passam a failed
        await db.update(integrationSyncRuns)
          .set({ status: "failed", error: "interrompida (sem conclusão)", finishedAt: nowMysql() })
          .where(and(eq(integrationSyncRuns.provider, provider), eq(integrationSyncRuns.status, "running"),
            sql`${integrationSyncRuns.startedAt} < NOW() - INTERVAL ${sql.raw(String(Math.max(1, Math.floor(ttlMin))))} MINUTE`));
      }
      return got;
    },
    async releaseLock(provider) {
      try { await db.update(integrationConnections).set({ syncLockAt: null }).where(eq(integrationConnections.provider, provider)); } catch { /* ignore */ }
    },
    async findResumableRun(provider, kind, range) {
      const prev = await db.select().from(integrationSyncRuns)
        .where(and(eq(integrationSyncRuns.provider, provider), eq(integrationSyncRuns.kind, kind), eq(integrationSyncRuns.status, "partial")))
        .orderBy(desc(integrationSyncRuns.id)).limit(1);
      const p = prev[0];
      const ok = p && p.cursor && !p.finishedAt && p.rangeFrom === range.from && p.rangeTo === range.to && (Date.now() - new Date(p.startedAt).getTime()) < RESUME_MAX_MS;
      return ok ? { id: p.id, rowsWritten: p.rowsWritten, cursor: p.cursor ?? null, warnings: p.warnings ?? null } : null;
    },
    async createRun(provider, kind, range, accountsTotal, triggeredById) {
      const ins = await db.insert(integrationSyncRuns).values({ provider, kind, status: "running", rangeFrom: range.from, rangeTo: range.to, accountsTotal, triggeredById });
      return Number((ins as any)?.[0]?.insertId ?? 0);
    },
    async updateRun(id, patch) {
      const { finished, ...rest } = patch;
      await db.update(integrationSyncRuns).set({ ...rest, ...(finished ? { finishedAt: nowMysql() } : {}) }).where(eq(integrationSyncRuns.id, id));
    },
    async setAccountResult(accountId, ok, error) {
      await db.update(adAccounts).set(ok ? { lastSyncAt: nowMysql(), lastError: null } : { lastError: error }).where(eq(adAccounts.id, accountId));
    },
    async countApiRows(provider, accountId, from, to) {
      const [ex] = await db.select({ n: sql<number>`COUNT(*)` }).from(adDailyMetrics)
        .where(and(eq(adDailyMetrics.provider, provider), eq(adDailyMetrics.accountId, accountId), eq(adDailyMetrics.source, "api"), gte(adDailyMetrics.date, from), lte(adDailyMetrics.date, to)));
      return Number(ex?.n ?? 0);
    },
    async writeChunk(provider, account, from, to, runId, today, payload) {
      let written = 0;
      await db.transaction(async (tx) => {
        // campanhas pelos IDs oficiais (a última ocorrência ganha)
        const byId = new Map<string, CampaignUpsert>();
        for (const c of payload.campaigns) byId.set(c.externalId, c);
        for (const c of byId.values()) {
          await tx.insert(adCampaigns).values({
            provider, accountId: account.id, externalId: c.externalId, name: c.name, status: c.status ?? null,
            channelType: c.channelType ?? null, budgetMicros: c.budgetMicros ?? null, lastSeenAt: nowMysql(),
          }).onDuplicateKeyUpdate({ set: {
            name: c.name,
            status: c.status === undefined ? sql`status` : c.status,
            channelType: c.channelType === undefined ? sql`channelType` : c.channelType,
            budgetMicros: c.budgetMicros === undefined ? sql`budgetMicros` : c.budgetMicros,
            lastSeenAt: nowMysql(),
          } });
        }
        // substitui o intervalo (só origem API) e reinsere
        await tx.delete(adDailyMetrics).where(and(eq(adDailyMetrics.provider, provider), eq(adDailyMetrics.accountId, account.id), eq(adDailyMetrics.source, "api"), gte(adDailyMetrics.date, from), lte(adDailyMetrics.date, to)));
        const values = payload.daily.map((r) => ({
          provider, accountId: account.id, campaignExternalId: r.campaignExternalId, date: r.date,
          costMicros: r.costMicros, currency: account.currency, impressions: r.impressions, clicks: r.clicks,
          conversions: r.conversions.toFixed(4), conversionValueMicros: r.conversionValueMicros, allConversions: r.allConversions.toFixed(4),
          source: "api" as const, isProvisional: isProvisional(r.date, today) ? 1 : 0, syncRunId: runId, collectedAt: nowMysql(),
        }));
        for (let i = 0; i < values.length; i += 500) {
          await tx.insert(adDailyMetrics).values(values.slice(i, i + 500)).onDuplicateKeyUpdate({ set: { costMicros: sql`VALUES(costMicros)`, impressions: sql`VALUES(impressions)`, clicks: sql`VALUES(clicks)`, conversions: sql`VALUES(conversions)`, conversionValueMicros: sql`VALUES(conversionValueMicros)`, allConversions: sql`VALUES(allConversions)`, isProvisional: sql`VALUES(isProvisional)`, syncRunId: runId, collectedAt: nowMysql() } });
        }
        written += values.length;
        if (payload.actions) {
          await tx.delete(adConversionActionMetrics).where(and(eq(adConversionActionMetrics.provider, provider), eq(adConversionActionMetrics.accountId, account.id), gte(adConversionActionMetrics.date, from), lte(adConversionActionMetrics.date, to)));
          const av = payload.actions.map((a) => ({
            provider, accountId: account.id, campaignExternalId: a.campaignExternalId, date: a.date, actionResource: a.actionResource,
            actionName: a.actionName, category: a.category, conversions: a.conversions.toFixed(4), valueMicros: a.valueMicros, syncRunId: runId, collectedAt: nowMysql(),
          }));
          for (let i = 0; i < av.length; i += 500) await tx.insert(adConversionActionMetrics).values(av.slice(i, i + 500)).onDuplicateKeyUpdate({ set: { conversions: sql`VALUES(conversions)`, valueMicros: sql`VALUES(valueMicros)`, syncRunId: runId } });
        }
      });
      return written;
    },
    async listSelectedAccounts(provider) {
      const rows = await db.select().from(adAccounts).where(and(eq(adAccounts.provider, provider), eq(adAccounts.selected, 1)));
      return rows.map((a) => ({ id: a.id, customerId: a.customerId, currency: a.currency, loginCustomerId: a.loginCustomerId, isManager: a.isManager }));
    },
    async upsertAccount(provider, row, known) {
      await db.insert(adAccounts).values({
        provider, customerId: row.customerId, name: row.name, currency: row.currency, timezone: row.timezone, isManager: 0, status: row.status, selected: 1,
      }).onDuplicateKeyUpdate({ set: known ? { name: row.name, currency: row.currency, timezone: row.timezone, status: row.status } : { status: sql`status` } });
    },
    async saveConnection(provider, patch) {
      const rows = await db.select({ id: integrationConnections.id }).from(integrationConnections).where(eq(integrationConnections.provider, provider)).limit(1);
      if (rows[0]) await db.update(integrationConnections).set(patch).where(eq(integrationConnections.id, rows[0].id));
      else await db.insert(integrationConnections).values({ provider, status: "connected", ...patch });
    },
  };
}
