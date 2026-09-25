/**
 * Trabalhos do Drive no cron /api/cron/google-sync (10 em 10 min), sempre com
 * prazo e retomáveis:
 *  - espelho no Shared Drive: documentos do RH → RH/<cidade>/<trabalhador>
 *    (Shared Drive de RH quando configurado) e provas das reclamações →
 *    Reclamações/<ano>/<id>; lotes pequenos, 1 linha por origem em
 *    google_drive_mirror (erro → nova tentativa, até 5);
 *  - relatórios ao vivo: 1×/dia (a partir da hora configurada), uma folha
 *    fixa em Relatórios/ no Shared Drive; um relatório de cada vez, os já
 *    feitos no dia ficam marcados (a corrida seguinte continua).
 * Nunca regista conteúdo nem dados pessoais (só ids e contagens).
 */
import { sql } from "drizzle-orm";
import { GOOGLE_MIME, LIVE_REPORT_KEYS, SHEET_EXPORT_LABELS, sharedFolderPath, type DriveConfig, type LiveReportKey, type SheetTab } from "../../shared/drive";
import { lisbonDayOf, lisbonHoursSince } from "../../shared/lisbonDay";
import { dwdConfigured, googleErrorMessage, httpStatusOf } from "./workspace";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

export interface DriveJobsReport {
  configured: boolean;
  done: boolean;
  mirrored: number;
  mirrorFailed: number;
  live: { ran: boolean; reports: string[]; partial: boolean; error: string | null } | null;
  errors: string[];
}

const MIRROR_BATCH = 15;
const MAX_ATTEMPTS = 5;

async function database() {
  const { getDb } = await import("../db");
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível.");
  return d;
}

async function markMirror(sourceType: string, sourceId: number, patch: { fileId?: string | null; status: "done" | "error" | "skipped"; error?: string | null }) {
  const d = await database();
  await d.execute(sql`INSERT INTO google_drive_mirror (sourceType, sourceId, fileId, status, attempts, lastError)
    VALUES (${sourceType}, ${sourceId}, ${patch.fileId ?? null}, ${patch.status}, ${patch.status === "error" ? 1 : 0}, ${patch.error ? patch.error.slice(0, 500) : null})
    ON DUPLICATE KEY UPDATE fileId = COALESCE(VALUES(fileId), fileId), status = VALUES(status),
      attempts = attempts + ${patch.status === "error" ? 1 : 0}, lastError = VALUES(lastError)`);
}

/** Espelho de uma origem (RH ou reclamações) — até ao prazo. */
async function mirrorBatch(kind: "employee_document" | "complaint_photo", cfg: DriveConfig, deadlineAt: number, report: DriveJobsReport): Promise<void> {
  const d = await database();
  const pending = kind === "employee_document"
    ? rowsOf(await d.execute(sql`SELECT x.id, x.employeeId AS ownerId, x.docType, x.label, x.fileKey, x.fileUrl, x.mimeType, e.fullName, e.projectId
        FROM employee_documents x JOIN employees e ON e.id = x.employeeId
        LEFT JOIN google_drive_mirror m ON m.sourceType = 'employee_document' AND m.sourceId = x.id
        WHERE m.id IS NULL OR (m.status = 'error' AND m.attempts < ${MAX_ATTEMPTS}) ORDER BY x.id LIMIT ${MIRROR_BATCH}`))
    : rowsOf(await d.execute(sql`SELECT x.id, x.complaintId AS ownerId, x.label, x.fileKey, x.url AS fileUrl, c.createdAt
        FROM complaint_photos x JOIN complaints c ON c.id = x.complaintId
        LEFT JOIN google_drive_mirror m ON m.sourceType = 'complaint_photo' AND m.sourceId = x.id
        WHERE m.id IS NULL OR (m.status = 'error' AND m.attempts < ${MAX_ATTEMPTS}) ORDER BY x.id LIMIT ${MIRROR_BATCH}`));
  if (!pending.length) return;
  const { sharedDriveContext, sharedFolderFor, fetchStoredBytes } = await import("./driveService");
  const { cityNameOfProject } = await import("./driveAccess");
  const ctx = await sharedDriveContext(deadlineAt, { restricted: kind === "employee_document", cfg });
  for (const r of pending) {
    if (Date.now() > deadlineAt - 8_000) { report.done = false; return; }
    try {
      const segments = kind === "employee_document"
        ? sharedFolderPath({ kind: "employee", id: Number(r.ownerId), name: String(r.fullName ?? ""), city: await cityNameOfProject(r.projectId != null ? Number(r.projectId) : null) })
        : sharedFolderPath({ kind: "complaint", id: Number(r.ownerId), createdAt: r.createdAt ? String(r.createdAt) : null });
      const folderId = await sharedFolderFor(ctx, segments, false);
      const bytes = await fetchStoredBytes(String(r.fileKey || r.fileUrl), r.fileUrl);
      const base = String(r.fileKey ?? "").split("/").pop() || `${kind}-${r.id}`;
      const name = kind === "employee_document" ? `${r.label || r.docType} (#${r.id}) — ${base}` : `${r.label ? `${r.label} — ` : ""}${base}`;
      const mime = r.mimeType || (/\.pdf$/i.test(base) ? "application/pdf" : /\.png$/i.test(base) ? "image/png" : /\.(jpe?g)$/i.test(base) ? "image/jpeg" : "application/octet-stream");
      const file = await ctx.apis.drive.upload({ name: name.slice(0, 200), mimeType: mime, parents: [folderId] }, bytes);
      await markMirror(kind, Number(r.id), { fileId: file.id, status: "done" });
      report.mirrored++;
    } catch (err: any) {
      report.mirrorFailed++;
      if ((err as any)?.rateLimited) { report.done = false; return; }
      // Pasta apagada no Drive → esquece a cache deste Shared Drive (recria na próxima).
      if (httpStatusOf(err) === 404) await d.execute(sql`DELETE FROM google_drive_folders WHERE scopeKey = ${ctx.scopeKey}`).catch(() => {});
      await markMirror(kind, Number(r.id), { status: "error", error: googleErrorMessage(err) }).catch(() => {});
    }
  }
  if (pending.length === MIRROR_BATCH) report.done = false;
}

/** Utilizador (super admin/admin ativo) cujas permissões os relatórios ao vivo usam. */
async function liveRunAs(cfg: DriveConfig): Promise<any | null> {
  if (!cfg.liveRunAsUserId) return null;
  const { getUserById } = await import("../db");
  const u: any = await getUserById(cfg.liveRunAsUserId);
  if (!u || !["admin", "super_admin"].includes(String(u.role)) || Number(u.isActive ?? 1) === 0) return null;
  return u;
}

/** Separadores de um relatório com o nome do relatório à frente (sem colisões). PURA. */
export function prefixTabs(key: LiveReportKey, tabs: readonly SheetTab[]): SheetTab[] {
  return tabs.map((t) => ({ name: `${SHEET_EXPORT_LABELS[key]} — ${t.name}`, rows: t.rows }));
}

async function runLiveReports(cfg: DriveConfig, deadlineAt: number, now: number, report: DriveJobsReport): Promise<void> {
  const today = lisbonDayOf(now);
  if (Math.floor(lisbonHoursSince(today, now)) < cfg.liveReports.hour) return;
  const { getDriveState, setDriveState, sharedDriveContext, sharedFolderFor } = await import("./driveService");
  const doneKey = `live:done:${today}`;
  const doneList = String((await getDriveState(doneKey)) ?? "").split(",").filter(Boolean);
  const wanted = cfg.liveReports.reports.filter((k) => (LIVE_REPORT_KEYS as readonly string[]).includes(k));
  const todo = wanted.filter((k) => !doneList.includes(k));
  if (!todo.length) return;
  const live: NonNullable<DriveJobsReport["live"]> = { ran: true, reports: [], partial: false, error: null };
  report.live = live;
  const user = await liveRunAs(cfg);
  if (!user) { live.error = "Relatórios ao vivo: a conta configurada já não é admin/super admin — volta a gravar as definições."; return; }
  try {
    const ctx = await sharedDriveContext(deadlineAt, { cfg });
    let spreadsheetId = await getDriveState("live:spreadsheetId");
    if (spreadsheetId) {
      try { await ctx.apis.drive.getFile(spreadsheetId); }
      catch (err) { if ([404, 410].includes(httpStatusOf(err) ?? 0)) spreadsheetId = null; else throw err; }
    }
    if (!spreadsheetId) {
      const folderId = await sharedFolderFor(ctx, sharedFolderPath({ kind: "reports" }));
      const f = await ctx.apis.drive.createFile({ name: "Relatórios ao vivo — Multipark", mimeType: GOOGLE_MIME.sheet, parents: [folderId] });
      spreadsheetId = f.id;
      await setDriveState("live:spreadsheetId", spreadsheetId);
      if (f.webViewLink) await setDriveState("live:spreadsheetUrl", f.webViewLink);
    }
    const { appRouter } = await import("../routers");
    const caller: any = appRouter.createCaller({ req: { headers: {} }, res: {}, user, accessDenied: false } as any);
    const call = (path: string, input?: unknown) => {
      const fn = path.split(".").reduce((o: any, k) => (o == null ? o : o[k]), caller);
      if (typeof fn !== "function") throw new Error(`procedimento desconhecido: ${path}`);
      return fn(input);
    };
    const { assertCanExportReport, loadReportTabs, refreshSpreadsheet, liveReportInput } = await import("./sheetsExport");
    for (const key of todo) {
      if (Date.now() > deadlineAt - 15_000) { live.partial = true; report.done = false; break; }
      assertCanExportReport(user, key);
      const tabs = prefixTabs(key, await loadReportTabs(call, liveReportInput(key, today), deadlineAt));
      tabs.push({ name: `${SHEET_EXPORT_LABELS[key]} — Atualizado`, rows: [["Atualizado em", new Date().toISOString()], ["Período", JSON.stringify(liveReportInput(key, today))]] });
      const r = await refreshSpreadsheet(ctx.apis.sheets, spreadsheetId, tabs, deadlineAt);
      if (r.partial) { live.partial = true; report.done = false; break; }
      doneList.push(key);
      live.reports.push(key);
      await setDriveState(doneKey, doneList.join(","));
    }
    await setDriveState("live:lastRunAt", new Date().toISOString());
  } catch (err: any) {
    live.error = `Relatórios ao vivo: ${googleErrorMessage(err)}`;
  }
}

export async function runDriveJobs(opts: { deadlineAt: number; now?: () => number }): Promise<DriveJobsReport> {
  const report: DriveJobsReport = { configured: false, done: true, mirrored: 0, mirrorFailed: 0, live: null, errors: [] };
  const { loadDriveConfig } = await import("./driveService");
  const cfg = await loadDriveConfig();
  if (!cfg.sharedEnabled || !cfg.ownerEmail || !dwdConfigured()) return report;
  report.configured = true;
  const now = (opts.now ?? Date.now)();
  const steps: Array<() => Promise<void>> = [];
  if (cfg.mirrorRhDocuments) steps.push(() => mirrorBatch("employee_document", cfg, opts.deadlineAt, report));
  if (cfg.mirrorComplaintEvidence) steps.push(() => mirrorBatch("complaint_photo", cfg, opts.deadlineAt, report));
  if (cfg.liveReports.enabled) steps.push(() => runLiveReports(cfg, opts.deadlineAt, now, report));
  for (const step of steps) {
    if (Date.now() > opts.deadlineAt - 8_000) { report.done = false; break; }
    try { await step(); } catch (err) { report.errors.push(`Drive: ${googleErrorMessage(err)}`); }
  }
  if (report.live?.error) report.errors.push(report.live.error);
  return report;
}
