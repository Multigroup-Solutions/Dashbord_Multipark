/**
 * P3 lote 17g (parte 2) — "Não enviar WhatsApp / email" por pessoa (Jorge,
 * 2 out 2026: "temos que conseguir desativar o enviar mensagem e/ou email para
 * cada um dos colaboradores ou extras"). Desliga tudo o automático ou em massa;
 * as conversas uma a uma continuam.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clearSendAsCache, sendMailWith, type SystemMailDeps } from "./mail/systemMail";
import { NO_AUTO_EMAIL_ERROR, contactPrefsLabel } from "../shared/contactPrefs";
import { MIGRATION_0370_STATEMENTS } from "./migrations/migration_0370";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function deps(blocked: Set<number>) {
  const sent: string[] = [];
  const asked: number[] = [];
  const d: SystemMailDeps = {
    async systemSender() { return "notificacoes@multipark.pt"; },
    async mailboxes() { return []; },
    async apiFor() {
      return {
        async listSendAs() { return [{ sendAsEmail: "notificacoes@multipark.pt", isPrimary: true, verificationStatus: null }]; },
        async sendRaw(raw) { sent.push(raw.toString("utf8")); return { id: "g1", threadId: null }; },
      };
    },
    dwdAvailable: () => true,
    async noAutoEmail(id) { asked.push(id); return blocked.has(id); },
  };
  return { d, sent, asked };
}

describe("Email: o 'Não enviar email' trava os automáticos, no sítio por onde todos passam", () => {
  it("automático para uma ficha com 'Não enviar email' → não sai, e não conta como falha", async () => {
    clearSendAsCache();
    const { d, sent } = deps(new Set([7]));
    const r = await sendMailWith(d, { to: "extra@gmail.com", subject: "Escala", text: "x", auto: { kind: "schedule_notice", employeeId: 7 } } as any);
    expect(r).toEqual({ ok: false, error: NO_AUTO_EMAIL_ERROR, blocked: true });
    expect(sent).toHaveLength(0);
  });
  it("outra ficha, ou um email que não é automático de uma ficha → sai normalmente", async () => {
    clearSendAsCache();
    const { d, sent, asked } = deps(new Set([7]));
    expect((await sendMailWith(d, { to: "a@gmail.com", subject: "Escala", text: "x", auto: { kind: "schedule_notice", employeeId: 8 } } as any)).ok).toBe(true);
    expect((await sendMailWith(d, { to: "b@gmail.com", subject: "Relatório", text: "x", auto: { kind: "report" } })).ok).toBe(true);
    expect(sent).toHaveLength(2);
    expect(asked).toEqual([8]);
  });
});

describe("WhatsApp e avisos: quem tem 'Não enviar' fica de fora, com o motivo", () => {
  it("difusões (disponibilidade, aviso de trabalho, regras): não envia, como um STOP, com o motivo certo", () => {
    const bc = src("server/whatsappBroadcast.ts");
    expect(bc).toContain("if (r.employeeId != null && cfg.noAutoEmployees?.has(r.employeeId)) {");
    expect(bc).toContain('return { ...r, status: "opted_out", error: NO_AUTO_WHATSAPP_ERROR };');
    expect(bc).toContain('const noAutoEmployees = await employeesWithNoAuto(resolved.map((r) => r.employeeId).filter((id): id is number => id != null), "whatsapp");');
  });
  it("pedido de disponibilidade por email, email da escala e turno cancelado (WhatsApp e email)", () => {
    const av = src("server/extrasAvailability.ts");
    expect(av).toContain('const noAuto = await employeesWithNoAuto(extras.map((e) => e.id), "email");');
    const sc = src("server/extrasSchedule.ts");
    expect(sc).toContain('for (const a of claimed) await finishNotification(a, "scheduled", "email", "opted_out", NO_AUTO_EMAIL_ERROR);');
    expect(sc).toContain('status = "opted_out"; detail = NO_AUTO_WHATSAPP_ERROR;');
    expect(sc).toContain('await finishNotification(row, "removed", "email", "opted_out", NO_AUTO_EMAIL_ERROR);');
  });
  it("as conversas uma a uma não passam pelo bloqueio (template e resposta no inbox)", () => {
    const bc = src("server/whatsappBroadcast.ts");
    expect(bc).toContain("({ ...baseDispatch(prep, broadcastId, opts.createdById, NEUTRAL_RECIPIENT_NAME), clientRequestId: opts.clientRequestId ?? null })");
  });
});

describe("Na ficha", () => {
  it("texto curto do que está desligado", () => {
    expect(contactPrefsLabel({ noAutoWhatsapp: 1, noAutoEmail: 0 })).toBe("Não enviar WhatsApp");
    expect(contactPrefsLabel({ noAutoWhatsapp: true, noAutoEmail: true })).toBe("Não enviar WhatsApp nem email");
    expect(contactPrefsLabel({})).toBeNull();
  });
  it("só o RH muda (19c, decisão do Jorge), no âmbito da cidade, e fica no registo", () => {
    const r = src("server/rhRouter.ts");
    const i = r.indexOf("setContactPrefs: protectedProcedure");
    expect(i).toBeGreaterThan(0);
    const body = r.slice(i, i + 2000);
    expect(body).toContain("if (!isRhFor(viewer, ref)) throw new TRPCError");
    expect(body).toContain("await assertEmployeeWriteScope(viewer, ref);");
    expect(body).toContain('action: "employee_contact_prefs"');
    expect(src("client/src/pages/HRPage.tsx")).toContain("<ContactPrefsRow employeeId={emp.id}");
  });
  it("migração 0370: duas colunas, depois da 0365, sem apagar nada", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0370")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0365"));
    expect(MIGRATION_0370_STATEMENTS).toEqual([
      "ALTER TABLE `employees` ADD COLUMN `noAutoWhatsapp` TINYINT NOT NULL DEFAULT 0",
      "ALTER TABLE `employees` ADD COLUMN `noAutoEmail` TINYINT NOT NULL DEFAULT 0",
    ]);
  });
});
