import { describe, expect, it } from "vitest";
import {
  bookingCampaignFallback, isPartnerUnconfigured, monthBoundsOf, monthsCovered,
  partnerFeeForPeriod,
} from "../shared/partnerRules";
import { buildPartnerIndex, commissionFor } from "./finance/rules";

describe("avenças rateadas pelo período", () => {
  it("um mês completo vale 1, seja de 28, 30 ou 31 dias", () => {
    expect(monthsCovered("2026-02-01", "2026-02-28")).toBe(1);
    expect(monthsCovered("2026-09-01", "2026-09-30")).toBe(1);
    expect(monthsCovered("2026-08-01", "2026-08-31")).toBe(1);
    expect(monthsCovered("2026-01-01", "2026-12-31")).toBeCloseTo(12, 10);
  });
  it("meses parciais contam a fração de dias desse mês", () => {
    expect(monthsCovered("2026-09-01", "2026-09-15")).toBeCloseTo(0.5, 10);
    expect(monthsCovered("2026-08-17", "2026-09-15")).toBeCloseTo(15 / 31 + 0.5, 10);
    expect(monthsCovered("2026-09-15", "2026-09-01")).toBe(0);
  });
  it("avença anual usa o valor mensal do formulário (×12 ao ano), não 1/12", () => {
    expect(partnerFeeForPeriod("avenca_anual", 100, "2026-09-01", "2026-09-30")).toBe(100);
    expect(partnerFeeForPeriod("avenca_anual", 100, "2026-01-01", "2026-12-31")).toBe(1200);
    expect(partnerFeeForPeriod("avenca_mensal", 100, "2026-08-01", "2026-08-31")).toBe(100);
    expect(partnerFeeForPeriod("avenca_mensal", 100, "2026-09-01", "2026-09-15")).toBe(50);
  });
  it("outros tipos, fee nula ou negativa → 0", () => {
    expect(partnerFeeForPeriod("agregador", 100, "2026-09-01", "2026-09-30")).toBe(0);
    expect(partnerFeeForPeriod("avenca_mensal", null, "2026-09-01", "2026-09-30")).toBe(0);
    expect(partnerFeeForPeriod("avenca_mensal", -5, "2026-09-01", "2026-09-30")).toBe(0);
  });
});

describe("fallback de campanha no sync", () => {
  it("'Unknown User' não apaga o código de desconto", () => {
    expect(bookingCampaignFallback({ partnerName: "Unknown User", discountCode: "PARKOS10" })).toBe("PARKOS10");
    expect(bookingCampaignFallback({ partnerName: "Unknown User", campaign: "Verão" })).toBe("Verão");
    expect(bookingCampaignFallback({ partnerName: "Unknown User" })).toBeNull();
  });
  it("partnerName real tem prioridade; vazios são ignorados", () => {
    expect(bookingCampaignFallback({ partnerName: "Parkos", discountCode: "X" })).toBe("Parkos");
    expect(bookingCampaignFallback({ partnerName: "  ", discountCode: " X " })).toBe("X");
    expect(bookingCampaignFallback({})).toBeNull();
  });
});

describe("parceiros por configurar", () => {
  it("configuredAt NULL = por configurar", () => {
    expect(isPartnerUnconfigured({ configuredAt: null })).toBe(true);
    expect(isPartnerUnconfigured({})).toBe(true);
    expect(isPartnerUnconfigured({ configuredAt: "2026-09-24 10:00:00" })).toBe(false);
  });
  it("taxa 0 nunca configurada é rate_missing; 0 confirmado é rate_zero", () => {
    const idx = buildPartnerIndex([
      { id: 1, name: "auto", commissionRate: 0, updatedAt: "2026-09-01", configuredAt: null },
      { id: 2, name: "conf", commissionRate: 0, updatedAt: "2026-09-01", configuredAt: "2026-09-02 10:00:00" },
      { id: 3, name: "legado", commissionRate: 0, updatedAt: "2026-09-01" },
    ], []);
    expect(commissionFor(100, idx.byKey.get("auto")).status).toBe("rate_missing");
    expect(commissionFor(100, idx.byKey.get("conf")).status).toBe("rate_zero");
    expect(commissionFor(100, idx.byKey.get("legado")).status).toBe("rate_zero");
  });
});

describe("limites do mês por omissão", () => {
  it("dá o 1.º e o último dia do mês do dia de Lisboa", () => {
    expect(monthBoundsOf("2026-09-24")).toEqual({ monthStart: "2026-09-01", monthEnd: "2026-09-30" });
    expect(monthBoundsOf("2028-02-10")).toEqual({ monthStart: "2028-02-01", monthEnd: "2028-02-29" });
  });
});
