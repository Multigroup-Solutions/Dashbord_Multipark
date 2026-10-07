/**
 * Lote 42a — a avaliação da EQUIPA (Jorge, 7 out 2026): o team leader é
 * avaliado de duas maneiras — como condutor (as ações dele, como toda a gente)
 * e como TL (o que a equipa dele fez); o supervisor fica com a equipa do dia
 * da cidade: a média da equipa e se teve extras a mais ou a menos face à
 * previsão. Regras PURAS (cliente e servidor).
 */

export interface TeamMember { totalPoints: number; totalActions: number }

export interface TeamScore {
  people: number;
  points: number;
  avgPoints: number;
  actions: number;
  avgActions: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Pontos e ações da equipa (soma e média por pessoa). PURA. */
export function teamScore(members: readonly TeamMember[]): TeamScore {
  const people = members.length;
  const points = r2(members.reduce((s, m) => s + (Number(m.totalPoints) || 0), 0));
  const actions = members.reduce((s, m) => s + (Number(m.totalActions) || 0), 0);
  return { people, points, avgPoints: people ? r1(points / people) : 0, actions, avgActions: people ? r1(actions / people) : 0 };
}

export interface ShiftSpan { startHour: number; endHour: number; sentHomeHour?: number | null }
export interface HourBalance { hour: number; needed: number; have: number }

export type CoverageVerdict = "a_menos" | "a_mais" | "certo" | "sem_previsao";

export interface CoverageBalance {
  /** horas·pessoa que a previsão pedia (condutores, sem o TL) */
  neededPersonHours: number;
  /** horas·pessoa escaladas (até à hora de mandar para casa) */
  scheduledPersonHours: number;
  /** horas·pessoa que faltaram / que sobraram, hora a hora */
  shortPersonHours: number;
  overPersonHours: number;
  /** horas do dia com gente a menos / a mais */
  shortHours: HourBalance[];
  overHours: HourBalance[];
  /** pico pedido e escalados nesse pico */
  peakNeeded: number;
  verdict: CoverageVerdict;
}

/**
 * Previsão (condutores por hora do dia operacional, 0–26) × escalados.
 * "A mais" quando sobram mais horas·pessoa do que faltam e pelo menos 4 h·pessoa
 * (uma pessoa a mais durante meio turno); "a menos" quando falta gente em
 * alguma hora e as faltas pesam mais do que as sobras. PURA.
 */
export function coverageBalance(needed: readonly number[], assigned: readonly ShiftSpan[]): CoverageBalance {
  const hours = Math.max(needed.length, ...assigned.map((a) => Math.max(a.endHour, a.sentHomeHour ?? 0)), 0);
  let neededPH = 0, scheduledPH = 0, shortPH = 0, overPH = 0, peak = 0;
  const shortHours: HourBalance[] = [], overHours: HourBalance[] = [];
  for (let h = 0; h < hours; h++) {
    const need = Math.max(0, Number(needed[h] ?? 0) || 0);
    const have = assigned.filter((a) => a.startHour <= h && h < (a.sentHomeHour ?? a.endHour)).length;
    neededPH += need;
    scheduledPH += have;
    peak = Math.max(peak, need);
    if (have < need) { shortPH += need - have; shortHours.push({ hour: h, needed: need, have }); }
    else if (have > need) { overPH += have - need; overHours.push({ hour: h, needed: need, have }); }
  }
  const verdict: CoverageVerdict = neededPH === 0 ? "sem_previsao"
    : shortPH > 0 && shortPH >= overPH ? "a_menos"
    : overPH >= 4 && overPH > shortPH ? "a_mais"
    : "certo";
  return { neededPersonHours: neededPH, scheduledPersonHours: scheduledPH, shortPersonHours: shortPH, overPersonHours: overPH, shortHours, overHours, peakNeeded: peak, verdict };
}

export const COVERAGE_VERDICT_LABELS: Record<CoverageVerdict, string> = {
  a_menos: "Extras a menos",
  a_mais: "Extras a mais",
  certo: "Extras certos",
  sem_previsao: "Sem previsão",
};

/** "07h–09h, 18h" — horas seguidas juntas (horas do dia operacional; 24h+ = madrugada). PURA. */
export function hoursLabel(list: readonly HourBalance[], max = 4): string {
  const hs = list.map((x) => x.hour).sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const h of hs) {
    const last = runs[runs.length - 1];
    if (last && h === last[1] + 1) last[1] = h; else runs.push([h, h]);
  }
  const fmt = (h: number) => `${String(h % 24).padStart(2, "0")}h`;
  const parts = runs.slice(0, max).map(([a, b]) => (a === b ? fmt(a) : `${fmt(a)}–${fmt(b + 1)}`));
  return parts.join(", ") + (runs.length > max ? "…" : "");
}

// ─── Mês: o TL como TL e a equipa de cada cidade ─────────────────────────────

export interface TeamDayInput {
  employeeId: number;
  employeeName: string;
  day: string;
  /** cidade da escala nesse dia (lisbon/porto/faro) ou null */
  city: string | null;
  shift: string | null;
  isTeamLeader: boolean;
  points: number;
  actions: number;
}

export interface TeamLeaderRow {
  employeeId: number;
  employeeName: string;
  /** dias em que foi TL */
  tlDays: number;
  /** os pontos dele nesses dias (como condutor) */
  ownPoints: number;
  /** a equipa nesses dias: pontos e ações (soma), pessoas·dia e média por pessoa·dia */
  teamPoints: number;
  teamActions: number;
  teamPersonDays: number;
  avgTeamPoints: number;
}

export interface CityTeamRow {
  city: string;
  /** dias com escala e pessoas·dia (sem os TL) */
  days: number;
  personDays: number;
  points: number;
  actions: number;
  avgPoints: number;
}

const teamKey = (d: TeamDayInput) => `${d.day}|${d.city ?? ""}|${d.shift ?? ""}`;

/**
 * Por TL: o que a equipa dele fez nos dias em que foi TL (mesmo dia, cidade e
 * turno da escala). Os mais fortes primeiro (média por pessoa·dia). PURA.
 */
export function teamLeaderTotals(days: readonly TeamDayInput[]): TeamLeaderRow[] {
  const members = new Map<string, TeamDayInput[]>();
  for (const d of days) if (!d.isTeamLeader && d.city) members.set(teamKey(d), [...(members.get(teamKey(d)) ?? []), d]);
  const out = new Map<number, TeamLeaderRow>();
  for (const d of days) {
    if (!d.isTeamLeader || !d.city) continue;
    const team = members.get(teamKey(d)) ?? [];
    const r = out.get(d.employeeId) ?? { employeeId: d.employeeId, employeeName: d.employeeName, tlDays: 0, ownPoints: 0, teamPoints: 0, teamActions: 0, teamPersonDays: 0, avgTeamPoints: 0 };
    r.tlDays += 1;
    r.ownPoints = r2(r.ownPoints + d.points);
    r.teamPoints = r2(r.teamPoints + team.reduce((s, m) => s + m.points, 0));
    r.teamActions += team.reduce((s, m) => s + m.actions, 0);
    r.teamPersonDays += team.length;
    out.set(d.employeeId, r);
  }
  for (const r of out.values()) r.avgTeamPoints = r.teamPersonDays ? r1(r.teamPoints / r.teamPersonDays) : 0;
  return Array.from(out.values()).sort((a, b) => b.avgTeamPoints - a.avgTeamPoints || a.employeeName.localeCompare(b.employeeName, "pt"));
}

/** Por cidade (a equipa do supervisor): pessoas·dia, pontos e média, sem os TL. PURA. */
export function cityTeamTotals(days: readonly TeamDayInput[]): CityTeamRow[] {
  const out = new Map<string, CityTeamRow & { daySet: Set<string> }>();
  for (const d of days) {
    if (!d.city || d.isTeamLeader) continue;
    const r = out.get(d.city) ?? { city: d.city, days: 0, personDays: 0, points: 0, actions: 0, avgPoints: 0, daySet: new Set<string>() };
    r.daySet.add(d.day);
    r.personDays += 1;
    r.points = r2(r.points + d.points);
    r.actions += d.actions;
    out.set(d.city, r);
  }
  return Array.from(out.values()).map(({ daySet, ...r }) => ({ ...r, days: daySet.size, avgPoints: r.personDays ? r1(r.points / r.personDays) : 0 }))
    .sort((a, b) => a.city.localeCompare(b.city));
}
