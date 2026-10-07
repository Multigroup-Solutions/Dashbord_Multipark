/**
 * "Avisar este turno" (Extras-dia, pedido 8, Jorge 7 out 2026): o aviso de
 * trabalho vai já com o dia e as horas DE CADA PESSOA nessa janela de trabalho
 * — sem ir à Disponibilidade escrever o dia à mão. Regras PURAS, partilhadas
 * pela pré-visualização (sem efeitos) e pelo envio (server/extrasDiaShift.ts),
 * para o que se vê na janela de confirmação ser exatamente o que segue.
 *
 *  - só linhas CONFIRMADAS recebem (decisão do Jorge); as propostas por
 *    confirmar aparecem assinaladas e não recebem;
 *  - canais: WhatsApp (template "aviso de trabalho") e email ("Aviso de
 *    trabalho — sexta 26/09, 18h–03h"); o email funciona mesmo sem WhatsApp;
 *  - email de trabalho ou, sem ele, o pessoal (os extras usam o pessoal);
 *    "Não enviar email/WhatsApp" da ficha e o STOP respeitam-se;
 *  - 1 aviso por (linha, versão, canal): um segundo clique não reenvia; uma
 *    linha alterada (versão nova) volta a receber.
 */
import { fmtDayPt, hh, notificationDone, scheduleMessageText, type NotifyChannel, type NotifyLogRow } from "./extrasSchedule";
import { NO_AUTO_EMAIL_ERROR, NO_AUTO_WHATSAPP_ERROR } from "./contactPrefs";

export const NOTICE_CHANNELS: readonly NotifyChannel[] = ["whatsapp", "email"];
export const NOTICE_CHANNEL_LABELS: Record<NotifyChannel, string> = { whatsapp: "WhatsApp", email: "Email" };

/** Motivo de um funcionário (não extra) posto à mão na escala — o mesmo do servidor. */
export const NOT_EXTRA_NOTICE_REASON = "funcionário (não é extra): não recebe avisos de escala";

export interface NoticeRow {
  id: number;
  version: number;
  employeeId: number | null;
  personName: string;
  status: string;
  startHour: number;
  endHour: number;
  sentHomeHour?: number | null;
}

export interface NoticePerson {
  id: number;
  fullName: string;
  /** Extra ativo (só esses recebem avisos de escala). */
  isExtra: boolean;
  email: string | null;
  personalEmail: string | null;
  /** Telemóvel normalizado (E.164) ou null se não houver/for inválido. */
  phoneE164: string | null;
  noAutoEmail: boolean;
  noAutoWhatsapp: boolean;
  /** O número pediu STOP. */
  whatsappOptedOut: boolean;
}

export type ChannelPlan =
  | { action: "send" }
  | { action: "off" }
  | { action: "skip"; reason: string; kind: "already" | "opted_out" | "no_contact" | "not_configured" | "not_extra" };

export interface NoticePlanPerson {
  employeeId: number;
  name: string;
  assignmentIds: number[];
  /** O texto exato (vai no {{2}} do WhatsApp e no corpo do email). */
  text: string;
  subject: string;
  /** Para onde vai o email (trabalho ou pessoal), se houver. */
  emailTo: string | null;
  channels: Record<NotifyChannel, ChannelPlan>;
}

export interface NoticePlan {
  people: NoticePlanPerson[];
  /** Propostas por confirmar neste turno: assinaladas, não recebem. */
  proposals: { assignmentId: number; personName: string; hours: string }[];
  /** Linhas confirmadas sem ficha do RH (antigas): não há a quem avisar. */
  withoutRecord: { assignmentId: number; personName: string }[];
  /** Quantas pessoas recebem por canal. */
  toSend: Record<NotifyChannel, number>;
}

const validEmail = (s: string | null | undefined) => {
  const v = (s ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
};

/** Email do aviso: o de trabalho, senão o pessoal (os extras usam o pessoal). PURA. */
export function noticeEmailAddress(p: { email: string | null; personalEmail: string | null }): string | null {
  return validEmail(p.email) ?? validEmail(p.personalEmail);
}

/** Horas efetivas de cada linha (mandado para casa = sai mais cedo), por ordem. PURA. */
export function noticeSpans(rows: readonly Pick<NoticeRow, "startHour" | "endHour" | "sentHomeHour">[]): { startHour: number; endHour: number }[] {
  return rows
    .map((r) => ({ startHour: r.startHour, endHour: r.sentHomeHour ?? r.endHour }))
    .sort((a, b) => a.startHour - b.startHour);
}

/** "18h–03h" / "06h–10h e 18h–22h". PURA. */
export function noticeHours(spans: readonly { startHour: number; endHour: number }[]): string {
  return spans.map((s) => `${hh(s.startHour)}–${hh(s.endHour)}`).join(" e ");
}

/** "Aviso de trabalho — sexta 26/09, 18h–03h". PURA. */
export function shiftNoticeSubject(date: string, spans: readonly { startHour: number; endHour: number }[]): string {
  return `Aviso de trabalho — ${fmtDayPt(date)}, ${noticeHours(spans)}`;
}

/** Corpo do email (texto simples; o servidor faz o HTML a partir dele). PURA. */
export function shiftNoticeEmailLines(firstName: string, text: string): string[] {
  return [
    `Olá ${firstName},`,
    `Aviso de trabalho: ${text}.`,
    "Se não puderes ir, avisa-nos o quanto antes (responde a este email ou pelo WhatsApp).",
    "Obrigado,\nMultipark",
  ];
}

/**
 * O plano do aviso de um turno: quem recebe o quê, por que canal, e quem fica
 * de fora e porquê. `rows` = as linhas desse dia/cidade/turno; `log` = os
 * avisos já registados (extras_dia_notifications). PURA.
 */
export function planShiftNotice(input: {
  date: string;
  city: string;
  meetingPoint?: string | null;
  rows: readonly NoticeRow[];
  people: ReadonlyMap<number, NoticePerson>;
  log: readonly NotifyLogRow[];
  legacyWhatsappSent?: ReadonlySet<number>;
  channels: readonly NotifyChannel[];
  configured: Record<NotifyChannel, boolean>;
}): NoticePlan {
  const proposals = input.rows
    .filter((r) => r.status === "proposed")
    .map((r) => ({ assignmentId: r.id, personName: r.personName, hours: noticeHours(noticeSpans([r])) }));
  const confirmed = input.rows.filter((r) => r.status === "confirmed");
  const withoutRecord = confirmed.filter((r) => r.employeeId == null).map((r) => ({ assignmentId: r.id, personName: r.personName }));

  const byEmp = new Map<number, NoticeRow[]>();
  for (const r of confirmed) {
    if (r.employeeId == null) continue;
    byEmp.set(r.employeeId, [...(byEmp.get(r.employeeId) ?? []), r]);
  }

  const people: NoticePlanPerson[] = [];
  for (const [empId, rows] of Array.from(byEmp.entries())) {
    const p = input.people.get(empId) ?? null;
    const spans = noticeSpans(rows);
    const text = scheduleMessageText({ date: input.date, city: input.city, spans, meetingPoint: input.meetingPoint ?? null });
    const emailTo = p ? noticeEmailAddress(p) : null;
    const plan = (channel: NotifyChannel): ChannelPlan => {
      if (!input.channels.includes(channel)) return { action: "off" };
      if (!input.configured[channel]) {
        return { action: "skip", kind: "not_configured", reason: channel === "whatsapp" ? "WhatsApp não configurado" : "Envio de email não configurado" };
      }
      if (!p || !p.isExtra) return { action: "skip", kind: "not_extra", reason: p ? NOT_EXTRA_NOTICE_REASON : "ficha inativa ou não encontrada" };
      const pending = rows.filter((a) => !notificationDone(a, input.log, "scheduled", channel, input.legacyWhatsappSent));
      if (!pending.length) return { action: "skip", kind: "already", reason: "já avisado(a) destas horas" };
      if (channel === "whatsapp") {
        if (p.noAutoWhatsapp) return { action: "skip", kind: "opted_out", reason: NO_AUTO_WHATSAPP_ERROR };
        if (!p.phoneE164) return { action: "skip", kind: "no_contact", reason: "sem telemóvel válido na ficha" };
        if (p.whatsappOptedOut) return { action: "skip", kind: "opted_out", reason: "pediu STOP no WhatsApp" };
        return { action: "send" };
      }
      if (p.noAutoEmail) return { action: "skip", kind: "opted_out", reason: NO_AUTO_EMAIL_ERROR };
      if (!emailTo) return { action: "skip", kind: "no_contact", reason: "sem email (de trabalho nem pessoal) na ficha" };
      return { action: "send" };
    };
    people.push({
      employeeId: empId,
      name: p?.fullName || rows[0].personName,
      assignmentIds: rows.map((r) => r.id),
      text,
      subject: shiftNoticeSubject(input.date, spans),
      emailTo,
      channels: { whatsapp: plan("whatsapp"), email: plan("email") },
    });
  }
  people.sort((a, b) => a.name.localeCompare(b.name, "pt") || a.employeeId - b.employeeId);
  const toSend = {
    whatsapp: people.filter((p) => p.channels.whatsapp.action === "send").length,
    email: people.filter((p) => p.channels.email.action === "send").length,
  };
  return { people, proposals, withoutRecord, toSend };
}

/** Resultado por pessoa e canal, a partir do registo (extras_dia_notifications) da versão atual. PURA. */
export function noticeOutcome(
  rows: readonly Pick<NoticeRow, "id" | "version">[],
  log: readonly (NotifyLogRow & { detail?: string | null })[],
  channel: NotifyChannel,
): { status: string; detail: string | null } | null {
  const hits = rows
    .map((a) => log.find((l) => l.assignmentId === a.id && l.version === a.version && l.kind === "scheduled" && l.channel === channel))
    .filter((x): x is NotifyLogRow & { detail?: string | null } => !!x);
  if (!hits.length) return null;
  // O pior estado ganha (uma falha numa das linhas não fica escondida).
  const rank = (s: string) => (s === "failed" ? 0 : s === "sending" ? 1 : s === "sent" ? 3 : 2);
  const worst = hits.slice().sort((a, b) => rank(a.status) - rank(b.status))[0];
  return { status: worst.status, detail: worst.detail ?? null };
}

/** "enviado", "falhou", … — o estado do registo em PT-PT. PURA. */
export function noticeStatusLabel(status: string): string {
  switch (status) {
    case "sent": return "enviado";
    case "failed": return "falhou";
    case "sending": return "a enviar";
    case "opted_out": return "não recebe (pediu para não receber)";
    case "no_contact": return "sem contacto";
    case "invalid": return "número inválido";
    case "skipped": return "não enviado";
    default: return status;
  }
}
