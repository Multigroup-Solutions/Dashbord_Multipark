// Tarefas — "Gerar hoje" nas Checklists (pedido 6), Jorge 7 out 2026: "aparece
// acesso negado para alguns users e nao o conseguem usar".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canGenerateChecklists, templatesInScope } from "../shared/taskRules";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("Gerar hoje: quem gere as checklists, no seu âmbito", () => {
  it("matriz: supervisor, front/back office e admin+ sim; team leader e extra não", () => {
    for (const role of ["supervisor", "frontoffice", "backoffice", "admin", "super_admin"]) expect(canGenerateChecklists({ role })).toBe(true);
    for (const role of ["team_leader", "extra", "condutor", "user"]) expect(canGenerateChecklists({ role })).toBe(false);
  });
  it("as exceções por pessoa contam: dar 'gerir' dá o botão; tirar tira", () => {
    expect(canGenerateChecklists({ role: "team_leader", accessOverrides: { tarefas: { access: "city", actions: ["view", "edit", "manage"] } } })).toBe(true);
    expect(canGenerateChecklists({ role: "supervisor", accessOverrides: { tarefas: { access: "city", actions: ["view", "edit"] } } })).toBe(false);
    // "gerir" só no que é seu não chega (o servidor recusa o alcance "own").
    expect(canGenerateChecklists({ role: "extra", accessOverrides: { tarefas: { access: "own", actions: ["view", "edit", "manage"] } } })).toBe(false);
  });
  it("só os modelos das cidades de quem gera; os sem cidade só com acesso a todas", () => {
    const t = [{ id: 1, cityProjectId: 10 }, { id: 2, cityProjectId: 20 }, { id: 3, cityProjectId: null }];
    expect(templatesInScope(t, undefined).map((x) => x.id)).toEqual([1, 2, 3]);
    expect(templatesInScope(t, [10, 11]).map((x) => x.id)).toEqual([1]);
    expect(templatesInScope(t, []).map((x) => x.id)).toEqual([]);
  });
  it("o servidor usa o MESMO predicado (sem o papel admin), o âmbito e o registo; o botão também", () => {
    const r = src("server/tasksRouter.ts");
    const gen = r.slice(r.indexOf("generateNow:"));
    expect(gen).toContain("if (!canGenerateChecklists(u)) throw");
    expect(gen).toContain("generateTemplateTasks(new Date(), { projectIds: scope })");
    expect(gen).toContain('action: "task_templates_generate_now"');
    expect(gen.slice(0, gen.indexOf("}),"))).not.toContain('requireRole(ctx.user.role, "admin")');
    expect(src("server/tasksService.ts")).toContain("const templates = templatesInScope(");
    const p = src("client/src/pages/TasksPage.tsx");
    expect(p).toContain("const canGenerate = !!user && canGenerateChecklists(user as any);");
    expect(p).toContain("canGenerate={canGenerate}");
  });
});
