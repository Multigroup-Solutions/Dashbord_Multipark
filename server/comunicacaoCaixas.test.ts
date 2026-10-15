/**
 * P3 lote 17f (parte 1) — caixas por tema para o email e o WhatsApp:
 * RH, Reservas, Alterações, Serviços extra, Reclamações, Perdidos, Parcerias,
 * Faturação (+ as que já existiam). A IA separa; uma pessoa pode mover; cada
 * um vê as caixas do seu módulo e a sua cidade (ou as sem cidade).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GENERAL_BOX_KEY, INTENT_BOX, TOPIC_BOX_SEEDS, canSeeBoxModule, whatsappBoxFor,
} from "../shared/commsBoxes";
import { decideMailTriage, parseTriageCategory } from "../shared/mailTriage";
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
  it("a regra corre a cada mensagem e a IA aplica a caixa na triagem (só conversas novas, 49f)", () => {
    expect(src("server/whatsappInbound.ts")).toContain("await assignBoxByRule(w.conversationId);");
    const t = src("server/whatsappTriage.ts");
    expect(t).toContain("await routeAfterTriage(conversationId, { intent, confidence: r.confidence, reason: r.reason });");
    // Jorge (8 out 2026): conversa que já tem caixa fica onde está (nem à mão nem pela IA muda sozinha).
    expect(src("server/commsRouting.ts")).toContain("WHERE id = ${conversationId} AND boxKey IS NULL AND boxSource IS NULL");
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
  it("destinos da IA só entre as caixas ativas; caixa inativa ou resposta inválida = info", () => {
    // 14 out 2026: a decisão é shared/mailTriage.ts (a mesma leitura dá a caixa e o caso).
    const active = new Set(["info", "rh", "faturacao"]);
    const facts = { sender: "external" as const, forwardedExternal: false, newThread: true, mode: "sync" as const };
    const t = { minConfidence: 0.7, createMinConfidence: 0.85, suggestMinConfidence: 0.5 };
    const f = { complaints: true, lostFound: true, notices: true };
    expect(parseTriageCategory("Faturacao")).toBe("faturacao");
    expect(parseTriageCategory("marketing")).toBeNull();
    expect(decideMailTriage({ box: "Faturacao", confidence: 0.9 }, facts, t, f, active).routeBox).toBe("faturacao");
    expect(decideMailTriage({ box: "parcerias", confidence: 0.9 }, facts, t, f, active).routeBox).toBe(GENERAL_BOX_KEY);
    expect(decideMailTriage({ box: "marketing", confidence: 0.9 }, facts, t, f, active).routeBox).toBe(GENERAL_BOX_KEY);
  });
  it("emails das caixas partilhadas, pela triagem, com o interruptor (ligado por omissão desde 8 out 2026); o aviso vai à caixa nova", () => {
    const svc = src("server/mail/service.ts");
    // 14 out 2026: pré-triagem (regras) e depois a IA — também nas respostas (só mudam de caixa com um caso).
    expect(svc).toContain("const target = await triageNewMessage(e, mailbox, {");
    expect(svc).toContain("const pre = preTriageMail({");
    expect(src("server/commsRouting.ts")).toContain('return aiFeatureAvailableFresh("mail_routing");');
    expect(svc).toContain("await notifyNewMail(e, noticeBox, projectId)");
    expect(automationFlagDefault("AI_MAIL_ROUTING")).toBe(true);
  });
  it("a IA nunca muda uma conversa já movida; quem moveu fica registado", () => {
    const svc = src("server/mail/service.ts");
    // 14 out 2026: só com um caso aberto (reroute) a IA muda uma conversa que ELA já separou — nunca uma movida à mão.
    expect(svc).toContain('const guard = by === "ai" ? (opts.reroute ? sql`AND (routedBy IS NULL OR routedBy = \'ai\')` : sql`AND routedBy IS NULL`) : sql``;');
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
