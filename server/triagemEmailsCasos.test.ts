/**
 * Triagem dos emails (14 out 2026) — o caso propriamente dito: a reclamação
 * "Por confirmar (IA)", o perdido aberto pela IA, a junção a um caso aberto
 * (pelo fio, pelo cliente, pela reserva), uma conversa = um caso, e nunca uma
 * palavra ao cliente. BD e Gmail simulados; a IA não entra aqui.
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
  openLost: vi.fn(async (..._a: any[]) => null as any),
  lostById: vi.fn(async (id: number) => ({ id, projectId: 2, clientEmail: "ana@gmail.com", bookingRef: "x" }) as any),
  bySignals: vi.fn(async (..._a: any[]) => null as any),
  byThread: vi.fn(async (..._a: any[]) => null as any),
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
    createComplaint: vi.fn(async (d: any) => { h.complaints.push(d); return 700 + h.complaints.length; }),
    addComplaintMessage: vi.fn(async (m: any) => { h.complaintMsgs.push(m); return 1; }),
    addComplaintPhoto: vi.fn(async () => 1),
    updateComplaint: vi.fn(async () => {}),
    getComplaintById: vi.fn(async (id: number) => ({ id, projectId: 1, complaintStatus: "new", clientEmail: "ana@gmail.com", reservationRef: null })),
    findComplaintByClientSignals: h.bySignals,
    findComplaintByThread: h.byThread,
    findOpenComplaintBySubject: vi.fn(async () => null),
    findOpenComplaintByBookingRef: vi.fn(async () => null),
    createLostFoundItem: vi.fn(async (d: any) => { h.lost.push(d); return 300 + h.lost.length; }),
    addLostFoundMessage: vi.fn(async (m: any) => { h.lostMsgs.push(m); return 1; }),
    findOpenLostFoundByClient: h.openLost,
    getLostFoundItemById: h.lostById,
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

import { COMPLAINT_INTAKE_DEFAULTS, LOST_FOUND_INTAKE_FLAG, caseIntakeDecision, intakeNote, type IntakeFacts } from "../shared/complaintIntake";
import { createOrLinkFromThread, dbIntakeDeps, intakeFromRouting, kindOfVerdict, type IntakeDeps, type IntakeMessage } from "./complaintMailIntake";
import { createFakeDb } from "./_core/ai/testUtils";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

beforeEach(() => {
  h.db = null;
  h.claimed.clear();
  h.complaints = [];
  h.lost = [];
  h.complaintMsgs = [];
  h.lostMsgs = [];
  for (const f of [h.autoAck, h.notifyCreated, h.sendMail, h.openLost, h.bySignals, h.byThread]) f.mockClear();
  h.openLost.mockImplementation(async () => null);
  h.bySignals.mockImplementation(async () => null);
  h.byThread.mockImplementation(async () => null);
});

const FACTS: IntakeFacts = {
  fromBoxKey: "info", fromBoxPipeline: null, outbound: false, automated: false, systemMail: false, personal: false,
  senderIsCompany: false, senderIsAutomated: false, senderIsPartner: false, subject: "x", text: "x", senderEmail: "ana@gmail.com",
};
const MSG: IntakeMessage = { threadId: 20, messageId: 200, fromBoxKey: "info", subject: "Óculos", text: "Deixei os óculos", fromName: "Ana", fromEmail: "ana@gmail.com", projectId: 2 };

describe("regras do caso (reclamação e perdido)", () => {
  it("perdido: as mesmas certezas; a caixa dos perdidos já trata o seu (lost_box)", () => {
    const s = { ...COMPLAINT_INTAKE_DEFAULTS };
    expect(caseIntakeDecision("lost_found", 0.9, FACTS, s)).toEqual({ action: "create" });
    expect(caseIntakeDecision("lost_found", 0.6, FACTS, s)).toEqual({ action: "create", uncertain: true });
    expect(caseIntakeDecision("lost_found", 0.4, FACTS, s)).toEqual({ action: "skip", why: "low_confidence" });
    expect(caseIntakeDecision("lost_found", 0.9, { ...FACTS, fromBoxPipeline: "perdidos" }, s)).toEqual({ action: "skip", why: "lost_box" });
    expect(caseIntakeDecision("complaint", 0.9, { ...FACTS, fromBoxPipeline: "perdidos" }, s)).toEqual({ action: "create" });
  });
  it("Livro de Reclamações (aviso oficial, de um endereço automático) passa; um automático qualquer não", () => {
    const s = { ...COMPLAINT_INTAKE_DEFAULTS };
    const auto = { ...FACTS, automated: true, senderEmail: "naoresponder@livroreclamacoes.pt" };
    expect(caseIntakeDecision("complaint", 1, auto, s)).toEqual({ action: "skip", why: "automatic" });
    expect(caseIntakeDecision("complaint", 1, auto, s, { trusted: true })).toEqual({ action: "create" });
  });
  it("o caso vem do veredicto (ou da caixa que a IA disse)", () => {
    expect(kindOfVerdict({ aiBoxKey: "perdidos", confidence: 1, reason: null })).toBe("lost_found");
    expect(kindOfVerdict({ aiBoxKey: "reclamacoes", confidence: 1, reason: null })).toBe("complaint");
    expect(kindOfVerdict({ kind: "complaint", aiBoxKey: "alteracoes", confidence: 1, reason: null })).toBe("complaint");
    expect(kindOfVerdict({ aiBoxKey: "reservas", confidence: 1, reason: null })).toBeNull();
  });
  it("a nota no caso diz que veio da IA, de que caixa, porquê, e se é para confirmar", () => {
    const a = intakeNote("created", { boxLabel: "Info (geral)", reason: "Óculos esquecidos", confidence: 0.6, caseKind: "lost_found", uncertain: true });
    expect(a).toContain("Criado pela IA — POR CONFIRMAR");
    expect(a).toContain("«Info (geral)»");
    expect(a).toContain("objeto perdido");
    expect(a).toContain("Ninguém respondeu ao cliente");
    expect(intakeNote("created", { boxLabel: "X", reason: null, confidence: 0.9 })).toContain("Criada pela IA");
  });
});

function intakeDeps(o: Partial<IntakeDeps> = {}) {
  const calls = { enabled: [] as string[], claim: [] as any[], create: [] as any[], record: [] as any[] };
  const deps: IntakeDeps = {
    enabled: async (k) => { calls.enabled.push(k); return true; },
    settings: async () => ({ ...COMPLAINT_INTAKE_DEFAULTS }),
    facts: async () => ({ ...FACTS, boxLabel: "Info (geral)" }),
    claim: async (r) => { calls.claim.push(r); return true; },
    record: async (t, p) => { calls.record.push([t, p]); },
    createOrLink: async (i) => { calls.create.push(i); return i.kind === "lost_found" ? { lostFoundId: 31, isNew: true } : { complaintId: 41, isNew: true }; },
    ...o,
  };
  return { deps, calls };
}

describe("a IA viu um perdido noutra caixa", () => {
  it("interruptor dos perdidos (AI_MAIL_LOST_FOUND); desligado → nada", async () => {
    const off = intakeDeps({ enabled: async () => false });
    expect(await intakeFromRouting(MSG, { kind: "lost_found", aiBoxKey: "perdidos", confidence: 0.9, reason: "x" }, off.deps)).toEqual({ status: "off" });
    expect(off.calls.claim).toEqual([]);
    const on = intakeDeps();
    expect(await intakeFromRouting(MSG, { kind: "lost_found", aiBoxKey: "perdidos", confidence: 0.9, reason: "x" }, on.deps)).toEqual({ status: "created", lostFoundId: 31 });
    expect(on.calls.enabled).toEqual(["lost_found"]);
    expect(on.calls.claim[0]).toMatchObject({ kind: "lost_found", status: "creating", uncertain: false });
    expect(on.calls.record[0]).toEqual([20, { status: "created", lostFoundId: 31, error: null, decidedById: null }]);
    expect(LOST_FOUND_INTAKE_FLAG).toBe("AI_MAIL_LOST_FOUND");
  });
  it("certeza média → perdido 'Por confirmar'", async () => {
    const { deps, calls } = intakeDeps();
    await intakeFromRouting(MSG, { kind: "lost_found", aiBoxKey: "criticas", confidence: 0.6, reason: "x" }, deps);
    expect(calls.create[0]).toMatchObject({ kind: "lost_found", uncertain: true });
  });
});

describe("uma conversa = um caso; uma decisão ignorada dá lugar a uma mensagem seguinte", () => {
  it("BD: INSERT IGNORE; já havia linha 'ignorada' → a mensagem seguinte pode ficar com ela (nunca uma recusada/criada)", async () => {
    let updates = 0;
    h.db = createFakeDb((q) => {
      if (q.sql.startsWith("INSERT IGNORE INTO complaint_mail_intake")) return [{ affectedRows: 0 }];
      if (q.sql.startsWith("UPDATE complaint_mail_intake SET messageId")) { updates++; return [{ affectedRows: 1 }]; }
      return [[]];
    });
    const deps = dbIntakeDeps();
    expect(await deps.claim({ msg: MSG, verdict: { aiBoxKey: "reclamacoes", confidence: 0.9, reason: "r" }, kind: "complaint", status: "creating", skipReason: null, uncertain: false })).toBe(true);
    expect(updates).toBe(1);
    const upd = h.db.queries.find((q: any) => q.sql.startsWith("UPDATE complaint_mail_intake SET messageId")).sql as string;
    expect(upd).toContain("WHERE threadId = ? AND (status = 'skipped' OR (status = 'suggested' AND ? = 'creating'))");
    expect(h.db.queries[0].sql).toContain("caseKind, uncertain");
  });
});

describe("o caso nasce pelo pipeline, sem nunca escrever ao cliente", () => {
  const base = (o: any = {}) => ({
    alias: "perdidos" as const, messageId: `<m-${Math.random()}@x>`, gmThreadId: "123", refs: [], fromName: "Ana Sousa", fromEmail: "ana.sousa@gmail.com",
    subject: "Óculos", receivedAt: "2026-10-14 10:00:00", text: "Deixei os óculos no carro.", html: null, loadAttachments: async () => [], ...o,
  });
  it("perdido pela IA: origem 'ia', 'Por confirmar' quando é o caso, sem nada ao cliente", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    const out = await processInboundEmail(base({ aiIntake: { actorId: null, projectId: 2, uncertain: true } }));
    expect(out).toMatchObject({ status: "processed", routed: { targetModule: "lostfound", isNew: true } });
    expect(h.lost[0]).toMatchObject({ origin: "ia", aiUnconfirmed: 1, projectId: 2, clientEmail: "ana.sousa@gmail.com" });
    expect(h.sendMail).not.toHaveBeenCalled();
    expect(h.autoAck).not.toHaveBeenCalled();
  });
  it("perdido aberto do mesmo cliente → junta (não duplica); resposta sem caso → nada", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    const recent = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    h.openLost.mockImplementationOnce(async () => ({ id: 77, clientEmail: "ana.sousa@gmail.com", bookingRef: "b", createdAt: recent }));
    const out = await processInboundEmail(base({ aiIntake: { actorId: null } }));
    expect(out).toMatchObject({ routed: { targetModule: "lostfound", targetId: 77, isNew: false } });
    expect(h.lost).toEqual([]);
    expect(h.lostMsgs[0]).toMatchObject({ itemId: 77, isInternal: 0 });
    // a mesma matrícula de OUTRO cliente nunca esconde o perdido no caso dele
    h.openLost.mockImplementation(async (email: any, plate: any) => (plate ? { id: 78, clientEmail: "outro@gmail.com", createdAt: recent } : null));
    const other = await processInboundEmail(base({ aiIntake: { actorId: null }, text: "Matrícula: AA-11-BB\nDeixei a carteira." }));
    expect(other).toMatchObject({ routed: { targetModule: "lostfound", isNew: true } });
    h.lostById.mockImplementationOnce(async () => null);
    const reply = await processInboundEmail(base({ aiIntake: { forceLostFoundId: 99, replyOnly: true } }));
    expect(reply).toMatchObject({ routed: { targetModule: "ignored" } });
  });
  it("perdidos@ direto continua igual (origem 'email')", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    await processInboundEmail(base());
    expect(h.lost[0]).toMatchObject({ origin: "email" });
    expect(h.lost[0].aiUnconfirmed).toBeUndefined();
  });
  it("reclamação 'Por confirmar': marcada, avisa a equipa no sino, mas nunca o aviso de receção ao cliente", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    await processInboundEmail(base({ alias: "reclamacoes", subject: "Carro riscado", text: "O carro veio riscado.", aiIntake: { actorId: null, uncertain: true } }));
    expect(h.complaints[0]).toMatchObject({ origin: "ia", aiUnconfirmed: 1 });
    expect(h.notifyCreated).toHaveBeenCalledTimes(1);
    expect(h.autoAck).not.toHaveBeenCalled();
    expect(src("server/complaintsExtended.ts")).toContain('"Reclamação por confirmar (IA)"');
  });
  it("de ponta a ponta: email de info@ → perdido (liga a conversa, nota interna), sem mover nem apagar nada", async () => {
    h.db = createFakeDb((q) => (q.sql.startsWith("SELECT m.id, m.threadId, m.accountKey") ? [[{ id: 200, threadId: 20, accountKey: "dwd:reservas@multipark.pt", gmailMessageId: "abc" }]] : [{ affectedRows: 1 }]));
    const parsed = {
      gmailMessageId: "abc", gmailThreadId: "abc", labelIds: [], historyId: null, sentAt: "2026-10-14 10:00:00", rfcMessageId: "<lf-1@gmail.com>", inReplyTo: null, references: [],
      subject: "Óculos", snippet: "", fromName: "Ana", fromEmail: "ana@gmail.com", to: ["info@multipark.pt"], cc: [], bcc: [], deliveredTo: [], xOriginalTo: [], replyTo: null,
      autoSubmitted: null, precedence: null, systemMail: false, autoKind: null, loginMail: false, text: "Deixei os óculos no carro.", html: "", attachments: [], outbound: false, unread: true,
    } as any;
    const out = await createOrLinkFromThread(
      { threadId: 20, messageId: 200, boxLabel: "Info (geral)", verdict: { kind: "lost_found", aiBoxKey: "perdidos", confidence: 0.62, reason: "Óculos" }, actor: null, projectId: 2, kind: "lost_found", uncertain: true },
      { parsed, api: { getAttachment: async () => Buffer.from(""), getMessage: async () => null } },
    );
    expect(out).toMatchObject({ lostFoundId: 301, isNew: true });
    const all = h.db.queries.map((q: any) => q.sql).join("\n");
    expect(all).toMatch(/INSERT INTO mail_links/);
    expect(h.db.queries.find((q: any) => q.sql.startsWith("INSERT INTO mail_links")).params).toContain("lost_found");
    expect(all).not.toMatch(/DELETE FROM|mailboxKey = \?/);
    expect(h.lostMsgs.some((m) => m.isInternal === 1 && String(m.message).includes("POR CONFIRMAR"))).toBe(true);
    expect(h.sendMail).not.toHaveBeenCalled();
  });
});

// ─── Auditoria (14 out 2026): a junção da IA nunca esconde outro caso ───────

describe("auditoria — o mesmo cliente com outra reserva tem outro caso", () => {
  const complaintMail = (o: any = {}) => ({
    alias: "reclamacoes" as const, messageId: `<c-${Math.random()}@x>`, gmThreadId: "999", refs: [], fromName: "Ana Sousa", fromEmail: "ana.sousa@gmail.com",
    subject: "Outra reserva", receivedAt: "2026-10-14 10:00:00", html: null, loadAttachments: async () => [], aiIntake: { actorId: null }, ...o,
  });
  // Nota: a reserva/matrícula compara-se quando o email as traz identificadas ("Reserva: …", "Matrícula: …").
  it("reclamação aberta do mesmo email mas de OUTRA reserva → cria outra; da mesma reserva → junta", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    h.bySignals.mockImplementation(async () => ({ id: 41, clientEmail: "ana.sousa@gmail.com", reservationRef: "MP-48213", vehiclePlate: null, complaintStatus: "new" }));
    const other = await processInboundEmail(complaintMail({ text: "Reserva: 51003\nO carro veio com o vidro partido." }));
    expect(other).toMatchObject({ routed: { targetModule: "complaint", isNew: true } });
    expect(h.complaints).toHaveLength(1);
    const same = await processInboundEmail(complaintMail({ text: "Reserva: 48213\nContinuo à espera de resposta." }));
    expect(same).toMatchObject({ routed: { targetModule: "complaint", targetId: 41, isNew: false } });
    const noSignal = await processInboundEmail(complaintMail({ text: "Continuo à espera de resposta." }));
    expect(noSignal).toMatchObject({ routed: { targetModule: "complaint", targetId: 41, isNew: false } });
    expect(h.complaints).toHaveLength(1);
  });
  it("perdido aberto há meses do mesmo cliente → um objeto novo abre o seu próprio caso", async () => {
    const { processInboundEmail } = await import("./jobs/emailInboundSync");
    h.openLost.mockImplementation(async (email: any) => (email ? { id: 90, clientEmail: "ana.sousa@gmail.com", createdAt: "2026-03-01 10:00:00" } : null));
    const out = await processInboundEmail(complaintMail({ alias: "perdidos", subject: "Carregador", text: "Esqueci-me do carregador na carrinha." }));
    expect(out).toMatchObject({ routed: { targetModule: "lostfound", isNew: true } });
    expect(h.lostMsgs.filter((m) => m.itemId === 90)).toEqual([]);
  });
});
