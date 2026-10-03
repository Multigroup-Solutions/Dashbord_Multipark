import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import {
  apiKeyPrefix, apiKeyTag, apiKeyActorId, checkPresentedKey, externalAllowed, externalRequiredCaps,
  generateApiKey, hashApiKey, isApiKeyExpired, shouldTouchLastUsed, v1Allowed,
  LAST_USED_THROTTLE_MS, type ApiKeyRow,
} from "./apiKeyAuth";
import { capabilitiesFor } from "../shared/apiKeyCapabilities";
import { isFeatureEnabled, parseSwitch } from "./_core/featureFlags";
import { activityLogCutoff, buildHealthBody, cronBearerOk, purgeInBatches, syncRangeError } from "./opsRules";
import { normalizeHourlyRate } from "./extraRates";
import { MIGRATION_0095_STATEMENTS, IDEMPOTENT_ERROR_CODES_0095 } from "./migrations/migration_0095";

const row = (over: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id: 7, name: "k", keyPrefix: "mp_abc123", permissions: '["read"]', active: 1,
  expiresAt: null, lastUsedAt: null, createdById: 3, ...over,
});

describe("API keys — hash, prefixo e lookup", () => {
  it("gera chaves mp_ com 32 caracteres aleatórios e únicas", () => {
    const a = generateApiKey(); const b = generateApiKey();
    expect(a).toMatch(/^mp_[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });
  it("hash = sha256 hex (igual ao SHA2(x,256) do MySQL) e prefixo de 9 caracteres", () => {
    const k = "mp_ab12cdEFGHIJKLMNOPQRSTUVWXYZ0123";
    expect(hashApiKey(k)).toBe(createHash("sha256").update(k).digest("hex"));
    expect(hashApiKey(k)).toMatch(/^[0-9a-f]{64}$/);
    expect(apiKeyPrefix(k)).toBe("mp_ab12cd");
  });
  it("lookup por hash: aceita chave ativa; recusa em falta, errada, inativa e expirada", async () => {
    const key = "mp_secretsecretsecretsecretsecret00";
    const store = new Map<string, ApiKeyRow>([[hashApiKey(key), row()]]);
    const lookup = async (h: string) => store.get(h) ?? null;
    const ok = await checkPresentedKey(key, lookup);
    expect(ok.ok).toBe(true);
    expect(await checkPresentedKey(undefined, lookup)).toMatchObject({ ok: false, status: 401 });
    expect(await checkPresentedKey("mp_wrong", lookup)).toMatchObject({ ok: false, status: 403 });
    // a chave em claro nunca é comparada — só o hash chega ao lookup
    const seen: string[] = [];
    await checkPresentedKey(key, async (h) => { seen.push(h); return null; });
    expect(seen).toEqual([hashApiKey(key)]);
    store.set(hashApiKey(key), row({ active: 0 }));
    expect(await checkPresentedKey(key, lookup)).toMatchObject({ ok: false, status: 403 });
    store.set(hashApiKey(key), row({ expiresAt: "2026-01-01 00:00:00" }));
    // 20a: expirada = mesma resposta que inválida (não revela que a chave existe)
    expect(await checkPresentedKey(key, lookup, Date.parse("2026-02-01T00:00:00Z"))).toMatchObject({ ok: false, status: 403, error: "Invalid or inactive API key" });
    expect(await checkPresentedKey(key, lookup, Date.parse("2025-12-01T00:00:00Z"))).toMatchObject({ ok: true });
  });
  it("expiração e lastUsedAt com throttle de 5 min (datas da BD em UTC)", () => {
    const now = Date.parse("2026-09-24T12:00:00Z");
    expect(isApiKeyExpired(null, now)).toBe(false);
    expect(isApiKeyExpired("2026-09-24 11:59:59", now)).toBe(true);
    expect(isApiKeyExpired("2026-09-24 12:00:01", now)).toBe(false);
    expect(shouldTouchLastUsed(null, now)).toBe(true);
    expect(shouldTouchLastUsed("2026-09-24 11:58:00", now)).toBe(false);
    expect(shouldTouchLastUsed(new Date(now - LAST_USED_THROTTLE_MS), now)).toBe(true);
  });
  it("auditoria: etiqueta com id+nome+prefixo e autor = 0 (a chave, nunca quem a criou)", () => {
    expect(apiKeyTag(row())).toBe("[API key #7 «k» mp_abc123…]");
    expect(apiKeyActorId(row())).toBe(0);
    expect(apiKeyActorId(row({ createdById: null }))).toBe(0);
  });
});

describe("API keys — capacidades (legado mantém o que fazia)", () => {
  const cases: Array<[string | null, string, string, boolean]> = [
    // permissions,           método,  caminho,           /api/external permitido?
    ['["read"]', "GET", "/vehicles", true],
    ['["read"]', "POST", "/speed-alert", false],
    ['["read","write"]', "POST", "/speed-alert", true],
    ['["admin"]', "POST", "/gmail-import", true],
    ['["device"]', "GET", "/employees", true],
    ['["device"]', "POST", "/radio-upload", true],
    ['["device"]', "POST", "/admin/anything", false],
    [null, "POST", "/vehicle-movement", true], // legado sem permissions = device
    ['["write"]', "POST", "/admin/x", false],
    ['["admin"]', "POST", "/admin/x", true],
    ['["write"]', "POST", "/gmail-import", true],
    ['["device"]', "POST", "/gmail-import", true],
    // novas: só o que foi marcado
    ['["complaints:write"]', "POST", "/gmail-import", true],
    ['["complaints:write"]', "POST", "/speed-alert", false],
    ['["reports:marketing"]', "GET", "/vehicles", false],
    ['["reports:ops"]', "GET", "/vehicles", true],
    ['["reports:ops"]', "GET", "/employees", false],
    ['["pii"]', "GET", "/employees", true],
    ['["site:intake"]', "GET", "/docs", true],
  ];
  it.each(cases)("external %s %s %s → %s", (perms, method, path, allowed) => {
    expect(externalAllowed(capabilitiesFor(perms), method, path)).toBe(allowed);
  });
  it("capacidade exigida na /api/external", () => {
    expect(externalRequiredCaps("GET", "/vehicles")).toEqual(["reports:ops", "device"]);
    expect(externalRequiredCaps("PATCH", "/x")).toEqual(["device"]);
    expect(externalRequiredCaps("GET", "/admin/y")).toEqual(["admin"]);
    expect(externalRequiredCaps("GET", "/docs")).toBe("any");
  });
  it("/api/v1: legado read/write/admin mantém; device não acede a nada; novas só o marcado", () => {
    const admin = capabilitiesFor('["admin"]'), write = capabilitiesFor("read,write"), read = capabilitiesFor("read"), device = capabilitiesFor(null);
    expect([v1Allowed(admin, ["admin"]), v1Allowed(admin, ["complaints:write"]), v1Allowed(admin, ["pii"])]).toEqual([true, true, true]);
    expect([v1Allowed(write, ["admin"]), v1Allowed(write, ["complaints:write"]), v1Allowed(write, ["site:intake"]), v1Allowed(write, ["reports:cash"])]).toEqual([false, true, true, true]);
    expect([v1Allowed(read, ["admin"]), v1Allowed(read, ["complaints:write"]), v1Allowed(read, ["site:intake"]), v1Allowed(read, ["pii"]), v1Allowed(read, ["reports:marketing"])]).toEqual([false, false, false, true, true]);
    expect([v1Allowed(device, ["admin"]), v1Allowed(device, ["pii"]), v1Allowed(device, ["reports:ops"])]).toEqual([false, false, false]);
    const mkt = capabilitiesFor('["reports:marketing"]');
    expect([v1Allowed(mkt, ["reports:marketing"]), v1Allowed(mkt, ["pii"]), v1Allowed(mkt, ["reports:cash"])]).toEqual([true, false, false]);
  });
});

describe("/api/health — redação", () => {
  const env = { DATABASE_URL: "mysql://secret", JWT_SECRET: "x", CRON_SECRET: "cron123", VERCEL_GIT_COMMIT_SHA: "abcdef123456" };
  it("público: só ok + version, sem flags nem erro", () => {
    const body = buildHealthBody({ initFailed: true, detailed: false, env });
    expect(body).toEqual({ ok: false, version: "abcdef1" });
  });
  it("detalhado: só booleanos de presença, nunca valores nem stack", () => {
    const body: any = buildHealthBody({ initFailed: false, detailed: true, env });
    expect(body.ok).toBe(true);
    expect(body.env.DATABASE_URL).toBe(true);
    expect(JSON.stringify(body)).not.toContain("mysql://secret");
    expect(JSON.stringify(body)).not.toContain("cron123");
    expect(body.error).toBeUndefined();
  });
  it("Bearer CRON_SECRET", () => {
    expect(cronBearerOk("Bearer cron123", env)).toBe(true);
    expect(cronBearerOk("Bearer nope", env)).toBe(false);
    expect(cronBearerOk("Bearer ", {})).toBe(false);
  });
});

describe("isFeatureEnabled", () => {
  it.each(["off", "OFF", " False ", "0", "no", "NÃO", "disabled"])("'%s' desliga", (v) => {
    expect(isFeatureEnabled("X", { env: { X: v } })).toBe(false);
  });
  it.each(["on", "TRUE", "1", "yes", "sim"])("'%s' liga (mesmo com default off)", (v) => {
    expect(isFeatureEnabled("X", { env: { X: v }, defaultEnabled: false })).toBe(true);
  });
  it("vazio/desconhecido → valor por omissão", () => {
    expect(isFeatureEnabled("X", { env: {} })).toBe(true);
    expect(isFeatureEnabled("X", { env: { X: "talvez" } })).toBe(true);
    expect(isFeatureEnabled("X", { env: { X: "" }, defaultEnabled: false })).toBe(false);
    expect(parseSwitch(undefined)).toBeNull();
  });
});

describe("retenção do activity_logs", () => {
  it("corte a 24 meses em UTC (20c, decisão do Jorge)", () => {
    expect(activityLogCutoff(new Date("2026-09-24T03:30:00Z"))).toBe("2024-09-24 03:30:00");
  });
  it("lotes: para quando um lote vem incompleto", async () => {
    const remaining = [5000, 5000, 1200];
    const limits: number[] = [];
    const r = await purgeInBatches(async (limit) => { limits.push(limit); return remaining.shift() ?? 0; }, { batchSize: 5000 });
    expect(r).toEqual({ deleted: 11200, batches: 3, done: true });
    expect(limits.every((l) => l === 5000)).toBe(true);
  });
  it("respeita maxBatches e o prazo", async () => {
    const full = await purgeInBatches(async (l) => l, { batchSize: 10, maxBatches: 3 });
    expect(full).toEqual({ deleted: 30, batches: 3, done: false });
    let t = 0;
    const timed = await purgeInBatches(async (l) => { t += 10; return l; }, { batchSize: 10, deadlineAt: 25, now: () => t });
    expect(timed.done).toBe(false);
    expect(timed.batches).toBe(3);
  });
});

describe("validação das taxas dos extras", () => {
  it.each([["5", "5.00"], ["5,5", "5.50"], [" 4.75 ", "4.75"], ["100", "100.00"]])("'%s' → %s", (v, out) => {
    expect(normalizeHourlyRate(v)).toBe(out);
  });
  it.each(["0", "-1", "100.01", "abc", "", "1e2", "NaN", "5.5.5"])("'%s' é inválido", (v) => {
    expect(normalizeHourlyRate(v)).toBeNull();
  });
});

describe("sync manual — intervalo máximo", () => {
  it("aceita até 31 dias e recusa mais/invertido/inválido", () => {
    expect(syncRangeError("2026-09-01", "2026-10-01")).toBeNull();
    expect(syncRangeError("2026-09-01", "2026-10-02")).toMatch(/32 dias/);
    expect(syncRangeError("2026-09-10", "2026-09-01")).toMatch(/anterior/);
    expect(syncRangeError("ontem", "2026-09-01")).toMatch(/inválidas/);
  });
});

describe("migração 0095", () => {
  it("backfill idempotente sem subquery na mesma tabela e antes de apagar o texto em claro", () => {
    const upd = MIGRATION_0095_STATEMENTS.findIndex((s) => s.includes("SHA2(`apiKey`, 256)"));
    const wipe = MIGRATION_0095_STATEMENTS.findIndex((s) => s.includes("SET `apiKey` = NULL"));
    const uniq = MIGRATION_0095_STATEMENTS.findIndex((s) => s.includes("api_keys_keyHash_unique"));
    expect(upd).toBeGreaterThan(-1);
    expect(wipe).toBeGreaterThan(upd);
    expect(uniq).toBeGreaterThan(upd);
    expect(MIGRATION_0095_STATEMENTS[upd]).toMatch(/WHERE `keyHash` IS NULL/);
    expect(MIGRATION_0095_STATEMENTS[wipe]).toMatch(/WHERE `keyHash` IS NOT NULL/);
    for (const s of MIGRATION_0095_STATEMENTS) expect(s).not.toMatch(/\(\s*SELECT/i);
    expect(MIGRATION_0095_STATEMENTS.some((s) => s.includes("idx_activity_logs_entity_createdAt"))).toBe(true);
    expect(IDEMPOTENT_ERROR_CODES_0095.has("ER_DUP_KEYNAME")).toBe(true);
  });
});
