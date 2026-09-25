/**
 * Web & SEO (Marketing) — regras PURAS partilhadas servidor ↔ cliente:
 * Google Analytics 4 (Data API), Search Console (searchanalytics.query) e
 * PageSpeed Insights, só para uso INTERNO no módulo Marketing.
 *
 *  - configuração (Definições → Integrações → Web & SEO, `marketing.webAnalytics`);
 *  - pedidos às APIs (runReport / searchanalytics.query) e leitura das respostas;
 *  - janelas de recolha (backfill de N dias, incremental com nova leitura dos
 *    últimos dias para os dados que chegam tarde, alargar para trás);
 *  - períodos de comparação, alertas, PageSpeed (limiares Google) e ligação ao
 *    negócio (reservas/receita por sessão).
 *
 * Só agregados: nada de identificadores de pessoas (a GA4 e a Search Console
 * só devolvem totais por dia/dimensão).
 */
import { z } from "zod";
import { MAIL_BRAND_IDS, MAIL_BRAND_LABELS, type MailBrand } from "./mail";
import { addDays, daysInRange } from "./lisbonDay";

export const WEB_ANALYTICS_SETTING_KEY = "marketing.webAnalytics";
export const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const WEB_ANALYTICS_SCOPES = [GA4_SCOPE, SEARCH_CONSOLE_SCOPE] as const;

export const WEB_BRAND_IDS = MAIL_BRAND_IDS;
export type WebBrand = MailBrand;
export const WEB_BRAND_LABELS = MAIL_BRAND_LABELS;

// ─── Identificadores ────────────────────────────────────────────────────────

/** "123456789" | "properties/123456789" → "123456789"; inválido → null. PURA. */
export function normalizeGa4PropertyId(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/^properties\//i, "");
  return /^\d{4,15}$/.test(s) ? s : null;
}

/**
 * Propriedade da Search Console: "sc-domain:exemplo.pt" (domínio) ou
 * prefixo de URL "https://www.exemplo.pt/" (sempre com "/" no fim, como a
 * Search Console a guarda). Inválido → null. PURA.
 */
export function normalizeSearchConsoleSite(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const dom = s.match(/^sc-domain:\s*([a-z0-9.-]+\.[a-z]{2,})$/i);
  if (dom) return `sc-domain:${dom[1].toLowerCase()}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.search || u.hash || u.username || u.password) return null;
    const path = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

/** URL pública http(s) para a PageSpeed. PURA. */
export function normalizePagespeedUrl(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const brandField = z.union([z.enum(WEB_BRAND_IDS, { error: "Marca desconhecida." }), z.literal("")]).default("");
const labelField = z.string().trim().max(80, "Nome: no máximo 80 caracteres.").default("");

const ga4PropertySchema = z.object({
  propertyId: z.string().transform((v, ctx) => {
    const n = normalizeGa4PropertyId(v);
    if (!n) { ctx.addIssue({ code: "custom", message: `ID de propriedade GA4 inválido: "${String(v).slice(0, 40)}" (só números, ex.: 123456789).` }); return z.NEVER; }
    return n;
  }),
  label: labelField,
  brand: brandField,
  active: z.boolean().default(true),
});
export type Ga4PropertyConfig = z.output<typeof ga4PropertySchema>;

const scSiteSchema = z.object({
  siteUrl: z.string().transform((v, ctx) => {
    const n = normalizeSearchConsoleSite(v);
    if (!n) { ctx.addIssue({ code: "custom", message: `Propriedade da Search Console inválida: "${String(v).slice(0, 60)}" (usa sc-domain:exemplo.pt ou https://www.exemplo.pt/).` }); return z.NEVER; }
    return n;
  }),
  label: labelField,
  brand: brandField,
  active: z.boolean().default(true),
});
export type SearchConsoleSiteConfig = z.output<typeof scSiteSchema>;

const psUrlSchema = z.object({
  url: z.string().transform((v, ctx) => {
    const n = normalizePagespeedUrl(v);
    if (!n) { ctx.addIssue({ code: "custom", message: `URL inválido para a PageSpeed: "${String(v).slice(0, 60)}".` }); return z.NEVER; }
    return n;
  }),
  label: labelField,
  brand: brandField,
});
export type PagespeedUrlConfig = z.output<typeof psUrlSchema>;

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export const webAlertThresholdsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Sessões de ontem abaixo da média dos 7 dias anteriores em ≥ X%. */
  sessionsDropPct: z.number().min(5).max(95).default(30),
  /** Cliques (Search Console) da última semana abaixo da anterior em ≥ X%. */
  clicksDropPct: z.number().min(5).max(95).default(30),
  /** Pontuação PageSpeed móvel abaixo disto (0–100). */
  pagespeedMobileMin: z.number().int().min(1).max(100).default(50),
  /** Posição média de uma pesquisa do top piorou mais do que isto. */
  positionDrop: z.number().min(0.5).max(50).default(3),
  /** Quantas pesquisas do top (por cliques) vigiar. */
  positionTopN: z.number().int().min(5).max(100).default(20),
  /** Base mínima para não alarmar com números pequenos. */
  minSessions: z.number().int().min(0).max(100_000).default(50),
  minClicks: z.number().int().min(0).max(100_000).default(20),
});
export type WebAlertThresholds = z.output<typeof webAlertThresholdsSchema>;

export const DEFAULT_PAGESPEED_URLS: Array<{ url: string; label: string; brand: WebBrand }> = [
  { url: "https://multipark.pt/", label: "Multipark — página inicial", brand: "multipark" },
  { url: "https://multipark.app/", label: "Multipark — reservas", brand: "multipark" },
];
export const DEFAULT_FUNNEL_EVENTS = ["view_item", "begin_checkout", "add_payment_info", "purchase"];

export const webAnalyticsConfigSchema = z.object({
  /** Recolha diária ligada. */
  enabled: z.boolean().default(false),
  /**
   * Opcional: conta do Workspace a impersonar (delegação ao nível do domínio).
   * Vazio (recomendado) = a própria conta de serviço, adicionada como
   * utilizador nas propriedades GA4 e na Search Console.
   */
  impersonateEmail: z.union([z.literal(""), z.string().trim().toLowerCase().email("Email inválido.")]).default(""),
  ga4Properties: z.array(ga4PropertySchema).max(20, "No máximo 20 propriedades GA4.").default([]),
  searchConsoleSites: z.array(scSiteSchema).max(20, "No máximo 20 propriedades da Search Console.").default([]),
  pagespeedEnabled: z.boolean().default(true),
  pagespeedUrls: z.array(psUrlSchema).max(15, "No máximo 15 páginas na PageSpeed.").default(DEFAULT_PAGESPEED_URLS),
  /** Hora (Lisboa) a partir da qual corre a atualização do dia. */
  refreshHour: z.number().int().min(0).max(23).default(7),
  /** Dias de histórico na primeira recolha (e se aumentar, alarga para trás). */
  backfillDays: z.number().int().min(7).max(480).default(90),
  /** Eventos do funil de reserva (GA4) — só os que existirem aparecem. */
  funnelEvents: z.array(z.string().trim().regex(EVENT_NAME, "Nome de evento inválido (letras, números e _).")).max(10).default(DEFAULT_FUNNEL_EVENTS),
  alerts: webAlertThresholdsSchema.prefault({}),
  /** Resumo semanal da IA (lite) — respeita também o interruptor AI_WEB_INSIGHT. */
  aiInsight: z.boolean().default(true),
}).superRefine((v, ctx) => {
  const dup = (list: string[], what: string) => {
    const seen = new Set<string>();
    for (const x of list) {
      if (seen.has(x)) ctx.addIssue({ code: "custom", message: `${what} repetida: ${x}` });
      seen.add(x);
    }
  };
  dup(v.ga4Properties.map((p) => p.propertyId), "Propriedade GA4");
  dup(v.searchConsoleSites.map((s) => s.siteUrl), "Propriedade da Search Console");
  dup(v.pagespeedUrls.map((s) => s.url), "Página PageSpeed");
});
export type WebAnalyticsConfig = z.output<typeof webAnalyticsConfigSchema>;
export const DEFAULT_WEB_ANALYTICS_CONFIG: WebAnalyticsConfig = webAnalyticsConfigSchema.parse({});

/** Valor guardado (JSON/objeto) → configuração válida (inválida → omissão). PURA. */
export function parseWebAnalyticsConfig(raw: unknown): WebAnalyticsConfig {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { v = {}; } }
  const r = webAnalyticsConfigSchema.safeParse(v && typeof v === "object" ? v : {});
  return r.success ? r.data : DEFAULT_WEB_ANALYTICS_CONFIG;
}

/** Propriedades/sites/páginas ativos de uma marca ("" = todas). PURA. */
export function scopeByBrand(cfg: WebAnalyticsConfig, brand: string | null | undefined): { properties: string[]; sites: string[]; urls: string[] } {
  const b = String(brand ?? "");
  const ok = (x: { brand: string }) => !b || x.brand === b;
  return {
    properties: cfg.ga4Properties.filter((p) => p.active && ok(p)).map((p) => p.propertyId),
    sites: cfg.searchConsoleSites.filter((s) => s.active && ok(s)).map((s) => s.siteUrl),
    urls: cfg.pagespeedUrls.filter(ok).map((u) => u.url),
  };
}

// ─── Janelas de recolha (backfill / incremental / alargar) ─────────────────

export interface SourceCursor {
  /** Primeiro e último dia já recolhidos (inclusive). */
  coveredFrom: string | null;
  coveredTo: string | null;
  /** Dia (Lisboa) em que foi feita a releitura dos últimos dias. */
  refreshedOn: string | null;
}
export const EMPTY_CURSOR: SourceCursor = { coveredFrom: null, coveredTo: null, refreshedOn: null };

export interface WindowOptions {
  /** Hoje (Lisboa). */
  today: string;
  /** Dias de atraso da fonte: GA4 1 (até ontem), Search Console 2. */
  lagDays: number;
  backfillDays: number;
  /** Tamanho máximo de cada pedido (dias). */
  chunkDays: number;
  /** Quantos dias do fim se voltam a ler 1×/dia (dados que chegam tarde). */
  refetchDays: number;
  /** Já passou a hora da atualização do dia? */
  refreshDue: boolean;
}

export type SyncWindowKind = "backfill" | "refresh" | "extend";
export interface SyncWindow { from: string; to: string; kind: SyncWindowKind }

const minDay = (a: string, b: string) => (a < b ? a : b);
const maxDay = (a: string, b: string) => (a > b ? a : b);

/**
 * Próxima janela a recolher (ou null = em dia). PURA.
 *  1. nada recolhido → começa no início do histórico (hoje − backfillDays);
 *  2. atrasado mais do que a releitura → avança em blocos até lá;
 *  3. 1×/dia depois da hora: relê os últimos `refetchDays` (até ao fim);
 *  4. histórico aumentado nas Definições → alarga para trás em blocos.
 */
export function nextSyncWindow(c: SourceCursor, o: WindowOptions): SyncWindow | null {
  const end = addDays(o.today, -Math.max(0, o.lagDays));
  const target = addDays(o.today, -Math.max(o.backfillDays, o.lagDays + 1));
  const chunk = Math.max(1, o.chunkDays);
  const refetch = Math.max(1, o.refetchDays);
  if (!c.coveredFrom || !c.coveredTo) {
    return { from: target, to: minDay(addDays(target, chunk - 1), end), kind: "backfill" };
  }
  if (c.coveredTo < addDays(end, -refetch)) {
    const from = addDays(c.coveredTo, 1);
    return { from, to: minDay(addDays(from, chunk - 1), end), kind: "backfill" };
  }
  if (o.refreshDue && c.refreshedOn !== o.today) {
    const from = maxDay(addDays(end, -(refetch - 1)), c.coveredFrom);
    return { from, to: end, kind: "refresh" };
  }
  if (c.coveredFrom > target) {
    const to = addDays(c.coveredFrom, -1);
    return { from: maxDay(target, addDays(to, -(chunk - 1))), to, kind: "extend" };
  }
  return null;
}

/** Cursor depois de recolher a janela com sucesso. PURA. */
export function applySyncWindow(c: SourceCursor, w: SyncWindow, today: string): SourceCursor {
  return {
    coveredFrom: c.coveredFrom ? minDay(c.coveredFrom, w.from) : w.from,
    coveredTo: c.coveredTo ? maxDay(c.coveredTo, w.to) : w.to,
    refreshedOn: w.kind === "refresh" ? today : c.refreshedOn,
  };
}

export function parseCursor(raw: unknown): SourceCursor {
  let v: any = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { v = null; } }
  const day = (x: unknown) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
  return v && typeof v === "object" ? { coveredFrom: day(v.coveredFrom), coveredTo: day(v.coveredTo), refreshedOn: day(v.refreshedOn) } : { ...EMPTY_CURSOR };
}

// ─── GA4 Data API ───────────────────────────────────────────────────────────

export const GA_TOTAL_METRICS = ["sessions", "totalUsers", "newUsers", "engagedSessions", "keyEvents", "totalRevenue"] as const;
export const GA_DIM_METRICS = ["sessions", "totalUsers", "engagedSessions", "keyEvents", "totalRevenue"] as const;
export const GA_EVENT_METRICS = ["eventCount", "totalUsers"] as const;

export type GaPart = "totals" | "channel" | "landing" | "device" | "country" | "city" | "event";
export const GA_PARTS: readonly GaPart[] = ["totals", "channel", "landing", "device", "country", "city", "event"];
export type GaDimKind = Exclude<GaPart, "totals">;
export const GA_DIMS: Record<GaDimKind, { apiName: string; topN: number; label: string }> = {
  channel: { apiName: "sessionDefaultChannelGroup", topN: 25, label: "Canal" },
  landing: { apiName: "landingPage", topN: 50, label: "Página de entrada" },
  device: { apiName: "deviceCategory", topN: 10, label: "Dispositivo" },
  country: { apiName: "country", topN: 30, label: "País" },
  city: { apiName: "city", topN: 30, label: "Cidade" },
  event: { apiName: "eventName", topN: 20, label: "Evento" },
};
/** Linhas por página no runReport (máx. da API 250 000; ficamos longe). */
export const GA_PAGE_LIMIT = 10_000;
export const GA_MAX_PAGES = 5;

const gaDate = (day: string) => day; // a Data API aceita AAAA-MM-DD

export function gaTotalsRequest(from: string, to: string) {
  return {
    dateRanges: [{ startDate: gaDate(from), endDate: gaDate(to) }],
    dimensions: [{ name: "date" }],
    metrics: GA_TOTAL_METRICS.map((name) => ({ name })),
    keepEmptyRows: true,
    limit: "1000",
  };
}

export function gaDimRequest(kind: GaDimKind, from: string, to: string, opts: { offset?: number; funnelEvents?: readonly string[] } = {}) {
  const metrics = kind === "event" ? GA_EVENT_METRICS : GA_DIM_METRICS;
  return {
    dateRanges: [{ startDate: gaDate(from), endDate: gaDate(to) }],
    dimensions: [{ name: "date" }, { name: GA_DIMS[kind].apiName }],
    metrics: metrics.map((name) => ({ name })),
    orderBys: [{ metric: { metricName: kind === "event" ? "eventCount" : "sessions" }, desc: true }],
    limit: String(GA_PAGE_LIMIT),
    offset: String(opts.offset ?? 0),
    ...(kind === "event" ? { dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: [...(opts.funnelEvents ?? [])], caseSensitive: true } } } } : {}),
  };
}

export interface GaRow { day: string; dim: string | null; m: Record<string, number> }

/** "20260924" → "2026-09-24". PURA. */
export function gaDayToIso(v: unknown): string | null {
  const s = String(v ?? "");
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Resposta do runReport → linhas {dia, valor da dimensão, métricas}. PURA. */
export function parseGaReport(res: any): { rows: GaRow[]; rowCount: number } {
  const dimHeaders: string[] = (res?.dimensionHeaders ?? []).map((h: any) => String(h?.name ?? ""));
  const metricHeaders: string[] = (res?.metricHeaders ?? []).map((h: any) => String(h?.name ?? ""));
  const dateIdx = dimHeaders.indexOf("date");
  const otherIdx = dimHeaders.findIndex((n, i) => i !== dateIdx);
  const rows: GaRow[] = [];
  for (const r of res?.rows ?? []) {
    const dv = r?.dimensionValues ?? [];
    const day = gaDayToIso(dv[dateIdx]?.value);
    if (!day) continue;
    const m: Record<string, number> = {};
    metricHeaders.forEach((name, i) => { m[name] = num(r?.metricValues?.[i]?.value); });
    rows.push({ day, dim: otherIdx >= 0 ? String(dv[otherIdx]?.value ?? "") : null, m });
  }
  return { rows, rowCount: num(res?.rowCount) };
}

/** Top N por dia (ordenado pela métrica `key`, desc). PURA. */
export function topNPerDay<T extends { day: string }>(rows: readonly T[], n: number, score: (r: T) => number): T[] {
  const byDay = new Map<string, T[]>();
  for (const r of rows) {
    const list = byDay.get(r.day) ?? [];
    list.push(r);
    byDay.set(r.day, list);
  }
  const out: T[] = [];
  for (const day of Array.from(byDay.keys()).sort()) {
    out.push(...byDay.get(day)!.slice().sort((a, b) => score(b) - score(a)).slice(0, n));
  }
  return out;
}

/** Soma linhas repetidas (mesmo dia + valor) — a API pode partir por página. PURA. */
export function mergeGaRows(rows: readonly GaRow[]): GaRow[] {
  const map = new Map<string, GaRow>();
  for (const r of rows) {
    const k = `${r.day}\u0000${r.dim ?? ""}`;
    const cur = map.get(k);
    if (!cur) { map.set(k, { day: r.day, dim: r.dim, m: { ...r.m } }); continue; }
    for (const [name, v] of Object.entries(r.m)) cur.m[name] = (cur.m[name] ?? 0) + v;
  }
  return Array.from(map.values());
}

export interface GaDailyRow { day: string; sessions: number; totalUsers: number; newUsers: number; engagedSessions: number; keyEvents: number; revenue: number }

/** Totais por dia, com zeros nos dias sem linha (a GA4 omite dias vazios). PURA. */
export function gaDailyRows(rows: readonly GaRow[], from: string, to: string): GaDailyRow[] {
  const byDay = new Map(mergeGaRows(rows).map((r) => [r.day, r.m]));
  return daysInRange(from, to).map((day) => {
    const m = byDay.get(day) ?? {};
    return {
      day, sessions: Math.round(m.sessions ?? 0), totalUsers: Math.round(m.totalUsers ?? 0), newUsers: Math.round(m.newUsers ?? 0),
      engagedSessions: Math.round(m.engagedSessions ?? 0), keyEvents: m.keyEvents ?? 0, revenue: m.totalRevenue ?? 0,
    };
  });
}

// ─── Search Console ─────────────────────────────────────────────────────────

export type ScPart = "totals" | "query" | "page" | "device" | "country";
export const SC_PARTS: readonly ScPart[] = ["totals", "query", "page", "device", "country"];
export type ScDimKind = Exclude<ScPart, "totals">;
export const SC_DIMS: Record<ScDimKind, { topN: number; chunkDays: number; label: string }> = {
  query: { topN: 250, chunkDays: 7, label: "Pesquisa" },
  page: { topN: 250, chunkDays: 7, label: "Página" },
  device: { topN: 10, chunkDays: 30, label: "Dispositivo" },
  country: { topN: 30, chunkDays: 30, label: "País" },
};
export const SC_ROW_LIMIT = 25_000;
export const SC_MAX_PAGES = 4;

export function scRequest(part: ScPart, from: string, to: string, startRow = 0) {
  return {
    startDate: from,
    endDate: to,
    dimensions: part === "totals" ? ["date"] : ["date", part],
    type: "web",
    dataState: "all",
    rowLimit: SC_ROW_LIMIT,
    startRow,
  };
}

export interface ScRow { day: string; dim: string | null; clicks: number; impressions: number; position: number }

export function parseScRows(res: any, part: ScPart): ScRow[] {
  const out: ScRow[] = [];
  for (const r of res?.rows ?? []) {
    const keys: any[] = r?.keys ?? [];
    const day = gaDayToIso(keys[0]);
    if (!day) continue;
    out.push({
      day, dim: part === "totals" ? null : String(keys[1] ?? ""),
      clicks: Math.round(num(r?.clicks)), impressions: Math.round(num(r?.impressions)), position: num(r?.position),
    });
  }
  return out;
}

/** Posição média ponderada pelas impressões (como a Search Console). PURA. */
export function weightedPosition(rows: ReadonlyArray<{ impressions: number; position: number }>): number | null {
  let imp = 0, acc = 0;
  for (const r of rows) { imp += r.impressions; acc += r.position * r.impressions; }
  return imp > 0 ? acc / imp : null;
}

// ─── PageSpeed Insights ─────────────────────────────────────────────────────

export type PsStrategy = "mobile" | "desktop";
export const PS_STRATEGIES: readonly PsStrategy[] = ["mobile", "desktop"];
/** Uma medição por página × estratégia por semana. */
export const PAGESPEED_INTERVAL_DAYS = 7;

export interface PagespeedResult {
  score: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fcpMs: number | null;
  speedIndexMs: number | null;
  /** Dados reais (CrUX) quando a página os tem. */
  inpMs: number | null;
  fieldLcpMs: number | null;
  fieldCls: number | null;
  fieldCategory: string | null;
}

const auditNum = (lh: any, id: string): number | null => {
  const v = lh?.audits?.[id]?.numericValue;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const fieldPct = (le: any, id: string): number | null => {
  const v = le?.metrics?.[id]?.percentile;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/** Resposta do runPagespeed → métricas (laboratório + campo). PURA. */
export function parsePagespeed(res: any): PagespeedResult {
  const lh = res?.lighthouseResult;
  const le = res?.loadingExperience ?? res?.originLoadingExperience;
  const rawScore = lh?.categories?.performance?.score;
  const round = (v: number | null) => (v == null ? null : Math.round(v));
  const fieldClsRaw = fieldPct(le, "CUMULATIVE_LAYOUT_SHIFT_SCORE");
  return {
    score: typeof rawScore === "number" ? Math.round(rawScore * 100) : null,
    lcpMs: round(auditNum(lh, "largest-contentful-paint")),
    cls: auditNum(lh, "cumulative-layout-shift") == null ? null : Math.round(auditNum(lh, "cumulative-layout-shift")! * 1000) / 1000,
    tbtMs: round(auditNum(lh, "total-blocking-time")),
    fcpMs: round(auditNum(lh, "first-contentful-paint")),
    speedIndexMs: round(auditNum(lh, "speed-index")),
    inpMs: round(fieldPct(le, "INTERACTION_TO_NEXT_PAINT")),
    fieldLcpMs: round(fieldPct(le, "LARGEST_CONTENTFUL_PAINT_MS")),
    // A CrUX dá o CLS × 100.
    fieldCls: fieldClsRaw == null ? null : Math.round(fieldClsRaw * 10) / 1000,
    fieldCategory: typeof le?.overall_category === "string" ? le.overall_category : null,
  };
}

export type PsMetric = "score" | "lcpMs" | "cls" | "inpMs" | "tbtMs" | "fcpMs";
export type PsLevel = "good" | "needs_improvement" | "poor";
/** Limiares oficiais (web.dev / Lighthouse): [bom até, a melhorar até]. */
export const PS_THRESHOLDS: Record<Exclude<PsMetric, "score">, [number, number]> = {
  lcpMs: [2500, 4000],
  cls: [0.1, 0.25],
  inpMs: [200, 500],
  tbtMs: [200, 600],
  fcpMs: [1800, 3000],
};

/** Verde/âmbar/vermelho de uma métrica. PURA. */
export function psLevel(metric: PsMetric, value: number | null | undefined): PsLevel | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (metric === "score") return value >= 90 ? "good" : value >= 50 ? "needs_improvement" : "poor";
  const [good, ni] = PS_THRESHOLDS[metric];
  return value <= good ? "good" : value <= ni ? "needs_improvement" : "poor";
}

/** Páginas × estratégias a medir hoje (sem medição nos últimos 7 dias). PURA. */
export function pagespeedDue(urls: readonly string[], latest: ReadonlyArray<{ url: string; strategy: string; runDay: string }>, today: string): Array<{ url: string; strategy: PsStrategy }> {
  const last = new Map<string, string>();
  for (const l of latest) {
    const k = `${l.url}\u0000${l.strategy}`;
    if (!last.has(k) || last.get(k)! < l.runDay) last.set(k, l.runDay);
  }
  const limit = addDays(today, -PAGESPEED_INTERVAL_DAYS);
  const out: Array<{ url: string; strategy: PsStrategy }> = [];
  for (const url of urls) for (const strategy of PS_STRATEGIES) {
    const d = last.get(`${url}\u0000${strategy}`);
    if (!d || d <= limit) out.push({ url, strategy });
  }
  return out;
}

// ─── Períodos ───────────────────────────────────────────────────────────────

export type CompareMode = "previous" | "yoy";

function shiftYear(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
  return `${String(y + n).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export function daysBetweenInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Período de comparação: anterior com o mesmo n.º de dias, ou mesmo período do ano passado. PURA. */
export function comparisonRange(from: string, to: string, mode: CompareMode): { from: string; to: string } {
  if (mode === "yoy") return { from: shiftYear(from, -1), to: shiftYear(to, -1) };
  const len = Math.max(1, daysBetweenInclusive(from, to));
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -(len - 1)), to: prevTo };
}

/** Variação relativa (0,25 = +25%); sem base → null. PURA. */
export function pctChange(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}

// ─── Alertas ────────────────────────────────────────────────────────────────

export interface WebAlert {
  code: "sessions_drop" | "clicks_drop" | "pagespeed_low" | "position_drop";
  level: "critical" | "warning";
  /** Chave de deduplicação (1 aviso por registo e dia). */
  key: string;
  title: string;
  detail: string;
  items?: string[];
}

export interface AlertInputs {
  today: string;
  thresholds: WebAlertThresholds;
  ga: Array<{ id: string; label: string; days: Array<{ day: string; sessions: number }> }>;
  sc: Array<{ id: string; label: string; days: Array<{ day: string; clicks: number }> }>;
  /** Última medição móvel por página. */
  pagespeed: Array<{ url: string; label: string; strategy: string; score: number | null; runDay: string }>;
  /** Pesquisas: cliques/posição na última semana e na anterior. */
  queries: Array<{ siteId: string; siteLabel: string; query: string; prevClicks: number; curPosition: number | null; prevPosition: number | null }>;
  /** Último dia completo da Search Console. */
  scEnd: string;
}

const fmtPct = (x: number) => `${Math.round(x * 100)}%`;
const fmtNum = (x: number) => Math.round(x).toLocaleString("pt-PT");
const fmtPos = (x: number) => x.toFixed(1).replace(".", ",");

/** Regras dos alertas (configuráveis). PURA. */
export function evaluateWebAlerts(inp: AlertInputs): WebAlert[] {
  const t = inp.thresholds;
  if (!t.enabled) return [];
  const out: WebAlert[] = [];
  const yesterday = addDays(inp.today, -1);
  // Sessões: ontem vs média dos 7 dias anteriores.
  for (const g of inp.ga) {
    const by = new Map(g.days.map((d) => [d.day, d.sessions]));
    if (!by.has(yesterday)) continue;
    const base = daysInRange(addDays(yesterday, -7), addDays(yesterday, -1)).filter((d) => by.has(d)).map((d) => by.get(d)!);
    if (base.length < 4) continue;
    const avg = base.reduce((s, x) => s + x, 0) / base.length;
    const cur = by.get(yesterday)!;
    if (avg < t.minSessions || avg <= 0) continue;
    const drop = (avg - cur) / avg;
    if (drop * 100 >= t.sessionsDropPct) {
      out.push({
        code: "sessions_drop", level: drop >= 0.5 ? "critical" : "warning", key: `sessions:${g.id}:${yesterday}`,
        title: `Sessões a cair: ${g.label}`,
        detail: `Ontem ${fmtNum(cur)} sessões vs média de ${fmtNum(avg)} nos 7 dias anteriores (−${fmtPct(drop)}).`,
      });
    }
  }
  // Cliques da pesquisa orgânica: última semana completa vs a anterior.
  const curFrom = addDays(inp.scEnd, -6), prevTo = addDays(curFrom, -1), prevFrom = addDays(prevTo, -6);
  for (const s of inp.sc) {
    const sum = (a: string, b: string) => s.days.filter((d) => d.day >= a && d.day <= b).reduce((x, d) => x + d.clicks, 0);
    const daysIn = (a: string, b: string) => s.days.filter((d) => d.day >= a && d.day <= b).length;
    if (daysIn(curFrom, inp.scEnd) < 7 || daysIn(prevFrom, prevTo) < 7) continue;
    const cur = sum(curFrom, inp.scEnd), prev = sum(prevFrom, prevTo);
    if (prev < t.minClicks || prev <= 0) continue;
    const drop = (prev - cur) / prev;
    if (drop * 100 >= t.clicksDropPct) {
      out.push({
        code: "clicks_drop", level: drop >= 0.5 ? "critical" : "warning", key: `clicks:${s.id}:${inp.scEnd}`,
        title: `Cliques do Google a cair: ${s.label}`,
        detail: `${fmtNum(cur)} cliques na semana até ${inp.scEnd.slice(8, 10)}/${inp.scEnd.slice(5, 7)} vs ${fmtNum(prev)} na anterior (−${fmtPct(drop)}).`,
      });
    }
  }
  // PageSpeed (móvel).
  for (const p of inp.pagespeed) {
    if (p.strategy !== "mobile" || p.score == null) continue;
    if (p.score < t.pagespeedMobileMin) {
      out.push({
        code: "pagespeed_low", level: p.score < 30 ? "critical" : "warning", key: `pagespeed:${p.url}:${p.runDay}`,
        title: `PageSpeed móvel baixa: ${p.label || p.url}`,
        detail: `Pontuação ${p.score}/100 (mínimo ${t.pagespeedMobileMin}) na medição de ${p.runDay.slice(8, 10)}/${p.runDay.slice(5, 7)}.`,
      });
    }
  }
  // Posição das pesquisas do top (por cliques na semana anterior).
  const bySite = new Map<string, AlertInputs["queries"]>();
  for (const q of inp.queries) bySite.set(q.siteId, [...(bySite.get(q.siteId) ?? []), q]);
  for (const [siteId, list] of bySite) {
    const top = list.slice().sort((a, b) => b.prevClicks - a.prevClicks).slice(0, t.positionTopN);
    const worse = top.filter((q) => q.curPosition != null && q.prevPosition != null && q.curPosition - q.prevPosition > t.positionDrop);
    if (!worse.length) continue;
    out.push({
      code: "position_drop", level: "warning", key: `position:${siteId}:${inp.scEnd}`,
      title: `Pesquisas a perder posição: ${list[0].siteLabel}`,
      detail: `${worse.length} das ${top.length} pesquisas com mais cliques caíram mais de ${fmtPos(t.positionDrop)} posições (semana até ${inp.scEnd.slice(8, 10)}/${inp.scEnd.slice(5, 7)}).`,
      items: worse.slice(0, 8).map((q) => `"${q.query}": ${fmtPos(q.prevPosition!)} → ${fmtPos(q.curPosition!)}`),
    });
  }
  return out;
}

// ─── Ligação ao negócio ─────────────────────────────────────────────────────

export interface BusinessDayInput { sessions: number; bookings: number; siteBookings: number; revenue: number; siteRevenue: number; spend: number }
export interface BusinessRow extends BusinessDayInput { day: string; conversionRate: number | null; revenuePerSession: number | null }
export interface BusinessTotals extends BusinessDayInput {
  /** Reservas feitas no site ÷ sessões. */
  conversionRate: number | null;
  /** Todas as reservas ÷ sessões (indicador, inclui telefone/parceiros). */
  bookingsPerSession: number | null;
  /** Receita das reservas do site ÷ sessões. */
  revenuePerSession: number | null;
  /** Gasto em anúncios ÷ sessões. */
  spendPerSession: number | null;
  /** Gasto ÷ reservas do site. */
  spendPerSiteBooking: number | null;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/** Junta sessões (GA4), reservas/receita (Multipark) e gasto (anúncios) por dia. PURA. */
export function businessJoin(days: readonly string[], byDay: {
  sessions: ReadonlyMap<string, number>;
  bookings: ReadonlyMap<string, { bookings: number; siteBookings: number; revenue: number; siteRevenue: number }>;
  spend: ReadonlyMap<string, number>;
}): { rows: BusinessRow[]; totals: BusinessTotals } {
  const t: BusinessDayInput = { sessions: 0, bookings: 0, siteBookings: 0, revenue: 0, siteRevenue: 0, spend: 0 };
  const rows = days.map((day) => {
    const b = byDay.bookings.get(day);
    const r: BusinessDayInput = {
      sessions: byDay.sessions.get(day) ?? 0, bookings: b?.bookings ?? 0, siteBookings: b?.siteBookings ?? 0,
      revenue: b?.revenue ?? 0, siteRevenue: b?.siteRevenue ?? 0, spend: byDay.spend.get(day) ?? 0,
    };
    for (const k of Object.keys(t) as Array<keyof BusinessDayInput>) t[k] += r[k];
    return { day, ...r, conversionRate: ratio(r.siteBookings, r.sessions), revenuePerSession: ratio(r.siteRevenue, r.sessions) };
  });
  return {
    rows,
    totals: {
      ...t,
      conversionRate: ratio(t.siteBookings, t.sessions),
      bookingsPerSession: ratio(t.bookings, t.sessions),
      revenuePerSession: ratio(t.siteRevenue, t.sessions),
      spendPerSession: ratio(t.spend, t.sessions),
      spendPerSiteBooking: ratio(t.spend, t.siteBookings),
    },
  };
}

/** Nome do nó "marca" da árvore de projetos ↔ id da marca ("Multipark" → multipark). PURA. */
export function brandIdOfName(name: string | null | undefined): WebBrand | null {
  const k = String(name ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
  return (WEB_BRAND_IDS as readonly string[]).includes(k) ? (k as WebBrand) : null;
}

// ─── Resumo semanal (factos para a IA e texto fixo) ────────────────────────

export interface WebWeekFacts {
  from: string;
  to: string;
  ga: { sessions: number; prevSessions: number; users: number; prevUsers: number; keyEvents: number; prevKeyEvents: number; revenue: number; prevRevenue: number } | null;
  channels: Array<{ name: string; cur: number; prev: number }>;
  sc: { clicks: number; prevClicks: number; impressions: number; prevImpressions: number; position: number | null; prevPosition: number | null } | null;
  gainers: Array<{ query: string; delta: number }>;
  losers: Array<{ query: string; delta: number }>;
  pagespeed: Array<{ label: string; score: number | null }>;
  bookings: { siteBookings: number; prevSiteBookings: number } | null;
}

const signedPct = (cur: number, prev: number) => {
  const p = pctChange(cur, prev);
  return p == null ? "sem base" : `${p >= 0 ? "+" : "−"}${Math.round(Math.abs(p) * 100)}%`;
};

/** Factos (só agregados, sem dados pessoais) — entrada da IA. PURA. */
export function webFactsText(f: WebWeekFacts): string {
  const L: string[] = [`Semana ${f.from} a ${f.to} vs semana anterior.`];
  if (f.ga) {
    L.push(`Sessões: ${fmtNum(f.ga.sessions)} (${signedPct(f.ga.sessions, f.ga.prevSessions)}); utilizadores ${fmtNum(f.ga.users)} (${signedPct(f.ga.users, f.ga.prevUsers)}); conversões (eventos-chave) ${fmtNum(f.ga.keyEvents)} (${signedPct(f.ga.keyEvents, f.ga.prevKeyEvents)}).`);
    if (f.ga.revenue || f.ga.prevRevenue) L.push(`Receita GA4: ${fmtNum(f.ga.revenue)} € (${signedPct(f.ga.revenue, f.ga.prevRevenue)}).`);
  }
  if (f.channels.length) L.push(`Canais (sessões): ${f.channels.slice(0, 6).map((c) => `${c.name} ${fmtNum(c.cur)} (${signedPct(c.cur, c.prev)})`).join("; ")}.`);
  if (f.sc) {
    L.push(`Google orgânico: ${fmtNum(f.sc.clicks)} cliques (${signedPct(f.sc.clicks, f.sc.prevClicks)}), ${fmtNum(f.sc.impressions)} impressões (${signedPct(f.sc.impressions, f.sc.prevImpressions)}), posição média ${f.sc.position == null ? "—" : fmtPos(f.sc.position)} (antes ${f.sc.prevPosition == null ? "—" : fmtPos(f.sc.prevPosition)}).`);
  }
  if (f.gainers.length) L.push(`Pesquisas a ganhar cliques: ${f.gainers.slice(0, 5).map((q) => `"${q.query}" +${q.delta}`).join(", ")}.`);
  if (f.losers.length) L.push(`Pesquisas a perder cliques: ${f.losers.slice(0, 5).map((q) => `"${q.query}" ${q.delta}`).join(", ")}.`);
  if (f.bookings) L.push(`Reservas feitas no site: ${fmtNum(f.bookings.siteBookings)} (${signedPct(f.bookings.siteBookings, f.bookings.prevSiteBookings)}).`);
  const slow = f.pagespeed.filter((p) => p.score != null && p.score < 50);
  if (slow.length) L.push(`PageSpeed móvel fraca: ${slow.map((p) => `${p.label} ${p.score}/100`).join(", ")}.`);
  return L.join("\n");
}

/** Texto fixo (IA desligada/sem orçamento) — os mesmos números. PURA. */
export function webInsightFallback(f: WebWeekFacts): string {
  const parts: string[] = [];
  if (f.ga) parts.push(`Sessões ${signedPct(f.ga.sessions, f.ga.prevSessions)} (${fmtNum(f.ga.sessions)}) e conversões ${signedPct(f.ga.keyEvents, f.ga.prevKeyEvents)} face à semana anterior.`);
  if (f.channels.length) {
    const moved = f.channels.filter((c) => c.prev > 0).map((c) => ({ c, p: pctChange(c.cur, c.prev) ?? 0 })).sort((a, b) => Math.abs(b.p) - Math.abs(a.p))[0];
    if (moved && Math.abs(moved.p) >= 0.1) parts.push(`O canal que mais mudou foi ${moved.c.name} (${signedPct(moved.c.cur, moved.c.prev)}).`);
  }
  if (f.sc) parts.push(`No Google orgânico: ${fmtNum(f.sc.clicks)} cliques (${signedPct(f.sc.clicks, f.sc.prevClicks)})${f.sc.position != null ? `, posição média ${fmtPos(f.sc.position)}` : ""}.`);
  if (f.losers[0]) parts.push(`Maior perda: "${f.losers[0].query}" (${f.losers[0].delta} cliques).`);
  if (f.bookings) parts.push(`Reservas no site ${signedPct(f.bookings.siteBookings, f.bookings.prevSiteBookings)}.`);
  return parts.join(" ") || "Sem dados suficientes para comparar as duas últimas semanas.";
}
