/**
 * Trinco da sincronização Multipark (tabela multipark_sync_lock, migração
 * 0101). Partilhado pelo cron (recente/futuro), pelo botão "Reparar período"
 * e pelas rotas MCP /sync/*: duas corridas em paralelo martelavam a API e a
 * pool de ligações da be-multipark (P2024).
 *
 * Lease numa linha em vez de GET_LOCK: o GET_LOCK pertence à ligação e numa
 * pool (serverless) o RELEASE pode sair por outra ligação — o trinco ficava
 * preso até a ligação morrer. A lease expira sozinha (> maxDuration de 60s),
 * por isso uma função morta a meio não bloqueia o ciclo seguinte.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "./db";

export const SYNC_LOCK_NAME = "multipark_sync";
/** Mais do que o maxDuration (60s) do Vercel: nunca expira a meio de uma corrida viva. */
export const SYNC_LOCK_LEASE_SECONDS = 75;
export const SYNC_BUSY_MESSAGE = "Sincronização já a correr — tenta daqui a um minuto.";

export type SyncLockOwner = "cron_recent" | "cron_future" | "manual" | "mcp_recent" | "mcp_future" | "mcp_day";

const affected = (r: unknown): number => Number((r as any)?.[0]?.affectedRows ?? (r as any)?.affectedRows ?? 0);

/** Tenta ficar com o trinco. `null` = ocupado. Sem BD → corre sem trinco. */
export async function acquireSyncLock(owner: SyncLockOwner, leaseSeconds = SYNC_LOCK_LEASE_SECONDS): Promise<{ token: string | null } | null> {
  const db = await getDb();
  if (!db) return { token: null };
  const token = crypto.randomUUID();
  await db.execute(sql`INSERT IGNORE INTO multipark_sync_lock (name, holder, leaseUntil) VALUES (${SYNC_LOCK_NAME}, NULL, NULL)`);
  const r = await db.execute(sql`UPDATE multipark_sync_lock
    SET holder = ${token}, owner = ${owner}, acquiredAt = UTC_TIMESTAMP(),
        leaseUntil = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${leaseSeconds} SECOND)
    WHERE name = ${SYNC_LOCK_NAME} AND (holder IS NULL OR leaseUntil IS NULL OR leaseUntil < UTC_TIMESTAMP())`);
  return affected(r) === 1 ? { token } : null;
}

export async function releaseSyncLock(token: string | null): Promise<void> {
  if (!token) return;
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`UPDATE multipark_sync_lock SET holder = NULL, leaseUntil = NULL
    WHERE name = ${SYNC_LOCK_NAME} AND holder = ${token}`);
}

/** Quem tem o trinco agora (para o painel). */
export async function currentSyncLock(): Promise<{ owner: string | null; acquiredAt: string | null } | null> {
  const db = await getDb();
  if (!db) return null;
  const res = await db.execute(sql`SELECT owner, DATE_FORMAT(acquiredAt, '%Y-%m-%d %H:%i:%s') AS acquiredAt FROM multipark_sync_lock
    WHERE name = ${SYNC_LOCK_NAME} AND holder IS NOT NULL AND leaseUntil >= UTC_TIMESTAMP() LIMIT 1`);
  const row = ((res as any)?.[0] ?? [])[0];
  return row ? { owner: row.owner ?? null, acquiredAt: row.acquiredAt ?? null } : null;
}

/** Corre `fn` com o trinco; ocupado → `{ busy: true }` sem correr nada. */
export async function withSyncLock<T>(owner: SyncLockOwner, fn: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
  const lock = await acquireSyncLock(owner);
  if (!lock) return { busy: true };
  try {
    return { busy: false, value: await fn() };
  } finally {
    try { await releaseSyncLock(lock.token); } catch (err) {
      // A lease expira sozinha; só fica registado.
      console.warn("[SyncLock] libertar falhou:", (err as any)?.code ?? (err as any)?.cause?.code ?? "ERR");
    }
  }
}
