/**
 * Marcadores de regras na ajuda (plano MPV, §3.3): um `.md` de docs/ajuda pode
 * escrever `{{regra:extras.timesPercentile.porto}}` e o gerador
 * (scripts/gen-ajuda.ts) troca o marcador pelo valor que está no CÓDIGO — a
 * ajuda não fica para trás quando a constante muda. O que as pessoas veem (a
 * ajuda do Multis, a pesquisa global e a Base de conhecimento) sai do ficheiro
 * gerado, já com o valor: o marcador nunca aparece cru.
 *
 * Marcador desconhecido (ou mal escrito) = erro do gerador. PURO.
 *
 * São os valores POR OMISSÃO do código; onde há uma definição que os muda
 * (ex.: o percentil por cidade em Definições → Parâmetros), a ajuda deve dizer
 * "por omissão" ao lado do número.
 */
import { DEFAULT_TIMES_PERCENTILE, SETTINGS } from "./appSettings";
import { EVALUATION_POINTS, LATE_ARRIVAL_FROM_MINUTES, MAX_LATE_ARRIVALS_PER_DAY, RECOMPUTE_WINDOW_DAYS } from "./evaluationRules";
import { MIN_SAMPLE, PRESSURE_WINDOW_DAYS } from "./extrasPressure";
import { DEFAULT_GPS_GATE, DEFAULT_PICKUP_T2_TARGET_MINUTES, DEFAULT_SERVICE_TARGET_MINUTES, DRIVER_STATS_MIN_N } from "./serviceTimes";

export interface HelpRuleValue {
  value: string | number;
  /** De onde vem (ficheiro:constante) — para quem mantém a ajuda. */
  source: string;
}

/** Números negativos com o sinal menos tipográfico (−5), como no resto da ajuda. */
const v = (value: string | number, source: string): HelpRuleValue => ({ value: typeof value === "number" && value < 0 ? `−${-value}` : value, source });

/** Os marcadores conhecidos. Acrescentar aqui antes de usar na ajuda. */
export const HELP_RULE_VALUES: Readonly<Record<string, HelpRuleValue>> = {
  // Extras Dia → Pressão / tempos por carro
  "extras.timesPercentile.lisbon": v(DEFAULT_TIMES_PERCENTILE.lisbon, "shared/appSettings.ts:DEFAULT_TIMES_PERCENTILE"),
  "extras.timesPercentile.porto": v(DEFAULT_TIMES_PERCENTILE.porto, "shared/appSettings.ts:DEFAULT_TIMES_PERCENTILE"),
  "extras.timesPercentile.faro": v(DEFAULT_TIMES_PERCENTILE.faro, "shared/appSettings.ts:DEFAULT_TIMES_PERCENTILE"),
  "extras.autoProposeAt": v(String(SETTINGS["extras.autoProposeAt"].defaultValue), "shared/appSettings.ts:SETTINGS[extras.autoProposeAt]"),
  "extras.autoProposeDaysAhead": v(Number(SETTINGS["extras.autoProposeDaysAhead"].defaultValue), "shared/appSettings.ts:SETTINGS[extras.autoProposeDaysAhead]"),
  "extras.autoConfirm": v(SETTINGS["extras.autoConfirm"].defaultValue ? "ligado" : "desligado", "shared/appSettings.ts:SETTINGS[extras.autoConfirm]"),
  "extras.autoConfirmAt": v(String(SETTINGS["extras.autoConfirmAt"].defaultValue), "shared/appSettings.ts:SETTINGS[extras.autoConfirmAt]"),
  "extras.pressureWindowDays": v(PRESSURE_WINDOW_DAYS, "shared/extrasPressure.ts:PRESSURE_WINDOW_DAYS"),
  "extras.pressureMinSample": v(MIN_SAMPLE, "shared/extrasPressure.ts:MIN_SAMPLE"),
  // Tempos de serviço
  "serviceTimes.targetMinutes": v(DEFAULT_SERVICE_TARGET_MINUTES, "shared/serviceTimes.ts:DEFAULT_SERVICE_TARGET_MINUTES"),
  "serviceTimes.pickupT2TargetMinutes": v(DEFAULT_PICKUP_T2_TARGET_MINUTES, "shared/serviceTimes.ts:DEFAULT_PICKUP_T2_TARGET_MINUTES"),
  "serviceTimes.gpsGate.minCoveragePct": v(DEFAULT_GPS_GATE.minCoveragePct, "shared/serviceTimes.ts:DEFAULT_GPS_GATE"),
  "serviceTimes.gpsGate.minN": v(DEFAULT_GPS_GATE.minN, "shared/serviceTimes.ts:DEFAULT_GPS_GATE"),
  "serviceTimes.driverStatsMinN": v(DRIVER_STATS_MIN_N, "shared/serviceTimes.ts:DRIVER_STATS_MIN_N"),
  // Avaliação (pontos v3)
  "evaluation.points.movement": v(EVALUATION_POINTS.movement, "shared/evaluationRules.ts:EVALUATION_POINTS"),
  "evaluation.points.spotChange": v(EVALUATION_POINTS.spotChange, "shared/evaluationRules.ts:EVALUATION_POINTS"),
  "evaluation.points.pickupOrDelivery": v(EVALUATION_POINTS.pickupOrDelivery, "shared/evaluationRules.ts:EVALUATION_POINTS"),
  "evaluation.points.firstMoveAfterPickup": v(EVALUATION_POINTS.firstMoveAfterPickup, "shared/evaluationRules.ts:EVALUATION_POINTS"),
  "evaluation.points.speeding": v(EVALUATION_POINTS.speeding, "shared/evaluationRules.ts:EVALUATION_POINTS"),
  "evaluation.points.delay": v(EVALUATION_POINTS.delay, "shared/evaluationRules.ts:EVALUATION_POINTS"),
  "evaluation.points.confirmedComplaint": v(EVALUATION_POINTS.confirmedComplaint, "shared/evaluationRules.ts:EVALUATION_POINTS"),
  "evaluation.points.accidentOrDamage": v(EVALUATION_POINTS.accidentOrDamage, "shared/evaluationRules.ts:EVALUATION_POINTS"),
  "evaluation.lateArrivalFromMinutes": v(LATE_ARRIVAL_FROM_MINUTES, "shared/evaluationRules.ts:LATE_ARRIVAL_FROM_MINUTES"),
  "evaluation.maxLateArrivalsPerDay": v(MAX_LATE_ARRIVALS_PER_DAY, "shared/evaluationRules.ts:MAX_LATE_ARRIVALS_PER_DAY"),
  "evaluation.recomputeWindowDays": v(RECOMPUTE_WINDOW_DAYS, "shared/evaluationRules.ts:RECOMPUTE_WINDOW_DAYS"),
};

export class HelpRuleMarkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelpRuleMarkerError";
  }
}

const MARKER_RE = /\{\{\s*regra\s*:\s*([^}\s]*)\s*\}\}/g;
/** Qualquer `{{…regra…}}` que o marcador estrito não apanhe (mal escrito). */
const LOOSE_RE = /\{\{[^}]*regra[^}]*\}\}?/i;

/** Troca os `{{regra:chave}}` pelos valores do código; desconhecido ou mal escrito = erro. PURA. */
export function renderRuleMarkers(text: string, file = "?", values: Readonly<Record<string, HelpRuleValue>> = HELP_RULE_VALUES): string {
  const out = text.replace(MARKER_RE, (_m, key: string) => {
    const hit = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
    if (!hit) throw new HelpRuleMarkerError(`${file}: marcador desconhecido {{regra:${key}}} (acrescenta-o em shared/helpRuleValues.ts).`);
    return String(hit.value);
  });
  const loose = LOOSE_RE.exec(out);
  if (loose) throw new HelpRuleMarkerError(`${file}: marcador mal escrito "${loose[0]}" (formato: {{regra:chave}}).`);
  return out;
}

/** As chaves usadas num texto (para testes e para o relatório). PURA. */
export function ruleMarkersIn(text: string): string[] {
  return [...text.matchAll(MARKER_RE)].map((m) => m[1]);
}
