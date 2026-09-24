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
  | "AI_HR_AUTOFILL"
  | "AI_TRAINING_TUTOR"
  | "AI_COMPLAINT_TRIAGE"
  | "AI_REVIEW_AUTO_DRAFTS"
  | "AI_WHATSAPP_TRIAGE"
  | "AI_LOST_FOUND_MATCH"
  | "AI_ASSISTANT"
  // Automações internas (set 2026) — cada uma com o seu interruptor.
  | "AI_OPS_BRIEFING"
  | "AI_WEEKLY_REPORTS"
  | "AI_ANOMALY_EXPLAIN"
  | "AI_AVAILABILITY_CLASSIFY"
  | "AI_LEAD_SCORING"
  | "AI_EVALUATION_EXPLAIN"
  | "AI_HANDOVER_REPEATS"
  | "AI_TASKS_FROM_TEXT"
  | "AI_MAIL_DRAFT";

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
  // Tutor da Formação: respostas curtas só a partir dos manuais (trechos
  // escolhidos por palavras-chave + conteúdo do módulo em cache) — o lite chega.
  training_tutor: { label: "Tutor da formação", flag: "AI_TRAINING_TUTOR", tier: "lite", essential: false },
  // Comunicação com clientes (triagem/rascunhos/correspondências). Nada é
  // enviado sem aprovação humana; tudo `lite` (regra do dono).
  complaint_triage: { label: "Reclamações: triagem e rascunho", flag: "AI_COMPLAINT_TRIAGE", tier: "lite", essential: false },
  review_auto_draft: { label: "Críticas: rascunho automático", flag: "AI_REVIEW_AUTO_DRAFTS", tier: "lite", essential: false },
  whatsapp_triage: { label: "WhatsApp: intenção e urgência", flag: "AI_WHATSAPP_TRIAGE", tier: "lite", essential: false },
  lost_found_match: { label: "Perdidos: correspondências", flag: "AI_LOST_FOUND_MATCH", tier: "lite", essential: false },
  // Assistente da app (chat da equipa): "como se usa" + perguntas aos dados
  // por ferramentas só de leitura. Lite (regra do dono; muitas mensagens curtas).
  assistant: { label: "Assistente (chat)", flag: "AI_ASSISTANT", tier: "lite", essential: false },
  // ── Automações internas (nenhuma é para clientes). Os NÚMEROS vêm sempre do
  // SQL/código; a IA só escreve o texto. Todas `lite` (regra do dono).
  ops_briefing: { label: "Briefing diário por cidade", flag: "AI_OPS_BRIEFING", tier: "lite", essential: false },
  weekly_report: { label: "Relatórios semanais (texto)", flag: "AI_WEEKLY_REPORTS", tier: "lite", essential: false },
  anomaly_explain: { label: "Explicação de anomalias", flag: "AI_ANOMALY_EXPLAIN", tier: "lite", essential: false },
  availability_classify: { label: "Respostas de disponibilidade pouco claras", flag: "AI_AVAILABILITY_CLASSIFY", tier: "lite", essential: false },
  lead_summary: { label: "Leads: resumo da pontuação", flag: "AI_LEAD_SCORING", tier: "lite", essential: false },
  lead_first_contact: { label: "Leads: rascunho do 1.º contacto", flag: "AI_LEAD_SCORING", tier: "lite", essential: false },
  evaluation_explain: { label: "Explicação da avaliação", flag: "AI_EVALUATION_EXPLAIN", tier: "lite", essential: false },
  handover_repeats: { label: "Passagem de turno: pendentes repetidos e resumo semanal", flag: "AI_HANDOVER_REPEATS", tier: "lite", essential: false },
  tasks_from_text: { label: "Tarefas a partir de texto", flag: "AI_TASKS_FROM_TEXT", tier: "lite", essential: false },
  // Comunicação (email): rascunho de resposta — vai para o editor, nunca é enviado sozinho.
  mail_reply: { label: "Email: rascunho de resposta", flag: "AI_MAIL_DRAFT", tier: "lite", essential: false },
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
