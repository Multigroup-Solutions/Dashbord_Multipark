/**
 * Login pelo QR do PDA, ponta a ponta pelas rotas HTTP (#335): o login começa
 * num browser (a app de leitura do QR) e a Google devolve a pessoa noutro
 * (Chrome), SEM o cookie de state. O state assinado chega sozinho e a pessoa
 * volta ao "Registar PDA". Google, BD e sessão são falsos; o resto é o código real.
 */
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  getDb: vi.fn(async () => null),
  upsertUser: vi.fn(async () => undefined),
  getUserByOpenId: vi.fn(async () => ({ id: 7, isActive: 1, sessionVersion: 0 })),
  getUserByEmail: vi.fn(async () => undefined),
  logActivity: vi.fn(async () => undefined),
}));
vi.mock("../identity", () => ({
  adoptPlaceholderAccountByEmail: vi.fn(async () => undefined),
  linkEmployeesToUserByEmail: vi.fn(async () => []),
}));
vi.mock("./sdk", () => ({
  sdk: {
    exchangeCodeForToken: vi.fn(async () => ({ access_token: "at" })),
    getUserInfo: vi.fn(async () => ({ sub: "123", email: "pda.teste@multipark.pt", email_verified: true, name: "Teste PDA" })),
    createSessionToken: vi.fn(async () => "sessao-falsa"),
    authenticateRequest: vi.fn(async () => null),
  },
}));

import { COOKIE_NAME } from "@shared/const";
import { registerOAuthRoutes } from "./oauth";
import { OAUTH_STATE_MAX_MS, createOAuthState } from "./oauthState";
import { sdk } from "./sdk";

const SECRET = "segredo-de-teste-com-tamanho-suficiente";
const PDA_PATH = "/pda/registar?pda=20&c=5131a65e02b5422a8698c298b9d9b5f4";
const ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "JWT_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};

let server: Server;
let base = "";

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.GOOGLE_CLIENT_ID = "cliente-teste";
  process.env.GOOGLE_CLIENT_SECRET = "segredo-cliente-teste";
  process.env.JWT_SECRET = SECRET;
  const app = express();
  registerOAuthRoutes(app);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => vi.clearAllMocks());

function cookiesOf(res: Response): string[] {
  return res.headers.getSetCookie();
}

async function startLogin(): Promise<{ google: URL; stateCookie: string }> {
  const res = await fetch(`${base}/api/oauth/login?next=${encodeURIComponent(PDA_PATH)}&pda=1`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const google = new URL(res.headers.get("location")!);
  const stateCookie = cookiesOf(res).find((c) => c.startsWith("app_oauth_state="))!;
  expect(stateCookie).toBeTruthy();
  return { google, stateCookie: stateCookie.split(";")[0] };
}

function callback(state: string, cookie?: string): Promise<Response> {
  return fetch(`${base}/api/oauth/callback?code=codigo-google&state=${encodeURIComponent(state)}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
}

describe("login pelo QR do PDA (rotas reais)", () => {
  it("no PDA pede para escolher a conta, sem consentimento nem acesso offline", async () => {
    const { google } = await startLogin();
    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.searchParams.get("prompt")).toBe("select_account");
    expect(google.searchParams.get("access_type")).toBeNull();
    expect(google.toString()).not.toContain("consent");
    expect(google.searchParams.get("redirect_uri")).toBe(`${base}/api/oauth/callback`);
  });

  it("volta noutro browser SEM cookie → entra e cai no Registar PDA", async () => {
    const { google } = await startLogin();
    const res = await callback(google.searchParams.get("state")!);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(PDA_PATH);
    expect(cookiesOf(res).some((c) => c.startsWith(`${COOKIE_NAME}=sessao-falsa`))).toBe(true);
    expect(sdk.exchangeCodeForToken).toHaveBeenCalledWith("codigo-google", `${base}/api/oauth/callback`);
  });

  it("no mesmo browser (cookie igual) também entra", async () => {
    const { google, stateCookie } = await startLogin();
    const res = await callback(google.searchParams.get("state")!, stateCookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(PDA_PATH);
  });

  it("state adulterado, expirado ou com cookie de outro login → 400 com Tentar de novo, sem falar com a Google", async () => {
    const { google } = await startLogin();
    const st = google.searchParams.get("state")!;
    const [payload, sig] = st.split(".");
    const forged = Buffer.from(JSON.stringify({ n: "x", t: Date.now(), r: "/admin" })).toString("base64url");
    const expired = createOAuthState(SECRET, { returnTo: PDA_PATH, now: Date.now() - OAUTH_STATE_MAX_MS - 1000 });
    const other = createOAuthState(SECRET, {});

    for (const res of [
      await callback(`${forged}.${sig}`),
      await callback(`${payload}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`),
      await callback(expired),
      await callback(st, `app_oauth_state=${encodeURIComponent(other)}`),
    ]) {
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("O pedido de entrada expirou");
      expect(html).toContain("Tentar de novo");
      expect(cookiesOf(res).some((c) => c.startsWith(`${COOKIE_NAME}=sessao-falsa`))).toBe(false);
    }
    expect(sdk.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("Cancelar na Google → página com Tentar de novo que volta ao Registar PDA", async () => {
    const { google } = await startLogin();
    const res = await fetch(`${base}/api/oauth/callback?error=access_denied&state=${encodeURIComponent(google.searchParams.get("state")!)}`, { redirect: "manual" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Entrada cancelada");
    // no PDA, a repetição volta a pedir a conta (pda=1, D61)
    expect(html).toContain(`/api/oauth/login?next=${encodeURIComponent(PDA_PATH)}&pda=1`.replace(/&/g, "&amp;"));
  });

  it("login fora do PDA: Tentar de novo sem pda=1", async () => {
    const res = await fetch(`${base}/api/oauth/login?next=%2Frh`, { redirect: "manual" });
    const google = new URL(res.headers.get("location")!);
    expect(google.searchParams.get("prompt")).toBeNull();
    const cb = await fetch(`${base}/api/oauth/callback?error=access_denied&state=${encodeURIComponent(google.searchParams.get("state")!)}`, { redirect: "manual" });
    const html = await cb.text();
    expect(html).toContain('href="/api/oauth/login?next=%2Frh"');
  });
});
