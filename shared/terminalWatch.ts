/**
 * TERMINAL PELO PERFIL — entrega B2 (plano 56; decisões do Jorge a 12 out
 * 2026). Regras PURAS, partilhadas pelo servidor (server/terminalWatch.ts,
 * server/terminalSessions.ts, ordenado e custo dos extras) e pelos ecrãs
 * (barra do terminal, Resumo do dia, ficha → Ponto).
 *
 * "Ainda estás no terminal?"
 *  - de 5 em 5 min lê-se o GPS do Zello do aparelho que está com a pessoa;
 *  - GPS velho (lastReportDelay > 10 min), pouco preciso ou inválido = "sem
 *    GPS": nunca conta como "fora" (nem como "dentro");
 *  - "fora" = distância − imprecisão > raio; só fica CONFIRMADO com 2 leituras
 *    seguidas fora (leituras diferentes, no máximo 15 min entre elas);
 *  - fora há mais de 20 min → pergunta (barra + push) e aviso ao TL de serviço;
 *  - "Sim, estou" → não volta a perguntar durante 60 min;
 *  - sem resposta em 15 min → o lugar liberta-se ("saiu do aeroporto às
 *    16:40 (GPS)"); até 30 min depois reabre-se sem buraco ("Ainda estou").
 *
 * Horas que contam (regra de 7 out: nunca se paga sem prova, não se corta a
 * quem tem prova):
 *  - fecho com GPS dentro da zona → até à hora do fecho ("gps_close");
 *  - senão → o máximo entre o último GPS dentro ("last_gps") e a última
 *    recolha/entrega dele ("last_service") — esta só até ao momento em que o
 *    GPS confirmou "fora";
 *  - sem nenhuma prova → "pending" (por confirmar, o RH decide);
 *  - "Ainda estou" sem prova não paga: fica para o RH ver.
 * Nada aqui toca na BD.
 */
import type { AirportFence } from "./pontoTerminal";
import { addDays, lisbonDayOf, lisbonWallTimeUtcMs } from "./lisbonDay";
import { lisbonClock } from "./pontoTerminal";
import {
  TERMINAL_MAX_ACCURACY_M, gpsInAirport, toDbUtc, toMs, validFix,
  type TerminalCountedBasis, type TerminalEndReason, type TerminalStartSource,
} from "./terminalSession";

// ─── Tempos (minutos) ───────────────────────────────────────────────────────

/** GPS do Zello mais velho do que isto = "sem GPS" (segundos). */
export const TERMINAL_GPS_STALE_S = 10 * 60;
/** Leituras fora para "fora" ficar confirmado. */
export const TERMINAL_OUTSIDE_READINGS = 2;
/** Duas leituras fora mais afastadas do que isto já não são "seguidas". */
export const TERMINAL_READINGS_GAP_MAX_MIN = 15;
/** Fora (confirmado) há mais de X min → "Ainda estás no terminal?". */
export const TERMINAL_ASK_AFTER_MIN = 20;
/** Sem resposta em X min → o lugar liberta-se. */
export const TERMINAL_NO_ANSWER_MIN = 15;
/** Depois de "Sim, estou" não se pergunta durante X min. */
export const TERMINAL_STILL_HERE_QUIET_MIN = 60;
/** Depois de libertado, "Ainda estou" reabre sem buraco durante X min. */
export const TERMINAL_REOPEN_MIN = 30;

const MIN = 60_000;

/** Bases que pagam (as outras — pendente, desmarcado — não pagam). */
export const TERMINAL_PAID_BASES: readonly TerminalCountedBasis[] = ["gps_close", "last_gps", "last_service", "confirmed"];
export function isPaidBasis(b: string | null | undefined): boolean {
  return (TERMINAL_PAID_BASES as readonly string[]).includes(String(b ?? ""));
}

export const TERMINAL_BASIS_LABELS: Record<TerminalCountedBasis, string> = {
  gps_close: "saiu com GPS no aeroporto",
  last_gps: "último GPS no aeroporto",
  last_service: "última recolha/entrega",
  confirmed: "confirmado pelo RH",
  pending: "por confirmar",
  rejected: "desmarcado pelo RH",
};

const ms = (v: string | Date | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : toMs(v);
  return Number.isFinite(n) ? n : null;
};

// ─── Leituras do GPS (Zello) ────────────────────────────────────────────────

export type ReadingState = "inside" | "outside" | "no_gps";

/** Uma posição do Zello (location/get). */
export interface ZelloReading {
  lat: number | null | undefined;
  lng: number | null | undefined;
  accuracy?: number | null;
  /** segundos desde o último relatório do aparelho */
  lastReportDelay?: number | null;
  /** instante do último relatório (segundos, epoch), se o Zello o der */
  lastReportSec?: number | null;
}

export interface ClassifiedReading {
  state: ReadingState;
  /** instante da posição (ms); null sem GPS */
  fixAtMs: number | null;
  /** distância ao centro da zona mais perto (m) */
  distanceM: number | null;
}

/**
 * Classifica uma leitura do Zello para a cidade da sessão:
 *  - sem leitura, GPS velho (> TERMINAL_GPS_STALE_S), "0,0", imprecisão acima de
 *    TERMINAL_MAX_ACCURACY_M → "no_gps" (nunca "fora");
 *  - distância − imprecisão ≤ raio → "inside"; senão "outside".
 * PURA.
 */
export function classifyReading(r: ZelloReading | null | undefined, fence: AirportFence | null | undefined, nowMs: number): ClassifiedReading {
  const none: ClassifiedReading = { state: "no_gps", fixAtMs: null, distanceM: null };
  if (!r || !fence) return none;
  // Instante da posição: o mais antigo entre "agora − atraso" e o instante do
  // relatório (quando o Zello dá os dois). Nenhum dos dois → não se sabe a idade → sem GPS.
  const delay = r.lastReportDelay == null ? NaN : Number(r.lastReportDelay);
  const reportSec = r.lastReportSec == null ? NaN : Number(r.lastReportSec);
  const byDelay = Number.isFinite(delay) && delay >= 0 ? nowMs - delay * 1000 : NaN;
  const byReport = Number.isFinite(reportSec) && reportSec > 0 ? reportSec * 1000 : NaN;
  const candidates = [byDelay, byReport].filter((x) => Number.isFinite(x));
  if (!candidates.length) return none;
  const fixAtMs = Math.floor(Math.min(...candidates) / 1000) * 1000;
  if (fixAtMs > nowMs + MIN) return none; // relógio do aparelho no futuro: não prova nada
  if (nowMs - fixAtMs > TERMINAL_GPS_STALE_S * 1000) return none; // GPS velho = sem GPS
  const v = validFix({ lat: r.lat, lng: r.lng, accuracy: r.accuracy ?? null });
  if (!v || v.accuracy > TERMINAL_MAX_ACCURACY_M) return none;
  const g = gpsInAirport(v, fence);
  return { state: g.inside ? "inside" : "outside", fixAtMs, distanceM: Number.isFinite(g.distanceM) ? Math.round(g.distanceM) : null };
}

/** O que a sessão guarda sobre o GPS (instantes em ms). */
export interface WatchState {
  startedAtMs: number;
  lastInsideAtMs: number | null;
  outsideSinceMs: number | null;
  outsideCount: number;
  lastFixAtMs: number | null;
}

/** O que se grava na sessão depois de uma leitura (texto UTC da BD). */
export interface WatchPatch {
  lastCheckAt: string;
  lastFixState: ReadingState;
  lastFixDistanceM?: number | null;
  lastFixAt?: string;
  lastInsideAt?: string;
  outsideSince?: string | null;
  outsideCount?: number;
}

/**
 * Próximo estado depois de uma leitura. Regras:
 *  - "sem GPS" não muda nada (nem conta como fora);
 *  - a mesma leitura outra vez (o Zello ainda não mandou nova posição) ou uma
 *    leitura anterior ao início da sessão não contam;
 *  - dentro → último GPS dentro = a hora da leitura; "fora" volta a zero;
 *  - fora → conta mais uma se a anterior também foi fora há ≤ 15 min; senão
 *    recomeça (fora desde = a hora desta leitura).
 * PURA.
 */
export function nextWatch(s: WatchState, r: ClassifiedReading, nowMs: number): { patch: WatchPatch; state: WatchState; newReading: boolean } {
  const base: WatchPatch = { lastCheckAt: toDbUtc(nowMs), lastFixState: r.state, lastFixDistanceM: r.distanceM };
  if (r.state === "no_gps" || r.fixAtMs == null) return { patch: { lastCheckAt: base.lastCheckAt, lastFixState: "no_gps" }, state: s, newReading: false };
  const stale = s.lastFixAtMs != null && r.fixAtMs <= s.lastFixAtMs;
  if (stale || r.fixAtMs < s.startedAtMs) return { patch: { lastCheckAt: base.lastCheckAt, lastFixState: r.state, lastFixDistanceM: r.distanceM }, state: s, newReading: false };
  if (r.state === "inside") {
    const last = Math.max(s.lastInsideAtMs ?? -Infinity, r.fixAtMs);
    const state: WatchState = { ...s, lastInsideAtMs: last, outsideSinceMs: null, outsideCount: 0, lastFixAtMs: r.fixAtMs };
    return { patch: { ...base, lastFixAt: toDbUtc(r.fixAtMs), lastInsideAt: toDbUtc(last), outsideSince: null, outsideCount: 0 }, state, newReading: true };
  }
  const followsOutside = s.outsideCount > 0 && s.outsideSinceMs != null && s.lastFixAtMs != null
    && r.fixAtMs - s.lastFixAtMs <= TERMINAL_READINGS_GAP_MAX_MIN * MIN;
  const outsideSinceMs = followsOutside ? s.outsideSinceMs! : r.fixAtMs;
  const outsideCount = followsOutside ? s.outsideCount + 1 : 1;
  const state: WatchState = { ...s, outsideSinceMs, outsideCount, lastFixAtMs: r.fixAtMs };
  return { patch: { ...base, lastFixAt: toDbUtc(r.fixAtMs), outsideSince: toDbUtc(outsideSinceMs), outsideCount }, state, newReading: true };
}

// ─── Pergunta, resposta e libertação ────────────────────────────────────────

export interface AskState {
  outsideSinceMs: number | null;
  outsideCount: number;
  askedAtMs: number | null;
  stillHereAtMs: number | null;
  /** instante da última leitura válida (para não perguntar com GPS velho) */
  lastFixAtMs?: number | null;
}

/** "Fora" confirmado: 2 leituras seguidas fora. PURA. */
export function outsideConfirmed(s: Pick<AskState, "outsideSinceMs" | "outsideCount">): boolean {
  return s.outsideSinceMs != null && s.outsideCount >= TERMINAL_OUTSIDE_READINGS;
}

/**
 * Há uma pergunta à espera de resposta? Feita durante ESTE "fora" e ainda sem
 * "Sim, estou" depois dela. (Voltar ao aeroporto apaga o "fora" e responde por
 * si.) PURA.
 */
export function questionOpen(s: AskState): boolean {
  if (s.askedAtMs == null || s.outsideSinceMs == null) return false;
  if (s.askedAtMs < s.outsideSinceMs) return false;
  return s.stillHereAtMs == null || s.stillHereAtMs < s.askedAtMs;
}

/**
 * O que o vigia faz agora a uma sessão aberta: perguntar, libertar ou nada.
 *  - pergunta à espera há ≥ 15 min sem "Sim" → libertar;
 *  - "fora" confirmado há ≥ 20 min, com a última leitura ainda fresca (GPS
 *    velho = sem GPS, nunca "fora"), sem "Sim" nos últimos 60 min → perguntar.
 * PURA.
 */
export function watchDecision(s: AskState, nowMs: number): "ask" | "release" | null {
  if (questionOpen(s)) return nowMs - s.askedAtMs! >= TERMINAL_NO_ANSWER_MIN * MIN ? "release" : null;
  if (!outsideConfirmed(s)) return null;
  if (s.lastFixAtMs == null || nowMs - s.lastFixAtMs > TERMINAL_GPS_STALE_S * 1000) return null;
  if (nowMs - s.outsideSinceMs! < TERMINAL_ASK_AFTER_MIN * MIN) return null;
  if (s.stillHereAtMs != null && nowMs - s.stillHereAtMs < TERMINAL_STILL_HERE_QUIET_MIN * MIN) return null;
  return "ask";
}

/** "saiu do aeroporto às 16:40 (GPS)". PURA. */
export function leftAirportNote(outsideSince: string | Date | number | null | undefined): string {
  const t = ms(outsideSince);
  return t == null ? "saiu do aeroporto (GPS)" : `saiu do aeroporto às ${lisbonClock(new Date(t))} (GPS)`;
}

/** A última sessão foi libertada por falta de resposta há ≤ 30 min? → pode reabrir sem buraco. PURA. */
export function reopenWindow(last: { endReason: TerminalEndReason | string | null; endedAt: string | null } | null | undefined, nowMs: number): { ok: boolean; untilMs: number | null } {
  if (!last || last.endReason !== "no_answer") return { ok: false, untilMs: null };
  const end = ms(last.endedAt);
  if (end == null) return { ok: false, untilMs: null };
  const until = end + TERMINAL_REOPEN_MIN * MIN;
  return { ok: nowMs <= until, untilMs: until };
}

// ─── Horas que contam ───────────────────────────────────────────────────────

export interface CountingInput {
  startedAt: string | Date | number;
  /** início do que conta quando não é o início (reabertura sem prova) */
  countedFrom?: string | Date | number | null;
  endedAt: string | Date | number;
  /** GPS do fecho: dentro (true), fora (false), sem GPS (null) */
  insideAtClose: boolean | null;
  /** fecho que não prova nada (ponto esquecido fechado sozinho, saída cortada) */
  forgotten?: boolean;
  lastInsideAt?: string | Date | number | null;
  outsideSince?: string | Date | number | null;
  outsideCount?: number | null;
  /** última recolha/entrega dele (Multipark), se lida */
  lastServiceAt?: string | Date | number | null;
}

/** Até onde a última recolha/entrega pode contar: o "fora" confirmado (ou o fecho). PURA. */
export function serviceCap(o: Pick<CountingInput, "endedAt" | "outsideSince" | "outsideCount">): number {
  const end = ms(o.endedAt)!;
  const out = ms(o.outsideSince);
  if (out != null && outsideConfirmed({ outsideSinceMs: out, outsideCount: Number(o.outsideCount ?? 0) })) return Math.min(out, end);
  return end;
}

/**
 * Horas que contam de uma sessão fechada (regra de 7 out). PURA.
 *  1. fecho com GPS dentro (e não esquecido) → até ao fecho, "gps_close";
 *  2. senão o maior entre o último GPS dentro e a última recolha/entrega (esta
 *     só até ao "fora" confirmado), se depois do início → "last_gps" /
 *     "last_service";
 *  3. senão "pending".
 */
export function countedAtClose(o: CountingInput): { countedUntil: string | null; countedBasis: TerminalCountedBasis } {
  const end = ms(o.endedAt);
  const start = ms(o.countedFrom) ?? ms(o.startedAt);
  if (end == null || start == null) return { countedUntil: null, countedBasis: "pending" };
  if (o.insideAtClose === true && !o.forgotten && end > start) return { countedUntil: toDbUtc(end), countedBasis: "gps_close" };
  let best: number | null = null;
  let basis: TerminalCountedBasis = "pending";
  const gps = ms(o.lastInsideAt);
  if (gps != null && gps > start) { best = Math.min(gps, end); basis = "last_gps"; }
  const svc = ms(o.lastServiceAt);
  if (svc != null && svc > start && svc <= serviceCap(o) && (best == null || svc > best)) { best = svc; basis = "last_service"; }
  if (best == null || best <= start) return { countedUntil: null, countedBasis: "pending" };
  return { countedUntil: toDbUtc(best), countedBasis: basis };
}

/** Uma prova nova melhora o que já conta? (nunca por cima do RH nem do fecho no aeroporto). PURA. */
export function improvesCounted(cur: { countedBasis: string | null; countedUntil: string | null }, next: { countedBasis: TerminalCountedBasis; countedUntil: string | null }): boolean {
  if (!next.countedUntil || next.countedBasis === "pending") return false;
  if (!["pending", "last_gps", "last_service"].includes(String(cur.countedBasis ?? "pending"))) return false;
  const a = ms(cur.countedUntil), b = ms(next.countedUntil);
  return b != null && (a == null || b > a);
}

/** "Ainda estou" sem prova: o fim da sessão ficou por provar e há uma resposta "Sim" (o RH vê). PURA. */
export function claimUnproven(s: { stillHereAt?: string | null; startSource?: TerminalStartSource | string | null; endedAt?: string | null; countedUntil?: string | null; countedBasis?: string | null }): boolean {
  if (!s.endedAt || s.countedBasis === "confirmed" || s.countedBasis === "rejected" || s.countedBasis === "gps_close") return false;
  const claimed = s.stillHereAt != null || s.startSource === "reopen";
  if (!claimed) return false;
  const until = ms(s.countedUntil), end = ms(s.endedAt);
  return until == null || (end != null && until < end);
}

// ─── Pagamento: interseção com o turno do ponto ─────────────────────────────

/** O que o ordenado precisa de cada sessão. */
export interface TerminalPaySessionLike {
  startedAt: string;
  countedFrom?: string | null;
  countedUntil?: string | null;
  countedBasis?: string | null;
  endedAt?: string | null;
  /** 1 = extra (nível +1) */
  payUplift?: number | boolean | null;
}

type Interval = [number, number];

function merge(list: Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** a ∖ b (intervalos já juntos). */
function subtract(a: Interval[], b: Interval[]): Interval[] {
  let cur = a.map((x): Interval => [x[0], x[1]]);
  for (const [c, d] of b) {
    const next: Interval[] = [];
    for (const [x, y] of cur) {
      if (d <= x || c >= y) { next.push([x, y]); continue; }
      if (c > x) next.push([x, c]);
      if (d < y) next.push([d, y]);
    }
    cur = next;
  }
  return cur;
}

function overlapMs(window: Interval, list: Interval[]): number {
  let t = 0;
  for (const [a, b] of list) t += Math.max(0, Math.min(b, window[1]) - Math.max(a, window[0]));
  return t;
}

/** Intervalos que pagam (base paga, até ao countedUntil) e por confirmar, só das sessões com nível +1. PURA. */
export function terminalPayIntervals(sessions: ReadonlyArray<TerminalPaySessionLike> | null | undefined): { paid: Interval[]; pending: Interval[] } {
  const paid: Interval[] = [], pending: Interval[] = [];
  for (const s of sessions ?? []) {
    if (!(s.payUplift === true || Number(s.payUplift) === 1)) continue;
    const from = ms(s.countedFrom) ?? ms(s.startedAt);
    if (from == null) continue;
    if (isPaidBasis(s.countedBasis)) {
      const until = ms(s.countedUntil);
      if (until != null && until > from) paid.push([from, until]);
    } else if (s.countedBasis === "pending") {
      const end = ms(s.endedAt);
      if (end != null && end > from) pending.push([from, end]);
    }
  }
  return { paid: merge(paid), pending: merge(pending) };
}

/**
 * Horas de terminal de um turno do ponto a partir das sessões (interseção com
 * o turno, até ao `countedUntil`, só bases que pagam). O turno conta até à
 * entrada + horas pagas (horas corrigidas/cortadas encurtam-no). Nunca mais do
 * que as horas do turno. `pendingHours` = horas do turno em sessões por
 * confirmar (não pagam). PURA.
 */
export function sessionHoursInShift(shift: { inAt: string | Date | null | undefined; outAt?: string | Date | null; hours: number }, sessions: ReadonlyArray<TerminalPaySessionLike> | null | undefined): { terminalHours: number; pendingHours: number } {
  const hours = Math.max(0, Number(shift.hours) || 0);
  const inMs = ms(shift.inAt ?? null);
  if (inMs == null || hours <= 0 || !sessions?.length) return { terminalHours: 0, pendingHours: 0 };
  const outMs = ms(shift.outAt ?? null);
  const endMs = Math.min(inMs + hours * 3_600_000, outMs ?? Infinity);
  if (!(endMs > inMs)) return { terminalHours: 0, pendingHours: 0 };
  const { paid, pending } = terminalPayIntervals(sessions);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const t = Math.min(hours, overlapMs([inMs, endMs], paid) / 3_600_000);
  // por confirmar: só a parte que não está já paga
  const p = Math.max(0, Math.min(hours - t, overlapMs([inMs, endMs], subtract(pending, paid)) / 3_600_000));
  return { terminalHours: r2(t), pendingHours: r2(p) };
}

// ─── RH: sem sobreposição na mesma cidade ───────────────────────────────────

export interface OverlapSession {
  id: number;
  employeeId: number;
  cityKey: string;
  startedAt: string;
  endedAt: string | null;
  countedFrom?: string | null;
  countedUntil?: string | null;
  countedBasis?: string | null;
}

/** O intervalo que uma sessão ocupa: o tempo em que esteve no lugar e o que conta (o maior). Desmarcadas não ocupam. PURA. */
export function occupiedInterval(s: OverlapSession, nowMs: number): Interval | null {
  if (s.countedBasis === "rejected") return null;
  const a = ms(s.startedAt);
  if (a == null) return null;
  const b = ms(s.endedAt) ?? nowMs;
  const cf = ms(s.countedFrom), cu = isPaidBasis(s.countedBasis) ? ms(s.countedUntil) : null;
  return [Math.min(a, cf ?? a), Math.max(b, cu ?? b)];
}

/**
 * O RH confirma/corrige a sessão `id` para [from, until]: não pode sobrepor
 * outra sessão da mesma cidade (duas pessoas no terminal ao mesmo tempo) nem
 * outra sessão da mesma pessoa. Devolve a primeira em conflito, ou null. PURA.
 */
export function overlapConflict(target: { id: number; employeeId: number; cityKey: string; fromMs: number; untilMs: number }, others: ReadonlyArray<OverlapSession>, nowMs: number): OverlapSession | null {
  for (const o of others) {
    if (o.id === target.id) continue;
    if (o.cityKey !== target.cityKey && o.employeeId !== target.employeeId) continue;
    const iv = occupiedInterval(o, nowMs);
    if (iv && target.fromMs < iv[1] && iv[0] < target.untilMs) return o;
  }
  return null;
}

// ─── Linha do tempo do dia (Resumo do dia) ──────────────────────────────────

export interface TimelineSessionLike {
  id: number;
  employeeId: number;
  name: string;
  startedAt: string;
  endedAt: string | null;
  startSource: string;
  endReason: string | null;
  countedFrom?: string | null;
  countedUntil: string | null;
  countedBasis: string | null;
  endNote?: string | null;
}

export type TimelineItem =
  | { kind: "session"; session: TimelineSessionLike; fromMs: number; toMs: number; open: boolean }
  | { kind: "gap"; fromMs: number; toMs: number; label: string };

/** Buracos mais curtos do que isto não aparecem (trocas no mesmo minuto). */
export const TERMINAL_GAP_MIN_MINUTES = 1;

/**
 * Linha do tempo de uma cidade num dia operacional: as sessões por ordem e os
 * buracos ENTRE elas ("terminal vazio 12:10–12:40"). Antes da primeira e
 * depois da última não é buraco (ninguém estava escalado para o terminal).
 * Sessões a cavalo da janela entram cortadas à janela. PURA.
 */
export function cityDayTimeline(sessions: ReadonlyArray<TimelineSessionLike>, windowStartMs: number, windowEndMs: number, nowMs: number): TimelineItem[] {
  const end = Math.min(windowEndMs, nowMs);
  const items = sessions
    .map((s) => {
      const a = ms(s.startedAt);
      const b = ms(s.endedAt) ?? nowMs;
      return a == null ? null : { s, a: Math.max(a, windowStartMs), b: Math.min(b, end), open: s.endedAt == null };
    })
    .filter((x): x is { s: TimelineSessionLike; a: number; b: number; open: boolean } => !!x && x.b > x.a)
    .sort((x, y) => x.a - y.a);
  const out: TimelineItem[] = [];
  let reach: number | null = null;
  for (const it of items) {
    if (reach != null && it.a - reach >= TERMINAL_GAP_MIN_MINUTES * MIN) {
      out.push({ kind: "gap", fromMs: reach, toMs: it.a, label: `terminal vazio ${lisbonClock(new Date(reach))}–${lisbonClock(new Date(it.a))}` });
    }
    out.push({ kind: "session", session: it.s, fromMs: it.a, toMs: it.b, open: it.open });
    reach = reach == null ? it.b : Math.max(reach, it.b);
  }
  return out;
}

/** "contou até 16:40 (último GPS no aeroporto)" / "por confirmar" / "a decorrer". PURA. */
export function countedLabel(s: { endedAt: string | null; countedUntil: string | null; countedBasis: string | null }): string {
  if (!s.endedAt) return "a decorrer";
  const basis = (s.countedBasis ?? "pending") as TerminalCountedBasis;
  if (basis === "pending") return "por confirmar";
  if (basis === "rejected") return "desmarcado pelo RH";
  const hm = s.countedUntil ? lisbonClock(s.countedUntil) : "";
  return `contou até ${hm || "?"} (${TERMINAL_BASIS_LABELS[basis] ?? basis})`;
}

// ─── RH: corrigir as horas (de–a, em hora de Lisboa) ────────────────────────

/**
 * "Das 14:05 às 17:20" (hora de Lisboa) perto do troço → UTC da BD. "Das" é
 * a ocorrência dessa hora mais perto do início do troço (o próprio dia, a
 * véspera ou o dia seguinte — troços à volta da meia-noite); se a hora de fim
 * for antes da de início, é no dia seguinte. null = hora inválida. PURA.
 */
export function correctionRange(startedAt: string, fromHHMM: string, untilHHMM: string): { from: string; until: string } | null {
  const p = (t: string) => {
    const m = String(t ?? "").trim().match(/^(\d{1,2})[:h](\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    return h > 23 || mi > 59 ? null : h + mi / 60;
  };
  const a = p(fromHHMM), b = p(untilHHMM);
  const start = ms(startedAt);
  if (a == null || b == null || start == null) return null;
  // "Das" é a hora mais perto do início do troço (no dia dele, na véspera ou no
  // dia seguinte): um troço das 23:50 corrigido para "00:10" é na madrugada
  // SEGUINTE, não 24 h antes; um das 00:20 corrigido para "23:50" é a véspera.
  const day0 = lisbonDayOf(start);
  let day = day0, fromMs = lisbonWallTimeUtcMs(day0, a);
  for (const d of [addDays(day0, -1), addDays(day0, 1)]) {
    const t = lisbonWallTimeUtcMs(d, a);
    if (Math.abs(t - start) < Math.abs(fromMs - start)) { day = d; fromMs = t; }
  }
  let untilMs = lisbonWallTimeUtcMs(day, b);
  if (untilMs <= fromMs) untilMs = lisbonWallTimeUtcMs(addDays(day, 1), b);
  return { from: toDbUtc(fromMs), until: toDbUtc(untilMs) };
}

// ─── Definições: zonas por terminal × parques ───────────────────────────────

export interface ParkPoint { projectId: number; name: string; lat: number; lng: number }

/**
 * Parques (centros de custos com raio de picagem) cujo centro cai dentro de
 * uma zona de terminal: aí o GPS "no aeroporto" também apanharia quem está no
 * parque. Para o aviso no editor (a validação final é do Jorge). PURA.
 */
export function parksInsideZones(airports: Partial<Record<string, AirportFence>>, parks: ReadonlyArray<ParkPoint>): Array<{ city: string; zone: string | null; park: string; distanceM: number }> {
  const out: Array<{ city: string; zone: string | null; park: string; distanceM: number }> = [];
  for (const [city, fence] of Object.entries(airports)) {
    if (!fence) continue;
    for (const p of parks) {
      const g = gpsInAirport({ lat: p.lat, lng: p.lng, accuracy: 0 }, fence);
      if (g.inside) out.push({ city, zone: g.zone, park: p.name, distanceM: Math.round(g.distanceM) });
    }
  }
  return out;
}
