/**
 * Extras Dia — Daily Forecast & Driver Allocation
 *
 * Fonte das reservas (fase 5B): LIDAS AO VIVO da BD da Multipark
 * (server/multiparkDb/extrasBookings.ts — parques nossos da cidade, sem
 * canceladas). Se a BD não estiver configurada/disponível, volta à cópia
 * `multipark_bookings` (como antes) e a página mostra um aviso
 * (`bookingSource` / `bookingSourceNotice`). Com a leitura ao vivo o trabalho
 * `multipark-future` saiu. Sem chamadas à API da Multipark: o detalhe da cópia
 * local vem do webhook (multipark-deliveries).
 *
 *   - Hourly check-ins / check-outs for tomorrow (or chosen base date + 1)
 *   - Lavagem (wash) counts for context days
 *   - Driver shift suggestion (tempo por carro conforme as pessoas no turno,
 *     TL incluído, POR CIDADE — definição `extras.crewRules` (D12, Jorge
 *     3 out): Lisboa 2→75 / 3–4→60 / 5–6→45 / 7+→30 min; Porto e Faro
 *     2→45 / 3+→30 min, mínimo 2 extras + TL — turnos de 3–12h)
 *
 * Driver levels are flat — all do everything — so the cheapest tier wins.
 */

import { cityNameScope, projectScope } from './cityScope';
import { and, asc, eq, gte, lte, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { DEFAULT_EXTRA_RATES, loadExtraRates, rateFor, type ExtraRates } from "./extraRates";
import { multiparkBookings, extrasDiaAssignments, employees, projects, users } from "../drizzle/schema";
import { DEFAULT_CREW_RULES } from "../shared/appSettings";
import { FALLBACK_CARS_PER_HOUR, MAX_SHIFT_HOURS as SHIFT_MAX, MIN_SHIFT_HOURS as SHIFT_MIN, describeCrewRule, extrasNeededFor, type CrewRule } from "../shared/extrasSchedule";
import { lisbonDayOf, lisbonWallTimeUtcMs } from "../shared/lisbonDay";
import type { LiveExtrasBooking } from "./multiparkDb/extrasBookings";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Níveis e taxas POR DEFEITO — as taxas vivas vêm de `extra_rates` (server/extraRates.ts). */
export const DRIVER_LEVELS = [
  { id: "junior", label: "Júnior", hourlyRate: 4.5 },
  { id: "senior", label: "Sénior", hourlyRate: 5 },
  { id: "terminal", label: "Terminal", hourlyRate: 5.5 },
  { id: "master", label: "Master", hourlyRate: 6 },
] as const;

export type DriverLevelId = (typeof DRIVER_LEVELS)[number]["id"];

/** (Antigo) carros/hora fixos — a capacidade viva é a tabela por equipa (`extras.crewRules`, loadCrewRule). */
export const CARS_PER_HOUR_PER_DRIVER = FALLBACK_CARS_PER_HOUR;
export const MIN_SHIFT_HOURS = SHIFT_MIN;
export const MAX_SHIFT_HOURS = SHIFT_MAX;
export const TL_WORKING_DAYS_PER_MONTH = 15;
export const SLOT_MINUTES = 20;
export const SLOTS_PER_HOUR = 60 / SLOT_MINUTES; // 3
export const SLOTS_PER_DAY = 24 * SLOTS_PER_HOUR; // 72
// O forecast cobre 27h: 00:00–24:00 do dia alvo + 00:00–03:00 do seguinte
// (para o turno da noite que vai até às 03:00).
export const FORECAST_HOURS = 27;
export const FORECAST_SLOTS = FORECAST_HOURS * SLOTS_PER_HOUR; // 81


export type ShiftId = "morning" | "night";

// Manhã: 03:00 → 15:00 (12h). Noite: 15:00 → 03:00 do dia seguinte (12h).
export const SHIFT_BOUNDS: Record<ShiftId, { startHour: number; endHour: number }> = {
  morning: { startHour: 3, endHour: 15 },
  night: { startHour: 15, endHour: 27 }, // 27 = 03h do dia seguinte
};

// A API Multipark devolve datas/horas em UTC; convertemos UTC → fuso da operação
// ao ler as reservas (via Intl, com DST). NÃO é offset fixo. O fuso é
// configurável (default Europe/Lisbon); quando houver Extras-Dia noutras cidades/
// países, passa-se o fuso respetivo a fetchBookingsInRange/getExtrasDiaForecast.
const OPERATION_TZ = process.env.OPERATION_TZ || "Europe/Lisbon";
const _tzFmtCache = new Map<string, Intl.DateTimeFormat>();
function tzFmt(tz: string): Intl.DateTimeFormat {
  let f = _tzFmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      });
    } catch {
      f = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      });
    }
    _tzFmtCache.set(tz, f);
  }
  return f;
}

function utcToLocal(s: string | null, tz: string = OPERATION_TZ): string | null {
  if (!s) return s;
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return s;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0));
  const p: Record<string, string> = {};
  for (const part of tzFmt(tz).formatToParts(d)) p[part.type] = part.value;
  const hh = p.hour === "24" ? "00" : p.hour; // Intl pode dar "24"
  return `${p.year}-${p.month}-${p.day} ${hh}:${p.minute}:${p.second}`;
}

// Multi-cidade (2026-08-06, pedido Jorge): o Extras-Dia existia so para
// Lisboa; agora o MESMO modulo serve Lisboa/Porto/Faro por parametro.
export type ExtraCity = "lisbon" | "porto" | "faro";
export const EXTRA_CITIES: Array<{ id: ExtraCity; label: string }> = [
  { id: "lisbon", label: "Lisboa" },
  { id: "porto", label: "Porto" },
  { id: "faro", label: "Faro" },
];
const CITY_CONFIG: Record<ExtraCity, { re: RegExp; pattern: string; prefix: string }> = {
  lisbon: { re: /lisb/i, pattern: "%lisb%", prefix: "LISBON_%" },
  porto: { re: /porto/i, pattern: "%porto%", prefix: "PORTO_%" },
  faro: { re: /faro/i, pattern: "%faro%", prefix: "FARO_%" },
};

// Resolve os projectIds da arvore da cidade (no cidade + descendentes),
// EXATAMENTE como a folha operacional. Cacheado por processo e por cidade.
/** Tempo por carro conforme as pessoas no turno, da cidade (Definições → Parâmetros), com omissões (D12). */
export async function loadCrewRule(city: ExtraCity): Promise<CrewRule> {
  let map: Partial<Record<ExtraCity, CrewRule>> | null = null;
  try {
    const { getSetting } = await import("./appSettings");
    map = await getSetting("extras.crewRules");
  } catch { /* sem BD → omissões */ }
  return map?.[city] ?? DEFAULT_CREW_RULES[city];
}

export function cityLabel(city: ExtraCity): string {
  return EXTRA_CITIES.find(c => c.id === city)?.label ?? city;
}

const _cityProjectIds = new Map<ExtraCity, number[]>();
async function getCityProjectIds(city: ExtraCity): Promise<number[]> {
  const cached = _cityProjectIds.get(city);
  if (cached) return cached;
  const db = await getDb();
  if (!db) return [];
  const all = await db
    .select({ id: projects.id, parentId: projects.parentId, name: projects.name, level: projects.level })
    .from(projects);
  const ids = new Set<number>();
  const addChildren = (parentId: number) => {
    ids.add(parentId);
    for (const p of all) if (p.parentId === parentId) addChildren(p.id);
  };
  for (const p of all) if (p.level === "city" && CITY_CONFIG[city].re.test(p.name)) addChildren(p.id);
  const out = Array.from(ids);
  _cityProjectIds.set(city, out);
  return out;
}

const LAVAGEM_RE = /lavag|wash/i;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function dateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toMysqlDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function hourOf(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours();
}

function minuteOf(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return null;
  return d.getMinutes();
}

function parseScheduledHM(
  timeStr: string | null,
  fallbackIso: string | null,
): { hour: number; minute: number } | null {
  if (timeStr && /^\d{1,2}:\d{2}/.test(timeStr)) {
    const [hh, mm] = timeStr.split(":");
    const h = parseInt(hh, 10);
    const m = parseInt(mm, 10);
    if (h >= 0 && h < 24 && m >= 0 && m < 60) return { hour: h, minute: m };
  }
  const h = hourOf(fallbackIso);
  const m = minuteOf(fallbackIso);
  if (h !== null && m !== null) return { hour: h, minute: m };
  return null;
}

function bookingHasLavagem(rawJson: string | null): boolean {
  if (!rawJson) return false;
  try {
    const data = JSON.parse(rawJson);
    const extras = data?.extraServices;
    if (!Array.isArray(extras)) return false;
    return extras.some((e: any) => {
      const name = typeof e === "string" ? e : e?.name;
      return typeof name === "string" && LAVAGEM_RE.test(name);
    });
  } catch {
    return false;
  }
}

// ─── Driver allocation ───────────────────────────────────────────────────────

export interface DriverShift {
  startHour: number;
  endHour: number;
  hours: number;
  level: DriverLevelId;
  label: string;
  hourlyRate: number;
  cost: number;
}

export function suggestShifts(
  hourlyCars: number[],
  level: DriverLevelId = "junior",
  rates?: ExtraRates,
  crewRule: CrewRule = DEFAULT_CREW_RULES.lisbon,
): { shifts: DriverShift[]; totalCost: number; peakDrivers: number; totalDriverHours: number } {
  const base = DRIVER_LEVELS.find(l => l.id === level)!;
  const rateInfo = { ...base, hourlyRate: rates ? rateFor(rates, level) : base.hourlyRate };
  const driversPerHour = hourlyCars.map(c => extrasNeededFor(c, crewRule));
  const peak = Math.max(0, ...driversPerHour);

  if (peak === 0) {
    return { shifts: [], totalCost: 0, peakDrivers: 0, totalDriverHours: 0 };
  }

  const shifts: DriverShift[] = [];

  for (let slot = 0; slot < peak; slot++) {
    const active: number[] = [];
    for (let h = 0; h < driversPerHour.length; h++) if (driversPerHour[h] > slot) active.push(h);
    if (active.length === 0) continue;

    const start = active[0];
    const end = active[active.length - 1] + 1;
    let span = end - start;
    if (span < MIN_SHIFT_HOURS) span = MIN_SHIFT_HOURS;

    let cursor = start;
    while (span > 0) {
      const chunk = Math.min(span, MAX_SHIFT_HOURS);
      shifts.push({
        startHour: cursor,
        endHour: cursor + chunk,
        hours: chunk,
        level: rateInfo.id,
        label: rateInfo.label,
        hourlyRate: rateInfo.hourlyRate,
        cost: chunk * rateInfo.hourlyRate,
      });
      cursor += chunk;
      span -= chunk;
    }
  }

  const totalDriverHours = shifts.reduce((s, x) => s + x.hours, 0);
  const totalCost = shifts.reduce((s, x) => s + x.cost, 0);
  return { shifts, totalCost, peakDrivers: peak, totalDriverHours };
}

// ─── Forecast (DB-based) ─────────────────────────────────────────────────────

export interface HourlyRow {
  hour: number;
  checkins: number;
  checkouts: number;
  driversNeeded: number;
  hasT2: boolean; // alguma reserva com Terminal 2
  hasOther: boolean; // alguma reserva fora de T1/T2/VIP (Partidas, Oriente, Rossio, Faro, ...)
  slots: Slot20Row[]; // 3 slots per hour
}

export type DeliveryClass = "t1" | "t2" | "vip" | "other" | "unknown";

export function classifyDeliveryType(dt: string | null | undefined): DeliveryClass {
  if (!dt) return "unknown";
  const x = dt.toLowerCase();
  if (x.includes("terminal 1")) return "t1";
  if (x.includes("terminal 2")) return "t2";
  if (x === "vip" || x.endsWith(" vip")) return "vip";
  return "other";
}

export interface Slot20Row {
  hour: number;
  slot: number; // 0, 1, or 2 (00-19, 20-39, 40-59 minutes)
  checkins: number;
  checkouts: number;
  // Procura "pesada" — tem em conta T2 (30min) e Outro (60min) ocupando o slot
  // mesmo quando a reserva começa noutro slot anterior.
  weightedDemand: number;
  driversNeeded: number;
}

export interface DailyWash {
  date: string;
  exitsWithWash: number;
}

export interface ExtrasDiaForecast {
  baseDate: string;
  targetDate: string;
  city: string;
  /** Id da cidade (lisbon/porto/faro). */
  cityId: ExtraCity;
  /** Regra de capacidade usada nesta previsão (tempo por carro conforme as pessoas no turno, D12) e o texto dela. */
  crewRule: CrewRule;
  crewRuleText: string;
  source: "db";
  /** De onde vieram as reservas: BD da Multipark ao vivo, ou a nossa cópia (recurso). */
  bookingSource: BookingSource;
  /** Aviso quando se usou a cópia (BD da Multipark indisponível / não configurada). */
  bookingSourceNotice: string | null;
  /**
   * Leitura das reservas cortada no limite: a previsão está INCOMPLETA (faltam
   * reservas). A automação não propõe nem avisa faltas com ela.
   */
  bookingsTruncated: boolean;
  parksQueried: string[]; // parques da cidade (ao vivo) ou distinct parkName (cópia)
  parksFailed: { park: string; error: string }[]; // always empty for DB mode (kept for UI compat)
  hourly: HourlyRow[];
  totals: {
    checkins: number;
    checkouts: number;
    operations: number;
  };
  spotTypeCounts: {
    covered: number;
    uncovered: number;
    indoor: number;
    unknown: number;
  };
  // Mesma classificação mas separada por sentido — para mostrar debaixo
  // dos KPIs de Chegadas e Saídas.
  spotTypeByDirection: {
    checkin: { covered: number; uncovered: number; indoor: number; unknown: number };
    checkout: { covered: number; uncovered: number; indoor: number; unknown: number };
  };
  // Soma de extrasTotal das reservas no dia. Estimativa = reservas com
  // data ainda no futuro; real = reservas com data já passada.
  extrasValue: {
    estimate: number;
    real: number;
    total: number;
  };
  washes: {
    base: DailyWash;
    target: DailyWash;
    next: DailyWash;
  };
  allocation: {
    cheapest: ReturnType<typeof suggestShifts>;
    bySingleLevel: { level: DriverLevelId; label: string; totalCost: number; totalHours: number }[];
  };
  /** Taxas €/h em vigor (null = a conta não vê custos). Antes o ecrã pedia-as a uma rota só de admin e caía nas de origem. */
  rates: ExtraRates | null;
  /** true = os euros foram tirados (a conta só vê escalas e turnos). */
  costsHidden: boolean;
}

/** Previsão sem euros para quem não vê custos (as horas e as pessoas ficam). PURA. */
export function maskForecastCosts(f: ExtrasDiaForecast): ExtrasDiaForecast {
  const zero = (s: DriverShift): DriverShift => ({ ...s, hourlyRate: 0, cost: 0 });
  return {
    ...f,
    rates: null,
    costsHidden: true,
    allocation: {
      cheapest: { ...f.allocation.cheapest, totalCost: 0, shifts: f.allocation.cheapest.shifts.map(zero) },
      bySingleLevel: f.allocation.bySingleLevel.map((l) => ({ ...l, totalCost: 0 })),
    },
  };
}

export type BookingRow = {
  id: number;
  externalId: string;
  bookingNumber: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  licensePlate: string | null;
  checkIn: string | null;
  checkOut: string | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  rawJson: string | null;
  parkName: string | null;
  city: string | null;
  deliveryType: string | null;
  enrichedAt: string | null;
  spotType: string | null;
  extrasTotal: string | null; // decimal as string
};

export interface BookingSummary {
  id: number;
  externalId: string;
  bookingNumber: string | null;
  clientName: string;
  licensePlate: string | null;
  parkName: string | null;
  time: string; // HH:mm
  deliveryType: string | null;
}

async function fetchBookingsInRange(
  field: "checkIn" | "checkOut",
  startInclusive: Date,
  endExclusive: Date,
  city: ExtraCity = "lisbon",
): Promise<BookingRow[]> {
  const db = await getDb();
  if (!db) return [];

  const col = field === "checkIn" ? multiparkBookings.checkIn : multiparkBookings.checkOut;
  const startStr = toMysqlDateTime(startInclusive);
  const endStr = toMysqlDateTime(endExclusive);

  // Mesmo critério de "Lisboa" que a folha operacional: árvore de projeto.
  // Fallback ao texto da cidade só se a árvore não resolver (defensivo).
  const cityIds = await getCityProjectIds(city);
  const cfg = CITY_CONFIG[city];
  const lisbonCond = cityIds.length
    ? inArray(multiparkBookings.projectId, cityIds)
    : sql`(LOWER(${multiparkBookings.city}) LIKE ${cfg.pattern} OR ${multiparkBookings.parkId} LIKE ${cfg.prefix})`;

  const rows = await db
    .select({
      id: multiparkBookings.id,
      externalId: multiparkBookings.externalId,
      bookingNumber: multiparkBookings.bookingNumber,
      clientFirstName: multiparkBookings.clientFirstName,
      clientLastName: multiparkBookings.clientLastName,
      licensePlate: multiparkBookings.licensePlate,
      checkIn: multiparkBookings.checkIn,
      checkOut: multiparkBookings.checkOut,
      checkInTime: multiparkBookings.checkInTime,
      checkOutTime: multiparkBookings.checkOutTime,
      rawJson: multiparkBookings.rawJson,
      parkName: multiparkBookings.parkName,
      city: multiparkBookings.city,
      deliveryType: multiparkBookings.deliveryType,
      enrichedAt: multiparkBookings.enrichedAt,
      spotType: multiparkBookings.spotType,
      extrasTotal: multiparkBookings.extrasTotal,
    })
    .from(multiparkBookings)
    .where(
      and(
        gte(col, startStr),
        lte(col, endStr),
        sql`${multiparkBookings.status} != 'CANCELLED'`,
        lisbonCond,
      ),
    )
    .limit(COPY_ROWS_LIMIT);

  // Converte UTC → Lisboa nas horas das reservas (a API dá UTC). As horas-string
  // soltas (checkInTime/checkOutTime, normalmente vazias e em UTC) são anuladas
  // para o bucketing usar o check-in/out já convertido.
  return rows.map(r => ({
    ...r,
    checkIn: utcToLocal(r.checkIn),
    checkOut: utcToLocal(r.checkOut),
    checkInTime: null,
    checkOutTime: null,
  }));
}

// ─── Reservas ao vivo (BD da Multipark) com recurso à cópia ──────────────────

export type BookingSource = "multipark-db" | "copy";

/** "AAAA-MM-DD HH:MM:SS" (hora de parede de Lisboa) → instante UTC (ms). PURA. */
export function lisbonWallToUtcMs(wall: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(wall);
  if (!m) throw new Error(`Hora inválida: ${wall}`);
  return lisbonWallTimeUtcMs(m[1], Number(m[2])) + Number(m[3]) * 60_000 + Number(m[4] ?? 0) * 1000;
}

/**
 * Reserva lida ao vivo → a linha que o resto deste módulo já sabe tratar
 * (horas em hora de parede de Lisboa, extras em rawJson para as lavagens).
 * `enrichedAt` preenchido: o tipo de entrega já vem da BD (não se vai à API). PURA.
 */
export function liveToBookingRow(b: LiveExtrasBooking, index: number): BookingRow {
  return {
    id: -(index + 1),
    externalId: b.externalId,
    bookingNumber: b.bookingNumber,
    clientFirstName: b.clientFirstName,
    clientLastName: b.clientLastName,
    licensePlate: b.licensePlate,
    checkIn: utcToLocal(b.checkInUtc),
    checkOut: utcToLocal(b.checkOutUtc),
    checkInTime: null,
    checkOutTime: null,
    rawJson: JSON.stringify({ extraServices: b.extraNames.map((name) => ({ name })) }),
    parkName: b.parkName,
    city: b.city,
    deliveryType: b.deliveryType,
    enrichedAt: "bd-multipark",
    spotType: b.spotType,
    extrasTotal: b.extrasTotal ? String(b.extrasTotal) : null,
  };
}

/** Linhas com a entrada/saída (hora de Lisboa) em [start, end). PURA. */
export function filterRowsByField(rows: BookingRow[], field: "checkIn" | "checkOut", startInclusive: Date, endExclusive: Date): BookingRow[] {
  const s = toMysqlDateTime(startInclusive);
  const e = toMysqlDateTime(endExclusive);
  return rows.filter((r) => {
    const v = field === "checkIn" ? r.checkIn : r.checkOut;
    return v != null && v >= s && v < e;
  });
}

type LiveWindow = { ok: true; rows: BookingRow[]; parks: string[]; truncated: boolean } | { ok: false; notice: string };

/** Teto da leitura de recurso (cópia): chegar a ele = previsão incompleta. */
export const COPY_ROWS_LIMIT = 20000;

/**
 * Reservas da cidade com entrada ou saída na janela [start, end) (horas de
 * parede de Lisboa), lidas ao vivo. `ok:false` → usar a cópia (com aviso).
 */
async function liveBookingsInWindow(startInclusive: Date, endExclusive: Date, city: ExtraCity): Promise<LiveWindow> {
  try {
    const { getLiveExtrasBookings } = await import("./multiparkDb/extrasBookings");
    const { getSetting } = await import("./appSettings");
    // "Parques que a operação não faz" (Definições) ficam fora da previsão e dos blocos.
    const excluded = (await getSetting("operations.excludedParks")) ?? [];
    const r = await getLiveExtrasBookings(city, lisbonWallToUtcMs(toMysqlDateTime(startInclusive)), lisbonWallToUtcMs(toMysqlDateTime(endExclusive)), undefined, undefined, excluded);
    if (!r.available) return { ok: false, notice: `${r.reason} A usar a cópia das reservas (pode estar desatualizada).` };
    if (r.data.truncated) console.warn(`[extrasDia] leitura ao vivo cortada (${r.data.bookings.length} reservas) — ${city}`);
    return { ok: true, rows: r.data.bookings.map(liveToBookingRow), parks: r.data.parks, truncated: r.data.truncated };
  } catch (err: any) {
    return { ok: false, notice: `Leitura ao vivo falhou (${String(err?.message ?? err).slice(0, 80)}). A usar a cópia das reservas.` };
  }
}

// ─── Assignments (gestor escala pessoas a turnos) ────────────────────────────

export interface Assignment {
  id: number;
  assignmentDate: string;
  employeeId: number | null;
  personName: string;
  level: DriverLevelId | null; // null when TL
  isTeamLeader: boolean;
  shift: ShiftId;
  startHour: number;
  endHour: number;
  sentHomeHour: number | null;
  notes: string | null;
  /** 'proposed' (proposta automática por confirmar) | 'confirmed'. */
  status: "proposed" | "confirmed";
  /** Sobe quando muda pessoa/dia/horas (1 aviso por versão). */
  version: number;
  /** "Porquê" da proposta automática. */
  proposalReason: string | null;
  hoursBilled: number;
  cost: number;
  /** Quem pôs / alterou por último (D14: os nomes aparecem na linha da escala). */
  createdById?: number | null;
  updatedById?: number | null;
  createdByName?: string | null;
  updatedByName?: string | null;
  /** 'auto' (proposta automática) | 'manual' */
  source?: string;
  // Mapeamento Multipark (preenchido se employeeId está associado a empregado RH)
  multiparkAgentName: string | null;
  multiparkAgentUserId: string | null;
  photoUrl: string | null;
}

/**
 * Derive "primeiro + último nome" de um nome completo. A API Multipark
 * agent/history usa este formato. Pode ser sobrescrito por mapping manual.
 */
export function deriveShortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return fullName.trim();
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

export function computeAssignmentCost(row: {
  level: DriverLevelId | null;
  isTeamLeader: boolean;
  startHour: number;
  endHour: number;
  sentHomeHour: number | null;
  tlDailyCost?: number; // monthlySalary / 15
}, rates: ExtraRates = DEFAULT_EXTRA_RATES): { hoursBilled: number; cost: number } {
  const end = row.sentHomeHour ?? row.endHour;
  const hours = Math.max(0, end - row.startHour);
  if (row.isTeamLeader) {
    // TL: fixed daily cost; ignore hours.
    return { hoursBilled: hours, cost: row.tlDailyCost ?? 0 };
  }
  const rate = row.level ? rateFor(rates, row.level) : 0;
  return { hoursBilled: hours, cost: hours * rate };
}

function rowToAssignment(
  r: typeof extrasDiaAssignments.$inferSelect,
  tlDailyCost?: number,
  multiparkAgentName?: string | null,
  multiparkAgentUserId?: string | null,
  photoUrl?: string | null,
  rates: ExtraRates = DEFAULT_EXTRA_RATES,
): Assignment {
  const isTL = r.isTeamLeader === 1;
  const level = (r.level as DriverLevelId | null) ?? null;
  const computed = computeAssignmentCost({
    level,
    isTeamLeader: isTL,
    startHour: r.startHour,
    endHour: r.endHour,
    sentHomeHour: r.sentHomeHour,
    tlDailyCost,
  }, rates);
  return {
    id: r.id,
    assignmentDate: r.assignmentDate,
    employeeId: r.employeeId,
    personName: r.personName,
    level,
    isTeamLeader: isTL,
    shift: (r.shift as ShiftId) ?? "morning",
    startHour: r.startHour,
    endHour: r.endHour,
    sentHomeHour: r.sentHomeHour,
    notes: r.notes,
    status: r.status === "proposed" ? "proposed" : "confirmed",
    version: r.version ?? 1,
    proposalReason: r.proposalReason ?? null,
    multiparkAgentName: multiparkAgentName ?? null,
    multiparkAgentUserId: multiparkAgentUserId ?? null,
    photoUrl: photoUrl ?? null,
    createdById: r.createdById ?? null,
    updatedById: r.updatedById ?? null,
    source: r.source ?? "manual",
    ...computed,
  };
}

async function getEmployeeDailyCost(employeeId: number | null): Promise<number> {
  if (!employeeId) return 0;
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ monthlySalary: employees.monthlySalary })
    .from(employees)
    .where(eq(employees.id, employeeId))
    .limit(1);
  if (!row?.monthlySalary) return 0;
  const monthly = parseFloat(String(row.monthlySalary));
  if (!Number.isFinite(monthly)) return 0;
  return monthly / TL_WORKING_DAYS_PER_MONTH;
}

export async function listAssignments(date: string, city?: ExtraCity): Promise<Assignment[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(extrasDiaAssignments)
    .where(and(cityNameScope(extrasDiaAssignments.city), eq(extrasDiaAssignments.assignmentDate, date), city ? eq(extrasDiaAssignments.city, city) : undefined))
    .orderBy(asc(extrasDiaAssignments.startHour));

  const rates = await loadExtraRates();
  // Pre-fetch dos empregados associados (mapeamento Multipark)
  const empIds = Array.from(new Set(rows.map(r => r.employeeId).filter((x): x is number => x !== null)));
  const empMap = new Map<number, { multiparkAgentName: string | null; multiparkAgentUserId: string | null; photoUrl: string | null }>();
  if (empIds.length > 0) {
    const empRows = await db
      .select({
        id: employees.id,
        multiparkAgentName: employees.multiparkAgentName,
        multiparkAgentUserId: employees.multiparkAgentUserId,
        photoUrl: employees.photoUrl,
      })
      .from(employees)
      .where(sql`${employees.id} IN (${sql.raw(empIds.join(","))})`);
    for (const e of empRows) {
      empMap.set(e.id, {
        multiparkAgentName: e.multiparkAgentName,
        multiparkAgentUserId: e.multiparkAgentUserId,
        photoUrl: e.photoUrl,
      });
    }
  }

  // D14: nomes de quem pôs e de quem alterou por último (utilizadores)
  const userIds = Array.from(new Set(rows.flatMap((r) => [r.createdById, r.updatedById]).filter((x): x is number => x != null && x > 0)));
  const userNames = new Map<number, string>();
  if (userIds.length > 0) {
    const us = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds));
    for (const u of us) if (u.name) userNames.set(u.id, u.name);
  }

  // Resolve TL daily cost for each TL row (employees.monthlySalary / 15)
  const result: Assignment[] = [];
  for (const r of rows) {
    let tlCost: number | undefined;
    if (r.isTeamLeader === 1) {
      tlCost = await getEmployeeDailyCost(r.employeeId);
    }
    const map = r.employeeId ? empMap.get(r.employeeId) : undefined;
    const a = rowToAssignment(r, tlCost, map?.multiparkAgentName, map?.multiparkAgentUserId, map?.photoUrl, rates);
    a.createdByName = r.createdById ? userNames.get(r.createdById) ?? null : null;
    a.updatedByName = r.updatedById ? userNames.get(r.updatedById) ?? null : null;
    result.push(a);
  }
  return result;
}

export interface UpsertAssignmentInput {
  city?: ExtraCity;
  id?: number;
  assignmentDate: string;
  employeeId?: number | null;
  personName: string;
  level?: DriverLevelId | null;
  isTeamLeader?: boolean;
  shift: ShiftId;
  startHour: number;
  endHour: number;
  sentHomeHour?: number | null;
  notes?: string | null;
  createdById?: number | null;
  /** Quem grava (fica como "alterado por" numa edição). */
  updatedById?: number | null;
  /** 'auto' só para a proposta automática; à mão é sempre 'manual'. */
  source?: "auto" | "manual";
  /** Omissão: 'proposed' se o dia/cidade tem uma proposta por confirmar; senão 'confirmed'. */
  status?: "proposed" | "confirmed";
  proposalReason?: string | null;
}

/** A versão sobe quando muda o que foi avisado (pessoa, dia, turno ou horas). PURA. */
export function assignmentVersionChanged(
  prev: { employeeId: number | null; assignmentDate: string; startHour: number; endHour: number; shift: string; personName: string },
  next: { employeeId: number | null; assignmentDate: string; startHour: number; endHour: number; shift: string; personName: string },
): boolean {
  return prev.employeeId !== next.employeeId || prev.assignmentDate !== next.assignmentDate
    || prev.startHour !== next.startHour || prev.endHour !== next.endHour || prev.shift !== next.shift
    || (prev.employeeId == null && prev.personName !== next.personName);
}

/** Conflito de escala (a mesma pessoa a horas sobrepostas): o router devolve 409. */
export class ScheduleConflictError extends Error {}

/** Outra linha da mesma pessoa no mesmo dia com horas sobrepostas ([início, fim)). PURA. */
export function findScheduleOverlap<T extends { id: number; startHour: number; endHour: number }>(
  sameDay: T[], cand: { id: number | null; startHour: number; endHour: number },
): T | null {
  return sameDay.find((r) => r.id !== cand.id && r.startHour < cand.endHour && cand.startHour < r.endHour) ?? null;
}

export async function upsertAssignment(input: UpsertAssignmentInput): Promise<Assignment | null> {
  const db = await getDb();
  if (!db) return null;

  const isTL = !!input.isTeamLeader;

  // 1 TL per (date, shift).
  if (isTL) {
    const existing = await db
      .select({ id: extrasDiaAssignments.id })
      .from(extrasDiaAssignments)
      .where(
        and(
          eq(extrasDiaAssignments.assignmentDate, input.assignmentDate),
          eq(extrasDiaAssignments.shift, input.shift),
          eq(extrasDiaAssignments.city, input.city ?? "lisbon"),
          eq(extrasDiaAssignments.isTeamLeader, 1),
        ),
      );
    const other = existing.find(e => e.id !== (input.id ?? -1));
    if (other) {
      const label = input.shift === "morning" ? "manhã" : "noite";
      throw new Error(`Já existe um Team Leader para o turno da ${label} deste dia.`);
    }
  }

  const payload = {
    assignmentDate: input.assignmentDate,
    city: input.city ?? "lisbon",
    employeeId: input.employeeId ?? null,
    personName: input.personName,
    level: isTL ? null : (input.level ?? "junior"),
    isTeamLeader: isTL ? 1 : 0,
    shift: input.shift,
    startHour: input.startHour,
    endHour: input.endHour,
    sentHomeHour: input.sentHomeHour ?? null,
    notes: input.notes ?? null,
  };

  // A mesma pessoa não fica em duas linhas com horas sobrepostas no mesmo dia
  // (nesta ou noutra cidade) — o caminho "um a um" não tinha esta verificação.
  if (payload.employeeId != null) {
    const sameDay = await db
      .select({ id: extrasDiaAssignments.id, city: extrasDiaAssignments.city, startHour: extrasDiaAssignments.startHour, endHour: extrasDiaAssignments.endHour })
      .from(extrasDiaAssignments)
      .where(and(eq(extrasDiaAssignments.assignmentDate, payload.assignmentDate), eq(extrasDiaAssignments.employeeId, payload.employeeId)));
    const clash = findScheduleOverlap(sameDay, { id: input.id ?? null, startHour: payload.startHour, endHour: payload.endHour });
    if (clash) throw new ScheduleConflictError(`${payload.personName} já está na escala deste dia das ${clash.startHour}h às ${clash.endHour}h${clash.city !== payload.city ? ` (${clash.city})` : ""}.`);
  }

  if (input.id) {
    const [prev] = await db.select().from(extrasDiaAssignments).where(eq(extrasDiaAssignments.id, input.id)).limit(1);
    if (!prev) return null;
    const bump = assignmentVersionChanged(prev, { ...payload, shift: payload.shift });
    // Editar não apaga as notas (o formulário de horas não as manda); quem
    // edita fica registado e a linha passa a "à mão" (a proposta refeita já não a substitui).
    const { notes: _notes, ...rest } = payload;
    await db.update(extrasDiaAssignments).set({
      ...rest,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      source: input.source ?? "manual",
      updatedById: input.updatedById ?? null,
      ...(input.status ? { status: input.status } : {}),
      ...(input.proposalReason !== undefined ? { proposalReason: input.proposalReason } : {}),
      ...(bump ? { version: sql`${extrasDiaAssignments.version} + 1` } : {}),
    } as any).where(eq(extrasDiaAssignments.id, input.id));
    const [row] = await db
      .select()
      .from(extrasDiaAssignments)
      .where(eq(extrasDiaAssignments.id, input.id))
      .limit(1);
    if (!row) return null;
    googleShiftChanged({ city: row.city, date: String(row.assignmentDate), employeeIds: [prev.employeeId, row.employeeId] });
    const tlCost = row.isTeamLeader === 1 ? await getEmployeeDailyCost(row.employeeId) : undefined;
    return rowToAssignment(row, tlCost, undefined, undefined, undefined, await loadExtraRates());
  }

  let status = input.status;
  if (!status) {
    const { getScheduleState } = await import("./extrasSchedule");
    const state = await getScheduleState(input.assignmentDate, payload.city as ExtraCity);
    status = state?.status === "proposed" ? "proposed" : "confirmed";
  }
  const [result] = await db
    .insert(extrasDiaAssignments)
    .values({ ...payload, status, proposalReason: input.proposalReason ?? null, createdById: input.createdById ?? null, source: input.source ?? "manual" })
    .$returningId();
  const newId = (result as any).id;
  const [row] = await db
    .select()
    .from(extrasDiaAssignments)
    .where(eq(extrasDiaAssignments.id, newId))
    .limit(1);
  if (!row) return null;
  if (status === "confirmed") googleShiftChanged({ city: row.city, date: String(row.assignmentDate), employeeIds: [row.employeeId] });
  const tlCost = row.isTeamLeader === 1 ? await getEmployeeDailyCost(row.employeeId) : undefined;
  return rowToAssignment(row, tlCost, undefined, undefined, undefined, await loadExtraRates());
}

/**
 * Escala mudou → turnos já para o Google Calendar (calendário partilhado da
 * cidade + calendário "Multipark" de quem está escalado), em segundo plano.
 */
function googleShiftChanged(input: { city: string | null; date: string; employeeIds: Array<number | null | undefined> }): void {
  import("./google/pendingSync")
    .then((m) => m.scheduleGoogleShiftSync({ city: input.city, date: input.date.slice(0, 10), employeeIds: input.employeeIds.filter((x): x is number => typeof x === "number") }))
    .catch(() => undefined);
}

// ─── Drill-down: reservas num slot de 20min ──────────────────────────────────

export async function getBookingsInSlot(
  targetDate: string,
  hour: number,
  slot: number,
  type: "checkin" | "checkout",
  city: ExtraCity = "lisbon",
): Promise<BookingSummary[]> {
  const day = new Date(targetDate + "T00:00:00");
  const targetStartLocal = startOfDay(day);
  // Para hours 0-23 fica no mesmo dia; para 24-26 (=00-02 de D+1) busca D+1.
  const dayOffset = Math.floor(hour / 24);
  const dayStart = addDays(targetStartLocal, dayOffset);
  const dayEnd = addDays(dayStart, 1);
  const hourLocal = hour % 24;
  const field = type === "checkin" ? "checkIn" : "checkOut";
  const live = await liveBookingsInWindow(dayStart, dayEnd, city);
  const rows = live.ok ? filterRowsByField(live.rows, field, dayStart, dayEnd) : await fetchBookingsInRange(field, dayStart, dayEnd, city);

  const slotStart = slot * SLOT_MINUTES;
  const slotEnd = slotStart + SLOT_MINUTES;

  type Pending = { row: BookingRow; summary: BookingSummary };
  const pendings: Pending[] = [];
  for (const r of rows) {
    const hm = type === "checkin"
      ? parseScheduledHM(r.checkInTime, r.checkIn)
      : parseScheduledHM(r.checkOutTime, r.checkOut);
    if (!hm || hm.hour !== hourLocal) continue;
    if (hm.minute < slotStart || hm.minute >= slotEnd) continue;
    const name = [r.clientFirstName, r.clientLastName].filter(Boolean).join(" ").trim();
    const pad = (n: number) => String(n).padStart(2, "0");
    pendings.push({
      row: r,
      summary: {
        id: r.id,
        externalId: r.externalId,
        bookingNumber: r.bookingNumber,
        clientName: name || "—",
        licensePlate: r.licensePlate,
        parkName: r.parkName,
        time: `${pad(hm.hour)}:${pad(hm.minute)}`,
        deliveryType: r.deliveryType,
      },
    });
  }

  return pendings.map(p => p.summary).sort((a, b) => a.time.localeCompare(b.time));
}

// ─── Driver candidates (para dropdown na UI) ─────────────────────────────────

export interface DriverCandidate {
  id: number;
  fullName: string;
  position: string;
  extraLevel: number | null;
  suggestedLevel: DriverLevelId;
  photoUrl: string | null;
  // Preenchido quando se passa uma data: disponibilidade declarada pelo extra
  // para esse dia (alimenta a escala do Extras-Dia). null = não aplicável.
  availability?: import("./extrasAvailability").DayAvailability | null;
}

const POSITION_TO_LEVEL: Record<string, DriverLevelId> = {
  driver: "junior",
  senior_driver: "senior",
  team_leader: "terminal",
  supervisor: "master",
  director: "master",
};

function suggestLevel(position: string | null | undefined, extraLevel: number | null | undefined): DriverLevelId {
  if (typeof extraLevel === "number") {
    if (extraLevel >= 4) return "master";
    if (extraLevel >= 3) return "terminal";
    if (extraLevel >= 2) return "senior";
    return "junior";
  }
  return POSITION_TO_LEVEL[(position ?? "").toLowerCase()] ?? "junior";
}

// Posições que podem ser TL sem permissão especial
const TL_POSITIONS = new Set(["team_leader", "supervisor", "director"]);

export async function listDriverCandidates(date?: string, opts?: { forTeamLeader?: boolean }): Promise<DriverCandidate[]> {
  const db = await getDb();
  if (!db) return [];
  let rows = await db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      position: employees.position,
      extraLevel: employees.extraLevel,
      isActive: employees.isActive,
      photoUrl: employees.photoUrl,
      userId: employees.userId,
    })
    .from(employees)
    .where(and(eq(employees.isActive, 1), projectScope(employees.projectId)))
    .orderBy(asc(employees.fullName));

  // TL (pedido Jorge): só aparecem posições de chefia OU quem tiver a
  // permissão explícita extras_dia.team_leader — os extras normais saem da
  // lista (antes apareciam todos).
  if (opts?.forTeamLeader) {
    const { listUserIdsWithGrant } = await import("./db");
    const granted = new Set(await listUserIdsWithGrant("extras_dia.team_leader"));
    rows = rows.filter(r =>
      TL_POSITIONS.has((r.position ?? "").toLowerCase()) ||
      (r.userId != null && granted.has(r.userId)),
    );
  }

  // Disponibilidade declarada para o dia, se uma data foi pedida.
  let availMap: Map<number, import("./extrasAvailability").DayAvailability> | null = null;
  if (date) {
    const { getAvailabilityForDay } = await import("./extrasAvailability");
    availMap = await getAvailabilityForDay(date);
  }

  return rows.map(r => ({
    id: r.id,
    fullName: r.fullName,
    position: r.position,
    extraLevel: r.extraLevel,
    suggestedLevel: suggestLevel(r.position, r.extraLevel),
    photoUrl: r.photoUrl ?? null,
    availability: availMap ? (availMap.get(r.id) ?? { status: "no_response", morning: false, night: false, fromHour: null, toHour: null, note: null }) : null,
  }));
}

function countWashes(rows: BookingRow[]): number {
  let n = 0;
  for (const r of rows) if (bookingHasLavagem(r.rawJson)) n++;
  return n;
}

function distinctParks(rows: BookingRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const label = [r.parkName, r.city].filter(Boolean).join(" / ");
    if (label) set.add(label);
  }
  return Array.from(set).sort();
}

export async function getExtrasDiaForecast(baseDateInput?: string, city: ExtraCity = "lisbon"): Promise<ExtrasDiaForecast> {
  // Sem dia pedido: HOJE em Lisboa (o servidor corre em UTC — entre a meia-noite
  // e a 01h de Lisboa no verão, "hoje" ainda era ontem).
  const baseDate = new Date(`${baseDateInput ?? lisbonDayOf(Date.now())}T00:00:00`);
  const baseStart = startOfDay(baseDate);
  const targetStart = addDays(baseStart, 1);
  const nextStart = addDays(baseStart, 2);
  const nextEnd = addDays(baseStart, 3);
  // Limite superior do forecast: 03:00 do dia D+2 (= targetStart + 27h),
  // para o turno da noite cobrir até às 03:00 do dia seguinte.
  const targetEndPlus3h = new Date(targetStart.getTime() + FORECAST_HOURS * 60 * 60 * 1000);

  // Uma só leitura ao vivo cobre as 3 janelas (dia base → fim do dia D+2);
  // sem a BD da Multipark, as 4 leituras de sempre na cópia.
  const live = await liveBookingsInWindow(baseStart, nextEnd, city);
  const [targetCheckins, baseCheckouts, targetCheckouts, nextCheckouts] = live.ok
    ? [
        filterRowsByField(live.rows, "checkIn", targetStart, targetEndPlus3h),
        filterRowsByField(live.rows, "checkOut", baseStart, targetStart),
        filterRowsByField(live.rows, "checkOut", targetStart, targetEndPlus3h),
        filterRowsByField(live.rows, "checkOut", nextStart, nextEnd),
      ]
    : await Promise.all([
        fetchBookingsInRange("checkIn", targetStart, targetEndPlus3h, city),
        fetchBookingsInRange("checkOut", baseStart, targetStart, city),
        fetchBookingsInRange("checkOut", targetStart, targetEndPlus3h, city),
        fetchBookingsInRange("checkOut", nextStart, nextEnd, city),
      ]);

  const hourly: HourlyRow[] = Array.from({ length: FORECAST_HOURS }, (_, h) => ({
    hour: h,
    checkins: 0,
    checkouts: 0,
    driversNeeded: 0,
    hasT2: false,
    hasOther: false,
    slots: Array.from({ length: SLOTS_PER_HOUR }, (_, s) => ({
      hour: h,
      slot: s,
      checkins: 0,
      checkouts: 0,
      weightedDemand: 0,
      driversNeeded: 0,
    })),
  }));

  // Acumulador da procura "pesada" por slot global (0..80). Cada reserva
  // espalha 1, 1.5 ou 3 unidades consoante o deliveryType.
  const weightedBySlot: number[] = Array.from({ length: FORECAST_SLOTS }, () => 0);

  // O "dia operacional" vai de 03:00 a 03:00 (24h reais). Hora efectiva:
  //   • bookings em D+1 hora 3–23 → 3–23
  //   • bookings em D+2 hora 0–2  → 24–26
  //   • bookings em D+1 hora 0–2  → DESCARTADOS (pertencem ao plano do dia anterior)
  function bookingEffectiveHM(
    timeStr: string | null,
    fallbackIso: string | null,
  ): { hour: number; minute: number } | null {
    const hm = parseScheduledHM(timeStr, fallbackIso);
    if (!hm) return null;
    if (!fallbackIso) return hm.hour >= 3 ? hm : null;
    const date = new Date(fallbackIso.includes("T") ? fallbackIso : fallbackIso.replace(" ", "T"));
    if (Number.isNaN(date.getTime())) return hm.hour >= 3 ? hm : null;
    const dayStartLocal = startOfDay(date);
    const offsetDays = Math.round((dayStartLocal.getTime() - targetStart.getTime()) / (24 * 60 * 60 * 1000));
    const effectiveHour = hm.hour + 24 * offsetDays;
    // janela do dia operacional: 3 ≤ effectiveHour < 27
    if (effectiveHour < 3 || effectiveHour >= FORECAST_HOURS) return null;
    return { hour: effectiveHour, minute: hm.minute };
  }

  function addToSlot(
    startHour: number,
    startMinute: number,
    deliveryType: string | null,
    type: "checkin" | "checkout",
  ) {
    const startSlot = startHour * SLOTS_PER_HOUR + Math.floor(startMinute / SLOT_MINUTES);
    const cls = classifyDeliveryType(deliveryType);
    // Regra: T2 só conta como 30min (1.5 slots) em CHECK-IN.
    // Em check-out, T2 trata-se como T1 (20min normal).
    let spread: number[];
    if (cls === "t2" && type === "checkin") spread = [1, 0.5];
    else if (cls === "other") spread = [1, 1, 1]; // Outro: aplica em ambos
    else spread = [1];
    for (let i = 0; i < spread.length; i++) {
      const s = startSlot + i;
      if (s >= 0 && s < FORECAST_SLOTS) weightedBySlot[s] += spread[i];
    }
  }

  function markHourClass(hour: number, deliveryType: string | null, type: "checkin" | "checkout") {
    const cls = classifyDeliveryType(deliveryType);
    if (cls === "t2" && type === "checkin") hourly[hour].hasT2 = true;
    else if (cls === "other") hourly[hour].hasOther = true;
  }

  for (const r of targetCheckins) {
    const hm = bookingEffectiveHM(r.checkInTime, r.checkIn);
    if (hm) {
      const slot = Math.floor(hm.minute / SLOT_MINUTES);
      hourly[hm.hour].checkins++;
      hourly[hm.hour].slots[slot].checkins++;
      addToSlot(hm.hour, hm.minute, r.deliveryType, "checkin");
      markHourClass(hm.hour, r.deliveryType, "checkin");
    }
  }
  for (const r of targetCheckouts) {
    const hm = bookingEffectiveHM(r.checkOutTime, r.checkOut);
    if (hm) {
      const slot = Math.floor(hm.minute / SLOT_MINUTES);
      hourly[hm.hour].checkouts++;
      hourly[hm.hour].slots[slot].checkouts++;
      addToSlot(hm.hour, hm.minute, r.deliveryType, "checkout");
      markHourClass(hm.hour, r.deliveryType, "checkout");
    }
  }
  // Capacidade da CIDADE (D12): tempo por carro de cada condutor conforme as
  // pessoas no turno (TL incluído; conduzem os extras). driversNeeded = extras
  // precisos (sem o TL). Num bloco de 20 min conta a procura ×3 (por hora).
  const crewRule = await loadCrewRule(city);
  for (const row of hourly) {
    let hourWeighted = 0;
    for (const s of row.slots) {
      const idx = s.hour * SLOTS_PER_HOUR + s.slot;
      s.weightedDemand = weightedBySlot[idx];
      s.driversNeeded = extrasNeededFor(s.weightedDemand * SLOTS_PER_HOUR, crewRule);
      hourWeighted += s.weightedDemand;
    }
    row.driversNeeded = extrasNeededFor(hourWeighted, crewRule);
  }

  // Para sugestão de turnos usa a procura pesada agregada por hora.
  const hourlyCars = hourly.map(h => h.slots.reduce((acc, s) => acc + s.weightedDemand, 0));
  const liveRates = await loadExtraRates();
  const cheapest = suggestShifts(hourlyCars, "junior", liveRates, crewRule);
  const bySingleLevel = DRIVER_LEVELS.map(l => {
    const r = suggestShifts(hourlyCars, l.id, liveRates, crewRule);
    return { level: l.id, label: l.label, totalCost: r.totalCost, totalHours: r.totalDriverHours };
  });

  const allParks = new Set<string>();
  for (const r of [...targetCheckins, ...baseCheckouts, ...targetCheckouts, ...nextCheckouts]) {
    const label = [r.parkName, r.city].filter(Boolean).join(" / ");
    if (label) allParks.add(label);
  }

  // Contadores por tipo de lugar (covered/uncovered/indoor).
  // spotTypeCounts: dedup por reserva (cada externalId conta 1× só)
  // spotTypeByDirection: por sentido, sem dedup (uma reserva pode ter
  // chegada E saída no mesmo dia operacional).
  const spotTypeCounts = { covered: 0, uncovered: 0, indoor: 0, unknown: 0 };
  const spotTypeByDirection = {
    checkin: { covered: 0, uncovered: 0, indoor: 0, unknown: 0 },
    checkout: { covered: 0, uncovered: 0, indoor: 0, unknown: 0 },
  };
  const seenForSpot = new Set<string>();
  for (const r of targetCheckins) {
    const st = (r.spotType ?? "unknown") as keyof typeof spotTypeCounts;
    if (st in spotTypeByDirection.checkin) spotTypeByDirection.checkin[st]++;
    if (!seenForSpot.has(r.externalId)) {
      seenForSpot.add(r.externalId);
      if (st in spotTypeCounts) spotTypeCounts[st]++;
    }
  }
  for (const r of targetCheckouts) {
    const st = (r.spotType ?? "unknown") as keyof typeof spotTypeCounts;
    if (st in spotTypeByDirection.checkout) spotTypeByDirection.checkout[st]++;
    if (!seenForSpot.has(r.externalId)) {
      seenForSpot.add(r.externalId);
      if (st in spotTypeCounts) spotTypeCounts[st]++;
    }
  }

  // Soma extrasTotal de reservas no dia operacional, dedup por externalId.
  // Decide estimativa vs real comparando a data relevante com o "agora".
  const extrasValue = { estimate: 0, real: 0, total: 0 };
  const seenForExtras = new Set<string>();
  const nowMs = Date.now();
  function addExtras(r: BookingRow, dateStr: string | null) {
    if (seenForExtras.has(r.externalId)) return;
    seenForExtras.add(r.externalId);
    const v = r.extrasTotal ? parseFloat(r.extrasTotal) : 0;
    if (!Number.isFinite(v) || v === 0) return;
    // As horas das reservas já estão em hora de Lisboa: compara-as como tal (não como UTC).
    let at: number | null = null;
    try { at = dateStr ? lisbonWallToUtcMs(dateStr) : null; } catch { at = null; }
    const isFuture = at != null && at > nowMs;
    if (isFuture) extrasValue.estimate += v;
    else extrasValue.real += v;
    extrasValue.total += v;
  }
  for (const r of targetCheckins) addExtras(r, r.checkIn);
  for (const r of targetCheckouts) addExtras(r, r.checkOut);

  return {
    baseDate: dateKey(baseStart),
    targetDate: dateKey(targetStart),
    city: cityLabel(city),
    cityId: city,
    crewRule,
    crewRuleText: describeCrewRule(crewRule),
    source: "db",
    bookingSource: live.ok ? "multipark-db" : "copy",
    bookingSourceNotice: live.ok ? null : live.notice,
    bookingsTruncated: live.ok ? live.truncated : [targetCheckins, baseCheckouts, targetCheckouts, nextCheckouts].some((r) => r.length >= COPY_ROWS_LIMIT),
    parksQueried: live.ok ? live.parks : Array.from(allParks).sort(),
    parksFailed: [],
    hourly,
    totals: {
      checkins: hourly.reduce((s, h) => s + h.checkins, 0),
      checkouts: hourly.reduce((s, h) => s + h.checkouts, 0),
      operations: hourly.reduce((s, h) => s + h.checkins + h.checkouts, 0),
    },
    spotTypeCounts,
    spotTypeByDirection,
    extrasValue,
    washes: {
      base: { date: dateKey(baseStart), exitsWithWash: countWashes(baseCheckouts) },
      target: { date: dateKey(targetStart), exitsWithWash: countWashes(targetCheckouts) },
      next: { date: dateKey(nextStart), exitsWithWash: countWashes(nextCheckouts) },
    },
    allocation: { cheapest, bySingleLevel },
    rates: liveRates,
    costsHidden: false,
  };
}
