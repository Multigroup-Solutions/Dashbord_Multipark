import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLinkableAgent, isNonPersonAgentName, isSystemAgentId } from "../shared/agentIdentity";
import { buildIdentityAudit, type EmployeeRow, type UserRow } from "./identityReconcile";
import { DEACTIVATION_REASON_LABELS } from "../shared/deactivationReasons";

describe("agentes que não são pessoas", () => {
  it("ids de sistema da Multipark nunca se ligam", () => {
    for (const id of ["system", "api", "API User", "apiUser", "", " ", "x y"]) expect(isSystemAgentId(id)).toBe(true);
    for (const id of ["cmhxl88s70004145dr80zpfq0", "cmtcubndk00enr0nqab83j5s5"]) expect(isSystemAgentId(id)).toBe(false);
  });
  it("teste, agências e textos de formulário não são pessoas; pessoas sim", () => {
    for (const n of ["agencia teste", "NOME DO RESPONSÁVEL PELA GESTÃO DAS RESERVAS", "Agência Bestravel Maia", "topparking", "Rafael Teste"]) expect(isNonPersonAgentName(n)).toBe(true);
    for (const n of ["Kamila Freire Fagundes", "Agent DRIVER", "Luís Miguel Cardoso Tercitano", "Bruno Meireles - PORTO"]) expect(isNonPersonAgentName(n)).toBe(false);
    expect(isLinkableAgent("cmhxl88s70004145dr80zpfq0", "Luis Tercitano")).toBe(true);
    expect(isLinkableAgent("system", "Jorge Tabuada")).toBe(false);
  });
  it("as ligações feitas à mão também recusam agentes de sistema", () => {
    const src = readFileSync(join(__dirname, "identityScreen.ts"), "utf8");
    expect(src).toMatch(/isSystemAgentId\(agentUserId\)/);
    expect(readFileSync(join(__dirname, "employeeAliases.ts"), "utf8")).toMatch(/isSystemAgentId\(agentUserId\)/);
  });
});

describe("email da ficha ≠ email do utilizador", () => {
  const u = (p: Partial<UserRow> & { id: number }): UserRow => ({ openId: `g${p.id}`, name: null, email: null, role: "extra", isActive: 1, loginMethod: "google", lastSignedIn: null, ...p });
  const e = (p: Partial<EmployeeRow> & { id: number }): EmployeeRow => ({ fullName: `P${p.id}`, email: null, personalEmail: null, phone: null, position: "extra", isActive: 1, userId: null, multiparkAgentName: null, multiparkAgentUserId: null, ...p });
  it("login com o email da casa e ficha com o pessoal não é conflito; emails pessoais diferentes são", () => {
    const a = buildIdentityAudit({
      users: [u({ id: 1, email: "arianavieira@multipark.pt" }), u({ id: 2, email: "macalcantara@outlook.com" }), u({ id: 3, email: "x@gmail.com" })],
      employees: [
        e({ id: 7, email: "arianavra@gmail.com", userId: 1 }),
        e({ id: 407, email: "malacaalcantara@outlook.com", userId: 2 }),
        e({ id: 8, email: "y@gmail.com", personalEmail: "x@gmail.com", userId: 3 }),
      ],
      agents: [],
    });
    expect(a.employeeUserEmailMismatch.map((m) => m.employeeId)).toEqual([407]);
  });
});

describe("juntar fichas", () => {
  it("ficha duplicada é um motivo de desativação com etiqueta", () => {
    expect(DEACTIVATION_REASON_LABELS.ficha_duplicada).toMatch(/duplicada/);
  });
});

describe("agentes por ligar: só os que mexem em carros", () => {
  it("parado = sem ações ou última ação há mais de 60 dias", async () => {
    const { isStaleAgent } = await import("../shared/agentIdentity");
    const now = Date.UTC(2026, 8, 29);
    expect(isStaleAgent(0, null, now)).toBe(true);
    expect(isStaleAgent(10, "2026-09-20T10:00:00.000Z", now)).toBe(false);
    expect(isStaleAgent(10, "2026-07-01 10:00:00", now)).toBe(true);
    expect(isStaleAgent(10, null, now)).toBe(false);
  });
  it("agentes só de parceiro vêm marcados da Multipark", async () => {
    const { mapLiveAgentRow } = await import("./multiparkDb/activityLive");
    expect(mapLiveAgentRow({ user_id: "u1", agent_name: "Guard Park", partner_only: true, total: 3 })?.partnerOnly).toBe(true);
    expect(mapLiveAgentRow({ user_id: "u2", agent_name: "Ana", partner_only: false, total: 3 })?.partnerOnly).toBe(false);
  });
});
