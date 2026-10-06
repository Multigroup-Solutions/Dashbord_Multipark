/**
 * P3 lote 31b — Jorge (6 out 2026): "sim" — os agentes com o mesmo email de
 * uma ficha ligam-se sozinhos (na reconciliação de hora a hora).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planEmailAutoLinks, type XAgentRow, type XPerson } from "../shared/agentCrossCheck";
import { AUTOMATION_FLAGS, automationFlagDefault } from "../shared/appSettings";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const row = (o: Partial<XAgentRow> & { userId: string }): XAgentRow => ({
  name: "Ana Silva", names: ["Ana Silva"], email: null, active: true, roles: ["DRIVER"], parks: [], cities: [], total: 5, lastSeen: null,
  excluded: null, partnerLike: false, mpPartner: null, place: { kind: "nenhum" }, needsUser: false, suggestions: [], ...o,
});
const person = (o: Partial<XPerson> & { employeeId: number }): XPerson => ({
  name: "Ana Silva", emails: [], phones: [], city: null, active: true, position: null, userId: null, agentIds: [], legacyAgentName: null, zelloUsernames: [], ...o,
});

describe("31b — mesmo email de UMA só ficha ativa → liga sozinho", () => {
  it("liga; se a ficha já tem agente, entra como extra (o plano não distingue — a ligação trata disso)", () => {
    const plan = planEmailAutoLinks(
      [row({ userId: "a1", email: "Ana@Empresa.pt" }), row({ userId: "a2", name: "Rui", email: "rui@x.pt" })],
      [person({ employeeId: 1, emails: ["ana@empresa.pt"] }), person({ employeeId: 2, name: "Rui Costa", emails: ["rui@x.pt"], agentIds: ["old"] })],
    );
    expect(plan).toEqual([
      { agentUserId: "a1", agentName: "Ana Silva", employeeId: 1, email: "ana@empresa.pt" },
      { agentUserId: "a2", agentName: "Rui", employeeId: 2, email: "rui@x.pt" },
    ]);
  });

  it("não liga: duas fichas com o email, ficha inativa, email de 3 agentes, empresa, já tem sítio, sem email", () => {
    const persons = [person({ employeeId: 1, emails: ["dup@x.pt"] }), person({ employeeId: 2, emails: ["dup@x.pt"] }), person({ employeeId: 3, emails: ["ina@x.pt"], active: false }), person({ employeeId: 4, emails: ["geral@x.pt"] }), person({ employeeId: 5, emails: ["ag@x.pt"] })];
    const rows = [
      row({ userId: "d", email: "dup@x.pt" }), row({ userId: "i", email: "ina@x.pt" }),
      row({ userId: "g1", email: "geral@x.pt" }), row({ userId: "g2", email: "geral@x.pt" }), row({ userId: "g3", email: "geral@x.pt" }),
      row({ userId: "p", email: "ag@x.pt", partnerLike: true }),
      row({ userId: "f", email: "ag@x.pt", place: { kind: "ficha", employeeId: 5, name: "x", byName: false, hasUser: true, active: true } }),
      row({ userId: "n" }),
    ];
    expect(planEmailAutoLinks(rows, persons)).toEqual([]);
  });

  it("ficha ligada só pelo nome antigo a OUTRO agente não se toca; ao mesmo nome liga", () => {
    const rows = [row({ userId: "a1", email: "ana@x.pt" })];
    expect(planEmailAutoLinks(rows, [person({ employeeId: 1, emails: ["ana@x.pt"], legacyAgentName: "Outro Nome" })])).toEqual([]);
    expect(planEmailAutoLinks(rows, [person({ employeeId: 1, emails: ["ana@x.pt"], legacyAgentName: "ANA SILVA - Porto" })])).toHaveLength(1);
  });
});

describe("31b — onde corre e o interruptor", () => {
  it("passo 6 da reconciliação de hora a hora, com interruptor ligado por omissão, e fica nos Logs", () => {
    expect(src("server/identityLink.ts")).toContain("rep.agentsByEmailCross = await autoLinkAgentsByEmail();");
    const s = src("server/agentCrossCheck.ts");
    expect(s).toContain(`isFeatureEnabled("AGENT_EMAIL_AUTOLINK"`);
    expect(s).toContain("ligado sozinho à ficha (mesmo email, cruzamento Agentes × pessoas)");
    expect(AUTOMATION_FLAGS.some((f) => f.name === "AGENT_EMAIL_AUTOLINK")).toBe(true);
    expect(automationFlagDefault("AGENT_EMAIL_AUTOLINK")).toBe(true);
    expect(src("client/src/components/IdentityLinksSection.tsx")).toContain("(r.agentsByEmailCross ?? 0)");
  });
});
