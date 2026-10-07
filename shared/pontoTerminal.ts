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
 *    paga terminal até o RH confirmar), "partial" (ver abaixo), "confirmed"
 *    (o RH marcou — paga o troço todo) e "rejected" (o RH desmarcou — não
 *    paga). Nada se apaga.
 *
 * Saída fora do aeroporto (Jorge, 7 out 2026): "Se o extra der saída do
 * terminal e já não esteja no terminal, conta até à última recolha ou entrega
 * feita por ele." O troço "pending" passa a "partial" quando a Multipark tem
 * recolhas (CHECK_IN) ou entregas (CHECK_OUT) feitas por ele dentro do troço:
 * o terminal conta da entrada no aeroporto até à ÚLTIMA delas
 * (`time_records.terminalUntil`, UTC) e daí até à saída é hora normal. Sem
 * nenhuma, ou sem conseguir ler a Multipark, fica "pending" (o RH decide) —
 * nunca se paga terminal sem prova.
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

/** Repetição automática dos "por confirmar": só os troços dos últimos N dias. */
export const TERMINAL_RETRY_DAYS = 7;

export type TerminalCheckInStatus = "start";
export type TerminalShiftStatus = "auto" | "pending" | "partial" | "confirmed" | "rejected";
export type TerminalStatus = TerminalCheckInStatus | TerminalShiftStatus;

export const TERMINAL_STATUS_LABELS: Record<TerminalStatus, string> = {
  start: "Terminal",
  auto: "Terminal",
  pending: "Terminal por confirmar",
  partial: "Terminal até à última recolha/entrega",
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

/** Instante (texto da BD "YYYY-MM-DD HH:MM:SS" em UTC, ISO ou Date) → ms; inválido → NaN. */
function toMs(v: string | Date | null | undefined): number {
  if (v == null || v === "") return NaN;
  if (v instanceof Date) return v.getTime();
  return parseUtc(String(v).trim());
}

/** ms → "YYYY-MM-DD HH:MM:SS" (UTC, como se grava na BD). */
function toDbUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** O troço fechado nesta saída era de terminal (pago, em parte ou por confirmar)? */
export function closedTerminalSegment(status: string | null | undefined): boolean {
  return status === "auto" || status === "pending" || status === "partial" || status === "confirmed";
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

/** O troço TODO paga como terminal? Só "auto" (GPS) e "confirmed" (RH). ("partial" paga só uma parte.) */
export function isPaidTerminal(status: string | null | undefined): boolean {
  return status === "auto" || status === "confirmed";
}

// ─── Saída fora do aeroporto: até à última recolha/entrega ──────────────────

/** Uma recolha (CHECK_IN) ou entrega (CHECK_OUT) feita pelo extra na Multipark. */
export interface TerminalServiceAction {
  /** instante UTC ("YYYY-MM-DD HH:MM:SS" ou ISO) */
  at: string;
  /** "CHECK_IN" (recolha) ou "CHECK_OUT" (entrega) */
  kind?: string | null;
  bookingCode?: string | null;
}

export type TerminalResolution =
  | { status: "partial"; terminalUntil: string; lastKind: "recolha" | "entrega" | null; bookingCode: string | null; actions: number }
  | { status: "pending"; reason: "read_failed" | "no_agent" | "no_actions" };

/**
 * REGRA (Jorge, 7 out 2026): troço de terminal fechado FORA do aeroporto (ou
 * sem GPS, ou saída esquecida) → o terminal conta da entrada até à ÚLTIMA
 * recolha/entrega feita por ele DENTRO do troço (entrada < ação ≤ saída).
 *  - `actions` null = a Multipark não respondeu → "pending" (o RH decide);
 *  - nenhuma ação dentro do troço (as de fora são ignoradas) → "pending";
 *  - senão → "partial" com `terminalUntil` = a última ação (UTC).
 * A saída no aeroporto não passa por aqui (continua "auto": tudo terminal).
 * PURA.
 */
export function resolveTerminalByLastService(o: {
  inAt: string | Date;
  outAt: string | Date;
  actions: ReadonlyArray<TerminalServiceAction> | null;
}): TerminalResolution {
  if (o.actions == null) return { status: "pending", reason: "read_failed" };
  const inMs = toMs(o.inAt), outMs = toMs(o.outAt);
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs <= inMs) return { status: "pending", reason: "no_actions" };
  let last: TerminalServiceAction | null = null, lastMs = -Infinity, n = 0;
  for (const a of o.actions) {
    const ms = toMs(a?.at);
    if (!Number.isFinite(ms) || ms <= inMs || ms > outMs) continue; // fora do troço → ignorada
    n++;
    if (ms > lastMs) { lastMs = ms; last = a; }
  }
  if (!last) return { status: "pending", reason: "no_actions" };
  const kind = String(last.kind ?? "").toUpperCase();
  return {
    status: "partial",
    terminalUntil: toDbUtc(Math.floor(lastMs / 1000) * 1000),
    lastKind: kind === "CHECK_IN" ? "recolha" : kind === "CHECK_OUT" ? "entrega" : null,
    bookingCode: last.bookingCode ?? null,
    actions: n,
  };
}

/** "HH:MM" de Lisboa de um instante UTC (texto da BD ou ISO). "" se inválido. PURA. */
export function lisbonClock(at: string | Date | null | undefined): string {
  const ms = toMs(at);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

/** Etiqueta do troço "partial": "Terminal até 14:32 (última recolha/entrega)". PURA. */
export function terminalPartialLabel(terminalUntil: string | Date | null | undefined): string {
  const hm = lisbonClock(terminalUntil);
  return hm ? `Terminal até ${hm} (última recolha/entrega)` : TERMINAL_STATUS_LABELS.partial;
}

/** Etiqueta de qualquer estado de terminal (o "partial" leva a hora). PURA. */
export function terminalStatusLabel(status: string | null | undefined, terminalUntil?: string | Date | null): string {
  if (!status) return "";
  if (status === "partial") return terminalPartialLabel(terminalUntil);
  return (TERMINAL_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

/** Um troço (o par entrada/saída) para a divisão das horas. */
export interface TerminalShiftLike {
  /** horas pagas do troço (as da saída / corrigidas pelo RH) */
  hours: number;
  /** estado da SAÍDA */
  terminalStatus?: string | null;
  /** "partial": até quando conta o terminal (UTC) */
  terminalUntil?: string | Date | null;
  /** entrada do troço (UTC) — necessária no "partial" */
  inAt?: string | Date | null;
}

/**
 * REGRA ÚNICA das horas de um troço (ordenado E custo dos extras):
 * quantas horas pagam como terminal (nível seguinte) e quantas como normais.
 *  - interruptor desligado → tudo normal (igual a antes);
 *  - "auto" / "confirmed" → tudo terminal;
 *  - "partial" → terminal da entrada até `terminalUntil` (nunca mais do que as
 *    horas pagas do troço), o resto normal; sem entrada ou sem hora → tudo
 *    normal (sem prova não se paga terminal);
 *  - resto ("pending", "rejected", normal) → tudo normal.
 * PURA.
 */
export function terminalSplitOfShift(s: TerminalShiftLike, enabled: boolean): { terminalHours: number; normalHours: number } {
  const hours = Math.max(0, Number(s.hours) || 0);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  if (!enabled || hours <= 0) return { terminalHours: 0, normalHours: r2(hours) };
  if (isPaidTerminal(s.terminalStatus)) return { terminalHours: r2(hours), normalHours: 0 };
  if (s.terminalStatus === "partial") {
    const inMs = toMs(s.inAt ?? null), untilMs = toMs(s.terminalUntil ?? null);
    if (Number.isFinite(inMs) && Number.isFinite(untilMs) && untilMs > inMs) {
      const t = r2(Math.min(hours, (untilMs - inMs) / 3_600_000));
      return { terminalHours: t, normalHours: r2(hours - t) };
    }
  }
  return { terminalHours: 0, normalHours: r2(hours) };
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
 * A que nível se paga um troço INTEIRO de ponto de um extra. Interruptor
 * desligado ou troço que não paga terminal → o nível dele (igual a antes);
 * troço todo terminal → o nível seguinte. As horas de cada troço (incluindo
 * o "partial", que se divide) saem de `terminalSplitOfShift`.
 */
export function payLevelForShift(level: number | string | null | undefined, o: { terminalStatus: string | null | undefined; enabled: boolean }): number {
  const own = normalizeExtraLevel(level);
  if (!o.enabled || !isPaidTerminal(o.terminalStatus)) return own;
  return terminalLevelOf(own);
}

/**
 * Horas de um extra divididas em normais e terminal (só os troços que contam
 * para pagamento entram aqui), troço a troço pela regra única
 * `terminalSplitOfShift` ("partial" divide-se). Desligado → tudo normal, como hoje.
 */
export function splitTerminalHours(
  shifts: ReadonlyArray<TerminalShiftLike>,
  enabled: boolean,
): { normalHours: number; terminalHours: number; pendingHours: number } {
  let normal = 0, terminal = 0, pending = 0;
  for (const s of shifts) {
    const part = terminalSplitOfShift(s, enabled);
    terminal += part.terminalHours;
    normal += part.normalHours;
    if (enabled && isPendingTerminal(s.terminalStatus)) pending += part.normalHours;
  }
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return { normalHours: r2(normal), terminalHours: r2(terminal), pendingHours: r2(pending) };
}
