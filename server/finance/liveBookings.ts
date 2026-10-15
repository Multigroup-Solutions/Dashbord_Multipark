/**
 * Reservas para o Financeiro e a Caixa, AO VIVO da BD da Multipark
 * (server/multiparkDb/financeAgg.ts) — em vez da cópia `multipark_bookings`.
 *
 * Do nosso lado:
 *   - só os NOSSOS parques (Airpark/Redpark/Skypark em Lisboa/Porto/Faro —
 *     shared/multiparkParks.ts; a cidade pelo resolvedor único, que reconhece
 *     "Prior Velho", "Maia"…). Os do marketplace ficam fora da receita;
 *   - parque → centro de custos pelo mesmo matcher que a cópia usava
 *     (shared/projectTree.ts createParkMatcher). Parque nosso sem centro →
 *     projectId null ("Por atribuir", aviso de qualidade);
 *   - campanha = parceiro nosso pelos aliases (partner_aliases: id de parceiro
 *     da Multipark, depois método de pagamento); senão o nome do parceiro, o
 *     código de desconto ou o nome da campanha (bookingCampaignFallback) —
 *     a mesma regra com que a cópia era gravada.
 */
import type { FinanceAggKind, FinanceAggRow, MultiparkParkRow } from "../multiparkDb/financeAgg";
import { classifyPark, marketplaceOperated, resolveParkCity } from "../../shared/multiparkParks";
import { MARKETPLACE_BRAND, createParkMatcher, isNodeActive, normalizeParkName, type ProjectTreeNode } from "../../shared/projectTree";
import { CITY_LABELS, matchCityKey } from "../../shared/city";
import { bookingCampaignFallback } from "../../shared/partnerRules";
import { MARKETPLACE_CAMPAIGN } from "../../shared/marketplace";

export interface LiveBookingAgg {
  day: string;
  projectId: number | null;
  parkId: string;
  campaign: string | null;
  paymentMethod: string | null;
  count: number;
  total: number;
  parking: number;
  delivery: number;
  extras: number;
  paid: number;
  remaining: number;
  owingCount: number;
  status: string | null;
  pro: boolean;
  discount: number;
}

export interface LiveContext {
  /** parques nossos: id → centro (null = sem centro) */
  ourParks: Map<string, number | null>;
  /** nome e cidade dos parques nossos (Parcerias mostra por parque) */
  parkInfo?: Map<string, { name: string; city: string | null }>;
  /** "multipark_partner_id:<id>" / "payment_method:<método>" → nome do parceiro */
  aliases: Map<string, string>;
  /**
   * Marketing (Jorge, 7 out 2026: "não encontramos as reservas do Marketplace"):
   * TODOS os parques de TERCEIROS → nó do Marketplace (o parque debaixo de
   * "Marketplace <cidade>", senão o próprio nó Marketplace da cidade; null =
   * sem cidade reconhecida ou cidade sem nó Marketplace → "Marketplace (sem
   * cidade)", com aviso — 8 out 2026, antes ficavam de fora). Só o Marketing
   * os lê — a receita, a Caixa e o CRM continuam só com os nossos.
   */
  marketplaceParks?: Map<string, number | null>;
  /** Parques de terceiros: nome, cidade gravada e se são operados por nós (etiqueta da comissão). */
  marketplaceParkInfo?: Map<string, MarketplaceParkInfo>;
  /** nó "Marketplace" (marca) de cada cidade: "lisboa" | "porto" | "faro" → id */
  marketplaceNodeByCity?: Map<string, number>;
  /** cidade (chave) de cada parque nosso — para pôr no Marketplace o que veio por multipark.pt */
  parkCity?: Map<string, string | null>;
}

export interface MarketplaceParkInfo { name: string; city: string | null; operated: boolean }

const classify = (p: MultiparkParkRow) => classifyPark({ name: p.name, city: p.city, address: p.address, firebaseBrand: p.firebaseBrand, listingType: p.listingType });
/**
 * Cidade para o matcher de centros: a reconhecida (resolveParkCity — "Prior
 * Velho" → Lisboa), senão a gravada. PURA.
 */
const matcherCity = (p: MultiparkParkRow): string | null => {
  const key = resolveParkCity(p).city;
  return key ? CITY_LABELS[key] : p.city;
};

/** Parques → nossos + centro. PURA. */
export function buildOurParks(parks: MultiparkParkRow[], matcher: (i: { parkName?: string | null; city?: string | null }) => number | undefined): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const p of parks) {
    if (!classify(p).ours) continue;
    out.set(p.id, matcher({ parkName: p.name, city: matcherCity(p) }) ?? null);
  }
  return out;
}

/** Parques de terceiros → nome, cidade gravada e operado por nós. PURA. */
export function buildMarketplaceParkInfo(parks: MultiparkParkRow[], excludedParkIds: readonly string[] = []): Map<string, MarketplaceParkInfo> {
  const ex = new Set(excludedParkIds);
  const out = new Map<string, MarketplaceParkInfo>();
  for (const p of parks) {
    if (classify(p).ours) continue;
    out.set(p.id, { name: p.name, city: p.city, operated: marketplaceOperated({ id: p.id, name: p.name, ours: false }, ex) });
  }
  return out;
}

const isMarketplaceName = (name: string) => normalizeParkName(name) === normalizeParkName(MARKETPLACE_BRAND);

/** Nó "Marketplace" (marca, ativo) debaixo de cada cidade. PURA. */
export function marketplaceNodesByCity(nodes: readonly ProjectTreeNode[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, number>();
  for (const n of [...nodes].sort((a, b) => a.id - b.id)) {
    if (n.level !== "brand" || !isNodeActive(n) || !isMarketplaceName(n.name) || n.parentId == null) continue;
    const city = byId.get(n.parentId);
    const key = city && city.level === "city" ? matchCityKey(city.name) : null;
    if (key && !out.has(key)) out.set(key, n.id);
  }
  return out;
}

/**
 * TODOS os parques de terceiros (não nossos) → nó do Marketplace: o nó do
 * parque se estiver debaixo de um nó Marketplace; senão o nó Marketplace da
 * cidade do parque (resolveParkCity: cidade, terra à volta, nome, morada);
 * null sem nada — o parque ENTRA na mesma ("Marketplace (sem cidade)"). PURA.
 */
export function buildMarketplaceParks(parks: MultiparkParkRow[], matcher: (i: { parkName?: string | null; city?: string | null }) => number | undefined, nodes: readonly ProjectTreeNode[]): Map<string, number | null> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byCity = marketplaceNodesByCity(nodes);
  const underMarketplace = (id: number): boolean => {
    const seen = new Set<number>();
    let node = byId.get(id);
    while (node && !seen.has(node.id)) {
      if (node.level === "brand") return isMarketplaceName(node.name);
      seen.add(node.id);
      node = node.parentId == null ? undefined : byId.get(node.parentId);
    }
    return false;
  };
  const out = new Map<string, number | null>();
  for (const p of parks) {
    if (classify(p).ours) continue;
    const hit = matcher({ parkName: p.name, city: matcherCity(p) });
    if (hit != null && underMarketplace(hit)) { out.set(p.id, hit); continue; }
    const city = resolveParkCity(p).city;
    out.set(p.id, city ? byCity.get(city) ?? null : null);
  }
  return out;
}

/**
 * Campanha (parceiro) de um agregado — a regra da cópia. 28b: veio pela
 * campanha do Marketplace (`origin = 'MARKETPLACE'`) → "Marketplace", que ganha
 * ao parceiro (como no canal da reserva, classifyBookingChannel) — nunca duas
 * comissões pela mesma reserva. PURA.
 */
export function campaignOf(r: Pick<FinanceAggRow, "partnerId" | "paymentMethod" | "partnerName" | "discountCode" | "campaignName"> & { marketplace?: boolean }, aliases: Map<string, string>): string | null {
  if (r.marketplace) return MARKETPLACE_CAMPAIGN;
  if (r.partnerId) {
    const hit = aliases.get(`multipark_partner_id:${r.partnerId.trim().toLowerCase()}`);
    if (hit) return hit;
  }
  if (r.paymentMethod) {
    const hit = aliases.get(`payment_method:${r.paymentMethod.trim().toLowerCase()}`);
    if (hit) return hit;
  }
  return bookingCampaignFallback({ partnerName: r.partnerName, discountCode: r.discountCode, campaign: r.campaignName });
}

/** Agregados da Multipark → linhas do motor (centro + campanha). PURA. */
export function toLiveBookingAgg(rows: FinanceAggRow[], ctx: LiveContext): LiveBookingAgg[] {
  const out: LiveBookingAgg[] = [];
  for (const r of rows) {
    if (!ctx.ourParks.has(r.parkId)) continue;
    out.push({
      day: r.day, projectId: ctx.ourParks.get(r.parkId) ?? null, parkId: r.parkId, campaign: campaignOf(r, ctx.aliases),
      paymentMethod: r.paymentMethod, count: r.count, total: r.total, parking: r.parking, delivery: r.delivery,
      extras: r.extras, paid: r.paid, remaining: r.remaining, owingCount: r.owingCount,
      status: r.status, pro: r.pro, discount: r.discount,
    });
  }
  return out;
}

// ─── Contexto (parques + aliases), 5 min em memória ─────────────────────────

const CTX_TTL_MS = 5 * 60_000;
let ctxCache: { at: number; ctx: LiveContext } | null = null;

export function resetLiveContextCache(): void { ctxCache = null; }

async function loadAliases(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { getDb } = await import("../db");
  const db = await getDb();
  if (!db) return map;
  const { partnerAliases, partnerships } = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ aliasType: partnerAliases.aliasType, aliasValue: partnerAliases.aliasValue, partnerName: partnerships.name })
    .from(partnerAliases)
    .leftJoin(partnerships, eq(partnerships.id, partnerAliases.partnershipId));
  for (const r of rows) {
    if (!r.partnerName) continue;
    map.set(`${r.aliasType}:${(r.aliasValue ?? "").trim().toLowerCase()}`, r.partnerName);
  }
  return map;
}

/** "Parques que a operação não faz" (Definições) — só para a etiqueta "operado / não operado". */
async function loadExcludedParkIds(): Promise<string[]> {
  try {
    const { getSetting } = await import("../appSettings");
    return ((await getSetting("operations.excludedParks")) as string[] | null) ?? [];
  } catch {
    return [];
  }
}

export async function loadLiveContext(): Promise<LiveContext> {
  if (ctxCache && Date.now() - ctxCache.at < CTX_TTL_MS) return ctxCache.ctx;
  const [{ readParks }, { getProjects }, { PARK_CONFIGS }] = await Promise.all([
    import("../multiparkDb/financeAgg"), import("../db"), import("../multipark"),
  ]);
  const [parks, projects, aliases, excludedParkIds] = await Promise.all([readParks(), getProjects(), loadAliases(), loadExcludedParkIds()]);
  const matcher = createParkMatcher(projects as any, PARK_CONFIGS);
  const ourParks = buildOurParks(parks, matcher);
  const parkInfo = new Map(parks.filter((p) => ourParks.has(p.id)).map((p) => [p.id, { name: p.name, city: p.city }]));
  const nodes = projects as unknown as ProjectTreeNode[];
  const marketplaceParks = buildMarketplaceParks(parks, matcher, nodes);
  const marketplaceParkInfo = buildMarketplaceParkInfo(parks, excludedParkIds);
  const marketplaceNodeByCity = marketplaceNodesByCity(nodes);
  const parkCity = new Map(parks.filter((p) => ourParks.has(p.id)).map((p) => [p.id, resolveParkCity(p).city]));
  const ctx: LiveContext = { ourParks, parkInfo, aliases, marketplaceParks, marketplaceParkInfo, marketplaceNodeByCity, parkCity };
  ctxCache = { at: Date.now(), ctx };
  return ctx;
}

/**
 * Reservas de um tipo (entregues, recolhidas, previstas, no-shows pagos,
 * canceladas pagas) no período UTC [start, end), dos nossos parques, já com
 * centro e campanha. `projectIds` filtra pelo centro (sem centro fica fora,
 * como antes). Lança se a BD da Multipark não responder.
 */
/** Parques nossos cortados pelo filtro de centro (sem centro fica fora quando há filtro). PURA. */
export function parkIdsFor(ctx: LiveContext, projectIds?: number[] | null): string[] {
  let parkIds = [...ctx.ourParks.keys()];
  if (projectIds) {
    const set = new Set(projectIds);
    parkIds = parkIds.filter((id) => { const pid = ctx.ourParks.get(id); return pid != null && set.has(pid); });
  }
  return parkIds;
}

export async function loadLiveBookingAgg(kind: FinanceAggKind, range: { start: string; end: string; todayStart?: string }, projectIds?: number[] | null): Promise<LiveBookingAgg[]> {
  const ctx = await loadLiveContext();
  const parkIds = parkIdsFor(ctx, projectIds);
  if (!parkIds.length) return [];
  const { readFinanceAgg } = await import("../multiparkDb/financeAgg");
  const rows = await readFinanceAgg({ kind, start: range.start, end: range.end, todayStart: range.todayStart, parkIds });
  return toLiveBookingAgg(rows, ctx);
}

/** Soma por chave. PURA. */
export function groupAgg<K extends string>(rows: LiveBookingAgg[], key: (r: LiveBookingAgg) => K): Map<K, LiveBookingAgg[]> {
  const m = new Map<K, LiveBookingAgg[]>();
  for (const r of rows) { const k = key(r); const l = m.get(k); if (l) l.push(r); else m.set(k, [r]); }
  return m;
}
export const sumOf = (rows: LiveBookingAgg[], f: (r: LiveBookingAgg) => number) => rows.reduce((s, r) => s + f(r), 0);
