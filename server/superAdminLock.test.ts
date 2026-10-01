import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

// Guarda ATÓMICA do último super_admin (P1, 1 out 2026). A BD falsa faz o que
// o SELECT … FOR UPDATE faz no MySQL: uma transação de cada vez sobre as
// contas super_admin. Com isso, dois pedidos ao mesmo tempo nunca tiram os
// dois últimos.

const state = vi.hoisted(() => ({
  users: new Map<number, { id: number; role: string; isActive: number }>(),
  statements: [] as string[],
  withDb: true,
}));

const dialect = new MySqlDialect();
const render = (q: any) => dialect.sqlToQuery(q).sql;

function fakeDb() {
  let queue: Promise<unknown> = Promise.resolve();
  const tx = {
    execute: async (q: any) => {
      const text = render(q);
      state.statements.push(text);
      if (/role = 'super_admin' AND isActive = 1/.test(text)) {
        return [[...state.users.values()].filter((u) => u.role === "super_admin" && u.isActive === 1).map((u) => ({ id: u.id }))];
      }
      const id = Number(dialect.sqlToQuery(q).params[0]);
      const u = state.users.get(id);
      return [u ? [{ ...u }] : []];
    },
  };
  return {
    // uma transação de cada vez (é o que a tranca FOR UPDATE garante)
    transaction: <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      const run = queue.then(() => fn(tx));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

vi.mock("./db", async (original) => {
  const db = fakeDb();
  return {
    ...(await original<object>()),
    getDb: async () => (state.withDb ? db : null),
    getUserById: async (id: number) => state.users.get(id),
    countActiveSuperAdmins: async () => [...state.users.values()].filter((u) => u.role === "super_admin" && u.isActive === 1).length,
  };
});

import { guardedAccountChange } from "./superAdminLock";
import { superAdminGuard } from "./userAdminRules";

const demote = (actorId: number, id: number) =>
  guardedAccountChange(id, (t, n) => superAdminGuard(actorId, t, "admin", n), async () => {
    // pausa a meio: sem a tranca, o outro pedido contava aqui "ainda há 2"
    await new Promise((r) => setTimeout(r, 5));
    state.users.get(id)!.role = "admin";
  });

beforeEach(() => {
  state.users = new Map([
    [1, { id: 1, role: "super_admin", isActive: 1 }],
    [2, { id: 2, role: "super_admin", isActive: 1 }],
    [3, { id: 3, role: "admin", isActive: 1 }],
  ]);
  state.statements = [];
  state.withDb = true;
});

describe("guardedAccountChange — último super_admin, atómico", () => {
  it("tranca as contas super_admin e o alvo ANTES de decidir e escrever", async () => {
    const write = vi.fn(async () => undefined);
    const r = await guardedAccountChange(2, (t, n) => superAdminGuard(1, t, "admin", n), write);
    expect(r).toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
    expect(state.statements[0]).toMatch(/FROM users WHERE role = 'super_admin' AND isActive = 1 ORDER BY id FOR UPDATE/);
    expect(state.statements[1]).toMatch(/FROM users WHERE id = \? FOR UPDATE/);
  });

  it("recusa tirar o último e não escreve", async () => {
    state.users.get(2)!.role = "admin";
    const write = vi.fn(async () => undefined);
    const r = await guardedAccountChange(1, (t, n) => superAdminGuard(3, t, null, n), write);
    expect(r).toBe("Não é possível remover o último super_admin ativo.");
    expect(write).not.toHaveBeenCalled();
  });

  it("dois pedidos ao mesmo tempo para despromover os DOIS super_admin: um passa, o outro é recusado", async () => {
    const [a, b] = await Promise.all([demote(3, 1), demote(3, 2)]);
    expect([a, b].filter((r) => r === null)).toHaveLength(1);
    expect([a, b]).toContain("Não é possível remover o último super_admin ativo.");
    expect([...state.users.values()].filter((u) => u.role === "super_admin")).toHaveLength(1);
  });

  it("decide com o alvo relido dentro da tranca (não com o que o pedido trazia)", async () => {
    // o alvo já não é super_admin quando a tranca é obtida → nada a proteger
    state.users.get(2)!.role = "admin";
    const decide = vi.fn((t: any, n: number) => superAdminGuard(1, t, "user", n));
    await guardedAccountChange(2, decide, async () => undefined);
    expect(decide).toHaveBeenCalledWith({ id: 2, role: "admin", isActive: 1 }, 1);
  });

  it("sem BD (testes, arranque) aplica a mesma regra sem tranca", async () => {
    state.withDb = false;
    state.users.get(2)!.role = "admin";
    const write = vi.fn(async () => undefined);
    expect(await guardedAccountChange(1, (t, n) => superAdminGuard(3, t, "admin", n), write)).toBe("Não é possível remover o último super_admin ativo.");
    expect(await guardedAccountChange(3, (t, n) => superAdminGuard(1, t, "user", n), write)).toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
