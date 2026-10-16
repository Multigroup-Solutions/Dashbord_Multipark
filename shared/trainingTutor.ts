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

// ─── D7 (Jorge, 16 out 2026): "o Multis passa a ser o tutor da página Formação" ──

/**
 * Quem faz de tutor na página Formação (Definições → Parâmetros → Pessoas →
 * `training.tutorMode`): "multis" (por omissão, decisão do Jorge) = o lugar
 * do tutor abre o Multis com o contexto da página, o perfil de tutor e os
 * manuais e vídeos da formação; "proprio" = o tutor próprio, tal como era.
 */
export const TUTOR_MODES = ["multis", "proprio"] as const;
export type TutorMode = (typeof TUTOR_MODES)[number];
export const TUTOR_DEFAULT_MODE: TutorMode = "multis";
export const TUTOR_MODE_LABELS: Record<TutorMode, string> = {
  multis: "o Multis",
  proprio: "o tutor próprio",
};
/** A página onde o Multis faz de tutor (caminho exato: "/formacao/conhecimento" não conta). */
export const TUTOR_PAGE_PATH = "/formacao";
/**
 * Contexto das perguntas feitas ao Multis na página sem um módulo aberto, no
 * agregado anónimo dos formadores (training_tutor_questions.contextType, 8 car.).
 */
export const TUTOR_PAGE_CONTEXT = "formacao" as const;
/** Pergunta mais longa que se procura nos manuais da formação (ferramenta do Multis). */
export const TUTOR_SEARCH_MAX_CHARS = 300;

/**
 * "?manual=12" / "?video=5" (as ligações das "Fontes" do Multis) → o que
 * abrir na página Formação; o resto → null. PURA.
 */
export function trainingDeepLink(search: string | null | undefined): { type: "manual" | "video"; id: number } | null {
  const p = new URLSearchParams(String(search ?? "").replace(/^\?/, ""));
  for (const type of ["manual", "video"] as const) {
    const raw = p.get(type);
    if (raw == null) continue;
    const id = Number(raw);
    if (/^\d{1,9}$/.test(raw) && Number.isSafeInteger(id) && id > 0) return { type, id };
  }
  return null;
}

/** Perguntas rápidas do lugar do tutor quando é o Multis (D7), por tipo de módulo. PURA. */
export function tutorQuickQuestions(type: TutorContextType): string[] {
  switch (type) {
    case "manual": return ["Explica-me este manual, passo a passo.", "Faz-me uma pergunta para ver se percebi."];
    case "video": return ["Explica-me o que este vídeo ensina.", "Faz-me uma pergunta para ver se percebi."];
    case "path": return ["Por onde começo este percurso?", "Explica-me o primeiro passo deste percurso."];
    case "quiz": return ["O que devo rever antes do quiz?", "Faz-me uma pergunta de treino."];
  }
}

/**
 * O módulo aberto na página, como registo do Multis (shared/multisPage.ts):
 * manual, vídeo ou percurso (o quiz vai pelo separador "quiz"). PURA.
 */
export const TUTOR_ENTITY_TYPES = { manual: "training_manual", video: "training_video", path: "training_path" } as const;
export function tutorContextFromPage(entity: { type: string; id: number } | null | undefined, tab: string | null | undefined): TutorContext | null {
  if (entity && Number.isSafeInteger(entity.id) && entity.id > 0) {
    for (const [type, name] of Object.entries(TUTOR_ENTITY_TYPES)) if (entity.type === name) return { type: type as TutorContextType, id: entity.id };
  }
  return tab === "quiz" ? { type: "quiz", id: 0 } : null;
}
