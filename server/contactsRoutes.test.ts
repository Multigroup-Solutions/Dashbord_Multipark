import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ load: vi.fn(), search: vi.fn(), queries: [] as string[] }));
vi.mock("./cityAccess", async (original) => ({ ...(await original<object>()), loadCityAccess: f.load }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getDb: async () => ({ execute: async () => [[], []] }),
  getUserModuleOverrides: async () => ({}),
}));
vi.mock("./contactsSearch", async (original) => ({ ...(await original<object>()), searchContacts: f.search }));

import { appRouter } from "./routers";
import { cityScope } from "./cityScope";
import { serviceDisplayName } from "../shared/contacts";

const caller = (role = "supervisor", id = 123) => appRouter.createCaller({ user: { id, role }, req: { headers: {} }, res: {} } as any);

beforeEach(() => {
  vi.clearAllMocks();
  f.load.mockResolvedValue({ all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false });
  f.search.mockImplementation(async () => ({ kinds: [], groups: [], scope: cityScope.getStore() }));
});

describe("Contactos — rotas e permissões", () => {
  it("pesquisa corre dentro da cidade da conta", async () => {
    const r: any = await caller().contacts.search({ q: "ana" });
    expect(r.scope).toMatchObject({ projectIds: [50, 65] });
    expect(f.search).toHaveBeenCalledTimes(1);
  });

  it.each(["user", "extra", "condutor"])("%s não entra nos Contactos", async (role) => {
    await expect(caller(role).contacts.search({ q: "ana" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(role).contacts.kinds()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.search).not.toHaveBeenCalled();
  });

  it("definições: admin vê, só o super admin grava", async () => {
    await expect(caller("backoffice").contacts.settings.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const cfg = { directory: { enabled: false, adminEmail: "" }, service: { roles: ["supervisor"], retentionDays: 2, maxPerUser: 100 }, partners: { enabled: false, roles: [] } } as any;
    await expect(caller("admin").contacts.settings.save(cfg)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("grupo Serviço: o condutor (e o TL) nunca — nem o super admin o consegue gravar", async () => {
    for (const roles of [["condutor"], ["team_leader"], ["condutor", "supervisor"]]) {
      const cfg = { directory: { enabled: false, adminEmail: "" }, service: { roles, retentionDays: 2, maxPerUser: 100 }, partners: { enabled: false, roles: [] } } as any;
      await expect(caller("super_admin").contacts.settings.save(cfg)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("diretório: 'Atualizar agora' só admin", async () => {
    await expect(caller("supervisor").contacts.directory.syncNow()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("criar a partir do Google exige editar o módulo de destino", async () => {
    // team leader: clientes city:ve (pode), leads de extras city:ve (pode); o contacto não é dele → não encontrado
    await expect(caller("team_leader").contacts.google.create({ id: 1, as: "client" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller("frontoffice").contacts.google.create({ id: 1, as: "extra_lead" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("nome no telemóvel: nome + matrícula, sem mais dados", () => {
    expect(serviceDisplayName({ clientFirstName: " Ana ", clientLastName: "Silva", licensePlate: "aa-00-bb" })).toBe("Cliente Multipark: Ana Silva (AA-00-BB)");
    expect(serviceDisplayName({})).toBe("Cliente Multipark: sem nome");
  });
});
