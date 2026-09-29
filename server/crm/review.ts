/**
 * CRM — ecrã "Rever fichas": sugestões para juntar (com as duas fichas lado a
 * lado), fusões recentes (para separar), emails estranhos e reservas próximas
 * de clientes sem email (pedir o email antes de o cliente se ir embora).
 */
import { sql, type SQL } from "drizzle-orm";
import { projectScope } from "../cityScope";
import { REASON_LABELS, type SuggestionReason } from "../../shared/crmIdentity";
import { clientVisibleSql } from "./scope";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const inList = (vals: (string | number)[]) => sql.join(vals.map((v) => sql`${v}`), sql`, `);
const DT = (c: string) => sql.raw(`DATE_FORMAT(${c}, '%Y-%m-%d %H:%i:%s')`);

/** Só fichas que o utilizador vê (server/crm/scope.ts). */
const clientInScope = (col: string) => clientVisibleSql(sql.raw(col));

/** Contagens dos separadores de "Rever fichas" (no âmbito de quem pede). */
export async function reviewCounts(db: any) {
  const [row] = rowsOf(await db.execute(sql`SELECT
    (SELECT COUNT(*) FROM crm_merge_suggestions s WHERE s.status = 'pending' AND ${clientInScope("s.clientA")} AND ${clientInScope("s.clientB")}) AS suggestions,
    (SELECT COUNT(*) FROM crm_clients c WHERE c.status = 'active' AND c.genericEmailOnly = 1 AND ${clientInScope("c.id")}) AS generic,
    (SELECT COUNT(DISTINCT c.id) FROM crm_clients c JOIN crm_booking_links l ON l.clientId = c.id JOIN multipark_bookings b ON b.externalId = l.bookingExternalId
      WHERE c.status = 'active' AND c.noEmail = 1 AND b.checkIn >= UTC_TIMESTAMP() AND b.checkIn < DATE_ADD(UTC_TIMESTAMP(), INTERVAL 3 DAY)
        AND UPPER(COALESCE(b.status, '')) NOT LIKE '%CANCEL%' AND ${projectScope(sql`b.projectId`)}) AS noEmail`));
  return { suggestions: Number(row?.suggestions ?? 0), generic: Number(row?.generic ?? 0), noEmail: Number(row?.noEmail ?? 0) };
}

async function sidesFor(db: any, ids: number[]) {
  const out = new Map<number, any>();
  if (!ids.length) return out;
  for (const c of rowsOf(await db.execute(sql`SELECT id, displayName, nif, bookings, ${DT("lastVisit")} AS lastVisit, originChannel, originPartnerName, photoUrl
    FROM crm_clients WHERE id IN (${inList(ids)})`))) {
    out.set(Number(c.id), { id: Number(c.id), name: c.displayName ?? null, nif: c.nif ?? null, bookings: Number(c.bookings), lastVisit: c.lastVisit ?? null, origin: c.originPartnerName || c.originChannel || null, photoUrl: c.photoUrl ?? null, emails: [] as string[], phones: [] as string[], vehicles: [] as string[] });
  }
  for (const e of rowsOf(await db.execute(sql`SELECT clientId, email FROM crm_client_emails WHERE clientId IN (${inList(ids)}) ORDER BY isPrimary DESC`))) out.get(Number(e.clientId))?.emails.push(String(e.email));
  for (const p of rowsOf(await db.execute(sql`SELECT clientId, phone FROM crm_client_phones WHERE clientId IN (${inList(ids)}) ORDER BY isPrimary DESC`))) out.get(Number(p.clientId))?.phones.push(String(p.phone));
  for (const v of rowsOf(await db.execute(sql`SELECT clientId, plateDisplay, plate, brand, model, color FROM crm_client_vehicles WHERE clientId IN (${inList(ids)}) ORDER BY bookings DESC`))) {
    out.get(Number(v.clientId))?.vehicles.push([v.plateDisplay || v.plate, [v.brand, v.model].filter(Boolean).join(" "), v.color].filter(Boolean).join(" · "));
  }
  return out;
}

export async function listSuggestions(db: any, o: { offset?: number; limit?: number; minScore?: number }) {
  const limit = Math.max(1, Math.min(50, o.limit ?? 10));
  const offset = Math.max(0, o.offset ?? 0);
  const min = Math.max(0, o.minScore ?? 0);
  // as DUAS fichas visíveis (a comparação mostra emails, telefones e matrículas de ambas)
  const where = sql`s.status = 'pending' AND s.score >= ${min} AND ${clientInScope("s.clientA")} AND ${clientInScope("s.clientB")}`;
  const [cnt] = rowsOf(await db.execute(sql`SELECT COUNT(*) AS n FROM crm_merge_suggestions s WHERE ${where}`));
  const rows = rowsOf(await db.execute(sql`SELECT s.id, s.clientA, s.clientB, s.score, s.reasons FROM crm_merge_suggestions s
    WHERE ${where} ORDER BY s.score DESC, s.id LIMIT ${sql.raw(String(limit))} OFFSET ${sql.raw(String(offset))}`));
  const sides = await sidesFor(db, [...new Set(rows.flatMap((r) => [Number(r.clientA), Number(r.clientB)]))]);
  return {
    total: Number(cnt?.n ?? 0),
    rows: rows.map((r) => {
      const a = sides.get(Number(r.clientA)), b = sides.get(Number(r.clientB));
      // fica a ficha com mais reservas (o utilizador pode trocar)
      const [keep, absorb] = (a?.bookings ?? 0) >= (b?.bookings ?? 0) ? [a, b] : [b, a];
      const reasons = String(r.reasons).split(",").filter(Boolean) as SuggestionReason[];
      return { id: Number(r.id), score: Number(r.score), reasons: reasons.map((x) => ({ id: x, label: REASON_LABELS[x] ?? x })), keep, absorb };
    }),
  };
}

export async function recentMerges(db: any, o: { limit?: number }) {
  const rows = rowsOf(await db.execute(sql`SELECT e.id, e.survivorId, e.mergedId, ${DT("e.mergedAt")} AS mergedAt, e.reason, u.name AS byName,
      s.displayName AS survivorName, m.displayName AS mergedName
    FROM crm_merge_events e LEFT JOIN users u ON u.id = e.mergedBy
    LEFT JOIN crm_clients s ON s.id = e.survivorId LEFT JOIN crm_clients m ON m.id = e.mergedId
    WHERE e.undoneAt IS NULL AND ${clientInScope("e.survivorId")}
    ORDER BY e.mergedAt DESC LIMIT ${sql.raw(String(Math.max(1, Math.min(100, o.limit ?? 30))))}`));
  return rows.map((r) => ({ id: Number(r.id), survivorId: Number(r.survivorId), mergedId: Number(r.mergedId), survivorName: r.survivorName ?? null, mergedName: r.mergedName ?? null, mergedAt: r.mergedAt, reason: r.reason ?? null, byName: r.byName ?? null }));
}

/** Fichas cujo único email é de balcão/agregador (email estranho). */
export async function genericEmailClients(db: any, o: { limit?: number; offset?: number }) {
  const limit = Math.max(1, Math.min(100, o.limit ?? 30));
  const where = sql`c.status = 'active' AND c.genericEmailOnly = 1 AND ${clientInScope("c.id")}`;
  const [cnt] = rowsOf(await db.execute(sql`SELECT COUNT(*) AS n FROM crm_clients c WHERE ${where}`));
  const rows = rowsOf(await db.execute(sql`SELECT c.id, c.displayName, c.primaryPhone, ${DT("c.lastVisit")} AS lastVisit, c.bookings,
      (SELECT e.email FROM crm_client_emails e WHERE e.clientId = c.id AND e.generic = 1 ORDER BY e.lastSeenAt DESC LIMIT 1) AS genericEmail,
      (SELECT CONCAT(v.plateDisplay, '') FROM crm_client_vehicles v WHERE v.clientId = c.id ORDER BY v.bookings DESC LIMIT 1) AS plate
    FROM crm_clients c WHERE ${where} ORDER BY c.lastVisit IS NULL, c.lastVisit DESC
    LIMIT ${sql.raw(String(limit))} OFFSET ${sql.raw(String(Math.max(0, o.offset ?? 0)))}`));
  return { total: Number(cnt?.n ?? 0), rows: rows.map((r) => ({ id: Number(r.id), name: r.displayName ?? null, phone: r.primaryPhone ?? null, plate: r.plate ?? null, genericEmail: r.genericEmail ?? null, lastVisit: r.lastVisit ?? null, bookings: Number(r.bookings) })) };
}

/**
 * Procura na nossa caixa de email (Comunicação) mensagens deste cliente, pelo
 * nome, matrícula ou n.º das reservas, e propõe o email verdadeiro.
 * `visible` = condição sobre `mail_threads t` das conversas que quem pede pode
 * ver (mail/inbox.ts visibleThreadsCondition — o super admin vê todas).
 */
export async function findEmailInMailbox(db: any, clientId: number, visible: SQL = sql`1 = 1`) {
  const [c] = rowsOf(await db.execute(sql`SELECT displayName FROM crm_clients WHERE id = ${clientId}`));
  if (!c) return [];
  const plates = rowsOf(await db.execute(sql`SELECT plateDisplay, plate FROM crm_client_vehicles WHERE clientId = ${clientId}`)).map((v) => String(v.plateDisplay || v.plate));
  const numbers = rowsOf(await db.execute(sql`SELECT b.bookingNumber FROM crm_booking_links l JOIN multipark_bookings b ON b.externalId = l.bookingExternalId
    WHERE l.clientId = ${clientId} AND b.bookingNumber IS NOT NULL LIMIT 20`)).map((b) => String(b.bookingNumber));
  const generic = new Set(rowsOf(await db.execute(sql`SELECT email FROM crm_client_emails WHERE generic = 1 AND clientId = ${clientId}`)).map((e) => String(e.email)));
  const terms: any[] = [];
  const name = String(c.displayName ?? "").trim();
  const like = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  if (name.split(/\s+/).length >= 2) terms.push(sql`m.fromName LIKE ${like(name)}`);
  for (const p of plates) terms.push(sql`(m.subject LIKE ${like(p)} OR m.snippet LIKE ${like(p)})`);
  for (const n of numbers) terms.push(sql`(m.subject LIKE ${like(n)} OR m.snippet LIKE ${like(n)})`);
  if (!terms.length) return [];
  try {
    const rows = rowsOf(await db.execute(sql`SELECT LOWER(TRIM(m.fromEmail)) AS email, MAX(m.fromName) AS fromName, COUNT(*) AS n,
        DATE_FORMAT(MAX(m.sentAt), '%Y-%m-%d %H:%i:%s') AS lastAt, MAX(m.subject) AS subject
      FROM mail_messages m JOIN mail_threads t ON t.id = m.threadId
      WHERE (${sql.join(terms, sql` OR `)}) AND m.fromEmail IS NOT NULL AND ${visible}
      GROUP BY LOWER(TRIM(m.fromEmail)) ORDER BY n DESC LIMIT 5`));
    return rows.filter((r) => r.email && !generic.has(String(r.email))).map((r) => ({ email: String(r.email), fromName: r.fromName ?? null, messages: Number(r.n), lastAt: r.lastAt ?? null, subject: r.subject ?? null }));
  } catch {
    return [];
  }
}

/** Reservas nos próximos dias de clientes sem email: pedir o email à chegada. */
export async function upcomingWithoutEmail(db: any, o: { days?: number }) {
  const days = Math.max(1, Math.min(14, o.days ?? 3));
  const rows = rowsOf(await db.execute(sql`SELECT c.id, c.displayName, c.primaryPhone, b.externalId, b.bookingNumber, ${DT("b.checkIn")} AS checkIn, b.parkName, b.licensePlate
    FROM crm_clients c JOIN crm_booking_links l ON l.clientId = c.id AND l.role = 'traveler'
    JOIN multipark_bookings b ON b.externalId = l.bookingExternalId
    WHERE c.status = 'active' AND c.noEmail = 1 AND b.checkIn >= UTC_TIMESTAMP() AND b.checkIn < DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${days} DAY)
      AND UPPER(COALESCE(b.status, '')) NOT LIKE '%CANCEL%' AND ${projectScope(sql`b.projectId`)}
    ORDER BY b.checkIn LIMIT 200`));
  return rows.map((r) => ({ id: Number(r.id), name: r.displayName ?? null, phone: r.primaryPhone ?? null, bookingId: String(r.externalId), bookingNumber: r.bookingNumber ?? null, checkIn: r.checkIn, park: r.parkName ?? null, plate: r.licensePlate ?? null }));
}
