/**
 * Triagem dos emails pela IA (Jorge, 14 out 2026): "tudo o que está na caixa
 * de correio e é uma reclamação tem de ir para as Reclamações; os perdidos e
 * achados também. As críticas ficam quietas (caixa das críticas, lidas). Uma
 * ocorrência fica lida e vai para as Ocorrências. Não por palavra-chave: tem
 * de perceber." Meta: > 90 % das reclamações e dos perdidos.
 *
 * A IA é SIMULADA em todos estes testes (sem chave): aqui prova-se tudo o que
 * é determinístico à volta dela. A meta prova-se com o modelo real no
 * "Testar a triagem" (Definições → Comunicação) ou em scripts/eval-mail-triage.ts.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: null as any, modify: vi.fn(async () => {}) }));
vi.mock("./db", async (orig) => ({
  ...(await orig<object>()), getDb: async () => h.db, logActivity: async () => {},
  getUserPermissionOverrides: async () => ({}), getUserModuleOverrides: async () => ({}),
}));
const national = vi.hoisted(() => ({ all: true, defaultCityId: null, cityName: null, cityIds: [] as number[], projectIds: [] as number[], missingCostCenter: false }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => national,
  loadCityAccessParts: async () => ({ access: national, base: national, all: national }),
}));
vi.mock("./mail/gmailApi", async (orig) => ({ ...(await orig<object>()), gmailApiForAccount: async () => ({ modifyLabels: h.modify }) }));

import {
  ALIAS_NOISE_MIN_CONFIDENCE, ALL_TRIAGE_FEATURES, MAIL_BACKFILL_DEFAULTS, MAIL_TRIAGE_CATEGORIES, MAIL_TRIAGE_HINTS, aliasGateIsNoise, automatedByHeaders,
  decideMailTriage, forwardedExternalSender, isLivroNoticeSender, isReviewNoticeSender, mailBackfillSettings, parseOccurrenceNotice, parseTriageCategory,
  preTriageMail, senderKindOf, splitQuotedText, triageMetrics, triageMetricsLogLine, type PreTriageFacts, type TriageFacts,
} from "../shared/mailTriage";
import { ROUTING_TARGETS } from "../shared/commsBoxes";
import { AUTOMATION_FLAGS, CRON_JOBS, SETTINGS, automationFlagDefault, validateSetting } from "../shared/appSettings";
import { MAIL_LINK_TYPES, isAutomatedSender, isCompanyAddress, isOwnListId, normalizeLinkEntityId } from "../shared/mail";
import { MAIL_ROUTING_SYSTEM, mailRoutingInput, mailRoutingSchema, MAIL_QUOTED_MAX } from "./_core/ai/prompts/comms";
import {
  applyRuleTriage, classifyEmailWithAi, routeEmailMessage, runMailBackfill, runPendingEmailRoutings, triageStoredMessage,
  type EmailRoutingDeps, type EmailRoutingMessage, type StoredTriageMessage,
} from "./commsRouting";
import { TRIAGE_CORPUS, corpusCounts } from "./fixtures/mailTriageCorpus";
import { corpusFacts, evalCorpusItem, evalTriageSlice, triageEvalReport } from "./mailTriageEval";
import { findOccurrenceForNotice } from "./mailNotices";
import { buildOccurrenceForNoticeSql } from "./multiparkDb/read";
import { MIGRATION_0655_STATEMENTS, IDEMPOTENT_ERROR_CODES_0655 } from "./migrations/migration_0655";
import { SCHEMA_MIGRATION_IDS } from "./migrations";
import { TICK_JOBS } from "./cronSchedule";
import { parseGmailMessage } from "./mail/parse";
import { setAiProvidersForTests } from "./_core/ai/client";
import { createFakeDb, createFakeProvider, okResponse } from "./_core/ai/testUtils";
import { resetAiUsageCachesForTests } from "./_core/ai/usage";
import { invalidateSettingsCache } from "./appSettings";
import { appRouter } from "./routers";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const company = (a: string) => isCompanyAddress(a);

// ─── Regras puras: depois da IA ──────────────────────────────────────────────

const T = { minConfidence: 0.7, createMinConfidence: 0.85, suggestMinConfidence: 0.5 };
const ACTIVE = new Set(["info", "rh", "reservas", "alteracoes", "cancelamentos", "reclamacoes", "perdidos", "faturacao", "criticas", "ocorrencias"]);
const NEW: TriageFacts = { sender: "external", forwardedExternal: false, newThread: true, mode: "sync" };
const decide = (out: any, facts: Partial<TriageFacts> = {}, features = ALL_TRIAGE_FEATURES, active: ReadonlySet<string> = ACTIVE) =>
  decideMailTriage(out, { ...NEW, ...facts }, T, features, active);

describe("decisão depois da IA — reclamações e perdidos abrem caso", () => {
  it("reclamação certa → caso confirmado; certeza média → 'Por confirmar'; abaixo → nada", () => {
    expect(decide({ box: "reclamacoes", confidence: 0.93 })).toMatchObject({ category: "reclamacoes", caseKind: "complaint", caseScore: 0.93, uncertain: false });
    expect(decide({ box: "reclamacoes", confidence: 0.6 })).toMatchObject({ category: "reclamacoes", caseKind: "complaint", uncertain: true });
    expect(decide({ box: "reservas", confidence: 0.95, complaint: 0.3 })).toMatchObject({ category: "reservas", caseKind: null });
  });
  it("reclamação escondida noutro pedido: a caixa da IA é outra, mas a certeza de queixa abre o caso", () => {
    const d = decide({ box: "alteracoes", confidence: 0.92, complaint: 0.72 });
    expect(d).toMatchObject({ category: "reclamacoes", caseKind: "complaint", uncertain: true, routeBox: "alteracoes" });
  });
  it("perdido (mesmo dentro de um elogio); os dois ao mesmo tempo → o mais certo (empate: reclamação)", () => {
    expect(decide({ box: "criticas", confidence: 0.8, lostItem: 0.9 })).toMatchObject({ category: "perdidos", caseKind: "lost_found", uncertain: false });
    expect(decide({ box: "perdidos", confidence: 0.9, complaint: 0.6 })).toMatchObject({ caseKind: "lost_found" });
    expect(decide({ box: "reclamacoes", confidence: 0.8, lostItem: 0.8 })).toMatchObject({ caseKind: "complaint" });
  });
  it("só de fora: a empresa a falar de uma queixa não abre caso — a reencaminhar a de um cliente, abre; automático nunca", () => {
    expect(decide({ box: "reclamacoes", confidence: 0.95 }, { sender: "company" })).toMatchObject({ caseKind: null, category: "reclamacoes" });
    expect(decide({ box: "reclamacoes", confidence: 0.95 }, { sender: "company", forwardedExternal: true })).toMatchObject({ caseKind: "complaint" });
    expect(decide({ box: "reclamacoes", confidence: 0.95 }, { sender: "automated" })).toMatchObject({ caseKind: null });
  });
  it("interruptores: sem o das reclamações/perdidos não há caso (fica a caixa do tema, como antes)", () => {
    const off = { complaints: false, lostFound: false, notices: false };
    expect(decide({ box: "reclamacoes", confidence: 0.95 }, {}, off)).toMatchObject({ caseKind: null, category: "reclamacoes", routeBox: "reclamacoes" });
    expect(decide({ box: "reservas", confidence: 0.9, lostItem: 0.95 }, {}, { ...off, complaints: true })).toMatchObject({ caseKind: null, category: "reservas" });
  });
  it("críticas e ocorrências só com o interruptor dos avisos; crítica fica lida, ocorrência por ler", () => {
    expect(decide({ box: "criticas", confidence: 0.9 })).toMatchObject({ category: "criticas", routeBox: "criticas", markRead: true, caseKind: null });
    expect(decide({ box: "ocorrencias", confidence: 0.9 })).toMatchObject({ category: "ocorrencias", routeBox: "ocorrencias", markRead: false });
    const noNotices = { ...ALL_TRIAGE_FEATURES, notices: false };
    expect(decide({ box: "criticas", confidence: 0.9 }, {}, noNotices)).toMatchObject({ category: "geral", routeBox: "info", markRead: false });
  });
  it("lixo fica onde está; não percebeu → info; sem info ativa → fica; caixa inativa → info", () => {
    expect(decide({ box: "ruido", confidence: 0.95 })).toMatchObject({ category: "ruido", routeBox: null });
    expect(decide({ box: "geral", confidence: 0.99 })).toMatchObject({ category: "geral", routeBox: "info" });
    expect(decide({ box: "reservas", confidence: 0.4 })).toMatchObject({ category: "geral", routeBox: "info", understood: false });
    expect(decide({ box: "parcerias", confidence: 0.9 })).toMatchObject({ routeBox: "info" });
    expect(decide({ box: "geral", confidence: 0.9 }, {}, ALL_TRIAGE_FEATURES, new Set(["reservas"])).routeBox).toBeNull();
  });
  it("resposta num fio e varrimento dos antigos: nunca mudam a caixa do tema (só o caso muda)", () => {
    expect(decide({ box: "reservas", confidence: 0.95 }, { newThread: false }).routeBox).toBeNull();
    expect(decide({ box: "reservas", confidence: 0.95 }, { mode: "sweep" }).routeBox).toBeNull();
    expect(decide({ box: "criticas", confidence: 0.95 }, { mode: "sweep" }).markRead).toBe(false);
    expect(decide({ box: "reclamacoes", confidence: 0.95 }, { newThread: false })).toMatchObject({ caseKind: "complaint" });
  });
  it("a IA às vezes devolve 85 em vez de 0,85; respostas antigas sem as certezas de caso contam 0", () => {
    expect(decide({ box: "Reclamações", confidence: 88 })).toMatchObject({ aiBoxKey: "reclamacoes", caseScore: 0.88 });
    expect(decide({ box: "reservas", confidence: 0.9 })).toMatchObject({ complaintScore: 0, lostScore: 0 });
    expect(parseTriageCategory("Serviços_extra")).toBe("servicos_extra");
    expect(parseTriageCategory("marketing")).toBeNull();
  });
  it("o texto do email nem entra na decisão (nenhuma palavra decide nada)", () => {
    expect(decideMailTriage.length).toBe(5);
    const body = src("shared/mailTriage.ts").split("export function decideMailTriage(")[1].split("\n}\n")[0];
    expect(body).not.toMatch(/\.test\(|RegExp|\.match\(|text|subject|body/);
  });
});

describe("reclamacoes@ / perdidos@: tudo é caso, salvo a IA ter a CERTEZA de que é lixo", () => {
  it("só lixo com ≥ 90 % e sem sinal de caso", () => {
    expect(ALIAS_NOISE_MIN_CONFIDENCE).toBe(0.9);
    expect(aliasGateIsNoise({ box: "ruido", confidence: 0.95 }, T)).toBe(true);
    expect(aliasGateIsNoise({ box: "ruido", confidence: 0.85 }, T)).toBe(false);
    expect(aliasGateIsNoise({ box: "ruido", confidence: 0.97, complaint: 0.6 }, T)).toBe(false);
    expect(aliasGateIsNoise({ box: "reservas", confidence: 0.99 }, T)).toBe(false);
  });
});

// ─── Regras puras: antes da IA ───────────────────────────────────────────────

const PRE: PreTriageFacts = {
  outbound: false, personal: false, systemMail: false, automated: 0, mailboxKey: "info", pipeline: null, fromEmail: "ana@gmail.com", text: "Olá",
  senderIsCompany: false, createdCase: false, threadHasCase: false, humanTouched: false,
};
const pre = (f: Partial<PreTriageFacts>) => preTriageMail({ ...PRE, ...f });

describe("antes da IA — só o determinístico óbvio", () => {
  it("o humano manda: o que uma pessoa mexeu nunca volta a ser mexido", () => {
    expect(pre({ humanTouched: true })).toEqual({ action: "skip", why: "human" });
    expect(pre({ humanTouched: true, fromEmail: "businessprofile-noreply@google.com" })).toEqual({ action: "skip", why: "human" });
  });
  it("reclamacoes@ e perdidos@ criam o caso sozinhas (a porta própria); caso já aberto → nada", () => {
    expect(pre({ pipeline: "reclamacoes" })).toEqual({ action: "skip", why: "case_box" });
    expect(pre({ pipeline: "perdidos" })).toEqual({ action: "skip", why: "case_box" });
    expect(pre({ threadHasCase: true })).toEqual({ action: "skip", why: "has_case" });
    expect(pre({ createdCase: true })).toEqual({ action: "skip", why: "has_case" });
  });
  it("avisos de avaliação pelo REMETENTE → Críticas (também na caixa das críticas)", () => {
    expect(pre({ fromEmail: "businessprofile-noreply@google.com" })).toMatchObject({ action: "rule", category: "criticas", notice: "review" });
    expect(pre({ fromEmail: "noreply@trustpilot.com", pipeline: "criticas", createdCase: true })).toMatchObject({ action: "rule", notice: "review" });
    expect(isReviewNoticeSender("calendar-notification@google.com")).toBe(false);
    expect(isReviewNoticeSender("reservas@booking.com")).toBe(false);
  });
  it("aviso de ocorrência da app pelo FORMULÁRIO (só de um endereço da empresa)", () => {
    const text = "Tipo de ocorrência: Vidro aberto\nMatrícula: 12-AB-34\nObservações: fechei\nLink reserva: https://www.admin.multigroup.pt/consulta/MvG5TZRxYURGKipy2WjU";
    expect(pre({ text, senderIsCompany: true, fromEmail: "info@multipark.pt" })).toMatchObject({ action: "rule", category: "ocorrencias", notice: "occurrence", occurrence: { plate: "12AB34", type: "Vidro aberto" } });
    expect(pre({ text, senderIsCompany: true, pipeline: "ocorrencias" })).toMatchObject({ action: "rule", notice: "occurrence" });
    expect(pre({ text })).toEqual({ action: "ai" }); // um cliente a copiar o formulário não é o aviso da app
    expect(parseOccurrenceNotice("**Tipo de ocorrência:** Dano\n**Matrícula:** AA-11-BB\n**Observações:** risco")).toEqual({ type: "Dano", plate: "AA11BB", remarks: "risco", bookingCode: null });
    expect(parseOccurrenceNotice(text)?.bookingCode).toBe("MvG5TZRxYURGKipy2WjU");
    expect(parseOccurrenceNotice("Houve uma ocorrência com o carro")).toBeNull();
  });
  it("Livro de Reclamações (plataforma oficial) → reclamação; envio em massa pelos cabeçalhos → lixo", () => {
    expect(isLivroNoticeSender("naoresponder@livroreclamacoes.pt")).toBe(true);
    expect(pre({ fromEmail: "naoresponder@livroreclamacoes.pt" })).toMatchObject({ action: "rule", category: "reclamacoes", notice: "livro" });
    expect(pre({ automated: 1, fromEmail: "news@loja.pt" })).toMatchObject({ action: "rule", category: "ruido", notice: "automatic" });
    // no-reply pelo endereço: pode ser um portal a passar a mensagem de um cliente → a IA lê
    expect(pre({ automated: 1, fromEmail: "no-reply@portal.pt" })).toEqual({ action: "ai" });
    expect(automatedByHeaders({ fromEmail: "no-reply@portal.pt", automated: 1 })).toBe(false);
  });
  it("de máquinas e sistema: nada (enviados, pessoais, sistema, notificações de reserva, campanhas)", () => {
    for (const f of [{ outbound: true }, { personal: true }, { systemMail: true }, { automated: 3 }, { automated: 2 }, { mailboxKey: null }, { pipeline: "campanhas" }, { pipeline: "criticas" }]) {
      expect(pre(f as any).action).toBe("skip");
    }
    expect(pre({ pipeline: "recursos-humanos" })).toEqual({ action: "ai" });
  });
  it("quem escreve e reencaminhamentos do backoffice", () => {
    expect(senderKindOf({ fromEmail: "Rui@Multipark.pt", automated: 0 }, company)).toBe("company");
    expect(senderKindOf({ fromEmail: "no-reply@x.pt", automated: 0 }, company)).toBe("automated");
    expect(senderKindOf({ fromEmail: "ana@gmail.com", automated: 1 }, company)).toBe("automated");
    expect(senderKindOf({ fromEmail: "ana@gmail.com", automated: 0 }, company)).toBe("external");
    const fwd = "Para tratar.\n\n---------- Forwarded message ---------\nDe: Ricardo Teles <ricardo.teles@gmail.com>\nSubject: Carro\n\nO espelho está partido.";
    expect(forwardedExternalSender(fwd, company)).toBe("ricardo.teles@gmail.com");
    expect(forwardedExternalSender("De: Rui <rui@multipark.pt>\nolá", company)).toBeNull();
    expect(forwardedExternalSender("Olá, tudo bem?", company)).toBeNull();
  });
  it("mensagem nova vs citado/reencaminhado (o citado vai à IA como contexto)", () => {
    expect(splitQuotedText("Ainda à espera!!\n\nEm 07/10/2026, Multipark escreveu:\n> Estamos a analisar.")).toEqual({ fresh: "Ainda à espera!!", quoted: "Em 07/10/2026, Multipark escreveu:\nEstamos a analisar." });
    const f = splitQuotedText("Ver abaixo.\n---------- Forwarded message ---------\nDe: A <a@b.pt>\nO carro veio riscado.");
    expect(f.fresh).toBe("Ver abaixo.");
    expect(f.quoted).toContain("O carro veio riscado.");
    expect(splitQuotedText("> citado\nnovo")).toEqual({ fresh: "novo", quoted: "citado" });
  });
  it("newsletter pelos cabeçalhos (List-Unsubscribe/List-Id); um Grupo Google NOSSO não faz de um cliente 'envio em massa'", () => {
    expect(isAutomatedSender("ana@gmail.com", { listUnsubscribe: "<https://x/unsub>" })).toBe(true);
    expect(isAutomatedSender("ana@gmail.com", { listId: "<news.loja.pt>" })).toBe(true);
    expect(isAutomatedSender("ana@gmail.com", { precedence: "list", listId: "<info.multipark.pt>" }, { ownListDomains: ["multipark.pt"] })).toBe(false);
    expect(isAutomatedSender("ana@gmail.com", { autoSubmitted: "auto-replied", listId: "<info.multipark.pt>" }, { ownListDomains: ["multipark.pt"] })).toBe(true);
    expect(isOwnListId("Info <info.multipark.pt>", ["multipark.pt"])).toBe(true);
    expect(isOwnListId("<news.multiparkfake.com>", ["multipark.pt"])).toBe(false);
    const raw = { id: "1", threadId: "1", labelIds: ["INBOX", "UNREAD"], payload: { headers: [{ name: "From", value: "a@b.pt" }, { name: "List-Unsubscribe", value: "<mailto:u@b.pt>" }, { name: "List-Id", value: "<n.b.pt>" }], mimeType: "text/plain", body: { data: "" } } } as any;
    expect(parseGmailMessage(raw)).toMatchObject({ listUnsubscribe: "<mailto:u@b.pt>", listId: "<n.b.pt>" });
    expect(src("server/mail/sync.ts")).toContain("listUnsubscribe: parsed.listUnsubscribe, listId: parsed.listId,");
  });
});

// ─── O pedido à IA: pelo sentido, nunca listas de palavras ──────────────────

/** Uma linha com 4 ou mais "palavras soltas" seguidas separadas por vírgulas (lista de palavras-chave). */
function keywordListLike(line: string): boolean {
  let run = 0;
  for (const seg of line.split(/,\s*/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean).length;
    run = words > 0 && words <= 2 ? run + 1 : 0;
    if (run >= 4) return true;
  }
  return false;
}

describe("o pedido à IA decide pelo sentido", () => {
  it("todas as categorias, cada uma descrita por uma frase (o que a pessoa quer) — sem listas de palavras", () => {
    for (const c of MAIL_TRIAGE_CATEGORIES) expect(MAIL_ROUTING_SYSTEM, c).toContain(`- ${c}: `);
    expect(MAIL_TRIAGE_HINTS.map((x) => x.key).sort()).toEqual([...MAIL_TRIAGE_CATEGORIES].sort());
    for (const t of ROUTING_TARGETS) expect(MAIL_TRIAGE_CATEGORIES as readonly string[]).toContain(t.key);
    for (const line of MAIL_ROUTING_SYSTEM.split("\n")) expect(keywordListLike(line), line).toBe(false);
    for (const hnt of MAIL_TRIAGE_HINTS) expect(hnt.hint.split(/\s+/).length, hnt.key).toBeGreaterThanOrEqual(8);
    expect(MAIL_ROUTING_SYSTEM).toContain("pelo sentido");
    expect(MAIL_ROUTING_SYSTEM).toContain("nunca por uma palavra solta");
    expect(MAIL_ROUTING_SYSTEM).not.toMatch(/palavras?-chave|se (o email )?(contiver|tiver a palavra|mencionar a palavra)|"reclama[cç][aã]o"|"queixa"/i);
    // o detetor apanha mesmo uma lista de palavras
    expect(keywordListLike("reclamações: danos, atrasos, mau serviço, cliente insatisfeito")).toBe(true);
  });
  it("a leitura dá as certezas de reclamação e de perdido (mesmo noutro pedido); respostas antigas sem elas continuam válidas", () => {
    expect(MAIL_ROUTING_SYSTEM).toMatch(/complaint: 0 a 1/);
    expect(MAIL_ROUTING_SYSTEM).toMatch(/lostItem: 0 a 1/);
    expect(mailRoutingSchema.safeParse({ box: "reservas", confidence: 0.9, reason: "x" }).success).toBe(true);
    expect(mailRoutingSchema.safeParse({ box: "reservas", confidence: 0.9, reason: "x", complaint: 0.7, lostItem: 0 }).success).toBe(true);
  });
  it("o texto citado/reencaminhado vai como contexto (cortado)", () => {
    const input = mailRoutingInput({ subject: "Fwd: carro", body: "Ver abaixo", quoted: "x".repeat(5000), senderFirstName: "Rui", senderKind: "company" });
    expect(input).toContain("Remetente: Rui (da empresa)");
    expect(input).toContain("Texto citado ou reencaminhado (contexto):");
    expect(input.length).toBeLessThan(MAIL_QUOTED_MAX + 400);
    expect(mailRoutingInput({ subject: "a", body: "b" })).not.toContain("citado");
  });
});

describe("a leitura real (fornecedor falso): o reencaminhamento chega à IA, sem dados pessoais", () => {
  const KEYS = ["GEMINI_API_KEY", "LLM_API_KEY", "AI_ENABLED", "AI_MAIL_ROUTING", "AI_MONTHLY_BUDGET_EUR", "AI_PROVIDER"];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    process.env.GEMINI_API_KEY = "test-key";
    h.db = createFakeDb();
    resetAiUsageCachesForTests();
    invalidateSettingsCache();
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    setAiProvidersForTests(null);
  });
  it("o corpo reencaminhado vai como contexto; telefone e email tapados; certezas de caso validadas", async () => {
    const out = { box: "reclamacoes", confidence: 0.9, reason: "Espelho partido", complaint: 0.95, lostItem: 0 };
    const fake = createFakeProvider("gemini", [okResponse(JSON.stringify(out))]);
    setAiProvidersForTests({ gemini: fake });
    const msg: EmailRoutingMessage = {
      threadId: 1, messageId: 2, fromBoxKey: "info", subject: "Fwd: Problema", fromName: "Backoffice Multipark", fromEmail: "backoffice@multipark.pt", attachmentNames: [], projectId: null,
      text: "Para tratar.\n\n---------- Forwarded message ---------\nDe: Ricardo <ricardo.teles@gmail.com>\n\nO espelho está partido. Liguem 912 345 678.",
      senderKind: "company",
    };
    const r = await classifyEmailWithAi(msg, "Info (geral)");
    expect(r.output).toMatchObject(out);
    const sent = fake.calls[0].parts.map((p: any) => p.text ?? "").join("\n");
    expect(sent).toContain("O espelho está partido.");
    expect(sent).toContain("Texto citado ou reencaminhado (contexto)");
    expect(sent).not.toContain("912 345 678");
    expect(sent).not.toContain("ricardo.teles@gmail.com");
    expect(sent).toContain("(da empresa)");
    expect(r.model).toBeTruthy();
  });
});

// ─── O encaminhador com a IA simulada ────────────────────────────────────────

const BOXES = ["info", "reservas", "alteracoes", "rh", "reclamacoes", "perdidos", "criticas", "ocorrencias", "faturacao"].map((key) => ({ key, label: key, active: true }));
const MSG: EmailRoutingMessage = { threadId: 10, messageId: 100, fromBoxKey: "info", subject: "Assunto", text: "Texto", fromName: "Ana", fromEmail: "ana@gmail.com", attachmentNames: [], projectId: null };

function deps(o: Partial<EmailRoutingDeps> & { output?: any; fail?: boolean; caseStatus?: string } = {}) {
  const calls = { classify: 0, move: [] as any[], record: [] as any[], intake: [] as any[], read: [] as number[], claim: 0, link: [] as any[] };
  const claimed = new Set<number>();
  const d: EmailRoutingDeps = {
    enabled: async () => true,
    settings: async () => ({ minConfidence: 0.7, perRun: 10 }),
    caseSettings: async () => ({ createMinConfidence: 0.85, suggestMinConfidence: 0.5 }),
    features: async () => ({ ...ALL_TRIAGE_FEATURES }),
    boxes: async () => BOXES,
    claim: async (m) => { calls.claim++; if (claimed.has(m.messageId)) return false; claimed.add(m.messageId); return true; },
    classify: async () => {
      calls.classify++;
      if (o.fail) throw Object.assign(new Error("timeout"), { code: "timeout" });
      return { output: o.output ?? { box: "reservas", confidence: 0.9, reason: "preço" }, restore: (s: string) => s };
    },
    move: async (t, b, opts) => { calls.move.push([t, b, opts ?? null]); return true; },
    record: async (_m, p) => { calls.record.push(p); },
    firstContact: async () => ({ outcome: "created", leadId: 1, applicationId: null }) as any,
    cityProjectId: async () => null,
    afterRh: async () => {},
    caseIntake: async (_m, v) => { calls.intake.push(v); return (o.caseStatus ?? "created") === "created" ? { status: "created", complaintId: 9 } : { status: o.caseStatus as any, why: "partner" } as any; },
    markRead: async (id) => { calls.read.push(id); },
    findOccurrence: async () => ({ status: "found", id: "occ_1" }),
    linkOccurrence: async (t, m, id) => { calls.link.push([t, m, id]); },
    ...o,
  };
  return { d, calls };
}

describe("email → caixa e caso (IA simulada)", () => {
  it("reclamação → caso (sem escrever ao cliente) e a conversa vai para as Reclamações, por ler", async () => {
    const { d, calls } = deps({ output: { box: "reclamacoes", confidence: 0.93, reason: "Risco na porta", complaint: 0.95 } });
    const r = await routeEmailMessage(MSG, d);
    expect(r).toMatchObject({ status: "moved", boxKey: "reclamacoes", category: "reclamacoes", complaint: { status: "created" } });
    expect(calls.intake[0]).toEqual({ kind: "complaint", aiBoxKey: "reclamacoes", confidence: 0.95, reason: "Risco na porta" });
    expect(calls.move).toEqual([[10, "reclamacoes", { reroute: true }]]);
    expect(calls.read).toEqual([]);
    expect(calls.record[0]).toMatchObject({ status: "moved", via: "ai", category: "reclamacoes", complaintScore: 0.95, lostScore: 0, boxKey: "reclamacoes" });
  });
  it("reclamação dentro de um pedido de alteração → caso 'Por confirmar' e a conversa vai para as Reclamações (não para as Alterações)", async () => {
    const { d, calls } = deps({ output: { box: "alteracoes", confidence: 0.92, reason: "Muda a data", complaint: 0.65 } });
    expect(await routeEmailMessage({ ...MSG, fromBoxKey: "reservas" }, d)).toMatchObject({ boxKey: "reclamacoes" });
    expect(calls.intake[0]).toMatchObject({ kind: "complaint", confidence: 0.65 });
    expect(calls.record[0].reason).toContain("Por confirmar");
  });
  it("o caso não nasceu (ex.: parceiro) → fica a caixa do tema", async () => {
    const { d, calls } = deps({ output: { box: "alteracoes", confidence: 0.92, reason: "x", complaint: 0.9 }, caseStatus: "skipped" });
    expect(await routeEmailMessage(MSG, d)).toMatchObject({ boxKey: "alteracoes" });
    expect(calls.move).toEqual([[10, "alteracoes", null]]);
  });
  it("perdido → caso nos Perdidos e a conversa vai para a caixa Perdidos", async () => {
    const { d, calls } = deps({ output: { box: "criticas", confidence: 0.8, reason: "Elogio e iPad esquecido", lostItem: 0.9 } });
    expect(await routeEmailMessage(MSG, d)).toMatchObject({ boxKey: "perdidos", category: "perdidos" });
    expect(calls.intake[0]).toMatchObject({ kind: "lost_found", confidence: 0.9 });
    expect(calls.read).toEqual([]); // um perdido nunca fica lido
  });
  it("resposta num fio: sem caso não muda de caixa; com caso vai para a caixa do caso (mesmo já separada pela IA)", async () => {
    const a = deps({ output: { box: "reservas", confidence: 0.95, reason: "x" } });
    expect(await routeEmailMessage({ ...MSG, newThread: false, fromBoxKey: "alteracoes" }, a.d)).toMatchObject({ status: "kept", boxKey: "alteracoes" });
    expect(a.calls.move).toEqual([]);
    const b = deps({ output: { box: "reclamacoes", confidence: 0.9, reason: "Ainda à espera", complaint: 0.9 } });
    expect(await routeEmailMessage({ ...MSG, newThread: false, fromBoxKey: "alteracoes" }, b.d)).toMatchObject({ status: "moved", boxKey: "reclamacoes" });
    expect(b.calls.move[0][2]).toEqual({ reroute: true });
  });
  it("crítica (elogio) → Críticas e LIDA; ocorrência relatada por uma pessoa → Ocorrências por ler; lixo fica", async () => {
    const a = deps({ output: { box: "criticas", confidence: 0.9, reason: "Elogio" } });
    expect(await routeEmailMessage(MSG, a.d)).toMatchObject({ boxKey: "criticas" });
    expect(a.calls.read).toEqual([100]);
    expect(a.calls.intake).toEqual([]); // nada no módulo das Críticas
    expect(a.calls.record[0]).toMatchObject({ markedRead: true, category: "criticas" });
    const b = deps({ output: { box: "ocorrencias", confidence: 0.9, reason: "Vidro aberto" } });
    expect(await routeEmailMessage({ ...MSG, senderKind: "company" }, b.d)).toMatchObject({ boxKey: "ocorrencias" });
    expect(b.calls.read).toEqual([]);
    const c = deps({ output: { box: "ruido", confidence: 0.97, reason: "Publicidade" } });
    expect(await routeEmailMessage(MSG, c.d)).toMatchObject({ status: "kept", boxKey: "info", category: "ruido" });
  });
  it("avisos desligados: crítica e ocorrência fazem o que já faziam (não percebeu → info), sem marcar lida", async () => {
    const { d, calls } = deps({ output: { box: "criticas", confidence: 0.9, reason: "Elogio" }, features: async () => ({ complaints: true, lostFound: false, notices: false }) });
    expect(await routeEmailMessage({ ...MSG, fromBoxKey: "reservas" }, d)).toMatchObject({ boxKey: "info" });
    expect(calls.read).toEqual([]);
  });
  it("reclamações desligadas: nem pergunta ao caso; separa pelas caixas como antes", async () => {
    const { d, calls } = deps({ output: { box: "reclamacoes", confidence: 0.9, reason: "x", complaint: 0.9 }, features: async () => ({ complaints: false, lostFound: false, notices: false }) });
    expect(await routeEmailMessage(MSG, d)).toMatchObject({ boxKey: "reclamacoes" });
    expect(calls.intake).toEqual([]);
    expect(calls.move[0][2]).toBeNull();
  });
  it("a IA falhou → nada se mexe (por ler), fica registado para voltar a tentar; o interruptor geral desligado → nada", async () => {
    const a = deps({ fail: true });
    expect(await routeEmailMessage({ ...MSG, fromBoxKey: "reservas" }, a.d)).toEqual({ status: "failed", boxKey: "reservas" });
    expect(a.calls.move).toEqual([]);
    expect(a.calls.intake).toEqual([]);
    expect(a.calls.record[0]).toMatchObject({ status: "failed", error: "timeout" });
    const b = deps({ enabled: async () => false });
    expect(await routeEmailMessage(MSG, b.d)).toEqual({ status: "off" });
    expect(b.calls).toMatchObject({ claim: 0, classify: 0 });
  });
  it("cada email é lido uma vez (a 2.ª vez nem chama a IA nem o caso)", async () => {
    const { d, calls } = deps({ output: { box: "reclamacoes", confidence: 0.9, reason: "x", complaint: 0.9 } });
    await routeEmailMessage(MSG, d);
    expect(await routeEmailMessage(MSG, d)).toEqual({ status: "seen" });
    expect(calls.classify).toBe(1);
    expect(calls.intake).toHaveLength(1);
  });
  it("varrimento: só o caso e a caixa do caso; o resto grava só a leitura (a linha antiga fica)", async () => {
    const a = deps({ output: { box: "reservas", confidence: 0.95, reason: "x" } });
    expect(await routeEmailMessage({ ...MSG, mode: "sweep" }, a.d)).toMatchObject({ status: "kept", boxKey: "info" });
    expect(a.calls.move).toEqual([]);
    expect(a.calls.record[0]).toMatchObject({ onlyTriage: true, category: "reservas" });
    const b = deps({ output: { box: "reservas", confidence: 0.95, reason: "x", complaint: 0.9 } });
    expect(await routeEmailMessage({ ...MSG, mode: "sweep" }, b.d)).toMatchObject({ status: "moved", boxKey: "reclamacoes" });
    expect(b.calls.record[0]).toMatchObject({ onlyTriage: false });
  });
});

describe("regras sem IA (avisos)", () => {
  const occText = "Tipo de ocorrência: Vidro aberto\nMatrícula: 12-AB-34";
  it("aviso de avaliação: Críticas + lido; com os avisos desligados nem reserva o email", async () => {
    const a = deps();
    const rule = preTriageMail({ ...PRE, fromEmail: "businessprofile-noreply@google.com" });
    expect(rule.action).toBe("rule");
    expect(await applyRuleTriage(MSG, rule as any, a.d)).toMatchObject({ status: "moved", boxKey: "criticas", category: "criticas" });
    expect(a.calls.read).toEqual([100]);
    expect(a.calls.classify).toBe(0);
    expect(a.calls.record[0]).toMatchObject({ via: "rule", notice: "review", markedRead: true });
    const b = deps({ features: async () => ({ complaints: true, lostFound: false, notices: false }) });
    expect(await applyRuleTriage(MSG, rule as any, b.d)).toEqual({ status: "off" });
    expect(b.calls.claim).toBe(0);
  });
  it("aviso de ocorrência: a da Multipark encontrada → liga, Ocorrências, lido; não está → Ocorrências por ler; Multipark em baixo → nada mexe, volta a tentar", async () => {
    const rule = preTriageMail({ ...PRE, text: occText, senderIsCompany: true, fromEmail: "info@multipark.pt" }) as any;
    const a = deps();
    expect(await applyRuleTriage({ ...MSG, sentAt: "2026-10-14 08:00:00" }, rule, a.d)).toMatchObject({ status: "moved", boxKey: "ocorrencias" });
    expect(a.calls.link).toEqual([[10, 100, "occ_1"]]);
    expect(a.calls.read).toEqual([100]);
    const b = deps({ findOccurrence: async () => ({ status: "none" }) });
    expect(await applyRuleTriage(MSG, rule, b.d)).toMatchObject({ status: "moved", boxKey: "ocorrencias" });
    expect(b.calls.read).toEqual([]);
    expect(b.calls.record[0].reason).toContain("não está na app Multipark");
    const c = deps({ findOccurrence: async () => ({ status: "unavailable" }) });
    expect(await applyRuleTriage(MSG, rule, c.d)).toEqual({ status: "pending" });
    expect(c.calls.move).toEqual([]);
    expect(c.calls.read).toEqual([]);
    expect(c.calls.record[0]).toMatchObject({ status: "pending", error: "multipark_indisponivel" });
  });
  it("Livro de Reclamações: reclamação (passa os filtros de automático) e caixa das Reclamações", async () => {
    const a = deps();
    const rule = preTriageMail({ ...PRE, fromEmail: "naoresponder@livroreclamacoes.pt" }) as any;
    await applyRuleTriage(MSG, rule, a.d);
    expect(a.calls.intake[0]).toMatchObject({ kind: "complaint", notice: "livro", confidence: 1 });
    expect(a.calls.move).toEqual([[10, "reclamacoes", { reroute: true }]]);
  });
  it("envio em massa: fica onde está, registado (o varrimento não o volta a ler)", async () => {
    const a = deps();
    const rule = preTriageMail({ ...PRE, automated: 1, fromEmail: "news@loja.pt" }) as any;
    expect(await applyRuleTriage(MSG, rule, a.d)).toMatchObject({ status: "kept", category: "ruido" });
    expect(a.calls.move).toEqual([]);
  });
  it("a ocorrência procura-se na Multipark só a LER (matrícula + hora, LIMIT 1)", async () => {
    const q = buildOccurrenceForNoticeSql({ plate: "12-AB-34", type: "Vidro aberto", atUtc: "2026-10-14 08:00:00" })!;
    expect(q.sql).toMatch(/^SELECT o\."id" AS id/);
    expect(q.sql).toContain("LIMIT 1");
    expect(q.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(q.params).toEqual(["12AB34", "2026-10-14 05:00:00", "2026-10-14 08:30:00", "2026-10-14 08:00:00", "Vidro aberto"]);
    expect(buildOccurrenceForNoticeSql({ plate: "1", type: null, atUtc: "2026-10-14 08:00:00" })).toBeNull();
    expect(await findOccurrenceForNotice({ type: "x", plate: "12AB34", remarks: null, bookingCode: null }, "2026-10-14 08:00:00", async () => ({ available: true, data: { id: "cmgX" } }))).toEqual({ status: "found", id: "cmgX" });
    expect(await findOccurrenceForNotice({ type: "x", plate: "12AB34", remarks: null, bookingCode: null }, null, async () => ({ available: true, data: null }))).toEqual({ status: "none" });
    expect(await findOccurrenceForNotice({ type: "x", plate: "12AB34", remarks: null, bookingCode: null }, null, async () => ({ available: false }))).toEqual({ status: "unavailable" });
    expect(MAIL_LINK_TYPES).toContain("occurrence");
    expect(normalizeLinkEntityId("occurrence", "cmgAbC_123")).toBe("cmgAbC_123");
    expect(normalizeLinkEntityId("occurrence", "x; DROP")).toBe("");
    expect(src("client/src/components/mail/mailUi.tsx")).toContain("occurrence: (id) => `/ocorrencias?mp=${encodeURIComponent(id)}`");
  });
});

// ─── Emails já guardados: pendentes, falhados e o varrimento ─────────────────

const stored = (o: Partial<PreTriageFacts> = {}, m: Partial<EmailRoutingMessage> = {}): StoredTriageMessage => ({
  pre: { ...PRE, ...o },
  msg: { ...MSG, newThread: true, senderKind: "external", ...m },
});

describe("emails já guardados", () => {
  it("o que uma pessoa mexeu fica decidido sem IA ('uma pessoa já mexeu')", async () => {
    const { d, calls } = deps();
    expect(await triageStoredMessage(100, { ...d, load: async () => stored({ humanTouched: true }) })).toMatchObject({ status: "kept" });
    expect(calls.classify).toBe(0);
    expect(calls.record[0]).toMatchObject({ status: "kept", via: "rule", reason: "uma pessoa já mexeu nesta conversa", onlyTriage: true });
  });
  it("pendente/falhado volta a ler com a IA; aviso volta à regra", async () => {
    const a = deps({ output: { box: "reclamacoes", confidence: 0.9, reason: "x", complaint: 0.9 } });
    expect(await triageStoredMessage(100, { ...a.d, load: async () => stored() })).toMatchObject({ boxKey: "reclamacoes" });
    const b = deps();
    expect(await triageStoredMessage(100, { ...b.d, load: async () => stored({ fromEmail: "businessprofile-noreply@google.com" }) })).toMatchObject({ boxKey: "criticas" });
    expect(b.calls.classify).toBe(0);
  });
  it("pendentes e falhados (até 3 tentativas, 2 dias); os acabados de reservar pelo varrimento ficam com ele", async () => {
    h.db = createFakeDb(() => [[]]);
    const { d } = deps();
    await runPendingEmailRoutings({}, d);
    const q = h.db.queries[0].sql as string;
    expect(q).toContain("attempts < ?");
    expect(q).toContain("(status = 'pending' OR (status = 'failed' AND via = 'fallback'");
    // auditoria: do varrimento só as presas "pending" (a corrida morreu), e em modo varrimento
    expect(q).toContain("(sweptAt IS NULL OR (status = 'pending' AND sweptAt < ?))");
  });
});

describe("varrimento dos emails que já estão nas caixas (AI_MAIL_BACKFILL)", () => {
  function sweepDb(opts: { rows: number[]; claimable: Set<number> }) {
    return createFakeDb((q) => {
      if (q.sql.startsWith("SELECT m.id, m.threadId FROM mail_messages m")) return [opts.rows.map((id) => ({ id, threadId: id }))];
      if (q.sql.startsWith("INSERT IGNORE INTO comms_ai_routing")) {
        const id = Number(q.params.find((p) => typeof p === "number"));
        if (opts.claimable.has(id)) { opts.claimable.delete(id); return [{ affectedRows: 1 }]; }
        return [{ affectedRows: 0 }];
      }
      if (q.sql.startsWith("UPDATE comms_ai_routing r SET r.sweptAt")) return [{ affectedRows: 0 }];
      return [[]];
    });
  }
  it("desligado (por omissão) → não lê nada", async () => {
    h.db = createFakeDb();
    const { d, calls } = deps();
    expect(await runMailBackfill({}, { ...d, backfillEnabled: async () => false })).toMatchObject({ skipped: "disabled" });
    expect(h.db.queries).toHaveLength(0);
    expect(calls.classify).toBe(0);
    expect(automationFlagDefault("AI_MAIL_BACKFILL")).toBe(false);
  });
  it("lê os que nunca leu, abre os casos, e a 2.ª corrida não repete nada (idempotente)", async () => {
    const claimable = new Set([1, 2]);
    h.db = sweepDb({ rows: [1, 2], claimable });
    const { d, calls } = deps({ output: { box: "reservas", confidence: 0.9, reason: "x", complaint: 0.9 } });
    const load = async (id: number) => stored({}, { messageId: id, threadId: id, mode: "sweep" });
    const r = await runMailBackfill({ deadlineAt: Date.now() + 60_000 }, { ...d, load, backfillEnabled: async () => true });
    expect(r).toMatchObject({ read: 2, ai: 2, cases: 2 });
    expect(calls.intake).toHaveLength(2);
    h.db = sweepDb({ rows: [1, 2], claimable });
    const again = await runMailBackfill({ deadlineAt: Date.now() + 60_000 }, { ...d, load, backfillEnabled: async () => true });
    expect(again).toMatchObject({ read: 0, ai: 0 });
    expect(calls.classify).toBe(2);
  });
  it("teto por corrida (perRun) e o que já tem caso/uma pessoa mexeu fica de fora (no SQL)", async () => {
    h.db = sweepDb({ rows: [1, 2, 3, 4, 5, 6, 7, 8, 9], claimable: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]) });
    const { d, calls } = deps({ output: { box: "reservas", confidence: 0.9, reason: "x" } });
    await runMailBackfill({ limit: 3, deadlineAt: Date.now() + 60_000 }, { ...d, load: async (id) => stored({}, { messageId: id, mode: "sweep" }), backfillEnabled: async () => true });
    expect(calls.classify).toBe(3);
    const q = (h.db.queries as any[]).find((x) => x.sql.startsWith("SELECT m.id, m.threadId")).sql as string;
    for (const part of [
      "m.direction = 'in'", "m.automated IN (0, 1)", "t.ownerUserId IS NULL", "t.routedBy <> 'manual'", "t.status <> 'resolvido'", "t.archivedAt IS NULL",
      "c.correctedBoxKey IS NOT NULL", "l.entityType IN ('complaint', 'lost_found')", "i.status <> 'skipped'", "r.category IS NOT NULL OR r.status = 'pending'",
      "r.sweptAt IS NOT NULL AND NOT",
      "ORDER BY m.sentAt DESC",
    ]) expect(q, part).toContain(part);
  });
  it("definições: 30 dias e 6 por corrida, validadas; trabalho próprio de 15 em 15 min", () => {
    expect(mailBackfillSettings(null)).toEqual({ days: 30, perRun: 6 });
    expect(SETTINGS["ai.mailBackfill"].defaultValue).toEqual({ ...MAIL_BACKFILL_DEFAULTS });
    expect(validateSetting("ai.mailBackfill", { days: 120, perRun: 6 }).ok).toBe(false);
    expect(validateSetting("ai.mailBackfill", { days: 14, perRun: 10 }).ok).toBe(true);
    expect(TICK_JOBS.find((j) => j.key === "mail-backfill")).toMatchObject({ cadence: { kind: "interval", minutes: 15 } });
    expect(CRON_JOBS.some((j) => j.name === "mail-backfill")).toBe(true);
    expect(src("server/commsAiSweep.ts")).toContain("(await import(\"./commsRouting\")).runMailBackfill({ deadlineAt })");
  });
});

// ─── Lido / por ler, mover, Gmail ────────────────────────────────────────────

describe("lido e por ler", () => {
  it("marcar lida (crítica/aviso): no dashboard e no Gmail; já lida → nada", async () => {
    h.modify.mockClear();
    const row = { threadId: 10, accountKey: "dwd:reservas@multipark.pt", gmailMessageId: "g1", isRead: 0, direction: "in", mailboxKey: "criticas", ownerUserId: null };
    h.db = createFakeDb((q) => (q.sql.startsWith("SELECT m.threadId, m.accountKey") ? [[row]] : [{ affectedRows: 1 }]));
    const { markMessageReadBySystem } = await import("./mail/store");
    expect(await markMessageReadBySystem(100)).toBe(true);
    const all = h.db.queries.map((q: any) => q.sql).join("\n");
    expect(all).toContain("UPDATE mail_messages SET isRead = 1 WHERE id = ?");
    expect(h.modify).toHaveBeenCalledWith("g1", [], ["UNREAD"]);
    h.db = createFakeDb((q) => (q.sql.startsWith("SELECT m.threadId, m.accountKey") ? [[{ ...row, isRead: 1 }]] : [{ affectedRows: 1 }]));
    expect(await markMessageReadBySystem(100)).toBe(false);
  });
  it("mover nunca marca lida; com caso pode mudar uma conversa que a IA separou, nunca uma movida à mão", async () => {
    h.db = createFakeDb(() => [{ affectedRows: 1 }]);
    const { moveThreadToBox } = await import("./mail/service");
    await moveThreadToBox(10, "reclamacoes", "ai", { reroute: true });
    await moveThreadToBox(10, "reservas", "ai");
    const [a, , b] = h.db.queries.map((q: any) => q.sql);
    expect(a).toContain("AND (routedBy IS NULL OR routedBy = 'ai')");
    expect(b).toContain("AND routedBy IS NULL");
    expect(h.db.queries.map((q: any) => q.sql).join("\n")).not.toMatch(/isRead/);
  });
});

// ─── Interruptores, definições, migração ─────────────────────────────────────

describe("interruptores (o que escreve sozinho entra desligado)", () => {
  const flag = (n: string) => AUTOMATION_FLAGS.find((f) => f.name === n)!;
  it("novos desligados; os já pedidos pelo Jorge continuam ligados; cada um diz o que faz", () => {
    for (const n of ["AI_MAIL_LOST_FOUND", "AI_MAIL_NOTICES", "AI_MAIL_BACKFILL", "AI_MAIL_ALIAS_FILTER"]) {
      expect(flag(n), n).toMatchObject({ group: "ia" });
      expect(automationFlagDefault(n), n).toBe(false);
      expect(flag(n).description, n).toMatch(/Desligado por omissão/);
    }
    expect(automationFlagDefault("AI_MAIL_ROUTING")).toBe(true);
    expect(automationFlagDefault("AI_MAIL_COMPLAINTS")).toBe(true);
    expect(flag("AI_MAIL_COMPLAINTS").description).toMatch(/Por confirmar \(IA\)/);
    expect(flag("AI_MAIL_COMPLAINTS").description).toMatch(/NUNCA se responde ao cliente/);
    expect(flag("AI_MAIL_ROUTING").description).toMatch(/Se a IA falhar nada se mexe/);
    expect(flag("AI_MAIL_LOST_FOUND").description).toMatch(/Nunca escreve ao cliente/);
    expect(flag("AI_MAIL_NOTICES").description).toMatch(/ficam LIDOS/);
    expect(flag("AI_MAIL_ALIAS_FILTER").description).toMatch(/90 %/);
    const names = AUTOMATION_FLAGS.map((x) => x.name);
    expect(names.indexOf("AI_MAIL_COMPLAINTS")).toBe(names.indexOf("AI_MAIL_ROUTING") + 1);
  });
  it("certezas dos casos: a do meio já cria 'Por confirmar' (descrição atualizada)", () => {
    expect(SETTINGS["ai.mailComplaints"].description).toContain("Por confirmar (IA)");
  });
});

describe("migração 0655 (só acrescenta) e nunca apagar", () => {
  it("registada no fim, por ordem, só ADD COLUMN, idempotente", () => {
    expect(SCHEMA_MIGRATION_IDS[SCHEMA_MIGRATION_IDS.length - 1]).toBe("0655");
    for (const s of MIGRATION_0655_STATEMENTS) expect(s).toMatch(/^ALTER TABLE `\w+` ADD COLUMN /);
    expect(MIGRATION_0655_STATEMENTS.join("\n")).not.toMatch(/\bDELETE\b|\bDROP\b|TRUNCATE/i);
    expect(IDEMPOTENT_ERROR_CODES_0655.has("ER_DUP_FIELDNAME")).toBe(true);
    expect(MIGRATION_0655_STATEMENTS.join("\n")).toContain("`aiUnconfirmed` TINYINT NOT NULL DEFAULT 0");
  });
  it("nenhum DELETE nos ficheiros novos", () => {
    for (const f of ["shared/mailTriage.ts", "server/mailTriageEval.ts", "server/mailNotices.ts", "server/commsRouting.ts", "server/complaintMailIntake.ts", "server/fixtures/mailTriageCorpus.ts"]) {
      expect(src(f), f).not.toMatch(/\bDELETE FROM\b|\.delete\(|\bDROP TABLE\b|TRUNCATE/);
    }
  });
});

// ─── Avaliação ("Testar a triagem") ─────────────────────────────────────────

describe("corpus rotulado e avaliação", () => {
  it("≥ 120 emails, todas as categorias, PT-PT na maioria + EN/ES/FR, ids únicos", () => {
    expect(TRIAGE_CORPUS.length).toBeGreaterThanOrEqual(120);
    const counts = corpusCounts();
    for (const c of MAIL_TRIAGE_CATEGORIES) expect(counts[c] ?? 0, c).toBeGreaterThan(0);
    expect(counts.reclamacoes).toBeGreaterThanOrEqual(30);
    expect(counts.perdidos).toBeGreaterThanOrEqual(15);
    const langs = new Set(TRIAGE_CORPUS.map((c) => c.lang));
    expect([...langs].sort()).toEqual(["en", "es", "fr", "pt"]);
    expect(TRIAGE_CORPUS.filter((c) => c.lang === "pt").length).toBeGreaterThan(TRIAGE_CORPUS.length / 2);
    expect(new Set(TRIAGE_CORPUS.map((c) => c.id)).size).toBe(TRIAGE_CORPUS.length);
    for (const c of TRIAGE_CORPUS) expect(parseTriageCategory(c.expected), c.id).toBe(c.expected);
    // os difíceis pedidos pelo Jorge estão lá
    for (const id of ["rec-11", "rec-12", "rec-13", "rec-14", "rec-15", "lost-07", "fat-05", "res-09", "noise-01"]) expect(TRIAGE_CORPUS.some((c) => c.id === id), id).toBe(true);
  });
  it("os factos do corpus são os de produção (regras sem IA dão a categoria certa)", async () => {
    const byId = (id: string) => TRIAGE_CORPUS.find((c) => c.id === id)!;
    expect(corpusFacts(byId("rec-14")).msg).toMatchObject({ senderKind: "company", forwardedExternal: true });
    const never = async () => { throw new Error("a IA não devia ser chamada"); };
    for (const id of ["crit-01", "crit-02", "crit-03", "occ-01", "occ-02", "occ-03", "rec-22", "noise-02", "noise-05", "noise-09"]) {
      const r = await evalCorpusItem(byId(id), never as any, T);
      expect(r.via, id).toBe("regra");
      expect(r.predicted, id).toBe(byId(id).expected);
    }
  });
  it("com a IA simulada a acertar tudo passa a meta; a IA a falhar nas reclamacoes@ abre o caso na mesma", async () => {
    const perfect = async (m: EmailRoutingMessage) => {
      const item = TRIAGE_CORPUS.find((c) => c.subject === m.subject && c.body === m.text)!;
      const k = item.expected;
      return { output: { box: k, confidence: 0.95, reason: "ok", complaint: k === "reclamacoes" ? 0.95 : 0, lostItem: k === "perdidos" ? 0.95 : 0 }, restore: (s: string) => s, model: "falso" } as any;
    };
    const rows = [];
    for (let off = 0; off < TRIAGE_CORPUS.length; off += 12) rows.push(...(await evalTriageSlice({ offset: off, limit: 12 }, { classify: perfect, thresholds: T })).items);
    const lines: string[] = [];
    const m = triageEvalReport({ rows, ms: 1000, model: "falso" }, TRIAGE_CORPUS, (l) => lines.push(l));
    expect(m).toMatchObject({ passes: true, recallComplaints: 1, recallLostFound: 1, correct: TRIAGE_CORPUS.length, missing: 0 });
    expect(lines[0]).toMatch(/^\[triagem-eval\] PASSA meta 90%/);
    const failing = async () => { throw Object.assign(new Error("x"), { code: "timeout" }); };
    const direct = TRIAGE_CORPUS.find((c) => c.id === "rec-31")!;
    expect(await evalCorpusItem(direct, failing as any, T)).toMatchObject({ predicted: "reclamacoes", via: "porta" });
    expect(await evalCorpusItem(TRIAGE_CORPUS.find((c) => c.id === "rec-01")!, failing as any, T)).toMatchObject({ predicted: null, via: "falhou" });
  });
  it("as contas: recall/precisão por categoria; os rótulos vêm SEMPRE do servidor", () => {
    const m = triageMetrics([
      { id: "a", expected: "reclamacoes", predicted: "reclamacoes" },
      { id: "b", expected: "reclamacoes", predicted: "reservas" },
      { id: "c", expected: "reservas", predicted: "reclamacoes" },
      { id: "d", expected: "perdidos", predicted: null },
    ]);
    expect(m.byCategory.find((c) => c.category === "reclamacoes")).toMatchObject({ support: 2, predicted: 2, correct: 1, recall: 0.5, precision: 0.5 });
    expect(m).toMatchObject({ failed: 1, recallLostFound: 0, passes: false });
    expect(triageMetricsLogLine(m)).toContain("NÃO PASSA");
    // o ecrã só manda ids e o que foi decidido: um rótulo inventado não conta
    const r = triageEvalReport({ rows: [{ id: "rec-01", predicted: "reclamacoes" }, { id: "inventado", predicted: "reclamacoes" }] }, TRIAGE_CORPUS, () => {});
    expect(r.total).toBe(1);
    expect(r.missing).toBe(TRIAGE_CORPUS.length - 1);
  });
  it("só o super admin testa; o ecrã está nas Definições → Comunicação; o script existe", async () => {
    h.db = null;
    const admin = appRouter.createCaller({ user: { id: 1, role: "admin", name: "A" }, req: { headers: {} }, res: {} } as any);
    await expect(admin.settings.mailTriageEval({ offset: 0, limit: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin.settings.mailTriageEvalReport({ rows: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(src("client/src/pages/DefinicoesPage.tsx")).toContain('{user.role === "super_admin" && <MailTriageEvalCard />}');
    expect(src("client/src/components/mail/MailTriageEvalCard.tsx")).toContain("Testar a triagem");
    const script = src("scripts/eval-mail-triage.ts");
    expect(script).toContain("evalTriageSlice");
    expect(script).not.toMatch(/API_KEY\s*=|sk-[A-Za-z0-9]/);
  });
});

describe("o resto do fluxo das caixas", () => {
  it("o push do Gmail já não falha em silêncio; uma linha de números por sincronização; casos falhados repetem-se de 15 em 15 min", () => {
    expect(src("server/mail/routes.ts")).toContain("[mail-push]");
    expect(src("server/mail/service.ts")).toContain("[triagem-email] sincronização");
    expect(src("server/commsAiSweep.ts")).toContain("retryFailedPipelines(r,");
  });
  it("'Por confirmar (IA)' nas Reclamações e nos Perdidos: confirmar ou arquivar", () => {
    expect(src("client/src/pages/ComplaintsPage.tsx")).toContain("<AiUnconfirmedBanner");
    expect(src("client/src/pages/lostFound/DetailView.tsx")).toContain("<AiUnconfirmedBanner");
    expect(src("client/src/pages/lostFound/KanbanView.tsx")).toContain("<AiUnconfirmedBadge />");
    expect(src("server/routers.ts").match(/confirmAi: protectedProcedure/g)).toHaveLength(2);
  });
});
