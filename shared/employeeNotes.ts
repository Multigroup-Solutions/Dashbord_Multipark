/**
 * Notas internas das fichas (Jorge, 7 out 2026: "Os extras devem ter notas
 * internas (ex. este extra trabalhou mal no dia ...)").
 *
 * Decisão (7 out 2026): leem e escrevem o team leader e acima, no âmbito de
 * cada um (cidade/centro); a própria pessoa NUNCA as vê. Editar/arquivar: o
 * autor nas primeiras 24 h, ou um administrador do RH. "Apagar" = arquivar.
 * PURO: igual no cliente e no servidor.
 */

export const NOTE_KINDS = ["general", "performance", "conduct", "praise"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  general: "Geral",
  performance: "Desempenho",
  conduct: "Comportamento",
  praise: "Elogio",
};

/** Cores das etiquetas (Tailwind, com modo escuro). */
export const NOTE_KIND_CLASSES: Record<NoteKind, string> = {
  general: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  performance: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
  conduct: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200",
  praise: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200",
};

export const NOTE_BODY_MAX = 2000;
/** O autor edita/arquiva a sua nota durante este tempo; depois, só um administrador do RH. */
export const NOTE_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const isNoteKind = (v: unknown): v is NoteKind => typeof v === "string" && (NOTE_KINDS as readonly string[]).includes(v);

/** Aviso RGPD por baixo do formulário. */
export const NOTE_PRIVACY_HINT = "Só factos de trabalho. Não escrevas dados de saúde, vida privada ou opiniões pessoais — a pessoa pode pedir acesso aos seus dados (RGPD).";
