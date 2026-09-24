/**
 * Cache de contexto do Gemini para prefixos (system) longos e estáveis — ex.:
 * o futuro chat público com a base de conhecimento da Multipark. Os tokens
 * lidos da cache custam ~10% do preço normal.
 *
 * O nome da cache é partilhado pelas instâncias via BD (ai_context_caches) e
 * guardado em memória por instância. Se criar falhar (ex.: o prefixo é curto
 * de mais para o mínimo do modelo), a chamada segue SEM cache e não se volta
 * a tentar durante 10 min. Nunca lança.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AiProvider } from "./client";

const mem = new Map<string, { name: string; expiresAt: number }>();
const failedUntil = new Map<string, number>();
const SAFETY_MS = 60_000;
const FAIL_BACKOFF_MS = 10 * 60_000;

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

export function contextCacheKey(provider: string, model: string, system: string): string {
  return createHash("sha256").update(`${provider}\u0000${model}\u0000${system}`).digest("hex");
}

export function resetContextCacheForTests(): void {
  mem.clear();
  failedUntil.clear();
}

export async function getOrCreateContextCache(
  provider: AiProvider,
  model: string,
  system: string,
  opts: { ttlSeconds?: number; signal: AbortSignal; now?: number },
): Promise<string | null> {
  if (!provider.createCache || !system.trim()) return null;
  const now = opts.now ?? Date.now();
  const key = contextCacheKey(provider.id, model, system);
  const hit = mem.get(key);
  if (hit && hit.expiresAt - SAFETY_MS > now) return hit.name;
  if ((failedUntil.get(key) ?? 0) > now) return null;

  let db: any = null;
  try {
    const { getDb } = await import("../../db");
    db = await getDb();
    if (db) {
      const row = rowsOf(await db.execute(sql`
        SELECT cacheName, DATE_FORMAT(expiresAt, '%Y-%m-%dT%H:%i:%sZ') AS exp
          FROM ai_context_caches WHERE cacheKey = ${key} LIMIT 1`))[0];
      const exp = row?.exp ? Date.parse(String(row.exp)) : NaN;
      if (row?.cacheName && Number.isFinite(exp) && exp - SAFETY_MS > now) {
        mem.set(key, { name: String(row.cacheName), expiresAt: exp });
        return String(row.cacheName);
      }
    }
  } catch { /* BD opcional */ }

  try {
    const ttl = Math.max(300, Math.min(24 * 3600, opts.ttlSeconds ?? 3600));
    const c = await provider.createCache({ model, system, ttlSeconds: ttl, signal: opts.signal });
    mem.set(key, c);
    if (db) {
      const exp = new Date(c.expiresAt).toISOString().slice(0, 19).replace("T", " ");
      await db.execute(sql`
        INSERT INTO ai_context_caches (cacheKey, provider, model, cacheName, expiresAt)
        VALUES (${key}, ${provider.id}, ${model.slice(0, 80)}, ${c.name.slice(0, 255)}, ${exp})
        ON DUPLICATE KEY UPDATE cacheName = VALUES(cacheName), model = VALUES(model), expiresAt = VALUES(expiresAt)`).catch(() => undefined);
    }
    return c.name;
  } catch (err: any) {
    failedUntil.set(key, now + FAIL_BACKOFF_MS);
    console.warn("[ai] cache de contexto indisponível:", String(err?.status ?? err?.name ?? "erro"));
    return null;
  }
}

/** Esquece uma cache (ex.: o fornecedor diz que expirou). */
export function forgetContextCache(name: string): void {
  for (const [k, v] of mem) if (v.name === name) mem.delete(k);
}
