import { describe, expect, it } from "vitest";
import {
  computeRecentWindows, deliveriesVerdict, futureSyncVerdict, lisbonHour, mysqlToMs, reconciliationAlert,
  reconciliationDiff, recentSyncVerdict, webhookAlertDecision, RECONCILIATION_DRIFT_THRESHOLD,
} from "./syncRules";

const H = 3_600_000;
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0); // 24 set 2026 12:00 UTC = 13:00 Lisboa

describe("janela do sync recente por parque", () => {
  it("parque em dia usa só a janela base", () => {
    const w = computeRecentWindows({ now: NOW, windowMinutes: 30, parkIds: ["A"], coverage: new Map([["A", NOW - 20 * 60_000]]) });
    // coberto há 20 min − 60 min de margem = 80 min atrás → alarga para lá da base (30 min)
    expect(w.get("A")).toBe(NOW - 80 * 60_000);
  });
  it("um parque partido alarga só a sua janela (máx. 3 dias)", () => {
    const coverage = new Map<string, number | null>([["OK", NOW - 70 * 60_000], ["BROKEN", NOW - 10 * 24 * H]]);
    const w = computeRecentWindows({ now: NOW, windowMinutes: 30, parkIds: ["OK", "BROKEN"], coverage });
    expect(w.get("OK")).toBe(NOW - 130 * 60_000);
    expect(w.get("BROKEN")).toBe(NOW - 3 * 24 * H);
  });
  it("parque sem cobertura usa o recurso legado; sem nada, o máximo", () => {
    const w = computeRecentWindows({ now: NOW, windowMinutes: 30, parkIds: ["NEW", "X"], coverage: new Map([["X", null]]), fallback: NOW - 5 * H });
    expect(w.get("NEW")).toBe(NOW - 6 * H);
    expect(w.get("X")).toBe(NOW - 6 * H);
    const none = computeRecentWindows({ now: NOW, windowMinutes: 30, parkIds: ["NEW"], coverage: new Map() });
    expect(none.get("NEW")).toBe(NOW - 3 * 24 * H);
  });
  it("uma cobertura mais recente do que a base nunca encolhe a janela abaixo da base", () => {
    const w = computeRecentWindows({ now: NOW, windowMinutes: 120, parkIds: ["A"], coverage: new Map([["A", NOW]]), marginMinutes: 0 });
    expect(w.get("A")).toBe(NOW - 120 * 60_000);
  });
  it("mysqlToMs lê DATETIME UTC em texto", () => {
    expect(mysqlToMs("2026-09-24 12:00:00")).toBe(NOW);
    expect(mysqlToMs(null)).toBeNull();
    expect(mysqlToMs("lixo")).toBeNull();
  });
});

describe("ok honesto dos crons", () => {
  it("sync recente: vermelho com parques a repetir, verde com erros de reservas", () => {
    expect(recentSyncVerdict({ parkErrors: [], errors: [] })).toEqual({ ok: true });
    const bad = recentSyncVerdict({ parkErrors: ["PORTO_AIRPARK"], errors: ["Airpark Porto/checkin: HTTP 502"] });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/PORTO_AIRPARK/);
    const items = recentSyncVerdict({ parkErrors: [], errors: ["Booking x: inválida"] });
    expect(items.ok).toBe(true);
    expect(items.warnings).toEqual(["1 reserva(s) com dados inválidos"]);
    expect(recentSyncVerdict({ parkErrors: [], errors: [], partnersError: "TIMEOUT" }).ok).toBe(false);
  });
  it("sync futuro: vermelho só sem acabar e sem progresso", () => {
    expect(futureSyncVerdict({ done: true, startOffset: 21, needsRetry: false, parkErrors: [] }).ok).toBe(true);
    expect(futureSyncVerdict({ done: false, startOffset: 0, nextOffset: 14, needsRetry: true, parkErrors: [] }).ok).toBe(true);
    const stuck = futureSyncVerdict({ done: false, startOffset: 7, nextOffset: 7, needsRetry: true, parkErrors: ["FARO_SKYPARK"] });
    expect(stuck.ok).toBe(false);
    expect(stuck.error).toMatch(/FARO_SKYPARK/);
    expect(futureSyncVerdict({ done: false, startOffset: 7, nextOffset: 7, needsRetry: false, parkErrors: [] }).error).toMatch(/prazo/);
  });
  it("entregas: falhas de itens são avisos; fase partida é erro", () => {
    const warn = deliveriesVerdict({ phaseErrors: [], queue: { failed: 2, lostLease: 0, dead: 1 }, details: { errors: 3, noKey: 0 }, history: null });
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

describe("reconciliação diária", () => {
  it("conta reservas em falta e ids repetidos só uma vez", () => {
    const r = reconciliationDiff({ day: "2026-09-23", parkId: "P", actionType: "checkin", apiTotal: 4, apiIds: ["a", "b", "c", "c"], dbIds: new Set(["a", "c"]) });
    expect(r).toMatchObject({ apiCount: 3, dbFound: 2, missing: 1, status: "drift", errorCode: null });
  });
  it("total diferente da lista é drift mesmo sem reservas em falta", () => {
    const r = reconciliationDiff({ day: "2026-09-23", parkId: "P", actionType: "creation", apiTotal: 10, apiIds: ["a"], dbIds: new Set(["a"]) });
    expect(r).toMatchObject({ missing: 0, status: "drift", errorCode: "TOTAL_MISMATCH" });
  });
  it("tudo na BD e total certo = ok", () => {
    expect(reconciliationDiff({ day: "d", parkId: "P", actionType: "checkout", apiTotal: undefined, apiIds: ["a"], dbIds: new Set(["a"]) }).status).toBe("ok");
  });
  it("alerta acima do limiar", () => {
    const row = (missing: number, parkId = "P") => ({ day: "d", parkId, actionType: "creation", apiTotal: null, apiCount: missing, dbFound: 0, missing, status: "drift" as const, errorCode: null });
    expect(reconciliationAlert([row(2), row(3, "Q")]).alert).toBe(false);
    const big = reconciliationAlert([row(RECONCILIATION_DRIFT_THRESHOLD), row(1, "Q")]);
    expect(big).toMatchObject({ alert: true, missing: RECONCILIATION_DRIFT_THRESHOLD + 1, parks: ["P", "Q"] });
  });
});
