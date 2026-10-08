/**
 * 49c (Jorge, 8 out 2026), pelas rotas HTTP reais do login: quem está
 * INATIVO (extra/condutor, motivo que não bloqueia) entra de novo como
 * utilizador; DESATIVADO, estrutura, conta bloqueada ou conta sem ficha →
 * recusado como sempre (a mesma mensagem). Google, BD e sessão são falsos;
 * a regra (shared/comeback.ts) e o login (oauth.ts + comebackLogin.ts) são reais.
 */
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  account: { id: 7, isActive: 0, role: "extra", deactivationReason: "inatividade" as string | null, sessionVersion: 0 },
  fichas: [] as any[],
  reactivated: [] as number[],
  converted: [] as Array<[number, number]>,
  logs: [] as string[],
}));

vi.mock("../db", () => ({
  getDb: vi.fn(async () => null),
  upsertUser: vi.fn(async () => undefined),
  getUserByOpenId: vi.fn(async () => ({ ...s.account })),
  getUserByEmail: vi.fn(async () => undefined),
  logActivity: vi.fn(async (e: any) => { s.logs.push(String(e?.details ?? "")); }),
}));
vi.mock("../identity", () => ({
  adoptPlaceholderAccountByEmail: vi.fn(async () => undefined),
  linkEmployeesToUserByEmail: vi.fn(async () => []),
}));
vi.mock("../comebackStore", () => ({
  loadLoginFichas: vi.fn(async () => s.fichas),
  reactivateAccountAsUser: vi.fn(async (userId: number) => { s.reactivated.push(userId); s.account = { ...s.account, isActive: 1, role: "user", deactivationReason: null }; }),
  convertSuspensionToInactive: vi.fn(async (employeeId: number, userId: number) => { s.converted.push([employeeId, userId]); s.account = { ...s.account, role: "user" }; }),
  logComeback: vi.fn(async (_u: number, _e: number, details: string) => { s.logs.push(details); }),
}));
vi.mock("./sdk", () => ({
  sdk: {
    exchangeCodeForToken: vi.fn(async () => ({ access_token: "at" })),
    getUserInfo: vi.fn(async () => ({ sub: "777", email: "ana.volta@gmail.com", email_verified: true, name: "Ana Volta" })),
    createSessionToken: vi.fn(async () => "sessao-falsa"),
    authenticateRequest: vi.fn(async () => null),
  },
}));

import { AUTH_DENIED_PARAM, COOKIE_NAME } from "@shared/const";
import { registerOAuthRoutes } from "./oauth";

const SECRET = "segredo-de-teste-com-tamanho-suficiente";
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
  server = await new Promise<Server>((resolve) => { const x = app.listen(0, "127.0.0.1", () => resolve(x)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const ficha = (o: Record<string, unknown> = {}) => ({ id: 70, position: "extra", isActive: 0, deactivationReason: "inatividade", blockedManually: 0, blockedByDocs: 0, blockedByPenalties: 0, loginBlockedReason: null, ...o });

beforeEach(() => {
  vi.clearAllMocks();
  s.account = { id: 7, isActive: 0, role: "extra", deactivationReason: "inatividade", sessionVersion: 0 };
  s.fichas = [ficha()];
  s.reactivated = [];
  s.converted = [];
  s.logs = [];
});

async function login(): Promise<Response> {
  const start = await fetch(`${base}/api/oauth/login`, { redirect: "manual" });
  const google = new URL(start.headers.get("location")!);
  const cookie = start.headers.getSetCookie().find((c) => c.startsWith("app_oauth_state="))!.split(";")[0];
  return fetch(`${base}/api/oauth/callback?code=codigo&state=${encodeURIComponent(google.searchParams.get("state")!)}`, { redirect: "manual", headers: { cookie } });
}
const entered = (res: Response) => res.status === 302 && res.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE_NAME}=sessao-falsa`));
const denied = (res: Response) => res.status === 302 && String(res.headers.get("location")).includes(`${AUTH_DENIED_PARAM}=`) && !entered(res);

describe("49c: login de quem está inativo", () => {
  it("extra INATIVO (inatividade) → a conta volta como utilizador, entra e fica no registo", async () => {
    const res = await login();
    expect(entered(res)).toBe(true);
    expect(res.headers.get("location")).toBe("/");
    expect(s.reactivated).toEqual([7]);
    expect(s.logs.join(" | ")).toContain("Voltou a entrar como utilizador; a ficha continua inativa até o RH reativar");
  });

  it.each(["fora_do_pais", "pedido_proprio", "ausencia_prolongada", "fim_contrato", "mudanca_funcao", "documentos", "candidato"])("motivo %s (não bloqueia) → entra", async (reason) => {
    s.fichas = [ficha({ deactivationReason: reason })];
    expect(entered(await login())).toBe(true);
  });

  it.each(["roubou", "despedido", "trabalha_mal", "comportamento", "faltas", "seguranca", "outro", "conta_duplicada", "ficha_duplicada", null])("ficha DESATIVADA (%s) → recusado, nada muda", async (reason) => {
    s.fichas = [ficha({ deactivationReason: reason })];
    expect(denied(await login())).toBe(true);
    expect(s.reactivated).toEqual([]);
  });

  it("conta desativada à mão por segurança (ficha inativa por inatividade) → recusado", async () => {
    s.account = { ...s.account, deactivationReason: "seguranca" };
    expect(denied(await login())).toBe(true);
    expect(s.reactivated).toEqual([]);
  });

  it.each(["team_leader", "supervisor", "backoffice", "admin"])("estrutura (posto %s) → recusado como hoje", async (position) => {
    s.fichas = [ficha({ position })];
    expect(denied(await login())).toBe(true);
  });

  it("papel de estrutura na conta (supervisor) com ficha de extra → recusado", async () => {
    s.account = { ...s.account, role: "supervisor" };
    expect(denied(await login())).toBe(true);
  });

  it("conta desativada SEM ficha → recusado", async () => {
    s.fichas = [];
    expect(denied(await login())).toBe(true);
  });

  it("conta desativada mas com uma ficha ATIVA → recusado (não se mexe)", async () => {
    s.fichas = [ficha({ isActive: 1, deactivationReason: null })];
    expect(denied(await login())).toBe(true);
  });

  it("antigo 'Suspenso: sem atividade' (conta ativa) → passa a inativo, conta a utilizador e entra", async () => {
    s.account = { id: 7, isActive: 1, role: "extra", deactivationReason: null, sessionVersion: 0 };
    s.fichas = [ficha({ isActive: 1, deactivationReason: null, blockedManually: 1, loginBlockedReason: "Suspenso: sem atividade há mais de 6 meses. Contacta o supervisor." })];
    const res = await login();
    expect(entered(res)).toBe(true);
    expect(s.converted).toEqual([[70, 7]]);
  });

  it("suspenso por outra razão (manual do RH) ou também por faltas → fica como está (o bloqueio continua na app)", async () => {
    s.account = { id: 7, isActive: 1, role: "extra", deactivationReason: null, sessionVersion: 0 };
    s.fichas = [ficha({ isActive: 1, deactivationReason: null, blockedManually: 1, loginBlockedReason: "Suspenso pelo RH. Contacta o supervisor." })];
    await login();
    s.fichas = [ficha({ isActive: 1, deactivationReason: null, blockedManually: 1, blockedByPenalties: 1, loginBlockedReason: "faltas em extras-dia sem aviso · Suspenso: sem atividade há mais de 6 meses. Contacta o supervisor." })];
    await login();
    expect(s.converted).toEqual([]);
  });
});
