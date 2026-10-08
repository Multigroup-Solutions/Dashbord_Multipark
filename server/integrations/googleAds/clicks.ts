/**
 * Cliques do Google Ads (click_view) → google_ads_clicks (Jorge, 8 out 2026:
 * "no Marketing as campanhas dão 0 reservas ligadas").
 *
 * Com o auto-tagging, o link da reserva só traz o `gclid` — sem o ID da
 * campanha não havia ligação. O relatório click_view da Google diz de que
 * campanha é cada clique (gclid → campanha, grupo de anúncios, dia). Aqui
 * lê-se esse relatório e guarda-se numa tabela nossa de apoio; a ligação
 * reserva → campanha está em ./clickAttribution.ts.
 *
 *  - SÓ LEITURA na Google (searchStream). Na nossa BD só INSERT … ON
 *    DUPLICATE KEY UPDATE — nada se apaga (não há purga: lê-se só o que
 *    interessa, por gclid).
 *  - A Google só aceita UM dia por consulta e só os últimos 90 dias.
 *  - Cada volta (de hora a hora, no agendador): HOJE e ONTEM de todas as
 *    contas (hoje ainda cresce; ontem acabou de fechar) e depois, aos poucos,
 *    os dias em falta da janela de 90 dias, do mais recente para trás, à vez
 *    por conta, no máximo CLICK_BACKFILL_DAYS_PER_RUN por conta. O que não
 *    couber no prazo fica para a volta seguinte.
 *  - Um dia lido (mesmo com 0 cliques) fica em google_ads_click_days — é o
 *    que dá os "dias em falta" no ecrã.
 *  - Interruptor GOOGLE_ADS_CLICK_SYNC (Definições → Automações), LIGADO por
 *    omissão: só lê da Google e escreve numa tabela de apoio nossa.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { adAccounts } from "../../../drizzle/schema";
import { lisbonToday } from "../../../shared/expensePeriods";
import { addDays } from "./metrics";
import { fetchClickView, setGoogleAdsApiDeadline } from "./client";
import type { ClickViewRow } from "./gaql";

export const CLICK_SYNC_FLAG = "GOOGLE_ADS_CLICK_SYNC";
/** O click_view só existe para os últimos 90 dias (hoje incluído). */
export const CLICK_VIEW_DAYS = 90;
/** Dias em falta lidos por conta em cada volta (o resto fica para a seguinte). */
export const CLICK_BACKFILL_DAYS_PER_RUN = 10;
/** Linhas por INSERT. */
const INSERT_CHUNK = 500;

const rowsOf = <T = any>(r: any): T[] => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as T[];

// ─── Regras puras ───────────────────────────────────────────────────────────

/** Janela que a Google aceita: hoje e os 89 dias antes. PURA. */
export function clickWindow(today: string, days = CLICK_VIEW_DAYS): { from: string; to: string } {
  return { from: addDays(today, -(days - 1)), to: today };
}

/** Dias da janela ainda por ler, de ONTEM para trás (hoje nunca está "completo"). PURA. */
export function missingClickDays(today: string, done: ReadonlySet<string>, days = CLICK_VIEW_DAYS): string[] {
  const { from } = clickWindow(today, days);
  const out: string[] = [];
  for (let d = addDays(today, -1); d >= from; d = addDays(d, -1)) if (!done.has(d)) out.push(d);
  return out;
}

export interface ClickAccount { customerId: string; loginCustomerId?: string | null }
export interface ClickTask { customerId: string; loginCustomerId: string | null; day: string; kind: "recent" | "backfill" }

/**
 * Plano de uma volta. PURA:
 *  1. hoje e ontem de TODAS as contas;
 *  2. os dias em falta antes de ontem, do mais recente para trás, à vez por
 *     conta (o 1.º em falta de cada conta, depois o 2.º…), no máximo
 *     `maxBackfill` por conta.
 */
export function planClickTasks(o: {
  today: string;
  accounts: ReadonlyArray<ClickAccount>;
  doneDays: ReadonlyMap<string, ReadonlySet<string>>;
  maxBackfill?: number;
  windowDays?: number;
}): ClickTask[] {
  const max = Math.max(0, o.maxBackfill ?? CLICK_BACKFILL_DAYS_PER_RUN);
  const yesterday = addDays(o.today, -1);
  const tasks: ClickTask[] = [];
  for (const day of [o.today, yesterday]) {
    for (const a of o.accounts) tasks.push({ customerId: a.customerId, loginCustomerId: a.loginCustomerId ?? null, day, kind: "recent" });
  }
  const missing = o.accounts.map((a) => missingClickDays(o.today, o.doneDays.get(a.customerId) ?? new Set(), o.windowDays).filter((d) => d !== yesterday).slice(0, max));
  for (let i = 0; i < max; i++) {
    o.accounts.forEach((a, k) => {
      const day = missing[k][i];
      if (day) tasks.push({ customerId: a.customerId, loginCustomerId: a.loginCustomerId ?? null, day, kind: "backfill" });
    });
  }
  return tasks;
}

export interface ClickDaysSummary {
  /** dia mais recente já lido (de qualquer conta) */
  lastDay: string | null;
  /** dias da janela (até ontem) que faltam a pelo menos uma conta */
  missingDays: number;
  /** o dia em falta mais antigo */
  oldestMissing: string | null;
  windowFrom: string;
  windowDays: number;
}

/** Resumo para o ecrã: último dia lido e dias em falta (união das contas). PURA. */
export function summarizeClickDays(today: string, customerIds: ReadonlyArray<string>, doneDays: ReadonlyMap<string, ReadonlySet<string>>, days = CLICK_VIEW_DAYS): ClickDaysSummary {
  const { from } = clickWindow(today, days);
  let lastDay: string | null = null;
  const missing = new Set<string>();
  for (const id of customerIds) {
    const done = doneDays.get(id) ?? new Set<string>();
    for (const d of done) if (d >= from && d <= today && (!lastDay || d > lastDay)) lastDay = d;
    for (const d of missingClickDays(today, done, days)) missing.add(d);
  }
  const sorted = [...missing].sort();
  return { lastDay, missingDays: missing.size, oldestMissing: sorted[0] ?? null, windowFrom: from, windowDays: days };
}

/** Cliques de um dia sem gclid repetido (o último ganha). PURA. */
export function dedupeClicks(rows: ReadonlyArray<ClickViewRow>): ClickViewRow[] {
  const m = new Map<string, ClickViewRow>();
  for (const r of rows) m.set(r.gclid, r);
  return [...m.values()];
}

// ─── BD (só INSERT … ON DUPLICATE KEY UPDATE) ────────────────────────────────

export interface ClickStore {
  /** customerId → dias já lidos (AAAA-MM-DD) desde `from`. */
  loadDoneDays(customerIds: ReadonlyArray<string>, from: string): Promise<Map<string, Set<string>>>;
  /** Grava os cliques do dia e marca o dia como lido; devolve quantos cliques. */
  saveDay(customerId: string, day: string, rows: ReadonlyArray<ClickViewRow>): Promise<number>;
}

const nowMysql3 = () => new Date().toISOString().slice(0, 23).replace("T", " ");

export function mysqlClickStore(db: { execute: (q: any) => Promise<unknown> }): ClickStore {
  return {
    async loadDoneDays(customerIds, from) {
      const out = new Map<string, Set<string>>();
      if (!customerIds.length) return out;
      const rows = rowsOf<any>(await db.execute(sql`
        SELECT customerId, DATE_FORMAT(clickDate, '%Y-%m-%d') AS d FROM google_ads_click_days
        WHERE clickDate >= ${from} AND customerId IN (${sql.join(customerIds.map((id) => sql`${id}`), sql`, `)})`));
      for (const r of rows) {
        const set = out.get(String(r.customerId)) ?? new Set<string>();
        set.add(String(r.d)); out.set(String(r.customerId), set);
      }
      return out;
    },
    async saveDay(customerId, day, rows) {
      const clicks = dedupeClicks(rows);
      const at = nowMysql3();
      for (let i = 0; i < clicks.length; i += INSERT_CHUNK) {
        const part = clicks.slice(i, i + INSERT_CHUNK);
        await db.execute(sql`
          INSERT INTO google_ads_clicks (gclid, customerId, campaignId, adGroupId, clickDate, fetchedAt)
          VALUES ${sql.join(part.map((r) => sql`(${r.gclid}, ${customerId}, ${r.campaignId}, ${r.adGroupId}, ${r.date}, ${at})`), sql`, `)}
          ON DUPLICATE KEY UPDATE customerId = VALUES(customerId), campaignId = VALUES(campaignId), adGroupId = VALUES(adGroupId),
            clickDate = VALUES(clickDate), fetchedAt = VALUES(fetchedAt)`);
      }
      await db.execute(sql`
        INSERT INTO google_ads_click_days (customerId, clickDate, clicks, fetchedAt) VALUES (${customerId}, ${day}, ${clicks.length}, ${at})
        ON DUPLICATE KEY UPDATE clicks = VALUES(clicks), fetchedAt = VALUES(fetchedAt)`);
      return clicks.length;
    },
  };
}

// ─── Recolha ────────────────────────────────────────────────────────────────

export interface ClickSyncResult {
  ok: boolean;
  /** false = o prazo cortou a volta (o resto fica para a seguinte) */
  done: boolean;
  status: "done" | "partial" | "failed" | "skipped";
  skipped?: string;
  reason?: string;
  accounts: number;
  daysPlanned: number;
  daysRead: number;
  clicksWritten: number;
  /** dias da janela ainda em falta depois desta volta (união das contas) */
  missingDays?: number;
  warnings: string[];
}

export interface ClickSyncDeps {
  flagOn(): Promise<boolean>;
  /** Configuração e ligação: null = pode correr; senão salta, com o motivo. */
  precheck(): Promise<{ skipped: string; reason: string } | null>;
  loadAccounts(): Promise<ClickAccount[]>;
  store(): Promise<ClickStore | null>;
  fetchDay(customerId: string, day: string, loginCustomerId: string | null): Promise<ClickViewRow[]>;
  setDeadline(at: number | null | undefined): void;
  today(): string;
}

const realDeps: ClickSyncDeps = {
  async flagOn() {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("../../_core/featureFlags"), import("../../../shared/appSettings")]);
    await ensureFeatureFlagOverrides().catch(() => undefined);
    return isFeatureEnabled(CLICK_SYNC_FLAG, { defaultEnabled: automationFlagDefault(CLICK_SYNC_FLAG) });
  },
  async precheck() {
    const { missingApiEnvs } = await import("./config");
    const missing = missingApiEnvs();
    if (missing.length) return { skipped: "not_configured", reason: `envs em falta: ${missing.join(", ")}` };
    const { getConnection } = await import("./oauth");
    const conn = await getConnection();
    if (!conn || conn.status === "disconnected" || !conn.refreshTokenEnc) return { skipped: "not_connected", reason: "Google Ads não está ligado" };
    // A recolha do gasto já fica vermelha com isto; aqui só salta (com o motivo à vista).
    if (conn.status === "reauth_required") return { skipped: "reauth_required", reason: "Reautorização necessária: volta a ligar o Google Ads em Integrações" };
    return null;
  },
  async loadAccounts() {
    const db = await getDb();
    if (!db) return [];
    const { GOOGLE_ADS_PROVIDER, readGoogleAdsConfig } = await import("./config");
    const cfg = readGoogleAdsConfig();
    const rows = await db.select({ customerId: adAccounts.customerId, loginCustomerId: adAccounts.loginCustomerId }).from(adAccounts)
      .where(and(eq(adAccounts.provider, GOOGLE_ADS_PROVIDER), eq(adAccounts.selected, 1), eq(adAccounts.isManager, 0)));
    return rows.map((a) => ({ customerId: a.customerId, loginCustomerId: a.loginCustomerId ?? cfg.loginCustomerId ?? null }));
  },
  async store() {
    const db = await getDb();
    return db ? mysqlClickStore(db as any) : null;
  },
  fetchDay: (customerId, day, login) => fetchClickView(customerId, day, login),
  setDeadline: (at) => setGoogleAdsApiDeadline(at),
  today: () => lisbonToday(),
};

const errText = (err: unknown) => String((err as any)?.message ?? err).slice(0, 160);

/**
 * Uma volta da leitura dos cliques. O que corre mal num dia ou numa conta
 * fica em `warnings` e a volta segue; o estado diz o resto —
 *  - interruptor desligado / sem configuração / sem ligação → skipped (ok);
 *  - token recusado pela Google → failed (pára tudo);
 *  - sem acesso a uma conta (401/403) → essa conta pára, as outras seguem;
 *  - nenhum dia lido e houve erros → failed; prazo a meio → partial.
 */
export async function runGoogleAdsClickSync(opts: { deadlineAt?: number; maxBackfill?: number } = {}, deps: ClickSyncDeps = realDeps): Promise<ClickSyncResult> {
  const base: ClickSyncResult = { ok: true, done: true, status: "skipped", accounts: 0, daysPlanned: 0, daysRead: 0, clicksWritten: 0, warnings: [] };
  if (!(await deps.flagOn())) return { ...base, skipped: `${CLICK_SYNC_FLAG} desligado`, reason: "Interruptor desligado (Definições → Automações)" };
  const pre = await deps.precheck();
  if (pre) return { ...base, skipped: pre.skipped, reason: pre.reason };
  const store = await deps.store();
  if (!store) return { ...base, ok: false, status: "failed", reason: "DB indisponível" };
  const accounts = await deps.loadAccounts();
  if (!accounts.length) return { ...base, skipped: "no_accounts", reason: "sem contas Google Ads selecionadas" };

  const today = deps.today();
  const { from } = clickWindow(today);
  const ids = accounts.map((a) => a.customerId);
  const doneDays = await store.loadDoneDays(ids, from);
  const tasks = planClickTasks({ today, accounts, doneDays, maxBackfill: opts.maxBackfill });
  const r: ClickSyncResult = { ...base, status: "done", accounts: accounts.length, daysPlanned: tasks.length };
  const stopped = new Set<string>();
  let cut = false, failures = 0, authError: string | null = null;
  deps.setDeadline(opts.deadlineAt);
  try {
    for (const t of tasks) {
      if (stopped.has(t.customerId)) continue;
      if (opts.deadlineAt != null && opts.deadlineAt - Date.now() < 3_000) { cut = true; break; }
      try {
        const rows = await deps.fetchDay(t.customerId, t.day, t.loginCustomerId);
        r.clicksWritten += await store.saveDay(t.customerId, t.day, rows);
        r.daysRead++;
        const set = doneDays.get(t.customerId) ?? new Set<string>();
        set.add(t.day); doneDays.set(t.customerId, set);
      } catch (err: any) {
        if (err?.deadline) { cut = true; break; }
        if (err?.oauthError) { authError = errText(err); break; }
        failures++;
        const status = Number(err?.status ?? 0);
        if (status === 401 || status === 403) {
          stopped.add(t.customerId);
          r.warnings.push(`${t.customerId}: sem acesso aos cliques (${errText(err)})`);
        } else {
          r.warnings.push(`${t.customerId} ${t.day}: ${errText(err)}`);
        }
      }
    }
  } finally {
    deps.setDeadline(null);
  }
  r.missingDays = summarizeClickDays(today, ids, doneDays).missingDays;
  if (authError) return { ...r, ok: false, done: true, status: "failed", reason: `Token recusado pela Google: ${authError}` };
  if (r.daysRead === 0 && failures > 0) return { ...r, ok: false, done: true, status: "failed", reason: r.warnings[0] ?? "nenhum dia lido" };
  if (cut) return { ...r, done: false, status: "partial", reason: "o prazo acabou; o resto fica para a próxima volta" };
  return r;
}

// ─── Estado para o ecrã (Integrações → Google Ads) ──────────────────────────

export interface ClickSyncStatus extends ClickDaysSummary {
  enabled: boolean;
  accounts: number;
  /** cliques guardados nos dias da janela */
  clicks: number;
  /** última leitura (UTC, "AAAA-MM-DD HH:MM:SS") */
  lastFetchedAt: string | null;
  error?: string;
}

/** Estado da leitura dos cliques; nunca lança (sem a tabela ainda → `error`). */
export async function clickSyncStatus(deps: Pick<ClickSyncDeps, "flagOn" | "loadAccounts" | "today"> = realDeps): Promise<ClickSyncStatus> {
  const today = deps.today();
  const empty = (): ClickSyncStatus => ({ enabled: true, accounts: 0, clicks: 0, lastFetchedAt: null, ...summarizeClickDays(today, [], new Map()) });
  try {
    const [enabled, accounts] = await Promise.all([deps.flagOn(), deps.loadAccounts()]);
    const db = await getDb();
    if (!db) return { ...empty(), enabled, error: "DB indisponível" };
    const ids = accounts.map((a) => a.customerId);
    const { from } = clickWindow(today);
    const doneDays = await mysqlClickStore(db as any).loadDoneDays(ids, from);
    let clicks = 0, lastFetchedAt: string | null = null;
    if (ids.length) {
      const [agg] = rowsOf<any>(await db.execute(sql`
        SELECT COALESCE(SUM(clicks), 0) AS clicks, DATE_FORMAT(MAX(fetchedAt), '%Y-%m-%d %H:%i:%s') AS lastFetchedAt
        FROM google_ads_click_days
        WHERE clickDate >= ${from} AND customerId IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`));
      clicks = Number(agg?.clicks ?? 0);
      lastFetchedAt = agg?.lastFetchedAt ?? null;
    }
    return { enabled, accounts: ids.length, clicks, lastFetchedAt, ...summarizeClickDays(today, ids, doneDays) };
  } catch (err) {
    return { ...empty(), error: errText(err) };
  }
}
