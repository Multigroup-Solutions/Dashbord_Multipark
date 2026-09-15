/**
 * Configuração da integração Google Ads — tudo por variáveis de ambiente do
 * SERVIDOR (nunca no browser). Ver .env.example e memory/google-ads-integration.md.
 */
export const GOOGLE_ADS_PROVIDER = "google_ads";
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
export const OAUTH_CALLBACK_PATH = "/api/integrations/google-ads/oauth/callback";

export interface GoogleAdsConfig {
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string | null;      // se vazio, deriva-se do host do pedido
  loginCustomerId: string | null;  // conta gestora (MCC) opcional
  apiVersion: string;
}

export function readGoogleAdsConfig(): GoogleAdsConfig {
  const env = process.env;
  return {
    clientId: env.GOOGLE_ADS_CLIENT_ID?.trim() || null,
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET?.trim() || null,
    redirectUri: env.GOOGLE_ADS_REDIRECT_URI?.trim() || null,
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/[^\d]/g, "") || null,
    // v21 was sunset on 2026-08-05; use a supported reporting API version.
    apiVersion: env.GOOGLE_ADS_API_VERSION?.trim() || "v25",
  };
}

/** Envs em falta para o fluxo OAuth arrancar. */
export function missingOAuthEnvs(cfg = readGoogleAdsConfig()): string[] {
  const m: string[] = [];
  if (!cfg.clientId) m.push("GOOGLE_ADS_CLIENT_ID");
  if (!cfg.clientSecret) m.push("GOOGLE_ADS_CLIENT_SECRET");
  return m;
}
export function missingApiEnvs(cfg = readGoogleAdsConfig()): string[] {
  // Desde 2026-09-09, o acesso pertence ao projeto Cloud do cliente OAuth.
  // O Google deixou de exigir developer tokens.
  return missingOAuthEnvs(cfg);
}

export function resolveRedirectUri(cfg: GoogleAdsConfig, origin: string): string {
  return cfg.redirectUri || `${origin}${OAUTH_CALLBACK_PATH}`;
}
