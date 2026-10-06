/**
 * P3 lote 29a — Parcerias (Jorge, 6 out 2026): "aqui deves pôr apenas as
 * marcas, não divididas por cidade — quem é parceiro de uma marca é parceiro
 * nas três cidades"; "tirar os parques inativos, os Pros inativos, os
 * parceiros inativos — fazê-los desaparecer daqui"; e o "Por configurar" que
 * "continua a aparecer se tudo está na Multipark".
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { brandsOfParkNames, isLivePartnerActive, partnerBrandFees, type BrandFeePark } from "../shared/partnerBrands";
import { isAwaitingMultiparkLink, isPartnerUnconfigured } from "../shared/partnerRules";
import { groupLivePartners } from "./multiparkDb/partnerships";
import { commissionFor } from "./finance/rules";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const park = (o: Partial<BrandFeePark>): BrandFeePark => ({ brand: "airpark", parkName: "Airpark - Lisboa", city: "Lisboa", active: true, feeType: "PERCENTAGE", feePct: 20, feeFixed: null, ...o });

describe("29a — uma linha por marca (não por cidade)", () => {
  it("as três cidades com a mesma taxa → 'Airpark · 20 %'; ordem Airpark, Redpark, Skypark", () => {
    const rows = partnerBrandFees([
      park({ brand: "skypark", parkName: "Skypark - Porto", city: "Porto" }),
      park({ city: "Faro", parkName: "Airpark - Faro" }), park({}), park({ city: "Porto", parkName: "Airpark - Porto" }),
      park({ brand: "redpark", parkName: "Redpark - Lisboa" }),
    ]);
    expect(rows).toEqual([
      { brand: "Airpark", active: true, fee: "20 %", detail: null },
      { brand: "Redpark", active: true, fee: "20 %", detail: null },
      { brand: "Skypark", active: true, fee: "20 %", detail: null },
    ]);
  });

  it("cidades com taxas diferentes → intervalo e o detalhe por cidade na dica", () => {
    const [a] = partnerBrandFees([park({ city: "Faro", feePct: 25 }), park({ city: "Lisboa", feePct: 20 }), park({ city: "Porto", feePct: 23.5 })]);
    expect(a.fee).toBe("20–25 %");
    expect(a.detail).toBe("Faro 25 % · Lisboa 20 % · Porto 23,5 %");
    const [b] = partnerBrandFees([park({ feeType: "FIXED", feeFixed: 2.5, feePct: null }), park({ city: "Porto", feePct: 20 })]);
    expect(b.fee).toBe("várias taxas");
  });

  it("a taxa mostrada é a das cidades ativas; marca só com cidades inativas fica inativa", () => {
    const rows = partnerBrandFees([
      park({ city: "Faro", feePct: 30, active: false }), park({ city: "Lisboa", feePct: 20 }),
      park({ brand: "redpark", active: false }), park({ brand: "skypark", parkActive: false }),
    ]);
    expect(rows[0]).toMatchObject({ brand: "Airpark", active: true, fee: "20 %", detail: null });
    expect(rows[1]).toMatchObject({ brand: "Redpark", active: false });
    expect(rows[2]).toMatchObject({ brand: "Skypark", active: false });
    expect(partnerBrandFees([park({ feePct: null, feeType: null })])[0].fee).toBeNull(); // sem taxa / escondida
  });

  it("o servidor leva a marca e o estado do parque em cada linha", () => {
    const parks = [{ id: "p1", name: "Airpark - Lisboa", cityName: "Lisboa", brand: "airpark" as const, status: "ACTIVE" }, { id: "p2", name: "Airpark - Faro", cityName: "Faro", brand: "airpark" as const, status: "INACTIVE" }];
    const [g] = groupLivePartners([
      { user_id: "u1", partner_id: "a", park_id: "p1", name: "Parkos", partner_type: "AGGREGATOR", active: true, fee_type: "PERCENTAGE", fee_pct: 20 },
      { user_id: "u1", partner_id: "b", park_id: "p2", name: "Parkos", partner_type: "AGGREGATOR", active: true, fee_type: "PERCENTAGE", fee_pct: 20 },
    ], parks);
    expect(g.parks.map((x) => [x.brand, x.parkActive])).toEqual([["airpark", false], ["airpark", true]]);
  });

  it("Pros e avenças: parques → marcas", () => {
    expect(brandsOfParkNames(["Airpark - Lisboa", "Airpark - Faro", "Skypark Porto", "Parque X"])).toEqual(["Airpark", "Skypark", "Parque X"]);
  });
});

describe("29a — inativos fora das listas (com 'Mostrar inativos')", () => {
  it("parceiro ativo = alguma linha ativa num parque ativo", () => {
    expect(isLivePartnerActive({ active: true, parks: [{ active: true, parkActive: true }] })).toBe(true);
    expect(isLivePartnerActive({ active: true, parks: [{ active: true, parkActive: false }, { active: false, parkActive: true }] })).toBe(false);
    expect(isLivePartnerActive({ active: false, parks: [{ active: true, parkActive: true }] })).toBe(false);
  });

  it("as quatro listas escondem os inativos e têm o botão para os ver", () => {
    const tabs = src("client/src/components/partnerships/LiveTabs.tsx");
    expect(tabs).toContain("d.partners.filter((p) => isLivePartnerActive(p))");
    expect(tabs).toContain(`String(p.status ?? "").toUpperCase() === "INACTIVE"`);
    expect(tabs).toContain("d.rows.filter((r) => r.active)");
    expect(tabs).toContain("partnerBrandFees(p.parks)");
    expect(tabs).toContain(">Marcas · taxa</th>");
    expect(tabs).not.toContain(">Parques · taxa</th>");
    const page = src("client/src/pages/PartnershipsPage.tsx");
    expect(page).toContain(`(partnerList as any[]).filter((p: any) => p.partnerStatus !== "inactive")`);
    expect(page).toContain("Mostrar inativos (${inactiveRecords})");
  });
});

describe("29a — 'Por configurar' só para o que é mesmo nosso", () => {
  it("ligados à Multipark, inativos e tipos que vêm da Multipark não pedem configuração", () => {
    expect(isPartnerUnconfigured({ configuredAt: null, partnerType: "hotel" })).toBe(true);
    expect(isPartnerUnconfigured({ configuredAt: "2026-10-01", partnerType: "hotel" })).toBe(false);
    expect(isPartnerUnconfigured({ configuredAt: null, partnerType: "agregador", multiparkPartnerId: "u1" })).toBe(false);
    expect(isPartnerUnconfigured({ configuredAt: null, partnerType: "outro", multiparkKind: "partner" })).toBe(false);
    expect(isPartnerUnconfigured({ configuredAt: null, partnerType: "outro", partnerStatus: "inactive" })).toBe(false);
    for (const t of ["cliente_pro", "avenca_mensal", "avenca_anual", "agencia_viagem", "agregador"]) expect(isPartnerUnconfigured({ configuredAt: null, partnerType: t }), t).toBe(false);
  });

  it("esses ficam 'à espera de ligar' (resolve-se com Ver o que muda → Aplicar)", () => {
    expect(isAwaitingMultiparkLink({ partnerType: "cliente_pro" })).toBe(true);
    expect(isAwaitingMultiparkLink({ partnerType: "avenca_mensal", multiparkPartnerId: "plan:1" })).toBe(false);
    expect(isAwaitingMultiparkLink({ partnerType: "agregador", multiparkKind: "own" })).toBe(false);
    expect(isAwaitingMultiparkLink({ partnerType: "hotel" })).toBe(false);
    expect(isAwaitingMultiparkLink({ partnerType: "cliente_pro", partnerStatus: "inactive" })).toBe(false);
    const page = src("client/src/pages/PartnershipsPage.tsx");
    expect(page).toContain("(partnerList as any[]).filter(isAwaitingMultiparkLink)");
    expect(page).toContain("Não precisas de os configurar à mão");
  });

  it("Pro e avença a 0 % não são 'taxa em falta' na Faturação (não têm comissão de venda)", () => {
    const base = { id: 1, name: "X", commissionRate: 0, updatedAt: "", configuredAt: null };
    expect(commissionFor(123, { ...base, partnerType: "cliente_pro" }).status).toBe("rate_zero");
    expect(commissionFor(123, { ...base, partnerType: "avenca_mensal" }).status).toBe("rate_zero");
    expect(commissionFor(123, { ...base, partnerType: "agregador" }).status).toBe("rate_missing");
  });
});
