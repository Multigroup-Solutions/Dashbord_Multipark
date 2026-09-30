import { describe, expect, it } from "vitest";
import { buildPartnerBillingSql, mapPartnerBilling } from "./multiparkDb/partnerBilling";
import { planMonthly, recordBillingFromMp } from "../shared/partnerBilling";
import { partnerKeyIndex } from "../shared/partnerClose";

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

// Parceiros juntos (#184): o 2.º id da Multipark passou a alias e a faturação
// só lia o id principal — as reservas dele desapareciam da Faturação.
describe("faturação de parceiros ← Multipark: registos juntos", () => {
  const live = mapPartnerBilling([
    { kind: "partner", key: "u-a", name: "Pro Cabopol", n: "3", value: "300", ours: "30", missing: "1" },
    { kind: "partner", key: "u-b", name: "Blocotelha", n: "2", value: "200", ours: "20", missing: "0" },
    { kind: "pro", key: "c1", n: 2, value: "100" },
    { kind: "pro", key: "c2", n: 1, value: "50" },
  ], new Map());
  const rec = (aliasPartnerIds: string[]) => ({ partnerType: "agencia_viagem", multiparkKind: "partner", multiparkPartnerId: "u-a", multiparkSnapshot: null, aliasPartnerIds });
  it("soma o id principal e o alias", () => {
    expect(recordBillingFromMp(rec(["u-b"]), live, "2026-09-01", "2026-09-30"))
      .toEqual({ bookingsCount: 5, revenueGross: 500, aFaturar: 50, missing: 1, source: "multipark" });
  });
  it("ids repetidos contam uma vez; aliases de outro tipo não entram", () => {
    expect(recordBillingFromMp(rec(["u-a", "u-b", "u-b", "pro:c2"]), live, "2026-09-01", "2026-09-30"))
      .toMatchObject({ bookingsCount: 5, revenueGross: 500 });
  });
  it("Pro junto a Pro soma os dois", () => {
    expect(recordBillingFromMp({ partnerType: "cliente_pro", multiparkKind: "pro", multiparkPartnerId: "pro:c1", multiparkSnapshot: null, aliasPartnerIds: ["pro:c2", "u-b"] }, live, "2026-09-01", "2026-09-30"))
      .toMatchObject({ bookingsCount: 3, aFaturar: 150 });
  });
  it("sem aliases fica como antes", () => {
    expect(recordBillingFromMp(rec([]), live, "2026-09-01", "2026-09-30")).toMatchObject({ bookingsCount: 3, aFaturar: 30 });
  });
  it("fecho do mês: o alias aponta para o registo que ficou; o principal de outro registo manda", () => {
    const idx = partnerKeyIndex(
      [{ id: 1, name: "Pro Cabopol", multiparkPartnerId: "u-a" }, { id: 4, name: "Outro", multiparkPartnerId: "u-x" }, { id: 5, name: "Sem id", multiparkPartnerId: null }],
      [{ partnershipId: 1, aliasValue: "u-b" }, { partnershipId: 1, aliasValue: "u-x" }, { partnershipId: 9, aliasValue: "u-arquivado" }],
    );
    expect(idx.get("u-b")).toEqual({ id: 1, name: "Pro Cabopol" });
    expect(idx.get("u-x")).toEqual({ id: 4, name: "Outro" });
    expect(idx.has("u-arquivado")).toBe(false);
  });
});
