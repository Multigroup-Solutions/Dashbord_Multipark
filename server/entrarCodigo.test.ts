/**
 * Plano 56 (A1): entrar com email + código + palavra-passe, pelas rotas reais
 * (tRPC `auth.*`, `users.resetAccess` e o login Google por HTTP). A BD é uma
 * loja em memória (server/loginStore.ts trocado); a Google, o sino e o push são
 * falsos. O resto — procura da conta, códigos, palavra-passe (scrypt), portas
 * do Google (`completeLogin`) — é o código real.
 */
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const canon = (e: string | null | undefined) => {
    const s = String(e ?? "").trim().toLowerCase();
    const at = s.lastIndexOf("@");
    if (at <= 0) return s;
    const dom = s.slice(at + 1);
    if (dom !== "gmail.com" && dom !== "googlemail.com") return s;
    return `${s.slice(0, at).split("+")[0].replace(/\./g, "")}@gmail.com`;
  };
  const state = {
    nextId: 100,
    users: [] as any[],
    fichas: [] as any[],
    codes: [] as any[],
    assignments: [] as any[],
    rhAdmins: [] as number[],
    shared: new Set<string>(),
    logs: [] as any[],
    notified: [] as any[],
    pushed: [] as any[],
    google: { sub: "g-1", email: "x@gmail.com", name: "Pessoa Google", email_verified: true } as any,
    /** Só nos testes do SQL da loja: um executor falso que guarda as queries. */
    fakeDb: null as any,
  };
  const userRow = (u: any) => u && ({
    id: u.id, openId: u.openId, email: u.email ?? null, name: u.name ?? null, role: u.role, isActive: u.isActive,
    loginMethod: u.loginMethod ?? null, googleSub: u.googleSub ?? null, hasPassword: !!u.passwordHash,
    deactivationReason: u.deactivationReason ?? null, sessionVersion: u.sessionVersion ?? 0,
  });
  const fichaRow = (f: any) => ({ id: f.id, fullName: f.fullName, isActive: f.isActive, userId: f.userId ?? null, aliasUserIds: f.aliasUserIds ?? [], photoUrl: f.photoUrl ?? null, projectId: null, position: f.position ?? "extra" });
  const notMerged = (u: any) => !String(u.loginMethod ?? "").startsWith("merged_into_");
  const store = {
    async usersByEmail(email: string) { return state.users.filter((u) => notMerged(u) && u.email && canon(u.email) === canon(email)).sort((a, b) => b.isActive - a.isActive || a.id - b.id).map(userRow); },
    async usersByIds(ids: number[]) { return state.users.filter((u) => notMerged(u) && ids.includes(u.id)).map(userRow); },
    async userById(id: number) { return userRow(state.users.find((u) => u.id === id)) ?? null; },
    async userByGoogleSub(sub: string) { return userRow(state.users.find((u) => u.googleSub === sub)) ?? null; },
    async userByOpenId(openId: string) { return userRow(state.users.find((u) => u.openId === openId)) ?? null; },
    async fichasByEmail(email: string) { return state.fichas.filter((f) => [f.email, f.personalEmail].some((x) => x && canon(x) === canon(email))).map(fichaRow); },
    async fichasOfUser(userId: number) { return state.fichas.filter((f) => f.userId === userId || (f.aliasUserIds ?? []).includes(userId)).map(fichaRow); },
    async isSharedMailbox(email: string) { return state.shared.has(email.trim().toLowerCase()); },
    async setGoogleSub(userId: number, sub: string) {
      const u = state.users.find((x) => x.id === userId);
      if (!u || u.googleSub || state.users.some((x) => x.googleSub === sub)) return false;
      u.googleSub = sub;
      return true;
    },
    async markSignedIn(userId: number, method: string, _now: number, opts?: { googleSub?: string }) {
      const u = state.users.find((x) => x.id === userId);
      if (!u) return;
      u.loginMethod = method;
      if (u.openId.startsWith("manual_")) u.openId = method === "google" && opts?.googleSub ? `google_${opts.googleSub}` : `email_${userId}x`;
    },
    async createEmailAccount({ email, name }: { email: string; name: string | null }) {
      const id = ++state.nextId;
      state.users.push({ id, openId: `email_${id}`, email, name, role: "user", isActive: 1, loginMethod: "email_code", sessionVersion: 0 });
      return id;
    },
    async insertCode(row: any) { const id = ++state.nextId; state.codes.push({ ...row, id, deliveredTo: [], attempts: 0, usedAt: null, usedByUserId: null }); return id; },
    async setCodeDelivery(id: number, to: number[]) { state.codes.find((c) => c.id === id).deliveredTo = to; },
    async deviceCodes(email: string, nonce: string, limit: number) { return state.codes.filter((c) => c.emailNorm === email && c.deviceNonceHash === nonce).sort((a, b) => b.id - a.id).slice(0, limit).map((c) => ({ ...c })); },
    async bumpCodeAttempts(ids: number[]) { for (const c of state.codes) if (ids.includes(c.id)) c.attempts++; },
    async useCode(id: number, userId: number | null, now: number) { const c = state.codes.find((x) => x.id === id); if (!c || c.usedAt != null) return false; c.usedAt = now; c.usedByUserId = userId; return true; },
    async setCodeUser(id: number, userId: number) { state.codes.find((c) => c.id === id).usedByUserId = userId; },
    async codeLoginSince(userId: number, since: number) { return state.codes.find((c) => c.usedByUserId === userId && c.usedAt != null && c.usedAt >= since) ?? null; },
    async codesDeliveredTo(userId: number, since: number) {
      return state.codes.filter((c) => c.deliveredTo.includes(userId) && c.createdAt >= since).map((c) => {
        const f = state.fichas.find((x) => x.id === c.employeeId);
        const n = state.notified.find((x) => x.kind === "login_code" && x.entity?.id === c.id);
        return { id: c.id, emailNorm: c.emailNorm, employeeId: c.employeeId, fullName: f?.fullName ?? null, photoUrl: f?.photoUrl ?? null, deviceLabel: c.deviceLabel, deviceNonceHash: c.deviceNonceHash, createdAt: c.createdAt, expiresAt: c.expiresAt, attempts: c.attempts, usedAt: c.usedAt, title: n?.title ?? null };
      });
    },
    async passwordState(userId: number) {
      const u = state.users.find((x) => x.id === userId);
      return u ? { hash: u.passwordHash ?? null, setAt: u.passwordSetAt ?? null, failedDay: u.failedDay ?? null, failedCount: u.failedCount ?? 0, lockedUntil: u.lockedUntil ?? null } : null;
    },
    async savePassword(userId: number, hash: string, now: number) { Object.assign(state.users.find((x) => x.id === userId), { passwordHash: hash, passwordSetAt: now, failedDay: null, failedCount: 0, lockedUntil: null }); },
    async recordPasswordFailure(userId: number, day: string, count: number, lockedUntil: number | null) { Object.assign(state.users.find((x) => x.id === userId), { failedDay: day, failedCount: count, lockedUntil }); },
    async clearPasswordFailures(userId: number) { Object.assign(state.users.find((x) => x.id === userId), { failedDay: null, failedCount: 0 }); },
    async clearPassword(userId: number) { Object.assign(state.users.find((x) => x.id === userId), { passwordHash: null, passwordSetAt: null, failedDay: null, failedCount: 0, lockedUntil: null }); },
    async dutyPools(city: string | null, shift: { date: string; shift: string }) {
      if (!city) return { scheduledTeamLeaders: [], supervisors: [], rhAdmins: state.rhAdmins };
      const tl = state.assignments.filter((a) => a.date === shift.date && a.shift === shift.shift && a.city === city && a.isTeamLeader)
        .flatMap((a) => { const f = state.fichas.find((x) => x.id === a.employeeId); return f?.userId ? [f.userId] : []; });
      const sups = state.users.filter((u) => u.role === "supervisor" && u.isActive === 1 && (u.cities ?? []).includes(city)).map((u) => ({ userId: u.id, clockOpen: !!u.clockOpen }));
      return { scheduledTeamLeaders: tl, supervisors: sups, rhAdmins: state.rhAdmins };
    },
    async cityOfFicha(id: number) { return state.fichas.find((f) => f.id === id)?.city ?? null; },
    async pdaByToken() { return null; },
    async peopleOf(ids: number[]) { return new Map(state.users.filter((u) => ids.includes(u.id)).map((u) => [u.id, { name: u.name, role: u.role }])); },
    async log(e: any) { state.logs.push(e); },
  };
  return { state, store, userRow, canon };
});

vi.mock("./loginStore", async (original) => ({ ...(await original<object>()), loginStore: () => m.store }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => m.state.fakeDb,
  getUserByOpenId: async (openId: string) => { const u = m.state.users.find((x) => x.openId === openId); return u ? { ...m.userRow(u) } : undefined; },
  getUserByEmail: async () => undefined,
  getUserById: async (id: number) => { const u = m.state.users.find((x) => x.id === id); return u ? { ...m.userRow(u) } : undefined; },
  upsertUser: async (u: any) => {
    const ex = m.state.users.find((x) => x.openId === u.openId);
    if (ex) Object.assign(ex, { name: u.name ?? ex.name, email: u.email ?? ex.email, loginMethod: u.loginMethod ?? ex.loginMethod });
    else m.state.users.push({ id: ++m.state.nextId, openId: u.openId, name: u.name ?? null, email: u.email ?? null, role: "user", isActive: 1, loginMethod: u.loginMethod ?? null, sessionVersion: 0 });
  },
  logActivity: async (e: any) => { m.state.logs.push(e); },
  getUserModuleOverrides: async () => ({}),
  getUserPermissionOverrides: async () => ({}),
  getEmployeeByUserId: async () => undefined,
  countActiveSuperAdmins: async () => 1,
}));
vi.mock("./identity", async (original) => ({
  ...(await original<object>()),
  adoptPlaceholderAccountByEmail: async () => null,
  linkEmployeesToUserByEmail: async () => [],
}));
vi.mock("./comebackStore", () => ({
  loadLoginFichas: async () => [],
  reactivateAccountAsUser: async () => undefined,
  convertSuspensionToInactive: async () => undefined,
  logComeback: async () => undefined,
}));
vi.mock("./notify", async (original) => ({
  ...(await original<object>()),
  notify: async (input: any) => { m.state.notified.push(input); return { recipients: [...(input.targetUserIds ?? [])], emailed: 0, duplicates: 0, city: null }; },
}));
vi.mock("./webPush", async (original) => ({
  ...(await original<object>()),
  pushToUsers: async (ids: number[], payload: any) => { m.state.pushed.push({ ids, payload }); return { sent: ids.length }; },
}));
vi.mock("./appSettings", async (original) => ({
  ...(await original<object>()),
  getSetting: async () => null,
  bumpSessionVersion: async (id: number) => { const u = m.state.users.find((x) => x.id === id); u.sessionVersion = (u.sessionVersion ?? 0) + 1; return u.sessionVersion; },
}));
vi.mock("./loginBlock", async (original) => ({ ...(await original<object>()), loginBlockFor: async () => null }));
vi.mock("./accountLink", async (original) => ({ ...(await original<object>()), linkCandidateFichaOnLogin: async () => null }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [49, 50], projectIds: [48, 49, 50], missingCostCenter: false }),
}));
vi.mock("./_core/sdk", () => ({
  sdk: {
    exchangeCodeForToken: vi.fn(async () => ({ access_token: "at" })),
    getUserInfo: vi.fn(async () => ({ ...m.state.google })),
    createSessionToken: vi.fn(async (openId: string, o: any) => `sess:${openId}:${o?.sessionVersion ?? 0}`),
    authenticateRequest: vi.fn(async () => null),
  },
}));

import { COOKIE_NAME, ACCESS_DENIED_MSG, AUTH_DENIED_PARAM } from "@shared/const";
import {
  CODE_EXPIRED_MSG, CODE_REQUESTED_MSG, LOGIN_NONCE_COOKIE, PASSWORD_LOCKED_MSG, PASSWORD_WRONG_MSG, ROLE_GOOGLE_MSG,
  codeFromLoginCodeTitle, entersWith, gmailCanonical, isPlaceholderAccount, passwordProblem, pickCodeRecipients,
} from "@shared/loginCode";
import { resetRateLimitMemoryForTests } from "./_core/ai/rateLimit";
import { registerOAuthRoutes } from "./_core/oauth";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { hashPassword } from "./loginCode";
import { sqlLoginStore } from "./loginStore";
import { MIGRATION_0620_STATEMENTS } from "./migrations/migration_0620";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { buildIdentityAudit, pickUser, planReconcile, type UserRow } from "./identityReconcile";
import { appRouter } from "./routers";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-A146) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
// 12 out 2026, 11:00 em Lisboa → turno da manhã de dia 12.
const T0 = new Date("2026-10-12T10:00:00Z").getTime();

/** Um aparelho: cookies próprios (sessão e app_login_nonce). */
function device(ua = ANDROID) {
  const jar = new Map<string, string>();
  const res = {
    cookie: (name: string, value: string) => { jar.set(name, value); },
    clearCookie: (name: string) => { jar.delete(name); },
  };
  const req = () => ({
    headers: { origin: "https://app.multipark.test", host: "app.multipark.test", "content-type": "application/json", "user-agent": ua, cookie: [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") },
    ip: "10.1.2.3", protocol: "https",
  });
  const caller = (user: any = null) => appRouter.createCaller({ user, req: req(), res, accessDenied: false } as any);
  return { jar, caller, session: () => jar.get(COOKIE_NAME) ?? null };
}

const lastCode = () => {
  const n = [...m.state.notified].reverse().find((x) => x.kind === "login_code");
  return n ? codeFromLoginCodeTitle(n.title) : null;
};
const userBy = (pred: (u: any) => boolean) => m.state.users.find(pred);
const asCtxUser = (u: any) => ({ ...m.userRow(u), name: u.name, email: u.email });

function addUser(u: Partial<any> & { id: number }) {
  const row = { openId: `google_${u.id}`, name: `Pessoa ${u.id}`, email: `p${u.id}@x.pt`, role: "extra", isActive: 1, loginMethod: "google", sessionVersion: 0, ...u };
  m.state.users.push(row);
  return row;
}

/** Cidade de Lisboa: TL escalado hoje de manhã (#21), supervisores (#22 com ponto, #23 sem), Porto (#24, #25). */
function lisbonTeam() {
  addUser({ id: 21, role: "team_leader", name: "Rui Tl" });
  m.state.fichas.push({ id: 11, fullName: "Rui Tl", email: "p21@x.pt", isActive: 1, userId: 21, position: "team_leader", city: "lisbon" });
  m.state.assignments.push({ date: "2026-10-12", shift: "morning", city: "lisbon", isTeamLeader: 1, employeeId: 11 });
  addUser({ id: 26, role: "team_leader", name: "Tiago Amanha" });
  m.state.fichas.push({ id: 16, fullName: "Tiago Amanha", email: "p26@x.pt", isActive: 1, userId: 26, position: "team_leader", city: "lisbon" });
  m.state.assignments.push({ date: "2026-10-13", shift: "morning", city: "lisbon", isTeamLeader: 1, employeeId: 16 });
  addUser({ id: 22, role: "supervisor", name: "Ana Sup", cities: ["lisbon"], clockOpen: true });
  addUser({ id: 23, role: "supervisor", name: "Bruno Sup", cities: ["lisbon"], clockOpen: false });
  addUser({ id: 24, role: "supervisor", name: "Carla Porto", cities: ["porto"], clockOpen: true });
  addUser({ id: 25, role: "team_leader", name: "Duarte Porto" });
  m.state.fichas.push({ id: 15, fullName: "Duarte Porto", email: "p25@x.pt", isActive: 1, userId: 25, position: "team_leader", city: "porto" });
  m.state.assignments.push({ date: "2026-10-12", shift: "morning", city: "porto", isTeamLeader: 1, employeeId: 15 });
  addUser({ id: 30, role: "backoffice", name: "Marta Rh" });
  m.state.rhAdmins = [30];
}

const ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "JWT_SECRET", "ENTRAR_COM_CODIGO"] as const;
const savedEnv: Record<string, string | undefined> = {};
let server: Server;
let base = "";

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.GOOGLE_CLIENT_ID = "cliente-teste";
  process.env.GOOGLE_CLIENT_SECRET = "segredo-cliente-teste";
  process.env.JWT_SECRET = "segredo-de-teste-com-tamanho-suficiente";
  const app = express();
  registerOAuthRoutes(app);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  process.env.ENTRAR_COM_CODIGO = "on";
  resetRateLimitMemoryForTests();
  Object.assign(m.state, { nextId: 100, users: [], fichas: [], codes: [], assignments: [], rhAdmins: [], logs: [], notified: [], pushed: [], fakeDb: null });
  m.state.shared = new Set();
});
afterEach(() => { vi.useRealTimers(); });

/** Login Google pelas rotas HTTP reais; devolve o cookie de sessão (ou null) e o destino. */
async function googleLogin(info: { sub: string; email: string; name?: string }): Promise<{ session: string | null; location: string | null }> {
  m.state.google = { sub: info.sub, email: info.email, name: info.name ?? "Pessoa Google", email_verified: true };
  const start = await fetch(`${base}/api/oauth/login`, { redirect: "manual" });
  const google = new URL(start.headers.get("location")!);
  const cookie = start.headers.getSetCookie().find((c) => c.startsWith("app_oauth_state="))!.split(";")[0];
  const res = await fetch(`${base}/api/oauth/callback?code=c&state=${encodeURIComponent(google.searchParams.get("state")!)}`, { redirect: "manual", headers: { cookie } });
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`));
  const session = set ? decodeURIComponent(set.split(";")[0].slice(COOKIE_NAME.length + 1)) : null;
  return { session: session && session.startsWith("sess:") ? session : null, location: res.headers.get("location") };
}

async function codeLogin(dev: ReturnType<typeof device>, email: string) {
  await dev.caller().auth.code.request({ email });
  const code = lastCode();
  expect(code).toMatch(/^\d{6}$/);
  return dev.caller().auth.code.verify({ email, code: code! });
}

describe("interruptor ENTRAR_COM_CODIGO desligado = tudo como hoje", () => {
  beforeEach(() => { delete process.env.ENTRAR_COM_CODIGO; });

  it("a página não mostra o email; código e palavra-passe recusados sem tocar em nada", async () => {
    const dev = device();
    expect(await dev.caller().auth.options()).toMatchObject({ codeLogin: false });
    await expect(dev.caller().auth.code.request({ email: "p40@x.pt" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(dev.caller().auth.code.verify({ email: "p40@x.pt", code: "123456" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(dev.caller().auth.password.login({ email: "p40@x.pt", password: "x".repeat(9) })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(dev.jar.has(LOGIN_NONCE_COOKIE)).toBe(false);
    expect(m.state.codes).toEqual([]);
    expect(m.state.notified).toEqual([]);
  });

  it("Google: quem já entra entra na mesma conta; email de uma conta de código NÃO é procurado (cria a google_ como sempre)", async () => {
    addUser({ id: 40, openId: "google_g40", googleSub: "g40", email: "rui@gmail.com", role: "extra" });
    const a = await googleLogin({ sub: "g40", email: "rui@gmail.com" });
    expect(a.session).toBe("sess:google_g40:0");
    expect(a.location).toBe("/");
    addUser({ id: 41, openId: "email_41", email: "ana@sapo.pt", loginMethod: "email_code", role: "user" });
    const b = await googleLogin({ sub: "g41", email: "ana@sapo.pt" });
    expect(b.session).toBe(`sess:google_g41:0`);
    expect(userBy((u) => u.openId === "google_g41")).toBeTruthy();
    expect(userBy((u) => u.id === 41).googleSub).toBeUndefined();
  });

  it("Perfil e cartão: sem palavra-passe nem códigos", async () => {
    const u = addUser({ id: 42, role: "extra" });
    const dev = device();
    expect(await dev.caller(asCtxUser(u)).auth.password.status()).toMatchObject({ enabled: false, hasPassword: false });
    expect(await dev.caller(asCtxUser(u)).auth.codes.pendingForMe()).toEqual([]);
  });
});

describe("conta única: Google e código caem na mesma conta", () => {
  it("Google → código: o código (Gmail com pontos/+) entra na conta Google", async () => {
    lisbonTeam();
    const g = await googleLogin({ sub: "g50", email: "rui.silva@gmail.com", name: "Rui Silva" });
    expect(g.session).toBe("sess:google_g50:0");
    const acc = userBy((u) => u.openId === "google_g50");
    expect(acc.googleSub).toBe("g50");
    acc.role = "extra";
    const dev = device();
    const r = await codeLogin(dev, "RuiSilva+pda@gmail.com");
    expect(r).toMatchObject({ ok: true, needsPassword: true });
    expect(dev.session()).toBe("sess:google_g50:0");
    expect(m.state.users.filter((u) => m.canon(u.email) === "ruisilva@gmail.com")).toHaveLength(1);
  });

  it("código → Google: a conta criada pelo código (ficha sem conta) recebe o googleSub e é a mesma nas duas", async () => {
    lisbonTeam();
    m.state.fichas.push({ id: 60, fullName: "Ana Extra", email: "ana@sapo.pt", isActive: 1, userId: null, position: "extra", city: "lisbon", photoUrl: "https://bucket/ana.jpg" });
    const dev = device();
    const r = await codeLogin(dev, "ana@sapo.pt");
    expect(r.needsPassword).toBe(true);
    const created = userBy((u) => u.email === "ana@sapo.pt");
    expect(created).toMatchObject({ role: "user", openId: expect.stringMatching(/^email_/), loginMethod: "email_code" });
    expect(dev.session()).toBe(`sess:${created.openId}:0`);

    const g = await googleLogin({ sub: "g60", email: "ana@sapo.pt", name: "Ana G" });
    expect(g.session).toBe(`sess:${created.openId}:0`);
    expect(created.googleSub).toBe("g60");
    expect(created.name).toBe("Ana Extra"); // o nome/email da conta não mudam
    expect(m.state.users.filter((u) => u.email === "ana@sapo.pt")).toHaveLength(1);
    // da próxima vez, pelo googleSub
    expect((await googleLogin({ sub: "g60", email: "ana@sapo.pt" })).session).toBe(`sess:${created.openId}:0`);
  });

  it("email já ligado a OUTRA Google → não junta: recusa e avisa os admins", async () => {
    addUser({ id: 70, openId: "google_g70", googleSub: "g70", email: "joao@gmail.com" });
    const g = await googleLogin({ sub: "g71", email: "joao@gmail.com" });
    expect(g.session).toBeNull();
    expect(g.location).toContain(`${AUTH_DENIED_PARAM}=`);
    expect(m.state.notified.some((n) => n.kind === "login_conflict")).toBe(true);
    expect(userBy((u) => u.openId === "google_g71")).toBeUndefined();
  });

  it("conta do backoffice por usar, achada pela ficha → a Google entra nela (passa a google_<sub>), sem criar outra", async () => {
    const u = addUser({ id: 85, openId: "manual_85", loginMethod: "manual", email: "trabalho@empresa.pt", role: "extra" });
    m.state.fichas.push({ id: 86, fullName: "Pessoal", email: "trabalho@empresa.pt", personalEmail: "pessoal@gmail.com", isActive: 1, userId: 85, city: "lisbon" });
    const g = await googleLogin({ sub: "g85", email: "pessoal@gmail.com" });
    expect(u).toMatchObject({ openId: "google_g85", googleSub: "g85", loginMethod: "google" });
    expect(g.session).toBe("sess:google_g85:0");
    expect(m.state.users).toHaveLength(1);
  });

  it("conta do backoffice por usar (manual_) → o código entra nela e ela deixa de ser 'por usar'", async () => {
    lisbonTeam();
    const u = addUser({ id: 80, openId: "manual_80", loginMethod: "manual", email: "nova@hotmail.com", role: "extra" });
    m.state.fichas.push({ id: 81, fullName: "Nova Extra", email: "nova@hotmail.com", isActive: 1, userId: 80, city: "lisbon" });
    const dev = device();
    await codeLogin(dev, "nova@hotmail.com");
    expect(u.openId).toMatch(/^email_/);
    expect(dev.session()).toBe(`sess:${u.openId}:0`);
    expect(isPlaceholderAccount({ openId: u.openId, loginMethod: u.loginMethod })).toBe(false);
  });
});

describe("portas: conta desativada", () => {
  it("o código certo de uma conta desativada não dá sessão (mesma mensagem de sempre)", async () => {
    lisbonTeam();
    addUser({ id: 90, email: "roubou@gmail.com", isActive: 0, deactivationReason: "roubou", role: "extra" });
    m.state.fichas.push({ id: 91, fullName: "Desativado", email: "roubou@gmail.com", isActive: 0, userId: 90, city: "lisbon" });
    const dev = device();
    await dev.caller().auth.code.request({ email: "roubou@gmail.com" });
    await expect(dev.caller().auth.code.verify({ email: "roubou@gmail.com", code: lastCode()! })).rejects.toMatchObject({ code: "FORBIDDEN", message: ACCESS_DENIED_MSG });
    expect(dev.session()).toBeNull();
    expect(m.state.logs.some((l) => l.action === "login_denied" && /conta desativada/.test(l.details))).toBe(true);
  });

  it("palavra-passe certa de uma conta desativada → recusado", async () => {
    addUser({ id: 92, email: "fora@gmail.com", isActive: 0, role: "extra", passwordHash: await hashPassword("Aviao!Verde77") });
    const dev = device();
    await expect(dev.caller().auth.password.login({ email: "fora@gmail.com", password: "Aviao!Verde77" })).rejects.toMatchObject({ code: "FORBIDDEN", message: ACCESS_DENIED_MSG });
    expect(dev.session()).toBeNull();
  });
});

describe("email desconhecido", () => {
  it("o pedido responde igual; o código vai ao RH/admins; a conta só nasce depois do código certo", async () => {
    lisbonTeam();
    const dev = device(IPHONE);
    const known = await device().caller().auth.code.request({ email: "p21@x.pt" }); // TL: não recebe código, resposta igual
    const r = await dev.caller().auth.code.request({ email: "desconhecido@hotmail.com" });
    expect(r).toEqual(known);
    expect(r.message).toBe(CODE_REQUESTED_MSG);
    expect(m.state.users.some((u) => u.email === "desconhecido@hotmail.com")).toBe(false);
    const n = m.state.notified.find((x) => x.kind === "login_code");
    expect(n.targetUserIds).toEqual([30]);
    expect(n.title).toContain("desconhecido@hotmail.com (iPhone · Safari)");
    const code = lastCode()!;
    const wrong = code === "000000" ? "111111" : "000000";
    await expect(dev.caller().auth.code.verify({ email: "desconhecido@hotmail.com", code: wrong })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(m.state.users.some((u) => u.email === "desconhecido@hotmail.com")).toBe(false);
    const ok = await dev.caller().auth.code.verify({ email: "desconhecido@hotmail.com", code });
    expect(ok).toMatchObject({ ok: true, needsPassword: true });
    const created = userBy((u) => u.email === "desconhecido@hotmail.com");
    expect(created).toMatchObject({ role: "user", isActive: 1 });
    expect(dev.session()).toBe(`sess:${created.openId}:0`);
    // o código só vale uma vez
    await expect(device(IPHONE).caller().auth.code.verify({ email: "desconhecido@hotmail.com", code })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("caixa partilhada da Comunicação (reservas@) → nada enviado, resposta igual", async () => {
    lisbonTeam();
    m.state.shared.add("reservas@multipark.pt");
    const r = await device().caller().auth.code.request({ email: "reservas@multipark.pt" });
    expect(r.message).toBe(CODE_REQUESTED_MSG);
    expect(m.state.notified).toEqual([]);
  });
});

describe("o código fica preso ao aparelho", () => {
  it("noutro aparelho não funciona; no próprio entra", async () => {
    lisbonTeam();
    addUser({ id: 100, email: "extra@gmail.com", role: "extra" });
    m.state.fichas.push({ id: 101, fullName: "Extra Um", email: "extra@gmail.com", isActive: 1, userId: 100, city: "lisbon" });
    const a = device();
    const b = device();
    await a.caller().auth.code.request({ email: "extra@gmail.com" });
    const code = lastCode()!;
    expect(a.jar.get(LOGIN_NONCE_COOKIE)).toBeTruthy();
    await expect(b.caller().auth.code.verify({ email: "extra@gmail.com", code })).rejects.toMatchObject({ message: CODE_EXPIRED_MSG });
    // B pede o seu: o de A continua a não servir em B
    vi.setSystemTime(T0 + 61_000);
    await b.caller().auth.code.request({ email: "extra@gmail.com" });
    await expect(b.caller().auth.code.verify({ email: "extra@gmail.com", code: code === lastCode() ? "999999" : code })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await a.caller().auth.code.verify({ email: "extra@gmail.com", code })).toMatchObject({ ok: true });
    expect(a.session()).toBe("sess:google_100:0");
    expect(b.session()).toBeNull();
  });

  it("valem os 3 últimos pedidos do aparelho; passados 10 min já não vale; 5 tentativas", async () => {
    lisbonTeam();
    addUser({ id: 110, email: "tres@gmail.com", role: "condutor" });
    const dev = device();
    const codes: string[] = [];
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(T0 + i * 61_000);
      await dev.caller().auth.code.request({ email: "tres@gmail.com" });
      codes.push(lastCode()!);
    }
    // o 1.º já não vale (há 3 mais recentes); o 2.º sim
    if (!codes.slice(1).includes(codes[0])) await expect(dev.caller().auth.code.verify({ email: "tres@gmail.com", code: codes[0] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    vi.setSystemTime(T0 + 3 * 61_000 + 11 * 60_000);
    await expect(dev.caller().auth.code.verify({ email: "tres@gmail.com", code: codes[3] })).rejects.toMatchObject({ message: CODE_EXPIRED_MSG });
    vi.setSystemTime(T0 + 20 * 60_000);
    await dev.caller().auth.code.request({ email: "tres@gmail.com" });
    const good = lastCode()!;
    const bad = good === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await expect(dev.caller().auth.code.verify({ email: "tres@gmail.com", code: bad })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(dev.caller().auth.code.verify({ email: "tres@gmail.com", code: good })).rejects.toMatchObject({ message: CODE_EXPIRED_MSG });
  });
});

describe("para quem vai o código", () => {
  it("TL escalado agora na cidade da ficha + supervisores com ponto aberto; depois o aviso diz a quem foi", async () => {
    lisbonTeam();
    addUser({ id: 120, email: "joaquim@gmail.com", role: "extra", name: "Joaquim Silva" });
    m.state.fichas.push({ id: 121, fullName: "Joaquim Silva", email: "joaquim@gmail.com", isActive: 1, userId: 120, city: "lisbon", photoUrl: "https://bucket/j.jpg" });
    const dev = device();
    await dev.caller().auth.code.request({ email: "joaquim@gmail.com" });
    const n = m.state.notified.find((x) => x.kind === "login_code");
    expect(n).toMatchObject({ kind: "login_code", city: "lisbon", targetUserIds: [21, 22], link: "/operacional?tab=live" });
    expect(n.title).toMatch(/^Código de entrada para Joaquim Silva \(Android · Chrome\): \d{3} \d{3}$/);
    expect(m.state.pushed[0]).toMatchObject({ ids: [21, 22], payload: { type: "login_code", url: "/operacional?tab=live" } });
    // o cartão "Códigos de entrada" do TL tem o pedido com o código; o do supervisor do Porto não
    const card = await device().caller(asCtxUser(userBy((u) => u.id === 21))).auth.codes.pendingForMe();
    expect(card).toEqual([expect.objectContaining({ name: "Joaquim Silva", photoUrl: "https://bucket/j.jpg", device: "Android · Chrome", code: lastCode(), status: "pending" })]);
    expect(await device().caller(asCtxUser(userBy((u) => u.id === 24))).auth.codes.pendingForMe()).toEqual([]);

    await dev.caller().auth.code.verify({ email: "joaquim@gmail.com", code: lastCode()! });
    const notice = m.state.notified.find((x) => x.kind === "login_security");
    expect(notice).toMatchObject({ targetUserIds: [120] });
    expect(notice.title).toBe("Entraste com um código enviado a TL Rui Tl / supervisor Ana Sup às 11:00.");
    const after = await device().caller(asCtxUser(userBy((u) => u.id === 21))).auth.codes.pendingForMe();
    expect(after[0]).toMatchObject({ status: "used", code: null });
  });

  it("nenhum supervisor com ponto aberto → todos os da cidade; sem cidade → RH/admins", async () => {
    lisbonTeam();
    userBy((u) => u.id === 22).clockOpen = false;
    addUser({ id: 130, email: "c@gmail.com", role: "extra" });
    m.state.fichas.push({ id: 131, fullName: "C", email: "c@gmail.com", isActive: 1, userId: 130, city: "lisbon" });
    addUser({ id: 132, email: "semcidade@gmail.com", role: "user" });
    await device().caller().auth.code.request({ email: "c@gmail.com" });
    await device().caller().auth.code.request({ email: "semcidade@gmail.com" });
    const sent = m.state.notified.filter((x) => x.kind === "login_code");
    expect(sent[0].targetUserIds).toEqual([21, 22, 23]);
    expect(sent[1].targetUserIds).toEqual([30]);
  });

  it("regra pura: nunca a própria pessoa; ninguém na cidade → RH", () => {
    const pools = { scheduledTeamLeaders: [5], supervisors: [{ userId: 6, clockOpen: false }, { userId: 7, clockOpen: true }], rhAdmins: [9] };
    expect(pickCodeRecipients("lisbon", pools)).toEqual({ userIds: [5, 7], via: "duty" });
    expect(pickCodeRecipients("lisbon", pools, [5])).toEqual({ userIds: [7], via: "duty" });
    expect(pickCodeRecipients("porto", { scheduledTeamLeaders: [], supervisors: [], rhAdmins: [9] })).toEqual({ userIds: [9], via: "rh" });
    expect(pickCodeRecipients(null, pools)).toEqual({ userIds: [9], via: "rh" });
  });
});

describe("palavra-passe", () => {
  it("TL e acima: recusada (\"Com o teu papel entra-se com Google\") e o código nem é enviado", async () => {
    lisbonTeam();
    const tl = userBy((u) => u.id === 21);
    tl.passwordHash = await hashPassword("Girafa#Azul42");
    const dev = device();
    await expect(dev.caller().auth.password.login({ email: "p21@x.pt", password: "Girafa#Azul42" })).rejects.toMatchObject({ code: "FORBIDDEN", message: ROLE_GOOGLE_MSG });
    expect(dev.session()).toBeNull();
    await expect(dev.caller(asCtxUser(tl)).auth.password.set({ password: "Outra!Coisa99" })).rejects.toMatchObject({ code: "FORBIDDEN", message: ROLE_GOOGLE_MSG });
    await dev.caller().auth.code.request({ email: "p21@x.pt" });
    expect(m.state.notified.filter((x) => x.kind === "login_code")).toEqual([]);
    expect(m.state.logs.some((l) => /entra com Google/.test(l.details))).toBe(true);
  });

  it("criar depois do código, entrar com ela; regras (fácil, nome, data)", async () => {
    lisbonTeam();
    const u = addUser({ id: 140, email: "maria.santos@gmail.com", name: "Maria Santos", role: "extra" });
    const dev = device();
    await codeLogin(dev, "maria.santos@gmail.com");
    const me = dev.caller(asCtxUser(u));
    for (const bad of ["12345678", "maria2026!", "pass01011990", "curta"]) {
      await expect(me.auth.password.set({ password: bad })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await me.auth.password.set({ password: "Cavalo!Azul33" })).toMatchObject({ ok: true, mode: "first" });
    expect(u.passwordHash).toMatch(/^scrypt\$/);
    const other = device(IPHONE);
    expect(await other.caller().auth.password.login({ email: "mariasantos@gmail.com", password: "Cavalo!Azul33" })).toMatchObject({ ok: true });
    expect(other.session()).toBe("sess:google_140:0");
    expect(u.loginMethod).toBe("password");
    // mudar pede a atual (passados 15 min do código) e termina as outras sessões
    vi.setSystemTime(T0 + 20 * 60_000);
    await expect(me.auth.password.set({ password: "Tigre!Verde55" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await me.auth.password.change({ current: "Cavalo!Azul33", password: "Tigre!Verde55" })).toMatchObject({ ok: true, mode: "change" });
    expect(u.sessionVersion).toBe(1);
    expect(dev.session()).toBe("sess:google_140:1");
  });

  it("bloqueio à 5.ª errada no dia: só com código até ao fim do dia e o dono é avisado", async () => {
    lisbonTeam();
    const u = addUser({ id: 150, email: "bloq@gmail.com", name: "Bloq", role: "condutor", passwordHash: await hashPassword("Leao!Branco21") });
    const dev = device();
    for (let i = 1; i <= 5; i++) {
      await expect(dev.caller().auth.password.login({ email: "bloq@gmail.com", password: `errada${i}xx` })).rejects.toMatchObject({ message: PASSWORD_WRONG_MSG });
    }
    expect(u.failedCount).toBe(5);
    expect(u.lockedUntil).toBeGreaterThan(Date.now());
    const warn = m.state.notified.find((x) => x.kind === "login_security");
    expect(warn).toMatchObject({ targetUserIds: [150] });
    expect(warn.title).toMatch(/^Tentaram entrar na tua conta \(Android · Chrome\) às 11:00$/);
    await expect(dev.caller().auth.password.login({ email: "bloq@gmail.com", password: "Leao!Branco21" })).rejects.toMatchObject({ message: PASSWORD_LOCKED_MSG });
    expect(dev.session()).toBeNull();
    // com código entra na mesma
    expect(await codeLogin(dev, "bloq@gmail.com")).toMatchObject({ ok: true, needsPassword: false });
    // no dia seguinte a palavra-passe volta
    vi.setSystemTime(T0 + 24 * 3_600_000);
    expect(await device().caller().auth.password.login({ email: "bloq@gmail.com", password: "Leao!Branco21" })).toMatchObject({ ok: true });
    expect(u.failedCount).toBe(0);
    // sem conta: a mesma mensagem
    await expect(dev.caller().auth.password.login({ email: "ninguem@gmail.com", password: "Leao!Branco21" })).rejects.toMatchObject({ message: PASSWORD_WRONG_MSG });
  });
});

describe("Repor acesso", () => {
  it("tira a palavra-passe, sobe a versão da sessão, avisa a pessoa e fica no registo", async () => {
    const admin = addUser({ id: 160, role: "admin", name: "Admin" });
    const u = addUser({ id: 161, email: "repor@gmail.com", name: "Repor", role: "extra", passwordHash: await hashPassword("Gato!Preto88"), lockedUntil: T0 + 3_600_000, failedCount: 5, failedDay: "2026-10-12" });
    const r = await device().caller(asCtxUser(admin)).users.resetAccess({ userId: 161 });
    expect(r).toEqual({ success: true });
    expect(u).toMatchObject({ passwordHash: null, lockedUntil: null, failedCount: 0, sessionVersion: 1 });
    expect(m.state.notified.find((x) => x.kind === "login_security")).toMatchObject({ targetUserIds: [161], title: "O teu acesso foi reposto" });
    expect(m.state.logs.some((l) => l.action === "access_reset" && l.entityId === 161 && l.userId === 160)).toBe(true);
    await expect(device().caller().auth.password.login({ email: "repor@gmail.com", password: "Gato!Preto88" })).rejects.toMatchObject({ message: PASSWORD_WRONG_MSG });
    // a própria conta não; um extra não repõe ninguém
    await expect(device().caller(asCtxUser(admin)).users.resetAccess({ userId: 160 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(device().caller(asCtxUser(u)).users.resetAccess({ userId: 160 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("regras puras", () => {
  it("Gmail com pontos e + é o mesmo email; outros domínios não", () => {
    expect(gmailCanonical("Rui.Silva+pda@GoogleMail.com")).toBe("ruisilva@gmail.com");
    expect(gmailCanonical("rui.silva@sapo.pt")).toBe("rui.silva@sapo.pt");
  });
  it("palavras-passe proibidas", () => {
    expect(passwordProblem("1234567")).toMatch(/pelo menos 8/);
    expect(passwordProblem("qwerty123")).toMatch(/fácil/);
    expect(passwordProblem("abababab")).toMatch(/fácil/);
    expect(passwordProblem("Joana!2026x", { name: "Joana Faria" })).toMatch(/nome/);
    expect(passwordProblem("x25121990!")).toMatch(/data/);
    expect(passwordProblem("Cavalo!Azul33", { name: "Maria Santos", email: "maria@gmail.com" })).toBeNull();
  });
  it("'Entra com' e contas por usar", () => {
    expect(entersWith({ openId: "google_1", googleSub: "1", hasPassword: true, loginMethod: "password" })).toEqual(["google", "password", "code"]);
    expect(entersWith({ openId: "manual_1", loginMethod: "manual" })).toEqual([]);
    expect(isPlaceholderAccount({ openId: "manual_1", loginMethod: "manual" })).toBe(true);
    expect(isPlaceholderAccount({ openId: "email_1", loginMethod: "email_code" })).toBe(false);
    expect(isPlaceholderAccount({ openId: "manual_1", loginMethod: "manual", hasPassword: true })).toBe(false);
    expect(isPlaceholderAccount({ openId: "manual_1", loginMethod: "merged_into_3" })).toBe(false);
  });
});

describe("SQL da loja (server/loginStore.ts) e migração 0620", () => {
  const dialect = new MySqlDialect();
  let queries: Array<{ sql: string; params: unknown[] }> = [];
  beforeEach(() => {
    queries = [];
    m.state.fakeDb = { execute: async (q: any) => { queries.push(dialect.sqlToQuery(q)); return [Object.assign([], { affectedRows: 1, insertId: 7 })]; } };
  });

  it("procura por email: minúsculas, sem contas fundidas; Gmail também sem pontos/+", async () => {
    await sqlLoginStore.usersByEmail("Rui.Silva@gmail.com");
    await sqlLoginStore.usersByEmail("ana@sapo.pt");
    expect(queries[0].sql).toContain("LEFT(loginMethod, 12) <> 'merged_into_'");
    expect(queries[0].sql).toContain("REPLACE(SUBSTRING_INDEX(SUBSTRING_INDEX(LOWER(TRIM(email)), '@', 1), '+', 1), '.', '')");
    expect(queries[0].params).toEqual(expect.arrayContaining(["rui.silva@gmail.com", "ruisilva"]));
    expect(queries[1].sql).not.toContain("REPLACE(");
    expect(queries[0].sql).toContain("(passwordHash IS NOT NULL) AS hasPassword");
  });

  it("googleSub só onde falta; código gasto uma vez; manual_ passa a email_ (não com a Google)", async () => {
    await sqlLoginStore.setGoogleSub(5, "sub-5");
    await sqlLoginStore.useCode(9, 5, T0);
    await sqlLoginStore.markSignedIn(5, "email_code", T0);
    expect(queries[0].sql).toMatch(/UPDATE users SET googleSub = \? WHERE id = \? AND googleSub IS NULL/);
    expect(queries[1].sql).toMatch(/WHERE id = \? AND usedAt IS NULL/);
    expect(queries[2].sql).toContain("IF(LEFT(openId, 7) = 'manual_', ?, openId)");
    expect(queries[2].params[1]).toBe("email_code");
    expect(String(queries[2].params[2])).toMatch(/^email_[0-9a-f]{24}$/);
    await sqlLoginStore.markSignedIn(5, "google", T0, { googleSub: "sub-5" });
    expect(queries[3].params[2]).toBe("google_sub-5");
  });

  it("nada se apaga (nem na loja nem na migração); a palavra-passe só em hash", async () => {
    await sqlLoginStore.clearPassword(5);
    await sqlLoginStore.savePassword(5, "scrypt$hash", T0);
    await sqlLoginStore.insertCode({ emailNorm: "a@b.pt", userId: null, employeeId: null, codeHash: "h".repeat(64), deviceNonceHash: "n".repeat(64), deviceLabel: "Android", pdaId: null, cityKey: null, deliveryMode: "duty", expiresAt: T0 + 600_000, ipHash: "i", createdAt: T0 });
    expect(queries.some((q) => /^\s*DELETE/i.test(q.sql))).toBe(false);
    expect(queries[2].sql).not.toMatch(/\bcode\b\s*,/);
    for (const st of MIGRATION_0620_STATEMENTS) expect(st).not.toMatch(/\b(DELETE|DROP|TRUNCATE)\b/i);
    expect(MIGRATION_0620_STATEMENTS.join("\n")).toContain("ADD UNIQUE INDEX `users_googleSub_unique` (`googleSub`)");
    expect(SCHEMA_MIGRATION_IDS).toContain("0620");
    expect(MIGRATION_0620_STATEMENTS.find((x) => x.startsWith("UPDATE"))).toContain("u.`googleSub` IS NULL AND LEFT(u.`openId`, 7) = 'google_'");
  });
});

describe("reconciliador conhece as contas de código e a palavra-passe", () => {
  const u = (p: Partial<UserRow> & { id: number }): UserRow => ({ openId: `manual_${p.id}`, name: `U ${p.id}`, email: "dup@x.pt", role: "extra", isActive: 1, loginMethod: "manual", lastSignedIn: null, ...p });
  const plan = (users: UserRow[]) => { const s = { users, employees: [], agents: [] }; return planReconcile(s, buildIdentityAudit(s)); };

  it("fica a conta que já entrou (código ou palavra-passe) em vez da do backoffice", () => {
    expect(pickUser([u({ id: 1 }), u({ id: 2, openId: "email_ab", loginMethod: "email_code" })])!.id).toBe(2);
    expect(pickUser([u({ id: 1 }), u({ id: 3, hasPassword: true })])!.id).toBe(3);
    expect(plan([u({ id: 1 }), u({ id: 2, openId: "email_ab", loginMethod: "email_code" })]).mergeUsers).toEqual([{ email: "dup@x.pt", keepUserId: 2, removeUserIds: [1] }]);
  });

  it("duas ativas com entrada própria (Google + código) ou as duas com googleSub → não junta sozinho", () => {
    const a = plan([u({ id: 1, openId: "google_1", googleSub: "1", loginMethod: "google" }), u({ id: 2, openId: "email_ab", loginMethod: "email_code" })]);
    expect(a.mergeUsers).toEqual([]);
    expect(a.skipped[0].reason).toContain("entrada própria");
    const b = plan([u({ id: 1, openId: "google_1", googleSub: "1", loginMethod: "google" }), u({ id: 2, openId: "google_2", googleSub: "2", isActive: 0, loginMethod: "google" })]);
    expect(b.mergeUsers).toEqual([]);
    expect(b.skipped[0].reason).toContain("ligadas a uma Google");
  });
});
