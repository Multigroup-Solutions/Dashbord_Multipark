import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { complaints, googleReviews, projects } from '../../../drizzle/schema';
import { BusinessClient } from './client';
import { accountPattern, locationPattern, normalizeReview, safeError, type GoogleReview } from './domain';
import { accessToken, connection, database, saveConnection } from './oauth';
import { PROVIDER } from './config';

export interface Location {
  id: number; locationName: string; accountName: string; title: string; address: string | null;
  projectId: number | null; selected: number; available: number; nextPageToken: string | null;
  lastSyncAt: string | null; lastError: string | null; dirtyAt: string | null; dirtyVersion: number;
}
export const rows = <T = any>(result: any): T[] => result[0] as T[];
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const json = <T>(v: unknown): T => typeof v === 'string' ? JSON.parse(v) : v as T;

export async function locations() {
  const db = await database();
  return rows<Location>(await db.execute(sql`SELECT * FROM google_business_locations ORDER BY title`));
}

export async function refreshLocations(deadline = Date.now() + 35_000) {
  const client = new BusinessClient(await accessToken());
  const found = new Map<string, { accountName: string; title: string; address: string }>();
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
            address: [...(a?.addressLines || []), a?.postalCode, a?.locality].filter(Boolean).join(', ') });
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
      await tx.execute(sql`INSERT INTO google_business_locations (locationName, accountName, title, address)
        VALUES (${name}, ${location.accountName}, ${location.title}, ${location.address})
        ON DUPLICATE KEY UPDATE accountName = ${location.accountName}, title = ${location.title}, address = ${location.address}, available = 1`);
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
  resolution?: { existingId: number | null }) {
  const db = await database();
  return db.transaction(async tx => {
    const [location] = rows<Location>(await tx.execute(sql`SELECT * FROM google_business_locations WHERE id = ${locationId} FOR UPDATE`));
    if (!location?.selected || !location.available || !location.projectId) throw new Error('Perfil sem associação ativa a um parque.');
    const review = normalizeReview(location.locationName, payload);
    let [existing] = await tx.select().from(googleReviews).where(eq(googleReviews.googleReviewKey, review.key)).limit(1).for('update');
    if (existing?.googleUpdatedAt && (existing.googleUpdatedAt > review.updated ||
      (existing.googleUpdatedAt === review.updated && existing.googleReply === review.reply && existing.respondedAt === review.replyAt))) return 'unchanged' as const;
    if (!existing) {
      if (resolution?.existingId) {
        [existing] = await tx.select().from(googleReviews).where(eq(googleReviews.id, resolution.existingId)).limit(1).for('update');
        if (!existing || existing.googleReviewKey || (existing.projectId !== null && existing.projectId !== location.projectId)) throw new Error('A crítica escolhida já está associada ou pertence a outro parque.');
      } else if (!resolution) {
        const candidates = await tx.select({ id: googleReviews.id }).from(googleReviews).where(and(
          isNull(googleReviews.googleReviewKey), or(eq(googleReviews.projectId, location.projectId), isNull(googleReviews.projectId)),
          eq(googleReviews.reviewerName, review.reviewerName),
          or(eq(googleReviews.rating, review.rating), eq(googleReviews.rating, 0)))).limit(30);
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
      googleReply: review.reply, reviewerName: review.reviewerName, rating: review.rating,
      reviewText: review.reviewText, reviewDate: review.reviewDate, projectId: location.projectId };
    let id: number;
    if (existing) {
      id = existing.id;
      await tx.update(googleReviews).set({ ...data,
        ...(contentChanged ? { aiResponse: null, aiResponseApproved: 0 } : {}),
        ...(review.reply ? { respondedAt: review.replyAt, status: existing.complaintId ? 'converted_complaint' as const : 'manually_responded' as const }
          : { respondedAt: null, status: existing.complaintId ? 'converted_complaint' as const : existing.status === 'dismissed' ? 'dismissed' as const : 'pending_response' as const }),
      }).where(eq(googleReviews.id, id));
    } else {
      const result = await tx.insert(googleReviews).values({ ...data, createdById: userId,
        importedAt: now(), respondedAt: review.replyAt, status: review.reply ? 'manually_responded' : 'pending_response' });
      id = result[0].insertId;
    }
    if (review.rating <= 3 && !existing?.complaintId && existing?.status !== 'dismissed') {
      const result = await tx.insert(complaints).values({ title: `Crítica Google ${review.rating}★ — ${review.reviewerName}`.slice(0, 255),
        description: review.reviewText || 'Avaliação sem texto.', complaintType: 'other', complaintStatus: 'new',
        complaintPriority: review.rating === 1 ? 'urgent' : 'high', clientName: review.reviewerName,
        projectId: location.projectId, createdById: userId,
        slaDeadline: new Date(Date.now() + 86_400_000).toISOString().slice(0, 19).replace('T', ' ') });
      await tx.update(googleReviews).set({ complaintId: result[0].insertId, status: 'converted_complaint' }).where(eq(googleReviews.id, id));
    }
    await tx.execute(sql`DELETE FROM google_business_review_pending WHERE reviewKey = ${review.key}`);
    return existing ? 'updated' as const : 'created' as const;
  });
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
    complaintId: googleReviews.complaintId }).from(googleReviews).where(inArray(googleReviews.id, ids)) : [];
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
  const db = await database();
  const lock = now();
  const acquired = await db.execute(sql`UPDATE integration_connections SET syncLockAt = ${lock}
    WHERE provider = ${PROVIDER} AND (syncLockAt IS NULL OR syncLockAt < UTC_TIMESTAMP() - INTERVAL 20 MINUTE)`);
  if (!(acquired[0] as any).affectedRows) return { ok: true, skipped: 'busy', imported: 0, pending: 0, done: false };
  let imported = 0, pending = 0, done = true; const errors: string[] = [];
  try {
    const client = new BusinessClient(await accessToken());
    const selected = rows<Location>(await db.execute(sql`SELECT * FROM google_business_locations
      WHERE selected = 1 AND available = 1 AND projectId IS NOT NULL
      ORDER BY (dirtyAt IS NOT NULL) DESC, (nextPageToken IS NOT NULL) DESC, lastSyncAt ASC, id`));
    for (const location of selected) {
      if (Date.now() > deadline) { done = false; break; }
      try {
        let token = location.nextPageToken || '';
        const seen = new Set<string>();
        do {
          if (seen.has(token)) throw new Error('A Google repetiu uma página de avaliações.');
          seen.add(token);
          const page = await client.reviews(location.accountName, location.locationName, token);
          for (const review of page.reviews || []) {
            if (Date.now() > deadline) { done = false; break; }
            const result = await importReview(location.id, review, conn.connectedById);
            if (result === 'created' || result === 'updated') imported++;
            if (result === 'pending') pending++;
          }
          // On timeout replay the current page; durable review keys make that safe.
          if (!done) break;
          token = page.nextPageToken || '';
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
    return { ok: !errors.length, done, imported, pending, errors };
  } finally {
    await db.execute(sql`UPDATE integration_connections SET syncLockAt = NULL WHERE provider = ${PROVIDER} AND syncLockAt = ${lock}`);
  }
}
