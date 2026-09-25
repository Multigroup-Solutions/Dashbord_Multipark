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
  /** Página-chave: entra nos alertas dos dados reais (CrUX). */
  keyUrl: z.boolean().default(true),
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
  /** Dados reais (CrUX, p75 28 dias) das páginas-chave acima dos limiares Google. */
  cruxEnabled: z.boolean().default(true),
  cruxLcpMs: z.number().int().min(500).max(20_000).default(2500),
  cruxInpMs: z.number().int().min(50).max(5_000).default(200),
  cruxCls: z.number().min(0.01).max(2).default(0.1),
});
export type WebAlertThresholds = z.output<typeof webAlertThresholdsSchema>;

export const DEFAULT_PAGESPEED_URLS: Array<{ url: string; label: string; brand: WebBrand; keyUrl: boolean }> = [
  { url: "https://multipark.pt/", label: "Multipark — página inicial", brand: "multipark", keyUrl: true },
  { url: "https://multipark.app/", label: "Multipark — reservas", brand: "multipark", keyUrl: true },
];
/** Páginas medidas (PageSpeed + CrUX): as de reserva de cada marca cabem com folga. */
export const PAGESPEED_MAX_URLS = 40;
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
  pagespeedUrls: z.array(psUrlSchema).max(PAGESPEED_MAX_URLS, `No máximo ${PAGESPEED_MAX_URLS} páginas na PageSpeed.`).default(DEFAULT_PAGESPEED_URLS),
  /** Chrome UX Report (dados reais) 1×/semana por origem e por página — precisa de chave de API. */
  cruxEnabled: z.boolean().default(true),
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
  code: "sessions_drop" | "clicks_drop" | "pagespeed_low" | "position_drop" | "crux_poor";
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
  /** Dados reais (CrUX) mais recentes das páginas-chave. */
  crux?: Array<{ target: string; label: string; formFactor: string; periodEnd: string; lcpP75: number | null; inpP75: number | null; clsP75: number | null }>;
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
  // Dados reais (CrUX): p75 acima dos limiares nas páginas-chave.
  if (t.cruxEnabled) {
    for (const c of inp.crux ?? []) {
      const bad: string[] = [];
      let critical = false;
      if (c.lcpP75 != null && c.lcpP75 > t.cruxLcpMs) { bad.push(`LCP ${fmtSec(c.lcpP75)} (máx. ${fmtSec(t.cruxLcpMs)})`); critical ||= c.lcpP75 > PS_THRESHOLDS.lcpMs[1]; }
      if (c.inpP75 != null && c.inpP75 > t.cruxInpMs) { bad.push(`INP ${c.inpP75} ms (máx. ${t.cruxInpMs} ms)`); critical ||= c.inpP75 > PS_THRESHOLDS.inpMs[1]; }
      if (c.clsP75 != null && c.clsP75 > t.cruxCls) { bad.push(`CLS ${c.clsP75.toFixed(2).replace(".", ",")} (máx. ${String(t.cruxCls).replace(".", ",")})`); critical ||= c.clsP75 > PS_THRESHOLDS.cls[1]; }
      if (!bad.length) continue;
      out.push({
        code: "crux_poor", level: critical ? "critical" : "warning", key: `crux:${c.target}:${c.formFactor}:${c.periodEnd}`,
        title: `Experiência real lenta (${c.formFactor === "DESKTOP" ? "computador" : "telemóvel"}): ${c.label}`,
        detail: `Visitantes reais (Chrome, 28 dias até ${c.periodEnd.slice(8, 10)}/${c.periodEnd.slice(5, 7)}, p75): ${bad.join("; ")}.`,
      });
    }
  }
  return out;
}

const fmtSec = (ms: number) => `${(ms / 1000).toFixed(1).replace(".", ",")} s`;

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

// ─── Chrome UX Report (dados reais) ─────────────────────────────────────────

export const CRUX_METRICS = ["lcp", "inp", "cls", "fcp", "ttfb"] as const;
export type CruxMetric = (typeof CRUX_METRICS)[number];
export const CRUX_API_NAMES: Record<CruxMetric, string[]> = {
  lcp: ["largest_contentful_paint"],
  inp: ["interaction_to_next_paint"],
  cls: ["cumulative_layout_shift"],
  fcp: ["first_contentful_paint"],
  ttfb: ["experimental_time_to_first_byte", "time_to_first_byte"],
};
/** Limiares Google [bom até, a melhorar até] (ms; CLS sem unidade). */
export const CRUX_THRESHOLDS: Record<CruxMetric, [number, number]> = {
  lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25], fcp: [1800, 3000], ttfb: [800, 1800],
};
export const CRUX_FORM_FACTORS = ["PHONE", "DESKTOP"] as const;
export type CruxFormFactor = (typeof CRUX_FORM_FACTORS)[number];
/** Uma consulta por alvo × dispositivo por semana (a CrUX atualiza 1×/semana). */
export const CRUX_INTERVAL_DAYS = 7;

export interface CruxDist { good: number; ni: number; poor: number }
export interface CruxPeriodRow {
  periodStart: string;
  periodEnd: string;
  p75: Record<CruxMetric, number | null>;
  dist: Record<CruxMetric, CruxDist | null>;
}

export function cruxLevel(metric: CruxMetric, v: number | null | undefined): PsLevel | null {
  if (v == null || !Number.isFinite(v)) return null;
  const [g, ni] = CRUX_THRESHOLDS[metric];
  return v <= g ? "good" : v <= ni ? "needs_improvement" : "poor";
}

const numOrNull = (v: unknown): number | null => {
  if (v == null || v === "NaN") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const cruxDate = (d: any): string | null => {
  const y = Number(d?.year), m = Number(d?.month), day = Number(d?.day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(day)) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};
const roundP75 = (metric: CruxMetric, v: number | null) => (v == null ? null : metric === "cls" ? Math.round(v * 1000) / 1000 : Math.round(v));
const roundFrac = (v: number) => Math.max(0, Math.min(1, Math.round(v * 10_000) / 10_000));

/**
 * Resposta do `records:queryHistoryRecord` (até 25 períodos semanais de 28
 * dias) → uma linha por período. Valores em falta ("NaN") ficam null. Também
 * aceita a resposta do `records:queryRecord` (um só período). PURA.
 */
export function parseCruxHistory(res: any): CruxPeriodRow[] {
  const rec = res?.record ?? {};
  const metrics = rec.metrics ?? {};
  const single = !Array.isArray(rec.collectionPeriods);
  const periods: any[] = single ? (rec.collectionPeriod ? [rec.collectionPeriod] : []) : rec.collectionPeriods;
  const rows: CruxPeriodRow[] = periods.map((p) => ({
    periodStart: cruxDate(p?.firstDate) ?? "",
    periodEnd: cruxDate(p?.lastDate) ?? "",
    p75: { lcp: null, inp: null, cls: null, fcp: null, ttfb: null },
    dist: { lcp: null, inp: null, cls: null, fcp: null, ttfb: null },
  }));
  for (const metric of CRUX_METRICS) {
    const m = CRUX_API_NAMES[metric].map((k) => metrics[k]).find(Boolean);
    if (!m) continue;
    const p75s: unknown[] = single ? [m.percentiles?.p75] : Array.isArray(m.percentilesTimeseries?.p75s) ? m.percentilesTimeseries.p75s : [];
    const bins: any[] = single ? (Array.isArray(m.histogram) ? m.histogram : []) : Array.isArray(m.histogramTimeseries) ? m.histogramTimeseries : [];
    rows.forEach((row, i) => {
      row.p75[metric] = roundP75(metric, numOrNull(p75s[i]));
      if (bins.length >= 3) {
        const at = (b: any) => numOrNull(single ? b?.density : Array.isArray(b?.densities) ? b.densities[i] : null);
        const good = at(bins[0]), ni = at(bins[1]), poor = at(bins[2]);
        row.dist[metric] = good == null && ni == null && poor == null ? null : { good: roundFrac(good ?? 0), ni: roundFrac(ni ?? 0), poor: roundFrac(poor ?? 0) };
      }
    });
  }
  return rows.filter((r) => r.periodStart && r.periodEnd && CRUX_METRICS.some((k) => r.p75[k] != null));
}

export interface CruxTarget { type: "origin" | "url"; target: string; label: string; keyUrl: boolean }

/** Alvos CrUX: a origem de cada página (uma vez) e a própria página. PURA. */
export function cruxTargets(urls: ReadonlyArray<{ url: string; label?: string; keyUrl?: boolean }>): CruxTarget[] {
  const out: CruxTarget[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    let origin: string;
    try { origin = new URL(u.url).origin; } catch { continue; }
    if (!seen.has(`o:${origin}`)) { seen.add(`o:${origin}`); out.push({ type: "origin", target: origin, label: `${new URL(origin).host} (site todo)`, keyUrl: false }); }
    if (!seen.has(`u:${u.url}`)) { seen.add(`u:${u.url}`); out.push({ type: "url", target: u.url, label: u.label || u.url, keyUrl: u.keyUrl ?? true }); }
  }
  return out;
}

export const cruxCheckKey = (t: Pick<CruxTarget, "type" | "target">, ff: CruxFormFactor) => `${t.type}:${t.target}:${ff}`;

/** Alvos × dispositivos a consultar hoje (sem consulta nos últimos 7 dias). PURA. */
export function cruxDue(targets: readonly CruxTarget[], checked: ReadonlyMap<string, string>, today: string): Array<{ target: CruxTarget; formFactor: CruxFormFactor }> {
  const limit = addDays(today, -CRUX_INTERVAL_DAYS);
  const out: Array<{ target: CruxTarget; formFactor: CruxFormFactor }> = [];
  for (const t of targets) for (const ff of CRUX_FORM_FACTORS) {
    const d = checked.get(cruxCheckKey(t, ff));
    if (!d || d <= limit) out.push({ target: t, formFactor: ff });
  }
  return out;
}

// ─── Lighthouse: "o que corrigir primeiro" ─────────────────────────────────

export interface LighthouseAudit {
  id: string;
  kind: "opportunity" | "diagnostic";
  title: string;
  displayValue: string | null;
  savingsMs: number | null;
  savingsBytes: number | null;
  score: number | null;
}

const LH_SKIP_MODES = new Set(["informative", "notApplicable", "manual", "error"]);
const cleanTitle = (s: unknown) => String(s ?? "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/`/g, "").replace(/\s+/g, " ").trim().slice(0, 300);

/**
 * Oportunidades e diagnósticos do Lighthouse (categoria desempenho) que
 * falharam, com a poupança estimada: `details.overallSavingsMs/Bytes` (ou
 * `metricSavings` nas versões novas). As métricas em si (LCP, CLS…) ficam de fora. PURA.
 */
export function extractLighthouseAudits(res: any, max = 15): LighthouseAudit[] {
  const lh = res?.lighthouseResult ?? res;
  const audits = lh?.audits ?? {};
  const refs: any[] = Array.isArray(lh?.categories?.performance?.auditRefs) ? lh.categories.performance.auditRefs : Object.keys(audits).map((id) => ({ id }));
  const out: LighthouseAudit[] = [];
  for (const ref of refs) {
    if (ref?.group === "metrics" || ref?.group === "hidden") continue;
    const a = audits[ref?.id];
    if (!a || typeof a !== "object") continue;
    if (LH_SKIP_MODES.has(String(a.scoreDisplayMode ?? ""))) continue;
    const score = typeof a.score === "number" ? a.score : null;
    if (score == null || score >= 0.9) continue;
    const d = a.details ?? {};
    const ms = numOrNull(d.overallSavingsMs);
    const metricMs = a.metricSavings && typeof a.metricSavings === "object"
      ? Math.max(0, ...["LCP", "FCP", "TBT", "INP"].map((k) => numOrNull(a.metricSavings[k]) ?? 0)) : 0;
    const savingsMs = ms != null && ms > 0 ? Math.round(ms) : metricMs > 0 ? Math.round(metricMs) : null;
    const bytes = numOrNull(d.overallSavingsBytes);
    const savingsBytes = bytes != null && bytes > 0 ? Math.round(bytes) : null;
    const kind: LighthouseAudit["kind"] = d.type === "opportunity" || savingsMs != null || savingsBytes != null ? "opportunity" : "diagnostic";
    const title = cleanTitle(a.title);
    if (!title) continue;
    out.push({ id: String(ref.id).slice(0, 80), kind, title, displayValue: a.displayValue ? cleanTitle(a.displayValue).slice(0, 160) : null, savingsMs, savingsBytes, score: Math.round(score * 100) / 100 });
  }
  return rankFixFirst(out).slice(0, max);
}

/** Ordem "o que corrigir primeiro": oportunidades com mais tempo poupado, depois bytes, depois pior pontuação. PURA. */
export function rankFixFirst(list: readonly LighthouseAudit[]): LighthouseAudit[] {
  return [...list].sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === "opportunity" ? -1 : 1)
    || (b.savingsMs ?? 0) - (a.savingsMs ?? 0)
    || (b.savingsBytes ?? 0) - (a.savingsBytes ?? 0)
    || (a.score ?? 1) - (b.score ?? 1)
    || a.id.localeCompare(b.id));
}

/** Marca adivinhada pelo domínio da página (redpark.pt → redpark). PURA. */
export function brandOfUrl(url: string): WebBrand | null {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  const order = [...WEB_BRAND_IDS].sort((a, b) => b.length - a.length);
  return (order.find((b) => host.includes(b)) as WebBrand | undefined) ?? null;
}

/**
 * Colar várias páginas de uma vez (uma por linha; "URL | nome" opcional):
 * devolve as válidas (sem repetidas nem as que já existem) e as recusadas. PURA.
 */
export function parseBulkUrls(text: string, existing: readonly string[] = []): { add: Array<{ url: string; label: string; brand: WebBrand | "" }>; rejected: string[] } {
  const have = new Set(existing);
  const add: Array<{ url: string; label: string; brand: WebBrand | "" }> = [];
  const rejected: string[] = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [u, ...rest] = line.split("|");
    const url = normalizePagespeedUrl(u.trim());
    if (!url) { rejected.push(line.slice(0, 120)); continue; }
    if (have.has(url)) continue;
    have.add(url);
    add.push({ url, label: rest.join("|").trim().slice(0, 80), brand: brandOfUrl(url) ?? "" });
  }
  return { add, rejected };
}
