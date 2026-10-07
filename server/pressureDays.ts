/**
 * 47c — "Pressão" do Extras-Dia guardada POR DIA (decisão do Jorge, 7 out
 * 2026: "vai buscar UMA vez desde abril, guarda, e depois vai buscar só o
 * último dia e acrescenta").
 *
 * Porquê: a leitura da janela inteira (desde `extras.timesSince`) crescia
 * todos os dias e, em Lisboa, o Postgres da Multipark escolhia planos
 * quadráticos (nested loops entre CTEs, por estimativas 30–100× abaixo do
 * real) — passou dos 40 s e falhou 4 noites seguidas. Agora cada leitura é
 * de UM dia × grupo (server/multiparkDb/pressure.ts, buildPressureDaySql /
 * buildPressureDriverDaySql) e o resultado de cada dia guarda-se na nossa BD
 * (ops_pressure_days, migração 0570). As células da janela montam-se aqui,
 * juntando os dias guardados, no MESMO formato das leituras antigas (os
 * mapeadores de pressure.ts e a página não mudam).
 *
 * Percentis exatos: as durações guardam-se ao milissegundo (é a resolução
 * das datas da Multipark) e o percentil calcula-se como o percentile_cont do
 * Postgres (mesma fórmula) — um histograma por minuto mudaria os números
 * mostrados (ex.: 12,3 e 14,8 min → mediana 13,55 → "14"; por minuto daria "13").
 *
 * Um dia guardado não se volta a ler, salvo: assinatura diferente (os parques
 * do grupo mudaram, ou a versão do cálculo) ou reprocessamento à mão
 * (/api/cron/extras-pressure?reprocessar=…). Tudo PURO (sem BD nem rede).
 */
import { createHash } from "node:crypto";
import { addDays } from "../shared/lisbonDay";
import { isRushHour, isoWeekday, loadBucketOf, type CrewMeasureBand } from "../shared/extrasPressure";
import type { PressureWindow } from "./multiparkDb/pressure";

/** Versão do cálculo por dia: mudar isto relê todos os dias (vai na assinatura). */
export const PRESSURE_DAYS_VERSION = 1;

export type PressureDayPart = "group" | "driver";

/** Uma hora de Lisboa de um grupo: check-ins/check-outs feitos e começados; durações (ms). */
export interface GroupHour { ci: number; co: number; cis: number; cos: number; del: number[]; pik: number[] }
/** Um dia de um grupo: horas ("0"–"23") e carros em mãos por hora de relógio ("AAAA-MM-DD HH"). */
export interface GroupDayPayload { h: Record<string, GroupHour>; c: Record<string, number> }
/** Uma hora de Lisboa por condutor: serviços começados, durações (ms) e quem agiu. */
export interface DriverHour { jobs: number; cy: number[]; dr: number[]; tp: number[]; u: string[] }
export interface DriverDayPayload { h: Record<string, DriverHour> }

export interface StoredDayMeta { sig: string; computedAt: string }

/** Reprocessar à mão: os dias [from, to] guardados antes de `before` (UTC "AAAA-MM-DD HH:MM:SS") voltam a ler-se. */
export interface PressureReprocess { from: string; to: string; before: string }

// ─── Dias da janela e o que falta ───────────────────────────────────────────

/** Os dias de Lisboa da janela, do primeiro ao último. PURA. */
export function windowDayList(w: Pick<PressureWindow, "startDay" | "endDay">): string[] {
  const out: string[] = [];
  for (let d = w.startDay; d <= w.endDay && out.length < 20_000; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Assinatura dos dias guardados de um grupo: versão do cálculo + os parques. PURA. */
export function pressureDaySig(parkIds: readonly string[]): string {
  const ids = [...new Set(parkIds.map(String))].sort();
  const h = createHash("sha1").update(ids.join("\n")).digest("hex").slice(0, 16);
  return `v${PRESSURE_DAYS_VERSION}:${ids.length}:${h}`;
}

/**
 * Dias a ler da Multipark: os que não estão guardados, os guardados com outra
 * assinatura e (reprocessar à mão) os do intervalo guardados antes do pedido.
 * Do mais antigo para o mais recente. PURA.
 */
export function missingPressureDays(days: readonly string[], meta: ReadonlyMap<string, StoredDayMeta>, sig: string, reprocess?: PressureReprocess | null): string[] {
  return days.filter((d) => {
    const m = meta.get(d);
    if (!m || m.sig !== sig) return true;
    return !!reprocess && d >= reprocess.from && d <= reprocess.to && m.computedAt < reprocess.before;
  });
}

// ─── Linhas da leitura de um dia → o que se guarda ──────────────────────────

const int = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/** "1,2,3" (string_agg) ou [1, 2, 3] → milissegundos inteiros. PURA. */
export function msList(v: unknown): number[] {
  if (v == null || v === "") return [];
  const parts = Array.isArray(v) ? v : String(v).split(",");
  const out: number[] = [];
  for (const x of parts) {
    const n = Number(x);
    if (x !== "" && x != null && Number.isFinite(n)) out.push(Math.round(n));
  }
  return out;
}

/** {a,b} (texto do pg) ou ["a","b"] → nomes de agente sem repetidos. PURA. */
export function uidList(v: unknown): string[] {
  if (v == null || v === "") return [];
  let parts: unknown[];
  if (Array.isArray(v)) parts = v;
  else {
    const s = String(v).trim();
    parts = (s.startsWith("{") && s.endsWith("}") ? s.slice(1, -1) : s).split(",").map((x) => x.replace(/^"(.*)"$/, "$1"));
  }
  return [...new Set(parts.map((x) => String(x ?? "").trim()).filter(Boolean))].sort();
}

const hourOk = (h: number) => h >= 0 && h <= 23;

/** Linhas de buildPressureDaySql → um payload por dia pedido (dias sem nada ficam vazios). PURA. */
export function groupDayPayloads(rows: ReadonlyArray<Record<string, unknown>>, days: readonly string[]): Map<string, GroupDayPayload> {
  const out = new Map<string, GroupDayPayload>(days.map((d) => [d, { h: {}, c: {} }]));
  for (const r of rows) {
    const day = out.get(String(r.d ?? ""));
    if (!day) continue;
    if (r.part === "h") {
      const hr = int(r.hr);
      if (!hourOk(hr)) continue;
      day.h[String(hr)] = { ci: int(r.ci_done), co: int(r.co_done), cis: int(r.ci_started), cos: int(r.co_started), del: msList(r.del_ms), pik: msList(r.pik_ms) };
    } else if (r.part === "c") {
      const hk = String(r.hk ?? "");
      if (!/^\d{4}-\d{2}-\d{2} \d{2}$/.test(hk)) continue;
      day.c[hk] = (day.c[hk] ?? 0) + int(r.n);
    }
  }
  return out;
}

/** Linhas de buildPressureDriverDaySql → um payload por dia pedido. PURA. */
export function driverDayPayloads(rows: ReadonlyArray<Record<string, unknown>>, days: readonly string[]): Map<string, DriverDayPayload> {
  const out = new Map<string, DriverDayPayload>(days.map((d) => [d, { h: {} }]));
  for (const r of rows) {
    const day = out.get(String(r.d ?? ""));
    const hr = int(r.hr);
    if (!day || !hourOk(hr)) continue;
    day.h[String(hr)] = { jobs: int(r.jobs), cy: msList(r.cy), dr: msList(r.dr), tp: msList(r.tp), u: uidList(r.uids) };
  }
  return out;
}

/** Quantos eventos tem um dia guardado (só para se ver na tabela). PURA. */
export function dayEvents(p: GroupDayPayload | DriverDayPayload): number {
  let n = 0;
  for (const x of Object.values(p.h) as Array<GroupHour | DriverHour>) n += "jobs" in x ? x.jobs : x.ci + x.co;
  return n;
}

// ─── Juntar os dias ─────────────────────────────────────────────────────────

/**
 * percentile_cont do Postgres (orderedsetaggs.c) sobre valores JÁ ordenados:
 * linhas floor/ceil de q·(n−1) e lo + (hi − lo)·(q·(n−1) − floor). PURA.
 */
export function percentileCont(sorted: readonly number[], q: number): number | null {
  const n = sorted.length;
  if (!n) return null;
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (hi === lo) return sorted[lo];
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

const minutesSorted = (ms: number[]) => ms.sort((a, b) => a - b).map((x) => x / 60_000);
const pcts = (sorted: number[], qs: readonly number[]) => qs.map((q) => percentileCont(sorted, q));

interface DayPayload<T> { day: string; payload: T }

/** Payload guardado (JSON) → objeto; lixo → vazio. PURA. */
export function parseDayPayload<T extends GroupDayPayload | DriverDayPayload>(raw: unknown): T {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (v && typeof v === "object" && v.h && typeof v.h === "object") return v as T;
  } catch { /* lixo → vazio */ }
  return { h: {}, c: {} } as unknown as T;
}

/**
 * Dias guardados de um grupo → linhas iguais às das leituras antigas da
 * janela inteira (buildPressureSlotsSql e buildPressureLoadSql), prontas para
 * mapPressureSlotRow / mapPressureLoadRow. PURA.
 */
export function combineGroupDays(days: ReadonlyArray<DayPayload<GroupDayPayload>>): { slotRows: Array<Record<string, unknown>>; loadRows: Array<Record<string, unknown>> } {
  const cells = new Map<string, { wd: number; hr: number; ci: number; co: number; cis: number; cos: number; del: number[]; pik: number[] }>();
  const conc = new Map<string, number>();
  const loads = new Map<string, { lb: number; rush: boolean; ms: number[] }>();
  const cellOf = (wd: number, hr: number) => {
    const k = `${wd}:${hr}`;
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { wd, hr, ci: 0, co: 0, cis: 0, cos: 0, del: [], pik: [] }));
    return c;
  };
  for (const { day, payload } of days) {
    const wd = isoWeekday(day);
    for (const [hk, x] of Object.entries(payload.h ?? {})) {
      const hr = Number(hk);
      if (!Number.isInteger(hr) || !hourOk(hr)) continue;
      const c = cellOf(wd, hr);
      const del = x.del ?? [];
      c.ci += x.ci ?? 0; c.co += x.co ?? 0; c.cis += x.cis ?? 0; c.cos += x.cos ?? 0;
      for (const v of del) c.del.push(v);
      for (const v of x.pik ?? []) c.pik.push(v);
      // Carga da hora de calendário = check-ins + check-outs feitos nessa hora (desse dia).
      if (del.length) {
        const lb = loadBucketOf((x.ci ?? 0) + (x.co ?? 0));
        const rush = isRushHour(hr);
        const k = `${lb}:${rush ? 1 : 0}`;
        let l = loads.get(k);
        if (!l) loads.set(k, (l = { lb, rush, ms: [] }));
        for (const v of del) l.ms.push(v);
      }
    }
    for (const [hk, n] of Object.entries(payload.c ?? {})) conc.set(hk, (conc.get(hk) ?? 0) + n);
  }
  // Carros em mãos: por hora de relógio somam-se os dias; depois soma e máximo por (dia da semana, hora).
  const concCells = new Map<string, { wd: number; hr: number; sum: number; max: number }>();
  for (const [hk, n] of Array.from(conc)) {
    const wd = isoWeekday(hk.slice(0, 10));
    const hr = Number(hk.slice(11, 13));
    const k = `${wd}:${hr}`;
    const c = concCells.get(k);
    if (c) { c.sum += n; c.max = Math.max(c.max, n); } else concCells.set(k, { wd, hr, sum: n, max: n });
  }
  const keys = [...new Set([...cells.keys(), ...concCells.keys()])]
    .map((k) => k.split(":").map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const slotRows = keys.map(([wd, hr]) => {
    const c = cells.get(`${wd}:${hr}`);
    const cc = concCells.get(`${wd}:${hr}`);
    const del = minutesSorted(c?.del ?? []);
    const pik = minutesSorted(c?.pik ?? []);
    const [d50, d75, d90] = pcts(del, [0.5, 0.75, 0.9]);
    const [p50, p75] = pcts(pik, [0.5, 0.75]);
    return {
      wd, hr,
      ci_done: c?.ci ?? 0, co_done: c?.co ?? 0, ci_started: c?.cis ?? 0, co_started: c?.cos ?? 0,
      conc_sum: cc?.sum ?? 0, conc_max: cc ? cc.max : null,
      del_n: del.length, del_p50: d50, del_p75: d75, del_p90: d90,
      pik_n: pik.length, pik_p50: p50, pik_p75: p75,
    };
  });
  const loadRows = [...loads.values()]
    .sort((a, b) => a.lb - b.lb || Number(a.rush) - Number(b.rush))
    .map((l) => {
      const v = minutesSorted(l.ms);
      const [p50, p75, p90] = pcts(v, [0.5, 0.75, 0.9]);
      return { lb: l.lb, rush: l.rush, n: v.length, p50, p75, p90 };
    });
  return { slotRows, loadRows };
}

/** Escalão de pessoas como o CASE do SQL (crewBandCase): 1.º com índice > 0 que serve; senão 0. PURA. */
export function crewBandIndex(people: number, bands: readonly CrewMeasureBand[]): number {
  for (const b of bands) {
    if (b.index <= 0) continue;
    if (people >= b.min && (b.max === null || people <= b.max)) return b.index;
  }
  return 0;
}

/**
 * Dias guardados por condutor de uma cidade → linhas iguais às das leituras
 * antigas (buildPressureDriverSlotsSql e buildPressureCrewSql). As pessoas de
 * cada hora contam com o TL (27b: se nenhum TL agiu nessa hora, +1) com a
 * lista de TL de HOJE e os escalões da tabela de HOJE, como antes. PURA.
 */
export function combineDriverDays(
  days: ReadonlyArray<DayPayload<DriverDayPayload>>,
  tlAgentIds: readonly string[],
  bands: readonly CrewMeasureBand[],
): { driverRows: Array<Record<string, unknown>>; crewRows: Array<Record<string, unknown>> } {
  const tls = new Set(tlAgentIds.map((x) => String(x ?? "").trim()).filter(Boolean));
  const cells = new Map<string, { wd: number; hr: number; jobs: number; cy: number[]; dr: number[]; tp: number[]; crewSum: number; crewHours: number }>();
  const crew = new Map<string, { band: number; busy: boolean; ms: number[] }>();
  for (const { day, payload } of days) {
    const wd = isoWeekday(day);
    for (const [hk, x] of Object.entries(payload.h ?? {})) {
      const hr = Number(hk);
      if (!Number.isInteger(hr) || !hourOk(hr)) continue;
      const k = `${wd}:${hr}`;
      let c = cells.get(k);
      if (!c) cells.set(k, (c = { wd, hr, jobs: 0, cy: [], dr: [], tp: [], crewSum: 0, crewHours: 0 }));
      const u = x.u ?? [];
      const cy = x.cy ?? [];
      const jobs = x.jobs ?? 0;
      const agents = u.length;
      const people = agents ? agents + (u.some((id) => tls.has(id)) ? 0 : 1) : 0;
      c.jobs += jobs;
      for (const v of cy) c.cy.push(v);
      for (const v of x.dr ?? []) c.dr.push(v);
      for (const v of x.tp ?? []) c.tp.push(v);
      if (agents) { c.crewSum += people; c.crewHours++; }
      if (cy.length) {
        const band = crewBandIndex(people, bands);
        // "Hora cheia": serviços começados nessa hora ≥ pessoas que agiram (sem o TL a mais).
        const busy = jobs >= Math.max(agents || 1, 1);
        const kk = `${band}:${busy ? 1 : 0}`;
        let g = crew.get(kk);
        if (!g) crew.set(kk, (g = { band, busy, ms: [] }));
        for (const v of cy) g.ms.push(v);
      }
    }
  }
  const driverRows = [...cells.values()]
    .filter((c) => c.jobs > 0 || c.crewHours > 0)
    .sort((a, b) => a.wd - b.wd || a.hr - b.hr)
    .map((c) => {
      const cy = minutesSorted(c.cy);
      const dr = minutesSorted(c.dr);
      const tp = minutesSorted(c.tp);
      const [cy50, cy60, cy75, cy85, cy90] = pcts(cy, [0.5, 0.6, 0.75, 0.85, 0.9]);
      const [dr50, dr75, dr90] = pcts(dr, [0.5, 0.75, 0.9]);
      const [tp50, tp75] = pcts(tp, [0.5, 0.75]);
      return {
        wd: c.wd, hr: c.hr,
        cy_n: cy.length, cy_p50: cy50, cy_p60: cy60, cy_p75: cy75, cy_p85: cy85, cy_p90: cy90,
        dr_n: dr.length, dr_p50: dr50, dr_p75: dr75, dr_p90: dr90,
        tp_n: tp.length, tp_p50: tp50, tp_p75: tp75,
        crew_avg: c.crewHours ? c.crewSum / c.crewHours : null,
      };
    });
  const crewRows = [...crew.values()]
    .sort((a, b) => a.band - b.band || Number(a.busy) - Number(b.busy))
    .map((g) => {
      const v = minutesSorted(g.ms);
      const [p50, p60, p75, p85, p90] = pcts(v, [0.5, 0.6, 0.75, 0.85, 0.9]);
      return { band: g.band, busy: g.busy, n: v.length, p50, p60, p75, p85, p90 };
    });
  return { driverRows, crewRows };
}
