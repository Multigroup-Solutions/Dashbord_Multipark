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
 * Na receção, o payload fica PRIMEIRO na memória só de acréscimo
 * (`multipark_webhook_snapshots`, server/webhookMemory.ts — nunca reescrita
 * nem apagada) e depois na fila. A receção é persistida antes do ACK. O
 * processamento usa o detalhe atual
 * da API, nunca o estado antigo do payload, e é retomado após falhas/crashes.
 * O cron da fila corre de hora a hora; o sync periódico (de hora a
 * hora) continua necessário para movimentos que não produzem notificações.
 * Montado antes do express.json global, para verificar o corpo original.
 */
import express, { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { createDeliveryStore, drainDeliveries, deliveryErrorCode } from "./bookingDeliveryQueue";
import { bearerMatches } from "./cronAuth";

/** Tolerância do `t=` da assinatura: ±5 minutos (anti-replay). */
export const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

/** `t=` da assinatura → epoch ms. Aceita segundos (10 dígitos) ou ms (13). */
export function signatureTimestampMs(ts: string): number | null {
  if (!/^\d{9,14}$/.test(ts)) return null;
  const n = Number(ts);
  return n >= 1e11 ? n : n * 1000;
}

/**
 * Verifica a assinatura `X-Multipark-Signature` ("t=<ts>,v1=<hex>").
 * v1 = HMAC-SHA256(secret, `${ts}.${rawBody}`), comparação em tempo constante.
 * O `ts` usado é o do próprio header (não o X-Multipark-Timestamp) para a
 * verificação ser autocontida, e tem de estar a ±5 min de `now` — uma
 * entrega capturada não pode ser reenviada mais tarde.
 */
export function verifyMultiparkSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!secret || !signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => p.trim().split("=") as [string, string]),
  );
  const ts = parts["t"];
  const provided = parts["v1"];
  if (!ts || !provided) return false;
  const tsMs = signatureTimestampMs(ts);
  if (tsMs == null || Math.abs(now - tsMs) > SIGNATURE_TOLERANCE_MS) return false;

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
  // Fichas do CRM e tarefas dos serviços desta reserva LOGO à chegada (Jorge,
  // 29 set 2026: sem voltas de 15 em 15 min; 30 set: o que falha repete-se). Leem a BD da Multipark ao vivo;
  // uma falha aqui não impede o resto (as tarefas que falham ficam para
  // repetir na fila; as fichas apanham-se na volta das 04:00).
  await onBookingArrived(ev.bookingId);

  const { getBookingTryAllParks, resolveParkForBooking, getParkApiKey, getBooking } = await import("./multipark");
  const { upsertMultiparkBooking } = await import("./db");
  const { enrichBookingsBatch } = await import("./jobs/multiparkBookingSync");

  const preferred = await resolveParkForBooking({ parkId: ev.parkId });
  const found = preferred
    ? { parkConfig: preferred, booking: await getBooking(ev.bookingId, getParkApiKey(preferred), { maxAttempts: 1, timeoutMs: 8000 }) }
    : await getBookingTryAllParks(ev.bookingId, { deadlineAt: Date.now() + 12_000 });
  if (!found) return { ok: false, detail: "Parque ainda não resolvido" };
  // O payload pode ser antigo: só usamos o ID e o parque. Nenhum estado,
  // preço ou matrícula do evento substitui dados mais recentes na cópia
  // `multipark_bookings` (que guarda só o último valor). O payload em si —
  // preço e método do momento — já ficou na memória só de acréscimo
  // (`multipark_webhook_snapshots`, server/webhookMemory.ts) na receção.
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

/** CRM (ficha do cliente) + serviços → tarefas de UMA reserva. Nunca lança. */
export async function onBookingArrived(bookingId: string): Promise<void> {
  if (!bookingId) return;
  try {
    const { syncCrmForBookings } = await import("./crm/sync");
    await syncCrmForBookings([bookingId]);
  } catch (err) {
    console.warn("[MultiparkWebhook] CRM da reserva:", deliveryErrorCode(err));
  }
  // Tarefas dos serviços: o que falhar aqui (erro, prazo esgotado) fica para
  // repetir na fila do webhook — a volta das 18:00 não cria saídas já passadas.
  let st: typeof import("./serviceTasks") | null = null;
  try {
    st = await import("./serviceTasks");
    const r = await st.runServiceTasksForBookings([bookingId], { deadlineAt: Date.now() + 10_000 });
    if (st.serviceReportNeedsRetry(r)) {
      const why = r.errors[0] ?? `prazo esgotado (${r.pending} por fazer)`;
      console.warn("[MultiparkWebhook] tarefas dos serviços por acabar — fica para repetir:", bookingId, why);
      await st.queueServiceTaskRetry(bookingId, why);
    }
  } catch (err) {
    console.warn("[MultiparkWebhook] tarefas dos serviços — fica para repetir:", bookingId, deliveryErrorCode(err));
    try { if (st) await st.queueServiceTaskRetry(bookingId, deliveryErrorCode(err)); }
    catch (e) { console.error("[MultiparkWebhook] tarefas dos serviços: não deu para guardar a repetição:", bookingId, deliveryErrorCode(e)); }
  }
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

      // Aceita assinatura HMAC válida (±5 min) OU Bearer com a chave exata —
      // a plataforma manda ambos; a assinatura é a forte, o Bearer é o
      // fallback. As duas comparações são em tempo constante.
      const sigOk = verifyMultiparkSignature(raw, signature, secret);
      const bearerOk = bearerMatches(req.header("Authorization"), secret);
      if (!sigOk && !bearerOk) {
        return res.status(401).json({ error: "Assinatura/credencial inválida" });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "JSON inválido" });
      }

      // MEMÓRIA primeiro (decisão do dono, 28 set 2026): em cada webhook
      // lemos a reserva toda na BD da Multipark (até 6 s; se falhar fica o
      // payload e o cron repete) e gravamos uma linha NOVA, só por acréscimo,
      // antes de qualquer outro passo. A mesma entrega repetida não duplica.
      // Se não conseguirmos guardar, 500 para a Multipark repetir.
      try {
        await (await import("./webhookMemory")).recordWebhookSnapshot(parsed, { signatureValid: sigOk, rawBody: raw });
      } catch (err) {
        console.error("[MultiparkWebhook] memória do webhook falhou:", deliveryErrorCode(err));
        return res.status(500).json({ error: "Erro interno ao guardar o evento" });
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
