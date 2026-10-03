/**
 * D45 (Jorge, 3 out 2026): aviso no sino "Nova tarefa para ti".
 *
 * Interruptor TASK_ASSIGNED_NOTIFY — desligado por omissão (coisas novas que
 * avisam gente entram desligadas). Regras:
 *  - só tarefas feitas por pessoas (origem "manual" ou sem origem): checklists,
 *    serviços, disponibilidade, fichas do RH e as que vêm do Google ficam de fora;
 *  - só quem passou a ser responsável agora (editar uma tarefa não volta a
 *    avisar quem já lá estava);
 *  - nunca quem a atribuiu (atribuir a ti próprio não te avisa);
 *  - responsáveis sem conta ligada à ficha não recebem (não há a quem avisar).
 * Nunca lança: uma falha a avisar não estraga a tarefa.
 */
export const TASK_ASSIGNED_FLAG = "TASK_ASSIGNED_NOTIFY";

/** Tarefa feita por uma pessoa (as automáticas e as do Google não avisam). PURA. */
export function isManualTask(t: { sourceModule?: string | null }): boolean {
  const s = String(t.sourceModule ?? "").trim();
  return s === "" || s === "manual";
}

/** Responsáveis que entraram agora (os que já estavam não contam). PURA. */
export function newAssigneeIds(next: ReadonlyArray<number | null | undefined>, prev: ReadonlyArray<number | null | undefined> = []): number[] {
  const before = new Set(prev.filter((x): x is number => typeof x === "number"));
  return Array.from(new Set(next.filter((x): x is number => typeof x === "number" && x > 0 && !before.has(x))));
}

export interface TaskAssignedInput {
  task: { id: number; title: string; sourceModule?: string | null; projectId?: number | null; dueDate?: string | null };
  /** Fichas (employees.id) que passaram a ser responsáveis. */
  employeeIds: ReadonlyArray<number | null | undefined>;
  /** Quem atribuiu (users.id) — nunca é avisado. */
  byUserId: number;
  byName?: string | null;
}

export interface TaskAssignedDeps {
  flagOn(): Promise<boolean>;
  userIdsOfEmployees(employeeIds: number[]): Promise<number[]>;
  notify(input: Record<string, any>): Promise<unknown>;
}

export type TaskAssignedOutcome = "not_manual" | "nobody" | "flag_off" | "notified";

/** Núcleo (dependências injetáveis para os testes). */
export async function notifyTaskAssignedWith(deps: TaskAssignedDeps, input: TaskAssignedInput): Promise<TaskAssignedOutcome> {
  if (!isManualTask(input.task)) return "not_manual";
  const employeeIds = newAssigneeIds(input.employeeIds);
  if (!employeeIds.length) return "nobody";
  if (!(await deps.flagOn())) return "flag_off";
  const userIds = (await deps.userIdsOfEmployees(employeeIds)).filter((u) => u !== input.byUserId);
  if (!userIds.length) return "nobody";
  const due = input.task.dueDate ? String(input.task.dueDate).slice(0, 10) : null;
  const by = String(input.byName ?? "").trim();
  await deps.notify({
    kind: "task_assigned",
    targetUserIds: userIds,
    projectId: input.task.projectId ?? null,
    title: "Nova tarefa para ti",
    body: `${input.task.title}${due ? ` · prazo ${due.split("-").reverse().join("/")}` : ""}${by ? ` · de ${by}` : ""}`.slice(0, 500),
    link: `/tarefas?focus=${input.task.id}`,
    entity: { type: "task", id: input.task.id },
  });
  return "notified";
}

export async function notifyTaskAssigned(input: TaskAssignedInput): Promise<TaskAssignedOutcome | "error"> {
  try {
    return await notifyTaskAssignedWith({
      async flagOn() {
        const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
        await ensureFeatureFlagOverrides();
        return isFeatureEnabled(TASK_ASSIGNED_FLAG, { defaultEnabled: automationFlagDefault(TASK_ASSIGNED_FLAG) });
      },
      async userIdsOfEmployees(ids) {
        const { assigneeUserIds } = await import("./complaintsExtended");
        return assigneeUserIds(ids);
      },
      async notify(n) {
        const { notify } = await import("./notify");
        return notify(n as any);
      },
    }, input);
  } catch (err) {
    console.warn("[taskAssignNotify] aviso falhou:", String((err as any)?.message ?? err).slice(0, 160));
    return "error";
  }
}
