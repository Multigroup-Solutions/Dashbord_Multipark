import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import {
  buildUserDirectoryWhere,
  cityProjectIdsFrom,
  escapeLike,
  normalizeUserDirectoryPage,
  userDirectoryOrder,
} from "./usersDirectory";
import { cityScope } from "./cityScope";
import { resolveCityAccess } from "./cityAccess";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Sem BD nos testes: o middleware de cidades dá acesso total.
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));

const nodes = [
  { id: 48, name: "Multipark", level: "group", parentId: null },
  { id: 49, name: "Lisboa", level: "city", parentId: 48 },
  { id: 50, name: "Porto", level: "city", parentId: 48 },
  { id: 51, name: "Faro", level: "city", parentId: 48 },
  { id: 65, name: "Parque Porto", level: "project", parentId: 50 },
  { id: 70, name: "Airpark", level: "brand", parentId: 49 },
  { id: 71, name: "Parque Aeroporto", level: "project", parentId: 70 },
];
const cityIds = cityProjectIdsFrom(nodes);
const compile = (value: SQL) => new MySqlDialect().sqlToQuery(value);

describe("diretório de utilizadores — cidades", () => {
  it("cada cidade leva a sub-árvore inteira; o grupo não é de nenhuma", () => {
    expect(cityIds).toEqual({ lisboa: [49, 70, 71], porto: [50, 65], faro: [51] });
  });
});

describe("diretório de utilizadores — paginação", () => {
  it("usa 20 por defeito e prende limite/offset aos intervalos válidos", () => {
    expect(normalizeUserDirectoryPage()).toEqual({ limit: 20, offset: 0 });
    expect(normalizeUserDirectoryPage(500, -3)).toEqual({ limit: 100, offset: 0 });
    expect(normalizeUserDirectoryPage(0, 40)).toEqual({ limit: 1, offset: 40 });
    expect(normalizeUserDirectoryPage(12.7, 5.9)).toEqual({ limit: 12, offset: 5 });
    expect(normalizeUserDirectoryPage(Number.NaN, Number.NaN)).toEqual({ limit: 20, offset: 0 });
  });

  it("ordena sempre com desempate por id (páginas estáveis)", () => {
    for (const sort of ["recent", "name", "created", null] as const) {
      const order = userDirectoryOrder(sort).map((s) => compile(s).sql).join(", ");
      expect(order).toMatch(/`users`\.`id`/);
    }
    expect(compile(userDirectoryOrder("recent")[0]).sql).toContain("lastSignedIn");
  });
});

describe("diretório de utilizadores — filtros SQL", () => {
  it("sem filtros fica só o âmbito (acesso total → 1 = 1)", () => {
    const q = compile(buildUserDirectoryWhere({}, cityIds));
    expect(q.sql).toBe("1 = 1");
    expect(q.params).toEqual([]);
  });

  it("a pesquisa vai como parâmetro, em minúsculas e com curingas escapados", () => {
    expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
    const q = compile(buildUserDirectoryWhere({ search: "  Ana_100% " }, cityIds));
    expect(q.sql).not.toContain("Ana");
    expect(q.sql).toContain("LIKE ?");
    expect(q.params).toEqual(["%ana\\_100\\%%", "%ana\\_100\\%%", "%ana\\_100\\%%"]);
    // procura também no nome da ficha RH ligada
    expect(q.sql).toContain("dir_search.fullName");
  });

  it("papel, estado e último acesso são parametrizados", () => {
    const q = compile(buildUserDirectoryWhere({ role: "extra", status: "inactive", lastLogin: "30d" }, cityIds));
    expect(q.params).toEqual(["extra", 30]);
    expect(q.sql).toContain("`users`.`isActive` = 0");
    expect(q.sql).toContain("INTERVAL ? DAY");
    // contas criadas à mão (nunca entraram) não contam como "ativas há 30 dias"
    expect(q.sql).toContain("<> 'manual'");
    const never = compile(buildUserDirectoryWhere({ lastLogin: "never" }, cityIds));
    expect(never.sql).toContain("= 'manual'");
    expect(never.params).toEqual([]);
  });

  it("cidade = fichas ligadas nessa cidade; 'none' = nenhuma ficha em cidade conhecida", () => {
    const porto = compile(buildUserDirectoryWhere({ city: "porto" }, cityIds));
    expect(porto.params).toEqual([50, 65]);
    expect(porto.sql).toContain("dir_emp.userId = `users`.`id`");
    const none = compile(buildUserDirectoryWhere({ city: "none" }, cityIds));
    expect(none.sql).toContain("NOT (EXISTS");
    expect(none.params).toEqual([49, 70, 71, 50, 65, 51]);
    const empty = compile(buildUserDirectoryWhere({ city: "faro" }, { lisboa: [], porto: [], faro: [] }));
    expect(empty.sql).toContain("1 = 0");
  });

  it("com ficha / sem ficha RH", () => {
    expect(compile(buildUserDirectoryWhere({ employee: "with" }, cityIds)).sql).toContain("EXISTS (SELECT 1 FROM employees dir_link");
    expect(compile(buildUserDirectoryWhere({ employee: "without" }, cityIds)).sql).toContain("NOT (EXISTS (SELECT 1 FROM employees dir_link");
  });

  it("o âmbito de cidades do visitante aplica-se sempre, também às subconsultas", () => {
    const porto = resolveCityAccess(50, nodes);
    cityScope.run(porto, () => {
      const q = compile(buildUserDirectoryWhere({ city: "porto", search: "rui" }, cityIds));
      // userScope (conta tem ficha no Porto) + âmbito dentro da pesquisa e do filtro de cidade
      expect(q.sql).toContain("city_employee.userId = `users`.`id`");
      expect(q.params.filter((p) => p === 50).length).toBeGreaterThanOrEqual(3);
    });
  });
});

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;
function ctx(role: string): TrpcContext {
  const user = {
    id: 99, openId: "t", email: "t@example.com", name: "T", loginMethod: "google", role,
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  } as unknown as AuthenticatedUser;
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

describe("users.search / users.summary — guardas", () => {
  it("quem vê utilizadores recebe uma página (sem BD: vazia, com os limites aplicados)", async () => {
    const caller = appRouter.createCaller(ctx("admin"));
    await expect(caller.users.search({ limit: 20, offset: 40, city: "porto" })).resolves.toMatchObject({ rows: [], total: 0, limit: 20, offset: 40 });
    await expect(caller.users.summary()).resolves.toMatchObject({ total: 0 });
  });

  it("utilizador comum é bloqueado", async () => {
    const caller = appRouter.createCaller(ctx("user"));
    await expect(caller.users.search({})).rejects.toThrow();
    await expect(caller.users.summary()).rejects.toThrow();
  });

  it("recusa limites fora do intervalo", async () => {
    const caller = appRouter.createCaller(ctx("admin"));
    await expect(caller.users.search({ limit: 1000 })).rejects.toThrow();
    await expect(caller.users.search({ offset: -1 })).rejects.toThrow();
  });
});
