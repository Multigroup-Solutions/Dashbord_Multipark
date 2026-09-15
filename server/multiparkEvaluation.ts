import { cityNameScope, bookingHistoryScope } from './cityScope';
import { extrasDiaAssignments } from "../drizzle/schema";

/**
 * Avaliação operacional do dia: cruza extras escalados em /extras-dia
 * com a actividade real registada em multipark_booking_history.
 *
 *  - Por condutor: nº de acções por changeType (CHECK_IN, CHECK_OUT,
 *    MOVEMENT, ...), total, horas pagas, custo, custo por acção
 *  - Por Team Leader: o seu próprio + agregado da sua equipa (mesmo turno)
 *  - Por turno (manhã / noite) e total do dia
 */

import { and, asc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { multiparkBookingHistory, employees } from "../drizzle/schema";
import { listAssignments } from "./extrasDia";
import { deriveShortName, DRIVER_LEVELS, TL_WORKING_DAYS_PER_MONTH } from "./extrasDia";

export interface PersonEvaluation {
  assignmentId: number;
  personName: string;
  resolvedAgentName: string;
  isTeamLeader: boolean;
  shift: "morning" | "night";
  level: string | null;
  hoursPaid: number;
  cost: number;
  totalActions: number;
  byType: Record<string, number>;
  costPerAction: number; // 0 se totalActions === 0
  // Apenas para TLs: agregado dos seus drivers (mesmo turno)
  teamAggregate?: {
    drivers: number;
    totalActions: number;
    totalCost: number;
    costPerAction: number;
    byType: Record<string, number>;
  };
}

export interface ShiftEvaluation {
  shift: "morning" | "night";
  drivers: number;
  totalActions: number;
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
    totalCost: number;
    byType: Record<string, number>;
    costPerAction: number;
  };
}

export async function evaluateDay(date: string): Promise<DayEvaluation> {
  const db = await getDb();
  if (!db) {
    return {
      date,
      shifts: [],
      totals: { people: 0, totalActions: 0, totalCost: 0, byType: {}, costPerAction: 0 },
    };
  }

  const assignments = await listAssignments(date);

  // Buscar history do dia inteiro (uma só query)
  const startStr = `${date} 00:00:00`;
  const endDate = new Date(date + "T00:00:00");
  endDate.setDate(endDate.getDate() + 1);
  const endStr = endDate.toISOString().slice(0, 19).replace("T", " ");

  const historyRows = await db
    .select({
      agentName: multiparkBookingHistory.agentName,
      changeType: multiparkBookingHistory.changeType,
    })
    .from(multiparkBookingHistory)
    .where(
      and(
        bookingHistoryScope(multiparkBookingHistory.bookingExternalId),
        gte(multiparkBookingHistory.actionTime, startStr),
        lt(multiparkBookingHistory.actionTime, endStr),
      ),
    );

  // Indexar por nome do agente (case-insensitive normalizado)
  const normalize = (s: string) => s.toLowerCase().trim();
  type Counts = { total: number; byType: Record<string, number> };
  const byAgent = new Map<string, Counts>();
  for (const h of historyRows) {
    if (!h.agentName) continue;
    const key = normalize(h.agentName);
    let c = byAgent.get(key);
    if (!c) { c = { total: 0, byType: {} }; byAgent.set(key, c); }
    c.total++;
    const ct = h.changeType ?? "?";
    c.byType[ct] = (c.byType[ct] ?? 0) + 1;
  }

  // Construir avaliações por pessoa
  const people: PersonEvaluation[] = assignments.map(a => {
    const shortName = a.multiparkAgentName || deriveShortName(a.personName);
    const counts = byAgent.get(normalize(shortName)) ?? { total: 0, byType: {} };
    return {
      assignmentId: a.id,
      personName: a.personName,
      resolvedAgentName: shortName,
      isTeamLeader: a.isTeamLeader,
      shift: a.shift,
      level: a.level,
      hoursPaid: a.hoursBilled,
      cost: a.cost,
      totalActions: counts.total,
      byType: counts.byType,
      costPerAction: counts.total > 0 ? a.cost / counts.total : 0,
    };
  });

  // Agrupar por turno
  const shifts: ShiftEvaluation[] = (["morning", "night"] as const).map(shift => {
    const shiftPeople = people.filter(p => p.shift === shift);
    const tl = shiftPeople.find(p => p.isTeamLeader) ?? null;
    const drivers = shiftPeople.filter(p => !p.isTeamLeader);

    // Team aggregate para o TL (excluindo TL)
    const driverActions = drivers.reduce((s, d) => s + d.totalActions, 0);
    const driverCost = drivers.reduce((s, d) => s + d.cost, 0);
    const driverByType: Record<string, number> = {};
    for (const d of drivers) {
      for (const [k, v] of Object.entries(d.byType)) driverByType[k] = (driverByType[k] ?? 0) + v;
    }
    if (tl) {
      tl.teamAggregate = {
        drivers: drivers.length,
        totalActions: driverActions,
        totalCost: driverCost,
        costPerAction: driverActions > 0 ? driverCost / driverActions : 0,
        byType: driverByType,
      };
    }

    // Totais do turno (incluindo TL)
    const totalActions = shiftPeople.reduce((s, p) => s + p.totalActions, 0);
    const totalCost = shiftPeople.reduce((s, p) => s + p.cost, 0);
    const byType: Record<string, number> = {};
    for (const p of shiftPeople) {
      for (const [k, v] of Object.entries(p.byType)) byType[k] = (byType[k] ?? 0) + v;
    }

    return {
      shift,
      drivers: shiftPeople.length,
      totalActions,
      totalCost,
      byType,
      costPerAction: totalActions > 0 ? totalCost / totalActions : 0,
      tl,
      members: drivers,
    };
  });

  // Totais do dia
  const dayActions = people.reduce((s, p) => s + p.totalActions, 0);
  const dayCost = people.reduce((s, p) => s + p.cost, 0);
  const dayByType: Record<string, number> = {};
  for (const p of people) {
    for (const [k, v] of Object.entries(p.byType)) dayByType[k] = (dayByType[k] ?? 0) + v;
  }

  return {
    date,
    shifts,
    totals: {
      people: people.length,
      totalActions: dayActions,
      totalCost: dayCost,
      byType: dayByType,
      costPerAction: dayActions > 0 ? dayCost / dayActions : 0,
    },
  };
}

// ─── DASHBOARD por intervalo de datas ────────────────────────────────────────

export interface DailyDashboardEntry {
  date: string;
  drivers: number;
  totalCost: number;
  totalActions: number;
  inShift: number;
  outOfShift: number;
}

export interface PersonRangeSummary {
  personName: string;
  resolvedAgentName: string;
  isTeamLeader: boolean;
  daysWorked: number;
  hoursPaid: number;
  totalCost: number;
  totalActions: number;
  inShiftActions: number;
  outOfShiftActions: number;
  byType: Record<string, number>;
  costPerAction: number;
}

export interface DashboardRange {
  startDate: string;
  endDate: string;
  daily: DailyDashboardEntry[];
  byPerson: PersonRangeSummary[];
  totals: {
    days: number;
    drivers: number;
    totalCost: number;
    totalActions: number;
    inShift: number;
    outOfShift: number;
    byType: Record<string, number>;
    costPerAction: number;
  };
}

function dateKeyFromDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function actionTimeToOffsetHours(actionTime: string, assignmentDate: string): number | null {
  // actionTime tipo "2026-06-06 07:25:00" — calcula em horas desde 00:00 do dia da escala
  if (!actionTime) return null;
  const aDate = new Date(actionTime.includes("T") ? actionTime : actionTime.replace(" ", "T"));
  if (Number.isNaN(aDate.getTime())) return null;
  const baseDate = new Date(assignmentDate + "T00:00:00");
  const diffMs = aDate.getTime() - baseDate.getTime();
  return diffMs / (60 * 60 * 1000);
}

export async function getDashboardRange(
  startDate: string,
  endDate: string,
): Promise<DashboardRange> {
  const db = await getDb();
  const empty: DashboardRange = {
    startDate,
    endDate,
    daily: [],
    byPerson: [],
    totals: {
      days: 0, drivers: 0, totalCost: 0, totalActions: 0,
      inShift: 0, outOfShift: 0, byType: {}, costPerAction: 0,
    },
  };
  if (!db) return empty;

  // Fetch assignments do intervalo (uma só query)
  const assignmentRows = await db
    .select()
    .from(extrasDiaAssignments)
    .where(
      and(
        cityNameScope(extrasDiaAssignments.city),
        gte(extrasDiaAssignments.assignmentDate, startDate),
        lte(extrasDiaAssignments.assignmentDate, endDate),
      ),
    );

  // Empregados → mapeamento Multipark
  const empIds = Array.from(new Set(assignmentRows.map(r => r.employeeId).filter((x): x is number => x !== null)));
  const empMap = new Map<number, { multiparkAgentName: string | null; monthlySalary: string | null }>();
  if (empIds.length > 0) {
    const empRows = await db
      .select({
        id: employees.id,
        multiparkAgentName: employees.multiparkAgentName,
        monthlySalary: employees.monthlySalary,
      })
      .from(employees)
      .where(sql`${employees.id} IN (${sql.raw(empIds.join(","))})`);
    for (const e of empRows) {
      empMap.set(e.id, {
        multiparkAgentName: e.multiparkAgentName,
        monthlySalary: e.monthlySalary ? String(e.monthlySalary) : null,
      });
    }
  }

  // Calcular custo de cada assignment (TL = salário/15, drivers = horas × rate)
  type AssignmentPlus = {
    id: number;
    assignmentDate: string;
    personName: string;
    resolvedAgentName: string;
    isTeamLeader: boolean;
    shift: "morning" | "night";
    startHour: number;
    endHour: number;
    sentHomeHour: number | null;
    hoursPaid: number;
    cost: number;
  };
  const assignmentsPlus: AssignmentPlus[] = assignmentRows.map(r => {
    const isTL = r.isTeamLeader === 1;
    const effectiveEnd = r.sentHomeHour ?? r.endHour;
    const hours = Math.max(0, effectiveEnd - r.startHour);
    const map = r.employeeId ? empMap.get(r.employeeId) : undefined;
    let cost = 0;
    if (isTL && map?.monthlySalary) {
      const monthly = parseFloat(map.monthlySalary);
      if (Number.isFinite(monthly)) cost = monthly / TL_WORKING_DAYS_PER_MONTH;
    } else if (!isTL && r.level) {
      const rate = DRIVER_LEVELS.find(l => l.id === r.level)?.hourlyRate ?? 0;
      cost = hours * rate;
    }
    const resolvedAgentName = map?.multiparkAgentName ?? deriveShortName(r.personName);
    return {
      id: r.id,
      assignmentDate: r.assignmentDate,
      personName: r.personName,
      resolvedAgentName,
      isTeamLeader: isTL,
      shift: (r.shift as "morning" | "night") ?? "morning",
      startHour: r.startHour,
      endHour: r.endHour,
      sentHomeHour: r.sentHomeHour,
      hoursPaid: hours,
      cost,
    };
  });

  // History do intervalo (alargado +27h para apanhar turnos noite que entram em D+1)
  const startStr = `${startDate} 00:00:00`;
  const endPlus = new Date(endDate + "T00:00:00");
  endPlus.setDate(endPlus.getDate() + 2); // +2 dias para apanhar turnos da noite
  const endStr = endPlus.toISOString().slice(0, 19).replace("T", " ");

  const historyRows = await db
    .select({
      agentName: multiparkBookingHistory.agentName,
      changeType: multiparkBookingHistory.changeType,
      actionTime: multiparkBookingHistory.actionTime,
    })
    .from(multiparkBookingHistory)
    .where(
      and(
        bookingHistoryScope(multiparkBookingHistory.bookingExternalId),
        gte(multiparkBookingHistory.actionTime, startStr),
        lt(multiparkBookingHistory.actionTime, endStr),
      ),
    );

  const normalize = (s: string) => s.toLowerCase().trim();

  // Para cada acção, encontra qual assignment a "abriga" (mesmo nome + actionTime
  // dentro do shift desse dia). Se nenhum, fica "out of shift" do mais próximo
  // assignment desse agente nos últimos N dias.
  type PersonAgg = {
    personName: string;
    resolvedAgentName: string;
    isTeamLeader: boolean;
    daysWorked: Set<string>;
    hoursPaid: number;
    totalCost: number;
    totalActions: number;
    inShiftActions: number;
    outOfShiftActions: number;
    byType: Record<string, number>;
  };
  const personByName = new Map<string, PersonAgg>();

  // 1. Aglutina pessoas a partir das assignments
  for (const a of assignmentsPlus) {
    const key = normalize(a.resolvedAgentName);
    let p = personByName.get(key);
    if (!p) {
      p = {
        personName: a.personName,
        resolvedAgentName: a.resolvedAgentName,
        isTeamLeader: a.isTeamLeader,
        daysWorked: new Set(),
        hoursPaid: 0,
        totalCost: 0,
        totalActions: 0,
        inShiftActions: 0,
        outOfShiftActions: 0,
        byType: {},
      };
      personByName.set(key, p);
    }
    p.daysWorked.add(a.assignmentDate);
    p.hoursPaid += a.hoursPaid;
    p.totalCost += a.cost;
    if (a.isTeamLeader) p.isTeamLeader = true;
  }

  // 2. Processa cada acção: tenta encontrar assignment do dia para classificar
  // in-shift / out-of-shift
  const dailyMap = new Map<string, DailyDashboardEntry>();
  for (const h of historyRows) {
    if (!h.agentName || !h.actionTime || !h.changeType) continue;
    const key = normalize(h.agentName);
    const p = personByName.get(key);
    if (!p) continue; // agente que não está escalado em nenhum dia do intervalo

    p.totalActions++;
    p.byType[h.changeType] = (p.byType[h.changeType] ?? 0) + 1;

    // Decide o dia operacional da acção: pertence à shift que a "contém"
    // Para isso testa contra todas as assignments deste agente no intervalo
    const personAssignments = assignmentsPlus.filter(
      a => normalize(a.resolvedAgentName) === key,
    );
    let inShift = false;
    let bucketDate: string | null = null;
    for (const a of personAssignments) {
      const offset = actionTimeToOffsetHours(h.actionTime, a.assignmentDate);
      if (offset === null) continue;
      const effectiveEnd = a.sentHomeHour ?? a.endHour;
      // O dia operacional vai de 03h a 03h+1d (range 3-27)
      // Mas vamos comparar com a janela do shift do assignment
      if (offset >= a.startHour && offset <= effectiveEnd) {
        inShift = true;
        bucketDate = a.assignmentDate;
        break;
      }
      // Se actionTime cai no mesmo dia mas FORA do shift, ainda assim conta como
      // "out-of-shift" desse assignment (para a métrica do user)
      if (offset >= 0 && offset < 24 && !bucketDate) {
        bucketDate = a.assignmentDate;
      }
    }

    if (inShift) p.inShiftActions++;
    else p.outOfShiftActions++;

    // Daily bucket
    const bd = bucketDate ?? (h.actionTime?.slice(0, 10) ?? null);
    if (bd) {
      let day = dailyMap.get(bd);
      if (!day) {
        day = { date: bd, drivers: 0, totalCost: 0, totalActions: 0, inShift: 0, outOfShift: 0 };
        dailyMap.set(bd, day);
      }
      day.totalActions++;
      if (inShift) day.inShift++;
      else day.outOfShift++;
    }
  }

  // 3. Preencher daily com custos e drivers
  for (const a of assignmentsPlus) {
    let day = dailyMap.get(a.assignmentDate);
    if (!day) {
      day = { date: a.assignmentDate, drivers: 0, totalCost: 0, totalActions: 0, inShift: 0, outOfShift: 0 };
      dailyMap.set(a.assignmentDate, day);
    }
    day.totalCost += a.cost;
    day.drivers++;
  }

  const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  const byPerson: PersonRangeSummary[] = Array.from(personByName.values()).map(p => ({
    personName: p.personName,
    resolvedAgentName: p.resolvedAgentName,
    isTeamLeader: p.isTeamLeader,
    daysWorked: p.daysWorked.size,
    hoursPaid: Math.round(p.hoursPaid * 100) / 100,
    totalCost: Math.round(p.totalCost * 100) / 100,
    totalActions: p.totalActions,
    inShiftActions: p.inShiftActions,
    outOfShiftActions: p.outOfShiftActions,
    byType: p.byType,
    costPerAction: p.totalActions > 0 ? p.totalCost / p.totalActions : 0,
  }));
  byPerson.sort((a, b) => b.totalActions - a.totalActions);

  // Totals
  const totalCost = daily.reduce((s, d) => s + d.totalCost, 0);
  const totalActions = byPerson.reduce((s, p) => s + p.totalActions, 0);
  const totalInShift = byPerson.reduce((s, p) => s + p.inShiftActions, 0);
  const totalOut = byPerson.reduce((s, p) => s + p.outOfShiftActions, 0);
  const totalByType: Record<string, number> = {};
  for (const p of byPerson) {
    for (const [k, v] of Object.entries(p.byType)) totalByType[k] = (totalByType[k] ?? 0) + v;
  }

  return {
    startDate,
    endDate,
    daily,
    byPerson,
    totals: {
      days: daily.length,
      drivers: byPerson.length,
      totalCost: Math.round(totalCost * 100) / 100,
      totalActions,
      inShift: totalInShift,
      outOfShift: totalOut,
      byType: totalByType,
      costPerAction: totalActions > 0 ? totalCost / totalActions : 0,
    },
  };
}
