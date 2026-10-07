/**
 * Lote 41a — identidade: o agente da Multipark na ficha do RH e na lista de
 * Utilizadores; ligar/separar conta ↔ ficha ↔ agente a partir de qualquer lado.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";

// BD simulada: cada execute() devolve a próxima resposta e guarda o SQL.
const calls: string[] = [];
let replies: any[][] = [];
vi.mock("./db", () => ({
  getDb: async () => ({
    execute: async (q: SQL) => {
      const c = new MySqlDialect().sqlToQuery(q);
      calls.push(`${c.sql} | ${JSON.stringify(c.params)}`);
      return [replies.shift() ?? []];
    },
  }),
}));

import { detachAccount, multiparkAgentUrl } from "./personIdentity";
import { SETTINGS } from "../shared/appSettings";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("41a: endereço de um agente na Multipark", () => {
  it("troca {id} pelo número do agente; sem modelo válido não há botão", () => {
    expect(multiparkAgentUrl("https://bo.multipark.pt/agents/{id}", "abc-123")).toBe("https://bo.multipark.pt/agents/abc-123");
    expect(multiparkAgentUrl("https://bo.multipark.pt/a?id={id}&x={id}", "7")).toBe("https://bo.multipark.pt/a?id=7&x=7");
    expect(multiparkAgentUrl("https://bo.multipark.pt/a/{id}", "a b/c")).toBe("https://bo.multipark.pt/a/a%20b%2Fc");
    expect(multiparkAgentUrl("", "7")).toBeNull();
    expect(multiparkAgentUrl("https://bo.multipark.pt/agents", "7")).toBeNull();
    expect(multiparkAgentUrl("http://bo.multipark.pt/{id}", "7")).toBeNull();
    expect(multiparkAgentUrl("javascript:alert(1)//{id}", "7")).toBeNull();
    expect(multiparkAgentUrl("https://bo.multipark.pt/{id}", null)).toBeNull();
  });

  it("a definição aceita vazio ou https com {id}", () => {
    const s = SETTINGS["multipark.agentUrl"].schema;
    expect(s.safeParse("").success).toBe(true);
    expect(s.safeParse("https://bo.multipark.pt/agents/{id}").success).toBe(true);
    expect(s.safeParse("https://bo.multipark.pt/agents").success).toBe(false);
    expect(s.safeParse("http://bo.multipark.pt/{id}").success).toBe(false);
    expect(s.safeParse("https://bo.multipark.pt/ {id}").success).toBe(false);
    expect(SETTINGS["multipark.agentUrl"].defaultValue).toBe("");
  });
});

describe("41a: separar uma conta da ficha", () => {
  it("conta extra: só sai a ligação dessa conta", async () => {
    calls.length = 0;
    replies = [[{ userId: 10 }], [{ userId: 22 }], []];
    await expect(detachAccount(5, 22)).resolves.toBe("extra");
    expect(calls[2]).toMatch(/^DELETE FROM employee_accounts WHERE userId = \? AND employeeId = \?/);
    expect(calls[2]).toContain("[22,5]");
    expect(calls.some((c) => c.startsWith("UPDATE employees"))).toBe(false);
  });

  it("conta principal com uma extra: a extra passa a principal", async () => {
    calls.length = 0;
    replies = [[{ userId: 10 }], [{ userId: 31 }], [], []];
    await expect(detachAccount(5, 10)).resolves.toBe("principal");
    expect(calls[2]).toMatch(/^UPDATE employees SET userId = \? WHERE id = \?/);
    expect(calls[2]).toContain("[31,5]");
    expect(calls[3]).toContain("DELETE FROM employee_accounts WHERE userId = ?");
  });

  it("conta principal sem extra: a ficha fica sem conta (a conta não é apagada)", async () => {
    calls.length = 0;
    replies = [[{ userId: 10 }], [], []];
    await expect(detachAccount(5, 10)).resolves.toBe("principal");
    expect(calls[2]).toMatch(/^UPDATE employees SET userId = NULL WHERE id = \?/);
    expect(calls.some((c) => /DELETE FROM users|UPDATE users/.test(c))).toBe(false);
  });

  it("conta que não é desta ficha: erro, nada muda", async () => {
    calls.length = 0;
    replies = [[{ userId: 10 }], []];
    await expect(detachAccount(5, 99)).rejects.toThrow("não está ligada");
    expect(calls.some((c) => /^(UPDATE|DELETE)/.test(c))).toBe(false);
  });
});

describe("41a: servidor", () => {
  const routers = read("server/routers.ts");
  const rh = read("server/rhRouter.ts");
  const dir = read("server/usersDirectory.ts");

  it("separar conta: quem gere o RH, na cidade da ficha, nunca a própria, com registo", () => {
    const i = routers.indexOf("detachAccount: protectedProcedure");
    const block = routers.slice(i, routers.indexOf("detachAgent: protectedProcedure", i));
    expect(block).toContain('requireAccess(ctx.user, "rh", "manage")');
    expect(block).toContain("assertEmployeeAccess(input.employeeId)");
    expect(block).toContain("input.userId === ctx.user.id");
    expect(block).toContain('action: "account_unlink"');
  });

  it("rh.agentSummary: quem vê a ficha vê o agente; ligar/separar só quem gere o RH", () => {
    const i = rh.indexOf("agentSummary: protectedProcedure");
    const block = rh.slice(i, rh.indexOf("// ── MY PROFILE", i));
    expect(block).toContain("canViewEmployee(viewer, person.employee)");
    expect(block).toContain("assertEmployeeAccess(input.employeeId)");
    expect(block).toContain("canManageLinks: canAccess(ctx.user, 'rh', 'manage')");
    expect(block).toContain("canOpenAgent: canAccess(ctx.user, 'criticas', 'view')");
    expect(block).toContain("FROM employee_agents WHERE employeeId");
    expect(block).toContain("getSetting('multipark.agentUrl')");
  });

  it("lista de Utilizadores: contas extra e agentes de cada ficha, no âmbito da cidade", () => {
    expect(dir).toContain("FROM employee_accounts ea JOIN employees ON employees.id = ea.employeeId");
    expect(dir).toMatch(/employee_accounts ea[\s\S]{0,400}projectScope\(employees\.projectId\)/);
    expect(dir).toContain("SELECT employeeId, agentUserId, agentName FROM employee_agents");
    expect(dir).toContain("agentUserId: employees.multiparkAgentUserId");
  });
});

describe("41a: cliente", () => {
  it("ficha do RH: agente com Abrir agente / Abrir na Multipark / Copiar ID / Ligações", () => {
    const c = read("client/src/components/EmployeeAccessAvailability.tsx");
    expect(c).toContain("trpc.rh.agentSummary.useQuery");
    expect(c).toContain("/pessoas/condutores-agentes?ficha=${employeeId}");
    expect(c).toContain("Abrir na Multipark");
    expect(c).toContain("Copiar ID");
    expect(c).toContain('rel="noopener noreferrer"');
    expect(c).toContain("d.canManageLinks &&");
    expect(c).toContain("d.canOpenAgent &&");
    expect(c).toContain("<PersonLinksDialog");
  });

  it("Condutores e agentes: ?ficha= abre logo os Agentes com a pessoa", () => {
    const c = read("client/src/pages/CondutoresAgentesPage.tsx");
    expect(c).toContain('get("ficha")');
    expect(c).toContain('initialFicha ? "agents" : "drivers"');
    expect(c).toContain("useState(initialEmployeeId)");
  });

  it("cartão de ligações: ficha fixa, separar com confirmação, ligar conta", () => {
    const c = read("client/src/components/PersonIdentityCard.tsx");
    expect(c).toContain("employeeId ? String(employeeId) : pickedId");
    expect(c).toContain("trpc.identityLinks.detachAccount.useMutation");
    expect(c).toContain("trpc.identityLinks.linkUser.useMutation");
    expect(c).toContain("Separar conta da ficha");
    expect(c).toContain("Separar agente da ficha");
    // separar o agente já não é um clique direto
    expect(c).not.toMatch(/onClick=\{\(\) => detach\.mutate/);
  });

  it("Utilizadores: coluna Agente, botão Ligações (admin+) e tabela que não sai do ecrã", () => {
    const c = read("client/src/pages/UsersPage.tsx");
    expect(c).toContain("<TableHead>Agente</TableHead>");
    expect(c).toContain("<UserAgentLinks employees={u.employees} />");
    expect(c).toContain('can(currentUser, "rh", "manage")');
    expect(c).toContain("<PersonLinksDialog");
    expect(c).toContain("LinkUserToEmployeeDialog");
    expect(c).toContain('className="hidden xl:table-cell">Departamento');
    expect(c).not.toContain('<div className="overflow-x-auto">\n                <Table>');
    const links = read("client/src/components/UserEmployeeLinks.tsx");
    expect(links).toContain("active > 1");
    expect(links).toContain("conta extra");
  });
});

// ─── 41a parte 2: inativar sem soltar · suspender ──────────────────────────
import { inactivityReason, manualBlockReason, pickSuspendCandidates, type SuspendRow } from "../shared/suspendSuggest";
import { crossCheckAgents, type XAgent, type XInput, type XPerson } from "../shared/agentCrossCheck";
import { employeesFollowingAccount } from "./personIdentity";

describe("41a: sugerir suspender (não desativar)", () => {
  const row = (o: Partial<SuspendRow> & { employeeId: number }): SuspendRow => ({
    fullName: `P${o.employeeId}`, position: "extra", projectName: "Porto", createdAt: "2025-01-01", lastLogin: null, topRole: "extra", ...o,
  });
  const today = "2026-10-07";

  it("parado há mais de 180 dias (trabalho e login); quem trabalhou ou entrou fica de fora", () => {
    const r = pickSuspendCandidates([
      row({ employeeId: 1 }),                                   // nunca fez nada, ficha de 2025 → sim
      row({ employeeId: 2, lastLogin: "2026-09-30" }),          // entrou há dias → não
      row({ employeeId: 3, lastLogin: "2026-01-10" }),          // último login em janeiro → sim
      row({ employeeId: 4, lastLogin: "2026-01-10" }),          // mas trabalhou em setembro → não
      row({ employeeId: 5, createdAt: "2026-08-01" }),          // ficha nova sem nada → não
      row({ employeeId: 6, topRole: "admin" }),                 // admin+ nunca
      row({ employeeId: 7, lastLogin: "2026-04-10" }),          // exatamente 180 dias → não
    ], { 4: "2026-09-20" }, today, 180);
    // quem nunca fez nada primeiro, depois os mais antigos
    expect(r.map((x) => x.employeeId)).toEqual([1, 3]);
    expect(r[0]).toMatchObject({ lastActivity: null, daysIdle: null });
    expect(r[1]).toMatchObject({ lastActivity: "2026-01-10", daysIdle: 270 });
  });

  it("0 dias = desligado", () => {
    expect(pickSuspendCandidates([row({ employeeId: 1 })], {}, today, 0)).toEqual([]);
  });

  it("motivo: meses certos e o texto manual sem o sufixo repetido", () => {
    expect(inactivityReason(180)).toBe("Suspenso: sem atividade há mais de 6 meses");
    expect(inactivityReason(30)).toBe("Suspenso: sem atividade há mais de 1 mês");
    expect(inactivityReason(100)).toBe("Suspenso: sem atividade há mais de 100 dias");
    expect(manualBlockReason("Suspenso pelo RH")).toBe("Suspenso pelo RH");
    expect(manualBlockReason("Suspenso pelo RH. Contacta o supervisor.")).toBe("Suspenso pelo RH");
    expect(manualBlockReason("faltas em extras-dia sem aviso · Suspenso pelo RH. Contacta o supervisor.")).toBe("Suspenso pelo RH");
    expect(manualBlockReason("faltas em extras-dia sem aviso. Contacta o supervisor.")).toBe("bloqueio manual");
    expect(manualBlockReason(null)).toBe("bloqueio manual");
  });

  it("servidor: só quem gere o RH, na cidade, nunca a própria ficha; o RH usa o motivo manual sem duplicar", () => {
    const routers = read("server/routers.ts");
    const i = routers.indexOf("suspendSuggestions: protectedProcedure");
    const block = routers.slice(i, routers.indexOf("detachAgent: protectedProcedure", i));
    expect(block.match(/requireAccess\(ctx\.user, "rh", "manage"\)/g)?.length).toBe(2);
    expect(block).toContain("scopedProjectIds()");
    expect(block).toContain("assertEmployeeAccess(id)");
    expect(block).toContain("me?.employee.id === id");
    expect(block).toContain('action: "suspend"');
    expect(read("server/rhService.ts")).toContain("reasons.push(manualBlockReason(e.loginBlockedReason))");
    const pi = read("server/personIdentity.ts");
    expect(pi).toContain("SET blockedManually = 1");
    expect(pi).not.toMatch(/suspendEmployee[\s\S]{0,600}isActive = 0/);
  });

  it("cliente: pop-up nos Utilizadores e Suspender na ficha", () => {
    const d = read("client/src/components/SuspendSuggestionsDialog.tsx");
    expect(d).toContain("trpc.identityLinks.suspendSuggestions.useQuery");
    expect(d).toContain("Suspender não é desativar");
    expect(d).toContain("Agora não");
    expect(read("client/src/pages/UsersPage.tsx")).toContain("<SuspendSuggestionsDialog enabled={canLinks} />");
    expect(read("client/src/pages/HRPage.tsx")).toContain('why: "manual"');
  });
});

describe("41a: inativar não solta (conta ↔ ficha ↔ agente)", () => {
  it("desativar a conta principal leva a ficha (se a pessoa não tiver outra conta ativa); reativar traz", async () => {
    calls.length = 0;
    replies = [[{ id: 7, fullName: "Ana" }]];
    expect(await employeesFollowingAccount(42, false)).toEqual([{ id: 7, fullName: "Ana" }]);
    expect(calls[0]).toContain("e.userId = ? AND e.isActive = ?");
    expect(calls[0]).toContain("NOT EXISTS (SELECT 1 FROM employee_accounts a JOIN users u ON u.id = a.userId");
    expect(calls[0]).toContain("u.isActive = 1");
    expect(calls[0]).toContain("[42,1,42]");
    calls.length = 0;
    replies = [[]];
    await employeesFollowingAccount(42, true);
    expect(calls[0]).not.toContain("NOT EXISTS");
    expect(calls[0]).toContain("[42,0]");
  });

  it("users.toggleActive: a ficha acompanha (na cidade, com o mesmo motivo); rh.setActive leva as contas extra", () => {
    const routers = read("server/routers.ts");
    const i = routers.indexOf("toggleActive: protectedProcedure");
    const block = routers.slice(i, routers.indexOf("sendInvite: protectedProcedure", i));
    expect(block).toContain("employeesFollowingAccount(input.userId, input.isActive)");
    expect(block).toContain("try { await assertEmployeeAccess(e.id); } catch { continue; }");
    expect(block).toContain("deactivationColumns(input.isActive, meta)");
    expect(block).toContain("return { success: true, employees: followed }");
    // nada solta o agente nem a conta
    expect(block).not.toMatch(/multiparkAgentUserId\s*=\s*NULL|SET userId = NULL/);
    const rh = read("server/rhRouter.ts");
    const j = rh.indexOf("setActive: protectedProcedure");
    const set = rh.slice(j, rh.indexOf("uploadPhoto: protectedProcedure", j));
    expect(set).toContain("activeExtraAccounts(input.id)");
    expect(set).toContain("if (xid === ctx.user.id || xid === userId) continue;");
    expect(set).toContain("superAdminGuard(ctx.user.id, t, null, n)");
  });

  it("cruzamento: o agente de uma conta desativada continua 'com utilizador' e a conta não entra na lista de quem não tem agente", () => {
    const agent: XAgent = { userId: "ag1", name: "Ana Silva", names: ["Ana Silva"], email: null, active: true, roles: ["DRIVER"], parks: [], cities: ["porto"], total: 3, lastSeen: null, excluded: null, partnerLike: false, mpPartner: null };
    const person: XPerson = { employeeId: 7, name: "Ana Silva", emails: [], phones: [], city: "porto", active: false, position: "extra", userId: 42, agentIds: ["ag1"], legacyAgentName: null, zelloUsernames: [] };
    const base: XInput = { agents: [agent], persons: [person], users: [], partnerships: [], partnerByAgentName: new Map(), ignoredAgentNames: new Set(), zello: [], agentDays: new Map(), zelloDays: new Map(), escalaDaysByEmployee: new Map(), escalaDaysByName: new Map() };
    const before = crossCheckAgents(base);
    expect(before.agents[0]).toMatchObject({ needsUser: true });
    const after = crossCheckAgents({ ...base, inactiveUsers: [{ id: 42, name: "Ana", email: "ana@x.pt", role: "extra", employeeId: 7 }] });
    expect(after.agents[0].place).toMatchObject({ kind: "ficha", employeeId: 7, hasUser: true, active: false });
    expect(after.agents[0].needsUser).toBe(false);
    expect(after.users).toEqual([]);
    expect(read("server/agentCrossCheck.ts")).toContain("persons, users, inactiveUsers,");
  });

  it("varredura: o agente principal de uma ficha inativa não passa a extra de outra", () => {
    const s = read("server/identityLink.ts");
    expect(s).toContain("const linkedIds = new Set([...fichas, ...allPrincipal]");
  });
});
