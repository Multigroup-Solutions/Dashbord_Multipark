/**
 * CRM fase 2 (29 set 2026) — "quem é este cliente?" pelas FICHAS do CRM.
 *
 * Substitui o "CRM leve" antigo (server/clientsCrm.ts, agregado da cópia
 * `multipark_bookings` por email): o histórico do cliente nas outras páginas,
 * as ligações automáticas de email/WhatsApp, o Drive, as reuniões e os
 * Contactos passam a encontrar o cliente aqui — emails, telefones (E.164) e
 * matrículas das fichas — e as reservas vêm das ligações reserva → ficha,
 * lidas AO VIVO da Multipark (readCrmBookingFacts).
 *
 * Só fichas ativas. `visible` aplica o âmbito de cidade de quem pede
 * (clientVisibleSql); sem ele (ligações automáticas do sistema) vê tudo.
 */
import { sql, type SQL } from "drizzle-orm";
import { emailKey, phoneKey, plateKey } from "../../shared/crmIdentity";
import { clientVisibleSql } from "./scope";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const inList = (vals: (string | number)[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
const likeOf = (t: string) => `%${t.replace(/[\\%_]/g, (m) => "\\" + m)}%`;

export interface CrmLookupQuery {
  clientId?: number | null;
  email?: string | null;
  phone?: string | null;
  plate?: string | null;
  name?: string | null;
}

/** Quantas fichas, no máximo, contam para um histórico (uma pessoa raramente tem mais). */
export const LOOKUP_MAX_CLIENTS = 5;

/**
 * Condição sobre `c` (crm_clients) para esta pesquisa. PURA.
 * O nome é fraco (há muitas "Ana Silva"): só entra sem email, telefone nem matrícula.
 */
export function lookupCond(q: CrmLookupQuery): SQL | null {
  const parts: SQL[] = [];
  if (q.clientId && Number.isInteger(q.clientId) && q.clientId > 0) parts.push(sql`c.id = ${q.clientId}`);
  const email = emailKey(q.email);
  const phone = phoneKey(q.phone);
  const plate = plateKey(q.plate);
  if (email) parts.push(sql`c.id IN (SELECT ce.clientId FROM crm_client_emails ce WHERE ce.email = ${email})`);
  if (phone) parts.push(sql`c.id IN (SELECT cp.clientId FROM crm_client_phones cp WHERE cp.phone = ${phone})`);
  if (plate) parts.push(sql`c.id IN (SELECT cv.clientId FROM crm_client_vehicles cv WHERE cv.plate = ${plate})`);
  const name = String(q.name ?? "").trim().replace(/\s+/g, " ");
  if (!parts.length && name.length >= 4) parts.push(sql`c.displayName LIKE ${likeOf(name)}`);
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : null;
}

/** Fichas ativas que coincidem (as com mais reservas primeiro). */
export async function findCrmClientIds(db: any, q: CrmLookupQuery, opts: { visible?: boolean; limit?: number } = {}): Promise<number[]> {
  const cond = lookupCond(q);
  if (!cond) return [];
  const scope = opts.visible === false ? sql`1 = 1` : clientVisibleSql(sql`c.id`);
  const rows = rowsOf(await db.execute(sql`SELECT c.id FROM crm_clients c WHERE c.status = 'active' AND ${cond} AND ${scope}
    ORDER BY c.bookings DESC, c.id LIMIT ${opts.limit ?? LOOKUP_MAX_CLIENTS}`));
  return rows.map((r) => Number(r.id));
}

export interface CrmClientCard {
  id: number; name: string | null; email: string | null; phone: string | null;
  bookings: number; upcoming: number; firstVisit: string | null; lastVisit: string | null;
}

const DT = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d %H:%i:%s')`);

/** Resumo de fichas (nome, contactos, contagens) pelos ids. */
export async function crmClientCards(db: any, ids: number[]): Promise<CrmClientCard[]> {
  const list = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))];
  if (!list.length) return [];
  const rows = rowsOf(await db.execute(sql`SELECT c.id, c.displayName, c.primaryEmail, c.primaryPhone, c.bookings, c.upcoming,
      ${DT("c.firstVisit")} AS firstVisit, ${DT("c.lastVisit")} AS lastVisit
    FROM crm_clients c WHERE c.id IN (${inList(list)})`));
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return list.map((id) => byId.get(id)).filter(Boolean).map((r: any) => ({
    id: Number(r.id), name: r.displayName ?? null, email: r.primaryEmail ?? null, phone: r.primaryPhone ?? null,
    bookings: Number(r.bookings ?? 0), upcoming: Number(r.upcoming ?? 0), firstVisit: r.firstVisit ?? null, lastVisit: r.lastVisit ?? null,
  }));
}

/** A ficha (visível) de um email — para o Drive, as reuniões e o âmbito do email. */
export async function crmClientByEmail(db: any, email: string, opts: { visible?: boolean } = {}): Promise<CrmClientCard | null> {
  const ids = await findCrmClientIds(db, { email }, { visible: opts.visible, limit: 1 });
  return (await crmClientCards(db, ids))[0] ?? null;
}

/** Há uma ficha ativa com este email (não genérico)? Ligações automáticas do email (sistema, sem âmbito). */
export async function crmEmailExists(db: any, email: string): Promise<boolean> {
  const e = emailKey(email);
  if (!e) return false;
  return rowsOf(await db.execute(sql`SELECT 1 AS x FROM crm_client_emails ce JOIN crm_clients c ON c.id = ce.clientId
    WHERE ce.email = ${e} AND ce.generic = 0 AND c.status = 'active' LIMIT 1`)).length > 0;
}

/** O email (não genérico) da ficha com este telefone — a mais recente. Sistema, sem âmbito. */
export async function crmEmailByPhone(db: any, phone: string): Promise<string | null> {
  const p = phoneKey(phone);
  if (!p) return null;
  const r = rowsOf(await db.execute(sql`SELECT ce.email FROM crm_client_phones cp
      JOIN crm_clients c ON c.id = cp.clientId AND c.status = 'active'
      JOIN crm_client_emails ce ON ce.clientId = c.id AND ce.generic = 0
    WHERE cp.phone = ${p} ORDER BY c.lastVisit DESC, ce.isPrimary DESC, ce.lastSeenAt DESC LIMIT 1`))[0];
  return r?.email ? String(r.email) : null;
}

/** Ids das reservas (Multipark) ligadas a estas fichas, sem repetir. */
export async function crmBookingIdsOf(db: any, clientIds: number[], limit = 2000): Promise<string[]> {
  const list = [...new Set(clientIds.filter((x) => Number.isInteger(x) && x > 0))];
  if (!list.length) return [];
  const rows = rowsOf(await db.execute(sql`SELECT DISTINCT bookingExternalId FROM crm_booking_links
    WHERE clientId IN (${inList(list)}) LIMIT ${limit}`));
  return rows.map((r) => String(r.bookingExternalId));
}
