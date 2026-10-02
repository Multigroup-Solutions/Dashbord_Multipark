/**
 * P3 lote 20a — API keys: capacidades por chave (as antigas mantêm o que
 * faziam), revogar em vez de apagar, autor = a chave (não quem a criou),
 * limite por chave, erros sem fuga, validade ao fim do dia em Lisboa.
 */
import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = vi.hoisted(() => ({
  keys: new Map<number, any>(),
  logs: [] as any[],
  revoked: [] as Array<{ id: number; by: number; reason: string }>,
  perms: [] as Array<{ id: number; permissions: string }>,
  created: [] as any[],
}));

vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  logActivity: async (row: any) => { mem.logs.push(row); },
  getApiKeys: async (opts: { includeRevoked?: boolean } = {}) =>
    Array.from(mem.keys.values()).filter((k) => opts.includeRevoked || !k.revokedAt),
  getApiKeyById: async (id: number) => mem.keys.get(id) ?? null,
  createApiKey: async (row: any) => { mem.created.push(row); return 99; },
  setApiKeyPermissions: async (id: number, permissions: string) => {
    const k = mem.keys.get(id);
    if (!k || k.revokedAt) return false;
    mem.perms.push({ id, permissions }); k.permissions = permissions; return true;
  },
  toggleApiKey: async (id: number, active: boolean) => {
    const k = mem.keys.get(id);
    if (!k || k.revokedAt) return false;
    k.active = active ? 1 : 0; return true;
  },
  revokeApiKey: async (id: number, by: number, reason: string) => {
    const k = mem.keys.get(id);
    if (!k || k.revokedAt) return false;
    mem.revoked.push({ id, by, reason }); k.revokedAt = "2026-10-02 10:00:00"; k.active = 0; return true;
  },
}));

import { appRouter } from "./routers";
import {
  API_KEY_CAPABILITIES, capabilitiesFor, capabilitiesLabel, isLegacyPermissions, normalizeCapabilities,
} from "../shared/apiKeyCapabilities";
import {
  apiInternalError, apiKeyRateWait, checkPresentedKey, hashApiKey, requireAnyV1Capability, requireCapability, v1Allowed,
} from "./apiKeyAuth";
import { apiKeyLogName, lisbonEndOfDayUtc } from "./apiKeysRouter";
import { radioAudioUrlError } from "./externalApi";
import { MIGRATION_0405_STATEMENTS, IDEMPOTENT_ERROR_CODES_0405 } from "./migrations/migration_0405";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const caller = (role: string, id = 1) => appRouter.createCaller({ user: { id, role, name: "Jorge", accessOverrides: {} }, req: { headers: {} }, res: {} } as any);

beforeEach(() => {
  mem.keys.clear(); mem.logs.length = 0; mem.revoked.length = 0; mem.perms.length = 0; mem.created.length = 0;
  mem.keys.set(3, { id: 3, name: "Site", keyPrefix: "mp_ab12cd", permissions: '["read","write"]', active: 1, expiresAt: null, lastUsedAt: null, createdById: 1, createdAt: "2026-01-01 00:00:00", revokedAt: null });
  mem.keys.set(4, { id: 4, name: "Velha", keyPrefix: "mp_zz99yy", permissions: '["read"]', active: 1, expiresAt: null, lastUsedAt: null, createdById: 1, createdAt: "2026-01-01 00:00:00", revokedAt: "2026-05-01 00:00:00" });
});

// ─── Rotas: todas declaram a capacidade ──────────────────────────────────────

type Route = { file: string; method: string; path: string; caps: string[] | "any" };
function routes(): Route[] {
  const out: Route[] = [];
  for (const file of ["server/mcpApi.ts", "server/mcpReportsApi.ts", "server/mcpMarketingApi.ts"]) {
    for (const line of read(file).split("\n")) {
      const m = line.match(/\br\.(get|post|patch|put|delete)\("([^"]+)",\s*(.*)$/);
      if (!m) continue;
      const rest = m[3];
      const cap = rest.match(/^requireCapability\(([^)]*)\)/);
      const any = /^requireAnyV1Capability\(\)/.test(rest);
      out.push({ file, method: m[1].toUpperCase(), path: m[2], caps: any ? "any" : cap ? cap[1].split(",").map((x) => x.trim().replace(/"/g, "")) : [] });
    }
  }
  return out;
}

describe("20a cada rota da /api/v1 pede uma capacidade", () => {
  it("nenhuma rota sem requireCapability (nem requireScope antigo)", () => {
    const rs = routes();
    expect(rs.length).toBeGreaterThan(40);
    const missing = rs.filter((r) => r.caps !== "any" && r.caps.length === 0).map((r) => `${r.file} ${r.method} ${r.path}`);
    expect(missing).toEqual([]);
    for (const f of ["server/mcpApi.ts", "server/mcpReportsApi.ts", "server/mcpMarketingApi.ts"]) expect(read(f)).not.toMatch(/requireScope\(/);
    for (const r of rs) if (r.caps !== "any") for (const c of r.caps) expect(API_KEY_CAPABILITIES).toContain(c);
  });

  it("chaves antigas mantêm o que faziam: read lê tudo, write escreve, admin só com admin", () => {
    const legacyRead = capabilitiesFor('["read"]');
    const legacyWrite = capabilitiesFor('["read","write"]');
    const legacyAdmin = capabilitiesFor('["admin"]');
    for (const r of routes()) {
      if (r.caps === "any") continue;
      const caps = r.caps as any[];
      const adminOnly = caps.length === 1 && caps[0] === "admin";
      expect(v1Allowed(legacyAdmin, caps), `${r.method} ${r.path}`).toBe(true);
      if (adminOnly) {
        expect(v1Allowed(legacyWrite, caps), `${r.method} ${r.path}`).toBe(false);
      } else {
        expect(v1Allowed(legacyWrite, caps), `${r.method} ${r.path}`).toBe(true);
        if (r.method === "GET") expect(v1Allowed(legacyRead, caps), `${r.method} ${r.path}`).toBe(true);
      }
    }
  });

  it("dados pessoais à parte: reservas, reclamações, críticas e colaboradores pedem pii", () => {
    const by = new Map(routes().map((r) => [`${r.method} ${r.path}`, r.caps]));
    for (const k of ["GET /bookings", "GET /bookings/:externalId", "GET /complaints", "GET /complaints/:id", "GET /reviews", "GET /employees"]) {
      expect(by.get(k), k).toEqual(["pii"]);
    }
    expect(by.get("GET /cash/counts")).toEqual(["reports:cash"]);
    expect(by.get("GET /marketing/stats")).toEqual(["reports:marketing"]);
    expect(by.get("POST /driver-applications")).toEqual(["site:intake"]);
    expect(by.get("POST /complaints")).toEqual(["complaints:write"]);
    expect(by.get("DELETE /complaints/:id")).toEqual(["admin"]);
    expect(by.get("GET /")).toBe("any");
    expect(read("server/mcpApi.ts")).toMatch(/r\.use\("\/admin", requireCapability\("admin"\)\)/);
  });

  it("middleware: sem a capacidade → 403; o índice pede uma capacidade da v1 (dispositivo não conta)", () => {
    const res = () => { const r: any = { code: 0, body: null }; r.status = (c: number) => { r.code = c; return r; }; r.json = (b: any) => { r.body = b; return r; }; return r; };
    const next = vi.fn();
    const r1 = res();
    requireCapability("pii")({ apiKeyCaps: capabilitiesFor('["reports:marketing"]') } as any, r1, next);
    expect(r1.code).toBe(403);
    expect(next).not.toHaveBeenCalled();
    requireCapability("pii")({ apiKeyCaps: capabilitiesFor('["pii"]') } as any, res(), next);
    expect(next).toHaveBeenCalledTimes(1);
    const r2 = res();
    requireAnyV1Capability()({ apiKeyCaps: capabilitiesFor(null) } as any, r2, next);
    expect(r2.code).toBe(403);
  });
});

// ─── Capacidades ─────────────────────────────────────────────────────────────

describe("20a capacidades", () => {
  it("normaliza: admin = tudo, desconhecidas fora, ordem fixa", () => {
    expect(normalizeCapabilities(["pii", "reports:ops", "pii", "xpto"])).toEqual(["reports:ops", "pii"]);
    expect(normalizeCapabilities(["pii", "admin"])).toEqual(["admin"]);
    expect(capabilitiesFor('["admin"]').size).toBe(API_KEY_CAPABILITIES.length);
    expect(capabilitiesLabel(capabilitiesFor('["admin"]'))).toBe("Administração (tudo)");
    expect(capabilitiesLabel(new Set(["reports:marketing", "pii"] as const))).toBe("Marketing, Dados pessoais");
  });
  it("chave antiga reconhecida (read/write/vazio); as novas não", () => {
    expect(isLegacyPermissions('["read"]')).toBe(true);
    expect(isLegacyPermissions(null)).toBe(true);
    expect(isLegacyPermissions("read,write")).toBe(true);
    expect(isLegacyPermissions('["device"]')).toBe(false);
    expect(isLegacyPermissions('["reports:ops","pii"]')).toBe(false);
    expect(Array.from(capabilitiesFor(null))).toEqual(["device"]);
  });
});

// ─── Chave revogada / expirada ───────────────────────────────────────────────

describe("20a revogada nunca entra; expirada = mesma resposta", () => {
  it("revogada ou expirada → 403 genérico", async () => {
    const key = "mp_secretsecretsecretsecretsecret00";
    const base = { id: 1, name: "k", keyPrefix: "mp_secret", permissions: '["pii"]', active: 1, expiresAt: null, lastUsedAt: null, createdById: 1 };
    const revoked = await checkPresentedKey(key, async (h) => (h === hashApiKey(key) ? { ...base, revokedAt: "2026-10-01 00:00:00" } : null));
    expect(revoked).toMatchObject({ ok: false, status: 403, error: "Invalid or inactive API key" });
    const expired = await checkPresentedKey(key, async () => ({ ...base, expiresAt: "2026-01-01 00:00:00" }), Date.parse("2026-02-01T00:00:00Z"));
    expect(expired).toEqual(revoked);
  });
  it("validade = fim do dia em Lisboa (verão e inverno)", () => {
    expect(lisbonEndOfDayUtc("2026-07-15")).toBe("2026-07-15 22:59:59");
    expect(lisbonEndOfDayUtc("2026-12-01")).toBe("2026-12-01 23:59:59");
    expect(read("server/settingsRouter.ts")).toMatch(/lisbonEndOfDayUtc\(input\.expiresOn\)/);
    expect(read("server/settingsRouter.ts")).not.toMatch(/`\$\{input\.expiresOn\} 23:59:59`/);
  });
});

// ─── Limite e erros ──────────────────────────────────────────────────────────

describe("20a limite por chave e erros sem fuga", () => {
  it("240 pedidos por minuto por chave; a seguinte espera", () => {
    const t0 = 5_000_000;
    for (let i = 0; i < 240; i++) expect(apiKeyRateWait(901, t0 + i)).toBe(0);
    expect(apiKeyRateWait(901, t0 + 500)).toBeGreaterThan(0);
    expect(apiKeyRateWait(902, t0 + 500)).toBe(0);
    expect(apiKeyRateWait(901, t0 + 60_001)).toBe(0);
  });
  it("500 = 'Erro interno (ref …)', sem a mensagem real", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r: any = { headersSent: false, code: 0, body: null };
    r.status = (c: number) => { r.code = c; return r; };
    r.json = (b: any) => { r.body = b; return r; };
    apiInternalError(r, "teste", new Error("ER_NO_SUCH_TABLE: Table 'prod.secret' doesn't exist"));
    expect(r.code).toBe(500);
    expect(r.body.error).toMatch(/^Erro interno \(ref [0-9a-f]{8}\)$/);
    expect(JSON.stringify(r.body)).not.toContain("secret");
    err.mockRestore();
  });
  it("nenhuma rota devolve e.message num 500", () => {
    for (const f of ["server/externalApi.ts", "server/mcpApi.ts", "server/mcpMarketingApi.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/status\(500\)\.json\(\{[^}]*\b(e|err)\.message/);
      expect(src, f).not.toMatch(/String\(e\?\.message \|\| "Erro interno"\)/);
    }
  });
  it("rádio: só endereços http(s) públicos", () => {
    expect(radioAudioUrlError("https://bucket.s3.eu-west-1.amazonaws.com/radio/a.mp3")).toBeNull();
    expect(radioAudioUrlError("http://example.com/a.mp3")).toBeNull();
    for (const bad of ["", "file:///etc/passwd", "http://localhost/a", "http://127.0.0.1/a", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/a",
      "http://192.168.1.1/a", "http://172.20.0.1/a", "http://[::1]/a", "http://2130706433/a", "http://intranet/a", "https://user:pw@example.com/a", "ftp://x.com/a"]) {
      expect(radioAudioUrlError(bad), bad).not.toBeNull();
    }
  });
});

// ─── Ecrã/servidor: criar, reduzir, revogar ──────────────────────────────────

describe("20a gerir chaves", () => {
  it("só super admin", async () => {
    await expect(caller("admin").apiKeys.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("lista: chave antiga com as capacidades equivalentes e o aviso; revogadas só a pedido", async () => {
    const list = await caller("super_admin").apiKeys.list();
    expect(list.map((k) => k.id)).toEqual([3]);
    expect(list[0].legacy).toBe(true);
    expect(list[0].capabilities).toEqual(["site:intake", "reports:ops", "reports:cash", "reports:marketing", "pii", "complaints:write", "device"]);
    const all = await caller("super_admin").apiKeys.list({ includeRevoked: true });
    expect(all.map((k) => k.id).sort()).toEqual([3, 4]);
  });
  it("criar: grava só as capacidades marcadas e regista nome + prefixo", async () => {
    const r = await caller("super_admin").apiKeys.create({ name: "MCP relatórios", capabilities: ["reports:marketing", "reports:ops"], expiresInDays: 30 });
    expect(r.key).toMatch(/^mp_/);
    expect(mem.created[0].permissions).toBe('["reports:ops","reports:marketing"]');
    expect(mem.created[0].expiresAt).toMatch(/^\d{4}-\d{2}-\d{2} (22|23):59:59$/);
    expect(mem.logs[0].details).toMatch(/«MCP relatórios» \(mp_.{6}…\) criada — pode: Relatórios de operação, Marketing; válida até/);
    await expect(caller("super_admin").apiKeys.create({ name: "x", capabilities: [] as any })).rejects.toThrow();
  });
  it("reduzir uma chave antiga: antes → depois no registo", async () => {
    await caller("super_admin").apiKeys.setCapabilities({ id: 3, capabilities: ["site:intake"] });
    expect(mem.perms).toEqual([{ id: 3, permissions: '["site:intake"]' }]);
    expect(mem.logs[0]).toMatchObject({ entity: "api_key", entityId: 3, userId: 1 });
    expect(mem.logs[0].details).toMatch(/#3 «Site» \(mp_ab12cd…\): capacidades .*Dados pessoais.* \(chave antiga\) → Formulários do site$/);
  });
  it("revogar: pede motivo, nunca apaga, não reativa", async () => {
    await expect(caller("super_admin").apiKeys.revoke({ id: 3, reason: "" })).rejects.toThrow();
    const r = await caller("super_admin").apiKeys.revoke({ id: 3, reason: "substituída" });
    expect(r).toEqual({ success: true, alreadyRevoked: false });
    expect(mem.revoked).toEqual([{ id: 3, by: 1, reason: "substituída" }]);
    expect(mem.logs[0]).toMatchObject({ action: "revoke", entityId: 3 });
    await expect(caller("super_admin").apiKeys.toggle({ id: 3, active: true })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller("super_admin").apiKeys.setCapabilities({ id: 3, capabilities: ["pii"] })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await caller("super_admin").apiKeys.revoke({ id: 3, reason: "outra vez" })).toEqual({ success: true, alreadyRevoked: true });
  });
  it("nada de DELETE nas chaves; migração 0405 idempotente e registada", () => {
    const db = read("server/db.ts");
    expect(db).not.toMatch(/db\.delete\(apiKeys\)/);
    expect(db).toMatch(/export async function revokeApiKey/);
    expect(read("server/apiKeysRouter.ts")).not.toMatch(/delete:/);
    expect(MIGRATION_0405_STATEMENTS.every((s) => /^ALTER TABLE `api_keys` ADD COLUMN/.test(s))).toBe(true);
    expect(IDEMPOTENT_ERROR_CODES_0405.has("ER_DUP_FIELDNAME")).toBe(true);
    expect(read("server/migrations/index.ts")).toMatch(/\["0405", \(\) => import\("\.\/migration_0405"\)/);
  });
  it("autor do que a chave faz = 0 (Sistema), com a etiqueta da chave", () => {
    const src = read("server/apiKeyAuth.ts");
    expect(src).toMatch(/export function apiKeyActorId\(_key\?: unknown\): number \{\n\s*return 0;/);
    expect(apiKeyLogName({ id: 7, name: "Site", keyPrefix: "mp_x" })).toBe("#7 «Site» (mp_x…)");
  });
  it("ecrã: erro ≠ vazio, toasts de erro, sem 'npm install', MCP sem admin, avisa as chefias", () => {
    const page = read("client/src/pages/ApiKeysPage.tsx");
    expect(page).toMatch(/<QueryErrorNote error=\{keysQuery\.error\}/);
    expect(page).toMatch(/onError: onErr\("Não foi possível criar a chave"\)/);
    expect(page).not.toMatch(/npm install/);
    expect(page).not.toMatch(/Notifica automaticamente o Super Admin/);
    expect(page).toMatch(/Não uses "Administração" num MCP/);
    expect(page).toMatch(/break-all/);
    expect(read("server/externalApi.ts")).toMatch(/Avisa as chefias da cidade do condutor/);
    const readme = read("mcp-server/README.md");
    expect(readme).not.toMatch(/INSERT INTO api_keys/);
    expect(readme).toMatch(/não uses num MCP/);
  });
});
