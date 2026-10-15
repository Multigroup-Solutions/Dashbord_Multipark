/**
 * 49c pelas rotas tRPC reais (BD falsa): a ficha PRÓPRIA inativa ou de
 * candidato abre (dados, disponibilidade); "Voltei"; aprovar/reativar repõe o
 * papel; o candidato que grava telefone/NIF de outra ficha gera um "possível
 * duplicado"; o pedido de ligação passa sem ficha nem cidade.
 */
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  load: vi.fn(),
  notify: vi.fn(async () => ({ recipients: [], emailed: 0, duplicates: 0, city: null })),
  updateEmployee: vi.fn(async () => undefined),
  toggleUserActive: vi.fn(async () => undefined),
  setMy: vi.fn(async () => ({ saved: 1, previous: [] })),
  flagDup: vi.fn(async () => 0),
  sql: [] as Array<{ sql: string; params: unknown[] }>,
  reply: (_q: string, _p: unknown[]): any[] => [],
  // conta → ficha (201 = inativo da ficha 21; 202 = candidato da ficha 22; 203 = ativo da ficha 23; 1 = admin)
  byUser: { 201: 21, 202: 22, 203: 23 } as Record<number, number>,
  fichas: {
    21: { id: 21, fullName: "Rui Inativo", email: "rui@x.pt", position: "extra", projectId: 50, userId: 201, isActive: 0, deactivationReason: "inatividade", loginBlocked: 0 },
    22: { id: 22, fullName: "Carla Candidata", email: "carla@gmail.com", position: "extra", projectId: null, userId: 202, isActive: 0, deactivationReason: "candidato", loginBlocked: 0, phone: null, nif: null },
    23: { id: 23, fullName: "Ana Ativa", email: "ana@x.pt", position: "extra", projectId: 50, userId: 203, isActive: 1, deactivationReason: null, loginBlocked: 0 },
    24: { id: 24, fullName: "Outra Pessoa", email: "outra@x.pt", position: "extra", projectId: 50, userId: null, isActive: 1, deactivationReason: null, loginBlocked: 0 },
  } as Record<number, any>,
}));

const dialect = new MySqlDialect();
const fakeDb = {
  execute: vi.fn(async (q: any) => {
    const r = dialect.sqlToQuery(q);
    s.sql.push(r);
    const rows = s.reply(r.sql, r.params);
    return [rows.length ? rows : Object.assign([], { insertId: 900, affectedRows: 1 })];
  }),
};

vi.mock("./cityAccess", async (original) => ({ ...(await original<object>()), loadCityAccess: s.load }));
vi.mock("./notify", () => ({ notify: s.notify }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => fakeDb,
  getUserModuleOverrides: async () => ({}),
  getUserPermissionOverrides: async () => ({}),
  getEmployeeByUserId: async (userId: number) => {
    const id = s.byUser[userId];
    return id ? { employee: s.fichas[id], project: null } : undefined;
  },
  getEmployeeById: async (id: number) => (s.fichas[id] ? { employee: s.fichas[id], project: null } : undefined),
  getUserById: async (id: number) => ({ id, name: "Conta", email: `conta${id}@gmail.com`, role: id === 1 ? "admin" : "user", isActive: 1 }),
  resolveProjectIds: async (id: number) => (id === 50 ? [50, 65] : [id]),
  logActivity: async () => undefined,
  updateEmployee: s.updateEmployee,
  toggleUserActive: s.toggleUserActive,
  countActiveSuperAdmins: async () => 1,
  findEmployeeByEmailOrName: async () => ({ id: 5, isActive: 1, userId: 77 }),
}));
vi.mock("./extrasAvailability", async (original) => ({ ...(await original<object>()), getMyWeek: async (employeeId: number, weekStart: string) => ({ employeeId, weekStart, weekEnd: "2026-10-18", submitted: false, days: [] }), setMyAvailability: s.setMy }));
vi.mock("./rhDocuments", async (original) => ({ ...(await original<object>()), licenceStatusesOrNull: async () => null }));
vi.mock("./appSettings", async (original) => ({ ...(await original<object>()), getSetting: async (k: string) => (k === "rh.missingCityAssignee" ? "Márcia Nunes" : null) }));
vi.mock("./accountLink", async (original) => {
  const real = await original<typeof import("./accountLink")>();
  return {
    ...real,
    flagCandidateDuplicates: s.flagDup,
    realLinkDeps: () => ({
      now: () => new Date("2026-10-08T10:00:00Z"), flagOn: async () => false, countRecent: async () => 0, expirePending: async () => undefined,
      insert: async () => 501, update: async () => undefined, get: async () => null, findMatches: async () => [], sendCode: async () => true,
      notifyRh: async () => undefined, linkTarget: async () => 0, log: async () => undefined, randomCode: () => "000000", hash: () => "h",
    }),
  };
});

import { appRouter } from "./routers";

const caller = (role: string, id: number, email = `conta${id}@gmail.com`) => appRouter.createCaller({ user: { id, role, email }, req: { headers: {} }, res: {} } as any);
const porto = { all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], cityNames: ["Porto"], projectIds: [50, 65], missingCostCenter: false };
const semCidade = { all: false, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: true };
const national = { all: true, defaultCityId: null, cityIds: [49, 50], projectIds: [48, 49, 50, 65], missingCostCenter: false };
const WEEK = "2026-10-12";
const days = [{ day: "2026-10-12", morning: true }];

beforeEach(() => {
  vi.clearAllMocks();
  s.sql = [];
  s.reply = () => [];
  s.load.mockImplementation(async (userId: number) => (userId === 1 ? national : s.byUser[userId] && s.fichas[s.byUser[userId]].projectId ? porto : semCidade));
});

describe("49c: a ficha própria INATIVA ou de CANDIDATO abre", () => {
  it.each([[201, 21], [202, 22]])("conta %s (utilizador): rh.me, a própria ficha e a disponibilidade; a de outro não", async (userId, fichaId) => {
    expect(await caller("user", userId).rh.me()).toMatchObject({ employee: { id: fichaId } });
    expect(await caller("user", userId).rh.byId({ id: fichaId })).toMatchObject({ employee: { id: fichaId } });
    expect(await caller("user", userId).extrasAvailability.myWeek({ weekStart: WEEK })).toMatchObject({ employeeId: fichaId });
    expect(await caller("user", userId).extrasAvailability.setMyWeek({ weekStart: WEEK, days })).toEqual({ saved: 1 });
    expect(s.setMy).toHaveBeenCalledWith(fichaId, WEEK, days, userId);
    await expect(caller("user", userId).rh.byId({ id: 24 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("o candidato (sem cidade) grava os próprios dados; telefone/NIF → procura possíveis duplicados (sem bloquear)", async () => {
    expect(await caller("user", 202).rh.update({ id: 22, phone: "912345678", nif: "123456789" })).toMatchObject({ success: true });
    expect(s.updateEmployee).toHaveBeenCalledWith(22, expect.objectContaining({ phone: "912345678", nif: "123456789" }));
    expect(s.flagDup).toHaveBeenCalledWith(22);
  });

  it("inativo/candidato não pica o ponto", async () => {
    await expect(caller("user", 201).rh.timeRecords.checkIn({ employeeId: 21 })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/ficha está inativa/) });
  });
});

describe("49c: 'Voltei, quero trabalhar'", () => {
  it("inativo → grava comebackRequestedAt, regista e avisa o RH da cidade + a pessoa do recrutamento (sem WhatsApp/email)", async () => {
    const r = await caller("user", 201).rh.comeback();
    expect(r.at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const upd = s.sql.find((q) => q.sql.startsWith("UPDATE employees SET comebackRequestedAt"));
    expect(upd?.params).toEqual([r.at, 21]);
    expect(s.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "employee_comeback", employeeId: 21, alsoUserIds: [77], link: "/extras-leads?tab=candidaturas" }));
    expect(s.sql.some((q) => /DELETE/i.test(q.sql))).toBe(false);
  });
  it("candidato, ativo ou sem ficha → não", async () => {
    await expect(caller("user", 202).rh.comeback()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller("extra", 203).rh.comeback()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller("user", 299).rh.comeback()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(s.notify).not.toHaveBeenCalled();
  });
});

describe("49c: aprovar o candidato / reativar quem voltou repõe o papel", () => {
  it("rh.setActive(true) numa ficha de candidato: ativa, limpa o motivo e o 'quer voltar', e a conta 'utilizador' passa a extra", async () => {
    s.reply = (q) => {
      if (q.startsWith("SELECT id, fullName, position, userId, isActive FROM employees")) return [{ id: 22, fullName: "Carla Candidata", position: "extra", userId: 202, isActive: 1 }];
      if (q.startsWith("SELECT u.id, u.role FROM users u")) return [{ id: 202, role: "user" }];
      return [];
    };
    const r = await caller("admin", 1).rh.setActive({ id: 22, isActive: true });
    expect(r).toMatchObject({ success: true, promotedRole: "extra", cascadedUser: true });
    expect(s.updateEmployee).toHaveBeenCalledWith(22, expect.objectContaining({ isActive: 1, deactivationReason: null, comebackRequestedAt: null }));
    expect(s.toggleUserActive).toHaveBeenCalledWith(202, true, null);
    const role = s.sql.find((q) => q.sql.startsWith("UPDATE users SET role"));
    expect(role?.sql).toContain("AND role = 'user'");
    expect(role?.params).toEqual(["extra", 202]);
  });
  it("conta com papel dado à mão (condutor) não muda", async () => {
    s.reply = (q) => {
      if (q.startsWith("SELECT id, fullName, position, userId, isActive FROM employees")) return [{ id: 21, fullName: "Rui", position: "extra", userId: 201, isActive: 1 }];
      if (q.startsWith("SELECT u.id, u.role FROM users u")) return [{ id: 201, role: "condutor" }];
      return [];
    };
    const r = await caller("admin", 1).rh.setActive({ id: 21, isActive: true });
    expect(r.promotedRole).toBeNull();
    expect(s.sql.some((q) => q.sql.startsWith("UPDATE users SET role"))).toBe(false);
  });
  it("'candidato' não se escolhe ao desativar", async () => {
    await expect(caller("admin", 1).rh.setActive({ id: 23, isActive: false, reason: "candidato" as any })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("49c: possíveis duplicados do candidato", () => {
  it("telefone igual ao de outra ficha → pedido pendente 'duplicate' para o RH (uma vez) e aviso; nada se apaga", async () => {
    const { flagCandidateDuplicates } = await vi.importActual<typeof import("./accountLink")>("./accountLink");
    let existing = false;
    s.reply = (q) => {
      if (q.startsWith("SELECT id, fullName, email, phone, nif, userId, isActive, deactivationReason, projectId FROM employees")) return [{ id: 22, fullName: "Carla Candidata", email: "carla@gmail.com", phone: "+351912345678", nif: null, userId: 202, isActive: 0, deactivationReason: "candidato", projectId: null }];
      if (q.startsWith("SELECT id, phone, personalPhone, nif FROM employees")) return [{ id: 24, phone: "912 345 678", personalPhone: null, nif: null }, { id: 30, phone: "933333333", personalPhone: null, nif: null }];
      if (q.startsWith("SELECT id, phone, nif, employeeId FROM driver_applications")) return [];
      if (q.startsWith("SELECT email FROM users")) return [{ email: "carla@gmail.com" }];
      if (q.startsWith("SELECT id FROM account_link_requests WHERE kind = 'duplicate'")) return existing ? [{ id: 1 }] : [];
      return [];
    };
    expect(await flagCandidateDuplicates(22)).toBe(1);
    const ins = s.sql.find((q) => q.sql.startsWith("INSERT INTO account_link_requests"));
    expect(ins?.sql).toContain("VALUES ('duplicate'");
    expect(ins?.params).toEqual(expect.arrayContaining([202, 22, 24]));
    expect(s.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "account_link_request", employeeId: 24 }));
    existing = true;
    expect(await flagCandidateDuplicates(22)).toBe(0);
    expect(s.sql.some((q) => /DELETE/i.test(q.sql))).toBe(false);
  });
  it("ficha que não é de candidato → nada", async () => {
    const { flagCandidateDuplicates } = await vi.importActual<typeof import("./accountLink")>("./accountLink");
    s.reply = (q) => (q.startsWith("SELECT id, fullName, email, phone, nif") ? [{ id: 23, isActive: 1, deactivationReason: null, phone: "+351912345678" }] : []);
    expect(await flagCandidateDuplicates(23)).toBe(0);
  });
});

describe("49c: 'Liga a tua conta' passa sem ficha nem cidade", () => {
  it("conta sem ficha → accountLink.request responde (mesma resposta, sem revelar nada)", async () => {
    const r = await caller("user", 299).accountLink.request({ claim: "antigo@gmail.com" });
    expect(r).toMatchObject({ requestId: 501, codeExpected: false });
    expect(r.message).toMatch(/O RH vai confirmar quem és/);
  });
  it("quem já tem ficha não faz pedidos", async () => {
    await expect(caller("extra", 203).accountLink.request({ claim: "antigo@gmail.com" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("a caixa do RH pede o módulo de recrutamento", async () => {
    await expect(caller("user", 299).accountLink.inbox()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
