/**
 * Lote 42a — a equipa do dia por cidade, para o supervisor: quem supervisiona
 * (supervisores da cidade), os team leaders do dia, quantos condutores
 * estavam escalados e se a escala bateu com a previsão (extras a mais / a
 * menos, hora a hora). Só leitura: a escala e os supervisores da nossa BD, a
 * previsão das reservas da Multipark (a mesma do Extras Dia).
 */
import { sql } from "drizzle-orm";
import { coverageBalance, type CoverageBalance } from "../shared/evaluationTeam";

const CITY_LABEL: Record<string, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };
const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];

export interface DayTeamCity {
  city: string;
  label: string;
  supervisors: string[];
  teamLeaders: string[];
  drivers: number;
  coverage: CoverageBalance | null;
  /** previsão incompleta ou indisponível (não se tiram conclusões) */
  notice: string | null;
}

/** Supervisores de cada cidade (papel supervisor, ativos, com a cidade no acesso), por nome. */
export async function supervisorsByCity(cities: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!cities.length) return out;
  const { loadCandidatesFromDb } = await import("./notify");
  const candidates = await loadCandidatesFromDb().catch(() => []);
  const supIds = new Map<string, number[]>();
  for (const c of cities) {
    supIds.set(c, candidates.filter((u) => u.role === "supervisor" && !u.personalOnly && (u.cities === "all" || (u.cities as readonly string[]).includes(c))).map((u) => u.id));
  }
  const allIds = Array.from(new Set(Array.from(supIds.values()).flat()));
  const names = new Map<number, string>();
  if (allIds.length) {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (db) for (const r of rowsOf(await db.execute(sql`SELECT id, name, email FROM users WHERE id IN (${sql.join(allIds.map((i) => sql`${i}`), sql`, `)})`))) {
      names.set(Number(r.id), String(r.name || r.email || `#${r.id}`));
    }
  }
  for (const c of cities) out.set(c, (supIds.get(c) ?? []).map((id) => names.get(id) ?? `#${id}`).sort((a, b) => a.localeCompare(b, "pt")));
  return out;
}

export async function dayTeamByCity(date: string): Promise<DayTeamCity[]> {
  const { listAssignments, getExtrasDiaForecast } = await import("./extrasDia");
  const { addDaysIso } = await import("./extrasAutomation");
  const { forecastIncompleteReason } = await import("./extrasSchedule");
  // cidades com escala neste dia, no âmbito de quem vê (cityNameScope)
  const { getDb } = await import("./db");
  const { cityNameScope } = await import("./cityScope");
  const { extrasDiaAssignments } = await import("../drizzle/schema");
  const db = await getDb();
  if (!db) return [];
  const cityRows = rowsOf(await db.execute(sql`SELECT DISTINCT city FROM extras_dia_assignments
    WHERE assignmentDate = ${date} AND ${cityNameScope(extrasDiaAssignments.city)}`));
  const cities = cityRows.map((r) => String(r.city)).filter((c) => c in CITY_LABEL).sort();
  if (!cities.length) return [];

  const supervisors = await supervisorsByCity(cities);

  return Promise.all(cities.map(async (city): Promise<DayTeamCity> => {
    const list = await listAssignments(date, city as any);
    const drivers = list.filter((a) => !a.isTeamLeader);
    let coverage: CoverageBalance | null = null;
    let notice: string | null = null;
    try {
      const f = await getExtrasDiaForecast(addDaysIso(date, -1), city as any);
      notice = forecastIncompleteReason(f);
      coverage = coverageBalance(f.hourly.map((h) => h.driversNeeded), drivers.map((a) => ({ startHour: Number(a.startHour), endHour: Number(a.endHour), sentHomeHour: a.sentHomeHour == null ? null : Number(a.sentHomeHour) })));
    } catch (err: any) {
      notice = `Previsão indisponível: ${String(err?.message ?? err).slice(0, 160)}`;
    }
    return {
      city, label: CITY_LABEL[city],
      supervisors: supervisors.get(city) ?? [],
      teamLeaders: Array.from(new Set(list.filter((a) => a.isTeamLeader).map((a) => a.personName))),
      drivers: new Set(drivers.map((a) => a.employeeId ?? a.personName)).size,
      coverage, notice,
    };
  }));
}
