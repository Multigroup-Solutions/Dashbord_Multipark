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
import { ROLE_LABELS, type Role } from "./access";
import { AI_ASSISTANT_DEFAULT_LIMITS, DEFAULT_TIGHT_USES_QUEUE, DEFAULT_TIMES_PERCENTILE, SETTINGS, automationFlagDefault } from "./appSettings";
import { TUTOR_DEFAULT_LIMITS, TUTOR_DEFAULT_MODE, TUTOR_MODE_LABELS } from "./trainingTutor";
import {
  COMPLAINT_LIST_DEFAULT_DAYS, COMPLAINT_PHOTO_MAX_BYTES, COMPLAINT_SLA_RUNNING, DEDUPE_WINDOW_MS, DEFAULT_INCIDENT_SLA_HOURS, DEFAULT_LOST_SLA_DAYS,
} from "./caseRules";
import { COMPLAINT_STATUS_FILTER_LABELS } from "./complaintFilters";
import { CREDIT_NOTE_STATES, CREDIT_NOTE_STATE_HELP, CREDIT_NOTE_STATE_LABELS } from "./creditNotes";
import { ACCIDENTS_FROM_DAY, EVALUATION_POINTS, EVALUATION_RULES_VERSION, LATE_ARRIVAL_FROM_MINUTES, MAX_GPS_SPEEDING_PER_DAY, MAX_LATE_ARRIVALS_PER_DAY, RECOMPUTE_WINDOW_DAYS } from "./evaluationRules";
import { PAID_ON_CREATE_ROLES } from "./expenseCreatePayment";
import { CREW_MEASURE_MIN_SAMPLES, CYCLE_PERCENTILES, MAX_CYCLE_MINUTES, MIN_SAMPLE, PRESSURE_SINCE_DEFAULT, RUSH_HOURS, TIGHT_TOP_SHARE } from "./extrasPressure";
import {
  COVERAGE_ALERT_MIN, DAY_START_HOUR, IDLE_PENALTY, MANUAL_EDIT_AT_CONFIRM_DEFAULT, MANUAL_EDIT_AT_CONFIRM_LABELS, MANUAL_EDIT_SETTLE_MIN, MANUAL_HOLD_REPEAT_AT_MIN, MAX_NOTIFY_ATTEMPTS,
  MAX_SHIFT_HOURS, MIN_SHIFT_HOURS, NOTIFY_RETRY_STEP_MIN, PICKUP_PAIR_AFTER_MIN, PICKUP_PAIR_BEFORE_MIN, RANK_WEIGHTS,
} from "./extrasSchedule";
import { REMINDER_LEAD_MIN } from "./extrasReminders";
import {
  REPLY_MAX_CHARS, REPLY_MIN_CHARS, REVIEW_AUTO_PUBLISH_DELAY_HOURS, REVIEW_AUTO_PUBLISH_EXPIRE_HOURS, REVIEW_AUTO_PUBLISH_MAX_ATTEMPTS,
  REVIEW_AUTO_PUBLISH_MAX_CONSECUTIVE_FAILURES, REVIEW_AUTO_PUBLISH_MAX_PER_PROFILE_DAY, REVIEW_AUTO_PUBLISH_VERIFY_DAYS, REVIEW_AUTO_PUBLISH_VERIFY_FAIL_DAYS,
} from "./reviewAutoPublish";
import { NO_COMMISSION_TYPES } from "./partnerRules";
import { getPartnerType } from "./partnerTypes";
import { REVIEW_AUTO_DRAFT_MAX_AGE_DAYS, REVIEW_COMPLAINT_SLA_HOURS } from "./reviewRules";
import {
  CALL_WINDOW_AFTER_MIN, CALL_WINDOW_BEFORE_MIN, DEFAULT_GARAGE_ROLES, DEFAULT_GPS_GATE, DEFAULT_PICKUP_T2_TARGET_MINUTES, DEFAULT_SERVICE_TARGET_MINUTES,
  DISPATCH_MIN_MINUTES, DRIVER_STATS_MIN_N, MAX_CUSTOMER_MIN, MAX_QUEUE_MIN, MAX_TRANSIT_MIN, PICKUP_TRACK_MAX_HOURS, SERVICE_CALLS_SINCE,
  SERVICE_TIMES_GPS_SINCE_DEFAULT, SERVICE_TIMES_SINCE_DEFAULT, SHARED_PHONE_MIN_BOOKINGS, type GarageRole,
} from "./serviceTimes";
import {
  DEFAULT_SPEED_RULE, EXCESS_MERGE_GAP_S, GPS_ABSURD_KMH, LEGACY_COLLECTED_THRESHOLD_KMH, MAX_SPEED_JUMP_KMH_PER_S, POSITION_MAX_GAP_S, POSITION_MIN_GAP_S,
} from "./speedRules";

export interface HelpRuleValue {
  value: string | number;
  /** De onde vem (ficheiro:constante) — para quem mantém a ajuda. */
  source: string;
  /**
   * É o valor POR OMISSÃO de uma definição que se muda nas Definições: a
   * ajuda tem de dizer "por omissão" (ou "em uso") perto de cada uso, porque
   * em produção pode estar outro valor. O gerador falha se não disser.
   */
  setting?: boolean;
}

/** Números negativos com o sinal menos tipográfico (−5), como no resto da ajuda. */
const v = (value: string | number, source: string): HelpRuleValue => ({ value: typeof value === "number" && value < 0 ? `−${-value}` : value, source });
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
/** "2026-04-03" → "3 abr 2026". PURA. */
export function ptDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}
/** Valor por omissão de uma definição (ver `setting`). */
const d = (value: string | number, source: string): HelpRuleValue => ({ ...v(value, source), setting: true });
/** ["a", "b", "c"] → "a, b e c". PURA. */
export function joinPt(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}
/** 0,5 com vírgula decimal. */
const dec = (n: number) => String(n).replace(".", ",");
/** 7 → "07h" (hora de Lisboa). */
const hh = (h: number) => `${String(h % 24).padStart(2, "0")}h`;
const garagesWith = (role: GarageRole) => joinPt(DEFAULT_GARAGE_ROLES.filter((g) => g.role === role).map((g) => g.garage));
const CITY_PT: Record<string, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };
/** { lisbon: true, porto: false } → "ligado em Lisboa" / "desligado em todas as cidades". */
const onCities = (map: Readonly<Record<string, boolean>>) => {
  const on = Object.keys(CITY_PT).filter((c) => map[c] === true).map((c) => CITY_PT[c]);
  return on.length ? `ligado em ${joinPt(on)}` : "desligado em todas as cidades";
};
const roleNames =(roles: readonly string[]) => joinPt(roles.map((r) => ROLE_LABELS[r as Role] ?? r));
/** "11:00" → 660 e 630 → "10:30". */
const hhmmMin = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const hhmmOf = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Os marcadores conhecidos. Acrescentar aqui antes de usar na ajuda. */
export const HELP_RULE_VALUES: Readonly<Record<string, HelpRuleValue>> = {
  // Extras Dia → Pressão / tempos por carro
  "extras.timesPercentile.lisbon": d(DEFAULT_TIMES_PERCENTILE.lisbon, "shared/appSettings.ts:DEFAULT_TIMES_PERCENTILE"),
  "extras.timesPercentile.porto": d(DEFAULT_TIMES_PERCENTILE.porto, "shared/appSettings.ts:DEFAULT_TIMES_PERCENTILE"),
  "extras.timesPercentile.faro": d(DEFAULT_TIMES_PERCENTILE.faro, "shared/appSettings.ts:DEFAULT_TIMES_PERCENTILE"),
  "extras.autoProposeAt": d(String(SETTINGS["extras.autoProposeAt"].defaultValue), "shared/appSettings.ts:SETTINGS[extras.autoProposeAt]"),
  "extras.autoProposeDaysAhead": d(Number(SETTINGS["extras.autoProposeDaysAhead"].defaultValue), "shared/appSettings.ts:SETTINGS[extras.autoProposeDaysAhead]"),
  "extras.autoConfirm": d(SETTINGS["extras.autoConfirm"].defaultValue ? "ligado" : "desligado", "shared/appSettings.ts:SETTINGS[extras.autoConfirm]"),
  "extras.autoConfirmAt": d(String(SETTINGS["extras.autoConfirmAt"].defaultValue), "shared/appSettings.ts:SETTINGS[extras.autoConfirmAt]"),
  "extras.pressureMinSample": v(MIN_SAMPLE, "shared/extrasPressure.ts:MIN_SAMPLE"),
  // Tempos de serviço
  "serviceTimes.targetMinutes": d(DEFAULT_SERVICE_TARGET_MINUTES, "shared/serviceTimes.ts:DEFAULT_SERVICE_TARGET_MINUTES"),
  "serviceTimes.since": d(ptDay(SERVICE_TIMES_SINCE_DEFAULT), "shared/serviceTimes.ts:SERVICE_TIMES_SINCE_DEFAULT"),
  "serviceTimes.gpsSince": d(ptDay(SERVICE_TIMES_GPS_SINCE_DEFAULT), "shared/serviceTimes.ts:SERVICE_TIMES_GPS_SINCE_DEFAULT"),
  "serviceTimes.pickupT2TargetMinutes": d(DEFAULT_PICKUP_T2_TARGET_MINUTES, "shared/serviceTimes.ts:DEFAULT_PICKUP_T2_TARGET_MINUTES"),
  "serviceTimes.gpsGate.minCoveragePct": d(DEFAULT_GPS_GATE.minCoveragePct, "shared/serviceTimes.ts:DEFAULT_GPS_GATE"),
  "serviceTimes.gpsGate.minN": d(DEFAULT_GPS_GATE.minN, "shared/serviceTimes.ts:DEFAULT_GPS_GATE"),
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
  // ── Plano MPV F2: "regras em vigor" (shared/rulesInForce.ts) — a MESMA fonte para a ajuda e para as regras ──
  "evaluation.accidentsFromDay": v(ptDay(ACCIDENTS_FROM_DAY), "shared/evaluationRules.ts:ACCIDENTS_FROM_DAY"),
  "evaluation.rulesVersion": v(EVALUATION_RULES_VERSION, "shared/evaluationRules.ts:EVALUATION_RULES_VERSION"),
  "evaluation.maxGpsSpeedingPerDay": v(MAX_GPS_SPEEDING_PER_DAY, "shared/evaluationRules.ts:MAX_GPS_SPEEDING_PER_DAY"),
  // Velocidade (Definições → Parâmetros → gps.speedRule; os limites do GPS são do código)
  "speed.limitKmh": d(DEFAULT_SPEED_RULE.limitKmh, "shared/speedRules.ts:DEFAULT_SPEED_RULE"),
  "speed.tolerancePercent": d(DEFAULT_SPEED_RULE.tolerancePercent, "shared/speedRules.ts:DEFAULT_SPEED_RULE"),
  "speed.minPoints": d(DEFAULT_SPEED_RULE.minPoints, "shared/speedRules.ts:DEFAULT_SPEED_RULE"),
  "speed.absurdKmh": v(GPS_ABSURD_KMH, "shared/speedRules.ts:GPS_ABSURD_KMH"),
  "speed.maxJumpKmhPerS": v(MAX_SPEED_JUMP_KMH_PER_S, "shared/speedRules.ts:MAX_SPEED_JUMP_KMH_PER_S"),
  "speed.mergeGapS": v(EXCESS_MERGE_GAP_S, "shared/speedRules.ts:EXCESS_MERGE_GAP_S"),
  "speed.positionMinGapS": v(POSITION_MIN_GAP_S, "shared/speedRules.ts:POSITION_MIN_GAP_S"),
  "speed.positionMaxGapS": v(POSITION_MAX_GAP_S, "shared/speedRules.ts:POSITION_MAX_GAP_S"),
  "speed.legacyThresholdKmh": v(LEGACY_COLLECTED_THRESHOLD_KMH, "shared/speedRules.ts:LEGACY_COLLECTED_THRESHOLD_KMH"),
  // Extras Dia → Pressão
  "extras.timesSince": d(ptDay(PRESSURE_SINCE_DEFAULT), "shared/extrasPressure.ts:PRESSURE_SINCE_DEFAULT"),
  "extras.cyclePercentiles": v(joinPt(CYCLE_PERCENTILES.map(String)), "shared/extrasPressure.ts:CYCLE_PERCENTILES"),
  "extras.maxCycleMinutes": v(MAX_CYCLE_MINUTES, "shared/extrasPressure.ts:MAX_CYCLE_MINUTES"),
  "extras.rushHours": v(joinPt(RUSH_HOURS.map(([a, b]) => `${hh(a)}–${hh(b)}`)), "shared/extrasPressure.ts:RUSH_HOURS"),
  "extras.crewMeasureMinSamples": v(CREW_MEASURE_MIN_SAMPLES, "shared/extrasPressure.ts:CREW_MEASURE_MIN_SAMPLES"),
  "extras.tightTopSharePct": v(Math.round(TIGHT_TOP_SHARE * 100), "shared/extrasPressure.ts:TIGHT_TOP_SHARE"),
  "extras.tightUsesQueue": d(onCities(DEFAULT_TIGHT_USES_QUEUE), "shared/appSettings.ts:DEFAULT_TIGHT_USES_QUEUE"),
  // Extras Dia → escala automática
  "extras.minShiftHours": v(MIN_SHIFT_HOURS, "shared/extrasSchedule.ts:MIN_SHIFT_HOURS"),
  "extras.maxShiftHours": v(MAX_SHIFT_HOURS, "shared/extrasSchedule.ts:MAX_SHIFT_HOURS"),
  "extras.dayStartHour": v(hh(DAY_START_HOUR), "shared/extrasSchedule.ts:DAY_START_HOUR"),
  "extras.pairBeforeMin": v(PICKUP_PAIR_BEFORE_MIN, "shared/extrasSchedule.ts:PICKUP_PAIR_BEFORE_MIN"),
  "extras.pairAfterMin": v(PICKUP_PAIR_AFTER_MIN, "shared/extrasSchedule.ts:PICKUP_PAIR_AFTER_MIN"),
  "extras.rankWeights.coverage": v(Math.round(RANK_WEIGHTS.coverage * 100), "shared/extrasSchedule.ts:RANK_WEIGHTS"),
  "extras.rankWeights.eval": v(Math.round(RANK_WEIGHTS.eval * 100), "shared/extrasSchedule.ts:RANK_WEIGHTS"),
  "extras.rankWeights.cost": v(Math.round(RANK_WEIGHTS.cost * 100), "shared/extrasSchedule.ts:RANK_WEIGHTS"),
  "extras.rankWeights.fairness": v(Math.round(RANK_WEIGHTS.fairness * 100), "shared/extrasSchedule.ts:RANK_WEIGHTS"),
  "extras.rankWeights.reliability": v(Math.round(RANK_WEIGHTS.reliability * 100), "shared/extrasSchedule.ts:RANK_WEIGHTS"),
  "extras.idlePenalty": v(dec(IDLE_PENALTY), "shared/extrasSchedule.ts:IDLE_PENALTY"),
  "extras.maxNotifyAttempts": v(MAX_NOTIFY_ATTEMPTS, "shared/extrasSchedule.ts:MAX_NOTIFY_ATTEMPTS"),
  // Plano MPV F7 (§6.1): novas tentativas, lembretes, dia mexido à mão, cobertura
  "extras.notifyRetryStepMin": v(NOTIFY_RETRY_STEP_MIN, "shared/extrasSchedule.ts:NOTIFY_RETRY_STEP_MIN"),
  "extras.reminderLeadMin": v(REMINDER_LEAD_MIN, "shared/extrasReminders.ts:REMINDER_LEAD_MIN"),
  "extras.reminderProposeAt": d(hhmmOf(hhmmMin(String(SETTINGS["extras.autoProposeAt"].defaultValue)) - REMINDER_LEAD_MIN), "shared/appSettings.ts:SETTINGS[extras.autoProposeAt] − REMINDER_LEAD_MIN"),
  "extras.reminderConfirmAt": d(hhmmOf(hhmmMin(String(SETTINGS["extras.autoConfirmAt"].defaultValue)) - REMINDER_LEAD_MIN), "shared/appSettings.ts:SETTINGS[extras.autoConfirmAt] − REMINDER_LEAD_MIN"),
  "extras.manualEditAtConfirm": d(`«${MANUAL_EDIT_AT_CONFIRM_LABELS[MANUAL_EDIT_AT_CONFIRM_DEFAULT]}»`, "shared/extrasSchedule.ts:MANUAL_EDIT_AT_CONFIRM_DEFAULT"),
  "extras.manualEditSettleMin": v(MANUAL_EDIT_SETTLE_MIN, "shared/extrasSchedule.ts:MANUAL_EDIT_SETTLE_MIN"),
  "extras.coverageAlertPct": v(Math.round(COVERAGE_ALERT_MIN * 100), "shared/extrasSchedule.ts:COVERAGE_ALERT_MIN"),
  "extras.remindersFlag": d(automationFlagDefault("EXTRAS_REMINDERS") ? "ligado" : "desligado", "shared/appSettings.ts:AUTOMATION_FLAGS[EXTRAS_REMINDERS]"),
  "extras.scheduleAlertsFlag": d(automationFlagDefault("EXTRAS_SCHEDULE_ALERTS") ? "ligado" : "desligado", "shared/appSettings.ts:AUTOMATION_FLAGS[EXTRAS_SCHEDULE_ALERTS]"),
  "extras.manualHoldRepeatAt": v(hhmmOf(MANUAL_HOLD_REPEAT_AT_MIN), "shared/extrasSchedule.ts:MANUAL_HOLD_REPEAT_AT_MIN"),
  "extras.completeFlag": d(automationFlagDefault("EXTRAS_COMPLETE_BEFORE_CONFIRM") ? "ligado" : "desligado", "shared/appSettings.ts:AUTOMATION_FLAGS[EXTRAS_COMPLETE_BEFORE_CONFIRM]"),
  // Tempos de serviço (parâmetros do cálculo)
  "serviceTimes.callWindowBeforeMin": v(CALL_WINDOW_BEFORE_MIN, "shared/serviceTimes.ts:CALL_WINDOW_BEFORE_MIN"),
  "serviceTimes.callWindowAfterMin": v(CALL_WINDOW_AFTER_MIN, "shared/serviceTimes.ts:CALL_WINDOW_AFTER_MIN"),
  "serviceTimes.useCalls": d(SETTINGS["serviceTimes.useCalls"].defaultValue ? "ligado" : "desligado", "shared/appSettings.ts:SETTINGS[serviceTimes.useCalls]"),
  "serviceTimes.callsSince":v(ptDay(SERVICE_CALLS_SINCE), "shared/serviceTimes.ts:SERVICE_CALLS_SINCE"),
  "serviceTimes.sharedPhoneMinBookings": v(SHARED_PHONE_MIN_BOOKINGS, "shared/serviceTimes.ts:SHARED_PHONE_MIN_BOOKINGS"),
  "serviceTimes.dispatchMinMinutes": v(DISPATCH_MIN_MINUTES, "shared/serviceTimes.ts:DISPATCH_MIN_MINUTES"),
  "serviceTimes.maxQueueMin": v(MAX_QUEUE_MIN, "shared/serviceTimes.ts:MAX_QUEUE_MIN"),
  "serviceTimes.maxTransitMin": v(MAX_TRANSIT_MIN, "shared/serviceTimes.ts:MAX_TRANSIT_MIN"),
  "serviceTimes.maxCustomerMin": v(MAX_CUSTOMER_MIN, "shared/serviceTimes.ts:MAX_CUSTOMER_MIN"),
  "serviceTimes.pickupTrackMaxHours": v(PICKUP_TRACK_MAX_HOURS, "shared/serviceTimes.ts:PICKUP_TRACK_MAX_HOURS"),
  "serviceTimes.garages.provisoria": d(garagesWith("provisoria"), "shared/serviceTimes.ts:DEFAULT_GARAGE_ROLES"),
  "serviceTimes.garages.parque": d(garagesWith("parque"), "shared/serviceTimes.ts:DEFAULT_GARAGE_ROLES"),
  "serviceTimes.garages.final": d(garagesWith("final"), "shared/serviceTimes.ts:DEFAULT_GARAGE_ROLES"),
  // Despesas
  "expenses.paidOnCreateRoles": v(roleNames(PAID_ON_CREATE_ROLES), "shared/expenseCreatePayment.ts:PAID_ON_CREATE_ROLES"),
  "creditNotes.states": v(joinPt(CREDIT_NOTE_STATES.map((s) => `«${CREDIT_NOTE_STATE_LABELS[s]}» (${CREDIT_NOTE_STATE_HELP[s].replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())})`)), "shared/creditNotes.ts:CREDIT_NOTE_STATE_LABELS"),
  // Parcerias
  "partners.noCommissionTypes": v(joinPt([...NO_COMMISSION_TYPES].map((t) => getPartnerType(t).label)), "shared/partnerRules.ts:NO_COMMISSION_TYPES"),
  // Reclamações, ocorrências e perdidos
  "cases.incidentSlaHours": d(DEFAULT_INCIDENT_SLA_HOURS, "shared/caseRules.ts:DEFAULT_INCIDENT_SLA_HOURS"),
  "cases.lostSlaDays": d(DEFAULT_LOST_SLA_DAYS, "shared/caseRules.ts:DEFAULT_LOST_SLA_DAYS"),
  "cases.dedupeWindowHours": v(DEDUPE_WINDOW_MS / 3_600_000, "shared/caseRules.ts:DEDUPE_WINDOW_MS"),
  "cases.complaintListDays": v(COMPLAINT_LIST_DEFAULT_DAYS, "shared/caseRules.ts:COMPLAINT_LIST_DEFAULT_DAYS"),
  "cases.complaintPhotoMaxMb": v(COMPLAINT_PHOTO_MAX_BYTES / (1024 * 1024), "shared/caseRules.ts:COMPLAINT_PHOTO_MAX_BYTES"),
  "cases.complaintSlaRunning": v(joinPt(COMPLAINT_SLA_RUNNING.map((s) => `«${COMPLAINT_STATUS_FILTER_LABELS[s as keyof typeof COMPLAINT_STATUS_FILTER_LABELS] ?? s}»`)), "shared/caseRules.ts:COMPLAINT_SLA_RUNNING"),
  // Críticas
  "reviews.complaintSlaHours": v(REVIEW_COMPLAINT_SLA_HOURS, "shared/reviewRules.ts:REVIEW_COMPLAINT_SLA_HOURS"),
  "reviews.autoDraftsFlag": d(automationFlagDefault("AI_REVIEW_AUTO_DRAFTS") ? "ligado" : "desligado", "shared/appSettings.ts:AUTOMATION_FLAGS[AI_REVIEW_AUTO_DRAFTS]"),
  "reviews.autoDraftMaxAgeDays":v(REVIEW_AUTO_DRAFT_MAX_AGE_DAYS, "shared/reviewRules.ts:REVIEW_AUTO_DRAFT_MAX_AGE_DAYS"),
  // Plano MPV F7 (§6.2): respostas automáticas às 5★
  "reviews.autoPublishFlag": d(automationFlagDefault("REVIEW_AUTO_PUBLISH_5STAR") ? "ligado" : "desligado", "shared/appSettings.ts:AUTOMATION_FLAGS[REVIEW_AUTO_PUBLISH_5STAR]"),
  "reviews.autoPublishDelayHours": v(REVIEW_AUTO_PUBLISH_DELAY_HOURS, "shared/reviewAutoPublish.ts:REVIEW_AUTO_PUBLISH_DELAY_HOURS"),
  "reviews.autoPublishMaxPerProfileDay": v(REVIEW_AUTO_PUBLISH_MAX_PER_PROFILE_DAY, "shared/reviewAutoPublish.ts:REVIEW_AUTO_PUBLISH_MAX_PER_PROFILE_DAY"),
  "reviews.autoPublishMaxFailures": v(REVIEW_AUTO_PUBLISH_MAX_CONSECUTIVE_FAILURES, "shared/reviewAutoPublish.ts:REVIEW_AUTO_PUBLISH_MAX_CONSECUTIVE_FAILURES"),
  "reviews.autoPublishExpireHours": v(REVIEW_AUTO_PUBLISH_EXPIRE_HOURS, "shared/reviewAutoPublish.ts:REVIEW_AUTO_PUBLISH_EXPIRE_HOURS"),
  "reviews.autoPublishVerifyDays": v(REVIEW_AUTO_PUBLISH_VERIFY_DAYS, "shared/reviewAutoPublish.ts:REVIEW_AUTO_PUBLISH_VERIFY_DAYS"),
  "reviews.autoPublishMaxAttempts": v(REVIEW_AUTO_PUBLISH_MAX_ATTEMPTS, "shared/reviewAutoPublish.ts:REVIEW_AUTO_PUBLISH_MAX_ATTEMPTS"),
  "reviews.verifyFailDays": v(REVIEW_AUTO_PUBLISH_VERIFY_FAIL_DAYS, "shared/reviewAutoPublish.ts:REVIEW_AUTO_PUBLISH_VERIFY_FAIL_DAYS"),
  "reviews.replyMinChars": v(REPLY_MIN_CHARS, "shared/reviewAutoPublish.ts:REPLY_MIN_CHARS"),
  "reviews.replyMaxChars": v(REPLY_MAX_CHARS, "shared/reviewAutoPublish.ts:REPLY_MAX_CHARS"),
  // D7 (16 out 2026): quem faz de tutor na Formação e os limites de cada um
  "training.tutorMode": d(`«${TUTOR_MODE_LABELS[TUTOR_DEFAULT_MODE]}»`, "shared/trainingTutor.ts:TUTOR_DEFAULT_MODE"),
  "training.tutorPerMinute": d(TUTOR_DEFAULT_LIMITS.perMinute, "shared/trainingTutor.ts:TUTOR_DEFAULT_LIMITS"),
  "training.tutorPerDay": d(TUTOR_DEFAULT_LIMITS.perDay, "shared/trainingTutor.ts:TUTOR_DEFAULT_LIMITS"),
  "assistant.perMinute": d(AI_ASSISTANT_DEFAULT_LIMITS.perMinute, "shared/appSettings.ts:AI_ASSISTANT_DEFAULT_LIMITS"),
  "assistant.perDay": d(AI_ASSISTANT_DEFAULT_LIMITS.perDay, "shared/appSettings.ts:AI_ASSISTANT_DEFAULT_LIMITS"),
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

/** Distância (caracteres) em que tem de aparecer "por omissão" ou "em uso" à volta de um marcador de definição. */
export const SETTING_NOTE_WINDOW = 120;
const SETTING_NOTE_RE = /por omiss[aã]o|em uso/i;

/** Os usos de marcadores de definições sem "por omissão"/"em uso" por perto. PURA. */
export function settingMarkersWithoutNote(text: string, values: Readonly<Record<string, HelpRuleValue>> = HELP_RULE_VALUES): Array<{ key: string; at: number; context: string }> {
  const out: Array<{ key: string; at: number; context: string }> = [];
  for (const m of text.matchAll(MARKER_RE)) {
    const hit = Object.prototype.hasOwnProperty.call(values, m[1]) ? values[m[1]] : undefined;
    if (!hit?.setting) continue;
    const at = m.index ?? 0;
    const around = text.slice(Math.max(0, at - SETTING_NOTE_WINDOW), at + m[0].length + SETTING_NOTE_WINDOW);
    if (!SETTING_NOTE_RE.test(around)) out.push({ key: m[1], at, context: around.replace(/\s+/g, " ").slice(0, 160) });
  }
  return out;
}

/**
 * Troca os `{{regra:chave}}` pelos valores do código; desconhecido ou mal
 * escrito = erro; marcador de definição sem "por omissão"/"em uso" por perto
 * = erro (desliga-se com `requireDefaultNote: false`, só para testes). PURA.
 */
export function renderRuleMarkers(text: string, file = "?", values: Readonly<Record<string, HelpRuleValue>> = HELP_RULE_VALUES, opts: { requireDefaultNote?: boolean } = {}): string {
  if (opts.requireDefaultNote !== false) {
    const bad = settingMarkersWithoutNote(text, values);
    if (bad.length) throw new HelpRuleMarkerError(`${file}: {{regra:${bad[0].key}}} é o valor por omissão de uma definição — escreve "por omissão" (ou "em uso") perto: «${bad[0].context}».`);
  }
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
