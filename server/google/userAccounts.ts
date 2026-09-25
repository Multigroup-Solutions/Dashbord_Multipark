/**
 * "Ligar a minha conta Google" — OAuth por utilizador (Fase 1).
 *
 *  - consentimento com PKCE (S256) + `state` de uso único (oauth_states,
 *    provider google_user, ligado ao utilizador da sessão, 10 min);
 *  - só contas do Workspace da empresa: id_token VERIFICADO (assinatura,
 *    audiência) + email verificado + claim `hd` em GOOGLE_WORKSPACE_DOMAINS;
 *  - autorização incremental: cada funcionalidade pede só os seus âmbitos
 *    (Gmail, Calendário, Tarefas e Contactos ligados; o Drive fica
 *    preparado — shared/mail.ts → GOOGLE_FEATURE_SCOPES);
 *  - refresh token CIFRADO (AES-256-GCM, INTEGRATIONS_ENCRYPTION_KEY);
 *  - revogado/expirado → status `reauth_required` + aviso à própria pessoa
 *    (alerts.ts → google_account_reauth); "Desligar" revoga na Google.
 * Nunca devolve tokens.
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { decryptSecret, encryptSecret } from "../integrations/googleAds/crypto";
import {
  GOOGLE_FEATURES_ENABLED, GOOGLE_FEATURES, hasFeatureScopes, isAllowedWorkspaceIdentity, normalizeAddress, personalAccountKey,
  type GoogleFeature,
} from "../../shared/mail";
import {
  GOOGLE_USER_PROVIDER, consentUrl, googleErrorMessage, isAuthRevokedError, newOAuthClient, userAuthClient, workspaceConfig,
} from "./workspace";
import type { OAuth2Client, TokenPayload } from "google-auth-library";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const nowMysql = () => new Date().toISOString().slice(0, 19).replace("T", " ");

async function database() {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  return db;
}

export type GoogleAccountStatus = "connected" | "reauth_required" | "error" | "disconnected";

export interface GoogleAccountRow {
  id: number; userId: number; email: string; hostedDomain: string | null; googleSub: string | null;
  refreshTokenEnc: string | null; scopes: string | null; status: GoogleAccountStatus; lastError: string | null;
  connectedAt: string | null; lastCheckedAt: string | null;
}

export async function getGoogleAccount(userId: number): Promise<GoogleAccountRow | null> {
  const db = await database();
  const r = rowsOf(await db.execute(sql`SELECT * FROM google_user_accounts WHERE userId = ${userId} LIMIT 1`))[0];
  return r ? ({ ...r, id: Number(r.id), userId: Number(r.userId) } as GoogleAccountRow) : null;
}

/** Destino relativo seguro depois do OAuth (nunca redirecionador aberto). PURA. */
export function safeReturnPath(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.length > 120 || !s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\") || /[\u0000-\u001f\\]/.test(s)) return "/perfil";
  return s;
}

/** Funcionalidades pedidas (só as conhecidas e ligadas; omissão: gmail). PURA. */
export function requestedFeatures(raw: unknown): GoogleFeature[] {
  const list = String(raw ?? "").split(",").map((x) => x.trim()).filter((x): x is GoogleFeature => (GOOGLE_FEATURES as readonly string[]).includes(x));
  const ok = list.filter((f) => GOOGLE_FEATURES_ENABLED.includes(f));
  return ok.length ? Array.from(new Set(ok)) : ["gmail"];
}

/** Começa o consentimento: devolve o URL da Google. */
export async function startGoogleAccountOAuth(user: { id: number; email?: string | null }, opts: { features?: GoogleFeature[]; returnTo?: string } = {}): Promise<string> {
  const cfg = workspaceConfig();
  const client = newOAuthClient(cfg);
  const db = await database();
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const features = opts.features?.length ? opts.features : (["gmail"] as GoogleFeature[]);
  const payload = encryptSecret(JSON.stringify({ v: verifier, r: safeReturnPath(opts.returnTo), f: features }));
  const expires = new Date(Date.now() + 10 * 60_000).toISOString().slice(0, 19).replace("T", " ");
  try { await db.execute(sql`DELETE FROM oauth_states WHERE expiresAt < ${nowMysql()} LIMIT 500`); } catch { /* limpeza */ }
  await db.execute(sql`INSERT INTO oauth_states (state, provider, userId, redirectTo, expiresAt)
    VALUES (${state}, ${GOOGLE_USER_PROVIDER}, ${user.id}, ${payload}, ${expires})`);
  const email = normalizeAddress(user.email);
  const hint = email && cfg.domains.some((d) => email.endsWith(`@${d}`)) ? email : null;
  return consentUrl(client, { state, codeChallenge: challenge, features, loginHint: hint, hd: cfg.domains.length === 1 ? cfg.domains[0] : null });
}

/** Consome o state (uma vez, só pelo mesmo utilizador). */
export async function consumeGoogleAccountState(state: string, userId: number): Promise<{ verifier: string; returnTo: string; features: GoogleFeature[] } | null> {
  const db = await database();
  return db.transaction(async (tx) => {
    const row = rowsOf(await tx.execute(sql`SELECT state, redirectTo, expiresAt FROM oauth_states
      WHERE state = ${state} AND provider = ${GOOGLE_USER_PROVIDER} AND userId = ${userId} LIMIT 1 FOR UPDATE`))[0];
    if (!row) return null;
    await tx.execute(sql`DELETE FROM oauth_states WHERE state = ${state}`);
    if (String(row.expiresAt) <= nowMysql() || !row.redirectTo) return null;
    try {
      const p = JSON.parse(decryptSecret(String(row.redirectTo)));
      if (typeof p?.v !== "string") return null;
      return { verifier: p.v, returnTo: safeReturnPath(p.r), features: requestedFeatures((p.f ?? []).join(",")) };
    } catch { return null; }
  });
}

/** Troca o código, valida a identidade (Workspace) e guarda o token cifrado. */
export async function finishGoogleAccountOAuth(code: string, verifier: string, user: { id: number; email?: string | null }): Promise<{ email: string; identityChanged: boolean }> {
  const cfg = workspaceConfig();
  const client = newOAuthClient(cfg);
  const { tokens } = await client.getToken({ code, codeVerifier: verifier });
  if (!tokens.id_token) throw new Error("A Google não devolveu a identidade da conta.");
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: cfg.clientId });
  const payload: Partial<TokenPayload> = ticket.getPayload() ?? {};
  const allowed = isAllowedWorkspaceIdentity({ email: payload.email, email_verified: payload.email_verified, hd: payload.hd }, cfg.domains);
  if (!allowed.ok) {
    // Não fica nada guardado: revoga o que a Google acabou de emitir.
    try { if (tokens.refresh_token || tokens.access_token) await client.revokeToken(String(tokens.refresh_token || tokens.access_token)); } catch { /* best-effort */ }
    throw new Error(allowed.error);
  }
  // A caixa pessoal é da própria pessoa: se o login é do Workspace, tem de ser a MESMA conta.
  const appEmail = normalizeAddress(user.email);
  if (appEmail && cfg.domains.some((d) => appEmail.endsWith(`@${d}`)) && appEmail !== allowed.email) {
    try { if (tokens.refresh_token) await client.revokeToken(tokens.refresh_token); } catch { /* best-effort */ }
    throw new Error(`Liga a tua própria conta (${appEmail}), não ${allowed.email}.`);
  }
  const old = await getGoogleAccount(user.id);
  const identityChanged = !!old?.email && normalizeAddress(old.email) !== allowed.email;
  let refresh = tokens.refresh_token ?? null;
  if (!refresh && !identityChanged && old?.refreshTokenEnc) {
    try { refresh = decryptSecret(old.refreshTokenEnc); } catch { refresh = null; }
  }
  if (!refresh) throw new Error("A Google não devolveu autorização de acesso contínuo. Volta a ligar a conta.");
  const scopes = String(tokens.scope ?? "");
  const db = await database();
  await db.execute(sql`INSERT INTO google_user_accounts (userId, email, hostedDomain, googleSub, refreshTokenEnc, scopes, status, lastError, connectedAt, lastCheckedAt)
    VALUES (${user.id}, ${allowed.email}, ${payload.hd ?? null}, ${payload.sub ?? null}, ${encryptSecret(refresh)}, ${scopes}, 'connected', NULL, ${nowMysql()}, ${nowMysql()})
    ON DUPLICATE KEY UPDATE email = VALUES(email), hostedDomain = VALUES(hostedDomain), googleSub = VALUES(googleSub),
      refreshTokenEnc = VALUES(refreshTokenEnc), scopes = VALUES(scopes), status = 'connected', lastError = NULL,
      connectedAt = VALUES(connectedAt), lastCheckedAt = VALUES(lastCheckedAt)`);
  // Conta de sincronização da caixa pessoal (nova conta Google → recomeça do zero).
  if (hasFeatureScopes(scopes, "gmail")) {
    const key = personalAccountKey(user.id);
    await db.execute(sql`INSERT INTO mail_accounts (accountKey, email, status) VALUES (${key}, ${allowed.email}, 'pending')
      ON DUPLICATE KEY UPDATE email = VALUES(email), status = IF(status = 'disconnected' OR status = 'reauth_required', 'pending', status), lastError = NULL`);
    if (identityChanged) {
      await db.execute(sql`UPDATE mail_accounts SET historyId = NULL, backfillStartHistoryId = NULL, backfillPageToken = NULL, backfillDoneAt = NULL, status = 'pending'
        WHERE accountKey = ${key}`);
    }
  }
  return { email: allowed.email, identityChanged };
}

/** Marca o estado da conta (e da sincronização da caixa pessoal). */
export async function setGoogleAccountStatus(userId: number, status: GoogleAccountStatus, error: string | null): Promise<void> {
  const db = await database();
  await db.execute(sql`UPDATE google_user_accounts SET status = ${status}, lastError = ${error ? error.slice(0, 500) : null}, lastCheckedAt = ${nowMysql()} WHERE userId = ${userId}`);
  if (status !== "connected") {
    await db.execute(sql`UPDATE mail_accounts SET status = ${status}, lastError = ${error ? error.slice(0, 500) : null} WHERE accountKey = ${personalAccountKey(userId)}`);
  }
}

/**
 * Cliente autenticado da conta Google da pessoa. Renova o access token já
 * (deteta revogação cedo) e marca `reauth_required` quando a Google recusa.
 */
export async function userGoogleAuth(userId: number, feature: GoogleFeature = "gmail"): Promise<{ client: OAuth2Client; email: string }> {
  const acc = await getGoogleAccount(userId);
  if (!acc || !acc.refreshTokenEnc || acc.status === "disconnected") throw new Error("Conta Google não ligada.");
  if (acc.status === "reauth_required") throw new Error("A autorização da conta Google expirou — volta a ligar no Perfil.");
  if (!hasFeatureScopes(acc.scopes, feature)) throw new Error("A conta Google ligada não autorizou este acesso — volta a ligar no Perfil.");
  let refresh: string;
  try { refresh = decryptSecret(acc.refreshTokenEnc); }
  catch {
    await setGoogleAccountStatus(userId, "reauth_required", "Não foi possível decifrar o token (a chave de cifra mudou?).");
    throw new Error("Não foi possível decifrar o token da conta Google — volta a ligar no Perfil.");
  }
  const client = userAuthClient(refresh);
  try {
    await client.getAccessToken();
  } catch (err) {
    if (isAuthRevokedError(err)) {
      await setGoogleAccountStatus(userId, "reauth_required", "A autorização expirou ou foi revogada. Volta a ligar a conta.");
      throw new Error("A autorização da conta Google expirou — volta a ligar no Perfil.");
    }
    await setGoogleAccountStatus(userId, "error", googleErrorMessage(err)).catch(() => {});
    throw err;
  }
  if (acc.status !== "connected") await setGoogleAccountStatus(userId, "connected", null).catch(() => {});
  return { client, email: acc.email };
}

/** Desliga: revoga na Google (best-effort), apaga o token e para a sincronização. */
export async function disconnectGoogleAccount(userId: number): Promise<void> {
  const acc = await getGoogleAccount(userId);
  // Contactos: antes de revogar, apaga (best-effort, ≤ 12 s) os contactos que a
  // app criou no Google da pessoa; o que se guardou dos contactos dela é apagado.
  if (acc?.refreshTokenEnc && hasFeatureScopes(acc.scopes, "contacts")) {
    try {
      const { removeAllAppContacts } = await import("./contactsService");
      await removeAllAppContacts(userId, Date.now() + 12_000);
    } catch { /* sem rede/sem autorização: a ligação é apagada na mesma */ }
  }
  try {
    const { purgeUserContacts } = await import("./contactsStore");
    await purgeUserContacts(userId);
  } catch { /* tabelas ainda por criar */ }
  if (acc?.refreshTokenEnc) {
    try {
      const client = newOAuthClient();
      await client.revokeToken(decryptSecret(acc.refreshTokenEnc));
    } catch { /* já revogado / sem rede: o token local é apagado na mesma */ }
  }
  const db = await database();
  await db.execute(sql`UPDATE google_user_accounts SET status = 'disconnected', refreshTokenEnc = NULL, lastError = NULL, lastCheckedAt = ${nowMysql()} WHERE userId = ${userId}`);
  await db.execute(sql`UPDATE mail_accounts SET status = 'disconnected', lastError = NULL WHERE accountKey = ${personalAccountKey(userId)}`);
}

/** Resumo para a UI (nunca tokens). */
export async function googleAccountSummary(userId: number) {
  const acc = await getGoogleAccount(userId).catch(() => null);
  const cfg = workspaceConfig();
  return {
    configured: !!(cfg.clientId && cfg.clientSecret),
    domains: cfg.domains,
    connected: !!acc && acc.status !== "disconnected" && !!acc.refreshTokenEnc,
    status: (acc?.status ?? "disconnected") as GoogleAccountStatus,
    email: acc && acc.status !== "disconnected" ? acc.email : null,
    lastError: acc?.lastError ?? null,
    connectedAt: acc?.connectedAt ?? null,
    features: GOOGLE_FEATURES.map((f) => ({ id: f, enabled: GOOGLE_FEATURES_ENABLED.includes(f), granted: !!acc && hasFeatureScopes(acc.scopes, f) })),
  };
}
