import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), jwt: vi.fn(), db: vi.fn(), execute: vi.fn(), consume: vi.fn(), finish: vi.fn(), start: vi.fn(), sync: vi.fn(), discover: vi.fn(), save: vi.fn() }));
vi.mock('../../_core/sdk', () => ({ sdk: { authenticateRequest: mock.auth } }));
vi.mock('../../cityAccess', () => ({ loadCityAccess: mock.access }));
vi.mock('jose', () => ({ createRemoteJWKSet: vi.fn(), jwtVerify: mock.jwt }));
vi.mock('./oauth', () => ({ database: mock.db, consumeState: mock.consume, finishOAuth: mock.finish, startOAuth: mock.start, saveConnection: mock.save }));
vi.mock('./service', () => ({ syncReviews: mock.sync, refreshLocations: mock.discover }));
import { registerGoogleBusinessRoutes } from './routes';

let routes: Record<string, Function>;
const response = () => { const res: any = {}; for (const key of ['status', 'send', 'json', 'type', 'redirect', 'end']) res[key] = vi.fn().mockReturnValue(res); return res; };
const request = (body?: unknown) => ({ headers: { authorization: 'Bearer oidc-test' }, query: {}, body });
const envelope = (subscription = 'projects/test/subscriptions/reviews') => ({ subscription, message: { messageId: 'message-1', data: Buffer.from(JSON.stringify({ notificationType: 'NEW_REVIEW', reviewName: 'accounts/1/locations/2/reviews/abc' })).toString('base64') } });

beforeEach(() => {
  vi.resetAllMocks(); routes = {};
  registerGoogleBusinessRoutes({ get: (p: string, h: Function) => { routes[p] = h; }, post: (p: string, h: Function) => { routes[p] = h; } } as any);
  mock.auth.mockResolvedValue({ id: 10, role: 'admin' }); mock.access.mockResolvedValue({ all: true });
  mock.db.mockResolvedValue({ execute: mock.execute }); mock.execute.mockResolvedValue([{ affectedRows: 1 }]);
  mock.jwt.mockResolvedValue({ payload: { email: 'push@test.iam.gserviceaccount.com', email_verified: true } });
  vi.stubEnv('GOOGLE_BUSINESS_PUSH_AUDIENCE', 'https://dashboard.multipark.pt/api/integrations/google-business/webhook');
  vi.stubEnv('GOOGLE_BUSINESS_PUSH_EMAIL', 'push@test.iam.gserviceaccount.com');
  vi.stubEnv('GOOGLE_BUSINESS_SUBSCRIPTION', 'projects/test/subscriptions/reviews');
});
afterEach(() => vi.unstubAllEnvs());
const push = '/api/integrations/google-business/webhook';
describe('Google Business routes fail closed', () => {
  it.each([undefined, '', 'wrong'])('rejects missing/incorrect cron credentials', async credential => {
    vi.stubEnv('CRON_SECRET', 'expected'); const res = response();
    await routes['/api/cron/google-business']({ headers: { authorization: credential && `Bearer ${credential}` } }, res);
    expect(res.status).toHaveBeenCalledWith(401); expect(mock.sync).not.toHaveBeenCalled();
  });
  it('does not authorize an empty server cron secret', async () => {
    vi.stubEnv('CRON_SECRET', ''); const res = response();
    await routes['/api/cron/google-business']({ headers: { authorization: 'Bearer ' } }, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });
  it('denies a city-scoped admin before starting OAuth', async () => {
    mock.access.mockResolvedValue({ all: false }); const res = response();
    await routes['/api/integrations/google-business/oauth/start'](request(), res);
    expect(res.status).toHaveBeenCalledWith(403); expect(mock.start).not.toHaveBeenCalled();
  });
  it('does not exchange an expired or replayed OAuth state', async () => {
    mock.consume.mockResolvedValue(null); const res = response();
    await routes['/api/integrations/google-business/oauth/callback']({ ...request(), query: { state: 'a'.repeat(43), code: 'code' } }, res);
    expect(mock.consume).toHaveBeenCalledWith('a'.repeat(43), 10);
    expect(res.status).toHaveBeenCalledWith(400); expect(mock.finish).not.toHaveBeenCalled();
  });
  it('rejects a forged or expired push JWT', async () => {
    mock.jwt.mockRejectedValue(new Error('invalid')); const res = response();
    await routes[push](request(envelope()), res);
    expect(res.status).toHaveBeenCalledWith(401); expect(mock.execute).not.toHaveBeenCalled();
  });
  it('rejects a valid Google token from a different service account', async () => {
    mock.jwt.mockResolvedValue({ payload: { email: 'other@test.iam.gserviceaccount.com', email_verified: true } }); const res = response();
    await routes[push](request(envelope()), res);
    expect(res.status).toHaveBeenCalledWith(401); expect(mock.execute).not.toHaveBeenCalled();
  });
  it('pins signature algorithm, issuer and audience and persists before acknowledgement', async () => {
    const res = response(); await routes[push](request(envelope()), res);
    expect(mock.jwt).toHaveBeenCalledWith('oidc-test', undefined, expect.objectContaining({ algorithms: ['RS256'], audience: 'https://dashboard.multipark.pt/api/integrations/google-business/webhook', issuer: ['https://accounts.google.com', 'accounts.google.com'] }));
    expect(mock.execute).toHaveBeenCalledOnce(); expect(res.status).toHaveBeenCalledWith(204);
    expect(mock.execute.mock.invocationCallOrder[0]).toBeLessThan(res.end.mock.invocationCallOrder[0]);
  });
  it('rejects an envelope from another subscription', async () => {
    const res = response(); await routes[push](request(envelope('projects/other/subscriptions/other')), res);
    expect(res.status).toHaveBeenCalledWith(400); expect(mock.execute).not.toHaveBeenCalled();
  });
  it('asks Google to retry when durable persistence fails', async () => {
    mock.execute.mockRejectedValue(new Error('database down')); const res = response();
    await routes[push](request(envelope()), res);
    expect(res.status).toHaveBeenCalledWith(503); expect(res.end).not.toHaveBeenCalled();
  });
});
