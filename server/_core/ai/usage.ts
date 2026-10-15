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
  // 0690 (plano MPV §8.3): observabilidade — nunca conteúdo.
  /** finishReason da última resposta (STOP, MAX_TOKENS…). */
  finishReason?: string | null;
  /** Voltas de ferramentas (null = sem ferramentas). */
  rounds?: number | null;
  /** Versão do chamador ("v1" | "mpv" no Multis). */
  variant?: string | null;
  /** Houve chamada final sem ferramentas (null = sem ferramentas). */
  forcedFinal?: boolean | null;
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

/** Aviso `ai_budget` (super_admin/admin), UMA vez por mês (INSERT IGNORE). Nunca lança. */
export async function notifyBudgetExceededOnce(month: string, spentEur: number, budgetEur: number): Promise<boolean> {
  try {
    const d = await db();
    if (!d) return false;
    const res = await d.execute(sql`INSERT IGNORE INTO ai_budget_alerts (month, spentEur, budgetEur) VALUES (${month}, ${spentEur.toFixed(4)}, ${budgetEur.toFixed(4)})`);
    if (affectedRows(res) !== 1) return false;
    const { notify } = await import("../../notify");
    await notify({
      kind: "ai_budget",
      title: "Orçamento da IA atingido",
      body: `A IA já gastou cerca de ${spentEur.toFixed(2).replace(".", ",")} € este mês (orçamento: ${budgetEur.toFixed(2).replace(".", ",")} €). As funcionalidades não essenciais ficam em pausa até ao próximo mês ou até o orçamento subir em Definições → Parâmetros.`,
      link: "/definicoes",
      entity: { type: "ai_budget", id: month },
    });
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
    const rounds = row.rounds == null ? null : Math.max(0, Math.min(127, Math.round(Number(row.rounds) || 0)));
    const forcedFinal = row.forcedFinal == null ? null : row.forcedFinal ? 1 : 0;
    try {
      await d.execute(sql`
        INSERT INTO ai_usage_log
          (createdAt, feature, tier, provider, model, userId, entity, entityId,
           inputTokens, outputTokens, cachedTokens, costEur, latencyMs, status, errorCode,
           finishReason, rounds, variant, forcedFinal)
        VALUES
          (${mysqlUtc(now)}, ${cut(row.feature, 40)}, ${cut(row.tier, 8)}, ${cut(row.provider, 16)}, ${cut(row.model, 80)},
           ${row.userId ?? null}, ${cut(row.entity ?? null, 40)}, ${row.entityId ?? null},
           ${int(row.inputTokens)}, ${int(row.outputTokens)}, ${int(row.cachedTokens)}, ${cost.toFixed(6)}, ${int(row.latencyMs)},
           ${row.status}, ${cut(row.errorCode ?? null, 40)},
           ${cut(row.finishReason ?? null, 32)}, ${rounds}, ${cut(row.variant ?? null, 16)}, ${forcedFinal})`);
    } catch (err: any) {
      // Antes da migração 0690 (colunas novas ainda não existem): a linha de sempre.
      if ((err?.code ?? err?.cause?.code) !== "ER_BAD_FIELD_ERROR") throw err;
      await d.execute(sql`
        INSERT INTO ai_usage_log
          (createdAt, feature, tier, provider, model, userId, entity, entityId,
           inputTokens, outputTokens, cachedTokens, costEur, latencyMs, status, errorCode)
        VALUES
          (${mysqlUtc(now)}, ${cut(row.feature, 40)}, ${cut(row.tier, 8)}, ${cut(row.provider, 16)}, ${cut(row.model, 80)},
           ${row.userId ?? null}, ${cut(row.entity ?? null, 40)}, ${row.entityId ?? null},
           ${int(row.inputTokens)}, ${int(row.outputTokens)}, ${int(row.cachedTokens)}, ${cost.toFixed(6)}, ${int(row.latencyMs)},
           ${row.status}, ${cut(row.errorCode ?? null, 40)})`);
    }
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

// ─── Uso por dia e leituras repetidas (plano MPV F0a, Definições → Estado) ──

export const AI_USAGE_DAILY_MAX_DAYS = 62;
export const AI_USAGE_REPEATS_MAX_DAYS = 31;
export const AI_USAGE_REPEATS_LIMIT = 100;
/** As conversas do chat têm várias chamadas de propósito (uma por pergunta): não são leituras repetidas. */
export const AI_USAGE_REPEATS_EXCLUDED_ENTITIES = ["ai_chat_conversation"] as const;

/** Início (UTC, 00:00) do 1.º dia de uma janela de `days` dias que acaba hoje. PURA. */
export function usageWindowStart(days: number, now: number = Date.now()): string {
  const d = new Date(now);
  const n = Math.max(1, Math.floor(days));
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (n - 1)));
  return mysqlUtc(start).slice(0, 19);
}

const num = (v: unknown) => Number(v) || 0;
const eur4 = (v: unknown) => Math.round(num(v) * 10_000) / 10_000;
const str = (v: unknown) => (v == null ? null : v instanceof Date ? mysqlUtc(v).slice(0, 19) : String(v));

export interface AiUsageDailyRow {
  /** AAAA-MM-DD (UTC) */
  day: string;
  feature: string;
  label: string;
  calls: number;
  errors: number;
  blocked: number;
  /** Bloqueadas pelo portão "só Vertex AI na UE" (RGPD). */
  euOnly: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costEur: number;
  /** Primeira e última chamada do dia (UTC, "AAAA-MM-DD HH:MM:SS"). */
  firstAt: string | null;
  lastAt: string | null;
}

/**
 * Uso da IA por dia (UTC) × funcionalidade, dos últimos `days` dias (≤ 62).
 * Só metadados do registo — serve, p. ex., para confirmar quando correram as
 * chamadas do RH (primeira/última de cada dia). Só leitura.
 */
export async function aiUsageDaily(days: number, feature?: string | null, now: number = Date.now()) {
  const n = Math.max(1, Math.min(AI_USAGE_DAILY_MAX_DAYS, Math.floor(days)));
  const since = usageWindowStart(n, now);
  const d = await db();
  const rows: AiUsageDailyRow[] = [];
  if (d) {
    const res = await d.execute(sql`
      SELECT DATE_FORMAT(createdAt, '%Y-%m-%d') AS day,
             feature,
             COUNT(*) AS calls,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
             SUM(CASE WHEN status = 'blocked' AND errorCode = 'eu_only' THEN 1 ELSE 0 END) AS euOnly,
             COALESCE(SUM(inputTokens), 0) AS inTok,
             COALESCE(SUM(outputTokens), 0) AS outTok,
             COALESCE(SUM(cachedTokens), 0) AS cachedTok,
             COALESCE(SUM(costEur), 0) AS totalCost,
             DATE_FORMAT(MIN(createdAt), '%Y-%m-%d %H:%i:%s') AS firstAt,
             DATE_FORMAT(MAX(createdAt), '%Y-%m-%d %H:%i:%s') AS lastAt
        FROM ai_usage_log
       WHERE createdAt >= ${since}${feature ? sql` AND feature = ${feature}` : sql``}
       GROUP BY day, feature
       ORDER BY day DESC, totalCost DESC, feature ASC
       LIMIT 3000`);
    for (const r of rowsOf(res)) {
      const f = String(r.feature);
      rows.push({
        day: String(str(r.day) ?? "").slice(0, 10),
        feature: f,
        label: isAiFeature(f) ? AI_FEATURES[f].label : f,
        calls: num(r.calls),
        errors: num(r.errors),
        blocked: num(r.blocked),
        euOnly: num(r.euOnly),
        inputTokens: num(r.inTok),
        outputTokens: num(r.outTok),
        cachedTokens: num(r.cachedTok),
        costEur: eur4(r.totalCost),
        firstAt: str(r.firstAt),
        lastAt: str(r.lastAt),
      });
    }
  }
  return { days: n, since, feature: feature ?? null, rows };
}

export interface AiUsageRepeatRow {
  feature: string;
  label: string;
  entity: string;
  entityId: number;
  calls: number;
  okCalls: number;
  costEur: number;
  firstAt: string | null;
  lastAt: string | null;
}

/**
 * Leituras repetidas: a mesma coisa (feature, entity, entityId) lida pela IA
 * mais de uma vez nos últimos `days` dias (≤ 31) — top 100 por chamadas. As
 * conversas do chat ficam de fora (várias perguntas por conversa). Só leitura.
 */
export async function aiUsageRepeats(days: number, feature?: string | null, now: number = Date.now()) {
  const n = Math.max(1, Math.min(AI_USAGE_REPEATS_MAX_DAYS, Math.floor(days)));
  const since = usageWindowStart(n, now);
  const d = await db();
  const rows: AiUsageRepeatRow[] = [];
  if (d) {
    const excluded = sql.join(AI_USAGE_REPEATS_EXCLUDED_ENTITIES.map((e) => sql`${e}`), sql`, `);
    const res = await d.execute(sql`
      SELECT feature, entity, entityId,
             COUNT(*) AS calls,
             SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS okCalls,
             COALESCE(SUM(costEur), 0) AS totalCost,
             DATE_FORMAT(MIN(createdAt), '%Y-%m-%d %H:%i:%s') AS firstAt,
             DATE_FORMAT(MAX(createdAt), '%Y-%m-%d %H:%i:%s') AS lastAt
        FROM ai_usage_log
       WHERE createdAt >= ${since}
         AND entity IS NOT NULL AND entityId IS NOT NULL
         AND entity NOT IN (${excluded})${feature ? sql` AND feature = ${feature}` : sql``}
       GROUP BY feature, entity, entityId
      HAVING COUNT(*) > 1
       ORDER BY calls DESC, totalCost DESC
       LIMIT ${AI_USAGE_REPEATS_LIMIT}`);
    for (const r of rowsOf(res)) {
      const f = String(r.feature);
      rows.push({
        feature: f,
        label: isAiFeature(f) ? AI_FEATURES[f].label : f,
        entity: String(r.entity),
        entityId: num(r.entityId),
        calls: num(r.calls),
        okCalls: num(r.okCalls),
        costEur: eur4(r.totalCost),
        firstAt: str(r.firstAt),
        lastAt: str(r.lastAt),
      });
    }
  }
  return { days: n, since, feature: feature ?? null, rows };
}
