/**
 * Atividade diária → "Semana" (Jorge, 12 out 2026): uma semana (domingo →
 * sábado, dias operacionais 03:00 → 03:00) de UMA cidade, por hora — quantas
 * entregas/recolhas, o tempo por carro (a métrica da Pressão) e a espera
 * (pendente → entregue; recolha começada → feita). Regras em
 * shared/weekActivity.ts.
 *
 * De onde vêm os números (reutiliza a Pressão do Extras-Dia):
 *   1. a semana já passou e os 8 dias de calendário estão guardados pelo
 *      trabalho noturno (ops_pressure_days, as duas partes, com a assinatura
 *      de hoje) → lê-se só a NOSSA BD;
 *   2. senão, UMA leitura da semana à BD da Multipark (só leitura): as mesmas
 *      consultas por (dia, hora) do trabalho noturno (buildPressureDaySql e
 *      buildPressureDriverDaySql) com os eventos só da semana e a MESMA
 *      janela de fundo do trabalho noturno (reservas e 1.ª ação de cada tipo
 *      desde extras.timesSince) — assim a semana dá os mesmos números que os
 *      dias guardados (prova em extrasPressure.pg.test.ts) —, limitadas aos
 *      parques da cidade (sem os "Parques que a operação não faz").
 * Guarda-se em memória uns minutos (a semana atual 3 min; as outras 30 min).
 * Falha a ler → `{ available:false, reason }` (erro ≠ zero, nunca grelha vazia).
 */
import { multiparkDbQuery, redactSecrets, type SqlParam } from "./multiparkDb/client";
import { describeReadFailure } from "./multiparkDb/read";
import { buildParksSql, mapParks } from "./multiparkDb/dayBookings";
import { buildPressureChunks, buildPressureDaySql, buildPressureDriverDaySql, pressureWindow, pressureWindowSince } from "./multiparkDb/pressure";
import { driverDayPayloads, groupDayPayloads, parseDayPayload, pressureDaySig, type DriverDayPayload, type GroupDayPayload } from "./pressureDays";
import { excludeParks } from "../shared/reservasDoDia";
import { PRESSURE_SINCE_DEFAULT, cityGroupKey } from "../shared/extrasPressure";
import { addDays, lisbonDayOf, lisbonHourOf, operationalDayOf } from "../shared/lisbonDay";
import { buildWeekGrids, weekCalendarDays, weekStartOf, type WeekGrid, type WeekKind } from "../shared/weekActivity";
import type { HandoverCity } from "../shared/shiftHandover";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

export type WeekActivityResult =
  | {
      available: true;
      city: HandoverCity;
      weekStart: string;
      /** Sábado (último dia operacional). */
      weekEnd: string;
      /** "guardado" = dias do cálculo da Pressão (nossa BD); "ao vivo" = lido agora da Multipark. */
      source: "guardado" | "ao vivo";
      /** UTC "AAAA-MM-DD HH:MM:SS". */
      computedAt: string;
      parks: number;
      grids: Record<WeekKind, WeekGrid>;
    }
  | { available: false; city: HandoverCity; weekStart: string; reason: string };

/** Cidade da página → cidade dos parques (lisboa/porto/faro). */
const PARK_CITY: Record<HandoverCity, string> = { lisbon: "lisboa", porto: "porto", faro: "faro" };

/** Leitura da semana: até 25 s (a função morre aos 60 s). */
export const WEEK_QUERY_TIMEOUT_MS = 25_000;
const CACHE_LIVE_MS = 3 * 60_000;
const CACHE_PAST_MS = 30 * 60_000;
const cache = new Map<string, { at: number; ttl: number; value: WeekActivityResult }>();

/** Só para os testes. */
export function clearWeekActivityCache(): void {
  cache.clear();
}

const utcNow = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

export interface WeekStoredDays {
  load(group: string, part: "group" | "driver", from: string, to: string, sig: string): Promise<Array<{ day: string; payload: unknown }>>;
}

export async function getWeekActivity(o: {
  city: HandoverCity;
  /** Qualquer dia da semana (vai para o domingo). */
  weekStart: string;
  now?: number;
  query?: Query;
  /** Dias guardados (omissão: ops_pressure_days). null = não usar. */
  stored?: WeekStoredDays | null;
  excludedParkIds?: readonly string[] | null;
  /** Início da janela de fundo (Definições → extras.timesSince; omissão: lida). */
  since?: string | null;
  isConfigured?: () => boolean;
}): Promise<WeekActivityResult> {
  const now = o.now ?? Date.now();
  const weekStart = weekStartOf(o.weekStart);
  const today = operationalDayOf(now);
  const base = { city: o.city, weekStart };
  if (weekStart > today) return { available: false, ...base, reason: "Essa semana ainda não começou." };
  const key = `${o.city}|${weekStart}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl && !o.query) return hit.value;

  const configured = o.isConfigured ?? (() => !!String(process.env.DATABASE_URL_MULTIPARK ?? "").trim());
  if (!configured()) return { available: false, ...base, reason: "A ligação à BD da Multipark não está configurada (DATABASE_URL_MULTIPARK)." };
  const query: Query = o.query ?? (<T,>(sqlText: string, params?: SqlParam[]) => multiparkDbQuery<T>(sqlText, params ?? [], { timeoutMs: WEEK_QUERY_TIMEOUT_MS, analytics: true }));
  const calDays = weekCalendarDays(weekStart);
  const lastCal = calDays[calDays.length - 1];
  const nowCal = { day: lisbonDayOf(now), hour: lisbonHourOf(now) };

  try {
    // Parques nossos da cidade (sem os que a operação não faz) — os mesmos grupos da Pressão.
    const excluded = o.excludedParkIds !== undefined ? o.excludedParkIds ?? [] : await loadExcludedParks();
    const ps = buildParksSql();
    const chunks = buildPressureChunks(excludeParks(mapParks(await query(ps.sql, ps.params)), excluded));
    const group = cityGroupKey(PARK_CITY[o.city]);
    const parkIds = chunks.find((c) => c.key === group && c.kind !== "driver")?.parkIds ?? [];
    if (!parkIds.length) return { available: false, ...base, reason: "Sem parques nossos nesta cidade na BD da Multipark." };

    let gp: Record<string, GroupDayPayload> | null = null;
    let dp: Record<string, DriverDayPayload> | null = null;
    let source: "guardado" | "ao vivo" = "ao vivo";
    // 1) Semana fechada (até ontem) e guardada pelo cálculo da Pressão → sem ler a Multipark.
    const stored = o.stored === undefined ? await defaultStore() : o.stored;
    if (stored && lastCal < lisbonDayOf(now)) {
      try {
        const [g, d] = await Promise.all([
          stored.load(group, "group", calDays[0], lastCal, pressureDaySig(parkIds, "group")),
          stored.load(group, "driver", calDays[0], lastCal, pressureDaySig(parkIds, "driver")),
        ]);
        if (g.length === calDays.length && d.length === calDays.length) {
          gp = Object.fromEntries(g.map((x) => [x.day, parseDayPayload<GroupDayPayload>(x.payload)]));
          dp = Object.fromEntries(d.map((x) => [x.day, parseDayPayload<DriverDayPayload>(x.payload)]));
          source = "guardado";
        }
      } catch (err) {
        console.warn("[week-activity] dias guardados:", redactSecrets(err).slice(0, 160));
      }
    }
    // 2) Senão, uma leitura da semana (as consultas da Pressão: eventos da semana, fundo = a janela do trabalho noturno).
    if (!gp || !dp) {
      const r = pressureWindow(lastCal, calDays.length);
      const w = weekBackgroundWindow(o.since !== undefined ? o.since : await loadSince(), weekStart, lastCal);
      const g = buildPressureDaySql(w, r, parkIds);
      const gRows = await query(g.sql, g.params);
      const d = buildPressureDriverDaySql(w, r, parkIds);
      const dRows = await query(d.sql, d.params);
      gp = Object.fromEntries(groupDayPayloads(gRows, calDays));
      dp = Object.fromEntries(driverDayPayloads(dRows, calDays));
    }
    const value: WeekActivityResult = {
      available: true, ...base, weekEnd: addDays(weekStart, 6), source, computedAt: utcNow(now), parks: parkIds.length,
      grids: buildWeekGrids(weekStart, gp, dp, nowCal),
    };
    if (!o.query) {
      if (cache.size > 60) cache.clear();
      cache.set(key, { at: now, ttl: lastCal >= addDays(lisbonDayOf(now), -1) ? CACHE_LIVE_MS : CACHE_PAST_MS, value });
    }
    return value;
  } catch (err) {
    console.warn("[week-activity]", o.city, weekStart, redactSecrets(err).slice(0, 200));
    return { available: false, ...base, reason: describeReadFailure(err).reason };
  }
}

/**
 * Janela de fundo da leitura da semana: a do trabalho noturno (desde
 * extras.timesSince), e pelo menos 30 dias antes da semana (uma semana antes
 * do início da medição). PURA.
 */
export function weekBackgroundWindow(since: string | null | undefined, weekStart: string, lastCal: string) {
  const s = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : PRESSURE_SINCE_DEFAULT;
  const floor = addDays(weekStart, -30);
  return pressureWindowSince(s < floor ? s : floor, lastCal);
}

async function loadSince(): Promise<string | null> {
  try {
    const { getSetting } = await import("./appSettings");
    return ((await getSetting("extras.timesSince")) as string | null) ?? null;
  } catch {
    return null;
  }
}

async function loadExcludedParks(): Promise<string[]> {
  try {
    const { getSetting } = await import("./appSettings");
    return ((await getSetting("operations.excludedParks")) as string[] | null) ?? [];
  } catch {
    return [];
  }
}

async function defaultStore(): Promise<WeekStoredDays | null> {
  try {
    const { mysqlPressureDaysStore } = await import("./extrasPressure");
    return mysqlPressureDaysStore;
  } catch {
    return null;
  }
}
