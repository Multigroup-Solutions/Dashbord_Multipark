/**
 * Filtros das listas de pessoas (Condutores, Agentes, Desempenho) — Jorge,
 * 14 out 2026: "não tem sequer um sítio para escrever um nome" e "um filtro
 * que dê para eu pôr parâmetros". Pesquisa por nome (sem acentos nem
 * maiúsculas) e regras "coluna ≥ / ≤ valor", todas ao mesmo tempo. PURO.
 */
import { z } from "zod";

export const METRIC_RULE_OPS = ["gte", "lte"] as const;
export type MetricRuleOp = (typeof METRIC_RULE_OPS)[number];
export const METRIC_RULE_OP_LABELS: Record<MetricRuleOp, string> = { gte: "≥", lte: "≤" };

export interface MetricRule { key: string; op: MetricRuleOp; value: number }

export const metricRuleSchema = z.object({
  key: z.string().min(1).max(64),
  op: z.enum(METRIC_RULE_OPS),
  value: z.number().finite(),
});

/** Texto para comparar: minúsculas, sem acentos, espaços simples. */
export function foldName(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Todas as palavras da pesquisa aparecem num dos textos ("joao alv" encontra "João Alves"). */
export function matchesSearch(query: string, ...texts: Array<string | null | undefined>): boolean {
  const words = foldName(query).split(" ").filter(Boolean);
  if (!words.length) return true;
  const hay = texts.map(foldName).join(" ");
  return words.every((w) => hay.includes(w));
}

/** Número escrito pela pessoa ("4,5", "10") → número; vazio ou lixo → null. */
export function parseRuleValue(txt: string): number | null {
  const t = String(txt ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * A linha passa em todas as regras? Um valor em falta (null: "—", sem horas
 * suficientes) não passa em nenhuma regra — não se sabe se cumpre.
 */
export function passesRules<T>(row: T, rules: readonly MetricRule[], valueOf: (row: T, key: string) => number | null | undefined): boolean {
  for (const r of rules) {
    const v = valueOf(row, r.key);
    if (v == null || !Number.isFinite(v)) return false;
    if (r.op === "gte" ? v < r.value : v > r.value) return false;
  }
  return true;
}

/** Junta uma regra; a mesma coluna e o mesmo sinal substituem a anterior. */
export function upsertRule(rules: readonly MetricRule[], rule: MetricRule): MetricRule[] {
  return [...rules.filter((r) => !(r.key === rule.key && r.op === rule.op)), rule];
}
