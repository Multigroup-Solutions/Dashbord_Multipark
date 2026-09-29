import { describe, expect, it, vi } from "vitest";
vi.mock("./db", () => ({ getDb: async () => null }));
import { agentGroup, suggestForAgents } from "./agentSuggestions";
import { cleanAgentName } from "../shared/agentIdentity";

describe("sugestões para os agentes por ligar", () => {
  const emps = [
    { id: 1, fullName: "Bruno Filipe Meireles", emails: ["bruno.meireles2001@gmail.com"], hasAgent: false },
    { id: 2, fullName: "Noémia Rodrigues", emails: [], hasAgent: false },
    { id: 3, fullName: "Ana Costa", emails: [], hasAgent: false },
    { id: 4, fullName: "Ana Costa", emails: [], hasAgent: false },
  ];
  const partnerships = [
    { id: 10, name: "Guard Park Valet", contactEmail: "reservas@guardpark.pt" },
    { id: 11, name: "Bestravel Maia", contactEmail: null },
    { id: 12, name: "Top Parking", contactEmail: "geral@topparking.pt" },
  ];
  it("equipa: pelo email, senão pelo nome sem a cidade; nome repetido não sugere", () => {
    const r = suggestForAgents([
      { agentName: "Bruno Meireles - PORTO", email: "bruno.meireles2001@gmail.com" },
      { agentName: "Noemia Rodrigues (Porto)", email: null },
      { agentName: "Ana Costa", email: null },
    ], emps, partnerships);
    expect(r[0]).toMatchObject({ group: "equipa", suggestion: { type: "ficha", employeeId: 1, by: "email" } });
    expect(r[1]).toMatchObject({ group: "equipa", suggestion: { type: "ficha", employeeId: 2, by: "nome" } });
    expect(r[2].suggestion).toBeNull();
  });
  it("parceiros e agências: pelo domínio do email ou pelo nome da parceria", () => {
    const r = suggestForAgents([
      { agentName: "João Paulo Oliveira", email: "geral@guardpark.pt", partnerOnly: true },
      { agentName: "Bestravel Maia", email: null },
      { agentName: "Top geral", email: "geral@topparking.pt" },
      { agentName: "Viagens & Cia", email: null },
    ], emps, partnerships);
    expect(r[0]).toMatchObject({ group: "parceiro", suggestion: { type: "parceiro", partnershipId: 10, by: "email" } });
    expect(r[1]).toMatchObject({ group: "parceiro", suggestion: { type: "parceiro", partnershipId: 11, by: "nome" } });
    expect(r[2]).toMatchObject({ group: "parceiro", suggestion: { type: "parceiro", partnershipId: 12 } });
    expect(r[3]).toMatchObject({ group: "parceiro", suggestion: null });
  });
  it("grupo e nome limpo", () => {
    expect(agentGroup({ agentName: "Ana", email: null, partnerOnly: true })).toBe("parceiro");
    expect(agentGroup({ agentName: "Ana", email: "ana@gmail.com" })).toBe("equipa");
    expect(cleanAgentName("Bruno Meireles - PORTO")).toBe("Bruno Meireles");
    expect(cleanAgentName("Luís Moraes1")).toBe("Luís Moraes");
    expect(cleanAgentName("Noemia Rodrigues (Porto)")).toBe("Noemia Rodrigues");
  });
});
