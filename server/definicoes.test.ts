import { describe, expect, it } from "vitest";
import { isFeatureEnabled, resolveFeatureFlag } from "./_core/featureFlags";
import {
  AUTOMATION_FLAGS,
  CRON_JOBS,
  cronHealth,
  cronNameFromPath,
  cronOutcome,
  effectiveRate,
  flagSettingKey,
  isFlagSettingKey,
  parseNotificationPrefs,
  staleThresholdMinutes,
  validateSetting,
  wantsNotification,
} from "../shared/appSettings";
import { fromMysqlMs, toMysqlMs } from "./cronRuns";
import { sessionVersionMatches } from "./_core/sdk";
import { integrationStatusesFromEnv, missingEnvs, scrubSecrets } from "./integrationsStatus";
import { MIGRATION_0098_STATEMENTS, IDEMPOTENT_ERROR_CODES_0098 } from "./migrations/migration_0098";

describe("interruptores: sobreposição da BD", () => {
  it("BD > env > omissão", () => {
    expect(resolveFeatureFlag("off", true)).toBe(true);
    expect(resolveFeatureFlag("on", false)).toBe(false);
    expect(resolveFeatureFlag("off", null)).toBe(false);
    expect(resolveFeatureFlag(undefined, undefined)).toBe(true);
    expect(resolveFeatureFlag("", null, false)).toBe(false);
    expect(resolveFeatureFlag("lixo", undefined, false)).toBe(false);
  });

  it("isFeatureEnabled aplica o mapa de sobreposições", () => {
    const env = { EXTRAS_AUTOMATION: "off" };
    expect(isFeatureEnabled("EXTRAS_AUTOMATION", { env, overrides: null })).toBe(false);
    expect(isFeatureEnabled("EXTRAS_AUTOMATION", { env, overrides: new Map([["EXTRAS_AUTOMATION", true]]) })).toBe(true);
    expect(isFeatureEnabled("TASKS_AUTOMATION", { env: {}, overrides: new Map([["TASKS_AUTOMATION", false]]) })).toBe(false);
    // sem sobreposições carregadas (testes) → comportamento antigo
    expect(isFeatureEnabled("EXTRAS_AUTOMATION", { env })).toBe(false);
    expect(isFeatureEnabled("EXTRAS_AUTOMATION", { env: {} })).toBe(true);
  });

  it("só as automações do catálogo são sobreponíveis (nunca INPROCESS_SCHEDULERS)", () => {
    expect(isFlagSettingKey(flagSettingKey("EXTRAS_AUTOMATION"))).toBe(true);
    expect(isFlagSettingKey("flag.INPROCESS_SCHEDULERS")).toBe(false);
    expect(AUTOMATION_FLAGS.some((f) => f.name === "INPROCESS_SCHEDULERS")).toBe(false);
    expect(validateSetting("flag.EXTRAS_AUTOMATION", true)).toEqual({ ok: true, value: true });
    expect(validateSetting("flag.EXTRAS_AUTOMATION", "on").ok).toBe(false);
  });
});

describe("crons: estado e deteção de parados", () => {
  const now = Date.UTC(2026, 8, 24, 12, 0, 0);
  const min = 60_000;

  it("limite de parado = 2× o intervalo (mínimo 30 min)", () => {
    expect(staleThresholdMinutes(60)).toBe(120);
    expect(staleThresholdMinutes(1440)).toBe(2880);
    expect(staleThresholdMinutes(5)).toBe(30);
  });

  it("classifica a última corrida", () => {
    expect(cronHealth(null, 60, now)).toBe("never");
    expect(cronHealth(null, null, now)).toBe("unscheduled");
    expect(cronHealth({ startedAt: now - 30 * min, finishedAt: now - 29 * min, ok: true }, 60, now)).toBe("ok");
    expect(cronHealth({ startedAt: now - 30 * min, finishedAt: now - 29 * min, ok: false }, 60, now)).toBe("failed");
    expect(cronHealth({ startedAt: now - 121 * min, finishedAt: now - 120 * min, ok: true }, 60, now)).toBe("stale");
    expect(cronHealth({ startedAt: now - 119 * min, finishedAt: now - 118 * min, ok: true }, 60, now)).toBe("ok");
    expect(cronHealth({ startedAt: now - 2 * min, finishedAt: null, ok: null }, 60, now)).toBe("running");
    expect(cronHealth({ startedAt: now - 20 * min, finishedAt: null, ok: null }, 60, now)).toBe("failed");
    // diário: 30h sem correr ainda não é parado; 49h já é
    expect(cronHealth({ startedAt: now - 30 * 60 * min, finishedAt: now - 30 * 60 * min + 5000, ok: true }, 1440, now)).toBe("ok");
    expect(cronHealth({ startedAt: now - 49 * 60 * min, finishedAt: now - 49 * 60 * min + 5000, ok: true }, 1440, now)).toBe("stale");
  });

  it("nome do cron a partir do caminho", () => {
    expect(cronNameFromPath("/multipark-sync")).toBe("multipark-sync");
    expect(cronNameFromPath("/api/cron/daily-ops")).toBe("daily-ops");
    expect(cronNameFromPath("/google-ads?kind=daily")).toBe("google-ads");
    expect(cronNameFromPath("/")).toBeNull();
    expect(cronNameFromPath("/../etc")).toBeNull();
    for (const j of CRON_JOBS) expect(cronNameFromPath(`/${j.name}`)).toBe(j.name);
  });

  it("resultado a partir do HTTP + corpo", () => {
    expect(cronOutcome(200, { ok: true })).toEqual({ ok: true, error: null });
    expect(cronOutcome(200, { ranAt: "x" })).toEqual({ ok: true, error: null });
    expect(cronOutcome(200, { ok: false, error: "IMAP" })).toEqual({ ok: false, error: "IMAP" });
    expect(cronOutcome(200, { status: "failed" }).ok).toBe(false);
    expect(cronOutcome(500, { ok: false, error: "boom" })).toEqual({ ok: false, error: "boom" });
    expect(cronOutcome(503, undefined)).toEqual({ ok: false, error: "HTTP 503" });
    expect(cronOutcome(200, { ok: true, stepErrors: ["RH: x"] })).toEqual({ ok: false, error: "RH: x" });
    expect(cronOutcome(200, { ok: true, stepErrors: [] }).ok).toBe(true);
  });

  it("datas DATETIME(3) em UTC ida e volta", () => {
    const d = new Date(Date.UTC(2026, 8, 24, 3, 30, 5, 123));
    expect(toMysqlMs(d)).toBe("2026-09-24 03:30:05.123");
    expect(fromMysqlMs("2026-09-24 03:30:05.123000")).toBe(d.getTime());
    expect(fromMysqlMs("2026-09-24 03:30:05")).toBe(d.getTime() - 123);
    expect(fromMysqlMs(null)).toBeNull();
  });
});

describe("definições: validação", () => {
  it("IVA/TSU: frações, datas únicas, ordenadas", () => {
    const r = validateSetting("finance.vat", [{ rate: 0.23, from: "2026-01-01" }, { rate: 0.22, from: "2011-01-01" }]);
    expect(r).toEqual({ ok: true, value: [{ rate: 0.22, from: "2011-01-01" }, { rate: 0.23, from: "2026-01-01" }] });
    expect(validateSetting("finance.vat", [{ rate: 23, from: "2026-01-01" }]).ok).toBe(false);
    expect(validateSetting("finance.tsu", [{ rate: 0.2375, from: "2026-1-1" }]).ok).toBe(false);
    expect(validateSetting("finance.tsu", []).ok).toBe(false);
    const dup = validateSetting("finance.vat", [{ rate: 0.23, from: "2026-01-01" }, { rate: 0.2, from: "2026-01-01" }]);
    expect(dup.ok).toBe(false);
  });

  it("taxa em vigor num dia", () => {
    const list = [{ rate: 0.23, from: "2011-01-01" }, { rate: 0.21, from: "2027-01-01" }];
    expect(effectiveRate(list, "2026-09-24")).toBe(0.23);
    expect(effectiveRate(list, "2027-01-01")).toBe(0.21);
    expect(effectiveRate(list, "2010-12-31")).toBeNull();
    expect(effectiveRate([], "2026-01-01")).toBeNull();
  });

  it("SLAs: inteiros dentro dos limites", () => {
    expect(validateSetting("sla.incidentHours", 24)).toEqual({ ok: true, value: 24 });
    expect(validateSetting("sla.incidentHours", 0).ok).toBe(false);
    expect(validateSetting("sla.incidentHours", 1.5).ok).toBe(false);
    expect(validateSetting("sla.incidentHours", 721).ok).toBe(false);
    expect(validateSetting("sla.lostFoundDays", "7").ok).toBe(false);
  });

  it("emails: normalizados, sem repetidos, inválidos recusados", () => {
    expect(validateSetting("emails.handoverCc", [" A@Multipark.pt ", "a@multipark.pt", "b@x.pt"]))
      .toEqual({ ok: true, value: ["a@multipark.pt", "b@x.pt"] });
    expect(validateSetting("emails.handoverCc", ["não-é-email"]).ok).toBe(false);
    expect(validateSetting("emails.handoverCc", []).ok).toBe(true);
    expect(validateSetting("availability.assigneeEmail", "")).toEqual({ ok: true, value: "" });
    expect(validateSetting("availability.assigneeEmail", "RH@Multipark.pt")).toEqual({ ok: true, value: "rh@multipark.pt" });
    expect(validateSetting("availability.assigneeEmail", "rh").ok).toBe(false);
  });

  it("chaves desconhecidas recusadas", () => {
    expect(validateSetting("x.y", 1).ok).toBe(false);
  });
});

describe("preferências de notificação", () => {
  it("só guarda tipos conhecidos e silenciáveis", () => {
    expect(parseNotificationPrefs('{"muted":["task","handover","lixo","task"]}')).toEqual({ muted: ["task"], email: {} });
    expect(parseNotificationPrefs(null)).toEqual({ muted: [], email: {} });
    expect(parseNotificationPrefs("{nope")).toEqual({ muted: [], email: {} });
  });
  it("obrigatórias e desconhecidas entram sempre", () => {
    const prefs = { muted: ["task", "handover"] };
    expect(wantsNotification(prefs, "task")).toBe(false);
    expect(wantsNotification(prefs, "handover")).toBe(true);
    expect(wantsNotification(prefs, "info")).toBe(true);
    expect(wantsNotification(prefs, "extras")).toBe(true);
  });
});

describe("sessões: versão", () => {
  it("cookie antigo sem versão vale para contas na versão 0", () => {
    expect(sessionVersionMatches(undefined, 0)).toBe(true);
    expect(sessionVersionMatches(0, undefined)).toBe(true);
    expect(sessionVersionMatches(0, 1)).toBe(false);
    expect(sessionVersionMatches(2, 2)).toBe(true);
  });
});

describe("integrações: nunca revelar segredos", () => {
  const env = { META_ACCESS_TOKEN: "EAAB-secret-token-123", META_AD_ACCOUNT_IDS: "act_1", SMTP_HOST: "smtp.x", SMTP_USER: "u", SMTP_PASS: "pa55word!" };
  it("estado só com sim/não e nomes das variáveis", () => {
    const list = integrationStatusesFromEnv(env);
    const json = JSON.stringify(list);
    expect(json).not.toContain("EAAB-secret-token-123");
    expect(json).not.toContain("pa55word!");
    expect(list.find((i) => i.id === "meta_ads")?.configured).toBe(true);
    expect(list.find((i) => i.id === "smtp")?.configured).toBe(true);
    expect(list.find((i) => i.id === "whatsapp")?.missing).toEqual(["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]);
  });
  it("grupos 'qualquer um destes'", () => {
    expect(missingEnvs([["A", "B"], ["C"]], { B: "1" })).toEqual(["C"]);
    expect(missingEnvs([["A", "B"]], { A: "  " })).toEqual(["A ou B"]);
  });
  it("tira segredos das mensagens de erro", () => {
    expect(scrubSecrets("token EAAB-secret-token-123 inválido", env)).toBe("token *** inválido");
    expect(scrubSecrets("mysql://root:pw@host/db", {})).toBe("mysql://***:***@host/db");
    expect(scrubSecrets("x?access_token=abc&y=1", {})).toBe("x?access_token=***&y=1");
  });
});

describe("migração 0098", () => {
  it("idempotente e sem subqueries", () => {
    for (const s of MIGRATION_0098_STATEMENTS) {
      expect(s).not.toMatch(/\(\s*SELECT/i);
      if (/^CREATE TABLE/.test(s)) expect(s).toMatch(/IF NOT EXISTS/);
    }
    expect(IDEMPOTENT_ERROR_CODES_0098.has("ER_DUP_FIELDNAME")).toBe(true);
    expect(IDEMPOTENT_ERROR_CODES_0098.has("ER_DUP_KEYNAME")).toBe(true);
    expect(IDEMPOTENT_ERROR_CODES_0098.has("ER_TABLE_EXISTS_ERROR")).toBe(true);
    expect(MIGRATION_0098_STATEMENTS.some((s) => s.includes("`sessionVersion` INT NOT NULL DEFAULT 0"))).toBe(true);
  });
});
