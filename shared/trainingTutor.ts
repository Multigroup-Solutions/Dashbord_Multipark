/**
 * Tutor da Formação — tipos e limites partilhados (servidor ↔ cliente).
 *
 * Um "módulo" é o contexto onde o formando está: um manual, um vídeo, um
 * percurso (path) ou o quiz (id = categoria; 0 = geral).
 */
export const TUTOR_CONTEXT_TYPES = ["manual", "video", "path", "quiz"] as const;
export type TutorContextType = (typeof TUTOR_CONTEXT_TYPES)[number];

export interface TutorContext {
  type: TutorContextType;
  id: number;
}

/** Tamanho máximo de uma pergunta (caracteres). */
export const TUTOR_MAX_INPUT_CHARS = 500;
/** Resposta curta (boa para ler em voz alta) e resposta "explicar melhor". */
export const TUTOR_SHORT_WORDS = 120;
export const TUTOR_DETAIL_WORDS = 250;
/** Turnos (pergunta + resposta) que o tutor lembra por formando e módulo. */
export const TUTOR_HISTORY_TURNS = 4;
/** Dias que o histórico fica guardado. */
export const TUTOR_HISTORY_DAYS = 30;
/** Limites por omissão (Definições → Parâmetros → ai.trainingTutorLimits). */
export const TUTOR_DEFAULT_LIMITS = { perMinute: 10, perDay: 100 } as const;

export const TUTOR_CONTEXT_LABELS: Record<TutorContextType, string> = {
  manual: "Manual",
  video: "Vídeo",
  path: "Percurso",
  quiz: "Quiz",
};
