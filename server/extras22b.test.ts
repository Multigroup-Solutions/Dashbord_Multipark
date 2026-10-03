/**
 * P3 lote 22b — decisões do Jorge (3 out) no Extras Dia e na Passagem de turno:
 *  - D12 tempo por carro conforme as pessoas no turno (TL incluído), por cidade
 *  - D14 a linha da escala diz quem pôs e quem alterou
 *  - D7  gravar a passagem de turno não espera pela IA nem pelo email
 *  - D13 custo das métricas de extras = a mesma conta da Faturação
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CREW_RULES, SETTINGS, crewRulesSchema } from "../shared/appSettings";
import { assignmentWhoLine, describeCrewRule } from "../shared/extrasSchedule";
import { extrasCityKeys } from "./extrasMetrics";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("D12 regra por equipa (Definições)", () => {
  it("a definição nova tem as omissões do Jorge e a antiga já não manda", () => {
    expect(SETTINGS["extras.crewRules"].defaultValue).toEqual(DEFAULT_CREW_RULES);
    expect(describeCrewRule(DEFAULT_CREW_RULES.lisbon)).toBe("Tempo por carro (pessoas com o TL): 2 → 75 min · 3–4 → 60 min · 5–6 → 45 min · 7+ → 30 min");
    expect(describeCrewRule(DEFAULT_CREW_RULES.porto)).toBe("Tempo por carro (pessoas com o TL, mínimo 3): 3+ → 30 min");
    expect(src("server/extrasDia.ts")).not.toContain('getSetting("extras.carsPerHourPerDriver")');
  });

  it("a última faixa é 'em diante' e as faixas sobem", () => {
    expect(crewRulesSchema.safeParse(DEFAULT_CREW_RULES).success).toBe(true);
    const bad = (lisbon: unknown) => crewRulesSchema.safeParse({ ...DEFAULT_CREW_RULES, lisbon }).success;
    expect(bad({ minCrew: 2, bands: [{ upTo: 4, minutes: 60 }] })).toBe(false);
    expect(bad({ minCrew: 2, bands: [{ upTo: 4, minutes: 60 }, { upTo: 3, minutes: 45 }, { upTo: null, minutes: 30 }] })).toBe(false);
    expect(bad({ minCrew: 2, bands: [{ upTo: null, minutes: 0 }] })).toBe(false);
  });
});

describe("D14 quem pôs / quem alterou", () => {
  it("proposta automática, posto à mão e alterado por outra pessoa", () => {
    expect(assignmentWhoLine({ source: "auto" })).toBe("proposta automática");
    expect(assignmentWhoLine({ source: "auto", updatedById: 5, updatedByName: "Rita" })).toBe("proposta automática · alterado por Rita");
    expect(assignmentWhoLine({ source: "manual", createdById: 3, createdByName: "Rui" })).toBe("posto por Rui");
    expect(assignmentWhoLine({ source: "manual", createdById: 3, createdByName: "Rui", updatedById: 3, updatedByName: "Rui" })).toBe("posto por Rui");
    expect(assignmentWhoLine({ source: "manual", createdById: 3, createdByName: "Rui", updatedById: 5, updatedByName: "Rita" })).toBe("posto por Rui · alterado por Rita");
    expect(assignmentWhoLine({ source: "manual" })).toBeNull();
  });

  it("a lista da escala traz os nomes (utilizadores) e o ecrã mostra-os", () => {
    const fn = src("server/extrasDia.ts").split("export async function listAssignments")[1].split("\nexport ")[0];
    expect(fn).toContain("inArray(users.id, userIds)");
    expect(fn).toContain("createdByName");
    expect(fn).toContain("updatedByName");
    expect(src("client/src/pages/ExtrasDiaPage.tsx")).toContain("assignmentWhoLine(a)");
  });
});

describe("D7 passagem de turno grava logo", () => {
  it("a automação (IA, aviso, email) corre depois de responder, com waitUntil", () => {
    const route = src("server/routers.ts").split("shiftHandover:")[1].split("// Resumo automático do turno (rascunho)")[0];
    expect(route).not.toMatch(/await\s+afterHandoverSave/);
    expect(route).toContain("waitUntil(work)");
    expect(route).toContain(".catch(");
    expect(route).toContain("automationPending: true");
  });

  it("o ecrã avisa que o resumo segue e volta a carregar a lista", () => {
    const page = src("client/src/pages/ShiftHandoverPage.tsx");
    expect(page).toContain("o resumo e o aviso ao turno seguinte seguem dentro de momentos");
    expect(page).not.toContain("r.automation");
    expect(page).toMatch(/setTimeout\(\(\) => \{ void utils\.shiftHandover\.list\.invalidate\(\); \}, 15_000\)/);
  });
});

describe("D13 custo das métricas = Faturação", () => {
  it("cidades do âmbito → cidades da escala", () => {
    expect(extrasCityKeys(["Lisboa", "Porto", "Faro"]).sort()).toEqual(["faro", "lisbon", "porto"]);
    expect(extrasCityKeys([" lisbon ", "Vila Nova (Porto)"]).sort()).toEqual(["lisbon", "porto"]);
    expect(extrasCityKeys(["Coimbra"])).toEqual([]);
    expect(extrasCityKeys([])).toEqual([]);
  });

  it("usa a conta da Faturação (não uma SQL própria) e sem acesso mostra '—'", () => {
    const cost = src("server/extrasMetrics.ts").split("export async function getExtrasMetrics")[1].split("// 2. Custo")[1].split("// 3.")[0];
    expect(cost).toContain("loadExtrasCostRows(db");
    expect(cost).toContain("aggregateExtrasCost(costRows");
    expect(cost).not.toContain("time_records");
    expect(cost).not.toContain("extras_dia_assignments");
    expect(src("client/src/components/ExtrasMetricsSection.tsx")).toContain('m.costHidden ? "—"');
  });
});
