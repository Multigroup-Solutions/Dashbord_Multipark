/**
 * P3 lote 29e — Orçamentos do Google Ads pela regra do dono (Jorge, 6 out
 * 2026): "o orçamento para o Google Ads será sempre 20 % da faturação do mês
 * anterior da mesma marca e cidade (ex.: Airpark Lisboa = 20 % da faturação do
 * mês anterior da Airpark Lisboa), sem ser o Marketplace. O Marketplace será
 * só sobre os 20 % que realmente ficam: numa reserva de 100 €, ficam 20 € e
 * investimos 20 % desses 20 € = 4 €."
 *
 * Faturação = reservas concluídas (saída) no mês anterior, SEM IVA (como a
 * Faturação), sem as que vieram pelo Marketplace. Marketplace = o que lhe
 * fica: a comissão dos parques de terceiros + os 20 % dos parques nossos.
 */
import { matchCityKey } from "./city";
export const BUDGET_RULE_PCT = 20;
export const MARKETPLACE_BUDGET_RULE_PCT = 20;
export const BUDGET_RULE_PROVIDER = "google_ads" as const;

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Mês anterior ("2026-10" → "2026-09"). PURA. */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

export interface RuleNode { id: number; name: string; level: string | null; parentId: number | null }
export interface RuleBudgetRow {
  /** nó marca debaixo da cidade (ex.: Airpark Lisboa; Marketplace Porto) */
  projectId: number;
  label: string;
  kind: "brand" | "marketplace";
  /** base do mês anterior (sem IVA) */
  base: number;
  pct: number;
  amount: number;
}

const norm = (s: string | null | undefined) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * Faturação por nó marca (sem Marketplace) + o que fica ao Marketplace por
 * cidade → orçamento de cada marca/cidade. Só marcas com base > 0. PURA.
 */
export function buildRuleBudgets(i: {
  nodes: readonly RuleNode[];
  /** faturação sem IVA do mês anterior por nó marca, sem as reservas do Marketplace */
  revenueByBrandNode: ReadonlyMap<number, number>;
  /** o que ficou ao Marketplace no mês anterior por nome de cidade (sem IVA) */
  marketplaceByCity: ReadonlyMap<string, number>;
  pct?: number;
  marketplacePct?: number;
}): RuleBudgetRow[] {
  const pct = i.pct ?? BUDGET_RULE_PCT;
  const mpPct = i.marketplacePct ?? MARKETPLACE_BUDGET_RULE_PCT;
  const byId = new Map(i.nodes.map((n) => [n.id, n]));
  const label = (n: RuleNode) => { const p = n.parentId != null ? byId.get(n.parentId) : null; return p ? `${n.name} ${p.name}` : n.name; };
  const isMarketplace = (n: RuleNode) => norm(n.name) === "marketplace";
  const out: RuleBudgetRow[] = [];
  for (const [id, base] of i.revenueByBrandNode) {
    const n = byId.get(id);
    if (!n || n.level !== "brand" || isMarketplace(n) || !(base > 0)) continue;
    out.push({ projectId: id, label: label(n), kind: "brand", base: r2(base), pct, amount: r2((base * pct) / 100) });
  }
  // Marketplace: o nó "Marketplace" debaixo de cada cidade
  for (const [cityName, base] of i.marketplaceByCity) {
    if (!(base > 0)) continue;
    const key = matchCityKey(cityName) ?? norm(cityName);
    const city = i.nodes.find((n) => n.level === "city" && (matchCityKey(n.name) ?? norm(n.name)) === key);
    const node = city ? i.nodes.find((n) => n.level === "brand" && n.parentId === city.id && isMarketplace(n)) : undefined;
    if (!node) continue;
    out.push({ projectId: node.id, label: label(node), kind: "marketplace", base: r2(base), pct: mpPct, amount: r2((base * mpPct) / 100) });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, "pt"));
}
