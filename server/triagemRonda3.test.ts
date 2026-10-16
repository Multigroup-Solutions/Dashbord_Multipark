/**
 * Triagem dos emails — ronda 3 da auditoria (verificação final, 14 out 2026).
 *
 *  - o sim/não da IA dá SEMPRE "Por confirmar" (mesmo com os dois limiares
 *    iguais nas Definições) — na decisão, na porta do caso e no "Testar a
 *    triagem";
 *  - o email do parceiro também não entra pelo corpo (assinatura, colega em
 *    cópia) — nem como o do cliente nem para juntar casos;
 *  - HTML enorme ou muito aninhado não bloqueia a sincronização (teto linear
 *    antes de converter); os dados pessoais continuam tapados antes da IA;
 *  - as respostas dadas à mão ao script passam pelo esquema da produção;
 *  - o aviso do perdido aberto pela IA vai à cidade do caso.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  claimed: new Set<string>(),
  complaints: [] as any[],
  lost: [] as any[],
  autoAck: vi.fn(async () => ({ sent: true })),
  sendMail: vi.fn(async () => ({ ok: true })),
  bySignals: vi.fn(async (..._a: any[]) => null as any),
  openLost: vi.fn(async (..._a: any[]) => null as any),
  matchBooking: vi.fn(async (..._a: any[]) => null as any),
}));

vi.mock("./db", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    getDb: async () => null,
    logActivity: async () => {},
    claimInboundEmail: vi.fn(async (d: any) => (h.claimed.has(d.messageId) ? null : (h.claimed.add(d.messageId), h.claimed.size))),
    updateInboundEmail: vi.fn(async () => {}),
    deleteInboundEmail: vi.fn(async () => {}),
    createComplaint: vi.fn(async (d: any) => { h.complaints.push(d); return 900 + h.complaints.length; }),
    addComplaintMessage: vi.fn(async () => 1),
    addComplaintPhoto: vi.fn(async () => 1),
    updateComplaint: vi.fn(async () => {}),
    getComplaintById: vi.fn(async (id: number) => ({ id, projectId: 1, complaintStatus: "new", clientEmail: null, reservationRef: null })),
    findComplaintByClientSignals: h.bySignals,
    findComplaintByThread: vi.fn(async () => null),
    findOpenComplaintBySubject: vi.fn(async () => null),
    findOpenComplaintByBookingRef: vi.fn(async () => null),
    createLostFoundItem: vi.fn(async (d: any) => { h.lost.push(d); return 400 + h.lost.length; }),
    addLostFoundMessage: vi.fn(async () => 1),
    findOpenLostFoundByClient: h.openLost,
    getLostFoundItemById: vi.fn(async (id: number) => ({ id, projectId: 2, clientEmail: null, bookingRef: "b" })),
    getSystemUserId: vi.fn(async () => 1),
    getInboundEmailByMessageId: vi.fn(async () => null),
  };
});
vi.mock("./complaintDossier", async (orig) => ({
  ...(await orig<object>()),
  matchBookingForComplaint: h.matchBooking,
  autoLinkComplaintBooking: vi.fn(async () => ({ linked: false })),
  autoLinkLostFoundBooking: vi.fn(async () => ({ linked: false })),
}));
vi.mock("./complaintsExtended", async (orig) => ({ ...(await orig<object>()), notifyComplaintCreated: vi.fn(async () => {}), sendComplaintAutoAck: h.autoAck }));
vi.mock("./mail/systemMail", async (orig) => ({ ...(await orig<object>()), sendEmailDetailed: h.sendMail, sendEmail: h.sendMail }));

import { COMPLAINT_INTAKE_DEFAULTS, partnerSafeClientEmail, type IntakeFacts } from "../shared/complaintIntake";
import { ALL_TRIAGE_FEATURES, caseScoresOf, decideMailTriage } from "../shared/mailTriage";
import { INBOUND_HTML_MAX, READABLE_HTML_MAX, boundedHtmlToText, readableMailText, stripHtmlNoise } from "./complaintEmail";
import { classifyAndApply, mailRoutingRequest, type EmailRoutingDeps, type EmailRoutingMessage } from "./commsRouting";
import { intakeFromRouting, type IntakeDeps, type IntakeMessage, type IntakeVerdict } from "./complaintMailIntake";
import { evalCorpusItem, parseOfflineAnswer } from "./mailTriageEval";
import { TRIAGE_BLIND } from "./fixtures/mailTriageBlind";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const ACTIVE = new Set(["info", "rh", "reservas", "alteracoes", "cancelamentos", "servicos_extra", "reclamacoes", "perdidos", "parcerias", "faturacao", "criticas", "ocorrencias"]);
const FACTS = { sender: "external" as const, forwardedExternal: false, newThread: true, mode: "sync" as const };
const DEFAULT_T = { minConfidence: 0.7, createMinConfidence: 0.85, suggestMinConfidence: 0.5 };
/** Definições permitidas (suggest ≤ create): sem banda "Por confirmar". */
const EQUAL_T = { minConfidence: 0.7, createMinConfidence: 0.85, suggestMinConfidence: 0.85 };

beforeEach(() => {
  h.claimed.clear();
  h.complaints = [];
  h.lost = [];
  for (const f of [h.autoAck, h.sendMail, h.bySignals, h.openLost, h.matchBooking]) f.mockClear();
  h.bySignals.mockImplementation(async () => null);
  h.openLost.mockImplementation(async () => null);
  h.matchBooking.mockImplementation(async () => null);
});

// ─── O sim/não da IA é sempre "Por confirmar" ────────────────────────────────

describe("um 'sim' da IA com pouca certeza dá exatamente 'Por confirmar' (nunca um caso confirmado)", () => {
  it("decisão: com os limiares de omissão e com os dois limiares iguais", () => {
    const out = { box: "faturacao", confidence: 0.9, complaintMentioned: true, complaint: 0 };
    expect(decideMailTriage(out, FACTS, DEFAULT_T, ALL_TRIAGE_FEATURES, ACTIVE)).toMatchObject({ caseKind: "complaint", caseScore: 0.5, uncertain: true });
    // suggest = create (permitido nas Definições): o sim levava a certeza a 0,85 = confirmada — agora não
    expect(decideMailTriage(out, FACTS, EQUAL_T, ALL_TRIAGE_FEATURES, ACTIVE)).toMatchObject({ caseKind: "complaint", caseScore: 0.85, uncertain: true });
    const lost = { box: "criticas", confidence: 0.9, lostItemMentioned: true, lostItem: 0.2 };
    expect(decideMailTriage(lost, FACTS, EQUAL_T, ALL_TRIAGE_FEATURES, ACTIVE)).toMatchObject({ caseKind: "lost_found", uncertain: true });
    // a certeza da própria IA (ou da caixa do caso) continua a confirmar
    expect(decideMailTriage({ ...out, complaint: 0.9 }, FACTS, EQUAL_T, ALL_TRIAGE_FEATURES, ACTIVE)).toMatchObject({ caseKind: "complaint", uncertain: false });
    expect(decideMailTriage({ box: "reclamacoes", confidence: 0.92, complaintMentioned: true, complaint: 0 }, FACTS, EQUAL_T, ALL_TRIAGE_FEATURES, ACTIVE))
      .toMatchObject({ caseKind: "complaint", uncertain: false });
  });
  it("caseScoresOf diz quando a certeza veio só do sim/não", () => {
    expect(caseScoresOf({ complaintMentioned: true, complaint: 0.1 }, EQUAL_T)).toMatchObject({ complaintScore: 0.85, complaintFloored: true, lostFloored: false });
    expect(caseScoresOf({ complaintMentioned: true, complaint: 0.9 }, EQUAL_T)).toMatchObject({ complaintScore: 0.9, complaintFloored: false });
    expect(caseScoresOf({ complaint: 0.1 }, EQUAL_T)).toMatchObject({ complaintScore: 0.1, complaintFloored: false });
  });
  it("a leitura passa o 'Por confirmar' à porta do caso", async () => {
    const verdicts: IntakeVerdict[] = [];
    const deps: EmailRoutingDeps = {
      enabled: async () => true, settings: async () => ({ minConfidence: 0.7, perRun: 10 } as any),
      caseSettings: async () => ({ createMinConfidence: 0.85, suggestMinConfidence: 0.85 }), features: async () => ALL_TRIAGE_FEATURES,
      boxes: async () => [...ACTIVE].map((key) => ({ key, label: key, active: true } as any)), claim: async () => true,
      classify: async () => ({ output: { box: "faturacao", confidence: 0.9, complaintMentioned: true, complaint: 0.1, lostItemMentioned: false, lostItem: 0, reason: "fatura e carro sujo" } as any, restore: (s: string) => s }),
      move: async () => true, record: async () => {}, firstContact: async () => ({} as any), cityProjectId: async () => null, afterRh: async () => {},
      caseIntake: async (_m, v) => { verdicts.push(v); return { status: "created", complaintId: 1 }; },
    };
    const msg: EmailRoutingMessage = { threadId: 1, messageId: 2, fromBoxKey: "info", subject: "Fatura", text: "Queria a fatura. Já agora, o carro veio sujo.", fromName: "Ana", fromEmail: "ana@gmail.com", attachmentNames: [], projectId: null, senderKind: "external", newThread: true };
    await classifyAndApply(msg, deps);
    expect(verdicts[0]).toMatchObject({ kind: "complaint", confidence: 0.85, uncertain: true });
  });
  it("a porta do caso respeita o 'Por confirmar' que vem da leitura (mesmo com a certeza no limiar)", async () => {
    const calls = { claim: [] as any[], create: [] as any[] };
    const facts: IntakeFacts & { boxLabel: string } = {
      fromBoxKey: "info", fromBoxPipeline: null, outbound: false, automated: false, systemMail: false, personal: false,
      senderIsCompany: false, senderIsAutomated: false, senderIsPartner: false, subject: "x", text: "x", senderEmail: "ana@gmail.com", boxLabel: "Info",
    };
    const deps: IntakeDeps = {
      enabled: async () => true, settings: async () => ({ createMinConfidence: 0.85, suggestMinConfidence: 0.85 }), facts: async () => facts,
      claim: async (r) => { calls.claim.push(r); return true; }, record: async () => {},
      createOrLink: async (i) => { calls.create.push(i); return { complaintId: 3, isNew: true }; },
    };
    const MSG: IntakeMessage = { threadId: 1, messageId: 2, fromBoxKey: "info", subject: "x", text: "x", fromName: "Ana", fromEmail: "ana@gmail.com", projectId: null };
    await intakeFromRouting(MSG, { kind: "complaint", aiBoxKey: "faturacao", confidence: 0.85, reason: "x", uncertain: true }, deps);
    expect(calls.claim[0]).toMatchObject({ status: "creating", uncertain: true });
    expect(calls.create[0]).toMatchObject({ uncertain: true });
    // sem o aviso da leitura, 0,85 com os limiares iguais é confirmada (como sempre)
    calls.claim = []; calls.create = [];
    await intakeFromRouting(MSG, { kind: "complaint", aiBoxKey: "reclamacoes", confidence: 0.85, reason: "x" }, deps);
    expect(calls.create[0].uncertain).toBe(false);
  });
  it("o 'Testar a triagem' mede o mesmo", async () => {
    const item = TRIAGE_BLIND.find((c) => c.expected === "reclamacoes" && !c.partner && c.box === "info") ?? TRIAGE_BLIND.find((c) => c.expected === "reclamacoes" && !c.partner && c.box !== "reclamacoes")!;
    const r = await evalCorpusItem(item, async () => ({ output: { box: "info", confidence: 0.9, complaintMentioned: true, complaint: 0.1, reason: "x" }, restore: (s: string) => s }) as any, EQUAL_T);
    expect(r).toMatchObject({ predicted: "reclamacoes", caseKind: "complaint", uncertain: true });
  });
});

// ─── Parceiro: o email dele também não entra pelo corpo ──────────────────────

describe("parceiro em nome do cliente: o email do parceiro nunca entra pelo corpo", () => {
  it("partnerSafeClientEmail: tira o endereço e o domínio de empresa do parceiro; num webmail só o endereço exato", () => {
    const p = "bookings@sunwaytravel.co.uk";
    expect(partnerSafeClientEmail("bookings@sunwaytravel.co.uk", p)).toBeUndefined();
    expect(partnerSafeClientEmail("BOOKINGS@SunwayTravel.co.uk", p)).toBeUndefined();
    expect(partnerSafeClientEmail("ops@sunwaytravel.co.uk", p)).toBeUndefined();
    expect(partnerSafeClientEmail("hughes@gmail.com", p)).toBe("hughes@gmail.com");
    expect(partnerSafeClientEmail("ana@gmail.com", "agencia.sol@gmail.com")).toBe("ana@gmail.com");
    expect(partnerSafeClientEmail("agencia.sol@gmail.com", "agencia.sol@gmail.com")).toBeUndefined();
    expect(partnerSafeClientEmail(null, p)).toBeUndefined();
    expect(partnerSafeClientEmail("x@empresa.pt", null)).toBe("x@empresa.pt");
  });
  const partnerMail = (over: Record<string, unknown> = {}) => ({
    alias: "reclamacoes" as const, messageId: `<r3-${Math.random()}@x>`, gmThreadId: "9", refs: [], fromName: "Sunway Travel", fromEmail: "bookings@sunwaytravel.co.uk",
    subject: "Client feedback", receivedAt: "2026-10-14 10:00:00",
    text: "Our client Mr. Hughes says his car came back with 340 km more.\n\nKind regards,\nSunway Travel | Reservations\nbookings@sunwaytravel.co.uk | cc ops@sunwaytravel.co.uk",
    html: null, loadAttachments: async () => [], aiIntake: { actorId: null, uncertain: true, partnerSender: true }, ...over,
  });
  it("reclamação: a assinatura do parceiro não fica como o email do cliente nem junta à reclamação de outro cliente da agência", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    h.bySignals.mockImplementation(async (email: any) => (email ? { id: 55, clientEmail: email } : null));
    const out = await processInboundEmail(partnerMail() as any);
    expect(out).toMatchObject({ status: "processed", routed: { targetModule: "complaint", isNew: true } });
    expect(h.complaints[0].clientEmail).toBeUndefined();
    expect(h.complaints[0]).toMatchObject({ origin: "ia", aiUnconfirmed: 1 });
    for (const call of h.bySignals.mock.calls) expect(String(call[0] ?? "")).not.toMatch(/sunwaytravel/);
    for (const call of h.matchBooking.mock.calls) expect(String(call[0]?.clientEmail ?? "")).not.toMatch(/sunwaytravel/);
    expect(h.autoAck).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  it("o email do cliente que o parceiro escreve no corpo continua a contar", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    const out = await processInboundEmail(partnerMail({ text: "Nome: John Hughes\nEmail: hughes@gmail.com\n\nThe car came back scratched.\n\nSunway Travel | bookings@sunwaytravel.co.uk" }) as any);
    expect(out).toMatchObject({ routed: { targetModule: "complaint", isNew: true } });
    expect(h.complaints[0].clientEmail).toBe("hughes@gmail.com");
  });
  it("perdido: o mesmo (nem email do parceiro no caso, nem junta pelo email dele)", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    h.openLost.mockImplementation(async (email: any) => (email ? { id: 77, clientEmail: email, createdAt: new Date().toISOString() } : null));
    const out = await processInboundEmail(partnerMail({ alias: "perdidos", subject: "Item left in car", text: "Our client left a jacket in the car.\n\nSunway Travel\nbookings@sunwaytravel.co.uk" }) as any);
    expect(out).toMatchObject({ routed: { targetModule: "lostfound", isNew: true } });
    expect(h.lost[0].clientEmail).toBeUndefined();
    for (const call of h.openLost.mock.calls) expect(String(call[0] ?? "")).not.toMatch(/sunwaytravel/);
  });
  it("quem não é parceiro: o email do corpo conta como antes", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    await processInboundEmail(partnerMail({ fromEmail: "ana@gmail.com", fromName: "Ana Lopes", text: "O meu marido escreve de rui@empresa.pt — o carro veio sujo.", aiIntake: { actorId: null } }) as any);
    expect(h.complaints[0].clientEmail).toBe("rui@empresa.pt");
  });
});

// ─── HTML enorme / malicioso ─────────────────────────────────────────────────

describe("HTML enorme ou muito aninhado não bloqueia a leitura", () => {
  it("stripHtmlNoise (linear): tira comentários, <head>, <style> e <script> (sem fecho → até ao fim); <header> fica", () => {
    expect(stripHtmlNoise("<html><HEAD><title>x</title></head><body><!-- c --><STYLE>p{}</style><p>Olá</p><script>alert(1)</script><header>Topo</header></body></html>"))
      .toBe("<html><body><p>Olá</p><header>Topo</header></body></html>");
    expect(stripHtmlNoise("<p>a</p><style>p{color:red}")).toBe("<p>a</p>");
    expect(stripHtmlNoise("<p>a</p><!-- sem fecho")).toBe("<p>a</p>");
    expect(stripHtmlNoise("a < b e c > d")).toBe("a < b e c > d");
  });
  it("1 MB de <div> encadeados: a triagem e o pipeline acabam depressa (antes ~19 s a bloquear)", () => {
    const nested = "<div>".repeat(200_000) + "texto";
    let t = Date.now();
    readableMailText({ text: "", html: nested, snippet: "resumo" });
    expect(Date.now() - t).toBeLessThan(5_000);
    t = Date.now();
    boundedHtmlToText(nested, INBOUND_HTML_MAX);
    expect(Date.now() - t).toBeLessThan(8_000);
    expect(READABLE_HTML_MAX).toBeLessThanOrEqual(100_000);
    expect(INBOUND_HTML_MAX).toBeLessThanOrEqual(150_000);
  });
  it("um <head> com 1 MB de estilos não esconde o texto (tira-se antes de cortar)", () => {
    const html = `<html><head><style>${"a{color:red}".repeat(80_000)}</style></head><body><p>Bom dia, o carro veio riscado.</p></body></html>`;
    expect(readableMailText({ text: "", html, snippet: "" })).toBe("Bom dia, o carro veio riscado.");
    // <style> sem fecho repetido (o recurso de expressões antigo voltava atrás sem fim)
    expect(readableMailText({ text: null, html: "<style>".repeat(150_000), snippet: "só o resumo" })).toBe("só o resumo");
  });
  it("os dados pessoais do texto que vem do HTML continuam tapados antes da IA", async () => {
    const text = readableMailText({ text: "", html: "<p>Sou a Ana, ana.lopes@gmail.com, 912345678. Matrícula AA-12-BB.</p><p>O carro veio sujo.</p>", snippet: "" });
    const req = await mailRoutingRequest({ subject: "Queixa", text, fromName: "Ana Lopes", senderKind: "external", attachmentNames: [] }, "Info");
    expect(req.input).not.toContain("ana.lopes@gmail.com");
    expect(req.input).not.toContain("912345678");
    expect(req.input).toContain("O carro veio sujo.");
  });
  it("o pipeline das caixas usa o teto (e só converte o HTML quando não há texto simples)", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    const t = Date.now();
    const out = await processInboundEmail({
      alias: "reclamacoes", messageId: `<html-${Math.random()}@x>`, gmThreadId: "1", refs: [], fromName: "Ana Lopes", fromEmail: "ana@gmail.com",
      subject: "Queixa", receivedAt: "2026-10-14 10:00:00", text: null, html: "<div>".repeat(200_000) + "texto", loadAttachments: async () => [],
    } as any);
    expect(Date.now() - t).toBeLessThan(8_000);
    expect(out.status).toBe("processed");
    const s = src("server/jobs/emailInboundSync.ts");
    expect(s).toContain("boundedHtmlToText(input.html, INBOUND_HTML_MAX)");
    expect(s).not.toMatch(/htmlToPlainText\(input\.html\)/);
  });
});

// ─── Script offline: o mesmo esquema da produção ─────────────────────────────

describe("respostas dadas à mão ao script passam pelo esquema da produção", () => {
  it("'true' vale sim; campos em falta valem 0 / não; fora do formato = a IA falhou", () => {
    expect(parseOfflineAnswer({ box: "info", confidence: 0.9, reason: "x", complaintMentioned: "true" })).toMatchObject({ complaintMentioned: true, lostItemMentioned: false, complaint: 0 });
    expect(() => parseOfflineAnswer({ confidence: 0.9, reason: "x" })).toThrow();
    try { parseOfflineAnswer({ box: "info", confidence: "alta", reason: "x" }); } catch (e: any) { expect(e.code).toBe("invalid_output"); }
    expect(src("scripts/eval-mail-triage.ts")).toContain("output: parseOfflineAnswer(out)");
  });
});

// ─── Aviso do perdido: a cidade do caso ──────────────────────────────────────

describe("o aviso do perdido aberto pela IA vai a quem vê a caixa Perdidos na cidade do caso", () => {
  it("relê a cidade da conversa (dada pelo caso) quando ainda não a tinha; a reclamação continua sem 2.º aviso", () => {
    const svc = src("server/mail/service.ts");
    expect(svc).toContain('if ((r.status === "created" || r.status === "linked") && "lostFoundId" in r) aiLostFound = true;');
    expect(svc).toContain("if (aiLostFound && projectId == null)");
    expect(svc.indexOf("if (aiLostFound && projectId == null)")).toBeLessThan(svc.indexOf("await notifyNewMail(e, noticeBox, projectId)"));
    // 15 out 2026: + o email da criticas@ que ficou só na caixa (importação desligada) — como quando criava a crítica.
    expect(svc).toContain("if (fresh && noticeBox?.notify && !createdCase && !aiComplaint && !ownerNotified && !stayedAsReviewMail)");
  });
});
