/**
 * Plano 62, P0 — "Diagnóstico dos tempos (calibração)": a sonda dentro da app.
 *
 * Corre no servidor, a pedido do super admin (Extras-Dia → Pressão → botão
 * "Correr"), UM dia operacional por pedido. Só lê:
 *  - BD da Multipark (só leitura, `assertReadOnlySql` em cada consulta):
 *    History do dia (+ 48 h para os MOVEMENT), reservas, agentes, garagens,
 *    parques e os telefones (só em memória);
 *  - a nossa BD: central_calls, whatsapp_calls, crm_booking_links /
 *    crm_client_phones, o Histórico Diário (daily_driver_history), as fichas
 *    (identidade agente → ficha), os check-ins de PDA e as definições;
 *  - os GeoJSON do Zello pelo mesmo caminho da app (`storageReadableUrl`),
 *    até 60 ficheiros, 6 de cada vez, com prazo.
 * Não escreve em lado nenhum, não manda nada a ninguém, não tem interruptor.
 * NUNCA lança: o que falhar vem em `failures` ("falhou: motivo") e o que não
 * coube no prazo vem com `truncated`. Cada corrida escreve as linhas
 * `[sonda62 n/N] {…}` (só agregados) no log do servidor.
 */
import { isMultiparkDbConfigured, type SqlParam } from "./multiparkDb/client";
import { describeReadFailure } from "./multiparkDb/read";
import type { AirportsMap } from "../shared/pontoTerminal";
import { operationalDayRangeUtc, lisbonDayOf } from "../shared/lisbonDay";
import { last9 } from "../shared/centralXsi";
import { matchCityKey } from "../shared/city";
import { marketplaceOperated } from "../shared/multiparkParks";
import { PROBE_CITIES, PROBE_CITY_LABELS, emptySondaResult, sondaLogLines, type ProbeCity, type SondaResult } from "../shared/sondaTempos";
import {
  computeProbeCity, garageCoords,
  type AgentResolution, type PosPoint, type ProbeSource, type ProbeBooking, type ProbeCall, type ProbeEvent, type ProbeGarage, type ProbeGpsEmp, type ProbeGpsFile, type ProbePark, type TerminalClass,
} from "./sondaTemposCompute";
import {
  PROBE_HISTORY_LIMIT, PROBE_IDS_PER_READ,
  buildProbeAgentsSql, buildProbeBookingsSql, buildProbeClientPhonesSql, buildProbeClockSql, buildProbeCoordColumnsSql, buildProbeDriverPhonesSql,
  buildProbeGaragesSql, buildProbeHistorySql, buildProbeParksSql, garageCoordColumns, mapCoordColumns, mapProbeHistoryRow, utcTextMs,
  type ProbeCoordColumn,
} from "./multiparkDb/sondaTempos";

// ─── Limites ────────────────────────────────────────────────────────────────

/** Prazo de um pedido (a função da Vercel corta aos 60 s). */
export const PROBE_DEADLINE_MS = 45_000;
/** Ficheiros GPS por pedido, quantos de cada vez e o prazo de cada um. */
export const PROBE_MAX_FILES = 60;
export const PROBE_FILE_PARALLEL = 6;
export const PROBE_FILE_TIMEOUT_MS = 15_000;
/** Tempo-limite da leitura da History e das leituras por chave (BD da Multipark). */
export const PROBE_HISTORY_TIMEOUT_MS = 25_000;
export const PROBE_KEY_TIMEOUT_MS = 8_000;
/** Folga para o fim (juntar, contar, escrever o log). */
const FINISH_RESERVE_MS = 3_000;

const H = 3_600_000;

// ─── Dependências (injetáveis nos testes) ───────────────────────────────────

export type MpQuery = <T = Record<string, unknown>>(sql: string, params?: SqlParam[], opts?: { timeoutMs?: number; analytics?: boolean }) => Promise<T[]>;

/** Uma linha do Histórico Diário (um Zello num dia) com as pessoas que nos interessam nela. */
export interface ProbeGpsSource { id: number; day: string; geoJsonUrl: string | null; split: boolean; rowEmployeeId: number | null; employeeIds: number[]; zello: string }

export interface ProbeDeps {
  now: () => number;
  mpConfigured: () => boolean;
  mpQuery: MpQuery;
  settings: () => Promise<{ airports: AirportsMap; centralSugarOn: boolean | null; excludedParkIds: string[] }>;
  /** chamadas RECEBIDAS (central e WhatsApp) em [from, to) UTC */
  calls: (fromUtc: string, toUtc: string) => Promise<ProbeCall[]>;
  /** reserva → telefones e fichas do CRM ligadas */
  crmPhones: (bookingIds: string[]) => Promise<Map<string, { phones: string[]; clientIds: number[] }>>;
  identity: () => Promise<(uid: string | null, name: string | null) => AgentResolution>;
  /** as linhas do Histórico Diário das pessoas pedidas nesses dias */
  gpsSources: (employeeIds: number[], days: string[]) => Promise<ProbeGpsSource[]>;
  /** "de quem é o ponto?" numa linha partida por check-ins de PDA (null = linha inteira) */
  gpsHolder: (sources: ProbeGpsSource[]) => Promise<(src: ProbeGpsSource) => ((tsSec: number) => number | null) | null>;
  fetchPoints: (src: ProbeGpsSource, signal: AbortSignal) => Promise<PosPoint[]>;
  /** linhas do Histórico Diário dos dias (só a passagem e se tem ficheiro) */
  gpsRows: (days: string[]) => Promise<Array<{ pass: string; hasFile: boolean }>>;
  /** a regra única do terminal (server/extrasDia.ts → classifyDeliveryType) */
  classifier: () => Promise<(deliveryType: string | null, city: ProbeCity) => TerminalClass>;
  parkClassify: (rows: Array<Record<string, unknown>>) => Promise<Array<{ id: string; name: string; ours: boolean; city: string | null }>>;
  operated: (p: { id: string; name: string; ours: boolean }, excluded: readonly string[]) => boolean;
  log: (line: string) => void;
}

export interface TimesProbeResponse {
  day: string;
  cities: ProbeCity[];
  results: Partial<Record<ProbeCity, SondaResult>>;
  elapsedMs: number;
  truncated: boolean;
  failures: string[];
}

// ─── Ajudantes ──────────────────────────────────────────────────────────────

const mysqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const chunk = <T,>(xs: readonly T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };
const cityOfKey = (k: string | null | undefined): ProbeCity | null => {
  const c = matchCityKey(k);
  return c === "lisboa" ? "lisbon" : c === "porto" ? "porto" : c === "faro" ? "faro" : null;
};
/**
 * Texto curto de um erro para as linhas `[sonda62]` do log, SEM dados: o
 * drizzle mete o SQL e os parâmetros na mensagem ("Failed query: … params:
 * <ids>") — fica só a causa; textos entre aspas com algarismos ou @ (valores),
 * emails, telefones e ids longos saem. PURA.
 */
export function probeErrText(err: unknown): string {
  const e = err as { message?: unknown; cause?: { message?: unknown } | unknown } | null | undefined;
  let msg = String(e?.message ?? err ?? "");
  if (/^\s*Failed query:/i.test(msg)) {
    const cause = (e?.cause as { message?: unknown } | undefined)?.message ?? e?.cause;
    msg = cause ? String(cause) : "a consulta falhou";
  }
  msg = msg.split(/\bparams:/i)[0];
  const clean = msg
    .replace(/\s+/g, " ")
    .replace(/(['"`])([^'"`]*)\1/g, (m, q: string, inner: string) => (/[0-9@+]/.test(inner) || inner.length > 40 ? `${q}…${q}` : m))
    .replace(/[^\s'"`@]+@[^\s'"`@]+/g, "…@…")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "#")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\b/g, "#")
    .trim()
    .slice(0, 160);
  return clean || "erro";
}

/** Corre `fn` sobre a lista, `limit` de cada vez. */
async function pool<T>(items: readonly T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const run = async () => { while (i < items.length) { const x = items[i++]; await fn(x); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** Espera pela promessa até `ms`; depois aborta e rejeita ("prazo"). */
function withTimeout<T>(p: Promise<T>, ms: number, ctrl: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, rej) => { timer = setTimeout(() => { ctrl.abort(); rej(new Error("prazo")); }, Math.max(0, ms)); });
  return Promise.race([p, t]).finally(() => { if (timer) clearTimeout(timer); });
}

/** De que ficheiros GPS (dias de Lisboa) precisa uma pessoa, e quantos serviços tem (o peso). */
export interface GpsNeed { services: number; days: Set<string> }

/**
 * As pessoas com serviços no dia operacional (o agente do início da entrega,
 * do check-in e dos movimentos) e os dias de Lisboa dos ficheiros GPS de que
 * precisam: o do dia sempre; o do dia seguinte só se uma janela passa da
 * meia-noite — entrega até à assinatura + 30 min (sem assinatura: S + 30 min),
 * check-in e movimento até t + 90 min. Assim o ficheiro do dia seguinte só se
 * lê para quem trabalhou depois da meia-noite (menos leituras ao S3 e menos
 * "leitura parcial" por causa do limite de 60). PURA.
 */
export function gpsNeeds(
  events: readonly ProbeEvent[],
  o: { opStartMs: number; opEndMs: number; hasBooking: (id: string) => boolean; resolve: (uid: string | null, name: string | null) => AgentResolution },
): Map<number, GpsNeed> {
  const checkouts = new Map<string, number[]>();
  for (const e of events) if (e.type === "CHECK_OUT") checkouts.set(e.bookingId, [...(checkouts.get(e.bookingId) ?? []), e.atMs]);
  for (const list of checkouts.values()) list.sort((a, b) => a - b);
  const out = new Map<number, GpsNeed>();
  for (const e of events) {
    if (e.atMs < o.opStartMs - H || e.atMs >= o.opEndMs + H || !o.hasBooking(e.bookingId)) continue;
    if (e.type !== "CHECKING_OUT" && e.type !== "CHECK_IN" && e.type !== "MOVEMENT") continue;
    const r = o.resolve(e.uid, e.agentName);
    if (r.kind !== "ficha") continue;
    let endMs = e.atMs + 90 * 60_000;
    if (e.type === "CHECKING_OUT") {
      const co = checkouts.get(e.bookingId)?.find((t) => t >= e.atMs && t - e.atMs <= 4 * H);
      endMs = (co ?? e.atMs) + 30 * 60_000;
    }
    const need = out.get(r.employeeId) ?? { services: 0, days: new Set<string>() };
    need.services++;
    // o ficheiro do dia operacional sempre (as janelas começam no dia: [S − 30 min, …], [K0 − 30 min, I]…)
    need.days.add(lisbonDayOf(o.opStartMs));
    need.days.add(lisbonDayOf(endMs));
    out.set(r.employeeId, need);
  }
  return out;
}

/**
 * Os ficheiros GPS das pessoas pedidas: até `maxFiles` (os do dia `primaryDay`
 * primeiro e, dentro de cada dia, os das pessoas com mais serviços),
 * `parallel` de cada vez, cada um com o seu prazo e todos com o prazo do
 * pedido. Nunca lança. O estado de cada pessoa:
 * ok (algum ficheiro lido) · sem_linha · sem_ficheiro · por_ler.
 */
export async function loadProbeGps(
  servicesByEmp: ReadonlyMap<number, number>,
  sources: ProbeGpsSource[],
  holder: (src: ProbeGpsSource) => ((tsSec: number) => number | null) | null,
  fetchPoints: ProbeDeps["fetchPoints"],
  o: { now: () => number; deadlineAt: number; maxFiles?: number; parallel?: number; fileTimeoutMs?: number; primaryDay?: string },
): Promise<{ byEmp: Map<number, ProbeGpsEmp>; read: number; pending: number; truncated: boolean }> {
  const byEmp = new Map<number, ProbeGpsEmp>();
  for (const e of servicesByEmp.keys()) byEmp.set(e, { status: "sem_linha", files: [] });
  const withFile = sources.filter((s) => s.geoJsonUrl);
  for (const s of sources) for (const e of s.employeeIds) {
    const cur = byEmp.get(e);
    if (cur && cur.status === "sem_linha") cur.status = "sem_ficheiro";
  }
  const weight = (s: ProbeGpsSource) => s.employeeIds.reduce((t, e) => t + (servicesByEmp.get(e) ?? 0), 0);
  const dayRank = (s: ProbeGpsSource) => (o.primaryDay && s.day !== o.primaryDay ? 1 : 0);
  const ordered = [...withFile].sort((a, b) => dayRank(a) - dayRank(b) || weight(b) - weight(a) || a.id - b.id);
  const max = o.maxFiles ?? PROBE_MAX_FILES;
  const take = ordered.slice(0, max);
  let pending = ordered.length - take.length;
  let read = 0;
  const failedFor = new Set<number>();
  for (const s of ordered.slice(max)) for (const e of s.employeeIds) failedFor.add(e);
  await pool(take, o.parallel ?? PROBE_FILE_PARALLEL, async (src) => {
    const left = o.deadlineAt - o.now();
    if (left <= 0) { pending++; for (const e of src.employeeIds) failedFor.add(e); return; }
    const ctrl = new AbortController();
    let points: PosPoint[];
    try {
      points = await withTimeout(fetchPoints(src, ctrl.signal), Math.min(o.fileTimeoutMs ?? PROBE_FILE_TIMEOUT_MS, left), ctrl);
    } catch {
      pending++;
      for (const e of src.employeeIds) failedFor.add(e);
      return;
    }
    read++;
    const h = src.split ? holder(src) : null;
    for (const e of src.employeeIds) {
      const mine = h ? (ts: number) => h(ts) === e : () => src.rowEmployeeId === e;
      const file: ProbeGpsFile = { id: src.id, day: src.day, split: src.split, points, mine };
      const cur = byEmp.get(e) ?? { status: "sem_linha" as const, files: [] };
      byEmp.set(e, { status: "ok", files: [...cur.files, file] });
    }
  });
  for (const e of failedFor) { const cur = byEmp.get(e); if (cur && cur.status !== "ok") cur.status = "por_ler"; }
  return { byEmp, read, pending, truncated: pending > 0 };
}

// ─── A corrida ──────────────────────────────────────────────────────────────

/** Dia operacional aceite: AAAA-MM-DD e já acabado (antes de hoje em Lisboa). PURA. */
export function probeDayError(day: string, nowMs: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "falhou: dia inválido";
  // 2026-02-30 passa na expressão mas não existe (o Date passava-o para 2 de março)
  const noon = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(noon) || new Date(noon).toISOString().slice(0, 10) !== day) return "falhou: dia inválido";
  const end = operationalDayRangeUtc(day).endMs;
  if (end > nowMs) return "falhou: o dia operacional ainda não acabou (escolhe um dia fechado; o ideal é D-3, com o GPS final)";
  return null;
}

/**
 * Corre a sonda para um dia operacional e as cidades pedidas. NUNCA lança.
 */
export async function runTimesProbe(input: { day: string; cities: ProbeCity[] }, deps: ProbeDeps): Promise<TimesProbeResponse> {
  const t0 = deps.now();
  const deadlineAt = t0 + PROBE_DEADLINE_MS - FINISH_RESERVE_MS;
  const cities = PROBE_CITIES.filter((c) => input.cities.includes(c));
  const out: TimesProbeResponse = { day: input.day, cities, results: {}, elapsedMs: 0, truncated: false, failures: [] };
  const fail = (msg: string) => { if (!out.failures.includes(msg)) out.failures.push(msg); };
  const finish = (): TimesProbeResponse => {
    out.elapsedMs = deps.now() - t0;
    for (const c of cities) {
      const r = out.results[c] ?? { ...emptySondaResult(c, [input.day]), failures: [...out.failures], truncated: out.truncated };
      out.results[c] = r;
      try { for (const line of sondaLogLines(r)) deps.log(line); } catch { /* o log nunca parte a resposta */ }
    }
    return out;
  };
  try {
    if (!cities.length) { fail("falhou: nenhuma cidade escolhida"); return finish(); }
    const dayErr = probeDayError(input.day, t0);
    if (dayErr) { fail(dayErr); return finish(); }
    if (!deps.mpConfigured()) { fail("falhou: a ligação à BD da Multipark não está configurada"); return finish(); }
    const op = operationalDayRangeUtc(input.day);
    /** Tempo-limite de uma leitura por chave: o normal, mas nunca para lá do prazo do pedido. */
    const keyTimeout = (): number => {
      const left = deadlineAt - deps.now();
      if (left < 1_000) throw new Error("statement timeout (prazo do pedido)");
      return Math.min(PROBE_KEY_TIMEOUT_MS, left);
    };
    /** Leituras que falharam: o que depende delas não conta nas contas deste dia (nunca como zero). */
    const down: Partial<Record<ProbeSource, boolean>> = {};
    const mpFail = (what: string, err: unknown) => {
      console.warn(`[sonda62] ${what}:`, probeErrText(err));
      fail(`falhou: ${what}: ${describeReadFailure(err).reason}`);
    };

    // 1. Definições (nossa BD)
    let settings: Awaited<ReturnType<ProbeDeps["settings"]>> = { airports: {} as AirportsMap, centralSugarOn: null, excludedParkIds: [] };
    try { settings = await deps.settings(); } catch (err) { console.warn("[sonda62] definições:", probeErrText(err)); fail("falhou: definições (usam-se as omissões)"); }
    if (!settings.airports || !Object.keys(settings.airports).length) {
      const { DEFAULT_TERMINAL_AIRPORTS } = await import("../shared/pontoTerminal");
      settings.airports = DEFAULT_TERMINAL_AIRPORTS;
    }

    // 2. Parques (Multipark)
    let parkRows: Array<Record<string, unknown>>;
    try {
      const q = buildProbeParksSql();
      parkRows = await deps.mpQuery(q.sql, q.params, { timeoutMs: keyTimeout() });
    } catch (err) { mpFail("parques da Multipark", err); return finish(); }
    const classified = await deps.parkClassify(parkRows);
    const latLng = new Map(parkRows.map((r) => [String(r.id ?? ""), { lat: Number(r.lat), lng: Number(r.lng) }]));
    const parks = new Map<string, ProbePark>();
    const excludedCount = new Map<ProbeCity, number>();
    for (const p of classified) {
      const city = cityOfKey(p.city);
      if (!city || !cities.includes(city)) continue;
      if (!deps.operated(p, settings.excludedParkIds)) { excludedCount.set(city, (excludedCount.get(city) ?? 0) + 1); continue; }
      const ll = latLng.get(p.id);
      parks.set(p.id, { id: p.id, name: p.name, city, lat: ll && Number.isFinite(ll.lat) && ll.lat !== 0 ? ll.lat : null, lng: ll && Number.isFinite(ll.lng) && ll.lng !== 0 ? ll.lng : null });
    }
    if (!parks.size) { fail("falhou: nenhum parque operado nas cidades escolhidas"); return finish(); }

    // 3. History (UMA leitura) — dia − 6 h até + 48 h (MOVEMENT/UPDATE/CANCEL) e até + 6 h (o resto)
    let events: ProbeEvent[] = [];
    try {
      const q = buildProbeHistorySql({ parkIds: [...parks.keys()], from: mysqlTs(op.startMs - 6 * H), to: mysqlTs(op.endMs + 48 * H), coreTo: mysqlTs(op.endMs + 6 * H), limit: PROBE_HISTORY_LIMIT });
      const rows = await deps.mpQuery(q.sql, q.params, { timeoutMs: Math.min(PROBE_HISTORY_TIMEOUT_MS, Math.max(1_000, deadlineAt - deps.now())), analytics: true });
      events = rows.map(mapProbeHistoryRow).filter((e): e is ProbeEvent => !!e);
      if (rows.length >= PROBE_HISTORY_LIMIT) { out.truncated = true; fail(`falhou em parte: a leitura da History chegou ao teto de ${PROBE_HISTORY_LIMIT} linhas`); }
    } catch (err) { mpFail("History da Multipark", err); return finish(); }

    // 4. Leituras por chave (Multipark)
    const bookingIds = [...new Set(events.map((e) => e.bookingId))];
    const bookings = new Map<string, ProbeBooking>();
    const clientOf = new Map<string, string>();
    const phones = new Map<string, Set<string>>();
    const addPhone = (b: string, raw: unknown) => { const k = last9(raw); if (!k) return; const s = phones.get(b) ?? new Set<string>(); s.add(k); phones.set(b, s); };
    try {
      const classify = await deps.classifier();
      for (const ids of chunk(bookingIds, PROBE_IDS_PER_READ)) {
        const q = buildProbeBookingsSql(ids);
        if (!q) continue;
        for (const r of await deps.mpQuery(q.sql, q.params, { timeoutMs: keyTimeout() })) {
          const id = String(r.id ?? ""), parkId = String(r.park_id ?? "");
          const park = parks.get(parkId);
          if (!id || !park) continue;
          bookings.set(id, { id, parkId, terminalClass: classify((r.delivery_type as string | null) ?? null, park.city) });
          if (r.client_id) clientOf.set(id, String(r.client_id));
        }
      }
    } catch (err) { mpFail("reservas da Multipark", err); return finish(); }
    const agents = new Map<string, Array<{ parkId: string; role: string }>>();
    try {
      const uids = [...new Set(events.map((e) => e.uid).filter((u): u is string => !!u))];
      for (const ids of chunk(uids, PROBE_IDS_PER_READ)) {
        const q = buildProbeAgentsSql(ids);
        if (!q) continue;
        for (const r of await deps.mpQuery(q.sql, q.params, { timeoutMs: keyTimeout() })) {
          const u = String(r.uid ?? "");
          if (u) agents.set(u, [...(agents.get(u) ?? []), { parkId: String(r.park_id ?? ""), role: String(r.role ?? "") }]);
        }
      }
    } catch (err) { down.agentes = true; mpFail("agentes da Multipark (sem papéis)", err); }
    // Q6: de onde vêm as coordenadas das garagens (information_schema) e as garagens com elas
    let coordCols: ProbeCoordColumn[] = [];
    try {
      const q = buildProbeCoordColumnsSql();
      coordCols = mapCoordColumns(await deps.mpQuery(q.sql, q.params, { timeoutMs: keyTimeout() }));
    } catch (err) { mpFail("colunas das coordenadas (Q6)", err); }
    let garages: ProbeGarage[] = [];
    try {
      const gc = garageCoordColumns(coordCols);
      const q = buildProbeGaragesSql(gc);
      garages = (await deps.mpQuery(q.sql, q.params, { timeoutMs: keyTimeout() })).map((r) => {
        const c = garageCoords({ lat: r.g_lat, lng: r.g_lng, other: gc.other.map((column, i) => ({ column, value: r[`g_other_${i}`] })), mapLink: (r.map_link as string | null) ?? null });
        return {
          name: String(r.name ?? "").trim(), parkingType: r.parking_type ? String(r.parking_type) : null, parkId: String(r.park_id ?? ""),
          mapHasCoords: c.source === "link do mapa (mapLink)", lat: c.lat, lng: c.lng, coordSource: c.source,
        };
      }).filter((g) => g.name);
    } catch (err) { down.garagens = true; mpFail("garagens da Multipark", err); }
    try {
      const byClient = new Map<string, string[]>();
      for (const [b, c] of clientOf) byClient.set(c, [...(byClient.get(c) ?? []), b]);
      for (const ids of chunk([...byClient.keys()], PROBE_IDS_PER_READ)) {
        const q = buildProbeClientPhonesSql(ids);
        if (!q) continue;
        for (const r of await deps.mpQuery(q.sql, q.params, { timeoutMs: keyTimeout() })) for (const b of byClient.get(String(r.id ?? "")) ?? []) addPhone(b, r.phone);
      }
      for (const ids of chunk([...bookings.keys()], PROBE_IDS_PER_READ)) {
        const q = buildProbeDriverPhonesSql(ids);
        if (!q) continue;
        for (const r of await deps.mpQuery(q.sql, q.params, { timeoutMs: keyTimeout() })) addPhone(String(r.booking_id ?? ""), r.phone);
      }
    } catch (err) { down.chamadas = true; mpFail("telefones das reservas (as chamadas deste dia não contam)", err); }
    let pgClockOffsetMs: number | null = null;
    try {
      const q = buildProbeClockSql();
      const before = deps.now();
      const [row] = await deps.mpQuery(q.sql, q.params, { timeoutMs: keyTimeout() });
      const pg = utcTextMs(row?.now_utc);
      if (pg != null) pgClockOffsetMs = pg - Math.round((before + deps.now()) / 2);
    } catch (err) { mpFail("relógio da Multipark", err); }

    // 5. Nossa BD: chamadas, CRM, identidade
    let calls: ProbeCall[] = [];
    try { calls = await deps.calls(mysqlTs(op.startMs - 4 * H), mysqlTs(op.endMs + 48 * H)); } catch (err) { down.chamadas = true; console.warn("[sonda62] chamadas:", probeErrText(err)); fail("falhou: chamadas (central/WhatsApp) — erro na leitura"); }
    const crmIds = new Map<string, Set<number>>();
    try {
      const crm = await deps.crmPhones([...bookings.keys()]);
      for (const [b, v] of crm) {
        for (const ph of v.phones) addPhone(b, ph);
        if (v.clientIds.length) crmIds.set(b, new Set(v.clientIds));
      }
    } catch (err) { down.chamadas = true; console.warn("[sonda62] CRM:", probeErrText(err)); fail("falhou: telefones do CRM — erro na leitura (as chamadas deste dia não contam)"); }
    let resolveAgent: (uid: string | null, name: string | null) => AgentResolution = () => ({ kind: "sem_ficha" });
    try { resolveAgent = await deps.identity(); } catch (err) { down.gps = true; console.warn("[sonda62] identidade:", probeErrText(err)); fail("falhou: fichas (agente → ficha) — o GPS deste dia não conta"); }

    // 6. GPS: as pessoas com serviços no dia (o agente do início da entrega, do check-in e do 1.º movimento)
    //    e, de cada uma, só os ficheiros (dia de Lisboa) que as janelas dela tocam
    const needs = down.gps ? new Map<number, GpsNeed>() : gpsNeeds(events, { opStartMs: op.startMs, opEndMs: op.endMs, hasBooking: (id) => bookings.has(id), resolve: resolveAgent });
    const servicesByEmp = new Map([...needs].map(([e, n]) => [e, n.services] as const));
    const lisbonDays = [...new Set([...needs.values()].flatMap((n) => [...n.days]))].sort();
    let gpsByEmp = new Map<number, ProbeGpsEmp>();
    let filesPending = 0;
    if (servicesByEmp.size) {
      try {
        const sources = (await deps.gpsSources([...servicesByEmp.keys()], lisbonDays))
          .filter((s) => s.employeeIds.some((e) => needs.get(e)?.days.has(s.day)));
        const holder = await deps.gpsHolder(sources);
        const g = await loadProbeGps(servicesByEmp, sources, holder, deps.fetchPoints, { now: deps.now, deadlineAt, primaryDay: input.day });
        gpsByEmp = g.byEmp;
        filesPending = g.pending;
        if (g.truncated) { out.truncated = true; fail(`falhou em parte: ${g.pending} ficheiro(s) GPS por ler (prazo ou limite de ${PROBE_MAX_FILES})`); }
      } catch (err) { down.gps = true; console.warn("[sonda62] GPS:", probeErrText(err)); fail("falhou: GPS do Zello — erro na leitura (o GPS deste dia não conta)"); }
    }
    let gpsRows: Array<{ pass: string; hasFile: boolean }> = [];
    try { gpsRows = await deps.gpsRows([input.day]); } catch (err) { console.warn("[sonda62] Histórico Diário:", probeErrText(err)); fail("falhou: linhas do Histórico Diário — erro na leitura"); }

    // 7. As contas, por cidade
    let first = true;
    for (const city of cities) {
      try {
        const cityParks = new Map([...parks].filter(([, p]) => p.city === city));
        const cityBookings = new Map([...bookings].filter(([, b]) => cityParks.has(b.parkId)));
        out.results[city] = computeProbeCity({
          city, day: input.day, opStartMs: op.startMs, opEndMs: op.endMs,
          events: events.filter((e) => cityBookings.has(e.bookingId)),
          bookings: cityBookings,
          parks: cityParks,
          garages,
          agents,
          resolveAgent,
          gps: gpsByEmp,
          phones,
          crmIds,
          calls,
          airport: settings.airports[city] ?? null,
          global: first ? { gpsRows, filesPending, calls } : undefined,
          coordColumns: coordCols.map((c) => `${c.table}.${c.column} (${c.type})`),
          staticBase: { centralSugarOn: settings.centralSugarOn, excludedParks: excludedCount.get(city) ?? 0, parks: cityParks.size, pgClockOffsetMs },
          truncated: out.truncated,
          failures: [...out.failures],
          unavailable: { ...down },
        });
        first = false;
      } catch (err) {
        console.warn(`[sonda62] contas ${city}:`, probeErrText(err));
        fail(`falhou: contas de ${PROBE_CITY_LABELS[city]} (erro inesperado)`);
      }
    }
  } catch (err) {
    console.warn("[sonda62] erro inesperado:", probeErrText(err));
    fail("falhou: erro inesperado (ver o log do servidor)");
  }
  return finish();
}

// ─── As dependências reais ──────────────────────────────────────────────────

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r) as any[]) ?? [];

/** Memória das colunas com posições (information_schema), por instância. */
const COORD_COLUMNS_TTL_MS = 30 * 60_000;
let coordColumnsCache: { at: number; rows: Array<Record<string, unknown>> } | null = null;

/** As leituras de verdade (BD da Multipark só de leitura, nossa BD só SELECT, GeoJSON pelo storageReadableUrl). */
export function defaultProbeDeps(): ProbeDeps {
  return {
    now: () => Date.now(),
    mpConfigured: () => isMultiparkDbConfigured(),
    mpQuery: async (sql, params = [], opts) => {
      const { multiparkDbQuery } = await import("./multiparkDb/client");
      // As colunas do information_schema (Q6) não mudam de um dia para o outro:
      // lidas uma vez por instância (30 min), não uma vez por dia pedido.
      const meta = sql.includes("information_schema.columns");
      if (meta && coordColumnsCache && Date.now() - coordColumnsCache.at < COORD_COLUMNS_TTL_MS) return coordColumnsCache.rows as any;
      const rows = await multiparkDbQuery(sql, params, opts);
      if (meta) coordColumnsCache = { at: Date.now(), rows: rows as Array<Record<string, unknown>> };
      return rows as any;
    },
    settings: async () => {
      const [{ loadTerminalAirports }, { getSetting }, { ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }, { CENTRAL_SUGAR_FLAG }] = await Promise.all([
        import("./pontoTerminal"), import("./appSettings"), import("./_core/featureFlags"), import("../shared/appSettings"), import("../shared/centralSugar"),
      ]);
      const airports = await loadTerminalAirports();
      const excluded = ((await getSetting("operations.excludedParks").catch(() => [])) as string[] | null) ?? [];
      let centralSugarOn: boolean | null = null;
      try { await ensureFeatureFlagOverrides(); centralSugarOn = isFeatureEnabled(CENTRAL_SUGAR_FLAG, { defaultEnabled: automationFlagDefault(CENTRAL_SUGAR_FLAG) }); } catch { centralSugarOn = null; }
      return { airports, centralSugarOn, excludedParkIds: excluded };
    },
    calls: async (fromUtc, toUtc) => {
      const [{ getDb }, { sql }, { parseContactRef }] = await Promise.all([import("./db"), import("drizzle-orm"), import("../shared/centralSugar")]);
      const db = await getDb();
      if (!db) throw new Error("BD indisponível");
      const out: ProbeCall[] = [];
      for (const r of rowsOf(await db.execute(sql`SELECT held, DATE_FORMAT(startedAt, '%Y-%m-%d %H:%i:%s') AS startedAt, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s') AS createdAt, phone, contactRef
          FROM central_calls WHERE direction = 'in' AND startedAt >= ${fromUtc} AND startedAt < ${toUtc} LIMIT 20000`))) {
        const at = utcTextMs(r.startedAt);
        if (at == null) continue;
        const ref = parseContactRef(r.contactRef);
        out.push({
          source: "central", atMs: at, held: Number(r.held) === 1, createdAtMs: utcTextMs(r.createdAt),
          last9: last9(r.phone) ?? (ref?.kind === "tel" ? last9(ref.id) : null),
          crmClientId: ref?.kind === "crm" ? Number(ref.id) : null,
        });
      }
      for (const r of rowsOf(await db.execute(sql`SELECT DATE_FORMAT(startedAt, '%Y-%m-%d %H:%i:%s') AS startedAt, phoneE164, missed
          FROM whatsapp_calls WHERE direction = 'in' AND startedAt >= ${fromUtc} AND startedAt < ${toUtc} LIMIT 20000`))) {
        const at = utcTextMs(r.startedAt);
        if (at == null) continue;
        out.push({ source: "whatsapp", atMs: at, held: Number(r.missed) !== 1, createdAtMs: null, last9: last9(r.phoneE164), crmClientId: null });
      }
      return out;
    },
    crmPhones: async (bookingIds) => {
      const [{ getDb }, { sql }] = await Promise.all([import("./db"), import("drizzle-orm")]);
      const db = await getDb();
      const out = new Map<string, { phones: string[]; clientIds: number[] }>();
      if (!db || !bookingIds.length) return out;
      for (const ids of chunk(bookingIds, 500)) {
        for (const r of rowsOf(await db.execute(sql`SELECT l.bookingExternalId AS b, l.clientId AS c, p.phone AS phone
            FROM crm_booking_links l LEFT JOIN crm_client_phones p ON p.clientId = l.clientId
           WHERE l.bookingExternalId IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)}) LIMIT 20000`))) {
          const b = String(r.b ?? "");
          const cur = out.get(b) ?? { phones: [], clientIds: [] };
          if (r.phone) cur.phones.push(String(r.phone));
          const c = Number(r.c);
          if (Number.isInteger(c) && c > 0 && !cur.clientIds.includes(c)) cur.clientIds.push(c);
          out.set(b, cur);
        }
      }
      return out;
    },
    identity: async () => {
      const [{ loadEvaluationIdentity }, { isSystemAgentId }] = await Promise.all([import("./evaluationIdentity"), import("../shared/agentIdentity")]);
      const { identity } = await loadEvaluationIdentity();
      return (uid, name) => {
        if (isSystemAgentId(uid)) return { kind: "sistema" };
        const r = identity.agent(uid, name);
        if (r.kind === "colaborador") return { kind: "ficha", employeeId: r.employeeId };
        if (r.kind === "parceiro") return { kind: "parceiro" };
        if (r.kind === "ignorado") return { kind: "sistema" };
        return { kind: "sem_ficha" };
      };
    },
    gpsSources: async (employeeIds, days) => {
      const { gpsSourcesFor } = await import("./shiftGps");
      return (await gpsSourcesFor(employeeIds, days)).map((s) => ({
        id: s.id, day: s.day, geoJsonUrl: s.geoJsonUrl, split: s.split, rowEmployeeId: s.rowEmployeeId, employeeIds: [...s.employeeIds], zello: s.zello,
      }));
    },
    gpsHolder: async (sources) => {
      const split = sources.filter((s) => s.split);
      if (!split.length) return () => null;
      const [{ pdaIntervalsForDay, fixedZelloOwners }, { holderAtFn }, { zelloKey }] = await Promise.all([import("./db"), import("./shiftGps"), import("../shared/zelloKey")]);
      const days = [...new Set(split.map((s) => s.day))];
      const intervals = new Map(await Promise.all(days.map(async (d) => [d, await pdaIntervalsForDay(d)] as const)));
      const owners = await fixedZelloOwners().catch(() => new Map<string, number>());
      return (src) => (src.split ? holderAtFn(intervals.get(src.day)?.get(zelloKey(src.zello)) ?? [], owners.get(zelloKey(src.zello)) ?? null) : null);
    },
    fetchPoints: async (src, signal) => {
      if (!src.geoJsonUrl) return [];
      const [{ storageReadableUrl }, { gpsPointsFromGeoJson }] = await Promise.all([import("./storageSign"), import("./zelloGps")]);
      const res = await fetch(await storageReadableUrl(src.geoJsonUrl), { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return gpsPointsFromGeoJson(await res.json())
        .filter((p) => p.lat != null && p.lon != null)
        .map((p) => ({ ts: p.ts, speed: p.speed, lat: p.lat as number, lon: p.lon as number, accurate: p.accurate }));
    },
    gpsRows: async (days) => {
      const [{ getDb }, { sql }] = await Promise.all([import("./db"), import("drizzle-orm")]);
      const db = await getDb();
      if (!db || !days.length) return [];
      return rowsOf(await db.execute(sql`SELECT collectionPass AS pass, (geoJsonUrl IS NOT NULL AND geoJsonUrl <> '') AS hasFile
          FROM daily_driver_history WHERE DATE(date) IN (${sql.join(days.map((d) => sql`${d}`), sql`, `)}) LIMIT 5000`))
        .map((r) => ({ pass: String(r.pass ?? ""), hasFile: Number(r.hasFile) === 1 }));
    },
    classifier: async () => {
      const { classifyDeliveryType } = await import("./extrasDia");
      return (deliveryType, city) => classifyDeliveryType(deliveryType, city) as TerminalClass;
    },
    parkClassify: async (rows) => {
      const { mapParks } = await import("./multiparkDb/dayBookings");
      return mapParks(rows).map((p) => ({ id: p.id, name: p.name, ours: p.ours, city: p.city ?? p.cityName }));
    },
    // a regra única de "parque operado" (shared/multiparkParks.ts)
    operated: (p, excluded) => marketplaceOperated(p, excluded),
    log: (line) => console.log(line),
  };
}
