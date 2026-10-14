/**
 * Plano 62, P0 — as contas da sonda dos tempos, PURAS (sem BD, sem rede).
 *
 * Recebe o que o servidor já leu (linhas da History da Multipark de um dia
 * operacional + 48 h, reservas, agentes, garagens, telefones só em memória,
 * chamadas da nossa BD e os pontos do Zello COM posição) e devolve um
 * `SondaResult` (shared/sondaTempos.ts) só com agregados.
 *
 * Não depende da P3/P4 (§11.0): emparelha os estados por reserva num ciclo
 * simples (o 1.º de cada tipo, como a Pressão) e conta à parte as exceções
 * (CHECK_OUT repetido, reaberturas, recolhas reiniciadas). As regras de
 * paragem e de saída daqui são para MEDIR as combinações de parâmetros; as
 * definitivas são as da P4 (`detectStop`/`detectExit`).
 */
import { isSystemAgentId } from "../shared/agentIdentity";
import { lisbonMidnightUtcMs, addDays } from "../shared/lisbonDay";
import { type MovementKind } from "../shared/multiparkMovements";
import { distanceMeters, type AirportFence, type TerminalZone } from "../shared/pontoTerminal";
import {
  CALL_HIST_AFTER_MIN, CALL_HIST_BEFORE_MIN, CALL_LATE_AFTER_MIN, CALL_WINDOW_AFTER_MIN, CALL_WINDOW_BEFORE_MIN,
  EXIT_CAR_SPEEDS_KMH, EXIT_MARGINS_M, FALLBACK_NEXT_KMH, GAP_MOVING_KMH, PARK_FAR_M, PARK_OK_M, PICKUP_GPS_WINDOW_MIN, PICKUP_TRACK_MAX_HOURS,
  PLAN_CONFIRM_S, PLAN_GAP_GOOD_S, PLAN_GAP_WEAK_S, PLAN_STOP_MIN_S, PLAN_TAIL_MAX_S, WALK_KMH,
  GARAGE_MAX_FROM_PARK_M, PROBE_TERMINAL_RADIUS_M, QUICK_PICKUP_MIN, SHARED_PHONE_MIN_BOOKINGS, STOP_MIN_SECONDS, STOP_RADII_M, STOP_SPEEDS_KMH, T2_LATE_AFTER_MIN,
  SondaAcc, emptySondaResult, exitComboKey, stopComboKey,
  type ProbeCity, type ProbeGarageInfo, type ProbeZoneInfo, type SondaResult, type SondaStatic,
} from "../shared/sondaTempos";
import { matchKey } from "../shared/textKey";

const MIN = 60_000;

// ─── Entradas ───────────────────────────────────────────────────────────────

/** Uma linha da History (só o que a sonda usa; nada do cliente). */
export interface ProbeEvent {
  id: string;
  bookingId: string;
  type: string;
  atMs: number;
  uid: string | null;
  agentName: string | null;
  platform: string | null;
  lat: number | null;
  lng: number | null;
  hasSnapshot: boolean;
  snapStatus: string | null;
  snapArrivedMs: number | null;
  snapBaggageMs: number | null;
  /** MOVEMENT: tipo e garagens (de/para, minúsculas como no classifyMovement) */
  moveKind: MovementKind | null;
  garageFrom: string | null;
  garageTo: string | null;
  /** UPDATE: o estado para onde foi ("status".to) */
  updateStatusTo: string | null;
}

export type TerminalClass = "t1" | "t2" | "vip" | "other" | "unknown";
export interface ProbeBooking { id: string; parkId: string; terminalClass: TerminalClass }
export interface ProbePark { id: string; name?: string | null; city: ProbeCity; lat: number | null; lng: number | null }
/** Uma linha da tabela Garage, já com as coordenadas que a Multipark tem (Q6) e de onde vieram. */
export interface ProbeGarage { name: string; parkingType: string | null; parkId: string; mapHasCoords: boolean; lat?: number | null; lng?: number | null; coordSource?: string }
/** Um ponto do Zello COM posição (a P4 vai usar a mesma variante do loadPoints). */
export interface PosPoint { ts: number; speed: number; lat: number; lon: number; accurate: boolean }
export interface ProbeGpsFile { id: number; day: string; split: boolean; points: PosPoint[]; mine: (tsSec: number) => boolean }
export type GpsEmpStatus = "ok" | "sem_linha" | "sem_ficheiro" | "por_ler";
export interface ProbeGpsEmp { status: GpsEmpStatus; files: ProbeGpsFile[] }
/** Uma chamada RECEBIDA (central ou WhatsApp); o número só como os últimos 9 algarismos, em memória. */
export interface ProbeCall { source: "central" | "whatsapp"; atMs: number; last9: string | null; held: boolean; crmClientId: number | null; createdAtMs: number | null }
export type AgentResolution = { kind: "sistema" | "parceiro" | "sem_ficha" } | { kind: "ficha"; employeeId: number };

export interface ProbeCityInput {
  city: ProbeCity;
  day: string;
  opStartMs: number;
  opEndMs: number;
  events: ProbeEvent[];
  bookings: ReadonlyMap<string, ProbeBooking>;
  parks: ReadonlyMap<string, ProbePark>;
  /** todas as garagens (para os nomes); as da cidade vão para o `s` */
  garages: readonly ProbeGarage[];
  /** userId → linhas Agent (uma por parque) */
  agents: ReadonlyMap<string, ReadonlyArray<{ parkId: string; role: string }>>;
  resolveAgent: (uid: string | null, name: string | null) => AgentResolution;
  gps: ReadonlyMap<number, ProbeGpsEmp>;
  /** reserva → últimos 9 algarismos dos telefones (Client, Driver, CRM) */
  phones: ReadonlyMap<string, ReadonlySet<string>>;
  /** reserva → fichas do CRM ligadas */
  crmIds: ReadonlyMap<string, ReadonlySet<number>>;
  calls: readonly ProbeCall[];
  airport: AirportFence | null;
  /** o que é de TODA a corrida (chamadas recebidas no dia, linhas do Histórico Diário do dia D, ficheiros por ler): só na 1.ª cidade */
  global?: { gpsRows: ReadonlyArray<{ pass: string; hasFile: boolean }>; filesPending: number; calls: readonly ProbeCall[] };
  /** colunas com posições na BD da Multipark ("Garage.mapLink (text)", …) */
  coordColumns?: string[];
  staticBase: Omit<SondaStatic, "garages" | "zones" | "airportRadiusM" | "coordColumns">;
  truncated?: boolean;
  failures?: string[];
  /**
   * Leituras que falharam neste dia: o que depende delas NÃO conta (nem como
   * zero) e fica `falhas.<leitura>` = 1 para o relatório o dizer.
   *  - chamadas: as chamadas ou os telefones das reservas (Multipark/CRM);
   *  - gps: as fichas (agente → ficha) ou as linhas/ficheiros do GPS;
   *  - agentes: os papéis (Agent);
   *  - garagens: a tabela Garage.
   */
  unavailable?: Partial<Record<ProbeSource, boolean>>;
}
export type ProbeSource = "chamadas" | "gps" | "agentes" | "garagens";

// ─── Ciclos por reserva ─────────────────────────────────────────────────────

const TYPE_ORDER: Record<string, number> = { CREATED: 0, CHECKING_IN: 1, CHECK_IN: 2, MOVEMENT: 3, PENDING_CHECKOUT: 4, CHECKING_OUT: 5, CHECK_OUT: 6, UPDATE: 7, CANCEL: 8 };

export interface DeliveryCycle {
  bookingId: string;
  R: ProbeEvent | null;
  S: ProbeEvent | null;
  E: ProbeEvent | null;
  pend: ProbeEvent[];
  events: ProbeEvent[];
  outcome: "entregue" | "cancelado" | "aberto";
}
export interface PickupCycle {
  bookingId: string;
  K: ProbeEvent | null;
  I: ProbeEvent | null;
  moves: ProbeEvent[];
  events: ProbeEvent[];
  outcome: "recebido" | "cancelado" | "aberto";
}
export type CycleNoteKind = "checkout_repetido" | "reaberturas" | "fecho_repetido" | "checkin_repetido" | "recolha_reiniciada" | "pedido_reiniciado";
export interface CycleNote { kind: CycleNoteKind; atMs: number }

const sortEvents = (evs: readonly ProbeEvent[]) =>
  [...evs].sort((a, b) => a.atMs - b.atMs || (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.id.localeCompare(b.id));

/**
 * Ciclos de entrega e de recolha de UMA reserva (as linhas dela, por ordem).
 * Entrega: pendente (R) e início (S) = o 1.º de cada desde o último fecho;
 * fecha no CHECK_OUT (E). Um CHECK_OUT sem pedido nem início novo depois de
 * outro = repetido; um UPDATE para CHECKED_IN depois de entregue = reabertura.
 * Recolha: "em recolha" (K) = o 1.º CHECKING_IN; fecha no CHECK_IN (I); os
 * MOVEMENT até 48 h depois ficam na recolha. PURA.
 */
export function buildBookingCycles(events: readonly ProbeEvent[]): { deliveries: DeliveryCycle[]; pickups: PickupCycle[]; notes: CycleNote[] } {
  const deliveries: DeliveryCycle[] = [];
  const pickups: PickupCycle[] = [];
  const notes: CycleNote[] = [];
  const bookingId = events[0]?.bookingId ?? "";
  const newD = (): DeliveryCycle => ({ bookingId, R: null, S: null, E: null, pend: [], events: [], outcome: "aberto" });
  const newP = (): PickupCycle => ({ bookingId, K: null, I: null, moves: [], events: [], outcome: "aberto" });
  let d = newD();
  let p = newP();
  let lastD: DeliveryCycle | null = null;
  let lastP: PickupCycle | null = null;
  let reopened = false;
  for (const ev of sortEvents(events)) {
    switch (ev.type) {
      case "PENDING_CHECKOUT":
        if (!d.R) d.R = ev;
        d.pend.push(ev);
        d.events.push(ev);
        break;
      case "CHECKING_OUT":
        if (!d.S) d.S = ev;
        d.events.push(ev);
        break;
      case "CHECK_OUT": {
        if (!d.R && !d.S && lastD?.outcome === "entregue") {
          notes.push({ kind: reopened ? "fecho_repetido" : "checkout_repetido", atMs: ev.atMs });
          reopened = false;
          break;
        }
        d.E = ev;
        d.events.push(ev);
        d.outcome = "entregue";
        deliveries.push(d);
        lastD = d;
        d = newD();
        reopened = false;
        break;
      }
      case "UPDATE": {
        const to = String(ev.updateStatusTo ?? "").toUpperCase();
        if (to === "CHECKED_IN") {
          if (d.R || d.S) { notes.push({ kind: "pedido_reiniciado", atMs: ev.atMs }); d = newD(); }
          else if (lastD?.outcome === "entregue" && !reopened) { notes.push({ kind: "reaberturas", atMs: ev.atMs }); reopened = true; }
        }
        if ((to === "BOOKED" || to === "PENDING") && p.K && !p.I) { notes.push({ kind: "recolha_reiniciada", atMs: ev.atMs }); p = newP(); }
        break;
      }
      case "CANCEL":
        if (d.R || d.S) { d.outcome = "cancelado"; d.events.push(ev); deliveries.push(d); d = newD(); }
        if (p.K) { p.outcome = "cancelado"; p.events.push(ev); pickups.push(p); p = newP(); }
        break;
      case "CHECKING_IN":
        if (!p.K) p.K = ev;
        p.events.push(ev);
        break;
      case "CHECK_IN":
        if (!p.K && lastP?.outcome === "recebido") { notes.push({ kind: "checkin_repetido", atMs: ev.atMs }); break; }
        p.I = ev;
        p.events.push(ev);
        p.outcome = "recebido";
        pickups.push(p);
        lastP = p;
        p = newP();
        break;
      case "MOVEMENT":
        if (lastP?.I && ev.atMs >= lastP.I.atMs && ev.atMs - lastP.I.atMs <= PICKUP_TRACK_MAX_HOURS * 3_600_000) {
          lastP.moves.push(ev);
          lastP.events.push(ev);
        }
        break;
      default:
        break;
    }
  }
  if (d.R || d.S) deliveries.push(d);
  if (p.K) pickups.push(p);
  return { deliveries, pickups, notes };
}

/** Instante de referência (o dia a que pertence): entrega = min(R, S) ou E; recolha = K ou I. PURA. */
export const deliveryRefMs = (d: DeliveryCycle): number | null =>
  d.R || d.S ? Math.min(d.R?.atMs ?? Infinity, d.S?.atMs ?? Infinity) : d.E?.atMs ?? null;
export const pickupRefMs = (p: PickupCycle): number | null => p.K?.atMs ?? p.I?.atMs ?? null;

// ─── GPS ────────────────────────────────────────────────────────────────────

/** Os pontos precisos "meus" de uma pessoa em [a, b] (todos os ficheiros, sem repetir o instante). PURA. */
export function myPoints(emp: ProbeGpsEmp | undefined, aMs: number, bMs: number): PosPoint[] {
  if (!emp || emp.status !== "ok") return [];
  const a = aMs / 1000, b = bMs / 1000;
  const seen = new Set<number>();
  const out: PosPoint[] = [];
  for (const f of emp.files) {
    for (const p of f.points) {
      if (p.ts < a || p.ts > b || !p.accurate || seen.has(p.ts) || !f.mine(p.ts)) continue;
      seen.add(p.ts);
      out.push(p);
    }
  }
  return out.sort((x, y) => x.ts - y.ts);
}

/** Algum ficheiro partido por check-ins de PDA tem pontos meus na janela? PURA. */
export function windowUsesPda(emp: ProbeGpsEmp | undefined, aMs: number, bMs: number): boolean {
  if (!emp) return false;
  const a = aMs / 1000, b = bMs / 1000;
  return emp.files.some((f) => f.split && f.points.some((p) => p.ts >= a && p.ts <= b && p.accurate && f.mine(p.ts)));
}

/**
 * Intervalos entre pontos seguidos que tocam [a, b] (inclui o que vem de
 * antes e o que vai para depois). "A andar" = um dos dois a mais de 10 km/h. PURA.
 */
export function windowGaps(pts: readonly PosPoint[], aMs: number, bMs: number): Array<{ gapS: number; moving: boolean }> {
  const a = aMs / 1000, b = bMs / 1000;
  const out: Array<{ gapS: number; moving: boolean }> = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1];
    if (p.ts > b || q.ts < a) continue;
    out.push({ gapS: q.ts - p.ts, moving: Math.max(p.speed, q.speed) > GAP_MOVING_KMH });
  }
  return out;
}

const distTo = (p: { lat: number; lon: number }, lat: number, lng: number) => distanceMeters(p.lat, p.lon, lat, lng);

/**
 * Paragem dentro do círculo (centro, raio) entre S e E (+2 min): o 1.º ponto
 * dentro a ≤ V que fica dentro e a ≤ V durante ≥ T segundos — ou até ao
 * último ponto antes de E, com E − início ≥ T (o carro ficou lá até à
 * assinatura). `lastsUntilEnd` = a paragem chega ao último ponto antes de E. PURA.
 */
export function terminalStop(
  pts: readonly PosPoint[],
  o: { lat: number; lng: number; radiusM: number; vMaxKmh: number; minStopS: number; startMs: number; endMs: number },
): { found: false } | { found: true; startMs: number; lastsUntilEnd: boolean } {
  const S = o.startMs / 1000, E = o.endMs / 1000;
  const w = pts.filter((p) => p.ts >= S && p.ts <= E + 120);
  const ok = (p: PosPoint) => p.speed <= o.vMaxKmh && distTo(p, o.lat, o.lng) <= o.radiusM;
  let lastBeforeE = -1;
  for (let k = 0; k < w.length; k++) if (w[k].ts <= E) lastBeforeE = k;
  for (let i = 0; i <= lastBeforeE; i++) {
    if (!ok(w[i])) continue;
    let j = i;
    while (j + 1 < w.length && ok(w[j + 1])) j++;
    const reachesEnd = j >= lastBeforeE;
    if (w[j].ts - w[i].ts >= o.minStopS || (reachesEnd && E - w[i].ts >= o.minStopS)) {
      return { found: true, startMs: w[i].ts * 1000, lastsUntilEnd: reachesEnd };
    }
    i = j;
  }
  return { found: false };
}

/**
 * Saída do terminal depois do check-in: o 1.º ponto fora do círculo "de
 * carro" (a mais de V, ou a mais de raio + margem do centro) com o ponto
 * seguinte também fora. X = meio entre o último ponto dentro (ou o check-in)
 * e esse ponto. PURA.
 */
export function terminalExit(
  pts: readonly PosPoint[],
  o: { lat: number; lng: number; radiusM: number; marginM: number; vCarKmh: number; fromMs: number; toMs: number },
): number | null {
  const w = pts.filter((p) => p.ts * 1000 >= o.fromMs && p.ts * 1000 <= o.toMs);
  let lastInside = o.fromMs / 1000;
  for (let k = 0; k < w.length; k++) {
    const d = distTo(w[k], o.lat, o.lng);
    if (d <= o.radiusM) { lastInside = w[k].ts; continue; }
    const car = w[k].speed > o.vCarKmh || d > o.radiusM + o.marginM;
    if (!car) continue;
    const nx = w[k + 1];
    if (!nx) return null;
    if (distTo(nx, o.lat, o.lng) <= o.radiusM) continue;
    return ((lastInside + w[k].ts) / 2) * 1000;
  }
  return null;
}

export type ArrivalVia = "parado" | "confirmado" | "ate_assinatura" | "recurso";
export type ArrivalPrecision = "boa (≤ 6 min)" | "fraca (6–15 min)" | "buraco (> 15 min)" | "sem ponto nos 15 min antes";

/**
 * A chegada pela regra do plano (§4.4, passos 2–5), para a P0 a medir tal
 * como a P4 a vai usar. `pts` = os pontos "meus" e precisos desde S − G_WEAK
 * (os anteriores a S só servem para o meio do passo 5 e para a precisão).
 *  - "plano": candidato = ponto DENTRO da zona a ≤ V_WALK (carro parado OU
 *    condutor a pé); confirmado por (a) ≥ T_STOP_MIN parado/a pé dentro,
 *    (b) o ponto seguinte, até T_CONFIRM, a ≤ V_WALK — dentro OU fora da zona
 *    (o condutor sai a pé), ou (c) não há mais pontos antes de E e E − t ≤ 20 min.
 *    Dentro a mais de V_WALK e depois fora a andar = passou, não chegou.
 *  - "recurso": a proposta da sonda-62 — 1 ponto dentro a ≤ 10 km/h e o
 *    seguinte (dentro ou fora) a ≤ 10 km/h.
 * Chegada (passo 5): o anterior a andar → o meio dos dois (nunca antes de S);
 * o anterior parado/a pé → o próprio ponto. A precisão é o intervalo até ao
 * anterior (G_GOOD 6 / G_WEAK 15 min). PURA.
 */
export function planArrival(
  pts: readonly PosPoint[],
  o: { lat: number; lng: number; radiusM: number; startMs: number; endMs: number; mode: "plano" | "recurso" },
): { found: false } | { found: true; arrivalMs: number; via: ArrivalVia; precision: ArrivalPrecision } {
  const S = o.startMs / 1000, E = o.endMs / 1000;
  const inside = (p: PosPoint) => distTo(p, o.lat, o.lng) <= o.radiusM;
  const walk = (p: PosPoint) => p.speed <= WALK_KMH;
  for (let k = 0; k < pts.length; k++) {
    const pi = pts[k];
    if (pi.ts < S) continue;
    if (pi.ts > E) break;
    const next = pts[k + 1] && pts[k + 1].ts <= E + 120 ? pts[k + 1] : undefined;
    let via: ArrivalVia | null = null;
    if (o.mode === "recurso") {
      if (inside(pi) && pi.speed <= FALLBACK_NEXT_KMH && next && next.speed <= FALLBACK_NEXT_KMH) via = "recurso";
    } else if (inside(pi) && walk(pi)) {
      let j = k;
      while (j + 1 < pts.length && pts[j + 1].ts <= E + 120 && inside(pts[j + 1]) && walk(pts[j + 1])) j++;
      if (pts[j].ts - pi.ts >= PLAN_STOP_MIN_S) via = "parado";
      else if (next && next.ts - pi.ts <= PLAN_CONFIRM_S && walk(next)) via = "confirmado";
      else if ((!pts[k + 1] || pts[k + 1].ts > E) && E - pi.ts <= PLAN_TAIL_MAX_S) via = "ate_assinatura";
    }
    if (!via) continue;
    const prev = k > 0 ? pts[k - 1] : null;
    const arrival = prev && prev.speed > WALK_KMH ? Math.max(S, (prev.ts + pi.ts) / 2) : pi.ts;
    const g = prev ? pi.ts - prev.ts : null;
    const precision: ArrivalPrecision = g == null ? "sem ponto nos 15 min antes" : g <= PLAN_GAP_GOOD_S ? "boa (≤ 6 min)" : g <= PLAN_GAP_WEAK_S ? "fraca (6–15 min)" : "buraco (> 15 min)";
    return { found: true, arrivalMs: arrival * 1000, via, precision };
  }
  return { found: false };
}

/** A última chegada à zona antes de `untilMs`: o 1.º ponto da última série de pontos dentro. PURA. */
export function lastArrivalInZone(pts: readonly PosPoint[], zone: { lat: number; lng: number; radiusM: number }, fromMs: number, untilMs: number): number | null {
  const w = pts.filter((p) => p.ts * 1000 >= fromMs && p.ts * 1000 <= untilMs);
  let k = w.length - 1;
  if (k < 0 || distTo(w[k], zone.lat, zone.lng) > zone.radiusM) return null;
  while (k > 0 && distTo(w[k - 1], zone.lat, zone.lng) <= zone.radiusM) k--;
  return w[k].ts * 1000;
}

// ─── Zonas e posições ───────────────────────────────────────────────────────

/** Rótulo da zona → T1 / T2 / outro / sem rótulo (matchKey). PURA. */
export function zoneKind(label: string | null | undefined): ProbeZoneInfo["label"] {
  const k = matchKey(label);
  if (!k) return "sem_rotulo";
  if (/t2|terminal2/.test(k)) return "T2";
  if (/t1|terminal1/.test(k)) return "T1";
  return "outro";
}

const validZones = (a: AirportFence | null): TerminalZone[] => (a?.zones ?? []).filter((z) => Number.isFinite(z.lat) && Number.isFinite(z.lng) && z.radiusM > 0);

export type PositionLabel = "zona do terminal" | "aeroporto (fora das zonas)" | "no parque (≤ 500 m)" | "fora (nem parque nem aeroporto)" | "sem posição";

/** Onde foi marcada uma linha: zona do terminal → parque → aeroporto → fora. PURA. */
export function positionLabel(lat: number | null, lng: number | null, park: ProbePark | undefined, airport: AirportFence | null): PositionLabel {
  if (lat == null || lng == null) return "sem posição";
  const zones = validZones(airport);
  if (zones.some((z) => distanceMeters(lat, lng, z.lat, z.lng) <= z.radiusM)) return "zona do terminal";
  if (park?.lat != null && park.lng != null && distanceMeters(lat, lng, park.lat, park.lng) <= PARK_OK_M) return "no parque (≤ 500 m)";
  if (airport && distanceMeters(lat, lng, airport.lat, airport.lng) <= airport.radiusM) return "aeroporto (fora das zonas)";
  return "fora (nem parque nem aeroporto)";
}

/** "No terminal": dentro de uma zona (se houver zonas), senão dentro do círculo do aeroporto. PURA. */
export function inTerminal(lat: number | null, lng: number | null, airport: AirportFence | null): boolean {
  if (lat == null || lng == null || !airport) return false;
  const zones = validZones(airport);
  if (zones.length) return zones.some((z) => distanceMeters(lat, lng, z.lat, z.lng) <= z.radiusM);
  return distanceMeters(lat, lng, airport.lat, airport.lng) <= airport.radiusM;
}

const P2_RE = /(^|[^a-z0-9])p\s*-?\s*2($|[^0-9])/i;
/** Nome de garagem que é o "P2". PURA. */
export const isP2Name = (name: string | null | undefined): boolean => P2_RE.test(String(name ?? ""));

const okCoord = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6);
const COORD_PATTERNS: RegExp[] = [
  /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, // pino do Google Maps (o sítio, não o centro do mapa)
  /@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/, // centro do mapa
  /[?&](?:q|ll|query|center|destination|daddr|sll)=(?:loc:)?(-?\d{1,2}\.\d+),\s*\+?(-?\d{1,3}\.\d+)/,
  /"lat(?:itude)?"\s*:\s*"?(-?\d{1,2}\.\d+)"?\s*,\s*"(?:lng|lon|long|longitude)"\s*:\s*"?(-?\d{1,3}\.\d+)/,
  /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/, // "38.77, -9.13" solto
];

/** Coordenadas num texto (link do mapa, "lat,lng", JSON {lat,lng}); sem elas (ex.: link curto) → null. PURA. */
export function coordsFromText(raw: string | null | undefined): { lat: number; lng: number } | null {
  let t = String(raw ?? "");
  if (!t.trim()) return null;
  try { t = decodeURIComponent(t); } catch { /* fica como está */ }
  t = t.replace(/%2C/gi, ",");
  for (const re of COORD_PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    const lat = Number(m[1]), lng = Number(m[2]);
    if (okCoord(lat, lng)) return { lat, lng };
  }
  return null;
}

/** O link do mapa tem coordenadas? PURA. */
export function mapLinkHasCoords(link: string | null | undefined): boolean {
  return coordsFromText(link) != null;
}

/**
 * As coordenadas de uma garagem pela ordem: colunas lat/lng da Garage →
 * outra coluna de posição da Garage → link do mapa. Diz de onde vieram (ou
 * porque não há). PURA.
 */
export function garageCoords(g: { lat?: unknown; lng?: unknown; other?: Array<{ column: string; value: unknown }>; mapLink?: string | null }): { lat: number | null; lng: number | null; source: string } {
  const lat = g.lat == null || g.lat === "" ? NaN : Number(g.lat), lng = g.lng == null || g.lng === "" ? NaN : Number(g.lng);
  if (okCoord(lat, lng)) return { lat, lng, source: "colunas lat/lng da Garage" };
  for (const o of g.other ?? []) {
    const c = coordsFromText(o.value == null ? null : String(o.value));
    if (c) return { ...c, source: `coluna ${o.column} da Garage` };
  }
  const c = coordsFromText(g.mapLink);
  if (c) return { ...c, source: "link do mapa (mapLink)" };
  if (g.mapLink && String(g.mapLink).trim()) return { lat: null, lng: null, source: "link do mapa sem coordenadas (link curto?)" };
  return { lat: null, lng: null, source: "sem coordenadas" };
}

// ─── Chamadas ───────────────────────────────────────────────────────────────

/** Números (últimos 9) em ≥ 3 reservas com pedido no dia = partilhados. PURA. */
export function sharedPhones(phonesByBooking: ReadonlyMap<string, ReadonlySet<string>>, bookingIds: Iterable<string>): Set<string> {
  const count = new Map<string, Set<string>>();
  for (const b of bookingIds) for (const ph of phonesByBooking.get(b) ?? []) {
    const s = count.get(ph) ?? new Set<string>();
    s.add(b);
    count.set(ph, s);
  }
  return new Set([...count].filter(([, s]) => s.size >= SHARED_PHONE_MIN_BOOKINGS).map(([ph]) => ph));
}

export type CallReason = "na_janela" | "fora_da_janela" | "sem_chamada" | "partilhado" | "sem_telefone";
export interface CallMatch {
  reason: CallReason;
  /** a 1.ª chamada que bate em [R − 180, R + 60] */
  first: ProbeCall | null;
  /** a 1.ª dentro da janela [R − 60, R + 5] */
  inWindow: ProbeCall | null;
  /** há chamada em [R − 60, R] */
  before60: boolean;
  /** a 1.ª chamada depois de R − 60 vem mais de 15 min depois de R */
  requestBeforeCall: boolean;
}

/** Chamadas (ordenadas) que batem com uma reserva à volta de um instante. PURA. */
export function matchCalls(calls: readonly ProbeCall[], refMs: number, phones: ReadonlySet<string> | undefined, crm: ReadonlySet<number> | undefined, shared: ReadonlySet<string>): CallMatch {
  const all = phones ?? new Set<string>();
  const own = new Set([...all].filter((p) => !shared.has(p)));
  const crmSet = crm ?? new Set<number>();
  const lo = refMs - CALL_HIST_BEFORE_MIN * MIN, hi = refMs + CALL_HIST_AFTER_MIN * MIN;
  const hits = (useShared: boolean) => calls.filter((c) => c.atMs >= lo && c.atMs <= hi && (
    (c.last9 != null && (useShared ? all.has(c.last9) : own.has(c.last9))) || (c.crmClientId != null && crmSet.has(c.crmClientId))
  )).sort((a, b) => a.atMs - b.atMs);
  const cand = hits(false);
  const inWin = cand.find((c) => c.atMs >= refMs - CALL_WINDOW_BEFORE_MIN * MIN && c.atMs <= refMs + CALL_WINDOW_AFTER_MIN * MIN) ?? null;
  const before60 = cand.some((c) => c.atMs >= refMs - CALL_WINDOW_BEFORE_MIN * MIN && c.atMs <= refMs);
  const afterStart = cand.filter((c) => c.atMs >= refMs - CALL_WINDOW_BEFORE_MIN * MIN);
  const requestBeforeCall = afterStart.length > 0 && afterStart[0].atMs > refMs + CALL_LATE_AFTER_MIN * MIN;
  let reason: CallReason;
  if (!all.size && !crmSet.size) reason = "sem_telefone";
  else if (inWin) reason = "na_janela";
  else if (cand.length) reason = "fora_da_janela";
  else if (hits(true).length) reason = "partilhado";
  else reason = "sem_chamada";
  return { reason, first: cand[0] ?? null, inWindow: inWin, before60, requestBeforeCall };
}

// ─── Rótulos (vocabulário fechado) ──────────────────────────────────────────

export function platformLabel(p: string | null | undefined): string {
  const s = String(p ?? "").trim().toUpperCase();
  if (!s) return "sem plataforma";
  if (s === "MOBILE" || s === "WEB") return s;
  return "outra";
}

const AGENT_ROLES = ["ADMIN", "SUPERVISOR", "LEADER", "ACCOUNTANT", "DRIVER", "JUNIOR", "PARTNER"] as const;
const ROLE_RANK: Record<string, number> = { ADMIN: 7, SUPERVISOR: 6, LEADER: 5, ACCOUNTANT: 4, DRIVER: 3, JUNIOR: 2, PARTNER: 1 };
const roleOf = (r: string) => ((AGENT_ROLES as readonly string[]).includes(r.toUpperCase()) ? r.toUpperCase() : "outro");

/** Papel do agente no parque da reserva; sem linha nesse parque, o "mais alto" das outras (`otherPark`). PURA. */
export function agentRoleAt(rows: ReadonlyArray<{ parkId: string; role: string }> | undefined, parkId: string, uid: string | null): { role: string; otherPark: boolean } {
  if (isSystemAgentId(uid)) return { role: "sistema", otherPark: false };
  if (!rows?.length) return { role: "sem agente (cliente ou sistema)", otherPark: false };
  const here = rows.find((r) => r.parkId === parkId);
  if (here) return { role: roleOf(here.role), otherPark: false };
  const best = [...rows].sort((a, b) => (ROLE_RANK[roleOf(b.role)] ?? 0) - (ROLE_RANK[roleOf(a.role)] ?? 0))[0];
  return { role: roleOf(best.role), otherPark: true };
}

const MOVE_SEQ: Record<string, string> = { inicio: "mov. início", arrumar: "mov. fim (arrumar)", parques: "mov. entre garagens", lugar: "mudança de lugar", antigo: "mov. antigo" };
const seqLabel = (ev: ProbeEvent): string =>
  ev.type === "CHECKING_IN" ? "em recolha" : ev.type === "CHECK_IN" ? "check-in" : ev.type === "MOVEMENT" ? MOVE_SEQ[ev.moveKind ?? "antigo"] ?? "mov." : ev.type === "CANCEL" ? "cancelada" : "outro";
const STATUS_OF_TYPE: Record<string, string> = { PENDING_CHECKOUT: "PENDING_CHECKOUT", CHECKING_OUT: "CHECKING_OUT", CHECK_OUT: "CHECKED_OUT", CHECKING_IN: "CHECKING_IN", CHECK_IN: "CHECKED_IN" };
const KNOWN_STATUS = new Set(["BOOKED", "CHECKING_IN", "CHECKED_IN", "CHECKING_OUT", "CHECKED_OUT", "MOVING", "CANCELLED", "PENDING", "PENDING_CHECKOUT"]);
const statusLabel = (s: string | null | undefined) => { const u = String(s ?? "").toUpperCase(); return KNOWN_STATUS.has(u) ? u : "desconhecido"; };

const FIM_KINDS = new Set<string>(["arrumar", "parques", "lugar"]);

// ─── As contas de uma cidade num dia ────────────────────────────────────────

/**
 * Tudo o que a P0 mede (§11.0, itens 1–15) para UMA cidade num dia
 * operacional, só com agregados. PURA.
 */
export function computeProbeCity(inp: ProbeCityInput): SondaResult {
  const res = emptySondaResult(inp.city, [inp.day]);
  const acc = new SondaAcc(res);
  res.truncated = !!inp.truncated;
  res.failures = [...(inp.failures ?? [])];
  // Este dia foi lido (o relatório compara com os dias pedidos: "falhou" ≠ "zero")
  acc.label("corrida.dias_lidos", inp.day);
  if (inp.global) acc.inc("corrida.global");
  const down = inp.unavailable ?? {};
  for (const [k, v] of Object.entries(down)) if (v) acc.inc(`falhas.${k}`);
  const callsDown = !!down.chamadas, gpsDown = !!down.gps, agentsDown = !!down.agentes, garagesDown = !!down.garagens;
  const inDay = (ms: number | null | undefined) => ms != null && ms >= inp.opStartMs && ms < inp.opEndMs;
  const zones = validZones(inp.airport);
  const zoneInfo: ProbeZoneInfo[] = zones.map((z) => ({ label: zoneKind(z.label), radiusM: z.radiusM }));

  // Garagens: nome a mostrar (o da tabela) e as desta cidade
  const garageByKey = new Map<string, string>();
  for (const g of inp.garages) { const k = matchKey(g.name); if (k && !garageByKey.has(k)) garageByKey.set(k, g.name.trim().slice(0, 40)); }
  const garageName = (raw: string | null) => (raw ? garageByKey.get(matchKey(raw)) ?? null : null);
  const cityParkIds = new Set([...inp.parks.values()].filter((p) => p.city === inp.city).map((p) => p.id));
  // Item 16 (Q6): cada garagem dos parques da cidade, com as coordenadas da Multipark
  const cityGarages: Array<ProbeGarageInfo & { parkId: string }> = [];
  for (const g of inp.garages) {
    if (!cityParkIds.has(g.parkId)) continue;
    const name = g.name.trim().slice(0, 40);
    const park = inp.parks.get(g.parkId);
    const lat = g.lat ?? null, lng = g.lng ?? null;
    const valid = lat != null && lng != null && (park?.lat == null || park.lng == null || distanceMeters(lat, lng, park.lat, park.lng) <= GARAGE_MAX_FROM_PARK_M);
    const r5 = (x: number | null) => (x == null ? null : Math.round(x * 1e5) / 1e5);
    cityGarages.push({ name, park: park?.name ? String(park.name).slice(0, 60) : null, parkingType: g.parkingType, coordSource: g.coordSource ?? (g.mapHasCoords ? "link do mapa (mapLink)" : "sem coordenadas"), lat: r5(lat), lng: r5(lng), valid, mapHasCoords: g.mapHasCoords, parkId: g.parkId });
    if (isP2Name(name)) acc.inc("p2.na_tabela");
  }
  cityGarages.sort((a, b) => a.name.localeCompare(b.name, "pt") || String(a.park).localeCompare(String(b.park), "pt"));
  /** A garagem (com coordenadas válidas) de um destino: a do parque da reserva, senão a da cidade com esse nome. */
  const garageCoordFor = (name: string, parkId: string | undefined) => {
    const k = matchKey(name);
    const same = cityGarages.filter((g) => g.valid && matchKey(g.name) === k);
    return same.find((g) => g.parkId === parkId) ?? same[0] ?? null;
  };
  res.s = {
    ...inp.staticBase,
    airportRadiusM: inp.airport?.radiusM ?? null,
    zones: zoneInfo,
    garages: cityGarages.map(({ parkId: _p, ...g }) => g),
    coordColumns: [...(inp.coordColumns ?? [])],
  };

  // Linhas por reserva → ciclos
  const byBooking = new Map<string, ProbeEvent[]>();
  for (const ev of inp.events) {
    if (!inp.bookings.has(ev.bookingId)) continue;
    const list = byBooking.get(ev.bookingId) ?? [];
    list.push(ev);
    byBooking.set(ev.bookingId, list);
    if (inDay(ev.atMs)) {
      acc.inc("eventos.do_dia");
      if (!ev.hasSnapshot) acc.inc("eventos.sem_snapshot");
    }
  }
  const deliveries: DeliveryCycle[] = [];
  const pickups: PickupCycle[] = [];
  for (const evs of byBooking.values()) {
    const c = buildBookingCycles(evs);
    for (const d of c.deliveries) if (inDay(deliveryRefMs(d))) deliveries.push(d);
    for (const p of c.pickups) if (inDay(pickupRefMs(p))) pickups.push(p);
    for (const n of c.notes) if (inDay(n.atMs)) acc.inc(`ciclos.${n.kind}`);
  }
  const parkOf = (bookingId: string) => inp.parks.get(inp.bookings.get(bookingId)?.parkId ?? "");
  const classOf = (bookingId: string): TerminalClass => inp.bookings.get(bookingId)?.terminalClass ?? "unknown";

  // Quem marca (item 7)
  const who = (type: string, ev: ProbeEvent | null) => {
    if (!ev) return;
    acc.label(`quem.${type}.plataforma`, platformLabel(ev.platform));
    if (agentsDown) return; // sem os papéis, "sem agente" seria mentira
    const r = agentRoleAt(inp.agents.get(ev.uid ?? ""), inp.bookings.get(ev.bookingId)?.parkId ?? "", ev.uid);
    acc.label(`quem.${type}.papel`, r.role);
    if (r.otherPark) acc.inc(`quem.${type}.outro_parque`);
  };

  // GPS de um agente numa janela (item 2)
  const employeeOf = (ev: ProbeEvent | null): { reason: string; employeeId: number | null } => {
    if (!ev) return { reason: "sem_inicio", employeeId: null };
    if (isSystemAgentId(ev.uid)) return { reason: "agente_sistema", employeeId: null };
    const r = inp.resolveAgent(ev.uid, ev.agentName);
    if (r.kind === "ficha") return { reason: "ficha", employeeId: r.employeeId };
    if (r.kind === "parceiro") return { reason: "parceiro", employeeId: null };
    if (r.kind === "sem_ficha") return { reason: "sem_ficha", employeeId: null };
    return { reason: "agente_sistema", employeeId: null };
  };
  const coverage = (candidates: Array<ProbeEvent | null>, aMs: number, bMs: number): { reason: string; employeeId: number | null; pts: PosPoint[] } => {
    let first: { reason: string; employeeId: number | null } | null = null;
    for (const ev of candidates) {
      const e = employeeOf(ev);
      if (e.employeeId == null) { first ??= e; continue; }
      const emp = inp.gps.get(e.employeeId);
      const status = emp?.status ?? "sem_linha";
      if (status !== "ok") { first ??= { reason: status, employeeId: e.employeeId }; continue; }
      const pts = myPoints(emp, aMs, bMs);
      if (pts.length >= 2) return { reason: "com_gps", employeeId: e.employeeId, pts };
      first ??= { reason: "sem_pontos", employeeId: e.employeeId };
    }
    return { ...(first ?? { reason: "sem_inicio", employeeId: null }), pts: [] };
  };
  const involved = new Set<number>();
  const addGaps = (ctx: string, pts: PosPoint[], aMs: number, bMs: number) => {
    for (const g of windowGaps(pts, aMs, bMs)) acc.hist(`gps.intervalo.${ctx}.${g.moving ? "andar" : "parado"}`, "gapS", g.gapS);
  };

  // Telefones partilhados (reservas com pedido no dia)
  const withRequest = new Set<string>();
  for (const d of deliveries) if (d.R) withRequest.add(d.bookingId);
  for (const p of pickups) if (p.K) withRequest.add(p.bookingId);
  const shared = sharedPhones(inp.phones, withRequest);
  const callsSorted = [...inp.calls].sort((a, b) => a.atMs - b.atMs);
  const callStats = (kind: "entregas" | "recolhas", refMs: number, bookingId: string): CallMatch => {
    const m = matchCalls(callsSorted, refMs, inp.phones.get(bookingId), inp.crmIds.get(bookingId), shared);
    acc.inc(`chamadas.${kind}.com_pedido`);
    acc.inc(`chamadas.${kind}.${m.reason}`);
    if (m.before60) acc.inc(`chamadas.${kind}.antes_60`);
    if (m.first) acc.hist(`chamadas.${kind}.c_menos_r`, "callMin", (m.first.atMs - refMs) / MIN);
    if (m.inWindow) acc.label(`chamadas.${kind}.fonte`, `${m.inWindow.source === "central" ? "central" : "WhatsApp"} ${m.inWindow.held ? "atendida" : "perdida"}`);
    if (kind === "entregas" && m.requestBeforeCall) acc.inc("chamadas.entregas.pedido_antes_da_chamada");
    return m;
  };

  // ── Entregas ──
  const startsByAgent = new Map<string, number[]>();
  for (const d of deliveries) {
    const park = parkOf(d.bookingId);
    if (d.outcome === "cancelado") { acc.inc("entregas.canceladas"); continue; }
    if (d.outcome === "aberto") { acc.inc("entregas.abertas"); continue; }
    const { R, S, E } = d;
    if (!E) continue;
    acc.inc("entregas.entregues");
    if (!R) acc.inc("entregas.sem_pedido");
    if (!S) acc.inc("entregas.sem_inicio");
    if (R && S && S.atMs < R.atMs) acc.inc("entregas.inicio_antes_do_pedido");
    if (d.pend.length > 1) acc.inc("entregas.pedido_repetido");
    if (R && S && S.atMs >= R.atMs) acc.hist("entregas.r_s", "min", (S.atMs - R.atMs) / MIN);
    if (S && E.atMs >= S.atMs) acc.hist("entregas.s_e", "min", (E.atMs - S.atMs) / MIN);
    who("PENDING_CHECKOUT", R);
    who("CHECKING_OUT", S);
    if (S) {
      if (S.uid) startsByAgent.set(S.uid, [...(startsByAgent.get(S.uid) ?? []), S.atMs]);
      acc.label("posicao.CHECKING_OUT", positionLabel(S.lat, S.lng, park, inp.airport));
      if (S.lat != null && S.lng != null && park?.lat != null && park.lng != null) {
        acc.inc("entregas.s_com_posicao");
        if (distanceMeters(S.lat, S.lng, park.lat, park.lng) > PARK_FAR_M) acc.inc("entregas.s_longe_do_parque");
      }
    }

    // Item 6: "Cheguei" e malas deste ciclo (pelo retrato)
    const start = deliveryRefMs(d) ?? E.atMs;
    const within = (ms: number | null) => ms != null && ms >= start - MIN && ms <= E.atMs + MIN;
    const pick = (f: (ev: ProbeEvent) => number | null) => {
      let best: number | null = null;
      for (const ev of d.events) { const v = f(ev); if (within(v) && (best == null || v! > best)) best = v; }
      return best;
    };
    const when = (ms: number) => !R ? "sem pendente" : ms < R.atMs ? "antes do pendente" : !S || ms < S.atMs ? "entre o pendente e o início" : ms <= E.atMs ? "entre o início e a assinatura" : "depois da assinatura";
    const arrived = pick((ev) => ev.snapArrivedMs);
    if (arrived != null) {
      acc.inc("cheguei.deste_ciclo");
      acc.label("cheguei.quando", when(arrived));
      const before = [...d.events].filter((ev) => ev.atMs <= arrived).pop();
      acc.label("cheguei.estado", statusLabel(before?.snapStatus ?? (before ? STATUS_OF_TYPE[before.type] : null)));
    }
    const bag = pick((ev) => ev.snapBaggageMs);
    if (bag != null) { acc.inc("malas.deste_ciclo"); acc.label("malas.quando", when(bag)); }

    // Item 4: distância da assinatura às zonas
    const cls = classOf(d.bookingId);
    if (E.lat != null && E.lng != null) {
      if (inp.airport) acc.hist(`distancia.checkout.${cls}.aeroporto`, "distM", distanceMeters(E.lat, E.lng, inp.airport.lat, inp.airport.lng));
      if (zones.length) {
        let best: { d: number; z: TerminalZone } | null = null;
        for (const z of zones) { const dz = distanceMeters(E.lat, E.lng, z.lat, z.lng); if (!best || dz < best.d) best = { d: dz, z }; }
        if (best) {
          acc.hist(`distancia.checkout.${cls}.zona`, "distM", best.d);
          acc.label(`distancia.checkout.${cls}.zona_mais_perto`, zoneKind(best.z.label));
        }
      }
    }

    // Item 5: chamadas (sem a leitura das chamadas/telefones não conta: não é "sem chamada")
    if (!callsDown) {
      if (R) callStats("entregas", R.atMs, d.bookingId);
      else if (S) {
        const m = matchCalls(callsSorted, S.atMs, inp.phones.get(d.bookingId), inp.crmIds.get(d.bookingId), shared);
        acc.inc("chamadas.entregas_sem_pendente");
        if (m.before60) acc.inc("chamadas.entregas_sem_pendente.com_chamada");
      }
    }

    // Item 2: cobertura (o condutor = agente do CHECKING_OUT); sem fichas/GPS não conta
    if (gpsDown) continue;
    if (!S) { acc.inc("gps.cobertura.entregas.sem_inicio"); continue; }
    const cov = coverage([S], S.atMs, E.atMs);
    acc.inc(`gps.cobertura.entregas.${cov.reason}`);
    if (cov.employeeId != null) involved.add(cov.employeeId);
    if (cov.reason !== "com_gps" || cov.employeeId == null) continue;
    const emp = inp.gps.get(cov.employeeId);
    acc.label("gps.aparelho.entregas", windowUsesPda(emp, S.atMs, E.atMs) ? "PDA com check-in" : "Zello da linha");
    // Item 1: intervalos dentro de [S, E] (com os pontos de fora que tocam a janela)
    addGaps("entregas", myPoints(emp, S.atMs - 30 * MIN, E.atMs + 30 * MIN), S.atMs, E.atMs);
    // Item 8: GPS em S → parque
    if (park?.lat != null && park.lng != null) {
      const before = myPoints(emp, S.atMs - 6 * MIN, S.atMs).pop() ?? myPoints(emp, S.atMs, S.atMs + 3 * MIN)[0];
      if (before) acc.hist("entregas.gps_s_parque", "distM", distTo(before, park.lat, park.lng));
    }
    // Item 3: paragem à volta da assinatura; item 14: relógio
    if (E.lat == null || E.lng == null) { acc.inc("paragem.sem_posicao_e"); continue; }
    acc.inc("paragem.base");
    const win = myPoints(emp, S.atMs, E.atMs + 2 * MIN);
    for (const v of STOP_SPEEDS_KMH) for (const t of STOP_MIN_SECONDS) for (const rad of STOP_RADII_M) {
      const key = stopComboKey(v, t, rad);
      const st = terminalStop(win, { lat: E.lat, lng: E.lng, radiusM: rad, vMaxKmh: v, minStopS: t, startMs: S.atMs, endMs: E.atMs });
      if (!st.found) continue;
      acc.inc(`paragem.${key}.com`);
      acc.hist(`paragem.${key}.antes`, "stopMin", Math.max(0, E.atMs - st.startMs) / MIN);
      if (st.lastsUntilEnd) acc.inc(`paragem.${key}.ate_e`);
    }
    // A regra do plano (carro parado OU condutor a pé, §4.4) e o recurso da sonda-62, por raio
    // (desde S − G_WEAK: o ponto anterior dá o meio do passo 5 e a precisão)
    const winPlan = myPoints(emp, S.atMs - PLAN_GAP_WEAK_S * 1000, E.atMs + 2 * MIN);
    for (const rad of STOP_RADII_M) {
      for (const mode of ["plano", "recurso"] as const) {
        const a = planArrival(winPlan, { lat: E.lat, lng: E.lng, radiusM: rad, startMs: S.atMs, endMs: E.atMs, mode });
        if (!a.found) continue;
        const key = `paragem.${mode}_r${rad}`;
        acc.inc(`${key}.com`);
        acc.hist(`${key}.antes`, "stopMin", Math.max(0, E.atMs - a.arrivalMs) / MIN);
        if (mode === "plano") { acc.label(`${key}.via`, a.via); acc.label(`${key}.precisao`, a.precision); }
      }
    }
    let near: { d: number; ts: number } | null = null;
    for (const p of myPoints(emp, E.atMs - 30 * MIN, E.atMs + 30 * MIN)) {
      const dd = distTo(p, E.lat, E.lng);
      if (dd <= 300 && (!near || dd < near.d)) near = { d: dd, ts: p.ts };
    }
    if (near) acc.hist("relogio.checkout_gps", "clockMin", (near.ts * 1000 - E.atMs) / MIN);
  }
  // Item 8: entre inícios seguidos do mesmo agente
  for (const list of startsByAgent.values()) {
    const s = [...list].sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++) acc.hist("entregas.entre_inicios", "min", (s[i] - s[i - 1]) / MIN);
  }

  // ── Recolhas ──
  const t2Zones = zones.filter((z) => zoneKind(z.label) === "T2");
  for (const p of pickups) {
    const park = parkOf(p.bookingId);
    if (p.outcome === "cancelado") { acc.inc("recolhas.canceladas"); continue; }
    if (p.outcome === "aberto") { acc.inc("recolhas.abertas"); continue; }
    const { K, I } = p;
    if (!I) continue;
    acc.inc("recolhas.recebidas");
    who("CHECKING_IN", K);
    who("CHECK_IN", I);
    acc.label("recolhas.sequencia", p.events.slice(0, 6).map(seqLabel).join(" → "));
    acc.label("posicao.CHECK_IN", positionLabel(I.lat, I.lng, park, inp.airport));
    if (K) {
      acc.inc("recolhas.com_em_recolha");
      acc.label("posicao.CHECKING_IN", positionLabel(K.lat, K.lng, park, inp.airport));
      if (I.atMs >= K.atMs) acc.hist("recolhas.k_i", "min", (I.atMs - K.atMs) / MIN);
      if (I.atMs - K.atMs < QUICK_PICKUP_MIN * MIN) {
        acc.inc("recolhas.k_i_rapido");
        if (K.uid && K.uid === I.uid) acc.inc("recolhas.k_i_rapido.mesmo_agente");
        if (inTerminal(K.lat, K.lng, inp.airport)) acc.inc("recolhas.k_i_rapido.k_no_terminal");
      }
    }
    if (I.lat != null && I.lng != null && zones.length) {
      acc.hist("distancia.checkin.zona", "distM", Math.min(...zones.map((z) => distanceMeters(I.lat!, I.lng!, z.lat, z.lng))));
    }
    const moveStart = p.moves.find((m) => m.moveKind === "inicio") ?? null;
    const moveEnd = p.moves.find((m) => FIM_KINDS.has(m.moveKind ?? "") || (m.moveKind === "antigo")) ?? null;
    if (!p.moves.length) acc.inc("recolhas.sem_movimento");
    if (moveStart) acc.hist("recolhas.i_inicio_mov", "min", (moveStart.atMs - I.atMs) / MIN);
    if (moveEnd) acc.hist("recolhas.i_fim_mov", "min", (moveEnd.atMs - I.atMs) / MIN);
    const firstGarage = p.moves.find((m) => FIM_KINDS.has(m.moveKind ?? "") && m.garageTo);
    if (firstGarage && !garagesDown) acc.label("garagens.primeira", garageName(firstGarage.garageTo) ?? "outra (fora da tabela)");

    // Chamadas (K) e K0 (sem a leitura das chamadas não conta, e o K0 fica por saber)
    const m = K && !callsDown ? callStats("recolhas", K.atMs, p.bookingId) : null;
    const k0 = K && !callsDown ? Math.min(K.atMs, m?.inWindow?.atMs ?? Infinity) : null;

    // Item 11: recurso da app (início do movimento na zona do check-in)
    if (moveStart && I.lat != null && I.lng != null && moveStart.lat != null && moveStart.lng != null
      && distanceMeters(moveStart.lat, moveStart.lng, I.lat, I.lng) <= PROBE_TERMINAL_RADIUS_M) acc.inc("saida.recurso_app");

    // Item 2: cobertura (quem tira o carro: o do 1.º movimento, senão o do check-in); sem fichas/GPS não conta
    const firstMove = p.moves.find((mv) => mv.atMs - I.atMs <= PICKUP_GPS_WINDOW_MIN * MIN) ?? null;
    const until = I.atMs + PICKUP_GPS_WINDOW_MIN * MIN;
    const cov = gpsDown ? null : coverage(firstMove && firstMove.uid !== I.uid ? [firstMove, I] : [I], I.atMs, until);
    if (cov) acc.inc(`gps.cobertura.recolhas.${cov.reason}`);
    if (cov?.employeeId != null) involved.add(cov.employeeId);
    if (cov && cov.reason === "com_gps" && cov.employeeId != null) {
      const emp = inp.gps.get(cov.employeeId);
      acc.label("gps.aparelho.recolhas", windowUsesPda(emp, I.atMs, until) ? "PDA com check-in" : "Zello da linha");
      addGaps("recolhas", myPoints(emp, I.atMs - 30 * MIN, until + 30 * MIN), I.atMs, until);
      if (I.lat != null && I.lng != null) {
        acc.inc("saida.base");
        const win = myPoints(emp, I.atMs, until);
        for (const v of EXIT_CAR_SPEEDS_KMH) for (const mg of EXIT_MARGINS_M) {
          const x = terminalExit(win, { lat: I.lat, lng: I.lng, radiusM: PROBE_TERMINAL_RADIUS_M, marginM: mg, vCarKmh: v, fromMs: I.atMs, toMs: until });
          if (x == null) continue;
          const key = exitComboKey(v, mg);
          acc.inc(`saida.${key}.com`);
          acc.hist(`saida.${key}.i_x`, "min", (x - I.atMs) / MIN);
        }
      }
    }

    // Item 12: T2 — chegada do agente do check-in à zona T2
    if (classOf(p.bookingId) === "t2") {
      acc.inc("t2.recolhas");
      if (!t2Zones.length) acc.inc("t2.sem_zona_t2");
      else if (callsDown || gpsDown) acc.inc("t2.leitura_falhou");
      else if (k0 == null) acc.inc("t2.sem_k0");
      else {
        const e = employeeOf(I);
        const emp = e.employeeId != null ? inp.gps.get(e.employeeId) : undefined;
        const pts = myPoints(emp, k0 - 30 * MIN, I.atMs);
        if (emp?.status === "por_ler") acc.inc("t2.por_ler");
        else if (pts.length < 1) acc.inc("t2.sem_gps");
        else {
          let arrived: number | null = null;
          for (const z of t2Zones) {
            const a = lastArrivalInZone(pts, z, k0 - 30 * MIN, I.atMs);
            if (a != null && (arrived == null || a > arrived)) arrived = a;
          }
          if (arrived == null) acc.inc("t2.sem_chegada");
          else {
            acc.inc("t2.com_chegada");
            acc.hist("t2.chegada_menos_k0", "min", (arrived - k0) / MIN);
            if (arrived <= k0) acc.inc("t2.ja_la");
            if (arrived - k0 > T2_LATE_AFTER_MIN * MIN) acc.inc("t2.atrasadas");
          }
        }
      }
    }
  }

  // ── Item 10: movimentos do dia (todas as reservas da cidade); sem a tabela Garage não conta ──
  const nextMoveOf = new Map<string, ProbeEvent[]>();
  if (!garagesDown) for (const [b, evs] of byBooking) nextMoveOf.set(b, sortEvents(evs.filter((e) => e.type === "MOVEMENT")));
  for (const moves of nextMoveOf.values()) {
    for (let i = 0; i < moves.length; i++) {
      const mv = moves[i];
      if (!inDay(mv.atMs) || !FIM_KINDS.has(mv.moveKind ?? "") || !mv.garageTo) continue;
      const to = garageName(mv.garageTo);
      if (!to) { acc.inc("garagens.fora_da_tabela"); acc.label("garagens.destino", "outra (fora da tabela)"); continue; }
      acc.label("garagens.destino", to);
      acc.label("garagens.de_para", `${garageName(mv.garageFrom) ?? (mv.garageFrom ? "outra" : "—")} → ${to}`);
      // Item 16 (Q6): a posição da app no fim do movimento bate com as coordenadas da garagem?
      const gc = garageCoordFor(to, inp.bookings.get(mv.bookingId)?.parkId);
      if (mv.lat == null || mv.lng == null) acc.inc("garagens.coord.mov_sem_posicao");
      else if (!gc || gc.lat == null || gc.lng == null) acc.inc("garagens.coord.garagem_sem_coordenadas");
      else acc.hist(`garagens.posicao_vs_coord.${to}`, "distM", distanceMeters(mv.lat, mv.lng, gc.lat, gc.lng));
      const next = moves.slice(i + 1).find((x) => x.atMs > mv.atMs && x.atMs - mv.atMs <= PICKUP_TRACK_MAX_HOURS * 3_600_000);
      if (next) acc.hist(`garagens.ate_seguinte.${to}`, "hours", (next.atMs - mv.atMs) / 3_600_000);
      if (isP2Name(to)) {
        acc.inc("p2.nos_movimentos");
        if (mv.lat != null && mv.lng != null) {
          for (const kind of ["T1", "T2"] as const) {
            const zs = zones.filter((z) => zoneKind(z.label) === kind);
            if (zs.length) acc.hist(`p2.distancia.${kind}`, "distM", Math.min(...zs.map((z) => distanceMeters(mv.lat!, mv.lng!, z.lat, z.lng))));
          }
          if (inp.airport) acc.hist("p2.distancia.aeroporto", "distM", distanceMeters(mv.lat, mv.lng, inp.airport.lat, inp.airport.lng));
        }
      }
    }
  }

  // ── Itens 1 e 13: os ficheiros das pessoas desta cidade ──
  const filesSeen = new Set<number>();
  for (const e of involved) {
    const emp = inp.gps.get(e);
    if (!emp || emp.status !== "ok") continue;
    const dayPts = myPoints(emp, inp.opStartMs, inp.opEndMs - 1);
    addGaps("dia", dayPts, inp.opStartMs, inp.opEndMs);
    for (const f of emp.files) {
      // só os ficheiros do dia de Lisboa D (o de D+1 conta no dia seguinte: juntar dias não repete ficheiros)
      if (filesSeen.has(f.id) || f.day !== inp.day) continue;
      filesSeen.add(f.id);
      acc.inc("ficheiros.lidos");
      if (!f.points.length) continue;
      const first = f.points[0].ts * 1000, last = f.points[f.points.length - 1].ts * 1000;
      const mid = lisbonMidnightUtcMs(f.day), next = lisbonMidnightUtcMs(addDays(f.day, 1));
      acc.hist("ficheiros.primeiro_ponto", "midnightH", (first - mid) / 3_600_000);
      acc.hist("ficheiros.ultimo_ponto", "midnightH", (last - next) / 3_600_000);
    }
  }

  // ── O que é de toda a corrida (só na 1.ª cidade) ──
  if (inp.global) {
    for (const r of inp.global.gpsRows) acc.label("ficheiros.passagem", `${r.pass === "sameday" ? "provisória (sameday)" : r.pass === "final" ? "final" : "outra"}${r.hasFile ? "" : " sem ficheiro"}`);
    if (inp.global.filesPending) acc.inc("ficheiros.por_ler", inp.global.filesPending);
    for (const c of inp.global.calls) {
      if (!inDay(c.atMs)) continue; // só as do dia (a leitura traz mais 48 h para emparelhar)
      if (c.source === "whatsapp") { acc.inc("chamadas.whatsapp.recebidas"); continue; }
      acc.inc("chamadas.central.recebidas");
      if (c.last9 == null && c.crmClientId == null) acc.inc("chamadas.central.sem_numero");
      if (c.createdAtMs != null) acc.hist("chamadas.central.atraso_registo", "regS", (c.createdAtMs - c.atMs) / 1000);
    }
  }
  return res;
}
