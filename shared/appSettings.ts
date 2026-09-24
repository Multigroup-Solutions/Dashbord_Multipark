/**
 * Definições da aplicação (página /definicoes) — regras PURAS, partilhadas
 * entre servidor (validação ao gravar) e cliente (validação no formulário).
 *
 *  - SETTINGS: definições editáveis (chave → schema zod + valor por omissão);
 *  - AUTOMATION_FLAGS: interruptores das automações que podem ser sobrepostos
 *    na BD (o resto das env vars NUNCA é sobreposto — ex.: INPROCESS_SCHEDULERS);
 *  - CRON_JOBS: os /api/cron/* agendados pelo GitHub Actions e o intervalo
 *    esperado de cada um (para detetar crons parados);
 *  - NOTIFICATION_KINDS: tipos de notificação na app que cada pessoa pode
 *    silenciar no seu Perfil.
 */
import { z } from "zod";

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

export type SettingGroup = "financeiro" | "sla" | "emails" | "disponibilidade";

export interface SettingDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  schema: S;
  defaultValue: z.input<S>;
  /** Onde o valor é usado; "store" = só guardado/mostrado (ainda não ligado ao código). */
  wiring: "live" | "store";
}

function def<S extends z.ZodTypeAny>(d: SettingDef<S>): SettingDef<S> {
  return d;
}

export const SETTINGS = {
  "finance.vat": def({
    key: "finance.vat",
    group: "financeiro",
    label: "IVA",
    description: "Taxa de IVA por data de efeito. Por agora só fica registada — os cálculos usam a constante do código (23%).",
    schema: rateScheduleSchema,
    defaultValue: [{ rate: 0.23, from: "2011-01-01" }],
    wiring: "store",
  }),
  "finance.tsu": def({
    key: "finance.tsu",
    group: "financeiro",
    label: "TSU (entidade patronal)",
    description: "Taxa Social Única a cargo da empresa, por data de efeito. Por agora só fica registada — os cálculos usam a constante do código (23,75%).",
    schema: rateScheduleSchema,
    defaultValue: [{ rate: 0.2375, from: "2011-01-01" }],
    wiring: "store",
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
    description: "Referência do prazo dos perdidos e achados. Por agora só fica registado.",
    schema: z.number({ error: "Indica um número de dias." }).int("Número inteiro de dias.").min(1, "Mínimo 1 dia.").max(90, "Máximo 90 dias."),
    defaultValue: 7,
    wiring: "store",
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
  "availability.assigneeEmail": def({
    key: "availability.assigneeEmail",
    group: "disponibilidade",
    label: "Responsável pelas disponibilidades a confirmar",
    description: "Email da pessoa a quem são atribuídas as tarefas \"Disponibilidade a confirmar\". Vazio = usa AVAILABILITY_TASK_ASSIGNEE_EMAIL.",
    schema: z.union([z.literal(""), emailSchema]),
    defaultValue: "",
    wiring: "live",
  }),
} as const;

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

// ─── Interruptores das automações ───────────────────────────────────────────

export interface AutomationFlag {
  name: string;
  label: string;
  description: string;
}

export const AUTOMATION_FLAGS: readonly AutomationFlag[] = [
  { name: "EXTRAS_AUTOMATION", label: "Automação dos extras", description: "Pedido de disponibilidade à quinta, lembrete ao sábado, aviso de escala e alerta de cobertura (cron horário)." },
  { name: "LEAD_REMINDERS", label: "Lembretes das leads de extras", description: "Lembretes automáticos às leads que ainda não responderam." },
  { name: "LEAD_AUTO_REPLY", label: "Resposta automática às leads", description: "Envia o link da candidatura às leads novas." },
  { name: "TASKS_AUTOMATION", label: "Automação das tarefas", description: "Checklists do dia e avisos de atraso/conclusão." },
  { name: "CASE_REMINDERS", label: "Lembretes de SLA dos casos", description: "Avisa quando ocorrências/perdidos passam do prazo." },
  { name: "COMPLAINT_AUTO_ACK", label: "Aviso de receção das reclamações", description: "Responde automaticamente ao cliente quando chega uma reclamação por email." },
  { name: "HANDOVER_EMAIL", label: "Email da passagem de turno", description: "Envia a passagem de turno por email aos team leaders." },
  { name: "HANDOVER_REMINDERS", label: "Lembretes da passagem de turno", description: "Lembra quem ainda não entregou/confirmou a passagem." },
  { name: "TRAINING_REMINDERS", label: "Lembretes da formação", description: "Avisa quem tem formação por concluir." },
  { name: "TRAINING_BLOCKS_ESCALA", label: "Formação bloqueia a escala", description: "Quem tem formação obrigatória em atraso não entra na escala." },
];

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

// ─── Crons (GitHub Actions → /api/cron/*) ───────────────────────────────────

export interface CronJob {
  name: string;
  label: string;
  /** Intervalo esperado entre corridas (min); `null` = sem agenda fixa. */
  intervalMinutes: number | null;
  workflow: string;
}

export const CRON_JOBS: readonly CronJob[] = [
  { name: "multipark-deliveries", label: "Fila do webhook Multipark", intervalMinutes: 5, workflow: "multipark-deliveries.yml" },
  { name: "google-business", label: "Críticas Google (Business Profile)", intervalMinutes: 10, workflow: "google-business-reviews.yml" },
  { name: "multipark-sync", label: "Sincronização de reservas (recente)", intervalMinutes: 60, workflow: "multipark-cron.yml" },
  { name: "extras-auto", label: "Automação dos extras", intervalMinutes: 60, workflow: "multipark-cron.yml" },
  { name: "identity-sweep", label: "Ligações funcionário ↔ utilizador", intervalMinutes: 60, workflow: "multipark-cron.yml" },
  { name: "email-inbound", label: "Emails recebidos (IMAP)", intervalMinutes: 60, workflow: "multipark-cron.yml" },
  { name: "multipark-future", label: "Sincronização de reservas (futuras)", intervalMinutes: 120, workflow: "multipark-cron.yml" },
  { name: "daily-ops", label: "Manutenção diária + recolha GPS", intervalMinutes: 1440, workflow: "multipark-cron.yml" },
  { name: "google-ads", label: "Google Ads", intervalMinutes: 1440, workflow: "multipark-cron.yml" },
  { name: "meta-ads", label: "Meta Ads", intervalMinutes: 1440, workflow: "multipark-cron.yml" },
];

const CRON_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** "/multipark-sync" ou "/api/cron/multipark-sync" → "multipark-sync"; `null` se inválido. PURA. */
export function cronNameFromPath(path: string): string | null {
  const seg = String(path ?? "").replace(/^\/api\/cron/, "").replace(/^\/+/, "").split(/[/?#]/)[0] ?? "";
  return CRON_NAME.test(seg) ? seg : null;
}

/** O GitHub Actions atrasa os crons (às vezes muito): nunca menos de 30 min de folga. */
export const CRON_MIN_STALE_MINUTES = 30;

/** Limite (min) sem corridas a partir do qual o cron é "parado": 2× o intervalo. */
export function staleThresholdMinutes(intervalMinutes: number): number {
  return Math.max(2 * intervalMinutes, CRON_MIN_STALE_MINUTES);
}

export type CronHealth = "ok" | "failed" | "stale" | "never" | "running" | "unscheduled";

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

/** Resultado de uma resposta de cron: 2xx e sem `ok:false` / `status:"failed"`. PURA. */
export function cronOutcome(httpStatus: number, body: unknown): { ok: boolean; error: string | null } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const httpOk = httpStatus >= 200 && httpStatus < 300;
  const bodyFailed = !!b && (b.ok === false || b.status === "failed");
  const ok = httpOk && !bodyFailed;
  if (ok) {
    const steps = Array.isArray(b?.stepErrors) ? (b!.stepErrors as unknown[]).filter(Boolean) : [];
    // daily-ops: a recolha correu, mas passos de manutenção falharam → falha.
    if (steps.length) return { ok: false, error: steps.map(String).join(" | ").slice(0, 1000) };
    return { ok: true, error: null };
  }
  const msg = typeof b?.error === "string" && b.error ? b.error : `HTTP ${httpStatus}${bodyFailed ? " (ok:false)" : ""}`;
  return { ok: false, error: msg.slice(0, 1000) };
}

// ─── Preferências de notificação (por pessoa) ───────────────────────────────

export interface NotificationKind {
  kind: string;
  label: string;
  description: string;
  /** Obrigatória: não se pode silenciar (pede ação/confirmação). */
  required?: boolean;
}

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  { kind: "task", label: "Tarefas", description: "Tarefas atribuídas, atrasadas ou concluídas." },
  { kind: "handover", label: "Passagem de turno", description: "Passagens entregues e lembretes (pede \"Recebi\").", required: true },
  { kind: "extras", label: "Extras e escala", description: "Falta de condutores, disponibilidades, avisos da escala." },
  { kind: "complaint", label: "Reclamações", description: "Reclamações novas." },
  { kind: "case_sla", label: "Casos em atraso", description: "Ocorrências e perdidos fora do prazo." },
  { kind: "driver_application", label: "Candidaturas", description: "Candidaturas novas \"Be a Driver\"." },
  { kind: "training", label: "Formação", description: "Formação por concluir e promoções." },
];

export const notificationPrefsSchema = z.object({
  muted: z.array(z.string().max(32)).max(50).default([]),
});
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

/** Normaliza as preferências guardadas (JSON cru ou objeto) — nunca lança. PURA. */
export function parseNotificationPrefs(raw: unknown): NotificationPrefs {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { v = null; }
  }
  const r = notificationPrefsSchema.safeParse(v ?? {});
  if (!r.success) return { muted: [] };
  const allowed = new Set(NOTIFICATION_KINDS.filter((k) => !k.required).map((k) => k.kind));
  return { muted: Array.from(new Set(r.data.muted.filter((k) => allowed.has(k)))) };
}

/** A pessoa quer receber notificações deste tipo? (obrigatórias e tipos desconhecidos → sim). PURA. */
export function wantsNotification(prefs: NotificationPrefs, kind: string | null | undefined): boolean {
  const k = String(kind ?? "info");
  const def = NOTIFICATION_KINDS.find((x) => x.kind === k);
  if (!def || def.required) return true;
  return !prefs.muted.includes(k);
}
