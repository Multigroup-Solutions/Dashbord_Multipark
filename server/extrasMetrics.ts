/**
 * Métricas dos Extras (ponto 12) e extras parados (ponto 13) — Jorge, 24 set 2026.
 *
 *  - taxa de resposta ao pedido de disponibilidade (últimas semanas + próxima)
 *  - cobertura dos próximos 7 dias: horas-condutor previstas vs escaladas
 *  - custo previsto (escala) vs pago (ponto × tarifa) no período
 *  - faltas por extra (pendentes e confirmadas)
 *  - tempo da candidatura ao 1.º turno (ponto)
 *  - extras ativos sem trabalho há mais de 90 dias → sugerir desativar
 *
 * Tudo dentro das cidades do utilizador (projectScope / cityNameScope).
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { cityNameScope } from "./cityScope";

// ─── Puros ──────────────────────────────────────────────────────────────────

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = values.slice().sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso.slice(0, 10)}T12:00:00Z`) - Date.parse(`${fromIso.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
}

export interface StaleExtra { employeeId: number; fullName: string; lastWorked: string | null; createdAt: string | null; idleDays: number }

/**
 * Extras sem trabalho (ponto, escala ou atividade Multipark) há mais de
 * `thresholdDays`. Quem nunca trabalhou conta desde que a ficha foi criada —
 * uma ficha nova ainda não é "parada".
 */
export function findStaleExtras(
  extras: { id: number; fullName: string; createdAt: string | null }[],
  lastWorked: Record<number, string>,
  today: string,
  thresholdDays = 90,
): StaleExtra[] {
  const out: StaleExtra[] = [];
  for (const e of extras) {
    const last = lastWorked[e.id] ?? null;
    const ref = last ?? e.createdAt;
    if (!ref) continue;
    const idle = daysBetween(ref, today);
    if (idle > thresholdDays) out.push({ employeeId: e.id, fullName: e.fullName, lastWorked: last, createdAt: e.createdAt, idleDays: idle });
  }
  return out.sort((a, b) => b.idleDays - a.idleDays);
}

// ─── I/O ────────────────────────────────────────────────────────────────────

function isoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const rowsOf = (res: any): any[] => ((Array.isArray(res) ? res[0] : res) as any[]) ?? [];

export interface ExtrasMetrics {
  period: { from: string; to: string };
  responseRate: { weekStart: string; total: number; responded: number }[];
  cost: { planned: number; paid: number; plannedHours: number; paidHours: number };
  noShows: { employeeId: number; fullName: string; pending: number; confirmed: number }[];
  timeToFirstShift: { approved: number; worked: number; medianDays: number | null };
  stale: StaleExtra[];
}

export async function getExtrasMetrics(days = 30): Promise<ExtrasMetrics> {
  const to = isoToday();
  const from = addDays(to, -Math.max(1, Math.min(180, days)) + 1);
  const out: ExtrasMetrics = {
    period: { from, to },
    responseRate: [],
    cost: { planned: 0, paid: 0, plannedHours: 0, paidHours: 0 },
    noShows: [],
    timeToFirstShift: { approved: 0, worked: 0, medianDays: null },
    stale: [],
  };
  const db = await getDb();
  if (!db) return out;

  const { listActiveExtras, getWeekOverview, mondayOf } = await import("./extrasAvailability");
  const extras = await listActiveExtras();
  const ids = extras.map((e) => e.id);
  const idList = ids.length ? sql.join(ids.map((id) => sql`${id}`), sql`, `) : sql`NULL`;

  // 1. Resposta ao pedido de disponibilidade: 2 semanas atrás, esta e a próxima
  const thisMonday = mondayOf(new Date(`${to}T12:00:00`));
  for (const offset of [-14, -7, 0, 7]) {
    const ov = await getWeekOverview(addDays(thisMonday, offset));
    out.responseRate.push({ weekStart: ov.weekStart, total: ov.totalExtras, responded: ov.responded });
  }

  // 2. Custo previsto (escala, sem TL) vs pago (ponto × tarifa, só turnos válidos)
  const { loadExtraRates, rateFor } = await import("./extraRates");
  const rates = await loadExtraRates();
  const { extrasDiaAssignments } = await import("../drizzle/schema");
  const planned = rowsOf(await db.execute(sql`
    SELECT level, SUM(GREATEST(COALESCE(sentHomeHour, endHour) - startHour, 0)) AS h
      FROM extras_dia_assignments
     WHERE isTeamLeader = 0 AND assignmentDate BETWEEN ${from} AND ${to}
       AND ${cityNameScope(extrasDiaAssignments.city)}
     GROUP BY level`));
  for (const r of planned) {
    const h = Number(r.h ?? 0);
    out.cost.plannedHours += h;
    out.cost.planned += h * rateFor(rates, r.level ?? "junior");
  }
  if (ids.length) {
    const paid = rowsOf(await db.execute(sql`
      SELECT e.extraLevel AS lvl, SUM(t.hoursWorked) AS h
        FROM time_records t JOIN employees e ON e.id = t.employeeId
       WHERE t.type = 'check_out' AND t.employeeId IN (${idList})
         AND t.recordedAt BETWEEN ${`${from} 00:00:00`} AND ${`${to} 23:59:59`}
         AND COALESCE(t.reviewStatus, 'ok') IN ('ok', 'approved')
         AND COALESCE(t.notes, '') NOT LIKE '%[SUSPEITO]%'
       GROUP BY e.extraLevel`));
    for (const r of paid) {
      const h = Number(r.h ?? 0);
      out.cost.paidHours += h;
      out.cost.paid += h * rateFor(rates, r.lvl != null ? Number(r.lvl) : 1);
    }
  }
  out.cost.planned = Math.round(out.cost.planned * 100) / 100;
  out.cost.paid = Math.round(out.cost.paid * 100) / 100;
  out.cost.plannedHours = Math.round(out.cost.plannedHours * 10) / 10;
  out.cost.paidHours = Math.round(out.cost.paidHours * 10) / 10;

  if (ids.length) {
    // 3. Faltas por extra no período
    const ns = rowsOf(await db.execute(sql`
      SELECT p.employeeId, e.fullName,
             SUM(p.status = 'pending') AS pending, SUM(p.status = 'confirmed') AS confirmed
        FROM employee_penalties p JOIN employees e ON e.id = p.employeeId
       WHERE p.reason = 'no_show_extra_dia' AND p.employeeId IN (${idList})
         AND p.createdAt BETWEEN ${`${from} 00:00:00`} AND ${`${to} 23:59:59`}
       GROUP BY p.employeeId, e.fullName
       ORDER BY confirmed DESC, pending DESC
       LIMIT 15`));
    out.noShows = ns.map((r) => ({ employeeId: Number(r.employeeId), fullName: String(r.fullName), pending: Number(r.pending ?? 0), confirmed: Number(r.confirmed ?? 0) }));

    // 4. Candidatura → 1.º turno (candidaturas aprovadas nos últimos 180 dias)
    const since = addDays(to, -180);
    const apps = rowsOf(await db.execute(sql`
      SELECT a.createdAt AS appliedAt,
             (SELECT MIN(t.recordedAt) FROM time_records t
               WHERE t.employeeId = a.employeeId AND t.type = 'check_in' AND t.recordedAt >= a.createdAt) AS firstShift
        FROM driver_applications a
       WHERE a.status = 'approved' AND a.employeeId IN (${idList})
         AND a.createdAt >= ${`${since} 00:00:00`}`));
    const waits: number[] = [];
    for (const a of apps) if (a.firstShift) waits.push(Math.max(0, daysBetween(String(a.appliedAt), String(a.firstShift))));
    out.timeToFirstShift = { approved: apps.length, worked: waits.length, medianDays: median(waits) };

    // 5. Extras parados há mais de 90 dias
    const { getLastWorkedMap } = await import("./db");
    const lastWorked = await getLastWorkedMap();
    const created = new Map<number, string>();
    for (const r of rowsOf(await db.execute(sql`SELECT id, createdAt FROM employees WHERE id IN (${idList})`))) {
      if (r.createdAt) created.set(Number(r.id), String(r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt).slice(0, 10));
    }
    out.stale = findStaleExtras(
      extras.map((e) => ({ id: e.id, fullName: e.fullName, createdAt: created.get(e.id) ?? null })),
      lastWorked,
      to,
    );
  }
  return out;
}

/** Cobertura dos próximos `days` dias numa cidade: horas-condutor previstas vs escaladas. */
export async function getCoverageOutlook(city: "lisbon" | "porto" | "faro", days = 7): Promise<{ date: string; neededHours: number; scheduledHours: number; peakNeeded: number }[]> {
  const { getExtrasDiaForecast, listAssignments } = await import("./extrasDia");
  const today = isoToday();
  const out: { date: string; neededHours: number; scheduledHours: number; peakNeeded: number }[] = [];
  for (let i = 1; i <= Math.max(1, Math.min(14, days)); i++) {
    const date = addDays(today, i);
    const [f, a] = await Promise.all([getExtrasDiaForecast(addDays(date, -1), city), listAssignments(date, city)]);
    out.push({
      date,
      neededHours: f.allocation.cheapest.totalDriverHours,
      peakNeeded: f.allocation.cheapest.peakDrivers,
      scheduledHours: a.filter((x) => !x.isTeamLeader).reduce((s, x) => s + x.hoursBilled, 0),
    });
  }
  return out;
}
