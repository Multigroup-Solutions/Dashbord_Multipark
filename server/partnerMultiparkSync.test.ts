import { describe, expect, it } from "vitest";
import { compatible, feeSummary, nameSimilarity, ourTypeForPartner, ourTypeForPlan, partnerNameKey, planPartnerSync, type MpEntity, type OurPartnerRecord } from "../shared/partnerMultiparkSync";
import { monthlyFromPlan } from "./partnerMultiparkSync";

const ent = (o: Partial<MpEntity> & Pick<MpEntity, "key" | "kind" | "name">): MpEntity => ({ altKeys: [], partnerType: null, active: true, snapshot: {}, ...o });
const rec = (o: Partial<OurPartnerRecord> & Pick<OurPartnerRecord, "id" | "name">): OurPartnerRecord => ({ partnerType: "outro", multiparkPartnerId: null, archivedAt: null, ...o });

describe("parcerias ← Multipark: regras", () => {
  it("tipos e nomes", () => {
    expect(ourTypeForPartner("AGGREGATOR")).toBe("agregador");
    expect(ourTypeForPartner("AGENCY")).toBe("agencia_viagem");
    expect(ourTypeForPartner("PARTNER")).toBeNull();
    expect(ourTypeForPlan("YEARLY")).toBe("avenca_anual");
    expect(ourTypeForPlan("MONTHLY")).toBe("avenca_mensal");
    expect(partnerNameKey("Pro Cabopol")).toBe(partnerNameKey("CABOPOL"));
    expect(partnerNameKey("Avença Anual Pawel Piechowiak")).toBe(partnerNameKey("Pawel Piechowiak"));
    expect(partnerNameKey("Agência de Viagens Be in Travel")).toBe(partnerNameKey("Be in Travel"));
    expect(compatible("pro", "cliente_pro")).toBe(true);
    expect(compatible("pro", "agencia_viagem")).toBe(false);
    expect(compatible("partner", "operacional")).toBe(false);
    expect(compatible("plan", "avenca_anual")).toBe(true);
  });
  it("taxa e avença", () => {
    expect(feeSummary([{ parkName: "A", feeType: "PERCENTAGE", feePct: 25, feeFixed: null, active: true }, { parkName: "B", feeType: "PERCENTAGE", feePct: 25, feeFixed: null, active: true }])).toBe("25 %");
    expect(feeSummary([{ parkName: "A", feeType: "PERCENTAGE", feePct: 25, feeFixed: null, active: true }, { parkName: "B", feeType: "FIXED", feePct: null, feeFixed: 5, active: true }])).toBe("A: 25 % · B: 5,00 €");
    expect(monthlyFromPlan(120, "YEARLY")).toBe(10);
    expect(monthlyFromPlan(30, "MONTHLY")).toBe(30);
    expect(monthlyFromPlan(null, "MONTHLY")).toBeNull();
  });
});

describe("parcerias ← Multipark: plano", () => {
  const entities: MpEntity[] = [
    ent({ key: "u-lets", altKeys: ["p1", "p2"], kind: "partner", name: "Let's Travel", partnerType: "agencia_viagem" }),
    ent({ key: "u-parkos", kind: "partner", name: "Parkos", partnerType: "agregador" }),
    ent({ key: "pro:c1", kind: "pro", name: "Cabopol", partnerType: "cliente_pro" }),
    ent({ key: "plan:9", kind: "plan", name: "Anna Dier", partnerType: "avenca_mensal" }),
    ent({ key: "u-novo", kind: "partner", name: "Agência Nova", partnerType: "agencia_viagem" }),
    ent({ key: "u-dup", kind: "partner", name: "Bestravel", partnerType: "agencia_viagem" }),
  ];
  const records: OurPartnerRecord[] = [
    rec({ id: 1, name: "Lets Travel", partnerType: "agencia_viagem", multiparkPartnerId: "p2" }), // pela linha por parque
    rec({ id: 2, name: "Parkos", partnerType: "agregador" }),                                  // pelo nome
    rec({ id: 3, name: "Pro Cabopol", partnerType: "cliente_pro" }),
    rec({ id: 4, name: "Avença Anna Dier", partnerType: "avenca_mensal" }),
    rec({ id: 5, name: "Bestravel", partnerType: "agencia_viagem" }),
    rec({ id: 6, name: "Bestravel", partnerType: "afiliado" }),
    rec({ id: 7, name: "Pro Antigo", partnerType: "cliente_pro" }),                            // sem par → arquivar
    rec({ id: 8, name: "Top Parking", partnerType: "operacional" }),                           // só nosso
    rec({ id: 9, name: "Velho", partnerType: "agencia_viagem", multiparkPartnerId: "u-sumiu" }), // já não existe
    rec({ id: 10, name: "Parkos", partnerType: "agregador", archivedAt: "2026-09-01 00:00:00" }),
    rec({ id: 11, name: "Pro Mantido", partnerType: "cliente_pro", multiparkKind: "own" }),   // o dono disse que fica
  ];
  const plan = planPartnerSync(entities, records);
  it("liga pelo id (também pelas linhas por parque) e pelo nome", () => {
    expect(plan.links.find((l) => l.key === "u-lets")).toMatchObject({ recordId: 1, by: "id" });
    expect(plan.links.find((l) => l.key === "u-parkos")).toMatchObject({ recordId: 2, by: "nome" });
    expect(plan.links.find((l) => l.key === "pro:c1")).toMatchObject({ recordId: 3, by: "nome" });
    expect(plan.links.find((l) => l.key === "plan:9")).toMatchObject({ recordId: 4, by: "nome" });
  });
  it("cria o que falta e deixa à mão os nomes repetidos", () => {
    expect(plan.creates.map((c) => c.key)).toEqual(["u-novo"]);
    expect(plan.ambiguous).toEqual([{ key: "u-dup", kind: "partner", name: "Bestravel", candidates: [{ id: 5, name: "Bestravel" }, { id: 6, name: "Bestravel" }] }]);
  });
  it("arquiva só os tipos da Multipark sem par (nunca os só nossos, os à mão ou os que o dono manteve)", () => {
    expect(plan.archives.map((a) => a.recordId).sort()).toEqual([7, 9]);
  });
  it("sem a leitura completa não arquiva nada", () => {
    expect(planPartnerSync(entities, records, false).archives).toEqual([]);
  });
});

describe("parcerias ← Multipark: nomes parecidos", () => {
  it("Bestravel ≈ BestTravel (uma letra) liga; lojas diferentes não", () => {
    expect(nameSimilarity(partnerNameKey("Agência Bestravel Castelo Branco"), partnerNameKey("BestTravel Castelo Branco"))).toBeGreaterThan(0.9);
    expect(nameSimilarity(partnerNameKey("Agência Bestravel Castelo Branco"), partnerNameKey("Bestravel Maia"))).toBeLessThan(0.7);
  });
  it("liga o parecido em vez de criar um novo e arquivar o velho", () => {
    const plan = planPartnerSync(
      [ent({ key: "u-cb", kind: "partner", name: "Agência Bestravel Castelo Branco", partnerType: "agencia_viagem" })],
      [rec({ id: 1, name: "BestTravel Castelo Branco", partnerType: "agencia_viagem" }), rec({ id: 2, name: "Bestravel Maia", partnerType: "agencia_viagem" })],
    );
    expect(plan.links).toMatchObject([{ recordId: 1, by: "parecido" }]);
    expect(plan.creates).toEqual([]);
    expect(plan.archives.map((a) => a.recordId)).toEqual([2]);
  });
  it("só parecido (um dentro do outro) fica à mão e não se arquiva", () => {
    const plan = planPartnerSync(
      [ent({ key: "u-x", kind: "partner", name: "Viagens Abreu Porto", partnerType: "agencia_viagem" })],
      [rec({ id: 5, name: "Viagens Abreu", partnerType: "agencia_viagem" })],
    );
    expect(plan.ambiguous).toMatchObject([{ key: "u-x", candidates: [{ id: 5 }] }]);
    expect(plan.archives).toEqual([]);
    expect(plan.creates).toEqual([]);
  });
});
