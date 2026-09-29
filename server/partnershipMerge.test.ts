import { describe, expect, it } from "vitest";
import { redirectMerged } from "./finance/partners";
import * as R from "./finance/rules";

describe("juntar registos das Parcerias: as reservas vão para o que fica", () => {
  const rows = [
    { id: 1, name: "Máquina de Viagens", campaignKey: null, mergedIntoId: null },
    { id: 2, name: "Pro Cabopol", campaignKey: "cabopol", mergedIntoId: 1 },
    { id: 3, name: "Blocotelha", campaignKey: null, mergedIntoId: 2 },   // cadeia: 3 → 2 → 1
    { id: 4, name: "Outro", campaignKey: null, mergedIntoId: null },
  ];
  it("nome, chave e aliases dos juntos apontam para o registo final", () => {
    const aliases = [{ partnershipId: 3, aliasValue: "mp-bloco" }, { partnershipId: 4, aliasValue: "mp-outro" }];
    redirectMerged(rows, aliases);
    expect(aliases).toEqual(expect.arrayContaining([
      { partnershipId: 1, aliasValue: "mp-bloco" },
      { partnershipId: 4, aliasValue: "mp-outro" },
      { partnershipId: 1, aliasValue: "Pro Cabopol" },
      { partnershipId: 1, aliasValue: "cabopol" },
      { partnershipId: 1, aliasValue: "Blocotelha" },
    ]));
  });
  it("no índice das finanças, as campanhas dos juntos dão o registo que fica", () => {
    const aliases: Array<{ partnershipId: number; aliasValue: string }> = [{ partnershipId: 3, aliasValue: "mp-bloco" }];
    redirectMerged(rows, aliases);
    const partners = rows.filter((r) => !r.mergedIntoId).map((r) => ({ id: r.id, name: r.name, campaignKey: r.campaignKey, commissionRate: 0, partnerType: "agencia_viagem", commissionBase: "net", updatedAt: "" }));
    const idx = R.buildPartnerIndex(partners as any, aliases);
    expect(idx.byKey.get("blocotelha")?.id).toBe(1);
    expect(idx.byKey.get("cabopol")?.id).toBe(1);
    expect(idx.byKey.get("mp-bloco")?.id).toBe(1);
    expect(idx.byKey.get("outro")?.id).toBe(4);
  });
});
