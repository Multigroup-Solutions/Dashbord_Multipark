/**
 * Leituras do Web & SEO para a UI, os alertas e o resumo semanal — tudo a
 * partir dos agregados guardados (web_ga_*, web_sc_*, web_pagespeed_runs) e
 * das reservas/gasto que a app já tem (a mesma regra das Reservas &
 * Operações: pela data de criação em dias de Lisboa, sem canceladas).
 * Tabelas grandes: sempre paginadas no SQL (LIMIT/OFFSET), nunca tudo.
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../db";
import { projectScope } from "../cityScope";
import { inLisbonDaysSql, notCancelledSql } from "../marketingSql";
import { lisbonDaySql } from "../../shared/lisbonDay";
import { brandNameForProject } from "../../shared/adCampaignMapping";
import { brandIdOfName, type GaDimKind, type ScDimKind } from "../../shared/webAnalytics";
import { inStrings, rowsOf } from "./store";

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const dayStr = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível.");
  return d;
}

// ─── Totais e séries ────────────────────────────────────────────────────────

export interface GaDayAgg { day: string; sessions: number; totalUsers: number; newUsers: number; engagedSessions: number; keyEvents: number; revenue: number }
export interface ScDayAgg { day: string; clicks: number; impressions: number; position: number | null }

export async function gaDaily(propertyIds: readonly string[], from: string, to: string): Promise<GaDayAgg[]> {
  if (!propertyIds.length) return [];
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day, SUM(sessions) AS sessions, SUM(totalUsers) AS totalUsers,
      SUM(newUsers) AS newUsers, SUM(engagedSessions) AS engagedSessions, SUM(keyEvents) AS keyEvents, SUM(revenue) AS revenue
    FROM web_ga_daily WHERE ${inStrings(sql`propertyId`, propertyIds)} AND day >= ${from} AND day <= ${to}
    GROUP BY day ORDER BY day`));
  return rows.map((r) => ({ day: dayStr(r.day), sessions: n(r.sessions), totalUsers: n(r.totalUsers), newUsers: n(r.newUsers), engagedSessions: n(r.engagedSessions), keyEvents: n(r.keyEvents), revenue: n(r.revenue) }));
}

export async function gaDailyByProperty(propertyIds: readonly string[], from: string, to: string): Promise<Array<{ propertyId: string; day: string; sessions: number }>> {
  if (!propertyIds.length) return [];
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT propertyId, DATE_FORMAT(day, '%Y-%m-%d') AS day, sessions
    FROM web_ga_daily WHERE ${inStrings(sql`propertyId`, propertyIds)} AND day >= ${from} AND day <= ${to} ORDER BY day`));
  return rows.map((r) => ({ propertyId: String(r.propertyId), day: dayStr(r.day), sessions: n(r.sessions) }));
}

export async function scDaily(sites: readonly string[], from: string, to: string): Promise<ScDayAgg[]> {
  if (!sites.length) return [];
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
      SUM(position * impressions) AS posW
    FROM web_sc_daily WHERE ${inStrings(sql`siteUrl`, sites)} AND day >= ${from} AND day <= ${to}
    GROUP BY day ORDER BY day`));
  return rows.map((r) => ({ day: dayStr(r.day), clicks: n(r.clicks), impressions: n(r.impressions), position: n(r.impressions) > 0 ? n(r.posW) / n(r.impressions) : null }));
}

export async function scDailyBySite(sites: readonly string[], from: string, to: string): Promise<Array<{ siteUrl: string; day: string; clicks: number }>> {
  if (!sites.length) return [];
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT siteUrl, DATE_FORMAT(day, '%Y-%m-%d') AS day, clicks
    FROM web_sc_daily WHERE ${inStrings(sql`siteUrl`, sites)} AND day >= ${from} AND day <= ${to} ORDER BY day`));
  return rows.map((r) => ({ siteUrl: String(r.siteUrl), day: dayStr(r.day), clicks: n(r.clicks) }));
}

export function sumGa(rows: readonly GaDayAgg[]) {
  return rows.reduce((t, r) => ({
    sessions: t.sessions + r.sessions, totalUsers: t.totalUsers + r.totalUsers, newUsers: t.newUsers + r.newUsers,
    engagedSessions: t.engagedSessions + r.engagedSessions, keyEvents: t.keyEvents + r.keyEvents, revenue: t.revenue + r.revenue,
  }), { sessions: 0, totalUsers: 0, newUsers: 0, engagedSessions: 0, keyEvents: 0, revenue: 0 });
}

export function sumSc(rows: readonly ScDayAgg[]) {
  let clicks = 0, impressions = 0, posW = 0;
  for (const r of rows) { clicks += r.clicks; impressions += r.impressions; if (r.position != null) posW += r.position * r.impressions; }
  return { clicks, impressions, ctr: impressions > 0 ? clicks / impressions : null, position: impressions > 0 ? posW / impressions : null };
}

// ─── Dimensões com comparação (paginadas) ───────────────────────────────────

export type GaSort = "sessions" | "keyEvents" | "revenue" | "losing" | "gaining";
export type ScSort = "clicks" | "impressions" | "position" | "losing" | "gaining" | "positionWorse";

export interface DimCompareInput {
  source: "ga" | "sc";
  ids: readonly string[];
  dim: GaDimKind | ScDimKind;
  cur: { from: string; to: string };
  prev: { from: string; to: string };
  sort: GaSort | ScSort;
  limit: number;
  offset: number;
  search?: string | null;
}

const GA_SORT: Record<GaSort, string> = {
  sessions: "cSessions DESC",
  keyEvents: "cKeyEvents DESC, cSessions DESC",
  revenue: "cRevenue DESC, cSessions DESC",
  losing: "(cSessions - pSessions) ASC, pSessions DESC",
  gaining: "(cSessions - pSessions) DESC, cSessions DESC",
};
const SC_SORT: Record<ScSort, string> = {
  clicks: "cClicks DESC, cImpressions DESC",
  impressions: "cImpressions DESC",
  position: "(CASE WHEN cImpressions > 0 THEN cPosW / cImpressions ELSE 9999 END) ASC, cImpressions DESC",
  losing: "(cClicks - pClicks) ASC, pClicks DESC",
  gaining: "(cClicks - pClicks) DESC, cClicks DESC",
  positionWorse: "(CASE WHEN cImpressions > 0 AND pImpressions > 0 THEN cPosW / cImpressions - pPosW / pImpressions ELSE -9999 END) DESC, pClicks DESC",
};

export interface DimCompareRow {
  key: string;
  value: string;
  sourceId: string | null;
  cur: Record<string, number>;
  prev: Record<string, number>;
  position: number | null;
  prevPosition: number | null;
}

/** Lista comparada (período vs comparação) de uma dimensão, paginada no SQL. */
export async function dimCompare(i: DimCompareInput): Promise<{ rows: DimCompareRow[]; total: number }> {
  if (!i.ids.length) return { rows: [], total: 0 };
  const d = await db();
  const inCur = sql`(day >= ${i.cur.from} AND day <= ${i.cur.to})`;
  const inPrev = sql`(day >= ${i.prev.from} AND day <= ${i.prev.to})`;
  const c = (col: string) => sql.raw(col);
  const search = (i.search ?? "").trim().slice(0, 100);
  const like = search ? sql` AND dimValue LIKE ${`%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}` : sql``;
  let select: SQL, from: SQL, having: SQL, order: string;
  // Páginas de entrada: a mesma "/" de marcas diferentes não se junta.
  const perSource = i.source === "ga" && i.dim === "landing";
  if (i.source === "ga") {
    const m = (col: string, alias: string) => sql`SUM(CASE WHEN ${inCur} THEN ${c(col)} ELSE 0 END) AS ${c(`c${alias}`)}, SUM(CASE WHEN ${inPrev} THEN ${c(col)} ELSE 0 END) AS ${c(`p${alias}`)}`;
    select = sql`${m("sessions", "Sessions")}, ${m("totalUsers", "Users")}, ${m("engagedSessions", "Engaged")}, ${m("keyEvents", "KeyEvents")}, ${m("revenue", "Revenue")}, ${m("eventCount", "Events")}`;
    from = sql`FROM web_ga_dims WHERE ${inStrings(sql`propertyId`, i.ids)} AND dim = ${i.dim} AND (${inCur} OR ${inPrev})${like}`;
    having = i.dim === "event" ? sql`HAVING cEvents > 0 OR pEvents > 0` : sql`HAVING cSessions > 0 OR pSessions > 0`;
    order = i.dim === "event" ? "cEvents DESC" : GA_SORT[(i.sort as GaSort)] ?? GA_SORT.sessions;
  } else {
    const m = (col: string, alias: string) => sql`SUM(CASE WHEN ${inCur} THEN ${c(col)} ELSE 0 END) AS ${c(`c${alias}`)}, SUM(CASE WHEN ${inPrev} THEN ${c(col)} ELSE 0 END) AS ${c(`p${alias}`)}`;
    select = sql`${m("clicks", "Clicks")}, ${m("impressions", "Impressions")}, ${m("position * impressions", "PosW")}`;
    from = sql`FROM web_sc_dims WHERE ${inStrings(sql`siteUrl`, i.ids)} AND dim = ${i.dim} AND (${inCur} OR ${inPrev})${like}`;
    having = sql`HAVING cImpressions > 0 OR pImpressions > 0`;
    order = SC_SORT[(i.sort as ScSort)] ?? SC_SORT.clicks;
  }
  const groupCols = perSource ? sql.raw("propertyId, valueHash") : sql.raw("valueHash");
  const sourceSel = perSource ? sql.raw("propertyId AS sourceId") : sql.raw("NULL AS sourceId");
  const limit = Math.max(1, Math.min(200, Math.floor(i.limit)));
  const offset = Math.max(0, Math.floor(i.offset));
  const rows = rowsOf(await d.execute(sql`SELECT valueHash AS h, ${sourceSel}, MAX(dimValue) AS v, ${select} ${from} GROUP BY ${groupCols} ${having}
    ORDER BY ${sql.raw(order)}, h LIMIT ${limit} OFFSET ${offset}`));
  const totalRow = rowsOf(await d.execute(sql`SELECT COUNT(*) AS t FROM (SELECT valueHash, ${select} ${from} GROUP BY ${groupCols} ${having}) x`))[0];
  const out: DimCompareRow[] = rows.map((r) => {
    const cur: Record<string, number> = {}, prev: Record<string, number> = {};
    for (const [k, v] of Object.entries(r)) {
      if (/^c[A-Z]/.test(k)) cur[k.slice(1, 2).toLowerCase() + k.slice(2)] = n(v);
      else if (/^p[A-Z]/.test(k)) prev[k.slice(1, 2).toLowerCase() + k.slice(2)] = n(v);
    }
    const position = i.source === "sc" && cur.impressions > 0 ? cur.posW / cur.impressions : null;
    const prevPosition = i.source === "sc" && prev.impressions > 0 ? prev.posW / prev.impressions : null;
    delete cur.posW; delete prev.posW;
    return { key: `${r.sourceId ?? ""}:${r.h}`, value: String(r.v ?? ""), sourceId: r.sourceId == null ? null : String(r.sourceId), cur, prev, position, prevPosition };
  });
  return { rows: out, total: n(totalRow?.t) };
}

// ─── PageSpeed ──────────────────────────────────────────────────────────────

export interface PagespeedRunRow {
  url: string; strategy: string; runDay: string; score: number | null; lcpMs: number | null; cls: number | null; tbtMs: number | null;
  fcpMs: number | null; inpMs: number | null; fieldLcpMs: number | null; fieldCls: number | null; fieldCategory: string | null; error: string | null;
}

export async function pagespeedHistory(urls: readonly string[], sinceDay: string): Promise<PagespeedRunRow[]> {
  if (!urls.length) return [];
  const d = await db();
  const { sha1 } = await import("./store");
  const rows = rowsOf(await d.execute(sql`SELECT url, strategy, DATE_FORMAT(runDay, '%Y-%m-%d') AS runDay, score, lcpMs, cls, tbtMs, fcpMs, inpMs, fieldLcpMs, fieldCls, fieldCategory, error
    FROM web_pagespeed_runs WHERE ${inStrings(sql`urlHash`, urls.map(sha1))} AND runDay >= ${sinceDay} ORDER BY runDay LIMIT 2000`));
  const nn = (v: unknown) => (v == null ? null : n(v));
  return rows.map((r) => ({
    url: String(r.url), strategy: String(r.strategy), runDay: dayStr(r.runDay), score: nn(r.score), lcpMs: nn(r.lcpMs), cls: nn(r.cls), tbtMs: nn(r.tbtMs),
    fcpMs: nn(r.fcpMs), inpMs: nn(r.inpMs), fieldLcpMs: nn(r.fieldLcpMs), fieldCls: nn(r.fieldCls), fieldCategory: r.fieldCategory ?? null, error: r.error ?? null,
  }));
}

// ─── Negócio: reservas e gasto por dia (por marca) ─────────────────────────

/** Origens em que a reserva é feita num site (shared/bookingOrigin.ts). */
export const SITE_BOOKING_ORIGINS = ["API", "GENERAL_FORM"];

async function projectsList(): Promise<Array<{ id: number; name: string; level: string | null; parentId: number | null }>> {
  const d = await db();
  return rowsOf(await d.execute(sql`SELECT id, name, level, parentId FROM projects`)).map((r) => ({ id: n(r.id), name: String(r.name ?? ""), level: r.level ?? null, parentId: r.parentId == null ? null : n(r.parentId) }));
}

/** Marca (id) de cada projeto, pela árvore (nó "brand"). */
async function brandOfProjectFn(): Promise<(projectId: number | null) => string | null> {
  const projects = await projectsList();
  const cache = new Map<number, string | null>();
  return (projectId) => {
    if (projectId == null) return null;
    if (!cache.has(projectId)) cache.set(projectId, brandIdOfName(brandNameForProject(projectId, projects as any)));
    return cache.get(projectId)!;
  };
}

export interface BookingDayAgg { bookings: number; siteBookings: number; revenue: number; siteRevenue: number }

export async function bookingsByDay(from: string, to: string, brand: string | null): Promise<Map<string, BookingDayAgg>> {
  const d = await db();
  const dayExpr = sql.raw(lisbonDaySql("b.bookingCreatedAt", from, to));
  const origins = sql.join(SITE_BOOKING_ORIGINS.map((o) => sql`${o}`), sql`, `);
  const rows = rowsOf(await d.execute(sql`SELECT ${dayExpr} AS d, b.projectId AS projectId, COUNT(*) AS n,
      SUM(CASE WHEN b.origin IN (${origins}) THEN 1 ELSE 0 END) AS site,
      COALESCE(SUM(b.totalPrice), 0) AS rev,
      COALESCE(SUM(CASE WHEN b.origin IN (${origins}) THEN b.totalPrice ELSE 0 END), 0) AS siteRev
    FROM multipark_bookings b
    WHERE ${notCancelledSql(sql`b.status`)} AND ${inLisbonDaysSql(sql`b.bookingCreatedAt`, from, to)} AND ${projectScope(sql`b.projectId`)}
    GROUP BY d, b.projectId`));
  const brandOf = brand ? await brandOfProjectFn() : null;
  const out = new Map<string, BookingDayAgg>();
  for (const r of rows) {
    if (brandOf && brandOf(r.projectId == null ? null : n(r.projectId)) !== brand) continue;
    const day = dayStr(r.d);
    const e = out.get(day) ?? { bookings: 0, siteBookings: 0, revenue: 0, siteRevenue: 0 };
    e.bookings += n(r.n); e.siteBookings += n(r.site); e.revenue += n(r.rev); e.siteRevenue += n(r.siteRev);
    out.set(day, e);
  }
  return out;
}

/** Gasto em anúncios por dia (fonte única getAdMetrics; por marca pelo nó da campanha). */
export async function adSpendByDay(from: string, to: string, brand: string | null): Promise<{ byDay: Map<string, number>; available: boolean }> {
  try {
    const { getAdMetrics } = await import("../integrations/googleAds/adMetrics");
    const { marketingProjectIds } = await import("../marketingSql");
    const projectIds = await marketingProjectIds(undefined);
    const ads = await getAdMetrics({ from, to, projectIds });
    const out = new Map<string, number>();
    if (!brand) {
      for (const x of ads.byDay) out.set(x.date, (out.get(x.date) ?? 0) + x.cost);
    } else {
      const brandOf = await brandOfProjectFn();
      for (const x of ads.byDayProject) if (brandOf(x.projectId) === brand) out.set(x.date, (out.get(x.date) ?? 0) + x.cost);
    }
    return { byDay: out, available: ads.byDay.length > 0 };
  } catch {
    return { byDay: new Map(), available: false };
  }
}
