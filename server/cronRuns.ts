/**
 * Registo das corridas dos crons (/api/cron/*: o agendador /api/cron/tick e
 * as chamadas manuais)
 * na tabela `cron_runs` (migração 0098): nome, início, fim, ok, erro, duração.
 *
 * `cronRunRecorder()` é um middleware Express montado em "/api/cron" ANTES das
 * rotas: embrulha TODOS os handlers de cron sem lhes mexer. Só regista pedidos
 * autenticados (Bearer CRON_SECRET) — um 401 de um scanner não é uma corrida.
 *   - à entrada: INSERT da linha (ok = NULL → "a correr") e refresh das
 *     sobreposições dos interruptores (a automação decide com o valor fresco);
 *   - à saída (evento `finish`): UPDATE com fim, duração, ok e erro, a partir
 *     do HTTP status e do corpo JSON (`ok:false`, `status:"failed"`, `stepErrors`).
 * Uma linha que fica sem fim = a função morreu (ex.: timeout de 60s do Vercel).
 *
 * Nunca parte o cron: qualquer falha a registar vai só para o log.
 */
import type { NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { cronAuthOk } from "./cronAuth";
import { CRON_JOBS, cronHealth, cronNameFromPath, cronOutcome, cronSkipProblem, isRetiredCron, staleThresholdMinutes, type CronHealth } from "../shared/appSettings";
import { scrubSecrets } from "./integrationsStatus";

/** "YYYY-MM-DD HH:MM:SS.mmm" (UTC) — DATETIME(3). */
export function toMysqlMs(d: Date): string {
  return d.toISOString().slice(0, 23).replace("T", " ");
}
/** Inverso de toMysqlMs (texto UTC → epoch ms); `null` se vazio/inválido. */
export function fromMysqlMs(s: unknown): number | null {
  if (s == null || s === "") return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/);
  if (!m) return null;
  const ms = m[7] ? Number(m[7].padEnd(3, "0").slice(0, 3)) : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
}

function rowsOf(res: unknown): any[] {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
}

const RETENTION_DAYS = 30;

/** 20b: erros e query strings sem segredos (tokens, passwords em URLs) antes de gravar/mostrar. */
function clean(v: string | null, max: number): string | null {
  if (v == null) return null;
  return scrubSecrets(v, process.env, max);
}

async function insertRun(name: string, startedAt: Date, meta: string | null): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const res = await db.execute(sql`
    INSERT INTO cron_runs (name, startedAt, meta) VALUES (${name}, ${toMysqlMs(startedAt)}, ${clean(meta, 255)})`);
  const header = Array.isArray(res) ? res[0] : res;
  const id = Number((header as any)?.insertId ?? 0);
  return id > 0 ? id : null;
}

async function finishRun(id: number, startedAt: Date, finishedAt: Date, httpStatus: number, ok: boolean, error: string | null): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  await db.execute(sql`
    UPDATE cron_runs SET finishedAt = ${toMysqlMs(finishedAt)}, ok = ${ok ? 1 : 0}, error = ${clean(error, 1000)},
           durationMs = ${durationMs}, httpStatus = ${httpStatus}
     WHERE id = ${id}`);
  // Retenção: ~1 em 50 corridas apaga o que tiver mais de 30 dias (em lote,
  // sem subquery sobre a mesma tabela). 20b: a ÚLTIMA corrida de cada cron
  // fica sempre — um cron parado há mais de 30 dias continua a aparecer como
  // "Parado" (antes ficava "Sem registo", sem alarme).
  if (Math.random() < 0.02) {
    const cutoff = toMysqlMs(new Date(Date.now() - RETENTION_DAYS * 86_400_000));
    const keep = rowsOf(await db.execute(sql`SELECT MAX(id) AS id FROM cron_runs GROUP BY name`)).map((r) => Number(r.id)).filter((n) => n > 0);
    await db.execute(sql`DELETE FROM cron_runs WHERE startedAt < ${cutoff}${keep.length ? sql` AND id NOT IN (${sql.join(keep.map((k) => sql`${k}`), sql`, `)})` : sql``} LIMIT 5000`);
  }
}

/**
 * Regista uma corrida feita DENTRO do processo (agendador /api/cron/tick):
 * mesma linha em cron_runs que um pedido HTTP a /api/cron/<name> daria, para
 * o Estado do sistema e os alertas de "cron parado" continuarem a funcionar.
 * Nunca lança por causa do registo (só se o próprio `run` lançar).
 */
export async function recordCronRun<T extends { httpStatus: number; body: unknown }>(name: string, meta: string | null, run: () => Promise<T>): Promise<T> {
  const startedAt = new Date();
  const id = await insertRun(name, startedAt, meta ? meta.slice(0, 255) : null).catch((err) => {
    console.warn(`[cron_runs] ${name}: registo inicial falhou:`, String(err?.message ?? err).slice(0, 160));
    return null;
  });
  let result: T | null = null;
  try {
    result = await run();
    return result;
  } finally {
    const outcome = result ? cronOutcome(result.httpStatus, result.body) : { ok: false, error: "exceção", note: null };
    if (id) {
      await finishRun(id, startedAt, new Date(), result?.httpStatus ?? 500, outcome.ok, outcome.error ?? outcome.note ?? null)
        .catch((err) => console.warn(`[cron_runs] ${name}: registo final falhou:`, String(err?.message ?? err).slice(0, 160)));
    }
  }
}

function cronAuthorized(req: Request): boolean {
  return cronAuthOk(req.headers["authorization"]);
}

/**
 * Middleware para `app.use("/api/cron", cronRunRecorder({ defer }))`.
 * `defer` mantém viva a função serverless até a escrita final acabar
 * (Vercel: `waitUntil`); sem ele, a promessa corre solta (servidor Node).
 */
export function cronRunRecorder(opts: { defer?: (p: Promise<unknown>) => void } = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const name = cronNameFromPath(req.path);
    if (!name || !cronAuthorized(req)) return next();
    const startedAt = new Date();
    const qi = req.originalUrl.indexOf("?");
    const query = qi >= 0 ? req.originalUrl.slice(qi + 1, qi + 256) || null : null;

    let body: unknown;
    const origJson = res.json.bind(res);
    res.json = ((b: unknown) => { body = b; return origJson(b); }) as typeof res.json;

    const idPromise = insertRun(name, startedAt, query).catch((err) => {
      console.warn(`[cron_runs] ${name}: registo inicial falhou:`, String(err?.message ?? err).slice(0, 160));
      return null;
    });

    res.on("finish", () => {
      const finishedAt = new Date();
      const outcome = cronOutcome(res.statusCode, body);
      const p = idPromise
        .then((id) => (id ? finishRun(id, startedAt, finishedAt, res.statusCode, outcome.ok, outcome.error ?? outcome.note ?? null) : undefined))
        .catch((err) => console.warn(`[cron_runs] ${name}: registo final falhou:`, String(err?.message ?? err).slice(0, 160)))
        // Alertas (ligação a religar / cron parado), 1×/10 min por processo.
        .then(() => import("./integrations/alerts").then((m) => m.evaluateIntegrationAlerts()))
        .catch(() => undefined);
      if (opts.defer) {
        try { opts.defer(p); } catch { /* segue */ }
      }
    });

    // A linha inicial e as sobreposições dos interruptores ficam prontas antes
    // do handler (uma query curta cada; nunca bloqueiam em erro).
    Promise.all([
      idPromise,
      import("./_core/featureFlags").then((m) => m.ensureFeatureFlagOverrides()).catch(() => undefined),
    ]).finally(() => next());
  };
}

// ─── Leitura para a página Definições → Estado do sistema ──────────────────

export interface CronRunView {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  error: string | null;
  durationMs: number | null;
  httpStatus: number | null;
  meta: string | null;
}

export interface CronStatus {
  name: string;
  label: string;
  workflow: string;
  intervalMinutes: number | null;
  staleAfterMinutes: number | null;
  health: CronHealth;
  last: CronRunView | null;
  lastOkAt: number | null;
  lastFailure: CronRunView | null;
  runs24h: number;
  failures24h: number;
  recent: CronRunView[];
}

function toView(r: any): CronRunView {
  return {
    id: Number(r.id),
    startedAt: fromMysqlMs(r.startedAt) ?? 0,
    finishedAt: fromMysqlMs(r.finishedAt),
    ok: r.ok == null ? null : Number(r.ok) === 1,
    error: r.error ? clean(String(r.error), 1000) : null,
    durationMs: r.durationMs == null ? null : Number(r.durationMs),
    httpStatus: r.httpStatus == null ? null : Number(r.httpStatus),
    meta: r.meta ? clean(String(r.meta), 255) : null,
  };
}

const RUN_COLUMNS = sql`id, DATE_FORMAT(startedAt, '%Y-%m-%d %H:%i:%s.%f') AS startedAt,
  DATE_FORMAT(finishedAt, '%Y-%m-%d %H:%i:%s.%f') AS finishedAt, ok, error, durationMs, httpStatus, meta`;

/**
 * `intervalOverrides`: intervalo esperado efetivo de um cron quando a agenda
 * muda em tempo real (ex.: mail-sync de 5 em 5 min sem o push do Gmail, de
 * hora a hora com ele) — o "Parado" passa a ser medido pelo que está em vigor.
 */
/** Nomes dos trabalhos retirados com histórico (para a nota da página). Nunca lança. */
export async function getRetiredCronNames(now = Date.now()): Promise<string[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    const known = new Set(CRON_JOBS.map((j) => j.name));
    const res = await db.execute(sql`SELECT name, DATE_FORMAT(MAX(startedAt), '%Y-%m-%d %H:%i:%s.%f') AS lastAt FROM cron_runs GROUP BY name`);
    return rowsOf(res).map((r) => ({ name: String(r.name), lastAt: fromMysqlMs(r.lastAt) }))
      .filter((r) => isRetiredCron(known.has(r.name), r.lastAt, now)).map((r) => r.name).sort();
  } catch {
    return [];
  }
}

export async function getCronStatuses(now = Date.now(), intervalOverrides: ReadonlyMap<string, number> = new Map()): Promise<CronStatus[]> {
  const db = await getDb();
  // 20b: sem BD é erro — antes [] e a página dizia "Tudo a correr".
  if (!db) throw new Error("Base de dados indisponível — estado dos crons desconhecido.");
  const known = new Map(CRON_JOBS.map((j) => [j.name, j]));
  const since = toMysqlMs(new Date(now - 86_400_000));

  // Agregados só com colunas agrupadas (ONLY_FULL_GROUP_BY).
  const aggRes = await db.execute(sql`
    SELECT name, COUNT(*) AS runs, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures
      FROM cron_runs WHERE startedAt >= ${since} GROUP BY name`);
  // "Último OK" = a última que FEZ o trabalho: uma corrida saltada (interruptor
  // desligado, sem configuração…) é verde mas não conta (20b).
  const okRes = await db.execute(sql`
    SELECT name, DATE_FORMAT(MAX(finishedAt), '%Y-%m-%d %H:%i:%s.%f') AS lastOkAt
      FROM cron_runs WHERE ok = 1 AND (error IS NULL OR error NOT LIKE 'saltado:%') GROUP BY name`);
  // Nomes + 1.ª corrida registada (D57: "saltado há dias" sem nenhum OK desde o início).
  const namesRes = await db.execute(sql`
    SELECT name, DATE_FORMAT(MIN(startedAt), '%Y-%m-%d %H:%i:%s.%f') AS firstAt,
           DATE_FORMAT(MAX(startedAt), '%Y-%m-%d %H:%i:%s.%f') AS lastAt FROM cron_runs GROUP BY name`);
  const agg = new Map(rowsOf(aggRes).map((r) => [String(r.name), { runs: Number(r.runs), failures: Number(r.failures ?? 0) }]));
  const lastOk = new Map(rowsOf(okRes).map((r) => [String(r.name), fromMysqlMs(r.lastOkAt)]));
  const firstAt = new Map(rowsOf(namesRes).map((r) => [String(r.name), fromMysqlMs(r.firstAt)]));
  const lastAt = new Map(rowsOf(namesRes).map((r) => [String(r.name), fromMysqlMs(r.lastAt)]));
  // Trabalhos retirados (fora de CRON_JOBS e sem corridas há dias) não entram: nem na lista, nem nos alertas.
  const names = Array.from(new Set([...known.keys(), ...firstAt.keys()]))
    .filter((n) => !isRetiredCron(known.has(n), lastAt.get(n) ?? null, now));

  return Promise.all(names.map(async (name) => {
    const job = known.get(name);
    const recentRes = await db.execute(sql`SELECT ${RUN_COLUMNS} FROM cron_runs WHERE name = ${name} ORDER BY startedAt DESC LIMIT 10`);
    const failRes = await db.execute(sql`SELECT ${RUN_COLUMNS} FROM cron_runs WHERE name = ${name} AND ok = 0 ORDER BY startedAt DESC LIMIT 1`);
    const recent = rowsOf(recentRes).map(toView);
    const last = recent[0] ?? null;
    const interval = intervalOverrides.get(name) ?? job?.intervalMinutes ?? null;
    const okAt = lastOk.get(name) ?? null;
    const health0 = cronHealth(last, interval, now);
    // D57: corre mas salta há dias por falta de configuração/ligação → problema.
    const health: CronHealth = health0 === "ok" && cronSkipProblem(last, okAt, firstAt.get(name) ?? null, now) ? "skipping" : health0;
    return {
      name,
      label: job?.label ?? name,
      workflow: job?.workflow ?? "—",
      intervalMinutes: interval,
      staleAfterMinutes: interval == null ? null : staleThresholdMinutes(interval),
      health,
      last,
      lastOkAt: okAt,
      lastFailure: rowsOf(failRes).map(toView)[0] ?? null,
      runs24h: agg.get(name)?.runs ?? 0,
      failures24h: agg.get(name)?.failures ?? 0,
      recent,
    };
  }));
}
