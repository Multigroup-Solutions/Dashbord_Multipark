/**
 * Velocidade (Web & SEO): Chrome UX Report (dados reais), "o que corrigir
 * primeiro" (oportunidades Lighthouse), páginas em lote e alertas CrUX —
 * com APIs FALSAS.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WEB_ANALYTICS_CONFIG, brandOfUrl, cruxDue, cruxLevel, cruxTargets, evaluateWebAlerts, extractLighthouseAudits, parseBulkUrls, parseCruxHistory,
  rankFixFirst, webAnalyticsConfigSchema, type AlertInputs, type CruxPeriodRow, type LighthouseAudit,
} from "../shared/webAnalytics";
import { cruxApi, cruxErrorMessage } from "./webAnalytics/apis";
import { cruxRowToStore } from "./webAnalytics/store";
import { runWebAnalyticsCore } from "./webAnalytics/sync";
import type { WebStore } from "./webAnalytics/store";

const HISTORY = {
  record: {
    key: { origin: "https://multipark.pt", formFactor: "PHONE" },
    metrics: {
      largest_contentful_paint: {
        histogramTimeseries: [{ start: 0, end: 2500, densities: [0.7, 0.62] }, { start: 2500, end: 4000, densities: [0.2, 0.25] }, { start: 4000, densities: [0.1, 0.13] }],
        percentilesTimeseries: { p75s: [2300, 2750] },
      },
      cumulative_layout_shift: {
        histogramTimeseries: [{ start: "0.00", end: "0.10", densities: [0.9, "NaN"] }, { start: "0.10", end: "0.25", densities: [0.05, "NaN"] }, { start: "0.25", densities: [0.05, "NaN"] }],
        percentilesTimeseries: { p75s: ["0.05", null] },
      },
      interaction_to_next_paint: { percentilesTimeseries: { p75s: [180, 240] } },
      experimental_time_to_first_byte: { percentilesTimeseries: { p75s: [700, 900] } },
    },
    collectionPeriods: [
      { firstDate: { year: 2026, month: 8, day: 10 }, lastDate: { year: 2026, month: 9, day: 6 } },
      { firstDate: { year: 2026, month: 8, day: 17 }, lastDate: { year: 2026, month: 9, day: 13 } },
    ],
  },
};

describe("Chrome UX Report — leitura", () => {
  it("histórico: p75 e distribuição por período; NaN/null → sem valor", () => {
    const rows = parseCruxHistory(HISTORY);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ periodStart: "2026-08-10", periodEnd: "2026-09-06", p75: { lcp: 2300, cls: 0.05, inp: 180, ttfb: 700, fcp: null } });
    expect(rows[0].dist.lcp).toEqual({ good: 0.7, ni: 0.2, poor: 0.1 });
    expect(rows[1].p75).toMatchObject({ lcp: 2750, inp: 240, cls: null });
    expect(rows[1].dist.cls).toBeNull();
    expect(cruxRowToStore(rows[0])).toMatchObject({ lcpP75: 2300, lcpGood: 0.7, clsP75: 0.05, ttfbP75: 700, fcpGood: null });
  });
  it("também lê o queryRecord (um período) e ignora respostas vazias", () => {
    const one = parseCruxHistory({ record: { metrics: { largest_contentful_paint: { histogram: [{ density: 0.8 }, { density: 0.15 }, { density: 0.05 }], percentiles: { p75: 1900 } } },
      collectionPeriod: { firstDate: { year: 2026, month: 8, day: 1 }, lastDate: { year: 2026, month: 8, day: 28 } } } });
    expect(one).toEqual([expect.objectContaining({ periodEnd: "2026-08-28", p75: expect.objectContaining({ lcp: 1900 }), dist: expect.objectContaining({ lcp: { good: 0.8, ni: 0.15, poor: 0.05 } }) })]);
    expect(parseCruxHistory({})).toEqual([]);
    expect(parseCruxHistory(null)).toEqual([]);
  });
  it("limiares Google (verde/âmbar/vermelho)", () => {
    expect(cruxLevel("lcp", 2500)).toBe("good");
    expect(cruxLevel("lcp", 2501)).toBe("needs_improvement");
    expect(cruxLevel("inp", 600)).toBe("poor");
    expect(cruxLevel("cls", 0.1)).toBe("good");
    expect(cruxLevel("ttfb", null)).toBeNull();
  });
  it("alvos: a origem de cada página (uma vez) e a página; 1×/semana por dispositivo", () => {
    const t = cruxTargets([{ url: "https://multipark.pt/", label: "Início" }, { url: "https://multipark.pt/reservar", label: "Reservar", keyUrl: false }, { url: "https://redpark.pt/", label: "Redpark" }]);
    expect(t.map((x) => `${x.type}:${x.target}`)).toEqual(["origin:https://multipark.pt", "url:https://multipark.pt/", "url:https://multipark.pt/reservar", "origin:https://redpark.pt", "url:https://redpark.pt/"]);
    expect(t.find((x) => x.target === "https://multipark.pt/reservar")?.keyUrl).toBe(false);
    const checked = new Map([["origin:https://multipark.pt:PHONE", "2026-09-24"], ["origin:https://multipark.pt:DESKTOP", "2026-09-18"]]);
    const due = cruxDue(t.slice(0, 1), checked, "2026-09-25");
    expect(due.map((d) => d.formFactor)).toEqual(["DESKTOP"]);
  });
  it("erros da API sem a chave; 404 = sem dados", async () => {
    expect(cruxErrorMessage(403, { error: { details: [{ reason: "SERVICE_DISABLED" }] } })).toMatch(/Chrome UX Report API não está ativa/);
    expect(cruxErrorMessage(400, { error: { details: [{ reason: "API_KEY_INVALID" }] } })).toMatch(/Chave de API inválida/);
    expect(cruxApi({})).toBeNull();
    const f = vi.fn().mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", details: [{ reason: "API_KEY_SERVICE_BLOCKED" }] } }), { status: 403 }));
    const api = cruxApi({ GOOGLE_CRUX_API_KEY: "segredo-da-chave" }, f as any)!;
    expect(await api.history({ type: "url", target: "https://multipark.pt/" }, "PHONE", 5_000)).toBeNull();
    const body = JSON.parse(String((f.mock.calls[0] as any[])[1].body));
    expect(body).toMatchObject({ url: "https://multipark.pt/", formFactor: "PHONE" });
    const err = await api.history({ type: "origin", target: "https://multipark.pt" }, "PHONE", 5_000).catch((e) => e);
    expect(err.message).toMatch(/restrita/);
    expect(err.message).not.toContain("segredo-da-chave");
  });
});

// ─── Lighthouse ─────────────────────────────────────────────────────────────

const LH = {
  lighthouseResult: {
    categories: { performance: { score: 0.55, auditRefs: [
      { id: "largest-contentful-paint", group: "metrics" },
      { id: "render-blocking-resources", group: "load-opportunities" },
      { id: "uses-optimized-images", group: "load-opportunities" },
      { id: "lcp-discovery-insight", group: "insights" },
      { id: "dom-size" , group: "diagnostics" },
      { id: "uses-http2", group: "load-opportunities" },
      { id: "screenshot-thumbnails", group: "hidden" },
      { id: "third-party-summary", group: "diagnostics" },
    ] } },
    audits: {
      "largest-contentful-paint": { score: 0.2, scoreDisplayMode: "numeric", numericValue: 5200, title: "Largest Contentful Paint" },
      "render-blocking-resources": { title: "Eliminate render-blocking resources", score: 0.3, scoreDisplayMode: "metricSavings", displayValue: "Potential savings of 1,210 ms", details: { type: "opportunity", overallSavingsMs: 1210.4, overallSavingsBytes: 0 } },
      "uses-optimized-images": { title: "Efficiently encode [images](https://web.dev/x)", score: 0.5, scoreDisplayMode: "metricSavings", details: { type: "opportunity", overallSavingsMs: 300, overallSavingsBytes: 845_000 } },
      "lcp-discovery-insight": { title: "LCP request discovery", score: 0, scoreDisplayMode: "metricSavings", metricSavings: { LCP: 1800, FCP: 0 }, details: { type: "checklist" } },
      "dom-size": { title: "Avoid an excessive DOM size", score: 0.4, scoreDisplayMode: "numeric", displayValue: "1,900 elements", details: { type: "table" } },
      "uses-http2": { title: "Use HTTP/2", score: 1, scoreDisplayMode: "metricSavings", details: { type: "opportunity", overallSavingsMs: 0 } },
      "third-party-summary": { title: "Minimize third-party usage", score: null, scoreDisplayMode: "informative" },
    },
  },
};

describe("o que corrigir primeiro (Lighthouse)", () => {
  it("só os que falharam, sem métricas/ocultos/informativos; poupança por overallSavings ou metricSavings", () => {
    const a = extractLighthouseAudits(LH);
    expect(a.map((x) => x.id)).toEqual(["lcp-discovery-insight", "render-blocking-resources", "uses-optimized-images", "dom-size"]);
    expect(a[0]).toMatchObject({ kind: "opportunity", savingsMs: 1800, savingsBytes: null });
    expect(a[1]).toMatchObject({ savingsMs: 1210, savingsBytes: null, displayValue: "Potential savings of 1,210 ms" });
    expect(a[2]).toMatchObject({ title: "Efficiently encode images", savingsBytes: 845_000 });
    expect(a[3]).toMatchObject({ kind: "diagnostic", savingsMs: null, displayValue: "1,900 elements" });
    expect(extractLighthouseAudits(LH, 2)).toHaveLength(2);
    expect(extractLighthouseAudits({})).toEqual([]);
  });
  it("ordem: oportunidades por ms, depois bytes; diagnósticos no fim pela pior pontuação", () => {
    const x = (id: string, kind: LighthouseAudit["kind"], savingsMs: number | null, savingsBytes: number | null, score: number): LighthouseAudit => ({ id, kind, title: id, displayValue: null, savingsMs, savingsBytes, score });
    expect(rankFixFirst([x("d1", "diagnostic", null, null, 0.8), x("o1", "opportunity", null, 5000, 0.5), x("o2", "opportunity", 200, null, 0.5), x("d2", "diagnostic", null, null, 0.1)]).map((a) => a.id))
      .toEqual(["o2", "o1", "d2", "d1"]);
  });
});

// ─── Páginas em lote e marca pelo domínio ───────────────────────────────────

describe("PageSpeed: várias páginas de uma vez", () => {
  it("uma por linha, nome opcional, sem repetidas nem as que já existem; marca pelo domínio", () => {
    const r = parseBulkUrls("https://redpark.pt/reservar | Redpark — reserva\n\nnão é url\nhttps://multipark.pt/\nhttps://skypark.pt/booking\nhttps://skypark.pt/booking", ["https://multipark.pt/"]);
    expect(r.add).toEqual([
      { url: "https://redpark.pt/reservar", label: "Redpark — reserva", brand: "redpark" },
      { url: "https://skypark.pt/booking", label: "", brand: "skypark" },
    ]);
    expect(r.rejected).toEqual(["não é url"]);
    expect(brandOfUrl("https://www.multibags.pt/x")).toBe("multibags");
    expect(brandOfUrl("https://exemplo.pt/")).toBeNull();
  });
  it("até 40 páginas; 'chave' por omissão; CrUX ligado por omissão", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ url: `https://multipark.pt/p${i}` }));
    const ok = webAnalyticsConfigSchema.safeParse({ pagespeedUrls: many });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.pagespeedUrls[0].keyUrl).toBe(true);
    expect(webAnalyticsConfigSchema.safeParse({ pagespeedUrls: [...many, { url: "https://multipark.pt/x" }] }).success).toBe(false);
    expect(DEFAULT_WEB_ANALYTICS_CONFIG.cruxEnabled).toBe(true);
    expect(DEFAULT_WEB_ANALYTICS_CONFIG.alerts).toMatchObject({ cruxEnabled: true, cruxLcpMs: 2500, cruxInpMs: 200, cruxCls: 0.1 });
  });
});

// ─── Alertas CrUX ───────────────────────────────────────────────────────────

describe("alertas dos dados reais (CrUX)", () => {
  const inp = (crux: AlertInputs["crux"], alerts = {}): AlertInputs => ({
    today: "2026-09-25", scEnd: "2026-09-22", thresholds: { ...DEFAULT_WEB_ANALYTICS_CONFIG.alerts, ...alerts }, ga: [], sc: [], pagespeed: [], queries: [], crux,
  });
  it("LCP > 2,5 s, INP > 200 ms ou CLS > 0,1 numa página-chave → alerta (crítico acima de 'fraco')", () => {
    const a = evaluateWebAlerts(inp([{ target: "https://multipark.app/", label: "Reservas", formFactor: "PHONE", periodEnd: "2026-09-13", lcpP75: 2800, inpP75: 150, clsP75: 0.05 }]));
    expect(a).toEqual([expect.objectContaining({ code: "crux_poor", level: "warning", key: "crux:https://multipark.app/:PHONE:2026-09-13" })]);
    expect(a[0].detail).toMatch(/LCP 2,8 s \(máx\. 2,5 s\)/);
    const b = evaluateWebAlerts(inp([{ target: "x", label: "X", formFactor: "DESKTOP", periodEnd: "2026-09-13", lcpP75: 2000, inpP75: 650, clsP75: 0.3 }]));
    expect(b[0].level).toBe("critical");
    expect(b[0].detail).toMatch(/INP 650 ms.*CLS 0,30/);
    expect(b[0].title).toMatch(/computador/);
  });
  it("dentro dos limiares, sem dados ou desligado → nada; limiares configuráveis", () => {
    const ok = [{ target: "x", label: "X", formFactor: "PHONE", periodEnd: "2026-09-13", lcpP75: 2400, inpP75: 190, clsP75: 0.09 }];
    expect(evaluateWebAlerts(inp(ok))).toEqual([]);
    expect(evaluateWebAlerts(inp([{ ...ok[0], lcpP75: null, inpP75: null, clsP75: null }]))).toEqual([]);
    expect(evaluateWebAlerts(inp([{ ...ok[0], lcpP75: 9000 }], { cruxEnabled: false }))).toEqual([]);
    expect(evaluateWebAlerts(inp(ok, { cruxLcpMs: 2000 }))).toHaveLength(1);
  });
});

// ─── Motor: CrUX e oportunidades gravados com a PageSpeed ──────────────────

class MemStore implements WebStore {
  state = new Map<string, string>();
  crux = new Map<string, CruxPeriodRow[]>();
  audits = new Map<string, LighthouseAudit[]>();
  runs: any[] = [];
  async getState(k: string) { return this.state.get(k) ?? null; }
  async setState(k: string, v: string | null) { if (v == null) this.state.delete(k); else this.state.set(k, v); }
  async upsertGaDaily() {}
  async replaceGaDims() {}
  async upsertScDaily() {}
  async replaceScDims() {}
  async latestPagespeed() { return this.runs.map((r) => ({ url: r.url, strategy: r.strategy, runDay: r.runDay, score: r.result?.score ?? null })); }
  async savePagespeed(r: any) { this.runs.push(r); }
  async savePagespeedAudits(url: string, strategy: string, runDay: string, a: readonly LighthouseAudit[]) { this.audits.set(`${url}|${strategy}|${runDay}`, [...a]); }
  async saveCrux(t: { type: string; target: string }, ff: string, rows: readonly CruxPeriodRow[]) { this.crux.set(`${t.type}:${t.target}:${ff}`, [...rows]); }
}

const NOW = Date.UTC(2026, 8, 25, 10, 0, 0);

describe("recolha semanal com CrUX e oportunidades", () => {
  it("guarda as oportunidades de cada medição e o histórico CrUX (404 = sem dados); 1×/semana", async () => {
    const store = new MemStore();
    const calls: string[] = [];
    const crux = {
      async history(t: { type: string; target: string }, ff: string) {
        calls.push(`${t.type}:${t.target}:${ff}`);
        return t.type === "url" ? null : HISTORY;
      },
    };
    const cfg = webAnalyticsConfigSchema.parse({ enabled: true, pagespeedUrls: [{ url: "https://multipark.pt/", label: "Início" }] });
    const r = await runWebAnalyticsCore(cfg, { ga: null, sc: null, psi: { run: async () => LH }, crux, store, now: () => NOW }, { deadlineAt: NOW + 5 * 60_000 });
    expect(r.crux).toEqual({ measured: 2, noData: 2, failed: 0, pending: 0 });
    expect(calls.sort()).toEqual(["origin:https://multipark.pt:DESKTOP", "origin:https://multipark.pt:PHONE", "url:https://multipark.pt/:DESKTOP", "url:https://multipark.pt/:PHONE"]);
    expect(store.crux.get("origin:https://multipark.pt:PHONE")).toHaveLength(2);
    expect(store.audits.get("https://multipark.pt/|mobile|2026-09-25")?.[0].id).toBe("lcp-discovery-insight");
    calls.length = 0;
    const r2 = await runWebAnalyticsCore(cfg, { ga: null, sc: null, psi: null, crux, store, now: () => NOW + 86_400_000 }, { deadlineAt: NOW + 86_400_000 + 60_000 });
    expect(calls).toEqual([]);
    expect(r2.crux?.pending).toBe(0);
  });
  it("API por ativar: pára na 1.ª falha e volta a tentar amanhã (não hoje)", async () => {
    const store = new MemStore();
    let n = 0;
    const crux = { async history() { n++; throw new Error("A Chrome UX Report API não está ativa no projeto da chave."); } };
    const cfg = webAnalyticsConfigSchema.parse({ enabled: true, pagespeedEnabled: true, pagespeedUrls: [{ url: "https://multipark.pt/" }] });
    const r = await runWebAnalyticsCore(cfg, { ga: null, sc: null, psi: null, crux, store, now: () => NOW }, { deadlineAt: NOW + 60_000 });
    expect(n).toBe(1);
    expect(r.crux).toMatchObject({ failed: 1, pending: 0 });
    expect(r.warnings.join(" ")).toMatch(/não está ativa/);
    await runWebAnalyticsCore(cfg, { ga: null, sc: null, psi: null, crux, store, now: () => NOW + 3_600_000 }, { deadlineAt: NOW + 3_600_000 + 60_000 });
    expect(n).toBe(2); // os outros 3 alvos ainda por tentar (1.ª falha pára de novo)
    const tomorrow = NOW + 86_400_000;
    const before = n;
    await runWebAnalyticsCore(cfg, { ga: null, sc: null, psi: null, crux, store, now: () => tomorrow }, { deadlineAt: tomorrow + 60_000 });
    expect(n).toBe(before + 1);
  });
});
