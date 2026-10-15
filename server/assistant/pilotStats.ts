/**
 * Cartão "Multis piloto" (plano MPV §8.3, F8) — Definições → Estado, só
 * admin/super admin. Por versão (v1 | mpv), nível (lite/fast/smart) e
 * pessoa: perguntas, €/pergunta, p95 do tempo de resposta, % erros, %
 * MAX_TOKENS, % rondas finais forçadas, % 👎, % "não sei" (as marcadas
 * sozinhas por detectUnanswered), % chamadas recusadas (sem acesso, só no
 * MPV) e as caches de contexto vivas. Os critérios do go/no-go (§9) leem daqui.
 *
 * SÓ LEITURA, da nossa BD, pelos índices da F0a:
 *  - ai_usage_log (feature, createdAt) — as perguntas (uma linha por
 *    pergunta, com a versão, o nível, o estado, o finishReason, as voltas, a
 *    ronda final forçada, o custo e o tempo) e o armazenamento das caches;
 *  - ai_chat_messages (createdAt) + ai_chat_conversations — as respostas
 *    guardadas com a versão e o nível (para o 👎 e o "não sei");
 *  - assistant_feedback (createdAt) — 👎 (auto = 0) e as marcas automáticas (auto = 1);
 *  - activity_logs (entity, createdAt) — as chamadas das ferramentas ("recusada");
 *  - ai_context_caches — as caches ainda válidas.
 * As contas estão em `buildPilotStats` (PURA). Nunca lança: sem BD → vazio.
 */
import { sql } from "drizzle-orm";
import { CONTEXT_CACHE_STORAGE_ENTITY } from "../_core/ai/contextCache";
import { percentileOf } from "../../shared/multisEval";

export const PILOT_STATS_MAX_DAYS = 31;
export const PILOT_STATS_ROW_LIMIT = 50_000;
/** Funcionalidades do Multis (o eval, assistant_eval, fica de fora). */
export const PILOT_FEATURES = ["assistant", "assistant_smart"] as const;
/** Alarme do plano (§3.6): respostas cortadas por MAX_TOKENS acima de 2 %. */
export const PILOT_MAX_TOKENS_ALARM = 0.02;

export interface PilotUsageRow {
  userId: number | null; variant: string | null; tier: string; status: string; errorCode: string | null; finishReason: string | null;
  forcedFinal: number | null; rounds: number | null; costEur: number; latencyMs: number; inputTokens: number; cachedTokens: number; entity: string | null;
}
export interface PilotAnswerRow { id: number; conversationId: number; userId: number | null; variant: string | null; tier: string | null }
export interface PilotFeedbackRow { messageId: number; rating: number; auto: number }
export interface PilotToolCallRow { userId: number; conversationId: number | null; refused: boolean }
export interface PilotCacheRow { model: string; live: number }

export interface PilotStatsRow {
  variant: string;
  tier: string;
  /** null = a linha da versão (todas as pessoas). */
  userId: number | null;
  name: string | null;
  inPilot: boolean;
  questions: number;
  /** Bloqueadas pelo teto próprio (o piloto desceu para o lite). */
  blocked: number;
  costEur: number;
  /** Armazenamento das caches (só na linha da versão). */
  storageEur: number;
  eurPerQuestion: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  errorPct: number | null;
  maxTokensPct: number | null;
  forcedFinalPct: number | null;
  avgRounds: number | null;
  /** Tokens de entrada que vieram da cache. */
  cachedPct: number | null;
  answers: number;
  downPct: number | null;
  unansweredPct: number | null;
  toolCalls: number;
  refusedPct: number | null;
}

export interface PilotStats {
  days: number;
  since: string;
  rows: PilotStatsRow[];
  caches: PilotCacheRow[];
  pilotUserIds: number[];
  /** Alguma leitura chegou ao teto de linhas (os números são de parte do período). */
  truncated: boolean;
}

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : null);
const r6 = (v: number) => Math.round(v * 1_000_000) / 1_000_000;

interface Acc {
  variant: string; tier: string; userId: number | null;
  questions: number; blocked: number; costEur: number; storageEur: number; lat: number[];
  errors: number; maxTokens: number; forced: number; rounds: number; roundsN: number; input: number; cached: number;
  answers: number; down: number; unanswered: number; toolCalls: number; refused: number;
}
const newAcc = (variant: string, tier: string, userId: number | null): Acc => ({
  variant, tier, userId, questions: 0, blocked: 0, costEur: 0, storageEur: 0, lat: [], errors: 0, maxTokens: 0, forced: 0, rounds: 0, roundsN: 0, input: 0, cached: 0,
  answers: 0, down: 0, unanswered: 0, toolCalls: 0, refused: 0,
});

/** As contas do cartão (PURA): linhas por versão × nível (todas as pessoas) e por pessoa. */
export function buildPilotStats(input: {
  days: number; since: string;
  usage: readonly PilotUsageRow[]; answers: readonly PilotAnswerRow[]; feedback: readonly PilotFeedbackRow[]; toolCalls: readonly PilotToolCallRow[];
  caches: readonly PilotCacheRow[]; names: ReadonlyMap<number, string>; pilotUserIds: readonly number[]; truncated?: boolean;
}): PilotStats {
  const acc = new Map<string, Acc>();
  const get = (variant: string | null, tier: string | null, userId: number | null) => {
    const v = variant || "v1";
    const t = tier || "?";
    const k = `${v}|${t}|${userId ?? "*"}`;
    let a = acc.get(k);
    if (!a) { a = newAcc(v, t, userId); acc.set(k, a); }
    return a;
  };
  const both = (variant: string | null, tier: string | null, userId: number | null, f: (a: Acc) => void) => {
    f(get(variant, tier, null));
    if (userId != null) f(get(variant, tier, userId));
  };
  for (const u of input.usage) {
    if (u.entity === CONTEXT_CACHE_STORAGE_ENTITY) { get(u.variant, u.tier, null).storageEur += Number(u.costEur) || 0; continue; }
    if (u.status === "blocked") { both(u.variant, u.tier, u.userId, (a) => { a.blocked++; }); continue; }
    if (u.status !== "ok" && u.status !== "error") continue;
    both(u.variant, u.tier, u.userId, (a) => {
      a.questions++;
      a.costEur += Number(u.costEur) || 0;
      if (Number.isFinite(u.latencyMs)) a.lat.push(u.latencyMs);
      if (u.status === "error") a.errors++;
      if (u.finishReason === "MAX_TOKENS") a.maxTokens++;
      if (Number(u.forcedFinal) === 1) a.forced++;
      if (u.rounds != null) { a.rounds += Number(u.rounds) || 0; a.roundsN++; }
      a.input += Number(u.inputTokens) || 0;
      a.cached += Number(u.cachedTokens) || 0;
    });
  }
  const byMessage = new Map<number, PilotAnswerRow>();
  const lastOfConversation = new Map<number, PilotAnswerRow>();
  for (const m of input.answers) {
    byMessage.set(m.id, m);
    const cur = lastOfConversation.get(m.conversationId);
    if (!cur || m.id > cur.id) lastOfConversation.set(m.conversationId, m);
    both(m.variant, m.tier, m.userId, (a) => { a.answers++; });
  }
  for (const f of input.feedback) {
    const m = byMessage.get(f.messageId);
    if (!m) continue;
    if (Number(f.auto) === 1) both(m.variant, m.tier, m.userId, (a) => { a.unanswered++; });
    else if (Number(f.rating) === -1) both(m.variant, m.tier, m.userId, (a) => { a.down++; });
  }
  // As chamadas das ferramentas vão para a versão/nível da última resposta da conversa (aproximado numa conversa com as duas).
  for (const t of input.toolCalls) {
    const m = t.conversationId != null ? lastOfConversation.get(t.conversationId) : undefined;
    both(m?.variant ?? null, m?.tier ?? null, t.userId, (a) => { a.toolCalls++; if (t.refused) a.refused++; });
  }
  const pilot = new Set(input.pilotUserIds);
  const rows: PilotStatsRow[] = [...acc.values()].map((a) => {
    const lat = percentileOf(a.lat, 0.95);
    const total = a.costEur + a.storageEur;
    return {
      variant: a.variant, tier: a.tier, userId: a.userId, name: a.userId != null ? input.names.get(a.userId) ?? null : null,
      inPilot: a.userId != null && pilot.has(a.userId),
      questions: a.questions, blocked: a.blocked, costEur: r6(a.costEur), storageEur: r6(a.storageEur),
      eurPerQuestion: a.questions ? r6(total / a.questions) : null,
      p50Ms: percentileOf(a.lat, 0.5), p95Ms: lat == null ? null : Math.round(lat),
      errorPct: ratio(a.errors, a.questions), maxTokensPct: ratio(a.maxTokens, a.questions), forcedFinalPct: ratio(a.forced, a.questions),
      avgRounds: a.roundsN ? Math.round((a.rounds / a.roundsN) * 100) / 100 : null,
      cachedPct: ratio(a.cached, a.input),
      answers: a.answers, downPct: ratio(a.down, a.answers), unansweredPct: ratio(a.unanswered, a.answers),
      toolCalls: a.toolCalls, refusedPct: ratio(a.refused, a.toolCalls),
    };
  });
  // Versão (mpv antes do v1), nível (smart, fast, lite), a linha de todos primeiro, depois as pessoas por perguntas.
  const vRank = (v: string) => (v === "mpv" ? 0 : v === "v1" ? 1 : 2);
  const tRank = (t: string) => (t === "smart" ? 0 : t === "fast" ? 1 : t === "lite" ? 2 : 3);
  rows.sort((x, y) => vRank(x.variant) - vRank(y.variant) || tRank(x.tier) - tRank(y.tier) || x.variant.localeCompare(y.variant) || x.tier.localeCompare(y.tier)
    || (x.userId == null ? -1 : 0) - (y.userId == null ? -1 : 0) || y.questions - x.questions || (x.userId ?? 0) - (y.userId ?? 0));
  return { days: input.days, since: input.since, rows, caches: [...input.caches], pilotUserIds: [...input.pilotUserIds], truncated: !!input.truncated };
}

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v) || 0);
const numOrNull = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Início da janela (UTC "AAAA-MM-DD HH:MM:SS"): os últimos `days` dias. PURA. */
export function pilotWindowStart(days: number, now: number = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

/** O cartão: lê as cinco tabelas (só leitura) e faz as contas. Nunca lança (sem BD → vazio). */
export async function getPilotStats(days: number, now: number = Date.now()): Promise<PilotStats> {
  const n = Math.max(1, Math.min(PILOT_STATS_MAX_DAYS, Math.floor(days)));
  const since = pilotWindowStart(n, now);
  let pilotUserIds: number[] = [];
  try {
    const { getSetting } = await import("../appSettings");
    const p = await getSetting("ai.assistantPilot");
    pilotUserIds = Array.isArray(p?.userIds) ? p.userIds : [];
  } catch { /* omissão */ }
  const empty = buildPilotStats({ days: n, since, usage: [], answers: [], feedback: [], toolCalls: [], caches: [], names: new Map(), pilotUserIds });
  const { getDb } = await import("../db");
  const db = await getDb().catch(() => null);
  if (!db) return empty;
  const feats = sql.join(PILOT_FEATURES.map((f) => sql`${f}`), sql`, `);
  const lim = sql.raw(String(PILOT_STATS_ROW_LIMIT));
  let truncated = false;
  const read = async (q: any): Promise<any[]> => {
    try {
      const r = rowsOf(await db.execute(q));
      if (r.length >= PILOT_STATS_ROW_LIMIT) truncated = true;
      return r;
    } catch (err: any) {
      console.warn("[multis piloto] leitura:", String(err?.cause?.message ?? err?.message ?? err).slice(0, 160));
      return [];
    }
  };
  const [usage, answers, feedback, tools, caches] = await Promise.all([
    read(sql`SELECT userId, variant, tier, status, errorCode, finishReason, forcedFinal, rounds, costEur, latencyMs, inputTokens, cachedTokens, entity
               FROM ai_usage_log WHERE feature IN (${feats}) AND createdAt >= ${since} ORDER BY id DESC LIMIT ${lim}`),
    read(sql`SELECT m.id, m.conversationId, c.userId, m.variant, m.tier
               FROM ai_chat_messages m JOIN ai_chat_conversations c ON c.id = m.conversationId
              WHERE m.createdAt >= ${since} AND m.role = 'assistant' AND c.channel = 'staff' ORDER BY m.id DESC LIMIT ${lim}`),
    read(sql`SELECT messageId, rating, auto FROM assistant_feedback WHERE createdAt >= ${since} ORDER BY id DESC LIMIT ${lim}`),
    read(sql`SELECT userId, entityId, (details LIKE '%"estado":"recusada"%') AS refused
               FROM activity_logs WHERE entity = 'assistant' AND action = 'assistant_tool' AND createdAt >= ${since} ORDER BY id DESC LIMIT ${lim}`),
    read(sql`SELECT model, COUNT(*) AS live FROM ai_context_caches WHERE expiresAt > UTC_TIMESTAMP() GROUP BY model ORDER BY model`),
  ]);
  const ids = [...new Set([...usage.map((u) => numOrNull(u.userId)), ...answers.map((a) => numOrNull(a.userId)), ...tools.map((t) => numOrNull(t.userId))].filter((x): x is number => x != null))];
  const names = new Map<number, string>();
  if (ids.length) {
    for (const r of await read(sql`SELECT id, name FROM users WHERE id IN (${sql.join(ids.slice(0, 2000).map((i) => sql`${i}`), sql`, `)})`)) names.set(Number(r.id), String(r.name ?? `#${r.id}`));
  }
  return buildPilotStats({
    days: n, since, pilotUserIds, truncated, names,
    usage: usage.map((u) => ({
      userId: numOrNull(u.userId), variant: u.variant ?? null, tier: String(u.tier ?? "?"), status: String(u.status ?? ""), errorCode: u.errorCode ?? null,
      finishReason: u.finishReason ?? null, forcedFinal: numOrNull(u.forcedFinal), rounds: numOrNull(u.rounds), costEur: num(u.costEur), latencyMs: num(u.latencyMs),
      inputTokens: num(u.inputTokens), cachedTokens: num(u.cachedTokens), entity: u.entity ?? null,
    })),
    answers: answers.map((a) => ({ id: num(a.id), conversationId: num(a.conversationId), userId: numOrNull(a.userId), variant: a.variant ?? null, tier: a.tier ?? null })),
    feedback: feedback.map((f) => ({ messageId: num(f.messageId), rating: num(f.rating), auto: num(f.auto) })),
    toolCalls: tools.map((t) => ({ userId: num(t.userId), conversationId: numOrNull(t.entityId), refused: num(t.refused) === 1 })),
    caches: caches.map((c) => ({ model: String(c.model ?? "?"), live: num(c.live) })),
  });
}
