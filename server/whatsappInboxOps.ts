/**
 * Inbox de WhatsApp — operações da migração 0097: estado + atribuição,
 * badge da sidebar, alertas de SLA/janela (UI + aviso por cidade no cron),
 * ligação a reserva/cliente, respostas rápidas e IA (resumo / sugestão).
 *
 * Regras puras em shared/whatsappConversation.ts (testadas). A guarda de
 * cidade das conversas é a de whatsappInbox (`visibilitySql` /
 * `conversationVisible`), chamada pelo router antes de cada operação.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { projectScope, scopedProjectIds } from "./cityScope";
import {
  employees,
  multiparkBookings,
  users,
  whatsappConversations,
  whatsappMessages,
  whatsappQuickReplies,
} from "../drizzle/schema";
import { visibilitySql } from "./whatsappInbox";
import { last9Digits } from "./whatsappInbound";
import { messageDisplayBody, firstNameOf } from "../shared/whatsappTemplate";
import { parseSlaMinutes, formatWaiting, type ConversationStatus } from "../shared/whatsappConversation";
import { effectiveSlaMinutes } from "../shared/commsAi";

function nowStr(d: Date = new Date()): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export function slaMinutes(): number {
  return parseSlaMinutes(process.env.WHATSAPP_SLA_MINUTES);
}

/** Papéis a quem se pode atribuir uma conversa (os mesmos que recebem avisos do backoffice). */
const ASSIGNABLE_ROLES = ["super_admin", "admin", "supervisor", "backoffice"] as const;

// ─── Estado + atribuição ────────────────────────────────────────────────────

export async function setConversationStatus(conversationId: number, status: ConversationStatus): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = nowStr();
  const [res] = await db
    .update(whatsappConversations)
    .set({
      status,
      statusChangedAt: now,
      resolvedAt: status === "resolvido" ? now : null,
      // Resolver = tratado: deixa de contar como "por ler" e "por responder"
      // (se o contacto voltar a escrever, o SLA conta a partir daí).
      ...(status === "resolvido" ? { unreadCount: 0, awaitingSince: null, slaAlertedAt: null } : {}),
    })
    .where(eq(whatsappConversations.id, conversationId));
  return Number((res as { affectedRows?: number }).affectedRows ?? 0) > 0;
}

export async function listAssignees(): Promise<{ id: number; name: string }[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(
      sql`${users.role} IN (${sql.join(ASSIGNABLE_ROLES.map((r) => sql`${r}`), sql`, `)}) AND ${users.isActive} = 1`,
    );
  return rows
    .map((r) => ({ id: r.id, name: (r.name || r.email || `#${r.id}`).trim() }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt"));
}

/** Atribui (ou tira, com null). Devolve false se o utilizador não for atribuível. */
export async function assignConversation(conversationId: number, userId: number | null): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  if (userId != null) {
    const ok = (await listAssignees()).some((u) => u.id === userId);
    if (!ok) return false;
  }
  await db.update(whatsappConversations).set({ assignedUserId: userId }).where(eq(whatsappConversations.id, conversationId));
  return true;
}

/** Quem responde a uma conversa sem responsável fica com ela. */
export async function claimIfUnassigned(conversationId: number, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(whatsappConversations)
    .set({ assignedUserId: userId })
    .where(and(eq(whatsappConversations.id, conversationId), sql`${whatsappConversations.assignedUserId} IS NULL`));
}

// ─── Badge da sidebar ───────────────────────────────────────────────────────

/**
 * Conversas visíveis ao utilizador que precisam de atenção — a mesma regra de
 * `conversationAlerts().needsAttention`, em SQL: por ler (não resolvidas) ou
 * abertas e por responder (sem opt-out). `overdue` = por responder há mais
 * do que o SLA.
 */
export async function inboxBadge(now: Date = new Date()): Promise<{ attention: number; overdue: number; slaMinutes: number }> {
  const sla = slaMinutes();
  const db = await getDb();
  if (!db) return { attention: 0, overdue: 0, slaMinutes: sla };
  const cutoff = nowStr(new Date(now.getTime() - sla * 60_000));
  const c = whatsappConversations;
  const unanswered = sql`(${c.status} = 'aberto' AND ${c.awaitingSince} IS NOT NULL AND ${c.optedOutAt} IS NULL)`;
  const [row] = await db
    .select({
      attention: sql<number>`COALESCE(SUM(CASE WHEN (${c.status} <> 'resolvido' AND ${c.unreadCount} > 0) OR ${unanswered} THEN 1 ELSE 0 END), 0)`,
      overdue: sql<number>`COALESCE(SUM(CASE WHEN ${unanswered} AND ${c.awaitingSince} <= ${cutoff} THEN 1 ELSE 0 END), 0)`,
    })
    .from(c)
    .leftJoin(employees, eq(c.employeeId, employees.id))
    .where(visibilitySql(scopedProjectIds()));
  return { attention: Number(row?.attention ?? 0), overdue: Number(row?.overdue ?? 0), slaMinutes: sla };
}

// ─── Ligação a reserva / cliente ────────────────────────────────────────────

export interface LinkableBooking {
  id: number;
  bookingNumber: string | null;
  clientName: string;
  clientEmail: string | null;
  licensePlate: string | null;
  checkIn: string | null;
  checkOut: string | null;
  parkName: string | null;
  status: string | null;
}

const bookingCols = {
  id: multiparkBookings.id,
  bookingNumber: multiparkBookings.bookingNumber,
  firstName: multiparkBookings.clientFirstName,
  lastName: multiparkBookings.clientLastName,
  clientEmail: multiparkBookings.clientEmail,
  licensePlate: multiparkBookings.licensePlate,
  checkIn: multiparkBookings.checkIn,
  checkOut: multiparkBookings.checkOut,
  parkName: multiparkBookings.parkName,
  status: multiparkBookings.status,
  projectId: multiparkBookings.projectId,
};

function toLinkable(r: any): LinkableBooking {
  return {
    id: r.id,
    bookingNumber: r.bookingNumber ?? null,
    clientName: [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || "—",
    clientEmail: r.clientEmail ?? null,
    licensePlate: r.licensePlate ?? null,
    checkIn: r.checkIn ?? null,
    checkOut: r.checkOut ?? null,
    parkName: r.parkName ?? null,
    status: r.status ?? null,
  };
}

/** Reserva por id, dentro das cidades do utilizador (null se não vê). */
async function bookingInScope(bookingId: number) {
  const db = await getDb();
  if (!db) return null;
  const [r] = await db
    .select(bookingCols)
    .from(multiparkBookings)
    .where(and(eq(multiparkBookings.id, bookingId), projectScope(multiparkBookings.projectId)))
    .limit(1);
  return r ?? null;
}

/**
 * Pesquisa de reservas para ligar à mão: nº da reserva, matrícula, email,
 * telefone (últimos 9 dígitos) ou nome. Só as cidades do utilizador.
 */
export async function searchLinkableBookings(q: string): Promise<LinkableBooking[]> {
  const db = await getDb();
  const term = q.trim();
  if (!db || term.length < 2) return [];
  const like = `%${term.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
  const digits = term.replace(/\D/g, "");
  const plate = term.replace(/[\s-]+/g, "").toUpperCase();
  const conds = [
    sql`${multiparkBookings.bookingNumber} LIKE ${like}`,
    sql`${multiparkBookings.externalId} = ${term}`,
    sql`UPPER(REPLACE(REPLACE(TRIM(${multiparkBookings.licensePlate}), ' ', ''), '-', '')) = ${plate}`,
    sql`LOWER(TRIM(${multiparkBookings.clientEmail})) = ${term.toLowerCase()}`,
    sql`CONCAT_WS(' ', ${multiparkBookings.clientFirstName}, ${multiparkBookings.clientLastName}) LIKE ${like}`,
  ];
  if (digits.length >= 9) {
    conds.push(sql`RIGHT(REGEXP_REPLACE(COALESCE(${multiparkBookings.clientPhone}, ''), '[^0-9]', ''), 9) = ${digits.slice(-9)}`);
  }
  const rows = await db
    .select(bookingCols)
    .from(multiparkBookings)
    .where(and(sql`(${sql.join(conds, sql` OR `)})`, projectScope(multiparkBookings.projectId)))
    .orderBy(desc(multiparkBookings.checkIn))
    .limit(15);
  return rows.map(toLinkable);
}

export type LinkTarget = { bookingId: number } | { clientEmail: string } | null;

/**
 * Liga a conversa a uma reserva (e ao cliente dessa reserva, pelo email) ou só
 * a um cliente (email); null desliga. Número solto sem cidade: a cidade da
 * reserva passa a ser a da conversa (quem ligou vê a reserva → é da cidade dele).
 */
export async function linkConversation(conversationId: number, target: LinkTarget): Promise<{ ok: boolean; error?: string }> {
  const db = await getDb();
  if (!db) return { ok: false, error: "Base de dados indisponível." };
  if (target == null) {
    await db
      .update(whatsappConversations)
      .set({ linkedBookingId: null, linkedClientEmail: null })
      .where(eq(whatsappConversations.id, conversationId));
    return { ok: true };
  }
  if ("clientEmail" in target) {
    const email = target.clientEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "Email inválido." };
    await db
      .update(whatsappConversations)
      .set({ linkedBookingId: null, linkedClientEmail: email })
      .where(eq(whatsappConversations.id, conversationId));
    return { ok: true };
  }
  const b = await bookingInScope(target.bookingId);
  if (!b) return { ok: false, error: "Reserva não encontrada." };
  await db
    .update(whatsappConversations)
    .set({ linkedBookingId: b.id, linkedClientEmail: b.clientEmail?.trim().toLowerCase() || null })
    .where(eq(whatsappConversations.id, conversationId));
  if (b.projectId != null) {
    await db
      .update(whatsappConversations)
      .set({ bookingProjectId: b.projectId, bookingCheckedAt: nowStr() })
      .where(
        and(
          eq(whatsappConversations.id, conversationId),
          sql`${whatsappConversations.employeeId} IS NULL AND ${whatsappConversations.bookingProjectId} IS NULL`,
        ),
      );
  }
  return { ok: true };
}

/**
 * Contexto do contacto para o painel: reserva ligada + sugestões pelo
 * telefone (reservas, reclamações, perdidos & achados) e pelo email ligado.
 * Reutiliza `getClientHistory` (já com o filtro de cidade).
 */
export async function getConversationContext(conversationId: number) {
  const db = await getDb();
  if (!db) return null;
  const [conv] = await db
    .select({
      phoneE164: whatsappConversations.phoneE164,
      linkedBookingId: whatsappConversations.linkedBookingId,
      linkedClientEmail: whatsappConversations.linkedClientEmail,
    })
    .from(whatsappConversations)
    .where(eq(whatsappConversations.id, conversationId))
    .limit(1);
  if (!conv) return null;
  const { getClientHistory } = await import("./db");
  const hasPhone = !!last9Digits(conv.phoneE164);
  const [byPhone, byEmail, linked] = await Promise.all([
    hasPhone ? getClientHistory({ phone: conv.phoneE164 }) : Promise.resolve(null),
    conv.linkedClientEmail ? getClientHistory({ email: conv.linkedClientEmail }) : Promise.resolve(null),
    conv.linkedBookingId ? bookingInScope(conv.linkedBookingId) : Promise.resolve(null),
  ]);
  const dedupe = <T extends { id: number }>(...lists: (T[] | undefined)[]): T[] => {
    const seen = new Set<number>();
    const out: T[] = [];
    for (const l of lists) for (const x of l ?? []) if (!seen.has(x.id)) { seen.add(x.id); out.push(x); }
    return out;
  };
  const bookings = dedupe<any>(byEmail?.bookings, byPhone?.bookings).slice(0, 10).map((b: any) => ({
    id: b.id as number,
    bookingNumber: (b.bookingNumber as string | null) ?? null,
    clientName: [b.clientFirstName, b.clientLastName].filter(Boolean).join(" ").trim() || "—",
    licensePlate: (b.licensePlate as string | null) ?? null,
    checkIn: (b.checkIn as string | null) ?? null,
    checkOut: (b.checkOut as string | null) ?? null,
    parkName: (b.parkName as string | null) ?? null,
    status: (b.status as string | null) ?? null,
  }));
  const complaints = dedupe<any>(byEmail?.complaints, byPhone?.complaints).slice(0, 10).map((c: any) => ({
    id: c.id as number,
    title: String(c.title ?? ""),
    status: String(c.status ?? ""),
    createdAt: (c.createdAt as string | null) ?? null,
  }));
  const lostFound = dedupe<any>(byEmail?.lostFound, byPhone?.lostFound).slice(0, 10).map((l: any) => ({
    id: l.id as number,
    description: String(l.description ?? "").slice(0, 120),
    status: String(l.status ?? ""),
    createdAt: (l.createdAt as string | null) ?? null,
  }));
  return {
    linkedBooking: linked ? toLinkable(linked) : null,
    linkedClientEmail: conv.linkedClientEmail,
    bookings,
    complaints,
    lostFound,
  };
}

// ─── Respostas rápidas ──────────────────────────────────────────────────────

export async function listQuickReplies() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ id: whatsappQuickReplies.id, title: whatsappQuickReplies.title, body: whatsappQuickReplies.body })
    .from(whatsappQuickReplies)
    .orderBy(whatsappQuickReplies.title);
}

export async function saveQuickReply(input: { id?: number | null; title: string; body: string }, userId: number): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const title = input.title.trim().slice(0, 80);
  const body = input.body.trim();
  if (input.id) {
    await db.update(whatsappQuickReplies).set({ title, body }).where(eq(whatsappQuickReplies.id, input.id));
    return input.id;
  }
  const res = await db.insert(whatsappQuickReplies).values({ title, body, createdById: userId });
  return Number((res as any)[0]?.insertId ?? 0) || null;
}

export async function deleteQuickReply(id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(whatsappQuickReplies).where(eq(whatsappQuickReplies.id, id));
}

// ─── IA: resumo e sugestão de resposta ──────────────────────────────────────

export type AiMode = "summary" | "reply";

/** Transcrição para a IA (sem números de telefone). PURA. */
export function buildAiTranscript(
  messages: { direction: "in" | "out"; body: string | null; type?: string | null; templateName?: string | null; mediaType?: string | null }[],
  contactName: string,
  maxChars = 8000,
): string {
  const lines = messages.map((m) => {
    const who = m.direction === "in" ? contactName : "Multipark";
    const text = messageDisplayBody(m).replace(/\s+/g, " ").trim() || "(sem texto)";
    return `${who}: ${text}`;
  });
  // Mantém as mais RECENTES quando é preciso cortar.
  const out: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1;
    if (total > maxChars) break;
    out.unshift(lines[i]);
  }
  return out.join("\n");
}

/**
 * Resumo da conversa ou sugestão de resposta. Só o primeiro nome do contacto
 * e o texto sem dados pessoais (telefones, emails, matrículas… → marcadores)
 * vão para o fornecedor; a resposta repõe os valores (é privada, vai para a
 * caixa de texto e nunca é enviada sozinha).
 */
export async function aiAssist(conversationId: number, mode: AiMode, ctx: { userId?: number | null } = {}): Promise<{ ok: boolean; text?: string; error?: string }> {
  const { runAi } = await import("./_core/ai/run");
  const { aiUserMessage } = await import("./_core/ai/errors");
  const { firstName, redactPii } = await import("./_core/ai/pii");
  const { WHATSAPP_SYSTEM, whatsappInstruction } = await import("./_core/ai/prompts/whatsapp");
  const { getConversationThread } = await import("./whatsappInbox");
  const thread = await getConversationThread(conversationId, 40);
  if (!thread) return { ok: false, error: "Conversa não encontrada." };
  if (!thread.messages.length) return { ok: false, error: "Conversa sem mensagens." };
  const name = firstName(thread.recipientFirstName, "Contacto");
  const red = redactPii(buildAiTranscript(thread.messages, name));
  try {
    const r = await runAi({
      feature: mode === "summary" ? "whatsapp_summary" : "whatsapp_reply",
      system: WHATSAPP_SYSTEM,
      input: `${whatsappInstruction(mode, name)}\n\nConversa:\n${red.text}`,
      maxTokens: mode === "summary" ? 600 : 450,
      timeoutMs: 25_000,
      userId: ctx.userId ?? null,
      entity: "whatsapp_conversation",
      entityId: conversationId,
    });
    const text = red.restore(r.output).trim();
    return { ok: true, text: mode === "reply" ? text.replace(/^["“]|["”]$/g, "").trim().slice(0, 4000) : text.slice(0, 3000) };
  } catch (err: any) {
    return { ok: false, error: aiUserMessage(err) };
  }
}

// ─── Avisos por cidade (cron horário) ───────────────────────────────────────

interface AlertRow { id: number; projectId: number | null; name: string; urgent?: boolean; assignedUserId?: number | null }

/**
 * Conversas abertas por responder há mais do que o SLA (aviso 1× por período
 * sem resposta — `slaAlertedAt`, limpo quando sai uma resposta) e com a janela
 * de 24h a fechar (<2h, aviso 1× por mensagem recebida — `windowAlertedAt`).
 * Uma notificação por cidade (quem tem a cidade no seu âmbito + quem vê todas).
 * WHATSAPP_SLA_NOTIFY=off desliga.
 */
export async function runWhatsappSlaAlerts(now: Date = new Date()): Promise<{ overdue: number; windowClosing: number; notifications: number }> {
  const out = { overdue: 0, windowClosing: 0, notifications: 0 };
  if (String(process.env.WHATSAPP_SLA_NOTIFY ?? "").trim().toLowerCase() === "off") return out;
  const db = await getDb();
  if (!db) return out;
  const sla = slaMinutes();
  const nowS = nowStr(now);
  const slaCutoff = nowStr(new Date(now.getTime() - sla * 60_000));
  // Urgentes (triagem por IA) entram mais cedo no aviso — mesmo aviso, 1× por período.
  const urgentCutoff = nowStr(new Date(now.getTime() - effectiveSlaMinutes(sla, "urgente") * 60_000));
  const recent = nowStr(new Date(now.getTime() - 3 * 24 * 3_600_000));
  const winFrom = nowStr(new Date(now.getTime() - 24 * 3_600_000));
  const winTo = nowStr(new Date(now.getTime() - 22 * 3_600_000));

  // Cidade da conversa: ficha → lead mais recente com cidade → reserva.
  const cityCol = sql<number | null>`COALESCE(e.projectId,
    (SELECT l.projectId FROM extra_leads l WHERE l.phoneE164 = c.phoneE164 COLLATE utf8mb4_unicode_ci AND l.projectId IS NOT NULL ORDER BY l.id DESC LIMIT 1),
    c.bookingProjectId)`;
  const nameCol = sql<string>`COALESCE(NULLIF(TRIM(e.fullName), ''), NULLIF(TRIM(c.profileName), ''), c.phoneE164)`;

  const [overdueRows] = (await db.execute(sql`
    SELECT c.id, ${cityCol} AS projectId, ${nameCol} AS name, c.aiUrgency AS aiUrgency, c.assignedUserId AS assignedUserId
      FROM whatsapp_conversations c LEFT JOIN employees e ON e.id = c.employeeId
     WHERE c.status = 'aberto' AND c.optedOutAt IS NULL AND c.awaitingSince IS NOT NULL
       AND (c.awaitingSince <= ${slaCutoff} OR (c.aiUrgency = 'urgente' AND c.awaitingSince <= ${urgentCutoff}))
       AND c.awaitingSince >= ${recent}
       AND c.slaAlertedAt IS NULL
     ORDER BY c.awaitingSince ASC LIMIT 200`)) as any;
  const [windowRows] = (await db.execute(sql`
    SELECT c.id, ${cityCol} AS projectId, ${nameCol} AS name, c.assignedUserId AS assignedUserId
      FROM whatsapp_conversations c LEFT JOIN employees e ON e.id = c.employeeId
     WHERE c.status <> 'resolvido' AND c.optedOutAt IS NULL AND c.awaitingSince IS NOT NULL
       AND c.lastInboundAt > ${winFrom} AND c.lastInboundAt <= ${winTo}
       AND (c.windowAlertedAt IS NULL OR c.windowAlertedAt < c.lastInboundAt)
     ORDER BY c.lastInboundAt ASC LIMIT 200`)) as any;

  const norm = (rows: any[]): AlertRow[] =>
    (rows ?? []).map((r) => ({ id: Number(r.id), projectId: r.projectId == null ? null : Number(r.projectId), name: String(r.name ?? ""), urgent: r.aiUrgency === "urgente", assignedUserId: r.assignedUserId == null ? null : Number(r.assignedUserId) }));
  const overdue = norm(overdueRows);
  const closing = norm(windowRows);
  out.overdue = overdue.length;
  out.windowClosing = closing.length;
  if (!overdue.length && !closing.length) return out;

  const groups = groupAlertsByCity(overdue, closing);
  const { notify } = await import("./notify");
  for (const g of groups) {
    const { title, body } = describeAlertGroup(g, sla);
    try {
      // Quem tem o WhatsApp NA CIDADE da conversa (team leader+) + o responsável.
      const r = await notify({
        kind: "whatsapp_sla", projectId: g.projectId,
        alsoUserIds: [...g.overdue, ...g.closing].map((x) => x.assignedUserId),
        title, body, link: "/whatsapp",
      });
      if (r.recipients.length) out.notifications++;
    } catch (err: any) {
      console.warn("[WhatsApp SLA] aviso falhou:", String(err?.message ?? err).slice(0, 160));
    }
  }
  const mark = async (ids: number[], col: "slaAlertedAt" | "windowAlertedAt") => {
    if (!ids.length) return;
    await db
      .update(whatsappConversations)
      .set({ [col]: nowS })
      .where(sql`${whatsappConversations.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  };
  await mark(overdue.map((r) => r.id), "slaAlertedAt");
  await mark(closing.map((r) => r.id), "windowAlertedAt");
  return out;
}

export interface AlertGroup { projectId: number | null; overdue: AlertRow[]; closing: AlertRow[] }

/** Agrupa por cidade (null = sem cidade → só quem vê todas as cidades). PURA. */
export function groupAlertsByCity(overdue: AlertRow[], closing: AlertRow[]): AlertGroup[] {
  const map = new Map<string, AlertGroup>();
  const get = (p: number | null) => {
    const k = String(p);
    let g = map.get(k);
    if (!g) { g = { projectId: p, overdue: [], closing: [] }; map.set(k, g); }
    return g;
  };
  for (const r of overdue) get(r.projectId).overdue.push(r);
  for (const r of closing) get(r.projectId).closing.push(r);
  return [...map.values()];
}

/** Título + texto da notificação de um grupo. PURA. */
export function describeAlertGroup(g: AlertGroup, sla: number): { title: string; body: string } {
  const parts: string[] = [];
  const urgent = g.overdue.filter((r) => r.urgent).length;
  if (urgent) parts.push(`${urgent} urgente${urgent > 1 ? "s" : ""} por responder`);
  if (g.overdue.length - urgent > 0) parts.push(`${g.overdue.length - urgent} sem resposta há +${formatWaiting(sla)}`);
  if (g.closing.length) parts.push(`${g.closing.length} com a janela de 24h a fechar`);
  const names = [...g.overdue, ...g.closing].map((r) => firstNameOf(r.name) || r.name);
  const uniq = [...new Set(names)].slice(0, 5);
  const more = new Set(names).size - uniq.length;
  return {
    title: `WhatsApp: ${parts.join(" · ")}`,
    body: `${uniq.join(", ")}${more > 0 ? ` e mais ${more}` : ""}.`,
  };
}
