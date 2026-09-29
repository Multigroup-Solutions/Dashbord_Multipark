/**
 * Web & SEO — recolha diária (trabalho web-analytics do agendador
 * /api/cron/tick: 1×/dia a partir das 09h ou da hora das Definições, a
 * retomar enquanto done:false; prazo por corrida, retomável):
 *
 *  - GA4 (runReport) por propriedade: totais por dia, canal, página de entrada
 *    (top 50/dia), dispositivo, país, cidade e eventos do funil;
 *  - Search Console (searchanalytics.query) por propriedade: totais por dia,
 *    pesquisas e páginas (top 250/dia), dispositivo e país;
 *  - PageSpeed: 1×/semana por página × (móvel, computador).
 *
 * Cada "unidade" (fonte × propriedade × parte) tem o seu cursor em
 * web_analytics_state: 1.ª vez → histórico de `backfillDays` em blocos; depois
 * 1×/dia (a partir da hora definida) relê os últimos dias (dados tardios).
 * Cada bloco é gravado de forma idempotente e SÓ DEPOIS o cursor avança —
 * uma função morta a meio repete o mesmo bloco na corrida seguinte.
 *
 * Depois da atualização do dia: alertas (notify, 1×/dia) e, 1×/semana, o
 * resumo "o que mudou e porquê" (IA lite, só com totais; texto fixo sem IA).
 */
import {
  CRUX_INTERVAL_DAYS, GA_DIMS, GA_MAX_PAGES, GA_PAGE_LIMIT, GA_PARTS, SC_DIMS, SC_MAX_PAGES, SC_PARTS, SC_ROW_LIMIT,
  applySyncWindow, cruxCheckKey, cruxDue, cruxTargets, extractLighthouseAudits, gaDailyRows, gaDimRequest, gaTotalsRequest, mergeGaRows, nextSyncWindow,
  pagespeedDue, parseCruxHistory, parseCursor, parseGaReport, parsePagespeed, parseScRows, scRequest,
  type GaDimKind, type GaPart, type GaRow, type PsStrategy, type ScDimKind, type ScPart, type ScRow, type SyncWindow, type WebAnalyticsConfig,
} from "../../shared/webAnalytics";
import { addDays, lisbonDayOf, lisbonHoursSince } from "../../shared/lisbonDay";
import { googleErrorMessage, httpStatusOf } from "../google/workspace";
import { isRateLimitError } from "../google/apis";
import type { CruxApiLike, GaApiLike, PsiApiLike, ScApiLike } from "./apis";
import { PAGESPEED_TIMEOUT_MS } from "./apis";
import type { WebStore } from "./store";

/** Prazo de cada pedido GA4/Search Console (+ folga) — não começa um sem isto. */
export const MIN_MS_PER_REQUEST = 22_000;
export const GA_LAG_DAYS = 1;
export const GA_REFETCH_DAYS = 3;
export const SC_LAG_DAYS = 2;
export const SC_REFETCH_DAYS = 4;
const GA_CHUNK: Record<GaPart, number> = { totals: 31, channel: 31, landing: 14, device: 31, country: 31, city: 31, event: 31 };

export type UnitStatus = "ok" | "pending" | "no_access" | "rate_limited" | "error";
export interface UnitReport { key: string; windows: number; rows: number; status: UnitStatus; error?: string }

export interface WebSyncReport {
  ok: boolean;
  configured: boolean;
  done: boolean;
  busy?: boolean;
  units: UnitReport[];
  pagespeed: { measured: number; failed: number; pending: number };
  /** Chrome UX Report: consultas feitas / sem dados suficientes / falhadas / por fazer. */
  crux?: { measured: number; noData: number; failed: number; pending: number };
  alerts?: number | null;
  insight?: { created: boolean; ai: boolean } | null;
  errors: string[];
  warnings: string[];
}

export interface CoreDeps {
  ga: GaApiLike | null;
  sc: ScApiLike | null;
  psi: PsiApiLike | null;
  /** Chrome UX Report (null = sem chave ou desligado). */
  crux?: CruxApiLike | null;
  store: WebStore;
  now?: () => number;
}

/** Sem acesso à propriedade (a conta de serviço não foi adicionada)? PURA. */
export function isNoAccessError(err: unknown): boolean {
  const s = httpStatusOf(err);
  if (s === 403 && !isRateLimitError(err)) return true;
  if (s === 404) return true;
  const msg = String((err as any)?.message ?? "");
  return /PERMISSION_DENIED|does not have (sufficient )?permission|User does not have/i.test(msg);
}

export const cursorKey = (unit: string) => `cursor:${unit}`;
export const gaUnitKey = (propertyId: string, part: GaPart) => `ga:${propertyId}:${part}`;
export const scUnitKey = (siteUrl: string, part: ScPart) => `sc:${siteUrl}:${part}`;
export const errorKey = (source: "ga" | "sc", id: string) => `error:${source}:${id}`;

/** A atualização do dia já é devida (hora de Lisboa ≥ hora definida)? PURA. */
export function refreshDueAt(nowMs: number, hour: number): boolean {
  const today = lisbonDayOf(nowMs);
  return Math.floor(lisbonHoursSince(today, nowMs)) >= hour;
}

async function fetchGa(api: GaApiLike, propertyId: string, part: GaPart, w: SyncWindow, cfg: WebAnalyticsConfig, remaining: () => number): Promise<{ daily?: ReturnType<typeof gaDailyRows>; dims?: GaRow[] }> {
  if (part === "totals") {
    const res = parseGaReport(await api.runReport(propertyId, gaTotalsRequest(w.from, w.to)));
    return { daily: gaDailyRows(res.rows, w.from, w.to) };
  }
  const all: GaRow[] = [];
  for (let page = 0; page < GA_MAX_PAGES; page++) {
    const res = parseGaReport(await api.runReport(propertyId, gaDimRequest(part, w.from, w.to, { offset: page * GA_PAGE_LIMIT, funnelEvents: cfg.funnelEvents })));
    all.push(...res.rows);
    // Ordenado por sessões (desc) no período todo: as primeiras páginas têm o top de cada dia.
    if (all.length >= res.rowCount || res.rows.length < GA_PAGE_LIMIT || remaining() < MIN_MS_PER_REQUEST) break;
  }
  return { dims: mergeGaRows(all) };
}

async function fetchSc(api: ScApiLike, siteUrl: string, part: ScPart, w: SyncWindow, remaining: () => number): Promise<ScRow[]> {
  const all: ScRow[] = [];
  for (let page = 0; page < SC_MAX_PAGES; page++) {
    const rows = parseScRows(await api.query(siteUrl, scRequest(part, w.from, w.to, page * SC_ROW_LIMIT)), part);
    all.push(...rows);
    if (rows.length < SC_ROW_LIMIT || remaining() < MIN_MS_PER_REQUEST) break;
  }
  return all;
}

/**
 * Núcleo (APIs e BD injetáveis — os testes usam falsos): PageSpeed devida,
 * depois cada unidade GA4/Search Console até ficar em dia ou acabar o prazo.
 */
export async function runWebAnalyticsCore(cfg: WebAnalyticsConfig, deps: CoreDeps, o: { deadlineAt: number }): Promise<WebSyncReport> {
  const now = deps.now ?? Date.now;
  const remaining = () => o.deadlineAt - now();
  const nowMs = now();
  const today = lisbonDayOf(nowMs);
  const refreshDue = refreshDueAt(nowMs, cfg.refreshHour);
  const report: WebSyncReport = { ok: true, configured: true, done: true, units: [], pagespeed: { measured: 0, failed: 0, pending: 0 }, errors: [], warnings: [] };
  const store = deps.store;

  // ── PageSpeed (1×/semana por página × estratégia; lenta → no início, com prazo) ──
  if (cfg.pagespeedEnabled && deps.psi && cfg.pagespeedUrls.length) {
    const latest = await store.latestPagespeed();
    const attemptedKey = `psi:attempted:${today}`;
    const attempted = new Set(String((await store.getState(attemptedKey)) ?? "").split("\n").filter(Boolean));
    const due = pagespeedDue(cfg.pagespeedUrls.map((u) => u.url), latest, today).filter((x) => !attempted.has(`${x.url} ${x.strategy}`));
    const batch: Array<{ url: string; strategy: PsStrategy }> = remaining() >= PAGESPEED_TIMEOUT_MS + 3_000 ? due.slice(0, 2) : [];
    if (batch.length) {
      for (const b of batch) attempted.add(`${b.url} ${b.strategy}`);
      await store.setState(attemptedKey, Array.from(attempted).join("\n"));
      const timeoutMs = Math.min(PAGESPEED_TIMEOUT_MS, remaining() - 3_000);
      const results = await Promise.allSettled(batch.map((b) => deps.psi!.run(b.url, b.strategy, timeoutMs)));
      for (let i = 0; i < batch.length; i++) {
        const r = results[i], b = batch[i];
        if (r.status === "fulfilled") {
          await store.savePagespeed({ url: b.url, strategy: b.strategy, runDay: today, result: parsePagespeed(r.value), error: null });
          // "O que corrigir primeiro" (0170) — nunca parte a medição.
          if (store.savePagespeedAudits) await store.savePagespeedAudits(b.url, b.strategy, today, extractLighthouseAudits(r.value)).catch(() => {});
          report.pagespeed.measured++;
        } else {
          report.pagespeed.failed++;
          report.warnings.push(`PageSpeed ${b.strategy === "mobile" ? "móvel" : "computador"} ${b.url}: ${googleErrorMessage(r.reason).slice(0, 160)} (volta a tentar amanhã).`);
        }
      }
    }
    report.pagespeed.pending = Math.max(0, due.length - batch.length);
    if (report.pagespeed.pending > 0) report.done = false;
  }

  // ── Chrome UX Report (dados reais, 1×/semana por origem/página × dispositivo; pedidos rápidos) ──
  if (cfg.pagespeedEnabled && cfg.cruxEnabled && deps.crux && store.saveCrux && cfg.pagespeedUrls.length) {
    const crux = { measured: 0, noData: 0, failed: 0, pending: 0 };
    report.crux = crux;
    const raw = await store.getState("crux:checked");
    let checked: Record<string, string> = {};
    try { checked = raw ? JSON.parse(raw) : {}; } catch { checked = {}; }
    const due = cruxDue(cruxTargets(cfg.pagespeedUrls), new Map(Object.entries(checked)), today);
    let done = 0, stop = false;
    for (const d of due.slice(0, 16)) {
      if (remaining() < 10_000) break;
      const key = cruxCheckKey(d.target, d.formFactor);
      done++;
      try {
        const res = await deps.crux.history(d.target, d.formFactor, Math.min(12_000, remaining() - 5_000));
        const rows = res ? parseCruxHistory(res) : [];
        if (rows.length) { await store.saveCrux(d.target, d.formFactor, rows); crux.measured++; } else crux.noData++;
        checked[key] = today;
      } catch (err) {
        crux.failed++;
        // Não insiste hoje (volta a tentar amanhã).
        checked[key] = addDays(today, -(CRUX_INTERVAL_DAYS - 1));
        if (report.warnings.length < 20) report.warnings.push(`CrUX ${d.formFactor === "PHONE" ? "telemóvel" : "computador"} ${d.target}: ${googleErrorMessage(err).slice(0, 160)}`);
        // Limite de pedidos ou erro de configuração (API/chave): o resto falharia igual.
        if (isRateLimitError(err) || /não está ativa|inválida|restrita/.test(String((err as any)?.message ?? ""))) { stop = true; break; }
      }
    }
    await store.setState("crux:checked", JSON.stringify(checked));
    crux.pending = stop ? 0 : Math.max(0, due.length - done);
    if (crux.pending > 0) report.done = false;
  }

  // ── GA4 e Search Console ──
  type Unit = { source: "ga" | "sc"; id: string; part: GaPart | ScPart; key: string; chunk: number; lag: number; refetch: number };
  const units: Unit[] = [];
  if (deps.ga) {
    for (const p of cfg.ga4Properties.filter((x) => x.active)) {
      for (const part of GA_PARTS) {
        if (part === "event" && !cfg.funnelEvents.length) continue;
        units.push({ source: "ga", id: p.propertyId, part, key: gaUnitKey(p.propertyId, part), chunk: GA_CHUNK[part], lag: GA_LAG_DAYS, refetch: GA_REFETCH_DAYS });
      }
    }
  }
  if (deps.sc) {
    for (const s of cfg.searchConsoleSites.filter((x) => x.active)) {
      for (const part of SC_PARTS) {
        units.push({ source: "sc", id: s.siteUrl, part, key: scUnitKey(s.siteUrl, part), chunk: part === "totals" ? 31 : SC_DIMS[part as ScDimKind].chunkDays, lag: SC_LAG_DAYS, refetch: SC_REFETCH_DAYS });
      }
    }
  }
  const blocked = new Set<string>(); // fonte:id sem acesso/erro nesta corrida
  const rateLimited = new Set<"ga" | "sc">();
  const okSources = new Set<string>();
  for (const u of units) {
    const ur: UnitReport = { key: u.key, windows: 0, rows: 0, status: "ok" };
    report.units.push(ur);
    const srcKey = `${u.source}:${u.id}`;
    // Sem acesso/erro noutra parte da mesma propriedade: não insiste nesta corrida
    // (já ficou o aviso; "done" não fica falso por isso — o workflow não repete à toa).
    if (blocked.has(srcKey)) { ur.status = "error"; ur.error = "ignorada (erro noutra parte desta propriedade)"; continue; }
    if (rateLimited.has(u.source)) { ur.status = "rate_limited"; report.done = false; continue; }
    let cursor = parseCursor(await store.getState(cursorKey(u.key)));
    const opts = { today, lagDays: u.lag, backfillDays: cfg.backfillDays, chunkDays: u.chunk, refetchDays: u.refetch, refreshDue };
    for (;;) {
      const w = nextSyncWindow(cursor, opts);
      if (!w) break;
      if (remaining() < MIN_MS_PER_REQUEST) { ur.status = "pending"; report.done = false; break; }
      try {
        if (u.source === "ga") {
          const r = await fetchGa(deps.ga!, u.id, u.part as GaPart, w, cfg, remaining);
          if (r.daily) { await store.upsertGaDaily(u.id, r.daily); ur.rows += r.daily.length; }
          if (r.dims) { await store.replaceGaDims(u.id, u.part as GaDimKind, w.from, w.to, r.dims); ur.rows += r.dims.length; }
        } else {
          const rows = await fetchSc(deps.sc!, u.id, u.part as ScPart, w, remaining);
          if (u.part === "totals") await store.upsertScDaily(u.id, rows);
          else await store.replaceScDims(u.id, u.part as ScDimKind, w.from, w.to, rows);
          ur.rows += rows.length;
        }
      } catch (err) {
        if (isRateLimitError(err) || (err as any)?.rateLimited) {
          ur.status = "rate_limited"; rateLimited.add(u.source); report.done = false;
        } else if (isNoAccessError(err)) {
          ur.status = "no_access"; ur.error = googleErrorMessage(err); blocked.add(srcKey);
          const what = u.source === "ga" ? `GA4 ${u.id}` : `Search Console ${u.id}`;
          report.warnings.push(`${what}: sem acesso — adiciona a conta de serviço como utilizador (${ur.error.slice(0, 120)}).`);
          await store.setState(errorKey(u.source, u.id), `Sem acesso: ${ur.error}`.slice(0, 500));
        } else {
          ur.status = "error"; ur.error = googleErrorMessage(err); blocked.add(srcKey);
          report.errors.push(`${u.source === "ga" ? "GA4" : "Search Console"} ${u.id} (${u.part}): ${ur.error.slice(0, 160)}`);
          await store.setState(errorKey(u.source, u.id), ur.error.slice(0, 500));
        }
        break;
      }
      cursor = applySyncWindow(cursor, w, today);
      await store.setState(cursorKey(u.key), JSON.stringify(cursor));
      ur.windows++;
    }
    if (ur.status === "ok") okSources.add(srcKey);
  }
  // Propriedades que correram sem erro ficam limpas.
  for (const src of okSources) {
    if (blocked.has(src)) continue;
    const [source, ...rest] = src.split(":");
    await store.setState(errorKey(source as "ga" | "sc", rest.join(":")), null);
  }
  report.ok = report.errors.length === 0;
  return report;
}

/** Todas as unidades já fizeram a atualização de hoje (ou estão em dia)? */
export async function allRefreshedToday(cfg: WebAnalyticsConfig, store: WebStore, today: string): Promise<boolean> {
  const keys: string[] = [];
  for (const p of cfg.ga4Properties.filter((x) => x.active)) keys.push(gaUnitKey(p.propertyId, "totals"));
  for (const s of cfg.searchConsoleSites.filter((x) => x.active)) keys.push(scUnitKey(s.siteUrl, "totals"));
  for (const k of keys) {
    const c = parseCursor(await store.getState(cursorKey(k)));
    if (c.refreshedOn !== today) return false;
  }
  return true;
}

// ─── Corrida completa (cron / "Atualizar agora") ────────────────────────────

export interface LastRunInfo { at: string; ok: boolean; done: boolean; errors: string[]; warnings: string[] }

export async function runWebAnalyticsSync(o: { deadlineAt: number; now?: () => number }): Promise<WebSyncReport> {
  const now = o.now ?? Date.now;
  const empty: WebSyncReport = { ok: true, configured: false, done: true, units: [], pagespeed: { measured: 0, failed: 0, pending: 0 }, errors: [], warnings: [] };
  const { loadWebAnalyticsConfig } = await import("./service");
  const cfg = await loadWebAnalyticsConfig();
  const hasGa = cfg.ga4Properties.some((p) => p.active);
  const hasSc = cfg.searchConsoleSites.some((s) => s.active);
  const hasPs = cfg.pagespeedEnabled && cfg.pagespeedUrls.length > 0;
  if (!cfg.enabled || (!hasGa && !hasSc && !hasPs)) return empty;
  const { dbWebStore, acquireWebLock, releaseWebLock } = await import("./store");
  const token = await acquireWebLock();
  if (!token) return { ...empty, configured: true, busy: true, warnings: ["Já há uma recolha Web & SEO a correr."] };
  let report: WebSyncReport;
  try {
    const { dwdConfigured } = await import("../google/workspace");
    const errors: string[] = [];
    let ga: GaApiLike | null = null, sc: ScApiLike | null = null;
    if (hasGa || hasSc) {
      if (!dwdConfigured()) errors.push("Conta de serviço Google em falta no servidor (GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON ou GOOGLE_SERVICE_ACCOUNT_JSON).");
      else {
        const { webAuth, gaApi, scApi } = await import("./apis");
        const auth = webAuth(cfg.impersonateEmail || null);
        const retry = { deadlineAt: o.deadlineAt, now };
        if (hasGa) ga = gaApi(auth, retry);
        if (hasSc) sc = scApi(auth, retry);
      }
    }
    const { psiApi, cruxApi } = await import("./apis");
    const crux = hasPs && cfg.cruxEnabled ? cruxApi() : null;
    report = await runWebAnalyticsCore(cfg, { ga, sc, psi: hasPs ? psiApi() : null, crux, store: dbWebStore, now }, { deadlineAt: o.deadlineAt });
    if (hasPs && cfg.cruxEnabled && !crux) report.warnings.unshift("Chrome UX Report sem chave (GOOGLE_PAGESPEED_API_KEY ou GOOGLE_CRUX_API_KEY) — só dados de laboratório.");
    report.errors.unshift(...errors);
    report.ok = report.errors.length === 0;

    // Alertas e resumo semanal: depois da atualização do dia (nunca partem a recolha).
    const nowMs = now();
    const today = lisbonDayOf(nowMs);
    if (refreshDueAt(nowMs, cfg.refreshHour) && (await allRefreshedToday(cfg, dbWebStore, today))) {
      const { runWebAlerts, runWebInsight } = await import("./service");
      try { report.alerts = await runWebAlerts(cfg, today); } catch (err: any) { report.warnings.push(`Alertas: ${String(err?.message ?? err).slice(0, 160)}`); }
      if (o.deadlineAt - now() > 25_000) {
        try { report.insight = await runWebInsight(cfg, today); } catch (err: any) { report.warnings.push(`Resumo semanal: ${String(err?.message ?? err).slice(0, 160)}`); }
      }
    }
    const last: LastRunInfo = { at: new Date(now()).toISOString(), ok: report.ok, done: report.done, errors: report.errors.slice(0, 10), warnings: report.warnings.slice(0, 10) };
    await dbWebStore.setState("lastRun", JSON.stringify(last)).catch(() => {});
    if (report.ok && report.done) await dbWebStore.setState("lastSuccessAt", last.at).catch(() => {});
  } finally {
    await releaseWebLock(token).catch(() => {});
  }
  return report;
}

