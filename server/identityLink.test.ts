import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: async () => null }));

import { nameKeys, normName, planAgentIdFill, planNameAttach, type EmpLite } from "./identityLink";

const emp = (id: number, fullName: string, o: Partial<EmpLite> = {}): EmpLite => ({ id, fullName, active: true, agentName: null, agentUserId: null, ...o });

describe("nomes", () => {
  it("normaliza acentos, maiúsculas e pontuação", () => expect(normName("  João  Tercitano-Silva ")).toBe("joao tercitano silva"));
  it("chaves: completo e primeiro + último", () => {
    expect(nameKeys("Luís Miguel Tercitano")).toEqual(["luis miguel tercitano", "luis tercitano"]);
    expect(nameKeys("Ana Silva")).toEqual(["ana silva"]);
  });
});

describe("completar o id do agente das fichas ligadas por nome", () => {
  it("só quando o nome é de um único agente livre", () => {
    const r = planAgentIdFill(
      [emp(1, "Ana", { agentName: "Ana Silva" }), emp(2, "Rui", { agentName: "Rui Costa" }), emp(3, "Eva", { agentName: "Eva Lima", agentUserId: "a9" })],
      [
        { id: "a1", name: "Ana Silva", count: 5 },
        { id: "a2", name: "Rui Costa", count: 3 },
        { id: "a3", name: "rui costa", count: 1 }, // dois agentes com o mesmo nome → não mexe
      ],
    );
    expect(r).toEqual([{ employeeId: 1, agentUserId: "a1" }]);
  });
  it("não rouba um id já ligado a outra ficha", () => {
    expect(planAgentIdFill([emp(1, "Ana", { agentName: "Ana Silva" }), emp(2, "X", { agentUserId: "a1" })], [{ id: "a1", name: "Ana Silva", count: 1 }])).toEqual([]);
  });
});

describe("ligar agentes pelo nome", () => {
  it("formato Multipark (primeiro + último) contra o nome completo da ficha", () => {
    const r = planNameAttach([{ id: "a1", name: "Luís Tercitano", count: 10 }], [emp(7, "Luís Miguel Tercitano")]);
    expect(r).toEqual([{ employeeId: 7, agentUserId: "a1", agentName: "Luís Tercitano" }]);
  });
  it("ambíguo (duas fichas com o mesmo nome) ou ficha já com agente → não liga", () => {
    expect(planNameAttach([{ id: "a1", name: "Ana Silva", count: 1 }], [emp(1, "Ana Silva"), emp(2, "Ana Maria Silva")])).toEqual([]);
    expect(planNameAttach([{ id: "a1", name: "Ana Silva", count: 1 }], [emp(1, "Ana Silva", { agentName: "Outro" })])).toEqual([]);
  });
  it("agente já ligado (por id ou nome) não volta a ser ligado; fichas inativas não contam", () => {
    expect(planNameAttach([{ id: "a1", name: "Ana Silva", count: 1 }], [emp(1, "Ana Silva"), emp(2, "Zé", { agentUserId: "a1" })])).toEqual([]);
    expect(planNameAttach([{ id: "a2", name: "Rui Costa", count: 1 }], [emp(3, "Rui Costa", { active: false })])).toEqual([]);
  });
});
