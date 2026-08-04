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

/**
 * Contexto do envio, usado só para tornar o erro AUTO-DIAGNOSTICÁVEL: sem isto
 * o utilizador lê "template inexistente" e não sabe QUAL template nem em que
 * língua foi tentado (foi exactamente o que aconteceu no broadcast 8).
 */
export interface MetaErrorContext {
  to?: string;
  templateName?: string;
  languageCode?: string;
  paramCount?: number;
}

const GRAPH_BASE = "https://graph.facebook.com";
const MAX_ATTEMPTS = 2; // 1 tentativa + 1 retry

/** Mensagens legíveis para os códigos de erro Meta sem contexto adicional. */
const META_ERROR_HINTS: Record<number, string> = {
  131047: "Janela de 24h fechada — é preciso um template para reabrir a conversa.",
  130429: "Limite de envio (rate limit) atingido — demasiadas mensagens em pouco tempo.",
  131031: "Conta WhatsApp Business suspensa ou restringida pela Meta.",
  133010: "Número do remetente não registado na Cloud API (WHATSAPP_PHONE_NUMBER_ID errado?).",
  190: "Token de acesso expirado ou inválido.",
  368: "Envio bloqueado temporariamente pela Meta (violação de políticas).",
};

function quoted(value: string | undefined, fallback: string): string {
  return value ? `"${value}"` : fallback;
}

/**
 * Traduz um erro da Graph API para PT, com o contexto do envio embutido.
 *
 * PURA (sem I/O) — é o núcleo testável do mapeamento de erros. Devolve já a
 * mensagem final que vai para a UI e para `whatsapp_messages.errorDetail`,
 * incluindo o código Meta e, quando existe, o `error_data.details` (o campo
 * onde a Meta explica de facto o que falhou).
 */
export function describeMetaError(
  code: number | undefined,
  metaErr: any,
  ctx?: MetaErrorContext,
): string {
  const templateRef = quoted(ctx?.templateName, "o template");
  const langRef = quoted(ctx?.languageCode, "a língua indicada");
  const toRef = ctx?.to ? ` ${ctx.to}` : "";

  let base: string | undefined;
  switch (code) {
    case 131030:
      // WABA em modo de desenvolvimento: só entrega a números da lista de teste.
      base =
        `O número${toRef} não está na lista de destinatários permitidos da app Meta ` +
        `(a conta WhatsApp ainda está em modo de desenvolvimento). ` +
        `Adiciona o número em Meta for Developers → WhatsApp → API Setup → "To" (allowed recipients), ` +
        `ou passa a conta para produção com um número verificado.`;
      break;
    case 132001:
      base =
        `Template ${templateRef} não existe ou não está aprovado na língua ${langRef}. ` +
        `Confirma no WhatsApp Manager o nome EXATO e a língua da tradução ` +
        `(pt_PT, pt_BR e pt são traduções diferentes para a Meta).`;
      break;
    case 132000:
      base =
        `Template ${templateRef} (${ctx?.languageCode ?? "?"}): o número de parâmetros enviados ` +
        `(${ctx?.paramCount ?? "?"}) não corresponde ao aprovado. ` +
        `Confirma quantos {{n}} tem o corpo do template e se ele tem (ou não) botão com link.`;
      break;
    case 132005:
      base = `Template ${templateRef}: um dos parâmetros é demasiado longo para o aprovado.`;
      break;
    case 132012:
      base = `Template ${templateRef}: formato de parâmetro inválido (quebras de linha, tabs ou espaços a mais).`;
      break;
    case 131026:
      base = `O número${toRef} não tem WhatsApp ou não pode receber mensagens.`;
      break;
    case 131009:
      base = `Parâmetro inválido no envio para${toRef || " o destinatário"} (número mal formado?).`;
      break;
    default:
      base = code != null ? META_ERROR_HINTS[code] : undefined;
  }

  const parts: string[] = [base || metaErr?.message || "Falha no envio."];
  const details: string | undefined = metaErr?.error_data?.details;
  // Só acrescenta o detalhe da Meta se trouxer informação nova (evita repetir
  // a mesma frase duas vezes quando não temos hint próprio).
  if (details && !parts[0].includes(details)) parts.push(`Detalhe Meta: ${details}`);
  const suffix = Number.isFinite(code) ? ` (código ${code})` : "";
  return parts.join(" — ") + suffix;
}

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
async function postMessage(
  payload: Record<string, unknown>,
  ctx?: MetaErrorContext,
): Promise<WhatsappSendResult> {
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
      const rawCode = Number(metaErr?.code);
      const code = Number.isFinite(rawCode) ? rawCode : undefined;
      const detail = metaErr
        ? describeMetaError(code, metaErr, ctx)
        : `HTTP ${resp.status}`;

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
      return { ok: false, error: detail, code };
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
  return postMessage(payload, {
    to: toE164,
    templateName,
    languageCode,
    paramCount: countBodyParams(components),
  });
}

/** Quantos parâmetros de body vão no envio (para a mensagem de erro do 132000). */
function countBodyParams(components?: unknown[]): number {
  if (!components) return 0;
  for (const c of components as any[]) {
    if (c?.type === "body") return Array.isArray(c.parameters) ? c.parameters.length : 0;
  }
  return 0;
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
