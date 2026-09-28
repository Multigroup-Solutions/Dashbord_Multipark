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
 */
import { attributionFromUrl, type AdAttribution } from "./integrations/googleAds/attribution";
import { campaignOf, loadLiveContext, type LiveContext } from "./finance/liveBookings";
import { lisbonDayRangeUtc } from "../shared/lisbonDay";
import type { MarketingBookingRow, MarketingClientRow } from "./multiparkDb/marketingBookings";

export interface MarketingBooking {
  id: string;
  /** UTC "YYYY-MM-DD HH:MM:SS" */
  createdAt: string;
  /** dia de Lisboa da criação */
  day: string;
  projectId: number | null;
  status: string | null;
  origin: string | null;
  hasOriginUrl: boolean;
  /** gclid / gbraid / wbraid no link */
  hasClickId: boolean;
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
}

/** Reserva da Multipark → reserva do marketing. PURA. */
export function toMarketingBooking(r: MarketingBookingRow, ctx: LiveContext): MarketingBooking | null {
  if (!ctx.ourParks.has(r.parkId)) return null;
  const a = attributionFromUrl(r.originUrl);
  return {
    id: r.id, createdAt: r.createdAt, day: r.day, projectId: ctx.ourParks.get(r.parkId) ?? null, status: r.status, origin: r.origin,
    hasOriginUrl: !!r.originUrl, hasClickId: !!(a.gclid || a.gbraid || a.wbraid),
    adAttribution: a.adAttribution, adCampaignExternalId: a.adCampaignExternalId, utmCampaign: a.utmCampaign,
    campaign: campaignOf(r, ctx.aliases), campaignName: r.campaignName, total: r.total, hasEmail: r.hasEmail, newClient: r.newClient,
  };
}

/** Parques a ler: os nossos, cortados pelo âmbito do utilizador e pelo filtro de centro. PURA. */
export function parksFor(ctx: LiveContext, projectIds?: number[] | null, scoped?: number[] | undefined): string[] {
  const allowed = (pid: number | null) => {
    if (scoped && (pid == null || !scoped.includes(pid))) return false;
    if (projectIds && (pid == null || !projectIds.includes(pid))) return false;
    return true;
  };
  return [...ctx.ourParks.entries()].filter(([, pid]) => allowed(pid)).map(([id]) => id);
}

async function scope(projectIds?: number[] | null) {
  const [ctx, { scopedProjectIds }, { INTERNAL_EMAIL_DOMAINS }] = await Promise.all([
    loadLiveContext(), import("./cityScope"), import("./clientsCrm"),
  ]);
  return { ctx, parkIds: parksFor(ctx, projectIds, scopedProjectIds()), internalDomains: INTERNAL_EMAIL_DOMAINS };
}

/**
 * Reservas criadas nos dias de Lisboa [from, to] (sem canceladas), dos nossos
 * parques, já com centro, atribuição e campanha. Lança se a BD da Multipark
 * não responder.
 */
export async function loadMarketingBookings(from: string, to: string, projectIds?: number[] | null): Promise<MarketingBooking[]> {
  const { ctx, parkIds, internalDomains } = await scope(projectIds);
  if (!parkIds.length) return [];
  // A mesma página pede isto várias vezes (estatísticas, marcas, ROAS, canais, alertas):
  // uma consulta por período × parques a cada minuto (a promessa é partilhada).
  const key = JSON.stringify([from, to, [...parkIds].sort()]);
  const hit = bookingsCache.get(key);
  if (hit && Date.now() - hit.at < BOOKINGS_TTL_MS) return hit.value;
  const value = (async () => {
    const { readMarketingBookings } = await import("./multiparkDb/marketingBookings");
    const utc = lisbonDayRangeUtc(from, to);
    const rows = await readMarketingBookings({ start: utc.start, end: utc.end, parkIds, internalDomains });
    return rows.map((r) => toMarketingBooking(r, ctx)).filter((b): b is MarketingBooking => !!b);
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
  const { readMarketingClients } = await import("./multiparkDb/marketingBookings");
  const utc = lisbonDayRangeUtc(from, to);
  const rows = await readMarketingClients({ start: utc.start, end: utc.end, parkIds, internalDomains });
  return rows.map((r) => toMarketingClient(r, ctx.aliases));
}
