/**
 * Notificações push do browser para as chamadas do WhatsApp (cliente):
 * registo do service worker (`/sw.js`, só push), pedido de permissão e
 * subscrição com a chave VAPID do servidor. O servidor guarda a subscrição
 * (`whatsapp.calls.pushSubscribe`) e envia o aviso quando uma chamada toca.
 */
import { base64UrlToBytes, type PushSubscriptionInput } from "@shared/webPush";

export const SW_URL = "/sw.js";

/** O browser suporta push (service worker + PushManager + Notification)? */
export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Permissão atual das notificações ("default" = ainda não perguntado). */
export function notificationPermission(): NotificationPermission | "unsupported" {
  return pushSupported() ? Notification.permission : "unsupported";
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  return existing ?? navigator.serviceWorker.register(SW_URL, { scope: "/" });
}

/** Subscrição deste browser, se já existir (sem pedir nada ao utilizador). */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch {
    return null;
  }
}

function sameKey(current: ArrayBuffer | null, expected: Uint8Array): boolean {
  if (!current) return false;
  const a = new Uint8Array(current);
  return a.length === expected.length && a.every((b, i) => b === expected[i]);
}

function toInput(sub: PushSubscription): PushSubscriptionInput | null {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

export type EnablePushResult = { ok: true; subscription: PushSubscriptionInput } | { ok: false; message: string };

/**
 * Pede permissão (tem de vir de um clique), regista o service worker e cria a
 * subscrição com a chave pública VAPID. Não fala com o servidor: quem chama
 * envia `subscription` para `pushSubscribe`.
 */
export async function enablePush(publicKey: string): Promise<EnablePushResult> {
  if (!pushSupported()) return { ok: false, message: "Este browser não suporta notificações push." };
  const permission = await Notification.requestPermission();
  if (permission === "denied") {
    return { ok: false, message: "As notificações estão bloqueadas neste browser. Para as ativar, abre as definições do site (cadeado ao lado do endereço) e permite as notificações." };
  }
  if (permission !== "granted") return { ok: false, message: "Não autorizaste as notificações." };
  try {
    const reg = await registration();
    await navigator.serviceWorker.ready;
    const key = base64UrlToBytes(publicKey);
    let existing = await reg.pushManager.getSubscription();
    // Subscrição feita com outra chave VAPID (chaves trocadas no servidor) não
    // serve: o serviço de push recusaria os envios.
    if (existing && !sameKey(existing.options?.applicationServerKey ?? null, key)) {
      await existing.unsubscribe().catch(() => false);
      existing = null;
    }
    const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource }));
    const input = toInput(sub);
    if (!input) return { ok: false, message: "O browser não devolveu uma subscrição válida." };
    return { ok: true, subscription: input };
  } catch (e: any) {
    return { ok: false, message: `Não foi possível ativar as notificações neste browser${e?.message ? ` (${e.message})` : ""}.` };
  }
}

/** Remove a subscrição deste browser. Devolve o endpoint que existia (para o servidor apagar). */
export async function disablePush(): Promise<string | null> {
  const sub = await currentPushSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  try {
    await sub.unsubscribe();
  } catch { /* o servidor apaga na mesma */ }
  return endpoint;
}
