/**
 * Falhas de entrega 131026 / 131049 (Jorge, 2 out 2026).
 *
 * Quase nunca vêm na resposta do POST /messages: a Meta aceita a mensagem e só
 * depois diz `failed` pelo webhook (`statuses[].errors[].code`). Por isso a
 * política corre na TRANSIÇÃO para `failed` de uma linha nossa — pelo webhook
 * (`handleStatus`) ou quando o estado chegou antes da linha
 * (`reconcilePendingStatus`). Uma repetição do mesmo `failed` não muda a linha
 * e não volta a correr nada.
 *
 *   131026  Não entregável (número sem WhatsApp, app antiga, bloqueou-nos).
 *           Repetir não resolve. Ao 2.º SEGUIDO no mesmo número → a conversa
 *           fica "sem WhatsApp" (`unreachableAt`) e não recebe mais templates
 *           até a pessoa escrever (ou o número mudar: é outra conversa). Uma
 *           mensagem entregue/lida pelo meio repõe a contagem.
 *   131049  A Meta reteve um template de MARKETING (limite por pessoa).
 *           Mensagens de EQUIPA (catálogo `teamRetry`): no máximo UMA nova
 *           tentativa passadas 24 h, e só se o turno ainda não tiver começado.
 *           Nunca de imediato.
 *   Ambos   alternativa pelo email que já existe para a mesma comunicação
 *           (aviso de escala, pedido de disponibilidade); sem email
 *           equivalente → registo + aviso no sino (`whatsapp_undelivered`).
 *   Outros  comportamento de sempre (errorDetail + afterOutboundFailed).
 *
 * As partes puras estão testadas em whatsappFailurePolicy.test.ts.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { whatsappBroadcasts, whatsappConversations, whatsappMessages } from "../drizzle/schema";
import { isDriverMessageTemplate, isTeamRetryTemplate } from "../shared/whatsappTemplate";
import { lisbonMidnightUtcMs } from "../shared/lisbonDay";
import { maskPhone } from "../shared/maskPhone";
import type { Db, MessageStatus } from "./whatsappStore";

// ─── Puras ──────────────────────────────────────────────────────────────────

export const META_ERROR_UNDELIVERABLE = 131026;
export const META_ERROR_MARKETING_LIMIT = 131049;
/** 131026 seguidos que marcam o número "sem WhatsApp". */
export const UNREACHABLE_AFTER = 2;
/** A nova tentativa de uma mensagem de equipa retida por 131049. */
export const TEAM_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

export const UNREACHABLE_ERROR =
  "Sem WhatsApp: a Meta não entregou as últimas mensagens a este número (131026). Volta a receber templates quando escrever.";

export type FailureKind = "undeliverable" | "marketing_limit" | "other";

export function classifyFailure(code: number | null | undefined): FailureKind {
  if (code === META_ERROR_UNDELIVERABLE) return "undeliverable";
  if (code === META_ERROR_MARKETING_LIMIT) return "marketing_limit";
  return "other";
}

/** Estado depois de mais um 131026 seguido. `markUnreachable` é verdade UMA vez. PURA. */
export function nextUndeliverableState(current: { undeliverableCount: number; unreachableAt: string | null }): {
  undeliverableCount: number;
  markUnreachable: boolean;
} {
  const undeliverableCount = current.undeliverableCount + 1;
  return { undeliverableCount, markUnreachable: !current.unreachableAt && undeliverableCount >= UNREACHABLE_AFTER };
}

const SHIFT_NOTE_RE = /^(Aviso de escala|Morada e regras \(1\.º turno\)|Turno confirmado) (\d{4}-\d{2}-\d{2})/;

/** Dia do turno pela nota da difusão de equipa (aviso de escala / morada e regras / turno confirmado). PURA. */
export function shiftDateFromNote(note: string | null | undefined): string | null {
  const m = String(note ?? "").match(SHIFT_NOTE_RE);
  return m ? m[2] : null;
}

/** Início do turno (Lisboa) em UTC. `startHour` pode passar das 24 (turno de noite). PURA. */
export function shiftStartUtc(date: string, startHour: number): Date {
  return new Date(lisbonMidnightUtcMs(date) + startHour * 60 * 60 * 1000);
}

export type RetryDecision =
  | { kind: "none" }
  | { kind: "schedule"; retryAt: Date }
  | { kind: "skip"; reason: string };

/** Nova tentativa de uma mensagem de equipa retida por 131049? PURA. */
export function planTeamRetry(input: {
  failure: FailureKind;
  teamTemplate: boolean;
  employeeId: number | null;
  isRetry: boolean;
  hasPayload: boolean;
  failedAt: Date;
  /** Início do turno a que a mensagem se refere (null = não é de turno). */
  shiftStartsAt: Date | null;
}): RetryDecision {
  if (input.failure !== "marketing_limit" || !input.teamTemplate || input.employeeId == null) return { kind: "none" };
  if (input.isRetry) return { kind: "skip", reason: "já era a nova tentativa" };
  if (!input.hasPayload) return { kind: "skip", reason: "envio sem dados para repetir" };
  const retryAt = new Date(input.failedAt.getTime() + TEAM_RETRY_DELAY_MS);
  if (input.shiftStartsAt && retryAt.getTime() >= input.shiftStartsAt.getTime()) {
    return { kind: "skip", reason: "o turno começa antes da nova tentativa" };
  }
  return { kind: "schedule", retryAt };
}

export type FallbackChannel = "schedule_email" | "availability_email" | "none";

/** Que email substitui esta mensagem? PURA. */
export function fallbackChannelFor(m: { templateName: string | null; note: string | null; employeeId: number | null }): FallbackChannel {
  if (m.employeeId == null) return "none";
  if (/^Aviso de escala \d{4}-\d{2}-\d{2}/.test(m.note ?? "")) return "schedule_email";
  // Pedido de disponibilidade de QUALQUER cidade (registo shared/driverTemplates.ts).
  if (isDriverMessageTemplate(m.templateName, "AVAILABILITY")) return "availability_email";
  return "none";
}

export type FallbackResult = "EMAIL_SENT" | "EMAIL_ALREADY_SENT" | "NO_EMAIL_EQUIVALENT" | "EMAIL_NOT_SENT";

/** Payload guardado num envio de equipa para a nova tentativa. */
export interface TeamSendPayload {
  languageCode: string;
  components?: unknown[];
  /** O botão do formulário leva um token NOVO na nova tentativa (nunca guardado). */
  formWeekStart?: string | null;
}

/** Marcador do token do formulário nos components guardados (o token real nunca vai para a BD). */
export const FORM_TOKEN_PLACEHOLDER = "{{form_token}}";

export function parseSendPayload(raw: string | null | undefined): TeamSendPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return p && typeof p.languageCode === "string" ? (p as TeamSendPayload) : null;
  } catch {
    return null;
  }
}

/** Components com o token verdadeiro no lugar do marcador. PURA. */
export function withFormToken(components: unknown[] | undefined, token: string | null): unknown[] | undefined {
  if (!components) return components;
  return JSON.parse(JSON.stringify(components), (_k, v) => (v === FORM_TOKEN_PLACEHOLDER ? token ?? "" : v));
}

// ─── I/O ────────────────────────────────────────────────────────────────────

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const affected = (res: unknown): number => Number((res as any)?.[0]?.affectedRows ?? (res as any)?.affectedRows ?? 0);
const toSql = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

export interface OutboundStatusChange {
  messageId: number;
  next: MessageStatus;
  errorCode: number | null;
  errorDetail: string | null;
}

interface FailedMessage {
  id: number;
  conversationId: number;
  templateName: string | null;
  sendPayload: string | null;
  retryOfId: number | null;
  createdAt: string;
  phoneE164: string;
  employeeId: number | null;
  note: string | null;
  weekStart: string | null;
}

/**
 * Depois de uma linha de SAÍDA mudar de estado. Nunca lança: o estado já está
 * gravado e um retry da Meta não voltaria a correr isto.
 */
export async function onOutboundStatusChanged(db: Db, change: OutboundStatusChange): Promise<void> {
  try {
    if (change.next === "delivered" || change.next === "read") {
      await resetUndeliverable(db, change.messageId);
      return;
    }
    if (change.next !== "failed") return;
    const failure = classifyFailure(change.errorCode);
    if (failure === "other") return;

    const m = await loadMessage(db, change.messageId);
    if (!m) return;
    if (failure === "undeliverable") await countUndeliverable(db, m);
    if (failure === "marketing_limit") await scheduleTeamRetry(db, m);
    await runFallback(db, m, change);
  } catch (err: any) {
    console.warn("[WhatsApp] política de falha (131026/131049) falhou:", String(err?.message ?? err).slice(0, 160));
  }
}

async function loadMessage(db: Db, messageId: number): Promise<FailedMessage | null> {
  const [row] = await db
    .select({
      id: whatsappMessages.id,
      conversationId: whatsappMessages.conversationId,
      templateName: whatsappMessages.templateName,
      sendPayload: whatsappMessages.sendPayload,
      retryOfId: whatsappMessages.retryOfId,
      createdAt: whatsappMessages.createdAt,
      phoneE164: whatsappConversations.phoneE164,
      employeeId: whatsappConversations.employeeId,
      note: whatsappBroadcasts.note,
      weekStart: whatsappBroadcasts.weekStart,
    })
    .from(whatsappMessages)
    .innerJoin(whatsappConversations, eq(whatsappMessages.conversationId, whatsappConversations.id))
    .leftJoin(whatsappBroadcasts, eq(whatsappMessages.broadcastId, whatsappBroadcasts.id))
    .where(and(eq(whatsappMessages.id, messageId), eq(whatsappMessages.direction, "out")))
    .limit(1);
  return (row as FailedMessage | undefined) ?? null;
}

async function countUndeliverable(db: Db, m: FailedMessage): Promise<void> {
  await db
    .update(whatsappConversations)
    .set({ undeliverableCount: sql`${whatsappConversations.undeliverableCount} + 1` })
    .where(eq(whatsappConversations.id, m.conversationId));
  const [conv] = await db
    .select({ undeliverableCount: whatsappConversations.undeliverableCount, unreachableAt: whatsappConversations.unreachableAt })
    .from(whatsappConversations)
    .where(eq(whatsappConversations.id, m.conversationId))
    .limit(1);
  if (!conv) return;
  // `conv` já tem o incremento: a decisão parte do estado anterior.
  const decision = nextUndeliverableState({ undeliverableCount: conv.undeliverableCount - 1, unreachableAt: conv.unreachableAt });
  if (!decision.markUnreachable) return;
  const res = await db
    .update(whatsappConversations)
    .set({ unreachableAt: toSql(new Date()) })
    .where(and(eq(whatsappConversations.id, m.conversationId), isNull(whatsappConversations.unreachableAt)));
  if (affected(res) > 0) {
    console.warn(`[WhatsApp] ${maskPhone(m.phoneE164)} marcado sem WhatsApp (${decision.undeliverableCount}× 131026 seguidos) — sem templates até escrever.`);
  }
}

/** Entregue/lida: o número funciona, acaba a série de 131026. */
async function resetUndeliverable(db: Db, messageId: number): Promise<void> {
  await db.execute(sql`UPDATE whatsapp_conversations c JOIN whatsapp_messages m ON m.conversationId = c.id
     SET c.undeliverableCount = 0 WHERE m.id = ${messageId} AND c.undeliverableCount > 0`);
}

/** Início do turno do colaborador no dia (a hora mais cedo das linhas confirmadas). */
async function shiftStartFor(db: Db, employeeId: number, date: string): Promise<Date> {
  const rows = rowsOf(await db.execute(sql`SELECT MIN(startHour) AS h FROM extras_dia_assignments
     WHERE employeeId = ${employeeId} AND assignmentDate = ${date} AND status = 'confirmed'`));
  const h = rows[0]?.h;
  // Sem linha (removida entretanto): o "turno" conta desde a meia-noite — nunca repete.
  return shiftStartUtc(date, h == null ? 0 : Number(h));
}

async function scheduleTeamRetry(db: Db, m: FailedMessage): Promise<void> {
  const teamTemplate = isTeamRetryTemplate(m.templateName);
  const date = shiftDateFromNote(m.note);
  const shiftStartsAt = date && m.employeeId != null ? await shiftStartFor(db, m.employeeId, date) : null;
  const decision = planTeamRetry({
    failure: "marketing_limit",
    teamTemplate,
    employeeId: m.employeeId,
    isRetry: m.retryOfId != null,
    hasPayload: !!parseSendPayload(m.sendPayload),
    failedAt: new Date(),
    shiftStartsAt,
  });
  if (decision.kind === "none") return;
  if (decision.kind === "schedule") {
    await db
      .update(whatsappMessages)
      .set({ retryState: "scheduled", retryAt: toSql(decision.retryAt) })
      .where(and(eq(whatsappMessages.id, m.id), isNull(whatsappMessages.retryState)));
    console.log(`[WhatsApp] ${m.templateName} retido (131049): nova tentativa às ${toSql(decision.retryAt)} UTC.`);
    return;
  }
  await db
    .update(whatsappMessages)
    .set({ retryState: "skipped" })
    .where(and(eq(whatsappMessages.id, m.id), isNull(whatsappMessages.retryState)));
  console.log(`[WhatsApp] ${m.templateName} retido (131049): sem nova tentativa — ${decision.reason}.`);
}

async function emailSentForShift(db: Db, employeeId: number, date: string): Promise<boolean> {
  const rows = rowsOf(await db.execute(sql`SELECT 1 AS x FROM extras_dia_notifications
     WHERE employeeId = ${employeeId} AND assignmentDate = ${date} AND kind = 'scheduled' AND channel = 'email' AND status = 'sent' LIMIT 1`));
  return rows.length > 0;
}

async function availabilityEmailSince(db: Db, employeeId: number, since: string): Promise<boolean> {
  try {
    const rows = rowsOf(await db.execute(sql`SELECT 1 AS x FROM mail_auto_sends
       WHERE employeeId = ${employeeId} AND kind IN ('availability_request', 'availability_reminder') AND sentAt >= ${since} LIMIT 1`));
    return rows.length > 0;
  } catch {
    return false; // tabela ainda por criar
  }
}

/** Alternativa por email (uma só vez por mensagem) + aviso no sino quando não há. */
async function runFallback(db: Db, m: FailedMessage, change: OutboundStatusChange): Promise<void> {
  const claim = await db
    .update(whatsappMessages)
    .set({ fallbackAt: toSql(new Date()) })
    .where(and(eq(whatsappMessages.id, m.id), isNull(whatsappMessages.fallbackAt)));
  if (affected(claim) === 0) return;

  const channel = fallbackChannelFor(m);
  let result: FallbackResult = "NO_EMAIL_EQUIVALENT";
  let detail: string | null = null;
  try {
    if (channel === "schedule_email") {
      const date = shiftDateFromNote(m.note)!;
      if (await emailSentForShift(db, m.employeeId!, date)) result = "EMAIL_ALREADY_SENT";
      else {
        const cities = rowsOf(await db.execute(sql`SELECT DISTINCT city FROM extras_dia_assignments
           WHERE employeeId = ${m.employeeId} AND assignmentDate = ${date} AND status = 'confirmed'`)).map((r) => String(r.city));
        const { sendScheduleEmails } = await import("./extrasSchedule");
        // Só esta pessoa: os outros avisos da cidade seguem o seu próprio fluxo.
        for (const city of cities) await sendScheduleEmails(date, city as any, { employeeIds: [m.employeeId!] });
        result = (await emailSentForShift(db, m.employeeId!, date)) ? "EMAIL_SENT" : "EMAIL_NOT_SENT";
        if (result === "EMAIL_NOT_SENT") detail = cities.length ? "o email da escala não seguiu (sem email na ficha ou envio de email desligado)" : "já não está na escala desse dia";
      }
    } else if (channel === "availability_email") {
      // O email segue no MESMO envio do pedido; só se não seguiu é que se manda.
      const since = toSql(new Date(new Date(`${m.createdAt.replace(" ", "T")}Z`).getTime() - 2 * 60 * 60 * 1000));
      if (await availabilityEmailSince(db, m.employeeId!, since)) result = "EMAIL_ALREADY_SENT";
      else if (!m.weekStart) {
        result = "EMAIL_NOT_SENT";
        detail = "pedido sem semana";
      } else {
        const { sendWeeklyAvailabilityRequest } = await import("./extrasAvailability");
        const { appOrigin } = await import("./extrasAutomation");
        const r = await sendWeeklyAvailabilityRequest({ weekStart: m.weekStart, origin: appOrigin(), employeeIds: [m.employeeId!] });
        result = r.sent > 0 ? "EMAIL_SENT" : "EMAIL_NOT_SENT";
        if (result === "EMAIL_NOT_SENT") detail = "o pedido por email não seguiu (sem email na ficha ou envio de email desligado)";
      }
    }
  } catch (err: any) {
    result = "EMAIL_NOT_SENT";
    detail = String(err?.message ?? err).slice(0, 160);
  }

  await db.update(whatsappMessages).set({ fallbackResult: result }).where(eq(whatsappMessages.id, m.id));
  console.log(`[WhatsApp] ${m.templateName ?? "mensagem"} não entregue (${change.errorCode}) a ${maskPhone(m.phoneE164)}: alternativa ${result}${detail ? ` (${detail})` : ""}.`);

  if (result === "NO_EMAIL_EQUIVALENT" || result === "EMAIL_NOT_SENT") {
    const { notify } = await import("./notify");
    const why = change.errorCode === META_ERROR_UNDELIVERABLE ? "o número não recebe WhatsApp (131026)" : "a Meta reteve a mensagem por limite de marketing (131049)";
    await notify({
      kind: "whatsapp_undelivered",
      employeeId: m.employeeId,
      noCityToAll: true,
      title: `WhatsApp não entregue: ${m.templateName ?? "mensagem"}`,
      body: `Para ${maskPhone(m.phoneE164)}: ${why}. ${result === "NO_EMAIL_EQUIVALENT" ? "Não há email equivalente" : `O email alternativo não seguiu${detail ? ` (${detail})` : ""}`} — contactar por outro meio.`,
      link: "/whatsapp",
      entity: { type: "whatsapp_message", id: m.id },
    });
  }
}

// ─── Nova tentativa (cron horário) ──────────────────────────────────────────

export interface RetryRunResult { due: number; sent: number; failed: number; skipped: number }

/**
 * Faz as novas tentativas agendadas (131049, mensagens de equipa) que já
 * passaram as 24 h. Re-verifica tudo à hora de enviar: STOP, "sem WhatsApp",
 * "Não enviar WhatsApp" na ficha e o turno ainda não começado. Cada linha é
 * reclamada (scheduled → running) para o cron e um segundo processo não
 * enviarem os dois. A nova linha leva `retryOfId`: se falhar outra vez, não
 * há terceira.
 */
export async function runWhatsappRetries(db: Db, now: Date = new Date(), limit = 20): Promise<RetryRunResult> {
  const out: RetryRunResult = { due: 0, sent: 0, failed: 0, skipped: 0 };
  const due = rowsOf(await db.execute(sql`
    SELECT m.id, m.conversationId, m.templateName, m.body, m.sendPayload, m.broadcastId, m.sentById,
           c.phoneE164, c.employeeId, c.optedOutAt, c.unreachableAt, b.note,
           COALESCE(e.noAutoWhatsapp, 0) AS noAutoWhatsapp
      FROM whatsapp_messages m
      JOIN whatsapp_conversations c ON c.id = m.conversationId
      LEFT JOIN whatsapp_broadcasts b ON b.id = m.broadcastId
      LEFT JOIN employees e ON e.id = c.employeeId
     WHERE m.retryState = 'scheduled' AND m.retryAt <= ${toSql(now)}
     ORDER BY m.retryAt LIMIT ${limit}`));
  out.due = due.length;

  for (const r of due) {
    const claim = await db.update(whatsappMessages).set({ retryState: "running" })
      .where(and(eq(whatsappMessages.id, Number(r.id)), eq(whatsappMessages.retryState, "scheduled")));
    if (affected(claim) === 0) continue;

    const finish = async (state: "done" | "skipped", why?: string) => {
      await db.update(whatsappMessages).set({ retryState: state }).where(eq(whatsappMessages.id, Number(r.id)));
      if (why) console.log(`[WhatsApp] nova tentativa de ${r.templateName} (msg ${r.id}) não feita: ${why}.`);
    };
    const payload = parseSendPayload(r.sendPayload);
    const employeeId = r.employeeId == null ? null : Number(r.employeeId);
    const date = shiftDateFromNote(r.note);
    let skip: string | null = null;
    if (!payload) skip = "envio sem dados para repetir";
    else if (r.optedOutAt) skip = "pediu STOP";
    else if (r.unreachableAt) skip = "número sem WhatsApp";
    else if (Number(r.noAutoWhatsapp) === 1) skip = "ficha com \"Não enviar WhatsApp\"";
    else if (date && employeeId != null && (await shiftStartFor(db, employeeId, date)).getTime() <= now.getTime()) skip = "o turno já começou";
    if (skip) { out.skipped++; await finish("skipped", skip); continue; }

    try {
      const ok = await resendTeamTemplate(db, {
        originalId: Number(r.id),
        conversationId: Number(r.conversationId),
        phoneE164: String(r.phoneE164),
        employeeId,
        templateName: String(r.templateName),
        body: r.body ?? null,
        broadcastId: r.broadcastId == null ? null : Number(r.broadcastId),
        sentById: r.sentById == null ? null : Number(r.sentById),
        payload: payload!,
      });
      if (ok) {
        out.sent++;
        await afterRetrySent(db, employeeId, r.note);
      } else out.failed++;
      await finish("done");
    } catch (err: any) {
      out.failed++;
      await finish("done", String(err?.message ?? err).slice(0, 160));
    }
  }
  return out;
}

/** Reenvia o template guardado (token do formulário NOVO); a nova linha aponta para a original. */
async function resendTeamTemplate(db: Db, r: {
  originalId: number; conversationId: number; phoneE164: string; employeeId: number | null;
  templateName: string; body: string | null; broadcastId: number | null; sentById: number | null; payload: TeamSendPayload;
}): Promise<boolean> {
  const { reserveOutboundMessage, finishOutboundMessage } = await import("./whatsappStore");
  const { sendTemplateMessage } = await import("./whatsapp");
  let token: string | null = null;
  if (r.payload.formWeekStart && r.employeeId != null) {
    const { issueAvailabilityFormToken } = await import("./availabilityFormToken");
    token = (await issueAvailabilityFormToken(db, r.employeeId, r.payload.formWeekStart)).token;
  }
  const row = { conversationId: r.conversationId, type: "template" as const, body: r.body, templateName: r.templateName };
  const reserved = await reserveOutboundMessage(db, { ...row, sentById: r.sentById, broadcastId: r.broadcastId });
  if (!reserved.reserved) return false;
  // Antes de enviar: se esta também falhar, a política vê que já é a nova tentativa.
  await db.update(whatsappMessages)
    .set({ retryOfId: r.originalId, language: r.payload.languageCode, sendPayload: JSON.stringify(r.payload) })
    .where(eq(whatsappMessages.id, reserved.id));
  const res = await sendTemplateMessage(r.phoneE164, r.templateName, r.payload.languageCode, withFormToken(r.payload.components, token));
  await finishOutboundMessage(db, reserved.id, row, res.ok ? res : { ok: false, error: res.error, uncertain: res.uncertain, code: res.code });
  return res.ok;
}

/** O aviso de escala / regras voltou a sair: o Extras-Dia volta a esperar o "sim". */
async function afterRetrySent(db: Db, employeeId: number | null, note: string | null): Promise<void> {
  const date = shiftDateFromNote(note);
  if (employeeId == null || !date) return;
  if (/^Aviso de escala/.test(note ?? "")) {
    await db.execute(sql`UPDATE extras_dia_notices SET status = 'sent', error = NULL, sentAt = CURRENT_TIMESTAMP
       WHERE employeeId = ${employeeId} AND assignmentDate = ${date} AND status = 'failed' AND confirmedAt IS NULL AND declinedAt IS NULL`);
    await db.execute(sql`UPDATE extras_dia_notifications SET status = 'sent', detail = NULL
       WHERE employeeId = ${employeeId} AND assignmentDate = ${date} AND kind = 'scheduled' AND channel = 'whatsapp' AND status = 'failed'`);
  } else {
    await db.execute(sql`INSERT IGNORE INTO \`extras_rules_sent\` (employeeId) VALUES (${employeeId})`);
  }
}
