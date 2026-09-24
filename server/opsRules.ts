/**
 * Regras operacionais PURAS (sem BD) — testáveis em isolamento:
 *  - limite de intervalo do sync manual Multipark;
 *  - retenção do registo de atividade (activity_logs) em lotes limitados;
 *  - resposta do /api/health (pública vs detalhada, nunca com stack traces).
 */
import { cronAuthOk } from "./cronAuth";

// ─── Sync manual ──────────────────────────────────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Mensagem de erro (PT) quando o intervalo é inválido ou excede `maxDays`; `null` se OK. */
export function syncRangeError(startDate: string, endDate: string, maxDays = 31): string | null {
  const s = String(startDate ?? "").slice(0, 10);
  const e = String(endDate ?? "").slice(0, 10);
  if (!ISO_DAY.test(s) || !ISO_DAY.test(e)) return "Datas inválidas (formato AAAA-MM-DD).";
  const a = Date.parse(`${s}T00:00:00Z`);
  const b = Date.parse(`${e}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "Datas inválidas.";
  if (b < a) return "A data final é anterior à inicial.";
  const days = Math.round((b - a) / 86_400_000) + 1;
  if (days > maxDays) return `Intervalo demasiado grande (${days} dias). Máximo: ${maxDays} dias por sincronização.`;
  return null;
}

// ─── Retenção do activity_logs ────────────────────────────────────────────────

export const ACTIVITY_LOG_RETENTION_MONTHS = 12;
export const ACTIVITY_LOG_PURGE_BATCH = 5000;

/** Corte "YYYY-MM-DD HH:MM:SS" (UTC): tudo o que for anterior é apagado. */
export function activityLogCutoff(now: Date = new Date(), months = ACTIVITY_LOG_RETENTION_MONTHS): string {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Apaga em lotes (`DELETE … WHERE createdAt < ? LIMIT n`, sem subquery sobre a
 * mesma tabela) até um lote vir incompleto, esgotar `maxBatches` ou passar o
 * prazo. `deleteBatch` executa UM lote e devolve as linhas apagadas.
 */
export async function purgeInBatches(
  deleteBatch: (limit: number) => Promise<number>,
  opts: { batchSize?: number; maxBatches?: number; deadlineAt?: number; now?: () => number } = {},
): Promise<{ deleted: number; batches: number; done: boolean }> {
  const batchSize = opts.batchSize ?? ACTIVITY_LOG_PURGE_BATCH;
  const maxBatches = opts.maxBatches ?? 20;
  const now = opts.now ?? Date.now;
  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    if (opts.deadlineAt != null && now() >= opts.deadlineAt) return { deleted, batches, done: false };
    const n = await deleteBatch(batchSize);
    batches++;
    deleted += n;
    if (n < batchSize) return { deleted, batches, done: true };
  }
  return { deleted, batches, done: false };
}

// ─── /api/health ──────────────────────────────────────────────────────────────

export type EnvLike = Record<string, string | undefined>;

/** Versão curta do deploy (commit), se o host a expuser. */
export function deployVersion(env: EnvLike = process.env): string | undefined {
  const sha = env.VERCEL_GIT_COMMIT_SHA || env.RAILWAY_GIT_COMMIT_SHA || env.GIT_COMMIT_SHA || "";
  return sha ? sha.slice(0, 7) : undefined;
}

/**
 * Corpo do /api/health. Público: só `{ ok, version? }`. Detalhado (sessão
 * admin ou Bearer CRON_SECRET): presença (booleana) das variáveis críticas.
 * NUNCA inclui a mensagem/stack do erro de arranque — essa vai só para o log.
 */
export function buildHealthBody(opts: { initFailed: boolean; detailed: boolean; env?: EnvLike }) {
  const env = opts.env ?? process.env;
  const version = deployVersion(env);
  const base: Record<string, unknown> = { ok: !opts.initFailed };
  if (version) base.version = version;
  if (!opts.detailed) return base;
  const has = (k: string) => !!(env[k] && String(env[k]).trim());
  return {
    ...base,
    time: new Date().toISOString(),
    env: {
      DATABASE_URL: has("DATABASE_URL"),
      JWT_SECRET: has("JWT_SECRET"),
      GOOGLE_CLIENT_ID: has("GOOGLE_CLIENT_ID"),
      GOOGLE_CLIENT_SECRET: has("GOOGLE_CLIENT_SECRET"),
      VITE_APP_ID: has("VITE_APP_ID"),
      NODE_ENV: env.NODE_ENV ?? null,
      CRON_SECRET: has("CRON_SECRET"),
      LLM: has("LLM_API_KEY") || has("OPENAI_API_KEY"),
      SMTP: has("SMTP_HOST") && has("SMTP_USER") && has("SMTP_PASS"),
      IMAP: has("IMAP_USER") && has("IMAP_PASS"),
      WHATSAPP_TOKEN: has("WHATSAPP_TOKEN"),
      WHATSAPP_PHONE_NUMBER_ID: has("WHATSAPP_PHONE_NUMBER_ID"),
      WHATSAPP_VERIFY_TOKEN: has("WHATSAPP_VERIFY_TOKEN"),
      WHATSAPP_APP_SECRET: has("WHATSAPP_APP_SECRET"),
      WHATSAPP_WABA_ID: has("WHATSAPP_WABA_ID"),
      AVAILABILITY_FORM_TOKEN_SECRET: has("AVAILABILITY_FORM_TOKEN_SECRET"),
      AVAILABILITY_FORM_URL: has("AVAILABILITY_FORM_URL"),
      MULTIPARK_WEBHOOK_SECRET: has("MULTIPARK_WEBHOOK_SECRET"),
      INPROCESS_SCHEDULERS: env.INPROCESS_SCHEDULERS ?? null,
    },
  };
}

/** Bearer CRON_SECRET válido? (sem segredo configurado → nunca). */
export function cronBearerOk(authorization: unknown, env: EnvLike = process.env): boolean {
  return cronAuthOk(authorization, env);
}
