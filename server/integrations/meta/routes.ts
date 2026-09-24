/**
 * GET /api/cron/meta-ads?kind=daily|monthly (Bearer CRON_SECRET) — recolha
 * Meta Ads com prazo. Não configurada → ok:true, skipped:'not_configured'
 * (o workflow segue verde). Falha de contas → ok:false (workflow vermelho).
 */
import type { Express, Request, Response } from "express";
import { normalizeSyncKind } from "../googleAds/metrics";
import { runMetaAdsSync } from "./sync";

export function registerMetaAdsRoutes(app: Express) {
  app.get("/api/cron/meta-ads", async (req: Request, res: Response) => {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret || req.headers["authorization"] !== `Bearer ${secret}`) { res.status(401).json({ error: "Unauthorized" }); return; }
    const kind = normalizeSyncKind(String(req.query.kind ?? "daily"));
    try {
      const r = await runMetaAdsSync({ kind, deadlineAt: Date.now() + 45_000, triggeredById: null });
      res.json({ ranAt: new Date().toISOString(), ...r });
    } catch (err: any) {
      res.status(500).json({ ok: false, done: true, error: String(err?.message ?? err).slice(0, 300) });
    }
  });
}
