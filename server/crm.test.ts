import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
const f = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("./db", () => ({ getDb: async () => ({ execute: f.execute }) }));
import { cityScope } from "./cityScope";
import {
  crmCte,
  getCrmCustomer,
  listCrmCustomers,
  mapCrmCustomer,
} from "./crm";
import {
  isCrmCancelled,
  isCrmCompleted,
  normalizeCrmEmail,
} from "../shared/crm";
const porto = {
  all: false,
  defaultCityId: 50,
  cityName: "Porto",
  cityIds: [50],
  projectIds: [50, 65],
  missingCostCenter: false,
};
const row = {
  contactKey: "a".repeat(64),
  contactEmail: "teste@example.com",
  contactName: "Pessoa teste",
  nameCount: 1,
  bookingCount: 6,
  completed: 3,
  cancelled: 2,
  upcoming: 1,
  visitsLastYear: 3,
  firstVisitText: "2026-01-01T10:00:00Z",
  lastVisitText: "2026-03-01T10:00:00Z",
  nextVisitText: "2026-12-01T10:00:00Z",
  averageGapDays: 29.5,
  stayValue: "120.30",
  currencyCount: 1,
  currency: "EUR",
  missingAmounts: 0,
};
const input = {
  search: "",
  segment: "all" as const,
  sort: "recent" as const,
  page: 1,
  inactiveDays: 180,
};
const dialect = new MySqlDialect();
beforeEach(() => f.execute.mockReset().mockResolvedValue([[], []]));
describe("identidade e métricas do CRM", () => {
  it("normaliza espaços/maiúsculas sem unir pontos ou sufixos diferentes", () => {
    expect(normalizeCrmEmail("  Joao+porto@Example.com ")).toBe(
      "joao+porto@example.com"
    );
    expect(normalizeCrmEmail("jo.ao@example.com")).not.toBe(
      normalizeCrmEmail("joao@example.com")
    );
  });
  it.each(["", null, "sem-email", "a b@example.com", "@example.com"])(
    "não cria identidade para %s",
    email => expect(normalizeCrmEmail(email)).toBeNull()
  );
  it("não confunde estados futuros, intermédios e cancelados com estadias concluídas", () => {
    expect(isCrmCompleted("checked_out")).toBe(true);
    for (const state of [
      "CONFIRMED",
      "CHECKED_IN",
      "PENDING_CHECKOUT",
      "CANCELLED",
      null,
    ])
      expect(isCrmCompleted(state)).toBe(false);
    expect(isCrmCancelled("CANCELLED")).toBe(true);
  });
  it("mantém contagens separadas e converte valores decimais", () => {
    expect(mapCrmCustomer(row, true)).toMatchObject({
      completed: 3,
      cancelled: 2,
      upcoming: 1,
      stayValue: 120.3,
      averageValue: 40.1,
      needsReview: false,
    });
  });
  it("sinaliza um email com vários nomes em vez de fingir identidade confirmada", () =>
    expect(mapCrmCustomer({ ...row, nameCount: 2 }, true).needsReview).toBe(
      true
    ));
  it.each([{ currencyCount: 2 }, { missingAmounts: 1 }, { currencyCount: 0 }])(
    "não soma moedas ou preenche lacunas como zero",
    change =>
      expect(mapCrmCustomer({ ...row, ...change }, true).stayValue).toBeNull()
  );
  it("retira todos os indicadores monetários sem permissão", () =>
    expect(mapCrmCustomer(row, false)).toMatchObject({
      stayValue: null,
      averageValue: null,
      currency: null,
      missingAmounts: 0,
    }));
});
describe("consultas do CRM", () => {
  it("nega acesso sem contexto autenticado antes de consultar a BD", async () => {
    await expect(listCrmCustomers(input, true)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("obriga a filtrar antes de agrupar e usa parâmetros para pesquisa/id", () =>
    cityScope.run(porto, () => {
      const q = dialect.sqlToQuery(
        crmCte(
          "x%' OR 1=1 --",
          new Date("2026-09-24T10:00:00Z"),
          "b".repeat(64)
        )
      );
      expect(q.sql.indexOf("b.projectId IN")).toBeLessThan(
        q.sql.indexOf("GROUP BY contactEmail")
      );
      expect(q.params).toContain(65);
      expect(q.params).toContain("b".repeat(64));
      expect(q.sql).not.toContain("OR 1=1 --");
      expect(q.sql).toContain("= 'CHECKED_OUT'");
      expect(q.sql).toContain("CASE WHEN completedStay THEN totalPrice");
    }));
  it("rejeita ordenação financeira negada sem executar a consulta", async () => {
    await expect(
      cityScope.run(porto, () =>
        listCrmCustomers({ ...input, sort: "value" }, false)
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("pagina a lista mas mantém os totais de todas as correspondências", async () => {
    f.execute
      .mockResolvedValueOnce([[row], []])
      .mockResolvedValueOnce([[{ total: 70 }], []])
      .mockResolvedValueOnce([
        [{ contacts: 100, returning: 40, review: 2 }],
        [],
      ])
      .mockResolvedValueOnce([[{ n: 3 }], []]);
    const result = await cityScope.run(porto, () =>
      listCrmCustomers({ ...input, page: 2 }, true)
    );
    expect(result).toMatchObject({
      page: 2,
      pageSize: 25,
      total: 70,
      overview: { contacts: 100, missingEmailBookings: 3 },
    });
    const query = dialect.sqlToQuery(f.execute.mock.calls[0][0]);
    expect(query.params.slice(-2)).toEqual([25, 25]);
  });
  it("devolve NOT_FOUND quando a chave não existe na cidade permitida", async () => {
    await expect(
      cityScope.run(porto, () => getCrmCustomer("a".repeat(64), 1, true))
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("protege detalhes, contactos, viaturas, meses e interações e oculta dinheiro", async () => {
    f.execute
      .mockResolvedValueOnce([[row], []])
      .mockResolvedValueOnce([
        [{ externalId: "b", value: "40.10", currency: "EUR" }],
        [],
      ])
      .mockResolvedValueOnce([
        [
          {
            month: "2026-03",
            value: "40.10",
            currency: "EUR",
            visits: 1,
            missing: 0,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []]);
    const detail = await cityScope.run(porto, () =>
      getCrmCustomer("a".repeat(64), 1, false)
    );
    expect(detail.bookings[0].value).toBeNull();
    expect(detail.monthly[0].value).toBeNull();
    expect(detail.customer.stayValue).toBeNull();
    for (const call of f.execute.mock.calls) {
      const q = dialect.sqlToQuery(call[0]);
      expect(q.params).toContain(65);
      expect(q.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER)\b/);
    }
  });
});
