/**
 * Pastas criadas pela app, a pedido e com cache (google_drive_folders):
 *  - "Multipark" no Drive de cada pessoa (drive.file: a app só encontra as
 *    pastas que ela própria criou — é o que se quer);
 *  - o caminho de um registo no Shared Drive (Clientes/<nome>,
 *    Reclamações/<ano>/<id>, RH/<cidade>/<trabalhador>, …).
 * Cada nível: cache → procura (nome exato, não apagada) → cria. Uma pasta
 * apagada no Drive (404) invalida a cache e é recriada.
 */
import { sql } from "drizzle-orm";
import { folderPathKey, sanitizeDriveName, USER_DRIVE_FOLDER } from "../../shared/drive";
import { httpStatusOf } from "./workspace";
import type { DriveApiLike } from "./driveApi";

export interface FolderStore {
  get(scopeKey: string, pathKey: string): Promise<string | null>;
  put(scopeKey: string, pathKey: string, folderId: string): Promise<void>;
  forget(scopeKey: string, pathKey: string): Promise<void>;
}

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

/** Cache na BD (google_drive_folders). */
export const dbFolderStore: FolderStore = {
  async get(scopeKey, pathKey) {
    const { getDb } = await import("../db");
    const d = await getDb();
    if (!d) return null;
    const r = rowsOf(await d.execute(sql`SELECT folderId FROM google_drive_folders WHERE scopeKey = ${scopeKey} AND pathKey = ${pathKey} LIMIT 1`))[0];
    return r?.folderId ? String(r.folderId) : null;
  },
  async put(scopeKey, pathKey, folderId) {
    const { getDb } = await import("../db");
    const d = await getDb();
    if (!d) return;
    await d.execute(sql`INSERT INTO google_drive_folders (scopeKey, pathKey, folderId) VALUES (${scopeKey}, ${pathKey}, ${folderId})
      ON DUPLICATE KEY UPDATE folderId = VALUES(folderId)`);
  },
  async forget(scopeKey, pathKey) {
    const { getDb } = await import("../db");
    const d = await getDb();
    if (!d) return;
    await d.execute(sql`DELETE FROM google_drive_folders WHERE scopeKey = ${scopeKey} AND pathKey = ${pathKey}`);
  },
};

/** A pasta ainda existe (e não está no lixo)? 404 → não. */
async function stillThere(api: DriveApiLike, folderId: string): Promise<boolean> {
  try { await api.getFile(folderId); return true; }
  catch (err) { if ([404, 410].includes(httpStatusOf(err) ?? 0)) return false; throw err; }
}

/**
 * Garante o caminho `segments` debaixo de `rootId` (id da pasta raiz, do
 * Shared Drive ou "root" no Drive da pessoa). Devolve o id da última pasta.
 * `verify`: confirma as pastas da cache (1 pedido) — ligado nas ações de
 * utilizador, desligado nos lotes do cron (a falha seguinte limpa a cache).
 */
export async function ensureFolderPath(
  api: DriveApiLike,
  store: FolderStore,
  o: { scopeKey: string; rootId: string; driveId?: string | null; segments: readonly string[]; verify?: boolean },
): Promise<string> {
  let parent = o.rootId;
  const done: string[] = [];
  for (const raw of o.segments) {
    const name = sanitizeDriveName(raw);
    done.push(name);
    const key = folderPathKey(done);
    let id = await store.get(o.scopeKey, key);
    if (id && o.verify && !(await stillThere(api, id))) {
      await store.forget(o.scopeKey, key);
      id = null;
    }
    if (!id) {
      id = await api.findFolder(name, parent, o.driveId ?? null);
      if (!id) id = await api.createFolder(name, parent);
      await store.put(o.scopeKey, key, id);
    }
    parent = id;
  }
  return parent;
}

export const userScopeKey = (userId: number) => `user:${Math.trunc(userId)}`;
export const sharedScopeKey = (driveId: string) => `shared:${driveId}`.slice(0, 64);

/** Pasta "Multipark" no Drive da pessoa (criada pela app). */
export async function ensureUserFolder(api: DriveApiLike, userId: number, store: FolderStore = dbFolderStore): Promise<string> {
  return ensureFolderPath(api, store, { scopeKey: userScopeKey(userId), rootId: "root", segments: [USER_DRIVE_FOLDER], verify: true });
}
