/**
 * Base de conhecimento — acesso à BD (kb_documents, kb_chunks, kb_sync_state).
 * SQL sempre parametrizado; nunca regista texto dos documentos.
 */
import { sql, type SQL } from "drizzle-orm";
import { parseVisibility, type KbSource, type KbStatus, type KbViewer, type KbVisibility } from "../../shared/knowledge";
import type { KbChunk } from "./chunker";

export type Db = { execute: (q: SQL) => Promise<any> };

export const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const header = (res: unknown): any => (Array.isArray(res) ? res[0] : res);
const s = (v: unknown) => (v == null || v === "" ? null : String(v));

export async function kbDb(): Promise<Db> {
  const { getDb } = await import("../db");
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível.");
  return d as unknown as Db;
}

export const nowMysql = (d: Date = new Date()) => d.toISOString().slice(0, 19).replace("T", " ");

const cityAliases = (c: string) => {
  const n = c.trim().toLowerCase();
  return n === "lisboa" ? ["Lisboa", "lisbon"] : n === "porto" ? ["Porto", "oporto"] : [c.trim()];
};

/**
 * Condição de visibilidade sobre kb_documents `d` (a mesma regra de
 * canSeeKbDoc). As listas são JSON escrito pela app (nunca texto do utilizador).
 */
export function kbVisibilitySql(viewer: KbViewer, alias = "d"): SQL {
  const col = (c: string) => sql.raw(`${alias}.${c}`);
  const noRoles = sql`(${col("visibilityRoles")} IS NULL OR ${col("visibilityRoles")} = '' OR ${col("visibilityRoles")} = '[]')`;
  const role = sql`(${noRoles} OR JSON_CONTAINS(${col("visibilityRoles")}, JSON_QUOTE(${viewer.role})))`;
  const noCities = sql`(${col("visibilityCities")} IS NULL OR ${col("visibilityCities")} = '' OR ${col("visibilityCities")} = '[]')`;
  if (viewer.allCities) return sql`(${role})`;
  const names = [...new Set(viewer.cityNames.flatMap(cityAliases))].filter((n) => /^[A-Za-zÀ-ÿ ]{2,40}$/.test(n));
  const any = names.length ? sql.join(names.map((n) => sql`JSON_CONTAINS(${col("visibilityCities")}, JSON_QUOTE(${n}))`), sql` OR `) : sql`1 = 0`;
  return sql`(${role} AND (${noCities} OR ${any}))`;
}

// ─── Documentos ──────────────────────────────────────────────────────────────

export interface KbDocRow {
  id: number;
  source: KbSource;
  driveFileId: string | null;
  folderPath: string | null;
  title: string;
  mimeType: string | null;
  webViewLink: string | null;
  fileKey: string | null;
  fileUrl: string | null;
  sizeBytes: number | null;
  modifiedTime: string | null;
  md5: string | null;
  checksum: string | null;
  status: KbStatus;
  error: string | null;
  attempts: number;
  visibility: KbVisibility;
  visibilityCustom: boolean;
  chunkCount: number;
  charCount: number;
  embedded: boolean;
  syncedAt: string | null;
  updatedAt: string | null;
}

const DOC_COLS = sql`d.id, d.source, d.driveFileId, d.folderPath, d.title, d.mimeType, d.webViewLink, d.fileKey, d.fileUrl, d.sizeBytes,
  d.modifiedTime, d.md5, d.checksum, d.status, d.error, d.attempts, d.visibilityRoles, d.visibilityCities, d.visibilityCustom,
  d.chunkCount, d.charCount, d.embedded, d.syncedAt, d.updatedAt`;

export function toDoc(r: any): KbDocRow {
  return {
    id: Number(r.id), source: String(r.source) as KbSource, driveFileId: s(r.driveFileId), folderPath: s(r.folderPath), title: String(r.title ?? ""),
    mimeType: s(r.mimeType), webViewLink: s(r.webViewLink), fileKey: s(r.fileKey), fileUrl: s(r.fileUrl),
    sizeBytes: r.sizeBytes != null ? Number(r.sizeBytes) : null, modifiedTime: s(r.modifiedTime), md5: s(r.md5), checksum: s(r.checksum),
    status: String(r.status ?? "pending") as KbStatus, error: s(r.error), attempts: Number(r.attempts ?? 0),
    visibility: parseVisibility(r.visibilityRoles, r.visibilityCities), visibilityCustom: Number(r.visibilityCustom ?? 0) === 1,
    chunkCount: Number(r.chunkCount ?? 0), charCount: Number(r.charCount ?? 0), embedded: Number(r.embedded ?? 0) === 1,
    syncedAt: s(r.syncedAt), updatedAt: s(r.updatedAt),
  };
}

export async function listDocs(d: Db, f: { q?: string | null; status?: KbStatus | null; source?: KbSource | null; limit?: number } = {}): Promise<KbDocRow[]> {
  const conds: SQL[] = [sql`d.deletedAt IS NULL`];
  if (f.status) conds.push(sql`d.status = ${f.status}`);
  if (f.source) conds.push(sql`d.source = ${f.source}`);
  const q = String(f.q ?? "").trim().toLowerCase().slice(0, 100);
  if (q) conds.push(sql`(LOWER(d.title) LIKE ${`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} OR LOWER(COALESCE(d.folderPath, '')) LIKE ${`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`})`);
  const rows = rowsOf(await d.execute(sql`SELECT ${DOC_COLS} FROM kb_documents d WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY d.source = 'help', d.title LIMIT ${Math.max(1, Math.min(1000, f.limit ?? 500))}`));
  return rows.map(toDoc);
}

export async function getDoc(d: Db, id: number, opts: { withText?: boolean } = {}): Promise<(KbDocRow & { textContent: string | null }) | null> {
  const r = rowsOf(await d.execute(sql`SELECT ${DOC_COLS}${opts.withText ? sql`, d.textContent` : sql``} FROM kb_documents d
    WHERE d.id = ${id} AND d.deletedAt IS NULL LIMIT 1`))[0];
  return r ? { ...toDoc(r), textContent: opts.withText ? s(r.textContent) : null } : null;
}

export async function insertDoc(d: Db, v: {
  source: KbSource; title: string; driveFileId?: string | null; folderPath?: string | null; mimeType?: string | null; webViewLink?: string | null;
  fileKey?: string | null; fileUrl?: string | null; sizeBytes?: number | null; modifiedTime?: string | null; md5?: string | null;
  visibility: KbVisibility; visibilityCustom?: boolean; createdById?: number | null; seenAt?: string | null;
}): Promise<number> {
  const res = await d.execute(sql`INSERT INTO kb_documents (source, driveFileId, folderPath, title, mimeType, webViewLink, fileKey, fileUrl, sizeBytes,
      modifiedTime, md5, status, visibilityRoles, visibilityCities, visibilityCustom, createdById, seenAt)
    VALUES (${v.source}, ${v.driveFileId ?? null}, ${v.folderPath ?? null}, ${v.title.slice(0, 300)}, ${v.mimeType ?? null}, ${v.webViewLink ?? null},
      ${v.fileKey ?? null}, ${v.fileUrl ?? null}, ${v.sizeBytes ?? null}, ${v.modifiedTime ?? null}, ${v.md5 ?? null}, 'pending',
      ${JSON.stringify(v.visibility.roles)}, ${JSON.stringify(v.visibility.cities)}, ${v.visibilityCustom ? 1 : 0}, ${v.createdById ?? null}, ${v.seenAt ?? null})`);
  return Number(header(res)?.insertId ?? 0);
}

export async function setVisibility(d: Db, id: number, v: KbVisibility, custom: boolean): Promise<void> {
  await d.execute(sql`UPDATE kb_documents SET visibilityRoles = ${JSON.stringify(v.roles)}, visibilityCities = ${JSON.stringify(v.cities)},
    visibilityCustom = ${custom ? 1 : 0} WHERE id = ${id}`);
}

export async function markStatus(d: Db, id: number, status: KbStatus, error: string | null = null): Promise<void> {
  await d.execute(sql`UPDATE kb_documents SET status = ${status}, error = ${error ? error.slice(0, 500) : null},
    attempts = ${status === "error" ? sql`attempts + 1` : status === "synced" ? sql`0` : sql`attempts`}
    ${status === "synced" ? sql`, syncedAt = ${nowMysql()}` : sql``} WHERE id = ${id}`);
}

export async function claimForProcessing(d: Db, id: number): Promise<boolean> {
  const res = await d.execute(sql`UPDATE kb_documents SET status = 'processing' WHERE id = ${id} AND status <> 'processing'`);
  return Number(header(res)?.affectedRows ?? 0) === 1;
}

/** Documentos por processar (pendentes, erros com tentativas e "a processar" presos há > 10 min). */
export async function pendingDocIds(d: Db, limit: number, now: Date = new Date()): Promise<number[]> {
  const stale = nowMysql(new Date(now.getTime() - 10 * 60_000));
  const rows = rowsOf(await d.execute(sql`SELECT d.id FROM kb_documents d WHERE d.deletedAt IS NULL AND (
      d.status = 'pending' OR (d.status = 'error' AND d.attempts < 3) OR (d.status = 'processing' AND d.updatedAt < ${stale}))
    ORDER BY d.status = 'error', d.updatedAt LIMIT ${limit}`));
  return rows.map((r) => Number(r.id));
}

/** Sincronizados sem vetores (para completar quando os embeddings ficam disponíveis). */
export async function unembeddedDocIds(d: Db, limit: number): Promise<number[]> {
  const rows = rowsOf(await d.execute(sql`SELECT d.id FROM kb_documents d WHERE d.deletedAt IS NULL AND d.status = 'synced'
    AND d.embedded = 0 AND d.chunkCount > 0 ORDER BY d.updatedAt LIMIT ${limit}`));
  return rows.map((r) => Number(r.id));
}

export async function saveExtraction(d: Db, id: number, v: { text: string; checksum: string; chunks: KbChunk[]; maxTextChars?: number }): Promise<void> {
  const text = v.text.slice(0, v.maxTextChars ?? 400_000);
  await d.execute(sql`DELETE FROM kb_chunks WHERE docId = ${id}`);
  for (let i = 0; i < v.chunks.length; i += 25) {
    const part = v.chunks.slice(i, i + 25);
    await d.execute(sql`INSERT INTO kb_chunks (docId, ord, section, text, tokens) VALUES ${sql.join(
      part.map((c) => sql`(${id}, ${c.ord}, ${c.section ? c.section.slice(0, 300) : null}, ${c.text}, ${c.tokens})`), sql`, `)}`);
  }
  await d.execute(sql`UPDATE kb_documents SET textContent = ${text}, checksum = ${v.checksum}, chunkCount = ${v.chunks.length},
    charCount = ${v.text.length}, embedded = 0, embedModel = NULL WHERE id = ${id}`);
}

export async function chunksOf(d: Db, docId: number): Promise<Array<{ id: number; ord: number; section: string | null; text: string; hasEmbedding: boolean }>> {
  return rowsOf(await d.execute(sql`SELECT id, ord, section, text, (embedding IS NOT NULL) AS hasEmb FROM kb_chunks WHERE docId = ${docId} ORDER BY ord`))
    .map((r) => ({ id: Number(r.id), ord: Number(r.ord), section: s(r.section), text: String(r.text ?? ""), hasEmbedding: Number(r.hasEmb ?? 0) === 1 }));
}

export async function saveEmbeddings(d: Db, docId: number, items: Array<{ chunkId: number; vector: string }>, model: string): Promise<void> {
  for (const it of items) await d.execute(sql`UPDATE kb_chunks SET embedding = ${it.vector} WHERE id = ${it.chunkId} AND docId = ${docId}`);
  await d.execute(sql`UPDATE kb_documents SET embedded = 1, embedModel = ${model} WHERE id = ${docId}`);
}

export async function deleteDocHard(d: Db, id: number): Promise<void> {
  await d.execute(sql`DELETE FROM kb_chunks WHERE docId = ${id}`);
  await d.execute(sql`DELETE FROM kb_documents WHERE id = ${id}`);
}

/** Tira do índice (fica a linha, para a sincronização do Drive não o voltar a trazer). */
export async function excludeDoc(d: Db, id: number): Promise<void> {
  await d.execute(sql`DELETE FROM kb_chunks WHERE docId = ${id}`);
  await d.execute(sql`UPDATE kb_documents SET status = 'skipped', error = 'Excluído por um administrador.', chunkCount = 0, embedded = 0 WHERE id = ${id}`);
}

export async function statusCounts(d: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const r of rowsOf(await d.execute(sql`SELECT status, COUNT(*) AS n FROM kb_documents WHERE deletedAt IS NULL GROUP BY status`))) out[String(r.status)] = Number(r.n);
  return out;
}

// ─── Estado da sincronização ─────────────────────────────────────────────────

export async function getState(d: Db, key: string): Promise<string | null> {
  const r = rowsOf(await d.execute(sql`SELECT value FROM kb_sync_state WHERE stateKey = ${key} LIMIT 1`))[0];
  return r?.value != null ? String(r.value) : null;
}
export async function setState(d: Db, key: string, value: string | null): Promise<void> {
  await d.execute(sql`INSERT INTO kb_sync_state (stateKey, value) VALUES (${key}, ${value}) ON DUPLICATE KEY UPDATE value = VALUES(value)`);
}
