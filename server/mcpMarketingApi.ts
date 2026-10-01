/**
 * MCP Control API — rotas de MARKETING e WEB (SÓ LEITURA), para a skill `multipark-relatorios`.
 *
 * Montadas por `server/mcpApi.ts` em /api/v1 (X-API-Key, scope "read"). Reutilizam as MESMAS
 * funções que alimentam os ecrãs "Marketing" e "Web analytics" do Dashboard, para os números
 * do relatório serem iguais aos do ecrã. Nada aqui escreve na BD nem altera campanhas.
 *
 *   GET /marketing/stats?from&to[&projectId]          gasto (Google Ads/Meta), reservas, CPA, ROAS
 *   GET /marketing/channels?from&to[&projectId]       mix de canais (origem das reservas) + gasto
 *   GET /marketing/brands?from&to[&projectId]         gasto e reservas por marca, com o mesmo gasto do ecrã
 *   GET /marketing/campaign-roas?from&to[&projectId]  ROAS por campanha (utm_campaign / código de desconto)
 *   GET /web/overview?from&to[&brand][&compare]       Google Analytics (GA4) + Search Console: totais e por dia
 *   GET /web/list?source=ga|sc&dim&from&to[...]       tabelas: canais, páginas, países, pesquisas, ...
 */
import type { Router, Request, Response } from "express";
import { requireScope } from "./apiKeyAuth";
import { parseRange } from "./mcpReportsApi";

type Handler = (fn: (req: Request, res: Response) => Promise<any>) => (req: Request, res: Response) => void;

const BRANDS = ["multipark", "multibags", "redpark", "skypark", "airpark", "multidriver"] as const;
const COMPARES = ["previous", "yoy"] as const;
const GA_DIMS = ["channel", "landing", "device", "country", "city", "event"] as const;
const SC_DIMS = ["query", "page", "device", "country"] as const;
const GA_SORTS = ["sessions", "keyEvents", "revenue", "losing", "gaining"] as const;
const SC_SORTS = ["clicks", "impressions", "position", "losing", "gaining", "positionWorse"] as const;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// ─── Puras (testadas em mcpMarketingApi.test.ts) ────────────────────────────

/** from/to obrigatórios (máx. 366 dias) + projectId opcional (inteiro positivo). */
export function parseMarketingQuery(q: Record<string, unknown>): { from: string; to: string; projectId?: number } | { error: string } {
  const rg = parseRange(q.from, q.to);
  if ("error" in rg) return rg;
  const p = str(q.projectId);
  if (p === undefined) return rg;
  if (!/^\d+$/.test(p) || Number(p) <= 0) return { error: "projectId tem de ser um inteiro positivo" };
  return { ...rg, projectId: Number(p) };
}

/** Consulta de web analytics: marca e comparação validadas; a lista valida fonte, dimensão e ordenação. */
export function parseWebQuery(q: Record<string, unknown>, withList: boolean):
  | { from: string; to: string; brand: string | null; compare: (typeof COMPARES)[number]; source?: "ga" | "sc"; dim?: string; sort?: string; pageSize?: number; search?: string }
  | { error: string } {
  const rg = parseRange(q.from, q.to);
  if ("error" in rg) return rg;
  const brand = str(q.brand) ?? null;
  if (brand && !(BRANDS as readonly string[]).includes(brand)) return { error: `brand: ${BRANDS.join(" | ")}` };
  const compare = (str(q.compare) ?? "previous") as (typeof COMPARES)[number];
  if (!COMPARES.includes(compare)) return { error: "compare: previous | yoy" };
  const base = { ...rg, brand, compare };
  if (!withList) return base;
  const source = str(q.source);
  if (source !== "ga" && source !== "sc") return { error: "source: ga | sc" };
  const dims: readonly string[] = source === "ga" ? GA_DIMS : SC_DIMS;
  const dim = str(q.dim);
  if (!dim || !dims.includes(dim)) return { error: `dim (${source}): ${dims.join(" | ")}` };
  const sorts: readonly string[] = source === "ga" ? GA_SORTS : SC_SORTS;
  const sort = str(q.sort) ?? sorts[0];
  if (!sorts.includes(sort)) return { error: `sort (${source}): ${sorts.join(" | ")}` };
  const ps = str(q.pageSize);
  const pageSize = ps === undefined ? 25 : Number(ps);
  if (!Number.isInteger(pageSize) || pageSize < 5 || pageSize > 100) return { error: "pageSize: inteiro entre 5 e 100" };
  return { ...base, source, dim, sort, pageSize, search: str(q.search)?.slice(0, 100) };
}

// ─── Rotas ──────────────────────────────────────────────────────────────────

export function registerMcpMarketingRoutes(r: Router, h: Handler): void {
  const bad = (res: Response, error: string) => res.status(400).json({ success: false, error });
  const failed = (res: Response, e: unknown) => res.status(400).json({ success: false, error: String((e as any)?.message ?? e).slice(0, 300) });

  r.get("/marketing/stats", requireScope("read"), h(async (req, res) => {
    const f = parseMarketingQuery(req.query);
    if ("error" in f) return bad(res, f.error);
    const { getMarketingStats } = await import("./integrations/googleAds/marketingStats");
    try { res.json({ success: true, from: f.from, to: f.to, data: await getMarketingStats(f) }); } catch (e) { failed(res, e); }
  }));

  r.get("/marketing/channels", requireScope("read"), h(async (req, res) => {
    const f = parseMarketingQuery(req.query);
    if ("error" in f) return bad(res, f.error);
    const { marketingProjectIds } = await import("./marketingSql");
    const { getAdMetrics } = await import("./integrations/googleAds/adMetrics");
    const { getChannels } = await import("./marketingChannels");
    const { getDb } = await import("./db");
    try {
      const db = await getDb();
      if (!db) return bad(res, "BD indisponível");
      const projectIds = await marketingProjectIds(f.projectId);
      const ads = await getAdMetrics({ from: f.from, to: f.to, projectIds });
      res.json({ success: true, from: f.from, to: f.to, data: await getChannels(db, { from: f.from, to: f.to, projectIds, adSpend: ads.totals.cost, adConversions: ads.totals.conversions }) });
    } catch (e) { failed(res, e); }
  }));

  r.get("/marketing/brands", requireScope("read"), h(async (req, res) => {
    const f = parseMarketingQuery(req.query);
    if ("error" in f) return bad(res, f.error);
    const { getSpendAndBookingsByBrand } = await import("./integrations/googleAds/marketingStats");
    try { res.json({ success: true, from: f.from, to: f.to, data: await getSpendAndBookingsByBrand(f) }); } catch (e) { failed(res, e); }
  }));

  r.get("/marketing/campaign-roas", requireScope("read"), h(async (req, res) => {
    const f = parseMarketingQuery(req.query);
    if ("error" in f) return bad(res, f.error);
    const { getCampaignRoas } = await import("./marketingCampaignRoas");
    try { res.json({ success: true, from: f.from, to: f.to, data: await getCampaignRoas(f) }); } catch (e) { failed(res, e); }
  }));

  r.get("/web/overview", requireScope("read"), h(async (req, res) => {
    const f = parseWebQuery(req.query, false);
    if ("error" in f) return bad(res, f.error);
    const { webOverview } = await import("./webAnalytics/service");
    try { res.json({ success: true, from: f.from, to: f.to, brand: f.brand, compare: f.compare, data: await webOverview({ from: f.from, to: f.to, brand: f.brand, compare: f.compare }) }); } catch (e) { failed(res, e); }
  }));

  r.get("/web/list", requireScope("read"), h(async (req, res) => {
    const f = parseWebQuery(req.query, true);
    if ("error" in f) return bad(res, f.error);
    const { loadWebAnalyticsConfig } = await import("./webAnalytics/service");
    const { dimCompare } = await import("./webAnalytics/queries");
    const { comparisonRange, scopeByBrand } = await import("../shared/webAnalytics");
    try {
      const cfg = await loadWebAnalyticsConfig();
      const scope = scopeByBrand(cfg, f.brand);
      const prev = comparisonRange(f.from, f.to, f.compare);
      const out = await dimCompare({
        source: f.source!, ids: f.source === "ga" ? scope.properties : scope.sites, dim: f.dim as any,
        cur: { from: f.from, to: f.to }, prev, sort: f.sort as any, limit: f.pageSize!, offset: 0, search: f.search,
      } as any);
      const labels = new Map(cfg.ga4Properties.map((p) => [p.propertyId, p.label || `GA4 ${p.propertyId}`]));
      res.json({
        success: true, from: f.from, to: f.to, brand: f.brand, source: f.source, dim: f.dim, sort: f.sort, prevRange: prev, total: out.total,
        rows: out.rows.map((x: any) => ({ ...x, sourceLabel: x.sourceId ? labels.get(x.sourceId) ?? x.sourceId : null })),
      });
    } catch (e) { failed(res, e); }
  }));
}
