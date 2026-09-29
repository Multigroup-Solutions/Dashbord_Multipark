import { describe, expect, it, vi } from "vitest";
import { budgetPacing, finalSyncStatus, isStaleSince, isoWeekKey, roasNetOfVat, weeklyRanges, weeklyReportDue, weeklyReportRunKey, isCancelledStatus } from "../shared/marketingRules";
import { attributionFromUrl } from "./integrations/googleAds/attribution";
import { nationalSharesForBrand, rollingCityWeights } from "../shared/adCampaignMapping";
import { legacyOverriddenByApi, legacyProvider } from "./integrations/googleAds/adMetrics";
import { joinOpsDaily } from "../shared/operationsDaily";
import { fetchMetaInsights, MetaApiError, parseInsightRow } from "./integrations/meta/insights";
import { missingMetaEnvs, readMetaConfig } from "./integrations/meta/config";
import { matchBookingsToCampaigns } from "./marketingCampaignRoas";
import { renderWeeklyEmail, weeklyRecipients, type WeeklyReport } from "./marketingWeekly";
import { FINANCE_PARAMS } from "./finance/rules";

describe("estado honesto da recolha", () => {
  it("todas as contas falharam → failed; algumas → partial; nenhuma → done; ok só sem falhas", () => {
    expect(finalSyncStatus(3, 0)).toEqual({ status: "done", ok: true });
    expect(finalSyncStatus(3, 1)).toEqual({ status: "partial", ok: false });
    expect(finalSyncStatus(3, 3)).toEqual({ status: "failed", ok: false });
    expect(finalSyncStatus(0, 0)).toEqual({ status: "failed", ok: false });
  });
  it("parada = mais de 26 h sem sucesso (o mesmo limiar em todo o lado)", () => {
    const now = Date.UTC(2026, 8, 24, 12, 0, 0);
    expect(isStaleSince("2026-09-23 11:00:00", now)).toBe(false);   // 25 h
    expect(isStaleSince("2026-09-23 09:00:00", now)).toBe(true);    // 27 h
    expect(isStaleSince("2026-09-23T09:00:00Z", now)).toBe(true);
    expect(isStaleSince(null, now)).toBe(true);
  });
});

describe("atribuição Meta", () => {
  it("fbclid ou utm_source de Meta → meta_paid", () => {
    const a = attributionFromUrl("https://multipark.pt/?fbclid=IwAR123&utm_campaign=120211234567890");
    expect(a).toMatchObject({ adAttribution: "meta_paid", evidence: "fbclid", fbclid: "IwAR123", adCampaignExternalId: "120211234567890" });
    for (const src of ["facebook", "Instagram", "meta", "fb", "IG"]) {
      expect(attributionFromUrl(`https://x.pt/?utm_source=${src}&utm_medium=paid_social`)).toMatchObject({ adAttribution: "meta_paid", evidence: "utm_meta" });
    }
  });
  it("o clique Google ganha quando os dois aparecem; utm de outras fontes não é Meta", () => {
    expect(attributionFromUrl("https://x.pt/?gclid=abc&fbclid=def").adAttribution).toBe("google_paid");
    expect(attributionFromUrl("https://x.pt/?utm_source=newsletter").adAttribution).toBe("unknown");
    expect(attributionFromUrl("https://x.pt/?utm_source=facebookish").adAttribution).toBe("unknown");
  });
});

describe("repartição do nacional com janela estável (28 dias)", () => {
  const projects = [
    { id: 1, name: "Lisboa", level: "city", parentId: null },
    { id: 2, name: "Porto", level: "city", parentId: null },
    { id: 11, name: "Airpark", level: "brand", parentId: 1 },
    { id: 12, name: "Airpark", level: "brand", parentId: 2 },
  ];
  const cost = new Map<string, Map<number, number>>([
    ["2026-09-01", new Map([[11, 300], [12, 100]])],
    ["2026-09-10", new Map([[11, 100], [12, 100]])],
    ["2026-09-20", new Map([[12, 800]])],   // depois do dia 10: NÃO pode mexer na parte do dia 10
  ]);
  it("a parte de um dia só depende dos 28 dias até esse dia (não do período escolhido)", () => {
    const d10 = nationalSharesForBrand("Airpark", projects, rollingCityWeights(cost, "2026-09-10"));
    expect(d10).toEqual([{ projectId: 11, fraction: 400 / 600 }, { projectId: 12, fraction: 200 / 600 }]);
    // "1–15" ou "1–30": o dia 10 usa sempre os mesmos pesos
    const again = nationalSharesForBrand("Airpark", projects, rollingCityWeights(cost, "2026-09-10"));
    expect(again).toEqual(d10);
    const d20 = nationalSharesForBrand("Airpark", projects, rollingCityWeights(cost, "2026-09-20"));
    expect(d20[1].fraction).toBeGreaterThan(d10[1].fraction);
  });
  it("fora da janela não pesa; sem pesos → partes iguais", () => {
    expect(rollingCityWeights(cost, "2026-10-20").size).toBe(0);            // janela 23/09..20/10: nenhum gasto
    expect(rollingCityWeights(cost, "2026-09-28").get(11)).toBe(400);       // 01/09 ainda dentro (28 dias: 01..28)
    expect(rollingCityWeights(cost, "2026-09-29").get(11)).toBe(100);       // 01/09 já saiu
    expect(nationalSharesForBrand("Airpark", projects, new Map())).toEqual([{ projectId: 11, fraction: 0.5 }, { projectId: 12, fraction: 0.5 }]);
  });
});

describe("legado por plataforma", () => {
  it("Meta antiga ignorada só nos dias com dados da API Meta; Google idem; 'other' conta sempre", () => {
    const api = new Map([["google_ads", new Set(["2026-09-01"])], ["meta", new Set(["2026-09-02"])]]);
    expect(legacyOverriddenByApi("google_ads", "2026-09-01", api)).toBe(true);
    expect(legacyOverriddenByApi("meta_ads", "2026-09-01", api)).toBe(false);
    expect(legacyOverriddenByApi("meta_ads", "2026-09-02", api)).toBe(true);
    expect(legacyOverriddenByApi("instagram", "2026-09-02", api)).toBe(true);
    expect(legacyOverriddenByApi("other", "2026-09-02", api)).toBe(false);
    expect(legacyProvider("instagram")).toBe("meta");
    expect(legacyProvider(null)).toBe("google_ads");
  });
});

describe("ritmo de orçamento (hoje não conta)", () => {
  it("esperado pelos dias COMPLETOS", () => {
    // dia 16 de um mês de 30: 15 dias completos → esperado 3000×15/30 = 1500
    const p = budgetPacing({ amount: 3000, spentToDate: 1800, dayOfMonth: 16, daysInMonth: 30 });
    expect(p).toMatchObject({ elapsedDays: 15, expected: 1500, status: "over" });
    expect(p.ratio).toBeCloseTo(1.2);
    expect(p.projected).toBeCloseTo(3600);
    expect(budgetPacing({ amount: 3000, spentToDate: 1100, dayOfMonth: 16, daysInMonth: 30 }).status).toBe("under"); // 73%
    expect(budgetPacing({ amount: 3000, spentToDate: 1500, dayOfMonth: 16, daysInMonth: 30 }).status).toBe("ok");
    expect(budgetPacing({ amount: 3000, spentToDate: 1640, dayOfMonth: 16, daysInMonth: 30 }).status).toBe("ok");   // 109%
  });
  it("início do mês: sem veredicto; mês fechado: todos os dias contam", () => {
    expect(budgetPacing({ amount: 3000, spentToDate: 50, dayOfMonth: 1, daysInMonth: 30 })).toMatchObject({ elapsedDays: 0, expected: 0, status: "early" });
    expect(budgetPacing({ amount: 3000, spentToDate: 200, dayOfMonth: 3, daysInMonth: 30 }).status).toBe("early");
    expect(budgetPacing({ amount: 3000, spentToDate: 3000, dayOfMonth: 31, daysInMonth: 30 })).toMatchObject({ elapsedDays: 30, expected: 3000, status: "ok" });
  });
});

describe("ROAS sem IVA", () => {
  it("receita ÷ (1 + IVA) ÷ gasto, com o IVA do FINANCE_PARAMS", () => {
    expect(FINANCE_PARAMS.vatRate).toBe(0.23);
    expect(roasNetOfVat(1230, 100, FINANCE_PARAMS.vatRate)).toBeCloseTo(10);
    expect(roasNetOfVat(1230, 0, 0.23)).toBeNull();
  });
  it("cancelada = status 'CANCELLED' exato (NULL e outros estados são ativos, como nas Reservas & Operações)", () => {
    expect(isCancelledStatus("CANCELLED")).toBe(true);
    expect(isCancelledStatus(null)).toBe(false);
    expect(isCancelledStatus("CANCELLATION_REQUESTED")).toBe(false);
  });
});

describe("email semanal: idempotência por semana ISO", () => {
  it("chave estável durante a semana; muda na semana seguinte", () => {
    expect(isoWeekKey("2026-09-28")).toBe("2026-W40");
    expect(weeklyReportRunKey("2026-09-28")).toBe("marketing-weekly:2026-W40");
    expect(weeklyReportRunKey("2026-10-04")).toBe("marketing-weekly:2026-W40");  // domingo, mesma semana
    expect(weeklyReportRunKey("2026-10-05")).toBe("marketing-weekly:2026-W41");
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");                               // semana ISO do ano anterior
  });
  it("só à segunda a partir das 8h; semana anterior seg–dom", () => {
    expect(weeklyReportDue({ dow: 1, hour: 7 })).toBe(false);
    expect(weeklyReportDue({ dow: 1, hour: 8 })).toBe(true);
    expect(weeklyReportDue({ dow: 2, hour: 9 })).toBe(false);
    expect(weeklyRanges("2026-09-28")).toEqual({ current: { from: "2026-09-21", to: "2026-09-27" }, previous: { from: "2026-09-14", to: "2026-09-20" } });
  });
  it("destinatários e texto", () => {
    expect(weeklyRecipients({ MARKETING_REPORT_EMAILS: "a@x.pt, b@y.pt;lixo" })).toEqual(["a@x.pt", "b@y.pt"]);
    expect(weeklyRecipients({})).toEqual([]);
    const line = { label: "Airpark", spend: 1000, bookings: 50, revenue: 6150, prevSpend: 800, prevBookings: 40, prevRevenue: 4920 };
    const r: WeeklyReport = { range: { from: "2026-09-21", to: "2026-09-27" }, prevRange: { from: "2026-09-14", to: "2026-09-20" }, vatRate: 0.23, total: { ...line, label: "Total" }, brands: [line], cities: [], top: [], bottom: [], alerts: [] };
    const m = renderWeeklyEmail(r);
    expect(m.subject).toContain("21/09–27/09");
    expect(m.text).toContain("+25%");
    expect(m.text).toContain("5,00×");   // 6150 ÷ 1,23 ÷ 1000
  });
});

describe("Meta Insights (sem rede)", () => {
  const cfg = readMetaConfig({ META_ACCESS_TOKEN: "tok", META_AD_ACCOUNT_IDS: "act_111, 222", META_API_VERSION: "23.0" });
  it("configuração por env", () => {
    expect(cfg).toMatchObject({ accountIds: ["111", "222"], apiVersion: "v23.0" });
    expect(missingMetaEnvs(readMetaConfig({}))).toEqual(["META_ACCESS_TOKEN", "META_AD_ACCOUNT_IDS"]);
  });
  it("uma compra conta uma vez (omni_purchase > purchase > pixel) e as ações de conversão vão à parte", () => {
    const r = parseInsightRow({
      campaign_id: "999", campaign_name: "Lisboa - Leads", date_start: "2026-09-20", date_stop: "2026-09-20",
      // clicks = TODOS os toques (gostos, perfil…); conta só inline_link_clicks
      spend: "12.34", impressions: "1000", clicks: "95", inline_link_clicks: "40",
      actions: [{ action_type: "link_click", value: "40" }, { action_type: "omni_purchase", value: "3" }, { action_type: "purchase", value: "3" }, { action_type: "lead", value: "2" }],
      action_values: [{ action_type: "omni_purchase", value: "150.5" }, { action_type: "purchase", value: "150.5" }],
    })!;
    expect(r).toMatchObject({ campaignId: "999", date: "2026-09-20", costMicros: 12_340_000, impressions: 1000, clicks: 40, conversions: 3, conversionValueMicros: 150_500_000 });
    expect(r.actions.map((a) => a.actionType).sort()).toEqual(["lead", "omni_purchase", "purchase"]);
    expect(parseInsightRow({ spend: "1" })).toBeNull();
  });
  it("segue a paginação e manda o token no cabeçalho (nunca no URL)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [{ campaign_id: "1", campaign_name: "A", date_start: "2026-09-20", spend: "5" }], paging: { next: "https://graph.facebook.com/v23.0/act_111/insights?after=xyz" } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [{ campaign_id: "2", campaign_name: "B", date_start: "2026-09-21", spend: "7" }], paging: {} }) });
    const rows = await fetchMetaInsights(cfg, "111", "2026-09-20", "2026-09-21", fetchMock as any);
    expect(rows.map((r) => r.campaignId)).toEqual(["1", "2"]);
    const firstUrl = String(fetchMock.mock.calls[0][0]);
    expect(firstUrl).toContain("/v23.0/act_111/insights?");
    expect(firstUrl).toContain("level=campaign");
    expect(firstUrl).toContain("time_increment=1");
    expect(decodeURIComponent(firstUrl)).toContain('"since":"2026-09-20"');
    expect(firstUrl).not.toContain("tok");
    expect(fetchMock.mock.calls[0][1]).toEqual({ headers: { Authorization: "Bearer tok" } });
  });
  it("token inválido (190) → erro de autenticação; não segue páginas de outros hosts", async () => {
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: "Error validating access token", type: "OAuthException", code: 190 } }) });
    const err = await fetchMetaInsights(cfg, "111", "2026-09-20", "2026-09-20", bad as any).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.isAuth).toBe(true);
    const evil = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [], paging: { next: "https://evil.example/steal" } }) });
    await fetchMetaInsights(cfg, "111", "2026-09-20", "2026-09-20", evil as any);
    expect(evil).toHaveBeenCalledTimes(1);
  });
});

describe("reservas → campanhas", () => {
  const campaigns = [
    { key: "api:1:555", provider: "google_ads", externalId: "555", campaignId: 10 },
    { key: "api:2:555", provider: "meta", externalId: "555", campaignId: 20 },
    { key: "api:1:777", provider: "google_ads", externalId: "777", campaignId: 30 },
  ];
  const links = [
    { id: 1, adCampaignId: 30, keyType: "utm_campaign" as const, keyValue: "Verao_Lisboa" },
    { id: 2, adCampaignId: 20, keyType: "discount_code" as const, keyValue: "META10" },
  ];
  const b = (o: any) => ({ id: 1, adAttribution: null, ext: null, utmCampaign: null, code: null, codeName: null, totalPrice: 100, ...o });
  it("ID no link (do fornecedor certo) > utm_campaign ligado > código de desconto; cada reserva uma vez", () => {
    const m = matchBookingsToCampaigns([
      b({ id: 1, adAttribution: "google_paid", ext: "555" }),
      b({ id: 2, adAttribution: "meta_paid", ext: "555" }),
      b({ id: 3, utmCampaign: "verao_lisboa " }),
      b({ id: 4, code: "meta10" }),
      b({ id: 5, adAttribution: "google_paid", ext: "555", code: "META10" }),
      b({ id: 6, code: "OUTRO" }),
    ], campaigns, links);
    expect(m.get("api:1:555")!.map((x) => x.id)).toEqual([1, 5]);
    expect(m.get("api:2:555")!.map((x) => x.id)).toEqual([2, 4]);
    expect(m.get("api:1:777")!.map((x) => x.id)).toEqual([3]);
  });
});

describe("Reservas & Operações: por atribuir entra no total", () => {
  it("Σ cidades + sem cidade = total do dia", () => {
    const d = joinOpsDaily({
      startDate: "2026-09-01", endDate: "2026-09-01", bookings: [],
      ads: [{ day: "2026-09-01", city: "lisboa", cost: 60 }, { day: "2026-09-01", city: "porto", cost: 30 }],
      adsUnassigned: [{ day: "2026-09-01", cost: 10 }],
    })[0];
    expect(d.ads).toBe(100);
    expect(d.adsByCity.lisboa + d.adsByCity.porto + d.adsByCity.faro + d.adsUnassigned).toBe(100);
  });
});

describe("Meta dormente", () => {
  it("sem META_ACCESS_TOKEN/META_AD_ACCOUNT_IDS a recolha não faz nada e o cron fica verde", async () => {
    vi.stubEnv("META_ACCESS_TOKEN", "");
    vi.stubEnv("META_AD_ACCOUNT_IDS", "");
    const { runMetaAdsSync } = await import("./integrations/meta/sync");
    const r = await runMetaAdsSync({ kind: "daily" });
    expect(r).toMatchObject({ ok: true, done: true, status: "skipped", skipped: "not_configured" });
    vi.unstubAllEnvs();
  });
});
