/**
 * Tabela de preços (estimativa) para o custo registado em ai_usage_log.
 *
 * Preços da Gemini API (nível pago, "Standard"), em USD por 1M de tokens,
 * lidos da página oficial de preços em set 2026, convertidos a USD_TO_EUR.
 * Os preços mudam: a sobreposição em Definições → Parâmetros
 * (`ai.priceOverridesEur`, já em EUR) ganha sempre a esta tabela.
 * Modelo desconhecido → preço do nível fast (estimativa conservadora).
 */
import type { AiPriceOverrides } from "../../../shared/appSettings";

export const USD_TO_EUR = 0.86;

export interface ModelPrice {
  /** por 1M tokens de entrada (texto/imagem/vídeo) */
  input: number;
  /** por 1M tokens de saída (inclui "thinking") */
  output: number;
  /** por 1M tokens lidos da cache de contexto */
  cached?: number;
  /** por 1M tokens de áudio à entrada (quando difere) */
  audioInput?: number;
}

/** USD por 1M tokens. */
const GEMINI_PRICES_USD: Record<string, ModelPrice> = {
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cached: 0.025, audioInput: 0.5 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cached: 0.03 },
  // Flash 3.6/3.7/3.8: preço promocional até 31 dez 2026 (depois 1.50/7.50).
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.5-flash": { input: 1.5, output: 9, cached: 0.15 },
  "gemini-3.1-pro-preview": { input: 2, output: 12, cached: 0.2 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cached: 0.01, audioInput: 0.3 },
  // Embeddings (base de conhecimento): só entrada.
  "gemini-embedding-001": { input: 0.15, output: 0 },
};

const toEur = (p: ModelPrice): ModelPrice => ({
  input: p.input * USD_TO_EUR,
  output: p.output * USD_TO_EUR,
  cached: p.cached != null ? p.cached * USD_TO_EUR : undefined,
  audioInput: p.audioInput != null ? p.audioInput * USD_TO_EUR : undefined,
});

export const DEFAULT_PRICES_EUR: Record<string, ModelPrice> = Object.fromEntries(
  Object.entries(GEMINI_PRICES_USD).map(([k, v]) => [k, toEur(v)]),
);

const FALLBACK_EUR = toEur(GEMINI_PRICES_USD["gemini-3.8-flash"]);

/** Preço em EUR de um modelo (sobreposição → tabela → fallback). PURA. */
export function priceFor(model: string, overrides?: AiPriceOverrides | null): ModelPrice {
  const o = overrides?.[model];
  if (o) return o;
  // Aceita sufixos de versão (ex.: "gemini-3.8-flash-001").
  const base = DEFAULT_PRICES_EUR[model] ?? Object.entries(DEFAULT_PRICES_EUR).find(([k]) => model.startsWith(`${k}-`))?.[1];
  return base ?? FALLBACK_EUR;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** entrada em áudio (parte de inputTokens) */
  audioInputTokens?: number;
}

/**
 * Custo (EUR) de uma chamada. `inputTokens` inclui os lidos da cache
 * (convenção do Gemini: promptTokenCount conta tudo) — esses pagam o preço
 * da cache em vez do de entrada. PURA.
 */
export function costEur(model: string, usage: TokenUsage, overrides?: AiPriceOverrides | null): number {
  const p = priceFor(model, overrides);
  const cached = Math.max(0, Math.min(usage.cachedTokens, usage.inputTokens));
  const audio = Math.max(0, Math.min(usage.audioInputTokens ?? 0, usage.inputTokens - cached));
  const plain = Math.max(0, usage.inputTokens - cached - audio);
  const c = (plain * p.input + audio * (p.audioInput ?? p.input) + cached * (p.cached ?? p.input) + Math.max(0, usage.outputTokens) * p.output) / 1_000_000;
  return Math.round(c * 1_000_000) / 1_000_000;
}

/** Whisper (OpenAI): USD 0,006 por minuto de áudio. PURA. */
export function whisperCostEur(durationSec: number | null | undefined): number {
  const min = Math.max(0, Number(durationSec ?? 0)) / 60;
  return Math.round(min * 0.006 * USD_TO_EUR * 1_000_000) / 1_000_000;
}
