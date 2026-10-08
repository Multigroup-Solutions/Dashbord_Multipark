/**
 * Ficha da reserva — leitura AO VIVO da BD da Multipark (BD 2), sem copiar
 * nada para a nossa (ver docs/multipark-db/plano-duas-bd.md, passo 4).
 *
 * Mesmas regras da camada read.ts:
 *   - SQL parametrizado (`$1…`, identificadores "camelCase" entre aspas);
 *   - construtores de SQL e mapeadores PUROS (testados);
 *   - LIMIT sempre;
 *   - NUNCA lança: cada secção devolve `{ available:false, reason }` se a BD
 *     não responder; dentro da secção, cada parte (tabela) falha sozinha e
 *     vai para `missing` — a página mostra o resto.
 *   - Âmbito de cidade por Park.city em TODAS as leituras (a reserva tem de
 *     ser de um parque das cidades do pedido).
 *
 * Robustez a colunas: as linhas vêm por `to_jsonb(tabela)`, por isso uma
 * coluna que desapareça (ou ainda não exista) fica só `undefined` no mapeador
 * em vez de rebentar a consulta. Só as colunas das junções/filtros são
 * referidas diretamente (ids e chaves estrangeiras).
 *
 * Tabelas e colunas usadas (docs/multipark-db/schema.md):
 *   Booking (quase todas: estado, fases *At, datas, voos + ETA, entrega,
 *            origem, parceiro, preços, pagamento, caixa, condutores, vídeo,
 *            assinaturas, km/autonomia, língua, NIF, lugar/garagem/alocação)
 *   Park (id, name, city, firebaseBrand, listingType, status), BookingVehicle, Client, Partner,
 *   Driver, Spot, Garage, Allocation, Attachment, History, ActivityEvent,
 *   Agent (name), BookingPricing, BookingPricingPayment, Billing,
 *   Cancellation, BookingExtraService, ExtraService, ChatMessage,
 *   EntityEmailLog, Occurrence, BookingReview.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import { cityAliases, ParamList, safeMultiparkRead, toIsoUtc, type MultiparkRead, type MultiparkReadUnavailableCode } from "./read";
import {
  BOOKING_CHANNEL_LABELS, ORIGIN_LABELS, classifyBookingChannel, classifyPark, marketplaceOperated, type BookingChannel,
} from "../../shared/multiparkParks";

// Etiquetas das origens: as mesmas das Reservas do dia (classificador único).
export { ORIGIN_LABELS };

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;
type J = Record<string, any>;

// ─── Ajudantes puros ────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "object") return null;
  const s = String(v).trim();
  return s ? s : null;
}
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "t" || v === "true";
}
function obj(v: unknown): J | null {
  if (v == null) return null;
  if (typeof v === "string") {
    try { const p = JSON.parse(v); return p && typeof p === "object" && !Array.isArray(p) ? p : null; } catch { return null; }
  }
  return typeof v === "object" && !Array.isArray(v) ? (v as J) : null;
}
const iso = (v: unknown) => toIsoUtc(v);

/** URL http(s) abrível; caminhos internos da app devolvem null. PURA. */
export function openableUrl(v: unknown): string | null {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
}

/** Link de mapa para um par lat/lng (null se faltar ou for 0,0). PURA. */
export function mapLink(lat: unknown, lng: unknown): string | null {
  const a = num(lat);
  const b = num(lng);
  if (a == null || b == null || (a === 0 && b === 0) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return `https://www.google.com/maps?q=${a},${b}`;
}

// ─── Âmbito de cidade ───────────────────────────────────────────────────────

/**
 * Condição "a reserva `idMarker` é de um parque das cidades" (sem WHERE).
 * undefined = todas (TRUE); [] = nenhuma (FALSE). PURA.
 */
export function bookingScopeSql(params: ParamList, idMarker: string, cities: string[] | undefined): string {
  if (cities === undefined) return "TRUE";
  const aliases = cityAliases(cities);
  if (!aliases.length) return "FALSE";
  return `EXISTS (SELECT 1 FROM "Booking" sb JOIN "Park" sp ON sp."id" = sb."parkId" WHERE sb."id" = ${idMarker} AND lower(trim(sp."city")) IN (${aliases.map((c) => params.add(c)).join(", ")}))`;
}

// ─── Resolver id / n.º da reserva ───────────────────────────────────────────

export const RESOLVE_MAX_CANDIDATES = 20;

/** Limpa a referência escrita ("#29484 " → "29484"). PURA. */
export function normalizeRef(ref: string): string {
  return String(ref ?? "").trim().replace(/^#+/, "").trim().slice(0, 128);
}

/**
 * Procura por id da Multipark, n.º (allocation) ou referência externa do
 * parceiro. O id exato vem sempre primeiro. PURA.
 */
export function buildResolveSql(ref: string, cities?: string[]): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const r = normalizeRef(ref);
  const idP = params.add(r);
  const scope = bookingScopeSql(params, `b."id"`, cities);
  const sql = [
    `SELECT b."id" AS id, NULLIF(b."allocation", '') AS allocation, b."status"::text AS status,`,
    ` p."name" AS park_name, p."city" AS park_city, v."licensePlate" AS plate,`,
    ` to_char(b."checkInDate", 'YYYY-MM-DD') AS check_in_date, to_char(b."checkOutDate", 'YYYY-MM-DD') AS check_out_date`,
    `FROM "Booking" b`,
    `LEFT JOIN "Park" p ON p."id" = b."parkId"`,
    `LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
    `WHERE (b."id" = ${idP} OR b."allocation" = ${idP} OR b."externalReference" = ${idP}) AND ${scope}`,
    `ORDER BY (b."id" = ${idP}) DESC, b."checkInDate" DESC`,
    `LIMIT ${params.add(RESOLVE_MAX_CANDIDATES)}`,
  ].join("\n");
  return { sql, params: params.values };
}

export interface BookingCandidate {
  id: string;
  code: string | null;
  status: string | null;
  statusLabel: string;
  parkName: string | null;
  parkCity: string | null;
  plate: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
}

export type BookingResolution =
  | { kind: "found"; id: string }
  | { kind: "ambiguous"; candidates: BookingCandidate[] }
  | { kind: "not_found" };

export function mapCandidateRow(r: J): BookingCandidate {
  const status = str(r.status);
  return {
    id: String(r.id ?? ""),
    code: str(r.allocation),
    status,
    statusLabel: statusLabel(status),
    parkName: str(r.park_name),
    parkCity: str(r.park_city),
    plate: str(r.plate),
    checkInDate: str(r.check_in_date),
    checkOutDate: str(r.check_out_date),
  };
}

/**
 * Linhas da procura → resultado. Id exato ganha sempre; um só candidato
 * também; vários com o mesmo n.º (o n.º repete-se entre parques) → escolher.
 * `hintIds` (ids que a nossa BD associa à referência) desempata. PURA.
 */
export function pickResolution(ref: string, rows: J[], hintIds: readonly string[] = []): BookingResolution {
  const r = normalizeRef(ref);
  if (!rows.length) return { kind: "not_found" };
  const exact = rows.find((x) => String(x.id) === r);
  if (exact) return { kind: "found", id: String(exact.id) };
  if (rows.length === 1) return { kind: "found", id: String(rows[0].id) };
  const hinted = rows.filter((x) => hintIds.includes(String(x.id)));
  if (hinted.length === 1) return { kind: "found", id: String(hinted[0].id) };
  return { kind: "ambiguous", candidates: rows.map(mapCandidateRow) };
}

// ─── Etiquetas ──────────────────────────────────────────────────────────────

export const STATUS_LABELS: Record<string, string> = {
  PENDING: "Pendente",
  BOOKED: "Reservada",
  CHECKING_IN: "A entrar",
  CHECKED_IN: "No parque",
  MOVING: "Em movimento",
  PENDING_CHECKOUT: "À espera de saída",
  CHECKING_OUT: "A sair",
  CHECKED_OUT: "Entregue",
  CANCELLED: "Cancelada",
};
export function statusLabel(s: string | null | undefined): string {
  const k = String(s ?? "").toUpperCase();
  return STATUS_LABELS[k] ?? (k || "—");
}

export const CHANGE_TYPE_LABELS: Record<string, string> = {
  CREATED: "Criada",
  UPDATE: "Alteração",
  CHECKING_IN: "A entrar",
  CHECK_IN: "Check-in",
  MOVEMENT: "Movimento",
  PENDING_CHECKOUT: "À espera de saída",
  CHECKING_OUT: "A sair",
  CHECK_OUT: "Check-out",
  CANCEL: "Cancelamento",
};

/** Campos da reserva em PT-PT (histórico e diferenças). */
export const FIELD_LABELS: Record<string, string> = {
  status: "Estado",
  bookingPrice: "Preço",
  originalBookingPrice: "Preço original",
  parkingPrice: "Preço estacionamento",
  deliveryPrice: "Preço entrega",
  discountAmount: "Desconto",
  paymentMethod: "Método de pagamento",
  paymentBy: "Pago por",
  priceValidated: "Preço validado",
  checkIn: "Entrada",
  checkOut: "Saída",
  checkInDate: "Dia de entrada",
  checkOutDate: "Dia de saída",
  checkInTime: "Hora de entrada",
  checkOutTime: "Hora de saída",
  spotId: "Lugar",
  garageId: "Garagem",
  allocation: "N.º",
  allocationId: "Alocação",
  externalGarage: "Garagem (externa)",
  externalRow: "Fila (externa)",
  externalSpot: "Lugar (externo)",
  vehicleKms: "Km",
  vehicleRange: "Autonomia",
  remarks: "Notas",
  deliveryType: "Entrega",
  deliveryLocation: "Local de entrega",
  departingFlight: "Voo de ida",
  returnFlight: "Voo de regresso",
  departingFlightEta: "ETA voo de ida",
  returnFlightEta: "ETA voo de regresso",
  licensePlate: "Matrícula",
  brand: "Marca",
  model: "Modelo",
  color: "Cor",
  language: "Língua",
  taxName: "Nome fiscal",
  taxNumber: "NIF",
  taxAddress: "Morada fiscal",
  parkingType: "Tipo de lugar",
  cashValidated: "Dinheiro conferido",
  driverValidated: "Condutor validou",
  cashierClosed: "Caixa fechada",
  checkInDriverName: "Condutor da entrada",
  checkOutDriverName: "Condutor da saída",
  partnerId: "Parceiro",
  campaignId: "Campanha",
};
export function fieldLabel(f: string): string {
  return FIELD_LABELS[f] ?? f;
}

// ─── Diferenças antes → depois ──────────────────────────────────────────────

export interface FieldChange {
  field: string;
  label: string;
  from: string | null;
  to: string | null;
}

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Valor de uma diferença → texto curto. PURA. */
export function formatDiffValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? "sim" : "não";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    if (DATE_LIKE.test(s)) return toIsoUtc(s) ?? s;
    return s.length > 200 ? `${s.slice(0, 197)}…` : s;
  }
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? `${s.slice(0, 197)}…` : s;
  } catch { return String(v); }
}

const FROM_KEYS = ["from", "old", "before", "previous", "oldValue", "prev"];
const TO_KEYS = ["to", "new", "after", "current", "newValue", "next", "value"];

function pickKey(o: J, keys: string[]): { found: boolean; value: unknown } {
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(o, k)) return { found: true, value: o[k] };
  return { found: false, value: undefined };
}

function change(field: string, from: unknown, to: unknown): FieldChange {
  return { field, label: fieldLabel(field), from: formatDiffValue(from), to: formatDiffValue(to) };
}

/**
 * `History.modifiedFields` (texto) → lista de campos com antes → depois.
 * Aceita JSON objeto `{campo:{from,to}}`, JSON lista `[{field,from,to}]` ou
 * `["campo"]`, e texto simples ("campo: a -> b", ou só nomes separados por
 * vírgulas). PURA; nunca lança.
 */
export function parseModifiedFields(raw: unknown): FieldChange[] {
  if (raw == null) return [];
  let v: unknown = raw;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s || s === "{}" || s === "[]") return [];
    try { v = JSON.parse(s); } catch { return parsePlainChanges(s); }
  }
  const out: FieldChange[] = [];
  if (Array.isArray(v)) {
    for (const it of v.slice(0, 100)) {
      if (typeof it === "string") { if (it.trim()) out.push(change(it.trim(), undefined, undefined)); continue; }
      const o = obj(it);
      if (!o) continue;
      const field = str(o.field) ?? str(o.name) ?? str(o.key) ?? str(o.path);
      if (!field) continue;
      out.push(change(field, pickKey(o, FROM_KEYS).value, pickKey(o, TO_KEYS).value));
    }
    return out;
  }
  const o = obj(v);
  if (!o) return typeof v === "string" ? parsePlainChanges(v) : [];
  for (const [field, val] of Object.entries(o).slice(0, 100)) {
    const inner = obj(val);
    if (inner) {
      const f = pickKey(inner, FROM_KEYS);
      const t = pickKey(inner, TO_KEYS);
      if (f.found || t.found) { out.push(change(field, f.value, t.value)); continue; }
    }
    if (Array.isArray(val) && val.length === 2) { out.push(change(field, val[0], val[1])); continue; }
    out.push(change(field, undefined, val));
  }
  return out;
}

function parsePlainChanges(s: string): FieldChange[] {
  const out: FieldChange[] = [];
  for (const part of s.split(/[\n;,]+/).map((x) => x.trim()).filter(Boolean).slice(0, 100)) {
    const m = /^([^:=]+?)\s*[:=]\s*(.*?)\s*(?:->|→|=>)\s*(.*)$/.exec(part);
    if (m) out.push(change(m[1].trim(), m[2], m[3]));
    else out.push(change(part, undefined, undefined));
  }
  return out;
}

/** "Estado: BOOKED → CHECKING_IN" (ou só o nome quando não há valores). PURA. */
export function formatChange(c: FieldChange): string {
  if (c.from == null && c.to == null) return c.label;
  return `${c.label}: ${c.from ?? "—"} → ${c.to ?? "—"}`;
}

const DIFF_IGNORE = new Set(["updatedAt", "firebaseSyncedAt", "firebaseSyncError", "checkinSignature", "checkoutSignature"]);

/** Campos de topo que mudaram entre dois retratos (ActivityEvent). PURA. */
export function diffSnapshots(prev: unknown, next: unknown): FieldChange[] {
  const a = obj(prev);
  const b = obj(next);
  if (!a || !b) return [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: FieldChange[] = [];
  for (const k of keys) {
    if (DIFF_IGNORE.has(k)) continue;
    const x = a[k];
    const y = b[k];
    if (JSON.stringify(x ?? null) === JSON.stringify(y ?? null)) continue;
    out.push(change(k, x, y));
    if (out.length >= 60) break;
  }
  return out;
}

/** Resumo curto do retrato da reserva guardado no histórico. PURA. */
export function summarizeSnapshot(snap: unknown): string | null {
  const s = obj(snap);
  if (!s) return null;
  const parts: string[] = [];
  const st = str(s.status);
  if (st) parts.push(statusLabel(st));
  const place = [str(s.externalGarage), str(s.externalRow), str(s.externalSpot)].filter(Boolean).join(" ");
  if (place) parts.push(`lugar ${place}`);
  else if (str(s.spotId)) parts.push("com lugar");
  const km = str(s.vehicleKms);
  if (km) parts.push(`${km} km`);
  const price = num(s.bookingPrice);
  if (price != null) parts.push(`${price.toFixed(2)} €`);
  const pm = str(s.paymentMethod);
  if (pm) parts.push(pm);
  const cin = str(s.checkInDriverName);
  if (cin) parts.push(`entrada: ${cin}`);
  const cout = str(s.checkOutDriverName);
  if (cout) parts.push(`saída: ${cout}`);
  return parts.length ? parts.join(" · ") : null;
}

// ─── Reserva (cabeçalho, cliente, viatura, provas, caixa) ───────────────────

export interface BookingPhase { key: string; label: string; at: string }
export interface Validation { done: boolean; at: string | null; by: string | null }

export interface BookingFileCore {
  id: string;
  code: string | null;
  status: string | null;
  statusLabel: string;
  createdAt: string | null;
  updatedAt: string | null;
  phases: BookingPhase[];
  customerCheckinEtaMin: number | null;
  park: {
    id: string | null;
    name: string | null;
    city: string | null;
    firebaseBrand: string | null;
    listingType: string | null;
    status: string | null;
    /** Classificação (shared/multiparkParks.ts): nosso (marca + cidade) ou Marketplace. */
    ours: boolean;
    /** "Airpark Lisboa" ou "Marketplace". */
    groupLabel: string;
    /** Porquê, em texto curto. */
    reason: string;
    /** 8 out 2026: operado por nós (os nossos e os de terceiros fora da lista do dono) — etiqueta da comissão. */
    operated: boolean;
  };
  checkIn: { day: string | null; time: string | null; at: string | null };
  checkOut: { day: string | null; time: string | null; at: string | null };
  flights: {
    departing: { flight: string | null; eta: string | null };
    return: { flight: string | null; eta: string | null };
  };
  delivery: { type: string | null; location: string | null; price: number | null };
  parkingType: string | null;
  origin: {
    code: string | null;
    label: string;
    /** Canal para a contabilidade (Direto / Parceiro / Marketplace). */
    channel: BookingChannel;
    channelLabel: string;
    /** Porquê / quem ("Parkos (agregador)", "Parque de terceiros"). */
    channelDetail: string;
    /** Texto do distintivo: "Direto", "Parceiro · Parkos", "Marketplace". */
    badge: string;
    partnerName: string | null;
    partnerType: string | null;
    /** "agência" / "agregador" / "parceiro". */
    partnerTypeLabel: string | null;
    partnerFee: string | null;
    partnerAmountDue: number | null;
    partnerAmountPaid: number | null;
    externalReference: string | null;
    externalCampaign: string | null;
    originUrl: string | null;
  };
  price: {
    currency: string;
    bookingPrice: number | null;
    originalBookingPrice: number | null;
    parkingPrice: number | null;
    deliveryPrice: number | null;
    discountAmount: number | null;
    priceValidated: boolean;
    paymentMethod: string | null;
    paymentSource: string | null;
    paymentBy: string | null;
  };
  client: {
    name: string | null;
    email: string | null;
    phone: string | null;
    nif: string | null;
    taxName: string | null;
    language: string | null;
    anonymized: boolean;
  };
  vehicle: {
    plate: string | null;
    brand: string | null;
    model: string | null;
    color: string | null;
    type: string | null;
    seats: number | null;
    kms: string | null;
    range: string | null;
  };
  agents: { checkIn: string | null; checkOut: string | null };
  cashier: { driverValidated: Validation; cashValidated: Validation; cashierClosed: Validation };
  evidence: {
    video: { raw: string; url: string | null } | null;
    hasCheckinSignature: boolean;
    hasCheckoutSignature: boolean;
  };
  remarks: string | null;
  pro: boolean;
}

const PHASES: Array<[string, string]> = [
  ["createdAt", "Criada"],
  ["checkingInAt", "A entrar"],
  ["movingAt", "Em movimento"],
  ["pendingCheckoutAt", "À espera de saída"],
  ["arrivedAtDeliveryAt", "Chegou à entrega"],
  ["baggageWaitingAt", "À espera da bagagem"],
  ["checkingOutAt", "A sair"],
  ["cashierClosedAt", "Caixa fechada"],
];

function validation(b: J, key: "driverValidated" | "cashValidated" | "cashierClosed"): Validation {
  return { done: bool(b[key]), at: iso(b[`${key}At`]), by: str(b[`${key}ByName`]) ?? str(b[`${key}ById`]) };
}

function dayOf(v: unknown): string | null {
  const i = iso(v);
  return i ? i.slice(0, 10) : null;
}

export interface CoreRow { booking?: unknown; park?: unknown; vehicle?: unknown; client?: unknown; partner?: unknown; checkin_sig_len?: unknown; checkout_sig_len?: unknown }

/** Linha principal → ficha. PURA. */
export function mapCoreRow(r: CoreRow): BookingFileCore {
  const b = obj(r.booking) ?? {};
  const p = obj(r.park) ?? {};
  const v = obj(r.vehicle) ?? {};
  const c = obj(r.client) ?? {};
  const pa = obj(r.partner) ?? {};
  const status = str(b.status);
  const origin = str(b.origin);
  const partnerId = str(b.partnerId);
  const phases = PHASES
    .map(([key, label]) => ({ key, label, at: iso(b[key]) }))
    .filter((x): x is BookingPhase => !!x.at)
    .sort((x, y) => x.at.localeCompare(y.at));
  const feeType = str(b.partnerFeeType) ?? str(pa.feeType);
  const feeValue = num(b.partnerFeeValue) ?? (feeType === "FIXED" ? num(pa.feeFixedValue) : num(pa.feePercentage));
  const video = str(b.checkinVideo);
  const name = [str(c.firstName), str(c.lastName)].filter(Boolean).join(" ") || null;
  const parkCls = classifyPark({ name: str(p.name), city: str(p.city), address: str(p.address), firebaseBrand: str(p.firebaseBrand), listingType: str(p.listingType) });
  const ch = classifyBookingChannel({
    parkOurs: parkCls.ours, origin, partnerId, partnerName: str(pa.name), partnerType: str(pa.partnerType), paymentSource: str(b.paymentSource),
  });
  return {
    id: String(b.id ?? ""),
    code: str(b.allocation),
    status,
    statusLabel: statusLabel(status),
    createdAt: iso(b.createdAt),
    updatedAt: iso(b.updatedAt),
    phases,
    customerCheckinEtaMin: num(b.customerCheckinEta),
    park: {
      id: str(b.parkId) ?? str(p.id), name: str(p.name), city: str(p.city),
      firebaseBrand: str(p.firebaseBrand), listingType: parkCls.listingType, status: str(p.status),
      ours: parkCls.ours, groupLabel: parkCls.label, reason: parkCls.reason,
      operated: marketplaceOperated({ id: str(b.parkId) ?? str(p.id), name: str(p.name), ours: parkCls.ours }),
    },
    checkIn: { day: dayOf(b.checkInDate), time: str(b.checkInTime), at: iso(b.checkIn) },
    checkOut: { day: dayOf(b.checkOutDate), time: str(b.checkOutTime), at: iso(b.checkOut) },
    flights: {
      departing: { flight: str(b.departingFlight), eta: iso(b.departingFlightEta) },
      return: { flight: str(b.returnFlight), eta: iso(b.returnFlightEta) },
    },
    delivery: { type: str(b.deliveryType), location: str(b.deliveryLocation), price: num(b.deliveryPrice) },
    parkingType: str(b.parkingType),
    origin: {
      code: origin,
      label: origin ? ORIGIN_LABELS[origin] ?? origin : "—",
      channel: ch.channel,
      channelLabel: BOOKING_CHANNEL_LABELS[ch.channel],
      channelDetail: ch.detail,
      badge: ch.badge,
      partnerName: str(pa.name),
      partnerType: str(pa.partnerType),
      partnerTypeLabel: ch.partnerTypeLabel,
      partnerFee: feeType && feeValue != null ? (feeType === "FIXED" ? `${feeValue} €` : `${feeValue} %`) : null,
      partnerAmountDue: num(b.partnerAmountDue),
      partnerAmountPaid: num(b.partnerAmountPaid),
      externalReference: str(b.externalReference),
      externalCampaign: str(b.externalCampaign),
      originUrl: openableUrl(b.originUrl),
    },
    price: {
      currency: str(b.currency) ?? "EUR",
      bookingPrice: num(b.bookingPrice),
      originalBookingPrice: num(b.originalBookingPrice),
      parkingPrice: num(b.parkingPrice),
      deliveryPrice: num(b.deliveryPrice),
      discountAmount: num(b.discountAmount),
      priceValidated: bool(b.priceValidated),
      paymentMethod: str(b.paymentMethod),
      paymentSource: str(b.paymentSource),
      paymentBy: str(b.paymentBy),
    },
    client: {
      name,
      email: str(c.email),
      phone: str(c.phoneNumber),
      nif: str(c.nif) ?? str(b.taxNumber),
      taxName: str(c.taxName) ?? str(b.taxName),
      language: str(b.language),
      anonymized: !!iso(c.anonymizedAt),
    },
    vehicle: {
      plate: str(v.licensePlate),
      brand: str(v.brand),
      model: str(v.model),
      color: str(v.color),
      type: str(v.vehicleType),
      seats: num(v.seats),
      kms: str(b.vehicleKms),
      range: str(b.vehicleRange),
    },
    agents: { checkIn: str(b.checkInDriverName) ?? str(b.checkInDriverId), checkOut: str(b.checkOutDriverName) ?? str(b.checkOutDriverId) },
    cashier: { driverValidated: validation(b, "driverValidated"), cashValidated: validation(b, "cashValidated"), cashierClosed: validation(b, "cashierClosed") },
    evidence: {
      video: video ? { raw: video, url: openableUrl(video) } : null,
      hasCheckinSignature: (num(r.checkin_sig_len) ?? 0) > 0,
      hasCheckoutSignature: (num(r.checkout_sig_len) ?? 0) > 0,
    },
    remarks: str(b.remarks),
    pro: bool(b.pro),
  };
}

/** SQL da reserva (sem as assinaturas: só o tamanho). PURA. */
export function buildCoreSql(id: string, cities?: string[]): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const idP = params.add(id);
  const scope = bookingScopeSql(params, idP, cities);
  const sql = [
    `SELECT to_jsonb(b) - 'checkinSignature' - 'checkoutSignature' - 'disputeEvents' AS booking,`,
    ` length(to_jsonb(b) ->> 'checkinSignature') AS checkin_sig_len,`,
    ` length(to_jsonb(b) ->> 'checkoutSignature') AS checkout_sig_len,`,
    ` to_jsonb(p) - 'terms' - 'images' - 'certificate' - 'logo' - 'iban' - 'bic' AS park,`,
    ` to_jsonb(v) AS vehicle,`,
    ` to_jsonb(c) - 'iban' - 'mitTransactionId' AS client,`,
    ` to_jsonb(pa) - 'agentsAllowedToCreateBookings' AS partner`,
    `FROM "Booking" b`,
    `LEFT JOIN "Park" p ON p."id" = b."parkId"`,
    `LEFT JOIN "BookingVehicle" v ON v."id" = b."vehicleId"`,
    `LEFT JOIN "Client" c ON c."id" = COALESCE(b."customerId", b."clientId")`,
    `LEFT JOIN "Partner" pa ON pa."id" = b."partnerId"`,
    `WHERE b."id" = ${idP} AND ${scope}`,
    `LIMIT 1`,
  ].join("\n");
  return { sql, params: params.values };
}

// ─── Onde está o carro ──────────────────────────────────────────────────────

export interface BookingLocation {
  code: string | null;
  allocation: { name: string | null; prefix: string | null; parkingType: string | null } | null;
  garage: { name: string | null; parkingType: string | null; mapLink: string | null } | null;
  spot: { row: string | null; spot: string | null; size: string | null; hasCharger: boolean; chargerPower: string | null } | null;
  external: { garage: string | null; row: string | null; spot: string | null } | null;
}

export function buildLocationSql(id: string, cities?: string[]): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const idP = params.add(id);
  const scope = bookingScopeSql(params, idP, cities);
  const sql = [
    `SELECT jsonb_build_object('allocation', b."allocation", 'externalGarage', to_jsonb(b) ->> 'externalGarage',`,
    ` 'externalRow', to_jsonb(b) ->> 'externalRow', 'externalSpot', to_jsonb(b) ->> 'externalSpot') AS b,`,
    ` to_jsonb(s) AS spot, to_jsonb(g) AS garage, to_jsonb(al) AS alloc`,
    `FROM "Booking" b`,
    `LEFT JOIN "Spot" s ON s."id" = b."spotId"`,
    `LEFT JOIN "Garage" g ON g."id" = COALESCE(b."garageId", s."garageId")`,
    `LEFT JOIN "Allocation" al ON al."id" = b."allocationId"`,
    `WHERE b."id" = ${idP} AND ${scope}`,
    `LIMIT 1`,
  ].join("\n");
  return { sql, params: params.values };
}

export function mapLocationRow(r: J | undefined): BookingLocation | null {
  if (!r) return null;
  const b = obj(r.b) ?? {};
  const s = obj(r.spot);
  const g = obj(r.garage);
  const a = obj(r.alloc);
  const ext = { garage: str(b.externalGarage), row: str(b.externalRow), spot: str(b.externalSpot) };
  return {
    code: str(b.allocation),
    allocation: a ? { name: str(a.name), prefix: str(a.prefix), parkingType: str(a.parkingType) } : null,
    garage: g ? { name: str(g.name), parkingType: str(g.parkingType), mapLink: openableUrl(g.mapLink) } : null,
    spot: s ? { row: str(s.row), spot: str(s.spot), size: str(s.size), hasCharger: bool(s.hasCharger), chargerPower: str(s.chargerPower) } : null,
    external: ext.garage || ext.row || ext.spot ? ext : null,
  };
}

// ─── Partes genéricas (uma tabela = uma parte) ─────────────────────────────

/** SQL "linhas de uma tabela filha desta reserva", com âmbito. PURA. */
export function buildChildSql(opts: {
  select: string;
  from: string;
  where: (idP: string) => string;
  order: string;
  limit: number;
}, id: string, cities?: string[]): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const idP = params.add(id);
  const scope = bookingScopeSql(params, idP, cities);
  const sql = [
    `SELECT ${opts.select}`,
    `FROM ${opts.from}`,
    `WHERE ${opts.where(idP)} AND ${scope}`,
    `ORDER BY ${opts.order}`,
    `LIMIT ${params.add(Math.min(Math.max(Math.floor(opts.limit), 1), 500))}`,
  ].join("\n");
  return { sql, params: params.values };
}

export const CHILD_SQL = {
  drivers: { select: `to_jsonb(d) AS d`, from: `"Driver" d`, where: (id: string) => `d."bookingId" = ${id}`, order: `d."id"`, limit: 10 },
  attachments: { select: `to_jsonb(a) AS a`, from: `"Attachment" a`, where: (id: string) => `a."bookingId" = ${id}`, order: `a."createdAt" ASC`, limit: 100 },
  pricing: { select: `to_jsonb(bp) AS l`, from: `"BookingPricing" bp`, where: (id: string) => `bp."bookingId" = ${id}`, order: `bp."createdAt" ASC, bp."id"`, limit: 100 },
  payments: {
    select: `to_jsonb(pp) AS pay, bp."description" AS line`,
    from: `"BookingPricingPayment" pp JOIN "BookingPricing" bp ON bp."id" = pp."pricingId"`,
    where: (id: string) => `bp."bookingId" = ${id}`,
    order: `pp."recordedAt" ASC`,
    limit: 200,
  },
  billing: { select: `to_jsonb(bi) - 'periodKeys' - 'parkIds' AS bi`, from: `"Billing" bi`, where: (id: string) => `bi."bookingId" = ${id}`, order: `bi."createdAt" ASC`, limit: 50 },
  cancellation: { select: `to_jsonb(ca) AS ca`, from: `"Cancellation" ca`, where: (id: string) => `ca."bookingId" = ${id}`, order: `ca."createdAt" DESC`, limit: 1 },
  extras: {
    select: `to_jsonb(e) AS e, es."name" AS catalog_name, es."price" AS catalog_price`,
    from: [
      `"BookingExtraService" e`,
      `JOIN "Booking" eb ON eb."id" = e."bookingId"`,
      `LEFT JOIN LATERAL (SELECT x."name", x."price" FROM "ExtraService" x WHERE x."parkId" = eb."parkId" AND lower(x."name") = lower(e."name") LIMIT 1) es ON TRUE`,
    ].join("\n"),
    where: (id: string) => `e."bookingId" = ${id}`,
    order: `e."name" ASC`,
    limit: 100,
  },
  history: {
    select: `to_jsonb(h) - 'snapshot' - 'userAgent' AS h, to_jsonb(h) -> 'snapshot' AS snap, ag."name" AS agent`,
    from: [
      `"History" h`,
      `JOIN "Booking" hb ON hb."id" = h."bookingId"`,
      `LEFT JOIN "Agent" ag ON ag."userId" = h."userId" AND ag."parkId" = hb."parkId"`,
    ].join("\n"),
    where: (id: string) => `h."bookingId" = ${id}`,
    order: `h."actionTime" DESC, h."id" DESC`,
    limit: 300,
  },
  activity: {
    select: `to_jsonb(ae) - 'userAgent' - 'metadata' - 'eventPayload' AS ae`,
    from: `"ActivityEvent" ae`,
    where: (id: string) => `ae."entityId" = ${id}`,
    order: `ae."timestamp" DESC`,
    limit: 200,
  },
  chat: {
    select: `to_jsonb(m) AS m, att."url" AS attachment_url`,
    from: `"ChatMessage" m LEFT JOIN "Attachment" att ON att."id" = m."attachmentId"`,
    where: (id: string) => `m."bookingId" = ${id}`,
    order: `m."createdAt" ASC`,
    limit: 300,
  },
  emails: {
    select: `to_jsonb(el) - 'metadata' AS el`,
    from: `"EntityEmailLog" el`,
    where: (id: string) => `el."entityType"::text = 'BOOKING' AND el."entityId" = ${id}`,
    order: `el."sentAt" DESC`,
    limit: 100,
  },
  occurrences: {
    select: `to_jsonb(o) AS o, ag."name" AS agent, ar."name" AS resolver`,
    from: [
      `"Occurrence" o`,
      `LEFT JOIN "Agent" ag ON ag."userId" = o."userId" AND ag."parkId" = o."parkId"`,
      `LEFT JOIN "Agent" ar ON ar."userId" = o."resolvedById" AND ar."parkId" = o."parkId"`,
    ].join("\n"),
    where: (id: string) => `o."bookingId" = ${id}`,
    order: `o."createdAt" DESC`,
    limit: 50,
  },
  review: { select: `to_jsonb(r) AS r`, from: `"BookingReview" r`, where: (id: string) => `r."bookingId" = ${id}`, order: `r."createdAt" DESC`, limit: 1 },
} as const;
export type ChildKey = keyof typeof CHILD_SQL;

export function buildChild(key: ChildKey, id: string, cities?: string[]) {
  return buildChildSql(CHILD_SQL[key], id, cities);
}

// ─── Mapeadores das partes ──────────────────────────────────────────────────

export interface ThirdPartyDriver { name: string | null; email: string | null; phone: string | null }
export function mapDriverRow(r: J): ThirdPartyDriver {
  const d = obj(r.d) ?? {};
  return { name: [str(d.firstName), str(d.lastName)].filter(Boolean).join(" ") || null, email: str(d.email), phone: str(d.phoneNumber) };
}

export interface BookingAttachment { id: string; type: string | null; typeLabel: string; raw: string | null; url: string | null; createdAt: string | null }
export const ATTACHMENT_LABELS: Record<string, string> = {
  VEHICLE_VIDEO: "Vídeo da viatura",
  VEHICLE_PHOTO: "Foto da viatura",
  SIGN_DOCUMENT: "Documento assinado",
  PAYMENT_PROOF: "Comprovativo de pagamento",
  DOCUMENT: "Documento",
  CREDIT_NOTE: "Nota de crédito",
  INVOICE_WITH_CREDIT_NOTE: "Fatura com nota de crédito",
  OTHER: "Outro",
};
export function mapAttachmentRow(r: J): BookingAttachment {
  const a = obj(r.a) ?? {};
  const type = str(a.type);
  return { id: String(a.id ?? ""), type, typeLabel: (type && ATTACHMENT_LABELS[type]) ?? type ?? "Anexo", raw: str(a.url), url: openableUrl(a.url), createdAt: iso(a.createdAt) };
}

export interface PricingLine { id: string; description: string | null; category: string | null; total: number | null; amountPaid: number | null; paymentMethod: string | null; createdAt: string | null }
export function mapPricingRow(r: J): PricingLine {
  const l = obj(r.l) ?? {};
  return { id: String(l.id ?? ""), description: str(l.description), category: str(l.category), total: num(l.total), amountPaid: num(l.amountPaid), paymentMethod: str(l.paymentMethod), createdAt: iso(l.createdAt) };
}

export interface PricingPayment { id: string; line: string | null; amount: number | null; paymentMethod: string | null; recordedAt: string | null }
export function mapPaymentRow(r: J): PricingPayment {
  const p = obj(r.pay) ?? {};
  return { id: String(p.id ?? ""), line: str(r.line), amount: num(p.amount), paymentMethod: str(p.paymentMethod), recordedAt: iso(p.recordedAt) };
}

export interface BillingDoc { id: string; invoice: string | null; invoiceExpressId: number | null; invoiceExpressType: string | null; emitted: boolean; amount: number | null; currency: string | null; provider: string | null; description: string | null; createdAt: string | null }
export function mapBillingRow(r: J): BillingDoc {
  const b = obj(r.bi) ?? {};
  return {
    id: String(b.id ?? ""), invoice: str(b.invoice), invoiceExpressId: num(b.invoiceExpressId), invoiceExpressType: str(b.invoiceExpressType),
    emitted: bool(b.emited), amount: num(b.amount), currency: str(b.currency), provider: str(b.provider), description: str(b.description), createdAt: iso(b.createdAt),
  };
}

export interface CancellationInfo { type: string | null; notes: string | null; refund: boolean; refunded: boolean; refundedAmount: number | null; refundedAt: string | null; createdAt: string | null }
export function mapCancellationRow(r: J | undefined): CancellationInfo | null {
  const c = obj(r?.ca);
  if (!c) return null;
  return { type: str(c.cancellationType), notes: str(c.cancellationObs), refund: bool(c.refund), refunded: bool(c.refunded), refundedAmount: num(c.refundedAmount), refundedAt: iso(c.refundedAt), createdAt: iso(c.createdAt) };
}

export interface ExtraServiceLine { id: string; name: string | null; description: string | null; price: number | null; catalogPrice: number | null; inCatalog: boolean; done: boolean; vehicleType: string | null }
export function mapExtraRow(r: J): ExtraServiceLine {
  const e = obj(r.e) ?? {};
  return {
    id: String(e.id ?? ""), name: str(e.name), description: str(e.description), price: num(e.price),
    catalogPrice: num(r.catalog_price), inCatalog: !!str(r.catalog_name), done: bool(e.done), vehicleType: str(e.vehicleType),
  };
}

export interface TimelineEntry {
  id: string;
  source: "history" | "activity";
  at: string | null;
  kind: string | null;
  kindLabel: string;
  who: string | null;
  role: string | null;
  platform: string | null;
  changes: FieldChange[];
  snapshotSummary: string | null;
  remarks: string | null;
  gps: { lat: number; lng: number; url: string } | null;
}

export function mapHistoryRow(r: J): TimelineEntry {
  const h = obj(r.h) ?? {};
  const kind = str(h.changeType);
  const url = mapLink(h.lat, h.lng);
  return {
    id: `h:${String(h.id ?? "")}`,
    source: "history",
    at: iso(h.actionTime),
    kind,
    kindLabel: (kind && CHANGE_TYPE_LABELS[kind]) ?? kind ?? "Ação",
    who: str(h.agentName) ?? str(r.agent) ?? str(h.userId),
    role: null,
    platform: str(h.platform),
    changes: parseModifiedFields(h.modifiedFields),
    snapshotSummary: summarizeSnapshot(r.snap),
    remarks: str(h.remarks),
    gps: url ? { lat: Number(h.lat), lng: Number(h.lng), url } : null,
  };
}

export function mapActivityRow(r: J): TimelineEntry {
  const a = obj(r.ae) ?? {};
  const kind = str(a.eventType);
  return {
    id: `a:${String(a.id ?? "")}`,
    source: "activity",
    at: iso(a.timestamp),
    kind,
    kindLabel: kind ?? str(a.i18nTitleKey) ?? "Evento",
    who: str(a.actorDisplayName) ?? str(a.actorEmail) ?? str(a.actorId),
    role: str(a.actorRole),
    platform: str(a.platform),
    changes: diffSnapshots(a.previousSnapshot, a.snapshot),
    snapshotSummary: summarizeSnapshot(a.snapshot),
    remarks: str(a.remarks),
    gps: null,
  };
}

/** Junta e ordena (mais recente primeiro). PURA. */
export function mergeTimeline(a: TimelineEntry[], b: TimelineEntry[]): TimelineEntry[] {
  return [...a, ...b].sort((x, y) => (y.at ?? "").localeCompare(x.at ?? ""));
}

export interface ChatLine { id: string; at: string | null; senderName: string | null; senderRole: string | null; content: string | null; readByPark: boolean; readByClient: boolean; attachmentUrl: string | null; hasAttachment: boolean }
export function mapChatRow(r: J): ChatLine {
  const m = obj(r.m) ?? {};
  return {
    id: String(m.id ?? ""), at: iso(m.createdAt), senderName: str(m.senderName), senderRole: str(m.senderRole), content: str(m.content),
    readByPark: bool(m.readByPark), readByClient: bool(m.readByClient), attachmentUrl: openableUrl(r.attachment_url), hasAttachment: bool(m.hasAttachment) || !!str(r.attachment_url),
  };
}

export interface EmailLogLine { id: string; sentAt: string | null; emailType: string | null; recipient: string | null; subject: string | null; sentBy: string | null }
export function mapEmailRow(r: J): EmailLogLine {
  const e = obj(r.el) ?? {};
  return { id: String(e.id ?? ""), sentAt: iso(e.sentAt), emailType: str(e.emailType), recipient: str(e.recipientEmail), subject: str(e.subject), sentBy: str(e.sentByUserId) };
}

export interface BookingOccurrence { id: string; title: string; priority: string | null; resolved: boolean; createdAt: string | null; createdBy: string | null; resolvedAt: string | null; resolvedBy: string | null; remarks: string | null; attachmentUrl: string | null; attachment: string | null; gpsUrl: string | null }
export function mapBookingOccurrenceRow(r: J): BookingOccurrence {
  const o = obj(r.o) ?? {};
  const att = str(o.attachment);
  return {
    id: String(o.id ?? ""), title: str(o.title) ?? "Ocorrência", priority: str(o.priority), resolved: bool(o.resolved), createdAt: iso(o.createdAt),
    createdBy: str(o.agentName) ?? str(r.agent), resolvedAt: iso(o.resolvedAt), resolvedBy: str(o.resolvedByName) ?? str(r.resolver),
    remarks: str(o.remarks), attachment: att, attachmentUrl: openableUrl(att), gpsUrl: mapLink(o.lat, o.lng),
  };
}

export interface BookingReviewInfo { rating: number | null; text: string | null; clientName: string | null; createdAt: string | null }
export function mapReviewRow(r: J | undefined): BookingReviewInfo | null {
  const v = obj(r?.r);
  if (!v) return null;
  return { rating: num(v.rating), text: str(v.comment), clientName: str(v.clientName), createdAt: iso(v.createdAt) };
}

// ─── Assinaturas (só quando se abre a secção) ───────────────────────────────

/** Máximo por assinatura enviada ao browser (as PNG costumam ter < 100 KB). */
export const SIGNATURE_MAX_CHARS = 1_500_000;

export type SignatureImage = { kind: "image"; src: string } | { kind: "link"; url: string } | { kind: "internal"; raw: string } | { kind: "too_large" } | null;

/** Texto guardado → imagem mostrável. PURA. */
export function normalizeSignature(v: unknown): SignatureImage {
  const s = str(v);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return { kind: "link", url: s };
  if (s.length > SIGNATURE_MAX_CHARS) return { kind: "too_large" };
  if (/^data:image\/(png|jpe?g|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) return { kind: "image", src: s.replace(/\s+/g, "") };
  const b64 = s.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length >= 40) {
    const mime = b64.startsWith("/9j/") ? "image/jpeg" : "image/png";
    return { kind: "image", src: `data:${mime};base64,${b64}` };
  }
  return { kind: "internal", raw: s.slice(0, 300) };
}

export function buildSignaturesSql(id: string, cities?: string[]): { sql: string; params: SqlParam[] } {
  const params = new ParamList();
  const idP = params.add(id);
  const scope = bookingScopeSql(params, idP, cities);
  return {
    sql: [
      `SELECT to_jsonb(b) ->> 'checkinSignature' AS checkin_sig, to_jsonb(b) ->> 'checkoutSignature' AS checkout_sig`,
      `FROM "Booking" b`,
      `WHERE b."id" = ${idP} AND ${scope}`,
      `LIMIT 1`,
    ].join("\n"),
    params: params.values,
  };
}

// ─── Leituras (nunca lançam) ────────────────────────────────────────────────

export interface PartsResult<T> {
  data: T;
  /** Partes que não se conseguiram ler (tabela/coluna em falta, tempo…). */
  missing: Array<{ part: string; reason: string }>;
}

/**
 * Corre várias leituras (em sequência — a pool tem 2 ligações) e junta-as.
 * Uma parte que falha fica `fallback` e vai para `missing`; se TODAS falharem
 * a secção inteira fica indisponível. Nunca lança.
 */
export async function readParts<T extends object>(
  label: string,
  parts: { [K in keyof T]: { fallback: T[K]; run: () => Promise<T[K]> } },
): Promise<MultiparkRead<PartsResult<T>>> {
  const keys = Object.keys(parts) as Array<keyof T>;
  const data = {} as T;
  const missing: Array<{ part: string; reason: string }> = [];
  let lastFail: { code: MultiparkReadUnavailableCode; reason: string } | null = null;
  for (const k of keys) {
    const r = await safeMultiparkRead(`${label}/${String(k)}`, parts[k].run);
    if (r.available) data[k] = r.data;
    else {
      data[k] = parts[k].fallback;
      missing.push({ part: String(k), reason: r.reason });
      lastFail = { code: r.code, reason: r.reason };
      // Sem configuração ou sem ligação: não vale a pena tentar as outras.
      if (r.code === "NOT_CONFIGURED" || r.code === "CONNECT_FAILED") break;
    }
  }
  if (lastFail && missing.length >= keys.length) return { available: false, ...lastFail };
  if (lastFail && (lastFail.code === "NOT_CONFIGURED" || lastFail.code === "CONNECT_FAILED")) return { available: false, ...lastFail };
  return { available: true, data: { data, missing } };
}

async function rows(key: ChildKey, id: string, cities: string[] | undefined, query: Query): Promise<J[]> {
  const { sql, params } = buildChild(key, id, cities);
  return query<J>(sql, params);
}

/** Id ou n.º → reserva (ou candidatos). */
export async function resolveBookingRef(ref: string, cities: string[] | undefined, hintIds: readonly string[] = [], query: Query = multiparkDbQuery): Promise<MultiparkRead<BookingResolution>> {
  return safeMultiparkRead("ficha/resolver", async () => {
    if (!normalizeRef(ref)) return { kind: "not_found" } as BookingResolution;
    const { sql, params } = buildResolveSql(ref, cities);
    return pickResolution(ref, await query<J>(sql, params), hintIds);
  });
}

export interface BookingFileMain {
  core: BookingFileCore | null;
  location: BookingLocation | null;
  drivers: ThirdPartyDriver[];
}

export async function getBookingFileMain(id: string, cities: string[] | undefined, query: Query = multiparkDbQuery) {
  return readParts<BookingFileMain>("ficha/reserva", {
    core: {
      fallback: null,
      run: async () => {
        const { sql, params } = buildCoreSql(id, cities);
        const r = await query<CoreRow>(sql, params);
        return r[0] ? mapCoreRow(r[0]) : null;
      },
    },
    location: {
      fallback: null,
      run: async () => {
        const { sql, params } = buildLocationSql(id, cities);
        return mapLocationRow((await query<J>(sql, params))[0]);
      },
    },
    drivers: { fallback: [], run: async () => (await rows("drivers", id, cities, query)).map(mapDriverRow) },
  });
}

export async function getBookingFileEvidence(id: string, cities: string[] | undefined, query: Query = multiparkDbQuery) {
  return readParts<{ attachments: BookingAttachment[] }>("ficha/provas", {
    attachments: { fallback: [], run: async () => (await rows("attachments", id, cities, query)).map(mapAttachmentRow) },
  });
}

export async function getBookingFileSignatures(id: string, cities: string[] | undefined, query: Query = multiparkDbQuery) {
  return safeMultiparkRead("ficha/assinaturas", async () => {
    const { sql, params } = buildSignaturesSql(id, cities);
    const r = (await query<J>(sql, params))[0];
    return { checkin: normalizeSignature(r?.checkin_sig), checkout: normalizeSignature(r?.checkout_sig) };
  });
}

export async function getBookingFileAccounts(id: string, cities: string[] | undefined, query: Query = multiparkDbQuery) {
  return readParts<{ pricing: PricingLine[]; payments: PricingPayment[]; billing: BillingDoc[]; cancellation: CancellationInfo | null }>("ficha/contas", {
    pricing: { fallback: [], run: async () => (await rows("pricing", id, cities, query)).map(mapPricingRow) },
    payments: { fallback: [], run: async () => (await rows("payments", id, cities, query)).map(mapPaymentRow) },
    billing: { fallback: [], run: async () => (await rows("billing", id, cities, query)).map(mapBillingRow) },
    cancellation: { fallback: null, run: async () => mapCancellationRow((await rows("cancellation", id, cities, query))[0]) },
  });
}

export async function getBookingFileExtras(id: string, cities: string[] | undefined, query: Query = multiparkDbQuery) {
  return readParts<{ extras: ExtraServiceLine[] }>("ficha/extras", {
    extras: { fallback: [], run: async () => (await rows("extras", id, cities, query)).map(mapExtraRow) },
  });
}

export async function getBookingFileTimeline(id: string, cities: string[] | undefined, query: Query = multiparkDbQuery) {
  const r = await readParts<{ history: TimelineEntry[]; activity: TimelineEntry[] }>("ficha/linha-do-tempo", {
    history: { fallback: [], run: async () => (await rows("history", id, cities, query)).map(mapHistoryRow) },
    activity: { fallback: [], run: async () => (await rows("activity", id, cities, query)).map(mapActivityRow) },
  });
  if (!r.available) return r;
  return { available: true as const, data: { entries: mergeTimeline(r.data.data.history, r.data.data.activity), missing: r.data.missing } };
}

export async function getBookingFileCommunication(id: string, cities: string[] | undefined, query: Query = multiparkDbQuery) {
  return readParts<{ chat: ChatLine[]; emails: EmailLogLine[] }>("ficha/comunicacao", {
    chat: { fallback: [], run: async () => (await rows("chat", id, cities, query)).map(mapChatRow) },
    emails: { fallback: [], run: async () => (await rows("emails", id, cities, query)).map(mapEmailRow) },
  });
}

export async function getBookingFileFeedback(id: string, cities: string[] | undefined, query: Query = multiparkDbQuery) {
  return readParts<{ occurrences: BookingOccurrence[]; review: BookingReviewInfo | null }>("ficha/ocorrencias", {
    occurrences: { fallback: [], run: async () => (await rows("occurrences", id, cities, query)).map(mapBookingOccurrenceRow) },
    review: { fallback: null, run: async () => mapReviewRow((await rows("review", id, cities, query))[0]) },
  });
}

