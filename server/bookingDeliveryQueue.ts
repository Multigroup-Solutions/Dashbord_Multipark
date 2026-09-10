import crypto from "node:crypto";
import type { MultiparkWebhookEvent } from "./multiparkWebhook";

export type DeliveryJob = { event: MultiparkWebhookEvent; token: string; attempts: number };
export interface DeliveryStore {
  receive(event: MultiparkWebhookEvent): Promise<void>;
  claim(): Promise<DeliveryJob | null>;
  complete(job: DeliveryJob): Promise<boolean>;
  retry(job: DeliveryJob, errorCode: string, delaySeconds: number): Promise<void>;
}

export function retryDelaySeconds(attempts: number): number {
  return Math.min(3600, 30 * 2 ** Math.min(7, Math.max(0, attempts - 1)));
}

// Apenas códigos; erros HTTP/SQL podem conter dados pessoais ou credenciais.
export function deliveryErrorCode(error: unknown): string {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) return `API_HTTP_${status}`;
  const code = (error as { code?: unknown })?.code ?? (error as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "PROCESSING_FAILED";
}

/** A receção e o processamento são independentes. A lease expira após crash;
 * o token impede que um trabalhador antigo conclua o trabalho de outro. */
export async function drainDeliveries(
  store: DeliveryStore,
  process: (event: MultiparkWebhookEvent) => Promise<{ ok: boolean; detail: string }>,
  opts: { limit?: number; deadlineAt?: number } = {},
) {
  const result = { completed: 0, failed: 0, lostLease: 0 };
  for (let i = 0; i < (opts.limit ?? 10); i++) {
    if (Date.now() >= (opts.deadlineAt ?? Infinity)) break;
    const job = await store.claim();
    if (!job) break;
    try {
      const r = await process(job.event);
      if (!r.ok) throw Object.assign(new Error("Reserva ainda não atualizada"), { code: "DETAIL_INCOMPLETE" });
      if (await store.complete(job)) result.completed++;
      else result.lostLease++;
    } catch (error) {
      await store.retry(job, deliveryErrorCode(error), retryDelaySeconds(job.attempts));
      result.failed++;
    }
  }
  return result;
}

export async function createDeliveryStore(): Promise<DeliveryStore> {
  const { getDb } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) throw Object.assign(new Error("Base de dados indisponível"), { code: "DATABASE_UNAVAILABLE" });
  const rows = (r: any): any[] => Array.isArray(r?.[0]) ? r[0] : [];
  const changed = (r: any) => Number(r?.[0]?.affectedRows ?? 0) > 0;
  return {
    async receive(event) {
      // Repetir a mesma entrega não reabre as concluídas nem apaga tentativas.
      await db.execute(sql`INSERT INTO multipark_webhook_jobs (deliveryId, bookingExternalId, payload, receivedAt, nextAttemptAt)
        VALUES (${event.deliveryId}, ${event.bookingId}, ${JSON.stringify(event)}, UTC_TIMESTAMP(), UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE deliveryId = deliveryId`);
    },
    async claim() {
      const token = crypto.randomUUID();
      // UPDATE atómico: duas instâncias nunca recebem a mesma lease ativa.
      await db.execute(sql`UPDATE multipark_webhook_jobs
        SET state = 'processing', leaseToken = ${token},
            leaseUntil = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE), attempts = attempts + 1
        WHERE (state IN ('pending', 'failed') AND nextAttemptAt <= UTC_TIMESTAMP())
           OR (state = 'processing' AND leaseUntil < UTC_TIMESTAMP())
        ORDER BY nextAttemptAt, receivedAt LIMIT 1`);
      const [row] = rows(await db.execute(sql`SELECT payload, attempts FROM multipark_webhook_jobs
        WHERE leaseToken = ${token} AND state = 'processing' LIMIT 1`));
      if (!row) return null;
      return { event: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload, token, attempts: row.attempts };
    },
    async complete(job) {
      return changed(await db.execute(sql`UPDATE multipark_webhook_jobs
        SET state = 'completed', completedAt = UTC_TIMESTAMP(), leaseToken = NULL, leaseUntil = NULL, errorCode = NULL
        WHERE deliveryId = ${job.event.deliveryId} AND leaseToken = ${job.token} AND state = 'processing'`));
    },
    async retry(job, code, delay) {
      await db.execute(sql`UPDATE multipark_webhook_jobs
        SET state = 'failed', errorCode = ${code}, nextAttemptAt = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${delay} SECOND),
            leaseToken = NULL, leaseUntil = NULL
        WHERE deliveryId = ${job.event.deliveryId} AND leaseToken = ${job.token} AND state = 'processing'`);
    },
  };
}

/** Só totais operacionais: não devolve o payload nem dados de clientes. */
export async function getDeliveryHealth() {
  const { getDb } = await import('./db');
  const { sql } = await import('drizzle-orm');
  const db = await getDb();
  if (!db) throw new Error('Base de dados indisponível');
  const result = await db.execute(sql`SELECT
    COALESCE(SUM(state = 'pending'), 0) AS pending,
    COALESCE(SUM(state = 'processing'), 0) AS processing,
    COALESCE(SUM(state = 'failed'), 0) AS failed,
    MAX(completedAt) AS lastCompletedAt
    FROM multipark_webhook_jobs`);
  const row = (result as any)[0]?.[0];
  const detailResult = await db.execute(sql`SELECT
    COALESCE(SUM(detailErrorCode IS NOT NULL), 0) AS failures,
    COALESCE(SUM(historyErrorCode IS NOT NULL), 0) AS historyFailures FROM multipark_bookings`);
  return { pending: Number(row?.pending ?? 0), processing: Number(row?.processing ?? 0),
    failed: Number(row?.failed ?? 0), detailFailures: Number((detailResult as any)[0]?.[0]?.failures ?? 0),
    historyFailures: Number((detailResult as any)[0]?.[0]?.historyFailures ?? 0),
    lastCompletedAt: row?.lastCompletedAt ? String(row.lastCompletedAt) : null };
}
