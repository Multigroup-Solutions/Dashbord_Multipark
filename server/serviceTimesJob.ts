/**
 * Tempos de entrega e de recolha — o trabalho noturno `service-times`
 * (plano 62, P7). Interruptor SERVICE_TIMES (só super admin, DESLIGADO por
 * omissão); à mão em /api/cron/service-times?reprocessar=AAAA-MM-DD..AAAA-MM-DD
 * (corre mesmo com o interruptor desligado: é o "dia reprocessado à mão" que
 * se faz antes de o ligar — explícito, com a chave das tarefas automáticas,
 * só escreve na tabela dos tempos e não avisa ninguém; auditoria final: fica).
 *
 * Cada corrida:
 *  1. noite (uma vez por dia operacional): os ciclos que FECHARAM nos dias
 *     operacionais D-3 … D-1 — UMA leitura da History (desde 6 h antes do
 *     início de D-3 até agora: os MOVEMENT até 48 h depois de cada check-in e
 *     os "por arrumar" vêm nesta mesma leitura); D-1 com o GPS provisório,
 *     D-2 e D-3 com o final (`gpsPass` sobe para "final");
 *  2. preenchimento para trás (blocos de 7 dias, 2 nos dias com GPS; ≤ 2
 *     leituras por corrida, só nos primeiros 20 s e só até às 09h de Lisboa):
 *     desde `serviceTimes.since` (sem GPS antes de `serviceTimes.gpsSince`).
 *     Mudar o `calcVersion` recomeça-o; mudar zonas, papéis das garagens ou a
 *     janela das chamadas (outro `paramsHash`) refaz os últimos 14 dias; as
 *     noites que faltaram também entram; o resto só à mão.
 *  Limites de carga: ver "Carga" abaixo (prazo, tetos das leituras, anulação
 *  suspensa numa leitura vazia).
 *  O estado (versão, impressão digital, noite feita, blocos por fazer) fica em
 *  `app_settings` ("serviceTimes._state"), por isso sobrevive de um dia para o
 *  outro.
 *
 * Uma linha `final` com o calcVersion e o paramsHash atuais não se relê (nem
 * o GPS), salvo no reprocessamento à mão. Um ciclo que deixe de aparecer fica
 * com `voidedAt` (volta a NULL se reaparecer). Nada se apaga.
 *
 * Nunca lança: a Multipark em baixo → nada se grava, `ok:false` com o motivo
 * (o agendador repete). Dependências injetáveis (testes: dia sintético).
 */
import {
  CALL_WINDOW_AFTER_MIN, CALL_WINDOW_BEFORE_MIN, SERVICE_CALLS_SINCE, SERVICE_TIMES_CALC_VERSION, T2_LOOKBACK_MIN,
  agentRoleIn, appTerminalExit, garageRoleOf, buildDeliveryCycles, buildPickupCycles, buttonCoherent, deliveryTimes, dispatchStartIds, driverBlockOf,
  matchCallToBooking, phone9Of, pickupTimes, resolveArrival, serviceParamsHash, sharedPhonesByDay, sortServiceEvents, withinTarget,
  zelloHolderAt, zelloOfAt,
  type AgentKind, type CallRecord, type DeliveryCycle, type ExitResolution, type FixedZelloLike, type GarageRoleEntry, type GpsArrival,
  type PdaCheckinLike, type PickupCycle, type ServiceEvent, type TransitStatus,
} from "../shared/serviceTimes";
import {
  AFTER_SIGNATURE_S, D_START_FAR_FROM_PARK_M, EXIT_SEARCH_MAX_MIN, G_GOOD_S,
  arrivalZoneFor, detectExit, detectStop, effectiveParkZones, garageMarkCenters, lastZoneArrival, latLngInside, nearestPark, p2ZoneOf, parkExitZone, parkRefsFor,
  terminalZoneFor, zonesTouch,
  type GpsFix, type LatLng, type ParkZoneCity, type ParkZoneExceptionsMap, type ParkZonesMap, type TerminalClass, type Zone,
} from "../shared/serviceGps";
import type { AirportFence } from "../shared/pontoTerminal";
import { classifyPark, marketplaceOperated } from "../shared/multiparkParks";
import { addDays, lisbonDayOf, lisbonHourOf, operationalDayOf, operationalDayRangeUtc, zelloLatestDay } from "../shared/lisbonDay";
import { percentile } from "../shared/extrasPressure";
import {
  SERVICE_HISTORY_MAX_ROWS, buildServiceAgentsSql, buildServiceBookingsSql, buildServiceDriverPhonesSql, buildServiceHistorySql, buildServiceParksSql,
  idBatches, mapServiceBookingRow, mapServiceHistoryRow, type ServiceBookingRow,
} from "./multiparkDb/serviceRows";
import { describeReadFailure } from "./multiparkDb/read";
import { buildGaragesSql, garageCoordsOf } from "./multiparkDb/parkZonesSuggest";
import type { SqlParam } from "./multiparkDb/client";
import { classifyAllocation } from "./spotClassification";

// ─── Dependências ───────────────────────────────────────────────────────────

export type ServiceQuery = <T = Record<string, unknown>>(sql: string, params?: SqlParam[], opts?: { timeoutMs?: number }) => Promise<T[]>;

export interface ServiceSettings {
  excludedParks: string[];
  airports: Partial<Record<ParkZoneCity, AirportFence>>;
  /** Q6: só as exceções (as zonas vêm das garagens da Multipark). */
  parkZones: ParkZoneExceptionsMap;
  garageRoles: GarageRoleEntry[];
  targetMinutes: number;
  t2TargetMinutes: number;
  since: string;
  gpsSince: string;
  useCalls: boolean;
}

export interface ServiceIdentity { agent(userId: string | null, name: string | null): { kind: AgentKind; employeeId: number | null } }

export type GpsFile = { status: "ok"; pass: "sameday" | "final"; points: GpsFix[] } | { status: "missing" } | { status: "failed"; reason?: "prazo" };
export const gpsFileKey = (zello: string, day: string) => `${zello.trim().toLowerCase()}|${day}`;

export interface ServiceOurDb {
  /** Chamadas RECEBIDAS (central e WhatsApp) em [from, to) (ms). */
  calls(fromMs: number, toMs: number): Promise<CallRecord[]>;
  /** Fichas do CRM ligadas a cada reserva: telefones (últimos 9) e ids. */
  crmLinks(bookingIds: string[]): Promise<Map<string, { phones: string[]; crmIds: number[] }>>;
  pdaCheckins(fromMs: number, toMs: number): Promise<PdaCheckinLike[]>;
  fixedZellos(): Promise<FixedZelloLike[]>;
}

export interface ServiceTimesState { v: number; h: string; nightly: string | null; todo: Array<{ from: string; to: string }> }
export interface ExistingRowMeta { id: number; kind: string; bookingId: string; anchorHistoryId: string; gpsPass: string; calcVersion: number; paramsHash: string; voided: boolean }

export interface ServiceStore {
  loadState(): Promise<ServiceTimesState | null>;
  saveState(s: ServiceTimesState): Promise<void>;
  /** Linhas com o fecho em [from, to) (UTC "YYYY-MM-DD HH:MM:SS"). */
  existing(fromUtc: string, toUtc: string): Promise<ExistingRowMeta[]>;
  upsert(rows: ServiceTimesRow[]): Promise<void>;
  voidRows(ids: number[], atUtc: string): Promise<void>;
}

export interface ServiceTimesDeps {
  query: ServiceQuery;
  now: () => number;
  settings: () => Promise<ServiceSettings>;
  ourDb: ServiceOurDb;
  loadGps: (requests: Array<{ zello: string; day: string }>, o: { deadlineAt: number }) => Promise<Map<string, GpsFile>>;
  identity: () => Promise<ServiceIdentity>;
  store: ServiceStore;
  log?: (line: string) => void;
}

// ─── A linha guardada (colunas da tabela service_times, migração 0685) ──────

export interface ServiceTimesRow {
  kind: "entrega" | "recolha";
  bookingId: string;
  anchorHistoryId: string;
  anchorAt: string;
  outcome: string;
  bookingCode: string | null;
  parkId: string | null;
  cityKey: string | null;
  parkGroup: string | null;
  terminalClass: string | null;
  opDay: string;
  refHour: number | null;
  callAt: string | null;
  callSource: string | null;
  callHeld: number | null;
  requestAt: string | null;
  requestCount: number;
  startSource: string | null;
  customerMs: number | null;
  customerStatus: string | null;
  zelloUsername: string | null;
  gpsPoints: number | null;
  gpsMaxGapS: number | null;
  gpsPass: "none" | "sameday" | "final";
  flags: string | null;
  startedAt: string | null;
  startAgentId: string | null;
  startEmployeeId: number | null;
  startPlatform: string | null;
  startRole: string | null;
  arrivedAt: string | null;
  arrivedSource: string | null;
  arrivedPrecisionS: number | null;
  buttonArrivedAt: string | null;
  buttonGapS: number | null;
  baggageWaitingAt: string | null;
  deliveredAt: string | null;
  deliverAgentId: string | null;
  deliverEmployeeId: number | null;
  queueMs: number | null;
  transitMs: number | null;
  ourMs: number | null;
  totalMs: number | null;
  queueStatus: string | null;
  transitStatus: string | null;
  ourStatus: string | null;
  checkInAt: string | null;
  checkInAgentId: string | null;
  checkInEmployeeId: number | null;
  driverEmployeeId: number | null;
  terminalExitAt: string | null;
  terminalExitSource: string | null;
  terminalMs: number | null;
  terminalStatus: string | null;
  firstGarage: string | null;
  firstGarageRole: string | null;
  firstGarageAt: string | null;
  toFirstGarageMs: number | null;
  p2ExitAt: string | null;
  p2Ms: number | null;
  p2Status: string | null;
  p2EmployeeId: number | null;
  parkedGarage: string | null;
  parkedAt: string | null;
  toParkedMs: number | null;
  parkedStatus: string | null;
  parkedEmployeeId: number | null;
  spotType: string | null;
  t2DriverArrivedAt: string | null;
  t2LateMs: number | null;
  t2Status: string | null;
  calcVersion: number;
  paramsHash: string;
  computedAt: string;
  voidedAt: null;
}

export const SERVICE_TIMES_ROW_COLUMNS = [
  "kind", "bookingId", "anchorHistoryId", "anchorAt", "outcome", "bookingCode", "parkId", "cityKey", "parkGroup", "terminalClass", "opDay", "refHour",
  "callAt", "callSource", "callHeld", "requestAt", "requestCount", "startSource", "customerMs", "customerStatus", "zelloUsername", "gpsPoints", "gpsMaxGapS",
  "gpsPass", "flags", "startedAt", "startAgentId", "startEmployeeId", "startPlatform", "startRole", "arrivedAt", "arrivedSource", "arrivedPrecisionS",
  "buttonArrivedAt", "buttonGapS", "baggageWaitingAt", "deliveredAt", "deliverAgentId", "deliverEmployeeId", "queueMs", "transitMs", "ourMs", "totalMs", "queueStatus",
  "transitStatus", "ourStatus", "checkInAt", "checkInAgentId", "checkInEmployeeId", "driverEmployeeId", "terminalExitAt", "terminalExitSource", "terminalMs", "terminalStatus",
  "firstGarage", "firstGarageRole", "firstGarageAt", "toFirstGarageMs", "p2ExitAt", "p2Ms", "p2Status", "p2EmployeeId", "parkedGarage", "parkedAt", "toParkedMs",
  "parkedStatus", "parkedEmployeeId", "spotType", "t2DriverArrivedAt", "t2LateMs", "t2Status", "calcVersion", "paramsHash", "computedAt", "voidedAt",
] as const satisfies ReadonlyArray<keyof ServiceTimesRow>;

/**
 * Tamanho máximo das colunas de texto (o mesmo da migração 0685; testado). Os
 * textos que vêm da Multipark (nome da garagem, código do lugar, papel do
 * agente…) cortam-se aqui: com o MySQL em modo estrito, um texto comprido
 * fazia falhar o lote inteiro do upsert.
 */
export const SERVICE_TIMES_TEXT_MAX: Partial<Record<keyof ServiceTimesRow, number>> = {
  kind: 8, bookingId: 64, anchorHistoryId: 64, outcome: 12, bookingCode: 40, parkId: 64, cityKey: 8, parkGroup: 40, terminalClass: 8,
  callSource: 10, startSource: 12, customerStatus: 32, zelloUsername: 255, gpsPass: 10, flags: 600, startAgentId: 64, startPlatform: 10,
  startRole: 16, arrivedSource: 24, deliverAgentId: 64, queueStatus: 32, transitStatus: 32, ourStatus: 32, checkInAgentId: 64,
  terminalExitSource: 24, terminalStatus: 32, firstGarage: 80, firstGarageRole: 12, p2Status: 32, parkedGarage: 80, parkedStatus: 16,
  spotType: 12, t2Status: 32, paramsHash: 16,
};

/** Corta os textos ao tamanho das colunas. PURA. */
export function fitServiceRow(r: ServiceTimesRow): ServiceTimesRow {
  const out = { ...r } as Record<string, unknown>;
  for (const [k, max] of Object.entries(SERVICE_TIMES_TEXT_MAX)) {
    const v = out[k];
    if (typeof v === "string" && v.length > max!) out[k] = v.slice(0, max);
  }
  return out as unknown as ServiceTimesRow;
}

// ─── Ajudantes puros ────────────────────────────────────────────────────────

/** ms → "YYYY-MM-DD HH:MM:SS.mmm" UTC (null fica null). PURA. */
export const utc3 = (ms: number | null | undefined): string | null => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString().slice(0, 23).replace("T", " "));
const utc0 = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const rowKey = (kind: string, bookingId: string, anchor: string) => `${kind}|${bookingId}|${anchor}`;
const clampInt = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.max(-2_000_000_000, Math.min(2_000_000_000, Math.round(v))));
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "?reprocessar=AAAA-MM-DD" ou "AAAA-MM-DD..AAAA-MM-DD" → intervalo (no máximo 120 dias). PURA. */
export function parseServiceReprocess(raw: unknown): { from: string; to: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const from = m[1], to = m[2] ?? m[1];
  if (Number.isNaN(Date.parse(`${from}T12:00:00Z`)) || Number.isNaN(Date.parse(`${to}T12:00:00Z`)) || from > to) return null;
  if ((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000 > 120) return null;
  return { from, to };
}

/** Junta intervalos de dias (sobrepostos ou seguidos). PURA. */
export function mergeDayRanges(ranges: ReadonlyArray<{ from: string; to: string }>): Array<{ from: string; to: string }> {
  const list = ranges.filter((r) => DAY_RE.test(r.from) && DAY_RE.test(r.to) && r.from <= r.to).map((r) => ({ ...r })).sort((a, b) => a.from.localeCompare(b.from));
  const out: Array<{ from: string; to: string }> = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r.from <= addDays(last.to, 1)) { if (r.to > last.to) last.to = r.to; } else out.push(r);
  }
  return out;
}

// ─── Carga (auditoria final): limites de cada corrida ───────────────────────
//
// A função da Vercel morre aos 60 s e o agendador dá a cada trabalho ≤ 45 s.
// Cada intervalo = UMA leitura sequencial da History (sem índice em
// "actionTime") + leituras por chave + os ficheiros GPS. Para nunca passar do
// prazo nem deixar leituras penduradas na Multipark:
//  - só se começa um intervalo com SERVICE_TIMES_RANGE_MIN_MS pela frente;
//  - a leitura da History tem teto próprio (o Postgres corta-a: statement_timeout)
//    e o resto das leituras também, sempre dentro do que falta;
//  - os blocos para trás com GPS são de 2 dias (≈ 40 Zellos × 2 ficheiros),
//    os sem GPS de 7;
//  - o preenchimento para trás só corre até às 09h de Lisboa (de madrugada e
//    de manhã cedo): não junta leituras sequenciais à Multipark a meio do dia.
//    O que faltar continua na manhã seguinte. À mão (`reprocessar`) não tem hora.

/** Só se começa um intervalo (uma leitura da History) com isto de prazo pela frente. */
export const SERVICE_TIMES_RANGE_MIN_MS = 25_000;
/** Teto da leitura da History deste trabalho. */
export const SERVICE_HISTORY_TIMEOUT_MS = 25_000;
/** Teto das leituras por chave (Booking, Driver, Agent). */
export const SERVICE_KEY_TIMEOUT_MS = 10_000;
/** Ficheiros GPS só com isto (ou mais) de prazo; senão ficam por recolher. */
export const SERVICE_GPS_MIN_MS = 8_000;
/** Blocos do preenchimento para trás: sem GPS e com GPS. */
export const BACKFILL_DAYS = 7;
export const BACKFILL_GPS_DAYS = 2;
/** O preenchimento para trás (automático) só até esta hora de Lisboa. */
export const BACKFILL_UNTIL_HOUR = 9;
/** Anulação suspensa quando desapareceriam mais do que isto E mais desta fração das linhas ativas do intervalo. */
export const VOID_MAX_ROWS = 20;
export const VOID_MAX_SHARE = 0.25;

/**
 * O bloco seguinte do preenchimento para trás, a partir do fim do intervalo
 * mais recente: 7 dias, ou 2 nos dias com GPS (desde `gpsSince`; um bloco não
 * mistura dias com e sem GPS). PURA.
 */
export function nextBackfillBlock(todo: ReadonlyArray<{ from: string; to: string }>, o: number | { days?: number; gpsDays?: number; gpsSince?: string | null } = BACKFILL_DAYS): { block: { from: string; to: string } | null; rest: Array<{ from: string; to: string }> } {
  const opts = typeof o === "number" ? { days: o } : o;
  const merged = mergeDayRanges(todo);
  if (!merged.length) return { block: null, rest: [] };
  const last = merged[merged.length - 1];
  const gpsEra = !!opts.gpsSince && last.to >= opts.gpsSince;
  const days = Math.max(1, gpsEra ? opts.gpsDays ?? BACKFILL_GPS_DAYS : opts.days ?? BACKFILL_DAYS);
  let from = addDays(last.to, -(days - 1));
  if (from < last.from) from = last.from;
  if (gpsEra && from < opts.gpsSince!) from = opts.gpsSince!;
  const block = { from, to: last.to };
  const rest = [...merged.slice(0, -1), ...(from > last.from ? [{ from: last.from, to: addDays(from, -1) }] : [])];
  return { block, rest };
}

/**
 * O estado do trabalho: versão nova → recomeça o preenchimento para trás desde
 * `since`; impressão digital nova → os últimos 14 dias entram nos blocos por
 * fazer; noites que faltaram (Multipark em baixo, interruptor desligado uns
 * dias) → os dias entre a última noite feita e D-4 também (a noite só lê D-3 …
 * D-1). PURA.
 */
export function nextServiceState(prev: ServiceTimesState | null, o: { version: number; hash: string; today: string; since: string }): ServiceTimesState {
  const lastBack = addDays(o.today, -4);
  if (!prev || prev.v !== o.version) {
    return { v: o.version, h: o.hash, nightly: null, todo: o.since <= lastBack ? [{ from: o.since, to: lastBack }] : [] };
  }
  const extra: Array<{ from: string; to: string }> = [];
  if (prev.h !== o.hash) {
    const from14 = addDays(o.today, -14) < o.since ? o.since : addDays(o.today, -14);
    if (from14 <= lastBack) extra.push({ from: from14, to: lastBack });
  }
  // a última noite (N) leu N-3 … N-1; hoje lê-se T-3 … T-1: faltam N … T-4
  if (prev.nightly && DAY_RE.test(prev.nightly) && prev.nightly <= lastBack) extra.push({ from: prev.nightly < o.since ? o.since : prev.nightly, to: lastBack });
  const todo = [...prev.todo, ...extra].filter((r) => r.to >= o.since).map((r) => ({ from: r.from < o.since ? o.since : r.from, to: r.to }));
  return { ...prev, h: o.hash, todo: mergeDayRanges(todo) };
}

const CITY_OF: Record<string, ParkZoneCity> = { lisboa: "lisbon", porto: "porto", faro: "faro" };

/**
 * Parque da reserva (o "Park" da Multipark): cidade, grupo e se é operado. A
 * posição do Park NÃO entra (P0: fica junto ao aeroporto, não na garagem) — as
 * regras do parque usam as garagens (parkRefsFor).
 */
interface ParkInfo { id: string; name: string; cityKey: string | null; zoneCity: ParkZoneCity | null; group: string; operated: boolean }

function parkInfos(rows: Array<Record<string, unknown>>, excluded: readonly string[]): Map<string, ParkInfo> {
  const out = new Map<string, ParkInfo>();
  const ex = new Set(excluded);
  for (const r of rows) {
    const id = r.id == null ? "" : String(r.id);
    if (!id) continue;
    const name = String(r.name ?? id);
    const cls = classifyPark({ name, city: r.city as string | null, address: r.address as string | null, firebaseBrand: r.firebase_brand as string | null, listingType: r.listing_type as string | null });
    out.set(id, {
      id, name, cityKey: cls.city, zoneCity: cls.city ? CITY_OF[cls.city] ?? null : null, group: cls.key,
      operated: marketplaceOperated({ id, name, ours: cls.ours }, ex) && !ex.has(id),
    });
  }
  return out;
}

/** Classe do destino (a mesma regra de server/extrasDia.ts → classifyDeliveryType). PURA. */
export function terminalClassOf(deliveryType: string | null | undefined, city: ParkZoneCity | null): TerminalClass {
  if (!deliveryType || !String(deliveryType).trim()) return "unknown";
  const x = String(deliveryType).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (city === "lisbon" && /oriente|sete\s*-?\s*rios|rossio|entre\s*-?\s*campos/.test(x)) return "other";
  if (city === "faro" && /estac|comboio|ferrovia|railway|train/.test(x)) return "other";
  if (city !== "porto" && /terminal\s*2|\bt\s*2\b/.test(x)) return "t2";
  if (x === "vip" || /\bvip\b/.test(x)) return "vip";
  return "t1";
}

/** Tipo de lugar do carro (como liveSpotTypeOf: pelo código, senão pelo parkingType). PURA. */
export function spotTypeOf(parkingType: unknown, code: string | null): string {
  const byAllocation = classifyAllocation(code).spotType;
  if (byAllocation !== "unknown") return byAllocation;
  const t = String(parkingType ?? "").trim().toUpperCase();
  return t === "COVERED" ? "covered" : t === "UNCOVERED" ? "uncovered" : t === "INDOOR" ? "indoor" : t === "VIP" ? "vip" : "unknown";
}

/** Dias de Lisboa tocados por [a, b] (ms). PURA. */
export function lisbonDaysBetween(a: number, b: number): string[] {
  const out: string[] = [];
  let d = lisbonDayOf(a);
  const last = lisbonDayOf(Math.max(a, b));
  for (let i = 0; i < 5 && d <= last; i++, d = addDays(d, 1)) out.push(d);
  return out;
}

const posOf = (e: ServiceEvent | null | undefined): LatLng | null => (e && e.lat != null && e.lng != null ? { lat: e.lat, lng: e.lng } : null);
/** O 1.º MOVEMENT depois do check-in (quem levou o carro do terminal). */
const firstMoveOf = (p: PickupCycle): ServiceEvent | null => (p.checkIn ? sortServiceEvents(p.moves).find((m) => m.at >= p.checkIn!.at) ?? null : null);

// ─── GPS de uma pessoa numa janela ──────────────────────────────────────────

interface GpsCtx { checkins: PdaCheckinLike[]; fixed: FixedZelloLike[]; files: Map<string, GpsFile>; /** último dia de Lisboa com a recolha final (D-2) */ finalUntil: string }
type HeldGps = { kind: "ok"; zello: string; points: GpsFix[]; pass: "sameday" | "final"; maxGapS: number | null; pending: boolean } | { kind: "no"; status: TransitStatus; zello: string | null };

/** Os pontos "meus" (de quem tinha o Zello) de uma pessoa na janela, a partir dos ficheiros já lidos. */
function heldGps(ctx: GpsCtx, employeeId: number, at: number, fromMs: number, toMs: number): HeldGps {
  const z = zelloOfAt(employeeId, at, ctx);
  if (z.zello == null) return { kind: "no", status: "sem_zello", zello: null };
  const days = lisbonDaysBetween(fromMs, toMs);
  const pts: GpsFix[] = [];
  let pass: "sameday" | "final" = "final";
  // ainda pode chegar mais GPS: ficheiro por ler, provisório que acaba antes do fim da janela, ou em falta num dia sem a recolha final
  let pending = false;
  let lastTsMs = -Infinity;
  for (const d of days) {
    const f = ctx.files.get(gpsFileKey(z.zello, d));
    if (!f || f.status === "failed") return { kind: "no", status: "gps_por_recolher", zello: z.zello };
    if (f.status === "missing") { if (d > ctx.finalUntil) pending = true; continue; }
    if (f.pass === "sameday") pass = "sameday";
    for (const p of f.points) if (p.ts * 1000 > lastTsMs) lastTsMs = p.ts * 1000;
    for (const p of f.points) {
      const ms = p.ts * 1000;
      if (ms >= fromMs && ms <= toMs && zelloHolderAt(z.zello, ms, ctx) === employeeId) pts.push(p);
    }
  }
  if (pass === "sameday" && lastTsMs < toMs) pending = true;
  if (!pts.length) return { kind: "no", status: pending ? "gps_por_recolher" : "sem_pontos", zello: z.zello };
  if (pending) pass = "sameday";
  pts.sort((a, b) => a.ts - b.ts);
  let maxGap = 0;
  for (let i = 1; i < pts.length; i++) maxGap = Math.max(maxGap, pts[i].ts - pts[i - 1].ts);
  return { kind: "ok", zello: z.zello, points: pts, pass, maxGapS: pts.length > 1 ? maxGap : null, pending };
}

/** Pedidos de ficheiros GPS (zello × dia de Lisboa) de uma pessoa numa janela. */
function gpsRequestsFor(ctx: Pick<GpsCtx, "checkins" | "fixed">, employeeId: number, at: number, fromMs: number, toMs: number): Array<{ zello: string; day: string }> {
  const z = zelloOfAt(employeeId, at, ctx);
  if (z.zello == null) return [];
  return lisbonDaysBetween(fromMs, toMs).map((day) => ({ zello: z.zello!, day }));
}

// ─── Uma corrida ────────────────────────────────────────────────────────────

export interface RangeReport {
  from: string;
  to: string;
  reason: "noite" | "para_tras" | "reprocessar";
  historyRows: number;
  truncated: boolean;
  /** Linhas que deixaram de aparecer mas NÃO se anularam (leitura vazia ou anulação em massa: suspeito). */
  voidSuspended: number;
  deliveries: number;
  pickups: number;
  openCycles: number;
  written: number;
  keptFinal: number;
  voided: number;
  gpsFiles: { asked: number; read: number; failed: number; /** não lidos por falta de prazo (ficam por recolher) */ skipped: number };
}

export interface ServiceTimesRunResult {
  /** `skipped` = saiu sem ler (ex.: sem prazo para uma leitura neste pedido). */
  ok: boolean;
  done: boolean;
  cursor: string | null;
  error?: string;
  skipped?: string;
  ranges: RangeReport[];
  lines: string[];
}

/** Janela da leitura de um intervalo de dias operacionais: 6 h antes (pedidos longos) até 48 h depois (movimentos), nunca depois de agora. PURA. */
export function readWindowFor(from: string, to: string, nowMs: number): { anchorFromMs: number; anchorToMs: number; readFromMs: number; readToMs: number } {
  const a = operationalDayRangeUtc(from, to);
  return { anchorFromMs: a.startMs, anchorToMs: Math.min(a.endMs, nowMs), readFromMs: a.startMs - 6 * 3_600_000, readToMs: Math.min(nowMs, a.endMs + 49 * 3_600_000) };
}

interface RangeCtx {
  deps: ServiceTimesDeps; settings: ServiceSettings; hash: string; nowMs: number; deadlineAt: number; force: boolean;
  /**
   * Ao vivo (Resumo do dia com a tabela ainda vazia): as MESMAS regras, sem GPS
   * (os tempos com GPS ficam "GPS por recolher") e sem gravar nem anular nada.
   */
  live?: boolean;
  /** Parques da Multipark (lidos uma vez por corrida). */
  parkRows: Array<Record<string, unknown>>;
  /** Q6: zonas em vigor (garagens da Multipark + exceções). */
  zones: ParkZonesMap;
}

async function processRange(c: RangeCtx, range: { from: string; to: string }, reason: RangeReport["reason"]): Promise<{ report: RangeReport; rows: ServiceTimesRow[] }> {
  const { deps, settings } = c;
  const w = readWindowFor(range.from, range.to, c.nowMs);
  const rep: RangeReport = { from: range.from, to: range.to, reason, historyRows: 0, truncated: false, voidSuspended: 0, deliveries: 0, pickups: 0, openCycles: 0, written: 0, keptFinal: 0, voided: 0, gpsFiles: { asked: 0, read: 0, failed: 0, skipped: 0 } };
  const left = () => c.deadlineAt - Date.now();
  // tetos sempre dentro do que falta (o Postgres corta a leitura no servidor: nada fica pendurado)
  const historyTimeout = Math.max(5_000, Math.min(SERVICE_HISTORY_TIMEOUT_MS, left() - 15_000));
  const keyTimeout = () => ({ timeoutMs: Math.max(3_000, Math.min(SERVICE_KEY_TIMEOUT_MS, left() - 8_000)) });

  // 1. UMA leitura da History
  const h = buildServiceHistorySql({ fromUtc: utc0(w.readFromMs), toUtc: utc0(w.readToMs) });
  const raw = await deps.query<Record<string, unknown>>(h.sql, h.params, { timeoutMs: historyTimeout });
  rep.historyRows = raw.length;
  rep.truncated = raw.length >= SERVICE_HISTORY_MAX_ROWS;
  const events = raw.map(mapServiceHistoryRow).filter((e): e is ServiceEvent => !!e);
  const inRange = (at: number) => at >= w.anchorFromMs && at < w.anchorToMs;
  const del = buildDeliveryCycles(events);
  rep.openCycles = del.openCycles;
  let deliveries = del.cycles.filter((x) => inRange(x.anchor.at));
  let pickups = buildPickupCycles(events).filter((x) => inRange(x.anchor.at));

  // 2. Reservas, parques, agentes, telefones (por chave)
  const bookingIds = new Set([...deliveries, ...pickups].map((x) => x.bookingId));
  const bookings = new Map<string, ServiceBookingRow>();
  for (const batch of idBatches(bookingIds)) {
    const q = buildServiceBookingsSql(batch);
    for (const r of await deps.query<Record<string, unknown>>(q.sql, q.params, keyTimeout())) { const b = mapServiceBookingRow(r); if (b) bookings.set(b.id, b); }
  }
  const parks = parkInfos(c.parkRows, settings.excludedParks);
  const operated = (bookingId: string) => { const b = bookings.get(bookingId); const p = b?.parkId ? parks.get(b.parkId) : null; return !!p?.operated; };
  deliveries = deliveries.filter((x) => operated(x.bookingId));
  pickups = pickups.filter((x) => operated(x.bookingId));
  rep.deliveries = deliveries.length;
  rep.pickups = pickups.length;
  const liveIds = [...new Set([...deliveries, ...pickups].map((x) => x.bookingId))];
  // (a) as garagens da cidade: as zonas da operação e, para as que não têm zona, o centro das
  // marcas "estacionado aqui" (fim dos movimentos) desta mesma leitura, só das reservas dos
  // parques que operamos — nunca o Park.lat/lng (P0: fica junto ao aeroporto)
  const liveSet = new Set(liveIds);
  const marks = garageMarkCenters(events.filter((e) => e.type === "MOVEMENT" && e.garageTo && liveSet.has(e.bookingId)).map((e) => ({ garage: e.garageTo, lat: e.lat, lng: e.lng })));
  const garageRefs = new Map<ParkZoneCity, LatLng[]>();
  const parkRefs = (city: ParkZoneCity | null): LatLng[] => {
    if (!city) return [];
    let r = garageRefs.get(city);
    if (!r) { r = parkRefsFor(c.zones[city] ?? [], marks.filter((m) => m.city === city)); garageRefs.set(city, r); }
    return r;
  };
  const driverPhones = new Map<string, string[]>();
  for (const batch of idBatches(liveIds)) {
    const q = buildServiceDriverPhonesSql(batch);
    for (const r of await deps.query<Record<string, unknown>>(q.sql, q.params, keyTimeout())) {
      const id = String(r.booking_id ?? ""), p9 = phone9Of(r.phone);
      if (id && p9) driverPhones.set(id, [...(driverPhones.get(id) ?? []), p9]);
    }
  }
  const agentIds = new Set<string>();
  for (const d of deliveries) if (d.start?.agentUserId) agentIds.add(d.start.agentUserId);
  const agentRows: Array<{ userId: string; parkId: string | null; role: string | null }> = [];
  for (const batch of idBatches(agentIds)) {
    const q = buildServiceAgentsSql(batch);
    for (const r of await deps.query<Record<string, unknown>>(q.sql, q.params, keyTimeout())) agentRows.push({ userId: String(r.user_id ?? ""), parkId: r.park_id == null ? null : String(r.park_id), role: r.role == null ? null : String(r.role) });
  }

  // 3. A nossa BD: chamadas, CRM, PDAs, Zellos fixos; identidade
  const callsOn = settings.useCalls && range.to >= SERVICE_CALLS_SINCE;
  const calls = callsOn ? await deps.ourDb.calls(w.anchorFromMs - 6 * 3_600_000, w.anchorToMs + 3_600_000) : [];
  const crm = callsOn && liveIds.length ? await deps.ourDb.crmLinks(liveIds) : new Map<string, { phones: string[]; crmIds: number[] }>();
  const gpsOn = !c.live && range.to >= settings.gpsSince;
  /** Sem GPS: antes do período do GPS; ao vivo, ainda por recolher (o GPS do dia só chega à noite). */
  const noGpsStatus: TransitStatus = c.live ? "gps_por_recolher" : "gps_fora_do_periodo";
  /** O GPS do Zello só existe desde `gpsSince` (dia de Lisboa do início). */
  const gpsOnAt = (at: number) => gpsOn && lisbonDayOf(at) >= settings.gpsSince;
  const checkins = gpsOn ? await deps.ourDb.pdaCheckins(w.readFromMs - 17 * 3_600_000, w.readToMs) : [];
  const fixed = gpsOn ? await deps.ourDb.fixedZellos() : [];
  const identity = await deps.identity();
  const phonesOf = (bookingId: string) => {
    const b = bookings.get(bookingId);
    const out = new Set<string>([...(driverPhones.get(bookingId) ?? []), ...(crm.get(bookingId)?.phones ?? [])]);
    const p9 = phone9Of(b?.clientPhone);
    if (p9) out.add(p9);
    return out;
  };
  const shared = sharedPhonesByDay([
    ...deliveries.map((d) => ({ day: operationalDayOf(d.requests[0]?.at ?? d.start?.at ?? d.anchor.at), bookingId: d.bookingId, phones: [...phonesOf(d.bookingId)] })),
    ...pickups.map((p) => ({ day: operationalDayOf(p.checkingIn?.at ?? p.anchor.at), bookingId: p.bookingId, phones: [...phonesOf(p.bookingId)] })),
  ]);
  const dispatch = dispatchStartIds(deliveries.filter((d) => d.start).map((d) => ({ id: d.start!.id, agentUserId: d.start!.agentUserId, at: d.start!.at, doneAt: d.checkout?.at ?? null, doneBy: d.checkout?.agentUserId ?? null })));

  // 4. Linhas já guardadas (finais e atuais não se refazem); ao vivo não se lê nem grava nada
  const existing = c.live ? [] : await deps.store.existing(utc0(w.anchorFromMs), utc0(w.anchorToMs));
  const existingByKey = new Map(existing.map((e) => [rowKey(e.kind, e.bookingId, e.anchorHistoryId), e]));
  const keepFinal = (kind: string, cyc: { bookingId: string; anchor: ServiceEvent }) => {
    if (c.force) return false;
    const e = existingByKey.get(rowKey(kind, cyc.bookingId, cyc.anchor.id));
    return !!e && !e.voided && e.gpsPass === "final" && e.calcVersion === SERVICE_TIMES_CALC_VERSION && e.paramsHash === c.hash;
  };
  const seenKeys = new Set<string>();

  // 5. O que cada ciclo precisa de GPS
  const gctx = { checkins, fixed };
  const requests = new Map<string, { zello: string; day: string }>();
  const ask = (list: Array<{ zello: string; day: string }>) => { for (const r of list) requests.set(gpsFileKey(r.zello, r.day), r); };
  const empOf = (e: ServiceEvent | null | undefined) => (e ? identity.agent(e.agentUserId, e.agentName) : null);
  const todoDel: DeliveryCycle[] = [], todoPick: PickupCycle[] = [];
  for (const d of deliveries) {
    seenKeys.add(rowKey("entrega", d.bookingId, d.anchor.id));
    if (keepFinal("entrega", d)) { rep.keptFinal++; continue; }
    todoDel.push(d);
    const who = empOf(d.start);
    if (gpsOnAt(d.start?.at ?? d.anchor.at) && d.outcome !== "cancelado" && d.start && d.checkout && who?.employeeId != null) {
      const S = d.start.at, E = d.checkout.at;
      // a janela do GPS começa antes do mais cedo entre a chamada (até 60 min antes do pendente) e S
      ask(gpsRequestsFor(gctx, who.employeeId, S, Math.min(S, d.requests[0]?.at ?? S) - CALL_WINDOW_BEFORE_MIN * 60_000 - G_GOOD_S * 1000 - 5 * 60_000, E + AFTER_SIGNATURE_S * 1000));
    }
  }
  for (const p of pickups) {
    seenKeys.add(rowKey("recolha", p.bookingId, p.anchor.id));
    if (keepFinal("recolha", p)) { rep.keptFinal++; continue; }
    todoPick.push(p);
    if (!p.checkIn || !gpsOnAt(p.checkIn.at)) continue;
    const I = p.checkIn.at;
    for (const e of [sortServiceEvents(p.moves).find((m) => m.at >= I) ?? null, p.checkIn]) {
      const who = empOf(e);
      if (who?.employeeId != null) ask(gpsRequestsFor(gctx, who.employeeId, I, I - G_GOOD_S * 1000, I + EXIT_SEARCH_MAX_MIN * 60_000));
    }
    const k0 = Math.min(p.checkingIn?.at ?? I, I);
    const who = empOf(p.checkIn);
    if (who?.employeeId != null) ask(gpsRequestsFor(gctx, who.employeeId, k0, k0 - (T2_LOOKBACK_MIN + CALL_WINDOW_BEFORE_MIN) * 60_000, I));
    const p2 = p2LeaveOf(p, settings.garageRoles);
    const mover = empOf(p2?.leave);
    if (p2 && mover?.employeeId != null) ask(gpsRequestsFor(gctx, mover.employeeId, p2.leave.at, p2.firstEnd.at, p2.leave.at));
  }
  const reqList = [...requests.values()].sort((a, b) => a.day.localeCompare(b.day));
  rep.gpsFiles.asked = reqList.length;
  // sem prazo para os ficheiros: ficam por recolher (a noite seguinte, ou o D-3 volta para trás)
  const files = reqList.length && !c.live && left() >= SERVICE_GPS_MIN_MS + 6_000 ? await deps.loadGps(reqList, { deadlineAt: c.deadlineAt - 6_000 }) : new Map<string, GpsFile>();
  for (const f of files.values()) { if (f.status === "ok" || f.status === "missing") rep.gpsFiles.read++; else if (f.reason === "prazo") rep.gpsFiles.skipped++; else rep.gpsFiles.failed++; }
  rep.gpsFiles.skipped += Math.max(0, reqList.length - files.size);
  const ctx: GpsCtx = { checkins, fixed, files, finalUntil: zelloLatestDay(c.nowMs) };
  const computedAt = utc0(c.nowMs);
  const rows: ServiceTimesRow[] = [];

  // 6. Entregas
  for (const d of todoDel) {
    const b = bookings.get(d.bookingId)!;
    const park = b.parkId ? parks.get(b.parkId) ?? null : null;
    const city = park?.zoneCity ?? null;
    const cls = terminalClassOf(b.deliveryType, city);
    const R = d.requests[0]?.at ?? null;
    const S = d.start?.at ?? null, E = d.checkout?.at ?? null;
    const cm = callsOn ? matchCallToBooking({ calls, phones: phonesOf(d.bookingId), crmIds: new Set(crm.get(d.bookingId)?.crmIds ?? []), anchorAt: R, fallbackAt: S, untilAt: E, shared: shared.get(operationalDayOf(R ?? S ?? d.anchor.at)) })
      : { call: null, flags: [] as string[] };
    const who = empOf(d.start);
    const role = agentRoleIn(agentRows, d.start?.agentUserId ?? null, b.parkId);
    const driverBlock = d.start ? driverBlockOf({ kind: who?.kind ?? null, role: role.role, dispatch: dispatch.has(d.start.id) }) : null;
    const extraFlags = [...cm.flags];
    if (role.otherPark) extraFlags.push("papel_de_outro_parque");
    let gps: GpsArrival | null = null;
    let inicioNoTerminal: { parkExitAt: number | null } | null = null;
    let held: HeldGps | null = null;
    let noGps: TransitStatus = "sem_pontos";
    const refs = parkRefs(city);
    const zoneRes = arrivalZoneFor({ terminalClass: cls, airport: city ? settings.airports[city] : null, signature: posOf(d.checkout), parks: refs });
    if (d.outcome !== "cancelado" && S != null && E != null && !driverBlock) {
      if (!gpsOnAt(S)) noGps = noGpsStatus;
      else if (who?.employeeId == null) noGps = "condutor_desconhecido";
      else {
        const Q0 = Math.min(R ?? S, cm.call?.at ?? Infinity, S);
        held = heldGps(ctx, who.employeeId, S, Q0 - G_GOOD_S * 1000 - 5 * 60_000, E + AFTER_SIGNATURE_S * 1000);
        if (held.kind === "no") noGps = held.status;
        else if (zoneRes.kind === "sem_zona") gps = { kind: "sem_chegada", status: zoneRes.status, flags: [] };
        else {
          let stop = detectStop({ points: held.points, startAt: S, endAt: E, zone: zoneRes.zone, parks: refs, startRow: posOf(d.start) });
          if (stop.kind === "inicio_no_terminal") {
            // a saída da garagem de ORIGEM (a mais perto da posição antes de sair)
            const parkZone = parkExitZone(held.points, Q0 - 5 * 60_000, S, refs);
            const exit = parkZone ? detectExit({ points: held.points, fromAt: Q0 - 5 * 60_000, untilAt: S, zone: parkZone }) : null;
            inicioNoTerminal = { parkExitAt: exit?.kind === "saida" ? exit.at : null };
            if (exit?.kind === "saida") stop = detectStop({ points: held.points, startAt: exit.at, endAt: E, zone: zoneRes.zone, parks: refs });
            else stop = { kind: "sem_chegada", status: "sem_pontos", flags: [] };
          }
          if (stop.kind === "chegada") gps = { kind: "chegada", at: stop.at, source: zoneRes.source, precisionS: stop.precisionS, flags: [...zoneRes.flags, ...stop.flags] };
          else if (stop.kind === "sem_chegada") {
            const pending = held.pending && (stop.status === "sem_pontos" || stop.status === "sem_paragem" || stop.status === "gps_parado");
            gps = { kind: "sem_chegada", status: pending ? "gps_por_recolher" : stop.status, flags: stop.flags };
          }
        }
      }
      // sem GPS: o "em entrega" marcado no terminal pela posição da linha (longe do parque)
      if (!inicioNoTerminal && (!held || held.kind === "no") && zoneRes.kind === "zona" && zoneRes.source === "gps_zona") {
        const sp = posOf(d.start);
        if (sp && latLngInside(sp, zoneRes.zone) && (nearestPark(sp, refs)?.distanceM ?? Infinity) >= D_START_FAR_FROM_PARK_M) inicioNoTerminal = { parkExitAt: null };
      }
    }
    const btn = d.button && S != null && E != null
      ? { at: d.button.at, coherent: buttonCoherent({ buttonAt: d.button.at, startAt: S, endAt: E, pressedBy: d.button.event?.agentUserId ?? null, driverAgentId: d.start?.agentUserId ?? null,
          distanceFromParkM: nearestPark(posOf(d.button.event ?? null), refs)?.distanceM ?? null }) }
      : null;
    const arrival = resolveArrival(gps, btn, noGps);
    const t = deliveryTimes({ cycle: d, call: cm.call, arrival, inicioNoTerminal, driverBlock });
    const flags = [...new Set([...t.flags, ...extraFlags])];
    rows.push({
      ...emptyRow("entrega", d.bookingId, d.anchor, c.hash, computedAt),
      outcome: t.outcome, bookingCode: b.code, parkId: b.parkId, cityKey: park?.cityKey ?? null, parkGroup: park?.group ?? null, terminalClass: cls,
      opDay: t.opDay, refHour: t.refHour, callAt: utc3(t.callAt), callSource: t.callSource, callHeld: t.callHeld == null ? null : t.callHeld ? 1 : 0,
      requestAt: utc3(t.requestAt), requestCount: t.requestCount, startSource: t.startSource, customerMs: clampInt(t.customerMs), customerStatus: t.customerStatus,
      zelloUsername: held?.zello ?? null, gpsPoints: held?.kind === "ok" ? held.points.length : null, gpsMaxGapS: held?.kind === "ok" ? held.maxGapS : null,
      gpsPass: held?.kind === "ok" ? held.pass : "none", flags: flags.length ? flags.join(",").slice(0, 600) : null,
      startedAt: utc3(t.startedAt), startAgentId: d.start?.agentUserId ?? null, startEmployeeId: who?.employeeId ?? null, startPlatform: d.start?.platform ?? null, startRole: role.role,
      arrivedAt: utc3(t.arrivedAt), arrivedSource: t.arrivedSource, arrivedPrecisionS: t.arrivedPrecisionS, buttonArrivedAt: utc3(t.buttonArrivedAt), buttonGapS: t.buttonGapS,
      baggageWaitingAt: utc3(d.baggageAt), deliveredAt: utc3(t.deliveredAt), deliverAgentId: d.checkout?.agentUserId ?? null, deliverEmployeeId: empOf(d.checkout)?.employeeId ?? null,
      queueMs: clampInt(t.queueMs), transitMs: clampInt(t.transitMs), ourMs: clampInt(t.ourMs), totalMs: clampInt(t.totalMs),
      queueStatus: t.queueStatus, transitStatus: t.transitStatus, ourStatus: t.ourStatus,
    });
  }

  // 7. Recolhas
  for (const p of todoPick) {
    const b = bookings.get(p.bookingId)!;
    const park = b.parkId ? parks.get(b.parkId) ?? null : null;
    const city = park?.zoneCity ?? null;
    const cls = terminalClassOf(b.deliveryType, city);
    const I = p.checkIn?.at ?? null;
    const K = p.checkingIn?.at ?? null;
    const cm = callsOn ? matchCallToBooking({ calls, phones: phonesOf(p.bookingId), crmIds: new Set(crm.get(p.bookingId)?.crmIds ?? []), anchorAt: K, fallbackAt: I, untilAt: I, shared: shared.get(operationalDayOf(K ?? p.anchor.at)) })
      : { call: null, flags: [] as string[] };
    const airport = city ? settings.airports[city] : null;
    const zoneRes = arrivalZoneFor({ terminalClass: cls, airport, signature: posOf(p.checkIn), parks: parkRefs(city) });
    const zone: Zone | null = zoneRes.kind === "zona" ? zoneRes.zone : null;
    const p2Zone = p2ZoneOf(c.zones, city);
    const overlap = !!p2Zone && (airport?.zones ?? []).some((z) => zonesTouch(p2Zone, z));
    const spot = spotTypeOf(b.parkingType, b.code);
    const gpsHere = I != null && gpsOnAt(I);
    let exit: ExitResolution = { kind: "sem_medicao", status: gpsHere ? "sem_zello" : noGpsStatus, flags: [] };
    let driver: { employeeId: number; held: HeldGps } | null = null;
    if (I != null && p.outcome === "recebido") {
      if (overlap) exit = { kind: "sem_medicao", status: "zonas_sobrepostas", flags: ["zonas_sobrepostas"] };
      else if (!zone) exit = { kind: "sem_medicao", status: "sem_zona", flags: [] };
      else if (gpsHere) {
        const firstMove = sortServiceEvents(p.moves).find((m) => m.at >= I) ?? null;
        let firstStatus: string | null = null;
        for (const e of [firstMove, p.checkIn]) {
          const who = empOf(e);
          if (who?.employeeId == null) { firstStatus ??= "condutor_desconhecido"; continue; }
          const hg = heldGps(ctx, who.employeeId, I, I - G_GOOD_S * 1000, I + EXIT_SEARCH_MAX_MIN * 60_000);
          driver ??= { employeeId: who.employeeId, held: hg };
          if (hg.kind === "no") { firstStatus ??= hg.status; continue; }
          const x = detectExit({ points: hg.points, fromAt: I, zone, startPos: posOf(p.checkIn) });
          // a zona do aeroporto inteiro (sem zona T1/T2 nem ponto do check-in) adianta-se pouco, mas é larga: fica marcado
          if (x.kind === "saida") { exit = { kind: "medido", at: x.at, source: "gps", precisionS: x.precisionS, flags: [...x.flags, ...(zoneRes.kind === "zona" ? zoneRes.flags : [])] }; driver = { employeeId: who.employeeId, held: hg }; break; }
          firstStatus ??= hg.pending && (x.status === "sem_pontos" || x.status === "sem_saida") ? "gps_por_recolher" : x.status;
        }
        if (exit.kind !== "medido") exit = { kind: "sem_medicao", status: firstStatus ?? "sem_zello", flags: [] };
      }
      if (exit.kind !== "medido" && zone && !overlap) exit = appTerminalExit(p, (lat, lng) => latLngInside({ lat, lng }, zone)) ?? exit;
    }
    // T2: o condutor do check-in chega à zona T2 (§3.4)
    let t2: { arrival: { at: number; alreadyThere: boolean } | { status: string }; targetMinutes: number } | null = null;
    if (cls === "t2" && I != null && p.outcome === "recebido") {
      const zT2 = terminalZoneFor(airport, "t2");
      const k0 = Math.min(cm.call?.at ?? Infinity, K ?? I);
      const who = empOf(p.checkIn);
      let arrival: { at: number; alreadyThere: boolean } | { status: string };
      if (!zT2) arrival = { status: "sem_zona_t2" };
      else if (!gpsOnAt(I)) arrival = { status: noGpsStatus };
      else if (who?.employeeId == null) arrival = { status: "sem_gps" };
      else {
        const hg = heldGps(ctx, who.employeeId, k0, k0 - T2_LOOKBACK_MIN * 60_000, I);
        if (hg.kind === "no") arrival = { status: hg.status === "gps_por_recolher" ? "gps_por_recolher" : "sem_gps" };
        else {
          const r = lastZoneArrival({ points: hg.points, fromAt: k0 - T2_LOOKBACK_MIN * 60_000, untilAt: I, zone: zT2 });
          arrival = r.kind === "chegada" ? { at: r.at, alreadyThere: r.alreadyThere } : { status: r.status === "sem_pontos" ? "sem_gps" : r.status };
        }
      }
      t2 = { arrival, targetMinutes: settings.t2TargetMinutes };
    }
    // saída do P2 pelo GPS (sem início de movimento): quem levou o carro do P2
    let p2GpsExitAt: number | null = null;
    const p2 = p2LeaveOf(p, settings.garageRoles);
    if (p2Zone && !overlap && p2 && gpsOnAt(p2.leave.at)) {
      const who = empOf(p2.leave);
      if (who?.employeeId != null) {
        const hg = heldGps(ctx, who.employeeId, p2.leave.at, p2.firstEnd.at, p2.leave.at);
        if (hg.kind === "ok") { const x = detectExit({ points: hg.points, fromAt: p2.firstEnd.at, untilAt: p2.leave.at, zone: p2Zone }); if (x.kind === "saida") p2GpsExitAt = x.at; }
      }
    }
    const t = pickupTimes({
      cycle: p, call: cm.call, checkingInAtTerminal: !!zone && zoneRes.kind === "zona" && zoneRes.source === "gps_zona" && latLngInside(posOf(p.checkingIn), zone),
      terminalExit: exit, roles: settings.garageRoles, spotType: spot, p2GpsExitAt, t2, now: c.nowMs,
    });
    const flags = [...new Set([...t.flags, ...cm.flags])];
    const held = driver?.held ?? null;
    rows.push({
      ...emptyRow("recolha", p.bookingId, p.anchor, c.hash, computedAt),
      outcome: t.outcome, bookingCode: b.code, parkId: b.parkId, cityKey: park?.cityKey ?? null, parkGroup: park?.group ?? null, terminalClass: cls,
      opDay: t.opDay, refHour: t.refHour, callAt: utc3(t.callAt), callSource: t.callSource, callHeld: t.callHeld == null ? null : t.callHeld ? 1 : 0,
      requestAt: utc3(t.requestAt), requestCount: t.requestCount, startSource: t.startSource, customerMs: clampInt(t.customerMs), customerStatus: t.customerStatus,
      zelloUsername: held?.zello ?? null, gpsPoints: held?.kind === "ok" ? held.points.length : null, gpsMaxGapS: held?.kind === "ok" ? held.maxGapS : null,
      gpsPass: held?.kind === "ok" ? held.pass : "none", flags: flags.length ? flags.join(",").slice(0, 600) : null,
      checkInAt: utc3(t.checkInAt), checkInAgentId: p.checkIn?.agentUserId ?? null, checkInEmployeeId: empOf(p.checkIn)?.employeeId ?? null,
      // quem tirou o carro do terminal: o do GPS que mostrou a saída; senão quem fez o 1.º movimento; senão o do check-in
      driverEmployeeId: exit.kind === "medido" && exit.source === "gps" ? driver?.employeeId ?? null : empOf(firstMoveOf(p))?.employeeId ?? empOf(p.checkIn)?.employeeId ?? null,
      terminalExitAt: utc3(t.terminalExitAt), terminalExitSource: t.terminalExitSource, terminalMs: clampInt(t.terminalMs), terminalStatus: t.terminalStatus,
      firstGarage: t.firstGarage, firstGarageRole: t.firstGarageRole, firstGarageAt: utc3(t.firstGarageAt), toFirstGarageMs: clampInt(t.toFirstGarageMs),
      p2ExitAt: utc3(t.p2ExitAt), p2Ms: clampInt(t.p2Ms), p2Status: t.p2Status, p2EmployeeId: empOf(t.p2Mover)?.employeeId ?? null,
      parkedGarage: t.parkedGarage, parkedAt: utc3(t.parkedAt), toParkedMs: clampInt(t.toParkedMs),
      parkedStatus: t.parkedStatus, parkedEmployeeId: empOf(t.parker)?.employeeId ?? null, spotType: spot, t2DriverArrivedAt: utc3(t.t2DriverArrivedAt), t2LateMs: clampInt(t.t2LateMs), t2Status: t.t2Status,
    });
  }

  // 8. Gravar (upsert) e anular o que deixou de aparecer (só com a leitura completa); ao vivo, nada
  if (c.live) return { report: rep, rows };
  if (rows.length) await deps.store.upsert(rows.map(fitServiceRow));
  rep.written = rows.length;
  if (!rep.truncated) {
    const active = existing.filter((e) => !e.voided);
    const gone = active.filter((e) => !seenKeys.has(rowKey(e.kind, e.bookingId, e.anchorHistoryId))).map((e) => e.id);
    // uma leitura vazia (ou que perde de repente muitas linhas) é suspeita: não se anula nada e fica no log
    if (gone.length && (rep.historyRows === 0 || (gone.length > VOID_MAX_ROWS && gone.length > active.length * VOID_MAX_SHARE))) rep.voidSuspended = gone.length;
    else if (gone.length) { await deps.store.voidRows(gone, computedAt); rep.voided = gone.length; }
  }
  return { report: rep, rows };
}

/**
 * O carro foi para o P2 e saiu de lá SEM linha de início de movimento (a
 * saída do P2 só se sabe pelo GPS de quem o levou): a chegada ao P2 e o fim
 * do movimento que o tirou de lá (até 24 h). PURA.
 */
export function p2LeaveOf(p: PickupCycle, roles: readonly GarageRoleEntry[]): { firstEnd: ServiceEvent; leave: ServiceEvent } | null {
  const I = p.checkIn?.at;
  if (I == null) return null;
  const moves = sortServiceEvents(p.moves);
  const firstEnd = moves.find((m) => m.garageTo && m.at >= I);
  if (!firstEnd || garageRoleOf(firstEnd.garageTo, roles).role !== "provisoria") return null;
  const leave = moves.find((m) => m.at > firstEnd.at && m.garageTo && garageRoleOf(m.garageTo, roles).role !== "provisoria");
  if (!leave || leave.at - firstEnd.at > 24 * 3_600_000) return null;
  if (moves.some((m) => m.moveKind === "inicio" && m.at > firstEnd.at && m.at <= leave.at)) return null;
  return { firstEnd, leave };
}

function emptyRow(kind: "entrega" | "recolha", bookingId: string, anchor: ServiceEvent, hash: string, computedAt: string): ServiceTimesRow {
  const r = Object.fromEntries(SERVICE_TIMES_ROW_COLUMNS.map((k) => [k, null])) as unknown as ServiceTimesRow;
  return { ...r, kind, bookingId, anchorHistoryId: anchor.id, anchorAt: utc3(anchor.at)!, requestCount: 0, gpsPass: "none", calcVersion: SERVICE_TIMES_CALC_VERSION, paramsHash: hash, computedAt, voidedAt: null } as ServiceTimesRow;
}

// ─── Resumo para o log ──────────────────────────────────────────────────────

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : "—");
const p = (vals: number[], q: number) => { const v = percentile(vals, q); return v == null ? "—" : String(Math.round(v / 60_000)); };
const hm = (vals: number[], q: number) => { const v = percentile(vals, q); if (v == null) return "—"; const m = Math.round(v / 60_000); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : String(m); };

/**
 * Uma linha por (dia, cidade): "[tempos] 2026-10-14 lisboa: entregas 212 (fila
 * p75 6, com chamada 41 %; trânsito p75 14, GPS 62 %; na meta 58 %) ·
 * recolhas 180 (cliente p50 18; terminal p75 9; P2 p75 2h10; T2 atrasadas
 * 5/22) · motivos {…}". Só números agregados (nada pessoal). PURA.
 */
export function summarizeServiceDay(rows: readonly ServiceTimesRow[], day: string, city: string, targetMinutes: number): string | null {
  const mine = rows.filter((r) => r.opDay === day && (r.cityKey ?? "?") === city && r.outcome !== "cancelado");
  if (!mine.length) return null;
  const del = mine.filter((r) => r.kind === "entrega"), pick = mine.filter((r) => r.kind === "recolha");
  const ok = (s: string | null) => s === "medido";
  const num = (xs: Array<number | null>) => xs.filter((x): x is number => x != null);
  const queue = num(del.filter((r) => ok(r.queueStatus)).map((r) => r.queueMs));
  const transit = num(del.filter((r) => ok(r.transitStatus)).map((r) => r.transitMs));
  const ours = del.filter((r) => ok(r.ourStatus));
  const inTarget = ours.filter((r) => withinTarget({ ourMs: r.ourMs, ourStatus: r.ourStatus ?? "" }, targetMinutes)).length;
  const reasons: Record<string, number> = {};
  for (const r of del) if (r.transitStatus && r.transitStatus !== "medido") reasons[r.transitStatus] = (reasons[r.transitStatus] ?? 0) + 1;
  for (const r of pick) if (r.terminalStatus && r.terminalStatus !== "medido") reasons[`terminal:${r.terminalStatus}`] = (reasons[`terminal:${r.terminalStatus}`] ?? 0) + 1;
  const t2 = pick.filter((r) => r.terminalClass === "t2" && ok(r.t2Status));
  const late = t2.filter((r) => (r.t2LateMs ?? 0) > 0).length;
  return `[tempos] ${day} ${city}: entregas ${del.length} (fila p75 ${p(queue, 0.75)}, com chamada ${pct(del.filter((r) => r.startSource === "chamada").length, del.length)}; `
    + `trânsito p75 ${p(transit, 0.75)}, GPS ${pct(transit.length, del.length)}; na meta ${pct(inTarget, ours.length)}) · `
    + `recolhas ${pick.length} (cliente p50 ${p(num(pick.filter((r) => ok(r.customerStatus)).map((r) => r.customerMs)), 0.5)}; terminal p75 ${p(num(pick.filter((r) => ok(r.terminalStatus)).map((r) => r.terminalMs)), 0.75)}; `
    + `P2 p75 ${hm(num(pick.filter((r) => ok(r.p2Status)).map((r) => r.p2Ms)), 0.75)}; T2 atrasadas ${late}/${t2.length}) · motivos ${JSON.stringify(reasons)}`;
}

// ─── Ao vivo (sem gravar) ───────────────────────────────────────────────────

export type ServiceLiveDeps = Pick<ServiceTimesDeps, "query" | "now" | "settings" | "ourDb" | "identity">;

/**
 * Os tempos dos ciclos que fecharam nos dias operacionais [from, to], AGORA,
 * com as regras do trabalho noturno mas sem GPS (Trânsito, Cliente das
 * entregas, Nosso, No terminal e T2 ficam "GPS por recolher") e sem escrever
 * nada: é o Resumo do dia enquanto a tabela dos tempos está vazia (interruptor
 * desligado ou dia ainda por calcular). Uma leitura da History, só leitura.
 * Nunca lança: a Multipark em baixo → `ok:false` com o motivo.
 */
export async function computeServiceRowsLive(deps: ServiceLiveDeps, o: { from: string; to: string; deadlineAt: number }): Promise<{ ok: true; rows: ServiceTimesRow[]; truncated: boolean } | { ok: false; error: string }> {
  try {
    const settings = await deps.settings();
    const nowMs = deps.now();
    const pq = buildServiceParksSql(), gq = buildGaragesSql();
    const [parkRows, garageRows] = await Promise.all([deps.query<Record<string, unknown>>(pq.sql, pq.params), deps.query<Record<string, unknown>>(gq.sql, gq.params)]);
    const zones = effectiveParkZones(garageCoordsOf(garageRows, parkRows), settings.parkZones).zones;
    const neverStore: ServiceStore = {
      loadState: async () => null, saveState: async () => undefined, existing: async () => [], upsert: async () => { throw new Error("ao vivo não grava"); }, voidRows: async () => undefined,
    };
    const full: ServiceTimesDeps = { ...deps, loadGps: async () => new Map(), store: neverStore };
    const { report, rows } = await processRange({ deps: full, settings, hash: "0000000000000000", nowMs, deadlineAt: o.deadlineAt, force: true, live: true, parkRows, zones }, { from: o.from, to: o.to }, "reprocessar");
    return { ok: true, rows, truncated: report.truncated };
  } catch (err) {
    const r = describeReadFailure(err);
    return { ok: false, error: r.reason };
  }
}

// ─── A corrida ──────────────────────────────────────────────────────────────

export const SERVICE_TIMES_RUN_READS_MS = 20_000;
export const SERVICE_TIMES_MAX_READS = 2;

/** Corre o trabalho (uma corrida do agendador ou do endpoint manual). Nunca lança. */
export async function runServiceTimes(deps: ServiceTimesDeps, o: { deadlineAt: number; reprocess?: { from: string; to: string } | null }): Promise<ServiceTimesRunResult> {
  const startedAt = Date.now();
  const log = deps.log ?? ((l: string) => console.log(l));
  const out: ServiceTimesRunResult = { ok: true, done: true, cursor: null, ranges: [], lines: [] };
  try {
    const settings = await deps.settings();
    const nowMs = deps.now();
    const today = operationalDayOf(nowMs);
    // Parques e garagens da Multipark (tabelas pequenas, uma vez por corrida): Q6 — as zonas vêm das garagens
    const pq = buildServiceParksSql(), gq = buildGaragesSql();
    const [parkRows, garageRows] = await Promise.all([deps.query<Record<string, unknown>>(pq.sql, pq.params), deps.query<Record<string, unknown>>(gq.sql, gq.params)]);
    const zones = effectiveParkZones(garageCoordsOf(garageRows, parkRows), settings.parkZones).zones;
    const hash = serviceParamsHash({
      zones,
      terminal: Object.fromEntries(Object.entries(settings.airports).map(([k, a]) => [k, a?.zones ?? []])),
      roles: settings.garageRoles,
      callWindow: [CALL_WINDOW_BEFORE_MIN, CALL_WINDOW_AFTER_MIN],
      useCalls: settings.useCalls,
    });
    const ctx = (force: boolean): RangeCtx => ({ deps, settings, hash, nowMs, deadlineAt: o.deadlineAt, force, parkRows, zones });
    let lastRows: ServiceTimesRow[] = [];
    const run = async (range: { from: string; to: string }, reason: RangeReport["reason"], force: boolean) => {
      const { report, rows } = await processRange(ctx(force), range, reason);
      out.ranges.push(report);
      if (reason === "noite") {
        const day = range.to;
        for (const city of ["lisboa", "porto", "faro"]) { const l = summarizeServiceDay(rows, day, city, settings.targetMinutes); if (l) { out.lines.push(l); log(l); } }
      }
      lastRows = rows;
      const l = `[tempos] ${reason} ${range.from}..${range.to}: entregas ${report.deliveries}, recolhas ${report.pickups}, gravadas ${report.written}, finais mantidas ${report.keptFinal}, anuladas ${report.voided}, abertas ${report.openCycles}, GPS ${report.gpsFiles.read}/${report.gpsFiles.asked}${report.gpsFiles.failed ? ` (${report.gpsFiles.failed} falharam)` : ""}${report.gpsFiles.skipped ? ` (${report.gpsFiles.skipped} sem prazo, por recolher)` : ""}${report.truncated ? ", LEITURA CORTADA" : ""}${report.voidSuspended ? `, ANULAÇÃO SUSPENSA (${report.voidSuspended} linhas deixaram de aparecer${report.historyRows === 0 ? " numa leitura vazia" : ""})` : ""}`;
      out.lines.push(l);
      log(l);
    };

    const blockOpts = { days: BACKFILL_DAYS, gpsDays: BACKFILL_GPS_DAYS, gpsSince: settings.gpsSince };
    const canStart = () => o.deadlineAt - Date.now() >= SERVICE_TIMES_RANGE_MIN_MS;

    // À mão: só o intervalo pedido (força refazer), em blocos (7 dias; 2 com GPS), com cursor
    if (o.reprocess) {
      const { block, rest } = nextBackfillBlock([o.reprocess], blockOpts);
      if (!canStart()) return { ...out, done: false, cursor: `${o.reprocess.from}..${o.reprocess.to}`, skipped: "sem prazo para uma leitura" };
      if (block) await run(block, "reprocessar", true);
      out.done = rest.length === 0;
      // o que falta (chamar outra vez com ?reprocessar=<isto>)
      out.cursor = rest.length ? `${rest[0].from}..${rest[rest.length - 1].to}` : null;
      return out;
    }

    const prev = await deps.store.loadState();
    let state = nextServiceState(prev, { version: SERVICE_TIMES_CALC_VERSION, hash, today, since: settings.since });
    let reads = 0;
    if (state.nightly !== today) {
      // sem prazo para a leitura da noite neste tick: fica para o seguinte (a meio, não falhado)
      if (!canStart()) return { ...out, done: false, cursor: "noite" };
      await run({ from: addDays(today, -3), to: addDays(today, -1) }, "noite", false);
      reads++;
      // D-3 é a última noite em que o GPS se lê: o que ficou por recolher (ficheiro que falhou, prazo) tenta-se já nos blocos seguintes
      const pendingD3 = lastRows.some((r) => r.opDay <= addDays(today, -3) && (r.transitStatus === "gps_por_recolher" || r.terminalStatus === "gps_por_recolher"));
      state = { ...state, nightly: today, todo: pendingD3 ? mergeDayRanges([...state.todo, { from: addDays(today, -3), to: addDays(today, -3) }]) : state.todo };
      await deps.store.saveState(state);
    }
    // para trás só de madrugada / manhã cedo (até às 09h de Lisboa): o que faltar fica para amanhã
    const backfillHours = lisbonHourOf(nowMs) < BACKFILL_UNTIL_HOUR;
    if (state.todo.length && !backfillHours) {
      const l = `[tempos] para trás: ${state.todo.length} intervalo(s) por fazer — continua amanhã de manhã (só até às ${BACKFILL_UNTIL_HOUR}h)`;
      out.lines.push(l);
      log(l);
      return { ...out, done: true, cursor: null };
    }
    while (state.todo.length && reads < SERVICE_TIMES_MAX_READS && Date.now() - startedAt < SERVICE_TIMES_RUN_READS_MS && canStart()) {
      const { block, rest } = nextBackfillBlock(state.todo, blockOpts);
      if (!block) break;
      await run(block, "para_tras", false);
      reads++;
      state = { ...state, todo: rest };
      await deps.store.saveState(state);
    }
    out.done = state.todo.length === 0;
    out.cursor = out.done ? null : `para_tras:${state.todo.length}`;
    return out;
  } catch (err) {
    const r = describeReadFailure(err);
    const msg = r.code === "QUERY_FAILED" && !/multipark/i.test(String((err as Error)?.message ?? "")) ? `${r.reason} (${String((err as Error)?.message ?? err).slice(0, 160)})` : r.reason;
    log(`[tempos] falhou: ${msg}`);
    return { ...out, ok: false, done: false, error: msg };
  }
}
