/**
 * Plano 63, passo 11 (auditoria): "Parceiro (empresa)" tira a pessoa da folha
 * de ordenados — é dinheiro. O supervisor e o back office mudam o tipo de
 * contrato (41c), mas pôr ou tirar este só um administrador.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEmployeeError, partnerContractChangeError, type EmployeeRef, type RhViewer } from "./rhAccess";

const src = (f: string) => readFileSync(resolve(__dirname, "..", f), "utf8");

describe("Parceiro (empresa): pôr ou tirar é dinheiro (sai/entra na folha) — só admin+", () => {
  const sup: RhViewer = { id: 5, role: "supervisor", employeeId: 50, scopeProjectIds: [10] };
  const backoffice: RhViewer = { id: 8, role: "backoffice", employeeId: 80, scopeProjectIds: null };
  const admin: RhViewer = { id: 1, role: "admin", employeeId: null, scopeProjectIds: null };
  const driver: EmployeeRef = { id: 101, projectId: 10, role: "driver", position: "driver" };
  it("supervisor e back office: não põem nem tiram; o resto do contrato continua deles", () => {
    expect(partnerContractChangeError(sup, driver, "permanent", "partner_company")).toMatch(/só um administrador/);
    expect(partnerContractChangeError(backoffice, driver, "partner_company", "permanent")).toMatch(/só um administrador/);
    expect(partnerContractChangeError(sup, driver, "permanent", "fixed_term")).toBeNull();
    expect(partnerContractChangeError(sup, driver, "permanent", undefined)).toBeNull();
  });
  it("reenviar o mesmo valor (formulário completo) não é mudança", () => {
    expect(partnerContractChangeError(sup, driver, "partner_company", "partner_company")).toBeNull();
  });
  it("admin: muda", () => {
    expect(partnerContractChangeError(admin, driver, "permanent", "partner_company")).toBeNull();
  });
  it("criar uma ficha já como parceiro-empresa: só admin+", () => {
    expect(createEmployeeError(sup, { position: "driver", projectId: 10, contractType: "partner_company" })).toMatch(/só um administrador cria/);
    expect(createEmployeeError(sup, { position: "driver", projectId: 10, contractType: "permanent" })).toBeNull();
    expect(createEmployeeError(admin, { position: "driver", projectId: 10, contractType: "partner_company" })).toBeNull();
  });
  it("o rh.create e o rh.update usam a guarda", () => {
    const r = src("server/rhRouter.ts");
    expect(r).toContain("contractType: input.contractType });");
    expect(r).toMatch(/partnerContractChangeError\(viewer, ref, \(await getEmployeeById\(input\.id\)\)\?\.employee\.contractType \?\? null, input\.contractType\)/);
  });
});
