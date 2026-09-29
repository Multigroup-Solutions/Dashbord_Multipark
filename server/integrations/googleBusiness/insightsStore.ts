/**
 * BD do desempenho Google Business Profile (migração 0170). SQL sempre
 * parametrizado; escrita idempotente:
 *  - métricas por perfil × dia: INSERT … ON DUPLICATE KEY UPDATE (reler a
 *    mesma janela dá o mesmo resultado);
 *  - pesquisas de um mês: apaga o mês do perfil e volta a inserir (uma
 *    pesquisa que saiu da lista não fica "fantasma").
 * O estado da recolha (cursores, trinco, último erro, alertas) vive em
 * web_analytics_state (0165) com o prefixo "gbp:".
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { GBP_METRIC_COLS, type GbpDayRow, type GbpKeywordRow } from "../../../shared/googleBusinessProfile";

export const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const affected = (res: unknown) => Number((Array.isArray(res) ? res[0] : res as any)?.affectedRows ?? 0);
export const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

export interface GbpLocationRow {
  id: number; locationName: string; accountName: string; title: string; address: string | null; projectId: number | null; available: boolean;
  openStatus: string | null; hasVoiceOfMerchant: boolean | null; hasGoogleUpdated: boolean | null; hasPendingEdits: boolean | null;
  canOperateLocalPost: boolean | null; mapsUri: string | null; metaCheckedAt: string | null;
}

export interface GbpStore {
  getState(key: string): Promise<string | null>;
  setState(key: string, value: string | null): Promise<void>;
  locations(): Promise<GbpLocationRow[]>;
  upsertDaily(locationId: number, rows: readonly GbpDayRow[]): Promise<void>;
  replaceKeywords(locationId: number, month: string, rows: readonly GbpKeywordRow[]): Promise<void>;
}

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível.");
  return d;
}
const bool = (v: unknown) => (v == null ? null : Number(v) === 1);

export function locationFromRow(r: any): GbpLocationRow {
  return {
    id: Number(r.id), locationName: String(r.locationName), accountName: String(r.accountName), title: String(r.title ?? ""),
    address: r.address == null ? null : String(r.address), projectId: r.projectId == null ? null : Number(r.projectId), available: Number(r.available) === 1,
    openStatus: r.openStatus == null ? null : String(r.openStatus), hasVoiceOfMerchant: bool(r.hasVoiceOfMerchant), hasGoogleUpdated: bool(r.hasGoogleUpdated),
    hasPendingEdits: bool(r.hasPendingEdits), canOperateLocalPost: bool(r.canOperateLocalPost), mapsUri: r.mapsUri == null ? null : String(r.mapsUri),
    metaCheckedAt: r.metaCheckedAt == null ? null : String(r.metaCheckedAt),
  };
}

/** Linhas de pesquisas a gravar: sem repetidos (a Google pode devolver o mesmo texto em páginas diferentes). PURA. */
export function keywordRowsToStore(rows: readonly GbpKeywordRow[]) {
  const by = new Map<string, { keywordHash: string; keyword: string; impressions: number | null; threshold: number | null }>();
  for (const r of rows) {
    const keyword = r.keyword.toLowerCase().slice(0, 300);
    const h = sha1(keyword);
    const prev = by.get(h);
    if (!prev || (r.impressions ?? -1) > (prev.impressions ?? -1)) by.set(h, { keywordHash: h, keyword, impressions: r.impressions, threshold: r.threshold });
  }
  return Array.from(by.values());
}

export const dbGbpStore: GbpStore = {
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
  async locations() {
    const d = await db();
    return rowsOf(await d.execute(sql`SELECT id, locationName, accountName, title, address, projectId, available, openStatus, hasVoiceOfMerchant,
      hasGoogleUpdated, hasPendingEdits, canOperateLocalPost, mapsUri, DATE_FORMAT(metaCheckedAt, '%Y-%m-%d %H:%i:%s') AS metaCheckedAt
      FROM google_business_locations ORDER BY title, id`)).map(locationFromRow);
  },
  async upsertDaily(locationId, rows) {
    if (!rows.length) return;
    const d = await db();
    const cols = sql.raw(GBP_METRIC_COLS.join(", "));
    const updates = sql.raw(GBP_METRIC_COLS.map((c) => `${c} = VALUES(${c})`).join(", "));
    for (let i = 0; i < rows.length; i += 200) {
      const part = rows.slice(i, i + 200);
      const values = sql.join(part.map((r) => sql`(${locationId}, ${r.day}, ${sql.join(GBP_METRIC_COLS.map((c) => sql`${Math.max(0, Math.round(r.values[c] ?? 0))}`), sql`, `)})`), sql`, `);
      await d.execute(sql`INSERT INTO gbp_daily_metrics (locationId, day, ${cols}) VALUES ${values} ON DUPLICATE KEY UPDATE ${updates}`);
    }
  },
  async replaceKeywords(locationId, month, rows) {
    const d = await db();
    const monthDay = `${month}-01`;
    const list = keywordRowsToStore(rows);
    await d.execute(sql`DELETE FROM gbp_search_keywords WHERE locationId = ${locationId} AND month = ${monthDay}`);
    for (let i = 0; i < list.length; i += 300) {
      const part = list.slice(i, i + 300);
      const values = sql.join(part.map((r) => sql`(${locationId}, ${monthDay}, ${r.keywordHash}, ${r.keyword}, ${r.impressions}, ${r.threshold})`), sql`, `);
      await d.execute(sql`INSERT INTO gbp_search_keywords (locationId, month, keywordHash, keyword, impressions, threshold) VALUES ${values}
        ON DUPLICATE KEY UPDATE keyword = VALUES(keyword), impressions = VALUES(impressions), threshold = VALUES(threshold)`);
    }
  },
};

// ─── Trinco (lease numa linha; expira sozinho) ──────────────────────────────

const LOCK_KEY = "gbp:lock";

export async function acquireGbpLock(seconds = 75): Promise<string | null> {
  const d = await getDb();
  if (!d) return null;
  const token = crypto.randomUUID();
  await d.execute(sql`INSERT IGNORE INTO web_analytics_state (stateKey, \`value\`, leaseUntil) VALUES (${LOCK_KEY}, NULL, NULL)`);
  const r = await d.execute(sql`UPDATE web_analytics_state SET \`value\` = ${token}, leaseUntil = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${seconds} SECOND)
    WHERE stateKey = ${LOCK_KEY} AND (\`value\` IS NULL OR leaseUntil IS NULL OR leaseUntil < UTC_TIMESTAMP())`);
  return affected(r) === 1 ? token : null;
}

export async function releaseGbpLock(token: string | null): Promise<void> {
  if (!token) return;
  const d = await getDb();
  if (!d) return;
  await d.execute(sql`UPDATE web_analytics_state SET \`value\` = NULL, leaseUntil = NULL WHERE stateKey = ${LOCK_KEY} AND \`value\` = ${token}`);
}
