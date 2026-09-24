/**
 * Meta Marketing API — Insights por campanha e por dia (só LEITURA).
 *
 *   GET {host}/{versão}/act_{id}/insights
 *       ?level=campaign&time_increment=1&time_range={"since","until"}
 *       &fields=campaign_id,campaign_name,spend,impressions,clicks,actions,action_values
 *
 * Paginação por `paging.next`. O token vai no cabeçalho Authorization (nunca
 * no registo de erros). O `fetch` é injetável — os testes não vão à rede.
 *
 * Conversões: a Meta devolve várias ações; para não contar a mesma compra
 * duas vezes usa-se a PRIMEIRA que existir por esta ordem: omni_purchase,
 * purchase, offsite_conversion.fb_pixel_purchase (e o valor da mesma ação).
 * As ações de conversão (compras, leads, registos, contactos…) guardam-se à
 * parte em ad_conversion_action_metrics, como no Google.
 */
import { META_GRAPH_HOST, type MetaConfig } from "./config";

export const META_INSIGHT_FIELDS = ["campaign_id", "campaign_name", "spend", "impressions", "clicks", "actions", "action_values"] as const;
export const META_PURCHASE_ACTION_PRIORITY = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"] as const;
/** Ações que são conversões (as outras — cliques, gostos, vídeo — não se guardam). */
const CONVERSION_ACTION_RE = /purchase|lead|complete_registration|contact|submit_application|schedule|initiate_checkout/;

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text?(): Promise<string> }>;

export class MetaApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: number | null, readonly subcode: number | null) { super(message); this.name = "MetaApiError"; }
  /** Token inválido/expirado (OAuthException 190) ou sem permissão (10/200) → é preciso novo token. */
  get isAuth(): boolean { return this.code === 190 || this.code === 102 || this.code === 10 || (this.code != null && this.code >= 200 && this.code < 300); }
}

export interface MetaActionRow { actionType: string; conversions: number; valueMicros: number }
export interface MetaInsightRow {
  campaignId: string; campaignName: string; date: string;
  costMicros: number; impressions: number; clicks: number;
  conversions: number; conversionValueMicros: number;
  actions: MetaActionRow[];
}

const toMicros = (v: unknown) => Math.round(Number(v ?? 0) * 1_000_000) || 0;
const num = (v: unknown) => Number(v ?? 0) || 0;

/** Normaliza uma linha de insights da Graph API. */
export function parseInsightRow(r: any): MetaInsightRow | null {
  if (!r?.campaign_id || !r?.date_start || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.date_start))) return null;
  const actions = new Map<string, number>();
  for (const a of Array.isArray(r.actions) ? r.actions : []) if (a?.action_type) actions.set(String(a.action_type), num(a.value));
  const values = new Map<string, number>();
  for (const a of Array.isArray(r.action_values) ? r.action_values : []) if (a?.action_type) values.set(String(a.action_type), num(a.value));
  const purchase = META_PURCHASE_ACTION_PRIORITY.find((t) => actions.has(t) || values.has(t));
  const conv: MetaActionRow[] = [];
  for (const t of new Set([...actions.keys(), ...values.keys()])) {
    if (!CONVERSION_ACTION_RE.test(t)) continue;
    conv.push({ actionType: t, conversions: actions.get(t) ?? 0, valueMicros: toMicros(values.get(t) ?? 0) });
  }
  return {
    campaignId: String(r.campaign_id), campaignName: String(r.campaign_name ?? r.campaign_id), date: String(r.date_start),
    costMicros: toMicros(r.spend), impressions: num(r.impressions), clicks: num(r.clicks),
    conversions: purchase ? actions.get(purchase) ?? 0 : 0,
    conversionValueMicros: purchase ? toMicros(values.get(purchase) ?? 0) : 0,
    actions: conv,
  };
}

export function insightsUrl(cfg: MetaConfig, accountId: string, from: string, to: string): string {
  const q = new URLSearchParams({
    level: "campaign", time_increment: "1", limit: "500",
    time_range: JSON.stringify({ since: from, until: to }),
    fields: META_INSIGHT_FIELDS.join(","),
  });
  return `${META_GRAPH_HOST}/${cfg.apiVersion}/act_${accountId}/insights?${q.toString()}`;
}

async function getJson(cfg: MetaConfig, url: string, fetchImpl: FetchLike): Promise<any> {
  if (!cfg.accessToken) throw new MetaApiError("META_ACCESS_TOKEN em falta", 0, null, null);
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${cfg.accessToken}` } });
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || body?.error) {
    const e = body?.error ?? {};
    const msg = String(e.message ?? `HTTP ${res.status}`).replace(/access_token=[^&\s]+/g, "access_token=***").slice(0, 300);
    throw new MetaApiError(`Meta API: ${msg}`, res.status, e.code != null ? Number(e.code) : null, e.error_subcode != null ? Number(e.error_subcode) : null);
  }
  return body;
}

/** Todas as linhas (campanha × dia) do intervalo, seguindo a paginação. */
export async function fetchMetaInsights(cfg: MetaConfig, accountId: string, from: string, to: string, fetchImpl: FetchLike = fetch as any): Promise<MetaInsightRow[]> {
  const out: MetaInsightRow[] = [];
  let url: string | null = insightsUrl(cfg, accountId, from, to);
  for (let page = 0; url && page < 200; page++) {
    const body: any = await getJson(cfg, url, fetchImpl);
    for (const r of Array.isArray(body?.data) ? body.data : []) { const p = parseInsightRow(r); if (p) out.push(p); }
    const next: string | null = typeof body?.paging?.next === "string" ? body.paging.next : null;
    // só segue páginas do próprio Graph (nunca um host arbitrário)
    url = next && next.startsWith(META_GRAPH_HOST) ? next : null;
  }
  return out;
}

/** Estado/nome das campanhas da conta (best effort; inclui arquivadas/eliminadas). */
export async function fetchMetaCampaigns(cfg: MetaConfig, accountId: string, fetchImpl: FetchLike = fetch as any): Promise<Map<string, { name: string; status: string | null; dailyBudgetMicros: number | null }>> {
  const out = new Map<string, { name: string; status: string | null; dailyBudgetMicros: number | null }>();
  const q = new URLSearchParams({ fields: "id,name,effective_status,daily_budget", limit: "500", effective_status: JSON.stringify(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED", "CAMPAIGN_PAUSED", "IN_PROCESS", "WITH_ISSUES"]) });
  let url: string | null = `${META_GRAPH_HOST}/${cfg.apiVersion}/act_${accountId}/campaigns?${q.toString()}`;
  for (let page = 0; url && page < 50; page++) {
    const body: any = await getJson(cfg, url, fetchImpl);
    for (const c of Array.isArray(body?.data) ? body.data : []) {
      if (!c?.id) continue;
      // daily_budget vem em cêntimos da moeda da conta
      out.set(String(c.id), { name: String(c.name ?? c.id), status: c.effective_status ? String(c.effective_status) : null, dailyBudgetMicros: c.daily_budget != null ? Number(c.daily_budget) * 10_000 : null });
    }
    const next: string | null = typeof body?.paging?.next === "string" ? body.paging.next : null;
    url = next && next.startsWith(META_GRAPH_HOST) ? next : null;
  }
  return out;
}

/** Nome, moeda e fuso da conta. */
export async function fetchMetaAccount(cfg: MetaConfig, accountId: string, fetchImpl: FetchLike = fetch as any): Promise<{ name: string | null; currency: string | null; timezone: string | null; status: string | null }> {
  const body: any = await getJson(cfg, `${META_GRAPH_HOST}/${cfg.apiVersion}/act_${accountId}?fields=name,currency,timezone_name,account_status`, fetchImpl);
  return { name: body?.name ?? null, currency: body?.currency ?? null, timezone: body?.timezone_name ?? null, status: body?.account_status != null ? String(body.account_status) : null };
}
