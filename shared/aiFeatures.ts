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
  | "AI_MAIL_ROUTING"
  | "AI_LOST_FOUND_MATCH"
  | "AI_CRM_IDENTITY"
  | "AI_ASSISTANT"
  // Plano MPV (F0b): o Multis do piloto no modelo smart (Argon), com teto € próprio.
  | "AI_ASSISTANT_SMART"
  // Automações internas (set 2026) — cada uma com o seu interruptor.
  | "AI_OPS_BRIEFING"
  | "AI_WEEKLY_REPORTS"
  | "AI_ANOMALY_EXPLAIN"
  | "AI_AVAILABILITY_CLASSIFY"
  | "AI_LEAD_SCORING"
  | "AI_EVALUATION_EXPLAIN"
  | "AI_HANDOVER_REPEATS"
  | "AI_TASKS_FROM_TEXT"
  | "AI_MAIL_DRAFT"
  | "AI_WEB_INSIGHT"
  | "AI_GBP_POSTS"
  | "AI_PAGESPEED_EXPLAIN"
  // Base de conhecimento (manuais do Drive/uploads): índice por embeddings e leitura de PDFs.
  | "AI_KNOWLEDGE"
  // D39: anexos dos emails do RH (CV, documentos) → candidato + resumo para quem entrevista.
  | "AI_HR_EMAIL_ATTACHMENTS"
  // Formação com IA (14 out 2026): quiz novo em cada jogo e FAQs a partir da base de conhecimento.
  | "AI_QUIZ_LIVE"
  | "AI_KB_FAQ";

export interface AiFeatureDef {
  label: string;
  /** null = sem interruptor próprio (só o geral AI_ENABLED). */
  flag: AiFlag | null;
  tier: AiTier;
  essential: boolean;
  /**
   * Tem teto € próprio (plano MPV §5.3): NÃO entra na conta do orçamento
   * mensal global que bloqueia as não essenciais (o cartão do custo mostra-a
   * na mesma). Ao atingir o teto próprio, quem chama desce para outra
   * funcionalidade (assistant_smart → assistant, "modo económico").
   */
  ownBudget?: boolean;
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
  // Quiz da Formação (Jorge, 14 out 2026: "perguntas diferentes de cada vez"):
  // 10 perguntas novas em cada jogo, só com trechos da base de conhecimento e
  // dos manuais que a pessoa pode ver. A resposta certa tem de estar certa →
  // `fast`, como as perguntas dos manuais (pode baixar em ai.featureTiers).
  quiz_live: { label: "Quiz: perguntas novas em cada jogo", flag: "AI_QUIZ_LIVE", tier: "fast", essential: false },
  // FAQs a partir da base de conhecimento (semanal + "Gerar agora"): 1 pedido por documento, curto → lite.
  kb_faq: { label: "FAQs a partir da base de conhecimento", flag: "AI_KB_FAQ", tier: "lite", essential: false },
  // "Procurar formação por tema": escolhe no catálogo (só títulos e resumos) → lite; sem IA, pesquisa por palavras.
  training_search: { label: "Formação: procurar por tema", flag: "AI_TRAINING_TUTOR", tier: "lite", essential: false },
  // Tutor da Formação: respostas curtas só a partir dos manuais (trechos
  // escolhidos por palavras-chave + conteúdo do módulo em cache) — o lite chega.
  training_tutor: { label: "Tutor da formação", flag: "AI_TRAINING_TUTOR", tier: "lite", essential: false },
  // Comunicação com clientes (triagem/rascunhos/correspondências). Nada é
  // enviado sem aprovação humana; tudo `lite` (regra do dono).
  complaint_triage: { label: "Reclamações: triagem e rascunho", flag: "AI_COMPLAINT_TRIAGE", tier: "lite", essential: false },
  review_auto_draft: { label: "Críticas: rascunho automático", flag: "AI_REVIEW_AUTO_DRAFTS", tier: "lite", essential: false },
  whatsapp_triage: { label: "WhatsApp: intenção e urgência", flag: "AI_WHATSAPP_TRIAGE", tier: "lite", essential: false },
  // 17f: separar os emails novos pela caixa do tema. Jorge (8 out 2026): todas as caixas
  // partilhadas; o WhatsApp usa a intenção da triagem (sem 2.ª chamada) com o mesmo interruptor.
  mail_routing: { label: "Email e WhatsApp: separar pelas caixas", flag: "AI_MAIL_ROUTING", tier: "lite", essential: false },
  lost_found_match: { label: "Perdidos: correspondências", flag: "AI_LOST_FOUND_MATCH", tier: "lite", essential: false },
  // 21c: dúvidas de "é a mesma pessoa?" em Rever fichas (só factos e o 1.º nome, nunca contactos).
  crm_identity: { label: "Clientes: mesma pessoa?", flag: "AI_CRM_IDENTITY", tier: "lite", essential: false },
  // Assistente da app (chat da equipa): "como se usa" + perguntas aos dados
  // por ferramentas só de leitura. Lite (regra do dono; muitas mensagens curtas).
  assistant: { label: "Assistente (chat)", flag: "AI_ASSISTANT", tier: "lite", essential: false },
  // Plano MPV §5.2 (F0b): o Multis das pessoas do piloto (interruptor MPV + ai.assistantPilot)
  // no nível smart (AI_MODEL_SMART=gemini-4-argon). Teto € próprio (ai.assistantSmartBudget);
  // ao atingi-lo desce para `assistant` (lite) — "modo económico".
  assistant_smart: { label: "Multis do piloto (smart)", flag: "AI_ASSISTANT_SMART", tier: "smart", essential: false, ownBudget: true },
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
  // Marketing → Web & SEO: resumo semanal a partir dos totais (GA4/Search Console/PageSpeed).
  web_insight: { label: "Web & SEO: resumo semanal", flag: "AI_WEB_INSIGHT", tier: "lite", essential: false },
  // Google Business: rascunho de publicação (vai para o editor; publicar é humano).
  gbp_post_draft: { label: "Google Business: rascunho de publicação", flag: "AI_GBP_POSTS", tier: "lite", essential: false },
  // PageSpeed: "o que corrigir primeiro" explicado em PT-PT (só títulos e poupanças).
  pagespeed_explain: { label: "PageSpeed: explicar o que corrigir", flag: "AI_PAGESPEED_EXPLAIN", tier: "lite", essential: false },
  // Base de conhecimento: vetores dos trechos (modelo de embeddings, o mais
  // barato; o `tier` não se aplica — ver server/_core/ai/embed.ts) e leitura
  // de PDFs sem Drive (lite). Sem IA, a pesquisa cai para FULLTEXT/palavras.
  knowledge_embed: { label: "Base de conhecimento: índice (embeddings)", flag: "AI_KNOWLEDGE", tier: "lite", essential: false },
  knowledge_extract: { label: "Base de conhecimento: ler PDFs", flag: "AI_KNOWLEDGE", tier: "lite", essential: false },
  // D39 (Jorge, 3 out 2026): todos os anexos dos emails do RH passam pela IA → ficha do candidato + resumo.
  hr_email_attachments: { label: "RH: ler os anexos dos emails (CV)", flag: "AI_HR_EMAIL_ATTACHMENTS", tier: "lite", essential: false },
  healthcheck: { label: "Teste da ligação", flag: null, tier: "lite", essential: true },
} as const satisfies Record<string, AiFeatureDef>;

export type AiFeature = keyof typeof AI_FEATURES;
export const AI_FEATURE_IDS = Object.keys(AI_FEATURES) as AiFeature[];

/** Funcionalidades com teto € próprio (fora da conta do orçamento global). */
export const AI_OWN_BUDGET_FEATURES: readonly AiFeature[] = AI_FEATURE_IDS.filter((f) => (AI_FEATURES[f] as AiFeatureDef).ownBudget === true);

/** Esta funcionalidade tem teto próprio? PURA. */
export function hasOwnBudget(feature: string): boolean {
  return (AI_OWN_BUDGET_FEATURES as readonly string[]).includes(feature);
}

export function isAiFeature(v: string): v is AiFeature {
  return Object.prototype.hasOwnProperty.call(AI_FEATURES, v);
}

export function isAiTier(v: unknown): v is AiTier {
  return typeof v === "string" && (AI_TIERS as readonly string[]).includes(v);
}

/**
 * Raciocínio (Gemini 3.x) por funcionalidade — Definições → Parâmetros,
 * `ai.thinkingLevels` (plano MPV, F0a). "default" = não manda o nível (fica o
 * do próprio modelo); uma funcionalidade fora da lista segue a env
 * AI_THINKING_LEVEL (omissão "low"), como até aqui.
 */
export type AiThinkingLevel = "minimal" | "low" | "medium" | "high" | "default";
export const AI_THINKING_LEVELS: readonly AiThinkingLevel[] = ["minimal", "low", "medium", "high", "default"];

export function isAiThinkingLevel(v: unknown): v is AiThinkingLevel {
  return typeof v === "string" && (AI_THINKING_LEVELS as readonly string[]).includes(v);
}
