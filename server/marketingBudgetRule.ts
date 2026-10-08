/**
 * P3 lote 29e — orçamentos do Google Ads pela regra (shared/marketingBudgetRule.ts):
 * lê a faturação do mês anterior (reservas concluídas, ao vivo da Multipark,
 * sem IVA, sem as do Marketplace) por marca/cidade e o que ficou ao
 * Marketplace por cidade (a cidade reconhecida do parque; os sem cidade vêm
 * à parte, com aviso). Guarda 10 min em memória por mês. Nunca grava nada.
 */
import { buildRuleBudgets, previousMonth, type RuleBudgetRow } from "../shared/marketingBudgetRule";
import { MARKETPLACE_CAMPAIGN } from "../shared/marketplace";
import { CITY_LABELS, type CityKey } from "../shared/city";

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: RuleBudgetResult }>();

/** O que ficou ao Marketplace em parques sem cidade reconhecida (não dá orçamento a nenhuma cidade — aviso). */
export interface MarketplaceWithoutCity { base: number; parks: string[] }
export type RuleBudgetResult = { ok: true; month: string; baseMonth: string; rows: RuleBudgetRow[]; marketplaceWithoutCity?: MarketplaceWithoutCity } | { ok: false; month: string; baseMonth: string; reason: string };

/**
 * O que ficou ao Marketplace (comissões) → por cidade, pela cidade RECONHECIDA
 * do parque (resolveParkCity: cidade, terra à volta — "Prior Velho", "Maia" —,
 * nome, morada). Antes, a cidade gravada tinha de ser "Lisboa"/"Porto"/"Faro"
 * e o resto ficava fora sem aviso (8 out 2026). PURA.
 */
export function marketplaceBaseByCity(rows: ReadonlyArray<{ parkName: string; cityKey: CityKey | null; commission: number | null }>): { byCity: Map<string, number>; withoutCity: MarketplaceWithoutCity } {
  const byCity = new Map<string, number>();
  const withoutCity: MarketplaceWithoutCity = { base: 0, parks: [] };
  for (const m of rows) {
    if (m.commission == null || !(m.commission > 0)) continue;
    if (!m.cityKey) {
      withoutCity.base = Math.round((withoutCity.base + m.commission) * 100) / 100;
      if (!withoutCity.parks.includes(m.parkName)) withoutCity.parks.push(m.parkName);
      continue;
    }
    const name = CITY_LABELS[m.cityKey];
    byCity.set(name, (byCity.get(name) ?? 0) + m.commission);
  }
  return { byCity, withoutCity };
}

function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(days).padStart(2, "0")}` };
}

export async function computeRuleBudgets(month: string): Promise<RuleBudgetResult> {
  const hit = cache.get(month);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const baseMonth = previousMonth(month);
  let value: RuleBudgetResult;
  try {
    const { from, to } = monthRange(baseMonth);
    const [{ getProjects }, { loadLiveBookingAgg }, { lisbonDayRangeUtc }, { vatRateForPeriod }, { readPartnerBillingLive }] = await Promise.all([
      import("./db"), import("./finance/liveBookings"), import("../shared/lisbonDay"), import("./finance/rates"), import("./multiparkDb/partnerBilling"),
    ]);
    const projects = (await getProjects()) as Array<{ id: number; name: string; level: string | null; parentId: number | null }>;
    const byId = new Map(projects.map((p) => [p.id, p]));
    const brandNodeOf = (projectId: number | null): number | null => {
      let node = projectId == null ? undefined : byId.get(projectId);
      const seen = new Set<number>();
      while (node && node.level !== "brand") { if (seen.has(node.id) || node.parentId == null) return null; seen.add(node.id); node = byId.get(node.parentId); }
      return node ? node.id : null;
    };
    const range = lisbonDayRangeUtc(from, to);
    const vat = await vatRateForPeriod(from, to);
    const rows = await loadLiveBookingAgg("delivered", { start: range.start, end: range.end });
    const revenueByBrandNode = new Map<number, number>();
    for (const r of rows) {
      if (r.campaign === MARKETPLACE_CAMPAIGN) continue; // as do Marketplace contam no Marketplace
      const node = brandNodeOf(r.projectId);
      if (node == null) continue;
      revenueByBrandNode.set(node, (revenueByBrandNode.get(node) ?? 0) + r.total / (1 + vat));
    }
    const billing = await readPartnerBillingLive({ start: range.start, end: range.end });
    if (!billing.available) throw new Error(billing.reason);
    const { byCity: marketplaceByCity, withoutCity } = marketplaceBaseByCity(billing.data.marketplace);
    value = { ok: true, month, baseMonth, rows: buildRuleBudgets({ nodes: projects, revenueByBrandNode, marketplaceByCity }), ...(withoutCity.base > 0 ? { marketplaceWithoutCity: withoutCity } : {}) };
  } catch (e: any) {
    value = { ok: false, month, baseMonth, reason: String(e?.message ?? e).slice(0, 200) };
  }
  cache.set(month, { at: Date.now(), value });
  return value;
}
