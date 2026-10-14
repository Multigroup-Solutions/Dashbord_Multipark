/**
 * O limite de velocidade em vigor (Definições → Parâmetros → "Limite de
 * velocidade (GPS do Zello)", `gps.speedRule`; regras em shared/speedRules.ts).
 * Sem valor gravado vale a omissão: 120 km/h com 10 % de tolerância (= 132
 * km/h, a mesma omissão que a Avaliação já usava desde o #381) e 2 pontos
 * seguidos.
 *
 * Substitui a tabela antiga `speed_limits` (sem ecrã para a configurar: sem
 * linha "por omissão", o limite era nulo, os "Dias acima do limite" davam
 * sempre 0 e os excessos da recolha usavam 999 km/h).
 *
 * Duas leituras, de propósito diferentes:
 *  - `speedRuleRead()` — para CONTAR (Avaliação, Desempenho, Resumo do dia):
 *    se a definição não se consegue ler (BD em baixo, erro), devolve null e
 *    quem chama não conta excessos do GPS e diz-o numa nota (a omissão só vale
 *    quando a leitura correu bem e não há valor gravado — a regra do #381);
 *  - `speedRuleNow()` — para a RECOLHA do Zello, que precisa sempre de uma
 *    regra: sem leitura, a omissão.
 * Nunca lançam.
 */
import { DEFAULT_SPEED_RULE, SPEED_RULE_SETTING_KEY, speedThresholdOf, type SpeedRule } from "../shared/speedRules";

export interface SpeedRuleNow { rule: SpeedRule; threshold: number }

const withThreshold = (rule: SpeedRule): SpeedRuleNow => ({ rule, threshold: speedThresholdOf(rule) });

/** A regra gravada (ou a omissão, sem valor gravado); null = não deu para ler. */
export async function speedRuleRead(): Promise<SpeedRuleNow | null> {
  try {
    const { getSettingFresh } = await import("./appSettings");
    const r = await getSettingFresh(SPEED_RULE_SETTING_KEY);
    if (r == null) return null; // BD em baixo ou erro a ler
    return withThreshold({ ...DEFAULT_SPEED_RULE, ...(r.value ?? {}) });
  } catch {
    return null;
  }
}

/** A regra em vigor para a recolha: a gravada, ou a omissão se não der para ler. */
export async function speedRuleNow(): Promise<SpeedRuleNow> {
  return (await speedRuleRead()) ?? withThreshold({ ...DEFAULT_SPEED_RULE });
}
