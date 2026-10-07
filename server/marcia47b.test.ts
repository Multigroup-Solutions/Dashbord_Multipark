/**
 * Jorge (7 out 2026): "atenção ao supervisor só ver os da cidade dele, porque a
 * pessoa responsável pelo recrutamento, que não tem cidade, é a supervisora
 * (Márcia)". Supervisor com TODAS as cidades vê as fichas sem cidade; as
 * tarefas de candidatura vão também para a pessoa do recrutamento.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canManageEmployee, canViewEmployee, inScopeProject } from "./rhAccess";
import { leadTaskAssignees } from "../shared/leadTasks";
import { SETTINGS } from "../shared/appSettings";

const src = (p: string) => readFileSync(p, "utf8");
const semCidade = { id: 70, projectId: null, role: "extra", position: "extra" };
const deLisboa = { id: 71, projectId: 7, role: "extra", position: "extra" };

describe("Supervisor sem cidade (todas as cidades) vê as fichas sem cidade", () => {
  const marcia = { id: 1, role: "supervisor", employeeId: 2, scopeProjectIds: null, scopeAll: true };
  const doPorto = { id: 3, role: "supervisor", employeeId: 4, scopeProjectIds: [9] };
  it("todas as cidades: vê e gere a ficha sem cidade e a de qualquer cidade", () => {
    expect(inScopeProject(marcia, null)).toBe(true);
    expect(canViewEmployee(marcia, semCidade)).toBe(true);
    expect(canManageEmployee(marcia, semCidade)).toBe(true);
    expect(canManageEmployee(marcia, deLisboa)).toBe(true);
  });
  it("supervisor de uma cidade: continua só com a dele, sem as fichas sem cidade", () => {
    expect(inScopeProject(doPorto, null)).toBe(false);
    expect(canViewEmployee(doPorto, semCidade)).toBe(false);
    expect(canManageEmployee(doPorto, deLisboa)).toBe(false);
    expect(canManageEmployee(doPorto, { ...deLisboa, projectId: 9 })).toBe(true);
  });
});

describe("Tarefas de candidatura: a pessoa do recrutamento", () => {
  it("lead sem cidade fica com ela (antes ficava sem ninguém)", () => {
    expect(leadTaskAssignees({ ownerEmployeeId: null, supervisorEmployeeIds: [], recruiterEmployeeId: 2 })).toEqual([2]);
  });
  it("lead com cidade: ela primeiro e os supervisores da cidade, sem repetir", () => {
    expect(leadTaskAssignees({ ownerEmployeeId: null, supervisorEmployeeIds: [5, 2, 6], recruiterEmployeeId: 2 })).toEqual([2, 5, 6]);
  });
  it("lead criado à mão por alguém com ficha: fica com quem o criou", () => {
    expect(leadTaskAssignees({ ownerEmployeeId: 8, supervisorEmployeeIds: [5], recruiterEmployeeId: 2 })).toEqual([8]);
  });
  it("sem pessoa do recrutamento definida: como antes", () => {
    expect(leadTaskAssignees({ ownerEmployeeId: null, supervisorEmployeeIds: [5], recruiterEmployeeId: null })).toEqual([5]);
  });
  it("usa a mesma definição das fichas sem cidade e dá dono às tarefas órfãs", () => {
    expect((SETTINGS as any)["rh.missingCityAssignee"].label).toBe("Responsável pelo recrutamento e pelas fichas sem cidade");
    const s = src("server/leadTasks.ts");
    expect(s).toContain('getSetting("rh.missingCityAssignee")');
    expect(s).toContain("await assignOrphanLeadTasks(db, recruiter)");
    expect(s).toContain("recruiterEmployeeId: recruiter");
    expect(s.slice(s.indexOf("async function assignOrphanLeadTasks"), s.indexOf("/** Fichas ativas dos supervisores"))).not.toMatch(/\bDELETE\b/);
  });
});
