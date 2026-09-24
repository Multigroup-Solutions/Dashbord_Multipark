import crypto from "node:crypto";
import type { MultiparkWebhookEvent } from "./multiparkWebhook";

export type DeliveryJob = { event: MultiparkWebhookEvent; token: string; attempts: number };
export interface DeliveryStore {
  receive(event: MultiparkWebhookEvent): Promise<void>;
  claim(): Promise<DeliveryJob | null>;
  complete(job: DeliveryJob): Promise<boolean>;
  retry(job: DeliveryJob, errorCode: string, delaySeconds: number): Promise<void>;
  /** Dead-letter: sai da fila; fica visível no painel de saúde. */
  dead(job: DeliveryJob, errorCode: string): Promise<void>;
}

export function retryDelaySeconds(attempts: number): number {
  return Math.min(3600, 30 * 2 ** Math.min(7, Math.max(0, attempts - 1)));
}

/** Ao fim de MAX_DELIVERY_ATTEMPTS tentativas o trabalho passa a 'dead'. */
export const MAX_DELIVERY_ATTEMPTS = 10;
/** Erros que nenhuma repetição resolve (falta configurar o parque). */
export const DEAD_LETTER_CODES: ReadonlySet<string> = new Set(["PARK_ACCESS_MISSING", "PARK_NOT_MAPPED"]);

/** Repetir ou mandar para dead-letter? `attempts` já conta a tentativa atual. PURA. */
export function deliveryDisposition(attempts: number, errorCode: string): "retry" | "dead" {
  if (DEAD_LETTER_CODES.has(errorCode)) return "dead";
  return attempts >= MAX_DELIVERY_ATTEMPTS ? "dead" : "retry";
}

const CODE_RE = /^[A-Z0-9_]{1,64}$/;
const codeOf = (v: unknown): string | null => (typeof v === "string" && CODE_RE.test(v) ? v : null);
const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

/**
 * Código estável de um erro, para guardar e agrupar. Apenas códigos: erros
 * HTTP/SQL podem conter dados pessoais ou credenciais, por isso a mensagem
 * NUNCA entra. Ordem: HTTP → timeout → code (próprio ou da causa) → errno /
 * sqlState → nome da classe (TypeError → TYPE_ERROR) → PROCESSING_FAILED.
 */
export function deliveryErrorCode(error: unknown): string {
  const e = (error ?? {}) as Record<string, any>;
  const cause = (e.cause ?? {}) as Record<string, any>;
  const status = e.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return `API_HTTP_${status}`;
  // AbortSignal.timeout() rejeita com DOMException name="TimeoutError".
  if (e.name === "TimeoutError" || cause.name === "TimeoutError") return "TIMEOUT";
  const code = codeOf(e.code) ?? codeOf(cause.code);
  if (code) return code;
  const errno = typeof e.errno === "number" ? e.errno : typeof cause.errno === "number" ? cause.errno : null;
  if (errno != null && Number.isInteger(errno)) return `ERRNO_${Math.abs(errno)}`;
  const sqlState = [e.sqlState, cause.sqlState].find(v => typeof v === "string" && /^[0-9A-Z]{5}$/.test(v));
  if (sqlState) return `SQLSTATE_${sqlState}`;
  if (e.name === "AbortError" || cause.name === "AbortError") return "ABORTED";
  const name = [e.name, cause.name].find(n => typeof n === "string" && /^[A-Za-z]{1,48}Error$/.test(n) && n !== "Error");
  if (name) return snake(name).slice(0, 64);
  return "PROCESSING_FAILED";
}

/** A receção e o processamento são independentes. A lease expira após crash;
 * o token impede que um trabalhador antigo conclua o trabalho de outro. */
export async function drainDeliveries(
  store: DeliveryStore,
  process: (event: MultiparkWebhookEvent) => Promise<{ ok: boolean; detail: string }>,
  opts: { limit?: number; deadlineAt?: number } = {},
) {
  const result = { completed: 0, failed: 0, lostLease: 0, dead: 0 };
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
      const code = deliveryErrorCode(error);
      if (deliveryDisposition(job.attempts, code) === "dead") {
        await store.dead(job, code);
        result.dead++;
      } else {
        await store.retry(job, code, retryDelaySeconds(job.attempts));
        result.failed++;
      }
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
    async dead(job, code) {
      await db.execute(sql`UPDATE multipark_webhook_jobs
        SET state = 'dead', errorCode = ${code}, deadAt = UTC_TIMESTAMP(), leaseToken = NULL, leaseUntil = NULL
        WHERE deliveryId = ${job.event.deliveryId} AND leaseToken = ${job.token} AND state = 'processing'`);
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
    COALESCE(SUM(state = 'dead'), 0) AS dead,
    MAX(completedAt) AS lastCompletedAt
    FROM multipark_webhook_jobs`);
  const row = (result as any)[0]?.[0];
  const detailResult = await db.execute(sql`SELECT
    COALESCE(SUM(detailErrorCode IS NOT NULL AND detailErrorCode <> 'PARK_CLOSED'), 0) AS failures,
    COALESCE(SUM(historyErrorCode IS NOT NULL AND historyErrorCode <> 'PARK_CLOSED'), 0) AS historyFailures FROM multipark_bookings`);
  return { pending: Number(row?.pending ?? 0), processing: Number(row?.processing ?? 0),
    failed: Number(row?.failed ?? 0), dead: Number(row?.dead ?? 0),
    detailFailures: Number((detailResult as any)[0]?.[0]?.failures ?? 0),
    historyFailures: Number((detailResult as any)[0]?.[0]?.historyFailures ?? 0),
    lastCompletedAt: row?.lastCompletedAt ? String(row.lastCompletedAt) : null };
}

/** Limpeza diária: apaga trabalhos concluídos há mais de `days` dias, em
 *  lotes (DELETE … LIMIT, sem subquery) e com prazo. */
export async function purgeCompletedDeliveries(opts: { days?: number; batch?: number; deadlineAt?: number } = {}) {
  const { getDb } = await import('./db');
  const { sql } = await import('drizzle-orm');
  const db = await getDb();
  if (!db) throw new Error('Base de dados indisponível');
  const days = Math.max(1, Math.trunc(opts.days ?? 30));
  const batch = Math.max(100, Math.trunc(opts.batch ?? 5000));
  let deleted = 0, batches = 0, done = false;
  while (Date.now() < (opts.deadlineAt ?? Infinity)) {
    const r = await db.execute(sql`DELETE FROM multipark_webhook_jobs
      WHERE state = 'completed' AND completedAt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${days} DAY) LIMIT ${batch}`);
    const n = Number((r as any)?.[0]?.affectedRows ?? 0);
    deleted += n; batches++;
    if (n < batch) { done = true; break; }
  }
  return { deleted, batches, done };
}
