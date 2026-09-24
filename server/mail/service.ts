/**
 * Comunicação — corrida da sincronização (cron /api/cron/mail-sync, 5 em 5
 * min, prazo 45 s, resumível) e o que acontece a cada email guardado:
 *
 *  1. pipeline antigo (reclamações, perdidos, críticas, RH, ocorrências) para
 *     emails RECEBIDOS nas caixas com pipeline, dentro da janela do IMAP
 *     (IMAP_SINCE_DAYS, 30 d) — o Message-ID reservado em inbound_emails
 *     impede que o IMAP e o Gmail processem o mesmo email;
 *  2. ligações automáticas (cliente, reserva, reclamação, perdido…);
 *  3. notificação `mail_new` (conversa nova/reaberta, caixa com aviso, sem
 *     registo criado pelo pipeline — esse já avisa) a quem vê a caixa.
 * "ok" honesto: falha de uma conta de caixa partilhada → ok:false; uma conta
 * pessoal que precisa de ser religada não pinta o cron de vermelho (avisa a
 * própria pessoa).
 */
import { sql } from "drizzle-orm";
import { canSeeMailbox, pipelineFor, isCompanyAddress, type MailboxConfig, type MailPipeline } from "../../shared/mail";
import type { InboundAlias } from "../emailParse";
import { gmailThreadIdToImap } from "./parse";
import { syncAccount, type AccountSyncResult, type StoredEvent } from "./sync";
import {
  addAutoLink, claimAccountLock, db, dbSyncStore, listSyncAccounts, loadBrandDomains, markAccount, releaseAccountLock, rowsOf,
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
  errors: string[];
  aiTriaged?: number;
  watchRenewed?: number;
}

const PIPELINE_WINDOW_DAYS = () => Math.max(1, Number(process.env.IMAP_SINCE_DAYS || 30));

// ─── Dependências reais das ligações automáticas ────────────────────────────

export const dbAutoLinkDeps: AutoLinkDeps = {
  async clientExists(email) {
    const d = await db();
    return rowsOf(await d.execute(sql`SELECT 1 AS x FROM multipark_bookings WHERE LOWER(TRIM(clientEmail)) = ${email} LIMIT 1`)).length > 0;
  },
  async clientEmailByPhone(phone) {
    const digits = String(phone).replace(/\D/g, "").slice(-9);
    if (digits.length < 9) return null;
    const d = await db();
    const r = rowsOf(await d.execute(sql`SELECT LOWER(TRIM(clientEmail)) AS email FROM multipark_bookings
      WHERE RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(clientPhone, ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), 9) = ${digits}
        AND clientEmail IS NOT NULL AND clientEmail <> '' ORDER BY checkIn DESC LIMIT 1`))[0];
    return r?.email ?? null;
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
  async openComplaintBySignals(email, plate, name) {
    const { findComplaintByClientSignals } = await import("../db");
    const c = await findComplaintByClientSignals(email, plate, name);
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

async function runPipeline(e: StoredEvent, api: GmailApi, pipeline: MailPipeline): Promise<{ targetModule: string; targetId?: number } | null> {
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
  return out.status === "processed" ? out.routed : null;
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

export function makeOnStored(api: GmailApi, report: MailSyncReport, brandDomains: Record<string, string[]>) {
  const windowMs = PIPELINE_WINDOW_DAYS() * 86_400_000;
  return async (e: StoredEvent) => {
    const p = e.parsed;
    const mailbox = e.classification.mailboxKey ? e.account.mailboxes.find((m) => m.key === e.classification.mailboxKey) ?? null : null;
    let routed: { targetModule: string; targetId?: number } | null = null;
    // 1) Pipeline antigo — só emails RECEBIDOS, recentes, de caixas partilhadas.
    if (!p.outbound && !e.classification.personal) {
      const accountPipelines = e.account.mailboxes.filter((m) => m.pipeline).map((m) => m.pipeline!) as MailPipeline[];
      const pipeline = pipelineFor(mailbox, p.subject, accountPipelines);
      const recent = p.sentAt ? Date.now() - Date.parse(p.sentAt.replace(" ", "T") + "Z") <= windowMs : false;
      if (pipeline && recent) {
        routed = await runPipeline(e, api, pipeline);
        if (routed && ["complaint", "lostfound", "review", "incident"].includes(routed.targetModule)) report.pipelineCreated++;
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
    // 3) Aviso a quem vê a caixa (conversa nova ou reaberta, não automática).
    const createdCase = !!routed && ["complaint", "lostfound", "review", "incident", "incident_dup"].includes(routed.targetModule);
    const automated = !!(await (await db()).execute(sql`SELECT automated FROM mail_messages WHERE id = ${e.result.messageId ?? 0}`).then((r) => Number(rowsOf(r)[0]?.automated ?? 0)));
    if (mailbox?.notify && !p.outbound && !automated && !createdCase && (e.result.newThread || e.result.reopened)) {
      await notifyNewMail(e, mailbox, projectId).catch(() => {});
    }
  };
}

// ─── Corrida ────────────────────────────────────────────────────────────────

export async function runMailSync(opts: { deadlineAt: number; onlyAccountKey?: string | null }): Promise<MailSyncReport> {
  const report: MailSyncReport = { ok: true, configured: false, done: true, accounts: [], stored: 0, pipelineCreated: 0, errors: [] };
  const { dwdConfigured } = await import("../google/workspace");
  const { gmailApiForAccount } = await import("./gmailApi");
  const accounts = (await listSyncAccounts({ dwdAvailable: dwdConfigured() })).filter((a) => !opts.onlyAccountKey || a.key === opts.onlyAccountKey);
  report.configured = accounts.length > 0;
  if (!accounts.length) return report;
  const brandDomains = await loadBrandDomains();
  let backfillDays = 90;
  try {
    const { getSetting } = await import("../appSettings");
    backfillDays = (await getSetting("mail.backfillDays")) ?? 90;
  } catch { /* omissão */ }

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
        deadlineAt: opts.deadlineAt - 2_000, backfillDays, brandDomains, onStored: makeOnStored(api, report, brandDomains),
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
  // Push (Pub/Sub): renova o watch das contas quando o interruptor está ligado.
  if (Date.now() + 8_000 < opts.deadlineAt) {
    try { report.watchRenewed = await renewWatches(accounts.map((a) => a.key), opts.deadlineAt); } catch { /* opcional */ }
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
