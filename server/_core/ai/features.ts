/**
 * Funcionalidades de IA: catálogo (shared/aiFeatures.ts), interruptores e
 * nível efetivo de cada uma.
 *
 * Interruptores (Definições → Automações; env on/off; sobreposição na BD):
 *   AI_ENABLED (geral) + um por funcionalidade. AI_HR_AUTOFILL nasce
 *   DESLIGADO até o dono decidir sobre o RGPD.
 *
 * Nível efetivo (do mais forte para o mais fraco):
 *   1. Definições → Parâmetros, `ai.featureTiers` ({"quiz_generation":"lite"});
 *   2. env AI_TIER_<FUNCIONALIDADE> (ex.: AI_TIER_EXPENSE_OCR=fast);
 *   3. o nível pedido no ponto de chamada (ex.: PDF de fatura → fast);
 *   4. o nível do catálogo (quase tudo `lite`).
 */
import { ensureFeatureFlagOverrides, isFeatureEnabled, type EnvLike } from "../featureFlags";
import { automationFlagDefault } from "../../../shared/appSettings";
import { AI_FEATURES, isAiTier, type AiFeature, type AiTier } from "../../../shared/aiFeatures";

export { AI_FEATURES, AI_FEATURE_IDS, isAiFeature, type AiFeature, type AiFeatureDef, type AiFlag } from "../../../shared/aiFeatures";

/** Interruptores (geral + da funcionalidade). Síncrono: usa a cache das sobreposições. */
export function isAiFeatureEnabled(feature: AiFeature, opts: { env?: EnvLike; overrides?: ReadonlyMap<string, boolean> | null } = {}): boolean {
  if (!isFeatureEnabled("AI_ENABLED", { ...opts, defaultEnabled: true })) return false;
  const flag = AI_FEATURES[feature].flag;
  if (!flag) return true;
  return isFeatureEnabled(flag, { ...opts, defaultEnabled: automationFlagDefault(flag) });
}

/** Igual, mas recarrega primeiro as sobreposições da BD (se velhas). */
export async function aiFeatureEnabledFresh(feature: AiFeature): Promise<boolean> {
  await ensureFeatureFlagOverrides();
  return isAiFeatureEnabled(feature);
}

/** Nível efetivo (ver ordem no topo). PURA. */
export function resolveFeatureTier(
  feature: AiFeature,
  opts: { requested?: AiTier; settings?: Partial<Record<string, AiTier>> | null; env?: EnvLike } = {},
): AiTier {
  const fromSettings = opts.settings?.[feature];
  if (isAiTier(fromSettings)) return fromSettings;
  const env = opts.env ?? process.env;
  const fromEnv = String(env[`AI_TIER_${feature.toUpperCase()}`] ?? "").trim().toLowerCase();
  if (isAiTier(fromEnv)) return fromEnv;
  return opts.requested ?? AI_FEATURES[feature].tier;
}

/** Sobreposições gravadas em Definições (cache de 30 s das definições). Nunca lança. */
export async function loadFeatureTierSettings(): Promise<Partial<Record<string, AiTier>> | null> {
  try {
    const { getSetting } = await import("../../appSettings");
    return (await getSetting("ai.featureTiers")) ?? null;
  } catch {
    return null;
  }
}
