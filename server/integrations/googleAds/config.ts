/**
 * Configuração da integração Google Ads — tudo por variáveis de ambiente do
 * SERVIDOR (nunca no browser). Ver .env.example e memory/google-ads-integration.md.
 */
export const GOOGLE_ADS_PROVIDER = "google_ads";
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
export const OAUTH_CALLBACK_PATH = "/api/integrations/google-ads/oauth/callback";

export interface GoogleAdsConfig {
  developerToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string | null;      // se vazio, deriva-se do host do pedido
  loginCustomerId: string | null;  // conta gestora (MCC) opcional
  apiVersion: string;
}

export function readGoogleAdsConfig(): GoogleAdsConfig {
  const env = process.env;
  return {
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() || null,
    clientId: env.GOOGLE_ADS_CLIENT_ID?.trim() || null,
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET?.trim() || null,
    redirectUri: env.GOOGLE_ADS_REDIRECT_URI?.trim() || null,
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/[^\d]/g, "") || null,
    apiVersion: env.GOOGLE_ADS_API_VERSION?.trim() || "v21",
  };
}

/** Envs em falta para o fluxo OAuth arrancar (o developer token só é preciso para consultar). */
export function missingOAuthEnvs(cfg = readGoogleAdsConfig()): string[] {
  const m: string[] = [];
  if (!cfg.clientId) m.push("GOOGLE_ADS_CLIENT_ID");
  if (!cfg.clientSecret) m.push("GOOGLE_ADS_CLIENT_SECRET");
  return m;
}
export function missingApiEnvs(cfg = readGoogleAdsConfig()): string[] {
  const m = missingOAuthEnvs(cfg);
  if (!cfg.developerToken) m.push("GOOGLE_ADS_DEVELOPER_TOKEN");
  return m;
}

export function resolveRedirectUri(cfg: GoogleAdsConfig, origin: string): string {
  return cfg.redirectUri || `${origin}${OAUTH_CALLBACK_PATH}`;
}
