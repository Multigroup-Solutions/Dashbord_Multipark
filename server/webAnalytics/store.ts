/**
 * BD do Web & SEO (migração 0165). SQL sempre parametrizado; escrita
 * idempotente:
 *  - totais por dia: INSERT … ON DUPLICATE KEY UPDATE (reler = mesmo resultado);
 *  - dimensões (top N por dia): apaga a janela e volta a inserir (um valor que
 *    saiu do top não fica "fantasma"). Se a função morrer a meio, o cursor não
 *    avança e a próxima corrida refaz a mesma janela.
 */
import crypto from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../db";
import {
  GA_DIMS, SC_DIMS, topNPerDay,
  type GaDailyRow, type GaDimKind, type GaRow, type PagespeedResult, type ScDimKind, type ScRow,
} from "../../shared/webAnalytics";

export const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const affected = (res: unknown) => Number((Array.isArray(res) ? res[0] : res as any)?.affectedRows ?? 0);

export const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const money = (n: number) => Math.round(n * 100) / 100;
const pos = (n: number | null) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

export interface WebStore {
  getState(key: string): Promise<string | null>;
  setState(key: string, value: string | null): Promise<void>;
  upsertGaDaily(propertyId: string, rows: GaDailyRow[]): Promise<void>;
  replaceGaDims(propertyId: string, dim: GaDimKind, from: string, to: string, rows: GaRow[]): Promise<void>;
  upsertScDaily(siteUrl: string, rows: ScRow[]): Promise<void>;
  replaceScDims(siteUrl: string, dim: ScDimKind, from: string, to: string, rows: ScRow[]): Promise<void>;
  latestPagespeed(): Promise<Array<{ url: string; strategy: string; runDay: string; score: number | null }>>;
  savePagespeed(r: { url: string; strategy: string; runDay: string; result: PagespeedResult | null; error: string | null }): Promise<void>;
}

/** Linhas a gravar de uma dimensão GA4: top N por dia, valor cortado. PURA. */
export function gaDimRowsToStore(dim: GaDimKind, rows: readonly GaRow[]) {
  const score = (r: GaRow) => (dim === "event" ? r.m.eventCount ?? 0 : r.m.sessions ?? 0);
  return topNPerDay(rows, GA_DIMS[dim].topN, score).map((r) => {
    const value = clip(r.dim ?? "", 500);
    return {
      day: r.day, valueHash: sha1(value), dimValue: value,
      sessions: Math.round(r.m.sessions ?? 0), totalUsers: Math.round(r.m.totalUsers ?? 0), engagedSessions: Math.round(r.m.engagedSessions ?? 0),
      keyEvents: money(r.m.keyEvents ?? 0), revenue: money(r.m.totalRevenue ?? 0), eventCount: Math.round(r.m.eventCount ?? 0),
    };
  });
}

/** Linhas a gravar de uma dimensão da Search Console: top N por dia (cliques, depois impressões). PURA. */
export function scDimRowsToStore(dim: ScDimKind, rows: readonly ScRow[]) {
  return topNPerDay(rows, SC_DIMS[dim].topN, (r) => r.clicks * 1e6 + r.impressions).map((r) => {
    const value = clip(r.dim ?? "", 1000);
    return { day: r.day, valueHash: sha1(value), dimValue: value, clicks: r.clicks, impressions: r.impressions, position: pos(r.position) };
  });
}

function chunks<T>(xs: readonly T[], n = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível.");
  return d;
}

export const dbWebStore: WebStore = {
  async getState(key) {
    const d = await db();
    const r = rowsOf(await d.execute(sql`SELECT \`value\` FROM web_analytics_state WHERE stateKey = ${key} LIMIT 1`))[0];
    return r?.value == null ? null : String(r.value);
  },
  async setState(key, value) {
    const d = await db();
    if (value == null) { await d.execute(sql`DELETE FROM web_analytics_state WHERE stateKey = ${key}`); return; }
    await d.execute(sql`INSERT INTO web_analytics_state (stateKey, \`value\`) VALUES (${key}, ${value})
      ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`);
  },
  async upsertGaDaily(propertyId, rows) {
    const d = await db();
    for (const part of chunks(rows)) {
      const values = sql.join(part.map((r) => sql`(${propertyId}, ${r.day}, ${r.sessions}, ${r.totalUsers}, ${r.newUsers}, ${r.engagedSessions}, ${money(r.keyEvents)}, ${money(r.revenue)})`), sql`, `);
      await d.execute(sql`INSERT INTO web_ga_daily (propertyId, day, sessions, totalUsers, newUsers, engagedSessions, keyEvents, revenue) VALUES ${values}
        ON DUPLICATE KEY UPDATE sessions = VALUES(sessions), totalUsers = VALUES(totalUsers), newUsers = VALUES(newUsers),
          engagedSessions = VALUES(engagedSessions), keyEvents = VALUES(keyEvents), revenue = VALUES(revenue)`);
    }
  },
  async replaceGaDims(propertyId, dim, from, to, rows) {
    const d = await db();
    const list = gaDimRowsToStore(dim, rows);
    await d.execute(sql`DELETE FROM web_ga_dims WHERE propertyId = ${propertyId} AND dim = ${dim} AND day >= ${from} AND day <= ${to}`);
    for (const part of chunks(list)) {
      const values = sql.join(part.map((r) => sql`(${propertyId}, ${dim}, ${r.day}, ${r.valueHash}, ${r.dimValue}, ${r.sessions}, ${r.totalUsers}, ${r.engagedSessions}, ${r.keyEvents}, ${r.revenue}, ${r.eventCount})`), sql`, `);
      await d.execute(sql`INSERT INTO web_ga_dims (propertyId, dim, day, valueHash, dimValue, sessions, totalUsers, engagedSessions, keyEvents, revenue, eventCount) VALUES ${values}
        ON DUPLICATE KEY UPDATE sessions = VALUES(sessions), totalUsers = VALUES(totalUsers), engagedSessions = VALUES(engagedSessions),
          keyEvents = VALUES(keyEvents), revenue = VALUES(revenue), eventCount = VALUES(eventCount)`);
    }
  },
  async upsertScDaily(siteUrl, rows) {
    const d = await db();
    for (const part of chunks(rows)) {
      const values = sql.join(part.map((r) => sql`(${siteUrl}, ${r.day}, ${r.clicks}, ${r.impressions}, ${pos(r.position)})`), sql`, `);
      await d.execute(sql`INSERT INTO web_sc_daily (siteUrl, day, clicks, impressions, position) VALUES ${values}
        ON DUPLICATE KEY UPDATE clicks = VALUES(clicks), impressions = VALUES(impressions), position = VALUES(position)`);
    }
  },
  async replaceScDims(siteUrl, dim, from, to, rows) {
    const d = await db();
    const list = scDimRowsToStore(dim, rows);
    await d.execute(sql`DELETE FROM web_sc_dims WHERE siteUrl = ${siteUrl} AND dim = ${dim} AND day >= ${from} AND day <= ${to}`);
    for (const part of chunks(list)) {
      const values = sql.join(part.map((r) => sql`(${siteUrl}, ${dim}, ${r.day}, ${r.valueHash}, ${r.dimValue}, ${r.clicks}, ${r.impressions}, ${r.position})`), sql`, `);
      await d.execute(sql`INSERT INTO web_sc_dims (siteUrl, dim, day, valueHash, dimValue, clicks, impressions, position) VALUES ${values}
        ON DUPLICATE KEY UPDATE clicks = VALUES(clicks), impressions = VALUES(impressions), position = VALUES(position)`);
    }
  },
  async latestPagespeed() {
    const d = await db();
    const rows = rowsOf(await d.execute(sql`SELECT r.url, r.strategy, DATE_FORMAT(r.runDay, '%Y-%m-%d') AS runDay, r.score
      FROM web_pagespeed_runs r
      JOIN (SELECT urlHash, strategy, MAX(runDay) AS mx FROM web_pagespeed_runs GROUP BY urlHash, strategy) m
        ON m.urlHash = r.urlHash AND m.strategy = r.strategy AND m.mx = r.runDay`));
    return rows.map((r) => ({ url: String(r.url), strategy: String(r.strategy), runDay: String(r.runDay), score: r.score == null ? null : Number(r.score) }));
  },
  async savePagespeed(r) {
    const d = await db();
    const x = r.result;
    await d.execute(sql`INSERT INTO web_pagespeed_runs (url, urlHash, strategy, runDay, score, lcpMs, cls, tbtMs, fcpMs, speedIndexMs, inpMs, fieldLcpMs, fieldCls, fieldCategory, error)
      VALUES (${clip(r.url, 1000)}, ${sha1(r.url)}, ${r.strategy}, ${r.runDay}, ${x?.score ?? null}, ${x?.lcpMs ?? null}, ${x?.cls ?? null}, ${x?.tbtMs ?? null},
        ${x?.fcpMs ?? null}, ${x?.speedIndexMs ?? null}, ${x?.inpMs ?? null}, ${x?.fieldLcpMs ?? null}, ${x?.fieldCls ?? null}, ${x?.fieldCategory ?? null}, ${r.error ? clip(r.error, 300) : null})
      ON DUPLICATE KEY UPDATE score = VALUES(score), lcpMs = VALUES(lcpMs), cls = VALUES(cls), tbtMs = VALUES(tbtMs), fcpMs = VALUES(fcpMs),
        speedIndexMs = VALUES(speedIndexMs), inpMs = VALUES(inpMs), fieldLcpMs = VALUES(fieldLcpMs), fieldCls = VALUES(fieldCls),
        fieldCategory = VALUES(fieldCategory), error = VALUES(error)`);
  },
};

// ─── Trinco (lease numa linha; expira sozinho > maxDuration) ────────────────

const LOCK_KEY = "lock";

export async function acquireWebLock(seconds = 75): Promise<string | null> {
  const d = await getDb();
  if (!d) return "no-db";
  const token = crypto.randomUUID();
  await d.execute(sql`INSERT IGNORE INTO web_analytics_state (stateKey, \`value\`, leaseUntil) VALUES (${LOCK_KEY}, NULL, NULL)`);
  const r = await d.execute(sql`UPDATE web_analytics_state SET \`value\` = ${token}, leaseUntil = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${seconds} SECOND)
    WHERE stateKey = ${LOCK_KEY} AND (\`value\` IS NULL OR leaseUntil IS NULL OR leaseUntil < UTC_TIMESTAMP())`);
  return affected(r) === 1 ? token : null;
}

export async function releaseWebLock(token: string | null): Promise<void> {
  if (!token || token === "no-db") return;
  const d = await getDb();
  if (!d) return;
  await d.execute(sql`UPDATE web_analytics_state SET \`value\` = NULL, leaseUntil = NULL WHERE stateKey = ${LOCK_KEY} AND \`value\` = ${token}`);
}

/** `col IN (…)`; lista vazia → falso. */
export function inStrings(col: SQL, xs: readonly string[]): SQL {
  return xs.length ? sql`${col} IN (${sql.join(xs.map((x) => sql`${x}`), sql`, `)})` : sql`1 = 0`;
}
