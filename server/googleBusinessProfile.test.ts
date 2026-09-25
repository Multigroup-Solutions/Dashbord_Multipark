/**
 * Google Business Profile (desempenho, pesquisas, horários, publicações,
 * alertas) e o "Testar" com diagnóstico — com APIs FALSAS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolved: vi.fn(),
  config: vi.fn(),
  setSetting: vi.fn(),
  applyHours: vi.fn(),
  createPosts: vi.fn(),
  deletePost: vi.fn(),
  clientFor: vi.fn(),
  runSync: vi.fn(),
  log: vi.fn(),
}));
vi.mock("./integrations/googleBusiness/insightsQueries", async (orig) => ({
  ...(await orig<object>()),
  resolvedLocations: h.resolved,
  loadGbpConfig: h.config,
}));
vi.mock("./integrations/googleBusiness/manage", async (orig) => ({
  ...(await orig<object>()),
  applyHours: h.applyHours,
  createPosts: h.createPosts,
  deletePost: h.deletePost,
  clientFor: h.clientFor,
}));
vi.mock("./integrations/googleBusiness/insights", async (orig) => ({ ...(await orig<object>()), runGbpInsightsSync: h.runSync }));
vi.mock("./appSettings", async (orig) => ({ ...(await orig<object>()), setSetting: h.setSetting }));
vi.mock("./cityAccess", async (orig) => ({ ...(await orig<object>()), loadCityAccess: async () => ({ all: true, defaultCityId: null, cityName: null, cityIds: [], projectIds: [], missingCostCenter: false }) }));
vi.mock("./db", async (orig) => ({ ...(await orig<object>()), getDb: async () => null, logActivity: h.log }));

import {
  DEFAULT_GBP_CONFIG, GbpValidationError, buildHoursPatch, buildLocalPost, buildRegularHours, buildSpecialHours, evaluateGbpAlerts, gbpBusinessByCity,
  gbpConfigSchema, guessBrand, keywordMonthsDue, keywordsParams, mergeSpecialDays, parseKeywords, parsePerformance, parsePosts, parseRegularHours,
  parseSpecialHours, performanceParams, ratingByWeek, resolveLocationMapping, reviewKpis, sumGbpValues, type DayHours, type GbpAlertInputs, type GbpDayRow,
} from "../shared/googleBusinessProfile";
import {
  GBP_ACCESS_FORM_URL, GbpApiError, diagnoseGbpError, isQuotaZero, parseGoogleErrorBody, projectNumberOfClientId, testGoogleBusiness, type GbpTestDeps,
} from "./integrations/googleBusiness/diagnostics";
import { BusinessClient } from "./integrations/googleBusiness/client";
import { runGbpInsightsCore, gbpPerfKey, gbpKwKey, locationsToSync, type GbpApiLike } from "./integrations/googleBusiness/insights";
import { keywordRowsToStore, type GbpLocationRow, type GbpStore } from "./integrations/googleBusiness/insightsStore";
// manage.ts está simulado para os testes do router — aqui usa-se o verdadeiro.
const { applyHours: realApplyHours, createPosts: realCreatePosts, deletePost: realDeletePost } = await vi.importActual<typeof import("./integrations/googleBusiness/manage")>("./integrations/googleBusiness/manage");
import { scopeLocations, type ResolvedLocation } from "./integrations/googleBusiness/insightsQueries";
import { MIGRATION_0170_STATEMENTS } from "./migrations/migration_0170";
import { SETTINGS, validateSetting, AUTOMATION_FLAGS } from "../shared/appSettings";
import { AI_FEATURES } from "../shared/aiFeatures";
import { kindDef } from "../shared/notificationRouting";
import { appRouter } from "./routers";

// ─── Diagnóstico do "Testar" ───────────────────────────────────────────────

const quotaBody = (limit?: string) => ({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for consumer 'project_number:123' secret-ish",
  details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED", domain: "googleapis.com",
    metadata: { service: "mybusinessaccountmanagement.googleapis.com", ...(limit != null ? { quota_limit_value: limit } : {}), quota_metric: "mybusinessaccountmanagement.googleapis.com/default_requests" } }] } });
const disabledBody = (service: string) => ({ error: { code: 403, status: "PERMISSION_DENIED", message: "API has not been used in project 123",
  details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", metadata: { service, consumer: "projects/123" } }] } });

describe("diagnóstico dos erros do Business Profile", () => {
  it("429 com quota 0 → pedir acesso à API (com o n.º do projeto), sem a mensagem livre da Google", () => {
    const info = parseGoogleErrorBody(429, "mybusinessaccountmanagement.googleapis.com", quotaBody("0"));
    expect(info).toMatchObject({ status: 429, reason: "RATE_LIMIT_EXCEEDED", quotaLimitValue: "0", service: "mybusinessaccountmanagement.googleapis.com" });
    expect(isQuotaZero(info)).toBe(true);
    const msg = diagnoseGbpError(info, { projectNumber: "123456789" });
    expect(msg).toMatch(/My Business Account Management API: quota 0/);
    expect(msg).toContain(GBP_ACCESS_FORM_URL);
    expect(msg).toMatch(/projeto n\.º 123456789/);
    expect(msg).toMatch(/300 pedidos\/min/);
    expect(msg).not.toMatch(/secret-ish|consumer/);
  });
  it("429 sem valor da quota → 'quase sempre quota 0'; com limite > 0 → esperar 1 minuto", () => {
    expect(diagnoseGbpError(parseGoogleErrorBody(429, "mybusiness.googleapis.com", null))).toMatch(/quota esgotada — quase sempre quota 0.*pede acesso|Pede acesso/i);
    expect(diagnoseGbpError(parseGoogleErrorBody(429, "businessprofileperformance.googleapis.com", quotaBody("300")))).toMatch(/limite de 300 pedidos por minuto.*daqui a 1 minuto/);
  });
  it("403 SERVICE_DISABLED → qual API ativar e onde", () => {
    const msg = diagnoseGbpError(parseGoogleErrorBody(403, "businessprofileperformance.googleapis.com", disabledBody("businessprofileperformance.googleapis.com")), { projectNumber: "42424242" });
    expect(msg).toMatch(/Business Profile Performance API não está ativa/);
    expect(msg).toContain("https://console.cloud.google.com/apis/library/businessprofileperformance.googleapis.com?project=42424242");
  });
  it("403 sem permissão de âmbito → religar; 403 genérico → conta Proprietária/Gestora; 401 → religar", () => {
    const scope = { error: { code: 403, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } };
    expect(diagnoseGbpError(parseGoogleErrorBody(403, "mybusiness.googleapis.com", scope))).toMatch(/business\.manage.*Volta a ligar/);
    expect(diagnoseGbpError(parseGoogleErrorBody(403, "mybusinessbusinessinformation.googleapis.com", { error: { status: "PERMISSION_DENIED" } }), { accountEmail: "marketing@multipark.pt" }))
      .toMatch(/marketing@multipark\.pt tem de ser Proprietária ou Gestora/);
    expect(diagnoseGbpError(parseGoogleErrorBody(401, "mybusinessaccountmanagement.googleapis.com", {}))).toMatch(/Volta a ligar a conta em Críticas/);
  });
  it("400 mostra só os campos recusados; 404 e 5xx têm mensagem própria", () => {
    const bad = { error: { code: 400, details: [{ "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field: "regular_hours.periods[0].close_time", description: "Invalid close time" }] }] } };
    expect(diagnoseGbpError(parseGoogleErrorBody(400, "mybusinessbusinessinformation.googleapis.com", bad))).toMatch(/recusou o pedido: regular_hours\.periods\[0\]\.close_time: Invalid close time/);
    expect(diagnoseGbpError(parseGoogleErrorBody(404, "businessprofileperformance.googleapis.com", null))).toMatch(/não encontrado/);
    expect(diagnoseGbpError(parseGoogleErrorBody(503, "businessprofileperformance.googleapis.com", null))).toMatch(/indisponível \(HTTP 503\)/);
  });
  it("n.º do projeto a partir do ID do cliente OAuth", () => {
    expect(projectNumberOfClientId("123456789012-abc123def.apps.googleusercontent.com")).toBe("123456789012");
    expect(projectNumberOfClientId("nada")).toBeNull();
  });
});

describe("cliente: erros, ritmo e repetição", () => {
  afterEach(() => vi.unstubAllGlobals());
  const resp = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(body == null ? "" : JSON.stringify(body), { status, headers });

  it("quota 0 → GbpApiError diagnosticado, sem repetir", async () => {
    const f = vi.fn(async () => resp(429, quotaBody("0")));
    vi.stubGlobal("fetch", f);
    const err = await new BusinessClient("t", { minIntervalMs: 0, deadlineAt: Date.now() + 60_000 }).accounts().catch((e) => e);
    expect(err).toBeInstanceOf(GbpApiError);
    expect(err.quotaZero).toBe(true);
    expect(err.isConfigError).toBe(true);
    expect(err.message).toContain(GBP_ACCESS_FORM_URL);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("limite de pedidos (quota > 0) → espera e repete dentro do prazo", async () => {
    const f = vi.fn().mockResolvedValueOnce(resp(429, quotaBody("300"), { "retry-after": "0" })).mockResolvedValueOnce(resp(200, { accounts: [{ name: "accounts/1" }] }));
    vi.stubGlobal("fetch", f);
    const r = await new BusinessClient("t", { minIntervalMs: 0, deadlineAt: Date.now() + 60_000 }).accounts();
    expect(r.accounts).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("pede as métricas diárias todas de uma vez e valida os nomes antes de sair", async () => {
    const f = vi.fn(async () => resp(200, {}));
    vi.stubGlobal("fetch", f);
    const c = new BusinessClient("t", { minIntervalMs: 0 });
    await c.performance("locations/77", "2026-09-01", "2026-09-07");
    const url = new URL(String((f.mock.calls[0] as any[])[0]));
    expect(url.host).toBe("businessprofileperformance.googleapis.com");
    expect(url.pathname).toBe("/v1/locations/77:fetchMultiDailyMetricsTimeSeries");
    expect(url.searchParams.getAll("dailyMetrics")).toContain("CALL_CLICKS");
    expect(url.searchParams.get("dailyRange.start_date.day")).toBe("1");
    expect(() => c.performance("locations/../x", "2026-09-01", "2026-09-07")).toThrow();
    expect(() => c.patchLocation("locations/77", "title", {})).toThrow(/Campos a alterar/);
    expect(() => c.deletePost("accounts/1/locations/2/localPosts/../x")).toThrow();
  });
});

describe("Testar (passo a passo)", () => {
  const conn = { status: "connected", scope: "https://www.googleapis.com/auth/business.manage openid email", accountEmail: "gbp@multipark.pt", refreshTokenEnc: "enc" };
  const quota0 = () => new GbpApiError(parseGoogleErrorBody(429, "mybusinessaccountmanagement.googleapis.com", quotaBody("0")), { projectNumber: "111222333" });
  const deps = (over: Partial<ReturnType<GbpTestDeps["client"]>> = {}, extra: Partial<GbpTestDeps> = {}): GbpTestDeps => ({
    connection: async () => conn,
    accessToken: async () => "tok",
    client: () => ({
      accounts: async () => ({ accounts: [{ name: "accounts/1" }] }),
      locations: async () => ({ locations: [{ name: "locations/9", title: "Redpark Lisboa" }] }),
      performanceProbe: async () => ({}),
      postsProbe: async () => ({}),
      ...over,
    }),
    clientId: "111222333-x1.apps.googleusercontent.com",
    clientIdSource: "GOOGLE_ADS_CLIENT_ID",
    ...extra,
  });
  it("tudo OK → uma linha por API com ✓ e as credenciais usadas", async () => {
    const msg = await testGoogleBusiness(deps());
    expect(msg).toMatch(/Conta gbp@multipark\.pt; credenciais OAuth partilhadas com o Google Ads \(GOOGLE_ADS_CLIENT_ID, projeto n\.º 111222333\)/);
    expect(msg).toMatch(/✓ My Business Account Management API: 1 conta/);
    expect(msg).toMatch(/✓ Business Profile Performance API: OK/);
    expect(msg).not.toMatch(/✗/);
  });
  it("quota 0 nas contas → falha com o pedido de acesso", async () => {
    await expect(testGoogleBusiness(deps({ accounts: async () => { throw quota0(); } }))).rejects.toThrow(/✗ My Business Account Management API: .*quota 0.*support\.google\.com\/business\/contact\/api_default/s);
  });
  it("sem contas / sem perfis → diz que conta Google ligar", async () => {
    await expect(testGoogleBusiness(deps({ accounts: async () => ({ accounts: [] }) }))).rejects.toThrow(/não gere nenhum perfil — liga a conta que é Proprietária\/Gestora/);
    await expect(testGoogleBusiness(deps({ locations: async () => ({ locations: [] }) }))).rejects.toThrow(/nenhum perfil nas contas/);
  });
  it("Performance API por ativar → falha só esse passo, com o link para a ativar", async () => {
    const off = new GbpApiError(parseGoogleErrorBody(403, "businessprofileperformance.googleapis.com", disabledBody("businessprofileperformance.googleapis.com")));
    const err = await testGoogleBusiness(deps({ performanceProbe: async () => { throw off; } })).catch((e) => e);
    expect(err.message).toMatch(/✓ My Business Business Information API/);
    expect(err.message).toMatch(/✗ Business Profile Performance API: .*apis\/library\/businessprofileperformance\.googleapis\.com/);
    expect(err.message).toMatch(/✓ Google My Business API/);
  });
  it("desligado / reautorização / token revogado → o que fazer", async () => {
    await expect(testGoogleBusiness(deps({}, { connection: async () => null }))).rejects.toThrow(/Não ligado: em Críticas/);
    await expect(testGoogleBusiness(deps({}, { connection: async () => ({ ...conn, status: "reauth_required" }) }))).rejects.toThrow(/expirou ou foi revogada/);
    await expect(testGoogleBusiness(deps({}, { connection: async () => ({ ...conn, scope: "openid email" }) }))).rejects.toThrow(/não inclui business\.manage/);
    await expect(testGoogleBusiness(deps({}, { accessToken: async () => { throw new Error("Autorização Google: invalid_grant. Volta a ligar a conta."); } }))).rejects.toThrow(/✗ Token: A autorização foi revogada/);
  });
});

// ─── Performance API: leitura, janelas e gravação idempotente ─────────────

const perfResponse = (from: string, days: string[], calls = 3) => ({
  multiDailyMetricTimeSeries: [{
    dailyMetricTimeSeries: [
      { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: days.map((d) => ({ date: { year: +d.slice(0, 4), month: +d.slice(5, 7), day: +d.slice(8, 10) }, value: String(calls) })) } },
      { dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_MAPS", timeSeries: { datedValues: [{ date: { year: +from.slice(0, 4), month: +from.slice(5, 7), day: +from.slice(8, 10) }, value: "120" }] } },
      { dailyMetric: "OUTRA_METRICA", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: "9" }] } },
    ],
  }],
});

describe("Performance API — leitura", () => {
  it("uma linha por dia do intervalo (0 onde a Google omite), ignora métricas desconhecidas", () => {
    const rows = parsePerformance(perfResponse("2026-09-01", ["2026-09-02"]), "2026-09-01", "2026-09-03");
    expect(rows.map((r) => r.day)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(rows[0].values).toMatchObject({ impMobileMaps: 120, callClicks: 0 });
    expect(rows[1].values.callClicks).toBe(3);
    expect(sumGbpValues(rows)).toMatchObject({ callClicks: 3, impMobileMaps: 120, bookings: 0 });
    expect(parsePerformance(null, "2026-09-01", "2026-09-01")).toHaveLength(1);
  });
  it("parâmetros: métricas repetidas e datas separadas", () => {
    const p = performanceParams("2026-03-05", "2026-04-06");
    expect(p.filter(([k]) => k === "dailyMetrics").map(([, v]) => v)).toEqual(expect.arrayContaining(["BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "WEBSITE_CLICKS", "BUSINESS_DIRECTION_REQUESTS", "BUSINESS_CONVERSATIONS", "BUSINESS_BOOKINGS"]));
    expect(Object.fromEntries(p.filter(([k]) => k.startsWith("dailyRange")))).toEqual({
      "dailyRange.start_date.year": "2026", "dailyRange.start_date.month": "3", "dailyRange.start_date.day": "5",
      "dailyRange.end_date.year": "2026", "dailyRange.end_date.month": "4", "dailyRange.end_date.day": "6",
    });
  });
  it("pesquisas: valor ou limiar (< 15), páginas e meses a recolher", () => {
    const r = parseKeywords({ searchKeywordsCounts: [{ searchKeyword: "estacionamento aeroporto lisboa", insightsValue: { value: "320" } }, { searchKeyword: "redpark", insightsValue: { threshold: "15" } }, { searchKeyword: " " }], nextPageToken: "p2" });
    expect(r.rows).toEqual([{ keyword: "estacionamento aeroporto lisboa", impressions: 320, threshold: null }, { keyword: "redpark", impressions: null, threshold: 15 }]);
    expect(r.nextPageToken).toBe("p2");
    expect(Object.fromEntries(keywordsParams("2026-08"))).toMatchObject({ "monthlyRange.start_month.month": "8", "monthlyRange.end_month.month": "8" });
    expect(keywordRowsToStore([{ keyword: "Redpark", impressions: 20, threshold: null }, { keyword: "redpark", impressions: 30, threshold: null }])).toHaveLength(1);
    // 180 dias a 25/09 → março..agosto (mais recente primeiro); agosto relido na 1.ª semana de setembro? (já passou: 25/09 → não).
    expect(keywordMonthsDue({}, "2026-09-25", 180)).toEqual(["2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03"]);
    expect(keywordMonthsDue({ "2026-08": "2026-09-01", "2026-07": "2026-08-01" }, "2026-09-03", 60)).toEqual(["2026-08"]);
    expect(keywordMonthsDue({ "2026-08": "2026-09-03", "2026-07": "2026-08-01" }, "2026-09-03", 60)).toEqual([]);
    expect(keywordMonthsDue({ "2026-08": "2026-09-08", "2026-07": "2026-08-01" }, "2026-09-10", 60)).toEqual([]);
  });
});

class MemGbpStore implements GbpStore {
  state = new Map<string, string>();
  daily = new Map<string, string>();
  keywords = new Map<string, string>();
  constructor(public locs: GbpLocationRow[]) {}
  async getState(k: string) { return this.state.get(k) ?? null; }
  async setState(k: string, v: string | null) { if (v == null) this.state.delete(k); else this.state.set(k, v); }
  async locations() { return this.locs; }
  async upsertDaily(id: number, rows: readonly GbpDayRow[]) { for (const r of rows) this.daily.set(`${id}|${r.day}`, JSON.stringify(r.values)); }
  async replaceKeywords(id: number, month: string, rows: any[]) { this.keywords.set(`${id}|${month}`, JSON.stringify(keywordRowsToStore(rows))); }
  snapshot() { return JSON.stringify([...this.daily.entries()].sort()); }
}
const loc = (id: number, patch: Partial<GbpLocationRow> = {}): GbpLocationRow => ({
  id, locationName: `locations/${id}00`, accountName: "accounts/1", title: `Parque ${id}`, address: "Lisboa", projectId: null, available: true,
  openStatus: "OPEN", hasVoiceOfMerchant: true, hasGoogleUpdated: false, hasPendingEdits: false, canOperateLocalPost: true, mapsUri: null, metaCheckedAt: null, ...patch,
});
// 25/09/2026 11:00 em Lisboa — depois da hora da atualização (08:00).
const NOW = Date.UTC(2026, 8, 25, 10, 0, 0);
const fakeApi = (calls: string[], opts: { fail?: unknown } = {}): GbpApiLike => ({
  async performance(l, f, t) {
    calls.push(`perf ${l} ${f} ${t}`);
    if (opts.fail) throw opts.fail;
    return perfResponse(f, [t]);
  },
  async keywords(l, m, p) {
    calls.push(`kw ${l} ${m} ${p}`);
    return { searchKeywordsCounts: [{ searchKeyword: `pesquisa ${m}`, insightsValue: { value: "10" } }], ...(p ? {} : { nextPageToken: "" }) };
  },
});

describe("recolha do desempenho (motor) com API falsa", () => {
  it("1.ª vez: ~6 meses em blocos de 90 dias; depois relê só os últimos 5 dias; reler não muda nada", async () => {
    const store = new MemGbpStore([loc(1), loc(2, { available: false })]);
    const calls: string[] = [];
    const cfg = gbpConfigSchema.parse({});
    const r1 = await runGbpInsightsCore(cfg, { api: fakeApi(calls), store, now: () => NOW }, { deadlineAt: NOW + 10 * 60_000 });
    expect(r1).toMatchObject({ ok: true, done: true, blocked: null, locations: 1 });
    const perf = calls.filter((c) => c.startsWith("perf"));
    // 180 dias até 23/09 (2 dias de atraso): 29/03 → 23/09, blocos de 90 dias, e a releitura do dia.
    expect(perf[0]).toBe("perf locations/100 2026-03-29 2026-06-26");
    expect(perf[1]).toBe("perf locations/100 2026-06-27 2026-09-23");
    expect(store.daily.has("1|2026-09-23")).toBe(true);
    expect(store.daily.has("1|2026-09-24")).toBe(false);
    expect([...store.daily.keys()].some((k) => k.startsWith("2|"))).toBe(false);
    expect(JSON.parse(store.state.get(gbpPerfKey(1))!)).toMatchObject({ coveredFrom: "2026-03-29", coveredTo: "2026-09-23", refreshedOn: "2026-09-25" });
    expect(JSON.parse(store.state.get(gbpKwKey(1))!)["2026-08"]).toBe("2026-09-25");
    const snap = store.snapshot();

    calls.length = 0;
    const r2 = await runGbpInsightsCore(cfg, { api: fakeApi(calls), store, now: () => NOW }, { deadlineAt: NOW + 10 * 60_000 });
    expect(r2.done).toBe(true);
    expect(calls).toEqual([]);

    // No dia seguinte (depois das 08:00): relê 19/09–24/09? não — 5 dias até ao último dia completo (24/09).
    const tomorrow = NOW + 86_400_000;
    await runGbpInsightsCore(cfg, { api: fakeApi(calls), store, now: () => tomorrow }, { deadlineAt: tomorrow + 10 * 60_000 });
    expect(calls.filter((c) => c.startsWith("perf"))).toEqual(["perf locations/100 2026-09-20 2026-09-24"]);
    // Reler a mesma janela é idempotente (mesmas linhas, mesmos valores).
    store.state.set(gbpPerfKey(1), JSON.stringify({ ...JSON.parse(store.state.get(gbpPerfKey(1))!), refreshedOn: "2026-09-25" }));
    const before = store.snapshot();
    await runGbpInsightsCore(cfg, { api: fakeApi([]), store, now: () => tomorrow }, { deadlineAt: tomorrow + 10 * 60_000 });
    expect(store.snapshot()).toBe(before);
    expect(snap.length).toBeGreaterThan(0);
  });

  it("antes da hora da atualização não relê; prazo curto pára antes de um pedido (done:false) e retoma", async () => {
    const early = Date.UTC(2026, 8, 25, 5, 0, 0); // 06:00 Lisboa
    const store = new MemGbpStore([loc(1)]);
    const calls: string[] = [];
    let t = early;
    const api: GbpApiLike = { performance: async (l, f, to) => { t += 20_000; return fakeApi(calls).performance(l, f, to); }, keywords: fakeApi(calls).keywords };
    const r = await runGbpInsightsCore(gbpConfigSchema.parse({ keywords: false }), { api, store, now: () => t }, { deadlineAt: early + 30_000 });
    expect(r.done).toBe(false);
    expect(calls).toHaveLength(1);
    t = early;
    const r2 = await runGbpInsightsCore(gbpConfigSchema.parse({ keywords: false }), { api, store, now: () => t }, { deadlineAt: early + 5 * 60_000 });
    expect(r2.done).toBe(true);
    expect(JSON.parse(store.state.get(gbpPerfKey(1))!).refreshedOn).toBeNull();
  });

  it("quota 0 / API por ativar: pára logo, guarda o diagnóstico e não insiste (done:true, ok:false)", async () => {
    const store = new MemGbpStore([loc(1), loc(3)]);
    const calls: string[] = [];
    const err = new GbpApiError(parseGoogleErrorBody(429, "businessprofileperformance.googleapis.com", quotaBody("0")));
    const r = await runGbpInsightsCore(DEFAULT_GBP_CONFIG, { api: fakeApi(calls, { fail: err }), store, now: () => NOW }, { deadlineAt: NOW + 60_000 });
    expect(r).toMatchObject({ ok: false, done: true });
    expect(r.blocked).toMatch(/quota 0/);
    expect(calls).toHaveLength(1);
    expect(store.state.get("gbp:lastError")).toMatch(/quota 0/);
    expect(store.state.has(gbpPerfKey(1))).toBe(false);
  });

  it("perfis desligados nas Definições ficam fora da recolha", () => {
    const cfg = gbpConfigSchema.parse({ locationMap: [{ locationName: "locations/100", active: false }] });
    expect(locationsToSync([loc(1), loc(2)], cfg).map((l) => l.id)).toEqual([2]);
  });
});

// ─── Cidade/marca e âmbito ──────────────────────────────────────────────────

describe("associação dos perfis a cidade/marca", () => {
  it("Definições > parque associado > morada/título", () => {
    expect(guessBrand("Redpark Lisboa — Aeroporto")).toBe("redpark");
    expect(guessBrand("MULTIBAGS Porto")).toBe("multibags");
    expect(guessBrand("Estacionamento")).toBeNull();
    const base = { locationName: "locations/1", title: "Skypark Faro", address: "Rua X, 8000-000 Faro" };
    expect(resolveLocationMapping(base, [])).toEqual({ city: "faro", brand: "skypark", active: true, source: "auto" });
    expect(resolveLocationMapping({ ...base, projectCity: "lisboa", projectBrand: "airpark" }, [])).toMatchObject({ city: "lisboa", brand: "airpark", source: "project" });
    expect(resolveLocationMapping(base, [{ locationName: "locations/1", city: "porto", brand: "", active: false }])).toEqual({ city: "porto", brand: "skypark", active: false, source: "manual" });
  });
  it("âmbito de cidade: quem só vê Porto não vê perfis de Lisboa nem sem cidade", () => {
    const r = (id: number, city: any): ResolvedLocation => ({ ...loc(id), city, brand: null, active: true, mappingSource: "auto" });
    const list = [r(1, "lisboa"), r(2, "porto"), r(3, null)];
    expect(scopeLocations(list, {}, null).map((l) => l.id)).toEqual([1, 2, 3]);
    expect(scopeLocations(list, {}, new Set(["porto"] as const)).map((l) => l.id)).toEqual([2]);
    expect(scopeLocations(list, { city: "lisboa" }, null).map((l) => l.id)).toEqual([1]);
  });
});

// ─── Horários ───────────────────────────────────────────────────────────────

const week = (patch: Partial<Record<string, Partial<DayHours>>> = {}): DayHours[] =>
  (["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const).map((day) => ({ day, mode: "intervals", intervals: [{ open: "08:00", close: "20:00" }], ...(patch[day] ?? {}) } as DayHours));

describe("horário normal e especiais", () => {
  it("constrói os períodos (24h, fecho depois da meia-noite) e volta a ler igual", () => {
    const w = week({ SATURDAY: { mode: "open24", intervals: [] }, SUNDAY: { mode: "closed", intervals: [] }, FRIDAY: { intervals: [{ open: "08:00", close: "12:30" }, { open: "22:00", close: "02:00" }] } });
    const r = buildRegularHours(w);
    expect(r.periods).toContainEqual({ openDay: "MONDAY", openTime: { hours: 8 }, closeDay: "MONDAY", closeTime: { hours: 20 } });
    expect(r.periods).toContainEqual({ openDay: "SATURDAY", openTime: {}, closeDay: "SATURDAY", closeTime: { hours: 24 } });
    expect(r.periods).toContainEqual({ openDay: "FRIDAY", openTime: { hours: 22 }, closeDay: "SATURDAY", closeTime: { hours: 2 } });
    expect(r.periods).toContainEqual({ openDay: "FRIDAY", openTime: { hours: 8 }, closeDay: "FRIDAY", closeTime: { hours: 12, minutes: 30 } });
    expect(r.periods.some((p) => p.openDay === "SUNDAY")).toBe(false);
    const back = parseRegularHours(r);
    expect(back.find((d) => d.day === "SATURDAY")?.mode).toBe("open24");
    expect(back.find((d) => d.day === "SUNDAY")?.mode).toBe("closed");
    expect(back.find((d) => d.day === "FRIDAY")?.intervals).toEqual([{ open: "08:00", close: "12:30" }, { open: "22:00", close: "02:00" }]);
  });
  it("recusa horas inválidas, sobrepostas, iguais e o horário todo fechado", () => {
    expect(() => buildRegularHours(week({ MONDAY: { intervals: [{ open: "8h", close: "20:00" }] } }))).toThrow(GbpValidationError);
    expect(() => buildRegularHours(week({ MONDAY: { intervals: [{ open: "08:00", close: "14:00" }, { open: "13:00", close: "20:00" }] } }))).toThrow(/sobrepostos/);
    expect(() => buildRegularHours(week({ MONDAY: { intervals: [{ open: "08:00", close: "08:00" }] } }))).toThrow(/iguais/);
    expect(() => buildRegularHours(week({ MONDAY: { intervals: [] } }))).toThrow(/pelo menos um intervalo/);
    expect(() => buildRegularHours(week().map((d) => ({ ...d, mode: "closed" as const, intervals: [] })))).toThrow(/todo fechado/);
    expect(() => buildRegularHours([...week(), { day: "MONDAY", mode: "closed", intervals: [] }])).toThrow(/repetido/);
  });
  it("especiais: fechado, aberto com horas, passado/repetido recusados; juntar sem apagar os outros", () => {
    const s = buildSpecialHours([{ date: "2026-12-25", closed: true, intervals: [] }, { date: "2026-12-24", closed: false, intervals: [{ open: "08:00", close: "14:00" }] }], "2026-09-25");
    expect(s.specialHourPeriods).toEqual([
      { startDate: { year: 2026, month: 12, day: 24 }, openTime: { hours: 8 }, endDate: { year: 2026, month: 12, day: 24 }, closeTime: { hours: 14 } },
      { startDate: { year: 2026, month: 12, day: 25 }, closed: true },
    ]);
    expect(parseSpecialHours(s)).toEqual([{ date: "2026-12-24", closed: false, intervals: [{ open: "08:00", close: "14:00" }] }, { date: "2026-12-25", closed: true, intervals: [] }]);
    expect(() => buildSpecialHours([{ date: "2026-09-01", closed: true, intervals: [] }], "2026-09-25")).toThrow(/passado/);
    expect(() => buildSpecialHours([{ date: "2026-12-25", closed: true, intervals: [] }, { date: "2026-12-25", closed: true, intervals: [] }], "2026-09-25")).toThrow(/repetido/);
    expect(() => buildSpecialHours([{ date: "2026-02-30", closed: true, intervals: [] }], "2026-01-01")).toThrow(/inválida/);
    expect(() => buildSpecialHours([{ date: "2026-12-25", closed: true, intervals: [{ open: "08:00", close: "10:00" }] }], "2026-09-25")).toThrow(/não leva horas/);
    const merged = mergeSpecialDays(
      [{ date: "2026-09-01", closed: true, intervals: [] }, { date: "2026-12-08", closed: true, intervals: [] }, { date: "2026-12-25", closed: false, intervals: [{ open: "09:00", close: "12:00" }] }],
      [{ date: "2026-12-25", closed: true, intervals: [] }, { date: "2027-01-01", closed: true, intervals: [] }], ["2026-12-08"], "2026-09-25");
    expect(merged.map((d) => `${d.date}:${d.closed}`)).toEqual(["2026-12-25:true", "2027-01-01:true"]);
  });
  it("patch: updateMask só com o que muda; nada → erro", () => {
    expect(buildHoursPatch({ regular: week(), today: "2026-09-25" }).updateMask).toBe("regularHours");
    const both = buildHoursPatch({ regular: week(), special: [], today: "2026-09-25" });
    expect(both.updateMask).toBe("regularHours,specialHours");
    expect(both.body.specialHours).toEqual({ specialHourPeriods: [] });
    expect(() => buildHoursPatch({ today: "2026-09-25" })).toThrow(/Nada para alterar/);
  });
  it("aplicar a vários perfis: valida antes de mexer, junta os especiais de cada um e regista", async () => {
    const patches: any[] = [];
    const client = {
      getHours: async (l: string) => ({ specialHours: { specialHourPeriods: l === "locations/100" ? [{ startDate: { year: 2026, month: 12, day: 8 }, closed: true }] : [] } }),
      patchLocation: async (l: string, mask: string, body: any) => { if (l === "locations/200") throw new GbpApiError(parseGoogleErrorBody(403, "mybusinessbusinessinformation.googleapis.com", { error: {} })); patches.push({ l, mask, body }); return {}; },
    };
    const logs: string[] = [];
    const locs = [loc(1), loc(2)].map((x) => ({ id: x.id, locationName: x.locationName, accountName: x.accountName, title: x.title }));
    await expect(realApplyHours(client as any, locs, { special: [{ date: "2020-01-01", closed: true, intervals: [] }], today: "2026-09-25" }, async (d) => { logs.push(d); })).rejects.toThrow(/passado/);
    expect(patches).toEqual([]);
    const res = await realApplyHours(client as any, locs, { special: [{ date: "2026-12-25", closed: true, intervals: [] }], today: "2026-09-25" }, async (d) => { logs.push(d); });
    expect(res.map((r) => r.ok)).toEqual([true, false]);
    expect(res[1].error).toMatch(/Proprietária ou Gestora/);
    expect(patches[0]).toMatchObject({ l: "locations/100", mask: "specialHours" });
    expect(patches[0].body.specialHours.specialHourPeriods.map((p: any) => p.startDate.day)).toEqual([8, 25]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/horários especiais \(2026-12-25\).*Parque 1/);
  });
});

// ─── Publicações ────────────────────────────────────────────────────────────

describe("publicações (v4 localPosts)", () => {
  it("Novidade com botão e imagem", () => {
    expect(buildLocalPost({ summary: "Parque coberto aberto 24h.", ctaType: "BOOK", ctaUrl: "https://multipark.pt/reservar", imageUrl: "https://multipark.pt/a.jpg" })).toEqual({
      languageCode: "pt-PT", summary: "Parque coberto aberto 24h.", topicType: "STANDARD",
      callToAction: { actionType: "BOOK", url: "https://multipark.pt/reservar" },
      media: [{ mediaFormat: "PHOTO", sourceUrl: "https://multipark.pt/a.jpg" }],
    });
  });
  it("Ligar não leva endereço; os outros botões precisam de https", () => {
    expect(buildLocalPost({ summary: "Ligue-nos", ctaType: "CALL" }).callToAction).toEqual({ actionType: "CALL" });
    expect(() => buildLocalPost({ summary: "x", ctaType: "CALL", ctaUrl: "https://a.pt" })).toThrow(/Ligar/);
    expect(() => buildLocalPost({ summary: "x", ctaType: "LEARN_MORE" })).toThrow(/https/);
    expect(() => buildLocalPost({ summary: "x", ctaType: "LEARN_MORE", ctaUrl: "http://a.pt" })).toThrow(/https/);
    expect(() => buildLocalPost({ summary: "" })).toThrow(/texto/);
    expect(() => buildLocalPost({ summary: "x".repeat(1501) })).toThrow(/1500/);
  });
  it("Evento e Oferta: título e datas obrigatórios; horas em par; campos de oferta só em ofertas", () => {
    const ev = buildLocalPost({ topicType: "EVENT", summary: "Natal", eventTitle: "Natal no aeroporto", startDate: "2026-12-20", endDate: "2026-12-26", startTime: "08:00", endTime: "20:00" });
    expect(ev.event).toEqual({ title: "Natal no aeroporto", schedule: { startDate: { year: 2026, month: 12, day: 20 }, endDate: { year: 2026, month: 12, day: 26 }, startTime: { hours: 8, minutes: 0 }, endTime: { hours: 20, minutes: 0 } } });
    expect(() => buildLocalPost({ topicType: "OFFER", summary: "x" })).toThrow(/título/);
    expect(() => buildLocalPost({ topicType: "OFFER", summary: "x", eventTitle: "t", startDate: "2026-12-20" })).toThrow(/datas/);
    expect(() => buildLocalPost({ topicType: "EVENT", summary: "x", eventTitle: "t", startDate: "2026-12-20", endDate: "2026-12-19" })).toThrow(/depois/);
    expect(() => buildLocalPost({ topicType: "EVENT", summary: "x", eventTitle: "t", startDate: "2026-12-20", endDate: "2026-12-20", startTime: "08:00" })).toThrow(/duas horas/);
    const offer = buildLocalPost({ topicType: "OFFER", summary: "10% off", eventTitle: "Outono", startDate: "2026-10-01", endDate: "2026-10-31", couponCode: "OUT10", redeemUrl: "https://multipark.pt/p" });
    expect(offer.offer).toEqual({ couponCode: "OUT10", redeemOnlineUrl: "https://multipark.pt/p" });
    expect(() => buildLocalPost({ summary: "x", couponCode: "A" })).toThrow(/só se usam em Ofertas/);
    expect(() => buildLocalPost({ summary: "x", eventTitle: "A" })).toThrow(/Eventos e Ofertas/);
  });
  it("publicar em vários perfis (valida uma vez) e apagar só do próprio perfil", async () => {
    const created: string[] = [];
    const client = { createPost: async (a: string, l: string) => { created.push(`${a}/${l}`); return { name: `${a}/${l}/localPosts/abc` }; }, deletePost: vi.fn(async () => ({})) };
    const logs: string[] = [];
    const locs = [loc(1), loc(2)].map((x) => ({ id: x.id, locationName: x.locationName, accountName: x.accountName, title: x.title }));
    await expect(realCreatePosts(client as any, locs, { summary: "" }, async (d) => { logs.push(d); })).rejects.toThrow();
    expect(created).toEqual([]);
    const r = await realCreatePosts(client as any, locs, { summary: "Olá" }, async (d) => { logs.push(d); });
    expect(r.every((x) => x.ok)).toBe(true);
    expect(created).toEqual(["accounts/1/locations/100", "accounts/1/locations/200"]);
    expect(logs).toHaveLength(2);
    await expect(realDeletePost(client as any, locs[0], "accounts/1/locations/200/localPosts/abc", async () => {})).rejects.toThrow(/não pertence/);
    await realDeletePost(client as any, locs[0], "accounts/1/locations/100/localPosts/abc", async (d) => { logs.push(d); });
    expect(client.deletePost).toHaveBeenCalledWith("accounts/1/locations/100/localPosts/abc");
    expect(parsePosts({ localPosts: [{ name: "accounts/1/locations/100/localPosts/abc", summary: "Olá", state: "LIVE", topicType: "STANDARD", callToAction: { actionType: "BOOK" } }] })[0]).toMatchObject({ ctaType: "BOOK", state: "LIVE" });
  });
});

// ─── Críticas: KPIs ─────────────────────────────────────────────────────────

describe("KPIs das críticas", () => {
  it("média, taxa e mediana do tempo de resposta; semanas", () => {
    const k = reviewKpis([
      { rating: 5, reviewDate: "2026-09-01 10:00:00", respondedAt: "2026-09-01 12:00:00", hasReply: true },
      { rating: 1, reviewDate: "2026-09-02 10:00:00", respondedAt: "2026-09-03 10:00:00", hasReply: true },
      { rating: 4, reviewDate: "2026-09-08 10:00:00", respondedAt: null, hasReply: false },
    ]);
    expect(k).toMatchObject({ count: 3, avgRating: 3.33, responded: 2, medianResponseHours: 13 });
    expect(k.responseRate).toBeCloseTo(2 / 3);
    expect(k.distribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 1, 5: 1 });
    expect(reviewKpis([])).toMatchObject({ count: 0, avgRating: null, responseRate: null, medianResponseHours: null });
    expect(ratingByWeek([{ rating: 5, reviewDate: "2026-09-01 10:00:00", respondedAt: null, hasReply: false }, { rating: 3, reviewDate: "2026-09-06 10:00:00", respondedAt: null, hasReply: false }]))
      .toEqual([{ week: "2026-08-31", count: 2, avg: 4 }]);
  });
});

// ─── Alertas ────────────────────────────────────────────────────────────────

describe("alertas Google Business", () => {
  const base = (patch: Partial<GbpAlertInputs["locations"][number]> = {}): GbpAlertInputs => ({
    today: "2026-09-25", weekEnd: "2026-09-23", thresholds: DEFAULT_GBP_CONFIG.alerts,
    locations: [{ id: 1, label: "Redpark Lisboa", city: "lisboa", ...patch }],
  });
  it("estrelas a cair (7 dias vs 90) só com críticas suficientes", () => {
    expect(evaluateGbpAlerts(base({ ratings: { last7Avg: 3.8, last7Count: 4, baseAvg: 4.6, baseCount: 40 } }))[0]).toMatchObject({ code: "rating_drop", channel: "reviews", level: "warning", city: "lisboa" });
    expect(evaluateGbpAlerts(base({ ratings: { last7Avg: 3.5, last7Count: 4, baseAvg: 4.6, baseCount: 40 } }))[0].level).toBe("critical");
    expect(evaluateGbpAlerts(base({ ratings: { last7Avg: 2, last7Count: 2, baseAvg: 4.6, baseCount: 40 } }))).toEqual([]);
    expect(evaluateGbpAlerts(base({ ratings: { last7Avg: 4.3, last7Count: 5, baseAvg: 4.6, baseCount: 40 } }))).toEqual([]);
  });
  it("críticas sem resposta há mais de N horas", () => {
    expect(evaluateGbpAlerts(base({ unanswered: { count: 2, oldestHours: 50 } }))[0]).toMatchObject({ code: "unanswered_reviews", level: "warning" });
    expect(evaluateGbpAlerts(base({ unanswered: { count: 2, oldestHours: 200 } }))[0].level).toBe("critical");
    expect(evaluateGbpAlerts(base({ unanswered: { count: 2, oldestHours: 10 } }))).toEqual([]);
  });
  it("impressões/chamadas −30% semana a semana, com bases mínimas e semanas completas", () => {
    const w = (ci: number, pi: number, cc: number, pc: number, days = 7) => ({ week: { cur: { impressions: ci, calls: cc, days }, prev: { impressions: pi, calls: pc, days: 7 } } });
    expect(evaluateGbpAlerts(base(w(600, 1000, 6, 10))).map((a) => a.code)).toEqual(["impressions_drop", "calls_drop"]);
    expect(evaluateGbpAlerts(base(w(800, 1000, 8, 10)))).toEqual([]);
    expect(evaluateGbpAlerts(base(w(60, 100, 1, 5)))).toEqual([]); // abaixo das bases
    expect(evaluateGbpAlerts(base(w(100, 1000, 0, 10, 5)))).toEqual([]); // semana incompleta
    expect(evaluateGbpAlerts(base(w(100, 1000, 6, 10)))[0].level).toBe("critical");
  });
  it("perfil suspenso/sem verificação, fechado, alterado pela Google, edições pendentes", () => {
    const st = (s: any) => evaluateGbpAlerts(base({ status: { openStatus: "OPEN", hasVoiceOfMerchant: true, hasGoogleUpdated: false, hasPendingEdits: false, ...s } }));
    expect(st({})).toEqual([]);
    expect(st({ hasVoiceOfMerchant: false })[0]).toMatchObject({ code: "profile_status", level: "critical", channel: "business" });
    expect(st({ hasGoogleUpdated: true, hasPendingEdits: true })[0].detail).toMatch(/a Google alterou.*edições pendentes/);
    expect(evaluateGbpAlerts({ ...base({ status: { openStatus: "CLOSED_PERMANENTLY", hasVoiceOfMerchant: true, hasGoogleUpdated: false, hasPendingEdits: false } }), thresholds: { ...DEFAULT_GBP_CONFIG.alerts, profileStatus: false } })).toEqual([]);
    expect(evaluateGbpAlerts({ ...base({ unanswered: { count: 9, oldestHours: 999 } }), thresholds: { ...DEFAULT_GBP_CONFIG.alerts, enabled: false } })).toEqual([]);
  });
});

describe("negócio: ações Google vs reservas por cidade", () => {
  it("junta por cidade × dia", () => {
    const actions = new Map([["lisboa" as const, new Map([["2026-09-01", { calls: 4, directions: 6, website: 3 }]])]]);
    const bookings = new Map([["lisboa" as const, new Map([["2026-09-01", 5], ["2026-09-02", 5]])], ["porto" as const, new Map([["2026-09-02", 2]])]]);
    const r = gbpBusinessByCity(["2026-09-01", "2026-09-02"], actions, bookings);
    expect(r.map((c) => c.city)).toEqual(["lisboa", "porto"]);
    expect(r[0]).toMatchObject({ calls: 4, directions: 6, website: 3, bookings: 10, actionsPerBooking: 1 });
    expect(r[1]).toMatchObject({ calls: 0, bookings: 2, actionsPerBooking: 0 });
  });
});

// ─── Catálogo, migração ─────────────────────────────────────────────────────

describe("catálogo e migração 0170", () => {
  it("definição só super admin, IA lite com interruptor, dois tipos de notificação", () => {
    expect(SETTINGS["marketing.googleBusiness"].group).toBe("marketing");
    expect(validateSetting("marketing.googleBusiness", { backfillDays: 10 }).ok).toBe(false);
    expect(validateSetting("marketing.googleBusiness", { locationMap: [{ locationName: "locations/1", city: "porto" }] }).ok).toBe(true);
    expect(validateSetting("marketing.googleBusiness", { locationMap: [{ locationName: "accounts/1" }] }).ok).toBe(false);
    expect(AI_FEATURES.gbp_post_draft).toMatchObject({ flag: "AI_GBP_POSTS", tier: "lite" });
    expect(AI_FEATURES.pagespeed_explain).toMatchObject({ flag: "AI_PAGESPEED_EXPLAIN", tier: "lite" });
    expect(AUTOMATION_FLAGS.some((f) => f.name === "AI_GBP_POSTS")).toBe(true);
    expect(kindDef("google_reviews_alert")).toMatchObject({ module: "criticas", cityScoped: true, personal: false });
    expect(kindDef("google_business_alert")).toMatchObject({ module: "marketing", cityScoped: false });
  });
  it("migração idempotente: CREATE IF NOT EXISTS / ADD COLUMN (duplicados ignorados)", () => {
    for (const s of MIGRATION_0170_STATEMENTS) expect(/^(CREATE TABLE IF NOT EXISTS|ALTER TABLE `google_business_locations` ADD COLUMN)/.test(s)).toBe(true);
    expect(MIGRATION_0170_STATEMENTS.join(" ")).toMatch(/UNIQUE KEY `uq_gbp_daily_metrics` \(`locationId`, `day`\)/);
    expect(MIGRATION_0170_STATEMENTS.join(" ")).toMatch(/UNIQUE KEY `uq_web_crux_records` \(`targetHash`, `formFactor`, `periodEnd`\)/);
  });
});

// ─── Acessos (Marketing — só super_admin; escrita = gerir; nada alargado) ───

const caller = (role = "super_admin") => appRouter.createCaller({ user: { id: 7, role }, req: { headers: {} }, res: {} } as any);
const rloc = (id: number, city: any = "lisboa"): ResolvedLocation => ({ ...loc(id), city, brand: "redpark", active: true, mappingSource: "auto" });

describe("marketing.gbp — permissões", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.config.mockResolvedValue(DEFAULT_GBP_CONFIG);
    h.resolved.mockResolvedValue([rloc(1), rloc(2, "porto")]);
    h.setSetting.mockResolvedValue({ changed: true, value: {} });
    h.clientFor.mockResolvedValue({});
    h.applyHours.mockResolvedValue([{ locationId: 1, title: "Parque 1", ok: true, error: null }]);
    h.createPosts.mockResolvedValue([{ locationId: 1, title: "Parque 1", ok: true, error: null, name: "x" }]);
    h.runSync.mockResolvedValue({ ok: true, done: true, blocked: null, errors: [], warnings: [], windows: 1, keywordMonths: 0 });
  });
  const regular = week();

  it("sem o módulo Marketing: nem ver nem mexer (nada chega à Google)", async () => {
    for (const role of ["admin", "backoffice", "supervisor", "team_leader", "extra"]) {
      await expect(caller(role).marketing.gbp.overview({ from: "2026-09-01", to: "2026-09-24" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).marketing.gbp.hours.save({ locationIds: [1], regular })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).marketing.gbp.posts.create({ locationIds: [1], post: { summary: "x" } as any })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).marketing.gbp.posts.remove({ locationId: 1, name: "accounts/1/locations/100/localPosts/a" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).marketing.gbp.settings.save({} as any)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(role).marketing.gbp.settings.runNow()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(h.applyHours).not.toHaveBeenCalled();
    expect(h.createPosts).not.toHaveBeenCalled();
    expect(h.deletePost).not.toHaveBeenCalled();
    expect(h.setSetting).not.toHaveBeenCalled();
    expect(h.runSync).not.toHaveBeenCalled();
  });

  it("super admin: horários em vários perfis (registado), publicações, definições e recolha", async () => {
    const r = await caller().marketing.gbp.hours.save({ locationIds: [1, 2], regular });
    expect(r.ok).toBe(true);
    expect(h.applyHours).toHaveBeenCalledWith({}, [expect.objectContaining({ id: 1 }), expect.objectContaining({ id: 2 })], expect.objectContaining({ regular }), expect.any(Function));
    await caller().marketing.gbp.posts.create({ locationIds: [1], post: { summary: "Olá" } as any });
    expect(h.createPosts).toHaveBeenCalled();
    await caller().marketing.gbp.settings.save({ locationMap: [{ locationName: "locations/100", city: "porto" }] } as any);
    expect(h.setSetting).toHaveBeenCalledWith("marketing.googleBusiness", expect.objectContaining({ locationMap: [expect.objectContaining({ city: "porto", active: true })] }), 7);
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ entity: "google_business_location", userId: 7 }));
    await caller().marketing.gbp.settings.runNow();
    expect(h.runSync).toHaveBeenCalled();
  });

  it("perfil inexistente/fora do âmbito → FORBIDDEN; validação dos pedidos", async () => {
    await expect(caller().marketing.gbp.hours.save({ locationIds: [99], regular })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller().marketing.gbp.hours.save({ locationIds: [], regular })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().marketing.gbp.overview({ from: "2026-09-10", to: "2026-09-01" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.applyHours).not.toHaveBeenCalled();
  });

  it("a definição genérica também é só do super admin", async () => {
    await expect(caller("admin").settings.values.set({ key: "marketing.googleBusiness", value: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
