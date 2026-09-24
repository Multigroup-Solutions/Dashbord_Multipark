/**
 * Avaliação operacional do dia: cruza a escala do /extras-dia com o motor
 * ÚNICO da avaliação (server/evaluationEngine.ts) — os mesmos números da
 * Avaliação individual (mesma identidade, mesmo ponto sem [SUSPEITO], mesmas
 * regras de pontos, mesmos ajustes manuais).
 *
 *  - Dia OPERACIONAL: manhã 03h–15h e noite 15h–03h (Lisboa) — as ações da
 *    madrugada contam para o turno da noite do dia anterior.
 *  - Por pessoa: ações por tipo, pontos das ações (regras do dono), horas
 *    (ponto; sem ponto, escala), custo, por hora.
 *  - Por Team Leader: o seu + agregado da equipa (mesmo turno).
 *  - Por turno e total do dia.
 *
 * Abrir o dia recalcula-o e grava-o (é o mesmo cálculo do cron diário).
 */
import { listAssignments } from "./extrasDia";
import { agentKeyOf, loadEvaluationIdentity, shortNameOf } from "./evaluationIdentity";
import { loadEvaluatedDays, recomputeRange } from "./evaluationEngine";
import {
  actionPoints,
  emptyDayMetrics,
  perHourMetrics,
  round2,
  scoreOf,
  type DayMetrics,
  type RuleLine,
} from "../shared/evaluationRules";

export interface PersonEvaluation {
  assignmentId: number;
  employeeId: number | null;
  personName: string;
  resolvedAgentName: string;
  isTeamLeader: boolean;
  shift: "morning" | "night";
  level: string | null;
  /** horas da escala (pagas pela escala) */
  hoursPaid: number;
  /** horas do ponto válidas (sem [SUSPEITO]) */
  hoursWorked: number;
  suspiciousHours: number;
  hoursSource: string | null;
  cost: number;
  totalActions: number;
  byType: Record<string, number>;
  recolhas: number;
  entregas: number;
  movements: number;
  parkingMoves: number;
  actionsMorning: number;
  actionsNight: number;
  /** pontos das ações (movimentos/recolhas/entregas/levar ao parque) */
  weightedActions: number;
  totalPoints: number;
  lines: RuleLine[];
  actionsPerHour: number | null;
  weightedPerHour: number | null;
  costPerAction: number; // 0 se totalActions === 0
  hasAdjustments: boolean;
  // Apenas para TLs: agregado dos seus drivers (mesmo turno)
  teamAggregate?: {
    drivers: number;
    totalActions: number;
    weightedActions: number;
    totalCost: number;
    costPerAction: number;
    byType: Record<string, number>;
  };
}

export interface ShiftEvaluation {
  shift: "morning" | "night";
  drivers: number;
  totalActions: number;
  weightedActions: number;
  totalCost: number;
  byType: Record<string, number>;
  costPerAction: number;
  tl: PersonEvaluation | null;
  members: PersonEvaluation[]; // sem TL
}

export interface DayEvaluation {
  date: string;
  shifts: ShiftEvaluation[];
  totals: {
    people: number;
    totalActions: number;
    weightedActions: number;
    totalCost: number;
    byType: Record<string, number>;
    costPerAction: number;
  };
}

const addByType = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

export async function evaluateDay(date: string): Promise<DayEvaluation> {
  const assignments = await listAssignments(date);
  if (assignments.length === 0) {
    return { date, shifts: [], totals: { people: 0, totalActions: 0, weightedActions: 0, totalCost: 0, byType: {}, costPerAction: 0 } };
  }

  // Mesmo cálculo do cron (grava o dia) + ajustes manuais por cima
  const computed = await recomputeRange(date, date);
  // Mesma identidade do motor: a linha da escala sem ficha liga-se pelo nome completo
  const { identity } = await loadEvaluationIdentity();
  const resolved = assignments.map((a) => ({ ...a, employeeId: identity.assignment({ employeeId: a.employeeId, personName: a.personName }).employeeId }));
  const empIds = Array.from(new Set(resolved.map((a) => a.employeeId).filter((x): x is number => x != null)));
  // a escala já vem filtrada pela cidade (listAssignments → cityNameScope)
  const days = await loadEvaluatedDays({ startDay: date, endDay: date, employeeIds: empIds, employeeIdsAlreadyScoped: true });
  const byEmp = new Map(days.map((d) => [d.employeeId, d]));
  const unresolved = computed.unresolved.get(date) ?? new Map();

  const used = new Set<number>(); // uma pessoa com 2 linhas na escala conta 1 vez
  const people: PersonEvaluation[] = resolved.map((a) => {
    const shortName = a.multiparkAgentName || shortNameOf(a.personName);
    let m: DayMetrics = emptyDayMetrics();
    let byType: Record<string, number> = {};
    let cost = a.cost;
    let hoursSource: string | null = null;
    let hasAdjustments = false;
    const first = a.employeeId != null && !used.has(a.employeeId);
    if (a.employeeId != null) {
      used.add(a.employeeId);
      const d = byEmp.get(a.employeeId);
      if (first && d) {
        m = d.metrics;
        byType = d.actionsByType;
        cost = d.metrics.cost;
        hoursSource = d.hoursSource;
        hasAdjustments = d.adjustments.length > 0;
      } else if (!first) {
        cost = 0; // já contada na 1.ª linha desta pessoa
      }
      // sem linha calculada (sem atividade/ponto): fica o custo da escala
    } else {
      // Sem ficha: ações do agente pelo nome curto (regra antiga do operacional)
      const u = unresolved.get(agentKeyOf(shortName));
      if (u) {
        m = { ...emptyDayMetrics(), actions: u.actions, actionsMorning: u.actionsMorning, actionsNight: u.actionsNight,
          recolhas: u.recolhas, entregas: u.entregas, movements: u.movements, parkingMoves: u.parkingMoves };
        m.weightedActions = actionPoints(m);
        byType = u.byType;
      }
      m.scheduledHours = a.hoursBilled;
      hoursSource = a.hoursBilled > 0 ? "escala" : null;
    }
    const score = scoreOf(m);
    const ph = perHourMetrics(m, score);
    return {
      assignmentId: a.id,
      employeeId: a.employeeId,
      personName: a.personName,
      resolvedAgentName: shortName,
      isTeamLeader: a.isTeamLeader,
      shift: a.shift,
      level: a.level,
      hoursPaid: a.hoursBilled,
      hoursWorked: m.hoursWorked,
      suspiciousHours: m.suspiciousHours,
      hoursSource,
      cost: round2(cost),
      totalActions: m.actions,
      byType,
      recolhas: m.recolhas,
      entregas: m.entregas,
      movements: m.movements,
      parkingMoves: m.parkingMoves,
      actionsMorning: m.actionsMorning,
      actionsNight: m.actionsNight,
      weightedActions: m.weightedActions,
      totalPoints: score.totalPoints,
      lines: score.lines,
      actionsPerHour: ph.actionsPerHour,
      weightedPerHour: ph.weightedPerHour,
      costPerAction: m.actions > 0 ? round2(cost / m.actions) : 0,
      hasAdjustments,
    };
  });

  const shifts: ShiftEvaluation[] = (["morning", "night"] as const).map((shift) => {
    const shiftPeople = people.filter((p) => p.shift === shift);
    const tl = shiftPeople.find((p) => p.isTeamLeader) ?? null;
    const drivers = shiftPeople.filter((p) => p !== tl);
    if (tl) {
      const acts = drivers.reduce((s, d) => s + d.totalActions, 0);
      const cost = drivers.reduce((s, d) => s + d.cost, 0);
      const byType: Record<string, number> = {};
      for (const d of drivers) addByType(byType, d.byType);
      tl.teamAggregate = {
        drivers: drivers.length, totalActions: acts, weightedActions: round2(drivers.reduce((s, d) => s + d.weightedActions, 0)),
        totalCost: round2(cost), costPerAction: acts > 0 ? round2(cost / acts) : 0, byType,
      };
    }
    const totalActions = shiftPeople.reduce((s, p) => s + p.totalActions, 0);
    const totalCost = round2(shiftPeople.reduce((s, p) => s + p.cost, 0));
    const byType: Record<string, number> = {};
    for (const p of shiftPeople) addByType(byType, p.byType);
    return {
      shift, drivers: shiftPeople.length, totalActions,
      weightedActions: round2(shiftPeople.reduce((s, p) => s + p.weightedActions, 0)),
      totalCost, byType, costPerAction: totalActions > 0 ? round2(totalCost / totalActions) : 0, tl, members: drivers,
    };
  });

  const dayActions = people.reduce((s, p) => s + p.totalActions, 0);
  const dayCost = round2(people.reduce((s, p) => s + p.cost, 0));
  const dayByType: Record<string, number> = {};
  for (const p of people) addByType(dayByType, p.byType);
  return {
    date,
    shifts,
    totals: {
      people: people.length,
      totalActions: dayActions,
      weightedActions: round2(people.reduce((s, p) => s + p.weightedActions, 0)),
      totalCost: dayCost,
      byType: dayByType,
      costPerAction: dayActions > 0 ? round2(dayCost / dayActions) : 0,
    },
  };
}


// O antigo "Dashboard por intervalo" (getDashboardRange) foi fundido na
// Atividade do Dia — ver server/dayActivity.ts (getActivityRange).
