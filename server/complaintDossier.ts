/**
 * Dossier automático das reclamações:
 *  - matching reclamação → reserva Multipark por ref/matrícula/email/telefone/
 *    nome, ancorado na DATA da reclamação (a reserva "da queixa", não a mais
 *    recente do cliente)
 *  - dossier da reserva (detalhe + extras da cópia local; histórico ao vivo da
 *    BD da Multipark, com a cópia antiga como recurso) — sem chamadas à API
 */

import { and, desc, eq, or, sql } from "drizzle-orm";
import { getDb, updateComplaint, updateLostFoundItem } from "./db";
import {
  complaints,
  lostFoundItems,
  multiparkBookingExtras,
  multiparkBookingHistory,
  multiparkBookings,
} from "../drizzle/schema";

const normPlate = (p: string) => p.replace(/[\s-]/g, "").toUpperCase();
const phoneDigits = (p: string) => p.replace(/\D/g, "");

/** Últimos 9 dígitos do telefone (ignora +351/espaços/hífens). */
function phoneKey(p?: string | null): string | null {
  if (!p) return null;
  const d = phoneDigits(p);
  return d.length >= 9 ? d.slice(-9) : null;
}

export interface BookingMatchSignals {
  reservationRef?: string | null;
  vehiclePlate?: string | null;
  clientEmail?: string | null;
  clientPhone?: string | null;
  clientName?: string | null;
  /** Data da reclamação/email — âncora temporal do match. */
  anchorDate?: Date | string | null;
}

export interface BookingMatch {
  booking: typeof multiparkBookings.$inferSelect;
  matchedBy: string[];
  score: number;
}

/**
 * Encontra a reserva de que o cliente se está a queixar. Ref exata ganha
 * sempre; sem ref, pontua sinais (matrícula > email > telefone > nome) e
 * favorece reservas cuja janela [checkIn-3d, checkOut+14d] cobre a data da
 * reclamação — evita apanhar uma reserva futura já marcada.
 */
export async function matchBookingForComplaint(
  s: BookingMatchSignals,
): Promise<BookingMatch | null> {
  const db = await getDb();
  if (!db) return null;

  // 1) Referência explícita (externalId ou nº de reserva) — match direto.
  const ref = s.reservationRef?.trim();
  if (ref) {
    const rows = await db
      .select()
      .from(multiparkBookings)
      .where(or(eq(multiparkBookings.externalId, ref), eq(multiparkBookings.bookingNumber, ref)))
      .limit(1);
    if (rows[0]) return { booking: rows[0], matchedBy: ["ref"], score: 100 };
  }

  const conds: any[] = [];
  const plate = s.vehiclePlate ? normPlate(s.vehiclePlate) : null;
  if (plate) conds.push(eq(multiparkBookings.licensePlate, plate));
  const email = s.clientEmail?.trim().toLowerCase() || null;
  if (email) conds.push(sql`LOWER(${multiparkBookings.clientEmail}) = ${email}`);
  const phone = phoneKey(s.clientPhone);
  if (phone) {
    conds.push(
      sql`RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${multiparkBookings.clientPhone}, ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), 9) = ${phone}`,
    );
  }
  const name = s.clientName?.trim();
  const nameOk = name && name.length >= 6 && !/desconhecido/i.test(name);
  if (nameOk) {
    conds.push(sql`CONCAT_WS(' ', ${multiparkBookings.clientFirstName}, ${multiparkBookings.clientLastName}) = ${name}`);
  }
  if (!conds.length) return null;

  const candidates = await db
    .select()
    .from(multiparkBookings)
    .where(or(...conds))
    .orderBy(desc(multiparkBookings.checkIn))
    .limit(25);
  if (!candidates.length) return null;

  const anchor = s.anchorDate ? new Date(s.anchorDate) : new Date();
  const anchorMs = isNaN(anchor.getTime()) ? Date.now() : anchor.getTime();
  const DAY = 86_400_000;

  let best: BookingMatch | null = null;
  for (const b of candidates) {
    const matchedBy: string[] = [];
    let score = 0;
    if (plate && b.licensePlate && normPlate(b.licensePlate) === plate) {
      score += 40; matchedBy.push("matricula");
    }
    if (email && b.clientEmail && b.clientEmail.toLowerCase() === email) {
      score += 30; matchedBy.push("email");
    }
    if (phone && b.clientPhone && phoneKey(b.clientPhone) === phone) {
      score += 25; matchedBy.push("telefone");
    }
    if (nameOk && `${b.clientFirstName ?? ""} ${b.clientLastName ?? ""}`.trim() === name) {
      score += 10; matchedBy.push("nome");
    }
    if (!matchedBy.length) continue;

    // Âncora temporal: a queixa costuma chegar durante/logo após a estadia.
    const inMs = b.checkIn ? new Date(String(b.checkIn).replace(" ", "T") + "Z").getTime() : NaN;
    const outMs = b.checkOut ? new Date(String(b.checkOut).replace(" ", "T") + "Z").getTime() : inMs;
    if (!isNaN(inMs)) {
      const start = inMs - 3 * DAY;
      const end = (isNaN(outMs) ? inMs : outMs) + 14 * DAY;
      if (anchorMs >= start && anchorMs <= end) {
        score += 30; matchedBy.push("janela");
      } else if (anchorMs > end && anchorMs - end <= 60 * DAY) {
        score += 15; // estadia recente
      } else if (inMs > anchorMs + 30 * DAY) {
        score -= 10; // reserva futura distante — provavelmente não é esta
      }
    }
    if (!best || score > best.score) best = { booking: b, matchedBy, score };
  }
  // Exige pelo menos um sinal forte ou combinação (>= 30).
  return best && best.score >= 30 ? best : null;
}

/**
 * Liga (ou re-liga) a reserva a uma reclamação existente e completa os campos
 * em falta a partir dela (matrícula, contactos, datas, projeto). Devolve o que
 * ligou; null se não houver match.
 */
export async function autoLinkComplaintBooking(complaintId: number): Promise<{
  linked: boolean;
  alreadyLinked: boolean;
  matchedBy: string[];
  booking: { externalId: string; bookingNumber: string | null; parkName: string | null } | null;
}> {
  const db = await getDb();
  if (!db) return { linked: false, alreadyLinked: false, matchedBy: [], booking: null };

  const rows = await db.select().from(complaints).where(eq(complaints.id, complaintId)).limit(1);
  const c = rows[0];
  if (!c) return { linked: false, alreadyLinked: false, matchedBy: [], booking: null };

  // Ref já válida? (aponta a uma reserva real) — mesmo assim completa os
  // campos em falta a partir dela.
  let booking: typeof multiparkBookings.$inferSelect | null = null;
  let matchedBy: string[] = [];
  let alreadyLinked = false;
  if (c.reservationRef) {
    const existing = await db
      .select()
      .from(multiparkBookings)
      .where(or(eq(multiparkBookings.externalId, c.reservationRef), eq(multiparkBookings.bookingNumber, c.reservationRef)))
      .limit(1);
    if (existing[0]) {
      booking = existing[0];
      matchedBy = ["ref"];
      alreadyLinked = true;
    }
  }

  if (!booking) {
    const match = await matchBookingForComplaint({
      reservationRef: c.reservationRef,
      vehiclePlate: c.vehiclePlate,
      clientEmail: c.clientEmail,
      clientPhone: c.clientPhone,
      clientName: c.clientName,
      anchorDate: c.createdAt,
    });
    if (!match) return { linked: false, alreadyLinked: false, matchedBy: [], booking: null };
    booking = match.booking;
    matchedBy = match.matchedBy;
  }

  const b = booking;
  const patch: Record<string, unknown> = {};
  if (!alreadyLinked) patch.reservationRef = b.externalId;
  if (!c.vehiclePlate && b.licensePlate) patch.vehiclePlate = b.licensePlate;
  if (!c.clientEmail && b.clientEmail) patch.clientEmail = b.clientEmail;
  if (!c.clientPhone && b.clientPhone) patch.clientPhone = b.clientPhone;
  if ((!c.clientName || /desconhecido/i.test(c.clientName)) && (b.clientFirstName || b.clientLastName)) {
    patch.clientName = `${b.clientFirstName ?? ""} ${b.clientLastName ?? ""}`.trim();
  }
  if (!c.reservationStart && b.checkIn) patch.reservationStart = b.checkIn;
  if (!c.reservationEnd && b.checkOut) patch.reservationEnd = b.checkOut;
  if (!c.projectId && b.projectId) patch.projectId = b.projectId;
  if (Object.keys(patch).length) await updateComplaint(complaintId, patch as any);

  return {
    linked: true,
    alreadyLinked,
    matchedBy,
    booking: { externalId: b.externalId, bookingNumber: b.bookingNumber, parkName: b.parkName },
  };
}

/**
 * O mesmo auto-link para os Perdidos & Achados: liga a reserva ao caso e
 * completa campos em falta a partir dela.
 */
export async function autoLinkLostFoundBooking(itemId: number): Promise<{
  linked: boolean;
  alreadyLinked: boolean;
  matchedBy: string[];
  booking: { externalId: string; bookingNumber: string | null; parkName: string | null } | null;
}> {
  const db = await getDb();
  if (!db) return { linked: false, alreadyLinked: false, matchedBy: [], booking: null };

  const rows = await db.select().from(lostFoundItems).where(eq(lostFoundItems.id, itemId)).limit(1);
  const item = rows[0];
  if (!item) return { linked: false, alreadyLinked: false, matchedBy: [], booking: null };

  let booking: typeof multiparkBookings.$inferSelect | null = null;
  let matchedBy: string[] = [];
  let alreadyLinked = false;
  if (item.bookingRef) {
    const existing = await db
      .select()
      .from(multiparkBookings)
      .where(or(eq(multiparkBookings.externalId, item.bookingRef), eq(multiparkBookings.bookingNumber, item.bookingRef)))
      .limit(1);
    if (existing[0]) {
      booking = existing[0];
      matchedBy = ["ref"];
      alreadyLinked = true;
    }
  }

  if (!booking) {
    const match = await matchBookingForComplaint({
      reservationRef: item.bookingRef,
      vehiclePlate: item.vehiclePlate,
      clientEmail: item.clientEmail,
      clientPhone: item.clientPhone,
      clientName: item.clientName,
      anchorDate: item.createdAt,
    });
    if (!match) return { linked: false, alreadyLinked: false, matchedBy: [], booking: null };
    booking = match.booking;
    matchedBy = match.matchedBy;
  }

  const b = booking;
  const patch: Record<string, unknown> = {};
  if (!alreadyLinked) patch.bookingRef = b.externalId;
  if (!item.vehiclePlate && b.licensePlate) patch.vehiclePlate = b.licensePlate;
  if (!item.clientEmail && b.clientEmail) patch.clientEmail = b.clientEmail;
  if (!item.clientPhone && b.clientPhone) patch.clientPhone = b.clientPhone;
  if ((!item.clientName || /desconhecido/i.test(item.clientName)) && (b.clientFirstName || b.clientLastName)) {
    patch.clientName = `${b.clientFirstName ?? ""} ${b.clientLastName ?? ""}`.trim();
  }
  if (!item.projectId && b.projectId) patch.projectId = b.projectId;
  if (Object.keys(patch).length) await updateLostFoundItem(itemId, patch as any);

  return {
    linked: true,
    alreadyLinked,
    matchedBy,
    booking: { externalId: b.externalId, bookingNumber: b.bookingNumber, parkName: b.parkName },
  };
}

/** Linha do histórico no formato que as páginas Reclamações/Perdidos leem. */
export interface BookingTimelineItem {
  id: string;
  changeType: string | null;
  actionTime: string | null;
  remarks: string | null;
  agentName: string | null;
  userId: string | null;
  modifiedFields: string | null;
  platform: string | null;
}

/**
 * Histórico de uma reserva para Reclamações/Perdidos: AO VIVO da BD da
 * Multipark (History; ref = id ou n.º da reserva). Sem BD 2, ou sem nada lá
 * (reservas anteriores a 2 mar 2026 só têm o retrato da migração), usa a
 * cópia antiga `multipark_booking_history` (só leitura — já não é
 * atualizada). Nunca vai à API da Multipark.
 */
export async function getBookingTimeline(ref: string, cities?: string[]): Promise<{ bookingId: string; total: number; history: BookingTimelineItem[] }> {
  try {
    const { resolveBookingRef, getBookingFileTimeline, formatChange } = await import("./multiparkDb/bookingFile");
    const resolved = await resolveBookingRef(ref, cities);
    if (resolved.available && resolved.data.kind === "found") {
      const t = await getBookingFileTimeline(resolved.data.id, cities);
      const entries = t.available ? t.data.entries.filter((e) => e.source === "history") : [];
      if (entries.length) {
        const history = entries.map((e) => ({
          id: e.id, changeType: e.kind, actionTime: e.at, remarks: e.remarks, agentName: e.who, userId: null,
          modifiedFields: e.changes.length ? e.changes.map(formatChange).join("; ") : null, platform: e.platform,
        }));
        return { bookingId: ref, total: history.length, history };
      }
    }
  } catch { /* BD da Multipark indisponível: usa a cópia antiga */ }
  const d = await getComplaintBookingDossier(ref);
  const history = d.history.map((h) => ({
    id: h.historyId, changeType: h.changeType, actionTime: h.actionTime, remarks: h.remarks,
    agentName: h.agentName, userId: h.agentUserId, modifiedFields: h.modifiedFields, platform: h.platform,
  }));
  return { bookingId: ref, total: history.length, history };
}

/**
 * Dossier completo de uma reserva para o detalhe da reclamação: detalhe da
 * reserva + extras itemizados (cópia financeira local, alimentada pelo
 * webhook) + histórico antigo de condutores (`multipark_booking_history`, já
 * não atualizado). A ficha completa e atual está em /reserva/:id (BD 2).
 */
export async function getComplaintBookingDossier(reservationRef: string): Promise<{
  booking: typeof multiparkBookings.$inferSelect | null;
  extras: Array<{ name: string | null; description: string | null; price: string | null; done: number | null }>;
  history: Array<typeof multiparkBookingHistory.$inferSelect>;
  historyFetched: boolean;
}> {
  const db = await getDb();
  if (!db) return { booking: null, extras: [], history: [], historyFetched: false };

  const rows = await db
    .select()
    .from(multiparkBookings)
    .where(or(eq(multiparkBookings.externalId, reservationRef), eq(multiparkBookings.bookingNumber, reservationRef)))
    .limit(1);
  const booking = rows[0] ?? null;
  if (!booking) return { booking: null, extras: [], history: [], historyFetched: false };

  const [extras, history] = await Promise.all([
    db
      .select({
        name: multiparkBookingExtras.name,
        description: multiparkBookingExtras.description,
        price: multiparkBookingExtras.price,
        done: multiparkBookingExtras.done,
      })
      .from(multiparkBookingExtras)
      .where(eq(multiparkBookingExtras.bookingExternalId, booking.externalId)),
    db
      .select()
      .from(multiparkBookingHistory)
      .where(eq(multiparkBookingHistory.bookingExternalId, booking.externalId))
      .orderBy(desc(multiparkBookingHistory.actionTime))
      .limit(500),
  ]);

  return { booking, extras, history, historyFetched: history.length > 0 };
}
