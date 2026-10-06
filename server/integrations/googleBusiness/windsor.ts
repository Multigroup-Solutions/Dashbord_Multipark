/**
 * P3 lote 33a — Google Business pela Windsor (Jorge, 6 out 2026): "consigo ir
 * buscar os dados do Business da Google através da Windsor para que me ponha
 * e responda através da dashboard?"
 *
 * Segundo canal da integração que já existe (OAuth direto à Google). Mesmas
 * tabelas, mesmo ecrã e mesma importação (`importReview`):
 *  - os perfis e as avaliações vêm da REST da Windsor (connector
 *    `google_my_business`) e entram nas Críticas como hoje (≤3★ → reclamação);
 *  - o "Publicar" das Críticas responde pela ação `reply_to_review` da
 *    Windsor quando a Google não está ligada diretamente.
 * Dois interruptores, desligados por omissão: GBP_WINDSOR_SYNC (importar) e
 * GBP_WINDSOR_REPLY (responder — é público).
 *
 * A chave (WINDSOR_API_KEY, na Vercel) vai só na query string: nunca aparece
 * em erros, logs ou no estado mostrado na UI (`scrubWindsor`).
 */
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { FetchTimeoutError, fetchWithTimeout } from '../../_core/fetchWithTimeout';
import { REPLY_MAX_LENGTH } from './client';
import { accountPattern, locationPattern, reviewPattern, safeError, type GoogleReview } from './domain';

export const WINDSOR_BASE = 'https://connectors.windsor.ai';
export const WINDSOR_CONNECTOR = 'google_my_business';
/** 1.ª importação de um perfil: até 3 anos para trás. */
export const WINDSOR_BACKFILL_DAYS = 3 * 365;
/** Depois: as avaliações escritas nos últimos 60 dias (respostas e edições incluídas). */
export const WINDSOR_RECENT_DAYS = 60;

export const windsorKey = () => process.env.WINDSOR_API_KEY?.trim() || '';
export const windsorConfigured = () => !!windsorKey();

/** Tira a chave e qualquer `api_key=` de uma mensagem. PURA. */
export function scrubWindsor(message: string, key = windsorKey()): string {
  let m = String(message ?? '');
  if (key && key.length >= 6) m = m.split(key).join('[omitido]');
  return m.replace(/api_key=[^&\s"']+/gi, 'api_key=[omitido]');
}

/** Erro da Windsor → texto curto e seguro (sem chave, sem tokens). PURA. */
export function windsorError(error: unknown, key = windsorKey()): string {
  return scrubWindsor(safeError(error), key).slice(0, 500);
}

const STARS: Record<string, string> = { '1': 'ONE', '2': 'TWO', '3': 'THREE', '4': 'FOUR', '5': 'FIVE' };
const WORDS = new Set(Object.values(STARS));
const text = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v));

/** "2026-10-01T18:48:34.880800Z" / "2026-10-01 18:48:34" (UTC) → ISO; null se não der. PURA. */
export function windsorIso(v: unknown): string | null {
  const s = text(v)?.trim();
  if (!s) return null;
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(withZone);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** "ONE".."FIVE" ou 1..5 → a palavra que a API da Google usa. PURA. */
export function windsorStars(v: unknown): string | null {
  const s = String(v ?? '').trim().toUpperCase();
  if (WORDS.has(s)) return s;
  const n = Number(s);
  return Number.isInteger(n) && STARS[String(n)] ? STARS[String(n)] : null;
}

/** Linha da tabela Reviews da Windsor → a forma da API da Google (null = sem avaliação / inválida). PURA. */
export function windsorReviewToGoogle(r: Record<string, unknown>): GoogleReview | null {
  const rawId = text(r.review_id);
  if (!rawId) return null;
  // Aceita também o nome completo do recurso (accounts/A/locations/L/reviews/{id}); outros caminhos não
  const raw = rawId.trim();
  if (raw.includes('/') && !reviewPattern.test(raw)) return null;
  const reviewId = raw.split('/').pop() || '';
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(reviewId)) return null;
  const starRating = windsorStars(r.review_star_rating);
  const createTime = windsorIso(r.review_create_time);
  const updateTime = windsorIso(r.review_update_time) ?? createTime;
  if (!starRating || !createTime || !updateTime) return null;
  const reviewer = text(r.review_reviewer);
  const comment = text(r.review_comment);
  const reply = text(r.review_reply_comment);
  const replyAt = windsorIso(r.review_reply_update_time);
  return {
    reviewId, starRating, createTime, updateTime,
    ...(reviewer ? { reviewer: { displayName: reviewer } } : {}),
    ...(comment ? { comment } : {}),
    ...(reply ? { reviewReply: { comment: reply, ...(replyAt ? { updateTime: replyAt } : {}) } } : {}),
  };
}

export interface WindsorLocation {
  locationName: string; accountName: string; title: string; address: string | null;
  meta: { openStatus: string | null; mapsUri: string | null; placeId: string | null; hasVoiceOfMerchant: number | null; hasPendingEdits: number | null; hasGoogleUpdated: number | null; canOperateLocalPost: number | null };
}

const bool01 = (v: unknown): number | null => {
  if (v === true || v === 1 || String(v).toLowerCase() === 'true') return 1;
  if (v === false || v === 0 || String(v).toLowerCase() === 'false') return 0;
  return null;
};

/** Linha de perfil da Windsor → o nosso perfil (null se faltar o local ou a conta Google). PURA. */
export function windsorLocationOf(r: Record<string, unknown>): WindsorLocation | null {
  const locationName = text(r.location_id)?.trim() ?? '';
  const accountName = text(r.google_account_id)?.trim() ?? '';
  // Sem a conta não há nome de recurso da avaliação → não se podia responder
  if (!locationPattern.test(locationName) || !accountPattern.test(accountName)) return null;
  const lines = Array.isArray(r.location_address_lines) ? (r.location_address_lines as unknown[]).map(String)
    : text(r.location_address_lines) ? [String(r.location_address_lines)] : [];
  const address = [...lines, text(r.location_address_postal_code), text(r.location_address_locality)].filter(Boolean).join(', ');
  const s = (v: unknown, n: number) => text(v)?.slice(0, n) ?? null;
  return {
    locationName, accountName, title: (text(r.location_title) ?? locationName).slice(0, 256), address: address || null,
    meta: {
      openStatus: s(r.location_open_info_status, 30), mapsUri: s(r.location_metadata_maps_uri, 500), placeId: s(r.location_metadata_place_id, 100),
      hasVoiceOfMerchant: bool01(r.location_metadata_has_voice_of_merchant), hasPendingEdits: bool01(r.location_metadata_has_pending_edits),
      hasGoogleUpdated: bool01(r.location_metadata_has_google_updated), canOperateLocalPost: bool01(r.location_metadata_can_operate_local_post),
    },
  };
}

/** Avaliações agrupadas por perfil, sem repetidas (fica a versão mais recente). PURA. */
export function groupWindsorReviews(rowsIn: readonly Record<string, unknown>[]): Map<string, GoogleReview[]> {
  const byLoc = new Map<string, Map<string, GoogleReview>>();
  for (const r of rowsIn) {
    const loc = text(r.location_id)?.trim() ?? '';
    if (!locationPattern.test(loc)) continue;
    const review = windsorReviewToGoogle(r);
    if (!review) continue;
    const m = byLoc.get(loc) ?? new Map<string, GoogleReview>();
    const prev = m.get(review.reviewId);
    if (!prev || Date.parse(review.updateTime) >= Date.parse(prev.updateTime)) m.set(review.reviewId, review);
    byLoc.set(loc, m);
  }
  // Mais antigas primeiro: numa recolha cortada a meio, as que faltam são as mais recentes e vêm na próxima
  return new Map([...byLoc].map(([k, m]) => [k, [...m.values()].sort((a, b) => Date.parse(a.updateTime) - Date.parse(b.updateTime))]));
}

/** Janela de datas a pedir (dias de calendário UTC). PURA. */
export function windsorSyncWindow(o: { firstImport: boolean; nowMs: number }): { dateFrom: string; dateTo: string } {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const back = o.firstImport ? WINDSOR_BACKFILL_DAYS : WINDSOR_RECENT_DAYS;
  return { dateFrom: day(o.nowMs - back * 86_400_000), dateTo: day(o.nowMs) };
}

/**
 * Que avaliações vale a pena passar ao `importReview` (uma transação cada):
 * fora da 1.ª importação, só as mexidas na janela recente; e nunca as que já
 * estão iguais cá dentro (mesma data de alteração e mesma resposta). PURA.
 */
export function reviewsToImport(reviews: readonly GoogleReview[], o: {
  firstImport: boolean; nowMs: number; existing: ReadonlyMap<string, { updatedAt: string | null; reply: string | null }>;
}): GoogleReview[] {
  const cutoff = o.nowMs - WINDSOR_RECENT_DAYS * 86_400_000;
  return reviews.filter((r) => {
    const touched = Math.max(Date.parse(r.updateTime), Date.parse(r.reviewReply?.updateTime ?? '') || 0);
    if (!o.firstImport && touched < cutoff) return false;
    const e = o.existing.get(r.reviewId);
    if (!e) return true;
    return !(e.updatedAt === new Date(Date.parse(r.updateTime)).toISOString() && (e.reply ?? null) === (r.reviewReply?.comment || null));
  });
}

export type ReplyChannel = 'google' | 'windsor' | 'none';
/** Por onde sai a resposta: Google direto quando ligado; senão a Windsor se tiver chave e o interruptor. PURA. */
export function replyChannel(o: { oauthConnected: boolean; windsorConfigured: boolean; windsorReplyOn: boolean }): ReplyChannel {
  if (o.oauthConnected) return 'google';
  if (o.windsorConfigured && o.windsorReplyOn) return 'windsor';
  return 'none';
}

// ─── REST ───────────────────────────────────────────────────────────────────

type FetchFn = (input: any, init?: any) => Promise<Response>;

export const REVIEW_FIELDS = ['location_id', 'google_account_id', 'review_id', 'review_star_rating', 'review_create_time', 'review_update_time',
  'review_reviewer', 'review_comment', 'review_reply_comment', 'review_reply_update_time'] as const;
export const LOCATION_FIELDS = ['location_id', 'google_account_id', 'location_title', 'location_address_lines', 'location_address_postal_code',
  'location_address_locality', 'location_open_info_status', 'location_metadata_maps_uri', 'location_metadata_place_id',
  'location_metadata_has_voice_of_merchant', 'location_metadata_has_pending_edits', 'location_metadata_has_google_updated',
  'location_metadata_can_operate_local_post'] as const;

/** URL de leitura (a chave fica no fim, só na query). PURA. */
export function windsorReadUrl(o: { key: string; fields: readonly string[]; dateFrom?: string; dateTo?: string; datePreset?: string; accounts?: readonly string[] }): string {
  const u = new URL(`${WINDSOR_BASE}/${WINDSOR_CONNECTOR}`);
  u.searchParams.set('fields', o.fields.join(','));
  if (o.datePreset) u.searchParams.set('date_preset', o.datePreset);
  if (o.dateFrom) u.searchParams.set('date_from', o.dateFrom);
  if (o.dateTo) u.searchParams.set('date_to', o.dateTo);
  if (o.accounts?.length) u.searchParams.set('select_accounts', o.accounts.join(','));
  u.searchParams.set('_renderer', 'json');
  u.searchParams.set('api_key', o.key);
  return u.toString();
}

async function readBody(res: Response): Promise<any> {
  const raw = await res.text().catch(() => '');
  try { return raw ? JSON.parse(raw) : null; } catch { return { _raw: raw.slice(0, 200) }; }
}
const bodyMessage = (b: any): string | null => {
  const m = b?.error?.message ?? b?.error ?? b?.message ?? b?.detail ?? b?._raw;
  return typeof m === 'string' && m.trim() ? m.trim().slice(0, 200) : null;
};

/** GET da Windsor → linhas. Lança com mensagem curta e sem a chave. */
export async function windsorGet(o: { fields: readonly string[]; dateFrom?: string; dateTo?: string; datePreset?: string; accounts?: readonly string[]; timeoutMs?: number },
  fetchImpl: FetchFn = fetch): Promise<Record<string, unknown>[]> {
  const key = windsorKey();
  if (!key) throw new Error('Falta a chave da Windsor (WINDSOR_API_KEY) na Vercel.');
  try {
    const res = await fetchWithTimeout(windsorReadUrl({ ...o, key }), { method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: o.timeoutMs ?? 25_000 }, fetchImpl);
    const body = await readBody(res);
    if (res.status === 401 || res.status === 403) throw new Error('A Windsor recusou a chave (WINDSOR_API_KEY). Confirma a chave na Vercel.');
    if (!res.ok) throw new Error(`Windsor: erro ${res.status}${bodyMessage(body) ? ` — ${bodyMessage(body)}` : ''}`);
    if (body && !Array.isArray(body) && (body.status === 'pending' || body.status === 'running')) {
      throw new Error('A Windsor ainda está a preparar os dados; a próxima recolha continua.');
    }
    const data = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
    if (!data) throw new Error(`Windsor: resposta inesperada${bodyMessage(body) ? ` — ${bodyMessage(body)}` : ''}`);
    return data.filter((r: unknown): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
  } catch (error) {
    if (error instanceof FetchTimeoutError) throw new Error('A Windsor demorou demasiado a responder (pode estar a preparar os dados); a próxima recolha continua.');
    throw new Error(windsorError(error, key));
  }
}

/** POST de uma ação de escrita (ex.: reply_to_review). `account` = "locations/N". */
export async function windsorAction(account: string, action: string, params: Record<string, unknown>, fetchImpl: FetchFn = fetch): Promise<any> {
  const key = windsorKey();
  if (!key) throw new Error('Falta a chave da Windsor (WINDSOR_API_KEY) na Vercel.');
  if (!locationPattern.test(account)) throw new Error('Perfil Google inválido.');
  if (!/^[a-z_]{3,60}$/.test(action)) throw new Error('Ação inválida.');
  const u = new URL(`${WINDSOR_BASE}/${WINDSOR_CONNECTOR}/actions`);
  u.searchParams.set('api_key', key);
  try {
    const res = await fetchWithTimeout(u.toString(), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ account, action, params }), timeoutMs: 20_000,
    }, fetchImpl);
    const body = await readBody(res);
    if (res.status === 401) throw new Error('A Windsor recusou a chave (WINDSOR_API_KEY). Confirma a chave na Vercel.');
    if (res.status === 403) throw new Error(`A Windsor não deixou fazer a ação — confirma que as ações de escrita estão ativas na equipa da Windsor${bodyMessage(body) ? ` (${bodyMessage(body)})` : ''}.`);
    if (!res.ok) throw new Error(`Windsor: erro ${res.status}${bodyMessage(body) ? ` — ${bodyMessage(body)}` : ''}`);
    if (body && typeof body === 'object' && (body.ok === false || body.success === false || body.status === 'error' || (body.error && !body.data))) {
      throw new Error(`Windsor: ${bodyMessage(body) ?? 'a ação falhou.'}`);
    }
    return body;
  } catch (error) {
    throw new Error(windsorError(error, key));
  }
}

/**
 * Publica a resposta pela Windsor. `reviewName` = accounts/A/locations/L/reviews/R
 * (o que já guardamos). Não toca na BD — quem chama grava depois.
 */
export async function replyViaWindsor(reviewName: string, comment: string, fetchImpl: FetchFn = fetch): Promise<{ publishedAt: string }> {
  if (!reviewPattern.test(reviewName)) throw new Error('Crítica sem ligação ao Google.');
  const t = comment.trim();
  if (!t || t.length > REPLY_MAX_LENGTH) throw new Error(`A resposta tem de ter entre 1 e ${REPLY_MAX_LENGTH} caracteres.`);
  const parts = reviewName.split('/');
  const location = `${parts[2]}/${parts[3]}`;
  const reviewId = parts[5];
  await windsorAction(location, 'reply_to_review', { review_id: reviewId, comment: t }, fetchImpl);
  return { publishedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') };
}

// ─── Interruptores e estado ──────────────────────────────────────────────────

export type WindsorFlag = 'GBP_WINDSOR_SYNC' | 'GBP_WINDSOR_REPLY';
/** Interruptor lido fresco; falha a ler = desligado (escreve/publica). */
export async function windsorFlagOn(name: WindsorFlag): Promise<boolean> {
  try {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import('../../_core/featureFlags'), import('../../../shared/appSettings')]);
    await ensureFeatureFlagOverrides();
    return isFeatureEnabled(name, { defaultEnabled: automationFlagDefault(name) });
  } catch { return false; }
}

const STATE_KEY = 'gbp_windsor:last';
const LOCK_KEY = 'gbp_windsor:lock';
const rowsOf = (res: unknown): any[] => { const r = Array.isArray(res) ? res[0] : res; return Array.isArray(r) ? r : []; };
const affected = (res: unknown) => Number((Array.isArray(res) ? res[0] : res as any)?.affectedRows ?? 0);
const mysqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export interface WindsorLastRun { at: string; ok: boolean; imported: number; pending: number; error: string | null; kind: 'discover' | 'sync' }

async function db() {
  const { database } = await import('./oauth');
  return database();
}
export async function windsorLastRun(): Promise<WindsorLastRun | null> {
  try {
    const d = await db();
    const r = rowsOf(await d.execute(sql`SELECT \`value\` FROM web_analytics_state WHERE stateKey = ${STATE_KEY} LIMIT 1`))[0];
    return r?.value ? JSON.parse(String(r.value)) as WindsorLastRun : null;
  } catch { return null; }
}
async function saveLastRun(v: WindsorLastRun) {
  try {
    const d = await db();
    const value = JSON.stringify({ ...v, error: v.error ? scrubWindsor(v.error).slice(0, 500) : null });
    await d.execute(sql`INSERT INTO web_analytics_state (stateKey, \`value\`) VALUES (${STATE_KEY}, ${value}) ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`);
  } catch { /* estado */ }
}
async function acquireLock(seconds = 90): Promise<string | null> {
  const d = await db();
  const token = crypto.randomUUID();
  await d.execute(sql`INSERT IGNORE INTO web_analytics_state (stateKey, \`value\`, leaseUntil) VALUES (${LOCK_KEY}, NULL, NULL)`);
  const r = await d.execute(sql`UPDATE web_analytics_state SET \`value\` = ${token}, leaseUntil = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${seconds} SECOND)
    WHERE stateKey = ${LOCK_KEY} AND (\`value\` IS NULL OR leaseUntil IS NULL OR leaseUntil < UTC_TIMESTAMP())`);
  return affected(r) === 1 ? token : null;
}
async function releaseLock(token: string | null) {
  if (!token) return;
  try {
    const d = await db();
    await d.execute(sql`UPDATE web_analytics_state SET \`value\` = NULL, leaseUntil = NULL WHERE stateKey = ${LOCK_KEY} AND \`value\` = ${token}`);
  } catch { /* expira sozinho */ }
}

/** A Google está ligada diretamente (OAuth)? Então a Windsor fica de lado. */
export async function oauthConnected(): Promise<boolean> {
  try {
    const { connection } = await import('./oauth');
    const c = await connection();
    return !!c?.refreshTokenEnc && c.status === 'connected';
  } catch { return false; }
}

// ─── Perfis e avaliações ─────────────────────────────────────────────────────

/**
 * Vai buscar os perfis à Windsor e grava-os em google_business_locations
 * (mesma chave `locationName` do OAuth: não há duplicados). Só acrescenta ou
 * atualiza — nunca desativa perfis que já lá estavam.
 */
export async function refreshLocationsFromWindsor(fetchImpl: FetchFn = fetch): Promise<{ found: number }> {
  try {
    const data = await windsorGet({ fields: LOCATION_FIELDS, datePreset: 'last_1d' }, fetchImpl);
    const found = new Map<string, WindsorLocation>();
    for (const r of data) { const l = windsorLocationOf(r); if (l) found.set(l.locationName, l); }
    const d = await db();
    for (const l of found.values()) {
      const m = l.meta;
      await d.execute(sql`INSERT INTO google_business_locations (locationName, accountName, title, address,
          hasGoogleUpdated, hasPendingEdits, hasVoiceOfMerchant, canOperateLocalPost, openStatus, mapsUri, placeId, metaCheckedAt)
        VALUES (${l.locationName}, ${l.accountName}, ${l.title}, ${l.address},
          ${m.hasGoogleUpdated}, ${m.hasPendingEdits}, ${m.hasVoiceOfMerchant}, ${m.canOperateLocalPost}, ${m.openStatus}, ${m.mapsUri}, ${m.placeId}, UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE accountName = ${l.accountName}, title = ${l.title}, address = COALESCE(${l.address}, address), available = 1,
          openStatus = COALESCE(${m.openStatus}, openStatus), mapsUri = COALESCE(${m.mapsUri}, mapsUri), placeId = COALESCE(${m.placeId}, placeId), metaCheckedAt = UTC_TIMESTAMP()`);
    }
    await saveLastRun({ at: mysqlNow(), ok: true, imported: 0, pending: 0, error: null, kind: 'discover' });
    return { found: found.size };
  } catch (error) {
    const message = windsorError(error);
    await saveLastRun({ at: mysqlNow(), ok: false, imported: 0, pending: 0, error: message, kind: 'discover' });
    throw new Error(message);
  }
}

export interface WindsorSyncResult { ok: boolean; skipped?: 'not_configured' | 'off' | 'oauth' | 'busy'; reason?: string; imported: number; pending: number; done: boolean; errors: string[]; aiDrafted?: number }

/**
 * Importa as avaliações pela Windsor para os perfis escolhidos (associados a
 * um parque). Um só pedido para todos os perfis; a 1.ª vez de um perfil vai
 * até 3 anos para trás, depois os últimos 60 dias. `manual` = botão (não
 * precisa do interruptor, mas continua a exigir a chave e a Google não ligada).
 */
export async function syncReviewsFromWindsor(o: { deadline?: number; manual?: boolean; nowMs?: number } = {}, fetchImpl: FetchFn = fetch): Promise<WindsorSyncResult> {
  const deadline = o.deadline ?? Date.now() + 40_000;
  const base = { imported: 0, pending: 0, done: true, errors: [] as string[] };
  if (!windsorConfigured()) return { ok: true, skipped: 'not_configured', reason: 'Falta a chave da Windsor (WINDSOR_API_KEY).', ...base };
  if (await oauthConnected()) return { ok: true, skipped: 'oauth', reason: 'A Google está ligada diretamente; a recolha vai por aí.', ...base };
  if (!o.manual && !(await windsorFlagOn('GBP_WINDSOR_SYNC'))) return { ok: true, skipped: 'off', reason: 'Interruptor GBP_WINDSOR_SYNC desligado.', ...base };
  const lock = await acquireLock();
  if (!lock) return { ok: true, skipped: 'busy', ...base, done: false };
  let imported = 0, pending = 0, done = true; const errors: string[] = [];
  try {
    const { rows } = await import('./service');
    const d = await db();
    const selected = rows<{ id: number; locationName: string; lastSyncAt: string | null; dirtyVersion: number }>(await d.execute(sql`SELECT id, locationName, lastSyncAt, dirtyVersion FROM google_business_locations
      WHERE selected = 1 AND available = 1 AND projectId IS NOT NULL ORDER BY (lastSyncAt IS NULL) DESC, lastSyncAt ASC, id`));
    if (!selected.length) return { ok: true, imported: 0, pending: 0, done: true, errors: [] };
    const firstImport = selected.some((l) => !l.lastSyncAt);
    const win = windsorSyncWindow({ firstImport, nowMs: o.nowMs ?? Date.now() });
    const data = await windsorGet({ fields: REVIEW_FIELDS, dateFrom: win.dateFrom, dateTo: win.dateTo,
      accounts: selected.map((l) => l.locationName), timeoutMs: Math.max(5_000, Math.min(30_000, deadline - Date.now() - 5_000)) }, fetchImpl);
    const byLoc = groupWindsorReviews(data);
    const { importReview } = await import('./service');
    for (const location of selected) {
      if (Date.now() > deadline) { done = false; break; }
      // 1.ª importação deste perfil: não despeja reclamações antigas (mesma regra do OAuth)
      const first = !location.lastSyncAt;
      let complete = true;
      try {
        const existing = new Map(rows<{ name: string; updatedAt: string | null; reply: string | null }>(await d.execute(sql`SELECT googleReviewName AS name,
            googleUpdatedAt AS updatedAt, googleReply AS reply FROM google_reviews WHERE googleLocationId = ${location.id} AND googleReviewName IS NOT NULL`))
          .map((e) => [String(e.name).split('/').pop() || '', { updatedAt: e.updatedAt, reply: e.reply }]));
        const reviews = reviewsToImport(byLoc.get(location.locationName) ?? [], { firstImport: first, nowMs: o.nowMs ?? Date.now(), existing });
        for (const review of reviews) {
          if (Date.now() > deadline) { complete = false; done = false; break; }
          const r = await importReview(location.id, review, null, undefined, { firstImport: first });
          if (r === 'created' || r === 'updated') imported++;
          if (r === 'pending') pending++;
        }
        // Só marca "recolhido" quando passou por todas: senão a 1.ª importação repete (idempotente)
        if (complete) await d.execute(sql`UPDATE google_business_locations SET lastSyncAt = ${mysqlNow()}, lastError = NULL,
          dirtyAt = CASE WHEN dirtyVersion = ${location.dirtyVersion} THEN NULL ELSE dirtyAt END WHERE id = ${location.id}`);
      } catch (error) {
        const message = windsorError(error); errors.push(message);
        await d.execute(sql`UPDATE google_business_locations SET lastError = ${message} WHERE id = ${location.id}`);
      }
      if (!complete) break;
    }
    // Rascunho IA (lite) para as novas — fica por aprovar; nunca publica sozinho.
    let aiDrafted = 0;
    if (Date.now() < deadline - 5_000) {
      try {
        const { draftPendingReviewReplies } = await import('../../reviewAutoDraft');
        aiDrafted = (await draftPendingReviewReplies({ limit: 3, deadlineAt: deadline + 10_000 })).drafted;
      } catch { /* IA opcional */ }
    }
    await saveLastRun({ at: mysqlNow(), ok: !errors.length, imported, pending, error: errors[0] ?? null, kind: 'sync' });
    return { ok: !errors.length, imported, pending, done, errors, aiDrafted };
  } catch (error) {
    const message = windsorError(error);
    await saveLastRun({ at: mysqlNow(), ok: false, imported, pending, error: message, kind: 'sync' });
    return { ok: false, imported, pending, done: false, errors: [message] };
  } finally {
    await releaseLock(lock);
  }
}
