/**
 * Raciocínio "minimal" só onde há avaliação (plano MPV F6b, T1). PURO.
 *
 * O `ai.thinkingLevels` (Definições → Parâmetros → IA) já existe desde o F0a e
 * continua VAZIO por omissão (= como até aqui: a env AI_THINKING_LEVEL, "low").
 * Nas classificações a saída é 53–76 % do custo e o raciocínio paga-se como
 * saída, por isso o "minimal" poupa — mas só se liga numa funcionalidade
 * depois de a avaliação dela passar COM ele:
 *
 *   mail_routing      scripts/eval-mail-triage.ts --thinking minimal
 *   whatsapp_triage   scripts/eval-whatsapp-triage.ts --compare
 *   complaint_triage  scripts/eval-complaint-triage.ts --compare
 *
 * Passou → o Jorge cola o valor sugerido em `ai.thinkingLevels` (uma linha
 * por funcionalidade que passou; nada muda sem ele). Desfazer = tirar a linha.
 */
import type { AiFeature, AiThinkingLevel } from "./aiFeatures";

/** O valor sugerido para `ai.thinkingLevels` — só para as funcionalidades com avaliação. */
export const AI_THINKING_SUGGESTED: Readonly<Partial<Record<AiFeature, AiThinkingLevel>>> = {
  mail_routing: "minimal",
  whatsapp_triage: "minimal",
  complaint_triage: "minimal",
};

/** A avaliação de cada funcionalidade com valor sugerido (o comando que a corre). */
export const AI_THINKING_EVALS: Readonly<Partial<Record<AiFeature, string>>> = {
  mail_routing: "pnpm tsx scripts/eval-mail-triage.ts --corpus todos --thinking minimal",
  whatsapp_triage: "pnpm tsx scripts/eval-whatsapp-triage.ts --compare",
  complaint_triage: "pnpm tsx scripts/eval-complaint-triage.ts --compare",
};

/** Resultado de uma corrida da avaliação (o essencial para comparar níveis). */
export interface ThinkingRun {
  /** Passa as metas da avaliação. */
  passes: boolean;
  /** Casos certos (a métrica principal). */
  correct: number;
  total: number;
  /** Casos em que a IA falhou (sem resposta). */
  failed: number;
}

/**
 * O nível candidato (ex.: "minimal") pode ligar-se? Só se passar as metas,
 * não falhar mais respostas do que o de hoje e acertar no máximo 1 caso a
 * menos (o ruído de uma corrida). PURA.
 */
export function thinkingLevelVerdict(today: ThinkingRun, candidate: ThinkingRun): { ok: boolean; why: string } {
  if (!candidate.passes) return { ok: false, why: "não passa as metas com este nível" };
  if (candidate.failed > today.failed) return { ok: false, why: `falhou ${candidate.failed} resposta(s) (hoje ${today.failed})` };
  if (candidate.correct < today.correct - 1) return { ok: false, why: `acertou ${candidate.correct} de ${candidate.total} (hoje ${today.correct})` };
  return { ok: true, why: `acertou ${candidate.correct} de ${candidate.total} (hoje ${today.correct}) e passa as metas` };
}

/** A linha a colar em `ai.thinkingLevels` com as funcionalidades que passaram. PURA. */
export function suggestedThinkingSetting(passed: readonly AiFeature[], current: Readonly<Record<string, unknown>> | null = null): Record<string, AiThinkingLevel> {
  const out: Record<string, AiThinkingLevel> = {};
  for (const [k, v] of Object.entries(current ?? {})) if (typeof v === "string") out[k] = v as AiThinkingLevel;
  for (const f of passed) {
    const level = AI_THINKING_SUGGESTED[f];
    if (level) out[f] = level;
  }
  return out;
}
