/**
 * Embeddings (vetores de texto) — a porta de entrada da base de conhecimento.
 *
 * Mesmas regras do `runAi`: interruptores (AI_ENABLED + AI_KNOWLEDGE) →
 * fornecedor (só Gemini; o caminho antigo não tem embeddings) → orçamento
 * mensal → pedido com prazo e novas tentativas (429/5xx) → registo de uso
 * (só metadados: nº de tokens estimado, custo, latência; nunca o texto).
 *
 * Modelo: AI_MODEL_EMBED → `gemini-embedding-001` (o mais barato da Gemini
 * API para texto), com 768 dimensões (Matryoshka: vetores mais curtos, mesma
 * qualidade útil e 4× menos espaço na BD).
 */
import { AiDisabledError, AiNotConfiguredError, AiTimeoutError, AiUnsupportedInputError, aiErrorCode, toAiError, type AiError } from "./errors";
import { getProvider, selectProvider, type EmbedRequest } from "./client";
import { AI_FEATURES, aiFeatureEnabledFresh, type AiFeature } from "./features";
import { costEur } from "./pricing";
import { enforceBudget, getPriceOverrides, logAiUsage } from "./usage";
import { backoffMs } from "./run";

export const DEFAULT_EMBED_MODEL = "gemini-embedding-001";
export const EMBED_DIMENSIONS = 768;
/** Textos por pedido (limite da API: 100 por lote). */
export const EMBED_BATCH = 50;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,127}$/;

export function embedModelFor(env: Record<string, string | undefined> = process.env): string {
  const raw = String(env.AI_MODEL_EMBED ?? "").trim();
  return raw && MODEL_ID.test(raw) ? raw : DEFAULT_EMBED_MODEL;
}

/** Tokens estimados (≈ 4 caracteres por token em PT). PURA. */
export function estimateTokens(text: string): number {
  return Math.ceil(String(text ?? "").length / 4);
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  costEur: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Vetores de `texts` (mesma ordem). Lança AiError (desligada, sem Gemini,
 * orçamento, prazo…). Os textos já devem vir sem dados pessoais (redactPii).
 */
export async function embedTexts(opts: {
  feature: Extract<AiFeature, "knowledge_embed">;
  texts: string[];
  taskType: EmbedRequest["taskType"];
  userId?: number | null;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<EmbedResult> {
  const env = opts.env ?? process.env;
  if (!(await aiFeatureEnabledFresh(opts.feature))) throw new AiDisabledError(opts.feature);
  const providerId = selectProvider(env, opts.feature);
  if (!providerId) throw new AiNotConfiguredError();
  const provider = getProvider(providerId, env);
  if (providerId !== "gemini" || !provider.embed) throw new AiUnsupportedInputError("embeddings");
  const model = embedModelFor(env);
  const texts = opts.texts.map((t) => String(t ?? "").slice(0, 8000));
  const started = Date.now();
  const tokens = texts.reduce((s, t) => s + estimateTokens(t), 0);
  const meta = { feature: opts.feature, tier: "lite", provider: providerId, model, userId: opts.userId ?? null, entity: null, entityId: null };

  try {
    await enforceBudget(AI_FEATURES[opts.feature].essential);
  } catch (err) {
    await logAiUsage({ ...meta, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costEur: 0, latencyMs: 0, status: "blocked", errorCode: "budget" });
    throw err;
  }
  if (!texts.length) return { vectors: [], model, costEur: 0 };

  const deadline = started + Math.max(2_000, Math.min(45_000, opts.timeoutMs ?? 20_000));
  const vectors: number[][] = [];
  try {
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      let lastErr: AiError | null = null;
      let done = false;
      for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining < 500) { lastErr = new AiTimeoutError(); break; }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remaining);
        (timer as any).unref?.();
        try {
          const out = await provider.embed({ model, texts: batch, taskType: opts.taskType, dimensions: EMBED_DIMENSIONS, signal: controller.signal, timeoutMs: remaining });
          if (out.length !== batch.length || out.some((v) => !v.length)) throw toAiError(new Error("embeddings incompletos"));
          vectors.push(...out);
          done = true;
        } catch (err) {
          lastErr = controller.signal.aborted ? new AiTimeoutError() : toAiError(err);
          if (!lastErr.retryable || lastErr instanceof AiTimeoutError) break;
          const wait = backoffMs(attempt);
          if (Date.now() + wait + 500 >= deadline) break;
          await sleep(wait);
        } finally {
          clearTimeout(timer);
        }
      }
      if (!done) throw lastErr ?? new AiTimeoutError();
    }
  } catch (err) {
    const e = toAiError(err);
    console.warn(`[ai] ${opts.feature} falhou: ${aiErrorCode(e)} (${providerId}/${model})`);
    await logAiUsage({ ...meta, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costEur: 0, latencyMs: Date.now() - started, status: "error", errorCode: aiErrorCode(e) });
    throw e;
  }
  const cost = costEur(model, { inputTokens: tokens, outputTokens: 0, cachedTokens: 0 }, await getPriceOverrides());
  await logAiUsage({ ...meta, inputTokens: tokens, outputTokens: 0, cachedTokens: 0, costEur: cost, latencyMs: Date.now() - started, status: "ok", errorCode: null });
  return { vectors, model, costEur: cost };
}

// ─── Vetores (PURAS) ─────────────────────────────────────────────────────────

/** Vetor → base64 (Float32, little-endian). PURA. */
export function encodeVector(v: readonly number[]): string {
  const buf = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => buf.writeFloatLE(Number.isFinite(x) ? x : 0, i * 4));
  return buf.toString("base64");
}

/** base64 → vetor; null se vazio/inválido. PURA. */
export function decodeVector(raw: string | null | undefined): Float32Array | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const buf = Buffer.from(s, "base64");
  if (!buf.length || buf.length % 4) return null;
  const out = new Float32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** Semelhança de cosseno (0 se tamanhos diferentes ou vetor nulo). PURA. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
