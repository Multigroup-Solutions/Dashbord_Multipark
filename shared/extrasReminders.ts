/**
 * Extras-dia — lembretes antes da proposta e da confirmação (plano MPV F7,
 * §6.1). PURO: regras partilhadas pelo servidor (trabalho `extras-reminders`),
 * pelas Definições e pelos testes.
 *
 *  - 30 min antes da proposta automática (omissão 10:30, para a proposta das
 *    11:00): "às 11:00 sai a proposta de amanhã; faltam N respostas";
 *  - 30 min antes da confirmação automática (omissão 14:30, para as 15:00):
 *    "às 15:00 a escala de amanhã é confirmada e os extras avisados" com o
 *    estado do dia (propostos, faltas, mexido à mão, suspenso, acrescentados).
 *
 * D4c (por decidir pelo Jorge): a quem vão e em que dias, por cidade. Fica
 * numa definição (`extras.reminderRecipients`): papéis, dias da semana (do dia
 * em que o lembrete sai) e contas a juntar. Omissão: TL e supervisor da
 * cidade, todos os dias.
 */
import { z } from "zod";
import type { Role } from "./access";

/** Os lembretes saem esta antecedência antes da hora da proposta/confirmação (min). */
export const REMINDER_LEAD_MIN = 30;

export type ReminderSlot = "propose" | "confirm";
export const REMINDER_SLOT_LABELS: Record<ReminderSlot, string> = {
  propose: "antes da proposta automática",
  confirm: "antes da confirmação automática",
};

export const REMINDER_CITIES = ["lisbon", "porto", "faro"] as const;
export type ReminderCity = (typeof REMINDER_CITIES)[number];

/** Papéis que podem receber (os que veem o Extras-dia na matriz de acessos). */
export const REMINDER_ROLES = ["team_leader", "supervisor", "frontoffice", "backoffice", "admin"] as const satisfies readonly Role[];
export type ReminderRole = (typeof REMINDER_ROLES)[number];
export const REMINDER_ROLE_LABELS: Record<ReminderRole, string> = {
  team_leader: "Team leader", supervisor: "Supervisor", frontoffice: "Front office", backoffice: "Back office", admin: "Admin",
};
/** 1 = segunda … 7 = domingo (ISO). */
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const WEEKDAY_SHORT_PT: Record<number, string> = { 1: "seg", 2: "ter", 3: "qua", 4: "qui", 5: "sex", 6: "sáb", 7: "dom" };

const cityRuleSchema = z.object({
  roles: z.array(z.enum(REMINDER_ROLES, { error: "Papel inválido." })).max(REMINDER_ROLES.length)
    .transform((r) => Array.from(new Set(r))),
  days: z.array(z.number({ error: "Dias: números de 1 (segunda) a 7 (domingo)." }).int().min(1, "Dias: 1 (segunda) a 7 (domingo).").max(7, "Dias: 1 (segunda) a 7 (domingo)."))
    .max(7).transform((d) => Array.from(new Set(d)).sort((a, b) => a - b)),
  userIds: z.array(z.number({ error: "Contas: só números (ids das contas)." }).int().positive()).max(20, "No máximo 20 contas por cidade.")
    .transform((ids) => Array.from(new Set(ids))),
}).strict();
export type ReminderCityRule = z.infer<typeof cityRuleSchema>;

export const reminderRecipientsSchema = z.object({
  lisbon: cityRuleSchema,
  porto: cityRuleSchema,
  faro: cityRuleSchema,
}).strict();
export type ReminderRecipients = z.infer<typeof reminderRecipientsSchema>;

const ALL_DAYS = [...ISO_WEEKDAYS];
export const DEFAULT_REMINDER_RECIPIENTS: ReminderRecipients = {
  lisbon: { roles: ["team_leader", "supervisor"], days: ALL_DAYS, userIds: [] },
  porto: { roles: ["team_leader", "supervisor"], days: ALL_DAYS, userIds: [] },
  faro: { roles: ["team_leader", "supervisor"], days: ALL_DAYS, userIds: [] },
};

/** Dia da semana ISO (1 = segunda … 7 = domingo) de uma data AAAA-MM-DD. PURA. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T12:00:00Z`);
  const w = d.getUTCDay();
  return w === 0 ? 7 : w;
}

/** O lembrete desta cidade sai hoje (`today` = dia de Lisboa em que sai)? PURA. */
export function reminderAppliesOn(rule: ReminderCityRule | null | undefined, today: string): boolean {
  if (!rule) return false;
  if (!rule.roles.length && !rule.userIds.length) return false;
  return rule.days.includes(isoWeekday(today));
}

/** Filtro dos destinatários: os papéis escolhidos ou as contas juntadas. PURA. */
export function reminderRecipientFilter(rule: ReminderCityRule): (c: { id: number; role: string }) => boolean {
  const roles = new Set<string>(rule.roles);
  const ids = new Set(rule.userIds);
  return (c) => roles.has(c.role) || ids.has(c.id);
}

/** "seg, ter e qua" / "todos os dias". PURA. */
export function describeDays(days: readonly number[]): string {
  const d = Array.from(new Set(days)).filter((x) => x >= 1 && x <= 7).sort((a, b) => a - b);
  if (d.length === 7) return "todos os dias";
  if (!d.length) return "nenhum dia";
  const names = d.map((x) => WEEKDAY_SHORT_PT[x]);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

/** "TL e supervisor (todos os dias)" — para o resumo nas Definições. PURA. */
export function describeReminderRule(rule: ReminderCityRule): string {
  const who = rule.roles.map((r) => REMINDER_ROLE_LABELS[r as ReminderRole] ?? r);
  if (rule.userIds.length) who.push(`${rule.userIds.length} conta(s) juntada(s)`);
  if (!who.length) return "ninguém";
  return `${who.join(", ")} (${describeDays(rule.days)})`;
}

const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export interface DueReminder {
  slot: ReminderSlot;
  /** Dia da escala a que se refere (amanhã). */
  date: string;
  /** Hora da proposta/confirmação a que o lembrete se refere ("11:00"). */
  at: string;
}

/**
 * Lembretes na altura (hora de Lisboa): da hora − 30 min até à própria hora
 * (o agendador corre de 15 em 15 min — uma corrida perdida ainda apanha a
 * seguinte; o servidor só manda uma vez por dia, cidade e lembrete). O da
 * confirmação só com a confirmação automática ligada. PURA.
 */
export function remindersDue(
  now: { date: string; minutes: number },
  s: { autoProposeAtMin: number; autoConfirm: boolean; autoConfirmAtMin: number },
): DueReminder[] {
  const out: DueReminder[] = [];
  const within = (atMin: number) => now.minutes >= atMin - REMINDER_LEAD_MIN && now.minutes < atMin;
  const tomorrow = addDays(now.date, 1);
  if (within(s.autoProposeAtMin)) out.push({ slot: "propose", date: tomorrow, at: hhmm(s.autoProposeAtMin) });
  if (s.autoConfirm && within(s.autoConfirmAtMin)) out.push({ slot: "confirm", date: tomorrow, at: hhmm(s.autoConfirmAtMin) });
  return out;
}

/** Hora (min) dos lembretes, para a ajuda e para o ecrã. PURA. */
export function reminderAtMinutes(atMin: number): number {
  return Math.max(0, atMin - REMINDER_LEAD_MIN);
}

export interface ReminderContext {
  slot: ReminderSlot;
  cityLabel: string;
  /** "qui 16/10" */
  dayLabel: string;
  at: string;
  /** Estado da escala desse dia ('none' = sem proposta ainda). */
  status: "none" | "proposing" | "proposed" | "confirmed" | "hold";
  holdAuto: boolean;
  manual: boolean;
  /** Regra do D4b em uso (para o texto do lembrete das 14:30). */
  manualMode: "confirm" | "skip_notify" | "if_older_30m";
  proposed: number;
  confirmed: number;
  /** "faltam 2 condutores entre 14h–17h" … (já em texto). */
  gaps: string[];
  /** Extras sem resposta à disponibilidade para esse dia (só no da proposta). */
  noAnswer: number | null;
  /** Acrescentados pelo "Completar com quem respondeu" (nomes). */
  added: string[];
}

/** Título e texto do lembrete. PURA. */
export function reminderMessage(c: ReminderContext): { title: string; body: string } {
  const lines: string[] = [];
  if (c.slot === "propose") {
    const title = `Extras-dia ${c.cityLabel}: proposta de ${c.dayLabel} às ${c.at}`;
    if (c.manual || (c.status !== "none" && c.status !== "proposing")) {
      lines.push(`O dia ${c.dayLabel} já tem ${c.status === "confirmed" ? "escala confirmada" : c.status === "proposed" ? "proposta" : "mudanças feitas à mão"}: a proposta automática das ${c.at} não lhe mexe.`);
    } else {
      lines.push(`Às ${c.at} sai a proposta automática da escala de ${c.dayLabel} com os extras que marcaram disponibilidade.`);
    }
    if (c.noAnswer != null && c.noAnswer > 0) lines.push(`${c.noAnswer === 1 ? "Falta 1 extra responder" : `Faltam ${c.noAnswer} extras responder`} à disponibilidade — carrega em "Pedir disponibilidade a quem não respondeu" (Extras-dia → Dia).`);
    else if (c.noAnswer === 0) lines.push("Todos os extras da cidade já responderam à disponibilidade.");
    lines.push("Se quiseres pôr ou tirar alguém, faz antes da proposta: a partir daí, o que mudares à mão manda.");
    return { title, body: lines.join("\n") };
  }
  const title = `Extras-dia ${c.cityLabel}: confirmação de ${c.dayLabel} às ${c.at}`;
  if (c.status === "confirmed") lines.push(`A escala de ${c.dayLabel} já está confirmada (${c.confirmed} condutor(es)).`);
  else if (c.status !== "proposed") lines.push(`Ainda não há proposta para ${c.dayLabel}: às ${c.at} não se confirma nem se avisa ninguém. Faz a escala à mão em Extras-dia.`);
  else if (c.holdAuto) lines.push(`O envio automático de ${c.dayLabel} está suspenso: às ${c.at} não se confirma nem se avisa ninguém.`);
  else {
    lines.push(`Às ${c.at} a escala de ${c.dayLabel} é confirmada e os extras são avisados (WhatsApp e email): ${c.proposed} proposto(s)${c.confirmed ? `, ${c.confirmed} já confirmado(s)` : ""}.`);
    if (c.manual) {
      lines.push(c.manualMode === "skip_notify"
        ? "O dia foi mexido à mão: com a regra em uso, não é confirmado sozinho — confirma tu em Extras-dia."
        : c.manualMode === "if_older_30m"
          ? "O dia foi mexido à mão: só é confirmado sozinho 30 min depois da última mudança."
          : "O dia foi mexido à mão: é confirmado na mesma, como está.");
    }
  }
  if (c.added.length) lines.push(`Acrescentados com quem respondeu entretanto: ${c.added.join(", ")}.`);
  if (c.gaps.length) lines.push(`Ainda: ${c.gaps.join("; ")}.`);
  lines.push("Tens até lá para ver e mexer (Extras-dia → Dia).");
  return { title, body: lines.join("\n") };
}
