/**
 * Anomalias (reservas por parque/canal, despesas, marketing): recolha no SQL,
 * deteção em anomalyMath.ts (pura), registo em `ops_anomalies` (dedupKey
 * único → idempotente) e UMA chamada lite por corrida para as explicações.
 *
 * SQL: parametrizado; o dia de Lisboa vem de lisbonDaySql (literais validados,
 * sem parâmetros) → a mesma expressão no SELECT e no GROUP BY
 * (ONLY_FULL_GROUP_BY).
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { addDays, lisbonDayRangeUtc, lisbonDaySql } from "../../shared/lisbonDay";
import { classifyBookingOrigin } from "../../shared/bookingOrigin";
import { bookingCityKey } from "../../shared/originGroup";
import { projectScope } from "../cityScope";
import { ANOMALY_SYSTEM, anomalyExplainSchema } from "../_core/ai/prompts/ops";
import { AiCallCap, oneLine, tryAi } from "./aiCall";
import { cityOfProject, loadCityTrees, opsCityOf, type CityTree, type OpsCity } from "./cities";
import {
  HISTORY_WEEKS,
  detectSeriesAnomalies,
  duplicateExpenses,
  expenseOutliers,
  round2,
  type ExpenseLite,
  type SeriesInput,
  type Severity,
} from "./anomalyMath";

const rowsOf = (res: unknown): any[] => (Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : []) as any[];

export type AnomalyDomain = "bookings" | "expenses" | "marketing";
export const ANOMALY_DOMAINS: readonly AnomalyDomain[] = ["bookings", "expenses", "marketing"];

export interface AnomalyRecord {
  day: string;
  domain: AnomalyDomain;
  kind: string;
  cityKey: OpsCity | null;
  projectId: number | null;
  subject: string;
  value: number;
  expected: number | null;
  zScore: number | null;
  severity: Severity;
  detail: string;
  refIds: string | null;
  dedupKey: string;
}

const EUR = (n: number) => `${n.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const NUM = (n: number) => n.toLocaleString("pt-PT", { maximumFractionDigits: 1 });
const WEEKDAY = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
export const weekdayOf = (day: string) => WEEKDAY[new Date(`${day}T12:00:00Z`).getUTCDay()];
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Frase do código (números exatos) para uma anomalia de série. PURA. */
export function seriesDetail(what: string, day: string, value: number, expected: number, z: number, money = false): string {
  const f = money ? EUR : NUM;
  const dir = value > expected ? "acima" : "abaixo";
  return `${what}: ${f(value)} em ${day} (${weekdayOf(day)}), ${dir} do habitual para este dia da semana (${f(expected)}, média das últimas ${HISTORY_WEEKS} semanas; z = ${NUM(z)}).`;
}

// ─── Reservas por parque e por canal ─────────────────────────────────────────

export interface BookingCountRow { day: string; parkName: string | null; city: string | null; projectId: number | null; origin: string | null; hasPartner: number; hasCampaign: number; n: number }

/** Séries por parque e por (cidade × canal) a partir das contagens do SQL. PURA. */
export function bookingSeries(rows: BookingCountRow[], trees: CityTree[]): { parks: Array<SeriesInput & { city: OpsCity | null }>; channels: Array<SeriesInput & { city: OpsCity | null }> } {
  const parks = new Map<string, SeriesInput & { city: OpsCity | null }>();
  const channels = new Map<string, SeriesInput & { city: OpsCity | null }>();
  const add = (m: Map<string, SeriesInput & { city: OpsCity | null }>, key: string, subject: string, city: OpsCity | null, day: string, n: number) => {
    const s = m.get(key) ?? { subject, city, values: new Map<string, number>() };
    s.values.set(day, (s.values.get(day) ?? 0) + n);
    m.set(key, s);
  };
  for (const r of rows) {
    const tree = cityOfProject(r.projectId, trees);
    const city = tree?.city ?? opsCityOf(bookingCityKey({ parkName: r.parkName, city: r.city }) ?? null);
    const park = (r.parkName ?? "").trim() || "Sem parque";
    add(parks, park.toLowerCase(), park, city, r.day, Number(r.n));
    const ch = classifyBookingOrigin({ origin: r.origin, salesPartnerName: r.hasPartner ? "x" : null, campaign: r.hasCampaign ? "x" : null }).group;
    add(channels, `${city ?? "?"}|${ch}`, `${CHANNEL_LABELS[ch] ?? ch}${city ? ` (${cityLabel(city)})` : ""}`, city, r.day, Number(r.n));
  }
  return { parks: [...parks.values()], channels: [...channels.values()] };
}

const CHANNEL_LABELS: Record<string, string> = { marketplace: "Marketplace", parceiro: "Parceiros", campanha: "Campanhas", telefone: "Telefone", site: "Site", outros: "Outros" };
const cityLabel = (c: OpsCity) => ({ lisbon: "Lisboa", porto: "Porto", faro: "Faro" })[c];

export async function detectBookingAnomalies(day: string, trees: CityTree[]): Promise<AnomalyRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const from = addDays(day, -7 * HISTORY_WEEKS);
  const r = lisbonDayRangeUtc(from, day);
  const d = sql.raw(lisbonDaySql("`bookingCreatedAt`", from, day));
  const partner = sql.raw("(CASE WHEN `partnerName` IS NOT NULL AND `partnerName` <> '' THEN 1 ELSE 0 END)");
  const campaign = sql.raw("(CASE WHEN `campaign` IS NOT NULL AND `campaign` <> '' THEN 1 ELSE 0 END)");
  const rows = rowsOf(await db.execute(sql`
    SELECT ${d} AS day, parkName, city, projectId, origin, ${partner} AS hasPartner, ${campaign} AS hasCampaign, COUNT(*) AS n
      FROM multipark_bookings
     WHERE bookingCreatedAt >= ${r.start} AND bookingCreatedAt < ${r.end}
       AND (status IS NULL OR status <> 'CANCELLED')
     GROUP BY ${d}, parkName, city, projectId, origin, ${partner}, ${campaign}`));
  const counts: BookingCountRow[] = rows.map((x) => ({
    day: String(x.day).slice(0, 10), parkName: x.parkName ?? null, city: x.city ?? null, projectId: x.projectId == null ? null : Number(x.projectId),
    origin: x.origin ?? null, hasPartner: Number(x.hasPartner ?? 0), hasCampaign: Number(x.hasCampaign ?? 0), n: Number(x.n ?? 0),
  }));
  const { parks, channels } = bookingSeries(counts, trees);
  const out: AnomalyRecord[] = [];
  const opts = { fillMissing: true, counts: true, minMagnitude: 5 };
  const cityOf = new Map([...parks, ...channels].map((s) => [s.subject, s.city]));
  for (const [kind, list] of [["park", parks], ["channel", channels]] as const) {
    for (const a of detectSeriesAnomalies(day, list, opts)) {
      const city = cityOf.get(a.subject) ?? null;
      out.push({
        day, domain: "bookings", kind: `bookings_${kind}`, cityKey: city, projectId: city ? trees.find((t) => t.city === city)?.rootId ?? null : null,
        subject: cut(a.subject, 160), value: a.value, expected: a.expected, zScore: a.z, severity: a.severity,
        detail: cut(seriesDetail(`Reservas criadas — ${kind === "park" ? "parque" : "canal"} ${a.subject}`, day, a.value, a.expected, a.z), 500),
        refIds: null, dedupKey: `bookings:${kind}:${day}:${a.subject.toLowerCase()}`.slice(0, 191),
      });
    }
  }
  return out;
}

// ─── Despesas ────────────────────────────────────────────────────────────────

export async function detectExpenseAnomalies(day: string, trees: CityTree[]): Promise<AnomalyRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const from = addDays(day, -180);
  const since = addDays(day, -2); // as últimas 3 datas (lançamentos atrasados)
  const rows = rowsOf(await db.execute(sql`
    SELECT id, DATE_FORMAT(expenseDate, '%Y-%m-%d') AS day, amount, supplier, supplierNif, documentNumber, categoryId, projectId
      FROM expenses
     WHERE expenseDate >= ${`${from} 00:00:00`} AND expenseDate < ${`${addDays(day, 1)} 00:00:00`}
       AND status <> 'cancelled'
     ORDER BY expenseDate, id
     LIMIT 8000`));
  const list: ExpenseLite[] = rows.map((x) => ({
    id: Number(x.id), day: String(x.day), amount: Number(x.amount ?? 0), supplier: x.supplier ?? null, supplierNif: x.supplierNif ?? null,
    documentNumber: x.documentNumber ?? null, categoryId: x.categoryId == null ? null : Number(x.categoryId), projectId: x.projectId == null ? null : Number(x.projectId),
  }));
  const out: AnomalyRecord[] = [];
  const cityFor = (projectId: number | null) => cityOfProject(projectId, trees)?.city ?? null;
  for (const o of expenseOutliers(list, since)) {
    const e = o.expense;
    const who = e.supplier?.trim() || "fornecedor sem nome";
    out.push({
      day: e.day, domain: "expenses", kind: "expense_outlier", cityKey: cityFor(e.projectId), projectId: e.projectId,
      subject: cut(who, 160), value: e.amount, expected: o.median, zScore: o.robustZ, severity: o.severity,
      detail: cut(`Despesa #${e.id} de ${EUR(e.amount)} (${who}, ${e.day}) muito acima do habitual para este ${o.groupLabel} (mediana ${EUR(o.median)}).`, 500),
      refIds: String(e.id), dedupKey: `expenses:outlier:${e.id}`,
    });
  }
  for (const p of duplicateExpenses(list, since)) {
    const who = p.a.supplier?.trim() || "fornecedor sem nome";
    out.push({
      day: p.b.day, domain: "expenses", kind: "expense_duplicate", cityKey: cityFor(p.b.projectId), projectId: p.b.projectId,
      subject: cut(who, 160), value: p.b.amount, expected: null, zScore: null, severity: "warning",
      detail: cut(p.reason === "document"
        ? `Possível duplicado: despesas #${p.a.id} e #${p.b.id} de ${who} com o mesmo nº de documento (${p.a.documentNumber}).`
        : `Possível duplicado: despesas #${p.a.id} (${p.a.day}) e #${p.b.id} (${p.b.day}) de ${who}, ambas de ${EUR(p.b.amount)}.`, 500),
      refIds: `${p.a.id},${p.b.id}`, dedupKey: `expenses:dup:${p.a.id}:${p.b.id}`,
    });
  }
  return out;
}

// ─── Marketing: gasto e ROAS por plataforma ──────────────────────────────────

export interface MarketingDayRow { day: string; provider: string; spend: number; revenue: number }

const PROVIDER_LABEL: Record<string, string> = { google_ads: "Google Ads", meta: "Meta" };

/** Séries de gasto e de ROAS s/ IVA (só dias com gasto ≥ 20 €). PURA. */
export function marketingSeries(rows: MarketingDayRow[], vatRate: number): { spend: SeriesInput[]; roas: SeriesInput[] } {
  const spend = new Map<string, SeriesInput>();
  const roas = new Map<string, SeriesInput>();
  for (const r of rows) {
    const label = PROVIDER_LABEL[r.provider] ?? r.provider;
    const s = spend.get(label) ?? { subject: label, values: new Map() };
    s.values.set(r.day, (s.values.get(r.day) ?? 0) + r.spend);
    spend.set(label, s);
    if (r.spend >= 20) {
      const q = roas.get(label) ?? { subject: label, values: new Map() };
      q.values.set(r.day, round2(r.revenue / (1 + vatRate) / r.spend));
      roas.set(label, q);
    }
  }
  return { spend: [...spend.values()], roas: [...roas.values()] };
}

export async function detectMarketingAnomalies(day: string): Promise<AnomalyRecord[]> {
  const db = await getDb();
  if (!db) return [];
  const from = addDays(day, -7 * HISTORY_WEEKS);
  const spendRows = rowsOf(await db.execute(sql`
    SELECT DATE_FORMAT(m.date, '%Y-%m-%d') AS day, m.provider AS provider, SUM(m.costMicros) AS cost
      FROM ad_daily_metrics m
      JOIN ad_accounts a ON a.id = m.accountId
     WHERE a.selected = 1 AND a.isManager = 0 AND m.source = 'api'
       AND m.date >= ${from} AND m.date <= ${day}
     GROUP BY DATE_FORMAT(m.date, '%Y-%m-%d'), m.provider`));
  if (!spendRows.length) return [];
  const r = lisbonDayRangeUtc(from, day);
  const d = sql.raw(lisbonDaySql("`bookingCreatedAt`", from, day));
  const revRows = rowsOf(await db.execute(sql`
    SELECT ${d} AS day, adAttribution AS attribution, COALESCE(SUM(totalPrice), 0) AS revenue
      FROM multipark_bookings
     WHERE bookingCreatedAt >= ${r.start} AND bookingCreatedAt < ${r.end}
       AND (status IS NULL OR status <> 'CANCELLED')
       AND adAttribution IN ('google_paid', 'meta_paid')
     GROUP BY ${d}, adAttribution`));
  const rev = new Map(revRows.map((x) => [`${String(x.day).slice(0, 10)}|${x.attribution === "meta_paid" ? "meta" : "google_ads"}`, Number(x.revenue ?? 0)]));
  const rows: MarketingDayRow[] = spendRows.map((x) => ({
    day: String(x.day), provider: String(x.provider), spend: Number(x.cost ?? 0) / 1_000_000,
    revenue: rev.get(`${String(x.day)}|${String(x.provider)}`) ?? 0,
  }));
  const { financeRatesAt } = await import("../finance/rates");
  const vat = (await financeRatesAt(day).catch(() => ({ vatRate: 0.23 }))).vatRate;
  const { spend, roas } = marketingSeries(rows, vat);
  const out: AnomalyRecord[] = [];
  for (const a of detectSeriesAnomalies(day, spend, { minMagnitude: 20, minStd: 5 })) {
    out.push({
      day, domain: "marketing", kind: "marketing_spend", cityKey: null, projectId: null, subject: a.subject,
      value: round2(a.value), expected: a.expected, zScore: a.z, severity: a.severity,
      detail: cut(seriesDetail(`Gasto ${a.subject}`, day, round2(a.value), a.expected, a.z, true), 500),
      refIds: null, dedupKey: `marketing:spend:${day}:${a.subject.toLowerCase()}`,
    });
  }
  for (const a of detectSeriesAnomalies(day, roas, { minStd: 0.3 })) {
    out.push({
      day, domain: "marketing", kind: "marketing_roas", cityKey: null, projectId: null, subject: a.subject,
      value: a.value, expected: a.expected, zScore: a.z, severity: a.severity,
      detail: cut(`ROAS s/ IVA ${a.subject}: ${NUM(a.value)}× em ${day} (${weekdayOf(day)}), contra ${NUM(a.expected)}× habitual neste dia da semana (z = ${NUM(a.z)}; reservas atribuídas pelo clique).`, 500),
      refIds: null, dedupKey: `marketing:roas:${day}:${a.subject.toLowerCase()}`,
    });
  }
  return out;
}

// ─── Registo e explicações ───────────────────────────────────────────────────

export async function saveAnomalies(list: AnomalyRecord[]): Promise<number> {
  const db = await getDb();
  if (!db || !list.length) return 0;
  let inserted = 0;
  for (const a of list) {
    const res = await db.execute(sql`
      INSERT IGNORE INTO ops_anomalies (day, domain, kind, cityKey, projectId, subject, value, expected, zScore, severity, detail, refIds, dedupKey)
      VALUES (${a.day}, ${a.domain}, ${a.kind}, ${a.cityKey}, ${a.projectId}, ${a.subject}, ${a.value}, ${a.expected}, ${a.zScore}, ${a.severity}, ${a.detail}, ${a.refIds}, ${a.dedupKey})`);
    const header: any = Array.isArray(res) ? res[0] : res;
    const isNew = Number(header?.affectedRows ?? 0) > 0;
    inserted += isNew ? 1 : 0;
    if (isNew && a.severity === "critical") await notifyAnomaly(a);
  }
  return inserted;
}

const ANOMALY_KIND = { bookings: "anomaly_bookings", expenses: "anomaly_expenses", marketing: "marketing_alert" } as const;
const ANOMALY_LINK = { bookings: "/operacoes", expenses: "/despesas", marketing: "/marketing" } as const;

/** Anomalia CRÍTICA nova → aviso do domínio (reservas/despesas: cidade; marketing: só quem tem o Marketing). Nunca lança. */
async function notifyAnomaly(a: AnomalyRecord): Promise<void> {
  const kind = ANOMALY_KIND[a.domain as keyof typeof ANOMALY_KIND];
  if (!kind) return;
  try {
    const { notify } = await import("../notify");
    await notify({
      kind, projectId: a.projectId ?? null, city: a.cityKey ?? null,
      title: `Anomalia: ${a.subject}`.slice(0, 255), body: a.detail,
      link: ANOMALY_LINK[a.domain as keyof typeof ANOMALY_LINK], entity: { type: "anomaly", id: a.dedupKey },
    });
  } catch { /* o aviso é best-effort */ }
}

/** Pedido compacto (sem nomes de pessoas: só fornecedor/parque/canal e números). PURA. */
export function anomalyPrompt(rows: Array<{ n: number; domain: string; detail: string }>): string {
  return rows.map((r) => `${r.n}. [${r.domain}] ${r.detail}`).join("\n");
}

/** Explica (UMA chamada lite) as anomalias ainda sem explicação dos últimos dias. */
export async function explainPendingAnomalies(day: string, cap: AiCallCap, max = 20): Promise<{ explained: number; skipped?: string }> {
  const db = await getDb();
  if (!db) return { explained: 0 };
  const rows = rowsOf(await db.execute(sql`
    SELECT id, domain, detail FROM ops_anomalies
     WHERE explanation IS NULL AND day >= ${addDays(day, -3)}
     ORDER BY FIELD(severity, 'critical', 'warning'), id DESC
     LIMIT ${max}`));
  if (!rows.length) return { explained: 0 };
  const numbered = rows.map((r, i) => ({ n: i + 1, id: Number(r.id), domain: String(r.domain), detail: String(r.detail) }));
  const res = await tryAi({
    feature: "anomaly_explain", system: ANOMALY_SYSTEM, input: anomalyPrompt(numbered), schema: anomalyExplainSchema,
    maxTokens: 60 * numbered.length + 100, cap, entity: "ops_anomalies",
  });
  if (!res.ok) return { explained: 0, skipped: res.skipped };
  let explained = 0;
  for (const line of res.output.lines) {
    const target = numbered.find((x) => x.n === line.n);
    const text = oneLine(line.text, 400);
    if (!target || !text) continue;
    await db.execute(sql`UPDATE ops_anomalies SET explanation = ${text} WHERE id = ${target.id} AND explanation IS NULL`);
    explained++;
  }
  return { explained };
}

export async function runAnomalyDetection(day: string, cap: AiCallCap): Promise<{ found: number; inserted: number; explained: number; aiSkipped?: string }> {
  const trees = await loadCityTrees();
  const found = [
    ...(await detectBookingAnomalies(day, trees)),
    ...(await detectExpenseAnomalies(day, trees)),
    ...(await detectMarketingAnomalies(day)),
  ];
  const inserted = await saveAnomalies(found);
  const ex = await explainPendingAnomalies(day, cap);
  return { found: found.length, inserted, explained: ex.explained, ...(ex.skipped ? { aiSkipped: ex.skipped } : {}) };
}

// ─── Leitura (páginas) ───────────────────────────────────────────────────────

export interface AnomalyView {
  id: number; day: string; domain: AnomalyDomain; kind: string; cityKey: string | null; subject: string;
  value: number; expected: number | null; zScore: number | null; severity: Severity; detail: string; explanation: string | null; refIds: string | null;
}

/** Últimas anomalias de um domínio, no âmbito de cidade do pedido (nacionais só a quem vê todas). */
export async function listAnomalies(domain: AnomalyDomain, opts: { days?: number; cityKey?: OpsCity | null; limit?: number; today: string }): Promise<AnomalyView[]> {
  const db = await getDb();
  if (!db) return [];
  const since = addDays(opts.today, -(opts.days ?? 14));
  const rows = rowsOf(await db.execute(sql`
    SELECT id, day, domain, kind, cityKey, subject, value, expected, zScore, severity, detail, explanation, refIds
      FROM ops_anomalies
     WHERE domain = ${domain} AND day >= ${since}
       AND (${projectScope(sql`projectId`)} OR (projectId IS NULL AND ${projectScope(sql`NULL`)}))
       ${opts.cityKey ? sql`AND cityKey = ${opts.cityKey}` : sql``}
     ORDER BY day DESC, FIELD(severity, 'critical', 'warning'), id DESC
     LIMIT ${Math.min(200, opts.limit ?? 50)}`));
  return rows.map(toView);
}

export function toView(r: any): AnomalyView {
  return {
    id: Number(r.id), day: String(r.day), domain: r.domain, kind: String(r.kind), cityKey: r.cityKey ?? null, subject: String(r.subject),
    value: Number(r.value ?? 0), expected: r.expected == null ? null : Number(r.expected), zScore: r.zScore == null ? null : Number(r.zScore),
    severity: r.severity === "critical" ? "critical" : "warning", detail: String(r.detail), explanation: r.explanation ?? null, refIds: r.refIds ?? null,
  };
}
