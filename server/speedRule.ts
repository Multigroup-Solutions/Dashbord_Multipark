/**
 * O limite de velocidade em vigor (Definições → Parâmetros → "Limite de
 * velocidade (GPS do Zello)", `gps.speedRule`; regras em
 * shared/speedRules.ts). Sem valor gravado (ou a leitura falha) vale a
 * omissão: 120 km/h, 0 % de tolerância, 2 pontos seguidos. Nunca lança.
 *
 * Substitui a tabela antiga `speed_limits` (sem ecrã para a configurar: sem
 * linha "por omissão", o limite era nulo e os "Dias acima do limite" davam
 * sempre 0 e os excessos da recolha usavam 999 km/h).
 */
import { DEFAULT_SPEED_RULE, SPEED_RULE_SETTING_KEY, speedThresholdOf, type SpeedRule } from "../shared/speedRules";

export async function loadSpeedRule(): Promise<SpeedRule> {
  try {
    const { getSetting } = await import("./appSettings");
    const v = await getSetting(SPEED_RULE_SETTING_KEY);
    if (v) return { ...DEFAULT_SPEED_RULE, ...v };
  } catch { /* omissão */ }
  return { ...DEFAULT_SPEED_RULE };
}

/** O limite em vigor e o limite com a tolerância (km/h). */
export async function speedRuleNow(): Promise<{ rule: SpeedRule; threshold: number }> {
  const rule = await loadSpeedRule();
  return { rule, threshold: speedThresholdOf(rule) };
}
