/**
 * P3 lote 20c — Logs: origem de cada registo, autor certo (nunca o 1.º super
 * admin por um automatismo), registos que não mudam de dono numa fusão,
 * contas desativadas em vez de apagadas, dados sensíveis mascarados, 24
 * meses (com o histórico do CRM/permissões sempre), marcadores de estado na
 * ficha, só o super admin, filtros e CSV seguro.
 */
import fs from "fs";
import path from "path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mem = vi.hoisted(() => ({ inserted: [] as any[], executed: [] as any[], dbOn: false, partnerUpdates: [] as any[], logs: [] as any[] }));

vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));
vi.mock("./db", async (original) => {
  const real = await original<any>();
  return {
    ...real,
    getUserPermissionOverrides: async () => ({}),
    getDb: async () => (mem.dbOn ? {
      insert: () => ({ values: async (v: any) => { mem.inserted.push(v); } }),
      execute: async (q: any) => { mem.executed.push(q); return [{ affectedRows: 0 }]; },
    } : null),
    getPartnerships: async () => [{ id: 5, name: "Hotel Sol", archivedAt: null }, { id: 6, name: "Velho", archivedAt: "2026-01-01 00:00:00" }],
    updatePartnership: async (id: number, patch: any) => { mem.partnerUpdates.push({ id, patch }); },
    logActivity: async (row: any) => { mem.logs.push(row); },
  };
});

import { appRouter } from "./routers";
import { maskSensitive } from "../shared/logMask";
import { csvCell, csvLine, groupLogEntities, logActionLabel } from "../shared/logsView";
import { can, grantFor } from "../shared/access";
import { ACTIVITY_LOG_KEEP_ACTIONS, ACTIVITY_LOG_KEEP_ENTITIES, ACTIVITY_LOG_RETENTION_MONTHS } from "./opsRules";
import { MIGRATION_0410_STATEMENTS, IDEMPOTENT_ERROR_CODES_0410, runMigration0410Data } from "./migrations/migration_0410";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const render = (q: any) => new MySqlDialect().sqlToQuery(q).sql;
const caller = (role: string, id = 1, accessOverrides: any = {}) =>
  appRouter.createCaller({ user: { id, role, name: "Rita", accessOverrides }, req: { headers: {} }, res: {} } as any);

beforeEach(() => { mem.inserted = []; mem.executed = []; mem.dbOn = false; mem.partnerUpdates = []; mem.logs = []; });

describe("20c máscara dos dados sensíveis", () => {
  it("IBAN, NIF, telefones, cartões e segredos ficam só com o fim; emails e ids ficam", () => {
    expect(maskSensitive("IBAN PT50000201231234567890154")).toBe("IBAN PT50 •••0154");
    expect(maskSensitive("NIF 123456789, telefone 912345678")).toBe("NIF •••6789, telefone •••678");
    expect(maskSensitive("ligar +351 912 345 678")).toBe("ligar •••678");
    expect(maskSensitive("cartão 4111 1111 1111 1111")).toBe("cartão •••1111");
    expect(maskSensitive('{"clientPhone":"+351912345678","nif":"123456789","email":"ana@x.pt","token":"abc"}'))
      .toBe('{"clientPhone":"•••678","nif":"•••789","email":"ana@x.pt","token":"•••"}');
    expect(maskSensitive('{"kinds":{"phone":"nif"}}')).toBe('{"kinds":{"phone":"nif"}}');
    expect(maskSensitive("Reserva #123456 · ficha #42 · 2026-10-02 00:15 · 45,50 €")).toBe("Reserva #123456 · ficha #42 · 2026-10-02 00:15 · 45,50 €");
    expect(maskSensitive(null)).toBeNull();
  });
  it("logActivity mascara sempre e grava a origem (ui com pessoa, system sem)", async () => {
    mem.dbOn = true;
    const { logActivity } = await vi.importActual<typeof import("./db")>("./db");
    // a função real usa getDb do próprio módulo; aqui confirma-se pelo código
    const src = read("server/db.ts");
    const fn = src.slice(src.indexOf("export async function logActivity"), src.indexOf("export async function getActivityLogs"));
    expect(fn).toMatch(/details: maskSensitive\(data\.details \?\? null\)/);
    expect(fn).toMatch(/source: data\.source \?\? \(Number\(data\.userId\) > 0 \? "ui" : "system"\)/);
    expect(typeof logActivity).toBe("function");
  });
  it("as escritas diretas também passam pela máscara (troca de contactos, reconciliação)", () => {
    expect(read("server/employeeContactSwap.ts")).toMatch(/details: maskSensitive\(JSON\.stringify\(/);
    expect(read("server/identityReconcile.ts")).toMatch(/\$\{maskSensitive\(details\.slice\(0, 2000\)\)\}, 'cron'\)/);
  });
});

describe("20c quem fez", () => {
  it("automatismos com autor 0 + origem, nunca o 1.º super admin", () => {
    const city = read("server/employeeCityFix.ts");
    expect(city).toMatch(/VALUES \(0, 'employee_city_auto'.*'cron'\)/s);
    expect(city).toMatch(/VALUES \(0, 'extra_city_requested'.*'cron'\)/s);
    const jobs = read("server/cronJobs.ts");
    expect(jobs).toMatch(/autoMergeConfident\(db, \{ deadlineAt: o\.deadlineAt - 15_000, userId: 0 \}\)/);
    expect(jobs).toMatch(/applyPartnerSync\(\{ userId: 0 \}\)/);
    expect(read("server/apiKeyAuth.ts")).toMatch(/source: "api_key"/);
    expect(read("server/identity.ts")).toMatch(/source: "site",\s*action: "employee_autocreate"/);
  });
  it("ligações ficha ↔ conta registadas por quem as fez (ou Sistema), não pela conta ligada", () => {
    const id = read("server/identity.ts");
    expect(id).toMatch(/const actorOf = \(by\?: LinkActor\)/);
    expect((id.match(/\.\.\.actorOf\(by\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(read("server/rhRouter.ts")).toMatch(/\}, \{ actorId: ctx\.user\.id \}\);/);
    expect(read("server/_core/oauth.ts")).toMatch(/linkEmployeesToUserByEmail\(database, account\.id, email, \{ actorId: account\.id, source: "ui" \}\)/);
  });
  it("numa fusão de contas os registos não mudam de dono e a conta antiga fica desativada (sem email)", () => {
    for (const f of ["server/identity.ts", "server/identityReconcile.ts"]) {
      const src = read(f);
      const list = src.slice(src.indexOf("USER_REF_COLUMNS: Array"), src.indexOf("];", src.indexOf("USER_REF_COLUMNS: Array")));
      expect(list, f).not.toMatch(/\["activity_logs"/);
      expect(src, f).not.toMatch(/DELETE FROM users/);
    }
    expect(read("server/identity.ts")).toMatch(/\.set\(\{ isActive: 0, email: null, loginMethod: `merged_into_/);
    expect(read("server/identityReconcile.ts")).toMatch(/UPDATE users SET isActive = 0, email = NULL, loginMethod/);
  });
});

describe("20c retenção e marcadores", () => {
  it("24 meses; o histórico do CRM e das permissões fica sempre", async () => {
    expect(ACTIVITY_LOG_RETENTION_MONTHS).toBe(24);
    expect(ACTIVITY_LOG_KEEP_ENTITIES).toContain("crm_client");
    expect(ACTIVITY_LOG_KEEP_ACTIONS).toEqual(expect.arrayContaining(["update_role", "set_permission", "set_module_access"]));
    mem.dbOn = true;
    const { purgeOldActivityLogs } = await vi.importActual<typeof import("./db")>("./db");
    expect(typeof purgeOldActivityLogs).toBe("function");
    const src = read("server/db.ts");
    expect(src).toMatch(/DELETE FROM activity_logs WHERE createdAt < \$\{cutoff\} AND entity NOT IN \(\$\{keepEntities\}\) AND action NOT IN \(\$\{keepActions\}\)/);
  });
  it("cidade pedida e ficha do site vivem na ficha (0410), com cópia única dos logs antigos", async () => {
    expect(MIGRATION_0410_STATEMENTS).toEqual(expect.arrayContaining([
      "ALTER TABLE `activity_logs` ADD COLUMN `source` VARCHAR(16) NULL",
      "ALTER TABLE `employees` ADD COLUMN `cityRequestedAt` TIMESTAMP NULL DEFAULT NULL",
      "ALTER TABLE `employees` ADD COLUMN `autoCreatedAt` TIMESTAMP NULL DEFAULT NULL",
    ]));
    expect(IDEMPOTENT_ERROR_CODES_0410.has("ER_DUP_FIELDNAME")).toBe(true);
    const ran: string[] = [];
    const done = await runMigration0410Data({ execute: async (q: any) => { ran.push(render(q)); return [[{ id: "x" }]]; } });
    expect(done).toEqual({ status: "skipped" });
    expect(ran).toHaveLength(1);
    const ran2: string[] = [];
    const applied = await runMigration0410Data({ execute: async (q: any) => { ran2.push(render(q)); return [[]]; } });
    expect(applied).toEqual({ status: "applied" });
    expect(ran2.some((s) => /SET e\.cityRequestedAt = x\.at/.test(s))).toBe(true);
    expect(ran2.some((s) => /SET e\.autoCreatedAt = x\.at/.test(s))).toBe(true);
    expect(ran2[ran2.length - 1]).toMatch(/INSERT INTO app_notification_maintenance/);
    const city = read("server/employeeCityFix.ts");
    expect(city).toMatch(/SELECT cityRequestedAt FROM employees WHERE id = /);
    expect(city).toMatch(/UPDATE employees SET cityRequestedAt = UTC_TIMESTAMP\(\)/);
    expect(read("server/mergeDuplicateExtras.ts")).toMatch(/e\.autoCreatedAt IS NOT NULL OR EXISTS/);
  });
});

describe("20c só o super admin", () => {
  it("os Logs não se dão por pessoa: um override antigo deixa de valer", async () => {
    const ov = { logs: { access: "national", actions: ["view"] } };
    expect(can({ role: "admin", accessOverrides: ov } as any, "logs", "view")).toBe(false);
    expect(grantFor({ role: "super_admin", accessOverrides: { logs: { access: "none", actions: [] } } } as any, "logs").access).toBe("national");
    await expect(caller("admin", 2, ov).logs.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("sem BD = erro (a página mostra-o), não 'nenhum log'", async () => {
    await expect(caller("super_admin").logs.list()).rejects.toThrow(/Base de dados indisponível/);
    await expect(caller("super_admin").logs.filterOptions()).rejects.toThrow(/Base de dados indisponível/);
  });
});

describe("20c apagar ≠ apagar", () => {
  it("'Eliminar' uma parceria arquiva-a (faturas e transações ficam) e regista o nome", async () => {
    const r = await caller("super_admin").partnerships.delete({ id: 5 });
    expect(r).toEqual({ success: true, alreadyArchived: false });
    expect(mem.partnerUpdates[0].id).toBe(5);
    expect(mem.partnerUpdates[0].patch.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(mem.logs[0]).toMatchObject({ action: "archive", entity: "partnership", entityId: 5 });
    expect(mem.logs[0].details).toMatch(/Parceria «Hotel Sol» arquivada/);
    expect(await caller("super_admin").partnerships.delete({ id: 6 })).toEqual({ success: true, alreadyArchived: true });
    expect(read("server/db.ts")).not.toMatch(/export async function deletePartnership/);
    expect(read("client/src/pages/PartnershipsPage.tsx")).toMatch(/Arquivar o parceiro/);
  });
  it("apagar um nó de projeto vazio fica registado com o nome", () => {
    expect(read("server/routers.ts")).toMatch(/details: `Nó «\$\{node\.name\}» \(\$\{node\.level\}/);
  });
});

describe("20c página", () => {
  it("CSV: aspas sempre e fórmulas desarmadas", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell("+351")).toBe(`"'+351"`);
    expect(csvCell("a;b\nc")).toBe('"a;b c"');
    expect(csvLine(["x", 1, null])).toBe('"x";"1";""');
  });
  it("entidades repetidas juntam-se; ações com nome", () => {
    expect(groupLogEntities(["employee", "employees", "task"])).toEqual([
      { value: "employee|employees", label: "employee (employees)" },
      { value: "task", label: "task" },
    ]);
    expect(logActionLabel("archive")).toBe("Arquivou");
    expect(logActionLabel("whatever")).toBe("whatever");
  });
  it("erro ≠ vazio, filtros novos, origem visível, só pela matriz", () => {
    const page = read("client/src/pages/LogsPage.tsx");
    expect(page).toMatch(/logsQ\.error \?/);
    expect(page).toMatch(/what="os logs"/);
    expect(page).toMatch(/trpc\.logs\.filterOptions\.useQuery/);
    expect(page).toMatch(/Só automático \(Sistema\)/);
    expect(page).toMatch(/aria-label="Filtrar por origem"/);
    expect(page).toMatch(/Registo #/);
    expect(page).toMatch(/csvLine\(\[/);
    expect(page).toMatch(/can\(currentUser as any, "logs", "view"\)/);
    expect(page).toMatch(/retenção: 24 meses/);
  });
});
