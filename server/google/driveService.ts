/**
 * Google Drive / Docs / Sheets — serviço (BD + APIs). As regras puras estão
 * em shared/drive.ts; o acesso aos registos em driveAccess.ts; o exportador
 * em sheetsExport.ts; os trabalhos do cron (espelho, relatórios ao vivo) em
 * driveJobs.ts.
 *
 *  - Drive da pessoa (OAuth, só drive.file): pasta "Multipark" criada pela
 *    app, "Guardar no Drive", "Exportar para Sheets", documentos gerados em
 *    "O meu Drive", importação de uma folha escolhida com o Picker;
 *  - Shared Drive da empresa (conta de serviço com delegação a impersonar a
 *    conta dona): pastas por registo criadas a pedido, modelos Docs, espelho
 *    das provas das reclamações; relatórios ao vivo num Shared Drive restrito
 *    próprio. Os documentos do RH NUNCA vão para o Drive (26 set 2026).
 *
 * Nunca se regista conteúdo de ficheiros nem dados pessoais; os tokens ficam
 * cifrados na BD (userAccounts.ts) e o que vai ao browser para o Picker é um
 * token de acesso curto e SÓ com drive.file (ou nada).
 */
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import {
  DOC_TEMPLATE_ENTITIES, DOC_TEMPLATE_LABELS, DRIVE_FILE_SCOPE, DWD_DRIVE_SCOPES, GOOGLE_MIME, buildPlaceholderValues, extractPlaceholders,
  fallbackViewLink, generateDestinationAllowed, generatedDocName, liveDriveProblem, parseDriveConfig, parseDriveFileId, placeholdersFor, replaceAllTextRequests, safeGoogleLink,
  sanitizeDriveName, sharedFolderPath, type DocTemplateType, type DriveConfig, type DriveEntityType, type GenerateDestination, type GenerateEntityType,
  type SheetImportPurpose, sheetValuesToCsv, type SheetExportInput, exportSpreadsheetName,
} from "../../shared/drive";
import { hasFeatureScopes, hasSheetsReadScope } from "../../shared/mail";
import { can } from "../../shared/access";
import { lisbonDayOf } from "../../shared/lisbonDay";
import { delegatedClient, dwdConfigured, googleErrorMessage, httpStatusOf, isAuthRevokedError, oauthConfigured, workspaceConfig } from "./workspace";
import { googleWorkspaceApis, type DriveApiLike, type DriveFileMeta, type DocsApiLike, type SheetsApiLike } from "./driveApi";
import { dbFolderStore, ensureFolderPath, ensureUserFolder, sharedScopeKey } from "./driveFolders";
import { assertDriveEntityAccess, cityNameOfProject, loadEntityRecord, type DriveUser } from "./driveAccess";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const header = (res: unknown): any => (Array.isArray(res) ? res[0] : res);
const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const precondition = (message: string) => new TRPCError({ code: "PRECONDITION_FAILED", message });

async function database() {
  const { getDb } = await import("../db");
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
  return d;
}

type Apis = { drive: DriveApiLike; docs: DocsApiLike; sheets: SheetsApiLike };

/** Erro do Google → TRPCError legível (sem tokens, sem conteúdo). */
export function driveError(err: unknown, what: string): TRPCError {
  if (err instanceof TRPCError) return err;
  const status = httpStatusOf(err);
  if ((err as any)?.rateLimited) return new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Limite de pedidos da Google — tenta daqui a um minuto." });
  if (isAuthRevokedError(err) || status === 401) return precondition("A autorização Google expirou — volta a ligar a conta no Perfil.");
  if (status === 404) return new TRPCError({ code: "NOT_FOUND", message: `${what}: ficheiro não encontrado ou sem acesso pela app.` });
  if (status === 403) return new TRPCError({ code: "FORBIDDEN", message: `${what}: a Google recusou o acesso (${googleErrorMessage(err).slice(0, 160)}).` });
  return bad(`${what}: ${googleErrorMessage(err)}`);
}

// ─── Configuração e contextos ───────────────────────────────────────────────

export async function loadDriveConfig(): Promise<DriveConfig> {
  try {
    const { getSetting } = await import("../appSettings");
    return parseDriveConfig(await getSetting("google.drive" as any));
  } catch { return parseDriveConfig(null); }
}

/** APIs com a conta Google da pessoa (exige a funcionalidade "drive"). */
export async function userDriveApis(userId: number, deadlineAt: number): Promise<{ apis: Apis; email: string; sheetsRead: boolean }> {
  const { getGoogleAccount, userGoogleAuth } = await import("./userAccounts");
  const acc = await getGoogleAccount(userId).catch(() => null);
  if (!acc || acc.status === "disconnected" || !acc.refreshTokenEnc) throw precondition("Liga primeiro a tua conta Google (Perfil → Google).");
  if (!hasFeatureScopes(acc.scopes, "drive")) throw precondition("Ativa o Google Drive na tua conta (Perfil → Google → Ativar Drive).");
  try {
    const { client, email } = await userGoogleAuth(userId, "drive");
    return { apis: googleWorkspaceApis(client, deadlineAt), email, sheetsRead: hasSheetsReadScope(acc.scopes) };
  } catch (err: any) {
    throw precondition(String(err?.message ?? err));
  }
}

async function getState(key: string): Promise<string | null> {
  try {
    const d = await database();
    const r = rowsOf(await d.execute(sql`SELECT value FROM google_drive_state WHERE stateKey = ${key} LIMIT 1`))[0];
    return r?.value != null ? String(r.value) : null;
  } catch { return null; }
}
async function setState(key: string, value: string | null): Promise<void> {
  const d = await database();
  await d.execute(sql`INSERT INTO google_drive_state (stateKey, value) VALUES (${key}, ${value}) ON DUPLICATE KEY UPDATE value = VALUES(value)`);
}
export { getState as getDriveState, setState as setDriveState };

export interface SharedDriveContext { apis: Apis; driveId: string; ownerEmail: string; scopeKey: string; cfg: DriveConfig }

/**
 * Shared Drive da empresa (delegação a impersonar a conta dona). `live` = o
 * Shared Drive RESTRITO dos relatórios ao vivo (sem ele configurado → erro;
 * nunca cai no Shared Drive geral).
 */
export async function sharedDriveContext(deadlineAt: number, o: { live?: boolean; cfg?: DriveConfig } = {}): Promise<SharedDriveContext> {
  const cfg = o.cfg ?? (await loadDriveConfig());
  if (!cfg.sharedEnabled || !cfg.ownerEmail) throw precondition("O Shared Drive da empresa não está configurado (Definições → Comunicação → Google Drive).");
  if (o.live) {
    const problem = liveDriveProblem(cfg);
    if (problem) throw precondition(problem);
  }
  if (!dwdConfigured()) throw precondition("Conta de serviço Google (delegação) em falta no servidor.");
  const name = o.live ? cfg.liveDriveName.trim() : cfg.sharedDriveName;
  const client = delegatedClient(cfg.ownerEmail, DWD_DRIVE_SCOPES);
  const apis = googleWorkspaceApis(client, deadlineAt);
  const key = `drive:${name}`.slice(0, 64);
  let driveId = await getState(key);
  if (!driveId) {
    driveId = await apis.drive.findSharedDrive(name);
    if (!driveId) {
      const err = precondition(`Shared Drive "${name}" não encontrado para ${cfg.ownerEmail} (cria-o e junta essa conta como gestor).`);
      (err as any).sharedDriveMissing = true;
      throw err;
    }
    await setState(key, driveId).catch(() => {});
  }
  return { apis, driveId, ownerEmail: cfg.ownerEmail, scopeKey: sharedScopeKey(driveId), cfg };
}

/** O erro é "o Shared Drive configurado não existe" (aviso nos crons, não falha)? */
export function isSharedDriveMissing(err: unknown): boolean {
  return !!(err as any)?.sharedDriveMissing;
}

/** Pasta do registo no Shared Drive (criada a pedido). */
export async function sharedFolderFor(ctx: SharedDriveContext, segments: string[], verify = true): Promise<string> {
  return ensureFolderPath(ctx.apis.drive, dbFolderStore, { scopeKey: ctx.scopeKey, rootId: ctx.driveId, driveId: ctx.driveId, segments, verify });
}

// ─── Ligações a registos ────────────────────────────────────────────────────

export interface DriveLinkRow {
  id: number; entityType: string; entityId: string; fileId: string; name: string; mimeType: string | null; webViewLink: string | null;
  iconLink: string | null; ownerEmail: string | null; ownerName: string | null; source: string; location: string; templateId: number | null;
  createdById: number | null; createdByName: string | null; createdAt: string | null;
}

function toLink(r: any): DriveLinkRow {
  return {
    id: Number(r.id), entityType: String(r.entityType), entityId: String(r.entityId), fileId: String(r.fileId), name: String(r.name),
    mimeType: r.mimeType ?? null, webViewLink: safeGoogleLink(r.webViewLink) ?? fallbackViewLink(String(r.fileId), r.mimeType),
    iconLink: safeGoogleLink(r.iconLink), ownerEmail: r.ownerEmail ?? null, ownerName: r.ownerName ?? null,
    source: String(r.source ?? "link"), location: String(r.location ?? "user"), templateId: r.templateId != null ? Number(r.templateId) : null,
    createdById: r.createdById != null ? Number(r.createdById) : null, createdByName: r.createdByName ?? null,
    createdAt: r.createdAt ? String(r.createdAt) : null,
  };
}

export async function listEntityLinks(entityType: DriveEntityType, entityId: string): Promise<DriveLinkRow[]> {
  const d = await database();
  return rowsOf(await d.execute(sql`SELECT l.*, u.name AS createdByName FROM google_drive_links l LEFT JOIN users u ON u.id = l.createdById
    WHERE l.entityType = ${entityType} AND l.entityId = ${entityId} AND l.removedAt IS NULL ORDER BY l.createdAt DESC, l.id DESC LIMIT 200`)).map(toLink);
}

export async function upsertLink(entityType: DriveEntityType, entityId: string, f: DriveFileMeta, o: { source: string; location: "user" | "shared"; userId: number; templateId?: number | null }): Promise<number> {
  const d = await database();
  const name = sanitizeDriveName(f.name, 255, "Ficheiro do Drive");
  await d.execute(sql`INSERT INTO google_drive_links (entityType, entityId, fileId, name, mimeType, webViewLink, iconLink, ownerEmail, ownerName, source, location, templateId, createdById)
    VALUES (${entityType}, ${entityId}, ${f.id}, ${name}, ${f.mimeType}, ${safeGoogleLink(f.webViewLink)}, ${safeGoogleLink(f.iconLink)}, ${f.ownerEmail}, ${f.ownerName}, ${o.source}, ${o.location}, ${o.templateId ?? null}, ${o.userId})
    ON DUPLICATE KEY UPDATE name = VALUES(name), mimeType = VALUES(mimeType), webViewLink = VALUES(webViewLink), iconLink = VALUES(iconLink),
      ownerEmail = VALUES(ownerEmail), ownerName = VALUES(ownerName), source = VALUES(source), location = VALUES(location),
      templateId = VALUES(templateId), createdById = VALUES(createdById), removedAt = NULL, removedById = NULL`);
  const r = rowsOf(await d.execute(sql`SELECT id FROM google_drive_links WHERE entityType = ${entityType} AND entityId = ${entityId} AND fileId = ${f.id} LIMIT 1`))[0];
  return Number(r?.id ?? 0);
}

async function logDrive(userId: number, action: string, details: string, entityId: number | null = null) {
  try {
    const { logActivity } = await import("../db");
    await logActivity({ userId, action, entity: "google_drive", entityId, details: details.slice(0, 500) } as any);
  } catch { /* registo nunca parte a ação */ }
}

/**
 * "Anexar do Drive": liga um ficheiro (link colado ou escolhido no Picker) a
 * um registo. Os metadados vêm da Google quando a app tem acesso (Picker /
 * ficheiros da app); senão guarda-se a referência com o nome indicado — o
 * link continua a respeitar as partilhas do próprio Drive.
 */
export async function attachDriveFile(user: DriveUser, input: { entityType: DriveEntityType; entityId: string; link: string; name?: string | null; source: "link" | "picker" }): Promise<DriveLinkRow> {
  const info = await assertDriveEntityAccess(user, input.entityType, input.entityId, "edit");
  const fileId = parseDriveFileId(input.link);
  if (!fileId) throw bad("Link do Google Drive inválido (usa o link de partilha do ficheiro).");
  let meta: DriveFileMeta | null = null;
  try {
    const { apis } = await userDriveApis(user.id, Date.now() + 20_000);
    meta = await apis.drive.getFile(fileId);
  } catch (err) {
    // Sem Drive ligado ou sem acesso pela app (drive.file): guarda a referência.
    if (err instanceof TRPCError && err.code !== "PRECONDITION_FAILED") throw err;
    if (!(err instanceof TRPCError) && ![403, 404].includes(httpStatusOf(err) ?? 0)) throw driveError(err, "Anexar do Drive");
  }
  const f: DriveFileMeta = meta ?? {
    id: fileId, name: sanitizeDriveName(input.name || "Ficheiro do Drive", 255), mimeType: null, webViewLink: null, iconLink: null,
    ownerEmail: null, ownerName: null, driveId: null, size: null,
  };
  const id = await upsertLink(info.type, info.id, f, { source: input.source, location: meta?.driveId ? "shared" : "user", userId: user.id });
  await logDrive(user.id, "attach", `Drive: ficheiro ligado a ${info.type} ${info.type === "client" ? "(cliente)" : info.id}`, id);
  return (await listEntityLinks(info.type, info.id)).find((l) => l.id === id)!;
}

export async function removeDriveLink(user: DriveUser, linkId: number): Promise<void> {
  const d = await database();
  const r = rowsOf(await d.execute(sql`SELECT entityType, entityId FROM google_drive_links WHERE id = ${linkId} AND removedAt IS NULL LIMIT 1`))[0];
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Ligação não encontrada." });
  await assertDriveEntityAccess(user, r.entityType as DriveEntityType, String(r.entityId), "edit");
  await d.execute(sql`UPDATE google_drive_links SET removedAt = CURRENT_TIMESTAMP, removedById = ${user.id} WHERE id = ${linkId}`);
  await logDrive(user.id, "detach", `Drive: ligação #${linkId} removida (o ficheiro fica no Drive)`, linkId);
}

// ─── Guardar no Drive ───────────────────────────────────────────────────────

export type SaveSource =
  | { kind: "mail_attachment"; messageId: number; index: number }
  | { kind: "complaint_photo"; id: number };

export async function fetchStoredBytes(keyOrUrl: string, fallbackUrl?: string | null): Promise<Buffer> {
  const { storagePresignGet } = await import("../storage");
  const { fetchWithTimeout } = await import("../_core/fetchWithTimeout");
  const { url } = await storagePresignGet(keyOrUrl, { fallbackUrl: fallbackUrl ?? null, expiresSeconds: 120 });
  if (!url) throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado no armazenamento." });
  const abs = url.startsWith("/") ? `${(await import("./workspace")).appOrigin()}${url}` : url;
  const res = await fetchWithTimeout(abs, { timeoutMs: 20_000 });
  if (!res.ok) throw bad(`Não foi possível ler o documento (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { DRIVE_MAX_UPLOAD_BYTES } = await import("./driveApi");
  if (buf.length > DRIVE_MAX_UPLOAD_BYTES) throw bad("Ficheiro demasiado grande para o Drive (máx. 20 MB).");
  return buf;
}

/** Bytes + nome de uma origem, com as permissões de quem a pode abrir na app. */
export async function loadSourceBytes(user: DriveUser, s: SaveSource): Promise<{ name: string; mimeType: string; bytes: Buffer; link: { entityType: DriveEntityType; entityId: string } | null }> {
  const d = await database();
  if (s.kind === "mail_attachment") {
    const { attachmentBytes } = await import("../mail/inbox");
    const { withOverrides } = await import("../_core/access");
    const u = withOverrides(user);
    const a = await attachmentBytes({ id: u.id, role: u.role, accessOverrides: u.accessOverrides ?? null } as any, s.messageId, s.index);
    const t = rowsOf(await d.execute(sql`SELECT threadId FROM mail_messages WHERE id = ${s.messageId} LIMIT 1`))[0];
    return { name: a.filename || "anexo", mimeType: a.mimeType || "application/octet-stream", bytes: a.content, link: t ? { entityType: "mail_thread", entityId: String(t.threadId) } : null };
  }
  if ((s as { kind: string }).kind === "employee_document") throw new TRPCError({ code: "FORBIDDEN", message: HR_NO_DRIVE_MESSAGE });
  const r = rowsOf(await d.execute(sql`SELECT id, complaintId, url, fileKey, label FROM complaint_photos WHERE id = ${s.id} LIMIT 1`))[0];
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Ficheiro não encontrado." });
  await assertDriveEntityAccess(user, "complaint", String(r.complaintId), "view");
  const name = String(r.fileKey ?? "").split("/").pop() || `reclamacao-${r.complaintId}-${r.id}`;
  const mime = /\.pdf$/i.test(name) ? "application/pdf" : /\.png$/i.test(name) ? "image/png" : /\.(jpe?g)$/i.test(name) ? "image/jpeg" : /\.webp$/i.test(name) ? "image/webp" : "application/octet-stream";
  return { name: r.label ? `${r.label} — ${name}` : name, mimeType: mime, bytes: await fetchStoredBytes(String(r.fileKey || r.url), r.url), link: { entityType: "complaint", entityId: String(r.complaintId) } };
}

/** Os documentos do RH nunca vão para o Google Drive (decisão do dono, 26 set 2026). */
export const HR_NO_DRIVE_MESSAGE = "Os documentos do RH nunca vão para o Google Drive — ficam só nos documentos da ficha, na app.";

/** "Guardar no Drive": copia para a pasta "Multipark" do Drive da pessoa (e liga ao registo). */
export async function saveToUserDrive(user: DriveUser, s: SaveSource, o: { linkToRecord?: boolean } = {}): Promise<{ file: DriveFileMeta; linkId: number | null }> {
  if ((s as { kind: string }).kind === "employee_document") throw new TRPCError({ code: "FORBIDDEN", message: HR_NO_DRIVE_MESSAGE });
  const src = await loadSourceBytes(user, s);
  const { apis } = await userDriveApis(user.id, Date.now() + 50_000);
  try {
    const folder = await ensureUserFolder(apis.drive, user.id);
    const file = await apis.drive.upload({ name: sanitizeDriveName(src.name, 200, "documento"), mimeType: src.mimeType, parents: [folder] }, src.bytes);
    let linkId: number | null = null;
    if (o.linkToRecord !== false && src.link) linkId = await upsertLink(src.link.entityType, src.link.entityId, file, { source: "saved", location: "user", userId: user.id });
    await logDrive(user.id, "save", `Guardado no Drive (${s.kind})`, linkId);
    return { file: { ...file, webViewLink: safeGoogleLink(file.webViewLink) ?? fallbackViewLink(file.id, file.mimeType) }, linkId };
  } catch (err) { throw driveError(err, "Guardar no Drive"); }
}

// ─── Picker (token curto, só drive.file) ────────────────────────────────────

/**
 * Token de acesso para o Google Picker no browser da própria pessoa: pedido
 * com `scope=drive.file` (subconjunto do que ela autorizou). Se a Google
 * devolver mais âmbitos, recusa-se (o Picker fica indisponível; colar o link
 * continua a funcionar). O token nunca é guardado nem registado.
 */
export async function pickerAccessToken(userId: number): Promise<{ token: string; expiresIn: number } | null> {
  const { getGoogleAccount } = await import("./userAccounts");
  const acc = await getGoogleAccount(userId).catch(() => null);
  if (!acc?.refreshTokenEnc || acc.status !== "connected" || !hasFeatureScopes(acc.scopes, "drive")) return null;
  const { decryptSecret } = await import("../integrations/googleAds/crypto");
  const cfg = workspaceConfig();
  const { fetchWithTimeout } = await import("../_core/fetchWithTimeout");
  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST", timeoutMs: 15_000,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: decryptSecret(acc.refreshTokenEnc), client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: DRIVE_FILE_SCOPE,
    }).toString(),
  });
  if (!res.ok) return null;
  const j: any = await res.json().catch(() => null);
  const granted = String(j?.scope ?? "").split(/\s+/).filter(Boolean);
  if (!j?.access_token || !granted.length || granted.some((s) => s !== DRIVE_FILE_SCOPE)) return null;
  return { token: String(j.access_token), expiresIn: Math.min(3600, Number(j.expires_in ?? 3600)) };
}

// ─── Modelos (Docs) ─────────────────────────────────────────────────────────

export interface DocTemplateRow {
  id: number; name: string; templateType: DocTemplateType; fileId: string; fileName: string | null; description: string | null;
  placeholders: string[]; active: boolean; createdAt: string | null;
}
function toTemplate(r: any): DocTemplateRow {
  let ph: string[] = [];
  try { ph = JSON.parse(r.placeholdersJson || "[]"); } catch { ph = []; }
  return {
    id: Number(r.id), name: String(r.name), templateType: String(r.templateType) as DocTemplateType, fileId: String(r.fileId),
    fileName: r.fileName ?? null, description: r.description ?? null, placeholders: Array.isArray(ph) ? ph.map(String) : [],
    active: Number(r.active ?? 1) === 1, createdAt: r.createdAt ? String(r.createdAt) : null,
  };
}

export async function listTemplates(o: { entityType?: DriveEntityType; includeInactive?: boolean } = {}): Promise<DocTemplateRow[]> {
  const d = await database();
  let rows: any[] = [];
  try { rows = rowsOf(await d.execute(sql`SELECT * FROM google_doc_templates ${o.includeInactive ? sql`` : sql`WHERE active = 1`} ORDER BY templateType, name LIMIT 200`)); }
  catch { rows = []; }
  const list = rows.map(toTemplate);
  return o.entityType ? list.filter((t) => DOC_TEMPLATE_ENTITIES[t.templateType]?.includes(o.entityType!)) : list;
}

/**
 * Confere o modelo pela conta dona do Shared Drive: tem de ser um Google Doc
 * a que essa conta chega; lê o texto só para listar os {{marcadores}}.
 */
export async function inspectTemplate(link: string, deadlineAt = Date.now() + 30_000): Promise<{ fileId: string; fileName: string; placeholders: string[] }> {
  const fileId = parseDriveFileId(link);
  if (!fileId) throw bad("Link do modelo inválido (cola o link do Google Docs).");
  const ctx = await sharedDriveContext(deadlineAt);
  try {
    const meta = await ctx.apis.drive.getFile(fileId);
    if (meta.mimeType !== GOOGLE_MIME.doc) throw bad("O modelo tem de ser um documento Google Docs.");
    const text = (await ctx.apis.drive.exportAs(fileId, "text/plain")).toString("utf8");
    return { fileId, fileName: meta.name, placeholders: extractPlaceholders(text).slice(0, 80) };
  } catch (err) { throw driveError(err, `Modelo (a conta ${ctx.ownerEmail} tem de ter acesso)`); }
}

export async function saveTemplate(userId: number, input: { id?: number | null; name: string; templateType: DocTemplateType; link: string; description?: string | null }): Promise<number> {
  const t = await inspectTemplate(input.link);
  const d = await database();
  const ph = JSON.stringify(t.placeholders).slice(0, 2000);
  if (input.id) {
    await d.execute(sql`UPDATE google_doc_templates SET name = ${input.name}, templateType = ${input.templateType}, fileId = ${t.fileId}, fileName = ${t.fileName.slice(0, 255)},
      description = ${input.description ?? null}, placeholdersJson = ${ph}, active = 1 WHERE id = ${input.id}`);
    await logDrive(userId, "update", `Modelo "${input.name}" (${DOC_TEMPLATE_LABELS[input.templateType]}) atualizado`, input.id);
    return input.id;
  }
  const res = await d.execute(sql`INSERT INTO google_doc_templates (name, templateType, fileId, fileName, description, placeholdersJson, active, createdById)
    VALUES (${input.name}, ${input.templateType}, ${t.fileId}, ${t.fileName.slice(0, 255)}, ${input.description ?? null}, ${ph}, 1, ${userId})`);
  const id = Number(header(res)?.insertId ?? 0);
  await logDrive(userId, "create", `Modelo "${input.name}" (${DOC_TEMPLATE_LABELS[input.templateType]}) registado`, id || null);
  return id;
}

export async function setTemplateActive(userId: number, id: number, active: boolean): Promise<void> {
  const d = await database();
  await d.execute(sql`UPDATE google_doc_templates SET active = ${active ? 1 : 0} WHERE id = ${id}`);
  await logDrive(userId, active ? "enable" : "disable", `Modelo #${id} ${active ? "ativado" : "desativado"}`, id);
}

// ─── Gerar documento ────────────────────────────────────────────────────────

export interface GenerateInput {
  templateId: number;
  entityType: GenerateEntityType;
  entityId: string;
  /** "app" = só o PDF nos documentos da ficha (obrigatório no RH; nunca fica no Drive). */
  destination: GenerateDestination;
}

/**
 * Passo 1 (≤ ~40 s): cópia do modelo + substituição dos {{marcadores}}.
 *  - Shared Drive: a conta dona copia o modelo para a pasta do registo,
 *    substitui e partilha o ficheiro com quem gerou (edição);
 *  - O meu Drive: a conta dona exporta o modelo (.docx), a pessoa carrega-o
 *    convertido para Google Docs na sua pasta "Multipark" (ficheiro da app →
 *    drive.file chega) e a substituição corre com o token dela.
 * O PDF (passo 2) é pedido à parte (exportPdf) para caber no limite de 60 s.
 */
export async function generateDocument(user: DriveUser, input: GenerateInput): Promise<{ linkId: number | null; file: DriveFileMeta | null; replaced: number; missing: string[]; warnings: string[]; employeeDocumentId: number | null }> {
  const deadlineAt = Date.now() + 45_000;
  if (!generateDestinationAllowed(input.entityType, input.destination)) {
    throw input.entityType === "employee"
      ? new TRPCError({ code: "FORBIDDEN", message: HR_NO_DRIVE_MESSAGE })
      : bad("Escolhe onde guardar o documento (Shared Drive ou o teu Drive).");
  }
  const info = await assertDriveEntityAccess(user, input.entityType, input.entityId, "edit");
  const d = await database();
  const tr = rowsOf(await d.execute(sql`SELECT * FROM google_doc_templates WHERE id = ${input.templateId} AND active = 1 LIMIT 1`))[0];
  if (!tr) throw new TRPCError({ code: "NOT_FOUND", message: "Modelo não encontrado ou desativado." });
  const template = toTemplate(tr);
  if (!DOC_TEMPLATE_ENTITIES[template.templateType]?.includes(input.entityType)) throw bad("Este modelo não se aplica a este registo.");

  const { record, projectId } = await loadEntityRecord(input.entityType, info.id);
  const warnings: string[] = [];
  const canSeeSalary = can(user as any, "rh_salarios", "view");
  const values = buildPlaceholderValues(input.entityType, record, {
    today: lisbonDayOf(Date.now()), user: { name: user.name ?? null, email: user.email ?? null }, canSeeSalary,
    cityName: await cityNameOfProject(projectId),
  });
  if (!canSeeSalary && template.placeholders.some((p) => ["salario_mensal", "subsidio_alimentacao"].includes(p))) {
    warnings.push("O modelo usa o ordenado, mas não tens acesso aos ordenados — ficou em branco.");
  }
  const known = new Set(placeholdersFor(input.entityType).map((p) => p.key));
  const missing = template.placeholders.filter((p) => !known.has(p));
  const requests = replaceAllTextRequests(values);
  const name = generatedDocName(template.templateType, info.label, lisbonDayOf(Date.now()));

  const shared = await sharedDriveContext(deadlineAt);
  if (input.destination === "app") {
    // RH: cópia de trabalho PRIVADA da conta dona (O meu Drive dela, fora de
    // qualquer Shared Drive) → marcadores → PDF → apagada; o PDF vai só para
    // os documentos da ficha (S3). Nada fica no Google Drive.
    const r = await generateEmployeePdf(user, shared, { template, requests, name, employeeId: Number(info.id) });
    await logDrive(user.id, "generate", `Documento gerado (só PDF na ficha): ${DOC_TEMPLATE_LABELS[template.templateType]} (employee ${info.id})`, r.employeeDocumentId);
    return { linkId: null, file: null, replaced: r.replaced, missing, warnings, employeeDocumentId: r.employeeDocumentId };
  }
  let file: DriveFileMeta;
  let replaced = 0;
  try {
    if (input.destination === "shared") {
      if (!info.folder) throw bad("Este registo não tem pasta no Shared Drive.");
      const folderId = await sharedFolderFor(shared, sharedFolderPath(info.folder));
      file = await shared.apis.drive.copy(template.fileId, { name, parents: [folderId] });
      replaced = (await shared.apis.docs.batchUpdate(file.id, requests as any)).replaced;
      if (user.email) await shared.apis.drive.shareWithUser(file.id, String(user.email).toLowerCase(), "writer").catch(() => { warnings.push("Não foi possível partilhar o documento contigo — pede acesso ao Shared Drive."); });
    } else {
      const docx = await shared.apis.drive.exportAs(template.fileId, GOOGLE_MIME.docx);
      const { apis } = await userDriveApis(user.id, deadlineAt);
      const folder = await ensureUserFolder(apis.drive, user.id);
      file = await apis.drive.upload({ name, mimeType: GOOGLE_MIME.docx, parents: [folder], convertTo: GOOGLE_MIME.doc }, docx);
      replaced = (await apis.docs.batchUpdate(file.id, requests as any)).replaced;
    }
  } catch (err) { throw driveError(err, "Gerar documento"); }
  const linkId = await upsertLink(info.type, info.id, file, { source: "generated", location: input.destination, userId: user.id, templateId: template.id });
  await logDrive(user.id, "generate", `Documento gerado: ${DOC_TEMPLATE_LABELS[template.templateType]} (${info.type} ${info.type === "client" ? "cliente" : info.id}, ${input.destination})`, linkId);
  return { linkId, file: { ...file, webViewLink: safeGoogleLink(file.webViewLink) ?? fallbackViewLink(file.id, GOOGLE_MIME.doc) }, replaced, missing, warnings, employeeDocumentId: null };
}

export interface EmployeeDocStore {
  put(key: string, pdf: Buffer): Promise<string>;
  createDoc(row: Record<string, unknown>): Promise<number | null>;
}

const defaultEmployeeDocStore: EmployeeDocStore = {
  async put(key, pdf) {
    const { storagePut } = await import("../storage");
    return (await storagePut(key, pdf, GOOGLE_MIME.pdf)).url;
  },
  async createDoc(row) {
    const { createEmployeeDocument } = await import("../db");
    const r: any = await createEmployeeDocument(row as any);
    return Number((Array.isArray(r) ? r[0] : r)?.insertId ?? 0) || null;
  },
};

/**
 * RH: modelo → PDF nos documentos da ficha, sem deixar nada no Drive. A cópia
 * de trabalho (Google Doc) é criada no Drive PRIVADO da conta dona (sem
 * pasta, fora dos Shared Drives) e apagada no fim, mesmo que falhe a meio.
 */
export async function generateEmployeePdf(
  user: DriveUser, shared: Pick<SharedDriveContext, "apis">,
  o: { template: Pick<DocTemplateRow, "fileId" | "templateType">; requests: unknown[]; name: string; employeeId: number },
  store: EmployeeDocStore = defaultEmployeeDocStore,
): Promise<{ replaced: number; employeeDocumentId: number | null }> {
  let tmpId: string | null = null;
  let pdf: Buffer;
  let replaced = 0;
  try {
    const docx = await shared.apis.drive.exportAs(o.template.fileId, GOOGLE_MIME.docx);
    const tmp = await shared.apis.drive.upload({ name: `${sanitizeDriveName(o.name, 180)} (temporário)`, mimeType: GOOGLE_MIME.docx, convertTo: GOOGLE_MIME.doc }, docx);
    tmpId = tmp.id;
    replaced = (await shared.apis.docs.batchUpdate(tmp.id, o.requests as any)).replaced;
    pdf = await shared.apis.drive.exportAs(tmp.id, GOOGLE_MIME.pdf);
  } catch (err) {
    throw driveError(err, "Gerar documento");
  } finally {
    if (tmpId) await shared.apis.drive.remove(tmpId).catch(() => { /* limpeza: tenta sempre */ });
  }
  const key = `employees/${o.employeeId}/docs/gerado-${Date.now()}.pdf`;
  const url = await store.put(key, pdf);
  const docType = o.template.templateType === "contrato_trabalho" ? "contract" : "other";
  const employeeDocumentId = await store.createDoc({
    employeeId: o.employeeId, docType, label: sanitizeDriveName(`${o.name}.pdf`, 250), fileUrl: url, fileKey: key, mimeType: GOOGLE_MIME.pdf, uploadedById: user.id,
  });
  return { replaced, employeeDocumentId };
}

/**
 * Passo 2: PDF do documento gerado, ao lado dele no Drive e ligado ao
 * registo (reclamações, clientes, parcerias). O RH não passa por aqui: o
 * PDF vai direto para os documentos da ficha (generateEmployeePdf).
 */
export async function exportGeneratedPdf(user: DriveUser, linkId: number): Promise<{ linkId: number; file: DriveFileMeta; employeeDocumentId: number | null }> {
  const deadlineAt = Date.now() + 45_000;
  const d = await database();
  const l = rowsOf(await d.execute(sql`SELECT l.*, t.templateType FROM google_drive_links l LEFT JOIN google_doc_templates t ON t.id = l.templateId
    WHERE l.id = ${linkId} AND l.removedAt IS NULL LIMIT 1`))[0];
  if (!l || l.source !== "generated") throw new TRPCError({ code: "NOT_FOUND", message: "Documento gerado não encontrado." });
  // RH: nunca para o Drive (documentos gerados antes de 26 set 2026 incluídos).
  if (String(l.entityType) === "employee") throw new TRPCError({ code: "FORBIDDEN", message: HR_NO_DRIVE_MESSAGE });
  const info = await assertDriveEntityAccess(user, l.entityType as DriveEntityType, String(l.entityId), "edit");
  let file: DriveFileMeta;
  try {
    const shared = l.location === "shared" ? await sharedDriveContext(deadlineAt) : null;
    const apis = shared ? shared.apis : (await userDriveApis(user.id, deadlineAt)).apis;
    const pdf = await apis.drive.exportAs(String(l.fileId), GOOGLE_MIME.pdf);
    let parents: string[] | undefined;
    if (shared && info.folder) parents = [await sharedFolderFor(shared, sharedFolderPath(info.folder), false)];
    else if (!shared) parents = [await ensureUserFolder(apis.drive, user.id)];
    file = await apis.drive.upload({ name: `${sanitizeDriveName(String(l.name), 190)}.pdf`, mimeType: GOOGLE_MIME.pdf, parents }, pdf);
    if (shared && user.email) await shared.apis.drive.shareWithUser(file.id, String(user.email).toLowerCase(), "reader").catch(() => {});
  } catch (err) { throw driveError(err, "Exportar PDF"); }
  const newId = await upsertLink(info.type, info.id, file, { source: "pdf", location: l.location === "shared" ? "shared" : "user", userId: user.id, templateId: l.templateId ?? null });
  const employeeDocumentId: number | null = null;
  await logDrive(user.id, "export_pdf", `PDF do documento gerado (${info.type} ${info.type === "client" ? "cliente" : info.id})`, newId);
  return { linkId: newId, file: { ...file, webViewLink: safeGoogleLink(file.webViewLink) ?? fallbackViewLink(file.id, GOOGLE_MIME.pdf) }, employeeDocumentId };
}

// ─── Sheets: exportar e importar ────────────────────────────────────────────

/** "Exportar para Sheets" — folha nova na pasta "Multipark" da pessoa. */
export async function exportReportToSheets(
  user: DriveUser, input: SheetExportInput, call: (path: string, input?: unknown) => Promise<any>,
): Promise<{ url: string; name: string; partial: boolean; rows: number }> {
  const deadlineAt = Date.now() + 50_000;
  const { assertCanExportReport, loadReportTabs, createSpreadsheet } = await import("./sheetsExport");
  assertCanExportReport(user, input.report);
  // Drive pronto antes de calcular o relatório (não se gasta o prazo à toa).
  const { apis } = await userDriveApis(user.id, deadlineAt);
  const tabs = await loadReportTabs(call, input, deadlineAt);
  try {
    const folder = await ensureUserFolder(apis.drive, user.id);
    const name = exportSpreadsheetName(input, lisbonDayOf(Date.now()));
    const r = await createSpreadsheet(apis, { name, parentId: folder, tabs, deadlineAt });
    const rows = tabs.reduce((s, t) => s + Math.max(0, t.rows.length - 1), 0);
    await logDrive(user.id, "export", `Exportar para Sheets: ${input.report} (${rows} linhas${r.partial ? ", incompleto" : ""})`);
    return { url: safeGoogleLink(r.file.webViewLink) ?? fallbackViewLink(r.file.id, GOOGLE_MIME.sheet), name, partial: r.partial, rows };
  } catch (err) { throw driveError(err, "Exportar para Sheets"); }
}

/**
 * Importar de uma folha Google: lê o 1.º separador (ou o indicado) e devolve
 * CSV no formato das importações existentes — a validação é a da importação
 * (o mesmo caminho do CSV colado). Com spreadsheets.readonly (pedido com o
 * Drive desde 26 set 2026) lê qualquer folha que a pessoa consiga abrir; sem
 * ele (autorização antiga, só drive.file) a folha tem de ter sido escolhida
 * com o Picker (ou criada pela app) — a mensagem de erro pede para voltar a
 * autorizar o Drive.
 */
export async function readSheetAsCsv(user: DriveUser, input: { link: string; purpose: SheetImportPurpose; sheetTitle?: string | null }): Promise<{ csv: string; rows: number; title: string }> {
  const { requireAccess } = await import("../_core/access");
  if (input.purpose === "extras") requireAccess(user, "rh", "manage");
  else requireAccess(user, "anual", "manage");
  const fileId = parseDriveFileId(input.link);
  if (!fileId) throw bad("Link da folha Google inválido.");
  const { apis, sheetsRead } = await userDriveApis(user.id, Date.now() + 30_000);
  try {
    const tabs = await apis.sheets.listSheets(fileId);
    const title = input.sheetTitle && tabs.some((t) => t.title === input.sheetTitle) ? input.sheetTitle : tabs[0]?.title;
    if (!title) throw bad("A folha não tem separadores.");
    const values = await apis.sheets.readValues(fileId, `'${title.replace(/'/g, "''")}'!A1:Z5000`);
    const csv = sheetValuesToCsv(values);
    await logDrive(user.id, "import_read", `Importar do Sheets (${input.purpose}): ${values.length} linhas lidas`);
    return { csv, rows: csv ? csv.split("\n").length : 0, title };
  } catch (err) {
    if (httpStatusOf(err) === 404 || httpStatusOf(err) === 403) {
      throw new TRPCError({ code: "NOT_FOUND", message: sheetImportDeniedMessage(sheetsRead) });
    }
    throw driveError(err, "Importar do Sheets");
  }
}

/** Mensagem quando a Google recusa ler a folha (com/sem spreadsheets.readonly). PURA. */
export function sheetImportDeniedMessage(sheetsRead: boolean): string {
  return sheetsRead
    ? "Não tens acesso a esta folha no Google (confirma o link ou pede ao dono que ta partilhe)."
    : "A app ainda não pode ler folhas pelo link. Volta a autorizar o Drive (Perfil → Google Drive → \"Autorizar leitura de folhas\") ou usa \"Escolher do Drive\" para abrir a folha com a app.";
}

// ─── Estado e teste ─────────────────────────────────────────────────────────

export async function driveStatus(userId: number) {
  const { getGoogleAccount } = await import("./userAccounts");
  const acc = await getGoogleAccount(userId).catch(() => null);
  const cfg = await loadDriveConfig();
  const connected = !!acc && acc.status !== "disconnected" && !!acc.refreshTokenEnc;
  return {
    configured: oauthConfigured(),
    connected,
    needsReauth: acc?.status === "reauth_required",
    granted: connected && hasFeatureScopes(acc!.scopes, "drive"),
    /** Pode importar de qualquer folha que a pessoa abre (spreadsheets.readonly). */
    sheetsRead: connected && hasSheetsReadScope(acc!.scopes),
    sharedEnabled: cfg.sharedEnabled && dwdConfigured(),
  };
}

/** Integrações → Testar: Shared Drive (delegação) e/ou a API Drive de alguém com o Drive ativo. */
export async function testGoogleDrive(): Promise<string> {
  const parts: string[] = [];
  const cfg = await loadDriveConfig();
  if (cfg.sharedEnabled && cfg.ownerEmail) {
    const ctx = await sharedDriveContext(Date.now() + 20_000, { cfg });
    await ctx.apis.drive.getFile(ctx.driveId).catch(async () => { await ctx.apis.drive.findSharedDrive(cfg.sharedDriveName); });
    parts.push(`Shared Drive "${cfg.sharedDriveName}" OK (delegação para ${cfg.ownerEmail})`);
  }
  const d = await database();
  const rows = rowsOf(await d.execute(sql`SELECT userId, scopes FROM google_user_accounts WHERE status = 'connected' LIMIT 500`));
  const withDrive = rows.filter((r) => hasFeatureScopes(String(r.scopes ?? ""), "drive"));
  if (withDrive[0]) {
    const { apis } = await userDriveApis(Number(withDrive[0].userId), Date.now() + 20_000);
    await ensureUserFolder(apis.drive, Number(withDrive[0].userId));
    parts.push("API Drive (pasta \"Multipark\" da pessoa) OK");
  }
  if (!parts.length) throw new Error("O Shared Drive está desligado e ninguém ativou ainda o Drive (Perfil → Google).");
  return `Ligação OK (${parts.join("; ")}; ${withDrive.length} pessoa(s) com o Drive).`;
}
