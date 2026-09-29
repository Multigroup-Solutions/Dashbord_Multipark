import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MODULES, can, effectiveGrants, grantFor, normalizeGrant, overrideActive, roleGrantFor, scopeFor, canSeeFinanceTotalsFor,
  type AccessOverrides, type ModuleOverride,
} from "../shared/access";
import { SUPER_ADMIN_ONLY_MODULES, describeGrant, overrideChangeError, overrideTargetError, withinReach } from "../shared/accessOverrides";
import { requireAccess } from "./_core/access";
import { accessRequest, adjustCityScope, moduleForPath } from "./_core/accessContext";
import { cityScope, scopedProjectIds } from "./cityScope";
import type { CityAccess } from "./cityAccess";
import { moduleOverrideFromRow, moduleOverridesFromRows } from "./db";
import { MIGRATION_0100_STATEMENTS, IDEMPOTENT_ERROR_CODES_0100 } from "./migrations/migration_0100";

const root = resolve(import.meta.dirname, "..");
const u = (role: string, accessOverrides?: AccessOverrides, id = 1) => ({ id, role, accessOverrides });
const cityGrant: ModuleOverride = { access: "city", actions: ["view", "edit"] };

describe("resolver: papel + overrides", () => {
  it("o override tem precedência sobre o papel (dar e retirar)", () => {
    // TL não tem Dashboards; com override passa a ter.
    expect(can("team_leader", "dashboards")).toBe(false);
    expect(can(u("team_leader", { dashboards: { access: "national", actions: ["view"] } }), "dashboards")).toBe(true);
    // Retirar: supervisor perde o WhatsApp.
    const noWa = u("supervisor", { whatsapp: { access: "none", actions: [] } });
    expect(can(noWa, "whatsapp")).toBe(false);
    expect(grantFor(noWa, "whatsapp")).toEqual({ access: "none", actions: [] });
    // Os outros módulos ficam como o papel.
    expect(grantFor(noWa, "rh")).toEqual(roleGrantFor("supervisor", "rh"));
    // O override substitui por inteiro (não soma ações do papel).
    const narrow = u("admin", { despesas: { access: "national", actions: ["view"] } });
    expect(can(narrow, "despesas", "manage")).toBe(false);
    expect(can("admin", "despesas", "manage")).toBe(true);
  });

  it("ver está sempre incluído e ações inválidas desaparecem", () => {
    expect(normalizeGrant({ access: "city", actions: ["edit"] })).toEqual({ access: "city", actions: ["view", "edit"] });
    expect(normalizeGrant({ access: "none", actions: ["view"] })).toEqual({ access: "none", actions: [] });
    expect(describeGrant({ access: "city", actions: ["view", "export"] })).toBe("cidade: ver, exportar");
    expect(describeGrant(null)).toBe("padrão do papel");
  });

  it("validade: inclusiva até ao dia; expirado volta ao papel", () => {
    const o: AccessOverrides = { rh: { access: "city", actions: ["view"], expiresOn: "2026-09-30" } };
    expect(overrideActive(o.rh, "2026-09-30")).toBe(true);
    expect(overrideActive(o.rh, "2026-10-01")).toBe(false);
    expect(grantFor(u("condutor", o), "rh", "2026-09-30").access).toBe("city");
    expect(grantFor(u("condutor", o), "rh", "2026-10-01").access).toBe("none");
    expect(overrideActive({ expiresOn: null }, "2099-01-01")).toBe(true);
  });

  it("alcance mais estreito: backoffice nacional → só cidade; own exige allowOwn", () => {
    const bo = u("backoffice", { despesas: { access: "city", actions: ["view"] }, servicos: { access: "own", actions: ["view"] } });
    expect(scopeFor(bo, "despesas")).toBe("city");
    expect(requireAccess(bo, "despesas", "view")).toBe("city");
    expect(() => requireAccess(bo, "despesas", "export")).toThrow();
    expect(() => requireAccess(bo, "servicos", "view")).toThrow();
    expect(requireAccess(bo, "servicos", "view", { allowOwn: true })).toBe("own");
  });

  it("effectiveGrants diz de onde vem cada módulo", () => {
    const eff = effectiveGrants(u("extra", { rh: cityGrant }));
    expect(eff.rh).toEqual({ access: "city", actions: ["view", "edit"], source: "override" });
    expect(eff.ficha.source).toBe("role");
    expect(Object.keys(eff).sort()).toEqual(MODULES.map(m => m.id).sort());
  });

  it("o Financeiro por override também abre os totais financeiros", () => {
    expect(canSeeFinanceTotalsFor(u("backoffice"))).toBe(false);
    expect(canSeeFinanceTotalsFor(u("backoffice", { financeiro: { access: "national", actions: ["view"] } }))).toBe(true);
    expect(canSeeFinanceTotalsFor(u("admin", { financeiro: { access: "none", actions: [] } }))).toBe(false);
  });

  it("requireAccess usa os overrides do pedido quando o objeto não os traz", async () => {
    await accessRequest.run({ userId: 7, overrides: { dashboards: { access: "national", actions: ["view"] } } }, async () => {
      expect(requireAccess({ id: 7, role: "team_leader" }, "dashboards")).toBe("national");
      // Outra pessoa no mesmo pedido: só o papel.
      expect(() => requireAccess({ id: 8, role: "team_leader" }, "dashboards")).toThrow();
    });
    expect(() => requireAccess({ id: 7, role: "team_leader" }, "dashboards")).toThrow();
  });
});

describe("linhas de user_permissions → overrides", () => {
  it("module.<id> grant/deny, letras e validade; chaves antigas ignoradas", () => {
    expect(moduleOverrideFromRow({ permission: "module.rh", mode: "grant", scope: "city", actions: "vex", expiresOn: null }))
      .toEqual({ module: "rh", override: { access: "city", actions: ["view", "edit", "export"], expiresOn: null } });
    expect(moduleOverrideFromRow({ permission: "module.rh", mode: "deny", scope: "city", actions: "v", expiresOn: null })?.override.access).toBe("none");
    expect(moduleOverrideFromRow({ permission: "module.naoexiste", mode: "grant", scope: "city", actions: "v", expiresOn: null })).toBeNull();
    expect(moduleOverrideFromRow({ permission: "finance.view_totals", mode: "grant", scope: null, actions: null, expiresOn: null })).toBeNull();
    const ov = moduleOverridesFromRows([
      { permission: "module.rh", mode: "grant", scope: "city", actions: "v", expiresOn: "2026-01-01" },
      { permission: "module.pdas", mode: "grant", scope: "national", actions: "ve", expiresOn: "2026-12-31" },
    ], "2026-09-24");
    expect(Object.keys(ov)).toEqual(["pdas"]);
  });
});

describe("guardas: quem pode dar o quê", () => {
  const sup = { id: 10, role: "supervisor" };
  const adm = { id: 20, role: "admin" };
  const sa = { id: 30, role: "super_admin" };
  const tl = { id: 40, role: "team_leader", inActorCity: true };

  it("não dá mais do que tem (alcance e ações)", () => {
    // Supervisor tem Serviços "cidade: ver, editar".
    expect(overrideChangeError(sup, tl, "servicos", { access: "city", actions: ["view", "edit"] }, null)).toBeNull();
    expect(overrideChangeError(sup, tl, "servicos", { access: "national", actions: ["view"] }, null)).toMatch(/mais do que tens/);
    expect(overrideChangeError(sup, tl, "servicos", { access: "city", actions: ["view", "manage"] }, null)).toMatch(/mais do que tens/);
    // Módulo que o supervisor não tem.
    expect(overrideChangeError(sup, tl, "financeiro", { access: "city", actions: ["view"] }, null)).toMatch(/não tens acesso/);
    // Retirar cabe sempre no alcance.
    expect(overrideChangeError(sup, tl, "servicos", { access: "none", actions: [] }, null)).toBeNull();
    // Os próprios overrides do ator contam como o que ele tem.
    const supNat = { ...sup, accessOverrides: { servicos: { access: "national", actions: ["view", "edit"] } } as AccessOverrides };
    expect(overrideChangeError(supNat, tl, "servicos", { access: "national", actions: ["view"] }, null)).toBeNull();
    expect(withinReach({ access: "city", actions: ["view"] }, { access: "below_city", actions: ["view"] })).toBe(true);
    expect(withinReach({ access: "below_city", actions: ["view"] }, { access: "city", actions: ["view"] })).toBe(false);
  });

  it("não mexe em overrides dados por quem tem mais nem repõe para mais do que tem", () => {
    const fromAdmin: ModuleOverride = { access: "national", actions: ["view", "edit"] };
    expect(overrideChangeError(sup, tl, "servicos", null, fromAdmin)).toMatch(/mais acesso/);
    expect(overrideChangeError(adm, tl, "servicos", null, fromAdmin)).toBeNull();
    // Repor o padrão de um backoffice (nacional) seria dar mais do que um supervisor tem —
    // e o supervisor nem pode mexer em papéis nacionais.
    expect(overrideChangeError(sup, { id: 50, role: "backoffice", inActorCity: true }, "servicos", null, { access: "city", actions: ["view"] })).toMatch(/acima do teu papel/);
  });

  it("Marketing, Logs, Faturação e API Keys: só super_admin", () => {
    expect([...SUPER_ADMIN_ONLY_MODULES].sort()).toEqual(["api_keys", "faturacao", "logs", "marketing"]);
    const target = { id: 60, role: "backoffice", inActorCity: true };
    for (const m of SUPER_ADMIN_ONLY_MODULES) {
      expect(overrideChangeError(adm, target, m, { access: "national", actions: ["view"] }, null)).toMatch(/super admin/);
      expect(overrideChangeError(adm, target, m, { access: "none", actions: [] }, null)).toMatch(/super admin/);
      expect(overrideChangeError(sa, target, m, { access: "national", actions: ["view"] }, null)).toBeNull();
    }
    // Admin com override de Marketing continua sem o poder dar.
    const admMk = { ...adm, accessOverrides: { marketing: { access: "national", actions: ["view"] } } as AccessOverrides };
    expect(overrideChangeError(admMk, target, "marketing", { access: "national", actions: ["view"] }, null)).toMatch(/super admin/);
  });

  it("supervisor: só na sua cidade e nunca a admins; admin só abaixo dele", () => {
    expect(overrideTargetError(sup, { ...tl, inActorCity: false })).toMatch(/cidade/);
    expect(overrideTargetError(sup, { id: 70, role: "admin", inActorCity: true })).not.toBeNull();
    expect(overrideTargetError(sup, { id: 71, role: "super_admin", inActorCity: true })).not.toBeNull();
    expect(overrideTargetError(adm, { id: 72, role: "admin", inActorCity: true })).not.toBeNull();
    expect(overrideTargetError(adm, { id: 73, role: "backoffice", inActorCity: false })).toBeNull(); // nacional
    expect(overrideTargetError(sa, { id: 74, role: "admin", inActorCity: false })).toBeNull();
    // Sem Permissões → gerir, nada.
    expect(overrideTargetError({ id: 80, role: "frontoffice" }, tl)).toMatch(/Sem permissão/);
    expect(overrideTargetError({ id: 81, role: "team_leader" }, { id: 82, role: "extra", inActorCity: true })).toMatch(/Sem permissão/);
  });

  it("ninguém edita os próprios overrides (nem o super_admin)", () => {
    expect(overrideTargetError(sa, { id: 30, role: "super_admin", inActorCity: true })).toMatch(/próprias/);
    expect(overrideChangeError(sup, { id: 10, role: "supervisor", inActorCity: true }, "rh", { access: "city", actions: ["view"] }, null)).toMatch(/próprias/);
  });
});

describe("cidade: o override muda o alcance de cidade do pedido", () => {
  const lisboa: CityAccess = { all: false, defaultCityId: 1, cityName: "Lisboa", cityIds: [1], projectIds: [1, 11], missingCostCenter: false };
  const all: CityAccess = { all: true, defaultCityId: 1, cityIds: [1, 2], projectIds: [1, 11, 2, 22], missingCostCenter: false };

  it("nacional por override abre todas as cidades; sem override nada muda", async () => {
    await accessRequest.run({ userId: 5, cityBase: lisboa, cityAll: all }, () => cityScope.run(lisboa, async () => {
      adjustCityScope(5, "national", false);
      expect(scopedProjectIds()).toEqual([1, 11]);
      adjustCityScope(5, "national", true);
      await Promise.resolve();
      expect(scopedProjectIds()).toBeUndefined();
      // De volta a um módulo "cidade" no mesmo pedido: volta a Lisboa.
      adjustCityScope(5, "city", false);
      expect(scopedProjectIds()).toEqual([1, 11]);
    }));
  });

  it("nacional com override de cidade fica na cidade do centro de custos", async () => {
    await accessRequest.run({ userId: 6, cityBase: lisboa, cityAll: all }, () => cityScope.run(all, async () => {
      adjustCityScope(6, "city", true);
      expect(scopedProjectIds()).toEqual([1, 11]);
    }));
    // Outra pessoa / fora do pedido: não mexe.
    await accessRequest.run({ userId: 6, cityBase: lisboa, cityAll: all }, () => cityScope.run(all, async () => {
      adjustCityScope(99, "city", true);
      expect(scopedProjectIds()).toBeUndefined();
    }));
  });

  it("procedimentos → módulo (para o alcance antes dos guardas)", () => {
    expect(moduleForPath("expenses.list")).toBe("despesas");
    expect(moduleForPath("permissions.setModuleAccess")).toBe("permissoes");
    expect(moduleForPath("multipark.bookings")).toBeUndefined();
  });
});

describe("migração 0100", () => {
  it("alarga user_permissions de forma idempotente, sem subqueries nem UPDATEs", () => {
    for (const s of MIGRATION_0100_STATEMENTS) {
      expect(s).not.toMatch(/\(\s*SELECT/i);
      expect(s).not.toMatch(/^UPDATE|DELETE/i);
      if (/^CREATE TABLE/.test(s)) expect(s).toMatch(/IF NOT EXISTS/);
      expect(s).toMatch(/`user_permissions`/);
    }
    for (const col of ["scope", "actions", "expiresOn", "note", "createdAt"]) {
      expect(MIGRATION_0100_STATEMENTS.some(s => s.includes(`ADD COLUMN \`${col}\``))).toBe(true);
    }
    expect(IDEMPOTENT_ERROR_CODES_0100.has("ER_DUP_FIELDNAME")).toBe(true);
    expect(IDEMPOTENT_ERROR_CODES_0100.has("ER_DUP_KEYNAME")).toBe(true);
  });
  it("registada no ensureRecentSchema a seguir à 0098 e no schema drizzle", () => {
    const db = readFileSync(resolve(root, "server/db.ts"), "utf8");
    const nums = [...db.matchAll(/import\("\.\/migrations\/migration_(\d{4})"\)\.then\(m => \(\{ s: m\.MIGRATION_/g)].map(x => Number(x[1]));
    expect(nums).toContain(99);
    expect(nums.indexOf(99)).toBe(nums.indexOf(98) + 1);
    const schema = readFileSync(resolve(root, "drizzle/schema.ts"), "utf8");
    expect(schema).toMatch(/mysqlTable\("user_permissions"/);
    expect(schema).toMatch(/expiresOn: date\(/);
  });
});
