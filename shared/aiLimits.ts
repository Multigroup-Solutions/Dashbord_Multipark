/**
 * Até onde vai a IA (Jorge, 8 out 2026 — "avança com o 7, a IA a agir sozinha"):
 * age sozinha onde é reversível e não fala com clientes, mas corta o custo e
 * o que se mostra a mais. Regras PURAS, usadas no servidor (que é quem manda)
 * e no ecrã (só para não mostrar botões que o servidor recusa).
 *
 *  - Condutores e extras (e "Utilizador") não veem a explicação da IA nos
 *    Alertas nem usam "Criar tarefas a partir de texto": team leader para cima.
 *  - Ficheiros pessoais INTEIROS (documentos e CV do RH) só vão para a IA com
 *    o Gemini em Vertex AI numa região da UE. Fora disso essas funcionalidades
 *    não correm, mesmo com o interruptor ligado. O rádio, as faturas e o resto
 *    não dependem disto.
 */
import { roleRank } from "./access";

/** Papel mínimo para as partes da IA cortadas a condutores e extras. */
export const AI_TEAM_MIN_ROLE = "team_leader" as const;

const atLeastTeamLeader = (role: string | null | undefined): boolean => roleRank(role) >= roleRank(AI_TEAM_MIN_ROLE);

/** Vê a linha da IA nos Alertas (anomalias) e no briefing? Condutor, extra e utilizador não. */
export function seesAiAlertExplanations(role: string | null | undefined): boolean {
  return atLeastTeamLeader(role);
}

/** Pode pedir à IA "Criar tarefas a partir de texto"? Team leader para cima. */
export function canUseAiTasksFromText(role: string | null | undefined): boolean {
  return atLeastTeamLeader(role);
}

export const AI_TASKS_FROM_TEXT_FORBIDDEN = "Criar tarefas a partir de texto (IA) é só para team leaders para cima.";

// ─── Ficheiros pessoais inteiros: só com Vertex AI na UE ────────────────────

/** Funcionalidades que mandam documentos/CV do RH inteiros para a IA. */
export const EU_VERTEX_ONLY_FEATURES = ["hr_autofill", "hr_email_attachments"] as const;
/** Os interruptores dessas funcionalidades (Definições → Automações). */
export const EU_VERTEX_ONLY_FLAGS = ["AI_HR_AUTOFILL", "AI_HR_EMAIL_ATTACHMENTS"] as const;

export function requiresEuVertex(feature: string): boolean {
  return (EU_VERTEX_ONLY_FEATURES as readonly string[]).includes(feature);
}
export function flagRequiresEuVertex(flag: string): boolean {
  return (EU_VERTEX_ONLY_FLAGS as readonly string[]).includes(flag);
}

/** Onde corre a IA de uma funcionalidade (sem segredos: só o tipo e a região). */
export interface AiWhere {
  provider: "gemini" | "legacy" | null;
  mode: "vertex" | "studio" | "legacy" | null;
  /** Região do Vertex (ex.: europe-west1); null fora do Vertex. */
  location: string | null;
}

// Regiões "europe-*" da Google que NÃO são da UE (Londres e Zurique).
const NOT_EU = new Set(["europe-west2", "europe-west6"]);

/** Região do Google Cloud dentro da UE? ("eu" = multirregião UE.) */
export function isEuRegion(location: string | null | undefined): boolean {
  const l = String(location ?? "").trim().toLowerCase();
  if (l === "eu") return true;
  return /^europe-[a-z]+\d+$/.test(l) && !NOT_EU.has(l);
}

/** A IA está em Vertex AI numa região da UE? */
export function euVertexOk(w: AiWhere): boolean {
  return w.provider === "gemini" && w.mode === "vertex" && isEuRegion(w.location);
}

/** Como as Definições chamam o sítio onde a IA corre. */
export function aiWhereLabel(w: AiWhere): string {
  if (w.provider == null) return "sem IA configurada";
  if (w.provider === "legacy" || w.mode === "legacy") return "fornecedor antigo";
  if (w.mode === "vertex") return `Gemini (Vertex AI${w.location ? `, ${w.location}` : ""})`;
  return "Gemini";
}

/** Texto ao lado do interruptor: "Só corre com a IA em Vertex AI na UE (hoje: …)". */
export function euVertexNote(w: AiWhere): { ok: boolean; text: string } {
  const ok = euVertexOk(w);
  return { ok, text: `Só corre com a IA em Vertex AI na UE (hoje: ${aiWhereLabel(w)}).${ok ? "" : " Até lá não corre, mesmo ligado."}` };
}
