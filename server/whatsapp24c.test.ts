/**
 * P3 lote 24c — decisões do Jorge (3 out 2026):
 *  - D33: mensagem aceite pela Meta ≠ enviada. Fica "Aceite" ('accepted', 0445)
 *    até o webhook dizer 'sent'; depois entregue → lido, ou falhou;
 *  - D32: difusões de uma pessoa não repetem o mesmo template ao mesmo número
 *    antes de 24 h, e pedem "Confirmar" antes de enviar a várias pessoas.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCEPTED_STATUS, finishOutboundMessage, isOutboundOk, nextStatus } from "./whatsappStore";
import { RECENT_TEMPLATE_ERROR, RECENT_TEMPLATE_HOURS, summarize, type BroadcastRecipient } from "./whatsappBroadcast";
import { MIGRATION_0445_STATEMENTS, WHATSAPP_MESSAGE_STATUS_ENUM_SQL } from "./migrations/migration_0445";
import { MIGRATION_0350_STATEMENTS } from "./migrations/migration_0350";
import { SCHEMA_MIGRATION_IDS } from "./migrations";
import { BROADCAST_CONFIRM_MIN, broadcastConfirmText, needsBroadcastConfirm } from "../shared/whatsappBroadcastRules";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("D33 — Aceite → Enviado → Entregue/Lido/Falhou", () => {
  it("aceite sobe com o webhook e nunca recua", () => {
    expect(nextStatus("accepted", "sent")).toBe("sent");
    expect(nextStatus("accepted", "delivered")).toBe("delivered");
    expect(nextStatus("accepted", "read")).toBe("read");
    expect(nextStatus("accepted", "failed")).toBe("failed");
    expect(nextStatus("sent", "sent")).toBeNull();
    expect(nextStatus("read", "sent")).toBeNull();
    // o que já existia continua igual
    expect(nextStatus("pending", "sent")).toBe("sent");
    expect(nextStatus("unknown", "sent")).toBe("sent");
    expect(nextStatus("failed", "read")).toBeNull();
  });

  it("aceite conta como saída que pode ter chegado (contas da difusão)", () => {
    for (const s of ["accepted", "sent", "delivered", "read"]) expect(isOutboundOk(s)).toBe(true);
    for (const s of ["pending", "unknown", "failed", null]) expect(isOutboundOk(s)).toBe(false);
  });

  it("a Meta aceitar o envio grava 'accepted' (não 'sent') e limpa o 'por responder'", async () => {
    const sets: any[] = [];
    const db: any = {
      update: () => ({ set: (v: any) => { sets.push(v); return { where: async () => undefined }; } }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      delete: () => ({ where: async () => undefined }),
    };
    const st = await finishOutboundMessage(db, 7, { conversationId: 3, type: "text", body: "olá" }, { ok: true, waMessageId: "wamid.X" });
    expect(st).toBe(ACCEPTED_STATUS);
    expect(sets[0]).toMatchObject({ status: "accepted", waMessageId: "wamid.X", errorDetail: null });
    expect(sets[1]).toMatchObject({ awaitingSince: null, slaAlertedAt: null });
  });

  it("migração 0445: 'accepted' no FIM do ENUM; a 0350 (que corre em cada arranque) já não o encolhe", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0445")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0440"));
    expect(WHATSAPP_MESSAGE_STATUS_ENUM_SQL).toBe("ENUM('pending','sent','delivered','read','failed','unknown','accepted')");
    expect(MIGRATION_0445_STATEMENTS.join("\n")).toContain(WHATSAPP_MESSAGE_STATUS_ENUM_SQL);
    expect(MIGRATION_0350_STATEMENTS.join("\n")).toContain(WHATSAPP_MESSAGE_STATUS_ENUM_SQL);
    expect(MIGRATION_0445_STATEMENTS.join("\n")).not.toMatch(/\bDELETE\b|\bDROP\b|\bUPDATE\b/);
    expect(src("drizzle/schema.ts")).toContain("status: mysqlEnum(['pending', 'sent', 'delivered', 'read', 'failed', 'unknown', 'accepted'])");
  });

  it("o pedido de autorização para ligar também fica 'aceite'; difusão falhada depois de aceite desconta", () => {
    expect(src("server/whatsappCallsRouter.ts")).toContain('status: sent.ok ? "accepted" : "failed",');
    expect(src("server/whatsappInbound.ts")).toMatch(/if \(isOutboundOk\(prevStatus\)\) \{\s*await db\.execute\(sql`UPDATE whatsapp_broadcasts SET sentCount = GREATEST\(sentCount - 1, 0\)/);
  });

  it("no ecrã: ícone e nome de cada estado (Aceite esbatido ≠ Enviado)", () => {
    const t = src("client/src/components/whatsapp/MessageThread.tsx");
    expect(t).toContain('accepted: "Aceite pela Meta — ainda sem aviso de que saiu"');
    expect(t).toContain('sent: "Enviado"');
    expect(t).toMatch(/case "accepted":\s*return <Check className="h-3 w-3 opacity-40" \/>;/);
    expect(t).toContain('<span role="img" aria-label={label} title={label}');
  });
});

describe("D32 — difusões: o mesmo template não volta antes de 24 h", () => {
  const b = src("server/whatsappBroadcast.ts");

  it("quem já recebeu fica de fora e não conta como falha", () => {
    const r = (status: BroadcastRecipient["status"]): BroadcastRecipient => ({ employeeId: 1, name: "A", phone: "1", phoneE164: "+3511", status });
    const sum = summarize([r("sent"), r("recent_template"), r("recent_template"), r("failed")]);
    expect(sum).toMatchObject({ sent: 1, failed: 1, recentTemplate: 2, notSent: 1 });
    expect(RECENT_TEMPLATE_HOURS).toBe(24);
    expect(RECENT_TEMPLATE_ERROR).toMatch(/últimas 24 h/);
  });

  it("a consulta: mesmo template, saída, 24 h, falhado de certeza não bloqueia, o próprio envio (retoma) não conta", () => {
    const q = b.slice(b.indexOf("async function recentTemplatePhones"), b.indexOf("async function recentTemplatePhones") + 900);
    expect(q).toContain("m.direction = 'out' AND m.type = 'template' AND m.templateName = ${templateName}");
    expect(q).toContain("m.status <> 'failed'");
    expect(q).toContain("m.createdAt >= NOW() - INTERVAL ${RECENT_TEMPLATE_HOURS} HOUR");
    expect(q).toContain("(m.broadcastId IS NULL OR m.broadcastId <> ${broadcastId})");
    // depois da retoma (17b) e antes de gastar token/chamada à Meta
    const d = b.slice(b.indexOf("async function dispatchOne"));
    expect(d.indexOf("cfg.recentTemplate?.has(r.phoneE164)")).toBeGreaterThan(d.indexOf("duplicateRequestOutcome(prev)"));
    expect(d.indexOf("cfg.recentTemplate?.has(r.phoneE164)")).toBeLessThan(d.indexOf("issueAvailabilityFormToken"));
  });

  it("vale para as difusões de uma pessoa (não no teste) e para os leads; os automáticos do Extras-Dia não", () => {
    expect(src("server/routers.ts")).toContain("blockRecentSameTemplate: !input.testPhone,");
    expect(b).toContain("const recentTemplate = opts.blockRecentSameTemplate ? await recentTemplatePhones(db, prep.templateName, broadcastId) : undefined;");
    expect(b).toContain("recentTemplate: await recentTemplatePhones(db, prep.templateName, broadcastId),");
    expect(src("server/extrasAutomation.ts")).not.toContain("blockRecentSameTemplate");
    expect(src("server/extraLeads.ts")).toContain('r.status === "duplicate_phone" || r.status === "recent_template"');
  });
});

describe("D32 — Confirmar antes de enviar a várias pessoas", () => {
  it("regra partilhada", () => {
    expect(BROADCAST_CONFIRM_MIN).toBe(2);
    expect(needsBroadcastConfirm(1)).toBe(false);
    expect(needsBroadcastConfirm(2)).toBe(true);
    expect(broadcastConfirmText("Seja motorista", 12)).toBe("Vais enviar “Seja motorista” a 12 pessoas. Quem já recebeu este template nas últimas 24 h fica de fora. Confirmas?");
  });

  it("Extras-Dia e Leads: primeiro clique pede confirmação, o segundo envia", () => {
    for (const p of ["client/src/pages/ExtrasDiaPage.tsx", "client/src/pages/ExtraLeadsPage.tsx"]) {
      const s = src(p);
      expect(s).toContain("needsBroadcastConfirm(");
      expect(s).toContain("broadcastConfirmText(");
      expect(s).toMatch(/Confirmar envio a \$\{/);
      expect(s).toContain('"Voltar"');
      expect(s).toContain("recent_template");
    }
  });
});
