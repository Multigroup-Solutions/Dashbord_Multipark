/**
 * GET /api/cron/meta-ads?kind=daily|monthly (Bearer CRON_SECRET) — recolha
 * Meta Ads com prazo. Não configurada → ok:true, skipped:'not_configured'
 * (o workflow segue verde). Falha de contas → ok:false (workflow vermelho).
 */
import type { Express, Request, Response } from "express";

export function registerMetaAdsRoutes(app: Express) {
  app.get("/api/cron/meta-ads", async (req: Request, res: Response) => {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret || req.headers["authorization"] !== `Bearer ${secret}`) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { metaAdsCron, sendCronRun } = await import("../../cronJobs");
    sendCronRun(res, await metaAdsCron({ kind: String(req.query.kind ?? "daily"), deadlineAt: Date.now() + 45_000 }));
  });
}
