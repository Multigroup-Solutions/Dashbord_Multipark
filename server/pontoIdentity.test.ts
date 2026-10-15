/**
 * Login × fichas (as horas que "desapareciam" em setembro de 2026): o login
 * ligava a conta a TODAS as fichas com o mesmo email e o ponto mudava de ficha a
 * meio do mês. `linkEmployeesToUserByEmail` com uma BD falsa: o que liga, o que
 * não liga, e que nunca parte o login.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ addAccountAlias: vi.fn(async () => {}), logActivity: vi.fn(async () => {}) }));
vi.mock("./db", () => ({ getDb: async () => null, logActivity: h.logActivity }));
vi.mock("./identityReconcile", () => ({ roleForPosition: () => "extra" }));
vi.mock("./employeeAliases", () => ({ addAccountAlias: h.addAccountAlias }));

const { linkEmployeesToUserByEmail, accountHasActiveFicha, activeFichaIdsOfAccount } = await import("./identity");

type Cand = { id: number; fullName: string; isActive: number };
function fakeDb(o: { candidates?: Cand[]; owned?: Array<{ id: number; fullName: string; userId: number }>; activeFicha?: boolean | "no-aliases-table"; activeIds?: number[] }) {
  const updates: Array<Record<string, unknown>> = [];
  const executes: number[] = [];
  const db: any = {
    select: () => {
      let ordered = false;
      const b: any = {
        from: () => b,
        where: () => b,
        orderBy: () => { ordered = true; return b; },
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(ordered ? (o.candidates ?? []) : (o.owned ?? [])).then(ok, ko),
      };
      return b;
    },
    execute: async () => {
      executes.push(1);
      if (o.activeFicha === "no-aliases-table") {
        if (executes.length === 1) throw new Error("Table 'employee_accounts' doesn't exist");
        return [[]];
      }
      if (o.activeIds) return [o.activeIds.map((id) => ({ id }))];
      return [o.activeFicha ? [{ x: 1 }] : []];
    },
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { updates.push(v); } }) }),
  };
  return { db, updates, executes };
}

beforeEach(() => { h.addAccountAlias.mockClear(); h.logActivity.mockClear(); });

describe("linkEmployeesToUserByEmail — uma pessoa = uma ficha", () => {
  it("a conta já está numa ficha ativa → não liga a ficha antiga com o mesmo email (era assim que o ponto mudava de ficha)", async () => {
    const f = fakeDb({ candidates: [{ id: 40, fullName: "Ariana (antiga)", isActive: 0 }], activeFicha: true });
    expect(await linkEmployeesToUserByEmail(f.db, 500, "ariana@x.pt")).toEqual([]);
    expect(f.updates).toEqual([]);
    expect(h.logActivity).not.toHaveBeenCalled();
  });
  it("conta sem ficha e várias fichas ativas com o email → liga só uma (antes ligava todas)", async () => {
    const f = fakeDb({ candidates: [{ id: 12, fullName: "A", isActive: 1 }, { id: 30, fullName: "A", isActive: 1 }, { id: 7, fullName: "A", isActive: 0 }], activeFicha: false });
    expect(await linkEmployeesToUserByEmail(f.db, 500, "a@x.pt")).toEqual([12]);
    expect(f.updates).toEqual([{ userId: 500 }]);
    expect(h.logActivity).toHaveBeenCalledTimes(1);
  });
  it("quem volta (só fichas inativas) ou o candidato → a mais recente, uma só", async () => {
    const f = fakeDb({ candidates: [{ id: 3, fullName: "B", isActive: 0 }, { id: 9, fullName: "B", isActive: 0 }], activeFicha: false });
    expect(await linkEmployeesToUserByEmail(f.db, 501, "b@x.pt")).toEqual([9]);
    expect(f.updates).toHaveLength(1);
  });
  it("conta nova de quem já tem ficha com outra conta → entra como conta EXTRA dessa ficha (como antes)", async () => {
    const f = fakeDb({ candidates: [], owned: [{ id: 15, fullName: "C", userId: 300 }], activeFicha: false });
    expect(await linkEmployeesToUserByEmail(f.db, 502, "c@x.pt")).toEqual([15]);
    expect(h.addAccountAlias).toHaveBeenCalledWith(15, 502);
    expect(f.updates).toEqual([]);
  });
  it("sem email ou sem conta → nada (nem lê a BD)", async () => {
    const f = fakeDb({});
    expect(await linkEmployeesToUserByEmail(f.db, 0, "c@x.pt")).toEqual([]);
    expect(await linkEmployeesToUserByEmail(f.db, 5, "")).toEqual([]);
    expect(f.executes).toHaveLength(0);
  });
});

describe("accountHasActiveFicha / activeFichaIdsOfAccount", () => {
  it("sem a tabela das contas extra → lê só a conta principal (nunca lança)", async () => {
    const f = fakeDb({ activeFicha: "no-aliases-table" });
    expect(await accountHasActiveFicha(f.db, 500)).toBe(false);
    expect(f.executes).toHaveLength(2);
  });
  it("ids das fichas ativas da conta (para o aviso na entrada do ponto)", async () => {
    const f = fakeDb({ activeIds: [10, 77] });
    expect(await activeFichaIdsOfAccount(f.db, 500)).toEqual([10, 77]);
  });
});
