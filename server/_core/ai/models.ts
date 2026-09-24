/**
 * Níveis de modelo → id do modelo (env), por fornecedor.
 *
 *  - lite  (AI_MODEL_LITE):  o mais barato — a OMISSÃO de todas as
 *    funcionalidades (regra do dono: o modelo mais barato sempre que possível);
 *  - fast  (AI_MODEL_FAST):  só onde o lite falha (PDFs de faturas com várias
 *    páginas, perguntas da formação);
 *  - smart (AI_MODEL_SMART): não usado por omissão; disponível para quem o
 *    pedir por configuração. Se o modelo não existir (404), cai para o `fast`.
 *
 * O nível de cada funcionalidade muda-se sem deploy (features.ts).
 *
 * Omissões (Gemini API, set 2026 — ver docs/ia.md): modelos ESTÁVEIS da
 * geração atual; o Pro só existe em "preview", daí a queda automática para o
 * fast. Mudar de modelo = mudar a env, sem deploy de código.
 */
import type { AiTier } from "../../../shared/aiFeatures";
export { AI_TIERS, type AiTier } from "../../../shared/aiFeatures";

export type Env = Record<string, string | undefined>;

export const DEFAULT_GEMINI_MODELS: Record<AiTier, string> = {
  lite: "gemini-3.1-flash-lite",
  fast: "gemini-3.8-flash",
  smart: "gemini-3.1-pro-preview",
};

const ENV_BY_TIER: Record<AiTier, string> = { lite: "AI_MODEL_LITE", fast: "AI_MODEL_FAST", smart: "AI_MODEL_SMART" };
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,127}$/;

function clean(v: string | undefined): string {
  return String(v ?? "").trim();
}

/** Modelo de um nível no Gemini (env válida → omissão). PURA. */
export function geminiModelFor(tier: AiTier, env: Env = process.env): string {
  const raw = clean(env[ENV_BY_TIER[tier]]);
  return raw && MODEL_ID.test(raw) ? raw : DEFAULT_GEMINI_MODELS[tier];
}

/** Modelo da transcrição (AI_MODEL_STT → nível lite). PURA. */
export function sttModelFor(env: Env = process.env): string {
  const raw = clean(env.AI_MODEL_STT);
  return raw && MODEL_ID.test(raw) ? raw : geminiModelFor("lite", env);
}

/**
 * Modelo de um nível para o fornecedor. O caminho antigo (Anthropic /
 * OpenAI-compatível) só tem um modelo (LLM_MODEL): usa-o para todos os
 * níveis, a não ser que AI_MODEL_<NÍVEL> esteja definido. PURA.
 */
export function resolveModel(tier: AiTier, provider: "gemini" | "legacy", env: Env = process.env, legacyDefault = ""): string {
  if (provider === "gemini") return geminiModelFor(tier, env);
  const tierRaw = clean(env[ENV_BY_TIER[tier]]);
  if (tierRaw && MODEL_ID.test(tierRaw) && !tierRaw.startsWith("gemini-")) return tierRaw;
  return clean(env.LLM_MODEL) || legacyDefault;
}

/** Nível para onde se cai quando o modelo não existe (404). PURA. */
export function fallbackTier(tier: AiTier): AiTier | null {
  return tier === "smart" ? "fast" : null;
}

/** Gemini 3.x aceita `thinkingLevel`; modelos mais antigos recusam-no. PURA. */
export function supportsThinkingLevel(model: string): boolean {
  return /^gemini-(3|[4-9])/.test(model);
}
