/**
 * Funcionalidades adicionais às reclamações:
 *  - Identificar condutores em serviço quando a reserva ocorreu
 *    (cruzamento com extras_dia_assignments + "History" da Multipark ao vivo)
 *  - Notificações in-app (criar / listar / marcar lida)
 *  - Envio de email ao cliente
 */

import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { getDb, getLastInboundMessageIdForComplaint } from "./db";
import {
  complaintDriversOnDuty,
  complaintMessages,
  complaintPenaltyConfig,
  complaints,
  employees,
  extrasDiaAssignments,
} from "../drizzle/schema";
import { isEmailSendConfigured, sendEmailDetailed } from "./mail/systemMail";
import {
  clientSignalName,
  complaintAckBody,
  isAutoAckRecipient,
  isComplaintAutoAckEnabled,
  tagComplaintSubject,
} from "./complaintEmail";
import { deriveShortName } from "./extrasDia";

// ─── Notificações ────────────────────────────────────────────────────────────
// O sino e os avisos vivem em server/notify.ts (roteamento por tipo/cidade).

// ─── Drivers em serviço quando a reserva da reclamação correu ────────────────

export interface DutyDriver {
  source: "assignment" | "history";
  employeeId: number | null;
  employeeName: string;
  roleAtTime: string | null;
  notes: string | null;
  alreadyLinked: boolean;
}

export interface DutyDriversResult {
  drivers: DutyDriver[];
  /** O histórico da reserva (Multipark) não se leu — a lista não está completa. */
  historyFailed: boolean;
}

/** Cidade da escala dos extras (lisbon|porto|faro) a partir do nome da cidade. PURA. */
export function extrasCityKeyOf(cityName: string | null | undefined): "lisbon" | "porto" | "faro" | null {
  const t = String(cityName ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\blisb/.test(t)) return "lisbon";
  if (/\b(porto|oporto)\b/.test(t)) return "porto";
  if (/\bfaro\b/.test(t)) return "faro";
  return null;
}

/**
 * Quem pode ter mexido no carro da reclamação (P3 16b):
 *  1) quem fez ações na reserva (histórico AO VIVO da Multipark), ligado à
 *     ficha pelo ID do agente (principal ou extra) — nunca pelo nome; agentes
 *     de sistema/API ficam de fora. Leitura falhada → `historyFailed`.
 *  2) quem estava escalado (confirmado) nos dias de ENTRADA e de SAÍDA, na
 *     cidade da reclamação — antes eram todos os dias da estadia, todas as
 *     cidades e também as propostas.
 */
export async function findDriversOnDuty(complaintId: number): Promise<DutyDriversResult> {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const [c] = await db
    .select({
      reservationRef: complaints.reservationRef,
      reservationStart: complaints.reservationStart,
      reservationEnd: complaints.reservationEnd,
      projectId: complaints.projectId,
    })
    .from(complaints)
    .where(eq(complaints.id, complaintId))
    .limit(1);
  if (!c) return { drivers: [], historyFailed: false };

  const drivers: DutyDriver[] = [];
  const seen = new Set<string>();
  let historyFailed = false;

  if (c.reservationRef) {
    const { readLiveHistory } = await import("./multiparkDb/historyLive");
    const { isLinkableAgent } = await import("../shared/agentIdentity");
    const { employeesForAgentIds } = await import("./personIdentity");
    let histRows: Array<{ agentName: string | null; agentUserId: string | null; changeType: string | null }> = [];
    try {
      histRows = await readLiveHistory({ bookingIds: [c.reservationRef], limit: 500 });
    } catch (err) {
      historyFailed = true;
      console.warn("[complaint duty] histórico da reserva falhou:", String((err as any)?.message ?? err).slice(0, 200));
    }
    const grouped = new Map<string, { name: string; actions: string[] }>();
    for (const h of histRows) {
      if (!h.agentUserId || !isLinkableAgent(h.agentUserId, h.agentName)) continue;
      const g = grouped.get(h.agentUserId) ?? { name: h.agentName ?? h.agentUserId, actions: [] };
      if (h.changeType) g.actions.push(h.changeType);
      grouped.set(h.agentUserId, g);
    }
    const owners = await employeesForAgentIds(Array.from(grouped.keys()));
    for (const [agentId, info] of Array.from(grouped.entries())) {
      const emp = owners.get(agentId);
      const k = `${emp?.id ?? "?"}|${emp?.fullName ?? info.name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      drivers.push({
        source: "history",
        employeeId: emp?.id ?? null,
        employeeName: emp?.fullName ?? info.name,
        roleAtTime: null,
        notes: `Ações: ${info.actions.join(", ") || "—"}${emp ? "" : " · agente sem ficha ligada"}`,
        alreadyLinked: false,
      });
    }
  }

  const { lisbonDayOf } = await import("../shared/lisbonDay");
  const day = (v: string | null) => (v ? lisbonDayOf(String(v)) : null); // timestamp UTC guardado → dia de Lisboa
  const days = Array.from(new Set([day(c.reservationStart), day(c.reservationEnd)].filter((x): x is string => !!x)));
  if (days.length) {
    const { projectCityMap } = await import("./caseOps");
    const city = extrasCityKeyOf((await projectCityMap()).cityOf(c.projectId)?.name);
    const { inArray } = await import("drizzle-orm");
    const assignmentRows = await db
      .select({
        employeeId: extrasDiaAssignments.employeeId,
        personName: extrasDiaAssignments.personName,
        isTeamLeader: extrasDiaAssignments.isTeamLeader,
        shift: extrasDiaAssignments.shift,
        assignmentDate: extrasDiaAssignments.assignmentDate,
      })
      .from(extrasDiaAssignments)
      .where(and(
        inArray(extrasDiaAssignments.assignmentDate, days),
        eq(extrasDiaAssignments.status, "confirmed"),
        ...(city ? [eq(extrasDiaAssignments.city, city)] : []),
      ));
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

  // Marca os que já estão associados à reclamação.
  const existing = await db
    .select({ employeeName: complaintDriversOnDuty.employeeName, employeeId: complaintDriversOnDuty.employeeId })
    .from(complaintDriversOnDuty)
    .where(eq(complaintDriversOnDuty.complaintId, complaintId));
  const byId = new Set(existing.map(e => e.employeeId).filter((x): x is number => x != null));
  const byName = new Set(existing.map(e => `${e.employeeId ?? "?"}|${e.employeeName}`));
  for (const d of drivers) {
    if ((d.employeeId != null && byId.has(d.employeeId)) || byName.has(`${d.employeeId ?? "?"}|${d.employeeName}`)) d.alreadyLinked = true;
  }

  return { drivers, historyFailed };
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
  if (!db) throw new Error("DB indisponível");
  // A mesma pessoa não fica associada duas vezes ao mesmo caso (16b).
  if (input.employeeId != null) {
    const [dup] = await db.select({ id: complaintDriversOnDuty.id }).from(complaintDriversOnDuty)
      .where(and(eq(complaintDriversOnDuty.complaintId, input.complaintId), eq(complaintDriversOnDuty.employeeId, input.employeeId))).limit(1);
    if (dup) return { id: dup.id, duplicate: true };
  }
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

/**
 * Tira o condutor da reclamação sem o perder (16b): a linha (com os pontos)
 * vai para removed_records com quem e quando; deixa de contar na avaliação.
 */
export async function detachComplaintDriver(id: number, actorId: number) {
  const { removeWithRecord } = await import("./removedRecords");
  return removeWithRecord({ table: complaintDriversOnDuty, entity: "complaint_driver", id, parentField: "complaintId", reason: "Retirado da reclamação", removedById: actorId });
}

/**
 * O responsável de uma reclamação (`assignedToId`) é uma FICHA (a página
 * escolhe da lista do RH). Os avisos e o calendário são por CONTA: converte
 * ficha → conta (16b). Fichas sem conta ficam de fora.
 */
export async function assigneeUserIds(employeeIds: Array<number | null | undefined>): Promise<number[]> {
  const ids = Array.from(new Set(employeeIds.filter((x): x is number => typeof x === "number" && x > 0)));
  if (!ids.length) return [];
  const db = await getDb();
  if (!db) return [];
  const { inArray } = await import("drizzle-orm");
  const rows = await db.select({ userId: employees.userId }).from(employees).where(inArray(employees.id, ids));
  return Array.from(new Set(rows.map((r) => r.userId).filter((x): x is number => typeof x === "number" && x > 0)));
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
  return { ok: false, error: `Falha ao enviar email (Gmail)${sent.error ? `: ${sent.error}` : ""}` };
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
 * sem envio de email (Gmail) configurado não faz nada. Best-effort: nunca lança.
 */
export async function sendComplaintAutoAck(
  complaintId: number,
  opts: { inReplyTo?: string | null } = {},
): Promise<{ sent: boolean; reason?: string }> {
  try {
    // Interruptor lido fresco (o email entra pelo cron, sem tRPC): desligado nas
    // Definições → não responde, mesmo numa instância acabada de arrancar (17e).
    const { ensureFeatureFlagOverrides } = await import("./_core/featureFlags");
    await ensureFeatureFlagOverrides().catch(() => {});
    if (!isComplaintAutoAckEnabled()) return { sent: false, reason: "desligado (COMPLAINT_AUTO_ACK=off)" };
    if (!isEmailSendConfigured()) return { sent: false, reason: "envio de email (Gmail) não configurado" };
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
        message: "⚠️ Aviso de receção automático NÃO enviado (falha no envio pelo Gmail).",
      } as any).catch(() => {});
      return { sent: false, reason: "falha no envio (Gmail)" };
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

// ─── Aviso de reclamação nova ────────────────────────────────────────────────

/**
 * Reclamação nova → backoffice, frontoffice e supervisores DA CIDADE da
 * reclamação (+ quem vê todas as cidades) e, se já tiver responsável, essa
 * pessoa (é assim que o team leader recebe: só quando é o responsável).
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
      projectId: complaints.projectId,
    })
    .from(complaints)
    .where(eq(complaints.id, complaintId))
    .limit(1);
  if (!c) return;
  const { notify } = await import("./notify");
  await notify({
    kind: "complaint_new",
    projectId: c.projectId ?? null,
    alsoUserIds: await assigneeUserIds([c.assignedToId]),
    title: `Nova reclamação: ${c.title}`,
    body: `Tipo: ${c.complaintType} · Prioridade: ${c.complaintPriority}${c.clientName ? ` · Cliente: ${c.clientName}` : ""}`,
    link: `/reclamacoes?id=${complaintId}`,
    entity: { type: "complaint", id: complaintId },
  });
}
