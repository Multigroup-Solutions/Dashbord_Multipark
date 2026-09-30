/**
 * Notificações push do browser (Web Push + VAPID) para as chamadas do
 * WhatsApp: regras PURAS partilhadas entre o servidor (`server/webPush.ts`) e
 * o cliente (`client/src/lib/webPush.ts`).
 */
import { maskPhone } from "./maskPhone";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * Chaves VAPID a partir das envs. Falta alguma (ou o subject não é
 * `mailto:`/`https:`) → null = funcionalidade desligada. PURA.
 */
export function vapidConfigFrom(env: Record<string, string | undefined>): VapidConfig | null {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (env.VAPID_PRIVATE_KEY ?? "").trim();
  const subject = (env.VAPID_SUBJECT ?? "").trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!/^(mailto:|https:\/\/)/i.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

/**
 * O serviço de push respondeu que a subscrição já não existe (404/410) →
 * apaga-se a linha. Outros erros (429, 5xx, rede) são temporários. PURA.
 */
export function isGonePushStatus(statusCode: number | null | undefined): boolean {
  return statusCode === 404 || statusCode === 410;
}

/** Subscrição tal como o browser a entrega (`PushSubscription.toJSON()`). */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Valida uma subscrição vinda do browser: endpoint https (serviço de push do
 * browser), chaves em base64url. Devolve a mensagem de erro ou null. PURA.
 */
export function pushSubscriptionError(sub: PushSubscriptionInput): string | null {
  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return "Endereço de notificações inválido.";
  }
  if (url.protocol !== "https:") return "Endereço de notificações inválido.";
  if (!B64URL.test(sub.keys.p256dh) || !B64URL.test(sub.keys.auth)) return "Chaves de notificações inválidas.";
  return null;
}

export interface PushSubscriptionRow {
  id: number;
  userId: number;
}

/**
 * Subscrições a quem se envia o push de UMA chamada: só as das pessoas que
 * veem essa chamada no toque (`visibleUserIds` = quem tem o WhatsApp
 * "editar" e a chamada no seu âmbito de cidade, calculado com as MESMAS
 * regras do `whatsapp.calls.incoming`). Várias subscrições da mesma pessoa
 * (browsers diferentes) recebem todas. Ordenado por id. PURA.
 */
export function pickPushDeliveries<T extends PushSubscriptionRow>(subs: readonly T[], visibleUserIds: ReadonlySet<number>): T[] {
  const seen = new Set<number>();
  return subs
    .filter((s) => visibleUserIds.has(s.userId) && !seen.has(s.id) && (seen.add(s.id), true))
    .sort((a, b) => a.id - b.id);
}

export interface CallPushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/**
 * Conteúdo do push de uma chamada a tocar. Sem nome conhecido (o "nome" é o
 * próprio número) → número mascarado. PURA.
 */
export function buildCallPushPayload(input: { callId: number; name: string | null; phoneE164: string; conversationId: number | null }): CallPushPayload {
  const rawName = (input.name ?? "").trim();
  const digits = (s: string) => s.replace(/\D/g, "");
  const isJustTheNumber = !rawName || (digits(rawName).length >= 6 && digits(rawName) === digits(input.phoneE164));
  const who = isJustTheNumber ? maskPhone(input.phoneE164) || "número desconhecido" : rawName.slice(0, 80);
  return {
    title: `Chamada WhatsApp de ${who}`,
    body: "Abre o dashboard para atender.",
    url: input.conversationId ? `/whatsapp?c=${input.conversationId}` : "/whatsapp",
    tag: `wa-call-${input.callId}`,
  };
}

/** Chave pública VAPID (base64url) → bytes para `pushManager.subscribe`. PURA. */
export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
