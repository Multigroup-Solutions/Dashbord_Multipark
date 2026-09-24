/**
 * Tutor da Formação — acesso à BD (módulos, histórico, perguntas frequentes,
 * progresso do formando). Toda a lógica está em ./trainingTutor e as regras
 * puras em ./trainingTutorRules.
 *
 * SQL parametrizado (drizzle) e seguro com ONLY_FULL_GROUP_BY (só agregados
 * nas colunas fora do GROUP BY).
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  quizAttempts, quizQuestions, trainingAssignments, trainingAttemptSessions, trainingCategories, trainingManuals, trainingPathItems,
  trainingPaths, trainingProgress, trainingTutorMessages, trainingTutorQuestions, trainingVideos, users,
} from "../drizzle/schema";
import { TUTOR_HISTORY_DAYS, type TutorContext, type TutorContextType } from "../shared/trainingTutor";
import { lisbonDay, parseDbDate, toDbDate } from "./trainingRules";
import type { ManualDoc } from "./trainingTutorRules";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível");
  return d;
}

const MAX_MANUALS_PER_MODULE = 30;

export interface TutorModule {
  title: string;
  manuals: ManualDoc[];
  /** Quem criou o conteúdo (recurso para o nome do formador). */
  createdBy: number | null;
  /** Categoria (quiz / vídeo) — para dicas e para as perguntas do quiz. */
  categoryId: number | null;
  found: boolean;
}

type ManualRow = { id: number; title: string; content: string; createdBy: number | null };

async function manualsWhere(where: ReturnType<typeof and> | undefined, includeUnpublished: boolean): Promise<ManualRow[]> {
  const d = await db();
  return d.select({ id: trainingManuals.id, title: trainingManuals.title, content: trainingManuals.content, createdBy: trainingManuals.createdBy })
    .from(trainingManuals)
    .where(and(where, includeUnpublished ? undefined : eq(trainingManuals.published, 1)))
    .orderBy(asc(trainingManuals.id))
    .limit(MAX_MANUALS_PER_MODULE);
}

const asDoc = (m: { id: number; title: string; content: string | null }): ManualDoc => ({ id: m.id, title: m.title, content: m.content ?? "" });

/** O conteúdo de um módulo (manual, vídeo, percurso ou quiz). */
export async function loadModule(ctx: TutorContext, opts: { includeUnpublished: boolean }): Promise<TutorModule> {
  const d = await db();
  const empty: TutorModule = { title: "", manuals: [], createdBy: null, categoryId: null, found: false };
  if (ctx.type === "manual") {
    const [m] = await manualsWhere(eq(trainingManuals.id, ctx.id), opts.includeUnpublished);
    if (!m) return empty;
    return { title: m.title, manuals: [asDoc(m)], createdBy: m.createdBy ?? null, categoryId: null, found: true };
  }
  if (ctx.type === "video") {
    const [v] = await d.select().from(trainingVideos).where(eq(trainingVideos.id, ctx.id)).limit(1);
    if (!v) return empty;
    const same = await manualsWhere(eq(trainingManuals.categoryId, v.categoryId), opts.includeUnpublished);
    const videoDoc: ManualDoc = { id: 0, title: `Vídeo: ${v.title}`, content: v.description ?? "" };
    return { title: v.title, manuals: [videoDoc, ...same.map(asDoc)], createdBy: v.createdBy ?? null, categoryId: v.categoryId, found: true };
  }
  if (ctx.type === "path") {
    const [p] = await d.select().from(trainingPaths).where(eq(trainingPaths.id, ctx.id)).limit(1);
    if (!p) return empty;
    const items = await d.select().from(trainingPathItems).where(eq(trainingPathItems.pathId, p.id)).orderBy(asc(trainingPathItems.sortOrder), asc(trainingPathItems.id));
    const manualIds = items.filter((i) => i.itemType === "manual").map((i) => i.itemId);
    const videoIds = items.filter((i) => i.itemType === "video").map((i) => i.itemId);
    const catIds = items.filter((i) => i.itemType === "quiz" && i.itemId > 0).map((i) => i.itemId);
    const docs: ManualDoc[] = [];
    if (p.description) docs.push({ id: 0, title: `Percurso: ${p.name}`, content: p.description });
    if (manualIds.length) docs.push(...(await manualsWhere(inArray(trainingManuals.id, manualIds), opts.includeUnpublished)).map(asDoc));
    if (videoIds.length) {
      const vids = await d.select({ title: trainingVideos.title, description: trainingVideos.description }).from(trainingVideos).where(inArray(trainingVideos.id, videoIds));
      for (const v of vids) if (v.description) docs.push({ id: 0, title: `Vídeo: ${v.title}`, content: v.description });
    }
    if (catIds.length) {
      const seen = new Set(docs.map((x) => x.id));
      for (const m of await manualsWhere(inArray(trainingManuals.categoryId, catIds), opts.includeUnpublished)) if (!seen.has(m.id)) docs.push(asDoc(m));
    }
    return { title: p.name, manuals: docs, createdBy: p.createdById ?? null, categoryId: null, found: true };
  }
  // quiz: id = categoria (0 = geral → manuais de onde vieram as perguntas, senão todos).
  const catId = ctx.id > 0 ? ctx.id : null;
  let title = "Quiz";
  let rows: ManualRow[] = [];
  if (catId) {
    const [c] = await d.select({ name: trainingCategories.name }).from(trainingCategories).where(eq(trainingCategories.id, catId)).limit(1);
    if (c) title = `Quiz — ${c.name}`;
    rows = await manualsWhere(eq(trainingManuals.categoryId, catId), opts.includeUnpublished);
  } else {
    const src = await d.selectDistinct({ id: quizQuestions.sourceManualId }).from(quizQuestions)
      .where(and(eq(quizQuestions.published, 1), isNotNull(quizQuestions.sourceManualId)));
    const ids = src.map((r) => Number(r.id)).filter((n) => n > 0);
    rows = ids.length ? await manualsWhere(inArray(trainingManuals.id, ids), opts.includeUnpublished) : [];
    if (!rows.length) rows = await manualsWhere(undefined, opts.includeUnpublished);
  }
  return { title, manuals: rows.map(asDoc), createdBy: null, categoryId: catId, found: true };
}

/** Manuais para explicar perguntas do quiz: os de origem + os das categorias. */
export async function manualsForQuestions(sourceManualIds: number[], categoryIds: number[]): Promise<ManualDoc[]> {
  const out = new Map<number, ManualDoc>();
  if (sourceManualIds.length) for (const m of await manualsWhere(inArray(trainingManuals.id, sourceManualIds), false)) out.set(m.id, asDoc(m));
  if (categoryIds.length) for (const m of await manualsWhere(inArray(trainingManuals.categoryId, categoryIds), false)) out.set(m.id, asDoc(m));
  if (!out.size) for (const m of await manualsWhere(undefined, false)) out.set(m.id, asDoc(m));
  return Array.from(out.values());
}

/**
 * Quem é o formador deste módulo para este formando: o dono (criador) do
 * percurso atribuído que contém o item; senão quem criou o conteúdo.
 */
export async function trainerUserId(ctx: TutorContext, employeeId: number | null, fallback: number | null): Promise<number | null> {
  const d = await db();
  if (ctx.type === "path") return fallback;
  if (employeeId != null && (ctx.type === "manual" || ctx.type === "video" || ctx.type === "quiz")) {
    const rows = await d.select({ owner: trainingPaths.createdById }).from(trainingAssignments)
      .innerJoin(trainingPaths, eq(trainingPaths.id, trainingAssignments.pathId))
      .innerJoin(trainingPathItems, eq(trainingPathItems.pathId, trainingPaths.id))
      .where(and(eq(trainingAssignments.employeeId, employeeId), eq(trainingPathItems.itemType, ctx.type), eq(trainingPathItems.itemId, ctx.id), isNotNull(trainingPaths.createdById)))
      .orderBy(desc(trainingAssignments.assignedAt))
      .limit(1);
    if (rows[0]?.owner != null) return rows[0].owner;
  }
  return fallback;
}

export async function userName(userId: number | null): Promise<string | null> {
  if (userId == null) return null;
  const d = await db();
  const [u] = await d.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.name ?? null;
}

// ─── Progresso (saudação) ──────────────────────────────────────────────────

/** Dias (Lisboa) com atividade de formação nos últimos 60 dias. */
export async function activityDays(employeeId: number, now: Date = new Date()): Promise<string[]> {
  const d = await db();
  const since = toDbDate(new Date(now.getTime() - 60 * 86400_000));
  const prog = await d.select({ viewedAt: trainingProgress.viewedAt, completedAt: trainingProgress.completedAt, updatedAt: trainingProgress.updatedAt })
    .from(trainingProgress)
    .where(and(eq(trainingProgress.employeeId, employeeId), or(gte(trainingProgress.viewedAt, since), gte(trainingProgress.completedAt, since), gte(trainingProgress.updatedAt, since))));
  const quiz = await d.select({ createdAt: quizAttempts.createdAt }).from(quizAttempts)
    .where(and(eq(quizAttempts.employeeId, employeeId), gte(quizAttempts.createdAt, since)));
  const days = new Set<string>();
  const add = (s: string | null | undefined) => { if (s) { const dt = parseDbDate(s); if (!Number.isNaN(dt.getTime())) days.add(lisbonDay(dt)); } };
  for (const p of prog) { add(p.viewedAt); add(p.completedAt); add(p.updatedAt); }
  for (const q of quiz) add(q.createdAt);
  return Array.from(days);
}

// ─── Quiz (explicação das erradas) ─────────────────────────────────────────

export async function quizSession(sessionId: number) {
  const d = await db();
  const [s] = await d.select().from(trainingAttemptSessions).where(eq(trainingAttemptSessions.id, sessionId)).limit(1);
  return s ?? null;
}

export async function quizQuestionsByIds(ids: number[]) {
  if (!ids.length) return [];
  const d = await db();
  return d.select().from(quizQuestions).where(inArray(quizQuestions.id, ids));
}

// ─── Histórico ─────────────────────────────────────────────────────────────

export interface StoredTurn { role: "user" | "assistant"; content: string; outOfContent: boolean; createdAt: string }

/** Últimas `limit` mensagens DESTE utilizador neste módulo (mais antiga primeiro). */
export async function recentHistory(userId: number, ctx: TutorContext, limit: number, now: Date = new Date()): Promise<StoredTurn[]> {
  const d = await db();
  const since = toDbDate(new Date(now.getTime() - TUTOR_HISTORY_DAYS * 86400_000));
  const rows = await d.select({ role: trainingTutorMessages.role, content: trainingTutorMessages.content, outOfContent: trainingTutorMessages.outOfContent, createdAt: trainingTutorMessages.createdAt })
    .from(trainingTutorMessages)
    .where(and(eq(trainingTutorMessages.userId, userId), eq(trainingTutorMessages.contextType, ctx.type), eq(trainingTutorMessages.contextId, ctx.id), gte(trainingTutorMessages.createdAt, since)))
    .orderBy(desc(trainingTutorMessages.createdAt), desc(trainingTutorMessages.id))
    .limit(Math.max(1, Math.min(50, limit)));
  return rows.reverse().map((r) => ({ role: r.role === "assistant" ? "assistant" : "user", content: r.content, outOfContent: !!r.outOfContent, createdAt: r.createdAt }));
}

export async function saveTurn(t: { userId: number; employeeId: number | null; ctx: TutorContext; question: string; answer: string; outOfContent: boolean; now?: Date }) {
  const d = await db();
  const now = t.now ?? new Date();
  const q = toDbDate(now);
  const a = toDbDate(new Date(now.getTime() + 1000)); // a resposta fica sempre depois da pergunta
  await d.insert(trainingTutorMessages).values([
    { userId: t.userId, employeeId: t.employeeId, contextType: t.ctx.type, contextId: t.ctx.id, role: "user", content: t.question, outOfContent: t.outOfContent ? 1 : 0, createdAt: q },
    { userId: t.userId, employeeId: t.employeeId, contextType: t.ctx.type, contextId: t.ctx.id, role: "assistant", content: t.answer, outOfContent: t.outOfContent ? 1 : 0, createdAt: a },
  ]);
  // Limpeza oportunista (≈2% das escritas): histórico com mais de 30 dias.
  if (Math.random() < 0.02) await purgeOldHistory(now).catch(() => undefined);
}

export async function purgeOldHistory(now: Date = new Date()): Promise<void> {
  const d = await db();
  const cutoff = toDbDate(new Date(now.getTime() - TUTOR_HISTORY_DAYS * 86400_000));
  await d.execute(sql`DELETE FROM training_tutor_messages WHERE createdAt < ${cutoff} LIMIT 5000`);
}

export async function clearHistory(userId: number, ctx: TutorContext): Promise<void> {
  const d = await db();
  await d.delete(trainingTutorMessages).where(and(eq(trainingTutorMessages.userId, userId), eq(trainingTutorMessages.contextType, ctx.type), eq(trainingTutorMessages.contextId, ctx.id)));
}

// ─── Perguntas frequentes (anónimo) ────────────────────────────────────────

export async function recordQuestion(ctx: TutorContext, key: string, sample: string, outOfContent: boolean, now: Date = new Date()): Promise<void> {
  if (!key) return;
  const d = await db();
  const at = toDbDate(now);
  const ooc = outOfContent ? 1 : 0;
  await d.execute(sql`
    INSERT INTO training_tutor_questions (contextType, contextId, questionKey, sampleText, askCount, outOfContentCount, firstAskedAt, lastAskedAt)
    VALUES (${ctx.type}, ${ctx.id}, ${key}, ${sample.slice(0, 500)}, 1, ${ooc}, ${at}, ${at})
    ON DUPLICATE KEY UPDATE askCount = askCount + 1, outOfContentCount = outOfContentCount + ${ooc}, lastAskedAt = ${at}`);
}

export interface ModuleQuestionStats { contextType: TutorContextType; contextId: number; asks: number; unanswered: number; distinctQuestions: number; lastAskedAt: string | null }
export interface TopQuestion { contextType: TutorContextType; contextId: number; sampleText: string; askCount: number; outOfContentCount: number; lastAskedAt: string }

/** Agregado por módulo (desde `since`) e as perguntas mais feitas. */
export async function questionStats(since: Date, limit = 300): Promise<{ modules: ModuleQuestionStats[]; questions: TopQuestion[] }> {
  const d = await db();
  const s = toDbDate(since);
  const modules = await d.select({
    contextType: trainingTutorQuestions.contextType,
    contextId: trainingTutorQuestions.contextId,
    asks: sql<number>`SUM(${trainingTutorQuestions.askCount})`,
    unanswered: sql<number>`SUM(${trainingTutorQuestions.outOfContentCount})`,
    distinctQuestions: sql<number>`COUNT(*)`,
    lastAskedAt: sql<string>`MAX(${trainingTutorQuestions.lastAskedAt})`,
  }).from(trainingTutorQuestions)
    .where(gte(trainingTutorQuestions.lastAskedAt, s))
    .groupBy(trainingTutorQuestions.contextType, trainingTutorQuestions.contextId)
    .orderBy(desc(sql`SUM(${trainingTutorQuestions.askCount})`))
    .limit(100);
  const questions = await d.select({
    contextType: trainingTutorQuestions.contextType,
    contextId: trainingTutorQuestions.contextId,
    sampleText: trainingTutorQuestions.sampleText,
    askCount: trainingTutorQuestions.askCount,
    outOfContentCount: trainingTutorQuestions.outOfContentCount,
    lastAskedAt: trainingTutorQuestions.lastAskedAt,
  }).from(trainingTutorQuestions)
    .where(gte(trainingTutorQuestions.lastAskedAt, s))
    .orderBy(desc(trainingTutorQuestions.askCount), desc(trainingTutorQuestions.lastAskedAt))
    .limit(Math.max(1, Math.min(1000, limit)));
  return {
    modules: modules.map((m) => ({ ...m, contextType: m.contextType as TutorContextType, asks: Number(m.asks ?? 0), unanswered: Number(m.unanswered ?? 0), distinctQuestions: Number(m.distinctQuestions ?? 0), lastAskedAt: m.lastAskedAt ? String(m.lastAskedAt) : null })),
    questions: questions.map((q) => ({ ...q, contextType: q.contextType as TutorContextType })),
  };
}

/** Títulos dos módulos (para a vista dos formadores). */
export async function moduleTitles(refs: Array<{ contextType: string; contextId: number }>): Promise<Map<string, string>> {
  const d = await db();
  const out = new Map<string, string>();
  const ids = (t: string) => Array.from(new Set(refs.filter((r) => r.contextType === t).map((r) => r.contextId).filter((n) => n > 0)));
  const m = ids("manual"), v = ids("video"), p = ids("path"), q = ids("quiz");
  if (m.length) for (const r of await d.select({ id: trainingManuals.id, t: trainingManuals.title }).from(trainingManuals).where(inArray(trainingManuals.id, m))) out.set(`manual:${r.id}`, r.t);
  if (v.length) for (const r of await d.select({ id: trainingVideos.id, t: trainingVideos.title }).from(trainingVideos).where(inArray(trainingVideos.id, v))) out.set(`video:${r.id}`, r.t);
  if (p.length) for (const r of await d.select({ id: trainingPaths.id, t: trainingPaths.name }).from(trainingPaths).where(inArray(trainingPaths.id, p))) out.set(`path:${r.id}`, r.t);
  out.set("quiz:0", "Quiz (geral)");
  if (q.length) for (const r of await d.select({ id: trainingCategories.id, t: trainingCategories.name }).from(trainingCategories).where(inArray(trainingCategories.id, q))) out.set(`quiz:${r.id}`, `Quiz — ${r.t}`);
  return out;
}


