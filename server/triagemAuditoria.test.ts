/**
 * Auditoria da triagem dos emails (14 out 2026, ronda 1). Cada teste prende
 * um problema que a auditoria encontrou e corrigiu:
 *  - o corpus de CONTROLO (independente) e a avaliação que só conta "foi para
 *    lá" quando o caso abre de facto;
 *  - o pedido EXATO à IA tem uma só fonte (dados pessoais tapados);
 *  - um cliente cujo email chega por um Grupo Google NOSSO não é "newsletter";
 *  - uma crítica do Google reencaminhada por um colega não abre reclamação;
 *  - o sistema só marca como lido em caixas partilhadas;
 *  - o caso "Por confirmar" que uma pessoa arquivou não volta pela resposta;
 *  - as ligações fracas não fazem saltar uma reclamação nova;
 *  - o varrimento repete o que falhou, sem mexer nas caixas de tema;
 *  - o "Testar a triagem" tem teto de custo.
 * A IA é simulada (sem chave). Nada se apaga.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: null as any, modify: vi.fn(async () => {}) }));
vi.mock("./db", async (orig) => ({
  ...(await orig<object>()), getDb: async () => h.db, logActivity: async () => {},
  getUserPermissionOverrides: async () => ({}), getUserModuleOverrides: async () => ({}),
}));
vi.mock("./mail/gmailApi", async (orig) => ({ ...(await orig<object>()), gmailApiForAccount: async () => ({ modifyLabels: h.modify }) }));

import {
  ALL_TRIAGE_FEATURES, MAIL_TRIAGE_CATEGORIES, bulkListMail, forwardedExternalSender, parseTriageCategory, preTriageMail, type PreTriageFacts,
} from "../shared/mailTriage";
import { aiMergeConflict, caseIntakeDecision, COMPLAINT_INTAKE_DEFAULTS, LOST_FOUND_AI_MERGE_DAYS, lostFoundMergeRecent, type IntakeFacts } from "../shared/complaintIntake";
import { isAutomatedSender, isCompanyAddress } from "../shared/mail";
import { MAIL_ROUTING_SYSTEM, mailRoutingSchema } from "./_core/ai/prompts/comms";
import { toProviderJsonSchema } from "./_core/ai/jsonSchema";
import {
  STRONG_CASE_LINK_MIN_CONFIDENCE, classifyAndApply, mailRoutingRequest, runMailBackfill, runPendingEmailRoutings,
  type EmailRoutingDeps, type EmailRoutingMessage, type StoredTriageMessage,
} from "./commsRouting";
import { TRIAGE_CORPUS } from "./fixtures/mailTriageCorpus";
import { TRIAGE_HOLDOUT } from "./fixtures/mailTriageHoldout";
import { MAIL_TRIAGE_EVAL_LIMITS, TRIAGE_CORPORA, corpusFacts, evalCorpusItem, evalTriageSlice, triageEvalReport } from "./mailTriageEval";
import { caseRejectedByHuman, intakeOfThread } from "./complaintMailIntake";
import { systemMayMarkRead } from "./mail/store";
import { checkRateLimit, resetRateLimitMemoryForTests } from "./_core/ai/rateLimit";
import { createFakeDb } from "./_core/ai/testUtils";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const company = (a: string) => isCompanyAddress(a);
const T = { minConfidence: 0.7, createMinConfidence: 0.85, suggestMinConfidence: 0.5 };

// ─── Corpus de controlo ──────────────────────────────────────────────────────

describe("corpus de controlo (independente, escrito antes de ler o principal)", () => {
  it("≥ 50 emails difíceis, PT-PT/EN/ES/FR, ids próprios, rótulos válidos, reclamações e perdidos suficientes", () => {
    expect(TRIAGE_HOLDOUT.length).toBeGreaterThanOrEqual(50);
    expect(new Set(TRIAGE_HOLDOUT.map((c) => c.lang))).toEqual(new Set(["pt", "en", "es", "fr"]));
    expect(new Set(TRIAGE_HOLDOUT.map((c) => c.id)).size).toBe(TRIAGE_HOLDOUT.length);
    for (const c of TRIAGE_HOLDOUT) {
      expect(c.id, c.id).toMatch(/^h-/);
      expect(parseTriageCategory(c.expected), c.id).toBe(c.expected);
      expect(TRIAGE_CORPUS.some((x) => x.id === c.id), c.id).toBe(false);
    }
    const n = (k: string) => TRIAGE_HOLDOUT.filter((c) => c.expected === k).length;
    expect(n("reclamacoes")).toBeGreaterThanOrEqual(20);
    expect(n("perdidos")).toBeGreaterThanOrEqual(10);
    // o que soa a reclamação e não é: há de cada (precisão)
    for (const k of ["alteracoes", "criticas", "faturacao", "reservas", "rh", "ocorrencias", "ruido"]) expect(n(k), k).toBeGreaterThan(0);
    // os difíceis que o Jorge pediu
    for (const id of ["h-rec-02", "h-rec-03", "h-rec-04", "h-rec-05", "h-rec-06", "h-rec-07", "h-rec-12", "h-per-01", "h-per-02", "h-alt-01", "h-cri-01", "h-cri-02", "h-rh-01"]) {
      expect(TRIAGE_HOLDOUT.some((c) => c.id === id), id).toBe(true);
    }
    expect(TRIAGE_CORPORA).toMatchObject({ principal: TRIAGE_CORPUS, controlo: TRIAGE_HOLDOUT });
  });
  it("com a IA simulada a acertar tudo, os dois corpora passam (os factos de produção não estragam nenhum rótulo)", async () => {
    for (const [key, corpus] of Object.entries(TRIAGE_CORPORA)) {
      const perfect = async (m: EmailRoutingMessage) => {
        const item = corpus.find((c) => c.subject === m.subject && c.body === m.text)!;
        const k = item.expected;
        return { output: { box: k, confidence: 0.95, reason: "ok", complaint: k === "reclamacoes" ? 0.95 : 0, lostItem: k === "perdidos" ? 0.95 : 0 }, restore: (s: string) => s } as any;
      };
      const rows = [];
      for (let off = 0; off < corpus.length; off += 12) rows.push(...(await evalTriageSlice({ offset: off, limit: 12, corpus: key as any }, { classify: perfect, thresholds: T })).items);
      const m = triageEvalReport({ rows, corpus: key as any }, undefined, () => {});
      expect(m, key).toMatchObject({ passes: true, recallComplaints: 1, recallLostFound: 1, missing: 0 });
      expect(m.correct, key).toBe(corpus.length);
    }
  });
});

// ─── A avaliação conta o que acontece de facto ──────────────────────────────

describe("avaliação: 'foi para lá' só quando o caso abre", () => {
  const byId = (id: string) => [...TRIAGE_CORPUS, ...TRIAGE_HOLDOUT].find((c) => c.id === id)!;
  const answer = (out: any) => async () => ({ output: out, restore: (s: string) => s }) as any;
  it("um colega (sem reencaminhar um cliente) a falar de uma queixa NÃO conta como reclamação aberta", async () => {
    const r = await evalCorpusItem(byId("h-rh-03"), answer({ box: "reclamacoes", confidence: 0.9, reason: "x", complaint: 0.9 }), T);
    expect(r).toMatchObject({ predicted: "geral", caseKind: null });
  });
  it("a reclamação reencaminhada pelo backoffice abre o caso; a certeza média fica 'Por confirmar'", async () => {
    expect(await evalCorpusItem(byId("h-rec-12"), answer({ box: "reclamacoes", confidence: 0.9, reason: "x", complaint: 0.9 }), T))
      .toMatchObject({ predicted: "reclamacoes", caseKind: "complaint", uncertain: false });
    expect(await evalCorpusItem(byId("h-rec-04"), answer({ box: "alteracoes", confidence: 0.7, reason: "x", complaint: 0.75 }), T))
      .toMatchObject({ predicted: "reclamacoes", caseKind: "complaint", uncertain: true });
  });
  it("crítica do Google reencaminhada por um colega: mesmo que a IA veja queixa, não abre reclamação (fica Críticas)", async () => {
    const item = byId("h-cri-02");
    expect(corpusFacts(item).msg.forwardedExternal).toBe(false);
    expect(await evalCorpusItem(item, answer({ box: "criticas", confidence: 0.9, reason: "x", complaint: 0.65 }), T)).toMatchObject({ predicted: "criticas", caseKind: null });
  });
  it("o script tem o substituto offline (pedido exato → respostas gravadas → decisão de produção)", () => {
    const s = src("scripts/eval-mail-triage.ts");
    expect(s).toContain("--dump");
    expect(s).toContain("--answers");
    expect(s).toContain("mailRoutingRequest(f.msg, f.fromLabel)");
    expect(s).toContain("evalCorpusItem(item");
  });
});

// ─── O pedido exato à IA ─────────────────────────────────────────────────────

describe("o pedido à IA: uma só fonte, dados pessoais tapados", () => {
  it("sistema + utilizador; email, telefone, NIF e matrícula tapados; só o 1.º nome; citado à parte", async () => {
    const r = await mailRoutingRequest({
      subject: "Carro 45-XZ-12", fromName: "Isabel Maria Correia", senderKind: "external", attachmentNames: ["foto.jpg"],
      text: "Liguem-me para o 912 345 678 ou isabel.correia@gmail.com. NIF 234567890.\n\nEm seg., 6/10/2026, Multipark <info@multipark.pt> escreveu:\n> O seu caso foi encaminhado.",
    }, "Info (geral)");
    expect(r.system).toBe(MAIL_ROUTING_SYSTEM);
    expect(r.input).not.toMatch(/912 345 678|isabel\.correia@gmail\.com|234567890|45-XZ-12|Correia/);
    expect(r.input).toContain("Remetente: Isabel (de fora da empresa)");
    expect(r.input).toContain("Texto citado ou reencaminhado (contexto)");
    expect(r.restore(r.input)).toContain("912 345 678");
    // a leitura real usa ESTA função (o que se mede é o que vai para produção)
    expect(src("server/commsRouting.ts")).toMatch(/const req = await mailRoutingRequest\(msg, fromLabel\);/);
  });
  it("as certezas de caso vêm primeiro e são obrigatórias para o fornecedor (não as pode omitir); resposta sem elas vale 0", () => {
    const js = toProviderJsonSchema(mailRoutingSchema) as any;
    expect(Object.keys(js.properties).slice(0, 2)).toEqual(["complaint", "lostItem"]);
    expect(js.required).toEqual(expect.arrayContaining(["complaint", "lostItem", "box", "confidence", "reason"]));
    expect(mailRoutingSchema.parse({ box: "reservas", confidence: 0.9, reason: "x" })).toMatchObject({ complaint: 0, lostItem: 0 });
    // e o pedido pergunta-as ANTES da categoria, independentes dela
    expect(MAIL_ROUTING_SYSTEM.indexOf("complaint: 0 a 1")).toBeLessThan(MAIL_ROUTING_SYSTEM.indexOf("box: a chave"));
    expect(MAIL_ROUTING_SYSTEM).toContain("responde-as sempre, mesmo que a categoria seja outra");
  });
  it("as avaliações publicadas (mesmo reencaminhadas) não contam como queixa — pelo sentido, no pedido", () => {
    expect(MAIL_ROUTING_SYSTEM).toContain("Um aviso de uma avaliação publicada num site de avaliações (mesmo reencaminhado por um colega) também é 0");
  });
});

// ─── Grupo Google nosso: não é newsletter ───────────────────────────────────

describe("um cliente que escreve para um Grupo Google da empresa não é 'envio em massa'", () => {
  const own = ["multipark.pt", "skypark.pt"];
  const groupHeaders = { listId: "<info.multipark.pt>", listUnsubscribe: "<mailto:googlegroups-manage+1+unsubscribe@googlegroups.com>", precedence: "list" };
  it("a sincronização já o dá como pessoa; o caso deixa de o deitar fora como newsletter", () => {
    const automated = isAutomatedSender("ana@gmail.com", groupHeaders, { ownListDomains: own }) ? 1 : 0;
    expect(automated).toBe(0);
    expect(bulkListMail({ automated, ...groupHeaders })).toBe(false);
    const facts: IntakeFacts = {
      fromBoxKey: "info", fromBoxPipeline: null, outbound: false, automated: false, systemMail: false, personal: false, senderIsCompany: false,
      senderIsAutomated: false, senderIsPartner: false, subject: "Carro riscado", text: "O carro veio riscado.", senderEmail: "ana@gmail.com",
      listMail: bulkListMail({ automated, ...groupHeaders }),
    };
    expect(caseIntakeDecision("complaint", 0.9, facts, COMPLAINT_INTAKE_DEFAULTS)).toEqual({ action: "create" });
  });
  it("uma newsletter de fora continua a ser envio em massa (não abre caso)", () => {
    const headers = { listId: "<news.loja.pt>", listUnsubscribe: "<https://loja.pt/unsub>" };
    const automated = isAutomatedSender("news@loja.pt", headers, { ownListDomains: own }) ? 1 : 0;
    expect(bulkListMail({ automated, ...headers })).toBe(true);
    expect(bulkListMail({ automated: 0, listId: null, listUnsubscribe: null })).toBe(false);
  });
  it("a sincronização usa a regra (e não o cabeçalho cru)", () => {
    expect(src("server/mail/service.ts")).toContain("listMail: bulkListMail({ automated: ctx.automated, listUnsubscribe: p.listUnsubscribe, listId: p.listId })");
    expect(src("server/mail/service.ts")).not.toContain("listMail: !!(p.listUnsubscribe || p.listId)");
  });
});

// ─── Reencaminhamentos ──────────────────────────────────────────────────────

describe("reencaminhamento de um aviso de avaliação não é um cliente", () => {
  it("Google/Trustpilot reencaminhados → não há cliente de fora; um cliente reencaminhado continua a contar", () => {
    const google = "Para verem.\n---------- Forwarded message ---------\nFrom: Google Business Profile <businessprofile-noreply@google.com>\nAna deixou 2 estrelas.";
    const trust = "FYI\nFrom: Trustpilot <reviews@trustpilot.com>\nNew 1-star review";
    expect(forwardedExternalSender(google, company)).toBeNull();
    expect(forwardedExternalSender(trust, company)).toBeNull();
    expect(forwardedExternalSender("Ver.\nDe: Rui <rui.matos@gmail.com>\nO carro veio riscado.", company)).toBe("rui.matos@gmail.com");
  });
});

// ─── Lido: só caixas partilhadas ─────────────────────────────────────────────

describe("o sistema só marca como lido emails recebidos de caixas partilhadas", () => {
  it("regra", () => {
    const ok = { direction: "in", mailboxKey: "criticas", ownerUserId: null, accountKey: "dwd:criticas@multipark.pt" };
    expect(systemMayMarkRead(ok)).toBe(true);
    expect(systemMayMarkRead({ ...ok, direction: "out" })).toBe(false);
    expect(systemMayMarkRead({ ...ok, mailboxKey: null, ownerUserId: 7 })).toBe(false);
    expect(systemMayMarkRead({ ...ok, ownerUserId: 7 })).toBe(false);
    expect(systemMayMarkRead({ ...ok, accountKey: "user:7" })).toBe(false);
  });
  it("email pessoal: não mexe no dashboard nem no Gmail", async () => {
    h.modify.mockClear();
    h.db = createFakeDb((q) => (q.sql.startsWith("SELECT m.threadId, m.accountKey")
      ? [[{ threadId: 1, accountKey: "user:7", gmailMessageId: "g9", isRead: 0, direction: "in", mailboxKey: null, ownerUserId: 7 }]]
      : [{ affectedRows: 1 }]));
    const { markMessageReadBySystem } = await import("./mail/store");
    expect(await markMessageReadBySystem(5)).toBe(false);
    expect(h.db.queries.map((q: any) => q.sql).join("\n")).not.toContain("UPDATE mail_messages SET isRead");
    expect(h.modify).not.toHaveBeenCalled();
  });
});

// ─── Junção: o mesmo cliente com outro caso ─────────────────────────────────

describe("junção: o mesmo cliente com duas reservas tem dois casos", () => {
  it("reserva ou matrícula diferentes → outro caso; a mesma (com ou sem prefixo) → junta; sem sinal → junta", () => {
    expect(aiMergeConflict({ ref: "MP-48213" }, { ref: "51003" })).toBe(true);
    expect(aiMergeConflict({ ref: "MP-48213" }, { ref: "48213" })).toBe(false);
    expect(aiMergeConflict({ plate: "45-XZ-12" }, { plate: "AA-11-BB" })).toBe(true);
    expect(aiMergeConflict({ plate: "45-XZ-12" }, { plate: "45XZ12" })).toBe(false);
    expect(aiMergeConflict({ ref: "MP-48213", plate: null }, { ref: null, plate: "45-XZ-12" })).toBe(false);
    expect(aiMergeConflict({}, {})).toBe(false);
  });
  it("perdidos: só junta a um perdido aberto recente (a mesma viagem)", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    expect(LOST_FOUND_AI_MERGE_DAYS).toBe(14);
    expect(lostFoundMergeRecent("2026-10-10 09:00:00", now)).toBe(true);
    expect(lostFoundMergeRecent("2026-06-01 09:00:00", now)).toBe(false);
    expect(lostFoundMergeRecent(new Date("2026-10-13T09:00:00Z"), now)).toBe(true);
    expect(lostFoundMergeRecent(null, now)).toBe(false);
  });
  it("o pipeline usa as duas guardas na junção da IA", () => {
    const s = src("server/jobs/emailInboundSync.ts");
    expect(s).toContain("(clientEmail ? noConflict(await findComplaintByClientSignals(clientEmail, null, null)) : null)");
    expect(s).toContain("(clientEmail ? recentLf(await findOpenLostFoundByClient(clientEmail, null)) : null)");
  });
});

// ─── O humano manda ─────────────────────────────────────────────────────────

describe("o caso 'Por confirmar' que uma pessoa arquivou não volta pela resposta do cliente", () => {
  it("regra", () => {
    expect(caseRejectedByHuman({ archivedAt: "2026-10-14 10:00:00", aiUnconfirmed: 1 })).toBe(true);
    expect(caseRejectedByHuman({ archivedAt: "2026-10-14 10:00:00", aiUnconfirmed: 0 })).toBe(false);
    expect(caseRejectedByHuman({ archivedAt: null, aiUnconfirmed: 1 })).toBe(false);
  });
  it("a conversa deixa de levar as respostas para esse caso (nem o reabre)", async () => {
    h.db = createFakeDb(() => [[{ complaintId: 5, lostFoundId: null, caseKind: "complaint", status: "created", cArchivedAt: "2026-10-14 10:00:00", cUnconfirmed: 1 }]]);
    expect(await intakeOfThread(1)).toEqual({ kind: "complaint", complaintId: null, lostFoundId: null, rejected: true });
    h.db = createFakeDb(() => [[{ complaintId: 5, lostFoundId: null, caseKind: "complaint", status: "created", cArchivedAt: null, cUnconfirmed: 1 }]]);
    expect(await intakeOfThread(1)).toEqual({ kind: "complaint", complaintId: 5, lostFoundId: null });
    h.db = createFakeDb(() => [[{ complaintId: null, lostFoundId: 8, caseKind: "lost_found", status: "linked", lArchivedAt: "2026-10-14 10:00:00", lUnconfirmed: 1 }]]);
    expect(await intakeOfThread(1)).toMatchObject({ lostFoundId: null, rejected: true });
    // uma pessoa tirou a ligação da conversa ao caso → também é dela
    h.db = createFakeDb(() => [[{ complaintId: 5, lostFoundId: null, caseKind: "complaint", status: "created", cArchivedAt: null, cUnconfirmed: 0, unlinked: 1 }]]);
    expect(await intakeOfThread(1)).toMatchObject({ complaintId: null, rejected: true });
    expect(h.db.queries[0].sql).toContain("ml.removedAt IS NOT NULL");
  });
});

// ─── Ligações fracas não escondem uma reclamação nova ────────────────────────

describe("ligações fracas ('aberta do mesmo cliente') não fazem saltar uma reclamação nova", () => {
  it("nova tentativa e varrimento só contam ligações fortes (à mão, pipeline/IA, mesma conversa)", async () => {
    expect(STRONG_CASE_LINK_MIN_CONFIDENCE).toBe(95);
    h.db = createFakeDb(() => [[]]);
    const { loadStoredTriageMessage } = await import("./commsRouting");
    await loadStoredTriageMessage(1);
    const q = h.db.queries[0].sql as string;
    expect(q).toContain("l.removedAt IS NULL AND (l.source = 'manual' OR l.confidence >= ?)");
  });
  it("na sincronização, uma conversa ligada à mão é da pessoa (sem 2.º caso numa resposta)", () => {
    const s = src("server/mail/service.ts");
    expect(s).toContain("AND l.removedAt IS NULL AND l.source = 'manual') AS hasCase");
  });
});

// ─── Varrimento: repete o que falhou, sem baralhar caixas ────────────────────

const PRE: PreTriageFacts = {
  outbound: false, personal: false, systemMail: false, automated: 0, mailboxKey: "info", pipeline: null, fromEmail: "ana@gmail.com", text: "Olá",
  senderIsCompany: false, createdCase: false, threadHasCase: false, humanTouched: false,
};
const MSG: EmailRoutingMessage = {
  threadId: 10, messageId: 100, fromBoxKey: "info", subject: "Carro", text: "O carro veio riscado.", fromName: "Ana", fromEmail: "ana@gmail.com",
  attachmentNames: [], projectId: null, newThread: true, senderKind: "external", mode: "sweep",
};
function deps(o: Partial<EmailRoutingDeps> & { fail?: boolean } = {}) {
  const calls = { record: [] as any[], classify: 0, move: [] as any[] };
  const d: EmailRoutingDeps = {
    enabled: async () => true,
    settings: async () => ({ minConfidence: 0.7, perRun: 10 }),
    caseSettings: async () => ({ createMinConfidence: 0.85, suggestMinConfidence: 0.5 }),
    features: async () => ({ ...ALL_TRIAGE_FEATURES }),
    boxes: async () => ["info", "reclamacoes", "reservas"].map((k) => ({ key: k, label: k, active: true })),
    claim: async () => true,
    classify: async () => {
      calls.classify++;
      if (o.fail) throw Object.assign(new Error("timeout"), { code: "timeout" });
      return { output: { box: "reservas", confidence: 0.9, reason: "x" }, restore: (s: string) => s };
    },
    move: async (t, b) => { calls.move.push([t, b]); return true; },
    record: async (_m, p) => { calls.record.push(p); },
    firstContact: async () => ({ outcome: "created", leadId: 1, applicationId: null }) as any,
    cityProjectId: async () => null,
    afterRh: async () => {},
    ...o,
  };
  return { d, calls };
}

describe("varrimento: a falha da IA repete-se e a linha antiga fica", () => {
  it("falhou no varrimento → só o erro e a tentativa (a linha 'Movido pela IA' antiga não se perde)", async () => {
    const { d, calls } = deps({ fail: true });
    expect(await classifyAndApply(MSG, d)).toMatchObject({ status: "failed" });
    expect(calls.record[0]).toMatchObject({ status: "failed", error: "timeout", onlyTriage: true });
    const sync = deps({ fail: true });
    await classifyAndApply({ ...MSG, mode: "sync" }, sync.d);
    expect(sync.calls.record[0]).toMatchObject({ status: "failed", onlyTriage: false });
  });
  it("o varrimento volta a pegar no que falhou (até 3 tentativas); não rouba as da nova tentativa da sincronização", async () => {
    h.db = createFakeDb(() => [[]]);
    await runMailBackfill({ deadlineAt: Date.now() + 60_000 }, { ...deps().d, backfillEnabled: async () => true });
    const q = (h.db.queries as any[]).find((x) => x.sql.startsWith("SELECT m.id, m.threadId")).sql as string;
    expect(q).toContain("r.sweptAt IS NULL AND r.status = 'failed' AND r.attempts < ? AND r.createdAt >= ?");
    expect(q).toContain("r.category IS NULL AND r.error IS NOT NULL AND r.attempts > 0 AND r.attempts < ?");
  });
  it("IA desligada: o que precisa dela fica por reservar (volta quando a IA voltar)", async () => {
    h.db = createFakeDb((q) => (q.sql.startsWith("SELECT m.id, m.threadId") ? [[{ id: 1, threadId: 1 }]] : [{ affectedRows: 1 }]));
    const load = async (): Promise<StoredTriageMessage> => ({ pre: PRE, msg: MSG });
    const r = await runMailBackfill({ deadlineAt: Date.now() + 60_000 }, { ...deps({ enabled: async () => false }).d, load, backfillEnabled: async () => true });
    expect(r).toMatchObject({ read: 0, ai: 0 });
    expect(h.db.queries.map((x: any) => x.sql).join("\n")).not.toMatch(/INSERT IGNORE INTO comms_ai_routing|UPDATE comms_ai_routing/);
    expect(preTriageMail(PRE).action).toBe("ai");
  });
  it("a nova tentativa de uma linha do varrimento corre em modo varrimento (nunca muda a caixa de tema de um email antigo)", async () => {
    h.db = createFakeDb((q) => (q.sql.startsWith("SELECT messageId, sweptAt") ? [[{ messageId: 100, sweptAt: "2026-10-14 08:00:00" }]] : [[]]));
    const seen: string[] = [];
    const load = async (_id: number, mode?: "sync" | "sweep") => { seen.push(mode ?? "sync"); return { pre: PRE, msg: { ...MSG, mode: mode ?? "sync" } }; };
    const { d, calls } = deps();
    await runPendingEmailRoutings({ deadlineAt: Date.now() + 60_000 }, { ...d, load } as any);
    expect(seen).toEqual(["sweep"]);
    expect(calls.move).toEqual([]);
  });
});

// ─── Testar a triagem: teto de custo ─────────────────────────────────────────

describe("'Testar a triagem' tem teto de custo (por hora e por dia)", () => {
  it("o servidor conta os lotes antes de chamar a IA", async () => {
    expect(MAIL_TRIAGE_EVAL_LIMITS).toEqual({ perHour: 40, perDay: 110 });
    const s = src("server/settingsRouter.ts");
    const body = s.slice(s.indexOf("mailTriageEval: protectedProcedure"), s.indexOf("mailTriageEvalReport"));
    expect(body.indexOf("requireSuperAdmin")).toBeLessThan(body.indexOf("checkRateLimit"));
    expect(body.indexOf("checkRateLimit")).toBeLessThan(body.indexOf("evalTriageSlice"));
    expect(body).toContain("TOO_MANY_REQUESTS");
    resetRateLimitMemoryForTests();
    h.db = null;
    const now = Date.parse("2026-10-14T10:05:00Z");
    for (let i = 0; i < MAIL_TRIAGE_EVAL_LIMITS.perHour; i++) expect((await checkRateLimit("triage-eval:user:1", MAIL_TRIAGE_EVAL_LIMITS, now)).allowed).toBe(true);
    expect((await checkRateLimit("triage-eval:user:1", MAIL_TRIAGE_EVAL_LIMITS, now)).allowed).toBe(false);
  });
  it("o ecrã corre os DOIS corpora e diz que há limite", () => {
    const card = src("client/src/components/mail/MailTriageEvalCard.tsx");
    expect(card).toContain('{ key: "controlo", label: "Corpus de controlo (independente)" }');
    expect(card).toContain("evalMut.mutateAsync({ offset, limit: BATCH, corpus: c.key })");
    expect(card).toContain("limite de vezes por hora");
  });
  it("todas as categorias da triagem continuam a existir", () => {
    expect(MAIL_TRIAGE_CATEGORIES.length).toBe(13);
  });
});

// ─── Caso criado à 2.ª tentativa: a conversa vai na mesma para a caixa do caso ─

describe("o caso que nasce na nova tentativa leva a conversa para a caixa do caso", () => {
  it("só a criação automática, só para uma caixa ativa, nunca uma conversa movida à mão", () => {
    const s = src("server/complaintMailIntake.ts");
    const retry = s.slice(s.indexOf("export async function retryFailedIntakes"), s.indexOf("async function moveToCaseBox"));
    expect(retry).toContain("if (row.decidedById == null) await moveToCaseBox(Number(row.threadId), kind)");
    const move = s.slice(s.indexOf("async function moveToCaseBox"));
    expect(move).toContain("b.key === box && b.active");
    expect(move).toContain('moveThreadToBox(threadId, box, "ai", { reroute: true })');
  });
});
