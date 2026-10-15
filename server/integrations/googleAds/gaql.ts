/**
 * Consultas GAQL (Google Ads Query Language) — puras, para o cliente REST.
 * Datas em YYYY-MM-DD. Só LEITURA: nada aqui altera campanhas ou orçamentos.
 */
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function assertDay(d: string) { if (!ISO.test(d)) throw new Error(`dia inválido: ${d}`); return d; }

/** Contas acessíveis a partir da conta gestora (nível ≤ 1: a própria + filhas diretas). */
export const GAQL_CUSTOMER_CLIENTS =
  "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, " +
  "customer_client.time_zone, customer_client.manager, customer_client.status, customer_client.level " +
  "FROM customer_client WHERE customer_client.level <= 1";

/** Dados da própria conta (moeda/fuso). */
export const GAQL_CUSTOMER =
  "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer";

/**
 * Métricas diárias por campanha — TODAS, incluindo as REMOVIDAS (24 set 2026):
 * a recolha substitui o intervalo inteiro (apaga + reinsere), por isso filtrar
 * as removidas apagava o gasto histórico delas. O estado vem na linha e a UI
 * mostra "removida".
 */
export function gaqlCampaignDaily(from: string, to: string): string {
  assertDay(from); assertDay(to);
  return (
    "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, " +
    "campaign_budget.amount_micros, segments.date, " +
    "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, " +
    "metrics.conversions_value, metrics.all_conversions " +
    `FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}'`
  );
}

/** Conversões por ação de conversão (guardadas à parte para não multiplicar o gasto). */
export function gaqlConversionActions(from: string, to: string): string {
  assertDay(from); assertDay(to);
  return (
    "SELECT campaign.id, segments.date, segments.conversion_action, segments.conversion_action_name, " +
    "segments.conversion_action_category, metrics.conversions, metrics.conversions_value " +
    `FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}' AND metrics.conversions > 0`
  );
}

/**
 * Cliques de UM dia (click_view): gclid → campanha e grupo de anúncios. A
 * Google só aceita um dia por consulta e só os últimos 90 dias. É o que liga
 * uma reserva com só o gclid no link (auto-tagging) à campanha.
 */
export function gaqlClickView(day: string): string {
  assertDay(day);
  return (
    "SELECT click_view.gclid, campaign.id, ad_group.id, segments.date " +
    `FROM click_view WHERE segments.date = '${day}'`
  );
}

export interface ClickViewRow { gclid: string; campaignId: string; adGroupId: string | null; date: string }
/** Linha do click_view (camelCase do REST) → clique; sem gclid/campanha/dia ou gclid > 128 → null. PURA. */
export function parseClickViewRow(r: any): ClickViewRow | null {
  const raw = r?.clickView?.gclid;
  const gclid = typeof raw === "string" ? raw.trim() : "";
  const campaignId = r?.campaign?.id != null ? String(r.campaign.id).trim() : "";
  const date = r?.segments?.date != null ? String(r.segments.date) : "";
  if (!gclid || gclid.length > 128 || !/^\d+$/.test(campaignId) || !ISO.test(date)) return null;
  const ag = r?.adGroup?.id != null ? String(r.adGroup.id).trim() : "";
  return { gclid, campaignId, adGroupId: /^\d+$/.test(ag) ? ag : null, date };
}

/** Linha de resultado normalizada a partir do JSON da API (searchStream). */
export interface CampaignDailyRow {
  campaignId: string; campaignName: string; campaignStatus: string; channelType: string | null;
  budgetMicros: number | null; date: string;
  costMicros: number; impressions: number; clicks: number; conversions: number; conversionValueMicros: number; allConversions: number;
}
export function parseCampaignDailyRow(r: any): CampaignDailyRow | null {
  const c = r?.campaign, m = r?.metrics, s = r?.segments;
  if (!c?.id || !s?.date) return null;
  return {
    campaignId: String(c.id), campaignName: String(c.name ?? ""), campaignStatus: String(c.status ?? "UNKNOWN"),
    channelType: c.advertisingChannelType ? String(c.advertisingChannelType) : null,
    budgetMicros: r?.campaignBudget?.amountMicros != null ? Number(r.campaignBudget.amountMicros) : null,
    date: String(s.date),
    costMicros: Number(m?.costMicros ?? 0), impressions: Number(m?.impressions ?? 0), clicks: Number(m?.clicks ?? 0),
    conversions: Number(m?.conversions ?? 0), conversionValueMicros: Math.round(Number(m?.conversionsValue ?? 0) * 1_000_000),
    allConversions: Number(m?.allConversions ?? 0),
  };
}

export interface ConversionActionRow {
  campaignId: string; date: string; actionResource: string; actionName: string; category: string | null;
  conversions: number; valueMicros: number;
}
export function parseConversionActionRow(r: any): ConversionActionRow | null {
  const c = r?.campaign, m = r?.metrics, s = r?.segments;
  if (!c?.id || !s?.date || !s?.conversionAction) return null;
  return {
    campaignId: String(c.id), date: String(s.date), actionResource: String(s.conversionAction),
    actionName: String(s.conversionActionName ?? ""), category: s.conversionActionCategory ? String(s.conversionActionCategory) : null,
    conversions: Number(m?.conversions ?? 0), valueMicros: Math.round(Number(m?.conversionsValue ?? 0) * 1_000_000),
  };
}

export interface CustomerClientRow {
  customerId: string; name: string; currency: string | null; timezone: string | null; manager: boolean; status: string; level: number;
}
export function parseCustomerClientRow(r: any): CustomerClientRow | null {
  const cc = r?.customerClient;
  if (!cc?.id) return null;
  return {
    customerId: String(cc.id), name: String(cc.descriptiveName ?? cc.id), currency: cc.currencyCode ?? null,
    timezone: cc.timeZone ?? null, manager: Boolean(cc.manager), status: String(cc.status ?? "UNKNOWN"), level: Number(cc.level ?? 0),
  };
}
