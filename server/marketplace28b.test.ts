/**
 * P3 lote 28b — Jorge (6 out 2026): "quando a reserva é feita num dos nossos
 * parques mas vem do Marketplace (a Multipark identifica-a: pertence à
 * campanha do Marketplace), o Marketplace deve ficar com 20 % dessa reserva —
 * as contas do Marketplace ficam com 20 %, igual que dos outros parceiros."
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFinanceAggSql, mapFinanceAggRow } from "./multiparkDb/financeAgg";
import { assertReadOnlySql } from "./multiparkDb/client";
import { campaignOf } from "./finance/liveBookings";
import { MARKETPLACE_PARTNER, partnerForCampaign, withMarketplacePartner } from "./finance/partners";
import { buildPartnerIndex, commissionFor, netOfVat } from "./finance/rules";
import { buildPartnerBillingSql, mapPartnerBilling } from "./multiparkDb/partnerBilling";
import { MARKETPLACE_CAMPAIGN } from "../shared/marketplace";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("28b — Faturação: a reserva vinda pelo Marketplace paga 20 % ao Marketplace", () => {
  it("o SQL lê a origem (só leitura) e agrupa por ela", () => {
    const { sql } = buildFinanceAggSql({ kind: "delivered", start: "2026-09-01 00:00:00", end: "2026-10-01 00:00:00", parkIds: ["pA"] } as any);
    expect(sql).toContain(`COALESCE(b."origin"::text = 'MARKETPLACE', false) AS mkt`);
    expect(sql).toContain("d.pro, d.mkt,");
    expect(sql).toContain("GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10");
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(mapFinanceAggRow({ mkt: true }).marketplace).toBe(true);
    expect(mapFinanceAggRow({ mkt: false }).marketplace).toBe(false);
  });

  it("campanha = Marketplace, que ganha ao parceiro (nunca duas comissões)", () => {
    const aliases = new Map([["multipark_partner_id:p1", "Parkos"]]);
    const base = { partnerId: "p1", paymentMethod: null, partnerName: "Parkos", discountCode: null, campaignName: "Verão" };
    expect(campaignOf({ ...base, marketplace: true }, aliases)).toBe(MARKETPLACE_CAMPAIGN);
    expect(campaignOf({ ...base, marketplace: false }, aliases)).toBe("Parkos");
    expect(campaignOf({ ...base, partnerId: null, partnerName: null, campaignName: null, marketplace: false }, aliases)).toBeNull();
  });

  it("o Marketplace é parceiro de venda a 20 % (base sem IVA, como os outros); um registo próprio nas Parcerias manda", () => {
    const empty = withMarketplacePartner(buildPartnerIndex([], []));
    const p = partnerForCampaign(empty, "Marketplace");
    expect(p).toBe(MARKETPLACE_PARTNER);
    expect(p).toMatchObject({ commissionRate: 20, commissionBase: "net", partnerType: "agregador" });
    expect(commissionFor(123, p, netOfVat(123))).toMatchObject({ commission: 20, status: "ok" });
    // Campanha "Marketplace" na Multipark (Campaign.name) também cai aqui
    expect(partnerForCampaign(empty, " marketplace ")).toBe(MARKETPLACE_PARTNER);
    const own = { id: 7, name: "Marketplace", commissionRate: 15, updatedAt: "2026-10-01", configuredAt: "2026-10-01" };
    expect(partnerForCampaign(withMarketplacePartner(buildPartnerIndex([own], [])), "Marketplace")).toBe(own);
  });

  it("o motor da Faturação usa o índice com o Marketplace", () => {
    const engine = src("server/finance/engine.ts");
    expect(engine).toContain("const partnerIndex = withMarketplacePartner(rawPartnerIndex);");
  });
});

describe("28b — Parcerias → Faturação: as contas do Marketplace ficam com 20 % dos parques nossos", () => {
  it("SQL: parte 'market_own' só dos parques nossos com origem MARKETPLACE, concluídas no período", () => {
    const { sql } = buildPartnerBillingSql({ ourParks: ["pk-al"], thirdParks: ["pk-x"], start: "2026-08-31 23:00:00", end: "2026-09-30 23:00:00" });
    const part = sql.split("UNION ALL").find((x) => x.includes("'market_own'"))!;
    expect(part).toContain(`b."origin"::text = 'MARKETPLACE'`);
    expect(part).toContain(`b."status"::text = 'CHECKED_OUT'`);
    expect(part).toContain(`b."parkId" IN ($3)`);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  });

  it("20 % sem IVA por parque nosso; à parte dos parques de terceiros", () => {
    const live = mapPartnerBilling([
      { kind: "market_own", key: "pk-al", n: 4, value: 246, ours: null, missing: 0, commission: null },
      { kind: "market", key: "pk-x", n: 2, value: 200, ours: null, missing: 0, commission: 50 },
    ], new Map([["pk-al", { name: "Airpark Lisboa", city: "Lisboa" }], ["pk-x", { name: "Boardingpark", city: "Lisboa" }]]));
    expect(live.marketplace).toEqual([
      { parkId: "pk-x", parkName: "Boardingpark", city: "Lisboa", bookings: 2, value: 200, commission: 50, missing: 0, rate: 25 },
      { parkId: "pk-al", parkName: "Airpark Lisboa", city: "Lisboa", bookings: 4, value: 246, commission: 40, missing: 0, rate: 20, own: true },
    ]);
  });

  it("o cartão do Marketplace mostra os parques nossos (20 %) e o total do Marketplace", () => {
    const page = src("client/src/pages/PartnershipsPage.tsx");
    expect(page).toContain("const ownRows = all.filter((r) => r.own);");
    expect(page).toContain("Marketplace (20 % s/ IVA)");
    expect(page).toContain("TOTAL do Marketplace");
  });
});
