/**
 * Comunicação — corrida da sincronização (agendador /api/cron/tick: de 5 em
 * 5 min, ou de hora a hora como rede de segurança quando o push do Gmail está
 * saudável; prazo por corrida, resumível) e o que acontece a cada email
 * guardado (TODO o email entra pela API do Gmail — não há IMAP):
 *
 *  1. pipeline temático (reclamações, perdidos, críticas, RH, campanhas,
 *     ocorrências) para emails RECEBIDOS, pelo destino do alias (tabela de
 *     aliases) ou da caixa, dentro de MAIL_PIPELINE_WINDOW_DAYS — o
 *     Message-ID reservado em inbound_emails impede processar duas vezes;
 *  2. ligações automáticas (cliente, reserva…) e cidade do alias (a conversa
 *     fica dessa cidade — regra de cidade das caixas e notificações);
 *  3. responsável do alias: pessoa → atribuída + `mail_assigned`; equipa
 *     (papel) → `mail_new` a quem tem o papel e vê a caixa (na cidade);
 *  4. notificação `mail_new` (conversa nova/reaberta, caixa com aviso, sem
 *     registo criado pelo pipeline — esse já avisa) a quem vê a caixa.
 * "ok" honesto: falha de uma conta de caixa partilhada → ok:false; uma conta
 * pessoal que precisa de ser religada não pinta o cron de vermelho (avisa a
 * própria pessoa).
 */
import { sql } from "drizzle-orm";
import { aliasPipeline, canSeeMailbox, configuredPipelines, isCompanyAddress, parseMailOwner, type MailboxAddress, type MailboxConfig, type MailPipeline } from "../../shared/mail";
import { emailRoutingEligible } from "../../shared/commsRouting";
import type { InboundAlias } from "../emailParse";
import { gmailThreadIdToImap } from "./parse";
import { syncAccount, type AccountSyncResult, type StoredEvent } from "./sync";
import {
  addAutoLink, claimAccountLock, db, dbSyncStore, listSyncAccounts, loadBrandDomains, loadWorkspaceDomains, markAccount, releaseAccountLock, rowsOf,
  setMessagePipeline, setThreadProjectIfEmpty, type MailboxRow,
} from "./store";
import { proposeLinks, projectFromLinks, type AutoLinkDeps } from "./autolink";
import type { GmailApi } from "./gmailApi";

export interface MailSyncReport {
  ok: boolean;
  configured: boolean;
  done: boolean;
  accounts: Array<Pick<AccountSyncResult, "accountKey" | "phase" | "fetched" | "stored" | "duplicates" | "partial"> & { status: string; error?: string }>;
  stored: number;
  pipelineCreated: number;
  /** Emails que deviam ter criado um caso e falharam nesta corrida (ficam para nova tentativa). */
  pipelineFailed?: number;
  /** Casos que falharam antes e foram criados agora (nova tentativa). */
  pipelineRetried?: number;
  errors: string[];
  aiTriaged?: number;
  watchRenewed?: number;
  /** Emails novos que a IA leu para separar pelas caixas nesta corrida (teto em "ai.commsRouting"). */
  aiRouted?: number;
}

/** Só emails recebidos nestes últimos dias criam registos (a importação inicial de 90 d não ressuscita casos antigos). */
export const MAIL_PIPELINE_WINDOW_DAYS = 30;
/** Tentativas automáticas de um caso que falhou (depois fica em Definições → Comunicação com "Tentar de novo"). */
export const MAIL_PIPELINE_MAX_ATTEMPTS = 5;

// ─── Dependências reais das ligações automáticas ────────────────────────────

export const dbAutoLinkDeps: AutoLinkDeps = {
  // CRM fase 2: o cliente é a ficha do CRM (emails/telefones das fichas), não a cópia das reservas.
  async clientExists(email) {
    const { crmEmailExists } = await import("../crm/lookup");
    return crmEmailExists(await db(), email);
  },
  async clientEmailByPhone(phone) {
    const { crmEmailByPhone } = await import("../crm/lookup");
    return crmEmailByPhone(await db(), phone);
  },
  async matchBooking(s) {
    const { matchBookingForComplaint } = await import("../complaintDossier");
    const m = await matchBookingForComplaint({
      reservationRef: s.ref, vehiclePlate: s.plate, clientEmail: s.email, clientPhone: s.phone, clientName: s.name, anchorDate: s.anchorIso,
    } as any);
    return m ? { externalId: String(m.booking.externalId), projectId: m.booking.projectId ?? null, score: m.score, matchedBy: m.matchedBy } : null;
  },
  async complaintByThread(s) {
    if (!s.gmThreadId && !s.refs.length) return null;
    const { findComplaintByThread } = await import("../db");
    const c = await findComplaintByThread({ gmThreadId: s.gmThreadId, refs: s.refs });
    return c ? { id: Number(c.id), projectId: (c as any).projectId ?? null } : null;
  },
  async openComplaintBySignals(email, plate) {
    // Ligação automática: email ou matrícula — o nome sozinho não chega (outra
    // "Ana Costa" ficava ligada à reclamação e à cidade de outra pessoa, 17d).
    const { findComplaintByClientSignals } = await import("../db");
    const c = await findComplaintByClientSignals(email, plate, null);
    return c ? { id: Number(c.id), projectId: (c as any).projectId ?? null } : null;
  },
  async openLostFoundBySignals(email, plate) {
    if (!email && !plate) return null;
    const { findOpenLostFoundByClient } = await import("../db");
    const l = await findOpenLostFoundByClient(email, plate);
    return l ? { id: Number(l.id), projectId: (l as any).projectId ?? null } : null;
  },
  async caseProject(type, id) {
    const d = await db();
    const table = type === "complaint" ? sql`complaints` : type === "lost_found" ? sql`lost_found_items` : sql`incidents`;
    const r = rowsOf(await d.execute(sql`SELECT projectId FROM ${table} WHERE id = ${id} LIMIT 1`))[0];
    return r?.projectId != null ? Number(r.projectId) : null;
  },
};

// ─── Pós-processamento de cada email guardado ───────────────────────────────

async function runPipeline(e: Pick<StoredEvent, "parsed" | "result">, api: Pick<GmailApi, "getAttachment">, pipeline: MailPipeline): Promise<{ targetModule: string; targetId?: number; existing?: true } | null> {
  const p = e.parsed;
  if (!p.rfcMessageId) return null;
  const { processInboundEmail } = await import("../jobs/emailInboundSync");
  const out = await processInboundEmail({
    alias: pipeline as InboundAlias,
    messageId: p.rfcMessageId,
    gmThreadId: gmailThreadIdToImap(p.gmailThreadId),
    refs: [...(p.inReplyTo ? [p.inReplyTo] : []), ...p.references],
    fromName: p.fromName ?? undefined,
    fromEmail: p.fromEmail ?? undefined,
    subject: p.subject,
    receivedAt: p.sentAt,
    text: p.text || null,
    html: p.html || null,
    loadAttachments: async () => {
      const list = [];
      for (const a of p.attachments.slice(0, 10)) {
        if (!a.attachmentId || a.size > 15 * 1024 * 1024) { list.push({ filename: a.filename, contentType: a.mimeType, size: a.size, content: null, related: a.inline }); continue; }
        const content = await api.getAttachment(p.gmailMessageId, a.attachmentId).catch(() => null);
        list.push({ filename: a.filename, contentType: a.mimeType, size: content?.length ?? a.size, content, related: a.inline });
      }
      return list;
    },
  });
  if (e.result.messageId) await setMessagePipeline(e.result.messageId, pipeline, out.status).catch(() => {});
  if (out.status === "processed") return out.routed;
  if (out.status === "duplicate") {
    // Já tratado (outra conta, ou uma tentativa anterior que criou o caso):
    // liga ao registo que existe, sem o contar como novo.
    const { getInboundEmailByMessageId } = await import("../db");
    const row: any = await getInboundEmailByMessageId(p.rfcMessageId).catch(() => null);
    if (row?.targetModule && row?.targetId) return { targetModule: String(row.targetModule), targetId: Number(row.targetId), existing: true };
  }
  return null;
}

/** Marca o caso que falhou (volta a ser tentado — `retryFailedPipelines`). */
async function markPipelineError(messageId: number, pipeline: string, err: unknown): Promise<void> {
  const d = await db();
  await d.execute(sql`UPDATE mail_messages SET pipeline = ${pipeline}, pipelineStatus = 'error', pipelineAttempts = LEAST(pipelineAttempts + 1, 100),
    pipelineError = ${String((err as any)?.message ?? err).slice(0, 300)} WHERE id = ${messageId}`);
}

async function notifyNewMail(e: StoredEvent, mailbox: MailboxConfig, projectId: number | null): Promise<void> {
  const { notify } = await import("../notify");
  const who = e.parsed.fromName || e.parsed.fromEmail || "cliente";
  await notify({
    kind: "mail_new",
    projectId,
    title: `${mailbox.label}: ${e.parsed.subject || "(sem assunto)"}`.slice(0, 255),
    body: `${e.result.reopened ? "Conversa reaberta — " : ""}${who}: ${e.parsed.snippet}`.slice(0, 500),
    link: `/comunicacao?caixa=${encodeURIComponent(mailbox.key)}&t=${e.result.threadId}`,
    entity: { type: "mail_thread", id: e.result.threadId },
    recipientFilter: (c) => canSeeMailbox({ id: c.id, role: c.role, accessOverrides: c.accessOverrides }, mailbox),
  });
}

/** Responsável do alias: pessoa → atribui (se ainda ninguém) e avisa; equipa (papel) → avisa quem tem o papel e vê a caixa. */
async function notifyAliasOwner(e: StoredEvent, mailbox: MailboxConfig, alias: MailboxAddress, projectId: number | null): Promise<boolean> {
  const owner = parseMailOwner(alias.owner);
  if (!owner) return false;
  const { notify } = await import("../notify");
  const link = `/comunicacao?caixa=${encodeURIComponent(mailbox.key)}&t=${e.result.threadId}`;
  const who = e.parsed.fromName || e.parsed.fromEmail || "cliente";
  const title = `${alias.tag || mailbox.label}: ${e.parsed.subject || "(sem assunto)"}`.slice(0, 255);
  const body = `Chegou por ${alias.address} — ${who}: ${e.parsed.snippet}`.slice(0, 500);
  const d = await db();
  if (owner.kind === "user") {
    const u = rowsOf(await d.execute(sql`SELECT id, role, isActive FROM users WHERE id = ${owner.userId} LIMIT 1`))[0];
    if (!u || Number(u.isActive) !== 1) return false;
    // Só se atribui a quem vê a caixa (a mesma regra da atribuição manual).
    const { getUserModuleOverrides } = await import("../db");
    const target = { id: Number(u.id), role: String(u.role), accessOverrides: await getUserModuleOverrides(Number(u.id)).catch(() => ({})) };
    if (!canSeeMailbox(target, mailbox)) return false;
    await d.execute(sql`UPDATE mail_threads SET assignedUserId = ${owner.userId} WHERE id = ${e.result.threadId} AND assignedUserId IS NULL`);
    await notify({ kind: "mail_assigned", targetUserId: owner.userId, projectId, title, body, link, entity: { type: "mail_thread", id: e.result.threadId } });
    return true;
  }
  // Papéis nacionais (admin/super_admin) não estão nos destinatários por omissão de mail_new: juntam-se à mão.
  const also = owner.role === "admin" || owner.role === "super_admin"
    ? rowsOf(await d.execute(sql`SELECT id FROM users WHERE isActive = 1 AND role = ${owner.role} LIMIT 200`)).map((r) => Number(r.id))
    : [];
  await notify({
    kind: "mail_new", projectId, title, body, link, alsoUserIds: also,
    entity: { type: "mail_thread", id: e.result.threadId },
    recipientFilter: (c) => c.role === owner.role && canSeeMailbox({ id: c.id, role: c.role, accessOverrides: c.accessOverrides }, mailbox),
  });
  return true;
}

export function makeOnStored(api: GmailApi, report: MailSyncReport, brandDomains: Record<string, string[]>, opts: { deadlineAt?: number } = {}) {
  const windowMs = MAIL_PIPELINE_WINDOW_DAYS * 86_400_000;
  // Teto de emails lidos pela IA para separar, nesta corrida (o resto fica para o varrimento ai-comms).
  const routingRun: { left: number; deadlineAt?: number; loaded?: boolean } = { left: 0, deadlineAt: opts.deadlineAt };
  return async (e: StoredEvent) => {
    const p = e.parsed;
    const mailbox = e.classification.mailboxKey ? e.account.mailboxes.find((m) => m.key === e.classification.mailboxKey) ?? null : null;
    const alias = e.classification.alias ?? null;
    let routed: { targetModule: string; targetId?: number; existing?: true } | null = null;
    let pipelineUsed: string | null = null;
    // 1) Pipeline temático — só emails RECEBIDOS (de pessoas), recentes, de caixas partilhadas.
    if (!p.outbound && !e.classification.personal && !p.systemMail) {
      const accountPipelines = [...configuredPipelines(e.account.mailboxes).keys()];
      const pipeline = aliasPipeline(mailbox, alias, p.subject, accountPipelines);
      pipelineUsed = pipeline;
      const recent = p.sentAt ? Date.now() - Date.parse(p.sentAt.replace(" ", "T") + "Z") <= windowMs : false;
      if (pipeline && recent) {
        try {
          routed = await runPipeline(e, api, pipeline);
          if (routed && !routed.existing && ["complaint", "lostfound", "review", "incident"].includes(routed.targetModule)) report.pipelineCreated++;
        } catch (err: any) {
          // O caso NÃO foi criado: fica marcado para nova tentativa e o cron
          // não fica verde (antes perdia-se em silêncio). O resto (ligações,
          // aviso de email novo à equipa) continua.
          if (e.result.messageId) await markPipelineError(e.result.messageId, pipeline, err).catch(() => {});
          report.pipelineFailed = (report.pipelineFailed ?? 0) + 1;
          report.ok = false;
          report.errors.push(`caso por criar (${pipeline}) ${p.gmailMessageId}: ${String(err?.message ?? err).slice(0, 160)}`);
        }
      }
    }
    // 2) Ligações automáticas (conversas com cliente externo ou registo do pipeline).
    const thread = rowsOf(await (await db()).execute(sql`SELECT contactEmail, contactName FROM mail_threads WHERE id = ${e.result.threadId} LIMIT 1`))[0] ?? {};
    let projectId: number | null = null;
    const contact = thread.contactEmail && !isCompanyAddress(thread.contactEmail, brandDomains) ? String(thread.contactEmail) : null;
    if (contact || routed?.targetId) {
      const links = await proposeLinks({
        contactEmail: contact, contactName: thread.contactName ?? null, subject: p.subject, bodyText: p.text || "",
        gmThreadId: gmailThreadIdToImap(p.gmailThreadId), refs: [...(p.inReplyTo ? [p.inReplyTo] : []), ...p.references],
        sentAt: p.sentAt, pipeline: routed,
      }, dbAutoLinkDeps);
      for (const l of links) {
        await addAutoLink({ threadId: e.result.threadId, messageId: e.result.messageId, entityType: l.entityType, entityId: l.entityId, confidence: l.confidence, reason: l.reason });
      }
      projectId = projectFromLinks(links);
      await setThreadProjectIfEmpty(e.result.threadId, projectId);
    }
    // Cidade do alias: a conversa fica dessa cidade quando as ligações não deram
    // um parque/cidade (regra "linked" das caixas → server/cityScope + cityAccess).
    if (projectId == null && alias?.cityId) {
      await setThreadProjectIfEmpty(e.result.threadId, alias.cityId);
      projectId = alias.cityId;
    }
    // 3) Avisos (conversa nova ou reaberta, recebida, não automática).
    const createdCase = !!routed && ["complaint", "lostfound", "review", "incident", "incident_dup"].includes(routed.targetModule);
    const automated = !!(await (await db()).execute(sql`SELECT automated FROM mail_messages WHERE id = ${e.result.messageId ?? 0}`).then((r) => Number(rowsOf(r)[0]?.automated ?? 0)));
    const fresh = !p.outbound && !automated && (e.result.newThread || e.result.reopened);
    // 2b) Caixas PARTILHADAS (Jorge, 8 out 2026): a IA lê a mensagem que ABRE
    // a conversa e põe-na na caixa do tema, por ler; o que não percebe vai para
    // o info (interruptor AI_MAIL_ROUTING; regras em shared/commsRouting.ts).
    // Respostas num fio que já está numa caixa ficam onde estão. O aviso vai a
    // quem vê a caixa nova.
    let noticeBox: MailboxConfig | null = mailbox;
    const routable = !!mailbox && !!e.result.messageId && emailRoutingEligible({
      outbound: p.outbound, personal: e.classification.personal, systemMail: !!p.systemMail, automated, newThread: e.result.newThread,
      mailboxKey: mailbox.key, pipeline: pipelineUsed, createdCase,
    });
    if (routable) {
      if (!routingRun.loaded) {
        routingRun.loaded = true;
        try {
          const { getSetting } = await import("../appSettings");
          const { commsRoutingSettings } = await import("../../shared/commsRouting");
          routingRun.left = commsRoutingSettings(await getSetting("ai.commsRouting")).perRun;
        } catch { routingRun.left = 10; }
      }
      const before = routingRun.left;
      const target = await routeNewThreadByAi(e.result.threadId, e.result.messageId!, mailbox!, p, routingRun).catch(() => null);
      if (routingRun.left < before) report.aiRouted = (report.aiRouted ?? 0) + 1;
      if (target) noticeBox = target;
    }
    let ownerNotified = false;
    if (fresh && mailbox && alias?.owner && e.result.newThread && noticeBox === mailbox) {
      ownerNotified = await notifyAliasOwner(e, mailbox, alias, projectId).catch(() => false);
    }
    if (fresh && noticeBox?.notify && !createdCase && !ownerNotified) {
      await notifyNewMail(e, noticeBox, projectId).catch(() => {});
    }
  };
}

/**
 * IA (lite): para que caixa do tema vai esta conversa nova de uma caixa
 * partilhada? (server/commsRouting.ts). Devolve a caixa nova quando a moveu;
 * null = ficou (interruptor desligado, já lida, sem teto nesta corrida, ou a
 * IA disse a caixa onde já está). Nunca responde ao cliente.
 */
export async function routeNewThreadByAi(
  threadId: number,
  messageId: number,
  from: MailboxConfig,
  p: Pick<StoredEvent["parsed"], "subject" | "text" | "snippet" | "fromName" | "fromEmail" | "attachments">,
  run: { left: number; deadlineAt?: number },
): Promise<MailboxRow | null> {
  const { routeEmailMessage } = await import("../commsRouting");
  const d = await db();
  const t = rowsOf(await d.execute(sql`SELECT projectId FROM mail_threads WHERE id = ${threadId} LIMIT 1`))[0];
  const res = await routeEmailMessage({
    threadId, messageId, fromBoxKey: from.key, subject: p.subject ?? "", text: p.text || p.snippet || "",
    fromName: p.fromName ?? null, fromEmail: p.fromEmail ?? null,
    attachmentNames: (p.attachments ?? []).filter((a) => !a.inline).map((a) => a.filename).filter(Boolean),
    projectId: t?.projectId != null ? Number(t.projectId) : null,
  }, undefined, run);
  if (res.status !== "moved") return null;
  const { listMailboxes } = await import("./store");
  return (await listMailboxes()).find((b) => b.key === res.boxKey) ?? null;
}

/**
 * Move uma conversa de email para outra caixa (IA ou à mão). Guarda de onde
 * veio (a 1.ª caixa) e quem moveu; a IA nunca muda uma conversa já movida.
 */
export async function moveThreadToBox(threadId: number, boxKey: string, by: "ai" | "manual"): Promise<boolean> {
  const d = await db();
  const guard = by === "ai" ? sql`AND routedBy IS NULL` : sql``;
  const res = await d.execute(sql`UPDATE mail_threads SET routedFromKey = COALESCE(routedFromKey, mailboxKey), mailboxKey = ${boxKey}, routedBy = ${by}
    WHERE id = ${threadId} AND mailboxKey IS NOT NULL AND mailboxKey <> ${boxKey} AND needsTriage = 0 ${guard}`);
  const head = Array.isArray(res) ? res[0] : res;
  if (Number((head as any)?.affectedRows ?? 0) !== 1) return false;
  await d.execute(sql`UPDATE mail_messages SET mailboxKey = ${boxKey} WHERE threadId = ${threadId}`);
  return true;
}

/**
 * "Por classificar" → caixa: depois de atribuída a conversa, se o destino
 * (alias escolhido ou caixa) tiver pipeline, corre-o nas mensagens recebidas
 * ainda não processadas (vão buscar-se ao Gmail — anexos incluídos).
 */
export async function reprocessThreadPipeline(threadId: number, mailbox: MailboxConfig, alias: MailboxAddress | null): Promise<{ processed: number; created: number }> {
  const out = { processed: 0, created: 0 };
  const pipeline = aliasPipeline(mailbox, alias, null);
  if (!pipeline) return out;
  const d = await db();
  const t = rowsOf(await d.execute(sql`SELECT accountKey FROM mail_threads WHERE id = ${threadId} LIMIT 1`))[0];
  if (!t) return out;
  const msgs = rowsOf(await d.execute(sql`SELECT id, gmailMessageId FROM mail_messages
    WHERE threadId = ${threadId} AND direction = 'in' AND automated = 0 AND pipeline IS NULL ORDER BY sentAt LIMIT 10`));
  if (!msgs.length) return out;
  const { gmailApiForAccount } = await import("./gmailApi");
  const { parseGmailMessage } = await import("./parse");
  const api = await gmailApiForAccount(String(t.accountKey));
  for (const m of msgs) {
    const raw = await api.getMessage(String(m.gmailMessageId)).catch(() => null);
    if (!raw) continue;
    const parsed = parseGmailMessage(raw);
    const routed = await runPipeline({ parsed, result: { stored: true, threadId, messageId: Number(m.id), newThread: false, reopened: false } }, api, pipeline);
    out.processed++;
    if (routed && ["complaint", "lostfound", "review", "incident"].includes(routed.targetModule)) out.created++;
  }
  return out;
}

// ─── Casos que falharam: nova tentativa ─────────────────────────────────────

/**
 * Volta a correr o pipeline de UM email cujo caso falhou (ou de um que a
 * pessoa pede em Definições). O Message-ID reservado em inbound_emails impede
 * criar o caso duas vezes: se a tentativa anterior chegou a criá-lo, liga-se
 * a esse. Devolve o que aconteceu.
 */
export async function retryPipelineMessage(messageId: number, opts: { manual?: boolean } = {}): Promise<{ ok: boolean; created: boolean; error?: string }> {
  const d = await db();
  const m = rowsOf(await d.execute(sql`SELECT id, threadId, accountKey, gmailMessageId, pipeline, pipelineStatus, pipelineAttempts FROM mail_messages WHERE id = ${messageId} LIMIT 1`))[0];
  if (!m || !m.pipeline) return { ok: false, created: false, error: "Email sem caso por criar." };
  if (m.pipelineStatus !== "error") return { ok: true, created: false };
  if (!opts.manual && Number(m.pipelineAttempts ?? 0) >= MAIL_PIPELINE_MAX_ATTEMPTS) return { ok: false, created: false, error: "Tentativas esgotadas." };
  const pipeline = String(m.pipeline) as MailPipeline;
  try {
    const { gmailApiForAccount } = await import("./gmailApi");
    const { parseGmailMessage } = await import("./parse");
    const api = await gmailApiForAccount(String(m.accountKey));
    const raw = await api.getMessage(String(m.gmailMessageId));
    if (!raw) throw new Error("O email já não está no Gmail.");
    const parsed = parseGmailMessage(raw);
    const threadId = Number(m.threadId);
    const routed = await runPipeline({ parsed, result: { stored: true, threadId, messageId, newThread: false, reopened: false } }, api, pipeline);
    if (routed?.targetId) {
      const links = await proposeLinks({ contactEmail: null, subject: "", bodyText: "", gmThreadId: null, refs: [], sentAt: null, pipeline: routed }, dbAutoLinkDeps);
      for (const l of links) await addAutoLink({ threadId, messageId, entityType: l.entityType, entityId: l.entityId, confidence: l.confidence, reason: l.reason });
      await setThreadProjectIfEmpty(threadId, projectFromLinks(links));
    }
    await d.execute(sql`UPDATE mail_messages SET pipelineError = NULL WHERE id = ${messageId}`);
    return { ok: true, created: !!routed && !routed.existing };
  } catch (err: any) {
    await markPipelineError(messageId, pipeline, err).catch(() => {});
    return { ok: false, created: false, error: String(err?.message ?? err).slice(0, 300) };
  }
}

/** Nova tentativa dos casos que falharam (recentes, com tentativas por gastar). */
export async function retryFailedPipelines(report: MailSyncReport, deadlineAt: number): Promise<void> {
  const d = await db();
  const since = new Date(Date.now() - MAIL_PIPELINE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const rows = rowsOf(await d.execute(sql`SELECT id FROM mail_messages
    WHERE pipelineStatus = 'error' AND pipelineAttempts < ${MAIL_PIPELINE_MAX_ATTEMPTS} AND direction = 'in' AND sentAt >= ${since}
    ORDER BY sentAt LIMIT 5`));
  for (const r of rows) {
    if (Date.now() > deadlineAt) break;
    const out = await retryPipelineMessage(Number(r.id));
    if (out.ok) { if (out.created) { report.pipelineRetried = (report.pipelineRetried ?? 0) + 1; report.pipelineCreated++; } }
    else { report.ok = false; report.errors.push(`caso por criar (mensagem ${r.id}): ${out.error ?? "falhou"}`); }
  }
}

/** Emails cujo caso falhou (Definições → Comunicação). */
export async function listPipelineFailures(): Promise<Array<{ messageId: number; threadId: number; mailboxKey: string | null; subject: string | null; fromEmail: string | null; pipeline: string | null; attempts: number; error: string | null; sentAt: string | null }>> {
  const d = await db();
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  return rowsOf(await d.execute(sql`SELECT m.id, m.threadId, t.mailboxKey, m.subject, m.fromEmail, m.pipeline, m.pipelineAttempts, m.pipelineError,
      DATE_FORMAT(m.sentAt, '%Y-%m-%d %H:%i:%s') AS sentAt
    FROM mail_messages m JOIN mail_threads t ON t.id = m.threadId
    WHERE m.sentAt >= ${since} AND m.pipelineStatus = 'error' ORDER BY m.sentAt DESC LIMIT 50`)).map((r) => ({
    messageId: Number(r.id), threadId: Number(r.threadId), mailboxKey: r.mailboxKey ?? null, subject: r.subject ?? null, fromEmail: r.fromEmail ?? null,
    pipeline: r.pipeline ?? null, attempts: Number(r.pipelineAttempts ?? 0), error: r.pipelineError ?? null, sentAt: r.sentAt ?? null,
  }));
}

// ─── Corrida ────────────────────────────────────────────────────────────────

export async function runMailSync(opts: { deadlineAt: number; onlyAccountKey?: string | null }): Promise<MailSyncReport> {
  const report: MailSyncReport = { ok: true, configured: false, done: true, accounts: [], stored: 0, pipelineCreated: 0, errors: [] };
  const { dwdConfigured } = await import("../google/workspace");
  const { gmailApiForAccount } = await import("./gmailApi");
  const accounts = (await listSyncAccounts({ dwdAvailable: dwdConfigured() })).filter((a) => !opts.onlyAccountKey || a.key === opts.onlyAccountKey);
  report.configured = accounts.length > 0;
  if (!accounts.length) return report;
  // Push (Pub/Sub): o watch vem ANTES da importação — é rápido e, se ficasse
  // para o fim, uma caixa com muito email por importar comia o prazo todo e o
  // Gmail nunca começava a avisar (27 set 2026). Só renova o que expira em < 24 h.
  try { report.watchRenewed = await renewWatches(accounts.map((a) => a.key), Math.min(opts.deadlineAt, Date.now() + 10_000)); } catch { /* opcional */ }
  const brandDomains = await loadBrandDomains();
  const workspaceDomains = await loadWorkspaceDomains();
  let backfillDays = 90;
  try {
    const { getSetting } = await import("../appSettings");
    backfillDays = (await getSetting("mail.backfillDays")) ?? 90;
  } catch { /* omissão */ }
  let autoSenders: string[] = [];
  try {
    const { systemSenderAddress } = await import("./systemMail");
    autoSenders = [await systemSenderAddress()];
  } catch { /* omissão: AUTO_MAIL_SENDERS */ }

  for (const acc of accounts) {
    if (Date.now() > opts.deadlineAt - 3_000) { report.done = false; break; }
    const personal = acc.ownerUserId != null && acc.mailboxes.length === 0;
    if (acc.state?.status === "disconnected" || acc.state?.status === "reauth_required") {
      report.accounts.push({ accountKey: acc.key, phase: "incremental", fetched: 0, stored: 0, duplicates: 0, partial: false, status: acc.state.status });
      continue;
    }
    if (!(await claimAccountLock(acc.key))) {
      report.accounts.push({ accountKey: acc.key, phase: "incremental", fetched: 0, stored: 0, duplicates: 0, partial: true, status: "locked" });
      report.done = false;
      continue;
    }
    try {
      const api = await gmailApiForAccount(acc.key);
      const r = await syncAccount(api, dbSyncStore, acc, {
        deadlineAt: opts.deadlineAt - 2_000, backfillDays, brandDomains, workspaceDomains, autoSenders, onStored: makeOnStored(api, report, brandDomains, { deadlineAt: opts.deadlineAt }),
      });
      report.stored += r.stored;
      if (r.partial) report.done = false;
      report.errors.push(...r.errors.map((x) => `${acc.key}: ${x}`));
      await markAccount(acc.key, { status: "ok", ok: true, stored: r.stored, lastError: r.errors[0] ?? null });
      report.accounts.push({ accountKey: acc.key, phase: r.phase, fetched: r.fetched, stored: r.stored, duplicates: r.duplicates, partial: r.partial, status: "ok" });
    } catch (err: any) {
      const msg = String(err?.message ?? err).slice(0, 300);
      const { isAuthRevokedError } = await import("../google/workspace");
      const authFailure = !!err?.authFailure || isAuthRevokedError(err) || /volta a ligar|não ligada|expirou/i.test(msg);
      const status = authFailure ? (personal ? "reauth_required" : "error") : "error";
      await markAccount(acc.key, { status, lastError: msg }).catch(() => {});
      report.accounts.push({ accountKey: acc.key, phase: "incremental", fetched: 0, stored: 0, duplicates: 0, partial: false, status, error: msg });
      // Conta pessoal por religar = problema da pessoa (avisada), não do cron.
      if (!personal) { report.ok = false; report.errors.push(`${acc.key}: ${msg}`); }
    } finally {
      await releaseAccountLock(acc.key).catch(() => {});
    }
  }

  // Casos que falharam em corridas anteriores: nova tentativa (até MAIL_PIPELINE_MAX_ATTEMPTS).
  if (!opts.onlyAccountKey && Date.now() + 15_000 < opts.deadlineAt) {
    try { await retryFailedPipelines(report, opts.deadlineAt - 10_000); }
    catch (err: any) { report.errors.push(`nova tentativa dos casos: ${String(err?.message ?? err).slice(0, 160)}`); }
  }
  // Triagem por IA das reclamações que o pipeline criou (como o IMAP fazia).
  if (report.pipelineCreated > 0 && Date.now() + 20_000 < opts.deadlineAt) {
    try {
      const { triagePendingComplaints } = await import("../complaintTriage");
      const t = await triagePendingComplaints({ limit: 5, deadlineAt: opts.deadlineAt });
      report.aiTriaged = t.triaged;
    } catch (err: any) {
      console.warn("[mail] triagem IA falhou:", String(err?.message ?? err).slice(0, 160));
    }
  }
  // Push: 2.ª tentativa no fim, para as contas que não couberam no início.
  if (Date.now() + 8_000 < opts.deadlineAt) {
    try { report.watchRenewed = (report.watchRenewed ?? 0) + await renewWatches(accounts.map((a) => a.key), opts.deadlineAt); } catch { /* opcional */ }
  }
  return report;
}

/** Interruptor MAIL_PUSH (Definições → Automações; desligado por omissão). */
export async function mailPushEnabled(): Promise<boolean> {
  const { ensureFeatureFlagOverrides, isFeatureEnabled } = await import("../_core/featureFlags");
  const { automationFlagDefault } = await import("../../shared/appSettings");
  await ensureFeatureFlagOverrides();
  return isFeatureEnabled("MAIL_PUSH", { defaultEnabled: automationFlagDefault("MAIL_PUSH") });
}

/** Gmail push: `users.watch` a cada ~6 dias por conta (expira aos 7). */
export async function renewWatches(accountKeys: string[], deadlineAt: number): Promise<number> {
  const topic = String(process.env.GMAIL_PUSH_TOPIC ?? "").trim();
  if (!topic) return 0;
  if (!(await mailPushEnabled())) return 0;
  const { gmailApiForAccount } = await import("./gmailApi");
  const d = await db();
  const soon = Date.now() + 24 * 3_600_000;
  let n = 0;
  for (const key of accountKeys) {
    if (Date.now() > deadlineAt - 3_000) break;
    const r = rowsOf(await d.execute(sql`SELECT watchExpiration, status FROM mail_accounts WHERE accountKey = ${key} LIMIT 1`))[0];
    if (!r || r.status !== "ok" || (r.watchExpiration != null && Number(r.watchExpiration) > soon)) continue;
    try {
      const api = await gmailApiForAccount(key);
      const w = await api.watch(topic);
      await d.execute(sql`UPDATE mail_accounts SET watchExpiration = ${w.expiration} WHERE accountKey = ${key}`);
      n++;
    } catch (err: any) {
      console.warn("[mail] watch falhou:", key, String(err?.message ?? err).slice(0, 160));
    }
  }
  return n;
}
