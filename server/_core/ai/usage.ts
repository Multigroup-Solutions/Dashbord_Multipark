/**
 * Registo de uso/custo da IA (tabela ai_usage_log, migração 0111) e
 * orçamento mensal.
 *
 *  - Só METADADOS: nunca o prompt, a resposta nem dados pessoais.
 *  - Custo estimado em EUR a partir da tabela de preços (pricing.ts) com as
 *    sobreposições de Definições (`ai.priceOverridesEur`).
 *  - Orçamento (`ai.monthlyBudgetEur` → AI_MONTHLY_BUDGET_EUR → 30 €), por mês
 *    civil UTC: ≥100% bloqueia as funcionalidades não essenciais, ≥150% todas;
 *    na primeira vez de cada mês avisa os admins (ai_budget_alerts).
 */
import { sql } from "drizzle-orm";
import type { AiPriceOverrides } from "../../../shared/appSettings";
import { AiBudgetExceededError } from "./errors";
import { AI_FEATURES, isAiFeature } from "../../../shared/aiFeatures";

export type AiUsageStatus = "ok" | "error" | "blocked";

export interface AiUsageRow {
  feature: string;
  tier: string;
  provider: string;
  model: string;
  userId?: number | null;
  entity?: string | null;
  entityId?: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costEur: number;
  latencyMs: number;
  status: AiUsageStatus;
  errorCode?: string | null;
}

export const DEFAULT_MONTHLY_BUDGET_EUR = 30;
/** As essenciais só param quando o gasto passa este múltiplo do orçamento. */
export const ESSENTIAL_BUDGET_FACTOR = 1.5;
const SPEND_CACHE_MS = 60_000;

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const affectedRows = (res: unknown): number => {
  const h = Array.isArray(res) ? res[0] : res;
  return Number((h as any)?.affectedRows ?? 0);
};

async function db() {
  const { getDb } = await import("../../db");
  return getDb();
}

/** "AAAA-MM-DD HH:MM:SS.mmm" (UTC). PURA. */
export function mysqlUtc(d: Date): string {
  return d.toISOString().slice(0, 23).replace("T", " ");
}

/** Mês civil UTC de um instante: rótulo e limites [início, fim). PURA. */
export function monthBounds(now: number | Date = Date.now()): { month: string; start: string; end: string } {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  return { month: start.toISOString().slice(0, 7), start: mysqlUtc(start).slice(0, 19), end: mysqlUtc(end).slice(0, 19) };
}

/** Orçamento: bloqueia? (0 ou negativo = sem limite). PURA. */
export function budgetDecision(spentEur: number, budgetEur: number, essential: boolean): "ok" | "blocked" {
  if (!(budgetEur > 0)) return "ok";
  const limit = essential ? budgetEur * ESSENTIAL_BUDGET_FACTOR : budgetEur;
  return spentEur >= limit ? "blocked" : "ok";
}

// ─── Gasto do mês (cache curta por processo) ────────────────────────────────

let spendCache: { month: string; at: number; value: number } | null = null;

/** Só testes. */
export function resetAiUsageCachesForTests(): void {
  spendCache = null;
}

export async function monthSpendEur(now: number = Date.now(), opts: { fresh?: boolean } = {}): Promise<number> {
  const b = monthBounds(now);
  if (!opts.fresh && spendCache && spendCache.month === b.month && now - spendCache.at < SPEND_CACHE_MS) return spendCache.value;
  const d = await db();
  if (!d) return spendCache?.month === b.month ? spendCache.value : 0;
  const res = await d.execute(sql`SELECT COALESCE(SUM(costEur), 0) AS spent FROM ai_usage_log WHERE createdAt >= ${b.start} AND createdAt < ${b.end}`);
  const value = Number(rowsOf(res)[0]?.spent ?? 0) || 0;
  spendCache = { month: b.month, at: now, value };
  return value;
}

export async function getMonthlyBudgetEur(env: Record<string, string | undefined> = process.env): Promise<number> {
  try {
    const { getSetting } = await import("../../appSettings");
    const v = await getSetting("ai.monthlyBudgetEur");
    if (typeof v === "number") return v;
  } catch { /* sem BD: env / omissão */ }
  const raw = Number(String(env.AI_MONTHLY_BUDGET_EUR ?? "").trim());
  return String(env.AI_MONTHLY_BUDGET_EUR ?? "").trim() !== "" && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MONTHLY_BUDGET_EUR;
}

export async function getPriceOverrides(): Promise<AiPriceOverrides | null> {
  try {
    const { getSetting } = await import("../../appSettings");
    return (await getSetting("ai.priceOverridesEur")) ?? null;
  } catch {
    return null;
  }
}

/** Aviso aos admins, UMA vez por mês (INSERT IGNORE). Nunca lança. */
export async function notifyBudgetExceededOnce(month: string, spentEur: number, budgetEur: number): Promise<boolean> {
  try {
    const d = await db();
    if (!d) return false;
    const res = await d.execute(sql`INSERT IGNORE INTO ai_budget_alerts (month, spentEur, budgetEur) VALUES (${month}, ${spentEur.toFixed(4)}, ${budgetEur.toFixed(4)})`);
    if (affectedRows(res) !== 1) return false;
    const { notifyAdmins } = await import("../../syncHealth");
    await notifyAdmins(
      "Orçamento da IA atingido",
      `A IA já gastou cerca de ${spentEur.toFixed(2).replace(".", ",")} € este mês (orçamento: ${budgetEur.toFixed(2).replace(".", ",")} €). As funcionalidades não essenciais ficam em pausa até ao próximo mês ou até o orçamento subir em Definições → Parâmetros.`,
      "/definicoes",
    );
    return true;
  } catch (err: any) {
    console.warn("[ai] aviso de orçamento falhou:", String(err?.code ?? err?.name ?? "erro"));
    return false;
  }
}

/** Lança AiBudgetExceededError se o orçamento não deixar esta funcionalidade correr. */
export async function enforceBudget(essential: boolean, now: number = Date.now()): Promise<void> {
  let spent = 0;
  let budget = DEFAULT_MONTHLY_BUDGET_EUR;
  try {
    [spent, budget] = await Promise.all([monthSpendEur(now), getMonthlyBudgetEur()]);
  } catch {
    return; // sem BD não se consegue medir: não bloqueia
  }
  // Aguardado (no Vercel, trabalho solto depois da resposta pode morrer).
  if (budget > 0 && spent >= budget) await notifyBudgetExceededOnce(monthBounds(now).month, spent, budget);
  if (budgetDecision(spent, budget, essential) === "blocked") throw new AiBudgetExceededError();
}

// ─── Registo ────────────────────────────────────────────────────────────────

const cut = (v: string | null | undefined, n: number) => (v == null ? null : String(v).slice(0, n));
const int = (v: unknown) => Math.max(0, Math.min(2_000_000_000, Math.round(Number(v) || 0)));

/** Grava uma linha (nunca lança; nunca bloqueia a funcionalidade). */
export async function logAiUsage(row: AiUsageRow, now: Date = new Date()): Promise<void> {
  const cost = Math.max(0, Number(row.costEur) || 0);
  const month = monthBounds(now.getTime()).month;
  if (spendCache && spendCache.month === month) spendCache = { ...spendCache, value: spendCache.value + cost };
  try {
    const d = await db();
    if (!d) return;
    await d.execute(sql`
      INSERT INTO ai_usage_log
        (createdAt, feature, tier, provider, model, userId, entity, entityId,
         inputTokens, outputTokens, cachedTokens, costEur, latencyMs, status, errorCode)
      VALUES
        (${mysqlUtc(now)}, ${cut(row.feature, 40)}, ${cut(row.tier, 8)}, ${cut(row.provider, 16)}, ${cut(row.model, 80)},
         ${row.userId ?? null}, ${cut(row.entity ?? null, 40)}, ${row.entityId ?? null},
         ${int(row.inputTokens)}, ${int(row.outputTokens)}, ${int(row.cachedTokens)}, ${cost.toFixed(6)}, ${int(row.latencyMs)},
         ${row.status}, ${cut(row.errorCode ?? null, 40)})`);
  } catch (err: any) {
    console.warn("[ai] registo de uso falhou:", String(err?.code ?? err?.name ?? "erro"));
  }
}

// ─── Resumo mensal (Definições → Estado) ────────────────────────────────────

export interface AiUsageFeatureSummary {
  feature: string;
  label: string;
  calls: number;
  errors: number;
  blocked: number;
  inputTokens: number;
  outputTokens: number;
  costEur: number;
  avgLatencyMs: number;
}

export async function aiUsageSummary(now: number = Date.now()) {
  const b = monthBounds(now);
  const budgetEur = await getMonthlyBudgetEur();
  const d = await db();
  const features: AiUsageFeatureSummary[] = [];
  if (d) {
    const res = await d.execute(sql`
      SELECT feature,
             COUNT(*) AS calls,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
             COALESCE(SUM(inputTokens), 0) AS inTok,
             COALESCE(SUM(outputTokens), 0) AS outTok,
             COALESCE(SUM(costEur), 0) AS totalCost,
             COALESCE(ROUND(AVG(latencyMs)), 0) AS avgLatency
        FROM ai_usage_log
       WHERE createdAt >= ${b.start} AND createdAt < ${b.end}
       GROUP BY feature
       ORDER BY totalCost DESC, feature ASC`);
    for (const r of rowsOf(res)) {
      const f = String(r.feature);
      features.push({
        feature: f,
        label: isAiFeature(f) ? AI_FEATURES[f].label : f,
        calls: Number(r.calls) || 0,
        errors: Number(r.errors) || 0,
        blocked: Number(r.blocked) || 0,
        inputTokens: Number(r.inTok) || 0,
        outputTokens: Number(r.outTok) || 0,
        costEur: Math.round((Number(r.totalCost) || 0) * 10_000) / 10_000,
        avgLatencyMs: Number(r.avgLatency) || 0,
      });
    }
  }
  const spentEur = Math.round(features.reduce((a, f) => a + f.costEur, 0) * 10_000) / 10_000;
  return {
    month: b.month,
    budgetEur,
    spentEur,
    pct: budgetEur > 0 ? Math.round((spentEur / budgetEur) * 1000) / 10 : null,
    blocked: budgetDecision(spentEur, budgetEur, false) === "blocked",
    features,
  };
}
