/**
 * Perguntas de quiz a partir de um documento da base de conhecimento.
 *
 * Mesmo prompt e mesma validação das perguntas geradas a partir dos manuais
 * da Formação (server/trainingAttempts.ts), mas no nível `lite` (pedido do
 * dono: o mais barato) e SEMPRE como rascunho (`published = 0`): um formador
 * revê, corrige e publica em Formação → Quiz. O texto vai sem dados pessoais
 * (redactPii — os marcadores são tirados das perguntas).
 */
import { TRPCError } from "@trpc/server";

export async function generateKbQuizDrafts(input: {
  docId: number;
  title: string;
  text: string;
  count: number;
  categoryId: number | null;
  userId: number;
}): Promise<{ created: number; skipped: boolean; reason: string | null }> {
  const { aiFeatureAvailableFresh } = await import("../_core/ai/status");
  if (!(await aiFeatureAvailableFresh("quiz_generation"))) return { created: 0, skipped: true, reason: "IA das perguntas desligada ou não configurada." };
  const text = input.text.slice(0, 40_000);
  if (text.trim().length < 200) throw new TRPCError({ code: "BAD_REQUEST", message: "O documento tem pouco texto para gerar perguntas." });
  const n = Math.max(1, Math.min(15, Math.trunc(input.count)));
  const { runAi } = await import("../_core/ai/run");
  const { aiTrpcError } = await import("../_core/ai/trpcError");
  const { redactPii } = await import("../_core/ai/pii");
  const { QUIZ_SYSTEM, quizInstruction, quizResponseSchema } = await import("../_core/ai/prompts/quiz");
  const { filterDraftQuestions } = await import("../trainingAttempts");
  const red = redactPii(text);
  let drafts;
  try {
    const r = await runAi({
      feature: "quiz_generation",
      tier: "lite",
      system: QUIZ_SYSTEM,
      input: quizInstruction(input.title, red.text, n),
      schema: quizResponseSchema,
      maxTokens: Math.min(6000, 600 + n * 350),
      timeoutMs: 45_000,
      retries: 1,
      userId: input.userId,
      entity: "kb_document",
      entityId: input.docId,
    });
    drafts = filterDraftQuestions(r.output.questions.map((q) => ({
      ...q,
      question: red.strip(q.question), optionA: red.strip(q.optionA), optionB: red.strip(q.optionB),
      optionC: red.strip(q.optionC), optionD: red.strip(q.optionD), explanation: q.explanation ? red.strip(q.explanation) : q.explanation,
    }))).slice(0, n);
  } catch (err) {
    throw aiTrpcError(err);
  }
  if (!drafts.length) throw new TRPCError({ code: "BAD_REQUEST", message: "A IA não devolveu perguntas válidas. Tenta outra vez." });
  const { getDb } = await import("../db");
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
  const { quizQuestions } = await import("../../drizzle/schema");
  await d.insert(quizQuestions).values(drafts.map((q) => ({
    categoryId: input.categoryId, question: q.question, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD,
    correctOption: q.correctOption, explanation: q.explanation ?? null, difficulty: q.difficulty ?? "medium", points: 10,
    published: 0, sourceKbDocId: input.docId,
  })));
  return { created: drafts.length, skipped: false, reason: null };
}
