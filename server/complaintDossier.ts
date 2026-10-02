/**
 * Dossier automático das reclamações:
 *  - matching reclamação → reserva Multipark por ref/matrícula/email/telefone/
 *    nome, ancorado na DATA da reclamação (a reserva "da queixa", não a mais
 *    recente do cliente)
 *  - dossier da reserva (ficha, extras e histórico)
 * Tudo AO VIVO na BD da Multipark (29 set 2026: "pesquisas e ligações a
 * reservas"); a cópia `multipark_bookings` já não é lida. Sem chamadas à API.
 */

import { eq } from "drizzle-orm";
import { getDb, updateComplaint, updateLostFoundItem } from "./db";
import { complaints, lostFoundItems, multiparkBookingHistory } from "../drizzle/schema";
import type { LiveBookingRow } from "./multiparkDb/bookingSearch";

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
  booking: LiveBookingRow;
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
  const { searchLiveBookings, liveBookingByRef } = await import("./multiparkDb/bookingSearch");

  // 1) Referência explícita (id da Multipark ou nº de reserva) — match direto.
  const ref = s.reservationRef?.trim();
  if (ref) {
    const b = await liveBookingByRef(ref);
    if (b) return { booking: b, matchedBy: ["ref"], score: 100 };
  }

  const plate = s.vehiclePlate ? normPlate(s.vehiclePlate) : null;
  const email = s.clientEmail?.trim().toLowerCase() || null;
  const phone = phoneKey(s.clientPhone);
  const name = s.clientName?.trim();
  const nameOk = !!name && name.length >= 6 && !/desconhecido/i.test(name);
  if (!plate && !email && !phone && !nameOk) return null;

  const candidates = await searchLiveBookings({ plate, email, phone, name: nameOk ? name : null }, { limit: 25 });
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
    if (nameOk && `${b.clientFirstName ?? ""} ${b.clientLastName ?? ""}`.trim().toLowerCase() === name!.toLowerCase()) {
      score += 10; matchedBy.push("nome");
    }
    // Só um sinal forte liga (16c): o nome (homónimos) e a janela de datas
    // não chegam sozinhos — copiava o email/telefone de outra pessoa.
    if (!isStrongBookingMatch(matchedBy)) continue;

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

/** Há matrícula, email ou telefone iguais? (o nome sozinho não chega). PURA. */
export function isStrongBookingMatch(matchedBy: readonly string[]): boolean {
  return matchedBy.some((m) => m === "matricula" || m === "email" || m === "telefone");
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
  let booking: LiveBookingRow | null = null;
  let matchedBy: string[] = [];
  let alreadyLinked = false;
  if (c.reservationRef) {
    const { liveBookingByRef } = await import("./multiparkDb/bookingSearch");
    const existing = await liveBookingByRef(c.reservationRef);
    if (existing) {
      booking = existing;
      matchedBy = ["ref"];
      alreadyLinked = true;
    } else {
      // Ref escrita à mão que não se encontra: fica como está — nunca é
      // trocada sem aviso por outra reserva (16c).
      return { linked: false, alreadyLinked: false, matchedBy: [], booking: null };
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

  let booking: LiveBookingRow | null = null;
  let matchedBy: string[] = [];
  let alreadyLinked = false;
  if (item.bookingRef) {
    const { liveBookingByRef } = await import("./multiparkDb/bookingSearch");
    const existing = await liveBookingByRef(item.bookingRef);
    if (existing) {
      booking = existing;
      matchedBy = ["ref"];
      alreadyLinked = true;
    } else {
      // Ref escrita à mão que não se encontra: fica como está (16c).
      return { linked: false, alreadyLinked: false, matchedBy: [], booking: null };
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
 * Multipark (History; ref = id ou n.º da reserva). Sem nada lá, usa o
 * dossier (também ao vivo). Nunca vai à API da Multipark nem à cópia antiga.
 */
export async function getBookingTimeline(ref: string, cities?: string[]): Promise<{ bookingId: string; total: number; history: BookingTimelineItem[]; error?: string }> {
  // Leitura falhada ≠ "sem histórico" (16b): vazio por falha leva `error`.
  let liveError: string | undefined;
  try {
    const { resolveBookingRef, getBookingFileTimeline, formatChange } = await import("./multiparkDb/bookingFile");
    const resolved = await resolveBookingRef(ref, cities);
    if (!resolved.available) liveError = UNAVAILABLE_HISTORY;
    if (resolved.available && resolved.data.kind === "found") {
      const t = await getBookingFileTimeline(resolved.data.id, cities);
      if (!t.available) liveError = UNAVAILABLE_HISTORY;
      const entries = t.available ? t.data.entries.filter((e) => e.source === "history") : [];
      if (entries.length) {
        const history = entries.map((e) => ({
          id: e.id, changeType: e.kind, actionTime: e.at, remarks: e.remarks, agentName: e.who, userId: null,
          modifiedFields: e.changes.length ? e.changes.map(formatChange).join("; ") : null, platform: e.platform,
        }));
        return { bookingId: ref, total: history.length, history };
      }
    }
  } catch { liveError = UNAVAILABLE_HISTORY; /* tenta o dossier */ }
  const d = await getComplaintBookingDossier(ref, cities);
  const history = d.history.map((h) => ({
    id: h.historyId, changeType: h.changeType, actionTime: h.actionTime, remarks: h.remarks,
    agentName: h.agentName, userId: h.agentUserId, modifiedFields: h.modifiedFields, platform: h.platform,
  }));
  const error = history.length ? undefined : (d.error ?? d.historyError ?? liveError);
  return { bookingId: ref, total: history.length, history, ...(error ? { error } : {}) };
}

const UNAVAILABLE_HISTORY = "Histórico indisponível (BD da Multipark sem resposta).";

/** Reserva do dossier, com os nomes de campos que as páginas Reclamações/Perdidos já usam. */
export interface DossierBooking {
  externalId: string; bookingNumber: string | null; status: string | null; bookingCreatedAt: string | null;
  origin: string | null; partnerName: string | null; campaignName: string | null;
  parkName: string | null; city: string | null; currentGarage: string | null; currentSpot: string | null;
  checkIn: string | null; checkInTime: string | null; checkinAgentName: string | null;
  checkOut: string | null; checkOutTime: string | null; checkoutAgentName: string | null;
  paymentMethod: string | null; currency: string; totalPrice: number | null; totalPaid: number | null; remainingToPay: number | null;
  deliveryType: string | null; deliveryAddress: string | null;
  arrivalFlight: string | null; departureFlight: string | null; returnFlight: string | null;
  vehicleBrand: string | null; vehicleModel: string | null; vehicleColor: string | null; licensePlate: string | null;
  clientName: string | null; clientEmail: string | null; clientPhone: string | null;
  cancelledAt: string | null; cancelReason: string | null; remarks: string | null;
}

type Core = import("./multiparkDb/bookingFile").BookingFileCore;
type Location = import("./multiparkDb/bookingFile").BookingLocation | null;

/** Ficha ao vivo → reserva do dossier. PURA. */
export function dossierBookingFromCore(c: Core, loc?: Location): DossierBooking {
  return {
    externalId: c.id, bookingNumber: c.code, status: c.status, bookingCreatedAt: c.createdAt,
    origin: c.origin.label || c.origin.code, partnerName: c.origin.partnerName, campaignName: c.origin.externalCampaign,
    parkName: c.park.name, city: c.park.city,
    currentGarage: loc?.garage?.name ?? loc?.external?.garage ?? null,
    currentSpot: [loc?.spot?.row ?? loc?.external?.row, loc?.spot?.spot ?? loc?.external?.spot].filter(Boolean).join(" ") || null,
    checkIn: c.checkIn.at ?? c.checkIn.day, checkInTime: c.checkIn.time, checkinAgentName: c.agents.checkIn,
    checkOut: c.checkOut.at ?? c.checkOut.day, checkOutTime: c.checkOut.time, checkoutAgentName: c.agents.checkOut,
    paymentMethod: c.price.paymentMethod, currency: c.price.currency || "EUR", totalPrice: c.price.bookingPrice, totalPaid: null, remainingToPay: null,
    deliveryType: c.delivery.type, deliveryAddress: c.delivery.location,
    arrivalFlight: null, departureFlight: c.flights.departing.flight, returnFlight: c.flights.return.flight,
    vehicleBrand: c.vehicle.brand, vehicleModel: c.vehicle.model, vehicleColor: c.vehicle.color, licensePlate: c.vehicle.plate,
    clientName: c.client.name, clientEmail: c.client.email, clientPhone: c.client.phone,
    // o estado diz se foi cancelada; a data/motivo estão na ficha da reserva (/reserva/:id)
    cancelledAt: null, cancelReason: null, remarks: c.remarks,
  };
}

/**
 * Dossier completo de uma reserva para o detalhe da reclamação/perdido: a
 * ficha, os extras e o histórico — tudo AO VIVO da BD da Multipark, nas
 * cidades de quem pede. A ficha completa está em /reserva/:id.
 */
export async function getComplaintBookingDossier(reservationRef: string, cities?: string[]): Promise<{
  booking: DossierBooking | null;
  extras: Array<{ name: string | null; description: string | null; price: number | null; done: boolean }>;
  history: Array<typeof multiparkBookingHistory.$inferSelect>;
  historyFetched: boolean;
  error?: string;
  /** O histórico não se leu (a ficha sim) — não é "sem histórico". */
  historyError?: string;
  /** Os extras não se leram — não é "sem extras". */
  extrasError?: string;
}> {
  const empty = { booking: null, extras: [], history: [], historyFetched: false };
  const { resolveBookingRef, getBookingFileMain, getBookingFileExtras } = await import("./multiparkDb/bookingFile");
  const resolved = await resolveBookingRef(reservationRef, cities);
  if (!resolved.available) return { ...empty, error: "Reserva indisponível (BD da Multipark sem resposta)." };
  if (resolved.data.kind !== "found") return empty;
  const id = resolved.data.id;
  const [main, extras, history] = await Promise.all([
    getBookingFileMain(id, cities),
    getBookingFileExtras(id, cities),
    // "History" AO VIVO no formato da cópia antiga (a página não muda).
    import("./multiparkDb/historyLive")
      .then(({ readLiveHistory }) => readLiveHistory({ bookingIds: [id], cities, limit: 500 }))
      .then((rows) => rows.map((r, i) => ({
        id: i + 1, bookingExternalId: r.bookingExternalId, historyId: r.historyId, changeType: r.changeType, actionTime: r.actionTime,
        remarks: r.remarks, agentName: r.agentName, agentUserId: r.agentUserId, agentEmail: null, modifiedFields: r.modifiedFields,
        platform: r.platform, fetchedAt: r.actionTime ?? "",
      }) as typeof multiparkBookingHistory.$inferSelect))
      .catch(() => null),
  ]);
  const core = main.available ? main.data.data.core : null;
  if (!core) return { ...empty, error: main.available ? undefined : "Reserva indisponível (BD da Multipark sem resposta)." };
  const extraRows = extras.available ? extras.data.data.extras : [];
  return {
    booking: dossierBookingFromCore(core, main.available ? main.data.data.location : null),
    extras: extraRows.map((e) => ({ name: e.name, description: e.description, price: e.price, done: e.done })),
    history: history ?? [],
    historyFetched: !!history && history.length > 0,
    ...(history ? {} : { historyError: UNAVAILABLE_HISTORY }),
    ...(extras.available ? {} : { extrasError: "Extras indisponíveis (BD da Multipark sem resposta)." }),
  };
}
