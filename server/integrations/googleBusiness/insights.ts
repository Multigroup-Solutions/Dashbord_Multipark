/**
 * Google Business Profile — recolha do desempenho (cron /api/cron/google-business,
 * depois das críticas; prazo total 50 s, retomável):
 *
 *  - 1×/dia: lista de contas/perfis com o estado (verificação, edições
 *    pendentes, alterado pela Google) — Account Management + Business Information;
 *  - por perfil: métricas diárias (Performance API, 1 pedido traz todas):
 *    1.ª vez ~6 meses em blocos de 90 dias; depois 1×/dia relê os últimos 5
 *    dias (os números acertam com atraso);
 *  - por perfil: pesquisas mensais (meses completos; o mês passado relido na
 *    1.ª semana do mês);
 *  - depois da atualização do dia: alertas (notify, 1×/dia).
 *
 * Cada bloco é gravado de forma idempotente e SÓ DEPOIS o cursor avança.
 * Quota 0 / API por ativar / sem permissão → pára logo (repetir não adianta)
 * e fica o diagnóstico em "gbp:lastError" (mostrado na UI e no Testar).
 */
import {
  GBP_CHUNK_DAYS, GBP_KEYWORD_MAX_PAGES, GBP_LAG_DAYS, GBP_REFETCH_DAYS, evaluateGbpAlerts, gbpImpressions, keywordMonthsDue, parseKeywords,
  parsePerformance, resolveLocationMapping, type GbpAlert, type GbpConfig, type GbpKeywordRow,
} from "../../../shared/googleBusinessProfile";
import { applySyncWindow, nextSyncWindow, parseCursor } from "../../../shared/webAnalytics";
import { addDays, lisbonDayOf, lisbonHoursSince } from "../../../shared/lisbonDay";
import { NOTIFY_CITY_LABELS, notifyCityOf } from "../../../shared/notificationRouting";
import { GbpApiError } from "./diagnostics";
import { safeError } from "./domain";
import type { GbpLocationRow, GbpStore } from "./insightsStore";

export interface GbpApiLike {
  performance(location: string, from: string, to: string): Promise<any>;
  keywords(location: string, month: string, pageToken: string): Promise<any>;
}
export interface GbpCoreDeps {
  api: GbpApiLike;
  store: GbpStore;
  /** Relista contas/perfis (estado do perfil) — 1×/dia. */
  refreshMeta?: (deadlineAt: number) => Promise<unknown>;
  now?: () => number;
}
export interface GbpSyncReport {
  ok: boolean; done: boolean; configured: boolean; busy?: boolean; skipped?: string;
  windows: number; keywordMonths: number; locations: number;
  /** Diagnóstico de um erro de configuração (quota 0, API por ativar, permissões). */
  blocked: string | null;
  errors: string[]; warnings: string[];
  alerts?: number | null;
}

/** Tempo mínimo que tem de sobrar para começar um pedido (10 s de prazo + folga). */
export const GBP_MIN_MS_PER_REQUEST = 12_000;
export const gbpPerfKey = (locationId: number) => `gbp:perf:${locationId}`;
export const gbpKwKey = (locationId: number) => `gbp:kw:${locationId}`;

function refreshDueAt(nowMs: number, hour: number): boolean {
  return Math.floor(lisbonHoursSince(lisbonDayOf(nowMs), nowMs)) >= hour;
}

function parseFetched(raw: string | null): Record<string, string> {
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([k, d]) => /^\d{4}-\d{2}$/.test(k) && typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))) as Record<string, string>;
  } catch { return {}; }
}

/** Perfis a recolher: disponíveis e ativos na associação das Definições. PURA. */
export function locationsToSync(rows: readonly GbpLocationRow[], cfg: GbpConfig): GbpLocationRow[] {
  return rows.filter((l) => l.available && resolveLocationMapping({ locationName: l.locationName, title: l.title, address: l.address }, cfg.locationMap).active);
}

/** Núcleo (API e BD injetáveis — os testes usam falsos). */
export async function runGbpInsightsCore(cfg: GbpConfig, deps: GbpCoreDeps, o: { deadlineAt: number }): Promise<GbpSyncReport> {
  const now = deps.now ?? Date.now;
  const remaining = () => o.deadlineAt - now();
  const nowMs = now();
  const today = lisbonDayOf(nowMs);
  const refreshDue = refreshDueAt(nowMs, cfg.refreshHour);
  const store = deps.store;
  const report: GbpSyncReport = { ok: true, done: true, configured: true, windows: 0, keywordMonths: 0, locations: 0, blocked: null, errors: [], warnings: [] };
  const block = (err: unknown) => { report.blocked = err instanceof Error ? err.message : safeError(err); };
  const isConfig = (err: unknown) => err instanceof GbpApiError && err.isConfigError;

  // 1) Estado dos perfis (1×/dia).
  if (deps.refreshMeta && (await store.getState("gbp:meta:day")) !== today && remaining() > GBP_MIN_MS_PER_REQUEST * 2) {
    try {
      await deps.refreshMeta(o.deadlineAt);
      await store.setState("gbp:meta:day", today);
    } catch (err) {
      if (isConfig(err)) block(err);
      else report.warnings.push(`Lista de perfis: ${safeError(err).slice(0, 200)}`);
    }
  }

  const locations = locationsToSync(await store.locations(), cfg);
  report.locations = locations.length;

  // 2) Métricas diárias.
  outer: for (const loc of report.blocked ? [] : locations) {
    let cursor = parseCursor(await store.getState(gbpPerfKey(loc.id)));
    const opts = { today, lagDays: GBP_LAG_DAYS, backfillDays: cfg.backfillDays, chunkDays: GBP_CHUNK_DAYS, refetchDays: GBP_REFETCH_DAYS, refreshDue };
    for (;;) {
      const w = nextSyncWindow(cursor, opts);
      if (!w) break;
      if (remaining() < GBP_MIN_MS_PER_REQUEST) { report.done = false; break outer; }
      try {
        const rows = parsePerformance(await deps.api.performance(loc.locationName, w.from, w.to), w.from, w.to);
        await store.upsertDaily(loc.id, rows);
      } catch (err) {
        if (isConfig(err)) { block(err); break outer; }
        if (err instanceof GbpApiError && err.status === 404) { report.warnings.push(`${loc.title}: perfil não encontrado na Performance API (removido ou sem acesso).`); break; }
        if (err instanceof GbpApiError && err.status === 429) { report.done = false; report.warnings.push("Limite de pedidos da Performance API — continua na próxima corrida."); break outer; }
        report.errors.push(`${loc.title} (desempenho): ${safeError(err).slice(0, 200)}`);
        break;
      }
      cursor = applySyncWindow(cursor, w, today);
      await store.setState(gbpPerfKey(loc.id), JSON.stringify(cursor));
      report.windows++;
    }
  }

  // 3) Pesquisas mensais.
  if (cfg.keywords && !report.blocked) {
    outerKw: for (const loc of locations) {
      const fetched = parseFetched(await store.getState(gbpKwKey(loc.id)));
      for (const month of keywordMonthsDue(fetched, today, cfg.backfillDays)) {
        if (remaining() < GBP_MIN_MS_PER_REQUEST) { report.done = false; break outerKw; }
        try {
          const rows: GbpKeywordRow[] = [];
          let token = "";
          const seen = new Set<string>();
          for (let page = 0; page < GBP_KEYWORD_MAX_PAGES; page++) {
            if (seen.has(token)) break;
            seen.add(token);
            const r = parseKeywords(await deps.api.keywords(loc.locationName, month, token));
            rows.push(...r.rows);
            token = r.nextPageToken ?? "";
            if (!token || remaining() < GBP_MIN_MS_PER_REQUEST) break;
          }
          await store.replaceKeywords(loc.id, month, rows);
          fetched[month] = today;
          await store.setState(gbpKwKey(loc.id), JSON.stringify(fetched));
          report.keywordMonths++;
        } catch (err) {
          if (isConfig(err)) { block(err); break outerKw; }
          if (err instanceof GbpApiError && err.status === 429) { report.done = false; break outerKw; }
          report.warnings.push(`${loc.title} (pesquisas ${month}): ${safeError(err).slice(0, 160)}`);
          break;
        }
      }
    }
  }

  if (report.blocked) report.done = true; // repetir não adianta até alguém corrigir
  report.ok = report.errors.length === 0 && !report.blocked;
  await store.setState("gbp:lastError", report.blocked ?? report.errors[0] ?? null).catch(() => {});
  return report;
}

/** Todos os perfis já releram hoje (ou estão em dia)? */
export async function allPerfRefreshedToday(locations: readonly GbpLocationRow[], store: GbpStore, today: string): Promise<boolean> {
  for (const l of locations) {
    const c = parseCursor(await store.getState(gbpPerfKey(l.id)));
    if (c.refreshedOn !== today) return false;
  }
  return true;
}

// ─── Alertas (1×/dia, depois da atualização) ────────────────────────────────

export async function buildGbpAlertInputs(cfg: GbpConfig, today: string) {
  const { resolvedLocations, gbpDailyByLocation, reviewsLite, unansweredByLocation } = await import("./insightsQueries");
  const locs = (await resolvedLocations(cfg)).filter((l) => l.active && l.available);
  const ids = locs.map((l) => l.id);
  const weekEnd = addDays(today, -GBP_LAG_DAYS);
  const curFrom = addDays(weekEnd, -6), prevTo = addDays(curFrom, -1), prevFrom = addDays(prevTo, -6);
  const daily = await gbpDailyByLocation(ids, prevFrom, weekEnd);
  const reviews = await reviewsLite(locs, addDays(today, -97), today);
  const unanswered = await unansweredByLocation(ids);
  const recentFrom = `${addDays(today, -7)} 00:00:00`;
  return {
    today, weekEnd, thresholds: cfg.alerts,
    locations: locs.map((l) => {
      const mine = daily.filter((d) => d.locationId === l.id);
      const sum = (a: string, b: string) => {
        const rows = mine.filter((d) => d.day >= a && d.day <= b);
        return { impressions: rows.reduce((t, r) => t + gbpImpressions(r.values), 0), calls: rows.reduce((t, r) => t + r.values.callClicks, 0), days: rows.length };
      };
      const rv = reviews.filter((r) => r.locationId === l.id || (r.locationId == null && l.projectId != null && r.projectId === l.projectId));
      const recent = rv.filter((r) => (r.reviewDate ?? "") >= recentFrom);
      const base = rv.filter((r) => (r.reviewDate ?? "") < recentFrom);
      const avg = (xs: typeof rv) => (xs.length ? xs.reduce((t, r) => t + r.rating, 0) / xs.length : null);
      return {
        id: l.id, label: l.title, city: l.city,
        week: { cur: sum(curFrom, weekEnd), prev: sum(prevFrom, prevTo) },
        ratings: { last7Avg: avg(recent), last7Count: recent.length, baseAvg: avg(base), baseCount: base.length },
        unanswered: unanswered.get(l.id) ?? null,
        status: { openStatus: l.openStatus, hasVoiceOfMerchant: l.hasVoiceOfMerchant, hasGoogleUpdated: l.hasGoogleUpdated, hasPendingEdits: l.hasPendingEdits },
      };
    }),
  };
}

export async function runGbpAlerts(cfg: GbpConfig, today: string, store: GbpStore, o: { force?: boolean } = {}): Promise<number | null> {
  if (!o.force && (await store.getState("gbp:alerts:day")) === today) return null;
  const alerts: GbpAlert[] = evaluateGbpAlerts(await buildGbpAlertInputs(cfg, today));
  if (alerts.length) {
    const { notify } = await import("../../notify");
    for (const a of alerts) {
      const city = a.city ? notifyCityOf(a.city) : null;
      await notify({
        kind: a.channel === "reviews" ? "google_reviews_alert" : "google_business_alert",
        title: a.title,
        body: `${a.detail}${city ? ` (${NOTIFY_CITY_LABELS[city]})` : ""}`,
        link: a.channel === "reviews" ? "/criticas" : "/marketing/web?sec=google-business",
        ...(city ? { city } : {}),
        entity: { type: "gbp_alert", id: a.key },
      });
    }
  }
  await store.setState("gbp:alerts:latest", JSON.stringify({ day: today, alerts }));
  await store.setState("gbp:alerts:day", today);
  return alerts.length;
}

// ─── Corrida completa (cron / "Atualizar agora") ────────────────────────────

export interface GbpLastRun { at: string; ok: boolean; done: boolean; blocked: string | null; errors: string[]; warnings: string[] }

export async function runGbpInsightsSync(o: { deadlineAt: number; now?: () => number }): Promise<GbpSyncReport> {
  const now = o.now ?? Date.now;
  const empty: GbpSyncReport = { ok: true, done: true, configured: false, windows: 0, keywordMonths: 0, locations: 0, blocked: null, errors: [], warnings: [] };
  const { loadGbpConfig } = await import("./insightsQueries");
  const cfg = await loadGbpConfig();
  if (!cfg.enabled) return { ...empty, skipped: "disabled" };
  const { connection, accessToken } = await import("./oauth");
  const conn = await connection();
  if (!conn?.refreshTokenEnc || conn.status === "disconnected") return { ...empty, skipped: "disconnected" };
  if (conn.status === "reauth_required") return { ...empty, skipped: "reauth_required" };
  const { dbGbpStore, acquireGbpLock, releaseGbpLock } = await import("./insightsStore");
  const token = await acquireGbpLock();
  if (!token) return { ...empty, configured: true, busy: true, done: false };
  let report: GbpSyncReport;
  try {
    const { BusinessClient } = await import("./client");
    const { config } = await import("./config");
    const { projectNumberOfClientId } = await import("./diagnostics");
    const { refreshLocations } = await import("./service");
    const client = new BusinessClient(await accessToken(), { deadlineAt: o.deadlineAt, context: { projectNumber: projectNumberOfClientId(config().clientId), accountEmail: conn.accountEmail ?? null } });
    report = await runGbpInsightsCore(cfg, {
      api: { performance: (l, f, t) => client.performance(l, f, t), keywords: (l, m, p) => client.keywords(l, m, p) },
      store: dbGbpStore,
      refreshMeta: (deadlineAt) => refreshLocations(deadlineAt),
      now,
    }, { deadlineAt: o.deadlineAt });
    const nowMs = now();
    const today = lisbonDayOf(nowMs);
    if (!report.blocked && refreshDueAt(nowMs, cfg.refreshHour) && o.deadlineAt - nowMs > 8_000) {
      const locs = locationsToSync(await dbGbpStore.locations(), cfg);
      if (await allPerfRefreshedToday(locs, dbGbpStore, today)) {
        try { report.alerts = await runGbpAlerts(cfg, today, dbGbpStore); } catch (err) { report.warnings.push(`Alertas: ${safeError(err).slice(0, 160)}`); }
      }
    }
    const last: GbpLastRun = { at: new Date(now()).toISOString(), ok: report.ok, done: report.done, blocked: report.blocked, errors: report.errors.slice(0, 10), warnings: report.warnings.slice(0, 10) };
    await dbGbpStore.setState("gbp:lastRun", JSON.stringify(last)).catch(() => {});
    if (report.ok && report.done) await dbGbpStore.setState("gbp:lastSuccessAt", last.at).catch(() => {});
  } catch (err) {
    report = { ...empty, configured: true, ok: false, errors: [safeError(err)] };
    await (await import("./insightsStore")).dbGbpStore.setState("gbp:lastError", safeError(err)).catch(() => {});
  } finally {
    await releaseGbpLock(token).catch(() => {});
  }
  return report;
}
