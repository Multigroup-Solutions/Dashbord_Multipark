import { describe, expect, it } from "vitest";
import {
  DRIVER_CITIES,
  DRIVER_TEMPLATES,
  citiesWithTemplate,
  cityMapFromPlan,
  driverCityFrom,
  driverTemplate,
  findDriverTemplateByName,
  hasDriverTemplate,
  planCityGroups,
} from "../shared/driverTemplates";
import { WHATSAPP_TEMPLATES, templateForCity } from "../shared/whatsappTemplate";
import { citySendKey, orderedCities } from "./whatsappBroadcast";
import { isShiftChangeRequest, splitByCity } from "./extrasAutomation";
import { MIGRATION_0530_STATEMENTS } from "./migrations/migration_0530";
import { fallbackChannelFor, shiftDateFromNote } from "./whatsappFailurePolicy";
import { findWhatsAppTemplateByName, isDriverMessageTemplate, isTeamRetryTemplate } from "../shared/whatsappTemplate";

describe("registo de templates por cidade", () => {
  it("Lisboa mantém-se como em produção (equipa pt_PT; recrutamento e morada pt_BR)", () => {
    expect(driverTemplate("LISBOA", "RECRUITMENT")).toMatchObject({ name: "seja_motorista", language: "pt_BR", params: null });
    expect(driverTemplate("LISBOA", "ADDRESS_RULES")).toMatchObject({ name: "morada_e_regras", language: "pt_BR", params: null });
    expect(driverTemplate("LISBOA", "WORK_NOTICE")).toMatchObject({
      name: "driver_shift_notice",
      language: "pt_PT",
      params: { recipient: "customer_name", shared: "day" },
    });
    expect(driverTemplate("LISBOA", "AVAILABILITY")).toMatchObject({
      name: "driver_availability",
      language: "pt_PT",
      params: { recipient: "customer_name", shared: "week_date" },
    });
  });

  it("Porto usa os templates _porto em pt_PT com os parâmetros padrão", () => {
    expect(driverTemplate("PORTO", "RECRUITMENT")).toMatchObject({ name: "seja_motorista_porto", language: "pt_PT" });
    expect(driverTemplate("PORTO", "ADDRESS_RULES")).toMatchObject({ name: "morada_e_regras_porto", language: "pt_PT" });
    expect(driverTemplate("PORTO", "WORK_NOTICE")).toMatchObject({ name: "aviso_de_trabalho_porto", language: "pt_PT" });
    expect(driverTemplate("PORTO", "AVAILABILITY")).toMatchObject({
      name: "disponibilidade_extras_porto",
      language: "pt_PT",
      params: { recipient: "customer_name", shared: "week_date" },
    });
  });

  it("turno_confirmado: pt_PT nas duas cidades (o de Lisboa ao contrário dos antigos)", () => {
    expect(driverTemplate("LISBOA", "CONFIRMED_SHIFT")).toMatchObject({ name: "turno_confirmado_lisboa", language: "pt_PT" });
    expect(driverTemplate("PORTO", "CONFIRMED_SHIFT")).toMatchObject({ name: "turno_confirmado_porto", language: "pt_PT" });
  });

  it("um nome só se repete entre cidades para a MESMA mensagem (o servidor descobre a mensagem pelo nome)", () => {
    const byName = new Map<string, Set<string>>();
    for (const c of DRIVER_CITIES) {
      for (const [message, t] of Object.entries(DRIVER_TEMPLATES[c])) {
        byName.set(t.name, new Set([...(byName.get(t.name) ?? []), message]));
      }
    }
    for (const [name, messages] of Array.from(byName.entries())) expect(messages.size, name).toBe(1);
    expect(findDriverTemplateByName("aviso_de_trabalho_porto")).toMatchObject({ city: "PORTO", message: "WORK_NOTICE", language: "pt_PT" });
  });

  it("Lisboa e Porto têm todas as mensagens do catálogo", () => {
    for (const def of WHATSAPP_TEMPLATES) {
      for (const city of ["LISBOA", "PORTO"] as const) expect(templateForCity(def, city)?.name, `${def.id}/${city}`).toBeTruthy();
    }
  });

  it("Faro: só os genéricos de equipa, nunca a morada nem o recrutamento de Lisboa", () => {
    expect(driverTemplate("FARO", "WORK_NOTICE")).toMatchObject({ name: "driver_shift_notice", language: "pt_PT" });
    expect(driverTemplate("FARO", "AVAILABILITY")).toMatchObject({ name: "driver_availability", language: "pt_PT" });
    expect(driverTemplate("FARO", "ADDRESS_RULES")).toBeNull();
    expect(driverTemplate("FARO", "RECRUITMENT")).toBeNull();
    expect(driverTemplate("FARO", "CONFIRMED_SHIFT")).toBeNull();
    expect(hasDriverTemplate("FARO", "ADDRESS_RULES")).toBe(false);
    expect(citiesWithTemplate("ADDRESS_RULES")).toEqual(["LISBOA", "PORTO"]);
    expect(citiesWithTemplate("WORK_NOTICE")).toEqual(["LISBOA", "PORTO", "FARO"]);
  });
});

describe("driverCityFrom", () => {
  it("aceita as várias formas usadas na app", () => {
    expect(driverCityFrom("lisboa")).toBe("LISBOA");
    expect(driverCityFrom("lisbon")).toBe("LISBOA"); // chave da escala
    expect(driverCityFrom("PORTO")).toBe("PORTO");
    expect(driverCityFrom("Porto")).toBe("PORTO");
    expect(driverCityFrom("Lisboa - Aeroporto")).toBe("LISBOA");
  });

  it("nunca adivinha: sem cidade ou texto ambíguo → null", () => {
    expect(driverCityFrom("faro")).toBe("FARO");
    expect(driverCityFrom(null)).toBeNull();
    expect(driverCityFrom("")).toBeNull();
    expect(driverCityFrom("Portimão")).toBeNull();
    expect(driverCityFrom("Vila Nova de Gaia")).toBeNull();
  });
});

describe("planCityGroups (lote por cidade)", () => {
  const people = [
    { id: 1, city: "LISBOA" as const },
    { id: 2, city: "PORTO" as const },
    { id: 3, city: null },
    { id: 4, city: "LISBOA" as const },
  ];

  it("AUTO agrupa pela cidade de cada um; quem não tem cidade fica por atribuir", () => {
    const plan = planCityGroups(people, "AUTO", null);
    expect(plan.groups).toEqual([
      { city: "LISBOA", ids: [1, 4] },
      { city: "PORTO", ids: [2] },
    ]);
    expect(plan.missing).toEqual([3]);
  });

  it("AUTO com cidade para os sem cidade → todos seguem", () => {
    const plan = planCityGroups(people, "AUTO", "PORTO");
    expect(plan.missing).toEqual([]);
    expect(cityMapFromPlan(plan)).toEqual({ 1: "LISBOA", 2: "PORTO", 3: "PORTO", 4: "LISBOA" });
  });

  it("uma cidade escolhida vale para todos", () => {
    const plan = planCityGroups(people, "PORTO", null);
    expect(plan.groups).toEqual([{ city: "PORTO", ids: [1, 2, 3, 4] }]);
  });

  it("só conta a cidade que tem template para a mensagem (Faro no recrutamento fica por atribuir)", () => {
    const leads = [
      { id: 1, city: "LISBOA" as const },
      { id: 2, city: "FARO" as const },
    ];
    const plan = planCityGroups(leads, "AUTO", null, ["LISBOA", "PORTO"]);
    expect(plan.groups).toEqual([{ city: "LISBOA", ids: [1] }]);
    expect(plan.missing).toEqual([2]);
    expect(planCityGroups(leads, "FARO", null, ["LISBOA", "PORTO"]).missing).toEqual([1, 2]);
  });

  it("sem escolha nada segue (nunca Lisboa por omissão)", () => {
    const plan = planCityGroups(people, null, null);
    expect(plan.groups).toEqual([]);
    expect(plan.missing).toEqual([1, 2, 3, 4]);
  });
});

describe("envio por cidade (servidor)", () => {
  it("orderedCities segue a ordem do registo, sem repetições", () => {
    expect(orderedCities(["PORTO", "LISBOA", "PORTO"])).toEqual(["LISBOA", "PORTO"]);
  });

  it("citySendKey: uma chave por cidade, determinística e dentro do limite de 40", () => {
    const key = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(citySendKey(key, "LISBOA")).toBe(`${key.slice(0, 33)}:LISBOA`);
    expect(citySendKey(key, "LISBOA")!.length).toBeLessThanOrEqual(40);
    expect(citySendKey(key, "LISBOA")).not.toBe(citySendKey(key, "PORTO"));
    expect(citySendKey(null, "PORTO")).toBeNull();
  });

  it("splitByCity parte o mapa id → cidade (jobs: uma chamada por cidade)", () => {
    expect(splitByCity({ 1: "LISBOA", 2: "PORTO", 3: "LISBOA" })).toEqual([
      ["LISBOA", { 1: "LISBOA", 3: "LISBOA" }],
      ["PORTO", { 2: "PORTO" }],
    ]);
  });
});

describe("botão Preciso de alterar", () => {
  it("reconhece o texto do botão, com ou sem maiúsculas/espaços", () => {
    expect(isShiftChangeRequest("Preciso de alterar")).toBe(true);
    expect(isShiftChangeRequest("  preciso  de ALTERAR ")).toBe(true);
  });

  it("não confunde com respostas livres", () => {
    expect(isShiftChangeRequest("sim")).toBe(false);
    expect(isShiftChangeRequest("preciso de alterar a hora para as 17h")).toBe(false);
    expect(isShiftChangeRequest("")).toBe(false);
  });
});

describe("migração 0530", () => {
  it("acrescenta a cidade aos registos de envio, a língua à difusão e o pedido de alteração", () => {
    const all = MIGRATION_0530_STATEMENTS.join("\n");
    expect(all).toContain("ALTER TABLE `whatsapp_broadcasts` ADD COLUMN `city`");
    expect(all).toContain("ALTER TABLE `whatsapp_broadcasts` ADD COLUMN `languageCode`");
    expect(all).toContain("ALTER TABLE `whatsapp_messages` ADD COLUMN `city`");
    expect(all).toContain("ADD COLUMN `changeRequestedAt`");
  });

  it("sem backfill: os templates antigos iam a todas as cidades, não se inventa a cidade", () => {
    expect(MIGRATION_0530_STATEMENTS.some((st) => st.startsWith("UPDATE"))).toBe(false);
  });
});

describe("regras que dependiam do nome do template valem para todas as cidades", () => {
  it("nova tentativa de equipa (131049) também para os templates do Porto", () => {
    expect(isTeamRetryTemplate("driver_shift_notice")).toBe(true);
    expect(isTeamRetryTemplate("aviso_de_trabalho_porto")).toBe(true);
    expect(isTeamRetryTemplate("turno_confirmado_porto")).toBe(true);
    expect(isTeamRetryTemplate("seja_motorista_porto")).toBe(false);
  });

  it("o email de recurso da disponibilidade vale para Lisboa e Porto", () => {
    for (const templateName of ["driver_availability", "disponibilidade_extras_porto"]) {
      expect(fallbackChannelFor({ templateName, note: null, employeeId: 1 })).toBe("availability_email");
    }
    expect(fallbackChannelFor({ templateName: "seja_motorista_porto", note: null, employeeId: 1 })).toBe("none");
  });

  it("os botões do aviso e do turno confirmado reconhecem os templates de cada cidade", () => {
    expect(isDriverMessageTemplate("aviso_de_trabalho_porto", "WORK_NOTICE")).toBe(true);
    expect(isDriverMessageTemplate("driver_shift_notice", "WORK_NOTICE")).toBe(true);
    expect(isDriverMessageTemplate("turno_confirmado_lisboa", "CONFIRMED_SHIFT")).toBe(true);
    expect(isDriverMessageTemplate("turno_confirmado_lisboa", "WORK_NOTICE")).toBe(false);
    expect(findWhatsAppTemplateByName("disponibilidade_extras_porto")?.tpl).toMatchObject({ city: "PORTO", language: "pt_PT" });
  });

  it("a data do turno sai da nota do turno confirmado", () => {
    expect(shiftDateFromNote("Turno confirmado 2026-10-22")).toBe("2026-10-22");
    expect(shiftDateFromNote("Aviso de escala 2026-10-22")).toBe("2026-10-22");
  });
});
