/**
 * Web & SEO (GA4, Search Console, PageSpeed): definições, pedidos às APIs,
 * janelas de recolha (backfill/incremental/alargar), gravação idempotente,
 * alertas, PageSpeed, ligação ao negócio e acessos — com APIs FALSAS.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  overview: vi.fn(),
  config: vi.fn(),
  check: vi.fn(),
  dimCompare: vi.fn(),
  setSetting: vi.fn(),
  runSync: vi.fn(),
}));
vi.mock("./webAnalytics/service", async (orig) => ({
  ...(await orig<object>()),
  webOverview: h.overview,
  loadWebAnalyticsConfig: h.config,
  checkWebAccess: h.check,
}));
vi.mock("./webAnalytics/queries", async (orig) => ({ ...(await orig<object>()), dimCompare: h.dimCompare }));
vi.mock("./webAnalytics/sync", async (orig) => ({ ...(await orig<object>()), runWebAnalyticsSync: h.runSync }));
vi.mock("./appSettings", async (orig) => ({ ...(await orig<object>()), setSetting: h.setSetting }));
vi.mock("./cityAccess", async (orig) => ({ ...(await orig<object>()), loadCityAccess: async () => ({ all: true, defaultCityId: null, cityName: null, cityIds: [], projectIds: [], missingCostCenter: false }) }));
vi.mock("./db", async (orig) => ({ ...(await orig<object>()), getDb: async () => null, logActivity: async () => undefined }));

import {
  DEFAULT_WEB_ANALYTICS_CONFIG, EMPTY_CURSOR, GA_DIMS, applySyncWindow, brandIdOfName, businessJoin, comparisonRange, evaluateWebAlerts, gaDailyRows,
  gaDimRequest, gaTotalsRequest, nextSyncWindow, normalizeGa4PropertyId, normalizeSearchConsoleSite, pagespeedDue, parseCursor, parseGaReport,
  parsePagespeed, parseScRows, parseWebAnalyticsConfig, pctChange, psLevel, scRequest, scopeByBrand, topNPerDay, webAlertThresholdsSchema,
  webAnalyticsConfigSchema, webFactsText, webInsightFallback, weightedPosition,
  type AlertInputs, type GaRow, type ScRow, type SourceCursor, type WebAnalyticsConfig,
} from "../shared/webAnalytics";
import { SETTINGS, validateSetting, CRON_JOBS, AUTOMATION_FLAGS } from "../shared/appSettings";
import { AI_FEATURES } from "../shared/aiFeatures";
import { kindDef } from "../shared/notificationRouting";
import { MIGRATION_0165_STATEMENTS } from "./migrations/migration_0165";
import { gaDimRowsToStore, scDimRowsToStore, type WebStore } from "./webAnalytics/store";
import { isNoAccessError, runWebAnalyticsCore, cursorKey, gaUnitKey, scUnitKey } from "./webAnalytics/sync";
import { accessCheckMessage, mondayOf } from "./webAnalytics/service";
import type { GaApiLike, PsiApiLike, ScApiLike } from "./webAnalytics/apis";
import { addDays, daysInRange } from "../shared/lisbonDay";
import { appRouter } from "./routers";

// ─── Definições ─────────────────────────────────────────────────────────────

describe("definições (marketing.webAnalytics)", () => {
  it("normaliza IDs GA4 e propriedades da Search Console", () => {
    expect(normalizeGa4PropertyId("properties/123456789")).toBe("123456789");
    expect(normalizeGa4PropertyId(" 987654 ")).toBe("987654");
    expect(normalizeGa4PropertyId("G-ABC123")).toBeNull();
    expect(normalizeSearchConsoleSite("sc-domain:Multipark.PT")).toBe("sc-domain:multipark.pt");
    expect(normalizeSearchConsoleSite("https://www.multipark.pt")).toBe("https://www.multipark.pt/");
    expect(normalizeSearchConsoleSite("https://www.multipark.pt/pt/")).toBe("https://www.multipark.pt/pt/");
    expect(normalizeSearchConsoleSite("ftp://x.pt/")).toBeNull();
    expect(normalizeSearchConsoleSite("https://x.pt/?a=1")).toBeNull();
    expect(normalizeSearchConsoleSite("multipark.pt")).toBeNull();
  });

  it("omissões seguras: desligado, 90 dias, 07:00, limiares do pedido", () => {
    const c = DEFAULT_WEB_ANALYTICS_CONFIG;
    expect(c.enabled).toBe(false);
    expect(c.backfillDays).toBe(90);
    expect(c.refreshHour).toBe(7);
    expect(c.alerts).toMatchObject({ enabled: true, sessionsDropPct: 30, clicksDropPct: 30, pagespeedMobileMin: 50, positionDrop: 3, positionTopN: 20 });
    expect(c.funnelEvents).toContain("begin_checkout");
    expect(c.funnelEvents).toContain("purchase");
    expect(c.pagespeedUrls.length).toBeGreaterThan(0);
  });

  it("valida e normaliza ao gravar (e recusa repetidos e inválidos)", () => {
    const r = webAnalyticsConfigSchema.safeParse({
      enabled: true,
      ga4Properties: [{ propertyId: "properties/111111", label: "multipark.pt", brand: "multipark" }],
      searchConsoleSites: [{ siteUrl: "https://multipark.pt", brand: "multipark" }],
      alerts: { sessionsDropPct: 40 },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.ga4Properties[0]).toEqual({ propertyId: "111111", label: "multipark.pt", brand: "multipark", active: true });
      expect(r.data.searchConsoleSites[0].siteUrl).toBe("https://multipark.pt/");
      expect(r.data.alerts.sessionsDropPct).toBe(40);
      expect(r.data.alerts.clicksDropPct).toBe(30);
    }
    expect(webAnalyticsConfigSchema.safeParse({ ga4Properties: [{ propertyId: "1111" }, { propertyId: "properties/1111" }] }).success).toBe(false);
    expect(webAnalyticsConfigSchema.safeParse({ ga4Properties: [{ propertyId: "abc" }] }).success).toBe(false);
    expect(webAnalyticsConfigSchema.safeParse({ funnelEvents: ["begin checkout"] }).success).toBe(false);
    expect(webAnalyticsConfigSchema.safeParse({ ga4Properties: [{ propertyId: "1111", brand: "outra" }] }).success).toBe(false);
    expect(webAlertThresholdsSchema.safeParse({ sessionsDropPct: 2 }).success).toBe(false);
  });

  it("valor guardado inválido → omissões; JSON em texto é aceite", () => {
    expect(parseWebAnalyticsConfig("{mal")).toEqual(DEFAULT_WEB_ANALYTICS_CONFIG);
    expect(parseWebAnalyticsConfig({ ga4Properties: [{ propertyId: "x" }] })).toEqual(DEFAULT_WEB_ANALYTICS_CONFIG);
    expect(parseWebAnalyticsConfig(JSON.stringify({ enabled: true })).enabled).toBe(true);
  });

  it("está no catálogo das Definições, com cron, interruptor de IA e tipo de notificação", () => {
    expect(SETTINGS["marketing.webAnalytics"].group).toBe("marketing");
    expect(validateSetting("marketing.webAnalytics", { enabled: true }).ok).toBe(true);
    expect(validateSetting("marketing.webAnalytics", { refreshHour: 30 }).ok).toBe(false);
    expect(CRON_JOBS.find((j) => j.name === "web-analytics")).toMatchObject({ intervalMinutes: 60, workflow: "web-analytics.yml" });
    expect(AUTOMATION_FLAGS.some((f) => f.name === "AI_WEB_INSIGHT" && f.group === "ia")).toBe(true);
    expect(AI_FEATURES.web_insight).toMatchObject({ flag: "AI_WEB_INSIGHT", tier: "lite" });
    expect(kindDef("web_analytics_alert")).toMatchObject({ module: "marketing", group: "marketing", personal: false });
  });

  it("filtra por marca (só ativas)", () => {
    const cfg = webAnalyticsConfigSchema.parse({
      ga4Properties: [{ propertyId: "1111", brand: "multipark" }, { propertyId: "2222", brand: "redpark" }, { propertyId: "3333", brand: "redpark", active: false }],
      searchConsoleSites: [{ siteUrl: "sc-domain:redpark.pt", brand: "redpark" }],
      pagespeedUrls: [{ url: "https://redpark.pt/", brand: "redpark" }],
    });
    expect(scopeByBrand(cfg, "redpark")).toEqual({ properties: ["2222"], sites: ["sc-domain:redpark.pt"], urls: ["https://redpark.pt/"] });
    expect(scopeByBrand(cfg, "").properties).toEqual(["1111", "2222"]);
  });
});

// ─── Pedidos e respostas ────────────────────────────────────────────────────

describe("pedidos às APIs e leitura das respostas", () => {
  it("GA4: totais por dia (date) com as métricas pedidas, mantendo dias vazios", () => {
    const r = gaTotalsRequest("2026-09-01", "2026-09-30");
    expect(r.dateRanges).toEqual([{ startDate: "2026-09-01", endDate: "2026-09-30" }]);
    expect(r.dimensions).toEqual([{ name: "date" }]);
    expect(r.metrics.map((m) => m.name)).toEqual(["sessions", "totalUsers", "newUsers", "engagedSessions", "keyEvents", "totalRevenue"]);
    expect(r.keepEmptyRows).toBe(true);
  });

  it("GA4: dimensões ordenadas por sessões, com página (offset) e filtro dos eventos do funil", () => {
    const land = gaDimRequest("landing", "2026-09-01", "2026-09-14", { offset: 10_000 });
    expect(land.dimensions).toEqual([{ name: "date" }, { name: "landingPage" }]);
    expect(land.orderBys[0]).toEqual({ metric: { metricName: "sessions" }, desc: true });
    expect(land.offset).toBe("10000");
    expect((land as any).dimensionFilter).toBeUndefined();
    const ev = gaDimRequest("event", "2026-09-01", "2026-09-14", { funnelEvents: ["begin_checkout", "purchase"] });
    expect(ev.metrics.map((m) => m.name)).toEqual(["eventCount", "totalUsers"]);
    expect((ev as any).dimensionFilter.filter).toEqual({ fieldName: "eventName", inListFilter: { values: ["begin_checkout", "purchase"], caseSensitive: true } });
    expect(gaDimRequest("channel", "a", "b").dimensions[1].name).toBe(GA_DIMS.channel.apiName);
  });

  it("GA4: lê as linhas pelos cabeçalhos e põe zeros nos dias sem linha", () => {
    const res = {
      dimensionHeaders: [{ name: "date" }],
      metricHeaders: [{ name: "sessions" }, { name: "totalUsers" }, { name: "totalRevenue" }],
      rows: [
        { dimensionValues: [{ value: "20260902" }], metricValues: [{ value: "120" }, { value: "100" }, { value: "45.5" }] },
        { dimensionValues: [{ value: "lixo" }], metricValues: [{ value: "1" }] },
      ],
      rowCount: 2,
    };
    const p = parseGaReport(res);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toEqual({ day: "2026-09-02", dim: null, m: { sessions: 120, totalUsers: 100, totalRevenue: 45.5 } });
    const daily = gaDailyRows(p.rows, "2026-09-01", "2026-09-03");
    expect(daily.map((d) => [d.day, d.sessions, d.revenue])).toEqual([["2026-09-01", 0, 0], ["2026-09-02", 120, 45.5], ["2026-09-03", 0, 0]]);
  });

  it("top N por dia (e só N por dia, não no total)", () => {
    const rows: GaRow[] = [];
    for (const day of ["2026-09-01", "2026-09-02"]) for (let i = 0; i < 60; i++) rows.push({ day, dim: `/p${i}`, m: { sessions: 1000 - i } });
    const top = topNPerDay(rows, 50, (r) => r.m.sessions);
    expect(top).toHaveLength(100);
    expect(top.filter((r) => r.day === "2026-09-01").map((r) => r.dim).slice(0, 2)).toEqual(["/p0", "/p1"]);
    expect(top.some((r) => r.dim === "/p55")).toBe(false);
    expect(gaDimRowsToStore("landing", rows)).toHaveLength(100);
    expect(gaDimRowsToStore("landing", rows)[0].valueHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("Search Console: pedido web com dataState all e página; linhas e posição ponderada", () => {
    expect(scRequest("totals", "2026-09-01", "2026-09-07")).toMatchObject({ dimensions: ["date"], type: "web", dataState: "all", rowLimit: 25_000, startRow: 0 });
    expect(scRequest("query", "2026-09-01", "2026-09-07", 25_000).dimensions).toEqual(["date", "query"]);
    const rows = parseScRows({ rows: [{ keys: ["2026-09-01", "parque aeroporto lisboa"], clicks: 10, impressions: 100, ctr: 0.1, position: 2.5 }, { keys: ["x"] }] }, "query");
    expect(rows).toEqual([{ day: "2026-09-01", dim: "parque aeroporto lisboa", clicks: 10, impressions: 100, position: 2.5 }]);
    expect(weightedPosition([{ impressions: 100, position: 2 }, { impressions: 300, position: 6 }])).toBe(5);
    expect(weightedPosition([])).toBeNull();
    const many: ScRow[] = Array.from({ length: 300 }, (_, i) => ({ day: "2026-09-01", dim: `q${i}`, clicks: 300 - i, impressions: 1000, position: 3 }));
    expect(scDimRowsToStore("query", many)).toHaveLength(250);
  });
});

// ─── Janelas de recolha ─────────────────────────────────────────────────────

describe("janelas: backfill → incremental → alargar", () => {
  const base = { today: "2026-09-25", lagDays: 1, backfillDays: 90, chunkDays: 31, refetchDays: 3, refreshDue: true };

  const drain = (c: SourceCursor, o: typeof base) => {
    const wins = [];
    for (let i = 0; i < 50; i++) {
      const w = nextSyncWindow(c, o);
      if (!w) break;
      wins.push(w);
      c = applySyncWindow(c, w, o.today);
    }
    return { wins, cursor: c };
  };

  it("1.ª vez: 90 dias em blocos até ontem e a releitura dos últimos 3 dias", () => {
    const { wins, cursor } = drain({ ...EMPTY_CURSOR }, base);
    expect(wins).toEqual([
      { from: "2026-06-27", to: "2026-07-27", kind: "backfill" },
      { from: "2026-07-28", to: "2026-08-27", kind: "backfill" },
      { from: "2026-08-28", to: "2026-09-24", kind: "backfill" },
      { from: "2026-09-22", to: "2026-09-24", kind: "refresh" },
    ]);
    expect(cursor).toEqual({ coveredFrom: "2026-06-27", coveredTo: "2026-09-24", refreshedOn: "2026-09-25" });
  });

  it("dia seguinte: só relê os últimos dias (1×/dia, depois da hora)", () => {
    const c: SourceCursor = { coveredFrom: "2026-06-27", coveredTo: "2026-09-24", refreshedOn: "2026-09-25" };
    const next = { ...base, today: "2026-09-26" };
    expect(nextSyncWindow(c, { ...next, refreshDue: false })).toBeNull();
    const { wins } = drain(c, next);
    expect(wins).toEqual([{ from: "2026-09-23", to: "2026-09-25", kind: "refresh" }]);
  });

  it("parado vários dias: avança em blocos antes da releitura", () => {
    const c: SourceCursor = { coveredFrom: "2026-06-27", coveredTo: "2026-09-10", refreshedOn: "2026-09-11" };
    expect(nextSyncWindow(c, base)).toEqual({ from: "2026-09-11", to: "2026-09-24", kind: "backfill" });
  });

  it("histórico aumentado nas Definições → alarga para trás", () => {
    const c: SourceCursor = { coveredFrom: "2026-06-27", coveredTo: "2026-09-24", refreshedOn: "2026-09-25" };
    const { wins, cursor } = drain(c, { ...base, backfillDays: 120 });
    expect(wins).toEqual([{ from: "2026-05-28", to: "2026-06-26", kind: "extend" }]);
    expect(cursor.coveredFrom).toBe("2026-05-28");
  });

  it("Search Console: atraso de 2 dias", () => {
    const w = nextSyncWindow({ coveredFrom: "2026-06-27", coveredTo: "2026-09-20", refreshedOn: "2026-09-24" }, { ...base, lagDays: 2, refetchDays: 4 });
    expect(w).toEqual({ from: "2026-09-20", to: "2026-09-23", kind: "refresh" });
  });

  it("cursor guardado inválido → vazio", () => {
    expect(parseCursor("{")).toEqual(EMPTY_CURSOR);
    expect(parseCursor(JSON.stringify({ coveredFrom: "2026-01-01", coveredTo: "x" }))).toEqual({ coveredFrom: "2026-01-01", coveredTo: null, refreshedOn: null });
  });
});

// ─── Motor com APIs falsas e BD em memória ─────────────────────────────────

class MemStore implements WebStore {
  state = new Map<string, string>();
  gaDaily = new Map<string, any>();
  gaDims = new Map<string, any>();
  scDaily = new Map<string, any>();
  scDims = new Map<string, any>();
  ps: Array<{ url: string; strategy: string; runDay: string; score: number | null }> = [];
  async getState(k: string) { return this.state.get(k) ?? null; }
  async setState(k: string, v: string | null) { if (v == null) this.state.delete(k); else this.state.set(k, v); }
  async upsertGaDaily(pid: string, rows: any[]) { for (const r of rows) this.gaDaily.set(`${pid}|${r.day}`, { ...r }); }
  async replaceGaDims(pid: string, dim: any, from: string, to: string, rows: GaRow[]) {
    for (const k of Array.from(this.gaDims.keys())) { const [p, d, day] = k.split("|"); if (p === pid && d === dim && day >= from && day <= to) this.gaDims.delete(k); }
    for (const r of gaDimRowsToStore(dim, rows)) this.gaDims.set(`${pid}|${dim}|${r.day}|${r.valueHash}`, r);
  }
  async upsertScDaily(site: string, rows: ScRow[]) { for (const r of rows) this.scDaily.set(`${site}|${r.day}`, { ...r }); }
  async replaceScDims(site: string, dim: any, from: string, to: string, rows: ScRow[]) {
    for (const k of Array.from(this.scDims.keys())) { const [s, d, day] = k.split("|"); if (s === site && d === dim && day >= from && day <= to) this.scDims.delete(k); }
    for (const r of scDimRowsToStore(dim, rows)) this.scDims.set(`${site}|${dim}|${r.day}|${r.valueHash}`, r);
  }
  async latestPagespeed() { return this.ps; }
  async savePagespeed(r: any) { this.ps = this.ps.filter((x) => !(x.url === r.url && x.strategy === r.strategy && x.runDay === r.runDay)); this.ps.push({ url: r.url, strategy: r.strategy, runDay: r.runDay, score: r.result?.score ?? null }); }
  snapshot() { return JSON.stringify([Array.from(this.gaDaily.entries()).sort(), Array.from(this.gaDims.entries()).sort(), Array.from(this.scDaily.entries()).sort(), Array.from(this.scDims.entries()).sort()]); }
}

const ymd = (d: string) => d.replace(/-/g, "");

function fakeGa(opts: { deny?: string[]; calls?: string[] } = {}): GaApiLike {
  return {
    async runReport(pid, body: any) {
      opts.calls?.push(`${pid}:${body.dimensions.map((x: any) => x.name).join(",")}:${body.dateRanges[0].startDate}`);
      if (opts.deny?.includes(pid)) throw Object.assign(new Error("User does not have sufficient permissions for this property."), { response: { status: 403, data: { error: { status: "PERMISSION_DENIED" } } } });
      const days = daysInRange(body.dateRanges[0].startDate, body.dateRanges[0].endDate);
      const dims = body.dimensions.map((x: any) => x.name);
      const metrics = body.metrics.map((m: any) => m.name);
      const rows: any[] = [];
      for (const day of days) {
        if (dims.length === 1) rows.push({ dimensionValues: [{ value: ymd(day) }], metricValues: metrics.map(() => ({ value: "100" })) });
        else for (let i = 0; i < 3; i++) rows.push({ dimensionValues: [{ value: ymd(day) }, { value: `v${i}` }], metricValues: metrics.map(() => ({ value: String(30 - i) })) });
      }
      return { dimensionHeaders: dims.map((name: string) => ({ name })), metricHeaders: metrics.map((name: string) => ({ name })), rows, rowCount: rows.length };
    },
  };
}
function fakeSc(opts: { rateLimit?: boolean } = {}): ScApiLike {
  return {
    async query(_site, body: any) {
      if (opts.rateLimit) throw Object.assign(new Error("Quota exceeded"), { response: { status: 429 } });
      const rows: any[] = [];
      for (const day of daysInRange(body.startDate, body.endDate)) {
        if (body.dimensions.length === 1) rows.push({ keys: [day], clicks: 50, impressions: 500, position: 4.2 });
        else rows.push({ keys: [day, `${body.dimensions[1]}-a`], clicks: 20, impressions: 200, position: 3 });
      }
      return { rows };
    },
    async getSite(siteUrl) { return { siteUrl, permissionLevel: "siteRestrictedUser" }; },
  };
}
const fakePsi = (calls: string[]): PsiApiLike => ({
  async run(url, strategy) {
    calls.push(`${url}:${strategy}`);
    return { lighthouseResult: { categories: { performance: { score: 0.42 } }, audits: { "largest-contentful-paint": { numericValue: 3100 } } } };
  },
});

// 25/09/2026 11:00 em Lisboa (10:00 UTC) — depois da hora da atualização (07:00).
const NOW = Date.UTC(2026, 8, 25, 10, 0, 0);
const cfgWith = (patch: Partial<WebAnalyticsConfig> = {}): WebAnalyticsConfig => webAnalyticsConfigSchema.parse({
  enabled: true,
  ga4Properties: [{ propertyId: "1111", label: "multipark.pt", brand: "multipark" }],
  searchConsoleSites: [{ siteUrl: "sc-domain:multipark.pt", brand: "multipark" }],
  pagespeedUrls: [{ url: "https://multipark.pt/", label: "Início", brand: "multipark" }],
  ...patch,
});

describe("recolha (motor) com APIs falsas", () => {
  it("backfill completo numa corrida longa, depois em dia; reler não muda nada (idempotente)", async () => {
    const store = new MemStore();
    const psiCalls: string[] = [];
    const cfg = cfgWith();
    const r1 = await runWebAnalyticsCore(cfg, { ga: fakeGa(), sc: fakeSc(), psi: fakePsi(psiCalls), store, now: () => NOW }, { deadlineAt: NOW + 10 * 60_000 });
    expect(r1.ok).toBe(true);
    expect(r1.done).toBe(true);
    expect(r1.errors).toEqual([]);
    // GA4: 90 dias até ontem (24/09), zeros incluídos → 90 linhas.
    expect(store.gaDaily.size).toBe(90);
    expect(store.gaDaily.has("1111|2026-06-27")).toBe(true);
    expect(store.gaDaily.has("1111|2026-09-25")).toBe(false);
    // Search Console: até 23/09 (2 dias de atraso).
    expect(store.scDaily.has("sc-domain:multipark.pt|2026-09-23")).toBe(true);
    expect(store.scDaily.has("sc-domain:multipark.pt|2026-09-24")).toBe(false);
    // PageSpeed: móvel e computador medidos hoje (1×/semana).
    expect(psiCalls.sort()).toEqual(["https://multipark.pt/:desktop", "https://multipark.pt/:mobile"]);
    expect(r1.pagespeed).toMatchObject({ measured: 2, failed: 0, pending: 0 });
    const cur = JSON.parse(store.state.get(cursorKey(gaUnitKey("1111", "totals")))!);
    expect(cur).toEqual({ coveredFrom: "2026-06-27", coveredTo: "2026-09-24", refreshedOn: "2026-09-25" });
    const snap = store.snapshot();

    // 2.ª corrida no mesmo dia: nada a fazer (nenhum pedido).
    const calls: string[] = [];
    const r2 = await runWebAnalyticsCore(cfg, { ga: fakeGa({ calls }), sc: fakeSc(), psi: fakePsi(psiCalls), store, now: () => NOW }, { deadlineAt: NOW + 10 * 60_000 });
    expect(r2.done).toBe(true);
    expect(calls).toEqual([]);
    expect(psiCalls).toHaveLength(2);

    // Forçar a releitura (apagar a marca de hoje) → os mesmos dados (idempotente).
    for (const [k, v] of Array.from(store.state.entries())) if (k.startsWith("cursor:")) store.state.set(k, JSON.stringify({ ...JSON.parse(v), refreshedOn: "2026-09-24" }));
    const r3 = await runWebAnalyticsCore(cfg, { ga: fakeGa({ calls }), sc: fakeSc(), psi: null, store, now: () => NOW }, { deadlineAt: NOW + 10 * 60_000 });
    expect(r3.done).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.endsWith(":2026-09-22"))).toBe(true);
    expect(store.snapshot()).toBe(snap);
  });

  it("prazo curto: pára antes de um pedido, done:false, e retoma onde ficou", async () => {
    const store = new MemStore();
    let t = NOW;
    const clock = () => t;
    const ga: GaApiLike = { async runReport(pid, body) { t += 10_000; return fakeGa().runReport(pid, body); } };
    const cfg = cfgWith({ searchConsoleSites: [], pagespeedEnabled: false });
    const r1 = await runWebAnalyticsCore(cfg, { ga, sc: null, psi: null, store, now: clock }, { deadlineAt: NOW + 45_000 });
    expect(r1.done).toBe(false);
    expect(r1.ok).toBe(true);
    const c1 = JSON.parse(store.state.get(cursorKey(gaUnitKey("1111", "totals")))!);
    expect(c1.coveredFrom).toBe("2026-06-27");
    // 3 pedidos cabem (45 s, 10 s cada, nunca começa um com < 22 s): falta a releitura e as outras partes.
    expect(c1.refreshedOn).toBeNull();
    expect(store.state.has(cursorKey(gaUnitKey("1111", "channel")))).toBe(false);
    // Corridas seguintes continuam até ficar em dia.
    let done = false;
    for (let i = 0; i < 40 && !done; i++) {
      t = NOW;
      done = (await runWebAnalyticsCore(cfg, { ga, sc: null, psi: null, store, now: clock }, { deadlineAt: NOW + 45_000 })).done;
    }
    expect(done).toBe(true);
    expect(store.gaDaily.size).toBe(90);
  });

  it("propriedade sem acesso: aviso com a correção, sem parar as outras; limite de pedidos não é erro", async () => {
    const store = new MemStore();
    const cfg = cfgWith({ ga4Properties: [{ propertyId: "1111", label: "a", brand: "multipark", active: true }, { propertyId: "2222", label: "b", brand: "redpark", active: true }], pagespeedEnabled: false });
    const r = await runWebAnalyticsCore(cfg, { ga: fakeGa({ deny: ["1111"] }), sc: fakeSc({ rateLimit: true }), psi: null, store, now: () => NOW }, { deadlineAt: NOW + 10 * 60_000 });
    expect(r.ok).toBe(true);
    expect(r.done).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/GA4 1111: sem acesso — adiciona a conta de serviço/);
    expect(store.state.get("error:ga:1111")).toMatch(/Sem acesso/);
    expect(r.units.filter((u) => u.key.startsWith("ga:1111")).every((u) => u.status !== "ok")).toBe(true);
    expect(store.gaDaily.has("2222|2026-09-24")).toBe(true);
    expect(r.units.find((u) => u.key === scUnitKey("sc-domain:multipark.pt", "totals"))?.status).toBe("rate_limited");
    expect(r.errors).toEqual([]);
    // Só "sem acesso" (sem limite de pedidos): em dia — o workflow não repete à toa.
    const r2 = await runWebAnalyticsCore(cfg, { ga: fakeGa({ deny: ["1111"] }), sc: null, psi: null, store: new MemStore(), now: () => NOW }, { deadlineAt: NOW + 10 * 60_000 });
    expect(r2.done).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it("erro a sério (500) pinta a corrida de vermelho", async () => {
    const store = new MemStore();
    const ga: GaApiLike = { async runReport() { throw Object.assign(new Error("Internal error"), { response: { status: 500 } }); } };
    const r = await runWebAnalyticsCore(cfgWith({ searchConsoleSites: [], pagespeedEnabled: false }), { ga, sc: null, psi: null, store, now: () => NOW }, { deadlineAt: NOW + 60_000 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/GA4 1111/);
  });

  it("classifica erros de acesso", () => {
    expect(isNoAccessError({ response: { status: 403, data: { error: { status: "PERMISSION_DENIED" } } } })).toBe(true);
    expect(isNoAccessError({ response: { status: 404 } })).toBe(true);
    expect(isNoAccessError({ response: { status: 403, data: { error: { errors: [{ reason: "rateLimitExceeded" }] } } } })).toBe(false);
    expect(isNoAccessError({ response: { status: 500 } })).toBe(false);
  });
});

// ─── PageSpeed ──────────────────────────────────────────────────────────────

describe("PageSpeed", () => {
  it("lê laboratório e campo (CrUX)", () => {
    const r = parsePagespeed({
      lighthouseResult: {
        categories: { performance: { score: 0.87 } },
        audits: {
          "largest-contentful-paint": { numericValue: 2345.6 }, "cumulative-layout-shift": { numericValue: 0.0512 },
          "total-blocking-time": { numericValue: 180.2 }, "first-contentful-paint": { numericValue: 1200 }, "speed-index": { numericValue: 3000 },
        },
      },
      loadingExperience: { overall_category: "AVERAGE", metrics: { INTERACTION_TO_NEXT_PAINT: { percentile: 240 }, LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2900 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12 } } },
    });
    expect(r).toEqual({ score: 87, lcpMs: 2346, cls: 0.051, tbtMs: 180, fcpMs: 1200, speedIndexMs: 3000, inpMs: 240, fieldLcpMs: 2900, fieldCls: 0.12, fieldCategory: "AVERAGE" });
    expect(parsePagespeed({}).score).toBeNull();
  });

  it("verde/âmbar/vermelho com os limiares da Google", () => {
    expect(psLevel("score", 95)).toBe("good");
    expect(psLevel("score", 50)).toBe("needs_improvement");
    expect(psLevel("score", 49)).toBe("poor");
    expect(psLevel("lcpMs", 2500)).toBe("good");
    expect(psLevel("lcpMs", 4001)).toBe("poor");
    expect(psLevel("cls", 0.2)).toBe("needs_improvement");
    expect(psLevel("inpMs", 200)).toBe("good");
    expect(psLevel("inpMs", null)).toBeNull();
  });

  it("1×/semana por página e estratégia", () => {
    const due = pagespeedDue(["https://a.pt/"], [{ url: "https://a.pt/", strategy: "mobile", runDay: "2026-09-20" }, { url: "https://a.pt/", strategy: "desktop", runDay: "2026-09-18" }], "2026-09-25");
    expect(due).toEqual([{ url: "https://a.pt/", strategy: "desktop" }]);
  });
});

// ─── Alertas ────────────────────────────────────────────────────────────────

describe("alertas (limiares configuráveis)", () => {
  const thresholds = webAlertThresholdsSchema.parse({});
  const days = (to: string, n: number, v: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ day: addDays(to, -(n - 1 - i)), value: v(i) }));
  const base = (patch: Partial<AlertInputs> = {}): AlertInputs => ({ today: "2026-09-25", thresholds, ga: [], sc: [], pagespeed: [], queries: [], scEnd: "2026-09-22", ...patch });

  it("sessões: ontem −30% vs média de 7 dias", () => {
    const ga = [{ id: "1111", label: "multipark.pt", days: days("2026-09-24", 8, (i) => (i === 7 ? 60 : 100)).map((d) => ({ day: d.day, sessions: d.value })) }];
    const a = evaluateWebAlerts(base({ ga }));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ code: "sessions_drop", level: "warning", key: "sessions:1111:2026-09-24" });
    expect(a[0].detail).toMatch(/−40%/);
    // −20%: não alerta; base pequena: não alerta.
    expect(evaluateWebAlerts(base({ ga: [{ ...ga[0], days: ga[0].days.map((d, i) => ({ ...d, sessions: i === 7 ? 80 : 100 })) }] }))).toHaveLength(0);
    expect(evaluateWebAlerts(base({ ga: [{ ...ga[0], days: ga[0].days.map((d, i) => ({ ...d, sessions: i === 7 ? 1 : 10 })) }] }))).toHaveLength(0);
    // limiar mais apertado
    expect(evaluateWebAlerts(base({ ga: [{ ...ga[0], days: ga[0].days.map((d, i) => ({ ...d, sessions: i === 7 ? 80 : 100 })) }], thresholds: { ...thresholds, sessionsDropPct: 15 } }))).toHaveLength(1);
    // desligados
    expect(evaluateWebAlerts(base({ ga, thresholds: { ...thresholds, enabled: false } }))).toEqual([]);
  });

  it("cliques: semana −30% vs a anterior (só semanas completas)", () => {
    const sc = [{ id: "sc-domain:multipark.pt", label: "multipark.pt", days: days("2026-09-22", 14, (i) => (i >= 7 ? 50 : 100)).map((d) => ({ day: d.day, clicks: d.value })) }];
    const a = evaluateWebAlerts(base({ sc }));
    expect(a.map((x) => x.code)).toEqual(["clicks_drop"]);
    expect(a[0].level).toBe("critical");
    expect(evaluateWebAlerts(base({ sc: [{ ...sc[0], days: sc[0].days.slice(3) }] }))).toHaveLength(0);
  });

  it("PageSpeed móvel < 50 (computador não conta)", () => {
    const a = evaluateWebAlerts(base({ pagespeed: [
      { url: "https://a.pt/", label: "A", strategy: "mobile", score: 42, runDay: "2026-09-25" },
      { url: "https://a.pt/", label: "A", strategy: "desktop", score: 20, runDay: "2026-09-25" },
      { url: "https://b.pt/", label: "B", strategy: "mobile", score: 70, runDay: "2026-09-25" },
    ] }));
    expect(a.map((x) => [x.code, x.title])).toEqual([["pagespeed_low", "PageSpeed móvel baixa: A"]]);
  });

  it("posição: pesquisas do top 20 que caíram mais de 3 lugares", () => {
    const queries = Array.from({ length: 25 }, (_, i) => ({ siteId: "s", siteLabel: "multipark.pt", query: `q${i}`, prevClicks: 100 - i, curPosition: i === 0 || i === 24 ? 9 : 3, prevPosition: 3 }));
    const a = evaluateWebAlerts(base({ queries }));
    expect(a).toHaveLength(1);
    expect(a[0].code).toBe("position_drop");
    expect(a[0].items).toEqual(['"q0": 3,0 → 9,0']); // q24 está fora do top 20
  });
});

// ─── Negócio, períodos e resumo ─────────────────────────────────────────────

describe("ligação ao negócio e períodos", () => {
  it("conversão web → reserva, receita e gasto por sessão", () => {
    const r = businessJoin(["2026-09-01", "2026-09-02", "2026-09-03"], {
      sessions: new Map([["2026-09-01", 1000], ["2026-09-02", 500]]),
      bookings: new Map([["2026-09-01", { bookings: 30, siteBookings: 20, revenue: 1500, siteRevenue: 1000 }], ["2026-09-03", { bookings: 5, siteBookings: 5, revenue: 250, siteRevenue: 250 }]]),
      spend: new Map([["2026-09-01", 150], ["2026-09-02", 75]]),
    });
    expect(r.rows[0]).toMatchObject({ conversionRate: 0.02, revenuePerSession: 1 });
    expect(r.rows[2].conversionRate).toBeNull(); // sem sessões → sem taxa (não infinito)
    expect(r.totals).toMatchObject({ sessions: 1500, bookings: 35, siteBookings: 25, siteRevenue: 1250, spend: 225 });
    expect(r.totals.conversionRate).toBeCloseTo(25 / 1500, 10);
    expect(r.totals.revenuePerSession).toBeCloseTo(1250 / 1500, 10);
    expect(r.totals.spendPerSession).toBeCloseTo(0.15, 10);
    expect(r.totals.spendPerSiteBooking).toBe(9);
    expect(r.totals.bookingsPerSession).toBeCloseTo(35 / 1500, 10);
  });

  it("marca da árvore de projetos ↔ id", () => {
    expect(brandIdOfName("Multipark")).toBe("multipark");
    expect(brandIdOfName(" RedPark ")).toBe("redpark");
    expect(brandIdOfName("Lisboa")).toBeNull();
  });

  it("período anterior e ano passado (29/02 → 28/02)", () => {
    expect(comparisonRange("2026-09-01", "2026-09-30", "previous")).toEqual({ from: "2026-08-02", to: "2026-08-31" });
    expect(comparisonRange("2026-09-01", "2026-09-30", "yoy")).toEqual({ from: "2025-09-01", to: "2025-09-30" });
    expect(comparisonRange("2028-02-29", "2028-03-01", "yoy")).toEqual({ from: "2027-02-28", to: "2027-03-01" });
    expect(pctChange(120, 100)).toBeCloseTo(0.2);
    expect(pctChange(1, 0)).toBeNull();
  });

  it("resumo: factos só com agregados e texto fixo quando não há IA", () => {
    const f = {
      from: "2026-09-16", to: "2026-09-22",
      ga: { sessions: 1200, prevSessions: 1000, users: 900, prevUsers: 800, keyEvents: 30, prevKeyEvents: 25, revenue: 0, prevRevenue: 0 },
      channels: [{ name: "Organic Search", cur: 600, prev: 400 }, { name: "Paid Search", cur: 300, prev: 350 }],
      sc: { clicks: 800, prevClicks: 1000, impressions: 20000, prevImpressions: 21000, position: 5.4, prevPosition: 4.9 },
      gainers: [{ query: "parque aeroporto porto", delta: 12 }], losers: [{ query: "estacionamento lisboa aeroporto", delta: -40 }],
      pagespeed: [{ label: "Início", score: 38 }], bookings: { siteBookings: 50, prevSiteBookings: 40 },
    };
    const facts = webFactsText(f);
    expect(facts).toMatch(/Sessões: 1\s?200 \(\+20%\)/);
    expect(facts).toMatch(/PageSpeed móvel fraca: Início 38\/100/);
    expect(facts).not.toMatch(/@/);
    const txt = webInsightFallback(f);
    expect(txt).toMatch(/Sessões \+20%/);
    expect(txt).toMatch(/Organic Search \(\+50%\)/);
    expect(txt).toMatch(/Maior perda: "estacionamento lisboa aeroporto"/);
    expect(mondayOf("2026-09-25")).toBe("2026-09-21");
    expect(mondayOf("2026-09-21")).toBe("2026-09-21");
    expect(mondayOf("2026-09-27")).toBe("2026-09-21");
  });

  it("mensagem do Testar: diz o que falta e o email a adicionar", () => {
    const c = { serviceAccountEmail: "dash@proj.iam.gserviceaccount.com", impersonating: null, ga: [{ id: "1111", label: "multipark.pt", ok: true, error: null }, { id: "2222", label: "redpark.pt", ok: false, error: "User does not have sufficient permissions" }], sc: [] };
    expect(() => accessCheckMessage("ga", c)).toThrow(/Sem acesso a 1 de 2 propriedade\(s\) GA4: redpark\.pt .*dash@proj\.iam\.gserviceaccount\.com.*Leitor/);
    expect(accessCheckMessage("ga", { ...c, ga: [c.ga[0]] })).toMatch(/Acesso OK a 1 propriedade/);
    expect(() => accessCheckMessage("sc", c)).toThrow(/Nenhuma propriedade/);
  });

  it("migração 0165 idempotente (só CREATE TABLE IF NOT EXISTS)", () => {
    expect(MIGRATION_0165_STATEMENTS.length).toBe(6);
    for (const s of MIGRATION_0165_STATEMENTS) expect(s.startsWith("CREATE TABLE IF NOT EXISTS")).toBe(true);
    expect(MIGRATION_0165_STATEMENTS.join(" ")).toMatch(/UNIQUE KEY `uq_web_ga_dims` \(`propertyId`, `dim`, `day`, `valueHash`\)/);
  });
});

// ─── Acessos (matriz do Marketing — só super_admin; nada alargado) ─────────

const caller = (role = "super_admin") => appRouter.createCaller({ user: { id: 7, role }, req: { headers: {} }, res: {} } as any);
const range = { from: "2026-09-01", to: "2026-09-24" };

describe("marketing.web — permissões", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.overview.mockResolvedValue({ ok: true });
    h.config.mockResolvedValue(cfgWith());
    h.dimCompare.mockResolvedValue({ rows: [{ key: ":a", value: "/", sourceId: "1111", cur: {}, prev: {}, position: null, prevPosition: null }], total: 1 });
    h.check.mockResolvedValue({ serviceAccountEmail: "x", impersonating: null, ga: [], sc: [] });
    h.setSetting.mockResolvedValue({ changed: true, value: {} });
    h.runSync.mockResolvedValue({ ok: true, done: true, configured: true, errors: [], warnings: [], pagespeed: { measured: 0, failed: 0, pending: 0 }, units: [] });
  });

  it("admin, backoffice, frontoffice e extras não veem nem configuram", async () => {
    for (const role of ["admin", "backoffice", "frontoffice", "extra", "supervisor"]) {
      await expect(caller(role).marketing.web.overview(range)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).marketing.web.list({ ...range, source: "sc", dim: "query" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).marketing.web.settings.save({ enabled: true } as any)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).marketing.web.settings.check()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).marketing.web.settings.runNow()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(h.overview).not.toHaveBeenCalled();
    expect(h.dimCompare).not.toHaveBeenCalled();
    expect(h.setSetting).not.toHaveBeenCalled();
    expect(h.check).not.toHaveBeenCalled();
    expect(h.runSync).not.toHaveBeenCalled();
  });

  it("super admin vê e configura", async () => {
    await expect(caller().marketing.web.overview({ ...range, compare: "yoy", brand: "multipark" })).resolves.toEqual({ ok: true });
    expect(h.overview).toHaveBeenCalledWith({ from: "2026-09-01", to: "2026-09-24", brand: "multipark", compare: "yoy" });
    const l = await caller().marketing.web.list({ ...range, source: "ga", dim: "landing", page: 2, pageSize: 10 });
    expect(l.rows[0].sourceLabel).toBe("multipark.pt");
    expect(h.dimCompare).toHaveBeenCalledWith(expect.objectContaining({ source: "ga", ids: ["1111"], dim: "landing", limit: 10, offset: 10, prev: { from: "2026-08-08", to: "2026-08-31" } }));
    await caller().marketing.web.settings.save({ enabled: true, ga4Properties: [{ propertyId: "properties/5555" }] } as any);
    expect(h.setSetting).toHaveBeenCalledWith("marketing.webAnalytics", expect.objectContaining({ enabled: true, ga4Properties: [expect.objectContaining({ propertyId: "5555" })] }), 7);
    await caller().marketing.web.settings.runNow();
    expect(h.runSync).toHaveBeenCalled();
  });

  it("recusa dimensões/ordenações fora da lista e períodos inválidos", async () => {
    await expect(caller().marketing.web.list({ ...range, source: "ga", dim: "query" } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().marketing.web.list({ ...range, source: "sc", dim: "query", sort: "revenue" } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().marketing.web.overview({ from: "2026-09-10", to: "2026-09-01" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().marketing.web.overview({ from: "2024-01-01", to: "2026-09-01" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a definição genérica também é só do super admin", async () => {
    await expect(caller("admin").settings.values.set({ key: "marketing.webAnalytics", value: { enabled: true } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
