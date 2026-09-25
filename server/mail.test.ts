/**
 * Comunicação (Gmail dentro do dashboard) — testes sem rede nem BD: a API do
 * Gmail e a BD são falsas (em memória).
 */
import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { gmail_v1 } from "@googleapis/gmail";
import {
  canActOnMailbox, canSeeMailbox, canSeePersonalMailbox, canSendFromPersonalMailbox, checkSendAs, classifyMessage, extractAddresses,
  hasFeatureScopes, isAllowedWorkspaceIdentity, isAutomatedSender, isMailOverdue, mailboxCityRestricted, mailboxConfigSchema, parseDomainList,
  pickFromAddress, pipelineFor, retentionCutoff, sourceAccountKey, type MailboxConfig,
} from "../shared/mail";
import { MATRIX, can } from "../shared/access";
import { resolveRecipients, type RoutingCandidate } from "../shared/notificationRouting";
import { syncAccount, addedMessageIds, readChanges, backfillQuery, type GmailApiLike, type SyncStore, type AccountSyncState, type SyncAccount } from "./mail/sync";
import { parseGmailMessage, gmailThreadIdToImap, decodeBase64Url } from "./mail/parse";
import { proposeLinks, bookingConfidence, type AutoLinkDeps } from "./mail/autolink";
import { purgeExpiredMail, type RetentionDeps } from "./mail/store";
import { sanitizeEmailHtml, wrapEmailDocument } from "./mail/sanitize";
import { buildRawMessage, prefixedSubject, replyReferences, textToHtml } from "./mail/compose";
import { consentUrl, scopesFor, isAuthRevokedError, workspaceConfig } from "./google/workspace";
import { requestedFeatures, safeReturnPath } from "./google/userAccounts";
import { decryptSecret, encryptSecret } from "./integrations/googleAds/crypto";
import { MIGRATION_0145_STATEMENTS, SEED_0145_ID } from "./migrations/migration_0145";

// ─── Utilitários ────────────────────────────────────────────────────────────

const mb = (over: Partial<MailboxConfig>): MailboxConfig => mailboxConfigSchema.parse({
  key: "info", label: "Info", addresses: [{ address: "info@multipark.pt", brand: "multipark" }], sourceKind: "dwd",
  sourceEmail: "reservas@multipark.pt", module: "comunicacao", ...over,
});

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

function gmailMsg(id: string, o: { threadId?: string; from?: string; to?: string; deliveredTo?: string; subject?: string; labels?: string[]; text?: string; date?: number; msgId?: string } = {}): gmail_v1.Schema$Message {
  const headers = [
    { name: "From", value: o.from ?? "Cliente <cliente@gmail.com>" },
    { name: "To", value: o.to ?? "info@multipark.pt" },
    { name: "Subject", value: o.subject ?? `Assunto ${id}` },
    { name: "Message-ID", value: o.msgId ?? `<${id}@mail.gmail.com>` },
    ...(o.deliveredTo ? [{ name: "Delivered-To", value: o.deliveredTo }] : []),
  ];
  return {
    id, threadId: o.threadId ?? `t${id}`, labelIds: o.labels ?? ["INBOX", "UNREAD"], snippet: (o.text ?? "olá").slice(0, 50),
    internalDate: String(o.date ?? Date.UTC(2026, 8, 20, 10, 0, 0)),
    payload: { mimeType: "text/plain", headers, body: { data: b64(o.text ?? "olá") } },
  };
}

/** API Gmail falsa: mensagens por id, páginas de lista e de histórico. */
function fakeApi(opts: {
  messages: Record<string, gmail_v1.Schema$Message>;
  listPages: string[][];
  profileHistoryId?: string;
  history?: Record<string, { history: gmail_v1.Schema$History[]; historyId: string; next?: string }>;
  expiredFrom?: string;
}) {
  const calls = { get: [] as string[], list: 0, history: [] as string[] };
  const api: GmailApiLike = {
    async getProfile() { return { emailAddress: "reservas@multipark.pt", historyId: opts.profileHistoryId ?? "100" }; },
    async listMessages({ pageToken }) {
      calls.list++;
      const idx = pageToken ? Number(pageToken) : 0;
      return { ids: opts.listPages[idx] ?? [], nextPageToken: idx + 1 < opts.listPages.length ? String(idx + 1) : null };
    },
    async listHistory({ startHistoryId, pageToken }) {
      calls.history.push(`${startHistoryId}${pageToken ? `/${pageToken}` : ""}`);
      if (opts.expiredFrom && startHistoryId === opts.expiredFrom) throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
      const h = opts.history?.[startHistoryId] ?? { history: [], historyId: startHistoryId };
      return { history: h.history, historyId: h.historyId, nextPageToken: h.next ?? null };
    },
    async getMessage(id) { calls.get.push(id); return opts.messages[id] ?? null; },
  };
  return { api, calls };
}

/** BD falsa (em memória) com dedupe por (conta, id Gmail). */
function memStore() {
  const state = new Map<string, AccountSyncState>();
  const msgs = new Map<string, { gmailId: string; mailboxKey: string | null; brand: string | null; personal: boolean; read: boolean }>();
  const store: SyncStore = {
    async getState(k) { return state.get(k) ?? { historyId: null, backfillStartHistoryId: null, backfillPageToken: null, backfillDoneAt: null, backfillDays: null }; },
    async saveState(k, patch) { state.set(k, { ...(await store.getState(k)), ...patch }); },
    async knownMessageIds(k, ids) { return new Set(ids.filter((id) => msgs.has(`${k}|${id}`))); },
    async storeMessage(k, p, c) {
      const key = `${k}|${p.gmailMessageId}`;
      if (msgs.has(key)) return { stored: false, threadId: 1, messageId: null, newThread: false, reopened: false };
      msgs.set(key, { gmailId: p.gmailMessageId, mailboxKey: c.mailboxKey, brand: c.brand, personal: c.personal, read: !p.unread });
      return { stored: true, threadId: 1, messageId: msgs.size, newThread: true, reopened: false };
    },
    async setRead(k, id, read) { const m = msgs.get(`${k}|${id}`); if (m) m.read = read; },
  };
  return { store, state, msgs };
}

const account = (mailboxes: MailboxConfig[] = [mb({})], ownerUserId: number | null = null): SyncAccount =>
  ({ key: ownerUserId ? `user:${ownerUserId}` : "dwd:reservas@multipark.pt", email: "reservas@multipark.pt", ownerUserId, mailboxes });

// ─── 1. Classificação alias → caixa → marca ─────────────────────────────────

describe("classificação alias → caixa → marca", () => {
  const boxes = [
    mb({ key: "reclamacoes", addresses: [{ address: "reclamacoes@multipark.pt", brand: "multipark" }, { address: "reclamacoes@skypark.pt", brand: "skypark" }], module: "reclamacoes", pipeline: "reclamacoes" }),
    mb({ key: "info", addresses: [{ address: "info@multipark.pt", brand: "multipark" }, { address: "info@redpark.pt", brand: "redpark" }] }),
    mb({ key: "reservas", addresses: [{ address: "reservas@multipark.pt", brand: "multipark" }], catchAll: true, module: "reservas_operacoes" }),
  ];
  it("Delivered-To (alias) ganha ao To e dá a marca do alias", () => {
    const c = classifyMessage({ deliveredTo: ["reclamacoes@skypark.pt"], to: ["info@multipark.pt"] }, boxes);
    expect(c).toMatchObject({ mailboxKey: "reclamacoes", brand: "skypark", matchedAddress: "reclamacoes@skypark.pt", personal: false });
  });
  it("sem Delivered-To usa o To/Cc (case-insensitive)", () => {
    expect(classifyMessage({ to: ["cliente@x.pt"], cc: ["INFO@RedPark.pt"] }, boxes)).toMatchObject({ mailboxKey: "info", brand: "redpark" });
  });
  it("sem alias conhecido → caixa 'apanha tudo' da conta, marca pelo domínio", () => {
    expect(classifyMessage({ deliveredTo: ["geral@airpark.pt"] }, boxes)).toMatchObject({ mailboxKey: "reservas", brand: "airpark" });
  });
  it("conta pessoal sem alias partilhado → O meu email", () => {
    expect(classifyMessage({ to: ["jorge@multipark.pt"] }, [], { personalOwner: true })).toMatchObject({ mailboxKey: null, personal: true, brand: "multipark" });
  });
  it("mensagem ENVIADA classifica-se pelo From (alias com que saiu)", () => {
    expect(classifyMessage({ from: "reclamacoes@multipark.pt", to: ["cliente@gmail.com"] }, boxes, { outbound: true })).toMatchObject({ mailboxKey: "reclamacoes", brand: "multipark" });
  });
  it("caixas inativas não recebem", () => {
    const off = [{ ...boxes[1], active: false }];
    expect(classifyMessage({ to: ["info@multipark.pt"] }, off).mailboxKey).toBeNull();
  });
  it("pipeline: da caixa; 'ocorrência' no assunto como o IMAP fazia", () => {
    expect(pipelineFor(boxes[0], "x")).toBe("reclamacoes");
    expect(pipelineFor(boxes[2], "Fwd: Ocorrência no parque", ["ocorrencias"])).toBe("ocorrencias");
    expect(pipelineFor(boxes[2], "Fwd: Ocorrência no parque", [])).toBeNull();
  });
  it("endereços e remetentes automáticos", () => {
    expect(extractAddresses('"A" <A@X.pt>, b@y.pt; <c@z.pt>')).toEqual(["a@x.pt", "b@y.pt", "c@z.pt"]);
    expect(isAutomatedSender("no-reply@booking.com")).toBe(true);
    expect(isAutomatedSender("cliente@gmail.com", { autoSubmitted: "auto-replied" })).toBe(true);
    expect(isAutomatedSender("cliente@gmail.com")).toBe(false);
  });
  it("chave da conta de origem", () => {
    expect(sourceAccountKey(mb({ sourceEmail: "Reservas@Multipark.pt" }))).toBe("dwd:reservas@multipark.pt");
    expect(sourceAccountKey(mb({ sourceKind: "user", sourceUserId: 7, sourceEmail: "" }))).toBe("user:7");
  });
});

// ─── 2/3. Sincronização incremental, retoma e dedupe ────────────────────────

describe("sincronização Gmail (histórico) — importação resumível, incremental e dedupe", () => {
  const messages = Object.fromEntries(["a", "b", "c", "d", "e"].map((id) => [id, gmailMsg(id, { deliveredTo: "info@multipark.pt" })]));

  it("importação inicial: guarda o historyId de partida, percorre as páginas e passa a incremental", async () => {
    const { api, calls } = fakeApi({ messages, listPages: [["a", "b"], ["c"]], profileHistoryId: "500" });
    const { store, state, msgs } = memStore();
    const r = await syncAccount(api, store, account(), { deadlineAt: Date.now() + 10_000, backfillDays: 90 });
    expect(r.partial).toBe(false);
    expect(r.stored).toBe(3);
    expect(msgs.size).toBe(3);
    const s = state.get("dwd:reservas@multipark.pt")!;
    expect(s.historyId).toBe("500");            // sem buracos: começa no historyId de ANTES da importação
    expect(s.backfillPageToken).toBeNull();
    expect(calls.history).toEqual(["500"]);     // e logo a seguir faz o incremental
    expect([...msgs.values()][0]).toMatchObject({ mailboxKey: "info", brand: "multipark" });
  });

  it("prazo a meio: fica o token da página e a corrida seguinte continua (sem repetir o que já guardou)", async () => {
    const { api, calls } = fakeApi({ messages, listPages: [["a", "b"], ["c", "d"]], profileHistoryId: "700" });
    const { store, state, msgs } = memStore();
    let t = 0;
    const clock = () => t;
    // 1.ª corrida: o relógio passa o prazo depois da 1.ª página
    const r1 = await syncAccount(api, store, account(), {
      deadlineAt: 10, backfillDays: 90, concurrency: 1, now: clock,
      onStored: async () => { t += 4; },
    });
    expect(r1.partial).toBe(true);
    expect(msgs.size).toBeLessThan(4);
    expect(state.get("dwd:reservas@multipark.pt")!.historyId).toBeNull();
    // 2.ª corrida: termina
    t = 0;
    const r2 = await syncAccount(api, store, account(), { deadlineAt: 1e9, backfillDays: 90, now: clock });
    expect(r2.partial).toBe(false);
    expect(msgs.size).toBe(4);
    expect(state.get("dwd:reservas@multipark.pt")!.historyId).toBe("700");
    // nenhuma mensagem foi guardada duas vezes; as já guardadas nem voltaram a ser pedidas
    const counts = calls.get.reduce<Record<string, number>>((acc, id) => ({ ...acc, [id]: (acc[id] ?? 0) + 1 }), {});
    expect(Object.values(counts).every((n) => n === 1)).toBe(true);
  });

  it("incremental: mensagens novas do histórico, lidas/por ler e avanço do historyId", async () => {
    const { api } = fakeApi({
      messages, listPages: [],
      history: {
        "10": { history: [{ id: "11", messagesAdded: [{ message: { id: "d" } }] }, { id: "12", labelsRemoved: [{ message: { id: "a" }, labelIds: ["UNREAD"] }] }], historyId: "20", next: "p2" },
        "12": { history: [{ id: "13", messagesAdded: [{ message: { id: "e" } }, { message: { id: "d" } }] }], historyId: "20" },
      },
    });
    const { store, state, msgs } = memStore();
    await store.saveState("dwd:reservas@multipark.pt", { historyId: "10" });
    msgs.set("dwd:reservas@multipark.pt|a", { gmailId: "a", mailboxKey: "info", brand: "multipark", personal: false, read: false });
    const r = await syncAccount(api, store, account(), { deadlineAt: Date.now() + 10_000, backfillDays: 90 });
    expect(r.phase).toBe("incremental");
    expect(r.stored).toBe(2);                   // d e e (d repetido no histórico → dedupe)
    expect(r.readChanges).toBe(1);
    expect(msgs.get("dwd:reservas@multipark.pt|a")!.read).toBe(true);
    expect(state.get("dwd:reservas@multipark.pt")!.historyId).toBe("20");
  });

  it("historyId expirado (404) → recomeça com importação curta de 7 dias", async () => {
    const { api } = fakeApi({ messages, listPages: [], expiredFrom: "1" });
    const { store, state } = memStore();
    await store.saveState("dwd:reservas@multipark.pt", { historyId: "1" });
    const r = await syncAccount(api, store, account(), { deadlineAt: Date.now() + 10_000, backfillDays: 90 });
    expect(r.historyReset).toBe(true);
    expect(state.get("dwd:reservas@multipark.pt")).toMatchObject({ historyId: null, backfillDays: 7 });
    expect(backfillQuery(7)).toBe("newer_than:7d -in:chats");
  });

  it("rascunhos, spam e lixo não são guardados; duplicados contam como duplicados", async () => {
    const m = { x: gmailMsg("x", { labels: ["DRAFT"] }), y: gmailMsg("y", { labels: ["SPAM"] }), z: gmailMsg("z") };
    const { api } = fakeApi({ messages: m, listPages: [["x", "y", "z", "z"]] });
    const { store, msgs } = memStore();
    const r = await syncAccount(api, store, account(), { deadlineAt: Date.now() + 10_000, backfillDays: 30 });
    expect([...msgs.keys()]).toEqual(["dwd:reservas@multipark.pt|z"]);
    expect(r.duplicates).toBeGreaterThanOrEqual(1);
  });

  it("helpers do histórico", () => {
    const h: gmail_v1.Schema$History[] = [{ messagesAdded: [{ message: { id: "1" } }, { message: { id: "1" } }] }, { labelsAdded: [{ message: { id: "2" }, labelIds: ["UNREAD"] }] }];
    expect(addedMessageIds(h)).toEqual(["1"]);
    expect([...readChanges(h)]).toEqual([["2", false]]);
  });
});

// ─── Leitura de uma mensagem ────────────────────────────────────────────────

describe("parse de mensagens Gmail", () => {
  it("multipart: texto, HTML, anexos e cabeçalhos", () => {
    const m: gmail_v1.Schema$Message = {
      id: "m1", threadId: "18c2f", labelIds: ["INBOX"], internalDate: String(Date.UTC(2026, 0, 2, 3, 4, 5)),
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: '"Ana Silva" <ana@gmail.com>' }, { name: "To", value: "reclamacoes@multipark.pt" },
          { name: "Subject", value: "Dano no carro" }, { name: "Message-ID", value: "<abc@x>" },
          { name: "In-Reply-To", value: "<prev@x>" }, { name: "References", value: "<p0@x> <prev@x>" },
        ],
        parts: [
          { mimeType: "multipart/alternative", parts: [
            { mimeType: "text/plain", body: { data: b64("Olá, matrícula AA-00-BB") } },
            { mimeType: "text/html", body: { data: b64("<p>Olá</p>") } },
          ] },
          { mimeType: "image/jpeg", filename: "foto.jpg", body: { attachmentId: "att1", size: 1234 }, headers: [{ name: "Content-Disposition", value: "attachment" }] },
        ],
      },
    };
    const p = parseGmailMessage(m);
    expect(p).toMatchObject({ fromName: "Ana Silva", fromEmail: "ana@gmail.com", subject: "Dano no carro", rfcMessageId: "<abc@x>", inReplyTo: "<prev@x>", outbound: false, sentAt: "2026-01-02 03:04:05" });
    expect(p.references).toEqual(["<p0@x>", "<prev@x>"]);
    expect(p.text).toContain("AA-00-BB");
    expect(p.html).toBe("<p>Olá</p>");
    expect(p.attachments).toEqual([expect.objectContaining({ filename: "foto.jpg", attachmentId: "att1", size: 1234, inline: false })]);
  });
  it("id da conversa: hex (API) → decimal (X-GM-THRID do IMAP)", () => {
    expect(gmailThreadIdToImap("18c2f")).toBe(String(0x18c2f));
    expect(gmailThreadIdToImap("zz")).toBeNull();
    expect(decodeBase64Url(b64("ção"))).toBe("ção");
  });
  it("SENT = enviada", () => {
    expect(parseGmailMessage(gmailMsg("s", { labels: ["SENT"] })).outbound).toBe(true);
  });
});

// ─── 4. Ligações automáticas ────────────────────────────────────────────────

describe("ligações automáticas", () => {
  const deps = (over: Partial<AutoLinkDeps> = {}): AutoLinkDeps => ({
    clientExists: async (e) => e === "ana@gmail.com",
    clientEmailByPhone: async () => null,
    matchBooking: async (s) => (s.ref === "MP123" ? { externalId: "ext-1", projectId: 5, score: 100, matchedBy: ["ref"] } : s.plate ? { externalId: "ext-2", projectId: 6, score: 70, matchedBy: ["matricula", "janela"] } : null),
    complaintByThread: async () => null,
    openComplaintBySignals: async () => null,
    openLostFoundBySignals: async () => null,
    caseProject: async () => 9,
    ...over,
  });
  it("cliente pelo email + reserva pela referência (com cidade)", async () => {
    const links = await proposeLinks({ contactEmail: "Ana@Gmail.com", subject: "Reserva MP123", bodyText: "Referência: MP123", gmThreadId: null, refs: [], sentAt: "2026-09-20 10:00:00" }, deps());
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "client", entityId: "ana@gmail.com", confidence: 90 }),
      expect.objectContaining({ entityType: "booking", entityId: "ext-1", confidence: 95, projectId: 5 }),
    ]));
  });
  it("registo criado pelo pipeline = 100%; reclamação da mesma conversa = 95%", async () => {
    const links = await proposeLinks({
      contactEmail: null, subject: "x", bodyText: "", gmThreadId: "123", refs: ["<a@b>"], sentAt: null, pipeline: { targetModule: "complaint", targetId: 42 },
    }, deps({ complaintByThread: async () => ({ id: 42, projectId: 3 }) }));
    expect(links[0]).toMatchObject({ entityType: "complaint", entityId: "42", confidence: 100, projectId: 9 });
    expect(links).toHaveLength(1);
  });
  it("abaixo do mínimo não liga; perdido aberto do mesmo cliente liga a 70%", async () => {
    expect(bookingConfidence(20, false)).toBe(0);
    expect(bookingConfidence(45, false)).toBe(70);
    const links = await proposeLinks({ contactEmail: "outro@gmail.com", subject: "Esqueci o casaco", bodyText: "", gmThreadId: null, refs: [], sentAt: null },
      deps({ openLostFoundBySignals: async (e) => (e === "outro@gmail.com" ? { id: 8, projectId: 2 } : null) }));
    expect(links).toEqual([expect.objectContaining({ entityType: "lost_found", entityId: "8", confidence: 70 })]);
  });
});

// ─── 5. Quem vê o quê ───────────────────────────────────────────────────────

describe("visibilidade das caixas", () => {
  const v = (id: number, role: string, accessOverrides: any = null) => ({ id, role, accessOverrides });
  const recl = mb({ key: "reclamacoes", module: "reclamacoes", cityRule: "linked" });
  const admin = mb({ key: "admin", visibleRoles: ["admin", "super_admin"] });
  it("módulo comunicacao na matriz: nada para user/extra/condutor; TL/supervisor por cidade; nacionais", () => {
    for (const r of ["user", "extra", "condutor"] as const) expect(can(r, "comunicacao", "view")).toBe(false);
    expect(MATRIX.comunicacao.team_leader.access).toBe("city");
    expect(MATRIX.comunicacao.backoffice.access).toBe("national");
    expect(can("admin", "comunicacao", "manage")).toBe(true);
  });
  it("caixa por módulo: supervisor vê reclamações (cidade); extra não; frontoffice nacional", () => {
    expect(canSeeMailbox(v(1, "supervisor"), recl)).toBe(true);
    expect(mailboxCityRestricted(v(1, "supervisor"), recl)).toBe(true);
    expect(canSeeMailbox(v(2, "extra"), recl)).toBe(false);
    expect(mailboxCityRestricted(v(3, "frontoffice"), recl)).toBe(false);
    expect(canActOnMailbox(v(3, "frontoffice"), recl)).toBe(true);
  });
  it("admin@ só para admin/super_admin", () => {
    expect(canSeeMailbox(v(1, "backoffice"), admin)).toBe(false);
    expect(canSeeMailbox(v(1, "admin"), admin)).toBe(true);
    expect(canSeeMailbox(v(1, "super_admin"), { ...admin, active: false })).toBe(true);
  });
  it("override do módulo comunicacao dá a caixa a quem o papel não dá", () => {
    const ov = { comunicacao: { access: "national", actions: ["view", "edit"] }, reclamacoes: { access: "national", actions: ["view"] } };
    expect(canSeeMailbox(v(9, "condutor", ov), recl)).toBe(true);
  });
  it("O meu email: só o próprio; o super_admin vê mas não envia em nome de outro", () => {
    expect(canSeePersonalMailbox(v(5, "backoffice"), 5)).toBe(true);
    expect(canSeePersonalMailbox(v(6, "admin"), 5)).toBe(false);
    expect(canSeePersonalMailbox(v(1, "super_admin"), 5)).toBe(true);
    expect(canSendFromPersonalMailbox(v(1, "super_admin"), 5)).toBe(false);
    expect(canSendFromPersonalMailbox(v(5, "user"), 5)).toBe(true);
  });
  it("notificação mail_new só a quem vê a caixa (filtro)", () => {
    const cand = (id: number, role: string, cities: any = "all"): RoutingCandidate => ({ id, role, isActive: true, cities, prefs: { muted: [], email: {} } });
    const out = resolveRecipients({ kind: "mail_new", city: "lisbon", filter: (c) => canSeeMailbox({ id: c.id, role: c.role }, admin) },
      [cand(1, "backoffice"), cand(2, "admin"), cand(3, "super_admin")]);
    expect(out.map((r) => r.userId).sort()).toEqual([2, 3]);
  });
  it("SLA por responder", () => {
    const now = Date.UTC(2026, 8, 20, 12, 0, 0);
    expect(isMailOverdue("2026-09-19 11:00:00", 24, now)).toBe(true);
    expect(isMailOverdue("2026-09-20 11:00:00", 24, now)).toBe(false);
    expect(isMailOverdue(null, 24, now)).toBe(false);
  });
});

// ─── 6. Enviar como ─────────────────────────────────────────────────────────

describe("'Enviar como' (alias)", () => {
  const box = mb({ addresses: [{ address: "info@multipark.pt", brand: "multipark" }, { address: "info@skypark.pt", brand: "skypark" }] });
  it("responde pelo alias a que o cliente escreveu; senão pela marca; ignora pedidos fora da caixa", () => {
    expect(pickFromAddress(box, { matchedAddress: "info@skypark.pt" })).toBe("info@skypark.pt");
    expect(pickFromAddress(box, { brand: "skypark" })).toBe("info@skypark.pt");
    expect(pickFromAddress(box, { requested: "ceo@multipark.pt" })).toBe("info@multipark.pt");
    expect(pickFromAddress(box, { requested: "INFO@skypark.pt", matchedAddress: "info@multipark.pt" })).toBe("info@skypark.pt");
  });
  it("erro claro quando o alias não está em sendAs ou não está verificado", () => {
    const list = [{ sendAsEmail: "reservas@multipark.pt", isPrimary: true }, { sendAsEmail: "info@multipark.pt", verificationStatus: "accepted", displayName: "Multipark" }, { sendAsEmail: "info@skypark.pt", verificationStatus: "pending" }];
    expect(checkSendAs("info@multipark.pt", "reservas@multipark.pt", list)).toEqual({ ok: true, email: "info@multipark.pt", displayName: "Multipark" });
    const miss = checkSendAs("comercial@multipark.pt", "reservas@multipark.pt", list);
    expect(miss.ok).toBe(false);
    expect(!miss.ok && miss.error).toMatch(/não está configurado como "Enviar email como".*reservas@multipark\.pt/);
    const pend = checkSendAs("info@skypark.pt", "reservas@multipark.pt", list);
    expect(!pend.ok && pend.error).toMatch(/ainda não foi verificado/);
  });
  it("composição: Re:/Fwd: sem acumular, References, In-Reply-To no MIME", async () => {
    expect(prefixedSubject("RE: Re: Fwd: Olá", "Re")).toBe("Re: Olá");
    expect(replyReferences({ rfcMessageId: "<c@x>", references: ["<a@x>", "<c@x>"] })).toEqual(["<a@x>", "<c@x>"]);
    expect(textToHtml("a <b>\n\nhttps://x.pt")).toContain('<a href="https://x.pt">');
    const raw = (await buildRawMessage({ from: { name: "Multipark", address: "info@multipark.pt" }, to: ["c@gmail.com"], cc: [], bcc: [], subject: "Re: Olá", text: "t", html: "<p>t</p>", inReplyTo: "<m@x>", references: ["<m@x>"] })).toString();
    expect(raw).toMatch(/In-Reply-To: <m@x>/);
    expect(raw).toMatch(/From: Multipark <info@multipark\.pt>/);
  });
});

// ─── 7. Retenção ────────────────────────────────────────────────────────────

describe("retenção dos emails", () => {
  it("limite em anos (mínimo 1)", () => {
    expect(retentionCutoff(5, new Date(Date.UTC(2026, 8, 24, 10, 0, 0)))).toBe("2021-09-24 10:00:00");
    expect(retentionCutoff(0, new Date(Date.UTC(2026, 8, 24)))).toBe("2021-09-24 00:00:00");
  });
  it("apaga só as mensagens antigas SEM ligação e as conversas que ficam vazias", async () => {
    const msgs = [
      { id: 1, threadId: 10, sentAt: "2019-01-01 00:00:00" }, { id: 2, threadId: 10, sentAt: "2019-02-01 00:00:00" },
      { id: 3, threadId: 11, sentAt: "2019-01-01 00:00:00" }, { id: 4, threadId: 12, sentAt: "2026-01-01 00:00:00" },
      { id: 5, threadId: 13, sentAt: "2019-01-01 00:00:00" }, { id: 6, threadId: 13, sentAt: "2026-01-01 00:00:00" },
    ];
    const linked = new Set([11]);
    let threads = new Set([10, 11, 12, 13]);
    const recomputed: number[] = [];
    const deps: RetentionDeps = {
      async expired(cutoff, limit) { return msgs.filter((m) => m.sentAt < cutoff && !linked.has(m.threadId)).slice(0, limit); },
      async deleteMessages(ids) { for (const id of ids) msgs.splice(msgs.findIndex((m) => m.id === id), 1); },
      async deleteEmptyThreads(ts) { const empty = ts.filter((t) => !msgs.some((m) => m.threadId === t)); threads = new Set([...threads].filter((t) => !empty.includes(t))); return empty.length; },
      async recompute(ts) { recomputed.push(...ts); },
    };
    const r = await purgeExpiredMail(deps, "2021-09-24 00:00:00", { deadlineAt: Date.now() + 5_000, batch: 2 });
    expect(r).toMatchObject({ messages: 3, threads: 1, partial: false });
    expect(msgs.map((m) => m.id).sort()).toEqual([3, 4, 6]);   // 3 fica: conversa ligada a um cliente/caso
    expect([...threads].sort()).toEqual([11, 12, 13]);
  });
});

// ─── 8. IMAP como alternativa, sem processar duas vezes ─────────────────────

vi.mock("./db", async (orig) => {
  const actual: any = await orig();
  const claimed = new Set<string>();
  return {
    ...actual,
    claimInboundEmail: vi.fn(async (d: any) => (claimed.has(d.messageId) ? null : (claimed.add(d.messageId), claimed.size))),
    updateInboundEmail: vi.fn(async () => {}),
    deleteInboundEmail: vi.fn(async () => {}),
  };
});

describe("pipeline antigo partilhado IMAP ↔ Gmail", () => {
  it("o mesmo Message-ID só é processado uma vez (a 2.ª fonte leva 'duplicado' e nem lê anexos)", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    const load = vi.fn(async () => []);
    const base = { alias: "campanhas" as const, messageId: "<dup-1@x>", gmThreadId: null, refs: [], subject: "Relatório", receivedAt: null, loadAttachments: load };
    const first = await processInboundEmail(base);   // ex.: veio pelo Gmail
    const second = await processInboundEmail(base);  // ex.: o IMAP apanhou o mesmo email
    expect(first.status).toBe("skipped");
    expect(second.status).toBe("duplicate");
    expect(load).not.toHaveBeenCalled();
  });
  it("o IMAP salta os aliases que o Gmail já trata e fica com os restantes", async () => {
    const { imapAliases } = await import("./jobs/emailInboundSync");
    expect(imapAliases(new Set(["reclamacoes", "perdidos"]))).toEqual(["criticas", "recursos-humanos", "campanhas", "ocorrencias"]);
    expect(imapAliases(new Set())).toHaveLength(6);
  });
});

// ─── 9/10. OAuth: domínio do Workspace, âmbitos, PKCE e cifra do token ──────

describe("OAuth por utilizador", () => {
  it("só contas do Workspace (hd) com email verificado", () => {
    const d = parseDomainList("multipark.pt, @skypark.pt");
    expect(d).toEqual(["multipark.pt", "skypark.pt"]);
    expect(isAllowedWorkspaceIdentity({ email: "Ana@Multipark.pt", email_verified: true, hd: "multipark.pt" }, d)).toEqual({ ok: true, email: "ana@multipark.pt" });
    expect(isAllowedWorkspaceIdentity({ email: "ana@gmail.com", email_verified: true }, d).ok).toBe(false);          // sem hd
    expect(isAllowedWorkspaceIdentity({ email: "x@outra.pt", email_verified: true, hd: "outra.pt" }, d).ok).toBe(false);
    expect(isAllowedWorkspaceIdentity({ email: "ana@multipark.pt", email_verified: false, hd: "multipark.pt" }, d).ok).toBe(false);
    expect(isAllowedWorkspaceIdentity({ email: "ana@multipark.pt", email_verified: true, hd: "multipark.pt" }, []).ok).toBe(false);
  });
  it("autorização incremental: só os âmbitos pedidos (gmail); os outros ficam preparados mas desligados", () => {
    expect(scopesFor(["gmail"])).toEqual(["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"]);
    expect(requestedFeatures("drive,contacts")).toEqual(["gmail"]);
    expect(requestedFeatures("calendar,drive,tasks")).toEqual(["calendar", "tasks"]);
    expect(requestedFeatures("gmail,x")).toEqual(["gmail"]);
    expect(hasFeatureScopes("openid https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send", "gmail")).toBe(true);
    expect(hasFeatureScopes("https://www.googleapis.com/auth/gmail.readonly", "gmail")).toBe(false);
  });
  it("URL de consentimento com PKCE S256, state, hd, offline e include_granted_scopes", async () => {
    const { OAuth2Client } = await import("google-auth-library");
    const client = new OAuth2Client({ clientId: "cid", clientSecret: "sec", redirectUri: "https://app/cb" });
    const url = new URL(consentUrl(client, { state: "st", codeChallenge: "ch", features: ["gmail"], hd: "multipark.pt", loginHint: "ana@multipark.pt" }));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("hd")).toBe("multipark.pt");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("scope")).toContain("gmail.send");
  });
  it("regresso só para caminhos relativos da app (sem redirecionador aberto)", () => {
    expect(safeReturnPath("/comunicacao/meu-email")).toBe("/comunicacao/meu-email");
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil", "", null]) expect(safeReturnPath(bad)).toBe("/perfil");
  });
  it("refresh token cifrado AES-256-GCM: sem a chave certa não se lê; adulterado falha", () => {
    const key = crypto.randomBytes(32);
    const enc = encryptSecret("1//refresh-token", key);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(enc).not.toContain("refresh-token");
    expect(decryptSecret(enc, key)).toBe("1//refresh-token");
    expect(() => decryptSecret(enc, crypto.randomBytes(32))).toThrow();
    const raw = Buffer.from(enc.slice(7), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptSecret(`enc:v1:${raw.toString("base64")}`, key)).toThrow();
  });
  it("revogação/delegação em falta é reconhecida", () => {
    expect(isAuthRevokedError({ response: { data: { error: "invalid_grant" } } })).toBe(true);
    expect(isAuthRevokedError(new Error("unauthorized_client: Client is unauthorized"))).toBe(true);
    expect(isAuthRevokedError(new Error("timeout"))).toBe(false);
  });
  it("configuração: domínios por omissão e fallback do cliente OAuth do login", () => {
    const c = workspaceConfig({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", APP_URL: "https://dash.multipark.pt/" });
    expect(c).toMatchObject({ clientId: "a", clientSecret: "b", domains: ["multipark.pt"], serviceAccount: null, redirectUri: "https://dash.multipark.pt/api/google-account/oauth/callback" });
  });
});

// ─── HTML seguro ────────────────────────────────────────────────────────────

describe("HTML dos emails", () => {
  const dirty = `<div onclick="x()"><script>alert(1)</script><p style="color:red;background:url(https://t.x/p.gif)">Olá</p>
    <img src="https://track.example/pixel.gif"><img src="cid:logo1"><a href="javascript:alert(1)">x</a><a href="https://ok.pt">ok</a>
    <iframe src="https://evil"></iframe><form><input></form></div>`;
  it("sem scripts, handlers, iframes, formulários nem url() nos estilos; links seguros", () => {
    const { html } = sanitizeEmailHtml(dirty);
    expect(html).not.toMatch(/script|onclick|iframe|<form|<input|javascript:|url\(/i);
    expect(html).toContain('href="https://ok.pt"');
    expect(html).toMatch(/rel="noopener noreferrer nofollow"/);
    expect(html).toContain("color:red");
  });
  it("imagens remotas bloqueadas por omissão; 'Mostrar imagens' carrega-as; cid: resolvido para data:", () => {
    const blocked = sanitizeEmailHtml(dirty);
    expect(blocked.blockedImages).toBe(1);
    expect(blocked.html).not.toContain("track.example");
    const shown = sanitizeEmailHtml(dirty, { showImages: true, cidMap: { logo1: "data:image/png;base64,AAAA" } });
    expect(shown.html).toContain("https://track.example/pixel.gif");
    expect(shown.html).toContain("data:image/png;base64,AAAA");
    expect(wrapEmailDocument("x")).toContain("img-src data:;");
    expect(wrapEmailDocument("x", { showImages: true })).toContain("img-src https:");
  });
});

// ─── Migração ───────────────────────────────────────────────────────────────

describe("migração 0145", () => {
  it("idempotente (IF NOT EXISTS) e sementes das caixas só uma vez (marca)", () => {
    const creates = MIGRATION_0145_STATEMENTS.filter((s) => s.startsWith("CREATE TABLE"));
    expect(creates.every((s) => s.includes("IF NOT EXISTS"))).toBe(true);
    const seeds = MIGRATION_0145_STATEMENTS.filter((s) => s.startsWith("INSERT IGNORE INTO `mail_mailboxes`"));
    expect(seeds.length).toBeGreaterThanOrEqual(9);
    expect(seeds.every((s) => s.includes(SEED_0145_ID))).toBe(true);
    for (const k of ["reclamacoes", "perdidos", "criticas", "ocorrencias", "rh", "campanhas", "info", "admin", "comercial"]) {
      expect(seeds.some((s) => s.includes(`'${k}'`))).toBe(true);
    }
    expect(MIGRATION_0145_STATEMENTS.at(-1)).toContain(SEED_0145_ID);
  });
});
