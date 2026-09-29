/**
 * Transcrição de áudio (rádio). Gemini com o áudio como entrada (modelo
 * AI_MODEL_STT → nível lite). O Whisper da OpenAI só entra quando
 * OPENAI_API_KEY está EXPLICITAMENTE definida — como fornecedor principal
 * (sem Gemini) ou como recurso se o Gemini falhar — e fala sempre com
 * api.openai.com (antes ia para o LLM_API_URL, o que partia com a Anthropic).
 *
 * Interruptor: AI_RADIO. Conta para o orçamento e fica em ai_usage_log.
 */
import { fetchWithTimeout } from "../fetchWithTimeout";
import { selectProvider } from "./client";
import {
  AiDisabledError,
  AiError,
  AiNotConfiguredError,
  AiProviderError,
  AiUnsupportedInputError,
  aiErrorCode,
  toAiError,
} from "./errors";
import { AI_FEATURES, aiFeatureEnabledFresh } from "./features";
import { sttModelFor } from "./models";
import { whisperCostEur } from "./pricing";
import { RADIO_TRANSCRIBE_INSTRUCTION, RADIO_TRANSCRIBE_SYSTEM } from "./prompts/radio";
import { runAi } from "./run";
import { enforceBudget, logAiUsage } from "./usage";

export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";
const NO_SPEECH = /^\(?sem fala\)?\.?$/i;

export interface TranscribeOptions {
  audioUrl: string;
  language?: string;
  userId?: number | null;
  entity?: string | null;
  entityId?: number | null;
  env?: Record<string, string | undefined>;
}

export interface TranscriptionResult {
  text: string;
  provider: "gemini" | "openai";
  model: string;
}

interface Audio { data: Buffer; mimeType: string }

/** Tipo MIME a usar (content-type → extensão do URL → mp3). PURA. */
export function audioMimeType(contentType: string | null | undefined, url: string): string {
  const ct = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  if (ct.startsWith("audio/")) return ct === "audio/mp3" ? "audio/mpeg" : ct;
  const ext = (url.split("?")[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? "").toLowerCase();
  const map: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", webm: "audio/webm" };
  return map[ext] ?? "audio/mpeg";
}

async function downloadAudio(url: string): Promise<Audio> {
  if (!/^https?:\/\//i.test(url)) throw new AiUnsupportedInputError("url");
  let res: Response;
  try {
    res = await fetchWithTimeout(url, { timeoutMs: 10_000 });
  } catch (err) {
    throw toAiError(err);
  }
  if (!res.ok) throw new AiProviderError(res.status, false, "download");
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_AUDIO_BYTES) throw new AiUnsupportedInputError("size");
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_AUDIO_BYTES) throw new AiUnsupportedInputError("size");
  if (!data.length) throw new AiUnsupportedInputError("empty");
  return { data, mimeType: audioMimeType(res.headers.get("content-type"), url) };
}

function extFor(mime: string): string {
  const m: Record<string, string> = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/aac": "aac", "audio/flac": "flac", "audio/webm": "webm" };
  return m[mime] ?? "mp3";
}

async function whisper(audio: Audio, opts: TranscribeOptions, env: Record<string, string | undefined>): Promise<TranscriptionResult> {
  const started = Date.now();
  const meta = { feature: "radio_transcription", tier: "lite", provider: "openai", model: "whisper-1", userId: opts.userId ?? null, entity: opts.entity ?? null, entityId: opts.entityId ?? null };
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio.data)], { type: audio.mimeType }), `audio.${extFor(audio.mimeType)}`);
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("language", (opts.language || "pt").slice(0, 5));
    const res = await fetchWithTimeout(WHISPER_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${String(env.OPENAI_API_KEY).trim()}` },
      body: form,
      timeoutMs: 32_000,
    });
    if (!res.ok) {
      await res.text().catch(() => "");
      throw toAiError({ status: res.status });
    }
    const j = (await res.json()) as { text?: unknown; duration?: unknown };
    const text = typeof j.text === "string" ? j.text.trim() : "";
    await logAiUsage({ ...meta, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costEur: whisperCostEur(Number(j.duration) || 0), latencyMs: Date.now() - started, status: "ok" });
    return { text, provider: "openai", model: "whisper-1" };
  } catch (err) {
    const e = toAiError(err);
    await logAiUsage({ ...meta, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costEur: 0, latencyMs: Date.now() - started, status: "error", errorCode: aiErrorCode(e) });
    throw e;
  }
}

/** Transcreve um áudio por URL. Lança AiError (mensagem segura em `userMessage`). */
export async function transcribeAudio(opts: TranscribeOptions): Promise<TranscriptionResult> {
  const env = opts.env ?? process.env;
  if (!(await aiFeatureEnabledFresh("radio_transcription"))) throw new AiDisabledError("radio_transcription");
  const useGemini = selectProvider(env, "radio_transcription") === "gemini";
  const whisperAvailable = !!String(env.OPENAI_API_KEY ?? "").trim();
  if (!useGemini && !whisperAvailable) throw new AiNotConfiguredError();

  const audio = await downloadAudio(opts.audioUrl);

  if (useGemini) {
    const t0 = Date.now();
    try {
      const model = sttModelFor(env);
      const r = await runAi({
        feature: "radio_transcription",
        tier: "lite",
        model,
        system: RADIO_TRANSCRIBE_SYSTEM,
        input: [{ type: "audio", mimeType: audio.mimeType, data: audio.data.toString("base64") }, { type: "text", text: RADIO_TRANSCRIBE_INSTRUCTION }],
        maxTokens: 4096,
        timeoutMs: 32_000,
        retries: 1,
        userId: opts.userId, entity: opts.entity, entityId: opts.entityId,
        env,
      });
      return { text: NO_SPEECH.test(r.output.trim()) ? "" : r.output.trim(), provider: "gemini", model: r.model };
    } catch (err) {
      const e = err instanceof AiError ? err : toAiError(err);
      // Desligado/orçamento/não configurado: o Whisper também não deve correr.
      if (!whisperAvailable || ["disabled", "budget", "not_configured"].includes(e.code)) throw e;
      // Sem tempo para uma segunda tentativa dentro dos 60 s do Vercel.
      if (Date.now() - t0 > 20_000) throw e;
      console.warn(`[ai] transcrição Gemini falhou (${aiErrorCode(e)}); a tentar o Whisper`);
    }
  } else {
    await enforceBudget(AI_FEATURES.radio_transcription.essential);
  }
  return whisper(audio, opts, env);
}
