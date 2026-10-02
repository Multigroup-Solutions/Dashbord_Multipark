/**
 * P3 lote 17f (parte 1) — caixas por tema para o email e o WhatsApp:
 * RH, Reservas, Alterações, Serviços extra, Reclamações, Perdidos, Parcerias,
 * Faturação (+ as que já existiam). A IA separa; uma pessoa pode mover; cada
 * um vê as caixas do seu módulo e a sua cidade (ou as sem cidade).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GENERAL_BOX_KEY, INTENT_BOX, TOPIC_BOX_SEEDS, availableTargets, canSeeBoxModule, parseRoutingAnswer, whatsappBoxFor,
} from "../shared/commsBoxes";
import { WHATSAPP_INTENTS, mapWhatsappIntent } from "../shared/commsAi";
import { mailboxConfigSchema, sourceAccountKey } from "../shared/mail";
import { matchesBoxFilter } from "../shared/whatsappInboxView";
import { automationFlagDefault } from "../shared/appSettings";
import { MIGRATION_0365_STATEMENTS } from "./migrations/migration_0365";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("WhatsApp: em que caixa fica a conversa", () => {
  const base = { boxKey: null, boxSource: null, employeeId: null, isLead: false, intent: null } as const;
  it("colaborador ou candidato → RH (regra); cliente → pela intenção da IA", () => {
    expect(whatsappBoxFor({ ...base, employeeId: 5 })).toEqual({ boxKey: "rh", boxSource: "rule" });
    expect(whatsappBoxFor({ ...base, isLead: true, intent: "reclamacao" })).toEqual({ boxKey: "rh", boxSource: "rule" });
    expect(whatsappBoxFor({ ...base, intent: "alteracao" })).toEqual({ boxKey: "alteracoes", boxSource: "ai" });
    expect(whatsappBoxFor({ ...base, intent: "faturacao" })).toEqual({ boxKey: "faturacao", boxSource: "ai" });
  });
  it("à mão nunca muda; sem novidade não mexe", () => {
    expect(whatsappBoxFor({ ...base, boxKey: "parcerias", boxSource: "manual", employeeId: 5, intent: "reserva" })).toBeNull();
    expect(whatsappBoxFor({ ...base, boxKey: "rh", boxSource: "rule", employeeId: 5 })).toBeNull();
    expect(whatsappBoxFor({ ...base, boxKey: "reservas", boxSource: "ai", intent: "reserva" })).toBeNull();
    expect(whatsappBoxFor(base)).toBeNull();
  });
  it("todas as intenções têm caixa; a IA conhece os temas novos", () => {
    for (const i of WHATSAPP_INTENTS) expect(INTENT_BOX[i]).toBeTruthy();
    expect(INTENT_BOX.outro).toBe(GENERAL_BOX_KEY);
    expect(mapWhatsappIntent("Lavagem")).toBe("servicos_extra");
    expect(mapWhatsappIntent("fatura")).toBe("faturacao");
    expect(mapWhatsappIntent("parceria")).toBe("parcerias");
    expect(src("server/_core/ai/prompts/comms.ts")).toContain("servicos_extra (lavagem, carregamento, outros serviços ao carro), parcerias");
  });
  it("a regra corre a cada mensagem e a IA aplica a caixa na triagem", () => {
    expect(src("server/whatsappInbound.ts")).toContain("await assignBoxByRule(w.conversationId);");
    const t = src("server/whatsappTriage.ts");
    expect(t).toContain("await applyBoxFromIntent(conversationId, intent);");
    expect(t).toContain("sql`COALESCE(${whatsappConversations.boxSource}, '') <> 'manual'`");
  });
});

describe("Quem vê cada caixa", () => {
  const box = (module: string, o: any = {}) => ({ module, visibleRoles: [] as string[], active: true, ...o });
  it("pelo módulo e papéis, sem exigir a Comunicação; inativa só o super admin", () => {
    const tl = { id: 1, role: "team_leader" };
    expect(canSeeBoxModule(tl, box("rh"))).toBe(true);
    expect(canSeeBoxModule(tl, box("servicos"))).toBe(true);
    expect(canSeeBoxModule(tl, box("financeiro"))).toBe(false);
    expect(canSeeBoxModule(tl, box("comunicacao", { visibleRoles: ["admin", "super_admin"] }))).toBe(false);
    expect(canSeeBoxModule(tl, box("rh", { active: false }))).toBe(false);
    expect(canSeeBoxModule({ id: 2, role: "super_admin" }, box("financeiro", { active: false }))).toBe(true);
  });
  it("o WhatsApp esconde as caixas que a pessoa não vê (lista, conversa, ações)", () => {
    const inbox = src("server/whatsappInbox.ts");
    expect(inbox).toContain("const boxCond = boxVisibleSql(opts.hiddenBoxes ?? []);");
    expect(inbox).toContain("visibilitySql(scope), boxCond ?? sql`1 = 1`");
    const r = src("server/routers.ts");
    expect(r).not.toContain("await conversationVisible(input.conversationId))");
    expect(r).toContain("hiddenBoxes: await hiddenBoxKeys(ctx.user)");
  });
  it("filtro da lista: todas, Geral (sem caixa) ou uma caixa", () => {
    expect(matchesBoxFilter("rh", "all")).toBe(true);
    expect(matchesBoxFilter(null, "geral")).toBe(true);
    expect(matchesBoxFilter("rh", "geral")).toBe(false);
    expect(matchesBoxFilter("rh", "rh")).toBe(true);
  });
});

describe("Email: a IA separa as caixas gerais; mover à mão; responder pelo alias de origem", () => {
  it("destinos da IA só entre as caixas ativas; resposta inválida = fica", () => {
    const t = availableTargets([{ key: "rh", active: true }, { key: "faturacao", active: true }, { key: "parcerias", active: false }]);
    expect(t.map((x) => x.key)).toEqual(["rh", "faturacao"]);
    expect(parseRoutingAnswer("Faturacao", t)).toBe("faturacao");
    expect(parseRoutingAnswer("geral", t)).toBeNull();
    expect(parseRoutingAnswer("parcerias", t)).toBeNull();
  });
  it("só emails NOVOS de caixa geral (aiRoute) e com o interruptor (desligado por omissão); o aviso vai à caixa nova", () => {
    const svc = src("server/mail/service.ts");
    expect(svc).toContain("if (fresh && e.result.newThread && mailbox?.aiRoute && !createdCase && !e.classification.personal) {");
    expect(svc).toContain('if (!(await aiFeatureAvailableFresh("mail_routing"))) return null;');
    expect(svc).toContain("await notifyNewMail(e, noticeBox, projectId)");
    expect(automationFlagDefault("AI_MAIL_ROUTING")).toBe(false);
  });
  it("a IA nunca muda uma conversa já movida; quem moveu fica registado", () => {
    const svc = src("server/mail/service.ts");
    expect(svc).toContain('const guard = by === "ai" ? sql`AND routedBy IS NULL` : sql``;');
    expect(svc).toContain("SET routedFromKey = COALESCE(routedFromKey, mailboxKey), mailboxKey = ${boxKey}, routedBy = ${by}");
  });
  it("responder numa caixa por tema sai pelo endereço por onde o cliente escreveu", () => {
    const inbox = src("server/mail/inbox.ts");
    expect(inbox).toContain("const replyAddrs = await replyAddressesOf(acc.mailbox, acc.thread);");
    expect(inbox).toContain("pickFromAddress({ addresses: threadRow ? await replyAddressesOf(mailbox, threadRow) : mailbox.addresses }");
    expect(inbox).toContain('canCompose: canActOnMailbox(viewer, m) && m.sourceKind !== "tema",');
  });
});

describe("Caixa por tema (configuração)", () => {
  const cfg = (o: any) => ({ key: "faturacao", label: "Faturação", addresses: [], sourceKind: "tema", sourceEmail: "", sourceUserId: null, module: "comunicacao", ...o });
  it("sem conta nem endereços; as outras continuam a precisar de endereço", () => {
    expect(mailboxConfigSchema.safeParse(cfg({})).success).toBe(true);
    expect(mailboxConfigSchema.safeParse(cfg({ sourceKind: "dwd", sourceEmail: "info@multipark.pt" })).success).toBe(false);
    expect(sourceAccountKey({ sourceKind: "tema", sourceEmail: "", sourceUserId: null })).toBeNull();
  });
  it("as quatro novas: Alterações, Serviços extra, Parcerias, Faturação", () => {
    expect(TOPIC_BOX_SEEDS.map((b) => b.key)).toEqual(["alteracoes", "servicos_extra", "parcerias", "faturacao"]);
  });
});

describe("Migração 0365", () => {
  it("depois da 0360; sementes e preenchimento só uma vez; sem DELETE/DROP", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0365")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0360"));
    const all = MIGRATION_0365_STATEMENTS.join("\n");
    expect(all).not.toMatch(/\bDELETE\b|\bDROP\b/);
    const once = MIGRATION_0365_STATEMENTS.filter((s) => s.startsWith("INSERT IGNORE INTO `mail_mailboxes`") || s.startsWith("UPDATE"));
    expect(once.length).toBe(4 + 3);
    expect(once.every((s) => s.includes("0365_comms_topic_boxes"))).toBe(true);
    expect(all).toContain("ADD COLUMN `boxKey` VARCHAR(40) NULL");
    expect(all).toContain("ADD COLUMN `routedFromKey` VARCHAR(40) NULL");
    expect(MIGRATION_0365_STATEMENTS.at(-1)).toContain("INSERT IGNORE INTO `app_notification_maintenance`");
  });
});
