/**
 * GET /api/cron/meta-ads?kind=daily|monthly (Bearer CRON_SECRET) — recolha
 * Meta Ads com prazo. Não configurada → ok:true, skipped:'not_configured'
 * (o workflow segue verde). Falha de contas → ok:false (workflow vermelho).
 */
import type { Express, Request, Response } from "express";
import { cronAuthOk } from "../../cronAuth";

export function registerMetaAdsRoutes(app: Express) {
  app.get("/api/cron/meta-ads", async (req: Request, res: Response) => {
    // 19d: a mesma verificação dos outros crons (tempo constante, segredo com trim)
    if (!cronAuthOk(req.headers["authorization"])) { res.status(401).json({ error: "Unauthorized" }); return; }
    const { metaAdsCron, sendCronRun } = await import("../../cronJobs");
    sendCronRun(res, await metaAdsCron({ kind: String(req.query.kind ?? "daily"), deadlineAt: Date.now() + 45_000 }));
  });
}
