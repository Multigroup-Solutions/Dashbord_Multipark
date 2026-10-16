/**
 * tRPC `training.tutor` — Tutor da Formação (IA). Formandos: só os próprios
 * dados (o utilizador vem sempre da sessão). Formadores/admins (gerir a
 * Formação): só agregados anónimos das perguntas.
 */
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess } from "./_core/access";
import { roleRank } from "../shared/access";
import { TUTOR_CONTEXT_TYPES, TUTOR_MAX_INPUT_CHARS, TUTOR_SEARCH_MAX_CHARS, type TutorMode } from "../shared/trainingTutor";
import { safeCitationHref } from "../shared/knowledge";
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

  /**
   * D7: quem faz de tutor nesta página. `setting` = Definições
   * (training.tutorMode); `effective` = o que a página mostra: "multis" só com
   * o Multis ligado (senão o tutor próprio, para não ficar sem tutor).
   */
  mode: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const { trainingTutorMode } = await import("./trainingTutorMultis");
    const setting = await trainingTutorMode();
    if (setting !== "multis") return { setting, effective: "proprio" as TutorMode };
    const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
    return { setting, effective: ((await aiFeatureAvailableFresh("assistant")) ? "multis" : "proprio") as TutorMode };
  }),

  /**
   * D7: procurar nos manuais e vídeos da formação (sem IA) — a ferramenta
   * `formacao_procurar` do Multis chama isto COMO quem pergunta. Os mesmos
   * materiais e a mesma visibilidade do tutor: o módulo aberto e o catálogo
   * (publicados; admin e acima também os não publicados) + a base de
   * conhecimento quando "Tutor da formação usa a base" está ligado (só os
   * documentos que a pessoa pode ver).
   */
  search: protectedProcedure.input(z.object({
    question: z.string().trim().min(2, "Escreve o que procuras.").max(TUTOR_SEARCH_MAX_CHARS, `No máximo ${TUTOR_SEARCH_MAX_CHARS} caracteres.`),
    context: contextInput.optional(),
  })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const { searchTrainingContent } = await import("./trainingTutorMultis");
    const { tutorKnowledge } = await import("./trainingTutor");
    const [training, kb] = await Promise.all([
      searchTrainingContent(input.question, { role: ctx.user.role, module: input.context ?? null, topK: 4 }),
      tutorKnowledge(input.question, ctx.user.role, 3, { noEmbed: true }),
    ]);
    return {
      moduleTitle: training.moduleTitle,
      hits: training.hits,
      kb: kb.hits.map((h) => ({ title: h.title, section: h.section, text: h.text, href: safeCitationHref(h.href) })),
      failed: training.failed && kb.failed,
    };
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
