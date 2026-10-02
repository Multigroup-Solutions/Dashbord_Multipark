/**
 * P3 lote 19a — Marketing. Decisão do Jorge (2 out 2026): as faturas do
 * Google/Meta nas Despesas não se contam duas vezes no custo total. E ainda:
 * reservas da Multipark em baixo ≠ 0 reservas (o gasto mostra-se na mesma),
 * erros do servidor ≠ "pedido inválido", nada se apaga (orçamentos e ligações
 * arquivam com registo), comissões como na Faturação, email semanal com
 * interruptor e erro ≠ vazio no ecrã.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { isAdPlatformInvoice } from "../shared/marketingRules";
import { computeMarketingAlerts } from "../shared/marketingAlerts";
import { MARKETING_MAX_DAYS, marketingError, marketingPeriodGuard } from "./marketingErrors";
import { renderWeeklyEmail, type WeeklyReport } from "./marketingWeekly";
import { MIGRATION_0395_STATEMENTS } from "./migrations/migration_0395";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { automationFlagDefault } from "../shared/appSettings";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const fnBody = (file: string, start: string, len = 900) => { const s = src(file); const i = s.indexOf(start); expect(i).toBeGreaterThan(-1); return s.slice(i, i + len); };

describe("Custo total: faturas Google/Meta não contam duas vezes", () => {
  it("reconhece as faturas pelo NIF ou pelo fornecedor", () => {
    expect(isAdPlatformInvoice("Google Ireland Limited", null)).toBe(true);
    expect(isAdPlatformInvoice("Meta Platforms Ireland Ltd.", null)).toBe(true);
    expect(isAdPlatformInvoice("Facebook", null)).toBe(true);
    expect(isAdPlatformInvoice("Qualquer", "IE 6388047V")).toBe(true);
    expect(isAdPlatformInvoice(null, "9692928F")).toBe(true);
    expect(isAdPlatformInvoice("Gráfica do Porto", "PT500000000")).toBe(false);
    expect(isAdPlatformInvoice("Agência Googleplex Lda", null)).toBe(false); // palavra inteira, não pedaço
  });
  it("outras despesas = sem as faturas; as faturas aparecem à parte", () => {
    const s = src("server/integrations/googleAds/marketingStats.ts");
    expect(s).toContain("if (isAdPlatformInvoice(r.supplier, r.supplierNif)) adInvoices += t; else other += t;");
    expect(s).toContain("const mktExpenses = expensesSplit.other;");
    expect(s).toContain("adInvoicesInExpenses: expensesSplit.adInvoices,");
  });
});

describe("Multipark em baixo: gasto sim, reservas indisponíveis (nunca 0)", () => {
  it("stats e por marca apanham a falha e marcam bookingsError", () => {
    const s = src("server/integrations/googleAds/marketingStats.ts");
    expect(s.match(/bookingsError = String\(err\?\.message \?\? err\)/g)?.length).toBe(2);
    expect(s).toContain("bookingsTotal: bk(bookingsTotal)");
    expect(s).toContain("roasAttributedNet: bookingsError ? null");
    expect(s).toContain("attributionQuality: bookingsError ? null : attributionQuality");
  });
  it("alertas: os das recolhas saem na mesma; os que dependem das reservas ficam suspensos", () => {
    const a = computeMarketingAlerts({
      windowCampaigns: [{ name: "Campanha X", accountName: null, cost: 200, conversions: 0, attributedBookings: 0 }],
      attribution: null, windowSpend: 200, windowConversions: 0, monthSpend: 0, prevMonthSpend: 0, dayOfMonth: 2, daysInMonth: 31,
      unmappedCampaigns: 0, coverage: null,
      syncHealth: [{ provider: "google_ads", connection: "reauth_required", lastRunStatus: null, lastRunError: null, stale: false, lastSuccessAt: null }],
    });
    const codes = a.map((x) => x.code);
    expect(codes).toContain("bookings_unavailable");
    expect(codes).toContain("ads_sync_google_ads");
    expect(codes).not.toContain("campaign_no_results");
    expect(codes).not.toContain("attribution_broken");
  });
  it("Web & SEO e Google Business: erro das reservas ≠ 0 reservas", () => {
    expect(src("server/webAnalytics/service.ts")).toContain("bookingsError },");
    expect(src("server/webAnalytics/queries.ts")).toContain("return { byDay: new Map(), available: false, error: String(err?.message ?? err).slice(0, 200) };");
    expect(src("server/integrations/googleBusiness/profileRouter.ts")).toContain("unmapped: locs.filter((l) => !l.city).length, bookingsError };");
  });
  it("tetos de leitura: chegar ao limite é erro, não números cortados", () => {
    const l = src("server/marketingLive.ts");
    expect(l).toContain("if (rows.length >= MARKETING_BOOKINGS_LIMIT) throw new Error(");
    expect(l).toContain("if (rows.length >= MARKETING_CLIENTS_LIMIT) throw new Error(");
  });
});

describe("Erros e período", () => {
  it("período: datas, ordem e máximo de 400 dias", () => {
    expect(() => marketingPeriodGuard("2026-01-01", "2026-12-31")).not.toThrow();
    expect(() => marketingPeriodGuard("2026-02-01", "2026-01-01")).toThrow(/antes do início/);
    expect(() => marketingPeriodGuard("2024-01-01", "2026-01-01")).toThrow(new RegExp(`máximo ${MARKETING_MAX_DAYS}`));
    expect(() => marketingPeriodGuard("2026-1-1", "2026-01-31")).toThrow(/Datas inválidas/);
  });
  it("entrada inválida = BAD_REQUEST; erro do servidor = INTERNAL_SERVER_ERROR", () => {
    expect(marketingError(new Error("Datas inválidas (AAAA-MM-DD)")).code).toBe("BAD_REQUEST");
    expect(marketingError(new Error("connect ETIMEDOUT")).code).toBe("INTERNAL_SERVER_ERROR");
    const t = new TRPCError({ code: "FORBIDDEN" });
    expect(marketingError(t)).toBe(t);
  });
  it("o router do marketing usa-os (já não transforma tudo em BAD_REQUEST)", () => {
    const r = fnBody("server/routers.ts", "  marketing: router({", 16000);
    expect(r.match(/throw marketingError\(e\);/g)?.length).toBe(4);
    expect(r).not.toContain('throw new TRPCError({ code: "BAD_REQUEST", message: String(e?.message ?? e) });');
  });
  it("API MCP: erro do servidor = 500", () => {
    expect(src("server/mcpMarketingApi.ts")).toContain("res.status(/^(Datas inválidas|Mês inválido)/.test(msg) ? 400 : 500)");
  });
});

describe("Nada se apaga", () => {
  it("migração 0395 depois da 0390, só acrescenta colunas", () => {
    expect(SCHEMA_MIGRATION_IDS.indexOf("0395")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0390"));
    expect(MIGRATION_0395_STATEMENTS.every((s) => s.startsWith("ALTER TABLE") && s.includes("ADD COLUMN"))).toBe(true);
  });
  it("orçamentos e ligações arquivam (sem DELETE) e ficam no registo", () => {
    expect(src("server/marketingBudgets.ts")).not.toMatch(/db\.delete\(marketingBudgets\)/);
    expect(src("server/marketingCampaignRoas.ts")).not.toContain("DELETE FROM ad_campaign_links");
    const r = fnBody("server/routers.ts", "  marketing: router({", 16000);
    expect(r).toContain('action: "archive", entity: "marketing_budgets"');
    expect(r).toContain('action: "archive", entity: "ad_campaign_links"');
    expect(r).toContain("passou da campanha #");
    expect(r).toContain('`${r.previous} € → `');
  });
  it("arquivados não contam (lista, cópia, alertas, ligações)", () => {
    const b = src("server/marketingBudgets.ts");
    expect(b.match(/isNull\(marketingBudgets\.archivedAt\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src("server/marketingCampaignRoas.ts")).toContain("WHERE l.archivedAt IS NULL");
  });
});

describe("Email semanal", () => {
  it("interruptor nas Definições (ligado por omissão, como estava)", () => {
    expect(automationFlagDefault("MARKETING_WEEKLY")).toBe(true);
    expect(src("server/marketingWeekly.ts")).toContain('isFeatureEnabled("MARKETING_WEEKLY"');
  });
  it("reservas indisponíveis: o email diz e mostra —", () => {
    const line = { label: "Total", spend: 1000, bookings: 0, revenue: 0, prevSpend: 900, prevBookings: 0, prevRevenue: 0 };
    const r: WeeklyReport = { range: { from: "2026-09-21", to: "2026-09-27" }, prevRange: { from: "2026-09-14", to: "2026-09-20" }, vatRate: 0.23, bookingsUnavailable: true, total: line, brands: [line], cities: [], top: [], bottom: [], alerts: [] };
    const m = renderWeeklyEmail(r);
    expect(m.subject).toContain("reservas indisponíveis");
    expect(m.html).toContain("não respondeu");
    expect(m.text).toContain("reservas indisponíveis");
  });
  it("o total conta as reservas sem marca", () => {
    expect(src("server/marketingWeekly.ts")).toContain("total.bookings += Number((cur as any).bookingsWithoutBrand ?? 0);");
  });
});

describe("Orçamento visto por quem só tem parte das cidades", () => {
  it("sem ritmo (não compara a parte com o orçamento inteiro)", () => {
    const b = src("server/marketingBudgets.ts");
    expect(b).toContain("const partialScope = ids.length < allIds.length;");
    expect(b).toContain('ratio: null, status: "early" as const');
  });
});

describe("Configurações de todas as cidades", () => {
  it("Web & SEO e Google Business: gravar e recolher pedem acesso a todas as cidades", () => {
    expect(src("server/webAnalytics/router.ts").match(/requireGlobalCityAccess\(\);/g)?.length).toBe(2);
    expect(src("server/integrations/googleBusiness/profileRouter.ts").match(/requireGlobalCityAccess\(\);/g)?.length).toBe(2);
  });
});

describe("Erro ≠ vazio no ecrã", () => {
  it("todos os painéis do Marketing usam QueryErrorNote", () => {
    for (const f of ["MarketingDashboardPanel", "MarketingBudgetsPanel", "MarketingChannelsPanel", "CampaignRoasPanel", "MarketingWebPanel", "MarketingGbpPanel", "MarketingSummaryCard", "WebSpeedExtras"]) {
      expect(src(`client/src/components/marketing/${f}.tsx`)).toContain("<QueryErrorNote");
    }
    expect(src("client/src/pages/MarketingPage.tsx")).toContain('what="o estado das recolhas (Google Ads / Meta)"');
  });
  it("o cartão do Financeiro só se esconde sem acesso", () => {
    expect(src("client/src/components/marketing/MarketingSummaryCard.tsx")).toContain('if (error && (error as any)?.data?.code === "FORBIDDEN") return null;');
  });
});
