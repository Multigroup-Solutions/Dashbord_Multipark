/**
 * Telemóveis pessoais (Jorge, 13 out 2026): o telemóvel de UMA pessoa (TL,
 * supervisor, qualquer um) separado dos PDAs partilhados. Pelas rotas reais
 * (`operational.personalDevices.*`, `operational.pdas.zelloCheck`) com a loja
 * em memória (server/personalDeviceStore.ts trocado).
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const state = {
    nextId: 1,
    devices: [] as any[],
    pdas: [] as any[],
    checkins: [] as any[],
    fichas: [] as any[],
    users: new Map<number, string>(),
    logs: [] as any[],
    ended: [] as number[],
    attaches: [] as any[],
    zelloUsers: [] as { name: string }[],
    raceOnRelease: false,
  };
  const dev = (id: number) => state.devices.find((d) => d.id === id);
  const copy = (d: any) => (d ? { ...d } : null);
  const store = {
    async byToken(token: string) { return copy(state.devices.find((d) => d.deviceToken === token)); },
    async byId(id: number) { return copy(dev(id)); },
    async insert(r: any) {
      if (state.devices.some((d) => d.deviceToken === r.deviceToken)) return null;
      const id = state.nextId++;
      state.devices.push({
        id, deviceToken: r.deviceToken, label: r.label, status: "active", ownerUserId: r.ownerUserId, ownerEmployeeId: r.ownerEmployeeId,
        currentUserId: r.currentUserId, currentEmployeeId: r.currentEmployeeId, currentSince: r.currentUserId != null ? r.now : null,
        lastUserId: r.currentUserId, lastEmployeeId: r.currentEmployeeId, lastSeenAt: r.currentUserId != null ? r.now : null,
        convertedFromPdaId: r.convertedFromPdaId,
      });
      return id;
    },
    async setCurrent(id: number, who: { userId: number; employeeId: number | null }, now: number) {
      const d = dev(id);
      if (!d || d.status !== "active") return;
      if (d.currentUserId !== who.userId || d.currentSince == null) d.currentSince = now;
      Object.assign(d, { currentUserId: who.userId, currentEmployeeId: who.employeeId, lastUserId: who.userId, lastEmployeeId: who.employeeId, lastSeenAt: now });
    },
    async clearCurrent(id: number, userId: number) {
      const d = dev(id);
      if (!d || d.currentUserId !== userId) return false;
      Object.assign(d, { currentUserId: null, currentEmployeeId: null, currentSince: null });
      return true;
    },
    async deactivate(id: number) {
      const d = dev(id);
      if (!d || d.status !== "active") return false;
      Object.assign(d, { status: "inactive", currentUserId: null, currentEmployeeId: null, currentSince: null });
      return true;
    },
    async claimOwner(id: number, userId: number, employeeId: number | null) {
      const d = dev(id);
      if (!d || d.status !== "active" || d.ownerUserId != null || d.ownerEmployeeId != null) return false;
      Object.assign(d, { ownerUserId: userId, ownerEmployeeId: employeeId });
      return true;
    },
    async listActive() { return state.devices.filter((d) => d.status === "active").map(copy); },
    async convertedPdaIds() { return state.devices.map((d) => d.convertedFromPdaId).filter((x) => x != null); },
    async activePdaByToken(token: string) { const p = state.pdas.find((x) => x.deviceToken === token && x.status === "active"); return p ? { id: p.id, name: p.name } : null; },
    async pda(id: number) {
      const p = state.pdas.find((x) => x.id === id);
      return p ? { id: p.id, name: p.name, status: p.status, deviceToken: p.deviceToken ?? null, projectId: p.projectId ?? null, zelloUsername: p.zelloUsername ?? null } : null;
    },
    async releasePdaToken(pdaId: number, token: string) {
      const p = state.pdas.find((x) => x.id === pdaId);
      if (state.raceOnRelease && p) p.deviceToken = "registado-noutro-aparelho-entretanto";
      if (!p || p.deviceToken !== token) return false;
      p.deviceToken = null;
      return true;
    },
    async retirePda(pdaId: number, note: string) { const p = state.pdas.find((x) => x.id === pdaId); Object.assign(p, { status: "inactive", notes: `${p.notes ?? ""}\n${note}`.trim() }); },
    async closePdaCheckins(pdaId: number, now: number, note: string) {
      let n = 0;
      for (const c of state.checkins) if (c.pdaId === pdaId && c.status === "checked_in") { Object.assign(c, { status: "checked_out", checkoutAt: now, notes: note }); n++; }
      return n;
    },
    async adoptZello(employeeId: number, zello: string) {
      if (state.fichas.some((f) => String(f.zello ?? "").toLowerCase() === zello.toLowerCase())) return false;
      const f = state.fichas.find((x) => x.id === employeeId);
      if (!f || f.zello) return false;
      f.zello = zello;
      return true;
    },
    async people(employeeIds: number[], userIds: number[]) {
      const employees = new Map<number, { name: string; zello: string | null; userId: number | null }>();
      for (const f of state.fichas) if (employeeIds.includes(f.id)) employees.set(f.id, { name: f.fullName, zello: f.zello ?? null, userId: f.userId ?? null });
      const users = new Map<number, string>();
      for (const id of userIds) if (state.users.has(id)) users.set(id, state.users.get(id)!);
      return { employees, users };
    },
  };
  const ficha = (f: any) => f && { employee: { id: f.id, fullName: f.fullName, zelloUsername: f.zello ?? null, userId: f.userId ?? null, projectId: null, position: f.position ?? "extra", isActive: 1 }, project: null };
  return { state, store, ficha };
});

vi.mock("./personalDeviceStore", async (original) => ({ ...(await original<object>()), personalDeviceStore: () => m.store }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));
vi.mock("./loginBlock", async (original) => ({ ...(await original<object>()), loginBlockFor: async () => null }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => null,
  getUserModuleOverrides: async () => ({}),
  getUserPermissionOverrides: async () => ({}),
  logActivity: async (e: any) => { m.state.logs.push(e); },
  getEmployeeByUserId: async (userId: number) => m.ficha(m.state.fichas.find((f) => f.userId === userId)) ?? undefined,
  getEmployeeById: async (id: number) => m.ficha(m.state.fichas.find((f) => f.id === id)) ?? undefined,
  listPdas: async () => m.state.pdas.map((p) => ({ ...p })),
  attachPdaByDeviceToken: async (token: string, employeeId: number) => { m.state.attaches.push({ token, employeeId }); return null; },
}));
vi.mock("./pdaSession", async (original) => ({
  ...(await original<object>()),
  endPdaSessionOnRetire: async (pdaId: number) => { m.state.ended.push(pdaId); const p = m.state.pdas.find((x) => x.id === pdaId); if (p) p.sessionNonce = null; return true; },
}));
vi.mock("./pdaZelloName", () => ({ syncPdaZelloName: async () => "skip", syncPdaZelloNameByToken: async () => undefined, syncPdaZelloNamesForEmployee: async () => undefined }));
vi.mock("./zello", async (original) => ({ ...(await original<object>()), getZelloUsers: async () => m.state.zelloUsers }));

import { appRouter } from "./routers";
import { isPersonalAccessPath } from "./cityAccess";
import { MIGRATION_0650_STATEMENTS, IDEMPOTENT_ERROR_CODES_0650 } from "./migrations/migration_0650";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import {
  CONVERT_NOT_REGISTERED_MSG, CONVERT_RACE_MSG, PDA_ON_PERSONAL_MSG, PERSONAL_TOKEN_KEY, isDeviceToken, looksLikePhone,
  personalDeviceTitle, personalDeviceZello, personalIsPdaMsg, personalZelloCheck, shortPersonName,
} from "../shared/personalDevice";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const PDA_TOKEN = "p".repeat(32);
const JORGE_PHONE_AS_PDA = "j".repeat(32);

const ROLE_OF: Record<number, string> = { 21: "team_leader", 22: "supervisor", 23: "admin", 100: "extra" };
const as = (userId: number) => appRouter.createCaller({ user: { id: userId, role: ROLE_OF[userId], name: m.state.users.get(userId) ?? null }, req: { headers: { "user-agent": ANDROID } }, res: {} } as any);

beforeEach(() => {
  Object.assign(m.state, { nextId: 1, devices: [], pdas: [], checkins: [], fichas: [], users: new Map(), logs: [], ended: [], attaches: [], zelloUsers: [], raceOnRelease: false });
  // Jorge (TL), Márcia (supervisora), Marco (admin, sem Zello na ficha), Joaquim (extra)
  m.state.users = new Map([[21, "Jorge"], [22, "Márcia"], [23, "Marco"], [100, "Joaquim"]]);
  m.state.fichas.push({ id: 11, fullName: "Jorge Manuel Tabuada", userId: 21, zello: "Jorge", position: "team_leader" });
  m.state.fichas.push({ id: 12, fullName: "Márcia Costa", userId: 22, zello: "Marcia" });
  m.state.fichas.push({ id: 13, fullName: "Marco Antunes", userId: 23, zello: null });
  m.state.fichas.push({ id: 101, fullName: "Joaquim Extra", userId: 100, zello: "Extra12" });
  // PDA 12, partilhado (extras), com sessão e check-in do Joaquim
  m.state.pdas.push({ id: 7, name: "PDA 12", deviceToken: PDA_TOKEN, status: "active", projectId: 49, zelloUsername: "Extra12", sessionNonce: "nonce-do-pda-12", registered: true });
  m.state.checkins.push({ id: 1, pdaId: 7, employeeId: 101, status: "checked_in" });
  m.state.zelloUsers = [{ name: "Jorge" }, { name: "Marcia" }, { name: "Extra12" }, { name: "marco" }];
});

const listed = async (userId = 21) => (await as(userId).operational.personalDevices.list()).devices;

describe("regras puras", () => {
  it("o nome é o de quem lá está; senão o último; senão o dono", () => {
    expect(personalDeviceTitle({ currentName: "Márcia Costa", lastName: "Jorge", ownerName: "Jorge Manuel Tabuada" })).toBe("Telemóvel de Márcia Costa");
    expect(personalDeviceTitle({ currentName: null, lastName: "Jorge Manuel Tabuada", ownerName: "x" })).toBe("Telemóvel de Jorge Tabuada");
    expect(personalDeviceTitle({ ownerName: "Marco" })).toBe("Telemóvel de Marco");
    expect(personalDeviceTitle({})).toBe("Telemóvel pessoal");
    expect(shortPersonName("Gelson Manuel Leão Sousa")).toBe("Gelson Sousa");
  });
  it("o Zello é o da ficha do dono (quem entra não o muda); sem dono, o de quem lá está", () => {
    expect(personalDeviceZello({ hasOwner: true, ownerZello: "Jorge", currentZello: "Marcia" })).toBe("Jorge");
    expect(personalDeviceZello({ hasOwner: true, ownerZello: null, currentZello: "Marcia" })).toBeNull();
    expect(personalDeviceZello({ hasOwner: false, currentZello: " Marcia ", lastZello: "Jorge" })).toBe("Marcia");
    expect(personalDeviceZello({ hasOwner: false, currentZello: null, lastZello: "Jorge" })).toBe("Jorge");
  });
  it("Zello do telemóvel: sem Zello não é erro (não fica amarelo); escrito de outra maneira é", () => {
    const users = [{ name: "Jorge" }, { name: "Marco_A" }];
    expect(personalZelloCheck("Jorge", "Jorge", users)).toMatchObject({ status: "ok", problem: false });
    expect(personalZelloCheck(null, "Marco Antunes", users)).toMatchObject({ status: "sem_zello", problem: false, detail: "A ficha de Marco Antunes não tem Zello." });
    expect(personalZelloCheck("jorge", "Jorge", users)).toMatchObject({ status: "maiusculas", problem: true, suggestion: "Jorge" });
    expect(personalZelloCheck("ninguem", "X", users)).toMatchObject({ status: "nao_existe", problem: true });
  });
  it("tokens, telemóvel e as chaves do browser nunca se cruzam com as do PDA", () => {
    expect(isDeviceToken("a".repeat(32))).toBe(true);
    expect(isDeviceToken("curto")).toBe(false);
    expect(isDeviceToken("a".repeat(32) + "'; DROP")).toBe(false);
    expect(looksLikePhone(ANDROID)).toBe(true);
    expect(looksLikePhone("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0")).toBe(false);
    expect(PERSONAL_TOKEN_KEY).not.toBe("mp.pda.deviceToken");
  });
});

describe("registar o próprio telemóvel", () => {
  it("qualquer pessoa (até um extra) regista o seu: fica dona, com o nome dela e o label do browser", async () => {
    const r = await as(100).operational.personalDevices.register({ pdaToken: null, currentToken: null });
    expect(isDeviceToken(r.token)).toBe(true);
    expect(r.already).toBe(false);
    expect(r.device).toMatchObject({ title: "Telemóvel de Joaquim Extra", ownerName: "Joaquim Extra", currentName: "Joaquim Extra", label: "Android · Chrome", zelloUsername: "Extra12", mine: true });
    expect(m.state.devices).toHaveLength(1);
    expect(m.state.logs.some((l) => l.entity === "personal_device" && l.action === "register_device")).toBe(true);
  });
  it("registar outra vez no mesmo telemóvel não cria outro nem muda o token", async () => {
    const a = await as(21).operational.personalDevices.register({});
    const b = await as(21).operational.personalDevices.register({ currentToken: a.token });
    expect(b).toMatchObject({ token: a.token, already: true });
    expect(m.state.devices).toHaveLength(1);
  });
  it("o nome e o Zello vêm da pessoa (a ficha), na lista de Operacional → PDAs", async () => {
    await as(21).operational.personalDevices.register({});
    const [d] = await listed();
    expect(d).toMatchObject({ title: "Telemóvel de Jorge Tabuada", ownerName: "Jorge Manuel Tabuada", zelloUsername: "Jorge", zelloOf: "Jorge Manuel Tabuada" });
  });
  it("outra pessoa entra: o nome passa a ser o dela, o Zello continua o do dono; ao sair fica como 'último'", async () => {
    const { token } = await as(21).operational.personalDevices.register({});
    const seen = await as(22).operational.personalDevices.seen({ token });
    expect(seen).toMatchObject({ kind: "pessoal", migrated: false });
    let [d] = await listed();
    expect(d).toMatchObject({ title: "Telemóvel de Márcia Costa", currentName: "Márcia Costa", ownerName: "Jorge Manuel Tabuada", zelloUsername: "Jorge" });
    expect(m.state.logs.some((l) => l.action === "personal_device_enter" && /Márcia Costa entrou/.test(l.details) && /antes: Jorge/.test(l.details))).toBe(true);
    // Sair (logout) neste telemóvel
    expect(await as(22).operational.personalDevices.left({ token })).toEqual({ left: true });
    [d] = await listed();
    expect(d).toMatchObject({ currentName: null, lastName: "Márcia Costa", title: "Telemóvel de Márcia Costa" });
    // Sair de outra conta não mexe em quem lá está
    await as(21).operational.personalDevices.seen({ token });
    expect(await as(22).operational.personalDevices.left({ token })).toEqual({ left: false });
    [d] = await listed();
    expect(d).toMatchObject({ currentName: "Jorge Manuel Tabuada", title: "Telemóvel de Jorge Tabuada" });
  });
  it("o telemóvel de outra pessoa não passa a ser meu por registar", async () => {
    const { token } = await as(21).operational.personalDevices.register({});
    await expect(as(22).operational.personalDevices.register({ currentToken: token })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("pessoal de Jorge Tabuada") });
    expect(m.state.devices[0]).toMatchObject({ ownerUserId: 21, ownerEmployeeId: 11 });
  });
  it("deixar de ser pessoal: o dono no telemóvel; um extra no telemóvel de outro não; nunca se apaga", async () => {
    const { token } = await as(21).operational.personalDevices.register({});
    await expect(as(100).operational.personalDevices.unregisterMine({ token })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await as(21).operational.personalDevices.unregisterMine({ token })).toEqual({ done: true });
    expect(m.state.devices).toHaveLength(1);
    expect(m.state.devices[0].status).toBe("inactive");
    expect(await listed()).toEqual([]);
    // O browser fica a saber que já não é pessoal (e esquece-o)
    expect(await as(21).operational.personalDevices.seen({ token })).toEqual({ kind: "none" });
  });
  it("pela lista só quem edita PDAs; o extra não", async () => {
    await as(21).operational.personalDevices.register({});
    await expect(as(100).operational.personalDevices.unregister({ id: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(100).operational.personalDevices.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await as(22).operational.personalDevices.unregister({ id: 1 })).toEqual({ done: true });
  });
  it("são procedimentos da própria pessoa (também sem centro de custos); a lista e a conversão não", () => {
    for (const p of ["register", "seen", "left", "unregisterMine"]) expect(isPersonalAccessPath(`operational.personalDevices.${p}`)).toBe(true);
    for (const p of ["list", "unregister", "convertFromPda"]) expect(isPersonalAccessPath(`operational.personalDevices.${p}`)).toBe(false);
  });
});

describe("não toca nos PDAs partilhados", () => {
  it("num PDA registado recusa (o PDA não passa a pessoal por aqui) e nada muda", async () => {
    const before = JSON.stringify(m.state.pdas);
    await expect(as(100).operational.personalDevices.register({ pdaToken: PDA_TOKEN })).rejects.toMatchObject({ code: "FORBIDDEN", message: personalIsPdaMsg("PDA 12") });
    expect(m.state.devices).toHaveLength(0);
    expect(JSON.stringify(m.state.pdas)).toBe(before);
  });
  it("registar, entrar e sair num telemóvel pessoal não liga PDAs, não mexe em check-ins nem em sessões de PDA", async () => {
    const before = JSON.stringify({ pdas: m.state.pdas, checkins: m.state.checkins });
    const { token } = await as(21).operational.personalDevices.register({});
    await as(100).operational.personalDevices.seen({ token });
    await as(100).operational.personalDevices.left({ token });
    expect(JSON.stringify({ pdas: m.state.pdas, checkins: m.state.checkins })).toBe(before);
    expect(m.state.attaches).toEqual([]);
    expect(m.state.ended).toEqual([]);
    // O token pessoal não é de nenhum PDA
    expect(m.state.pdas.some((p) => p.deviceToken === token)).toBe(false);
  });
  it("o token de um PDA normal não é telemóvel pessoal ('none'): o PDA fica igual", async () => {
    const before = JSON.stringify(m.state.pdas);
    expect(await as(100).operational.personalDevices.seen({ pdaToken: PDA_TOKEN })).toEqual({ kind: "none" });
    expect(JSON.stringify(m.state.pdas)).toBe(before);
  });
  it("no cliente: chave própria no browser; o ponto→PDA, o login no PDA e o QR não usam o token pessoal; o QR recusa num pessoal", () => {
    const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    const lib = src("client/src/lib/pdaDevice.ts");
    expect(lib).toContain("localStorage.getItem(PERSONAL_TOKEN_KEY)");
    expect(lib).toContain('export const PDA_TOKEN_KEY = "mp.pda.deviceToken";');
    expect(src("client/src/components/PdaDeviceBinder.tsx")).not.toMatch(/getPersonalToken|personalDevices/);
    expect(src("client/src/pages/HRPage.tsx")).toContain('pdaDeviceToken: localStorage.getItem("mp.pda.deviceToken") || undefined');
    expect(src("client/src/pages/HRPage.tsx")).not.toContain("personalToken");
    const qr = src("client/src/pages/PdaRegisterPage.tsx");
    expect(qr).toContain("if (r.kind === \"pessoal\") { setState({ ok: false, message: PDA_ON_PERSONAL_MSG }); return; }");
    expect(PDA_ON_PERSONAL_MSG).toContain("Deixar de ser pessoal");
    // Num PDA o cartão "Este telemóvel" não aparece
    expect(src("client/src/components/PersonalDeviceCard.tsx")).toContain("if (!user || pdaToken) return null;");
  });
});

describe("converter um PDA que afinal é o telemóvel de alguém", () => {
  beforeEach(() => {
    // O telemóvel do Jorge, registado como PDA pelo QR: sem Zello no PDA (fica "sem Zello", amarelo)
    m.state.pdas.push({ id: 9, name: "Telemóvel Jorge", deviceToken: JORGE_PHONE_AS_PDA, status: "active", projectId: 49, zelloUsername: null, sessionNonce: "nonce-jorge", registered: true });
    m.state.checkins.push({ id: 2, pdaId: 9, employeeId: 11, status: "checked_in" });
  });
  it("só o team leader ou acima (quem edita PDAs)", async () => {
    await expect(as(100).operational.personalDevices.convertFromPda({ pdaId: 9, employeeId: 11 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(m.state.devices).toHaveLength(0);
    expect(m.state.pdas.find((p) => p.id === 9)).toMatchObject({ status: "active", deviceToken: JORGE_PHONE_AS_PDA });
  });
  it("passa a pessoal do dono: o PDA fica Inativo com nota e sem token, a sessão de PDA acaba, o check-in fecha; o resto fica", async () => {
    const r = await as(21).operational.personalDevices.convertFromPda({ pdaId: 9, employeeId: 11 });
    expect(r).toMatchObject({ pdaName: "Telemóvel Jorge", closedCheckins: 1, zelloAdopted: null });
    expect(r.device).toMatchObject({ title: "Telemóvel de Jorge Tabuada", ownerName: "Jorge Manuel Tabuada", zelloUsername: "Jorge", convertedFromPdaId: 9, label: "Telemóvel Jorge" });
    const pda = m.state.pdas.find((p) => p.id === 9);
    expect(pda).toMatchObject({ status: "inactive", deviceToken: null, sessionNonce: null });
    expect(pda.notes).toMatch(/passou a telemóvel pessoal de Jorge Tabuada/);
    expect(m.state.ended).toEqual([9]);
    expect(m.state.checkins.find((c) => c.id === 2)).toMatchObject({ status: "checked_out", notes: "fechado: o aparelho passou a telemóvel pessoal" });
    // O PDA 12 (partilhado) e o check-in do Joaquim não mexem
    expect(m.state.pdas.find((p) => p.id === 7)).toMatchObject({ status: "active", deviceToken: PDA_TOKEN, sessionNonce: "nonce-do-pda-12" });
    expect(m.state.checkins.find((c) => c.id === 1)?.status).toBe("checked_in");
    // Nada apagado; registado no PDA e no telemóvel
    expect(m.state.pdas).toHaveLength(2);
    expect(m.state.logs.filter((l) => l.action === "convert_device").map((l) => l.entity).sort()).toEqual(["pda", "personal_device"]);
    expect((await as(21).operational.personalDevices.list()).convertedPdaIds).toEqual([9]);
  });
  it("o telemóvel passa sozinho na próxima entrada (o token sai da chave do PDA)", async () => {
    await as(21).operational.personalDevices.convertFromPda({ pdaId: 9, employeeId: 11 });
    const s = await as(21).operational.personalDevices.seen({ pdaToken: JORGE_PHONE_AS_PDA });
    expect(s).toMatchObject({ kind: "pessoal", migrated: true, device: { title: "Telemóvel de Jorge Tabuada", currentName: "Jorge Manuel Tabuada" } });
    // Com o token já na chave pessoal: igual, sem "migrated"
    expect(await as(21).operational.personalDevices.seen({ token: JORGE_PHONE_AS_PDA })).toMatchObject({ kind: "pessoal", migrated: false });
  });
  it("o Zello que estava no PDA passa para a ficha do dono só se a ficha não tiver nenhum e mais ninguém o tiver", async () => {
    m.state.pdas.push({ id: 10, name: "Telemóvel Marco", deviceToken: "k".repeat(32), status: "active", projectId: 49, zelloUsername: "marco", registered: true });
    const r = await as(21).operational.personalDevices.convertFromPda({ pdaId: 10, employeeId: 13 });
    expect(r.zelloAdopted).toBe("marco");
    expect(m.state.fichas.find((f) => f.id === 13)?.zello).toBe("marco");
    // A Márcia já tem Zello: o "Jorge" do PDA não lhe tira nem troca nada
    m.state.pdas.push({ id: 11, name: "Telemóvel Márcia", deviceToken: "n".repeat(32), status: "active", projectId: 49, zelloUsername: "Jorge", registered: true });
    expect((await as(21).operational.personalDevices.convertFromPda({ pdaId: 11, employeeId: 12 })).zelloAdopted).toBeNull();
    expect(m.state.fichas.find((f) => f.id === 12)?.zello).toBe("Marcia");
    expect(m.state.fichas.find((f) => f.id === 11)?.zello).toBe("Jorge");
  });
  it("sem dono escolhido: quem o registar no Perfil fica dono; até lá o nome é o de quem lá está", async () => {
    await as(21).operational.personalDevices.convertFromPda({ pdaId: 9, employeeId: null });
    await as(22).operational.personalDevices.seen({ pdaToken: JORGE_PHONE_AS_PDA });
    let [d] = await listed();
    expect(d).toMatchObject({ title: "Telemóvel de Márcia Costa", ownerName: null, zelloUsername: "Marcia" });
    await as(21).operational.personalDevices.register({ currentToken: JORGE_PHONE_AS_PDA });
    [d] = await listed();
    expect(d).toMatchObject({ ownerName: "Jorge Manuel Tabuada", zelloUsername: "Jorge", title: "Telemóvel de Jorge Tabuada" });
  });
  it("um PDA sem aparelho registado não se converte; um já convertido também não", async () => {
    m.state.pdas.push({ id: 12, name: "PDA 20", deviceToken: null, status: "active", projectId: 49, registered: false });
    await expect(as(21).operational.personalDevices.convertFromPda({ pdaId: 12, employeeId: 11 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: CONVERT_NOT_REGISTERED_MSG });
    await as(21).operational.personalDevices.convertFromPda({ pdaId: 9, employeeId: 11 });
    await expect(as(21).operational.personalDevices.convertFromPda({ pdaId: 9, employeeId: 11 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(m.state.devices).toHaveLength(1);
  });
  it("o PDA mudou de aparelho entretanto: não converte e o telemóvel novo fica inativo (não apagado)", async () => {
    m.state.raceOnRelease = true;
    await expect(as(21).operational.personalDevices.convertFromPda({ pdaId: 9, employeeId: 11 })).rejects.toMatchObject({ code: "CONFLICT", message: CONVERT_RACE_MSG });
    expect(m.state.pdas.find((p) => p.id === 9)?.status).toBe("active");
    expect(m.state.devices).toHaveLength(1);
    expect(m.state.devices[0].status).toBe("inactive");
    expect(m.state.ended).toEqual([]);
  });
});

describe("Zello dos telemóveis pessoais na verificação do Zello", () => {
  it("um a um: certo, sem Zello (sem amarelo) e com outras maiúsculas (amarelo)", async () => {
    const jorge = await as(21).operational.personalDevices.register({});
    const marco = await as(23).operational.personalDevices.register({});
    m.state.fichas.find((f) => f.id === 12)!.zello = "marcia";
    const marcia = await as(22).operational.personalDevices.register({});
    const r = await as(21).operational.pdas.zelloCheck();
    expect(r.available).toBe(true);
    if (!r.available) return;
    const by = new Map(r.personal.map((c: any) => [c.deviceId, c]));
    expect(by.get(jorge.device!.id)).toMatchObject({ status: "ok", problem: false });
    expect(by.get(marco.device!.id)).toMatchObject({ status: "sem_zello", problem: false });
    expect(by.get(marcia.device!.id)).toMatchObject({ status: "maiusculas", problem: true, suggestion: "Marcia" });
    // Os PDAs continuam com a verificação de sempre
    expect(r.checks.find((c: any) => c.pdaId === 7)).toMatchObject({ status: "ok" });
  });
});

describe("migração 0650", () => {
  it("cria a tabela só se não existir, registada por ordem no fim da lista", () => {
    expect(MIGRATION_0650_STATEMENTS).toHaveLength(1);
    expect(MIGRATION_0650_STATEMENTS[0]).toMatch(/^CREATE TABLE IF NOT EXISTS `personal_devices`/);
    expect(MIGRATION_0650_STATEMENTS[0]).toContain("UNIQUE KEY `uq_personal_devices_token` (`deviceToken`)");
    expect(MIGRATION_0650_STATEMENTS.join(" ")).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
    expect(IDEMPOTENT_ERROR_CODES_0650.has("ER_TABLE_EXISTS_ERROR")).toBe(true);
    expect(SCHEMA_MIGRATION_IDS.indexOf("0650")).toBe(SCHEMA_MIGRATION_IDS.indexOf("0645") + 1);
  });
});
