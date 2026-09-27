/**
 * "Reservas do dia" — tipos e regras PURAS partilhadas entre o servidor
 * (server/multiparkDb/dayBookings.ts, que lê a BD da Multipark ao vivo) e a
 * página (/operacoes, aba "Reservas do dia").
 *
 * Cada linha da lista é um MOVIMENTO do dia: a Entrada (check-in nesse dia) ou
 * a Saída (check-out nesse dia) de uma reserva. Uma reserva que entra e sai no
 * mesmo dia dá duas linhas.
 */
import { MARKETPLACE_GROUP_KEY, allParkGroups } from "./multiparkParks";

// ─── Estados e fases ────────────────────────────────────────────────────────

/** Estados da reserva na BD da Multipark ("BookingStatus"). */
export const BOOKING_STATUSES = [
  "PENDING", "BOOKED", "CHECKING_IN", "CHECKED_IN", "MOVING", "PENDING_CHECKOUT", "CHECKING_OUT", "CHECKED_OUT", "CANCELLED",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  PENDING: "Pendente",
  BOOKED: "Reservada",
  CHECKING_IN: "A dar entrada",
  CHECKED_IN: "Estacionada",
  MOVING: "Em movimento",
  PENDING_CHECKOUT: "A preparar saída",
  CHECKING_OUT: "A entregar",
  CHECKED_OUT: "Entregue",
  CANCELLED: "Cancelada",
};

export const BOOKING_STATUS_COLORS: Record<BookingStatus, string> = {
  PENDING: "bg-yellow-100 text-yellow-800",
  BOOKED: "bg-blue-100 text-blue-800",
  CHECKING_IN: "bg-sky-100 text-sky-800",
  CHECKED_IN: "bg-green-100 text-green-800",
  MOVING: "bg-emerald-100 text-emerald-800",
  PENDING_CHECKOUT: "bg-violet-100 text-violet-800",
  CHECKING_OUT: "bg-purple-100 text-purple-800",
  CHECKED_OUT: "bg-gray-100 text-gray-800",
  CANCELLED: "bg-red-100 text-red-800",
};

export function statusLabel(status: string | null | undefined): string {
  return (BOOKING_STATUS_LABELS as Record<string, string>)[String(status ?? "")] ?? (status || "—");
}

/** Estados em que o carro já entrou no parque. */
const ENTERED: ReadonlySet<string> = new Set(["CHECKED_IN", "MOVING", "PENDING_CHECKOUT", "CHECKING_OUT", "CHECKED_OUT"]);

/** O movimento já foi feito? (entrada: o carro já entrou; saída: já foi entregue). PURA. */
export function movementDone(kind: MovementKind, status: string | null | undefined): boolean {
  const s = String(status ?? "");
  return kind === "entrada" ? ENTERED.has(s) : s === "CHECKED_OUT";
}

/**
 * Fase fina (texto curto) a partir das horas das fases da reserva: "No local
 * de entrega" e "À espera da bagagem" só existem nessas colunas. PURA.
 */
export function phaseLabel(b: Pick<DayBooking, "status" | "phases">): string | null {
  const s = b.status;
  if (s === "PENDING_CHECKOUT" || s === "CHECKING_OUT") {
    if (b.phases.baggageWaitingAt) return "À espera da bagagem";
    if (b.phases.arrivedAtDeliveryAt) return "No local de entrega";
  }
  return null;
}

// ─── Origem (contabilidade): Direto vs Marketplace ──────────────────────────

export type BookingChannel = "direto" | "marketplace";

export const BOOKING_CHANNEL_LABELS: Record<BookingChannel, string> = {
  direto: "Direto",
  marketplace: "Marketplace",
};

/** Origens ("BookingOrigin") que já são de um canal de terceiros. */
export const MARKETPLACE_ORIGINS: readonly string[] = ["MARKETPLACE", "PARTNER_API", "PARTNER_DASHBOARD"];
/** Quem cobrou ("PaymentSource") que é um agregador (não a Stripe do parque). */
export const MARKETPLACE_PAYMENT_SOURCES: readonly string[] = ["PARKVIA", "PARKOS", "AGGREGATOR_OTHER", "PARKFLOW"];

export const PARTNER_TYPE_LABELS: Record<string, string> = {
  AGENCY: "agência",
  AGGREGATOR: "agregador",
  PARTNER: "parceiro",
};

export const ORIGIN_LABELS: Record<string, string> = {
  GENERAL_FORM: "Formulário",
  MANUAL: "Manual",
  MARKETPLACE: "Marketplace",
  IMPORTED: "Importada",
  API: "API / site",
  MOBILE_APP: "App",
  PARTNER_API: "API de parceiro",
  PARTNER_DASHBOARD: "Painel de parceiro",
  CLIENT_PLAN: "Avença",
};

/**
 * Canal da reserva para a contabilidade: "marketplace" quando veio por um
 * parceiro/agregador/agência (`partnerId`), por uma origem de terceiros
 * (`origin`) ou foi cobrada por um agregador (`paymentSource`); senão "direto".
 * Conta mesmo nos parques nossos. PURA.
 */
export function classifyBookingChannel(b: {
  partnerId?: string | null;
  partnerName?: string | null;
  partnerType?: string | null;
  origin?: string | null;
  paymentSource?: string | null;
}): { channel: BookingChannel; detail: string } {
  const origin = String(b.origin ?? "").toUpperCase();
  const pay = String(b.paymentSource ?? "").toUpperCase();
  if (b.partnerId) {
    const type = PARTNER_TYPE_LABELS[String(b.partnerType ?? "").toUpperCase()];
    const name = b.partnerName?.trim() || "Parceiro";
    return { channel: "marketplace", detail: type ? `${name} (${type})` : name };
  }
  if (MARKETPLACE_ORIGINS.includes(origin)) return { channel: "marketplace", detail: ORIGIN_LABELS[origin] ?? origin };
  if (MARKETPLACE_PAYMENT_SOURCES.includes(pay)) return { channel: "marketplace", detail: pay.charAt(0) + pay.slice(1).toLowerCase().replace(/_/g, " ") };
  return { channel: "direto", detail: ORIGIN_LABELS[origin] ?? (origin || "Direto") };
}

// ─── Linhas ─────────────────────────────────────────────────────────────────

export type MovementKind = "entrada" | "saida";

export interface DayBooking {
  id: string;
  /** N.º da reserva que mostramos (Booking.allocation); null se não houver. */
  code: string | null;
  status: string;
  /** Instantes ISO UTC. */
  checkIn: string | null;
  checkOut: string | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  createdAt: string | null;
  parkId: string;
  parkName: string | null;
  parkCity: string | null;
  groupKey: string;
  groupLabel: string;
  ours: boolean;
  clientName: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  plate: string | null;
  vehicleBrand: string | null;
  vehicleModel: string | null;
  vehicleColor: string | null;
  vehicleType: string | null;
  departingFlight: string | null;
  departingFlightEta: string | null;
  returnFlight: string | null;
  returnFlightEta: string | null;
  deliveryType: string | null;
  deliveryLocation: string | null;
  extrasCount: number;
  extrasPending: number;
  origin: string | null;
  paymentSource: string | null;
  partnerId: string | null;
  partnerName: string | null;
  partnerType: string | null;
  channel: BookingChannel;
  channelDetail: string;
  garage: string | null;
  spot: string | null;
  price: number | null;
  paid: number | null;
  toPay: number | null;
  paymentMethod: string | null;
  currency: string;
  pro: boolean;
  remarks: string | null;
  checkInDriverName: string | null;
  checkOutDriverName: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  customerCheckinEta: number | null;
  phases: {
    checkingInAt: string | null;
    movingAt: string | null;
    pendingCheckoutAt: string | null;
    checkingOutAt: string | null;
    arrivedAtDeliveryAt: string | null;
    baggageWaitingAt: string | null;
  };
}

export interface DayMovement {
  /** `${id}:entrada` / `${id}:saida`. */
  key: string;
  kind: MovementKind;
  /** Instante ISO UTC do movimento (checkIn ou checkOut). */
  at: string;
  /** Voo e ETA relevantes para o movimento (partida na entrada, regresso na saída). */
  flight: string | null;
  flightEta: string | null;
  done: boolean;
  booking: DayBooking;
}

/**
 * Reservas → movimentos do dia [startMs, endMs). Ordenados pela hora (e pela
 * ordem do grupo em empate não interessa: a página agrupa). PURA.
 */
export function toDayMovements(bookings: DayBooking[], startMs: number, endMs: number): DayMovement[] {
  const out: DayMovement[] = [];
  const inDay = (iso: string | null) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= startMs && t < endMs;
  };
  for (const b of bookings) {
    if (inDay(b.checkIn)) {
      out.push({ key: `${b.id}:entrada`, kind: "entrada", at: b.checkIn!, flight: b.departingFlight, flightEta: b.departingFlightEta, done: movementDone("entrada", b.status), booking: b });
    }
    if (inDay(b.checkOut)) {
      out.push({ key: `${b.id}:saida`, kind: "saida", at: b.checkOut!, flight: b.returnFlight, flightEta: b.returnFlightEta, done: movementDone("saida", b.status), booking: b });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

// ─── Filtros e contagens (na página; o dia inteiro já está carregado) ───────

export interface DayFilters {
  kind?: "todas" | MovementKind;
  /** Park.id ou "" (todos). */
  parkId?: string;
  /** "ativas" (sem canceladas), "todas" ou um estado. */
  state?: string;
  search?: string;
}

const norm = (s: string | null | undefined) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const alnum = (s: string | null | undefined) => norm(s).replace(/[^A-Z0-9]/g, "");

/** Aplica os filtros da página. Pesquisa: n.º, id, matrícula (sem traços) ou nome. PURA. */
export function filterMovements(rows: DayMovement[], f: DayFilters): DayMovement[] {
  const q = String(f.search ?? "").trim();
  const qn = norm(q);
  const qa = alnum(q);
  const state = f.state || "ativas";
  return rows.filter((m) => {
    const b = m.booking;
    if (f.kind && f.kind !== "todas" && m.kind !== f.kind) return false;
    if (f.parkId && b.parkId !== f.parkId) return false;
    if (state === "ativas" && b.status === "CANCELLED") return false;
    if (state !== "ativas" && state !== "todas" && b.status !== state) return false;
    if (q) {
      const hit = norm(b.code).includes(qn)
        || b.id === q
        || (qa.length >= 2 && alnum(b.plate).includes(qa))
        || norm(b.clientName).includes(qn);
      if (!hit) return false;
    }
    return true;
  });
}

export interface DayGroupCount { key: string; label: string; ours: boolean; entradas: number; saidas: number }
export interface DaySummary {
  entradas: number;
  saidas: number;
  /** Reservas canceladas (distintas) com movimento previsto no dia. */
  canceladas: number;
  /** Por fazer (não canceladas). */
  entradasPorFazer: number;
  saidasPorFazer: number;
  groups: DayGroupCount[];
}

/** Contagens do dia (as canceladas não contam como entradas/saídas). PURA. */
export function summarizeDay(rows: DayMovement[]): DaySummary {
  const groups = new Map<string, DayGroupCount>();
  for (const g of allParkGroups()) groups.set(g.key, { key: g.key, label: g.label, ours: g.ours, entradas: 0, saidas: 0 });
  const cancelled = new Set<string>();
  let entradas = 0, saidas = 0, entradasPorFazer = 0, saidasPorFazer = 0;
  for (const m of rows) {
    if (m.booking.status === "CANCELLED") { cancelled.add(m.booking.id); continue; }
    const g = groups.get(m.booking.groupKey) ?? groups.get(MARKETPLACE_GROUP_KEY)!;
    if (m.kind === "entrada") { entradas++; g.entradas++; if (!m.done) entradasPorFazer++; }
    else { saidas++; g.saidas++; if (!m.done) saidasPorFazer++; }
  }
  return { entradas, saidas, canceladas: cancelled.size, entradasPorFazer, saidasPorFazer, groups: [...groups.values()] };
}
