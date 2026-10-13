/**
 * Telemóveis pessoais (13 out 2026) e o nome no Zello (ZELLO_PDA_NAMES): um
 * PDA que passou a telemóvel pessoal nunca volta a ter nome de PDA no Zello
 * (fica com o nome do dono); os PDAs partilhados ficam como sempre. BD falsa
 * (lê o SQL gerado), Zello e interruptor falsos.
 */
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  flagOn: true,
  pdas: [] as any[],
  personal: [] as any[],
  holders: new Map<number, string>(),
  writes: [] as Array<{ user: string; name: string }>,
}));

vi.mock("./_core/featureFlags", async (original) => ({
  ...(await original<object>()),
  ensureFeatureFlagOverrides: async () => undefined,
  isFeatureEnabled: (name: string) => (name === "ZELLO_PDA_NAMES" ? m.flagOn : false),
}));
vi.mock("./zello", async (original) => ({
  ...(await original<object>()),
  isZelloConfigured: () => true,
  setZelloUserFullName: async (user: string, name: string) => { m.writes.push({ user, name }); },
}));
vi.mock("./db", async (original) => {
  const dialect = new MySqlDialect();
  return {
    ...(await original<object>()),
    getDb: async () => ({
      execute: async (q: any) => {
        const { sql, params } = dialect.sqlToQuery(q);
        if (/FROM pdas WHERE id = /.test(sql)) return [m.pdas.filter((p) => p.id === params[0])];
        if (/FROM personal_devices WHERE convertedFromPdaId = /.test(sql)) return [m.personal.filter((d) => d.convertedFromPdaId === params[0] && d.status === "active").map(() => ({ x: 1 }))];
        if (/FROM pda_checkins c JOIN employees/.test(sql)) return [m.holders.has(params[0] as number) ? [{ fullName: m.holders.get(params[0] as number) }] : []];
        return [[]];
      },
    }),
  };
});

import { syncPdaZelloName, syncPersonalZelloName } from "./pdaZelloName";

beforeEach(() => {
  Object.assign(m, { flagOn: true, pdas: [], personal: [], holders: new Map(), writes: [] });
  m.pdas.push({ id: 7, name: "PDA 12", zelloUsername: "Extra12", status: "active" });
  m.pdas.push({ id: 9, name: "Telemóvel Jorge", zelloUsername: "Jorge", status: "inactive" });
  m.pdas.push({ id: 10, name: "PDA 20", zelloUsername: "Extra20", status: "inactive" });
  m.personal.push({ id: 1, convertedFromPdaId: 9, status: "active" });
});

describe("nome no Zello e telemóveis pessoais", () => {
  it("o PDA convertido em telemóvel pessoal nunca volta a ter nome de PDA (p. ex. na saída do ponto logo a seguir)", async () => {
    expect(await syncPdaZelloName(9)).toBe("skip");
    expect(m.writes).toEqual([]);
  });
  it("os PDAs partilhados ficam como sempre: com alguém → \"PDA 12 · Nome\"; retirado sem conversão → \"PDA 20\"", async () => {
    m.holders.set(7, "Rui Manuel Alves Santos");
    expect(await syncPdaZelloName(7)).toBe("ok");
    expect(await syncPdaZelloName(10)).toBe("ok");
    expect(m.writes).toEqual([{ user: "Extra12", name: "PDA 12 · Rui Santos" }, { user: "Extra20", name: "PDA 20" }]);
  });
  it("conversão desfeita (telemóvel pessoal inativo): o PDA volta a ser tratado como PDA", async () => {
    m.personal[0].status = "inactive";
    expect(await syncPdaZelloName(9)).toBe("ok");
    expect(m.writes).toEqual([{ user: "Jorge", name: "Telemóvel Jorge" }]);
  });
  it("a conta Zello do telemóvel convertido fica com o nome do dono; desligado, nada se escreve", async () => {
    expect(await syncPersonalZelloName("Jorge", "Jorge Manuel Tabuada")).toBe("ok");
    expect(m.writes).toEqual([{ user: "Jorge", name: "Jorge Tabuada" }]);
    m.flagOn = false;
    expect(await syncPersonalZelloName("Jorge", "Jorge Manuel Tabuada")).toBe("skip");
    expect(await syncPersonalZelloName("  ", "Jorge")).toBe("skip");
    expect(m.writes).toHaveLength(1);
  });
});
