/**
 * P3 lote 18b — Leads de extras. Decisão do Jorge (2 out 2026): converter um
 * lead (ou aprovar uma candidatura) de quem já teve ficha desativada →
 * "Bloqueia, reativa com confirmação" (roubo/despedimento nunca; ficha junta
 * → a que ficou). E ainda: arquivar em vez de apagar, âmbito de cidade nas
 * candidaturas, rejeitar fecha o lead, cidade pela terra, erro ≠ vazio.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blockedFichaMessage, leadFichaDecision, mergedTargetId, pickFicha } from "../shared/extraLeadsConvert";
import { cityKeyFromPlace, cityKeyFromText } from "../shared/city";
import { cityTextVisible } from "./extrasCityFilter";
import { cityProjectIdFromText } from "./extraLeadsSync";
import { moduleForPath } from "./_core/accessContext";
import { MIGRATION_0380_STATEMENTS } from "./migrations/migration_0380";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { EXTRA_LEADS_LIST_LIMIT } from "../shared/extraLeadsFunnel";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("Converter/Aprovar quem já teve ficha", () => {
  it("ficha ativa → liga-se (como sempre)", () => {
    expect(leadFichaDecision({ id: 1, isActive: 1 }, false)).toEqual({ kind: "use", reactivate: false });
  });
  it("desativada por outro motivo → mostra o motivo e só reativa com confirmação", () => {
    expect(leadFichaDecision({ id: 1, isActive: 0, deactivationReason: "inatividade" }, false)).toEqual({ kind: "confirm", reason: "Inatividade" });
    expect(leadFichaDecision({ id: 1, isActive: 0, deactivationReason: "inatividade" }, true)).toEqual({ kind: "use", reactivate: true });
    expect(leadFichaDecision({ id: 1, isActive: 0, deactivationReason: null }, false)).toEqual({ kind: "confirm", reason: "Inatividade" });
    expect(leadFichaDecision({ id: 1, isActive: 0, deactivationReason: "outro", deactivationReasonOther: "Mudou-se" }, false)).toEqual({ kind: "confirm", reason: "Mudou-se" });
  });
  it("roubo, despedimento e ficha junta sem destino → nunca, nem com confirmação", () => {
    for (const r of ["roubou", "despedido", "ficha_duplicada", "conta_duplicada"]) {
      expect(leadFichaDecision({ id: 1, isActive: 0, deactivationReason: r }, true).kind).toBe("blocked");
    }
    expect(blockedFichaMessage({ id: 12, fullName: "Ana", isActive: 0 }, "Roubou")).toBe("Esta pessoa já teve ficha (#12, Ana) e saiu por «Roubou»: não se reativa a partir de um lead. Fala com o RH.");
  });
  it("ficha junta a outra → segue para a que ficou", () => {
    expect(mergedTargetId({ id: 5, isActive: 0, deactivationReason: "ficha_duplicada", deactivationReasonOther: "Junta à ficha #42" })).toBe(42);
    expect(mergedTargetId({ id: 5, isActive: 1, deactivationReason: "ficha_duplicada", deactivationReasonOther: "Junta à ficha #42" })).toBeNull();
    expect(mergedTargetId({ id: 5, isActive: 0, deactivationReason: "inatividade", deactivationReasonOther: "#42" })).toBeNull();
    expect(mergedTargetId({ id: 5, isActive: 0, deactivationReason: "ficha_duplicada", deactivationReasonOther: "Junta à ficha #5" })).toBeNull();
  });
  it("várias fichas com o mesmo contacto: a ativa ganha, depois a de extra, depois a mais antiga", () => {
    expect(pickFicha([{ id: 3, isActive: 0, position: "extra" }, { id: 9, isActive: 1, position: "driver" }])?.id).toBe(9);
    expect(pickFicha([{ id: 9, isActive: 1, position: "driver" }, { id: 11, isActive: 1, position: "extra" }])?.id).toBe(11);
    expect(pickFicha([{ id: 9, isActive: 0 }, { id: 4, isActive: 0 }])?.id).toBe(4);
    expect(pickFicha([])).toBeNull();
  });
  it("o Converter e o Aprovar usam a regra; reativar limpa o motivo e fica registado", () => {
    const a = src("server/extrasAutomation.ts");
    expect(a).toContain("const d = leadFichaDecision(existing, !!opts.confirmReactivate);");
    expect(a).toContain("Já existe uma ficha com este contacto noutra cidade");
    expect(a).toContain("Object.assign(patch, { isActive: 1, deactivationReason: null, deactivationReasonOther: null, deactivationNotes: null, deactivatedAt: null, deactivatedById: null });");
    expect(a).toContain('action: "employee_reactivate"');
    // Antes reativava qualquer ficha encontrada, em silêncio.
    expect(a).not.toContain("if (emp && emp.isActive !== 1) patch.isActive = 1;");
    const w = src("server/webIntake.ts");
    expect(w).toContain("const d = leadFichaDecision(existing, !!opts.confirmReactivate);");
    expect(src("server/routers.ts")).toContain("confirmReactivate: input.confirmReactivate");
  });
  it("a reserva do Converter já não prende para sempre (10 min)", () => {
    expect(src("server/extrasAutomation.ts")).toContain("(${extraLeads.employeeId} = 0 AND ${extraLeads.updatedAt} < NOW() - INTERVAL 10 MINUTE)");
  });
});

describe("Nada se apaga: arquivar leads", () => {
  it("migração 0380, depois da 0375", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0380")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0375"));
    expect(MIGRATION_0380_STATEMENTS).toEqual([
      "ALTER TABLE `extra_leads` ADD COLUMN `archivedAt` TIMESTAMP NULL DEFAULT NULL",
      "ALTER TABLE `extra_leads` ADD COLUMN `archivedById` INT NULL",
    ]);
  });
  it("sem DELETE; arquivado sai da lista, do funil, dos envios, dos lembretes e das respostas", () => {
    const l = src("server/extraLeads.ts");
    expect(l).not.toContain("db.delete(extraLeads)");
    expect(l).toContain("const conds = [filter.archived ? sql`${extraLeads.archivedAt} IS NOT NULL` : isNull(extraLeads.archivedAt)];");
    expect(l).toContain("const conds = [gte(extraLeads.createdAt, since), isNull(extraLeads.archivedAt)];");
    expect(l).toContain('results.push({ leadId: l.id, fullName: l.fullName, status: "skipped", error: "Arquivado" });');
    expect(src("server/extrasAutomation.ts")).toContain("isNull(extraLeads.optedOutAt), isNull(extraLeads.archivedAt)));");
    expect(src("server/extraLeadsSync.ts")).toContain("and(eq(extraLeads.phoneE164, input.phoneE164), isNull(extraLeads.archivedAt))");
  });
  it("quem volta a candidatar-se sai do arquivo", () => {
    expect(src("server/extraLeadsSync.ts")).toContain("const unarchive = existing.archivedAt ? { archivedAt: null, archivedById: null } : {};");
  });
  it("lista cortada nos 500 → a página avisa", () => {
    expect(EXTRA_LEADS_LIST_LIMIT).toBe(500);
    expect(src("client/src/pages/ExtraLeadsPage.tsx")).toContain("allLeads.length >= LEADS_LIST_LIMIT");
  });
});

describe("Candidaturas: âmbito de cidade, estados e reserva", () => {
  it("setStatus e approve verificam a cidade; aprovada não volta atrás; fica registado", () => {
    const w = src("server/webIntake.ts");
    expect(w.match(/await assertApplicationVisible\(db, app\);/g)?.length).toBe(2);
    expect(w).toContain('if (app.status === "approved" && status !== "approved") {');
    expect(w).toContain('action: "driver_application_status"');
  });
  it("rejeitar fecha o lead (Sem interesse)", () => {
    expect(src("server/webIntake.ts")).toContain("await declineLeadForApplication(app, reviewedById);");
    expect(src("server/extraLeadsSync.ts")).toContain('inArray(extraLeads.status, ["new", "contacted", "replied"]), isNull(extraLeads.employeeId)');
  });
  it("aprovar tem reserva: dois cliques não criam duas fichas", () => {
    expect(src("server/webIntake.ts")).toContain('.where(and(eq(driverApplications.id, id), ne(driverApplications.status, "approved")));');
  });
  it("o aviso de candidatura nova abre o separador certo", () => {
    expect(src("server/webIntake.ts")).toContain('link: "/extras-leads?tab=candidaturas",');
  });
});

describe("Cidade escrita à mão: também pela terra", () => {
  it("Corroios → Lisboa, Gaia → Porto, Albufeira → Faro; Portimão nunca é Porto", () => {
    expect(cityKeyFromText("corroios")).toBe("lisboa");
    expect(cityKeyFromText("Vila Nova de Gaia")).toBe("porto");
    expect(cityKeyFromText("Albufeira")).toBe("faro");
    expect(cityKeyFromText("Portimão")).toBe("faro");
    expect(cityKeyFromText("Porto")).toBe("porto");
    expect(cityKeyFromText("Castelo Branco")).toBeNull();
    expect(cityKeyFromPlace("Rua X, 2855-001 Corroios")).toBe("lisboa");
  });
  it("candidatura de Corroios já não aparece ao TL de Faro; e o lead nasce em Lisboa", () => {
    expect(cityTextVisible("corroios", ["faro"])).toBe(false);
    expect(cityTextVisible("corroios", ["lisboa"])).toBe(true);
    expect(cityTextVisible("Castelo Branco", ["faro"])).toBe(true);
    const projects = [{ id: 2, name: "Lisboa", level: "city" }, { id: 3, name: "Porto", level: "city" }];
    expect(cityProjectIdFromText("Loures", projects)).toBe(2);
  });
});

describe("Recrutamento por email", () => {
  it("notas só em emails da recursos-humanos@ e registadas; resposta sempre pela recursos-humanos@; contas só por quem gere utilizadores", () => {
    const r = src("server/rhRouter.ts");
    expect(r).toContain('.where(and(eq(inboundEmails.id, input.id), eq(inboundEmails.alias, "recursos-humanos")));');
    expect(r).toContain('action: "recruitment_notes"');
    expect(r).toContain('const from = "recursos-humanos@multipark.pt";');
    expect(r).toContain('if (input.includeRegisterLink && !canAccess(ctx.user, "utilizadores", "edit")) {');
  });
  it("candidaturas, recrutamento e pontuação seguem o alcance de Leads de extras", () => {
    for (const p of ["driverApplications.approve", "rh.recruitmentEmails", "rh.setRecruitmentNotes", "rh.replyRecruitment", "aiOps.leads.scores"]) {
      expect(moduleForPath(p)).toBe("leads_extras");
    }
    expect(moduleForPath("rh.list")).toBeUndefined();
  });
});

describe("Erro ≠ vazio e automações", () => {
  it("a página mostra o erro nos três separadores", () => {
    expect(src("client/src/pages/ExtraLeadsPage.tsx")).toContain('what="os leads"');
    expect(src("client/src/pages/ExtraLeadsPage.tsx")).toContain('what="o funil"');
    expect(src("client/src/components/CandidaturasSection.tsx")).toContain('what="as candidaturas"');
    expect(src("client/src/components/RecruitmentSection.tsx")).toContain('what="os emails de recrutamento"');
  });
  it("lembrete com código de envio; entrada das candidaturas corre sem a automação dos extras; rascunho da IA não vai a quem já disse que não", () => {
    const a = src("server/extrasAutomation.ts");
    expect(a).toContain("sendKey: `leads-reminder:${clock.date}`,");
    expect(a).toContain('["leads-sync", async () => {');
    expect(src("server/aiOps/leadScoring.ts")).toContain('if (lead.status === "converted" || lead.status === "declined")');
  });
});
