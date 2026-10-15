import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { complaints, googleReviews, projects } from '../../../drizzle/schema';
import { BusinessClient, REPLY_MAX_LENGTH, type GoogleLocation } from './client';
import { accountPattern, locationPattern, normalizeReview, reviewPattern, safeError, shouldOpenComplaint, shouldStopPaging, type GoogleReview } from './domain';
import { accessToken, connection, database, saveConnection } from './oauth';
import { PROVIDER } from './config';
import { reviewAutoDraftEligible } from '../../../shared/reviewRules';

export interface Location {
  id: number; locationName: string; accountName: string; title: string; address: string | null;
  projectId: number | null; selected: number; available: number; nextPageToken: string | null;
  lastSyncAt: string | null; lastError: string | null; dirtyAt: string | null; dirtyVersion: number;
  // 0170 — estado do perfil (lido na listagem, readMask metadata,openInfo)
  hasGoogleUpdated?: number | null; hasPendingEdits?: number | null; hasVoiceOfMerchant?: number | null;
  canOperateLocalPost?: number | null; openStatus?: string | null; mapsUri?: string | null; placeId?: string | null; metaCheckedAt?: string | null;
}
export const rows = <T = any>(result: any): T[] => result[0] as T[];
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const json = <T>(v: unknown): T => typeof v === 'string' ? JSON.parse(v) : v as T;

export async function locations() {
  const db = await database();
  return rows<Location>(await db.execute(sql`SELECT * FROM google_business_locations ORDER BY title`));
}

/** Estado do perfil (0170): verificação, edições pendentes, alterado pela Google, aberto/fechado. PURA. */
export function locationMeta(l: GoogleLocation) {
  const b = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : null);
  const s = (v: unknown, n: number) => (typeof v === 'string' && v ? v.slice(0, n) : null);
  return {
    hasGoogleUpdated: b(l.metadata?.hasGoogleUpdated), hasPendingEdits: b(l.metadata?.hasPendingEdits),
    hasVoiceOfMerchant: b(l.metadata?.hasVoiceOfMerchant), canOperateLocalPost: b(l.metadata?.canOperateLocalPost),
    openStatus: s(l.openInfo?.status, 30), mapsUri: s(l.metadata?.mapsUri, 500), placeId: s(l.metadata?.placeId, 100),
  };
}

export async function refreshLocations(deadline = Date.now() + 35_000) {
  const client = new BusinessClient(await accessToken(), { deadlineAt: deadline });
  const found = new Map<string, { accountName: string; title: string; address: string; meta: ReturnType<typeof locationMeta> }>();
  const accountTokens = new Set<string>(); let accountToken = '';
  do {
    if (Date.now() > deadline || accountTokens.has(accountToken)) throw new Error('Listagem incompleta; volta a atualizar os perfis.');
    accountTokens.add(accountToken);
    const page = await client.accounts(accountToken);
    for (const account of page.accounts || []) {
      if (!accountPattern.test(account.name)) throw new Error('Conta Google inválida.');
      const pageTokens = new Set<string>(); let token = '';
      do {
        if (Date.now() > deadline || pageTokens.has(token)) throw new Error('Listagem incompleta; volta a atualizar os perfis.');
        pageTokens.add(token);
        const result = await client.locations(account.name, token);
        for (const location of result.locations || []) {
          if (!locationPattern.test(location.name)) throw new Error('Local Google inválido.');
          const a = location.storefrontAddress;
          found.set(location.name, { accountName: account.name, title: location.title.slice(0, 256),
            address: [...(a?.addressLines || []), a?.postalCode, a?.locality].filter(Boolean).join(', '), meta: locationMeta(location) });
        }
        token = result.nextPageToken || '';
      } while (token);
    }
    accountToken = page.nextPageToken || '';
  } while (accountToken);
  const db = await database();
  await db.transaction(async tx => {
    // A failed/partial discovery never disables a previous, valid mapping.
    await tx.execute(sql`UPDATE google_business_locations SET available = 0`);
    for (const [name, location] of found) {
      const m = location.meta;
      await tx.execute(sql`INSERT INTO google_business_locations (locationName, accountName, title, address,
          hasGoogleUpdated, hasPendingEdits, hasVoiceOfMerchant, canOperateLocalPost, openStatus, mapsUri, placeId, metaCheckedAt)
        VALUES (${name}, ${location.accountName}, ${location.title}, ${location.address},
          ${m.hasGoogleUpdated}, ${m.hasPendingEdits}, ${m.hasVoiceOfMerchant}, ${m.canOperateLocalPost}, ${m.openStatus}, ${m.mapsUri}, ${m.placeId}, UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE accountName = ${location.accountName}, title = ${location.title}, address = ${location.address}, available = 1,
          hasGoogleUpdated = ${m.hasGoogleUpdated}, hasPendingEdits = ${m.hasPendingEdits}, hasVoiceOfMerchant = ${m.hasVoiceOfMerchant},
          canOperateLocalPost = ${m.canOperateLocalPost}, openStatus = ${m.openStatus}, mapsUri = ${m.mapsUri}, placeId = ${m.placeId}, metaCheckedAt = UTC_TIMESTAMP()`);
    }
  });
  await saveConnection({ lastError: null, lastCheckedAt: now() });
  return { found: found.size };
}

export async function mapLocation(id: number, projectId: number | null, selected: boolean) {
  const db = await database();
  await db.transaction(async tx => {
    const [location] = rows<Location>(await tx.execute(sql`SELECT * FROM google_business_locations WHERE id = ${id} FOR UPDATE`));
    if (!location) throw new Error('Perfil não encontrado.');
    if (selected && (!projectId || !location.available)) throw new Error('Seleciona um projeto e um perfil disponível.');
    if (projectId && !(await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1)).length) throw new Error('Projeto inválido.');
    const imported = await tx.select({ id: googleReviews.id }).from(googleReviews).where(eq(googleReviews.googleLocationId, id)).limit(1);
    if (imported.length && projectId !== location.projectId) throw new Error('Este perfil já tem avaliações importadas. A mudança de parque exige reconciliação do histórico.');
    await tx.execute(sql`UPDATE google_business_locations SET projectId = ${projectId}, selected = ${selected ? 1 : 0},
      nextPageToken = NULL, dirtyAt = UTC_TIMESTAMP(), dirtyVersion = dirtyVersion + 1 WHERE id = ${id}`);
  });
}

/** Atomic review + complaint. All delivery retries share the same Google key.
 * Ambiguous email history is kept pending until a person chooses a match. */
export async function importReview(locationId: number, payload: GoogleReview, userId: number | null,
  resolution?: { existingId: number | null }, opts: { firstImport?: boolean; nowMs?: number; dedup?: boolean } = {}) {
  const db = await database();
  if (opts.dedup === undefined && !resolution) {
    const { reviewFlagOn } = await import('../../reviewCleanup');
    opts = { ...opts, dedup: await reviewFlagOn('REVIEWS_DEDUP') };
  }
  return db.transaction(async tx => {
    const [location] = rows<Location>(await tx.execute(sql`SELECT * FROM google_business_locations WHERE id = ${locationId} FOR UPDATE`));
    if (!location?.selected || !location.available || !location.projectId) throw new Error('Perfil sem associação ativa a um parque.');
    const review = normalizeReview(location.locationName, payload);
    // Nome do recurso — é o que permite responder pela API (0073).
    const reviewName = `${location.accountName}/${location.locationName}/reviews/${payload.reviewId}`;
    if (!reviewPattern.test(reviewName)) throw new Error('Identificador Google inválido.');
    let [existing] = await tx.select().from(googleReviews).where(eq(googleReviews.googleReviewKey, review.key)).limit(1).for('update');
    if (existing?.googleUpdatedAt && existing.googleReviewName && (existing.googleUpdatedAt > review.updated ||
      (existing.googleUpdatedAt === review.updated && existing.googleReply === review.reply && existing.respondedAt === review.replyAt))) return 'unchanged' as const;
    if (!existing) {
      if (resolution?.existingId) {
        [existing] = await tx.select().from(googleReviews).where(eq(googleReviews.id, resolution.existingId)).limit(1).for('update');
        if (!existing || existing.googleReviewKey || (existing.projectId !== null && existing.projectId !== location.projectId)) throw new Error('A crítica escolhida já está associada ou pertence a outro parque.');
        // Plano MPV F6b: uma crítica marcada (não é crítica / repetida) não se liga — desfaz-se primeiro.
        if (Number(existing.notAReview ?? 0) === 1 || existing.duplicateOf != null) throw new Error('A crítica escolhida está marcada como "não é crítica" ou "repetida" — desfaz a marca em Críticas → Limpeza antes de a ligar.');
      } else if (!resolution) {
        // Plano MPV F6b: as marcadas (não é crítica / repetida) nunca são candidatas.
        const byName = await tx.select({ id: googleReviews.id }).from(googleReviews).where(and(
          isNull(googleReviews.googleReviewKey), or(eq(googleReviews.projectId, location.projectId), isNull(googleReviews.projectId)),
          eq(googleReviews.notAReview, 0), isNull(googleReviews.duplicateOf),
          eq(googleReviews.reviewerName, review.reviewerName),
          or(eq(googleReviews.rating, review.rating), eq(googleReviews.rating, 0)))).limit(30);
        // R3 (REVIEWS_DEDUP): também a de email com as MESMAS estrelas e o MESMO
        // texto (o nome do email vinha muitas vezes errado: "Google Business
        // Profile", só o 1.º nome). Fica por conciliar — uma pessoa escolhe.
        const byText = opts.dedup ? await emailCandidatesByText(tx, location.projectId, review) : [];
        const candidates = [...new Map([...byName, ...byText].map((c) => [c.id, c])).values()].slice(0, 30);
        if (candidates.length) {
          await tx.execute(sql`INSERT INTO google_business_review_pending (reviewKey, locationId, payload, candidates)
            VALUES (${review.key}, ${locationId}, ${JSON.stringify(payload)}, ${JSON.stringify(candidates.map(c => c.id))})
            ON DUPLICATE KEY UPDATE payload = ${JSON.stringify(payload)}, candidates = ${JSON.stringify(candidates.map(c => c.id))}`);
          return 'pending' as const;
        }
      }
    }
    const contentChanged = existing && (existing.rating !== review.rating || existing.reviewText !== review.reviewText);
    const data = { googleReviewKey: review.key, googleLocationId: locationId, googleUpdatedAt: review.updated,
      googleReviewName: reviewName,
      googleReply: review.reply, reviewerName: review.reviewerName, rating: review.rating,
      reviewText: review.reviewText, reviewDate: review.reviewDate, projectId: location.projectId };
    let id: number;
    if (existing) {
      id = existing.id;
      await tx.update(googleReviews).set({ ...data,
        // Texto/estrelas mudaram: o rascunho volta a "por aprovar" (16d — o texto
        // fica, pode ser de uma pessoa; "Regenerar" faz um novo).
        ...(contentChanged ? { aiResponseApproved: 0 } : {}),
        ...(review.reply ? { respondedAt: review.replyAt, status: existing.complaintId ? 'converted_complaint' as const : 'manually_responded' as const }
          : { respondedAt: null, status: existing.complaintId ? 'converted_complaint' as const : existing.status === 'dismissed' ? 'dismissed' as const : 'pending_response' as const }),
      }).where(eq(googleReviews.id, id));
    } else {
      const result = await tx.insert(googleReviews).values({ ...data, createdById: userId,
        importedAt: now(), respondedAt: review.replyAt, status: review.reply ? 'manually_responded' : 'pending_response',
        // MPV R1: na 1.ª importação de um perfil (histórico todo de uma vez) as
        // críticas ANTIGAS (fora dos 14 dias) ficam marcadas como já tentadas —
        // nunca rascunho automático. As recentes ficam por marcar: se a 1.ª
        // importação nunca chegar ao fim, não perdem o rascunho. "Gerar" à mão
        // continua a funcionar.
        ...(opts.firstImport && !reviewAutoDraftEligible({ reviewDate: review.reviewDate }, opts.nowMs ?? Date.now())
          ? { aiDraftAttemptedAt: now() } : {}) });
      id = result[0].insertId;
    }
    if (shouldOpenComplaint({ rating: review.rating, hasComplaint: !!existing?.complaintId, dismissed: existing?.status === 'dismissed',
      firstImport: !!opts.firstImport, updatedIso: review.updated, hasReply: !!review.reply, nowMs: opts.nowMs })) {
      const result = await tx.insert(complaints).values({ title: `Crítica Google ${review.rating}★ — ${review.reviewerName}`.slice(0, 255),
        description: review.reviewText || 'Avaliação sem texto.', complaintType: 'other', complaintStatus: 'new',
        complaintPriority: review.rating === 1 ? 'urgent' : 'high', clientName: review.reviewerName,
        projectId: location.projectId, createdById: userId, origin: 'critica',
        slaDeadline: new Date(Date.now() + 86_400_000).toISOString().slice(0, 19).replace('T', ' ') });
      await tx.update(googleReviews).set({ complaintId: result[0].insertId, status: 'converted_complaint' }).where(eq(googleReviews.id, id));
    }
    await tx.execute(sql`DELETE FROM google_business_review_pending WHERE reviewKey = ${review.key}`);
    return existing ? 'updated' as const : 'created' as const;
  });
}

/**
 * Críticas de EMAIL (sem chave Google) que são esta da API/Windsor pelas
 * estrelas + texto (plano MPV F6b, R3): mesmo parque ou sem parque, ±48 h,
 * texto da crítica igual com 20 ou mais caracteres; o 1.º nome só impede se
 * os dois forem conhecidos e diferentes (shared/reviewDedup.ts `sameReview`).
 */
async function emailCandidatesByText(tx: any, projectId: number, review: ReturnType<typeof normalizeReview>): Promise<Array<{ id: number }>> {
  const { REVIEW_DEDUP_MIN_TEXT, REVIEW_DEDUP_WINDOW_HOURS, reviewDateMs, reviewTextKeyFromApi, reviewerNameKey, sameReview } = await import('../../../shared/reviewDedup');
  const textKey = reviewTextKeyFromApi(review.reviewText);
  const atMs = reviewDateMs(review.reviewDate);
  if (textKey.length < REVIEW_DEDUP_MIN_TEXT || atMs == null || !(review.rating >= 1)) return [];
  const at = new Date(atMs).toISOString().slice(0, 19).replace('T', ' ');
  const rows = await tx.select({ id: googleReviews.id, reviewerName: googleReviews.reviewerName, rating: googleReviews.rating, reviewText: googleReviews.reviewText,
    reviewDate: googleReviews.reviewDate, sourceEmailDate: googleReviews.sourceEmailDate, createdAt: googleReviews.createdAt, projectId: googleReviews.projectId,
    googleReviewKey: googleReviews.googleReviewKey, sourceEmailId: googleReviews.sourceEmailId }).from(googleReviews).where(and(
    isNull(googleReviews.googleReviewKey), or(eq(googleReviews.projectId, projectId), isNull(googleReviews.projectId)),
    eq(googleReviews.notAReview, 0), isNull(googleReviews.duplicateOf),
    or(eq(googleReviews.rating, review.rating), eq(googleReviews.rating, 0)),
    sql`COALESCE(${googleReviews.reviewDate}, ${googleReviews.sourceEmailDate}, ${googleReviews.createdAt}) BETWEEN DATE_SUB(${at}, INTERVAL ${REVIEW_DEDUP_WINDOW_HOURS} HOUR) AND DATE_ADD(${at}, INTERVAL ${REVIEW_DEDUP_WINDOW_HOURS} HOUR)`,
  )).limit(50);
  const { dedupFactsOfRow, emailParser, loadRawEmails } = await import('../../reviewCleanup');
  const parse = await emailParser();
  const raw = await loadRawEmails(tx, rows.map((r: any) => r.sourceEmailId));
  const me = { id: -1, parkKey: `p${projectId}`, rating: review.rating, textKey, name: reviewerNameKey(review.reviewerName), atMs, apiKey: true };
  return rows.filter((r: any) => sameReview(me, dedupFactsOfRow(r, parse, r.sourceEmailId ? raw.get(String(r.sourceEmailId)) : null), { requireName: false })).map((r: any) => ({ id: Number(r.id) }));
}

/**
 * Por onde sai uma resposta agora: Google direto quando ligado; senão a
 * Windsor (chave + interruptor GBP_WINDSOR_REPLY); senão 'none'. Também usado
 * pelas 5★ automáticas (plano MPV F7) para não tentar publicar sem canal.
 */
export async function currentReplyChannel(): Promise<'google' | 'windsor' | 'none'> {
  const w = await import('./windsor');
  const conn = await connection();
  return w.replyChannel({ oauthConnected: !!conn?.refreshTokenEnc && conn.status === 'connected',
    windsorConfigured: w.windsorConfigured(), windsorReplyOn: w.windsorConfigured() && await w.windsorFlagOn('GBP_WINDSOR_REPLY') });
}

/**
 * Publica no Google a resposta escrita no dashboard (pedido do Jorge,
 * 2026-09-16: "receber a crítica e responder pela dashboard"). Só para
 * críticas importadas pela API (têm `googleReviewName`); as que vieram por
 * email não têm ligação ao Google e a resposta fica só local.
 *
 * Grava primeiro no Google e só depois na BD: se a Google recusar (quota 0,
 * conta sem permissão no perfil), nada muda cá dentro.
 */
export async function publishReply(reviewId: number, comment: string, userId: number) {
  const text = comment.trim();
  if (!text) throw new Error('Escreve a resposta antes de publicar.');
  if (text.length > REPLY_MAX_LENGTH) throw new Error(`A resposta tem de ter no máximo ${REPLY_MAX_LENGTH} caracteres.`);
  const db = await database();
  const [review] = await db.select({ id: googleReviews.id, name: googleReviews.googleReviewName, complaintId: googleReviews.complaintId })
    .from(googleReviews).where(eq(googleReviews.id, reviewId)).limit(1);
  if (!review) throw new Error('Crítica não encontrada.');
  if (!review.name || !reviewPattern.test(review.name)) {
    throw new Error('Esta crítica veio por email e não está ligada ao Google. Responde diretamente no perfil Google, ou espera que a importação pela API a associe.');
  }
  // 33a: Google direto quando ligado; senão pela Windsor (chave + interruptor GBP_WINDSOR_REPLY).
  const w = await import('./windsor');
  const channel = await currentReplyChannel();
  if (channel === 'none') {
    throw new Error(w.windsorConfigured()
      ? 'A Google não está ligada diretamente e a resposta pela Windsor está desligada (Definições → Automações → GBP_WINDSOR_REPLY).'
      : 'Google Business Profile desligado: liga a conta Google ou a Windsor para publicar daqui.');
  }
  let published: { comment?: string; updateTime?: string };
  if (channel === 'google') {
    const client = new BusinessClient(await accessToken());
    published = await client.reply(review.name, text);
  } else {
    await w.replyViaWindsor(review.name, text);
    published = { comment: text };
  }
  const at = published.updateTime && Number.isFinite(Date.parse(published.updateTime))
    ? new Date(published.updateTime).toISOString().slice(0, 19).replace('T', ' ') : now();
  await db.update(googleReviews).set({
    googleReply: published.comment || text, aiResponse: text, aiResponseApproved: 1, respondedAt: at, respondedBy: userId,
    status: review.complaintId ? 'converted_complaint' : 'manually_responded',
  }).where(eq(googleReviews.id, reviewId));
  return { publishedAt: at, channel };
}

export async function pendingReviews() {
  const db = await database();
  const pending = rows<any>(await db.execute(sql`SELECT p.*, l.title FROM google_business_review_pending p
    JOIN google_business_locations l ON l.id = p.locationId ORDER BY p.createdAt LIMIT 100`)).map(p => ({
    key: String(p.reviewKey), locationId: Number(p.locationId), title: String(p.title),
    review: json<GoogleReview>(p.payload), candidates: json<number[]>(p.candidates),
  }));
  const ids = [...new Set(pending.flatMap(p => p.candidates))];
  const candidates = ids.length ? await db.select({ id: googleReviews.id, reviewerName: googleReviews.reviewerName,
    rating: googleReviews.rating, reviewText: googleReviews.reviewText, reviewDate: googleReviews.reviewDate,
    complaintId: googleReviews.complaintId }).from(googleReviews)
    // Plano MPV F6b: as marcadas (não é crítica / repetida) não são oferecidas.
    .where(and(inArray(googleReviews.id, ids), eq(googleReviews.notAReview, 0), isNull(googleReviews.duplicateOf))) : [];
  return pending.map(p => ({ ...p, candidateReviews: candidates.filter(c => p.candidates.includes(c.id)) }));
}
export async function resolvePending(key: string, existingId: number | null, userId: number) {
  const db = await database();
  const [pending] = rows<any>(await db.execute(sql`SELECT * FROM google_business_review_pending WHERE reviewKey = ${key}`));
  if (!pending) throw new Error('Avaliação pendente não encontrada.');
  if (existingId && !json<number[]>(pending.candidates).includes(existingId)) throw new Error('Escolhe uma das críticas candidatas.');
  return importReview(Number(pending.locationId), json<GoogleReview>(pending.payload), userId, { existingId });
}

export async function syncReviews(deadline = Date.now() + 35_000) {
  const conn = await connection();
  if (!conn?.refreshTokenEnc || conn.status === 'disconnected') return { ok: true, skipped: 'disconnected', imported: 0, pending: 0, done: true };
  // Reautorização pendente: não é um 500 — o alerta (Integrações) avisa quem tem de religar.
  if (conn.status === 'reauth_required') return { ok: true, skipped: 'reauth_required', reason: 'Google Business Profile precisa de ser religado (Críticas).', imported: 0, pending: 0, done: true };
  const db = await database();
  const lock = now();
  const acquired = await db.execute(sql`UPDATE integration_connections SET syncLockAt = ${lock}
    WHERE provider = ${PROVIDER} AND (syncLockAt IS NULL OR syncLockAt < UTC_TIMESTAMP() - INTERVAL 20 MINUTE)`);
  if (!(acquired[0] as any).affectedRows) return { ok: true, skipped: 'busy', imported: 0, pending: 0, done: false };
  let imported = 0, pending = 0, done = true, stoppedEarly = 0; const errors: string[] = [];
  try {
    let client: BusinessClient;
    try { client = new BusinessClient(await accessToken(), { deadlineAt: deadline }); }
    catch (error) {
      // A renovação acabou de marcar reauth_required (invalid_grant) → saltado, não 500.
      const after = await connection();
      if (after?.status === 'reauth_required') return { ok: true, skipped: 'reauth_required', reason: 'Google Business Profile precisa de ser religado (Críticas).', imported: 0, pending: 0, done: true };
      throw error;
    }
    const selected = rows<Location>(await db.execute(sql`SELECT * FROM google_business_locations
      WHERE selected = 1 AND available = 1 AND projectId IS NOT NULL
      ORDER BY (dirtyAt IS NOT NULL) DESC, (nextPageToken IS NOT NULL) DESC, lastSyncAt ASC, id`));
    for (const location of selected) {
      if (Date.now() > deadline) { done = false; break; }
      // 1.ª importação = o perfil nunca completou uma volta (lastSyncAt vazio)
      const firstImport = !location.lastSyncAt;
      const backfill = firstImport || !!location.nextPageToken;
      try {
        let token = location.nextPageToken || '';
        const seen = new Set<string>();
        do {
          if (seen.has(token)) throw new Error('A Google repetiu uma página de avaliações.');
          seen.add(token);
          const page = await client.reviews(location.accountName, location.locationName, token);
          const results: string[] = [];
          for (const review of page.reviews || []) {
            if (Date.now() > deadline) { done = false; break; }
            const result = await importReview(location.id, review, conn.connectedById, undefined, { firstImport });
            results.push(result);
            if (result === 'created' || result === 'updated') imported++;
            if (result === 'pending') pending++;
          }
          // On timeout replay the current page; durable review keys make that safe.
          if (!done) break;
          token = page.nextPageToken || '';
          // Ordem updateTime desc: página toda igual → o resto também está (fora de backfill/dirty).
          if (token && shouldStopPaging({ results, backfill, dirty: !!location.dirtyAt })) { token = ''; stoppedEarly++; }
          await db.execute(sql`UPDATE google_business_locations SET nextPageToken = ${token || null}, lastError = NULL,
            lastSyncAt = ${token ? location.lastSyncAt : now()},
            dirtyAt = CASE WHEN ${token} = '' AND dirtyVersion = ${location.dirtyVersion} THEN NULL ELSE dirtyAt END WHERE id = ${location.id}`);
        } while (token && Date.now() <= deadline);
        if (token) done = false;
        if (!done) break;
      } catch (error) {
        const message = safeError(error); errors.push(message);
        await db.execute(sql`UPDATE google_business_locations SET lastError = ${message} WHERE id = ${location.id}`);
      }
    }
    await saveConnection({ lastCheckedAt: now(), lastError: errors[0] || null });
    // Rascunho IA (lite) para as críticas novas — fica por aprovar, nunca
    // publica sozinho. Lote pequeno e só com tempo; interruptor/orçamento → salta.
    let aiDrafted = 0;
    if (Date.now() < deadline - 5_000) {
      try {
        const { draftPendingReviewReplies } = await import('../../reviewAutoDraft');
        aiDrafted = (await draftPendingReviewReplies({ limit: 3, deadlineAt: deadline + 15_000 })).drafted;
      } catch { /* IA opcional: a recolha já terminou */ }
    }
    return { ok: !errors.length, done, imported, pending, stoppedEarly, errors, aiDrafted };
  } finally {
    await db.execute(sql`UPDATE integration_connections SET syncLockAt = NULL WHERE provider = ${PROVIDER} AND syncLockAt = ${lock}`);
  }
}
