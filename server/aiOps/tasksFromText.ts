/**
 * "Criar tarefas a partir de texto": a IA (`tasks_from_text`, lite) PROPÕE
 * tarefas (título, sugestão de responsável, prazo) a partir de notas coladas;
 * NADA é criado aqui. A pessoa confirma no ecrã e só então
 * `tasks.createFromProposals` cria (com os mesmos guardas do "Nova tarefa").
 *
 * Os nomes da equipa NÃO vão para a IA: ela devolve só uma pista ("Rui") e a
 * correspondência com a ficha é feita no código, dentro de quem a pessoa pode
 * atribuir.
 */
import { TASKS_FROM_TEXT_SYSTEM, tasksFromTextSchema } from "../_core/ai/prompts/ops";
import { addDays } from "../../shared/lisbonDay";
import { tryAi } from "./aiCall";

export const MAX_PROPOSALS = 15;
export const MAX_TEXT = 6000;

export interface AssigneeCandidate { id: number; fullName: string }
export interface TaskProposal {
  title: string;
  description: string | null;
  assigneeHint: string | null;
  suggestedAssigneeId: number | null;
  suggestedAssigneeName: string | null;
  dueDate: string | null;
  priority: "low" | "medium" | "high" | "urgent";
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Pista → ficha: nome completo contido, ou primeiro nome ÚNICO. PURA. */
export function matchAssignee(hint: string | null | undefined, candidates: AssigneeCandidate[]): AssigneeCandidate | null {
  const h = norm(String(hint ?? ""));
  if (h.length < 2) return null;
  const full = candidates.filter((c) => norm(c.fullName) === h || (h.includes(" ") && norm(c.fullName).includes(h)));
  if (full.length === 1) return full[0];
  const first = candidates.filter((c) => norm(c.fullName).split(/\s+/)[0] === h.split(/\s+/)[0]);
  return first.length === 1 ? first[0] : null;
}

/** Prazo válido: AAAA-MM-DD entre ontem e +180 dias. PURA. */
export function validDueDate(d: string | null | undefined, today: string): string | null {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) return null;
  return d >= addDays(today, -1) && d <= addDays(today, 180) ? d : null;
}

/** Limpa a saída da IA: sem títulos vazios/repetidos, prazos e responsáveis validados. PURA. */
export function normalizeProposals(raw: Array<{ title: string; description?: string | null; assigneeHint?: string | null; dueDate?: string | null; priority?: string | null }>, candidates: AssigneeCandidate[], today: string): TaskProposal[] {
  const seen = new Set<string>();
  const out: TaskProposal[] = [];
  for (const r of raw) {
    const title = String(r.title ?? "").replace(/\s+/g, " ").trim().slice(0, 256);
    if (title.length < 3 || seen.has(norm(title))) continue;
    seen.add(norm(title));
    const who = matchAssignee(r.assigneeHint, candidates);
    const priority = (["low", "medium", "high", "urgent"] as const).find((p) => p === r.priority) ?? "medium";
    out.push({
      title,
      description: r.description ? String(r.description).trim().slice(0, 1000) || null : null,
      assigneeHint: r.assigneeHint ? String(r.assigneeHint).slice(0, 80) : null,
      suggestedAssigneeId: who?.id ?? null,
      suggestedAssigneeName: who?.fullName ?? null,
      dueDate: validDueDate(r.dueDate, today),
      priority,
    });
    if (out.length >= MAX_PROPOSALS) break;
  }
  return out;
}

export async function proposeTasksFromText(text: string, opts: { candidates: AssigneeCandidate[]; today: string; userId: number }): Promise<{ ok: true; proposals: TaskProposal[] } | { ok: false; reason: string }> {
  const body = String(text ?? "").trim().slice(0, MAX_TEXT);
  if (body.length < 10) return { ok: false, reason: "Cola um texto com pelo menos uma ação." };
  const res = await tryAi({
    feature: "tasks_from_text", system: TASKS_FROM_TEXT_SYSTEM, schema: tasksFromTextSchema,
    input: `Hoje: ${opts.today}.\nTexto:\n${body}`, maxTokens: 1200, timeoutMs: 25_000, userId: opts.userId, entity: "tasks",
  });
  if (!res.ok) {
    return { ok: false, reason: res.skipped === "disabled" ? "Esta funcionalidade de IA está desligada." : res.skipped === "budget" ? "IA temporariamente indisponível." : "A IA não respondeu. Tenta outra vez." };
  }
  return { ok: true, proposals: normalizeProposals(res.output.tasks, opts.candidates, opts.today) };
}
