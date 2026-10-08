/**
 * 49f — Central de recrutamento / a IA separa emails e WhatsApp pelas caixas
 * (lote 41 ponto 13 + Jorge, 8 out 2026: "a IA vê os e-mails que entram nas
 * caixas partilhadas e age sozinha… divide-os pelas caixas sem ler; o que não
 * perceber vai para o info. No WhatsApp o mesmo: se já houver conversa antes,
 * deixa estar. Recrutamento em 1.º contacto → criação de candidato").
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: null as any, log: vi.fn() }));
vi.mock("./db", () => ({ getDb: async () => h.db, logActivity: h.log }));

import {
  aiIntakeNote, commsRoutingSettings, decideRoutedBox, emailRoutingEligible, firstContactPlan, normalizeCandidate, normalizeConfidence,
  routingNoteText, whatsappRoutingPlan, COMMS_ROUTING_DEFAULTS, WHATSAPP_NEW_CONVERSATION_HOURS,
} from "../shared/commsRouting";
import { GENERAL_BOX_KEY, availableTargets } from "../shared/commsBoxes";
import { AUTOMATION_FLAGS, SETTINGS, automationFlagDefault, validateSetting } from "../shared/appSettings";
import { AI_FEATURES } from "../shared/aiFeatures";
import { LEAD_SOURCES, LEAD_SOURCE_LABELS } from "../shared/extraLeadsFunnel";
import { isCandidaturaLead } from "../shared/leadTasks";
import {
  candidateFromEmail, candidateFromWhatsapp, classifyEmailWithAi, routeEmailMessage, routeWhatsappConversation, runPendingEmailRoutings, stripQuoted,
  type EmailRoutingDeps, type EmailRoutingMessage, type WhatsappConversationLite, type WhatsappRoutingDeps,
} from "./commsRouting";
import { contactOf, leadNameFor, onRecruitmentFirstContact, phoneTail, type FirstContactStore } from "./recruitmentFirstContact";
import { MIGRATION_0595_STATEMENTS } from "./migrations/migration_0595";
import { SCHEMA_MIGRATION_IDS } from "./migrations";
import { setAiProvidersForTests } from "./_core/ai/client";
import { createFakeDb, createFakeProvider, okResponse } from "./_core/ai/testUtils";
import { resetAiUsageCachesForTests } from "./_core/ai/usage";
import { invalidateSettingsCache } from "./appSettings";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const BOXES = [
  { key: "info", label: "Geral (info@)", active: true },
  { key: "rh", label: "RH", active: true, pipeline: "recursos-humanos" },
  { key: "reservas", label: "Reservas", active: true },
  { key: "reclamacoes", label: "Reclamações", active: true },
  { key: "faturacao", label: "Faturação", active: true },
  { key: "parcerias", label: "Parcerias", active: false },
];
const TARGETS = availableTargets(BOXES);

// ─── Regras puras ────────────────────────────────────────────────────────────

describe("resposta da IA → caixa (abaixo do limiar, geral ou inválida → info)", () => {
  const opts = { minConfidence: 0.7 };
  it("caixa válida e certa → essa caixa", () => {
    expect(decideRoutedBox({ box: "Reservas", confidence: 0.92 }, TARGETS, opts)).toMatchObject({ boxKey: "reservas", understood: true, confidence: 0.92 });
    expect(decideRoutedBox({ box: "rh", confidence: 85 }, TARGETS, opts)).toMatchObject({ boxKey: "rh", confidence: 0.85 });
  });
  it("dúvida, geral, caixa inativa ou inventada → info", () => {
    expect(decideRoutedBox({ box: "reservas", confidence: 0.5 }, TARGETS, opts)).toMatchObject({ boxKey: GENERAL_BOX_KEY, aiBoxKey: "reservas", understood: false });
    expect(decideRoutedBox({ box: "geral", confidence: 0.99 }, TARGETS, opts).boxKey).toBe(GENERAL_BOX_KEY);
    expect(decideRoutedBox({ box: "parcerias", confidence: 0.99 }, TARGETS, opts).boxKey).toBe(GENERAL_BOX_KEY);
    expect(decideRoutedBox({ box: "marketing", confidence: 0.99 }, TARGETS, opts).boxKey).toBe(GENERAL_BOX_KEY);
    expect(decideRoutedBox({ box: "reservas" }, TARGETS, opts).boxKey).toBe(GENERAL_BOX_KEY);
  });
  it("confiança normalizada e definições com omissão", () => {
    expect(normalizeConfidence("0,8")).toBe(0.8);
    expect(normalizeConfidence(null)).toBeNull();
    expect(normalizeConfidence("x")).toBeNull();
    expect(normalizeConfidence(250)).toBe(1);
    expect(commsRoutingSettings(null)).toEqual({ ...COMMS_ROUTING_DEFAULTS });
    expect(commsRoutingSettings({ minConfidence: 0.8, perRun: 5 })).toEqual({ minConfidence: 0.8, perRun: 5 });
    expect(validateSetting("ai.commsRouting", { minConfidence: 2, perRun: 5 }).ok).toBe(false);
    expect(SETTINGS["ai.commsRouting"].defaultValue).toEqual({ minConfidence: 0.7, perRun: 10 });
  });
});

describe("email: que mensagens se separam", () => {
  const base = { outbound: false, personal: false, systemMail: false, automated: false, newThread: true, mailboxKey: "info", pipeline: null, createdCase: false };
  it("mensagem nova recebida numa caixa partilhada → sim (incluindo a recursos-humanos@)", () => {
    expect(emailRoutingEligible(base)).toBe(true);
    expect(emailRoutingEligible({ ...base, mailboxKey: "reservas" })).toBe(true);
    expect(emailRoutingEligible({ ...base, mailboxKey: "rh", pipeline: "recursos-humanos" })).toBe(true);
  });
  it("resposta num fio que já existe, pessoais, enviados, automáticos, casos criados e emails de máquinas → não", () => {
    expect(emailRoutingEligible({ ...base, newThread: false })).toBe(false);
    expect(emailRoutingEligible({ ...base, personal: true })).toBe(false);
    expect(emailRoutingEligible({ ...base, outbound: true })).toBe(false);
    expect(emailRoutingEligible({ ...base, automated: true })).toBe(false);
    expect(emailRoutingEligible({ ...base, systemMail: true })).toBe(false);
    expect(emailRoutingEligible({ ...base, mailboxKey: null })).toBe(false);
    expect(emailRoutingEligible({ ...base, createdCase: true })).toBe(false);
    for (const p of ["reclamacoes", "perdidos", "criticas", "campanhas", "ocorrencias"]) expect(emailRoutingEligible({ ...base, pipeline: p })).toBe(false);
  });
  it("só a mensagem nova vai à IA (sem o histórico citado)", () => {
    expect(stripQuoted("Quero trabalhar.\n\nEm 3 out, X escreveu:\n> antigo")).toBe("Quero trabalhar.");
    expect(stripQuoted("> citado\nnovo")).toBe("novo");
  });
});

describe("WhatsApp: conversa com caixa ou antiga fica; nova vai para a caixa do tema", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const base = { boxKey: null, boxSource: null, employeeId: null, isLead: false, intent: null, confidence: null, firstMessageAtMs: now - 60_000, nowMs: now };
  const opts = { minConfidence: 0.7 };
  it("já tem caixa (IA, regra ou à mão) → não mexe", () => {
    expect(whatsappRoutingPlan({ ...base, boxKey: "reservas", boxSource: "ai", intent: "reclamacao", confidence: 0.99 }, opts)).toEqual({ action: "leave", why: "has_box" });
    expect(whatsappRoutingPlan({ ...base, boxKey: null, boxSource: "manual", intent: "reserva", confidence: 0.99 }, opts)).toEqual({ action: "leave", why: "has_box" });
  });
  it("conversa anterior (1.ª mensagem há mais de 48 h) → não mexe", () => {
    const old = now - (WHATSAPP_NEW_CONVERSATION_HOURS + 1) * 3_600_000;
    expect(whatsappRoutingPlan({ ...base, firstMessageAtMs: old, intent: "reserva", confidence: 0.9 }, opts)).toEqual({ action: "leave", why: "old_conversation" });
  });
  it("nova: colaborador/candidato → RH (regra); intenção certa → caixa; outro ou dúvida → Geral", () => {
    expect(whatsappRoutingPlan({ ...base, employeeId: 3 }, opts)).toMatchObject({ action: "route", boxKey: "rh", boxSource: "rule" });
    expect(whatsappRoutingPlan({ ...base, intent: "reserva", confidence: 0.9 }, opts)).toMatchObject({ action: "route", boxKey: "reservas", boxSource: "ai", understood: true });
    expect(whatsappRoutingPlan({ ...base, intent: "recrutamento", confidence: 0.9 }, opts)).toMatchObject({ boxKey: "rh", understood: true });
    expect(whatsappRoutingPlan({ ...base, intent: "outro", confidence: 0.9 }, opts)).toMatchObject({ action: "route", boxKey: null, understood: false });
    expect(whatsappRoutingPlan({ ...base, intent: "reserva", confidence: 0.3 }, opts)).toMatchObject({ action: "route", boxKey: null, understood: false });
    expect(whatsappRoutingPlan(base, opts)).toEqual({ action: "leave", why: "no_intent" });
  });
});

describe("dados do candidato e regra do 1.º contacto", () => {
  it("os marcadores são repostos depois da IA; nomes com números/@ não passam", () => {
    const restore = (s: string) => s.replace("[TELEFONE_1]", "912 345 678").replace("[EMAIL_1]", "Ana@Gmail.com");
    const c = normalizeCandidate({ candidateName: "Ana Sousa", candidatePhone: "[TELEFONE_1]", candidateEmail: "[EMAIL_1]", candidateCity: "Gaia", hasLicense: "sim", licenseYears: 6, availability: "fins de semana" }, restore);
    expect(c).toEqual({ fullName: "Ana Sousa", phone: "912 345 678", email: "ana@gmail.com", city: "Gaia", hasLicense: true, licenseYears: 6, availability: "fins de semana" });
    expect(normalizeCandidate({ candidateName: "[NIF_1]", candidatePhone: "[TELEFONE_2]" }).fullName).toBeNull();
    expect(normalizeCandidate({ candidatePhone: "[TELEFONE_2]" }).phone).toBeNull();
    expect(normalizeCandidate({ licenseYears: 400, hasLicense: "desconhecido" })).toMatchObject({ licenseYears: null, hasLicense: null });
  });
  it("email: o remetente ganha quando é uma pessoa; portal/no-reply → o email lido no corpo", () => {
    const c = { output: { box: "rh", confidence: 0.9, reason: "CV", candidate: true, candidateEmail: "[EMAIL_1]" } as any, restore: (s: string) => s.replace("[EMAIL_1]", "rui@gmail.com") };
    expect(candidateFromEmail(c, { fromName: "Ana Sousa", fromEmail: "ana@sapo.pt" })).toMatchObject({ email: "ana@sapo.pt", fullName: "Ana Sousa" });
    expect(candidateFromEmail(c, { fromName: "Portal", fromEmail: "no-reply@jobs.pt" }).email).toBe("rui@gmail.com");
  });
  it("WhatsApp: telefone da conversa, nome do perfil, email e cidade escritos", () => {
    const c = candidateFromWhatsapp({ phoneE164: "+351912345678", profileName: "Rui Costa", inboundText: "Olá, moro em Gaia e queria trabalhar. rui@x.pt" });
    expect(c).toMatchObject({ fullName: "Rui Costa", phone: "+351912345678", email: "rui@x.pt", city: "Porto" });
    expect(candidateFromWhatsapp({ phoneE164: "+351912345678", profileName: "🚗", inboundText: "" }).fullName).toBeNull();
  });
  it("cria só quando não há ficha, lead nem candidatura; precisa de email ou telefone", () => {
    const k = { email: "a@b.pt", phoneE164: null };
    expect(firstContactPlan({ employee: false, lead: false, application: false }, k)).toBe("create");
    expect(firstContactPlan({ employee: true, lead: false, application: false }, k)).toBe("employee");
    expect(firstContactPlan({ employee: false, lead: true, application: false }, k)).toBe("existing");
    expect(firstContactPlan({ employee: false, lead: false, application: true }, k)).toBe("existing");
    expect(firstContactPlan({ employee: false, lead: false, application: false }, { email: null, phoneE164: null })).toBe("invalid");
    expect(aiIntakeNote("email", { hasLicense: true, licenseYears: 1, availability: null }, "Envia CV")).toBe("Entrou pela IA (email) · Envia CV · carta há 1 ano");
    expect(contactOf({ email: "no-reply@x.pt", phone: "912345678" })).toEqual({ email: null, phoneE164: "+351912345678", phone: "+351912345678" });
    expect(leadNameFor({ fullName: null, email: "joana.m@x.pt", phoneE164: null })).toBe("Candidato joana.m");
    expect(phoneTail("+351912345678")).toBe("912345678");
  });
  it("linha no ecrã: movido, deixou, falhou, corrigido", () => {
    const label = (k: string | null) => ({ rh: "RH", info: "Geral (info@)" } as Record<string, string>)[k ?? "info"] ?? String(k);
    const base = { status: "moved", via: "ai", boxKey: "rh", fromBoxKey: "info", reason: "Envia CV", confidence: 0.93, correctedBoxKey: null };
    expect(routingNoteText(base, label)).toBe("Movido pela IA → RH (Envia CV · 93%)");
    expect(routingNoteText({ ...base, status: "failed", boxKey: "info", reason: null, confidence: null }, label)).toBe("A IA não conseguiu ler — ficou em Geral (info@)");
    expect(routingNoteText({ ...base, correctedBoxKey: "info" }, label)).toContain("corrigido à mão → Geral (info@)");
    expect(routingNoteText({ ...base, status: "pending" }, label)).toBeNull();
  });
});

// ─── Email: o encaminhador (dependências falsas) ─────────────────────────────

function emailDeps(o: Partial<EmailRoutingDeps> & { output?: any; fail?: boolean } = {}) {
  const calls = { claim: 0, classify: 0, move: [] as Array<[number, string]>, record: [] as any[], firstContact: [] as any[], afterRh: [] as any[] };
  const claimed = new Set<number>();
  const deps: EmailRoutingDeps = {
    enabled: async () => true,
    settings: async () => ({ minConfidence: 0.7, perRun: 10 }),
    boxes: async () => BOXES,
    claim: async (m) => { calls.claim++; if (claimed.has(m.messageId)) return false; claimed.add(m.messageId); return true; },
    classify: async () => {
      calls.classify++;
      if (o.fail) throw Object.assign(new Error("timeout"), { code: "timeout" });
      return { output: o.output ?? { box: "reservas", confidence: 0.92, reason: "Pede preço de reserva" }, restore: (s: string) => s.replace("[TELEFONE_1]", "912345678") };
    },
    move: async (t, b) => { calls.move.push([t, b]); return true; },
    record: async (_m, p) => { calls.record.push(p); },
    firstContact: async (i) => { calls.firstContact.push(i); return { outcome: "created", leadId: 77, applicationId: 5 }; },
    cityProjectId: async (t) => (t === "Porto" ? 2 : null),
    afterRh: async (t, x) => { calls.afterRh.push([t, x]); },
    ...o,
  };
  return { deps, calls };
}
const MSG: EmailRoutingMessage = { threadId: 10, messageId: 100, fromBoxKey: "info", subject: "Preço", text: "Quanto custa?", fromName: "Ana Sousa", fromEmail: "ana@sapo.pt", attachmentNames: [], projectId: null };

describe("email novo → caixa certa (por ler); dúvida ou falha → info", () => {
  it("interruptor desligado = nada (nem reserva, nem IA, nem mover)", async () => {
    const { deps, calls } = emailDeps({ enabled: async () => false });
    expect(await routeEmailMessage(MSG, deps)).toEqual({ status: "off" });
    expect(calls).toMatchObject({ claim: 0, classify: 0, move: [], record: [] });
  });
  it("certo → move para a caixa do tema e regista o motivo", async () => {
    const { deps, calls } = emailDeps();
    const r = await routeEmailMessage(MSG, deps);
    expect(r).toMatchObject({ status: "moved", boxKey: "reservas" });
    expect(calls.move).toEqual([[10, "reservas"]]);
    expect(calls.record[0]).toMatchObject({ status: "moved", via: "ai", aiBoxKey: "reservas", boxKey: "reservas", confidence: 0.92, reason: "Pede preço de reserva" });
    expect(calls.firstContact).toEqual([]);
  });
  it("lida uma só vez: a 2.ª vez nem chama a IA", async () => {
    const { deps, calls } = emailDeps();
    await routeEmailMessage(MSG, deps);
    expect(await routeEmailMessage(MSG, deps)).toEqual({ status: "seen" });
    expect(calls.classify).toBe(1);
  });
  it("dúvida → info; falha da IA → info (nunca se perde)", async () => {
    const a = emailDeps({ output: { box: "reservas", confidence: 0.4, reason: "Pouco claro" } });
    expect(await routeEmailMessage({ ...MSG, fromBoxKey: "reservas" }, a.deps)).toMatchObject({ status: "moved", boxKey: "info" });
    expect(a.calls.record[0]).toMatchObject({ aiBoxKey: "reservas", boxKey: "info" });
    const b = emailDeps({ fail: true });
    expect(await routeEmailMessage({ ...MSG, fromBoxKey: "reservas" }, b.deps)).toMatchObject({ status: "failed", boxKey: "info" });
    expect(b.calls.record[0]).toMatchObject({ status: "failed", via: "fallback", error: "timeout", boxKey: "info" });
  });
  it("a IA diz a caixa onde já está → fica (kept); sem info ativa a dúvida fica onde entrou", async () => {
    const a = emailDeps({ output: { box: "rh", confidence: 0.95, reason: "Escala", candidate: false } });
    expect(await routeEmailMessage({ ...MSG, fromBoxKey: "rh" }, a.deps)).toMatchObject({ status: "kept", boxKey: "rh" });
    expect(a.calls.move).toEqual([]);
    const b = emailDeps({ boxes: async () => BOXES.filter((x) => x.key !== "info"), output: { box: "geral", confidence: 0.9, reason: "?" } });
    expect(await routeEmailMessage({ ...MSG, fromBoxKey: "reservas" }, b.deps)).toMatchObject({ status: "kept", boxKey: "reservas" });
  });
  it("teto da corrida: sem espaço fica 'pending' para o varrimento (sem IA)", async () => {
    const { deps, calls } = emailDeps();
    const run = { left: 0 };
    expect(await routeEmailMessage(MSG, deps, run)).toEqual({ status: "pending" });
    expect(calls.classify).toBe(0);
    expect(calls.claim).toBe(1);
  });
  it("recrutamento: vai para o RH, corre o pipeline do RH e cria o candidato com o que a IA leu", async () => {
    const { deps, calls } = emailDeps({ output: { box: "rh", confidence: 0.9, reason: "Envia CV", candidate: true, candidateName: "Ana Sousa", candidatePhone: "[TELEFONE_1]", candidateCity: "Porto", hasLicense: "sim", licenseYears: 4 } });
    const r = await routeEmailMessage({ ...MSG, attachmentNames: ["CV.pdf"] }, deps);
    expect(r).toMatchObject({ status: "moved", boxKey: "rh", recruit: { outcome: "created", leadId: 77 } });
    expect(calls.firstContact[0]).toMatchObject({ channel: "email", sourceRef: "ai:mail_thread:10", projectId: 2, candidate: { email: "ana@sapo.pt", phone: "912345678", fullName: "Ana Sousa", licenseYears: 4 } });
    expect(calls.afterRh).toEqual([[10, { moved: true, leadId: 77 }]]);
    expect(calls.record[0]).toMatchObject({ recruitOutcome: "created", leadId: 77, applicationId: 5 });
  });
  it("RH com pouca certeza ou que não é candidato (colaborador) → não cria candidato", async () => {
    const a = emailDeps({ output: { box: "rh", confidence: 0.5, reason: "?", candidate: true } });
    await routeEmailMessage(MSG, a.deps);
    expect(a.calls.firstContact).toEqual([]);
    const b = emailDeps({ output: { box: "rh", confidence: 0.9, reason: "Pergunta pelo salário", candidate: false } });
    await routeEmailMessage(MSG, b.deps);
    expect(b.calls.firstContact).toEqual([]);
    // Um email do RH que não é candidatura não entra na lista do Recrutamento (nem vira lead pela importação).
    expect(b.calls.afterRh).toEqual([]);
    expect(b.calls.move).toEqual([[10, "rh"]]);
  });
});

// ─── IA a sério (fornecedor falso): saída validada e dados pessoais tapados ───

describe("classificação pela IA (zod + dados pessoais)", () => {
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

  it("só o 1.º nome, telefone/email tapados; a resposta passa no zod e repõe-se o telefone", async () => {
    const out = { box: "rh", confidence: 0.91, reason: "Pede emprego", candidate: true, candidateName: "Ana Sousa", candidatePhone: "[TELEFONE_1]" };
    const fake = createFakeProvider("gemini", [okResponse(JSON.stringify(out))]);
    setAiProvidersForTests({ gemini: fake });
    const msg = { ...MSG, subject: "Emprego", text: "Olá, sou a Ana Sousa, quero ser condutora. Liguem 912 345 678 ou ana.s@gmail.com", fromName: "Ana Sousa Pereira" };
    const r = await classifyEmailWithAi(msg, TARGETS, "Geral (info@)");
    expect(r.output).toMatchObject(out);
    expect(r.restore(String(r.output.candidatePhone))).toBe("912 345 678");
    const sent = fake.calls[0].parts.map((p: any) => p.text ?? "").join("\n");
    expect(sent).not.toContain("912 345 678");
    expect(sent).not.toContain("ana.s@gmail.com");
    expect(sent).toContain("Remetente: Ana");
    expect(sent).not.toContain("Pereira");
    expect(fake.calls[0].jsonSchema).toBeTruthy();
  });
  it("resposta fora do schema → erro (o encaminhador manda para o info)", async () => {
    setAiProvidersForTests({ gemini: createFakeProvider("gemini", [okResponse(JSON.stringify({ box: "rh" }))]) });
    await expect(classifyEmailWithAi(MSG, TARGETS, "Geral")).rejects.toMatchObject({ code: "invalid_output" });
  });
  it("interruptor desligado → nenhuma chamada ao fornecedor", async () => {
    process.env.AI_MAIL_ROUTING = "off";
    const fake = createFakeProvider("gemini", [okResponse("{}")]);
    setAiProvidersForTests({ gemini: fake });
    await expect(classifyEmailWithAi(MSG, TARGETS, "Geral")).rejects.toMatchObject({ code: "disabled" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("mover não marca como lida; correções à mão ficam registadas", () => {
  beforeEach(() => { h.db = createFakeDb(() => [{ affectedRows: 1 }]); });
  it("moveThreadToBox só muda a caixa (a conversa fica por ler)", async () => {
    const { moveThreadToBox } = await import("./mail/service");
    expect(await moveThreadToBox(10, "rh", "ai")).toBe(true);
    const all = h.db.queries.map((q: any) => q.sql).join("\n");
    expect(all).toContain("UPDATE mail_threads SET routedFromKey");
    expect(all).not.toMatch(/isRead|unreadCount/);
  });
  it("mover à mão (email e WhatsApp) regista quem corrigiu a IA", () => {
    expect(src("server/mail/inbox.ts")).toContain('noteManualBoxChange("email", threadId, target.key, viewer.id)');
    expect(src("server/routers.ts")).toContain('noteManualBoxChange("whatsapp", input.conversationId, input.boxKey === GENERAL_BOX_KEY ? null : input.boxKey, ctx.user.id)');
  });
});

describe("varrimento dos emails que ficaram por separar", () => {
  it("interruptor desligado → não lê nada", async () => {
    h.db = createFakeDb();
    const { deps, calls } = emailDeps({ enabled: async () => false });
    expect(await runPendingEmailRoutings({}, deps)).toEqual({ routed: 0, skipped: "disabled" });
    expect(h.db.queries).toHaveLength(0);
    expect(calls.classify).toBe(0);
  });
});

// ─── WhatsApp: o encaminhador usa a triagem (sem 2.ª chamada à IA) ───────────

function waDeps(conv: Partial<WhatsappConversationLite> = {}, o: Partial<WhatsappRoutingDeps> = {}) {
  const calls = { claim: 0, setBox: [] as any[], record: [] as any[], firstContact: [] as any[] };
  const c: WhatsappConversationLite = { id: 5, boxKey: null, boxSource: null, employeeId: null, isLead: false, phoneE164: "+351912345678", profileName: "Rui Costa", firstMessageAtMs: Date.now() - 60_000, inboundText: "Boa tarde, procuram motoristas? Sou do Porto", ...conv };
  const claimed = new Set<number>();
  const deps: WhatsappRoutingDeps = {
    enabled: async () => true,
    settings: async () => ({ minConfidence: 0.7, perRun: 10 }),
    load: async () => c,
    claim: async (id) => { calls.claim++; if (claimed.has(id)) return false; claimed.add(id); return true; },
    setBox: async (id, b, s) => { calls.setBox.push([id, b, s]); return true; },
    record: async (_id, p) => { calls.record.push(p); },
    firstContact: async (i) => { calls.firstContact.push(i); return { outcome: "created", leadId: 9, applicationId: null }; },
    cityProjectId: async (t) => (t === "Porto" ? 2 : null),
    ...o,
  };
  return { deps, calls };
}

describe("WhatsApp: conversa nova → caixa + etiqueta; com conversa anterior não mexe", () => {
  it("interruptor desligado = nada", async () => {
    const { deps, calls } = waDeps({}, { enabled: async () => false });
    expect(await routeWhatsappConversation(5, { intent: "reserva", confidence: 0.9, reason: "x" }, deps)).toEqual({ status: "off" });
    expect(calls).toMatchObject({ claim: 0, setBox: [], record: [] });
  });
  it("conversa que já tem caixa → fica onde está (nem reserva o registo)", async () => {
    const { deps, calls } = waDeps({ boxKey: "reservas", boxSource: "ai" });
    expect(await routeWhatsappConversation(5, { intent: "reclamacao", confidence: 0.99, reason: "x" }, deps)).toMatchObject({ status: "leave", why: "has_box" });
    expect(calls.claim).toBe(0);
    expect(calls.setBox).toEqual([]);
  });
  it("nova → caixa do tema, registada uma vez (a 2.ª triagem já não mexe)", async () => {
    const { deps, calls } = waDeps();
    expect(await routeWhatsappConversation(5, { intent: "reserva", confidence: 0.9, reason: "Quer reservar" }, deps)).toMatchObject({ status: "moved", boxKey: "reservas" });
    expect(calls.setBox).toEqual([[5, "reservas", "ai"]]);
    expect(calls.record[0]).toMatchObject({ status: "moved", via: "triage", boxKey: "reservas", reason: "Quer reservar" });
    expect(await routeWhatsappConversation(5, { intent: "reserva", confidence: 0.9, reason: "x" }, deps)).toEqual({ status: "seen" });
  });
  it("dúvida → Geral (marcada como decidida, para não voltar a mexer)", async () => {
    const { deps, calls } = waDeps();
    expect(await routeWhatsappConversation(5, { intent: "outro", confidence: 0.9, reason: "Saudação" }, deps)).toMatchObject({ status: "kept", boxKey: null });
    expect(calls.setBox).toEqual([[5, null, "ai"]]);
  });
  it("recrutamento em 1.º contacto → RH + candidato com telefone, nome do perfil e cidade", async () => {
    const { deps, calls } = waDeps();
    const r = await routeWhatsappConversation(5, { intent: "recrutamento", confidence: 0.95, reason: "Procura trabalho" }, deps);
    expect(r).toMatchObject({ status: "moved", boxKey: "rh", recruit: { outcome: "created", leadId: 9 } });
    expect(calls.firstContact[0]).toMatchObject({ channel: "whatsapp", sourceRef: "ai:whatsapp:5", projectId: 2, candidate: { fullName: "Rui Costa", phone: "+351912345678", city: "Porto" } });
  });
  it("colaborador → RH pela regra, sem criar candidato", async () => {
    const { deps, calls } = waDeps({ employeeId: 3 });
    expect(await routeWhatsappConversation(5, { intent: "recrutamento", confidence: 0.95, reason: "x" }, deps)).toMatchObject({ boxKey: "rh" });
    expect(calls.setBox).toEqual([[5, "rh", "rule"]]);
    expect(calls.firstContact).toEqual([]);
  });
  it("a triagem é a única chamada à IA: o encaminhador do WhatsApp não chama o runAi", () => {
    const r = src("server/commsRouting.ts");
    const wa = r.slice(r.indexOf("// ─── WhatsApp ───"), r.indexOf("// ─── Correções à mão"));
    expect(wa).not.toContain("runAi");
    expect(wa).not.toContain("classify");
    const t = src("server/whatsappTriage.ts");
    expect(t.match(/runAi\(/g)?.length).toBe(1);
    expect(t).toContain("routeAfterTriage(conversationId, { intent, confidence: normalizeConfidence(r.output.confidence)");
    expect(t).not.toContain("applyBoxFromIntent");
  });
});

// ─── Recrutamento em 1.º contacto: lead + candidatura sem duplicar ──────────

function memStore(init: { employees?: any[]; leads?: any[]; apps?: any[] } = {}) {
  const st = { employees: [...(init.employees ?? [])], leads: [...(init.leads ?? [])], apps: [...(init.apps ?? [])], sources: [] as any[], logs: [] as any[], notes: [] as any[], tasks: [] as number[] };
  const store: FirstContactStore = {
    findActiveEmployee: async (c) => st.employees.find((e) => (c.email && e.email === c.email) || (c.phoneE164 && e.phoneE164 === c.phoneE164)) ?? null,
    findLead: async (c) => st.leads.find((l) => (c.email && l.email === c.email) || (c.phoneE164 && l.phoneE164 === c.phoneE164)) ?? null,
    findApplication: async (c) => st.apps.find((a) => (c.email && a.email === c.email) || (c.phoneE164 && a.phoneE164 === c.phoneE164)) ?? null,
    createApplication: async (row) => { if (st.apps.some((a) => a.email === row.email)) return null; const id = st.apps.length + 1; st.apps.push({ id, ...row }); return id; },
    createLead: async (row) => { if (st.leads.some((l) => l.sourceRef === row.sourceRef)) return null; const id = st.leads.length + 100; st.leads.push({ id, ...row }); return id; },
    appendLeadNote: async (id, note) => { st.notes.push([id, note]); },
    markSources: async (refs) => { st.sources.push(...refs); },
    log: async (e) => { st.logs.push(e); },
    afterLeadCreated: async (id) => { st.tasks.push(id); },
  };
  return { st, store };
}
const CAND = { fullName: "Ana Sousa", phone: "912 345 678", email: "ana@sapo.pt", city: "Porto", hasLicense: true, licenseYears: 5, availability: "noites" };

describe("recrutamento em 1.º contacto", () => {
  it("ninguém conhece a pessoa → candidatura + lead (source email), nota 'Entrou pela IA', origens marcadas, tarefa", async () => {
    const { st, store } = memStore();
    const r = await onRecruitmentFirstContact({ channel: "email", sourceRef: "ai:mail_thread:10", candidate: CAND, projectId: 2, reason: "Envia CV" }, store);
    expect(r).toEqual({ outcome: "created", leadId: 100, applicationId: 1, candidateEmployeeId: null });
    expect(st.apps[0]).toMatchObject({ email: "ana@sapo.pt", fullName: "Ana Sousa", phone: "+351912345678", city: "Porto", howDidYouKnow: "Email (IA)", drivingExperience: "5 anos de carta" });
    expect(st.apps[0].payload).toMatchObject({ source: "email", via: "ia", sourceRef: "ai:mail_thread:10" });
    expect(st.leads[0]).toMatchObject({ source: "email", sourceRef: "ai:mail_thread:10", phoneE164: "+351912345678", email: "ana@sapo.pt", projectId: 2 });
    expect(st.leads[0].notes).toContain("Entrou pela IA (email)");
    expect(st.sources).toEqual([{ sourceRef: "ai:mail_thread:10", leadId: 100, outcome: "created" }, { sourceRef: "application:1", leadId: 100, outcome: "merged" }]);
    expect(st.tasks).toEqual([100]);
  });
  it("já é lead (mesmo telefone) → não duplica: só acrescenta a nota", async () => {
    const { st, store } = memStore({ leads: [{ id: 7, phoneE164: "+351912345678", email: null }] });
    const r = await onRecruitmentFirstContact({ channel: "whatsapp", sourceRef: "ai:whatsapp:5", candidate: { ...CAND, email: null }, projectId: null, reason: null }, store);
    expect(r).toMatchObject({ outcome: "existing", leadId: 7 });
    expect(st.leads).toHaveLength(1);
    expect(st.apps).toHaveLength(0);
    expect(st.notes[0][1]).toContain("Voltou a escrever por WhatsApp");
  });
  it("já tem candidatura do site (mesmo email) → não cria outra nem lead nova", async () => {
    const { st, store } = memStore({ apps: [{ id: 3, email: "ana@sapo.pt" }] });
    expect(await onRecruitmentFirstContact({ channel: "email", sourceRef: "ai:mail_thread:11", candidate: CAND, projectId: null, reason: null }, store)).toMatchObject({ outcome: "existing", applicationId: 3 });
    expect(st.apps).toHaveLength(1);
    expect(st.leads).toHaveLength(0);
  });
  it("colaborador ativo → não cria nada", async () => {
    const { st, store } = memStore({ employees: [{ id: 1, fullName: "Ana Sousa", email: "ana@sapo.pt" }] });
    expect(await onRecruitmentFirstContact({ channel: "email", sourceRef: "ai:mail_thread:12", candidate: CAND, projectId: null, reason: null }, store)).toMatchObject({ outcome: "employee" });
    expect(st.apps).toHaveLength(0);
    expect(st.leads).toHaveLength(0);
  });
  it("WhatsApp sem email → só a lead (a candidatura do site precisa de email); sem contactos → nada", async () => {
    const { st, store } = memStore();
    const r = await onRecruitmentFirstContact({ channel: "whatsapp", sourceRef: "ai:whatsapp:6", candidate: { ...CAND, email: null }, projectId: null, reason: "Procura trabalho" }, store);
    expect(r).toMatchObject({ outcome: "created", applicationId: null });
    expect(st.leads[0]).toMatchObject({ source: "whatsapp", email: null });
    expect(st.apps).toHaveLength(0);
    expect(await onRecruitmentFirstContact({ channel: "email", sourceRef: "ai:x", candidate: { ...CAND, email: null, phone: null }, projectId: null, reason: null }, store)).toMatchObject({ outcome: "invalid" });
  });
  it("corrida: a lead já foi criada pela mesma origem → não duplica", async () => {
    const { st, store } = memStore({ leads: [{ id: 1, sourceRef: "ai:whatsapp:7", phoneE164: "+351999999999" }] });
    const r = await onRecruitmentFirstContact({ channel: "whatsapp", sourceRef: "ai:whatsapp:7", candidate: { ...CAND, email: null, phone: "913000000" }, projectId: null, reason: null }, store);
    expect(r.outcome).toBe("existing");
    expect(st.leads).toHaveLength(1);
  });
  it("com candidatura cria a ficha de candidato (49h); nunca escreve a ninguém", () => {
    const f = src("server/recruitmentFirstContact.ts");
    expect(f).toContain("s.createCandidateEmployee({ applicationId, email: contact.email");
    expect(f).not.toMatch(/sendEmail|sendTemplate|replyToConversation|notify\(/);
  });
});

// ─── Interruptor, definições, leads, migração, ecrã, ajuda ──────────────────

describe("interruptor único, ligado por omissão", () => {
  it("AI_MAIL_ROUTING: emails e WhatsApp, ligado; nada de interruptores de 'sugestões'", () => {
    const f = AUTOMATION_FLAGS.find((x) => x.name === "AI_MAIL_ROUTING")!;
    expect(f.label).toBe("IA: separar emails e WhatsApp pelas caixas");
    expect(f.group).toBe("ia");
    expect(automationFlagDefault("AI_MAIL_ROUTING")).toBe(true);
    expect(f.description).toContain("Nunca responde a ninguém");
    expect(AUTOMATION_FLAGS.some((x) => /AI_RECRUIT/.test(x.name))).toBe(false);
    expect(AI_FEATURES.mail_routing).toMatchObject({ flag: "AI_MAIL_ROUTING", tier: "lite" });
  });
  it("leads e tarefas: origem WhatsApp", () => {
    expect(LEAD_SOURCES).toContain("whatsapp");
    expect(LEAD_SOURCE_LABELS.whatsapp).toBe("WhatsApp");
    expect(isCandidaturaLead({ source: "whatsapp" })).toBe(true);
  });
  it("varrimento ai-comms apanha o que ficou por separar", () => {
    expect(src("server/commsAiSweep.ts")).toContain('await step("routing", async () => (await import("./commsRouting")).runPendingEmailRoutings({ limit: 4, deadlineAt }));');
    expect(src("server/mail/service.ts")).toContain("makeOnStored(api, report, brandDomains, { deadlineAt: opts.deadlineAt })");
  });
});

describe("migração 0595 e nunca apagar", () => {
  it("só cria a tabela (UNIQUE na origem) e está registada", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0595");
    expect(MIGRATION_0595_STATEMENTS).toHaveLength(1);
    expect(MIGRATION_0595_STATEMENTS[0]).toMatch(/^CREATE TABLE IF NOT EXISTS `comms_ai_routing`/);
    expect(MIGRATION_0595_STATEMENTS[0]).toContain("UNIQUE KEY `uq_comms_ai_routing_ref` (`sourceRef`)");
  });
  it("nenhum DELETE nos ficheiros novos", () => {
    for (const f of ["server/commsRouting.ts", "server/recruitmentFirstContact.ts", "server/commsRoutingRouter.ts", "shared/commsRouting.ts", "server/migrations/migration_0595.ts"]) {
      expect(src(f), f).not.toMatch(/\bDELETE\b|\.delete\(|\bDROP\b|TRUNCATE/);
    }
  });
});

describe("ecrã", () => {
  it("'Movido pela IA' no email e no WhatsApp; 'Entraram pela IA' no Recrutamento com uma linha na página", () => {
    expect(src("client/src/components/mail/MailThreadView.tsx")).toContain('<AiRoutingNote channel="email" id={threadId}');
    expect(src("client/src/pages/WhatsAppInboxPage.tsx")).toContain('<AiRoutingNote channel="whatsapp" id={t.conversationId} />');
    const page = src("client/src/pages/ExtraLeadsPage.tsx");
    expect(page).toContain('<TabsContent value="recrutamento" className="mt-4 space-y-4"><RecruitmentAiIntake /><RecruitmentSection /></TabsContent>');
    const ui = src("client/src/components/RecruitmentAiIntake.tsx");
    for (const t of ["Entraram pela IA", "Candidato criado", "Já existia", "Já é colaborador", "Abrir conversa"]) expect(ui).toContain(t);
  });
  it("ajuda: comunicação, leads de extras e definições", () => {
    expect(src("docs/ajuda/comunicacao.md")).toContain("Movido pela IA");
    expect(src("docs/ajuda/leads-extras.md")).toContain("Entraram pela IA");
    expect(src("docs/ajuda/definicoes.md")).toContain("IA: separar emails e WhatsApp pelas caixas");
    expect(src("server/assistant/helpDocs.generated.ts")).toContain("Entraram pela IA");
  });
});
