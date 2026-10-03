/**
 * Motor da avaliação — parte PURA (sem BD). Recebe as linhas já lidas (ações
 * das reservas, ponto, escala, ocorrências, reclamações, alertas de
 * velocidade, penalizações) e devolve as métricas por (colaborador, dia
 * operacional). As regras/pontos estão em shared/evaluationRules.ts.
 *
 * Dia operacional = D 03:00 → D+1 03:00 (Lisboa); manhã 03h–15h, noite
 * 15h–03h (shared/lisbonDay.ts). Testado em evaluationCore.test.ts.
 */
import { incidentCountsAgainstDriver } from "../shared/caseRules";
import {
  DAMAGE_INCIDENT_TYPES,
  DELAY_TOLERANCE_MINUTES,
  LATE_SERVICE_MAX_MINUTES,
  LATE_SERVICE_MINUTES,
  actionCategory,
  actionPoints,
  emptyDayMetrics,
  round2,
  type DayMetrics,
} from "../shared/evaluationRules";
import { addDays, lisbonWallTimeUtcMs, operationalDayOf, operationalSlotOf, utcMs } from "../shared/lisbonDay";
import { pontoShiftHours } from "../shared/pontoHours";
import type { EvaluationIdentity } from "./evaluationIdentity";

// ─── Ponto ───────────────────────────────────────────────────────────────────

export interface PontoRecord {
  id: number;
  employeeId: number;
  type: "check_in" | "check_out";
  recordedAt: string; // UTC "YYYY-MM-DD HH:MM:SS"
  hoursWorked?: string | number | null;
  notes?: string | null;
  reviewStatus?: string | null;
}

export interface PontoShift {
  employeeId: number;
  day: string; // dia operacional da ENTRADA
  inAt: string;
  outAt: string | null;
  hours: number;
  /** conta para as horas (fechado, ok/aprovado e sem [SUSPEITO] por rever) */
  countable: boolean;
}

/** Registo/turno marcado como suspeito (e ainda não aprovado)? Igual ao ordenado. */
export function isFlaggedPonto(rec: { notes?: string | null; reviewStatus?: string | null } | null, out?: { notes?: string | null; reviewStatus?: string | null } | null): boolean {
  const rs = out?.reviewStatus ?? rec?.reviewStatus ?? null;
  if (rs === "approved") return false;
  if (rs === "rejected" || rs === "suspicious") return true;
  return /\[SUSPEITO\]/.test(`${rec?.notes ?? ""} ${out?.notes ?? ""}`);
}

/**
 * Emparelha entradas/saídas de UM colaborador (como o ordenado): entrada →
 * saída = turno; horas do registo de saída (se houver) ou a diferença real.
 * [SUSPEITO] / suspeito / rejeitado não contam até serem aprovados.
 */
export function pairPonto(records: PontoRecord[]): PontoShift[] {
  const sorted = [...records].sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.id - b.id));
  const out: PontoShift[] = [];
  let open: PontoRecord | null = null;
  const openShift = (o: PontoRecord): PontoShift => ({ employeeId: o.employeeId, day: operationalDayOf(o.recordedAt), inAt: o.recordedAt, outAt: null, hours: 0, countable: false });
  for (const r of sorted) {
    if (r.type === "check_in") {
      if (open) out.push(openShift(open));
      open = r;
      continue;
    }
    if (!open) continue; // saída sem entrada: ignorada (como no ordenado)
    const real = Math.max(0, (utcMs(r.recordedAt) - utcMs(open.recordedAt)) / 3_600_000);
    out.push({
      employeeId: open.employeeId, day: operationalDayOf(open.recordedAt), inAt: open.recordedAt, outAt: r.recordedAt,
      // a mesma regra do ordenado (shared/pontoHours.ts)
      hours: pontoShiftHours({ inRec: open, outRec: r, realHours: real }), countable: !isFlaggedPonto(open, r),
    });
    open = null;
  }
  if (open) out.push(openShift(open));
  return out;
}

// ─── Atrasos ─────────────────────────────────────────────────────────────────

/** Instante UTC (ms) da hora da escala: `startHour` ≥ 24 é já o dia seguinte. */
export function scheduledStartUtcMs(day: string, startHour: number): number {
  const extraDays = Math.floor(startHour / 24);
  return lisbonWallTimeUtcMs(addDays(day, extraDays), startHour - extraDays * 24);
}

/**
 * Atraso: a 1.ª entrada no ponto à volta da hora da escala (de 6 h antes a
 * 12 h depois) foi depois da hora + tolerância. Sem entrada nenhuma não é
 * atraso (é falta — tratada no RH).
 */
export function isLateArrival(checkInsMs: number[], scheduledMs: number, toleranceMinutes = DELAY_TOLERANCE_MINUTES): boolean {
  const from = scheduledMs - 6 * 3_600_000, to = scheduledMs + 12 * 3_600_000;
  const first = checkInsMs.filter((t) => t >= from && t <= to).sort((a, b) => a - b)[0];
  if (first == null) return false;
  // ao minuto: 03:00:40 numa escala das 03:00 não é atraso
  return Math.floor(first / 60_000) > Math.floor((scheduledMs + toleranceMinutes * 60_000) / 60_000);
}

// ─── Ações das reservas ──────────────────────────────────────────────────────

export interface ActionRow {
  bookingExternalId: string;
  historyId?: string | null;
  changeType: string | null;
  actionTime: string; // UTC
  agentUserId: string | null;
  agentName: string | null;
}

/**
 * Índices das ações que são o 1.º MOVIMENTO depois de uma recolha (CHECK_IN)
 * na MESMA reserva — levar o carro ao parque. Uma entrega fecha o ciclo.
 */
export function markParkingMoves(rows: ActionRow[]): Set<number> {
  const byBooking = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const list = byBooking.get(r.bookingExternalId) ?? [];
    list.push(i);
    byBooking.set(r.bookingExternalId, list);
  });
  const out = new Set<number>();
  for (const idx of byBooking.values()) {
    idx.sort((a, b) => {
      const ta = utcMs(rows[a].actionTime), tb = utcMs(rows[b].actionTime);
      if (ta !== tb) return ta - tb;
      return String(rows[a].historyId ?? "").localeCompare(String(rows[b].historyId ?? ""), undefined, { numeric: true }) || a - b;
    });
    let awaitingPark = false;
    for (const i of idx) {
      const cat = actionCategory(rows[i].changeType);
      if (cat === "recolhas") awaitingPark = true;
      else if (cat === "movements") {
        if (awaitingPark) out.add(i);
        awaitingPark = false;
      } else if (cat === "entregas" || cat === "cancels") awaitingPark = false;
    }
  }
  return out;
}

/**
 * Índices das ENTREGAS atrasadas: CHECK_OUT mais de LATE_SERVICE_MINUTES
 * depois do 1.º PENDING_CHECKOUT (pedido do cliente) ainda por servir, na
 * mesma reserva. Mais de LATE_SERVICE_MAX_MINUTES = outro pedido → não conta.
 */
export function markLateDeliveries(rows: ActionRow[], thresholdMinutes = LATE_SERVICE_MINUTES): Set<number> {
  const byBooking = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const list = byBooking.get(r.bookingExternalId) ?? [];
    list.push(i);
    byBooking.set(r.bookingExternalId, list);
  });
  const out = new Set<number>();
  for (const idx of byBooking.values()) {
    idx.sort((a, b) => utcMs(rows[a].actionTime) - utcMs(rows[b].actionTime) || a - b);
    let pendingAt: number | null = null;
    for (const i of idx) {
      const type = String(rows[i].changeType ?? "").trim().toUpperCase();
      const t = utcMs(rows[i].actionTime);
      if (type === "PENDING_CHECKOUT") {
        if (pendingAt == null) pendingAt = t;
      } else if (actionCategory(type) === "entregas") {
        if (pendingAt != null) {
          const mins = (t - pendingAt) / 60_000;
          if (mins > thresholdMinutes && mins < LATE_SERVICE_MAX_MINUTES) out.add(i);
        }
        pendingAt = null;
      }
    }
  }
  return out;
}

/**
 * Ações agregadas por (agente, dia operacional, turno, tipo) — a forma em que
 * chegam da BD da Multipark. `parkingMoves`/`lateDeliveries` = quantas dessas
 * `n` ações foram "levar ao parque" / entregas atrasadas.
 */
export interface ActionCountRow {
  agentUserId: string | null;
  agentName: string | null;
  day: string;
  shift: "morning" | "night";
  changeType: string;
  n: number;
  parkingMoves: number;
  lateDeliveries: number;
}

export interface AgentOccurrenceCount {
  agentUserId: string | null;
  agentName: string | null;
  day: string;
  n: number;
}

/**
 * Linhas soltas → contagens (mesmas regras: markParkingMoves e
 * markLateDeliveries sobre TODAS as linhas, incluindo as de antes do
 * intervalo). PURA.
 */
export function actionRowsToCounts(rows: ActionRow[]): ActionCountRow[] {
  const parking = markParkingMoves(rows);
  const late = markLateDeliveries(rows);
  const out = new Map<string, ActionCountRow>();
  rows.forEach((a, i) => {
    const slot = operationalSlotOf(a.actionTime);
    const type = String(a.changeType ?? "?").toUpperCase();
    const k = `${a.agentUserId ?? ""}|${a.agentName ?? ""}|${slot.day}|${slot.shift}|${type}`;
    let c = out.get(k);
    if (!c) {
      c = { agentUserId: a.agentUserId, agentName: a.agentName, day: slot.day, shift: slot.shift, changeType: type, n: 0, parkingMoves: 0, lateDeliveries: 0 };
      out.set(k, c);
    }
    c.n += 1;
    if (parking.has(i)) c.parkingMoves += 1;
    if (late.has(i)) c.lateDeliveries += 1;
  });
  return Array.from(out.values());
}

// ─── Entradas do motor ───────────────────────────────────────────────────────

export interface EngineAssignment {
  assignmentDate: string;
  employeeId: number | null;
  personName: string;
  level: string | null;
  isTeamLeader: boolean;
  shift: "morning" | "night";
  city: string | null;
  startHour: number;
  endHour: number;
  sentHomeHour: number | null;
}

export interface EngineEmployee {
  id: number;
  position: string | null;
  contractType: string | null;
  extraLevel: number | null;
  monthlySalary: number | null;
  projectId: number | null;
}

export interface EngineIncident {
  at: string; // COALESCE(sourceEmailDate, createdAt)
  incidentType: string | null;
  reportedBy: number | null;
  employeeId: number | null;
  status: string | null;
  driverConfirmed: number | null;
}

/** Colaborador associado a uma reclamação (complaint_drivers_on_duty). */
export interface EngineComplaint {
  complaintId: number;
  employeeId: number | null;
  at: string;
  /** pontos aplicados à reclamação (> 0 = confirmada) */
  penaltyPoints: number;
  status: string | null;
}

export interface EngineSpeedAlert { id?: number; employeeId: number | null; createdAt: string }
/** Acidente confirmado pelo TL (evaluation_accidents ativo, D15): conta no dia operacional da ocorrência. */
export interface EngineConfirmedAccident { employeeId: number; day: string }
export interface EnginePenalty { employeeId: number; points: number; reason: string; relatedId: number | null; createdAt: string }

export interface EngineInput {
  startDay: string;
  endDay: string;
  identity: EvaluationIdentity;
  employees: Map<number, EngineEmployee>;
  /** Ações soltas (cópia local multipark_booking_history). */
  actions: ActionRow[];
  /** Ações já agregadas (BD da Multipark ao vivo). Somam às soltas. */
  actionCounts?: ActionCountRow[];
  /** Ocorrências criadas na app Multipark, por agente e dia operacional. */
  agentOccurrences?: AgentOccurrenceCount[];
  ponto: PontoRecord[];
  assignments: EngineAssignment[];
  incidents: EngineIncident[];
  complaints: EngineComplaint[];
  speedAlerts: EngineSpeedAlert[];
  penalties: EnginePenalty[];
  /** Acidentes confirmados (ocorrências Multipark + quem conduzia). */
  confirmedAccidents?: EngineConfirmedAccident[];
  /**
   * Reclamações confirmadas e alertas de velocidade a que as penalizações do
   * período apontam, de QUALQUER data ("empregado|id"): já contam no dia deles
   * (noutra fatia do recálculo), por isso a penalização não os conta outra vez.
   */
  relatedCountedElsewhere?: { complaints: string[]; speedAlerts: string[] };
  /** €/hora por nível (extraRates.rateFor) */
  rate: (level: string | number | null) => number;
  /** dias do TL por mês (custo diário = salário / isto) */
  tlWorkingDaysPerMonth: number;
}

export interface EmployeeDayRow {
  employeeId: number;
  day: string;
  projectId: number | null;
  city: string | null;
  shift: "morning" | "night" | null;
  isTeamLeader: boolean;
  level: string | null;
  hoursSource: "ponto" | "escala" | null;
  actionsByType: Record<string, number>;
  metrics: DayMetrics;
}

export interface UnresolvedAgentDay {
  key: string;
  name: string;
  actions: number;
  actionsMorning: number;
  actionsNight: number;
  recolhas: number;
  entregas: number;
  movements: number;
  parkingMoves: number;
  byType: Record<string, number>;
}

export interface EngineOutput {
  rows: EmployeeDayRow[];
  /** ações de agentes sem ficha, por dia (para a escala sem ficha no operacional) */
  unresolved: Map<string, Map<string, UnresolvedAgentDay>>;
}

const inRange = (d: string, a: string, b: string) => d >= a && d <= b;

/** Complaint conta como CONFIRMADA? (pontos aplicados e não convertida). */
export function complaintIsConfirmed(c: { penaltyPoints: number; status: string | null }): boolean {
  return Number(c.penaltyPoints) > 0 && c.status !== "converted";
}

/** Ocorrência conta como acidente/dano contra o condutor? */
export function incidentIsAccident(i: { incidentType: string | null; employeeId?: number | null; driverConfirmed?: number | null; status?: string | null }): boolean {
  return DAMAGE_INCIDENT_TYPES.includes(String(i.incidentType ?? "")) && incidentCountsAgainstDriver(i);
}

/** Calcula as métricas por (colaborador, dia operacional) em [startDay, endDay]. */
export function computeEmployeeDays(input: EngineInput): EngineOutput {
  const { startDay, endDay, identity } = input;
  const rows = new Map<string, EmployeeDayRow>();
  const unresolved = new Map<string, Map<string, UnresolvedAgentDay>>();
  const row = (employeeId: number, day: string): EmployeeDayRow => {
    const k = `${employeeId}|${day}`;
    let r = rows.get(k);
    if (!r) {
      const emp = input.employees.get(employeeId);
      r = {
        employeeId, day, projectId: emp?.projectId ?? null, city: null, shift: null, isTeamLeader: false,
        level: null, hoursSource: null, actionsByType: {}, metrics: emptyDayMetrics(),
      };
      rows.set(k, r);
    }
    return r;
  };

  // ── Ações (dia/turno operacional; 1.º movimento após recolha pela reserva).
  // Linhas soltas (cópia local) → contagens; as contagens já vêm agregadas
  // da BD da Multipark (server/multiparkDb/movements.ts) com as mesmas regras.
  const counts = [...actionRowsToCounts(input.actions), ...(input.actionCounts ?? [])];
  for (const a of counts) {
    if (!inRange(a.day, startDay, endDay) || a.n <= 0) continue;
    const who = identity.agent(a.agentUserId, a.agentName);
    if (who.kind === "ignorado") continue;
    const type = String(a.changeType ?? "?").toUpperCase();
    const cat = actionCategory(type);
    const target = who.kind === "colaborador"
      ? (() => {
          const r = row(who.employeeId, a.day);
          r.actionsByType[type] = (r.actionsByType[type] ?? 0) + a.n;
          if (a.lateDeliveries > 0) { r.metrics.lateServices += a.lateDeliveries; r.metrics.delays += a.lateDeliveries; }
          return r.metrics;
        })()
      : (() => {
          let byDay = unresolved.get(a.day);
          if (!byDay) { byDay = new Map(); unresolved.set(a.day, byDay); }
          let u = byDay.get(who.key);
          if (!u) { u = { key: who.key, name: who.name, actions: 0, actionsMorning: 0, actionsNight: 0, recolhas: 0, entregas: 0, movements: 0, parkingMoves: 0, byType: {} }; byDay.set(who.key, u); }
          u.byType[type] = (u.byType[type] ?? 0) + a.n;
          return u;
        })();
    target.actions += a.n;
    if (a.shift === "morning") target.actionsMorning += a.n; else target.actionsNight += a.n;
    if (cat === "recolhas" || cat === "entregas" || cat === "movements") target[cat] += a.n;
    else if (who.kind === "colaborador") (target as DayMetrics)[cat] += a.n;
    if (a.parkingMoves > 0) target.parkingMoves += a.parkingMoves;
  }

  // ── Ocorrências criadas na app Multipark pelo agente (informativo)
  for (const o of input.agentOccurrences ?? []) {
    if (!inRange(o.day, startDay, endDay) || o.n <= 0) continue;
    const who = identity.agent(o.agentUserId, o.agentName);
    if (who.kind === "colaborador") row(who.employeeId, o.day).metrics.incidentsReported += o.n;
  }

  // ── Ponto (turnos pela ENTRADA; [SUSPEITO] fora das horas)
  const byEmp = new Map<number, PontoRecord[]>();
  for (const p of input.ponto) {
    const list = byEmp.get(p.employeeId) ?? [];
    list.push(p);
    byEmp.set(p.employeeId, list);
    const d = operationalDayOf(p.recordedAt);
    if (inRange(d, startDay, endDay)) row(p.employeeId, d).metrics.pontoEvents += 1;
  }
  for (const list of byEmp.values()) {
    for (const s of pairPonto(list)) {
      if (!inRange(s.day, startDay, endDay) || s.outAt == null) continue;
      const m = row(s.employeeId, s.day).metrics;
      if (s.countable) m.hoursWorked = round2(m.hoursWorked + s.hours);
      else m.suspiciousHours = round2(m.suspiciousHours + s.hours);
    }
  }
  const checkInsByEmp = new Map<number, number[]>();
  for (const [emp, list] of byEmp) checkInsByEmp.set(emp, list.filter((p) => p.type === "check_in").map((p) => utcMs(p.recordedAt)));

  // ── Escala (extras-dia): horas, custo e atrasos
  const scheduleCost = new Map<string, number>();
  const tlCost = new Map<string, number>();
  for (const a of input.assignments) {
    if (!inRange(a.assignmentDate, startDay, endDay)) continue;
    const who = identity.assignment({ employeeId: a.employeeId, personName: a.personName });
    if (who.employeeId == null) continue;
    const r = row(who.employeeId, a.assignmentDate);
    const hours = Math.max(0, (a.sentHomeHour ?? a.endHour) - a.startHour);
    r.metrics.scheduledHours = round2(r.metrics.scheduledHours + hours);
    r.shift = r.shift ?? a.shift;
    r.city = r.city ?? a.city;
    r.level = r.level ?? a.level;
    const k = `${who.employeeId}|${a.assignmentDate}`;
    if (a.isTeamLeader) {
      r.isTeamLeader = true;
      const salary = input.employees.get(who.employeeId)?.monthlySalary ?? 0;
      if (salary > 0) tlCost.set(k, salary / input.tlWorkingDaysPerMonth);
    } else if (a.level) {
      scheduleCost.set(k, (scheduleCost.get(k) ?? 0) + hours * input.rate(a.level));
    }
    if (isLateArrival(checkInsByEmp.get(who.employeeId) ?? [], scheduledStartUtcMs(a.assignmentDate, a.startHour))) {
      r.metrics.delays += 1;
    }
  }

  // ── Ocorrências (acidentes/danos + informativos)
  for (const i of input.incidents) {
    const d = operationalDayOf(i.at);
    if (!inRange(d, startDay, endDay)) continue;
    const reporter = identity.user(i.reportedBy);
    if (reporter != null) row(reporter, d).metrics.incidentsReported += 1;
    if (i.employeeId && incidentCountsAgainstDriver(i)) {
      const m = row(i.employeeId, d).metrics;
      m.incidentsAgainst += 1;
      if (incidentIsAccident(i)) m.accidents += 1;
    }
  }

  // ── Acidentes confirmados pelo TL nas ocorrências da app Multipark (D15)
  for (const a of input.confirmedAccidents ?? []) {
    if (!a.employeeId || !inRange(a.day, startDay, endDay)) continue;
    const m = row(a.employeeId, a.day).metrics;
    m.incidentsAgainst += 1;
    m.accidents += 1;
  }

  // ── Reclamações confirmadas (uma por reclamação e colaborador)
  const seenComplaint = new Set<string>();
  for (const c of input.complaints) {
    if (!c.employeeId || !complaintIsConfirmed(c)) continue;
    const key = `${c.employeeId}|${c.complaintId}`;
    if (seenComplaint.has(key)) continue;
    seenComplaint.add(key);
    const d = operationalDayOf(c.at);
    if (inRange(d, startDay, endDay)) row(c.employeeId, d).metrics.complaints += 1;
  }

  // ── Excessos de velocidade: alertas (speed_alerts) + penalizações RH de
  // velocidade confirmadas (a que aponta para um alerta já contado não repete).
  // Os "excessos" do GPS Zello são PONTOS acima do limite, não eventos — não contam.
  const alertIds = new Set<string>();
  for (const s of input.speedAlerts) {
    if (!s.employeeId) continue;
    if (s.id != null) alertIds.add(`${s.employeeId}|${s.id}`);
    const d = operationalDayOf(s.createdAt);
    if (inRange(d, startDay, endDay)) row(s.employeeId, d).metrics.speedingEvents += 1;
  }

  // ── Penalizações RH confirmadas (informativo; as de reclamação contam como
  // reclamação e as de velocidade como excesso de velocidade)
  const elsewhereComplaints = new Set(input.relatedCountedElsewhere?.complaints ?? []);
  const elsewhereAlerts = new Set(input.relatedCountedElsewhere?.speedAlerts ?? []);
  for (const p of input.penalties) {
    const d = operationalDayOf(p.createdAt);
    if (!inRange(d, startDay, endDay)) continue;
    const m = row(p.employeeId, d).metrics;
    m.penaltyPoints += Number(p.points) || 0;
    const relKey = p.relatedId != null ? `${p.employeeId}|${p.relatedId}` : null;
    if (p.reason === "speeding" && !(relKey && (alertIds.has(relKey) || elsewhereAlerts.has(relKey)))) m.speedingEvents += 1;
    if (p.reason === "complaint_investigation") {
      const key = relKey ?? `${p.employeeId}|p${p.createdAt}`;
      if (!seenComplaint.has(key) && !elsewhereComplaints.has(key)) { seenComplaint.add(key); m.complaints += 1; }
    }
  }

  // ── Derivadas: pontos das ações, origem das horas, custo
  for (const r of rows.values()) {
    const m = r.metrics;
    m.weightedActions = actionPoints(m);
    r.hoursSource = m.hoursWorked > 0 ? "ponto" : m.scheduledHours > 0 ? "escala" : null;
    const emp = input.employees.get(r.employeeId);
    const isExtra = emp?.position === "extra" || emp?.contractType === "extra";
    const k = `${r.employeeId}|${r.day}`;
    let cost = tlCost.get(k) ?? 0;
    // extras recebem pelo PONTO; sem ponto, a escala estima o custo
    if (isExtra && m.hoursWorked > 0) cost += m.hoursWorked * input.rate(emp?.extraLevel ?? r.level ?? null);
    else cost += scheduleCost.get(k) ?? 0;
    m.cost = round2(cost);
  }

  return {
    rows: Array.from(rows.values()).sort((a, b) => (a.day === b.day ? a.employeeId - b.employeeId : a.day < b.day ? -1 : 1)),
    unresolved,
  };
}
