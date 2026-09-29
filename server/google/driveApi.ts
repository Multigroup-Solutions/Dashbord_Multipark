/**
 * Adaptadores das APIs OFICIAIS Google Drive (@googleapis/drive v3), Docs
 * (@googleapis/docs v1) e Sheets (@googleapis/sheets v4), sempre com prazo
 * (timedFetch → fetchWithTimeout) e repetição com espera exponencial nos
 * limites de pedidos (apis.ts → withGoogleRetry).
 *
 * O envio de ficheiros (multipart) é feito aqui com um corpo em memória pelo
 * mesmo `fetch` com prazo (o upload em stream do googleapis-common depende do
 * transporte) — o token vem do próprio cliente de autenticação e nunca é
 * registado.
 *
 * Os serviços (driveService.ts, sheetsExport.ts) só conhecem as interfaces
 * `DriveApiLike` / `DocsApiLike` / `SheetsApiLike` — os testes usam falsas.
 */
import type { JWT, OAuth2Client } from "google-auth-library";
import { drive as driveFactory, type drive_v3 } from "@googleapis/drive";
import { docs as docsFactory, type docs_v1 } from "@googleapis/docs";
import { sheets as sheetsFactory, type sheets_v4 } from "@googleapis/sheets";
import { GOOGLE_API_TIMEOUT_MS, httpStatusOf, timedFetch } from "./workspace";
import { withGoogleRetry, type RetryOptions } from "./apis";
import { GOOGLE_MIME, driveQueryLiteral } from "../../shared/drive";

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string | null;
  webViewLink: string | null;
  iconLink: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  driveId: string | null;
  size: number | null;
}

export interface DriveApiLike {
  getFile(fileId: string): Promise<DriveFileMeta>;
  findFolder(name: string, parentId: string, driveId?: string | null): Promise<string | null>;
  createFolder(name: string, parentId: string | null): Promise<string>;
  createFile(meta: { name: string; mimeType: string; parents?: string[] }): Promise<DriveFileMeta>;
  upload(meta: { name: string; mimeType: string; parents?: string[]; convertTo?: string | null }, bytes: Buffer): Promise<DriveFileMeta>;
  copy(fileId: string, meta: { name: string; parents?: string[] }): Promise<DriveFileMeta>;
  exportAs(fileId: string, mimeType: string): Promise<Buffer>;
  download(fileId: string): Promise<Buffer>;
  shareWithUser(fileId: string, email: string, role: "reader" | "writer"): Promise<void>;
  findSharedDrive(name: string): Promise<string | null>;
  remove(fileId: string): Promise<void>;
}

export interface DocsApiLike {
  batchUpdate(documentId: string, requests: docs_v1.Schema$Request[]): Promise<{ replaced: number }>;
}

export interface SheetsApiLike {
  listSheets(spreadsheetId: string): Promise<Array<{ sheetId: number; title: string }>>;
  batchUpdate(spreadsheetId: string, requests: sheets_v4.Schema$Request[]): Promise<void>;
  writeValues(spreadsheetId: string, data: Array<{ range: string; values: unknown[][] }>): Promise<void>;
  clearValues(spreadsheetId: string, ranges: string[]): Promise<void>;
  readValues(spreadsheetId: string, range: string): Promise<unknown[][]>;
}

export type GoogleAuth = OAuth2Client | JWT;

const FILE_FIELDS = "id,name,mimeType,webViewLink,iconLink,owners(emailAddress,displayName),driveId,size";

export function toMeta(f: drive_v3.Schema$File | null | undefined): DriveFileMeta {
  const owner = f?.owners?.[0];
  return {
    id: String(f?.id ?? ""),
    name: String(f?.name ?? ""),
    mimeType: f?.mimeType ?? null,
    webViewLink: f?.webViewLink ?? null,
    iconLink: f?.iconLink ?? null,
    ownerEmail: owner?.emailAddress ?? null,
    ownerName: owner?.displayName ?? null,
    driveId: f?.driveId ?? null,
    size: f?.size != null && Number.isFinite(Number(f.size)) ? Number(f.size) : null,
  };
}

export function driveFor(auth: GoogleAuth): drive_v3.Drive {
  return (driveFactory as any)({ version: "v3", auth, timeout: GOOGLE_API_TIMEOUT_MS, fetchImplementation: timedFetch() }) as drive_v3.Drive;
}
export function docsFor(auth: GoogleAuth): docs_v1.Docs {
  return (docsFactory as any)({ version: "v1", auth, timeout: GOOGLE_API_TIMEOUT_MS, fetchImplementation: timedFetch() }) as docs_v1.Docs;
}
export function sheetsFor(auth: GoogleAuth): sheets_v4.Sheets {
  return (sheetsFactory as any)({ version: "v4", auth, timeout: GOOGLE_API_TIMEOUT_MS, fetchImplementation: timedFetch() }) as sheets_v4.Sheets;
}

/** Corpo multipart/related (metadados JSON + conteúdo). PURA. */
export function multipartBody(meta: Record<string, unknown>, bytes: Buffer, mimeType: string, boundary: string): Buffer {
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "utf8"), bytes, Buffer.from(`\r\n--${boundary}--`, "utf8")]);
}

/** Envio (upload) de ficheiros: até 40 s (ficheiros até 20 MB). */
export const DRIVE_UPLOAD_TIMEOUT_MS = 40_000;
export const DRIVE_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function wrapDrive(d: drive_v3.Drive, auth: GoogleAuth, retry: RetryOptions): DriveApiLike {
  const r = <T>(fn: () => Promise<T>) => withGoogleRetry(fn, retry);
  const all = { supportsAllDrives: true } as const;
  return {
    async getFile(fileId) {
      return toMeta((await r(() => d.files.get({ fileId, fields: FILE_FIELDS, ...all }))).data);
    },
    async findFolder(name, parentId, driveId) {
      const q = `${driveQueryLiteral(parentId)} in parents and name = ${driveQueryLiteral(name)} and mimeType = '${GOOGLE_MIME.folder}' and trashed = false`;
      const res = await r(() => d.files.list({
        q, fields: "files(id,name)", pageSize: 5, ...all, includeItemsFromAllDrives: true,
        ...(driveId ? { corpora: "drive", driveId } : { corpora: "user" }),
      }));
      return res.data.files?.[0]?.id ?? null;
    },
    async createFolder(name, parentId) {
      const res = await r(() => d.files.create({ requestBody: { name, mimeType: GOOGLE_MIME.folder, ...(parentId ? { parents: [parentId] } : {}) }, fields: "id", ...all }));
      return String(res.data.id);
    },
    async createFile(meta) {
      return toMeta((await r(() => d.files.create({ requestBody: meta, fields: FILE_FIELDS, ...all }))).data);
    },
    async upload(meta, bytes) {
      if (bytes.length > DRIVE_MAX_UPLOAD_BYTES) throw new Error("Ficheiro demasiado grande para enviar ao Drive (máx. 20 MB).");
      const { token } = await auth.getAccessToken();
      if (!token) throw new Error("Sem autorização para o Google Drive.");
      const boundary = `multipark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const body = multipartBody({ name: meta.name, mimeType: meta.convertTo ?? meta.mimeType, ...(meta.parents ? { parents: meta.parents } : {}) }, bytes, meta.mimeType, boundary);
      const url = `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`;
      const res = await r(async () => {
        const resp = await timedFetch(DRIVE_UPLOAD_TIMEOUT_MS)(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
          body: new Uint8Array(body),
        });
        const json: any = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          const err: any = new Error(String(json?.error?.message ?? `Drive respondeu ${resp.status}`));
          err.response = { status: resp.status, data: json };
          throw err;
        }
        return json;
      });
      return toMeta(res);
    },
    async copy(fileId, meta) {
      return toMeta((await r(() => d.files.copy({ fileId, requestBody: meta, fields: FILE_FIELDS, ...all }))).data);
    },
    async exportAs(fileId, mimeType) {
      const res = await r(() => d.files.export({ fileId, mimeType }, { responseType: "arraybuffer" }));
      return Buffer.from(res.data as ArrayBuffer);
    },
    async download(fileId) {
      const res = await r(() => d.files.get({ fileId, alt: "media", ...all }, { responseType: "arraybuffer" }));
      return Buffer.from(res.data as unknown as ArrayBuffer);
    },
    async shareWithUser(fileId, email, role) {
      try {
        await r(() => d.permissions.create({ fileId, sendNotificationEmail: false, requestBody: { type: "user", role, emailAddress: email }, ...all }));
      } catch (err) { if (httpStatusOf(err) !== 409) throw err; }
    },
    async findSharedDrive(name) {
      const res = await r(() => d.drives.list({ q: `name = ${driveQueryLiteral(name)} and hidden = false`, pageSize: 10, fields: "drives(id,name)" }));
      const exact = (res.data.drives ?? []).find((x) => x.name === name);
      return exact?.id ?? res.data.drives?.[0]?.id ?? null;
    },
    async remove(fileId) {
      try { await r(() => d.files.delete({ fileId, ...all })); }
      catch (err) { if (![404, 410].includes(httpStatusOf(err) ?? 0)) throw err; }
    },
  };
}

export function wrapDocs(c: docs_v1.Docs, retry: RetryOptions): DocsApiLike {
  return {
    async batchUpdate(documentId, requests) {
      if (!requests.length) return { replaced: 0 };
      const res = await withGoogleRetry(() => c.documents.batchUpdate({ documentId, requestBody: { requests } }), retry);
      const replaced = (res.data.replies ?? []).reduce((s, x) => s + Number(x.replaceAllText?.occurrencesChanged ?? 0), 0);
      return { replaced };
    },
  };
}

export function wrapSheets(s: sheets_v4.Sheets, retry: RetryOptions): SheetsApiLike {
  const r = <T>(fn: () => Promise<T>) => withGoogleRetry(fn, retry);
  return {
    async listSheets(spreadsheetId) {
      const res = await r(() => s.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" }));
      return (res.data.sheets ?? []).map((x) => ({ sheetId: Number(x.properties?.sheetId ?? 0), title: String(x.properties?.title ?? "") }));
    },
    async batchUpdate(spreadsheetId, requests) {
      if (!requests.length) return;
      await r(() => s.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }));
    },
    async writeValues(spreadsheetId, data) {
      if (!data.length) return;
      // RAW: nada é interpretado como fórmula (sem injeção de fórmulas).
      await r(() => s.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: "RAW", data: data as any } }));
    },
    async clearValues(spreadsheetId, ranges) {
      if (!ranges.length) return;
      await r(() => s.spreadsheets.values.batchClear({ spreadsheetId, requestBody: { ranges } }));
    },
    async readValues(spreadsheetId, range) {
      const res = await r(() => s.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: "FORMATTED_VALUE" }));
      return (res.data.values ?? []) as unknown[][];
    },
  };
}

/** As três APIs com o mesmo cliente de autenticação e o mesmo prazo. */
export function googleWorkspaceApis(auth: GoogleAuth, deadlineAt: number): { drive: DriveApiLike; docs: DocsApiLike; sheets: SheetsApiLike } {
  const retry: RetryOptions = { deadlineAt };
  return { drive: wrapDrive(driveFor(auth), auth, retry), docs: wrapDocs(docsFor(auth), retry), sheets: wrapSheets(sheetsFor(auth), retry) };
}
