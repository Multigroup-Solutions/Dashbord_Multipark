/**
 * Lote 43b/43c — Atividade diária (Jorge, 7 out 2026): o Rádio passa para
 * dentro da Atividade diária; os alertas "sem PDA ou Zello" pequenos e de
 * lado; as tarefas da disponibilidade já não vão para a Kamila por omissão.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { operationalAccess } from "../shared/operationalTabs";
import { availabilityTaskAssigneeEmail, DEFAULT_AVAILABILITY_TASK_ASSIGNEE_EMAIL } from "../shared/taskRules";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("43b — Rádio dentro da Atividade diária", () => {
  it("separador para quem vê o Rádio; quem só tem o Rádio também entra; o condutor não perde o próprio histórico", () => {
    expect(operationalAccess({ role: "supervisor" } as any).tabs).toContain("radio");
    expect(operationalAccess({ role: "condutor" } as any).ownSpeedOnly).toBe(true);
    // a regra: o Rádio entra depois de decidir o "só o próprio histórico"
    expect(src("shared/operationalTabs.ts")).toMatch(/const ownSpeedOnly = [^\n]+\n\s*if \(can\(user, "radio", "view"\)\) tabs\.push\("radio"\);/);
  });

  it("o endereço antigo vai lá ter; o menu tem uma entrada só (Actividade Diária também para quem só tem o Rádio)", () => {
    const app = src("client/src/App.tsx");
    expect(app).toMatch(/<Route path="\/radio">\s*\{\(\) => <Redirect to="\/operacional\?tab=radio" replace \/>\}/);
    expect(app).not.toContain("<RadioPage />");
    const menu = src("client/src/components/DashboardLayout.tsx");
    expect(menu).toContain('anyOf: ["atividade_diaria", "historico_diario", "radio"]');
    expect(menu).not.toContain('label: "Rádio", path: "/radio"');
    expect(src("shared/globalSearch.ts")).toContain('path: "/operacional?tab=radio"');
    const page = src("client/src/pages/OperationalPage.tsx");
    expect(page).toContain('{has("radio") && <TabsContent value="radio">{tab === "radio" && <RadioPage />}</TabsContent>}');
  });
});

describe("43b — alertas sem PDA ou Zello de lado", () => {
  it("pequenos, encolhem, a nota só abre se for preciso; na aba PDAs ficam ao lado", () => {
    const panel = src("client/src/components/OpsPresencePanel.tsx");
    expect(panel).toContain('usePersistedState("pdas.presence.collapsed", false)');
    expect(panel).toContain("+ nota");
    expect(panel).toContain("{!isLoading && !failed && open.length === 0"); // erro ≠ vazio continua
    const page = src("client/src/pages/OperationalPage.tsx");
    expect(page).toContain('<aside className="order-first min-w-0 lg:order-last lg:sticky lg:top-4"><OpsPresencePanel /></aside>');
  });
});

describe("43c — disponibilidade sem a Kamila por omissão", () => {
  it("ninguém escrito no código; Definições ou env mandam; sem nenhum fica sem responsável", () => {
    expect(DEFAULT_AVAILABILITY_TASK_ASSIGNEE_EMAIL).toBe("");
    expect(availabilityTaskAssigneeEmail({})).toBe("");
    expect(availabilityTaskAssigneeEmail({ AVAILABILITY_TASK_ASSIGNEE_EMAIL: "rh@multipark.pt" })).toBe("rh@multipark.pt");
    const t = src("server/tasksService.ts");
    expect(t).toContain("const owner = ownerEmail ? await findEmployeeByEmailOrName(ownerEmail) : null;");
    for (const f of ["shared/taskRules.ts", "server/tasksService.ts", "shared/appSettings.ts"]) expect(src(f)).not.toMatch(/kamilafagundes@/i);
  });
});
