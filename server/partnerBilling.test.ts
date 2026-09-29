import { describe, expect, it } from "vitest";
import { buildPartnerBillingSql, mapPartnerBilling } from "./multiparkDb/partnerBilling";
import { planMonthly, recordBillingFromMp } from "../shared/partnerBilling";

describe("faturação de parceiros ← Multipark: SQL", () => {
  const { sql, params } = buildPartnerBillingSql({ ourParks: ["pk-al"], thirdParks: ["pk-x"], start: "2026-08-31 23:00:00", end: "2026-09-30 23:00:00" });
  it("só saídas concluídas no período, nos parques certos", () => {
    expect(sql).toContain(`b."status"::text = 'CHECKED_OUT'`);
    expect(sql).toContain(`b."checkOut" >= $1::timestamp AND b."checkOut" < $2::timestamp`);
    expect(params.slice(0, 2)).toEqual(["2026-08-31 23:00:00", "2026-09-30 23:00:00"]);
    expect(params).toEqual(expect.arrayContaining(["pk-al", "pk-x"]));
  });
  it("parceiro por empresa com o devido; Pro sem avenças; marketplace com a comissão gravada", () => {
    expect(sql).toContain(`'partner' AS kind, pa."userId" AS key`);
    expect(sql).toContain(`b."partnerAmountDue"`);
    expect(sql).toContain(`b."clientPlanId" IS NULL AND (b."proClientId" IS NOT NULL OR b."pro" = true)`);
    expect(sql).toContain(`SUM(b."commissionAmount") AS commission`);
    expect(sql).toContain(`b."origin"::text = 'MARKETPLACE'`);
  });
  it("sem parques não há leitura", () => {
    expect(() => buildPartnerBillingSql({ ourParks: [], thirdParks: [], start: "a", end: "b" })).toThrow();
  });
});

describe("faturação de parceiros ← Multipark: números", () => {
  const live = mapPartnerBilling([
    { kind: "partner", key: "u-lets", name: "Let's Travel", n: "3", value: "402", ours: "301.5", missing: "1" },
    { kind: "pro", key: "c1", n: 2, value: "107.6" },
    { kind: "plan", key: "cp1", n: 4, value: "0" },
    { kind: "market", key: "pk-x", n: 2, value: "200", commission: "50", missing: 0 },
  ], new Map([["pk-x", { name: "Top Parking", city: "Porto" }]]));
  it("mapas por entidade e marketplace com a taxa efetiva", () => {
    expect(live.partners.get("u-lets")).toMatchObject({ n: 3, value: 402, ours: 301.5, missing: 1 });
    expect(live.marketplace).toEqual([{ parkId: "pk-x", parkName: "Top Parking", city: "Porto", bookings: 2, value: 200, commission: 50, missing: 0, rate: 25 }]);
  });
  it("registo ligado: parceiro fatura o nosso; Pro o preço; avença o plano pelos meses", () => {
    expect(recordBillingFromMp({ partnerType: "agencia_viagem", multiparkKind: "partner", multiparkPartnerId: "u-lets", multiparkSnapshot: null }, live, "2026-09-01", "2026-09-30"))
      .toEqual({ bookingsCount: 3, revenueGross: 402, aFaturar: 301.5, missing: 1, source: "multipark" });
    expect(recordBillingFromMp({ partnerType: "cliente_pro", multiparkKind: "pro", multiparkPartnerId: "pro:c1", multiparkSnapshot: null }, live, "2026-09-01", "2026-09-30"))
      .toMatchObject({ bookingsCount: 2, aFaturar: 107.6 });
    expect(recordBillingFromMp({ partnerType: "avenca_mensal", multiparkKind: "plan", multiparkPartnerId: "plan:cp1", multiparkSnapshot: JSON.stringify({ price: 90, cadence: "MONTHLY" }) }, live, "2026-09-01", "2026-09-30"))
      .toMatchObject({ bookingsCount: 4, aFaturar: 90 });
    expect(recordBillingFromMp({ partnerType: "agencia_viagem", multiparkKind: "partner", multiparkPartnerId: "u-sem", multiparkSnapshot: null }, live, "2026-09-01", "2026-09-30"))
      .toMatchObject({ bookingsCount: 0, aFaturar: 0 });
  });
  it("registos só nossos seguem a regra antiga", () => {
    expect(recordBillingFromMp({ partnerType: "operacional", multiparkKind: "own", multiparkPartnerId: null, multiparkSnapshot: null }, live, "2026-09-01", "2026-09-30")).toBeNull();
    expect(recordBillingFromMp({ partnerType: "hotel", multiparkKind: null, multiparkPartnerId: null, multiparkSnapshot: null }, live, "2026-09-01", "2026-09-30")).toBeNull();
  });
  it("avença anual → por mês", () => {
    expect(planMonthly(1200, "YEARLY")).toBe(100);
    expect(planMonthly(null, "MONTHLY")).toBe(0);
  });
});
