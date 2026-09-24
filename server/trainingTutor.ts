/**
 * Tutor da Formação (IA) — chat nas páginas da Formação que ajuda, motiva e
 * responde SÓ com o conteúdo dos manuais.
 *
 *   pergunta → interruptor (AI_ENABLED + AI_TRAINING_TUTOR) → limite por pessoa
 *   (checkRateLimit) → dados pessoais fora (redactPii) → trechos por
 *   palavras-chave (sem trechos = "pergunta ao formador", sem chamar a IA) →
 *   runAi (lite; conteúdo do módulo no `system` com cache de contexto) →
 *   "SEM_RESPOSTA" = "pergunta ao formador" → corte de palavras → histórico
 *   (30 dias) + agregado anónimo das perguntas para os formadores.
 *
 * Saudação e dicas antes do quiz não usam IA (custo zero). Depois do quiz, as
 * respostas erradas são explicadas com uma citação LITERAL do manual (escolhida
 * aqui, não pelo modelo) e a IA só escreve a explicação curta.
 */
import { TRPCError } from "@trpc/server";
import { runAi } from "./_core/ai/run";
import { aiFeatureAvailableFresh } from "./_core/ai/status";
import { checkRateLimit, userKey, type RateLimitRule } from "./_core/ai/rateLimit";
import { firstName, redactPii } from "./_core/ai/pii";
import { isAiError } from "./_core/ai/errors";
import {
  QUIZ_EXPLAIN_SYSTEM, quizExplainInput, quizExplainSchema, tutorInput, tutorSystem, type WrongAnswerInput,
} from "./_core/ai/prompts/trainingTutor";
import {
  TUTOR_DEFAULT_LIMITS, TUTOR_DETAIL_WORDS, TUTOR_HISTORY_TURNS, TUTOR_MAX_INPUT_CHARS, TUTOR_SHORT_WORDS, type TutorContext,
} from "../shared/trainingTutor";
import {
  bestQuote, buildGreeting, chunkManuals, computeStreak, isOutOfContentReply, limitWords, outOfContentAnswer, questionKey, quizTips,
  retrieveChunks, type Chunk, type NextStep,
} from "./trainingTutorRules";
import * as store from "./trainingTutorStore";
import { lisbonDay } from "./trainingRules";

export interface TutorUser { id: number; role: string; name?: string | null }

export type TutorFallback = "disabled" | "budget" | "unavailable" | null;

export interface TutorAnswer {
  answer: string;
  outOfContent: boolean;
  fallback: TutorFallback;
  sources: Array<{ manualId: number; manualTitle: string; heading: string }>;
  trainerName: string | null;
}

/** A partir deste tamanho o conteúdo do módulo vai para a cache de contexto. */
const CACHE_MIN_CHARS = 6000;

// ─── Limites ───────────────────────────────────────────────────────────────

/** Definições (ai.trainingTutorLimits) > env AI_TRAINING_TUTOR_PER_MINUTE/PER_DAY > 10/min e 100/dia. */
export async function tutorLimits(env: Record<string, string | undefined> = process.env): Promise<Required<RateLimitRule>> {
  try {
    const { getSetting } = await import("./appSettings");
    const s = await getSetting("ai.trainingTutorLimits");
    if (s) return { perMinute: s.perMinute, perDay: s.perDay };
  } catch { /* segue para a env */ }
  const num = (v: string | undefined, d: number) => {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    perMinute: num(env.AI_TRAINING_TUTOR_PER_MINUTE, TUTOR_DEFAULT_LIMITS.perMinute),
    perDay: num(env.AI_TRAINING_TUTOR_PER_DAY, TUTOR_DEFAULT_LIMITS.perDay),
  };
}

async function enforceRateLimit(userId: number): Promise<void> {
  const rl = await checkRateLimit(`training_tutor:${userKey(userId)}`, await tutorLimits());
  if (!rl.allowed) {
    const when = rl.limitedBy === "day" ? "amanhã" : `daqui a ${rl.retryAfterSec} s`;
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Fizeste muitas perguntas seguidas. Tenta ${when} — ou pergunta ao teu formador.` });
  }
}

// ─── Mensagens de recurso (sempre simpáticas) ──────────────────────────────

export function fallbackMessage(kind: Exclude<TutorFallback, null>, trainerName: string | null): string {
  const who = trainerName ? `ao teu formador, ${trainerName}` : "ao teu formador";
  if (kind === "disabled") return `O tutor está desligado de momento. Para já, pergunta ${who} — e continua, estás a ir bem!`;
  if (kind === "budget") return `O tutor está a descansar até ao próximo mês. Entretanto, pergunta ${who}.`;
  return `Não consegui responder agora. Tenta daqui a pouco ou pergunta ${who}.`;
}

function fallbackOf(err: unknown): Exclude<TutorFallback, null> {
  if (isAiError(err)) {
    if (err.code === "disabled" || err.code === "not_configured") return "disabled";
    if (err.code === "budget") return "budget";
  }
  return "unavailable";
}

// ─── Módulo ────────────────────────────────────────────────────────────────

async function trainerNameFor(ctx: TutorContext, employeeId: number | null, createdBy: number | null): Promise<string | null> {
  try {
    const uid = await store.trainerUserId(ctx, employeeId, createdBy);
    const name = await store.userName(uid);
    return name ? firstName(name, "") || null : null;
  } catch {
    return null;
  }
}

function moduleText(manuals: Array<{ title: string; content: string }>): string {
  return manuals
    .filter((m) => m.content && !/^\s*https?:\/\/\S+\s*$/.test(m.content))
    .map((m) => `## ${m.title}\n${m.content.trim()}`)
    .join("\n\n");
}

function uniqueSources(hits: Chunk[]) {
  const seen = new Set<string>();
  const out: TutorAnswer["sources"] = [];
  for (const h of hits) {
    const k = `${h.manualId}:${h.heading}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ manualId: h.manualId, manualTitle: h.manualTitle, heading: h.heading });
  }
  return out;
}

// ─── Pergunta ──────────────────────────────────────────────────────────────

export async function tutorAsk(
  user: TutorUser,
  employeeId: number | null,
  ctx: TutorContext,
  question: string,
  opts: { detail?: boolean; includeUnpublished?: boolean; now?: Date } = {},
): Promise<TutorAnswer> {
  const q = String(question ?? "").trim();
  if (!q) throw new TRPCError({ code: "BAD_REQUEST", message: "Escreve a tua pergunta." });
  if (q.length > TUTOR_MAX_INPUT_CHARS) throw new TRPCError({ code: "BAD_REQUEST", message: `A pergunta é demasiado longa (máx. ${TUTOR_MAX_INPUT_CHARS} caracteres).` });

  const mod = await store.loadModule(ctx, { includeUnpublished: !!opts.includeUnpublished });
  if (!mod.found) throw new TRPCError({ code: "NOT_FOUND", message: "Conteúdo não encontrado." });
  const trainerName = await trainerNameFor(ctx, employeeId, mod.createdBy);
  const base = { sources: [] as TutorAnswer["sources"], trainerName };

  // Interruptor antes do limite (desligado não gasta pedidos).
  if (!(await aiFeatureAvailableFresh("training_tutor"))) {
    return { ...base, answer: fallbackMessage("disabled", trainerName), outOfContent: false, fallback: "disabled" };
  }
  await enforceRateLimit(user.id);

  const redaction = redactPii(q);
  const safeQ = redaction.text;
  const detail = !!opts.detail;
  const maxWords = detail ? TUTOR_DETAIL_WORDS : TUTOR_SHORT_WORDS;

  const history = await store.recentHistory(user.id, ctx, TUTOR_HISTORY_TURNS * 2, opts.now).catch(() => [] as store.StoredTurn[]);
  // "Explicar melhor" reaproveita a última pergunta para a procura.
  const lastUserQ = [...history].reverse().find((t) => t.role === "user")?.content ?? "";
  const hits = retrieveChunks(detail && lastUserQ ? `${safeQ} ${lastUserQ}` : safeQ, chunkManuals(mod.manuals));

  const persist = async (answerStored: string, outOfContent: boolean) => {
    try {
      await store.saveTurn({ userId: user.id, employeeId, ctx, question: safeQ, answer: answerStored, outOfContent, now: opts.now });
      if (!detail) await store.recordQuestion(ctx, questionKey(safeQ), safeQ, outOfContent, opts.now);
    } catch (err) {
      console.warn("[TrainingTutor] histórico não guardado:", String((err as any)?.message ?? err).slice(0, 120));
    }
  };

  if (!hits.length) {
    const answer = outOfContentAnswer(trainerName);
    await persist(answer, true);
    return { ...base, answer, outOfContent: true, fallback: null };
  }

  const text = moduleText(mod.manuals);
  let output: string;
  try {
    const r = await runAi({
      feature: "training_tutor",
      system: tutorSystem(mod.title, text),
      cacheSystem: text.length >= CACHE_MIN_CHARS ? { ttlSeconds: 3600 } : undefined,
      input: tutorInput({
        question: safeQ,
        passages: hits.map((h) => ({ manualTitle: h.manualTitle, heading: h.heading, text: h.text })),
        history: history.map((t) => ({ role: t.role, content: t.content })),
        maxWords,
        detail,
      }),
      maxTokens: detail ? 800 : 450,
      timeoutMs: 20_000,
      retries: 1,
      userId: user.id,
      entity: `training_${ctx.type}`,
      entityId: ctx.id,
    });
    output = String(r.output ?? "").trim();
  } catch (err) {
    const kind = fallbackOf(err);
    return { ...base, answer: fallbackMessage(kind, trainerName), outOfContent: false, fallback: kind };
  }

  if (!output || isOutOfContentReply(output)) {
    const answer = outOfContentAnswer(trainerName);
    await persist(answer, true);
    return { ...base, answer, outOfContent: true, fallback: null };
  }
  const stored = limitWords(output, maxWords);
  await persist(stored, false);
  return { ...base, answer: redaction.restore(stored), outOfContent: false, fallback: null, sources: uniqueSources(hits) };
}

// ─── Saudação, progresso e dicas (sem IA) ──────────────────────────────────

export interface TutorOverview {
  available: boolean;
  greeting: string;
  contextTitle: string | null;
  modulesDone: number;
  modulesTotal: number;
  streak: number;
  nextStep: NextStep | null;
  tips: string[];
  trainerName: string | null;
}

export async function tutorOverview(user: TutorUser, employeeId: number | null, ctx: TutorContext, opts: { includeUnpublished?: boolean; now?: Date } = {}): Promise<TutorOverview> {
  const now = opts.now ?? new Date();
  const mod = await store.loadModule(ctx, { includeUnpublished: !!opts.includeUnpublished });
  let modulesDone = 0, modulesTotal = 0, streak = 0;
  let nextStep: NextStep | null = null;
  const done = new Set<string>();
  if (employeeId != null) {
    const { employeeTraining } = await import("./trainingPaths");
    const t = await employeeTraining(employeeId, now);
    for (const p of t.progress) if (p.completedAt) done.add(`${p.itemType}:${p.itemId}`);
    const required = new Set<string>();
    for (const a of t.assignments) for (const it of a.items) if (it.required) required.add(`${it.itemType}:${it.itemId}`);
    modulesTotal = required.size;
    modulesDone = modulesTotal ? Array.from(required).filter((k) => done.has(k)).length : t.progress.filter((p) => p.completedAt && (p.itemType === "manual" || p.itemType === "video")).length;
    const open = [...t.assignments].filter((a) => a.status !== "completed").sort((a, b) => (a.status === "overdue" ? -1 : 0) - (b.status === "overdue" ? -1 : 0));
    for (const a of open) {
      const it = a.items.find((i) => i.required && !i.completedAt) ?? a.items.find((i) => !i.completedAt);
      if (it) { nextStep = { itemType: it.itemType, itemId: it.itemId, title: it.title, pathName: a.pathName }; break; }
    }
    streak = computeStreak(await store.activityDays(employeeId, now).catch(() => []), lisbonDay(now));
  }
  let tips: string[] = [];
  if (ctx.type === "quiz") {
    // Temas a rever: títulos dos manuais do quiz que ainda não leste.
    const topics = chunkManuals(mod.manuals.filter((m) => m.id > 0 && !done.has(`manual:${m.id}`)))
      .map((c) => ({ manualTitle: c.manualTitle, heading: c.heading }));
    tips = quizTips(topics);
  }
  const available = await aiFeatureAvailableFresh("training_tutor");
  const trainerName = await trainerNameFor(ctx, employeeId, mod.createdBy);
  const greeting = buildGreeting({
    firstName: user.name ? firstName(user.name, "") || null : null,
    modulesDone, modulesTotal, nextStep, streak,
    contextType: ctx.type, contextTitle: mod.found ? mod.title : null,
  });
  return { available, greeting, contextTitle: mod.found ? mod.title : null, modulesDone, modulesTotal, streak, nextStep, tips, trainerName };
}

// ─── Depois do quiz: explicar as respostas erradas ─────────────────────────

export interface QuizExplainItem {
  questionId: number;
  question: string;
  yourAnswer: string | null;
  correctAnswer: string;
  explanation: string;
  quote: { text: string; manualId: number; manualTitle: string; heading: string } | null;
  review: string | null;
}

export interface QuizExplanation {
  correct: number;
  total: number;
  items: QuizExplainItem[];
  encouragement: string;
  fallback: TutorFallback;
}

type Letter = "A" | "B" | "C" | "D";

function defaultEncouragement(correct: number, total: number): string {
  if (total > 0 && correct === total) return "Acertaste tudo — excelente trabalho!";
  if (total > 0 && correct / total >= 0.7) return "Bom resultado! Revê estes pontos e à próxima chegas lá.";
  return "Cada tentativa ensina alguma coisa. Revê os trechos abaixo e tenta outra vez — tu consegues!";
}

export async function explainQuiz(
  user: TutorUser,
  employeeId: number,
  sessionId: number,
  answers: Array<{ questionId: number; answer: Letter }>,
): Promise<QuizExplanation> {
  const s = await store.quizSession(sessionId);
  // Só a tentativa do próprio, de quiz, já submetida.
  if (!s || s.employeeId !== employeeId || s.kind !== "quiz" || !s.submittedAt) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Tentativa não encontrada." });
  }
  const servedIds: number[] = (() => { try { return (JSON.parse(s.questionIds) as unknown[]).map(Number).filter(Number.isFinite); } catch { return []; } })();
  const served = new Set(servedIds);
  const questions = (await store.quizQuestionsByIds(servedIds)).filter((q) => served.has(q.id));
  const ans = new Map(answers.filter((a) => served.has(a.questionId)).map((a) => [a.questionId, a.answer]));
  const total = questions.length;
  const wrongQs = questions.filter((q) => ans.get(q.id) !== q.correctOption).slice(0, 10);
  const correct = total - questions.filter((q) => ans.get(q.id) !== q.correctOption).length;
  if (!wrongQs.length) return { correct, total, items: [], encouragement: defaultEncouragement(correct, total), fallback: null };

  const opt = (q: (typeof questions)[number], k: Letter | undefined | null) => (k ? `${k}. ${q[`option${k}`]}` : null);
  const manuals = await store.manualsForQuestions(
    Array.from(new Set(wrongQs.map((q) => q.sourceManualId).filter((x): x is number => !!x))),
    Array.from(new Set([s.categoryId, ...wrongQs.map((q) => q.categoryId)].filter((x): x is number => !!x))),
  );
  const chunks = chunkManuals(manuals);

  const items: QuizExplainItem[] = wrongQs.map((q) => {
    const correctText = q[`option${q.correctOption as Letter}`];
    const query = `${q.question} ${correctText}`;
    const own = q.sourceManualId ? chunks.filter((c) => c.manualId === q.sourceManualId) : [];
    const hit = (own.length ? retrieveChunks(query, own, { topK: 1, minCoverage: 0.2 })[0] : undefined)
      ?? retrieveChunks(query, chunks, { topK: 1, minCoverage: 0.25 })[0];
    const quote = hit ? { text: bestQuote(hit, query), manualId: hit.manualId, manualTitle: hit.manualTitle, heading: hit.heading } : null;
    const review = hit
      ? (hit.heading && hit.heading !== hit.manualTitle ? `Revê a secção «${hit.heading}» do manual «${hit.manualTitle}».` : `Revê o manual «${hit.manualTitle}».`)
      : null;
    return {
      questionId: q.id,
      question: q.question,
      yourAnswer: opt(q, ans.get(q.id)),
      correctAnswer: opt(q, q.correctOption as Letter)!,
      explanation: q.explanation?.trim() || `A resposta certa é a ${opt(q, q.correctOption as Letter)}.`,
      quote: quote && quote.text ? quote : null,
      review,
    };
  });

  const deterministic = (fallback: TutorFallback): QuizExplanation => ({ correct, total, items, encouragement: defaultEncouragement(correct, total), fallback });
  if (!(await aiFeatureAvailableFresh("training_tutor"))) return deterministic("disabled");
  await enforceRateLimit(user.id);

  const wrongInput: WrongAnswerInput[] = items.map((it, i) => ({
    questionId: it.questionId,
    question: it.question,
    yourAnswer: it.yourAnswer,
    correctAnswer: it.correctAnswer,
    trainerExplanation: wrongQs[i].explanation ?? null,
    passage: it.quote ? { manualTitle: it.quote.manualTitle, heading: it.quote.heading, quote: it.quote.text } : null,
  }));
  try {
    const r = await runAi({
      feature: "training_tutor",
      system: QUIZ_EXPLAIN_SYSTEM,
      input: quizExplainInput(correct, total, wrongInput),
      schema: quizExplainSchema,
      maxTokens: Math.min(1600, 250 + 120 * items.length),
      timeoutMs: 25_000,
      retries: 1,
      userId: user.id,
      entity: "training_quiz_session",
      entityId: sessionId,
    });
    const byId = new Map(r.output.items.map((x) => [Number(x.questionId), x.explanation]));
    return {
      correct, total, fallback: null,
      encouragement: limitWords(r.output.encouragement || defaultEncouragement(correct, total), 30),
      items: items.map((it) => {
        const e = byId.get(it.questionId)?.trim();
        return e ? { ...it, explanation: limitWords(e, 60) } : it;
      }),
    };
  } catch (err) {
    return deterministic(fallbackOf(err));
  }
}

// ─── Histórico e vista dos formadores ──────────────────────────────────────

/** Histórico do PRÓPRIO (o userId vem sempre da sessão, nunca do cliente). */
export async function tutorHistory(userId: number, ctx: TutorContext) {
  const rows = await store.recentHistory(userId, ctx, TUTOR_HISTORY_TURNS * 2);
  return rows.map((r) => ({ role: r.role, content: r.content, outOfContent: r.outOfContent, createdAt: r.createdAt }));
}

export async function trainerQuestionsView(days: number, now: Date = new Date()) {
  const since = new Date(now.getTime() - Math.max(1, days) * 86400_000);
  const { modules, questions } = await store.questionStats(since);
  const titles = await store.moduleTitles(modules);
  return modules.map((m) => {
    const key = `${m.contextType}:${m.contextId}`;
    return {
      contextType: m.contextType,
      contextId: m.contextId,
      title: titles.get(key) ?? `(${m.contextType} #${m.contextId} removido)`,
      asks: m.asks,
      unanswered: m.unanswered,
      distinctQuestions: m.distinctQuestions,
      lastAskedAt: m.lastAskedAt,
      questions: questions
        .filter((q) => q.contextType === m.contextType && q.contextId === m.contextId)
        .slice(0, 15)
        .map((q) => ({ text: q.sampleText, count: q.askCount, unanswered: q.outOfContentCount, lastAskedAt: q.lastAskedAt })),
    };
  });
}
