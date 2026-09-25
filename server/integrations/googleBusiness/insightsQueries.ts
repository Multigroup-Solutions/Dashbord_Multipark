/**
 * Leituras do Google Business Profile para a UI e os alertas — a partir dos
 * agregados guardados (gbp_daily_metrics, gbp_search_keywords), das críticas
 * já importadas (google_reviews: só nota, datas e se tem resposta — nunca o
 * texto nem o nome) e das reservas (mesma regra das Reservas & Operações).
 *
 * Âmbito de cidade: cada perfil tem cidade (Definições → associação, parque
 * associado nas Críticas ou morada); quem só vê algumas cidades só vê esses
 * perfis. Tabelas grandes paginadas no SQL.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { cityScope, projectScope } from "../../cityScope";
import { inLisbonDaysSql, notCancelledSql } from "../../marketingSql";
import { lisbonDaySql } from "../../../shared/lisbonDay";
import { matchCityKey, type CityKey } from "../../../shared/city";
import { cityKeyOfNode, type ProjectTreeNode } from "../../../shared/projectTree";
import { brandNameForProject } from "../../../shared/adCampaignMapping";
import { brandIdOfName } from "../../../shared/webAnalytics";
import {
  DEFAULT_GBP_CONFIG, GBP_METRIC_COLS, GBP_SETTING_KEY, emptyGbpValues, resolveLocationMapping,
  type GbpConfig, type GbpMetricValues, type ResolvedMapping, type ReviewLite,
} from "../../../shared/googleBusinessProfile";
import type { MailBrand } from "../../../shared/mail";
import { dbGbpStore, rowsOf, type GbpLocationRow } from "./insightsStore";

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const dayStr = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível.");
  return d;
}

export async function loadGbpConfig(): Promise<GbpConfig> {
  const { getSetting } = await import("../../appSettings");
  return ((await getSetting(GBP_SETTING_KEY as any)) as GbpConfig | null) ?? DEFAULT_GBP_CONFIG;
}

// ─── Perfis com cidade/marca ────────────────────────────────────────────────

export type ResolvedLocation = GbpLocationRow & { city: CityKey | null; brand: MailBrand | null; active: boolean; mappingSource: ResolvedMapping["source"] };

async function projectNodes(): Promise<ProjectTreeNode[]> {
  const d = await db();
  return rowsOf(await d.execute(sql`SELECT id, name, level, parentId FROM projects`)).map((r) => ({
    id: n(r.id), name: String(r.name ?? ""), level: String(r.level ?? ""), parentId: r.parentId == null ? null : n(r.parentId),
  }));
}

/** Cidade e marca de cada projeto (árvore Grupo → Cidade → Marca → Parque). */
export async function projectCityBrand(): Promise<{ cityOf: (id: number | null) => CityKey | null; brandOf: (id: number | null) => MailBrand | null }> {
  const nodes = await projectNodes();
  const byId = new Map(nodes.map((x) => [x.id, x]));
  return {
    cityOf: (id) => (id == null ? null : cityKeyOfNode(id, byId)),
    brandOf: (id) => (id == null ? null : (brandIdOfName(brandNameForProject(id, nodes as any)) as MailBrand | null)),
  };
}

export async function resolvedLocations(cfg: GbpConfig, rows?: GbpLocationRow[]): Promise<ResolvedLocation[]> {
  const list = rows ?? (await dbGbpStore.locations());
  const pm = await projectCityBrand().catch(() => ({ cityOf: () => null, brandOf: () => null }));
  return list.map((l) => {
    const m = resolveLocationMapping({ locationName: l.locationName, title: l.title, address: l.address, projectCity: pm.cityOf(l.projectId), projectBrand: pm.brandOf(l.projectId) }, cfg.locationMap);
    return { ...l, city: m.city, brand: m.brand, active: m.active, mappingSource: m.source };
  });
}

/** Cidades que o utilizador pode ver (null = todas). */
export function allowedCities(): Set<CityKey> | null {
  const access = cityScope.getStore();
  if (!access || access.all) return null;
  const names = access.cityNames ?? (access.cityName ? [access.cityName] : []);
  return new Set(names.map((x) => matchCityKey(x)).filter((x): x is CityKey => !!x));
}

/** Perfis ativos dentro do âmbito do utilizador e do filtro (cidade/perfil). PURA sobre a lista. */
export function scopeLocations(list: readonly ResolvedLocation[], f: { city?: CityKey | null; locationId?: number | null; includeInactive?: boolean }, allowed: Set<CityKey> | null = allowedCities()): ResolvedLocation[] {
  return list.filter((l) => (f.includeInactive || (l.active && l.available))
    && (!allowed || (l.city != null && allowed.has(l.city)))
    && (!f.city || l.city === f.city)
    && (!f.locationId || l.id === f.locationId));
}

// ─── Desempenho ─────────────────────────────────────────────────────────────

const inIds = (col: string, ids: readonly number[]) => (ids.length ? sql`${sql.raw(col)} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql`1 = 0`);
const sumCols = sql.raw(GBP_METRIC_COLS.map((c) => `SUM(${c}) AS ${c}`).join(", "));
const valuesOf = (r: any): GbpMetricValues => { const v = emptyGbpValues(); for (const c of GBP_METRIC_COLS) v[c] = n(r[c]); return v; };

export async function gbpDaily(ids: readonly number[], from: string, to: string): Promise<Array<{ day: string; values: GbpMetricValues }>> {
  if (!ids.length) return [];
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day, ${sumCols} FROM gbp_daily_metrics
    WHERE ${inIds("locationId", ids)} AND day >= ${from} AND day <= ${to} GROUP BY day ORDER BY day`));
  return rows.map((r) => ({ day: dayStr(r.day), values: valuesOf(r) }));
}

export async function gbpDailyByLocation(ids: readonly number[], from: string, to: string): Promise<Array<{ locationId: number; day: string; values: GbpMetricValues }>> {
  if (!ids.length) return [];
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT locationId, DATE_FORMAT(day, '%Y-%m-%d') AS day, ${sql.raw(GBP_METRIC_COLS.join(", "))} FROM gbp_daily_metrics
    WHERE ${inIds("locationId", ids)} AND day >= ${from} AND day <= ${to} ORDER BY day LIMIT 50000`));
  return rows.map((r) => ({ locationId: n(r.locationId), day: dayStr(r.day), values: valuesOf(r) }));
}

export async function gbpTotalsByLocation(ids: readonly number[], from: string, to: string): Promise<Map<number, GbpMetricValues & { days: number }>> {
  const out = new Map<number, GbpMetricValues & { days: number }>();
  if (!ids.length) return out;
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT locationId, COUNT(*) AS days, ${sumCols} FROM gbp_daily_metrics
    WHERE ${inIds("locationId", ids)} AND day >= ${from} AND day <= ${to} GROUP BY locationId`));
  for (const r of rows) out.set(n(r.locationId), { ...valuesOf(r), days: n(r.days) });
  return out;
}

export async function gbpCoverage(ids: readonly number[]): Promise<{ from: string | null; to: string | null }> {
  if (!ids.length) return { from: null, to: null };
  const d = await db();
  const r = rowsOf(await d.execute(sql`SELECT DATE_FORMAT(MIN(day), '%Y-%m-%d') AS f, DATE_FORMAT(MAX(day), '%Y-%m-%d') AS t FROM gbp_daily_metrics WHERE ${inIds("locationId", ids)}`))[0];
  return { from: r?.f ? String(r.f) : null, to: r?.t ? String(r.t) : null };
}

// ─── Pesquisas mensais ──────────────────────────────────────────────────────

export async function gbpKeywords(i: { ids: readonly number[]; fromMonth: string; toMonth: string; page: number; pageSize: number; search?: string | null }) {
  if (!i.ids.length) return { rows: [] as Array<{ keyword: string; impressions: number; hidden: number; months: number }>, total: 0 };
  const d = await db();
  const search = (i.search ?? "").trim().toLowerCase().slice(0, 100);
  const like = search ? sql` AND keyword LIKE ${`%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}` : sql``;
  const where = sql`${inIds("locationId", i.ids)} AND month >= ${`${i.fromMonth}-01`} AND month <= ${`${i.toMonth}-01`}${like}`;
  const limit = Math.max(1, Math.min(100, Math.floor(i.pageSize)));
  const offset = Math.max(0, Math.floor((i.page - 1) * limit));
  const rows = rowsOf(await d.execute(sql`SELECT keywordHash AS h, MAX(keyword) AS k, COALESCE(SUM(impressions), 0) AS imp,
      SUM(CASE WHEN impressions IS NULL THEN 1 ELSE 0 END) AS hidden, COUNT(DISTINCT month) AS months
    FROM gbp_search_keywords WHERE ${where} GROUP BY keywordHash ORDER BY imp DESC, hidden ASC, h LIMIT ${limit} OFFSET ${offset}`));
  const total = rowsOf(await d.execute(sql`SELECT COUNT(DISTINCT keywordHash) AS t FROM gbp_search_keywords WHERE ${where}`))[0];
  return { rows: rows.map((r) => ({ keyword: String(r.k ?? ""), impressions: n(r.imp), hidden: n(r.hidden), months: n(r.months) })), total: n(total?.t) };
}

// ─── Críticas (só nota, datas e se tem resposta) ───────────────────────────

const reviewScope = (locs: readonly ResolvedLocation[]) => {
  const ids = locs.map((l) => l.id);
  const projects = Array.from(new Set(locs.map((l) => l.projectId).filter((x): x is number => x != null)));
  const byLoc = inIds("r.googleLocationId", ids);
  // Críticas vindas por email (sem perfil) contam no perfil do mesmo parque.
  return projects.length ? sql`(${byLoc} OR (r.googleLocationId IS NULL AND ${inIds("r.projectId", projects)}))` : byLoc;
};

export async function reviewsLite(locs: readonly ResolvedLocation[], from: string, to: string): Promise<Array<ReviewLite & { locationId: number | null; projectId: number | null }>> {
  if (!locs.length) return [];
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT r.rating, DATE_FORMAT(r.reviewDate, '%Y-%m-%d %H:%i:%s') AS reviewDate,
      DATE_FORMAT(r.respondedAt, '%Y-%m-%d %H:%i:%s') AS respondedAt, (r.googleReply IS NOT NULL AND r.googleReply <> '') AS hasReply,
      r.googleLocationId AS locationId, r.projectId AS projectId
    FROM google_reviews r WHERE ${reviewScope(locs)} AND ${inLisbonDaysSql(sql`r.reviewDate`, from, to)} AND r.status <> 'dismissed' LIMIT 20000`));
  return rows.map((r) => ({
    rating: n(r.rating), reviewDate: r.reviewDate ? String(r.reviewDate) : null, respondedAt: r.respondedAt ? String(r.respondedAt) : null,
    hasReply: Number(r.hasReply) === 1, locationId: r.locationId == null ? null : n(r.locationId), projectId: r.projectId == null ? null : n(r.projectId),
  }));
}

/** Críticas importadas pela API sem resposta pública (últimos `maxAgeDays`), por perfil. */
export async function unansweredByLocation(ids: readonly number[], maxAgeDays = 30): Promise<Map<number, { count: number; oldestHours: number }>> {
  const out = new Map<number, { count: number; oldestHours: number }>();
  if (!ids.length) return out;
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT googleLocationId AS id, COUNT(*) AS c, TIMESTAMPDIFF(HOUR, MIN(reviewDate), UTC_TIMESTAMP()) AS h
    FROM google_reviews WHERE ${inIds("googleLocationId", ids)} AND (googleReply IS NULL OR googleReply = '') AND respondedAt IS NULL
      AND status IN ('pending_response', 'ai_responded', 'converted_complaint') AND reviewDate >= UTC_TIMESTAMP() - INTERVAL ${maxAgeDays} DAY
    GROUP BY googleLocationId`));
  for (const r of rows) out.set(n(r.id), { count: n(r.c), oldestHours: n(r.h) });
  return out;
}

// ─── Negócio: reservas por cidade × dia ─────────────────────────────────────

export async function bookingsByCityDay(from: string, to: string): Promise<Map<CityKey, Map<string, number>>> {
  const d = await db();
  const dayExpr = sql.raw(lisbonDaySql("b.bookingCreatedAt", from, to));
  const rows = rowsOf(await d.execute(sql`SELECT ${dayExpr} AS d, b.projectId AS projectId, COUNT(*) AS c
    FROM multipark_bookings b
    WHERE ${notCancelledSql(sql`b.status`)} AND ${inLisbonDaysSql(sql`b.bookingCreatedAt`, from, to)} AND ${projectScope(sql`b.projectId`)}
    GROUP BY d, b.projectId`));
  const pm = await projectCityBrand();
  const out = new Map<CityKey, Map<string, number>>();
  for (const r of rows) {
    const city = pm.cityOf(r.projectId == null ? null : n(r.projectId));
    if (!city) continue;
    const m = out.get(city) ?? new Map<string, number>();
    const day = dayStr(r.d);
    m.set(day, (m.get(day) ?? 0) + n(r.c));
    out.set(city, m);
  }
  return out;
}
