/**
 * "Reservas do dia" — tipos e regras PURAS partilhadas entre o servidor
 * (server/multiparkDb/dayBookings.ts, que lê a BD da Multipark ao vivo) e a
 * página (/operacoes, aba "Reservas do dia").
 *
 * Cada linha da lista é um MOVIMENTO do dia: a Entrada (check-in nesse dia) ou
 * a Saída (check-out nesse dia) de uma reserva. Uma reserva que entra e sai no
 * mesmo dia dá duas linhas.
 *
 * A lista é só OPERACIONAL (recolher/entregar os carros de TODOS os parques da
 * BD da Multipark, menos os de "Parques que a operação não faz" nas
 * Definições). O canal Direto / Parceiro / Marketplace é da contabilidade e NÃO
 * entra aqui (vive em shared/multiparkParks.ts, usado pela ficha da reserva).
 */

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

// ─── Grupos (operação): um por parque ───────────────────────────────────────

/** Ordem dos grupos que não são marca nossa + cidade (vêm depois, por nome). */
export const OTHER_PARK_GROUP_ORDER = 1000;

export interface OperationalGroup {
  /** "airpark_lisboa" (marca nossa + cidade) ou "park:<Park.id>". */
  key: string;
  /** "Airpark Lisboa" ou o nome do parque. */
  label: string;
  /** Marca nossa (Airpark / Redpark / Skypark) em Lisboa, Porto ou Faro. */
  ours: boolean;
  order: number;
}

/**
 * Grupo operacional de um parque: marca nossa + cidade quando se reconhece
 * ("Airpark Lisboa", pela classificação de shared/multiparkParks.ts); senão o
 * próprio parque, pelo nome. Sem bloco "Marketplace". PURA.
 */
export function operationalParkGroup(p: { id: string; name: string | null; key: string; label: string; ours: boolean; order?: number }): OperationalGroup {
  if (p.ours) return { key: p.key, label: p.label, ours: true, order: p.order ?? 0 };
  return { key: `park:${p.id}`, label: p.name || p.id, ours: false, order: OTHER_PARK_GROUP_ORDER };
}

/** Ordena grupos: marcas nossas (Lisboa, Porto, Faro × Airpark, Redpark, Skypark) e depois os outros por nome. PURA. */
export function compareGroups(a: Pick<OperationalGroup, "label" | "order">, b: Pick<OperationalGroup, "label" | "order">): number {
  return a.order - b.order || a.label.localeCompare(b.label, "pt", { sensitivity: "base" });
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
  /** Grupo operacional (operationalParkGroup). */
  groupKey: string;
  groupLabel: string;
  groupOrder: number;
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

/**
 * Fora das contas do dia: só as canceladas. As compras online por pagar
 * (PENDING) CONTAM (Jorge, 3 out — D6): o carro vem na mesma; saem sozinhas
 * quando a Multipark as passa a recolhidas ou canceladas (lidas ao vivo).
 * Igual à Passagem de turno, ao Extras Dia e ao painel de Operações. No
 * dinheiro (Faturação, Financeiro) continuam de fora.
 */
export function countsForDay(status: string | null | undefined): boolean {
  return status !== "CANCELLED";
}

export interface DayFilters {
  kind?: "todas" | MovementKind;
  /** Park.id ou "" (todos). */
  parkId?: string;
  /** "ativas" (sem canceladas; as por pagar contam), "todas" ou um estado. */
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
    if (state === "ativas" && !countsForDay(b.status)) return false;
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

export interface DayGroupCount { key: string; label: string; ours: boolean; order: number; entradas: number; saidas: number }
export interface DaySummary {
  entradas: number;
  saidas: number;
  /** Reservas canceladas (distintas) com movimento previsto no dia. */
  canceladas: number;
  /** Das que contam: compras online por pagar (PENDING, distintas) com movimento previsto no dia. */
  pendentes: number;
  /** Por fazer (das que contam). */
  entradasPorFazer: number;
  saidasPorFazer: number;
  /** Por parque (grupo operacional), só os que têm movimentos, pela ordem da página. */
  groups: DayGroupCount[];
}

/** Contagens do dia (as canceladas não contam; as por pagar contam e contam-se à parte também). PURA. */
export function summarizeDay(rows: DayMovement[]): DaySummary {
  const groups = new Map<string, DayGroupCount>();
  const cancelled = new Set<string>();
  const pending = new Set<string>();
  let entradas = 0, saidas = 0, entradasPorFazer = 0, saidasPorFazer = 0;
  for (const m of rows) {
    if (m.booking.status === "CANCELLED") { cancelled.add(m.booking.id); continue; }
    if (m.booking.status === "PENDING") pending.add(m.booking.id);
    const b = m.booking;
    let g = groups.get(b.groupKey);
    if (!g) groups.set(b.groupKey, (g = { key: b.groupKey, label: b.groupLabel, ours: b.ours, order: b.groupOrder, entradas: 0, saidas: 0 }));
    if (m.kind === "entrada") { entradas++; g.entradas++; if (!m.done) entradasPorFazer++; }
    else { saidas++; g.saidas++; if (!m.done) saidasPorFazer++; }
  }
  return { entradas, saidas, canceladas: cancelled.size, pendentes: pending.size, entradasPorFazer, saidasPorFazer, groups: [...groups.values()].sort(compareGroups) };
}

export interface DayGroupSection extends OperationalGroup { rows: DayMovement[] }

/** Movimentos → um bloco por grupo (parque), pela ordem da página. PURA. */
export function groupMovements(rows: DayMovement[]): DayGroupSection[] {
  const out = new Map<string, DayGroupSection>();
  for (const m of rows) {
    const b = m.booking;
    let g = out.get(b.groupKey);
    if (!g) out.set(b.groupKey, (g = { key: b.groupKey, label: b.groupLabel, ours: b.ours, order: b.groupOrder, rows: [] }));
    g.rows.push(m);
  }
  return [...out.values()].sort(compareGroups);
}

/** Tira os parques que a operação não faz (Definições). PURA. */
export function excludeParks<T extends { id: string }>(parks: T[], excludedIds: readonly string[] | null | undefined): T[] {
  if (!excludedIds?.length) return parks;
  const ex = new Set(excludedIds);
  return parks.filter((p) => !ex.has(p.id));
}
