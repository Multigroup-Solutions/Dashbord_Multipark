import { describe, expect, it } from "vitest";
import {
  buildIdentityAudit,
  pickUser,
  planReconcile,
  roleForPosition,
  type AgentRow,
  type EmployeeRow,
  type IdentitySnapshot,
  type UserRow,
} from "./identityReconcile";

// ─── Fábricas ────────────────────────────────────────────────────────────────

function user(p: Partial<UserRow> & { id: number }): UserRow {
  return {
    openId: `google_${p.id}`,
    name: `User ${p.id}`,
    email: null,
    role: "extra",
    isActive: 1,
    loginMethod: "google",
    lastSignedIn: null,
    ...p,
  };
}
function emp(p: Partial<EmployeeRow> & { id: number }): EmployeeRow {
  return {
    fullName: `Pessoa ${p.id}`,
    email: null,
    personalEmail: null,
    phone: null,
    position: "extra",
    isActive: 1,
    userId: null,
    multiparkAgentName: null,
    multiparkAgentUserId: null,
    ...p,
  };
}
function agent(p: Partial<AgentRow> & { agentUserId: string }): AgentRow {
  return { agentNames: ["Agente"], agentEmails: [], actions: 1, firstAction: null, lastAction: null, ...p };
}
const snap = (s: Partial<IdentitySnapshot>): IdentitySnapshot => ({ users: [], employees: [], agents: [], ...s });

// ─── roleForPosition ─────────────────────────────────────────────────────────

describe("roleForPosition", () => {
  it("extras e condutores entram como extra; chefias com o role equivalente", () => {
    expect(roleForPosition("extra")).toBe("extra");
    expect(roleForPosition("driver")).toBe("extra");
    expect(roleForPosition("senior_driver")).toBe("extra");
    expect(roleForPosition("team_leader")).toBe("team_leader");
    expect(roleForPosition("backoffice")).toBe("backoffice");
    expect(roleForPosition("frontoffice")).toBe("frontoffice");
    expect(roleForPosition("supervisor")).toBe("supervisor");
  });
  it("nunca dá admin sozinho: director → supervisor", () => {
    expect(roleForPosition("director")).toBe("supervisor");
    expect(roleForPosition("qualquer coisa")).toBe("extra");
  });
});

// ─── pickUser ────────────────────────────────────────────────────────────────

describe("pickUser", () => {
  it("ativo > login Google > id mais baixo", () => {
    const a = user({ id: 5, openId: "manual_x", isActive: 1 });
    const b = user({ id: 9, openId: "google_9", isActive: 1 });
    const c = user({ id: 1, openId: "google_1", isActive: 0 });
    expect(pickUser([a, b, c])!.id).toBe(9);
    expect(pickUser([a, c])!.id).toBe(5);
    expect(pickUser([user({ id: 3, openId: "manual_a" }), user({ id: 2, openId: "manual_b" })])!.id).toBe(2);
    expect(pickUser([])).toBeNull();
  });
});

// ─── buildIdentityAudit ──────────────────────────────────────────────────────

describe("buildIdentityAudit", () => {
  it("ficha com email válido e sem utilizador → employeesWithoutUser (com o user existente, se houver)", () => {
    const s = snap({
      users: [user({ id: 10, email: "ana@x.pt" })],
      employees: [emp({ id: 1, email: "Ana@X.pt" }), emp({ id: 2, email: "bob@x.pt" }), emp({ id: 3, email: "lixo" }), emp({ id: 4 })],
    });
    const a = buildIdentityAudit(s);
    expect(a.employeesWithoutUser.map((e) => [e.employeeId, e.existingUserId])).toEqual([
      [1, 10],
      [2, null],
    ]);
    expect(a.employeesInvalidEmail.map((e) => e.employeeId)).toEqual([3]);
    expect(a.counts.employeesWithoutEmail).toBe(1);
    expect(a.counts.employeesWithValidEmail).toBe(2);
  });

  it("compara emails na forma canónica (maiúsculas/espaços)", () => {
    const s = snap({
      users: [user({ id: 10, email: "  ANA@x.pt " })],
      employees: [emp({ id: 1, email: "ana@x.pt", userId: 10 })],
    });
    const a = buildIdentityAudit(s);
    expect(a.employeeUserEmailMismatch).toEqual([]);
    expect(a.employeesWithoutUser).toEqual([]);
  });

  it("ficha ligada a utilizador com email diferente → mismatch; userId inexistente → dangling", () => {
    const s = snap({
      users: [user({ id: 10, email: "ana@multipark.pt" })],
      employees: [emp({ id: 1, email: "ana@gmail.com", userId: 10 }), emp({ id: 2, email: "z@x.pt", userId: 999 })],
    });
    const a = buildIdentityAudit(s);
    expect(a.employeeUserEmailMismatch).toHaveLength(1);
    expect(a.employeeUserEmailMismatch[0]).toMatchObject({ employeeId: 1, userId: 10, userEmail: "ana@multipark.pt" });
    expect(a.employeesDanglingUser).toEqual([{ employeeId: 2, fullName: "Pessoa 2", userId: 999 }]);
  });

  it("duplicados: utilizadores e fichas com o mesmo email; utilizador com várias fichas ativas", () => {
    const s = snap({
      users: [user({ id: 1, email: "dup@x.pt" }), user({ id: 2, email: "DUP@x.pt", openId: "manual_2" })],
      employees: [emp({ id: 1, email: "f@x.pt", userId: 1 }), emp({ id: 2, email: "f@x.pt", userId: 1 }), emp({ id: 3, email: "f@x.pt", isActive: 0 })],
    });
    const a = buildIdentityAudit(s);
    expect(a.duplicateUsers).toHaveLength(1);
    expect(a.duplicateUsers[0].rows.map((u) => u.id)).toEqual([1, 2]);
    expect(a.duplicateEmployees[0].rows.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(a.usersWithSeveralActiveEmployees).toEqual([{ userId: 1, employeeIds: [1, 2] }]);
  });

  it("agentes: por anexar (email bate), anexado com email diferente, sem correspondência, email partilhado", () => {
    const s = snap({
      users: [user({ id: 10, email: "so-user@x.pt" })],
      employees: [
        emp({ id: 1, email: "ana@x.pt" }), // agente A bate por email → anexar
        emp({ id: 2, email: "bob@x.pt", multiparkAgentUserId: "B", multiparkAgentName: "Bob" }), // anexado, email do agente diferente
        emp({ id: 3, userId: 10 }), // sem email na ficha; email vem do user
      ],
      agents: [
        agent({ agentUserId: "A", agentNames: ["Ana"], agentEmails: ["ana@x.pt"] }),
        agent({ agentUserId: "B", agentNames: ["Bob"], agentEmails: ["bob@multipark.pt"] }),
        agent({ agentUserId: "C", agentNames: ["Carlos"], agentEmails: ["carlos@x.pt"] }),
        agent({ agentUserId: "D", agentNames: ["Dora"], agentEmails: ["so-user@x.pt"] }),
        agent({ agentUserId: "E", agentNames: ["Eva"], agentEmails: ["carlos@x.pt"] }),
      ],
    });
    const a = buildIdentityAudit(s);
    expect(a.agentsToAttach.map((x) => x.agentUserId).sort()).toEqual(["A", "D"]);
    expect(a.agentsToAttach.find((x) => x.agentUserId === "A")!.emailMatchEmployeeIds).toEqual([1]);
    // D: o email é do utilizador 10, que está ligado à ficha 3 (email efetivo)
    expect(a.agentsToAttach.find((x) => x.agentUserId === "D")!.emailMatchEmployeeIds).toEqual([3]);
    expect(a.agentsEmailMismatch.map((x) => x.agentUserId)).toEqual(["B"]);
    expect(a.agentsUnmatched.map((x) => x.agentUserId).sort()).toEqual(["C", "E"]);
    expect(a.agentsSharingEmail).toEqual([{ email: "carlos@x.pt", agentUserIds: ["C", "E"] }]);
  });

  it("email PESSOAL de um interno também casa agentes (anexar e sem mismatch)", () => {
    const s = snap({
      employees: [
        emp({ id: 1, email: "ana@multipark.pt", personalEmail: "ana@gmail.com", position: "team_leader" }),
        emp({ id: 2, email: "luis@multipark.pt", personalEmail: "luis@gmail.com", position: "backoffice", multiparkAgentName: "Luis" }),
      ],
      agents: [
        agent({ agentUserId: "A", agentNames: ["Ana"], agentEmails: ["ana@gmail.com"] }),
        agent({ agentUserId: "L", agentNames: ["Luis"], agentEmails: ["luis@gmail.com"] }),
      ],
    });
    const a = buildIdentityAudit(s);
    expect(a.agentsToAttach.map((x) => x.agentUserId)).toEqual(["A"]);
    expect(a.agentsToAttach[0].emailMatchEmployeeIds).toEqual([1]);
    expect(a.agentsEmailMismatch).toEqual([]);
    // Só para agentes: a ficha↔utilizador continua a exigir o email de trabalho.
    expect(a.employeesWithoutUser.map((e) => e.email)).toEqual(["ana@multipark.pt", "luis@multipark.pt"]);
  });

  it("agente ligado por NOME (sem id) conta como anexado; nome de agente desconhecido na ficha é reportado", () => {
    const s = snap({
      employees: [emp({ id: 1, email: "ana@x.pt", multiparkAgentName: "ana" }), emp({ id: 2, email: "zed@x.pt", multiparkAgentName: "Zé Ninguém" })],
      agents: [agent({ agentUserId: "A", agentNames: ["Ana"], agentEmails: ["ana@x.pt"] })],
    });
    const a = buildIdentityAudit(s);
    expect(a.agentsToAttach).toEqual([]);
    expect(a.agentsEmailMismatch).toEqual([]);
    expect(a.employeesWithUnknownAgent.map((e) => e.employeeId)).toEqual([2]);
  });
});

// ─── planReconcile ───────────────────────────────────────────────────────────

describe("planReconcile", () => {
  it("cria utilizador (role pela função) ou liga ao existente; inativas ficam de fora por defeito", () => {
    const s = snap({
      users: [user({ id: 10, email: "ana@x.pt" })],
      employees: [
        emp({ id: 1, email: "ana@x.pt" }),
        emp({ id: 2, email: "bob@x.pt", position: "team_leader" }),
        emp({ id: 3, email: "old@x.pt", isActive: 0 }),
      ],
    });
    const plan = planReconcile(s, buildIdentityAudit(s));
    expect(plan.linkUsers).toEqual([{ employeeId: 1, fullName: "Pessoa 1", email: "ana@x.pt", userId: 10 }]);
    expect(plan.createUsers).toEqual([{ employeeId: 2, fullName: "Pessoa 2", email: "bob@x.pt", position: "team_leader", role: "team_leader" }]);
    expect(plan.skipped).toEqual([{ what: "create_user", ref: "ficha #3", reason: "ficha inativa (usa --include-inactive)" }]);
    const plan2 = planReconcile(s, buildIdentityAudit(s), { includeInactive: true });
    expect(plan2.createUsers.map((c) => c.employeeId)).toEqual([2, 3]);
  });

  it("não liga a um utilizador que já pertence a outra ficha ativa, nem a um desativado", () => {
    const s = snap({
      users: [user({ id: 10, email: "ana@x.pt" }), user({ id: 11, email: "off@x.pt", isActive: 0 })],
      employees: [emp({ id: 1, email: "ana@x.pt" }), emp({ id: 2, userId: 10 }), emp({ id: 3, email: "off@x.pt" })],
    });
    const plan = planReconcile(s, buildIdentityAudit(s));
    expect(plan.linkUsers).toEqual([]);
    expect(plan.createUsers).toEqual([]);
    expect(plan.skipped.map((x) => x.ref)).toEqual(["ficha #1", "ficha #3"]);
    expect(plan.skipped[0].reason).toContain("já ligado à ficha ativa #2");
    expect(plan.skipped[1].reason).toContain("desativado");
  });

  it("email partilhado por várias fichas ativas → nada é criado, tudo vai para decisão humana", () => {
    const s = snap({
      employees: [emp({ id: 1, email: "fam@x.pt" }), emp({ id: 2, email: "fam@x.pt" })],
    });
    const plan = planReconcile(s, buildIdentityAudit(s));
    expect(plan.createUsers).toEqual([]);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped[0].reason).toContain("partilhado por 2 fichas");
  });

  it("anexa o agente à única ficha com o email, com o nome canónico (mais usado) quando o da ficha não existe no histórico", () => {
    const s = snap({
      employees: [
        emp({ id: 1, email: "ana@x.pt", multiparkAgentName: "Ana Antiga" }),
        emp({ id: 2, email: "bob@x.pt", multiparkAgentName: "bob" }),
      ],
      agents: [
        agent({ agentUserId: "A", agentNames: ["Ana Nova", "ana@x.pt"], agentEmails: ["ana@x.pt"], actions: 40 }),
        agent({ agentUserId: "B", agentNames: ["Bob"], agentEmails: ["bob@x.pt"], actions: 3 }),
      ],
    });
    const audit = buildIdentityAudit(s);
    // B já está ligado por nome (case-insensitive) → não aparece por anexar
    expect(audit.agentsToAttach.map((a) => a.agentUserId)).toEqual(["A"]);
    const plan = planReconcile(s, audit);
    expect(plan.attachAgents).toEqual([
      {
        employeeId: 1,
        fullName: "Pessoa 1",
        email: "ana@x.pt",
        agentUserId: "A",
        agentName: "Ana Nova",
        previousAgentName: "Ana Antiga",
        previousAgentUserId: null,
        actions: 40,
      },
    ]);
  });

  it("mantém o nome da ficha quando é um dos nomes reais do agente", () => {
    const s = snap({
      employees: [emp({ id: 1, email: "ana@x.pt", multiparkAgentName: "ANA@x.pt" })],
      agents: [agent({ agentUserId: "A", agentNames: ["Ana", "ana@x.pt"], agentEmails: ["ana@x.pt"] })],
    });
    const audit = buildIdentityAudit(s);
    // ligado por nome (case-insensitive) → já anexado, nada a fazer
    expect(audit.agentsToAttach).toEqual([]);
    expect(planReconcile(s, audit).attachAgents).toEqual([]);
  });

  it("agente cujo email só bate com utilizador (sem ficha) ou com várias fichas → decisão humana", () => {
    const s = snap({
      users: [user({ id: 10, email: "teste@x.pt" })],
      employees: [emp({ id: 1, email: "dup@x.pt" }), emp({ id: 2, email: "dup@x.pt" })],
      agents: [
        agent({ agentUserId: "T", agentNames: ["Teste"], agentEmails: ["teste@x.pt"] }),
        agent({ agentUserId: "D", agentNames: ["Dup"], agentEmails: ["dup@x.pt"] }),
      ],
    });
    const plan = planReconcile(s, buildIdentityAudit(s));
    expect(plan.attachAgents).toEqual([]);
    const reasons = plan.skipped.filter((x) => x.what === "attach_agent").map((x) => x.reason);
    expect(reasons[0]).toContain("só bate com utilizador(es) #10");
    expect(reasons[1]).toContain("2 fichas ativas");
  });

  it("não substitui uma ligação legada por NOME a outro agente real (caso Luís Tercitano)", () => {
    const s = snap({
      employees: [emp({ id: 2, email: "luis@multipark.pt", multiparkAgentName: "Luis Tercitano" })],
      agents: [
        agent({ agentUserId: "REAL", agentNames: ["Luis Tercitano", "luis@gmail.com"], agentEmails: ["luis@gmail.com"], actions: 410 }),
        agent({ agentUserId: "TESTE", agentNames: ["agencia teste"], agentEmails: ["luis@multipark.pt"], actions: 4 }),
      ],
    });
    const audit = buildIdentityAudit(s);
    expect(audit.agentsToAttach.map((a) => a.agentUserId)).toEqual(["TESTE"]);
    const plan = planReconcile(s, audit);
    expect(plan.attachAgents).toEqual([]);
    const skip = plan.skipped.find((x) => x.what === "attach_agent")!;
    expect(skip.reason).toContain("ligada por nome ao agente REAL");
    expect(skip.reason).toContain("410 ações");
  });

  it("não troca um agente real já anexado por outro", () => {
    const s = snap({
      employees: [emp({ id: 1, email: "ana@x.pt", multiparkAgentUserId: "OLD", multiparkAgentName: "Old" })],
      agents: [
        agent({ agentUserId: "OLD", agentNames: ["Old"], agentEmails: ["outra@x.pt"] }),
        agent({ agentUserId: "NEW", agentNames: ["New"], agentEmails: ["ana@x.pt"] }),
      ],
    });
    const plan = planReconcile(s, buildIdentityAudit(s));
    expect(plan.attachAgents).toEqual([]);
    expect(plan.skipped.find((x) => x.what === "attach_agent")!.reason).toContain("já está anexada ao agente OLD");
  });

  it("utilizadores duplicados: fica o ativo/Google/mais antigo; duas contas Google ativas → decisão humana", () => {
    const s = snap({
      users: [
        user({ id: 1, email: "a@x.pt", openId: "manual_1", loginMethod: "manual" }),
        user({ id: 2, email: "a@x.pt", openId: "google_2" }),
        user({ id: 3, email: "b@x.pt", openId: "google_3" }),
        user({ id: 4, email: "b@x.pt", openId: "google_4" }),
      ],
    });
    const plan = planReconcile(s, buildIdentityAudit(s));
    expect(plan.mergeUsers).toEqual([{ email: "a@x.pt", keepUserId: 2, removeUserIds: [1] }]);
    expect(plan.skipped.find((x) => x.what === "merge_users")!.reason).toContain("duas contas Google ATIVAS");
  });
});
