/**
 * 41c — Permissões do RH (Jorge, 7 out 2026): "cada um tem de poder alterar as
 * suas informações e carregar os seus ficheiros" e "o supervisor tem que ter
 * permissões para fazer tudo no RH da cidade dele".
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canManageEmployee, contractEditError, createEmployeeError, selfUploadDocTypeError, employeeAccess, inScopeProject, PERSONAL_FIELDS,
  type RhViewer, type EmployeeRef,
} from "./rhAccess";
import { roleGrantFor } from "../shared/access";
import { blockedSelfPathKind, ownRecordEmployeeId } from "./cityAccess";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

const sup: RhViewer = { id: 5, role: "supervisor", employeeId: 50, scopeProjectIds: [10, 11, 12] };
const admin: RhViewer = { id: 1, role: "admin", employeeId: null, scopeProjectIds: null };
const tl: RhViewer = { id: 6, role: "team_leader", employeeId: 60, scopeProjectIds: [10] };
const extraSelf: RhViewer = { id: 7, role: "extra", employeeId: 70, scopeProjectIds: null };
const driverInCity: EmployeeRef = { id: 80, projectId: 11, role: "condutor", position: "driver" };
const extraNoAccount: EmployeeRef = { id: 81, projectId: 12, role: null, position: "extra" };
const otherSupervisor: EmployeeRef = { id: 82, projectId: 10, role: "supervisor", position: "supervisor" };
const driverOtherCity: EmployeeRef = { id: 83, projectId: 99, role: "condutor", position: "driver" };

describe("41c — supervisor faz tudo no RH da sua cidade", () => {
  it("matriz: o supervisor gere o RH (na cidade)", () => {
    expect(roleGrantFor("supervisor", "rh")).toEqual({ access: "city", actions: ["view", "edit", "manage"] });
    expect(roleGrantFor("team_leader", "rh").actions).not.toContain("manage");
  });

  it("gere as fichas da cidade de quem está abaixo dele — não outros supervisores, outras cidades nem a dele", () => {
    expect(canManageEmployee(sup, driverInCity)).toBe(true);
    expect(canManageEmployee(sup, extraNoAccount)).toBe(true);
    expect(canManageEmployee(sup, otherSupervisor)).toBe(false);
    expect(canManageEmployee(sup, driverOtherCity)).toBe(false);
    expect(canManageEmployee(sup, { id: 50, projectId: 10, role: "supervisor" })).toBe(false);
    expect(canManageEmployee(tl, driverInCity)).toBe(false);
    expect(canManageEmployee(admin, driverOtherCity)).toBe(true);
    expect(canManageEmployee({ ...sup, scopeProjectIds: null, scopeAll: true }, driverOtherCity)).toBe(true);
    expect(inScopeProject(sup, 11)).toBe(true);
    expect(inScopeProject(sup, null)).toBe(false);
  });

  it("contrato: posto até team leader, centro da cidade, tipo e datas — dinheiro e conta só admin", () => {
    expect(contractEditError(sup, driverInCity, { position: "team_leader", projectId: 12, contractType: "fixed_term", contractStart: "2026-10-01", isActive: true })).toBeNull();
    expect(contractEditError(sup, driverInCity, { monthlySalary: "900" })).toMatch(/salário/);
    expect(contractEditError(sup, driverInCity, { userId: 3 })).toMatch(/conta associada/);
    expect(contractEditError(sup, driverInCity, { email: "x@multipark.pt" })).toMatch(/email de trabalho/);
    expect(contractEditError(sup, driverInCity, { position: "supervisor" })).toMatch(/abaixo d(ele|o supervisor)/);
    expect(contractEditError(sup, driverInCity, { projectId: 99 })).toMatch(/não é da tua cidade/);
    expect(contractEditError(sup, otherSupervisor, { position: "driver" })).toMatch(/Só admin/);
    expect(contractEditError(admin, driverOtherCity, { monthlySalary: "900", userId: 3 })).toBeNull();
    expect(contractEditError(sup, driverInCity, { fullName: "X" })).toBeNull();
  });

  it("criar ficha: o supervisor na cidade, abaixo dele, sem salário nem conta à mão", () => {
    expect(createEmployeeError(sup, { position: "extra", projectId: 11 })).toBeNull();
    expect(createEmployeeError(sup, { position: "backoffice", projectId: 11 })).toMatch(/abaixo d(ele|o supervisor)/);
    expect(createEmployeeError(sup, { position: "driver", projectId: 99 })).toMatch(/não é da tua cidade/);
    expect(createEmployeeError(sup, { position: "driver", projectId: 11, monthlySalary: "900" })).toMatch(/salário/);
    expect(createEmployeeError(sup, { position: "driver", projectId: 11, userId: 4 })).toMatch(/conta/);
    expect(createEmployeeError(tl, { position: "extra", projectId: 10 })).toMatch(/administrador, o back office ou o supervisor/);
    expect(createEmployeeError(admin, { position: "director", projectId: 99, monthlySalary: "3000", userId: 2 })).toBeNull();
  });

  it("o cliente sabe o que mostrar (canManage)", () => {
    expect(employeeAccess(sup, driverInCity).canManage).toBe(true);
    expect(employeeAccess(sup, driverInCity).canEditContract).toBe(false);
    expect(employeeAccess(sup, otherSupervisor).canManage).toBe(false);
  });

  it("rotas: horário, ausências, ponto e desativar pedem gerir a ficha (cidade + abaixo); o que mexe em todas as cidades fica com quem gere todas", () => {
    const r = src("server/rhRouter.ts");
    expect(r.match(/assertCanManageEmployee\(ctx\.user, /g)?.length).toBeGreaterThanOrEqual(5);
    expect(r).toContain("canManageEmployee(await rhViewer(ctx.user), await rhEmployeeRefOrThrow(input.id))");
    expect(r).toContain("requireNationalRhManage(ctx.user);");
    expect(r).toContain(`assertOwnOrScopedEmployee(ctx.user, input.employeeId, "supervisor");`);
    // dinheiro continua admin
    expect(r.split("salaryHistory: protectedProcedure")[1].slice(0, 300)).toContain(`"admin"`);
    const routers = src("server/routers.ts");
    const links = routers.split("identityLinks: router({")[1];
    for (const name of ["overview", "agentCrossCheck", "reconcileNow", "compareAgentList"]) {
      const block = links.split(`${name}: protectedProcedure`)[1].slice(0, 700);
      expect(block, name).toContain("requireNationalRhManage(ctx.user)");
    }
    expect(routers.split("linkAgent: protectedProcedure")[1].slice(0, 600)).toContain("assertAgentHoldersInScope");
    expect(src("server/rhGuards.ts")).toContain('const access = user.role === "supervisor" ? cityScope.getStore() : undefined;');
    expect(src("server/rhService.ts").split("export async function listSuspiciousTimeRecords")[1].slice(0, 600)).toContain("projectScope(employees.projectId)");
  });
});

describe("41c — cada um muda os seus dados e carrega os seus ficheiros", () => {
  it("n.º do documento e da carta são dados pessoais (o próprio muda)", () => {
    expect(PERSONAL_FIELDS).toContain("idDocNumber");
    expect(PERSONAL_FIELDS).toContain("drivingLicenseNumber");
  });

  it("na própria ficha carrega os seus documentos; contrato/termo/seguro são do RH", () => {
    const own: EmployeeRef = { id: 70, projectId: null };
    for (const t of ["id_card", "driving_license", "nib_proof", "address_proof", "photo", "other"]) expect(selfUploadDocTypeError(extraSelf, own, t), t).toBeNull();
    for (const t of ["contract", "extra_contract", "contract_annex", "responsibility_term", "work_accident_insurance"]) expect(selfUploadDocTypeError(extraSelf, own, t), t).toMatch(/RH/);
    expect(selfUploadDocTypeError(sup, driverInCity, "contract")).toBeNull();
  });

  it("sem centro de custos ou bloqueado: a própria ficha continua a funcionar (o ecrã usa o uploadBatch)", () => {
    expect(ownRecordEmployeeId("rh.documents.uploadBatch", { employeeId: 70 })).toBe(70);
    expect(ownRecordEmployeeId("rh.uploadPhoto", { employeeId: 70 })).toBe(70);
    expect(blockedSelfPathKind("rh.documents.uploadBatch")).toBe("own");
    expect(blockedSelfPathKind("rh.me")).toBe("self");
    expect(blockedSelfPathKind("rh.update")).toBeNull();
    expect(blockedSelfPathKind("rh.list")).toBeNull();
    const trpc = src("server/_core/trpc.ts");
    expect(trpc).toContain("blockedSelfPathKind(opts.path)");
    expect(trpc).toContain("allowed = target != null && mine === target;");
  });

  it("limites nos documentos (antes sem tamanho nem número)", () => {
    const r = src("server/rhRouter.ts");
    expect(r).toContain("fileBase64: z.string().max(DOC_MAX_BASE64_CHARS)");
    expect(r).toContain(".min(1).max(10)");
    expect(r.match(/await assertSelfUploadDocType\(ctx\.user, input\.employeeId, input\.docType\);/g)?.length).toBe(2);
  });

  it("ecrãs: quem não vê o RH abre a sua ficha; o bloqueio deixa carregar documentos; botões só a quem pode", () => {
    const hr = src("client/src/pages/HRPage.tsx");
    expect(hr).toContain(`!can(user as any, "rh", "view")`);
    expect(hr).toContain("{canManageRh && (");
    expect(hr).toContain("{canSalaries && (");
    expect(hr).toContain("N.º da carta de condução");
    expect(src("client/src/components/DashboardLayout.tsx")).toContain("<BlockedOwnDocuments />");
  });
});
