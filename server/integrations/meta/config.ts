/**
 * Integração Meta Ads (Facebook/Instagram) — Marketing API Insights, só
 * LEITURA. DORMENTE até ser configurada por variáveis de ambiente do servidor:
 *
 *   META_ACCESS_TOKEN     token de longa duração de um utilizador de sistema
 *                         (Business Manager → Utilizadores do sistema) com
 *                         `ads_read` sobre as contas;
 *   META_AD_ACCOUNT_IDS   IDs das contas, separados por vírgula ("act_123,456");
 *   META_API_VERSION      opcional (por omissão META_DEFAULT_API_VERSION).
 *
 * Escreve nas MESMAS tabelas do Google Ads (ad_accounts / ad_campaigns /
 * ad_daily_metrics / ad_conversion_action_metrics) com provider = 'meta'.
 */
export const META_PROVIDER = "meta";
/** Versão da Graph API por omissão (cada versão vive ~2 anos; muda-se aqui ou em META_API_VERSION). */
export const META_DEFAULT_API_VERSION = "v24.0";
export const META_GRAPH_HOST = "https://graph.facebook.com";

export interface MetaConfig {
  accessToken: string | null;
  accountIds: string[];   // só dígitos (sem "act_")
  apiVersion: string;
}

export function normalizeMetaAccountId(raw: string): string {
  return String(raw).trim().replace(/^act_/i, "").replace(/[^\d]/g, "");
}

export function readMetaConfig(env: Record<string, string | undefined> = process.env): MetaConfig {
  const ids = String(env.META_AD_ACCOUNT_IDS ?? "").split(/[,;\s]+/).map(normalizeMetaAccountId).filter(Boolean);
  const version = env.META_API_VERSION?.trim();
  return {
    accessToken: env.META_ACCESS_TOKEN?.trim() || null,
    accountIds: Array.from(new Set(ids)),
    apiVersion: version ? (version.startsWith("v") ? version : `v${version}`) : META_DEFAULT_API_VERSION,
  };
}

export function missingMetaEnvs(cfg: MetaConfig = readMetaConfig()): string[] {
  const m: string[] = [];
  if (!cfg.accessToken) m.push("META_ACCESS_TOKEN");
  if (!cfg.accountIds.length) m.push("META_AD_ACCOUNT_IDS");
  return m;
}

export function isMetaConfigured(cfg: MetaConfig = readMetaConfig()): boolean {
  return missingMetaEnvs(cfg).length === 0;
}
