/**
 * Lote 46 (Jorge, 7 out 2026): "eles [os extras] entram, supostamente são
 * utilizadores e deviam de poder ir à ficha deles e pôr as disponibilidades, e
 * não conseguem". Utilizador e extra abrem a PRÓPRIA ficha e gravam a PRÓPRIA
 * disponibilidade (com ou sem cidade); nunca a dos outros; sem ficha ligada ou
 * sem cidade, a mensagem diz qual é a conta e o que pedir ao RH.
 */
import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  load: vi.fn(),
  getMyWeek: vi.fn(),
  setMy: vi.fn(),
  logins: vi.fn(),
  candidates: vi.fn(),
  // conta → ficha (101 = extra da ficha 7, 102 = utilizador da ficha 9, 202 = sem ficha)
  byUser: { 101: 7, 102: 9 } as Record<number, number>,
  fichas: {
    7: { id: 7, fullName: "Ana Sousa", email: "ana.sousa@gmail.com", personalEmail: null, position: "extra", projectId: 50, userId: 101, isActive: 1 },
    8: { id: 8, fullName: "Rui Costa", email: "rui@gmail.com", personalEmail: null, position: "extra", projectId: 50, userId: 103, isActive: 1 },
    9: { id: 9, fullName: "Joana Lima", email: "joana@gmail.com", personalEmail: null, position: "extra", projectId: 50, userId: 102, isActive: 1 },
  } as Record<number, any>,
}));

vi.mock("./cityAccess", async (original) => ({ ...(await original<object>()), loadCityAccess: s.load }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserModuleOverrides: async () => ({}),
  getUserPermissionOverrides: async () => ({}),
  getEmployeeByUserId: async (userId: number) => {
    const id = s.byUser[userId];
    return id ? { employee: s.fichas[id], project: null } : undefined;
  },
  getEmployeeById: async (id: number) => (s.fichas[id] ? { employee: s.fichas[id], project: null } : undefined),
  getUserById: async (id: number) => ({ id, name: "Conta", email: `conta${id}@gmail.com`, role: id === 102 ? "user" : "extra", isActive: 1 }),
  resolveProjectIds: async (id: number) => (id === 50 ? [50, 65] : [id]),
  logActivity: async () => undefined,
}));
vi.mock("./extrasAvailability", async (original) => ({ ...(await original<object>()), getMyWeek: s.getMyWeek, setMyAvailability: s.setMy }));
vi.mock("./rhDocuments", async (original) => ({ ...(await original<object>()), licenceStatusesOrNull: async () => null }));
vi.mock("./personIdentity", async (original) => ({ ...(await original<object>()), listEmployeeLogins: s.logins, orphanLoginCandidates: s.candidates }));

import { appRouter } from "./routers";
import { accessEmployee, MISSING_COST_CENTRE_MESSAGE, ownRecordEmployeeId } from "./cityAccess";
import { loginCandidateReason, noAccessHint, noLinkedRecordMessage, NO_CITY_OWN_MESSAGE } from "../shared/ownAccess";
import { grantFor } from "../shared/access";

const caller = (role: string, id: number, email = `conta${id}@gmail.com`) =>
  appRouter.createCaller({ user: { id, role, email }, req: { headers: {} }, res: {} } as any);
const porto = { all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], cityNames: ["Porto"], projectIds: [50, 65], missingCostCenter: false };
const semCidade = { all: false, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: true };
const national = { all: true, defaultCityId: null, cityIds: [49, 50], projectIds: [48, 49, 50, 65], missingCostCenter: false };
const WEEK = "2026-10-12";
const days = [{ day: "2026-10-12", morning: true }, { day: "2026-10-13", night: true }];
const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

beforeEach(() => {
  vi.clearAllMocks();
  s.load.mockResolvedValue(porto);
  s.getMyWeek.mockImplementation(async (employeeId: number, weekStart: string) => ({ employeeId, weekStart, weekEnd: "2026-10-18", submitted: false, days: [] }));
  s.setMy.mockResolvedValue({ saved: 2, previous: [] });
  s.logins.mockResolvedValue([]);
  s.candidates.mockResolvedValue([{ userId: 300, name: "Ana Sousa", email: "anasousa77@gmail.com", lastSignedIn: "2026-10-07 09:00", reason: "nome parecido (ana, sousa)" }]);
});

describe("46: a matriz já dá a ficha e a disponibilidade próprias a utilizador e extra", () => {
  it.each(["user", "extra"])("%s: ficha e disponibilidade = só o próprio, ver e editar; nada da escala dos outros", (role) => {
    expect(grantFor(role, "ficha")).toEqual({ access: "own", actions: ["view", "edit"] });
    expect(grantFor(role, "disponibilidade")).toEqual({ access: "own", actions: ["view", "edit"] });
    expect(grantFor(role, "extras_dia").access).toBe("none");
    expect(grantFor(role, "disponibilidade_extras").access).toBe("none");
    expect(grantFor(role, "rh").access).toBe("none");
  });
});

describe.each([["extra", 101, 7], ["user", 102, 9]] as const)("46: %s com ficha e cidade", (role, userId, fichaId) => {
  it("abre a própria ficha (rh.me e rh.byId) e não a de outro", async () => {
    expect(await caller(role, userId).rh.me()).toMatchObject({ employee: { id: fichaId } });
    expect(await caller(role, userId).rh.byId({ id: fichaId })).toMatchObject({ employee: { id: fichaId } });
    await expect(caller(role, userId).rh.byId({ id: 8 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("vê e grava a própria disponibilidade — sempre na SUA ficha (a ficha vem da sessão)", async () => {
    expect(await caller(role, userId).extrasAvailability.myWeek({ weekStart: WEEK })).toMatchObject({ employeeId: fichaId, weekStart: WEEK });
    expect(await caller(role, userId).extrasAvailability.setMyWeek({ weekStart: WEEK, days })).toEqual({ saved: 2 });
    expect(s.setMy).toHaveBeenCalledWith(fichaId, WEEK, days, userId);
  });
  it("vê a disponibilidade da própria ficha no RH; a de outro não", async () => {
    expect(await caller(role, userId).extrasAvailability.forEmployee({ employeeId: fichaId, weekStart: WEEK })).toMatchObject({ employeeId: fichaId });
    await expect(caller(role, userId).extrasAvailability.forEmployee({ employeeId: 8, weekStart: WEEK })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(s.getMyWeek).not.toHaveBeenCalledWith(8, WEEK);
  });
  it("não marca pelos outros nem vê a matriz de todos", async () => {
    await expect(caller(role, userId).extrasAvailability.setForEmployee({ employeeId: 8, weekStart: WEEK, days })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(role, userId).extrasAvailability.overview({ weekStart: WEEK })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(s.setMy).not.toHaveBeenCalled();
  });
});

describe("46: sem cidade (centro de custos) o que é da pessoa abre na mesma", () => {
  beforeEach(() => { s.load.mockResolvedValue(semCidade); });
  it("a ficha, a disponibilidade (ler e gravar) e os cartões da própria ficha", async () => {
    const c = caller("extra", 101);
    expect(await c.rh.byId({ id: 7 })).toMatchObject({ employee: { id: 7 } });
    expect(await c.extrasAvailability.myWeek({ weekStart: WEEK })).toMatchObject({ employeeId: 7 });
    expect(await c.extrasAvailability.setMyWeek({ weekStart: WEEK, days })).toEqual({ saved: 2 });
    expect(await c.extrasAvailability.forEmployee({ employeeId: 7, weekStart: WEEK })).toMatchObject({ employeeId: 7 });
    expect(await c.rh.accountSummary({ employeeId: 7 })).toMatchObject({ id: 101, canManage: false });
    expect(await c.rh.loginLinks({ employeeId: 7 })).toMatchObject({ canLink: false, candidates: [] });
  });
  it("a de outra pessoa continua fechada, com a mensagem que diz o que pedir ao RH", async () => {
    await expect(caller("extra", 101).extrasAvailability.forEmployee({ employeeId: 8, weekStart: WEEK }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: MISSING_COST_CENTRE_MESSAGE });
    await expect(caller("extra", 101).rh.byId({ id: 8 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(MISSING_COST_CENTRE_MESSAGE).toMatch(/Pede ao RH para pôr a tua cidade na ficha/);
    expect(NO_CITY_OWN_MESSAGE).toMatch(/Pede ao RH para pôr a tua cidade/);
  });
  it("só os cartões da ficha (leituras por employeeId) entram na lista do 'próprio'", () => {
    for (const p of ["rh.accountSummary", "rh.agentSummary", "rh.autoMail", "rh.myMonthSummary", "rh.timeRecords.monthlyHours", "extrasAvailability.forEmployee", "rh.loginLinks"]) {
      expect(ownRecordEmployeeId(p, { employeeId: 7 })).toBe(7);
    }
    expect(ownRecordEmployeeId("extrasAvailability.setForEmployee", { employeeId: 7 })).toBeNull();
    expect(ownRecordEmployeeId("rh.checkDocs", { employeeId: 7 })).toBeNull();
  });
});

describe("46: conta Google sem ficha", () => {
  it("a disponibilidade diz qual é a conta e o que fazer (não um erro genérico)", async () => {
    const c = caller("user", 202, "Maria.Extra@Gmail.com");
    await expect(c.extrasAvailability.myWeek({ weekStart: WEEK })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("A tua conta Google maria.extra@gmail.com não está ligada a nenhuma ficha. Pede ao RH para pôr este email na tua ficha"),
    });
    await expect(c.extrasAvailability.setMyWeek({ weekStart: WEEK, days })).rejects.toMatchObject({ message: expect.stringContaining("maria.extra@gmail.com") });
    expect(s.setMy).not.toHaveBeenCalled();
    expect(await c.rh.me()).toBeUndefined();
  });
  it("a mensagem funciona sem email e é a mesma no ecrã", () => {
    expect(noLinkedRecordMessage(null)).toMatch(/não está ligada a nenhuma ficha. Pede ao RH/);
    for (const f of ["client/src/components/OwnAccessNotice.tsx", "client/src/pages/ProfilePage.tsx", "client/src/components/DashboardLayout.tsx"]) {
      expect(read(f)).toMatch(/noLinkedRecordMessage\(/);
    }
    const hr = read("client/src/pages/HRPage.tsx");
    expect(hr).not.toMatch(/O seu perfil de colaborador ainda não foi criado/);
    expect(hr).toMatch(/if \(myLoading\)/);
    expect(hr).toMatch(/<NoLinkedRecordNotice email=\{user\?\.email\} \/>/);
    expect(read("client/src/pages/DisponibilidadePage.tsx")).toMatch(/\(user as any\)\?\.employee === null\) return <NoLinkedRecordNotice/);
  });
});

describe("46: no RH, quem gere vê com que conta a pessoa entra", () => {
  it("admin (todas as cidades): ficha sem conta → emails da ficha + contas sem ficha parecidas", async () => {
    s.load.mockResolvedValue(national);
    const r = await caller("admin", 1).rh.loginLinks({ employeeId: 7 });
    expect(r).toMatchObject({ fichaEmails: ["ana.sousa@gmail.com"], logins: [], canLink: true, national: true });
    expect(r.candidates).toHaveLength(1);
    expect(s.candidates).toHaveBeenCalledWith({ fullName: "Ana Sousa", emails: ["ana.sousa@gmail.com"] });
  });
  it("com conta ligada mostra-a (e avisa se está como Utilizador numa ficha de extra); não procura outras", async () => {
    s.load.mockResolvedValue(national);
    s.logins.mockResolvedValue([{ userId: 102, name: "Joana", email: "joana@gmail.com", role: "user", isActive: true, principal: true, lastSignedIn: "2026-10-07 08:00", loginMethod: "google" }]);
    const r = await caller("admin", 1).rh.loginLinks({ employeeId: 9 });
    expect(r.logins[0]).toMatchObject({ email: "joana@gmail.com", principal: true });
    expect(r.warnings.join(" ")).toMatch(/está como "Utilizador"/);
    expect(s.candidates).not.toHaveBeenCalled();
  });
  it("supervisor da cidade não vê contas sem ficha (não têm cidade); extra não vê a de outro", async () => {
    const sup = await caller("supervisor", 104).rh.loginLinks({ employeeId: 7 });
    expect(sup).toMatchObject({ national: false, candidates: [] });
    expect(s.candidates).not.toHaveBeenCalled();
    await expect(caller("extra", 101).rh.loginLinks({ employeeId: 8 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("46: regras puras", () => {
  it("readmissão: a conta na ficha antiga (inativa) e na nova → conta a ativa; duas ativas → reconciliar", () => {
    expect(accessEmployee([{ id: 1, isActive: 0 }, { id: 2, isActive: 1 }])).toMatchObject({ id: 2 });
    expect(accessEmployee([{ id: 1, isActive: 1 }])).toMatchObject({ id: 1 });
    expect(accessEmployee([{ id: 1, isActive: 1 }, { id: 2, isActive: 1 }])).toBeNull();
    expect(accessEmployee([])).toBeNull();
    expect(read("server/cityAccess.ts")).toMatch(/const chosen = accessEmployee\(people\)/);
  });
  it("contas sem ficha parecidas: mesmo email ou dois nomes em comum; um nome só não chega", () => {
    const ficha = { fullName: "Ana Maria Sousa", emails: ["ana@empresa.pt", null] };
    expect(loginCandidateReason(ficha, { name: "x", email: " ANA@empresa.pt " })).toBe("mesmo email da ficha");
    expect(loginCandidateReason(ficha, { name: "Ana Sousa", email: "outra@gmail.com" })).toMatch(/nome parecido/);
    expect(loginCandidateReason(ficha, { name: null, email: "ana.sousa92@gmail.com" })).toMatch(/nome parecido \(ana, sousa\)/);
    expect(loginCandidateReason(ficha, { name: "Ana Costa", email: "ac@gmail.com" })).toBeNull();
    expect(loginCandidateReason({ fullName: "Ana", emails: [] }, { name: "Ana", email: null })).toBeNull();
  });
  it("Extras Dia continua 'Sem acesso' para o extra, mas com o atalho para a SUA disponibilidade", () => {
    const hint = noAccessHint("/extras-dia?dia=hoje", new Set(["/rh", "/disponibilidade"]));
    expect(hint).toMatchObject({ to: "/disponibilidade", label: "Abrir a minha disponibilidade" });
    expect(noAccessHint("/extras-dia", new Set(["/rh"]))).toBeNull();
    expect(noAccessHint("/logs", new Set(["/disponibilidade"]))).toBeNull();
    expect(read("client/src/components/DashboardLayout.tsx")).toMatch(/hint=\{noAccessHint\(location, new Set\(filteredItems\.map\(i => i\.path\)\)\)\}/);
  });
  it("menu: quem só vê o seu lê 'A minha ficha' e 'A minha disponibilidade'; o Perfil leva à disponibilidade", () => {
    const layout = read("client/src/components/DashboardLayout.tsx");
    expect(layout).toMatch(/path: "\/rh", anyOf: \["rh", "ficha"\], ownLabel: "A minha ficha"/);
    expect(layout).toMatch(/ownLabel: "A minha disponibilidade"/);
    expect(layout).toMatch(/return mods\.some\(m => seesBeyondOwn\(userRole, m\)\) \? item\.label : item\.ownLabel;/);
    expect(read("client/src/pages/ProfilePage.tsx")).toMatch(/label: "A minha disponibilidade".*navigate\("\/disponibilidade"\)/);
    expect(read("client/src/components/EmployeeAccessAvailability.tsx")).toMatch(/isMine && <Button size="sm" asChild><Link href=\{`\/disponibilidade\?week=\$\{weekStart\}`\}>/);
  });
});
