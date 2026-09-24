/**
 * Saúde dos dados da sincronização Multipark — painel da página
 * Sincronização e cartão do "Estado do sistema" (Definições).
 *
 * Só totais e códigos: nenhum payload, nome de cliente ou mensagem de erro
 * (as mensagens podem trazer dados pessoais).
 *
 * Também trata os alertas com estado (multipark_sync_alerts): uma notificação
 * in-app aos admins por TRANSIÇÃO (levanta / resolve), nunca a cada ciclo.
 */
import { sql } from "drizzle-orm";
import { getDb, getLastSyncSuccessAt } from "./db";
import { PARK_CONFIGS } from "./multipark";
import { currentSyncLock } from "./syncLock";
import { mysqlToMs, utcMysql, webhookAlertDecision, WEBHOOK_STALE_HOURS_DEFAULT, WEBHOOK_ALERT_START_HOUR, WEBHOOK_ALERT_END_HOUR, RECONCILIATION_DRIFT_THRESHOLD } from "./syncRules";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const affected = (r: unknown): number => Number((r as any)?.[0]?.affectedRows ?? 0);

export const WEBHOOK_ALERT_KEY = "webhook_stale";
export const RECONCILIATION_ALERT_KEY = "reconciliation_drift";

const parkLabel = (id: string) => {
  const p = PARK_CONFIGS.find((c) => c.id === id);
  return p ? `${p.name} — ${p.city}` : id;
};

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

export interface SyncHealth {
  now: number;
  lastWebhookAt: number | null;
  lastRecentOkAt: number | null;
  lastFutureOkAt: number | null;
  lastRecentRun: { at: number | null; status: string; parkErrors: Array<{ id: string; label: string }>; skippedJobs: number; totalMismatches: number } | null;
  queue: { pending: number; processing: number; failed: number; dead: number; oldestOpenAt: number | null };
  queueErrors: Array<{ state: string; code: string; n: number }>;
  bookingErrors: Array<{ kind: "detail" | "history"; code: string; park: string; n: number }>;
  coverage: Array<{ parkId: string; label: string; recentCoveredAt: number | null; lastStatus: string | null; lastErrorCode: string | null }>;
  reconciliation: {
    lastCheckedAt: number | null;
    rows: Array<{ day: string; parkId: string; label: string; actionType: string; apiTotal: number | null; apiCount: number; dbFound: number; missing: number; status: string; errorCode: string | null }>;
    driftThreshold: number;
  };
  alerts: Array<{ key: string; active: boolean; since: number | null; detail: string | null }>;
  webhookStaleHours: number;
  operatingHours: { start: number; end: number };
  lock: { owner: string | null; acquiredAt: string | null } | null;
}

export async function getSyncHealth(): Promise<SyncHealth> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");

  const [q] = rowsOf(await db.execute(sql`SELECT
      DATE_FORMAT(MAX(receivedAt), '%Y-%m-%d %H:%i:%s') AS lastWebhookAt,
      DATE_FORMAT(MIN(CASE WHEN state IN ('pending', 'processing', 'failed') THEN receivedAt END), '%Y-%m-%d %H:%i:%s') AS oldestOpenAt,
      COALESCE(SUM(state = 'pending'), 0) AS pending,
      COALESCE(SUM(state = 'processing'), 0) AS processing,
      COALESCE(SUM(state = 'failed'), 0) AS failed,
      COALESCE(SUM(state = 'dead'), 0) AS dead
    FROM multipark_webhook_jobs`));

  const queueErrors = rowsOf(await db.execute(sql`SELECT state, COALESCE(errorCode, 'SEM_CODIGO') AS code, COUNT(*) AS n
    FROM multipark_webhook_jobs WHERE state IN ('failed', 'dead')
    GROUP BY state, COALESCE(errorCode, 'SEM_CODIGO') ORDER BY n DESC LIMIT 50`))
    .map((r) => ({ state: String(r.state), code: String(r.code), n: Number(r.n) }));

  const bookingErrors = rowsOf(await db.execute(sql`SELECT kind, code, park, n FROM (
      SELECT 'detail' AS kind, detailErrorCode AS code, COALESCE(parkName, 'sem parque') AS park, COUNT(*) AS n
        FROM multipark_bookings WHERE detailErrorCode IS NOT NULL
        GROUP BY detailErrorCode, COALESCE(parkName, 'sem parque')
      UNION ALL
      SELECT 'history' AS kind, historyErrorCode AS code, COALESCE(parkName, 'sem parque') AS park, COUNT(*) AS n
        FROM multipark_bookings WHERE historyErrorCode IS NOT NULL
        GROUP BY historyErrorCode, COALESCE(parkName, 'sem parque')
    ) t ORDER BY n DESC LIMIT 100`))
    .map((r) => ({ kind: r.kind === "history" ? "history" as const : "detail" as const, code: String(r.code), park: String(r.park), n: Number(r.n) }));

  const [lastRun] = rowsOf(await db.execute(sql`SELECT status, meta, DATE_FORMAT(startedAt, '%Y-%m-%d %H:%i:%s') AS startedAt
    FROM multipark_sync_logs WHERE syncType = 'api_sync_recent' ORDER BY startedAt DESC LIMIT 1`));
  let lastRecentRun: SyncHealth["lastRecentRun"] = null;
  if (lastRun) {
    let meta: any = {};
    try { meta = lastRun.meta ? JSON.parse(String(lastRun.meta)) : {}; } catch { meta = {}; }
    const ids: string[] = Array.isArray(meta.parkErrors) ? meta.parkErrors.map(String) : [];
    lastRecentRun = {
      at: mysqlToMs(lastRun.startedAt), status: String(lastRun.status),
      parkErrors: ids.map((id) => ({ id, label: parkLabel(id) })),
      skippedJobs: Number(meta.skippedJobs ?? 0),
      totalMismatches: Array.isArray(meta.totalMismatches) ? meta.totalMismatches.length : 0,
    };
  }

  const coverage = rowsOf(await db.execute(sql`SELECT parkId, DATE_FORMAT(recentCoveredAt, '%Y-%m-%d %H:%i:%s') AS recentCoveredAt,
      lastStatus, lastErrorCode FROM multipark_sync_coverage ORDER BY parkId`))
    .map((r) => ({ parkId: String(r.parkId), label: parkLabel(String(r.parkId)), recentCoveredAt: mysqlToMs(r.recentCoveredAt),
      lastStatus: r.lastStatus ?? null, lastErrorCode: r.lastErrorCode ?? null }));

  const reconRows = rowsOf(await db.execute(sql`SELECT day, parkId, actionType, apiTotal, apiCount, dbFound, missing, status, errorCode
    FROM multipark_reconciliation WHERE day >= DATE_FORMAT(DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY), '%Y-%m-%d') AND status <> 'ok'
    ORDER BY day DESC, missing DESC LIMIT 100`))
    .map((r) => ({ day: String(r.day), parkId: String(r.parkId), label: parkLabel(String(r.parkId)), actionType: String(r.actionType),
      apiTotal: r.apiTotal == null ? null : Number(r.apiTotal), apiCount: Number(r.apiCount), dbFound: Number(r.dbFound),
      missing: Number(r.missing), status: String(r.status), errorCode: r.errorCode ?? null }));
  const [reconLast] = rowsOf(await db.execute(sql`SELECT DATE_FORMAT(MAX(checkedAt), '%Y-%m-%d %H:%i:%s') AS at FROM multipark_reconciliation`));

  const alerts = rowsOf(await db.execute(sql`SELECT alertKey, active, DATE_FORMAT(since, '%Y-%m-%d %H:%i:%s') AS since, detail FROM multipark_sync_alerts`))
    .map((r) => ({ key: String(r.alertKey), active: Number(r.active) === 1, since: mysqlToMs(r.since), detail: r.detail ?? null }));

  const recentOk = mysqlToMs(await getLastSyncSuccessAt("api_sync_recent")) ?? mysqlToMs(await getLastSyncSuccessAt("api_sync"));
  const futureOk = mysqlToMs(await getLastSyncSuccessAt("api_sync_future"));

  return {
    now: Date.now(),
    lastWebhookAt: mysqlToMs(q?.lastWebhookAt),
    lastRecentOkAt: recentOk,
    lastFutureOkAt: futureOk,
    lastRecentRun,
    queue: { pending: Number(q?.pending ?? 0), processing: Number(q?.processing ?? 0), failed: Number(q?.failed ?? 0),
      dead: Number(q?.dead ?? 0), oldestOpenAt: mysqlToMs(q?.oldestOpenAt) },
    queueErrors,
    bookingErrors,
    coverage,
    reconciliation: { lastCheckedAt: mysqlToMs(reconLast?.at), rows: reconRows, driftThreshold: RECONCILIATION_DRIFT_THRESHOLD },
    alerts,
    webhookStaleHours: await webhookStaleHours(),
    operatingHours: { start: WEBHOOK_ALERT_START_HOUR, end: WEBHOOK_ALERT_END_HOUR },
    lock: await currentSyncLock(),
  };
}

// ─── Alertas com estado ──────────────────────────────────────────────────────

/** Muda o estado do alerta; true só para quem fez a transição (UPDATE
 *  condicional — duas corridas em paralelo não avisam duas vezes). */
export async function transitionAlert(key: string, active: boolean, detail: string | null): Promise<boolean> {
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

/** Notificação in-app a admin/super_admin ativos. */
export async function notifyAdmins(title: string, body: string, link = "/multipark/sync"): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const { createNotification } = await import("./complaintsExtended");
  const admins = rowsOf(await db.execute(sql`SELECT id FROM users WHERE role IN ('admin', 'super_admin') AND isActive = 1`));
  let sent = 0;
  for (const a of admins) {
    try { await createNotification({ userId: Number(a.id), title, body, kind: "sync", link }); sent++; } catch { /* segue */ }
  }
  return sent;
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
      notified = await notifyAdmins("Sem notificações Multipark", `Não chega nenhum webhook da Multipark há mais de ${staleHours} h, em horário de operação. O sync de hora a hora continua a cobrir as reservas; verificar as Conexões na plataforma.`);
    }
  } else if (decision.transition === "clear") {
    if (await transitionAlert(WEBHOOK_ALERT_KEY, false, null)) {
      notified = await notifyAdmins("Notificações Multipark retomadas", "Voltaram a chegar webhooks da Multipark.");
    }
  }
  return { checked: true as const, ...decision, lastWebhookAt, staleHours, notified };
}
