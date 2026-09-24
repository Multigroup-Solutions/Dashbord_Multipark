/**
 * Definições da aplicação (tabelas `app_settings` + `app_settings_audit`,
 * migração 0098). Chave → valor JSON; cada alteração fica auditada (quem,
 * quando, valor antigo, valor novo). As regras (schemas, omissões) vivem em
 * shared/appSettings.ts.
 *
 * Leitura com cache em memória de 30s por processo (as definições mudam
 * raramente e há leituras em caminhos quentes, ex.: criar uma ocorrência).
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  AUTOMATION_FLAGS,
  FLAG_SETTING_PREFIX,
  SETTINGS,
  SETTING_KEYS,
  flagSettingKey,
  isAutomationFlag,
  isFlagSettingKey,
  isSettingKey,
  validateSetting,
  type SettingKey,
  type SettingValue,
} from "../shared/appSettings";

const CACHE_TTL_MS = 30_000;
let cache: { at: number; values: Map<string, unknown> } | null = null;

function rowsOf(res: unknown): any[] {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
}

/** O mysql2 devolve JSON como objeto (MySQL) ou texto (MariaDB). */
export function parseJsonValue(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  if (Buffer.isBuffer(raw)) {
    try { return JSON.parse(raw.toString("utf8")); } catch { return null; }
  }
  return raw;
}

async function loadAll(): Promise<Map<string, unknown>> {
  if (cache && Date.now() - cache.at <= CACHE_TTL_MS) return cache.values;
  const db = await getDb();
  const values = new Map<string, unknown>();
  if (db) {
    const res = await db.execute(sql`SELECT settingKey, \`value\` FROM app_settings`);
    for (const r of rowsOf(res)) values.set(String(r.settingKey), parseJsonValue(r.value));
  }
  cache = { at: Date.now(), values };
  return values;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

/**
 * Valor GRAVADO de uma definição (validado); `null` se não existir ou se o
 * valor guardado já não passar na validação — o chamador usa então o seu
 * fallback (env / constante). Nunca lança.
 */
export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K> | null> {
  try {
    const values = await loadAll();
    if (!values.has(key)) return null;
    const v = validateSetting(key, values.get(key));
    return v.ok ? (v.value as SettingValue<K>) : null;
  } catch {
    return null;
  }
}

/** Sobreposições dos interruptores das automações (só os do catálogo). */
export async function loadFeatureFlagOverrides(): Promise<Map<string, boolean>> {
  const db = await getDb();
  const out = new Map<string, boolean>();
  if (!db) return out;
  const res = await db.execute(sql`SELECT settingKey, \`value\` FROM app_settings WHERE settingKey LIKE ${FLAG_SETTING_PREFIX + "%"}`);
  for (const r of rowsOf(res)) {
    const name = String(r.settingKey).slice(FLAG_SETTING_PREFIX.length);
    const v = parseJsonValue(r.value);
    if (isAutomationFlag(name) && typeof v === "boolean") out.set(name, v);
  }
  return out;
}

export interface SettingRow {
  key: string;
  value: unknown;
  updatedAt: string | null;
  updatedByName: string | null;
}

async function storedRows(): Promise<Map<string, SettingRow>> {
  const db = await getDb();
  const out = new Map<string, SettingRow>();
  if (!db) return out;
  const res = await db.execute(sql`
    SELECT s.settingKey, s.\`value\`, DATE_FORMAT(s.updatedAt, '%Y-%m-%d %H:%i:%s') AS updatedAt, u.name AS updatedByName
      FROM app_settings s LEFT JOIN users u ON u.id = s.updatedById`);
  for (const r of rowsOf(res)) {
    out.set(String(r.settingKey), {
      key: String(r.settingKey),
      value: parseJsonValue(r.value),
      updatedAt: r.updatedAt ? String(r.updatedAt) : null,
      updatedByName: r.updatedByName ? String(r.updatedByName) : null,
    });
  }
  return out;
}

/** Todas as definições editáveis: valor gravado (ou omissão) + metadados. */
export async function listSettings() {
  const rows = await storedRows();
  return SETTING_KEYS.map((key) => {
    const d = SETTINGS[key];
    const row = rows.get(key);
    const parsed = row ? validateSetting(key, row.value) : null;
    return {
      key,
      group: d.group,
      label: d.label,
      description: d.description,
      wiring: d.wiring,
      defaultValue: d.defaultValue as unknown,
      value: parsed?.ok ? parsed.value : null,
      isSet: !!parsed?.ok,
      updatedAt: row?.updatedAt ?? null,
      updatedByName: row?.updatedByName ?? null,
    };
  });
}

/** Interruptores: valor da env, sobreposição da BD e estado efetivo. */
export async function listAutomationFlags(env: Record<string, string | undefined> = process.env) {
  const rows = await storedRows();
  const { parseSwitch, resolveFeatureFlag } = await import("./_core/featureFlags");
  return AUTOMATION_FLAGS.map((f) => {
    const row = rows.get(flagSettingKey(f.name));
    const override = typeof row?.value === "boolean" ? row.value : null;
    const envRaw = env[f.name];
    return {
      ...f,
      envValue: parseSwitch(envRaw),
      override,
      effective: resolveFeatureFlag(envRaw, override, true),
      updatedAt: row?.updatedAt ?? null,
      updatedByName: row?.updatedByName ?? null,
    };
  });
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Grava (ou, com `value === null`, apaga → volta à omissão/env) uma definição,
 * com auditoria. Lança Error com mensagem PT se o valor for inválido.
 */
export async function setSetting(key: string, value: unknown, userId: number): Promise<{ changed: boolean; value: unknown }> {
  if (!isSettingKey(key) && !isFlagSettingKey(key)) throw new Error(`Definição desconhecida: ${key}`);
  let normalized: unknown = null;
  if (value !== null) {
    const v = validateSetting(key, value);
    if (!v.ok) throw new Error(v.error);
    normalized = v.value;
  }
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  const oldRes = await db.execute(sql`SELECT \`value\` FROM app_settings WHERE settingKey = ${key} LIMIT 1`);
  const oldRow = rowsOf(oldRes)[0];
  const oldValue = oldRow ? parseJsonValue(oldRow.value) : null;
  if ((oldRow ? oldValue : null) === null && normalized === null) return { changed: false, value: null };
  if (oldRow && sameJson(oldValue, normalized)) return { changed: false, value: normalized };

  if (normalized === null) {
    await db.execute(sql`DELETE FROM app_settings WHERE settingKey = ${key}`);
  } else {
    const json = JSON.stringify(normalized);
    await db.execute(sql`
      INSERT INTO app_settings (settingKey, \`value\`, updatedById) VALUES (${key}, ${json}, ${userId})
      ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updatedById = VALUES(updatedById)`);
  }
  await db.execute(sql`
    INSERT INTO app_settings_audit (settingKey, oldValue, newValue, changedById)
    VALUES (${key}, ${oldRow ? JSON.stringify(oldValue) : null}, ${normalized === null ? null : JSON.stringify(normalized)}, ${userId})`);
  invalidateSettingsCache();
  if (key === "finance.vat" || key === "finance.tsu") {
    const { invalidateFinanceRatesCache } = await import("./finance/rates");
    invalidateFinanceRatesCache();
  }
  if (isFlagSettingKey(key)) {
    const { setCachedFeatureOverride } = await import("./_core/featureFlags");
    setCachedFeatureOverride(key.slice(FLAG_SETTING_PREFIX.length), normalized as boolean | null);
  }
  return { changed: true, value: normalized };
}

export async function listSettingsAudit(limit = 50) {
  const db = await getDb();
  if (!db) return [];
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const res = await db.execute(sql`
    SELECT a.id, a.settingKey, a.oldValue, a.newValue,
           DATE_FORMAT(a.changedAt, '%Y-%m-%d %H:%i:%s') AS changedAt, u.name AS changedByName
      FROM app_settings_audit a LEFT JOIN users u ON u.id = a.changedById
     ORDER BY a.changedAt DESC, a.id DESC
     LIMIT ${n}`);
  return rowsOf(res).map((r) => ({
    id: Number(r.id),
    key: String(r.settingKey),
    oldValue: parseJsonValue(r.oldValue),
    newValue: parseJsonValue(r.newValue),
    changedAt: r.changedAt ? String(r.changedAt) : null,
    changedByName: r.changedByName ? String(r.changedByName) : null,
  }));
}

// ─── Preferências de notificação por utilizador (users.notificationPrefs) ──

export async function getNotificationPrefsRaw(userId: number): Promise<unknown> {
  const db = await getDb();
  if (!db) return null;
  const res = await db.execute(sql`SELECT notificationPrefs FROM users WHERE id = ${userId} LIMIT 1`);
  return parseJsonValue(rowsOf(res)[0]?.notificationPrefs ?? null);
}

export async function saveNotificationPrefs(userId: number, prefs: { muted: string[] }): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  await db.execute(sql`UPDATE users SET notificationPrefs = ${JSON.stringify(prefs)} WHERE id = ${userId}`);
}

// ─── Sessões (users.sessionVersion) ─────────────────────────────────────────

/** Invalida todas as sessões de um utilizador (os cookies antigos deixam de valer). */
export async function bumpSessionVersion(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  await db.execute(sql`UPDATE users SET sessionVersion = sessionVersion + 1 WHERE id = ${userId}`);
  const res = await db.execute(sql`SELECT sessionVersion FROM users WHERE id = ${userId} LIMIT 1`);
  return Number(rowsOf(res)[0]?.sessionVersion ?? 0);
}

/** Invalida as sessões de TODAS as pessoas. Devolve quantas contas foram tocadas. */
export async function bumpAllSessionVersions(): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível.");
  const res = await db.execute(sql`UPDATE users SET sessionVersion = sessionVersion + 1`);
  const header = Array.isArray(res) ? res[0] : res;
  return Number((header as any)?.affectedRows ?? 0);
}
