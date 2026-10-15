/**
 * Plano MPV F6b — críticas por email (R2/R3), triagem do WhatsApp dos
 * colaboradores (W1) e raciocínio "minimal" só com avaliação (T1).
 * Sem chamadas reais à IA nem à BD.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  flags: { REVIEWS_EMAIL_STRICT: false, REVIEWS_DEDUP: false } as Record<string, boolean>,
  claimed: new Set<string>(),
  created: [] as any[],
  duplicateOf: null as number | null,
  dupQueries: [] as any[],
  autoDraft: vi.fn(async () => ({ drafted: true })),
}));

vi.mock("./db", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    getDb: async () => null,
    claimInboundEmail: vi.fn(async (d: any) => (h.claimed.has(d.messageId) ? null : (h.claimed.add(d.messageId), h.claimed.size))),
    updateInboundEmail: vi.fn(async () => {}),
    deleteInboundEmail: vi.fn(async () => {}),
    createGoogleReview: vi.fn(async (d: any) => { h.created.push(d); return 500 + h.created.length; }),
  };
});
vi.mock("./reviewCleanup", async (orig) => ({
  ...(await orig<object>()),
  reviewFlagOn: async (name: string) => !!h.flags[name],
  findEmailReviewDuplicate: async (n: any) => { h.dupQueries.push(n); return h.duplicateOf; },
}));
vi.mock("./reviewOps", async (orig) => ({ ...(await orig<object>()), projectIdForReviewPark: async (name?: string) => (name && /airpark/i.test(name) ? 7 : null) }));
vi.mock("./reviewAutoDraft", () => ({ autoDraftEmailReview: h.autoDraft }));

import { parseGoogleReviewNotification } from "./emailParse";
import { dedupFactsOfRow, parseMarkBackup } from "./reviewCleanup";
import {
  emailReviewVerdict, findDuplicateOf, genericTextKeys, isReviewSummaryEmail, namesCompatible, notAReviewDecision, planDuplicateCleanup,
  reviewCommentFromEmail, reviewTextKeyFromApi, reviewTextKeyFromEmail, reviewerNameKey, sameReview, type DedupCleanupRow, type ReviewDedupFacts,
} from "../shared/reviewDedup";
import { isStaffWhatsappConversation, whatsappTriageGate, whatsappUrgentByWords } from "../shared/commsAi";
import { AI_THINKING_SUGGESTED, suggestedThinkingSetting, thinkingLevelVerdict } from "../shared/aiThinkingEval";
import { automationFlagDefault } from "../shared/appSettings";
import { SETTINGS } from "../shared/appSettings";
import { evalWhatsappTriage, whatsappEvalMetrics } from "./whatsappTriageEval";
import { evalComplaintTriage } from "./complaintTriageEval";
import { WHATSAPP_TRIAGE_CORPUS } from "./fixtures/whatsappTriageCorpus";
import { COMPLAINT_TRIAGE_CORPUS } from "./fixtures/complaintTriageCorpus";

const parse = (b: string, s: string) => parseGoogleReviewNotification(b, s);

// ─── Emails de exemplo (os dois formatos da Google) ─────────────────────────

const SUBJECT_RUI = "Rui deixou uma crítica sobre Airpark - Estacionamento Aeroporto de Lisboa";
const TEXT_RUI = "O serviço foi rápido e o condutor muito simpático, recomendo.";
/** 1.º email (o formato de sempre). */
const BODY_A = `Rui deixou uma crítica sobre Airpark - Estacionamento Aeroporto de Lisboa

<https://business.google.com/n/1/reviews/a?trk=x>

Bom trabalho, recebeu uma nova crítica de 5 estrela(s)

Rui Costa

${TEXT_RUI}

Responder à crítica <https://business.google.com/n/1>

Ver todas as críticas <https://business.google.com/n/1/reviews>

(c) 2026 Google Ireland Ltd, Gordon House, Barrow Street, Dublin 4, Ireland.`;
/** 2.º email da MESMA crítica: o nome e o perfil só no assunto, as estrelas desenhadas. */
const BODY_B = `Google Business Profile

Rui Costa
★★★★★
${TEXT_RUI}

Responder <https://business.google.com/n/1/reviews/a>`;

/** Como o leitor ANTIGO (só o corpo) guardava cada um (caso 3412/3413). */
function storedRow(id: number, body: string, o: Partial<{ reviewerName: string; rating: number; projectId: number | null; at: string }> = {}) {
  const g = parseGoogleReviewNotification(body);
  const text = g.rating > 0 || g.reviewerName ? `${SUBJECT_RUI}\n\n${g.cleanText}` : `${SUBJECT_RUI}\n\n${body}`;
  return {
    id, reviewerName: o.reviewerName ?? g.reviewerName ?? "Desconhecido", rating: o.rating ?? g.rating, reviewText: text,
    reviewDate: null, sourceEmailDate: o.at ?? "2026-10-10 09:00:00", createdAt: o.at ?? "2026-10-10 09:01:00",
    projectId: o.projectId === undefined ? 7 : o.projectId, googleReviewKey: null, sourceEmailId: `<m${id}@google>`,
  };
}
const GOOGLE = "businessprofile-noreply@google.com";
/** Factos de uma crítica de email guardada, com o email original (como a limpeza os lê). */
const emailFacts = (row: ReturnType<typeof storedRow>, body: string) => dedupFactsOfRow(row, parse, { body, fromEmail: GOOGLE });
const cleanupRow = (f: ReviewDedupFacts): DedupCleanupRow => ({ ...f, notAReview: false, duplicateOf: null, markUndone: false, locked: false });

/** Só estrelas, com um rodapé da Google que nenhuma lista conhece. */
const starsOnly = (first: string, full: string, withButton = true) => `${first} deixou uma crítica sobre Airpark - Estacionamento Aeroporto de Lisboa

Bom trabalho, recebeu uma nova crítica de 5 estrela(s)

${full}
${withButton ? "\nResponder à crítica <https://business.google.com/n/2>\n" : ""}
Gerir as preferências de email da sua conta Google Business
Google LLC, 1600 Amphitheatre Parkway, Mountain View, CA 94043`;
/** Com texto, no formato de sempre. */
const withText = (first: string, full: string, text: string) => `${first} deixou uma crítica sobre Airpark - Estacionamento Aeroporto de Lisboa

Bom trabalho, recebeu uma nova crítica de 5 estrela(s)

${full}

${text}

Responder à crítica <https://business.google.com/n/3>`;

const facts = (o: Partial<ReviewDedupFacts> & { id: number }): ReviewDedupFacts => ({
  parkKey: "p7", rating: 5, textKey: reviewTextKeyFromApi(TEXT_RUI), name: "rui costa", atMs: Date.parse("2026-10-10T09:00:00Z"), apiKey: false, ...o,
});

// ─── R2: o que vira crítica ─────────────────────────────────────────────────

describe("R2 — só o aviso de avaliação (ou com estrelas) vira crítica", () => {
  it("interruptores desligados: tudo vira crítica, como até aqui", () => {
    expect(emailReviewVerdict({ fromEmail: "candidato@gmail.com", rating: 0, subject: "Candidatura", body: "Envio o meu CV", strict: false, dedup: false })).toBe("review");
  });
  it("REVIEWS_EMAIL_STRICT: candidatura / resposta de cliente → não é crítica; Google ou com estrelas → crítica", () => {
    const v = (fromEmail: string, rating: number) => emailReviewVerdict({ fromEmail, rating, subject: "x", body: "y", strict: true, dedup: false });
    expect(v("candidato@gmail.com", 0)).toBe("not_review");
    expect(v("cliente@hotmail.com", 0)).toBe("not_review");
    expect(v("businessprofile-noreply@google.com", 0)).toBe("review");
    expect(v("jorge@multipark.pt", 4)).toBe("review"); // um colega reencaminhou o aviso
  });
  it("resumos ('recebeu 3 novas críticas') nunca viram crítica com um dos interruptores; só da Google e nunca com avaliador + texto", () => {
    expect(isReviewSummaryEmail({ fromEmail: GOOGLE, subject: "Recebeu 3 novas críticas", body: "Veja as críticas do seu perfil" })).toBe(true);
    expect(isReviewSummaryEmail({ fromEmail: GOOGLE, subject: "O seu perfil", body: "Tem novas críticas para ler" })).toBe(true);
    expect(isReviewSummaryEmail({ fromEmail: GOOGLE, subject: SUBJECT_RUI, body: BODY_A })).toBe(false);
    // Não é a Google (um cliente que escreve "recebi 3 novas críticas…") → não é resumo.
    expect(isReviewSummaryEmail({ fromEmail: "cliente@gmail.com", subject: "Recebeu 3 novas críticas", body: "" })).toBe(false);
    expect(isReviewSummaryEmail({ fromEmail: "noreply@trustpilot.com", subject: "Recebeu 3 novas críticas", body: "" })).toBe(false);
    // Avaliador com texto → é uma crítica, mesmo que o rodapé fale em "novas críticas".
    expect(isReviewSummaryEmail({ fromEmail: GOOGLE, subject: "Tem novas críticas", body: "x", reviewerWithText: true })).toBe(false);
    expect(emailReviewVerdict({ fromEmail: "businessprofile-noreply@google.com", rating: 0, subject: "Recebeu 2 novas críticas", body: "", strict: false, dedup: true })).toBe("summary");
    expect(emailReviewVerdict({ fromEmail: "businessprofile-noreply@google.com", rating: 0, subject: "Recebeu 2 novas críticas", body: "", strict: false, dedup: false })).toBe("review");
  });
  it("limpeza das antigas: marca só as de email sem estrelas e sem aviso; o que uma pessoa mexeu fica", () => {
    const row = { id: 1, fromEmail: "cliente@gmail.com", rating: 0, sourceEmailId: "<a>", complaintId: null, googleReviewKey: null, googleReply: null, respondedAt: null, status: "ai_responded", notAReview: false, duplicateOf: null, markUndone: false };
    expect(notAReviewDecision(row)).toEqual({ action: "mark" });
    expect(notAReviewDecision({ ...row, fromEmail: "businessprofile-noreply@google.com" })).toBeNull();
    expect(notAReviewDecision({ ...row, rating: 5 })).toBeNull();
    expect(notAReviewDecision({ ...row, sourceEmailId: null })).toBeNull();
    expect(notAReviewDecision({ ...row, notAReview: true })).toBeNull();
    expect(notAReviewDecision({ ...row, complaintId: 9 })).toMatchObject({ action: "keep" });
    expect(notAReviewDecision({ ...row, status: "manually_responded" })).toMatchObject({ action: "keep" });
    expect(notAReviewDecision({ ...row, markUndone: true })).toMatchObject({ action: "keep" });
    // Sem o email guardado (nem em inbound_emails nem em mail_messages) → não se propõe.
    expect(notAReviewDecision({ ...row, fromEmail: null })).toEqual({ action: "keep", why: expect.stringContaining("Remetente desconhecido") });
  });
});

// ─── R3: a mesma crítica ────────────────────────────────────────────────────

describe("R3 — chave de repetida (perfil + estrelas + texto ≥ 20 + 1.º nome + 48 h)", () => {
  it("o assunto dá o nome e o perfil quando o corpo não os tem; as estrelas desenhadas contam", () => {
    const old = parseGoogleReviewNotification(BODY_B);
    expect(old.parkName).toBeUndefined();
    expect(old.rating).toBe(0);
    const g = parseGoogleReviewNotification(BODY_B, SUBJECT_RUI);
    expect(g.parkName).toContain("Airpark");
    expect(g.reviewerName).toBe("Rui Costa");
    expect(g.rating).toBe(5);
    // O corpo continua a mandar.
    expect(parseGoogleReviewNotification(BODY_A, "Maria deixou uma crítica sobre Outro").reviewerName).toBe("Rui Costa");
  });

  it("o texto tira-se pela positiva: entre o nome/estrelas e o 'Responder'; sem os dois limites = sem texto", () => {
    expect(reviewCommentFromEmail(BODY_A, "Rui Costa")).toBe(TEXT_RUI);
    expect(reviewCommentFromEmail(BODY_B, "Rui Costa")).toBe(TEXT_RUI);
    // Só estrelas + rodapé desconhecido (com e sem o botão) → sem texto.
    expect(reviewCommentFromEmail(starsOnly("João", "João Silva"), "João Silva")).toBe("");
    expect(reviewCommentFromEmail(starsOnly("João", "João Silva", false), "João Silva")).toBe("");
    // "Este utilizador deixou apenas uma classificação" → sem texto.
    expect(reviewCommentFromEmail(BODY_A.replace(TEXT_RUI, "Este utilizador deixou apenas uma classificação"), "Rui Costa")).toBe("");
    expect(reviewCommentFromEmail("Bom dia, envio o meu CV.\nObrigado", null)).toBe("");
  });

  it("casos 3412/3413: os dois emails da Google da mesma crítica (um sem nome, sem parque e sem estrelas no leitor antigo) juntam-se", () => {
    const a = emailFacts(storedRow(3412, BODY_A), BODY_A);
    const b = emailFacts(storedRow(3413, BODY_B, { projectId: null, at: "2026-10-10 09:03:00" }), BODY_B);
    expect(b.name).toBe("rui costa");
    expect(b.rating).toBe(5);
    expect(a.textKey).toBe(reviewTextKeyFromApi(TEXT_RUI));
    expect(sameReview(a, b)).toBe(true);
    expect(findDuplicateOf(b, [a])).toBe(3412);
    expect(planDuplicateCleanup([cleanupRow(a), cleanupRow(b)]).mark).toEqual([{ id: 3413, duplicateOf: 3412 }]);
  });

  it("casos 3407/3408: o mesmo email repetido (outro Message-ID, nome curto num e completo no outro) junta-se", () => {
    const body = BODY_A.replace(/Rui/g, "Marta").replace("Marta Costa", "Marta Silva");
    const a = emailFacts(storedRow(3407, body, { reviewerName: "Marta", at: "2026-10-09 18:00:00" }), body);
    const b = emailFacts(storedRow(3408, body, { reviewerName: "Marta Silva", at: "2026-10-09 18:40:00" }), body);
    expect(planDuplicateCleanup([cleanupRow(a), cleanupRow(b)]).mark).toEqual([{ id: 3408, duplicateOf: 3407 }]);
  });

  it("rodapé desconhecido em críticas só de estrelas → NÃO junta (nem entrada, nem limpeza)", () => {
    const s1 = starsOnly("João", "João Silva");
    const s2 = starsOnly("João", "João Pereira");
    const a = emailFacts(storedRow(1, s1, { reviewerName: "João Silva" }), s1);
    const b = emailFacts(storedRow(2, s2, { reviewerName: "João Pereira", at: "2026-10-10 10:00:00" }), s2);
    expect(a.textKey).toBe("");
    expect(sameReview(a, b)).toBe(false);
    expect(findDuplicateOf(b, [a])).toBeNull();
    expect(planDuplicateCleanup([cleanupRow(a), cleanupRow(b)]).mark).toEqual([]);
    // O mesmo com o 1.º nome igual e só uma palavra num dos lados: sem texto, nunca junta.
    const s3 = starsOnly("João", "João");
    const c = emailFacts(storedRow(3, s3, { reviewerName: "João" }), s3);
    expect(sameReview(a, c)).toBe(false);
  });

  it("'Excelente serviço, recomendo' de João Silva e de João Pereira → NÃO junta (nome completo e texto genérico)", () => {
    const t = "Excelente serviço, recomendo";
    const b1 = withText("João", "João Silva", t);
    const b2 = withText("João", "João Pereira", t);
    const a = emailFacts(storedRow(1, b1, { reviewerName: "João Silva" }), b1);
    const b = emailFacts(storedRow(2, b2, { reviewerName: "João Pereira", at: "2026-10-10 09:30:00" }), b2);
    expect(a.textKey.length).toBeGreaterThanOrEqual(20);
    expect(namesCompatible(a.name, b.name)).toBe(false);
    expect(sameReview(a, b)).toBe(false);
    // Texto genérico: mesmo uma 2.ª cópia do João Silva não junta sozinha.
    const a2 = { ...a, id: 3 };
    expect(genericTextKeys([a, b, a2]).has(a.textKey)).toBe(true);
    expect(findDuplicateOf(a2, [a, b])).toBeNull();
    expect(planDuplicateCleanup([a, b, a2].map(cleanupRow)).mark).toEqual([]);
    // "Excelente serviço" (17 caracteres) nunca junta, nem com o mesmo nome.
    const short = facts({ id: 7, textKey: reviewTextKeyFromApi("Excelente serviço") });
    expect(sameReview(short, { ...short, id: 8 })).toBe(false);
  });

  it("nomes: 2+ palavras dos dois lados = nome completo; uma palavra num lado = 1.º nome", () => {
    expect(namesCompatible("joao silva", "joao silva")).toBe(true);
    expect(namesCompatible("joao silva", "joao pereira")).toBe(false);
    expect(namesCompatible("joao", "joao pereira")).toBe(true);
    expect(namesCompatible("ana", "joao")).toBe(false);
    expect(namesCompatible(null, "joao")).toBe(false);
    expect(namesCompatible(null, "joao", true)).toBe(true);
    expect(reviewerNameKey("Google Business Profile")).toBeNull();
    expect(reviewerNameKey("Desconhecido")).toBeNull();
  });

  it("sem texto, estrelas diferentes, outro parque, mais de 48 h, nome desconhecido ou duas da API → não junta", () => {
    const base = facts({ id: 1 });
    expect(sameReview(base, { ...base, id: 2, textKey: "" })).toBe(false);
    expect(sameReview(base, { ...base, id: 2, rating: 4 })).toBe(false);
    expect(sameReview(base, { ...base, id: 2, parkKey: "p9" })).toBe(false);
    expect(sameReview(base, { ...base, id: 2, atMs: base.atMs! + 49 * 3_600_000 })).toBe(false);
    expect(sameReview(base, { ...base, id: 2, name: null })).toBe(false);
    expect(sameReview({ ...base, apiKey: true }, { ...base, id: 2, apiKey: true })).toBe(false);
    // Um sem parque (o email não disse) junta.
    expect(sameReview(base, { ...base, id: 2, parkKey: null })).toBe(true);
  });

  it("Windsor ↔ email pelas estrelas + texto: o nome desconhecido do email não impede (fica por conciliar); nomes diferentes impedem", () => {
    const windsor = facts({ id: 10, apiKey: true });
    const email = facts({ id: 11, name: null, parkKey: null });
    expect(sameReview(windsor, email)).toBe(false);
    expect(sameReview(windsor, email, { requireName: false })).toBe(true);
    expect(sameReview(windsor, { ...email, name: "rui pereira" }, { requireName: false })).toBe(false);
  });

  it("limpeza: fica a da API (senão a mais antiga); a desfeita à mão e a com reclamação ficam para uma pessoa", () => {
    const row = (o: Partial<DedupCleanupRow> & { id: number }): DedupCleanupRow => ({ ...facts(o), notAReview: false, duplicateOf: null, markUndone: false, locked: false, ...o });
    const plan = planDuplicateCleanup([
      row({ id: 20 }),
      row({ id: 21, apiKey: true, atMs: facts({ id: 0 }).atMs! + 3_600_000 }),
      row({ id: 22, markUndone: true }),
      row({ id: 23, locked: true }),
      row({ id: 24, duplicateOf: 21 }),
    ]);
    expect(plan.mark).toEqual([{ id: 20, duplicateOf: 21 }]);
    expect(plan.keep.map((k) => k.id).sort()).toEqual([22, 23]);
  });

  it("limpeza em escala: agrupa por (estrelas, texto) — 5000 críticas diferentes acabam depressa", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => cleanupRow(facts({ id: i + 1, name: `pessoa ${i}`, textKey: `texto da critica numero ${i} bastante longo` })));
    const t0 = Date.now();
    expect(planDuplicateCleanup(rows).mark).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("desfazer: a cópia guarda o rascunho, a aprovação e a tentativa de rascunho (a que a marca pôs volta a NULL)", () => {
    const b = parseMarkBackup(JSON.stringify({ aiResponse: "Obrigado!", aiResponseApproved: 1, status: "ai_responded", aiDraftAttemptedAt: null }));
    expect(b).toEqual({ aiResponse: "Obrigado!", aiResponseApproved: 1, status: "ai_responded", aiDraftAttemptedAt: null, hasAttempted: true });
    expect(parseMarkBackup("lixo").hasAttempted).toBe(false);
    const src = readFileSync("server/reviewCleanup.ts", "utf8");
    // A cópia é feita no MESMO UPDATE, antes de limpar o rascunho.
    expect(src.indexOf("reviewMarkBackup = JSON_OBJECT(")).toBeLessThan(src.indexOf("aiResponse = NULL, aiResponseApproved = 0"));
    expect(src).toContain("projectScope(googleReviews.projectId)} ORDER BY id DESC");
  });
});

// ─── Pipeline do email (alias criticas) com os interruptores ────────────────

describe("pipeline criticas@ com REVIEWS_EMAIL_STRICT / REVIEWS_DEDUP", () => {
  const base = (o: any = {}) => ({
    alias: "criticas" as const, messageId: `<m-${Math.random()}@x>`, gmThreadId: null, refs: [], fromName: "Ana", fromEmail: "ana@gmail.com",
    subject: "Candidatura a condutor", receivedAt: "2026-10-14 10:00:00", text: "Bom dia, envio o meu CV em anexo.", html: null, loadAttachments: async () => [], ...o,
  });
  beforeEach(() => {
    h.flags = { REVIEWS_EMAIL_STRICT: false, REVIEWS_DEDUP: false };
    h.created = [];
    h.duplicateOf = null;
    h.dupQueries = [];
    h.autoDraft.mockClear();
  });

  it("desligados: uma candidatura que entrou pelas Críticas ainda vira crítica (como até aqui)", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    const out = await processInboundEmail(base());
    expect(out).toMatchObject({ status: "processed", routed: { targetModule: "review" } });
    expect(h.created).toHaveLength(1);
  });

  it("STRICT: a candidatura segue para a triagem ('not_review', nunca 'ignored') e não cria crítica", async () => {
    h.flags.REVIEWS_EMAIL_STRICT = true;
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    const out = await processInboundEmail(base());
    expect(out).toMatchObject({ status: "processed", routed: { targetModule: "not_review" } });
    expect(h.created).toHaveLength(0);
  });

  it("STRICT: o aviso da Google vira crítica", async () => {
    h.flags.REVIEWS_EMAIL_STRICT = true;
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    const out = await processInboundEmail(base({ fromEmail: "businessprofile-noreply@google.com", subject: SUBJECT_RUI, text: BODY_A }));
    expect(out).toMatchObject({ routed: { targetModule: "review" } });
    expect(h.created[0]).toMatchObject({ rating: 5, reviewerName: "Rui Costa", projectId: 7 });
  });

  it("DEDUP: resumo não vira crítica; repetida fica marcada (guardada) e sem rascunho; lê o assunto", async () => {
    h.flags.REVIEWS_DEDUP = true;
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    const sum = await processInboundEmail(base({ fromEmail: "businessprofile-noreply@google.com", subject: "Recebeu 3 novas críticas", text: "Veja o que os clientes dizem." }));
    expect(sum).toMatchObject({ routed: { targetModule: "review_summary" } });
    expect(h.created).toHaveLength(0);

    h.duplicateOf = 3412;
    await processInboundEmail(base({ fromEmail: "businessprofile-noreply@google.com", subject: SUBJECT_RUI, text: BODY_B }));
    expect(h.created[0]).toMatchObject({ duplicateOf: 3412, rating: 5, projectId: 7, reviewerName: "Rui Costa" });
    expect(h.created[0].aiDraftAttemptedAt).toBeTruthy();
    expect(h.autoDraft).not.toHaveBeenCalled();
    expect(h.dupQueries[0]).toMatchObject({ parkKey: "p7", rating: 5, name: "rui costa", textKey: reviewTextKeyFromApi(TEXT_RUI) });
  });

  it("a triagem das caixas lê o 'not_review' como uma caixa sem pipeline (também no varrimento)", () => {
    const svc = readFileSync("server/mail/service.ts", "utf8");
    expect(svc).toContain('routed?.targetModule === "not_review"');
    // a 2.ª cópia do mesmo Message-ID e a nova tentativa também seguem para a triagem
    expect(svc).toContain('if (row?.targetModule === "not_review")');
    expect(svc).toContain("triageReleasedMessage(messageId)");
    expect(svc).toContain("ctx.releasedFromPipeline ? null");
    const routing = readFileSync("server/commsRouting.ts", "utf8");
    expect(routing).toContain('r.pipelineStatus === "not_review" ? null');
  });

  it("as marcadas saem das listas, dos números e dos rascunhos automáticos", () => {
    const db = readFileSync("server/db.ts", "utf8");
    const list = db.slice(db.indexOf("export async function getGoogleReviews("), db.indexOf("async function withReviewLocationTitles"));
    expect(list).toContain("eq(googleReviews.notAReview, 0), isNull(googleReviews.duplicateOf)");
    const stats = db.slice(db.indexOf("export async function getGoogleReviewStats("));
    expect(stats.slice(0, 900)).toContain("eq(googleReviews.notAReview, 0), isNull(googleReviews.duplicateOf)");
    const draft = readFileSync("server/reviewAutoDraft.ts", "utf8");
    expect(draft).toContain("eq(googleReviews.notAReview, 0),");
    expect(draft).toContain("isNull(googleReviews.duplicateOf),");
  });
});

// ─── W1: WhatsApp dos colaboradores ─────────────────────────────────────────

describe("W1 — não triar com IA as conversas de colaboradores (salvo urgência)", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const g = (o: Partial<Parameters<typeof whatsappTriageGate>[0]>) => whatsappTriageGate({ skipStaff: true, isStaff: false, urgentWords: false, intent: null, lastTriagedAt: null, nowMs: now, ...o });

  it("palavras de urgência (acidente, avaria, roubo…), sem falsos alarmes comuns", () => {
    for (const t of ["Tive um acidente na A1", "o carro avariou", "Roubaram-me a mala", "houve um furto no parque", "bati com o carro", "chamem a polícia", "preciso de reboque", "It's an emergency, my car was stolen"]) {
      expect(whatsappUrgentByWords(t)).toBe(true);
    }
    for (const t of ["Socorro, preciso de ajuda", "Estou preso no parque", "o portão não abre", "a cancela não se abre"]) {
      expect(whatsappUrgentByWords(t)).toBe(true);
    }
    for (const t of ["sim, posso amanhã", "Bom dia, quanto custa?", "carregar a bateria do carro elétrico", "roupa no carro", "sem urgência, quando puderem", "não é urgente", "abre às 6h?"]) {
      expect(whatsappUrgentByWords(t)).toBe(false);
    }
  });

  it("interruptor desligado → sempre (como até aqui)", () => {
    expect(g({ skipStaff: false, isStaff: true, intent: "outro", lastTriagedAt: "2026-10-15 11:00:00" })).toEqual({ triage: true, why: "off" });
  });

  it("clientes: como até hoje (o debounce decide), mesmo lidos há pouco", () => {
    expect(g({ isStaff: false, intent: "reserva", lastTriagedAt: "2026-10-15 11:30:00" })).toEqual({ triage: true, why: "customer" });
    expect(g({ isStaff: false, intent: null })).toEqual({ triage: true, why: "customer" });
  });

  it("colaborador já lido há menos de 24 h → não; com urgência → sim", () => {
    expect(g({ isStaff: true, intent: "recrutamento", lastTriagedAt: "2026-10-15 08:00:00" })).toEqual({ triage: false, why: "staff" });
    expect(g({ isStaff: true, intent: "recrutamento", lastTriagedAt: "2026-10-15 08:00:00", urgentWords: true })).toEqual({ triage: true, why: "urgent" });
  });

  it("colaborador: retria só sem intenção (vazia ou 'outro'), mais de 24 h ou urgência", () => {
    expect(g({ isStaff: true, intent: null })).toMatchObject({ triage: true, why: "no_intent" });
    expect(g({ isStaff: true, intent: "outro", lastTriagedAt: "2026-10-15 11:00:00" })).toMatchObject({ triage: true, why: "no_intent" });
    expect(g({ isStaff: true, intent: "recrutamento", lastTriagedAt: "2026-10-14 11:00:00" })).toMatchObject({ triage: true, why: "stale" });
  });

  it("resposta de disponibilidade já lida pela IA dela → UMA leitura (nem com urgência volta à IA)", () => {
    expect(g({ isStaff: true, urgentWords: true, availabilityAiRead: true })).toEqual({ triage: false, why: "availability_ai" });
    const auto = readFileSync("server/extrasAutomation.ts", "utf8");
    expect(auto).toContain("seen.aiRead = d.action !== \"review\" || !!d.ai;");
    const inbound = readFileSync("server/whatsappInbound.ts", "utf8");
    expect(inbound).toContain("noteInboundForTriage(w.conversationId, Date.now(), { body: m.body, availabilityAiRead })");
  });

  it("colaborador = tem ficha ou caixa RH por regra (não a escolhida à mão)", () => {
    expect(isStaffWhatsappConversation({ employeeId: 3, boxKey: null, boxSource: null })).toBe(true);
    expect(isStaffWhatsappConversation({ employeeId: null, boxKey: "rh", boxSource: "rule" })).toBe(true);
    expect(isStaffWhatsappConversation({ employeeId: null, boxKey: "rh", boxSource: "manual" })).toBe(false);
    expect(isStaffWhatsappConversation({ employeeId: null, boxKey: "reservas", boxSource: "ai" })).toBe(false);
  });
});

// ─── Interruptores e T1 ─────────────────────────────────────────────────────

describe("interruptores do F6b desligados por omissão", () => {
  it("REVIEWS_EMAIL_STRICT, REVIEWS_DEDUP e WA_TRIAGE_SKIP_STAFF", () => {
    for (const f of ["REVIEWS_EMAIL_STRICT", "REVIEWS_DEDUP", "WA_TRIAGE_SKIP_STAFF"]) expect(automationFlagDefault(f)).toBe(false);
  });
  it("ai.thinkingLevels continua vazio por omissão (a mudança é só sugerida)", () => {
    expect((SETTINGS as any)["ai.thinkingLevels"].defaultValue).toEqual({});
    expect((SETTINGS as any)["ai.thinkingLevels"].description).toContain("complaint_triage");
  });
  it("migração 0700 registada (só acrescenta)", () => {
    const m = readFileSync("server/migrations/migration_0700.ts", "utf8");
    expect(m).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
    expect(readFileSync("server/migrations/index.ts", "utf8")).toContain('["0700"');
  });
});

describe("T1 — 'minimal' só onde há avaliação", () => {
  it("sugestão só para email, WhatsApp e reclamações", () => {
    expect(Object.keys(AI_THINKING_SUGGESTED).sort()).toEqual(["complaint_triage", "mail_routing", "whatsapp_triage"]);
    expect(suggestedThinkingSetting(["whatsapp_triage"], { assistant: "low" })).toEqual({ assistant: "low", whatsapp_triage: "minimal" });
  });
  it("veredicto: passa as metas, não falha mais e acerta no máximo 1 a menos", () => {
    const today = { passes: true, correct: 22, total: 24, failed: 0 };
    expect(thinkingLevelVerdict(today, { ...today, correct: 21 }).ok).toBe(true);
    expect(thinkingLevelVerdict(today, { ...today, correct: 20 }).ok).toBe(false);
    expect(thinkingLevelVerdict(today, { ...today, failed: 1 }).ok).toBe(false);
    expect(thinkingLevelVerdict(today, { ...today, passes: false }).ok).toBe(false);
  });
  it("avaliação do WhatsApp: um classificador que acerta tudo passa; um que diz sempre 'outro' não", async () => {
    const perfect = await evalWhatsappTriage({}, {
      classify: async (t) => {
        const c = WHATSAPP_TRIAGE_CORPUS.find((x) => t.includes(x.messages[x.messages.length - 1].body.replace(/\s+/g, " ").trim()))!;
        return { intent: c.intents[0], urgency: c.urgency };
      },
    });
    expect(perfect.metrics.total).toBe(WHATSAPP_TRIAGE_CORPUS.length);
    expect(perfect.metrics.passes).toBe(true);
    const lazy = await evalWhatsappTriage({}, { classify: async () => ({ intent: "outro", urgency: "normal" }) });
    expect(lazy.metrics.passes).toBe(false);
    const broken = await evalWhatsappTriage({ limit: 3 }, { classify: async () => { throw Object.assign(new Error("x"), { code: "timeout" }); } });
    expect(broken.metrics.failed).toBe(3);
    expect(whatsappEvalMetrics([]).passes).toBe(false);
  });
  it("avaliação das reclamações: acerta tudo → passa; uma urgente como 'medium' → não passa", async () => {
    const perfect = await evalComplaintTriage({}, { classify: async (c) => ({ type: c.types[0], priority: c.priorities[0] }) });
    expect(perfect.metrics.total).toBe(COMPLAINT_TRIAGE_CORPUS.length);
    expect(perfect.metrics.passes).toBe(true);
    const missed = await evalComplaintTriage({}, { classify: async (c) => ({ type: c.types[0], priority: c.urgent && c.id === "rc-06" ? "medium" : c.priorities[0] }) });
    expect(missed.metrics.missedUrgent).toBe(1);
    expect(missed.metrics.passes).toBe(false);
  });
});
