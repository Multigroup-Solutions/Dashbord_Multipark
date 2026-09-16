import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getDb } from '../../db';
import { integrationConnections, oauthStates } from '../../../drizzle/schema';
import { encryptSecret, decryptSecret } from '../googleAds/crypto';
import { config, consentUrl, PROVIDER, SCOPE } from './config';

const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const mysqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
export async function database() { const db = await getDb(); if (!db) throw new Error('Base de dados indisponível.'); return db; }
export async function connection() {
  const db = await database();
  return (await db.select().from(integrationConnections).where(eq(integrationConnections.provider, PROVIDER)).limit(1))[0] ?? null;
}
export async function saveConnection(patch: Partial<typeof integrationConnections.$inferInsert>) {
  const db = await database();
  await db.insert(integrationConnections).values({ provider: PROVIDER, ...patch })
    .onDuplicateKeyUpdate({ set: patch });
}
export async function startOAuth(userId: number) {
  const db = await database();
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  await db.insert(oauthStates).values({ state, provider: PROVIDER, userId,
    redirectTo: encryptSecret(verifier), expiresAt: new Date(Date.now() + 600_000).toISOString().slice(0, 19).replace('T', ' ') });
  return consentUrl(state, crypto.createHash('sha256').update(verifier).digest('base64url'));
}
export async function consumeState(state: string, userId: number) {
  const db = await database();
  return db.transaction(async tx => {
    const [row] = await tx.select().from(oauthStates).where(and(eq(oauthStates.state, state),
      eq(oauthStates.provider, PROVIDER), eq(oauthStates.userId, userId))).limit(1).for('update');
    if (!row) return null;
    await tx.delete(oauthStates).where(eq(oauthStates.state, state));
    if (row.expiresAt <= mysqlNow() || !row.redirectTo) return null;
    return decryptSecret(row.redirectTo);
  });
}
type Tokens = { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string; error?: string };
async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const c = config();
  if (!c.clientId || !c.clientSecret) throw new Error('Credenciais Google em falta.');
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(12_000),
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }) });
  const body: Tokens = await res.json().catch(() => ({}));
  if (!res.ok || body.error || !body.access_token) {
    const code = ['invalid_grant', 'invalid_client', 'access_denied'].includes(body.error || '') ? body.error : String(res.status);
    throw new Error(`Autorização Google: ${code}. Volta a ligar a conta.`);
  }
  return body;
}
export async function finishOAuth(code: string, verifier: string, userId: number) {
  const c = config();
  const t = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: c.redirectUri });
  if (!t.scope?.split(' ').includes(SCOPE) || !t.id_token) throw new Error('A autorização não incluiu acesso aos perfis de empresas.');
  const { payload } = await jwtVerify(t.id_token, keys, { audience: c.clientId, issuer: ['https://accounts.google.com', 'accounts.google.com'] });
  if (payload.email_verified !== true || typeof payload.email !== 'string') throw new Error('A Google não confirmou a identidade da conta.');
  const old = await connection();
  const refresh = t.refresh_token || (old?.accountEmail === payload.email && old.refreshTokenEnc ? decryptSecret(old.refreshTokenEnc) : null);
  if (!refresh) throw new Error('Falta autorização de acesso contínuo. Volta a ligar a conta.');
  await saveConnection({ status: 'connected', refreshTokenEnc: encryptSecret(refresh), scope: t.scope,
    accountEmail: payload.email, connectedById: userId, connectedAt: mysqlNow(), lastError: null });
  // Never carry park selections over silently when a different Google identity connects.
  if (old?.accountEmail && old.accountEmail !== payload.email) {
    const db = await database();
    await db.execute(sql`UPDATE google_business_locations SET selected = 0, available = 0, nextPageToken = NULL`);
  }
}
export async function accessToken() {
  const conn = await connection();
  if (!conn?.refreshTokenEnc || conn.status === 'disconnected' || conn.status === 'reauth_required') throw new Error('Google Business Profile desligado.');
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decryptSecret(conn.refreshTokenEnc) });
    return t.access_token!;
  } catch (error) {
    if (error instanceof Error && /invalid_grant|invalid_client/.test(error.message)) {
      await saveConnection({ status: 'reauth_required', lastError: 'A autorização expirou ou foi revogada. Volta a ligar a conta.' });
    }
    throw error;
  }
}
export async function disconnect() {
  const db = await database();
  await db.transaction(async tx => {
    await tx.update(integrationConnections).set({ status: 'disconnected', refreshTokenEnc: null, lastError: null })
      .where(eq(integrationConnections.provider, PROVIDER));
    await tx.execute(sql`UPDATE google_business_locations SET selected = 0, nextPageToken = NULL`);
  });
}
