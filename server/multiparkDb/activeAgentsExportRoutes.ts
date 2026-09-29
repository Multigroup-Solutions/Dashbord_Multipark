import type { Express, Request, Response } from "express";
import { bearerMatches } from "../cronAuth";
import { getMultiparkDb, isMultiparkDbConfigured, redactSecrets } from "./client";
import { parseExportPage } from "./initialBookingPriceRoutes";
import { agentExportPage, bookingDriversPage, AGENT_EXPORT_STAGES, type AgentExportStage } from "./activeAgentsExport";

export const ACTIVE_AGENTS_EXPORT_PATH = "/api/exports/active-agents";
export function registerActiveAgentsExportRoutes(app: Pick<Express, "post">) {
  app.post(ACTIVE_AGENTS_EXPORT_PATH, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!bearerMatches(req.headers.authorization, process.env.AGENT_ACTIVITY_EXPORT_SECRET)) return res.status(401).json({ ok: false, error: "Unauthorized" });
    let input: ReturnType<typeof parseExportPage>;
    try { input = parseExportPage(req.body, Date.now(), [...AGENT_EXPORT_STAGES, "booking-drivers"]); }
    catch (error) { return res.status(400).json({ ok: false, error: (error as Error).message }); }
    if (!isMultiparkDbConfigured()) return res.status(503).json({ ok: false, error: "Ligação à base de dados indisponível." });
    try {
      const db = await getMultiparkDb();
      if (db.engine !== "postgres" || !await db.readOnlyCheck()) return res.status(409).json({ ok: false, error: "Não foi confirmada uma ligação PostgreSQL só de leitura." });
      const { stage, period, cursor, pageSize } = input;
      const q = stage === "booking-drivers" ? bookingDriversPage(period, cursor, pageSize) : agentExportPage(stage as AgentExportStage, period, cursor, pageSize);
      return res.json({ ok: true, stage, period, rows: await db.query(q.sql, q.params) });
    } catch (error) {
      console.error("[active-agents-export]", redactSecrets(error));
      return res.status(503).json({ ok: false, error: "Falhou a leitura do lote de agentes. Nenhum registo foi alterado." });
    }
  });
}
