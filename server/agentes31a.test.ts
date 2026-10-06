/**
 * P3 lote 31a — Agentes × pessoas (Jorge, 6 out 2026): "todos os agentes da
 * Multipark têm de estar em algum lado… cada agente tem que ser um utilizador
 * e cada utilizador tem que ter um agente."
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { crossCheckAgents, crossCheckSummary, daysOverlap, nameScore, phoneTail, type XAgent, type XInput, type XPerson } from "../shared/agentCrossCheck";
import { buildAgentDaysSql, buildAgentRegistrySql, mapRegistryRow } from "./multiparkDb/agentRegistry";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const agent = (o: Partial<XAgent> & { userId: string }): XAgent => ({
  name: null, names: [], email: null, active: true, roles: ["DRIVER"], parks: [], cities: ["lisboa"], total: 10, lastSeen: "2026-10-05T10:00:00.000Z",
  excluded: null, partnerLike: false, mpPartner: null, ...o, names: o.names ?? (o.name ? [o.name] : []),
});
const person = (o: Partial<XPerson> & { employeeId: number; name: string }): XPerson => ({
  emails: [], phones: [], city: "lisboa", active: true, position: "extra", userId: null, agentIds: [], legacyAgentName: null, zelloUsernames: [], ...o,
});
const days = (...d: string[]) => new Set(d);
const D = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];

function input(o: Partial<XInput>): XInput {
  return {
    agents: [], persons: [], users: [], partnerships: [], partnerByAgentName: new Map(), ignoredAgentNames: new Set(), zello: [],
    agentDays: new Map(), zelloDays: new Map(), escalaDaysByEmployee: new Map(), escalaDaysByName: new Map(), ...o,
  };
}

describe("31a — nomes, dias e telefone", () => {
  it("nome igual, parecido (primeiro + apelido) e só o primeiro", () => {
    expect(nameScore("Gelson Leao", "Gelson Leão").score).toBe(60);
    expect(nameScore("Bruno Meireles", "Bruno Filipe Meireles Silva")).toEqual({ score: 45, reason: "nome parecido" });
    expect(nameScore("Jhonatas Dias - Porto", "Jhonatas Dias")).toEqual({ score: 60, reason: "mesmo nome" });
    expect(nameScore("Gelson", "Gelson Leão").score).toBe(15);
    expect(nameScore("Carlos Silva", "Carla Silva").score).toBe(0);
  });

  it("dias em comum (Jaccard) e telefone pelos últimos 9 dígitos", () => {
    expect(daysOverlap(days(...D), days(...D.slice(0, 4)))).toMatchObject({ common: 4, ofAgent: 5 });
    expect(daysOverlap(days(...D), days(...D)).jaccard).toBe(1);
    expect(phoneTail("+351 912 345 678")).toBe("912345678");
  });
});

describe("31a — onde está cada agente e quem falta", () => {
  const P1 = "partner-owner-1";
  const r = crossCheckAgents(input({
    agents: [
      agent({ userId: "a1", name: "Luis Linares" }),
      agent({ userId: "a2", name: "Carlito Kanbung" }),
      agent({ userId: "a3", name: "Mafalda X", email: "mafalda@empresa.pt" }),
      agent({ userId: "a4", name: "Bruno Meireles" }),
      agent({ userId: "a5", name: "Ana Agência", roles: ["PARTNER"], mpPartner: { ownerUserId: P1, name: "Viagens Lda", type: "AGENCY", how: "membro" } }),
      agent({ userId: "a6", name: "Outra Agência", roles: ["PARTNER"], mpPartner: { ownerUserId: "p-x", name: "Sem Cá", type: "AGGREGATOR", how: "dono" } }),
      agent({ userId: "a7", name: "Sistema", excluded: "sistema" }),
      agent({ userId: "a8", name: "Ze" }),
      agent({ userId: "a9", name: "Ana Sousa" }),
      agent({ userId: "a10", name: "Ricardo Rodrigues" }),
    ],
    persons: [
      person({ employeeId: 1, name: "Luis Linares", agentIds: ["a1"], userId: 101 }),
      person({ employeeId: 2, name: "Carlito Kanbung", agentIds: ["a2"] }),
      person({ employeeId: 3, name: "Mafalda Pereira", emails: ["mafalda@empresa.pt"] }),
      person({ employeeId: 4, name: "Bruno Filipe Meireles Silva", zelloUsernames: ["bruno.m"] }),
      person({ employeeId: 5, name: "José Carvalho", phones: ["912345678"] }),
      person({ employeeId: 6, name: "Ricardo Rodrigues", userId: 106 }),
    ],
    users: [{ id: 101, name: "Luis", email: null, role: "user", employeeId: 1 }, { id: 106, name: "Ricardo Rodrigues", email: null, role: "user", employeeId: 6 }],
    partnerships: [{ id: 50, name: "Viagens Lda", kind: "partner", multiparkPartnerId: P1, contactEmail: null, archived: false }],
    zello: [{ username: "zx", fullName: "PDA 7", email: null, phone: "+351 912 345 678", employeeId: null }],
    agentDays: new Map([["a4", days(...D)], ["a8", days(...D)], ["a9", days(...D)]]),
    zelloDays: new Map([["bruno.m", days(...D)], ["zx", days(...D.slice(0, 4))]]),
    escalaDaysByName: new Map([["ana sousa", { name: "Ana Sousa", city: "lisboa", days: days(...D) }]]),
  }));
  const by = (id: string) => r.agents.find((a) => a.userId === id)!;

  it("na ficha (com e sem utilizador), na parceria pela Multipark, parceiro sem parceria, fora", () => {
    expect(by("a1").place).toMatchObject({ kind: "ficha", employeeId: 1, hasUser: true });
    expect(by("a1").needsUser).toBe(false);
    expect(by("a2").needsUser).toBe(true); // cada agente tem de ser um utilizador
    expect(by("a5").place).toMatchObject({ kind: "parceria", partnershipId: 50, viaMultipark: true });
    expect(by("a6").place).toMatchObject({ kind: "parceiro_sem_parceria", name: "Sem Cá" });
    expect(by("a7").place).toMatchObject({ kind: "sistema" });
  });

  it("em lado nenhum → a pessoa provável e o porquê", () => {
    expect(by("a3").suggestions[0]).toMatchObject({ kind: "ficha", employeeId: 3 });
    expect(by("a3").suggestions[0].reasons).toContain("mesmo email");
    const b = by("a4").suggestions[0];
    expect(b).toMatchObject({ kind: "ficha", employeeId: 4 });
    expect(b.reasons).toEqual(expect.arrayContaining(["nome parecido", "mesma cidade", "no Zello em 5 dos 5 dias em que mexeu na Multipark"]));
  });

  it("telefone pelo Zello: a conta do Zello sem ficha com o telefone de uma ficha é essa pessoa", () => {
    const z = by("a8").suggestions.find((x) => x.employeeId === 5);
    expect(z?.reasons.some((x) => x.startsWith("no Zello em 4 dos 5 dias"))).toBe(true);
  });

  it("escala dos Extras sem ficha entra como pista", () => {
    expect(by("a9").suggestions[0]).toMatchObject({ kind: "escala" });
    expect(by("a9").suggestions[0].reasons).toEqual(expect.arrayContaining(["mesmo nome", "mesma cidade"]));
  });

  it("utilizadores sem agente, com o agente provável", () => {
    expect(r.users.map((u) => u.id)).toEqual([106]);
    expect(r.users[0].suggestions[0]).toMatchObject({ agentUserId: "a10" });
    const s = crossCheckSummary(r);
    expect(s).toMatchObject({ agents: 9, inFicha: 2, withoutUser: 1, partners: 2, partnersToLink: 2, usersWithoutAgent: 1 });
    expect(s.nowhere).toBe(5);
  });
});

describe("31a — leitura da Multipark e servidor", () => {
  it("registo: um por utilizador, com parques/cidades e a empresa parceira; só leitura com LIMIT", () => {
    const q = buildAgentRegistrySql();
    expect(q.sql).toContain(`FROM "Agent" a LEFT JOIN "Park" pk`);
    expect(q.sql).toContain(`"PartnerMember"`);
    expect(q.sql).toMatch(/LIMIT \$1$/);
    expect(q.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(mapRegistryRow({ user_id: "u1", name: "Ana", active: "t", roles: "{DRIVER,LEADER}", parks: "{\"Airpark Lisboa\"}", cities: "{Lisboa}", member_owner: "p1", owner_name: "Viagens", owner_type: "AGENCY" }))
      .toMatchObject({ userId: "u1", roles: ["DRIVER", "LEADER"], parks: ["Airpark Lisboa"], partner: { ownerUserId: "p1", how: "membro", name: "Viagens" } });
    const d = buildAgentDaysSql({ agentIds: ["a", "b"], since: "2026-08-01 00:00:00" });
    expect(d.sql).toContain(`interval '3 hours'`); // dia operacional
    expect(d.params).toEqual(["a", "b", "2026-08-01 00:00:00", 124]);
  });

  it("rota só para quem gere o RH; o cruzamento só lê; criar ficha liga ao id exato do agente", () => {
    const r = src("server/routers.ts");
    expect(r).toMatch(/agentCrossCheck: protectedProcedure[\s\S]{0,200}requireAccess\(ctx\.user, "rh", "manage"\)/);
    expect(r).toContain("const agentId = input.agentUserId ?? await agentIdForName(input.agentName);");
    expect(r).toContain("Esse agente já está ligado a uma ficha");
    expect(src("server/agentCrossCheck.ts")).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b|\.insert\(|\.update\(|\.delete\(/);
    expect(src("client/src/components/IdentityLinksSection.tsx")).toContain("<AgentCrossCheckCard employeeOptions={empOptions} />");
  });
});
