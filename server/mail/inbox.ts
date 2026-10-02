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
  MAIL_BRAND_LABELS, MAIL_LINK_MODULE, MAIL_TRIAGE_KEY, brandOfAddress, canActOnMailbox, canSeeMailbox, canSeePersonalMailbox, canSendFromPersonalMailbox, checkSendAs,
  isHrMailThread, mailAttachmentDriveAllowed, extractAddresses, hideAutomaticThreads, isCompanyAddress, isMailBrand, mailboxCityRestricted, normalizeAddress, normalizeLinkEntityId, personalAccountKey,
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
  /** Só automáticos (notificações de reserva, emails de sistema) — escondida por omissão nas listas. */
  automated: boolean;
  /** "Por classificar": entrou por um endereço fora da tabela de aliases. */
  needsTriage: boolean;
  /** Etiqueta do alias por onde entrou. */
  routeLabel: string | null;
  /** Arquivada pela retenção (+5 anos, sem ligação): só o super admin a vê, a pedido. */
  archivedAt: string | null;
  /** Movida de outra caixa (17f): a caixa de origem e quem moveu (ai | manual). */
  routedFromKey: string | null;
  routedBy: string | null;
}

/** Quem trata "Por classificar" (e edita a tabela de aliases): admin e super_admin. */
export const canTriageMail = (v: Pick<MailViewer, "role"> | null | undefined): boolean => v?.role === "admin" || v?.role === "super_admin";

function toThread(r: any): ThreadRow {
  return {
    id: Number(r.id), accountKey: String(r.accountKey), gmailThreadId: String(r.gmailThreadId), mailboxKey: r.mailboxKey ?? null,
    ownerUserId: r.ownerUserId != null ? Number(r.ownerUserId) : null, brand: r.brand ?? null, subject: r.subject ?? null, snippet: r.snippet ?? null,
    contactEmail: r.contactEmail ?? null, contactName: r.contactName ?? null, matchedAddress: r.matchedAddress ?? null,
    messageCount: Number(r.messageCount ?? 0), unreadCount: Number(r.unreadCount ?? 0), lastMessageAt: r.lastMessageAt ?? null,
    lastInboundAt: r.lastInboundAt ?? null, lastOutboundAt: r.lastOutboundAt ?? null, awaitingSince: r.awaitingSince ?? null,
    status: (r.status ?? "aberto") as MailThreadStatus, assignedUserId: r.assignedUserId != null ? Number(r.assignedUserId) : null,
    assignedName: r.assignedName ?? null, projectId: r.projectId != null ? Number(r.projectId) : null,
    automated: Number(r.automated ?? 0) === 1,
    needsTriage: Number(r.needsTriage ?? 0) === 1,
    routeLabel: r.routeLabel ?? null,
    archivedAt: r.archivedAt ?? null,
    routedFromKey: r.routedFromKey ?? null,
    routedBy: r.routedBy ?? null,
  };
}

/**
 * Endereços por onde se responde numa conversa: os da caixa + os da caixa de
 * origem quando foi movida (17f — uma caixa por tema não tem endereços; o
 * cliente escreveu para o info@ e a resposta sai do info@).
 */
async function replyAddressesOf(mailbox: MailboxRow, thread: Pick<ThreadRow, "routedFromKey">): Promise<MailboxRow["addresses"]> {
  const origin = thread.routedFromKey ? await getMailbox(thread.routedFromKey) : null;
  const seen = new Set<string>();
  return [...mailbox.addresses, ...(origin?.addresses ?? [])].filter((a) => {
    const k = normalizeAddress(a.address);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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

/** Quem vê pela cidade do pedido vê esta conversa (caixas "por cidade")? */
function threadCityVisible(viewer: MailViewer, mailbox: MailboxRow, projectId: number | null): boolean {
  if (!mailboxCityRestricted(viewer, mailbox)) return true;
  const ids = scopedProjectIds();
  return ids === undefined || (projectId != null && ids.includes(projectId));
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
  // Arquivo da retenção (+5 anos, sem ligação): fica guardada, só o super admin a vê.
  if (thread.archivedAt && viewer.role !== "super_admin") throw forbidden("Conversa arquivada (mais de 5 anos) — só o super admin a consulta.");
  if (thread.ownerUserId != null && !thread.mailboxKey) {
    if (!canSeePersonalMailbox(viewer, thread.ownerUserId)) throw forbidden();
    const own = canSendFromPersonalMailbox(viewer, thread.ownerUserId);
    return { thread, mailbox: null, personal: true, canAct: own, canSend: own };
  }
  const mailbox = await getMailbox(thread.mailboxKey);
  if (!mailbox) {
    // Sem caixa ("Por classificar" ou caixa apagada): só a administração vê e atribui.
    if (!canTriageMail(viewer)) throw forbidden();
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

/**
 * Condição SQL (sobre `mail_threads t`) das conversas que este utilizador pode
 * ver: as caixas partilhadas visíveis (com o filtro de cidade de cada uma) e o
 * próprio email pessoal. O super admin vê tudo (IT / procurar o que se perdeu).
 */
export async function visibleThreadsCondition(viewer: MailViewer): Promise<SQL> {
  // As arquivadas pela retenção ficam de fora de tudo (pesquisas, contactos,
  // CRM); o super admin vê-as só a pedido (Comunicação → Arquivo).
  // O super admin vê todas as caixas partilhadas e o SEU email; o email pessoal
  // dos outros consulta-se só em "O meu email" → escolher a pessoa — nunca
  // aparece na caixa geral nem nas pesquisas (Jorge, 2 out 2026).
  if (viewer.role === "super_admin") return sql`((t.mailboxKey IS NOT NULL OR t.ownerUserId IS NULL OR t.ownerUserId = ${viewer.id}) AND t.archivedAt IS NULL)`;
  const all = await listMailboxes();
  const parts: SQL[] = all.filter((m) => canSeeMailbox(viewer, m)).map((m) => sql`(t.mailboxKey = ${m.key} AND ${cityCondition(viewer, m)})`);
  parts.push(sql`(t.mailboxKey IS NULL AND t.ownerUserId = ${viewer.id})`);
  return sql`((${sql.join(parts, sql` OR `)}) AND t.archivedAt IS NULL)`;
}

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
      FROM mail_threads t WHERE t.mailboxKey = ${m.key} AND ${cityCondition(viewer, m)} AND COALESCE(t.automated, 0) = 0 AND t.archivedAt IS NULL`))[0] ?? {};
    out.push({
      key: m.key, label: m.label, module: m.module, brands: Array.from(new Set(m.addresses.map((a) => a.brand))),
      addresses: m.addresses, signatures: m.signatures, canAct: canActOnMailbox(viewer, m), pipeline: m.pipeline,
      // Caixa por tema (sem conta): não se escreve uma mensagem nova daqui (17f).
      canCompose: canActOnMailbox(viewer, m) && m.sourceKind !== "tema",
      unread: Number(r.unread ?? 0), awaiting: Number(r.awaiting ?? 0), open: Number(r.open ?? 0),
    });
  }
  const pr = rowsOf(await d.execute(sql`SELECT SUM(CASE WHEN unreadCount > 0 THEN 1 ELSE 0 END) AS unread FROM mail_threads
    WHERE ownerUserId = ${viewer.id} AND mailboxKey IS NULL AND COALESCE(automated, 0) = 0 AND archivedAt IS NULL`))[0] ?? {};
  let triage: { open: number; unread: number } | null = null;
  if (canTriageMail(viewer)) {
    const tr = rowsOf(await d.execute(sql`SELECT COUNT(*) AS n, SUM(CASE WHEN unreadCount > 0 THEN 1 ELSE 0 END) AS unread FROM mail_threads
      WHERE needsTriage = 1 AND status <> 'resolvido' AND archivedAt IS NULL`))[0] ?? {};
    triage = { open: Number(tr.n ?? 0), unread: Number(tr.unread ?? 0) };
  }
  return { mailboxes: out, personalUnread: Number(pr.unread ?? 0), triage };
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
  /** Mostrar as conversas automáticas (notificações de reserva) — escondidas por omissão; a pesquisa mostra-as sempre. */
  showAutomatic?: boolean;
  /** Arquivo da retenção (+5 anos, sem ligação): só o super admin, a pedido. */
  archived?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listThreads(viewer: MailViewer, input: ThreadListInput) {
  const conds: SQL[] = [];
  if (input.mailbox === "me") {
    const owner = input.ownerUserId ?? viewer.id;
    if (!canSeePersonalMailbox(viewer, owner)) throw forbidden();
    conds.push(sql`t.ownerUserId = ${owner} AND t.mailboxKey IS NULL`);
  } else if (input.mailbox === MAIL_TRIAGE_KEY) {
    if (!canTriageMail(viewer)) throw forbidden();
    conds.push(sql`t.needsTriage = 1`);
  } else {
    const m = await getMailbox(input.mailbox);
    if (!m || !canSeeMailbox(viewer, m)) throw forbidden();
    conds.push(sql`t.mailboxKey = ${m.key}`, cityCondition(viewer, m));
  }
  if (input.archived && viewer.role !== "super_admin") throw forbidden("Só o super admin consulta o arquivo.");
  conds.push(input.archived ? sql`t.archivedAt IS NOT NULL` : sql`t.archivedAt IS NULL`);
  if (input.brand && isMailBrand(input.brand)) conds.push(sql`t.brand = ${input.brand}`);
  if (input.status && input.status !== "all") conds.push(sql`t.status = ${input.status}`);
  if (input.assigned === "me") conds.push(sql`t.assignedUserId = ${viewer.id}`);
  else if (input.assigned === "none") conds.push(sql`t.assignedUserId IS NULL`);
  else if (typeof input.assigned === "number") conds.push(sql`t.assignedUserId = ${input.assigned}`);
  if (input.awaiting) conds.push(sql`t.awaitingSince IS NOT NULL AND t.status <> 'resolvido'`);
  if (input.unread) conds.push(sql`t.unreadCount > 0`);
  if (hideAutomaticThreads(input)) conds.push(sql`COALESCE(t.automated, 0) = 0`);
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

/** Imagens inline já buscadas ao Gmail (a conversa refresca a cada minuto — não as pedir sempre). */
const CID_CACHE = new Map<string, string>();
const CID_CACHE_MAX_CHARS = 24 * 1024 * 1024;
let cidCacheChars = 0;
function cidCachePut(k: string, v: string) {
  CID_CACHE.set(k, v);
  cidCacheChars += v.length;
  while (cidCacheChars > CID_CACHE_MAX_CHARS && CID_CACHE.size) {
    const [k0, v0] = CID_CACHE.entries().next().value as [string, string];
    CID_CACHE.delete(k0);
    cidCacheChars -= v0.length;
  }
}

async function cidImages(accountKey: string, gmailMessageId: string, atts: MailAttachmentMeta[]): Promise<Record<string, string>> {
  const inline = atts.filter((a) => a.contentId && a.attachmentId && a.mimeType.startsWith("image/") && a.size <= 1_000_000).slice(0, 6);
  if (!inline.length) return {};
  const out: Record<string, string> = {};
  let api: Awaited<ReturnType<typeof import("./gmailApi").gmailApiForAccount>> | null = null;
  for (const a of inline) {
    const k = `${accountKey}|${gmailMessageId}|${a.attachmentId}`;
    const hit = CID_CACHE.get(k);
    if (hit) { out[a.contentId!] = hit; continue; }
    try {
      if (!api) { const { gmailApiForAccount } = await import("./gmailApi"); api = await gmailApiForAccount(accountKey); }
      const uri = `data:${a.mimeType};base64,${(await api.getAttachment(gmailMessageId, a.attachmentId!)).toString("base64")}`;
      cidCachePut(k, uri);
      out[a.contentId!] = uri;
    } catch { /* fica bloqueada */ }
  }
  return out;
}

/**
 * Anexos que aparecem na lista: os normais e as FOTOS coladas no corpo (≥ 20
 * KB — ex.: danos enviados do iPhone, 17d); os logótipos/assinaturas inline
 * pequenos ficam de fora. PURA.
 */
export function listedAttachment(a: Pick<MailAttachmentMeta, "inline" | "contentId" | "mimeType" | "size">): boolean {
  if (!a.inline || !a.contentId) return true;
  return String(a.mimeType ?? "").startsWith("image/") && Number(a.size ?? 0) >= 20 * 1024;
}

export async function getThread(viewer: MailViewer, threadId: number, opts: { showImages?: boolean; showArchived?: boolean } = {}) {
  const acc = await threadAccess(viewer, threadId);
  const d = await db();
  // Mensagens arquivadas pela retenção: só o super admin, a pedido (ou numa conversa toda arquivada, que só ele abre).
  const superAdmin = viewer.role === "super_admin";
  const withArchived = superAdmin && (!!opts.showArchived || !!acc.thread.archivedAt);
  const allRows = rowsOf(await d.execute(sql`SELECT m.id, m.gmailMessageId, m.rfcMessageId, m.referencesText, m.direction, m.fromName, m.fromEmail, m.toJson, m.ccJson,
      m.subject, m.snippet, m.bodyText, m.bodyHtml, m.attachmentsJson, m.sentAt, m.isRead, m.brand, m.matchedAddress, m.sentById, m.pipeline, m.pipelineStatus,
      m.archivedAt, u.name AS sentByName
    FROM mail_messages m LEFT JOIN users u ON u.id = m.sentById WHERE m.threadId = ${threadId} ORDER BY m.sentAt, m.id`));
  const rows = withArchived ? allRows : allRows.filter((r) => !r.archivedAt);
  const archivedHidden = superAdmin ? allRows.length - rows.length : 0;
  // Email do RH: só os currículos podem ir para o Drive pessoal (Jorge, 2 out 2026).
  const hrThread = isHrMailThread(acc.mailbox, acc.thread.matchedAddress);
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
      attachments: atts.filter(listedAttachment).map((a) => ({
        index: a.index, filename: a.filename, mimeType: a.mimeType, size: a.size, href: `/api/mail/attachment/${Number(r.id)}/${a.index}`,
        driveAllowed: mailAttachmentDriveAllowed(hrThread, a.filename),
      })),
      sentAt: r.sentAt ?? null, isRead: Number(r.isRead) === 1, brand: r.brand ?? null, sentByName: r.sentByName ?? null,
      pipeline: r.pipeline ?? null, pipelineStatus: r.pipelineStatus ?? null,
      rfcMessageId: r.rfcMessageId ?? null,
      archived: !!r.archivedAt,
    });
  }
  const links = await linksForThreads([threadId]);
  // Destinatários sugeridos para "Responder" / "Responder a todos".
  let fromOptions: string[] = [];
  let defaultFrom: string | null = null;
  if (acc.mailbox) {
    const replyAddrs = await replyAddressesOf(acc.mailbox, acc.thread);
    fromOptions = replyAddrs.map((a) => a.address);
    defaultFrom = pickFromAddress({ addresses: replyAddrs }, { matchedAddress: acc.thread.matchedAddress, brand: isMailBrand(acc.thread.brand) ? acc.thread.brand : null });
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
    /** "Por classificar" e quem vê pode atribuí-la a uma caixa (admin/super_admin). */
    canTriage: acc.thread.needsTriage && canTriageMail(viewer),
    /** 17f: caixas para onde a pessoa pode mover a conversa ("Mover para…"). */
    moveTargets: acc.mailbox && acc.canAct && !acc.thread.needsTriage
      ? (await listMailboxes()).filter((m) => m.active && m.key !== acc.mailbox!.key && canSeeMailbox(viewer, m)).map((m) => ({ key: m.key, label: m.label }))
      : [],
    routedFrom: acc.thread.routedFromKey ? { key: acc.thread.routedFromKey, label: (await getMailbox(acc.thread.routedFromKey))?.label ?? acc.thread.routedFromKey, by: acc.thread.routedBy } : null,
    messages,
    /** Super admin: mensagens arquivadas (+5 anos) escondidas nesta conversa — "Mostrar arquivadas". */
    archivedHidden,
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
      if (!canActOnMailbox(target, acc.mailbox)) throw bad("Essa pessoa não pode responder nesta caixa.");
      // E vê a cidade da conversa — senão recebia o aviso e não a conseguia abrir (17d).
      if (!(await targetSeesThreadCity(target, acc.mailbox, acc.thread))) throw bad("Essa pessoa não vê a cidade desta conversa.");
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

/**
 * Cidades (projetos) que OUTRA pessoa vê na Comunicação: o alcance do papel,
 * ou só o centro de custos + cidades dadas quando um override do módulo a põe
 * "por cidade". undefined = todas.
 */
async function targetCityIds(target: MailViewer): Promise<number[] | undefined> {
  const { loadCityAccessParts } = await import("../cityAccess");
  const { activeOverride } = await import("../../shared/access");
  const parts = await loadCityAccessParts(target.id, target.role);
  const scope = activeOverride(target as any, "comunicacao") && !parts.base.all ? parts.base : parts.access;
  return scope.all ? undefined : scope.projectIds;
}

/** Essa pessoa vê a CIDADE desta conversa (caixas "por cidade")? */
async function targetSeesThreadCity(target: MailViewer, mailbox: MailboxRow, thread: Pick<ThreadRow, "projectId">): Promise<boolean> {
  if (!mailboxCityRestricted(target, mailbox)) return true;
  try {
    const ids = await targetCityIds(target);
    return ids === undefined || (thread.projectId != null && ids.includes(thread.projectId));
  } catch {
    return false; // sem centro de custos resolvido: não se atribui
  }
}

/**
 * Quem pode ser responsável: quem responde nesta caixa (papel + permissões
 * individuais) e — com `threadId` — vê a cidade dessa conversa (17d).
 */
export async function assigneesFor(viewer: MailViewer, mailboxKey: string, threadId: number | null = null) {
  const m = await getMailbox(mailboxKey);
  if (!m || !canSeeMailbox(viewer, m)) throw forbidden();
  let thread: ThreadRow | null = null;
  if (threadId != null) {
    const acc = await threadAccess(viewer, threadId);
    if (acc.mailbox?.key !== m.key) throw bad("A conversa não é desta caixa.");
    thread = acc.thread;
  }
  const { loadCandidatesFromDb } = await import("../notify");
  const cands = (await loadCandidatesFromDb())
    .filter((c) => ["team_leader", "supervisor", "frontoffice", "backoffice", "admin", "super_admin"].includes(c.role))
    .map((c) => ({ id: c.id, role: c.role, accessOverrides: c.accessOverrides ?? null }) as MailViewer)
    .filter((v) => canActOnMailbox(v, m));
  const ok = thread ? (await Promise.all(cands.map((v) => targetSeesThreadCity(v, m, thread!)))) : cands.map(() => true);
  const ids = cands.filter((_, i) => ok[i]).map((v) => v.id);
  if (!ids.length) return [];
  const d = await db();
  return rowsOf(await d.execute(sql`SELECT id, name FROM users WHERE id IN (${inList(ids)}) ORDER BY name LIMIT 500`))
    .map((u) => ({ id: Number(u.id), name: String(u.name ?? `#${u.id}`) }));
}

// ─── Mover para outra caixa (17f) ───────────────────────────────────────────

/** "Mover para…": quem trata a conversa e vê a caixa de destino. */
export async function moveThread(viewer: MailViewer, threadId: number, boxKey: string): Promise<void> {
  const acc = await requireAct(viewer, threadId);
  if (!acc.mailbox || acc.thread.needsTriage) throw bad("Esta conversa não muda de caixa (email pessoal ou por classificar).");
  const target = await getMailbox(boxKey);
  if (!target || !target.active || !canSeeMailbox(viewer, target)) throw bad("Caixa desconhecida.");
  const { moveThreadToBox } = await import("./service");
  if (!(await moveThreadToBox(threadId, target.key, "manual"))) throw bad("A conversa já está nessa caixa.");
  try {
    const { logActivity } = await import("../db");
    await logActivity({ userId: viewer.id, action: "update", entity: "mail_thread", entityId: threadId, details: `Caixa ${acc.mailbox.key} → ${target.key}` } as any);
  } catch { /* registo */ }
}

// ─── "Por classificar" → caixa ──────────────────────────────────────────────

/**
 * Atribui uma conversa "Por classificar" a uma caixa (admin/super_admin):
 * opcionalmente pelo alias da tabela (dá marca, cidade, destino, etiqueta) e
 * opcionalmente acrescentando um endereço novo à tabela dessa caixa (os
 * próximos emails por esse endereço já chegam classificados). Se o destino
 * tiver pipeline, corre-o nas mensagens recebidas da conversa.
 */
export async function assignTriagedThread(viewer: MailViewer, threadId: number, input: { mailbox: string; alias?: string | null; addAlias?: string | null }): Promise<{ processed: number; created: number }> {
  if (!canTriageMail(viewer)) throw forbidden("Só a administração classifica emails.");
  const thread = await loadThread(threadId);
  if (!thread) throw notFound();
  if (thread.ownerUserId != null && !thread.needsTriage) throw bad("Conversa pessoal — não se classifica.");
  if (thread.mailboxKey && !thread.needsTriage) throw bad("Esta conversa já está classificada numa caixa.");
  let mailbox = await getMailbox(input.mailbox);
  if (!mailbox) throw bad("Caixa desconhecida.");
  const { listMailboxes, saveMailbox, setThreadProjectIfEmpty } = await import("./store");
  const newAddr = normalizeAddress(input.addAlias);
  if (newAddr) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newAddr)) throw bad("Endereço inválido.");
    const all = await listMailboxes({ fresh: true });
    const owner = all.find((m) => m.addresses.some((a) => normalizeAddress(a.address) === newAddr));
    if (owner && owner.key !== mailbox.key) throw bad(`O endereço ${newAddr} já encaminha para a caixa "${owner.label}".`);
    if (!owner) {
      const { mailboxAddressSchema } = await import("../../shared/mail");
      const brand = brandOfAddress(newAddr) ?? mailbox.addresses[0]?.brand ?? "multipark";
      const next = { ...mailbox, addresses: [...mailbox.addresses, mailboxAddressSchema.parse({ address: newAddr, brand })] };
      const { id: _id, updatedAt: _u, ...cfg } = next;
      await saveMailbox(cfg, viewer.id);
      mailbox = (await getMailbox(mailbox.key)) ?? mailbox;
    }
  }
  const aliasAddr = normalizeAddress(input.alias) || newAddr;
  const alias = aliasAddr ? mailbox.addresses.find((a) => normalizeAddress(a.address) === aliasAddr) ?? null : null;
  const d = await db();
  await d.execute(sql`UPDATE mail_threads SET mailboxKey = ${mailbox.key}, needsTriage = 0,
      brand = COALESCE(${alias?.brand ?? null}, brand), routeLabel = COALESCE(${alias?.tag || null}, routeLabel),
      matchedAddress = COALESCE(${alias ? normalizeAddress(alias.address) : null}, matchedAddress)
    WHERE id = ${threadId}`);
  await d.execute(sql`UPDATE mail_messages SET mailboxKey = ${mailbox.key} WHERE threadId = ${threadId}`);
  if (alias?.cityId) await setThreadProjectIfEmpty(threadId, alias.cityId);
  try {
    const { logActivity } = await import("../db");
    await logActivity({ userId: viewer.id, action: "update", entity: "mail_thread", entityId: threadId, details: `Por classificar → ${mailbox.key}${alias ? ` (${alias.address})` : ""}${newAddr ? ` +alias ${newAddr}` : ""}` } as any);
  } catch { /* registo */ }
  const { reprocessThreadPipeline } = await import("./service");
  return reprocessThreadPipeline(threadId, mailbox, alias);
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
    // Ao vivo na Multipark (id ou n.º), nas cidades de quem liga.
    const { liveBookingByRef } = await import("../multiparkDb/bookingSearch");
    const r = await liveBookingByRef(id, { cities: "request" }).catch(() => { throw bad("Não foi possível confirmar a reserva (BD da Multipark sem resposta)."); });
    if (!r) throw bad("Reserva não encontrada (usa a referência ou o nº da reserva).");
    return r.id;
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
  /** Ficheiros já carregados por /api/upload (key + nome + tipo + recibo de quem carregou). */
  attachments: Array<{ key: string; filename: string; contentType: string; ticket?: string | null }>;
  /** Reencaminhar: juntar os anexos da mensagem original. */
  includeOriginalAttachments?: boolean;
  /** Código do envio (o editor gera um por mensagem): carregar outra vez nunca manda 2 emails (17d). */
  clientRequestId?: string | null;
}

export interface SendResult {
  threadId: number;
  gmailMessageId: string | null;
  /** O mesmo código já tinha sido enviado: devolve-se esse envio, sem mandar outro. */
  duplicate?: true;
  /** O Gmail não respondeu (prazo, rede): PODE ter saído — confirmar em "Enviados" antes de reenviar. */
  uncertain?: true;
  /** Saiu, mas ainda não ficou gravado aqui (aparece na próxima sincronização). */
  warning?: string;
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

export async function sendMail(viewer: MailViewer, input: SendInput): Promise<SendResult> {
  const to = cleanList(input.to), cc = cleanList(input.cc), bcc = cleanList(input.bcc);
  if (!to.length && !cc.length && !bcc.length) throw bad("Indica pelo menos um destinatário.");
  if (!input.body.trim()) throw bad("A mensagem está vazia.");
  // Anexos: só ficheiros que ESTA pessoa carregou (recibo do /api/upload).
  const { verifyUploadTicket } = await import("../uploadTicket");
  for (const a of input.attachments) {
    if (!verifyUploadTicket(viewer.id, a.key, a.ticket)) throw bad(`Anexo "${a.filename}" inválido — volta a anexar o ficheiro.`);
  }

  // Código do envio: reservado ANTES do Gmail; o mesmo código devolve o 1.º envio.
  const { cleanRequestId, claimSendRequest, finishSendRequest, sendFailureIsDefinite } = await import("./sendRequests");
  const reqId = cleanRequestId(input.clientRequestId);
  if (reqId) {
    const claim = await claimSendRequest(reqId, viewer.id);
    if (!claim.go) return claim.outcome;
  }
  let prepared: Awaited<ReturnType<typeof prepareSend>>;
  let sent: { id: string; threadId: string | null };
  try {
    prepared = await prepareSend(viewer, input, { to, cc, bcc });
    try {
      sent = await prepared.api.sendRaw(prepared.raw, prepared.gmailThreadId);
    } catch (err: any) {
      if (sendFailureIsDefinite(err)) throw err;
      // Sem resposta do Gmail: pode ter saído. Não se repete sozinho.
      const detail = String(err?.message ?? err).slice(0, 300);
      console.warn("[mail] envio sem confirmação do Gmail:", detail);
      if (reqId) await finishSendRequest(reqId, { status: "unknown", threadId: prepared.threadRow?.id ?? null, errorDetail: detail }).catch(() => {});
      return { threadId: prepared.threadRow?.id ?? 0, gmailMessageId: null, uncertain: true };
    }
  } catch (err: any) {
    if (reqId) await finishSendRequest(reqId, { status: "failed", errorDetail: String(err?.message ?? err) }).catch(() => {});
    throw err;
  }
  if (reqId) await finishSendRequest(reqId, { status: "sent", gmailMessageId: sent.id, threadId: prepared.threadRow?.id ?? null }).catch(() => {});

  // Depois do envio NADA pode falhar o pedido (a pessoa carregava outra vez e
  // o cliente recebia dois): gravar, ligar e registar são "tenta sem falhar".
  const { accountKey, mailbox, personal, threadRow, check, account, brand, subject, text } = prepared;
  let threadId = threadRow?.id ?? 0;
  let warning: string | undefined;
  try {
    const msg = await prepared.api.getMessage(sent.id).catch(() => null);
    if (!msg) throw new Error("mensagem enviada ainda não disponível no Gmail");
    const { parseGmailMessage } = await import("./parse");
    const p = parseGmailMessage(msg, { accountEmail: account });
    p.outbound = true;
    const contactEmail = to.find((a) => !isCompanyAddress(a)) ?? null;
    const r = await dbSyncStore.storeMessage(accountKey, p, {
      mailboxKey: mailbox?.key ?? null, brand: brand ?? (mailbox?.addresses.find((a) => normalizeAddress(a.address) === check.email)?.brand ?? null),
      matchedAddress: check.email, personal,
    }, { ownerUserId: personal ? viewer.id : null, automated: false, contactEmail, contactName: null });
    threadId = r.threadId || threadId;
    const d = await db();
    if (r.messageId) await d.execute(sql`UPDATE mail_messages SET sentById = ${viewer.id} WHERE id = ${r.messageId}`);
    if (input.mode === "forward" && threadRow) {
      // Reencaminhar cria outra conversa no Gmail: herda as ligações da original.
      const links = await linksForThreads([threadRow.id]);
      const { addAutoLink } = await import("./store");
      for (const l of links) await addAutoLink({ threadId, messageId: r.messageId, entityType: l.entityType, entityId: l.entityId, confidence: l.confidence, reason: "reencaminhado de outra conversa" });
    }
    // Conversa NOVA numa caixa partilhada: cidade e ligações já no envio (a
    // sincronização salta esta mensagem por já ser conhecida).
    if (mailbox && threadId && threadId !== threadRow?.id) {
      await placeNewThread(viewer, mailbox, {
        threadId, messageId: r.messageId, fromEmail: check.email, contactEmail, subject, text, sentAt: p.sentAt, inheritedProjectId: threadRow?.projectId ?? null,
      }).catch((err) => console.warn("[mail] cidade/ligações da conversa nova:", String(err?.message ?? err).slice(0, 160)));
    }
    if (reqId && threadId) await finishSendRequest(reqId, { threadId }).catch(() => {});
  } catch (err: any) {
    console.warn("[mail] enviado mas não gravado:", String(err?.message ?? err).slice(0, 200));
    warning = "Email enviado. Ainda não aparece aqui — a sincronização trata disso dentro de minutos.";
  }
  try {
    const { logActivity } = await import("../db");
    await logActivity({
      userId: viewer.id, action: "send", entity: "mail_message", entityId: threadId || null,
      details: `${input.mode} de ${check.email} para ${[...to, ...cc].join(", ")}${bcc.length ? ` (+${bcc.length} bcc)` : ""} — ${subject}`.slice(0, 1000),
    } as any);
  } catch { /* o registo não parte o envio */ }
  return { threadId, gmailMessageId: sent.id, ...(warning ? { warning } : {}) };
}

/**
 * Cidade de uma conversa NOVA criada por um envio (17d): a herdada (reencaminhar),
 * a do alias, ou a das ligações automáticas — a primeira que quem envia vê; se
 * nenhuma, a cidade de quem envia (senão abria a conversa e recebia "não
 * pertence à tua cidade"). E as ligações ao cliente/reserva.
 */
async function placeNewThread(viewer: MailViewer, mailbox: MailboxRow, t: {
  threadId: number; messageId: number | null; fromEmail: string; contactEmail: string | null; subject: string; text: string; sentAt: string | null; inheritedProjectId: number | null;
}): Promise<void> {
  const { addAutoLink, setThreadProjectIfEmpty } = await import("./store");
  const linkProjects: number[] = [];
  if (t.contactEmail) {
    const { proposeLinks } = await import("./autolink");
    const { dbAutoLinkDeps } = await import("./service");
    const links = await proposeLinks({ contactEmail: t.contactEmail, contactName: null, subject: t.subject, bodyText: t.text, gmThreadId: null, refs: [], sentAt: t.sentAt }, dbAutoLinkDeps);
    for (const l of links) {
      await addAutoLink({ threadId: t.threadId, messageId: t.messageId, entityType: l.entityType, entityId: l.entityId, confidence: l.confidence, reason: l.reason });
      if (l.projectId != null) linkProjects.push(l.projectId);
    }
  }
  const aliasCity = mailbox.addresses.find((a) => normalizeAddress(a.address) === normalizeAddress(t.fromEmail))?.cityId ?? null;
  const ids = mailboxCityRestricted(viewer, mailbox) ? scopedProjectIds() : undefined;
  await setThreadProjectIfEmpty(t.threadId, newThreadProject({ inherited: t.inheritedProjectId, aliasCity, linkProjects, senderScope: ids }));
}

/** Cidade da conversa nova (ver placeNewThread). PURA. */
export function newThreadProject(c: { inherited: number | null; aliasCity: number | null; linkProjects: readonly number[]; senderScope: readonly number[] | undefined }): number | null {
  const ok = (p: number | null | undefined): p is number => p != null && (c.senderScope === undefined || c.senderScope.includes(p));
  const pick = [c.inherited, c.aliasCity, ...c.linkProjects].find(ok);
  if (pick != null) return pick;
  return c.senderScope?.length ? c.senderScope[0] : null;
}

/** Tudo o que se faz ANTES do envio (sem efeitos fora daqui): conta, remetente, corpo, anexos. */
async function prepareSend(viewer: MailViewer, input: SendInput, list: { to: string[]; cc: string[]; bcc: string[] }) {
  const { to, cc, bcc } = list;

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
  if (mailbox) from = pickFromAddress({ addresses: threadRow ? await replyAddressesOf(mailbox, threadRow) : mailbox.addresses }, { requested: input.from, matchedAddress: threadRow?.matchedAddress, brand });
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
  return { api, raw, gmailThreadId, accountKey, mailbox, personal, threadRow, check, account, brand, subject, text };
}

// ─── Rascunho IA ────────────────────────────────────────────────────────────

export async function aiDraft(viewer: MailViewer, threadId: number): Promise<{ ok: boolean; text?: string; error?: string }> {
  const acc = await threadAccess(viewer, threadId);
  if (!acc.canSend) throw forbidden();
  const d = await db();
  const msgs = rowsOf(await d.execute(sql`SELECT direction, fromName, bodyText, snippet FROM mail_messages WHERE threadId = ${threadId} AND archivedAt IS NULL ORDER BY sentAt DESC, id DESC LIMIT 8`)).reverse();
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
export async function assertEntityInScope(type: MailLinkType, entityId: string): Promise<void> {
  const ids = scopedProjectIds();
  if (ids === undefined) return;
  const d = await db();
  const inScope = ids.length ? sql`IN (${inList(ids)})` : sql`IN (NULL)`;
  let ok = false;
  if (type === "client") {
    // CRM fase 2: cliente = ficha do CRM com este email, visível nas cidades de quem pede.
    const { crmClientByEmail } = await import("../crm/lookup");
    ok = !!(await crmClientByEmail(d, entityId));
  } else if (type === "booking") {
    // A reserva (ao vivo) é de um parque das cidades de quem pede?
    const { liveBookingByRef } = await import("../multiparkDb/bookingSearch");
    ok = !!(await liveBookingByRef(entityId, { cities: "request" }).catch(() => null));
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
    const threads = rowsOf(await d.execute(sql`SELECT * FROM mail_threads WHERE id IN (${inList(ids)}) AND archivedAt IS NULL`)).map(toThread);
    const mailboxes = await listMailboxes();
    const allowed = new Map<number, { label: string; canOpen: boolean; mailboxKey: string | null }>();
    for (const t of threads) {
      if (t.mailboxKey) {
        const m = mailboxes.find((x) => x.key === t.mailboxKey);
        // Caixas com papéis restritos (ex.: admin@) só aparecem a quem as vê.
        if (m && m.visibleRoles.length && !canSeeMailbox(viewer, m)) continue;
        // Abrir = ver a caixa E a cidade da conversa (17d: um TL de Lisboa lia
        // assunto e texto de conversas do Porto do mesmo cliente).
        allowed.set(t.id, { label: m?.label ?? t.mailboxKey, canOpen: !!m && canSeeMailbox(viewer, m) && threadCityVisible(viewer, m, t.projectId), mailboxKey: t.mailboxKey });
      } else {
        allowed.set(t.id, { label: "Email pessoal", canOpen: canSeePersonalMailbox(viewer, t.ownerUserId), mailboxKey: null });
      }
    }
    const okIds = Array.from(allowed.keys());
    if (okIds.length) {
      const msgs = rowsOf(await d.execute(sql`SELECT id, threadId, direction, fromName, fromEmail, subject, snippet, LEFT(bodyText, 3000) AS text, sentAt, rfcMessageId
        FROM mail_messages WHERE threadId IN (${inList(okIds)}) AND archivedAt IS NULL ORDER BY sentAt DESC LIMIT 200`));
      const seen = new Set<string>();
      for (const m of msgs) {
        const k = m.rfcMessageId ? String(m.rfcMessageId) : `id:${m.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        items.push(emailTimelineItem(m, allowed.get(Number(m.threadId))!));
      }
    }
  }
  // WhatsApp ligado ao mesmo cliente/reserva (se a pessoa vê o WhatsApp).
  if ((type === "client" || type === "booking") && can(viewer, "whatsapp", "view")) {
    const cond = type === "client"
      ? sql`LOWER(TRIM(c.linkedClientEmail)) = ${entityId}`
      : sql`c.linkedBookingRef = ${entityId}`;
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
  // Reuniões (Google Meet) criadas a partir deste registo ("Criar reunião").
  if (type === "client" || type === "complaint") {
    try {
      const meets = rowsOf(await d.execute(sql`SELECT m.id, m.title, m.startAt, m.meetLink, m.invitedEmail, u.name AS userName
        FROM google_meetings m LEFT JOIN users u ON u.id = m.userId
        WHERE m.entityType = ${type} AND m.entityId = ${entityId} ORDER BY m.startAt DESC LIMIT 30`));
      for (const m of meets) {
        items.push({
          kind: "meeting", id: `g${m.id}`, threadId: null, at: m.startAt ? String(m.startAt) : null, direction: "out",
          who: String(m.userName ?? "Multipark"), subject: String(m.title ?? "Reunião"),
          text: `Reunião com Google Meet${m.invitedEmail ? ` · cliente convidado (${m.invitedEmail})` : ""}`,
          source: "Reunião", link: m.meetLink ? String(m.meetLink) : null,
        });
      }
    } catch { /* tabela ainda por criar */ }
  }
  items.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  return { items: items.slice(0, 200) };
}

/** Texto que aparece na linha do tempo no lugar de um email que quem vê não pode abrir. */
export const TIMELINE_NO_ACCESS_TEXT = "Sem acesso ao conteúdo (email de outra caixa ou pessoal).";

/**
 * Um email na linha do tempo. Quem não pode abrir a conversa (email pessoal de
 * outra pessoa, caixa que não vê) fica só a saber que houve um email — quem,
 * quando e de onde —, SEM assunto nem texto. PURA.
 */
export function emailTimelineItem(
  m: { id: unknown; threadId: unknown; sentAt?: string | null; direction?: string | null; fromName?: string | null; fromEmail?: string | null; subject?: string | null; text?: string | null; snippet?: string | null },
  a: { label: string; canOpen: boolean; mailboxKey: string | null },
): TimelineItem {
  const base = { kind: "email" as const, id: `m${m.id}`, threadId: Number(m.threadId), at: m.sentAt ?? null, direction: (m.direction === "out" ? "out" : "in") as "in" | "out", who: m.fromName || m.fromEmail || "", source: a.label };
  if (!a.canOpen) return { ...base, subject: "", text: TIMELINE_NO_ACCESS_TEXT, link: null };
  return {
    ...base, subject: m.subject ?? "", text: String(m.text || m.snippet || "").replace(/\n>.*$/gms, "").trim().slice(0, 2000),
    link: a.mailboxKey ? `/comunicacao?caixa=${encodeURIComponent(a.mailboxKey)}&t=${m.threadId}` : `/comunicacao/meu-email?t=${m.threadId}`,
  };
}

export interface TimelineItem {
  kind: "email" | "whatsapp" | "meeting"; id: string; threadId: number | null; at: string | null; direction: "in" | "out";
  who: string; subject: string; text: string; source: string; link: string | null;
}

// ─── Contactos (autocompletar ao escrever) ──────────────────────────────────

export async function contactSuggestions(viewer: MailViewer, q: string) {
  const term = q.trim().toLowerCase().slice(0, 60);
  if (term.length < 2) return [];
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const d = await db();
  const out = new Map<string, { email: string; name: string | null; source: "crm" | "email" }>();
  // Fichas do CRM (no âmbito de cidade) — só quem vê clientes ou a comunicação partilhada.
  if (can(viewer, "clientes", "view") || can(viewer, "comunicacao", "view")) {
    const { clientVisibleSql } = await import("../crm/scope");
    const rows = rowsOf(await d.execute(sql`SELECT ce.email, MAX(c.displayName) AS name, MAX(c.lastVisit) AS lastAt
      FROM crm_client_emails ce JOIN crm_clients c ON c.id = ce.clientId
      WHERE c.status = 'active' AND ce.generic = 0 AND ${clientVisibleSql(sql`c.id`)}
        AND (ce.email LIKE ${like} OR LOWER(c.displayName) LIKE ${like})
      GROUP BY ce.email ORDER BY lastAt DESC LIMIT 8`));
    for (const r of rows) out.set(String(r.email), { email: String(r.email), name: r.name ?? null, source: "crm" });
  }
  // Contactos das conversas que a pessoa já vê (a sua caixa pessoal + caixas
  // partilhadas, COM a regra de cidade de cada caixa — 17d).
  const scope = await visibleThreadsCondition(viewer);
  const rows = rowsOf(await d.execute(sql`SELECT t.contactEmail AS email, MAX(t.contactName) AS name, MAX(t.lastMessageAt) AS lastAt
    FROM mail_threads t WHERE ${scope} AND t.contactEmail IS NOT NULL AND (t.contactEmail LIKE ${like} OR t.contactName LIKE ${like})
    GROUP BY t.contactEmail ORDER BY lastAt DESC LIMIT 8`));
  for (const r of rows) if (!out.has(String(r.email))) out.set(String(r.email), { email: String(r.email), name: r.name ?? null, source: "email" });
  return Array.from(out.values()).slice(0, 12);
}

// ─── Anexo (bytes a pedido) ─────────────────────────────────────────────────

export async function attachmentBytes(viewer: MailViewer, messageId: number, index: number): Promise<{ filename: string; mimeType: string; content: Buffer }> {
  const d = await db();
  const r = rowsOf(await d.execute(sql`SELECT threadId, accountKey, gmailMessageId, attachmentsJson, archivedAt FROM mail_messages WHERE id = ${messageId} LIMIT 1`))[0];
  if (!r) throw notFound("Anexo não encontrado.");
  await threadAccess(viewer, Number(r.threadId));
  if (r.archivedAt && viewer.role !== "super_admin") throw forbidden("Email arquivado (mais de 5 anos) — só o super admin o consulta.");
  const metas: MailAttachmentMeta[] = (() => { try { return JSON.parse(r.attachmentsJson || "[]"); } catch { return []; } })();
  const a = metas.find((x) => x.index === index);
  if (!a || !a.attachmentId) throw notFound("Anexo não encontrado.");
  const { gmailApiForAccount } = await import("./gmailApi");
  const api = await gmailApiForAccount(String(r.accountKey));
  return { filename: a.filename, mimeType: a.mimeType, content: await api.getAttachment(String(r.gmailMessageId), a.attachmentId) };
}
