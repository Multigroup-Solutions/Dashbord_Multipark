/**
 * CRM fase 3 — parceiros e parques: junta a leitura AO VIVO da BD da
 * Multipark (server/multiparkDb/partners.ts) com o que é só do CRM (nossa BD:
 * crm_partner_links — ligação às Parcerias, notas, contacto) e com as fichas
 * dos clientes que vieram por cada parceiro/parque (crm_booking_links).
 * Euros só para quem vê totais financeiros.
 */
import { sql } from "drizzle-orm";
import {
  monthsAgo, readParkDetail, readParksOverview, readPartnerDetail, readPartnersOverview, totalsOf,
  type MonthTotals, type PartnerOut, type RecentBooking,
} from "../multiparkDb/partners";
import { lisbonMonth, multiparkBookingUrl } from "../../shared/crmPro";
import { nifKey } from "../../shared/crmIdentity";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const inList = (vals: (string | number)[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);

/** `canSeeParcerias`: acesso ao módulo Parcerias (contactos/NIF dos registos de lá). */
type Opts = { cities: string[] | undefined; canSeeTotals: boolean; canSeeParcerias?: boolean };
export type LinkKind = "partner" | "park";
/** partnershipId gravado = 0: "sem ligação" (desliga a ligação automática). */
export const NO_PARTNERSHIP = 0;

/** Ligação às Parcerias: à mão (id), desligada (0) ou automática (null). PURA. */
export function resolvePartnership(p: Pick<PartnerOut, "parks" | "taxNumber">, linkId: number | null | undefined, list: PartnershipRef[]) {
  if (linkId === NO_PARTNERSHIP) return null;
  if (linkId) { const ref = list.find((x) => x.id === linkId); return ref ? { ref, how: "manual" as const } : null; }
  return matchPartnership(p, list);
}

/** Taxas dos parceiros são condições comerciais: só com totais financeiros. */
function hideFees<T extends { feePct?: number | null; feeFixed?: number | null; feeType?: string | null }>(x: T, can: boolean): T {
  return can ? x : { ...x, feePct: null, feeFixed: null, feeType: null };
}

// ─── Parcerias (registo nosso) ──────────────────────────────────────────────

export interface PartnershipRef { id: number; name: string; partnerType: string | null; contactName: string | null; contactEmail: string | null; contactPhone: string | null; nif: string | null; mpPartnerIds: string[] }

async function loadPartnerships(db: any): Promise<PartnershipRef[]> {
  const rows = rowsOf(await db.execute(sql`SELECT id, name, partnerType, contactName, contactEmail, contactPhone, partner_nif AS nif, multiparkPartnerId FROM partnerships`));
  const aliases = rowsOf(await db.execute(sql`SELECT partnershipId, aliasValue FROM partner_aliases WHERE aliasType = 'multipark_partner_id'`));
  const byId = new Map<number, PartnershipRef>(rows.map((r) => [Number(r.id), {
    id: Number(r.id), name: String(r.name), partnerType: r.partnerType ?? null, contactName: r.contactName ?? null,
    contactEmail: r.contactEmail ?? null, contactPhone: r.contactPhone ?? null, nif: r.nif ?? null,
    mpPartnerIds: r.multiparkPartnerId ? [String(r.multiparkPartnerId)] : [],
  }]));
  for (const a of aliases) byId.get(Number(a.partnershipId))?.mpPartnerIds.push(String(a.aliasValue));
  return [...byId.values()];
}

/** Registo nas Parcerias de um parceiro: pelo id da Multipark (ou alias), senão pelo NIF. PURA. */
export function matchPartnership(p: Pick<PartnerOut, "parks" | "taxNumber">, list: PartnershipRef[]): { ref: PartnershipRef; how: "id" | "nif" } | null {
  const ids = new Set(p.parks.map((x) => x.partnerId));
  const byId = list.find((r) => r.mpPartnerIds.some((id) => ids.has(id)));
  if (byId) return { ref: byId, how: "id" };
  const nif = nifKey(p.taxNumber);
  if (nif) {
    const hits = list.filter((r) => nifKey(r.nif) === nif);
    if (hits.length === 1) return { ref: hits[0], how: "nif" };
  }
  return null;
}

async function loadLinks(db: any, kind: LinkKind, ids: string[]) {
  const out = new Map<string, any>();
  if (!ids.length) return out;
  for (const r of rowsOf(await db.execute(sql`SELECT mpId, partnershipId, notes, contactName, contactEmail, contactPhone FROM crm_partner_links
    WHERE kind = ${kind} AND mpId IN (${inList(ids)})`))) out.set(String(r.mpId), r);
  return out;
}

// ─── euros ──────────────────────────────────────────────────────────────────

const money = <T extends Record<string, unknown>>(o: T, keys: (keyof T)[], can: boolean): T => {
  if (can) return o;
  const c: any = { ...o };
  for (const k of keys) c[k] = null;
  return c;
};
const MONTH_MONEY: (keyof MonthTotals)[] = ["value", "commission", "ours", "paid"];
const hideMonth = (m: MonthTotals | Omit<MonthTotals, "month">, can: boolean) => money(m as any, MONTH_MONEY as any, can);
const RECENT_MONEY: (keyof RecentBooking)[] = ["price", "value", "commission", "ours", "paid", "marketplaceCommission", "feeType", "feeValue"];

function periods(now = new Date()) {
  return { thisMonth: lisbonMonth(now)!, from12: monthsAgo(11, now).month };
}

// ─── Parceiros ──────────────────────────────────────────────────────────────

export async function partnersList(db: any, o: Opts & { search?: string | null; type?: string | null }) {
  const r = await readPartnersOverview(o.cities);
  if (!r.available) return { available: false as const, reason: r.reason };
  const { thisMonth, from12 } = periods();
  const t = (o.search ?? "").trim().toLowerCase();
  const list = r.data.partners.filter((p) => (!o.type || p.type === o.type)
    && (!t || [p.name, p.taxName, p.taxNumber].some((x) => String(x ?? "").toLowerCase().includes(t))));
  const partnerships = await loadPartnerships(db);
  const links = await loadLinks(db, "partner", list.map((p) => p.userId));
  const rows = list.map((p) => {
    const months = r.data.months.get(p.userId) ?? [];
    const link = links.get(p.userId);
    const ps = resolvePartnership(p, link?.partnershipId == null ? null : Number(link.partnershipId), partnerships);
    const fees = o.canSeeTotals ? [...new Set(p.parks.map((x) => x.feePct).filter((x): x is number => x != null))].sort((a, b) => a - b) : [];
    // só meses que já começaram (reservas futuras não contam)
    const lastMonth = months.find((m) => m.month <= thisMonth && m.bookings > 0)?.month ?? null;
    return {
      userId: p.userId, name: p.name, type: p.type, active: p.active, taxNumber: p.taxNumber,
      parks: p.parks.map((x) => ({ name: x.parkName, city: x.city, active: x.active })), fees,
      thisMonth: hideMonth(totalsOf(months, thisMonth, thisMonth), o.canSeeTotals),
      last12: hideMonth(totalsOf(months, from12, thisMonth), o.canSeeTotals),
      lastMonth,
      partnership: ps ? { id: ps.ref.id, name: ps.ref.name, how: ps.how } : null,
    };
  });
  // mais reservas nos últimos 12 meses primeiro
  rows.sort((a, b) => (b.last12.bookings ?? 0) - (a.last12.bookings ?? 0) || a.name.localeCompare(b.name, "pt"));
  return { available: true as const, rows, canSeeTotals: o.canSeeTotals, thisMonth };
}

/** Clientes das reservas (fichas do CRM, quando existem). */
async function clientsOf(db: any, recent: RecentBooking[]) {
  const ids = recent.map((b) => b.id);
  const ficha = new Map<string, { id: number; name: string | null }>();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    if (!part.length) continue;
    for (const r of rowsOf(await db.execute(sql`SELECT l.bookingExternalId, c.id, c.displayName FROM crm_booking_links l
      JOIN crm_clients c ON c.id = l.clientId AND c.status = 'active' WHERE l.role = 'traveler' AND l.bookingExternalId IN (${inList(part)})`))) {
      ficha.set(String(r.bookingExternalId), { id: Number(r.id), name: r.displayName ?? null });
    }
  }
  // quem mais veio (pelas últimas reservas)
  const top = new Map<string, { key: string; clientId: number | null; name: string; bookings: number }>();
  for (const b of recent) {
    if (String(b.status ?? "").toUpperCase().includes("CANCEL")) continue;
    const f = ficha.get(b.id);
    const key = f ? `c${f.id}` : `n${(b.clientName ?? "?").toLowerCase()}`;
    const cur = top.get(key) ?? { key, clientId: f?.id ?? null, name: f?.name ?? b.clientName ?? "Sem nome", bookings: 0 };
    cur.bookings++;
    top.set(key, cur);
  }
  return { ficha, top: [...top.values()].sort((a, b) => b.bookings - a.bookings).slice(0, 20) };
}

export async function partnerDetail(db: any, userId: string, o: Opts) {
  const r = await readPartnerDetail(userId, o.cities);
  if (!r.available) return { available: false as const, reason: r.reason };
  if (!r.data) return null;
  const { partner, months, recent } = r.data;
  const { thisMonth, from12 } = periods();
  const partnerships = await loadPartnerships(db);
  const [link] = [...(await loadLinks(db, "partner", [userId])).values()];
  const linkId = link?.partnershipId == null ? null : Number(link.partnershipId);
  const resolved = resolvePartnership(partner, linkId, partnerships);
  const { ficha, top } = await clientsOf(db, recent);
  const parkName = new Map(partner.parks.map((x) => [x.partnerId, x.parkName]));
  return {
    available: true as const,
    partner: { ...partner, parks: partner.parks.map((x) => hideFees(x, o.canSeeTotals)) },
    months: months.map((m) => hideMonth(m, o.canSeeTotals)),
    thisMonth: hideMonth(totalsOf(months, thisMonth, thisMonth), o.canSeeTotals),
    last12: hideMonth(totalsOf(months, from12, thisMonth), o.canSeeTotals),
    recent: recent.map((b) => ({
      ...money(b as any, RECENT_MONEY as any, o.canSeeTotals) as RecentBooking,
      parkName: b.partnerId ? parkName.get(b.partnerId) ?? null : null,
      client: ficha.get(b.id) ?? null,
      multiparkUrl: multiparkBookingUrl(b.id),
    })),
    topClients: top,
    // contactos e NIF do registo das Parcerias só para quem tem acesso às Parcerias
    partnership: resolved ? {
      id: resolved.ref.id, name: resolved.ref.name, how: resolved.how,
      contactName: o.canSeeParcerias ? resolved.ref.contactName : null,
      contactEmail: o.canSeeParcerias ? resolved.ref.contactEmail : null,
      contactPhone: o.canSeeParcerias ? resolved.ref.contactPhone : null,
    } : null,
    /** "sem ligação" escolhido à mão */
    partnershipOff: linkId === NO_PARTNERSHIP,
    partnerships: o.canSeeParcerias ? partnerships.map((x) => ({ id: x.id, name: x.name })).sort((a, b) => a.name.localeCompare(b.name, "pt")) : [],
    link: link ? { notes: link.notes ?? null, contactName: link.contactName ?? null, contactEmail: link.contactEmail ?? null, contactPhone: link.contactPhone ?? null } : null,
    canSeeTotals: o.canSeeTotals,
  };
}

// ─── Parques em que somos o agregador ──────────────────────────────────────

export async function parksList(db: any, o: Opts & { search?: string | null }) {
  const r = await readParksOverview(o.cities);
  if (!r.available) return { available: false as const, reason: r.reason };
  const { thisMonth, from12 } = periods();
  const t = (o.search ?? "").trim().toLowerCase();
  const list = r.data.parks.filter((p) => !t || [p.name, p.companyName, p.city, p.email, p.nif].some((x) => String(x ?? "").toLowerCase().includes(t)));
  const links = await loadLinks(db, "park", list.map((p) => p.id));
  const rows = list.map((p) => {
    const months = r.data.months.get(p.id) ?? [];
    return {
      id: p.id, name: p.name, companyName: p.companyName, city: p.city, country: p.country, status: p.status, listingType: p.listingType,
      email: p.email, phone: p.phone,
      thisMonth: hideMonth(totalsOf(months, thisMonth, thisMonth), o.canSeeTotals),
      last12: hideMonth(totalsOf(months, from12, thisMonth), o.canSeeTotals),
      lastMonth: months.find((m) => m.month <= thisMonth && m.bookings > 0)?.month ?? null,
      hasNotes: !!links.get(p.id)?.notes,
    };
  });
  rows.sort((a, b) => (b.last12.bookings ?? 0) - (a.last12.bookings ?? 0) || a.name.localeCompare(b.name, "pt"));
  return { available: true as const, rows, canSeeTotals: o.canSeeTotals, thisMonth };
}

export async function parkDetail(db: any, parkId: string, o: Opts) {
  const r = await readParkDetail(parkId, o.cities);
  if (!r.available) return { available: false as const, reason: r.reason };
  if (!r.data) return null;
  const { park, months, recent } = r.data;
  const { thisMonth, from12 } = periods();
  const [link] = [...(await loadLinks(db, "park", [parkId])).values()];
  const { ficha, top } = await clientsOf(db, recent);
  return {
    available: true as const,
    park,
    months: months.map((m) => hideMonth(m, o.canSeeTotals)),
    thisMonth: hideMonth(totalsOf(months, thisMonth, thisMonth), o.canSeeTotals),
    last12: hideMonth(totalsOf(months, from12, thisMonth), o.canSeeTotals),
    recent: recent.map((b) => ({ ...money(b as any, RECENT_MONEY as any, o.canSeeTotals) as RecentBooking, client: ficha.get(b.id) ?? null, multiparkUrl: multiparkBookingUrl(b.id) })),
    topClients: top,
    link: link ? { notes: link.notes ?? null, contactName: link.contactName ?? null, contactEmail: link.contactEmail ?? null, contactPhone: link.contactPhone ?? null } : null,
    canSeeTotals: o.canSeeTotals,
  };
}

// ─── Notas, contacto e ligação às Parcerias (só nossa BD) ──────────────────

export async function saveLink(db: any, userId: number, o: {
  kind: LinkKind; mpId: string; partnershipId?: number | null; notes?: string | null;
  contactName?: string | null; contactEmail?: string | null; contactPhone?: string | null;
}) {
  const t = (s: string | null | undefined, n: number) => (s == null ? null : s.trim() ? s.trim().slice(0, n) : null);
  // partnershipId não enviado (sem acesso às Parcerias) → a ligação fica como está
  const keepPartnership = o.partnershipId === undefined;
  await db.execute(sql`INSERT INTO crm_partner_links (kind, mpId, partnershipId, notes, contactName, contactEmail, contactPhone, updatedBy)
    VALUES (${o.kind}, ${o.mpId}, ${o.partnershipId ?? null}, ${t(o.notes, 10_000)}, ${t(o.contactName, 255)}, ${t(o.contactEmail, 320)}, ${t(o.contactPhone, 40)}, ${userId})
    ON DUPLICATE KEY UPDATE partnershipId = ${keepPartnership ? sql`partnershipId` : sql`VALUES(partnershipId)`}, notes = VALUES(notes), contactName = VALUES(contactName),
      contactEmail = VALUES(contactEmail), contactPhone = VALUES(contactPhone), updatedBy = VALUES(updatedBy)`);
  const { logActivity } = await import("../db");
  await logActivity({ userId, action: `crm_${o.kind}_link`, entity: `crm_${o.kind}`, details: JSON.stringify({ mpId: o.mpId, partnershipId: o.partnershipId ?? null }) } as any);
}
