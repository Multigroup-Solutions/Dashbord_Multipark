/**
 * Leads de extras — regras PURAS partilhadas entre o servidor (cron, importação,
 * métricas) e a página (faixa "Atenção", funil). Sem BD, testadas em
 * server/extraLeadsFunnel.test.ts.
 *
 *  - estados e transições (incl. `replied` = "Respondeu");
 *  - deduplicação de um contacto novo contra os leads existentes;
 *  - SLA: `new` sem contacto há >24h, `contacted` sem resposta há >3 dias;
 *  - lembrete automático (reenvio do template, no máximo 2 envios por lead);
 *  - agregação do funil (origem × cidade × semana ISO + medianas).
 */

export const LEAD_STATUSES = ["new", "contacted", "replied", "converted", "declined"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_SOURCES = ["manual", "site", "email"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  site: "Site",
  email: "Email",
};

export const LEAD_SLA = {
  /** `new` sem nenhum contacto há mais de X horas. */
  newNoContactHours: 24,
  /** `contacted` sem resposta há mais de X dias → atenção + lembrete automático. */
  contactedNoReplyDays: 3,
  /** Máximo de templates enviados a um lead (1.º contacto + 1 lembrete). */
  maxSends: 2,
  /** Lembretes só de segunda a sábado, entre estas horas de Lisboa. */
  reminderFromHour: 10,
  reminderToHour: 19,
} as const;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 'YYYY-MM-DD HH:MM:SS' da BD (UTC) ou ISO → ms; null se vazio/ilegível. */
export function parseDbTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z");
  return Number.isNaN(ms) ? null : ms;
}

// ─── Estados ────────────────────────────────────────────────────────────────

/** Uma mensagem recebida só passa a "Respondeu" quem ainda está no início do funil. */
export function canAutoMarkReplied(status: string): boolean {
  return status === "new" || status === "contacted";
}

/**
 * Transições de estado feitas à mão (edição, mudança em lote). "Convertido"
 * só pelo botão Converter (cria/liga a ficha); um lead com ficha fica
 * convertido. "Respondeu" pode ser marcado à mão (ex.: respondeu por telefone).
 */
export function manualStatusError(current: { status: string; employeeId: number | null }, next: string): string | null {
  if (next === current.status) return null;
  if (!(LEAD_STATUSES as readonly string[]).includes(next)) return `Estado desconhecido: ${next}`;
  if (next === "converted") return "Para marcar como convertido usa o botão Converter (cria ou liga a ficha do extra).";
  if (current.employeeId) return "Este lead já tem ficha de extra — o estado fica Convertido.";
  return null;
}

// ─── Deduplicação ───────────────────────────────────────────────────────────

export interface LeadIdentity {
  id: number;
  phoneE164: string | null;
  email: string | null;
}

/**
 * Lead existente com o mesmo telemóvel (E.164) ou, na falta, o mesmo email.
 * O telemóvel ganha: é a chave do WhatsApp. Emails comparados sem maiúsculas.
 */
export function matchExistingLead<T extends LeadIdentity>(
  candidate: { phoneE164: string | null; email: string | null },
  leads: T[],
): T | null {
  if (candidate.phoneE164) {
    const byPhone = leads.find((l) => l.phoneE164 === candidate.phoneE164);
    if (byPhone) return byPhone;
  }
  const email = candidate.email?.trim().toLowerCase();
  if (email) {
    const byEmail = leads.find((l) => l.email?.trim().toLowerCase() === email);
    if (byEmail) return byEmail;
  }
  return null;
}

/** Remetentes automáticos (portais de emprego, notificações) que não são pessoas. */
export function isAutomatedSender(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  return (
    /(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|alerts?|bounce[s]?)([._+-]|@)/.test(e) ||
    /@(.*\.)?(multipark\.pt|multidriver\.pt)$/.test(e)
  );
}

// ─── SLA / lembretes ────────────────────────────────────────────────────────

export interface SlaLead {
  id: number;
  status: string;
  createdAt: string;
  lastContactedAt: string | null;
  lastInboundAt?: string | null;
  contactCount: number;
  phoneE164?: string | null;
}

export type LeadAttention = "new_stale" | "contacted_stale";

/** Precisa de atenção? `new` sem contacto >24h, `contacted` sem resposta >3 dias. */
export function leadAttention(lead: SlaLead, nowMs: number): LeadAttention | null {
  if (lead.status === "new") {
    const since = parseDbTime(lead.lastContactedAt) ?? parseDbTime(lead.createdAt);
    return since != null && nowMs - since > LEAD_SLA.newNoContactHours * HOUR ? "new_stale" : null;
  }
  if (lead.status === "contacted") {
    const contacted = parseDbTime(lead.lastContactedAt) ?? parseDbTime(lead.createdAt);
    if (contacted == null) return null;
    const inbound = parseDbTime(lead.lastInboundAt ?? null);
    if (inbound != null && inbound >= contacted) return null; // respondeu depois do contacto
    return nowMs - contacted > LEAD_SLA.contactedNoReplyDays * DAY ? "contacted_stale" : null;
  }
  return null;
}

export function selectSlaLeads<T extends SlaLead>(leads: T[], nowMs: number): { newStale: T[]; contactedStale: T[] } {
  const newStale: T[] = [];
  const contactedStale: T[] = [];
  for (const l of leads) {
    const a = leadAttention(l, nowMs);
    if (a === "new_stale") newStale.push(l);
    else if (a === "contacted_stale") contactedStale.push(l);
  }
  return { newStale, contactedStale };
}

/**
 * Leads a quem o cron reenvia o template: `contacted`, com telemóvel, sem
 * resposta há mais de 3 dias e com menos de 2 envios no total.
 */
export function selectReminderLeads<T extends SlaLead>(leads: T[], nowMs: number): T[] {
  return leads.filter(
    (l) =>
      !!l.phoneE164 &&
      l.contactCount > 0 &&
      l.contactCount < LEAD_SLA.maxSends &&
      leadAttention(l, nowMs) === "contacted_stale",
  );
}

/** Hora de Lisboa em que se pode mandar um lembrete (seg–sáb, 10h–19h). */
export function isLeadReminderTime(clock: { dow: number; hour: number }): boolean {
  return clock.dow >= 1 && clock.dow <= 6 && clock.hour >= LEAD_SLA.reminderFromHour && clock.hour < LEAD_SLA.reminderToHour;
}

// ─── Funil ──────────────────────────────────────────────────────────────────

/** Semana ISO ("2026-W39") de um instante (UTC). */
export function isoWeekKey(ms: number): string {
  const d = new Date(ms);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = day.getUTCDay() || 7; // segunda = 1 … domingo = 7
  day.setUTCDate(day.getUTCDate() + 4 - dow); // quinta-feira da mesma semana
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / DAY + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export interface FunnelLeadRow {
  source: string;
  projectId: number | null;
  status: string;
  createdAt: string;
  contactCount: number;
  firstContactedAt: string | null;
  lastContactedAt: string | null;
  lastInboundAt: string | null;
  convertedAt: string | null;
}

export interface FunnelCounts {
  created: number;
  contacted: number;
  replied: number;
  converted: number;
}

export interface FunnelCell extends FunnelCounts {
  source: string;
  city: string;
  week: string;
}

export interface FunnelResult {
  totals: FunnelCounts;
  bySource: (FunnelCounts & { source: string })[];
  rows: FunnelCell[];
  /** Mediana (horas) entre a criação e o 1.º contacto. */
  medianHoursToFirstContact: number | null;
  /** Mediana (dias) entre a criação e a conversão. */
  medianDaysToConversion: number | null;
}

/**
 * Etapas ATINGIDAS por um lead (cumulativas): um convertido conta também como
 * contactado/respondeu se isso aconteceu; um `replied` marcado à mão conta
 * como contactado.
 */
export function leadStages(l: FunnelLeadRow): { contacted: boolean; replied: boolean; converted: boolean } {
  const converted = l.status === "converted";
  const replied = l.status === "replied" || l.lastInboundAt != null;
  const contacted = replied || l.contactCount > 0 || l.lastContactedAt != null || l.status === "contacted";
  return { contacted, replied, converted };
}

const emptyCounts = (): FunnelCounts => ({ created: 0, contacted: 0, replied: 0, converted: 0 });

function addTo(c: FunnelCounts, s: ReturnType<typeof leadStages>): void {
  c.created++;
  if (s.contacted) c.contacted++;
  if (s.replied) c.replied++;
  if (s.converted) c.converted++;
}

/** Agrega os leads por origem × cidade × semana ISO (da criação). PURA. */
export function aggregateFunnel(leads: FunnelLeadRow[], cityName: (projectId: number | null) => string): FunnelResult {
  const totals = emptyCounts();
  const bySource = new Map<string, FunnelCounts>();
  const cells = new Map<string, FunnelCell>();
  const toContact: number[] = [];
  const toConvert: number[] = [];

  for (const l of leads) {
    const created = parseDbTime(l.createdAt);
    if (created == null) continue;
    const s = leadStages(l);
    const source = l.source || "manual";
    const city = cityName(l.projectId);
    const week = isoWeekKey(created);
    addTo(totals, s);
    if (!bySource.has(source)) bySource.set(source, emptyCounts());
    addTo(bySource.get(source)!, s);
    const key = `${source}|${city}|${week}`;
    if (!cells.has(key)) cells.set(key, { source, city, week, ...emptyCounts() });
    addTo(cells.get(key)!, s);

    const first = parseDbTime(l.firstContactedAt) ?? (l.contactCount === 1 ? parseDbTime(l.lastContactedAt) : null);
    if (first != null && first >= created) toContact.push((first - created) / HOUR);
    const conv = s.converted ? parseDbTime(l.convertedAt) : null;
    if (conv != null && conv >= created) toConvert.push((conv - created) / DAY);
  }

  const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
  return {
    totals,
    bySource: [...bySource.entries()]
      .map(([source, c]) => ({ source, ...c }))
      .sort((a, b) => b.created - a.created || a.source.localeCompare(b.source)),
    rows: [...cells.values()].sort(
      (a, b) => b.week.localeCompare(a.week) || a.source.localeCompare(b.source) || a.city.localeCompare(b.city),
    ),
    medianHoursToFirstContact: round1(median(toContact)),
    medianDaysToConversion: round1(median(toConvert)),
  };
}

/** % de `part` sobre `whole` (inteiro), ou null quando não há base. */
export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}
