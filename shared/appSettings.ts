/**
 * Definições da aplicação (página /definicoes) — regras PURAS, partilhadas
 * entre servidor (validação ao gravar) e cliente (validação no formulário).
 *
 *  - SETTINGS: definições editáveis (chave → schema zod + valor por omissão);
 *  - AUTOMATION_FLAGS: interruptores das automações que podem ser sobrepostos
 *    na BD (o resto das env vars NUNCA é sobreposto);
 *  - CRON_JOBS: os /api/cron/* (corridos pelo agendador /api/cron/tick) e o
 *    intervalo esperado de cada um (para detetar crons parados);
 *  - NOTIFICATION_KINDS: vista compatível do catálogo de notificações
 *    (shared/notificationRouting.ts — quem recebe o quê).
 */
import { z } from "zod";
import { AI_FEATURE_IDS, AI_THINKING_LEVELS, AI_TIERS } from "./aiFeatures";
import { DEFAULT_HOME_CITY_ONLY, NOTIFICATION_KIND_DEFS, NOTIFICATION_ROUTING_SETTING_KEY, notificationRoutingSchema } from "./notificationRouting";
import { DEFAULT_BRAND_DOMAINS, DEFAULT_MAIL_ALIAS_DOMAINS, DEFAULT_MAILBOX_SOURCE, MAIL_WORKSPACE_PRIMARY_DOMAIN, MAIL_BRAND_IDS, MAIL_DEFAULT_BACKFILL_DAYS, MAIL_DEFAULT_RETENTION_YEARS, MAIL_DEFAULT_SLA_HOURS } from "./mail";
import { DEFAULT_SHARED_CALENDARS_CONFIG, sharedCalendarsConfigSchema } from "./googleSync";
import { DEFAULT_CONTACTS_CONFIG, contactsConfigSchema } from "./contacts";
import { DEFAULT_DRIVE_CONFIG, driveConfigSchema } from "./drive";
import { DEFAULT_WEB_ANALYTICS_CONFIG, WEB_ANALYTICS_SETTING_KEY, webAnalyticsConfigSchema } from "./webAnalytics";
import { DEFAULT_GBP_CONFIG, GBP_SETTING_KEY, gbpConfigSchema } from "./googleBusinessProfile";
import { DEFAULT_KNOWLEDGE_CONFIG, KNOWLEDGE_SETTING_KEY, knowledgeConfigSchema } from "./knowledge";
import { DEFAULT_SERVICE_TASK_RULES, SERVICE_TASKS_SETTING_KEY, serviceTaskRulesSchema } from "./serviceTasks";
import { matchKey } from "./textKey";
import { PRESSURE_SINCE_DEFAULT } from "./extrasPressure";
import { DEFAULT_TERMINAL_AIRPORTS } from "./pontoTerminal";
import { DOCS_TEMPLATE_PATTERN } from "./docsRequest";
import { COMMS_ROUTING_DEFAULTS, commsRoutingSettingsSchema } from "./commsRouting";
import { MAIL_BACKFILL_DEFAULTS, mailBackfillSettingsSchema } from "./mailTriage";
import { COMPLAINT_INTAKE_DEFAULTS, complaintIntakeSettingsSchema } from "./complaintIntake";
import { DEFAULT_SPEED_RULE, SPEED_RULE_SETTING_KEY, speedRuleSchema } from "./speedRules";
import { PERF_RANK_WEIGHTS_KEY, rankWeightsReadSchema, rankWeightsSchema } from "./peoplePerformance";
import { DEFAULT_PARK_ZONES, PARK_ZONE_KINDS, PARK_ZONE_RADIUS, p2TerminalConflicts, type ParkZonesMap } from "./serviceGps";
import type { AirportFence } from "./pontoTerminal";
import {
  DEFAULT_GARAGE_ROLES, DEFAULT_GPS_GATE, DEFAULT_PICKUP_T2_TARGET_MINUTES, DEFAULT_SERVICE_TARGET_MINUTES, GARAGE_ROLES,
  SERVICE_TIMES_GPS_SINCE_DEFAULT, SERVICE_TIMES_SINCE_DEFAULT,
} from "./serviceTimes";
import { EVALUATION_CLOSED_UNTIL_KEY, EVALUATION_CLOSERS_KEY, isIsoDay } from "./evaluationClose";
import { operationalDayOf } from "./lisbonDay";
import { MANUAL_EDIT_AT_CONFIRM_DEFAULT, MANUAL_EDIT_AT_CONFIRM_MODES, type ManualEditAtConfirm } from "./extrasSchedule";
import { DEFAULT_REMINDER_RECIPIENTS, reminderRecipientsSchema } from "./extrasReminders";

// ─── Entrar com código (plano 56) ───────────────────────────────────────────

/** Para onde vai o código de entrada: TL/supervisor de serviço (duty) ou o email da pessoa (A2). */
export const LOGIN_CODE_DELIVERY_MODES = ["duty", "email"] as const;
export type LoginCodeDeliveryMode = (typeof LOGIN_CODE_DELIVERY_MODES)[number];
export const LOGIN_CODE_DELIVERY_SETTING_KEY = "login.codeDelivery";

// ─── Taxas com data de efeito (IVA / TSU) ───────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const rateEntrySchema = z.object({
  /** Fração (0.23 = 23%). */
  rate: z.number({ error: "Taxa inválida." }).min(0, "A taxa não pode ser negativa.").max(1, "A taxa é uma fração (ex.: 0,23)."),
  /** Primeiro dia (Lisboa, AAAA-MM-DD) em que a taxa se aplica. */
  from: z.string().regex(ISO_DAY, "Data inválida (AAAA-MM-DD)."),
});
export type RateEntry = z.infer<typeof rateEntrySchema>;

export const rateScheduleSchema = z
  .array(rateEntrySchema)
  .min(1, "Indica pelo menos uma taxa.")
  .max(20, "No máximo 20 taxas.")
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const e of list) {
      if (seen.has(e.from)) ctx.addIssue({ code: "custom", message: `Data de efeito repetida: ${e.from}.` });
      seen.add(e.from);
    }
  })
  .transform((list) => [...list].sort((a, b) => a.from.localeCompare(b.from)));

/** Taxa em vigor num dia (a última com `from` <= dia); `null` se nenhuma. PURA. */
export function effectiveRate(list: readonly RateEntry[] | null | undefined, day: string): number | null {
  let best: RateEntry | null = null;
  for (const e of list ?? []) {
    if (e.from <= day && (!best || e.from > best.from)) best = e;
  }
  return best ? best.rate : null;
}

// ─── Registo das definições editáveis ───────────────────────────────────────

const emailSchema = z.string().trim().toLowerCase().email("Email inválido.").max(320);

export const emailListSchema = z
  .array(emailSchema)
  .max(20, "No máximo 20 emails.")
  .transform((list) => Array.from(new Set(list)));

/** Preço (EUR por 1M tokens) de um modelo de IA — sobreposição da tabela do código. */
export const aiModelPriceSchema = z.object({
  input: z.number({ error: "Preço de entrada inválido." }).min(0).max(1000),
  output: z.number({ error: "Preço de saída inválido." }).min(0).max(1000),
  cached: z.number().min(0).max(1000).optional(),
  audioInput: z.number().min(0).max(1000).optional(),
});
export const aiPriceOverridesSchema = z
  .record(z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, "Nome de modelo inválido."), aiModelPriceSchema)
  .refine((r) => Object.keys(r).length <= 40, "No máximo 40 modelos.");
export type AiPriceOverrides = z.infer<typeof aiPriceOverridesSchema>;

/** Nível de modelo por funcionalidade de IA (só ids e níveis conhecidos). */
export const aiFeatureTiersSchema = z.record(
  z.string().refine((k) => (AI_FEATURE_IDS as readonly string[]).includes(k), "Funcionalidade de IA desconhecida."),
  z.enum(AI_TIERS as unknown as ["lite", "fast", "smart"], { error: "Nível inválido (lite, fast ou smart)." }),
);

/**
 * Raciocínio por funcionalidade de IA (plano MPV, F0a). Só ids conhecidos e
 * níveis do Gemini 3.x; "default" = o do próprio modelo. Vazio = a env
 * AI_THINKING_LEVEL (omissão "low") para todas, como até aqui.
 */
export const aiThinkingLevelsSchema = z.record(
  z.string().refine((k) => (AI_FEATURE_IDS as readonly string[]).includes(k), "Funcionalidade de IA desconhecida."),
  z.enum(AI_THINKING_LEVELS as unknown as ["minimal", "low", "medium", "high", "default"], { error: "Nível inválido (minimal, low, medium, high ou default)." }),
);

export type SettingGroup = "financeiro" | "sla" | "emails" | "disponibilidade" | "ia" | "extras" | "notificacoes" | "marketing" | "operacao" | "servicos" | "pessoas";

// ─── Zello (GPS) ────────────────────────────────────────────────────────────

/**
 * Contas Zello que NÃO entram na recolha GPS nem nos alertas de GPS (consolas
 * de despacho, contas de teste). Lista explícita — a flag "admin" do Zello já
 * não exclui ninguém (auditoria PDA/Zello, B5).
 */
export const ZELLO_GPS_EXCLUDED_KEY = "zello.gpsExcludedUsers" as const;
export const zelloUsernameListSchema = z
  .array(z.string().trim().min(1, "Utilizador Zello vazio.").max(255, "Utilizador Zello demasiado longo."))
  .max(200, "No máximo 200 contas.")
  .transform((list) => Array.from(new Set(list)));

/** Lista gravada → conjunto para comparar (sem distinguir maiúsculas). PURA. */
export function zelloExclusionSet(list: readonly string[] | null | undefined): Set<string> {
  return new Set((list ?? []).map((u) => matchKey(u)).filter(Boolean));
}

/** Esta conta Zello está na lista de exclusão do GPS? PURA. */
export function isZelloGpsExcluded(username: string | null | undefined, excluded: ReadonlySet<string>): boolean {
  const k = matchKey(username);
  return !!k && excluded.has(k);
}

// ─── Parques que a operação não faz ─────────────────────────────────────────

export const EXCLUDED_PARKS_SETTING_KEY = "operations.excludedParks" as const;

/** Ids de parques ("Park".id da BD da Multipark), sem repetidos. */
export const parkIdListSchema = z
  .array(z.string({ error: "Id de parque inválido." }).trim().min(1, "Id de parque vazio.").max(64, "Id de parque demasiado longo."), { error: "Indica uma lista de parques." })
  .max(300, "No máximo 300 parques.")
  .transform((list) => Array.from(new Set(list)));

// ─── Extras-dia (escala automática) ─────────────────────────────────────────

/** Cidades do Extras-dia (mesmos ids do servidor: server/extrasDia.ts). */
export const EXTRAS_CITY_IDS = ["lisbon", "porto", "faro"] as const;
export type ExtrasCityId = (typeof EXTRAS_CITY_IDS)[number];

const carsPerHourValue = z
  .number({ error: "Indica um número de carros por hora." })
  .min(0.5, "Mínimo 0,5 carros/hora.")
  .max(20, "Máximo 20 carros/hora.");

/**
 * Tempo por carro de cada condutor conforme as PESSOAS no turno, TL incluído
 * (Jorge, 3 out — D12): "2 pessoas" = TL + 1 extra. Quem conduz são os
 * extras (o TL vai buscá-los). `minCrew`: o mínimo de pessoas quando há
 * trabalho (Faro/Porto: 2 extras + TL = 3).
 */
const crewBandSchema = z.object({
  upTo: z.number().int().min(1).max(60).nullable(),
  minutes: z.number().min(5, "Mínimo 5 minutos por carro.").max(240, "Máximo 240 minutos por carro."),
});
const crewRuleSchema = z.object({
  minCrew: z.number().int().min(1).max(20),
  bands: z.array(crewBandSchema).min(1).max(12),
}).refine((r) => r.bands[r.bands.length - 1].upTo === null, { message: "A última linha é \"a partir daí\" (upTo: null)." })
  .refine((r) => r.bands.every((b, i) => i === 0 || b.upTo === null || (r.bands[i - 1].upTo ?? 0) < b.upTo), { message: "As linhas vão por ordem crescente de pessoas." });
export const crewRulesSchema = z.object({ lisbon: crewRuleSchema, porto: crewRuleSchema, faro: crewRuleSchema }, { error: "Indica as regras de Lisboa, Porto e Faro." });
export type CrewRulesMap = z.infer<typeof crewRulesSchema>;
// 22d (Jorge, 3 out): medir desde 6 meses atrás e acumular; p75 Lisboa, p60 Porto e Faro.
const timesSinceSchema = z.string({ error: "Indica o dia (AAAA-MM-DD)." })
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dia no formato AAAA-MM-DD.")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && d >= "2025-01-01", "Dia inválido (a partir de 2025).");
const percentileChoice = z.union([z.literal(50), z.literal(60), z.literal(75), z.literal(85), z.literal(90)], { error: "Percentil: 50, 60, 75, 85 ou 90." });
export const timesPercentileSchema = z.object({ lisbon: percentileChoice, porto: percentileChoice, faro: percentileChoice }, { error: "Indica Lisboa, Porto e Faro." });
export type TimesPercentileMap = z.infer<typeof timesPercentileSchema>;
export const DEFAULT_TIMES_PERCENTILE: TimesPercentileMap = { lisbon: 75, porto: 60, faro: 60 };
// 26c (fase 2 da capacidade aprendida): a escala usa os tempos medidos, nunca
// acima da tabela. Desligado por omissão (por cidade).
export const useMeasuredTimesSchema = z.object({ lisbon: z.boolean(), porto: z.boolean(), faro: z.boolean() }, { error: "Indica, para Lisboa, Porto e Faro, se fica ligado ou desligado." });
export type UseMeasuredTimesMap = z.infer<typeof useMeasuredTimesSchema>;
export const DEFAULT_USE_MEASURED_TIMES: UseMeasuredTimesMap = { lisbon: false, porto: false, faro: false };
// 26d (regra do Jorge): a recolha feita pelo meio de uma entrega (mesmo
// terminal, −10/+30 min) não conta como carro na previsão. Por cidade;
// desligado por omissão (mexe no número de extras que se chamam).
export const pairPickupsSchema = useMeasuredTimesSchema;
export type PairPickupsMap = UseMeasuredTimesMap;
export const DEFAULT_PAIR_PICKUPS: PairPickupsMap = { lisbon: false, porto: false, faro: false };
// Tempos de entrega (15 out 2026): a "hora apertada" pela Fila em vez do total. Por cidade; desligado por omissão.
export const tightUsesQueueSchema = useMeasuredTimesSchema;
export type TightUsesQueueMap = UseMeasuredTimesMap;
export const DEFAULT_TIGHT_USES_QUEUE: TightUsesQueueMap = { lisbon: false, porto: false, faro: false };

export const DEFAULT_CREW_RULES: CrewRulesMap = {
  lisbon: { minCrew: 2, bands: [{ upTo: 2, minutes: 75 }, { upTo: 4, minutes: 60 }, { upTo: 6, minutes: 45 }, { upTo: null, minutes: 30 }] },
  porto: { minCrew: 3, bands: [{ upTo: 2, minutes: 45 }, { upTo: null, minutes: 30 }] },
  faro: { minCrew: 3, bands: [{ upTo: 2, minutes: 45 }, { upTo: null, minutes: 30 }] },
};

/** (Antigo, até 22b) Carros/hora que UM condutor despacha, por cidade. Já não é usado. */
export const carsPerHourMapSchema = z.object({
  lisbon: carsPerHourValue,
  porto: carsPerHourValue,
  faro: carsPerHourValue,
}, { error: "Indica os carros/hora de Lisboa, Porto e Faro." });
export type CarsPerHourMap = z.infer<typeof carsPerHourMapSchema>;
export const DEFAULT_CARS_PER_HOUR: CarsPerHourMap = { lisbon: 2, porto: 3, faro: 3 };

/**
 * Aeroportos do terminal no ponto (Jorge, 7 out 2026): centro (lat/lng) e raio
 * por cidade. Entrada/saída do ponto de um extra com GPS dentro do raio do
 * aeroporto da cidade dele = troço de terminal (shared/pontoTerminal.ts).
 */
const latSchema = z.number({ error: "Indica a latitude (ex.: 38.7742)." }).min(-90, "Latitude entre -90 e 90.").max(90, "Latitude entre -90 e 90.");
const lngSchema = z.number({ error: "Indica a longitude (ex.: -9.1342)." }).min(-180, "Longitude entre -180 e 180.").max(180, "Longitude entre -180 e 180.");
/**
 * Plano 56 (terminal pelo perfil): zonas por terminal (T1/T2…), centro + raio.
 * Opcional — sem zonas vale o círculo do aeroporto (como até aqui).
 */
const terminalZoneSchema = z.object({
  label: z.string().trim().max(40, "Nome da zona: máximo 40 caracteres.").optional(),
  lat: latSchema,
  lng: lngSchema,
  radiusM: z.number({ error: "Indica o raio da zona em metros." }).int("Raio em metros inteiros.").min(50, "Raio mínimo da zona: 50 m.").max(5000, "Raio máximo da zona: 5 000 m."),
});
const airportFenceSchema = z.object({
  lat: latSchema,
  lng: lngSchema,
  radiusM: z.number({ error: "Indica o raio em metros." }).int("Raio em metros inteiros.").min(100, "Raio mínimo: 100 m.").max(10000, "Raio máximo: 10 000 m."),
  zones: z.array(terminalZoneSchema).max(6, "Máximo 6 zonas por aeroporto.").optional(),
});
export const terminalAirportsSchema = z.object({ lisbon: airportFenceSchema, porto: airportFenceSchema, faro: airportFenceSchema }, { error: "Indica os aeroportos de Lisboa, Porto e Faro." });
export const TERMINAL_AIRPORTS_SETTING_KEY = "ponto.terminalAirports" as const;

// ─── Tempos de entrega e de recolha (plano 62, P5) ──────────────────────────

export const PARK_ZONES_SETTING_KEY = "operations.parkZones" as const;
export const GARAGE_ROLES_SETTING_KEY = "operations.garageRoles" as const;
export const SERVICE_TIMES_SETTING_KEYS = [
  "serviceTimes.targetMinutes", "serviceTimes.pickupT2TargetMinutes", "serviceTimes.since", "serviceTimes.gpsSince",
  "serviceTimes.useCalls", "serviceTimes.inBriefing", "serviceTimes.gpsGate",
] as const;

/**
 * Exceção a uma zona da operação (Q6: as zonas vêm das garagens da
 * Multipark): `label` = nome da garagem (ou de uma zona nova); centro, raio
 * (50–1 000 m) e tipo só quando se querem mudar.
 */
const parkZoneSchema = z.object({
  label: z.string({ error: "Indica a garagem (ex.: P2)." }).trim().min(1, "Indica a garagem (ex.: P2).").max(80, "Nome da garagem: máximo 80 caracteres."),
  kind: z.enum(PARK_ZONE_KINDS as unknown as ["p2", "pd", "central", "coberto", "outra"], { error: "Tipo de zona: P2, PD, central, coberto ou outra." }).optional(),
  lat: latSchema.optional(),
  lng: lngSchema.optional(),
  radiusM: z.number({ error: "Indica o raio da zona em metros." }).int("Raio em metros inteiros.")
    .min(PARK_ZONE_RADIUS.min, `Raio mínimo da zona: ${PARK_ZONE_RADIUS.min} m.`).max(PARK_ZONE_RADIUS.max, `Raio máximo da zona: ${PARK_ZONE_RADIUS.max} m.`).optional(),
  garages: z.array(z.string().trim().min(1, "Nome de garagem vazio.").max(80, "Nome de garagem: máximo 80 caracteres.")).max(20, "Máximo 20 garagens por zona.").optional(),
}).refine((z0) => (z0.lat == null) === (z0.lng == null), { message: "Indica a latitude E a longitude (ou nenhuma, para usar as da Multipark)." });
const parkZoneListSchema = z.array(parkZoneSchema).max(12, "Máximo 12 zonas por cidade.").superRefine((list, ctx) => {
  const seen = new Set<string>();
  for (const z0 of list) {
    const k = matchKey(z0.label);
    if (seen.has(k)) ctx.addIssue({ code: "custom", message: `Garagem repetida: ${z0.label}.` });
    seen.add(k);
  }
});
export const parkZonesSchema = z.object({ lisbon: parkZoneListSchema, porto: parkZoneListSchema, faro: parkZoneListSchema }, { error: "Indica as exceções de Lisboa, Porto e Faro (lista vazia = nenhuma)." });

/** Papel de cada garagem nos tempos das recolhas (provisória / já num parque / parque certo). */
export const garageRolesSchema = z.array(z.object({
  garage: z.string({ error: "Nome da garagem em falta." }).trim().min(1, "Nome da garagem em falta.").max(80, "Nome da garagem: máximo 80 caracteres."),
  role: z.enum(GARAGE_ROLES as unknown as ["provisoria", "parque", "final"], { error: "Papel: provisoria, parque ou final." }),
})).max(60, "Máximo 60 garagens.").superRefine((list, ctx) => {
  const seen = new Set<string>();
  for (const g of list) {
    const k = matchKey(g.garage);
    if (seen.has(k)) ctx.addIssue({ code: "custom", message: `Garagem repetida: ${g.garage}.` });
    seen.add(k);
  }
});

/** Portão dos tempos com GPS (§8.1). */
export const gpsGateSchema = z.object({
  visible: z.boolean({ error: "visible: true ou false." }),
  minCoveragePct: z.number({ error: "minCoveragePct: um número (%)." }).min(0, "minCoveragePct: entre 0 e 100.").max(100, "minCoveragePct: entre 0 e 100."),
  minN: z.number({ error: "minN: um número." }).int("minN: número inteiro.").min(1, "minN: mínimo 1.").max(10000, "minN: máximo 10 000."),
}).strict();

const PARK_ZONE_CITY_LABEL: Record<string, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };

/**
 * Zonas P2 a tocar numa zona do terminal → texto do erro (recusado ao
 * gravar, §5.2); null = pode gravar. Recebe as zonas EM VIGOR (garagens da
 * Multipark + exceções: effectiveParkZones). PURA (o servidor e o editor usam-na).
 */
export function parkZonesConflictError(zones: Partial<ParkZonesMap> | null | undefined, airports: Partial<Record<string, AirportFence>> | null | undefined): string | null {
  const hits = p2TerminalConflicts(zones, airports);
  if (!hits.length) return null;
  const list = hits.map((h) => `${h.p2} toca na zona ${h.terminal} do terminal (${PARK_ZONE_CITY_LABEL[h.city] ?? h.city}, centros a ${h.distanceM} m)`).join("; ");
  return `A zona P2 não pode tocar numa zona do terminal: ${list}. Afasta o centro ou diminui o raio — senão a saída do terminal e a paragem no P2 ficavam iguais.`;
}

const serviceDaySchema = z.string({ error: "Indica o dia (AAAA-MM-DD)." })
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dia no formato AAAA-MM-DD.")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && d >= "2025-01-01", "Dia inválido (a partir de 2025).");

/**
 * Template do WhatsApp do pedido de documentos em falta, por cidade:
 * "nome_do_modelo|pt_PT" ou vazio (= por configurar: só email). Pauta do
 * Rafael, 7 out 2026 — regras em shared/docsRequest.ts.
 */
const docsTemplateValue = z.string().trim().max(540, "Máximo 540 caracteres.")
  .refine((v) => v === "" || DOCS_TEMPLATE_PATTERN.test(v), "Formato: nome_do_modelo|pt_PT (ou vazio para não usar o WhatsApp nesta cidade).");
export const docsRequestTemplatesSchema = z.object({
  lisbon: docsTemplateValue,
  porto: docsTemplateValue,
  faro: docsTemplateValue,
}, { error: "Indica o template de Lisboa, Porto e Faro (ou deixa vazio)." });

/** Ponto de encontro por cidade (vai no aviso de escala); vazio = não se indica. */
export const meetingPointMapSchema = z.object({
  lisbon: z.string().trim().max(200, "Máximo 200 caracteres."),
  porto: z.string().trim().max(200, "Máximo 200 caracteres."),
  faro: z.string().trim().max(200, "Máximo 200 caracteres."),
});

/**
 * Quem recebe o WhatsApp: um telefone (ex.: "+351912345678") ou, 38a (Jorge:
 * "devia dar para pôr o nome do RH, que já tem os contactos"), uma pessoa do
 * RH como "ficha:<id>" — o telefone vem da ficha na hora de enviar.
 */
export const PRESENCE_FICHA_PREFIX = "ficha:";
const PRESENCE_PHONE_RE = /^\+?[0-9][0-9 ]{7,19}$/;
const PRESENCE_FICHA_RE = /^ficha:[1-9][0-9]{0,9}$/;
/** "ficha:12" → 12; um telefone → null. PURA. */
export function presenceFichaId(entry: string): number | null {
  const v = String(entry ?? "").trim();
  return PRESENCE_FICHA_RE.test(v) ? Number(v.slice(PRESENCE_FICHA_PREFIX.length)) : null;
}
const phoneListSchema = z.array(z.string().trim().refine((v) => PRESENCE_PHONE_RE.test(v) || PRESENCE_FICHA_RE.test(v), "Telefone inválido (ex.: +351912345678).")).max(20, "Máximo 20 pessoas ou números.");

/** Alertas sem PDA/Zello: administradores por cidade + cópia (recebem o WhatsApp). */
export const presencePhonesSchema = z.object({
  lisbon: phoneListSchema,
  porto: phoneListSchema,
  faro: phoneListSchema,
  copy: phoneListSchema,
});

/** Hora "HH:MM" (Lisboa). */
export const hhmmSchema = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora inválida (HH:MM, ex.: 14:00).");

/** "14:30" → 870 (minutos desde a meia-noite). PURA. */
export function hhmmToMinutes(v: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}
/** Limites do tutor da formação (pedidos por pessoa). */
export const trainingTutorLimitsSchema = z.object({
  perMinute: z.number({ error: "Indica um número por minuto." }).int("Número inteiro.").min(1, "Mínimo 1 por minuto.").max(120, "Máximo 120 por minuto."),
  perDay: z.number({ error: "Indica um número por dia." }).int("Número inteiro.").min(1, "Mínimo 1 por dia.").max(5000, "Máximo 5000 por dia."),
});

/** Limites do assistente (chat): pedidos por pessoa e tamanho da pergunta. */
export const aiAssistantLimitsSchema = z.object({
  perMinute: z.number({ error: "perMinute tem de ser um número." }).int().min(1, "perMinute: mínimo 1.").max(120, "perMinute: máximo 120."),
  perDay: z.number({ error: "perDay tem de ser um número." }).int().min(1, "perDay: mínimo 1.").max(5000, "perDay: máximo 5000."),
  maxInputChars: z.number({ error: "maxInputChars tem de ser um número." }).int().min(100, "maxInputChars: mínimo 100.").max(4000, "maxInputChars: máximo 4000.").optional(),
}).strict();
export type AiAssistantLimits = z.infer<typeof aiAssistantLimitsSchema>;
export const AI_ASSISTANT_DEFAULT_LIMITS = { perMinute: 20, perDay: 200, maxInputChars: 1000 } as const;


/** Tarefa 62 (P2d): data AAAA-MM-DD ou nula ("" = nula, para o campo de texto/data). */
export const closedUntilSchema = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : typeof v === "string" ? v.trim() : v),
  z.string({ error: "Indica a data (AAAA-MM-DD)." }).refine(isIsoDay, "Data inválida (AAAA-MM-DD).").nullable(),
);
/** Lista de contas (ids de utilizador), sem repetir. */
export const userIdListSchema = z.array(z.number({ error: "Escolhe as contas na lista." }).int().positive()).max(50, "No máximo 50 contas.")
  .transform((ids) => Array.from(new Set(ids)));

/** Plano MPV §5.2 (F0b): quem está no piloto do Multis (ids de utilizador). */
export const aiAssistantPilotSchema = z.object({
  userIds: z.array(z.number({ error: "userIds: só números (ids das contas)." }).int().positive()).max(50, "No máximo 50 contas no piloto.")
    .transform((ids) => Array.from(new Set(ids))),
}).strict();
export type AiAssistantPilot = z.infer<typeof aiAssistantPilotSchema>;

/** Plano MPV §5.3 (F0b): teto € próprio do Multis do piloto (assistant_smart). Os três > 0 (sem "sem teto"). */
export const aiAssistantSmartBudgetSchema = z.object({
  // Sem "sem teto": o piloto tem sempre os três tetos (auditoria M2).
  eurPerDay: z.number({ error: "eurPerDay tem de ser um número." }).positive("eurPerDay: tem de ser maior que 0 (o piloto tem sempre teto).").max(10_000, "eurPerDay: máximo 10 000 €."),
  eurPerMonth: z.number({ error: "eurPerMonth tem de ser um número." }).positive("eurPerMonth: tem de ser maior que 0 (o piloto tem sempre teto).").max(100_000, "eurPerMonth: máximo 100 000 €."),
  eurPerUserPerDay: z.number({ error: "eurPerUserPerDay tem de ser um número." }).positive("eurPerUserPerDay: tem de ser maior que 0 (o piloto tem sempre teto).").max(10_000, "eurPerUserPerDay: máximo 10 000 €."),
}).strict();
export type AiAssistantSmartBudget = z.infer<typeof aiAssistantSmartBudgetSchema>;
export const AI_ASSISTANT_SMART_DEFAULT_BUDGET: AiAssistantSmartBudget = { eurPerDay: 10, eurPerMonth: 150, eurPerUserPerDay: 3 };
export const AI_ASSISTANT_SMART_DEFAULT_LIMITS = { perMinute: 10, perDay: 80, maxInputChars: 1000 } as const;

export interface SettingDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  schema: S;
  defaultValue: z.input<S>;
  /** Onde o valor é usado; "store" = só guardado/mostrado (ainda não ligado ao código). */
  wiring: "live" | "store";
  /** Validação mais apertada só ao GRAVAR (a leitura usa `schema`, que pode ser mais tolerante com valores antigos). */
  writeSchema?: z.ZodTypeAny;
}

function def<S extends z.ZodTypeAny>(d: SettingDef<S>): SettingDef<S> {
  return d;
}

export const SETTINGS = {
  "finance.vat": def({
    key: "finance.vat",
    group: "financeiro",
    label: "IVA",
    description: "Taxa de IVA por data de efeito. Usada nos cálculos de Finanças (receita e despesas sem IVA) e de Marketing (ROAS s/ IVA) a partir da data de efeito; antes da primeira data usa-se 23%.",
    schema: rateScheduleSchema,
    defaultValue: [{ rate: 0.23, from: "2011-01-01" }],
    wiring: "live",
  }),
  "finance.tsu": def({
    key: "finance.tsu",
    group: "financeiro",
    label: "TSU (entidade patronal)",
    description: "Taxa Social Única a cargo da empresa, por data de efeito. Usada nos custos de pessoal em Finanças a partir da data de efeito; antes da primeira data usa-se 23,75%.",
    schema: rateScheduleSchema,
    defaultValue: [{ rate: 0.2375, from: "2011-01-01" }],
    wiring: "live",
  }),
  "sla.incidentHours": def({
    key: "sla.incidentHours",
    group: "sla",
    label: "Prazo das ocorrências (horas)",
    description: "Prazo de resolução dado a cada ocorrência nova. Sobrepõe-se a INCIDENT_SLA_HOURS.",
    schema: z.number({ error: "Indica um número de horas." }).int("Número inteiro de horas.").min(1, "Mínimo 1 hora.").max(720, "Máximo 720 horas (30 dias)."),
    defaultValue: 48,
    wiring: "live",
  }),
  "sla.lostFoundDays": def({
    key: "sla.lostFoundDays",
    group: "sla",
    label: "Prazo dos perdidos e achados (dias)",
    description: "Dias desde o registo até um perdido aberto ficar em atraso (quando o caso não tem prazo próprio na Atribuição): conta para o \"Em atraso\" do painel, para os lembretes diários e para a cor do \"Parado há N dias\" (âmbar a ~3/7 do prazo, vermelho no prazo).",
    schema: z.number({ error: "Indica um número de dias." }).int("Número inteiro de dias.").min(1, "Mínimo 1 dia.").max(90, "Máximo 90 dias."),
    defaultValue: 7,
    // D24 (Jorge, 3 out 2026): passou a mandar no prazo dos Perdidos.
    wiring: "live",
  }),
  "sync.webhookStaleHours": def({
    key: "sync.webhookStaleHours",
    group: "sla",
    label: "Alerta sem notificações Multipark (horas)",
    description: "Se não chegar nenhum webhook da Multipark durante este número de horas, em horário de operação (07h–23h, Lisboa), os admins recebem um aviso na app (uma vez, e outra quando voltarem).",
    schema: z.number({ error: "Indica um número de horas." }).int("Número inteiro de horas.").min(1, "Mínimo 1 hora.").max(48, "Máximo 48 horas."),
    defaultValue: 3,
    wiring: "live",
  }),
  [ZELLO_GPS_EXCLUDED_KEY]: def({
    key: ZELLO_GPS_EXCLUDED_KEY,
    group: "operacao",
    label: "Contas Zello excluídas do GPS",
    description: "Utilizadores Zello (um por linha) que ficam fora da recolha GPS diária, dos alertas de GPS desligado e da lista \"Zello por ligar\" — consolas de despacho, contas de teste. Vazio = recolhe todos (a conta ser \"admin\" no Zello já não exclui ninguém).",
    schema: zelloUsernameListSchema,
    defaultValue: [],
    wiring: "live",
  }),
  // Jorge (14 out 2026): "há gente a 141 e 149 km/h, e o limite em Portugal é 120".
  [SPEED_RULE_SETTING_KEY]: def({
    key: SPEED_RULE_SETTING_KEY,
    group: "operacao",
    label: "Limite de velocidade (GPS do Zello)",
    description: "Quando é excesso de velocidade no GPS do Zello: o limite em km/h (120 = autoestrada em Portugal; o Zello não diz em que estrada se vai, por isso é um limite único), a tolerância em % (0 por omissão = conta acima de 120 km/h; 10 = 132 km/h) e quantos pontos seguidos acima dele contam um excesso (2 por omissão; um ponto sozinho só conta se a distância percorrida até ao ponto ao lado, a pelo menos 30 s, o confirmar; com o Zello a mandar pontos espaçados, o mesmo troço sem nenhum ponto abaixo do limite pelo meio é um excesso só). Os picos falsos do GPS (acima de 250 km/h ou um salto isolado) nunca contam. Vale para a recolha diária (excessos de cada dia, Atividade diária, Resumo do dia), para a Avaliação (1 excesso de velocidade, −10, por dia acima do limite, sem contar a dobrar com os alertas) e para o Desempenho (dias acima do limite). Os dias já recolhidos ficam como estavam até se voltarem a dividir (Atividade diária → Histórico Diário → Forçar re-divisão): na Avaliação e no Desempenho um dia só conta acima do MAIOR entre o limite de hoje e o limite com que foi recolhido (os dias recolhidos antes de se guardar o limite de cada dia contam a 132), para nunca contar um excesso que a recolha não confirmou. Substitui a tabela antiga speed_limits (sem ecrã).",
    schema: speedRuleSchema,
    defaultValue: { ...DEFAULT_SPEED_RULE },
    wiring: "live",
  }),
  [EXCLUDED_PARKS_SETTING_KEY]: def({
    key: EXCLUDED_PARKS_SETTING_KEY,
    group: "operacao",
    label: "Parques que a operação não faz",
    description: "Parques da BD da Multipark cujas entradas e saídas a operação NÃO faz: saem de Operações → Reservas do dia, da previsão e dos blocos dos Extras do dia, da Pressão, do estado ao vivo da Passagem de turno e das Ocorrências (lista, contagens, Suporte). As Reclamações e as Críticas vêm de todos os parques. Além destes, ficam SEMPRE fora os parques que não operamos (lista do dono, pelo nome: Top Parking, Check-in Park, Prime Park, …), marcados aqui como \"não operado\". Vazio = só a lista dos não operados.",
    schema: parkIdListSchema,
    defaultValue: [],
    wiring: "live",
  }),
  // Plano 62 (P5): tempos de entrega e de recolha — zonas, garagens e parâmetros.
  [PARK_ZONES_SETTING_KEY]: def({
    key: PARK_ZONES_SETTING_KEY,
    group: "operacao",
    label: "Zonas da operação (GPS)",
    description: "As zonas dos parques (P2, PD, central, coberto…) vêm das garagens da Multipark (o centro é o do link do mapa de cada garagem; o raio, o de omissão do tipo: P2 e coberto 150 m, PD e central 200 m). Aqui ficam só as EXCEÇÕES, por cidade: ajustar o raio (50 a 1 000 m), corrigir o centro ou o tipo de uma garagem, ou dar o centro a uma garagem que não tem coordenadas na Multipark (\"Sugerir\" propõe-no: posições da app nos movimentos das últimas 4 semanas, ou o parque). Servem aos tempos das recolhas (a saída do P2 pelo GPS quando a app não tem o início do movimento). Uma zona P2 que toque numa zona do terminal (Aeroportos → zonas) é recusada ao gravar: a saída do terminal e a paragem no P2 ficavam iguais.",
    schema: parkZonesSchema,
    defaultValue: DEFAULT_PARK_ZONES,
    wiring: "live",
  }),
  [GARAGE_ROLES_SETTING_KEY]: def({
    key: GARAGE_ROLES_SETTING_KEY,
    group: "operacao",
    label: "Papéis das garagens (tempos das recolhas)",
    description: "Para onde vai o carro depois do check-in: a garagem PROVISÓRIA (P2 — conta-se o tempo até sair de lá), as que já são UM PARQUE (CENTRAL, CENTRAL COBERTO — o carro já está num dos parques e deixa de se medir) e as do PARQUE CERTO (PD, PD FORA, COBERTO — arrumado se o tipo de lugar bater: descobertos e toldo no PD, interior no coberto). Os nomes são os da app (não contam maiúsculas nem espaços). Uma garagem fora da lista conta como \"parque certo\" e fica marcada como \"garagem sem papel\".",
    schema: garageRolesSchema,
    defaultValue: DEFAULT_GARAGE_ROLES.map((g) => ({ ...g })),
    wiring: "live",
  }),
  "serviceTimes.targetMinutes": def({
    key: "serviceTimes.targetMinutes",
    group: "operacao",
    label: "Tempos: meta da entrega (minutos)",
    description: "O nosso tempo de uma entrega = Fila + Trânsito (da chamada do cliente, ou do pendente, até o condutor chegar ao terminal). Conta para a % na meta. 15 por omissão.",
    schema: z.number({ error: "Indica um número de minutos." }).int("Número inteiro de minutos.").min(5, "Mínimo 5 minutos.").max(120, "Máximo 120 minutos."),
    defaultValue: DEFAULT_SERVICE_TARGET_MINUTES,
    wiring: "live",
  }),
  "serviceTimes.pickupT2TargetMinutes": def({
    key: "serviceTimes.pickupT2TargetMinutes",
    group: "operacao",
    label: "Tempos: recolha atrasada no T2 (minutos)",
    description: "Uma recolha no Terminal 2 fica atrasada quando o condutor chega à zona T2 mais do que isto depois de o cliente ligar (ou do \"em recolha\"). Só no T2 (no T1 há sempre gente de manhã) e só com GPS: sem GPS fica sem medição, nunca \"a tempo\". 15 por omissão (decisão do Jorge).",
    schema: z.number({ error: "Indica um número de minutos." }).int("Número inteiro de minutos.").min(1, "Mínimo 1 minuto.").max(120, "Máximo 120 minutos."),
    defaultValue: DEFAULT_PICKUP_T2_TARGET_MINUTES,
    wiring: "live",
  }),
  "serviceTimes.since": def({
    key: "serviceTimes.since",
    group: "operacao",
    label: "Tempos: medir desde",
    description: "Primeiro dia que o trabalho noturno dos tempos preenche para trás (sem GPS antes do dia do GPS). Mudar esta data não apaga nada.",
    schema: serviceDaySchema,
    defaultValue: SERVICE_TIMES_SINCE_DEFAULT,
    wiring: "live",
  }),
  "serviceTimes.gpsSince": def({
    key: "serviceTimes.gpsSince",
    group: "operacao",
    label: "Tempos: GPS desde",
    description: "A partir deste dia o preenchimento para trás também lê os pontos GPS do Zello guardados (antes não há pontos). Os dias anteriores ficam com os tempos que não dependem do GPS (Fila, Total, Cliente das recolhas, P2, até arrumado).",
    schema: serviceDaySchema,
    defaultValue: SERVICE_TIMES_GPS_SINCE_DEFAULT,
    wiring: "live",
  }),
  "serviceTimes.useCalls": def({
    key: "serviceTimes.useCalls",
    group: "operacao",
    label: "Tempos: contar desde a chamada do cliente",
    description: "Ligado (regra do Jorge): a Fila começa no mais cedo entre a chamada do cliente (central Vodafone ou WhatsApp, pelo telefone da reserva, até 60 min antes do pendente) e o pendente; nas recolhas, o mesmo com o \"em recolha\". Desligado: só o pendente (ou o \"em recolha\"). Só muda contas.",
    schema: z.boolean({ error: "Ligado ou desligado." }),
    defaultValue: true,
    wiring: "live",
  }),
  "serviceTimes.inBriefing": def({
    key: "serviceTimes.inBriefing",
    group: "operacao",
    label: "Tempos: linha no briefing por email",
    description: "Uma linha \"ontem\" com os tempos de entrega e de recolha no briefing diário (vai por email). Desligado por omissão.",
    schema: z.boolean({ error: "Ligado ou desligado." }),
    defaultValue: false,
    wiring: "store",
  }),
  "serviceTimes.gpsGate": def({
    key: "serviceTimes.gpsGate",
    group: "operacao",
    label: "Tempos com GPS: portão",
    description: "Os tempos que dependem do GPS (Trânsito, Cliente das entregas, Nosso, % na meta, No terminal, Até à 1.ª garagem, Atrasadas no T2, a máxima no Trânsito) só aparecem a quem não é super admin com \"visible\": true e, por cidade e período, com a cobertura ≥ minCoveragePct % e pelo menos minN medições; abaixo disso aparece \"Sem dados suficientes\". Fechado (omissão): só o super admin os vê, marcados como provisórios (\"em calibração\"); os outros veem \"Em calibração\". Vale no servidor (os números nem saem) no Resumo do dia, no dia do condutor, na Pressão, na Semana, na Ficha da reserva e nos tempos por condutor (Condutores e agentes, Desempenho). A cobertura vê-se sempre. Abre-se depois da calibração (diagnóstico dos tempos), quando o cartão \"De onde vêm os tempos\" mostrar ≥ 60 % numa cidade.",
    schema: gpsGateSchema,
    defaultValue: { ...DEFAULT_GPS_GATE },
    wiring: "live",
  }),
  "emails.handoverCc": def({
    key: "emails.handoverCc",
    group: "emails",
    label: "Cópia do email da passagem de turno",
    description: "Emails em CC na passagem de turno (além dos team leaders). Vazio = usa HANDOVER_EMAIL_CC.",
    schema: emailListSchema,
    defaultValue: [],
    wiring: "live",
  }),
  "multipark.agentUrl": def({
    key: "multipark.agentUrl",
    group: "operacao",
    label: "Endereço de um agente na Multipark",
    description: "Para o botão \"Abrir na Multipark\" (ficha do RH e lista de Utilizadores). Abre um agente no backoffice da Multipark, copia o endereço e troca o número do agente por {id}. Vazio: o botão não aparece (fica \"Copiar ID\").",
    schema: z.string().trim().max(300, "Máximo 300 caracteres.").refine((v) => v === "" || (/^https:\/\/\S+$/.test(v) && v.includes("{id}")), "Tem de começar por https:// e ter {id} no sítio do número do agente."),
    defaultValue: "",
    wiring: "live",
  }),
  "rh.suspendAfterDays": def({
    key: "rh.suspendAfterDays",
    group: "operacao",
    label: "Sugerir pôr inativo ao fim de (dias sem atividade)",
    description: "Na lista de Utilizadores aparece um aviso com as pessoas de ficha ativa que não trabalham (agente da Multipark, ponto, extras) nem entram na app há mais destes dias, para as pôr INATIVAS (motivo \"Inatividade\"): saem das listas, da escala e dos avisos, mas podem voltar a entrar como utilizador e dizer \"Voltei\". A ficha, a conta e o agente ficam ligados. 0 = não sugerir.",
    schema: z.number({ error: "Indica um número de dias." }).int("Número inteiro de dias.").min(0, "0 desliga.").max(3650, "Máximo 3650 dias."),
    defaultValue: 180,
    wiring: "live",
  }),
  "rh.missingCityAssignee": def({
    key: "rh.missingCityAssignee",
    group: "operacao",
    label: "Responsável pelo recrutamento e pelas fichas sem cidade",
    description: "Nome ou email da pessoa do recrutamento. Recebe a tarefa de cada candidatura de condutor (com os supervisores da cidade do lead; um lead sem cidade fica só com ela) e a tarefa (e o email) quando uma ficha ativa não tem cidade e o dashboard não a consegue descobrir pelo agente da Multipark, pela candidatura ou pela morada.",
    schema: z.string().trim().min(2, "Indica um nome ou email.").max(320),
    defaultValue: "Márcia Nunes",
    wiring: "live",
  }),
  "ops.presencePhones": def({
    key: "ops.presencePhones",
    group: "operacao",
    label: "Alertas sem PDA/Zello: WhatsApp dos administradores",
    description: "Quem recebe o WhatsApp quando um alerta \"a trabalhar sem PDA ou Zello ligado\" fica sem resposta: os administradores de cada cidade e a cópia para todas as cidades. Escolhe as pessoas do RH (o telefone vem da ficha, por isso fica sempre atualizado); para alguém que não está no RH, escreve o número em \"Outros números\".",
    schema: presencePhonesSchema,
    defaultValue: { lisbon: [], porto: [], faro: [], copy: [] },
    wiring: "live",
  }),
  "login.codeDelivery": def({
    key: "login.codeDelivery",
    group: "operacao",
    label: "Código de entrada vai para",
    description: "Com \"Entrar com email e código\" ligado: duty = o team leader de serviço e os supervisores da cidade da pessoa (sem cidade: RH e admins). email = o email da própria pessoa, enviado pela conta própria acesso@multipark.pt (tem de existir no Google Workspace com delegação; nunca uma caixa da Comunicação — se for, não envia). Se o email não sair, o código vai ao TL e ao supervisor e aparece \"pede o código ao TL\".",
    schema: z.enum(LOGIN_CODE_DELIVERY_MODES, { error: "Escolhe duty ou email." }),
    defaultValue: "duty",
    wiring: "live",
  }),
  "ops.presenceEscalateMinutes": def({
    key: "ops.presenceEscalateMinutes",
    group: "operacao",
    label: "Alertas sem PDA/Zello: minutos até ao WhatsApp",
    description: "Minutos depois do aviso no sino, sem ligação nem \"Visto\" do team leader, até se mandar o WhatsApp aos administradores.",
    schema: z.number().int().min(5, "Mínimo 5 minutos.").max(120, "Máximo 120 minutos."),
    defaultValue: 10,
    wiring: "live",
  }),
  "ops.presenceTemplate": def({
    key: "ops.presenceTemplate",
    group: "operacao",
    label: "Alertas sem PDA/Zello: modelo do WhatsApp",
    description: "Nome exato do modelo aprovado pela Meta e língua, separados por \"|\" (ex.: alerta_operacional|pt_PT). O modelo tem dois campos: {{1}} = cidade, {{2}} = o alerta numa linha.",
    schema: z.string().trim().regex(/^[a-z0-9_]{1,512}\|[a-z]{2}(_[A-Z]{2})?$/, "Formato: nome_do_modelo|pt_PT"),
    defaultValue: "alerta_operacional|pt_PT",
    wiring: "live",
  }),
  "availability.assigneeEmail": def({
    key: "availability.assigneeEmail",
    group: "disponibilidade",
    label: "Responsável pelas disponibilidades a confirmar",
    description: "Email da pessoa a quem são atribuídas as tarefas \"Disponibilidade a confirmar\". Vazio = usa AVAILABILITY_TASK_ASSIGNEE_EMAIL; sem nenhum, a tarefa fica sem responsável (na lista de Tarefas da cidade da pessoa).",
    schema: z.union([z.literal(""), emailSchema]),
    defaultValue: "",
    wiring: "live",
  }),
  "ai.monthlyBudgetEur": def({
    key: "ai.monthlyBudgetEur",
    group: "ia",
    label: "Orçamento mensal da IA (€)",
    description: "Teto de gasto estimado da IA por mês civil (UTC). Ao chegar a 100%, as funcionalidades não essenciais respondem \"IA temporariamente indisponível\" e os admins recebem um aviso (uma vez por mês); as essenciais (leitura de faturas) param aos 150%. 0 = sem limite. Vazio = usa AI_MONTHLY_BUDGET_EUR (ou 30 €).",
    schema: z.number({ error: "Indica um valor em euros." }).min(0, "Não pode ser negativo.").max(100_000, "Máximo 100 000 €."),
    defaultValue: 30,
    wiring: "live",
  }),
  "ai.featureTiers": def({
    key: "ai.featureTiers",
    group: "ia",
    label: "Nível de modelo por funcionalidade de IA",
    description: "Sobrepõe o nível (lite = o mais barato, fast, smart) de cada funcionalidade. JSON: {\"expense_ocr\": \"fast\"}. Funcionalidades: " + AI_FEATURE_IDS.join(", ") + ". Vazio = omissão do código (quase tudo lite).",
    schema: aiFeatureTiersSchema,
    defaultValue: {},
    wiring: "live",
  }),
  "ai.thinkingLevels": def({
    key: "ai.thinkingLevels",
    group: "ia",
    label: "Raciocínio da IA por funcionalidade",
    description: "Quanto o modelo \"pensa\" antes de responder (só os Gemini 3.x): minimal (quase nada, o mais barato), low, medium, high, ou default (o do próprio modelo). O raciocínio paga-se como saída. JSON: {\"mail_routing\": \"minimal\", \"assistant\": \"low\"}. Atenção: os modelos Pro/smart podem não aceitar \"minimal\" — nas funcionalidades em nível smart (ex.: assistant_smart) o \"minimal\" é ignorado e fica o da env (low). Funcionalidades fora da lista seguem AI_THINKING_LEVEL (omissão low). Vazio = como até aqui. Valor sugerido (plano MPV F6b) — só com a avaliação de cada uma a passar com o \"minimal\" (scripts/eval-mail-triage.ts --thinking minimal, eval-whatsapp-triage.ts --compare, eval-complaint-triage.ts --compare): {\"mail_routing\": \"minimal\", \"whatsapp_triage\": \"minimal\", \"complaint_triage\": \"minimal\"}.",
    schema: aiThinkingLevelsSchema,
    defaultValue: {},
    wiring: "live",
  }),
  "ai.assistantLimits": def({
    key: "ai.assistantLimits",
    group: "ia",
    label: "Limites do assistente (chat)",
    description: "Pedidos por pessoa ao assistente e tamanho máximo da pergunta. JSON: {\"perMinute\": 20, \"perDay\": 200, \"maxInputChars\": 1000}. Acima do limite, a pessoa vê \"Muitos pedidos\" e o tempo de espera.",
    schema: aiAssistantLimitsSchema,
    defaultValue: { ...AI_ASSISTANT_DEFAULT_LIMITS },
    wiring: "live",
  }),
  // Plano MPV §5.2/§5.3 (F0b): piloto do Multis no modelo smart (Argon).
  "ai.assistantPilot": def({
    key: "ai.assistantPilot",
    group: "ia",
    label: "Multis: quem está no piloto (modelo smart)",
    description: "Contas (ids) que usam o Multis do piloto no modelo smart (assistant_smart), com o interruptor «Multis por página (MPV)» e «IA: Multis do piloto (smart)» ligados. As outras pessoas ficam no Multis de sempre (lite). JSON: {\"userIds\": [1, 12]}. Vazio = ninguém.",
    schema: aiAssistantPilotSchema,
    defaultValue: { userIds: [] },
    wiring: "live",
  }),
  "ai.assistantSmartLimits": def({
    key: "ai.assistantSmartLimits",
    group: "ia",
    label: "Multis do piloto: limites de perguntas",
    description: "Pedidos por pessoa ao Multis do piloto (assistant_smart) e tamanho máximo da pergunta. JSON: {\"perMinute\": 10, \"perDay\": 80, \"maxInputChars\": 1000}. No modo económico valem os limites do assistente de sempre.",
    schema: aiAssistantLimitsSchema,
    defaultValue: { ...AI_ASSISTANT_SMART_DEFAULT_LIMITS },
    wiring: "live",
  }),
  "ai.assistantSmartBudget": def({
    key: "ai.assistantSmartBudget",
    group: "ia",
    label: "Multis do piloto: teto de gasto (€)",
    description: "Teto próprio do Multis do piloto (assistant_smart), em € estimados: por dia (dia de Lisboa), por mês civil (UTC) e por pessoa por dia (Lisboa). Ao chegar a um deles, a pessoa continua a ter o Multis no modelo de sempre (lite), com a nota \"modo económico\" — não bloqueia nada. Este gasto não conta para o orçamento mensal da IA que pára as outras funcionalidades (o cartão do custo mostra-o na mesma). Os três têm de ser maiores que 0. Se não for possível medir o gasto, também responde o modelo de sempre. JSON: {\"eurPerDay\": 10, \"eurPerMonth\": 150, \"eurPerUserPerDay\": 3}.",
    schema: aiAssistantSmartBudgetSchema,
    defaultValue: { ...AI_ASSISTANT_SMART_DEFAULT_BUDGET },
    wiring: "live",
  }),
  "ai.commsRouting": def({
    key: "ai.commsRouting",
    group: "ia",
    label: "IA a separar emails e WhatsApp: limiar e teto",
    description: "minConfidence: abaixo desta certeza (0 a 1) a IA \"não percebeu\" e a conversa vai para o info (no WhatsApp, a Geral). perRun: máximo de emails lidos pela IA em cada sincronização (o resto fica para o varrimento de 15 em 15 min). JSON: {\"minConfidence\": 0.7, \"perRun\": 10}.",
    schema: commsRoutingSettingsSchema,
    defaultValue: { ...COMMS_ROUTING_DEFAULTS },
    wiring: "live",
  }),
  // Lote 57 (Jorge, 12 out 2026): a IA vê uma reclamação num email de outra caixa → Reclamações.
  // 14 out 2026: também os perdidos; a certeza média cria "Por confirmar (IA)" (já não fica só sugerida).
  "ai.mailComplaints": def({
    key: "ai.mailComplaints",
    group: "ia",
    label: "IA: reclamações e perdidos vistos nas caixas — certezas",
    description: "Quando a IA vê uma reclamação (ou um objeto perdido) num email de uma caixa partilhada (info@, reservas@…): com certeza ≥ createMinConfidence o caso é criado (ou o email junta-se ao aberto do mesmo cliente); entre suggestMinConfidence e isso é criado na mesma, marcado \"Por confirmar (IA)\" (confirma-se ou arquiva-se — nada se apaga); abaixo, nada. JSON: {\"createMinConfidence\": 0.85, \"suggestMinConfidence\": 0.5}.",
    schema: complaintIntakeSettingsSchema,
    defaultValue: { ...COMPLAINT_INTAKE_DEFAULTS },
    wiring: "live",
  }),
  // 14 out 2026 (Jorge: "tudo o que está na caixa de correio e é uma reclamação tem de ir para lá").
  "ai.mailBackfill": def({
    key: "ai.mailBackfill",
    group: "ia",
    label: "IA: rever os emails que já estão nas caixas — dias e lote",
    description: "days: quantos dias para trás se revêem os emails das caixas partilhadas ainda sem caso (1 a 90); perRun: emails lidos pela IA em cada corrida de 15 em 15 min (1 a 20). Só com o interruptor «IA: rever os emails que já estão nas caixas» ligado. JSON: {\"days\": 30, \"perRun\": 6}.",
    schema: mailBackfillSettingsSchema,
    defaultValue: { ...MAIL_BACKFILL_DEFAULTS },
    wiring: "live",
  }),
  "ai.priceOverridesEur": def({
    key: "ai.priceOverridesEur",
    group: "ia",
    label: "Preços dos modelos de IA (€ por 1M tokens)",
    description: "Sobrepõe a tabela de preços do código (server/_core/ai/pricing.ts) para calcular o custo registado. JSON: {\"<modelo>\": {\"input\": 0.22, \"output\": 1.3, \"cached\": 0.02}}. Vazio = tabela do código.",
    schema: aiPriceOverridesSchema,
    defaultValue: {},
    wiring: "live",
  }),
  "extras.crewRules": def({
    key: "extras.crewRules",
    group: "extras",
    label: "Tempo por carro conforme as pessoas no turno",
    description: "Minutos que cada condutor leva por carro, conforme as pessoas no turno com o TL incluído (2 = TL + 1 extra; quem conduz são os extras, o TL vai buscá-los), por cidade, e o mínimo de pessoas quando há trabalho. Define quantos extras a previsão do Extras-dia pede em cada hora e a proposta automática de escala. JSON: {\"lisbon\": {\"minCrew\": 2, \"bands\": [{\"upTo\": 2, \"minutes\": 75}, {\"upTo\": 4, \"minutes\": 60}, {\"upTo\": 6, \"minutes\": 45}, {\"upTo\": null, \"minutes\": 30}]}, \"porto\": {…}, \"faro\": {…}}.",
    schema: crewRulesSchema,
    defaultValue: DEFAULT_CREW_RULES,
    wiring: "live",
  }),
  "extras.timesSince": def({
    key: "extras.timesSince",
    group: "extras",
    label: "Tempos medidos desde",
    description: "Dia a partir do qual a Pressão do Extras-dia mede os tempos (carros por hora, entregas, recolhas, condutor por carro). A janela vai deste dia até ontem e cresce todos os dias: nunca deita fora o que já mediu, para haver o ano inteiro.",
    schema: timesSinceSchema,
    defaultValue: PRESSURE_SINCE_DEFAULT,
    wiring: "live",
  }),
  "extras.timesPercentile": def({
    key: "extras.timesPercentile",
    group: "extras",
    label: "Percentil do tempo por carro, por cidade",
    description: "Que valor do tempo por carro medido se usa em cada cidade: 75 = em 3 de cada 4 vezes foi mais rápido do que isto (mais prudente); 60 = um pouco acima do meio. Valores: 50, 60, 75, 85 ou 90. JSON: {\"lisbon\": 75, \"porto\": 60, \"faro\": 60}.",
    schema: timesPercentileSchema,
    defaultValue: DEFAULT_TIMES_PERCENTILE,
    wiring: "live",
  }),
  "extras.useMeasuredTimes": def({
    key: "extras.useMeasuredTimes",
    group: "extras",
    label: "Escala com os tempos medidos (por cidade)",
    description: "Ligado: o Extras-dia calcula quantos extras são precisos com o tempo por carro que a equipa REALMENTE fez nas horas cheias (medido), em vez da tabela de máximos. Se a equipa foi mais rápida do que a tabela, pede menos extras; se foi mais lenta, fica a tabela (nunca pede mais do que a tabela pediria). Num escalão com menos de 30 serviços medidos continua a usar a tabela. Desligado: só a tabela, como até aqui. Liga cidade a cidade.",
    schema: useMeasuredTimesSchema,
    defaultValue: DEFAULT_USE_MEASURED_TIMES,
    wiring: "live",
  }),
  "extras.pairPickups": def({
    key: "extras.pairPickups",
    group: "extras",
    label: "Recolha pelo meio de uma entrega (por cidade)",
    description: "Ligado: quem leva um carro ao aeroporto e volta ao parque com o carro de uma recolha não conta essa recolha como um carro a mais. Vale para a recolha no mesmo terminal, entre 10 min antes e 30 min depois da entrega (uma por entrega; no T2 conta só a meia extra; moradas e hotéis nunca contam). Resultado: a previsão e a escala pedem menos extras nas horas com entregas e recolhas juntas. Desligado: cada recolha conta como um carro, como até aqui. Liga cidade a cidade.",
    schema: pairPickupsSchema,
    defaultValue: DEFAULT_PAIR_PICKUPS,
    wiring: "live",
  }),
  "extras.tightUsesQueue": def({
    key: "extras.tightUsesQueue",
    group: "extras",
    label: "Hora apertada pela Fila (por cidade)",
    description: "Ligado: na Pressão e na escala do Extras-dia, a parte \"entregas lentas\" da hora apertada usa a Fila (da chamada do cliente, ou do pendente, até o condutor pegar no carro — o tempo que mostra se falta gente), em vez do tempo total do pedido à assinatura (que também tem o caminho e a espera pelo cliente). Só quando a Fila está medida em pelo menos 60 % das entregas da cidade; abaixo disso fica o total e o ecrã diz porquê. Desligado: as horas apertadas ficam exatamente como até aqui. Liga cidade a cidade.",
    schema: tightUsesQueueSchema,
    defaultValue: DEFAULT_TIGHT_USES_QUEUE,
    wiring: "live",
  }),
  "extras.autoProposeAt": def({
    key: "extras.autoProposeAt",
    group: "extras",
    label: "Hora da proposta automática de escala",
    description: "A partir desta hora (Lisboa) o sistema propõe a escala dos próximos dias com os extras disponíveis (só a primeira proposta de cada dia e cidade: não substitui uma escala já proposta ou confirmada, e num dia mexido à mão já não mexe). O agendador vê de 15 em 15 min, por isso a proposta sai até 15 min depois desta hora. Com o interruptor dos lembretes ligado, o lembrete sai 30 min antes.",
    schema: hhmmSchema,
    // Plano MPV F7 (D4, Jorge 15 out 2026): proposta às 11:00 (antes 14:00).
    defaultValue: "11:00",
    wiring: "live",
  }),
  "extras.autoProposeDaysAhead": def({
    key: "extras.autoProposeDaysAhead",
    group: "extras",
    label: "Dias propostos com antecedência",
    description: "Quantos dias à frente a proposta automática cobre (1 = só amanhã).",
    schema: z.number({ error: "Indica um número de dias." }).int("Número inteiro de dias.").min(1, "Mínimo 1 dia.").max(7, "Máximo 7 dias."),
    defaultValue: 1,
    wiring: "live",
  }),
  "extras.autoConfirm": def({
    key: "extras.autoConfirm",
    group: "extras",
    label: "Confirmar e avisar automaticamente",
    description: "Se ligado, a proposta de amanhã que ninguém confirmou nem suspendeu é confirmada à hora indicada abaixo e os extras são avisados por WhatsApp e email.",
    schema: z.boolean({ error: "Ligado ou desligado." }),
    defaultValue: true,
    wiring: "live",
  }),
  "extras.autoConfirmAt": def({
    key: "extras.autoConfirmAt",
    group: "extras",
    label: "Hora da confirmação automática",
    description: "Hora (Lisboa) a partir da qual a proposta de amanhã é confirmada e enviada automaticamente (se não estiver suspensa). O agendador vê de 15 em 15 min. Um dia mexido à mão segue a regra \"Dia mexido à mão na hora da confirmação\".",
    schema: hhmmSchema,
    // Plano MPV F7 (D4, Jorge 15 out 2026): confirmar e chamar às 15:00 (antes 18:00).
    defaultValue: "15:00",
    wiring: "live",
  }),
  // Plano MPV F7 (D4b, por decidir pelo Jorge): as três opções; omissão = a mais segura.
  "extras.manualEditAtConfirm": def({
    key: "extras.manualEditAtConfirm",
    group: "extras",
    label: "Dia mexido à mão na hora da confirmação",
    description: "O que a confirmação automática faz a um dia em que alguém mexeu à mão (pôs, tirou, mudou horas, refez a proposta…): confirmar na mesma, como está (o que se fazia até aqui); não confirmar e avisar o TL, o supervisor e o back office da cidade (sino e email, com o interruptor \"Extras-dia: avisos da escala\"; repete às 18:00 se continuar por confirmar) para confirmarem eles; ou só confirmar quando a última mudança à mão tiver mais de 30 min (até lá volta a ver de 15 em 15 min; uma mudança depois das ~23:15 avisa, porque já não dá para confirmar sozinho). Omissão: confirma na mesma (o que se faz hoje), até o Jorge decidir.",
    schema: z.enum(MANUAL_EDIT_AT_CONFIRM_MODES as [ManualEditAtConfirm, ...ManualEditAtConfirm[]], { error: "Escolhe uma das três opções." }),
    defaultValue: MANUAL_EDIT_AT_CONFIRM_DEFAULT,
    wiring: "live",
  }),
  // Plano MPV F7 (D4c, por decidir pelo Jorge): a quem vão os lembretes, por cidade e em que dias.
  "extras.reminderRecipients": def({
    key: "extras.reminderRecipients",
    group: "extras",
    label: "Lembretes da escala: a quem e em que dias (por cidade)",
    description: "Os lembretes 30 min antes da proposta e da confirmação automáticas (interruptor \"Extras-dia: lembretes antes da proposta e da confirmação\", em Definições → Automações) vão, em cada cidade, às pessoas com estes papéis nessa cidade e às contas juntadas, só nos dias da semana escolhidos (o dia em que o lembrete sai). Sino da app; o email segue o Perfil de cada pessoa. Omissão: team leader e supervisor da cidade, todos os dias.",
    schema: reminderRecipientsSchema,
    defaultValue: DEFAULT_REMINDER_RECIPIENTS,
    wiring: "live",
  }),
  "extras.meetingPoints": def({
    key: "extras.meetingPoints",
    group: "extras",
    label: "Ponto de encontro (aviso de escala)",
    description: "Texto curto com o ponto de encontro de cada cidade, incluído no WhatsApp e no email de escala. Vazio = não se indica.",
    schema: meetingPointMapSchema,
    defaultValue: { lisbon: "", porto: "", faro: "" },
    wiring: "live",
  }),
  [TERMINAL_AIRPORTS_SETTING_KEY]: def({
    key: TERMINAL_AIRPORTS_SETTING_KEY,
    group: "extras",
    label: "Aeroportos (terminal no ponto)",
    description: "Centro e raio do aeroporto de cada cidade e, se quiseres, zonas por terminal (T1/T2: centro e raio; com zonas só elas contam). Com o interruptor \"Terminal no ponto (aeroporto)\" ligado (Definições → Automações), o \"Estou no terminal\" só abre com o GPS dentro (distância − imprecisão ≤ raio), no aeroporto de uma cidade onde a pessoa trabalha, e o vigia de 5 em 5 min usa as mesmas zonas para o \"Ainda estás no terminal?\" (fora = distância − imprecisão > raio). Se um parque cair dentro de uma zona, aparece um aviso aqui.",
    schema: terminalAirportsSchema,
    defaultValue: DEFAULT_TERMINAL_AIRPORTS,
    wiring: "live",
  }),
  "rh.docsRequestTemplates": def({
    key: "rh.docsRequestTemplates",
    group: "extras",
    label: "Pedido de documentos em falta: template do WhatsApp",
    description: "Nome exato do template aprovado pela Meta e língua, separados por \"|\" (ex.: documentos_em_falta|pt_PT), para cada cidade. O template tem dois campos: {{1}} = primeiro nome, {{2}} = os documentos em falta numa linha (ex.: \"Fotografia, Carta de Condução (recusado: ilegível)\"); o resto do texto (onde carregar, responder com fotografia) fica fixo no template. Vazio = essa cidade só recebe o pedido por email.",
    schema: docsRequestTemplatesSchema,
    defaultValue: { lisbon: "", porto: "", faro: "" },
    wiring: "live",
  }),
  "ai.trainingTutorLimits": def({
    key: "ai.trainingTutorLimits",
    group: "ia",
    label: "Tutor da formação: limite de perguntas",
    description: "Perguntas ao tutor da formação por pessoa, por minuto e por dia. JSON: {\"perMinute\": 10, \"perDay\": 100}. Vazio = usa AI_TRAINING_TUTOR_PER_MINUTE / AI_TRAINING_TUTOR_PER_DAY (ou 10 e 100).",
    schema: trainingTutorLimitsSchema,
    defaultValue: { perMinute: 10, perDay: 100 },
    wiring: "live",
  }),
  "sla.mailHours": def({
    key: "sla.mailHours",
    group: "sla",
    label: "Prazo de resposta aos emails (horas)",
    description: "Comunicação: uma conversa de uma caixa partilhada por responder há mais do que isto fica \"fora do prazo\" (lista e filtro \"Por responder\").",
    schema: z.number({ error: "Indica um número de horas." }).int("Número inteiro de horas.").min(1, "Mínimo 1 hora.").max(720, "Máximo 720 horas."),
    defaultValue: MAIL_DEFAULT_SLA_HOURS,
    wiring: "live",
  }),
  "mail.retentionYears": def({
    key: "mail.retentionYears",
    group: "emails",
    label: "Retenção dos emails (anos)",
    description: "Comunicação: os emails guardados há mais do que isto e SEM ligação a um cliente, reserva, reclamação, perdido ou ocorrência são apagados da base de dados (limpeza diária). Os ligados ficam.",
    schema: z.number({ error: "Indica um número de anos." }).int("Número inteiro de anos.").min(1, "Mínimo 1 ano.").max(20, "Máximo 20 anos."),
    defaultValue: MAIL_DEFAULT_RETENTION_YEARS,
    wiring: "live",
  }),
  "mail.backfillDays": def({
    key: "mail.backfillDays",
    group: "emails",
    label: "Emails a importar ao ligar uma caixa (dias)",
    description: "Comunicação: quando uma caixa (ou a conta Google de alguém) é ligada, importam-se os emails destes últimos dias; depois a sincronização é incremental.",
    schema: z.number({ error: "Indica um número de dias." }).int("Número inteiro de dias.").min(1, "Mínimo 1 dia.").max(730, "Máximo 730 dias."),
    defaultValue: MAIL_DEFAULT_BACKFILL_DAYS,
    wiring: "live",
  }),
  "mail.systemSender": def({
    key: "mail.systemSender",
    group: "emails",
    label: "Remetente dos emails de sistema (Gmail)",
    description: "Conta do Google Workspace pela qual a aplicação envia os emails de sistema (notificações, briefing, escala, tarefas, formação, relatórios) pela API do Gmail — tem de estar autorizada na delegação da conta de serviço (gmail.send). Os emails a clientes saem pelo alias da caixa (reclamacoes@, perdidos@…) quando está em \"Enviar email como\" na conta de origem. Editável em Definições → Comunicação.",
    schema: emailSchema,
    defaultValue: DEFAULT_MAILBOX_SOURCE,
    wiring: "live",
  }),
  "mail.brandDomains": def({
    key: "mail.brandDomains",
    group: "emails",
    label: "Domínios de email por marca",
    description: "Comunicação: domínio(s) de cada marca, para detetar a marca de um email pelo endereço de quem o recebeu (quando o endereço não está numa caixa). JSON: {\"multipark\": [\"multipark.pt\"], \"skypark\": [\"skypark.pt\"]}. Marcas: " + MAIL_BRAND_IDS.join(", ") + ".",
    schema: z.partialRecord(z.enum(MAIL_BRAND_IDS, { error: "Marca desconhecida." }), z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Domínio inválido.")).max(10)),
    defaultValue: DEFAULT_BRAND_DOMAINS,
    wiring: "live",
  }),
  "mail.aliasDomains": def({
    key: "mail.aliasDomains",
    group: "emails",
    label: "Domínios alternativos do Google Workspace",
    description: "Comunicação: domínios alternativos (\"alias domains\") do Workspace " + MAIL_WORKSPACE_PRIMARY_DOMAIN + ". Nestes domínios TODOS os endereços do domínio principal funcionam automaticamente — um email para reclamacoes@skypark.pt é encaminhado como o alias reclamacoes@" + MAIL_WORKSPACE_PRIMARY_DOMAIN + " (a marca vem do domínio para onde foi enviado). Um endereço escrito na tabela de aliases ganha sempre. Lista vazia = desligado.",
    schema: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Domínio inválido.")).max(30),
    defaultValue: [...DEFAULT_MAIL_ALIAS_DOMAINS],
    wiring: "live",
  }),
  "google.sharedCalendars": def({
    key: "google.sharedCalendars",
    group: "emails",
    label: "Calendários partilhados da escala (Google)",
    description: "Calendários \"Escala Multipark — <cidade>\" escritos pela conta de serviço (delegação) em nome da conta dona, para quem não ligou a conta Google poder subscrever. Editável em Definições → Comunicação (só super admin).",
    schema: sharedCalendarsConfigSchema,
    defaultValue: DEFAULT_SHARED_CALENDARS_CONFIG,
    wiring: "live",
  }),
  "google.contacts": def({
    key: "google.contacts",
    group: "emails",
    label: "Contactos Google (diretório e grupos no telemóvel)",
    description: "Diretório da empresa (conta de serviço com delegação, a impersonar a conta indicada), grupo \"Multipark — Serviço\" com os clientes das recolhas/entregas de hoje e amanhã (papéis e dias de retenção) e grupo opcional de parceiros. Editável em Definições → Comunicação (só super admin).",
    schema: contactsConfigSchema,
    defaultValue: DEFAULT_CONTACTS_CONFIG,
    wiring: "live",
  }),
  "google.drive": def({
    key: "google.drive",
    group: "emails",
    label: "Google Drive (Shared Drive, espelho e relatórios ao vivo)",
    description: "Shared Drive \"Multipark\" da empresa (conta de serviço com delegação, a impersonar a conta indicada): pastas Clientes/Reclamações/RH criadas a pedido, espelho opcional dos documentos do RH e das provas das reclamações e relatórios ao vivo numa folha atualizada 1×/dia. Editável em Definições → Comunicação (só super admin).",
    schema: driveConfigSchema,
    defaultValue: DEFAULT_DRIVE_CONFIG,
    wiring: "live",
  }),
  [WEB_ANALYTICS_SETTING_KEY]: def({
    key: WEB_ANALYTICS_SETTING_KEY,
    group: "marketing",
    label: "Web & SEO (Google Analytics 4, Search Console, PageSpeed)",
    description: "Propriedades GA4 e da Search Console (por marca) lidas pela conta de serviço, páginas medidas na PageSpeed, hora da recolha diária, eventos do funil e limiares dos alertas. Editável em Definições → Integrações (só super admin).",
    schema: webAnalyticsConfigSchema,
    defaultValue: DEFAULT_WEB_ANALYTICS_CONFIG,
    wiring: "live",
  }),
  [GBP_SETTING_KEY]: def({
    key: GBP_SETTING_KEY,
    group: "marketing",
    label: "Google Business Profile (desempenho, pesquisas e alertas)",
    description: "Recolha diária do desempenho dos perfis Google (impressões, chamadas, direções, cliques no site) e das pesquisas mensais, cidade/marca de cada perfil e limiares dos alertas. Editável em Marketing → Web & SEO → Google Business (só super admin).",
    schema: gbpConfigSchema,
    defaultValue: DEFAULT_GBP_CONFIG,
    wiring: "live",
  }),
  [KNOWLEDGE_SETTING_KEY]: def({
    key: KNOWLEDGE_SETTING_KEY,
    group: "ia",
    label: "Base de conhecimento (pastas do Drive, índice e uso pela IA)",
    description: "Pastas do Shared Drive sincronizadas para a base de conhecimento (e quem vê cada uma), índice por embeddings e se o assistente/tutor a usam. Editável em Formação → Base de conhecimento (admin).",
    schema: knowledgeConfigSchema,
    defaultValue: DEFAULT_KNOWLEDGE_CONFIG,
    wiring: "live",
  }),
  [SERVICE_TASKS_SETTING_KEY]: def({
    key: SERVICE_TASKS_SETTING_KEY,
    group: "servicos",
    label: "Serviços → tarefas",
    description: "Por cidade e por tipo de serviço extra (lavagem, carregamento elétrico…): se cada reserva com esse serviço gera uma tarefa (prazo: a saída do carro) e, opcionalmente, o responsável. Os team leaders do turno da saída e do turno anterior são sempre acrescentados. Editável em Definições → Parâmetros → Serviços → tarefas.",
    schema: serviceTaskRulesSchema,
    defaultValue: DEFAULT_SERVICE_TASK_RULES,
    wiring: "live",
  }),
  // Jorge (8 out 2026): "avança com os pesos do ranking" — mudar os pesos sem deploy.
  [PERF_RANK_WEIGHTS_KEY]: def({
    key: PERF_RANK_WEIGHTS_KEY,
    group: "pessoas",
    label: "Pesos do ranking do Desempenho",
    description: "Quanto vale cada coisa nos pontos do ranking de Pessoas → Condutores e agentes → Desempenho, por aba (office, supervision, teamleaders, drivers) e os pontos da equipa (team). Só o que muda face às omissões do código (1 ponto ≈ 5 minutos de trabalho). Um peso 0 = não conta; sem a métrica = a omissão. Pesos entre −10 000 e 10 000, com 1 casa decimal no máximo; horas e km nunca dão pontos. JSON: {\"office\": {\"created\": 3}, \"team\": {\"noZelloPerPerson\": -10}}. Mais fácil no próprio Desempenho: \"Como se contam os pontos desta aba\" → Editar pesos. Vazio = omissões do código. Só o super admin muda.",
    // 14 out 2026: ao ler, um peso proibido gravado antes é ignorado (o resto vale); ao gravar, é recusado
    schema: rankWeightsReadSchema,
    writeSchema: rankWeightsSchema,
    defaultValue: {},
    wiring: "live",
  }),
  // Tarefa 62 (P2d): fecho mensal da Avaliação — fecha-se cada mês antes de pagar os prémios (o 1.º: novembro).
  [EVALUATION_CLOSED_UNTIL_KEY]: def({
    key: EVALUATION_CLOSED_UNTIL_KEY,
    group: "pessoas",
    label: "Avaliação fechada até (fecho mensal)",
    description: "Último dia FECHADO da Avaliação (AAAA-MM-DD). Os dias até essa data já não mudam: o recálculo da noite, o Recalcular, os ajustes, a anulação de ajustes, as contestações (criar e aceitar com ajuste) e a re-divisão do GPS dos últimos 31 dias não lhes tocam. Fecha-se cada mês antes de pagar os prémios (o primeiro é novembro, no início de dezembro). Reabrir = mudar a data (fica no histórico). Vazio = nada fechado. Também se fecha em Avaliação → Mês (\"Fecho do mês\"), por quem está na lista \"Avaliação: quem fecha o mês\". Atenção: o fecho congela os números, não as regras — depois do primeiro fecho, uma mudança nos pontos tem de dizer a partir de que dia vale.",
    schema: closedUntilSchema,
    // ao gravar (também em Definições): nunca hoje nem o futuro — fechar o dia de hoje congelava o recálculo
    writeSchema: closedUntilSchema.refine((v) => v == null || v < operationalDayOf(Date.now()), "Só se fecha até ontem (o dia de hoje ainda está a acontecer)."),
    defaultValue: null,
    wiring: "live",
  }),
  [EVALUATION_CLOSERS_KEY]: def({
    key: EVALUATION_CLOSERS_KEY,
    group: "pessoas",
    label: "Avaliação: quem fecha o mês",
    description: "Contas que podem fechar e reabrir a Avaliação (Avaliação → Mês → \"Fecho do mês\"), além do super admin. Escolhe as pessoas na lista. Só o super admin muda.",
    schema: userIdListSchema,
    defaultValue: [],
    wiring: "live",
  }),
  [NOTIFICATION_ROUTING_SETTING_KEY]: def({
    key: NOTIFICATION_ROUTING_SETTING_KEY,
    group: "notificacoes",
    label: "Regras das notificações",
    description: "Quem recebe cada tipo de notificação (papéis), email por omissão e papéis nacionais limitados à própria cidade (ligado por omissão para frontoffice, backoffice e admin; super admin recebe sempre tudo). Vazio = regras do código (shared/notificationRouting.ts). Editável só pelo super admin em Definições → Notificações.",
    schema: notificationRoutingSchema,
    defaultValue: { kinds: {}, homeCityOnly: [...DEFAULT_HOME_CITY_ONLY] },
    wiring: "live",
  }),
} as const;

/**
 * Definições que só o super admin muda (os admins veem-nas). Inclui o
 * remetente dos emails de sistema (decisão do Jorge, 2 out 2026).
 */
export const SUPER_ADMIN_SETTING_KEYS: ReadonlySet<string> = new Set([
  "notifications.routing",
  "google.sharedCalendars",
  "marketing.webAnalytics",
  "marketing.googleBusiness",
  "google.contacts",
  "google.drive",
  "mail.systemSender",
  // o Desempenho só o super admin o vê (Jorge, 8 out 2026)
  PERF_RANK_WEIGHTS_KEY,
  // Plano 62: zonas, garagens e parâmetros dos tempos (quem preenche é o super admin, Q6)
  PARK_ZONES_SETTING_KEY,
  GARAGE_ROLES_SETTING_KEY,
  ...SERVICE_TIMES_SETTING_KEYS,
  // tarefa 62 (Q10): em Definições, o fecho e a lista de quem fecha só o super admin muda
  // (quem está na lista fecha em Avaliação → Mês, pelo procedimento próprio)
  EVALUATION_CLOSED_UNTIL_KEY,
  EVALUATION_CLOSERS_KEY,
]);
export function settingSuperAdminOnly(key: string): boolean {
  return SUPER_ADMIN_SETTING_KEYS.has(key);
}

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]["schema"]>;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Valida (e normaliza) o valor de uma definição. PURA. */
export function validateSetting<K extends SettingKey>(key: K, value: unknown): ValidationResult<SettingValue<K>>;
export function validateSetting(key: string, value: unknown): ValidationResult<unknown>;
export function validateSetting(key: string, value: unknown): ValidationResult<unknown> {
  if (isFlagSettingKey(key)) {
    return typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "O interruptor só aceita ligado/desligado." };
  }
  if (!isSettingKey(key)) return { ok: false, error: `Definição desconhecida: ${key}` };
  const r = SETTINGS[key].schema.safeParse(value);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues.map((i) => i.message).join(" ") || "Valor inválido." };
}

/** Validação para GRAVAR: a `writeSchema` (se houver) primeiro, e depois a normal. */
export function validateSettingForWrite(key: string, value: unknown): ValidationResult<unknown> {
  if (isSettingKey(key)) {
    const w = (SETTINGS[key] as SettingDef).writeSchema;
    if (w) {
      const r = w.safeParse(value);
      if (!r.success) return { ok: false, error: r.error.issues.map((i) => i.message).join(" ") || "Valor inválido." };
    }
  }
  return validateSetting(key, value);
}

// ─── Interruptores das automações ───────────────────────────────────────────

export interface AutomationFlag {
  name: string;
  label: string;
  description: string;
  /** Valor sem env nem sobreposição (omissão: ligado). */
  defaultEnabled?: boolean;
  /** Secção na página (omissão: automações gerais). */
  group?: "ia";
  /** Só o super_admin o pode mudar (os admins veem-no, mas não mexem). */
  superAdminOnly?: boolean;
  /** Valores próprios da env além de on/off (ex.: X=db → ligado). */
  envAliases?: Record<string, boolean>;
  /**
   * Sem valor próprio (nem variável nem "definido aqui"), segue o estado deste
   * outro interruptor — para separar um interruptor sem mudar o que já estava.
   */
  followsFlag?: string;
}

export const AUTOMATION_FLAGS: readonly AutomationFlag[] = [
  { name: "EXTRAS_AUTOMATION", label: "Automação dos extras", description: "Pedido de disponibilidade à quinta, lembrete ao sábado, aviso de escala e alerta de cobertura (cron horário)." },
  // D30 (Jorge, 3 out 2026): interruptor próprio. Sem valor próprio segue a
  // "Automação dos extras" (como era até aqui) — nada muda até alguém o mudar.
  { name: "EXTRAS_AVAILABILITY_AUTO_REPLY", label: "Extras: resposta automática no WhatsApp", description: "Quando um extra responde pelo WhatsApp ao pedido de disponibilidade (ou carrega Sim/Não no aviso de turno), marca os dias e responde-lhe sozinho. Desligado: a resposta fica na caixa do WhatsApp para uma pessoa tratar. Sem valor próprio, segue a \"Automação dos extras\".", followsFlag: "EXTRAS_AUTOMATION" },
  // Plano MPV F7 (D4/D4c): avisa gente → desligado até o Jorge decidir a quem vão (D4c).
  { name: "EXTRAS_REMINDERS", label: "Extras-dia: lembretes antes da proposta e da confirmação", description: "30 min antes da proposta automática (10:30, por omissão) e da confirmação automática (14:30) avisa no sino quem está em Definições → Parâmetros → \"Lembretes da escala: a quem e em que dias\" (omissão: TL e supervisor da cidade, todos os dias) com o estado da escala de amanhã. Só com a \"Automação dos extras\" ligada. Desligado por omissão.", defaultEnabled: false },
  // Plano MPV F7 (§6.1, auditoria): avisos novos a pessoas → desligados até o Jorge ver (regra da casa).
  { name: "EXTRAS_SCHEDULE_ALERTS", label: "Extras-dia: avisos da escala (por confirmar, por avisar, cobertura)", description: "Sino e email ao TL, ao supervisor e ao back office da cidade (e aos admins, se ninguém da cidade os receber) quando: um dia mexido à mão não foi confirmado sozinho; um extra ficou por avisar (nenhum canal chegou depois das tentativas todas); a escala confirmada cobre menos de 80 % das horas; ou a confirmação automática falhou. Desligado: nada disto avisa ninguém (a escala corre na mesma). Desligado por omissão.", defaultEnabled: false },
  // Plano MPV F7 (§6.1): mexe na escala sozinho → desligado até o Jorge ver.
  { name: "EXTRAS_COMPLETE_BEFORE_CONFIRM", label: "Extras-dia: completar com quem respondeu antes da confirmação", description: "30 min antes da confirmação automática (14:30, por omissão), num dia com a proposta automática ainda intocada, acrescenta às horas em falta os extras que marcaram disponibilidade depois da proposta (só acrescenta, nunca tira ninguém; num dia mexido à mão não faz nada). As linhas novas ficam \"proposta automática\" e o lembrete da confirmação diz quem entrou. Desligado por omissão.", defaultEnabled: false },
  // D31 (Jorge, 3 out 2026): era só a variável WHATSAPP_SLA_NOTIFY=off; a variável continua a valer.
  { name: "WHATSAPP_SLA_NOTIFY", label: "WhatsApp: aviso de conversas por responder", description: "De hora a hora, avisa no sino as conversas do WhatsApp fora do prazo de resposta, as urgentes e as que têm a janela de 24 h a fechar (por cidade e ao responsável). Desligado: a caixa continua a mostrar os atrasos, só não avisa." },
  { name: "LEAD_REMINDERS", label: "Lembretes das leads de extras", description: "Lembretes automáticos às leads que ainda não responderam." },
  // 17e (Jorge, 2 out 2026): escreve a gente de fora → desligado por omissão, como as outras.
  { name: "LEAD_AUTO_REPLY", label: "Resposta automática às leads", description: "Envia o link da candidatura às leads novas (por WhatsApp). Desligado por omissão.", defaultEnabled: false },
  // 17g-3 (Jorge, 2 out 2026): escreve a gente de fora → desligado por omissão.
  { name: "EXTRAS_ASK_CITY", label: "Pedir a cidade aos extras sem cidade", description: "Quando um extra chega sem cidade, pede-lha uma vez por email (pela recursos-humanos@) e por WhatsApp se a conversa estiver aberta. A tarefa para quem trata das fichas sem cidade cria-se sempre. Desligado por omissão.", defaultEnabled: false },
  // Pauta do Rafael (7 out 2026): escreve aos extras → desligado por omissão. O botão
  // "Pedir documentos em falta" (ficha e lista do RH) funciona sem isto.
  { name: "EXTRAS_DOCS_REQUEST", label: "Pedir documentos em falta aos extras", description: "À segunda a partir das 10:00 (Lisboa): pede por WhatsApp (template da cidade em Definições → Parâmetros, Extras-dia) e por email aos extras ativos os documentos obrigatórios em falta ou recusados. No máximo 1 pedido por pessoa a cada 7 dias (contam também os feitos à mão) e 4 pedidos automáticos por pessoa — depois só à mão. Respeita \"Não enviar WhatsApp/email\" e o STOP. Desligado por omissão.", defaultEnabled: false },
  // 19a: o email semanal de marketing tinha só a variável MARKETING_WEEKLY=off (invisível nas Definições).
  { name: "MARKETING_WEEKLY", label: "Email semanal de marketing", description: "À segunda a partir das 8h: gasto, reservas e ROAS da semana por marca e cidade, para os endereços em MARKETING_REPORT_EMAILS." },
  // D20 (Jorge, 3 out 2026): avisa gente → desligado por omissão.
  { name: "COMPLAINT_CLIENT_REPLY_NOTIFY", label: "Reclamações: avisar o responsável quando o cliente responde", description: "Quando o cliente volta a escrever (email) numa reclamação, o responsável recebe no sino \"O cliente respondeu à reclamação #X\" — no máximo 1 aviso por reclamação a cada 30 min, só emails do próprio cliente com menos de 48 h. Sem responsável não avisa ninguém (o caso volta na mesma a \"Em análise\"). Desligado por omissão.", defaultEnabled: false },
  // 49c (Jorge, 8 out 2026): escreve a gente de fora (código por email) → desligado por omissão.
  { name: "ACCOUNT_LINK_EMAIL_CODE", label: "Liga a tua conta: código por email", description: "Quem entra com uma conta Google sem ficha e escreve o email ou o telefone com que se candidatou (ou trabalhou connosco) recebe um código de 6 algarismos no email que está nessa ficha/candidatura (pela recursos-humanos@; vale 10 minutos, 5 tentativas) e, ao escrevê-lo, a conta liga-se sozinha. Só quando dá UMA pessoa, extra ou condutor, e não desativada; o resto vai para o RH. Desligado: todos os pedidos vão para o RH (Leads de Extras → Candidaturas e ficha → Utilizador e permissões), com aviso no sino. Desligado por omissão.", defaultEnabled: false },
  // 19c: avisa gente → desligado por omissão. Sem ele, os pedidos aparecem na lista do RH e na ficha.
  { name: "RH_BANK_CHANGE_NOTIFY", label: "Aviso dos pedidos de IBAN", description: "Quando alguém pede para mudar o IBAN de uma ficha, avisa no sino o back office e o supervisor da cidade (e os administradores) para aprovar ou recusar. Desligado por omissão: os pedidos aparecem na mesma no RH (topo da lista) e na ficha.", defaultEnabled: false },
  // D45 (Jorge, 3 out 2026): avisa gente → desligado por omissão.
  { name: "TASK_ASSIGNED_NOTIFY", label: "Tarefas: aviso \"Nova tarefa para ti\"", description: "Quando alguém te põe como responsável numa tarefa, recebes no sino \"Nova tarefa para ti\". Só tarefas feitas por pessoas (as automáticas — checklists, serviços, disponibilidade, RH — e as do Google não avisam) e nunca quem a atribuiu. Desligado por omissão.", defaultEnabled: false },
  // D50 (Jorge, 3 out 2026): obrigatórias, mas só com este interruptor (desligado por omissão).
  { name: "NOTIFY_CRITICAL_MANDATORY", label: "Avisos críticos obrigatórios", description: "\"Ocorrência crítica\" e \"A trabalhar sem PDA ou Zello\" passam a obrigatórias: ninguém as desliga no Perfil (quem as tinha desligado volta a recebê-las). Desligar isto devolve a cada um o que tinha escolhido. Não muda quem as recebe nem quando são enviadas. Desligado por omissão.", defaultEnabled: false },
  // D51 (Jorge, 3 out 2026): avisa gente → desligado por omissão.
  { name: "INTEGRATION_DISCONNECT_NOTIFY", label: "Aviso quando desligam uma integração", description: "Quando alguém desliga o Google Business ou o Google Ads, avisa no sino (e por email, se a pessoa o tiver ligado) os administradores e o super admin — menos quem desligou. Fica sempre no registo (Logs). Desligado por omissão.", defaultEnabled: false },
  // D52 (Jorge, 3 out 2026): o push já existia → ligado por omissão (nada muda até alguém o mudar).
  { name: "GBP_PUSH", label: "Google Business: notificações push", description: "A Google avisa a app quando chega uma crítica nova e a app vai buscá-la logo. Desligado: os avisos da Google são ignorados (confirmados, sem repetições) e as críticas chegam na recolha agendada." },
  // 33a (Jorge, 6 out 2026): Google Business pela Windsor — escreve/publica → desligados por omissão.
  { name: "GBP_WINDSOR_SYNC", label: "Críticas: importar do Google Business pela Windsor", description: "Quando a Google não está ligada diretamente, a recolha agendada vai buscar as avaliações dos perfis escolhidos à Windsor (WINDSOR_API_KEY) e põe-nas nas Críticas, como a ligação direta (1–3 estrelas → Reclamações). A 1.ª vez vai até 3 anos para trás; depois os últimos 60 dias. O botão \"Importar pela Windsor\" funciona sem isto. Desligado por omissão.", defaultEnabled: false },
  { name: "GBP_WINDSOR_REPLY", label: "Críticas: publicar respostas no Google pela Windsor", description: "Quando a Google não está ligada diretamente, o \"Aprovar e publicar\" das Críticas publica a resposta pela Windsor (ação reply_to_review — tem de estar ativa na equipa da Windsor). A resposta é pública e substitui a anterior. Desligado: publica-se no perfil Google e marca-se \"Já publiquei\". Desligado por omissão.", defaultEnabled: false },
  // Plano MPV F7 (§6.2, D6): conteúdo PÚBLICO publicado sem uma pessoa → desligado e só o super admin o liga.
  { name: "REVIEW_AUTO_PUBLISH_5STAR", label: "Críticas 5★: publicar a resposta sozinho (6 h depois)", description: "Para as críticas de 5★ ligadas ao Google (API ou Windsor), recentes, sem reclamação, sem resposta e sem links, contactos, insultos ou instruções no texto: a IA barata escreve a resposta, que fica 6 h à vista na crítica (com \"Cancelar\") e só depois é publicada, com o utilizador do sistema — antes de publicar volta a ler a crítica no Google (tem de continuar com 5★, o mesmo texto e sem resposta). No máximo 20 por dia e por perfil; pára sozinho ao fim de 3 falhas seguidas e avisa. Desligar pára as que estão à espera (as já publicadas ficam). Desligado por omissão.", defaultEnabled: false, superAdminOnly: true },
  // Jorge (14 out 2026): "porque é que os 141 não dão aviso nenhum?" — avisa gente → desligado por omissão.
  // Tarefa 62 (Q8, Jorge: "não vem: marca-se falta"): as faltas de quem tem horário fixo, como as dos extras.
  { name: "RH_FALTAS_HORARIO", label: "RH: possíveis faltas de quem tem horário fixo", description: "Todas as madrugadas (manutenção diária), quem tinha horário fixo na ficha do RH (Horário; funcionários — os extras regem-se pela escala) num dia de trabalho e não picou a entrada fica como \"possível falta\" na lista RH → Possíveis faltas, para alguém da operação confirmar ou dispensar. Confirmada, fica marcada como falta, sem pontos de penalização (não soma para o bloqueio da app das 3 faltas dos extras). Fora: quem estava na escala do Extras-Dia nesse dia (tem a sua regra), férias e baixas, dias livres do horário, fora do contrato, os feriados (nacionais e o municipal da cidade da ficha: 13 jun Lisboa, 24 jun Porto, 7 set Faro) e quem mexeu em carros na Multipark. Não avisa ninguém. Desligado por omissão.", defaultEnabled: false, superAdminOnly: true },
  { name: "GPS_SPEED_ALERTS", label: "Avisos de excesso de velocidade (GPS do Zello)", description: "Na recolha do GPS do Zello (a provisória das 23h e a final de D-2), cada excesso de velocidade (Definições → Parâmetros → Limite de velocidade) fica registado e avisa no sino o team leader e o supervisor da cidade da pessoa (\"Excesso de velocidade\"): um aviso por pessoa e recolha, com quantos excessos e a velocidade máxima (a final de D-2 só volta a avisar se trouxer excessos que a provisória não tinha; só para dias dos últimos 3; um dia antigo recolhido à mão não avisa). Também o aviso da verificação manual de velocidade (\"verificar agora\", pela API) só sai com isto ligado. Os pontos da Avaliação (−10 por dia acima do limite) contam sempre, com ou sem isto. Desligado por omissão.", defaultEnabled: false },
  { name: "TASKS_AUTOMATION", label: "Automação das tarefas", description: "Checklists do dia e avisos de atraso/conclusão." },
  // 18a (Jorge, 2 out 2026): avisa gente → desligado por omissão, como as outras.
  { name: "TASKS_AUTO_OVERDUE", label: "Avisos de atraso das tarefas automáticas", description: "Checklists, serviços, disponibilidade e fichas sem cidade que passam o prazo: avisa no sino os responsáveis e o supervisor da cidade (um resumo por cidade). Sem email. Só as que passaram o prazo há menos de 48 h (as mais antigas ficam marcadas sem aviso)." },
  { name: "CASE_REMINDERS", label: "Lembretes de SLA dos casos", description: "Avisa quando ocorrências/perdidos passam do prazo." },
  { name: "COMPLAINT_AUTO_ACK", label: "Aviso de receção das reclamações", description: "Responde automaticamente ao cliente quando chega uma reclamação por email." },
  { name: "HANDOVER_EMAIL", label: "Email da passagem de turno", description: "Envia a passagem de turno por email aos team leaders." },
  { name: "HANDOVER_REMINDERS", label: "Lembretes da passagem de turno", description: "Lembra quem ainda não entregou/confirmou a passagem." },
  { name: "TRAINING_REMINDERS", label: "Lembretes da formação", description: "Avisa quem tem formação por concluir." },
  // Jorge (14 out 2026): "uma vez por semana vai lá, escolhe duas ou três e põe lá" — escreve sozinho → desligado por omissão.
  { name: "KB_FAQ_WEEKLY", label: "Formação: FAQs novas da base de conhecimento (semanal)", description: "À segunda a partir das 09:30 (Lisboa) escolhe 2 ou 3 documentos da base de conhecimento (primeiro os atualizados há pouco e os que ainda não deram FAQ; só os que todos podem ver, nunca a ajuda da app) e a IA escreve 2 ou 3 FAQs novas, com resposta curta e a ligação ao documento. Entram logo publicadas em Formação → FAQs, marcadas \"IA\". Nunca repete uma FAQ que já existe, nem as que foram eliminadas (ficam arquivadas e servem de marca). Quem gere a formação pode editar ou eliminar. Precisa de \"IA: FAQs a partir da base de conhecimento\" ligado. Desligado por omissão.", defaultEnabled: false },
  { name: "TRAINING_BLOCKS_ESCALA", label: "Formação bloqueia a escala", description: "Quem tem formação obrigatória em atraso não entra na escala. Desligado por omissão (Jorge, 2 out 2026: para já a formação não bloqueia nada).", defaultEnabled: false },
  { name: "OPS_BRIEFING", label: "Briefing diário por cidade", description: "Às 07:30 (Lisboa): reservas do dia, extras, SLA, pendentes e alertas por email aos team leaders/supervisores da cidade e no Dashboard." },
  { name: "WEEKLY_REPORTS", label: "Relatórios semanais", description: "À segunda de manhã: direção, marketing, operações e RH por email a quem tem acesso nacional ao módulo; resumo semanal da passagem de turno." },
  { name: "WHATSAPP_CALLS", label: "Chamadas de voz do WhatsApp", description: "Toque no dashboard, atender no browser e \"Ligar\" nas conversas. Desligado por omissão: liga só depois de ativar as chamadas no número na Meta (e subscrever o campo `calls` do webhook).", defaultEnabled: false },
  { name: "MAIL_PUSH", label: "Gmail: notificações push (Pub/Sub)", description: "O Gmail avisa a app logo que chega um email (precisa do tópico Pub/Sub configurado: GMAIL_PUSH_TOPIC). Com o push a chegar (últimas 6 h), a sincronização agendada passa de 5 em 5 min a de hora a hora (rede de segurança); sem push volta sozinha aos 5 min. Desligado por omissão.", defaultEnabled: false },
  // Pauta do Rafael (Jorge, 7 out 2026): mexe no dinheiro (ordenado e custos) → desligado por omissão.
  // Plano 56 (Jorge, 12 out 2026): "terminal pelo perfil + pagamento" (B1 + B2). Mexe no dinheiro → desligado por omissão.
  { name: "PONTO_TERMINAL", label: "Terminal no ponto (aeroporto)", description: "Terminal pelo perfil + pagamento. Extras, condutores e team leaders carregam na fotografia → \"Estou no terminal\" (ou marcam \"Estou no terminal\" na entrada do ponto). O GPS tem de estar no aeroporto de uma cidade onde a pessoa trabalha (Definições → Parâmetros → Extras-dia → \"Aeroportos (terminal no ponto)\", com zonas por terminal). Só uma pessoa por cidade e cada pessoa só num terminal: ocupado → \"Pedir ao João para passar\" (sino ao João e ao TL de serviço). O TL/supervisor da cidade põe, passa ou fecha em Atividade diária → Ao vivo → Terminal agora (com motivo). A saída do ponto liberta o lugar. De 5 em 5 min vê-se o GPS do Zello do aparelho com a pessoa: fora há mais de 20 min → \"Ainda estás no terminal?\" (barra + push; aviso ao TL); sem resposta em 15 min o lugar fica livre; \"Ainda estou\" reabre sem buraco até 30 min. Horas que contam: saída com GPS no aeroporto → até à saída; senão até ao último GPS no aeroporto ou à última recolha/entrega (só até o GPS o ver sair); sem prova ficam por confirmar e o RH decide na ficha → Ponto. As horas de terminal pagam ao nível seguinte só aos extras (júnior → sénior, sénior → terminal, terminal → master), no ordenado, no recibo e no custo dos extras; condutores e TL ficam no terminal sem mudar o valor. O método antigo (saída + entrada no aeroporto) deixa de contar; os troços antigos ficam como estavam. Meses com o ordenado já fechado não mudam. Desligado: nada aparece, o vigia não corre e nada muda no ordenado.", defaultEnabled: false },
  // Plano 63, passo 1 (Jorge, 15 out 2026: "só eu mudo o modo"). Entra desligado; só o super admin o liga.
  { name: "PONTO_MODOS", label: "Ponto: modo de cada pessoa (horário fixo, isenção, sempre em serviço)", description: "Aparece o cartão \"Modo do ponto\" em RH → ficha → Horário: sem modo (as regras de hoje), 1 Horário fixo (back office e front office), 2 Isenção ou 3 Sempre em serviço (reformados). Só o super admin muda o modo, com a data \"a partir de\" e o motivo; fica o histórico. Os extras só podem ficar em \"Sempre em serviço\"; a isenção e o \"Sempre em serviço\" (pôr ou tirar) só valem a partir de hoje; nada muda num mês com o ordenado fechado. A pessoa lê o aviso do seu modo e carrega em \"Li\" (ou o RH regista a leitura em papel). As picagens passam a guardar o rasto: o modo desse dia, se a selfie veio da câmara ou de um ficheiro, a imprecisão do GPS e a conta que picou. Por agora NENHUMA regra muda: horas, ordenado, atrasos e faltas ficam iguais (as regras de cada modo vêm depois, com interruptores próprios). Desligado: o cartão não aparece e as picagens ficam como até aqui. Desligado por omissão.", defaultEnabled: false, superAdminOnly: true },
  { name: "ZELLO_PDA_NAMES", label: "Zello: nome de quem tem o PDA no mapa", description: "Quando alguém faz login num PDA (registado pelo QR), o nome da conta Zello desse PDA passa a \"PDA 12 · Rui Santos\"; no logout volta a \"PDA 12\". Assim o mapa do Zello mostra quem está com cada PDA. Um PDA que passa a telemóvel pessoal (botão \"Pessoal?\") fica com o nome do dono. Escreve no Zello (só o nome). Desligado por omissão até testar com um PDA.", defaultEnabled: false },
  // 20b (Jorge, 2 out 2026): mexe em fichas de clientes sozinho → só o super admin o liga/desliga.
  { name: "CRM_AUTO_MERGE", label: "CRM: juntar sozinho as fichas óbvias", description: "Todas as madrugadas (depois das sugestões das 05:15; se não acabar, continua) o CRM junta sozinho as fichas com o mesmo 1.º e último nome e um dado igual (email, telefone ou matrícula), ou com o mesmo email E telefone mesmo com outro nome. Nunca empresas, clientes Pro, emails genéricos (info@, reservas@…), dados em mais de 2 fichas nem NIF pessoais diferentes. Fica a ficha com mais reservas; cada junção aparece em Rever fichas → Juntas recentemente e pode ser separada. As dúvidas só vão à IA com \"IA: fichas de clientes duvidosas\" ligado.", defaultEnabled: true, superAdminOnly: true },
  // 31b (Jorge, 6 out 2026: "sim" às ligações automáticas pelo mesmo email) → ligado; desliga-se aqui.
  { name: "AGENT_EMAIL_AUTOLINK", label: "Agentes: ligar sozinho pelo mesmo email", description: "Na reconciliação de hora a hora, cada agente da Multipark que está em lado nenhum e tem o email de UMA só ficha ativa (email de trabalho, pessoal ou do utilizador) liga-se a essa ficha; se a ficha já tinha agente, entra como agente extra. Emails partilhados por mais de 2 agentes e fichas ligadas só pelo nome a outro agente ficam para o RH → Ligações. Cada ligação fica nos Logs.", defaultEnabled: true },
  { name: "PARTNER_MP_SYNC", label: "Parcerias: manter ligadas à Multipark todos os dias", description: "Todas as madrugadas (05:40) as Parcerias acertam-se com a Multipark: parceiros (agências e agregadores, com a taxa por parque), clientes Pro e avenças ficam presos ao id de lá, os novos são criados, os que deixaram de existir são arquivados (nunca apagados) e os agentes de cada parceiro ficam ligados à parceria. Liga depois de aplicares a primeira vez em Parcerias → Ligar à Multipark.", defaultEnabled: false },
  { name: "SERVICE_TASKS_TOMORROW_ALERT", label: "Serviços: aviso das tarefas de amanhã", description: "Todos os dias a partir das 18:00 (Lisboa): a lista das tarefas dos serviços extra com saída no dia seguinte, no sino e por email aos team leaders e supervisores de cada cidade. Lê só a nossa BD (sai mesmo com a Multipark em baixo). Desligado por omissão.", defaultEnabled: false },
  { name: "PARTNER_CLOSE_ALERTS", label: "Parceiros: avisar diferenças no fecho do mês", description: "Todas as manhãs (06:40) compara-se o mês corrente e o anterior, parceiro a parceiro, entre a Multipark e a nossa memória do webhook (a comparação corre sempre; isto só liga os avisos). Com isto ligado, quando aparecem diferenças NOVAS chega um aviso (sino e email) a quem vê as Parcerias.", defaultEnabled: false },
  { name: "OPS_PRESENCE_ALERTS", label: "Alertas: a trabalhar sem PDA ou Zello ligado", description: "De 5 em 5 minutos o dashboard vê quem do operacional tem o ponto aberto sem PDA (ou com o Zello desligado) e quem fez movimentos na Multipark sem ponto aberto (ou com o Zello desligado). A lista aparece sempre em Operacional → PDAs; com isto ligado, avisa também no sino o team leader de serviço na cidade e o supervisor. Desligado por omissão até se ver a lista uns dias.", defaultEnabled: false },
  { name: "OPS_PRESENCE_WHATSAPP", label: "Alertas sem PDA/Zello: WhatsApp aos administradores", description: "Se um alerta ficar sem ligação nem \"Visto\" do team leader (10 min por omissão), manda um WhatsApp aos administradores da cidade e à cópia (Definições → Operação). Precisa do modelo aprovado pela Meta e do alerta no sino ligado.", defaultEnabled: false },
  // Plano 56 (Jorge, 12 out 2026): entrar com email + código + palavra-passe. Avisa gente e mexe na entrada → desligado; só o super admin.
  { name: "ENTRAR_COM_CODIGO", label: "Entrar com email e código (sem Google)", description: "Na página de entrada aparecem Email + Palavra-passe e \"Pedir código\". O código (6 algarismos, vale 10 minutos, só no aparelho onde foi pedido) vai para o team leader de serviço e os supervisores da cidade da pessoa (sino + aviso no telemóvel; sem cidade, RH e admins), que o dão à pessoa. Depois do código a pessoa pode criar uma palavra-passe. Só para utilizadores, extras e condutores: team leaders e acima continuam a entrar com Google (num PDA registado entram com código, sem palavra-passe). O botão Google continua lá. Google e código caem na mesma conta (mesmo email). Nos PDAs registados a sessão fica presa ao PDA: acaba na saída do ponto, no logout, quando outra pessoa entra no PDA ou ao fim de 16 h; o Chrome não guarda emails nem palavras-passe; o QR do PDA só é lido pelo TL ou acima (e o supervisor é avisado quando um PDA passa para outro aparelho). Desligado: tudo como antes (só Google).", defaultEnabled: false, superAdminOnly: true },
  // Plano 56 A2 (Jorge, 12 out 2026): "o Google sai dos PDAs". Ligado = como hoje; só desliga com a entrada com código ligada.
  { name: "GOOGLE_NOS_PDAS", label: "Google nos PDAs", description: "Ligado (como hoje): nos PDAs registados aparece \"Entrar com Google\". Desligado: o botão Google desaparece nos PDAs registados (página de entrada, \"Iniciar sessão\" e registo do PDA) e entra-se com email e código. Só dá para desligar com \"Entrar com email e código\" ligado — sem ele, os PDAs ficavam sem forma de entrar. Telemóveis e PCs ficam sempre com o Google.", defaultEnabled: true, superAdminOnly: true },
  // ── Caixa, fase 4: cruzar com o exterior (desligados até haver chaves e decisão do dono; até lá confirma-se à mão) ──
  { name: "CASH_STRIPE_CHECK", label: "Caixa: cruzar os pagamentos online com a Stripe", description: "Todos os dias (07:00), as saídas de ontem e anteontem pagas online são confirmadas na Stripe (cobrado, valor, reembolsos, disputas). Precisa da chave restrita STRIPE_READ_KEY na Vercel. Desligado: só se confirma na Multipark que o pagamento online existe.", defaultEnabled: false, superAdminOnly: true },
  { name: "CASH_VIVA_CHECK", label: "Caixa: cruzar o multibanco com a Viva Wallet", description: "Todos os dias (07:00), os pagamentos por multibanco de ontem e anteontem são procurados nas transações da Viva Wallet (mesmo dia ou seguinte, mesmo valor). Precisa de VIVA_MERCHANT_ID e VIVA_API_KEY na Vercel. Desligado: confirma-se à mão com a foto do talão.", defaultEnabled: false, superAdminOnly: true },
  { name: "CASH_INVOICEXPRESS_CHECK", label: "Caixa: confirmar as faturas na InvoiceExpress", description: "Todos os dias (07:00), cada fatura emitida das saídas de ontem e anteontem é lida na InvoiceExpress (existe, não anulada, mesmo valor). Precisa de INVOICEXPRESS_ACCOUNT e INVOICEXPRESS_API_KEY na Vercel.", defaultEnabled: false, superAdminOnly: true },
  { name: "CENTRAL_SUGAR", label: "Central Vodafone: receber as chamadas da consola", description: "A consola One Net Attendant Console regista cada chamada na dashboard, como se fosse um Sugar CRM (Integrações → Central Vodafone: endereço a pôr na consola e um acesso por pessoa). As chamadas contam no Desempenho de quem atendeu ou fez. Desligado: a dashboard responde \"desligada\" à consola e só regista que ela tentou. Desligado por omissão.", defaultEnabled: false, superAdminOnly: true },
  // Lote 45 (Jorge, 7 out 2026: "quando a aplicação toca, dê algum input aqui e também toque aqui").
  { name: "CENTRAL_RING", label: "Central Vodafone: tocar no dashboard", description: "Quando entra uma chamada na consola de uma pessoa, o dashboard dessa pessoa toca e mostra quem é (nome, cliente ou equipa, reservas) com o botão para abrir a ficha. Só para quem tem um acesso da consola (Integrações → Central Vodafone) e precisa do \"receber as chamadas da consola\" ligado. As chamadas que a pessoa faz pelos botões \"Ligar\" da dashboard não tocam. Desligado por omissão.", defaultEnabled: false, superAdminOnly: true },
  // Plano 62 (P7): lê a Multipark todas as noites e escreve a tabela service_times → desligado até o Jorge ver
  // (depois do diagnóstico dos tempos, do PR dos parâmetros e de um dia reprocessado à mão).
  { name: "SERVICE_TIMES", label: "Tempos de entrega e de recolha (trabalho noturno)", description: "Todas as madrugadas (a partir das 05:30, depois da recolha GPS final) calcula, para cada entrega e recolha que fechou nos últimos 3 dias, a Fila (desde a chamada do cliente ou o pendente), o Trânsito e a espera pelo cliente (pela paragem no terminal no GPS do Zello), e nas recolhas o tempo no terminal, no P2 e até arrumado, com o condutor de cada tempo; guarda tudo na tabela dos tempos e preenche para trás desde abril (blocos de 7 dias, 2 nos dias com GPS, só até às 09h). Uma leitura da BD da Multipark por noite (só leitura, com teto); nada se apaga. Não avisa ninguém nem dá pontos. À mão: /api/cron/service-times?reprocessar=AAAA-MM-DD..AAAA-MM-DD (funciona mesmo desligado). Desligado por omissão.", defaultEnabled: false, superAdminOnly: true },
  { name: "OPS_ANOMALIES", label: "Deteção de anomalias", description: "Todos os dias: reservas por parque/canal, despesas (valores fora do normal e duplicados) e gasto/ROAS do marketing." },
  // B1 (Jorge, 8 out 2026: "as campanhas dão 0 reservas ligadas"). Só LÊ da Google e escreve
  // numa tabela nossa de apoio (google_ads_clicks) → ligado por omissão; desliga-se aqui.
  { name: "GOOGLE_ADS_CLICK_SYNC", label: "Google Ads: ligar reservas à campanha pelo clique (gclid)", description: "De hora a hora lê do Google Ads de que campanha é cada clique (relatório click_view: hoje, ontem e, aos poucos, os dias em falta até 90 dias para trás — a Google não guarda mais) e guarda-o numa tabela de apoio. Assim uma reserva cujo link só traz o gclid (auto-tagging) fica ligada à campanha no Marketing (ROAS por campanha, Ligadas, alertas). O ID da campanha no link continua a ganhar. Só lê do Google Ads; nada é alterado lá. Desligado: deixa de ler cliques novos (as reservas com cliques já lidos continuam ligadas; as outras só pelo ID no link). Estado em Integrações → Google Ads → Recolha." },
  // ── IA (server/_core/ai) — AI_ENABLED desliga tudo de uma vez ──
  { name: "AI_ENABLED", label: "IA (interruptor geral)", description: "Desligado = nenhuma funcionalidade de IA faz pedidos ao fornecedor.", group: "ia" },
  { name: "AI_EXPENSE_OCR", label: "IA: leitura de faturas", description: "Extrai fornecedor, valor, datas e NIF das faturas carregadas nas Despesas.", group: "ia" },
  { name: "AI_REVIEW_DRAFTS", label: "IA: rascunhos de resposta às críticas", description: "Prepara a resposta às críticas Google (nunca publica sozinha).", group: "ia" },
  { name: "AI_RADIO", label: "IA: transcrição e resumo do rádio", description: "Transcreve as mensagens de rádio e resume-as em 1–2 frases.", group: "ia" },
  { name: "AI_HANDOVER_SUMMARY", label: "IA: resumo da passagem de turno", description: "5 pontos para o team leader do turno seguinte, feitos quando a passagem é entregue (1.ª gravação) e no botão «Resumir agora». Editar a passagem depois não chama a IA.", group: "ia" },
  { name: "AI_WHATSAPP_ASSIST", label: "IA: assistente do WhatsApp", description: "Resumo da conversa e sugestão de resposta (vai para a caixa de texto, nunca é enviada sozinha).", group: "ia" },
  { name: "AI_QUIZ", label: "IA: perguntas da formação", description: "Gera rascunhos de perguntas a partir dos manuais.", group: "ia" },
  // Jorge (14 out 2026): "a IA devia fazer as perguntas a partir da base de conhecimento, diferentes de cada vez".
  // Ligado: só corre quando a pessoa carrega em "Jogar" e só grava as perguntas dessa tentativa (para a corrigir).
  { name: "AI_QUIZ_LIVE", label: "IA: quiz novo em cada jogo", description: "Em cada jogo do Quiz a IA faz 10 perguntas novas (escolha múltipla) a partir da base de conhecimento e dos manuais que a pessoa pode ver, sobre o tema escolhido ou o da formação; evita as que a pessoa já teve. A resposta certa fica só no servidor e a correção é feita lá. As perguntas e as respostas ficam guardadas para a nota e para rever. Se a IA falhar ou estiver desligada, o jogo usa as perguntas fixas (Gerir perguntas). Nada é publicado sozinho.", group: "ia" },
  // Usado pela FAQ semanal (KB_FAQ_WEEKLY, desligada) e pelo botão "Gerar agora" (uma pessoa carrega).
  { name: "AI_KB_FAQ", label: "IA: FAQs a partir da base de conhecimento", description: "A IA lê um documento da base de conhecimento (só os que todos podem ver) e escreve FAQs curtas com a ligação ao documento, sem repetir as que já existem nem as eliminadas. Corre no botão \"Gerar agora\" (Formação → FAQs, quem gere a formação) e, com \"Formação: FAQs novas da base de conhecimento (semanal)\" ligado, uma vez por semana.", group: "ia" },
  { name: "AI_TRAINING_TUTOR", label: "IA: tutor da formação", description: "Chat nas páginas da Formação: responde só com o conteúdo dos manuais, motiva e explica as respostas erradas do quiz. Também ajuda a \"Procurar formação por tema\" (escolhe no catálogo só pelos títulos e resumos; desligado, a pesquisa usa só palavras).", group: "ia" },
  { name: "AI_COMPLAINT_TRIAGE", label: "IA: triagem das reclamações por email", description: "Sugere tipo, prioridade, SLA, reserva e duplicados e prepara um rascunho de resposta (nunca é enviado sozinho). Só aplica sozinha com confiança alta e campo vazio.", group: "ia" },
  { name: "AI_REVIEW_AUTO_DRAFTS", label: "IA: rascunho automático para cada crítica nova", description: "Prepara a resposta às críticas Google novas (fica por aprovar; nunca publica sozinha).", group: "ia" },
  // Plano MPV F6b (R2/R3): críticas por email. Mudam o que vira crítica → desligados por omissão.
  { name: "REVIEWS_EMAIL_STRICT", label: "Críticas: só cria crítica a partir de um aviso de avaliação", description: "Um email que chega às Críticas (inclui o «apanha tudo» da reservas@) só vira crítica se vier do aviso de avaliação (Google Business Profile, Trustpilot, Tripadvisor) ou se trouxer as estrelas. O resto (candidaturas, respostas de clientes, alertas) segue para a triagem normal das caixas — nunca fica ignorado. As críticas antigas que não o são marcam-se à parte (Críticas → Limpeza; não corre sozinho). Desligado por omissão.", defaultEnabled: false },
  { name: "REVIEWS_DEDUP", label: "Críticas: juntar a mesma crítica que chega duas vezes", description: "A Google manda às vezes 2 emails da mesma crítica e a Windsor traz a mesma outra vez. Ligado: lê o assunto além do corpo (perfil/parque e nome), os emails-resumo («recebeu N críticas») nunca viram crítica, e uma crítica igual (mesmo parque, mesmas estrelas, mesmo 1.º nome, o mesmo texto com 20 ou mais letras, até 48 h de diferença) fica marcada como repetida da primeira — não se apaga e sai das listas. Sem texto nunca se junta sozinha. A ligação Windsor ↔ email passa a procurar também pelas estrelas + texto (fica por conciliar, uma pessoa escolhe). Desligado por omissão.", defaultEnabled: false },
  { name: "AI_WHATSAPP_TRIAGE", label: "IA: intenção e urgência no WhatsApp", description: "Etiqueta as conversas (reserva, cancelamento, reclamação…) e marca as urgentes (entram no aviso de SLA). No máximo 1× a cada poucos minutos por conversa; nunca responde sozinha.", group: "ia" },
  // Plano MPV F6b (W1): 64 % das triagens do WhatsApp eram de colaboradores → desligado por omissão (o Jorge liga depois de ver).
  { name: "WA_TRIAGE_SKIP_STAFF", label: "IA: não ler com IA as conversas de colaboradores no WhatsApp", description: "As conversas de colaboradores e candidatos (caixa RH por regra) deixam de passar pela IA da intenção e urgência — salvo se a mensagem tiver uma palavra de urgência (acidente, avaria, roubo, furto, batida, incêndio, ferido, polícia, reboque, urgente…): nesses casos lê. Uma conversa já lida só volta a ser lida se ainda não tiver intenção, se a última leitura tiver mais de 24 h ou com uma palavra de urgência. A resposta a um pedido de disponibilidade que a IA da disponibilidade já leu não volta a ir à IA (a urgência por palavras marca-se sem IA). Desligado por omissão.", defaultEnabled: false, group: "ia" },
  { name: "AI_LOST_FOUND_MATCH", label: "IA: correspondências nos Perdidos & Achados", description: "Compara as descrições dos perdidos com os objetos encontrados (depois de um filtro por data, matrícula/reserva e parque). Contactar o cliente é sempre humano.", group: "ia" },
  { name: "AI_CRM_IDENTITY", label: "IA: fichas de clientes duvidosas", description: "Nas sugestões para juntar que as regras não resolvem (nome diferente, nome de uma palavra…), a IA dá o parecer e junta sozinha só com certeza alta (≥ 85 %); o resto fica em Rever fichas com o parecer à vista. Recebe só o primeiro nome e factos (\"telefone igual\", \"NIF diferente\"), nunca emails, telefones ou matrículas. Empresas, clientes Pro e NIF pessoais diferentes nunca vão à IA. Só funciona com a junção automática (CRM_AUTO_MERGE) ligada.", defaultEnabled: false, group: "ia" },
  { name: "AI_ASSISTANT", label: "IA: assistente (chat)", description: "Botão de ajuda em todas as páginas: explica como se usa a app e responde a perguntas sobre os dados que a pessoa já pode ver (só leitura).", group: "ia" },
  // Plano MPV (F0b): piloto do Multis no modelo smart. Gasta mais → desligado por omissão.
  { name: "AI_ASSISTANT_SMART", label: "IA: Multis do piloto (modelo smart)", description: "Para as pessoas do piloto (Definições → Parâmetros → IA, ai.assistantPilot), com o «Multis por página (MPV)» ligado, o Multis responde com o modelo smart (AI_MODEL_SMART, ex.: gemini-4-argon). Tem teto de gasto próprio (ai.assistantSmartBudget): ao chegar lá, a pessoa continua no modelo de sempre com a nota \"modo económico\". Não conta para o orçamento mensal que pára as outras funcionalidades. Desligado: toda a gente fica no Multis de sempre.", defaultEnabled: false, group: "ia" },
  { name: "MPV", label: "Multis por página (MPV) — piloto", description: "Liga o piloto do Multis por página: as pessoas em ai.assistantPilot passam a usar o Multis do piloto (com «IA: Multis do piloto (modelo smart)» ligado). As outras pessoas não mudam. Desligado por omissão; só o super admin muda.", defaultEnabled: false, group: "ia", superAdminOnly: true },
  // Multis 2 (Jorge, 8 out 2026: pediu a memória) → ligado por omissão. Não chama a IA:
  // o "Lembra-te" grava sem IA; as notas só vão no contexto das perguntas ao Multis.
  { name: "AI_ASSISTANT_MEMORY", label: "IA: memória do Multis", description: "Quem escreve no Multis uma mensagem a começar por \"Lembra-te\" (ou \"Memoriza\", \"Não te esqueças\") fica com essa nota guardada (até 30 por pessoa), e os admins escrevem notas da empresa (até 100) que toda a gente vê. O Multis segue-as em todas as conversas, mas nunca para contornar permissões ou cidades. Tudo à vista no separador Memória do Multis; arquivar não apaga. Desligado: não guarda, não usa as notas e esconde a Memória.", group: "ia" },
  { name: "AI_HR_AUTOFILL", label: "IA: preenchimento a partir de documentos do RH", description: "Lê CC, título de residência, carta, IBAN e morada para preencher campos vazios da ficha. O documento vai inteiro: só corre com a IA em Vertex AI na UE. Desligado por omissão.", defaultEnabled: false, group: "ia" },
  { name: "AI_HR_EMAIL_ATTACHMENTS", label: "IA: anexos dos emails do RH (CV)", description: "Lê os anexos (CV, documentos) dos emails de candidatura que chegam ao RH: preenche no candidato só os campos vazios (NIF, n.º do BI/CC, n.º da carta, cidade só quando é certa, outros contactos) e escreve um resumo para quem entrevista. NIF e números dos documentos só o RH vê. Só emails dos últimos 14 dias; cada anexo é lido uma vez. O ficheiro vai inteiro: só corre com a IA em Vertex AI na UE.", defaultEnabled: false, group: "ia" },
  { name: "AI_OPS_BRIEFING", label: "IA: texto do briefing diário", description: "Escreve o parágrafo do briefing das 07:30 por cidade (os números vêm sempre do sistema).", group: "ia" },
  { name: "AI_WEEKLY_REPORTS", label: "IA: texto dos relatórios semanais", description: "Narrativa curta dos relatórios de segunda-feira (direção, marketing, operações, RH).", group: "ia" },
  { name: "AI_ANOMALY_EXPLAIN", label: "IA: explicação das anomalias", description: "Uma linha por anomalia detetada (reservas, despesas, marketing), uma vez por dia. A deteção é estatística, sem IA. Condutores e extras veem o alerta sem a linha da IA.", group: "ia" },
  { name: "AI_AVAILABILITY_CLASSIFY", label: "IA: respostas de disponibilidade pouco claras", description: "Classifica as respostas que o sistema não percebeu. Confiança alta aplica-se sozinha; o resto vai para revisão humana.", group: "ia" },
  { name: "AI_LEAD_SCORING", label: "IA: resumo e 1.º contacto das leads", description: "Resumo de uma linha da pontuação (calculada no sistema) e rascunho do 1.º contacto, que precisa de aprovação. Os dois só para quem edita as leads.", group: "ia" },
  { name: "AI_EVALUATION_EXPLAIN", label: "IA: explicação da avaliação", description: "Explica em PT-PT a pontuação a partir das linhas das regras (nunca recalcula).", group: "ia" },
  { name: "AI_HANDOVER_REPEATS", label: "IA: pendentes repetidos da passagem de turno", description: "Redige os pendentes que se repetem entre turnos e o resumo semanal por cidade.", group: "ia" },
  // Jorge (8 out 2026): "a IA… age sozinha… divide logo e põe nas caixas sem ler" → ligado por omissão.
  // Jorge (8 out 2026): "a IA… age sozinha… divide logo e põe nas caixas sem ler" → ligado por omissão.
  // 14 out 2026: lê pelo sentido; a falha não move nada; uma resposta só muda de caixa com um caso.
  { name: "AI_MAIL_ROUTING", label: "IA: separar emails e WhatsApp pelas caixas", description: "A IA lê cada email recebido nas caixas partilhadas (info@, reservas@, recursos-humanos@…; nunca as pessoais) e as conversas NOVAS do WhatsApp, e decide pelo sentido do que a pessoa escreve (não por palavras soltas). Conversa nova → caixa do tema (RH, Reservas, Alterações, Cancelamentos, Serviços extra, Reclamações, Perdidos, Parcerias, Faturação), por ler; lixo (publicidade, spam, respostas automáticas) fica onde está; o que não percebe vai para o info (no WhatsApp, a Geral). Se a IA falhar nada se mexe: fica por ler e volta a ser lida. Uma resposta numa conversa que já tem caixa só muda de caixa se trouxer uma reclamação ou um perdido. Recrutamento em 1.º contacto cria a lead e a candidatura. As reclamações, os perdidos, as críticas e as ocorrências têm interruptores próprios. Nunca responde a ninguém; mover à mão corrige e a IA não volta a mexer nessa conversa.", group: "ia" },
  // Lote 57 (Jorge, 12 out 2026: "se a IA vê que é uma reclamação, envia para lá") → ligado por omissão.
  // 14 out 2026: "tem de ficar automático" — certeza média cria "Por confirmar (IA)"; a conversa vai para as Reclamações.
  { name: "AI_MAIL_COMPLAINTS", label: "IA: reclamações que chegam a outras caixas vão para as Reclamações", description: "Usa a leitura da IA das caixas (precisa de «IA: separar emails e WhatsApp pelas caixas»; não faz outra chamada à IA). Quando um email de uma caixa partilhada (info@, reservas@, cancelamentos…) é uma reclamação — também numa resposta, num reencaminhamento do backoffice ou escondida noutro pedido: cria a reclamação (origem IA) ou junta o email à aberta da mesma conversa, do mesmo cliente ou da mesma reserva, e a conversa vai para a caixa Reclamações, por ler. Com certeza média a reclamação nasce \"Por confirmar (IA)\": confirma-se ou arquiva-se (nada se apaga). Uma conversa nunca dá duas reclamações. Nunca para emails internos (salvo o reencaminhamento de um cliente), automáticos, envios em massa, parceiros nem avisos de avaliações. NUNCA se responde ao cliente (sem aviso de receção). Na reclamação fica escrito que veio da IA, de que caixa e porquê. Certezas em Definições → Parâmetros → IA (ai.mailComplaints). Desligado: a IA continua a separar pelas caixas, mas não cria reclamações.", group: "ia" },
  // 14 out 2026 — o mesmo para os perdidos. Cria casos sozinha → desligado por omissão (o Jorge liga depois de ver).
  { name: "AI_MAIL_LOST_FOUND", label: "IA: objetos perdidos que chegam às caixas vão para os Perdidos e Achados", description: "Como as reclamações, para os objetos perdidos (usa a mesma leitura da IA, sem outra chamada): quando um email de uma caixa partilhada diz que alguém deixou, perdeu ou esqueceu um objeto (no carro, no parque, no transfer), cria o caso nos Perdidos e Achados (origem IA) ou junta o email ao caso aberto do mesmo cliente, e a conversa vai para a caixa Perdidos, por ler. Com certeza média o caso nasce \"Por confirmar (IA)\". As respostas do cliente nessa conversa juntam-se ao caso. Uma conversa nunca dá dois casos. Nunca escreve ao cliente. Desligado por omissão.", defaultEnabled: false, group: "ia" },
  // Ronda 2 da auditoria (14 out 2026) — parceiros em nome de clientes. Cria casos sozinha → desligado por omissão.
  { name: "AI_MAIL_PARTNER_CASES", label: "IA: reclamações e perdidos que um parceiro manda em nome de um cliente abrem o caso", description: "Uma agência, um hotel ou um comparador (contacto das Parcerias) que escreve a dizer que um cliente dele se queixa — ou que deixou um objeto — abre a reclamação (ou o perdido) como os outros emails, mas SEMPRE «Por confirmar (IA)»: o email do parceiro nunca fica como o do cliente nem junta casos de clientes diferentes (junta só pela conversa, pela matrícula ou pela reserva). Precisa dos interruptores das reclamações / dos perdidos ligados. Nunca escreve ao parceiro nem ao cliente. Desligado: os emails de parceiros nunca abrem caso (como antes; a conversa vai para a caixa do tema).", defaultEnabled: false, group: "ia" },
  // 14 out 2026 — críticas e ocorrências por email: caixa própria e lidas. Muda o lido → desligado por omissão.
  { name: "AI_MAIL_NOTICES", label: "IA: críticas e ocorrências por email vão para a caixa delas e ficam lidas", description: "Avisos de avaliação (Google Business Profile, Trustpilot, Tripadvisor — reconhecidos pelo remetente) e elogios ou opiniões de clientes vão para a caixa Críticas e ficam LIDOS: a crítica entra nas Críticas pela API do Google ou pela criticas@ — daqui não se cria nada. Avisos de ocorrência da app Multipark (o formulário «Tipo de ocorrência / Matrícula») ligam-se à ocorrência da Multipark (só leitura, pela matrícula e pela hora), vão para a caixa Ocorrências e ficam lidos; se a ocorrência não estiver na app, ficam por ler. Relatos de ocorrências escritos por pessoas vão para as Ocorrências por ler. Lido também no Gmail. Desligado por omissão.", defaultEnabled: false, group: "ia" },
  // 14 out 2026 — rever o que já está nas caixas (cria casos sozinha) → desligado por omissão.
  { name: "AI_MAIL_BACKFILL", label: "IA: rever os emails que já estão nas caixas", description: "De 15 em 15 min passa pela mesma triagem os emails recebidos nos últimos dias (30 por omissão; Definições → Parâmetros → IA, ai.mailBackfill) nas caixas partilhadas que ainda não têm caso: as reclamações e os perdidos que lá estejam abrem o caso (com os interruptores deles ligados) e a conversa vai para a caixa do caso; avisos de avaliação e de ocorrência ficam lidos (com o interruptor dos avisos). Não baralha as caixas de tema dos emails antigos. Cada email é lido uma vez; o que já tem caso e o que uma pessoa mexeu (moveu, corrigiu a IA, recusou, resolveu, arquivou) fica como está. Por lotes (6 emails por corrida, por omissão). Nunca escreve ao cliente. Desligado por omissão.", defaultEnabled: false, group: "ia" },
  // 14 out 2026 — reclamacoes@/perdidos@: só não abre o caso com a certeza da IA de que é lixo → desligado por omissão.
  { name: "AI_MAIL_ALIAS_FILTER", label: "IA: não abrir caso para o lixo que chega à reclamacoes@ e perdidos@", description: "Tudo o que chega à reclamacoes@ e à perdidos@ continua a abrir o caso (a reclamação com o aviso de receção, como sempre), salvo se a IA tiver a certeza (90 % ou mais) de que é lixo — publicidade, spam, resposta automática — e não vê reclamação nem perdido. Esse email fica na caixa, por ler, com a linha da IA a dizer porquê. Se a IA falhar ou não houver leitura nesta corrida, o caso abre na mesma. Desligado por omissão.", defaultEnabled: false, group: "ia" },
  { name: "AI_MAIL_DRAFT", label: "IA: rascunho de resposta a emails", description: "Botão \"Rascunho IA\" na Comunicação: prepara uma resposta ao cliente (vai para o editor; nunca é enviada sozinha).", group: "ia" },
  { name: "AI_GBP_POSTS", label: "IA: rascunho de publicações Google Business", description: "Marketing → Web & SEO → Google Business: propõe o texto de uma Novidade/Oferta/Evento a partir do tema indicado (fica no editor; nada é publicado sem confirmação).", group: "ia" },
  { name: "AI_PAGESPEED_EXPLAIN", label: "IA: explicar o que corrigir na PageSpeed", description: "Marketing → Web & SEO → Velocidade: explica em PT-PT as principais oportunidades do Lighthouse (só com os títulos e poupanças; sem dados pessoais).", group: "ia" },
  { name: "AI_WEB_INSIGHT", label: "IA: resumo semanal Web & SEO", description: "Marketing → Web & SEO: um parágrafo por semana sobre o que mudou no tráfego, na pesquisa Google e na velocidade (só a partir dos totais; sem dados pessoais).", group: "ia" },
  { name: "AI_KNOWLEDGE", label: "IA: base de conhecimento", description: "Índice dos manuais (Drive e ficheiros carregados) por embeddings e leitura de PDFs sem Drive. Desligado = a pesquisa usa só palavras-chave (FULLTEXT).", group: "ia" },
  { name: "AI_TASKS_FROM_TEXT", label: "IA: tarefas a partir de texto", description: "Propõe tarefas a partir de notas coladas; nada é criado sem confirmação. Team leader para cima.", group: "ia" },
];

/** Omissão de um interruptor do catálogo (desconhecido → ligado). PURA. */
export function automationFlagDefault(name: string): boolean {
  return AUTOMATION_FLAGS.find((f) => f.name === name)?.defaultEnabled ?? true;
}

/** O interruptor que este segue quando não tem valor próprio (ou null). PURA. */
export function automationFlagFollows(name: string): string | null {
  return AUTOMATION_FLAGS.find((f) => f.name === name)?.followsFlag ?? null;
}

/**
 * Valor da env de um interruptor já traduzido para on/off quando o catálogo
 * tem valores próprios (ex.: X=db → "on"). PURA.
 */
export function normalizeFlagEnv(name: string, raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;
  const aliases = AUTOMATION_FLAGS.find((f) => f.name === name)?.envAliases;
  const hit = aliases?.[String(raw).trim().toLowerCase()];
  return hit === undefined ? raw : hit ? "on" : "off";
}

/** Só o super_admin pode mudar este interruptor? PURA. */
export function automationFlagSuperAdminOnly(name: string): boolean {
  return AUTOMATION_FLAGS.find((f) => f.name === name)?.superAdminOnly === true;
}

export const FLAG_SETTING_PREFIX = "flag.";
const FLAG_NAMES = new Set(AUTOMATION_FLAGS.map((f) => f.name));

export function isAutomationFlag(name: string): boolean {
  return FLAG_NAMES.has(name);
}
export function flagSettingKey(name: string): string {
  return `${FLAG_SETTING_PREFIX}${name}`;
}
export function isFlagSettingKey(key: string): boolean {
  return key.startsWith(FLAG_SETTING_PREFIX) && isAutomationFlag(key.slice(FLAG_SETTING_PREFIX.length));
}

// ─── Crons (agendador /api/cron/tick → trabalhos) ───────────────────────────

export interface CronJob {
  name: string;
  label: string;
  /** Intervalo esperado entre corridas (min); `null` = sem agenda fixa. */
  intervalMinutes: number | null;
  /** Quem o corre: "tick" (agendador, cron-job.org de 5 em 5 min) ou "manual". */
  workflow: string;
}

export const CRON_JOBS: readonly CronJob[] = [
  // O próprio agendador (cron-job.org de 5 em 5 min; GitHub Actions de hora a hora).
  { name: "tick", label: "Agendador (cron-job.org → /api/cron/tick)", intervalMinutes: 5, workflow: "cron-job.org" },
  // 5 em 5 min sem push; 1×/dia (rede de segurança) com o push do Gmail saudável. O Estado do
  // sistema usa a cadência em vigor (20b); este valor fica só para quem não a conhece.
  { name: "mail-sync", label: "Comunicação: sincronização do Gmail", intervalMinutes: 60, workflow: "tick" },
  { name: "multipark-deliveries", label: "Fila do webhook Multipark (repescagem)", intervalMinutes: 60, workflow: "tick" },
  { name: "ai-comms", label: "IA na comunicação com clientes", intervalMinutes: 15, workflow: "tick" },
  { name: "mail-backfill", label: "Comunicação: casos por criar e emails das caixas revistos pela IA", intervalMinutes: 15, workflow: "tick" },
  // Google por eventos: repetição de hora a hora, rede de segurança de 4 em 4 h, renovação diária dos canais.
  { name: "google-pending", label: "Google: alterações por enviar/receber (repetição)", intervalMinutes: 60, workflow: "tick" },
  { name: "google-sync", label: "Google Tarefas, Calendário, Contactos e Drive (rede de segurança)", intervalMinutes: 240, workflow: "tick" },
  { name: "google-watch-renew", label: "Google: renovar canais de notificação (Calendário/Drive)", intervalMinutes: 1440, workflow: "tick" },
  { name: "extras-auto", label: "Automação dos extras", intervalMinutes: 60, workflow: "tick" },
  // De 15 em 15 min entre as 08h e as 23h (Lisboa; plano MPV F7); 300 min para
  // a pausa da noite (~9 h) não aparecer como "parado".
  { name: "extras-schedule", label: "Escala automática dos extras (propor/confirmar/avisar)", intervalMinutes: 300, workflow: "tick" },
  // Plano MPV F7: lembretes 30 min antes da proposta e da confirmação (interruptor EXTRAS_REMINDERS). Igual: 08h–23h.
  { name: "extras-reminders", label: "Extras-dia: lembretes antes da proposta e da confirmação", intervalMinutes: 300, workflow: "tick" },
  // Plano MPV F7 (§6.2): críticas 5★ respondidas sozinhas (interruptor REVIEW_AUTO_PUBLISH_5STAR, desligado). 08h–23h.
  { name: "reviews-5star", label: "Críticas 5★: responder sozinho (6 h depois, desligado por omissão)", intervalMinutes: 300, workflow: "tick" },
  { name: "identity-sweep", label: "Ligações funcionário ↔ utilizador", intervalMinutes: 60, workflow: "tick" },
  // CRM (27 set 2026): fichas de cliente a partir das reservas + sugestões de fusão.
  { name: "crm-sync", label: "CRM: fichas de cliente a partir das reservas", intervalMinutes: 1440, workflow: "tick" },
  { name: "crm-suggestions", label: "CRM: sugestões para juntar fichas", intervalMinutes: 1440, workflow: "tick" },
  { name: "crm-pro-sync", label: "CRM: conta corrente dos clientes Pro (BD Multipark)", intervalMinutes: 30, workflow: "tick" },
  // Serviços extra das reservas → tarefas: nascem no webhook (saídas até 72 h); volta de segurança e aviso de amanhã às 18:00.
  { name: "services-tasks", label: "Serviços: volta de segurança das tarefas", intervalMinutes: 1440, workflow: "tick" },
  { name: "services-tomorrow", label: "Serviços: aviso das tarefas de amanhã", intervalMinutes: 1440, workflow: "tick" },
  // Caixa, fase 2 (29 set 2026): varredura do dinheiro e fecho do dia → "Correção de caixa".
  { name: "crm-auto-merge", label: "CRM: juntar sozinho as fichas óbvias", intervalMinutes: 1440, workflow: "tick" },
  { name: "partner-mp-sync", label: "Parcerias: ligar à Multipark", intervalMinutes: 1440, workflow: "tick" },
  { name: "partner-close", label: "Parceiros: comparar o fecho do mês", intervalMinutes: 1440, workflow: "tick" },
  { name: "cash-sweep", label: "Caixa: varredura do dinheiro (Correção de caixa)", intervalMinutes: 180, workflow: "tick" },
  { name: "ops-presence", label: "Operacional: a trabalhar sem PDA ou Zello ligado", intervalMinutes: 5, workflow: "tick" },
  { name: "cash-confirm-recheck", label: "Caixa: reler os dias confirmados (reabre se a Multipark mudou)", intervalMinutes: 60, workflow: "tick" },
  { name: "terminal-watch", label: "Terminal: \"Ainda estás no terminal?\" (GPS de 5 em 5 min)", intervalMinutes: 5, workflow: "tick" },
  { name: "cash-close", label: "Caixa: fecho do dia (saídas de ontem e anteontem)", intervalMinutes: 1440, workflow: "tick" },
  { name: "cash-external", label: "Caixa: confirmar pagamentos (online, Viva, faturas)", intervalMinutes: 1440, workflow: "tick" },
  { name: "daily-ops", label: "Manutenção diária + recolha GPS final (D-2)", intervalMinutes: 1440, workflow: "tick" },
  { name: "zello-sameday", label: "GPS do Zello — recolha provisória do dia (23:15–23:55)", intervalMinutes: 1440, workflow: "tick" },
  { name: "gps-resplit-backfill", label: "GPS: re-dividir os últimos 31 dias (a pedido do super admin)", intervalMinutes: 5, workflow: "tick" },
  { name: "extras-pressure", label: "Extras-Dia: pressão (acumula desde abril, BD Multipark)", intervalMinutes: 1440, workflow: "tick" },
  { name: "rh-docs-weekly", label: "RH: regra documental dos extras (semanal)", intervalMinutes: 10080, workflow: "tick" },
  { name: "rh-docs-request", label: "RH: pedir documentos em falta aos extras (semanal)", intervalMinutes: 10080, workflow: "tick" },
  { name: "kb-faq-weekly", label: "Formação: FAQs novas da base de conhecimento (semanal)", intervalMinutes: 10080, workflow: "tick" },
  { name: "evaluation-recompute", label: "Avaliação (recálculo do último mês)", intervalMinutes: 1440, workflow: "tick" },
  // Plano 62 (P7): interruptor SERVICE_TIMES (desligado por omissão).
  { name: "service-times", label: "Tempos de entrega e de recolha (BD Multipark, chamadas e GPS)", intervalMinutes: 1440, workflow: "tick" },
  { name: "google-ads", label: "Google Ads", intervalMinutes: 1440, workflow: "tick" },
  { name: "google-ads-clicks", label: "Google Ads: cliques (gclid → campanha)", intervalMinutes: 60, workflow: "tick" },
  { name: "meta-ads", label: "Meta Ads", intervalMinutes: 1440, workflow: "tick" },
  { name: "ops-briefing", label: "Briefing diário, anomalias e relatórios semanais", intervalMinutes: 1440, workflow: "tick" },
  { name: "ops-anomaly-retries", label: "Anomalias: repetir as explicações que falharam", intervalMinutes: 1440, workflow: "tick" },
  { name: "web-analytics", label: "Web & SEO (GA4, Search Console, PageSpeed)", intervalMinutes: 1440, workflow: "tick" },
  // Fora da agenda do tick: base de conhecimento — sincroniza SOZINHA quando há
  // alterações nas pastas do Drive (avisos da Google → fila de hora a hora, e a
  // verificação de 4 em 4 h do google-sync); esta linha regista só o botão
  // "Sincronizar agora" — e Google Business Profile (em pausa até a Google aprovar a API).
  { name: "knowledge-sync", label: "Base de conhecimento: «Sincronizar agora» (sozinha quando há alterações nas pastas do Drive)", intervalMinutes: null, workflow: "manual" },
  { name: "google-business", label: "Google Business Profile (críticas, desempenho e pesquisas)", intervalMinutes: null, workflow: "manual (em pausa)" },
];

const CRON_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** "/mail-sync" ou "/api/cron/mail-sync" → "mail-sync"; `null` se inválido. PURA. */
export function cronNameFromPath(path: string): string | null {
  const seg = String(path ?? "").replace(/^\/api\/cron/, "").replace(/^\/+/, "").split(/[/?#]/)[0] ?? "";
  return CRON_NAME.test(seg) ? seg : null;
}

/** Folga mínima antes de dar um cron como "parado" (um tick falhado não chega). */
export const CRON_MIN_STALE_MINUTES = 30;

/** Limite (min) sem corridas a partir do qual o cron é "parado": 2× o intervalo. */
export function staleThresholdMinutes(intervalMinutes: number): number {
  return Math.max(2 * intervalMinutes, CRON_MIN_STALE_MINUTES);
}

export type CronHealth = "ok" | "failed" | "stale" | "never" | "running" | "unscheduled" | "skipping";

/**
 * Trabalho RETIRADO (Jorge, 7 out 2026: o `multipark-db-sync`, retirado a
 * 27 set, continuava a aparecer como "Falhou"): já não está em CRON_JOBS e não
 * corre há mais de RETIRED_CRON_AFTER_DAYS dias. Sai da lista e dos alertas
 * (o histórico em cron_runs fica). Um nome desconhecido que correu há pouco
 * (ex.: corrida à mão) continua a aparecer. PURA.
 */
export const RETIRED_CRON_AFTER_DAYS = 7;
export function isRetiredCron(isKnown: boolean, lastStartedAt: number | null, now: number): boolean {
  if (isKnown) return false;
  return lastStartedAt == null || now - lastStartedAt > RETIRED_CRON_AFTER_DAYS * 86_400_000;
}

export interface CronRunLite {
  startedAt: number;          // epoch ms
  finishedAt: number | null;  // null = ainda a correr (ou morreu sem responder)
  ok: boolean | null;
}

/**
 * Estado de um cron a partir da última corrida. PURA.
 *  - never: nunca correu (desde que há registo);
 *  - stale: sem corridas há mais de 2× o intervalo esperado;
 *  - failed: a última terminada falhou (ou ficou sem resposta > 15 min);
 *  - running: começou há pouco e ainda não respondeu.
 */
export function cronHealth(last: CronRunLite | null, intervalMinutes: number | null, now: number): CronHealth {
  if (!last) return intervalMinutes == null ? "unscheduled" : "never";
  if (intervalMinutes != null && now - last.startedAt > staleThresholdMinutes(intervalMinutes) * 60_000) return "stale";
  if (last.finishedAt == null) return now - last.startedAt > 15 * 60_000 ? "failed" : "running";
  return last.ok ? "ok" : "failed";
}

/**
 * D57 (Jorge, 3 out 2026): um cron que corre mas SALTA há vários dias por
 * falta de configuração ou de ligação (Zello por configurar, BD da Multipark
 * sem endereço, Google Ads/Business desligado, conta a religar…) é um problema
 * no Estado. Saltar porque um interruptor está desligado, fora de horas ou
 * porque outra corrida já está a trabalhar é escolha/normal — não conta.
 */
export const CRON_SKIP_PROBLEM_DAYS = 2;
const SKIP_PROBLEM_RE = /not_configured|not_connected|reauth_required|disconnected|no_accounts|não (?:está|estão) (?:definid|ligad)|não configurad|sem contas|sem MARKETING_REPORT_EMAILS/i;
const SKIP_BY_CHOICE_RE = /desligad|disabled|interruptor|fora de horas|locked|noutro tick|busy|meia-noite/i;

/** A nota de uma corrida saltada diz que falta configuração/ligação? PURA. */
export function isProblemSkip(note: string | null | undefined): boolean {
  const n = String(note ?? "");
  if (!/^saltado:/i.test(n)) return false;
  return SKIP_PROBLEM_RE.test(n) && !SKIP_BY_CHOICE_RE.test(n);
}

/**
 * A última corrida saltou por falta de configuração/ligação e não há trabalho
 * feito há mais de `days` dias (desde o último OK que fez o trabalho; sem
 * nenhum, desde a primeira corrida registada). PURA.
 */
export function cronSkipProblem(
  last: { ok: boolean | null; error: string | null } | null,
  lastOkAt: number | null,
  firstRunAt: number | null,
  now: number,
  days = CRON_SKIP_PROBLEM_DAYS,
): boolean {
  if (!last || last.ok !== true || !isProblemSkip(last.error)) return false;
  const since = lastOkAt ?? firstRunAt;
  return since != null && now - since > days * 86_400_000;
}

/**
 * Resultado de uma resposta de cron. PURA.
 *  - falha: HTTP não-2xx, `ok:false`, `status:"failed"`, `stepErrors[]` ou
 *    `errors[]` não vazios (estes últimos só sem `ok:true` explícito);
 *  - mensagem de erro: `error` → `reason` → `errors[]`/`stepErrors[]`;
 *  - sucesso com nota: `skipped` (+ `reason`) ou `warnings[]` não vazios ficam
 *    em `note` (a corrida é verde, mas não fica em silêncio).
 * `errors[]` com `ok:true` explícito são erros de itens individuais (ex.: um
 * email que falhou e se repete) → vão para a nota, não tornam a corrida
 * vermelha; sem `ok` explícito contam como falha.
 */
export function cronOutcome(httpStatus: number, body: unknown): { ok: boolean; error: string | null; note?: string | null } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const httpOk = httpStatus >= 200 && httpStatus < 300;
  const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => x != null && x !== "").map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : []);
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const steps = strList(b?.stepErrors);
  const errors = strList(b?.errors);
  const warnings = strList(b?.warnings);
  const reason = str(b?.reason);
  const bodyFailed = !!b && (b.ok === false || b.status === "failed");
  const errorsFail = errors.length > 0 && b?.ok !== true;
  const ok = httpOk && !bodyFailed && steps.length === 0 && !errorsFail;
  if (ok) {
    const parts: string[] = [];
    const skipped = b?.skipped != null && b.skipped !== false ? (typeof b.skipped === "string" ? b.skipped : "sim") : b?.status === "skipped" ? "sim" : null;
    if (skipped) parts.push(`saltado: ${skipped}${reason ? ` — ${reason}` : ""}`);
    else if (reason) parts.push(reason);
    if (errors.length) parts.push(`${errors.length} erro(s) de itens: ${errors.slice(0, 3).join(" | ")}`);
    if (warnings.length) parts.push(`${warnings.length} aviso(s): ${warnings.slice(0, 3).join(" | ")}`);
    return parts.length ? { ok: true, error: null, note: parts.join(" · ").slice(0, 1000) } : { ok: true, error: null };
  }
  // daily-ops: a recolha correu, mas passos de manutenção falharam → falha.
  const msg = str(b?.error) ?? (steps.length ? steps.join(" | ") : null) ?? reason ?? (errors.length ? errors.join(" | ") : null)
    ?? `HTTP ${httpStatus}${bodyFailed ? " (ok:false)" : ""}`;
  return { ok: false, error: msg.slice(0, 1000) };
}

// ─── Preferências de notificação (por pessoa) ───────────────────────────────
// O catálogo, as regras de quem recebe e as preferências vivem em
// shared/notificationRouting.ts; aqui fica só a vista compatível.

export interface NotificationKind {
  kind: string;
  label: string;
  description: string;
  /** Obrigatória: não se pode silenciar (pede ação/confirmação). */
  required?: boolean;
}

export const NOTIFICATION_KINDS: readonly NotificationKind[] = NOTIFICATION_KIND_DEFS.map((d) => ({
  kind: d.kind, label: d.label, description: d.description, ...("mandatory" in d && d.mandatory ? { required: true } : {}),
}));

export { notificationPrefsSchema, parseNotificationPrefs, wantsNotification, type NotificationPrefs } from "./notificationRouting";
