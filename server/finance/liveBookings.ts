/**
 * Reservas para o Financeiro e a Caixa, AO VIVO da BD da Multipark
 * (server/multiparkDb/financeAgg.ts) — em vez da cópia `multipark_bookings`.
 *
 * Do nosso lado:
 *   - só os NOSSOS parques (Airpark/Redpark/Skypark em Lisboa/Porto/Faro —
 *     shared/multiparkParks.ts). Os do marketplace ficam fora da receita;
 *   - parque → centro de custos pelo mesmo matcher que a cópia usava
 *     (shared/projectTree.ts createParkMatcher). Parque nosso sem centro →
 *     projectId null ("Por atribuir", aviso de qualidade);
 *   - campanha = parceiro nosso pelos aliases (partner_aliases: id de parceiro
 *     da Multipark, depois método de pagamento); senão o nome do parceiro, o
 *     código de desconto ou o nome da campanha (bookingCampaignFallback) —
 *     a mesma regra com que a cópia era gravada.
 */
import type { FinanceAggKind, FinanceAggRow, MultiparkParkRow } from "../multiparkDb/financeAgg";
import { classifyPark } from "../../shared/multiparkParks";
import { createParkMatcher } from "../../shared/projectTree";
import { bookingCampaignFallback } from "../../shared/partnerRules";

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
}

export interface LiveContext {
  /** parques nossos: id → centro (null = sem centro) */
  ourParks: Map<string, number | null>;
  /** "multipark_partner_id:<id>" / "payment_method:<método>" → nome do parceiro */
  aliases: Map<string, string>;
}

/** Parques → nossos + centro. PURA. */
export function buildOurParks(parks: MultiparkParkRow[], matcher: (i: { parkName?: string | null; city?: string | null }) => number | undefined): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const p of parks) {
    if (!classifyPark({ name: p.name, city: p.city, firebaseBrand: p.firebaseBrand, listingType: p.listingType }).ours) continue;
    out.set(p.id, matcher({ parkName: p.name, city: p.city }) ?? null);
  }
  return out;
}

/** Campanha (parceiro) de um agregado — a regra da cópia. PURA. */
export function campaignOf(r: Pick<FinanceAggRow, "partnerId" | "paymentMethod" | "partnerName" | "discountCode" | "campaignName">, aliases: Map<string, string>): string | null {
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

export async function loadLiveContext(): Promise<LiveContext> {
  if (ctxCache && Date.now() - ctxCache.at < CTX_TTL_MS) return ctxCache.ctx;
  const [{ readParks }, { getProjects }, { PARK_CONFIGS }] = await Promise.all([
    import("../multiparkDb/financeAgg"), import("../db"), import("../multipark"),
  ]);
  const [parks, projects, aliases] = await Promise.all([readParks(), getProjects(), loadAliases()]);
  const matcher = createParkMatcher(projects as any, PARK_CONFIGS);
  const ctx: LiveContext = { ourParks: buildOurParks(parks, matcher), aliases };
  ctxCache = { at: Date.now(), ctx };
  return ctx;
}

/**
 * Reservas de um tipo (entregues, recolhidas, previstas, no-shows pagos,
 * canceladas pagas) no período UTC [start, end), dos nossos parques, já com
 * centro e campanha. `projectIds` filtra pelo centro (sem centro fica fora,
 * como antes). Lança se a BD da Multipark não responder.
 */
export async function loadLiveBookingAgg(kind: FinanceAggKind, range: { start: string; end: string; todayStart?: string }, projectIds?: number[] | null): Promise<LiveBookingAgg[]> {
  const ctx = await loadLiveContext();
  let parkIds = [...ctx.ourParks.keys()];
  if (projectIds) {
    const set = new Set(projectIds);
    parkIds = parkIds.filter((id) => { const pid = ctx.ourParks.get(id); return pid != null && set.has(pid); });
  }
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
