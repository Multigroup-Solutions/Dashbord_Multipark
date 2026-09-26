/**
 * Rotas HTTP da Comunicação:
 *  - GET  /api/cron/mail-sync           manual (o agendador /api/cron/tick corre-o de 5 em 5 min; prazo 45 s; `done:false` → repetir)
 *  - POST /api/mail/push                Gmail push (Pub/Sub, OIDC verificado) — só com MAIL_PUSH ligado
 *  - GET  /api/mail/attachment/:m/:i    bytes de um anexo a pedido (sessão + acesso à conversa)
 */
import type { Express, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { sql } from "drizzle-orm";
import { cronAuthOk } from "../cronAuth";

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/** Tipos seguros para mostrar no browser; o resto descarrega. PURA. */
export function inlineSafeMime(mime: string): boolean {
  return /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/i.test(mime);
}

function contentDisposition(filename: string, inline: boolean): string {
  const ascii = filename.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_").slice(0, 150) || "anexo";
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename.slice(0, 150))}`;
}

export async function verifyGmailPush(authorization: string | undefined): Promise<void> {
  const audience = String(process.env.GMAIL_PUSH_AUDIENCE ?? "").trim();
  const email = String(process.env.GMAIL_PUSH_SERVICE_ACCOUNT ?? "").trim();
  if (!audience || !email || !authorization?.startsWith("Bearer ")) throw new Error("Push não autorizado.");
  const { payload } = await jwtVerify(authorization.slice(7), googleKeys, {
    issuer: ["https://accounts.google.com", "accounts.google.com"], audience, algorithms: ["RS256"],
  });
  if (payload.email !== email || payload.email_verified !== true) throw new Error("Identidade push inválida.");
}

export function registerMailRoutes(app: Express, opts: { defer?: (p: Promise<unknown>) => void } = {}) {
  app.get("/api/cron/mail-sync", async (req: Request, res: Response) => {
    if (!cronAuthOk(req.headers["authorization"])) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { mailSyncCron, sendCronRun } = await import("../cronJobs");
    sendCronRun(res, await mailSyncCron({ deadlineAt: Date.now() + 45_000 }));
  });

  app.post("/api/mail/push", async (req: Request, res: Response) => {
    try { await verifyGmailPush(req.headers.authorization); }
    catch { res.status(401).json({ error: "Unauthorized" }); return; }
    try {
      const { mailPushEnabled } = await import("./service");
      if (!(await mailPushEnabled())) { res.status(204).end(); return; }
      const encoded = req.body?.message?.data;
      if (typeof encoded !== "string" || encoded.length > 8192 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(encoded)) { res.status(400).json({ error: "Notificação inválida." }); return; }
      const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      const email = String(data?.emailAddress ?? "").trim().toLowerCase();
      if (!email) { res.status(204).end(); return; }
      const { db, rowsOf, nowUtc } = await import("./store");
      const d = await db();
      const keys = rowsOf(await d.execute(sql`SELECT accountKey FROM mail_accounts WHERE email = ${email} AND status IN ('ok','pending') LIMIT 5`)).map((r) => String(r.accountKey));
      if (keys.length) await d.execute(sql`UPDATE mail_accounts SET pushPendingAt = ${nowUtc()} WHERE email = ${email}`);
      res.status(204).end();
      // Sincroniza já essas contas (o tick de 5 min apanha o que falhar).
      const { runMailSync } = await import("./service");
      for (const key of keys) {
        const p = runMailSync({ deadlineAt: Date.now() + 40_000, onlyAccountKey: key }).catch(() => undefined);
        if (opts.defer) opts.defer(p);
      }
    } catch {
      if (!res.headersSent) res.status(503).json({ error: "Não foi possível tratar a notificação." });
    }
  });

  app.get("/api/mail/attachment/:messageId/:index", async (req: Request, res: Response) => {
    try {
      const { sdk } = await import("../_core/sdk");
      const user = await sdk.authenticateRequest(req).catch(() => null);
      if (!user) { res.status(401).json({ error: "Sessão expirada." }); return; }
      const messageId = Number(req.params.messageId);
      const index = Number(req.params.index);
      if (!Number.isInteger(messageId) || messageId <= 0 || !Number.isInteger(index) || index < 0 || index > 500) { res.status(400).json({ error: "Pedido inválido." }); return; }
      const { getUserModuleOverrides } = await import("../db");
      const { loadCityAccess } = await import("../cityAccess");
      const { cityScope } = await import("../cityScope");
      const viewer = { id: user.id, role: user.role, accessOverrides: await getUserModuleOverrides(user.id).catch(() => ({})) };
      const access = await loadCityAccess(user.id, user.role);
      const { attachmentBytes } = await import("./inbox");
      const a = await cityScope.run(access, () => attachmentBytes(viewer, messageId, index));
      const inline = inlineSafeMime(a.mimeType);
      res.setHeader("Content-Type", inline ? a.mimeType : "application/octet-stream");
      res.setHeader("Content-Disposition", contentDisposition(a.filename, inline));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(a.content);
    } catch (err: any) {
      const code = err?.code === "FORBIDDEN" ? 403 : err?.code === "NOT_FOUND" ? 404 : 500;
      res.status(code).json({ error: code === 500 ? "Não foi possível obter o anexo." : String(err?.message ?? "") });
    }
  });
}
