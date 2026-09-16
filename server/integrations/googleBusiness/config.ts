export const PROVIDER = 'google_business';
export const SCOPE = 'https://www.googleapis.com/auth/business.manage';
export const CALLBACK = '/api/integrations/google-business/oauth/callback';
export const PAGE = '/criticas';

export function config() {
  const origin = process.env.GOOGLE_BUSINESS_ORIGIN || 'https://dashboard.multipark.pt';
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('GOOGLE_BUSINESS_ORIGIN tem de ser uma origem HTTPS.');
  }
  return {
    clientId: process.env.GOOGLE_BUSINESS_CLIENT_ID?.trim() || process.env.GOOGLE_ADS_CLIENT_ID?.trim() || '',
    clientSecret: process.env.GOOGLE_BUSINESS_CLIENT_SECRET?.trim() || process.env.GOOGLE_ADS_CLIENT_SECRET?.trim() || '',
    redirectUri: `${url.origin}${CALLBACK}`,
    pushAudience: process.env.GOOGLE_BUSINESS_PUSH_AUDIENCE?.trim() || '',
    pushEmail: process.env.GOOGLE_BUSINESS_PUSH_EMAIL?.trim() || '',
    subscription: process.env.GOOGLE_BUSINESS_SUBSCRIPTION?.trim() || '',
  };
}

export function consentUrl(state: string, challenge: string) {
  const c = config();
  if (!c.clientId || !c.clientSecret) throw new Error('Credenciais Google Business Profile em falta.');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: c.clientId, redirect_uri: c.redirectUri,
    response_type: 'code', scope: `${SCOPE} openid email`, access_type: 'offline', prompt: 'consent select_account',
    include_granted_scopes: 'false', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return url.toString();
}
