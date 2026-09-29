import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { complaints, googleReviews } from '../../../drizzle/schema';
vi.mock('./oauth', () => ({ database: vi.fn(), accessToken: vi.fn(), connection: vi.fn(), saveConnection: vi.fn() }));
import { connection, database } from './oauth';
import { importReview, syncReviews } from './service';
const dialect = new MySqlDialect();
const payload = { reviewId: 'test-review', starRating: 'ONE', reviewer: { displayName: 'Pessoa teste' }, comment: 'Comentário de teste',
  createTime: '2026-09-01T12:00:00Z', updateTime: '2026-09-02T12:00:00Z' };
let reviewRows: any[], complaintRows: any[], pending: number, failComplaint: boolean, selected: number;

beforeEach(() => {
  reviewRows = []; complaintRows = []; pending = 0; failComplaint = false; selected = 1;
  const tx: any = {
    execute: async (statement: any) => {
      const query = dialect.sqlToQuery(statement).sql;
      if (query.startsWith('SELECT * FROM google_business_locations')) return [[{ id: 1, accountName: 'accounts/77', locationName: 'locations/123', selected, available: 1, projectId: 9 }]];
      if (query.startsWith('INSERT INTO google_business_review_pending')) pending++;
      if (query.startsWith('DELETE FROM google_business_review_pending')) pending = 0;
      return [{ affectedRows: 1 }];
    },
    select: (fields?: any) => {
      let condition: any;
      const result = () => {
        const q = dialect.sqlToQuery(condition);
        if (fields) return reviewRows.filter(r => !r.googleReviewKey).map(r => ({ id: r.id }));
        const key = q.params[0];
        return reviewRows.filter(r => typeof key === 'number' ? r.id === key : r.googleReviewKey === key).map(r => ({ ...r }));
      };
      const builder: any = { from: () => builder, where: (v: any) => { condition = v; return builder; }, limit: () => builder,
        for: async () => result(), then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject) };
      return builder;
    },
    insert: (table: any) => ({ values: async (data: any) => {
      if (table === complaints && failComplaint) throw new Error('Complaint write failed');
      const target = table === complaints ? complaintRows : reviewRows;
      const id = target.length + 1;
      target.push({ id, complaintId: null, googleReviewKey: null, ...data });
      return [{ insertId: id }];
    } }),
    update: (table: any) => ({ set: (data: any) => ({ where: async (condition: any) => {
      const id = dialect.sqlToQuery(condition).params[0];
      const row = (table === googleReviews ? reviewRows : complaintRows).find(r => r.id === id);
      if (row) Object.assign(row, data);
      return [{ affectedRows: row ? 1 : 0 }];
    } }) }),
  };
  vi.mocked(database).mockResolvedValue({ transaction: async (work: any) => {
    const backup = structuredClone({ reviewRows, complaintRows, pending });
    try { return await work(tx); } catch (error) {
      reviewRows = backup.reviewRows; complaintRows = backup.complaintRows; pending = backup.pending; throw error;
    }
  } } as any);
});
describe('durable review imports', () => {
  it('replaying the same low-rated review opens exactly one complaint', async () => {
    expect(await importReview(1, payload, 10)).toBe('created');
    expect(await importReview(1, payload, 10)).toBe('unchanged');
    expect(reviewRows).toHaveLength(1); expect(complaintRows).toHaveLength(1);
    expect(reviewRows[0].complaintId).toBe(complaintRows[0].id);
    // Nome do recurso guardado (0073) — é o que permite responder pela API.
    expect(reviewRows[0].googleReviewName).toBe('accounts/77/locations/123/reviews/test-review');
  });
  it('a lower rating updates the review and opens one case without losing its identity', async () => {
    await importReview(1, { ...payload, starRating: 'FIVE' }, 10);
    expect(complaintRows).toHaveLength(0);
    const lowered = { ...payload, updateTime: '2026-09-03T12:00:00Z' };
    expect(await importReview(1, lowered, 10)).toBe('updated');
    await importReview(1, { ...lowered, updateTime: '2026-09-04T12:00:00Z' }, 10);
    expect(reviewRows).toHaveLength(1); expect(complaintRows).toHaveLength(1);
  });
  it('refreshes a public reply even when the review timestamp has not changed', async () => {
    const positive = { ...payload, starRating: 'FIVE' };
    await importReview(1, positive, 10);
    const replied = { ...positive, reviewReply: { comment: 'Obrigado pela avaliação.', updateTime: '2026-09-04T12:00:00Z' } };
    expect(await importReview(1, replied, 10)).toBe('updated');
    expect(reviewRows[0].googleReply).toBe('Obrigado pela avaliação.');
    expect(await importReview(1, replied, 10)).toBe('unchanged');
    expect(complaintRows).toHaveLength(0);
  });
  it('uma linha importada antes da 0073 (sem nome do recurso) é atualizada uma vez para o ganhar', async () => {
    await importReview(1, { ...payload, starRating: 'FIVE' }, 10);
    reviewRows[0].googleReviewName = null;
    expect(await importReview(1, { ...payload, starRating: 'FIVE' }, 10)).toBe('updated');
    expect(reviewRows[0].googleReviewName).toBe('accounts/77/locations/123/reviews/test-review');
    expect(await importReview(1, { ...payload, starRating: 'FIVE' }, 10)).toBe('unchanged');
  });
  it('rolls the review back if complaint creation fails, allowing safe retry', async () => {
    failComplaint = true;
    await expect(importReview(1, payload, 10)).rejects.toThrow('Complaint write failed');
    expect(reviewRows).toHaveLength(0);
    failComplaint = false;
    await importReview(1, payload, 10);
    expect(reviewRows).toHaveLength(1); expect(complaintRows).toHaveLength(1);
  });
  it('blocks a park whose mapping is disabled', async () => {
    selected = 0;
    await expect(importReview(1, payload, 10)).rejects.toThrow(/associação/);
    expect(reviewRows).toHaveLength(0); expect(complaintRows).toHaveLength(0);
  });
  it('keeps a possible email duplicate pending instead of opening another complaint', async () => {
    reviewRows.push({ id: 7, googleReviewKey: null, projectId: 9, complaintId: 12, rating: 1, reviewerName: 'Pessoa teste' });
    expect(await importReview(1, payload, 10)).toBe('pending');
    expect(pending).toBe(1); expect(reviewRows).toHaveLength(1); expect(complaintRows).toHaveLength(0);
    expect(await importReview(1, payload, 10, { existingId: 7 })).toBe('updated');
    expect(reviewRows[0].complaintId).toBe(12); expect(pending).toBe(0); expect(complaintRows).toHaveLength(0);
  });
  it('1.ª importação: crítica antiga ou já respondida entra sem abrir reclamação', async () => {
    const nowMs = Date.parse('2026-09-24T12:00:00Z');
    expect(await importReview(1, { ...payload, reviewId: 'antiga', updateTime: '2026-08-01T12:00:00Z' }, 10, undefined, { firstImport: true, nowMs })).toBe('created');
    expect(await importReview(1, { ...payload, reviewId: 'respondida', updateTime: '2026-09-22T12:00:00Z',
      reviewReply: { comment: 'Lamentamos.', updateTime: '2026-09-23T12:00:00Z' } }, 10, undefined, { firstImport: true, nowMs })).toBe('created');
    expect(complaintRows).toHaveLength(0);
    expect(await importReview(1, { ...payload, reviewId: 'recente', updateTime: '2026-09-22T12:00:00Z' }, 10, undefined, { firstImport: true, nowMs })).toBe('created');
    expect(complaintRows).toHaveLength(1);
  });
  it('does not bind a manually selected review from a different park', async () => {
    reviewRows.push({ id: 7, googleReviewKey: null, projectId: 20 });
    await expect(importReview(1, payload, 10, { existingId: 7 })).rejects.toThrow(/outro parque/);
    expect(reviewRows[0].projectId).toBe(20);
  });
  it('reautorização pendente → saltado (não 500), sem tocar na BD', async () => {
    vi.mocked(connection).mockResolvedValue({ refreshTokenEnc: 'enc', status: 'reauth_required' } as any);
    vi.mocked(database).mockClear();
    await expect(syncReviews()).resolves.toMatchObject({ ok: true, skipped: 'reauth_required', done: true });
    expect(database).not.toHaveBeenCalled();
  });
});
