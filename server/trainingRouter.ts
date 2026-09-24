/**
 * Router tRPC `training` (Formação e apoio). Extraído de routers.ts para
 * isolar a Formação: conteúdos, quiz/exames servidos pelo servidor, percursos
 * obrigatórios, dashboard de conclusão, promoções e certificados.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { notifyOwner } from "./_core/notification";
import { projectScope } from "./cityScope";
import { assessmentAnswers, trainingResultScope } from "./trainingAssessments";
import { CENTER_SCOPED_ROLES, type RhViewer } from "./rhAccess";
import {
  getDb, logActivity, getEmployeeByUserId, resolveProjectIds,
  getTrainingCategories, createTrainingCategory, deleteTrainingCategory,
  getTrainingVideos, createTrainingVideo, deleteTrainingVideo,
  getTrainingManuals, createTrainingManual, updateTrainingManual, deleteTrainingManual,
  getFAQs, createFAQ, updateFAQ, deleteFAQ,
  getQuizQuestions, createQuizQuestion, deleteQuizQuestion,
  getCareerExams, createCareerExam, deleteCareerExam, getCareerExamQuestions, createCareerExamQuestion, getCareerExamAttempts,
} from "./db";
import { careerExamQuestions, careerExams, employees, quizQuestions, trainingManuals, trainingVideos } from "../drizzle/schema";
import { TRAINING_ITEM_TYPES } from "./trainingRules";
import { requireAccess, employeeBelowCondition } from "./_core/access";
import { roleRank, scopeFor, seesBeyondOwn } from "../shared/access";
import { trainingTutorRouter } from "./trainingTutorRouter";

/** Fichas da equipa de um team_leader (abaixo dele, na cidade) + a própria. */
async function trainingTeamIds(user: { id: number; role: string }): Promise<Set<number>> {
  const d = await dbOrThrow();
  const { sql } = await import("drizzle-orm");
  const rows = await d.select({ id: employees.id }).from(employees)
    .where(and(projectScope(employees.projectId), sql`${await employeeBelowCondition(user, sql`${employees.id}`)}`));
  const out = new Set(rows.map(r => r.id));
  const me = await getEmployeeByUserId(user.id);
  if (me?.employee?.id != null) out.add(me.employee.id);
  return out;
}

/** team_leader (alcance "below_city"): só a ficha dele e as da equipa. */
async function assertTrainingTeam(user: { id: number; role: string }, employeeId: number) {
  if (scopeFor(user, "formacao") !== "below_city") return;
  const me = await getEmployeeByUserId(user.id);
  if (me?.employee?.id === employeeId) return;
  const d = await dbOrThrow();
  const { sql } = await import("drizzle-orm");
  const rows = await d.select({ id: employees.id }).from(employees)
    .where(and(eq(employees.id, employeeId), sql`${await employeeBelowCondition(user, sql`${employees.id}`)}`)).limit(1);
  if (!rows.length) throw new TRPCError({ code: "FORBIDDEN", message: "Só vês o progresso da tua equipa." });
}

const atLeast = (role: string, min: string) => roleRank(role) >= roleRank(min);
function requireRole(role: string, min: string) {
  if (!atLeast(role, min)) throw new TRPCError({ code: "FORBIDDEN", message: "Acesso não autorizado." });
}

async function rhViewer(user: { id: number; role: string }): Promise<RhViewer> {
  const me = await getEmployeeByUserId(user.id);
  let scope: number[] | null = null;
  if ((CENTER_SCOPED_ROLES as readonly string[]).includes(user.role)) {
    const pid = me?.employee?.projectId ?? null;
    scope = pid != null ? await resolveProjectIds(pid) : [];
  }
  return { id: user.id, role: user.role, employeeId: me?.employee?.id ?? null, scopeProjectIds: scope };
}

async function myEmployeeId(userId: number): Promise<number> {
  const me = await getEmployeeByUserId(userId);
  if (!me) throw new TRPCError({ code: "NOT_FOUND", message: "Sem ficha de colaborador. Pede ao admin para te registar primeiro." });
  return me.employee.id;
}

async function dbOrThrow() {
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
  return d;
}

/** Todos os colaboradores pedidos têm de estar no âmbito (cidade) de quem pede. */
async function assertEmployeesInScope(ids: number[]) {
  if (!ids.length) return;
  const d = await dbOrThrow();
  const rows = await d.select({ id: employees.id }).from(employees).where(and(inArray(employees.id, ids), projectScope(employees.projectId)));
  if (rows.length !== new Set(ids).size) throw new TRPCError({ code: "FORBIDDEN", message: "Há colaboradores fora do teu âmbito." });
}

const LEVELS = [
  "condutor_1", "condutor_2", "condutor_3", "condutor_4",
  "terminal_1", "terminal_2", "terminal_3", "terminal_4",
  "front_1", "front_2", "front_3", "front_4",
  "team_leader", "supervisor",
] as const;
const MANUAL_TYPES = ["manual", "update", "news", "procedure", "link"] as const;
const option = z.enum(["A", "B", "C", "D"]);
const questionFields = {
  question: z.string().min(1).max(2000), optionA: z.string().min(1), optionB: z.string().min(1), optionC: z.string().min(1), optionD: z.string().min(1),
  correctOption: option, explanation: z.string().max(4000).nullable().optional(),
};
const pathInput = z.object({
  name: z.string().min(1).max(255), description: z.string().max(4000).nullable().optional(),
  targetRole: z.string().max(32).nullable().optional(), city: z.enum(["lisboa", "porto", "faro"]).nullable().optional(),
  active: z.boolean().optional(), isDefaultOnboarding: z.boolean().optional(), blocksEscala: z.boolean().optional(),
  dueDays: z.number().int().min(1).max(365).optional(),
});

export const trainingRouter = router({
  // ─── Tutor (IA) — server/trainingTutorRouter.ts ─────────────────────────
  tutor: trainingTutorRouter,

  // ─── Categorias ──────────────────────────────────────────────────────────
  categories: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    return getTrainingCategories();
  }),
  createCategory: protectedProcedure.input(z.object({ name: z.string().min(1), description: z.string().optional(), icon: z.string().optional(), sortOrder: z.number().optional() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const result = await createTrainingCategory(input);
    await logActivity({ userId: ctx.user.id, action: "create", entity: "training_category", entityId: result.id, details: input.name });
    return result;
  }),
  categoryUsage: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { categoryUsage } = await import("./trainingPaths");
    return categoryUsage(input.id);
  }),
  // Só super_admin; uma categoria com conteúdo NÃO se apaga (os vídeos exigem
  // categoria — mover primeiro os conteúdos para outra).
  deleteCategory: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.user.role, "super_admin");
    const { categoryUsage } = await import("./trainingPaths");
    const u = await categoryUsage(input.id);
    if (u.total > 0) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `A categoria tem ${u.total} conteúdo(s) (${u.videos} vídeos, ${u.manuals} manuais, ${u.faqs} FAQs, ${u.questions} perguntas). Move-os para outra categoria antes de a apagar.` });
    }
    await deleteTrainingCategory(input.id);
    await logActivity({ userId: ctx.user.id, action: "delete", entity: "training_category", entityId: input.id, details: "" });
    return { success: true };
  }),

  // ─── Vídeos ──────────────────────────────────────────────────────────────
  videos: protectedProcedure.input(z.object({ categoryId: z.number().optional() })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    return getTrainingVideos(input.categoryId);
  }),
  createVideo: protectedProcedure.input(z.object({ categoryId: z.number(), title: z.string().min(1), description: z.string().optional(), videoUrl: z.string().min(1), thumbnailUrl: z.string().optional(), durationMinutes: z.number().optional(), careerLevel: z.string().max(32).optional() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const result = await createTrainingVideo({ ...input, createdBy: ctx.user.id });
    await logActivity({ userId: ctx.user.id, action: "create", entity: "training_video", entityId: result.id, details: input.title });
    return result;
  }),
  updateVideo: protectedProcedure.input(z.object({ id: z.number(), categoryId: z.number().optional(), title: z.string().min(1).optional(), description: z.string().nullable().optional(), videoUrl: z.string().min(1).optional(), thumbnailUrl: z.string().nullable().optional(), durationMinutes: z.number().int().min(0).nullable().optional(), careerLevel: z.string().max(32).nullable().optional() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { id, ...data } = input;
    const d = await dbOrThrow();
    await d.update(trainingVideos).set(data).where(eq(trainingVideos.id, id));
    await logActivity({ userId: ctx.user.id, action: "update", entity: "training_video", entityId: id, details: data.title || "" });
    return { success: true };
  }),
  deleteVideo: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    await deleteTrainingVideo(input.id);
    await logActivity({ userId: ctx.user.id, action: "delete", entity: "training_video", entityId: input.id, details: "" });
    return { success: true };
  }),

  // ─── Manuais ─────────────────────────────────────────────────────────────
  manuals: protectedProcedure.input(z.object({ categoryId: z.number().optional(), type: z.string().optional() })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    return getTrainingManuals(input.categoryId, input.type, atLeast(ctx.user.role, "admin"));
  }),
  createManual: protectedProcedure.input(z.object({ categoryId: z.number().optional(), title: z.string().min(1), content: z.string(), type: z.enum(MANUAL_TYPES).optional(), fileUrl: z.string().optional(), fileKey: z.string().optional(), fileName: z.string().optional(), fileMimeType: z.string().optional(), careerLevel: z.string().max(32).optional() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const result = await createTrainingManual({ ...input, createdBy: ctx.user.id });
    await logActivity({ userId: ctx.user.id, action: "create", entity: "training_manual", entityId: result.id, details: input.title });
    return result;
  }),
  uploadManualFile: protectedProcedure.input(z.object({ fileName: z.string().min(1).max(255), fileBase64: z.string(), mimeType: z.string() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { storagePut } = await import("./storage");
    const buffer = Buffer.from(input.fileBase64, "base64");
    if (buffer.length > 4 * 1024 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Ficheiro demasiado grande (máx 4MB)." });
    const safe = input.fileName.replace(/[^\w.\-]+/g, "_").slice(-120);
    const key = `training/manuals/${Date.now()}-${safe}`;
    const { url } = await storagePut(key, buffer, input.mimeType);
    return { url, key, fileName: input.fileName, mimeType: input.mimeType };
  }),
  updateManual: protectedProcedure.input(z.object({ id: z.number(), categoryId: z.number().nullable().optional(), title: z.string().min(1).optional(), content: z.string().optional(), type: z.enum(MANUAL_TYPES).optional(), published: z.boolean().optional(), fileUrl: z.string().nullable().optional(), fileKey: z.string().nullable().optional(), fileName: z.string().nullable().optional(), fileMimeType: z.string().nullable().optional(), careerLevel: z.string().max(32).nullable().optional() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { id, ...data } = input;
    await updateTrainingManual(id, data);
    await logActivity({ userId: ctx.user.id, action: "update", entity: "training_manual", entityId: id, details: data.title || (data.published !== undefined ? (data.published ? "publicado" : "despublicado") : "") });
    return { success: true };
  }),
  deleteManual: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    await deleteTrainingManual(input.id);
    await logActivity({ userId: ctx.user.id, action: "delete", entity: "training_manual", entityId: input.id, details: "" });
    return { success: true };
  }),
  /** URL assinada (temporária) do anexo de um manual. */
  manualFileUrl: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const d = await dbOrThrow();
    const [m] = await d.select().from(trainingManuals).where(eq(trainingManuals.id, input.id)).limit(1);
    if (!m || (!m.published && !atLeast(ctx.user.role, "admin"))) throw new TRPCError({ code: "NOT_FOUND", message: "Manual não encontrado." });
    if (m.type === "link") return { url: m.fileUrl ?? null, signed: false };
    const src = m.fileKey || m.fileUrl;
    if (!src) return { url: null, signed: false };
    const { storagePresignGet } = await import("./storage");
    const out = await storagePresignGet(src, { fallbackUrl: m.fileUrl, expiresSeconds: 900 });
    let url = out.url || null;
    // Modo local / URL relativa: o endpoint autenticado /api/file resolve pela key.
    if (url && !/^https?:\/\//.test(url) && m.fileKey) url = `/api/file/${encodeURI(m.fileKey)}`;
    return { url, signed: out.signed };
  }),

  // ─── FAQs ────────────────────────────────────────────────────────────────
  faqs: protectedProcedure.input(z.object({ categoryId: z.number().optional() })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    return getFAQs(input.categoryId);
  }),
  createFAQ: protectedProcedure.input(z.object({ categoryId: z.number().optional(), question: z.string().min(1), answer: z.string().min(1), sortOrder: z.number().optional() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const result = await createFAQ(input);
    await logActivity({ userId: ctx.user.id, action: "create", entity: "faq", entityId: result.id, details: input.question });
    return result;
  }),
  updateFAQ: protectedProcedure.input(z.object({ id: z.number(), question: z.string().min(1).optional(), answer: z.string().min(1).optional(), sortOrder: z.number().optional() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { id, ...data } = input;
    await updateFAQ(id, data);
    await logActivity({ userId: ctx.user.id, action: "update", entity: "faq", entityId: id, details: data.question || "" });
    return { success: true };
  }),
  deleteFAQ: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    await deleteFAQ(input.id);
    await logActivity({ userId: ctx.user.id, action: "delete", entity: "faq", entityId: input.id, details: "" });
    return { success: true };
  }),

  // ─── Quiz ────────────────────────────────────────────────────────────────
  // ADMIN: com correctOption e rascunhos (para edição)
  quizQuestions: protectedProcedure.input(z.object({ categoryId: z.number().optional() })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    return getQuizQuestions(input.categoryId);
  }),
  /** Quantas perguntas publicadas há (o jogo é servido por startQuiz). */
  quizInfo: protectedProcedure.input(z.object({ categoryId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const d = await dbOrThrow();
    const [r] = await d.select({ n: sql<number>`COUNT(*)` }).from(quizQuestions)
      .where(and(eq(quizQuestions.published, 1), input?.categoryId ? eq(quizQuestions.categoryId, input.categoryId) : undefined));
    const { QUIZ_MAX_PER_DAY, QUIZ_QUESTIONS_PER_GAME } = await import("./trainingRules");
    return { published: Number(r?.n ?? 0), perGame: QUIZ_QUESTIONS_PER_GAME, maxPerDay: QUIZ_MAX_PER_DAY };
  }),
  createQuizQuestion: protectedProcedure.input(z.object({ categoryId: z.number().optional(), ...questionFields, difficulty: z.enum(["easy", "medium", "hard"]).optional(), points: z.number().int().min(1).max(10000).optional() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const result = await createQuizQuestion({ ...input, explanation: input.explanation ?? undefined });
    await logActivity({ userId: ctx.user.id, action: "create", entity: "quiz_question", entityId: result.id, details: input.question });
    return result;
  }),
  updateQuizQuestion: protectedProcedure.input(z.object({ id: z.number(), categoryId: z.number().nullable().optional(), question: z.string().min(1).optional(), optionA: z.string().min(1).optional(), optionB: z.string().min(1).optional(), optionC: z.string().min(1).optional(), optionD: z.string().min(1).optional(), correctOption: option.optional(), explanation: z.string().nullable().optional(), difficulty: z.enum(["easy", "medium", "hard"]).optional(), points: z.number().int().min(1).max(10000).optional(), published: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { id, published, ...rest } = input;
    const d = await dbOrThrow();
    await d.update(quizQuestions).set({ ...rest, ...(published !== undefined ? { published: published ? 1 : 0 } : {}) }).where(eq(quizQuestions.id, id));
    await logActivity({ userId: ctx.user.id, action: "update", entity: "quiz_question", entityId: id, details: published !== undefined ? (published ? "publicada" : "rascunho") : (rest.question ?? "") });
    return { success: true };
  }),
  deleteQuizQuestion: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    await deleteQuizQuestion(input.id);
    await logActivity({ userId: ctx.user.id, action: "delete", entity: "quiz_question", entityId: input.id, details: "" });
    return { success: true };
  }),
  generateQuizDrafts: protectedProcedure.input(z.object({ manualId: z.number(), count: z.number().int().min(1).max(20).default(5) })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { generateQuizDrafts } = await import("./trainingAttempts");
    return generateQuizDrafts(input.manualId, input.count, ctx.user.id);
  }),
  llmStatus: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
    return { configured: await aiFeatureAvailableFresh("quiz_generation") };
  }),
  /** Começa um jogo: o servidor escolhe e guarda as perguntas servidas. */
  startQuiz: protectedProcedure.input(z.object({ categoryId: z.number().optional() }).optional()).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const employeeId = await myEmployeeId(ctx.user.id);
    const { startQuizAttempt } = await import("./trainingAttempts");
    return startQuizAttempt(employeeId, input?.categoryId ?? null);
  }),
  submitQuiz: protectedProcedure.input(z.object({ sessionId: z.number().int().positive(), answers: assessmentAnswers })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const employeeId = await myEmployeeId(ctx.user.id);
    const { submitAttempt } = await import("./trainingAttempts");
    const r = await submitAttempt(employeeId, input.sessionId, input.answers);
    if (r.kind !== "quiz") throw new TRPCError({ code: "BAD_REQUEST", message: "Tentativa inválida." });
    return r;
  }),
  quizRanking: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const { quizRanking } = await import("./trainingAttempts");
    return quizRanking();
  }),
  /** Nomes a mostrar no ranking — só para ids que jogaram (extra+). */
  rankingNames: protectedProcedure.input(z.object({ employeeIds: z.array(z.number().int().positive()).max(200) })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const { displayNames } = await import("./trainingAttempts");
    const m = await displayNames(input.employeeIds);
    return Array.from(m.entries()).map(([id, name]) => ({ id, name }));
  }),

  // ─── Exames de carreira ─────────────────────────────────────────────────
  careerExams: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const exams = await getCareerExams();
    if (!exams.length) return [];
    const d = await dbOrThrow();
    const counts = await d.select({ examId: careerExamQuestions.examId, n: sql<number>`COUNT(*)` }).from(careerExamQuestions)
      .where(inArray(careerExamQuestions.examId, exams.map(e => e.id))).groupBy(careerExamQuestions.examId);
    const m = new Map(counts.map(c => [c.examId, Number(c.n)]));
    return exams.map(e => ({ ...e, questionCount: m.get(e.id) ?? 0 }));
  }),
  createCareerExam: protectedProcedure.input(z.object({
    level: z.enum(LEVELS), title: z.string().min(1), description: z.string().optional(),
    passingScore: z.number().int().min(1).max(100), timeLimitMinutes: z.number().int().min(1).max(240).optional(),
    validityMonths: z.number().int().min(0).max(120).optional(), maxAttemptsPerDay: z.number().int().min(1).max(20).optional(),
  })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { validityMonths, maxAttemptsPerDay, ...base } = input;
    const result = await createCareerExam(base);
    if (validityMonths !== undefined || maxAttemptsPerDay !== undefined) {
      const d = await dbOrThrow();
      await d.update(careerExams).set({ ...(validityMonths !== undefined ? { validityMonths } : {}), ...(maxAttemptsPerDay !== undefined ? { maxAttemptsPerDay } : {}) }).where(eq(careerExams.id, result.id));
    }
    await logActivity({ userId: ctx.user.id, action: "create", entity: "career_exam", entityId: result.id, details: input.title });
    return result;
  }),
  updateCareerExam: protectedProcedure.input(z.object({
    id: z.number(), title: z.string().min(1).optional(), description: z.string().nullable().optional(),
    passingScore: z.number().int().min(1).max(100).optional(), timeLimitMinutes: z.number().int().min(1).max(240).nullable().optional(),
    validityMonths: z.number().int().min(0).max(120).optional(), maxAttemptsPerDay: z.number().int().min(1).max(20).optional(),
  })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { id, ...data } = input;
    const d = await dbOrThrow();
    await d.update(careerExams).set(data).where(eq(careerExams.id, id));
    await logActivity({ userId: ctx.user.id, action: "update", entity: "career_exam", entityId: id, details: data.title ?? "" });
    return { success: true };
  }),
  deleteCareerExam: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.user.role, "super_admin");
    await deleteCareerExam(input.id);
    await logActivity({ userId: ctx.user.id, action: "update", entity: "career_exam", entityId: input.id, details: "Exame arquivado; resultados preservados" });
    return { success: true };
  }),
  careerExamQuestions: protectedProcedure.input(z.object({ examId: z.number() })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    return getCareerExamQuestions(input.examId);
  }),
  createCareerExamQuestion: protectedProcedure.input(z.object({ examId: z.number(), ...questionFields, points: z.number().int().min(1).max(10000).optional() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    if (!(await getCareerExams()).some(exam => exam.id === input.examId)) throw new TRPCError({ code: "NOT_FOUND", message: "Exame não disponível." });
    return createCareerExamQuestion({ ...input, explanation: input.explanation ?? undefined });
  }),
  updateCareerExamQuestion: protectedProcedure.input(z.object({ id: z.number(), question: z.string().min(1).optional(), optionA: z.string().min(1).optional(), optionB: z.string().min(1).optional(), optionC: z.string().min(1).optional(), optionD: z.string().min(1).optional(), correctOption: option.optional(), explanation: z.string().nullable().optional(), points: z.number().int().min(1).max(10000).optional() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { id, ...data } = input;
    const d = await dbOrThrow();
    await d.update(careerExamQuestions).set(data).where(eq(careerExamQuestions.id, id));
    await logActivity({ userId: ctx.user.id, action: "update", entity: "career_exam_question", entityId: id, details: data.question ?? "" });
    return { success: true };
  }),
  deleteCareerExamQuestion: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const d = await dbOrThrow();
    await d.delete(careerExamQuestions).where(eq(careerExamQuestions.id, input.id));
    await logActivity({ userId: ctx.user.id, action: "delete", entity: "career_exam_question", entityId: input.id, details: "" });
    return { success: true };
  }),
  startCareerExam: protectedProcedure.input(z.object({ examId: z.number() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const employeeId = await myEmployeeId(ctx.user.id);
    const { startExamAttempt } = await import("./trainingAttempts");
    return startExamAttempt(employeeId, input.examId);
  }),
  submitCareerExam: protectedProcedure.input(z.object({ sessionId: z.number().int().positive(), answers: assessmentAnswers })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const me = await getEmployeeByUserId(ctx.user.id);
    if (!me) throw new TRPCError({ code: "NOT_FOUND", message: "Sem ficha de colaborador." });
    const { submitAttempt } = await import("./trainingAttempts");
    const r = await submitAttempt(me.employee.id, input.sessionId, input.answers);
    if (r.kind !== "exam") throw new TRPCError({ code: "BAD_REQUEST", message: "Tentativa inválida." });
    if (r.passed) {
      try {
        await notifyOwner({ title: "Exame aprovado", content: `${me.employee.fullName} passou num exame de carreira com ${r.percentage}% (mínimo: ${r.passingScore}%). Promoção pendente de aprovação.` });
      } catch { console.warn("[Training] Resultado guardado; o envio do aviso ao responsável falhou."); }
    }
    return r;
  }),
  myCareerExamAttempts: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const me = await getEmployeeByUserId(ctx.user.id);
    if (!me) return [];
    return getCareerExamAttempts(me.employee.id);
  }),
  careerExamAttempts: protectedProcedure.input(z.object({ employeeId: z.number().optional(), examId: z.number().optional() })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    return getCareerExamAttempts(input.employeeId, input.examId, trainingResultScope(await rhViewer(ctx.user)));
  }),

  // ─── A minha formação (percursos + progresso) ───────────────────────────
  myTraining: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const me = await getEmployeeByUserId(ctx.user.id);
    if (!me) return { employeeId: null, assignments: [], progress: [], certificates: [] };
    const { employeeTraining } = await import("./trainingPaths");
    const { listCertificates } = await import("./trainingAttempts");
    const t = await employeeTraining(me.employee.id);
    const certificates = await listCertificates({ employeeId: me.employee.id, scoped: false });
    return { employeeId: me.employee.id, ...t, certificates };
  }),
  /** Abriu um vídeo/manual (visto) ou confirmou "Li"/"Marcar como visto"/≥80% (concluído). */
  markItem: protectedProcedure.input(z.object({ itemType: z.enum(["video", "manual"]), itemId: z.number().int().positive(), completed: z.boolean(), seconds: z.number().int().min(0).max(86400).optional() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const me = await getEmployeeByUserId(ctx.user.id);
    if (!me) return { success: false };
    const d = await dbOrThrow();
    const table = input.itemType === "video" ? trainingVideos : trainingManuals;
    const [exists] = await d.select({ id: table.id }).from(table).where(eq(table.id, input.itemId)).limit(1);
    if (!exists) throw new TRPCError({ code: "NOT_FOUND", message: "Conteúdo não encontrado." });
    const { recordProgress } = await import("./trainingPaths");
    await recordProgress(me.employee.id, input.itemType, input.itemId, { completed: input.completed, seconds: input.seconds });
    return { success: true };
  }),

  // ─── Percursos (gestão) ──────────────────────────────────────────────────
  paths: protectedProcedure.input(z.object({ includeInactive: z.boolean().optional() }).optional()).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view");
    const { listPaths } = await import("./trainingPaths");
    return listPaths({ includeInactive: input?.includeInactive });
  }),
  createPath: protectedProcedure.input(pathInput).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { createPath } = await import("./trainingPaths");
    return createPath(input, ctx.user.id);
  }),
  updatePath: protectedProcedure.input(pathInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { id, ...data } = input;
    const { updatePath } = await import("./trainingPaths");
    await updatePath(id, data, ctx.user.id);
    return { success: true };
  }),
  deletePath: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { deletePath } = await import("./trainingPaths");
    const r = await deletePath(input.id, ctx.user.id);
    if (!r.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `O percurso tem ${r.assigned} atribuição(ões). Desativa-o em vez de o apagar.` });
    return { success: true };
  }),
  setPathItems: protectedProcedure.input(z.object({ pathId: z.number(), items: z.array(z.object({ itemType: z.enum(TRAINING_ITEM_TYPES as ["video", "manual", "exam", "quiz"]), itemId: z.number().int().min(0), required: z.boolean() })).max(100) })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { setPathItems } = await import("./trainingPaths");
    await setPathItems(input.pathId, input.items, ctx.user.id);
    return { success: true };
  }),
  assignPath: protectedProcedure.input(z.object({ pathId: z.number(), employeeIds: z.array(z.number().int().positive()).min(1).max(500) })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "edit");
    await assertEmployeesInScope(input.employeeIds);
    // team_leader: só a equipa (abaixo dele, na cidade).
    for (const id of input.employeeIds) await assertTrainingTeam(ctx.user, id);
    const { assignPath } = await import("./trainingPaths");
    const r = await assignPath(input.pathId, input.employeeIds, { assignedById: ctx.user.id, source: "manual" });
    await logActivity({ userId: ctx.user.id, action: "update", entity: "training_path", entityId: input.pathId, details: `Atribuído a ${input.employeeIds.length} colaborador(es): ${r.created} novos` });
    return r;
  }),
  assignToActiveExtras: protectedProcedure.input(z.object({ pathId: z.number() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { assignToActiveExtras } = await import("./trainingPaths");
    return assignToActiveExtras(input.pathId, ctx.user.id);
  }),
  unassign: protectedProcedure.input(z.object({ assignmentId: z.number() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "manage");
    const { unassign } = await import("./trainingPaths");
    await unassign(input.assignmentId, ctx.user.id);
    return { success: true };
  }),
  /** Colaboradores ativos no âmbito (para atribuir percursos). */
  assignableEmployees: protectedProcedure.query(async ({ ctx }) => {
    requireAccess(ctx.user, "formacao", "edit");
    const d = await dbOrThrow();
    const rows = await d.select({ id: employees.id, fullName: employees.fullName, position: employees.position })
      .from(employees).where(and(eq(employees.isActive, 1), projectScope(employees.projectId))).orderBy(employees.fullName);
    if (scopeFor(ctx.user, "formacao") !== "below_city") return rows;
    const team = await trainingTeamIds(ctx.user);
    return rows.filter(r => team.has(r.id));
  }),

  // ─── Dashboard de conclusão ─────────────────────────────────────────────
  dashboard: protectedProcedure.input(z.object({ city: z.enum(["lisboa", "porto", "faro"]).nullable().optional(), pathId: z.number().nullable().optional(), targetRole: z.string().max(32).nullable().optional() }).optional()).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view");
    const { completionDashboard } = await import("./trainingPaths");
    const { listPromotions, listCertificates } = await import("./trainingAttempts");
    // team_leader: só a equipa (fichas abaixo dele na cidade) e sem decidir promoções.
    const team = scopeFor(ctx.user, "formacao") === "below_city" ? await trainingTeamIds(ctx.user) : null;
    const [dash, promotions, certificates] = await Promise.all([
      completionDashboard({ ...(input ?? {}), employeeIds: team }),
      team ? Promise.resolve([] as Awaited<ReturnType<typeof listPromotions>>) : listPromotions("pending"),
      listCertificates({ scoped: true }),
    ]);
    const certs = certificates.filter(c => c.state === "expired" || c.state === "expiring")
      .filter(c => !team || team.has((c as any).employeeId));
    return { ...dash, promotions, certificates: certs };
  }),
  personProgress: protectedProcedure.input(z.object({ employeeId: z.number() })).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view");
    await assertTrainingTeam(ctx.user, input.employeeId);
    await assertEmployeesInScope([input.employeeId]);
    const d = await dbOrThrow();
    const [emp] = await d.select({ id: employees.id, fullName: employees.fullName, position: employees.position, careerLevel: employees.careerLevel, extraLevel: employees.extraLevel }).from(employees).where(eq(employees.id, input.employeeId)).limit(1);
    const { employeeTraining } = await import("./trainingPaths");
    const { listCertificates } = await import("./trainingAttempts");
    const t = await employeeTraining(input.employeeId);
    const certificates = await listCertificates({ employeeId: input.employeeId, scoped: true });
    const attempts = await getCareerExamAttempts(input.employeeId);
    return { employee: emp ?? null, ...t, certificates, attempts };
  }),

  // ─── Promoções e certificados ───────────────────────────────────────────
  promotions: protectedProcedure.input(z.object({ status: z.enum(["pending", "all"]).optional() }).optional()).query(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "edit");
    const { listPromotions } = await import("./trainingAttempts");
    return listPromotions(input?.status ?? "pending");
  }),
  decidePromotion: protectedProcedure.input(z.object({ id: z.number(), approve: z.boolean(), note: z.string().max(500).optional() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "edit");
    const { decidePromotion } = await import("./trainingAttempts");
    return decidePromotion(input.id, input.approve, input.note?.trim() || null, ctx.user);
  }),
  certificateUrl: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "formacao", "view", { allowOwn: true });
    const me = await getEmployeeByUserId(ctx.user.id);
    const { certificateDownloadUrl } = await import("./trainingAttempts");
    return certificateDownloadUrl(input.id, { employeeId: me?.employee?.id ?? null, canSeeOthers: seesBeyondOwn(ctx.user, "formacao") && scopeFor(ctx.user, "formacao") !== "below_city" });
  }),
});
