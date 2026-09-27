/**
 * Caixa sem os envios automáticos da aplicação (migração 0220): os pedidos e
 * lembretes de disponibilidade que saem por recursos-humanos@ (e os outros
 * envios automáticos) ficam automáticos/escondidos na Comunicação até a pessoa
 * responder; os antigos são limpos pelo passo de dados. Sem rede nem BD.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { gmail_v1 } from "googleapis";
import {
  AUTO_MAIL_HEADER, MAIL_AUTOMATED_RESERVATION, MAIL_AUTOMATED_SYSTEM, SYSTEM_MAIL_HEADER, autoMailKindLabel, autoSendStatus, automaticOutboundKind,
  mailboxConfigSchema, normalizeAutoMailKind, threadIsAutomatic, type MailboxConfig,
} from "../shared/mail";
import { buildAvailabilityMessage } from "../shared/availabilityMessages";
import { parseGmailMessage } from "./mail/parse";
import { syncAccount, type AccountSyncState, type GmailApiLike, type SyncAccount, type SyncStore } from "./mail/sync";
import { clearSendAsCache, sendMailWith, type AutoSendRecord, type SenderApi, type SystemMailDeps } from "./mail/systemMail";
import {
  AUTO_SUBJECT_LIKE_0220, DATA_0220_ID, IDEMPOTENT_ERROR_CODES_0220, MIGRATION_0220_STATEMENTS, pickAutoOutbound0220, runMigration0220Data,
} from "./migrations/migration_0220";

const root = resolve(import.meta.dirname, "..");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

const reservas: MailboxConfig = mailboxConfigSchema.parse({
  key: "reservas", label: "Reservas (geral)", addresses: [{ address: "reservas@multipark.pt", brand: "multipark" }, { address: "recursos-humanos@multipark.pt", brand: "multipark" }],
  sourceKind: "dwd", sourceEmail: "reservas@multipark.pt", module: "reservas_operacoes", catchAll: true,
});
const availabilitySubject = buildAvailabilityMessage({ kind: "week", weekLabel: "Segunda 28/09 a Domingo 04/10" }).subject;

function gmailMsg(id: string, o: { threadId: string; from: string; to: string; subject: string; labels: string[]; headers?: Array<{ name: string; value: string }> }): gmail_v1.Schema$Message {
  return {
    id, threadId: o.threadId, labelIds: o.labels, snippet: "olá", internalDate: String(Date.UTC(2026, 8, 25, 10, 0, 0) + Number(id.replace(/\D/g, "") || 0) * 1000),
    payload: { mimeType: "text/plain", body: { data: b64("olá") }, headers: [
      { name: "From", value: o.from }, { name: "To", value: o.to }, { name: "Subject", value: o.subject }, { name: "Message-ID", value: `<${id}@x>` },
      ...(o.headers ?? []),
    ] },
  };
}

function fakeApi(messages: Record<string, gmail_v1.Schema$Message>): GmailApiLike {
  return {
    async getProfile() { return { emailAddress: "reservas@multipark.pt", historyId: "500" }; },
    async listMessages() { return { ids: Object.keys(messages), nextPageToken: null }; },
    async listHistory({ startHistoryId }) { return { history: [], historyId: startHistoryId, nextPageToken: null }; },
    async getMessage(id) { return messages[id] ?? null; },
  };
}

/** Loja em memória: guarda o `automated` como a BD (0/1/2/3) e calcula a conversa como o SQL. */
function memStore() {
  const state = new Map<string, AccountSyncState>();
  const msgs = new Map<string, { gmailThreadId: string; automated: number; systemMail: boolean }>();
  const store: SyncStore = {
    async getState(k) { return state.get(k) ?? { historyId: null, backfillStartHistoryId: null, backfillPageToken: null, backfillDoneAt: null, backfillDays: null }; },
    async saveState(k, patch) { state.set(k, { ...(await store.getState(k)), ...patch }); },
    async knownMessageIds(k, ids) { return new Set(ids.filter((id) => msgs.has(`${k}|${id}`))); },
    async storeMessage(k, p, _c, extra) {
      const automated = extra.systemMail ? MAIL_AUTOMATED_SYSTEM : extra.reservationNotice ? MAIL_AUTOMATED_RESERVATION : extra.automated ? 1 : 0;
      msgs.set(`${k}|${p.gmailMessageId}`, { gmailThreadId: p.gmailThreadId, automated, systemMail: !!extra.systemMail });
      return { stored: true, threadId: 1, messageId: msgs.size, newThread: true, reopened: false };
    },
    async setRead() { /* nada */ },
  };
  const threadHidden = (gmailThreadId: string) => threadIsAutomatic([...msgs.values()].filter((m) => m.gmailThreadId === gmailThreadId).map((m) => m.automated));
  return { store, msgs, threadHidden };
}

const account: SyncAccount = { key: "dwd:reservas@multipark.pt", email: "reservas@multipark.pt", ownerUserId: null, mailboxes: [reservas] };

// ─── 1. Classificador ───────────────────────────────────────────────────────

describe("envio automático nosso (classificador)", () => {
  it("cabeçalho X-Multipark-Auto / X-Multipark-System ganha sempre", () => {
    expect(automaticOutboundKind({ outbound: true, fromEmail: "recursos-humanos@multipark.pt", subject: "Qualquer", autoKind: "availability_reminder" })).toBe("availability_reminder");
    expect(automaticOutboundKind({ outbound: false, fromEmail: "x@y.pt", subject: "Aviso", systemHeader: true })).toBe("system");
    expect(normalizeAutoMailKind(" Availability-Request ")).toBe("availability_request");
    expect(normalizeAutoMailKind("")).toBeNull();
  });
  it("sem cabeçalho (antigos): remetente das automações + assunto conhecido", () => {
    expect(availabilitySubject).toBe("Disponibilidade — semana de Segunda 28/09 a Domingo 04/10");
    expect(automaticOutboundKind({ outbound: true, fromEmail: "Recursos-Humanos@multipark.pt", subject: availabilitySubject })).toBe("availability_request");
    expect(automaticOutboundKind({ outbound: true, fromEmail: "recursos-humanos@multipark.pt", subject: `[TESTE] ${availabilitySubject}` })).toBe("availability_test");
    for (const kind of ["day_shift", "day_hours", "day_range"] as const) {
      const s = buildAvailabilityMessage({ kind, dateLabel: "amanhã (29/09)", shift: "night", fromHour: 8, toHour: 20 }).subject;
      expect(automaticOutboundKind({ outbound: true, fromEmail: "recursos-humanos@multipark.pt", subject: s })).toBe("availability_request");
    }
    expect(automaticOutboundKind({ outbound: true, fromEmail: "reservas@multipark.pt", subject: "Escala Multipark — turno cancelado (29/09)" })).toBe("schedule_cancel");
    expect(automaticOutboundKind({ outbound: true, fromEmail: "notificacoes@multipark.pt", subject: "Escala Multipark — 29/09" }, ["notificacoes@multipark.pt"])).toBe("schedule_notice");
  });
  it("não apanha: respostas (Re:), mensagens recebidas, outros remetentes, assuntos humanos", () => {
    expect(automaticOutboundKind({ outbound: true, fromEmail: "recursos-humanos@multipark.pt", subject: `Re: ${availabilitySubject}` })).toBeNull();
    expect(automaticOutboundKind({ outbound: false, fromEmail: "recursos-humanos@multipark.pt", subject: availabilitySubject })).toBeNull();
    expect(automaticOutboundKind({ outbound: true, fromEmail: "jorge@multipark.pt", subject: availabilitySubject })).toBeNull();
    expect(automaticOutboundKind({ outbound: true, fromEmail: "reservas@multipark.pt", subject: "A sua reserva MP123" })).toBeNull();
  });
  it("conversa só com envios nossos → escondida; com resposta humana → visível", () => {
    expect(threadIsAutomatic([MAIL_AUTOMATED_SYSTEM, MAIL_AUTOMATED_SYSTEM])).toBe(true);
    expect(threadIsAutomatic([MAIL_AUTOMATED_SYSTEM, 0])).toBe(false);
    expect(threadIsAutomatic([MAIL_AUTOMATED_SYSTEM, 1])).toBe(false);
    expect(threadIsAutomatic([])).toBe(false);
    // O SQL (recomputeThread) segue a mesma regra.
    const store = readFileSync(resolve(root, "server/mail/store.ts"), "utf8");
    expect(store).toMatch(/automated IN \(\$\{MAIL_AUTOMATED_RESERVATION\}, \$\{MAIL_AUTOMATED_SYSTEM\}\) THEN 0 ELSE 1/);
  });
  it("estado na ficha do extra: enviado / respondido", () => {
    expect(autoSendStatus(null)).toBe("enviado");
    expect(autoSendStatus({ threadAutomated: 1, lastInboundAt: null })).toBe("enviado");
    expect(autoSendStatus({ threadAutomated: 0, lastInboundAt: "2026-09-26 10:00:00" })).toBe("respondido");
    expect(autoMailKindLabel("availability_reminder")).toBe("Lembrete de disponibilidade");
    expect(autoMailKindLabel("coisa_nova")).toBe("coisa_nova");
  });
});

// ─── 2. Sincronização ───────────────────────────────────────────────────────

describe("sincronização: pedidos de disponibilidade fora da caixa partilhada", () => {
  it("envio com cabeçalho e envio antigo sem cabeçalho → automáticos (3), conversa escondida; a resposta do extra torna-a visível", async () => {
    const messages = {
      a1: gmailMsg("a1", { threadId: "T1", from: "Multipark Operações <recursos-humanos@multipark.pt>", to: "extra1@gmail.com", subject: availabilitySubject, labels: ["SENT"],
        headers: [{ name: SYSTEM_MAIL_HEADER, value: "1" }, { name: AUTO_MAIL_HEADER, value: "availability_request" }, { name: "Auto-Submitted", value: "auto-generated" }] }),
      a2: gmailMsg("a2", { threadId: "T2", from: "Multipark Operações <recursos-humanos@multipark.pt>", to: "extra2@gmail.com", subject: availabilitySubject, labels: ["SENT"] }),
      a3: gmailMsg("a3", { threadId: "T2", from: "Extra Dois <extra2@gmail.com>", to: "recursos-humanos@multipark.pt", subject: `Re: ${availabilitySubject}`, labels: ["INBOX", "UNREAD"] }),
      h1: gmailMsg("h1", { threadId: "T3", from: "reservas@multipark.pt", to: "cliente@gmail.com", subject: "A sua reserva", labels: ["SENT"] }),
    };
    const { store, msgs, threadHidden } = memStore();
    await syncAccount(fakeApi(messages), store, account, { deadlineAt: Date.now() + 10_000, backfillDays: 90 });
    expect(msgs.get("dwd:reservas@multipark.pt|a1")).toMatchObject({ automated: MAIL_AUTOMATED_SYSTEM, systemMail: true });
    expect(msgs.get("dwd:reservas@multipark.pt|a2")).toMatchObject({ automated: MAIL_AUTOMATED_SYSTEM, systemMail: true });
    expect(msgs.get("dwd:reservas@multipark.pt|a3")).toMatchObject({ automated: 0, systemMail: false });
    expect(msgs.get("dwd:reservas@multipark.pt|h1")).toMatchObject({ automated: 0 });
    expect(threadHidden("T1")).toBe(true);   // só o pedido → escondida
    expect(threadHidden("T2")).toBe(false);  // o extra respondeu → conversa normal
    expect(threadHidden("T3")).toBe(false);  // email humano
  });
  it("parse: X-Multipark-Auto lido e normalizado", () => {
    const m = parseGmailMessage(gmailMsg("p1", { threadId: "T", from: "recursos-humanos@multipark.pt", to: "e@x.pt", subject: "s", labels: ["SENT"], headers: [{ name: AUTO_MAIL_HEADER, value: "Availability_Reminder" }] }));
    expect(m.autoKind).toBe("availability_reminder");
    expect(m.systemMail).toBe(false);
  });
  it("a sincronização considera também o remetente de sistema configurado", () => {
    const service = readFileSync(resolve(root, "server/mail/service.ts"), "utf8");
    expect(service).toMatch(/autoSenders/);
  });
});

// ─── 3. Envio ───────────────────────────────────────────────────────────────

function fakeDeps() {
  const sent: Array<{ accountKey: string; raw: string }> = [];
  const recorded: AutoSendRecord[] = [];
  const deps: SystemMailDeps = {
    async systemSender() { return "reservas@multipark.pt"; },
    async mailboxes() { return [reservas]; },
    async apiFor(accountKey): Promise<SenderApi> {
      return {
        async listSendAs() { return [{ sendAsEmail: "reservas@multipark.pt", isPrimary: true, verificationStatus: null }, { sendAsEmail: "recursos-humanos@multipark.pt", verificationStatus: "accepted" }]; },
        async sendRaw(raw) { sent.push({ accountKey, raw: raw.toString("utf8") }); return { id: "gm1", threadId: "gt1" }; },
      };
    },
    dwdAvailable: () => true,
    async recordAutoSend(r) { recorded.push(r); },
  };
  return { deps, sent, recorded };
}

describe("envio automático por alias (recursos-humanos@)", () => {
  it("leva X-Multipark-System + X-Multipark-Auto + Auto-Submitted e fica registado com o extra", async () => {
    clearSendAsCache();
    const { deps, sent, recorded } = fakeDeps();
    const r = await sendMailWith(deps, { to: "extra@gmail.com", subject: availabilitySubject, html: "<p>x</p>", from: "recursos-humanos@multipark.pt", fromName: "Multipark Operações", auto: { kind: "availability_request", employeeId: 42 } });
    expect(r).toMatchObject({ ok: true, from: "recursos-humanos@multipark.pt", accountKey: "dwd:reservas@multipark.pt", gmailMessageId: "gm1", gmailThreadId: "gt1" });
    expect(sent[0].raw).toMatch(/X-Multipark-System: 1/i);
    expect(sent[0].raw).toMatch(/X-Multipark-Auto: availability_request/i);
    expect(sent[0].raw).toMatch(/Auto-Submitted: auto-generated/i);
    expect(recorded).toEqual([expect.objectContaining({ accountKey: "dwd:reservas@multipark.pt", gmailMessageId: "gm1", gmailThreadId: "gt1", kind: "availability_request", employeeId: 42, toEmail: "extra@gmail.com" })]);
  });
  it("email humano por alias continua sem marca; automático sem colaborador não é registado", async () => {
    clearSendAsCache();
    const { deps, sent, recorded } = fakeDeps();
    await sendMailWith(deps, { to: "c@x.pt", subject: "Olá", text: "x", from: "recursos-humanos@multipark.pt" });
    expect(sent[0].raw).not.toMatch(/X-Multipark-/i);
    await sendMailWith(deps, { to: "c@x.pt", subject: "Aviso", text: "x", auto: { kind: "notification" } });
    expect(sent[1].raw).toMatch(/X-Multipark-Auto: notification/i);
    expect(recorded).toHaveLength(0);
  });
  it("todos os caminhos automáticos marcam o envio", () => {
    const expectations: Array<[string, RegExp]> = [
      ["server/extrasAvailability.ts", /auto: \{ kind: opts\.autoKind \?\? "availability_request", employeeId: e\.id \}/],
      ["server/extrasAvailability.ts", /auto: \{ kind: "availability_test" \}/],
      ["server/extrasAutomation.ts", /"availability_reminder"\);/],
      ["server/extrasSchedule.ts", /kind: "schedule_notice", employeeId: empId/],
      ["server/extrasSchedule.ts", /kind: "schedule_cancel"/],
      ["server/trainingPaths.ts", /kind: "training_reminder"/],
      ["server/tasksService.ts", /kind: "task_notice"/],
      ["server/shiftHandoverAutomation.ts", /kind: "handover"/],
      ["server/notify.ts", /kind: "notification"/],
      ["server/_core/notification.ts", /kind: "owner_alert"/],
      ["server/marketingWeekly.ts", /kind: "report"/],
      ["server/aiOps/cron.ts", /kind: "report"/],
    ];
    for (const [file, re] of expectations) expect(readFileSync(resolve(root, file), "utf8"), file).toMatch(re);
  });
});

// ─── 4. Migração 0220 (limpeza dos antigos) ─────────────────────────────────

/** BD falsa: responde às consultas da migração pelo texto do SQL. */
function fakeDb(o: { done?: boolean; messages?: any[]; employees?: any[] }) {
  const log: string[] = [];
  const text = (q: any) => {
    const chunks: any[] = q?.queryChunks ?? [];
    return chunks.map((c) => (typeof c === "string" ? c : Array.isArray(c?.value) ? c.value.join("") : c?.queryChunks ? "(...)" : "?")).join("");
  };
  let served = false;
  const db = {
    async execute(q: any) {
      const t = text(q);
      log.push(t);
      if (t.includes("FROM app_notification_maintenance")) return [o.done ? [{ id: DATA_0220_ID }] : []];
      if (t.includes("FROM app_settings")) return [[]];
      if (t.includes("FROM mail_messages") && t.includes("SELECT id, threadId")) { const r = served ? [] : o.messages ?? []; served = true; return [r]; }
      if (t.includes("FROM employees")) return [o.employees ?? []];
      return [{ affectedRows: 1 }];
    },
  };
  return { db, log };
}

describe("migração 0220: limpa os pedidos de disponibilidade já sincronizados", () => {
  it("SQL idempotente: tabela mail_auto_sends com índices", () => {
    const all = MIGRATION_0220_STATEMENTS.join("\n");
    expect(all).toMatch(/CREATE TABLE IF NOT EXISTS `mail_auto_sends`/);
    expect(all).toMatch(/UNIQUE KEY `uq_mail_auto_sends_msg` \(`accountKey`, `gmailMessageId`\)/);
    expect(all).toMatch(/KEY `idx_mail_auto_sends_employee` \(`employeeId`, `sentAt`\)/);
    expect(IDEMPOTENT_ERROR_CODES_0220.has("ER_TABLE_EXISTS_ERROR")).toBe(true);
    const db = readFileSync(resolve(root, "server/db.ts"), "utf8");
    expect(db).toMatch(/migration_0220/);
    expect(db).toMatch(/runMigration0220Data/);
  });
  it("matcher do backfill: só os envios nossos (sem Re:, sem recebidas, sem humanos)", () => {
    const rows = [
      { id: 1, threadId: 10, direction: "out", fromEmail: "recursos-humanos@multipark.pt", subject: availabilitySubject },
      { id: 2, threadId: 11, direction: "out", fromEmail: "recursos-humanos@multipark.pt", subject: `Re: ${availabilitySubject}` },
      { id: 3, threadId: 12, direction: "in", fromEmail: "recursos-humanos@multipark.pt", subject: availabilitySubject },
      { id: 4, threadId: 13, direction: "out", fromEmail: "reservas@multipark.pt", subject: "[TESTE] Olá" },
      { id: 5, threadId: 14, direction: "out", fromEmail: "notificacoes@multipark.pt", subject: "Escala Multipark — 29/09" },
    ];
    expect(pickAutoOutbound0220(rows, ["recursos-humanos@multipark.pt", "reservas@multipark.pt"]).map((r) => [r.id, r.kind])).toEqual([[1, "availability_request"]]);
    expect(pickAutoOutbound0220(rows, ["notificacoes@multipark.pt"]).map((r) => r.id)).toEqual([5]);
    // O pré-filtro SQL cobre os assuntos de todas as automações.
    expect(AUTO_SUBJECT_LIKE_0220.some((p) => p.startsWith("Disponibilidade"))).toBe(true);
  });
  it("corre uma vez: marca as mensagens, recalcula as conversas, liga ao extra e grava a marca no fim", async () => {
    const { db, log } = fakeDb({
      messages: [
        { id: 1, threadId: 10, direction: "out", fromEmail: "recursos-humanos@multipark.pt", subject: availabilitySubject, accountKey: "dwd:reservas@multipark.pt", gmailMessageId: "g1", gmailThreadId: "t1", rfcMessageId: "<1@x>", toJson: JSON.stringify(["extra@gmail.com"]), sentAt: "2026-09-24 10:00:00" },
        { id: 2, threadId: 11, direction: "out", fromEmail: "reservas@multipark.pt", subject: "Escala Multipark — 29/09", accountKey: "dwd:reservas@multipark.pt", gmailMessageId: "g2", gmailThreadId: "t2", rfcMessageId: null, toJson: JSON.stringify(["outro@gmail.com"]), sentAt: null },
      ],
      employees: [{ id: 42, email: "extra@gmail.com" }],
    });
    const r = await runMigration0220Data(db);
    expect(r).toEqual({ status: "applied", messages: 2, threads: 2, sends: 1 });
    expect(log.some((t) => t.startsWith("UPDATE mail_messages SET automated ="))).toBe(true);
    expect(log.some((t) => t.includes("UPDATE mail_threads t SET t.automated"))).toBe(true);
    expect(log.filter((t) => t.includes("INSERT IGNORE INTO mail_auto_sends"))).toHaveLength(1);
    expect(log[log.length - 1]).toMatch(/INSERT INTO app_notification_maintenance/);
  });
  it("já corrida → não faz nada", async () => {
    const { db, log } = fakeDb({ done: true });
    expect(await runMigration0220Data(db)).toEqual({ status: "skipped", messages: 0, threads: 0, sends: 0 });
    expect(log).toHaveLength(1);
  });
});
