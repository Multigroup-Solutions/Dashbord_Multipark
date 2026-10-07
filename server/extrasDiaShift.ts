/**
 * Extras-dia — indicador de pessoal (pedido 7) e "Avisar este turno"
 * (pedido 8), Jorge 7 out 2026. As regras são puras e partilhadas
 * (shared/extrasStaffing.ts, shared/shiftNotice.ts); aqui só se lê a BD e se
 * chamam os envios que já existem (que guardam 1 aviso por linha/versão/canal
 * em extras_dia_notifications — um segundo clique não reenvia).
 */
import { sql } from "drizzle-orm";
import { getDb, logActivity } from "./db";
import {
  CITY_LABELS_PT,
  addDaysIso,
  fmtDayPt,
  lisbonNow,
  type NotifyChannel,
} from "../shared/extrasSchedule";
import { staffingByHour, staffingGaps, type StaffingGap, type StaffingHour } from "../shared/extrasStaffing";
import {
  NOTICE_CHANNEL_LABELS,
  noticeOutcome,
  noticeStatusLabel,
  planShiftNotice,
  type NoticePerson,
  type NoticePlan,
  type NoticeRow,
} from "../shared/shiftNotice";
import { normalizePhoneE164 } from "../shared/phone";
import type { ScheduleCity } from "./extrasSchedule";

export type ShiftId = "morning" | "night";

function rowsOf(res: unknown): any[] {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
}
const inList = (ids: number[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

// ─── Indicador de pessoal ──────────────────────────────────────────────────

export interface StaffingReport {
  date: string;
  city: ScheduleCity;
  hours: StaffingHour[];
  gaps: StaffingGap[];
  /** Nomes dos disponíveis por escalar (id → nome), para o detalhe por hora. */
  people: { id: number; name: string; hours: string }[];
  /** Previsão incompleta (o aviso pode estar abaixo do real). */
  incomplete: string | null;
}

/**
 * Por hora: precisas N (além do TL) · escalados M · disponíveis por escalar K,
 * e as faltas ("faltam escalar" vs "falta gente"). Os disponíveis são os
 * mesmos que a proposta automática pode escolher (loadEligibleExtras), com a
 * mesma leitura da disponibilidade (dia operacional, semântica de calendário).
 */
export async function getStaffingReport(date: string, city: ScheduleCity): Promise<StaffingReport> {
  const { getExtrasDiaForecast, listAssignments } = await import("./extrasDia");
  const { forecastIncompleteReason, loadEligibleExtras, candidateWindows } = await import("./extrasSchedule");
  const [forecast, dayRows, rows, eligible] = await Promise.all([
    getExtrasDiaForecast(addDaysIso(date, -1), city),
    listAssignments(date), // todas as cidades: quem já está no dia não está "por escalar"
    listAssignments(date, city),
    loadEligibleExtras(date, city),
  ]);
  const needed = forecast.hourly.map((h) => h.driversNeeded);
  const alreadyScheduled = new Set(dayRows.map((a) => a.employeeId).filter((x): x is number => x != null));
  const candidates = eligible.map((c) => ({ id: c.id, name: c.fullName, windows: candidateWindows(c) }));
  const hours = staffingByHour({ needed, rows, candidates, alreadyScheduled });
  const used = new Set(hours.flatMap((h) => h.availableIds));
  return {
    date,
    city,
    hours,
    gaps: staffingGaps(hours, candidates),
    people: eligible.filter((c) => used.has(c.id)).map((c) => ({ id: c.id, name: c.fullName, hours: c.availability?.hours ?? "" })),
    incomplete: forecastIncompleteReason(forecast),
  };
}

// ─── Avisar este turno ─────────────────────────────────────────────────────

function whatsappConfigured(): boolean {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

async function emailConfigured(): Promise<boolean> {
  const { isEmailSendConfigured } = await import("./mail/systemMail");
  return isEmailSendConfigured();
}

async function loadShiftRows(date: string, city: ScheduleCity, shift: ShiftId): Promise<(NoticeRow & { city: string })[]> {
  const db = await getDb();
  if (!db) return [];
  const res = await db.execute(sql`
    SELECT id, version, employeeId, personName, status, startHour, endHour, sentHomeHour, city
      FROM extras_dia_assignments
     WHERE assignmentDate = ${date} AND city = ${city} AND shift = ${shift}
     ORDER BY startHour, id`);
  return rowsOf(res).map((r) => ({
    id: Number(r.id),
    version: Number(r.version ?? 1),
    employeeId: r.employeeId == null ? null : Number(r.employeeId),
    personName: String(r.personName ?? ""),
    status: String(r.status ?? "confirmed"),
    startHour: Number(r.startHour),
    endHour: Number(r.endHour),
    sentHomeHour: r.sentHomeHour == null ? null : Number(r.sentHomeHour),
    city: String(r.city),
  }));
}

async function loadNoticePeople(ids: number[]): Promise<Map<number, NoticePerson>> {
  const out = new Map<number, NoticePerson>();
  const db = await getDb();
  if (!db || !ids.length) return out;
  const res = await db.execute(sql`
    SELECT id, fullName, email, personalEmail, phone, position, isActive, noAutoEmail, noAutoWhatsapp
      FROM employees WHERE id IN (${inList(ids)})`);
  let optedOut = new Set<string>();
  try {
    const { optedOutPhones } = await import("./whatsappStore");
    optedOut = await optedOutPhones(db as any);
  } catch { /* sem tabela do WhatsApp: ninguém marcado */ }
  for (const r of rowsOf(res)) {
    const phoneE164 = r.phone ? normalizePhoneE164(String(r.phone)) : null;
    out.set(Number(r.id), {
      id: Number(r.id),
      fullName: String(r.fullName ?? ""),
      isExtra: String(r.position ?? "") === "extra" && Number(r.isActive) === 1,
      email: r.email ? String(r.email) : null,
      personalEmail: r.personalEmail ? String(r.personalEmail) : null,
      phoneE164,
      noAutoEmail: Number(r.noAutoEmail ?? 0) === 1,
      noAutoWhatsapp: Number(r.noAutoWhatsapp ?? 0) === 1,
      whatsappOptedOut: !!phoneE164 && optedOut.has(phoneE164),
    });
  }
  return out;
}

/** Avisos antigos (extras_dia_notices) que ainda valem para a versão atual. */
async function legacyWhatsappSent(date: string, city: string): Promise<Set<number>> {
  try {
    const { listNotices } = await import("./extrasAutomation");
    return new Set((await listNotices(date, city)).filter((n) => n.status === "sent" && !n.outdated).map((n) => n.assignmentId));
  } catch {
    return new Set();
  }
}

async function loadLogWithDetail(ids: number[]): Promise<{ assignmentId: number; version: number; kind: "scheduled" | "removed"; channel: NotifyChannel; status: string; attempts: number; detail: string | null }[]> {
  const db = await getDb();
  if (!db || !ids.length) return [];
  const res = await db.execute(sql`
    SELECT assignmentId, version, kind, channel, status, attempts, detail
      FROM extras_dia_notifications WHERE assignmentId IN (${inList(ids)})`);
  return rowsOf(res).map((r) => ({
    assignmentId: Number(r.assignmentId), version: Number(r.version), kind: String(r.kind) as "scheduled" | "removed",
    channel: String(r.channel) as NotifyChannel, status: String(r.status), attempts: Number(r.attempts), detail: r.detail ? String(r.detail) : null,
  }));
}

export interface ShiftNoticePreview extends NoticePlan {
  date: string;
  city: ScheduleCity;
  shift: ShiftId;
  dayLabel: string;
  configured: Record<NotifyChannel, boolean>;
  /** O dia já passou: não se avisa ninguém. */
  pastDay: boolean;
}

/** O que "Avisar este turno" vai enviar — sem efeitos (nada é reservado nem enviado). */
export async function previewShiftNotice(date: string, city: ScheduleCity, shift: ShiftId, channels: readonly NotifyChannel[]): Promise<ShiftNoticePreview> {
  const { loadScheduleSettings } = await import("./extrasSchedule");
  const rows = await loadShiftRows(date, city, shift);
  const ids = Array.from(new Set(rows.map((r) => r.employeeId).filter((x): x is number => x != null)));
  const [people, log, legacy, settings, email] = await Promise.all([
    loadNoticePeople(ids),
    loadLogWithDetail(rows.map((r) => r.id)),
    legacyWhatsappSent(date, city),
    loadScheduleSettings(),
    emailConfigured(),
  ]);
  const configured = { whatsapp: whatsappConfigured(), email };
  const plan = planShiftNotice({
    date, city, meetingPoint: settings.meetingPoints[city], rows, people, log, legacyWhatsappSent: legacy, channels, configured,
  });
  return { ...plan, date, city, shift, dayLabel: fmtDayPt(date), configured, pastDay: date < lisbonNow().date };
}

export interface ChannelOutcome {
  status: string;
  label: string;
  detail: string | null;
  /** false = já estava assim antes deste clique (ex.: avisado antes — não se reenviou). */
  fresh: boolean;
}

export interface ShiftNoticeResult {
  people: { employeeId: number; name: string; whatsapp: ChannelOutcome | null; email: ChannelOutcome | null }[];
  /** Enviados AGORA (não conta quem já tinha sido avisado). */
  sent: Record<NotifyChannel, number>;
  failed: Record<NotifyChannel, number>;
  /** Já avisados antes desta versão — nada reenviado. */
  already: Record<NotifyChannel, number>;
  rulesSent: number;
  warnings: string[];
  errors: string[];
}

/**
 * Envia o aviso de trabalho do turno pelos canais pedidos. Reutiliza os envios
 * da escala (notifyAssignments → WhatsApp; sendScheduleEmails → email), que
 * reservam cada (linha, versão, canal) — idempotente. Devolve o resultado por
 * pessoa lido do registo (o mesmo que a linha da escala mostra).
 */
export async function sendShiftNotice(input: { date: string; city: ScheduleCity; shift: ShiftId; channels: readonly NotifyChannel[]; userId: number }): Promise<ShiftNoticeResult> {
  const { date, city, shift, channels } = input;
  const { PAST_DAY_MESSAGE, sendScheduleEmails } = await import("./extrasSchedule");
  if (date < lisbonNow().date) throw new Error(PAST_DAY_MESSAGE);
  if (!channels.length) throw new Error("Escolhe pelo menos um canal (WhatsApp ou email).");
  const out: ShiftNoticeResult = {
    people: [], sent: { whatsapp: 0, email: 0 }, failed: { whatsapp: 0, email: 0 }, already: { whatsapp: 0, email: 0 }, rulesSent: 0, warnings: [], errors: [],
  };
  const confirmedRows = async () => (await loadShiftRows(date, city, shift)).filter((r) => r.status === "confirmed" && r.employeeId != null);
  const before = await loadLogWithDetail((await confirmedRows()).map((r) => r.id));

  if (channels.includes("whatsapp")) {
    if (!whatsappConfigured()) out.warnings.push("WhatsApp não configurado — só email");
    else {
      try {
        const { notifyAssignments } = await import("./extrasAutomation");
        const r = await notifyAssignments(date, { city, shift, createdById: input.userId });
        out.rulesSent = r.rulesSent;
      } catch (err: any) {
        out.errors.push(`WhatsApp: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
  }
  if (channels.includes("email")) {
    if (!(await emailConfigured())) out.warnings.push("Envio de email (Gmail) não configurado — sem email");
    else {
      try {
        await sendScheduleEmails(date, city, { shift });
      } catch (err: any) {
        out.errors.push(`email: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
  }

  // Resultado por pessoa (versão atual de cada linha confirmada).
  const rows = await confirmedRows();
  const log = await loadLogWithDetail(rows.map((r) => r.id));
  const byEmp = new Map<number, typeof rows>();
  for (const r of rows) byEmp.set(r.employeeId as number, [...(byEmp.get(r.employeeId as number) ?? []), r]);
  for (const [empId, list] of Array.from(byEmp.entries())) {
    const one = (channel: NotifyChannel): ChannelOutcome | null => {
      if (!channels.includes(channel)) return null;
      const o = noticeOutcome(list, log, channel);
      if (!o) return null;
      const prev = noticeOutcome(list, before, channel);
      const fresh = !prev || prev.status !== o.status || prev.detail !== o.detail || o.status === "failed";
      if (!fresh && o.status === "sent") out.already[channel]++;
      else if (o.status === "sent") out.sent[channel]++;
      else if (o.status === "failed") out.failed[channel]++;
      return { status: o.status, label: noticeStatusLabel(o.status), detail: o.detail, fresh };
    };
    out.people.push({ employeeId: empId, name: list[0].personName, whatsapp: one("whatsapp"), email: one("email") });
  }
  out.people.sort((a, b) => a.name.localeCompare(b.name, "pt"));

  const shiftLabel = shift === "morning" ? "manhã" : "noite";
  const per = (c: NotifyChannel) =>
    `${NOTICE_CHANNEL_LABELS[c]} ${out.sent[c]} enviado(s)${out.failed[c] ? `, ${out.failed[c]} falhado(s)` : ""}${out.already[c] ? `, ${out.already[c]} já avisado(s)` : ""}`;
  await logActivity({
    userId: input.userId,
    action: "extras_shift_notify",
    entity: "extras_dia_assignments",
    details: [
      `Avisar este turno · ${date} · ${CITY_LABELS_PT[city] ?? city} · ${shiftLabel}`,
      ...channels.map(per),
      ...out.warnings,
      ...out.errors.map((e) => `erro: ${e}`),
    ].join(" · ").slice(0, 1000),
  });
  return out;
}
