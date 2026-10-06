/**
 * P3 lote 24d — decisões do Jorge (3 out 2026):
 *  - D34: a triagem do WhatsApp PROPÕE criar o caso (reclamação / perdido);
 *    uma pessoa carrega em "Criar" ou "Não é". Um caso por conversa;
 *  - D35: "Parar promoções" (botão, escrito, ou na app do WhatsApp) = STOP,
 *    partilhado com o be-multipark.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { caseDraftFromMessages, caseProposalKind, CASE_PROPOSAL_LABEL } from "../shared/whatsappConversation";
import { detectOptIntent, optOutSourceForText, preferenceIntent } from "../shared/whatsappOptOut";
import { parseWebhookPayload } from "./whatsappInbound";
import { MIGRATION_0450_STATEMENTS } from "./migrations/migration_0450";
import { SCHEMA_MIGRATION_IDS } from "./migrations";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("D34 — proposta de caso", () => {
  const base = { aiIntent: "reclamacao", employeeId: null, caseId: null, caseProposalDismissedAt: null };
  it("só reclamação/perdido, só clientes, nunca depois de criado ou de 'Não é'", () => {
    expect(caseProposalKind(base)).toBe("complaint");
    expect(caseProposalKind({ ...base, aiIntent: "perdido_achado" })).toBe("lost");
    for (const i of ["reserva", "alteracao", "cancelamento", "outro", null]) expect(caseProposalKind({ ...base, aiIntent: i })).toBeNull();
    expect(caseProposalKind({ ...base, employeeId: 4 })).toBeNull();
    expect(caseProposalKind({ ...base, caseId: 12 })).toBeNull();
    expect(caseProposalKind({ ...base, caseProposalDismissedAt: "2026-10-03 10:00:00" })).toBeNull();
    expect(CASE_PROPOSAL_LABEL.complaint.link(7)).toBe("/reclamacoes?id=7");
    expect(CASE_PROPOSAL_LABEL.lost.link(7)).toBe("/perdidos-achados/caso/7");
  });

  it("rascunho: só o que o cliente escreveu (sem marcadores de ficheiro), as mais recentes cabem", () => {
    const d = caseDraftFromMessages([
      { direction: "in", body: "Bom dia" },
      { direction: "out", body: "Olá, em que podemos ajudar?" },
      { direction: "in", body: "[imagem]" },
      { direction: "in", body: "O meu carro veio com um risco na porta" },
    ]);
    expect(d.title).toBe("WhatsApp: Bom dia");
    expect(d.description).toBe("Mensagens do cliente no WhatsApp:\n— Bom dia\n— O meu carro veio com um risco na porta");
    const long = caseDraftFromMessages([{ direction: "in", body: "a".repeat(100) }, { direction: "in", body: "b".repeat(50) }], 60);
    expect(long.description).toContain("b".repeat(50));
    expect(long.description).not.toContain("a".repeat(100));
    expect(caseDraftFromMessages([]).title).toBe("WhatsApp: mensagem do cliente");
  });

  it("servidor: reserva a conversa antes de criar (um caso só), desfaz se falhar; mesmos passos do criar à mão", () => {
    const m = src("server/whatsappCaseProposal.ts");
    expect(m).toContain(".set({ caseKind: kind, caseId: null })");
    expect(m).toContain("isNull(whatsappConversations.caseKind)");
    expect(m).toContain(".set({ caseKind: null, caseId: null })");
    expect(m).toContain("autoLinkComplaintBooking(id)");
    expect(m).toContain("notifyComplaintCreated(id)");
    expect(m).toContain("autoLinkLostFoundBooking(id)");
    expect(m).toContain('kind: "lost_found_new"');
    expect(m).toContain("const projectId = conv.bookingProjectId ?? fallbackProjectId;");
    expect(m).not.toMatch(/\.delete\(|DELETE FROM/);
  });

  it("rotas: criar pede editar no módulo do caso e ver a conversa; 'Não é' pede editar no WhatsApp", () => {
    const r = src("server/routers.ts");
    const create = r.slice(r.indexOf("createCase: protectedProcedure"), r.indexOf("dismissCaseProposal: protectedProcedure"));
    expect(create).toContain('requireAccess(ctx.user, input.kind === "complaint" ? "reclamacoes" : "perdidos", "edit");');
    expect(create).toContain("conversationVisible(input.conversationId, ctx.user)");
    expect(create).toContain("createCaseFromConversation(input.conversationId, input.kind, ctx.user.id, defaultScopedProjectId())");
    const dismiss = r.slice(r.indexOf("dismissCaseProposal: protectedProcedure"), r.indexOf("dismissCaseProposal: protectedProcedure") + 700);
    expect(dismiss).toContain('requireAccess(ctx.user, "whatsapp", "edit");');
  });

  it("ecrã: faixa com Criar / Não é por cima das mensagens; depois do caso, o link", () => {
    const bar = src("client/src/components/whatsapp/CaseProposalBar.tsx");
    expect(bar).toContain("A triagem acha que isto é <strong>{l.noun}</strong>.");
    expect(bar).toContain("Não é");
    expect(bar).toContain("criado a partir desta conversa.");
    expect(src("client/src/pages/WhatsAppInboxPage.tsx")).toMatch(/<CaseProposalBar t=\{t\} \/>\}\s*<MessageThread/);
    expect(src("server/whatsappInbox.ts")).toContain("caseProposal: caseProposalKind(conv),");
  });

  it("migração 0450: só colunas novas", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0450")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0445"));
    const all = MIGRATION_0450_STATEMENTS.join("\n");
    for (const c of ["`caseKind`", "`caseId`", "`caseProposalDismissedAt`", "`optOutSource`"]) expect(all).toContain(c);
    expect(all).not.toMatch(/\bDELETE\b|\bDROP\b|\bUPDATE\b/);
  });
});

describe("D35 — Parar promoções = STOP, partilhado", () => {
  it("o botão / texto 'Parar promoções' é um STOP; frases claras também; conversa normal não", () => {
    for (const t of ["Parar promoções", "PARAR PROMOÇÕES!", "Stop promotions", "parar publicidade", "não quero promoções"]) {
      expect(detectOptIntent(t)).toBe("opt_out");
      expect(optOutSourceForText(t)).toBe("promocoes");
    }
    expect(detectOptIntent("Por favor parem as promoções")).toBe("opt_out");
    expect(detectOptIntent("Vou parar o carro na promoção do parque")).toBeNull();
    expect(detectOptIntent("quero deixar de receber as promoções")).toBe("opt_out");
    expect(detectOptIntent("Tem promoções para o Natal?")).toBeNull();
    expect(optOutSourceForText("STOP")).toBe("stop");
    expect(detectOptIntent("Retomar promoções")).toBe("opt_in");
  });

  it("user_preferences da Meta (marketing stop/resume) → STOP/INICIAR", () => {
    expect(preferenceIntent({ category: "marketing_messages", value: "stop" })).toBe("opt_out");
    expect(preferenceIntent({ category: "marketing_messages", value: "resume" })).toBe("opt_in");
    expect(preferenceIntent({ category: "other", value: "stop" })).toBeNull();
    const payload = {
      entry: [{ changes: [{ field: "user_preferences", value: {
        metadata: { phone_number_id: "PN1" },
        user_preferences: [
          { wa_id: "351912345678", category: "marketing_messages", value: "stop", detail: "User requested to stop marketing messages" },
          { wa_id: "351900000000", category: "outra", value: "stop" },
        ],
      } }] }],
    };
    const parsed = parseWebhookPayload(payload, "PN1");
    expect(parsed.preferences).toEqual([{ from: "351912345678", intent: "opt_out" }]);
    expect(parseWebhookPayload(payload, "OUTRO").preferences).toEqual([]);
  });

  it("webhook: grava a origem; a preferência da app não responde ao cliente; número novo fica numa conversa resolvida", () => {
    const w = src("server/whatsappInbound.ts");
    expect(w).toContain("optOutSourceForText(m.body)");
    expect(w).toContain(".set({ optedOutAt: now, optOutSource: source })");
    expect(w).toContain(".set({ optedOutAt: null, optOutSource: null })");
    expect(w).toContain('await applyOptIntent(db, p.intent, c.id, phoneE164, "meta", { confirm: false });');
    expect(w).toContain('.values({ phoneE164, status: "resolvido", statusChangedAt: now })');
    expect(w).toContain("for (const p of parsed.preferences) await handlePreference(db, p);");
    expect(src("client/src/pages/WhatsAppInboxPage.tsx")).toContain("OPT_OUT_SOURCE_LABEL[t.optOutSource as OptOutSource]");
  });
});
