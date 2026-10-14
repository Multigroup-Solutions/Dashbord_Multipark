/**
 * Migração 0680 (tarefa 62, P1): a coluna do limiar da recolha do GPS e o
 * passo de dados que passa a definição `gps.speedRule` gravada com
 * {120, 10 %, x} para {120, 0 %, x} — uma vez em toda a frota, com a linha no
 * histórico das Definições, sem tocar noutro valor e sem apagar nada.
 */
import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  IDEMPOTENT_ERROR_CODES_0680, MIGRATION_0680_STATEMENTS, SPEED_RULE_FLAG_0680, describe0680, planSpeedRuleTolerance, runMigration0680Data,
} from "./migrations/migration_0680";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { SPEED_RULE_SETTING_KEY } from "../shared/speedRules";

const dialect = new MySqlDialect();

/** BD falsa: app_settings (chave primária, valor JSON) e app_settings_audit. */
function fakeDb(speedRule: unknown, opts: { failOnUpdate?: boolean; changedMeanwhile?: boolean; asText?: boolean } = {}) {
  const settings = new Map<string, string>();
  const updatedBy = new Map<string, number | null>();
  if (speedRule !== undefined) { settings.set(SPEED_RULE_SETTING_KEY, JSON.stringify(speedRule)); updatedBy.set(SPEED_RULE_SETTING_KEY, 7); }
  const audit: Array<{ key: string; oldValue: string | null; newValue: string | null; changedById: unknown }> = [];
  const db = {
    settings, audit, updatedBy,
    async execute(q: any) {
      const { sql, params } = dialect.sqlToQuery(q);
      const text = sql.replace(/\s+/g, " ").trim();
      if (text.startsWith("INSERT IGNORE INTO app_settings")) {
        if (settings.has(params[0] as string)) return [{ affectedRows: 0 }];
        settings.set(params[0] as string, params[1] as string);
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith("UPDATE app_settings SET `value` = ? WHERE settingKey = ? AND ( JSON_UNQUOTE")) {
        const key = params[1] as string, staleBefore = params[2] as string;
        const v = settings.has(key) ? JSON.parse(settings.get(key)!) : null;
        if (v && (v.state === "failed" || (v.state === "running" && String(v.at) < staleBefore))) { settings.set(key, params[0] as string); return [{ affectedRows: 1 }]; }
        return [{ affectedRows: 0 }];
      }
      if (text.startsWith("SELECT `value` FROM app_settings")) {
        const raw = settings.get(params[0] as string);
        if (raw == null) return [[]];
        return [[{ value: opts.asText ? raw : JSON.parse(raw) }]];
      }
      if (text.startsWith("UPDATE app_settings SET `value` = ?, updatedById = NULL")) {
        if (opts.failOnUpdate) throw new Error("ligação perdida");
        const [json, key, limit, tol] = params as [string, string, number, number];
        if (opts.changedMeanwhile) return [{ affectedRows: 0 }];
        const cur = settings.has(key) ? JSON.parse(settings.get(key)!) : null;
        if (!cur || cur.limitKmh !== limit || cur.tolerancePercent !== tol) return [{ affectedRows: 0 }];
        settings.set(key, json);
        updatedBy.set(key, null);
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith("UPDATE app_settings SET `value` = ? WHERE settingKey = ?")) { settings.set(params[1] as string, params[0] as string); return [{ affectedRows: 1 }]; }
      if (text.startsWith("INSERT INTO app_settings_audit")) {
        audit.push({ key: params[0] as string, oldValue: params[1] as string, newValue: params[2] as string, changedById: text.endsWith("NULL)") ? null : params[3] });
        return [{ affectedRows: 1 }];
      }
      if (/\bDELETE\b/i.test(text)) throw new Error("DELETE proibido");
      throw new Error(`SQL inesperado: ${text}`);
    },
  };
  return db;
}

describe("migração 0680 — velocidade a 120 sem tolerância", () => {
  it("está registada, por ordem crescente, e só acrescenta a coluna (idempotente)", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0680");
    expect([...SCHEMA_MIGRATION_IDS].sort()).toEqual([...SCHEMA_MIGRATION_IDS]);
    expect(MIGRATION_0680_STATEMENTS).toEqual(["ALTER TABLE `daily_driver_history` ADD COLUMN `speedThresholdKmh` DECIMAL(6,2) NULL AFTER `metricsVersion`"]);
    expect(IDEMPOTENT_ERROR_CODES_0680.has("ER_DUP_FIELDNAME")).toBe(true);
  });
  it("plano (PURO): {120, 10, x} → {120, 0, x}; sem valor → nada; outro valor → intacto", () => {
    expect(planSpeedRuleTolerance({ limitKmh: 120, tolerancePercent: 10, minPoints: 3 })).toEqual({ action: "update", from: { limitKmh: 120, tolerancePercent: 10, minPoints: 3 }, to: { limitKmh: 120, tolerancePercent: 0, minPoints: 3 } });
    expect(planSpeedRuleTolerance(null)).toEqual({ action: "none" });
    expect(planSpeedRuleTolerance({ limitKmh: 120, tolerancePercent: 5, minPoints: 2 }).action).toBe("keep");
    expect(planSpeedRuleTolerance({ limitKmh: 110, tolerancePercent: 10, minPoints: 2 }).action).toBe("keep");
    expect(planSpeedRuleTolerance("lixo").action).toBe("keep");
  });
  it("{120, 10, 2} gravado passa a {120, 0, 2}, com a linha no histórico (quem = sistema) e marca 'done'", async () => {
    const db = fakeDb({ limitKmh: 120, tolerancePercent: 10, minPoints: 2 });
    const r = await runMigration0680Data(db);
    expect(r).toMatchObject({ status: "applied", result: "updated" });
    expect(JSON.parse(db.settings.get(SPEED_RULE_SETTING_KEY)!)).toEqual({ limitKmh: 120, tolerancePercent: 0, minPoints: 2 });
    expect(db.updatedBy.get(SPEED_RULE_SETTING_KEY)).toBeNull();
    expect(db.audit).toEqual([{ key: SPEED_RULE_SETTING_KEY, oldValue: JSON.stringify({ limitKmh: 120, tolerancePercent: 10, minPoints: 2 }), newValue: JSON.stringify({ limitKmh: 120, tolerancePercent: 0, minPoints: 2 }), changedById: null }]);
    expect(JSON.parse(db.settings.get(SPEED_RULE_FLAG_0680)!)).toMatchObject({ state: "done", result: "updated" });
    expect(describe0680(r)).toMatch(/^0680 velocidade: limite gravado .* → .*0 % de tolerância/);
  });
  it("valor em texto (MariaDB) também se lê", async () => {
    const db = fakeDb({ limitKmh: 120, tolerancePercent: 10, minPoints: 2 }, { asText: true });
    expect((await runMigration0680Data(db))).toMatchObject({ result: "updated" });
  });
  it("outro valor gravado → intacto, sem linha no histórico, e o log diz-o", async () => {
    const db = fakeDb({ limitKmh: 120, tolerancePercent: 5, minPoints: 2 });
    const r = await runMigration0680Data(db);
    expect(r).toEqual({ status: "applied", result: "other_value", value: { limitKmh: 120, tolerancePercent: 5, minPoints: 2 } });
    expect(JSON.parse(db.settings.get(SPEED_RULE_SETTING_KEY)!)).toEqual({ limitKmh: 120, tolerancePercent: 5, minPoints: 2 });
    expect(db.audit).toEqual([]);
    expect(describe0680(r)).toMatch(/não se tocou/);
  });
  it("sem valor gravado → nada a gravar (vale a omissão nova)", async () => {
    const db = fakeDb(undefined);
    expect(await runMigration0680Data(db)).toEqual({ status: "applied", result: "no_value" });
    expect(db.settings.has(SPEED_RULE_SETTING_KEY)).toBe(false);
    expect(db.audit).toEqual([]);
  });
  it("mudou entretanto (o UPDATE condicional não apanha nada) → fica o de quem mudou", async () => {
    const db = fakeDb({ limitKmh: 120, tolerancePercent: 10, minPoints: 2 }, { changedMeanwhile: true });
    expect(await runMigration0680Data(db)).toEqual({ status: "applied", result: "changed_meanwhile" });
    expect(db.audit).toEqual([]);
  });
  it("corre uma vez só: o 2.º arranque (ou outro em paralelo) sai sem tocar em nada", async () => {
    const db = fakeDb({ limitKmh: 120, tolerancePercent: 10, minPoints: 2 });
    const [a, b] = await Promise.all([runMigration0680Data(db), runMigration0680Data(db)]);
    expect([a.status, b.status].sort()).toEqual(["applied", "skipped"]);
    expect(db.audit).toHaveLength(1);
    // alguém volta a pôr 10 % à mão depois: a migração não o desfaz
    db.settings.set(SPEED_RULE_SETTING_KEY, JSON.stringify({ limitKmh: 120, tolerancePercent: 10, minPoints: 2 }));
    expect((await runMigration0680Data(db)).status).toBe("skipped");
    expect(JSON.parse(db.settings.get(SPEED_RULE_SETTING_KEY)!).tolerancePercent).toBe(10);
  });
  it("se falhar fica 'failed' e o arranque seguinte volta a tentar", async () => {
    const bad = fakeDb({ limitKmh: 120, tolerancePercent: 10, minPoints: 2 }, { failOnUpdate: true });
    await expect(runMigration0680Data(bad)).rejects.toThrow("ligação perdida");
    expect(JSON.parse(bad.settings.get(SPEED_RULE_FLAG_0680)!).state).toBe("failed");
    const good = fakeDb({ limitKmh: 120, tolerancePercent: 10, minPoints: 2 });
    good.settings.set(SPEED_RULE_FLAG_0680, bad.settings.get(SPEED_RULE_FLAG_0680)!);
    expect(await runMigration0680Data(good)).toMatchObject({ status: "applied", result: "updated" });
  });
});
