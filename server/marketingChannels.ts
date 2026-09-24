/**
 * Marketing → Canais e clientes (Jorge, 24 set 2026).
 *
 *  1. De onde vêm as reservas: por canal (Google Ads, parceiros, campanhas,
 *     marketplace, site, telefone), com o custo de cada canal — gasto do
 *     Google Ads (API) e comissões dos parceiros (mapa campanha → parceria,
 *     o mesmo da Faturação). Reservas pela data de criação, sem canceladas.
 *  2. Ligação ao CRM (email = cliente): canal de ENTRADA de cada cliente =
 *     canal da sua primeira reserva. Daí: clientes novos por canal no
 *     período, custo por cliente novo, peso dos clientes repetentes e quanto
 *     vale (historicamente) um cliente de cada canal.
 *
 * Tudo com âmbito de cidade (`projectScope`) e filtro de projeto, como o resto.
 * Emails da casa ficam de fora (INTERNAL_EMAIL_DOMAINS do CRM).
 */
import { sql, type SQL } from "drizzle-orm";
import { projectScope, scopedProjectIds } from "./cityScope";
import { INTERNAL_EMAIL_DOMAINS, VISITED_STATUSES } from "./clientsCrm";
import { CHANNEL_LABEL, CHANNEL_ORDER, channelOf, parseFirstBooking, type ChannelKey } from "../shared/marketingChannels";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const CACHE_TTL_MS = 5 * 60 * 1000;

function rows<T = any>(r: any): T[] {
  return (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as T[];
}

export interface PartnerLite { id: number; name: string; commissionRate: number }

export interface ChannelRow {
  key: ChannelKey; label: string;
  bookings: number; revenue: number;
  /** custo conhecido do canal (gasto Google Ads / comissões); null = sem custo registado */
  cost: number | null;
  costPerBooking: number | null;
  newClients: number;
  costPerNewClient: number | null;
}

export interface ValueByChannel {
  key: ChannelKey; label: string;
  clients: number;
  avgBookings: number;
  /** % de clientes com 2+ reservas */
  repeatRate: number;
  /** valor médio realizado por cliente (reservas em que o carro entrou no parque) */
  avgValue: number;
}

export interface ChannelsResult {
  range: { from: string; to: string };
  channels: ChannelRow[];
  partners: Array<{ name: string; bookings: number; revenue: number; commissionRate: number; commission: number }>;
  bookingsTotal: number;
  /** reservas do período sem email (não dá para as ligar a um cliente) */
  bookingsWithoutEmail: number;
  newClients: number;
  /** reservas do período feitas por clientes que já tinham reservado antes */
  returningBookings: number;
  valueByChannel: ValueByChannel[];
}

// ─── Regras puras (testáveis) ────────────────────────────────────────────────
export interface MixRow { origin: string | null; googlePaid: boolean; campaign: string | null; bookings: number; revenue: number; withEmail: number }
export interface ClientRowAgg { first: string | null; bookings: number; periodBookings: number; value: number }

export function buildChannels(
  mix: MixRow[],
  clients: ClientRowAgg[],
  range: { from: string; to: string },
  adSpend: number,
  partnerFor: (campaign: string) => PartnerLite | undefined,
): ChannelsResult {
  const hasPartner = (c: string) => !!partnerFor(c);
  const agg = new Map<ChannelKey, ChannelRow>(CHANNEL_ORDER.map((k) => [k, { key: k, label: CHANNEL_LABEL[k], bookings: 0, revenue: 0, cost: null, costPerBooking: null, newClients: 0, costPerNewClient: null }]));
  const partners = new Map<string, ChannelsResult["partners"][number]>();
  let bookingsTotal = 0, withEmail = 0;
  for (const m of mix) {
    const key = channelOf(m, hasPartner);
    const row = agg.get(key)!;
    row.bookings += m.bookings; row.revenue += m.revenue;
    bookingsTotal += m.bookings; withEmail += m.withEmail;
    const p = key === "parceiro" && m.campaign ? partnerFor(m.campaign.trim()) : undefined;
    if (p) {
      const commission = m.revenue * (p.commissionRate / 100);
      row.cost = (row.cost ?? 0) + commission;
      const ex = partners.get(p.name) ?? { name: p.name, bookings: 0, revenue: 0, commissionRate: p.commissionRate, commission: 0 };
      ex.bookings += m.bookings; ex.revenue += m.revenue; ex.commission += commission;
      partners.set(p.name, ex);
    }
  }
  agg.get("google_ads")!.cost = adSpend > 0 ? adSpend : agg.get("google_ads")!.cost;

  const fromAt = `${range.from} 00:00:00`, toAt = `${range.to} 23:59:59`;
  const value = new Map<ChannelKey, { clients: number; bookings: number; repeat: number; value: number }>();
  let newClients = 0, returningBookings = 0;
  for (const c of clients) {
    const first = parseFirstBooking(c.first);
    if (!first) continue;
    const key = channelOf(first, hasPartner);
    const v = value.get(key) ?? { clients: 0, bookings: 0, repeat: 0, value: 0 };
    v.clients++; v.bookings += c.bookings; v.value += c.value; if (c.bookings >= 2) v.repeat++;
    value.set(key, v);
    if (first.at >= fromAt && first.at <= toAt) {
      newClients++;
      agg.get(key)!.newClients++;
      returningBookings += Math.max(0, c.periodBookings - 1);   // a 1.ª é a de entrada; as outras já são de repetente
    } else if (first.at < fromAt) {
      returningBookings += c.periodBookings;
    }
  }

  const channels = [...agg.values()].map((r) => ({
    ...r,
    costPerBooking: r.cost != null && r.bookings > 0 ? r.cost / r.bookings : null,
    costPerNewClient: r.cost != null && r.newClients > 0 ? r.cost / r.newClients : null,
  }));
  const valueByChannel = CHANNEL_ORDER.filter((k) => value.has(k)).map((k) => {
    const v = value.get(k)!;
    return { key: k, label: CHANNEL_LABEL[k], clients: v.clients, avgBookings: v.bookings / v.clients, repeatRate: v.repeat / v.clients, avgValue: v.value / v.clients };
  });
  return {
    range, channels,
    partners: [...partners.values()].sort((a, b) => b.bookings - a.bookings),
    bookingsTotal, bookingsWithoutEmail: bookingsTotal - withEmail,
    newClients, returningBookings, valueByChannel,
  };
}

// ─── Queries ─────────────────────────────────────────────────────────────────
function scopeWhere(projectIds?: number[] | null): SQL {
  const proj = projectIds && projectIds.length
    ? sql` AND b.projectId IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})`
    : projectIds && !projectIds.length ? sql` AND 1 = 0` : sql``;
  return sql`${projectScope(sql`b.projectId`)}${proj}`;
}
const NOT_CANCELLED = sql`UPPER(COALESCE(b.status, '')) NOT LIKE '%CANCEL%'`;
const HAS_EMAIL = sql`(b.clientEmail LIKE '%@%' AND SUBSTRING_INDEX(LOWER(TRIM(b.clientEmail)), '@', -1) NOT IN (${sql.join(INTERNAL_EMAIL_DOMAINS.map((d) => sql`${d}`), sql`, `)}))`;
const VISITED = sql`UPPER(COALESCE(b.status, '')) IN (${sql.join(VISITED_STATUSES.map((v) => sql`${v}`), sql`, `)})`;

export function mixSql(from: string, to: string, projectIds?: number[] | null): SQL {
  return sql`
    SELECT b.origin AS origin, (b.adAttribution = 'google_paid') AS googlePaid, NULLIF(TRIM(b.campaign), '') AS campaign,
           COUNT(*) AS bookings, COALESCE(SUM(b.totalPrice), 0) AS revenue, SUM(${HAS_EMAIL}) AS withEmail
    FROM multipark_bookings b
    WHERE ${NOT_CANCELLED} AND b.bookingCreatedAt BETWEEN ${`${from} 00:00:00`} AND ${`${to} 23:59:59`} AND ${scopeWhere(projectIds)}
    GROUP BY b.origin, (b.adAttribution = 'google_paid'), NULLIF(TRIM(b.campaign), '')`;
}

/** Um registo por cliente (email): a 1.ª reserva codificada, totais e reservas do período. */
export function clientsSql(from: string, to: string, projectIds?: number[] | null): SQL {
  return sql`
    SELECT LOWER(TRIM(b.clientEmail)) AS email,
           MIN(CONCAT(DATE_FORMAT(b.bookingCreatedAt, '%Y-%m-%d %H:%i:%s'), '|', COALESCE(b.origin, ''), '|',
                      IF(b.adAttribution = 'google_paid', '1', '0'), '|', COALESCE(TRIM(b.campaign), ''))) AS first,
           COUNT(*) AS bookings,
           SUM(b.bookingCreatedAt BETWEEN ${`${from} 00:00:00`} AND ${`${to} 23:59:59`}) AS periodBookings,
           COALESCE(SUM(CASE WHEN ${VISITED} THEN b.totalPrice END), 0) AS value
    FROM multipark_bookings b
    WHERE ${NOT_CANCELLED} AND b.bookingCreatedAt IS NOT NULL AND ${HAS_EMAIL} AND ${scopeWhere(projectIds)}
    GROUP BY LOWER(TRIM(b.clientEmail))`;
}

const cache = new Map<string, { at: number; value: ChannelsResult }>();
export function invalidateChannelsCache(): void { cache.clear(); }

export async function getChannels(db: any, f: { from: string; to: string; projectIds?: number[] | null; adSpend: number }): Promise<ChannelsResult> {
  if (!ISO.test(f.from) || !ISO.test(f.to)) throw new Error("Datas inválidas (AAAA-MM-DD)");
  const key = JSON.stringify({ s: scopedProjectIds() ?? "all", p: f.projectIds ?? null, from: f.from, to: f.to, spend: f.adSpend });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const { buildPartnerByCampaignMap } = await import("./db");
  const [mixRaw, clientsRaw, partnerMap] = await Promise.all([
    db.execute(mixSql(f.from, f.to, f.projectIds)),
    db.execute(clientsSql(f.from, f.to, f.projectIds)),
    buildPartnerByCampaignMap(),
  ]);
  const mix: MixRow[] = rows(mixRaw).map((r) => ({
    origin: r.origin ?? null, googlePaid: Number(r.googlePaid ?? 0) === 1, campaign: r.campaign ?? null,
    bookings: Number(r.bookings ?? 0), revenue: Number(r.revenue ?? 0), withEmail: Number(r.withEmail ?? 0),
  }));
  const clients: ClientRowAgg[] = rows(clientsRaw).map((r) => ({
    first: r.first ?? null, bookings: Number(r.bookings ?? 0), periodBookings: Number(r.periodBookings ?? 0), value: Number(r.value ?? 0),
  }));
  const partnerFor = (c: string): PartnerLite | undefined => {
    const p = partnerMap.get(c.trim().toLowerCase());
    return p ? { id: p.id, name: p.name, commissionRate: Number(p.commissionRate ?? 0) } : undefined;
  };
  const value = buildChannels(mix, clients, { from: f.from, to: f.to }, f.adSpend, partnerFor);
  cache.set(key, { at: Date.now(), value });
  return value;
}
