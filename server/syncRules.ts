/**
 * Regras PURAS do webhook Multipark (sem BD, sem rede) — testadas em
 * syncRules.test.ts:
 *  - `ok` honesto da fila multipark-deliveries;
 *  - alerta "sem webhooks" em horário de operação (Lisboa).
 * (O sync pela API — janelas, sync futuro e reconciliação diária — saiu: as
 * páginas leem a BD da Multipark ao vivo.)
 */

/** "YYYY-MM-DD HH:MM:SS" (UTC) para DATETIME. */
export const utcMysql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
/** DATETIME/TIMESTAMP em texto UTC → epoch ms (null se inválido). */
export function mysqlToMs(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  const d = new Date(String(v).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

// ─── `ok` honesto dos crons ──────────────────────────────────────────────────

export interface CronVerdict { ok: boolean; error?: string; warnings?: string[] }

/** /api/cron/multipark-deliveries: falhas de itens são avisos; vermelho só
 *  quando uma fase inteira falhou (fila/BD indisponível, exceção). */
export function deliveriesVerdict(r: {
  phaseErrors: readonly string[];
  queue?: { failed: number; lostLease: number; dead: number } | null;
  details?: { errors: number; noKey: number } | null;
}): CronVerdict {
  const warnings: string[] = [];
  if (r.queue?.failed) warnings.push(`fila: ${r.queue.failed} por repetir`);
  if (r.queue?.dead) warnings.push(`fila: ${r.queue.dead} em dead-letter`);
  if (r.queue?.lostLease) warnings.push(`fila: ${r.queue.lostLease} lease perdida`);
  if (r.details?.errors) warnings.push(`detalhe: ${r.details.errors} erro(s)`);
  if (r.details?.noKey) warnings.push(`detalhe: ${r.details.noKey} sem chave`);
  return {
    ok: r.phaseErrors.length === 0,
    ...(r.phaseErrors.length ? { error: r.phaseErrors.join("; ") } : {}),
    warnings,
  };
}

// ─── Alerta "sem webhooks" ───────────────────────────────────────────────────

const WEBHOOK_ALERT_START_HOUR = 7;
const WEBHOOK_ALERT_END_HOUR = 23;
export const WEBHOOK_STALE_HOURS_DEFAULT = 3;

/** Hora (0–23) em Lisboa. */
export function lisbonHour(ms: number): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", hour: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  return Number(h) % 24;
}

/**
 * Estado do alerta e transição. Fora do horário (07–23 Lisboa) não levanta
 * alertas novos, mas também não os limpa (a noite sem reservas é normal; só
 * limpa quando chega um webhook). `raise`/`clear` = uma notificação por
 * transição.
 */
export function webhookAlertDecision(input: {
  now: number;
  lastWebhookAt: number | null;
  staleHours: number;
  wasActive: boolean;
  startHour?: number;
  endHour?: number;
}): { stale: boolean; inHours: boolean; active: boolean; transition: "raise" | "clear" | null } {
  const h = lisbonHour(input.now);
  const inHours = h >= (input.startHour ?? WEBHOOK_ALERT_START_HOUR) && h < (input.endHour ?? WEBHOOK_ALERT_END_HOUR);
  const limit = Math.max(1, input.staleHours) * 3_600_000;
  const stale = input.lastWebhookAt == null || input.now - input.lastWebhookAt > limit;
  let active = input.wasActive;
  if (!stale) active = false;
  else if (inHours) active = true;
  const transition = active && !input.wasActive ? "raise" : !active && input.wasActive ? "clear" : null;
  return { stale, inHours, active, transition };
}
