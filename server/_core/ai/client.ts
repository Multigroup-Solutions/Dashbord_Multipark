/**
 * Fornecedores de IA por trás de uma interface única.
 *
 *  - "gemini" (omissão): SDK oficial @google/genai. Duas formas:
 *      · Google AI Studio — GEMINI_API_KEY;
 *      · Vertex AI (UE) — GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT
 *        (+ GOOGLE_CLOUD_LOCATION, omissão europe-west1) e a conta de serviço
 *        em GOOGLE_SERVICE_ACCOUNT_JSON (JSON cru ou base64).
 *  - "legacy": o cliente antigo (server/_core/llm.ts) — Anthropic quando
 *    LLM_API_URL contém "anthropic", senão OpenAI-compatível.
 *
 * Escolha: AI_PROVIDER_<FUNCIONALIDADE> (ex.: AI_PROVIDER_EXPENSE_OCR=legacy)
 * → AI_PROVIDER → automático (Gemini se configurado, senão o antigo).
 */
import { parseSwitch } from "../featureFlags";
import { AiNotConfiguredError, AiUnsupportedInputError } from "./errors";
import { supportsThinkingLevel, type Env } from "./models";
import type { TokenUsage } from "./pricing";

export type AiProviderId = "gemini" | "legacy";

/** Partes da entrada. Binários em base64 (sem o prefixo data:). */
export type AiPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "pdf"; data: string }
  | { type: "audio"; mimeType: string; data: string };

export interface ProviderRequest {
  model: string;
  system?: string;
  parts: AiPart[];
  /** JSON Schema da resposta (já no subconjunto aceite pelo Gemini). */
  jsonSchema?: Record<string, unknown>;
  maxOutputTokens: number;
  temperature?: number;
  signal: AbortSignal;
  timeoutMs: number;
  /** Nome de uma cache de contexto (Gemini) com o `system` já lá dentro. */
  cachedContent?: string;
}

export interface ProviderResponse {
  text: string;
  model: string;
  finishReason: string | null;
  usage: TokenUsage;
}

export interface ContextCacheHandle {
  name: string;
  expiresAt: number;
}

export interface AiProvider {
  id: AiProviderId;
  generate(req: ProviderRequest): Promise<ProviderResponse>;
  /** Só Gemini: guarda um prefixo longo e estável (system) para reutilizar. */
  createCache?(p: { model: string; system: string; ttlSeconds: number; signal: AbortSignal }): Promise<ContextCacheHandle>;
}

const clean = (v: string | undefined) => String(v ?? "").trim();

// ─── Configuração (PURA) ────────────────────────────────────────────────────

export type GeminiConfig =
  | { mode: "studio"; apiKey: string }
  | { mode: "vertex"; project: string; location: string; credentials: Record<string, unknown> | null };

/** Conta de serviço (JSON cru ou base64); null se ausente/inválida. PURA. */
export function parseServiceAccount(raw: string | undefined): Record<string, unknown> | null {
  const v = clean(raw);
  if (!v) return null;
  const tryJson = (s: string) => {
    try {
      const j = JSON.parse(s);
      return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
    } catch { return null; }
  };
  return tryJson(v) ?? tryJson(Buffer.from(v, "base64").toString("utf8"));
}

export function geminiConfig(env: Env = process.env): GeminiConfig | null {
  const project = clean(env.GOOGLE_CLOUD_PROJECT);
  if (parseSwitch(env.GOOGLE_GENAI_USE_VERTEXAI) === true && project) {
    return {
      mode: "vertex",
      project,
      location: clean(env.GOOGLE_CLOUD_LOCATION) || "europe-west1",
      credentials: parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON),
    };
  }
  const apiKey = clean(env.GEMINI_API_KEY);
  return apiKey ? { mode: "studio", apiKey } : null;
}

export function legacyConfigured(env: Env = process.env): boolean {
  return !!(clean(env.LLM_API_KEY) || clean(env.OPENAI_API_KEY));
}

function normalizeProviderName(raw: string | undefined): AiProviderId | "auto" {
  const v = clean(raw).toLowerCase();
  if (["gemini", "google", "vertex", "vertexai"].includes(v)) return "gemini";
  if (["legacy", "anthropic", "openai", "llm"].includes(v)) return "legacy";
  return "auto";
}

/**
 * Fornecedor para uma funcionalidade; null = IA não configurada. Um fornecedor
 * pedido explicitamente mas sem configuração também dá null (nunca cai
 * silenciosamente para outro — seria mandar dados para onde não se pediu). PURA.
 */
export function selectProvider(env: Env = process.env, feature?: string): AiProviderId | null {
  const perFeature = feature ? normalizeProviderName(env[`AI_PROVIDER_${feature.toUpperCase()}`]) : "auto";
  const wanted = perFeature !== "auto" ? perFeature : normalizeProviderName(env.AI_PROVIDER);
  if (wanted === "gemini") return geminiConfig(env) ? "gemini" : null;
  if (wanted === "legacy") return legacyConfigured(env) ? "legacy" : null;
  if (geminiConfig(env)) return "gemini";
  if (legacyConfigured(env)) return "legacy";
  return null;
}

/** Há IA configurada (para qualquer funcionalidade)? */
export function aiConfigured(env: Env = process.env): boolean {
  return selectProvider(env) != null;
}

/** Opções do construtor do SDK (sem retries próprios: o runAi trata disso). PURA. */
export function geminiClientOptions(cfg: GeminiConfig): Record<string, unknown> {
  const httpOptions = { retryOptions: { attempts: 1 } };
  if (cfg.mode === "studio") return { apiKey: cfg.apiKey, httpOptions };
  return {
    vertexai: true,
    project: cfg.project,
    location: cfg.location,
    ...(cfg.credentials ? { googleAuthOptions: { credentials: cfg.credentials, scopes: ["https://www.googleapis.com/auth/cloud-platform"] } } : {}),
    httpOptions,
  };
}

/** Nível de raciocínio (Gemini 3.x). AI_THINKING_LEVEL=off omite-o. PURA. */
export function thinkingLevelFor(model: string, env: Env = process.env): string | null {
  if (!supportsThinkingLevel(model)) return null;
  const v = clean(env.AI_THINKING_LEVEL).toLowerCase();
  if (v === "off" || v === "default") return null;
  return ["minimal", "low", "medium", "high"].includes(v) ? v : "low";
}

// ─── Gemini ─────────────────────────────────────────────────────────────────

function toGeminiParts(parts: AiPart[]): any[] {
  return parts.map((p) => {
    switch (p.type) {
      case "text": return { text: p.text };
      case "image": return { inlineData: { mimeType: p.mimeType, data: p.data } };
      case "pdf": return { inlineData: { mimeType: "application/pdf", data: p.data } };
      case "audio": return { inlineData: { mimeType: p.mimeType, data: p.data } };
    }
  });
}

/** usageMetadata do Gemini → contagens (o "thinking" paga-se como saída). PURA. */
export function geminiUsage(meta: any): TokenUsage {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const audio = Array.isArray(meta?.promptTokensDetails)
    ? meta.promptTokensDetails.filter((d: any) => d?.modality === "AUDIO").reduce((a: number, d: any) => a + n(d?.tokenCount), 0)
    : 0;
  return {
    inputTokens: n(meta?.promptTokenCount),
    outputTokens: n(meta?.candidatesTokenCount) + n(meta?.thoughtsTokenCount),
    cachedTokens: n(meta?.cachedContentTokenCount),
    audioInputTokens: audio,
  };
}

let geminiClient: { key: string; client: any } | null = null;

async function getGeminiClient(env: Env): Promise<any> {
  const cfg = geminiConfig(env);
  if (!cfg) throw new AiNotConfiguredError();
  const key = JSON.stringify(cfg);
  if (geminiClient?.key === key) return geminiClient.client;
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI(geminiClientOptions(cfg) as any);
  geminiClient = { key, client };
  return client;
}

export function createGeminiProvider(env: Env = process.env): AiProvider {
  return {
    id: "gemini",
    async generate(req) {
      const ai = await getGeminiClient(env);
      const config: Record<string, unknown> = {
        maxOutputTokens: req.maxOutputTokens,
        abortSignal: req.signal,
        httpOptions: { timeout: req.timeoutMs, retryOptions: { attempts: 1 } },
      };
      // Com cache de contexto, o system já está na cache (a API recusa os dois).
      if (req.cachedContent) config.cachedContent = req.cachedContent;
      else if (req.system) config.systemInstruction = req.system;
      if (req.jsonSchema) {
        config.responseMimeType = "application/json";
        config.responseJsonSchema = req.jsonSchema;
      }
      if (req.temperature != null) config.temperature = req.temperature;
      const level = thinkingLevelFor(req.model, env);
      if (level) config.thinkingConfig = { thinkingLevel: level };
      const res = await ai.models.generateContent({
        model: req.model,
        contents: [{ role: "user", parts: toGeminiParts(req.parts) }],
        config,
      });
      return {
        text: String(res?.text ?? ""),
        model: String(res?.modelVersion || req.model),
        finishReason: res?.candidates?.[0]?.finishReason ?? null,
        usage: geminiUsage(res?.usageMetadata),
      };
    },
    async createCache({ model, system, ttlSeconds, signal }) {
      const ai = await getGeminiClient(env);
      const c = await ai.caches.create({
        model,
        config: { systemInstruction: system, ttl: `${Math.max(60, Math.floor(ttlSeconds))}s`, displayName: "multipark-ctx", abortSignal: signal },
      });
      if (!c?.name) throw new Error("cache sem nome");
      const exp = c.expireTime ? Date.parse(c.expireTime) : NaN;
      return { name: String(c.name), expiresAt: Number.isFinite(exp) ? exp : Date.now() + ttlSeconds * 1000 };
    },
  };
}

// ─── Caminho antigo (Anthropic / OpenAI-compatível) ─────────────────────────

export function createLegacyProvider(): AiProvider {
  return {
    id: "legacy",
    async generate(req) {
      const { invokeLegacyLLM } = await import("../llm");
      const content: any[] = req.parts.map((p) => {
        switch (p.type) {
          case "text": return { type: "text", text: p.text };
          case "image": return { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}`, detail: "high" } };
          case "pdf": return { type: "file_url", file_url: { url: `data:application/pdf;base64,${p.data}`, mime_type: "application/pdf" } };
          case "audio": throw new AiUnsupportedInputError("audio");
        }
      });
      const messages: any[] = [];
      if (req.system) messages.push({ role: "system", content: req.system });
      messages.push({ role: "user", content: content.length === 1 && content[0].type === "text" ? content[0].text : content });
      const r = await invokeLegacyLLM({
        messages,
        maxTokens: req.maxOutputTokens,
        model: req.model || undefined,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        ...(req.jsonSchema ? { response_format: { type: "json_schema", json_schema: { name: "resposta", schema: req.jsonSchema, strict: false } } } : {}),
      });
      const c = r.choices?.[0]?.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? "").join("") : "";
      return {
        text,
        model: r.model || req.model,
        finishReason: r.choices?.[0]?.finish_reason ?? null,
        usage: { inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0, cachedTokens: 0 },
      };
    },
  };
}

// ─── Registo (com gancho para testes) ───────────────────────────────────────

let testProviders: Partial<Record<AiProviderId, AiProvider>> | null = null;

/** Só testes: substitui os fornecedores (null repõe). */
export function setAiProvidersForTests(p: Partial<Record<AiProviderId, AiProvider>> | null): void {
  testProviders = p;
  geminiClient = null;
}

export function getProvider(id: AiProviderId, env: Env = process.env): AiProvider {
  const t = testProviders?.[id];
  if (t) return t;
  return id === "gemini" ? createGeminiProvider(env) : createLegacyProvider();
}
