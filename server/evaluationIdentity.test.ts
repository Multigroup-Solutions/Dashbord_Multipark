import { describe, expect, it } from "vitest";
import { agentKeyOf, buildEvaluationIdentity, normName, shortNameOf } from "./evaluationIdentity";

const identity = () => buildEvaluationIdentity({
  employees: [
    { id: 1, fullName: "Gelson Manuel Leão Sousa", userId: 10, multiparkAgentName: null, multiparkAgentUserId: null },
    { id: 2, fullName: "Ana Rita Costa", userId: 20, multiparkAgentName: "Ana C", multiparkAgentUserId: "777" },
    { id: 3, fullName: "João Silva", userId: null, multiparkAgentName: null, multiparkAgentUserId: null },
    { id: 4, fullName: "João Pedro Silva", userId: null, multiparkAgentName: null, multiparkAgentUserId: null },
    { id: 5, fullName: "Rui Alves", userId: null, multiparkAgentName: null, multiparkAgentUserId: null },
  ],
  agentAliases: [{ agentUserId: "888", employeeId: 5, agentName: "Rui (tablet)" }],
  accountAliases: [{ userId: 99, employeeId: 1 }, { userId: 20, employeeId: 5 }],
  partners: [{ agentName: "Parceiro X", partnerName: "X Lda" }],
  ignoredAgentNames: ["sistema"],
});

describe("identidade da avaliação (condutor → ficha)", () => {
  it("nomes: sem acentos, minúsculas, espaços simples; nome curto = 1.º + último", () => {
    expect(normName("  Gélson   SOUSA ")).toBe("gelson sousa");
    expect(shortNameOf("Gelson Manuel Leão Sousa")).toBe("Gelson Sousa");
    expect(shortNameOf("Madonna")).toBe("Madonna");
    expect(agentKeyOf(" Zé Ninguém ")).toBe("agent:zé ninguém");
  });

  it("id do agente ganha ao nome; agentes extra (aliases) ligam à ficha", () => {
    expect(identity().agent("777", "outro nome")).toMatchObject({ kind: "colaborador", employeeId: 2 });
    expect(identity().agent("888", null)).toMatchObject({ kind: "colaborador", employeeId: 5 });
    expect(identity().agent(null, "ana c")).toMatchObject({ kind: "colaborador", employeeId: 2 });
  });

  it("nome curto (último recurso) e nome completo, com ou sem acentos", () => {
    expect(identity().agent(null, "Gelson Sousa")).toMatchObject({ kind: "colaborador", employeeId: 1 });
    expect(identity().agent(null, "gelson manuel leao sousa")).toMatchObject({ kind: "colaborador", employeeId: 1 });
  });

  it("homónimos no nome curto não ligam a ninguém (ficam por ligar)", () => {
    // "João Silva" e "João Pedro Silva" → ambos "joao silva" em nome curto
    const r = identity().agent(null, "João Silva");
    // o nome completo "João Silva" é único → liga à ficha 3
    expect(r).toMatchObject({ kind: "colaborador", employeeId: 3 });
    const identity2 = buildEvaluationIdentity({
      employees: [
        { id: 3, fullName: "João Carlos Silva", userId: null, multiparkAgentName: null, multiparkAgentUserId: null },
        { id: 4, fullName: "João Pedro Silva", userId: null, multiparkAgentName: null, multiparkAgentUserId: null },
      ],
      agentAliases: [], accountAliases: [],
    });
    expect(identity2.agent(null, "João Silva").kind).toBe("por_ligar");
  });

  it("ignorados e parceiros não contam para ninguém", () => {
    expect(identity().agent(null, "Sistema").kind).toBe("ignorado");
    expect(identity().agent(null, "Parceiro X").kind).toBe("parceiro");
    expect(identity().agent(null, "Desconhecido Total").kind).toBe("por_ligar");
  });

  it("utilizador → ficha: conta principal ganha às contas extra", () => {
    const id = identity();
    expect(id.user(10)).toBe(1);
    expect(id.user(99)).toBe(1);
    expect(id.user(20)).toBe(2); // principal da ficha 2, não o alias para a 5
    expect(id.user(12345)).toBeNull();
    expect(id.user(null)).toBeNull();
  });

  it("linha da escala: usa a ficha; sem ficha, liga pelo nome completo; chave do nome curto", () => {
    const id = identity();
    expect(id.assignment({ employeeId: 2, personName: "Ana Rita Costa" })).toEqual({ employeeId: 2, agentKey: "agent:ana costa" });
    expect(id.assignment({ employeeId: null, personName: "Rui Alves" })).toEqual({ employeeId: 5, agentKey: "agent:rui alves" });
    expect(id.assignment({ employeeId: null, personName: "Extra Novo Sem Ficha" })).toEqual({ employeeId: null, agentKey: "agent:extra ficha" });
  });
});
