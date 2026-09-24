/**
 * Regras PURAS da sincronização Multipark (sem BD, sem rede) — testadas em
 * syncRules.test.ts:
 *  - janela do sync recente POR PARQUE;
 *  - `ok` honesto das respostas dos crons de sincronização;
 *  - alerta "sem webhooks" em horário de operação (Lisboa);
 *  - diferenças da reconciliação diária (report vs BD).
 */

// ─── Janela do sync recente ──────────────────────────────────────────────────

export const RECENT_MAX_DAYS = 3;
export const RECENT_MARGIN_MINUTES = 60;

/**
 * Início da janela de cada parque. Base: agora − windowMinutes. Um parque
 * cuja última cobertura completa seja mais antiga alarga até lá (menos uma
 * margem); um parque sem cobertura usa `fallback` (sucesso legado global) ou,
 * sem nada, o máximo. Limite: `maxDays`. Cada parque é independente — um
 * parque partido não obriga os outros a pedir 3 dias.
 */
export function computeRecentWindows(input: {
  now: number;
  windowMinutes: number;
  parkIds: readonly string[];
  coverage: ReadonlyMap<string, number | null>;
  fallback?: number | null;
  maxDays?: number;
  marginMinutes?: number;
}): Map<string, number> {
  const maxDays = input.maxDays ?? RECENT_MAX_DAYS;
  const margin = (input.marginMinutes ?? RECENT_MARGIN_MINUTES) * 60_000;
  const floor = input.now - maxDays * 86_400_000;
  const base = input.now - Math.max(1, input.windowMinutes) * 60_000;
  const out = new Map<string, number>();
  for (const id of input.parkIds) {
    const covered = input.coverage.get(id) ?? input.fallback ?? null;
    let since = base;
    if (covered == null || !Number.isFinite(covered)) since = floor;
    else if (covered - margin < since) since = covered - margin;
    out.set(id, Math.max(floor, Math.min(base, since)));
  }
  return out;
}

/** "YYYY-MM-DD" (UTC) — granularidade do /bookings/report. */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** "YYYY-MM-DD HH:MM:SS" (UTC) para DATETIME. */
export const utcMysql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
/** DATETIME/TIMESTAMP em texto UTC → epoch ms (null se inválido). */
export function mysqlToMs(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  const d = new Date(String(v).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

// ─── Erros do report ─────────────────────────────────────────────────────────

/**
 * Um report tem de ser repetido quando pelo menos um pedido falhou por inteiro
 * (erro "<parque>/<ação>: …"). Erros de reservas individuais ("Booking <id>: …")
 * são dados inválidos de UMA reserva — repetir não os cura.
 */
export function chunkNeedsRetry(errors: readonly string[]): boolean {
  return errors.some((e) => !/^Booking\s/.test(e));
}

// ─── `ok` honesto dos crons ──────────────────────────────────────────────────

export interface CronVerdict { ok: boolean; error?: string; warnings?: string[] }

/** /api/cron/multipark-sync: vermelho quando há parques a repetir. */
export function recentSyncVerdict(r: { parkErrors: readonly string[]; errors: readonly string[]; partnersError?: string | null }): CronVerdict {
  const problems: string[] = [];
  if (r.parkErrors.length > 0 || chunkNeedsRetry(r.errors)) {
    const n = r.parkErrors.length || r.errors.filter((e) => !/^Booking\s/.test(e)).length;
    problems.push(`report falhou em ${n} parque(s)${r.parkErrors.length ? `: ${r.parkErrors.slice(0, 8).join(", ")}` : ""} — repete no ciclo seguinte`);
  }
  if (r.partnersError) problems.push(`descoberta de parceiros falhou: ${r.partnersError}`);
  const bookingErrors = r.errors.filter((e) => /^Booking\s/.test(e)).length;
  return {
    ok: problems.length === 0,
    ...(problems.length ? { error: problems.join("; ") } : {}),
    ...(bookingErrors ? { warnings: [`${bookingErrors} reserva(s) com dados inválidos`] } : {}),
  };
}

/** /api/cron/multipark-future: vermelho só quando não acabou E não avançou. */
export function futureSyncVerdict(r: { done: boolean; startOffset: number; nextOffset?: number; needsRetry: boolean; parkErrors: readonly string[] }): CronVerdict {
  if (r.done) return { ok: true };
  const progressed = r.nextOffset != null && r.nextOffset > r.startOffset;
  if (progressed) return { ok: true };
  return {
    ok: false,
    error: r.needsRetry
      ? `sem progresso na fatia ${r.startOffset}: report falhou${r.parkErrors.length ? ` em ${r.parkErrors.slice(0, 8).join(", ")}` : ""}`
      : `sem progresso na fatia ${r.startOffset}: prazo esgotado antes de acabar`,
  };
}

/** /api/cron/multipark-deliveries: falhas de itens são avisos; vermelho só
 *  quando uma fase inteira falhou (fila/BD indisponível, exceção). */
export function deliveriesVerdict(r: {
  phaseErrors: readonly string[];
  queue?: { failed: number; lostLease: number; dead: number } | null;
  details?: { errors: number; noKey: number } | null;
  history?: { errors: number; noKey: number } | null;
}): CronVerdict {
  const warnings: string[] = [];
  if (r.queue?.failed) warnings.push(`fila: ${r.queue.failed} por repetir`);
  if (r.queue?.dead) warnings.push(`fila: ${r.queue.dead} em dead-letter`);
  if (r.queue?.lostLease) warnings.push(`fila: ${r.queue.lostLease} lease perdida`);
  if (r.details?.errors) warnings.push(`detalhe: ${r.details.errors} erro(s)`);
  if (r.details?.noKey) warnings.push(`detalhe: ${r.details.noKey} sem chave`);
  if (r.history?.errors) warnings.push(`histórico: ${r.history.errors} erro(s)`);
  if (r.history?.noKey) warnings.push(`histórico: ${r.history.noKey} sem chave`);
  return {
    ok: r.phaseErrors.length === 0,
    ...(r.phaseErrors.length ? { error: r.phaseErrors.join("; ") } : {}),
    warnings,
  };
}

// ─── Alerta "sem webhooks" ───────────────────────────────────────────────────

export const WEBHOOK_ALERT_START_HOUR = 7;
export const WEBHOOK_ALERT_END_HOUR = 23;
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

// ─── Reconciliação diária ────────────────────────────────────────────────────

export const RECONCILIATION_DRIFT_THRESHOLD = 5;

export interface ReconciliationRow {
  day: string;
  parkId: string;
  actionType: string;
  apiTotal: number | null;
  apiCount: number;
  dbFound: number;
  missing: number;
  status: "ok" | "drift" | "error";
  errorCode: string | null;
}

/**
 * Compara um report com a BD. `apiIds` = ids distintos do report; `dbIds` =
 * os que existem em multipark_bookings. Drift = reservas do report que não
 * estão na BD, ou `total` diferente do que veio na lista (report truncado).
 */
export function reconciliationDiff(input: {
  day: string;
  parkId: string;
  actionType: string;
  apiTotal: number | null | undefined;
  apiIds: readonly string[];
  dbIds: ReadonlySet<string>;
}): ReconciliationRow {
  const unique = Array.from(new Set(input.apiIds));
  const found = unique.filter((id) => input.dbIds.has(id)).length;
  const missing = unique.length - found;
  const total = typeof input.apiTotal === "number" && Number.isFinite(input.apiTotal) ? input.apiTotal : null;
  const truncated = total != null && total !== input.apiIds.length;
  return {
    day: input.day, parkId: input.parkId, actionType: input.actionType,
    apiTotal: total, apiCount: unique.length, dbFound: found, missing,
    status: missing > 0 || truncated ? "drift" : "ok",
    errorCode: truncated ? "TOTAL_MISMATCH" : null,
  };
}

/** Drift total (reservas em falta + diferenças total≠lista) e se passa o limiar. */
export function reconciliationAlert(rows: readonly ReconciliationRow[], threshold = RECONCILIATION_DRIFT_THRESHOLD) {
  let missing = 0, mismatch = 0;
  const parks = new Set<string>();
  for (const r of rows) {
    if (r.status !== "drift") continue;
    missing += r.missing;
    if (r.apiTotal != null && r.apiTotal !== r.apiCount) mismatch += Math.abs(r.apiTotal - r.apiCount);
    parks.add(r.parkId);
  }
  const drift = missing + mismatch;
  return { drift, missing, mismatch, parks: Array.from(parks).sort(), alert: drift > threshold };
}
