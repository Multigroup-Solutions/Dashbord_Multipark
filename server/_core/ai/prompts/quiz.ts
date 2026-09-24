/** Perguntas de escolha múltipla a partir de um manual da formação. */
import { z } from "zod";
import { PT_PT_RULE } from "./common";

/** Resposta do modelo (larga); cada pergunta é depois validada a sério. */
export const quizResponseSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      optionA: z.string(),
      optionB: z.string(),
      optionC: z.string(),
      optionD: z.string(),
      correctOption: z.enum(["A", "B", "C", "D"]),
      explanation: z.string().nullable(),
      difficulty: z.enum(["easy", "medium", "hard"]).nullable(),
    }),
  ),
});

export const QUIZ_SYSTEM = [
  "És formador numa empresa de parques de estacionamento e valet (Multipark).",
  "A partir do manual dado, crias perguntas de escolha múltipla com 4 opções (A–D), UMA só correta, e uma explicação curta.",
  PT_PT_RULE,
  "Pergunta só o que está no manual; opções erradas plausíveis; varia a letra da opção correta.",
].join("\n");

export function quizInstruction(title: string, text: string, n: number): string {
  return `Manual: "${title}"\n\n${text}\n\nGera ${n} perguntas.`;
}
