import { describe, expect, it } from "vitest";
import { brandNameForProject, cityInCampaignName, suggestCampaignProject, suggestCampaignProjects, type ProjectNode } from "../shared/adCampaignMapping";

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

  it("sem marca na conta, sem cidade no nome, ou marca inexistente nessa cidade → nada", () => {
    expect(suggestCampaignProject({ id: 3, name: "Airpark - Pmax", accountProjectId: 52, projectId: null }, P)).toBeNull();
    expect(suggestCampaignProject({ id: 4, name: "Airpark - Faro - PT", accountProjectId: null, projectId: null }, P)).toBeNull();
    expect(suggestCampaignProject({ id: 5, name: "Redpark - Porto - PT", accountProjectId: 70, projectId: null }, P)).toBeNull(); // não há Redpark no Porto na lista
  });

  it("em lote: só as sem marca/cidade por defeito, e nunca repete o que já está", () => {
    const list = [
      { id: 1, name: "Airpark - Faro - EN", accountProjectId: 52, projectId: null },
      { id: 2, name: "Airpark - Lisboa - PT", accountProjectId: 52, projectId: 52 }, // já certa
      { id: 3, name: "Airpark - Porto - PT", accountProjectId: 52, projectId: 54 }, // errada, mas já tem
    ];
    expect(suggestCampaignProjects(list, P).map((s) => [s.campaignId, s.projectId])).toEqual([[1, 54]]);
    expect(suggestCampaignProjects(list, P, false).map((s) => [s.campaignId, s.projectId])).toEqual([[1, 54], [3, 53]]);
  });
});
