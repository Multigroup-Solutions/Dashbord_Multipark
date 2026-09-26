/**
 * Google Tarefas & Calendário — corrida (cron /api/cron/google-sync de 10 em
 * 10 min, prazo 45 s, resumível) e o que a app usa:
 *
 *  - por pessoa com a conta Google ligada: Tarefas (se ligou "Tarefas" no
 *    Perfil e autorizou o âmbito) e Calendário "Multipark" (turnos, escala da
 *    cidade + passagens de turno para TL/supervisor, formação, prazos de
 *    tarefas e SLAs, conforme as preferências). Quem mudou alguma coisa há
 *    pouco ("sujo") vai primeiro; depois quem está há mais tempo sem correr;
 *  - calendários partilhados "Escala Multipark — <cidade>" pela conta de
 *    serviço (delegação), para quem não ligou a conta;
 *  - "ok" honesto (shared/googleSync.ts → googleSyncCronOk): contas por
 *    religar ou sem âmbito são avisos (a própria pessoa é avisada pelo
 *    alerts.ts → google_account_reauth); falhas reais pintam o cron de vermelho;
 *  - sincronizar já depois de uma alteração nas Tarefas (best-effort);
 *  - disponibilidade (livre/ocupado) e reuniões com Meet;
 *  - Contactos (People API): grupo "Multipark — Serviço" / parceiros e
 *    leitura para sugestões por pessoa (contactsService.ts) e o diretório da
 *    empresa 1×/dia (conta de serviço com delegação);
 *  - Drive (driveJobs.ts): espelho no Shared Drive e relatórios ao vivo.
 */
import { sql } from "drizzle-orm";
import {
  DWD_CALENDAR_SCOPES, GOOGLE_CALENDAR_DESCRIPTION, GOOGLE_CALENDAR_TITLE, SHARED_CALENDAR_CITIES, anyCalendarPref, busyByDay, calendarWindow,
  cityDayEvent, filterLeadEvents, googleSyncCronOk, handoverEvent, meetLinkOf, meetingEventBody, parseSharedCalendarsConfig, sharedCalendarTitle, sharedShiftEvent,
  shiftEvent, slaEvent, taskDueEvent, taskSyncPermissions, toSqlUtc, trainingEvent,
  type DesiredEvent, type GoogleSyncPrefs, type GoogleSyncUserOutcome, type SharedCalendarCity, type ShiftRow,
} from "../../shared/googleSync";
import { hasFeatureScopes } from "../../shared/mail";
import { addDays, daysInRange, lisbonMidnightUtcMs } from "../../shared/lisbonDay";
import { handoverCityKey } from "../../shared/shiftHandover";
import { appOrigin, calendarAndTasksErrorKind, delegatedClient, dwdConfigured, googleErrorMessage, isAuthRevokedError, oauthConfigured } from "./workspace";
import { calendarFor, tasksFor, wrapCalendar, wrapTasks } from "./apis";
import { syncUserTasks, type TaskSyncResult } from "./tasksSync";
import { syncCalendarTarget, type CalendarSyncResult } from "./calendarSync";
import {
  claimUserLock, db, dbCalendarStore, dbTaskSyncStore, getSyncState, inList, nowSql, patchSyncState, releaseUserLock, rowsOf,
} from "./syncStore";

export interface GoogleSyncUserReport extends GoogleSyncUserOutcome {
  tasks?: Pick<TaskSyncResult, "pulled" | "pushed" | "created" | "createdRemote" | "unassigned" | "deletedRemote" | "rejected" | "conflicts" | "partial">;
  calendar?: Pick<CalendarSyncResult, "inserted" | "updated" | "deleted" | "adopted" | "partial">;
  contacts?: { pulled: number; created: number; deleted: number; forgotten: number; adopted: number; partial: boolean };
}

export interface GoogleSyncReport {
  ok: boolean;
  configured: boolean;
  done: boolean;
  users: GoogleSyncUserReport[];
  shared: Array<{ city: string; status: string; error?: string; inserted?: number; updated?: number; deleted?: number }>;
  directory?: { ran: boolean; done: boolean; count: number | null; error: string | null };
  drive?: { done: boolean; mirrored: number; mirrorFailed: number; live: { ran: boolean; reports: string[]; partial: boolean; error: string | null } | null };
  errors: string[];
  warnings: string[];
}

// ─── Eventos desejados ──────────────────────────────────────────────────────

const toShift = (r: any): ShiftRow => ({
  id: Number(r.id), assignmentDate: String(r.assignmentDate), city: String(r.city), startHour: Number(r.startHour), endHour: Number(r.endHour),
  sentHomeHour: r.sentHomeHour == null ? null : Number(r.sentHomeHour), isTeamLeader: Number(r.isTeamLeader), version: Number(r.version ?? 1),
  personName: r.personName ?? null, shift: r.shift ?? null,
});

async function confirmedShifts(where: { employeeId?: number; cities?: string[] }, fromDay: string, toDay: string): Promise<ShiftRow[]> {
  const d = await db();
  const cond = where.employeeId != null ? sql`employeeId = ${where.employeeId}` : sql`city IN (${inList(where.cities ?? [])})`;
  if (where.employeeId == null && !(where.cities ?? []).length) return [];
  return rowsOf(await d.execute(sql`SELECT id, assignmentDate, city, personName, startHour, endHour, sentHomeHour, isTeamLeader, version, shift
    FROM extras_dia_assignments WHERE ${cond} AND status = 'confirmed' AND assignmentDate >= ${fromDay} AND assignmentDate <= ${toDay}
    ORDER BY assignmentDate, startHour LIMIT 3000`)).map(toShift);
}

/** Cidades da escala de um TL/supervisor (a sua cidade de base; nacionais não). */
async function leadCities(userId: number, role: string): Promise<string[]> {
  if (!["team_leader", "supervisor"].includes(role)) return [];
  try {
    const { loadCityAccessParts } = await import("../cityAccess");
    const { base } = await loadCityAccessParts(userId, role);
    if (base.all) return [];
    const names = base.cityNames?.length ? base.cityNames : base.cityName ? [base.cityName] : [];
    return Array.from(new Set(names.map((n) => handoverCityKey(n)).filter((x): x is NonNullable<typeof x> => !!x)));
  } catch { return []; }
}

export async function desiredEventsForUser(u: { userId: number; role: string; employeeId: number | null; prefs: GoogleSyncPrefs }, nowMs: number, appUrl = appOrigin()): Promise<DesiredEvent[]> {
  const { fromDay, toDay } = calendarWindow(nowMs);
  const out: DesiredEvent[] = [];
  const d = await db();
  const fromSql = toSqlUtc(lisbonMidnightUtcMs(fromDay));
  const toSql = toSqlUtc(lisbonMidnightUtcMs(addDays(toDay, 1)));
  if (u.prefs.calShifts) {
    if (u.employeeId != null) {
      for (const r of await confirmedShifts({ employeeId: u.employeeId }, fromDay, toDay)) {
        out.push(shiftEvent(r, appUrl));
        if (Number(r.isTeamLeader)) out.push(handoverEvent(r.assignmentDate, r.city, appUrl));
      }
    }
    const cities = await leadCities(u.userId, u.role);
    if (cities.length) {
      const rows = await confirmedShifts({ cities }, fromDay, toDay);
      const days = new Map<string, Set<string>>();
      for (const r of rows) { if (!days.has(r.city)) days.set(r.city, new Set()); days.get(r.city)!.add(r.assignmentDate); }
      for (const [city, set] of days) {
        for (const date of set) {
          const e = cityDayEvent(date, city, rows, appUrl);
          if (e) out.push(e);
          if (u.role === "team_leader") out.push(handoverEvent(date, city, appUrl));
        }
      }
    }
  }
  if (u.prefs.calTraining && u.employeeId != null) {
    const rows = rowsOf(await d.execute(sql`SELECT ta.id, ta.dueAt, p.name AS pathName FROM training_assignments ta
      JOIN training_paths p ON p.id = ta.pathId
      WHERE ta.employeeId = ${u.employeeId} AND ta.dueAt IS NOT NULL AND ta.status <> 'completed' AND ta.dueAt >= ${fromSql} AND ta.dueAt < ${toSql}
      LIMIT 200`).catch(() => [[]]));
    for (const r of rows) { const e = trainingEvent({ id: Number(r.id), dueAt: String(r.dueAt), pathName: String(r.pathName ?? "Formação") }, appUrl); if (e) out.push(e); }
  }
  if (u.prefs.calTaskDue && u.employeeId != null) {
    const rows = rowsOf(await d.execute(sql`SELECT t.id, t.title, t.dueDate, t.dueHasTime FROM tasks t
      WHERE (t.assigneeId = ${u.employeeId} OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.taskId = t.id AND ta.employeeId = ${u.employeeId}))
        AND t.taskStatus <> 'done' AND t.dueDate IS NOT NULL AND t.dueDate >= ${toSqlUtc(lisbonMidnightUtcMs(fromDay) - 86_400_000)} AND t.dueDate < ${toSql}
      LIMIT 500`));
    for (const r of rows) { const e = taskDueEvent({ id: Number(r.id), title: String(r.title), dueDate: String(r.dueDate), dueHasTime: Number(r.dueHasTime ?? 0) }, appUrl); if (e) out.push(e); }
  }
  if (u.prefs.calSla) {
    const rows = rowsOf(await d.execute(sql`SELECT id, title, slaDeadline FROM complaints
      WHERE assignedToId = ${u.userId} AND slaDeadline IS NOT NULL AND slaDeadline >= ${fromSql} AND slaDeadline < ${toSql}
        AND complaint_status NOT IN ('resolved', 'closed', 'converted') LIMIT 300`));
    for (const r of rows) { const e = slaEvent({ id: Number(r.id), title: String(r.title), slaDeadline: String(r.slaDeadline) }, appUrl); if (e) out.push(e); }
  }
  const seen = new Set<string>();
  const lead = await loadSharedCalendarsConfig();
  return filterLeadEvents(out, lead).filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)));
}

export async function desiredEventsForSharedCity(city: SharedCalendarCity, nowMs: number, appUrl = appOrigin()): Promise<DesiredEvent[]> {
  const { fromDay, toDay } = calendarWindow(nowMs);
  const rows = await confirmedShifts({ cities: [city] }, fromDay, toDay);
  const out: DesiredEvent[] = rows.map((r) => sharedShiftEvent(r, appUrl));
  for (const date of Array.from(new Set(rows.map((r) => r.assignmentDate)))) out.push(handoverEvent(date, city, appUrl));
  return filterLeadEvents(out, await loadSharedCalendarsConfig());
}

// ─── Uma pessoa ─────────────────────────────────────────────────────────────

interface Candidate { userId: number; role: string; scopes: string; status: string; isActive: boolean }

async function employeeIdOf(userId: number): Promise<number | null> {
  const { getEmployeeByUserId } = await import("../db");
  const me = await getEmployeeByUserId(userId).catch(() => undefined);
  return me?.employee?.id ?? null;
}

async function permsFor(c: Candidate, employeeId: number | null) {
  const { getUserModuleOverrides } = await import("../db");
  const { loadCityAccess } = await import("../cityAccess");
  const overrides = await getUserModuleOverrides(c.userId).catch(() => ({}));
  const access = await loadCityAccess(c.userId, c.role).catch(() => null);
  const inScope = (projectId: number | null) => projectId == null || (!!access && (access.all || access.projectIds.includes(projectId)));
  return taskSyncPermissions({ id: c.userId, role: c.role, accessOverrides: overrides as any, employeeId }, inScope);
}

export async function syncOneUser(c: Candidate, opts: { deadlineAt: number; tasksOnly?: boolean; now?: () => number }): Promise<GoogleSyncUserReport> {
  const out: GoogleSyncUserReport = { userId: c.userId, status: "ok" };
  if (!c.isActive) return { ...out, status: "skipped", error: "utilizador inativo" };
  if (c.status === "reauth_required") return { ...out, status: "reauth_required" };
  const state = await getSyncState(c.userId);
  const prefs = state.prefs;
  const wantTasks = prefs.tasks;
  const wantCal = !opts.tasksOnly && (anyCalendarPref(prefs) || !!state.calendarId);
  const hasTasks = hasFeatureScopes(c.scopes, "tasks");
  const hasCal = hasFeatureScopes(c.scopes, "calendar");
  const hasContacts = hasFeatureScopes(c.scopes, "contacts");
  const missing: string[] = [];
  // Tarefas/Calendário só avisam em falta a quem não autorizou nada disso (quem só quer Contactos não é incomodado).
  const onlyContacts = hasContacts && !hasTasks && !hasCal;
  if (wantTasks && !hasTasks && !onlyContacts) missing.push("Tarefas");
  if (!opts.tasksOnly && anyCalendarPref(prefs) && !hasCal && !onlyContacts) missing.push("Calendário");
  const runTasks = wantTasks && hasTasks;
  const runCal = wantCal && hasCal;
  let runContacts = false;
  if (!opts.tasksOnly && hasContacts) {
    const { wantsContacts } = await import("./contactsService");
    runContacts = await wantsContacts(c.userId, c.role);
  }
  if (!runTasks && !runCal && !runContacts) {
    const warning = missing.length ? `Falta autorizar: ${missing.join(" e ")} (Perfil → Google → Ativar).` : null;
    if (warning) await patchSyncState(c.userId, { lastWarning: warning, lastStatus: "scope_missing" }).catch(() => {});
    return { ...out, status: missing.length ? "scope_missing" : "skipped", error: warning ?? undefined };
  }
  if (!(await claimUserLock(c.userId))) return { ...out, status: "partial", error: "a sincronizar noutra corrida" };
  const warnings: string[] = [];
  if (missing.length) warnings.push(`Falta autorizar: ${missing.join(" e ")} (Perfil → Google → Ativar).`);
  let partial = false;
  try {
    const { userGoogleAuth } = await import("./userAccounts");
    const employeeId = await employeeIdOf(c.userId);
    if (runTasks) {
      if (employeeId == null) warnings.push("Sem ficha de funcionário ligada — as tarefas não sincronizam.");
      else {
        const { client } = await userGoogleAuth(c.userId, "tasks");
        const api = wrapTasks(tasksFor(client), { deadlineAt: opts.deadlineAt });
        const r = await syncUserTasks(api, dbTaskSyncStore, {
          userId: c.userId, employeeId, perms: await permsFor(c, employeeId), appUrl: appOrigin(), deadlineAt: opts.deadlineAt - 1_500, now: opts.now,
        });
        out.tasks = { pulled: r.pulled, pushed: r.pushed, created: r.created, createdRemote: r.createdRemote, unassigned: r.unassigned, deletedRemote: r.deletedRemote, rejected: r.rejected, conflicts: r.conflicts, partial: r.partial };
        if (r.rateLimited) out.status = "rate_limited";
        if (r.partial) partial = true;
        if (r.rejected) warnings.push(`${r.rejected} tarefa(s) criada(s) no Google não entraram no dashboard (sem permissão para criar tarefas).`);
        if (!r.partial) await patchSyncState(c.userId, { lastTasksSyncAt: nowSql() });
      }
    }
    if (runCal && Date.now() < opts.deadlineAt - 3_000) {
      const { client } = await userGoogleAuth(c.userId, "calendar");
      const api = wrapCalendar(calendarFor(client), { deadlineAt: opts.deadlineAt });
      const nowMs = (opts.now ?? Date.now)();
      const desired = await desiredEventsForUser({ userId: c.userId, role: c.role, employeeId, prefs }, nowMs);
      const r = await syncCalendarTarget(api, dbCalendarStore, `user:${c.userId}`, desired, {
        title: GOOGLE_CALENDAR_TITLE, description: GOOGLE_CALENDAR_DESCRIPTION, deadlineAt: opts.deadlineAt - 1_500, windowFromMs: calendarWindow(nowMs).fromMs, now: opts.now,
      });
      out.calendar = { inserted: r.inserted, updated: r.updated, deleted: r.deleted, adopted: r.adopted, partial: r.partial };
      if (r.rateLimited) out.status = "rate_limited";
      if (r.partial) partial = true;
      if (!r.partial) await patchSyncState(c.userId, { lastCalendarSyncAt: nowSql() });
    } else if (runCal) partial = true;
    if (runContacts && Date.now() < opts.deadlineAt - 4_000) {
      const { runUserContacts } = await import("./contactsService");
      const { patchContactsState } = await import("./contactsStore");
      try {
        const r = await runUserContacts({ userId: c.userId, role: c.role }, employeeId, { deadlineAt: opts.deadlineAt, now: opts.now });
        out.contacts = { pulled: r.pulled, created: r.created, deleted: r.deleted, forgotten: r.forgotten, adopted: r.adopted, partial: r.partial };
        if (r.rateLimited) out.status = "rate_limited";
        if (r.partial) partial = true;
        warnings.push(...r.warnings);
        await patchContactsState(c.userId, { lastRunAt: nowSql(), lastStatus: r.rateLimited ? "rate_limited" : r.partial ? "partial" : "ok", lastError: null, lastWarning: r.warnings.join(" ").slice(0, 500) || null });
      } catch (err) {
        const kind = calendarAndTasksErrorKind(err);
        await patchContactsState(c.userId, { lastRunAt: nowSql(), lastStatus: kind, lastError: googleErrorMessage(err) }).catch(() => {});
        throw err;
      }
    } else if (runContacts) partial = true;
    if (partial && out.status === "ok") out.status = "partial";
    await patchSyncState(c.userId, {
      lastRunAt: nowSql(), lastStatus: out.status, lastError: null, lastWarning: warnings.join(" ").slice(0, 500) || null,
      ...(partial ? {} : { dirtyAt: null }),
    });
    return out;
  } catch (err: any) {
    const msg = googleErrorMessage(err);
    const kind = calendarAndTasksErrorKind(err);
    out.status = kind;
    out.error = msg;
    await patchSyncState(c.userId, { lastRunAt: nowSql(), lastStatus: kind, lastError: msg, lastWarning: warnings.join(" ").slice(0, 500) || null }).catch(() => {});
    return out;
  } finally {
    await releaseUserLock(c.userId).catch(() => {});
  }
}

// ─── Calendários partilhados (delegação) ────────────────────────────────────

export async function loadSharedCalendarsConfig() {
  try {
    const { getSetting } = await import("../appSettings");
    return parseSharedCalendarsConfig(await getSetting("google.sharedCalendars"));
  } catch { return parseSharedCalendarsConfig(null); }
}

export async function syncSharedCalendars(opts: { deadlineAt: number; now?: () => number }): Promise<{ configured: boolean; cities: GoogleSyncReport["shared"]; errors: string[] }> {
  const cfg = await loadSharedCalendarsConfig();
  const out = { configured: cfg.enabled, cities: [] as GoogleSyncReport["shared"], errors: [] as string[] };
  if (!cfg.enabled) return out;
  if (!dwdConfigured()) { out.errors.push("Calendários partilhados: conta de serviço em falta (GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON)."); return out; }
  const d = await db();
  const client = delegatedClient(cfg.ownerEmail, DWD_CALENDAR_SCOPES);
  try { await client.authorize(); }
  catch (err) {
    out.errors.push(isAuthRevokedError(err)
      ? `Calendários partilhados: a conta de serviço não tem delegação para ${cfg.ownerEmail} (Admin Google → Segurança → Controlos de API → Delegação ao nível do domínio: autoriza ${DWD_CALENDAR_SCOPES.join(", ")}).`
      : `Calendários partilhados: ${googleErrorMessage(err)}`);
    return out;
  }
  const api = wrapCalendar(calendarFor(client), { deadlineAt: opts.deadlineAt });
  const domain = cfg.ownerEmail.split("@")[1] ?? "";
  for (const city of SHARED_CALENDAR_CITIES) {
    if (!cfg.cities[city]) continue;
    if (Date.now() > opts.deadlineAt - 3_000) { out.cities.push({ city, status: "partial" }); continue; }
    try {
      const prev = rowsOf(await d.execute(sql`SELECT ownerEmail FROM google_shared_calendars WHERE city = ${city} LIMIT 1`))[0];
      if (!prev) await d.execute(sql`INSERT INTO google_shared_calendars (city, ownerEmail) VALUES (${city}, ${cfg.ownerEmail})`);
      else if (String(prev.ownerEmail) !== cfg.ownerEmail) {
        // Nova conta dona → calendário novo (o antigo fica na conta anterior).
        await d.execute(sql`UPDATE google_shared_calendars SET ownerEmail = ${cfg.ownerEmail}, calendarId = NULL, syncToken = NULL, aclDomain = NULL WHERE city = ${city}`);
        await d.execute(sql`DELETE FROM google_calendar_events WHERE target = ${`shared:${city}`}`);
      }
      const nowMs = (opts.now ?? Date.now)();
      const desired = await desiredEventsForSharedCity(city, nowMs);
      const r = await syncCalendarTarget(api, dbCalendarStore, `shared:${city}`, desired, {
        title: sharedCalendarTitle(city), description: `Escala confirmada de ${city === "lisbon" ? "Lisboa" : city === "porto" ? "Porto" : "Faro"} (gerida pelo dashboard Multipark). Subscreve para veres os turnos.`,
        deadlineAt: opts.deadlineAt - 1_500, windowFromMs: calendarWindow(nowMs).fromMs, now: opts.now,
        onCreated: async (calendarId) => {
          if (cfg.shareWithDomain && domain) {
            await api.insertAcl(calendarId, { role: "reader", scope: { type: "domain", value: domain } });
            await d.execute(sql`UPDATE google_shared_calendars SET aclDomain = ${domain} WHERE city = ${city}`);
          }
        },
      });
      await d.execute(sql`UPDATE google_shared_calendars SET lastSyncAt = ${nowSql()}, lastError = NULL WHERE city = ${city}`);
      out.cities.push({ city, status: r.partial ? "partial" : "ok", inserted: r.inserted, updated: r.updated, deleted: r.deleted });
    } catch (err) {
      const msg = googleErrorMessage(err);
      await d.execute(sql`UPDATE google_shared_calendars SET lastError = ${msg.slice(0, 500)} WHERE city = ${city}`).catch(() => {});
      out.cities.push({ city, status: "error", error: msg });
      out.errors.push(`Calendário partilhado ${city}: ${msg}`);
    }
  }
  return out;
}

// ─── Corrida ────────────────────────────────────────────────────────────────

async function candidates(onlyUserIds?: readonly number[] | null): Promise<Candidate[]> {
  const d = await db();
  const only = onlyUserIds?.length ? sql`AND g.userId IN (${inList(onlyUserIds)})` : sql``;
  const rows = rowsOf(await d.execute(sql`SELECT g.userId, g.scopes, g.status, u.role, u.isActive
    FROM google_user_accounts g
    JOIN users u ON u.id = g.userId
    LEFT JOIN google_sync_state s ON s.userId = g.userId
    WHERE g.status <> 'disconnected' AND g.refreshTokenEnc IS NOT NULL ${only}
    ORDER BY (s.dirtyAt IS NULL), (s.lastRunAt IS NOT NULL), s.lastRunAt
    LIMIT 500`));
  return rows
    .map((r) => ({ userId: Number(r.userId), scopes: String(r.scopes ?? ""), status: String(r.status), role: String(r.role ?? "user"), isActive: Number(r.isActive ?? 1) === 1 }))
    .filter((c) => hasFeatureScopes(c.scopes, "tasks") || hasFeatureScopes(c.scopes, "calendar") || hasFeatureScopes(c.scopes, "contacts") || !!onlyUserIds?.length);
}

export async function runGoogleSync(opts: { deadlineAt: number; onlyUserIds?: readonly number[] | null; tasksOnly?: boolean; includeShared?: boolean; now?: () => number }): Promise<GoogleSyncReport> {
  const report: GoogleSyncReport = { ok: true, configured: false, done: true, users: [], shared: [], errors: [], warnings: [] };
  let fatal: string | null = null;
  const sharedErrors: string[] = [];
  try {
    report.configured = oauthConfigured() || (await loadSharedCalendarsConfig()).enabled
      || (await (await import("./contactsService")).loadContactsConfig()).directory.enabled
      || (await (await import("./driveService")).loadDriveConfig()).sharedEnabled;
    if (!report.configured) return report;
    const list = await candidates(opts.onlyUserIds);
    for (const c of list) {
      if (Date.now() > opts.deadlineAt - 4_000) { report.done = false; break; }
      const r = await syncOneUser(c, { deadlineAt: opts.deadlineAt, tasksOnly: opts.tasksOnly, now: opts.now });
      report.users.push(r);
      if (r.status === "partial" || r.status === "rate_limited") report.done = false;
      if (r.status === "error") report.errors.push(`utilizador ${c.userId}: ${r.error ?? "erro"}`);
      else if (["reauth_required", "scope_missing", "rate_limited"].includes(r.status) && r.error) report.warnings.push(`utilizador ${c.userId}: ${r.error}`);
      else if (r.status === "reauth_required") report.warnings.push(`utilizador ${c.userId}: conta Google por religar`);
    }
    if (opts.includeShared !== false && !opts.onlyUserIds?.length) {
      if (Date.now() < opts.deadlineAt - 6_000) {
        const s = await syncSharedCalendars({ deadlineAt: opts.deadlineAt, now: opts.now });
        report.shared = s.cities;
        sharedErrors.push(...s.errors);
        if (s.cities.some((x) => x.status === "partial")) report.done = false;
      } else if ((await loadSharedCalendarsConfig()).enabled) report.done = false;
      // Diretório da empresa (1×/dia, resumível) — só com tempo de sobra.
      if (Date.now() < opts.deadlineAt - 10_000) {
        const { runDirectorySync } = await import("./contactsService");
        const dir = await runDirectorySync({ deadlineAt: opts.deadlineAt - 2_000, now: opts.now });
        if (dir.configured) {
          report.directory = { ran: dir.ran, done: dir.done, count: dir.count, error: dir.error };
          if (!dir.done) report.done = false;
          if (dir.error) sharedErrors.push(dir.error);
        }
      }
      // Drive: espelho no Shared Drive e relatórios ao vivo (lotes, retomável).
      if (Date.now() < opts.deadlineAt - 12_000) {
        const { runDriveJobs } = await import("./driveJobs");
        const dj = await runDriveJobs({ deadlineAt: opts.deadlineAt - 2_000, now: opts.now });
        if (dj.configured) {
          report.drive = { done: dj.done, mirrored: dj.mirrored, mirrorFailed: dj.mirrorFailed, live: dj.live };
          if (!dj.done) report.done = false;
          sharedErrors.push(...dj.errors);
        }
      }
    }
  } catch (err: any) {
    fatal = String(err?.message ?? err).slice(0, 300);
  }
  report.errors.push(...sharedErrors);
  if (fatal) report.errors.push(fatal);
  report.ok = googleSyncCronOk({ users: report.users, sharedErrors, fatal });
  return report;
}

// ─── Sincronizar já (depois de uma alteração nas Tarefas) ───────────────────

/**
 * Marca como "sujas" as pessoas afetadas por uma alteração (responsáveis e
 * quem tinha a tarefa ligada) e tenta sincronizá-las já (≤ 20 s, sem
 * atrasar a resposta; no Vercel o waitUntil mantém a função viva). Nunca
 * lança — o cron de 10 min apanha o que falhar.
 */
export function scheduleGoogleTaskSync(input: { taskIds?: readonly number[]; employeeIds?: readonly number[] }): void {
  const work = (async () => {
    const d = await db();
    const users = new Set<number>();
    const taskIds = (input.taskIds ?? []).filter((x) => Number.isInteger(x) && x > 0);
    const empIds = (input.employeeIds ?? []).filter((x) => Number.isInteger(x) && x > 0);
    if (taskIds.length) {
      for (const r of rowsOf(await d.execute(sql`SELECT DISTINCT userId FROM google_task_links WHERE taskId IN (${inList(taskIds)})`))) users.add(Number(r.userId));
      for (const r of rowsOf(await d.execute(sql`SELECT DISTINCT e.userId FROM task_assignees ta JOIN employees e ON e.id = ta.employeeId
        WHERE ta.taskId IN (${inList(taskIds)}) AND e.userId IS NOT NULL`))) users.add(Number(r.userId));
      for (const r of rowsOf(await d.execute(sql`SELECT DISTINCT e.userId FROM tasks t JOIN employees e ON e.id = t.assigneeId
        WHERE t.id IN (${inList(taskIds)}) AND e.userId IS NOT NULL`))) users.add(Number(r.userId));
    }
    if (empIds.length) {
      for (const r of rowsOf(await d.execute(sql`SELECT DISTINCT userId FROM employees WHERE id IN (${inList(empIds)}) AND userId IS NOT NULL`))) users.add(Number(r.userId));
    }
    if (!users.size) return;
    const connected = rowsOf(await d.execute(sql`SELECT userId, scopes FROM google_user_accounts WHERE userId IN (${inList(Array.from(users))}) AND status = 'connected'`))
      .filter((r) => hasFeatureScopes(String(r.scopes ?? ""), "tasks")).map((r) => Number(r.userId));
    if (!connected.length) return;
    for (const u of connected) await patchSyncState(u, { dirtyAt: nowSql() });
    await runGoogleSync({ deadlineAt: Date.now() + 20_000, onlyUserIds: connected, tasksOnly: true, includeShared: false });
  })().catch((err) => console.warn("[google-sync] sincronização imediata falhou:", String(err?.message ?? err).slice(0, 160)));
  import("@vercel/functions").then((m) => m.waitUntil(work)).catch(() => { /* fora do Vercel a promessa continua sozinha */ });
}

// ─── Disponibilidade (livre/ocupado, só leitura) ────────────────────────────

export async function userBusyBlocks(userId: number, fromDay: string, toDay: string): Promise<{ enabled: boolean; reason: string | null; days: Record<string, Array<{ start: string; end: string }>> }> {
  const days = daysInRange(fromDay, toDay).slice(0, 31);
  const { getGoogleAccount, userGoogleAuth } = await import("./userAccounts");
  const acc = await getGoogleAccount(userId).catch(() => null);
  if (!acc || acc.status === "disconnected" || !acc.refreshTokenEnc) return { enabled: false, reason: "not_connected", days: {} };
  if (!hasFeatureScopes(acc.scopes, "calendar")) return { enabled: false, reason: "scope_missing", days: {} };
  try {
    const { client } = await userGoogleAuth(userId, "calendar");
    const api = wrapCalendar(calendarFor(client), { deadlineAt: Date.now() + 15_000 });
    const busy = await api.freeBusy(new Date(lisbonMidnightUtcMs(days[0])).toISOString(), new Date(lisbonMidnightUtcMs(addDays(days[days.length - 1], 1))).toISOString(), ["primary"]);
    return { enabled: true, reason: null, days: busyByDay(busy, days) };
  } catch (err) {
    return { enabled: false, reason: calendarAndTasksErrorKind(err) === "reauth_required" ? "reauth_required" : "error", days: {} };
  }
}

// ─── Reuniões com Meet ──────────────────────────────────────────────────────

export async function createMeetingEvent(userId: number, i: {
  title: string; startMs: number; durationMin: number; description: string; attendeeEmail: string | null; link: string;
  entityType: string; entityId: string;
}): Promise<{ eventId: string; meetLink: string | null; htmlLink: string | null }> {
  const { userGoogleAuth } = await import("./userAccounts");
  const { client } = await userGoogleAuth(userId, "calendar");
  const api = wrapCalendar(calendarFor(client), { deadlineAt: Date.now() + 25_000 });
  const crypto = await import("node:crypto");
  const requestId = crypto.randomUUID();
  const body = meetingEventBody({ title: i.title, startMs: i.startMs, durationMin: i.durationMin, description: i.description, attendeeEmail: i.attendeeEmail, requestId, link: i.link, entityKey: `${i.entityType}:${i.entityId}` });
  const e = await api.insertEvent("primary", body as any, { conferenceDataVersion: 1, sendUpdates: i.attendeeEmail ? "all" : "none" });
  const meetLink = meetLinkOf(e as any);
  const d = await db();
  await d.execute(sql`INSERT INTO google_meetings (userId, entityType, entityId, eventId, title, startAt, endAt, meetLink, htmlLink, invitedEmail)
    VALUES (${userId}, ${i.entityType}, ${i.entityId.slice(0, 320)}, ${String(e.id ?? "")}, ${i.title.slice(0, 255)}, ${toSqlUtc(i.startMs)},
      ${toSqlUtc(i.startMs + i.durationMin * 60_000)}, ${meetLink}, ${e.htmlLink ?? null}, ${i.attendeeEmail})`);
  return { eventId: String(e.id ?? ""), meetLink, htmlLink: e.htmlLink ?? null };
}

// ─── Resumo para o Perfil / Integrações ─────────────────────────────────────

export async function googleSyncSummary(userId: number) {
  const { googleAccountSummary } = await import("./userAccounts");
  const account = await googleAccountSummary(userId);
  let state = null as Awaited<ReturnType<typeof getSyncState>> | null;
  let linked = 0;
  let rejected = 0;
  try {
    state = await getSyncState(userId);
    const d = await db();
    const r = rowsOf(await d.execute(sql`SELECT SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS linked, SUM(CASE WHEN state = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM google_task_links WHERE userId = ${userId}`))[0];
    linked = Number(r?.linked ?? 0);
    rejected = Number(r?.rejected ?? 0);
  } catch { /* tabelas ainda por criar */ }
  const granted = (f: string) => account.features.find((x) => x.id === f)?.granted ?? false;
  return {
    account,
    prefs: state?.prefs ?? (await import("../../shared/googleSync")).DEFAULT_GOOGLE_SYNC_PREFS,
    tasksGranted: granted("tasks"),
    calendarGranted: granted("calendar"),
    lastRunAt: state?.lastRunAt ?? null,
    lastTasksSyncAt: state?.lastTasksSyncAt ?? null,
    lastCalendarSyncAt: state?.lastCalendarSyncAt ?? null,
    lastStatus: state?.lastStatus ?? null,
    lastError: state?.lastError ?? null,
    lastWarning: state?.lastWarning ?? null,
    hasCalendar: !!state?.calendarId,
    linkedTasks: linked,
    rejectedTasks: rejected,
  };
}

/** "Testar" no hub das Integrações: chamada real e só de leitura. */
export async function testGoogleSync(): Promise<string> {
  const cfg = await loadSharedCalendarsConfig();
  const parts: string[] = [];
  if (cfg.enabled) {
    const client = delegatedClient(cfg.ownerEmail, DWD_CALENDAR_SCOPES);
    await client.authorize();
    const api = wrapCalendar(calendarFor(client), { deadlineAt: Date.now() + 15_000 });
    const cals = await api.listCalendars();
    parts.push(`delegação OK para ${cfg.ownerEmail} (${cals.length} calendário(s))`);
  }
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT userId, scopes FROM google_user_accounts WHERE status = 'connected' LIMIT 500`));
  const withTasks = rows.filter((r) => hasFeatureScopes(String(r.scopes ?? ""), "tasks"));
  const withCal = rows.filter((r) => hasFeatureScopes(String(r.scopes ?? ""), "calendar"));
  const first = withTasks[0] ?? withCal[0];
  if (first) {
    const { userGoogleAuth } = await import("./userAccounts");
    if (hasFeatureScopes(String(first.scopes), "tasks")) {
      const { client } = await userGoogleAuth(Number(first.userId), "tasks");
      await wrapTasks(tasksFor(client), { deadlineAt: Date.now() + 15_000 }).listTaskLists();
      parts.push("API Google Tasks OK");
    } else {
      const { client } = await userGoogleAuth(Number(first.userId), "calendar");
      await wrapCalendar(calendarFor(client), { deadlineAt: Date.now() + 15_000 }).listCalendars();
      parts.push("API Google Calendar OK");
    }
  }
  if (!parts.length) throw new Error("Ninguém ligou ainda as Tarefas/Calendário (Perfil → Google) e os calendários partilhados estão desligados.");
  return `Ligação OK (${parts.join("; ")}; ${withTasks.length} pessoa(s) com Tarefas, ${withCal.length} com Calendário).`;
}

export { nowSql };
