/**
 * Webhook entrante das "Conexões" da plataforma Multipark (be-multipark).
 *
 * A plataforma envia um POST por evento de reserva — BOOKING_CREATED,
 * BOOKING_UPDATED, BOOKING_CANCELLED — com um payload mínimo whitelisted:
 *   { id, event, createdAt, data: { id, parkId, status, licensePlate,
 *     checkIn, checkOut, bookingPrice, paymentMethod, createdAt, updatedAt } }
 * Headers: `Authorization: Bearer <chave>`, `X-Multipark-Event`,
 * `X-Multipark-Delivery` (idempotência), `X-Multipark-Timestamp` e
 * `X-Multipark-Signature: t=<ts>,v1=<HMAC-SHA256(chave, "<ts>.<body>")>`.
 *
 * A receção é persistida antes do ACK. O processamento usa o detalhe atual
 * da API, nunca o estado antigo do payload, e é retomado após falhas/crashes.
 * O cron da fila corre de cinco em cinco minutos; o polling periódico continua
 * necessário para movimentos que não produzem notificações.
 * Montado antes do express.json global, para verificar o corpo original.
 */
import express, { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { createDeliveryStore, drainDeliveries, deliveryErrorCode } from "./bookingDeliveryQueue";

/**
 * Verifica a assinatura `X-Multipark-Signature` ("t=<ts>,v1=<hex>").
 * v1 = HMAC-SHA256(secret, `${ts}.${rawBody}`), comparação em tempo constante.
 * O `ts` usado é o do próprio header (não o X-Multipark-Timestamp) para a
 * verificação ser autocontida.
 */
export function verifyMultiparkSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => p.split("=") as [string, string]),
  );
  const ts = parts["t"];
  const provided = parts["v1"];
  if (!ts || !provided) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${rawBody.toString("utf8")}`)
    .digest("hex");

  let providedBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided, "hex");
    expectedBuf = Buffer.from(expected, "hex");
  } catch {
    return false;
  }
  if (providedBuf.length !== expectedBuf.length || providedBuf.length === 0) return false;
  try {
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

export interface MultiparkWebhookEvent {
  deliveryId: string;
  event: "BOOKING_CREATED" | "BOOKING_UPDATED" | "BOOKING_CANCELLED";
  bookingId: string;
  parkId: string | null;
  status: string | null;
  licensePlate: string | null;
  checkIn: string | null;
  checkOut: string | null;
  bookingPrice: number | null;
  paymentMethod: string | null;
}

/** Parse defensivo do envelope { id, event, createdAt, data }. */
export function parseMultiparkWebhook(body: unknown): MultiparkWebhookEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const data = (b.data ?? {}) as Record<string, unknown>;
  const event = String(b.event ?? "");
  if (!["BOOKING_CREATED", "BOOKING_UPDATED", "BOOKING_CANCELLED"].includes(event)) return null;
  const bookingId = typeof data.id === "string" ? data.id : null;
  if (!bookingId || bookingId.length > 128) return null;
  if (typeof b.id === "string" && (b.id.length > 128 || !b.id.trim())) return null;
  return {
    // Atualizações diferentes da mesma reserva não podem partilhar o fallback.
    deliveryId: typeof b.id === "string" ? b.id : `fallback-${crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")}`,
    event: event as MultiparkWebhookEvent["event"],
    bookingId,
    parkId: typeof data.parkId === "string" ? data.parkId : null,
    status: typeof data.status === "string" ? data.status : null,
    licensePlate: typeof data.licensePlate === "string" ? data.licensePlate : null,
    checkIn: typeof data.checkIn === "string" ? data.checkIn : null,
    checkOut: typeof data.checkOut === "string" ? data.checkOut : null,
    bookingPrice: typeof data.bookingPrice === "number" ? data.bookingPrice : null,
    paymentMethod: typeof data.paymentMethod === "string" ? data.paymentMethod : null,
  };
}

/** Cidade da config ("Lisboa") → forma canónica do sync ("lisbon"). */
export function cityToSyncForm(city: string): string {
  const m: Record<string, string> = { lisboa: "lisbon", porto: "porto", faro: "faro" };
  return m[city.toLowerCase()] ?? city.toLowerCase();
}

/**
 * ISO 8601 ("2026-07-31T10:00:00.000Z") → "2026-07-31 10:00:00" (UTC).
 * A BD guarda tudo em UTC wall-clock; a exibição converte para Lisboa.
 */
export function isoToMysql(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Processa um evento: busca a reserva completa à API (tenta todas as chaves),
 * upsert na BD com parkName/city no formato do sync e enrichment imediato.
 */
export async function processMultiparkWebhookEvent(ev: MultiparkWebhookEvent): Promise<{
  ok: boolean;
  detail: string;
}> {
  const { getBookingTryAllParks, resolveParkForBooking, getParkApiKey, getBooking } = await import("./multipark");
  const { upsertMultiparkBooking } = await import("./db");
  const { enrichBookingsBatch } = await import("./jobs/multiparkBookingSync");

  const preferred = await resolveParkForBooking({ parkId: ev.parkId });
  const found = preferred
    ? { parkConfig: preferred, booking: await getBooking(ev.bookingId, getParkApiKey(preferred), { maxAttempts: 1, timeoutMs: 8000 }) }
    : await getBookingTryAllParks(ev.bookingId, { deadlineAt: Date.now() + 12_000 });
  if (!found) return { ok: false, detail: "Parque ainda não resolvido" };
  // O payload pode ser antigo: só usamos o ID e o parque. Nenhum estado,
  // preço ou matrícula do evento substitui dados mais recentes.
  await upsertMultiparkBooking({
    externalId: ev.bookingId,
    historyFetchedAt: null,
    historyRetryAt: null,
    parkName: `${found.parkConfig.name} - ${found.parkConfig.city}`,
    city: cityToSyncForm(found.parkConfig.city),
  });
  const r = await enrichBookingsBatch({ externalIds: [ev.bookingId], limit: 1, force: true,
    details: new Map([[ev.bookingId, found.booking]]) });
  return { ok: r.enriched === 1 && r.errors === 0 && r.noKey === 0, detail: `enriched=${r.enriched} errors=${r.errors} noKey=${r.noKey}` };
}

export async function retryMultiparkDeliveries(deadlineAt = Date.now() + 40_000) {
  return drainDeliveries(await createDeliveryStore(), processMultiparkWebhookEvent, { limit: 20, deadlineAt });
}

export function createMultiparkWebhookRouter(opts: { afterReceive?: () => void } = {}): Router {
  const router = express.Router();

  // GET simples para testar a montagem (não expõe nada).
  router.get("/", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "multipark-webhook" });
  });

  router.post(
    "/",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req: Request, res: Response) => {
      const secret = process.env.MULTIPARK_WEBHOOK_SECRET?.trim();
      if (!secret) {
        return res.status(503).json({ error: "MULTIPARK_WEBHOOK_SECRET não configurado" });
      }

      const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""));
      const signature = req.header("X-Multipark-Signature") ?? undefined;
      const bearer = (req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");

      // Aceita assinatura HMAC válida OU Bearer com a chave exata — a
      // plataforma manda ambos; a assinatura é a forte, o Bearer é o fallback.
      const sigOk = verifyMultiparkSignature(raw, signature, secret);
      const bearerOk = bearer.length > 0 && bearer === secret;
      if (!sigOk && !bearerOk) {
        return res.status(401).json({ error: "Assinatura/credencial inválida" });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "JSON inválido" });
      }
      const ev = parseMultiparkWebhook(parsed);
      if (!ev) {
        // Evento desconhecido/sem id — ack para não gerar retries inúteis,
        // mas fica registado no log para diagnóstico.
        console.warn("[MultiparkWebhook] payload não reconhecido:", Object.keys((parsed as any) ?? {}));
        return res.status(200).json({ ok: true, ignored: true });
      }

      try {
        // Guardar antes de iniciar trabalho em segundo plano. O cron é a
        // recuperação; nenhuma chamada à origem atrasa a confirmação HTTP.
        await (await createDeliveryStore()).receive(ev);
        try { opts.afterReceive?.(); }
        catch (error) { console.error('[MultiparkWebhook] arranque adiado:', deliveryErrorCode(error)); }
        return res.status(202).json({ ok: true, accepted: true });
      } catch (err: any) {
        // Erro nosso → 500 para a plataforma re-tentar (retry com backoff).
        console.error("[MultiparkWebhook] erro a processar:", deliveryErrorCode(err));
        return res.status(500).json({ error: "Erro interno ao processar o evento" });
      }
    },
  );

  return router;
}
