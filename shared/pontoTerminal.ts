/**
 * TERMINAL NO PONTO (aeroporto) — regras puras, partilhadas pelo ponto, pelo
 * ordenado (server/payroll/compute.ts) e pelo custo dos extras
 * (server/finance/extrasCost.ts). Pauta do Rafael, Jorge 7 out 2026.
 *
 * Como funciona no terreno:
 *  - o extra já tem o ponto aberto; ao chegar ao aeroporto dá SAÍDA + ENTRADA:
 *    a entrada com GPS dentro do aeroporto da cidade dele abre um troço de
 *    TERMINAL;
 *  - antes de sair do aeroporto dá SAÍDA + ENTRADA outra vez: a saída fecha o
 *    troço de terminal (no aeroporto → terminal confirmado pelo GPS) e a
 *    entrada logo a seguir é o REGRESSO (volta a extra normal), mesmo sendo
 *    dada no aeroporto;
 *  - o troço de terminal paga à taxa do nível SEGUINTE ao do extra (júnior →
 *    sénior, sénior → terminal, terminal → master; master fica master).
 *
 * Estados guardados em `time_records.terminalStatus`:
 *  - na ENTRADA: "start" = esta entrada abriu um troço de terminal;
 *  - na SAÍDA (o troço todo): "auto" (entrada e saída no aeroporto — paga
 *    terminal), "pending" (entrada no aeroporto, saída fora ou sem GPS — NÃO
 *    paga terminal até o RH confirmar), "confirmed" (o RH marcou — paga) e
 *    "rejected" (o RH desmarcou — não paga). Nada se apaga.
 */

export type AirportCityId = "lisbon" | "porto" | "faro";

export interface AirportFence {
  lat: number;
  lng: number;
  /** raio em metros */
  radiusM: number;
}

export type AirportsMap = Record<AirportCityId, AirportFence>;

export const AIRPORT_CODES: Record<AirportCityId, string> = { lisbon: "LIS", porto: "OPO", faro: "FAO" };
export const AIRPORT_LABELS: Record<AirportCityId, string> = {
  lisbon: "Lisboa (LIS)",
  porto: "Porto (OPO)",
  faro: "Faro (FAO)",
};

/** Valores por omissão (Definições → Parâmetros → Extras-dia → "Aeroportos (terminal no ponto)"). */
export const DEFAULT_TERMINAL_RADIUS_M = 1500;
export const DEFAULT_TERMINAL_AIRPORTS: AirportsMap = {
  lisbon: { lat: 38.7742, lng: -9.1342, radiusM: DEFAULT_TERMINAL_RADIUS_M },
  porto: { lat: 41.2481, lng: -8.6814, radiusM: DEFAULT_TERMINAL_RADIUS_M },
  faro: { lat: 37.0144, lng: -7.9659, radiusM: DEFAULT_TERMINAL_RADIUS_M },
};

/** Entrada até X minutos depois de fechar um troço de terminal = regresso (volta a extra normal). */
export const TERMINAL_RETURN_WINDOW_MIN = 30;

/** Nível mais alto dos extras (master). */
export const TERMINAL_MAX_LEVEL = 4;

export type TerminalCheckInStatus = "start";
export type TerminalShiftStatus = "auto" | "pending" | "confirmed" | "rejected";
export type TerminalStatus = TerminalCheckInStatus | TerminalShiftStatus;

export const TERMINAL_STATUS_LABELS: Record<TerminalStatus, string> = {
  start: "Terminal",
  auto: "Terminal",
  pending: "Terminal por confirmar",
  confirmed: "Terminal (confirmado)",
  rejected: "Terminal desmarcado",
};

/** Cidade das fichas (shared/city.ts: lisboa/porto/faro) → chave do aeroporto. */
export function airportCityOf(city: string | null | undefined): AirportCityId | null {
  const c = String(city ?? "").trim().toLowerCase();
  if (c === "lisboa" || c === "lisbon") return "lisbon";
  if (c === "porto") return "porto";
  if (c === "faro") return "faro";
  return null;
}

/** Distância em metros entre dois pontos (fórmula de haversine). */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function coord(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * O GPS está dentro do aeroporto? `true` dentro do raio, `false` fora,
 * `null` sem GPS (ou coordenadas inválidas, ou cidade sem aeroporto).
 */
export function isAtAirport(latitude: unknown, longitude: unknown, airport: AirportFence | null | undefined): boolean | null {
  const lat = coord(latitude), lng = coord(longitude);
  if (lat == null || lng == null || !airport) return null;
  if (lat === 0 && lng === 0) return null; // "0,0" = GPS que não respondeu
  return distanceMeters(lat, lng, airport.lat, airport.lng) <= airport.radiusM;
}

export interface PrevRecordLike {
  type: "check_in" | "check_out";
  /** "YYYY-MM-DD HH:MM:SS" (UTC, como está na BD) ou ISO */
  recordedAt: string;
  terminalStatus?: string | null;
}

function parseUtc(s: string): number {
  return new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").getTime();
}

/** O troço fechado nesta saída era de terminal (pago ou por confirmar)? */
export function closedTerminalSegment(status: string | null | undefined): boolean {
  return status === "auto" || status === "pending" || status === "confirmed";
}

export type CheckInTerminal =
  | { status: "start"; reason: "start" }
  | { status: null; reason: "return" | "outside" | "no_gps" };

/**
 * ENTRADA: abre um troço de terminal quando o GPS está no aeroporto da cidade
 * do extra — exceto quando é o REGRESSO (saída + entrada antes de sair do
 * aeroporto): a saída anterior fechou um troço de terminal há menos de
 * TERMINAL_RETURN_WINDOW_MIN minutos.
 */
export function classifyCheckIn(o: { atAirport: boolean | null; prev: PrevRecordLike | null; at: Date }): CheckInTerminal {
  if (o.atAirport == null) return { status: null, reason: "no_gps" };
  if (!o.atAirport) return { status: null, reason: "outside" };
  const prev = o.prev;
  if (prev && prev.type === "check_out" && closedTerminalSegment(prev.terminalStatus)) {
    const gapMin = (o.at.getTime() - parseUtc(prev.recordedAt)) / 60000;
    if (gapMin >= 0 && gapMin <= TERMINAL_RETURN_WINDOW_MIN) return { status: null, reason: "return" };
  }
  return { status: "start", reason: "start" };
}

/**
 * SAÍDA: o troço é terminal só se a entrada o abriu ("start"). Saída no
 * aeroporto → "auto" (paga terminal); saída fora ou sem GPS → "pending"
 * (não paga terminal até o RH confirmar). Entrada normal → null.
 */
export function classifyCheckOut(o: { checkInStatus: string | null | undefined; atAirport: boolean | null }): "auto" | "pending" | null {
  if (o.checkInStatus !== "start") return null;
  return o.atAirport === true ? "auto" : "pending";
}

/** O troço paga como terminal? Só "auto" (GPS) e "confirmed" (RH). */
export function isPaidTerminal(status: string | null | undefined): boolean {
  return status === "auto" || status === "confirmed";
}

/** O troço está à espera do RH (entrada no aeroporto, saída fora ou sem GPS)? */
export function isPendingTerminal(status: string | null | undefined): boolean {
  return status === "pending";
}

/** Nível da ficha normalizado (1–4; desconhecido → 1, júnior). */
export function normalizeExtraLevel(level: number | string | null | undefined): number {
  const n = Math.trunc(Number(level));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(TERMINAL_MAX_LEVEL, n);
}

/** Nível seguinte (júnior→sénior, sénior→terminal, terminal→master; master fica master). */
export function terminalLevelOf(level: number | string | null | undefined): number {
  return Math.min(TERMINAL_MAX_LEVEL, normalizeExtraLevel(level) + 1);
}

/**
 * REGRA ÚNICA do terminal no dinheiro: a que nível se paga um troço de ponto
 * de um extra. Interruptor desligado ou troço que não paga terminal → o nível
 * dele (igual a antes); troço terminal → o nível seguinte.
 */
export function payLevelForShift(level: number | string | null | undefined, o: { terminalStatus: string | null | undefined; enabled: boolean }): number {
  const own = normalizeExtraLevel(level);
  if (!o.enabled || !isPaidTerminal(o.terminalStatus)) return own;
  return terminalLevelOf(own);
}

/**
 * Horas de um extra divididas em normais e terminal (só os troços que contam
 * para pagamento entram aqui). Desligado → tudo normal, como hoje.
 */
export function splitTerminalHours(
  shifts: ReadonlyArray<{ hours: number; terminalStatus?: string | null }>,
  enabled: boolean,
): { normalHours: number; terminalHours: number; pendingHours: number } {
  let normal = 0, terminal = 0, pending = 0;
  for (const s of shifts) {
    const h = Number(s.hours) || 0;
    if (enabled && isPaidTerminal(s.terminalStatus)) terminal += h;
    else {
      normal += h;
      if (enabled && isPendingTerminal(s.terminalStatus)) pending += h;
    }
  }
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return { normalHours: r2(normal), terminalHours: r2(terminal), pendingHours: r2(pending) };
}
