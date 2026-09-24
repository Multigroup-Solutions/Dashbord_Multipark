/**
 * TAXAS COM DATA DE EFEITO (IVA / TSU patronal) — Definições → Finanças e
 * Marketing.
 *
 * As taxas vivem em `app_settings` (`finance.vat` / `finance.tsu`, listas
 * `{ rate, from }` validadas por shared/appSettings.ts). Num dia aplica-se a
 * taxa cuja data de efeito é a MAIS RECENTE que não passa desse dia. Sem nada
 * gravado — ou num dia anterior à primeira data de efeito — usa-se a constante
 * FINANCE_PARAMS (./rules.ts), por isso o comportamento só muda quando alguém
 * grava uma taxa.
 *
 * Parte PURA (rateOn / splitByRate / makeFinanceRates / rateCaseSql) + leitura
 * da BD com cache de 60 s (invalidada ao gravar a definição — setSetting).
 */
import { sql, type SQL } from "drizzle-orm";
import { effectiveRate, type RateEntry } from "../../shared/appSettings";
import { getSetting } from "../appSettings";
import { FINANCE_PARAMS, addDays } from "./rules";

export interface RatePeriod {
  /** primeiro dia (inclusive) */
  from: string;
  /** último dia (inclusive) */
  to: string;
  rate: number;
}

/** Taxa em vigor num dia; antes da 1.ª data de efeito (ou sem lista) → `fallback`. PURA. */
export function rateOn(list: readonly RateEntry[] | null | undefined, day: string, fallback: number): number {
  return effectiveRate(list, day) ?? fallback;
}

/**
 * Parte [from, to] em sub-períodos com taxa constante (corta em cada data de
 * efeito que cai dentro do intervalo; junta vizinhos com a mesma taxa). PURA.
 */
export function splitByRate(list: readonly RateEntry[] | null | undefined, from: string, to: string, fallback: number): RatePeriod[] {
  if (from > to) return [];
  const cuts = Array.from(new Set((list ?? []).map((e) => e.from).filter((d) => d > from && d <= to))).sort();
  const out: RatePeriod[] = [];
  let start = from;
  for (const cut of [...cuts, null]) {
    const end = cut ? addDays(cut, -1) : to;
    const rate = rateOn(list, start, fallback);
    const last = out[out.length - 1];
    if (last && last.rate === rate) last.to = end;
    else out.push({ from: start, to: end, rate });
    if (cut) start = cut;
  }
  return out;
}

export interface FinanceRates {
  /** listas gravadas (null = nada gravado → constante) */
  vat: readonly RateEntry[] | null;
  tsu: readonly RateEntry[] | null;
  vatOn(day: string): number;
  tsuOn(day: string): number;
  vatPeriods(from: string, to: string): RatePeriod[];
  tsuPeriods(from: string, to: string): RatePeriod[];
}

/** Resolvedor a partir das listas gravadas; fallback = FINANCE_PARAMS. PURA. */
export function makeFinanceRates(
  vat: readonly RateEntry[] | null | undefined,
  tsu: readonly RateEntry[] | null | undefined,
  fallback: { vatRate: number; tsuEmployerRate: number } = FINANCE_PARAMS,
): FinanceRates {
  const v = vat && vat.length ? [...vat] : null;
  const t = tsu && tsu.length ? [...tsu] : null;
  return {
    vat: v,
    tsu: t,
    vatOn: (day) => rateOn(v, day, fallback.vatRate),
    tsuOn: (day) => rateOn(t, day, fallback.tsuEmployerRate),
    vatPeriods: (from, to) => splitByRate(v, from, to, fallback.vatRate),
    tsuPeriods: (from, to) => splitByRate(t, from, to, fallback.tsuEmployerRate),
  };
}

/** Sem nada gravado: as constantes de sempre. */
export const DEFAULT_FINANCE_RATES: FinanceRates = makeFinanceRates(null, null);

/**
 * Expressão SQL com a taxa (fração) de cada linha, pelos sub-períodos:
 * `CASE WHEN <dia> < ? THEN ? … ELSE ? END` — datas e taxas vão SEMPRE como
 * parâmetros. `boundary` converte o 1.º dia de cada sub-período no valor a
 * comparar com `expr` (por omissão o próprio dia "AAAA-MM-DD"; para colunas
 * UTC passa-se a meia-noite de Lisboa em UTC). Sem períodos → constante.
 */
export function rateCaseSql(expr: SQL, periods: readonly RatePeriod[], fallback: number, boundary: (day: string) => string = (d) => d): SQL {
  if (periods.length === 0) return sql`${fallback}`;
  if (periods.length === 1) return sql`${periods[0].rate}`;
  const whens = periods.slice(0, -1).map((p, i) => sql`WHEN ${expr} < ${boundary(periods[i + 1].from)} THEN ${p.rate}`);
  return sql`(CASE ${sql.join(whens, sql` `)} ELSE ${periods[periods.length - 1].rate} END)`;
}

// ─── Leitura da BD (cache 60 s) ─────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
let cache: { at: number; rates: FinanceRates } | null = null;

export function invalidateFinanceRatesCache(): void {
  cache = null;
}

/** Taxas gravadas nas Definições (nunca lança: em erro → constantes). */
export async function loadFinanceRates(): Promise<FinanceRates> {
  if (cache && Date.now() - cache.at <= CACHE_TTL_MS) return cache.rates;
  let rates = DEFAULT_FINANCE_RATES;
  try {
    const [vat, tsu] = await Promise.all([getSetting("finance.vat"), getSetting("finance.tsu")]);
    rates = makeFinanceRates(vat, tsu);
  } catch {
    rates = DEFAULT_FINANCE_RATES;
  }
  cache = { at: Date.now(), rates };
  return rates;
}

export interface ResolvedFinanceRates {
  rates: FinanceRates;
  vatPeriods: RatePeriod[];
  tsuPeriods: RatePeriod[];
  /** taxa em vigor no último dia do período (apresentação / fallback documentado) */
  vatAtEnd: number;
  tsuAtEnd: number;
}

/** Taxas para um período [from, to] (dias de Lisboa, inclusivos). */
export async function resolveFinanceRates(from: string, to: string, preloaded?: FinanceRates): Promise<ResolvedFinanceRates> {
  const rates = preloaded ?? (await loadFinanceRates());
  return {
    rates,
    vatPeriods: rates.vatPeriods(from, to),
    tsuPeriods: rates.tsuPeriods(from, to),
    vatAtEnd: rates.vatOn(to),
    tsuAtEnd: rates.tsuOn(to),
  };
}

/** Dia de hoje em Lisboa (AAAA-MM-DD). */
export function lisbonTodayIso(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

/** Taxas (IVA / TSU) em vigor num dia — Definições, senão FINANCE_PARAMS. */
export async function financeRatesAt(day: string): Promise<{ vatRate: number; tsuEmployerRate: number }> {
  const rates = await loadFinanceRates();
  return { vatRate: rates.vatOn(day), tsuEmployerRate: rates.tsuOn(day) };
}

/**
 * IVA para um indicador AGREGADO de um período (ex.: ROAS = receita ÷ gasto
 * do período inteiro, sem série diária): usa-se a taxa em vigor no ÚLTIMO dia
 * do período. Um rácio agregado não se pode partir por data de efeito sem
 * refazer as somas dia a dia, e uma mudança de IVA a meio de um período de
 * marketing é rara; a taxa do fim é a que vale para o período "atual".
 */
export async function vatRateForPeriod(_from: string, to: string): Promise<number> {
  const rates = await loadFinanceRates();
  return rates.vatOn(to);
}
