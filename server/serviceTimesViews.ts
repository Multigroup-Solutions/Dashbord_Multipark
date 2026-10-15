/**
 * Tempos de entrega e de recolha — os blocos `times` dos ecrãs da Pressão e
 * da Semana e o cartão "De onde vêm os tempos" (só leitura, a NOSSA BD: a
 * tabela `service_times`). As contas e o portão são os de
 * server/serviceTimesAgg.ts; o formato antigo da Pressão e da Semana não muda
 * (o bloco `times` vem ao lado).
 */
import { addDays } from "../shared/lisbonDay";
import { cityGroupKey } from "../shared/extrasPressure";
import { DEFAULT_TIGHT_USES_QUEUE, type TightUsesQueueMap } from "../shared/appSettings";
import { SERVICE_TIMES_CALC_VERSION, DEFAULT_GARAGE_ROLES, garageRoleOf, type GarageRoleEntry, type GpsGate } from "../shared/serviceTimes";
import { pressureCellKey, queueCellsOf, timesGrid, weekCellKey, type GateCtx, type ServiceRow, type TimesGrid } from "./serviceTimesAgg";
import { GRID_ROW_COLUMNS, loadServiceRowsInfo, loadServiceViewSettings } from "./serviceTimesRead";

const CITY_OF_KEY: Record<string, "lisbon" | "porto" | "faro"> = { lisboa: "lisbon", porto: "porto", faro: "faro" };

// ─── Pressão ────────────────────────────────────────────────────────────────

export interface PressureTimesGroup extends TimesGrid {
  /** extras.tightUsesQueue nesta cidade. */
  tightUsesQueue: boolean;
  /** A Fila por célula para a hora apertada — só com a definição ligada E cobertura ≥ 60 %. */
  queue: Record<string, { n: number; p75: number | null }> | null;
  queueCoveragePct: number | null;
}
export interface PressureTimes {
  available: boolean;
  from: string;
  to: string;
  rows: number;
  /** A leitura chegou ao teto: ficam os dias mais recentes (o ecrã avisa). */
  truncated: boolean;
  targetMinutes: number;
  groups: Record<string, PressureTimesGroup>;
}

/**
 * Os tempos novos por (dia da semana × hora) de cada cidade, no período da
 * Pressão. PURA (as linhas já lidas).
 */
export function pressureTimesFrom(rows: readonly ServiceRow[], o: { from: string; to: string; isSuperAdmin: boolean; gate: GpsGate | null | undefined; targetMinutes: number; tightUsesQueue: TightUsesQueueMap; truncated?: boolean }): PressureTimes {
  const byCity = new Map<string, ServiceRow[]>();
  for (const r of rows) {
    if (!r.cityKey || !CITY_OF_KEY[r.cityKey]) continue;
    const l = byCity.get(r.cityKey) ?? [];
    l.push(r);
    byCity.set(r.cityKey, l);
  }
  const groups: Record<string, PressureTimesGroup> = {};
  for (const [city, list] of byCity) {
    const grid = timesGrid(list, pressureCellKey, { gate: { gate: o.gate, isSuperAdmin: o.isSuperAdmin }, targetMinutes: o.targetMinutes });
    const q = queueCellsOf(grid);
    const on = o.tightUsesQueue[CITY_OF_KEY[city]] === true;
    groups[cityGroupKey(city)] = { ...grid, tightUsesQueue: on, queue: on && q.ok ? q.cells : null, queueCoveragePct: q.coveragePct };
  }
  return { available: rows.length > 0, from: o.from, to: o.to, rows: rows.length, truncated: !!o.truncated, targetMinutes: o.targetMinutes, groups };
}

const PRESSURE_TIMES_CACHE_MS = 10 * 60_000;
const pressureCache = new Map<string, { at: number; value: PressureTimes }>();

/**
 * O bloco `times` da Pressão (lê a tabela no período da janela; guardado 10 min). Nunca lança.
 * Auditoria do #389: a chave da cache leva o portão, a meta e a "hora apertada pela Fila" —
 * fechar o portão (ou mudar a meta) vale logo, sem esperar 10 min.
 */
export async function getPressureTimes(o: { from: string; to: string; cityKeys: readonly string[] | null; isSuperAdmin: boolean }): Promise<PressureTimes> {
  const empty: PressureTimes = { available: false, from: o.from, to: o.to, rows: 0, truncated: false, targetMinutes: 15, groups: {} };
  try {
    const [st, tq] = await Promise.all([
      loadServiceViewSettings(),
      (async () => { const { getSetting } = await import("./appSettings"); return ((await getSetting("extras.tightUsesQueue").catch(() => null)) as TightUsesQueueMap | null) ?? DEFAULT_TIGHT_USES_QUEUE; })(),
    ]);
    const key = [o.from, o.to, o.cityKeys ? [...o.cityKeys].sort().join(",") : "*", o.isSuperAdmin ? 1 : 0, JSON.stringify(st.gate), st.targetMinutes, JSON.stringify(tq)].join("|");
    const hit = pressureCache.get(key);
    if (hit && Date.now() - hit.at < PRESSURE_TIMES_CACHE_MS) return hit.value;
    const read = await loadServiceRowsInfo({ fromDay: o.from, toDay: o.to, cityKeys: o.cityKeys, columns: GRID_ROW_COLUMNS });
    const value = pressureTimesFrom(read.rows, { from: o.from, to: o.to, isSuperAdmin: o.isSuperAdmin, gate: st.gate, targetMinutes: st.targetMinutes, tightUsesQueue: tq, truncated: read.truncated });
    if (pressureCache.size > 40) pressureCache.clear();
    pressureCache.set(key, { at: Date.now(), value });
    return value;
  } catch (err: any) {
    console.warn("[tempos] pressão:", String(err?.message ?? err).slice(0, 160));
    return empty;
  }
}

/** Só para os testes. */
export function clearPressureTimesCache(): void { pressureCache.clear(); }

// ─── Semana ─────────────────────────────────────────────────────────────────

export interface WeekTimes {
  available: boolean;
  /** A leitura chegou ao teto (o ecrã avisa). */
  truncated: boolean;
  targetMinutes: number;
  /** Célula "dia|hora", total do dia "dia|*", total da hora "*|hora" e a semana "*". */
  cells: TimesGrid;
  byDay: TimesGrid;
  byHour: TimesGrid;
  total: TimesGrid;
}

/** Os tempos novos da semana de uma cidade (dia operacional × hora). PURA. */
export function weekTimesFrom(rows: readonly ServiceRow[], o: { gate: GateCtx; targetMinutes: number; truncated?: boolean }): WeekTimes {
  const base = { gate: o.gate, targetMinutes: o.targetMinutes };
  return {
    available: rows.length > 0, truncated: !!o.truncated, targetMinutes: o.targetMinutes,
    cells: timesGrid(rows, weekCellKey, base),
    byDay: timesGrid(rows, (r) => r.opDay, base),
    byHour: timesGrid(rows, (r) => (r.refHour == null ? null : String(r.refHour)), base),
    total: timesGrid(rows, () => "*", base),
  };
}

/** O bloco `times` da Semana. Nunca lança. */
export async function getWeekTimes(o: { weekStart: string; cityKey: string; isSuperAdmin: boolean }): Promise<WeekTimes | null> {
  try {
    const [read, st] = await Promise.all([loadServiceRowsInfo({ fromDay: o.weekStart, toDay: addDays(o.weekStart, 6), cityKeys: [o.cityKey], columns: GRID_ROW_COLUMNS }), loadServiceViewSettings()]);
    return weekTimesFrom(read.rows, { gate: { gate: st.gate, isSuperAdmin: o.isSuperAdmin }, targetMinutes: st.targetMinutes, truncated: read.truncated });
  } catch (err: any) {
    console.warn("[tempos] semana:", String(err?.message ?? err).slice(0, 160));
    return null;
  }
}

// ─── "De onde vêm os tempos" (Pressão, super admin) ─────────────────────────

export interface CoverageWeekRow {
  city: string;
  /** Segunda-feira da semana. */
  week: string;
  deliveries: number; withCall: number; fromPending: number; gps: number; button: number; transitUnmeasured: number;
  pickups: number; pickupWithCall: number; terminalGps: number; terminalApp: number; terminalUnmeasured: number;
  /** Zello que não bate com ninguém (sem Zello, condutor por ligar). */
  noZello: number;
  /** Zonas em falta (sem zona de destino, sem zona do terminal, sem zona T2). */
  missingZones: number;
  /** GPS ainda por recolher. */
  gpsPending: number;
  reasons: Record<string, number>;
}
export interface CoverageCard {
  weeks: CoverageWeekRow[];
  /** Garagens dos movimentos sem papel nas Definições (nomes da operação). */
  garagesWithoutRole: string[];
  /** Linhas com outra versão do cálculo ou outros parâmetros do que as mais recentes (últimos 14 dias). */
  staleRows: number;
  rows: number;
  /** A leitura chegou ao teto: ficam as semanas mais recentes (o cartão avisa). */
  truncated: boolean;
  calcVersion: number;
}

const mondayOf = (day: string) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1)); return d.toISOString().slice(0, 10); };
const NO_ZELLO = new Set(["sem_zello", "condutor_desconhecido", "condutor_fora_da_equipa"]);
const NO_ZONE = new Set(["sem_destino", "sem_zona", "sem_zona_t2", "destino_ambiguo", "zonas_sobrepostas"]);

/** O cartão da cobertura: por cidade e semana (contagens; nada pessoal). PURA. */
export function coverageCardFrom(rows: readonly ServiceRow[], o: { roles: readonly GarageRoleEntry[]; today: string; truncated?: boolean }): CoverageCard {
  const acc = new Map<string, CoverageWeekRow>();
  const unknown = new Set<string>();
  const recent = rows.filter((r) => r.opDay >= addDays(o.today, -14));
  const latestHash = recent.reduce<{ at: string; h: string | null }>((m, r) => (r.computedAt && r.computedAt > m.at ? { at: r.computedAt, h: r.paramsHash ?? null } : m), { at: "", h: null }).h;
  let stale = 0;
  for (const r of recent) if ((r.calcVersion != null && r.calcVersion !== SERVICE_TIMES_CALC_VERSION) || (latestHash && r.paramsHash && r.paramsHash !== latestHash)) stale++;
  for (const r of rows) {
    if (r.voidedAt || r.outcome === "cancelado") continue;
    const key = `${r.cityKey ?? "?"}|${mondayOf(r.opDay)}`;
    let a = acc.get(key);
    if (!a) {
      a = { city: r.cityKey ?? "?", week: mondayOf(r.opDay), deliveries: 0, withCall: 0, fromPending: 0, gps: 0, button: 0, transitUnmeasured: 0, pickups: 0, pickupWithCall: 0, terminalGps: 0, terminalApp: 0, terminalUnmeasured: 0, noZello: 0, missingZones: 0, gpsPending: 0, reasons: {} };
      acc.set(key, a);
    }
    const status = r.kind === "entrega" ? r.transitStatus : r.terminalStatus;
    if (r.kind === "entrega") {
      a.deliveries++;
      if (r.startSource === "chamada") a.withCall++; else if (r.startSource === "pendente") a.fromPending++;
      if (r.transitStatus === "medido" && r.arrivedSource === "botao") a.button++;
      else if (r.transitStatus === "medido") a.gps++;
      else a.transitUnmeasured++;
    } else {
      a.pickups++;
      if (r.startSource === "chamada") a.pickupWithCall++;
      if (r.terminalStatus === "medido" && r.terminalExitSource === "gps") a.terminalGps++;
      else if (r.terminalStatus === "medido") a.terminalApp++;
      else a.terminalUnmeasured++;
      for (const g of [r.firstGarage, r.parkedGarage]) if (g && !garageRoleOf(g, o.roles).configured) unknown.add(g);
    }
    if (status && status !== "medido") {
      a.reasons[status] = (a.reasons[status] ?? 0) + 1;
      if (NO_ZELLO.has(status)) a.noZello++;
      if (NO_ZONE.has(status)) a.missingZones++;
      if (status === "gps_por_recolher") a.gpsPending++;
    }
    if (r.kind === "recolha" && r.t2Status && NO_ZONE.has(r.t2Status)) a.missingZones++;
  }
  return {
    weeks: [...acc.values()].sort((x, y) => y.week.localeCompare(x.week) || x.city.localeCompare(y.city)),
    garagesWithoutRole: [...unknown].sort((a, b) => a.localeCompare(b, "pt")).slice(0, 30),
    staleRows: stale, rows: rows.length, truncated: !!o.truncated, calcVersion: SERVICE_TIMES_CALC_VERSION,
  };
}

/** O cartão (últimas 8 semanas, cidades do âmbito). Nunca lança. */
export async function getCoverageCard(o: { today: string; cityKeys: readonly string[] | null }): Promise<CoverageCard> {
  const read = await loadServiceRowsInfo({ fromDay: addDays(mondayOf(o.today), -7 * 7), toDay: o.today, cityKeys: o.cityKeys });
  let roles: GarageRoleEntry[] = DEFAULT_GARAGE_ROLES.map((g) => ({ ...g }));
  try {
    const { getSetting } = await import("./appSettings");
    roles = ((await getSetting("operations.garageRoles")) as GarageRoleEntry[] | null) ?? roles;
  } catch { /* omissão */ }
  return coverageCardFrom(read.rows, { roles, today: o.today, truncated: read.truncated });
}
