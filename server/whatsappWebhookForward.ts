/**
 * Fan-out do webhook WhatsApp para o be-multipark.
 *
 * A dashboard é o ÚNICO Callback URL na Meta (a Meta só aceita um por app).
 * O be-multipark também precisa dos eventos (estados das mensagens `booking_*`
 * que ele envia, opt-out "Parar promoções", alterações de template), por isso
 * a dashboard reencaminha-lhos.
 *
 * Regras:
 * - SECUNDÁRIO: só corre DEPOIS do 200 à Meta (ver whatsappWebhook.ts) e nunca
 *   atira — qualquer falha (be em baixo, timeout, 4xx/5xx) é só logada. A Meta
 *   nunca vê uma falha por causa do forward. Não há retry: se o be estiver em
 *   baixo, esse evento perde-se para o be (a dashboard já o processou).
 * - Forward do ORIGINAL: os bytes exatos do raw body + `X-Hub-Signature-256`
 *   da Meta, para o be validar a assinatura com o mesmo App Secret. Nada é
 *   reprocessado nem re-serializado.
 * - Autenticação própria do forward: header `X-Multipark-Forward-Secret` com
 *   FORWARD_SHARED_SECRET (NUNCA o WHATSAPP_APP_SECRET).
 * - Desligado (no-op) enquanto BE_MULTIPARK_WEBHOOK_URL ou
 *   FORWARD_SHARED_SECRET não estiverem definidos.
 * - SEM filtro (decisão 2026-10-06): TODOS os eventos seguem, incluindo
 *   mensagens de números internos (colaboradores/extras) — o inbox do multipark
 *   tem de mostrar qualquer mensagem recebida. O da dashboard não muda.
 */

export const FORWARD_SECRET_HEADER = "x-multipark-forward-secret";
export const FORWARD_TIMEOUT_MS = 5_000;

export interface WebhookForwardConfig {
  url: string;
  sharedSecret: string;
}

/**
 * Lê e valida a config do forward. Devolve `null` (forward desligado) se faltar
 * algum valor ou se o URL não for https (http só para localhost, em dev). PURA.
 */
export function readWebhookForwardConfig(env: NodeJS.ProcessEnv = process.env): WebhookForwardConfig | null {
  const url = env.BE_MULTIPARK_WEBHOOK_URL?.trim();
  const sharedSecret = env.FORWARD_SHARED_SECRET?.trim();
  if (!url || !sharedSecret) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn("[WhatsAppForward] BE_MULTIPARK_WEBHOOK_URL inválido — forward desligado");
    return null;
  }
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
    console.warn("[WhatsAppForward] BE_MULTIPARK_WEBHOOK_URL tem de ser https — forward desligado");
    return null;
  }
  return { url: parsed.toString(), sharedSecret };
}

/**
 * Reencaminha o webhook ORIGINAL para o be-multipark. Nunca atira: resolve
 * sempre (com o resultado, útil em testes/logs).
 */
export async function forwardWhatsappWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  config: WebhookForwardConfig | null = readWebhookForwardConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<"skipped" | "ok" | "failed"> {
  if (!config) return "skipped";
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [FORWARD_SECRET_HEADER]: config.sharedSecret,
    };
    if (signatureHeader) headers["x-hub-signature-256"] = signatureHeader;

    const res = await fetchImpl(config.url, {
      method: "POST",
      headers,
      body: new Uint8Array(rawBody),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      redirect: "error", // nunca seguir redirects com o segredo no header
    });
    if (!res.ok) {
      // Só o estado HTTP: o corpo da resposta não é logado.
      console.error(`[WhatsAppForward] be-multipark respondeu ${res.status} — evento não reencaminhado`);
      return "failed";
    }
    return "ok";
  } catch (err: any) {
    console.error("[WhatsAppForward] falha a reencaminhar para o be-multipark:", err?.name || "", err?.message || err);
    return "failed";
  }
}
