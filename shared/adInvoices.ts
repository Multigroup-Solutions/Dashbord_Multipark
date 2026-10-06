/**
 * P3 lote 29f — Marketing nas contas (Jorge, 6 out 2026): "nas despesas de
 * marketing o que deve lá ficar é o gasto dos anúncios, por projeto; quando
 * entra a fatura — que representa sempre 60 ou 90 dias para trás, mas tem a
 * data de consumo — trocamos os valores do Google Ads pelo valor da fatura.
 * Até entrar a fatura daquele período, fica lá o valor do marketing."
 *
 *  - Gasto dos anúncios (API Google/Meta) por dia × projeto: é custo.
 *  - Fatura do Google/Meta COM período de consumo (de/até): nos dias desse
 *    período, o gasto dessa plataforma é substituído pela fatura, repartida
 *    pelos dias e projetos na proporção do gasto (o total do período = a
 *    fatura). Sem gasto no período → a fatura reparte-se pelos dias no
 *    projeto da própria despesa.
 *  - Fatura SEM período: não conta (o gasto já conta) — aviso para o indicar.
 */
import { AD_PLATFORM_NIFS, isAdPlatformInvoice } from "./marketingRules";

export type AdProvider = "google_ads" | "meta";

/** Plataforma da fatura (Google ou Meta) pelo NIF ou pelo fornecedor; null = não é fatura de anúncios. PURA. */
export function adPlatformOf(supplier: string | null | undefined, supplierNif: string | null | undefined): AdProvider | null {
  if (!isAdPlatformInvoice(supplier, supplierNif)) return null;
  const nif = String(supplierNif ?? "").replace(/[\s.-]/g, "").toUpperCase();
  const [googleNif, metaNif] = AD_PLATFORM_NIFS;
  if (nif === googleNif || nif === googleNif.slice(2)) return "google_ads";
  if (nif === metaNif || nif === metaNif.slice(2)) return "meta";
  return /\bgoogle\b/i.test(String(supplier ?? "")) ? "google_ads" : "meta";
}

/** Período de consumo válido (AAAA-MM-DD, de ≤ até, no máximo 1 ano). PURA. */
export function validConsumptionPeriod(from: string | null | undefined, to: string | null | undefined): boolean {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !re.test(from) || !re.test(to) || from > to) return false;
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 <= 366;
}

export interface AdSpendDay { date: string; projectId: number | null; provider: string; cost: number }
export interface AdInvoice { id: number; provider: AdProvider; periodFrom: string; periodTo: string; amount: number; projectId: number | null }
export interface AdCostRow { date: string; projectId: number | null; provider: AdProvider; cost: number; source: "plataforma" | "fatura"; invoiceId: number | null }

const days = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

/**
 * Custos de marketing do período [from, to] por dia × projeto. `spend` é o
 * gasto no âmbito (já filtrado); `periodSpend` = gasto TOTAL da plataforma no
 * período de cada fatura (todos os projetos) — a base da proporção.
 * `inScope` diz se o projeto da fatura conta (filtro de centro). PURA.
 */
export function allocateAdCosts(i: {
  from: string; to: string;
  spend: readonly AdSpendDay[];
  invoices: readonly AdInvoice[];
  periodSpend: ReadonlyMap<number, number>;
  inScope?: (projectId: number | null) => boolean;
}): AdCostRow[] {
  const inScope = i.inScope ?? (() => true);
  const coverOf = (date: string, provider: string) => i.invoices.find((v) => v.provider === provider && date >= v.periodFrom && date <= v.periodTo) ?? null;
  const out: AdCostRow[] = [];
  for (const s of i.spend) {
    if (s.provider !== "google_ads" && s.provider !== "meta") continue; // legado "other" fica de fora (sem fatura possível)
    if (s.date < i.from || s.date > i.to || !s.cost) continue;
    const inv = coverOf(s.date, s.provider);
    const base = inv ? i.periodSpend.get(inv.id) ?? 0 : 0;
    if (inv && base > 0) out.push({ date: s.date, projectId: s.projectId, provider: s.provider, cost: s.cost * (inv.amount / base), source: "fatura", invoiceId: inv.id });
    else if (!inv) out.push({ date: s.date, projectId: s.projectId, provider: s.provider, cost: s.cost, source: "plataforma", invoiceId: null });
  }
  // Faturas sem gasto no período: repartem-se pelos dias no projeto da despesa
  for (const v of i.invoices) {
    if ((i.periodSpend.get(v.id) ?? 0) > 0 || !inScope(v.projectId)) continue;
    const all = days(v.periodFrom, v.periodTo);
    const per = v.amount / all.length;
    for (const d of all) if (d >= i.from && d <= i.to) out.push({ date: d, projectId: v.projectId, provider: v.provider, cost: per, source: "fatura", invoiceId: v.id });
  }
  return out;
}

export const AD_PROVIDER_LABEL: Record<AdProvider, string> = { google_ads: "Google Ads", meta: "Meta" };
/** Nome da "categoria" destas linhas nos custos da Faturação. PURA. */
export const adCostCategory = (r: Pick<AdCostRow, "provider" | "source">): string =>
  `Anúncios ${AD_PROVIDER_LABEL[r.provider]} — ${r.source === "fatura" ? "fatura" : "gasto da plataforma (à espera da fatura)"}`;
