import { describe, expect, it } from "vitest";
import {
  buildPartnerIndex, bucketKey, commissionFor, computeMargin, daysBetweenInclusive, employerTaxFor,
  extrasCityFromKey, extrasDiaRate, isExtraEmployee, isoWeekKey, monthsOverlapping, netOfVat,
  salaryForPeriod, shareTargets, shiftHours, FINANCE_PARAMS,
} from "./rules";

describe("calendário", () => {
  it("dias inclusivos e meses sobrepostos", () => {
    expect(daysBetweenInclusive("2026-02-01", "2026-02-28")).toBe(28);
    expect(daysBetweenInclusive("2026-09-09", "2026-09-09")).toBe(1);
    const ms = monthsOverlapping("2026-01-20", "2026-03-05");
    expect(ms.map((m) => `${m.month}:${m.days}/${m.daysInMonth}`)).toEqual(["1:12/31", "2:28/28", "3:5/31"]);
  });
  it("buckets iguais ao DATE_FORMAT do MySQL", () => {
    expect(bucketKey("2026-09-09", "day")).toBe("2026-09-09");
    expect(bucketKey("2026-09-09", "month")).toBe("2026-09");
    expect(bucketKey("2026-09-09", "year")).toBe("2026");
    expect(isoWeekKey("2026-01-01")).toBe("2026-W01");   // quinta → semana 1 de 2026
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");   // sexta → ainda semana 53 de 2026
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01");   // segunda → semana 1 de 2025
  });
});

describe("salaryForPeriod", () => {
  it("mês completo = salário mensal, em fevereiro e em meses de 31 dias", () => {
    expect(salaryForPeriod({ monthlySalary: 1500, from: "2026-02-01", to: "2026-02-28" }).base).toBeCloseTo(1500, 6);
    expect(salaryForPeriod({ monthlySalary: 1500, from: "2026-07-01", to: "2026-07-31" }).base).toBeCloseTo(1500, 6);
    expect(salaryForPeriod({ monthlySalary: 1500, from: "2026-02-01", to: "2026-02-28" }).days).toBe(28);
  });
  it("período parcial é proporcional aos dias do PRÓPRIO mês", () => {
    const r = salaryForPeriod({ monthlySalary: 3100, from: "2026-07-01", to: "2026-07-10" });
    expect(r.base).toBeCloseTo(1000, 6);       // 3100/31 × 10
    expect(r.perDay).toHaveLength(10);
  });
  it("respeita início e fim de contrato (inativos com vínculo no período contam)", () => {
    const r = salaryForPeriod({ monthlySalary: 3000, from: "2026-06-01", to: "2026-06-30", contractEnd: "2026-06-15" });
    expect(r.base).toBeCloseTo(1500, 6);
    const s = salaryForPeriod({ monthlySalary: 3000, from: "2026-06-01", to: "2026-06-30", contractStart: "2026-07-01" });
    expect(s.base).toBe(0);
  });
  it("provisões 13.º/14.º = 2/12 do base, proporcionais; salário histórico por mês", () => {
    const r = salaryForPeriod({ monthlySalary: 1200, from: "2026-01-01", to: "2026-02-28", salaryByMonth: { "2026-02": 1800 } });
    expect(r.base).toBeCloseTo(3000, 6);
    expect(r.provisions).toBeCloseTo(500, 6);   // 3000 × 2/12
  });
});

describe("pessoal — regras auxiliares", () => {
  it("extra por UM critério (contractType OU position)", () => {
    expect(isExtraEmployee({ contractType: "extra", position: "driver" })).toBe(true);
    expect(isExtraEmployee({ contractType: "permanent", position: "extra" })).toBe(true);
    expect(isExtraEmployee({ contractType: "permanent", position: "driver" })).toBe(false);
  });
  it("rateio pelas folhas e filtro", () => {
    expect(shareTargets([1, 2, 3, 4], new Set([1, 2]))).toEqual({ matching: [1, 2], share: 0.5 });
    expect(shareTargets([], new Set([1]))).toEqual({ matching: [], share: 0 });
  });
  it("TSU só sobre a base tributável", () => {
    expect(employerTaxFor(1000)).toBeCloseTo(237.5, 6);
  });
});

describe("equipa do dia", () => {
  it("saída antecipada prevalece; sem ela usa endHour; nunca negativo", () => {
    expect(shiftHours(8, 16, null)).toBe(8);
    expect(shiftHours(8, 16, 12)).toBe(4);
    expect(shiftHours(8, 16, 6)).toBe(0);
  });
  it("tarifas por nível e cidade das escalas", () => {
    expect(extrasDiaRate("master")).toBe(6);
    expect(extrasDiaRate(null)).toBe(FINANCE_PARAMS.extrasDiaRates.junior);
    expect(extrasDiaRate("desconhecido")).toBe(FINANCE_PARAMS.extrasDiaDefaultRate);
    expect(extrasCityFromKey("lisboa")).toBe("lisbon");
    expect(extrasCityFromKey("faro")).toBe("faro");
    expect(extrasCityFromKey(null)).toBeNull();
  });
});

describe("parceiros e comissões", () => {
  const partners = [
    { id: 1, name: "Agência A", campaignKey: "AGA", commissionRate: 10, updatedAt: "2026-01-01" },
    { id: 2, name: "Agência B", campaignKey: "AGA", commissionRate: 15, updatedAt: "2026-05-01" },
    { id: 3, name: "Sem taxa", campaignKey: "ST", commissionRate: null, updatedAt: "2026-01-01" },
    { id: 4, name: "Zero", campaignKey: "Z0", commissionRate: 0, updatedAt: "2026-01-01" },
  ];
  const idx = buildPartnerIndex(partners as any, [{ partnershipId: 1, aliasValue: "pm-a" }]);
  it("conflitos ficam assinalados (o mais recente ganha, mas não em silêncio)", () => {
    expect(idx.byKey.get("aga")?.id).toBe(2);
    expect(idx.conflicts).toEqual([{ key: "aga", partnerIds: [2, 1] }]);
    expect(idx.byKey.get("pm-a")?.id).toBe(1);
  });
  it("distingue 0% confirmado, taxa em falta e sem parceiro", () => {
    expect(commissionFor(100, idx.byKey.get("aga"))).toEqual({ commission: 15, status: "ok" });
    expect(commissionFor(100, idx.byKey.get("st"))).toEqual({ commission: 0, status: "rate_missing" });
    expect(commissionFor(100, idx.byKey.get("z0"))).toEqual({ commission: 0, status: "rate_zero" });
    expect(commissionFor(100, undefined)).toEqual({ commission: 0, status: "no_partner" });
  });
});

describe("computeMargin — a fórmula", () => {
  it("receita s/IVA − despesas s/IVA − pessoal − TSU − extras − comissões", () => {
    const r = computeMargin({
      revenueGross: 1230, expensesGross: 123,
      salariesBase: 100, salariesProvisions: 10, salariesVariable: 5, employerTax: 25,
      extrasDia: 20, salesCommissions: 7, operationalCommissions: 3,
    });
    expect(r.revenueNet).toBeCloseTo(1000, 6);
    expect(r.expensesNet).toBeCloseTo(100, 6);
    expect(r.salaries).toBeCloseTo(115, 6);
    expect(r.personnel).toBeCloseTo(140, 6);
    expect(r.commissions).toBeCloseTo(10, 6);
    expect(r.totalCostsNet).toBeCloseTo(270, 6);
    expect(r.margin).toBeCloseTo(730, 6);
    expect(r.marginPct).toBeCloseTo(73, 6);
    expect(r.vatToPay).toBeCloseTo(230 - 23, 6);
  });
  it("comissão entra UMA vez (custo), nunca deduzida à receita", () => {
    const a = computeMargin({ revenueGross: 1230, expensesGross: 0, salariesBase: 0, salariesProvisions: 0, salariesVariable: 0, employerTax: 0, extrasDia: 0, salesCommissions: 100, operationalCommissions: 0 });
    expect(a.revenueNet).toBeCloseTo(1000, 6);
    expect(a.margin).toBeCloseTo(900, 6);
  });
  it("sem receita a % é null, não zero", () => {
    expect(computeMargin({ revenueGross: 0, expensesGross: 0, salariesBase: 0, salariesProvisions: 0, salariesVariable: 0, employerTax: 0, extrasDia: 0, salesCommissions: 0, operationalCommissions: 0 }).marginPct).toBeNull();
    expect(netOfVat(123)).toBeCloseTo(100, 6);
  });
});
