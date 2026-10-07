/**
 * Filtros das Tarefas — regras PURAS (cliente + servidor, sem BD nem relógio
 * implícito). Jorge, 7 out 2026: "Nas tarefas 'as minhas tarefas' deve estar
 * filtrado por estado da reserva (quando é reserva ser parecido com os estados
 * da multipark), candidaturas de condutores, etc. Tudo que de para filtrar bem".
 *
 *  - o estado dos filtros (`TaskFilters`) e as transições (alternar um valor,
 *    limpar, normalizar o que vem guardado no aparelho ou da rede);
 *  - o que o servidor recebe (`taskFiltersForServer`): só o que está ativo;
 *  - a classificação do prazo de uma tarefa (em atraso / hoje / amanhã /
 *    esta semana / sem prazo), no calendário de Lisboa, e as janelas que o
 *    servidor usa no SQL (as MESMAS fronteiras);
 *  - o estado da reserva (os 9 estados Multipark de shared/reservasDoDia.ts,
 *    sem agrupar) só conta para tarefas ligadas a uma reserva (`bookingRef`);
 *  - os contadores por opção (cada faceta conta com as OUTRAS aplicadas).
 *
 * Facetas (combinam-se com E; dentro de uma faceta, OU): origem, estado da
 * tarefa, prioridade, prazo, estado da reserva. Fora das facetas: responsável,
 * centro de custos (cidade) e pesquisa — esses definem a base dos contadores.
 */
import { BOOKING_STATUS_COLORS, BOOKING_STATUS_LABELS, BOOKING_STATUSES, statusLabel, type BookingStatus } from "./reservasDoDia";
import { addDays, lisbonDayOf, lisbonMidnightUtcMs, utcMs } from "./lisbonDay";
import { TASK_SOURCE_MODULES, TASK_STATUSES, isTaskOverdue, mondayOfDay, type TaskSourceModule, type TaskStatus } from "./taskRules";

// ─── Valores ────────────────────────────────────────────────────────────────

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = { low: "Baixa", medium: "Média", high: "Alta", urgent: "Urgente" };

export const TASK_DUE_FILTERS = ["overdue", "today", "tomorrow", "week", "none"] as const;
export type TaskDueFilter = (typeof TASK_DUE_FILTERS)[number];
export const TASK_DUE_LABELS: Record<TaskDueFilter, string> = {
  overdue: "Em atraso", today: "Hoje", tomorrow: "Amanhã", week: "Esta semana", none: "Sem prazo",
};

/** Reserva ligada mas sem estado conhecido (ainda não sincronizada, ou estado novo da Multipark). */
export const BOOKING_STATUS_UNKNOWN = "UNKNOWN";
export const TASK_BOOKING_FILTERS = [...BOOKING_STATUSES, BOOKING_STATUS_UNKNOWN] as const;
export type TaskBookingFilter = (typeof TASK_BOOKING_FILTERS)[number];

export function bookingFilterLabel(v: TaskBookingFilter): string {
  return v === BOOKING_STATUS_UNKNOWN ? "Sem estado" : BOOKING_STATUS_LABELS[v];
}

/** Estado (texto da BD) → um dos 9 estados ou "UNKNOWN". */
export function bookingStatusKey(raw: string | null | undefined): BookingStatus | typeof BOOKING_STATUS_UNKNOWN {
  const s = String(raw ?? "").trim().toUpperCase();
  return (BOOKING_STATUSES as readonly string[]).includes(s) ? (s as BookingStatus) : BOOKING_STATUS_UNKNOWN;
}

/** Chip do estado da reserva: rótulo e cores de reservasDoDia; desconhecido → o texto em bruto, cinzento. */
export function bookingStatusChip(raw: string | null | undefined): { label: string; className: string; known: boolean } {
  const k = bookingStatusKey(raw);
  if (k !== BOOKING_STATUS_UNKNOWN) return { label: BOOKING_STATUS_LABELS[k], className: BOOKING_STATUS_COLORS[k], known: true };
  const text = String(raw ?? "").trim();
  return { label: text ? statusLabel(text) : "Sem estado", className: "bg-slate-100 text-slate-700", known: false };
}

/**
 * Reserva de uma tarefa a partir da origem: serviço extra ("svc:<reserva>:<linha>",
 * também com o sufixo "#dup<id>" das gémeas da 0325) → <reserva>. Igual ao
 * backfill SQL da 0545 (SUBSTRING_INDEX). Outras origens → null.
 */
export function taskBookingRef(sourceModule: string | null | undefined, sourceKey: string | null | undefined): string | null {
  if (sourceModule !== "service") return null;
  const m = /^svc:([^:]+):./.exec(String(sourceKey ?? ""));
  return m && m[1].length <= 128 ? m[1] : null;
}

// ─── Estado dos filtros ─────────────────────────────────────────────────────

export interface TaskFilters {
  sources: TaskSourceModule[];
  statuses: TaskStatus[];
  priorities: TaskPriority[];
  due: TaskDueFilter[];
  bookingStatuses: TaskBookingFilter[];
  /** Responsável: uma ficha, "none" (sem responsável) ou null (todos). */
  assignee: number | "none" | null;
  /** Centro de custos (cidade e descendentes); null = todos. */
  projectId: number | null;
  q: string;
}

export const TASK_FACETS = ["sources", "statuses", "priorities", "due", "bookingStatuses"] as const;
export type TaskFacet = (typeof TASK_FACETS)[number];

const FACET_VALUES: { [K in TaskFacet]: readonly TaskFilters[K][number][] } = {
  sources: TASK_SOURCE_MODULES,
  statuses: TASK_STATUSES,
  priorities: TASK_PRIORITIES,
  due: TASK_DUE_FILTERS,
  bookingStatuses: TASK_BOOKING_FILTERS,
};

export const TASK_SEARCH_MAX = 120;

export const EMPTY_TASK_FILTERS: TaskFilters = Object.freeze({
  sources: [], statuses: [], priorities: [], due: [], bookingStatuses: [], assignee: null, projectId: null, q: "",
}) as TaskFilters;

/** Só os valores conhecidos, sem repetidos, pela ordem canónica. */
function cleanFacet<K extends TaskFacet>(facet: K, raw: unknown): TaskFilters[K] {
  const want = new Set(Array.isArray(raw) ? raw.map((v) => String(v)) : []);
  return FACET_VALUES[facet].filter((v) => want.has(String(v))) as TaskFilters[K];
}

const positiveInt = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * Qualquer coisa (o que estava guardado no aparelho, numa versão antiga, ou
 * vem da rede) → filtros válidos. Valores desconhecidos caem; nunca lança.
 */
export function normalizeTaskFilters(raw: unknown): TaskFilters {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    sources: cleanFacet("sources", r.sources),
    statuses: cleanFacet("statuses", r.statuses),
    priorities: cleanFacet("priorities", r.priorities),
    due: cleanFacet("due", r.due),
    bookingStatuses: cleanFacet("bookingStatuses", r.bookingStatuses),
    assignee: r.assignee === "none" ? "none" : positiveInt(r.assignee),
    projectId: positiveInt(r.projectId),
    q: typeof r.q === "string" ? r.q.slice(0, TASK_SEARCH_MAX) : "",
  };
}

/** Chave dos filtros guardados por utilizador neste aparelho (versão no nome: um formato novo não lê o antigo à pressa). */
export function taskFiltersStorageKey(userId: number): string {
  return `mp.tasks.filters.v1.u${userId}`;
}

/** Liga/desliga um valor de uma faceta. */
export function toggleTaskFilter<K extends TaskFacet>(f: TaskFilters, facet: K, value: TaskFilters[K][number]): TaskFilters {
  const cur = f[facet] as readonly string[];
  const next = cur.includes(String(value)) ? cur.filter((v) => v !== String(value)) : [...cur, String(value)];
  return { ...f, [facet]: cleanFacet(facet, next) };
}

/** Muda campos (passa pelo normalizador: nada inválido entra). */
export function patchTaskFilters(f: TaskFilters, patch: Partial<TaskFilters>): TaskFilters {
  return normalizeTaskFilters({ ...f, ...patch });
}

/** "Limpar filtros": tudo vazio (o modo de vista e "Mostrar antigas" não são filtros). */
export function clearTaskFilters(): TaskFilters {
  return { ...EMPTY_TASK_FILTERS, sources: [], statuses: [], priorities: [], due: [], bookingStatuses: [] };
}

/** Quantos filtros estão ativos (cada valor de faceta conta 1; responsável, centro e pesquisa contam 1 cada). */
export function activeTaskFilterCount(f: TaskFilters, opts: { ignoreAssignee?: boolean } = {}): number {
  let n = 0;
  for (const k of TASK_FACETS) n += f[k].length;
  if (f.assignee != null && !opts.ignoreAssignee) n++;
  if (f.projectId != null) n++;
  if (f.q.trim()) n++;
  return n;
}

/** Facetas + pesquisa, como o servidor as recebe (`tasks.list`/`tasks.facets` → `filters`). */
export interface TaskFacetsInput {
  sources?: TaskSourceModule[];
  statuses?: TaskStatus[];
  priorities?: TaskPriority[];
  due?: TaskDueFilter[];
  bookingStatuses?: TaskBookingFilter[];
  q?: string;
}

/**
 * O que vai para o servidor: só o que está ativo (a chave da consulta não muda
 * com campos vazios). O centro de custos e o responsável seguem nos campos de
 * topo que o servidor já validava (`projectId` passa pelo filtro de cidades
 * do middleware); em "As minhas" o responsável é sempre a própria pessoa.
 */
export function taskFiltersForServer(f: TaskFilters, opts: { mine?: boolean } = {}): {
  projectId?: number; assigneeId?: number; unassigned?: true; filters?: TaskFacetsInput;
} {
  const out: { projectId?: number; assigneeId?: number; unassigned?: true; filters?: TaskFacetsInput } = {};
  if (f.projectId != null) out.projectId = f.projectId;
  if (!opts.mine && typeof f.assignee === "number") out.assigneeId = f.assignee;
  if (!opts.mine && f.assignee === "none") out.unassigned = true;
  const facets: TaskFacetsInput = {};
  for (const k of TASK_FACETS) if (f[k].length) (facets as any)[k] = [...f[k]];
  const q = f.q.trim();
  if (q) facets.q = q;
  if (Object.keys(facets).length) out.filters = facets;
  return out;
}

// ─── Prazo (calendário de Lisboa) ───────────────────────────────────────────

export interface DueWindows {
  /** Dias de Lisboa. A semana é a de calendário (segunda a domingo) de hoje. */
  today: string; tomorrow: string; weekStart: string; weekEnd: string;
}

export function dueWindows(nowMs: number): DueWindows {
  const today = lisbonDayOf(nowMs);
  const weekStart = mondayOfDay(today);
  return { today, tomorrow: addDays(today, 1), weekStart, weekEnd: addDays(weekStart, 6) };
}

export interface TaskDueRow { dueDate: string | Date | null | undefined; dueHasTime?: number | boolean | null; taskStatus?: string | null; status?: string | null }

/** Dia de Lisboa do prazo: só data → esse dia; com hora (UTC) → o dia de Lisboa desse instante. */
export function taskDueDay(t: TaskDueRow): string | null {
  if (t.dueDate == null || t.dueDate === "") return null;
  if (t.dueHasTime) {
    const ms = utcMs(t.dueDate as any);
    return Number.isFinite(ms) ? lisbonDayOf(ms) : null;
  }
  const day = typeof t.dueDate === "string" ? t.dueDate.slice(0, 10) : t.dueDate.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * Em que opções do filtro "Prazo" a tarefa entra (pode ser mais do que uma:
 * uma tarefa de hoje às 10h, às 11h, está "Em atraso" e é de "Hoje").
 */
export function taskDueBuckets(t: TaskDueRow, nowMs: number): TaskDueFilter[] {
  const day = taskDueDay(t);
  if (day == null) return ["none"];
  const w = dueWindows(nowMs);
  const out: TaskDueFilter[] = [];
  if (isTaskOverdue({ dueDate: t.dueDate, dueHasTime: t.dueHasTime, taskStatus: t.taskStatus ?? t.status ?? null }, nowMs)) out.push("overdue");
  if (day === w.today) out.push("today");
  if (day === w.tomorrow) out.push("tomorrow");
  if (day >= w.weekStart && day <= w.weekEnd) out.push("week");
  return out;
}

const mysqlUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/**
 * Janelas do SQL para cada opção de dias (as mesmas de `taskDueBuckets`):
 * tarefas só com data comparam o dia (`DATE(dueDate)`); com hora, o instante
 * UTC entre a meia-noite de Lisboa do 1.º dia e a do dia a seguir ao último.
 */
export function dueDayRanges(nowMs: number): Record<"today" | "tomorrow" | "week", { fromDay: string; toDay: string; fromUtc: string; toUtcExcl: string }> {
  const w = dueWindows(nowMs);
  const range = (fromDay: string, toDay: string) => ({
    fromDay, toDay, fromUtc: mysqlUtc(lisbonMidnightUtcMs(fromDay)), toUtcExcl: mysqlUtc(lisbonMidnightUtcMs(addDays(toDay, 1))),
  });
  return { today: range(w.today, w.today), tomorrow: range(w.tomorrow, w.tomorrow), week: range(w.weekStart, w.weekEnd) };
}

// ─── Correspondência e contadores ───────────────────────────────────────────

export interface TaskFilterRow extends TaskDueRow {
  sourceModule: string | null | undefined;
  taskPriority: string | null | undefined;
  bookingRef?: string | null;
  bookingStatus?: string | null;
}

/** Origem a filtrar: sem origem conta como "Manual". */
export const taskSourceOf = (t: { sourceModule?: string | null }): string => String(t.sourceModule ?? "").trim() || "manual";
const statusOf = (t: TaskFilterRow): string => String(t.taskStatus ?? t.status ?? "");

/** Valores de uma tarefa numa faceta (o estado da reserva só existe para tarefas ligadas a uma reserva). */
export function facetValuesOf(t: TaskFilterRow, facet: TaskFacet, nowMs: number): string[] {
  switch (facet) {
    case "sources": return [taskSourceOf(t)];
    case "statuses": return [statusOf(t)];
    case "priorities": return [String(t.taskPriority ?? "")];
    case "due": return taskDueBuckets(t, nowMs);
    case "bookingStatuses": return t.bookingRef ? [bookingStatusKey(t.bookingStatus)] : [];
  }
}

/** A tarefa passa nas facetas ativas (todas, ou todas menos `skip`)? */
export function taskMatchesFacets(t: TaskFilterRow, f: TaskFilters, nowMs: number, skip?: TaskFacet): boolean {
  for (const facet of TASK_FACETS) {
    if (facet === skip) continue;
    const want = f[facet] as readonly string[];
    if (!want.length) continue;
    if (!facetValuesOf(t, facet, nowMs).some((v) => want.includes(v))) return false;
  }
  return true;
}

export type TaskFacetCounts = { [K in TaskFacet]: Record<string, number> };

/**
 * Contadores por opção: cada faceta conta as tarefas que passam nas OUTRAS
 * facetas ativas (assim um número diz quantas aparecem se se juntar essa
 * opção). Todas as opções aparecem, com 0 quando não há.
 */
export function taskFacetCounts(rows: readonly TaskFilterRow[], f: TaskFilters, nowMs: number): TaskFacetCounts {
  const out = Object.fromEntries(TASK_FACETS.map((k) => [k, Object.fromEntries(FACET_VALUES[k].map((v) => [String(v), 0]))])) as TaskFacetCounts;
  for (const t of rows) {
    for (const facet of TASK_FACETS) {
      if (!taskMatchesFacets(t, f, nowMs, facet)) continue;
      for (const v of new Set(facetValuesOf(t, facet, nowMs))) {
        if (v in out[facet]) out[facet][v]++;
      }
    }
  }
  return out;
}
