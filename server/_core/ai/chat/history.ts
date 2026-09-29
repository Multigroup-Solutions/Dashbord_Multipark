/**
 * Contexto de conversa barato: os últimos N turnos em texto + um resumo
 * EXTRATIVO (sem chamada à IA) das perguntas mais antigas. Cada mensagem é
 * cortada a um teto de caracteres. PURO.
 */
import type { AiTurn } from "../client";

export interface ChatMessageLike {
  role: "user" | "assistant";
  content: string;
}

export interface TrimOptions {
  /** Pares pergunta/resposta mantidos por inteiro (omissão 6). */
  maxTurns?: number;
  /** Teto por mensagem mantida (omissão 1200 caracteres). */
  maxCharsPerMessage?: number;
  /** Teto do resumo das mensagens antigas (omissão 600 caracteres). */
  summaryChars?: number;
}

export const DEFAULT_MAX_TURNS = 6;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Mensagens (mais antiga primeiro) → turnos para o modelo + resumo do que
 * ficou de fora. Começa sempre num turno do utilizador (o Gemini não aceita
 * uma conversa a começar pelo modelo).
 */
export function trimHistory(messages: ChatMessageLike[], opts: TrimOptions = {}): { turns: AiTurn[]; summary: string | null; dropped: number } {
  const maxTurns = Math.max(0, opts.maxTurns ?? DEFAULT_MAX_TURNS);
  const maxChars = Math.max(50, opts.maxCharsPerMessage ?? 1200);
  const summaryChars = Math.max(0, opts.summaryChars ?? 600);
  const clean = messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim());

  // Corta pelo número de perguntas do utilizador (um "turno" = pergunta + resposta).
  let userSeen = 0;
  let cut = clean.length;
  for (let i = clean.length - 1; i >= 0; i--) {
    if (clean[i].role === "user") {
      if (userSeen === maxTurns) break;
      userSeen++;
    }
    cut = i;
  }
  let kept = clean.slice(cut);
  while (kept.length && kept[0].role !== "user") kept = kept.slice(1);
  const older = clean.slice(0, clean.length - kept.length);

  let summary: string | null = null;
  if (summaryChars > 0) {
    const questions = older.filter((m) => m.role === "user").map((m) => clip(oneLine(m.content), 120));
    if (questions.length) summary = clip(`Perguntas anteriores nesta conversa: ${questions.join(" | ")}`, summaryChars);
  }

  return {
    turns: kept.map((m) => ({ role: m.role === "user" ? "user" : "model", text: clip(m.content.trim(), maxChars) })),
    summary,
    dropped: older.length,
  };
}
