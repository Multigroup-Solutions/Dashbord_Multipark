/**
 * Catálogo das funcionalidades de IA (partilhado servidor ↔ cliente): nome,
 * interruptor, nível de modelo por omissão e se é "essencial" (continua a
 * funcionar entre 100% e 150% do orçamento mensal).
 *
 * Regra do dono (set 2026): o modelo MAIS BARATO sempre que possível — tudo
 * em `lite` (Flash-Lite) por omissão; `fast` só onde o lite comprovadamente
 * falha; `smart` em lado nenhum por omissão. O nível de cada funcionalidade
 * pode ser mudado sem deploy: Definições → Parâmetros (`ai.featureTiers`) ou
 * env AI_TIER_<FUNCIONALIDADE> (ex.: AI_TIER_EXPENSE_OCR=fast).
 */
export type AiTier = "lite" | "fast" | "smart";
export const AI_TIERS: readonly AiTier[] = ["lite", "fast", "smart"];

export type AiFlag =
  | "AI_EXPENSE_OCR"
  | "AI_REVIEW_DRAFTS"
  | "AI_RADIO"
  | "AI_HANDOVER_SUMMARY"
  | "AI_WHATSAPP_ASSIST"
  | "AI_QUIZ"
  | "AI_HR_AUTOFILL";

export interface AiFeatureDef {
  label: string;
  /** null = sem interruptor próprio (só o geral AI_ENABLED). */
  flag: AiFlag | null;
  tier: AiTier;
  essential: boolean;
}

export const AI_FEATURES = {
  // Imagens de faturas: o lite lê bem. PDFs (várias páginas) pedem `fast` no
  // ponto de chamada (routers.ts, expenses.extractFromImage).
  expense_ocr: { label: "Leitura de faturas", flag: "AI_EXPENSE_OCR", tier: "lite", essential: true },
  review_reply: { label: "Resposta a críticas", flag: "AI_REVIEW_DRAFTS", tier: "lite", essential: false },
  radio_transcription: { label: "Transcrição do rádio", flag: "AI_RADIO", tier: "lite", essential: false },
  radio_summary: { label: "Resumo do rádio", flag: "AI_RADIO", tier: "lite", essential: false },
  handover_summary: { label: "Resumo da passagem de turno", flag: "AI_HANDOVER_SUMMARY", tier: "lite", essential: false },
  whatsapp_summary: { label: "WhatsApp: resumo", flag: "AI_WHATSAPP_ASSIST", tier: "lite", essential: false },
  whatsapp_reply: { label: "WhatsApp: sugestão de resposta", flag: "AI_WHATSAPP_ASSIST", tier: "lite", essential: false },
  hr_autofill: { label: "Documentos do RH", flag: "AI_HR_AUTOFILL", tier: "lite", essential: false },
  // Manual longo → 5–20 perguntas com resposta certa: o lite inventa/repete
  // opções com frequência; `fast` chega (nunca `smart`, por custo).
  quiz_generation: { label: "Perguntas da formação", flag: "AI_QUIZ", tier: "fast", essential: false },
  healthcheck: { label: "Teste da ligação", flag: null, tier: "lite", essential: true },
} as const satisfies Record<string, AiFeatureDef>;

export type AiFeature = keyof typeof AI_FEATURES;
export const AI_FEATURE_IDS = Object.keys(AI_FEATURES) as AiFeature[];

export function isAiFeature(v: string): v is AiFeature {
  return Object.prototype.hasOwnProperty.call(AI_FEATURES, v);
}

export function isAiTier(v: unknown): v is AiTier {
  return typeof v === "string" && (AI_TIERS as readonly string[]).includes(v);
}
