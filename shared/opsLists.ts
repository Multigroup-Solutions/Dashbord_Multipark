/**
 * Listas das Operações por período — "Reservas" (criadas), "Recolhas"
 * (check-in), "Entregas" (check-out) e "Cancelados" — lidas AO VIVO da BD da
 * Multipark (server/multiparkDb/opsLists.ts). Tipos e regras PURAS partilhadas
 * entre o servidor e a página (/operacoes).
 *
 * Datas: dias de Lisboa "YYYY-MM-DD" (inclusive). O período por omissão é
 * HOJE; máximo OPS_LIST_MAX_DAYS dias (os contadores são agregados no SQL).
 */
import {
  BOOKING_CHANNELS, BOOKING_CHANNEL_LABELS, MARKETPLACE_GROUP_KEY, allParkGroups, classifyBookingChannel,
  type BookingChannel,
} from "./multiparkParks";
import { addDays } from "./lisbonDay";

// ─── Listas ─────────────────────────────────────────────────────────────────

/** Ids das abas (os mesmos das listas antigas, para os links continuarem a servir). */
export const OPS_LIST_KINDS = ["reservas", "entradas", "saidas", "cancelados"] as const;
export type OpsListKind = (typeof OPS_LIST_KINDS)[number];

export const OPS_LIST_LABELS: Record<OpsListKind, string> = {
  reservas: "Reservas",
  entradas: "Recolhas",
  saidas: "Entregas",
  cancelados: "Cancelados",
};

/** A data que conta em cada lista (texto para cabeçalhos e ajuda). */
export const OPS_LIST_EVENT_LABELS: Record<OpsListKind, string> = {
  reservas: "Criada",
  entradas: "Recolha",
  saidas: "Entrega",
  cancelados: "Cancelada",
};

export const OPS_LIST_SUBTITLES: Record<OpsListKind, string> = {
  reservas: "Reservas criadas no período",
  entradas: "Recolhas (check-in) previstas ou feitas no período",
  saidas: "Entregas (check-out) previstas ou feitas no período",
  cancelados: "Reservas canceladas no período (data do cancelamento)",
};

/** Filtro de estado de cada lista (o 1.º é o de omissão). */
export const OPS_LIST_STATES: Record<OpsListKind, ReadonlyArray<{ id: string; label: string }>> = {
  reservas: [{ id: "all", label: "Todas" }, { id: "active", label: "Não canceladas" }, { id: "cancelled", label: "Canceladas" }],
  entradas: [{ id: "all", label: "Todas" }, { id: "done", label: "Recolhidas" }, { id: "pending", label: "Por recolher" }],
  saidas: [{ id: "all", label: "Todas" }, { id: "done", label: "Entregues" }, { id: "pending", label: "Por entregar" }],
  cancelados: [{ id: "all", label: "Todas" }, { id: "refund", label: "Com reembolso" }, { id: "norefund", label: "Sem reembolso" }],
};

export function isOpsListState(kind: OpsListKind, state: string | null | undefined): boolean {
  return OPS_LIST_STATES[kind].some((s) => s.id === state);
}

/** Estados em que o carro já entrou no parque (recolha feita). */
export const ENTERED_STATUSES = ["CHECKED_IN", "MOVING", "PENDING_CHECKOUT", "CHECKING_OUT", "CHECKED_OUT"] as const;

/** Pauta do Rafael (7 out 2026): o produto "coberto" chama-se TOLDO (o carro fica sob toldo). */
export const PARKING_TYPE_LABELS: Record<string, string> = {
  COVERED: "Toldo",
  UNCOVERED: "Descoberto",
  INDOOR: "Interior",
  VIP: "VIP",
};

// ─── Período ────────────────────────────────────────────────────────────────

/** Máximo de dias por pedido (cabe folgado nos 15 s da BD). */
export const OPS_LIST_MAX_DAYS = 62;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** N.º de dias de `from` a `to` (inclusive); 0 se inválido. PURA. */
export function rangeDays(from: string, to: string): number {
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || to < from) return 0;
  const ms = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  return Math.round(ms / 86_400_000) + 1;
}

/** Período anterior com a mesma duração (para comparar). PURA. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const n = Math.max(rangeDays(from, to), 1);
  return { from: addDays(from, -n), to: addDays(from, -1) };
}

export const OPS_RANGE_PRESETS = ["hoje", "ontem", "amanha", "7dias", "mes"] as const;
export type OpsRangePreset = (typeof OPS_RANGE_PRESETS)[number];
export const OPS_RANGE_PRESET_LABELS: Record<OpsRangePreset, string> = {
  hoje: "Hoje",
  ontem: "Ontem",
  amanha: "Amanhã",
  "7dias": "7 dias",
  mes: "Este mês",
};

/** Intervalo de um atalho, a partir do dia de hoje (Lisboa). PURA. */
export function presetRange(preset: OpsRangePreset, today: string): { from: string; to: string } {
  switch (preset) {
    case "hoje": return { from: today, to: today };
    case "ontem": { const d = addDays(today, -1); return { from: d, to: d }; }
    case "amanha": { const d = addDays(today, 1); return { from: d, to: d }; }
    case "7dias": return { from: addDays(today, -6), to: today };
    case "mes": {
      const first = `${today.slice(0, 7)}-01`;
      return { from: first, to: addDays(addDays(first, 32).slice(0, 7) + "-01", -1) };
    }
  }
}

/** Qual atalho corresponde a este intervalo (ou null). PURA. */
export function matchPreset(from: string, to: string, today: string): OpsRangePreset | null {
  return OPS_RANGE_PRESETS.find((p) => { const r = presetRange(p, today); return r.from === from && r.to === to; }) ?? null;
}

// ─── Linhas ─────────────────────────────────────────────────────────────────

export interface OpsListRow {
  id: string;
  /** N.º da reserva (Booking.allocation). */
  code: string | null;
  status: string;
  /** Instante (ISO UTC) que conta nesta lista: criação, recolha, entrega ou cancelamento. */
  eventAt: string | null;
  /** Cancelados sem linha na tabela Cancellation: datados pela última alteração. */
  approxDate: boolean;
  checkIn: string | null;
  checkOut: string | null;
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
  vehicleType: string | null;
  deliveryType: string | null;
  parkingType: string | null;
  origin: string | null;
  paymentSource: string | null;
  partnerId: string | null;
  partnerName: string | null;
  partnerType: string | null;
  channel: BookingChannel;
  channelDetail: string;
  channelBadge: string;
  price: number | null;
  paid: number | null;
  toPay: number | null;
  paymentMethod: string | null;
  pro: boolean;
  remarks: string | null;
  checkInDriverName: string | null;
  checkOutDriverName: string | null;
  /** Só nos cancelados (tabela Cancellation + último movimento CANCEL). */
  cancellation: {
    at: string | null;
    type: string | null;
    obs: string | null;
    refund: boolean;
    refunded: boolean;
    refundedAmount: number | null;
    refundedAt: string | null;
    /** Quem cancelou (History CANCEL → agentName / Agent). */
    by: string | null;
  } | null;
}

// ─── Contadores (agregados no SQL, somados aqui) ───────────────────────────

/** Uma linha do agregado: um grupo (parque × canal × estado × período). */
export interface OpsAggRow {
  parkId: string;
  /** Período atual (true) ou o anterior (false). */
  current: boolean;
  status: string;
  origin: string | null;
  paymentSource: string | null;
  hasPartner: boolean;
  /** Motivo do cancelamento (só nos cancelados). */
  reason: string | null;
  count: number;
  value: number;
  paid: number;
  toPay: number;
  approx: number;
  refund: number;
  refunded: number;
}

export interface OpsParkInfo { id: string; name: string; cityName: string | null; key: string; label: string; ours: boolean }

export interface OpsParkCount { parkId: string; parkName: string; groupLabel: string; ours: boolean; count: number; value: number; prevCount: number }
export interface OpsGroupCount { key: string; label: string; ours: boolean; count: number; prevCount: number }
export interface OpsChannelCount { channel: BookingChannel; label: string; count: number; value: number; prevCount: number }
export interface OpsReasonCount { reason: string; count: number; value: number }

export interface OpsListSummary {
  total: number;
  prevTotal: number;
  /** Valor c/ IVA (BookingPricing; na falta, bookingPrice). */
  value: number;
  paid: number;
  toPay: number;
  /** Reservas: não canceladas / canceladas (e o valor destas). */
  active: number;
  cancelled: number;
  cancelledValue: number;
  /** Recolhas/Entregas: feitas / por fazer. */
  done: number;
  pending: number;
  /** Cancelados: datados pela última alteração (sem Cancellation). */
  approx: number;
  /** Cancelados: com reembolso pedido e o valor reembolsado. */
  refund: number;
  refunded: number;
  /**
   * Quantas são de parques NOSSOS e, dessas, quantas têm data aproximada (só
   * nos cancelados). O Dashboard das Operações conta `ours - oursApprox`: só
   * parques nossos e só cancelamentos com registo na Multipark.
   */
  ours: number;
  oursApprox: number;
  byPark: OpsParkCount[];
  byGroup: OpsGroupCount[];
  byChannel: OpsChannelCount[];
  byReason: OpsReasonCount[];
}

const ENTERED: ReadonlySet<string> = new Set(ENTERED_STATUSES);

/** Feito? Recolha: o carro já entrou. Entrega: já foi entregue. PURA. */
export function opsDone(kind: OpsListKind, status: string): boolean {
  if (kind === "entradas") return ENTERED.has(status);
  if (kind === "saidas") return status === "CHECKED_OUT";
  return false;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Agregado do SQL → contadores. O canal é calculado aqui (classificador
 * único); `channel` filtra os totais, mas `byChannel` mostra sempre os três
 * (para os botões de canal). PURA.
 */
export function summarizeOps(kind: OpsListKind, rows: OpsAggRow[], parks: OpsParkInfo[], channel?: BookingChannel | ""): OpsListSummary {
  const parkById = new Map(parks.map((p) => [p.id, p]));
  const channels = new Map<BookingChannel, OpsChannelCount>(BOOKING_CHANNELS.map((c) => [c, { channel: c, label: BOOKING_CHANNEL_LABELS[c], count: 0, value: 0, prevCount: 0 }]));
  const groups = new Map<string, OpsGroupCount>();
  for (const g of allParkGroups()) groups.set(g.key, { key: g.key, label: g.label, ours: g.ours, count: 0, prevCount: 0 });
  const byPark = new Map<string, OpsParkCount>();
  const reasons = new Map<string, OpsReasonCount>();
  const s: OpsListSummary = {
    total: 0, prevTotal: 0, value: 0, paid: 0, toPay: 0, active: 0, cancelled: 0, cancelledValue: 0, done: 0, pending: 0,
    approx: 0, refund: 0, refunded: 0, ours: 0, oursApprox: 0, byPark: [], byGroup: [], byChannel: [], byReason: [],
  };
  for (const r of rows) {
    const park = parkById.get(r.parkId);
    const ours = park?.ours ?? false;
    const ch = classifyBookingChannel({ parkOurs: ours, origin: r.origin, paymentSource: r.paymentSource, partnerId: r.hasPartner ? "x" : null }).channel;
    const c = channels.get(ch)!;
    if (r.current) { c.count += r.count; c.value += r.value; } else c.prevCount += r.count;
    if (channel && ch !== channel) continue;
    const g = groups.get(park?.key ?? MARKETPLACE_GROUP_KEY) ?? groups.get(MARKETPLACE_GROUP_KEY)!;
    const p = byPark.get(r.parkId) ?? byPark.set(r.parkId, {
      parkId: r.parkId, parkName: park?.name ?? r.parkId, groupLabel: park?.label ?? g.label, ours, count: 0, value: 0, prevCount: 0,
    }).get(r.parkId)!;
    if (!r.current) { s.prevTotal += r.count; g.prevCount += r.count; p.prevCount += r.count; continue; }
    s.total += r.count; g.count += r.count; p.count += r.count; p.value += r.value;
    s.approx += r.approx; s.refund += r.refund; s.refunded += r.refunded;
    if (ours) { s.ours += r.count; s.oursApprox += r.approx; }
    if (kind === "reservas" && r.status === "CANCELLED") { s.cancelled += r.count; s.cancelledValue += r.value; continue; }
    // Valores: nas Reservas só as não canceladas contam (como na lista antiga).
    s.value += r.value; s.paid += r.paid; s.toPay += r.toPay;
    if (kind === "reservas") s.active += r.count;
    if (kind === "entradas" || kind === "saidas") { if (opsDone(kind, r.status)) s.done += r.count; else s.pending += r.count; }
    if (kind === "cancelados") {
      const key = r.reason ?? "Sem motivo";
      const x = reasons.get(key) ?? reasons.set(key, { reason: key, count: 0, value: 0 }).get(key)!;
      x.count += r.count; x.value += r.value;
    }
  }
  s.value = round2(s.value); s.paid = round2(s.paid); s.toPay = round2(s.toPay);
  s.cancelledValue = round2(s.cancelledValue); s.refunded = round2(s.refunded);
  s.byPark = [...byPark.values()].map((p) => ({ ...p, value: round2(p.value) }))
    .filter((p) => p.count || p.prevCount)
    .sort((a, b) => b.count - a.count || a.parkName.localeCompare(b.parkName, "pt"));
  s.byGroup = [...groups.values()].filter((g) => g.count || g.prevCount);
  s.byChannel = [...channels.values()].map((c) => ({ ...c, value: round2(c.value) }));
  s.byReason = [...reasons.values()].map((r) => ({ ...r, value: round2(r.value) })).sort((a, b) => b.count - a.count);
  return s;
}

/** Variação face ao período anterior: diferença e % (null sem base). PURA. */
export function deltaVs(current: number, previous: number): { diff: number; pct: number | null } {
  return { diff: current - previous, pct: previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null };
}
