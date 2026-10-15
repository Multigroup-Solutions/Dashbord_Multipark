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
 *  - Funcionalidades com TETO PRÓPRIO (plano MPV §5.3, `ownBudget` no catálogo:
 *    hoje só o `assistant_smart`) NÃO entram na soma que bloqueia as outras
 *    (`monthSpendEur`/`spendCache`); têm o seu teto por dia, por mês e por
 *    pessoa por dia (`ownBudgetCheck`). O cartão do custo mostra-as na mesma.
 */
import { sql } from "drizzle-orm";
import { AI_ASSISTANT_SMART_DEFAULT_BUDGET, type AiAssistantSmartBudget, type AiPriceOverrides } from "../../../shared/appSettings";
import { AiBudgetExceededError } from "./errors";
import { AI_FEATURES, AI_OWN_BUDGET_FEATURES, hasOwnBudget, isAiFeature } from "../../../shared/aiFeatures";

export type AiUsageStatus = "ok" | "error" | "blocked";

/** Linhas do armazenamento da cache de contexto (contextCache.ts) — à parte no cartão. */
const CONTEXT_CACHE_STORAGE = "context_cache_storage";

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
/** Teto próprio: gasto da funcionalidade (dia e mês) e de cada pessoa no dia — 60 s por instância. */
const ownSpendCache = new Map<string, { day: string; month: string; at: number; dayEur: number; monthEur: number }>();
const ownUserDayCache = new Map<string, { day: string; at: number; value: number }>();

/** Só testes. */
export function resetAiUsageCachesForTests(): void {
  spendCache = null;
  ownSpendCache.clear();
  ownUserDayCache.clear();
  reservedByFeature.clear();
  reservedByUser.clear();
}

/** `AND feature NOT IN (…)` das funcionalidades com teto próprio (vazio se não houver). */
function excludeOwnBudgetSql() {
  if (!AI_OWN_BUDGET_FEATURES.length) return sql``;
  return sql` AND feature NOT IN (${sql.join(AI_OWN_BUDGET_FEATURES.map((f) => sql`${f}`), sql`, `)})`;
}

/**
 * Gasto do mês que conta para o orçamento GLOBAL — sem as funcionalidades com
 * teto próprio (plano MPV §5.3: o assistant_smart nunca faz bloquear as outras).
 */
export async function monthSpendEur(now: number = Date.now(), opts: { fresh?: boolean } = {}): Promise<number> {
  const b = monthBounds(now);
  if (!opts.fresh && spendCache && spendCache.month === b.month && now - spendCache.at < SPEND_CACHE_MS) return spendCache.value;
  const d = await db();
  if (!d) return spendCache?.month === b.month ? spendCache.value : 0;
  const res = await d.execute(sql`SELECT COALESCE(SUM(costEur), 0) AS spent FROM ai_usage_log WHERE createdAt >= ${b.start} AND createdAt < ${b.end}${excludeOwnBudgetSql()}`);
  const value = Number(rowsOf(res)[0]?.spent ?? 0) || 0;
  spendCache = { month: b.month, at: now, value };
  return value;
}

// ─── Teto próprio (plano MPV §5.3) ──────────────────────────────────────────

const LISBON_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** Diferença (ms) entre a hora de Lisboa e a UTC num instante. PURA. */
function lisbonOffsetMs(at: number): number {
  const p = Object.fromEntries(LISBON_PARTS.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * Dia civil de LISBOA (como o resto da aplicação): rótulo e limites [início,
 * fim) em UTC, para o teto diário. A hora muda à 01:00 UTC, por isso a
 * diferença à meia-noite UTC é a da meia-noite de Lisboa. PURA.
 */
export function dayBounds(now: number | Date = Date.now()): { day: string; start: string; end: string } {
  const t = new Date(now).getTime();
  const p = Object.fromEntries(LISBON_PARTS.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const y = Number(p.year), m = Number(p.month) - 1, d = Number(p.day);
  const midnight = (yy: number, mm: number, dd: number) => { const u = Date.UTC(yy, mm, dd); return u - lisbonOffsetMs(u); };
  const start = new Date(midnight(y, m, d));
  const end = new Date(midnight(y, m, d + 1));
  return { day: `${p.year}-${p.month}-${p.day}`, start: mysqlUtc(start).slice(0, 19), end: mysqlUtc(end).slice(0, 19) };
}

/** "unknown" = não se conseguiu medir o gasto (erro): por prudência, não corre (modo económico). */
export type OwnBudgetReason = "day" | "month" | "user_day" | "unknown";

export interface OwnBudgetSpend {
  dayEur: number;
  monthEur: number;
  /** Da pessoa, hoje (0 sem pessoa). */
  userDayEur: number;
}

/** Reserva à cabeça por turno em curso (≈ o máximo estimado de uma pergunta no smart, plano §5.3). */
export const OWN_BUDGET_TURN_RESERVE_EUR = 0.2;
/** A partir desta fração de um teto, o gasto lê-se sempre da BD (sem a cache de 60 s). */
export const OWN_BUDGET_FRESH_RATIO = 0.8;

/** Teto próprio atingido? null = pode correr. Ordem: pessoa, dia, mês. PURA. */
export function ownBudgetDecision(spend: OwnBudgetSpend, budget: AiAssistantSmartBudget, hasUser: boolean): Exclude<OwnBudgetReason, "unknown"> | null {
  if (hasUser && budget.eurPerUserPerDay > 0 && spend.userDayEur >= budget.eurPerUserPerDay) return "user_day";
  if (budget.eurPerDay > 0 && spend.dayEur >= budget.eurPerDay) return "day";
  if (budget.eurPerMonth > 0 && spend.monthEur >= budget.eurPerMonth) return "month";
  return null;
}

/** Algum dos gastos já passou de OWN_BUDGET_FRESH_RATIO do seu teto? PURA. */
export function ownBudgetNearCap(spend: OwnBudgetSpend, budget: AiAssistantSmartBudget, hasUser: boolean): boolean {
  const near = (v: number, cap: number) => cap > 0 && v >= cap * OWN_BUDGET_FRESH_RATIO;
  return (hasUser && near(spend.userDayEur, budget.eurPerUserPerDay)) || near(spend.dayEur, budget.eurPerDay) || near(spend.monthEur, budget.eurPerMonth);
}

/** Teto em vigor de uma funcionalidade com teto próprio (Definições → omissão). Nunca lança. */
export async function getOwnBudget(feature: string): Promise<AiAssistantSmartBudget> {
  // Hoje só o assistant_smart tem teto próprio (ai.assistantSmartBudget).
  void feature;
  try {
    const { getSetting } = await import("../../appSettings");
    const v = await getSetting("ai.assistantSmartBudget");
    if (v && typeof v === "object") return { ...AI_ASSISTANT_SMART_DEFAULT_BUDGET, ...v };
  } catch { /* sem BD: omissão */ }
  return { ...AI_ASSISTANT_SMART_DEFAULT_BUDGET };
}

/**
 * Gasto de uma funcionalidade com teto próprio: hoje (dia de Lisboa) e este
 * mês (UTC, como o orçamento global) e, com `userId`, o da pessoa hoje — pelo
 * índice (feature, userId, createdAt). Cache de 60 s por instância (o registo
 * de cada chamada soma à cache). Sem BD → 0. Lança se a BD falhar.
 */
export async function ownBudgetSpend(feature: string, userId: number | null | undefined, now: number = Date.now(), opts: { fresh?: boolean } = {}): Promise<OwnBudgetSpend> {
  const m = monthBounds(now);
  const dd = dayBounds(now);
  const d = await db();
  let dayEur = 0;
  let monthEur = 0;
  const hit = ownSpendCache.get(feature);
  if (!opts.fresh && hit && hit.day === dd.day && hit.month === m.month && now - hit.at < SPEND_CACHE_MS) {
    dayEur = hit.dayEur;
    monthEur = hit.monthEur;
  } else if (d) {
    // O dia de Lisboa pode começar antes do mês UTC (verão): lê desde o mais cedo dos dois.
    const from = dd.start < m.start ? dd.start : m.start;
    const res = await d.execute(sql`
      SELECT COALESCE(SUM(CASE WHEN createdAt >= ${dd.start} AND createdAt < ${dd.end} THEN costEur ELSE 0 END), 0) AS dayEur,
             COALESCE(SUM(CASE WHEN createdAt >= ${m.start} THEN costEur ELSE 0 END), 0) AS monthEur
        FROM ai_usage_log
       WHERE feature = ${feature} AND createdAt >= ${from} AND createdAt < ${m.end}`);
    const r = rowsOf(res)[0] ?? {};
    dayEur = Number(r.dayEur ?? 0) || 0;
    monthEur = Number(r.monthEur ?? 0) || 0;
    ownSpendCache.set(feature, { day: dd.day, month: m.month, at: now, dayEur, monthEur });
  } else if (hit && hit.day === dd.day && hit.month === m.month) {
    dayEur = hit.dayEur;
    monthEur = hit.monthEur;
  }
  let userDayEur = 0;
  if (userId != null) {
    const key = `${feature}|${userId}`;
    const u = ownUserDayCache.get(key);
    if (!opts.fresh && u && u.day === dd.day && now - u.at < SPEND_CACHE_MS) userDayEur = u.value;
    else if (d) {
      const res = await d.execute(sql`
        SELECT COALESCE(SUM(costEur), 0) AS spent
          FROM ai_usage_log
         WHERE feature = ${feature} AND userId = ${userId} AND createdAt >= ${dd.start} AND createdAt < ${dd.end}`);
      userDayEur = Number(rowsOf(res)[0]?.spent ?? 0) || 0;
      ownUserDayCache.set(key, { day: dd.day, at: now, value: userDayEur });
    } else if (u && u.day === dd.day) userDayEur = u.value;
  }
  return { dayEur, monthEur, userDayEur };
}

// Reservas à cabeça dos turnos em curso nesta instância (por funcionalidade e por pessoa).
const reservedByFeature = new Map<string, number>();
const reservedByUser = new Map<string, number>();
const addTo = (map: Map<string, number>, key: string, v: number) => {
  const n = Math.max(0, (map.get(key) ?? 0) + v);
  if (n < 1e-9) map.delete(key); else map.set(key, n);
};

/**
 * Reserva à cabeça `eur` (omissão OWN_BUDGET_TURN_RESERVE_EUR) para um turno
 * em curso: os pedidos que chegam ao mesmo tempo contam com ela. Devolve a
 * função que a liberta (uma vez; o runAi chama-a antes de registar o custo
 * real). Funcionalidade sem teto próprio → nada.
 */
export function reserveOwnBudget(feature: string, userId: number | null | undefined, eur: number = OWN_BUDGET_TURN_RESERVE_EUR): () => void {
  if (!hasOwnBudget(feature) || !(eur > 0)) return () => undefined;
  addTo(reservedByFeature, feature, eur);
  const uk = userId != null ? `${feature}|${userId}` : null;
  if (uk) addTo(reservedByUser, uk, eur);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    addTo(reservedByFeature, feature, -eur);
    if (uk) addTo(reservedByUser, uk, -eur);
  };
}

/** Só testes. */
export function ownBudgetReservedForTests(feature: string, userId?: number | null): { feature: number; user: number } {
  return { feature: reservedByFeature.get(feature) ?? 0, user: userId != null ? reservedByUser.get(`${feature}|${userId}`) ?? 0 : 0 };
}

/**
 * Pode esta funcionalidade (com teto próprio) correr agora para esta pessoa?
 * Conta o gasto registado + as reservas dos turnos em curso nesta instância;
 * acima de 80 % de um teto lê sempre da BD (sem a cache). Funcionalidade sem
 * teto próprio → ok. Erro a medir → NÃO (reason "unknown": quem chama desce
 * para o lite). Sem BD → ok (não há registo a ler). Nunca lança.
 *
 * Limite do excesso: cada instância só vê as suas reservas; o gasto das
 * outras chega pela BD (≤ 60 s de atraso abaixo dos 80 %, nenhum acima). O
 * teto pode passar, no máximo, ≈ (turnos em curso nas outras instâncias ×
 * 0,20 €) + o que um turno gastar acima da estimativa.
 */
export async function ownBudgetCheck(feature: string, userId: number | null | undefined, now: number = Date.now()): Promise<{ ok: boolean; reason: OwnBudgetReason | null; spend: OwnBudgetSpend; budget: AiAssistantSmartBudget }> {
  const budget = await getOwnBudget(feature);
  const zero: OwnBudgetSpend = { dayEur: 0, monthEur: 0, userDayEur: 0 };
  if (!hasOwnBudget(feature)) return { ok: true, reason: null, spend: zero, budget };
  const hasUser = userId != null;
  const withReserved = (s: OwnBudgetSpend): OwnBudgetSpend => {
    const rf = reservedByFeature.get(feature) ?? 0;
    const ru = hasUser ? reservedByUser.get(`${feature}|${userId}`) ?? 0 : 0;
    return { dayEur: s.dayEur + rf, monthEur: s.monthEur + rf, userDayEur: s.userDayEur + ru };
  };
  try {
    let spend = withReserved(await ownBudgetSpend(feature, userId, now));
    if (ownBudgetNearCap(spend, budget, hasUser)) spend = withReserved(await ownBudgetSpend(feature, userId, now, { fresh: true }));
    const reason = ownBudgetDecision(spend, budget, hasUser);
    return { ok: reason == null, reason, spend, budget };
  } catch {
    return { ok: false, reason: "unknown", spend: zero, budget };
  }
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
  if (hasOwnBudget(row.feature)) {
    // Teto próprio: soma às caches da funcionalidade (nunca à do orçamento global).
    const day = dayBounds(now.getTime()).day;
    const f = ownSpendCache.get(row.feature);
    if (f && f.month === month && f.day === day) ownSpendCache.set(row.feature, { ...f, dayEur: f.dayEur + cost, monthEur: f.monthEur + cost });
    if (row.userId != null) {
      const key = `${row.feature}|${row.userId}`;
      const u = ownUserDayCache.get(key);
      if (u && u.day === day) ownUserDayCache.set(key, { ...u, value: u.value + cost });
    }
  } else if (spendCache && spendCache.month === month) spendCache = { ...spendCache, value: spendCache.value + cost };
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
  /** Teto próprio (fora do orçamento global, plano MPV §5.3). */
  ownBudget: boolean;
  /**
   * Armazenamento da cache de contexto (linhas entity = context_cache_storage):
   * à parte — não conta nas chamadas, na latência nem no custo por pergunta
   * (`costEur`), mas conta no gasto do mês.
   */
  storageEur: number;
}

export async function aiUsageSummary(now: number = Date.now()) {
  const b = monthBounds(now);
  const budgetEur = await getMonthlyBudgetEur();
  const d = await db();
  const features: AiUsageFeatureSummary[] = [];
  if (d) {
    const res = await d.execute(sql`
      SELECT feature,
             SUM(CASE WHEN entity = ${CONTEXT_CACHE_STORAGE} THEN 0 ELSE 1 END) AS calls,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
             COALESCE(SUM(inputTokens), 0) AS inTok,
             COALESCE(SUM(outputTokens), 0) AS outTok,
             COALESCE(SUM(costEur), 0) AS totalCost,
             COALESCE(SUM(CASE WHEN entity = ${CONTEXT_CACHE_STORAGE} THEN costEur ELSE 0 END), 0) AS storageCost,
             COALESCE(ROUND(AVG(CASE WHEN entity = ${CONTEXT_CACHE_STORAGE} THEN NULL ELSE latencyMs END)), 0) AS avgLatency
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
        costEur: Math.round(((Number(r.totalCost) || 0) - (Number(r.storageCost) || 0)) * 10_000) / 10_000,
        avgLatencyMs: Number(r.avgLatency) || 0,
        ownBudget: hasOwnBudget(f),
        storageEur: Math.round((Number(r.storageCost) || 0) * 10_000) / 10_000,
      });
    }
  }
  const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
  // O cartão mostra tudo; o orçamento global (barra e bloqueio) só conta as sem teto próprio.
  const spentEur = round4(features.reduce((a, f) => a + f.costEur + f.storageEur, 0));
  const ownBudgetSpentEur = round4(features.filter((f) => f.ownBudget).reduce((a, f) => a + f.costEur + f.storageEur, 0));
  const storageEur = round4(features.reduce((a, f) => a + f.storageEur, 0));
  const gateSpentEur = round4(spentEur - ownBudgetSpentEur);
  return {
    month: b.month,
    budgetEur,
    spentEur,
    gateSpentEur,
    ownBudgetSpentEur,
    storageEur,
    pct: budgetEur > 0 ? Math.round((gateSpentEur / budgetEur) * 1000) / 10 : null,
    blocked: budgetDecision(gateSpentEur, budgetEur, false) === "blocked",
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
  /** Respostas com o texto de recurso (errorCode final_fallback). */
  fallbacks: number;
  /** Com chamada final sem ferramentas (forcedFinal = 1). */
  forcedFinal: number;
  /** Cortadas pelo teto de saída (finishReason = MAX_TOKENS). */
  maxTokens: number;
  /** Armazenamento da cache de contexto (à parte; incluído em costEur). */
  storageEur: number;
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
             SUM(CASE WHEN entity = ${CONTEXT_CACHE_STORAGE} THEN 0 ELSE 1 END) AS calls,
             COALESCE(SUM(CASE WHEN entity = ${CONTEXT_CACHE_STORAGE} THEN costEur ELSE 0 END), 0) AS storageCost,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
             SUM(CASE WHEN status = 'blocked' AND errorCode = 'eu_only' THEN 1 ELSE 0 END) AS euOnly,
             SUM(CASE WHEN errorCode = 'final_fallback' THEN 1 ELSE 0 END) AS fallbacks,
             SUM(CASE WHEN forcedFinal = 1 THEN 1 ELSE 0 END) AS forcedFinals,
             SUM(CASE WHEN finishReason = 'MAX_TOKENS' THEN 1 ELSE 0 END) AS maxTokens,
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
        fallbacks: num(r.fallbacks),
        forcedFinal: num(r.forcedFinals),
        maxTokens: num(r.maxTokens),
        storageEur: eur4(r.storageCost),
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
