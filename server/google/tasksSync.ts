/**
 * Google Tasks ↔ Tarefas do dashboard, nos dois sentidos, por pessoa
 * (núcleo com dependências injetáveis — a API e a BD são falsas nos testes).
 *
 *  1. Lista "Multipark": a guardada, senão a que já existe com esse nome,
 *     senão cria-a.
 *  2. PUXAR (Google → dashboard): tasks.list com updatedMin (cursor com 60 s
 *     de sobreposição; inclui apagadas, escondidas e concluídas):
 *       - ligada e mudou só no Google → aplica o que a pessoa pode mudar na
 *         app (estado sempre que é responsável; título/notas/prazo só quem
 *         edita tarefas) e reenvia o resto (o Google fica igual ao dashboard);
 *       - mudou dos dois lados → ganha a alteração mais recente (tolerância
 *         de 10 s; empate → dashboard);
 *       - apagada no Google → a pessoa deixa de ser responsável (nunca se
 *         apaga a tarefa) e fica registado; uma tarefa criada no Google pela
 *         própria pessoa e só dela é concluída ("arquivada");
 *       - nova no Google → tarefa nova atribuída à pessoa, SÓ se ela pode
 *         criar tarefas na app (senão fica "recusada" e não se tenta outra vez).
 *  3. ENVIAR (dashboard → Google): tarefas atribuídas sem ligação → cria;
 *     mudadas no dashboard → atualiza; ligadas mas já não atribuídas (ou
 *     apagadas no dashboard) → apaga no Google.
 *  O cursor só avança no fim de uma passagem completa (resumível: o que já
 *  foi tratado fica igual pelo hash da forma acordada).
 */
import type { tasks_v1 } from "@googleapis/tasks";
import {
  GOOGLE_TASK_LIST_TITLE, GOOGLE_TASK_SOURCE, TASKS_UPDATED_MIN_OVERLAP_MS, decideTaskSync, normHash, normLocal, normRemote,
  notesFromGoogle, pullPatch, remoteDueDay, taskIdFromNotes, taskToGoogle,
  type LocalTaskLike, type TaskPullPatch, type TaskSyncPermissions,
} from "../../shared/googleSync";
import { httpStatusOf } from "./workspace";
import { GoogleRateLimitError, type TasksApiLike } from "./apis";

export interface TaskLinkRow {
  id: number | null;
  userId: number;
  taskId: number | null;
  googleTaskId: string;
  listId: string;
  etag: string | null;
  googleUpdatedAt: string | null;
  syncedHash: string | null;
  state: "active" | "rejected";
}

export interface TaskSyncStateRow { tasksListId: string | null; tasksUpdatedMin: string | null }

export interface NewTaskInput {
  title: string; description: string | null; dueDate: string | null; done: boolean; createdById: number; employeeId: number;
}

export interface TaskSyncStore {
  getState(userId: number): Promise<TaskSyncStateRow>;
  saveState(userId: number, patch: Partial<TaskSyncStateRow>): Promise<void>;
  loadLinks(userId: number): Promise<TaskLinkRow[]>;
  saveLink(link: TaskLinkRow): Promise<TaskLinkRow>;
  deleteLink(link: TaskLinkRow): Promise<void>;
  /** Tarefas atribuídas à pessoa (ativas + as já ligadas, se ainda atribuídas). */
  loadAssignedTasks(employeeId: number, linkedTaskIds: readonly number[]): Promise<LocalTaskLike[]>;
  applyPull(taskId: number, patch: TaskPullPatch, actorUserId: number): Promise<LocalTaskLike | null>;
  createTask(input: NewTaskInput): Promise<LocalTaskLike>;
  /** Tira a pessoa dos responsáveis (nunca apaga a tarefa); `archive` conclui-a. */
  unassign(taskId: number, employeeId: number, actorUserId: number, archive: boolean): Promise<void>;
  log(userId: number, action: string, taskId: number | null, details: string): Promise<void>;
}

export interface TaskSyncContext {
  userId: number;
  employeeId: number;
  perms: TaskSyncPermissions;
  appUrl: string;
  deadlineAt: number;
  now?: () => number;
}

export interface TaskSyncResult {
  listId: string | null;
  pulled: number;
  pushed: number;
  created: number;
  createdRemote: number;
  unassigned: number;
  deletedRemote: number;
  rejected: number;
  conflicts: number;
  partial: boolean;
  rateLimited: boolean;
  errors: string[];
}

const ms = (s: string | null | undefined) => { const t = Date.parse(String(s ?? "")); return Number.isFinite(t) ? t : null; };
const sqlMs = (s: string | null | undefined) => (s ? ms(String(s).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? "" : "Z")) : null);
const maxIso = (a: string | null, b: string | null | undefined) => (!b ? a : !a || Date.parse(b) > Date.parse(a) ? b : a);

async function ensureList(api: TasksApiLike, store: TaskSyncStore, userId: number, state: TaskSyncStateRow): Promise<string> {
  if (state.tasksListId) return state.tasksListId;
  const lists = await api.listTaskLists();
  const found = lists.find((l) => l.title.trim().toLowerCase() === GOOGLE_TASK_LIST_TITLE.toLowerCase());
  const id = found?.id ?? (await api.insertTaskList(GOOGLE_TASK_LIST_TITLE)).id;
  await store.saveState(userId, { tasksListId: id, tasksUpdatedMin: null });
  return id;
}

/** Sincroniza as tarefas de UMA pessoa até ao prazo. */
export async function syncUserTasks(api: TasksApiLike, store: TaskSyncStore, ctx: TaskSyncContext): Promise<TaskSyncResult> {
  const now = ctx.now ?? Date.now;
  const res: TaskSyncResult = { listId: null, pulled: 0, pushed: 0, created: 0, createdRemote: 0, unassigned: 0, deletedRemote: 0, rejected: 0, conflicts: 0, partial: false, rateLimited: false, errors: [] };
  const late = () => now() > ctx.deadlineAt;
  try {
    let state = await store.getState(ctx.userId);
    let listId = await ensureList(api, store, ctx.userId, state);
    res.listId = listId;
    let links = (await store.loadLinks(ctx.userId)).filter((l) => l.listId === listId);

    // ── 1. Ler as alterações do Google ──
    const remote: tasks_v1.Schema$Task[] = [];
    const updatedMin = state.tasksUpdatedMin ? new Date(Date.parse(state.tasksUpdatedMin) - TASKS_UPDATED_MIN_OVERLAP_MS).toISOString() : null;
    let pageToken: string | null = null;
    for (let page = 0; page < 50; page++) {
      if (late()) { res.partial = true; return res; }
      let r: Awaited<ReturnType<TasksApiLike["listTasks"]>>;
      try { r = await api.listTasks(listId, { updatedMin, pageToken }); }
      catch (err) {
        // Lista apagada pela pessoa → volta a criá-la (as ligações antigas deixam de valer).
        if (httpStatusOf(err) === 404 && page === 0) {
          await store.saveState(ctx.userId, { tasksListId: null, tasksUpdatedMin: null });
          state = { tasksListId: null, tasksUpdatedMin: null };
          listId = await ensureList(api, store, ctx.userId, state);
          res.listId = listId;
          for (const l of links) await store.deleteLink(l);
          links = [];
          continue;
        }
        throw err;
      }
      remote.push(...r.items);
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    let cursor: string | null = state.tasksUpdatedMin;
    for (const t of remote) cursor = maxIso(cursor, t.updated);

    const byGid = new Map(links.map((l) => [l.googleTaskId, l]));
    const byTid = new Map(links.filter((l) => l.taskId != null).map((l) => [l.taskId!, l]));
    let local = await store.loadAssignedTasks(ctx.employeeId, Array.from(byTid.keys()));
    const localById = new Map(local.map((t) => [t.id, t]));
    const handled = new Set<string>();

    const pushPatch = async (task: LocalTaskLike, link: TaskLinkRow): Promise<boolean> => {
      try {
        const g = await api.patchTask(listId, link.googleTaskId, taskToGoogle(task, ctx.appUrl, now()));
        cursor = maxIso(cursor, g.updated);
        await store.saveLink({ ...link, etag: g.etag ?? null, googleUpdatedAt: g.updated ?? null, syncedHash: normHash(normLocal(task)) });
        return true;
      } catch (err) {
        if (httpStatusOf(err) !== 404) throw err;
        // Apagada no Google entretanto → tratada como apagada.
        await onRemoteDeleted(task, link);
        return false;
      }
    };

    const onRemoteDeleted = async (task: LocalTaskLike | undefined, link: TaskLinkRow) => {
      if (task) {
        const own = task.createdById === ctx.userId && task.assigneeIds.every((x) => x === ctx.employeeId);
        await store.unassign(task.id, ctx.employeeId, ctx.userId, own);
        await store.log(ctx.userId, "google_tasks_unassign", task.id,
          own ? `Tarefa apagada no Google Tasks — concluída (arquivada): ${task.title}` : `Tarefa apagada no Google Tasks — deixou de ser responsável: ${task.title}`);
        res.unassigned++;
        // Já não é desta pessoa: não volta a ser enviada.
        localById.delete(task.id);
      }
      await store.deleteLink(link);
      byGid.delete(link.googleTaskId);
      if (link.taskId != null) byTid.delete(link.taskId);
    };

    for (const r of remote) {
      if (late()) { res.partial = true; return res; }
      if (!r.id) continue;
      handled.add(r.id);
      let link = byGid.get(r.id);
      if (!link) {
        if (r.deleted) continue;
        // Ligação perdida? (o link nas notas diz qual é a tarefa)
        const tid = taskIdFromNotes(r.notes);
        if (tid != null && localById.has(tid) && !byTid.has(tid)) {
          link = await store.saveLink({ id: null, userId: ctx.userId, taskId: tid, googleTaskId: r.id, listId, etag: r.etag ?? null, googleUpdatedAt: r.updated ?? null, syncedHash: normHash(normRemote(r)), state: "active" });
          byGid.set(r.id, link); byTid.set(tid, link);
        } else if (tid != null) {
          continue; // tarefa de outra pessoa/antiga: não se duplica
        } else {
          // Nova no Google → tarefa nova no dashboard (só se a pessoa pode criar).
          if (!ctx.perms.canCreate) {
            const rej = await store.saveLink({ id: null, userId: ctx.userId, taskId: null, googleTaskId: r.id, listId, etag: r.etag ?? null, googleUpdatedAt: r.updated ?? null, syncedHash: null, state: "rejected" });
            byGid.set(r.id, rej);
            res.rejected++;
            await store.log(ctx.userId, "google_tasks_rejected", null, `Tarefa criada no Google Tasks não entrou no dashboard (sem permissão para criar tarefas): ${String(r.title ?? "").slice(0, 120)}`);
            continue;
          }
          const n = normRemote(r);
          const task = await store.createTask({
            title: n.title || "(sem título)", description: n.notes || null, dueDate: n.day ? `${n.day} 00:00:00` : null, done: n.done,
            createdById: ctx.userId, employeeId: ctx.employeeId,
          });
          await store.log(ctx.userId, "google_tasks_create", task.id, `Tarefa criada a partir do Google Tasks: ${task.title}`);
          local = [...local, task];
          localById.set(task.id, task);
          link = await store.saveLink({ id: null, userId: ctx.userId, taskId: task.id, googleTaskId: r.id, listId, etag: r.etag ?? null, googleUpdatedAt: r.updated ?? null, syncedHash: normHash(n), state: "active" });
          byGid.set(r.id, link); byTid.set(task.id, link);
          // Escreve a ligação de volta ao dashboard nas notas.
          await pushPatch(task, link);
          res.created++;
          continue;
        }
      }
      if (link.state === "rejected") continue;
      const task = link.taskId != null ? localById.get(link.taskId) : undefined;
      if (r.deleted) { await onRemoteDeleted(task, link); continue; }
      if (!task) continue; // já não atribuída/apagada no dashboard → trata-se no envio
      const decision = decideTaskSync({
        local: normLocal(task), remote: normRemote(r), syncedHash: link.syncedHash,
        localUpdatedMs: sqlMs(task.updatedAt), remoteUpdatedMs: ms(r.updated),
      });
      const bothChanged = link.syncedHash != null && normHash(normLocal(task)) !== link.syncedHash && normHash(normRemote(r)) !== link.syncedHash;
      if (bothChanged && decision !== "none") res.conflicts++;
      if (decision === "none") {
        if (link.etag !== (r.etag ?? null) || link.syncedHash !== normHash(normRemote(r))) {
          await store.saveLink({ ...link, etag: r.etag ?? null, googleUpdatedAt: r.updated ?? null, syncedHash: normHash(normRemote(r)) });
        }
        continue;
      }
      if (decision === "push") {
        if (await pushPatch(task, link)) res.pushed++;
        continue;
      }
      // pull
      const patch = pullPatch(task, normRemote(r), ctx.perms);
      let fresh = task;
      if (Object.keys(patch).length) {
        fresh = (await store.applyPull(task.id, patch, ctx.userId)) ?? task;
        localById.set(fresh.id, fresh);
        res.pulled++;
      }
      if (normHash(normLocal(fresh)) !== normHash(normRemote(r))) {
        // O que a pessoa não pode mudar na app volta ao valor do dashboard.
        await pushPatch(fresh, link);
      } else {
        await store.saveLink({ ...link, etag: r.etag ?? null, googleUpdatedAt: r.updated ?? null, syncedHash: normHash(normLocal(fresh)) });
      }
    }

    // ── 2. Enviar o que mudou no dashboard ──
    for (const task of Array.from(localById.values())) {
      if (late()) { res.partial = true; return res; }
      const link = byTid.get(task.id);
      if (!link) {
        const g = await api.insertTask(listId, taskToGoogle(task, ctx.appUrl, now()));
        cursor = maxIso(cursor, g.updated);
        const saved = await store.saveLink({ id: null, userId: ctx.userId, taskId: task.id, googleTaskId: String(g.id), listId, etag: g.etag ?? null, googleUpdatedAt: g.updated ?? null, syncedHash: normHash(normLocal(task)), state: "active" });
        byTid.set(task.id, saved); byGid.set(saved.googleTaskId, saved);
        res.createdRemote++;
        continue;
      }
      if (handled.has(link.googleTaskId)) continue;
      if (normHash(normLocal(task)) !== link.syncedHash) {
        if (await pushPatch(task, link)) res.pushed++;
      }
    }

    // ── 3. Ligadas mas já não atribuídas / apagadas no dashboard → apagar no Google ──
    for (const link of Array.from(byGid.values())) {
      if (late()) { res.partial = true; return res; }
      if (link.state !== "active" || link.taskId == null || localById.has(link.taskId)) continue;
      await api.deleteTask(listId, link.googleTaskId);
      await store.deleteLink(link);
      res.deletedRemote++;
    }

    if (cursor !== state.tasksUpdatedMin) await store.saveState(ctx.userId, { tasksUpdatedMin: cursor });
    return res;
  } catch (err) {
    if (err instanceof GoogleRateLimitError) { res.rateLimited = true; res.partial = true; return res; }
    throw err;
  }
}

// Reexportado para os testes.
export { notesFromGoogle, remoteDueDay, GOOGLE_TASK_SOURCE };
