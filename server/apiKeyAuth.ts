/**
 * API keys (X-API-Key) — autenticação, capacidades e auditoria partilhados por
 * /api/external (dispositivos) e /api/v1 (MCP, site, relatórios).
 *
 * Armazenamento (migração 0095): nunca em claro. Guarda-se o SHA-256 (hex) da
 * chave em `keyHash` (índice UNIQUE → lookup direto) e os 9 primeiros
 * caracteres em `keyPrefix` (ex. "mp_ab12cd") para a UI reconhecer a chave. A
 * chave completa só é mostrada UMA vez, na criação. `expiresAt` opcional.
 * Revogada (0405) = nunca mais funciona.
 *
 * Capacidades (P3 lote 20a, shared/apiKeyCapabilities.ts): cada rota exige uma
 * (ou uma de várias) — formulários do site, relatórios de operação, caixa,
 * marketing, dados pessoais, reclamações (escrever), dispositivo, admin.
 * As chaves antigas (read/write/admin/device/vazio) são lidas como o conjunto
 * equivalente: continuam a fazer exatamente o que faziam.
 */
import { createHash, randomBytes } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { capabilitiesFor, type ApiKeyCapability } from "../shared/apiKeyCapabilities";

export type { ApiKeyCapability } from "../shared/apiKeyCapabilities";

export const API_KEY_PREFIX_LEN = 9;
export const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;
/** Pedidos por minuto por chave (por instância). Acima disto: 429. */
export const API_KEY_RATE_PER_MIN = 240;

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

// ─── Capacidades por rota ─────────────────────────────────────────────────────

/**
 * /api/external: o que cada pedido exige (basta UMA das capacidades).
 * Mantém o que as chaves antigas faziam: leitura (GET) com "read", tudo menos
 * /admin com "device" ou "write", importação do Gmail com "write"/"device".
 */
export function externalRequiredCaps(method: string, path: string): ApiKeyCapability[] | "any" {
  if (/^\/admin(\/|$)/.test(path)) return ["admin"];
  const m = method.toUpperCase();
  const read = m === "GET" || m === "HEAD" || m === "OPTIONS";
  if (read) {
    if (path === "/docs") return "any";
    if (path === "/employees") return ["pii", "device"];
    return ["reports:ops", "device"];
  }
  if (path === "/gmail-import") return ["complaints:write", "device"];
  return ["device"];
}

/** Pode esta chave fazer este pedido à /api/external? */
export function externalAllowed(caps: Set<ApiKeyCapability>, method: string, path: string): boolean {
  const need = externalRequiredCaps(method, path);
  if (need === "any") return caps.size > 0;
  return need.some((c) => caps.has(c));
}

/** /api/v1: basta uma das capacidades pedidas; "device" nunca abre nada aqui. */
export function v1Allowed(caps: Set<ApiKeyCapability>, anyOf: readonly ApiKeyCapability[]): boolean {
  return anyOf.some((c) => c !== "device" && caps.has(c));
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
  revokedAt?: string | null;
  /** D53: quem a criou continua ativo (conta junta → a conta que ficou). `false` = a chave não funciona. */
  creatorActive?: boolean;
}

export type ApiKeyCheck =
  | { ok: true; key: ApiKeyRow }
  | { ok: false; status: 401 | 403; error: string };

/** A mesma resposta para chave errada, inativa, revogada ou expirada (não revela qual). */
export const INVALID_KEY_ERROR = "Invalid or inactive API key";

/** Valida a chave apresentada; `lookupByHash` devolve a linha com esse keyHash (ou null). */
export async function checkPresentedKey(
  presented: string | undefined | null,
  lookupByHash: (hash: string) => Promise<ApiKeyRow | null>,
  now = Date.now(),
): Promise<ApiKeyCheck> {
  const key = String(presented ?? "").trim();
  if (!key) return { ok: false, status: 401, error: "Missing X-API-Key header" };
  if (key.length > 200) return { ok: false, status: 403, error: INVALID_KEY_ERROR };
  const row = await lookupByHash(hashApiKey(key));
  if (!row || !row.active || row.revokedAt) return { ok: false, status: 403, error: INVALID_KEY_ERROR };
  if (isApiKeyExpired(row.expiresAt, now)) return { ok: false, status: 403, error: INVALID_KEY_ERROR };
  // D53 (Jorge, 3 out 2026): a chave de quem ficou inativo deixa de funcionar.
  if (row.creatorActive === false) return { ok: false, status: 403, error: INVALID_KEY_ERROR };
  return { ok: true, key: row };
}

export interface ApiKeyCreatorRow { isActive: unknown; loginMethod?: string | null }

/**
 * D53: quem criou a chave continua ativo? Uma conta junta a outra fica
 * desativada com `merged_into_<id>` — aí conta a conta que ficou (a chave
 * não morre por se juntarem as contas). Conta que não existe = inativa.
 */
export async function creatorStillActive(createdById: number, load: (id: number) => Promise<ApiKeyCreatorRow | null>): Promise<boolean> {
  let id = createdById;
  const seen = new Set<number>();
  while (!seen.has(id) && seen.size < 5) {
    seen.add(id);
    const u = await load(id);
    if (!u) return false;
    if (u.isActive === true || Number(u.isActive) === 1) return true;
    const m = /^merged_into_(\d+)$/.exec(String(u.loginMethod ?? ""));
    if (!m) return false;
    id = Number(m[1]);
  }
  return false;
}

/** Leitor de contas para `creatorStillActive` (BD). */
export async function loadApiKeyCreator(id: number): Promise<ApiKeyCreatorRow | null> {
  const { getDb } = await import("./db");
  const { users } = await import("../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [u] = await db.select({ isActive: users.isActive, loginMethod: users.loginMethod }).from(users).where(eq(users.id, id)).limit(1);
  return u ?? null;
}

// ─── Limite por chave ─────────────────────────────────────────────────────────

const rateBuckets = new Map<number, { start: number; count: number }>();

/** Janela fixa de 1 minuto por chave. Devolve os segundos a esperar (0 = pode). */
export function apiKeyRateWait(keyId: number, now = Date.now(), limit = API_KEY_RATE_PER_MIN): number {
  const b = rateBuckets.get(keyId);
  if (!b || now - b.start >= 60_000) {
    rateBuckets.set(keyId, { start: now, count: 1 });
    if (rateBuckets.size > 5000) rateBuckets.clear();
    return 0;
  }
  b.count += 1;
  return b.count > limit ? Math.max(1, Math.ceil((b.start + 60_000 - now) / 1000)) : 0;
}

// ─── Erros sem fuga ───────────────────────────────────────────────────────────

/**
 * Erro interno para quem chama a API: mensagem genérica + referência; o
 * detalhe (mensagem, SQL, stack) fica só nos logs do servidor.
 */
export function apiInternalError(res: Response, where: string, err: unknown, extra: Record<string, unknown> = {}): void {
  const ref = randomBytes(4).toString("hex");
  console.error(`[API ${where}] ref=${ref}`, err);
  if (!res.headersSent) res.status(500).json({ ...extra, error: `Erro interno (ref ${ref})`, ref });
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
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);
  const row = (rows[0] as ApiKeyRow | undefined) ?? null;
  // Chaves antigas sem autor (createdById vazio) continuam como estavam.
  if (row && row.active && !row.revokedAt && row.createdById != null) row.creatorActive = await creatorStillActive(row.createdById, loadApiKeyCreator);
  return row;
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
export function getCapabilities(req: Request): Set<ApiKeyCapability> {
  return (req as any).apiKeyCaps ?? new Set<ApiKeyCapability>();
}

const missingCap = (need: readonly ApiKeyCapability[]) =>
  `Esta API key não tem a capacidade necessária (${need.join(" ou ")}).`;

/**
 * Autentica o X-API-Key, aplica o limite por chave e, na /api/external, a
 * capacidade exigida pelo pedido. Na /api/v1 cada rota usa `requireCapability`.
 */
export function apiKeyMiddleware(surface: "external" | "v1") {
  return async (req: Request, res: Response, next: NextFunction) => {
    let check: ApiKeyCheck;
    try {
      check = await checkPresentedKey(req.headers["x-api-key"] as string | undefined, lookupByHashDb);
    } catch (err) {
      console.error("[ApiKey] lookup falhou:", err);
      return res.status(503).json({ error: "Serviço indisponível. Tenta daqui a pouco." });
    }
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    const key = check.key;
    const wait = apiKeyRateWait(key.id);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      return res.status(429).json({ error: `Demasiados pedidos com esta API key. Tenta daqui a ${wait} s.` });
    }
    const caps = capabilitiesFor(key.permissions);
    (req as any).apiKeyInfo = key;
    (req as any).apiKeyCaps = caps;
    if (shouldTouchLastUsed(key.lastUsedAt)) {
      touchLastUsed(key.id).catch((err) => console.warn("[ApiKey] lastUsedAt:", String(err?.message ?? err).slice(0, 120)));
    }
    if (surface === "external" && !externalAllowed(caps, req.method, req.path)) {
      const need = externalRequiredCaps(req.method, req.path);
      return res.status(403).json({ error: missingCap(need === "any" ? [] : need) });
    }
    next();
  };
}

/** /api/v1: a rota exige UMA destas capacidades ("admin" abre tudo). */
export function requireCapability(...anyOf: Exclude<ApiKeyCapability, "device">[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!v1Allowed(getCapabilities(req), anyOf)) return res.status(403).json({ error: missingCap(anyOf) });
    next();
  };
}

/** /api/v1 sem rota específica (índice): qualquer capacidade da v1 (dispositivo não conta). */
export function requireAnyV1Capability() {
  return (req: Request, res: Response, next: NextFunction) => {
    const caps = getCapabilities(req);
    if (!Array.from(caps).some((c) => c !== "device")) return res.status(403).json({ error: "Esta API key não tem acesso à /api/v1." });
    next();
  };
}

// ─── Auditoria ────────────────────────────────────────────────────────────────

/** Etiqueta da chave para os logs: "[API key #3 «Site» mp_ab12cd…]". */
export function apiKeyTag(key: Pick<ApiKeyRow, "id" | "keyPrefix"> & { name?: string | null } | undefined | null): string {
  if (!key) return "[API key ?]";
  const name = key.name ? ` «${String(key.name).slice(0, 60)}»` : "";
  return `[API key #${key.id}${name}${key.keyPrefix ? ` ${key.keyPrefix}…` : ""}]`;
}

/**
 * Autor do que uma chave faz: 0 (sistema/integração) — nunca a pessoa que a
 * criou (antes as escritas da chave apareciam como feitas por essa pessoa).
 * A chave fica identificada na etiqueta dos detalhes.
 */
export function apiKeyActorId(_key?: unknown): number {
  return 0;
}

/**
 * Regista uma escrita feita por API key: autor = 0 (integração), detalhes com
 * a etiqueta da chave. `asKeyEvent` (ações admin/syncs) regista com entity
 * 'api_key' + entityId = id da chave, para se filtrar tudo o que uma chave fez.
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
      await logActivity({ userId: apiKeyActorId(key), source: "api_key", action: entry.action, entity: "api_key", entityId: key?.id ?? null,
        details: `${details} (${entry.entity}${entry.entityId != null ? ` #${entry.entityId}` : ""})` });
    } else {
      await logActivity({ userId: apiKeyActorId(key), source: "api_key", action: entry.action, entity: entry.entity, entityId: entry.entityId ?? null, details });
    }
  } catch (err) {
    console.warn("[ApiKey] log falhou:", String((err as any)?.message ?? err).slice(0, 160));
  }
}
