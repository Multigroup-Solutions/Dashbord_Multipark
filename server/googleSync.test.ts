/**
 * Google Tarefas & Calendário — testes sem rede nem BD: as APIs Google
 * (Tasks, Calendar) e a BD são falsas (em memória).
 */
import { describe, expect, it, vi } from "vitest";
import type { tasks_v1 } from "@googleapis/tasks";
import type { calendar_v3 } from "@googleapis/calendar";
import {
  CALENDAR_WINDOW_FUTURE_DAYS, DEFAULT_GOOGLE_SYNC_PREFS, busyByDay, calendarEventId, calendarWindow, decideTaskSync, eventBody, eventHash,
  googleSyncCronOk, lisbonLocalToUtcMs, mappingFromEvent, meetLinkOf, meetingEventBody, normLocal, normRemote, notesFromGoogle,
  filterLeadEvents, parseGoogleSyncPrefs, planCalendarOps, pullPatch, sharedCalendarsConfigSchema, shiftEvent, stableHash, taskIdFromNotes, taskSyncPermissions,
  taskToGoogle, type CalendarMapping, type DesiredEvent, type LocalTaskLike, type ShiftRow,
} from "../shared/googleSync";
import { GOOGLE_FEATURE_SCOPES, hasFeatureScopes } from "../shared/mail";
import { syncUserTasks, type TaskLinkRow, type TaskSyncStore } from "./google/tasksSync";
import { syncCalendarTarget, type CalendarStore } from "./google/calendarSync";
import { GoogleRateLimitError, isRateLimitError, withGoogleRetry, wrapCalendar, type CalendarApiLike, type TasksApiLike } from "./google/apis";
import { calendarAndTasksErrorKind, scopesFor } from "./google/workspace";
import { requestedFeatures } from "./google/userAccounts";
import { MIGRATION_0150_STATEMENTS } from "./migrations/migration_0150";

const APP = "https://dashboard.multipark.pt";
const T0 = Date.parse("2026-09-25T10:00:00Z");
const sqlTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const httpErr = (status: number, data?: unknown) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

// ─── Google Tasks falso ─────────────────────────────────────────────────────

type GTask = tasks_v1.Schema$Task & { listId: string };

class FakeTasks implements TasksApiLike {
  lists: Array<{ id: string; title: string }> = [{ id: "L-pessoal", title: "As minhas tarefas" }];
  tasks = new Map<string, GTask>();
  clock = T0;
  n = 0;
  calls: string[] = [];
  private stamp() { this.clock += 1000; return new Date(this.clock).toISOString(); }
  async listTaskLists() { this.calls.push("lists.list"); return this.lists.map((l) => ({ ...l })); }
  async insertTaskList(title: string) { const id = `L${++this.n}`; this.lists.push({ id, title }); this.calls.push("lists.insert"); return { id }; }
  async listTasks(listId: string, p: { updatedMin?: string | null }) {
    this.calls.push("tasks.list");
    const items = Array.from(this.tasks.values()).filter((t) => t.listId === listId && (!p.updatedMin || Date.parse(String(t.updated)) >= Date.parse(p.updatedMin)))
      .map(({ listId: _l, ...t }) => ({ ...t }));
    return { items, nextPageToken: null };
  }
  async insertTask(listId: string, body: tasks_v1.Schema$Task) {
    const id = `g${++this.n}`;
    const t: GTask = { ...body, id, etag: `e${this.n}`, updated: this.stamp(), listId };
    this.tasks.set(id, t);
    this.calls.push(`tasks.insert:${id}`);
    return { ...t };
  }
  async patchTask(listId: string, id: string, body: tasks_v1.Schema$Task) {
    const cur = this.tasks.get(id);
    if (!cur || cur.deleted || cur.listId !== listId) throw httpErr(404);
    const t: GTask = { ...cur, ...body, etag: `e${++this.n}`, updated: this.stamp() };
    this.tasks.set(id, t);
    this.calls.push(`tasks.patch:${id}`);
    return { ...t };
  }
  async deleteTask(_listId: string, id: string) {
    const cur = this.tasks.get(id);
    if (cur) this.tasks.set(id, { ...cur, deleted: true, etag: `e${++this.n}`, updated: this.stamp() });
    this.calls.push(`tasks.delete:${id}`);
  }
  /** Alteração feita pela pessoa na app do Google Tasks. */
  userEdit(id: string, patch: Partial<tasks_v1.Schema$Task>, atMs?: number) {
    const cur = this.tasks.get(id)!;
    this.clock = Math.max(this.clock, atMs ?? this.clock) + 1000;
    this.tasks.set(id, { ...cur, ...patch, etag: `e${++this.n}`, updated: new Date(atMs ?? this.clock).toISOString() });
  }
  userCreate(listId: string, body: tasks_v1.Schema$Task) {
    const id = `u${++this.n}`;
    this.tasks.set(id, { status: "needsAction", ...body, id, etag: `e${this.n}`, updated: this.stamp(), listId });
    return id;
  }
}

class MemTaskStore implements TaskSyncStore {
  state = { tasksListId: null as string | null, tasksUpdatedMin: null as string | null };
  links: TaskLinkRow[] = [];
  tasks = new Map<number, LocalTaskLike>();
  logs: Array<{ action: string; taskId: number | null; details: string }> = [];
  nextLink = 1;
  nextTask = 500;
  now = T0;
  async getState() { return { ...this.state }; }
  async saveState(_u: number, p: Partial<typeof this.state>) { Object.assign(this.state, p); }
  async loadLinks(userId: number) { return this.links.filter((l) => l.userId === userId).map((l) => ({ ...l })); }
  async saveLink(l: TaskLinkRow) {
    if (l.id != null) { this.links = this.links.map((x) => (x.id === l.id ? { ...l } : x)); return l; }
    this.links = this.links.filter((x) => !(x.userId === l.userId && (x.googleTaskId === l.googleTaskId || (l.taskId != null && x.taskId === l.taskId))));
    const saved = { ...l, id: this.nextLink++ };
    this.links.push(saved);
    return { ...saved };
  }
  async deleteLink(l: TaskLinkRow) { this.links = this.links.filter((x) => x.id !== l.id); }
  async loadAssignedTasks(employeeId: number) {
    return Array.from(this.tasks.values()).filter((t) => t.assigneeId === employeeId || t.assigneeIds.includes(employeeId)).map((t) => ({ ...t, assigneeIds: [...t.assigneeIds] }));
  }
  async applyPull(taskId: number, patch: any) {
    const t = this.tasks.get(taskId)!;
    const n: LocalTaskLike = { ...t, ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate, dueHasTime: 0 } : {}), ...(patch.taskStatus !== undefined ? { taskStatus: patch.taskStatus } : {}), updatedAt: sqlTs(this.now += 1000) };
    this.tasks.set(taskId, n);
    return { ...n };
  }
  async createTask(i: { title: string; description: string | null; dueDate: string | null; done: boolean; createdById: number; employeeId: number }) {
    const t: LocalTaskLike = { id: this.nextTask++, title: i.title, description: i.description, dueDate: i.dueDate, dueHasTime: 0, taskStatus: i.done ? "done" : "todo",
      updatedAt: sqlTs(this.now += 1000), projectId: null, createdById: i.createdById, assigneeId: i.employeeId, assigneeIds: [i.employeeId] };
    this.tasks.set(t.id, t);
    return { ...t };
  }
  async unassign(taskId: number, employeeId: number, _a: number, archive: boolean) {
    const t = this.tasks.get(taskId)!;
    const ids = t.assigneeIds.filter((x) => x !== employeeId);
    this.tasks.set(taskId, { ...t, assigneeIds: ids, assigneeId: t.assigneeId === employeeId ? ids[0] ?? null : t.assigneeId, taskStatus: archive ? "done" : t.taskStatus });
  }
  async log(_u: number, action: string, taskId: number | null, details: string) { this.logs.push({ action, taskId, details }); }
  add(t: Partial<LocalTaskLike> & { id: number }) {
    this.tasks.set(t.id, { title: `Tarefa ${t.id}`, description: null, dueDate: null, dueHasTime: 0, taskStatus: "todo", updatedAt: sqlTs(T0 - 3_600_000),
      projectId: null, createdById: 1, assigneeId: 7, assigneeIds: [7], ...t });
  }
}

const EMP = 7;
const permsFor = (role: string) => taskSyncPermissions({ id: 42, role, employeeId: EMP }, () => true);
const ctxFor = (role = "supervisor", now = () => T0) => ({ userId: 42, employeeId: EMP, perms: permsFor(role), appUrl: APP, deadlineAt: T0 + 60_000, now });

async function firstSync(role = "supervisor") {
  const api = new FakeTasks();
  const store = new MemTaskStore();
  store.add({ id: 1, title: "Limpar parque", description: "Zona B", dueDate: "2026-09-30 00:00:00" });
  store.add({ id: 2, title: "Ver câmaras", taskStatus: "done" });
  store.add({ id: 3, title: "De outra pessoa", assigneeId: 9, assigneeIds: [9] });
  const r = await syncUserTasks(api, store, ctxFor(role));
  return { api, store, r, list: store.state.tasksListId! };
}

describe("Google Tasks ↔ Tarefas (dois sentidos)", () => {
  it("push: cria a lista Multipark e envia as tarefas atribuídas (título, notas + link, dia, estado)", async () => {
    const { api, store, r, list } = await firstSync();
    expect(api.lists.find((l) => l.id === list)?.title).toBe("Multipark");
    expect(r.createdRemote).toBe(2);
    const g1 = Array.from(api.tasks.values()).find((t) => t.title === "Limpar parque")!;
    expect(g1.notes).toContain("Zona B");
    expect(g1.notes).toContain(`${APP}/tarefas?focus=1`);
    expect(g1.due).toBe("2026-09-30T00:00:00.000Z");
    expect(g1.status).toBe("needsAction");
    expect(Array.from(api.tasks.values()).find((t) => t.title === "Ver câmaras")!.status).toBe("completed");
    expect(Array.from(api.tasks.values()).some((t) => t.title === "De outra pessoa")).toBe(false);
    expect(store.links.filter((l) => l.state === "active")).toHaveLength(2);
    // Segunda corrida sem alterações: nada é enviado de novo.
    api.calls = [];
    const r2 = await syncUserTasks(api, store, ctxFor());
    expect(r2.pushed + r2.createdRemote + r2.pulled).toBe(0);
    expect(api.calls.filter((c) => c.startsWith("tasks.patch") || c.startsWith("tasks.insert"))).toEqual([]);
  });

  it("reencontra uma lista \"Multipark\" que já existe (não cria outra)", async () => {
    const api = new FakeTasks();
    api.lists.push({ id: "L-antiga", title: "Multipark" });
    const store = new MemTaskStore();
    await syncUserTasks(api, store, ctxFor());
    expect(store.state.tasksListId).toBe("L-antiga");
    expect(api.calls).not.toContain("lists.insert");
  });

  it("pull: concluída / título / notas / prazo mudados no Google chegam ao dashboard", async () => {
    const { api, store } = await firstSync();
    const link = store.links.find((l) => l.taskId === 1)!;
    api.userEdit(link.googleTaskId, { status: "completed", title: "Limpar parque (feito)", notes: `Zona B e C\n\nAbrir no dashboard: ${APP}/tarefas?focus=1`, due: "2026-10-02T00:00:00.000Z" });
    const r = await syncUserTasks(api, store, ctxFor());
    expect(r.pulled).toBe(1);
    const t = store.tasks.get(1)!;
    expect(t.taskStatus).toBe("done");
    expect(t.title).toBe("Limpar parque (feito)");
    expect(t.description).toBe("Zona B e C");
    expect(String(t.dueDate).slice(0, 10)).toBe("2026-10-02");
    // Reaberta no Google → volta a "A fazer".
    api.userEdit(link.googleTaskId, { status: "needsAction", completed: null });
    await syncUserTasks(api, store, ctxFor());
    expect(store.tasks.get(1)!.taskStatus).toBe("todo");
  });

  it("push: alteração no dashboard vai para o Google", async () => {
    const { api, store } = await firstSync();
    store.tasks.set(1, { ...store.tasks.get(1)!, title: "Limpar parque já", updatedAt: sqlTs(T0 + 120_000) });
    const r = await syncUserTasks(api, store, ctxFor());
    expect(r.pushed).toBe(1);
    const gid = store.links.find((l) => l.taskId === 1)!.googleTaskId;
    expect(api.tasks.get(gid)!.title).toBe("Limpar parque já");
  });

  it("conflito: a última alteração ganha (com tolerância; empate → dashboard)", async () => {
    // Google mais recente → puxa.
    let { api, store } = await firstSync();
    let gid = store.links.find((l) => l.taskId === 1)!.googleTaskId;
    store.tasks.set(1, { ...store.tasks.get(1)!, title: "Versão dashboard", updatedAt: sqlTs(T0 + 60_000) });
    api.userEdit(gid, { title: "Versão Google" }, T0 + 5 * 60_000);
    let r = await syncUserTasks(api, store, ctxFor());
    expect(r.conflicts).toBe(1);
    expect(store.tasks.get(1)!.title).toBe("Versão Google");

    // Dashboard mais recente → envia.
    ({ api, store } = await firstSync());
    gid = store.links.find((l) => l.taskId === 1)!.googleTaskId;
    api.userEdit(gid, { title: "Versão Google" }, T0 + 60_000);
    store.tasks.set(1, { ...store.tasks.get(1)!, title: "Versão dashboard", updatedAt: sqlTs(T0 + 5 * 60_000) });
    r = await syncUserTasks(api, store, ctxFor());
    expect(store.tasks.get(1)!.title).toBe("Versão dashboard");
    expect(api.tasks.get(gid)!.title).toBe("Versão dashboard");

    // Empate (dentro da tolerância) → ganha o dashboard.
    ({ api, store } = await firstSync());
    gid = store.links.find((l) => l.taskId === 1)!.googleTaskId;
    api.userEdit(gid, { title: "Versão Google" }, T0 + 60_000 + 4_000);
    store.tasks.set(1, { ...store.tasks.get(1)!, title: "Versão dashboard", updatedAt: sqlTs(T0 + 60_000) });
    await syncUserTasks(api, store, ctxFor());
    expect(store.tasks.get(1)!.title).toBe("Versão dashboard");
    expect(api.tasks.get(gid)!.title).toBe("Versão dashboard");
  });

  it("criada no Google → tarefa nova atribuída à pessoa, com o link escrito de volta", async () => {
    const { api, store, list } = await firstSync();
    const gid = api.userCreate(list, { title: "Comprar cones", notes: "10 unidades", due: "2026-10-05T00:00:00.000Z" });
    const r = await syncUserTasks(api, store, ctxFor());
    expect(r.created).toBe(1);
    const t = Array.from(store.tasks.values()).find((x) => x.title === "Comprar cones")!;
    expect(t.assigneeIds).toEqual([EMP]);
    expect(t.description).toBe("10 unidades");
    expect(String(t.dueDate).slice(0, 10)).toBe("2026-10-05");
    expect(api.tasks.get(gid)!.notes).toContain(`focus=${t.id}`);
    expect(store.logs.some((l) => l.action === "google_tasks_create")).toBe(true);
    // Não duplica na corrida seguinte.
    const r2 = await syncUserTasks(api, store, ctxFor());
    expect(r2.created).toBe(0);
    expect(Array.from(store.tasks.values()).filter((x) => x.title === "Comprar cones")).toHaveLength(1);
  });

  it("apagada no Google → deixa de ser responsável (nunca apaga a tarefa) e fica registado", async () => {
    const { api, store } = await firstSync();
    const gid = store.links.find((l) => l.taskId === 1)!.googleTaskId;
    await api.deleteTask("", gid);
    const r = await syncUserTasks(api, store, ctxFor());
    expect(r.unassigned).toBe(1);
    expect(store.tasks.has(1)).toBe(true);
    expect(store.tasks.get(1)!.assigneeIds).not.toContain(EMP);
    expect(store.tasks.get(1)!.taskStatus).toBe("todo");
    expect(store.logs.find((l) => l.action === "google_tasks_unassign")?.taskId).toBe(1);
    expect(store.links.some((l) => l.taskId === 1)).toBe(false);
  });

  it("apagada no Google uma tarefa criada pela própria pessoa e só dela → arquivada (concluída)", async () => {
    const { api, store } = await firstSync();
    store.tasks.set(1, { ...store.tasks.get(1)!, createdById: 42 });
    const gid = store.links.find((l) => l.taskId === 1)!.googleTaskId;
    await api.deleteTask("", gid);
    await syncUserTasks(api, store, ctxFor());
    expect(store.tasks.get(1)!.taskStatus).toBe("done");
  });

  it("tirada da pessoa no dashboard → apagada do Google Tasks dela", async () => {
    const { api, store } = await firstSync();
    const gid = store.links.find((l) => l.taskId === 1)!.googleTaskId;
    store.tasks.set(1, { ...store.tasks.get(1)!, assigneeId: 9, assigneeIds: [9] });
    const r = await syncUserTasks(api, store, ctxFor());
    expect(r.deletedRemote).toBe(1);
    expect(api.tasks.get(gid)!.deleted).toBe(true);
  });

  it("guarda de permissões: quem não pode criar tarefas na app não cria pelo Google; o extra só muda o estado", async () => {
    const { api, store, list } = await firstSync("extra");
    const gid = api.userCreate(list, { title: "Tarefa inventada" });
    const r = await syncUserTasks(api, store, ctxFor("extra"));
    expect(r.rejected).toBe(1);
    expect(Array.from(store.tasks.values()).some((t) => t.title === "Tarefa inventada")).toBe(false);
    expect(store.links.find((l) => l.googleTaskId === gid)?.state).toBe("rejected");
    // Não tenta outra vez.
    const r2 = await syncUserTasks(api, store, ctxFor("extra"));
    expect(r2.rejected).toBe(0);
    // Muda o título (não pode) e conclui (pode): o estado entra, o título volta ao do dashboard.
    const g1 = store.links.find((l) => l.taskId === 1)!.googleTaskId;
    api.userEdit(g1, { title: "Título do extra", status: "completed" });
    await syncUserTasks(api, store, ctxFor("extra"));
    expect(store.tasks.get(1)!.taskStatus).toBe("done");
    expect(store.tasks.get(1)!.title).toBe("Limpar parque");
    expect(api.tasks.get(g1)!.title).toBe("Limpar parque");
  });

  it("permissões puras: extra não cria; team leader só edita o conteúdo das tarefas só suas", () => {
    expect(permsFor("extra").canCreate).toBe(false);
    expect(permsFor("extra").canChangeStatus({ projectId: null, assigneeId: EMP, assigneeIds: [EMP] })).toBe(true);
    expect(permsFor("extra").canChangeStatus({ projectId: null, assigneeId: 9, assigneeIds: [9] })).toBe(false);
    const tl = permsFor("team_leader");
    expect(tl.canCreate).toBe(true);
    expect(tl.canEditContent({ projectId: null, assigneeId: EMP, assigneeIds: [EMP] })).toBe(true);
    expect(tl.canEditContent({ projectId: null, assigneeId: EMP, assigneeIds: [EMP, 9] })).toBe(false);
    const outOfScope = taskSyncPermissions({ id: 42, role: "supervisor", employeeId: EMP }, (p) => p == null);
    expect(outOfScope.canEditContent({ projectId: 5, assigneeId: EMP, assigneeIds: [EMP] })).toBe(false);
  });

  it("resumível: prazo esgotado a meio não avança o cursor e a corrida seguinte termina sem duplicar", async () => {
    const api = new FakeTasks();
    const store = new MemTaskStore();
    for (let i = 1; i <= 5; i++) store.add({ id: i });
    let calls = 0;
    const now = () => (++calls > 6 ? T0 + 120_000 : T0);
    const r = await syncUserTasks(api, store, { ...ctxFor(), now });
    expect(r.partial).toBe(true);
    expect(store.state.tasksUpdatedMin).toBeNull();
    const r2 = await syncUserTasks(api, store, ctxFor());
    expect(r2.partial).toBe(false);
    expect(Array.from(api.tasks.values()).filter((t) => !t.deleted)).toHaveLength(5);
    expect(store.state.tasksUpdatedMin).not.toBeNull();
  });

  it("regras puras: notas sem o link, id pelo link, decisão sem mudanças", () => {
    expect(notesFromGoogle(`Olá\n\nAbrir no dashboard: ${APP}/tarefas?focus=12`)).toBe("Olá");
    expect(taskIdFromNotes(`x\nAbrir no dashboard: ${APP}/tarefas?focus=12`)).toBe(12);
    const local: LocalTaskLike = { id: 1, title: "A", description: "n", dueDate: "2026-09-30 00:00:00", taskStatus: "todo", updatedAt: null, projectId: null, assigneeId: 7, assigneeIds: [7] };
    const g = taskToGoogle(local, APP, T0);
    expect(decideTaskSync({ local: normLocal(local), remote: normRemote(g), syncedHash: null, localUpdatedMs: 0, remoteUpdatedMs: 0 })).toBe("none");
    expect(pullPatch(local, { ...normRemote(g), done: true }, permsFor("extra"))).toEqual({ taskStatus: "done" });
  });
});

// ─── Google Calendar falso ──────────────────────────────────────────────────

class FakeCalendar implements CalendarApiLike {
  calendars: Array<{ id: string; summary: string; accessRole: string | null; description: string | null }> = [{ id: "primary@x", summary: "joao@multipark.pt", accessRole: "owner", description: null }];
  events = new Map<string, calendar_v3.Schema$Event & { cal: string }>();
  changed: string[] = [];
  token = 0;
  calls: string[] = [];
  acl: calendar_v3.Schema$AclRule[] = [];
  private touch(id: string) { this.changed.push(id); }
  async listCalendars() { return this.calendars.map((c) => ({ ...c })); }
  async insertCalendar(b: { summary: string; description: string; timeZone: string }) { const id = `cal${this.calendars.length}`; this.calendars.push({ id, summary: b.summary, accessRole: "owner", description: b.description }); this.calls.push("calendars.insert"); return { id }; }
  async listEvents(cal: string, p: { syncToken?: string | null }) {
    const since = p.syncToken ? Number(p.syncToken) : 0;
    const ids = p.syncToken ? Array.from(new Set(this.changed.slice(since))) : Array.from(this.events.keys());
    const items = ids.map((id) => this.events.get(id)).filter((e): e is calendar_v3.Schema$Event & { cal: string } => !!e && e.cal === cal).map(({ cal: _c, ...e }) => ({ ...e }));
    return { items, nextPageToken: null, nextSyncToken: String(this.changed.length) };
  }
  async insertEvent(cal: string, body: calendar_v3.Schema$Event) {
    const id = String(body.id ?? `ev${this.events.size}`);
    if (this.events.has(id)) throw httpErr(409);
    this.events.set(id, { ...body, id, status: "confirmed", cal });
    this.touch(id);
    this.calls.push(`insert:${id}`);
    return { ...body, id };
  }
  async patchEvent(cal: string, id: string, body: calendar_v3.Schema$Event) {
    const cur = this.events.get(id);
    if (!cur || cur.cal !== cal) throw httpErr(404);
    this.events.set(id, { ...cur, ...body, cal });
    this.touch(id);
    this.calls.push(`patch:${id}`);
    return { ...cur, ...body };
  }
  async deleteEvent(cal: string, id: string) {
    const cur = this.events.get(id);
    if (cur) { this.events.set(id, { ...cur, status: "cancelled" }); this.touch(id); }
    this.calls.push(`delete:${id}`);
  }
  async freeBusy() { return []; }
  async insertAcl(_c: string, rule: calendar_v3.Schema$AclRule) { this.acl.push(rule); }
  live() { return Array.from(this.events.values()).filter((e) => e.status !== "cancelled"); }
}

class MemCalStore implements CalendarStore {
  st = new Map<string, { calendarId: string | null; syncToken: string | null }>();
  maps = new Map<string, Map<string, CalendarMapping>>();
  async getState(t: string) { return { ...(this.st.get(t) ?? { calendarId: null, syncToken: null }) }; }
  async saveState(t: string, p: Partial<{ calendarId: string | null; syncToken: string | null }>) { this.st.set(t, { ...(this.st.get(t) ?? { calendarId: null, syncToken: null }), ...p }); }
  async loadMappings(t: string) { return Array.from((this.maps.get(t) ?? new Map()).values()).map((m) => ({ ...m })); }
  async saveMapping(t: string, _c: string, m: CalendarMapping) { if (!this.maps.has(t)) this.maps.set(t, new Map()); this.maps.get(t)!.set(m.key, { ...m }); }
  async deleteMapping(t: string, k: string) { this.maps.get(t)?.delete(k); }
}

const shift = (o: Partial<ShiftRow> = {}): ShiftRow => ({ id: 11, assignmentDate: "2026-09-27", city: "lisbon", startHour: 8, endHour: 16, isTeamLeader: 0, version: 1, personName: "Ana", ...o });
const OPTS = { title: "Multipark", description: "x", deadlineAt: T0 + 60_000, windowFromMs: calendarWindow(T0).fromMs, now: () => T0 };

describe("Google Calendar (eventos idempotentes)", () => {
  it("upsert idempotente: cria o calendário secundário, insere 1×, a 2.ª corrida não faz nada", async () => {
    const api = new FakeCalendar();
    const store = new MemCalStore();
    const desired = [shiftEvent(shift(), APP)];
    const r1 = await syncCalendarTarget(api, store, "user:42", desired, OPTS);
    expect(api.calls).toContain("calendars.insert");
    expect(r1.inserted).toBe(1);
    const ev = api.live()[0];
    expect(ev.extendedProperties?.private).toMatchObject({ mpKey: "shift:11", mpSource: "shift", mpId: "11", mpVersion: "1" });
    expect(ev.description).toContain(`${APP}/extras-dia?date=2026-09-27`);
    expect(ev.id).toBe(calendarEventId("user:42", "shift:11"));
    api.calls = [];
    const r2 = await syncCalendarTarget(api, store, "user:42", desired, OPTS);
    expect(r2.inserted + r2.updated + r2.deleted).toBe(0);
    expect(api.calls).toEqual([]);
  });

  it("ligação perdida na BD: o evento é reencontrado pela propriedade privada — nunca duplica", async () => {
    const api = new FakeCalendar();
    const store = new MemCalStore();
    const desired = [shiftEvent(shift(), APP)];
    await syncCalendarTarget(api, store, "user:42", desired, OPTS);
    store.maps.clear();
    await store.saveState("user:42", { syncToken: null });
    const r = await syncCalendarTarget(api, store, "user:42", desired, OPTS);
    expect(r.adopted).toBe(1);
    expect(r.inserted).toBe(0);
    expect(api.live()).toHaveLength(1);
  });

  it("inserir outra vez o mesmo id (corrida anterior a meio) → 409 → atualiza", async () => {
    const api = new FakeCalendar();
    const store = new MemCalStore();
    await syncCalendarTarget(api, store, "user:42", [shiftEvent(shift(), APP)], OPTS);
    store.maps.clear();
    await store.saveState("user:42", { syncToken: String(api.changed.length) }); // o pull não vê o evento
    const r = await syncCalendarTarget(api, store, "user:42", [shiftEvent(shift({ version: 2, endHour: 18 }), APP)], OPTS);
    expect(r.updated).toBe(1);
    expect(api.live()).toHaveLength(1);
    expect(api.live()[0].summary).toContain("08h–18h");
  });

  it("turno mudado (nova versão / horas) → atualiza o evento", async () => {
    const api = new FakeCalendar();
    const store = new MemCalStore();
    await syncCalendarTarget(api, store, "user:42", [shiftEvent(shift(), APP)], OPTS);
    const r = await syncCalendarTarget(api, store, "user:42", [shiftEvent(shift({ version: 2, startHour: 10, endHour: 18 }), APP)], OPTS);
    expect(r.updated).toBe(1);
    const ev = api.live()[0];
    expect(ev.extendedProperties?.private?.mpVersion).toBe("2");
    expect(ev.summary).toContain("10h–18h");
  });

  it("turno cancelado → apaga o evento; eventos passados nunca se apagam", async () => {
    const api = new FakeCalendar();
    const store = new MemCalStore();
    await syncCalendarTarget(api, store, "user:42", [shiftEvent(shift(), APP)], OPTS);
    const r = await syncCalendarTarget(api, store, "user:42", [], OPTS);
    expect(r.deleted).toBe(1);
    expect(api.live()).toHaveLength(0);
    const past: CalendarMapping = { key: "shift:1", eventId: "x", version: "1", hash: "h", startMs: OPTS.windowFromMs - 86_400_000 };
    expect(planCalendarOps([], [past], OPTS.windowFromMs).delete).toEqual([]);
  });

  it("apagado pela pessoa no Google: não se recria enquanto a origem não mudar", async () => {
    const api = new FakeCalendar();
    const store = new MemCalStore();
    const d = [shiftEvent(shift(), APP)];
    await syncCalendarTarget(api, store, "user:42", d, OPTS);
    const id = api.live()[0].id!;
    await api.deleteEvent("cal1", id); // a pessoa apagou
    const r = await syncCalendarTarget(api, store, "user:42", d, OPTS);
    expect(r.inserted + r.updated).toBe(0);
    const r2 = await syncCalendarTarget(api, store, "user:42", [shiftEvent(shift({ version: 3, endHour: 20 }), APP)], OPTS);
    expect(r2.updated).toBe(1);
    expect(api.live()).toHaveLength(1);
  });

  it("plano puro: igual → nada; hash diferente → atualizar; sem origem → apagar", () => {
    const e = shiftEvent(shift(), APP);
    const m: CalendarMapping = { key: e.key, eventId: "ev", version: e.version, hash: eventHash(e), startMs: e.startMs };
    expect(planCalendarOps([e], [m], 0)).toEqual({ insert: [], patch: [], delete: [], forget: [] });
    expect(planCalendarOps([{ ...e, summary: "outro" }], [m], 0).patch).toHaveLength(1);
    expect(planCalendarOps([], [m], 0).delete).toHaveLength(1);
    const body = eventBody(e);
    expect(mappingFromEvent({ id: "ev", status: "confirmed", start: body.start, extendedProperties: body.extendedProperties })).toMatchObject({ key: e.key, version: "1", hash: eventHash(e) });
  });

  it("turno da noite (horas até às 27h) acaba no dia seguinte, hora de Lisboa", () => {
    const e = shiftEvent(shift({ startHour: 20, endHour: 27 }), APP);
    expect(e.start.dateTime).toBe("2026-09-27T19:00:00.000Z");
    expect(e.end.dateTime).toBe("2026-09-28T02:00:00.000Z");
    expect(e.start.timeZone).toBe("Europe/Lisbon");
  });
});

// ─── Reuniões com Meet ──────────────────────────────────────────────────────

describe("Criar reunião (Google Meet)", () => {
  it("corpo com conferenceData (hangoutsMeet) e convidado só quando pedido", () => {
    const base = { title: "Reunião", startMs: lisbonLocalToUtcMs("2026-10-01T14:30"), durationMin: 30, description: "Cliente X", requestId: "req-1", link: `${APP}/clientes`, entityKey: "client:a@b.pt" };
    const b = meetingEventBody({ ...base, attendeeEmail: null });
    expect(b.conferenceData.createRequest).toEqual({ requestId: "req-1", conferenceSolutionKey: { type: "hangoutsMeet" } });
    expect((b as any).attendees).toBeUndefined();
    expect(b.start.dateTime).toBe("2026-10-01T13:30:00.000Z");
    expect(b.end.dateTime).toBe("2026-10-01T14:00:00.000Z");
    const inv = meetingEventBody({ ...base, attendeeEmail: "cliente@gmail.com" });
    expect((inv as any).attendees).toEqual([{ email: "cliente@gmail.com" }]);
    expect(meetLinkOf({ conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:1" }, { entryPointType: "video", uri: "https://meet.google.com/abc" }] } })).toBe("https://meet.google.com/abc");
    expect(meetLinkOf({ hangoutLink: "https://meet.google.com/xyz" })).toBe("https://meet.google.com/xyz");
  });

  it("adaptador oficial: events.insert no calendário principal com conferenceDataVersion 1 e sendUpdates", async () => {
    const insert = vi.fn(async (_p: any) => ({ data: { id: "e1", hangoutLink: "https://meet.google.com/q", htmlLink: "https://calendar.google.com/e1" } }));
    const fake = { events: { insert } } as unknown as calendar_v3.Calendar;
    const api = wrapCalendar(fake, { deadlineAt: Date.now() + 10_000 });
    const e = await api.insertEvent("primary", { summary: "x" }, { conferenceDataVersion: 1, sendUpdates: "none" });
    expect(insert.mock.calls[0][0]).toMatchObject({ calendarId: "primary", conferenceDataVersion: 1, sendUpdates: "none", requestBody: { summary: "x" } });
    expect(meetLinkOf(e)).toBe("https://meet.google.com/q");
  });
});

// ─── Âmbitos, limites e cron ────────────────────────────────────────────────

describe("Âmbitos (autorização incremental) e âmbito em falta", () => {
  it("calendário e tarefas pedem os seus âmbitos; o Gmail continua a valer", () => {
    expect(requestedFeatures("tasks,calendar")).toEqual(["tasks", "calendar"]);
    const s = scopesFor(["tasks", "calendar"]);
    expect(s).toContain("https://www.googleapis.com/auth/tasks");
    expect(s).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(s).toContain("https://www.googleapis.com/auth/calendar.freebusy");
    expect(s).not.toContain("https://www.googleapis.com/auth/gmail.modify");
    const granted = [...GOOGLE_FEATURE_SCOPES.gmail, ...GOOGLE_FEATURE_SCOPES.tasks].join(" ");
    expect(hasFeatureScopes(granted, "tasks")).toBe(true);
    expect(hasFeatureScopes(granted, "calendar")).toBe(false);
  });

  it("âmbito em falta / revogado / limite → tipos distintos (nunca rebenta)", () => {
    expect(calendarAndTasksErrorKind(new Error("A conta Google ligada não autorizou este acesso — volta a ligar no Perfil."))).toBe("scope_missing");
    expect(calendarAndTasksErrorKind(httpErr(403, { error: { errors: [{ reason: "insufficientPermissions" }], message: "Insufficient Permission" } }))).toBe("scope_missing");
    expect(calendarAndTasksErrorKind(Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } }))).toBe("reauth_required");
    expect(calendarAndTasksErrorKind(new GoogleRateLimitError())).toBe("rate_limited");
    expect(calendarAndTasksErrorKind(httpErr(403, { error: { errors: [{ reason: "accessNotConfigured" }] } }))).toBe("error");
  });

  it("sem âmbito: a sincronização da pessoa devolve scope_missing (aviso para o Perfil) sem chamar a Google", async () => {
    vi.resetModules();
    const patched: any[] = [];
    vi.doMock("./google/syncStore", async (orig) => ({
      ...(await orig<typeof import("./google/syncStore")>()),
      getSyncState: vi.fn(async (userId: number) => ({ userId, prefs: DEFAULT_GOOGLE_SYNC_PREFS, tasksListId: null, tasksUpdatedMin: null, calendarId: null, calendarSyncToken: null, lastTasksSyncAt: null, lastCalendarSyncAt: null, lastRunAt: null, lastStatus: null, lastError: null, lastWarning: null, dirtyAt: null })),
      patchSyncState: vi.fn(async (_u: number, p: any) => { patched.push(p); }),
      claimUserLock: vi.fn(async () => { throw new Error("não devia correr"); }),
    }));
    const auth = vi.fn();
    vi.doMock("./google/userAccounts", () => ({ userGoogleAuth: auth }));
    const { syncOneUser } = await import("./google/syncService");
    const r = await syncOneUser({ userId: 5, role: "supervisor", scopes: GOOGLE_FEATURE_SCOPES.gmail.join(" "), status: "connected", isActive: true }, { deadlineAt: Date.now() + 10_000 });
    expect(r.status).toBe("scope_missing");
    expect(r.error).toMatch(/Tarefas e Calendário/);
    expect(auth).not.toHaveBeenCalled();
    expect(patched[0]).toMatchObject({ lastStatus: "scope_missing" });
    vi.doUnmock("./google/syncStore");
    vi.doUnmock("./google/userAccounts");
    vi.resetModules();
  });
});

describe("Limites de pedidos (429 / 403 rateLimitExceeded)", () => {
  it("repete com espera exponencial e desiste antes do prazo", async () => {
    expect(isRateLimitError(httpErr(429))).toBe(true);
    expect(isRateLimitError(httpErr(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }))).toBe(true);
    expect(isRateLimitError(httpErr(403, { error: { errors: [{ reason: "forbidden" }] } }))).toBe(false);
    const waits: number[] = [];
    let n = 0;
    const ok = await withGoogleRetry(async () => { if (n++ < 2) throw httpErr(429); return "ok"; }, { deadlineAt: 1e15, sleep: async (ms) => { waits.push(ms); }, random: () => 0 });
    expect(ok).toBe("ok");
    expect(waits).toEqual([500, 1000]);
    await expect(withGoogleRetry(async () => { throw httpErr(429); }, { deadlineAt: 1e15, retries: 2, sleep: async () => {}, random: () => 0 })).rejects.toBeInstanceOf(GoogleRateLimitError);
    await expect(withGoogleRetry(async () => { throw httpErr(429); }, { deadlineAt: Date.now() + 500, sleep: async () => {} })).rejects.toBeInstanceOf(GoogleRateLimitError);
    await expect(withGoogleRetry(async () => { throw httpErr(500); }, { deadlineAt: 1e15 })).rejects.toThrow("HTTP 500");
  });

  it("limite a meio da sincronização de tarefas → parcial (repete na próxima), sem erro", async () => {
    const api = new FakeTasks();
    const store = new MemTaskStore();
    store.add({ id: 1 });
    api.insertTask = async () => { throw new GoogleRateLimitError(); };
    const r = await syncUserTasks(api, store, ctxFor());
    expect(r.rateLimited).toBe(true);
    expect(r.partial).toBe(true);
  });
});

describe("Cron google-sync: ok honesto", () => {
  it("avisos (religar, âmbito, limite) não pintam de vermelho; falhas reais sim", () => {
    expect(googleSyncCronOk({ users: [], sharedErrors: [] })).toBe(true);
    expect(googleSyncCronOk({ users: [{ userId: 1, status: "reauth_required" }, { userId: 2, status: "scope_missing" }, { userId: 3, status: "rate_limited" }], sharedErrors: [] })).toBe(true);
    expect(googleSyncCronOk({ users: [{ userId: 1, status: "ok" }, { userId: 2, status: "ok" }, { userId: 3, status: "error" }], sharedErrors: [] })).toBe(true);
    expect(googleSyncCronOk({ users: [{ userId: 1, status: "error" }], sharedErrors: [] })).toBe(false);
    expect(googleSyncCronOk({ users: [{ userId: 1, status: "ok" }, { userId: 2, status: "error" }], sharedErrors: [] })).toBe(false);
    expect(googleSyncCronOk({ users: [{ userId: 1, status: "ok" }], sharedErrors: ["Calendário partilhado lisbon: 500"] })).toBe(false);
    expect(googleSyncCronOk({ users: [], sharedErrors: [], fatal: "BD indisponível" })).toBe(false);
    expect(googleSyncCronOk({ users: [{ userId: 1, status: "skipped" }, { userId: 2, status: "partial" }], sharedErrors: [] })).toBe(true);
  });
});

describe("Outros (preferências, configuração, livre/ocupado, migração)", () => {
  it("preferências com omissões seguras (prazos de tarefas e SLAs desligados)", () => {
    expect(parseGoogleSyncPrefs(null)).toEqual({ tasks: true, calShifts: true, calTraining: true, calTaskDue: false, calSla: false });
    expect(parseGoogleSyncPrefs('{"calSla":true}').calSla).toBe(true);
    expect(parseGoogleSyncPrefs("lixo").tasks).toBe(true);
  });

  it("calendários partilhados: ligar exige a conta dona", () => {
    expect(sharedCalendarsConfigSchema.safeParse({ enabled: true, ownerEmail: "" }).success).toBe(false);
    expect(sharedCalendarsConfigSchema.safeParse({ enabled: true, ownerEmail: "Escala@Multipark.pt" }).data?.ownerEmail).toBe("escala@multipark.pt");
  });

  it("escala da cidade e passagem de turno automáticas: desligadas por omissão; turnos pessoais ficam sempre", () => {
    const cfg = sharedCalendarsConfigSchema.parse({});
    expect(cfg.leadCityDayEvents).toBe(false);
    expect(cfg.handoverEvents).toBe(false);
    const evs = [{ sourceType: "shift" }, { sourceType: "cityday" }, { sourceType: "handover" }, { sourceType: "training" }];
    expect(filterLeadEvents(evs, cfg).map((e) => e.sourceType)).toEqual(["shift", "training"]);
    expect(filterLeadEvents(evs, { leadCityDayEvents: true, handoverEvents: false }).map((e) => e.sourceType)).toEqual(["shift", "cityday", "training"]);
    expect(filterLeadEvents(evs, { leadCityDayEvents: false, handoverEvents: true }).map((e) => e.sourceType)).toEqual(["shift", "handover", "training"]);
  });

  it("livre/ocupado por dia de Lisboa, cortado à meia-noite (só horas)", () => {
    const r = busyByDay([{ start: "2026-09-28T08:00:00Z", end: "2026-09-28T09:30:00Z" }, { start: "2026-09-28T22:00:00Z", end: "2026-09-29T01:00:00Z" }], ["2026-09-28", "2026-09-29"]);
    expect(r["2026-09-28"]).toEqual([{ start: "09:00", end: "10:30" }, { start: "23:00", end: "24:00" }]);
    expect(r["2026-09-29"]).toEqual([{ start: "00:00", end: "02:00" }]);
  });

  it("janela do calendário e hash estáveis", () => {
    const w = calendarWindow(T0);
    expect(w.fromDay).toBe("2026-09-24");
    expect(w.toDay).toBe(`2026-10-${String(25 + CALENDAR_WINDOW_FUTURE_DAYS - 30).padStart(2, "0")}`);
    expect(stableHash("a")).toBe(stableHash("a"));
    expect(stableHash("a")).not.toBe(stableHash("b"));
    expect(calendarEventId("user:1", "shift:1")).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  it("migração 0150 idempotente (só CREATE TABLE IF NOT EXISTS)", () => {
    expect(MIGRATION_0150_STATEMENTS.length).toBe(5);
    for (const s of MIGRATION_0150_STATEMENTS) expect(s.startsWith("CREATE TABLE IF NOT EXISTS")).toBe(true);
  });

  it("evento de turno leva o link de volta e a versão", () => {
    const e: DesiredEvent = shiftEvent(shift({ isTeamLeader: 1 }), APP);
    expect(e.summary).toMatch(/^Team leader Multipark — Lisboa/);
    expect(eventBody(e).source.url).toBe(`${APP}/extras-dia?date=2026-09-27`);
  });
});
