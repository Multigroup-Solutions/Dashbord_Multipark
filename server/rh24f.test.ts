/**
 * P3 lote 24f — D39 (Jorge, 3 out 2026): todos os anexos dos emails do RH
 * passam pela IA (interruptor desligado por omissão). Do CV: nome, NIF, BI/CC,
 * carta, cidade só quando é certa, outros contactos → candidato (só campos
 * vazios; depois passa para a ficha do colaborador) + resumo para quem entrevista.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RH_ATTACHMENT_MAX_AGE_DAYS,
  attachmentReadPlan,
  canSeeLeadIdentity,
  planLeadFromAttachment,
  redactLeadIdentity,
  validDocNumber,
  validLeadNif,
} from "../shared/rhAttachments";
import { parseAttachmentsJson } from "./rhAttachmentReader";
import { leadIdentityPatch } from "./extrasAutomation";
import { AI_FEATURES } from "../shared/aiFeatures";
import { AUTOMATION_FLAGS } from "../shared/appSettings";
import { MIGRATION_0460_STATEMENTS } from "./migrations/migration_0460";
import { SCHEMA_MIGRATION_IDS } from "./migrations";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("o que se lê", () => {
  it("PDF, imagem e Word; o resto fica 'não lido' com o motivo", () => {
    expect(attachmentReadPlan({ filename: "cv.pdf", contentType: "application/pdf", size: 1000, url: "u" })).toEqual({ ok: true, input: "pdf", mimeType: "application/pdf" });
    expect(attachmentReadPlan({ filename: "cc.JPG", contentType: "application/octet-stream", size: 1000, key: "k" })).toEqual({ ok: true, input: "image", mimeType: "image/jpeg" });
    expect(attachmentReadPlan({ filename: "cv.docx", contentType: "", size: 1000, url: "u" })).toMatchObject({ ok: true, input: "docx" });
    expect(attachmentReadPlan({ filename: "cv.doc", contentType: "application/msword", size: 1000, url: "u" })).toMatchObject({ ok: false });
    expect(attachmentReadPlan({ filename: "cv.pdf", contentType: "application/pdf", size: 9 * 1024 * 1024, url: "u" })).toEqual({ ok: false, reason: "demasiado grande (máx. 8 MB)" });
    expect(attachmentReadPlan({ filename: "cv.pdf", contentType: "application/pdf", size: 10 })).toEqual({ ok: false, reason: "ficheiro não guardado" });
    expect(parseAttachmentsJson('[{"filename":"a.pdf"},null,3]')).toEqual([{ filename: "a.pdf" }]);
    expect(parseAttachmentsJson("não é json")).toEqual([]);
    expect(RH_ATTACHMENT_MAX_AGE_DAYS).toBe(14);
  });
});

describe("o que vai para o candidato (só vazios, só válidos)", () => {
  const lead = { nif: null, idDocNumber: null, drivingLicenseNumber: null, projectId: null, phone: "+351912345678", email: null, aiSummary: null };
  const opts = { cityProjectId: 7, normalizePhone: (p: string) => (p.replace(/\D/g, "").length === 9 ? `+351${p.replace(/\D/g, "")}` : null), normalizeEmail: (e: string) => (e.includes("@") ? e.toLowerCase() : null) };

  it("NIF com dígito de controlo, números de documento plausíveis, cidade só se certa", () => {
    expect(validLeadNif("123 456 789")).toBe("123456789");
    expect(validLeadNif("123456780")).toBeNull();
    expect(validDocNumber("12345678 9 ZZ1")).toBe("123456789ZZ1");
    expect(validDocNumber("ABC")).toBeNull();
    const p = planLeadFromAttachment(lead, {
      docKind: "cv", nif: "123456789", idDocNumber: "12345678 9ZZ1", drivingLicenseNumber: "L-123456 7", city: "Lisboa", cityCertain: true,
      phones: ["912345678", "913 333 333"], emails: ["Ana@Mail.pt"], summary: "Carta B há 10 anos; fala inglês.",
    }, opts);
    expect(p.patch).toMatchObject({ nif: "123456789", idDocNumber: "123456789ZZ1", drivingLicenseNumber: "L-1234567", projectId: 7, email: "ana@mail.pt", aiSummary: "Carta B há 10 anos; fala inglês." });
    expect(p.patch.phone).toBeUndefined(); // já tinha telefone
    expect(p.otherContacts).toEqual(["+351913333333"]);
    expect(planLeadFromAttachment(lead, { cityCertain: false, city: "Lisboa" }, opts).patch.projectId).toBeUndefined();
  });

  it("nunca substitui o que o candidato já tem", () => {
    const full = { nif: "111111111", idDocNumber: "X1234567", drivingLicenseNumber: "Y1234567", projectId: 3, phone: "+351911111111", email: "a@b.pt", aiSummary: "antigo" };
    const p = planLeadFromAttachment(full, { docKind: "id_card", nif: "123456789", idDocNumber: "99999999", cityCertain: true, summary: "novo" }, opts);
    expect(p.patch).toEqual({});
    // o resumo de um CV novo substitui (é o mais recente para quem entrevista)
    expect(planLeadFromAttachment(full, { docKind: "cv", summary: "CV novo" }, opts).patch).toEqual({ aiSummary: "CV novo" });
  });

  it("ao converter em extra passam para a ficha, só se lá estiverem vazios", () => {
    expect(leadIdentityPatch({ nif: "123456789", idDocNumber: "X1", drivingLicenseNumber: "Y1" }, { nif: null, idDocNumber: "", drivingLicenseNumber: "JA" })).toEqual({ nif: "123456789", idDocNumber: "X1" });
    expect(leadIdentityPatch({ nif: "123456789" }, null)).toEqual({});
  });
});

describe("RGPD: NIF e números só o RH vê", () => {
  it("front/back office e admin+ veem; team leader e supervisor não", () => {
    for (const r of ["frontoffice", "backoffice", "admin", "super_admin"]) expect(canSeeLeadIdentity(r)).toBe(true);
    for (const r of ["team_leader", "supervisor", "driver", "extra", null]) expect(canSeeLeadIdentity(r)).toBe(false);
    expect(redactLeadIdentity({ id: 1, nif: "1", idDocNumber: "2", drivingLicenseNumber: "3", aiSummary: "ok" })).toEqual({ id: 1, nif: null, idDocNumber: null, drivingLicenseNumber: null, aiSummary: "ok" });
  });
  it("lista, criar e editar tiram os números a quem não é RH; leituras pedem ver o candidato", () => {
    const r = src("server/routers.ts");
    expect(r.match(/canSeeLeadIdentity\(ctx\.user\.role\) \? (rows|row) : /g)?.length).toBe(3);
    const reads = r.slice(r.indexOf("attachmentReads: protectedProcedure"), r.indexOf("attachmentReads: protectedProcedure") + 900);
    expect(reads).toContain('requireAccess(ctx.user, "leads_extras", "view");');
    expect(reads).toContain("assertLeadVisible(lead)");
  });
});

describe("ligado com cuidado", () => {
  it("interruptor próprio, desligado por omissão; corre no varrimento da IA, não na sincronização do email", () => {
    expect(AI_FEATURES.hr_email_attachments).toMatchObject({ flag: "AI_HR_EMAIL_ATTACHMENTS", tier: "lite" });
    expect(AUTOMATION_FLAGS.find((f) => f.name === "AI_HR_EMAIL_ATTACHMENTS")?.defaultEnabled).toBe(false);
    expect(src("server/commsAiSweep.ts")).toContain('runRhAttachmentSweep({ limit: 2, deadlineAt })');
    expect(src("server/jobs/emailInboundSync.ts")).not.toContain("rhAttachmentReader");
    const rd = src("server/rhAttachmentReader.ts");
    expect(rd).toContain('aiFeatureAvailableFresh("hr_email_attachments")');
    expect(rd).toContain("e.targetModule = 'rh'");
    expect(rd).toContain("inArray(extraLeadSources.sourceRef, recent.map((e) => `email:${e.id}`))");
    expect(rd).toContain("sources.filter((r) => r.leadId != null)");
    // regista ANTES de mexer no candidato (um anexo nunca é aplicado duas vezes)
    expect(rd.indexOf('status: "done"')).toBeLessThan(rd.indexOf("await applyToLead(db, base.leadId, x)"));
    expect(rd).not.toMatch(/\.delete\(|DELETE FROM/);
  });

  it("migração 0460: tabela nova e colunas novas; nada se apaga", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0460")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0455"));
    const all = MIGRATION_0460_STATEMENTS.join("\n");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS `rh_attachment_reads`");
    expect(all).toContain("UNIQUE KEY `uq_rh_attachment_reads` (`inboundEmailId`, `attachmentIndex`)");
    for (const c of ["`extra_leads` ADD COLUMN `nif`", "`extra_leads` ADD COLUMN `aiSummary`", "`employees` ADD COLUMN `idDocNumber`", "`employees` ADD COLUMN `drivingLicenseNumber`"]) expect(all).toContain(c);
    expect(all).not.toMatch(/\bDELETE\b|\bDROP\b|\bUPDATE\b/);
  });

  it("o prompt pede o resumo sem dados pessoais", () => {
    expect(src("server/_core/ai/prompts/hrAttachment.ts")).toContain("sem dados pessoais (nada de NIF, números de documentos, telefones ou emails)");
  });
});
