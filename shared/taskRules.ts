import { can, seesBeyondOwn } from "./access";
/**
 * Tarefas — regras PURAS (cliente + servidor, sem BD nem relógio implícito).
 *
 *  - prazo = FIM do dia de Lisboa da data limite (ou a hora exata quando a
 *    tarefa tem hora — `dueHasTime`, p.ex. checklists recorrentes);
 *  - permissões: frontoffice+ edita; qualquer responsável muda o ESTADO das
 *    suas próprias tarefas (extras incluídos);
 *  - chave de deduplicação das tarefas de disponibilidade (pessoa × semana);
 *  - geração das checklists recorrentes (modelo × dia × turno, idempotente);
 *  - gestores da hierarquia de projetos (carregados 1× por corrida).
 */
import { addDays, lisbonDayOf, lisbonMidnightUtcMs, utcMs } from "./lisbonDay";
import { NIGHT_START_HOUR, OPERATIONAL_DAY_START_HOUR, lisbonLocalTimeUtcMs } from "./shiftHandover";

export const TASK_STATUSES = ["backlog", "todo", "in_progress", "review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** "backlog" mantém-se na BD; em PT-PT mostra-se "Por planear". */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Por planear", todo: "A fazer", in_progress: "Em curso", review: "Revisão", done: "Concluída",
};

/** Tarefas concluídas há mais do que isto ficam escondidas por omissão ("Mostrar antigas"). */
export const TASK_HIDE_DONE_AFTER_DAYS = 30;

// ─── Prazo (Europe/Lisbon) ──────────────────────────────────────────────────

export interface TaskDueLike { dueDate: string | Date | null | undefined; dueHasTime?: number | boolean | null }

const dayPart = (v: string | Date): string =>
  typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10);

/**
 * Instante (ms) a partir do qual a tarefa está em atraso.
 * Só data ("YYYY-MM-DD 00:00:00") → meia-noite de Lisboa do dia SEGUINTE
 * (a tarefa vale o dia inteiro). Com hora → o próprio instante (UTC).
 */
export function taskDeadlineMs(t: TaskDueLike): number | null {
  if (t.dueDate == null || t.dueDate === "") return null;
  if (t.dueHasTime) {
    const ms = utcMs(t.dueDate as any);
    return Number.isFinite(ms) ? ms : null;
  }
  const day = dayPart(t.dueDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return lisbonMidnightUtcMs(addDays(day, 1));
}

export function isTaskOverdue(t: TaskDueLike & { taskStatus?: string | null; status?: string | null }, nowMs: number): boolean {
  const status = t.taskStatus ?? t.status;
  if (status === "done") return false;
  const d = taskDeadlineMs(t);
  return d != null && nowMs >= d;
}

/** "YYYY-MM-DD" (input date) → valor da coluna (só data, sem fuso). */
export function dueDateFromDay(day: string | null | undefined): string | null {
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day} 00:00:00` : null;
}

// ─── Permissões ─────────────────────────────────────────────────────────────

// Modelo de acessos (shared/access.ts): quem tem Tarefas para além das suas
// (team_leader para a equipa, supervisor/front/backoffice/admin) cria, edita
// e apaga; extra/condutor só mudam o estado das suas.
/** Criar / editar / apagar / arrastar. */
export function canEditTasks(role: string | null | undefined): boolean {
  return seesBeyondOwn(role, "tarefas") && can(role, "tarefas", "edit");
}

// ─── Filtro "centro de custos" (/tarefas) ───────────────────────────────────
// O texto antigo "Todos (grupo / cidade / marca / projeto)" não cabia no
// seletor (cortado no computador e no telemóvel). O botão mostra o rótulo
// curto; a explicação completa fica na opção e na dica (title).
export const COST_CENTRE_ALL_LABEL = "Todos os centros";
export const COST_CENTRE_ALL_HINT = "Todos os centros de custos (grupo, cidade, marca e projeto)";
/** Máximo de caracteres que o botão do filtro mostra sem cortar (largura w-56). */
export const COST_CENTRE_TRIGGER_MAX_CHARS = 24;

/** Texto do botão do filtro para o valor escolhido (nomes longos encurtados com "…"). PURA. */
export function costCentreTriggerLabel(value: string, projects: ReadonlyArray<{ id: number; name: string }>): string {
  if (value === "all" || !value) return COST_CENTRE_ALL_LABEL;
  const name = projects.find((p) => String(p.id) === value)?.name ?? COST_CENTRE_ALL_LABEL;
  return name.length > COST_CENTRE_TRIGGER_MAX_CHARS ? `${name.slice(0, COST_CENTRE_TRIGGER_MAX_CHARS - 1)}…` : name;
}

export interface TaskAssignLike { assigneeId: number | null; assigneeIds?: number[] | null }

export function isTaskAssignee(employeeId: number | null | undefined, t: TaskAssignLike): boolean {
  if (employeeId == null) return false;
  return t.assigneeId === employeeId || (t.assigneeIds ?? []).includes(employeeId);
}

/** Mudar o ESTADO: editores, ou qualquer responsável (extra incluído) na sua própria tarefa. */
export function canChangeTaskStatus(viewer: { role: string; employeeId: number | null }, t: TaskAssignLike): boolean {
  if (canEditTasks(viewer.role)) return true;
  return can(viewer.role, "tarefas", "edit") && isTaskAssignee(viewer.employeeId, t);
}

// ─── Atualização (efeitos colaterais do estado / prazo) ─────────────────────

/**
 * Campos extra a gravar numa atualização:
 *  - passa a "done" → completedAt = agora e notifiedComplete = 0 (alerta ao criador);
 *  - reabre (sai de "done") → completedAt = NULL e notifiedComplete = 0;
 *  - data limite muda → notifiedOverdue = 0 (volta a avisar no novo prazo).
 */
export function taskUpdateSideEffects(
  prev: { taskStatus: string; dueDate: string | null; dueHasTime?: number | boolean | null },
  next: { taskStatus?: string; dueDate?: string | null },
  nowMysql: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (next.taskStatus !== undefined && next.taskStatus !== prev.taskStatus) {
    if (next.taskStatus === "done") { out.completedAt = nowMysql; out.notifiedComplete = 0; }
    else if (prev.taskStatus === "done") { out.completedAt = null; out.notifiedComplete = 0; }
  }
  if (next.dueDate !== undefined && (next.dueDate ?? null) !== (prev.dueDate ?? null)) {
    out.notifiedOverdue = 0;
    out.dueHasTime = 0;
  }
  return out;
}

// ─── Origem (link para o registo) ───────────────────────────────────────────

export const TASK_SOURCE_MODULES = ["manual", "availability", "complaint", "incident", "lost_found", "template", "google_tasks"] as const;
export type TaskSourceModule = (typeof TASK_SOURCE_MODULES)[number];
export const TASK_SOURCE_LABELS: Record<TaskSourceModule, string> = {
  manual: "Manual", availability: "Disponibilidade", complaint: "Reclamação", incident: "Ocorrência", lost_found: "Perdidos e achados", template: "Checklist", google_tasks: "Google Tarefas",
};

/** Link da origem (null quando não há página própria). */
export function taskSourceLink(module: string | null | undefined, id: number | null | undefined, key?: string | null): string | null {
  if (!module || module === "manual" || module === "template" || module === "google_tasks") return null;
  switch (module) {
    case "availability": {
      const week = key?.split(":")[2];
      return `/extras-dia${week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? `?date=${week}` : ""}`;
    }
    case "complaint": return id ? `/reclamacoes?id=${id}` : "/reclamacoes";
    case "incident": return "/ocorrencias";
    case "lost_found": return "/perdidos-achados";
    default: return null;
  }
}

/** Estados da origem que fecham automaticamente a tarefa ligada. */
export const SOURCE_RESOLVED_STATUSES: Record<"complaint" | "incident" | "lost_found", readonly string[]> = {
  complaint: ["resolved", "closed"],
  incident: ["resolved", "dismissed"],
  lost_found: ["returned", "closed"],
};

// ─── Disponibilidade a confirmar (1 tarefa por pessoa × semana) ─────────────

/** Segunda-feira (YYYY-MM-DD) da semana de `day` (aritmética de calendário). */
export function mondayOfDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}

export function availabilityTaskKey(employeeId: number, weekStartOrDay: string): string {
  return `availability:${employeeId}:${mondayOfDay(weekStartOrDay.slice(0, 10))}`;
}

export function availabilityTaskTitle(name: string | null | undefined): string {
  return `Disponibilidade a confirmar: ${(name ?? "").trim() || "sem nome"}`.slice(0, 256);
}

/** Destinatário configurável (AVAILABILITY_TASK_ASSIGNEE_EMAIL); fallback = RH histórico. */
export const DEFAULT_AVAILABILITY_TASK_ASSIGNEE_EMAIL = "kamilafagundes@multipark.pt";
export function availabilityTaskAssigneeEmail(env: Record<string, string | undefined>): string {
  const v = (env.AVAILABILITY_TASK_ASSIGNEE_EMAIL ?? "").trim();
  return v || DEFAULT_AVAILABILITY_TASK_ASSIGNEE_EMAIL;
}

// ─── Checklists recorrentes (modelos) ───────────────────────────────────────

export const TEMPLATE_SHIFTS = ["manha", "noite", "any"] as const;
export type TemplateShift = (typeof TEMPLATE_SHIFTS)[number];
export const TEMPLATE_SHIFT_LABELS: Record<TemplateShift, string> = { manha: "Manhã", noite: "Noite", any: "Dia todo" };
/** Máscara de dias: bit 0 = segunda … bit 6 = domingo. 127 = todos. */
export const WEEKDAY_LABELS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"] as const;
export const ALL_WEEKDAYS_MASK = 127;

export interface TaskTemplateLike {
  id: number;
  active: number | boolean;
  shift: string;
  weekdaysMask: number;
  dueHour: number | null;
}

export function weekdayIndex(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function templateRunsOn(t: Pick<TaskTemplateLike, "weekdaysMask">, day: string): boolean {
  return ((Number(t.weekdaysMask) >>> 0) & (1 << weekdayIndex(day))) !== 0;
}

/**
 * Prazo (ms) de uma ocorrência. Manhã: `dueHour` (omissão 15h, fim da manhã).
 * Noite: `dueHour` < 03h conta para a madrugada seguinte (omissão 03h do dia
 * seguinte, fim da noite). Dia todo: `dueHour` ou fim do dia operacional.
 */
export function templateDueAtMs(day: string, shift: TemplateShift, dueHour: number | null): number {
  const h = dueHour == null ? null : Math.max(0, Math.min(23, Math.trunc(dueHour)));
  if (shift === "manha") return lisbonLocalTimeUtcMs(day, h ?? NIGHT_START_HOUR);
  if (shift === "noite") {
    const hh = h == null ? 24 + OPERATIONAL_DAY_START_HOUR : h < OPERATIONAL_DAY_START_HOUR ? h + 24 : h;
    return lisbonLocalTimeUtcMs(day, hh);
  }
  return lisbonLocalTimeUtcMs(day, h == null ? 24 + OPERATIONAL_DAY_START_HOUR : h < OPERATIONAL_DAY_START_HOUR ? h + 24 : h);
}

export interface TemplateOccurrence { templateId: number; date: string; shift: TemplateShift; dueAtMs: number; key: string }

export function templateOccurrenceKey(templateId: number, date: string, shift: string): string {
  return `${templateId}|${date}|${shift}`;
}

/**
 * Ocorrências a gerar no dia `day` (Lisboa): modelos ativos cujo dia da semana
 * está na máscara, sem as que já existem (`existingKeys`) — idempotente.
 */
export function templateOccurrencesFor(templates: TaskTemplateLike[], day: string, existingKeys: Iterable<string> = []): TemplateOccurrence[] {
  const have = new Set(existingKeys);
  const out: TemplateOccurrence[] = [];
  for (const t of templates) {
    if (!t.active || !templateRunsOn(t, day)) continue;
    const shift = ((TEMPLATE_SHIFTS as readonly string[]).includes(t.shift) ? t.shift : "any") as TemplateShift;
    const key = templateOccurrenceKey(t.id, day, shift);
    if (have.has(key)) continue;
    have.add(key);
    out.push({ templateId: t.id, date: day, shift, dueAtMs: templateDueAtMs(day, shift, t.dueHour), key });
  }
  return out;
}

/** Dia operacional de Lisboa (antes das 03h ainda conta o dia anterior). */
export function operationalDayOf(nowMs: number): string {
  return lisbonDayOf(nowMs - OPERATIONAL_DAY_START_HOUR * 3_600_000);
}

// ─── Hierarquia de gestores ─────────────────────────────────────────────────

/** Gestores (userIds) do projeto e de todos os antepassados, sem repetidos. */
export function hierarchyManagerIds(
  projects: Array<{ id: number; parentId: number | null; managerId: number | null }>,
  projectId: number | null | undefined,
): number[] {
  if (projectId == null) return [];
  const byId = new Map(projects.map((p) => [p.id, p]));
  const out: number[] = [];
  const seen = new Set<number>();
  let cur = byId.get(projectId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.managerId != null && !out.includes(cur.managerId)) out.push(cur.managerId);
    cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
  }
  return out;
}
