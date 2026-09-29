/**
 * Alertas com estado do webhook Multipark (multipark_sync_alerts): uma
 * notificação in-app aos admins por TRANSIÇÃO (levanta / resolve), nunca a
 * cada ciclo. O painel "Saúde dos dados" (sync pela API) saiu: as páginas
 * leem a BD da Multipark ao vivo e o webhook tem o seu cartão no Estado.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { mysqlToMs, utcMysql, webhookAlertDecision, WEBHOOK_STALE_HOURS_DEFAULT } from "./syncRules";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const affected = (r: unknown): number => Number((r as any)?.[0]?.affectedRows ?? 0);

export const WEBHOOK_ALERT_KEY = "webhook_stale";

/** Horas sem webhooks até alertar (Definições → Parâmetros; omissão 3 h). */
export async function webhookStaleHours(): Promise<number> {
  try {
    const { getSetting } = await import("./appSettings");
    const v = await getSetting("sync.webhookStaleHours");
    return typeof v === "number" && v > 0 ? v : WEBHOOK_STALE_HOURS_DEFAULT;
  } catch {
    return WEBHOOK_STALE_HOURS_DEFAULT;
  }
}

// ─── Alertas com estado ──────────────────────────────────────────────────────

/** Muda o estado do alerta; true só para quem fez a transição (UPDATE
 *  condicional — duas corridas em paralelo não avisam duas vezes). */
async function transitionAlert(key: string, active: boolean, detail: string | null): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  await db.execute(sql`INSERT IGNORE INTO multipark_sync_alerts (alertKey, active) VALUES (${key}, 0)`);
  const r = await db.execute(sql`UPDATE multipark_sync_alerts
    SET active = ${active ? 1 : 0}, since = ${active ? utcMysql(Date.now()) : null}, detail = ${detail ? detail.slice(0, 255) : null}
    WHERE alertKey = ${key} AND active = ${active ? 0 : 1}`);
  return affected(r) === 1;
}

async function alertIsActive(key: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const [row] = rowsOf(await db.execute(sql`SELECT active FROM multipark_sync_alerts WHERE alertKey = ${key} LIMIT 1`));
  return Number(row?.active ?? 0) === 1;
}

/**
 * Aviso de sincronização (tipo `sync_alert`: quem tem a Sincronização com
 * alcance nacional — super_admin e admin por omissão; ver
 * shared/notificationRouting.ts). Devolve quantas pessoas receberam.
 */
async function notifySyncAlert(title: string, body: string, link = "/definicoes?tab=estado", entityId?: string): Promise<number> {
  const { notify } = await import("./notify");
  const r = await notify({ kind: "sync_alert", title, body, link, entity: entityId ? { type: "sync_alert", id: entityId } : null });
  return r.recipients.length;
}

/** Corre no cron das notificações (5/5 min): sem webhooks há > X h em horário
 *  de operação (07–23 Lisboa) → avisa os admins uma vez; resolve quando voltar. */
export async function checkWebhookStaleAlert(now = Date.now()) {
  const db = await getDb();
  if (!db) return { checked: false as const };
  const [row] = rowsOf(await db.execute(sql`SELECT DATE_FORMAT(MAX(receivedAt), '%Y-%m-%d %H:%i:%s') AS lastAt FROM multipark_webhook_jobs`));
  const lastWebhookAt = mysqlToMs(row?.lastAt);
  const staleHours = await webhookStaleHours();
  const decision = webhookAlertDecision({ now, lastWebhookAt, staleHours, wasActive: await alertIsActive(WEBHOOK_ALERT_KEY) });
  let notified = 0;
  if (decision.transition === "raise") {
    if (await transitionAlert(WEBHOOK_ALERT_KEY, true, `sem webhooks há mais de ${staleHours} h`)) {
      notified = await notifySyncAlert("Sem notificações Multipark", `Não chega nenhum webhook da Multipark há mais de ${staleHours} h, em horário de operação. A cópia financeira (multipark_bookings) e o CRM ficam por atualizar; verificar as Conexões na plataforma.`);
    }
  } else if (decision.transition === "clear") {
    if (await transitionAlert(WEBHOOK_ALERT_KEY, false, null)) {
      notified = await notifySyncAlert("Notificações Multipark retomadas", "Voltaram a chegar webhooks da Multipark.");
    }
  }
  return { checked: true as const, ...decision, lastWebhookAt, staleHours, notified };
}
