/**
 * Regras PURAS das métricas Google Ads: unidades, agregação, janelas de
 * recolha e cobertura. Sem BD, sem rede — tudo testável.
 */

/** A API devolve dinheiro em micros (1 € = 1 000 000). Guardamos micros; convertemos só para mostrar. */
export const microsToAmount = (micros: number | string | bigint | null | undefined): number =>
  Number(micros ?? 0) / 1_000_000;
export const amountToMicros = (amount: number): number => Math.round(amount * 1_000_000);

export interface MetricTotals {
  costMicros: number;
  impressions: number;
  clicks: number;
  conversions: number;        // decimal (a Google atribui frações)
  conversionValueMicros: number;
}
export const emptyTotals = (): MetricTotals => ({ costMicros: 0, impressions: 0, clicks: 0, conversions: 0, conversionValueMicros: 0 });

export function addTotals(a: MetricTotals, b: Partial<MetricTotals>): MetricTotals {
  return {
    costMicros: a.costMicros + Number(b.costMicros ?? 0),
    impressions: a.impressions + Number(b.impressions ?? 0),
    clicks: a.clicks + Number(b.clicks ?? 0),
    conversions: a.conversions + Number(b.conversions ?? 0),
    conversionValueMicros: a.conversionValueMicros + Number(b.conversionValueMicros ?? 0),
  };
}

/** CPC/CTR/ROAS a partir dos TOTAIS (nunca média de percentagens diárias). Sem denominador → null. */
export function derivedRatios(t: MetricTotals) {
  const cost = microsToAmount(t.costMicros);
  const value = microsToAmount(t.conversionValueMicros);
  return {
    cost,
    conversionValue: value,
    cpc: t.clicks > 0 ? cost / t.clicks : null,
    ctr: t.impressions > 0 ? t.clicks / t.impressions : null,
    costPerConversion: t.conversions > 0 ? cost / t.conversions : null,
    roasGoogle: cost > 0 ? value / cost : null,
  };
}

// ─── Datas (dias de calendário; a conta Google tem o seu fuso — usamos o dia que a API devolve) ─
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function addDays(day: string, n: number): string {
  if (!ISO.test(day)) throw new Error(`dia inválido: ${day}`);
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function addMonths(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
export function daysInclusive(from: string, to: string): number {
  return Math.floor((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86400000) + 1;
}

export type SyncKind = "initial" | "hourly" | "nightly" | "monthly" | "manual";

/**
 * Janela de cada tipo de recolha (plano, fase C):
 *  - hourly: últimos 7 dias incluindo hoje (provisório);
 *  - nightly: últimos 90 dias (conversões tardias e correções);
 *  - monthly: o resto do histórico acessível (37 meses) até ao dia 91;
 *  - initial/manual: tudo (37 meses).
 */
export function syncWindow(kind: SyncKind, today: string, retentionMonths = 37): { from: string; to: string } {
  switch (kind) {
    case "hourly": return { from: addDays(today, -6), to: today };
    case "nightly": return { from: addDays(today, -89), to: today };
    case "monthly": return { from: addMonths(today, -retentionMonths), to: addDays(today, -90) };
    default: return { from: addMonths(today, -retentionMonths), to: today };
  }
}

/** Parte um intervalo em pedaços de no máximo `maxDays` dias (limites de resposta/tempo). */
export function chunkRange(from: string, to: string, maxDays = 31): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  let cur = from;
  while (cur <= to) {
    const end = addDays(cur, maxDays - 1);
    out.push({ from: cur, to: end < to ? end : to });
    cur = addDays(end, 1);
  }
  return out;
}

/** Dias que a Google ainda pode rever: hoje e os 2 dias anteriores ficam "provisórios". */
export function isProvisional(day: string, today: string): boolean {
  return day >= addDays(today, -2);
}

export interface Coverage {
  from: string; to: string;
  daysInRange: number;
  apiDays: number;            // dias com pelo menos uma linha da API
  legacyDays: number;         // dias cobertos só por importações antigas
  missingDays: number;
  lastCompleteDay: string | null;   // último dia não provisório com dados da API
  lastSuccessfulSyncAt: string | null;
  status: "ok" | "partial" | "stale" | "none";
}

/** Cobertura de um intervalo dado o conjunto de dias com dados (API e legado). */
export function coverageFor(
  from: string, to: string, apiDays: Set<string>, legacyDays: Set<string>,
  lastSuccessfulSyncAt: string | null, today: string,
): Coverage {
  const total = daysInclusive(from, to);
  let api = 0, legacy = 0, missing = 0, lastComplete: string | null = null;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (apiDays.has(d)) { api++; if (!isProvisional(d, today) && (!lastComplete || d > lastComplete)) lastComplete = d; }
    else if (legacyDays.has(d)) legacy++;
    else if (d <= today) missing++;
  }
  const stale = lastSuccessfulSyncAt ? (Date.now() - new Date(lastSuccessfulSyncAt).getTime()) > 2 * 3600_000 : true;
  const status: Coverage["status"] = api + legacy === 0 ? "none" : missing > 0 ? "partial" : stale && api > 0 ? "stale" : "ok";
  return { from, to, daysInRange: total, apiDays: api, legacyDays: legacy, missingDays: missing, lastCompleteDay: lastComplete, lastSuccessfulSyncAt, status };
}

/** ID de cliente Google sem hífens ("123-456-7890" → "1234567890"). */
export function normalizeCustomerId(id: string): string {
  return String(id).replace(/[^\d]/g, "");
}
