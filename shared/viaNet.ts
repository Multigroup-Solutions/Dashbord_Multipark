/**
 * "Via net" no Marketing — regras puras (Jorge, 8 out 2026: "1 sim 2 sim 3 não").
 *
 * 1. QUE reservas contam como via net: tudo o que NÃO é parceiro (canal
 *    Direto ou Marketplace — classifyBookingChannel), MENOS:
 *      - as PENDENTES (compra online por acabar — `PENDING`; a mesma regra das
 *        Parcerias, dos Parceiros e das Operações: só contam as confirmadas,
 *        ativas e concluídas; as canceladas já não vêm);
 *      - as de clientes PRO (`proClientId` ou `pro`) e as de AVENÇAS
 *        (`clientPlanId`) — a mesma identificação da Faturação de parceiros
 *        (multiparkDb/partnerBilling.ts).
 * 2. QUANTO vale cada reserva para o Marketing (valor via net, valor ligadas,
 *    ROAS por marca/cidade e por campanha):
 *      - parques NOSSOS → o preço inteiro (também as que vieram pelo
 *        Marketplace: a comissão de 20 % é custo à parte);
 *      - parques de TERCEIROS → só a NOSSA comissão: a gravada na reserva
 *        ("commissionAmount"); sem ela, a taxa do parque — comissão ÷ valor
 *        das reservas desse parque com comissão gravada no mesmo período (a
 *        conta das Parcerias/Faturação); sem nenhuma → 0, marcada "comissão em
 *        falta" (nada de taxas inventadas).
 * 3. COMO se reparte o via net de uma marca/cidade pelas campanhas dela: em
 *    proporção às CONVERSÕES da plataforma (Google/Meta) no período; se nenhuma
 *    campanha do grupo tiver conversões, pelos CLIQUES; se nem cliques, pelo
 *    GASTO. As campanhas nacionais entram em cada cidade com a sua parte
 *    (nationalShares). Uma marca/cidade sem campanhas fica "por repartir".
 *    As "ligadas" (link/gclid/utm/código) continuam a ser as diretas.
 */

// ─── 1. Que reservas contam ─────────────────────────────────────────────────

/** Porque é que uma reserva que não é de parceiro NÃO conta como via net. */
export type ViaNetExclusion = "pending" | "pro" | "plan";

export const VIA_NET_EXCLUSION_LABEL: Record<ViaNetExclusion, string> = {
  pending: "pendente (compra por acabar)",
  pro: "cliente Pro",
  plan: "avença",
};

/** Estado da Multipark de uma compra online por acabar. */
export const PENDING_STATUS = "PENDING";

/** Pendente → Pro → avença (a primeira que se aplica); null = conta. PURA. */
export function viaNetExclusion(b: { status?: string | null; pro?: boolean | null; plan?: boolean | null }): ViaNetExclusion | null {
  if (String(b.status ?? "").trim().toUpperCase() === PENDING_STATUS) return "pending";
  if (b.pro) return "pro";
  if (b.plan) return "plan";
  return null;
}

/** Conta como via net: não é parceiro e não está excluída. PURA. */
export function isViaNet(channel: string, exclusion: ViaNetExclusion | null): boolean {
  return channel !== "parceiro" && exclusion == null;
}

// ─── 2. Quanto vale ─────────────────────────────────────────────────────────

const cents = (n: number) => Math.round(n * 100) / 100;

export interface ValueInput { parkId: string; parkOurs: boolean; total: number; commission?: number | null }
export interface MarketingValue {
  /** valor para o Marketing (preço inteiro nos nossos; a nossa comissão nos de terceiros) */
  value: number;
  /** parque de terceiros sem comissão gravada nem taxa do parque no período (valor 0) */
  commissionMissing: boolean;
  /** de onde veio o valor */
  valueBasis: "price" | "commission" | "park_rate" | "missing";
}

/**
 * Taxa de cada parque de terceiros: Σ comissão gravada ÷ Σ valor das reservas
 * desse parque COM comissão gravada (> 0). PURA.
 */
export function thirdParkRates(bookings: ReadonlyArray<ValueInput>): Map<string, number> {
  const acc = new Map<string, { c: number; v: number }>();
  for (const b of bookings) {
    if (b.parkOurs || !(Number(b.commission) > 0) || !(b.total > 0)) continue;
    const a = acc.get(b.parkId) ?? { c: 0, v: 0 };
    a.c += Number(b.commission); a.v += b.total; acc.set(b.parkId, a);
  }
  const out = new Map<string, number>();
  for (const [park, a] of acc) if (a.v > 0) out.set(park, a.c / a.v);
  return out;
}

/** Valor de UMA reserva para o Marketing (ver regra 2). PURA. */
export function marketingValueOf(b: ValueInput, rates: ReadonlyMap<string, number>): MarketingValue {
  if (b.parkOurs) return { value: cents(b.total), commissionMissing: false, valueBasis: "price" };
  if (Number(b.commission) > 0) return { value: cents(Number(b.commission)), commissionMissing: false, valueBasis: "commission" };
  const rate = rates.get(b.parkId);
  if (rate != null && rate > 0) return { value: cents(b.total * rate), commissionMissing: false, valueBasis: "park_rate" };
  return { value: 0, commissionMissing: true, valueBasis: "missing" };
}

/** Valores de uma lista (a taxa de cada parque sai da própria lista). Devolve cópias. PURA. */
export function withMarketingValues<T extends ValueInput>(bookings: ReadonlyArray<T>): Array<T & MarketingValue> {
  const rates = thirdParkRates(bookings);
  return bookings.map((b) => ({ ...b, ...marketingValueOf(b, rates) }));
}

// ─── 3. Repartição pelas campanhas ──────────────────────────────────────────

export type ViaNetBase = "conversions" | "clicks" | "cost";
export const VIA_NET_BASE_LABEL: Record<ViaNetBase | "mixed", string> = {
  conversions: "conversões", clicks: "cliques", cost: "gasto", mixed: "várias (por cidade)",
};
/** Texto curto para o ecrã. */
export const VIA_NET_SPLIT_EXPLAINER = "via net repartido pelas conversões da Google/Meta; sem conversões, pelos cliques (sem cliques, pelo gasto)";

export interface ProjectLite { id: number; level: string; parentId: number | null }

/** Nó marca-cidade (nível "brand") de um projeto: ele próprio ou o de cima. PURA. */
export function brandNodeResolver(projects: ReadonlyArray<ProjectLite>): (projectId: number | null | undefined) => number | null {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const cache = new Map<number, number | null>();
  return (projectId) => {
    if (projectId == null) return null;
    if (cache.has(projectId)) return cache.get(projectId)!;
    let node = byId.get(projectId); const seen = new Set<number>();
    while (node && node.level !== "brand") {
      if (seen.has(node.id) || node.parentId == null) { node = undefined; break; }
      seen.add(node.id); node = byId.get(node.parentId);
    }
    const out = node ? node.id : null;
    cache.set(projectId, out);
    return out;
  };
}

export interface ViaNetPool { bookings: number; value: number }

/** Reservas via net por nó marca-cidade (as sem nó ficam de fora). PURA. */
export function viaNetPools(bookings: ReadonlyArray<{ projectId: number | null; viaNet: boolean; value?: number; total: number }>, nodeOf: (projectId: number | null) => number | null): { pools: Map<number, ViaNetPool>; withoutNode: ViaNetPool } {
  const pools = new Map<number, ViaNetPool>();
  const withoutNode: ViaNetPool = { bookings: 0, value: 0 };
  for (const b of bookings) {
    if (!b.viaNet) continue;
    const v = b.value ?? b.total;
    const node = nodeOf(b.projectId);
    const p = node == null ? withoutNode : pools.get(node) ?? { bookings: 0, value: 0 };
    p.bookings++; p.value += v;
    if (node != null) pools.set(node, p);
  }
  return { pools, withoutNode };
}

export interface ViaNetParticipant { key: string; node: number; conversions: number; clicks: number; cost: number }

/**
 * Quem entra na repartição: as campanhas de cidade (no nó da campanha) e as
 * partes das nacionais (uma por cidade, `nationalShares`). Por associar e
 * nacionais sem cidades ficam de fora. PURA.
 */
export function viaNetParticipants(
  campaigns: ReadonlyArray<{ key: string; projectId: number | null; national?: boolean; conversions: number; clicks: number; cost: number }>,
  nationalShares: ReadonlyArray<{ key: string; projectId: number; conversions: number; clicks: number; cost: number }>,
  nodeOf: (projectId: number | null) => number | null,
): ViaNetParticipant[] {
  const out: ViaNetParticipant[] = [];
  for (const c of campaigns) {
    if (c.national) continue;
    const node = nodeOf(c.projectId);
    if (node != null) out.push({ key: c.key, node, conversions: Number(c.conversions) || 0, clicks: Number(c.clicks) || 0, cost: Number(c.cost) || 0 });
  }
  for (const s of nationalShares) {
    const node = nodeOf(s.projectId);
    if (node != null) out.push({ key: s.key, node, conversions: Number(s.conversions) || 0, clicks: Number(s.clicks) || 0, cost: Number(s.cost) || 0 });
  }
  return out;
}

/** Base de um grupo: conversões > cliques > gasto (a primeira com soma > 0); null = nada para repartir. PURA. */
export function splitBase(parts: ReadonlyArray<Pick<ViaNetParticipant, "conversions" | "clicks" | "cost">>): ViaNetBase | null {
  for (const base of ["conversions", "clicks", "cost"] as const) if (parts.reduce((t, p) => t + Math.max(0, p[base]), 0) > 0) return base;
  return null;
}

export interface CampaignViaNet {
  /** reservas via net repartidas (1 casa) */
  bookings: number;
  /** valor via net repartido (cêntimos) */
  value: number;
  /** parte da campanha no via net da(s) sua(s) marca/cidade(s) (0–1) */
  share: number;
  /** base usada (conversões/cliques/gasto; "mixed" = nacional com bases diferentes por cidade) */
  base: ViaNetBase | "mixed";
}

export interface ViaNetSplit {
  byCampaign: Map<string, CampaignViaNet>;
  /** base de cada marca/cidade (null = sem campanhas com conversões, cliques nem gasto) */
  baseByNode: Map<number, ViaNetBase | null>;
  /** via net de marcas/cidades sem campanhas para o receber */
  unassigned: ViaNetPool & { nodes: number[] };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Reparte o via net de cada marca/cidade pelas campanhas dela (regra 3). PURA.
 * Toda a campanha que participa aparece (com 0 se o grupo não teve via net).
 */
export function splitViaNet(pools: ReadonlyMap<number, ViaNetPool>, participants: ReadonlyArray<ViaNetParticipant>): ViaNetSplit {
  const byNode = new Map<number, ViaNetParticipant[]>();
  for (const p of participants) { const l = byNode.get(p.node) ?? []; l.push(p); byNode.set(p.node, l); }
  const acc = new Map<string, { bookings: number; value: number; pool: number; weights: number[]; bases: Set<ViaNetBase> }>();
  const baseByNode = new Map<number, ViaNetBase | null>();
  const unassigned = { bookings: 0, value: 0, nodes: [] as number[] };
  const nodes = new Set<number>([...byNode.keys(), ...pools.keys()]);
  for (const node of nodes) {
    const parts = byNode.get(node) ?? [];
    const pool = pools.get(node) ?? { bookings: 0, value: 0 };
    const base = splitBase(parts);
    baseByNode.set(node, base);
    if (!base) {
      if (pool.bookings > 0) { unassigned.bookings += pool.bookings; unassigned.value += pool.value; unassigned.nodes.push(node); }
      continue;
    }
    // a mesma campanha pode vir duas vezes no mesmo nó (duas contas ou nacional + cidade): junta-se
    const weightOf = new Map<string, number>();
    for (const p of parts) weightOf.set(p.key, (weightOf.get(p.key) ?? 0) + Math.max(0, p[base]));
    const total = [...weightOf.values()].reduce((t, w) => t + w, 0);
    for (const [key, w] of weightOf) {
      const share = total > 0 ? w / total : 0;
      const a = acc.get(key) ?? { bookings: 0, value: 0, pool: 0, weights: [], bases: new Set<ViaNetBase>() };
      a.bookings += pool.bookings * share; a.value += pool.value * share; a.pool += pool.bookings; a.weights.push(share); a.bases.add(base);
      acc.set(key, a);
    }
  }
  const byCampaign = new Map<string, CampaignViaNet>();
  for (const [key, a] of acc) {
    const share = a.pool > 0 ? a.bookings / a.pool : a.weights.reduce((t, w) => t + w, 0) / Math.max(1, a.weights.length);
    byCampaign.set(key, { bookings: round1(a.bookings), value: cents(a.value), share: Math.round(share * 1000) / 1000, base: a.bases.size === 1 ? [...a.bases][0] : "mixed" });
  }
  unassigned.value = cents(unassigned.value);
  return { byCampaign, baseByNode, unassigned };
}

/** "≈ 3,4" quando é fração; "3" quando é inteiro (pt-PT). PURA. */
export function fmtViaNet(n: number | null | undefined): string {
  if (n == null) return "—";
  const r = round1(n);
  return Number.isInteger(r) ? r.toLocaleString("pt-PT") : `≈ ${r.toLocaleString("pt-PT", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
}
