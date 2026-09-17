import { describe, expect, it } from "vitest";
import { brandNameForProject, cityInCampaignName, isCampaignMapped, isNationalCampaignName, nationalSharesForBrand, suggestCampaignProject, suggestCampaignProjects, type ProjectNode } from "../shared/adCampaignMapping";

describe("nacional repartido pelas cidades da marca", () => {
  it("proporcional ao gasto de cidade da marca; sem gasto, partes iguais; marca sem cidades → nada", () => {
    const w = new Map<number, number>([[52, 300], [53, 100], [54, 0]]);
    expect(nationalSharesForBrand("Airpark", P, w)).toEqual([
      { projectId: 52, fraction: 0.75 }, { projectId: 53, fraction: 0.25 }, { projectId: 54, fraction: 0 },
    ]);
    const eq = nationalSharesForBrand("airpark", P, new Map());
    expect(eq.map((s) => s.projectId)).toEqual([52, 53, 54]);
    expect(eq.every((s) => Math.abs(s.fraction - 1 / 3) < 1e-9)).toBe(true);
    expect(nationalSharesForBrand("Boardingpark", P, w)).toEqual([]);
  });
});

// Hierarquia real (set 2026): Grupo → Cidade → Marca → Parque
const P: ProjectNode[] = [
  { id: 48, name: "Multipark", level: "group", parentId: null },
  { id: 49, name: "Lisboa", level: "city", parentId: 48 },
  { id: 50, name: "Porto", level: "city", parentId: 48 },
  { id: 51, name: "Faro", level: "city", parentId: 48 },
  { id: 52, name: "Airpark", level: "brand", parentId: 49 },
  { id: 53, name: "Airpark", level: "brand", parentId: 50 },
  { id: 54, name: "Airpark", level: "brand", parentId: 51 },
  { id: 70, name: "Redpark", level: "brand", parentId: 49 },
  { id: 56, name: "Redpark", level: "brand", parentId: 51 },
  { id: 84, name: "Marketplace", level: "brand", parentId: 50 },
  { id: 92, name: "Marketplace", level: "brand", parentId: 51 },
  { id: 60, name: "Airpark Lisboa", level: "project", parentId: 52 },
];

describe("campanhas Google Ads → marca/cidade pelo nome", () => {
  it("marca da conta: nó marca direto, ou o nó marca acima de um parque", () => {
    expect(brandNameForProject(52, P)).toBe("Airpark");
    expect(brandNameForProject(60, P)).toBe("Airpark");
    expect(brandNameForProject(49, P)).toBeNull(); // cidade não tem marca
    expect(brandNameForProject(null, P)).toBeNull();
  });

  it("cidade no nome: tolerante a acentos e separadores; ambígua ou ausente dá null", () => {
    expect(cityInCampaignName("Airpark - Faro - EN", P)?.name).toBe("Faro");
    expect(cityInCampaignName("Estacionamento - Aeroporto - Lisboa", P)?.name).toBe("Lisboa");
    expect(cityInCampaignName("airpark – PORTO", P)?.name).toBe("Porto");
    expect(cityInCampaignName("Airpark - Brand", P)).toBeNull();
    expect(cityInCampaignName("Lisboa - Porto", P)).toBeNull();
    expect(cityInCampaignName("Airportlisboa", P)).toBeNull(); // não é substring solta
  });

  it("sugere o nó marca da conta debaixo da cidade do nome", () => {
    const s = suggestCampaignProject({ id: 1, name: "Airpark - Faro - EN", accountProjectId: 52, projectId: null }, P);
    expect(s).toMatchObject({ campaignId: 1, projectId: 54, projectName: "Airpark Faro", cityName: "Faro", brandName: "Airpark" });
    // conta Multipark.pt associada a Marketplace/Porto → campanha de Faro vai para Marketplace/Faro
    expect(suggestCampaignProject({ id: 2, name: "Estacionamento - Aeroporto - Faro - EN", accountProjectId: 84, projectId: null }, P)?.projectId).toBe(92);
  });

  it("sem marca na conta, sem cidade nem palavra nacional no nome, ou marca inexistente nessa cidade → nada", () => {
    expect(suggestCampaignProject({ id: 3, name: "Espanha", accountProjectId: 52, projectId: null }, P)).toBeNull();
    expect(suggestCampaignProject({ id: 4, name: "Airpark - Faro - PT", accountProjectId: null, projectId: null }, P)).toBeNull();
    expect(suggestCampaignProject({ id: 5, name: "Redpark - Porto - PT", accountProjectId: 70, projectId: null }, P)).toBeNull(); // não há Redpark no Porto na lista
    expect(suggestCampaignProject({ id: 6, name: "Airpark - Brand", accountProjectId: null, projectId: null }, P)).toBeNull(); // nacional mas sem marca na conta
  });

  it("nacional: Brand / Pmax / Portugal sem cidade → da marca, sem cidade (scope national)", () => {
    expect(isNationalCampaignName("Airpark - Brand", P)).toBe(true);
    expect(isNationalCampaignName("Skypark - Pmax - PT", P)).toBe(true);
    expect(isNationalCampaignName("Multipark - Portugal", P)).toBe(true);
    expect(isNationalCampaignName("PMax - Estacionamento - Aeroporto - Lisboa", P)).toBe(false); // tem cidade → é de Lisboa
    expect(isNationalCampaignName("Rock in Rio", P)).toBe(false);
    const s = suggestCampaignProject({ id: 7, name: "Airpark - Pmax", accountProjectId: 52, projectId: null }, P);
    expect(s).toMatchObject({ campaignId: 7, kind: "national", projectId: null, projectName: "Nacional · Airpark", cityName: "Nacional", brandName: "Airpark" });
    // já marcada nacional → não volta a sugerir
    expect(suggestCampaignProjects([{ id: 7, name: "Airpark - Pmax", accountProjectId: 52, projectId: null, scope: "national" }], P)).toEqual([]);
    expect(isCampaignMapped({ projectId: null, scope: "national" })).toBe(true);
    expect(isCampaignMapped({ projectId: null, scope: "city" })).toBe(false);
  });

  it("em lote: só as sem marca/cidade por defeito, e nunca repete o que já está", () => {
    const list = [
      { id: 1, name: "Airpark - Faro - EN", accountProjectId: 52, projectId: null },
      { id: 2, name: "Airpark - Lisboa - PT", accountProjectId: 52, projectId: 52 }, // já certa
      { id: 3, name: "Airpark - Porto - PT", accountProjectId: 52, projectId: 54 }, // errada, mas já tem
    ];
    expect(suggestCampaignProjects(list, P).map((s) => [s.campaignId, s.projectId])).toEqual([[1, 54]]);
    expect(suggestCampaignProjects(list, P, false).map((s) => [s.campaignId, s.projectId])).toEqual([[1, 54], [3, 53]]);
    expect(suggestCampaignProjects(list, P).every((s) => s.kind === "city")).toBe(true);
  });
});
