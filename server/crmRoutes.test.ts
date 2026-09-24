import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  load: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
  denied: false,
}));
vi.mock("./cityAccess", async original => ({
  ...(await original<object>()),
  loadCityAccess: f.load,
}));
vi.mock("./db", async original => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () =>
    f.denied ? { "finance.view_totals": "deny" } : {},
}));
vi.mock("./crm", () => ({
  listCrmCustomers: f.list,
  getCrmCustomer: f.detail,
}));
import { appRouter } from "./routers";
import { cityScope } from "./cityScope";
const caller = (role = "backoffice") =>
  appRouter.createCaller({
    user: { id: 123, role },
    req: { headers: {} },
    res: {},
  } as any);
beforeEach(() => {
  vi.clearAllMocks();
  f.denied = false;
  f.load.mockResolvedValue({
    all: false,
    defaultCityId: 50,
    cityName: "Porto",
    cityIds: [50],
    projectIds: [50, 65],
    missingCostCenter: false,
  });
  f.list.mockImplementation(async () => ({ scope: cityScope.getStore() }));
});
describe("autorização CRM", () => {
  it("consulta sem filtros mantém a cidade da conta", async () =>
    expect(await caller().clients.crmList({})).toMatchObject({
      scope: { projectIds: [50, 65] },
    }));
  it("recusa outra cidade antes da consulta CRM", async () => {
    await expect(
      caller().clients.crmList({ projectId: 49 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.list).not.toHaveBeenCalled();
  });
  it("extras não podem pesquisar clientes", async () => {
    await expect(caller("extra").clients.crmList({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(f.list).not.toHaveBeenCalled();
  });
  it.each(["frontoffice", "backoffice"])(
    "não expõe dinheiro sem autorização: %s",
    async role => {
      f.denied = true;
      await caller(role).clients.crmList({});
      expect(f.list).toHaveBeenCalledWith(expect.anything(), false);
    }
  );
  it("valida chave e paginação antes de consultar um cliente", async () => {
    await expect(
      caller().clients.crmDetail({ key: "outro-email" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().clients.crmList({ page: 0 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(f.detail).not.toHaveBeenCalled();
  });
});
