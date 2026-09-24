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
import { deriveShortName, TL_WORKING_DAYS_PER_MONTH } from "./extrasDia";
import { loadExtraRates, rateFor } from "./extraRates";

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

// O antigo "Dashboard por intervalo" (getDashboardRange) foi fundido na
// Atividade do Dia — ver server/dayActivity.ts (getActivityRange).
