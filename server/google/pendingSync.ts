/**
 * Fila "sincronizar já" com o Google (tabela google_sync_pending, migração
 * 0200) e o heartbeat do dashboard (shared/googlePush.ts):
 *
 *  - alteração no dashboard (tarefa, turno, SLA, formação, prova de uma
 *    reclamação) ou notificação da Google → `markPending(chave)` e corrida
 *    imediata em segundo plano (waitUntil no Vercel), sem atrasar a resposta;
 *  - cada âmbito corre com lease (`runningUntil`); a linha só sai quando
 *    ninguém a marcou entretanto (`version`) — marcações durante uma
 *    corrida fazem-na correr outra vez, nunca se perdem;
 *  - falha → espera crescente (2, 4, 8… min, até 2 h) e o agendador
 *    (google-pending, de 15 em 15 min) repete; ao fim de 8 falhas desiste
 *    (o google-sync de 4 em 4 h apanha);
 *  - heartbeat: Tarefas e Contactos (a Google não avisa) quando a pessoa
 *    abre o dashboard e de 5 em 5 min enquanto o tem aberto e visível;
 *    no máximo 1 corrida por pessoa a cada ~5 min, por mais abas que tenha.
 */
import { sql } from "drizzle-orm";
import {
  HEARTBEAT_MIN_GAP_MS, PENDING_MAX_ATTEMPTS, parsePendingKey, pendingBackoffMs, type PendingScope,
} from "../../shared/googlePush";
import { SHARED_CALENDAR_CITIES, toSqlUtc } from "../../shared/googleSync";
import { hasFeatureScopes } from "../../shared/mail";
import { affected, db, ensureStateRow, inList, rowsOf } from "./syncStore";

/** Lease de uma corrida de um âmbito (mais do que o prazo máximo de uma função). */
const LEASE_MS = 100_000;

/** Mantém a função viva depois de responder (Vercel); fora do Vercel a promessa corre sozinha. */
export function deferGoogleWork(p: Promise<unknown>): void {
  const safe = p.catch((err) => console.warn("[google-sync] em segundo plano falhou:", String(err?.message ?? err).slice(0, 160)));
  import("@vercel/functions").then((m) => m.waitUntil(safe)).catch(() => { /* fora do Vercel */ });
}

// ─── Fila ───────────────────────────────────────────────────────────────────

export async function markPending(keys: readonly string[], reason: string, now = Date.now()): Promise<string[]> {
  const valid = Array.from(new Set(keys.filter((k) => parsePendingKey(k) != null)));
  if (!valid.length) return [];
  const d = await db();
  const at = toSqlUtc(now);
  for (const k of valid) {
    await d.execute(sql`INSERT INTO google_sync_pending (scopeKey, reason, version, dirtyAt) VALUES (${k}, ${reason.slice(0, 32)}, 1, ${at})
      ON DUPLICATE KEY UPDATE version = version + 1, dirtyAt = VALUES(dirtyAt), reason = VALUES(reason), attempts = 0, nextAttemptAt = NULL, lastError = NULL`);
  }
  return valid;
}

export type ScopeRunStatus = "ok" | "partial" | "error";
export type ScopeRunner = (scope: PendingScope, deadlineAt: number) => Promise<{ status: ScopeRunStatus; error?: string | null }>;

export interface DrainReport { ran: number; succeeded: number; partial: number; failed: number; gaveUp: number; remaining: boolean; errors: string[] }

/**
 * Corre os âmbitos pendentes (os dados, ou todos os que estão na altura), um
 * a um, até ao prazo. `runner` injetável nos testes.
 */
export async function drainPending(opts: { deadlineAt: number; keys?: readonly string[] | null; runner?: ScopeRunner; now?: () => number }): Promise<DrainReport> {
  const now = opts.now ?? Date.now;
  const report: DrainReport = { ran: 0, succeeded: 0, partial: 0, failed: 0, gaveUp: 0, remaining: false, errors: [] };
  const runner = opts.runner ?? runScope;
  const d = await db();
  const at = toSqlUtc(now());
  const only = opts.keys?.length ? sql`scopeKey IN (${inList(opts.keys)})` : sql`(nextAttemptAt IS NULL OR nextAttemptAt <= ${at})`;
  const rows = rowsOf(await d.execute(sql`SELECT scopeKey, version, attempts FROM google_sync_pending WHERE ${only} ORDER BY dirtyAt LIMIT 100`));
  for (const r of rows) {
    const key = String(r.scopeKey);
    if (now() > opts.deadlineAt - 6_000) { report.remaining = true; break; }
    const scope = parsePendingKey(key);
    if (!scope) { await d.execute(sql`DELETE FROM google_sync_pending WHERE scopeKey = ${key}`); continue; }
    let version = Number(r.version);
    const t = now();
    const claim = await d.execute(sql`UPDATE google_sync_pending SET runningUntil = ${toSqlUtc(t + LEASE_MS)}
      WHERE scopeKey = ${key} AND (runningUntil IS NULL OR runningUntil < ${toSqlUtc(t)}) AND (nextAttemptAt IS NULL OR nextAttemptAt <= ${toSqlUtc(t)})`);
    if (affected(claim) !== 1) { report.remaining = true; continue; } // outra corrida tem-no, ou está à espera depois de uma falha
    version = Number(rowsOf(await d.execute(sql`SELECT version FROM google_sync_pending WHERE scopeKey = ${key} LIMIT 1`))[0]?.version ?? version);
    for (let round = 0; round < 3; round++) {
      report.ran++;
      let res: { status: ScopeRunStatus; error?: string | null };
      try { res = await runner(scope, opts.deadlineAt); }
      catch (err: any) { res = { status: "error", error: String(err?.message ?? err) }; }
      if (res.status === "ok") {
        report.succeeded++;
        const del = await d.execute(sql`DELETE FROM google_sync_pending WHERE scopeKey = ${key} AND version = ${version}`);
        if (affected(del) === 1) break;
        // Marcado outra vez durante a corrida → corre de novo (se houver tempo).
        version = Number(rowsOf(await d.execute(sql`SELECT version FROM google_sync_pending WHERE scopeKey = ${key} LIMIT 1`))[0]?.version ?? version);
        if (now() > opts.deadlineAt - 8_000 || round === 2) {
          await d.execute(sql`UPDATE google_sync_pending SET runningUntil = NULL WHERE scopeKey = ${key}`);
          report.remaining = true;
          break;
        }
        continue;
      }
      if (res.status === "partial") {
        report.partial++;
        report.remaining = true;
        await d.execute(sql`UPDATE google_sync_pending SET runningUntil = NULL WHERE scopeKey = ${key}`);
        break;
      }
      report.failed++;
      const attempts = Number(r.attempts ?? 0) + 1;
      const msg = String(res.error ?? "erro").replace(/\s+/g, " ").slice(0, 500);
      report.errors.push(`${key}: ${msg.slice(0, 200)}`);
      if (attempts >= PENDING_MAX_ATTEMPTS) {
        report.gaveUp++;
        await d.execute(sql`DELETE FROM google_sync_pending WHERE scopeKey = ${key} AND version = ${version}`);
        await d.execute(sql`UPDATE google_sync_pending SET runningUntil = NULL WHERE scopeKey = ${key}`);
      } else {
        await d.execute(sql`UPDATE google_sync_pending SET runningUntil = NULL, attempts = ${attempts}, lastError = ${msg},
          nextAttemptAt = ${toSqlUtc(now() + pendingBackoffMs(attempts))} WHERE scopeKey = ${key}`);
        report.remaining = true;
      }
      break;
    }
  }
  return report;
}

// ─── Âmbito → corrida ───────────────────────────────────────────────────────

const USER_DONE = new Set(["ok", "skipped", "scope_missing", "reauth_required"]);

async function runUserScope(userId: number, parts: { tasks: boolean; calendar: boolean; contacts: boolean }, deadlineAt: number) {
  const { runGoogleSync } = await import("./syncService");
  const r = await runGoogleSync({ deadlineAt, onlyUserIds: [userId], includeShared: false, parts });
  const me = r.users[0];
  if (!me) return { status: (r.errors.length ? "error" : "ok") as ScopeRunStatus, error: r.errors[0] ?? null };
  if (USER_DONE.has(me.status)) return { status: "ok" as ScopeRunStatus };
  if (me.status === "partial" || me.status === "rate_limited") return { status: "partial" as ScopeRunStatus };
  return { status: "error" as ScopeRunStatus, error: me.error ?? me.status };
}

/** Corre um âmbito (sincronização incremental só daquilo). */
export const runScope: ScopeRunner = async (scope, deadlineAt) => {
  switch (scope.kind) {
    case "user": return runUserScope(scope.userId, { tasks: true, calendar: true, contacts: false }, deadlineAt);
    case "user-cal": return runUserScope(scope.userId, { tasks: false, calendar: true, contacts: false }, deadlineAt);
    case "shared": {
      const { syncSharedCalendars } = await import("./syncService");
      const r = await syncSharedCalendars({ deadlineAt, onlyCity: scope.city });
      if (r.errors.length) return { status: "error", error: r.errors[0] };
      return { status: r.cities.some((c) => c.status === "partial") ? "partial" : "ok" };
    }
    case "drive-kb": {
      const { runKbChanges } = await import("../knowledge/driveChanges");
      const r = await runKbChanges({ deadlineAt });
      return r.status === "error" ? { status: "error", error: r.error } : { status: r.status === "partial" ? "partial" : "ok" };
    }
    case "drive-mirror": {
      const { runDriveJobs } = await import("./driveJobs");
      const r = await runDriveJobs({ deadlineAt, includeLive: false });
      if (r.errors.length) return { status: "error", error: r.errors[0] };
      return { status: r.done ? "ok" : "partial" };
    }
  }
};

/** Marca e corre já (≤ 25 s). */
async function markAndDrain(keys: readonly string[], reason: string): Promise<void> {
  if (!keys.length) return;
  const marked = await markPending(keys, reason);
  if (marked.length) await drainPending({ deadlineAt: Date.now() + 25_000, keys: marked });
}

/** Marca e corre já em segundo plano (≤ 25 s); nunca lança — o agendador repete o que falhar. */
export function scheduleGoogleSync(keys: readonly string[], reason: string): void {
  if (!keys.length) return;
  deferGoogleWork(markAndDrain(keys, reason));
}

// ─── Quem é afetado por uma alteração ───────────────────────────────────────

/** Pessoas (utilizadores) com a conta Google ligada com Tarefas ou Calendário, a partir de funcionários. */
async function connectedUsersOfEmployees(employeeIds: readonly number[]): Promise<number[]> {
  const ids = employeeIds.filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) return [];
  const d = await db();
  const users = rowsOf(await d.execute(sql`SELECT DISTINCT userId FROM employees WHERE id IN (${inList(ids)}) AND userId IS NOT NULL`)).map((r) => Number(r.userId));
  return connectedUsers(users);
}

async function connectedUsers(userIds: readonly number[], feature?: "tasks" | "calendar"): Promise<number[]> {
  const ids = Array.from(new Set(userIds.filter((x) => Number.isInteger(x) && x > 0)));
  if (!ids.length) return [];
  const d = await db();
  return rowsOf(await d.execute(sql`SELECT userId, scopes FROM google_user_accounts WHERE userId IN (${inList(ids)}) AND status = 'connected'`))
    .filter((r) => {
      const s = String(r.scopes ?? "");
      return feature ? hasFeatureScopes(s, feature) : hasFeatureScopes(s, "tasks") || hasFeatureScopes(s, "calendar");
    })
    .map((r) => Number(r.userId));
}

/** Tarefas/Calendário de funcionários (formação, turnos, …) — já para o Google. */
export function scheduleGoogleEmployeesSync(employeeIds: readonly number[], reason = "employee"): void {
  deferGoogleWork((async () => {
    const users = await connectedUsersOfEmployees(employeeIds);
    await markAndDrain(users.map((u) => `user:${u}`), reason);
  })());
}

/** Calendário de utilizadores (ex.: SLA de uma reclamação atribuída). */
export function scheduleGoogleUsersSync(userIds: readonly number[], reason = "user"): void {
  deferGoogleWork((async () => {
    const users = await connectedUsers(userIds, "calendar");
    await markAndDrain(users.map((u) => `user:${u}`), reason);
  })());
}

/**
 * Escala (turno criado/alterado/apagado, escala confirmada): calendário
 * partilhado da cidade + calendário de quem está escalado nesse dia/cidade
 * (+ `employeeIds`, ex.: quem saiu da escala) + TL/supervisores se os
 * eventos da cidade estão ligados.
 */
export function scheduleGoogleShiftSync(input: { city: string | null | undefined; date?: string | null; employeeIds?: readonly number[] }): void {
  deferGoogleWork((async () => {
    const keys: string[] = [];
    const city = String(input.city ?? "");
    const { loadSharedCalendarsConfig } = await import("./syncService");
    const cfg = await loadSharedCalendarsConfig();
    if ((SHARED_CALENDAR_CITIES as readonly string[]).includes(city) && cfg.enabled && cfg.cities[city as keyof typeof cfg.cities]) keys.push(`shared:${city}`);
    const emp = new Set<number>((input.employeeIds ?? []).filter((x) => Number.isInteger(x) && x > 0));
    const d = await db();
    if (city && input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      for (const r of rowsOf(await d.execute(sql`SELECT DISTINCT employeeId FROM extras_dia_assignments WHERE assignmentDate = ${input.date} AND city = ${city} AND employeeId IS NOT NULL LIMIT 500`))) emp.add(Number(r.employeeId));
    }
    const users = new Set(await connectedUsersOfEmployees(Array.from(emp)));
    if (cfg.leadCityDayEvents || cfg.handoverEvents) {
      const leads = rowsOf(await d.execute(sql`SELECT id FROM users WHERE role IN ('team_leader', 'supervisor') AND COALESCE(isActive, 1) = 1 LIMIT 300`)).map((r) => Number(r.id));
      for (const u of await connectedUsers(leads, "calendar")) users.add(u);
    }
    for (const u of users) keys.push(`user:${u}`);
    await markAndDrain(keys, "shift");
  })());
}

/** Prova nova numa reclamação → espelho no Shared Drive já (se ligado). */
export function scheduleGoogleDriveMirror(): void {
  deferGoogleWork((async () => {
    const { loadDriveConfig } = await import("./driveService");
    const cfg = await loadDriveConfig();
    if (cfg.sharedEnabled && cfg.mirrorComplaintEvidence) await markAndDrain(["drive:mirror"], "complaint_photo");
  })());
}

// ─── Heartbeat do dashboard ─────────────────────────────────────────────────

export interface HeartbeatResult { ran: boolean; reason: "started" | "not_connected" | "nothing_to_sync" | "throttled" }

/**
 * A pessoa tem o dashboard aberto: Tarefas e Contactos (sem notificações da
 * Google) sincronizam agora, no máximo 1× a cada ~5 min por pessoa (UPDATE
 * condicional — várias abas/pedidos ao mesmo tempo: só um ganha).
 */
export async function onlineHeartbeat(userId: number, o: { now?: number; defer?: (p: Promise<unknown>) => void } = {}): Promise<HeartbeatResult> {
  const now = o.now ?? Date.now();
  const d = await db();
  const acc = rowsOf(await d.execute(sql`SELECT scopes FROM google_user_accounts WHERE userId = ${userId} AND status = 'connected' AND refreshTokenEnc IS NOT NULL LIMIT 1`))[0];
  if (!acc) return { ran: false, reason: "not_connected" };
  const scopes = String(acc.scopes ?? "");
  if (!hasFeatureScopes(scopes, "tasks") && !hasFeatureScopes(scopes, "contacts")) return { ran: false, reason: "nothing_to_sync" };
  await ensureStateRow(userId);
  const cutoff = toSqlUtc(now - HEARTBEAT_MIN_GAP_MS);
  const claim = await d.execute(sql`UPDATE google_sync_state SET lastOnlineSyncAt = ${toSqlUtc(now)}
    WHERE userId = ${userId} AND (lastOnlineSyncAt IS NULL OR lastOnlineSyncAt <= ${cutoff})`);
  if (affected(claim) !== 1) return { ran: false, reason: "throttled" };
  const work = (async () => {
    const { runGoogleSync } = await import("./syncService");
    await runGoogleSync({ deadlineAt: Date.now() + 25_000, onlyUserIds: [userId], includeShared: false, parts: { tasks: true, calendar: false, contacts: true } });
  })();
  (o.defer ?? deferGoogleWork)(work);
  return { ran: true, reason: "started" };
}
