import { describe, expect, it } from "vitest";
import { campaignTabBrand } from "../shared/adCampaignMapping";

// Faro (cidade) → Airpark (marca) → parque; Lisboa → Marketplace (marca)
const projects = [
  { id: 1, name: "Faro", level: "city", parentId: null },
  { id: 2, name: "Airpark", level: "brand", parentId: 1 },
  { id: 3, name: "Airpark Faro P1", level: "project", parentId: 2 },
  { id: 4, name: "Lisboa", level: "city", parentId: null },
  { id: 5, name: "Marketplace", level: "brand", parentId: 4 },
] as any[];
const accountBrand = new Map([[10, "Marketplace"]]);
const accountName = new Map([[10, "Multipark.pt"], [11, "Conta sem marca"]]);

describe("separador do Google Ads por marca", () => {
  it("campanha da conta Multipark.pt marcada Airpark Faro vai para Airpark", () => {
    expect(campaignTabBrand({ projectId: 2, accountId: 10 }, projects, accountBrand, accountName)).toBe("Airpark");
    expect(campaignTabBrand({ projectId: 3, accountId: 10 }, projects, accountBrand, accountName)).toBe("Airpark");
  });
  it("nacional ou por associar fica na marca da conta; conta sem marca → nome da conta", () => {
    expect(campaignTabBrand({ projectId: null, national: true, accountId: 10 }, projects, accountBrand, accountName)).toBe("Marketplace");
    expect(campaignTabBrand({ projectId: null, accountId: 10 }, projects, accountBrand, accountName)).toBe("Marketplace");
    expect(campaignTabBrand({ projectId: null, accountId: 11 }, projects, accountBrand, accountName)).toBe("Conta sem marca");
  });
});
