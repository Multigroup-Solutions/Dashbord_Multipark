/**
 * Adaptadores das APIs OFICIAIS Google Tasks (@googleapis/tasks v1) e Google
 * Calendar (@googleapis/calendar v3) para o que a sincronização usa, sempre
 * com prazo (timedFetch → fetchWithTimeout) e com repetição com espera
 * exponencial nos limites de pedidos (429 / 403 rateLimitExceeded /
 * userRateLimitExceeded) — só enquanto o prazo da corrida o permitir.
 *
 * Os motores (tasksSync.ts, calendarSync.ts) só conhecem as interfaces
 * `TasksApiLike` / `CalendarApiLike` — os testes usam implementações falsas.
 */
import type { JWT, OAuth2Client } from "google-auth-library";
import { tasks as tasksFactory, type tasks_v1 } from "@googleapis/tasks";
import { calendar as calendarFactory, type calendar_v3 } from "@googleapis/calendar";
import { GOOGLE_API_TIMEOUT_MS, httpStatusOf, timedFetch } from "./workspace";

// ─── Limites de pedidos ─────────────────────────────────────────────────────

/** 429 ou 403 com motivo de limite (a Google usa os dois)? PURA. */
export function isRateLimitError(err: unknown): boolean {
  const status = httpStatusOf(err);
  if (status === 429) return true;
  if (status !== 403) return false;
  const e = err as any;
  const reasons: string[] = [
    ...((e?.response?.data?.error?.errors ?? []) as any[]).map((x) => String(x?.reason ?? "")),
    ...((e?.errors ?? []) as any[]).map((x) => String(x?.reason ?? "")),
    String(e?.response?.data?.error?.status ?? ""),
    String(e?.message ?? ""),
  ];
  return reasons.some((r) => /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED|Rate Limit/i.test(r));
}

export class GoogleRateLimitError extends Error {
  rateLimited = true;
  constructor(message = "Limite de pedidos da Google atingido — continua na próxima corrida.") { super(message); }
}

export interface RetryOptions {
  deadlineAt: number;
  retries?: number;
  baseDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Corre `fn` e repete nos limites de pedidos com espera exponencial + jitter
 * (base, 2×, 4×…), sem passar do prazo. Esgotado → GoogleRateLimitError.
 */
export async function withGoogleRetry<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rnd = o.random ?? Math.random;
  const retries = o.retries ?? 3;
  const base = o.baseDelayMs ?? 500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
      const wait = base * 2 ** attempt + Math.floor(rnd() * base);
      if (attempt >= retries || now() + wait > o.deadlineAt - 1_000) throw new GoogleRateLimitError();
      await sleep(wait);
    }
  }
}

// ─── Google Tasks ───────────────────────────────────────────────────────────

export interface TasksApiLike {
  listTaskLists(): Promise<Array<{ id: string; title: string }>>;
  insertTaskList(title: string): Promise<{ id: string }>;
  listTasks(listId: string, p: { updatedMin?: string | null; pageToken?: string | null }): Promise<{ items: tasks_v1.Schema$Task[]; nextPageToken: string | null }>;
  insertTask(listId: string, body: tasks_v1.Schema$Task): Promise<tasks_v1.Schema$Task>;
  patchTask(listId: string, taskId: string, body: tasks_v1.Schema$Task): Promise<tasks_v1.Schema$Task>;
  deleteTask(listId: string, taskId: string): Promise<void>;
}

export function tasksFor(auth: OAuth2Client | JWT): tasks_v1.Tasks {
  return tasksFactory({ version: "v1", auth, timeout: GOOGLE_API_TIMEOUT_MS, fetchImplementation: timedFetch() } as any);
}

export function wrapTasks(t: tasks_v1.Tasks, retry: RetryOptions): TasksApiLike {
  const r = <T>(fn: () => Promise<T>) => withGoogleRetry(fn, retry);
  return {
    async listTaskLists() {
      const out: Array<{ id: string; title: string }> = [];
      let pageToken: string | undefined;
      for (let i = 0; i < 10; i++) {
        const res = await r(() => t.tasklists.list({ maxResults: 100, ...(pageToken ? { pageToken } : {}) }));
        for (const l of res.data.items ?? []) if (l.id) out.push({ id: l.id, title: String(l.title ?? "") });
        pageToken = res.data.nextPageToken ?? undefined;
        if (!pageToken) break;
      }
      return out;
    },
    async insertTaskList(title) {
      const res = await r(() => t.tasklists.insert({ requestBody: { title } }));
      return { id: String(res.data.id) };
    },
    async listTasks(listId, p) {
      const res = await r(() => t.tasks.list({
        tasklist: listId, maxResults: 100, showCompleted: true, showHidden: true, showDeleted: true,
        ...(p.updatedMin ? { updatedMin: p.updatedMin } : {}), ...(p.pageToken ? { pageToken: p.pageToken } : {}),
      }));
      return { items: res.data.items ?? [], nextPageToken: res.data.nextPageToken ?? null };
    },
    async insertTask(listId, body) {
      return (await r(() => t.tasks.insert({ tasklist: listId, requestBody: body }))).data;
    },
    async patchTask(listId, taskId, body) {
      return (await r(() => t.tasks.patch({ tasklist: listId, task: taskId, requestBody: body }))).data;
    },
    async deleteTask(listId, taskId) {
      try { await r(() => t.tasks.delete({ tasklist: listId, task: taskId })); }
      catch (err) { if (![404, 410].includes(httpStatusOf(err) ?? 0)) throw err; }
    },
  };
}

// ─── Google Calendar ────────────────────────────────────────────────────────

export interface CalendarApiLike {
  listCalendars(): Promise<Array<{ id: string; summary: string; accessRole: string | null; description: string | null }>>;
  insertCalendar(body: { summary: string; description: string; timeZone: string }): Promise<{ id: string }>;
  listEvents(calendarId: string, p: { syncToken?: string | null; pageToken?: string | null }): Promise<{ items: calendar_v3.Schema$Event[]; nextPageToken: string | null; nextSyncToken: string | null }>;
  insertEvent(calendarId: string, body: calendar_v3.Schema$Event, opts?: { conferenceDataVersion?: number; sendUpdates?: "all" | "none" }): Promise<calendar_v3.Schema$Event>;
  patchEvent(calendarId: string, eventId: string, body: calendar_v3.Schema$Event): Promise<calendar_v3.Schema$Event>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  freeBusy(timeMin: string, timeMax: string, calendarIds: string[]): Promise<Array<{ start?: string | null; end?: string | null }>>;
  insertAcl(calendarId: string, rule: calendar_v3.Schema$AclRule): Promise<void>;
}

export function calendarFor(auth: OAuth2Client | JWT): calendar_v3.Calendar {
  return calendarFactory({ version: "v3", auth, timeout: GOOGLE_API_TIMEOUT_MS, fetchImplementation: timedFetch() } as any);
}

export function wrapCalendar(c: calendar_v3.Calendar, retry: RetryOptions): CalendarApiLike {
  const r = <T>(fn: () => Promise<T>) => withGoogleRetry(fn, retry);
  return {
    async listCalendars() {
      const out: Array<{ id: string; summary: string; accessRole: string | null; description: string | null }> = [];
      let pageToken: string | undefined;
      for (let i = 0; i < 10; i++) {
        const res = await r(() => c.calendarList.list({ maxResults: 250, minAccessRole: "owner", ...(pageToken ? { pageToken } : {}) }));
        for (const x of res.data.items ?? []) if (x.id) out.push({ id: x.id, summary: String(x.summary ?? ""), accessRole: x.accessRole ?? null, description: x.description ?? null });
        pageToken = res.data.nextPageToken ?? undefined;
        if (!pageToken) break;
      }
      return out;
    },
    async insertCalendar(body) {
      const res = await r(() => c.calendars.insert({ requestBody: body }));
      return { id: String(res.data.id) };
    },
    async listEvents(calendarId, p) {
      const res = await r(() => c.events.list({
        calendarId, maxResults: 250, showDeleted: true, singleEvents: false,
        ...(p.syncToken ? { syncToken: p.syncToken } : {}), ...(p.pageToken ? { pageToken: p.pageToken } : {}),
      }));
      return { items: res.data.items ?? [], nextPageToken: res.data.nextPageToken ?? null, nextSyncToken: res.data.nextSyncToken ?? null };
    },
    async insertEvent(calendarId, body, opts) {
      return (await r(() => c.events.insert({
        calendarId, requestBody: body,
        ...(opts?.conferenceDataVersion != null ? { conferenceDataVersion: opts.conferenceDataVersion } : {}),
        sendUpdates: opts?.sendUpdates ?? "none",
      }))).data;
    },
    async patchEvent(calendarId, eventId, body) {
      return (await r(() => c.events.patch({ calendarId, eventId, requestBody: body, sendUpdates: "none" }))).data;
    },
    async deleteEvent(calendarId, eventId) {
      try { await r(() => c.events.delete({ calendarId, eventId, sendUpdates: "none" })); }
      catch (err) { if (![404, 410].includes(httpStatusOf(err) ?? 0)) throw err; }
    },
    async freeBusy(timeMin, timeMax, calendarIds) {
      const res = await r(() => c.freebusy.query({ requestBody: { timeMin, timeMax, timeZone: "Europe/Lisbon", items: calendarIds.map((id) => ({ id })) } }));
      const out: Array<{ start?: string | null; end?: string | null }> = [];
      for (const cal of Object.values(res.data.calendars ?? {})) out.push(...(cal.busy ?? []));
      return out;
    },
    async insertAcl(calendarId, rule) {
      try { await r(() => c.acl.insert({ calendarId, requestBody: rule, sendNotifications: false })); }
      catch (err) { if (httpStatusOf(err) !== 409) throw err; }
    },
  };
}
