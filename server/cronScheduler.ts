/**
 * Agendador único do servidor: GET /api/cron/tick (Bearer CRON_SECRET).
 *
 * Chamado de 5 em 5 min pelo cron-job.org (e de hora a hora pelo GitHub
 * Actions, como rede de segurança — o lease torna as chamadas duplicadas
 * inofensivas). Cada tick:
 *   1. lê o estado de cada trabalho (cron_job_state, migração 0190) e decide,
 *      pela hora de Lisboa, o que está na altura (server/cronSchedule.ts);
 *   2. corre os devidos UM A UM (primeiro os que ficaram a meio, depois por
 *      prioridade), cada um com um prazo que cabe no que resta do orçamento
 *      (~50 s da função de 60 s); o que não couber fica para o tick seguinte;
 *   3. cada trabalho só corre com o lease dele (UPDATE … WHERE leaseUntil <
 *      agora): dois ticks nunca correm o mesmo trabalho ao mesmo tempo;
 *   4. grava o resultado (ok/error/partial, cursor, período feito) e uma
 *      linha em cron_runs com o nome de sempre (Estado do sistema e alertas).
 *
 * A resposta HTTP sai logo (202 + lista do que vai arrancar) e o trabalho
 * continua em segundo plano com o `waitUntil` do Vercel (o mesmo mecanismo do
 * push do Gmail); `?wait=1` corre tudo antes de responder (relatório completo).
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { fromMysqlMs, recordCronRun, toMysqlMs } from "./cronRuns";
import {
  LEASE_GRACE_MS, TICK_JOBS, applyOutcome, effectiveTickJobs, leaseFree, cursorForRun, describeCadence, emptyState, isDue, jobDeadline, mailPushHealthy, nextDueAt,
  periodKeyFor, planTick, type DynamicCadence, type JobState, type JobStatus, type PlannedJob, type TickJobSpec,
} from "./cronSchedule";
import type { CronJobRun } from "./cronJobs";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const affected = (res: unknown): number => Number((Array.isArray(res) ? res[0] : res as any)?.affectedRows ?? 0);

// ─── Trabalhos → funções ────────────────────────────────────────────────────

type JobRunner = (o: { deadlineAt: number; cursor: string | null }) => Promise<CronJobRun>;

const offset = (c: string | null) => (c && /^\d{1,4}$/.test(c) ? Number(c) : 0);

/** Cada chave de TICK_JOBS → a função partilhada com o endpoint manual. */
export const JOB_RUNNERS: Record<string, JobRunner> = {
  "mail-sync": async (o) => (await import("./cronJobs")).mailSyncCron(o),
  "multipark-deliveries": async (o) => (await import("./cronJobs")).multiparkDeliveriesCron(o),
  "ai-comms": async (o) => (await import("./cronJobs")).aiCommsCron(o),
  "google-pending": async (o) => (await import("./cronJobs")).googlePendingCron(o),
  "google-sync": async (o) => (await import("./cronJobs")).googleSyncCron(o),
  "google-watch-renew": async (o) => (await import("./cronJobs")).googleWatchRenewCron(o),
  "extras-schedule": async () => (await import("./cronJobs")).extrasScheduleCron(),
  "multipark-sync": async (o) => (await import("./cronJobs")).multiparkSyncCron(o),
  "extras-auto": async (o) => (await import("./cronJobs")).extrasAutoCron({ deadlineAt: o.deadlineAt, from: o.cursor || null }),
  "identity-sweep": async () => (await import("./cronJobs")).identitySweepCron(),
  "multipark-future": async (o) => (await import("./cronJobs")).multiparkFutureCron({ deadlineAt: o.deadlineAt, offsetDays: offset(o.cursor) }),
  "zello-sameday": async (o) => (await import("./cronJobs")).zelloSameDayCron(o),
  "rh-docs-weekly": async () => (await import("./cronJobs")).rhDocsWeeklyCron(),
  "daily-ops": async (o) => (await import("./cronJobs")).dailyOpsCron({ deadlineAt: o.deadlineAt, cursor: o.cursor, deferStepErrors: true }),
  "ops-briefing": async (o) => (await import("./cronJobs")).opsBriefingCron(o),
  "evaluation-recompute": async (o) => (await import("./cronJobs")).evaluationRecomputeCron({ deadlineAt: o.deadlineAt, offsetDays: offset(o.cursor) }),
  "google-ads": async (o) => (await import("./cronJobs")).googleAdsCron({ deadlineAt: o.deadlineAt, kind: "daily" }),
  "google-ads-monthly": async (o) => (await import("./cronJobs")).googleAdsCron({ deadlineAt: o.deadlineAt, kind: "monthly" }),
  "meta-ads": async (o) => (await import("./cronJobs")).metaAdsCron({ deadlineAt: o.deadlineAt, kind: "daily" }),
  "meta-ads-monthly": async (o) => (await import("./cronJobs")).metaAdsCron({ deadlineAt: o.deadlineAt, kind: "monthly" }),
  "web-analytics": async (o) => (await import("./cronJobs")).webAnalyticsCron(o),
};

/** Meta do registo de corridas (o que o GitHub Actions punha na query). */
function runMeta(key: string, cursor: string | null): string {
  const kind = key.endsWith("-monthly") ? "kind=monthly" : key === "google-ads" || key === "meta-ads" ? "kind=daily" : "";
  return ["tick", kind, cursor ? `cursor=${cursor.slice(0, 120)}` : ""].filter(Boolean).join(" ");
}

/** "a partir de" dinâmico: o Web & SEO só atualiza depois da hora das Definições. */
async function fromOverrides(): Promise<Map<string, number | null>> {
  const m = new Map<string, number | null>();
  const { webAnalyticsRefreshMinutes } = await import("./cronJobs");
  m.set("web-analytics", await webAnalyticsRefreshMinutes());
  return m;
}

/**
 * Cadência dinâmica: o push do Gmail está saudável (MAIL_PUSH ligado, tópico
 * configurado, watch em dia em todas as contas e push recebido há pouco —
 * mail_accounts.pushPendingAt)? Na dúvida (BD/flags em erro) fica a cadência
 * normal de 5 min.
 */
export async function loadDynamicCadence(now = Date.now()): Promise<DynamicCadence> {
  try {
    const { mailPushEnabled } = await import("./mail/service");
    const { mailPushState } = await import("./mail/store");
    const [flagOn, push] = await Promise.all([mailPushEnabled(), mailPushState(now)]);
    const topicConfigured = !!String(process.env.GMAIL_PUSH_TOPIC ?? "").trim();
    return { mailPushHealthy: mailPushHealthy({ flagOn, topicConfigured, lastPushAt: push.lastPushAt, allWatched: push.allWatched, now }) };
  } catch {
    return { mailPushHealthy: false };
  }
}

// ─── Estado (cron_job_state) ────────────────────────────────────────────────

const STATE_COLUMNS = sql`jobKey,
  DATE_FORMAT(lastStartedAt, '%Y-%m-%d %H:%i:%s.%f') AS lastStartedAt,
  DATE_FORMAT(lastFinishedAt, '%Y-%m-%d %H:%i:%s.%f') AS lastFinishedAt,
  DATE_FORMAT(lastOkAt, '%Y-%m-%d %H:%i:%s.%f') AS lastOkAt,
  lastStatus, lastError, lastDurationMs, resumeCursor, periodKey, attempts,
  DATE_FORMAT(leaseUntil, '%Y-%m-%d %H:%i:%s.%f') AS leaseUntil`;

function toState(r: any): JobState {
  const status = String(r.lastStatus ?? "");
  return {
    jobKey: String(r.jobKey),
    lastStartedAt: fromMysqlMs(r.lastStartedAt),
    lastFinishedAt: fromMysqlMs(r.lastFinishedAt),
    lastOkAt: fromMysqlMs(r.lastOkAt),
    lastStatus: (["ok", "error", "partial"].includes(status) ? status : null) as JobStatus | null,
    lastError: r.lastError ? String(r.lastError) : null,
    lastDurationMs: r.lastDurationMs == null ? null : Number(r.lastDurationMs),
    resumeCursor: r.resumeCursor ? String(r.resumeCursor) : null,
    periodKey: r.periodKey ? String(r.periodKey) : null,
    attempts: Number(r.attempts ?? 0),
    leaseUntil: fromMysqlMs(r.leaseUntil),
  };
}

export async function loadJobStates(): Promise<Map<string, JobState>> {
  const db = await getDb();
  const out = new Map<string, JobState>();
  // Sem BD não há lease nem estado: o tick falha (vermelho) em vez de fingir que correu.
  if (!db) throw new Error("Base de dados indisponível — o agendador não pode correr.");
  for (const r of rowsOf(await db.execute(sql`SELECT ${STATE_COLUMNS} FROM cron_job_state`))) {
    const st = toState(r);
    out.set(st.jobKey, st);
  }
  return out;
}

const dt = (ms: number | null) => (ms == null ? null : toMysqlMs(new Date(ms)));

/**
 * Reserva o trabalho (compare-and-set): só se o lease estiver livre/expirado
 * E ninguém o tiver arrancado desde que lemos o estado (`lastStartedAt`
 * igual ao lido). Marca o início na mesma instrução. true = é nosso.
 */
export async function acquireLease(jobKey: string, owner: string, now: number, until: number, seenStartedAt: number | null): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  await db.execute(sql`INSERT IGNORE INTO cron_job_state (jobKey) VALUES (${jobKey})`);
  const res = await db.execute(sql`
    UPDATE cron_job_state SET leaseUntil = ${toMysqlMs(new Date(until))}, leaseOwner = ${owner.slice(0, 40)}, lastStartedAt = ${toMysqlMs(new Date(now))}
     WHERE jobKey = ${jobKey} AND (leaseUntil IS NULL OR leaseUntil <= ${toMysqlMs(new Date(now))})
       AND lastStartedAt <=> ${dt(seenStartedAt)}`);
  return affected(res) > 0;
}

/** Grava o estado; com `owner`, só se o lease ainda for dele (e liberta-o). */
async function saveState(st: JobState, owner: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.execute(sql`
    UPDATE cron_job_state SET
      lastStartedAt = ${dt(st.lastStartedAt)}, lastFinishedAt = ${dt(st.lastFinishedAt)}, lastOkAt = ${dt(st.lastOkAt)},
      lastStatus = ${st.lastStatus}, lastError = ${st.lastError ? st.lastError.slice(0, 1000) : null}, lastDurationMs = ${st.lastDurationMs},
      resumeCursor = ${st.resumeCursor && st.resumeCursor.length <= 8000 ? st.resumeCursor : null}, periodKey = ${st.periodKey}, attempts = ${st.attempts},
      leaseUntil = NULL, leaseOwner = NULL
     WHERE jobKey = ${st.jobKey} AND leaseOwner = ${owner.slice(0, 40)}`);
}

async function loadJobState(jobKey: string): Promise<{ state: JobState; owner: string | null } | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const r = rowsOf(await db.execute(sql`SELECT ${STATE_COLUMNS}, leaseOwner FROM cron_job_state WHERE jobKey = ${jobKey} LIMIT 1`))[0];
  return r ? { state: toState(r), owner: r.leaseOwner ? String(r.leaseOwner) : null } : undefined;
}

// ─── Tick ───────────────────────────────────────────────────────────────────

export interface TickJobReport {
  key: string;
  status: JobStatus | "skipped";
  reason?: string;
  durationMs?: number;
  error?: string | null;
  done?: boolean;
}

export interface TickReport {
  ok: boolean;
  startedAt: string;
  budgetMs: number;
  planned: PlannedJob[];
  jobs: TickJobReport[];
  errors: string[];
}

export interface TickPlan { now: number; states: Map<string, JobState>; overrides: Map<string, number | null>; planned: PlannedJob[]; specs?: TickJobSpec[] }

/** O que está na altura agora (lê o estado; não reserva nada). */
export async function planDueJobs(now = Date.now()): Promise<TickPlan> {
  const states = await loadJobStates();
  const overrides = await fromOverrides().catch(() => new Map<string, number | null>());
  const specs = effectiveTickJobs(TICK_JOBS, await loadDynamicCadence(now));
  return { now, states, overrides, planned: planTick(specs, states, now, overrides), specs };
}

/** Mensagem de uma corrida que ficou sem resultado (a função morreu a meio). */
export const ABANDONED_ERROR = "a corrida anterior não terminou (função terminada pelo limite de tempo?)";

/** Corre UM trabalho com o lease dele; nunca lança. */
async function runOne(spec: TickJobSpec, plan: TickPlan, owner: string, deadlineAt: number): Promise<TickJobReport> {
  const now = Date.now();
  // Estado fresco (outro tick pode tê-lo corrido depois do plano).
  let fresh: { state: JobState; owner: string | null } | undefined;
  try { fresh = await loadJobState(spec.key); } catch { fresh = undefined; }
  let prev = fresh?.state ?? plan.states.get(spec.key);
  if (fresh && fresh.owner && !leaseFree(fresh.state.leaseUntil, now)) return { key: spec.key, status: "skipped", reason: "a correr noutro tick" };
  // Lease expirado sem resultado = a corrida anterior morreu (timeout do
  // Vercel): conta como falha — um diário espera 30 min e desiste à 3.ª.
  if (fresh && fresh.owner && prev?.lastStartedAt != null) {
    const period = periodKeyFor(spec.cadence, prev.lastStartedAt);
    const dead = applyOutcome(spec, prev, { ok: false, done: false, cursor: cursorForRun(prev, period), error: ABANDONED_ERROR, startedAt: prev.lastStartedAt, finishedAt: prev.leaseUntil ?? now });
    try { await saveState(dead, fresh.owner); prev = dead; } catch { /* segue com o que há */ }
  }
  if (!isDue(spec, prev, now, plan.states, plan.overrides.get(spec.key)).due) {
    return { key: spec.key, status: "skipped", reason: "já não está na altura" };
  }
  const startedAt = Date.now();
  if (!(await acquireLease(spec.key, owner, startedAt, deadlineAt + LEASE_GRACE_MS, prev?.lastStartedAt ?? null))) {
    return { key: spec.key, status: "skipped", reason: "a correr noutro tick" };
  }
  const period = periodKeyFor(spec.cadence, startedAt);
  const cursor = cursorForRun(prev, period);
  const runner = JOB_RUNNERS[spec.key];
  let run: CronJobRun;
  try {
    run = await recordCronRun(spec.runName, runMeta(spec.key, cursor), () => runner({ deadlineAt, cursor }));
  } catch (err: any) {
    run = { httpStatus: 500, body: { ok: false, error: String(err?.message ?? err).slice(0, 300) } };
  }
  const { cronOutcome } = await import("../shared/appSettings");
  const outcome = cronOutcome(run.httpStatus, run.body);
  const done = run.done ?? run.body?.done !== false;
  const finishedAt = Date.now();
  const next = applyOutcome(spec, prev, { ok: outcome.ok, done, cursor: run.cursor ?? null, error: outcome.error, startedAt, finishedAt });
  try { await saveState(next, owner); } catch (err: any) {
    console.warn(`[cron tick] ${spec.key}: gravar estado falhou:`, String(err?.message ?? err).slice(0, 160));
  }
  return { key: spec.key, status: next.lastStatus ?? "error", durationMs: finishedAt - startedAt, error: outcome.error, done };
}

/**
 * Corre o plano por ordem até acabar o orçamento (`budgetEndAt`). Os que não
 * couberem (tempo mínimo) ficam para o tick seguinte (continuam devidos).
 */
export async function runTick(plan: TickPlan, budgetEndAt: number): Promise<TickReport> {
  const owner = `tick-${plan.now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const SPECS = new Map((plan.specs ?? TICK_JOBS).map((s) => [s.key, s]));
  const report: TickReport = { ok: true, startedAt: new Date(plan.now).toISOString(), budgetMs: budgetEndAt - plan.now, planned: plan.planned, jobs: [], errors: [] };
  for (const p of plan.planned) {
    const spec = SPECS.get(p.key);
    if (!spec || !JOB_RUNNERS[p.key]) continue;
    const deadlineAt = jobDeadline(spec, Date.now(), budgetEndAt);
    if (deadlineAt == null) { report.jobs.push({ key: p.key, status: "skipped", reason: "sem tempo neste tick" }); continue; }
    const r = await runOne(spec, plan, owner, deadlineAt);
    report.jobs.push(r);
    if (r.status === "error") report.errors.push(`${p.key}: ${r.error ?? "erro"}`);
  }
  report.ok = report.errors.length === 0;
  return report;
}

// ─── Vista para as Definições (super admin) ─────────────────────────────────

export interface SchedulerJobView {
  key: string;
  label: string;
  runName: string;
  cadence: string;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastOkAt: number | null;
  lastStatus: JobStatus | null;
  lastError: string | null;
  lastDurationMs: number | null;
  running: boolean;
  /** O lease expirou sem o resultado ser gravado (a função morreu a meio). */
  abandoned: boolean;
  resuming: boolean;
  periodDone: boolean;
  attempts: number;
  nextDueAt: number | null;
  dueNow: boolean;
  dueReason: string;
}

export async function schedulerStatus(now = Date.now()): Promise<{ now: number; jobs: SchedulerJobView[] }> {
  const states = await loadJobStates();
  const overrides = await fromOverrides().catch(() => new Map<string, number | null>());
  const owners = new Map<string, string>();
  const db = await getDb();
  if (db) for (const r of rowsOf(await db.execute(sql`SELECT jobKey, leaseOwner FROM cron_job_state WHERE leaseOwner IS NOT NULL`))) owners.set(String(r.jobKey), String(r.leaseOwner));
  const specs = effectiveTickJobs(TICK_JOBS, await loadDynamicCadence(now));
  const jobs = specs.map((spec) => {
    const st = states.get(spec.key) ?? emptyState(spec.key);
    const due = isDue(spec, st, now, states, overrides.get(spec.key));
    const period = periodKeyFor(spec.cadence, now);
    return {
      key: spec.key, label: spec.label, runName: spec.runName, cadence: describeCadence(spec.cadence),
      lastStartedAt: st.lastStartedAt, lastFinishedAt: st.lastFinishedAt, lastOkAt: st.lastOkAt, lastStatus: st.lastStatus,
      lastError: st.lastError, lastDurationMs: st.lastDurationMs,
      running: st.leaseUntil != null && st.leaseUntil > now,
      abandoned: owners.has(spec.key) && (st.leaseUntil == null || st.leaseUntil <= now),
      resuming: st.lastStatus === "partial",
      periodDone: period != null && st.periodKey === period,
      attempts: st.attempts,
      nextDueAt: nextDueAt(spec, st, now, states, overrides.get(spec.key)),
      dueNow: due.due,
      dueReason: due.reason,
    };
  });
  return { now, jobs };
}
