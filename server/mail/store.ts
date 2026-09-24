/**
 * Comunicação — acesso à BD (SQL parametrizado, compatível com
 * ONLY_FULL_GROUP_BY). Caixas, contas de sincronização, conversas,
 * mensagens, ligações e retenção. As regras puras vivem em shared/mail.ts.
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../db";
import {
  MAIL_DEFAULT_BACKFILL_DAYS, DEFAULT_BRAND_DOMAINS, hasFeatureScopes, mailboxConfigSchema, normalizeAddress, personalAccountKey,
  sourceAccountKey, userIdOfAccountKey, type Classification, type MailboxConfig, type MailLinkType,
} from "../../shared/mail";
import type { AccountSyncState, StoreMessageResult, SyncAccount, SyncStore } from "./sync";
import type { ParsedGmailMessage } from "./parse";
import { sanitizeForStorage } from "./sanitize";

export const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const header = (res: unknown): any => (Array.isArray(res) ? res[0] : res);
export const nowUtc = (d: Date = new Date()) => d.toISOString().slice(0, 19).replace("T", " ");

export async function db() {
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível.");
  return d;
}

const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw as T;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
};

// ─── Caixas ─────────────────────────────────────────────────────────────────

export type MailboxRow = MailboxConfig & { id: number; updatedAt: string | null };

export function rowToMailbox(r: any): MailboxRow | null {
  const cfg = mailboxConfigSchema.safeParse({
    key: r.mailboxKey,
    label: r.label,
    addresses: parseJson(r.addressesJson, []),
    sourceKind: r.sourceKind === "user" ? "user" : "dwd",
    sourceEmail: r.sourceEmail ?? "",
    sourceUserId: r.sourceUserId != null ? Number(r.sourceUserId) : null,
    module: r.module,
    pipeline: r.pipeline || null,
    cityRule: r.cityRule === "linked" ? "linked" : "all",
    visibleRoles: parseJson(r.visibleRolesJson, []),
    signatures: parseJson(r.signaturesJson, {}),
    catchAll: Number(r.catchAll) === 1,
    notify: Number(r.notify) === 1,
    active: Number(r.active) === 1,
    sortOrder: Number(r.sortOrder ?? 100),
  });
  if (!cfg.success) {
    console.warn("[mail] caixa inválida ignorada:", r.mailboxKey, cfg.error.issues[0]?.message);
    return null;
  }
  return { ...cfg.data, id: Number(r.id), updatedAt: r.updatedAt ?? null };
}

let mailboxCache: { at: number; rows: MailboxRow[] } | null = null;
export function invalidateMailboxCache() { mailboxCache = null; }

export async function listMailboxes(opts: { fresh?: boolean } = {}): Promise<MailboxRow[]> {
  if (!opts.fresh && mailboxCache && Date.now() - mailboxCache.at < 30_000) return mailboxCache.rows;
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT * FROM mail_mailboxes ORDER BY sortOrder, label`)).map(rowToMailbox).filter((x): x is MailboxRow => !!x);
  mailboxCache = { at: Date.now(), rows };
  return rows;
}

export async function getMailbox(key: string | null | undefined): Promise<MailboxRow | null> {
  if (!key) return null;
  return (await listMailboxes()).find((m) => m.key === key) ?? null;
}

export async function saveMailbox(cfg: MailboxConfig, userId: number): Promise<void> {
  const d = await db();
  await d.execute(sql`INSERT INTO mail_mailboxes (mailboxKey, label, addressesJson, sourceKind, sourceEmail, sourceUserId, module, pipeline, cityRule,
      visibleRolesJson, signaturesJson, catchAll, notify, active, sortOrder, updatedById)
    VALUES (${cfg.key}, ${cfg.label}, ${JSON.stringify(cfg.addresses)}, ${cfg.sourceKind}, ${cfg.sourceKind === "dwd" ? normalizeAddress(cfg.sourceEmail) : null},
      ${cfg.sourceKind === "user" ? cfg.sourceUserId : null}, ${cfg.module}, ${cfg.pipeline}, ${cfg.cityRule}, ${JSON.stringify(cfg.visibleRoles)},
      ${JSON.stringify(cfg.signatures)}, ${cfg.catchAll ? 1 : 0}, ${cfg.notify ? 1 : 0}, ${cfg.active ? 1 : 0}, ${cfg.sortOrder}, ${userId})
    ON DUPLICATE KEY UPDATE label = VALUES(label), addressesJson = VALUES(addressesJson), sourceKind = VALUES(sourceKind), sourceEmail = VALUES(sourceEmail),
      sourceUserId = VALUES(sourceUserId), module = VALUES(module), pipeline = VALUES(pipeline), cityRule = VALUES(cityRule),
      visibleRolesJson = VALUES(visibleRolesJson), signaturesJson = VALUES(signaturesJson), catchAll = VALUES(catchAll), notify = VALUES(notify),
      active = VALUES(active), sortOrder = VALUES(sortOrder), updatedById = VALUES(updatedById)`);
  invalidateMailboxCache();
}

export async function deleteMailbox(key: string): Promise<void> {
  const d = await db();
  await d.execute(sql`DELETE FROM mail_mailboxes WHERE mailboxKey = ${key}`);
  invalidateMailboxCache();
}

export async function loadBrandDomains(): Promise<Record<string, string[]>> {
  try {
    const { getSetting } = await import("../appSettings");
    return ((await getSetting("mail.brandDomains")) as Record<string, string[]> | null) ?? DEFAULT_BRAND_DOMAINS;
  } catch { return DEFAULT_BRAND_DOMAINS; }
}

// ─── Contas de sincronização ────────────────────────────────────────────────

export interface MailAccountRow {
  accountKey: string; email: string | null; status: string; lastError: string | null; lastSyncAt: string | null; lastOkAt: string | null;
  historyId: string | null; backfillDoneAt: string | null; backfillPageToken: string | null; messagesStored: number; watchExpiration: number | null;
}

export async function listMailAccountRows(): Promise<MailAccountRow[]> {
  const d = await db();
  return rowsOf(await d.execute(sql`SELECT accountKey, email, status, lastError, lastSyncAt, lastOkAt, historyId, backfillDoneAt, backfillPageToken,
      messagesStored, watchExpiration FROM mail_accounts ORDER BY accountKey`)).map((r) => ({
    ...r, messagesStored: Number(r.messagesStored ?? 0), watchExpiration: r.watchExpiration != null ? Number(r.watchExpiration) : null,
  }));
}

/**
 * Contas a sincronizar: as de origem das caixas partilhadas ativas (DWD ou
 * conta ligada de alguém) + a conta pessoal de quem ligou o Gmail. Garante
 * a linha em mail_accounts. Ordenadas pela sincronização mais antiga.
 */
export async function listSyncAccounts(opts: { dwdAvailable: boolean }): Promise<Array<SyncAccount & { state: MailAccountRow | null }>> {
  const d = await db();
  const mailboxes = (await listMailboxes({ fresh: true })).filter((m) => m.active);
  const accounts = new Map<string, SyncAccount>();
  const google = rowsOf(await d.execute(sql`SELECT userId, email, scopes, status FROM google_user_accounts
    WHERE refreshTokenEnc IS NOT NULL AND status <> 'disconnected'`));
  const gmailUsers = new Map<number, string>();
  for (const g of google) if (hasFeatureScopes(g.scopes, "gmail")) gmailUsers.set(Number(g.userId), normalizeAddress(g.email));
  for (const m of mailboxes) {
    const key = sourceAccountKey(m);
    if (!key) continue;
    if (m.sourceKind === "dwd" && !opts.dwdAvailable) continue;
    const uid = userIdOfAccountKey(key);
    if (uid != null && !gmailUsers.has(uid)) continue;
    const email = m.sourceKind === "dwd" ? normalizeAddress(m.sourceEmail) : gmailUsers.get(uid!)!;
    const acc = accounts.get(key) ?? { key, email, ownerUserId: uid, mailboxes: [] };
    acc.mailboxes.push(m);
    accounts.set(key, acc);
  }
  for (const [uid, email] of gmailUsers) {
    const key = personalAccountKey(uid);
    if (!accounts.has(key)) accounts.set(key, { key, email, ownerUserId: uid, mailboxes: [] });
  }
  for (const a of accounts.values()) {
    await d.execute(sql`INSERT IGNORE INTO mail_accounts (accountKey, email, status, backfillDays) VALUES (${a.key}, ${a.email}, 'pending', NULL)`);
  }
  const states = new Map((await listMailAccountRows()).map((r) => [r.accountKey, r]));
  return Array.from(accounts.values())
    .map((a) => ({ ...a, state: states.get(a.key) ?? null }))
    .sort((x, y) => String(x.state?.lastSyncAt ?? "").localeCompare(String(y.state?.lastSyncAt ?? "")));
}

/** Bloqueio por conta (linha, sobrevive a serverless): 1 corrida de cada vez. */
export async function claimAccountLock(accountKey: string, staleSeconds = 90): Promise<boolean> {
  const d = await db();
  const cutoff = nowUtc(new Date(Date.now() - staleSeconds * 1000));
  const res = await d.execute(sql`UPDATE mail_accounts SET syncLockAt = ${nowUtc()}
    WHERE accountKey = ${accountKey} AND (syncLockAt IS NULL OR syncLockAt < ${cutoff})`);
  return Number(header(res)?.affectedRows ?? 0) === 1;
}

export async function releaseAccountLock(accountKey: string): Promise<void> {
  const d = await db();
  await d.execute(sql`UPDATE mail_accounts SET syncLockAt = NULL WHERE accountKey = ${accountKey}`);
}

export async function markAccount(accountKey: string, patch: { status: string; lastError?: string | null; ok?: boolean; stored?: number }): Promise<void> {
  const d = await db();
  const n = nowUtc();
  await d.execute(sql`UPDATE mail_accounts SET status = ${patch.status}, lastError = ${patch.lastError ? patch.lastError.slice(0, 500) : null},
    lastSyncAt = ${n}, lastOkAt = ${patch.ok ? n : sql`lastOkAt`}, messagesStored = messagesStored + ${patch.stored ?? 0}
    WHERE accountKey = ${accountKey}`);
}

/**
 * Pipelines antigos (aliases) que a sincronização do Gmail já trata: caixa
 * ativa com pipeline + conta de origem saudável (importação inicial feita e
 * sincronizada com sucesso nas últimas 2 h). Os restantes ficam no IMAP.
 */
export async function gmailHandledPipelines(): Promise<Set<string>> {
  const out = new Set<string>();
  const mailboxes = (await listMailboxes()).filter((m) => m.active && m.pipeline);
  if (!mailboxes.length) return out;
  const d = await db();
  const cutoff = nowUtc(new Date(Date.now() - 2 * 3_600_000));
  const healthy = new Set(rowsOf(await d.execute(sql`SELECT accountKey FROM mail_accounts
    WHERE status = 'ok' AND backfillDoneAt IS NOT NULL AND lastOkAt >= ${cutoff}`)).map((r) => String(r.accountKey)));
  for (const m of mailboxes) {
    const key = sourceAccountKey(m);
    if (key && healthy.has(key)) out.add(m.pipeline!);
  }
  return out;
}

// ─── SyncStore (BD) ─────────────────────────────────────────────────────────

const STATE_COLS = ["historyId", "backfillStartHistoryId", "backfillPageToken", "backfillDoneAt", "backfillDays"] as const;

export async function recomputeThread(threadId: number): Promise<void> {
  const d = await db();
  await d.execute(sql`UPDATE mail_threads t
    JOIN (
      SELECT threadId, COUNT(*) AS c,
             SUM(CASE WHEN isRead = 0 AND direction = 'in' THEN 1 ELSE 0 END) AS u,
             MAX(sentAt) AS lastAt,
             MAX(CASE WHEN direction = 'in' THEN sentAt END) AS li,
             MAX(CASE WHEN direction = 'out' THEN sentAt END) AS lo
      FROM mail_messages WHERE threadId = ${threadId} GROUP BY threadId
    ) x ON x.threadId = t.id
    SET t.messageCount = x.c, t.unreadCount = x.u, t.lastMessageAt = x.lastAt, t.lastInboundAt = x.li, t.lastOutboundAt = x.lo,
        t.awaitingSince = (SELECT MIN(m.sentAt) FROM mail_messages m
                           WHERE m.threadId = x.threadId AND m.direction = 'in' AND m.automated = 0 AND (x.lo IS NULL OR m.sentAt > x.lo))
    WHERE t.id = ${threadId}`);
  await d.execute(sql`UPDATE mail_threads t
    JOIN (SELECT snippet FROM mail_messages WHERE threadId = ${threadId} ORDER BY sentAt DESC, id DESC LIMIT 1) l
    SET t.snippet = l.snippet WHERE t.id = ${threadId}`);
}

export const dbSyncStore: SyncStore = {
  async getState(accountKey: string): Promise<AccountSyncState> {
    const d = await db();
    const r = rowsOf(await d.execute(sql`SELECT historyId, backfillStartHistoryId, backfillPageToken, backfillDoneAt, backfillDays
      FROM mail_accounts WHERE accountKey = ${accountKey} LIMIT 1`))[0] ?? {};
    let backfillDays = r.backfillDays != null ? Number(r.backfillDays) : null;
    if (backfillDays == null) {
      try {
        const { getSetting } = await import("../appSettings");
        backfillDays = (await getSetting("mail.backfillDays")) ?? MAIL_DEFAULT_BACKFILL_DAYS;
      } catch { backfillDays = MAIL_DEFAULT_BACKFILL_DAYS; }
    }
    return {
      historyId: r.historyId ?? null, backfillStartHistoryId: r.backfillStartHistoryId ?? null,
      backfillPageToken: r.backfillPageToken ?? null, backfillDoneAt: r.backfillDoneAt ?? null, backfillDays,
    };
  },
  async saveState(accountKey, patch) {
    const sets: SQL[] = [];
    for (const k of STATE_COLS) if (k in patch) sets.push(sql`${sql.raw("`" + k + "`")} = ${(patch as any)[k] ?? null}`);
    if (!sets.length) return;
    const d = await db();
    await d.execute(sql`UPDATE mail_accounts SET ${sql.join(sets, sql`, `)} WHERE accountKey = ${accountKey}`);
  },
  async knownMessageIds(accountKey, ids) {
    if (!ids.length) return new Set();
    const d = await db();
    const rows = rowsOf(await d.execute(sql`SELECT gmailMessageId FROM mail_messages
      WHERE accountKey = ${accountKey} AND gmailMessageId IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`));
    return new Set(rows.map((r) => String(r.gmailMessageId)));
  },
  async storeMessage(accountKey, p, c, extra): Promise<StoreMessageResult> {
    const d = await db();
    // O mesmo email pode chegar à MESMA caixa por duas contas (ex.: alias em
    // duas caixas de origem) — guarda-se uma vez (Message-ID).
    if (c.mailboxKey && p.rfcMessageId) {
      const dup = rowsOf(await d.execute(sql`SELECT threadId FROM mail_messages
        WHERE rfcMessageId = ${p.rfcMessageId} AND mailboxKey = ${c.mailboxKey} AND accountKey <> ${accountKey} LIMIT 1`))[0];
      if (dup) return { stored: false, threadId: Number(dup.threadId), messageId: null, newThread: false, reopened: false };
    }
    let thread = rowsOf(await d.execute(sql`SELECT id, status FROM mail_threads WHERE accountKey = ${accountKey} AND gmailThreadId = ${p.gmailThreadId} LIMIT 1`))[0];
    let newThread = false;
    if (!thread) {
      const ins = await d.execute(sql`INSERT IGNORE INTO mail_threads (accountKey, gmailThreadId, mailboxKey, ownerUserId, brand, subject, snippet,
          contactEmail, contactName, matchedAddress, status, awaitingSince)
        VALUES (${accountKey}, ${p.gmailThreadId}, ${c.mailboxKey}, ${extra.ownerUserId}, ${c.brand}, ${p.subject || null}, ${p.snippet || null},
          ${extra.contactEmail}, ${extra.contactName ? extra.contactName.slice(0, 255) : null}, ${c.matchedAddress}, 'aberto', NULL)`);
      newThread = Number(header(ins)?.affectedRows ?? 0) === 1;
      thread = rowsOf(await d.execute(sql`SELECT id, status FROM mail_threads WHERE accountKey = ${accountKey} AND gmailThreadId = ${p.gmailThreadId} LIMIT 1`))[0];
    } else {
      // Completa o que faltava (1.ª mensagem pode ter sido nossa, sem cliente).
      await d.execute(sql`UPDATE mail_threads SET
          mailboxKey = COALESCE(mailboxKey, ${c.mailboxKey}), brand = COALESCE(brand, ${c.brand}),
          contactEmail = COALESCE(contactEmail, ${extra.contactEmail}), contactName = COALESCE(contactName, ${extra.contactName ? extra.contactName.slice(0, 255) : null}),
          matchedAddress = COALESCE(matchedAddress, ${c.matchedAddress}), subject = COALESCE(NULLIF(subject, ''), ${p.subject || null})
        WHERE id = ${Number(thread.id)}`);
    }
    const threadId = Number(thread.id);
    const ins = await d.execute(sql`INSERT IGNORE INTO mail_messages (threadId, accountKey, gmailMessageId, gmailThreadId, rfcMessageId, inReplyTo, referencesText,
        mailboxKey, brand, direction, fromName, fromEmail, toJson, ccJson, deliveredTo, matchedAddress, subject, snippet, bodyText, bodyHtml,
        attachmentsJson, labelIdsJson, sentAt, isRead, automated)
      VALUES (${threadId}, ${accountKey}, ${p.gmailMessageId}, ${p.gmailThreadId}, ${p.rfcMessageId ? p.rfcMessageId.slice(0, 255) : null},
        ${p.inReplyTo ? p.inReplyTo.slice(0, 255) : null}, ${p.references.length ? p.references.join(" ").slice(0, 8000) : null},
        ${c.mailboxKey}, ${c.brand}, ${p.outbound ? "out" : "in"}, ${p.fromName ? p.fromName.slice(0, 255) : null}, ${p.fromEmail},
        ${JSON.stringify(p.to)}, ${JSON.stringify(p.cc)}, ${p.deliveredTo[0] ?? null}, ${c.matchedAddress}, ${p.subject || null}, ${p.snippet || null},
        ${p.text ? p.text.slice(0, 200_000) : null}, ${p.html ? sanitizeForStorage(p.html) : null},
        ${p.attachments.length ? JSON.stringify(p.attachments) : null}, ${JSON.stringify(p.labelIds).slice(0, 1000)}, ${p.sentAt},
        ${p.outbound || !p.unread ? 1 : 0}, ${extra.automated ? 1 : 0})`);
    const stored = Number(header(ins)?.affectedRows ?? 0) === 1;
    if (!stored) return { stored: false, threadId, messageId: null, newThread: false, reopened: false };
    const messageId = Number(header(ins)?.insertId ?? 0) || null;
    let reopened = false;
    if (!p.outbound && !extra.automated && String(thread.status) === "resolvido") {
      await d.execute(sql`UPDATE mail_threads SET status = 'aberto', statusChangedAt = ${nowUtc()} WHERE id = ${threadId}`);
      reopened = true;
    }
    await recomputeThread(threadId);
    return { stored, threadId, messageId, newThread, reopened };
  },
  async setRead(accountKey, gmailId, read) {
    const d = await db();
    const r = rowsOf(await d.execute(sql`SELECT threadId FROM mail_messages WHERE accountKey = ${accountKey} AND gmailMessageId = ${gmailId} LIMIT 1`))[0];
    if (!r) return;
    await d.execute(sql`UPDATE mail_messages SET isRead = ${read ? 1 : 0} WHERE accountKey = ${accountKey} AND gmailMessageId = ${gmailId}`);
    await recomputeThread(Number(r.threadId));
  },
};

export async function setMessagePipeline(messageId: number, pipeline: string, status: string): Promise<void> {
  const d = await db();
  await d.execute(sql`UPDATE mail_messages SET pipeline = ${pipeline}, pipelineStatus = ${status.slice(0, 16)} WHERE id = ${messageId}`);
}

export async function setThreadProjectIfEmpty(threadId: number, projectId: number | null | undefined): Promise<void> {
  if (!projectId) return;
  const d = await db();
  await d.execute(sql`UPDATE mail_threads SET projectId = ${projectId} WHERE id = ${threadId} AND projectId IS NULL`);
}

// ─── Ligações ───────────────────────────────────────────────────────────────

export interface MailLinkRow { id: number; threadId: number; messageId: number | null; entityType: MailLinkType; entityId: string; confidence: number; source: "auto" | "manual"; reason: string | null; createdAt: string }

/** Ligação automática: nunca ressuscita uma ligação desligada à mão; sobe a confiança. */
export async function addAutoLink(l: { threadId: number; messageId: number | null; entityType: MailLinkType; entityId: string; confidence: number; reason: string }): Promise<void> {
  if (!l.entityId) return;
  const d = await db();
  await d.execute(sql`INSERT INTO mail_links (threadId, messageId, entityType, entityId, confidence, source, reason)
    VALUES (${l.threadId}, ${l.messageId}, ${l.entityType}, ${l.entityId}, ${l.confidence}, 'auto', ${l.reason.slice(0, 120)})
    ON DUPLICATE KEY UPDATE confidence = IF(removedAt IS NULL, GREATEST(confidence, VALUES(confidence)), confidence)`);
}

export async function addManualLink(l: { threadId: number; entityType: MailLinkType; entityId: string; userId: number }): Promise<void> {
  const d = await db();
  await d.execute(sql`INSERT INTO mail_links (threadId, messageId, entityType, entityId, confidence, source, reason, createdById)
    VALUES (${l.threadId}, NULL, ${l.entityType}, ${l.entityId}, 100, 'manual', 'ligado à mão', ${l.userId})
    ON DUPLICATE KEY UPDATE removedAt = NULL, removedById = NULL, source = 'manual', confidence = 100, createdById = VALUES(createdById)`);
}

export async function removeLink(l: { threadId: number; entityType: MailLinkType; entityId: string; userId: number }): Promise<void> {
  const d = await db();
  await d.execute(sql`UPDATE mail_links SET removedAt = ${nowUtc()}, removedById = ${l.userId}
    WHERE threadId = ${l.threadId} AND entityType = ${l.entityType} AND entityId = ${l.entityId}`);
}

export async function linksForThreads(threadIds: readonly number[]): Promise<MailLinkRow[]> {
  if (!threadIds.length) return [];
  const d = await db();
  return rowsOf(await d.execute(sql`SELECT id, threadId, messageId, entityType, entityId, confidence, source, reason, createdAt FROM mail_links
    WHERE removedAt IS NULL AND threadId IN (${sql.join(threadIds.map((i) => sql`${i}`), sql`, `)}) ORDER BY confidence DESC, id`))
    .map((r) => ({ ...r, id: Number(r.id), threadId: Number(r.threadId), messageId: r.messageId != null ? Number(r.messageId) : null, confidence: Number(r.confidence) }));
}

export async function threadIdsForEntity(type: MailLinkType, entityId: string, limit = 50): Promise<number[]> {
  const d = await db();
  return rowsOf(await d.execute(sql`SELECT l.threadId FROM mail_links l JOIN mail_threads t ON t.id = l.threadId
    WHERE l.entityType = ${type} AND l.entityId = ${entityId} AND l.removedAt IS NULL
    ORDER BY t.lastMessageAt DESC LIMIT ${limit}`)).map((r) => Number(r.threadId));
}

// ─── Retenção ───────────────────────────────────────────────────────────────

export interface RetentionDeps {
  /** Mensagens mais antigas do que o limite em conversas SEM ligações ativas. */
  expired(cutoff: string, limit: number): Promise<Array<{ id: number; threadId: number }>>;
  deleteMessages(ids: number[]): Promise<void>;
  /** Apaga as conversas que ficaram sem mensagens; devolve quantas. */
  deleteEmptyThreads(threadIds: number[]): Promise<number>;
  recompute(threadIds: number[]): Promise<void>;
}

/** Limpeza da retenção (lotes, com prazo). */
export async function purgeExpiredMail(deps: RetentionDeps, cutoff: string, opts: { deadlineAt: number; batch?: number }): Promise<{ messages: number; threads: number; partial: boolean }> {
  const out = { messages: 0, threads: 0, partial: false };
  const batch = opts.batch ?? 500;
  for (;;) {
    if (Date.now() > opts.deadlineAt) { out.partial = true; break; }
    const rows = await deps.expired(cutoff, batch);
    if (!rows.length) break;
    await deps.deleteMessages(rows.map((r) => r.id));
    out.messages += rows.length;
    const threads = Array.from(new Set(rows.map((r) => r.threadId)));
    out.threads += await deps.deleteEmptyThreads(threads);
    await deps.recompute(threads);
    if (rows.length < batch) break;
  }
  return out;
}

export const dbRetentionDeps: RetentionDeps = {
  async expired(cutoff, limit) {
    const d = await db();
    return rowsOf(await d.execute(sql`SELECT m.id, m.threadId FROM mail_messages m
      WHERE m.sentAt < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM mail_links l WHERE l.threadId = m.threadId AND l.removedAt IS NULL)
      ORDER BY m.id LIMIT ${limit}`)).map((r) => ({ id: Number(r.id), threadId: Number(r.threadId) }));
  },
  async deleteMessages(ids) {
    if (!ids.length) return;
    const d = await db();
    await d.execute(sql`DELETE FROM mail_messages WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  },
  async deleteEmptyThreads(threadIds) {
    if (!threadIds.length) return 0;
    const d = await db();
    const list = sql.join(threadIds.map((i) => sql`${i}`), sql`, `);
    const empty = rowsOf(await d.execute(sql`SELECT t.id FROM mail_threads t WHERE t.id IN (${list})
      AND NOT EXISTS (SELECT 1 FROM mail_messages m WHERE m.threadId = t.id)`)).map((r) => Number(r.id));
    if (!empty.length) return 0;
    const el = sql.join(empty.map((i) => sql`${i}`), sql`, `);
    await d.execute(sql`DELETE FROM mail_links WHERE threadId IN (${el})`);
    await d.execute(sql`DELETE FROM mail_threads WHERE id IN (${el})`);
    return empty.length;
  },
  async recompute(threadIds) {
    for (const id of threadIds) await recomputeThread(id).catch(() => {});
  },
};

export async function runMailRetention(opts: { deadlineAt: number; now?: Date }): Promise<{ messages: number; threads: number; partial: boolean; cutoff: string }> {
  const { getSetting } = await import("../appSettings");
  const { retentionCutoff, MAIL_DEFAULT_RETENTION_YEARS } = await import("../../shared/mail");
  const years = (await getSetting("mail.retentionYears")) ?? MAIL_DEFAULT_RETENTION_YEARS;
  const cutoff = retentionCutoff(years, opts.now);
  const r = await purgeExpiredMail(dbRetentionDeps, cutoff, { deadlineAt: opts.deadlineAt });
  return { ...r, cutoff };
}

export type { Classification, ParsedGmailMessage };
