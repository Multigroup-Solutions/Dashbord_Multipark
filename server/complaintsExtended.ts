/**
 * Funcionalidades adicionais às reclamações:
 *  - Identificar condutores em serviço quando a reserva ocorreu
 *    (cruzamento com extras_dia_assignments + multipark_booking_history)
 *  - Notificações in-app (criar / listar / marcar lida)
 *  - Envio de email ao cliente
 */

import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { getDb, getLastInboundMessageIdForComplaint } from "./db";
import {
  appNotifications,
  complaintDriversOnDuty,
  complaintMessages,
  complaintPenaltyConfig,
  complaints,
  employees,
  extrasDiaAssignments,
  multiparkBookingHistory,
  multiparkBookings,
} from "../drizzle/schema";
import { isSmtpConfigured, sendEmailDetailed } from "./_core/notification";
import {
  clientSignalName,
  complaintAckBody,
  isAutoAckRecipient,
  isComplaintAutoAckEnabled,
  tagComplaintSubject,
} from "./complaintEmail";
import { deriveShortName } from "./extrasDia";

// ─── Notifications ───────────────────────────────────────────────────────────

export async function createNotification(input: {
  userId: number;
  title: string;
  body?: string | null;
  kind?: string;
  link?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(appNotifications).values({
    userId: input.userId,
    title: input.title.slice(0, 255),
    body: input.body ?? null,
    kind: (input.kind ?? "info").slice(0, 32),
    link: input.link?.slice(0, 512) ?? null,
  });
}

export async function listNotifications(userId: number, unreadOnly = false, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  const cond = unreadOnly
    ? and(eq(appNotifications.userId, userId), eq(appNotifications.isRead, 0))
    : eq(appNotifications.userId, userId);
  return db
    .select()
    .from(appNotifications)
    .where(cond)
    .orderBy(desc(appNotifications.createdAt))
    .limit(limit);
}

export async function unreadCount(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(appNotifications)
    .where(and(eq(appNotifications.userId, userId), eq(appNotifications.isRead, 0)));
  return Number(row?.n ?? 0);
}

export async function markNotificationRead(userId: number, id: number) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(appNotifications)
    .set({ isRead: 1 })
    .where(and(eq(appNotifications.id, id), eq(appNotifications.userId, userId)));
}

export async function markAllNotificationsRead(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(appNotifications)
    .set({ isRead: 1 })
    .where(eq(appNotifications.userId, userId));
}

// ─── Drivers em serviço quando a reserva da reclamação correu ────────────────

export interface DutyDriver {
  source: "assignment" | "history";
  employeeId: number | null;
  employeeName: string;
  roleAtTime: string | null;
  notes: string | null;
  alreadyLinked: boolean;
}

/**
 * Lookup do reservationRef → booking → datas → cruza com assignments do dia
 * (manhã/noite) e com history (quem efectivamente fez CHECK_IN/CHECK_OUT/MOVEMENT
 * naquela reserva).
 */
export async function findDriversOnDuty(complaintId: number): Promise<DutyDriver[]> {
  const db = await getDb();
  if (!db) return [];
  const [c] = await db
    .select({
      reservationRef: complaints.reservationRef,
      reservationStart: complaints.reservationStart,
      reservationEnd: complaints.reservationEnd,
    })
    .from(complaints)
    .where(eq(complaints.id, complaintId))
    .limit(1);
  if (!c) return [];

  const drivers: DutyDriver[] = [];
  const seen = new Set<string>();

  // 1) Quem mexeu na reserva (history) — fonte mais fiável
  if (c.reservationRef) {
    const histRows = await db
      .select({
        agentName: multiparkBookingHistory.agentName,
        agentEmail: multiparkBookingHistory.agentEmail,
        changeType: multiparkBookingHistory.changeType,
      })
      .from(multiparkBookingHistory)
      .where(eq(multiparkBookingHistory.bookingExternalId, c.reservationRef));

    // Para cada agente único, tentar match a um empregado RH pelo email ou nome
    const grouped = new Map<string, { actions: string[]; email: string | null }>();
    for (const h of histRows) {
      if (!h.agentName) continue;
      let g = grouped.get(h.agentName);
      if (!g) { g = { actions: [], email: h.agentEmail ?? null }; grouped.set(h.agentName, g); }
      if (h.changeType) g.actions.push(h.changeType);
      if (!g.email && h.agentEmail) g.email = h.agentEmail;
    }

    for (const [name, info] of Array.from(grouped.entries())) {
      const empCandidates = await db
        .select({ id: employees.id, fullName: employees.fullName })
        .from(employees)
        .where(
          info.email
            ? eq(employees.email, info.email)
            : sql`LOWER(${employees.fullName}) LIKE LOWER(${"%" + name + "%"})`,
        )
        .limit(1);
      const emp = empCandidates[0];
      const k = `${emp?.id ?? "?"}|${name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      drivers.push({
        source: "history",
        employeeId: emp?.id ?? null,
        employeeName: emp?.fullName ?? name,
        roleAtTime: null,
        notes: `Acções: ${info.actions.join(", ") || "—"}`,
        alreadyLinked: false,
      });
    }
  }

  // 2) Quem estava escalado em extras-dia nos dias da reserva
  if (c.reservationStart || c.reservationEnd) {
    const startDate = (c.reservationStart ?? c.reservationEnd ?? "").slice(0, 10);
    const endDate = (c.reservationEnd ?? c.reservationStart ?? "").slice(0, 10);
    if (startDate && endDate) {
      const assignmentRows = await db
        .select({
          employeeId: extrasDiaAssignments.employeeId,
          personName: extrasDiaAssignments.personName,
          isTeamLeader: extrasDiaAssignments.isTeamLeader,
          shift: extrasDiaAssignments.shift,
          assignmentDate: extrasDiaAssignments.assignmentDate,
        })
        .from(extrasDiaAssignments)
        .where(
          and(
            gte(extrasDiaAssignments.assignmentDate, startDate),
            lte(extrasDiaAssignments.assignmentDate, endDate),
          ),
        );

      for (const a of assignmentRows) {
        const k = `${a.employeeId ?? "?"}|${a.personName}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const role = a.isTeamLeader === 1 ? "team_leader" : (a.shift ?? "driver");
        drivers.push({
          source: "assignment",
          employeeId: a.employeeId,
          employeeName: a.personName,
          roleAtTime: role,
          notes: `Escalado ${a.assignmentDate} (${a.shift})`,
          alreadyLinked: false,
        });
      }
    }
  }

  // Marca os que já estão linkados ao complaintDriversOnDuty
  const existing = await db
    .select({ employeeName: complaintDriversOnDuty.employeeName, employeeId: complaintDriversOnDuty.employeeId })
    .from(complaintDriversOnDuty)
    .where(eq(complaintDriversOnDuty.complaintId, complaintId));
  const existingSet = new Set(existing.map(e => `${e.employeeId ?? "?"}|${e.employeeName}`));
  for (const d of drivers) {
    if (existingSet.has(`${d.employeeId ?? "?"}|${d.employeeName}`)) d.alreadyLinked = true;
  }

  return drivers;
}

export async function attachDriverToComplaint(input: {
  complaintId: number;
  employeeId?: number | null;
  employeeName: string;
  roleAtTime?: string | null;
  source: "assignment" | "history" | "manual";
  notes?: string | null;
}) {
  const db = await getDb();
  if (!db) return;
  await db.insert(complaintDriversOnDuty).values({
    complaintId: input.complaintId,
    employeeId: input.employeeId ?? null,
    employeeName: input.employeeName.slice(0, 256),
    roleAtTime: input.roleAtTime?.slice(0, 64) ?? null,
    source: input.source,
    penaltyPointsApplied: 0,
    notes: input.notes?.slice(0, 512) ?? null,
  });
}

export async function listComplaintDrivers(complaintId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(complaintDriversOnDuty)
    .where(eq(complaintDriversOnDuty.complaintId, complaintId));
}

export async function detachComplaintDriver(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(complaintDriversOnDuty).where(eq(complaintDriversOnDuty.id, id));
}

// ─── Penalty config ──────────────────────────────────────────────────────────

export async function listPenaltyConfig() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(complaintPenaltyConfig);
}

export async function updatePenaltyConfig(complaintType: string, basePoints: number) {
  const db = await getDb();
  if (!db) return;
  // upsert
  await db
    .insert(complaintPenaltyConfig)
    .values({ complaintType, basePoints })
    .onDuplicateKeyUpdate({ set: { basePoints } });
}

// ─── Email ao cliente ────────────────────────────────────────────────────────

export async function sendComplaintEmailToClient(input: {
  complaintId: number;
  subject: string;
  body: string;
}): Promise<{ ok: boolean; error?: string; subject?: string }> {
  const db = await getDb();
  if (!db) return { ok: false, error: "DB indisponível" };
  const [c] = await db
    .select({
      clientEmail: complaints.clientEmail,
      clientName: complaints.clientName,
      lastOutboundMessageId: complaints.lastOutboundMessageId,
    })
    .from(complaints)
    .where(eq(complaints.id, input.complaintId))
    .limit(1);
  if (!c) return { ok: false, error: "Reclamação não encontrada" };
  if (!c.clientEmail) return { ok: false, error: "Reclamação sem email de cliente" };

  // Etiqueta do caso no assunto ([REC-<id>], só uma vez) + In-Reply-To /
  // References para a resposta do cliente voltar a ESTE caso.
  const subject = tagComplaintSubject(input.subject, input.complaintId).slice(0, 255);
  const lastInbound = await getLastInboundMessageIdForComplaint(input.complaintId);
  const references = [lastInbound, c.lastOutboundMessageId].filter((x): x is string => !!x);

  const greeting = c.clientName ? `Olá ${c.clientName},\n\n` : "Olá,\n\n";
  const fullBody = greeting + input.body;
  const sent = await sendEmailDetailed({
    to: c.clientEmail,
    subject,
    text: fullBody,
    html: `<p>${escapeHtml(fullBody).replace(/\n/g, "<br>")}</p>`,
    from: "reclamacoes@multipark.pt",
    fromName: "Multipark",
    inReplyTo: lastInbound ?? undefined,
    references,
  });

  if (sent.ok) {
    await db
      .update(complaints)
      .set({
        clientEmailSentAt: new Date().toISOString().slice(0, 19).replace("T", " "),
        clientEmailSubject: subject,
        clientEmailBody: input.body,
        ...(sent.messageId ? { lastOutboundMessageId: sent.messageId.slice(0, 255) } : {}),
      })
      .where(eq(complaints.id, input.complaintId));
    return { ok: true, subject };
  }
  return { ok: false, error: "Falha ao enviar email (SMTP)" };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Aviso de receção automático ─────────────────────────────────────────────

/**
 * Envia UM aviso de receção ao cliente de uma reclamação criada por email
 * (de reclamacoes@, com o nº do processo [REC-<id>] no assunto). Guarda:
 * `autoAckSentAt` reservado atomicamente (UPDATE … WHERE autoAckSentAt IS NULL)
 * antes do envio — nunca sai duas vezes. Desligável com COMPLAINT_AUTO_ACK=off;
 * sem SMTP configurado não faz nada. Best-effort: nunca lança.
 */
export async function sendComplaintAutoAck(
  complaintId: number,
  opts: { inReplyTo?: string | null } = {},
): Promise<{ sent: boolean; reason?: string }> {
  try {
    if (!isComplaintAutoAckEnabled()) return { sent: false, reason: "desligado (COMPLAINT_AUTO_ACK=off)" };
    if (!isSmtpConfigured()) return { sent: false, reason: "SMTP não configurado" };
    const db = await getDb();
    if (!db) return { sent: false, reason: "DB indisponível" };
    const [c] = await db
      .select({ clientEmail: complaints.clientEmail, clientName: complaints.clientName, autoAckSentAt: complaints.autoAckSentAt })
      .from(complaints)
      .where(eq(complaints.id, complaintId))
      .limit(1);
    if (!c) return { sent: false, reason: "reclamação não encontrada" };
    if (c.autoAckSentAt) return { sent: false, reason: "já enviado" };
    if (!isAutoAckRecipient(c.clientEmail)) return { sent: false, reason: "sem email externo do cliente" };

    const nowStr = new Date().toISOString().slice(0, 19).replace("T", " ");
    const [claim] = (await db
      .update(complaints)
      .set({ autoAckSentAt: nowStr })
      .where(and(eq(complaints.id, complaintId), isNull(complaints.autoAckSentAt)))) as any;
    if (!claim?.affectedRows) return { sent: false, reason: "já enviado" };

    const name = clientSignalName(c.clientName);
    const body = complaintAckBody(complaintId);
    const fullBody = (name ? `Olá ${name},\n\n` : "Olá,\n\n") + body;
    const subject = tagComplaintSubject("Recebemos a sua reclamação", complaintId);
    const sent = await sendEmailDetailed({
      to: c.clientEmail!,
      subject,
      text: fullBody,
      html: `<p>${escapeHtml(fullBody).replace(/\n/g, "<br>")}</p>`,
      from: "reclamacoes@multipark.pt",
      fromName: "Multipark",
      inReplyTo: opts.inReplyTo ?? undefined,
      references: opts.inReplyTo ? [opts.inReplyTo] : undefined,
    });
    if (!sent.ok) {
      // Fica marcado (não se re-tenta automaticamente: um aviso fora de tempo
      // é pior do que nenhum); a nota no caso diz que falhou.
      await db.insert(complaintMessages).values({
        complaintId, isInternal: 1, authorName: "Sistema",
        message: "⚠️ Aviso de receção automático NÃO enviado (falha SMTP).",
      } as any).catch(() => {});
      return { sent: false, reason: "falha SMTP" };
    }
    await db
      .update(complaints)
      .set({
        clientEmailSentAt: nowStr,
        clientEmailSubject: subject.slice(0, 255),
        clientEmailBody: body,
        ...(sent.messageId ? { lastOutboundMessageId: sent.messageId.slice(0, 255) } : {}),
      })
      .where(eq(complaints.id, complaintId));
    await db.insert(complaintMessages).values({
      complaintId, isInternal: 0, authorName: "Multipark (automático)",
      message: `📤 Aviso de receção enviado ao cliente — ${subject}\n\n${body}`,
    } as any);
    return { sent: true };
  } catch (err) {
    console.warn("[complaint auto-ack] falhou:", err);
    return { sent: false, reason: "erro" };
  }
}

// ─── Notification on complaint create ────────────────────────────────────────

/**
 * Notifica todos os admins/supervisores quando uma reclamação é criada.
 * Quando assignedToId está definido, também notifica esse utilizador.
 */
export async function notifyComplaintCreated(complaintId: number) {
  const db = await getDb();
  if (!db) return;
  const [c] = await db
    .select({
      id: complaints.id,
      title: complaints.title,
      complaintType: complaints.complaintType,
      complaintPriority: complaints.complaintPriority,
      assignedToId: complaints.assignedToId,
      clientName: complaints.clientName,
    })
    .from(complaints)
    .where(eq(complaints.id, complaintId))
    .limit(1);
  if (!c) return;

  const { users } = await import("../drizzle/schema");
  const recipients = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`${users.role} IN ('admin','super_admin','supervisor','team_leader')`);

  const title = `Nova reclamação: ${c.title}`;
  const body = `Tipo: ${c.complaintType} · Prioridade: ${c.complaintPriority}${
    c.clientName ? ` · Cliente: ${c.clientName}` : ""
  }`;
  const link = `/reclamacoes/${complaintId}`;

  const userIds = new Set<number>(recipients.map(r => r.id));
  if (c.assignedToId) userIds.add(c.assignedToId);

  for (const userId of Array.from(userIds)) {
    try {
      await createNotification({ userId, title, body, kind: "complaint", link });
    } catch {}
  }
}
