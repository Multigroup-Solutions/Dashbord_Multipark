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
 * Desenho (payload-agnóstico): o webhook é só um GATILHO. Extraímos o id da
 * reserva, vamos buscar a versão completa ao /bookings/:id (getBookingTryAllParks)
 * e reutilizamos o upsert + enrichment do sync — a BD fica exatamente como
 * ficaria pelo polling, mas em segundos. Check-ins/check-outs e movimentações
 * de condutores NÃO disparam webhook (confirmado no código be-multipark), por
 * isso o sync de 15 min continua como rede de segurança e fonte desses eventos.
 *
 * Montado em `/api/multipark/webhook` ANTES do express.json global (raw body
 * para o HMAC), nos dois entrypoints. Process-then-ack (como o webhook Meta):
 * a plataforma tem timeout de 10s e retry com backoff — preferimos o retry
 * deles a perder eventos.
 */
import express, { Router, type Request, type Response } from "express";
import crypto from "crypto";

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
  if (!bookingId) return null;
  return {
    deliveryId: typeof b.id === "string" ? b.id : `no-delivery-${bookingId}-${event}`,
    event: event as MultiparkWebhookEvent["event"],
    bookingId,
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

/** Remove chaves undefined — o upsert não deve tocar campos que não trazemos. */
function clean<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

// ─── Dedup de entregas (idempotência) ────────────────────────────────────────
// A plataforma faz retries; X-Multipark-Delivery identifica cada entrega.
// Tabela criada on-demand (CREATE IF NOT EXISTS idempotente, cache por processo
// — em serverless cada instância paga 1 vez).
let deliveriesTableReady = false;
async function ensureDeliveriesTable(): Promise<void> {
  if (deliveriesTableReady) return;
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) return;
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`CREATE TABLE IF NOT EXISTS \`multipark_webhook_deliveries\` (
    \`id\` INT NOT NULL AUTO_INCREMENT,
    \`deliveryId\` VARCHAR(128) NOT NULL,
    \`event\` VARCHAR(32) NOT NULL,
    \`bookingExternalId\` VARCHAR(128) NOT NULL,
    \`receivedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE INDEX \`mp_webhook_deliveries_delivery_unique\` (\`deliveryId\`)
  )`);
  deliveriesTableReady = true;
}

/** true = entrega nova (registada); false = duplicado (já processada). */
async function registerDelivery(ev: MultiparkWebhookEvent): Promise<boolean> {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) return true; // sem BD não há como deduplicar; processa
  await ensureDeliveriesTable();
  const { sql } = await import("drizzle-orm");
  try {
    await db.execute(sql`INSERT INTO \`multipark_webhook_deliveries\`
      (\`deliveryId\`, \`event\`, \`bookingExternalId\`)
      VALUES (${ev.deliveryId}, ${ev.event}, ${ev.bookingId})`);
    return true;
  } catch (err: any) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

/**
 * O mysql2 marca duplicados com code ER_DUP_ENTRY/errno 1062, mas o Drizzle
 * embrulha o erro original em `cause` — verificamos os dois níveis (e a
 * mensagem, como última rede).
 */
export function isDuplicateKeyError(err: unknown): boolean {
  const candidates: any[] = [err, (err as any)?.cause];
  for (const e of candidates) {
    if (!e) continue;
    if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true;
  }
  return /duplicate entry/i.test(String((err as any)?.message ?? "") + String((err as any)?.cause?.message ?? ""));
}

/**
 * Processa um evento: busca a reserva completa à API (tenta todas as chaves),
 * upsert na BD com parkName/city no formato do sync e enrichment imediato.
 */
export async function processMultiparkWebhookEvent(ev: MultiparkWebhookEvent): Promise<{
  ok: boolean;
  detail: string;
}> {
  const { getBookingTryAllParks } = await import("./multipark");
  const { upsertMultiparkBooking } = await import("./db");
  const { enrichBookingsBatch } = await import("./jobs/multiparkBookingSync");

  // Esqueleto a partir do payload (ISO→UTC MySQL). O detalhe/parsing fino fica
  // para o enrichment oficial do sync — evitamos duplicar mapeamentos aqui.
  const skeleton: Record<string, unknown> = clean({
    externalId: ev.bookingId,
    status: ev.status ?? undefined,
    checkIn: isoToMysql(ev.checkIn),
    checkOut: isoToMysql(ev.checkOut),
    bookingPrice: ev.bookingPrice != null ? String(ev.bookingPrice) : undefined,
    paymentMethod: ev.paymentMethod ?? undefined,
    licensePlate: ev.licensePlate ?? undefined,
    enrichedAt: null, // reabre o enrichment para captar o detalhe fresco
  });

  // Resolve o parque (dá-nos parkName/city no formato do sync — sem isso o
  // enrichment não sabe que chave usar).
  const found = await getBookingTryAllParks(ev.bookingId);
  if (found) {
    skeleton.parkName = `${found.parkConfig.name} - ${found.parkConfig.city}`;
    skeleton.city = cityToSyncForm(found.parkConfig.city);
  }
  await upsertMultiparkBooking(skeleton as any);

  if (!found) {
    // Reserva ainda não visível na API (propagação) ou parque sem chave — o
    // esqueleto fica e o sync de 15 min completa mais tarde.
    return { ok: true, detail: "skeleton-only (parque não resolvido)" };
  }

  // Enrichment direcionado — preenche cliente/campanha/parceiro/voos/etc com o
  // mapping oficial do sync (resolve a chave por parkName/city acabados de gravar).
  const r = await enrichBookingsBatch({ externalIds: [ev.bookingId], limit: 1 });
  return { ok: true, detail: `enriched=${r.enriched} errors=${r.errors} noKey=${r.noKey}` };
}

export function createMultiparkWebhookRouter(): Router {
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
        const fresh = await registerDelivery(ev);
        if (!fresh) return res.status(200).json({ ok: true, duplicate: true });

        const result = await processMultiparkWebhookEvent(ev);
        console.log(`[MultiparkWebhook] ${ev.event} ${ev.bookingId}: ${result.detail}`);
        return res.status(200).json({ ok: true });
      } catch (err: any) {
        // Erro nosso → 500 para a plataforma re-tentar (retry com backoff).
        console.error("[MultiparkWebhook] erro a processar:", err?.message ?? err);
        return res.status(500).json({ error: "Erro interno ao processar o evento" });
      }
    },
  );

  return router;
}
