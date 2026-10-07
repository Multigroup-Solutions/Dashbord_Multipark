/**
 * Lote 42b — Pessoas → Condutores e agentes: uma linha por PESSOA (as várias
 * contas de agente de uma ficha somam; sem ficha, o agente sozinho), com
 * recolhas, entregas, movimentos e o resto das ações lidas AO VIVO da BD da
 * Multipark no período, e os km do GPS do Zello (as partes do PDA de cada um).
 * Âmbito: as cidades de quem vê (Park.city) e, com uma marca escolhida no
 * topo, só os parques dela. Só leitura.
 */
import { sql } from "drizzle-orm";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];

export interface MovementPersonRow {
  key: string;
  employeeId: number | null;
  name: string;
  kind: "colaborador" | "parceiro" | "por_ligar";
  agentUserIds: string[];
  agentName: string | null;
  recolhas: number;
  entregas: number;
  movements: number;
  spotChanges: number;
  bookings: number;
  total: number;
  byType: Record<string, number>;
  lastAt: string | null;
  /** km do GPS do Zello no período (null = sem ficha ou sem GPS) */
  km: number | null;
}

export type MovementPeopleResult =
  | { available: true; rows: MovementPersonRow[] }
  | { available: false; reason: string; code?: string };

/** Pessoas com movimentos no período. `drivers` = só quem recolheu, entregou ou moveu carros. */
export async function loadMovementPeople(opts: { from: string; to: string; cities?: string[]; parkIds?: string[]; drivers?: boolean }): Promise<MovementPeopleResult> {
  const { getAgentMovementSummaries, sumAgentSummaries } = await import("./multiparkDb/movements");
  const r = await getAgentMovementSummaries({ startDay: opts.from, endDay: opts.to, byDay: false, cities: opts.cities, parkIds: opts.parkIds });
  if (!r.available) return { available: false, reason: r.reason, code: r.code };
  const { loadEvaluationIdentity } = await import("./evaluationIdentity");
  const { identity } = await loadEvaluationIdentity();
  const groups = new Map<string, { employeeId: number | null; name: string; kind: MovementPersonRow["kind"]; list: typeof r.data }>();
  for (const s of r.data) {
    const who = identity.agent(s.agentUserId, s.agentName);
    if (who.kind === "ignorado") continue;
    const g = groups.get(who.key) ?? { employeeId: who.employeeId, name: who.name, kind: who.kind, list: [] };
    g.list.push(s);
    groups.set(who.key, g);
  }
  let rows: MovementPersonRow[] = Array.from(groups.entries()).map(([key, g]) => {
    const t = sumAgentSummaries(g.list)!;
    return {
      key, employeeId: g.employeeId, name: g.name, kind: g.kind, agentUserIds: t.agentUserIds, agentName: t.agentName,
      recolhas: t.recolhas, entregas: t.entregas, movements: t.movements, spotChanges: t.spotChanges, bookings: t.bookings,
      total: t.total, byType: t.byType, lastAt: t.lastAt, km: null,
    };
  });
  if (opts.drivers) rows = rows.filter((x) => x.recolhas + x.entregas + x.movements > 0);

  // km do GPS (as partes de PDA partilhado de cada pessoa; sem partes, a linha do dia)
  const ids = Array.from(new Set(rows.map((x) => x.employeeId).filter((x): x is number => x != null)));
  if (ids.length) {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (db) {
      const idList = sql.join(ids.map((x) => sql`${x}`), sql`, `);
      const km = new Map<number, number>();
      const add = (id: unknown, v: unknown) => { const k = Number(id); km.set(k, (km.get(k) ?? 0) + (Number(v) || 0)); };
      for (const g of rowsOf(await db.execute(sql`SELECT employeeId, SUM(km) AS km FROM driver_day_shares
          WHERE day >= ${opts.from} AND day <= ${opts.to} AND employeeId IN (${idList}) GROUP BY employeeId`).catch(() => [[]]))) add(g.employeeId, g.km);
      for (const g of rowsOf(await db.execute(sql`SELECT h.employeeId, SUM(h.totalKm) AS km FROM daily_driver_history h
          WHERE h.employeeId IN (${idList}) AND DATE(h.date) >= ${opts.from} AND DATE(h.date) <= ${opts.to}
            AND NOT EXISTS (SELECT 1 FROM driver_day_shares s WHERE s.historyId = h.id) GROUP BY h.employeeId`).catch(() => [[]]))) add(g.employeeId, g.km);
      for (const row of rows) if (row.employeeId != null && km.has(row.employeeId)) row.km = Math.round(km.get(row.employeeId)! * 10) / 10;
    }
  }
  rows.sort((a, b) => b.entregas + b.recolhas - (a.entregas + a.recolhas) || b.total - a.total || a.name.localeCompare(b.name, "pt"));
  return { available: true, rows };
}

/**
 * 42b: a marca escolhida no topo → os parques dela. Cidade ou nada → undefined
 * (a cidade já vem pelo âmbito do pedido).
 */
export async function brandParkIdsFor(projectId: number | undefined): Promise<string[] | undefined> {
  if (!projectId) return undefined;
  if (projectId > 0) {
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return undefined;
    const level = String(rowsOf(await db.execute(sql`SELECT level FROM projects WHERE id = ${projectId} LIMIT 1`))[0]?.level ?? "");
    if (level !== "brand" && level !== "project") return undefined;
  }
  const { liveParkScope } = await import("./opsStatsLive");
  return (await liveParkScope(projectId)).parkIds;
}
