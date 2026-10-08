/**
 * Reservas para o Marketing, AO VIVO da BD da Multipark
 * (server/multiparkDb/marketingBookings.ts) — em vez da cópia
 * `multipark_bookings` (Jorge, 28 set 2026).
 *
 * Do nosso lado, com as MESMAS regras que gravavam a cópia:
 *   - só os nossos parques; parque → centro (server/finance/liveBookings.ts);
 *   - atribuição Google/Meta a partir do link de origem
 *     (integrations/googleAds/attribution.ts attributionFromUrl);
 *   - campanha/parceiro por aliases, senão parceiro / código / campanha
 *     (campaignOf);
 *   - âmbito de cidade do utilizador (scopedProjectIds) e filtro de centro.
 *
 * Marketplace (Jorge, 7 out 2026: "continuamos a não encontrar as reservas do
 * Marketplace"), só com `{ marketplace: true }` (o separador Anúncios, os
 * totais, o ROAS por campanha e os alertas): entram também as vendas nossas
 * nos parques de TERCEIROS (origin MARKETPLACE ou comissão nossa) e as
 * reservas dos nossos parques que vieram pelo multipark.pt (origin
 * MARKETPLACE) — todas no nó "Marketplace <cidade>", onde estão as campanhas
 * "Multipark - <Cidade> - PT". A receita, a Caixa e o CRM não mudam.
 */
import { attributionFromUrl, type AdAttribution } from "./integrations/googleAds/attribution";
import { campaignOf, loadLiveContext, type LiveContext } from "./finance/liveBookings";
import { lisbonDayRangeUtc } from "../shared/lisbonDay";
import { classifyBookingChannel } from "../shared/multiparkParks";
import type { MarketingBookingRow, MarketingClientRow } from "./multiparkDb/marketingBookings";

export interface MarketingBooking {
  id: string;
  /** UTC "YYYY-MM-DD HH:MM:SS" */
  createdAt: string;
  /** dia de Lisboa da criação */
  day: string;
  projectId: number | null;
  parkId: string;
  status: string | null;
  origin: string | null;
  /** reserva de um parceiro da Multipark (partnerId/nome) */
  hasPartner: boolean;
  /**
   * 28c (Jorge, 6 out): "via net" — tudo o que NÃO é parceiro (canal Direto ou
   * Marketplace de classifyBookingChannel: sem partnerId, sem origem de
   * parceiro, sem agregador a cobrar). É o que os anúncios podem trazer.
   */
  viaNet: boolean;
  hasOriginUrl: boolean;
  /** gclid / gbraid / wbraid no link */
  hasClickId: boolean;
  /** gclid do link (liga a reserva à campanha pelo clique — integrations/googleAds/clickAttribution.ts) */
  gclid?: string | null;
  adAttribution: AdAttribution;
  adCampaignExternalId: string | null;
  utmCampaign: string | null;
  /** campanha resolvida (parceiro nosso, código de desconto…) — a antiga coluna `campaign` */
  campaign: string | null;
  /** nome da campanha da Multipark — a antiga `campaignName` */
  campaignName: string | null;
  total: number;
  hasEmail: boolean;
  newClient: boolean;
  /** Venda pelo Marketplace (parque de terceiros, ou nosso com origem MARKETPLACE) — só com `{ marketplace: true }`. */
  marketplace?: boolean;
  /** Comissão nossa nos parques de terceiros (null = sem valor na Multipark). */
  commission?: number | null;
}

export interface MarketingLoadOptions {
  /** Também as vendas do Marketplace, no nó "Marketplace <cidade>". */
  marketplace?: boolean;
}

/** Reserva da Multipark → reserva do marketing. PURA. */
export function toMarketingBooking(r: MarketingBookingRow, ctx: LiveContext, opts: MarketingLoadOptions = {}): MarketingBooking | null {
  const own = ctx.ourParks.has(r.parkId);
  const third = !own && !!opts.marketplace && !!ctx.marketplaceParks?.has(r.parkId);
  if (!own && !third) return null;
  const viaMarketplace = third || (!!opts.marketplace && String(r.origin ?? "").toUpperCase() === "MARKETPLACE");
  let projectId = own ? ctx.ourParks.get(r.parkId) ?? null : ctx.marketplaceParks!.get(r.parkId) ?? null;
  if (own && viaMarketplace) {
    const city = ctx.parkCity?.get(r.parkId);
    const node = city ? ctx.marketplaceNodeByCity?.get(city) : undefined;
    if (node != null) projectId = node;
  }
  const a = attributionFromUrl(r.originUrl);
  return {
    id: r.id, createdAt: r.createdAt, day: r.day, projectId, parkId: r.parkId, status: r.status, origin: r.origin,
    hasPartner: !!(r.partnerId || (r.partnerName && !/unknown/i.test(r.partnerName))),
    viaNet: classifyBookingChannel({ parkOurs: own, origin: r.origin, paymentSource: r.paymentSource ?? null, partnerId: r.partnerId, partnerName: r.partnerName }).channel !== "parceiro",
    ...(opts.marketplace ? { marketplace: viaMarketplace, commission: third ? r.commission ?? null : null } : {}),
    hasOriginUrl: !!r.originUrl, hasClickId: !!(a.gclid || a.gbraid || a.wbraid),
    adAttribution: a.adAttribution, adCampaignExternalId: a.adCampaignExternalId, utmCampaign: a.utmCampaign,
    gclid: a.gclid,
    campaign: campaignOf(r, ctx.aliases), campaignName: r.campaignName, total: r.total, hasEmail: r.hasEmail, newClient: r.newClient,
  };
}

/** O centro está no âmbito do utilizador e no filtro? (sem centro só passa sem filtros) PURA. */
function allowedBy(projectIds?: number[] | null, scoped?: number[] | undefined) {
  return (pid: number | null) => {
    if (scoped && (pid == null || !scoped.includes(pid))) return false;
    if (projectIds && (pid == null || !projectIds.includes(pid))) return false;
    return true;
  };
}

/** Parques a ler: os nossos, cortados pelo âmbito do utilizador e pelo filtro de centro. PURA. */
export function parksFor(ctx: LiveContext, projectIds?: number[] | null, scoped?: number[] | undefined): string[] {
  const allowed = allowedBy(projectIds, scoped);
  return [...ctx.ourParks.entries()].filter(([, pid]) => allowed(pid)).map(([id]) => id);
}

/**
 * Marketplace no âmbito: parques de terceiros cujo nó passa (`third`) e
 * parques nossos que não passam pelo centro deles mas cujo nó Marketplace da
 * cidade passa (`marketplaceOnly`: só as reservas vindas pelo Marketplace). PURA.
 */
export function marketplaceParksFor(ctx: LiveContext, projectIds?: number[] | null, scoped?: number[] | undefined): { third: string[]; marketplaceOnly: string[] } {
  const allowed = allowedBy(projectIds, scoped);
  const third = [...(ctx.marketplaceParks ?? new Map<string, number | null>()).entries()].filter(([, pid]) => pid != null && allowed(pid)).map(([id]) => id);
  const marketplaceOnly = [...ctx.ourParks.entries()].filter(([id, pid]) => {
    if (allowed(pid)) return false;
    const city = ctx.parkCity?.get(id);
    const node = city ? ctx.marketplaceNodeByCity?.get(city) : undefined;
    return node != null && allowed(node);
  }).map(([id]) => id);
  return { third, marketplaceOnly };
}

async function scope(projectIds?: number[] | null) {
  const [ctx, { scopedProjectIds }, { INTERNAL_EMAIL_DOMAINS }] = await Promise.all([
    loadLiveContext(), import("./cityScope"), import("../shared/crmIdentity"),
  ]);
  const scoped = scopedProjectIds();
  return { ctx, parkIds: parksFor(ctx, projectIds, scoped), internalDomains: INTERNAL_EMAIL_DOMAINS, allowed: allowedBy(projectIds, scoped), projectIds, scoped };
}

/**
 * Reservas criadas nos dias de Lisboa [from, to] (sem canceladas), dos nossos
 * parques, já com centro, atribuição e campanha. Lança se a BD da Multipark
 * não responder.
 */
export async function loadMarketingBookings(from: string, to: string, projectIds?: number[] | null, opts: MarketingLoadOptions = {}): Promise<MarketingBooking[]> {
  const { ctx, parkIds, internalDomains, allowed, scoped } = await scope(projectIds);
  const mk = opts.marketplace ? marketplaceParksFor(ctx, projectIds, scoped) : { third: [], marketplaceOnly: [] };
  if (!parkIds.length && !mk.third.length && !mk.marketplaceOnly.length) return [];
  // A mesma página pede isto várias vezes (estatísticas, marcas, ROAS, canais, alertas):
  // uma consulta por período × parques a cada minuto (a promessa é partilhada).
  const key = JSON.stringify([from, to, [...parkIds].sort(), opts.marketplace ? [[...mk.third].sort(), [...mk.marketplaceOnly].sort(), projectIds ?? null] : null]);
  const hit = bookingsCache.get(key);
  if (hit && Date.now() - hit.at < BOOKINGS_TTL_MS) return hit.value;
  const value = (async () => {
    const { readMarketingBookings, MARKETING_BOOKINGS_LIMIT } = await import("./multiparkDb/marketingBookings");
    const utc = lisbonDayRangeUtc(from, to);
    const rows = await readMarketingBookings({ start: utc.start, end: utc.end, parkIds, internalDomains,
      ...(opts.marketplace ? { marketplaceParkIds: mk.third, marketplaceOnlyParkIds: mk.marketplaceOnly } : {}) });
    // 19a: chegar ao teto = dados cortados → erro (antes contava só um pedaço, sem aviso).
    if (rows.length >= MARKETING_BOOKINGS_LIMIT) throw new Error(`Demasiadas reservas no período (mais de ${MARKETING_BOOKINGS_LIMIT.toLocaleString("pt-PT")}): escolhe um período mais curto.`);
    const out = rows.map((r) => toMarketingBooking(r, ctx, opts)).filter((b): b is MarketingBooking => !!b);
    // Com o Marketplace, uma reserva de um parque nosso pode mudar de nó (→ Marketplace da
    // cidade): fica só se o nó final estiver no âmbito/filtro.
    return opts.marketplace ? out.filter((b) => allowed(b.projectId)) : out;
  })();
  bookingsCache.set(key, { at: Date.now(), value });
  value.catch(() => bookingsCache.delete(key));
  if (bookingsCache.size > 50) bookingsCache.delete(bookingsCache.keys().next().value as string);
  return value;
}

const BOOKINGS_TTL_MS = 60_000;
const bookingsCache = new Map<string, { at: number; value: Promise<MarketingBooking[]> }>();
export function resetMarketingBookingsCache(): void { bookingsCache.clear(); }

/** Cliente (por email) no formato do "Canais e clientes": 1.ª reserva codificada. */
export interface MarketingClient { first: string | null; bookings: number; periodBookings: number; value: number }

/** Cliente da Multipark → linha dos canais. PURA. */
export function toMarketingClient(r: MarketingClientRow, aliases: Map<string, string>): MarketingClient {
  const googlePaid = attributionFromUrl(r.firstUrl).adAttribution === "google_paid";
  const campaign = campaignOf({ partnerId: r.firstPartnerId, paymentMethod: r.firstPaymentMethod, partnerName: r.firstPartnerName, discountCode: r.firstDiscountCode, campaignName: r.firstCampaignName }, aliases) ?? "";
  return { first: r.firstAt ? `${r.firstAt}|${r.firstOrigin ?? ""}|${googlePaid ? "1" : "0"}|${campaign}` : null, bookings: r.bookings, periodBookings: r.periodBookings, value: r.value };
}

/** Clientes (email) de todo o histórico dos parques no âmbito, com as reservas do período. */
export async function loadMarketingClients(from: string, to: string, projectIds?: number[] | null): Promise<MarketingClient[]> {
  const { ctx, parkIds, internalDomains } = await scope(projectIds);
  if (!parkIds.length) return [];
  const { readMarketingClients, MARKETING_CLIENTS_LIMIT } = await import("./multiparkDb/marketingBookings");
  const utc = lisbonDayRangeUtc(from, to);
  const rows = await readMarketingClients({ start: utc.start, end: utc.end, parkIds, internalDomains });
  // 19a: o histórico de clientes não pode vir cortado em silêncio (clientes novos e valor por cliente saíam errados).
  if (rows.length >= MARKETING_CLIENTS_LIMIT) throw new Error(`Histórico de clientes maior do que o limite (${MARKETING_CLIENTS_LIMIT.toLocaleString("pt-PT")}): os números de clientes não se conseguem calcular.`);
  return rows.map((r) => toMarketingClient(r, ctx.aliases));
}
