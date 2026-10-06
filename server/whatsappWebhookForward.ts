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
 * - Números internos são MARCADOS, não retidos: `X-Multipark-Internal-Senders`
 *   leva os remetentes que são colaboradores/extras/candidatos. O multipark é
 *   SaaS multi-parque: uma conversa interna nunca pode cair no inbox de um
 *   parque (lá fica "não atribuída", só admins da plataforma). O cabeçalho só
 *   vale porque o pedido é autenticado pelo segredo do forward.
 */

import { isNotNull } from "drizzle-orm";
import { getDb } from "./db";
import { employees, extraLeads } from "../drizzle/schema";
import { normalizePhoneE164 } from "../shared/phone";

export const FORWARD_SECRET_HEADER = "x-multipark-forward-secret";
export const INTERNAL_SENDERS_HEADER = "x-multipark-internal-senders";
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

/** Remetentes (`from` da Meta, só dígitos) das mensagens recebidas no payload. PURA. */
export function inboundSenders(payload: unknown): string[] {
  const senders = new Set<string>();
  const entries = (payload as { entry?: unknown })?.entry;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const changes = (entry as { changes?: unknown })?.changes;
    for (const change of Array.isArray(changes) ? changes : []) {
      const messages = (change as { value?: { messages?: unknown } })?.value?.messages;
      for (const m of Array.isArray(messages) ? messages : []) {
        const from = typeof (m as any)?.from === "string" ? (m as any).from.replace(/\D/g, "") : "";
        if (from) senders.add(from);
      }
    }
  }
  return Array.from(senders);
}

/** `from` da Meta (dígitos) → E.164, com a normalização da dashboard. PURA. */
function senderToE164(from: string): string {
  return normalizePhoneE164(from) ?? `+${from}`;
}

export type InternalPhoneLookup = (phoneE164: string) => Promise<boolean>;

// Conjunto de telefones internos (cache 5 min): `employees.phone` (texto livre,
// normalizado em memória como no inbox) + `extra_leads` (candidatos a extra).
export const INTERNAL_PHONE_CACHE_MS = 5 * 60 * 1000;
let internalPhoneCache: { at: number; set: Set<string> } | null = null;

export function invalidateInternalPhoneCache(): void {
  internalPhoneCache = null;
}

/** Lookup por omissão. ATIRA se não houver BD — o chamador decide. */
export const isInternalPhone: InternalPhoneLookup = async (phoneE164) => {
  const now = Date.now();
  if (!internalPhoneCache || now - internalPhoneCache.at >= INTERNAL_PHONE_CACHE_MS) {
    const db = await getDb();
    if (!db) throw new Error("DB indisponível");
    const [staff, leads] = await Promise.all([
      db.select({ phone: employees.phone }).from(employees).where(isNotNull(employees.phone)),
      db.select({ phone: extraLeads.phone, phoneE164: extraLeads.phoneE164 }).from(extraLeads),
    ]);
    const set = new Set<string>();
    for (const r of staff) {
      const e164 = r.phone ? normalizePhoneE164(r.phone) : null;
      if (e164) set.add(e164);
    }
    for (const r of leads) {
      const e164 = r.phoneE164 || (r.phone ? normalizePhoneE164(r.phone) : null);
      if (e164) set.add(e164);
    }
    internalPhoneCache = { at: now, set };
  }
  return internalPhoneCache.set.has(phoneE164);
};

/**
 * Remetentes do payload que são números INTERNOS (dígitos, como a Meta os
 * manda). Nunca atira: falha na consulta → [] e o evento segue sem marca (o
 * multipark aplica então as regras normais de atribuição, que já recusam
 * adivinhar).
 */
export async function findInternalSenders(payload: unknown, lookup: InternalPhoneLookup = isInternalPhone): Promise<string[]> {
  const senders = inboundSenders(payload);
  if (senders.length === 0) return [];
  try {
    const internal: string[] = [];
    for (const from of senders) {
      if (await lookup(senderToE164(from))) internal.push(from);
    }
    return internal;
  } catch (err: any) {
    console.warn("[WhatsAppForward] consulta de números internos falhou — segue sem marca:", err?.message || err);
    return [];
  }
}

/**
 * Reencaminha o webhook ORIGINAL para o be-multipark. Nunca atira: resolve
 * sempre (com o resultado, útil em testes/logs). `internalSenders` vai no
 * cabeçalho `X-Multipark-Internal-Senders` (só quando há algum).
 */
export async function forwardWhatsappWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  config: WebhookForwardConfig | null = readWebhookForwardConfig(),
  fetchImpl: typeof fetch = fetch,
  internalSenders: string[] = [],
): Promise<"skipped" | "ok" | "failed"> {
  if (!config) return "skipped";
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [FORWARD_SECRET_HEADER]: config.sharedSecret,
    };
    if (signatureHeader) headers["x-hub-signature-256"] = signatureHeader;
    if (internalSenders.length) headers[INTERNAL_SENDERS_HEADER] = internalSenders.join(",");

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
