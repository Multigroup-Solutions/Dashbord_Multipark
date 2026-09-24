/**
 * Motor da avaliação — parte com BD.
 *
 *  - `recomputeRange(start, end)`: lê as fontes (ações Multipark, ponto,
 *    escala, ocorrências, reclamações, alertas de velocidade, penalizações),
 *    calcula (evaluationCore) e grava em `employee_day_metrics` (upsert +
 *    limpeza das linhas desse intervalo que deixaram de existir).
 *  - `runEvaluationRecompute`: o cron diário — últimas 4 semanas, em fatias
 *    de 7 dias dentro do prazo (done/nextOffset, como o multipark-future).
 *  - `loadEvaluatedDays`: lê os dias guardados + ajustes manuais por cima
 *    (nunca gravados no calculado) + pontuação por regra + por hora.
 *  - ajustes e contestações.
 *
 * SQL parametrizado; sem GROUP BY (agregação em JS) e sem subqueries sobre a
 * própria tabela (erro 1093).
 */
import { and, desc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  employeeDayMetrics,
  employeeMetricAdjustments,
  employeeMetricDisputes,
  employees,
} from "../drizzle/schema";
import { employeeScope } from "./cityScope";
import { computeEmployeeDays, type EmployeeDayRow, type EngineEmployee, type EngineOutput } from "./evaluationCore";
import { loadEvaluationIdentity } from "./evaluationIdentity";
import {
  METRIC_KEYS,
  RANKING_POSITIONS,
  RECOMPUTE_WINDOW_DAYS,
  applyAdjustments,
  emptyDayMetrics,
  perHourMetrics,
  round2,
  scoreOf,
  type DayMetrics,
  type PerHourMetrics,
  type Score,
} from "../shared/evaluationRules";
import { addDays, operationalDayOf, operationalDayRangeUtc } from "../shared/lisbonDay";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r) as any[]) ?? [];
const toUtcStr = (v: any): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace("T", " ");
  return String(v).slice(0, 19).replace("T", " ");
};
const mysqlStamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Dia operacional de "agora" (antes das 03h de Lisboa ainda é o dia anterior). */
export function currentOperationalDay(now: Date = new Date()): string {
  return operationalDayOf(now.getTime());
}

// ─── Cálculo ─────────────────────────────────────────────────────────────────

/** Lê as fontes e calcula (sem gravar). */
export async function computeRange(startDay: string, endDay: string): Promise<EngineOutput> {
  if (!DAY_RE.test(startDay) || !DAY_RE.test(endDay) || endDay < startDay) throw new Error("Intervalo inválido");
  const db = await getDb();
  const empty: EngineOutput = { rows: [], unresolved: new Map() };
  if (!db) return empty;

  const range = operationalDayRangeUtc(startDay, endDay);
  // Recolhas até 3 dias antes: um "levar ao parque" pode vir de uma recolha anterior
  const lookback = mysqlStamp(range.startMs - 3 * 86_400_000);
  const pontoFrom = mysqlStamp(range.startMs - 86_400_000);
  const pontoTo = mysqlStamp(range.endMs + 86_400_000);

  const { identity } = await loadEvaluationIdentity();
  const empRows = await db.select({
    id: employees.id, position: employees.position, contractType: employees.contractType,
    extraLevel: employees.extraLevel, monthlySalary: employees.monthlySalary, projectId: employees.projectId,
  }).from(employees);
  const emps = new Map<number, EngineEmployee>(empRows.map((e) => [e.id, {
    id: e.id, position: e.position ?? null, contractType: e.contractType ?? null, extraLevel: e.extraLevel ?? null,
    monthlySalary: e.monthlySalary != null ? Number(e.monthlySalary) : null, projectId: e.projectId ?? null,
  }]));

  const [actions, ponto, assignments, incidents, speed, penalties] = await Promise.all([
    db.execute(sql`SELECT bookingExternalId, historyId, changeType, actionTime, agentUserId, agentName
                     FROM multipark_booking_history
                    WHERE actionTime >= ${lookback} AND actionTime < ${range.end}`),
    db.execute(sql`SELECT id, employeeId, type, recordedAt, hoursWorked, notes, reviewStatus
                     FROM time_records
                    WHERE recordedAt >= ${pontoFrom} AND recordedAt < ${pontoTo}`),
    db.execute(sql`SELECT assignmentDate, employeeId, personName, level, isTeamLeader, shift, city, startHour, endHour, sentHomeHour
                     FROM extras_dia_assignments
                    WHERE assignmentDate >= ${startDay} AND assignmentDate <= ${endDay}`),
    db.execute(sql`SELECT COALESCE(sourceEmailDate, createdAt) AS at, incidentType, reportedBy, employeeId, status, driverConfirmed
                     FROM incidents
                    WHERE COALESCE(sourceEmailDate, createdAt) >= ${range.start} AND COALESCE(sourceEmailDate, createdAt) < ${range.end}`),
    db.execute(sql`SELECT id, employeeId, createdAt FROM speed_alerts
                    WHERE employeeId IS NOT NULL AND createdAt >= ${range.start} AND createdAt < ${range.end}`),
    db.execute(sql`SELECT employeeId, points, reason, relatedId, createdAt FROM employee_penalties
                    WHERE status = 'confirmed' AND createdAt >= ${range.start} AND createdAt < ${range.end}`),
  ]);
  let complaintRows: any[] = [];
  try {
    complaintRows = rowsOf(await db.execute(sql`
      SELECT d.complaintId, d.employeeId, c.createdAt AS at, c.penaltyPoints, c.complaint_status AS status
        FROM complaint_drivers_on_duty d
        JOIN complaints c ON c.id = d.complaintId
       WHERE d.employeeId IS NOT NULL AND c.createdAt >= ${range.start} AND c.createdAt < ${range.end}`));
  } catch { /* tabela ainda não criada */ }

  const { loadExtraRates, rateFor } = await import("./extraRates");
  const { TL_WORKING_DAYS_PER_MONTH } = await import("./extrasDia");
  const rates = await loadExtraRates();

  return computeEmployeeDays({
    startDay, endDay, identity, employees: emps,
    actions: rowsOf(actions).map((r) => ({
      bookingExternalId: String(r.bookingExternalId), historyId: r.historyId != null ? String(r.historyId) : null,
      changeType: r.changeType ?? null, actionTime: toUtcStr(r.actionTime),
      agentUserId: r.agentUserId != null ? String(r.agentUserId) : null, agentName: r.agentName != null ? String(r.agentName) : null,
    })).filter((r) => r.actionTime),
    ponto: rowsOf(ponto).map((r) => ({
      id: Number(r.id), employeeId: Number(r.employeeId), type: r.type, recordedAt: toUtcStr(r.recordedAt),
      hoursWorked: r.hoursWorked, notes: r.notes ?? null, reviewStatus: r.reviewStatus ?? null,
    })),
    assignments: rowsOf(assignments).map((r) => ({
      assignmentDate: String(r.assignmentDate), employeeId: r.employeeId != null ? Number(r.employeeId) : null,
      personName: String(r.personName ?? ""), level: r.level ?? null, isTeamLeader: Number(r.isTeamLeader) === 1,
      shift: r.shift === "night" ? "night" : "morning", city: r.city ?? null,
      startHour: Number(r.startHour), endHour: Number(r.endHour), sentHomeHour: r.sentHomeHour != null ? Number(r.sentHomeHour) : null,
    })),
    incidents: rowsOf(incidents).map((r) => ({
      at: toUtcStr(r.at), incidentType: r.incidentType ?? null, reportedBy: r.reportedBy != null ? Number(r.reportedBy) : null,
      employeeId: r.employeeId != null ? Number(r.employeeId) : null, status: r.status ?? null,
      driverConfirmed: r.driverConfirmed != null ? Number(r.driverConfirmed) : null,
    })),
    complaints: complaintRows.map((r) => ({
      complaintId: Number(r.complaintId), employeeId: r.employeeId != null ? Number(r.employeeId) : null,
      at: toUtcStr(r.at), penaltyPoints: Number(r.penaltyPoints ?? 0), status: r.status ?? null,
    })),
    speedAlerts: rowsOf(speed).map((r) => ({ id: Number(r.id), employeeId: r.employeeId != null ? Number(r.employeeId) : null, createdAt: toUtcStr(r.createdAt) })),
    penalties: rowsOf(penalties).map((r) => ({
      employeeId: Number(r.employeeId), points: Number(r.points ?? 0), reason: String(r.reason ?? ""),
      relatedId: r.relatedId != null ? Number(r.relatedId) : null, createdAt: toUtcStr(r.createdAt),
    })),
    rate: (level) => rateFor(rates, level),
    tlWorkingDaysPerMonth: TL_WORKING_DAYS_PER_MONTH,
  });
}

function metricsRow(r: EmployeeDayRow, stamp: string) {
  const m = r.metrics;
  const s = scoreOf(m);
  return {
    employeeId: r.employeeId, day: r.day, projectId: r.projectId, city: r.city, shift: r.shift,
    isTeamLeader: r.isTeamLeader ? 1 : 0, level: r.level, hoursSource: r.hoursSource,
    hoursWorked: String(m.hoursWorked), suspiciousHours: String(m.suspiciousHours), scheduledHours: String(m.scheduledHours),
    pontoEvents: m.pontoEvents, cost: String(m.cost),
    actions: m.actions, actionsMorning: m.actionsMorning, actionsNight: m.actionsNight,
    recolhas: m.recolhas, entregas: m.entregas, movements: m.movements, parkingMoves: m.parkingMoves,
    cancels: m.cancels, otherActions: m.otherActions, weightedActions: String(m.weightedActions),
    actionsByType: JSON.stringify(r.actionsByType),
    speedingEvents: m.speedingEvents, delays: m.delays, lateServices: m.lateServices, complaints: m.complaints, accidents: m.accidents,
    incidentsReported: m.incidentsReported, incidentsAgainst: m.incidentsAgainst, penaltyPoints: m.penaltyPoints,
    positivePoints: String(s.positivePoints), negativePoints: String(s.negativePoints), totalPoints: String(s.totalPoints),
    computedAt: stamp,
  };
}

const UPSERT_COLUMNS = [
  "projectId", "city", "shift", "isTeamLeader", "level", "hoursSource", "hoursWorked", "suspiciousHours", "scheduledHours",
  "pontoEvents", "cost", "actions", "actionsMorning", "actionsNight", "recolhas", "entregas", "movements", "parkingMoves",
  "cancels", "otherActions", "weightedActions", "actionsByType", "speedingEvents", "delays", "lateServices", "complaints", "accidents",
  "incidentsReported", "incidentsAgainst", "penaltyPoints", "positivePoints", "negativePoints", "totalPoints", "computedAt",
] as const;

/** Grava as linhas de [start, end] e apaga as desse intervalo que deixaram de existir. */
export async function persistRows(rows: EmployeeDayRow[], startDay: string, endDay: string): Promise<{ written: number; removed: number }> {
  const db = await getDb();
  if (!db) return { written: 0, removed: 0 };
  const stamp = mysqlStamp(Math.floor(Date.now() / 1000) * 1000);
  const values = rows.map((r) => metricsRow(r, stamp));
  const set: Record<string, any> = {};
  for (const c of UPSERT_COLUMNS) set[c] = sql.raw(`VALUES(\`${c}\`)`);
  for (let i = 0; i < values.length; i += 200) {
    await db.insert(employeeDayMetrics).values(values.slice(i, i + 200) as any).onDuplicateKeyUpdate({ set });
  }
  const res: any = await db.delete(employeeDayMetrics).where(and(
    gte(employeeDayMetrics.day, startDay), lte(employeeDayMetrics.day, endDay), lt(employeeDayMetrics.computedAt, stamp),
  ));
  const removed = Number((Array.isArray(res) ? res[0] : res)?.affectedRows ?? 0);
  return { written: values.length, removed };
}

/** Recalcula e grava [start, end]. Devolve também as ações por ligar (operacional). */
export async function recomputeRange(startDay: string, endDay: string): Promise<EngineOutput & { written: number; removed: number }> {
  const out = await computeRange(startDay, endDay);
  const p = await persistRows(out.rows, startDay, endDay);
  return { ...out, ...p };
}

/**
 * Cron diário: recalcula as últimas 4 semanas (até hoje), em fatias de 7 dias
 * a partir de `offsetDays`, enquanto houver prazo. done:false + nextOffset →
 * o workflow chama outra vez.
 */
export async function runEvaluationRecompute(opts: { offsetDays?: number; deadlineAt: number; now?: Date }): Promise<{
  window: { start: string; end: string }; done: boolean; nextOffset: number | null; slices: Array<{ start: string; end: string; written: number; removed: number }>;
}> {
  const today = currentOperationalDay(opts.now);
  const start = addDays(today, -(RECOMPUTE_WINDOW_DAYS - 1));
  const slices: Array<{ start: string; end: string; written: number; removed: number }> = [];
  let offset = Math.max(0, opts.offsetDays ?? 0);
  while (offset < RECOMPUTE_WINDOW_DAYS) {
    if (slices.length > 0 && Date.now() > opts.deadlineAt) break;
    const s = addDays(start, offset);
    const e = addDays(start, Math.min(offset + 6, RECOMPUTE_WINDOW_DAYS - 1));
    const r = await recomputeRange(s, e);
    slices.push({ start: s, end: e, written: r.written, removed: r.removed });
    offset += 7;
  }
  const done = offset >= RECOMPUTE_WINDOW_DAYS;
  return { window: { start, end: today }, done, nextOffset: done ? null : offset, slices };
}

// ─── Leitura (com ajustes por cima) ──────────────────────────────────────────

export interface AdjustmentView {
  id: number; employeeId: number; day: string; metric: string; delta: number; reason: string;
  authorId: number | null; authorName: string | null; disputeId: number | null; createdAt: string;
  voidedAt: string | null; voidReason: string | null;
}

export interface EvaluatedDay {
  employeeId: number;
  employeeName: string;
  position: string | null;
  day: string;
  shift: string | null;
  city: string | null;
  isTeamLeader: boolean;
  hoursSource: string | null;
  actionsByType: Record<string, number>;
  computedAt: string | null;
  /** calculado (sem ajustes) */
  base: DayMetrics;
  /** calculado + ajustes */
  metrics: DayMetrics;
  score: Score;
  perHour: PerHourMetrics;
  adjustments: AdjustmentView[];
}

const num = (v: any) => (v == null ? 0 : Number(v) || 0);

function baseFromRow(r: any): DayMetrics {
  const m = emptyDayMetrics();
  for (const k of METRIC_KEYS) if (k in r) (m as any)[k] = num(r[k]);
  m.bonusPoints = 0;
  return m;
}

function adjustmentView(a: any): AdjustmentView {
  return {
    id: Number(a.id), employeeId: Number(a.employeeId), day: String(a.day), metric: String(a.metric), delta: num(a.delta),
    reason: String(a.reason ?? ""), authorId: a.authorId != null ? Number(a.authorId) : null, authorName: a.authorName ?? null,
    disputeId: a.disputeId != null ? Number(a.disputeId) : null, createdAt: toUtcStr(a.createdAt),
    voidedAt: a.voidedAt ? toUtcStr(a.voidedAt) : null, voidReason: a.voidReason ?? null,
  };
}

/**
 * Dias avaliados (com ajustes) em [start, end]. Respeita o âmbito de cidade do
 * pedido (employeeScope). `rankingOnly` = só as posições do ranking, ativas.
 */
export async function loadEvaluatedDays(opts: {
  startDay: string; endDay: string; employeeIds?: number[]; rankingOnly?: boolean; includeVoided?: boolean;
  /** Só quando `employeeIds` já vem de uma fonte com âmbito (ex.: a escala do dia, já filtrada pela cidade). */
  employeeIdsAlreadyScoped?: boolean;
}): Promise<EvaluatedDay[]> {
  const db = await getDb();
  if (!db) return [];
  if (opts.employeeIds && opts.employeeIds.length === 0) return [];
  const empFilter = opts.employeeIds ? inArray(employees.id, opts.employeeIds) : undefined;
  const scope = (col: typeof employeeDayMetrics.employeeId | typeof employeeMetricAdjustments.employeeId) =>
    opts.employeeIdsAlreadyScoped && opts.employeeIds ? undefined : employeeScope(col);
  const rankFilter = opts.rankingOnly
    ? and(eq(employees.isActive, 1), inArray(employees.position, [...RANKING_POSITIONS]))
    : undefined;

  const metricRows = await db.select({ m: employeeDayMetrics, fullName: employees.fullName, position: employees.position })
    .from(employeeDayMetrics)
    .innerJoin(employees, eq(employees.id, employeeDayMetrics.employeeId))
    .where(and(
      gte(employeeDayMetrics.day, opts.startDay), lte(employeeDayMetrics.day, opts.endDay),
      scope(employeeDayMetrics.employeeId), empFilter, rankFilter,
    ));

  const adjRows = await db.select({ a: employeeMetricAdjustments, fullName: employees.fullName, position: employees.position })
    .from(employeeMetricAdjustments)
    .innerJoin(employees, eq(employees.id, employeeMetricAdjustments.employeeId))
    .where(and(
      gte(employeeMetricAdjustments.day, opts.startDay), lte(employeeMetricAdjustments.day, opts.endDay),
      opts.includeVoided ? undefined : isNull(employeeMetricAdjustments.voidedAt),
      scope(employeeMetricAdjustments.employeeId), empFilter, rankFilter,
    ))
    .orderBy(employeeMetricAdjustments.id);

  const days = new Map<string, EvaluatedDay>();
  for (const { m, fullName, position } of metricRows) {
    let byType: Record<string, number> = {};
    try { byType = m.actionsByType ? JSON.parse(m.actionsByType) : {}; } catch { byType = {}; }
    const base = baseFromRow(m);
    days.set(`${m.employeeId}|${m.day}`, {
      employeeId: m.employeeId, employeeName: fullName, position: position ?? null, day: m.day, shift: m.shift ?? null,
      city: m.city ?? null, isTeamLeader: m.isTeamLeader === 1, hoursSource: m.hoursSource ?? null, actionsByType: byType,
      computedAt: m.computedAt ? toUtcStr(m.computedAt) : null, base, metrics: base, score: scoreOf(base),
      perHour: perHourMetrics(base), adjustments: [],
    });
  }
  for (const { a, fullName, position } of adjRows) {
    const k = `${a.employeeId}|${a.day}`;
    let d = days.get(k);
    if (!d) {
      const base = emptyDayMetrics();
      d = {
        employeeId: a.employeeId, employeeName: fullName, position: position ?? null, day: a.day, shift: null, city: null,
        isTeamLeader: false, hoursSource: null, actionsByType: {}, computedAt: null, base, metrics: base,
        score: scoreOf(base), perHour: perHourMetrics(base), adjustments: [],
      };
      days.set(k, d);
    }
    d.adjustments.push(adjustmentView(a));
  }
  for (const d of days.values()) {
    if (d.adjustments.length === 0) continue;
    d.metrics = applyAdjustments(d.base, d.adjustments);
    d.score = scoreOf(d.metrics);
    d.perHour = perHourMetrics(d.metrics, d.score);
  }
  return Array.from(days.values()).sort((a, b) => (a.day === b.day ? a.employeeName.localeCompare(b.employeeName) : a.day < b.day ? -1 : 1));
}

// ─── Ajustes ─────────────────────────────────────────────────────────────────

export async function createAdjustment(input: {
  employeeId: number; day: string; metric: string; delta: number; reason: string;
  authorId: number | null; authorName: string | null; disputeId?: number | null;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const [r] = await db.insert(employeeMetricAdjustments).values({
    employeeId: input.employeeId, day: input.day, metric: input.metric, delta: String(round2(input.delta)),
    reason: input.reason.slice(0, 500), authorId: input.authorId, authorName: input.authorName?.slice(0, 128) ?? null,
    disputeId: input.disputeId ?? null,
  }).$returningId();
  return r.id;
}

export async function getAdjustment(id: number) {
  const db = await getDb();
  if (!db) return null;
  const [r] = await db.select().from(employeeMetricAdjustments).where(eq(employeeMetricAdjustments.id, id)).limit(1);
  return r ?? null;
}

export async function voidAdjustment(id: number, byId: number, reason: string | null): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  await db.update(employeeMetricAdjustments)
    .set({ voidedAt: mysqlStamp(Date.now()), voidedById: byId, voidReason: reason?.slice(0, 255) ?? null })
    .where(and(eq(employeeMetricAdjustments.id, id), isNull(employeeMetricAdjustments.voidedAt)));
}

// ─── Contestações ────────────────────────────────────────────────────────────

export interface DisputeView {
  id: number; employeeId: number; employeeName: string | null; day: string; metric: string | null; comment: string;
  status: string; createdAt: string; resolvedByName: string | null; resolvedAt: string | null;
  resolution: string | null; adjustmentId: number | null;
}

export async function createDispute(input: { employeeId: number; day: string; metric: string | null; comment: string; userId: number }): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const [r] = await db.insert(employeeMetricDisputes).values({
    employeeId: input.employeeId, day: input.day, metric: input.metric, comment: input.comment.slice(0, 4000),
    status: "open", createdByUserId: input.userId,
  }).$returningId();
  return r.id;
}

export async function listDisputes(opts: { employeeId?: number; status?: string; startDay?: string; endDay?: string; limit?: number }): Promise<DisputeView[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ d: employeeMetricDisputes, fullName: employees.fullName })
    .from(employeeMetricDisputes)
    .innerJoin(employees, eq(employees.id, employeeMetricDisputes.employeeId))
    .where(and(
      employeeScope(employeeMetricDisputes.employeeId),
      opts.employeeId != null ? eq(employeeMetricDisputes.employeeId, opts.employeeId) : undefined,
      opts.status ? eq(employeeMetricDisputes.status, opts.status) : undefined,
      opts.startDay ? gte(employeeMetricDisputes.day, opts.startDay) : undefined,
      opts.endDay ? lte(employeeMetricDisputes.day, opts.endDay) : undefined,
    ))
    .orderBy(desc(employeeMetricDisputes.createdAt), desc(employeeMetricDisputes.id))
    .limit(opts.limit ?? 200);
  return rows.map(({ d, fullName }) => ({
    id: d.id, employeeId: d.employeeId, employeeName: fullName ?? null, day: d.day, metric: d.metric ?? null,
    comment: d.comment, status: d.status, createdAt: toUtcStr(d.createdAt), resolvedByName: d.resolvedByName ?? null,
    resolvedAt: d.resolvedAt ? toUtcStr(d.resolvedAt) : null, resolution: d.resolution ?? null, adjustmentId: d.adjustmentId ?? null,
  }));
}

export async function getDispute(id: number) {
  const db = await getDb();
  if (!db) return null;
  const [r] = await db.select().from(employeeMetricDisputes).where(eq(employeeMetricDisputes.id, id)).limit(1);
  return r ?? null;
}

/** Fecha uma contestação em aberto (guardado: só muda se ainda estiver `open`). */
export async function resolveDispute(input: {
  id: number; status: "accepted" | "rejected"; resolution: string; byId: number; byName: string | null; adjustmentId?: number | null;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const res: any = await db.update(employeeMetricDisputes).set({
    status: input.status, resolution: input.resolution.slice(0, 4000), resolvedById: input.byId,
    resolvedByName: input.byName?.slice(0, 128) ?? null, resolvedAt: mysqlStamp(Date.now()), adjustmentId: input.adjustmentId ?? null,
  }).where(and(eq(employeeMetricDisputes.id, input.id), eq(employeeMetricDisputes.status, "open")));
  return Number((Array.isArray(res) ? res[0] : res)?.affectedRows ?? 0) > 0;
}

