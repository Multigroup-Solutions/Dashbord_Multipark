import { describe, expect, it } from "vitest";
import { attributionFromUrl } from "./attribution";
import { addTotals, chunkRange, coverageFor, derivedRatios, emptyTotals, isProvisional, microsToAmount, normalizeCustomerId, syncWindow } from "./metrics";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto";
import { gaqlCampaignDaily, gaqlConversionActions, parseCampaignDailyRow, parseCustomerClientRow } from "./gaql";
import crypto from "crypto";

describe("attributionFromUrl", () => {
  it("gclid prova clique pago; ID de campanha vem do ValueTrack", () => {
    const a = attributionFromUrl("https://multipark.pt/lisboa?gclid=Cj0KCQ&campaignid=1234567890&utm_source=google&utm_medium=cpc&utm_campaign=Brand%20Lisboa");
    expect(a.adAttribution).toBe("google_paid");
    expect(a.evidence).toBe("gclid");
    expect(a.adCampaignExternalId).toBe("1234567890");
    expect(a.utmCampaign).toBe("Brand Lisboa");
  });
  it("gbraid/wbraid também provam; utm google+cpc prova sem gclid", () => {
    expect(attributionFromUrl("https://x.pt/?wbraid=abc").evidence).toBe("wbraid");
    expect(attributionFromUrl("https://x.pt/?gbraid=abc").evidence).toBe("gbraid");
    const u = attributionFromUrl("https://x.pt/?utm_source=Google&utm_medium=CPC&utm_campaign=98765432");
    expect(u.adAttribution).toBe("google_paid");
    expect(u.evidence).toBe("utm_paid");
    expect(u.adCampaignExternalId).toBe("98765432");
  });
  it("google orgânico, URL genérico e vazio NÃO são atribuídos", () => {
    expect(attributionFromUrl("https://x.pt/?utm_source=google&utm_medium=organic").adAttribution).toBe("unknown");
    expect(attributionFromUrl("https://multipark.pt/porto").adAttribution).toBe("unknown");
    expect(attributionFromUrl(null).adAttribution).toBe("unknown");
    expect(attributionFromUrl("lixo sem url").adAttribution).toBe("unknown");
  });
  it("parâmetros no fragmento (SPA) e query solta", () => {
    expect(attributionFromUrl("https://x.pt/#/reservar?gclid=zzz").evidence).toBe("gclid");
    expect(attributionFromUrl("?gclid=zzz&utm_campaign=abc").adCampaignExternalId).toBeNull();
  });
});

describe("metrics", () => {
  it("micros, totais e rácios dos totais", () => {
    expect(microsToAmount(1_234_560_000)).toBeCloseTo(1234.56, 6);
    const t = addTotals(addTotals(emptyTotals(), { costMicros: 10_000_000, clicks: 10, impressions: 1000, conversions: 1.5, conversionValueMicros: 30_000_000 }), { clicks: 10, impressions: 1000 });
    const r = derivedRatios(t);
    expect(r.cpc).toBeCloseTo(0.5, 6);
    expect(r.ctr).toBeCloseTo(0.01, 6);
    expect(r.costPerConversion).toBeCloseTo(10 / 1.5, 6);
    expect(r.roasGoogle).toBeCloseTo(3, 6);
    expect(derivedRatios(emptyTotals()).cpc).toBeNull();
  });
  it("janelas de recolha e pedaços", () => {
    expect(syncWindow("hourly", "2026-09-09")).toEqual({ from: "2026-09-03", to: "2026-09-09" });
    expect(syncWindow("nightly", "2026-09-09")).toEqual({ from: "2026-06-12", to: "2026-09-09" });
    expect(syncWindow("monthly", "2026-09-09")).toEqual({ from: "2023-08-09", to: "2026-06-11" });
    expect(chunkRange("2026-01-01", "2026-02-15", 31)).toEqual([{ from: "2026-01-01", to: "2026-01-31" }, { from: "2026-02-01", to: "2026-02-15" }]);
    expect(chunkRange("2026-03-01", "2026-03-01")).toEqual([{ from: "2026-03-01", to: "2026-03-01" }]);
  });
  it("cobertura distingue API, legado e em falta; hoje é provisório", () => {
    expect(isProvisional("2026-09-09", "2026-09-09")).toBe(true);
    expect(isProvisional("2026-09-06", "2026-09-09")).toBe(false);
    const c = coverageFor("2026-09-01", "2026-09-09", new Set(["2026-09-01", "2026-09-02", "2026-09-09"]), new Set(["2026-09-03"]), new Date().toISOString(), "2026-09-09");
    expect(c).toMatchObject({ daysInRange: 9, apiDays: 3, legacyDays: 1, missingDays: 5, lastCompleteDay: "2026-09-02", status: "partial" });
    expect(coverageFor("2026-09-01", "2026-09-02", new Set(), new Set(), null, "2026-09-09").status).toBe("none");
    expect(normalizeCustomerId("123-456-7890")).toBe("1234567890");
  });
});

describe("crypto", () => {
  it("cifra e decifra com AES-GCM; adulteração falha", () => {
    const key = crypto.randomBytes(32);
    const enc = encryptSecret("1//refresh-token-xyz", key);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(enc, key)).toBe("1//refresh-token-xyz");
    const tampered = enc.slice(0, -4) + "AAAA";
    expect(() => decryptSecret(tampered, key)).toThrow();
    expect(maskSecret("ya29.abcdefghijk")).toBe("ya29…jk");
  });
});

describe("gaql", () => {
  it("consultas só de leitura com datas validadas", () => {
    expect(gaqlCampaignDaily("2026-09-01", "2026-09-09")).toContain("BETWEEN '2026-09-01' AND '2026-09-09'");
    expect(() => gaqlCampaignDaily("hoje", "2026-09-09")).toThrow();
    expect(gaqlConversionActions("2026-09-01", "2026-09-09")).toContain("segments.conversion_action");
  });
  it("parse das linhas da API (camelCase do REST)", () => {
    const row = parseCampaignDailyRow({ campaign: { id: "123", name: "Brand", status: "ENABLED", advertisingChannelType: "SEARCH" }, campaignBudget: { amountMicros: "20000000" }, segments: { date: "2026-09-08" }, metrics: { costMicros: "1500000", impressions: "100", clicks: "7", conversions: 1.25, conversionsValue: 40.5 } });
    expect(row).toMatchObject({ campaignId: "123", budgetMicros: 20_000_000, costMicros: 1_500_000, conversions: 1.25, conversionValueMicros: 40_500_000 });
    expect(parseCampaignDailyRow({})).toBeNull();
    expect(parseCustomerClientRow({ customerClient: { id: "999", descriptiveName: "Multipark", currencyCode: "EUR", timeZone: "Europe/Lisbon", manager: false, level: 1 } })).toMatchObject({ customerId: "999", currency: "EUR", manager: false });
  });
});
