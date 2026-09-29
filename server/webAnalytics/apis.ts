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

// ─── Chrome UX Report (dados reais) ─────────────────────────────────────────

export interface CruxApiLike {
  /** Histórico (até 25 períodos semanais); null = a CrUX não tem dados suficientes (404). */
  history(target: { type: "origin" | "url"; target: string }, formFactor: "PHONE" | "DESKTOP", timeoutMs: number): Promise<any | null>;
}

/** Chave da CrUX: a mesma da PageSpeed ou uma própria. */
export function cruxApiKey(env: Record<string, string | undefined> = process.env): string {
  return String(env.GOOGLE_PAGESPEED_API_KEY ?? "").trim() || String(env.GOOGLE_CRUX_API_KEY ?? "").trim();
}

/** Erro da CrUX → mensagem PT-PT (sem a chave nem o URL do pedido). PURA. */
export function cruxErrorMessage(status: number, body: any): string {
  const details: any[] = Array.isArray(body?.error?.details) ? body.error.details : [];
  const reason = String(details.find((d) => d?.reason)?.reason ?? body?.error?.status ?? "");
  if (status === 403 && /SERVICE_DISABLED|ACCESS_NOT_CONFIGURED/.test(reason)) return "A Chrome UX Report API não está ativa no projeto da chave (Google Cloud → APIs e serviços → Biblioteca → Chrome UX Report API).";
  if (status === 400 && /API_KEY_INVALID/.test(reason)) return "Chave de API inválida (GOOGLE_PAGESPEED_API_KEY / GOOGLE_CRUX_API_KEY).";
  if (status === 403 && /API_KEY_SERVICE_BLOCKED/.test(reason)) return "A chave está restrita a outras APIs — junta a Chrome UX Report API às restrições da chave.";
  if (status === 429) return "Chrome UX Report: limite de pedidos atingido (volta a tentar amanhã).";
  return `Chrome UX Report: HTTP ${status}${reason ? ` (${reason.slice(0, 60)})` : ""}.`;
}

/**
 * Chrome UX Report API (records:queryHistoryRecord) por `fetch` com prazo —
 * pedido JSON simples, sem cliente extra no bundle. A chave vai na query
 * string e NUNCA aparece nas mensagens de erro (só o código/estado).
 */
export function cruxApi(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): CruxApiLike | null {
  const key = cruxApiKey(env);
  if (!key) return null;
  return {
    async history(t, formFactor, timeoutMs) {
      const { fetchWithTimeout } = await import("../_core/fetchWithTimeout");
      const res = await fetchWithTimeout(`https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Sem lista de métricas: a API devolve todas as que tem (um nome de métrica
        // desconhecido — ex.: TTFB ainda "experimental_" — daria 400).
        body: JSON.stringify({ [t.type]: t.target, formFactor }),
        timeoutMs: Math.max(3_000, Math.min(timeoutMs, 15_000)),
      }, fetchImpl as any);
      if (res.status === 404) return null;
      const body: any = await res.json().catch(() => null);
      if (!res.ok) {
        const err: any = new Error(cruxErrorMessage(res.status, body));
        err.response = { status: res.status };
        throw err;
      }
      return body;
    },
  };
}
