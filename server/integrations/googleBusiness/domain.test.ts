import { afterEach, describe, expect, it, vi } from 'vitest';
import { consentUrl } from './config';
import { normalizeReview, notificationLocation } from './domain';
import { BusinessClient } from './client';
const review = { reviewId: 'ABC_def-123', starRating: 'ONE', createTime: '2026-09-01T12:00:00Z', updateTime: '2026-09-02T12:00:00Z', reviewer: { displayName: 'Teste' } };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('Google review identity and requests', () => {
  it('distinguishes locations and case-sensitive Google review identifiers', () => {
    const a = normalizeReview('locations/1', review);
    expect(a.rating).toBe(1);
    expect(a.key).toHaveLength(64);
    expect(a.key).not.toBe(normalizeReview('locations/2', review).key);
    expect(a.key).not.toBe(normalizeReview('locations/1', { ...review, reviewId: 'abc_def-123' }).key);
  });
  it.each([{ ...review, starRating: 'STAR_RATING_UNSPECIFIED' }, { ...review, updateTime: 'invalid' }, { ...review, reviewId: '../token' }])('rejects malformed upstream reviews', r => {
    expect(() => normalizeReview('locations/1', r)).toThrow();
  });
  it('parses current and legacy review notification names', () => {
    expect(notificationLocation({ notificationType: 'NEW_REVIEW', reviewName: 'accounts/2/locations/1/reviews/abc' })).toBe('locations/1');
    expect(notificationLocation({ type: 'UPDATED_REVIEW', location_name: 'accounts/2/locations/1' })).toBe('locations/1');
    expect(notificationLocation({ notificationType: 'GOOGLE_UPDATE', locationName: 'locations/1' })).toBeNull();
    expect(() => notificationLocation({ type: 'NEW_REVIEW', locationName: 'https://attacker.test' })).toThrow();
  });
  it('uses a fixed HTTPS callback and PKCE, with no credentials in the consent URL', () => {
    vi.stubEnv('GOOGLE_BUSINESS_CLIENT_ID', 'test-client'); vi.stubEnv('GOOGLE_BUSINESS_CLIENT_SECRET', 'secret-test');
    const url = new URL(consentUrl('state', 'challenge'));
    expect(url.searchParams.get('redirect_uri')).toBe('https://dashboard.multipark.pt/api/integrations/google-business/oauth/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.toString()).not.toContain('secret-test');
    expect(url.searchParams.get('scope')).toContain('business.manage');
  });
  it('rejects non-HTTPS callback origins', () => {
    vi.stubEnv('GOOGLE_BUSINESS_ORIGIN', 'http://attacker.test');
    expect(() => consentUrl('state', 'challenge')).toThrow();
  });
  it('fetches reviews with the supplied page cursor and authenticated official endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reviews: [], nextPageToken: 'next' }) });
    vi.stubGlobal('fetch', fetcher);
    await new BusinessClient('test-token').reviews('accounts/2', 'locations/1', 'cursor');
    const [url, options] = fetcher.mock.calls[0];
    expect(url.origin).toBe('https://mybusiness.googleapis.com');
    expect(url.pathname).toBe('/v4/accounts/2/locations/1/reviews');
    expect(url.searchParams.get('pageToken')).toBe('cursor');
    expect(options.headers.Authorization).toBe('Bearer test-token');
  });
  it('never fetches a path injected through account/location input', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(() => new BusinessClient('test-token').reviews('accounts/2/../../../token', 'locations/1')).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reports quota approval failures without exposing the upstream body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ secret: 'do-not-expose' }) }));
    await expect(new BusinessClient('test-token').accounts()).rejects.toThrow(/quota/);
  });
});
