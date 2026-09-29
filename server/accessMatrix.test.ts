import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MATRIX, MODULES, ROLES, can, scopeFor, isBelow, rolesBelow, assignableRoles, canManageUserRole,
  canGrantPermissionsTo, canTouchPermission, canSeeFinanceTotalsFor, isNationalRole, type ModuleId, type Role,
} from "../shared/access";
import { renderPermissoesDoc } from "../shared/accessDoc";
import { requireAccess } from "./_core/access";
import { MIGRATION_0096_STATEMENTS, USER_ROLE_ENUM_0096 } from "./migrations/migration_0096";

const root = resolve(import.meta.dirname, "..");
const sees = (role: Role, m: ModuleId) => can(role, m, "view");

describe("matriz de acessos — papéis do dono", () => {
  it("user: a própria ficha, Formação e Disponibilidade — e mais nada", () => {
    const allowed = MODULES.filter(m => sees("user", m.id)).map(m => m.id).sort();
    expect(allowed).toEqual(["disponibilidade", "ficha", "formacao"]);
    expect(scopeFor("user", "ficha")).toBe("own");
    expect(can("user", "ficha", "edit")).toBe(true);
  });

  it("extra: user + avaliação/histórico/ocorrências próprios, serviços, PDAs e tarefas", () => {
    for (const m of ["avaliacao", "historico_diario", "reclamacoes", "criticas", "ocorrencias"] as ModuleId[]) {
      expect(scopeFor("extra", m)).toBe("own");
    }
    expect(sees("extra", "servicos")).toBe(true);
    expect(can("extra", "pdas", "edit")).toBe(true);
    expect(can("extra", "tarefas", "edit")).toBe(true);
    for (const m of ["despesas", "reservas_operacoes", "extras_dia", "perdidos", "rh", "whatsapp"] as ModuleId[]) {
      expect(sees("extra", m)).toBe(false);
    }
  });

  it("condutor: extra + as próprias despesas, Reservas e Extras-dia (cidade), perdidos próprios", () => {
    expect(scopeFor("condutor", "despesas")).toBe("own");
    expect(can("condutor", "despesas", "edit")).toBe(true);
    expect(scopeFor("condutor", "reservas_operacoes")).toBe("city");
    expect(scopeFor("condutor", "extras_dia")).toBe("city");
    expect(can("condutor", "extras_dia", "edit")).toBe(false);
    expect(scopeFor("condutor", "perdidos")).toBe("own");
    expect(sees("condutor", "parcerias")).toBe(false);
    expect(sees("condutor", "rh")).toBe(false);
  });

  it("team_leader: equipa na cidade + módulos operacionais, sem o Resumo do dia", () => {
    expect(scopeFor("team_leader", "despesas")).toBe("below_city");
    expect(scopeFor("team_leader", "rh")).toBe("below_city");
    expect(scopeFor("team_leader", "tarefas")).toBe("below_city");
    expect(scopeFor("team_leader", "avaliacao")).toBe("below_city");
    expect(can("team_leader", "formacao", "edit")).toBe(true);
    expect(can("team_leader", "extras_dia", "edit")).toBe(true);
    for (const m of ["parcerias", "leads_extras", "reservas_operacoes", "servicos", "atividade_diaria", "passagem_turno",
      "disponibilidade_extras", "whatsapp", "clientes", "reclamacoes", "criticas", "ocorrencias", "perdidos"] as ModuleId[]) {
      expect(scopeFor("team_leader", m)).toBe("city");
    }
    expect(sees("team_leader", "passagem_resumo_dia")).toBe(false);
    for (const m of ["utilizadores", "permissoes", "sincronizacao", "integracoes"] as ModuleId[]) {
      expect(sees("team_leader", m)).toBe(false);
    }
  });

  it("supervisor: team_leader + Utilizadores, Permissões, Sincronização e Integrações da cidade", () => {
    for (const m of ["utilizadores", "permissoes", "sincronizacao", "integracoes"] as ModuleId[]) {
      expect(scopeFor("supervisor", m)).toBe("city");
    }
    expect(can("supervisor", "permissoes", "manage")).toBe(true);
    expect(isNationalRole("supervisor")).toBe(false);
  });

  it("backoffice: o supervisor a nível nacional; frontoffice: backoffice sem Permissões", () => {
    for (const m of ["utilizadores", "permissoes", "sincronizacao", "integracoes", "rh", "despesas", "whatsapp"] as ModuleId[]) {
      expect(scopeFor("backoffice", m)).toBe("national");
    }
    expect(sees("frontoffice", "permissoes")).toBe(false);
    for (const m of MODULES.map(x => x.id).filter(id => id !== "permissoes")) {
      expect(MATRIX[m].frontoffice).toEqual(MATRIX[m].backoffice);
    }
  });

  it("admin: backoffice + Financeiro (sem Faturação) e Dashboards; sem Marketing, Logs, Faturação nem Anual", () => {
    expect(sees("admin", "financeiro")).toBe(true);
    expect(sees("admin", "dashboards")).toBe(true);
    expect(can("admin", "permissoes", "manage")).toBe(true);
    for (const m of ["marketing", "logs", "faturacao", "anual"] as ModuleId[]) {
      expect(sees("admin", m)).toBe(false);
      expect(sees("super_admin", m)).toBe(true);
      // só super_admin
      expect(ROLES.filter(r => sees(r, m))).toEqual(["super_admin"]);
    }
    expect(sees("backoffice", "dashboards")).toBe(false);
    expect(sees("backoffice", "financeiro")).toBe(false);
  });

  it("super_admin: tudo, com todas as ações que existem no módulo", () => {
    for (const m of MODULES) {
      expect(sees("super_admin", m.id)).toBe(true);
      for (const r of ROLES) {
        for (const a of MATRIX[m.id][r].actions) expect(MATRIX[m.id].super_admin.actions).toContain(a);
      }
    }
  });

  it("herança: cada papel tem pelo menos as ações do papel abaixo (salvo frontoffice/Permissões)", () => {
    const chain: Role[] = ["user", "extra", "condutor", "team_leader", "supervisor", "backoffice", "admin", "super_admin"];
    for (const m of MODULES) {
      for (let i = 1; i < chain.length; i++) {
        const lower = MATRIX[m.id][chain[i - 1]], upper = MATRIX[m.id][chain[i]];
        if (lower.access === "none") continue;
        // Marketing/Logs/Faturação/Anual: correção explícita do dono (admin fica sem eles).
        for (const a of lower.actions) expect({ m: m.id, role: chain[i], has: upper.actions.includes(a) }).toEqual({ m: m.id, role: chain[i], has: true });
      }
    }
  });

  it("papel desconhecido não tem nada", () => {
    for (const m of MODULES) expect(can("director", m.id)).toBe(false);
    expect(can(null, "ficha")).toBe(false);
  });
});

describe("requireAccess (servidor)", () => {
  it("recusa quem não tem o módulo ou a ação", () => {
    expect(() => requireAccess({ id: 1, role: "extra" }, "whatsapp", "view")).toThrow();
    expect(() => requireAccess({ id: 1, role: "team_leader" }, "whatsapp", "edit")).not.toThrow();
    expect(() => requireAccess({ id: 1, role: "backoffice" }, "whatsapp", "manage")).toThrow();
    expect(() => requireAccess({ id: 1, role: "admin" }, "marketing", "view")).toThrow();
    expect(() => requireAccess(null, "ficha", "view", { allowOwn: true })).toThrow();
  });
  it("alcance 'own' só passa quando o procedimento filtra o próprio (allowOwn)", () => {
    expect(() => requireAccess({ id: 1, role: "condutor" }, "despesas", "view")).toThrow();
    expect(requireAccess({ id: 1, role: "condutor" }, "despesas", "view", { allowOwn: true })).toBe("own");
    expect(requireAccess({ id: 1, role: "team_leader" }, "despesas", "view")).toBe("below_city");
  });
});

describe("hierarquia, utilizadores e permissões", () => {
  it("abaixo de: condutor entre extra e team_leader; frontoffice = backoffice", () => {
    expect(isBelow("team_leader", "condutor")).toBe(true);
    expect(isBelow("condutor", "extra")).toBe(true);
    expect(isBelow("condutor", "team_leader")).toBe(false);
    expect(isBelow("backoffice", "frontoffice")).toBe(false);
    expect(rolesBelow("team_leader")).toEqual(["user", "extra", "condutor"]);
  });
  it("quem atribui que papéis", () => {
    expect(assignableRoles("team_leader")).toEqual([]);
    expect(assignableRoles("supervisor")).toEqual(["user", "extra", "condutor", "team_leader", "supervisor"]);
    expect(assignableRoles("admin")).not.toContain("admin");
    expect(assignableRoles("super_admin")).toEqual([...ROLES]);
    expect(canManageUserRole("supervisor", "admin")).toBe(false);
    expect(canManageUserRole("supervisor", "condutor")).toBe(true);
    expect(canManageUserRole("admin", "super_admin")).toBe(false);
  });
  it("Permissões: supervisor/backoffice não mexem em admins; admin só abaixo dele; frontoffice nada", () => {
    expect(canGrantPermissionsTo("supervisor", "backoffice")).toBe(true);
    expect(canGrantPermissionsTo("supervisor", "admin")).toBe(false);
    expect(canGrantPermissionsTo("backoffice", "admin")).toBe(false);
    expect(canGrantPermissionsTo("admin", "backoffice")).toBe(true);
    expect(canGrantPermissionsTo("admin", "admin")).toBe(false);
    expect(canGrantPermissionsTo("super_admin", "admin")).toBe(true);
    expect(canGrantPermissionsTo("frontoffice", "user")).toBe(false);
    expect(canTouchPermission("supervisor", "city.extra.porto")).toBe(false);
    expect(canTouchPermission("backoffice", "city.extra.porto")).toBe(true);
    expect(canTouchPermission("supervisor", "finance.view_totals")).toBe(false);
    expect(canTouchPermission("supervisor", "extras_dia.team_leader")).toBe(true);
  });
  it("totais financeiros: admin+ por defeito; grant abre a supervisor/backoffice; deny retira", () => {
    expect(canSeeFinanceTotalsFor("admin")).toBe(true);
    expect(canSeeFinanceTotalsFor("backoffice")).toBe(false);
    expect(canSeeFinanceTotalsFor("backoffice", { "finance.view_totals": "grant" })).toBe(true);
    expect(canSeeFinanceTotalsFor("team_leader", { "finance.view_totals": "grant" })).toBe(false);
    expect(canSeeFinanceTotalsFor("admin", { "finance.view_totals": "deny" })).toBe(false);
  });
});

describe("papel condutor — migração e esquema", () => {
  it("a migração 0096 é idempotente (MODIFY com a lista completa) e não converte ninguém", () => {
    expect(MIGRATION_0096_STATEMENTS).toHaveLength(1);
    const stmt = MIGRATION_0096_STATEMENTS[0];
    expect(stmt).toMatch(/^ALTER TABLE `users` MODIFY COLUMN `role` ENUM\(/);
    expect(stmt).not.toMatch(/UPDATE/i);
    expect([...USER_ROLE_ENUM_0096].sort()).toEqual([...ROLES].sort());
  });
  it("drizzle/schema.ts tem o mesmo enum", () => {
    const schema = readFileSync(resolve(root, "drizzle/schema.ts"), "utf8");
    const m = schema.match(/role: mysqlEnum\(\[([^\]]*)\]\)/);
    expect(m).not.toBeNull();
    const values = m![1].split(",").map(v => v.trim().replace(/'/g, ""));
    expect(values).toEqual([...USER_ROLE_ENUM_0096]);
  });
  it("registada no ensureRecentSchema, por ordem numérica", () => {
    const db = readFileSync(resolve(root, "server/db.ts"), "utf8");
    const nums = [...db.matchAll(/import\("\.\/migrations\/migration_(\d{4})"\)\.then\(m => \(\{ s: m\.MIGRATION_/g)].map(x => Number(x[1]));
    expect(nums).toContain(96);
    expect(nums.indexOf(96)).toBe(nums.indexOf(95) + 1);
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
  });
});

describe("docs/permissoes.md", () => {
  it("está em dia com a matriz (regenerar: pnpm tsx scripts/gen-permissoes-doc.ts)", () => {
    const doc = readFileSync(resolve(root, "docs/permissoes.md"), "utf8");
    expect(doc).toBe(renderPermissoesDoc());
  });
});
