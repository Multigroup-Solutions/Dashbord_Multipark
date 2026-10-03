/**
 * P3 lote 24a — WhatsApp (decisões do Jorge, 3 out 2026):
 *  - stream das chamadas: fecha antes dos 60 s do Vercel ("Task timed out");
 *  - D30: a resposta automática à disponibilidade tem interruptor próprio
 *    (sem valor próprio segue a "Automação dos extras", como até aqui);
 *  - D31: o aviso de SLA do WhatsApp passa a interruptor nas Definições;
 *  - D38: a chamada do cliente renova a janela de 24 h (testes em whatsappCalls.test.ts).
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// Definições sem nada gravado (a lista de interruptores lê app_settings).
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({ execute: async () => [[]] }),
}));
import { AUTOMATION_FLAGS, automationFlagDefault, automationFlagFollows } from "../shared/appSettings";
import { CALL_STREAM_HARD_STOP_MS, CALL_STREAM_MAX_MS } from "../shared/whatsappCallSignal";
import { availabilityAutoReplyOn } from "./extrasAutomation";
import { listAutomationFlags } from "./appSettings";
import { runWhatsappSlaAlerts } from "./whatsappInboxOps";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const saved = { a: process.env.EXTRAS_AUTOMATION, b: process.env.EXTRAS_AVAILABILITY_AUTO_REPLY, c: process.env.WHATSAPP_SLA_NOTIFY };
afterEach(() => {
  for (const [k, v] of [["EXTRAS_AUTOMATION", saved.a], ["EXTRAS_AVAILABILITY_AUTO_REPLY", saved.b], ["WHATSAPP_SLA_NOTIFY", saved.c]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("stream das chamadas fecha antes dos 60 s", () => {
  it("travão aos 55 s contados desde a chegada do pedido; o ciclo normal acaba aos 50 s", () => {
    const vercel = JSON.parse(src("vercel.json"));
    const maxDurationMs = vercel.functions["api/index.js"].maxDuration * 1000;
    expect(CALL_STREAM_MAX_MS).toBeLessThan(CALL_STREAM_HARD_STOP_MS);
    expect(CALL_STREAM_HARD_STOP_MS).toBeLessThanOrEqual(maxDurationMs - 5_000);
    const s = src("server/whatsappCallStream.ts");
    // o prazo conta desde antes da sessão (resolveStreamScope)
    expect(s.indexOf("const startedAt = Date.now();")).toBeLessThan(s.indexOf("await resolveStreamScope(req, res)"));
    expect(s).toMatch(/const endAt = startedAt \+ CALL_STREAM_MAX_MS;/);
    expect(s).toMatch(/const hardStop = setTimeout\(\(\) => \{\s*if \(closed\) return;\s*closed = true;\s*res\.end\(\);\s*\}, Math\.max\(0, startedAt \+ CALL_STREAM_HARD_STOP_MS - Date\.now\(\)\)\);/);
    expect(s).toMatch(/Math\.min\(CALL_STREAM_TICK_MS, endAt - Date\.now\(\)\)/);
    expect(s).toMatch(/clearTimeout\(hardStop\);/);
  });
});

describe("D30 — resposta automática à disponibilidade com interruptor próprio", () => {
  it("existe, segue EXTRAS_AUTOMATION quando não tem valor próprio", () => {
    expect(AUTOMATION_FLAGS.some((f) => f.name === "EXTRAS_AVAILABILITY_AUTO_REPLY")).toBe(true);
    expect(automationFlagFollows("EXTRAS_AVAILABILITY_AUTO_REPLY")).toBe("EXTRAS_AUTOMATION");
  });

  it("sem valor próprio: igual à automação dos extras (nada muda em produção)", () => {
    delete process.env.EXTRAS_AVAILABILITY_AUTO_REPLY;
    process.env.EXTRAS_AUTOMATION = "on";
    expect(availabilityAutoReplyOn()).toBe(true);
    process.env.EXTRAS_AUTOMATION = "off";
    expect(availabilityAutoReplyOn()).toBe(false);
  });

  it("com valor próprio manda ele, nos dois sentidos", () => {
    process.env.EXTRAS_AUTOMATION = "on";
    process.env.EXTRAS_AVAILABILITY_AUTO_REPLY = "off";
    expect(availabilityAutoReplyOn()).toBe(false);
    process.env.EXTRAS_AUTOMATION = "off";
    process.env.EXTRAS_AVAILABILITY_AUTO_REPLY = "on";
    expect(availabilityAutoReplyOn()).toBe(true);
  });

  it("Definições: o estado mostrado segue o outro interruptor quando não tem valor próprio", async () => {
    const off = (await listAutomationFlags({ EXTRAS_AUTOMATION: "off" })).find((f) => f.name === "EXTRAS_AVAILABILITY_AUTO_REPLY")!;
    expect(off).toMatchObject({ effective: false, defaultEnabled: false, envValue: null, override: null, followsFlag: "EXTRAS_AUTOMATION" });
    const own = (await listAutomationFlags({ EXTRAS_AUTOMATION: "off", EXTRAS_AVAILABILITY_AUTO_REPLY: "on" })).find((f) => f.name === "EXTRAS_AVAILABILITY_AUTO_REPLY")!;
    expect(own).toMatchObject({ effective: true, envValue: true });
    expect(src("client/src/pages/DefinicoesPage.tsx")).toMatch(/if \(f\.followsFlag\) return `segue "\$\{followedLabel \?\? f\.followsFlag\}"`;/);
  });

  it("os dois pontos de entrada (texto e Sim/Não do aviso de turno) usam o interruptor novo", () => {
    const auto = src("server/extrasAutomation.ts");
    expect(auto.match(/if \(!availabilityAutoReplyOn\(\)\)/g)?.length).toBe(2);
    expect(auto).not.toMatch(/if \(!isFeatureEnabled\("EXTRAS_AUTOMATION", \{ defaultEnabled: automationFlagDefault\("EXTRAS_AUTOMATION"\) \}\)\) return (true|\{ action: "none" \});/);
  });
});

describe("D31 — aviso de SLA do WhatsApp nas Definições", () => {
  it("interruptor WHATSAPP_SLA_NOTIFY (ligado por omissão, como até aqui); a variável continua a desligar", async () => {
    expect(AUTOMATION_FLAGS.some((f) => f.name === "WHATSAPP_SLA_NOTIFY")).toBe(true);
    expect(automationFlagDefault("WHATSAPP_SLA_NOTIFY")).toBe(true);
    process.env.WHATSAPP_SLA_NOTIFY = "false"; // antes só "off" desligava
    expect(await runWhatsappSlaAlerts(new Date())).toEqual({ overdue: 0, windowClosing: 0, notifications: 0 });
    const ops = src("server/whatsappInboxOps.ts");
    expect(ops).toMatch(/if \(!isFeatureEnabled\("WHATSAPP_SLA_NOTIFY", \{ defaultEnabled: automationFlagDefault\("WHATSAPP_SLA_NOTIFY"\) \}\)\) return out;/);
    expect(ops).not.toMatch(/process\.env\.WHATSAPP_SLA_NOTIFY/);
  });
});
