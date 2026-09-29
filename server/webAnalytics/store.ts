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
  type CruxPeriodRow, type GaDailyRow, type GaDimKind, type GaRow, type LighthouseAudit, type PagespeedResult, type ScDimKind, type ScRow,
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
  /** 0170: oportunidades/diagnósticos Lighthouse de uma medição (substitui os da mesma medição). */
  savePagespeedAudits?(url: string, strategy: string, runDay: string, audits: readonly LighthouseAudit[]): Promise<void>;
  /** 0170: períodos CrUX de um alvo × dispositivo (idempotente por período). */
  saveCrux?(target: { type: "origin" | "url"; target: string }, formFactor: string, rows: readonly CruxPeriodRow[]): Promise<void>;
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

/** Linha a gravar de um período CrUX (colunas p75 e distribuição). PURA. */
export function cruxRowToStore(r: CruxPeriodRow) {
  const d = (k: keyof CruxPeriodRow["dist"]) => r.dist[k];
  return {
    periodStart: r.periodStart, periodEnd: r.periodEnd,
    lcpP75: r.p75.lcp, inpP75: r.p75.inp, clsP75: r.p75.cls, fcpP75: r.p75.fcp, ttfbP75: r.p75.ttfb,
    lcpGood: d("lcp")?.good ?? null, lcpNi: d("lcp")?.ni ?? null, lcpPoor: d("lcp")?.poor ?? null,
    inpGood: d("inp")?.good ?? null, inpNi: d("inp")?.ni ?? null, inpPoor: d("inp")?.poor ?? null,
    clsGood: d("cls")?.good ?? null, clsNi: d("cls")?.ni ?? null, clsPoor: d("cls")?.poor ?? null,
    fcpGood: d("fcp")?.good ?? null, fcpNi: d("fcp")?.ni ?? null, fcpPoor: d("fcp")?.poor ?? null,
    ttfbGood: d("ttfb")?.good ?? null, ttfbNi: d("ttfb")?.ni ?? null, ttfbPoor: d("ttfb")?.poor ?? null,
  };
}

export const CRUX_COLS = ["lcpP75", "inpP75", "clsP75", "fcpP75", "ttfbP75", "lcpGood", "lcpNi", "lcpPoor", "inpGood", "inpNi", "inpPoor", "clsGood", "clsNi", "clsPoor", "fcpGood", "fcpNi", "fcpPoor", "ttfbGood", "ttfbNi", "ttfbPoor"] as const;

dbWebStore.savePagespeedAudits = async (url, strategy, runDay, audits) => {
  const d = await db();
  const h = sha1(url);
  await d.execute(sql`DELETE FROM web_pagespeed_audits WHERE urlHash = ${h} AND strategy = ${strategy} AND runDay = ${runDay}`);
  if (!audits.length) return;
  const values = sql.join(audits.map((a) => sql`(${h}, ${strategy}, ${runDay}, ${clip(a.id, 80)}, ${a.kind}, ${clip(a.title, 300)}, ${a.displayValue ? clip(a.displayValue, 160) : null}, ${a.savingsMs}, ${a.savingsBytes}, ${a.score})`), sql`, `);
  await d.execute(sql`INSERT INTO web_pagespeed_audits (urlHash, strategy, runDay, auditId, kind, title, displayValue, savingsMs, savingsBytes, score) VALUES ${values}
    ON DUPLICATE KEY UPDATE kind = VALUES(kind), title = VALUES(title), displayValue = VALUES(displayValue), savingsMs = VALUES(savingsMs), savingsBytes = VALUES(savingsBytes), score = VALUES(score)`);
};

dbWebStore.saveCrux = async (t, formFactor, rows) => {
  if (!rows.length) return;
  const d = await db();
  const h = sha1(`${t.type}:${t.target}`);
  const cols = sql.raw(CRUX_COLS.join(", "));
  const updates = sql.raw(["periodStart = VALUES(periodStart)", "target = VALUES(target)", ...CRUX_COLS.map((c) => `${c} = VALUES(${c})`)].join(", "));
  const values = sql.join(rows.map((r) => {
    const x = cruxRowToStore(r);
    return sql`(${t.type}, ${clip(t.target, 1000)}, ${h}, ${formFactor}, ${x.periodStart}, ${x.periodEnd}, ${sql.join(CRUX_COLS.map((c) => sql`${x[c]}`), sql`, `)})`;
  }), sql`, `);
  await d.execute(sql`INSERT INTO web_crux_records (targetType, target, targetHash, formFactor, periodStart, periodEnd, ${cols}) VALUES ${values} ON DUPLICATE KEY UPDATE ${updates}`);
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
