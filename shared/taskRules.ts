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

/** Máximo de tarefas numa lista (as mais recentes); a página avisa quando chega a isto. */
export const TASK_LIST_LIMIT = 2000;

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
/**
 * Criar / editar / arquivar / arrastar. Recebe o utilizador (com as exceções
 * por pessoa — P3 18a: antes só o papel contava) ou só o papel.
 */
export function canEditTasks(user: TaskUserLike): boolean {
  return seesBeyondOwn(user, "tarefas") && can(user, "tarefas", "edit");
}
type TaskUserLike = Parameters<typeof can>[0];

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

/**
 * Mudar o ESTADO: editores, ou qualquer responsável (extra incluído) na sua
 * própria tarefa. O team leader só vê as da equipa — isso é verificado à
 * parte, no servidor (`teamTaskAccess`).
 */
export function canChangeTaskStatus(viewer: { role: string; employeeId: number | null; accessOverrides?: any }, t: TaskAssignLike): boolean {
  if (canEditTasks(viewer)) return true;
  return can(viewer, "tarefas", "edit") && isTaskAssignee(viewer.employeeId, t);
}

/**
 * Team leader (alcance "below_city"), P3 18a — Jorge: "só a equipa dele".
 * Vê / muda o estado / comenta numa tarefa se ele a criou ou se algum
 * responsável é da equipa (ele incluído). Editar e arquivar pede mais: todos
 * os responsáveis da equipa — e uma tarefa sem responsáveis só se foi ele a
 * criar (as transversais ficam para supervisor e acima). PURA.
 */
export function teamTaskAccess(
  viewer: { userId: number; team: ReadonlySet<number> },
  t: { createdById: number | null; assigneeIds: ReadonlyArray<number | null | undefined> },
): { see: boolean; edit: boolean } {
  const ids = t.assigneeIds.filter((x): x is number => x != null);
  const mine = t.createdById === viewer.userId;
  const see = mine || ids.some((id) => viewer.team.has(id));
  const edit = ids.length ? ids.every((id) => viewer.team.has(id)) : mine;
  return { see, edit };
}

// ─── Tarefas automáticas (geradas pelo sistema) ─────────────────────────────

/** Origens das tarefas que o sistema cria sozinho (o "criador" é o utilizador de sistema). */
export const AUTOMATIC_TASK_SOURCES = ["availability", "template", "service", "rh"] as const;

export function isAutomaticTask(t: { sourceModule?: string | null }): boolean {
  return (AUTOMATIC_TASK_SOURCES as readonly string[]).includes(String(t.sourceModule ?? ""));
}

/**
 * Quem é avisado quando uma tarefa passa o prazo (P3 18a — Jorge: "responsáveis
 * + supervisor"). Manuais: como sempre (criador + gestores da hierarquia no
 * sino e email ao criador; responsáveis no sino). Automáticas: só os
 * responsáveis e o supervisor da cidade, no sino — nada ao "criador" (o
 * utilizador de sistema) nem por email — e só com o interruptor ligado. PURA.
 */
export function overdueAudience(
  t: { sourceModule?: string | null; createdById: number | null; projectId: number | null },
  managerIds: readonly number[],
  autoNoticesOn: boolean,
): { managers: number[]; emailCreator: boolean; assignees: boolean; citySupervisors: boolean } {
  if (isAutomaticTask(t)) {
    return autoNoticesOn
      ? { managers: [], emailCreator: false, assignees: true, citySupervisors: t.projectId != null }
      : { managers: [], emailCreator: false, assignees: false, citySupervisors: false };
  }
  const managers = [...new Set([t.createdById, ...managerIds].filter((x): x is number => x != null))];
  return { managers, emailCreator: t.createdById != null, assignees: true, citySupervisors: false };
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

export const TASK_SOURCE_MODULES = ["manual", "availability", "complaint", "incident", "lost_found", "template", "google_tasks", "service", "rh"] as const;
export type TaskSourceModule = (typeof TASK_SOURCE_MODULES)[number];
export const TASK_SOURCE_LABELS: Record<TaskSourceModule, string> = {
  manual: "Manual", availability: "Disponibilidade", complaint: "Reclamação", incident: "Ocorrência", lost_found: "Perdidos e achados", template: "Checklist", google_tasks: "Google Tarefas", service: "Serviço da reserva", rh: "Ficha (RH)",
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
    // Ficha sem cidade (rh:missing-city:<ficha>) → a ficha no RH.
    case "rh": return id ? `/rh?employeeId=${id}` : "/rh";
    // Serviço extra de uma reserva (sourceKey "svc:<reserva>:<linha>") → ficha da reserva.
    case "service": {
      const m = /^svc:([^:]+):/.exec(key ?? "");
      return m ? `/reserva/${encodeURIComponent(m[1])}` : "/servicos";
    }
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

/**
 * Destinatário configurável (Definições → availability.assigneeEmail, ou a env
 * AVAILABILITY_TASK_ASSIGNEE_EMAIL). 43c (Jorge, 7 out 2026: "vê se isto da
 * disponibilidade ainda está com a Kamila… para retirarmos isto daqui"): já não
 * há ninguém escrito no código — sem nada configurado, a tarefa fica sem
 * responsável (na lista de Tarefas da cidade da pessoa).
 */
export const DEFAULT_AVAILABILITY_TASK_ASSIGNEE_EMAIL = "";
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
