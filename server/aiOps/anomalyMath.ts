/**
 * Deteção estatística de anomalias — TUDO PURO (sem BD, sem IA).
 *
 *  - séries diárias (reservas por parque/canal, gasto e ROAS do marketing):
 *    z-score do dia contra o MESMO dia da semana nas últimas 8 semanas
 *    (segunda com segundas, etc.), com desvio mínimo para contagens pequenas;
 *  - despesas: valor fora do normal para o fornecedor/categoria (mediana +
 *    MAD, "z robusto") e possíveis duplicados (mesmo fornecedor e valor em
 *    ≤ 3 dias, ou mesmo nº de documento).
 * A IA só escreve depois uma linha de explicação por anomalia.
 */
import { addDays } from "../../shared/lisbonDay";

export const HISTORY_WEEKS = 8;
export const Z_THRESHOLD = 2.5;
export const Z_CRITICAL = 3.5;
export const MIN_HISTORY_POINTS = 4;

export type Severity = "warning" | "critical";

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Desvio padrão amostral (n−1); 0 com menos de 2 pontos. */
export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Os mesmos dias da semana antes de `day` (day−7, day−14, …). */
export function sameWeekdayDays(day: string, weeks = HISTORY_WEEKS): string[] {
  return Array.from({ length: weeks }, (_, i) => addDays(day, -7 * (i + 1)));
}

/**
 * z-score de `value` contra o histórico. `minStd` evita divisões por quase 0
 * (ex.: um parque que tem sempre 3 reservas). null = histórico insuficiente.
 */
export function zScore(value: number, history: number[], opts: { minStd?: number; minHistory?: number } = {}): { z: number; expected: number; std: number } | null {
  if (history.length < (opts.minHistory ?? MIN_HISTORY_POINTS)) return null;
  const expected = mean(history);
  const std = Math.max(stdDev(history), opts.minStd ?? 0);
  if (std <= 0) return value === expected ? { z: 0, expected, std: 0 } : null;
  return { z: (value - expected) / std, expected, std };
}

/** Desvio mínimo para contagens (Poisson): √média, pelo menos 1. */
export function countMinStd(history: number[]): number {
  return Math.max(1, Math.sqrt(Math.max(0, mean(history))));
}

export function severityOf(z: number): Severity {
  return Math.abs(z) >= Z_CRITICAL ? "critical" : "warning";
}

export interface SeriesInput {
  subject: string;
  /** dia (AAAA-MM-DD) → valor. Dias em falta contam como 0 se `fillMissing`. */
  values: Map<string, number>;
}

export interface SeriesAnomaly {
  subject: string;
  day: string;
  value: number;
  expected: number;
  z: number;
  direction: "up" | "down";
  severity: Severity;
}

export function detectSeriesAnomalies(
  day: string,
  series: SeriesInput[],
  opts: {
    weeks?: number;
    threshold?: number;
    fillMissing?: boolean;
    /** para contagens: desvio mínimo √média */
    counts?: boolean;
    minStd?: number;
    /** ignora séries cujo valor esperado E o do dia estão abaixo disto (ruído) */
    minMagnitude?: number;
    /** só estes sentidos */
    directions?: Array<"up" | "down">;
  } = {},
): SeriesAnomaly[] {
  const weeks = opts.weeks ?? HISTORY_WEEKS;
  const threshold = opts.threshold ?? Z_THRESHOLD;
  const out: SeriesAnomaly[] = [];
  for (const s of series) {
    const histDays = sameWeekdayDays(day, weeks);
    const history: number[] = [];
    for (const d of histDays) {
      const v = s.values.get(d);
      if (v != null && Number.isFinite(v)) history.push(v);
      else if (opts.fillMissing) history.push(0);
    }
    const value = s.values.get(day) ?? (opts.fillMissing ? 0 : NaN);
    if (!Number.isFinite(value)) continue;
    const minStd = Math.max(opts.minStd ?? 0, opts.counts ? countMinStd(history) : 0);
    const r = zScore(value, history, { minStd });
    if (!r) continue;
    if (opts.minMagnitude != null && Math.max(Math.abs(value), Math.abs(r.expected)) < opts.minMagnitude) continue;
    if (Math.abs(r.z) < threshold) continue;
    const direction = r.z > 0 ? "up" : "down";
    if (opts.directions && !opts.directions.includes(direction)) continue;
    out.push({ subject: s.subject, day, value, expected: round2(r.expected), z: round2(r.z), direction, severity: severityOf(r.z) });
  }
  return out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ─── Despesas ────────────────────────────────────────────────────────────────

export interface ExpenseLite {
  id: number;
  day: string;
  amount: number;
  supplier: string | null;
  supplierNif: string | null;
  documentNumber: string | null;
  categoryId: number | null;
  projectId: number | null;
}

export function normalizeSupplier(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(lda|sa|unipessoal|limitada|s\.a\.)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function supplierKey(e: ExpenseLite): string | null {
  const nif = String(e.supplierNif ?? "").replace(/\D/g, "");
  if (nif.length >= 9) return `nif:${nif}`;
  const n = normalizeSupplier(e.supplier);
  return n ? `sup:${n}` : null;
}

export interface ExpenseOutlier { expense: ExpenseLite; groupLabel: string; median: number; robustZ: number; severity: Severity }

/**
 * Valores fora do normal: para cada despesa RECENTE (dia ≥ `since`), compara
 * com o histórico do MESMO fornecedor (senão da mesma categoria) — z robusto
 * 0,6745·(x − mediana)/MAD ≥ 3,5, pelo menos 2,5× a mediana e pelo menos
 * `minAmount` €. Só para cima.
 */
export function expenseOutliers(rows: ExpenseLite[], since: string, opts: { minAmount?: number; minHistory?: number; threshold?: number; minRatio?: number } = {}): ExpenseOutlier[] {
  const minAmount = opts.minAmount ?? 100;
  const minHistory = opts.minHistory ?? 5;
  const threshold = opts.threshold ?? 3.5;
  const minRatio = opts.minRatio ?? 2.5;
  const groups = new Map<string, ExpenseLite[]>();
  for (const e of rows) {
    const keys = [supplierKey(e), e.categoryId != null ? `cat:${e.categoryId}` : null].filter((k): k is string => !!k);
    for (const k of keys) {
      const list = groups.get(k) ?? [];
      list.push(e);
      groups.set(k, list);
    }
  }
  const out: ExpenseOutlier[] = [];
  for (const e of rows) {
    if (e.day < since || e.amount < minAmount) continue;
    for (const k of [supplierKey(e), e.categoryId != null ? `cat:${e.categoryId}` : null]) {
      if (!k) continue;
      const hist = (groups.get(k) ?? []).filter((x) => x.id !== e.id && x.day < since).map((x) => x.amount);
      if (hist.length < minHistory) continue;
      const med = median(hist);
      const mad = median(hist.map((x) => Math.abs(x - med)));
      const scale = Math.max(mad, med * 0.05, 1);
      const rz = (0.6745 * (e.amount - med)) / scale;
      if (rz >= threshold && e.amount >= med * minRatio) out.push({ expense: e, groupLabel: k.startsWith("cat:") ? "categoria" : "fornecedor", median: round2(med), robustZ: round2(rz), severity: rz >= threshold * 2 ? "critical" : "warning" });
      break; // o fornecedor ganha à categoria; só uma vez por despesa
    }
  }
  return out;
}

export interface DuplicatePair { a: ExpenseLite; b: ExpenseLite; reason: "document" | "same_amount" }

/** Possíveis duplicados: mesmo nº de documento do mesmo fornecedor, ou mesmo fornecedor + valor em ≤ `maxDays` dias. Pelo menos uma das duas é recente. */
export function duplicateExpenses(rows: ExpenseLite[], since: string, opts: { maxDays?: number } = {}): DuplicatePair[] {
  const maxDays = opts.maxDays ?? 3;
  const out: DuplicatePair[] = [];
  const seen = new Set<string>();
  const sorted = [...rows].sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : x.id - y.id));
  const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const ka = supplierKey(a);
    if (!ka) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (dayNum(b.day) - dayNum(a.day) > 45) break;
      if (a.day < since && b.day < since) continue;
      if (supplierKey(b) !== ka) continue;
      const docA = String(a.documentNumber ?? "").trim().toLowerCase();
      const sameDoc = !!docA && docA === String(b.documentNumber ?? "").trim().toLowerCase();
      const sameAmount = Math.abs(a.amount - b.amount) < 0.005 && dayNum(b.day) - dayNum(a.day) <= maxDays;
      if (!sameDoc && !sameAmount) continue;
      const key = `${a.id}-${b.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ a, b, reason: sameDoc ? "document" : "same_amount" });
    }
  }
  return out;
}
