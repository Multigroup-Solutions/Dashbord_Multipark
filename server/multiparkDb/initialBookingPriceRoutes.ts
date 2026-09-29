import type { Express, Request, Response } from "express";
import { bearerMatches, cronAuthOk } from "../cronAuth";
import { getMultiparkDb, isMultiparkDbConfigured, redactSecrets } from "./client";
import { bookingPage, historyPage, makePeriod, price, priceChanges, type HistoryRow } from "./initialBookingPrice";

export const INITIAL_PRICE_EXPORT_PATH = "/api/exports/initial-booking-price";

export function parseExportPage(body: unknown, now = Date.now(), stages: readonly string[] = ["bookings", "history"]) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Pedido inválido.");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => !["stage", "from", "to", "asOf", "cursor", "pageSize"].includes(k))) throw new Error("Parâmetro desconhecido.");
  if (typeof b.stage !== "string" || !stages.includes(b.stage)) throw new Error("Etapa inválida.");
  if (typeof b.from !== "string" || (b.to != null && typeof b.to !== "string")) throw new Error("Datas inválidas.");
  if (typeof b.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(b.asOf)) throw new Error("Instante inválido.");
  const asOf = new Date(b.asOf);
  if (!Number.isFinite(asOf.getTime()) || asOf.toISOString() !== b.asOf || asOf.getTime() > now + 60_000) throw new Error("Instante inválido.");
  if (typeof b.cursor !== "string" || b.cursor.length > 200 || /[\x00-\x1f]/.test(b.cursor)) throw new Error("Cursor inválido.");
  if (typeof b.pageSize !== "number" || !Number.isInteger(b.pageSize) || b.pageSize < 1 || b.pageSize > 1000) throw new Error("O lote deve ter entre 1 e 1000 registos.");
  return { stage: b.stage, cursor: b.cursor, pageSize: b.pageSize, period: makePeriod(b.from, b.to ?? undefined, asOf) };
}

export function registerInitialBookingPriceRoutes(app: Pick<Express, "post">) {
  app.post(INITIAL_PRICE_EXPORT_PATH, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "private, no-store");
    const authorized = bearerMatches(req.headers.authorization, process.env.BOOKING_PRICE_EXPORT_SECRET) || cronAuthOk(req.headers.authorization);
    if (!authorized) return res.status(401).json({ ok: false, error: "Unauthorized" });
    let input: ReturnType<typeof parseExportPage>;
    try { input = parseExportPage(req.body); }
    catch (error) { return res.status(400).json({ ok: false, error: (error as Error).message }); }
    if (!isMultiparkDbConfigured()) return res.status(503).json({ ok: false, error: "Ligação à base de dados indisponível." });
    try {
      const db = await getMultiparkDb();
      if (db.engine !== "postgres" || !await db.readOnlyCheck()) return res.status(409).json({ ok: false, error: "Não foi confirmada uma ligação PostgreSQL só de leitura." });
      const { stage, period, cursor, pageSize } = input;
      const q = stage === "bookings" ? bookingPage(period, cursor, pageSize) : historyPage(period, cursor, pageSize);
      const rows = await db.query(q.sql, q.params);
      // Send ONLY the price changes, never the other personal fields stored in a history diff.
      const result = stage === "history" ? (rows as unknown as HistoryRow[]).map(h => ({
        id: h.id, booking_id: h.booking_id, change_type: h.change_type, action_time: h.action_time,
        snapshot_price: price(h.snapshot_price),
        modified_fields: priceChanges(h.modified_fields).map(c => ({ field: "bookingPrice", ...c })),
      })) : rows;
      return res.json({ ok: true, stage, period, rows: result });
    } catch (error) {
      console.error("[initial-booking-price]", redactSecrets(error));
      return res.status(503).json({ ok: false, error: "Falhou a leitura do lote. Nenhum preço foi alterado." });
    }
  });
}
