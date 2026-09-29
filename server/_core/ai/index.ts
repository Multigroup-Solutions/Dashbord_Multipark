/**
 * IA da aplicação — ponto de entrada público. Ver README.md (API) e docs/ia.md.
 *
 *   runAi()            chamada única (flags, orçamento, prazos, retries, registo)
 *   transcribeAudio()  rádio (Gemini áudio → Whisper só com OPENAI_API_KEY)
 *   redactPii()        política de dados pessoais
 *   checkRateLimit()   limitador por utilizador/IP (BD; serverless)
 */
export * from "./errors";
export { aiTrpcError } from "./trpcError";
export { AI_TIERS, DEFAULT_GEMINI_MODELS, geminiModelFor, resolveModel, sttModelFor, type AiTier } from "./models";
export {
  AI_FEATURES, AI_FEATURE_IDS, aiFeatureEnabledFresh, isAiFeature, isAiFeatureEnabled, resolveFeatureTier,
  type AiFeature, type AiFeatureDef, type AiFlag,
} from "./features";
export { aiConfigured, selectProvider, geminiConfig, legacyConfigured, type AiPart, type AiProviderId } from "./client";
export { runAi, parseStructured, DEFAULT_AI_TIMEOUT_MS, MAX_AI_TIMEOUT_MS, type RunAiBase, type RunAiResult } from "./run";
export { redactPii, firstName, type Redaction, type PiiKind } from "./pii";
export { checkRateLimit, ipKey, userKey, type RateLimitRule, type RateLimitResult } from "./rateLimit";
export { aiUsageSummary, logAiUsage, type AiUsageRow } from "./usage";
export { costEur, priceFor, type TokenUsage } from "./pricing";
export { draftReviewReply } from "./reviewReply";
export { transcribeAudio, type TranscriptionResult } from "./stt";
export { aiStatus, testAi, aiFeatureAvailable, aiFeatureAvailableFresh, type AiStatus } from "./status";
export * as prompts from "./prompts";
