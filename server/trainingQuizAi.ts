/**
 * Quiz feito pela IA em cada jogo (Jorge, 14 out 2026: "a IA devia fazer as
 * perguntas a partir da base de conhecimento, perguntas diferentes de cada
 * vez. Mas isto ficou na versão antiga e ainda tem as perguntas fixas").
 *
 *   tema (escolhido, o da formação ou "tudo") → trechos que a PESSOA pode ver
 *   (base de conhecimento pela visibilidade de papel/cidade + manuais
 *   publicados), escolhidos ao acaso → runAi (quiz_live) com a lista das
 *   perguntas que a pessoa já teve → validação (trainingAiRules) → as
 *   perguntas ficam em training_quiz_ai_questions com a resposta certa; o
 *   browser só recebe a pergunta e as opções.
 *
 * Qualquer falha (IA desligada, sem trechos, resposta fraca) → null e o jogo
 * usa as perguntas fixas (trainingAttempts.startQuizAttempt).
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { isTrainingArea, sameSubarea, TRAINING_AREA_LABELS, effectiveArea, searchCatalog, type TrainingAreaId } from "../shared/trainingAreas";
import type { KbViewer } from "../shared/knowledge";
import { LIVE_QUIZ_MIN_VALID, isPublicKbVisibility, liveQuestionRestricted, pickExcerpts, questionKeyOf, validateLiveQuestions, type Excerpt, type LiveQuestion } from "./trainingAiRules";
import { chunkManual } from "./trainingTutorRules";
import { getDb } from "./db";

export interface QuizTopic {
  categoryId?: number | null;
  area?: string | null;
  subarea?: string | null;
  /** Tema escrito pela pessoa (ex.: "fechar a caixa"). */
  topic?: string | null;
}

export interface LiveQuizResult {
  /** `restricted`: pode ter saído de um documento que nem toda a gente vê (para quem gere e "Guardar nas fixas"). */
  questions: Array<LiveQuestion & { sourceKbDocId: number | null; sourceManualId: number | null; sourceTitle: string | null; restricted: boolean }>;
  topicLabel: string;
}

/** Orçamento de texto por jogo (trechos). */
const MATERIAL_MAX_CHARS = 12_000;

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível");
  return d;
}
const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

/** Texto do tema para mostrar e para procurar. PURA. */
export function quizTopicLabel(t: QuizTopic, categoryName?: string | null): string {
  const free = String(t.topic ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (free) return free;
  if (isTrainingArea(t.area)) return t.subarea ? `${TRAINING_AREA_LABELS[t.area]} · ${t.subarea}` : TRAINING_AREA_LABELS[t.area];
  if (categoryName) return categoryName;
  return "Tudo";
}

/** Há tema (para procurar trechos) ou é "tudo"? PURA. */
export function hasTopic(t: QuizTopic): boolean {
  return !!String(t.topic ?? "").trim() || isTrainingArea(t.area) || !!t.categoryId;
}

/** A IA do quiz pode correr agora? (AI_ENABLED + AI_QUIZ_LIVE + fornecedor). */
export async function liveQuizAvailable(): Promise<boolean> {
  try {
    const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
    return await aiFeatureAvailableFresh("quiz_live");
  } catch {
    return false;
  }
}

/** Manuais publicados que servem para o tema (pela área/subsecção, categoria ou texto). */
async function manualExcerpts(topic: QuizTopic, query: string): Promise<Excerpt[]> {
  const d = await db();
  const { trainingManuals, trainingCategories } = await import("../drizzle/schema");
  const [rows, cats] = await Promise.all([
    d.select({ id: trainingManuals.id, title: trainingManuals.title, content: trainingManuals.content, type: trainingManuals.type, categoryId: trainingManuals.categoryId, area: trainingManuals.area, subarea: trainingManuals.subarea })
      .from(trainingManuals).where(and(eq(trainingManuals.published, 1), isNull(trainingManuals.archivedAt))).orderBy(desc(trainingManuals.updatedAt)).limit(300),
    d.select({ id: trainingCategories.id, name: trainingCategories.name }).from(trainingCategories),
  ]);
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const usable = rows.filter((m) => m.type !== "link" && String(m.content ?? "").trim().length >= 80);
  let chosen = usable;
  if (String(topic.topic ?? "").trim()) {
    const hits = searchCatalog(query, usable.map((m) => ({ key: String(m.id), title: m.title, category: m.categoryId ? catName.get(m.categoryId) ?? null : null, text: m.content, m })), 6);
    chosen = hits.map((h) => h.item.m);
  } else if (isTrainingArea(topic.area)) {
    chosen = usable.filter((m) => {
      const e = effectiveArea(m, m.categoryId ? catName.get(m.categoryId) ?? null : null);
      return e.area === topic.area && (!topic.subarea || sameSubarea(e.subarea, topic.subarea));
    });
  } else if (topic.categoryId) {
    chosen = usable.filter((m) => m.categoryId === topic.categoryId);
  }
  return chosen.slice(0, 20).flatMap((m) => chunkManual({ id: m.id, title: m.title, content: m.content }).map((c) => ({
    title: m.title, section: c.heading !== m.title ? c.heading : null, text: c.text, manualId: m.id, kbDocId: null,
  })));
}

/** Documentos da base de conhecimento que TODA a gente pode ver (id → sim/não). Falha → mapa vazio (= restritos). */
export async function kbDocsPublic(ids: readonly number[]): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>();
  const clean = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)));
  if (!clean.length) return out;
  try {
    const d = await db();
    const rows = rowsOf(await d.execute(sql`SELECT d.id, d.visibilityRoles, d.visibilityCities FROM kb_documents d WHERE d.id IN (${sql.join(clean.map((x) => sql`${x}`), sql`, `)})`));
    for (const r of rows) out.set(Number(r.id), isPublicKbVisibility(r.visibilityRoles, r.visibilityCities));
  } catch { /* sem resposta: ficam como restritos */ }
  return out;
}

/** Trechos da base de conhecimento visíveis para quem joga. Com tema: os mais parecidos; sem tema: ao acaso. */
async function kbExcerpts(query: string | null, viewer: KbViewer): Promise<Excerpt[]> {
  if (query) {
    const { retrieveKnowledge } = await import("./knowledge/retrieve");
    const r = await retrieveKnowledge({ question: query, viewer, topK: 8 });
    return r.hits.map((h) => ({ title: h.title, section: h.section, text: h.text, kbDocId: h.docId, manualId: null }));
  }
  const d = await db();
  const { kbVisibilitySql } = await import("./knowledge/store");
  // "Tudo": 4 documentos ao acaso (manuais da empresa — a ajuda da app só entra com tema) e 3 trechos de cada.
  const docs = rowsOf(await d.execute(sql`SELECT d.id, d.title FROM kb_documents d
    WHERE d.deletedAt IS NULL AND d.status = 'synced' AND d.source IN ('drive', 'upload') AND d.chunkCount > 0 AND ${kbVisibilitySql(viewer)}
    ORDER BY RAND() LIMIT 4`));
  if (!docs.length) return [];
  const ids = docs.map((r) => Number(r.id));
  const title = new Map(docs.map((r) => [Number(r.id), String(r.title ?? "")]));
  const chunks = rowsOf(await d.execute(sql`SELECT c.docId, c.section, c.text FROM kb_chunks c
    WHERE c.docId IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)}) ORDER BY RAND() LIMIT 12`));
  return chunks.map((c) => ({ title: title.get(Number(c.docId)) ?? "", section: c.section != null ? String(c.section) : null, text: String(c.text ?? ""), kbDocId: Number(c.docId), manualId: null }));
}

/** As perguntas que a pessoa já teve (para a IA não as repetir). */
export async function recentAiQuestions(employeeId: number, limit = 40): Promise<string[]> {
  try {
    const d = await db();
    const { trainingQuizAiQuestions } = await import("../drizzle/schema");
    const rows = await d.select({ question: trainingQuizAiQuestions.question }).from(trainingQuizAiQuestions)
      .where(eq(trainingQuizAiQuestions.employeeId, employeeId)).orderBy(desc(trainingQuizAiQuestions.id)).limit(limit);
    return rows.map((r) => r.question);
  } catch {
    return [];
  }
}

/**
 * Perguntas novas para um jogo, ou null (sem trechos / IA falhou / poucas
 * válidas — o motivo vai em `reason`). Não grava nada.
 */
export async function generateLiveQuiz(input: {
  topic: QuizTopic;
  categoryName?: string | null;
  viewer: KbViewer;
  employeeId: number;
  userId: number;
  n: number;
  rand?: () => number;
}): Promise<{ result: LiveQuizResult | null; reason: string | null }> {
  const label = quizTopicLabel(input.topic, input.categoryName);
  const query = hasTopic(input.topic) ? (String(input.topic.topic ?? "").trim() || (isTrainingArea(input.topic.area)
    ? [TRAINING_AREA_LABELS[input.topic.area as TrainingAreaId], input.topic.subarea ?? ""].join(" ").trim()
    : input.categoryName ?? "")) : null;
  const [kb, manuals] = await Promise.all([
    kbExcerpts(query || null, input.viewer).catch(() => [] as Excerpt[]),
    manualExcerpts(input.topic, query ?? "").catch(() => [] as Excerpt[]),
  ]);
  const excerpts = pickExcerpts([...kb, ...manuals], { maxChars: MATERIAL_MAX_CHARS, maxItems: 10, rand: input.rand });
  if (!excerpts.length) return { result: null, reason: hasTopic(input.topic) ? `Não encontrei conteúdo sobre «${label}» na base de conhecimento.` : "A base de conhecimento ainda não tem conteúdo para perguntas." };

  const { redactPii } = await import("./_core/ai/pii");
  // Que trechos vêm de documentos restritos (papel/cidade)? Os manuais são de toda a gente.
  const pub = await kbDocsPublic(excerpts.map((e) => e.kbDocId ?? 0));
  const tagged = excerpts.map((e, i) => {
    const red = redactPii(e.text.slice(0, 2500));
    return { tag: `S${i + 1}`, e, red, isPublic: e.kbDocId ? pub.get(e.kbDocId) === true : true };
  });
  const publicByTag = new Map(tagged.map((t) => [t.tag, t.isPublic]));
  const recent = await recentAiQuestions(input.employeeId);
  const { runAi } = await import("./_core/ai/run");
  const { LIVE_QUIZ_SYSTEM, liveQuizInput, liveQuizResponseSchema } = await import("./_core/ai/prompts/trainingAi");
  const seed = Math.floor((input.rand ?? Math.random)() * 9000) + 1000;
  let raw: unknown[];
  try {
    const r = await runAi({
      feature: "quiz_live",
      system: LIVE_QUIZ_SYSTEM,
      input: liveQuizInput({ topic: redactPii(label).text, excerpts: tagged.map((t) => ({ tag: t.tag, title: t.e.title, section: t.e.section, text: t.red.text })), n: input.n, recent, seed }),
      schema: liveQuizResponseSchema,
      maxTokens: Math.min(6000, 700 + input.n * 380),
      temperature: 0.9,
      timeoutMs: 30_000,
      retries: 0,
      userId: input.userId,
      entity: "training_quiz_live",
      entityId: input.employeeId,
    });
    // Tira os marcadores de dados pessoais (de todos os trechos) antes de validar.
    const strip = (s: string) => tagged.reduce((acc, t) => t.red.strip(acc), s);
    raw = r.output.questions.map((q) => ({
      ...q,
      question: strip(q.question), optionA: strip(q.optionA), optionB: strip(q.optionB), optionC: strip(q.optionC), optionD: strip(q.optionD),
      explanation: q.explanation ? strip(q.explanation) : q.explanation,
    }));
  } catch (err) {
    const { aiUserMessage } = await import("./_core/ai/errors");
    return { result: null, reason: aiUserMessage(err) };
  }
  const tags = new Set(tagged.map((t) => t.tag));
  const min = Math.min(LIVE_QUIZ_MIN_VALID, input.n);
  let valid = validateLiveQuestions(raw, { n: input.n, recent, sourceTags: tags, rand: input.rand });
  if (valid.length < min) {
    // Base pequena: já não há perguntas novas que cheguem — completa com as já
    // feitas (melhor um jogo com algumas repetidas do que voltar às fixas).
    const seen = new Set(valid.map((v) => v.question));
    const again = validateLiveQuestions(raw, { n: input.n, recent: [], sourceTags: tags, rand: input.rand }).filter((v) => !seen.has(v.question));
    valid = [...valid, ...again].slice(0, input.n);
  }
  if (valid.length < min) return { result: null, reason: "A IA não fez perguntas suficientes desta vez." };
  const byTag = new Map(tagged.map((t) => [t.tag, t.e]));
  return {
    reason: null,
    result: {
      topicLabel: label,
      questions: valid.map((q) => {
        const src = q.sourceTag ? byTag.get(q.sourceTag) : undefined;
        return {
          ...q, sourceKbDocId: src?.kbDocId ?? null, sourceManualId: src?.manualId ?? null, sourceTitle: src ? src.title.slice(0, 300) : null,
          restricted: liveQuestionRestricted(q.sourceTag, publicByTag),
        };
      }),
    },
  };
}

/**
 * Grava as perguntas na tentativa JÁ RESERVADA (trainingAttempts reserva-a
 * antes de chamar a IA, para o limite diário contar logo) — transação: ou
 * ficam todas e a tentativa passa a apontar para elas, ou nada.
 * Devolve os ids das perguntas, pela ordem.
 */
export async function saveLiveQuizQuestions(input: {
  sessionId: number;
  employeeId: number;
  result: LiveQuizResult;
}): Promise<{ questionIds: number[] }> {
  const d = await db();
  const { trainingAttemptSessions, trainingQuizAiQuestions } = await import("../drizzle/schema");
  const insertId = (r: any): number => Number(r?.[0]?.insertId ?? r?.insertId ?? 0);
  return d.transaction(async (tx) => {
    const ids: number[] = [];
    let ord = 0;
    for (const q of input.result.questions) {
      const r = await tx.insert(trainingQuizAiQuestions).values({
        sessionId: input.sessionId, employeeId: input.employeeId, ord: ord++, question: q.question, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD,
        correctOption: q.correctOption, explanation: q.explanation, difficulty: q.difficulty, points: 10, questionKey: questionKeyOf(q.question) || null,
        sourceKbDocId: q.sourceKbDocId, sourceManualId: q.sourceManualId, sourceTitle: q.sourceTitle, restricted: q.restricted ? 1 : 0,
      });
      ids.push(insertId(r));
    }
    if (!ids.length || ids.some((x) => !x)) throw new Error("Perguntas não gravadas");
    await tx.update(trainingAttemptSessions)
      .set({ questionIds: JSON.stringify(ids), source: "ai", topic: input.result.topicLabel.slice(0, 160) })
      .where(and(eq(trainingAttemptSessions.id, input.sessionId), eq(trainingAttemptSessions.employeeId, input.employeeId)));
    return { questionIds: ids };
  });
}
