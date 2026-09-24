/**
 * Registo das corridas dos crons (/api/cron/*, chamados pelo GitHub Actions)
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
import { CRON_JOBS, cronHealth, cronNameFromPath, cronOutcome, staleThresholdMinutes, type CronHealth } from "../shared/appSettings";

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

async function insertRun(name: string, startedAt: Date, meta: string | null): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const res = await db.execute(sql`
    INSERT INTO cron_runs (name, startedAt, meta) VALUES (${name}, ${toMysqlMs(startedAt)}, ${meta})`);
  const header = Array.isArray(res) ? res[0] : res;
  const id = Number((header as any)?.insertId ?? 0);
  return id > 0 ? id : null;
}

async function finishRun(id: number, startedAt: Date, finishedAt: Date, httpStatus: number, ok: boolean, error: string | null): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  await db.execute(sql`
    UPDATE cron_runs SET finishedAt = ${toMysqlMs(finishedAt)}, ok = ${ok ? 1 : 0}, error = ${error},
           durationMs = ${durationMs}, httpStatus = ${httpStatus}
     WHERE id = ${id}`);
  // Retenção: ~1 em 50 corridas apaga o que tiver mais de 30 dias (em lote,
  // sem subquery sobre a mesma tabela).
  if (Math.random() < 0.02) {
    const cutoff = toMysqlMs(new Date(Date.now() - RETENTION_DAYS * 86_400_000));
    await db.execute(sql`DELETE FROM cron_runs WHERE startedAt < ${cutoff} LIMIT 5000`);
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
    error: r.error ? String(r.error) : null,
    durationMs: r.durationMs == null ? null : Number(r.durationMs),
    httpStatus: r.httpStatus == null ? null : Number(r.httpStatus),
    meta: r.meta ? String(r.meta) : null,
  };
}

const RUN_COLUMNS = sql`id, DATE_FORMAT(startedAt, '%Y-%m-%d %H:%i:%s.%f') AS startedAt,
  DATE_FORMAT(finishedAt, '%Y-%m-%d %H:%i:%s.%f') AS finishedAt, ok, error, durationMs, httpStatus, meta`;

export async function getCronStatuses(now = Date.now()): Promise<CronStatus[]> {
  const db = await getDb();
  const known = new Map(CRON_JOBS.map((j) => [j.name, j]));
  if (!db) return [];
  const since = toMysqlMs(new Date(now - 86_400_000));

  // Agregados só com colunas agrupadas (ONLY_FULL_GROUP_BY).
  const aggRes = await db.execute(sql`
    SELECT name, COUNT(*) AS runs, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures
      FROM cron_runs WHERE startedAt >= ${since} GROUP BY name`);
  const okRes = await db.execute(sql`
    SELECT name, DATE_FORMAT(MAX(finishedAt), '%Y-%m-%d %H:%i:%s.%f') AS lastOkAt
      FROM cron_runs WHERE ok = 1 GROUP BY name`);
  const namesRes = await db.execute(sql`SELECT DISTINCT name FROM cron_runs`);
  const agg = new Map(rowsOf(aggRes).map((r) => [String(r.name), { runs: Number(r.runs), failures: Number(r.failures ?? 0) }]));
  const lastOk = new Map(rowsOf(okRes).map((r) => [String(r.name), fromMysqlMs(r.lastOkAt)]));
  const names = Array.from(new Set([...known.keys(), ...rowsOf(namesRes).map((r) => String(r.name))]));

  return Promise.all(names.map(async (name) => {
    const job = known.get(name);
    const recentRes = await db.execute(sql`SELECT ${RUN_COLUMNS} FROM cron_runs WHERE name = ${name} ORDER BY startedAt DESC LIMIT 10`);
    const failRes = await db.execute(sql`SELECT ${RUN_COLUMNS} FROM cron_runs WHERE name = ${name} AND ok = 0 ORDER BY startedAt DESC LIMIT 1`);
    const recent = rowsOf(recentRes).map(toView);
    const last = recent[0] ?? null;
    const interval = job?.intervalMinutes ?? null;
    return {
      name,
      label: job?.label ?? name,
      workflow: job?.workflow ?? "—",
      intervalMinutes: interval,
      staleAfterMinutes: interval == null ? null : staleThresholdMinutes(interval),
      health: cronHealth(last, interval, now),
      last,
      lastOkAt: lastOk.get(name) ?? null,
      lastFailure: rowsOf(failRes).map(toView)[0] ?? null,
      runs24h: agg.get(name)?.runs ?? 0,
      failures24h: agg.get(name)?.failures ?? 0,
      recent,
    };
  }));
}
