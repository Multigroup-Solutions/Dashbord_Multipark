/**
 * P3 lote 25b — decisões do Jorge (3 out 2026):
 *  - D49: mudam o IBAN de OUTRA pessoa na hora: back office, supervisor, admin
 *    e super admin. Front office e team leader não (fica pedido). O próprio
 *    pede sempre; os pedidos vão para o RH (back office / admin / super admin);
 *  - D45: aviso no sino "Nova tarefa para ti" (interruptor desligado); as
 *    tarefas automáticas ficam de fora.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { canApproveIbanRequests, canChangeIbanDirectly, employeeAccess, type RhViewer } from "./rhAccess";
import { isManualTask, newAssigneeIds, notifyTaskAssignedWith, TASK_ASSIGNED_FLAG, type TaskAssignedDeps } from "./taskAssignNotify";
import { kindDef } from "../shared/notificationRouting";
import { KIND_SOURCES } from "../shared/notificationRoutingDoc";
import { AUTOMATION_FLAGS } from "../shared/appSettings";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("D49 — IBAN na hora", () => {
  const viewer = (role: string, extra: Partial<RhViewer> = {}): RhViewer => ({ id: 1, role, employeeId: 10, scopeProjectIds: [5], ...extra });
  const other = { id: 20, projectId: 5, role: "extra" };
  const own = { id: 10, projectId: 5, role: "backoffice" };

  it("back office, supervisor (da sua cidade), admin e super admin mudam o de outra pessoa", () => {
    for (const r of ["backoffice", "supervisor", "admin", "super_admin"]) expect(canChangeIbanDirectly(viewer(r), other)).toBe(true);
    expect(canChangeIbanDirectly(viewer("supervisor", { scopeProjectIds: [9] }), other)).toBe(false);
  });
  it("front office e team leader não (fica pedido); o próprio pede sempre (menos o super admin)", () => {
    for (const r of ["frontoffice", "team_leader", "condutor", "extra", "user"]) expect(canChangeIbanDirectly(viewer(r), other)).toBe(false);
    for (const r of ["backoffice", "supervisor", "admin"]) expect(canChangeIbanDirectly(viewer(r), own)).toBe(false);
    expect(canChangeIbanDirectly(viewer("super_admin"), own)).toBe(true);
  });
  it("aprovam pedidos: back office, supervisor (da sua cidade), admin e super admin — nunca o da própria ficha", () => {
    for (const r of ["backoffice", "supervisor", "admin", "super_admin"]) expect(canApproveIbanRequests(viewer(r), other)).toBe(true);
    for (const r of ["frontoffice", "team_leader"]) expect(canApproveIbanRequests(viewer(r), other)).toBe(false);
    expect(canApproveIbanRequests(viewer("supervisor", { scopeProjectIds: [9] }), other)).toBe(false);
    expect(canApproveIbanRequests(viewer("backoffice"), own)).toBe(false);
    expect(employeeAccess(viewer("supervisor"), other)).toMatchObject({ canChangeIban: true, canApproveIban: true });
    expect(employeeAccess(viewer("frontoffice"), other)).toMatchObject({ canChangeIban: false, canApproveIban: false });
  });
  it("servidor e ecrã usam as regras novas; o aviso vai ao back office e não a quem pediu", () => {
    const r = src("server/rhRouter.ts");
    expect(r).toContain("canChangeIbanDirectly(viewer, ref)");
    expect(r.match(/canApproveIbanRequests\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src("client/src/pages/HRPage.tsx")).toContain('["backoffice", "supervisor", "admin", "super_admin"].includes(userRole)');
    expect(kindDef("rh_bank_change")?.roles).toEqual(["backoffice", "supervisor"]);
    expect(src("server/rhBankChange.ts")).toContain("recipientFilter: (c) => c.id !== requestedById");
  });
});

describe("D45 — Nova tarefa para ti", () => {
  const deps = (over: Partial<TaskAssignedDeps> = {}) => {
    const notify = vi.fn(async () => undefined);
    return { notify, d: { flagOn: async () => true, userIdsOfEmployees: async (ids: number[]) => ids.map((i) => i * 100), notify, ...over } as TaskAssignedDeps };
  };
  const task = { id: 7, title: "Limpar o parque", sourceModule: "manual", projectId: 3, dueDate: "2026-10-05 23:59:59" };

  it("só tarefas feitas por pessoas; só quem entrou agora", () => {
    expect(isManualTask({ sourceModule: "manual" })).toBe(true);
    expect(isManualTask({ sourceModule: null })).toBe(true);
    for (const s of ["template", "service", "availability", "rh", "google_tasks"]) expect(isManualTask({ sourceModule: s })).toBe(false);
    expect(newAssigneeIds([1, 2, 3, 2, null], [2])).toEqual([1, 3]);
    expect(newAssigneeIds([2], [2])).toEqual([]);
  });

  it("avisa os responsáveis novos (nunca quem atribuiu), com prazo e autor", async () => {
    const { d, notify } = deps();
    expect(await notifyTaskAssignedWith(d, { task, employeeIds: [1, 2], byUserId: 200, byName: "Rui" })).toBe("notified");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      kind: "task_assigned", targetUserIds: [100], title: "Nova tarefa para ti",
      body: "Limpar o parque · prazo 05/10/2026 · de Rui", link: "/tarefas?focus=7", entity: { type: "task", id: 7 },
    }));
  });

  it("interruptor desligado, automática ou só o próprio → ninguém é avisado", async () => {
    const off = deps({ flagOn: async () => false });
    expect(await notifyTaskAssignedWith(off.d, { task, employeeIds: [1], byUserId: 9 })).toBe("flag_off");
    const auto = deps();
    expect(await notifyTaskAssignedWith(auto.d, { task: { ...task, sourceModule: "template" }, employeeIds: [1], byUserId: 9 })).toBe("not_manual");
    const self = deps();
    expect(await notifyTaskAssignedWith(self.d, { task, employeeIds: [1], byUserId: 100 })).toBe("nobody");
    for (const x of [off, auto, self]) expect(x.notify).not.toHaveBeenCalled();
  });

  it("tipo pessoal no sino + interruptor desligado por omissão + ligado no criar/editar", () => {
    expect(kindDef("task_assigned")).toMatchObject({ personal: true, module: "tarefas" });
    expect(KIND_SOURCES.task_assigned).toMatch(/TASK_ASSIGNED_NOTIFY/);
    expect(AUTOMATION_FLAGS.find((f) => f.name === TASK_ASSIGNED_FLAG)?.defaultEnabled).toBe(false);
    const r = src("server/tasksRouter.ts");
    expect(r.match(/await notifyTaskAssigned\(/g)?.length).toBe(3);
    expect(r).toContain("newAssigneeIds(assigneeIds ?? (input.assigneeId != null ? [input.assigneeId] : []), prevIds)");
    expect(src("server/taskAssignNotify.ts")).not.toMatch(/\.delete\(|DELETE FROM/);
  });
});
