/**
 * Extras-dia — lembretes 30 min antes da proposta e da confirmação automáticas
 * (plano MPV F7, §6.1; trabalho `extras-reminders` do agendador, de 15 em 15
 * min entre as 08h e as 23h).
 *
 * Interruptores: "Automação dos extras" (EXTRAS_AUTOMATION) e o próprio
 * EXTRAS_REMINDERS (desligado por omissão — avisa gente, e o D4c ainda não
 * está decidido). Desligado: não lê nada nem avisa ninguém.
 *
 * Quem recebe (D4c): Definições → Parâmetros → "Lembretes da escala: a quem e
 * em que dias" — papéis e contas por cidade, nos dias da semana escolhidos.
 * Um lembrete por dia, cidade e hora (reserva em extras_dia_alerts): correr
 * duas vezes, ou às 10:30 e outra vez às 10:45, nunca repete.
 */
import {
  DEFAULT_REMINDER_RECIPIENTS, REMINDER_CITIES, reminderAppliesOn, reminderMessage, reminderRecipientFilter, remindersDue,
  type ReminderCity, type ReminderRecipients,
} from "../shared/extrasReminders";
import { CITY_LABELS_PT, describeGap, effectiveManualEditMode, fmtDayPt, lisbonNow } from "../shared/extrasSchedule";
import type { LoadedScheduleSettings, ScheduleAlertKind, ScheduleState } from "./extrasSchedule";

export interface RemindersReport {
  ok: boolean;
  now: { date: string; minutes: number };
  skipped?: string;
  reason?: string;
  /** "propose:2026-10-16:lisbon (4 pessoa(s))" */
  sent: string[];
  /** Na altura mas sem lembrete: já enviado, dia da semana fora, ninguém escolhido. */
  notSent: string[];
  errors: string[];
}

export interface RemindersDeps {
  flagOn(name: string): Promise<boolean>;
  loadSettings(): Promise<LoadedScheduleSettings>;
  loadRules(): Promise<ReminderRecipients>;
  getState(date: string, city: ReminderCity): Promise<ScheduleState | null>;
  counts(date: string, city: ReminderCity): Promise<{ proposed: number; confirmed: number }>;
  noAnswer(date: string, city: ReminderCity): Promise<number>;
  completedNames(date: string, city: ReminderCity): Promise<string[]>;
  claim(a: { date: string; city: string; kind: ScheduleAlertKind; detail?: string | null }): Promise<boolean>;
  notify(input: import("./notify").NotifyInput): Promise<{ recipients: number[] }>;
  noteRecipients(a: { date: string; city: string; kind: ScheduleAlertKind }, recipients: number): Promise<void>;
}

async function loadReminderRules(): Promise<ReminderRecipients> {
  const { getSetting } = await import("./appSettings");
  const v = await getSetting("extras.reminderRecipients");
  return (v as ReminderRecipients | null) ?? DEFAULT_REMINDER_RECIPIENTS;
}

export const realReminderDeps: RemindersDeps = {
  flagOn: async (name) => (await import("./extrasSchedule")).scheduleFlagOn(name),
  loadSettings: async () => (await import("./extrasSchedule")).loadScheduleSettings(),
  loadRules: loadReminderRules,
  getState: async (date, city) => (await import("./extrasSchedule")).getScheduleState(date, city),
  counts: async (date, city) => (await import("./extrasSchedule")).countScheduleRows(date, city),
  noAnswer: async (date, city) => (await (await import("./extrasSchedule")).noAnswerTargets(date, city)).length,
  completedNames: async (date, city) => (await import("./extrasSchedule")).loadCompletedNames(date, city),
  claim: async (a) => (await import("./extrasSchedule")).claimScheduleAlert(a),
  notify: async (input) => (await import("./notify")).notify(input),
  noteRecipients: async (a, n) => {
    try {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (db) await db.execute(sql`UPDATE extras_dia_alerts SET recipients = ${n} WHERE assignmentDate = ${a.date} AND city = ${a.city} AND kind = ${a.kind} AND alertKey = ''`);
    } catch { /* registo */ }
  },
};

/**
 * Corre os lembretes que estão na altura (hora de Lisboa). Nunca lança: os
 * erros de uma cidade vão no relatório e não travam as outras.
 */
export async function runExtrasReminders(now: Date = new Date(), deps: RemindersDeps = realReminderDeps): Promise<RemindersReport> {
  const ln = lisbonNow(now);
  const report: RemindersReport = { ok: true, now: ln, sent: [], notSent: [], errors: [] };
  if (!(await deps.flagOn("EXTRAS_AUTOMATION"))) return { ...report, skipped: "off", reason: "Automação dos extras desligada (EXTRAS_AUTOMATION)" };
  if (!(await deps.flagOn("EXTRAS_REMINDERS"))) return { ...report, skipped: "off", reason: "Lembretes da escala desligados (EXTRAS_REMINDERS)" };
  const settings = await deps.loadSettings();
  const due = remindersDue(ln, settings);
  // A regra do dia mexido à mão em vigor de facto (sem os avisos da escala, "não confirma e avisa" confirma).
  const manualMode = due.length ? effectiveManualEditMode(settings.manualEditAtConfirm, await deps.flagOn("EXTRAS_SCHEDULE_ALERTS").catch(() => false)) : settings.manualEditAtConfirm;
  if (!due.length) return report;
  const rules = await deps.loadRules();
  for (const r of due) {
    for (const city of REMINDER_CITIES) {
      const key = `${r.slot}:${r.date}:${city}`;
      const rule = rules[city];
      // D4c: só nos dias da semana escolhidos (o dia em que o lembrete sai) e com alguém escolhido.
      if (!reminderAppliesOn(rule, ln.date)) { report.notSent.push(`${key} (hoje não, ou ninguém escolhido)`); continue; }
      try {
        const kind: ScheduleAlertKind = r.slot === "propose" ? "reminder_propose" : "reminder_confirm";
        if (!(await deps.claim({ date: r.date, city, kind }))) { report.notSent.push(`${key} (já enviado)`); continue; }
        const [state, counts, added, noAnswer] = await Promise.all([
          deps.getState(r.date, city),
          deps.counts(r.date, city),
          r.slot === "confirm" ? deps.completedNames(r.date, city) : Promise.resolve([] as string[]),
          r.slot === "propose" ? deps.noAnswer(r.date, city).catch(() => null) : Promise.resolve(null),
        ]);
        const msg = reminderMessage({
          slot: r.slot, cityLabel: CITY_LABELS_PT[city], dayLabel: fmtDayPt(r.date), at: r.at,
          status: (state?.status ?? "none") as "none" | "proposing" | "proposed" | "confirmed" | "hold",
          holdAuto: !!state?.holdAuto, manual: !!state?.manual, manualMode,
          proposed: counts.proposed, confirmed: counts.confirmed,
          gaps: (state?.gaps ?? []).map(describeGap), noAnswer, added,
        });
        const out = await deps.notify({
          kind: "extras_reminder", city, title: msg.title, body: msg.body, link: "/extras-dia",
          entity: { type: "extras_reminder", id: key },
          recipientFilter: reminderRecipientFilter(rule),
          alsoUserIds: rule.userIds,
        });
        const n = out?.recipients?.length ?? 0;
        await deps.noteRecipients({ date: r.date, city, kind }, n);
        report.sent.push(`${key} (${n} pessoa(s))`);
      } catch (err: any) {
        report.errors.push(`${key}: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
  }
  report.ok = report.errors.length === 0;
  return report;
}
