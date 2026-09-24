/**
 * API keys (X-API-Key) — autenticação, scopes e auditoria partilhados por
 * /api/external (dispositivos) e /api/v1 (MCP).
 *
 * Armazenamento (migração 0095): nunca em claro. Guarda-se o SHA-256 (hex) da
 * chave em `keyHash` (índice UNIQUE → lookup direto) e os 9 primeiros
 * caracteres em `keyPrefix` (ex. "mp_ab12cd") para a UI reconhecer a chave. A
 * chave completa só é mostrada UMA vez, na criação. `expiresAt` opcional.
 *
 * Scopes (`permissions`, JSON ou lista separada por vírgulas):
 *   - read   → leituras (GET)
 *   - write  → leituras + escritas operacionais (POST/PATCH, syncs)
 *   - admin  → tudo, incluindo destrutivo e /admin/*   (admin ⊃ write ⊃ read)
 *   - device → dispositivos (GPS/rádio): SÓ /api/external (GET + POST);
 *              nenhuma rota da /api/v1. Chaves antigas sem `permissions`
 *              contam como `device` — era o que já faziam, continuam a fazer.
 */
import { createHash, randomBytes } from "crypto";
import type { NextFunction, Request, Response } from "express";

export type Scope = "read" | "write" | "admin" | "device";

export const API_KEY_PREFIX_LEN = 9;
export const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

// ─── Chave, hash e prefixo ────────────────────────────────────────────────────

/** Nova chave: "mp_" + 32 caracteres base64url (192 bits de entropia). */
export function generateApiKey(): string {
  return `mp_${randomBytes(24).toString("base64url")}`;
}

/** SHA-256 hex (minúsculas) — igual ao SHA2(x, 256) do MySQL usado no backfill. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function apiKeyPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX_LEN);
}

// ─── Scopes ───────────────────────────────────────────────────────────────────

export function scopesFor(permissions: string | null | undefined): Set<Scope> {
  const s = new Set<Scope>();
  const raw = String(permissions ?? "").trim();
  let parts: string[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      parts = Array.isArray(parsed) ? parsed.map(String) : String(parsed).split(/[,\s]+/);
    } catch {
      parts = raw.split(/[,\s]+/);
    }
  }
  const set = new Set(parts.map(p => p.trim().toLowerCase()).filter(Boolean));
  // Legado: chave sem permissions (ou "[]") = chave de dispositivo.
  if (set.size === 0) { s.add("device"); return s; }
  if (set.has("*") || set.has("admin") || set.has("full")) { s.add("read"); s.add("write"); s.add("admin"); }
  if (set.has("write")) { s.add("read"); s.add("write"); }
  if (set.has("read")) s.add("read");
  if (set.has("device")) s.add("device");
  return s;
}

/** Scope exigido por um pedido à /api/external: GET/HEAD → read; resto → write; /admin/* → admin. */
export function externalRequiredScope(method: string, path: string): Scope {
  if (/^\/admin(\/|$)/.test(path)) return "admin";
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? "read" : "write";
}

/** Pode esta chave fazer este pedido à /api/external? (device cobre read/write, nunca admin) */
export function externalAllowed(scopes: Set<Scope>, method: string, path: string): boolean {
  const need = externalRequiredScope(method, path);
  if (scopes.has(need)) return true;
  return need !== "admin" && scopes.has("device");
}

/** /api/v1: device não conta; cada rota declara o scope que exige. */
export function v1Allowed(scopes: Set<Scope>, need: Exclude<Scope, "device">): boolean {
  return scopes.has(need);
}

// ─── Estado da chave ──────────────────────────────────────────────────────────

const toMs = (v: string | Date | null | undefined): number | null => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.getTime();
  // Timestamps da BD vêm como "YYYY-MM-DD HH:MM:SS" em UTC.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export function isApiKeyExpired(expiresAt: string | Date | null | undefined, now = Date.now()): boolean {
  const t = toMs(expiresAt);
  return t != null && t <= now;
}

/** `lastUsedAt` só é gravado de 5 em 5 minutos (evita um UPDATE por pedido). */
export function shouldTouchLastUsed(lastUsedAt: string | Date | null | undefined, now = Date.now()): boolean {
  const t = toMs(lastUsedAt);
  return t == null || now - t >= LAST_USED_THROTTLE_MS;
}

export interface ApiKeyRow {
  id: number;
  name: string;
  keyPrefix: string | null;
  permissions: string | null;
  active: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdById: number | null;
}

export type ApiKeyCheck =
  | { ok: true; key: ApiKeyRow }
  | { ok: false; status: 401 | 403; error: string };

/** Valida a chave apresentada; `lookupByHash` devolve a linha com esse keyHash (ou null). */
export async function checkPresentedKey(
  presented: string | undefined | null,
  lookupByHash: (hash: string) => Promise<ApiKeyRow | null>,
  now = Date.now(),
): Promise<ApiKeyCheck> {
  const key = String(presented ?? "").trim();
  if (!key) return { ok: false, status: 401, error: "Missing X-API-Key header" };
  if (key.length > 200) return { ok: false, status: 403, error: "Invalid or inactive API key" };
  const row = await lookupByHash(hashApiKey(key));
  if (!row || !row.active) return { ok: false, status: 403, error: "Invalid or inactive API key" };
  if (isApiKeyExpired(row.expiresAt, now)) return { ok: false, status: 403, error: "API key expired" };
  return { ok: true, key: row };
}

// ─── BD ───────────────────────────────────────────────────────────────────────

async function lookupByHashDb(hash: string): Promise<ApiKeyRow | null> {
  const { getDb } = await import("./db");
  const { apiKeys } = await import("../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const rows = await db
    .select({
      id: apiKeys.id, name: apiKeys.name, keyPrefix: apiKeys.keyPrefix, permissions: apiKeys.permissions,
      active: apiKeys.active, expiresAt: apiKeys.expiresAt, lastUsedAt: apiKeys.lastUsedAt, createdById: apiKeys.createdById,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);
  return (rows[0] as ApiKeyRow | undefined) ?? null;
}

async function touchLastUsed(id: number): Promise<void> {
  const { getDb } = await import("./db");
  const { apiKeys } = await import("../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return;
  await db.update(apiKeys).set({ lastUsedAt: new Date().toISOString().slice(0, 19).replace("T", " ") }).where(eq(apiKeys.id, id));
}

// ─── Middleware ──────────────────────────────────────────────────────────────

export function getApiKeyInfo(req: Request): ApiKeyRow | undefined {
  return (req as any).apiKeyInfo;
}
export function getScopes(req: Request): Set<Scope> {
  return (req as any).scopes ?? new Set<Scope>();
}

/**
 * Autentica o X-API-Key. `surface: "external"` também aplica a matriz de
 * scopes da /api/external (GET=read, escrita=write, /admin=admin; device
 * cobre read+write). Na /api/v1 cada rota usa `requireScope`.
 */
export function apiKeyMiddleware(surface: "external" | "v1") {
  return async (req: Request, res: Response, next: NextFunction) => {
    let check: ApiKeyCheck;
    try {
      check = await checkPresentedKey(req.headers["x-api-key"] as string | undefined, lookupByHashDb);
    } catch (err) {
      console.error("[ApiKey] lookup falhou:", err);
      return res.status(500).json({ error: "Database unavailable" });
    }
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    const key = check.key;
    const scopes = scopesFor(key.permissions);
    (req as any).apiKeyInfo = key;
    (req as any).scopes = scopes;
    if (shouldTouchLastUsed(key.lastUsedAt)) {
      touchLastUsed(key.id).catch((err) => console.warn("[ApiKey] lastUsedAt:", String(err?.message ?? err).slice(0, 120)));
    }
    if (surface === "external" && !externalAllowed(scopes, req.method, req.path)) {
      const need = externalRequiredScope(req.method, req.path);
      return res.status(403).json({ error: `Esta API key não tem o scope '${need}'. Scopes da chave: [${Array.from(scopes).join(", ") || "nenhum"}].` });
    }
    next();
  };
}

export function requireScope(scope: Exclude<Scope, "device">) {
  return (req: Request, res: Response, next: NextFunction) => {
    const scopes = getScopes(req);
    if (!v1Allowed(scopes, scope)) {
      return res.status(403).json({
        error: `Esta API key não tem o scope '${scope}'. Scopes da chave: [${Array.from(scopes).join(", ") || "nenhum"}].`,
      });
    }
    next();
  };
}

// ─── Auditoria ────────────────────────────────────────────────────────────────

/** Etiqueta da chave para os logs: "[API key #3 mp_ab12cd…]". */
export function apiKeyTag(key: Pick<ApiKeyRow, "id" | "keyPrefix"> | undefined | null): string {
  if (!key) return "[API key ?]";
  return `[API key #${key.id}${key.keyPrefix ? ` ${key.keyPrefix}…` : ""}]`;
}

/** Autor do log: quem criou a chave (0 = sistema, quando desconhecido). */
export function apiKeyActorId(key: Pick<ApiKeyRow, "createdById"> | undefined | null): number {
  return key?.createdById ?? 0;
}

/**
 * Regista uma escrita feita por API key: autor = criador da chave, detalhes
 * com a etiqueta da chave. `asKeyEvent` (ações admin/syncs) regista também
 * com entity 'api_key' + entityId = id da chave, para se filtrar tudo o que
 * uma chave fez.
 */
export async function logApiKeyAction(
  req: Request,
  entry: { action: string; entity: string; entityId?: number | null; details?: string; asKeyEvent?: boolean },
): Promise<void> {
  const key = getApiKeyInfo(req);
  const { logActivity } = await import("./db");
  const tag = apiKeyTag(key);
  const details = `${tag} ${entry.details ?? ""}`.trim();
  try {
    if (entry.asKeyEvent) {
      await logActivity({ userId: apiKeyActorId(key), action: entry.action, entity: "api_key", entityId: key?.id ?? null,
        details: `${details} (${entry.entity}${entry.entityId != null ? ` #${entry.entityId}` : ""})` });
    } else {
      await logActivity({ userId: apiKeyActorId(key), action: entry.action, entity: entry.entity, entityId: entry.entityId ?? null, details });
    }
  } catch (err) {
    console.warn("[ApiKey] log falhou:", String((err as any)?.message ?? err).slice(0, 160));
  }
}
