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
 */

import { isNotNull } from "drizzle-orm";
import { getDb } from "./db";
import { employees, extraLeads } from "../drizzle/schema";
import { normalizePhoneE164 } from "../shared/phone";

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

// ── PONTO DE FILTRAGEM ──────────────────────────────────────────────────────
//
// Decisão do utilizador (2026-10-02): a dashboard é para números INTERNOS
// (colaboradores, extras e candidatos a extra), o multipark para clientes e
// reservas — são independentes. Logo um evento NÃO segue para o be quando é
// SÓ mensagens recebidas de números internos conhecidos. Tudo o resto segue:
//   - qualquer `statuses` (o be precisa dos estados dos `booking_*` que envia),
//   - qualquer evento que não seja `messages` (template status/category, …),
//   - payload misto (algum remetente não interno) — o raw body vai inteiro ou
//     não vai (editá-lo partia a assinatura),
//   - erro na consulta à BD → SEGUE (fail-open: no be, um número desconhecido
//     cai no balde "não atribuídas", visível só a admins da plataforma).
// Só corre DEPOIS do 200 à Meta, por isso nunca atrasa a resposta.

/** O que o filtro precisa de saber de um payload. PURA. */
export type ForwardClassification =
  | { kind: "forward"; reason: "statuses" | "non_message_event" | "no_inbound" | "malformed" }
  | { kind: "inbound_only"; senders: string[] };

export function classifyForwardPayload(payload: unknown): ForwardClassification {
  const entries = (payload as { entry?: unknown })?.entry;
  if (!Array.isArray(entries)) return { kind: "forward", reason: "malformed" };
  const senders = new Set<string>();
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) return { kind: "forward", reason: "malformed" };
    for (const change of changes) {
      const field = (change as { field?: unknown })?.field;
      const value = (change as { value?: any })?.value ?? {};
      if (field !== "messages") return { kind: "forward", reason: "non_message_event" };
      if (Array.isArray(value.statuses) && value.statuses.length > 0) return { kind: "forward", reason: "statuses" };
      for (const m of Array.isArray(value.messages) ? value.messages : []) {
        const from = typeof m?.from === "string" ? m.from.replace(/\D/g, "") : "";
        if (!from) return { kind: "forward", reason: "malformed" };
        senders.add(from);
      }
    }
  }
  if (senders.size === 0) return { kind: "forward", reason: "no_inbound" };
  return { kind: "inbound_only", senders: Array.from(senders) };
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

/** Lookup por omissão. ATIRA se não houver BD — o chamador faz fail-open. */
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
 * Segue para o be-multipark? Async (consulta a BD). Nunca atira: em dúvida, SEGUE.
 * O `payload` é só para LER — o que segue para o be é sempre o raw body.
 */
export async function shouldForwardWebhook(
  payload: unknown,
  lookup: InternalPhoneLookup = isInternalPhone,
): Promise<boolean> {
  const verdict = classifyForwardPayload(payload);
  if (verdict.kind === "forward") return true;
  try {
    for (const sender of verdict.senders) {
      if (!(await lookup(senderToE164(sender)))) return true; // cliente (ou desconhecido)
    }
    return false; // só números internos — o multipark não os vê
  } catch (err: any) {
    console.warn("[WhatsAppForward] consulta de números internos falhou — reencaminha (fail-open):", err?.message || err);
    return true;
  }
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
