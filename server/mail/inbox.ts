/**
 * Comunicação — o que a UI usa: caixas visíveis (com contagens), lista de
 * conversas (filtros), conversa (HTML seguro, imagens bloqueadas por
 * omissão), estado/responsável/lida, ligações manuais, envio (Gmail "Enviar
 * como"), rascunho IA, timeline de um registo e contactos do CRM.
 *
 * Acesso: caixas partilhadas → shared/mail.ts (canSeeMailbox + cidade);
 * "O meu email" → só o próprio (o super_admin vê, mas não envia em nome de
 * outro). Nunca devolve tokens.
 */
import { TRPCError } from "@trpc/server";
import { sql, type SQL } from "drizzle-orm";
import {
  MAIL_BRAND_LABELS, MAIL_LINK_MODULE, canActOnMailbox, canSeeMailbox, canSeePersonalMailbox, canSendFromPersonalMailbox, checkSendAs,
  extractAddresses, isCompanyAddress, isMailBrand, mailboxCityRestricted, normalizeAddress, normalizeLinkEntityId, personalAccountKey,
  pickFromAddress, type MailLinkType, type MailViewer, type MailThreadStatus,
} from "../../shared/mail";
import { can, grantFor } from "../../shared/access";
import { projectScope, scopedProjectIds } from "../cityScope";
import {
  addManualLink, db, dbSyncStore, getMailbox, linksForThreads, listMailboxes, nowUtc, recomputeThread, removeLink, rowsOf,
  threadIdsForEntity, type MailboxRow,
} from "./store";
import { sanitizeEmailHtml, wrapEmailDocument } from "./sanitize";
import { buildRawMessage, prefixedSubject, quoteHtml, quoteText, replyReferences, textToHtml } from "./compose";
import type { MailAttachmentMeta } from "./parse";

const forbidden = (message = "Acesso não autorizado.") => new TRPCError({ code: "FORBIDDEN", message });
const notFound = (message = "Conversa não encontrada.") => new TRPCError({ code: "NOT_FOUND", message });
const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

const inList = (ids: readonly (number | string)[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);

export interface ThreadRow {
  id: number; accountKey: string; gmailThreadId: string; mailboxKey: string | null; ownerUserId: number | null; brand: string | null;
  subject: string | null; snippet: string | null; contactEmail: string | null; contactName: string | null; matchedAddress: string | null;
  messageCount: number; unreadCount: number; lastMessageAt: string | null; lastInboundAt: string | null; lastOutboundAt: string | null;
  awaitingSince: string | null; status: MailThreadStatus; assignedUserId: number | null; assignedName: string | null; projectId: number | null;
}

function toThread(r: any): ThreadRow {
  return {
    id: Number(r.id), accountKey: String(r.accountKey), gmailThreadId: String(r.gmailThreadId), mailboxKey: r.mailboxKey ?? null,
    ownerUserId: r.ownerUserId != null ? Number(r.ownerUserId) : null, brand: r.brand ?? null, subject: r.subject ?? null, snippet: r.snippet ?? null,
    contactEmail: r.contactEmail ?? null, contactName: r.contactName ?? null, matchedAddress: r.matchedAddress ?? null,
    messageCount: Number(r.messageCount ?? 0), unreadCount: Number(r.unreadCount ?? 0), lastMessageAt: r.lastMessageAt ?? null,
    lastInboundAt: r.lastInboundAt ?? null, lastOutboundAt: r.lastOutboundAt ?? null, awaitingSince: r.awaitingSince ?? null,
    status: (r.status ?? "aberto") as MailThreadStatus, assignedUserId: r.assignedUserId != null ? Number(r.assignedUserId) : null,
    assignedName: r.assignedName ?? null, projectId: r.projectId != null ? Number(r.projectId) : null,
  };
}

// ─── Acesso a uma conversa ──────────────────────────────────────────────────

export interface ThreadAccess { thread: ThreadRow; mailbox: MailboxRow | null; personal: boolean; canAct: boolean; canSend: boolean }

/** Condição de cidade para quem só vê as conversas ligadas à sua cidade. */
function cityCondition(viewer: MailViewer, mailbox: MailboxRow): SQL {
  if (!mailboxCityRestricted(viewer, mailbox)) return sql`1 = 1`;
  const ids = scopedProjectIds();
  if (ids === undefined) return sql`1 = 1`;
  return ids.length ? sql`t.projectId IN (${inList(ids)})` : sql`1 = 0`;
}

export async function loadThread(threadId: number): Promise<ThreadRow | null> {
  const d = await db();
  const r = rowsOf(await d.execute(sql`SELECT t.*, u.name AS assignedName FROM mail_threads t LEFT JOIN users u ON u.id = t.assignedUserId
    WHERE t.id = ${threadId} LIMIT 1`))[0];
  return r ? toThread(r) : null;
}

export async function threadAccess(viewer: MailViewer, threadId: number): Promise<ThreadAccess> {
  const thread = await loadThread(threadId);
  if (!thread) throw notFound();
  if (thread.ownerUserId != null && !thread.mailboxKey) {
    if (!canSeePersonalMailbox(viewer, thread.ownerUserId)) throw forbidden();
    const own = canSendFromPersonalMailbox(viewer, thread.ownerUserId);
    return { thread, mailbox: null, personal: true, canAct: own, canSend: own };
  }
  const mailbox = await getMailbox(thread.mailboxKey);
  if (!mailbox) {
    // Sem caixa (conta sem "apanha tudo"): só a administração vê.
    if (viewer.role !== "super_admin") throw forbidden();
    return { thread, mailbox: null, personal: false, canAct: true, canSend: false };
  }
  if (!canSeeMailbox(viewer, mailbox)) throw forbidden();
  if (mailboxCityRestricted(viewer, mailbox)) {
    const ids = scopedProjectIds();
    if (ids !== undefined && (thread.projectId == null || !ids.includes(thread.projectId))) throw forbidden("Esta conversa não pertence à tua cidade.");
  }
  const act = canActOnMailbox(viewer, mailbox);
  return { thread, mailbox, personal: false, canAct: act, canSend: act };
}

// ─── Caixas visíveis ────────────────────────────────────────────────────────

export async function visibleMailboxes(viewer: MailViewer) {
  const all = await listMailboxes();
  const visible = all.filter((m) => canSeeMailbox(viewer, m));
  const d = await db();
  const out = [];
  for (const m of visible) {
    const r = rowsOf(await d.execute(sql`SELECT
        SUM(CASE WHEN t.unreadCount > 0 THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN t.awaitingSince IS NOT NULL AND t.status <> 'resolvido' THEN 1 ELSE 0 END) AS awaiting,
        SUM(CASE WHEN t.status = 'aberto' THEN 1 ELSE 0 END) AS open
      FROM mail_threads t WHERE t.mailboxKey = ${m.key} AND ${cityCondition(viewer, m)}`))[0] ?? {};
    out.push({
      key: m.key, label: m.label, module: m.module, brands: Array.from(new Set(m.addresses.map((a) => a.brand))),
      addresses: m.addresses, signatures: m.signatures, canAct: canActOnMailbox(viewer, m), pipeline: m.pipeline,
      unread: Number(r.unread ?? 0), awaiting: Number(r.awaiting ?? 0), open: Number(r.open ?? 0),
    });
  }
  const pr = rowsOf(await d.execute(sql`SELECT SUM(CASE WHEN unreadCount > 0 THEN 1 ELSE 0 END) AS unread FROM mail_threads
    WHERE ownerUserId = ${viewer.id} AND mailboxKey IS NULL`))[0] ?? {};
  return { mailboxes: out, personalUnread: Number(pr.unread ?? 0) };
}

/** Badge do menu: conversas por ler nas caixas visíveis + pessoal. */
export async function mailBadge(viewer: MailViewer): Promise<{ shared: number; personal: number }> {
  const v = await visibleMailboxes(viewer);
  return { shared: v.mailboxes.reduce((s, m) => s + m.unread, 0), personal: v.personalUnread };
}

// ─── Lista de conversas ─────────────────────────────────────────────────────

export interface ThreadListInput {
  mailbox: string;              // chave da caixa ou "me"
  ownerUserId?: number | null;  // "me" de outra pessoa (só super_admin)
  brand?: string | null;
  status?: MailThreadStatus | "all" | null;
  assigned?: "all" | "me" | "none" | number | null;
  awaiting?: boolean;
  unread?: boolean;
  search?: string | null;
  page?: number;
  pageSize?: number;
}

export async function listThreads(viewer: MailViewer, input: ThreadListInput) {
  const conds: SQL[] = [];
  if (input.mailbox === "me") {
    const owner = input.ownerUserId ?? viewer.id;
    if (!canSeePersonalMailbox(viewer, owner)) throw forbidden();
    conds.push(sql`t.ownerUserId = ${owner} AND t.mailboxKey IS NULL`);
  } else {
    const m = await getMailbox(input.mailbox);
    if (!m || !canSeeMailbox(viewer, m)) throw forbidden();
    conds.push(sql`t.mailboxKey = ${m.key}`, cityCondition(viewer, m));
  }
  if (input.brand && isMailBrand(input.brand)) conds.push(sql`t.brand = ${input.brand}`);
  if (input.status && input.status !== "all") conds.push(sql`t.status = ${input.status}`);
  if (input.assigned === "me") conds.push(sql`t.assignedUserId = ${viewer.id}`);
  else if (input.assigned === "none") conds.push(sql`t.assignedUserId IS NULL`);
  else if (typeof input.assigned === "number") conds.push(sql`t.assignedUserId = ${input.assigned}`);
  if (input.awaiting) conds.push(sql`t.awaitingSince IS NOT NULL AND t.status <> 'resolvido'`);
  if (input.unread) conds.push(sql`t.unreadCount > 0`);
  const q = String(input.search ?? "").trim().slice(0, 100);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(sql`(t.subject LIKE ${like} OR t.contactEmail LIKE ${like} OR t.contactName LIKE ${like} OR t.snippet LIKE ${like}
      OR EXISTS (SELECT 1 FROM mail_messages mm WHERE mm.threadId = t.id AND (mm.fromEmail LIKE ${like} OR mm.fromName LIKE ${like})))`);
  }
  const pageSize = Math.min(100, Math.max(10, input.pageSize ?? 40));
  const page = Math.max(1, input.page ?? 1);
  const where = sql.join(conds, sql` AND `);
  const d = await db();
  const [rows, total] = await Promise.all([
    d.execute(sql`SELECT t.*, u.name AS assignedName FROM mail_threads t LEFT JOIN users u ON u.id = t.assignedUserId
      WHERE ${where} ORDER BY t.lastMessageAt DESC, t.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`),
    d.execute(sql`SELECT COUNT(*) AS n FROM mail_threads t WHERE ${where}`),
  ]);
  const threads = rowsOf(rows).map(toThread);
  const links = await linksForThreads(threads.map((t) => t.id));
  return {
    threads: threads.map((t) => ({ ...t, links: links.filter((l) => l.threadId === t.id).map((l) => ({ type: l.entityType, id: l.entityId })) })),
    total: Number(rowsOf(total)[0]?.n ?? 0), page, pageSize,
  };
}

// ─── Conversa ───────────────────────────────────────────────────────────────

function sentAtLabel(s: string | null): string {
  if (!s) return "";
  const d = new Date(s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon", dateStyle: "short", timeStyle: "short" });
}

async function cidImages(accountKey: string, gmailMessageId: string, atts: MailAttachmentMeta[]): Promise<Record<string, string>> {
  const inline = atts.filter((a) => a.contentId && a.attachmentId && a.mimeType.startsWith("image/") && a.size <= 1_000_000).slice(0, 6);
  if (!inline.length) return {};
  const { gmailApiForAccount } = await import("./gmailApi");
  const api = await gmailApiForAccount(accountKey);
  const out: Record<string, string> = {};
  for (const a of inline) {
    try { out[a.contentId!] = `data:${a.mimeType};base64,${(await api.getAttachment(gmailMessageId, a.attachmentId!)).toString("base64")}`; }
    catch { /* fica bloqueada */ }
  }
  return out;
}

export async function getThread(viewer: MailViewer, threadId: number, opts: { showImages?: boolean } = {}) {
  const acc = await threadAccess(viewer, threadId);
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT m.id, m.gmailMessageId, m.rfcMessageId, m.referencesText, m.direction, m.fromName, m.fromEmail, m.toJson, m.ccJson,
      m.subject, m.snippet, m.bodyText, m.bodyHtml, m.attachmentsJson, m.sentAt, m.isRead, m.brand, m.matchedAddress, m.sentById, m.pipeline, m.pipelineStatus,
      u.name AS sentByName
    FROM mail_messages m LEFT JOIN users u ON u.id = m.sentById WHERE m.threadId = ${threadId} ORDER BY m.sentAt, m.id`));
  let blocked = 0;
  const messages = [];
  for (const r of rows) {
    const atts: MailAttachmentMeta[] = (() => { try { return JSON.parse(r.attachmentsJson || "[]"); } catch { return []; } })();
    let cidMap: Record<string, string> = {};
    if (opts.showImages && r.bodyHtml && atts.some((a) => a.contentId)) {
      cidMap = await cidImages(acc.thread.accountKey, String(r.gmailMessageId), atts).catch(() => ({}));
    }
    const s = r.bodyHtml ? sanitizeEmailHtml(String(r.bodyHtml), { showImages: !!opts.showImages, cidMap }) : null;
    blocked += s?.blockedImages ?? 0;
    messages.push({
      id: Number(r.id), direction: r.direction === "out" ? "out" as const : "in" as const, fromName: r.fromName ?? null, fromEmail: r.fromEmail ?? null,
      to: (() => { try { return JSON.parse(r.toJson || "[]") as string[]; } catch { return []; } })(),
      cc: (() => { try { return JSON.parse(r.ccJson || "[]") as string[]; } catch { return []; } })(),
      subject: r.subject ?? "", snippet: r.snippet ?? "", text: String(r.bodyText ?? "").slice(0, 100_000),
      htmlDocument: s ? wrapEmailDocument(s.html, { showImages: !!opts.showImages }) : null,
      blockedImages: s?.blockedImages ?? 0,
      attachments: atts.filter((a) => !a.inline || !a.contentId).map((a) => ({
        index: a.index, filename: a.filename, mimeType: a.mimeType, size: a.size, href: `/api/mail/attachment/${Number(r.id)}/${a.index}`,
      })),
      sentAt: r.sentAt ?? null, isRead: Number(r.isRead) === 1, brand: r.brand ?? null, sentByName: r.sentByName ?? null,
      pipeline: r.pipeline ?? null, pipelineStatus: r.pipelineStatus ?? null,
      rfcMessageId: r.rfcMessageId ?? null,
    });
  }
  const links = await linksForThreads([threadId]);
  // Destinatários sugeridos para "Responder" / "Responder a todos".
  let fromOptions: string[] = [];
  let defaultFrom: string | null = null;
  if (acc.mailbox) {
    fromOptions = acc.mailbox.addresses.map((a) => a.address);
    defaultFrom = pickFromAddress(acc.mailbox, { matchedAddress: acc.thread.matchedAddress, brand: isMailBrand(acc.thread.brand) ? acc.thread.brand : null });
  } else if (acc.personal) {
    const g = rowsOf(await d.execute(sql`SELECT email FROM google_user_accounts WHERE userId = ${acc.thread.ownerUserId} LIMIT 1`))[0];
    defaultFrom = g?.email ?? null;
    fromOptions = defaultFrom ? [defaultFrom] : [];
  }
  const own = new Set(fromOptions.map(normalizeAddress));
  const lastIn = [...messages].reverse().find((m) => m.direction === "in");
  const replyTo = lastIn?.fromEmail ? [lastIn.fromEmail] : acc.thread.contactEmail ? [acc.thread.contactEmail] : [];
  const replyAllCc = lastIn ? [...lastIn.to, ...lastIn.cc].filter((a) => !own.has(normalizeAddress(a)) && !replyTo.includes(a)) : [];
  const brand = isMailBrand(acc.thread.brand) ? acc.thread.brand : null;
  return {
    thread: acc.thread,
    mailbox: acc.mailbox ? { key: acc.mailbox.key, label: acc.mailbox.label, module: acc.mailbox.module } : null,
    personal: acc.personal,
    canAct: acc.canAct,
    canSend: acc.canSend,
    messages,
    blockedImages: blocked,
    links: links.map((l) => ({ type: l.entityType, id: l.entityId, confidence: l.confidence, source: l.source, reason: l.reason })),
    compose: {
      fromOptions, defaultFrom, replyTo, replyAllCc: Array.from(new Set(replyAllCc)),
      subject: acc.thread.subject ?? "",
      signature: acc.mailbox && brand ? acc.mailbox.signatures[brand] ?? "" : acc.mailbox ? Object.values(acc.mailbox.signatures)[0] ?? "" : "",
      brandLabel: brand ? MAIL_BRAND_LABELS[brand] : null,
    },
  };
}

// ─── Ações ──────────────────────────────────────────────────────────────────

async function requireAct(viewer: MailViewer, threadId: number): Promise<ThreadAccess> {
  const acc = await threadAccess(viewer, threadId);
  if (!acc.canAct) throw forbidden("Só podes ver esta conversa.");
  return acc;
}

export async function markThreadRead(viewer: MailViewer, threadId: number, read: boolean): Promise<void> {
  const acc = await threadAccess(viewer, threadId);
  // Consultar a caixa pessoal de outra pessoa (super_admin) não mexe no estado dela.
  if (acc.personal && !acc.canAct) return;
  // Ler (abrir) chega para marcar como lida; "não lida" pede poder agir.
  if (!read && !acc.canAct) throw forbidden();
  const d = await db();
  const ids = rowsOf(await d.execute(sql`SELECT gmailMessageId FROM mail_messages WHERE threadId = ${threadId} AND direction = 'in' AND isRead = ${read ? 0 : 1}
    ORDER BY sentAt DESC LIMIT ${read ? 100 : 1}`)).map((r) => String(r.gmailMessageId));
  if (!ids.length) return;
  await d.execute(sql`UPDATE mail_messages SET isRead = ${read ? 1 : 0} WHERE threadId = ${threadId} AND gmailMessageId IN (${inList(ids)})`);
  await recomputeThread(threadId);
  // Espelha no Gmail (best-effort: a conta pode estar sem rede/token).
  try {
    const { gmailApiForAccount } = await import("./gmailApi");
    const api = await gmailApiForAccount(acc.thread.accountKey);
    for (const id of ids.slice(0, 20)) await api.modifyLabels(id, read ? [] : ["UNREAD"], read ? ["UNREAD"] : []);
  } catch { /* fica só no dashboard */ }
}

export async function setThreadStatus(viewer: MailViewer, threadId: number, status: MailThreadStatus): Promise<void> {
  await requireAct(viewer, threadId);
  const d = await db();
  await d.execute(sql`UPDATE mail_threads SET status = ${status}, statusChangedAt = ${nowUtc()} WHERE id = ${threadId}`);
}

export async function assignThread(viewer: MailViewer, threadId: number, userId: number | null): Promise<void> {
  const acc = await requireAct(viewer, threadId);
  if (acc.personal && userId != null && userId !== viewer.id) throw bad("Conversas do teu email pessoal não se atribuem a outra pessoa.");
  const d = await db();
  if (userId != null) {
    const u = rowsOf(await d.execute(sql`SELECT id, role, isActive FROM users WHERE id = ${userId} LIMIT 1`))[0];
    if (!u || Number(u.isActive) !== 1) throw bad("Utilizador inválido.");
    if (acc.mailbox) {
      const { getUserModuleOverrides } = await import("../db");
      const target: MailViewer = { id: Number(u.id), role: String(u.role), accessOverrides: await getUserModuleOverrides(Number(u.id)).catch(() => ({})) };
      if (!canSeeMailbox(target, acc.mailbox)) throw bad("Essa pessoa não tem acesso a esta caixa.");
    }
  }
  await d.execute(sql`UPDATE mail_threads SET assignedUserId = ${userId} WHERE id = ${threadId}`);
  if (userId != null && userId !== viewer.id && acc.mailbox) {
    const { notify } = await import("../notify");
    await notify({
      kind: "mail_assigned", targetUserId: userId,
      title: `Email atribuído: ${acc.thread.subject ?? "(sem assunto)"}`.slice(0, 255),
      body: `${acc.mailbox.label} — ${acc.thread.contactName ?? acc.thread.contactEmail ?? ""}`.trim(),
      link: `/comunicacao?caixa=${encodeURIComponent(acc.mailbox.key)}&t=${threadId}`,
      entity: { type: "mail_thread", id: threadId },
    }).catch(() => {});
  }
}

/** Quem pode ser responsável numa caixa (ativos com acesso). */
export async function assigneesFor(viewer: MailViewer, mailboxKey: string) {
  const m = await getMailbox(mailboxKey);
  if (!m || !canSeeMailbox(viewer, m)) throw forbidden();
  const d = await db();
  // Pelo papel (uma consulta); quem só tem acesso por override pode ser
  // atribuído na mesma — assignThread valida a pessoa com os overrides.
  const users = rowsOf(await d.execute(sql`SELECT id, name, role FROM users WHERE isActive = 1 AND role IN ('team_leader','supervisor','frontoffice','backoffice','admin','super_admin') ORDER BY name LIMIT 500`));
  return users
    .filter((u) => canSeeMailbox({ id: Number(u.id), role: String(u.role), accessOverrides: null }, m))
    .map((u) => ({ id: Number(u.id), name: String(u.name ?? `#${u.id}`) }));
}

// ─── Ligações manuais ───────────────────────────────────────────────────────

async function resolveEntity(type: MailLinkType, raw: string): Promise<string> {
  const id = normalizeLinkEntityId(type, raw);
  if (!id) throw bad("Identificador inválido.");
  const d = await db();
  if (type === "client") {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id)) throw bad("Indica o email do cliente.");
    return id;
  }
  if (type === "booking") {
    const r = rowsOf(await d.execute(sql`SELECT externalId FROM multipark_bookings WHERE externalId = ${id} OR bookingNumber = ${id} LIMIT 1`))[0];
    if (!r) throw bad("Reserva não encontrada (usa a referência ou o nº da reserva).");
    return String(r.externalId);
  }
  const table = type === "complaint" ? sql`complaints` : type === "lost_found" ? sql`lost_found_items` : sql`incidents`;
  const r = rowsOf(await d.execute(sql`SELECT id FROM ${table} WHERE id = ${Number(id)} LIMIT 1`))[0];
  if (!r) throw bad("Registo não encontrado.");
  return String(r.id);
}

export async function linkThread(viewer: MailViewer, threadId: number, type: MailLinkType, rawId: string): Promise<{ entityId: string }> {
  await requireAct(viewer, threadId);
  const entityId = await resolveEntity(type, rawId);
  await addManualLink({ threadId, entityType: type, entityId, userId: viewer.id });
  return { entityId };
}

export async function unlinkThread(viewer: MailViewer, threadId: number, type: MailLinkType, entityId: string): Promise<void> {
  await requireAct(viewer, threadId);
  await removeLink({ threadId, entityType: type, entityId: normalizeLinkEntityId(type, entityId), userId: viewer.id });
}

// ─── Envio ──────────────────────────────────────────────────────────────────

export interface SendInput {
  mode: "reply" | "replyAll" | "forward" | "new";
  threadId?: number | null;
  /** Para "new": caixa partilhada ou "me". */
  mailbox?: string | null;
  from?: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | null;
  body: string;
  /** Ficheiros já carregados por /api/upload (key + nome + tipo). */
  attachments: Array<{ key: string; filename: string; contentType: string }>;
  /** Reencaminhar: juntar os anexos da mensagem original. */
  includeOriginalAttachments?: boolean;
}

const MAX_ATTACH_BYTES = 20 * 1024 * 1024;

function cleanList(list: readonly string[]): string[] {
  return Array.from(new Set(list.flatMap((x) => extractAddresses(x)))).slice(0, 50);
}

async function uploadedBytes(key: string): Promise<Buffer> {
  if (!/^uploads\/[\w.\-]+$/.test(key)) throw bad("Anexo inválido.");
  const { storagePresignGet } = await import("../storage");
  const { url } = await storagePresignGet(key);
  if (/^https?:\/\//.test(url)) {
    const { fetchWithTimeout } = await import("../_core/fetchWithTimeout");
    const res = await fetchWithTimeout(url, { timeoutMs: 15_000 });
    if (!res.ok) throw bad("Não foi possível ler um anexo carregado.");
    return Buffer.from(await res.arrayBuffer());
  }
  const fs = await import("fs");
  const path = await import("path");
  const root = path.resolve(process.cwd(), "uploads");
  const p = path.resolve(root, key.replace(/^uploads\//, ""));
  if (!p.startsWith(root)) throw bad("Anexo inválido.");
  return fs.promises.readFile(p);
}

export async function sendMail(viewer: MailViewer, input: SendInput): Promise<{ threadId: number; gmailMessageId: string }> {
  const to = cleanList(input.to), cc = cleanList(input.cc), bcc = cleanList(input.bcc);
  if (!to.length && !cc.length && !bcc.length) throw bad("Indica pelo menos um destinatário.");
  if (!input.body.trim()) throw bad("A mensagem está vazia.");

  // Contexto: conversa existente (responder/reencaminhar) ou caixa (novo).
  let accountKey: string;
  let mailbox: MailboxRow | null = null;
  let personal = false;
  let gmailThreadId: string | null = null;
  let threadRow: ThreadRow | null = null;
  let original: any = null;
  if (input.mode !== "new") {
    if (!input.threadId) throw bad("Conversa em falta.");
    const acc = await threadAccess(viewer, input.threadId);
    if (!acc.canSend) throw forbidden(acc.personal ? "Só o próprio envia pelo seu email." : "Sem permissão para responder nesta caixa.");
    accountKey = acc.thread.accountKey; mailbox = acc.mailbox; personal = acc.personal; threadRow = acc.thread;
    const d = await db();
    original = rowsOf(await d.execute(sql`SELECT * FROM mail_messages WHERE threadId = ${acc.thread.id}
      ORDER BY (direction = 'in') DESC, sentAt DESC, id DESC LIMIT 1`))[0] ?? null;
    if (input.mode !== "forward") gmailThreadId = acc.thread.gmailThreadId;
  } else if (input.mailbox === "me") {
    if (!canSendFromPersonalMailbox(viewer, viewer.id)) throw forbidden();
    accountKey = personalAccountKey(viewer.id); personal = true;
  } else {
    const m = await getMailbox(input.mailbox);
    if (!m || !canActOnMailbox(viewer, m)) throw forbidden("Sem permissão para enviar por esta caixa.");
    const { sourceAccountKey } = await import("../../shared/mail");
    const key = sourceAccountKey(m);
    if (!key) throw bad("A caixa não tem conta Google de origem configurada.");
    accountKey = key; mailbox = m;
  }

  // Endereço de envio + verificação do "Enviar como" na conta Gmail.
  const { gmailApiForAccount } = await import("./gmailApi");
  const api = await gmailApiForAccount(accountKey);
  const brand = isMailBrand(threadRow?.brand) ? threadRow!.brand as any : null;
  let from: string | null;
  if (mailbox) from = pickFromAddress(mailbox, { requested: input.from, matchedAddress: threadRow?.matchedAddress, brand });
  else {
    const d = await db();
    const g = rowsOf(await d.execute(sql`SELECT email FROM google_user_accounts WHERE userId = ${viewer.id} LIMIT 1`))[0];
    from = normalizeAddress(input.from) || normalizeAddress(g?.email) || null;
  }
  const sendAs = await api.listSendAs();
  const account = (await api.getProfile()).emailAddress ?? accountKey;
  const check = checkSendAs(from, account, sendAs);
  if (!check.ok) throw bad(check.error);

  // Corpo + citação + cabeçalhos de resposta.
  const subject = input.mode === "new"
    ? (String(input.subject ?? "").trim() || "(sem assunto)").slice(0, 300)
    : input.subject?.trim() ? input.subject.trim().slice(0, 300) : prefixedSubject(threadRow?.subject ?? original?.subject, input.mode === "forward" ? "Fwd" : "Re");
  let text = input.body.replace(/\r\n/g, "\n");
  let html = textToHtml(text);
  let inReplyTo: string | null = null;
  let references: string[] = [];
  if (original) {
    const q = { fromName: original.fromName ?? null, fromEmail: original.fromEmail ?? null, sentAtLabel: sentAtLabel(original.sentAt ?? null), text: String(original.bodyText ?? original.snippet ?? "") };
    text += quoteText(q);
    html += quoteHtml(q);
    if (input.mode !== "forward") {
      inReplyTo = original.rfcMessageId ?? null;
      references = replyReferences({ rfcMessageId: original.rfcMessageId ?? null, references: String(original.referencesText ?? "").split(/\s+/).filter(Boolean) });
    }
  }
  const attachments: Array<{ filename: string; contentType: string; content: Buffer }> = [];
  let total = 0;
  for (const a of input.attachments.slice(0, 10)) {
    const content = await uploadedBytes(a.key);
    total += content.length;
    if (total > MAX_ATTACH_BYTES) throw bad("Anexos acima de 20 MB.");
    attachments.push({ filename: a.filename.slice(0, 200) || "anexo", contentType: a.contentType || "application/octet-stream", content });
  }
  if (input.mode === "forward" && input.includeOriginalAttachments && original?.attachmentsJson) {
    const metas: MailAttachmentMeta[] = (() => { try { return JSON.parse(original.attachmentsJson); } catch { return []; } })();
    for (const a of metas.filter((x) => x.attachmentId && !x.inline).slice(0, 10)) {
      const content = await api.getAttachment(String(original.gmailMessageId), a.attachmentId!);
      total += content.length;
      if (total > MAX_ATTACH_BYTES) throw bad("Anexos acima de 20 MB.");
      attachments.push({ filename: a.filename, contentType: a.mimeType, content });
    }
  }
  const raw = await buildRawMessage({
    from: { name: check.displayName || (brand ? MAIL_BRAND_LABELS[brand as keyof typeof MAIL_BRAND_LABELS] : null), address: check.email },
    to, cc, bcc, subject, text, html, inReplyTo, references, attachments,
  });
  const sent = await api.sendRaw(raw, gmailThreadId);

  // Guarda já a mensagem enviada (a sincronização depois só a reconhece).
  const msg = await api.getMessage(sent.id).catch(() => null);
  let threadId = threadRow?.id ?? 0;
  if (msg) {
    const { parseGmailMessage } = await import("./parse");
    const p = parseGmailMessage(msg, { accountEmail: account });
    p.outbound = true;
    const r = await dbSyncStore.storeMessage(accountKey, p, {
      mailboxKey: mailbox?.key ?? null, brand: brand ?? (mailbox?.addresses.find((a) => normalizeAddress(a.address) === check.email)?.brand ?? null),
      matchedAddress: check.email, personal,
    }, { ownerUserId: personal ? viewer.id : null, automated: false, contactEmail: to.find((a) => !isCompanyAddress(a)) ?? null, contactName: null });
    threadId = r.threadId || threadId;
    const d = await db();
    if (r.messageId) await d.execute(sql`UPDATE mail_messages SET sentById = ${viewer.id} WHERE id = ${r.messageId}`);
    if (input.mode === "forward" && threadRow) {
      // Reencaminhar cria outra conversa no Gmail: herda as ligações da original.
      const links = await linksForThreads([threadRow.id]);
      const { addAutoLink } = await import("./store");
      for (const l of links) await addAutoLink({ threadId, messageId: r.messageId, entityType: l.entityType, entityId: l.entityId, confidence: l.confidence, reason: "reencaminhado de outra conversa" });
    }
  }
  try {
    const { logActivity } = await import("../db");
    await logActivity({
      userId: viewer.id, action: "send", entity: "mail_message", entityId: threadId || null,
      details: `${input.mode} de ${check.email} para ${[...to, ...cc].join(", ")}${bcc.length ? ` (+${bcc.length} bcc)` : ""} — ${subject}`.slice(0, 1000),
    } as any);
  } catch { /* o registo não parte o envio */ }
  return { threadId, gmailMessageId: sent.id };
}

// ─── Rascunho IA ────────────────────────────────────────────────────────────

export async function aiDraft(viewer: MailViewer, threadId: number): Promise<{ ok: boolean; text?: string; error?: string }> {
  const acc = await threadAccess(viewer, threadId);
  if (!acc.canSend) throw forbidden();
  const d = await db();
  const msgs = rowsOf(await d.execute(sql`SELECT direction, fromName, bodyText, snippet FROM mail_messages WHERE threadId = ${threadId} ORDER BY sentAt DESC, id DESC LIMIT 8`)).reverse();
  if (!msgs.length) return { ok: false, error: "Conversa sem mensagens." };
  const { runAi } = await import("../_core/ai/run");
  const { aiUserMessage } = await import("../_core/ai/errors");
  const { firstName, redactPii } = await import("../_core/ai/pii");
  const { MAIL_SYSTEM, mailReplyInstruction } = await import("../_core/ai/prompts/mail");
  const name = firstName(acc.thread.contactName, "Cliente");
  const brand = isMailBrand(acc.thread.brand) ? MAIL_BRAND_LABELS[acc.thread.brand] : "Multipark";
  const transcript = msgs.map((m) => {
    const who = m.direction === "in" ? name : brand;
    const body = String(m.bodyText || m.snippet || "").replace(/\n>.*$/gms, "").replace(/\s+\n/g, "\n").trim().slice(0, 1500);
    return `${who}:\n${body}`;
  }).join("\n\n---\n\n").slice(-9000);
  const red = redactPii(transcript);
  try {
    const r = await runAi({
      feature: "mail_reply", system: MAIL_SYSTEM, input: `${mailReplyInstruction(name, brand)}\n\nConversa:\n${red.text}`,
      maxTokens: 700, timeoutMs: 25_000, userId: viewer.id, entity: "mail_thread", entityId: threadId,
    });
    return { ok: true, text: red.restore(r.output).trim().slice(0, 6000) };
  } catch (err) {
    return { ok: false, error: aiUserMessage(err) };
  }
}

// ─── Timeline de um registo (cliente, reserva, reclamação, perdido, ocorrência) ──

/** O registo está no âmbito (cidade) de quem pede? Papéis nacionais: sempre. */
async function assertEntityInScope(type: MailLinkType, entityId: string): Promise<void> {
  const ids = scopedProjectIds();
  if (ids === undefined) return;
  const d = await db();
  const inScope = ids.length ? sql`IN (${inList(ids)})` : sql`IN (NULL)`;
  let ok = false;
  if (type === "client") {
    ok = rowsOf(await d.execute(sql`SELECT 1 AS x FROM multipark_bookings WHERE LOWER(TRIM(clientEmail)) = ${entityId} AND projectId ${inScope} LIMIT 1`)).length > 0;
  } else if (type === "booking") {
    ok = rowsOf(await d.execute(sql`SELECT 1 AS x FROM multipark_bookings WHERE externalId = ${entityId} AND projectId ${inScope} LIMIT 1`)).length > 0;
  } else {
    const table = type === "complaint" ? sql`complaints` : type === "lost_found" ? sql`lost_found_items` : sql`incidents`;
    ok = rowsOf(await d.execute(sql`SELECT 1 AS x FROM ${table} WHERE id = ${Number(entityId)} AND projectId ${inScope} LIMIT 1`)).length > 0;
  }
  if (!ok) throw forbidden("Este registo não pertence à tua cidade.");
}

export async function entityTimeline(viewer: MailViewer, type: MailLinkType, rawId: string) {
  // Só quem vê o módulo para além do que é seu (o alcance "own" não chega para ler emails de clientes).
  const g = grantFor(viewer, MAIL_LINK_MODULE[type]);
  if (g.access === "none" || g.access === "own" || !g.actions.includes("view")) throw forbidden();
  const entityId = normalizeLinkEntityId(type, rawId);
  if (!entityId) return { items: [] as TimelineItem[] };
  await assertEntityInScope(type, entityId);
  const ids = await threadIdsForEntity(type, entityId, 40);
  const items: TimelineItem[] = [];
  const d = await db();
  if (ids.length) {
    const threads = rowsOf(await d.execute(sql`SELECT * FROM mail_threads WHERE id IN (${inList(ids)})`)).map(toThread);
    const mailboxes = await listMailboxes();
    const allowed = new Map<number, { label: string; canOpen: boolean; mailboxKey: string | null }>();
    for (const t of threads) {
      if (t.mailboxKey) {
        const m = mailboxes.find((x) => x.key === t.mailboxKey);
        // Caixas com papéis restritos (ex.: admin@) só aparecem a quem as vê.
        if (m && m.visibleRoles.length && !canSeeMailbox(viewer, m)) continue;
        allowed.set(t.id, { label: m?.label ?? t.mailboxKey, canOpen: !!m && canSeeMailbox(viewer, m), mailboxKey: t.mailboxKey });
      } else {
        allowed.set(t.id, { label: "Email pessoal", canOpen: canSeePersonalMailbox(viewer, t.ownerUserId), mailboxKey: null });
      }
    }
    const okIds = Array.from(allowed.keys());
    if (okIds.length) {
      const msgs = rowsOf(await d.execute(sql`SELECT id, threadId, direction, fromName, fromEmail, subject, snippet, LEFT(bodyText, 3000) AS text, sentAt, rfcMessageId
        FROM mail_messages WHERE threadId IN (${inList(okIds)}) ORDER BY sentAt DESC LIMIT 200`));
      const seen = new Set<string>();
      for (const m of msgs) {
        const k = m.rfcMessageId ? String(m.rfcMessageId) : `id:${m.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const a = allowed.get(Number(m.threadId))!;
        items.push({
          kind: "email", id: `m${m.id}`, threadId: Number(m.threadId), at: m.sentAt ?? null, direction: m.direction === "out" ? "out" : "in",
          who: m.fromName || m.fromEmail || "", subject: m.subject ?? "", text: String(m.text || m.snippet || "").replace(/\n>.*$/gms, "").trim().slice(0, 2000),
          source: a.label, link: a.canOpen ? (a.mailboxKey ? `/comunicacao?caixa=${encodeURIComponent(a.mailboxKey)}&t=${m.threadId}` : `/comunicacao/meu-email?t=${m.threadId}`) : null,
        });
      }
    }
  }
  // WhatsApp ligado ao mesmo cliente/reserva (se a pessoa vê o WhatsApp).
  if ((type === "client" || type === "booking") && can(viewer, "whatsapp", "view")) {
    const cond = type === "client"
      ? sql`LOWER(TRIM(c.linkedClientEmail)) = ${entityId}`
      : sql`c.linkedBookingId IN (SELECT b.id FROM multipark_bookings b WHERE b.externalId = ${entityId})`;
    const wa = rowsOf(await d.execute(sql`SELECT w.id, w.conversationId, w.direction, w.body, w.type, w.templateName, COALESCE(w.waTimestamp, w.createdAt) AS at, c.profileName
      FROM whatsapp_messages w JOIN whatsapp_conversations c ON c.id = w.conversationId WHERE ${cond} ORDER BY at DESC LIMIT 60`));
    for (const w of wa) {
      items.push({
        kind: "whatsapp", id: `w${w.id}`, threadId: null, at: w.at ?? null, direction: w.direction === "out" ? "out" : "in",
        who: w.direction === "out" ? "Multipark" : (w.profileName ?? "Cliente"), subject: "",
        text: String(w.body ?? (w.templateName ? `[template ${w.templateName}]` : `[${w.type}]`)).slice(0, 2000),
        source: "WhatsApp", link: can(viewer, "whatsapp", "view") ? "/whatsapp" : null,
      });
    }
  }
  items.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  return { items: items.slice(0, 200) };
}

export interface TimelineItem {
  kind: "email" | "whatsapp"; id: string; threadId: number | null; at: string | null; direction: "in" | "out";
  who: string; subject: string; text: string; source: string; link: string | null;
}

// ─── Contactos (autocompletar ao escrever) ──────────────────────────────────

export async function contactSuggestions(viewer: MailViewer, q: string) {
  const term = q.trim().toLowerCase().slice(0, 60);
  if (term.length < 2) return [];
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const d = await db();
  const out = new Map<string, { email: string; name: string | null; source: "crm" | "email" }>();
  // CRM (clientes das reservas) — só quem vê clientes ou a comunicação partilhada.
  if (can(viewer, "clientes", "view") || can(viewer, "comunicacao", "view")) {
    const rows = rowsOf(await d.execute(sql`SELECT LOWER(TRIM(b.clientEmail)) AS email,
        MAX(NULLIF(TRIM(CONCAT_WS(' ', b.clientFirstName, b.clientLastName)), '')) AS name, MAX(b.checkIn) AS lastAt
      FROM multipark_bookings b
      WHERE b.clientEmail IS NOT NULL AND b.clientEmail <> '' AND ${projectScope(sql`b.projectId`)}
        AND (LOWER(b.clientEmail) LIKE ${like} OR LOWER(CONCAT_WS(' ', b.clientFirstName, b.clientLastName)) LIKE ${like})
      GROUP BY LOWER(TRIM(b.clientEmail)) ORDER BY lastAt DESC LIMIT 8`));
    for (const r of rows) out.set(String(r.email), { email: String(r.email), name: r.name ?? null, source: "crm" });
  }
  // Contactos das conversas que a pessoa já vê (a sua caixa pessoal + caixas partilhadas).
  const mailboxes = (await listMailboxes()).filter((m) => canSeeMailbox(viewer, m)).map((m) => m.key);
  const scope = mailboxes.length
    ? sql`(t.ownerUserId = ${viewer.id} OR t.mailboxKey IN (${inList(mailboxes)}))`
    : sql`t.ownerUserId = ${viewer.id}`;
  const rows = rowsOf(await d.execute(sql`SELECT t.contactEmail AS email, MAX(t.contactName) AS name, MAX(t.lastMessageAt) AS lastAt
    FROM mail_threads t WHERE ${scope} AND t.contactEmail IS NOT NULL AND (t.contactEmail LIKE ${like} OR t.contactName LIKE ${like})
    GROUP BY t.contactEmail ORDER BY lastAt DESC LIMIT 8`));
  for (const r of rows) if (!out.has(String(r.email))) out.set(String(r.email), { email: String(r.email), name: r.name ?? null, source: "email" });
  return Array.from(out.values()).slice(0, 12);
}

// ─── Anexo (bytes a pedido) ─────────────────────────────────────────────────

export async function attachmentBytes(viewer: MailViewer, messageId: number, index: number): Promise<{ filename: string; mimeType: string; content: Buffer }> {
  const d = await db();
  const r = rowsOf(await d.execute(sql`SELECT threadId, accountKey, gmailMessageId, attachmentsJson FROM mail_messages WHERE id = ${messageId} LIMIT 1`))[0];
  if (!r) throw notFound("Anexo não encontrado.");
  await threadAccess(viewer, Number(r.threadId));
  const metas: MailAttachmentMeta[] = (() => { try { return JSON.parse(r.attachmentsJson || "[]"); } catch { return []; } })();
  const a = metas.find((x) => x.index === index);
  if (!a || !a.attachmentId) throw notFound("Anexo não encontrado.");
  const { gmailApiForAccount } = await import("./gmailApi");
  const api = await gmailApiForAccount(String(r.accountKey));
  return { filename: a.filename, mimeType: a.mimeType, content: await api.getAttachment(String(r.gmailMessageId), a.attachmentId) };
}
