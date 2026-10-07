/**
 * Custo dos EXTRAS — fonte única para o motor financeiro (Faturação/Anual) e
 * para as Reservas & Operações (custo de extras por dia × cidade).
 *
 * Regras (as do motor, extraídas sem mudar o resultado dele):
 *   - REAL: horas dos check_out do PONTO × tarifa do nível (`extra_rates`),
 *     só extras (contrato/posição "extra"), só registos ok/aprovados e não
 *     suspeitos; cidade = centro de custos (projectId) da ficha do extra;
 *   - PREVISTO: escala do Extras Dia (`extras_dia_assignments`), horas do turno
 *     (saída antecipada respeitada) × tarifa; cidade = a da escala;
 *     team leaders EXCLUÍDOS (o salário mensal já os paga);
 *   - o que "conta": real até hoje, previsto só nos dias futuros;
 *   - terminal (aeroporto, interruptor PONTO_TERMINAL, `opts.terminal`): as
 *     horas de terminal do troço pagam à taxa do nível SEGUINTE e o resto à
 *     dele — a mesma regra do ordenado (shared/pontoTerminal.ts
 *     terminalSplitOfShift): troço todo terminal, ou "partial" (saída fora do
 *     aeroporto) só da entrada até à última recolha/entrega. Desligado → igual.
 */
import { and, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { employees, extrasDiaAssignments, timeRecords } from "../../drizzle/schema";
import { rateFor, type ExtraRates } from "../extraRates";
import { matchCityKey, type CityKey } from "../../shared/city";
import * as R from "./rules";
import { normalizeExtraLevel, terminalLevelOf, terminalSplitOfShift } from "../../shared/pontoTerminal";

export interface ExtrasAssignmentRow { date: string; city: string | null; level: string | null; isTeamLeader: number | boolean | null; startHour: number; endHour: number; sentHomeHour: number | null }
export interface ExtrasPontoRow {
  recordedAt: string | null; hours: unknown; level: number | null; employeeId: number; projectId: number | null; terminalStatus?: string | null;
  /** 0575 — "partial": o terminal conta até aqui (UTC) */
  terminalUntil?: string | null;
  /** "partial": a entrada do troço (UTC), lida só nesses */
  shiftInAt?: string | null;
}

export interface ExtrasCostQuery {
  from: string; to: string;
  /** limites do ponto em UTC (por omissão `${from} 00:00:00`…`${to} 23:59:59`, como o motor) */
  pontoRange?: { start: string; endExclusive: string };
  projectIds?: number[];
  /** cidades da escala (lisbon|porto|faro) */
  cities?: string[] | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadExtrasCostRows(db: any, q: ExtrasCostQuery): Promise<{ assignments: ExtrasAssignmentRow[]; ponto: ExtrasPontoRow[] }> {
  const extrasConds: any[] = [gte(extrasDiaAssignments.assignmentDate, q.from), lte(extrasDiaAssignments.assignmentDate, q.to)];
  if (q.cities) extrasConds.push(q.cities.length ? inArray(extrasDiaAssignments.city, q.cities) : sql`1 = 0`);
  const assignments = await db
    .select({ date: extrasDiaAssignments.assignmentDate, city: extrasDiaAssignments.city, level: extrasDiaAssignments.level, isTeamLeader: extrasDiaAssignments.isTeamLeader, startHour: extrasDiaAssignments.startHour, endHour: extrasDiaAssignments.endHour, sentHomeHour: extrasDiaAssignments.sentHomeHour })
    .from(extrasDiaAssignments)
    .where(and(...extrasConds));

  const pontoConds: any[] = [
    eq(timeRecords.type, "check_out"),
    ...(q.pontoRange
      ? [gte(timeRecords.recordedAt, q.pontoRange.start), lt(timeRecords.recordedAt, q.pontoRange.endExclusive)]
      : [gte(timeRecords.recordedAt, `${q.from} 00:00:00`), lte(timeRecords.recordedAt, `${q.to} 23:59:59`)]),
    or(eq(employees.contractType, "extra"), eq(employees.position, "extra")),
    // como no ordenado (payroll/shifts countableShifts): aprovado conta sempre;
    // "ok" só sem [SUSPEITO] nas notas; suspeitos/rejeitados não pagam
    or(
      eq(timeRecords.reviewStatus, "approved"),
      and(eq(timeRecords.reviewStatus, "ok"), sql`COALESCE(${timeRecords.notes}, '') NOT LIKE '%[SUSPEITO]%'`),
    ),
  ];
  if (q.projectIds) pontoConds.push(q.projectIds.length ? inArray(employees.projectId, q.projectIds) : sql`1 = 0`);
  // "partial" (terminal até à última recolha/entrega): precisa da entrada do
  // troço — a última entrada antes desta saída (só nesses registos).
  const shiftInAt = sql<string | null>`CASE WHEN ${timeRecords.terminalStatus} = 'partial' THEN (SELECT DATE_FORMAT(MAX(ti.recordedAt), '%Y-%m-%d %H:%i:%s') FROM time_records ti WHERE ti.employeeId = ${timeRecords.employeeId} AND ti.type = 'check_in' AND ti.recordedAt < ${timeRecords.recordedAt}) END`;
  const ponto = await db
    .select({ recordedAt: timeRecords.recordedAt, hours: timeRecords.hoursWorked, level: employees.extraLevel, employeeId: timeRecords.employeeId, projectId: employees.projectId, terminalStatus: timeRecords.terminalStatus, terminalUntil: timeRecords.terminalUntil, shiftInAt })
    .from(timeRecords)
    .innerJoin(employees, eq(employees.id, timeRecords.employeeId))
    .where(and(...pontoConds));
  return { assignments, ponto };
}

type LevelAgg = { level: string; hours: number; headcount: number; cost: number };
const LEVEL_BY_NUMBER: Record<number, string> = { 1: "junior", 2: "senior", 3: "terminal", 4: "master" };

/** Agrega (PURO) as linhas em mapas por dia, por dia × cidade e por nível. */
export function aggregateExtrasCost(
  rows: { assignments: ExtrasAssignmentRow[]; ponto: ExtrasPontoRow[] },
  rates: ExtraRates,
  opts: { dayOfRecord: (recordedAt: string | null) => string; cityOfProject: (projectId: number | null) => CityKey | null; terminal?: boolean },
) {
  const plannedByDay = new Map<string, number>();
  const realByDay = new Map<string, number>();
  /** `${day}|${city ?? ""}` → { real, planned } */
  const byDayCity = new Map<string, { day: string; city: CityKey | null; real: number; planned: number }>();
  const plannedByLevel = new Map<string, LevelAgg>();
  const realByLevel = new Map<string, LevelAgg>();
  /** `${day}|${projectId ?? ""}` → custo REAL (ponto) por dia × centro da ficha do extra */
  const realByDayProject = new Map<string, { day: string; projectId: number | null; cost: number }>();
  const realPeople = new Map<string, Set<number>>();
  let teamLeaderShifts = 0;
  const cell = (day: string, city: CityKey | null) => {
    const k = `${day}|${city ?? ""}`;
    let c = byDayCity.get(k);
    if (!c) { c = { day, city, real: 0, planned: 0 }; byDayCity.set(k, c); }
    return c;
  };

  for (const r of rows.assignments) {
    if (r.isTeamLeader) { teamLeaderShifts++; continue; }  // salário mensal já paga o team leader
    const hours = R.shiftHours(r.startHour, r.endHour, r.sentHomeHour);
    const cost = hours * rateFor(rates, r.level);
    if (cost) plannedByDay.set(r.date, (plannedByDay.get(r.date) ?? 0) + cost);
    cell(r.date, matchCityKey(r.city)).planned += cost;
    const lv = String(r.level ?? "junior");
    const ex = plannedByLevel.get(lv) ?? { level: lv, hours: 0, headcount: 0, cost: 0 };
    ex.hours += hours; ex.headcount += 1; ex.cost += cost;
    plannedByLevel.set(lv, ex);
  }
  for (const r of rows.ponto) {
    const hours = Number(r.hours ?? 0) || 0;
    if (hours <= 0) continue;
    const lvName = LEVEL_BY_NUMBER[Number(r.level ?? 1)] ?? "junior";
    // terminal: as horas de terminal do troço pagam ao nível seguinte e o resto
    // ao dele (mesma regra do ordenado: terminalSplitOfShift; "partial" divide-se)
    const part = terminalSplitOfShift({ hours, terminalStatus: r.terminalStatus, terminalUntil: r.terminalUntil, inAt: r.shiftInAt }, !!opts.terminal);
    const tLevel = terminalLevelOf(r.level ?? 1);
    const tName = tLevel === normalizeExtraLevel(r.level ?? 1) ? lvName : LEVEL_BY_NUMBER[tLevel];
    const cost = part.normalHours * rateFor(rates, lvName) + (part.terminalHours > 0 ? part.terminalHours * rateFor(rates, tName) : 0);
    const day = opts.dayOfRecord(r.recordedAt);
    if (cost) {
      realByDay.set(day, (realByDay.get(day) ?? 0) + cost);
      const k = `${day}|${r.projectId ?? ""}`;
      const dp = realByDayProject.get(k) ?? { day, projectId: r.projectId ?? null, cost: 0 };
      dp.cost += cost;
      realByDayProject.set(k, dp);
    }
    cell(day, opts.cityOfProject(r.projectId)).real += cost;
    const ex = realByLevel.get(lvName) ?? { level: lvName, hours: 0, headcount: 0, cost: 0 };
    ex.hours += hours; ex.cost += cost;
    realByLevel.set(lvName, ex);
    const people = realPeople.get(lvName) ?? new Set<number>(); people.add(r.employeeId); realPeople.set(lvName, people);
  }
  for (const [lv, ppl] of realPeople) realByLevel.get(lv)!.headcount = ppl.size;
  return { plannedByDay, realByDay, realByDayProject, byDayCity, plannedByLevel, realByLevel, teamLeaderShifts };
}

/** O custo que conta num dia: real até hoje (inclusive), previsto depois. */
export function countedExtrasCost(day: string, today: string, real: number, planned: number): number {
  return day <= today ? real : planned;
}
