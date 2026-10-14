/**
 * Triagem dos emails — ronda 2 da auditoria (14 out 2026).
 *
 *  - o corpus CEGO (escrito antes de ler os outros) entra no "Testar a
 *    triagem" e no script, com os parceiros marcados;
 *  - o sim/não "há uma queixa / um objeto em qualquer parte do email" vale
 *    pelo menos "Por confirmar" (um modelo pequeno vê a queixa de passagem mas
 *    dá-lhe pouca certeza);
 *  - parceiros em nome de um cliente (interruptor próprio, desligado);
 *  - emails só em HTML; resposta por baixo da citação;
 *  - o perdido já ligado à conversa recebe a mensagem seguinte (nunca outro caso);
 *  - o filtro "Por confirmar (IA)".
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: null as any,
  claimed: new Set<string>(),
  complaints: [] as any[],
  lost: [] as any[],
  complaintMsgs: [] as any[],
  lostMsgs: [] as any[],
  autoAck: vi.fn(async () => ({ sent: true })),
  notifyCreated: vi.fn(async () => {}),
  sendMail: vi.fn(async () => ({ ok: true })),
  bySignals: vi.fn(async (..._a: any[]) => null as any),
  openLost: vi.fn(async (..._a: any[]) => null as any),
}));

vi.mock("./db", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    getDb: async () => h.db,
    logActivity: async () => {},
    claimInboundEmail: vi.fn(async (d: any) => (h.claimed.has(d.messageId) ? null : (h.claimed.add(d.messageId), h.claimed.size))),
    updateInboundEmail: vi.fn(async () => {}),
    deleteInboundEmail: vi.fn(async () => {}),
    createComplaint: vi.fn(async (d: any) => { h.complaints.push(d); return 900 + h.complaints.length; }),
    addComplaintMessage: vi.fn(async (m: any) => { h.complaintMsgs.push(m); return 1; }),
    addComplaintPhoto: vi.fn(async () => 1),
    updateComplaint: vi.fn(async () => {}),
    getComplaintById: vi.fn(async (id: number) => ({ id, projectId: 1, complaintStatus: "new", clientEmail: null, reservationRef: null })),
    findComplaintByClientSignals: h.bySignals,
    findComplaintByThread: vi.fn(async () => null),
    findOpenComplaintBySubject: vi.fn(async () => null),
    findOpenComplaintByBookingRef: vi.fn(async () => null),
    createLostFoundItem: vi.fn(async (d: any) => { h.lost.push(d); return 400 + h.lost.length; }),
    addLostFoundMessage: vi.fn(async (m: any) => { h.lostMsgs.push(m); return 1; }),
    findOpenLostFoundByClient: h.openLost,
    getLostFoundItemById: vi.fn(async (id: number) => ({ id, projectId: 2, clientEmail: null, bookingRef: "b" })),
    getSystemUserId: vi.fn(async () => 1),
    getInboundEmailByMessageId: vi.fn(async () => null),
  };
});
vi.mock("./complaintDossier", async (orig) => ({
  ...(await orig<object>()),
  matchBookingForComplaint: vi.fn(async () => null),
  autoLinkComplaintBooking: vi.fn(async () => ({ linked: false })),
  autoLinkLostFoundBooking: vi.fn(async () => ({ linked: false })),
}));
vi.mock("./complaintsExtended", async (orig) => ({ ...(await orig<object>()), notifyComplaintCreated: h.notifyCreated, sendComplaintAutoAck: h.autoAck }));
vi.mock("./mail/systemMail", async (orig) => ({ ...(await orig<object>()), sendEmailDetailed: h.sendMail, sendEmail: h.sendMail }));

import {
  COMPLAINT_INTAKE_DEFAULTS, PARTNER_CASES_FLAG, caseIntakeDecision, intakeNote, type IntakeFacts,
} from "../shared/complaintIntake";
import {
  ALL_TRIAGE_FEATURES, TRIAGE_CORPUS_KEYS, aliasGateIsNoise, caseScoresOf, decideMailTriage, parseTriageCategory, splitQuotedText,
} from "../shared/mailTriage";
import { COMPLAINT_AI_UNCONFIRMED_FILTER, filterComplaintRows } from "../shared/complaintFilters";
import { AUTOMATION_FLAGS, automationFlagDefault } from "../shared/appSettings";
import { MAIL_ROUTING_SYSTEM, mailRoutingSchema } from "./_core/ai/prompts/comms";
import { toProviderJsonSchema } from "./_core/ai/jsonSchema";
import { readableMailText } from "./complaintEmail";
import { mailRoutingRequest, runMailBackfill } from "./commsRouting";
import { createFakeDb } from "./_core/ai/testUtils";
import { intakeFromRouting, type IntakeDeps, type IntakeMessage } from "./complaintMailIntake";
import { TRIAGE_BLIND } from "./fixtures/mailTriageBlind";
import { TRIAGE_CORPUS } from "./fixtures/mailTriageCorpus";
import { TRIAGE_HOLDOUT } from "./fixtures/mailTriageHoldout";
import { TRIAGE_CORPORA, corpusFacts, evalCorpusItem, evalTriageSlice, triageEvalReport } from "./mailTriageEval";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const T = { minConfidence: 0.7, createMinConfidence: 0.85, suggestMinConfidence: 0.5 };
const ACTIVE = new Set(["info", "rh", "reservas", "alteracoes", "cancelamentos", "servicos_extra", "reclamacoes", "perdidos", "parcerias", "faturacao", "criticas", "ocorrencias"]);

beforeEach(() => {
  h.db = null;
  h.claimed.clear();
  h.complaints = [];
  h.lost = [];
  h.complaintMsgs = [];
  h.lostMsgs = [];
  for (const f of [h.autoAck, h.notifyCreated, h.sendMail, h.bySignals, h.openLost]) f.mockClear();
  h.bySignals.mockImplementation(async () => null);
  h.openLost.mockImplementation(async () => null);
});

// ─── O corpus cego ───────────────────────────────────────────────────────────

describe("corpus cego (ronda 2): escrito antes de ler os outros, entra na avaliação", () => {
  it("60 emails, ids próprios, rótulos válidos; ≥ 25 reclamações (≥ 12 escondidas), ≥ 10 perdidos; PT-PT, EN, ES, FR e um PT-BR", () => {
    expect(TRIAGE_BLIND).toHaveLength(60);
    const ids = TRIAGE_BLIND.map((c) => c.id);
    expect(new Set(ids).size).toBe(60);
    for (const c of TRIAGE_BLIND) {
      expect(c.id, c.id).toMatch(/^cg\d\d$/);
      expect(parseTriageCategory(c.expected), c.id).toBe(c.expected);
      expect([...TRIAGE_CORPUS, ...TRIAGE_HOLDOUT].some((x) => x.id === c.id), c.id).toBe(false);
    }
    const n = (k: string) => TRIAGE_BLIND.filter((c) => c.expected === k).length;
    expect(n("reclamacoes")).toBeGreaterThanOrEqual(25);
    expect(n("perdidos")).toBeGreaterThanOrEqual(10);
    const hidden = TRIAGE_BLIND.filter((c) => c.expected === "reclamacoes" && /escondid|irónic|curta|foto|uma linha|parceiro|agência|hotel|reencaminh|cadeia|calma|assunto vazio/i.test(c.note ?? ""));
    expect(hidden.length).toBeGreaterThanOrEqual(12);
    expect(new Set(TRIAGE_BLIND.map((c) => c.lang))).toEqual(new Set(["pt", "en", "es", "fr"]));
    expect(TRIAGE_BLIND.some((c) => /PT-BR/.test(c.note ?? ""))).toBe(true);
    // o que não é caso também lá está (precisão)
    for (const k of ["alteracoes", "reservas", "criticas", "faturacao", "rh", "ocorrencias", "ruido"]) expect(n(k), k).toBeGreaterThan(0);
    // os parceiros em nome do cliente estão marcados (o pior caso para a meta)
    expect(TRIAGE_BLIND.filter((c) => c.partner).map((c) => c.id)).toEqual(["cg08", "cg09", "cg24", "cg33"]);
  });
  it("está no 'Testar a triagem' (servidor, ecrã) e no script, pela mesma lista de corpora", () => {
    expect(TRIAGE_CORPUS_KEYS).toEqual(["principal", "controlo", "cego"]);
    expect(TRIAGE_CORPORA.cego).toBe(TRIAGE_BLIND);
    const router = src("server/settingsRouter.ts");
    expect(router.match(/corpus: z\.enum\(TRIAGE_CORPUS_KEYS\)/g)?.length).toBe(2);
    const card = src("client/src/components/mail/MailTriageEvalCard.tsx");
    expect(card).toContain("TRIAGE_CORPUS_KEYS.map((key) => ({ key, label: TRIAGE_CORPUS_LABELS[key] }))");
    expect(src("scripts/eval-mail-triage.ts")).toContain('"cego" = o da auditoria');
  });
  it("com a IA a acertar tudo, o cego passa (os parceiros contam com os interruptores ligados)", async () => {
    const perfect = async (m: any) => {
      const item = TRIAGE_BLIND.find((c) => c.subject === m.subject && c.body === m.text)!;
      const k = item.expected;
      return { output: { box: k, confidence: 0.95, reason: "ok", complaint: k === "reclamacoes" ? 0.95 : 0, lostItem: k === "perdidos" ? 0.95 : 0 }, restore: (s: string) => s } as any;
    };
    const rows = [];
    for (let off = 0; off < TRIAGE_BLIND.length; off += 12) rows.push(...(await evalTriageSlice({ offset: off, limit: 12, corpus: "cego" }, { classify: perfect, thresholds: T })).items);
    const m = triageEvalReport({ rows, corpus: "cego" }, undefined, () => {});
    expect(m).toMatchObject({ passes: true, recallComplaints: 1, recallLostFound: 1, missing: 0 });
    // o parceiro abre o caso, mas sempre "Por confirmar"
    const partner = rows.find((r) => r.id === "cg08")!;
    expect(partner).toMatchObject({ predicted: "reclamacoes", caseKind: "complaint", uncertain: true });
  });
  it("os factos do parceiro chegam à porta do caso (como em produção)", async () => {
    const cg08 = TRIAGE_BLIND.find((c) => c.id === "cg08")!;
    const r = await evalCorpusItem({ ...cg08, partner: undefined }, async () => ({ output: { box: "reclamacoes", confidence: 0.95, complaint: 0.95, reason: "x" }, restore: (s: string) => s }) as any, T);
    expect(r).toMatchObject({ caseKind: "complaint", uncertain: false });
    expect(corpusFacts(cg08).msg.senderKind).toBe("external");
  });
});

// ─── O sim/não da IA ─────────────────────────────────────────────────────────

describe("'há uma queixa / um objeto em qualquer parte do email' vale pelo menos 'Por confirmar'", () => {
  const facts = { sender: "external" as const, forwardedExternal: false, newThread: true, mode: "sync" as const };
  it("queixa escondida num pedido de fatura: o modelo vê-a (sim) mas dá-lhe 0,3 → reclamação Por confirmar; a conversa vai para a caixa do caso", () => {
    const d = decideMailTriage({ box: "faturacao", confidence: 0.85, complaintMentioned: true, complaint: 0.3 }, facts, T, ALL_TRIAGE_FEATURES, ACTIVE);
    expect(d).toMatchObject({ caseKind: "complaint", uncertain: true, category: "reclamacoes", caseScore: 0.5 });
    // sem o sim, como antes: 0,3 não chega
    expect(decideMailTriage({ box: "faturacao", confidence: 0.85, complaint: 0.3 }, facts, T, ALL_TRIAGE_FEATURES, ACTIVE)).toMatchObject({ caseKind: null, category: "faturacao" });
  });
  it("o objeto mencionado de passagem também; o mais certo ganha", () => {
    expect(decideMailTriage({ box: "criticas", confidence: 0.8, lostItemMentioned: true, lostItem: 0.2 }, facts, T, ALL_TRIAGE_FEATURES, ACTIVE))
      .toMatchObject({ caseKind: "lost_found", uncertain: true });
    expect(decideMailTriage({ box: "perdidos", confidence: 0.9, lostItem: 0.9, complaintMentioned: true, complaint: 0.2 }, facts, T, ALL_TRIAGE_FEATURES, ACTIVE))
      .toMatchObject({ caseKind: "lost_found", uncertain: false });
  });
  it("nunca para um colega, um automático ou com o interruptor desligado", () => {
    const out = { box: "alteracoes", confidence: 0.9, complaintMentioned: true, complaint: 0.2 };
    expect(decideMailTriage(out, { ...facts, sender: "company" }, T, ALL_TRIAGE_FEATURES, ACTIVE).caseKind).toBeNull();
    expect(decideMailTriage(out, { ...facts, sender: "automated" }, T, ALL_TRIAGE_FEATURES, ACTIVE).caseKind).toBeNull();
    expect(decideMailTriage(out, facts, T, { ...ALL_TRIAGE_FEATURES, complaints: false }, ACTIVE).caseKind).toBeNull();
  });
  it("só true conta (não a palavra 'true' nem 1 sem passar pelo esquema); o sim nunca baixa uma certeza maior", () => {
    expect(caseScoresOf({ complaintMentioned: "true" as any, complaint: 0.1 }, T).complaintScore).toBe(0.1);
    expect(caseScoresOf({ complaintMentioned: true, complaint: 0.95 }, T).complaintScore).toBe(0.95);
    expect(caseScoresOf({ box: "reclamacoes", confidence: 0.8 }, T).complaintScore).toBe(0.8);
  });
  it("reclamacoes@/perdidos@: com o sim nunca é lixo", () => {
    expect(aliasGateIsNoise({ box: "ruido", confidence: 0.97 }, T)).toBe(true);
    expect(aliasGateIsNoise({ box: "ruido", confidence: 0.97, complaintMentioned: true }, T)).toBe(false);
    expect(aliasGateIsNoise({ box: "ruido", confidence: 0.97, lostItemMentioned: true }, { suggestMinConfidence: 0 })).toBe(false);
  });
  it("esquema: o sim/não vem primeiro, é obrigatório e tolerante (\"true\", 1, \"sim\"; o resto é não — nunca 'resposta inválida')", () => {
    const js = toProviderJsonSchema(mailRoutingSchema) as any;
    expect(Object.keys(js.properties).slice(0, 4)).toEqual(["complaintMentioned", "complaint", "lostItemMentioned", "lostItem"]);
    expect(js.properties.complaintMentioned.type).toBe("boolean");
    expect(js.required).toEqual(expect.arrayContaining(["complaintMentioned", "complaint", "lostItemMentioned", "lostItem", "box", "confidence", "reason"]));
    const p = (o: any) => mailRoutingSchema.parse({ box: "info", confidence: 1, reason: "x", ...o });
    expect(p({}).complaintMentioned).toBe(false);
    expect(p({ complaintMentioned: "true", lostItemMentioned: 1 })).toMatchObject({ complaintMentioned: true, lostItemMentioned: true });
    expect(p({ complaintMentioned: "Sim" }).complaintMentioned).toBe(true);
    expect(p({ complaintMentioned: "talvez", lostItemMentioned: null })).toMatchObject({ complaintMentioned: false, lostItemMentioned: false });
  });
  it("o pedido explica o sim/não e a escala pelo SENTIDO (nunca uma lista de palavras)", () => {
    expect(MAIL_ROUTING_SYSTEM).toContain("complaintMentioned: true se, em qualquer parte do email");
    expect(MAIL_ROUTING_SYSTEM).toContain("lostItemMentioned: true se, em qualquer parte do email");
    expect(MAIL_ROUTING_SYSTEM).toContain("cerca de 0,6 se a queixa é secundária");
    expect(MAIL_ROUTING_SYSTEM).toContain("um parceiro em nome dele");
    expect(MAIL_ROUTING_SYSTEM).not.toMatch(/palavras[- ]chave|keywords?:/i);
  });
});

// ─── Parceiros em nome do cliente ────────────────────────────────────────────

const FACTS: IntakeFacts = {
  fromBoxKey: "info", fromBoxPipeline: null, outbound: false, automated: false, systemMail: false, personal: false,
  senderIsCompany: false, senderIsAutomated: false, senderIsPartner: true, subject: "x", text: "x", senderEmail: "bookings@sunwaytravel.co.uk",
};

describe("parceiro em nome de um cliente (AI_MAIL_PARTNER_CASES, desligado por omissão)", () => {
  const S = { ...COMPLAINT_INTAKE_DEFAULTS };
  it("desligado: como antes (nunca abre); ligado: abre SEMPRE 'Por confirmar', mesmo com certeza alta; pouca certeza → nada", () => {
    expect(caseIntakeDecision("complaint", 0.95, FACTS, S)).toEqual({ action: "skip", why: "partner" });
    expect(caseIntakeDecision("complaint", 0.95, FACTS, S, { partnerCases: true })).toEqual({ action: "create", uncertain: true, partner: true });
    expect(caseIntakeDecision("lost_found", 0.6, FACTS, S, { partnerCases: true })).toEqual({ action: "create", uncertain: true, partner: true });
    expect(caseIntakeDecision("complaint", 0.3, FACTS, S, { partnerCases: true })).toEqual({ action: "skip", why: "low_confidence" });
    // quem não é parceiro: nada muda
    const client = { ...FACTS, senderIsPartner: false, senderEmail: "ana@gmail.com" };
    expect(caseIntakeDecision("complaint", 0.95, client, S, { partnerCases: true })).toEqual({ action: "create" });
    expect(caseIntakeDecision("complaint", 0.6, client, S, { partnerCases: true })).toEqual({ action: "create", uncertain: true });
  });
  it("o interruptor existe e vem desligado", () => {
    expect(PARTNER_CASES_FLAG).toBe("AI_MAIL_PARTNER_CASES");
    const f = AUTOMATION_FLAGS.find((x) => x.name === PARTNER_CASES_FLAG)!;
    expect(f).toBeTruthy();
    expect(automationFlagDefault(PARTNER_CASES_FLAG)).toBe(false);
    expect(f.description).toMatch(/Por confirmar/);
  });
  it("a nota no caso diz que veio de um parceiro (confirmar quem é o cliente)", () => {
    const n = intakeNote("created", { boxLabel: "Info (geral)", reason: "cliente queixa-se", confidence: 0.9, uncertain: true, partner: true });
    expect(n).toContain("POR CONFIRMAR");
    expect(n).toContain("PARCEIRO");
    expect(n).toContain("Ninguém respondeu ao cliente");
  });
  it("a porta do caso passa o parceiro ao pipeline (e o interruptor manda)", async () => {
    const MSG: IntakeMessage = { threadId: 5, messageId: 50, fromBoxKey: "info", subject: "Client feedback", text: "Our client…", fromName: "Sunway", fromEmail: "bookings@sunwaytravel.co.uk", projectId: null };
    const make = (on: boolean) => {
      const calls = { create: [] as any[], claim: [] as any[] };
      const deps: IntakeDeps = {
        enabled: async () => true, partnerCases: async () => on, settings: async () => ({ ...S }),
        facts: async () => ({ ...FACTS, boxLabel: "Info (geral)" }),
        claim: async (r) => { calls.claim.push(r); return true; }, record: async () => {},
        createOrLink: async (i) => { calls.create.push(i); return { complaintId: 7, isNew: true }; },
      };
      return { deps, calls };
    };
    const off = make(false);
    expect(await intakeFromRouting(MSG, { kind: "complaint", aiBoxKey: "reclamacoes", confidence: 0.95, reason: "x" }, off.deps)).toEqual({ status: "skipped", why: "partner" });
    expect(off.calls.create).toEqual([]);
    const on = make(true);
    expect(await intakeFromRouting(MSG, { kind: "complaint", aiBoxKey: "reclamacoes", confidence: 0.95, reason: "x" }, on.deps)).toEqual({ status: "created", complaintId: 7 });
    expect(on.calls.claim[0]).toMatchObject({ status: "creating", uncertain: true });
    expect(on.calls.create[0]).toMatchObject({ uncertain: true, partnerSender: true });
    // a lista de parceiros a falhar nunca liga o interruptor
    const broken = make(true);
    broken.deps.partnerCases = async () => { throw new Error("bd"); };
    expect(await intakeFromRouting(MSG, { kind: "complaint", aiBoxKey: "reclamacoes", confidence: 0.95, reason: "x" }, broken.deps)).toEqual({ status: "skipped", why: "partner" });
  });
  it("pipeline: o email do parceiro nunca fica como o do cliente nem junta pelo email; nada ao parceiro nem ao cliente", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    h.bySignals.mockImplementation(async (email: any) => (email === "bookings@sunwaytravel.co.uk" ? { id: 55, clientEmail: "bookings@sunwaytravel.co.uk" } : null));
    const out = await processInboundEmail({
      alias: "reclamacoes", messageId: `<p-${Math.random()}@x>`, gmThreadId: "9", refs: [], fromName: "Sunway Travel", fromEmail: "bookings@sunwaytravel.co.uk",
      subject: "Client feedback", receivedAt: "2026-10-14 10:00:00", text: "Our client Mr. Hughes says his car came back with 340 km more.", html: null,
      loadAttachments: async () => [], aiIntake: { actorId: null, uncertain: true, partnerSender: true },
    });
    expect(out).toMatchObject({ status: "processed", routed: { targetModule: "complaint", isNew: true } });
    expect(h.complaints[0].clientEmail).toBeUndefined();
    expect(h.complaints[0]).toMatchObject({ origin: "ia", aiUnconfirmed: 1 });
    expect(h.bySignals).not.toHaveBeenCalledWith("bookings@sunwaytravel.co.uk", null, null);
    expect(h.autoAck).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
    // o mesmo email SEM ser parceiro junta-se à aberta desse email (como sempre)
    const again = await processInboundEmail({
      alias: "reclamacoes", messageId: `<p-${Math.random()}@x>`, gmThreadId: "10", refs: [], fromName: "Sunway Travel", fromEmail: "bookings@sunwaytravel.co.uk",
      subject: "Client feedback", receivedAt: "2026-10-14 10:00:00", text: "Another thing.", html: null, loadAttachments: async () => [], aiIntake: { actorId: null },
    });
    expect(again).toMatchObject({ routed: { targetModule: "complaint", targetId: 55, isNew: false } });
  });
  it("createOrLinkFromThread descobre o parceiro pelo remetente (vale nas novas tentativas e nas sugestões aceites)", () => {
    const s = src("server/complaintMailIntake.ts");
    const fn = s.slice(s.indexOf("export async function createOrLinkFromThread"), s.indexOf("export function dbIntakeDeps"));
    expect(fn).toContain("isPartnerSender(String(m.fromEmail), await partnerEmails(d))");
    expect(fn).toContain("...(partnerSender ? { partnerSender: true } : {})");
    expect(fn).toContain("(partnerSender && !input.actor)");
  });
});

// ─── Uma conversa = um caso (perdidos) ───────────────────────────────────────

describe("o perdido já ligado a esta conversa recebe a mensagem seguinte", () => {
  it("procura a ligação forte (à mão ou ≥ 95) da conversa a um perdido não arquivado e força esse caso", () => {
    const s = src("server/complaintMailIntake.ts");
    const fn = s.slice(s.indexOf("export async function createOrLinkFromThread"), s.indexOf("export function dbIntakeDeps"));
    expect(fn).toContain("l.entityType = 'lost_found' AND l.removedAt IS NULL AND (l.source = 'manual' OR l.confidence >= 95)");
    expect(fn).toContain("f.archivedAt IS NULL");
    expect(fn).toContain("...(threadLostFoundId ? { forceLostFoundId: threadLostFoundId } : {})");
  });
  it("pipeline: com o perdido forçado junta-se a ele (nunca cria outro)", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    const out = await processInboundEmail({
      alias: "perdidos", messageId: `<l-${Math.random()}@x>`, gmThreadId: "11", refs: [], fromName: "Ana", fromEmail: "ana@gmail.com",
      subject: "Re: óculos", receivedAt: "2026-10-14 10:00:00", text: "Já encontraram?", html: null, loadAttachments: async () => [],
      aiIntake: { actorId: null, forceLostFoundId: 321 },
    });
    expect(out).toMatchObject({ routed: { targetModule: "lostfound", targetId: 321, isNew: false } });
    expect(h.lost).toEqual([]);
  });
});

// ─── Emails só em HTML; resposta por baixo da citação ───────────────────────

describe("o que a IA lê", () => {
  it("email só em HTML → o texto do HTML (não só o resumo do Gmail); o texto simples ganha; sem nada → o resumo", () => {
    const html = "<html><head><style>p{color:red}</style></head><body><p>Bom dia, queria mudar a data da reserva 123.</p><p>E da última vez o carro veio com um risco na porta.</p></body></html>";
    const t = readableMailText({ text: "", html, snippet: "Bom dia, queria mudar a data" });
    expect(t).toContain("risco na porta");
    expect(t).not.toContain("color:red");
    expect(readableMailText({ text: "texto simples", html, snippet: "x" })).toBe("texto simples");
    expect(readableMailText({ text: null, html: null, snippet: "só o resumo" })).toBe("só o resumo");
  });
  it("sincronização, porta da reclamacoes@ e emails guardados leem pelo mesmo caminho", () => {
    const svc = src("server/mail/service.ts");
    expect(svc.match(/readableMailText\(\{ text: p\.text, html: p\.html, snippet: p\.snippet \}\)/g)?.length).toBe(2);
    expect(svc).not.toContain('p.text || p.snippet || ""');
    const cr = src("server/commsRouting.ts");
    expect(cr).toContain("CASE WHEN m.bodyText IS NULL OR m.bodyText = '' THEN m.bodyHtml END AS bodyHtml");
    expect(cr).toContain("readableMailText({ text: r.bodyText ?? null, html: r.bodyHtml ?? null, snippet: r.snippet ?? null })");
  });
  it("resposta POR BAIXO da citação: o 'Em … escreveu:' vai para o citado, a mensagem nova fica limpa", async () => {
    const text = "Em 2/10/2026 18:02, Multipark <info@multipark.pt> escreveu:\n> Segue o recibo.\n> Obrigado!\n\nContinuo à espera do reembolso.";
    expect(splitQuotedText(text)).toEqual({ fresh: "Continuo à espera do reembolso.", quoted: "Em 2/10/2026 18:02, Multipark <info@multipark.pt> escreveu:\nSegue o recibo.\nObrigado!" });
    // por cima (o normal) continua igual
    expect(splitQuotedText("Ainda nada?\n\nEm 1/10, Ana escreveu:\n> Cobraram duas vezes.").fresh).toBe("Ainda nada?");
    // uma linha "De: …" sem citação a seguir continua a ser texto do cliente
    expect(splitQuotedText("De: Lisboa para o Porto, quanto custa?").fresh).toBe("De: Lisboa para o Porto, quanto custa?");
    const req = await mailRoutingRequest({ subject: "Re: recibo", text, fromName: "Sofia Antunes", senderKind: "external", attachmentNames: [] }, "Info (geral)");
    expect(req.input).toContain('Mensagem nova:\n"""\nContinuo à espera do reembolso.\n"""');
  });
});

// ─── Filtro "Por confirmar (IA)" ─────────────────────────────────────────────

describe("filtro 'Por confirmar (IA)'", () => {
  it("reclamações: no filtro Origem, só as que a IA criou e ninguém confirmou", () => {
    const rows = [
      { id: 1, origin: "ia", aiUnconfirmed: 1 },
      { id: 2, origin: "ia", aiUnconfirmed: 0 },
      { id: 3, origin: "email", aiUnconfirmed: 0 },
    ];
    expect(filterComplaintRows(rows, { origin: COMPLAINT_AI_UNCONFIRMED_FILTER }, Date.now()).map((r) => r.id)).toEqual([1]);
    expect(filterComplaintRows(rows, { origin: "ia" }, Date.now()).map((r) => r.id)).toEqual([1, 2]);
    expect(filterComplaintRows(rows, { origin: "all" }, Date.now())).toHaveLength(3);
  });
  it("ecrãs: a opção no filtro e o atalho nas Reclamações; a caixa 'Por confirmar (IA)' e o selo IA nos Perdidos", () => {
    const page = src("client/src/pages/ComplaintsPage.tsx");
    expect(page).toContain("<SelectItem value={COMPLAINT_AI_UNCONFIRMED_FILTER}>{COMPLAINT_AI_UNCONFIRMED_LABEL}</SelectItem>");
    expect(page).toContain("setF({ origin: COMPLAINT_AI_UNCONFIRMED_FILTER })");
    const lost = src("client/src/pages/lostFound/KanbanView.tsx");
    expect(lost).toContain("onlyUnconfirmed ? (allItems as any[]).filter((i) => Number(i.aiUnconfirmed ?? 0) === 1)");
    expect(lost).toContain('(item as any).origin === "ia"');
  });
});

// ─── Emails reservados e nunca lidos (fora da janela da nova tentativa) ─────

describe("o que a sincronização reservou e nunca leu não fica por ler para sempre", () => {
  it("o varrimento pega numa linha 'pending' com mais de 2 dias que nunca foi varrida (e só nessa)", async () => {
    h.db = createFakeDb(() => [[]]);
    const deps: any = {
      enabled: async () => true, settings: async () => ({ minConfidence: 0.7, perRun: 10 }), boxes: async () => [], claim: async () => true,
      classify: async () => { throw new Error("não"); }, move: async () => false, record: async () => {}, firstContact: async () => ({}),
      cityProjectId: async () => null, afterRh: async () => {},
    };
    await runMailBackfill({ deadlineAt: Date.now() + 60_000 }, { ...deps, backfillEnabled: async () => true });
    const q = (h.db.queries as any[]).find((x) => x.sql.startsWith("SELECT m.id, m.threadId")).sql as string;
    expect(q).toContain("(r.status = 'pending' AND NOT (r.status = 'pending' AND r.sweptAt IS NULL AND r.createdAt < ?))");
    // corrida com a sincronização: um email acabado de guardar é dela (10 min) — o varrimento não lhe rouba a leitura
    expect(q).toContain("AND m.createdAt < ?");
    const src2 = src("server/commsRouting.ts");
    const claim = src2.slice(src2.indexOf("const upd = await d.execute(sql`UPDATE comms_ai_routing r SET r.sweptAt"), src2.indexOf("claimed = affected(upd) === 1"));
    expect(claim).toContain("OR (${strandedPending(sql`r`, since2d)})");
    expect(claim).toContain("r.category IS NULL");
  });
});

// ─── Avisos ──────────────────────────────────────────────────────────────────

describe("um perdido aberto pela IA não fica em silêncio", () => {
  it("o aviso de email novo só se cala para a reclamação (que tem o seu); o perdido avisa quem vê a caixa Perdidos", () => {
    const svc = src("server/mail/service.ts");
    expect(svc).toContain('if ((r.status === "created" || r.status === "linked") && "complaintId" in r) aiComplaint = true;');
    expect(svc).toContain("if (fresh && noticeBox?.notify && !createdCase && !aiComplaint && !ownerNotified)");
  });
});
