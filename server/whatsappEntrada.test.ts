/**
 * P3 lote 17b — Entrada e difusões do WhatsApp: um envio em massa cortado a
 * meio retoma sem duplicar, um erro num destinatário não deixa buracos, um
 * "falhou" tardio da Meta corrige contas e avisos, o STOP não se perde atrás
 * do download de ficheiros, a manutenção corre sem a automação dos extras.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ maintenance: 0, sla: 0 }));
vi.mock("./whatsappInbound", async (original) => ({
  ...(await original<object>()),
  runWhatsappMaintenance: async () => { calls.maintenance++; return { mediaRetried: 0, mediaStored: 0, pendingStatusesPurged: 0 }; },
}));
vi.mock("./whatsappInboxOps", async (original) => ({
  ...(await original<object>()),
  runWhatsappSlaAlerts: async () => { calls.sla++; return { alerted: 0 }; },
}));

import { messageBody, scheduleNoticeDateFromNote } from "./whatsappInbound";
import { recipientRequestKey, resolveRecipients } from "./whatsappBroadcast";
import { analyzeTemplateEntry, validateTemplateUsage } from "./whatsappTemplateMeta";
import { runExtrasAutomation } from "./extrasAutomation";
import { MIGRATION_0355_STATEMENTS } from "./migrations/migration_0355";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("Envio em massa: retomar sem duplicar", () => {
  it("cada destinatário tem o seu código dentro do envio (≤ 64, só dígitos do número)", () => {
    const k = recipientRequestKey("3f2c1a9e-1111-4222-8333-944455556666", "+351 912 345 678");
    expect(k).toBe("b:3f2c1a9e-1111-4222-8333-944455556666:351912345678");
    expect(k.length).toBeLessThanOrEqual(64);
  });
  it("lista vazia = ninguém; o envio sem destinatários dá erro em vez de ir a todos", () => {
    expect(resolveRecipients([{ id: 1, fullName: "Ana", phone: "912345678" } as any], [])).toEqual([]);
    expect(src("server/whatsappBroadcast.ts")).toContain('if (!resolved.length) throw new Error("Nenhum destinatário para este envio.");');
  });
  it("o mesmo código reabre a MESMA difusão e salta quem já foi tratado (sem token novo nem Meta)", () => {
    const b = src("server/whatsappBroadcast.ts");
    expect(b).toContain("const { id: broadcastId } = await openBroadcast(db, {");
    expect(b).toContain("if (prev) return { id: prev.id, resumed: true };");
    const one = b.slice(b.indexOf("async function dispatchOne("), b.indexOf("async function updateBroadcastCounts("));
    expect(one.indexOf("eq(whatsappMessages.clientRequestId, requestId)")).toBeGreaterThan(-1);
    expect(one.indexOf("eq(whatsappMessages.clientRequestId, requestId)")).toBeLessThan(one.indexOf("issueAvailabilityFormToken("));
  });
  it("o ecrã manda um código por diálogo e não deixa enviar 2× depois do resultado", () => {
    const page = src("client/src/pages/ExtrasDiaPage.tsx");
    expect(page).toContain("sendKey: testPhone ? undefined : waSendKey,");
    expect(page).toContain("disabled={waMissingParam || broadcast.isPending || waValidCount === 0 || waSentReal || !!waCity.blockReason}");
    expect(src("client/src/pages/ExtraLeadsPage.tsx")).toContain("sendKey: contactSendKey || undefined");
    const r = src("server/routers.ts");
    expect(r).toContain("sendKey: input.testPhone ? null : input.sendKey ?? null,");
    expect(r).toContain("sendKey: input.sendKey ?? null });");
  });
  it("leads retomados não contam um 2.º contacto", () => {
    expect(src("server/extraLeads.ts")).toContain("...(r.resumed ? {} : { contactCount: sql`${extraLeads.contactCount} + 1` }),");
  });
  it("um erro num destinatário fica 'falhou' — nunca um buraco na lista", () => {
    const b = src("server/whatsappBroadcast.ts");
    const all = b.slice(b.indexOf("async function dispatchAll("), b.indexOf("/** Um contacto solto"));
    expect(all).toContain("} catch (err: any) {");
    expect(all).toContain('if (!recipients[i]) recipients[i] = { ...resolved[i], status: "failed", error: "Envio interrompido." };');
  });
});

describe("'Falhou' depois de 'aceite'", () => {
  it("a data do aviso de escala lê-se da nota da difusão (a mesma que o envio escreve)", () => {
    expect(scheduleNoticeDateFromNote("Aviso de escala 2026-10-03")).toBe("2026-10-03");
    expect(scheduleNoticeDateFromNote("Pedido automático de disponibilidade")).toBeNull();
    expect(src("server/extrasAutomation.ts")).toContain("note: `Aviso de escala ${date}`,");
  });
  it("corrige a contagem da difusão e põe o aviso em 'falhou' sem voltar a tentar", () => {
    const inbound = src("server/whatsappInbound.ts");
    expect(inbound).toContain("SET sentCount = GREATEST(sentCount - 1, 0), failedCount = failedCount + 1");
    expect(inbound).toContain("UPDATE extras_dia_notices SET status = 'failed'");
    expect(inbound).toContain("attempts = GREATEST(attempts, 3)");
  });
  it("estados que chegaram antes da mensagem são aplicados antes de limpar", () => {
    const inbound = src("server/whatsappInbound.ts");
    const fn = inbound.slice(inbound.indexOf("export async function runWhatsappMaintenance"));
    expect(fn.indexOf("await reconcilePendingStatus(db, r.waMessageId);")).toBeLessThan(fn.indexOf(".delete(whatsappPendingStatuses)"));
  });
});

describe("Entrada", () => {
  it("o STOP, as respostas e os leads correm ANTES do ficheiro e da cidade (lentos)", () => {
    const inbound = src("server/whatsappInbound.ts");
    const fn = inbound.slice(inbound.indexOf("async function handleInbound("), inbound.indexOf("async function applyOptIntent("));
    const at = (needle: string) => fn.indexOf(needle);
    expect(at("applyOptIntent(")).toBeGreaterThan(-1);
    expect(at("applyOptIntent(")).toBeLessThan(at("fetchAndStoreMedia("));
    expect(at("handleWhatsappReply(")).toBeLessThan(at("fetchAndStoreMedia("));
    expect(at("handleLeadInbound(")).toBeLessThan(at("matchBookingCity("));
  });
  it("localização e contactos guardam o conteúdo", () => {
    const loc = messageBody({ type: "location", location: { latitude: 38.7742, longitude: -9.1342, name: "Aeroporto", address: "Lisboa" } });
    expect(loc).toBe("[localização] Aeroporto — Lisboa\nhttps://maps.google.com/?q=38.774200,-9.134200");
    expect(messageBody({ type: "location" })).toBe("[localização]");
    const c = messageBody({ type: "contacts", contacts: [{ name: { formatted_name: "Rui Sousa" }, phones: [{ phone: "+351 912 000 111" }] }] });
    expect(c).toBe("[contacto] Rui Sousa: +351 912 000 111");
  });
  it("webhook: 3 MB e sem laço de reencaminhamento", () => {
    const wh = src("server/whatsappWebhook.ts");
    expect(wh).toContain('express.raw({ type: "application/json", limit: "3mb" })');
    expect(wh).toContain('const alreadyForwarded = req.headers["x-multipark-forward-secret"] != null;');
  });
});

describe("Templates com cabeçalho que precisa de parâmetro", () => {
  const entry = (header: any) => ({ name: "t", language: "pt_PT", status: "APPROVED", components: [header, { type: "BODY", text: "Olá {{1}}" }].filter(Boolean) });
  it("imagem/documento ou texto com variável → recusado antes de enviar; cabeçalho fixo passa", () => {
    expect(analyzeTemplateEntry(entry({ type: "HEADER", format: "IMAGE" })).headerNeedingParam).toBe("IMAGE");
    expect(analyzeTemplateEntry(entry({ type: "HEADER", format: "TEXT", text: "Olá {{1}}" })).headerNeedingParam).toBe("TEXT");
    expect(analyzeTemplateEntry(entry({ type: "HEADER", format: "TEXT", text: "Multipark" })).headerNeedingParam).toBeNull();
    expect(analyzeTemplateEntry(entry(null)).headerNeedingParam).toBeNull();
    const msg = validateTemplateUsage(analyzeTemplateEntry(entry({ type: "HEADER", format: "DOCUMENT" })), { hasBodyParam2: true, hasWeekStart: true });
    expect(msg).toMatch(/cabeçalho com um documento/);
  });
});

describe("Interruptores", () => {
  it("manutenção do WhatsApp e SLA correm com EXTRAS_AUTOMATION desligado", async () => {
    const prev = process.env.EXTRAS_AUTOMATION;
    process.env.EXTRAS_AUTOMATION = "off";
    try {
      const r = await runExtrasAutomation(new Date("2026-10-02T10:05:00Z"), { deadlineAt: Date.now() + 10_000 });
      expect(r.skipped.join(" ")).toContain("EXTRAS_AUTOMATION");
      expect(calls.maintenance).toBe(1);
      expect(calls.sla).toBe(1);
      // 18a/18b: as tarefas e a entrada das candidaturas nos Leads também correm
      // (aqui as tarefas falham por não haver BD — ficam nos erros, não em "ran").
      expect(r.ran.slice(0, 2)).toEqual(["whatsapp-maintenance", "whatsapp-sla"]);
      expect(r.ran).toContain("leads-sync");
      expect(r.ran.concat(r.errors.map((e) => e.split(":")[0]))).toContain("tasks");
    } finally {
      if (prev === undefined) delete process.env.EXTRAS_AUTOMATION;
      else process.env.EXTRAS_AUTOMATION = prev;
    }
  });
  it("resposta automática aos leads e aos extras leem o interruptor fresco (webhook sem tRPC)", () => {
    const leads = src("server/extraLeadsSync.ts");
    expect(leads).toContain('isFeatureEnabled("LEAD_AUTO_REPLY", { defaultEnabled: automationFlagDefault("LEAD_AUTO_REPLY") })');
    expect(leads.indexOf("await ensureFeatureFlagOverrides();")).toBeLessThan(leads.indexOf('isFeatureEnabled("LEAD_AUTO_REPLY"'));
  });
});

describe("Migração 0355", () => {
  it("registada depois da 0350; só coluna e chave", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0355")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0350"));
    const all = MIGRATION_0355_STATEMENTS.join("\n");
    expect(all).toContain("`sendKey`");
    expect(all).toContain("`uq_whatsapp_broadcasts_send_key`");
    expect(all).not.toMatch(/\bDELETE\b|\bDROP\b/);
  });
});
