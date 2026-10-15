/**
 * Cache de contexto do Gemini para prefixos (system) longos e estáveis — ex.:
 * o futuro chat público com a base de conhecimento da Multipark. Os tokens
 * lidos da cache custam ~10% do preço normal.
 *
 * O nome da cache é partilhado pelas instâncias via BD (ai_context_caches) e
 * guardado em memória por instância. Se criar falhar (ex.: o prefixo é curto
 * de mais para o mínimo do modelo), a chamada segue SEM cache e não se volta
 * a tentar durante 10 min. Nunca lança.
 *
 * Armazenamento (plano MPV §5.3, F0b): cada cache CRIADA fica registada em
 * ai_usage_log com `feature` = a funcionalidade dona (quem a criou, ex.:
 * assistant_smart) e `entity` = "context_cache_storage" — entra assim no teto
 * dessa funcionalidade. Custo = tokens guardados × TTL × preço de
 * armazenamento (pricing.ts, estimativa). Tokens: os da API
 * (usageMetadata.totalTokenCount); sem eles, estimados (≈ 4 caracteres por
 * token). Modelo sem preço de armazenamento → regista só os tokens (custo 0).
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AiProvider, AiToolDeclaration } from "./client";
import { cacheStorageCostEur } from "./pricing";
import { logAiUsage } from "./usage";

/** Quem cria a cache (para o registo do armazenamento). */
export interface ContextCacheOwner {
  feature: string;
  tier: string;
  variant?: string | null;
}

/** Entidade das linhas do armazenamento da cache no registo de uso. */
export const CONTEXT_CACHE_STORAGE_ENTITY = "context_cache_storage";

/**
 * Modelos SEM cache explícita (docs da Google, out 2026: o Gemini 4 Argon só
 * tem cache implícita, para prefixos iguais de ≥ 4 096 tokens — o guia do
 * modelo fala em 6 144). Nesses não se tenta criar a cache: o desconto da
 * implícita vem sozinho no usageMetadata (cachedTokens). PURA.
 */
export function supportsExplicitCache(model: string): boolean {
  return !/^gemini-4-argon/.test(model);
}

/** Tokens de um prefixo quando a API não os dá (≈ 4 car./token). PURA. */
export function estimateCacheTokens(system: string, tools?: AiToolDeclaration[]): number {
  const t = tools?.length ? JSON.stringify(tools).length : 0;
  return Math.ceil((system.length + t) / 4);
}

const mem = new Map<string, { name: string; expiresAt: number }>();
const failedUntil = new Map<string, number>();
const SAFETY_MS = 60_000;
const FAIL_BACKOFF_MS = 10 * 60_000;

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

export function contextCacheKey(provider: string, model: string, system: string, tools?: AiToolDeclaration[]): string {
  const t = tools?.length ? `\u0000${JSON.stringify(tools)}` : "";
  return createHash("sha256").update(`${provider}\u0000${model}\u0000${system}${t}`).digest("hex");
}

export function resetContextCacheForTests(): void {
  mem.clear();
  failedUntil.clear();
}

export async function getOrCreateContextCache(
  provider: AiProvider,
  model: string,
  system: string,
  opts: { ttlSeconds?: number; signal: AbortSignal; now?: number; tools?: AiToolDeclaration[]; owner?: ContextCacheOwner },
): Promise<string | null> {
  if (!provider.createCache || !system.trim() || !supportsExplicitCache(model)) return null;
  const now = opts.now ?? Date.now();
  // As ferramentas vão DENTRO da cache (a API recusa-as ao lado dela): cada
  // conjunto de ferramentas tem a sua cache.
  const key = contextCacheKey(provider.id, model, system, opts.tools);
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
    const c = await provider.createCache({ model, system, ...(opts.tools?.length ? { tools: opts.tools } : {}), ttlSeconds: ttl, signal: opts.signal });
    mem.set(key, { name: c.name, expiresAt: c.expiresAt });
    if (opts.owner) {
      const tokens = c.tokens ?? estimateCacheTokens(system, opts.tools);
      const cost = cacheStorageCostEur(model, tokens, ttl);
      await logAiUsage({
        feature: opts.owner.feature, tier: opts.owner.tier, provider: provider.id, model,
        userId: null, entity: CONTEXT_CACHE_STORAGE_ENTITY, entityId: null,
        inputTokens: 0, outputTokens: 0, cachedTokens: tokens, costEur: cost ?? 0, latencyMs: 0,
        status: "ok", errorCode: c.tokens == null ? "tokens_estimated" : null,
        variant: opts.owner.variant ?? null,
      });
    }
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
