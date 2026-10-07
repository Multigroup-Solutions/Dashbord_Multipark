/**
 * 41d — Recrutamento (Jorge, 7 out 2026: "ver o que não é recrutamento e
 * mandares para o lixo… não conseguimos tirar nada daí, damos ok e nada, não dá
 * para cancelar, fica aí para sempre").
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyRecruitmentEmail, countRecruitmentStates, recruitmentStateOf } from "../shared/recruitmentEmails";
import { MIGRATION_0510_STATEMENTS } from "./migrations/migration_0510";
import { SCHEMA_MIGRATION_IDS } from "./migrations";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("41d — o que não é candidatura vai sozinho para o lixo", () => {
  it("avisos de entrega, respostas automáticas e no-reply → lixo", () => {
    expect(classifyRecruitmentEmail({ subject: "Delivery Status Notification (Delay)", fromEmail: "mailer-daemon@googlemail.com", fromName: "Mail Delivery Subsystem" })).toBe("not_recruitment");
    expect(classifyRecruitmentEmail({ subject: "Olá", fromEmail: "no-reply@accounts.google.com" })).toBe("not_recruitment");
    expect(classifyRecruitmentEmail({ subject: "Resposta automática: Disponibilidade da semana", fromEmail: "ana@gmail.com" })).toBe("not_recruitment");
    expect(classifyRecruitmentEmail({ subject: "RE: Disponibilidade semana 12/10", fromEmail: "rui@gmail.com" })).toBe("not_recruitment");
    expect(classifyRecruitmentEmail({ subject: "Security alert", fromEmail: "x@y.pt" })).toBe("not_recruitment");
    expect(recruitmentStateOf({ subject: "Delivery Status Notification (Failure)", fromEmail: "mailer-daemon@googlemail.com" })).toEqual({ state: "trash", auto: true });
  });

  it("candidaturas nunca vão sozinhas para o lixo; na dúvida, ficam por tratar", () => {
    expect(classifyRecruitmentEmail({ subject: "Nova Candidatura - Paulo Fernandes", fromEmail: "pausan.empresa@gmail.com", fromName: "Multidriver" })).toBe("recruitment");
    expect(classifyRecruitmentEmail({ subject: "Envio CV", fromEmail: "noreply@jobs.pt" })).toBe("recruitment");
    expect(classifyRecruitmentEmail({ subject: "Bom dia", fromEmail: "joana@gmail.com", bodyText: "Gostava de trabalhar como motorista" })).toBe("recruitment");
    expect(classifyRecruitmentEmail({ subject: "Bom dia", fromEmail: "joana@gmail.com", bodyText: "Tudo bem?" })).toBe("unsure");
    expect(recruitmentStateOf({ subject: "Bom dia", fromEmail: "joana@gmail.com" })).toEqual({ state: "open", auto: false });
  });

  it("a escolha da pessoa manda sempre (repor tira do lixo automático)", () => {
    const bounce = { subject: "Delivery Status Notification (Delay)", fromEmail: "mailer-daemon@googlemail.com" };
    expect(recruitmentStateOf({ ...bounce, recruitmentState: "open" })).toEqual({ state: "open", auto: false });
    expect(recruitmentStateOf({ subject: "Nova Candidatura - X", recruitmentState: "trash" })).toEqual({ state: "trash", auto: false });
    expect(recruitmentStateOf({ subject: "Nova Candidatura - X", recruitmentState: "done" }).state).toBe("done");
    expect(countRecruitmentStates([bounce, { subject: "Nova Candidatura - Y" }, { subject: "Z", recruitmentState: "done" }])).toEqual({ open: 1, done: 1, trash: 1 });
  });

  it("migração só acrescenta colunas e corre sozinha no arranque", () => {
    expect(MIGRATION_0510_STATEMENTS.every((s) => s.startsWith("ALTER TABLE `inbound_emails` ADD COLUMN"))).toBe(true);
    expect(SCHEMA_MIGRATION_IDS).toContain("0510");
  });

  it("rotas: mudar de sítio pede edição, só emails de recrutamento, fica registado; responder marca como pronta", () => {
    const r = src("server/rhRouter.ts");
    const set = r.split("setRecruitmentState: protectedProcedure")[1].split("replyRecruitment:")[0];
    expect(set).toContain(`requireAccess(ctx.user, "leads_extras", "edit")`);
    expect(set).toContain(`eq(inboundEmails.alias, "recursos-humanos")`);
    expect(set).toContain("logActivity(");
    expect(set).not.toMatch(/\.delete\(|DELETE FROM/);
    expect(r).toContain(`set({ recruitmentState: "done"`);
  });

  it("ecrã: Por tratar / Prontas / Lixo, Pronta, Lixo, Repor e Desfazer", () => {
    const ui = src("client/src/components/RecruitmentSection.tsx");
    for (const t of ["Pronta", "Lixo", "Repor", "Desfazer", "não é candidatura", "emailId:"]) expect(ui).toContain(t);
    const c = src("client/src/components/CandidaturasSection.tsx");
    expect(c).toContain(`changeStatus(a, "reviewed")`);
    expect(c).toContain(`changeStatus(a, "new")`);
    expect(c).toContain("Desfazer");
  });
});
