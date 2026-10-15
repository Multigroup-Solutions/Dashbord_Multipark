/**
 * Atividade diária → separador "Semana" (Jorge, 12 out 2026: "quantas coisas
 * houve naquele dia, quanto é que demorámos em cada hora a recolher ou a
 * entregar, quantas entregas houve"). PARTILHADO (servidor e página). PURO.
 *
 * Uma semana de domingo a sábado; cada linha é um DIA OPERACIONAL (03:00 →
 * 03:00 de Lisboa, como o resto da página), por isso as colunas vão das 03h
 * às 02h (00–02 = a madrugada a seguir, ainda desse dia). Por célula
 * (dia operacional × hora de Lisboa), para as entregas OU para as recolhas:
 *   - quantidade: carros entregues (check-out feito) / recolhidos (check-in
 *     feito) nessa hora — os mesmos "feitos" da Pressão;
 *   - tempo por carro: a métrica da Pressão (início de um serviço → início do
 *     serviço seguinte do mesmo condutor), dos serviços desse tipo começados
 *     nessa hora — n, média, mediana e p75;
 *   - espera: entregas = pendente → entregue (pela hora do pedido); recolhas =
 *     recolha começada → feita (pela hora do início) — n, média, p75, máximo;
 *   - pedidos: pedidos de entrega / recolhas começadas nessa hora;
 *   - pessoas: agentes diferentes com ações nessa hora.
 * Totais por dia (linha) e por hora (coluna): somas e percentis sobre TODOS os
 * casos (não a média das células).
 *
 * As entradas são as linhas por (dia de calendário, hora) das leituras da
 * Pressão (server/multiparkDb/pressure.ts → server/pressureDays.ts): o
 * mesmo formato dos dias guardados, por isso uma semana passada pode vir da
 * nossa BD sem ler a Multipark.
 */
import { addDays, OPERATIONAL_DAY_START_HOUR } from "./lisbonDay";
import { isoWeekday, percentile } from "./extrasPressure";

/** Colunas pela ordem do dia operacional: 03h … 23h, 00h, 01h, 02h. */
export const WEEK_HOURS: readonly number[] = [
  ...Array.from({ length: 24 - OPERATIONAL_DAY_START_HOUR }, (_, i) => i + OPERATIONAL_DAY_START_HOUR),
  ...Array.from({ length: OPERATIONAL_DAY_START_HOUR }, (_, i) => i),
];

export type WeekKind = "entregas" | "recolhas";
export type WeekMeasure = "quantidade" | "tempo";

/** Abreviaturas a começar no domingo (a semana desta vista). */
export const WEEK_DAY_SHORT: Record<number, string> = { 7: "Dom", 1: "Seg", 2: "Ter", 3: "Qua", 4: "Qui", 5: "Sex", 6: "Sáb" };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Domingo da semana de um dia (o próprio, se for domingo). PURA. */
export function weekStartOf(day: string): string {
  if (!DAY_RE.test(day)) throw new Error(`Dia inválido: ${day}`);
  return addDays(day, -(isoWeekday(day) % 7));
}

/** Os 7 dias operacionais da semana (domingo → sábado). PURA. */
export function weekOpDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** Os 8 dias de calendário a ler: domingo → domingo seguinte (00–02h do último). PURA. */
export function weekCalendarDays(weekStart: string): string[] {
  return Array.from({ length: 8 }, (_, i) => addDays(weekStart, i));
}

/** (dia operacional, hora de Lisboa) → (dia de calendário, hora): 00–02h são do dia seguinte. PURA. */
export function opSlotToCalendar(opDay: string, hour: number): { day: string; hour: number } {
  return hour < OPERATIONAL_DAY_START_HOUR ? { day: addDays(opDay, 1), hour } : { day: opDay, hour };
}

/** Uma hora de um dia guardado/lido da parte "grupo" (check-ins/outs feitos e começados, durações em ms). */
export interface WeekGroupHour { ci?: number; co?: number; cis?: number; cos?: number; del?: number[]; pik?: number[] }
/** Uma hora da parte "por condutor" (tempo por carro por tipo de serviço, em ms; quem agiu). */
export interface WeekDriverHour { cyo?: number[]; cyi?: number[]; u?: string[] }
export type WeekDayMap<T> = Readonly<Record<string, { h?: Readonly<Record<string, T>> } | undefined>>;

/** Minutos: casos, média, mediana, p75 e máximo (1 casa decimal). */
export interface DurStats { n: number; avg: number | null; p50: number | null; p75: number | null; max: number | null }

export interface WeekCell {
  /** Entregues / recolhidos nessa hora. */
  count: number;
  /** Pedidos de entrega / recolhas começadas nessa hora. */
  requested: number;
  /** Tempo por carro (a métrica da Pressão) dos serviços começados nessa hora. */
  cycle: DurStats;
  /** Entregas: pendente → entregue; recolhas: começada → feita. */
  wait: DurStats;
  /** Agentes diferentes com ações nessa hora (entregas e recolhas). */
  people: number;
  /** Hora que ainda não chegou (semana atual). */
  future?: boolean;
}

export interface WeekRow { day: string; weekday: number; cells: WeekCell[]; total: WeekCell; future: boolean }

export interface WeekGrid {
  kind: WeekKind;
  /** Horas de cada coluna (WEEK_HOURS). */
  hours: number[];
  rows: WeekRow[];
  /** Total de cada coluna (a semana toda nessa hora). */
  hourTotals: WeekCell[];
  total: WeekCell;
}

const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

/** Durações (ms) → estatística em minutos. PURA. */
export function durStats(ms: readonly number[]): DurStats {
  const mins = ms.filter((x) => Number.isFinite(x) && x >= 0).map((x) => x / 60_000).sort((a, b) => a - b);
  if (!mins.length) return { n: 0, avg: null, p50: null, p75: null, max: null };
  return {
    n: mins.length,
    avg: r1(mins.reduce((a, b) => a + b, 0) / mins.length),
    p50: r1(percentile(mins, 0.5)),
    p75: r1(percentile(mins, 0.75)),
    max: r1(mins[mins.length - 1]),
  };
}

interface Acc { count: number; requested: number; cycle: number[]; wait: number[]; people: Set<string> }
const acc = (): Acc => ({ count: 0, requested: 0, cycle: [], wait: [], people: new Set() });
const add = (into: Acc, from: Acc) => {
  into.count += from.count;
  into.requested += from.requested;
  for (const v of from.cycle) into.cycle.push(v);
  for (const v of from.wait) into.wait.push(v);
  from.people.forEach((p) => into.people.add(p));
};
const cellOf = (a: Acc, future?: boolean): WeekCell => ({
  count: a.count, requested: a.requested, cycle: durStats(a.cycle), wait: durStats(a.wait), people: a.people.size, ...(future ? { future: true } : {}),
});

/**
 * As duas grelhas da semana (entregas e recolhas). `now` = { dia, hora } de
 * Lisboa de agora (as horas depois disto ficam marcadas "future"); sem ele,
 * nada é futuro. PURA.
 */
export function buildWeekGrids(
  weekStart: string,
  group: WeekDayMap<WeekGroupHour>,
  driver: WeekDayMap<WeekDriverHour>,
  now?: { day: string; hour: number } | null,
): Record<WeekKind, WeekGrid> {
  const isFuture = (day: string, hour: number) => !!now && (day > now.day || (day === now.day && hour > now.hour));
  const build = (kind: WeekKind): WeekGrid => {
    const hourAcc = WEEK_HOURS.map(() => acc());
    const all = acc();
    const rows: WeekRow[] = weekOpDays(weekStart).map((opDay) => {
      const rowAcc = acc();
      let rowFuture = true;
      const cells = WEEK_HOURS.map((hour, i) => {
        const cal = opSlotToCalendar(opDay, hour);
        const g = group[cal.day]?.h?.[String(hour)];
        const d = driver[cal.day]?.h?.[String(hour)];
        const a = acc();
        if (g) {
          a.count = kind === "entregas" ? g.co ?? 0 : g.ci ?? 0;
          a.requested = kind === "entregas" ? g.cos ?? 0 : g.cis ?? 0;
          for (const v of (kind === "entregas" ? g.del : g.pik) ?? []) a.wait.push(v);
        }
        if (d) {
          for (const v of (kind === "entregas" ? d.cyo : d.cyi) ?? []) a.cycle.push(v);
          for (const u of d.u ?? []) a.people.add(u);
        }
        add(rowAcc, a);
        add(hourAcc[i], a);
        const future = isFuture(cal.day, cal.hour);
        if (!future) rowFuture = false;
        return cellOf(a, future);
      });
      add(all, rowAcc);
      return { day: opDay, weekday: isoWeekday(opDay), cells, total: cellOf(rowAcc), future: rowFuture };
    });
    return { kind, hours: [...WEEK_HOURS], rows, hourTotals: hourAcc.map((a) => cellOf(a)), total: cellOf(all) };
  };
  return { entregas: build("entregas"), recolhas: build("recolhas") };
}

/** Valor mostrado numa célula: a quantidade, ou o p75 do tempo por carro (null = sem casos). PURA. */
export function weekCellValue(c: WeekCell, measure: WeekMeasure): number | null {
  if (measure === "quantidade") return c.count > 0 ? c.count : null;
  return c.cycle.n > 0 ? c.cycle.p75 : null;
}

/** "12/10" do dia "2026-10-12". PURA. */
export function ddmm(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}
