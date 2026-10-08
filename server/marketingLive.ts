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
 * Marketplace"; 8 out: "têm que aparecer TODAS as reservas feitas no
 * marketplace, seja de que parque for"), com `{ marketplace: true }` (o
 * separador Anúncios, os totais, os Canais e clientes, o ROAS por campanha e
 * os alertas): entram TODAS as reservas dos parques de TERCEIROS e as dos
 * nossos parques que vieram pelo multipark.pt (origin MARKETPLACE) — a regra
 * única (shared/marketplace.ts isMarketplaceBooking) — no nó "Marketplace
 * <cidade>", onde estão as campanhas "Multipark - <Cidade> - PT". Um parque de
 * terceiros sem cidade reconhecida (ou cuja cidade não tem nó Marketplace)
 * ENTRA na mesma, sem centro ("Marketplace (sem cidade)"), e a página avisa
 * (unplacedMarketplaceParks). Cada reserva diz se é do Marketplace e se o
 * parque é operado por nós (etiqueta da comissão). A receita, a Caixa e o CRM
 * não mudam.
 */
import { attributionFromUrl, type AdAttribution } from "./integrations/googleAds/attribution";
import { campaignOf, loadLiveContext, type LiveContext } from "./finance/liveBookings";
import { lisbonDayRangeUtc } from "../shared/lisbonDay";
import { classifyBookingChannel, marketplaceOperated } from "../shared/multiparkParks";
import { isMarketplaceBooking, MARKETPLACE_ORIGIN } from "../shared/marketplace";
import { isViaNet, marketingValueOf, thirdParkRates, viaNetExclusion, type ViaNetExclusion } from "../shared/viaNet";
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
   * 8 out 2026: sem as pendentes, as de clientes Pro e as de avenças
   * (shared/viaNet.ts).
   */
  viaNet: boolean;
  /** Não é parceiro mas não conta como via net: pendente, Pro ou avença (null = conta, ou é parceiro). */
  viaNetOut?: ViaNetExclusion | null;
  /** O parque é nosso (Airpark/Redpark/Skypark). */
  parkOurs?: boolean;
  /**
   * 8 out 2026: valor para o Marketing (valor via net, ligadas, ROAS): o preço
   * inteiro nos parques nossos; a NOSSA comissão nos de terceiros (shared/viaNet.ts).
   */
  value?: number;
  /** Parque de terceiros sem comissão gravada nem taxa do parque no período (valor 0). */
  commissionMissing?: boolean;
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
  /**
   * Reserva do Marketplace — a regra única (parque de terceiros, ou nosso com
   * origem MARKETPLACE). Sempre preenchido; só com `{ marketplace: true }` é
   * que muda o nó (→ "Marketplace <cidade>") e entram os parques de terceiros.
   */
  marketplace: boolean;
  /** Parque operado por nós (os nossos sempre; os de terceiros fora da lista do dono e das Definições). Sempre preenchido. */
  operated: boolean;
  /** Comissão gravada nos parques de terceiros (null = sem valor na Multipark) — só com `{ marketplace: true }`. */
  commission?: number | null;
}

export interface MarketingLoadOptions {
  /** Também as reservas do Marketplace (todas as dos parques de terceiros), no nó "Marketplace <cidade>". */
  marketplace?: boolean;
}

/** Reserva da Multipark → reserva do marketing. PURA. */
export function toMarketingBooking(r: MarketingBookingRow, ctx: LiveContext, opts: MarketingLoadOptions = {}): MarketingBooking | null {
  const own = ctx.ourParks.has(r.parkId);
  const third = !own && !!opts.marketplace && !!ctx.marketplaceParks?.has(r.parkId);
  if (!own && !third) return null;
  const marketplace = isMarketplaceBooking({ parkOurs: own, origin: r.origin });
  const viaMarketplace = !!opts.marketplace && marketplace;
  let projectId = own ? ctx.ourParks.get(r.parkId) ?? null : ctx.marketplaceParks!.get(r.parkId) ?? null;
  if (own && viaMarketplace) {
    const city = ctx.parkCity?.get(r.parkId);
    const node = city ? ctx.marketplaceNodeByCity?.get(city) : undefined;
    if (node != null) projectId = node;
  }
  const a = attributionFromUrl(r.originUrl);
  const channel = classifyBookingChannel({ parkOurs: own, origin: r.origin, paymentSource: r.paymentSource ?? null, partnerId: r.partnerId, partnerName: r.partnerName }).channel;
  const exclusion = viaNetExclusion({ status: r.status, pro: r.pro, plan: r.plan });
  // valor de UMA reserva; a taxa dos parques de terceiros sem comissão gravada aplica-se na lista (loadMarketingBookings)
  const v = marketingValueOf({ parkId: r.parkId, parkOurs: own, total: r.total, commission: third ? r.commission ?? null : null }, new Map());
  return {
    id: r.id, createdAt: r.createdAt, day: r.day, projectId, parkId: r.parkId, status: r.status, origin: r.origin,
    hasPartner: !!(r.partnerId || (r.partnerName && !/unknown/i.test(r.partnerName))),
    viaNet: isViaNet(channel, exclusion),
    viaNetOut: channel !== "parceiro" ? exclusion : null,
    parkOurs: own,
    value: v.value, commissionMissing: v.commissionMissing,
    marketplace,
    operated: own || (ctx.marketplaceParkInfo?.get(r.parkId)?.operated ?? marketplaceOperated({ id: r.parkId, ours: false })),
    ...(opts.marketplace ? { commission: third ? r.commission ?? null : null } : {}),
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
 * Marketplace no âmbito: parques de terceiros cujo nó passa (`third`; os sem
 * nó — "Marketplace (sem cidade)" — só para quem vê tudo, sem filtro de
 * centro, como qualquer reserva sem centro) e parques nossos que não passam
 * pelo centro deles mas cujo nó Marketplace da cidade passa (`marketplaceOnly`:
 * só as reservas vindas pelo Marketplace). PURA.
 */
export function marketplaceParksFor(ctx: LiveContext, projectIds?: number[] | null, scoped?: number[] | undefined): { third: string[]; marketplaceOnly: string[] } {
  const allowed = allowedBy(projectIds, scoped);
  const third = [...(ctx.marketplaceParks ?? new Map<string, number | null>()).entries()].filter(([, pid]) => allowed(pid)).map(([id]) => id);
  const marketplaceOnly = [...ctx.ourParks.entries()].filter(([id, pid]) => {
    if (allowed(pid)) return false;
    const city = ctx.parkCity?.get(id);
    const node = city ? ctx.marketplaceNodeByCity?.get(city) : undefined;
    return node != null && allowed(node);
  }).map(([id]) => id);
  return { third, marketplaceOnly };
}

/** Parque de terceiros sem nó Marketplace (sem cidade reconhecida ou cidade sem nó) — para o aviso. */
export interface UnplacedMarketplacePark { id: string; name: string; city: string | null; operated: boolean }

/**
 * Parques de terceiros que entram como "Marketplace (sem cidade)": a página
 * mostra-os (nome + cidade gravada) para se corrigir a cidade na Multipark ou
 * criar o nó "Marketplace" da cidade. PURA.
 */
export function unplacedMarketplaceParks(ctx: LiveContext): UnplacedMarketplacePark[] {
  const out: UnplacedMarketplacePark[] = [];
  for (const [id, pid] of ctx.marketplaceParks ?? []) {
    if (pid != null) continue;
    const info = ctx.marketplaceParkInfo?.get(id);
    out.push({ id, name: info?.name ?? id, city: info?.city ?? null, operated: info?.operated ?? true });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "pt"));
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
    const mapped = rows.map((r) => toMarketingBooking(r, ctx, opts)).filter((b): b is MarketingBooking => !!b);
    // 8 out 2026: parque de terceiros sem comissão gravada → a taxa do parque no período (Parcerias/Faturação)
    const inputs = mapped.map((b) => ({ parkId: b.parkId, parkOurs: !!b.parkOurs, total: b.total, commission: b.commission ?? null }));
    const rates = thirdParkRates(inputs);
    const out = mapped.map((b, i) => {
      if (!b.commissionMissing) return b;
      const v = marketingValueOf(inputs[i], rates);
      return { ...b, value: v.value, commissionMissing: v.commissionMissing };
    });
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

/**
 * Cliente da Multipark → linha dos canais. A 1.ª reserva que for do
 * Marketplace (regra única — num parque de terceiros, seja qual for a origem)
 * entra com a origem MARKETPLACE, para o canal de entrada ser o Marketplace.
 * PURA.
 */
export function toMarketingClient(r: MarketingClientRow, aliases: Map<string, string>, ctx?: Pick<LiveContext, "ourParks">): MarketingClient {
  const googlePaid = attributionFromUrl(r.firstUrl).adAttribution === "google_paid";
  const campaign = campaignOf({ partnerId: r.firstPartnerId, paymentMethod: r.firstPaymentMethod, partnerName: r.firstPartnerName, discountCode: r.firstDiscountCode, campaignName: r.firstCampaignName }, aliases) ?? "";
  const viaMarketplace = !!ctx && !!r.firstParkId && isMarketplaceBooking({ parkOurs: ctx.ourParks.has(r.firstParkId), origin: r.firstOrigin });
  const origin = viaMarketplace ? MARKETPLACE_ORIGIN : r.firstOrigin ?? "";
  return { first: r.firstAt ? `${r.firstAt}|${origin}|${googlePaid ? "1" : "0"}|${campaign}` : null, bookings: r.bookings, periodBookings: r.periodBookings, value: r.value };
}

/**
 * Clientes (email) de todo o histórico dos parques no âmbito, com as reservas
 * do período. Com `{ marketplace: true }` (8 out 2026), também os do
 * Marketplace — as mesmas reservas que loadMarketingBookings.
 */
export async function loadMarketingClients(from: string, to: string, projectIds?: number[] | null, opts: MarketingLoadOptions = {}): Promise<MarketingClient[]> {
  const { ctx, parkIds, internalDomains, scoped } = await scope(projectIds);
  const mk = opts.marketplace ? marketplaceParksFor(ctx, projectIds, scoped) : { third: [], marketplaceOnly: [] };
  if (!parkIds.length && !mk.third.length && !mk.marketplaceOnly.length) return [];
  const { readMarketingClients, MARKETING_CLIENTS_LIMIT } = await import("./multiparkDb/marketingBookings");
  const utc = lisbonDayRangeUtc(from, to);
  const rows = await readMarketingClients({ start: utc.start, end: utc.end, parkIds, internalDomains,
    ...(opts.marketplace ? { marketplaceParkIds: mk.third, marketplaceOnlyParkIds: mk.marketplaceOnly } : {}) });
  // 19a: o histórico de clientes não pode vir cortado em silêncio (clientes novos e valor por cliente saíam errados).
  if (rows.length >= MARKETING_CLIENTS_LIMIT) throw new Error(`Histórico de clientes maior do que o limite (${MARKETING_CLIENTS_LIMIT.toLocaleString("pt-PT")}): os números de clientes não se conseguem calcular.`);
  return rows.map((r) => toMarketingClient(r, ctx.aliases, ctx));
}

/** Parques de terceiros no "Marketplace (sem cidade)" visíveis a quem pede (âmbito + filtro). */
export async function loadUnplacedMarketplaceParks(projectIds?: number[] | null): Promise<UnplacedMarketplacePark[]> {
  const { ctx, allowed } = await scope(projectIds);
  return allowed(null) ? unplacedMarketplaceParks(ctx) : [];
}

/** Reservas do Marketplace no período, separadas por "operado por nós / não operado" e as sem cidade. */
export interface MarketplaceSummary {
  bookings: number;
  revenue: number;
  operated: { bookings: number; revenue: number };
  notOperated: { bookings: number; revenue: number };
  /** "Marketplace (sem cidade)": parques de terceiros sem nó Marketplace (não entram em nenhuma cidade). */
  withoutCity: { bookings: number; revenue: number };
}

/** Resumo das reservas do Marketplace (regra única) de uma lista do Marketing. PURA. */
export function summarizeMarketplace(bookings: ReadonlyArray<Pick<MarketingBooking, "marketplace" | "operated" | "projectId" | "total">>): MarketplaceSummary {
  const z = () => ({ bookings: 0, revenue: 0 });
  const out: MarketplaceSummary = { bookings: 0, revenue: 0, operated: z(), notOperated: z(), withoutCity: z() };
  const add = (t: { bookings: number; revenue: number }, v: number) => { t.bookings++; t.revenue = Math.round((t.revenue + v) * 100) / 100; };
  for (const b of bookings) {
    if (!b.marketplace) continue;
    out.bookings++; out.revenue = Math.round((out.revenue + b.total) * 100) / 100;
    add(b.operated ? out.operated : out.notOperated, b.total);
    if (b.projectId == null) add(out.withoutCity, b.total);
  }
  return out;
}
