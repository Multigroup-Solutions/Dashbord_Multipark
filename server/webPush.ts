/**
 * Notificações push do browser (Web Push + VAPID) — só para as chamadas do
 * WhatsApp a tocar: "Chamada WhatsApp de <nome>" mesmo com o separador do
 * dashboard em segundo plano (o toque dentro da página continua a ser o
 * `WhatsAppCallManager`).
 *
 *  - envs `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`
 *    (gerar com `pnpm exec web-push generate-vapid-keys`); faltam → tudo
 *    desligado, um aviso no log, nunca rebenta;
 *  - subscrições em `web_push_subscriptions` (migração 0330), uma por browser;
 *  - destinatários = quem VÊ a chamada no toque (mesmas regras do
 *    `whatsapp.calls.incoming`: WhatsApp "editar" + cidade);
 *  - corre DEPOIS do 200 do webhook (waitUntil), nunca lança;
 *  - 404/410 do serviço de push → a subscrição é apagada.
 *
 * Dependência `web-push`: faz a assinatura VAPID (JWT ES256) e a cifra do
 * conteúdo (RFC 8291, aes128gcm) que os serviços de push exigem.
 */
import crypto from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { users, webPushSubscriptions } from "../drizzle/schema";
import { maskPhone } from "../shared/maskPhone";
import {
  buildCallPushPayload, isGonePushStatus, pickPushDeliveries, vapidConfigFrom,
  type PushSubscriptionInput, type VapidConfig,
} from "../shared/webPush";

let warnedMissing = false;

/** Configuração VAPID ou null (e um único aviso no log por processo). */
export function vapidConfig(): VapidConfig | null {
  const cfg = vapidConfigFrom(process.env);
  if (!cfg && !warnedMissing) {
    warnedMissing = true;
    console.warn("[WebPush] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT em falta ou inválidas: notificações push desligadas.");
  }
  return cfg;
}

const endpointHash = (endpoint: string): string => crypto.createHash("sha256").update(endpoint).digest("hex");
const nowUtc = (): string => new Date().toISOString().slice(0, 19).replace("T", " ");

async function dbOrThrow() {
  const { getDb } = await import("./db");
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  return db;
}

/** Guarda (ou passa para esta pessoa) a subscrição deste browser. */
export async function savePushSubscription(userId: number, sub: PushSubscriptionInput, userAgent: string | null): Promise<void> {
  const db = await dbOrThrow();
  await db.insert(webPushSubscriptions).values({
    userId,
    endpointHash: endpointHash(sub.endpoint),
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    userAgent: userAgent ? userAgent.slice(0, 255) : null,
  }).onDuplicateKeyUpdate({
    set: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent ? userAgent.slice(0, 255) : null, lastFailureAt: null },
  });
}

/** Apaga a subscrição deste browser (só se for da própria pessoa). */
export async function deletePushSubscription(userId: number, endpoint: string): Promise<void> {
  const db = await dbOrThrow();
  await db.delete(webPushSubscriptions).where(and(eq(webPushSubscriptions.endpointHash, endpointHash(endpoint)), eq(webPushSubscriptions.userId, userId)));
}

/** A pessoa tem esta subscrição registada? */
export async function hasPushSubscription(userId: number, endpoint: string): Promise<boolean> {
  const db = await dbOrThrow();
  const rows = await db.select({ id: webPushSubscriptions.id }).from(webPushSubscriptions)
    .where(and(eq(webPushSubscriptions.endpointHash, endpointHash(endpoint)), eq(webPushSubscriptions.userId, userId))).limit(1);
  return rows.length > 0;
}

interface CallForPush {
  id: number;
  phoneE164: string;
  conversationId: number | null;
  name: string | null;
}

/** Chamadas recebidas a tocar (pelos ids `wacid.…` da Meta) com o nome da conversa. */
async function loadRingingCalls(callIds: string[]): Promise<CallForPush[]> {
  const db = await dbOrThrow();
  const [rows] = (await db.execute(sql`
    SELECT k.id, k.phoneE164, k.conversationId,
           COALESCE(NULLIF(TRIM(e.fullName), ''),
             (SELECT ln.fullName FROM extra_leads ln WHERE ln.phoneE164 = c.phoneE164 COLLATE utf8mb4_unicode_ci ORDER BY ln.id DESC LIMIT 1),
             NULLIF(TRIM(c.profileName), '')) AS name
      FROM whatsapp_calls k
      LEFT JOIN whatsapp_conversations c ON c.id = k.conversationId
      LEFT JOIN employees e ON e.id = c.employeeId
     WHERE k.callId IN (${sql.join(callIds.map((id) => sql`${id}`), sql`, `)})
       AND k.direction = 'in' AND k.status = 'ringing'`)) as any;
  return (rows as any[]).map((r) => ({
    id: Number(r.id),
    phoneE164: String(r.phoneE164),
    conversationId: r.conversationId == null ? null : Number(r.conversationId),
    name: r.name == null ? null : String(r.name),
  }));
}

/**
 * Push "Chamada WhatsApp de …" para as chamadas que começaram a tocar neste
 * webhook. Nunca lança (corre depois do 200, via waitUntil).
 */
export async function pushRingingCalls(callIds: string[]): Promise<void> {
  if (!callIds.length) return;
  const cfg = vapidConfig();
  if (!cfg) return;
  try {
    const db = await dbOrThrow();
    const calls = await loadRingingCalls(callIds);
    if (!calls.length) return;
    const subs = await db.select().from(webPushSubscriptions);
    if (!subs.length) return;

    // Quem vê cada chamada no toque: o âmbito de cada pessoa com subscrição é
    // calculado pelas MESMAS regras do stream/`incoming`.
    const userIds = Array.from(new Set(subs.map((s) => s.userId)));
    const people = await db.select().from(users).where(and(inArray(users.id, userIds), eq(users.isActive, 1)));
    const { callScopeForUser } = await import("./whatsappCallStream");
    const { listIncomingCalls } = await import("./whatsappCallsQueries");
    const visibleByCall = new Map<number, Set<number>>(calls.map((c) => [c.id, new Set<number>()]));
    for (const person of people) {
      const s = await callScopeForUser(person);
      if (!s?.enabled) continue;
      const seen = await listIncomingCalls(s.scope ?? undefined);
      for (const row of seen) if (row.status === "ringing") visibleByCall.get(row.id)?.add(person.id);
    }

    const webpush = (await import("web-push")).default;
    webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
    let sent = 0;
    let removed = 0;
    for (const call of calls) {
      const payload = JSON.stringify(buildCallPushPayload({ callId: call.id, name: call.name, phoneE164: call.phoneE164, conversationId: call.conversationId }));
      for (const sub of pickPushDeliveries(subs, visibleByCall.get(call.id) ?? new Set())) {
        try {
          // TTL curto: um aviso de chamada com mais de 1 min já não serve.
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 60, urgency: "high" });
          sent++;
          await db.update(webPushSubscriptions).set({ lastSuccessAt: nowUtc() }).where(eq(webPushSubscriptions.id, sub.id));
        } catch (err: any) {
          if (isGonePushStatus(err?.statusCode)) {
            removed++;
            await db.delete(webPushSubscriptions).where(eq(webPushSubscriptions.id, sub.id)).catch(() => undefined);
          } else {
            console.warn(`[WebPush] envio falhou (subscrição ${sub.id}, estado ${err?.statusCode ?? "sem resposta"})`);
            await db.update(webPushSubscriptions).set({ lastFailureAt: nowUtc() }).where(eq(webPushSubscriptions.id, sub.id)).catch(() => undefined);
          }
        }
      }
    }
    if (sent || removed) {
      console.log(`[WebPush] chamada de ${calls.map((c) => maskPhone(c.phoneE164)).join(", ")}: ${sent} push enviados${removed ? `, ${removed} subscrições expiradas apagadas` : ""}`);
    }
  } catch (err: any) {
    console.warn("[WebPush] aviso de chamada falhou:", String(err?.message ?? err).slice(0, 160));
  }
}
