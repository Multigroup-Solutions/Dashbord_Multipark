/**
 * Base de conhecimento — alterações no Shared Drive por notificação da Google
 * (changes.watch; canal em server/google/pushChannels.ts, âmbito `drive:kb`).
 *
 * Cada notificação (ou a verificação de 4 em 4 h do google-sync) lê só o que
 * mudou desde o último `pageToken` (changes.list, guardado em
 * google_drive_state) e:
 *  - documento já indexado → atualiza os metadados e fica "por processar"
 *    se o modifiedTime/md5 mudou; apagado/no lixo → sai do índice;
 *  - ficheiro/pasta novo numa pasta da base de conhecimento (subindo pelos
 *    pais até uma das pastas configuradas) → pede uma volta completa às
 *    pastas (descoberta) na corrida seguinte;
 *  - o resto do Shared Drive (ex.: o espelho das provas das reclamações) é
 *    ignorado sem mais chamadas do que a subida pelos pais.
 * Depois, só se houve alguma coisa, corre a sincronização da base de
 * conhecimento (processa os documentos por processar, até ao prazo).
 * Nunca regista conteúdo (só ids e contagens).
 */
import { sql } from "drizzle-orm";
import { GOOGLE_MIME } from "../../shared/drive";
import { isSupportedKbMime } from "./drive";
import * as store from "./store";

export interface KbChange {
  fileId: string;
  removed: boolean;
  file: { id: string; name: string; mimeType: string; modifiedTime: string | null; md5: string | null; size: number | null; webViewLink: string | null; parents: string[]; trashed: boolean } | null;
}

export interface KbChangesApi {
  driveId: string;
  startPageToken(): Promise<string>;
  listChanges(pageToken: string): Promise<{ changes: KbChange[]; nextPageToken: string | null; newStartPageToken: string | null }>;
  parentsOf(fileId: string): Promise<string[]>;
}

export const kbPageTokenKey = (driveId: string) => `changes:kb:${driveId}`.slice(0, 64);

/**
 * O ficheiro está numa das pastas `roots` (até `maxDepth` níveis acima)?
 * Pára no Shared Drive (raiz). `cache` guarda o resultado por pasta. PURA
 * (com a leitura dos pais injetada).
 */
export async function isUnderRoots(parents: readonly string[], roots: ReadonlySet<string>, driveId: string, parentsOf: (id: string) => Promise<string[]>, cache: Map<string, boolean> = new Map(), maxDepth = 6): Promise<boolean> {
  const visit = async (id: string, depth: number): Promise<boolean> => {
    if (roots.has(id)) return true;
    if (id === driveId || depth >= maxDepth) return false;
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    let up: string[] = [];
    try { up = await parentsOf(id); } catch { up = []; }
    let r = false;
    for (const p of up) if (await visit(p, depth + 1)) { r = true; break; }
    cache.set(id, r);
    return r;
  };
  for (const p of parents) if (await visit(p, 0)) return true;
  return false;
}

export interface KbChangesResult {
  pageToken: string;
  seen: number;
  updated: number;
  removed: number;
  needsDiscovery: boolean;
  done: boolean;
}

/** Aplica as alterações desde `pageToken` (até ao prazo); devolve o token seguinte. */
export async function applyKbChanges(d: store.Db, api: KbChangesApi, roots: ReadonlySet<string>, pageToken: string, deadlineAt: number): Promise<KbChangesResult> {
  const out: KbChangesResult = { pageToken, seen: 0, updated: 0, removed: 0, needsDiscovery: false, done: true };
  const cache = new Map<string, boolean>();
  let token = pageToken;
  for (let page = 0; page < 50; page++) {
    if (Date.now() > deadlineAt - 8_000) { out.done = false; break; }
    const r = await api.listChanges(token);
    for (const c of r.changes) {
      out.seen++;
      const known = store.rowsOf(await d.execute(sql`SELECT id, modifiedTime, md5, status FROM kb_documents
        WHERE driveFileId = ${c.fileId} AND source = 'drive' LIMIT 1`))[0];
      const gone = c.removed || !c.file || c.file.trashed;
      if (known) {
        if (gone) {
          await d.execute(sql`DELETE FROM kb_chunks WHERE docId = ${Number(known.id)}`);
          await d.execute(sql`UPDATE kb_documents SET deletedAt = ${store.nowMysql()}, chunkCount = 0 WHERE id = ${Number(known.id)} AND deletedAt IS NULL`);
          out.removed++;
          continue;
        }
        const f = c.file!;
        const changed = String(known.modifiedTime ?? "") !== String(f.modifiedTime ?? "") || String(known.md5 ?? "") !== String(f.md5 ?? "");
        const excluded = String(known.status) === "skipped";
        const title = f.name.replace(/\.(pdf|docx|txt|md)$/i, "").slice(0, 300) || "(sem título)";
        await d.execute(sql`UPDATE kb_documents SET title = ${title}, mimeType = ${f.mimeType}, webViewLink = ${f.webViewLink}, sizeBytes = ${f.size},
            modifiedTime = ${f.modifiedTime}, md5 = ${f.md5}, deletedAt = NULL
            ${changed && !excluded ? sql`, status = 'pending', attempts = 0, error = NULL` : sql``}
          WHERE id = ${Number(known.id)}`);
        if (changed && !excluded) out.updated++;
        continue;
      }
      if (gone) continue;
      const f = c.file!;
      const relevant = f.mimeType === GOOGLE_MIME.folder || isSupportedKbMime(f.mimeType);
      if (!relevant || out.needsDiscovery) continue;
      if (await isUnderRoots(f.parents, roots, api.driveId, (id) => api.parentsOf(id), cache)) out.needsDiscovery = true;
    }
    if (r.nextPageToken) { token = r.nextPageToken; continue; }
    token = r.newStartPageToken ?? token;
    break;
  }
  out.pageToken = token;
  return out;
}

/** API real (conta de serviço com delegação a impersonar a conta dona do Shared Drive). */
export async function realKbChangesApi(deadlineAt: number): Promise<KbChangesApi | null> {
  const { loadDriveConfig } = await import("../google/driveService");
  const { dwdConfigured, delegatedClient } = await import("../google/workspace");
  const { DWD_DRIVE_SCOPES } = await import("../../shared/drive");
  const cfg = await loadDriveConfig();
  if (!cfg.sharedEnabled || !cfg.ownerEmail || !dwdConfigured()) return null;
  const { kbDriveApi } = await import("./drive");
  const kb = await kbDriveApi(deadlineAt);
  if (!kb) return null;
  const { driveFor } = await import("../google/driveApi");
  const { withGoogleRetry } = await import("../google/apis");
  const drive = driveFor(delegatedClient(cfg.ownerEmail, DWD_DRIVE_SCOPES));
  const r = <T>(fn: () => Promise<T>) => withGoogleRetry(fn, { deadlineAt });
  const all = { supportsAllDrives: true } as const;
  return {
    driveId: kb.driveId,
    async startPageToken() {
      const res = await r(() => drive.changes.getStartPageToken({ driveId: kb.driveId, ...all }));
      return String(res.data.startPageToken ?? "");
    },
    async listChanges(pageToken) {
      const res = await r(() => drive.changes.list({
        pageToken, driveId: kb.driveId, includeItemsFromAllDrives: true, includeRemoved: true, pageSize: 200, ...all,
        fields: "nextPageToken, newStartPageToken, changes(fileId, removed, file(id,name,mimeType,modifiedTime,md5Checksum,size,webViewLink,parents,trashed))",
      }));
      return {
        nextPageToken: res.data.nextPageToken ?? null,
        newStartPageToken: res.data.newStartPageToken ?? null,
        changes: (res.data.changes ?? []).filter((c) => c.fileId).map((c) => ({
          fileId: String(c.fileId), removed: !!c.removed,
          file: c.file ? {
            id: String(c.file.id ?? c.fileId), name: String(c.file.name ?? ""), mimeType: String(c.file.mimeType ?? ""),
            modifiedTime: c.file.modifiedTime ?? null, md5: c.file.md5Checksum ?? null,
            size: c.file.size != null && Number.isFinite(Number(c.file.size)) ? Number(c.file.size) : null,
            webViewLink: c.file.webViewLink ?? null, parents: (c.file.parents ?? []).map(String), trashed: !!c.file.trashed,
          } : null,
        })),
      };
    },
    async parentsOf(fileId) {
      const res = await r(() => drive.files.get({ fileId, fields: "parents", ...all }));
      return (res.data.parents ?? []).map(String);
    },
  };
}

/** Token guardado das alterações do Shared Drive (cria um, a partir de agora, se não houver). */
export async function kbChangesPageToken(api: Pick<KbChangesApi, "driveId" | "startPageToken">): Promise<{ token: string; fresh: boolean }> {
  const { getDriveState, setDriveState } = await import("../google/driveService");
  const key = kbPageTokenKey(api.driveId);
  const saved = await getDriveState(key);
  if (saved) return { token: saved, fresh: false };
  const token = await api.startPageToken();
  if (!token) throw new Error("A Google não devolveu o ponto de partida das alterações do Drive.");
  await setDriveState(key, token);
  return { token, fresh: true };
}

export interface KbChangesRun { status: "ok" | "partial" | "skipped" | "error"; seen: number; updated: number; removed: number; discovery: boolean; processed: number; error: string | null }

/**
 * Uma corrida do âmbito `drive:kb`: alterações desde o último token e, se
 * houve alguma coisa (ou `force` — verificação de 4 h), a sincronização da
 * base de conhecimento até ao prazo.
 */
export async function runKbChanges(opts: { deadlineAt: number; force?: boolean }): Promise<KbChangesRun> {
  const out: KbChangesRun = { status: "ok", seen: 0, updated: 0, removed: 0, discovery: false, processed: 0, error: null };
  try {
    const { loadKnowledgeConfig, resolveFolder, forceNextDiscovery, runKnowledgeSync } = await import("./sync");
    const cfg = await loadKnowledgeConfig();
    if (!cfg.driveEnabled || !cfg.folders.length) { out.status = "skipped"; return out; }
    const api = await realKbChangesApi(opts.deadlineAt);
    if (!api) { out.status = "skipped"; return out; }
    const d = await store.kbDb();
    const { token, fresh } = await kbChangesPageToken(api);
    let run = !!opts.force || fresh;
    if (!fresh) {
      const { kbDriveApi } = await import("./drive");
      const kb = await kbDriveApi(opts.deadlineAt);
      const roots = new Set<string>();
      if (kb) for (const f of cfg.folders) { const id = await resolveFolder(kb, f.path).catch(() => null); if (id) roots.add(id); }
      const r = await applyKbChanges(d, api, roots, token, opts.deadlineAt);
      const { setDriveState } = await import("../google/driveService");
      if (r.pageToken !== token) await setDriveState(kbPageTokenKey(api.driveId), r.pageToken);
      Object.assign(out, { seen: r.seen, updated: r.updated, removed: r.removed, discovery: r.needsDiscovery });
      if (r.needsDiscovery) await forceNextDiscovery(d);
      if (r.updated || r.removed || r.needsDiscovery) run = true;
      if (!r.done) out.status = "partial";
    } else {
      // Primeiro token: não se sabe o que mudou antes → volta completa.
      await forceNextDiscovery(d);
      out.discovery = true;
    }
    // Trabalho a meio de uma corrida anterior (documentos por processar ou
    // uma volta às pastas por acabar) → continua.
    if (!run && ((await store.pendingDocIds(d, 1)).length || (await store.getState(d, "drive:cursor")))) run = true;
    if (run && Date.now() < opts.deadlineAt - 12_000) {
      const k = await runKnowledgeSync({ deadlineAt: opts.deadlineAt - 2_000 });
      out.processed = k.processed;
      if (!k.done) out.status = "partial";
      if (!k.ok) { out.status = "error"; out.error = k.errors[0] ?? "erro na base de conhecimento"; }
    } else if (run) out.status = "partial";
    return out;
  } catch (err: any) {
    out.status = "error";
    out.error = String(err?.message ?? err).replace(/\s+/g, " ").slice(0, 200);
    return out;
  }
}
