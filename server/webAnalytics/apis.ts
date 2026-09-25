/**
 * Adaptadores das APIs OFICIAIS (CommonJS, versões fixas):
 *   - @googleapis/analyticsdata (GA4 Data API v1beta, runReport);
 *   - @googleapis/searchconsole (v1, searchanalytics.query / sites.get);
 *   - @googleapis/pagespeedonline (v5, runpagespeed).
 * Sempre com prazo (timedFetch → fetchWithTimeout) e repetição com espera
 * exponencial nos limites de pedidos (withGoogleRetry, só dentro do prazo).
 *
 * O motor (sync.ts) só conhece `GaApiLike` / `ScApiLike` / `PsiApiLike` — os
 * testes usam implementações falsas.
 */
import type { JWT } from "google-auth-library";
import { analyticsdata as analyticsdataFactory, type analyticsdata_v1beta } from "@googleapis/analyticsdata";
import { searchconsole as searchconsoleFactory } from "@googleapis/searchconsole";
import { pagespeedonline as pagespeedFactory } from "@googleapis/pagespeedonline";
import { GOOGLE_API_TIMEOUT_MS, serviceAccountClient, timedFetch } from "../google/workspace";
import { withGoogleRetry, type RetryOptions } from "../google/apis";
import { WEB_ANALYTICS_SCOPES, type PsStrategy } from "../../shared/webAnalytics";

export interface GaApiLike {
  runReport(propertyId: string, body: Record<string, unknown>): Promise<any>;
}
export interface ScApiLike {
  query(siteUrl: string, body: Record<string, unknown>): Promise<any>;
  getSite(siteUrl: string): Promise<{ siteUrl: string; permissionLevel: string | null }>;
}
export interface PsiApiLike {
  run(url: string, strategy: PsStrategy, timeoutMs: number): Promise<any>;
}

/** PageSpeed: uma análise demora 10–30 s; nunca mais do que isto por pedido. */
export const PAGESPEED_TIMEOUT_MS = 35_000;

export function webAuth(subject?: string | null): JWT {
  return serviceAccountClient(WEB_ANALYTICS_SCOPES, subject || null);
}

export function gaApi(auth: JWT, retry: RetryOptions): GaApiLike {
  const api = analyticsdataFactory({ version: "v1beta", auth, timeout: GOOGLE_API_TIMEOUT_MS, fetchImplementation: timedFetch() } as any) as unknown as analyticsdata_v1beta.Analyticsdata;
  return {
    async runReport(propertyId, body) {
      const res = await withGoogleRetry(() => api.properties.runReport({ property: `properties/${propertyId}`, requestBody: body as any }), retry);
      return res.data;
    },
  };
}

export function scApi(auth: JWT, retry: RetryOptions): ScApiLike {
  const api = searchconsoleFactory({ version: "v1", auth, timeout: GOOGLE_API_TIMEOUT_MS, fetchImplementation: timedFetch() } as any);
  return {
    async query(siteUrl, body) {
      const res = await withGoogleRetry(() => api.searchanalytics.query({ siteUrl, requestBody: body as any }), retry);
      return res.data;
    },
    async getSite(siteUrl) {
      const res = await withGoogleRetry(() => api.sites.get({ siteUrl }), retry);
      return { siteUrl: String(res.data.siteUrl ?? siteUrl), permissionLevel: res.data.permissionLevel ?? null };
    },
  };
}

/** PageSpeed Insights (chave opcional GOOGLE_PAGESPEED_API_KEY; sem chave a quota é baixa). */
export function psiApi(env: Record<string, string | undefined> = process.env): PsiApiLike {
  const key = String(env.GOOGLE_PAGESPEED_API_KEY ?? "").trim();
  return {
    async run(url, strategy, timeoutMs) {
      const ms = Math.max(5_000, Math.min(timeoutMs, PAGESPEED_TIMEOUT_MS));
      const api = pagespeedFactory({ version: "v5", timeout: ms, fetchImplementation: timedFetch(ms) } as any);
      const res = await api.pagespeedapi.runpagespeed({ url, strategy: strategy.toUpperCase(), category: ["PERFORMANCE"], ...(key ? { key } : {}) } as any);
      return res.data;
    },
  };
}
