/**
 * Cliente fino da WhatsApp Cloud API (Meta Graph API).
 *
 * Uma chamada por destinatário (POST /{phoneNumberId}/messages). Sem
 * dependências novas — usa `fetch` nativo. Faz 1 retry com backoff curto apenas
 * em 429 / 5xx / erro de rede (erros de aplicação, ex. template não aprovado ou
 * número inválido, NÃO fazem retry). Mapeia os códigos de erro Meta mais comuns
 * para mensagens legíveis em PT.
 *
 * Config por env: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_API_VERSION
 * (default v21.0).
 */

export type WhatsappSendResult =
  | { ok: true; waMessageId: string }
  | { ok: false; error: string; code?: number };

const GRAPH_BASE = "https://graph.facebook.com";
const MAX_ATTEMPTS = 2; // 1 tentativa + 1 retry

/** Mensagens legíveis para os códigos de erro Meta mais frequentes. */
const META_ERROR_HINTS: Record<number, string> = {
  131026: "O número não tem WhatsApp ou não pode receber mensagens.",
  131047: "Janela de 24h fechada — é preciso um template para reabrir a conversa.",
  132000: "Template inválido: o número de parâmetros não corresponde ao aprovado.",
  132001: "Template inexistente ou ainda não aprovado.",
  130429: "Limite de envio (rate limit) atingido — demasiadas mensagens em pouco tempo.",
  190: "Token de acesso expirado ou inválido.",
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function apiVersion(): string {
  return process.env.WHATSAPP_API_VERSION || "v21.0";
}

/** Meta aceita o destinatário em dígitos (sem o "+"). */
function toRecipient(toE164: string): string {
  return toE164.replace(/^\+/, "");
}

/**
 * POST genérico com retry. Interno — os exports públicos montam o payload.
 */
async function postMessage(payload: Record<string, unknown>): Promise<WhatsappSendResult> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return {
      ok: false,
      error: "WhatsApp não configurado (falta WHATSAPP_TOKEN e/ou WHATSAPP_PHONE_NUMBER_ID).",
    };
  }

  const url = `${GRAPH_BASE}/${apiVersion()}/${phoneNumberId}/messages`;
  let lastError = "Falha desconhecida no envio.";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as any;
        const waMessageId: string | undefined = data?.messages?.[0]?.id;
        if (waMessageId) return { ok: true, waMessageId };
        return { ok: false, error: "Resposta da Meta sem message id." };
      }

      // Erro HTTP — extrai o erro estruturado da Meta.
      const errBody = (await resp.json().catch(() => ({}))) as any;
      const metaErr = errBody?.error;
      const code = Number(metaErr?.code);
      const hint = Number.isFinite(code) ? META_ERROR_HINTS[code] : undefined;
      const base = hint || metaErr?.message || `HTTP ${resp.status}`;
      const detail = Number.isFinite(code) ? `${base} (código ${code})` : base;

      // Retry só em rate limit / erro do servidor.
      if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_ATTEMPTS) {
        lastError = detail;
        console.warn(
          `[WhatsApp] Envio falhou (tentativa ${attempt}, HTTP ${resp.status}): ${detail} — a repetir…`,
        );
        await sleep(500 * attempt);
        continue;
      }

      console.warn(`[WhatsApp] Envio falhou (HTTP ${resp.status}): ${detail}`);
      return { ok: false, error: detail, code: Number.isFinite(code) ? code : undefined };
    } catch (err: any) {
      lastError = err?.message || String(err);
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[WhatsApp] Erro de rede (tentativa ${attempt}): ${lastError} — a repetir…`);
        await sleep(500 * attempt);
        continue;
      }
      console.error(`[WhatsApp] Erro de rede final: ${lastError}`);
      return { ok: false, error: `Erro de rede: ${lastError}` };
    }
  }

  return { ok: false, error: lastError };
}

/**
 * Envia uma mensagem de TEMPLATE (o único tipo permitido fora da janela de 24h).
 * `components` opcional segue o formato da Graph API (body/header params etc.).
 */
export async function sendTemplateMessage(
  toE164: string,
  templateName: string,
  languageCode: string,
  components?: unknown[],
): Promise<WhatsappSendResult> {
  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    to: toRecipient(toE164),
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components && components.length ? { components } : {}),
    },
  };
  return postMessage(payload);
}

/**
 * Envia texto livre. Só é entregue se a janela de 24h estiver aberta
 * (última mensagem entrante do contacto há menos de 24h) — caso contrário a
 * Meta devolve 131047 (mapeado acima).
 */
export async function sendTextMessage(toE164: string, text: string): Promise<WhatsappSendResult> {
  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    to: toRecipient(toE164),
    type: "text",
    text: { body: text },
  };
  return postMessage(payload);
}
