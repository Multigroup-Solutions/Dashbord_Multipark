/**
 * tRPC `training.tutor` — Tutor da Formação (IA). Formandos: só os próprios
 * dados (o utilizador vem sempre da sessão). Formadores/admins (gerir a
 * Formação): só agregados anónimos das perguntas.
 */
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess } from "./_core/access";
import { roleRank } from "../shared/access";
import { TUTOR_CONTEXT_TYPES, TUTOR_MAX_INPUT_CHARS } from "../shared/trainingTutor";
import { getEmployeeByUserId } from "./db";
import { assessmentAnswers } from "./trainingAssessments";
import { TRPCError } from "@trpc/server";

const contextInput = z.object({ type: z.enum(TUTOR_CONTEXT_TYPES), id: z.number().int().min(0) });

async function myEmployeeId(userId: number): Promise<number | null> {
  const me = await getEmployeeByUserId(userId);
  return me?.employee?.id ?? null;
}

const seesUnpublished = (role: string) => roleRank(role) >= roleRank("admin");

export const trainingTutorRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
    return { available: await aiFeatureAvailableFresh("training_tutor") };
  }),

  /** Saudação com o progresso, próximo passo, sequência de dias e dicas (sem IA). */
  overview: protectedProcedure.input(z.object({ context: contextInput })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const { tutorOverview } = await import("./trainingTutor");
    return tutorOverview(ctx.user, await myEmployeeId(ctx.user.id), input.context, { includeUnpublished: seesUnpublished(ctx.user.role) });
  }),

  /** Últimas mensagens do PRÓPRIO neste módulo (não aceita outro utilizador). */
  history: protectedProcedure.input(z.object({ context: contextInput })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const { tutorHistory } = await import("./trainingTutor");
    return tutorHistory(ctx.user.id, input.context);
  }),

  clearHistory: protectedProcedure.input(z.object({ context: contextInput })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const { clearHistory } = await import("./trainingTutorStore");
    await clearHistory(ctx.user.id, input.context);
    return { success: true };
  }),

  ask: protectedProcedure.input(z.object({
    context: contextInput,
    question: z.string().trim().min(1, "Escreve a tua pergunta.").max(TUTOR_MAX_INPUT_CHARS, `A pergunta é demasiado longa (máx. ${TUTOR_MAX_INPUT_CHARS} caracteres).`),
    detail: z.boolean().optional(),
  })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const { tutorAsk } = await import("./trainingTutor");
    return tutorAsk(ctx.user, await myEmployeeId(ctx.user.id), input.context, input.question, {
      detail: input.detail, includeUnpublished: seesUnpublished(ctx.user.role),
    });
  }),

  /** Depois do quiz: explica as respostas erradas com o trecho do manual. */
  explainQuiz: protectedProcedure.input(z.object({ sessionId: z.number().int().positive(), answers: assessmentAnswers })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const employeeId = await myEmployeeId(ctx.user.id);
    if (employeeId == null) throw new TRPCError({ code: "NOT_FOUND", message: "Sem ficha de colaborador." });
    const { explainQuiz } = await import("./trainingTutor");
    return explainQuiz(ctx.user, employeeId, input.sessionId, input.answers);
  }),

  /** Formadores: o que os formandos perguntam mais, por módulo (anónimo). */
  trainerQuestions: protectedProcedure.input(z.object({ days: z.number().int().min(1).max(365).default(90) }).optional()).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { trainerQuestionsView } = await import("./trainingTutor");
    return trainerQuestionsView(input?.days ?? 90);
  }),
});
