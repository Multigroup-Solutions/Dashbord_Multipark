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
import { classifyBookingChannel, isNotOperatedByName, OUR_PARK_BRAND_LABELS, OUR_PARK_BRANDS, type OurParkBrand } from "./multiparkParks";
import { CITY_LABELS, type CityKey } from "./city";

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
  /** 42d: cidade do parque (classificação: a cidade do parque ou, sem ela, o nome) e marca nossa. */
  cityKey?: CityKey | null;
  brand?: OurParkBrand | null;
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
  /** 42d: cidade ("" = todas) e hora de Lisboa (0–23; null = todas). */
  city?: CityKey | "";
  hour?: number | null;
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
    if (f.city && b.cityKey !== f.city) return false;
    if (f.hour != null && lisbonClockHour(m.at) !== f.hour) return false;
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

/**
 * Tira os parques que a operação não faz: os escolhidos em Definições (por id)
 * E os que não operamos pelo nome (28a, lista do Jorge — `isNotOperatedByName`).
 * Nada a tirar → o mesmo array. PURA.
 */
export function excludeParks<T extends { id: string; name?: string | null }>(parks: T[], excludedIds: readonly string[] | null | undefined): T[] {
  const ex = new Set(excludedIds ?? []);
  const out = parks.filter((p) => !ex.has(p.id) && !isNotOperatedByName(p.name));
  return out.length === parks.length ? parks : out;
}

/** Fica fora da operação? (Definições por id OU lista por nome). PURA. */
export function isParkExcluded(p: { id: string; name?: string | null }, excludedIds: ReadonlySet<string> | readonly string[] | null | undefined): boolean {
  const ex = excludedIds instanceof Set ? excludedIds : new Set(excludedIds ?? []);
  return ex.has(p.id) || isNotOperatedByName(p.name);
}

// ─── 42d: por cidade, por hora e por marca (Marketplace à parte) ────────────
// Jorge, 7 out 2026: "reservas do dia… separa isto por cidade… por hora, o que
// vai sair, o que vai entrar… os parques que não são nossos também têm que
// estar aqui… Marketplace também pode ser Airpark, Redpark ou Skypark".

export const DAY_CITIES: readonly CityKey[] = ["lisboa", "porto", "faro"];

const LISBON_HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", hour: "2-digit", hourCycle: "h23" });
/** Hora do relógio de Lisboa (0–23) de um instante ISO. PURA. */
export function lisbonClockHour(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Number(LISBON_HOUR.format(t)) % 24 : -1;
}

/** Balde da reserva: a marca nossa (diretas e parceiros) ou Marketplace. */
export type DayBucket = OurParkBrand | "marketplace";
export const DAY_BUCKETS: readonly DayBucket[] = [...OUR_PARK_BRANDS, "marketplace"];
export const DAY_BUCKET_LABELS: Record<DayBucket, string> = { ...OUR_PARK_BRAND_LABELS, marketplace: "Marketplace" };

/**
 * Marketplace = os parques que não são nossos (Travelparking, Boardingpark…)
 * E as reservas das nossas marcas que vieram pelo Marketplace (origem
 * MARKETPLACE) — a regra do canal (classifyBookingChannel). O resto conta na
 * marca do parque. PURA.
 */
export function dayBucketOf(b: Pick<DayBooking, "ours" | "brand" | "origin" | "paymentSource" | "partnerId">): DayBucket {
  const ch = classifyBookingChannel({ parkOurs: b.ours, origin: b.origin, paymentSource: b.paymentSource, partnerId: b.partnerId }).channel;
  return ch === "marketplace" || !b.brand ? "marketplace" : b.brand;
}

export interface InOut { entradas: number; saidas: number; entradasPorFazer: number; saidasPorFazer: number }
export interface CityDay extends InOut {
  city: CityKey | null;
  label: string;
  byBucket: Record<DayBucket, InOut>;
  /** Dentro do Marketplace: cada parque (os de terceiros pelo nome; os nossos "Airpark (pelo Marketplace)"). */
  marketplaceParks: Array<InOut & { name: string }>;
  /** 24 horas de Lisboa (0–23), o que entra e o que sai em cada uma. */
  hours: Array<InOut & { hour: number }>;
}

const emptyInOut = (): InOut => ({ entradas: 0, saidas: 0, entradasPorFazer: 0, saidasPorFazer: 0 });
const addMove = (x: InOut, m: DayMovement) => {
  if (m.kind === "entrada") { x.entradas++; if (!m.done) x.entradasPorFazer++; }
  else { x.saidas++; if (!m.done) x.saidasPorFazer++; }
};

/**
 * Movimentos do dia → uma linha por cidade (Lisboa, Porto, Faro, e "Sem
 * cidade" se houver), com as marcas, o Marketplace por parque e as 24 horas.
 * As canceladas não contam (countsForDay). PURA.
 */
export function summarizeByCity(rows: DayMovement[]): CityDay[] {
  const out = new Map<string, CityDay>();
  const get = (city: CityKey | null) => {
    const k = city ?? "";
    let c = out.get(k);
    if (!c) {
      c = {
        city, label: city ? CITY_LABELS[city] : "Sem cidade", ...emptyInOut(),
        byBucket: Object.fromEntries(DAY_BUCKETS.map((b) => [b, emptyInOut()])) as Record<DayBucket, InOut>,
        marketplaceParks: [], hours: Array.from({ length: 24 }, (_, hour) => ({ hour, ...emptyInOut() })),
      };
      out.set(k, c);
    }
    return c;
  };
  const parks = new Map<string, InOut & { name: string }>();
  for (const m of rows) {
    const b = m.booking;
    if (!countsForDay(b.status)) continue;
    const c = get(b.cityKey ?? null);
    addMove(c, m);
    const bucket = dayBucketOf(b);
    addMove(c.byBucket[bucket], m);
    const h = lisbonClockHour(m.at);
    if (h >= 0) addMove(c.hours[h], m);
    if (bucket === "marketplace") {
      const name = b.ours ? `${b.parkName ?? b.groupLabel} (pelo Marketplace)` : (b.parkName ?? b.groupLabel);
      const k = `${b.cityKey ?? ""}|${name}`;
      let p = parks.get(k);
      if (!p) { p = { name, ...emptyInOut() }; parks.set(k, p); c.marketplaceParks.push(p); }
      addMove(p, m);
    }
  }
  for (const c of out.values()) c.marketplaceParks.sort((a, b) => b.entradas + b.saidas - (a.entradas + a.saidas) || a.name.localeCompare(b.name, "pt"));
  const order = (c: CityDay) => (c.city ? DAY_CITIES.indexOf(c.city) : 99);
  return [...out.values()].sort((a, b) => order(a) - order(b));
}
