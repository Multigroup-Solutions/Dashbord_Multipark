/**
 * Webhook entrante da WhatsApp Cloud API (Meta).
 *
 * Montado em `/api/whatsapp/webhook` — TEM de ser registado ANTES do
 * `express.json` global nos dois entrypoints (`_core/index.ts` e
 * `_core/api-entry.ts`), porque a validação da assinatura precisa do RAW body
 * intacto (o `express.json` consome-o). Este router usa o seu próprio
 * `express.raw({ type: 'application/json' })` no POST.
 *
 * Fase 0 (agora): apenas verificação (GET) e validação de assinatura (POST) —
 * o POST responde 200 sem processar. O processamento/escrita na BD chega na
 * Fase 3 e, por decisão do Jorge, corre ANTES de responder 200 à Meta (volume
 * baixo, latência irrelevante; preferimos o retry da Meta a perder mensagens).
 */
import express, { Router, type Request, type Response } from "express";
import crypto from "crypto";

/**
 * Valida o handshake de verificação do webhook (GET) da Meta.
 * A Meta chama `GET ...?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`
 * e espera o `hub.challenge` de volta se o token bater certo.
 */
export function isValidWebhookVerification(
  mode: unknown,
  token: unknown,
  verifyToken: string | undefined,
): boolean {
  if (!verifyToken) return false;
  return mode === "subscribe" && typeof token === "string" && token === verifyToken;
}

/**
 * Verifica a assinatura `X-Hub-Signature-256` que a Meta envia em cada POST.
 * É um HMAC-SHA256 do RAW body usando o App Secret, prefixado por `sha256=`.
 * Comparação em tempo constante (timingSafeEqual) para evitar timing attacks.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || !signatureHeader) return false;

  const [scheme, provided] = signatureHeader.split("=");
  if (scheme !== "sha256" || !provided) return false;

  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

  // Buffers de tamanhos diferentes fazem timingSafeEqual atirar → guarda antes.
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

export function createWhatsappWebhookRouter(): Router {
  const r = Router();

  // ── GET: verificação do webhook (setup na Meta) ────────────────────────────
  r.get("/", (req: Request, res: Response) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

    if (isValidWebhookVerification(mode, token, verifyToken)) {
      console.log("[WhatsAppWebhook] Verificação OK — a devolver challenge");
      res.status(200).send(String(challenge ?? ""));
      return;
    }
    console.warn("[WhatsAppWebhook] Verificação falhou (token/mode inválidos)");
    res.sendStatus(403);
  });

  // ── POST: eventos entrantes (mensagens + status) ───────────────────────────
  // express.raw local: mantém o body como Buffer para a validação HMAC.
  r.post("/", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

    if (!verifyMetaSignature(rawBody, signature, appSecret)) {
      console.warn("[WhatsAppWebhook] Assinatura X-Hub-Signature-256 inválida ou ausente → 401");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    // Parse do JSON. Corpo malformado → 400 (retry da Meta não ajudaria).
    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString("utf8") || "{}");
    } catch {
      console.warn("[WhatsAppWebhook] Corpo JSON malformado → 400");
      res.status(400).json({ error: "Malformed JSON" });
      return;
    }

    // PROCESS-THEN-ACK (decisão do Jorge, ajuste #2): escreve na BD ANTES de
    // responder 200. Se falhar, responde 5xx e a Meta faz retry — nunca perder
    // mensagens em silêncio. Import dinâmico para manter esta rota (que corre
    // antes do express.json) leve e só puxar db/drizzle quando há evento.
    try {
      const { processInboundWebhook } = await import("./whatsappInbound");
      const result = await processInboundWebhook(payload);
      if (result.processed || result.statuses || result.deduped) {
        console.log(
          `[WhatsAppWebhook] processado: ${result.processed} inbound, ${result.deduped} dedup, ${result.statuses} status`,
        );
      }
      res.sendStatus(200);
    } catch (err: any) {
      console.error("[WhatsAppWebhook] ERRO a processar (Meta fará retry):", err?.message || err);
      res.status(500).json({ error: "processing_failed" });
    }
  });

  return r;
}
