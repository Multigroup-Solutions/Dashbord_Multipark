/**
 * IA na comunicação com clientes (runAi simulado): mapeamento da
 * classificação, limiares de confiança, nada é enviado sozinho, duplicados,
 * debounce do WhatsApp, pré-filtro dos Perdidos e interruptor desligado →
 * nenhuma chamada à IA.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const h = vi.hoisted(() => ({
  runAi: vi.fn(),
  derive: vi.fn(),
  selectRows: (_table: string): any[] => [],
  executeRows: (_sql: string, _params: unknown[]): any => [[]],
  affected: () => 1,
  db: null as any,
  sendEmail: vi.fn(),
  autoAck: vi.fn(),
  waText: vi.fn(),
  waTemplate: vi.fn(),
  publishReply: vi.fn(),
  addComplaintMessage: vi.fn(),
  addLostFoundMessage: vi.fn(),
}));

vi.mock("./_core/ai/run", () => ({ runAi: (...a: any[]) => h.runAi(...a) }));
vi.mock("./db", () => ({
  getDb: async () => h.db,
  addComplaintMessage: (...a: any[]) => h.addComplaintMessage(...a),
  addLostFoundMessage: (...a: any[]) => h.addLostFoundMessage(...a),
  resolveProjectIds: async () => [],
}));
vi.mock("./caseOps", () => ({ deriveBookingForCase: (...a: any[]) => h.derive(...a) }));
vi.mock("./complaintsExtended", () => ({ sendComplaintEmailToClient: h.sendEmail, sendComplaintAutoAck: h.autoAck, notifyComplaintCreated: vi.fn() }));
vi.mock("./whatsapp", () => ({ sendTextMessage: h.waText, sendTemplateMessage: h.waTemplate }));
vi.mock("./integrations/googleBusiness/service", () => ({ publishReply: h.publishReply }));

import {
  AUTO_APPLY_CONFIDENCE,
  combinedMatchScore,
  effectiveSlaMinutes,
  finalizeComplaintDraft,
  isComplaintFieldEmpty,
  lostFoundSide,
  mapComplaintPriority,
  mapComplaintType,
  mapWhatsappIntent,
  mapWhatsappUrgency,
  mentionsCompensation,
  pickDuplicate,
  prefilterMatch,
  rankMatchCandidates,
  reviewSentiment,
  shouldAutoApply,
  whatsappTriagePlan,
} from "../shared/commsAi";
import { conversationAlerts } from "../shared/whatsappConversation";
import { triageComplaint, decideComplaintSuggestion } from "./complaintTriage";
import { noteInboundForTriage, triageConversation, triageTranscript } from "./whatsappTriage";
import { computeMatchesFor } from "./lostFoundMatch";
import { draftPendingReviewReplies } from "./reviewAutoDraft";

const dialect = new MySqlDialect();

interface Log { updates: { table: string; data: any }[]; executes: { sql: string; params: unknown[] }[] }

function fakeDb(): { log: Log } & Record<string, any> {
  const log: Log = { updates: [], executes: [] };
  const chain = () => {
    const c: any = { table: "" };
    for (const m of ["where", "limit", "orderBy", "leftJoin", "for"]) c[m] = () => c;
    c.from = (t: any) => { c.table = getTableName(t); return c; };
    c.then = (res: any, rej: any) => Promise.resolve(h.selectRows(c.table)).then(res, rej);
    return c;
  };
  return {
    log,
    select: () => chain(),
    update: (t: any) => ({
      set: (data: any) => ({
        where: () => { log.updates.push({ table: getTableName(t), data }); return Promise.resolve([{ affectedRows: h.affected() }]); },
      }),
    }),
    delete: () => ({ where: () => Promise.resolve([{ affectedRows: 0 }]) }),
    execute: async (q: any) => {
      const c = dialect.sqlToQuery(q);
      const entry = { sql: c.sql.replace(/\s+/g, " ").trim(), params: c.params as unknown[] };
      log.executes.push(entry);
      return h.executeRows(entry.sql, entry.params);
    },
  };
}

const FLAGS = ["GEMINI_API_KEY", "LLM_API_KEY", "AI_ENABLED", "AI_COMPLAINT_TRIAGE", "AI_REVIEW_AUTO_DRAFTS", "AI_WHATSAPP_TRIAGE", "AI_LOST_FOUND_MATCH"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
  for (const k of FLAGS) delete process.env[k];
  process.env.GEMINI_API_KEY = "test-key";
  for (const f of [h.runAi, h.derive, h.sendEmail, h.autoAck, h.waText, h.waTemplate, h.publishReply, h.addComplaintMessage, h.addLostFoundMessage]) f.mockReset();
  h.selectRows = () => [];
  h.executeRows = () => [[]];
  h.affected = () => 1;
  h.db = fakeDb();
});
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const aiResult = (output: unknown) => ({ output, text: JSON.stringify(output), provider: "gemini", model: "m", tier: "lite", usage: {}, costEur: 0, latencyMs: 1, attempts: 1 });

function expectNothingSent() {
  expect(h.sendEmail).not.toHaveBeenCalled();
  expect(h.autoAck).not.toHaveBeenCalled();
  expect(h.waText).not.toHaveBeenCalled();
  expect(h.waTemplate).not.toHaveBeenCalled();
  expect(h.publishReply).not.toHaveBeenCalled();
}

// ─── Regras puras ───────────────────────────────────────────────────────────

describe("mapeamento da classificação", () => {
  it("tipo: enum, PT, acentos e desconhecido → other", () => {
    expect(mapComplaintType("damage")).toBe("damage");
    expect(mapComplaintType("Dano")).toBe("damage");
    expect(mapComplaintType("ATRASO")).toBe("delay");
    expect(mapComplaintType("cobrança")).toBe("overcharge");
    expect(mapComplaintType("cobranca")).toBe("overcharge");
    expect(mapComplaintType("atendimento")).toBe("staff");
    expect(mapComplaintType("sujidade")).toBe("dirt");
    expect(mapComplaintType("xpto")).toBe("other");
    expect(mapComplaintType(null)).toBe("other");
  });
  it("prioridade e intenção/urgência do WhatsApp", () => {
    expect(mapComplaintPriority("Urgente")).toBe("urgent");
    expect(mapComplaintPriority("alta")).toBe("high");
    expect(mapComplaintPriority("??")).toBe("medium");
    expect(mapWhatsappIntent("Alteração")).toBe("alteracao");
    expect(mapWhatsappIntent("perdido/achado")).toBe("perdido_achado");
    expect(mapWhatsappIntent("extra")).toBe("recrutamento");
    expect(mapWhatsappIntent("cancelar")).toBe("cancelamento");
    expect(mapWhatsappIntent("qualquer")).toBe("outro");
    expect(mapWhatsappUrgency("URGENTE")).toBe("urgente");
    expect(mapWhatsappUrgency("normal")).toBe("normal");
    expect(mapWhatsappUrgency(undefined)).toBe("normal");
  });
  it("sentimento das críticas", () => {
    expect(reviewSentiment(5, "")).toBe("positivo");
    expect(reviewSentiment(1, "")).toBe("negativo");
    expect(reviewSentiment(3, "atrasaram 1 hora")).toBe("negativo");
    expect(reviewSentiment(0, "Excelente serviço, recomendo")).toBe("positivo");
    expect(reviewSentiment(0, "")).toBe("neutro");
  });
});

const emailComplaint = {
  complaintType: "other", complaintPriority: "medium", complaintStatus: "new", slaDeadline: "2026-09-26 10:00:00",
  reservationRef: null, createdById: null, assignedToId: null,
};

describe("limiares de confiança", () => {
  it("aplica sozinha só com confiança ≥ 0,85 E campo vazio", () => {
    expect(shouldAutoApply("type", AUTO_APPLY_CONFIDENCE, emailComplaint)).toBe(true);
    expect(shouldAutoApply("type", 0.84, emailComplaint)).toBe(false);
    expect(shouldAutoApply("type", 0.99, { ...emailComplaint, complaintType: "damage" })).toBe(false);
    // Uma pessoa já pegou no caso → prioridade/SLA deixam de estar "vazios".
    expect(shouldAutoApply("priority", 0.95, { ...emailComplaint, assignedToId: 3 })).toBe(false);
    expect(shouldAutoApply("priority", 0.95, { ...emailComplaint, createdById: 7 })).toBe(false);
    expect(shouldAutoApply("booking", 0.95, { ...emailComplaint, reservationRef: "ABC123" })).toBe(false);
    expect(isComplaintFieldEmpty("booking", emailComplaint)).toBe(true);
  });
  it("duplicados e rascunhos nunca se aplicam sozinhos", () => {
    expect(shouldAutoApply("duplicate", 1, emailComplaint)).toBe(false);
    expect(shouldAutoApply("draft", 1, emailComplaint)).toBe(false);
  });
});

describe("rascunho da reclamação", () => {
  it("cita a reserva e troca o marcador", () => {
    expect(finalizeComplaintDraft("Sobre a reserva [RESERVA], estamos a analisar.", "MP-991")).toBe("Sobre a reserva MP-991, estamos a analisar.");
    expect(finalizeComplaintDraft("Estamos a analisar o seu caso.", "MP-991")).toBe("Relativamente à reserva MP-991: Estamos a analisar o seu caso.");
    expect(finalizeComplaintDraft("Estamos a analisar.", null)).toMatch(/sua reserva/);
  });
  it("nunca promete compensações (rascunho recusado)", () => {
    expect(mentionsCompensation("Vamos proceder ao reembolso total.")).toBe(true);
    expect(mentionsCompensation("Oferecemos um voucher de 10€.")).toBe(true);
    expect(mentionsCompensation("Teremos todo o gosto em compensar o incómodo.")).toBe(true);
    expect(finalizeComplaintDraft("Iremos reembolsar a reserva [RESERVA].", "X1")).toBeNull();
    expect(finalizeComplaintDraft("A equipa está a analisar a reserva [RESERVA].", "X1")).not.toBeNull();
  });
});

describe("duplicados", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const self = { id: 10, clientEmail: "Ana@Mail.pt", reservationRef: "R1", vehiclePlate: "AA-11-BB" };
  it("aberta do mesmo cliente/reserva/matrícula; ignora fechadas, antigas e a própria", () => {
    const cands = [
      { id: 10, clientEmail: "ana@mail.pt", complaintStatus: "new", createdAt: "2026-09-24 10:00:00" },
      { id: 3, clientEmail: "ana@mail.pt", complaintStatus: "closed", createdAt: "2026-09-20 10:00:00" },
      { id: 4, reservationRef: "R1", complaintStatus: "resolved", createdAt: "2026-09-20 10:00:00" },
      { id: 5, clientEmail: "ana@mail.pt", complaintStatus: "analyzing", createdAt: "2026-05-01 10:00:00" },
      { id: 7, vehiclePlate: "aa 11 bb", complaintStatus: "new", createdAt: "2026-09-22 10:00:00" },
      { id: 8, reservationRef: "R1", clientEmail: "ANA@mail.pt", complaintStatus: "waiting_client", createdAt: "2026-09-23 10:00:00" },
    ];
    const d = pickDuplicate(self, cands, now)!;
    expect(d.id).toBe(8);
    expect(d.reason).toContain("mesma reserva");
    expect(d.confidence).toBeGreaterThan(0.9);
    expect(pickDuplicate(self, cands.filter((c) => c.id !== 8), now)!.id).toBe(7);
    expect(pickDuplicate({ id: 1 }, cands, now)).toBeNull();
  });
});

describe("debounce do WhatsApp (regra)", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  it("sem triagem → já; há 2 min → agenda para +5 min; há 6 min → já", () => {
    expect(whatsappTriagePlan(null, now)).toEqual({ runNow: true, dueAtMs: now });
    const p = whatsappTriagePlan("2026-09-24 11:58:00", now);
    expect(p.runNow).toBe(false);
    expect(p.dueAtMs).toBe(Date.parse("2026-09-24T12:03:00Z"));
    expect(whatsappTriagePlan("2026-09-24 11:54:00", now).runNow).toBe(true);
  });
  it("urgentes entram mais cedo no SLA", () => {
    expect(effectiveSlaMinutes(15, "urgente")).toBe(5);
    expect(effectiveSlaMinutes(60, "urgente")).toBe(20);
    expect(effectiveSlaMinutes(15, "normal")).toBe(15);
    const t = Date.parse("2026-09-24T12:00:00Z");
    const base = { status: "aberto", awaitingSince: "2026-09-24 11:52:00", windowState: "open" as const, windowExpiresAt: null };
    expect(conversationAlerts(base, t, 15).overdue).toBe(false);
    expect(conversationAlerts({ ...base, aiUrgency: "urgente" }, t, 15).overdue).toBe(true);
  });
});

describe("pré-filtro perdido ↔ achado", () => {
  const lost = { id: 1, clientName: "Ana Silva", status: "new", projectId: 2, vehiclePlate: "AA-11-BB", bookingRef: "R1", itemType: "electronics", createdAt: "2026-09-20 10:00:00" };
  it("lados", () => {
    expect(lostFoundSide(lost)).toBe("lost");
    expect(lostFoundSide({ id: 2, clientName: "Desconhecido", status: "new" })).toBe("found");
    expect(lostFoundSide({ id: 3, clientName: "Rui", status: "new", convertedFromType: "incident" })).toBe("found");
    expect(lostFoundSide({ id: 4, clientName: "Rui", status: "returned" })).toBeNull();
    expect(lostFoundSide({ id: 5, clientName: "Rui", status: "found" })).toBeNull();
  });
  it("janela de datas, parque, matrícula/reserva", () => {
    const found = { id: 9, clientName: "Desconhecido", status: "new", projectId: 2, vehiclePlate: "aa11bb", bookingRef: "R1", itemType: "electronics", createdAt: "2026-09-21 09:00:00" };
    const r = prefilterMatch(lost, found)!;
    expect(r.reasons).toEqual(expect.arrayContaining(["mesma reserva", "mesma matrícula", "mesmo tipo de objeto", "mesmo parque"]));
    expect(r.score).toBe(100);
    expect(prefilterMatch(lost, { ...found, createdAt: "2026-11-30 09:00:00" })).toBeNull(); // fora da janela
    expect(prefilterMatch(lost, { ...found, projectId: 5 })).toBeNull(); // outro parque
    expect(prefilterMatch(lost, { ...found, bookingRef: null, vehiclePlate: "ZZ-99-ZZ", itemType: "other" })).toBeNull(); // matrícula diferente
    const ranked = rankMatchCandidates(lost, [
      { ...found, id: 20, bookingRef: null, vehiclePlate: null },
      found,
      { ...found, id: 21, clientName: "Outro Cliente" }, // outro perdido, não é achado
    ], "lost");
    expect(ranked.map((x) => x.item.id)).toEqual([9, 20]);
    expect(combinedMatchScore(40, 90)).toBe(75);
    expect(combinedMatchScore(40, null)).toBe(40);
  });
});

// ─── Reclamações (runAi simulado) ───────────────────────────────────────────

const complaintRow = {
  id: 42, title: "Carro riscado", description: "Recolhi o carro AA-11-BB e tem um risco. Email ana@mail.pt, tel 912345678. Reserva MP12345.",
  complaintType: "other", complaintPriority: "medium", complaintStatus: "new", slaDeadline: "2026-09-26 10:00:00",
  reservationRef: null, vehiclePlate: null, clientEmail: "ana@mail.pt", clientName: "Ana Maria Silva", createdById: null, assignedToId: null,
  projectId: null, createdAt: "2026-09-24 10:00:00", aiTriagedAt: null,
};

describe("triagem das reclamações", () => {
  beforeEach(() => {
    h.selectRows = (t) => (t === "complaints" ? [complaintRow] : []);
    h.executeRows = (sql) => (sql.startsWith("SELECT id, clientEmail") ? [[{ id: 7, clientEmail: "ana@mail.pt", reservationRef: null, vehiclePlate: null, complaintStatus: "new", createdAt: "2026-09-23 09:00:00" }]] : [{}]);
    h.derive.mockResolvedValue({ projectId: 3, externalId: "MP12345" });
  });

  it("confiança alta + campo vazio → aplica; resto fica por decidir; nada enviado", async () => {
    h.runAi.mockResolvedValue(aiResult({
      type: "dano", typeConfidence: 0.93, priority: "alta", priorityConfidence: 0.6, reason: "Risco no carro",
      bookingRef: "MP12345", plate: "[MATRICULA_1]", draft: "Lamentamos o sucedido. Estamos a analisar a reserva [RESERVA] e as fotografias.",
    }));
    const r = await triageComplaint(42);
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(expect.arrayContaining(["type", "booking"]));
    expect(r.suggested).toEqual(expect.arrayContaining(["priority", "sla", "duplicate", "draft"]));
    // PII fora do pedido; só o primeiro nome; entrada cortada
    const call = h.runAi.mock.calls[0][0];
    expect(call.feature).toBe("complaint_triage");
    expect(call.input).not.toMatch(/ana@mail\.pt|912345678|AA-11-BB|Silva/);
    expect(call.input).toContain("Ana");
    // Campos humanos: só type/reserva aplicados (prioridade 0,6 fica sugestão)
    const upd = h.db.log.updates.find((u: any) => u.table === "complaints");
    expect(upd.data).toMatchObject({ complaintType: "damage", reservationRef: "MP12345", projectId: 3 });
    expect(upd.data.complaintPriority).toBeUndefined();
    expect(upd.data.aiTriagedAt).toBeTruthy();
    // Sugestões gravadas à parte, com estado
    const ins = h.db.log.executes.filter((e: any) => e.sql.startsWith("INSERT INTO ai_suggestions"));
    const byField = Object.fromEntries(ins.map((e: any) => [e.params[2], e.params]));
    expect(byField.type[6]).toBe("applied");
    expect(byField.type[7]).toBe("other"); // valor anterior (para desfazer)
    expect(byField.priority[6]).toBe("pending");
    expect(byField.duplicate[3]).toBe("7");
    expect(byField.draft[3]).toContain("MP12345");
    expect(byField.draft[6]).toBe("pending");
    // A SQL do duplicado é parametrizada (o email vai como parâmetro)
    const dupSql = h.db.log.executes.find((e: any) => e.sql.startsWith("SELECT id, clientEmail"));
    expect(dupSql.sql).not.toContain("ana@mail.pt");
    expect(dupSql.params).toContain("ana@mail.pt");
    expectNothingSent();
  });

  it("rascunho com compensação é descartado", async () => {
    h.runAi.mockResolvedValue(aiResult({ type: "delay", typeConfidence: 0.5, priority: "medium", priorityConfidence: 0.5, reason: "", bookingRef: "", plate: "", draft: "Vamos oferecer um desconto na próxima reserva [RESERVA]." }));
    const r = await triageComplaint(42);
    expect(r.ok).toBe(true);
    expect(r.suggested).not.toContain("draft");
    expect(r.applied).toEqual([]);
    expectNothingSent();
  });

  it("interruptor desligado → nenhuma chamada à IA nem escrita", async () => {
    process.env.AI_COMPLAINT_TRIAGE = "off";
    const r = await triageComplaint(42);
    expect(r.skipped).toBe("disabled");
    expect(h.runAi).not.toHaveBeenCalled();
    expect(h.db.log.updates).toHaveLength(0);
  });

  it("aceitar o rascunho não envia nada; rejeitar uma aplicada repõe o valor anterior", async () => {
    h.selectRows = (t) => (t === "ai_suggestions" ? [{ id: 1, field: "draft", value: "Texto", status: "pending", previousValue: null }] : t === "complaints" ? [complaintRow] : []);
    expect(await decideComplaintSuggestion(42, "draft", "accept", { id: 5, name: "Rita" })).toEqual({ ok: true });
    expectNothingSent();
    h.db = fakeDb();
    h.selectRows = (t) => (t === "ai_suggestions" ? [{ id: 2, field: "type", value: "damage", status: "applied", previousValue: "other" }] : t === "complaints" ? [{ ...complaintRow, complaintType: "damage" }] : []);
    await decideComplaintSuggestion(42, "type", "reject", { id: 5 });
    expect(h.db.log.updates.find((u: any) => u.table === "complaints").data).toEqual({ complaintType: "other" });
  });
});

// ─── WhatsApp (debounce + triagem) ──────────────────────────────────────────

describe("triagem do WhatsApp", () => {
  it("debounce: 1.ª mensagem reserva a triagem; a 2.ª (2 min depois) só agenda — sem IA no webhook", async () => {
    const now = Date.parse("2026-09-24T12:00:00Z");
    h.selectRows = () => [{ aiTriagedAt: null, aiTriageDueAt: null }];
    expect(await noteInboundForTriage(1, now)).toBe(true);
    h.selectRows = () => [{ aiTriagedAt: "2026-09-24 11:58:00", aiTriageDueAt: null }];
    expect(await noteInboundForTriage(1, now)).toBe(false);
    const sched = h.db.log.updates.at(-1);
    expect(sched.data).toEqual({ aiTriageDueAt: "2026-09-24 12:03:00" });
    // Outra instância já reservou → false
    h.selectRows = () => [{ aiTriagedAt: null, aiTriageDueAt: null }];
    h.affected = () => 0;
    expect(await noteInboundForTriage(1, now)).toBe(false);
    expect(h.runAi).not.toHaveBeenCalled();
  });

  it("interruptor desligado → nem reserva nem IA", async () => {
    process.env.AI_WHATSAPP_TRIAGE = "off";
    h.selectRows = () => [{ aiTriagedAt: null, aiTriageDueAt: null }];
    expect(await noteInboundForTriage(1)).toBe(false);
    expect(h.db.log.updates).toHaveLength(0);
    expect(h.runAi).not.toHaveBeenCalled();
  });

  it("classifica (sem telefones no pedido) e grava etiquetas; nunca responde", async () => {
    h.selectRows = (t) => (t === "whatsapp_messages" ? [
      { direction: "in", body: "Estou no aeroporto e o carro não chegou! Liguem 912345678" },
      { direction: "out", body: "Olá, vamos verificar." },
    ] : []);
    h.runAi.mockResolvedValue(aiResult({ intent: "reclamação", urgency: "URGENTE" }));
    expect(await triageConversation(9)).toEqual({ ok: true });
    const call = h.runAi.mock.calls[0][0];
    expect(call.feature).toBe("whatsapp_triage");
    expect(call.input).not.toContain("912345678");
    expect(call.input.length).toBeLessThanOrEqual(1500);
    expect(h.db.log.updates.at(-1).data).toMatchObject({ aiIntent: "reclamacao", aiUrgency: "urgente" });
    expectNothingSent();
  });

  it("transcrição cortada nas mais recentes", () => {
    const t = triageTranscript([{ direction: "in", body: "a".repeat(50) }, { direction: "in", body: "b".repeat(50) }], 70);
    expect(t).toBe(`Cliente: ${"b".repeat(50)}`);
  });
});

// ─── Perdidos & Achados ─────────────────────────────────────────────────────

describe("correspondências dos Perdidos", () => {
  const lostItem = { id: 1, clientName: "Ana Silva", status: "new", projectId: 2, vehiclePlate: "AA-11-BB", bookingRef: null, itemType: "electronics", createdAt: "2026-09-20 10:00:00", description: "iPhone preto com capa azul, contacto ana@mail.pt" };
  beforeEach(() => {
    h.selectRows = (t) => (t === "lost_found_items" ? [lostItem] : []);
    h.executeRows = (sql) => (sql.startsWith("SELECT id, clientName") ? [[
      { id: 9, clientName: "Desconhecido", status: "new", projectId: 2, vehiclePlate: "AA11BB", itemType: "electronics", createdAt: "2026-09-21 09:00:00", description: "Telemóvel com capa azul no banco" },
      { id: 11, clientName: "Rui", status: "new", projectId: 2, itemType: "electronics", createdAt: "2026-09-21 09:00:00", description: "Outro perdido" },
    ]] : [{}]);
  });

  it("uma só chamada com os candidatos do pré-filtro; IDs inventados ignorados; sem contacto ao cliente", async () => {
    h.runAi.mockResolvedValue(aiResult({ matches: [{ id: 9, score: 88, reason: "Capa azul igual" }, { id: 999, score: 99, reason: "inventado" }] }));
    const r = await computeMatchesFor(1);
    expect(r).toMatchObject({ candidates: 1, ai: true });
    expect(h.runAi).toHaveBeenCalledTimes(1);
    expect(h.runAi.mock.calls[0][0].input).not.toContain("ana@mail.pt");
    const ins = h.db.log.executes.filter((e: any) => e.sql.startsWith("INSERT INTO lost_found_matches"));
    expect(ins).toHaveLength(1);
    expect(ins[0].params.slice(0, 4)).toEqual([1, 9, expect.any(Number), 88]);
    expect(h.addLostFoundMessage).not.toHaveBeenCalled();
    expectNothingSent();
  });

  it("interruptor desligado → só pré-filtro, nenhuma chamada à IA", async () => {
    process.env.AI_LOST_FOUND_MATCH = "off";
    const r = await computeMatchesFor(1);
    expect(r).toMatchObject({ candidates: 1, ai: false });
    expect(h.runAi).not.toHaveBeenCalled();
    const ins = h.db.log.executes.find((e: any) => e.sql.startsWith("INSERT INTO lost_found_matches"));
    expect(ins.params[3]).toBeNull();
  });
});

// ─── Críticas Google ────────────────────────────────────────────────────────

describe("rascunho automático das críticas", () => {
  const review = { id: 5, rating: 2, reviewerName: "Joana Costa", reviewText: "Esperei 1 hora. joana@x.pt", complaintId: 77, vehiclePlate: null, createdAt: "2026-09-24 09:00:00" };

  it("fica por aprovar (aiResponseApproved = 0), com sentimento e contexto; nunca publica", async () => {
    h.selectRows = (t) => (t === "google_reviews" ? [review] : t === "complaints" ? [{ t: "delay", s: "analyzing", ref: "MP1" }] : []);
    h.runAi.mockResolvedValue(aiResult("Olá Joana, lamentamos a espera. A equipa vai analisar."));
    const r = await draftPendingReviewReplies({ limit: 3 });
    expect(r.drafted).toBe(1);
    const call = h.runAi.mock.calls[0][0];
    expect(call.feature).toBe("review_auto_draft");
    expect(call.input).toContain("Contexto interno");
    expect(call.input).toContain("Sentimento: negativo");
    expect(call.input).not.toMatch(/joana@x\.pt|Costa/);
    const upd = h.db.log.updates.find((u: any) => u.table === "google_reviews" && "aiResponse" in u.data);
    expect(upd.data).toMatchObject({ aiResponseApproved: 0, aiSentiment: "negativo" });
    expect(h.publishReply).not.toHaveBeenCalled();
    expectNothingSent();
  });

  it("interruptor desligado → nenhuma chamada", async () => {
    process.env.AI_REVIEW_AUTO_DRAFTS = "off";
    h.selectRows = (t) => (t === "google_reviews" ? [review] : []);
    const r = await draftPendingReviewReplies();
    expect(r.skipped).toBe("disabled");
    expect(h.runAi).not.toHaveBeenCalled();
  });

  it("IA geral desligada (AI_ENABLED=off) → nenhuma funcionalidade chama", async () => {
    process.env.AI_ENABLED = "off";
    h.selectRows = (t) => (t === "complaints" ? [complaintRow] : t === "google_reviews" ? [review] : [{ aiTriagedAt: null }]);
    await triageComplaint(42);
    await draftPendingReviewReplies();
    await noteInboundForTriage(1);
    await computeMatchesFor(1);
    expect(h.runAi).not.toHaveBeenCalled();
  });
});

// ─── Migração ───────────────────────────────────────────────────────────────

describe("migração 0123 (IA na comunicação com clientes)", () => {
  it("registada no ensureRecentSchema (por ordem), idempotente e espelhada no schema drizzle", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const root = resolve(__dirname, "..");
    const db = readFileSync(resolve(root, "server/db.ts"), "utf8");
    const nums = [...db.matchAll(/import\("\.\/migrations\/migration_(\d{4})"\)\.then\(m => \(\{ s: m\.MIGRATION_/g)].map((x) => Number(x[1]));
    expect(nums).toContain(123);
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    const { MIGRATION_0123_STATEMENTS, IDEMPOTENT_ERROR_CODES_0123 } = await import("./migrations/migration_0123");
    for (const st of MIGRATION_0123_STATEMENTS) expect(st).toMatch(/^(CREATE TABLE IF NOT EXISTS|ALTER TABLE `\w+` ADD (COLUMN|INDEX))/);
    expect(MIGRATION_0123_STATEMENTS.join("\n")).not.toMatch(/^\s*(UPDATE|DROP|DELETE)\b|\bDROP (TABLE|COLUMN)\b/im);
    for (const code of ["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]) expect(IDEMPOTENT_ERROR_CODES_0123.has(code)).toBe(true);
    const schema = readFileSync(resolve(root, "drizzle/schema.ts"), "utf8");
    expect(schema).toMatch(/mysqlTable\("ai_suggestions"/);
    expect(schema).toMatch(/mysqlTable\("lost_found_matches"/);
    for (const col of ["aiTriagedAt", "aiSentiment", "aiDraftAttemptedAt", "aiIntent", "aiUrgency", "aiTriageDueAt", "aiMatchCheckedAt"]) expect(schema).toContain(`${col}:`);
  });

  it("funcionalidades novas: nível lite + interruptor próprio em Definições", async () => {
    const { AI_FEATURES } = await import("../shared/aiFeatures");
    const { AUTOMATION_FLAGS } = await import("../shared/appSettings");
    for (const f of ["complaint_triage", "review_auto_draft", "whatsapp_triage", "lost_found_match"] as const) {
      expect(AI_FEATURES[f].tier).toBe("lite");
      expect(AI_FEATURES[f].essential).toBe(false);
      expect(AUTOMATION_FLAGS.map((x) => x.name)).toContain(AI_FEATURES[f].flag);
    }
  });
});
