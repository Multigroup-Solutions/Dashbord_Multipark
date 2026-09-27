import { describe, expect, it } from "vitest";
import { deliveriesVerdict, lisbonHour, mysqlToMs, webhookAlertDecision } from "./syncRules";

const H = 3_600_000;
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0); // 24 set 2026 12:00 UTC = 13:00 Lisboa

describe("datas", () => {
  it("mysqlToMs lê DATETIME UTC em texto", () => {
    expect(mysqlToMs("2026-09-24 12:00:00")).toBe(NOW);
    expect(mysqlToMs(null)).toBeNull();
    expect(mysqlToMs("lixo")).toBeNull();
  });
});

describe("ok honesto dos crons", () => {
  it("entregas: falhas de itens são avisos; fase partida é erro", () => {
    const warn = deliveriesVerdict({ phaseErrors: [], queue: { failed: 2, lostLease: 0, dead: 1 }, details: { errors: 3, noKey: 0 } });
    expect(warn.ok).toBe(true);
    expect(warn.warnings).toEqual(["fila: 2 por repetir", "fila: 1 em dead-letter", "detalhe: 3 erro(s)"]);
    const broken = deliveriesVerdict({ phaseErrors: ["fila indisponível (DATABASE_UNAVAILABLE)"] });
    expect(broken).toMatchObject({ ok: false, error: "fila indisponível (DATABASE_UNAVAILABLE)" });
  });
});

describe("alerta sem webhooks (07–23 Lisboa)", () => {
  const base = { staleHours: 3 };
  it("levanta uma vez em horário de operação", () => {
    const d = webhookAlertDecision({ ...base, now: NOW, lastWebhookAt: NOW - 4 * H, wasActive: false });
    expect(d).toMatchObject({ stale: true, inHours: true, active: true, transition: "raise" });
    expect(webhookAlertDecision({ ...base, now: NOW, lastWebhookAt: NOW - 5 * H, wasActive: true }).transition).toBeNull();
  });
  it("não levanta de noite nem limpa só por ser de noite", () => {
    const night = Date.UTC(2026, 8, 24, 2, 0, 0); // 03:00 Lisboa
    expect(lisbonHour(night)).toBe(3);
    expect(webhookAlertDecision({ ...base, now: night, lastWebhookAt: night - 6 * H, wasActive: false }).transition).toBeNull();
    expect(webhookAlertDecision({ ...base, now: night, lastWebhookAt: night - 6 * H, wasActive: true })).toMatchObject({ active: true, transition: null });
  });
  it("limpa quando volta a chegar um webhook", () => {
    expect(webhookAlertDecision({ ...base, now: NOW, lastWebhookAt: NOW - 10 * 60_000, wasActive: true }).transition).toBe("clear");
  });
  it("sem nenhum webhook registado conta como parado", () => {
    expect(webhookAlertDecision({ ...base, now: NOW, lastWebhookAt: null, wasActive: false }).transition).toBe("raise");
  });
  it("limites do horário: 07:00 dentro, 23:00 fora (hora de verão)", () => {
    expect(webhookAlertDecision({ ...base, now: Date.UTC(2026, 8, 24, 6, 0), lastWebhookAt: null, wasActive: false }).inHours).toBe(true);
    expect(webhookAlertDecision({ ...base, now: Date.UTC(2026, 8, 24, 22, 0), lastWebhookAt: null, wasActive: false }).inHours).toBe(false);
  });
});
