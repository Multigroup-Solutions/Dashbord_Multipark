/** Estado da IA para a UI (hub de Integrações, botões "IA") e teste barato. */
import { geminiConfig, selectProvider } from "./client";
import { aiFeatureEnabledFresh, isAiFeatureEnabled, type AiFeature } from "./features";
import { geminiModelFor, sttModelFor, type Env } from "./models";
import { runAi } from "./run";

export interface AiStatus {
  provider: "gemini" | "legacy" | null;
  mode: "studio" | "vertex" | "legacy" | null;
  models: { lite: string; fast: string; smart: string; stt: string } | null;
  warnings: string[];
}

/** PURA (só env). */
export function aiStatus(env: Env = process.env): AiStatus {
  const provider = selectProvider(env);
  const warnings: string[] = [];
  if (!provider) return { provider: null, mode: null, models: null, warnings: ["Sem GEMINI_API_KEY (nem Vertex, nem LLM_API_KEY): a IA está desligada."] };
  if (provider === "legacy") {
    warnings.push("A usar o fornecedor antigo (LLM_API_URL/LLM_API_KEY). Para o Gemini, definir GEMINI_API_KEY.");
    return { provider, mode: "legacy", models: null, warnings };
  }
  const cfg = geminiConfig(env)!;
  if (cfg.mode === "vertex" && !cfg.credentials) warnings.push("Vertex AI sem GOOGLE_SERVICE_ACCOUNT_JSON válido: só funciona com credenciais por omissão do ambiente.");
  const models = { lite: geminiModelFor("lite", env), fast: geminiModelFor("fast", env), smart: geminiModelFor("smart", env), stt: sttModelFor(env) };
  if (/preview/.test(models.smart)) warnings.push(`O modelo "smart" (${models.smart}) é preview: se for retirado, as chamadas caem para o "fast".`);
  return { provider, mode: cfg.mode, models, warnings };
}

/** Funcionalidade utilizável agora? (configurada + interruptores ligados). */
export function aiFeatureAvailable(feature: AiFeature, env: Env = process.env): boolean {
  if (feature === "radio_transcription") {
    if (!(selectProvider(env, feature) === "gemini" || String(env.OPENAI_API_KEY ?? "").trim())) return false;
  } else if (!selectProvider(env, feature)) return false;
  return isAiFeatureEnabled(feature, { env });
}

export async function aiFeatureAvailableFresh(feature: AiFeature, env: Env = process.env): Promise<boolean> {
  await aiFeatureEnabledFresh(feature);
  return aiFeatureAvailable(feature, env);
}

/** Teste barato (Integrações → Testar). */
export async function testAi(userId?: number | null): Promise<{ model: string; provider: string }> {
  const r = await runAi({ feature: "healthcheck", input: "Responde só: ok", maxTokens: 64, timeoutMs: 20_000, retries: 0, userId: userId ?? null });
  return { model: r.model, provider: r.provider };
}
