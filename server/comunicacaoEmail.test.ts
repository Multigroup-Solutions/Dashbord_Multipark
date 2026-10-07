/**
 * P3 lote 17d — Comunicação (email): o mesmo email nunca sai duas vezes; um
 * caso por email que falhou volta a ser tentado (e o cron diz que falhou);
 * fotos coladas no corpo veem-se; o nome sozinho não liga a uma reclamação;
 * erro ≠ vazio; conversa nova fica com cidade; linha do tempo e responsáveis
 * respeitam a cidade; caixas desativam-se (nada se apaga); horas de Lisboa.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sendMode: "ok" as "ok" | "timeout" | "reject",
  sendCalls: 0,
  reqs: new Map<string, any>(),
}));

vi.mock("./mail/store", () => ({
  db: async () => ({ execute: async () => [[{ email: "ana@multipark.pt" }]] }),
  rowsOf: (res: any) => (Array.isArray(res) ? res[0] : []),
  dbSyncStore: { storeMessage: async () => ({ stored: true, threadId: 77, messageId: 5, newThread: true, reopened: false }) },
  getMailbox: async () => null,
  linksForThreads: async () => [],
  listMailboxes: async () => [],
  nowUtc: () => "2026-10-02 10:00:00",
  recomputeThread: async () => {},
  addManualLink: async () => {},
  removeLink: async () => {},
  threadIdsForEntity: async () => [],
}));
vi.mock("./mail/sendRequests", async (original) => {
  const real = await original<typeof import("./mail/sendRequests")>();
  return {
    ...real,
    async claimSendRequest(id: string, userId: number) {
      const r = h.reqs.get(id);
      if (!r) { h.reqs.set(id, { userId, status: "sending", gmailMessageId: null, threadId: null }); return { go: true }; }
      const dec = real.decidePrior({ ...r, updatedAtMs: Date.now() }, userId, Date.now());
      if (dec.kind === "sent") return { go: false, outcome: { threadId: dec.threadId ?? 0, gmailMessageId: dec.gmailMessageId, duplicate: true } };
      if (dec.kind === "unknown") return { go: false, outcome: { threadId: dec.threadId ?? 0, gmailMessageId: null, uncertain: true } };
      if (dec.kind === "retry") { r.status = "sending"; return { go: true }; }
      throw new Error(dec.kind);
    },
    async finishSendRequest(id: string, patch: any) { Object.assign(h.reqs.get(id), patch); },
  };
});
vi.mock("./mail/gmailApi", () => ({
  gmailApiForAccount: async () => ({
    getProfile: async () => ({ emailAddress: "ana@multipark.pt", historyId: "1" }),
    listSendAs: async () => [{ sendAsEmail: "ana@multipark.pt", verificationStatus: "accepted", isPrimary: true, isDefault: true, displayName: "Ana" }],
    sendRaw: async () => {
      h.sendCalls++;
      if (h.sendMode === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      if (h.sendMode === "reject") throw Object.assign(new Error("Invalid To header"), { response: { status: 400 } });
      return { id: "gm-1", threadId: "t-1" };
    },
    // Enviado, mas a leitura de volta falha → nada pode partir o pedido.
    getMessage: async () => null,
  }),
}));
vi.mock("./db", () => ({ logActivity: async () => {}, getUserModuleOverrides: async () => ({}) }));

import { sendMail, newThreadProject, listedAttachment } from "./mail/inbox";
import { cleanRequestId, decidePrior, sendFailureIsDefinite } from "./mail/sendRequests";
import { uploadTicket, verifyUploadTicket } from "./uploadTicket";
import { sanitizeEmailHtml } from "./mail/sanitize";
import { proposeLinks, type AutoLinkDeps } from "./mail/autolink";
import { MIGRATION_0360_STATEMENTS } from "./migrations/migration_0360";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const viewer = { id: 7, role: "team_leader", accessOverrides: null };
const input = (over: any = {}) => ({ mode: "new" as const, mailbox: "me", to: ["cliente@gmail.com"], cc: [], bcc: [], subject: "Olá", body: "Texto", attachments: [], ...over });

beforeEach(() => { h.sendMode = "ok"; h.sendCalls = 0; h.reqs.clear(); });

describe("Envio sem duplicar", () => {
  it("o Gmail envia mas a gravação falha → sucesso com aviso; carregar outra vez NÃO envia outro", async () => {
    const r1 = await sendMail(viewer, input({ clientRequestId: "req-aaaa-0001" }));
    expect(r1).toMatchObject({ gmailMessageId: "gm-1" });
    expect(r1.warning).toMatch(/Ainda não aparece aqui/);
    const r2 = await sendMail(viewer, input({ clientRequestId: "req-aaaa-0001" }));
    expect(r2).toMatchObject({ duplicate: true, gmailMessageId: "gm-1" });
    expect(h.sendCalls).toBe(1);
  });
  it("sem resposta do Gmail (prazo) → 'sem confirmação'; a 2.ª tentativa com o mesmo código não reenvia", async () => {
    h.sendMode = "timeout";
    const r1 = await sendMail(viewer, input({ clientRequestId: "req-bbbb-0002" }));
    expect(r1).toMatchObject({ uncertain: true, gmailMessageId: null });
    h.sendMode = "ok";
    const r2 = await sendMail(viewer, input({ clientRequestId: "req-bbbb-0002" }));
    expect(r2.uncertain).toBe(true);
    expect(h.sendCalls).toBe(1);
  });
  it("o Gmail recusou (4xx) → erro e pode tentar outra vez com o mesmo código", async () => {
    h.sendMode = "reject";
    await expect(sendMail(viewer, input({ clientRequestId: "req-cccc-0003" }))).rejects.toThrow(/Invalid To/);
    expect(h.reqs.get("req-cccc-0003").status).toBe("failed");
    h.sendMode = "ok";
    const r = await sendMail(viewer, input({ clientRequestId: "req-cccc-0003" }));
    expect(r.gmailMessageId).toBe("gm-1");
    expect(h.sendCalls).toBe(2);
  });
  it("regras puras: código, decisão sobre o envio anterior, erro certo vs incerto", () => {
    expect(cleanRequestId("3f2c1a9e-1111-4222-8333-944455556666")).toBe("3f2c1a9e-1111-4222-8333-944455556666");
    expect(cleanRequestId("x")).toBeNull();
    expect(cleanRequestId("a b c d e f g h")).toBeNull();
    const base = { userId: 7, gmailMessageId: null, threadId: 3, updatedAtMs: 1_000 };
    expect(decidePrior({ ...base, status: "sending" }, 8, 2_000)).toEqual({ kind: "foreign" });
    expect(decidePrior({ ...base, status: "sending" }, 7, 2_000)).toEqual({ kind: "busy" });
    expect(decidePrior({ ...base, status: "sending" }, 7, 1_000 + 4 * 60_000)).toEqual({ kind: "stale" });
    expect(decidePrior({ ...base, status: "failed" }, 7, 2_000)).toEqual({ kind: "retry" });
    expect(sendFailureIsDefinite({ response: { status: 400 } })).toBe(true);
    expect(sendFailureIsDefinite({ code: "429" })).toBe(true);
    expect(sendFailureIsDefinite({ response: { status: 503 } })).toBe(false);
    expect(sendFailureIsDefinite({ code: "ECONNRESET" })).toBe(false);
    expect(sendFailureIsDefinite({ code: "ENOTFOUND" })).toBe(true);
    expect(sendFailureIsDefinite(new Error("timeout"))).toBe(false);
  });
  it("o editor manda um código por mensagem e trata 'sem confirmação' com escolha explícita", () => {
    const c = src("client/src/components/mail/MailComposer.tsx");
    expect(c).toContain("clientRequestId: id,");
    expect(c).toContain("if (r.uncertain) { setUncertain(true); return; }");
    expect(c).toContain("Confirmei que não saiu — enviar outra vez");
  });
});

describe("Anexos: só ficheiros que a pessoa carregou", () => {
  it("recibo do upload ligado a quem carregou e à key", () => {
    const t = uploadTicket(7, "uploads/1-abc.pdf");
    expect(verifyUploadTicket(7, "uploads/1-abc.pdf", t)).toBe(true);
    expect(verifyUploadTicket(8, "uploads/1-abc.pdf", t)).toBe(false);
    expect(verifyUploadTicket(7, "uploads/2-rh.pdf", t)).toBe(false);
    expect(verifyUploadTicket(7, "uploads/1-abc.pdf", null)).toBe(false);
  });
  it("sem recibo válido o envio recusa ANTES de falar com o Gmail", async () => {
    await expect(sendMail(viewer, input({ attachments: [{ key: "uploads/9-cv.pdf", filename: "cv.pdf", contentType: "application/pdf", ticket: "x".repeat(32) }] })))
      .rejects.toThrow(/inválido/);
    expect(h.sendCalls).toBe(0);
    expect(src("server/_core/api-entry.ts")).toContain("ticket: uploadTicket(uid, key)");
    expect(src("server/_core/index.ts")).toContain("ticket: uploadTicket(uid, key)");
  });
});

describe("Conversa nova: cidade", () => {
  it("herdada → alias → ligações, a primeira que quem envia vê; senão a cidade de quem envia", () => {
    expect(newThreadProject({ inherited: null, aliasCity: 2, linkProjects: [5], senderScope: undefined })).toBe(2);
    expect(newThreadProject({ inherited: null, aliasCity: null, linkProjects: [5], senderScope: undefined })).toBe(5);
    expect(newThreadProject({ inherited: null, aliasCity: 2, linkProjects: [5], senderScope: [5, 6] })).toBe(5);
    expect(newThreadProject({ inherited: null, aliasCity: null, linkProjects: [], senderScope: [6, 7] })).toBe(6);
    expect(newThreadProject({ inherited: 3, aliasCity: 2, linkProjects: [], senderScope: undefined })).toBe(3);
    expect(newThreadProject({ inherited: null, aliasCity: null, linkProjects: [], senderScope: undefined })).toBeNull();
  });
});

describe("Fotos coladas no corpo do email", () => {
  it("cid: por resolver conta como bloqueada (há botão) e as fotos entram na lista de anexos", () => {
    const r = sanitizeEmailHtml('<p>Danos:</p><img src="cid:foto1"><img src="cid:foto2">');
    expect(r.blockedImages).toBe(2);
    const shown = sanitizeEmailHtml('<img src="cid:foto1">', { showImages: true, cidMap: { foto1: "data:image/jpeg;base64,AAAA" } });
    expect(shown.blockedImages).toBe(0);
    expect(listedAttachment({ inline: true, contentId: "foto1", mimeType: "image/jpeg", size: 900_000 })).toBe(true);
    expect(listedAttachment({ inline: true, contentId: "logo", mimeType: "image/png", size: 4_000 })).toBe(false);
    expect(listedAttachment({ inline: false, contentId: null, mimeType: "application/pdf", size: 10 } as any)).toBe(true);
  });
});

describe("Ligação automática: o nome sozinho não liga", () => {
  const deps = (over: Partial<AutoLinkDeps> = {}): AutoLinkDeps => ({
    clientExists: async () => false, clientEmailByPhone: async () => null, matchBooking: async () => null,
    complaintByThread: async () => null, openComplaintBySignals: async () => null, openLostFoundBySignals: async () => null, ...over,
  });
  it("a reclamação aberta procura-se só por email/matrícula", async () => {
    const calls: unknown[][] = [];
    await proposeLinks({ contactEmail: "ana.nova@gmail.com", contactName: "Ana Costa", subject: "Olá", bodyText: "Nome: Ana Costa", gmThreadId: null, refs: [], sentAt: null },
      deps({ openComplaintBySignals: async (...a: unknown[]) => { calls.push(a); return null; } }) as AutoLinkDeps);
    expect(calls).toEqual([["ana.nova@gmail.com", null]]);
    expect(src("server/mail/service.ts")).toContain("findComplaintByClientSignals(email, plate, null)");
  });
  it("agrupar reclamações: com email, o nome só junta a uma reclamação sem email", () => {
    expect(src("server/db.ts")).toContain("(${complaints.clientName} = ${name} AND (${complaints.clientEmail} IS NULL OR TRIM(${complaints.clientEmail}) = ''))");
  });
});

describe("Caso por email que falhou: nova tentativa e cron honesto", () => {
  const svc = src("server/mail/service.ts");
  it("a falha marca a mensagem, põe o cron a vermelho e não trava o resto", () => {
    expect(svc).toContain("if (e.result.messageId) await markPipelineError(e.result.messageId, pipeline, err).catch(() => {});");
    expect(svc).toContain("report.ok = false;");
    expect(svc).toContain("pipelineStatus = 'error', pipelineAttempts = LEAST(pipelineAttempts + 1, 100)");
  });
  it("as corridas seguintes voltam a tentar (até 5) e o que já criou o caso liga-se em vez de duplicar", () => {
    expect(svc).toContain("WHERE pipelineStatus = 'error' AND pipelineAttempts < ${MAIL_PIPELINE_MAX_ATTEMPTS}");
    expect(svc).toContain("export const MAIL_PIPELINE_MAX_ATTEMPTS = 5;");
    expect(svc).toContain("return { targetModule: String(row.targetModule), targetId: Number(row.targetId), existing: true };");
    expect(svc.indexOf("await retryFailedPipelines(report")).toBeLessThan(svc.indexOf("triagePendingComplaints"));
  });
  it("Definições mostram os que falharam, com Tentar de novo; 'Sincronizado' só quando correu bem", () => {
    const st = src("client/src/components/mail/MailboxesSettings.tsx");
    expect(st).toContain("Emails que não criaram o caso");
    expect(st).toContain("retryCase.mutate({ messageId: f.messageId })");
    expect(st).toContain("Sincronização com problemas");
    const page = src("client/src/pages/ComunicacaoPage.tsx");
    expect(page).toContain('else if (acc.status !== "ok") toast.error(`Não foi possível ler o teu Gmail');
  });
});

describe("Cidade: linha do tempo, contactos e responsáveis", () => {
  const inbox = src("server/mail/inbox.ts");
  it("abrir na linha do tempo = ver a caixa E a cidade; sugestões com a mesma regra", () => {
    expect(inbox).toContain("canOpen: !!m && canSeeMailbox(viewer, m) && threadCityVisible(viewer, m, t.projectId)");
    expect(inbox).toContain("const scope = await visibleThreadsCondition(viewer);");
  });
  it("responsável = quem responde na caixa (com permissões individuais) e vê a cidade da conversa", () => {
    expect(inbox).toContain('if (!(await targetSeesThreadCity(target, acc.mailbox, acc.thread))) throw bad("Essa pessoa não vê a cidade desta conversa.");');
    expect(inbox).toContain(".filter((v) => canActOnMailbox(v, m));");
    expect(src("client/src/components/mail/MailThreadView.tsx")).toContain('{ mailbox: t?.mailbox?.key ?? "", threadId }');
  });
});

describe("Nada se apaga: desativar caixa", () => {
  it("sem DELETE de caixas; 'Desativar' no lugar de 'Apagar'", () => {
    expect(src("server/mail/store.ts")).not.toContain("DELETE FROM mail_mailboxes");
    expect(src("server/mail/router.ts")).toContain("deactivate: protectedProcedure");
    expect(src("server/mail/router.ts")).not.toContain("remove: protectedProcedure");
    expect(src("client/src/components/mail/MailboxesSettings.tsx")).toContain("deactivate.mutate({ key: m.key })");
  });
});

describe("Erro ≠ vazio e horas de Lisboa", () => {
  it("caixas, lista, conversa, comunicações e triagem mostram o erro; o menu mostra '?'", () => {
    const page = src("client/src/pages/ComunicacaoPage.tsx");
    expect(page).toContain('what="as caixas de email"');
    expect(page).toContain("enabled && !list.isLoading && !list.error && threads.length === 0"); // lote 45: só email
    expect(src("client/src/components/mail/MailThreadView.tsx")).toContain('what="a conversa"');
    expect(src("client/src/components/mail/CommunicationsTimeline.tsx")).toContain('what="as comunicações"');
    expect(src("client/src/components/mail/TriagePanel.tsx")).toContain('what="as caixas para classificar"');
    expect(src("client/src/components/DashboardLayout.tsx")).toContain("Não foi possível contar os emails por ler");
    expect(src("server/mail/router.ts")).not.toContain("catch { return { shared: 0, personal: 0 }; }");
  });
  it("datas da lista, conversa e linha do tempo em Lisboa", () => {
    const ui = src("client/src/components/mail/mailUi.tsx");
    expect(ui.match(/timeZone: "Europe\/Lisbon"/g)?.length).toBe(3);
    expect(ui).toContain("lisbonDayOf(d) === lisbonDayOf(now)");
  });
});

describe("Retenção: arquivar, nunca apagar (só o super admin vê, a pedido)", () => {
  it("sem DELETE na retenção; arquiva mensagens e conversas", () => {
    const store = src("server/mail/store.ts");
    expect(store).not.toMatch(/DELETE FROM mail_(messages|threads|links)/);
    expect(store).toContain("UPDATE mail_messages SET archivedAt = ${nowUtc()} WHERE archivedAt IS NULL");
    expect(store).toContain("UPDATE mail_threads SET archivedAt = NULL WHERE id = ${threadId} AND archivedAt IS NOT NULL");
  });
  it("arquivadas fora de listas, contagens, pesquisas, linha do tempo e CRM; o super admin pede o Arquivo", () => {
    const inbox = src("server/mail/inbox.ts");
    expect(inbox).toContain('if (thread.archivedAt && viewer.role !== "super_admin") throw forbidden(');
    expect(inbox).toContain('if (input.archived && viewer.role !== "super_admin") throw forbidden("Só o super admin consulta o arquivo.");');
    expect(inbox).toContain("conds.push(input.archived ? sql`t.archivedAt IS NOT NULL` : sql`t.archivedAt IS NULL`);");
    expect(inbox).toContain('if (viewer.role === "super_admin") return sql`((t.mailboxKey IS NOT NULL OR t.ownerUserId IS NULL OR t.ownerUserId = ${viewer.id}) AND t.archivedAt IS NULL)`;');
    expect(inbox).toContain("AND archivedAt IS NULL ORDER BY sentAt DESC LIMIT 200");
    expect(src("server/globalSearch.ts")).toContain("AND t.archivedAt IS NULL`;");
    expect(src("server/contactsSearch.ts")).toContain("AND t.archivedAt IS NULL`;");
    expect(src("server/crm/review.ts")).toContain("m.archivedAt IS NULL AND ${visible}");
    expect(src("client/src/pages/ComunicacaoPage.tsx")).toContain("Arquivo (+5 anos)");
    expect(src("client/src/components/mail/MailThreadView.tsx")).toContain("Mostrar arquivadas ({t.archivedHidden})");
  });
});

describe("Migração 0360", () => {
  it("registada depois da 0355; tabela nova e colunas, sem DELETE nem DROP", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0360")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0355"));
    const all = MIGRATION_0360_STATEMENTS.join("\n");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS `mail_send_requests`");
    expect(all).toContain("UNIQUE KEY `uq_mail_send_requests_request` (`requestId`)");
    expect(all).toContain("`pipelineAttempts`");
    expect(all).toContain("ALTER TABLE `mail_messages` ADD COLUMN `archivedAt` DATETIME NULL");
    expect(all).toContain("ALTER TABLE `mail_threads` ADD COLUMN `archivedAt` DATETIME NULL");
    expect(all).not.toMatch(/\bDELETE\b|\bDROP\b/);
  });
});
