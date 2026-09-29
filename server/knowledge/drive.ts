/**
 * Base de conhecimento — acesso ao Shared Drive "Multipark" (conta de serviço
 * com delegação a impersonar a conta dona, a mesma do resto do Drive). Só o
 * que a sincronização precisa: listar pastas (com modifiedTime/md5), exportar
 * Google Docs em texto, descarregar e converter PDF/DOCX em Google Doc (cópia
 * temporária, apagada logo a seguir) para exportar o texto — sem bibliotecas
 * novas de PDF.
 *
 * `KbDriveApi` é a interface que a sincronização conhece — os testes usam uma
 * falsa.
 */
import { GOOGLE_MIME, DWD_DRIVE_SCOPES, driveQueryLiteral } from "../../shared/drive";

export interface KbDriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  md5: string | null;
  size: number | null;
  webViewLink: string | null;
}

export interface KbDriveApi {
  /** Id do Shared Drive (raiz). */
  driveId: string;
  findFolder(name: string, parentId: string): Promise<string | null>;
  list(folderId: string, pageToken?: string | null): Promise<{ files: KbDriveFile[]; nextPageToken: string | null }>;
  exportText(fileId: string): Promise<string>;
  download(fileId: string): Promise<Buffer>;
  /** Copia como Google Doc (o Drive converte PDF/DOCX, com OCR), exporta o texto e apaga a cópia. */
  convertToText(fileId: string, name: string): Promise<string>;
  /** Carrega bytes como Google Doc (conversão), exporta o texto e apaga-o. */
  uploadAndConvert(bytes: Buffer, mimeType: string, name: string): Promise<string>;
}

/** Tipos que a base de conhecimento lê. PURA. */
export function isSupportedKbMime(mime: string | null | undefined): boolean {
  const m = String(mime ?? "");
  return m === GOOGLE_MIME.doc || m === GOOGLE_MIME.slides || m === GOOGLE_MIME.pdf || m === GOOGLE_MIME.docx
    || m === "text/plain" || m === "text/markdown";
}

const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;

/** Contexto real (Shared Drive configurado + delegação); null se não houver. */
export async function kbDriveApi(deadlineAt: number): Promise<KbDriveApi | null> {
  const { loadDriveConfig, getDriveState, setDriveState } = await import("../google/driveService");
  const { dwdConfigured, delegatedClient, httpStatusOf } = await import("../google/workspace");
  const cfg = await loadDriveConfig();
  if (!cfg.sharedEnabled || !cfg.ownerEmail || !dwdConfigured()) return null;
  const { driveFor, googleWorkspaceApis } = await import("../google/driveApi");
  const { withGoogleRetry } = await import("../google/apis");
  const client = delegatedClient(cfg.ownerEmail, DWD_DRIVE_SCOPES);
  const drive = driveFor(client);
  const wrapped = googleWorkspaceApis(client, deadlineAt).drive;
  const retry = { deadlineAt };
  const r = <T>(fn: () => Promise<T>) => withGoogleRetry(fn, retry);
  const all = { supportsAllDrives: true } as const;
  const key = `drive:${cfg.sharedDriveName}`.slice(0, 64);
  let driveId = await getDriveState(key);
  if (!driveId) {
    driveId = await wrapped.findSharedDrive(cfg.sharedDriveName);
    if (!driveId) throw new Error(`Shared Drive "${cfg.sharedDriveName}" não encontrado.`);
    await setDriveState(key, driveId).catch(() => undefined);
  }
  const sharedId = driveId;

  const exportText = async (fileId: string) => {
    const buf = await wrapped.exportAs(fileId, "text/plain");
    return buf.toString("utf8");
  };
  const removeQuietly = async (fileId: string) => {
    try { await r(() => drive.files.delete({ fileId, ...all })); } catch (err) { if (![404, 410].includes(httpStatusOf(err) ?? 0)) throw err; }
  };

  return {
    driveId: sharedId,
    findFolder: (name, parentId) => wrapped.findFolder(name, parentId, sharedId),
    async list(folderId, pageToken) {
      const res = await r(() => drive.files.list({
        q: `${driveQueryLiteral(folderId)} in parents and trashed = false`,
        fields: "nextPageToken, files(id,name,mimeType,modifiedTime,md5Checksum,size,webViewLink)",
        pageSize: 100, corpora: "drive", driveId: sharedId, includeItemsFromAllDrives: true, ...all,
        ...(pageToken ? { pageToken } : {}),
      }));
      return {
        nextPageToken: res.data.nextPageToken ?? null,
        files: (res.data.files ?? []).map((f) => ({
          id: String(f.id ?? ""), name: String(f.name ?? ""), mimeType: String(f.mimeType ?? ""),
          modifiedTime: f.modifiedTime ?? null, md5: f.md5Checksum ?? null,
          size: f.size != null && Number.isFinite(Number(f.size)) ? Number(f.size) : null, webViewLink: f.webViewLink ?? null,
        })),
      };
    },
    exportText,
    async download(fileId) {
      const buf = await wrapped.download(fileId);
      if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error("Ficheiro demasiado grande (máx. 15 MB).");
      return buf;
    },
    async convertToText(fileId, name) {
      const res = await r(() => drive.files.copy({ fileId, requestBody: { name: `[conversão] ${name}`.slice(0, 200), mimeType: GOOGLE_MIME.doc }, fields: "id", ...all }));
      const copyId = String(res.data.id ?? "");
      if (!copyId) throw new Error("Conversão sem ficheiro.");
      try { return await exportText(copyId); } finally { await removeQuietly(copyId); }
    },
    async uploadAndConvert(bytes, mimeType, name) {
      const meta = await wrapped.upload({ name: `[conversão] ${name}`.slice(0, 200), mimeType, parents: [sharedId], convertTo: GOOGLE_MIME.doc }, bytes);
      if (!meta.id) throw new Error("Conversão sem ficheiro.");
      try { return await exportText(meta.id); } finally { await removeQuietly(meta.id); }
    },
  };
}
