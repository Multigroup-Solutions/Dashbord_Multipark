/**
 * Resumo do dia da Passagem de turno (Jorge, 12 out 2026) — regras PURAS,
 * usadas no servidor e no ecrã (testes em server/resumoDia.test.ts):
 *
 *  1. `dayTimings` — entregas (pendente → entregue) e recolhas (feita vs
 *     prevista) do dia operacional: as MESMAS regras dos cartões de cima,
 *     agora com a reserva e quem fez cada uma.
 *  2. `teamLines` — a equipa de cada chefe de turno, com a regra do
 *     Desempenho (42c): o turno dele na escala (mesmo dia, cidade e turno),
 *     sem os TL. Quantas recolhas e entregas a tempo e atrasadas, com os
 *     mesmos limites dos cartões (entregas >15/>30 min, recolhas >15 min).
 *  3. `deliveryPairs` + `deliveryContext` — o que se passava na mesma cidade
 *     enquanto uma entrega lenta esperava (pedidos à espera, quem entregou).
 *  4. `shiftWindowsFor` + `gpsWindowStats` — o GPS dentro de uma janela:
 *     tempo parado no TURNO (picagens; sem elas, a escala) e a velocidade
 *     máxima numa entrega, com as regras da recolha (shared/gpsRules.ts).
 */
import { MAX_PLAUSIBLE_KMH, MAX_SEGMENT_GAP_S, STOPPED_SPEED_KMH } from "./gpsRules";
import { lisbonHoursSince, utcMs } from "./lisbonDay";
import { lisbonLocalTimeUtcMs } from "./shiftHandover";
import { matchKey } from "./textKey";

/** Entrega "atrasada" (pendente → entregue), como no cartão "Entregas >15/>30 min". */
export const DELIVERY_LATE_MIN = 15;
export const DELIVERY_VERY_LATE_MIN = 30;
/** Recolha atrasada face à entrada prevista, como no cartão "Recolhas atrasadas >15min". */
export const PICKUP_LATE_MIN = 15;
/** Acima de 10 h não é a mesma operação (pendente→entrega e desvio da recolha). */
export const TIMING_MAX_MIN = 600;

// ─── 1. Entregas e recolhas do dia ──────────────────────────────────────────

/** Uma linha do histórico da reserva ("History" da Multipark, ao vivo). Instantes UTC "YYYY-MM-DD HH:MM:SS". */
export interface DayHistRow {
  bookingExternalId: string;
  changeType: string | null;
  actionTime: string | null;
  agentName: string | null;
  agentUserId?: string | null;
  /** entrada prevista da reserva */
  checkIn?: string | null;
  /** saída prevista da reserva */
  checkOut?: string | null;
  bookingCode?: string | null;
  licensePlate?: string | null;
  parkName?: string | null;
  city?: string | null;
  bookingStatus?: string | null;
}

export interface BookingMeta {
  bookingCode: string | null;
  plate: string | null;
  parkName: string | null;
  city: string | null;
  status: string | null;
  plannedIn: string | null;
  plannedOut: string | null;
}

function metaOf(r: DayHistRow): BookingMeta {
  return {
    bookingCode: r.bookingCode ?? null, plate: r.licensePlate ?? null, parkName: r.parkName ?? null,
    city: r.city ?? null, status: r.bookingStatus ?? null, plannedIn: r.checkIn ?? null, plannedOut: r.checkOut ?? null,
  };
}

/** Completa o que falta (as linhas da mesma reserva trazem os mesmos dados; uma vazia não apaga). */
function fillMeta(m: BookingMeta, r: DayHistRow): void {
  const n = metaOf(r);
  for (const k of Object.keys(n) as Array<keyof BookingMeta>) if (m[k] == null && n[k] != null) m[k] = n[k];
}

export interface DeliveryRecord extends BookingMeta {
  booking: string;
  pendingAt: string;
  deliveredAt: string;
  mins: number;
  /** quem entregou (o CHECK_OUT) */
  agent: string | null;
  agentUserId: string | null;
}
export interface CheckoutRecord extends BookingMeta { booking: string; at: string; agent: string | null; agentUserId: string | null }
export interface PickupRecord extends BookingMeta {
  booking: string;
  at: string;
  planned: string | null;
  /** minutos depois (+) ou antes (−) da entrada prevista; null sem previsão ou fora das 10 h */
  delayMins: number | null;
  agent: string | null;
  agentUserId: string | null;
}

/**
 * Entregas e recolhas do dia operacional [start, end):
 *  - entrega MEDIDA: 1.º PENDING_CHECKOUT no dia → 1.º CHECK_OUT (até
 *    `checkoutEnd`, 10 h depois do fim do dia), se vier depois do pendente e
 *    em menos de 10 h;
 *  - entrega SEM MEDIDA: o 1.º CHECK_OUT do dia de uma reserva sem pendente
 *    medido (conta para o total da equipa, não para os tempos);
 *  - recolha: 1.º CHECK_IN do dia vs entrada PREVISTA (±10 h).
 * São as regras de sempre dos cartões (server/db.ts → supervisorTimings). PURA.
 */
export function dayTimings(
  rows: readonly DayHistRow[],
  w: { start: string; end: string; checkoutEnd: string },
): { deliveries: DeliveryRecord[]; unmeasured: CheckoutRecord[]; pickups: PickupRecord[] } {
  const meta = new Map<string, BookingMeta>();
  const pend = new Map<string, string>();
  const out = new Map<string, { t: string; agent: string | null; agentUserId: string | null }>();
  const cin = new Map<string, { t: string; planned: string | null; agent: string | null; agentUserId: string | null }>();
  for (const r of rows) {
    const t = r.actionTime; const b = r.bookingExternalId;
    if (!t || !b) continue;
    const m = meta.get(b);
    if (m) fillMeta(m, r); else meta.set(b, metaOf(r));
    const ct = (r.changeType ?? "").toUpperCase();
    if (ct === "PENDING_CHECKOUT" && t >= w.start && t < w.end) { if (!pend.has(b) || t < pend.get(b)!) pend.set(b, t); }
    else if (ct === "CHECK_OUT" && t >= w.start && t < w.checkoutEnd) {
      const e = out.get(b);
      if (!e || t < e.t) out.set(b, { t, agent: r.agentName ?? e?.agent ?? null, agentUserId: r.agentUserId ?? e?.agentUserId ?? null });
    } else if (ct === "CHECK_IN" && t >= w.start && t < w.end) {
      if (!cin.has(b) || t < cin.get(b)!.t) cin.set(b, { t, planned: r.checkIn ?? null, agent: r.agentName ?? null, agentUserId: r.agentUserId ?? null });
    }
  }
  const deliveries: DeliveryRecord[] = [];
  const measured = new Set<string>();
  for (const [b, t1] of pend) {
    const o = out.get(b);
    if (!o || o.t < t1) continue;
    const mins = Math.floor((utcMs(o.t) - utcMs(t1)) / 60_000);
    if (mins < TIMING_MAX_MIN) {
      deliveries.push({ ...meta.get(b)!, booking: b, pendingAt: t1, deliveredAt: o.t, mins, agent: o.agent, agentUserId: o.agentUserId });
      measured.add(b);
    }
  }
  const unmeasured: CheckoutRecord[] = [];
  for (const [b, o] of out) {
    if (measured.has(b) || o.t >= w.end) continue;
    unmeasured.push({ ...meta.get(b)!, booking: b, at: o.t, agent: o.agent, agentUserId: o.agentUserId });
  }
  const pickups: PickupRecord[] = [];
  for (const [b, c] of cin) {
    let delay: number | null = null;
    if (c.planned) {
      const mins = Math.trunc((utcMs(c.t) - utcMs(c.planned)) / 60_000);
      if (Number.isFinite(mins) && Math.abs(mins) < TIMING_MAX_MIN) delay = mins;
    }
    pickups.push({ ...meta.get(b)!, booking: b, at: c.t, planned: c.planned, delayMins: delay, agent: c.agent, agentUserId: c.agentUserId });
  }
  return { deliveries, unmeasured, pickups };
}

/** Cor da entrega pelos minutos (a mesma dos cartões). PURA. */
export function deliveryBand(mins: number | null | undefined): "ok" | "late" | "very_late" | null {
  if (mins == null) return null;
  return mins > DELIVERY_VERY_LATE_MIN ? "very_late" : mins > DELIVERY_LATE_MIN ? "late" : "ok";
}

// ─── 2. Equipas por chefe de turno (regra 42c) ──────────────────────────────

export interface RosterEntry {
  employeeId: number | null;
  personName: string;
  shift: "morning" | "night";
  city: string;
  isTeamLeader: boolean | number | null;
  startHour: number;
  endHour: number;
  sentHomeHour?: number | null;
}
/** Quem fez a ação: a ficha (ou, sem ficha ligada, o nome). */
export interface ActorRef { employeeId: number | null; name: string | null }

export interface DeliveryTally { count: number; measured: number; onTime: number; over15: number; over30: number }
export interface PickupTally { count: number; measured: number; onTime: number; late: number }
export interface TeamLine {
  shift: "morning" | "night";
  city: string;
  /** o chefe de turno da escala (null: turno sem TL escalado) */
  tl: { employeeId: number | null; name: string } | null;
  /** quem está na equipa (a escala do turno sem os TL) */
  members: string[];
  deliveries: DeliveryTally;
  pickups: PickupTally;
  /** o que o próprio TL fez (fica de fora da equipa, como no Desempenho) */
  tlOwn: { deliveries: number; pickups: number };
}

const isTL = (r: Pick<RosterEntry, "isTeamLeader">) => r.isTeamLeader === true || Number(r.isTeamLeader) === 1;
const emptyDeliveries = (): DeliveryTally => ({ count: 0, measured: 0, onTime: 0, over15: 0, over30: 0 });
const emptyPickups = (): PickupTally => ({ count: 0, measured: 0, onTime: 0, late: 0 });

/** Junta uma entrega aos números (os mesmos limites dos cartões). PURA. */
export function addDelivery(t: DeliveryTally, mins: number | null): void {
  t.count++;
  if (mins == null) return;
  t.measured++;
  if (mins > DELIVERY_LATE_MIN) t.over15++; else t.onTime++;
  if (mins > DELIVERY_VERY_LATE_MIN) t.over30++;
}
/** Junta uma recolha aos números. PURA. */
export function addPickup(t: PickupTally, delayMins: number | null): void {
  t.count++;
  if (delayMins == null) return;
  t.measured++;
  if (delayMins > PICKUP_LATE_MIN) t.late++; else t.onTime++;
}

/**
 * Uma linha por chefe de turno (dois TL no mesmo turno → duas linhas, com a
 * mesma equipa). Cada ação vai para o turno de quem a fez nesse dia: pela
 * ficha (ou pelo nome, se a escala não tem ficha ligada); com dois turnos no
 * mesmo dia, o que abriga a hora da ação. Quem não está na escala não conta
 * para nenhuma equipa. PURA.
 */
export function teamLines(
  date: string,
  roster: readonly RosterEntry[],
  acts: {
    deliveries: ReadonlyArray<{ actor: ActorRef; at: string; mins: number | null }>;
    pickups: ReadonlyArray<{ actor: ActorRef; at: string; delayMins: number | null }>;
  },
): TeamLine[] {
  type Group = { shift: "morning" | "night"; city: string; tls: Map<string, RosterEntry>; members: RosterEntry[]; d: DeliveryTally; p: PickupTally; own: Map<string, { deliveries: number; pickups: number }> };
  type Slot = { group: Group; key: string; tl: boolean; from: number; to: number };
  const personKey = (r: Pick<RosterEntry, "employeeId" | "personName">) => (r.employeeId != null ? `e:${r.employeeId}` : `n:${matchKey(r.personName)}`);
  const groups = new Map<string, Group>();
  const slots = new Map<string, Slot[]>();
  for (const r of roster) {
    const gk = `${r.shift}|${r.city}`;
    let g = groups.get(gk);
    if (!g) { g = { shift: r.shift, city: r.city, tls: new Map(), members: [], d: emptyDeliveries(), p: emptyPickups(), own: new Map() }; groups.set(gk, g); }
    const key = personKey(r);
    const tl = isTL(r);
    if (tl) { if (!g.tls.has(key)) { g.tls.set(key, r); g.own.set(key, { deliveries: 0, pickups: 0 }); } }
    else g.members.push(r);
    if (key === "n:") continue;
    slots.set(key, [...(slots.get(key) ?? []), { group: g, key, tl, from: r.startHour, to: r.sentHomeHour ?? r.endHour }]);
  }
  const slotFor = (actor: ActorRef, at: string): Slot | null => {
    const cands = (actor.employeeId != null ? slots.get(`e:${actor.employeeId}`) : undefined)
      ?? (actor.name && matchKey(actor.name) ? slots.get(`n:${matchKey(actor.name)}`) : undefined);
    if (!cands?.length) return null;
    const h = lisbonHoursSince(date, at);
    return cands.find((s) => h >= s.from - 1 && h <= s.to + 1) ?? cands[0];
  };
  for (const d of acts.deliveries) {
    const s = slotFor(d.actor, d.at);
    if (!s) continue;
    if (s.tl) s.group.own.get(s.key)!.deliveries++;
    else addDelivery(s.group.d, d.mins);
  }
  for (const p of acts.pickups) {
    const s = slotFor(p.actor, p.at);
    if (!s) continue;
    if (s.tl) s.group.own.get(s.key)!.pickups++;
    else addPickup(s.group.p, p.delayMins);
  }
  const out: TeamLine[] = [];
  for (const g of groups.values()) {
    const members = Array.from(new Set(g.members.map((m) => m.personName.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, "pt"));
    const base = { shift: g.shift, city: g.city, members, deliveries: { ...g.d }, pickups: { ...g.p } };
    if (!g.tls.size) { out.push({ ...base, tl: null, tlOwn: { deliveries: 0, pickups: 0 } }); continue; }
    for (const [key, tl] of g.tls) out.push({ ...base, tl: { employeeId: tl.employeeId, name: tl.personName }, tlOwn: { ...g.own.get(key)! } });
  }
  return out.sort((a, b) => (a.shift === b.shift ? 0 : a.shift === "morning" ? -1 : 1) || a.city.localeCompare(b.city) || (a.tl?.name ?? "").localeCompare(b.tl?.name ?? "", "pt"));
}

// ─── 3. O que se passava enquanto uma entrega esperava ──────────────────────

/** Um pedido de entrega de uma reserva: pendente → pegou (a fazer check-out) → entregue. */
export interface DeliveryPair extends BookingMeta {
  booking: string;
  pendingAt: string | null;
  pendingBy: string | null;
  takenAt: string | null;
  takenBy: string | null;
  deliveredAt: string | null;
  deliveredBy: string | null;
  /** pendente → entregue (null sem pendente ou ainda por entregar) */
  mins: number | null;
}

const minsBetween = (a: string, b: string) => Math.floor((utcMs(b) - utcMs(a)) / 60_000);

/**
 * Pedidos de entrega a partir do histórico (PENDING_CHECKOUT, CHECKING_OUT,
 * CHECK_OUT). Por reserva, por ordem: o 1.º pendente abre o pedido, o 1.º "a
 * fazer check-out" diz quem pegou, o CHECK_OUT fecha-o. Um CHECK_OUT sem
 * pendente aberto é uma entrega sem pedido registado. PURA.
 */
export function deliveryPairs(rows: readonly DayHistRow[]): DeliveryPair[] {
  const sorted = rows.filter((r) => r.actionTime && r.bookingExternalId)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.actionTime! < b.r.actionTime! ? -1 : a.r.actionTime! > b.r.actionTime! ? 1 : a.i - b.i))
    .map((x) => x.r);
  const open = new Map<string, DeliveryPair>();
  const out: DeliveryPair[] = [];
  const blank = (r: DayHistRow): DeliveryPair => ({ ...metaOf(r), booking: r.bookingExternalId, pendingAt: null, pendingBy: null, takenAt: null, takenBy: null, deliveredAt: null, deliveredBy: null, mins: null });
  for (const r of sorted) {
    const b = r.bookingExternalId, t = r.actionTime!;
    const ct = (r.changeType ?? "").toUpperCase();
    const cur = open.get(b);
    if (cur) fillMeta(cur, r);
    if (ct === "PENDING_CHECKOUT") {
      if (open.has(b)) continue; // pendente repetido: conta o 1.º
      const p = { ...blank(r), pendingAt: t, pendingBy: r.agentName ?? null };
      open.set(b, p); out.push(p);
    } else if (ct === "CHECKING_OUT") {
      let p = open.get(b);
      if (!p) { p = blank(r); open.set(b, p); out.push(p); }
      if (!p.takenAt) { p.takenAt = t; p.takenBy = r.agentName ?? null; }
    } else if (ct === "CHECK_OUT") {
      const p = open.get(b);
      if (p) {
        p.deliveredAt = t; p.deliveredBy = r.agentName ?? null;
        p.mins = p.pendingAt ? minsBetween(p.pendingAt, t) : null;
        open.delete(b);
      } else {
        out.push({ ...blank(r), deliveredAt: t, deliveredBy: r.agentName ?? null });
      }
    }
  }
  return out;
}

export interface DeliveryContext {
  target: DeliveryPair | null;
  /** outros pedidos da mesma cidade à espera enquanto este esperava (pela hora do pedido) */
  others: Array<DeliveryPair & { waitingBefore: boolean }>;
  /** pedidos que JÁ estavam à espera quando este ficou pendente */
  waitingWhenRequested: number;
  /** o máximo de pedidos à espera ao mesmo tempo (com este) entre o pedido e a entrega */
  peakWaiting: number;
  /** entregas feitas (na cidade, por outros pedidos) entre o pedido e a entrega deste */
  deliveredMeanwhile: number;
  /** quem as fez */
  byDriver: Array<{ name: string; count: number }>;
}

/**
 * "O que se passava nesse mesmo horário" de uma entrega: os outros pedidos da
 * MESMA cidade que estavam à espera entre o pedido (P) e a entrega (E) desta
 * — pedidos antes de E e entregues depois de P (ou ainda por entregar) —, o
 * pico de pedidos à espera e quem entregou o quê nesse intervalo. PURA.
 */
export function deliveryContext(pairs: readonly DeliveryPair[], target: { booking: string; pendingAt: string; deliveredAt: string }): DeliveryContext {
  const t = pairs.find((p) => p.booking === target.booking && p.pendingAt === target.pendingAt)
    ?? pairs.find((p) => p.booking === target.booking && p.deliveredAt === target.deliveredAt) ?? null;
  if (!t) return { target: null, others: [], waitingWhenRequested: 0, peakWaiting: 0, deliveredMeanwhile: 0, byDriver: [] };
  const P = t.pendingAt ?? target.pendingAt;
  const E = t.deliveredAt ?? target.deliveredAt;
  const city = matchKey(t.city);
  const sameCity = (p: DeliveryPair) => !city || !matchKey(p.city) || matchKey(p.city) === city;
  const others = pairs
    .filter((p) => p !== t && sameCity(p) && p.pendingAt != null && p.pendingAt < E && (p.deliveredAt == null || p.deliveredAt > P))
    .map((p) => ({ ...p, waitingBefore: p.pendingAt! < P }))
    .sort((a, b) => a.pendingAt!.localeCompare(b.pendingAt!));
  // pico: intervalos [max(pedido, P), min(entrega, E)) — a entrega sai antes de um pedido à mesma hora
  const pMs = utcMs(P), eMs = utcMs(E);
  const events: Array<[number, number]> = [];
  for (const x of [t, ...others]) {
    const s = Math.max(utcMs(x.pendingAt ?? P), pMs);
    const e = Math.min(x.deliveredAt ? utcMs(x.deliveredAt) : Number.POSITIVE_INFINITY, eMs);
    if (e <= s) continue;
    events.push([s, 1], [e, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0;
  for (const [, d] of events) { cur += d; if (cur > peak) peak = cur; }
  const meanwhile = pairs.filter((p) => p !== t && sameCity(p) && p.deliveredAt != null && p.deliveredAt >= P && p.deliveredAt <= E);
  const by = new Map<string, number>();
  for (const p of meanwhile) { const n = (p.deliveredBy ?? "").trim() || "—"; by.set(n, (by.get(n) ?? 0) + 1); }
  return {
    target: t, others,
    waitingWhenRequested: others.filter((o) => o.waitingBefore).length,
    peakWaiting: peak,
    deliveredMeanwhile: meanwhile.length,
    byDriver: [...by.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "pt")),
  };
}

// ─── 4. GPS dentro de uma janela (turno, entrega) ───────────────────────────

export interface WindowPoint { ts: number; speed: number; accurate: boolean }
export interface TimeWindow { startMs: number; endMs: number }
export interface GpsWindowStats {
  /** minutos com o Zello a reportar (troços < 1 h entre pontos) */
  minutes: number;
  movingMinutes: number;
  stoppedMinutes: number;
  maxSpeed: number;
  /** epoch s do ponto da velocidade máxima */
  maxAt: number | null;
  violations: number;
  points: number;
}

export const EMPTY_GPS_STATS: GpsWindowStats = { minutes: 0, movingMinutes: 0, stoppedMinutes: 0, maxSpeed: 0, maxAt: null, violations: 0, points: 0 };

/**
 * O GPS (pontos já ordenados) dentro das janelas, com as regras da recolha
 * (processGeoJsonHistory / splitByHolder): um troço entre dois pontos conta
 * quando os DOIS caem na mesma janela (e são da pessoa — `mine`) e estão a
 * menos de 1 h; anda se o ponto anterior ia a mais de 2 km/h, senão está
 * parado. Velocidade máxima e excessos pelo ponto (preciso, até 150 km/h;
 * excesso acima de `threshold`). PURA.
 */
export function gpsWindowStats(
  points: readonly WindowPoint[],
  windows: readonly TimeWindow[],
  o: { threshold: number | null; mine?: (tsSec: number) => boolean },
): GpsWindowStats {
  const ws = windows.filter((w) => w.endMs > w.startMs);
  const winOf = (tsSec: number) => {
    const ms = tsSec * 1000;
    for (let i = 0; i < ws.length; i++) if (ms >= ws[i].startMs && ms < ws[i].endMs) return i;
    return -1;
  };
  let moving = 0, stopped = 0, max = 0, maxAt: number | null = null, viol = 0, n = 0;
  let prev: { p: WindowPoint; w: number } | null = null;
  for (const p of points) {
    const w = winOf(p.ts);
    const inside = w >= 0 && (!o.mine || o.mine(p.ts));
    if (inside) {
      n++;
      if (p.accurate && p.speed > 0 && p.speed <= MAX_PLAUSIBLE_KMH) {
        if (p.speed > max) { max = p.speed; maxAt = p.ts; }
        if (o.threshold != null && p.speed > o.threshold) viol++;
      }
      if (prev && prev.w === w) {
        const dt = p.ts - prev.p.ts;
        if (dt > 0 && dt < MAX_SEGMENT_GAP_S) { if (prev.p.speed > STOPPED_SPEED_KMH) moving += dt; else stopped += dt; }
      }
    }
    prev = inside ? { p, w } : null;
  }
  const m = (s: number) => Math.round(s / 6) / 10;
  return { minutes: m(moving + stopped), movingMinutes: m(moving), stoppedMinutes: m(stopped), maxSpeed: Math.round(max * 100) / 100, maxAt, violations: viol, points: n };
}

/** Junta as contas de vários ficheiros do dia (PDA + telemóvel, dia e dia seguinte). PURA. */
export function mergeGpsStats(list: readonly GpsWindowStats[]): GpsWindowStats {
  const out = { ...EMPTY_GPS_STATS };
  for (const s of list) {
    out.minutes = Math.round((out.minutes + s.minutes) * 10) / 10;
    out.movingMinutes = Math.round((out.movingMinutes + s.movingMinutes) * 10) / 10;
    out.stoppedMinutes = Math.round((out.stoppedMinutes + s.stoppedMinutes) * 10) / 10;
    out.violations += s.violations;
    out.points += s.points;
    if (s.maxSpeed > out.maxSpeed) { out.maxSpeed = s.maxSpeed; out.maxAt = s.maxAt; }
  }
  return out;
}

export interface PontoMark { type: "check_in" | "check_out"; atMs: number; rejected?: boolean }
export interface RosterSpan { date: string; startHour: number; endHour: number; sentHomeHour?: number | null }
export type ShiftWindowSource = "ponto" | "escala";

/** Uma entrada até 1 h antes das 03:00 ainda é deste dia operacional. */
export const PONTO_EARLY_MS = 3_600_000;
/** Entrada sem saída: conta no máximo 16 h (ou até agora). */
export const PONTO_OPEN_MAX_MS = 16 * 3_600_000;

/**
 * As horas do TURNO de uma pessoa no dia operacional [opStart, opEnd):
 *  - as picagens (entrada → saída seguinte; entrada sem saída → até agora,
 *    no máximo 16 h; as rejeitadas não contam); só entradas deste dia (até
 *    1 h antes das 03:00);
 *  - sem picagens, a escala (início → mandado para casa / fim);
 *  - sem escala, nenhuma (quem chama fica com o dia inteiro, marcado "~"). PURA.
 */
export function shiftWindowsFor(o: {
  opStartMs: number; opEndMs: number;
  ponto: readonly PontoMark[]; roster: readonly RosterSpan[]; nowMs: number;
}): { windows: TimeWindow[]; source: ShiftWindowSource | null } {
  const marks = o.ponto.filter((m) => !m.rejected && Number.isFinite(m.atMs)).slice().sort((a, b) => a.atMs - b.atMs);
  const fromPonto: TimeWindow[] = [];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    if (m.type !== "check_in" || m.atMs < o.opStartMs - PONTO_EARLY_MS || m.atMs >= o.opEndMs - PONTO_EARLY_MS) continue;
    const next = marks[i + 1];
    const end = next?.type === "check_out"
      ? next.atMs
      : Math.min(o.nowMs, m.atMs + PONTO_OPEN_MAX_MS, next?.atMs ?? Number.POSITIVE_INFINITY);
    if (end > m.atMs) fromPonto.push({ startMs: m.atMs, endMs: end });
  }
  if (fromPonto.length) return { windows: fromPonto, source: "ponto" };
  const fromRoster = o.roster
    .map((r) => ({ startMs: lisbonLocalTimeUtcMs(r.date, r.startHour), endMs: lisbonLocalTimeUtcMs(r.date, r.sentHomeHour ?? r.endHour) }))
    .filter((w) => w.endMs > w.startMs);
  if (fromRoster.length) return { windows: fromRoster, source: "escala" };
  return { windows: [], source: null };
}
