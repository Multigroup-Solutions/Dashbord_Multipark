/**
 * Sincronização do Gmail por conta (núcleo, dependências injetáveis):
 *
 *  1. Importação inicial (resumível): guarda o historyId ATUAL da conta
 *     (getProfile) e percorre messages.list `newer_than:<N>d` página a
 *     página; o pageToken fica gravado a cada página — se o prazo acabar a
 *     meio, a corrida seguinte continua dessa página (as mensagens já
 *     guardadas saltam pelo dedupe). No fim, o historyId guardado passa a
 *     ser o ponto de partida do incremental (sem buracos).
 *  2. Incremental: users.history.list desde o historyId; mensagens novas →
 *     buscar e guardar; mudanças de UNREAD → lidas/por ler. Depois de cada
 *     página processada por inteiro, o historyId avança para o último
 *     registo dessa página (resumível); no fim, para o historyId da conta.
 *     historyId expirado (404) → recomeça com uma importação curta (7 dias).
 *  3. Dedupe: (conta, id Gmail) único; o `store` diz o que já existe.
 *
 * Classificação (alias → caixa → marca) e o que acontece a seguir (pipeline
 * antigo, ligações, notificações) ficam fora: `onStored`.
 */
import type { gmail_v1 } from "@googleapis/gmail";
import { classifyMessage, isAutomatedSender, isCompanyAddress, type Classification, type MailboxConfig } from "../../shared/mail";
import { parseGmailMessage, type ParsedGmailMessage } from "./parse";

// ─── Dependências ───────────────────────────────────────────────────────────

/** O que a sincronização usa da API Gmail (implementação real em gmailApi.ts). */
export interface GmailApiLike {
  getProfile(): Promise<{ emailAddress: string | null; historyId: string | null }>;
  listMessages(p: { q: string; pageToken?: string | null; maxResults: number }): Promise<{ ids: string[]; nextPageToken: string | null }>;
  listHistory(p: { startHistoryId: string; pageToken?: string | null }): Promise<{ history: gmail_v1.Schema$History[]; historyId: string | null; nextPageToken: string | null }>;
  getMessage(id: string): Promise<gmail_v1.Schema$Message | null>;
}

export interface AccountSyncState {
  historyId: string | null;
  backfillStartHistoryId: string | null;
  backfillPageToken: string | null;
  backfillDoneAt: string | null;
  backfillDays: number | null;
}

export interface StoreMessageResult {
  stored: boolean;
  threadId: number;
  messageId: number | null;
  newThread: boolean;
  /** Mensagem recebida numa conversa que estava resolvida (reabre). */
  reopened: boolean;
}

export interface SyncStore {
  getState(accountKey: string): Promise<AccountSyncState>;
  saveState(accountKey: string, patch: Partial<AccountSyncState>): Promise<void>;
  knownMessageIds(accountKey: string, gmailIds: readonly string[]): Promise<Set<string>>;
  storeMessage(accountKey: string, p: ParsedGmailMessage, c: Classification, extra: { ownerUserId: number | null; automated: boolean; contactEmail: string | null; contactName: string | null }): Promise<StoreMessageResult>;
  setRead(accountKey: string, gmailId: string, read: boolean): Promise<void>;
}

export interface SyncAccount {
  key: string;
  email: string;
  /** Conta pessoal (caixa "O meu email" do utilizador). */
  ownerUserId: number | null;
  /** Caixas partilhadas lidas desta conta. */
  mailboxes: MailboxConfig[];
}

export interface StoredEvent {
  account: SyncAccount;
  parsed: ParsedGmailMessage;
  classification: Classification;
  result: StoreMessageResult;
}

export interface SyncOptions {
  deadlineAt: number;
  backfillDays: number;
  brandDomains?: Record<string, string[]>;
  onStored?: (e: StoredEvent) => Promise<void>;
  now?: () => number;
  /** Mensagens buscadas em paralelo (default 4). */
  concurrency?: number;
}

export interface AccountSyncResult {
  accountKey: string;
  phase: "backfill" | "incremental";
  fetched: number;
  stored: number;
  duplicates: number;
  readChanges: number;
  partial: boolean;
  historyReset: boolean;
  errors: string[];
}

/** Lista de pesquisa da importação inicial. PURA. */
export function backfillQuery(days: number): string {
  return `newer_than:${Math.max(1, Math.floor(days))}d -in:chats`;
}

/** 404 do history.list = historyId demasiado antigo. PURA. */
export function isHistoryExpired(err: unknown): boolean {
  const e = err as any;
  return Number(e?.response?.status ?? e?.status ?? e?.code) === 404;
}

/** Ids de mensagens novas numa página de histórico (sem repetidos, por ordem). PURA. */
export function addedMessageIds(history: readonly gmail_v1.Schema$History[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of history) {
    for (const a of h.messagesAdded ?? []) {
      const id = a.message?.id;
      if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
  }
  return out;
}

/** Mudanças de lida/por ler (UNREAD) numa página de histórico. PURA. */
export function readChanges(history: readonly gmail_v1.Schema$History[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const h of history) {
    for (const a of h.labelsAdded ?? []) if (a.message?.id && (a.labelIds ?? []).includes("UNREAD")) out.set(a.message.id, false);
    for (const r of h.labelsRemoved ?? []) if (r.message?.id && (r.labelIds ?? []).includes("UNREAD")) out.set(r.message.id, true);
  }
  return out;
}

const SKIP_LABELS = new Set(["DRAFT", "SPAM", "TRASH", "CHAT"]);

async function processIds(
  ids: readonly string[],
  api: GmailApiLike,
  store: SyncStore,
  account: SyncAccount,
  opts: SyncOptions,
  res: AccountSyncResult,
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const known = ids.length ? await store.knownMessageIds(account.key, ids) : new Set<string>();
  const todo = ids.filter((id) => !known.has(id));
  res.duplicates += ids.length - todo.length;
  const batch = Math.max(1, opts.concurrency ?? 4);
  for (let i = 0; i < todo.length; i += batch) {
    if (now() > opts.deadlineAt) return false;
    const chunk = todo.slice(i, i + batch);
    const msgs = await Promise.all(chunk.map(async (id) => {
      try { return await api.getMessage(id); } catch (err: any) {
        if (Number(err?.response?.status ?? err?.status) === 404) return null; // apagada entretanto
        throw err;
      }
    }));
    for (const m of msgs) {
      if (!m?.id) continue;
      res.fetched++;
      const parsed = parseGmailMessage(m, { accountEmail: account.email });
      if (parsed.labelIds.some((l) => SKIP_LABELS.has(l))) continue;
      const company = (a: string) => isCompanyAddress(a, opts.brandDomains);
      const classification = classifyMessage(
        { deliveredTo: parsed.deliveredTo, xOriginalTo: parsed.xOriginalTo, to: parsed.to, cc: parsed.cc, bcc: parsed.bcc, from: parsed.fromEmail },
        account.mailboxes,
        { outbound: parsed.outbound, personalOwner: account.ownerUserId != null, brandDomains: opts.brandDomains },
      );
      const party = (() => {
        if (!parsed.outbound) {
          const e = parsed.replyTo && !company(parsed.replyTo) ? parsed.replyTo : parsed.fromEmail;
          return e && !company(e) ? { email: e, name: e === parsed.fromEmail ? parsed.fromName : null } : { email: null, name: null };
        }
        const e = [...parsed.to, ...parsed.cc].find((a) => !company(a)) ?? null;
        return { email: e, name: null };
      })();
      const automated = !parsed.outbound && isAutomatedSender(parsed.fromEmail, { autoSubmitted: parsed.autoSubmitted, precedence: parsed.precedence });
      const result = await store.storeMessage(account.key, parsed, classification, {
        ownerUserId: classification.personal ? account.ownerUserId : null,
        automated,
        contactEmail: party.email,
        contactName: party.name,
      });
      if (!result.stored) { res.duplicates++; continue; }
      res.stored++;
      if (opts.onStored) {
        try { await opts.onStored({ account, parsed, classification, result }); }
        catch (err: any) { res.errors.push(`pós-processamento ${parsed.gmailMessageId}: ${String(err?.message ?? err).slice(0, 160)}`); }
      }
    }
  }
  return true;
}

/** Sincroniza UMA conta até ao prazo. Nunca deixa o estado inconsistente. */
export async function syncAccount(api: GmailApiLike, store: SyncStore, account: SyncAccount, opts: SyncOptions): Promise<AccountSyncResult> {
  const now = opts.now ?? Date.now;
  let state = await store.getState(account.key);
  const res: AccountSyncResult = {
    accountKey: account.key, phase: state.historyId ? "incremental" : "backfill",
    fetched: 0, stored: 0, duplicates: 0, readChanges: 0, partial: false, historyReset: false, errors: [],
  };

  // ── 1. Importação inicial ──
  if (!state.historyId) {
    const days = state.backfillDays ?? opts.backfillDays;
    if (!state.backfillStartHistoryId) {
      const profile = await api.getProfile();
      if (!profile.historyId) throw new Error("A conta não devolveu historyId.");
      await store.saveState(account.key, { backfillStartHistoryId: profile.historyId, backfillPageToken: null, backfillDays: days, backfillDoneAt: null });
      state = { ...state, backfillStartHistoryId: profile.historyId, backfillPageToken: null, backfillDays: days };
    }
    let token = state.backfillPageToken;
    for (;;) {
      if (now() > opts.deadlineAt) { res.partial = true; return res; }
      const page = await api.listMessages({ q: backfillQuery(days), pageToken: token, maxResults: 100 });
      const done = await processIds(page.ids, api, store, account, opts, res);
      if (!done) {
        // Prazo a meio da página: fica o token DESTA página (o que já foi guardado salta pelo dedupe).
        await store.saveState(account.key, { backfillPageToken: token });
        res.partial = true;
        return res;
      }
      token = page.nextPageToken;
      if (!token) {
        await store.saveState(account.key, { historyId: state.backfillStartHistoryId, backfillPageToken: null, backfillDoneAt: new Date(now()).toISOString().slice(0, 19).replace("T", " ") });
        state = { ...state, historyId: state.backfillStartHistoryId };
        break;
      }
      await store.saveState(account.key, { backfillPageToken: token });
    }
    res.phase = "incremental";
  }

  // ── 2. Incremental ──
  let start = state.historyId!;
  let pageToken: string | null = null;
  for (;;) {
    if (now() > opts.deadlineAt) { res.partial = true; return res; }
    let page: Awaited<ReturnType<GmailApiLike["listHistory"]>>;
    try {
      page = await api.listHistory({ startHistoryId: start, pageToken });
    } catch (err) {
      if (!isHistoryExpired(err)) throw err;
      // historyId expirado: importação curta para voltar a ter um ponto de partida.
      await store.saveState(account.key, { historyId: null, backfillStartHistoryId: null, backfillPageToken: null, backfillDoneAt: null, backfillDays: 7 });
      res.historyReset = true;
      res.partial = true;
      return res;
    }
    for (const [id, read] of readChanges(page.history)) {
      await store.setRead(account.key, id, read);
      res.readChanges++;
    }
    const done = await processIds(addedMessageIds(page.history), api, store, account, opts, res);
    if (!done) { res.partial = true; return res; }
    const lastId = page.history.length ? page.history[page.history.length - 1].id : null;
    if (page.nextPageToken) {
      // Página inteira tratada: avança até ao último registo dela (resumível).
      if (lastId) { await store.saveState(account.key, { historyId: lastId }); start = lastId; pageToken = null; }
      else pageToken = page.nextPageToken;
      continue;
    }
    const latest = page.historyId ?? lastId ?? start;
    if (latest !== state.historyId) await store.saveState(account.key, { historyId: latest });
    return res;
  }
}
