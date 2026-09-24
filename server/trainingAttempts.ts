/**
 * Formação — tentativas de quiz/exame servidas pelo servidor (anti-batota),
 * ranking por melhor pontuação, pedidos de promoção, certificados em PDF e
 * perguntas de quiz geradas por IA (rascunhos).
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  getDb, logActivity, saveCareerExamAttempt, saveQuizAttempt,
} from "./db";
import { projectScope } from "./cityScope";
import { gradeAssessment } from "./trainingAssessments";
import {
  careerExamQuestions, careerExams, employees, quizAttempts, quizQuestions, trainingAttemptSessions,
  trainingCertificates, trainingManuals, trainingPromotions,
} from "../drizzle/schema";
import {
  AttemptError, QUIZ_MAX_PER_DAY, QUIZ_QUESTIONS_PER_GAME, assertCanStartAttempt, attemptsLeftToday, certificateStatus,
  certificateValidUntil, lisbonDay, parseDbDate, pickQuestions, promotionPatch, rankBestScores, toDbDate, validateSubmission,
} from "./trainingRules";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível");
  return d;
}
const insertId = (r: any): number => Number(r?.[0]?.insertId ?? r?.insertId ?? 0);
const affected = (r: any): number => Number(r?.[0]?.affectedRows ?? r?.affectedRows ?? 0);

function asTrpc(err: unknown): never {
  if (err instanceof AttemptError) throw new TRPCError({ code: err.code, message: err.message });
  throw err;
}

export const QUIZ_PASS_PCT = 70;

// ─── Início de tentativa ───────────────────────────────────────────────────

/** Sessões iniciadas nas últimas 36h (chega para contar "hoje" em Lisboa). */
async function recentStarts(employeeId: number, kind: "quiz" | "exam", examId: number | null, now: Date) {
  const d = await db();
  const since = toDbDate(new Date(now.getTime() - 36 * 3600_000));
  const rows = await d.select({ startedAt: trainingAttemptSessions.startedAt }).from(trainingAttemptSessions)
    .where(and(eq(trainingAttemptSessions.employeeId, employeeId), eq(trainingAttemptSessions.kind, kind),
      examId != null ? eq(trainingAttemptSessions.examId, examId) : undefined,
      gte(trainingAttemptSessions.startedAt, since)));
  return rows.map(r => r.startedAt);
}

export async function startExamAttempt(employeeId: number, examId: number, now: Date = new Date()) {
  const d = await db();
  const [exam] = await d.select().from(careerExams).where(and(eq(careerExams.id, examId), sql`${careerExams.archivedAt} IS NULL`)).limit(1);
  if (!exam) throw new TRPCError({ code: "NOT_FOUND", message: "Exame não disponível." });
  const qs = await d.select().from(careerExamQuestions).where(eq(careerExamQuestions.examId, examId));
  if (!qs.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Este exame ainda não tem perguntas." });
  const max = exam.maxAttemptsPerDay ?? 3;
  const starts = await recentStarts(employeeId, "exam", examId, now);
  try { assertCanStartAttempt(starts, now, max); } catch (e) { asTrpc(e); }
  const served = pickQuestions(qs, qs.length);
  const limitMin = exam.timeLimitMinutes ?? 0;
  const deadlineAt = limitMin > 0 ? toDbDate(new Date(now.getTime() + limitMin * 60_000)) : null;
  const r = await d.insert(trainingAttemptSessions).values({
    employeeId, kind: "exam", examId, questionIds: JSON.stringify(served.map(q => q.id)), startedAt: toDbDate(now), deadlineAt,
  });
  return {
    sessionId: insertId(r), deadlineAt, timeLimitSeconds: limitMin > 0 ? limitMin * 60 : null,
    attemptsLeft: attemptsLeftToday([...starts, now], now, max),
    questions: served.map(q => ({ id: q.id, question: q.question, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD, points: q.points })),
  };
}

export async function startQuizAttempt(employeeId: number, categoryId: number | null, now: Date = new Date()) {
  const d = await db();
  const qs = await d.select().from(quizQuestions)
    .where(and(eq(quizQuestions.published, 1), categoryId ? eq(quizQuestions.categoryId, categoryId) : undefined));
  if (!qs.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Ainda não há perguntas publicadas." });
  const starts = await recentStarts(employeeId, "quiz", null, now);
  try { assertCanStartAttempt(starts, now, QUIZ_MAX_PER_DAY); } catch (e) { asTrpc(e); }
  const served = pickQuestions(qs, QUIZ_QUESTIONS_PER_GAME);
  const r = await d.insert(trainingAttemptSessions).values({
    employeeId, kind: "quiz", categoryId: categoryId ?? null, questionIds: JSON.stringify(served.map(q => q.id)), startedAt: toDbDate(now), deadlineAt: null,
  });
  return {
    sessionId: insertId(r), deadlineAt: null, timeLimitSeconds: null,
    attemptsLeft: attemptsLeftToday([...starts, now], now, QUIZ_MAX_PER_DAY),
    questions: served.map(q => ({ id: q.id, question: q.question, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD, points: q.points, difficulty: q.difficulty })),
  };
}

// ─── Submissão ─────────────────────────────────────────────────────────────

export interface SubmitResult {
  kind: "quiz" | "exam";
  correct: number; total: number; score: number; percentage: number;
  passed: boolean | null; passingScore: number | null; timedOut: boolean; expired: boolean;
  promotionRequested: boolean;
  review: Array<{ questionId: number; question: string; options: Record<"A" | "B" | "C" | "D", string>; yourAnswer: string | null; correctOption: string; correct: boolean; explanation: string | null }>;
}

export async function submitAttempt(employeeId: number, sessionId: number, answers: { questionId: number; answer: "A" | "B" | "C" | "D" }[], now: Date = new Date()): Promise<SubmitResult> {
  const d = await db();
  const [s] = await d.select().from(trainingAttemptSessions).where(eq(trainingAttemptSessions.id, sessionId)).limit(1);
  if (!s || s.employeeId !== employeeId) throw new TRPCError({ code: "NOT_FOUND", message: "Tentativa não encontrada." });
  const servedIds: number[] = (() => { try { return (JSON.parse(s.questionIds) as unknown[]).map(Number).filter(Number.isFinite); } catch { return []; } })();
  let mode: ReturnType<typeof validateSubmission> = "ok";
  try {
    mode = validateSubmission({ servedIds, answers, startedAt: s.startedAt, deadlineAt: s.deadlineAt, submittedAt: s.submittedAt, now });
  } catch (e) { asTrpc(e); }

  // Reserva atómica: só uma submissão ganha (duplo clique / dois separadores).
  const claim = await d.update(trainingAttemptSessions).set({ submittedAt: toDbDate(now) })
    .where(and(eq(trainingAttemptSessions.id, sessionId), sql`${trainingAttemptSessions.submittedAt} IS NULL`));
  if (affected(claim) !== 1) throw new TRPCError({ code: "BAD_REQUEST", message: "Esta tentativa já foi submetida." });

  const isExam = s.kind === "exam";
  const questions: Array<{ id: number; question: string; optionA: string; optionB: string; optionC: string; optionD: string; correctOption: string; explanation: string | null; points: number }> = isExam
    ? await d.select().from(careerExamQuestions).where(inArray(careerExamQuestions.id, servedIds.length ? servedIds : [0]))
    : await d.select().from(quizQuestions).where(inArray(quizQuestions.id, servedIds.length ? servedIds : [0]));
  const qMap = new Map(questions.map(q => [q.id, q]));
  const servedQs = servedIds.map(id => qMap.get(id)).filter((q): q is NonNullable<typeof q> => !!q);
  const validAnswers = answers.filter(a => qMap.has(a.questionId));
  let correct = 0, score = 0, percentage = 0;
  if (mode !== "expired" && servedQs.length && validAnswers.length) {
    const g = gradeAssessment(servedQs.map(q => ({ id: q.id, correctOption: q.correctOption, points: q.points })), validAnswers);
    correct = g.correct; score = g.score; percentage = g.percentage;
  }
  const timeSpent = Math.max(0, Math.round((now.getTime() - parseDbDate(s.startedAt).getTime()) / 1000));

  let passed: boolean | null = null, passingScore: number | null = null, resultId = 0, promotionRequested = false;
  const { recordProgress } = await import("./trainingPaths");
  if (isExam) {
    const [exam] = await d.select().from(careerExams).where(eq(careerExams.id, s.examId!)).limit(1);
    passingScore = exam?.passingScore ?? 100;
    passed = mode !== "expired" && percentage >= passingScore;
    const saved = await saveCareerExamAttempt({ examId: s.examId!, employeeId, totalQuestions: servedQs.length, correctAnswers: correct, score: percentage, passed, timeSpentSeconds: timeSpent });
    resultId = saved?.id ?? 0;
    if (passed && exam) {
      try { await recordProgress(employeeId, "exam", exam.id, { completed: true }); } catch (err) { console.warn("[Training] progresso do exame falhou", err); }
      try { promotionRequested = await requestPromotion(employeeId, exam, resultId, percentage); } catch (err) { console.warn("[Training] pedido de promoção falhou", err); }
    }
  } else {
    const saved = await saveQuizAttempt({ employeeId, totalQuestions: servedQs.length, correctAnswers: correct, score, timeSpentSeconds: timeSpent });
    resultId = saved?.id ?? 0;
    if (percentage >= QUIZ_PASS_PCT) {
      try {
        await recordProgress(employeeId, "quiz", 0, { completed: true });
        if (s.categoryId) await recordProgress(employeeId, "quiz", s.categoryId, { completed: true });
      } catch (err) { console.warn("[Training] progresso do quiz falhou", err); }
    }
  }
  await d.update(trainingAttemptSessions).set({ resultId, score: isExam ? percentage : score, passed: passed == null ? null : passed ? 1 : 0 })
    .where(eq(trainingAttemptSessions.id, sessionId));

  const ansMap = new Map(validAnswers.map(a => [a.questionId, a.answer]));
  return {
    kind: isExam ? "exam" : "quiz", correct, total: servedQs.length, score: isExam ? percentage : score, percentage,
    passed, passingScore, timedOut: mode === "timed_out", expired: mode === "expired", promotionRequested,
    review: servedQs.map(q => ({
      questionId: q.id, question: q.question, options: { A: q.optionA, B: q.optionB, C: q.optionC, D: q.optionD },
      yourAnswer: ansMap.get(q.id) ?? null, correctOption: q.correctOption, correct: ansMap.get(q.id) === q.correctOption,
      explanation: q.explanation ?? null,
    })),
  };
}

// ─── Ranking ───────────────────────────────────────────────────────────────

/** Melhor pontuação por pessoa, no âmbito da cidade de quem vê. */
export async function quizRanking(limit = 50) {
  const d = await db();
  const rows = await d.select({
    employeeId: quizAttempts.employeeId,
    bestScore: sql<number>`MAX(${quizAttempts.score})`,
    attempts: sql<number>`COUNT(*)`,
    firstAt: sql<string>`MIN(${quizAttempts.createdAt})`,
  }).from(quizAttempts)
    .innerJoin(employees, eq(employees.id, quizAttempts.employeeId))
    .where(projectScope(employees.projectId))
    .groupBy(quizAttempts.employeeId);
  const ranked = rankBestScores(rows.map(r => ({ employeeId: r.employeeId, bestScore: Number(r.bestScore), attempts: Number(r.attempts), firstBestAt: r.firstAt })), limit);
  const names = await displayNames(ranked.map(r => r.employeeId));
  // `totalScore` mantém-se por compatibilidade (PessoasDashboard) = melhor pontuação.
  return ranked.map(r => ({ ...r, totalScore: r.bestScore, totalAttempts: r.attempts, name: names.get(r.employeeId) ?? null }));
}

/** "Primeiro Último" — nada mais da ficha. Só para ids que estão no ranking. */
export async function displayNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const clean = Array.from(new Set(ids.filter(n => Number.isInteger(n) && n > 0))).slice(0, 200);
  if (!clean.length) return out;
  const d = await db();
  const ranked = await d.selectDistinct({ id: quizAttempts.employeeId }).from(quizAttempts).where(inArray(quizAttempts.employeeId, clean));
  const allowed = ranked.map(r => r.id);
  if (!allowed.length) return out;
  const rows = await d.select({ id: employees.id, fullName: employees.fullName }).from(employees).where(inArray(employees.id, allowed));
  for (const r of rows) {
    const parts = (r.fullName || "").trim().split(/\s+/).filter(Boolean);
    out.set(r.id, parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]}` : parts[0] || `#${r.id}`);
  }
  return out;
}

// ─── Promoções ─────────────────────────────────────────────────────────────

async function requestPromotion(employeeId: number, exam: { id: number; level: string; title: string }, attemptId: number, score: number): Promise<boolean> {
  const d = await db();
  const [pending] = await d.select({ id: trainingPromotions.id }).from(trainingPromotions)
    .where(and(eq(trainingPromotions.employeeId, employeeId), eq(trainingPromotions.examId, exam.id), eq(trainingPromotions.status, "pending"))).limit(1);
  if (pending) {
    await d.update(trainingPromotions).set({ attemptId, score }).where(eq(trainingPromotions.id, pending.id));
    return true;
  }
  await d.insert(trainingPromotions).values({ employeeId, examId: exam.id, attemptId, level: exam.level, score, status: "pending" });
  try {
    const [emp] = await d.select({ fullName: employees.fullName }).from(employees).where(eq(employees.id, employeeId)).limit(1);
    const { notifyBackoffice } = await import("./extrasAutomation");
    await notifyBackoffice(`Promoção por aprovar: ${emp?.fullName ?? `#${employeeId}`}`, `Passou no exame "${exam.title}" com ${score}%.`, "/formacao");
  } catch { /* aviso é best-effort */ }
  return true;
}

export async function listPromotions(status: "pending" | "all" = "pending") {
  const d = await db();
  return d.select({
    id: trainingPromotions.id, employeeId: trainingPromotions.employeeId, examId: trainingPromotions.examId, level: trainingPromotions.level,
    score: trainingPromotions.score, status: trainingPromotions.status, requestedAt: trainingPromotions.requestedAt,
    decidedAt: trainingPromotions.decidedAt, note: trainingPromotions.note, certificateId: trainingPromotions.certificateId,
    fullName: employees.fullName, currentLevel: employees.careerLevel, examTitle: careerExams.title,
  }).from(trainingPromotions)
    .innerJoin(employees, eq(employees.id, trainingPromotions.employeeId))
    .leftJoin(careerExams, eq(careerExams.id, trainingPromotions.examId))
    .where(and(projectScope(employees.projectId), status === "pending" ? eq(trainingPromotions.status, "pending") : undefined))
    .orderBy(desc(trainingPromotions.requestedAt))
    .limit(200);
}

export async function decidePromotion(id: number, approve: boolean, note: string | null, user: { id: number }) {
  const d = await db();
  const [p] = await d.select().from(trainingPromotions).where(eq(trainingPromotions.id, id)).limit(1);
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Pedido não encontrado." });
  const [emp] = await d.select().from(employees).where(and(eq(employees.id, p.employeeId), projectScope(employees.projectId))).limit(1);
  if (!emp) throw new TRPCError({ code: "FORBIDDEN", message: "Colaborador fora do teu âmbito." });
  const claim = await d.update(trainingPromotions).set({ status: approve ? "approved" : "rejected", decidedAt: toDbDate(new Date()), decidedById: user.id, note })
    .where(and(eq(trainingPromotions.id, id), eq(trainingPromotions.status, "pending")));
  if (affected(claim) !== 1) throw new TRPCError({ code: "BAD_REQUEST", message: "Este pedido já foi decidido." });

  let certificateId: number | null = null;
  if (approve) {
    const patch = promotionPatch(p.level, { extraLevel: emp.extraLevel ?? null, position: emp.position ?? null });
    await d.update(employees).set(patch as any).where(eq(employees.id, emp.id));
    certificateId = await issueCertificate(emp.id, p.examId, p.level, id);
    await d.update(trainingPromotions).set({ certificateId }).where(eq(trainingPromotions.id, id));
    if (emp.userId) {
      try {
        const { createNotification } = await import("./complaintsExtended");
        await createNotification({ userId: emp.userId, title: "Promoção aprovada 🎉", body: `Subiste para ${p.level}. O certificado está na Formação → Carreira.`, kind: "training", link: "/formacao" });
      } catch { /* segue */ }
    }
  }
  await logActivity({
    userId: user.id, action: approve ? "training_promotion_approve" : "training_promotion_reject", entity: "employees", entityId: emp.id,
    details: `${approve ? "Promoção aprovada" : "Promoção recusada"}: ${emp.fullName} → ${p.level} (exame #${p.examId}, ${p.score ?? "?"}%)${note ? ` · ${note}` : ""}`,
  });
  return { success: true, certificateId };
}

// ─── Certificados ──────────────────────────────────────────────────────────

export async function issueCertificate(employeeId: number, examId: number, level: string, promotionId: number | null, now: Date = new Date()): Promise<number> {
  const d = await db();
  const [exam] = await d.select().from(careerExams).where(eq(careerExams.id, examId)).limit(1);
  const validUntil = certificateValidUntil(now, exam?.validityMonths ?? 12);
  const r = await d.insert(trainingCertificates).values({ employeeId, examId, level, issuedAt: toDbDate(now), validUntil, promotionId });
  const id = insertId(r);
  try { await renderAndStoreCertificate(id); } catch (err: any) {
    console.warn("[Training] PDF do certificado falhou (gera-se ao descarregar):", String(err?.message ?? err).slice(0, 160));
  }
  return id;
}

async function renderAndStoreCertificate(certId: number): Promise<{ key: string; url: string }> {
  const d = await db();
  const [c] = await d.select().from(trainingCertificates).where(eq(trainingCertificates.id, certId)).limit(1);
  if (!c) throw new Error("Certificado não encontrado");
  const [emp] = await d.select({ fullName: employees.fullName }).from(employees).where(eq(employees.id, c.employeeId)).limit(1);
  const [exam] = await d.select({ title: careerExams.title }).from(careerExams).where(eq(careerExams.id, c.examId)).limit(1);
  const { renderCertificatePdf } = await import("./trainingCertificatePdf");
  const pdf = await renderCertificatePdf({
    certificateId: c.id, fullName: emp?.fullName ?? `Colaborador #${c.employeeId}`, examTitle: exam?.title ?? `Exame #${c.examId}`,
    level: c.level, issuedAt: lisbonDay(parseDbDate(c.issuedAt)), validUntil: c.validUntil ?? null,
  });
  const { storagePut } = await import("./storage");
  const out = await storagePut(`training/certificates/${c.employeeId}/cert-${c.id}-${Date.now()}.pdf`, pdf, "application/pdf");
  await d.update(trainingCertificates).set({ fileKey: out.key, fileUrl: out.url }).where(eq(trainingCertificates.id, c.id));
  return out;
}

export async function certificateDownloadUrl(certId: number, viewer: { employeeId: number | null; canSeeOthers: boolean }) {
  const d = await db();
  const [c] = await d.select({ cert: trainingCertificates, projectId: employees.projectId }).from(trainingCertificates)
    .innerJoin(employees, eq(employees.id, trainingCertificates.employeeId))
    .where(eq(trainingCertificates.id, certId)).limit(1);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Certificado não encontrado." });
  const own = viewer.employeeId != null && viewer.employeeId === c.cert.employeeId;
  if (!own) {
    if (!viewer.canSeeOthers) throw new TRPCError({ code: "FORBIDDEN", message: "Sem acesso a este certificado." });
    const [inScope] = await d.select({ id: employees.id }).from(employees).where(and(eq(employees.id, c.cert.employeeId), projectScope(employees.projectId))).limit(1);
    if (!inScope) throw new TRPCError({ code: "FORBIDDEN", message: "Colaborador fora do teu âmbito." });
  }
  let key = c.cert.fileKey, url = c.cert.fileUrl;
  if (!key) { const out = await renderAndStoreCertificate(certId); key = out.key; url = out.url; }
  const { storagePresignGet } = await import("./storage");
  const signed = await storagePresignGet(key!, { fallbackUrl: url, expiresSeconds: 600 });
  if (!signed.url) throw new TRPCError({ code: "NOT_FOUND", message: "Ficheiro do certificado indisponível." });
  return { url: signed.url };
}

export async function listCertificates(opts: { employeeId?: number; scoped: boolean }, now: Date = new Date()) {
  const d = await db();
  const rows = await d.select({
    id: trainingCertificates.id, employeeId: trainingCertificates.employeeId, examId: trainingCertificates.examId, level: trainingCertificates.level,
    issuedAt: trainingCertificates.issuedAt, validUntil: trainingCertificates.validUntil, recertAssignedAt: trainingCertificates.recertAssignedAt,
    fullName: employees.fullName, examTitle: careerExams.title,
  }).from(trainingCertificates)
    .innerJoin(employees, eq(employees.id, trainingCertificates.employeeId))
    .leftJoin(careerExams, eq(careerExams.id, trainingCertificates.examId))
    .where(and(opts.employeeId ? eq(trainingCertificates.employeeId, opts.employeeId) : undefined, opts.scoped ? projectScope(employees.projectId) : undefined))
    .orderBy(desc(trainingCertificates.issuedAt))
    .limit(500);
  return rows.map(r => ({ ...r, state: certificateStatus(r.validUntil, now) }));
}

// ─── Perguntas geradas por IA (rascunhos) ──────────────────────────────────

const draftSchema = z.object({
  question: z.string().min(5).max(1000),
  optionA: z.string().min(1).max(500), optionB: z.string().min(1).max(500),
  optionC: z.string().min(1).max(500), optionD: z.string().min(1).max(500),
  correctOption: z.enum(["A", "B", "C", "D"]),
  explanation: z.string().max(2000).optional().nullable(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional().nullable(),
});

export function llmConfigured(): boolean {
  return !!(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "").trim();
}

/** Extrai a lista de perguntas de uma resposta do LLM (JSON solto ou em ```). */
export function parseDraftQuestions(text: string): z.infer<typeof draftSchema>[] {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  let parsed: unknown = null;
  const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
  parsed = tryParse(cleaned);
  if (!parsed) {
    const obj = cleaned.match(/\{[\s\S]*\}/); const arr = cleaned.match(/\[[\s\S]*\]/);
    parsed = (obj && tryParse(obj[0])) || (arr && tryParse(arr[0]));
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as any)?.questions) ? (parsed as any).questions : [];
  const out: z.infer<typeof draftSchema>[] = [];
  for (const q of list) {
    const r = draftSchema.safeParse({ ...q, correctOption: typeof q?.correctOption === "string" ? q.correctOption.trim().toUpperCase().slice(0, 1) : q?.correctOption });
    if (r.success) out.push(r.data);
  }
  return out;
}

export async function generateQuizDrafts(manualId: number, count: number, userId: number) {
  if (!llmConfigured()) return { skipped: true as const, reason: "IA não configurada (LLM_API_KEY em falta).", created: 0 };
  const d = await db();
  const [m] = await d.select().from(trainingManuals).where(eq(trainingManuals.id, manualId)).limit(1);
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Manual não encontrado." });
  const text = (m.content || "").slice(0, 60_000);
  const parts: any[] = [];
  // PDF anexo: só o caminho Claude aceita documentos (data URI); até 4MB.
  const isPdf = (m.fileMimeType || "").includes("pdf") && (m.fileKey || m.fileUrl);
  if (isPdf && (process.env.LLM_API_URL || "").includes("anthropic")) {
    try {
      const { storagePresignGet } = await import("./storage");
      const { url } = await storagePresignGet(m.fileKey || m.fileUrl!, { fallbackUrl: m.fileUrl });
      if (url && /^https?:\/\//.test(url)) {
        const resp = await fetch(url);
        const buf = Buffer.from(await resp.arrayBuffer());
        if (resp.ok && buf.length <= 4 * 1024 * 1024) parts.push({ type: "file_url", file_url: { url: `data:application/pdf;base64,${buf.toString("base64")}`, mime_type: "application/pdf" } });
      }
    } catch { /* segue só com o texto */ }
  }
  if (text.trim().length < 40 && !parts.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "O manual não tem texto suficiente (nem PDF legível) para gerar perguntas." });
  }
  const n = Math.max(1, Math.min(20, Math.trunc(count)));
  parts.unshift({ type: "text", text: `Manual: "${m.title}"\n\n${text}\n\nGera ${n} perguntas.` });
  const { invokeLLM } = await import("./_core/llm");
  let content = "";
  try {
    const resp = await invokeLLM({
      messages: [
        { role: "system", content: "És formador numa empresa de parques de estacionamento/valet (Multipark). A partir do manual dado, crias perguntas de escolha múltipla em português de Portugal (PT-PT, não brasileiro), com 4 opções (A–D), UMA correta, e uma explicação curta. Responde APENAS com JSON: {\"questions\":[{\"question\":\"…\",\"optionA\":\"…\",\"optionB\":\"…\",\"optionC\":\"…\",\"optionD\":\"…\",\"correctOption\":\"A\",\"explanation\":\"…\",\"difficulty\":\"easy|medium|hard\"}]}" },
        { role: "user", content: parts },
      ],
    });
    const c = resp?.choices?.[0]?.message?.content;
    content = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => p?.text ?? "").join("") : "";
  } catch (err: any) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `A IA falhou: ${String(err?.message ?? err).slice(0, 200)}` });
  }
  const drafts = parseDraftQuestions(content).slice(0, n);
  if (!drafts.length) throw new TRPCError({ code: "BAD_REQUEST", message: "A IA não devolveu perguntas válidas. Tenta outra vez." });
  await d.insert(quizQuestions).values(drafts.map(q => ({
    categoryId: m.categoryId ?? null, question: q.question, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD,
    correctOption: q.correctOption, explanation: q.explanation ?? null, difficulty: q.difficulty ?? "medium", points: 10,
    published: 0, sourceManualId: m.id,
  })));
  await logActivity({ userId, action: "create", entity: "quiz_question", entityId: m.id, details: `${drafts.length} rascunhos IA do manual "${m.title}"` });
  return { skipped: false as const, reason: null, created: drafts.length };
}

