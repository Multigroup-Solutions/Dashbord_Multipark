/**
 * Tarefas de candidatura — regras PURAS (Jorge, 7 out 2026: as candidaturas de
 * condutores "criam tarefa automática (uma por candidatura) e são filtráveis").
 *
 *  - uma candidatura = um lead que chegou de fora: candidatura do site
 *    ("Be a Driver", `source = 'site'`) ou email de recrutamento
 *    (`source = 'email'`). Os leads criados à mão já têm quem trate deles;
 *  - UMA tarefa por lead (origem `lead`, `sourceKey "lead:<id>"`, chave única
 *    na BD — migração 0545): nunca nasce outra, nem depois de arquivada;
 *  - responsável: quem criou o lead (se tiver ficha ativa), senão o(s)
 *    supervisor(es) da cidade do lead; sem nenhum, fica sem responsável na
 *    lista de Tarefas da cidade (ou de todos, se o lead não tiver cidade);
 *  - prazo: o SLA do 1.º contacto (24 h depois de o lead entrar);
 *  - fecha sozinha quando o lead é convertido em extra, fica "Sem interesse"
 *    ou é arquivado (o fecho é idempotente: só mexe nas abertas);
 *  - arranque sem enxurrada: só leads abertos que entraram nos últimos
 *    `LEAD_TASK_MAX_AGE_DAYS` dias (os mais antigos já têm o resumo diário).
 */
import { LEAD_SLA } from "./extraLeadsFunnel";
import { utcMs } from "./lisbonDay";

export const LEAD_TASK_SOURCE = "lead";
/** Origens do lead que são candidaturas (site Be a Driver + emails de recrutamento). */
export const LEAD_TASK_LEAD_SOURCES = ["site", "email"] as const;
/** Estados em que a candidatura ainda está por tratar. */
export const LEAD_TASK_OPEN_STATUSES = ["new", "contacted", "replied"] as const;
/** Estados que fecham a tarefa (além de arquivar o lead). */
export const LEAD_TASK_CLOSED_STATUSES = ["converted", "declined"] as const;
/** Só se criam tarefas para leads que entraram há no máximo isto (sem enxurrada no 1.º deploy). */
export const LEAD_TASK_MAX_AGE_DAYS = 7;
/** Máximo de supervisores atribuídos a uma tarefa. */
export const LEAD_TASK_MAX_ASSIGNEES = 10;

export interface LeadForTask {
  id: number;
  fullName: string;
  source: string | null | undefined;
  status: string;
  archivedAt?: string | null;
  createdAt: string;
}

export function leadTaskKey(leadId: number): string {
  return `${LEAD_TASK_SOURCE}:${leadId}`;
}

export function parseLeadTaskKey(key: string | null | undefined): number | null {
  const m = /^lead:(\d+)$/.exec(String(key ?? ""));
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function isCandidaturaLead(lead: { source: string | null | undefined }): boolean {
  return (LEAD_TASK_LEAD_SOURCES as readonly string[]).includes(String(lead.source ?? ""));
}

/** O lead já não precisa de ninguém: convertido, sem interesse ou arquivado. */
export function leadIsResolved(lead: { status: string; archivedAt?: string | null }): boolean {
  return !!lead.archivedAt || (LEAD_TASK_CLOSED_STATUSES as readonly string[]).includes(lead.status);
}

/**
 * O que fazer com a tarefa de um lead (idempotente: aplicar duas vezes dá o
 * mesmo). `task` = a tarefa que já existe (arquivada conta — não volta a nascer).
 */
export function leadTaskAction(
  lead: LeadForTask,
  task: { taskStatus: string; archivedAt?: string | null } | null,
  nowMs: number,
): "create" | "close" | "none" {
  if (task) {
    return !task.archivedAt && task.taskStatus !== "done" && leadIsResolved(lead) ? "close" : "none";
  }
  if (!isCandidaturaLead(lead) || leadIsResolved(lead)) return "none";
  if (!(LEAD_TASK_OPEN_STATUSES as readonly string[]).includes(lead.status)) return "none";
  const created = utcMs(lead.createdAt);
  if (!Number.isFinite(created) || nowMs - created > LEAD_TASK_MAX_AGE_DAYS * 86_400_000) return "none";
  return "create";
}

/** Instante (UTC, YYYY-MM-DD HH:MM:SS) a partir do qual os leads entram (o resto fica sem tarefa). */
export function leadTaskCutoffMysql(nowMs: number): string {
  return new Date(nowMs - LEAD_TASK_MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

export function leadTaskTitle(fullName: string | null | undefined): string {
  return `Candidatura de condutor: ${(fullName ?? "").trim() || "sem nome"}`.slice(0, 256);
}

const SOURCE_TEXT: Record<string, string> = { site: "candidatura do site (Be a Driver)", email: "email de recrutamento" };

export function leadTaskDescription(
  lead: { source: string | null | undefined; phone?: string | null; email?: string | null; notes?: string | null },
  cityName: string | null,
): string {
  return [
    `Nova ${SOURCE_TEXT[String(lead.source ?? "")] ?? "candidatura"}${cityName ? ` · ${cityName}` : " · sem cidade"}.`,
    "Contacta a pessoa e trata a candidatura nos Leads de extras (converter em extra, Sem interesse ou arquivar). A tarefa fecha-se sozinha nesse momento.",
    [lead.phone ? `Telemóvel: ${lead.phone}` : null, lead.email ? `Email: ${lead.email}` : null].filter(Boolean).join(" · "),
    lead.notes ? `Notas: ${lead.notes}` : "",
  ].filter(Boolean).join("\n").slice(0, 20_000);
}

/** Prazo da tarefa: o SLA do 1.º contacto a contar da entrada do lead (com hora). */
export function leadTaskDueMs(createdAt: string): number {
  return utcMs(createdAt) + LEAD_SLA.newNoContactHours * 3_600_000;
}

/**
 * Responsáveis: quem criou o lead (ficha ativa), senão os supervisores da
 * cidade. Sem repetidos, no máximo `LEAD_TASK_MAX_ASSIGNEES`.
 */
export function leadTaskAssignees(input: { ownerEmployeeId: number | null; supervisorEmployeeIds: readonly number[] }): number[] {
  if (input.ownerEmployeeId != null && input.ownerEmployeeId > 0) return [input.ownerEmployeeId];
  return [...new Set(input.supervisorEmployeeIds.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, LEAD_TASK_MAX_ASSIGNEES);
}

/** Comentário deixado na tarefa quando fecha sozinha. */
export function leadTaskCloseComment(lead: { status: string; archivedAt?: string | null }): string {
  if (lead.status === "converted") return "Fechada automaticamente: o lead foi convertido em extra.";
  if (lead.status === "declined") return "Fechada automaticamente: o lead ficou «Sem interesse».";
  return "Fechada automaticamente: o lead foi arquivado.";
}
