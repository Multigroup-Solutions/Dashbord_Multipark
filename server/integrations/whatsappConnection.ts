/**
 * Estado da ligação WhatsApp (Cloud API) em integration_connections
 * (provider 'whatsapp'), para o hub de Integrações e os alertas.
 *
 * O WhatsApp usa um token fixo (WHATSAPP_TOKEN), não OAuth — mas o token
 * expira/é revogado e a Graph API responde com o código 190. Até aqui isso só
 * aparecia como "falha no envio" mensagem a mensagem; agora fica registado
 * como `reauth_required` (o alerta avisa os admins uma vez) e volta a
 * `connected` no primeiro envio bem-sucedido.
 *
 * Nunca lança: o registo é melhor-esforço e não pode partir um envio.
 */
import { sql } from "drizzle-orm";

export const WHATSAPP_PROVIDER = "whatsapp";
/** Graph API: token inválido/expirado. */
export const META_TOKEN_EXPIRED_CODE = 190;

const RECOVER_THROTTLE_MS = 5 * 60_000;
let lastRecoverAt = 0;

/** O erro da Graph API é de token expirado/inválido? PURA. */
export function isWhatsappTokenError(code: number | null | undefined): boolean {
  return Number(code) === META_TOKEN_EXPIRED_CODE;
}

export async function recordWhatsappAuthError(detail: string): Promise<void> {
  try {
    const { getDb } = await import("../db");
    const db = await getDb();
    if (!db) return;
    const msg = `Token WhatsApp expirado ou inválido (190): ${String(detail).slice(0, 300)}`;
    await db.execute(sql`
      INSERT INTO integration_connections (provider, status, lastError, lastCheckedAt)
      VALUES (${WHATSAPP_PROVIDER}, 'reauth_required', ${msg}, UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE status = 'reauth_required', lastError = ${msg}, lastCheckedAt = UTC_TIMESTAMP()`);
    lastRecoverAt = 0;
  } catch (err: any) {
    console.warn("[WhatsApp] não foi possível registar o erro de token:", String(err?.message ?? err).slice(0, 160));
  }
}

/** Um pedido bem-sucedido: se a ligação estava marcada como má, volta a `connected` (no máx. 1×/5 min). */
export async function recordWhatsappSuccess(): Promise<void> {
  if (Date.now() - lastRecoverAt < RECOVER_THROTTLE_MS) return;
  lastRecoverAt = Date.now();
  try {
    const { getDb } = await import("../db");
    const db = await getDb();
    if (!db) return;
    await db.execute(sql`
      UPDATE integration_connections SET status = 'connected', lastError = NULL, lastCheckedAt = UTC_TIMESTAMP()
       WHERE provider = ${WHATSAPP_PROVIDER} AND status <> 'connected'`);
  } catch { /* melhor esforço */ }
}
