/**
 * Google Tarefas & Calendário — regras PURAS (servidor + cliente, sem BD,
 * sem rede, sem relógio implícito). Pedido do dono (set 2026): ligar as
 * Tarefas do dashboard ao Google Tasks (nos dois sentidos, por pessoa) e o
 * Calendário ao dashboard (turnos, passagens de turno, formação, prazos,
 * SLAs, reuniões com Meet).
 *
 *  - preferências por pessoa (Perfil → Google): o que sincronizar;
 *  - Tarefas: forma normalizada de uma tarefa (título, notas sem a ligação
 *    ao dashboard, dia, concluída) dos dois lados, hash dessa forma e decisão
 *    "puxar / enviar / nada" — a última alteração ganha, com tolerância
 *    (empate → ganha o dashboard);
 *  - permissões: nunca se cria/edita no dashboard o que a pessoa não podia
 *    criar/editar na app (mesmas regras de shared/access.ts + taskRules.ts);
 *  - Calendário: eventos desejados por origem (turno, dia da cidade,
 *    passagem de turno, formação, prazo de tarefa, SLA) com propriedade
 *    privada (origem + id + versão + hash) e o plano de operações
 *    (inserir / atualizar / apagar) contra o que já está no Google —
 *    idempotente;
 *  - calendários partilhados por cidade (conta de serviço com delegação);
 *  - "ok" honesto do cron.
 */
import { z } from "zod";
import { grantFor, type AccessOverrides } from "./access";
import { canChangeTaskStatus } from "./taskRules";
import { addDays, lisbonDayOf, lisbonMidnightUtcMs } from "./lisbonDay";
import { NIGHT_START_HOUR, lisbonLocalTimeUtcMs } from "./shiftHandover";

// ─── Constantes ─────────────────────────────────────────────────────────────

/** Nome da lista (Google Tasks) e do calendário secundário de cada pessoa. */
export const GOOGLE_TASK_LIST_TITLE = "Multipark";
export const GOOGLE_CALENDAR_TITLE = "Multipark";
export const GOOGLE_CALENDAR_DESCRIPTION = "Calendário gerido pelo dashboard Multipark (turnos, formação e prazos). As alterações feitas aqui podem ser substituídas.";
export const GOOGLE_TIMEZONE = "Europe/Lisbon";
/** Empate (ms) entre alterações dos dois lados: ganha o dashboard. */
export const TASK_CONFLICT_TOLERANCE_MS = 10_000;
/** Sobreposição ao ler as alterações do Google Tasks (updatedMin). */
export const TASKS_UPDATED_MIN_OVERLAP_MS = 60_000;
/** Janela do calendário: de ontem até daqui a N dias (Lisboa). */
export const CALENDAR_WINDOW_PAST_DAYS = 1;
export const CALENDAR_WINDOW_FUTURE_DAYS = 30;
/** Concluídas há mais do que isto não vão para o Google (as já ligadas ficam). */
export const TASK_SYNC_DONE_MAX_AGE_DAYS = 30;
/** Origem das tarefas criadas no Google Tasks (taskRules: TASK_SOURCE_MODULES). */
export const GOOGLE_TASK_SOURCE = "google_tasks";

export const SHARED_CALENDAR_CITIES = ["lisbon", "porto", "faro"] as const;
export type SharedCalendarCity = (typeof SHARED_CALENDAR_CITIES)[number];
export const SHARED_CALENDAR_CITY_LABELS: Record<SharedCalendarCity, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro" };
export const sharedCalendarTitle = (city: SharedCalendarCity) => `Escala Multipark — ${SHARED_CALENDAR_CITY_LABELS[city]}`;

/** Âmbitos da conta de serviço (delegação) para os calendários partilhados. */
export const DWD_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.acls",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;

// ─── Preferências (Perfil → Google) ─────────────────────────────────────────

export const googleSyncPrefsSchema = z.object({
  /** Tarefas atribuídas ↔ lista "Multipark" do Google Tasks. */
  tasks: z.boolean().default(true),
  /** Calendário: turnos confirmados (e, para TL/supervisor, a escala da cidade + passagens de turno). */
  calShifts: z.boolean().default(true),
  /** Calendário: prazos da formação. */
  calTraining: z.boolean().default(true),
  /** Calendário: prazos das tarefas (desligado por omissão). */
  calTaskDue: z.boolean().default(false),
  /** Calendário: prazos (SLA) das reclamações atribuídas (desligado por omissão). */
  calSla: z.boolean().default(false),
});
export type GoogleSyncPrefs = z.output<typeof googleSyncPrefsSchema>;
export const DEFAULT_GOOGLE_SYNC_PREFS: GoogleSyncPrefs = googleSyncPrefsSchema.parse({});

/** Lê as preferências guardadas (JSON) com omissões seguras. PURA. */
export function parseGoogleSyncPrefs(raw: unknown): GoogleSyncPrefs {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { v = {}; } }
  const r = googleSyncPrefsSchema.safeParse(v && typeof v === "object" ? v : {});
  return r.success ? r.data : DEFAULT_GOOGLE_SYNC_PREFS;
}

export const anyCalendarPref = (p: GoogleSyncPrefs) => p.calShifts || p.calTraining || p.calTaskDue || p.calSla;

// ─── Calendários partilhados (Definições → Comunicação) ─────────────────────

export const sharedCalendarsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Conta do Workspace dona dos calendários (impersonada pela conta de serviço). */
  ownerEmail: z.union([z.literal(""), z.string().trim().toLowerCase().email("Email inválido.")]).default(""),
  cities: z.object({ lisbon: z.boolean(), porto: z.boolean(), faro: z.boolean() }).default({ lisbon: true, porto: true, faro: true }),
  /** Partilha de leitura com todo o domínio do Workspace (para subscrever). */
  shareWithDomain: z.boolean().default(true),
}).superRefine((v, ctx) => {
  if (v.enabled && !v.ownerEmail) ctx.addIssue({ code: "custom", message: "Indica a conta do Workspace dona dos calendários partilhados." });
});
export type SharedCalendarsConfig = z.output<typeof sharedCalendarsConfigSchema>;
export const DEFAULT_SHARED_CALENDARS_CONFIG: SharedCalendarsConfig = sharedCalendarsConfigSchema.parse({});

export function parseSharedCalendarsConfig(raw: unknown): SharedCalendarsConfig {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { v = {}; } }
  const r = sharedCalendarsConfigSchema.safeParse(v && typeof v === "object" ? v : {});
  return r.success ? r.data : DEFAULT_SHARED_CALENDARS_CONFIG;
}

// ─── Utilitários ────────────────────────────────────────────────────────────

/** FNV-1a 64 bits (dois ramos de 32) → 16 hex. Deteção de mudanças, não segurança. PURA. */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** "YYYY-MM-DD HH:MM:SS" (UTC, MySQL) ou ISO → ms; null se inválido. PURA. */
export function sqlUtcMs(v: string | Date | null | undefined): number | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  const s = String(v).trim();
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export const toSqlUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** Link absoluto para o dashboard. PURA. */
export function dashboardUrl(appUrl: string, path: string): string {
  return `${appUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

// ─── Tarefas: forma normalizada dos dois lados ──────────────────────────────

export interface LocalTaskLike {
  id: number;
  title: string;
  description: string | null;
  dueDate: string | null;
  dueHasTime?: number | boolean | null;
  taskStatus: string;
  updatedAt: string | null;
  projectId: number | null;
  createdById?: number | null;
  assigneeId: number | null;
  assigneeIds: number[];
}

export interface RemoteTaskLike {
  id?: string | null;
  etag?: string | null;
  title?: string | null;
  notes?: string | null;
  due?: string | null;
  status?: string | null;
  completed?: string | null;
  deleted?: boolean | null;
  updated?: string | null;
}

export interface NormTask { title: string; notes: string; day: string | null; done: boolean }

const LINK_LINE = /^\s*Abrir no dashboard:\s*\S+\s*$/gim;
const FOCUS_RE = /Abrir no dashboard:\s*\S*[?&]focus=(\d+)/i;

/** Linha com a ligação de volta ao dashboard (vai no fim das notas). PURA. */
export function taskLinkLine(appUrl: string, taskId: number): string {
  return `Abrir no dashboard: ${dashboardUrl(appUrl, `/tarefas?focus=${taskId}`)}`;
}

/** Notas do Google sem a linha da ligação ao dashboard. PURA. */
export function notesFromGoogle(notes: string | null | undefined): string {
  return String(notes ?? "").replace(LINK_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Id da tarefa do dashboard escrito nas notas (para reencontrar ligações perdidas). PURA. */
export function taskIdFromNotes(notes: string | null | undefined): number | null {
  const m = FOCUS_RE.exec(String(notes ?? ""));
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Dia (Lisboa) do prazo de uma tarefa local. PURA. */
export function localDueDay(t: Pick<LocalTaskLike, "dueDate" | "dueHasTime">): string | null {
  if (!t.dueDate) return null;
  const s = String(t.dueDate);
  if (t.dueHasTime) {
    const ms = sqlUtcMs(s);
    return ms == null ? null : lisbonDayOf(ms);
  }
  const d = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/** Dia do `due` do Google Tasks (só a data conta — a hora é descartada pela Google). PURA. */
export function remoteDueDay(due: string | null | undefined): string | null {
  const d = String(due ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

export function normLocal(t: LocalTaskLike): NormTask {
  return { title: t.title.trim().slice(0, 256), notes: String(t.description ?? "").trim().slice(0, 7000), day: localDueDay(t), done: t.taskStatus === "done" };
}

export function normRemote(r: RemoteTaskLike): NormTask {
  return { title: String(r.title ?? "").trim().slice(0, 256), notes: notesFromGoogle(r.notes).slice(0, 7000), day: remoteDueDay(r.due), done: r.status === "completed" };
}

export const normHash = (n: NormTask) => stableHash(JSON.stringify([n.title, n.notes, n.day, n.done]));

/** Corpo do Google Tasks a partir da tarefa local (título, notas + ligação, dia, estado). PURA. */
export function taskToGoogle(t: LocalTaskLike, appUrl: string, nowMs: number): { title: string; notes: string; due: string | null; status: "completed" | "needsAction"; completed: string | null } {
  const n = normLocal(t);
  const link = taskLinkLine(appUrl, t.id);
  const notes = (n.notes ? `${n.notes}\n\n${link}` : link).slice(0, 8192);
  return {
    title: n.title || "(sem título)",
    notes,
    due: n.day ? `${n.day}T00:00:00.000Z` : null,
    status: n.done ? "completed" : "needsAction",
    completed: n.done ? new Date(nowMs).toISOString() : null,
  };
}

export type TaskSyncDecision = "none" | "push" | "pull";

/**
 * O que fazer com uma tarefa ligada. `syncedHash` = forma acordada na última
 * sincronização. Só um lado mudou → esse ganha; os dois mudaram → ganha a
 * alteração mais recente, com tolerância (empate → o dashboard). PURA.
 */
export function decideTaskSync(i: {
  local: NormTask; remote: NormTask; syncedHash: string | null;
  localUpdatedMs: number | null; remoteUpdatedMs: number | null; toleranceMs?: number;
}): TaskSyncDecision {
  const lh = normHash(i.local);
  const rh = normHash(i.remote);
  if (lh === rh) return "none";
  const localChanged = i.syncedHash == null || lh !== i.syncedHash;
  const remoteChanged = i.syncedHash == null || rh !== i.syncedHash;
  if (localChanged && !remoteChanged) return "push";
  if (remoteChanged && !localChanged) return "pull";
  const tol = i.toleranceMs ?? TASK_CONFLICT_TOLERANCE_MS;
  const l = i.localUpdatedMs ?? 0;
  const r = i.remoteUpdatedMs ?? 0;
  return r - l > tol ? "pull" : "push";
}

// ─── Tarefas: permissões (as mesmas da app) ─────────────────────────────────

export interface TaskSyncUser { id: number; role: string; accessOverrides?: AccessOverrides | null; employeeId: number | null }

export interface TaskSyncPermissions {
  /** Criar tarefas no dashboard (mesma regra do tasks.create: "tarefas" edit, alcance além do próprio). */
  canCreate: boolean;
  /** Editar título/notas/prazo desta tarefa (tasks.update). */
  canEditContent(t: Pick<LocalTaskLike, "projectId" | "assigneeId" | "assigneeIds">): boolean;
  /** Mudar o estado (tasks.setStatus: editores ou o próprio responsável). */
  canChangeStatus(t: Pick<LocalTaskLike, "projectId" | "assigneeId" | "assigneeIds">): boolean;
}

/**
 * Permissões da pessoa sobre as tarefas vindas do Google. `inScope` diz se o
 * projeto da tarefa está nas cidades autorizadas (sem projeto = transversal).
 * team_leader (alcance "below_city") só edita o conteúdo das tarefas que são
 * só suas (a app exige que todos os responsáveis sejam da equipa). PURA.
 */
export function taskSyncPermissions(u: TaskSyncUser, inScope: (projectId: number | null) => boolean): TaskSyncPermissions {
  const g = grantFor({ role: u.role, accessOverrides: u.accessOverrides ?? undefined } as any, "tarefas");
  const canCreate = g.access !== "none" && g.access !== "own" && g.actions.includes("edit");
  return {
    canCreate,
    canEditContent(t) {
      if (!canCreate || !inScope(t.projectId)) return false;
      if (g.access !== "below_city") return true;
      const ids = new Set([...(t.assigneeIds ?? []), ...(t.assigneeId != null ? [t.assigneeId] : [])]);
      return u.employeeId != null && ids.size > 0 && Array.from(ids).every((x) => x === u.employeeId);
    },
    canChangeStatus(t) {
      if (!inScope(t.projectId)) return false;
      if (canCreate) return true;
      return g.access !== "none" && g.actions.includes("edit") && canChangeTaskStatus({ role: u.role, employeeId: u.employeeId }, { assigneeId: t.assigneeId, assigneeIds: t.assigneeIds });
    },
  };
}

export interface TaskPullPatch {
  title?: string;
  description?: string | null;
  /** Só data: "YYYY-MM-DD 00:00:00" ou null. */
  dueDate?: string | null;
  taskStatus?: "done" | "todo";
}

/**
 * Campos a gravar no dashboard a partir do Google, só os que a pessoa pode
 * mudar (o resto volta a ser enviado → o Google fica igual ao dashboard). PURA.
 */
export function pullPatch(local: LocalTaskLike, remote: NormTask, perms: TaskSyncPermissions): TaskPullPatch {
  const cur = normLocal(local);
  const out: TaskPullPatch = {};
  if (perms.canEditContent(local)) {
    if (remote.title && remote.title !== cur.title) out.title = remote.title;
    if (remote.notes !== cur.notes) out.description = remote.notes || null;
    if (remote.day !== cur.day) out.dueDate = remote.day ? `${remote.day} 00:00:00` : null;
  }
  if (remote.done !== cur.done && perms.canChangeStatus(local)) out.taskStatus = remote.done ? "done" : "todo";
  return out;
}

// ─── Calendário: eventos desejados ──────────────────────────────────────────

export type CalendarSourceType = "shift" | "cityday" | "handover" | "training" | "taskdue" | "sla";

export const CALENDAR_SOURCE_LABELS: Record<CalendarSourceType, string> = {
  shift: "Turno", cityday: "Escala da cidade", handover: "Passagem de turno", training: "Formação", taskdue: "Prazo de tarefa", sla: "Prazo (SLA)",
};

export interface EventTime { dateTime?: string; date?: string; timeZone?: string }

export interface DesiredEvent {
  /** "<tipo>:<id>" — única por calendário. */
  key: string;
  sourceType: CalendarSourceType;
  sourceId: string;
  /** Versão da origem (ex.: versão da linha da escala) — vai na propriedade privada. */
  version: string;
  summary: string;
  description: string;
  location?: string | null;
  start: EventTime;
  end: EventTime;
  /** Início (ms) — só apaga eventos a partir do início da janela (o passado fica). */
  startMs: number;
  link: string;
  transparent?: boolean;
  colorId?: string | null;
}

/** Hash do conteúdo visível do evento (muda → atualiza). PURA. */
export function eventHash(e: Omit<DesiredEvent, "startMs">): string {
  return stableHash(JSON.stringify([e.summary, e.description, e.location ?? "", e.start, e.end, e.transparent ? 1 : 0, e.colorId ?? "", e.link]));
}

/** Id determinístico do evento (base32hex: 0-9a-v; hex serve) → inserir duas vezes dá 409, nunca duplica. PURA. */
export function calendarEventId(target: string, key: string): string {
  return `mp${stableHash(`${target}|${key}`)}${stableHash(`${key}|${target}|v1`)}`;
}

/** Corpo para a API do Calendar (propriedade privada = origem + id + versão + hash). PURA. */
export function eventBody(e: DesiredEvent) {
  const hash = eventHash(e);
  return {
    summary: e.summary.slice(0, 250),
    description: `${e.description}\n\nAbrir no dashboard: ${e.link}`.trim().slice(0, 8000),
    ...(e.location ? { location: e.location.slice(0, 250) } : {}),
    start: e.start,
    end: e.end,
    transparency: e.transparent ? "transparent" : "opaque",
    ...(e.colorId ? { colorId: e.colorId } : {}),
    source: { title: "Dashboard Multipark", url: e.link },
    reminders: { useDefault: true },
    extendedProperties: { private: { mpKey: e.key, mpSource: e.sourceType, mpId: e.sourceId, mpVersion: e.version, mpHash: hash } },
    status: "confirmed",
  };
}

const hh = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, "0")}h`;
const timed = (ms: number): EventTime => ({ dateTime: new Date(ms).toISOString(), timeZone: GOOGLE_TIMEZONE });

export interface ShiftRow { id: number; assignmentDate: string; city: string; startHour: number; endHour: number; sentHomeHour?: number | null; isTeamLeader: number | boolean; version: number; personName?: string | null; shift?: string | null }

const cityLabel = (c: string) => SHARED_CALENDAR_CITY_LABELS[c as SharedCalendarCity] ?? c;

/** Turno confirmado de uma pessoa. PURA. */
export function shiftEvent(r: ShiftRow, appUrl: string): DesiredEvent {
  const end = r.sentHomeHour != null && r.sentHomeHour > r.startHour && r.sentHomeHour < r.endHour ? r.sentHomeHour : r.endHour;
  const startMs = lisbonLocalTimeUtcMs(r.assignmentDate, r.startHour);
  const endMs = lisbonLocalTimeUtcMs(r.assignmentDate, Math.max(end, r.startHour + 1));
  const tl = !!Number(r.isTeamLeader);
  return {
    key: `shift:${r.id}`, sourceType: "shift", sourceId: String(r.id), version: String(r.version),
    summary: `${tl ? "Team leader" : "Turno"} Multipark — ${cityLabel(r.city)} (${hh(r.startHour)}–${hh(end)})`,
    description: `Turno confirmado na escala de ${cityLabel(r.city)}, ${r.assignmentDate}, das ${hh(r.startHour)} às ${hh(end)}.`,
    start: timed(startMs), end: timed(endMs), startMs, link: dashboardUrl(appUrl, `/extras-dia?date=${r.assignmentDate}`),
  };
}

/** Escala do dia de uma cidade (para o TL/supervisor dessa cidade): 1 evento por dia. PURA. */
export function cityDayEvent(date: string, city: string, rows: readonly ShiftRow[], appUrl: string): DesiredEvent | null {
  const list = rows.filter((r) => r.assignmentDate === date && r.city === city).slice().sort((a, b) => a.startHour - b.startHour || String(a.personName ?? "").localeCompare(String(b.personName ?? "")));
  if (!list.length) return null;
  const start = Math.min(...list.map((r) => r.startHour));
  const end = Math.max(...list.map((r) => r.endHour));
  const startMs = lisbonLocalTimeUtcMs(date, start);
  const lines = list.map((r) => `• ${r.personName ?? "?"}${Number(r.isTeamLeader) ? " (TL)" : ""} — ${hh(r.startHour)}–${hh(r.endHour)}`);
  return {
    key: `cityday:${city}:${date}`, sourceType: "cityday", sourceId: `${city}:${date}`,
    version: stableHash(list.map((r) => `${r.id}.${r.version}`).join(",")),
    summary: `Escala ${cityLabel(city)} — ${list.length} pessoa${list.length === 1 ? "" : "s"}`,
    description: `Escala confirmada de ${cityLabel(city)} (${date}):\n${lines.join("\n")}`,
    start: timed(startMs), end: timed(lisbonLocalTimeUtcMs(date, Math.max(end, start + 1))), startMs,
    link: dashboardUrl(appUrl, `/extras-dia?date=${date}`), transparent: true,
  };
}

/** Passagem de turno (manhã → noite, às 15h) para o TL escalado nesse dia. PURA. */
export function handoverEvent(date: string, city: string, appUrl: string): DesiredEvent {
  const startMs = lisbonLocalTimeUtcMs(date, NIGHT_START_HOUR);
  return {
    key: `handover:${city}:${date}`, sourceType: "handover", sourceId: `${city}:${date}`, version: "1",
    summary: `Passagem de turno — ${cityLabel(city)}`,
    description: `Passagem de turno manhã → noite em ${cityLabel(city)} (${date}). Preenche e confirma a passagem no dashboard.`,
    start: timed(startMs), end: timed(startMs + 30 * 60_000), startMs,
    link: dashboardUrl(appUrl, `/passagem-turno?date=${date}&city=${city}`),
  };
}

/** Dia inteiro (prazo) — `end` é exclusivo no Google. PURA. */
function allDay(day: string): { start: EventTime; end: EventTime; startMs: number } {
  return { start: { date: day }, end: { date: addDays(day, 1) }, startMs: lisbonMidnightUtcMs(day) };
}

export function trainingEvent(r: { id: number; dueAt: string; pathName: string }, appUrl: string): DesiredEvent | null {
  const ms = sqlUtcMs(r.dueAt);
  if (ms == null) return null;
  const day = lisbonDayOf(ms);
  return {
    key: `training:${r.id}`, sourceType: "training", sourceId: String(r.id), version: stableHash(String(r.dueAt)),
    summary: `Prazo da formação: ${r.pathName}`.slice(0, 250),
    description: `A formação "${r.pathName}" tem de estar concluída até ${day}.`,
    ...allDay(day), link: dashboardUrl(appUrl, "/formacao"), transparent: true,
  };
}

export function taskDueEvent(t: { id: number; title: string; dueDate: string; dueHasTime?: number | boolean | null }, appUrl: string): DesiredEvent | null {
  const link = dashboardUrl(appUrl, `/tarefas?focus=${t.id}`);
  const base = { key: `taskdue:${t.id}`, sourceType: "taskdue" as const, sourceId: String(t.id), version: stableHash(`${t.dueDate}|${t.dueHasTime ? 1 : 0}`),
    summary: `Prazo: ${t.title}`.slice(0, 250), description: `Prazo da tarefa "${t.title}".`, link, transparent: true };
  if (t.dueHasTime) {
    const ms = sqlUtcMs(t.dueDate);
    if (ms == null) return null;
    return { ...base, start: timed(ms - 30 * 60_000), end: timed(ms), startMs: ms - 30 * 60_000 };
  }
  const day = String(t.dueDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return { ...base, ...allDay(day) };
}

export function slaEvent(c: { id: number; title: string; slaDeadline: string }, appUrl: string): DesiredEvent | null {
  const ms = sqlUtcMs(c.slaDeadline);
  if (ms == null) return null;
  return {
    key: `sla:complaint:${c.id}`, sourceType: "sla", sourceId: `complaint:${c.id}`, version: stableHash(String(c.slaDeadline)),
    summary: `SLA reclamação #${c.id}: ${c.title}`.slice(0, 250),
    description: `Prazo (SLA) da reclamação #${c.id} "${c.title}".`,
    start: timed(ms - 30 * 60_000), end: timed(ms), startMs: ms - 30 * 60_000,
    link: dashboardUrl(appUrl, `/reclamacoes?id=${c.id}`), transparent: true, colorId: "11",
  };
}

/** Turno de uma pessoa no calendário partilhado da cidade. PURA. */
export function sharedShiftEvent(r: ShiftRow, appUrl: string): DesiredEvent {
  const e = shiftEvent(r, appUrl);
  const end = r.sentHomeHour != null && r.sentHomeHour > r.startHour && r.sentHomeHour < r.endHour ? r.sentHomeHour : r.endHour;
  return { ...e, summary: `${r.personName ?? "?"}${Number(r.isTeamLeader) ? " (TL)" : ""} · ${hh(r.startHour)}–${hh(end)}`, transparent: true };
}

/** Janela [início, fim] (dias de Lisboa) do calendário. PURA. */
export function calendarWindow(nowMs: number): { fromDay: string; toDay: string; fromMs: number } {
  const today = lisbonDayOf(nowMs);
  const fromDay = addDays(today, -CALENDAR_WINDOW_PAST_DAYS);
  return { fromDay, toDay: addDays(today, CALENDAR_WINDOW_FUTURE_DAYS), fromMs: lisbonMidnightUtcMs(fromDay) };
}

// ─── Calendário: plano de operações ─────────────────────────────────────────

export interface CalendarMapping {
  key: string;
  eventId: string;
  version: string | null;
  hash: string | null;
  startMs: number | null;
  /** Apagado pela pessoa no Google (não se recria enquanto a origem não mudar). */
  remoteDeleted?: boolean;
}

export interface CalendarPlan {
  insert: DesiredEvent[];
  patch: Array<{ desired: DesiredEvent; eventId: string }>;
  delete: CalendarMapping[];
  /** Ligações a esquecer sem chamar a API (apagadas no Google e já sem origem). */
  forget: CalendarMapping[];
}

/**
 * Plano idempotente: o que falta → inserir; mudou (versão/hash) ou foi
 * apagado e a origem mudou → atualizar; já não existe na origem e começa na
 * janela → apagar (o passado nunca se apaga). Correr duas vezes seguidas dá
 * um plano vazio. PURA.
 */
export function planCalendarOps(desired: readonly DesiredEvent[], mappings: readonly CalendarMapping[], windowFromMs: number): CalendarPlan {
  const byKey = new Map(mappings.map((m) => [m.key, m]));
  const plan: CalendarPlan = { insert: [], patch: [], delete: [], forget: [] };
  const wanted = new Set<string>();
  for (const d of desired) {
    if (wanted.has(d.key)) continue;
    wanted.add(d.key);
    const m = byKey.get(d.key);
    if (!m) { plan.insert.push(d); continue; }
    const hash = eventHash(d);
    const same = m.version === d.version && m.hash === hash;
    if (same) continue; // igual (ou apagado pela pessoa e a origem não mudou)
    plan.patch.push({ desired: d, eventId: m.eventId });
  }
  for (const m of mappings) {
    if (wanted.has(m.key)) continue;
    if (m.startMs != null && m.startMs < windowFromMs) continue;
    if (m.remoteDeleted) plan.forget.push(m);
    else plan.delete.push(m);
  }
  return plan;
}

/** Ligação a partir de um evento lido do Google (propriedade privada). PURA. */
export function mappingFromEvent(e: { id?: string | null; status?: string | null; start?: { dateTime?: string | null; date?: string | null } | null; extendedProperties?: { private?: Record<string, string> | null } | null }): CalendarMapping | null {
  const p = e.extendedProperties?.private ?? null;
  const key = p?.mpKey;
  if (!key || !e.id) return null;
  const s = e.start?.dateTime ? Date.parse(e.start.dateTime) : e.start?.date ? lisbonMidnightUtcMs(e.start.date) : NaN;
  return { key, eventId: e.id, version: p?.mpVersion ?? null, hash: p?.mpHash ?? null, startMs: Number.isFinite(s) ? s : null, remoteDeleted: e.status === "cancelled" };
}

// ─── Disponibilidade (livre/ocupado) ────────────────────────────────────────

export interface BusyBlock { start: string; end: string }

/**
 * Blocos ocupados por dia de Lisboa ("HH:MM"), cortados à meia-noite; nunca
 * mostra o conteúdo dos eventos, só as horas. PURA.
 */
export function busyByDay(busy: readonly { start?: string | null; end?: string | null }[], days: readonly string[]): Record<string, BusyBlock[]> {
  const out: Record<string, BusyBlock[]> = Object.fromEntries(days.map((d) => [d, [] as BusyBlock[]]));
  const fmt = (ms: number) => new Intl.DateTimeFormat("pt-PT", { timeZone: GOOGLE_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  for (const b of busy) {
    const s = Date.parse(String(b.start ?? ""));
    const e = Date.parse(String(b.end ?? ""));
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    for (const d of days) {
      const ds = lisbonMidnightUtcMs(d);
      const de = lisbonMidnightUtcMs(addDays(d, 1));
      const a = Math.max(s, ds);
      const z = Math.min(e, de);
      if (z <= a) continue;
      out[d].push({ start: fmt(a), end: z >= de ? "24:00" : fmt(z) });
    }
  }
  return out;
}

// ─── Cron: "ok" honesto ─────────────────────────────────────────────────────

export interface GoogleSyncUserOutcome {
  userId: number;
  status: "ok" | "partial" | "skipped" | "reauth_required" | "scope_missing" | "rate_limited" | "error";
  error?: string;
}

/**
 * O cron falha (ok:false) quando: um calendário partilhado falhou, ou pelo
 * menos metade das pessoas tentadas deu erro "a sério" (ex.: API desligada
 * no Google Cloud) — um erro isolado entre muitas fica como aviso. Contas por religar, âmbitos em falta e limites
 * de pedidos são avisos (a própria pessoa é avisada / repete na próxima). PURA.
 */
export function googleSyncCronOk(r: { users: readonly GoogleSyncUserOutcome[]; sharedErrors: readonly string[]; fatal?: string | null }): boolean {
  if (r.fatal) return false;
  if (r.sharedErrors.length) return false;
  const tried = r.users.filter((u) => u.status !== "skipped");
  const hard = tried.filter((u) => u.status === "error").length;
  return !(hard >= 1 && hard * 2 >= tried.length);
}

// ─── Reuniões (Meet) ────────────────────────────────────────────────────────

export const MEETING_ENTITY_TYPES = ["client", "complaint", "partnership"] as const;
export type MeetingEntityType = (typeof MEETING_ENTITY_TYPES)[number];

export const createMeetingSchema = z.object({
  entityType: z.enum(MEETING_ENTITY_TYPES),
  entityId: z.string().trim().min(1).max(320),
  title: z.string().trim().min(1, "Indica o título.").max(200),
  /** "YYYY-MM-DDTHH:MM" (hora de Lisboa). */
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Data/hora inválida."),
  durationMin: z.number().int().min(15).max(480).default(30),
  inviteClient: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
});
export type CreateMeetingInput = z.output<typeof createMeetingSchema>;

/** "2026-10-01T14:30" (Lisboa) → ms UTC. PURA. */
export function lisbonLocalToUtcMs(local: string): number {
  const [day, time] = local.split("T");
  const [h, m] = time.split(":").map(Number);
  return lisbonLocalTimeUtcMs(day, h) + m * 60_000;
}

/** Corpo do evento com Meet (conferenceData) no calendário principal. PURA. */
export function meetingEventBody(i: { title: string; startMs: number; durationMin: number; description: string; attendeeEmail: string | null; requestId: string; link: string; entityKey: string }) {
  return {
    summary: i.title,
    description: `${i.description}\n\nAbrir no dashboard: ${i.link}`.trim().slice(0, 8000),
    start: timed(i.startMs),
    end: timed(i.startMs + i.durationMin * 60_000),
    ...(i.attendeeEmail ? { attendees: [{ email: i.attendeeEmail }] } : {}),
    conferenceData: { createRequest: { requestId: i.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } },
    source: { title: "Dashboard Multipark", url: i.link },
    extendedProperties: { private: { mpKey: `meeting:${i.entityKey}:${i.requestId}`, mpSource: "meeting", mpId: i.entityKey, mpVersion: "1" } },
    reminders: { useDefault: true },
  };
}

/** Link do Meet de um evento criado (hangoutLink ou o ponto de entrada de vídeo). PURA. */
export function meetLinkOf(e: { hangoutLink?: string | null; conferenceData?: { entryPoints?: Array<{ entryPointType?: string | null; uri?: string | null }> | null } | null }): string | null {
  if (e.hangoutLink) return e.hangoutLink;
  const v = (e.conferenceData?.entryPoints ?? []).find((p) => p.entryPointType === "video" && p.uri);
  return v?.uri ?? null;
}
