/**
 * `runAi` — a ÚNICA porta de entrada para a IA na aplicação.
 *
 *   interruptores (AI_ENABLED + da funcionalidade) → fornecedor configurado →
 *   orçamento mensal → modelo do nível → pedido com prazo (AbortSignal) →
 *   novas tentativas em 429/5xx/rede com espera exponencial → validação zod
 *   (saída estruturada) → registo de uso/custo (só metadados).
 *
 * Erros: sempre AiError (errors.ts); a UI só recebe `err.userMessage`.
 * Nunca escreve no log o prompt, a resposta ou dados pessoais.
 */
import type { z } from "zod";
import {
  getProvider, selectProvider,
  type AiPart, type AiProvider, type AiProviderId, type AiToolCall, type AiToolDeclaration, type AiToolRound, type AiTurn, type ProviderResponse,
} from "./client";
import { getOrCreateContextCache, forgetContextCache } from "./contextCache";
import {
  AiDisabledError,
  AiError,
  AiInvalidOutputError,
  AiNotConfiguredError,
  AiTimeoutError,
  aiErrorCode,
  toAiError,
} from "./errors";
import { AI_FEATURES, aiFeatureEnabledFresh, loadFeatureTierSettings, resolveFeatureTier, type AiFeature } from "./features";
import { toProviderJsonSchema } from "./jsonSchema";
import { fallbackTier, resolveModel, type AiTier } from "./models";
import { costEur, type TokenUsage } from "./pricing";
import { enforceBudget, getPriceOverrides, logAiUsage } from "./usage";

/** Prazo por omissão (a função do Vercel morre aos 60 s). */
export const DEFAULT_AI_TIMEOUT_MS = 25_000;
export const MAX_AI_TIMEOUT_MS = 50_000;
export const DEFAULT_MAX_TOKENS = 1024;
/** Voltas de ferramentas por pedido (cada volta é mais uma chamada paga). */
export const MAX_TOOL_ROUNDS = 4;
export const MAX_TOOL_CALLS_PER_ROUND = 4;

/**
 * Function calling: o runAi declara as ferramentas, executa as que o modelo
 * pedir (`execute` — nunca deve lançar; se lançar, o modelo recebe um erro
 * genérico) e devolve-lhe os resultados até haver resposta final.
 */
export interface AiToolsOption {
  declarations: AiToolDeclaration[];
  execute: (call: AiToolCall) => Promise<Record<string, unknown>>;
  /** Máximo de voltas (omissão 3, teto MAX_TOOL_ROUNDS). */
  maxRounds?: number;
}

export interface RunAiBase {
  feature: AiFeature;
  /**
   * Nível pedido por este ponto de chamada (omissão: o do catálogo). As
   * sobreposições de Definições (`ai.featureTiers`) e AI_TIER_<FUNC> ganham.
   */
  tier?: AiTier;
  /** Força um modelo (ex.: transcrição com AI_MODEL_STT). */
  model?: string;
  system?: string;
  /** Turnos anteriores da conversa (texto), antes de `input`. */
  history?: AiTurn[];
  input: string | AiPart[];
  /** Ferramentas (function calling). Não combina com `schema`. */
  tools?: AiToolsOption;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  /** Novas tentativas além da primeira (omissão 2). */
  retries?: number;
  /** Para o registo (quem e sobre quê) — nunca conteúdo. */
  userId?: number | null;
  entity?: string | null;
  entityId?: number | null;
  /** Guarda o `system` numa cache de contexto do Gemini (prefixos longos e estáveis). */
  cacheSystem?: boolean | { ttlSeconds?: number };
  env?: Record<string, string | undefined>;
}

export interface RunAiResult<T> {
  output: T;
  text: string;
  provider: AiProviderId;
  model: string;
  tier: AiTier;
  usage: TokenUsage;
  costEur: number;
  latencyMs: number;
  attempts: number;
  /** Ferramentas chamadas (por ordem), se houve. */
  toolCalls?: AiToolCall[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Espera antes da tentativa n (1, 2, …): 400 ms, 800 ms, 1,6 s… com ±25%. PURA (salvo o aleatório). */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = 400 * 2 ** Math.max(0, attempt - 1);
  return Math.round(Math.min(4000, base) * (0.75 + rand() * 0.5));
}

function normalizeParts(input: string | AiPart[]): AiPart[] {
  return typeof input === "string" ? [{ type: "text", text: input }] : input;
}

/** Resposta JSON → validada pelo schema (sem regex nem "cercas" de markdown). */
export function parseStructured<S extends z.ZodType>(text: string, schema: S): z.output<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    throw new AiInvalidOutputError("json");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new AiInvalidOutputError("schema");
  return r.data;
}

export function runAi<S extends z.ZodType>(opts: RunAiBase & { schema: S }): Promise<RunAiResult<z.output<S>>>;
export function runAi(opts: RunAiBase & { schema?: undefined }): Promise<RunAiResult<string>>;
export async function runAi(opts: RunAiBase & { schema?: z.ZodType }): Promise<RunAiResult<unknown>> {
  const env = opts.env ?? process.env;
  const def = AI_FEATURES[opts.feature];
  if (!(await aiFeatureEnabledFresh(opts.feature))) throw new AiDisabledError(opts.feature);
  let tier: AiTier = resolveFeatureTier(opts.feature, { requested: opts.tier, settings: await loadFeatureTierSettings(), env });
  const providerId = selectProvider(env, opts.feature);
  if (!providerId) throw new AiNotConfiguredError();
  const provider = getProvider(providerId, env);
  let model = opts.model || resolveModel(tier, providerId, env);

  const meta = { feature: opts.feature, userId: opts.userId ?? null, entity: opts.entity ?? null, entityId: opts.entityId ?? null };
  const started = Date.now();

  try {
    await enforceBudget(def.essential);
  } catch (err) {
    await logAiUsage({ ...meta, tier, provider: providerId, model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costEur: 0, latencyMs: 0, status: "blocked", errorCode: "budget" });
    throw err;
  }

  const timeoutMs = Math.max(1000, Math.min(MAX_AI_TIMEOUT_MS, opts.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS));
  const deadline = started + timeoutMs;
  const maxTokens = Math.max(16, Math.floor(opts.maxTokens ?? DEFAULT_MAX_TOKENS));
  const retries = Math.max(0, Math.min(4, opts.retries ?? 2));
  const parts = normalizeParts(opts.input);
  const jsonSchema = opts.schema ? toProviderJsonSchema(opts.schema) : undefined;
  const overrides = await getPriceOverrides();
  const tools = opts.tools?.declarations.length ? opts.tools : undefined;
  const maxRounds = Math.max(1, Math.min(MAX_TOOL_ROUNDS, tools?.maxRounds ?? 3));

  const usageTotal: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, audioInputTokens: 0 };
  let cost = 0;
  let attempts = 0;
  let switchedModel = false;
  let useCache = !!(opts.cacheSystem && opts.system);
  let invalidOutputs = 0;

  const finish = async (status: "ok" | "error", errorCode: string | null) => {
    await logAiUsage({
      ...meta, tier, provider: providerId, model,
      inputTokens: usageTotal.inputTokens, outputTokens: usageTotal.outputTokens, cachedTokens: usageTotal.cachedTokens,
      costEur: cost, latencyMs: Date.now() - started, status, errorCode,
    });
  };

  type Step = { kind: "final"; output: unknown; text: string } | { kind: "tools"; res: ProviderResponse };

  /** Um pedido ao fornecedor com as novas tentativas (429/5xx/rede, resposta inválida 1×). */
  const attempt = async (toolRounds: AiToolRound[]): Promise<Step> => {
    let lastErr: AiError | null = null;
    let tries = 0;
    while (tries <= retries) {
      const remaining = deadline - Date.now();
      if (remaining < 500) { lastErr = lastErr ?? new AiTimeoutError(); break; }
      tries++;
      attempts++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      (timer as any).unref?.();
      let cachedContent: string | undefined;
      try {
        if (useCache && opts.system) {
          const ttl = typeof opts.cacheSystem === "object" ? opts.cacheSystem.ttlSeconds : undefined;
          cachedContent = (await getOrCreateContextCache(provider, model, opts.system, { ttlSeconds: ttl, signal: controller.signal, tools: tools?.declarations })) ?? undefined;
        }
        const res = await callProvider(provider, {
          model, system: opts.system, history: opts.history, parts, jsonSchema, maxOutputTokens: maxTokens, temperature: opts.temperature,
          signal: controller.signal, timeoutMs: remaining, cachedContent,
          ...(tools ? { tools: tools.declarations, toolRounds } : {}),
        });
        addUsage(usageTotal, res.usage);
        cost += costEur(model, res.usage, overrides);
        if (tools && res.toolCalls?.length) return { kind: "tools", res };
        if (!res.text.trim()) throw new AiInvalidOutputError(`empty:${res.finishReason ?? "?"}`);
        const output = opts.schema ? parseStructured(res.text, opts.schema) : res.text.trim();
        return { kind: "final", output, text: res.text };
      } catch (err) {
        const e = controller.signal.aborted && !(err instanceof AiInvalidOutputError) ? new AiTimeoutError() : toAiError(err);
        lastErr = e;
        // Cache de contexto expirada do lado do fornecedor → esquecer e repetir sem ela.
        if (cachedContent && (e.status === 404 || e.status === 400)) {
          forgetContextCache(cachedContent);
          useCache = false;
          tries--;
          attempts--;
          continue;
        }
        // Modelo inexistente (404) no nível smart → cai para o fast, uma vez.
        if (e.status === 404 && !switchedModel) {
          const fb = fallbackTier(tier);
          if (fb && !opts.model) {
            switchedModel = true;
            tier = fb;
            model = resolveModel(fb, providerId, env);
            tries--; // a troca de modelo não gasta uma tentativa
            attempts--;
            continue;
          }
        }
        if (e instanceof AiTimeoutError || !e.retryable || tries > retries) break;
        // Resposta inválida: repete no máximo UMA vez (cada tentativa custa).
        if (e.code === "invalid_output" && ++invalidOutputs > 1) break;
        const wait = backoffMs(tries);
        if (Date.now() + wait + 500 >= deadline) break;
        await sleep(wait);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr ?? new AiTimeoutError();
  };

  try {
    const rounds: AiToolRound[] = [];
    for (;;) {
      const step = await attempt(rounds);
      if (step.kind === "final") {
        await finish("ok", null);
        return {
          output: step.output, text: step.text, provider: providerId, model, tier, usage: usageTotal, costEur: cost,
          latencyMs: Date.now() - started, attempts, toolCalls: rounds.flatMap((r) => r.calls),
        };
      }
      // O modelo pediu ferramentas: executa-as (nunca lançam) e devolve-lhe os resultados.
      if (rounds.length >= maxRounds) throw new AiInvalidOutputError("tool_rounds");
      const calls = (step.res.toolCalls ?? []).slice(0, MAX_TOOL_CALLS_PER_ROUND);
      const results: AiToolRound["results"] = [];
      for (const call of calls) results.push({ call, response: await executeTool(tools!.execute, call) });
      rounds.push({ modelRaw: step.res.raw, calls, results });
    }
  } catch (err) {
    const final = toAiError(err);
    console.warn(`[ai] ${opts.feature} falhou: ${aiErrorCode(final)} (tentativas: ${attempts}, ${providerId}/${model})`);
    await finish("error", aiErrorCode(final));
    throw final;
  }
}

/** Executa uma ferramenta; um erro vira `{ error }` para o modelo (sem detalhe interno). */
async function executeTool(execute: AiToolsOption["execute"], call: AiToolCall): Promise<Record<string, unknown>> {
  try {
    const r = await execute(call);
    return r && typeof r === "object" && !Array.isArray(r) ? r : { result: r ?? null };
  } catch {
    return { error: "Não foi possível obter estes dados." };
  }
}

async function callProvider(provider: AiProvider, req: Parameters<AiProvider["generate"]>[0]): Promise<ProviderResponse> {
  return provider.generate(req);
}

function addUsage(total: TokenUsage, u: TokenUsage): void {
  total.inputTokens += u.inputTokens || 0;
  total.outputTokens += u.outputTokens || 0;
  total.cachedTokens += u.cachedTokens || 0;
  total.audioInputTokens = (total.audioInputTokens ?? 0) + (u.audioInputTokens ?? 0);
}
