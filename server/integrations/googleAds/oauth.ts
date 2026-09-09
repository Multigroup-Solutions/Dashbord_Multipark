/**
 * OAuth do Google Ads (servidor): URL de consentimento, troca do código,
 * renovação do access token e guarda CIFRADA do refresh token.
 *
 * Regras (plano, passo 6): estado anti-CSRF de uso único, troca do código no
 * servidor, acesso offline, renovação automática, preservação do refresh
 * token quando a Google não devolve um novo, e deteção de perda de
 * autorização (invalid_grant → reauth_required).
 */
import crypto from "crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { integrationConnections, oauthStates } from "../../../drizzle/schema";
import { decryptSecret, encryptSecret, encryptionKeyInfo } from "./crypto";
import { GOOGLE_ADS_PROVIDER, GOOGLE_ADS_SCOPE, readGoogleAdsConfig, resolveRedirectUri } from "./config";

const nowMysql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

export async function createOAuthState(userId: number, redirectTo?: string | null): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const state = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + 10 * 60_000).toISOString().slice(0, 19).replace("T", " ");
  // limpa estados expirados (best-effort)
  try { await db.delete(oauthStates).where(lt(oauthStates.expiresAt, nowMysql())); } catch { /* ignore */ }
  await db.insert(oauthStates).values({ state, provider: GOOGLE_ADS_PROVIDER, userId, redirectTo: redirectTo ?? null, expiresAt: expires });
  return state;
}

/** Consome o estado (uma vez). Devolve o userId ou null se inválido/expirado. */
export async function consumeOAuthState(state: string): Promise<{ userId: number; redirectTo: string | null } | null> {
  const db = await getDb();
  if (!db || !state) return null;
  const rows = await db.select().from(oauthStates).where(and(eq(oauthStates.state, state), eq(oauthStates.provider, GOOGLE_ADS_PROVIDER))).limit(1);
  const row = rows[0];
  if (!row) return null;
  await db.delete(oauthStates).where(eq(oauthStates.state, state));
  if (row.expiresAt < nowMysql()) return null;
  return { userId: row.userId, redirectTo: row.redirectTo ?? null };
}

export function buildConsentUrl(state: string, origin: string): string {
  const cfg = readGoogleAdsConfig();
  if (!cfg.clientId) throw new Error("GOOGLE_ADS_CLIENT_ID em falta");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", resolveRedirectUri(cfg, origin));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_ADS_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");          // garante refresh_token
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", state);
  return url.toString();
}

interface TokenResponse { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string; error?: string; error_description?: string }

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    const err = new Error(`${json.error ?? res.status}: ${json.error_description ?? "erro no token"}`);
    (err as any).oauthError = json.error ?? String(res.status);
    throw err;
  }
  return json;
}

export async function exchangeCodeForTokens(code: string, origin: string): Promise<TokenResponse> {
  const cfg = readGoogleAdsConfig();
  if (!cfg.clientId || !cfg.clientSecret) throw new Error("GOOGLE_ADS_CLIENT_ID/SECRET em falta");
  return tokenRequest({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: resolveRedirectUri(cfg, origin), grant_type: "authorization_code" });
}

export async function getConnection() {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(integrationConnections).where(eq(integrationConnections.provider, GOOGLE_ADS_PROVIDER)).limit(1);
  return rows[0] ?? null;
}

export async function saveConnection(patch: Partial<typeof integrationConnections.$inferInsert>) {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const existing = await getConnection();
  if (existing) await db.update(integrationConnections).set(patch).where(eq(integrationConnections.id, existing.id));
  else await db.insert(integrationConnections).values({ provider: GOOGLE_ADS_PROVIDER, status: "disconnected", ...patch });
}

/** Guarda o refresh token (cifrado). Se a Google não devolver um novo, mantém o anterior. */
export async function storeRefreshToken(tokens: TokenResponse, userId: number, loginCustomerId: string | null) {
  const existing = await getConnection();
  const refresh = tokens.refresh_token ?? (existing?.refreshTokenEnc ? decryptSecret(existing.refreshTokenEnc) : null);
  if (!refresh) throw new Error("A Google não devolveu refresh token (tenta de novo com consentimento)");
  await saveConnection({
    status: "connected",
    refreshTokenEnc: encryptSecret(refresh),
    scope: tokens.scope ?? GOOGLE_ADS_SCOPE,
    loginCustomerId: loginCustomerId ?? existing?.loginCustomerId ?? null,
    connectedById: userId,
    connectedAt: nowMysql(),
    lastCheckedAt: nowMysql(),
    lastError: null,
  });
}

let cachedAccess: { token: string; expiresAt: number } | null = null;

/** Access token válido (renova com o refresh token). Marca reauth_required se a Google revogar. */
export async function getAccessToken(): Promise<string> {
  if (cachedAccess && cachedAccess.expiresAt > Date.now() + 60_000) return cachedAccess.token;
  const cfg = readGoogleAdsConfig();
  const conn = await getConnection();
  if (!conn || conn.status === "disconnected" || !conn.refreshTokenEnc) throw new Error("Google Ads não está ligado");
  if (!cfg.clientId || !cfg.clientSecret) throw new Error("GOOGLE_ADS_CLIENT_ID/SECRET em falta");
  let refresh: string;
  try { refresh = decryptSecret(conn.refreshTokenEnc); }
  catch { throw new Error("Não foi possível decifrar o refresh token (a chave de cifra mudou?) — volta a ligar"); }
  try {
    const t = await tokenRequest({ refresh_token: refresh, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "refresh_token" });
    cachedAccess = { token: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
    if (conn.status !== "connected") await saveConnection({ status: "connected", lastError: null });
    return t.access_token;
  } catch (err: any) {
    const code = err?.oauthError;
    if (code === "invalid_grant" || code === "invalid_client") {
      await saveConnection({ status: "reauth_required", lastError: `${code}: é preciso voltar a autorizar (${err.message})`, lastCheckedAt: nowMysql() });
    } else {
      await saveConnection({ status: "error", lastError: String(err?.message ?? err).slice(0, 500), lastCheckedAt: nowMysql() });
    }
    cachedAccess = null;
    throw err;
  }
}

export async function disconnect() {
  cachedAccess = null;
  await saveConnection({ status: "disconnected", refreshTokenEnc: null, lastError: null, lastCheckedAt: nowMysql() });
}

export function connectionSummary(conn: Awaited<ReturnType<typeof getConnection>>) {
  const keyInfo = (() => { try { return encryptionKeyInfo().source; } catch { return "invalid"; } })();
  return {
    status: conn?.status ?? "disconnected",
    connectedAt: conn?.connectedAt ?? null,
    connectedById: conn?.connectedById ?? null,
    lastCheckedAt: conn?.lastCheckedAt ?? null,
    lastError: conn?.lastError ?? null,
    loginCustomerId: conn?.loginCustomerId ?? null,
    scope: conn?.scope ?? null,
    encryptionKeySource: keyInfo as "env" | "derived" | "none" | "invalid",
  };
}

/** Só para diagnóstico: existe token guardado? (nunca devolve o token) */
export async function hasStoredRefreshToken(): Promise<boolean> {
  const c = await getConnection();
  return Boolean(c?.refreshTokenEnc);
}

// evita "unused" em builds que não usam sql
void sql;
