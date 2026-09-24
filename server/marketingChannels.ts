/**
 * Marketing → Canais e clientes (Jorge, 24 set 2026).
 *
 *  1. De onde vêm as reservas. Canais próprios (Marketplace, site das marcas,
 *     telefone): reserva de CLIENTE NOVO (1.ª do email, ou sem email) =
 *     "Anúncios Google" (custo = gasto do Google Ads); de quem JÁ ERA cliente
 *     = "Orgânico". Parceiros (custo = comissões, mapa campanha → parceria da
 *     Faturação), campanhas sem parceiro e outros à parte. O gclid é só prova
 *     de clique. Reservas pela data de criação, sem canceladas.
 *  2. Ligação ao CRM (email = cliente): canal de ENTRADA de cada cliente =
 *     canal da sua primeira reserva. Daí: clientes novos por canal no
 *     período, custo por cliente novo, peso dos clientes repetentes e quanto
 *     vale (historicamente) um cliente de cada canal.
 *
 * Tudo com âmbito de cidade (`projectScope`) e filtro de projeto, como o resto.
 * Cancelada e dia = as MESMAS regras das Reservas & Operações (24 set 2026):
 * `status = 'CANCELLED'` e dias de Lisboa sobre `bookingCreatedAt` em UTC.
 * Emails da casa ficam de fora (INTERNAL_EMAIL_DOMAINS do CRM).
 */
import { sql, type SQL } from "drizzle-orm";
import { projectScope, scopedProjectIds } from "./cityScope";
import { INTERNAL_EMAIL_DOMAINS, VISITED_STATUSES } from "./clientsCrm";
import { lisbonDayRangeUtc } from "../shared/lisbonDay";
import { CANCELLED_STATUS } from "../shared/marketingRules";
import { CHANNEL_LABEL, CHANNEL_ORDER, GROUP_LABEL, GROUP_ORDER, channelOf, groupOf, parseFirstBooking, type ChannelGroup, type ChannelKey } from "../shared/marketingChannels";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const CACHE_TTL_MS = 5 * 60 * 1000;

function rows<T = any>(r: any): T[] {
  return (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as T[];
}

export interface PartnerLite { id: number; name: string; commissionRate: number }

export interface ChannelRow {
  key: ChannelKey; label: string; group: ChannelGroup;
  bookings: number; revenue: number;
  /** reservas com prova de clique pago (gclid/utm) — só informação, não decide o canal */
  paidProof: number;
  newClients: number;
}

export interface GroupRow {
  key: ChannelGroup; label: string;
  bookings: number; revenue: number; newClients: number; paidProof: number;
  /** custo do grupo: gasto Google Ads (anúncios) ou comissões (parceiros); null = sem custo registado */
  cost: number | null;
  costPerBooking: number | null;
  costPerNewClient: number | null;
  channels: ChannelRow[];
}

export interface ValueByChannel {
  key: ChannelKey; label: string; group: ChannelGroup;
  clients: number;
  avgBookings: number;
  /** % de clientes com 2+ reservas */
  repeatRate: number;
  /** valor médio realizado por cliente (reservas em que o carro entrou no parque) */
  avgValue: number;
}

export interface ChannelsResult {
  range: { from: string; to: string };
  groups: GroupRow[];
  partners: Array<{ name: string; bookings: number; revenue: number; commissionRate: number; commission: number }>;
  bookingsTotal: number;
  /** gasto Google Ads do período (custo do grupo "anúncios") */
  adSpend: number;
  /** conversões que a Google conta no período */
  googleConversions: number;
  /** reservas do período sem email (não dá para as ligar a um cliente) */
  bookingsWithoutEmail: number;
  newClients: number;
  /** reservas do período feitas por clientes que já tinham reservado antes */
  returningBookings: number;
  valueByChannel: ValueByChannel[];
}

// ─── Regras puras (testáveis) ────────────────────────────────────────────────
export interface MixRow { origin: string | null; googlePaid: boolean; campaign: string | null; bookings: number; revenue: number; withEmail: number; /** 1.ª reserva do email (ou sem email) */ newClient: boolean }
export interface ClientRowAgg { first: string | null; bookings: number; periodBookings: number; value: number }

export function buildChannels(
  mix: MixRow[],
  clients: ClientRowAgg[],
  range: { from: string; to: string },
  adSpend: number,
  partnerFor: (campaign: string) => PartnerLite | undefined,
): ChannelsResult {
  const hasPartner = (c: string) => !!partnerFor(c);
  const rows = new Map<string, ChannelRow>();
  const rowFor = (k: ChannelKey, g: ChannelGroup) => {
    const id = `${g}:${k}`;
    let r = rows.get(id);
    if (!r) { r = { key: k, label: CHANNEL_LABEL[k], group: g, bookings: 0, revenue: 0, paidProof: 0, newClients: 0 }; rows.set(id, r); }
    return r;
  };
  const partners = new Map<string, ChannelsResult["partners"][number]>();
  let bookingsTotal = 0, withEmail = 0, commissions = 0;
  for (const m of mix) {
    const key = channelOf(m, hasPartner);
    const row = rowFor(key, groupOf(key, m.newClient));
    row.bookings += m.bookings; row.revenue += m.revenue;
    if (m.googlePaid) row.paidProof += m.bookings;
    bookingsTotal += m.bookings; withEmail += m.withEmail;
    const p = key === "parceiro" && m.campaign ? partnerFor(m.campaign.trim()) : undefined;
    if (p) {
      const commission = m.revenue * (p.commissionRate / 100);
      commissions += commission;
      const ex = partners.get(p.name) ?? { name: p.name, bookings: 0, revenue: 0, commissionRate: p.commissionRate, commission: 0 };
      ex.bookings += m.bookings; ex.revenue += m.revenue; ex.commission += commission;
      partners.set(p.name, ex);
    }
  }

  // `first.at` está em UTC (como a coluna): compara-se com o intervalo UTC dos dias de Lisboa
  const utc = lisbonDayRangeUtc(range.from, range.to);
  const fromAt = utc.start, endAt = utc.end;
  const value = new Map<ChannelKey, { clients: number; bookings: number; repeat: number; value: number }>();
  let newClients = 0, returningBookings = 0;
  for (const c of clients) {
    const first = parseFirstBooking(c.first);
    if (!first) continue;
    const key = channelOf(first, hasPartner);
    const v = value.get(key) ?? { clients: 0, bookings: 0, repeat: 0, value: 0 };
    v.clients++; v.bookings += c.bookings; v.value += c.value; if (c.bookings >= 2) v.repeat++;
    value.set(key, v);
    if (first.at >= fromAt && first.at < endAt) {
      newClients++;
      rowFor(key, groupOf(key, true)).newClients++;
      returningBookings += Math.max(0, c.periodBookings - 1);   // a 1.ª é a de entrada; as outras já são de repetente
    } else if (first.at < fromAt) {
      returningBookings += c.periodBookings;
    }
  }

  const groupCost: Record<ChannelGroup, number | null> = {
    anuncios: adSpend > 0 ? adSpend : null,
    organico: null,   // quem volta por si não tem custo de aquisição
    parceiros: partners.size ? commissions : null,
    campanhas: null,
    outros: null,
  };
  const groups: GroupRow[] = GROUP_ORDER.map((g) => {
    const chs = CHANNEL_ORDER.map((k) => rows.get(`${g}:${k}`)).filter((r): r is ChannelRow => !!r);
    const bookings = chs.reduce((t, r) => t + r.bookings, 0);
    const nc = chs.reduce((t, r) => t + r.newClients, 0);
    const cost = groupCost[g];
    return {
      key: g, label: GROUP_LABEL[g], channels: chs,
      bookings, revenue: chs.reduce((t, r) => t + r.revenue, 0), newClients: nc, paidProof: chs.reduce((t, r) => t + r.paidProof, 0),
      cost,
      costPerBooking: cost != null && bookings > 0 ? cost / bookings : null,
      costPerNewClient: cost != null && nc > 0 ? cost / nc : null,
    };
  });
  const valueByChannel = CHANNEL_ORDER.filter((k) => value.has(k)).map((k) => {
    const v = value.get(k)!;
    return { key: k, label: CHANNEL_LABEL[k], group: groupOf(k, true), clients: v.clients, avgBookings: v.bookings / v.clients, repeatRate: v.repeat / v.clients, avgValue: v.value / v.clients };
  });
  return {
    range, groups, adSpend, googleConversions: 0,
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
const NOT_CANCELLED = sql`COALESCE(b.status, '') <> ${CANCELLED_STATUS}`;
const inPeriod = (from: string, to: string) => { const r = lisbonDayRangeUtc(from, to); return sql`(b.bookingCreatedAt >= ${r.start} AND b.bookingCreatedAt < ${r.end})`; };
const HAS_EMAIL = sql`(b.clientEmail LIKE '%@%' AND SUBSTRING_INDEX(LOWER(TRIM(b.clientEmail)), '@', -1) NOT IN (${sql.join(INTERNAL_EMAIL_DOMAINS.map((d) => sql`${d}`), sql`, `)}))`;
const VISITED = sql`UPPER(COALESCE(b.status, '')) IN (${sql.join(VISITED_STATUSES.map((v) => sql`${v}`), sql`, `)})`;

/**
 * Reservas do período por canal e se são de cliente NOVO: a 1.ª reserva não
 * cancelada daquele email em TODA a base (um cliente de Lisboa que reserva no
 * Porto já é cliente) — o derivado só dá a data da 1.ª reserva por email, não
 * expõe dados de outras cidades. Sem email = não se sabe se é cliente → novo.
 */
export function mixSql(from: string, to: string, projectIds?: number[] | null): SQL {
  // Agrupa-se por COLUNAS de um derivado (e não por expressões com parâmetros),
  // para o ONLY_FULL_GROUP_BY do MySQL aceitar.
  return sql`
    SELECT t.origin, t.googlePaid, t.campaign, t.newClient,
           COUNT(*) AS bookings, COALESCE(SUM(t.totalPrice), 0) AS revenue, SUM(t.hasEmail) AS withEmail
    FROM (
      SELECT b.origin AS origin, (b.adAttribution = 'google_paid') AS googlePaid, NULLIF(TRIM(b.campaign), '') AS campaign,
             (CASE WHEN NOT ${HAS_EMAIL} OR fb.firstAt IS NULL OR b.bookingCreatedAt <= fb.firstAt THEN 1 ELSE 0 END) AS newClient,
             b.totalPrice AS totalPrice, (CASE WHEN ${HAS_EMAIL} THEN 1 ELSE 0 END) AS hasEmail
      FROM multipark_bookings b
      LEFT JOIN (
        SELECT LOWER(TRIM(x.clientEmail)) AS email, MIN(x.bookingCreatedAt) AS firstAt
        FROM multipark_bookings x
        WHERE x.clientEmail LIKE '%@%' AND x.bookingCreatedAt IS NOT NULL AND COALESCE(x.status, '') <> ${CANCELLED_STATUS}
        GROUP BY LOWER(TRIM(x.clientEmail))
      ) fb ON fb.email = LOWER(TRIM(b.clientEmail))
      WHERE ${NOT_CANCELLED} AND ${inPeriod(from, to)} AND ${scopeWhere(projectIds)}
    ) t
    GROUP BY t.origin, t.googlePaid, t.campaign, t.newClient`;
}

/** Um registo por cliente (email): a 1.ª reserva codificada, totais e reservas do período. */
export function clientsSql(from: string, to: string, projectIds?: number[] | null): SQL {
  return sql`
    SELECT LOWER(TRIM(b.clientEmail)) AS email,
           MIN(CONCAT(DATE_FORMAT(b.bookingCreatedAt, '%Y-%m-%d %H:%i:%s'), '|', COALESCE(b.origin, ''), '|',
                      IF(b.adAttribution = 'google_paid', '1', '0'), '|', COALESCE(TRIM(b.campaign), ''))) AS first,
           COUNT(*) AS bookings,
           SUM(${inPeriod(from, to)}) AS periodBookings,
           COALESCE(SUM(CASE WHEN ${VISITED} THEN b.totalPrice END), 0) AS value
    FROM multipark_bookings b
    WHERE ${NOT_CANCELLED} AND b.bookingCreatedAt IS NOT NULL AND ${HAS_EMAIL} AND ${scopeWhere(projectIds)}
    GROUP BY LOWER(TRIM(b.clientEmail))`;
}

const cache = new Map<string, { at: number; value: ChannelsResult }>();
export function invalidateChannelsCache(): void { cache.clear(); }

export async function getChannels(db: any, f: { from: string; to: string; projectIds?: number[] | null; adSpend: number; adConversions?: number }): Promise<ChannelsResult> {
  if (!ISO.test(f.from) || !ISO.test(f.to)) throw new Error("Datas inválidas (AAAA-MM-DD)");
  const key = JSON.stringify({ s: scopedProjectIds() ?? "all", p: f.projectIds ?? null, from: f.from, to: f.to, spend: f.adSpend, conv: f.adConversions ?? 0 });
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
    newClient: Number(r.newClient ?? 1) === 1,
  }));
  const clients: ClientRowAgg[] = rows(clientsRaw).map((r) => ({
    first: r.first ?? null, bookings: Number(r.bookings ?? 0), periodBookings: Number(r.periodBookings ?? 0), value: Number(r.value ?? 0),
  }));
  const partnerFor = (c: string): PartnerLite | undefined => {
    const p = partnerMap.get(c.trim().toLowerCase());
    return p ? { id: p.id, name: p.name, commissionRate: Number(p.commissionRate ?? 0) } : undefined;
  };
  const value = { ...buildChannels(mix, clients, { from: f.from, to: f.to }, f.adSpend, partnerFor), googleConversions: f.adConversions ?? 0 };
  cache.set(key, { at: Date.now(), value });
  return value;
}
