/**
 * Plano 56 (A2): PDAs — sessão de PDA, sem Google, sem guardar, QR só TL+,
 * push do PDA e o código por email (preparado). Pelas rotas reais (tRPC
 * `auth.*`, `rh.timeRecords.checkOut`, `operational.pdas.registerByQr`,
 * `settings.flags.set`) e pelo autenticador REAL dos cookies
 * (`sdk.authenticateRequest`, JWT assinado). A BD é em memória
 * (server/loginStore.ts e server/pdaSessionStore.ts trocados); o sino, o
 * envio de email e o serviço de push são falsos.
 */
import type { gmail_v1 } from "@googleapis/gmail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  // O ENV do servidor lê-se ao importar: o segredo e a app têm de existir já.
  process.env.JWT_SECRET = "segredo-de-teste-pdas-com-tamanho-suficiente";
  process.env.VITE_APP_ID = "app-teste";
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
    mailboxes: new Set<string>(),
    logs: [] as any[],
    notified: [] as any[],
    pdas: [] as any[],
    push: [] as any[],
    attaches: [] as any[],
    released: [] as any[],
    closedCheckins: [] as any[],
    timeRecords: new Map<number, any[]>(),
    inserted: [] as any[],
    settings: {} as Record<string, unknown>,
    sentMail: [] as any[],
    sendResult: { ok: true } as any,
    webpushSent: [] as any[],
    fakeDb: null as any,
  };
  const userRow = (u: any) => u && ({
    id: u.id, openId: u.openId, email: u.email ?? null, name: u.name ?? null, role: u.role, isActive: u.isActive,
    loginMethod: u.loginMethod ?? null, googleSub: u.googleSub ?? null, hasPassword: !!u.passwordHash,
    deactivationReason: u.deactivationReason ?? null, sessionVersion: u.sessionVersion ?? 0,
  });
  const fichaRow = (f: any) => ({ id: f.id, fullName: f.fullName, isActive: f.isActive, userId: f.userId ?? null, aliasUserIds: f.aliasUserIds ?? [], photoUrl: null, projectId: null, position: f.position ?? "extra" });
  const notMerged = (u: any) => !String(u.loginMethod ?? "").startsWith("merged_into_");
  const pdaOf = (id: number) => state.pdas.find((p) => p.id === id);
  const store = {
    async usersByEmail(email: string) { return state.users.filter((u) => notMerged(u) && u.email && canon(u.email) === canon(email)).map(userRow); },
    async usersByIds(ids: number[]) { return state.users.filter((u) => notMerged(u) && ids.includes(u.id)).map(userRow); },
    async userById(id: number) { return userRow(state.users.find((u) => u.id === id)) ?? null; },
    async userByGoogleSub(sub: string) { return userRow(state.users.find((u) => u.googleSub === sub)) ?? null; },
    async userByOpenId(openId: string) { return userRow(state.users.find((u) => u.openId === openId)) ?? null; },
    async fichasByEmail(email: string) { return state.fichas.filter((f) => [f.email, f.personalEmail].some((x) => x && canon(x) === canon(email))).map(fichaRow); },
    async fichasOfUser(userId: number) { return state.fichas.filter((f) => f.userId === userId || (f.aliasUserIds ?? []).includes(userId)).map(fichaRow); },
    async isSharedMailbox(email: string) { return state.shared.has(email.trim().toLowerCase()); },
    async isMailboxAddress(email: string) { return state.mailboxes.has(email.trim().toLowerCase()); },
    async setGoogleSub() { return false; },
    async markSignedIn(userId: number, method: string) { const u = state.users.find((x) => x.id === userId); if (u) u.loginMethod = method; },
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
    async codeLoginSince() { return null; },
    async codesDeliveredTo() { return []; },
    async passwordState(userId: number) {
      const u = state.users.find((x) => x.id === userId);
      return u ? { hash: u.passwordHash ?? null, setAt: null, failedDay: null, failedCount: 0, lockedUntil: null } : null;
    },
    async savePassword() { /* */ },
    async recordPasswordFailure() { /* */ },
    async clearPasswordFailures() { /* */ },
    async clearPassword() { /* */ },
    async dutyPools(city: string | null, shift: { date: string; shift: string }) {
      if (!city) return { scheduledTeamLeaders: [], supervisors: [], rhAdmins: state.rhAdmins };
      const tl = state.assignments.filter((a) => a.date === shift.date && a.shift === shift.shift && a.city === city && a.isTeamLeader)
        .flatMap((a) => { const f = state.fichas.find((x) => x.id === a.employeeId); return f?.userId ? [f.userId] : []; });
      const sups = state.users.filter((u) => u.role === "supervisor" && u.isActive === 1 && (u.cities ?? []).includes(city)).map((u) => ({ userId: u.id, clockOpen: !!u.clockOpen }));
      return { scheduledTeamLeaders: tl, supervisors: sups, rhAdmins: state.rhAdmins };
    },
    async cityOfFicha(id: number) { return state.fichas.find((f) => f.id === id)?.city ?? null; },
    async pdaByToken(token: string) {
      const p = state.pdas.find((x) => x.deviceToken && x.deviceToken === token && x.status === "active");
      return p ? { id: p.id, name: p.name, city: p.city } : null;
    },
    async peopleOf(ids: number[]) { return new Map(state.users.filter((u) => ids.includes(u.id)).map((u) => [u.id, { name: u.name, role: u.role }])); },
    async log(e: any) { state.logs.push(e); },
  };
  const pdaStore = {
    async start(pdaId: number, userId: number, nonce: string, now: number) {
      const p = pdaOf(pdaId);
      if (!p || p.status !== "active") return false;
      Object.assign(p, { sessionUserId: userId, sessionNonce: nonce, sessionStartedAt: now });
      return true;
    },
    async read(pdaId: number) { const p = pdaOf(pdaId); return p ? { userId: p.sessionUserId ?? null, nonce: p.status === "active" ? p.sessionNonce ?? null : null, startedAt: p.sessionStartedAt ?? null } : null; },
    async clearIf(pdaId: number, nonce: string) { const p = pdaOf(pdaId); if (!p || p.sessionNonce !== nonce) return false; p.sessionNonce = null; return true; },
    async openSessionsOf(ids: number[]) { return state.pdas.filter((p) => p.sessionNonce && ids.includes(p.sessionUserId)).map((p) => ({ pdaId: p.id, nonce: p.sessionNonce, userId: p.sessionUserId })); },
    async accountsOfEmployee(employeeId: number) { const f = state.fichas.find((x) => x.id === employeeId); return f ? [f.userId, ...(f.aliasUserIds ?? [])].filter(Boolean) : []; },
    async movePush(pdaId: number, userId: number, nonce: string) {
      const p = pdaOf(pdaId);
      if (!p || p.sessionNonce !== nonce || p.sessionUserId !== userId) return;
      for (const s of state.push) if (s.pdaId === pdaId) Object.assign(s, { userId, disabledAt: null });
    },
    async disablePush(pdaId: number, now: number) {
      if (pdaOf(pdaId)?.sessionNonce) return;
      for (const s of state.push) if (s.pdaId === pdaId && !s.disabledAt) s.disabledAt = new Date(now).toISOString().slice(0, 19).replace("T", " ");
    },
    async pdaName(pdaId: number) { return pdaOf(pdaId)?.name ?? null; },
    async registration(pdaId: number) { const p = pdaOf(pdaId); return p ? { deviceToken: p.deviceToken ?? null, projectId: p.projectId ?? null, name: p.name } : null; },
    async releaseCheckin(pdaId: number, employeeId: number) { state.released.push({ pdaId, employeeId }); return 1; },
  };
  return { state, store, pdaStore, userRow, canon };
});

vi.mock("./loginStore", async (original) => ({ ...(await original<object>()), loginStore: () => m.store }));
vi.mock("./pdaSessionStore", async (original) => ({ ...(await original<object>()), pdaSessionStore: () => m.pdaStore }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => m.state.fakeDb,
  getUserByOpenId: async (openId: string) => { const u = m.state.users.find((x) => x.openId === openId); return u ? { ...m.userRow(u), lastSignedIn: new Date().toISOString() } : undefined; },
  getUserByEmail: async () => undefined,
  getUserById: async (id: number) => { const u = m.state.users.find((x) => x.id === id); return u ? { ...m.userRow(u) } : undefined; },
  upsertUser: async () => undefined,
  logActivity: async (e: any) => { m.state.logs.push(e); },
  getUserModuleOverrides: async () => ({}),
  getUserPermissionOverrides: async () => ({}),
  countActiveSuperAdmins: async () => 1,
  getEmployeeByUserId: async (userId: number) => {
    const f = m.state.fichas.find((x) => x.userId === userId || (x.aliasUserIds ?? []).includes(userId));
    return f ? { employee: { id: f.id, fullName: f.fullName, position: f.position ?? "extra", isActive: f.isActive, multiparkAgentName: "agente", photoUrl: null, loginBlocked: 0 }, project: null } : undefined;
  },
  attachPdaByDeviceToken: async (token: string, employeeId: number) => {
    const p = m.state.pdas.find((x) => x.deviceToken === token);
    m.state.attaches.push({ token, employeeId });
    return p ? { pdaId: p.id, pdaName: p.name, zelloUsername: null, replacedName: null, changed: true } : null;
  },
  verifyPdaQrCode: async (pdaId: number, code: string) => { const p = m.state.pdas.find((x) => x.id === pdaId && x.qrCode === code && x.status === "active"); return p ? { name: p.name } : null; },
  setPdaDeviceToken: async (pdaId: number) => { const p = m.state.pdas.find((x) => x.id === pdaId); const t = `tok${++m.state.nextId}`.padEnd(32, "x"); p.deviceToken = t; return t; },
  getTimeRecords: async (employeeId: number) => m.state.timeRecords.get(employeeId) ?? [],
  checkGeofenceNote: async () => null,
  resolveZelloUsernameForShift: async () => null,
  closePdaCheckinsForEmployee: async (employeeId: number) => { m.state.closedCheckins.push(employeeId); return 1; },
}));
vi.mock("./rhService", async (original) => ({
  ...(await original<object>()),
  insertTimeRecordAtomic: async (employeeId: number, type: string, data: any) => { m.state.inserted.push({ employeeId, type, data }); return { id: ++m.state.nextId }; },
}));
vi.mock("./pontoTerminal", async (original) => ({ ...(await original<object>()), pontoTerminalEnabled: async () => false }));
vi.mock("./terminalSessions", async (original) => ({ ...(await original<object>()), realTerminalDeps: async () => { throw new Error("sem BD"); } }));
vi.mock("./pdaZelloName", () => ({ syncPdaZelloName: async () => "skip", syncPdaZelloNameByToken: async () => undefined, syncPdaZelloNamesForEmployee: async () => undefined }));
vi.mock("./identity", async (original) => ({ ...(await original<object>()), adoptPlaceholderAccountByEmail: async () => null, linkEmployeesToUserByEmail: async () => [] }));
vi.mock("./comebackStore", () => ({ loadLoginFichas: async () => [], reactivateAccountAsUser: async () => undefined, convertSuspensionToInactive: async () => undefined, logComeback: async () => undefined }));
vi.mock("./notify", async (original) => ({
  ...(await original<object>()),
  notify: async (input: any) => { m.state.notified.push(input); return { recipients: [...(input.targetUserIds ?? [])], emailed: 0, duplicates: 0, city: null }; },
}));
vi.mock("./appSettings", async (original) => ({
  ...(await original<object>()),
  getSetting: async (key: string) => m.state.settings[key] ?? null,
  setSetting: async (_key: string, value: unknown) => ({ changed: true, value }),
  bumpSessionVersion: async (id: number) => { const u = m.state.users.find((x) => x.id === id); u.sessionVersion = (u.sessionVersion ?? 0) + 1; return u.sessionVersion; },
}));
vi.mock("./loginBlock", async (original) => ({ ...(await original<object>()), loginBlockFor: async () => null }));
vi.mock("./accountLink", async (original) => ({ ...(await original<object>()), linkCandidateFichaOnLogin: async () => null }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [49, 50], projectIds: [48, 49, 50], missingCostCenter: false }),
}));
vi.mock("./mail/systemMail", async (original) => ({
  ...(await original<object>()),
  sendEmailDetailed: async (o: any) => { m.state.sentMail.push(o); return m.state.sendResult; },
}));
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: () => undefined,
    sendNotification: async (sub: any, body: string) => { m.state.webpushSent.push({ endpoint: sub.endpoint, body: JSON.parse(body) }); return {}; },
  },
}));

import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { COOKIE_NAME } from "@shared/const";
import {
  CODE_EMAILED_MSG, CODE_EMAIL_FAILED_MSG, CODE_REQUESTED_MSG, LOGIN_CODE_SENDER, ROLE_GOOGLE_MSG, STAFF_CODE_ON_REGISTERED_PDA,
  codeFromLoginCodeTitle, codeRecipientsForRole, methodAllowedForRole,
} from "@shared/loginCode";
import {
  GOOGLE_PDAS_NEEDS_CODE_MSG, PDA_SESSION_MS, QR_TL_ONLY_MSG, checkoutSummaryLines, googleShownOnDevice, pdaSessionOk, sessionEndsInText,
} from "@shared/pdaSession";
import { payloadForSubscription, pickPushDeliveries } from "@shared/webPush";
import { AUTOMATION_FLAGS, automationFlagDefault } from "@shared/appSettings";
import { kindDef } from "@shared/notificationRouting";
import { LOGIN_MAIL_HEADER } from "@shared/mail";
import { resetRateLimitMemoryForTests } from "./_core/ai/rateLimit";
import { sdk } from "./_core/sdk";
import { endPdaSessionsOfEmployee, pdaSessionTag } from "./pdaSession";
import { sendLoginCodeEmailWith } from "./loginMail";
import { sendMailWith } from "./mail/systemMail";
import { syncAccount, type GmailApiLike, type SyncStore } from "./mail/sync";
import { parseGmailMessage } from "./mail/parse";
import { pushToUsers } from "./webPush";
import { MIGRATION_0635_STATEMENTS } from "./migrations/migration_0635";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { appRouter } from "./routers";

const ANDROID = "Mozilla/5.0 (Linux; Android 13; PDA) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
// 12 out 2026, 11:00 em Lisboa → turno da manhã.
const T0 = new Date("2026-10-12T10:00:00Z").getTime();
const TOKEN7 = "a".repeat(32);
const TOKEN8 = "b".repeat(32);
const QR7 = "q".repeat(32);

/** Um aparelho: os seus cookies (sessão e app_login_nonce). */
function device(ua = ANDROID) {
  const jar = new Map<string, string>();
  const res = {
    cookie: (name: string, value: string) => { jar.set(name, value); },
    clearCookie: (name: string) => { jar.delete(name); },
  };
  const req = () => ({
    headers: { origin: "https://app.multipark.test", host: "app.multipark.test", "content-type": "application/json", "user-agent": ua, cookie: [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") },
    ip: "10.9.8.7", protocol: "https",
  });
  /** O contexto como o servidor o monta: o utilizador vem do cookie (autenticador real). */
  const caller = async () => {
    const r = req();
    let user: any = null;
    try { user = await sdk.authenticateRequest(r as any); } catch { user = null; }
    return appRouter.createCaller({ user, req: r, res, accessDenied: false } as any);
  };
  const valid = async () => sdk.authenticateRequest(req() as any).then(() => true, () => false);
  return { jar, res, req, caller, valid, session: () => jar.get(COOKIE_NAME) ?? null };
}

/** Sessão "de hoje" (Google, sem PDA), como as que já existem. */
async function googleSession(dev: ReturnType<typeof device>, u: any) {
  dev.jar.set(COOKIE_NAME, await sdk.createSessionToken(u.openId, { name: u.name ?? "Pessoa", sessionVersion: u.sessionVersion ?? 0, expiresInMs: 30 * 86_400_000 }));
}

const lastCode = () => {
  const n = [...m.state.notified].reverse().find((x) => x.kind === "login_code");
  return n ? codeFromLoginCodeTitle(n.title) : null;
};
const userBy = (id: number) => m.state.users.find((u) => u.id === id);
const pda7 = () => m.state.pdas.find((p) => p.id === 7);

function addUser(u: Partial<any> & { id: number }) {
  const row = { openId: `google_${u.id}`, name: `Pessoa ${u.id}`, email: `p${u.id}@x.pt`, role: "extra", isActive: 1, loginMethod: "google", sessionVersion: 0, ...u };
  m.state.users.push(row);
  return row;
}

/** Lisboa: TL escalado hoje (#21), supervisores (#22 com ponto, #23), RH #30, um TL de folga (#26), extras #100 e #110, PDA 12 (#7) e PDA 13 (#8). */
function lisbon() {
  addUser({ id: 21, role: "team_leader", name: "Rui Tl" });
  m.state.fichas.push({ id: 11, fullName: "Rui Tl", email: "p21@x.pt", isActive: 1, userId: 21, position: "team_leader", city: "lisbon" });
  m.state.assignments.push({ date: "2026-10-12", shift: "morning", city: "lisbon", isTeamLeader: 1, employeeId: 11 });
  addUser({ id: 22, role: "supervisor", name: "Ana Sup", cities: ["lisbon"], clockOpen: true });
  addUser({ id: 23, role: "supervisor", name: "Bruno Sup", cities: ["lisbon"], clockOpen: false });
  addUser({ id: 26, role: "team_leader", name: "Tiago Folga" });
  m.state.fichas.push({ id: 16, fullName: "Tiago Folga", email: "p26@x.pt", isActive: 1, userId: 26, position: "team_leader", city: "lisbon" });
  addUser({ id: 30, role: "backoffice", name: "Marta Rh" });
  m.state.rhAdmins = [30];
  addUser({ id: 100, role: "extra", name: "Joaquim Extra", email: "joaquim@gmail.com" });
  m.state.fichas.push({ id: 101, fullName: "Joaquim Extra", email: "joaquim@gmail.com", isActive: 1, userId: 100, aliasUserIds: [105], city: "lisbon" });
  addUser({ id: 105, role: "extra", name: "Joaquim (conta pessoal)", email: "joaquim.pessoal@sapo.pt", openId: "google_105" });
  addUser({ id: 110, role: "condutor", name: "Carla Condutora", email: "carla@gmail.com" });
  m.state.fichas.push({ id: 111, fullName: "Carla Condutora", email: "carla@gmail.com", isActive: 1, userId: 110, city: "lisbon" });
  m.state.pdas.push({ id: 7, name: "PDA 12", deviceToken: TOKEN7, qrCode: QR7, status: "active", projectId: 49, city: "lisbon" });
  m.state.pdas.push({ id: 8, name: "PDA 13", deviceToken: TOKEN8, qrCode: "r".repeat(32), status: "active", projectId: 49, city: "lisbon" });
}

/** Entrar com código num aparelho (com o token do PDA, se for um). */
async function codeLogin(dev: ReturnType<typeof device>, email: string, pdaToken: string | null = TOKEN7) {
  await (await dev.caller()).auth.code.request({ email, pdaToken });
  const code = lastCode();
  expect(code).toMatch(/^\d{6}$/);
  return (await dev.caller()).auth.code.verify({ email, code: code!, pdaToken });
}

const ENV_KEYS = ["ENTRAR_COM_CODIGO", "GOOGLE_NOS_PDAS", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_SUBJECT;
  delete process.env.GOOGLE_NOS_PDAS;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  process.env.ENTRAR_COM_CODIGO = "on";
  resetRateLimitMemoryForTests();
  Object.assign(m.state, {
    nextId: 1000, users: [], fichas: [], codes: [], assignments: [], rhAdmins: [], logs: [], notified: [], pdas: [], push: [], attaches: [], released: [],
    closedCheckins: [], timeRecords: new Map(), inserted: [], settings: {}, sentMail: [], sendResult: { ok: true }, webpushSent: [], fakeDb: null,
  });
  m.state.shared = new Set();
  m.state.mailboxes = new Set();
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("interruptores por omissão (ENTRAR_COM_CODIGO desligado, GOOGLE_NOS_PDAS ligado) = nada muda", () => {
  beforeEach(() => { delete process.env.ENTRAR_COM_CODIGO; });

  it("a página: Google em todo o lado, o PDA não é 'registado' para a entrada, nada de código", async () => {
    lisbon();
    const dev = device();
    expect(await (await dev.caller()).auth.options()).toMatchObject({ codeLogin: false, googleOnPdas: true });
    expect(await (await dev.caller()).auth.pda.device({ deviceToken: TOKEN7 })).toEqual({ registered: false, name: null, google: true });
    expect(automationFlagDefault("GOOGLE_NOS_PDAS")).toBe(true);
    expect(automationFlagDefault("ENTRAR_COM_CODIGO")).toBe(false);
  });

  it("as sessões que já existem num PDA não caem: nem com o bind, nem com o QR, nem com a saída do ponto", async () => {
    lisbon();
    const dev = device();
    const extra = userBy(100);
    await googleSession(dev, extra);
    const before = dev.session();
    expect(await dev.valid()).toBe(true);
    // o cliente pede o bind ao abrir: desligado não faz nada
    expect(await (await dev.caller()).auth.pda.bind({ deviceToken: TOKEN7 })).toEqual({ bound: false, reason: "off" });
    expect(dev.session()).toBe(before);
    expect(pda7().sessionNonce).toBeUndefined();
    // QR: como hoje (um extra ainda regista), sem mexer no cookie nem avisar ninguém
    const qr = await (await dev.caller()).operational.pdas.registerByQr({ pdaId: 7, code: QR7, currentToken: TOKEN7 });
    expect(qr.pdaSession).toBe(false);
    expect(qr.token).not.toBe(TOKEN7); // como sempre: o QR dá um token novo
    expect(dev.session()).toBe(before);
    expect(m.state.notified).toEqual([]);
    // saída do ponto: o resumo como sempre e a sessão continua
    m.state.timeRecords.set(101, [{ type: "check_in", recordedAt: "2026-10-12 06:00:00", terminalStatus: null }]);
    const out = await (await dev.caller()).rh.timeRecords.checkOut({ employeeId: 101 });
    expect(out).toMatchObject({ success: true, hoursWorked: "4.00", pdaSessionEnded: false });
    expect(await dev.valid()).toBe(true);
    // logout como sempre (limpa o cookie)
    expect(await (await dev.caller()).auth.logout()).toEqual({ success: true });
    expect(dev.session()).toBeNull();
  });

  it("um cookie de antes desta mudança (sem PDA) continua válido; os avisos normais não mudam", async () => {
    lisbon();
    const dev = device();
    await googleSession(dev, userBy(21));
    expect(await dev.valid()).toBe(true);
    const claims = await sdk.verifySession(dev.session());
    expect(claims).toMatchObject({ pda: null, pn: null, sv: 0 });
    const n = { type: "login_code", title: "Código de entrada para Joaquim: 123 456", body: "x", url: "/operacional?tab=live", tag: "t" };
    expect(payloadForSubscription({ pdaId: null }, n)).toBe(n);
  });

  it("não se desliga o Google nos PDAs sem a entrada com código", async () => {
    addUser({ id: 1, role: "super_admin", name: "Jorge" });
    const dev = device();
    await googleSession(dev, userBy(1));
    await expect((await dev.caller()).settings.flags.set({ name: "GOOGLE_NOS_PDAS", value: false })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: GOOGLE_PDAS_NEEDS_CODE_MSG });
    expect(await (await dev.caller()).settings.flags.set({ name: "GOOGLE_NOS_PDAS", value: true })).toMatchObject({ changed: true });
    process.env.ENTRAR_COM_CODIGO = "on";
    expect(await (await dev.caller()).settings.flags.set({ name: "GOOGLE_NOS_PDAS", value: false })).toMatchObject({ changed: true, value: false });
  });
});

describe("sessão de PDA: entra presa ao PDA e acaba quando deve", () => {
  it("código no PDA → sessão do PDA (nonce em pdas e no cookie), o PDA fica com a ficha", async () => {
    lisbon();
    const dev = device();
    const r = await codeLogin(dev, "joaquim@gmail.com");
    expect(r).toMatchObject({ ok: true, pdaSession: true });
    const claims = await sdk.verifySession(dev.session());
    expect(claims).toMatchObject({ pda: 7, pn: pda7().sessionNonce });
    expect(pda7().sessionUserId).toBe(100);
    expect((claims!.exp! * 1000) - T0).toBeLessThanOrEqual(PDA_SESSION_MS);
    expect(m.state.attaches).toEqual([{ token: TOKEN7, employeeId: 101 }]);
    expect(await dev.valid()).toBe(true);
    const me = await (await dev.caller()).auth.me();
    expect((me as any).pdaSession).toMatchObject({ pdaId: 7, name: "PDA 12", tag: pdaSessionTag(pda7().sessionNonce) });
  });

  it("acaba na saída do ponto (o resumo vem na própria resposta) — e da saída feita noutro aparelho", async () => {
    lisbon();
    const pda = device();
    await codeLogin(pda, "joaquim@gmail.com");
    m.state.timeRecords.set(101, [{ type: "check_in", recordedAt: "2026-10-12 02:00:00", terminalStatus: null }]);
    const out = await (await pda.caller()).rh.timeRecords.checkOut({ employeeId: 101 });
    expect(out).toMatchObject({ success: true, hoursWorked: "8.00", pdaSessionEnded: true });
    expect(checkoutSummaryLines(out as any)[0]).toBe("Saída registada: 8 h de trabalho.");
    expect(await pda.valid()).toBe(false);
    expect(pda7().sessionNonce).toBeNull();

    // Outra vez no PDA, e a saída é dada no telemóvel (conta pessoal, employee_accounts)
    await codeLogin(pda, "joaquim@gmail.com");
    expect(await pda.valid()).toBe(true);
    const phone = device();
    await googleSession(phone, userBy(105));
    const out2 = await (await phone.caller()).rh.timeRecords.checkOut({ employeeId: 101 });
    expect(out2).toMatchObject({ success: true, pdaSessionEnded: false });
    expect(await pda.valid()).toBe(false);
    expect(await phone.valid()).toBe(true);
  });

  it("acaba quando outra pessoa entra no PDA (e a do outro PDA não é tocada)", async () => {
    lisbon();
    const a = device();
    await codeLogin(a, "joaquim@gmail.com");
    const other = device();
    await codeLogin(other, "joaquim@gmail.com", TOKEN8); // a mesma pessoa noutro PDA
    const b = device();
    await codeLogin(b, "carla@gmail.com");
    expect(pda7().sessionUserId).toBe(110);
    expect(await a.valid()).toBe(false);
    expect(await b.valid()).toBe(true);
    expect(await other.valid()).toBe(true);
  });

  it("acaba no logout (avisos do PDA desligados, PDA solto) e ao fim de 16 h", async () => {
    lisbon();
    const dev = device();
    await codeLogin(dev, "joaquim@gmail.com");
    const copy = dev.session()!;
    const me = await (await dev.caller()).auth.me() as any;
    expect(await (await dev.caller()).auth.logout({ expect: { userId: 100, tag: me.pdaSession.tag } })).toEqual({ success: true });
    expect(dev.session()).toBeNull();
    expect(pda7().sessionNonce).toBeNull();
    expect(m.state.released).toEqual([{ pdaId: 7, employeeId: 101 }]);
    const stolen = device();
    stolen.jar.set(COOKIE_NAME, copy);
    expect(await stolen.valid()).toBe(false);

    const later = device();
    await codeLogin(later, "carla@gmail.com");
    vi.setSystemTime(T0 + PDA_SESSION_MS - 60_000);
    expect(await later.valid()).toBe(true);
    vi.setSystemTime(T0 + PDA_SESSION_MS + 60_000);
    expect(await later.valid()).toBe(false);
    // a regra pura também (o nonce em pdas manda, mesmo com um cookie mais longo)
    const row = { userId: 1, nonce: "n".repeat(32), startedAt: T0 };
    expect(pdaSessionOk(row, { userId: 1, nonce: "n".repeat(32) }, T0 + PDA_SESSION_MS - 1)).toBe(true);
    expect(pdaSessionOk(row, { userId: 1, nonce: "n".repeat(32) }, T0 + PDA_SESSION_MS)).toBe(false);
    expect(pdaSessionOk(row, { userId: 2, nonce: "n".repeat(32) }, T0)).toBe(false);
    expect(pdaSessionOk({ ...row, nonce: null }, { userId: 1, nonce: "n".repeat(32) }, T0)).toBe(false);
  });

  it("acaba no fecho automático do ponto esquecido (que também solta o PDA, só com o interruptor)", async () => {
    lisbon();
    const dev = device();
    await codeLogin(dev, "joaquim@gmail.com");
    const ended = await endPdaSessionsOfEmployee(101, "stale_checkout");
    expect(ended).toEqual([{ pdaId: 7, nonce: expect.any(String) }]);
    expect(await dev.valid()).toBe(false);
    expect(m.state.logs.some((l) => l.action === "pda_session_end" && /fecho automático/.test(l.details))).toBe(true);
    const d = readFileSync("server/db.ts", "utf8");
    const fn = d.slice(d.indexOf("export async function autoCloseStaleCheckIns"), d.indexOf("// ─── PASSAGEM DE TURNO"));
    expect(fn).toContain('endPdaSessionsOfEmployee(Number(r.employeeId), "stale_checkout")');
    expect(fn).toMatch(/pdaOn && \(await closePdaCheckinsForEmployee\(Number\(r\.employeeId\), outAt\)\)/);
    expect(fn).not.toMatch(/delete\(/i);
  });

  it("PDA retirado (perdido/inativo) → a sessão nele deixa de valer", async () => {
    lisbon();
    const dev = device();
    await codeLogin(dev, "joaquim@gmail.com");
    expect(await dev.valid()).toBe(true);
    pda7().status = "lost";
    expect(await dev.valid()).toBe(false);
    const src = readFileSync("server/pdaSessionStore.ts", "utf8");
    expect(src).toContain('nonce: active ? r.sessionNonce ?? null : null');
  });

  it("funciona sem ficha (conta 'utilizador' / candidato)", async () => {
    lisbon();
    addUser({ id: 140, role: "user", name: "Nova Candidata", email: "nova@hotmail.com" });
    const dev = device();
    expect(await codeLogin(dev, "nova@hotmail.com")).toMatchObject({ ok: true, pdaSession: true });
    expect(pda7().sessionUserId).toBe(140);
    expect(m.state.attaches).toEqual([]); // sem ficha, nada para ligar ao PDA
    expect(await dev.valid()).toBe(true);
    // email desconhecido: a conta nasce depois do código e a sessão também é do PDA
    const dev2 = device();
    expect(await codeLogin(dev2, "desconhecido@sapo.pt")).toMatchObject({ ok: true, pdaSession: true });
    expect(await dev.valid()).toBe(false);
    expect(await dev2.valid()).toBe(true);
    expect((await (await dev2.caller()).auth.logout()).success).toBe(true);
    expect(await dev2.valid()).toBe(false);
  });

  it("um separador antigo não mata a sessão nova (mesmo browser e cookie antigo)", async () => {
    lisbon();
    const dev = device();
    await codeLogin(dev, "joaquim@gmail.com");
    const oldCookie = dev.session()!;
    const tagA = ((await (await dev.caller()).auth.me()) as any).pdaSession.tag;
    // outra pessoa entra no mesmo PDA (o cookie do browser passa a ser o dela)
    await codeLogin(dev, "carla@gmail.com");
    expect(await dev.valid()).toBe(true);
    // o separador antigo carrega em "Sair" (ou acaba os 10 s): o cookie já é da Carla → não mexe
    expect(await (await dev.caller()).auth.logout({ expect: { userId: 100, tag: tagA } })).toEqual({ success: true, stale: true });
    expect(await dev.valid()).toBe(true);
    // e um pedido com o cookie velho do Joaquim também não acaba a da Carla
    const stale = device();
    stale.jar.set(COOKIE_NAME, oldCookie);
    await (await stale.caller()).auth.logout();
    expect(await dev.valid()).toBe(true);
    expect(pda7().sessionUserId).toBe(110);
  });

  it("mudar a palavra-passe / terminar as outras sessões num PDA mantém a sessão presa ao PDA", async () => {
    lisbon();
    const dev = device();
    await codeLogin(dev, "joaquim@gmail.com");
    await (await dev.caller()).settings.security.endMySessions();
    const claims = await sdk.verifySession(dev.session());
    expect(claims).toMatchObject({ pda: 7, pn: pda7().sessionNonce, sv: 1 });
    expect(claims!.exp! * 1000).toBeLessThanOrEqual(T0 + PDA_SESSION_MS);
    expect(await dev.valid()).toBe(true);
  });
});

describe("login Google num PDA → bind (nunca logout)", () => {
  it("a sessão Google sem PDA num aparelho com deviceToken passa a sessão de PDA; quem lá estava sai", async () => {
    lisbon();
    const before = device();
    await codeLogin(before, "carla@gmail.com");
    const dev = device();
    await googleSession(dev, userBy(100));
    expect(await dev.valid()).toBe(true);
    const r = await (await dev.caller()).auth.pda.bind({ deviceToken: TOKEN7 });
    expect(r).toEqual({ bound: true, pdaName: "PDA 12" });
    expect(await sdk.verifySession(dev.session())).toMatchObject({ pda: 7 });
    expect(await dev.valid()).toBe(true);
    expect(await before.valid()).toBe(false);
    expect(m.state.attaches.at(-1)).toEqual({ token: TOKEN7, employeeId: 101 });
    // outra vez: já está
    expect(await (await dev.caller()).auth.pda.bind({ deviceToken: TOKEN7 })).toEqual({ bound: true, already: true, pdaName: "PDA 12" });
    // token de um aparelho que já não é PDA: não faz nada (e não termina a sessão)
    const loose = device();
    await googleSession(loose, userBy(110));
    expect(await (await loose.caller()).auth.pda.bind({ deviceToken: "z".repeat(32) })).toEqual({ bound: false, reason: "unknown_device" });
    expect(await loose.valid()).toBe(true);
  });
});

describe("funcionários com código só num PDA registado (sem palavra-passe)", () => {
  it("TL: fora do PDA não recebe código; no PDA sim, e só entra no PDA onde o pediu", async () => {
    lisbon();
    expect(STAFF_CODE_ON_REGISTERED_PDA).toBe(true);
    expect(methodAllowedForRole("code", "team_leader")).toBe(false);
    expect(methodAllowedForRole("code", "team_leader", { registeredPda: true })).toBe(true);
    expect(methodAllowedForRole("password", "team_leader", { registeredPda: true })).toBe(false);
    const phone = device();
    await (await phone.caller()).auth.code.request({ email: "p26@x.pt" });
    expect(m.state.notified.filter((n) => n.kind === "login_code")).toEqual([]);
    // token falso → como fora do PDA
    await (await phone.caller()).auth.code.request({ email: "p26@x.pt", pdaToken: "f".repeat(32) });
    expect(m.state.notified.filter((n) => n.kind === "login_code")).toEqual([]);

    const pda = device();
    vi.setSystemTime(T0 + 61_000);
    await (await pda.caller()).auth.code.request({ email: "p26@x.pt", pdaToken: TOKEN7 });
    const n = m.state.notified.find((x) => x.kind === "login_code");
    expect(n.targetUserIds).toEqual([21, 22]);
    expect(n.title).toContain("Tiago Folga (PDA 12)");
    const code = lastCode()!;
    // no mesmo aparelho mas sem o token do PDA → recusado (papel)
    await expect((await pda.caller()).auth.code.verify({ email: "p26@x.pt", code, pdaToken: null })).rejects.toMatchObject({ code: "FORBIDDEN", message: ROLE_GOOGLE_MSG });
    expect(pda.session()).toBeNull();
    // pede outro e entra no PDA
    vi.setSystemTime(T0 + 130_000);
    await (await pda.caller()).auth.code.request({ email: "p26@x.pt", pdaToken: TOKEN7 });
    expect(await (await pda.caller()).auth.code.verify({ email: "p26@x.pt", code: lastCode()!, pdaToken: TOKEN7 })).toMatchObject({ ok: true, needsPassword: false, pdaSession: true });
    expect(pda7().sessionUserId).toBe(26);
    expect(await pda.valid()).toBe(true);
  });

  it("o código de um funcionário só vai a quem está ao mesmo nível ou acima (o TL nunca recebe o de um supervisor)", async () => {
    lisbon();
    await (await device().caller()).auth.code.request({ email: "p23@x.pt", pdaToken: TOKEN7 });
    expect(m.state.notified.filter((n) => n.kind === "login_code").map((n) => n.targetUserIds)).toEqual([[22]]);
    // admin num PDA: ninguém de serviço ao nível dele, nem no RH → não se envia
    addUser({ id: 40, role: "admin", name: "Admin Cidade", email: "admin@x.pt" });
    await (await device().caller()).auth.code.request({ email: "admin@x.pt", pdaToken: TOKEN7 });
    expect(m.state.notified.filter((n) => n.kind === "login_code")).toHaveLength(1);
    expect(m.state.logs.some((l) => /ninguém de serviço/.test(l.details))).toBe(true);
    expect(codeRecipientsForRole("extra", [21, 22], new Map([[21, "team_leader"], [22, "supervisor"]]))).toEqual([21, 22]);
    expect(codeRecipientsForRole("supervisor", [21, 22, 30], new Map([[21, "team_leader"], [22, "supervisor"], [30, "backoffice"]]))).toEqual([22, 30]);
  });

  it("código pedido num PDA não serve para entrar como funcionário noutro PDA", async () => {
    lisbon();
    const dev = device();
    await (await dev.caller()).auth.code.request({ email: "p26@x.pt", pdaToken: TOKEN7 });
    await expect((await dev.caller()).auth.code.verify({ email: "p26@x.pt", code: lastCode()!, pdaToken: TOKEN8 })).rejects.toMatchObject({ code: "FORBIDDEN", message: ROLE_GOOGLE_MSG });
    expect(dev.session()).toBeNull();
  });
});

describe("QR do PDA (operational.pdas.registerByQr)", () => {
  it("só TL e acima; o cookie passa a sessão do PDA; o supervisor é avisado quando o PDA muda de aparelho", async () => {
    lisbon();
    const extraDev = device();
    await googleSession(extraDev, userBy(100));
    await expect((await extraDev.caller()).operational.pdas.registerByQr({ pdaId: 7, code: QR7 })).rejects.toMatchObject({ code: "FORBIDDEN", message: QR_TL_ONLY_MSG });
    expect(pda7().deviceToken).toBe(TOKEN7);

    const tl = device();
    await googleSession(tl, userBy(21));
    const r = await (await tl.caller()).operational.pdas.registerByQr({ pdaId: 7, code: QR7, currentToken: null });
    expect(r).toMatchObject({ name: "PDA 12", pdaSession: true });
    expect(r.token).not.toBe(TOKEN7);
    expect(await sdk.verifySession(tl.session())).toMatchObject({ pda: 7, pn: pda7().sessionNonce });
    expect(pda7().sessionUserId).toBe(21);
    const n = m.state.notified.find((x) => x.kind === "pda_device");
    expect(n).toMatchObject({ kind: "pda_device", projectId: 49, title: "O PDA 12 mudou de aparelho" });
    expect(n.recipientFilter({ id: 21 })).toBe(false);
    expect(n.recipientFilter({ id: 22 })).toBe(true);
    expect(kindDef("pda_device")).toMatchObject({ module: "pdas", roles: ["supervisor"], cityScoped: true, personal: false });

    // o QR lido outra vez no MESMO aparelho: o token fica e ninguém é avisado
    const again = await (await tl.caller()).operational.pdas.registerByQr({ pdaId: 7, code: QR7, currentToken: r.token });
    expect(again.token).toBe(r.token);
    expect(m.state.notified.filter((x) => x.kind === "pda_device")).toHaveLength(1);
  });

  it("a lista dos PDAs nunca leva o token do aparelho nem o nonce da sessão", () => {
    const src = readFileSync("server/operationalRouter.ts", "utf8");
    expect(src).toContain("return ((await listPdas()) as any[]).map(publicPdaRow);");
    expect(src).toContain("return pda ? publicPdaRow(pda) : pda;");
    expect(src).toMatch(/const \{ deviceToken, qrCode: _qr, sessionNonce: _n, \.\.\.rest \} = p;/);
  });
});

describe("push nos PDAs: muda de dono e desliga-se", () => {
  beforeEach(() => {
    process.env.VAPID_PUBLIC_KEY = "BPub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    process.env.VAPID_SUBJECT = "mailto:dev@multipark.pt";
    const dialect = new MySqlDialect();
    m.state.fakeDb = {
      // (os limites de pedidos também usam a BD: aqui contam sempre 1)
      execute: async () => [[]],
      select: () => ({ from: () => ({ where: (cond: any) => {
        const ids = dialect.sqlToQuery(cond).params;
        const rows = m.state.push.filter((s) => ids.includes(s.userId));
        return Object.assign(Promise.resolve(rows), { limit: async () => rows });
      } }) }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      delete: () => ({ where: async () => undefined }),
      insert: () => ({ values: (v: any) => ({ onDuplicateKeyUpdate: async ({ set }: any) => {
        const row = m.state.push.find((s) => s.endpointHash === v.endpointHash);
        if (row) Object.assign(row, set);
        else m.state.push.push({ id: ++m.state.nextId, ...v, pdaId: v.pdaId ?? null, disabledAt: null });
      } }) }),
    };
  });

  it("subscrição feita no PDA fica do PDA; a pessoa seguinte fica com ela; sessão acabada → desligada; texto genérico", async () => {
    lisbon();
    const dev = device();
    await codeLogin(dev, "joaquim@gmail.com");
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/pda12", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } };
    await (await dev.caller()).notifications.pushSubscribe(sub);
    expect(m.state.push).toEqual([expect.objectContaining({ userId: 100, pdaId: 7, disabledAt: null })]);

    await codeLogin(dev, "carla@gmail.com");
    expect(m.state.push[0]).toMatchObject({ userId: 110, pdaId: 7, disabledAt: null });
    m.state.webpushSent = [];
    await pushToUsers([110], { type: "login_code", title: "Código de entrada para Joaquim Silva (PDA 12): 482 913", body: "Joaquim Silva: 482 913", url: "/operacional?tab=live", tag: "login-code-1" });
    expect(m.state.webpushSent).toEqual([{ endpoint: sub.endpoint, body: { type: "pda", title: "Multipark", body: "Tens um aviso", url: "/", tag: "pda-login-code-1" } }]);

    await (await dev.caller()).auth.logout();
    expect(m.state.push[0].disabledAt).toBeTruthy();
    m.state.webpushSent = [];
    expect(await pushToUsers([110], { type: "x", title: "t", body: "b", url: "/", tag: "t" })).toEqual({ sent: 0 });
    expect(m.state.webpushSent).toEqual([]);
    expect(pickPushDeliveries([{ id: 1, userId: 110, disabledAt: "2026-10-12 10:00:00" }], new Set([110]))).toEqual([]);
    // volta a entrar no PDA → volta a receber
    await codeLogin(dev, "carla@gmail.com");
    expect(m.state.push[0].disabledAt).toBeNull();
  });

  it("subscrição fora do PDA continua normal (texto completo)", async () => {
    lisbon();
    const phone = device();
    await googleSession(phone, userBy(21));
    await (await phone.caller()).notifications.pushSubscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/tl", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } });
    expect(m.state.push[0]).toMatchObject({ userId: 21, pdaId: null });
    await pushToUsers([21], { type: "login_code", title: "Código de entrada para X: 123 456", body: "X: 123 456", url: "/operacional?tab=live", tag: "login-code-2" });
    expect(m.state.webpushSent[0].body).toMatchObject({ type: "login_code", body: "X: 123 456" });
  });
});

describe("código por email pela acesso@ (definição login.codeDelivery = 'email')", () => {
  beforeEach(() => { m.state.settings["login.codeDelivery"] = "email"; });

  it("sai da conta própria acesso@ com X-Multipark-Login, sem link; o TL não recebe nada; o aviso diz 'o teu email'", async () => {
    lisbon();
    const dev = device();
    const r = await (await dev.caller()).auth.code.request({ email: "joaquim@gmail.com", pdaToken: TOKEN7 });
    expect(r.message).toBe(CODE_EMAILED_MSG);
    expect(m.state.notified.filter((n) => n.kind === "login_code")).toEqual([]);
    expect(m.state.sentMail).toHaveLength(1);
    const mail = m.state.sentMail[0];
    expect(mail).toMatchObject({ to: "joaquim@gmail.com", account: LOGIN_CODE_SENDER, kind: "system", headers: { [LOGIN_MAIL_HEADER]: "1" } });
    expect(mail.text).toContain("Escreve-o no aparelho onde pediste");
    expect(mail.text).not.toMatch(/https?:\/\//);
    const code = /é (\d{3}) (\d{3})\./.exec(mail.text)!.slice(1).join("");
    expect(m.state.codes[0]).toMatchObject({ deliveryMode: "email", pdaId: 7 });
    expect(await (await dev.caller()).auth.code.verify({ email: "joaquim@gmail.com", code, pdaToken: TOKEN7 })).toMatchObject({ ok: true, pdaSession: true });
    const notice = m.state.notified.find((x) => x.kind === "login_security");
    expect(notice.title).toBe("Entraste com um código enviado para o teu email às 11:00.");
  });

  it("remetente que é uma caixa da Comunicação → recusa enviar e cai no TL/supervisor (\"pede o código ao TL\")", async () => {
    lisbon();
    m.state.mailboxes.add(LOGIN_CODE_SENDER);
    const dev = device();
    const r = await (await dev.caller()).auth.code.request({ email: "joaquim@gmail.com" });
    expect(r.message).toBe(CODE_EMAIL_FAILED_MSG);
    expect(m.state.sentMail).toEqual([]);
    expect(m.state.notified.find((n) => n.kind === "login_code").targetUserIds).toEqual([21, 22]);
    expect(m.state.codes[0].deliveryMode).toBe("duty");
    expect(m.state.logs.some((l) => /o email não saiu/.test(l.details) && /caixa da Comunicação/.test(l.details))).toBe(true);
    // o envio a falhar dá o mesmo
    m.state.mailboxes.clear();
    m.state.sendResult = { ok: false, error: "Delegation denied" };
    vi.setSystemTime(T0 + 61_000);
    expect((await (await dev.caller()).auth.code.request({ email: "joaquim@gmail.com" })).message).toBe(CODE_EMAIL_FAILED_MSG);
    expect(m.state.notified.filter((n) => n.kind === "login_code")).toHaveLength(2);
    // por omissão (duty) a mensagem de sempre
    m.state.settings = {};
    vi.setSystemTime(T0 + 122_000);
    expect((await (await dev.caller()).auth.code.request({ email: "joaquim@gmail.com" })).message).toBe(CODE_REQUESTED_MSG);
  });

  it("o envio: conta própria (delegação), cabeçalho de login; sem confirmar a caixa → não envia", async () => {
    const calls: string[] = [];
    let raw = "";
    const deps = {
      systemSender: async () => "reservas@multipark.pt",
      mailboxes: async () => [],
      apiFor: async (k: string) => { calls.push(k); return { listSendAs: async () => [], sendRaw: async (b: Buffer) => { raw = b.toString("utf8"); return { id: "g1", threadId: "t1" }; } }; },
      dwdAvailable: () => true,
    };
    const r = await sendLoginCodeEmailWith({ isMailbox: async () => false, send: (o) => sendMailWith(deps as any, o) }, { to: "pessoa@gmail.com", code: "482913" });
    expect(r).toEqual({ ok: true });
    expect(calls).toEqual(["dwd:acesso@multipark.pt"]);
    expect(raw).toMatch(/^X-Multipark-Login: 1/m);
    expect(raw).toMatch(/^X-Multipark-System: 1/m);
    expect(raw).toMatch(/^From: .*acesso@multipark\.pt/m);
    expect(await sendLoginCodeEmailWith({ isMailbox: async () => { throw new Error("BD"); }, send: async () => ({ ok: true }) }, { to: "x@y.pt", code: "1" })).toMatchObject({ ok: false, refused: "mailbox" });
  });

  it("a sincronização do Gmail salta o email do código (nunca fica guardado)", async () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    const msg = (id: string, headers: Array<{ name: string; value: string }>): gmail_v1.Schema$Message => ({
      id, threadId: id, labelIds: ["INBOX"], snippet: "", internalDate: String(T0),
      payload: { mimeType: "text/plain", body: { data: b64("O teu código de entrada é 482 913.") }, headers: [
        { name: "From", value: "Multipark <acesso@multipark.pt>" }, { name: "To", value: "rui@multipark.pt" }, { name: "Subject", value: "Código de entrada Multipark: 482 913" }, ...headers,
      ] },
    });
    expect(parseGmailMessage(msg("m1", [{ name: LOGIN_MAIL_HEADER, value: "1" }])).loginMail).toBe(true);
    const messages: Record<string, gmail_v1.Schema$Message> = { m1: msg("m1", [{ name: LOGIN_MAIL_HEADER, value: "1" }]), m2: msg("m2", []) };
    const api: GmailApiLike = {
      async getProfile() { return { emailAddress: "rui@multipark.pt", historyId: "9" }; },
      async listMessages() { return { ids: Object.keys(messages), nextPageToken: null }; },
      async listHistory({ startHistoryId }) { return { history: [], historyId: startHistoryId, nextPageToken: null }; },
      async getMessage(id) { return messages[id] ?? null; },
    };
    const stored: string[] = [];
    const st: Record<string, any> = {};
    const store: SyncStore = {
      async getState(k) { return st[k] ?? { historyId: null, backfillStartHistoryId: null, backfillPageToken: null, backfillDoneAt: null, backfillDays: null }; },
      async saveState(k, p) { st[k] = { ...(await store.getState(k)), ...p }; },
      async knownMessageIds() { return new Set(); },
      async storeMessage(_k, p) { stored.push(p.gmailMessageId); return { stored: true, threadId: 1, messageId: 1, newThread: true, reopened: false }; },
      async setRead() { /* */ },
    };
    await syncAccount(api, store, { key: "user:21", email: "rui@multipark.pt", ownerUserId: 21, mailboxes: [] }, { deadlineAt: Date.now() + 60_000, backfillDays: 7 });
    expect(stored).toEqual(["m2"]);
  });
});

describe("GOOGLE_NOS_PDAS e o ecrã", () => {
  it("desligado (com a entrada com código ligada): sem Google nos PDAs registados; fora deles há sempre", async () => {
    lisbon();
    process.env.GOOGLE_NOS_PDAS = "off";
    const dev = device();
    expect(await (await dev.caller()).auth.options()).toMatchObject({ codeLogin: true, googleOnPdas: false });
    expect(await (await dev.caller()).auth.pda.device({ deviceToken: TOKEN7 })).toEqual({ registered: true, name: "PDA 12", google: false });
    expect(await (await dev.caller()).auth.pda.device({ deviceToken: "z".repeat(32) })).toEqual({ registered: false, name: null, google: true });
    expect(googleShownOnDevice({ registeredPda: true, codeLogin: false, googleOnPdas: false })).toBe(true);
    expect(googleShownOnDevice({ registeredPda: false, codeLogin: true, googleOnPdas: false })).toBe(true);
    const flag = AUTOMATION_FLAGS.find((f) => f.name === "GOOGLE_NOS_PDAS");
    expect(flag).toMatchObject({ defaultEnabled: true, superAdminOnly: true });
  });

  it("no PDA o Chrome não guarda nada; o QR abre a página de entrada nova; o resumo da saída e os 10 s", () => {
    const home = readFileSync("client/src/pages/Home.tsx", "utf8");
    expect(home).toContain('autoComplete={onPda ? "off" : "username"}');
    expect(home).toContain('autoComplete={onPda ? "new-password" : "current-password"}');
    expect(home).toContain('autoComplete="one-time-code"');
    expect(home).toContain("pdaToken: getPdaToken()");
    const reg = readFileSync("client/src/pages/PdaRegisterPage.tsx", "utf8");
    expect(reg).toContain("window.location.href = codeLogin ? loginPageUrl(back) : loginUrlForDevice(loginUrlWithReturn(back), true);");
    const layout = readFileSync("client/src/components/DashboardLayout.tsx", "utf8");
    expect(layout).toContain("if (d?.pdaSessionEnded) { setPontoMode(null); beginPdaSessionEnd(checkoutSummaryLines(d as any)); return; }");
    const main = readFileSync("client/src/main.tsx", "utf8");
    expect(main).toContain("if (isPdaSessionEnding()) return;");
    expect(sessionEndsInText(10)).toBe("A sessão termina em 10 s.");
    expect(checkoutSummaryLines({ hoursWorked: "7.50", zello: { km: 12.34, maxSpeed: 61.2, offlineMinutes: 14 } })).toEqual([
      "Saída registada: 7 h 30 de trabalho.", "Zello: 12,3 km · velocidade máxima 61 km/h.", "14 min com o Zello desligado.",
    ]);
  });
});

describe("migração 0635", () => {
  it("só acrescenta colunas/índices (nada se apaga) e está registada", () => {
    for (const st of MIGRATION_0635_STATEMENTS) expect(st).not.toMatch(/\b(DELETE|DROP|TRUNCATE|UPDATE)\b/i);
    const all = MIGRATION_0635_STATEMENTS.join("\n");
    for (const c of ["sessionUserId", "sessionNonce", "sessionStartedAt"]) expect(all).toContain(`ALTER TABLE \`pdas\` ADD COLUMN \`${c}\``);
    expect(all).toContain("ALTER TABLE `web_push_subscriptions` ADD COLUMN `pdaId`");
    expect(all).toContain("ALTER TABLE `web_push_subscriptions` ADD COLUMN `disabledAt`");
    expect(SCHEMA_MIGRATION_IDS).toContain("0635");
  });
});
