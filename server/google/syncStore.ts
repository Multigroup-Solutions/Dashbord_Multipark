/**
 * BD da sincronização Google Tarefas & Calendário (migração 0150). SQL
 * sempre parametrizado; sem GROUP BY (ONLY_FULL_GROUP_BY seguro).
 */
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../db";
import {
  GOOGLE_TASK_SOURCE, TASK_SYNC_DONE_MAX_AGE_DAYS, parseGoogleSyncPrefs, toSqlUtc,
  type CalendarMapping, type GoogleSyncPrefs, type LocalTaskLike,
} from "../../shared/googleSync";
import { taskUpdateSideEffects } from "../../shared/taskRules";
import type { NewTaskInput, TaskLinkRow, TaskSyncStateRow, TaskSyncStore } from "./tasksSync";
import type { CalendarStore, CalendarTargetState } from "./calendarSync";

export const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const header = (res: unknown): any => (Array.isArray(res) ? res[0] : res);
export const affected = (res: unknown) => Number(header(res)?.affectedRows ?? 0);
export const nowSql = () => toSqlUtc(Date.now());
export const inList = (xs: readonly (number | string)[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);

export async function db() {
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível.");
  return d;
}

// ─── Estado por utilizador ──────────────────────────────────────────────────

export interface SyncStateRow {
  userId: number;
  prefs: GoogleSyncPrefs;
  tasksListId: string | null;
  tasksUpdatedMin: string | null;
  calendarId: string | null;
  calendarSyncToken: string | null;
  lastTasksSyncAt: string | null;
  lastCalendarSyncAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastWarning: string | null;
  dirtyAt: string | null;
}

const STATE_COLUMNS = ["prefsJson", "tasksListId", "tasksUpdatedMin", "calendarId", "calendarSyncToken", "lastTasksSyncAt", "lastCalendarSyncAt", "lastRunAt", "lastStatus", "lastError", "lastWarning", "lockAt", "dirtyAt"] as const;
type StateColumn = (typeof STATE_COLUMNS)[number];

export async function ensureStateRow(userId: number): Promise<void> {
  const d = await db();
  await d.execute(sql`INSERT IGNORE INTO google_sync_state (userId) VALUES (${userId})`);
}

export async function getSyncState(userId: number): Promise<SyncStateRow> {
  const d = await db();
  const r = rowsOf(await d.execute(sql`SELECT * FROM google_sync_state WHERE userId = ${userId} LIMIT 1`))[0] ?? {};
  const s = (k: string) => (r[k] == null ? null : String(r[k]));
  return {
    userId, prefs: parseGoogleSyncPrefs(r.prefsJson ?? null),
    tasksListId: s("tasksListId"), tasksUpdatedMin: s("tasksUpdatedMin"), calendarId: s("calendarId"), calendarSyncToken: s("calendarSyncToken"),
    lastTasksSyncAt: s("lastTasksSyncAt"), lastCalendarSyncAt: s("lastCalendarSyncAt"), lastRunAt: s("lastRunAt"), lastStatus: s("lastStatus"),
    lastError: s("lastError"), lastWarning: s("lastWarning"), dirtyAt: s("dirtyAt"),
  };
}

/** Atualiza só as colunas dadas (lista fechada de colunas; valores parametrizados). */
export async function patchSyncState(userId: number, patch: Partial<Record<StateColumn, string | null>>): Promise<void> {
  const sets: SQL[] = [];
  for (const k of STATE_COLUMNS) {
    if (!(k in patch)) continue;
    const v = patch[k] ?? null;
    sets.push(sql`${sql.identifier(k)} = ${v == null ? null : String(v).slice(0, k === "prefsJson" ? 4000 : 500)}`);
  }
  if (!sets.length) return;
  await ensureStateRow(userId);
  const d = await db();
  await d.execute(sql`UPDATE google_sync_state SET ${sql.join(sets, sql`, `)} WHERE userId = ${userId}`);
}

export async function claimUserLock(userId: number, staleSeconds = 90): Promise<boolean> {
  await ensureStateRow(userId);
  const d = await db();
  const cutoff = toSqlUtc(Date.now() - staleSeconds * 1000);
  const res = await d.execute(sql`UPDATE google_sync_state SET lockAt = ${nowSql()} WHERE userId = ${userId} AND (lockAt IS NULL OR lockAt < ${cutoff})`);
  return affected(res) === 1;
}

export async function releaseUserLock(userId: number): Promise<void> {
  const d = await db();
  await d.execute(sql`UPDATE google_sync_state SET lockAt = NULL WHERE userId = ${userId}`);
}

// ─── Tarefas ────────────────────────────────────────────────────────────────

const toLink = (r: any): TaskLinkRow => ({
  id: Number(r.id), userId: Number(r.userId), taskId: r.taskId == null ? null : Number(r.taskId), googleTaskId: String(r.googleTaskId),
  listId: String(r.listId), etag: r.etag ?? null, googleUpdatedAt: r.googleUpdatedAt ?? null, syncedHash: r.syncedHash ?? null,
  state: r.state === "rejected" ? "rejected" : "active",
});

async function loadTasksByIds(ids: readonly number[]): Promise<LocalTaskLike[]> {
  if (!ids.length) return [];
  const d = await db();
  const rows = rowsOf(await d.execute(sql`SELECT id, title, description, dueDate, dueHasTime, taskStatus, updatedAt, projectId, createdById, assigneeId
    FROM tasks WHERE id IN (${inList(ids)})`));
  const ass = rowsOf(await d.execute(sql`SELECT taskId, employeeId FROM task_assignees WHERE taskId IN (${inList(ids)})`));
  const byTask = new Map<number, number[]>();
  for (const a of ass) {
    const k = Number(a.taskId);
    if (!byTask.has(k)) byTask.set(k, []);
    byTask.get(k)!.push(Number(a.employeeId));
  }
  return rows.map((r) => ({
    id: Number(r.id), title: String(r.title ?? ""), description: r.description ?? null, dueDate: r.dueDate == null ? null : String(r.dueDate),
    dueHasTime: Number(r.dueHasTime ?? 0), taskStatus: String(r.taskStatus), updatedAt: r.updatedAt == null ? null : String(r.updatedAt),
    projectId: r.projectId == null ? null : Number(r.projectId), createdById: r.createdById == null ? null : Number(r.createdById),
    assigneeId: r.assigneeId == null ? null : Number(r.assigneeId), assigneeIds: byTask.get(Number(r.id)) ?? [],
  }));
}

export const dbTaskSyncStore: TaskSyncStore = {
  async getState(userId): Promise<TaskSyncStateRow> {
    const s = await getSyncState(userId);
    return { tasksListId: s.tasksListId, tasksUpdatedMin: s.tasksUpdatedMin };
  },
  async saveState(userId, patch) {
    await patchSyncState(userId, patch as any);
  },
  async loadLinks(userId) {
    const d = await db();
    return rowsOf(await d.execute(sql`SELECT * FROM google_task_links WHERE userId = ${userId} LIMIT 5000`)).map(toLink);
  },
  async saveLink(l) {
    const d = await db();
    if (l.id != null) {
      await d.execute(sql`UPDATE google_task_links SET taskId = ${l.taskId}, etag = ${l.etag}, googleUpdatedAt = ${l.googleUpdatedAt},
        syncedHash = ${l.syncedHash}, state = ${l.state}, listId = ${l.listId}, lastSyncedAt = ${nowSql()} WHERE id = ${l.id}`);
      return l;
    }
    // Uma ligação por (pessoa, tarefa) e por (pessoa, tarefa Google): limpa restos (ex.: lista antiga).
    await d.execute(sql`DELETE FROM google_task_links WHERE userId = ${l.userId}
      AND (googleTaskId = ${l.googleTaskId}${l.taskId != null ? sql` OR taskId = ${l.taskId}` : sql``})`);
    const res = await d.execute(sql`INSERT INTO google_task_links (userId, taskId, googleTaskId, listId, etag, googleUpdatedAt, syncedHash, state, lastSyncedAt)
      VALUES (${l.userId}, ${l.taskId}, ${l.googleTaskId}, ${l.listId}, ${l.etag}, ${l.googleUpdatedAt}, ${l.syncedHash}, ${l.state}, ${nowSql()})`);
    return { ...l, id: Number(header(res)?.insertId ?? 0) || null };
  },
  async deleteLink(l) {
    const d = await db();
    if (l.id != null) await d.execute(sql`DELETE FROM google_task_links WHERE id = ${l.id}`);
    else await d.execute(sql`DELETE FROM google_task_links WHERE userId = ${l.userId} AND googleTaskId = ${l.googleTaskId}`);
  },
  async loadAssignedTasks(employeeId, linkedTaskIds) {
    const d = await db();
    const cutoff = toSqlUtc(Date.now() - TASK_SYNC_DONE_MAX_AGE_DAYS * 86_400_000);
    const linked = linkedTaskIds.length ? sql` OR t.id IN (${inList(linkedTaskIds)})` : sql``;
    const ids = rowsOf(await d.execute(sql`SELECT t.id FROM tasks t
      WHERE (t.assigneeId = ${employeeId} OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.taskId = t.id AND ta.employeeId = ${employeeId}))
        AND (t.taskStatus <> 'done' OR COALESCE(t.completedAt, t.updatedAt) >= ${cutoff}${linked})
      ORDER BY t.id DESC LIMIT 1000`)).map((r) => Number(r.id));
    return loadTasksByIds(ids);
  },
  async applyPull(taskId, patch, actorUserId) {
    const d = await db();
    const [prev] = await loadTasksByIds([taskId]);
    if (!prev) return null;
    const data: Record<string, unknown> = {};
    if (patch.title !== undefined) data.title = patch.title.slice(0, 256);
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.dueDate !== undefined) data.dueDate = patch.dueDate;
    if (patch.taskStatus !== undefined) data.taskStatus = patch.taskStatus;
    Object.assign(data, taskUpdateSideEffects(prev as any, { taskStatus: patch.taskStatus, dueDate: patch.dueDate }, nowSql()));
    if (patch.taskStatus === "done" && prev.taskStatus !== "done") data.completedById = actorUserId;
    const cols = Object.keys(data).filter((k) => ["title", "description", "dueDate", "taskStatus", "completedAt", "notifiedComplete", "notifiedOverdue", "dueHasTime", "completedById"].includes(k));
    if (!cols.length) return prev;
    await d.execute(sql`UPDATE tasks SET ${sql.join(cols.map((k) => sql`${sql.identifier(k)} = ${data[k] as any}`), sql`, `)} WHERE id = ${taskId}`);
    const { logActivity } = await import("../db");
    await logActivity({ userId: actorUserId, action: "update", entity: "task", entityId: taskId, details: `Google Tasks: ${cols.join(", ")}` } as any).catch(() => {});
    return (await loadTasksByIds([taskId]))[0] ?? null;
  },
  async createTask(input: NewTaskInput) {
    const d = await db();
    const done = input.done;
    const res = await d.execute(sql`INSERT INTO tasks (title, description, projectId, assigneeId, createdById, taskStatus, taskPriority, dueDate, sourceModule, completedAt, completedById, notifiedComplete)
      VALUES (${input.title.slice(0, 256)}, ${input.description}, NULL, ${input.employeeId}, ${input.createdById}, ${done ? "done" : "todo"}, 'medium', ${input.dueDate},
        ${GOOGLE_TASK_SOURCE}, ${done ? nowSql() : null}, ${done ? input.createdById : null}, 0)`);
    const id = Number(header(res)?.insertId ?? 0);
    await d.execute(sql`INSERT INTO task_assignees (taskId, employeeId) VALUES (${id}, ${input.employeeId})`);
    return (await loadTasksByIds([id]))[0];
  },
  async unassign(taskId, employeeId, actorUserId, archive) {
    const d = await db();
    await d.execute(sql`DELETE FROM task_assignees WHERE taskId = ${taskId} AND employeeId = ${employeeId}`);
    const next = rowsOf(await d.execute(sql`SELECT employeeId FROM task_assignees WHERE taskId = ${taskId} ORDER BY id LIMIT 1`))[0];
    await d.execute(sql`UPDATE tasks SET assigneeId = ${next ? Number(next.employeeId) : null} WHERE id = ${taskId} AND assigneeId = ${employeeId}`);
    if (archive) {
      await d.execute(sql`UPDATE tasks SET taskStatus = 'done', completedAt = COALESCE(completedAt, ${nowSql()}), completedById = COALESCE(completedById, ${actorUserId}), notifiedComplete = 1
        WHERE id = ${taskId} AND taskStatus <> 'done'`);
    }
  },
  async log(userId, action, taskId, details) {
    try {
      const { logActivity } = await import("../db");
      await logActivity({ userId, action, entity: "task", entityId: taskId, details: details.slice(0, 500) } as any);
    } catch { /* registo nunca parte a sincronização */ }
  },
};

// ─── Calendário ─────────────────────────────────────────────────────────────

const sharedCity = (target: string) => (target.startsWith("shared:") ? target.slice(7) : null);
const userOf = (target: string) => { const m = /^user:(\d+)$/.exec(target); return m ? Number(m[1]) : null; };

export const dbCalendarStore: CalendarStore = {
  async getState(target): Promise<CalendarTargetState> {
    const d = await db();
    const city = sharedCity(target);
    if (city) {
      const r = rowsOf(await d.execute(sql`SELECT calendarId, syncToken FROM google_shared_calendars WHERE city = ${city} LIMIT 1`))[0];
      return { calendarId: r?.calendarId ?? null, syncToken: r?.syncToken ?? null };
    }
    const s = await getSyncState(userOf(target)!);
    return { calendarId: s.calendarId, syncToken: s.calendarSyncToken };
  },
  async saveState(target, patch) {
    const d = await db();
    const city = sharedCity(target);
    if (city) {
      if ("calendarId" in patch) await d.execute(sql`UPDATE google_shared_calendars SET calendarId = ${patch.calendarId ?? null} WHERE city = ${city}`);
      if ("syncToken" in patch) await d.execute(sql`UPDATE google_shared_calendars SET syncToken = ${patch.syncToken ?? null} WHERE city = ${city}`);
      return;
    }
    const p: Record<string, string | null> = {};
    if ("calendarId" in patch) p.calendarId = patch.calendarId ?? null;
    if ("syncToken" in patch) p.calendarSyncToken = patch.syncToken ?? null;
    await patchSyncState(userOf(target)!, p as any);
  },
  async loadMappings(target) {
    const d = await db();
    return rowsOf(await d.execute(sql`SELECT sourceKey, eventId, version, hash, startMs, remoteDeleted FROM google_calendar_events WHERE target = ${target} LIMIT 20000`))
      .map((r): CalendarMapping => ({ key: String(r.sourceKey), eventId: String(r.eventId), version: r.version ?? null, hash: r.hash ?? null, startMs: r.startMs == null ? null : Number(r.startMs), remoteDeleted: Number(r.remoteDeleted) === 1 }));
  },
  async saveMapping(target, calendarId, m) {
    const d = await db();
    await d.execute(sql`INSERT INTO google_calendar_events (target, calendarId, sourceKey, eventId, version, hash, startMs, remoteDeleted)
      VALUES (${target}, ${calendarId}, ${m.key.slice(0, 120)}, ${m.eventId}, ${m.version}, ${m.hash}, ${m.startMs}, ${m.remoteDeleted ? 1 : 0})
      ON DUPLICATE KEY UPDATE calendarId = VALUES(calendarId), eventId = VALUES(eventId), version = VALUES(version), hash = VALUES(hash),
        startMs = VALUES(startMs), remoteDeleted = VALUES(remoteDeleted)`);
  },
  async deleteMapping(target, key) {
    const d = await db();
    await d.execute(sql`DELETE FROM google_calendar_events WHERE target = ${target} AND sourceKey = ${key.slice(0, 120)}`);
  },
};
