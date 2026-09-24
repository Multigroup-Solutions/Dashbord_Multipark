/**
 * Rádio: transcrição (Gemini áudio; Whisper só com OPENAI_API_KEY) + resumo
 * operacional em 1–2 frases (nível lite). Partilhado pelo tRPC
 * (operations.radio.transcribe) e pela API externa (/api/external/radio-upload).
 *
 * O resumo é best-effort: se falhar, a transcrição fica gravada sem resumo.
 * Dados pessoais da transcrição (telefones, matrículas…) são trocados por
 * marcadores antes do resumo e repostos depois (o fornecedor não os vê).
 */
import { redactPii } from "./_core/ai/pii";
import { RADIO_SUMMARY_SYSTEM } from "./_core/ai/prompts/radio";
import { runAi } from "./_core/ai/run";
import { transcribeAudio } from "./_core/ai/stt";

export async function summarizeRadio(transcription: string, ctx: { userId?: number | null } = {}): Promise<string> {
  if (!transcription.trim()) return "";
  const red = redactPii(transcription.slice(0, 8000));
  try {
    const r = await runAi({
      feature: "radio_summary",
      system: RADIO_SUMMARY_SYSTEM,
      input: red.text,
      maxTokens: 300,
      timeoutMs: 10_000,
      retries: 1,
      userId: ctx.userId ?? null,
      entity: "radio_transcription",
    });
    return red.restore(r.output).slice(0, 1000);
  } catch {
    return "";
  }
}

/** Lança AiError se a transcrição falhar (a UI mostra `userMessage`). */
export async function transcribeAndSummarizeRadio(audioUrl: string, ctx: { userId?: number | null } = {}): Promise<{ transcription: string; summary: string }> {
  const t = await transcribeAudio({ audioUrl, language: "pt", userId: ctx.userId ?? null, entity: "radio_transcription" });
  const summary = await summarizeRadio(t.text, ctx);
  return { transcription: t.text, summary };
}
