/**
 * Google Business Profile (Marketing → Web & SEO → Google Business) — regras
 * PURAS partilhadas servidor ↔ cliente:
 *
 *  - definições (`marketing.googleBusiness`, só super admin): recolha, histórico,
 *    associação de cada perfil a cidade/marca e limiares dos alertas;
 *  - Performance API (fetchMultiDailyMetricsTimeSeries): pedido e leitura;
 *  - pesquisas mensais (searchkeywords.impressions.monthly) e meses a recolher;
 *  - horário normal e horários especiais (feriados): leitura, validação e o
 *    patch (Business Information API, updateMask);
 *  - publicações ("Novidades", ofertas, eventos — v4 localPosts);
 *  - KPIs das críticas (média, volume, taxa e tempo de resposta);
 *  - alertas (estrelas a cair, críticas sem resposta, impressões/chamadas a
 *    cair, perfil suspenso/alterado pela Google);
 *  - ligação ao negócio (chamadas e pedidos de direções vs reservas por cidade).
 *
 * Só agregados: a Performance API devolve totais por dia; as críticas são
 * contadas, nunca copiadas para aqui.
 */
import { z } from "zod";
import { CITY_KEYS, CITY_LABELS, matchCityKey, type CityKey } from "./city";
import { MAIL_BRAND_IDS, MAIL_BRAND_LABELS, type MailBrand } from "./mail";
import { addDays, daysInRange } from "./lisbonDay";

export const GBP_SETTING_KEY = "marketing.googleBusiness";
export const GBP_LOCATION_PATTERN = /^locations\/\d+$/;

// ─── Definições ─────────────────────────────────────────────────────────────

const cityField = z.union([z.enum(CITY_KEYS), z.literal("")]).default("");
const brandField = z.union([z.enum(MAIL_BRAND_IDS), z.literal("")]).default("");

const locationMapEntrySchema = z.object({
  locationName: z.string().trim().regex(GBP_LOCATION_PATTERN, "Perfil Google inválido (locations/…)."),
  city: cityField,
  brand: brandField,
  /** Desligado = fica fora dos totais, dos alertas e da recolha de desempenho. */
  active: z.boolean().default(true),
});
export type GbpLocationMapEntry = z.output<typeof locationMapEntrySchema>;

export const gbpAlertsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Média das estrelas dos últimos 7 dias abaixo da média dos 90 dias anteriores em ≥ X estrelas. */
  ratingDrop: z.number().min(0.1).max(3).default(0.5),
  /** Mínimo de críticas nos 7 dias para avaliar a média. */
  ratingMinReviews: z.number().int().min(1).max(100).default(3),
  /** Críticas importadas pela API sem resposta há mais de N horas. */
  unansweredHours: z.number().int().min(1).max(720).default(48),
  /** Impressões da última semana abaixo da anterior em ≥ X%. */
  impressionsDropPct: z.number().min(5).max(95).default(30),
  /** Chamadas da última semana abaixo da anterior em ≥ X%. */
  callsDropPct: z.number().min(5).max(95).default(30),
  /** Bases mínimas (por semana) para não alarmar com números pequenos. */
  minImpressions: z.number().int().min(0).max(1_000_000).default(200),
  minCalls: z.number().int().min(0).max(100_000).default(10),
  /** Perfil suspenso/sem verificação, fechado, alterado pela Google ou com edições pendentes. */
  profileStatus: z.boolean().default(true),
});
export type GbpAlertThresholds = z.output<typeof gbpAlertsSchema>;

export const gbpConfigSchema = z.object({
  /** Recolha diária do desempenho (impressões, chamadas, direções…) e das pesquisas. */
  enabled: z.boolean().default(true),
  /** Dias de histórico na 1.ª recolha (a API guarda ~18 meses). */
  backfillDays: z.number().int().min(30).max(540).default(180),
  /** Hora (Lisboa) a partir da qual se relêem os últimos dias. */
  refreshHour: z.number().int().min(0).max(23).default(8),
  /** Pesquisas mensais que mostram o perfil (1 pedido por perfil × mês). */
  keywords: z.boolean().default(true),
  /** Cidade/marca de cada perfil (vazio = adivinhado pelo parque associado, título ou morada). */
  locationMap: z.array(locationMapEntrySchema).max(200, "No máximo 200 perfis.").default([]),
  alerts: gbpAlertsSchema.prefault({}),
  /** Rascunho de publicações com IA (lite) — respeita também o interruptor AI_GBP_POSTS. */
  aiPostDrafts: z.boolean().default(true),
}).superRefine((v, ctx) => {
  const seen = new Set<string>();
  for (const e of v.locationMap) {
    if (seen.has(e.locationName)) ctx.addIssue({ code: "custom", message: `Perfil repetido: ${e.locationName}` });
    seen.add(e.locationName);
  }
});
export type GbpConfig = z.output<typeof gbpConfigSchema>;
export const DEFAULT_GBP_CONFIG: GbpConfig = gbpConfigSchema.parse({});

export function parseGbpConfig(raw: unknown): GbpConfig {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { v = {}; } }
  const r = gbpConfigSchema.safeParse(v && typeof v === "object" ? v : {});
  return r.success ? r.data : DEFAULT_GBP_CONFIG;
}

// ─── Cidade / marca de cada perfil ──────────────────────────────────────────

const norm = (s: string | null | undefined) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Marca no título/morada ("Redpark Lisboa Aeroporto" → redpark). Nomes mais longos primeiro. PURA. */
export function guessBrand(text: string | null | undefined): MailBrand | null {
  const t = norm(text).replace(/[^a-z0-9]+/g, " ");
  const compact = t.replace(/\s+/g, "");
  const order = [...MAIL_BRAND_IDS].sort((a, b) => b.length - a.length);
  for (const b of order) if (compact.includes(b)) return b;
  return null;
}

export interface LocationMappingInput {
  locationName: string;
  title: string;
  address: string | null;
  /** Cidade/marca do parque associado nas Críticas (árvore de projetos), se houver. */
  projectCity?: CityKey | null;
  projectBrand?: MailBrand | null;
}
export interface ResolvedMapping { city: CityKey | null; brand: MailBrand | null; active: boolean; source: "manual" | "project" | "auto" | "none" }

/**
 * Cidade e marca de um perfil: o que estiver nas Definições ganha; senão o
 * parque associado (Críticas); senão adivinha pela morada/título. PURA.
 */
export function resolveLocationMapping(loc: LocationMappingInput, map: readonly GbpLocationMapEntry[]): ResolvedMapping {
  const m = map.find((e) => e.locationName === loc.locationName);
  const autoCity = loc.projectCity ?? matchCityKey(loc.address) ?? matchCityKey(loc.title);
  const autoBrand = loc.projectBrand ?? guessBrand(loc.title) ?? null;
  const source: ResolvedMapping["source"] = m && (m.city || m.brand) ? "manual" : loc.projectCity || loc.projectBrand ? "project" : autoCity || autoBrand ? "auto" : "none";
  const city: CityKey | null = m?.city ? m.city : autoCity;
  const brand: MailBrand | null = m?.brand ? m.brand : autoBrand;
  return { city, brand, active: m ? m.active : true, source };
}

export const GBP_CITY_LABELS = CITY_LABELS;
export const GBP_BRAND_LABELS = MAIL_BRAND_LABELS;

// ─── Performance API ────────────────────────────────────────────────────────

export const GBP_DAILY_METRICS = [
  { api: "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", col: "impDesktopMaps", label: "Impressões no Maps (computador)" },
  { api: "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", col: "impDesktopSearch", label: "Impressões na Pesquisa (computador)" },
  { api: "BUSINESS_IMPRESSIONS_MOBILE_MAPS", col: "impMobileMaps", label: "Impressões no Maps (telemóvel)" },
  { api: "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", col: "impMobileSearch", label: "Impressões na Pesquisa (telemóvel)" },
  { api: "CALL_CLICKS", col: "callClicks", label: "Chamadas" },
  { api: "WEBSITE_CLICKS", col: "websiteClicks", label: "Cliques no site" },
  { api: "BUSINESS_DIRECTION_REQUESTS", col: "directionRequests", label: "Pedidos de direções" },
  { api: "BUSINESS_CONVERSATIONS", col: "conversations", label: "Conversas" },
  { api: "BUSINESS_BOOKINGS", col: "bookings", label: "Marcações pelo Google" },
] as const;
export type GbpMetricCol = (typeof GBP_DAILY_METRICS)[number]["col"];
export const GBP_METRIC_COLS = GBP_DAILY_METRICS.map((m) => m.col) as GbpMetricCol[];
export type GbpMetricValues = Record<GbpMetricCol, number>;
export interface GbpDayRow { day: string; values: GbpMetricValues }

export const emptyGbpValues = (): GbpMetricValues => Object.fromEntries(GBP_METRIC_COLS.map((c) => [c, 0])) as GbpMetricValues;

/** Atraso dos dados (dias) e dias relidos 1×/dia depois da hora da atualização. */
export const GBP_LAG_DAYS = 2;
export const GBP_REFETCH_DAYS = 5;
/** Dias por pedido (1 pedido por perfil traz todas as métricas). */
export const GBP_CHUNK_DAYS = 90;

const dateParts = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return { year: y, month: m, day: d };
};

/** Parâmetros de fetchMultiDailyMetricsTimeSeries (métricas repetidas + intervalo). PURA. */
export function performanceParams(from: string, to: string): Array<[string, string]> {
  const s = dateParts(from), e = dateParts(to);
  return [
    ...GBP_DAILY_METRICS.map((m) => ["dailyMetrics", m.api] as [string, string]),
    ["dailyRange.start_date.year", String(s.year)], ["dailyRange.start_date.month", String(s.month)], ["dailyRange.start_date.day", String(s.day)],
    ["dailyRange.end_date.year", String(e.year)], ["dailyRange.end_date.month", String(e.month)], ["dailyRange.end_date.day", String(e.day)],
  ];
}

const pad2 = (n: number) => String(n).padStart(2, "0");
export function apiDateToIso(d: any): string | null {
  const y = Number(d?.year), m = Number(d?.month), day = Number(d?.day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(day) || y < 2000 || m < 1 || m > 12 || day < 1 || day > 31) return null;
  return `${y}-${pad2(m)}-${pad2(day)}`;
}

/**
 * Resposta → uma linha por dia do intervalo (a API omite os valores 0, por
 * isso os dias sem valor ficam a 0 — reler a janela dá o mesmo resultado).
 * Métricas desconhecidas são ignoradas. PURA.
 */
export function parsePerformance(res: any, from: string, to: string): GbpDayRow[] {
  const byDay = new Map<string, GbpMetricValues>(daysInRange(from, to).map((d) => [d, emptyGbpValues()]));
  const colOf = new Map<string, GbpMetricCol>(GBP_DAILY_METRICS.map((m) => [m.api, m.col]));
  const groups: any[] = Array.isArray(res?.multiDailyMetricTimeSeries) ? res.multiDailyMetricTimeSeries : [];
  for (const g of groups) {
    const series: any[] = Array.isArray(g?.dailyMetricTimeSeries) ? g.dailyMetricTimeSeries : [];
    for (const s of series) {
      const col = colOf.get(String(s?.dailyMetric ?? ""));
      if (!col) continue;
      const values: any[] = Array.isArray(s?.timeSeries?.datedValues) ? s.timeSeries.datedValues : [];
      for (const v of values) {
        const day = apiDateToIso(v?.date);
        if (!day || !byDay.has(day)) continue;
        const n = Number(v?.value ?? 0);
        byDay.get(day)![col] = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
      }
    }
  }
  return Array.from(byDay, ([day, values]) => ({ day, values }));
}

export const sumGbpValues = (rows: ReadonlyArray<{ values: GbpMetricValues } | GbpMetricValues>): GbpMetricValues => {
  const out = emptyGbpValues();
  for (const r of rows) {
    const v = ("values" in r ? r.values : r) as GbpMetricValues;
    for (const c of GBP_METRIC_COLS) out[c] += Number(v[c] ?? 0);
  }
  return out;
};
export const gbpImpressions = (v: GbpMetricValues) => v.impDesktopMaps + v.impDesktopSearch + v.impMobileMaps + v.impMobileSearch;
export const gbpActions = (v: GbpMetricValues) => v.callClicks + v.websiteClicks + v.directionRequests + v.conversations + v.bookings;

// ─── Pesquisas mensais ──────────────────────────────────────────────────────

export const GBP_KEYWORD_PAGE_SIZE = 100;
export const GBP_KEYWORD_MAX_PAGES = 5;

export const monthOf = (day: string) => day.slice(0, 7);
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
}

/** Parâmetros de searchkeywords.impressions.monthly para UM mês. PURA. */
export function keywordsParams(month: string, pageToken = ""): Array<[string, string]> {
  const [y, m] = month.split("-");
  const out: Array<[string, string]> = [
    ["monthlyRange.start_month.year", String(Number(y))], ["monthlyRange.start_month.month", String(Number(m))],
    ["monthlyRange.end_month.year", String(Number(y))], ["monthlyRange.end_month.month", String(Number(m))],
    ["pageSize", String(GBP_KEYWORD_PAGE_SIZE)],
  ];
  if (pageToken) out.push(["pageToken", pageToken]);
  return out;
}

export interface GbpKeywordRow { keyword: string; impressions: number | null; threshold: number | null }

/**
 * Resposta → pesquisas. A Google esconde os valores pequenos: vem
 * `threshold` ("< 15") em vez de `value`. PURA.
 */
export function parseKeywords(res: any): { rows: GbpKeywordRow[]; nextPageToken: string | null } {
  const list: any[] = Array.isArray(res?.searchKeywordsCounts) ? res.searchKeywordsCounts : [];
  const rows: GbpKeywordRow[] = [];
  for (const k of list) {
    const keyword = String(k?.searchKeyword ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!keyword) continue;
    const v = k?.insightsValue ?? {};
    const value = v.value != null && Number.isFinite(Number(v.value)) ? Math.round(Number(v.value)) : null;
    const threshold = value == null && v.threshold != null && Number.isFinite(Number(v.threshold)) ? Math.round(Number(v.threshold)) : null;
    rows.push({ keyword, impressions: value, threshold });
  }
  const next = typeof res?.nextPageToken === "string" && res.nextPageToken ? res.nextPageToken : null;
  return { rows, nextPageToken: next };
}

/**
 * Meses a recolher (AAAA-MM): os meses completos desde o início do histórico
 * que ainda não foram lidos, e o mês passado relido 1×/dia durante a 1.ª
 * semana do mês (os números acertam nos primeiros dias). PURA.
 */
export function keywordMonthsDue(fetched: Readonly<Record<string, string>>, today: string, backfillDays: number): string[] {
  const prev = addMonths(monthOf(today), -1);
  const start = monthOf(addDays(today, -Math.max(31, backfillDays)));
  const out: string[] = [];
  const firstOfMonth = `${monthOf(today)}-01`;
  for (let m = start; m <= prev; m = addMonths(m, 1)) {
    const f = fetched[m];
    if (!f) out.push(m);
    else if (m === prev && f !== today && f < addDays(firstOfMonth, 7)) out.push(m);
  }
  // Mais recentes primeiro (o que interessa aparece logo).
  return out.reverse();
}

// ─── Horários ───────────────────────────────────────────────────────────────

export const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABELS: Record<Weekday, string> = {
  MONDAY: "Segunda", TUESDAY: "Terça", WEDNESDAY: "Quarta", THURSDAY: "Quinta", FRIDAY: "Sexta", SATURDAY: "Sábado", SUNDAY: "Domingo",
};

export interface ApiTime { hours?: number; minutes?: number }
export interface ApiTimePeriod { openDay: Weekday; openTime: ApiTime; closeDay: Weekday; closeTime: ApiTime }
export interface ApiDate { year: number; month: number; day: number }
export interface ApiSpecialPeriod { startDate: ApiDate; openTime?: ApiTime; endDate?: ApiDate; closeTime?: ApiTime; closed?: boolean }

export interface Interval { open: string; close: string }
export interface DayHours { day: Weekday; mode: "closed" | "open24" | "intervals"; intervals: Interval[] }
export interface SpecialDay { date: string; closed: boolean; intervals: Interval[] }

export class GbpValidationError extends Error {
  constructor(message: string) { super(message); this.name = "GbpValidationError"; }
}

const HHMM = /^([01]\d|2[0-4]):([0-5]\d)$/;
export function parseHHMM(s: string, allow24 = false): number | null {
  const m = HHMM.exec(String(s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h === 24 && (min !== 0 || !allow24)) return null;
  return h * 60 + min;
}
const toApiTime = (mins: number): ApiTime => {
  const hours = Math.floor(mins / 60), minutes = mins % 60;
  return { ...(hours ? { hours } : {}), ...(minutes ? { minutes } : {}) };
};
const apiTimeMins = (t: ApiTime | undefined | null) => (Number(t?.hours ?? 0) * 60) + Number(t?.minutes ?? 0);
const fmtMins = (mins: number) => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
const nextWeekday = (d: Weekday): Weekday => WEEKDAYS[(WEEKDAYS.indexOf(d) + 1) % 7];

/** Horário da API → 7 dias editáveis (Segunda a Domingo). PURA. */
export function parseRegularHours(api: { periods?: ApiTimePeriod[] } | null | undefined): DayHours[] {
  const out: DayHours[] = WEEKDAYS.map((day) => ({ day, mode: "closed", intervals: [] }));
  for (const p of api?.periods ?? []) {
    const d = out.find((x) => x.day === p.openDay);
    if (!d) continue;
    const open = apiTimeMins(p.openTime), close = apiTimeMins(p.closeTime);
    if (p.closeDay === p.openDay && open === 0 && close >= 24 * 60) { d.mode = "open24"; d.intervals = []; continue; }
    if (d.mode === "open24") continue;
    d.mode = "intervals";
    d.intervals.push({ open: fmtMins(open), close: fmtMins(Math.min(close, 24 * 60)) });
  }
  for (const d of out) d.intervals.sort((a, b) => a.open.localeCompare(b.open));
  return out;
}

/** Intervalos de um dia → minutos, validados (sobreposições, fecho depois da meia-noite). */
function validateIntervals(intervals: readonly Interval[], what: string): Array<{ open: number; close: number; crosses: boolean }> {
  if (!intervals.length) throw new GbpValidationError(`${what}: indica pelo menos um intervalo ou marca como fechado.`);
  if (intervals.length > 6) throw new GbpValidationError(`${what}: no máximo 6 intervalos.`);
  const list = intervals.map((i) => {
    const open = parseHHMM(i.open), close = parseHHMM(i.close, true);
    if (open == null || close == null) throw new GbpValidationError(`${what}: hora inválida (usa HH:MM, ex.: 08:30).`);
    if (open === close) throw new GbpValidationError(`${what}: a abertura e o fecho não podem ser iguais.`);
    // Fecho antes da abertura = fecha depois da meia-noite (ex.: 22:00–02:00).
    return { open, close, crosses: close < open };
  }).sort((a, b) => a.open - b.open);
  for (let i = 1; i < list.length; i++) {
    const prevEnd = list[i - 1].crosses ? 24 * 60 : list[i - 1].close;
    if (list[i].open < prevEnd) throw new GbpValidationError(`${what}: intervalos sobrepostos.`);
  }
  if (list.slice(0, -1).some((x) => x.crosses)) throw new GbpValidationError(`${what}: só o último intervalo pode passar da meia-noite.`);
  return list;
}

/** 7 dias editáveis → `regularHours` da API (valida tudo). PURA. */
export function buildRegularHours(week: readonly DayHours[]): { periods: ApiTimePeriod[] } {
  const periods: ApiTimePeriod[] = [];
  const seen = new Set<Weekday>();
  for (const d of week) {
    if (!(WEEKDAYS as readonly string[]).includes(d.day)) throw new GbpValidationError("Dia da semana inválido.");
    if (seen.has(d.day)) throw new GbpValidationError(`${WEEKDAY_LABELS[d.day]} repetido.`);
    seen.add(d.day);
    if (d.mode === "closed") continue;
    if (d.mode === "open24") { periods.push({ openDay: d.day, openTime: {}, closeDay: d.day, closeTime: { hours: 24 } }); continue; }
    for (const i of validateIntervals(d.intervals, WEEKDAY_LABELS[d.day])) {
      periods.push({ openDay: d.day, openTime: toApiTime(i.open), closeDay: i.crosses ? nextWeekday(d.day) : d.day, closeTime: toApiTime(i.close) });
    }
  }
  if (!periods.length) throw new GbpValidationError("O horário não pode ficar todo fechado (usa um horário especial ou marca o perfil como fechado no Google).");
  return { periods };
}

const isoToApiDate = (iso: string): ApiDate => dateParts(iso);
const validIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && apiDateToIso(dateParts(s)) === s && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Horários especiais da API → lista por dia (ordenada). PURA. */
export function parseSpecialHours(api: { specialHourPeriods?: ApiSpecialPeriod[] } | null | undefined): SpecialDay[] {
  const by = new Map<string, SpecialDay>();
  for (const p of api?.specialHourPeriods ?? []) {
    const date = apiDateToIso(p.startDate);
    if (!date) continue;
    const e = by.get(date) ?? { date, closed: false, intervals: [] };
    if (p.closed) { e.closed = true; e.intervals = []; }
    else if (!e.closed) e.intervals.push({ open: fmtMins(apiTimeMins(p.openTime)), close: fmtMins(Math.min(apiTimeMins(p.closeTime), 24 * 60)) });
    by.set(date, e);
  }
  return Array.from(by.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/** Máximo de dias para a frente num horário especial. */
export const SPECIAL_HOURS_MAX_DAYS_AHEAD = 730;

/** Lista por dia → `specialHours` da API (valida; dias passados são recusados). PURA. */
export function buildSpecialHours(days: readonly SpecialDay[], today: string): { specialHourPeriods: ApiSpecialPeriod[] } {
  const out: ApiSpecialPeriod[] = [];
  const seen = new Set<string>();
  const maxDay = addDays(today, SPECIAL_HOURS_MAX_DAYS_AHEAD);
  for (const d of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!validIso(d.date)) throw new GbpValidationError(`Data inválida: ${String(d.date).slice(0, 20)}.`);
    if (d.date < today) throw new GbpValidationError(`${d.date}: não se pode definir um horário especial no passado.`);
    if (d.date > maxDay) throw new GbpValidationError(`${d.date}: no máximo 2 anos para a frente.`);
    if (seen.has(d.date)) throw new GbpValidationError(`${d.date} repetido.`);
    seen.add(d.date);
    if (d.closed) {
      if (d.intervals.length) throw new GbpValidationError(`${d.date}: dia fechado não leva horas.`);
      out.push({ startDate: isoToApiDate(d.date), closed: true });
      continue;
    }
    for (const i of validateIntervals(d.intervals, d.date)) {
      out.push({ startDate: isoToApiDate(d.date), openTime: toApiTime(i.open), endDate: isoToApiDate(i.crosses ? addDays(d.date, 1) : d.date), closeTime: toApiTime(i.close) });
    }
  }
  return { specialHourPeriods: out };
}

/**
 * Aplicar horários especiais a vários perfis sem apagar os que cada um já
 * tem: as datas enviadas substituem as mesmas datas; `removeDates` tira;
 * datas passadas caem (a Google já não as mostra). PURA.
 */
export function mergeSpecialDays(existing: readonly SpecialDay[], incoming: readonly SpecialDay[], removeDates: readonly string[], today: string): SpecialDay[] {
  const by = new Map<string, SpecialDay>();
  for (const d of existing) if (d.date >= today) by.set(d.date, d);
  for (const r of removeDates) by.delete(r);
  for (const d of incoming) by.set(d.date, d);
  return Array.from(by.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/** Pedido `locations.patch`: updateMask + corpo. Sem nada para mudar → erro. PURA. */
export function buildHoursPatch(i: { regular?: readonly DayHours[] | null; special?: readonly SpecialDay[] | null; today: string }): { updateMask: string; body: Record<string, unknown> } {
  const mask: string[] = [];
  const body: Record<string, unknown> = {};
  if (i.regular) { body.regularHours = buildRegularHours(i.regular); mask.push("regularHours"); }
  if (i.special) { body.specialHours = buildSpecialHours(i.special, i.today); mask.push("specialHours"); }
  if (!mask.length) throw new GbpValidationError("Nada para alterar.");
  return { updateMask: mask.join(","), body };
}

// ─── Publicações (v4 localPosts) ────────────────────────────────────────────

export const POST_TOPICS = ["STANDARD", "OFFER", "EVENT"] as const;
export type PostTopic = (typeof POST_TOPICS)[number];
export const POST_TOPIC_LABELS: Record<PostTopic, string> = { STANDARD: "Novidade", OFFER: "Oferta", EVENT: "Evento" };
export const POST_CTAS = ["BOOK", "ORDER", "LEARN_MORE", "CALL"] as const;
export type PostCta = (typeof POST_CTAS)[number];
export const POST_CTA_LABELS: Record<PostCta, string> = { BOOK: "Reservar", ORDER: "Encomendar", LEARN_MORE: "Saber mais", CALL: "Ligar" };
export const POST_SUMMARY_MAX = 1500;

const httpsUrl = z.string().trim().max(1000).refine((v) => { try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } }, "Tem de ser um endereço https:// válido.");
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida (AAAA-MM-DD).");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora inválida (HH:MM).");

export const postInputSchema = z.object({
  topicType: z.enum(POST_TOPICS).default("STANDARD"),
  summary: z.string().trim().min(1, "Escreve o texto da publicação.").max(POST_SUMMARY_MAX, `No máximo ${POST_SUMMARY_MAX} caracteres.`),
  languageCode: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default("pt-PT"),
  ctaType: z.union([z.enum(POST_CTAS), z.literal("")]).default(""),
  ctaUrl: z.union([httpsUrl, z.literal("")]).default(""),
  imageUrl: z.union([httpsUrl, z.literal("")]).default(""),
  eventTitle: z.string().trim().max(58, "Título do evento: no máximo 58 caracteres.").default(""),
  startDate: z.union([isoDay, z.literal("")]).default(""),
  endDate: z.union([isoDay, z.literal("")]).default(""),
  startTime: z.union([hhmm, z.literal("")]).default(""),
  endTime: z.union([hhmm, z.literal("")]).default(""),
  couponCode: z.string().trim().max(58).default(""),
  redeemUrl: z.union([httpsUrl, z.literal("")]).default(""),
  terms: z.string().trim().max(5000).default(""),
});
export type PostInput = z.input<typeof postInputSchema>;

const timeObj = (s: string) => { const [h, m] = s.split(":").map(Number); return { hours: h, minutes: m }; };

/** Formulário → corpo do localPost v4 (valida as regras da API). PURA. */
export function buildLocalPost(raw: PostInput): Record<string, unknown> {
  const r = postInputSchema.safeParse(raw);
  if (!r.success) throw new GbpValidationError(r.error.issues.map((i) => i.message).join(" "));
  const p = r.data;
  const body: Record<string, unknown> = { languageCode: p.languageCode, summary: p.summary, topicType: p.topicType };
  if (p.ctaType) {
    if (p.ctaType === "CALL") {
      if (p.ctaUrl) throw new GbpValidationError("O botão \"Ligar\" usa o telefone do perfil — não leva endereço.");
      body.callToAction = { actionType: "CALL" };
    } else {
      if (!p.ctaUrl) throw new GbpValidationError("O botão escolhido precisa de um endereço https://.");
      body.callToAction = { actionType: p.ctaType, url: p.ctaUrl };
    }
  } else if (p.ctaUrl) throw new GbpValidationError("Escolhe o tipo de botão para o endereço indicado.");
  if (p.imageUrl) body.media = [{ mediaFormat: "PHOTO", sourceUrl: p.imageUrl }];
  if (p.topicType === "EVENT" || p.topicType === "OFFER") {
    if (!p.eventTitle) throw new GbpValidationError(`${POST_TOPIC_LABELS[p.topicType]}: indica o título.`);
    if (!p.startDate || !p.endDate) throw new GbpValidationError(`${POST_TOPIC_LABELS[p.topicType]}: indica as datas de início e fim.`);
    if (!validIso(p.startDate) || !validIso(p.endDate)) throw new GbpValidationError("Data inválida.");
    if (p.endDate < p.startDate) throw new GbpValidationError("A data de fim tem de ser depois da de início.");
    if ((p.startTime && !p.endTime) || (!p.startTime && p.endTime)) throw new GbpValidationError("Indica as duas horas (início e fim) ou nenhuma.");
    if (p.startTime && p.startDate === p.endDate && p.endTime <= p.startTime) throw new GbpValidationError("A hora de fim tem de ser depois da de início.");
    body.event = {
      title: p.eventTitle,
      schedule: {
        startDate: isoToApiDate(p.startDate), endDate: isoToApiDate(p.endDate),
        ...(p.startTime ? { startTime: timeObj(p.startTime), endTime: timeObj(p.endTime) } : {}),
      },
    };
  } else if (p.eventTitle || p.startDate || p.endDate) {
    throw new GbpValidationError("Título e datas só se usam em Eventos e Ofertas.");
  }
  if (p.topicType === "OFFER") {
    const offer: Record<string, string> = {};
    if (p.couponCode) offer.couponCode = p.couponCode;
    if (p.redeemUrl) offer.redeemOnlineUrl = p.redeemUrl;
    if (p.terms) offer.termsConditions = p.terms;
    if (Object.keys(offer).length) body.offer = offer;
  } else if (p.couponCode || p.redeemUrl || p.terms) {
    throw new GbpValidationError("Código, endereço de resgate e condições só se usam em Ofertas.");
  }
  return body;
}

export interface GbpPostView { name: string; topicType: string; summary: string; state: string; createTime: string | null; searchUrl: string | null; ctaType: string | null; imageUrl: string | null }

/** localPosts.list → vista curta. PURA. */
export function parsePosts(res: any): GbpPostView[] {
  const list: any[] = Array.isArray(res?.localPosts) ? res.localPosts : [];
  return list.filter((p) => typeof p?.name === "string").map((p) => ({
    name: String(p.name),
    topicType: String(p.topicType ?? "STANDARD"),
    summary: String(p.summary ?? "").slice(0, 1500),
    state: String(p.state ?? ""),
    createTime: typeof p.createTime === "string" ? p.createTime : null,
    searchUrl: typeof p.searchUrl === "string" ? p.searchUrl : null,
    ctaType: typeof p.callToAction?.actionType === "string" ? p.callToAction.actionType : null,
    imageUrl: typeof p.media?.[0]?.googleUrl === "string" ? p.media[0].googleUrl : typeof p.media?.[0]?.sourceUrl === "string" ? p.media[0].sourceUrl : null,
  }));
}
export const POST_NAME_PATTERN = /^accounts\/\d+\/locations\/\d+\/localPosts\/[A-Za-z0-9_-]+$/;

// ─── Críticas: KPIs ─────────────────────────────────────────────────────────

export interface ReviewLite {
  rating: number;
  /** "AAAA-MM-DD HH:MM:SS" (UTC) */
  reviewDate: string | null;
  respondedAt: string | null;
  hasReply: boolean;
}
const tsMs = (s: string | null | undefined) => (s ? Date.parse(`${s.replace(" ", "T")}Z`) : NaN);

export interface ReviewKpis {
  count: number;
  avgRating: number | null;
  responded: number;
  responseRate: number | null;
  /** Mediana das horas entre a crítica e a resposta (só as respondidas com data). */
  medianResponseHours: number | null;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

/** KPIs das críticas (média, volume, taxa e tempo de resposta). PURA. */
export function reviewKpis(reviews: readonly ReviewLite[]): ReviewKpis {
  const distribution: ReviewKpis["distribution"] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0, rated = 0, responded = 0;
  const hours: number[] = [];
  for (const r of reviews) {
    if (r.rating >= 1 && r.rating <= 5) { distribution[r.rating as 1] += 1; sum += r.rating; rated++; }
    if (r.hasReply || r.respondedAt) {
      responded++;
      const a = tsMs(r.reviewDate), b = tsMs(r.respondedAt);
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) hours.push((b - a) / 3_600_000);
    }
  }
  hours.sort((a, b) => a - b);
  const median = hours.length ? (hours.length % 2 ? hours[(hours.length - 1) / 2] : (hours[hours.length / 2 - 1] + hours[hours.length / 2]) / 2) : null;
  return {
    count: reviews.length,
    avgRating: rated ? Math.round((sum / rated) * 100) / 100 : null,
    responded,
    responseRate: reviews.length ? responded / reviews.length : null,
    medianResponseHours: median == null ? null : Math.round(median * 10) / 10,
    distribution,
  };
}

/** Média e volume por semana (segunda-feira). PURA. */
export function ratingByWeek(reviews: readonly ReviewLite[]): Array<{ week: string; count: number; avg: number | null }> {
  const by = new Map<string, { n: number; s: number }>();
  for (const r of reviews) {
    const day = r.reviewDate?.slice(0, 10);
    if (!day || !(r.rating >= 1 && r.rating <= 5)) continue;
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    const week = addDays(day, -((dow + 6) % 7));
    const e = by.get(week) ?? { n: 0, s: 0 };
    e.n++; e.s += r.rating;
    by.set(week, e);
  }
  return Array.from(by, ([week, e]) => ({ week, count: e.n, avg: e.n ? Math.round((e.s / e.n) * 100) / 100 : null })).sort((a, b) => a.week.localeCompare(b.week));
}

// ─── Alertas ────────────────────────────────────────────────────────────────

export interface GbpAlert {
  code: "rating_drop" | "unanswered_reviews" | "impressions_drop" | "calls_drop" | "profile_status";
  /** reviews → tipo "google_reviews_alert" (Críticas, por cidade); business → "google_business_alert" (Marketing). */
  channel: "reviews" | "business";
  level: "critical" | "warning";
  key: string;
  title: string;
  detail: string;
  city: CityKey | null;
  locationId: number;
}

export interface GbpAlertLocation {
  id: number;
  label: string;
  city: CityKey | null;
  /** Semana (7 dias) até ao último dia completo vs a anterior. */
  week?: { cur: { impressions: number; calls: number; days: number }; prev: { impressions: number; calls: number; days: number } } | null;
  ratings?: { last7Avg: number | null; last7Count: number; baseAvg: number | null; baseCount: number } | null;
  unanswered?: { count: number; oldestHours: number } | null;
  status?: { openStatus: string | null; hasVoiceOfMerchant: boolean | null; hasGoogleUpdated: boolean | null; hasPendingEdits: boolean | null } | null;
}
export interface GbpAlertInputs { today: string; weekEnd: string; thresholds: GbpAlertThresholds; locations: GbpAlertLocation[] }

const fmtInt = (x: number) => Math.round(x).toLocaleString("pt-PT");
const fmtStars = (x: number) => x.toFixed(1).replace(".", ",");
const fmtP = (x: number) => `${Math.round(x * 100)}%`;

/** Regras dos alertas do Google Business (configuráveis). PURA. */
export function evaluateGbpAlerts(inp: GbpAlertInputs): GbpAlert[] {
  const t = inp.thresholds;
  if (!t.enabled) return [];
  const out: GbpAlert[] = [];
  const wk = `${inp.weekEnd.slice(8, 10)}/${inp.weekEnd.slice(5, 7)}`;
  for (const l of inp.locations) {
    const r = l.ratings;
    if (r && r.last7Avg != null && r.baseAvg != null && r.last7Count >= t.ratingMinReviews && r.baseCount >= t.ratingMinReviews) {
      const drop = r.baseAvg - r.last7Avg;
      if (drop >= t.ratingDrop) {
        out.push({ code: "rating_drop", channel: "reviews", level: drop >= 1 ? "critical" : "warning", key: `gbp:rating:${l.id}:${inp.today}`, city: l.city, locationId: l.id,
          title: `Estrelas a cair: ${l.label}`,
          detail: `Média de ${fmtStars(r.last7Avg)}★ nas ${r.last7Count} críticas dos últimos 7 dias vs ${fmtStars(r.baseAvg)}★ nos 90 dias anteriores.` });
      }
    }
    const u = l.unanswered;
    if (u && u.count > 0 && u.oldestHours >= t.unansweredHours) {
      out.push({ code: "unanswered_reviews", channel: "reviews", level: u.oldestHours >= t.unansweredHours * 3 ? "critical" : "warning", key: `gbp:unanswered:${l.id}:${inp.today}`, city: l.city, locationId: l.id,
        title: `Críticas sem resposta: ${l.label}`,
        detail: `${u.count} crítica(s) sem resposta há mais de ${t.unansweredHours} h (a mais antiga há ${fmtInt(u.oldestHours)} h). Responde em Críticas.` });
    }
    const w = l.week;
    if (w && w.cur.days >= 7 && w.prev.days >= 7) {
      if (w.prev.impressions >= t.minImpressions && w.prev.impressions > 0) {
        const drop = (w.prev.impressions - w.cur.impressions) / w.prev.impressions;
        if (drop * 100 >= t.impressionsDropPct) {
          out.push({ code: "impressions_drop", channel: "business", level: drop >= 0.5 ? "critical" : "warning", key: `gbp:impr:${l.id}:${inp.weekEnd}`, city: l.city, locationId: l.id,
            title: `Impressões no Google a cair: ${l.label}`,
            detail: `${fmtInt(w.cur.impressions)} impressões na semana até ${wk} vs ${fmtInt(w.prev.impressions)} na anterior (−${fmtP(drop)}).` });
        }
      }
      if (w.prev.calls >= t.minCalls && w.prev.calls > 0) {
        const drop = (w.prev.calls - w.cur.calls) / w.prev.calls;
        if (drop * 100 >= t.callsDropPct) {
          out.push({ code: "calls_drop", channel: "business", level: drop >= 0.5 ? "critical" : "warning", key: `gbp:calls:${l.id}:${inp.weekEnd}`, city: l.city, locationId: l.id,
            title: `Chamadas pelo Google a cair: ${l.label}`,
            detail: `${fmtInt(w.cur.calls)} chamadas na semana até ${wk} vs ${fmtInt(w.prev.calls)} na anterior (−${fmtP(drop)}).` });
        }
      }
    }
    const s = l.status;
    if (t.profileStatus && s) {
      const problems: string[] = [];
      let critical = false;
      if (s.hasVoiceOfMerchant === false) { problems.push("sem controlo do perfil (suspenso ou por verificar)"); critical = true; }
      if (s.openStatus === "CLOSED_PERMANENTLY") { problems.push("marcado como fechado definitivamente"); critical = true; }
      if (s.openStatus === "CLOSED_TEMPORARILY") problems.push("marcado como fechado temporariamente");
      if (s.hasGoogleUpdated) problems.push("a Google alterou dados do perfil (rever e aceitar/recusar no Google)");
      if (s.hasPendingEdits) problems.push("há edições pendentes de aprovação da Google");
      if (problems.length) {
        out.push({ code: "profile_status", channel: "business", level: critical ? "critical" : "warning", key: `gbp:status:${l.id}:${problems.join("|")}`, city: l.city, locationId: l.id,
          title: `Perfil Google a rever: ${l.label}`, detail: `${problems.join("; ")}.` });
      }
    }
  }
  return out;
}

// ─── Negócio: ações no Google vs reservas por cidade ───────────────────────

export interface CityActionsRow { day: string; calls: number; directions: number; website: number; bookings: number }
export interface CityBusinessSummary { city: CityKey; calls: number; directions: number; website: number; bookings: number; actionsPerBooking: number | null; rows: CityActionsRow[] }

/**
 * Junta por cidade × dia as chamadas/direções/cliques do Google com as
 * reservas (mesma regra das Reservas & Operações). Indicador, não atribuição. PURA.
 */
export function gbpBusinessByCity(days: readonly string[],
  actions: ReadonlyMap<CityKey, ReadonlyMap<string, { calls: number; directions: number; website: number }>>,
  bookings: ReadonlyMap<CityKey, ReadonlyMap<string, number>>): CityBusinessSummary[] {
  const cities = CITY_KEYS.filter((c) => actions.has(c) || bookings.has(c));
  return cities.map((city) => {
    const rows = days.map((day) => {
      const a = actions.get(city)?.get(day);
      return { day, calls: a?.calls ?? 0, directions: a?.directions ?? 0, website: a?.website ?? 0, bookings: bookings.get(city)?.get(day) ?? 0 };
    });
    const tot = rows.reduce((t, r) => ({ calls: t.calls + r.calls, directions: t.directions + r.directions, website: t.website + r.website, bookings: t.bookings + r.bookings }), { calls: 0, directions: 0, website: 0, bookings: 0 });
    return { city, ...tot, actionsPerBooking: tot.bookings > 0 ? (tot.calls + tot.directions) / tot.bookings : null, rows };
  });
}
