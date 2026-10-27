import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSharedAuthClient, encodeSharedPassword, mapStatus, pickSharedUser, SharedAuthError } from "./_core/sharedAuth";
import { clearSharedSessionCacheForTests, sharedSessionStillValidWith, SHARED_SESSION_RECHECK_MS, SHARED_SESSION_RETRY_MS } from "./sharedSessionCheck";

const config = { url: "https://auth.example", serviceToken: "dash-token", timeoutMs: 1000 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("sharedAuth client", () => {
  it("palavra-passe em base64 (como as apps), email em minúsculas, X-Client-Name e IP da pessoa", async () => {
    const fetchImpl = vi.fn(async () => json(200, { user: { id: "s1", email: "Ana@Gmail.com", firstName: "Ana", lastName: "S", isActive: true, emailVerifiedAt: null, iban: "PT50…" }, token: "a", refreshToken: "r", sessionId: "sess1" }));
    const client = createSharedAuthClient(config, fetchImpl as any);
    const s = await client.passwordLogin(" ANA@gmail.com ", "pässwörd", { ip: "1.2.3.4", userAgent: "UA" });
    const [url, init] = fetchImpl.mock.calls[0] as any[];
    expect(url).toBe("https://auth.example/api/auth/login");
    expect(JSON.parse(init.body)).toEqual({ email: "ana@gmail.com", password: encodeSharedPassword("pässwörd") });
    expect(Buffer.from(encodeSharedPassword("pässwörd"), "base64").toString("utf8")).toBe("pässwörd");
    expect(init.headers).toMatchObject({ "X-Client-Name": "dashboard", "X-Client-IP": "1.2.3.4", "X-Client-User-Agent": "UA", "X-Service-Token": "dash-token" });
    expect(s.sessionId).toBe("sess1");
    expect(s.user).toEqual({ id: "s1", email: "ana@gmail.com", firstName: "Ana", lastName: "S", isActive: true, emailVerifiedAt: null });
    expect((s.user as any).iban).toBeUndefined();
  });

  it("mapeia os erros e trata 404 de pesquisa como 'não existe'", async () => {
    expect(mapStatus(401, {})).toBe("invalid_credentials");
    expect(mapStatus(401, { code: "GOOGLE_TOKEN_INVALID" })).toBe("invalid_token");
    expect(mapStatus(403, { code: "ACCOUNT_DEACTIVATED" })).toBe("account_deactivated");
    expect(mapStatus(403, { code: "SERVICE_SCOPE_DENIED" })).toBe("forbidden");
    expect(mapStatus(429, {})).toBe("rate_limited");
    expect(mapStatus(502, {})).toBe("unavailable");
    const client = createSharedAuthClient(config, (async () => json(404, { error: "User not found" })) as any);
    expect(await client.userByEmail("x@y.pt")).toBeNull();
    expect(await client.userById("s1")).toBeNull();
  });

  it("rede em baixo → unavailable; sem configuração → not_configured", async () => {
    const down = createSharedAuthClient(config, (async () => { throw new TypeError("fetch failed"); }) as any);
    await expect(down.passwordLogin("a@b.pt", "x")).rejects.toMatchObject({ code: "unavailable" });
    const none = createSharedAuthClient(null);
    expect(none.configured).toBe(false);
    await expect(none.userByEmail("a@b.pt")).rejects.toBeInstanceOf(SharedAuthError);
    expect(await none.endSession("sess1")).toBe(false);
  });

  it("pickSharedUser recusa lixo", () => {
    expect(pickSharedUser(null)).toBeNull();
    expect(pickSharedUser({ id: 1, email: "x" })).toBeNull();
    expect(pickSharedUser({ id: "s", email: "x@y.pt" })?.emailVerifiedAt).toBeUndefined();
  });
});

describe("sharedSessionCheck", () => {
  beforeEach(() => clearSharedSessionCacheForTests());

  it("ativa → aceita e guarda 5 min; terminada → recusa", async () => {
    const check = vi.fn(async (ids: string[]) => new Set(ids.filter((id) => id === "alive")));
    expect(await sharedSessionStillValidWith("alive", check, 0)).toBe(true);
    expect(await sharedSessionStillValidWith("alive", check, SHARED_SESSION_RECHECK_MS - 1)).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    expect(await sharedSessionStillValidWith("alive", check, SHARED_SESSION_RECHECK_MS + 1)).toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
    expect(await sharedSessionStillValidWith("ended", check, 0)).toBe(false);
  });

  it("FALHA ABERTA: be-shared em baixo → continua aceite e volta a perguntar daqui a 1 min", async () => {
    const check = vi.fn(async () => { throw new SharedAuthError("unavailable"); });
    expect(await sharedSessionStillValidWith("s", check, 0)).toBe(true);
    expect(await sharedSessionStillValidWith("s", check, SHARED_SESSION_RETRY_MS - 1)).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    // Já sabíamos que estava terminada: uma falha de rede não a ressuscita.
    clearSharedSessionCacheForTests();
    await sharedSessionStillValidWith("dead", async () => new Set(), 0);
    expect(await sharedSessionStillValidWith("dead", check, SHARED_SESSION_RECHECK_MS + 1)).toBe(false);
  });

  it("pedidos simultâneos à mesma sessão fazem uma só consulta", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const check = vi.fn(async (ids: string[]) => { await gate; return new Set(ids); });
    const a = sharedSessionStillValidWith("x", check, 0);
    const b = sharedSessionStillValidWith("x", check, 0);
    release();
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
