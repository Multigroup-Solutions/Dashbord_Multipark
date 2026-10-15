/**
 * Críticas: o que não é crítica e a mesma crítica repetida (plano MPV, F6b —
 * R2/R3). As regras são de shared/reviewDedup.ts; aqui está a BD.
 *
 * Nada se apaga: marcar é `notAReview = 1` (com o rascunho guardado em
 * `reviewMarkBackup`, para repor) ou `duplicateOf = <original>`. As marcadas
 * saem das listas, dos números e dos rascunhos automáticos (server/db.ts,
 * server/reviewAutoDraft.ts). Desfazer repõe tudo e a limpeza não volta a
 * propor essa crítica (`reviewMarkUndoneAt`).
 *
 * A limpeza das que já existem (Críticas → Limpeza, admin) é só
 * pré-visualizar → aplicar → (desfazer). Nunca corre sozinha (D9).
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { googleReviews } from "../drizzle/schema";
import { getDb } from "./db";
import {
  findDuplicateOf, notAReviewDecision, planDuplicateCleanup, reviewDateMs, reviewTextKey, reviewerFirstNameKey,
  REVIEW_DEDUP_WINDOW_HOURS, type DedupCleanupRow, type ReviewDedupFacts,
} from "../shared/reviewDedup";

const nowStr = () => new Date().toISOString().slice(0, 19).replace("T", " ");

/** Interruptor das automações (Definições → Automações), lido fresco (cache de 30 s). Nunca lança. */
export async function reviewFlagOn(name: "REVIEWS_EMAIL_STRICT" | "REVIEWS_DEDUP"): Promise<boolean> {
  try {
    const { ensureFeatureFlagOverrides, isFeatureEnabled } = await import("./_core/featureFlags");
    const { automationFlagDefault } = await import("../shared/appSettings");
    await ensureFeatureFlagOverrides().catch(() => {});
    return isFeatureEnabled(name, { defaultEnabled: automationFlagDefault(name) });
  } catch {
    return false;
  }
}

/** O que se lê de cada crítica para as duas limpezas. */
export interface ReviewRowLite {
  id: number;
  reviewerName: string | null;
  rating: number;
  reviewText: string | null;
  reviewDate: string | null;
  sourceEmailDate: string | null;
  createdAt: string | null;
  projectId: number | null;
  googleReviewKey: string | null;
  sourceEmailId: string | null;
  complaintId: number | null;
  googleReply: string | null;
  respondedAt: string | null;
  status: string;
  notAReview: number | boolean | null;
  duplicateOf: number | null;
  reviewMarkUndoneAt: string | null;
}

/**
 * Factos de repetida de uma crítica guardada. Nas de email o texto guardado é
 * "assunto + corpo limpo": volta-se a ler (com o assunto) para achar o nome e
 * as estrelas que o leitor antigo perdeu ("Google Business Profile"). PURA
 * (o leitor do email não toca na BD).
 */
export function dedupFactsOfRow(r: Pick<ReviewRowLite, "id" | "reviewerName" | "rating" | "reviewText" | "reviewDate" | "sourceEmailDate" | "createdAt" | "projectId" | "googleReviewKey" | "sourceEmailId">, parse: (body: string, subject: string) => { reviewerName?: string; rating: number }): ReviewDedupFacts {
  let name = r.reviewerName ?? "";
  let rating = Number(r.rating) || 0;
  if (r.sourceEmailId && !r.googleReviewKey) {
    const [subject = "", ...rest] = String(r.reviewText ?? "").replace(/\r/g, "").split("\n");
    const g = parse(rest.join("\n"), subject);
    if (!reviewerFirstNameKey(name) && g.reviewerName) name = g.reviewerName;
    if (!(rating > 0) && g.rating > 0) rating = g.rating;
  }
  return {
    id: Number(r.id),
    parkKey: r.projectId != null ? `p${r.projectId}` : null,
    rating,
    textKey: reviewTextKey(r.reviewText, name),
    firstName: reviewerFirstNameKey(name),
    atMs: reviewDateMs(r.reviewDate, r.sourceEmailDate, r.createdAt),
    apiKey: !!r.googleReviewKey,
  };
}

async function emailParser() {
  const { parseGoogleReviewNotification } = await import("./emailParse");
  return (body: string, subject: string) => parseGoogleReviewNotification(body, subject);
}

const rowsOf = (res: any): any[] => (Array.isArray(res?.[0]) ? res[0] : Array.isArray(res) ? res : []);

/**
 * A crítica que está a chegar por email (R3, com o REVIEWS_DEDUP) é repetida
 * de outra? Procura só à volta (mesmas estrelas, ±48 h, mesmo parque ou sem
 * parque) e devolve o id da original, ou null. Nunca lança.
 */
export async function findEmailReviewDuplicate(n: Omit<ReviewDedupFacts, "id">): Promise<number | null> {
  try {
    if (!(n.rating >= 1) || n.atMs == null) return null;
    const db = await getDb();
    if (!db) return null;
    const at = new Date(n.atMs).toISOString().slice(0, 19).replace("T", " ");
    const projectId = n.parkKey?.startsWith("p") ? Number(n.parkKey.slice(1)) : null;
    const res = await db.execute(sql`SELECT id, reviewerName, rating, reviewText, reviewDate, sourceEmailDate, createdAt, projectId, googleReviewKey, sourceEmailId
      FROM google_reviews
      WHERE rating = ${n.rating} AND notAReview = 0 AND duplicateOf IS NULL
        ${projectId != null ? sql`AND (projectId = ${projectId} OR projectId IS NULL)` : sql``}
        AND COALESCE(reviewDate, sourceEmailDate, createdAt) BETWEEN DATE_SUB(${at}, INTERVAL ${REVIEW_DEDUP_WINDOW_HOURS} HOUR) AND DATE_ADD(${at}, INTERVAL ${REVIEW_DEDUP_WINDOW_HOURS} HOUR)
      ORDER BY id LIMIT 200`);
    const parse = await emailParser();
    const existing = rowsOf(res).map((r) => dedupFactsOfRow(r, parse));
    return findDuplicateOf({ ...n, id: -1 }, existing);
  } catch (err: any) {
    console.warn("[Críticas] procura de repetida falhou:", String(err?.message ?? err).slice(0, 160));
    return null;
  }
}

// ─── Limpeza das que já existem (admin) ─────────────────────────────────────

export type ReviewCleanupKind = "not_review" | "duplicate";

export interface ReviewCleanupItem {
  id: number;
  reviewerName: string;
  rating: number;
  /** Data da crítica (ou do email). */
  date: string | null;
  snippet: string;
  projectId: number | null;
  fromEmail?: string | null;
  duplicateOf?: number | null;
  hasDraft?: boolean;
  why?: string;
}

export interface ReviewCleanupPreview {
  kind: ReviewCleanupKind;
  /** Vão ser marcadas ao aplicar. */
  mark: ReviewCleanupItem[];
  /** Batem na regra mas ficam (com o porquê). */
  keep: ReviewCleanupItem[];
  /** Já marcadas (para desfazer). */
  marked: ReviewCleanupItem[];
}

const LIST_MAX = 300;

async function loadRows(kind: ReviewCleanupKind): Promise<Array<ReviewRowLite & { aiResponse: string | null; fromEmail: string | null }>> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const where = kind === "not_review" ? sql`sourceEmailId IS NOT NULL` : sql`rating >= 1`;
  const rows = rowsOf(await db.execute(sql`SELECT id, reviewerName, rating, reviewText, reviewDate, sourceEmailDate, createdAt, projectId, googleReviewKey,
      sourceEmailId, complaintId, googleReply, respondedAt, status, notAReview, duplicateOf, reviewMarkUndoneAt, aiResponse
    FROM google_reviews WHERE ${where} ORDER BY id LIMIT 20000`));
  // Remetente de cada email (inbound_emails, pelo Message-ID) — em lotes, sem JOIN entre colações.
  const fromBy = new Map<string, string | null>();
  const ids = [...new Set(rows.map((r) => r.sourceEmailId).filter(Boolean).map(String))];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const got = rowsOf(await db.execute(sql`SELECT messageId, fromEmail FROM inbound_emails WHERE messageId IN (${sql.join(chunk.map((m) => sql`${m}`), sql`, `)})`));
    for (const g of got) fromBy.set(String(g.messageId), g.fromEmail ?? null);
  }
  return rows.map((r) => ({ ...r, fromEmail: r.sourceEmailId ? fromBy.get(String(r.sourceEmailId)) ?? null : null }));
}

function itemOf(r: ReviewRowLite & { aiResponse?: string | null; fromEmail?: string | null }, extra: Partial<ReviewCleanupItem> = {}): ReviewCleanupItem {
  const text = String(r.reviewText ?? "").replace(/\s+/g, " ").trim();
  return {
    id: Number(r.id),
    reviewerName: String(r.reviewerName ?? ""),
    rating: Number(r.rating) || 0,
    date: (r.reviewDate ?? r.sourceEmailDate ?? r.createdAt ?? null) as string | null,
    snippet: text.slice(0, 160),
    projectId: r.projectId != null ? Number(r.projectId) : null,
    fromEmail: r.fromEmail ?? null,
    duplicateOf: r.duplicateOf != null ? Number(r.duplicateOf) : null,
    hasDraft: !!String(r.aiResponse ?? "").trim(),
    ...extra,
  };
}

const isOn = (v: unknown) => v === true || Number(v) === 1;

function notReviewPlan(rows: Awaited<ReturnType<typeof loadRows>>) {
  const mark: typeof rows = [];
  const keep: Array<{ row: (typeof rows)[number]; why: string }> = [];
  for (const r of rows) {
    const d = notAReviewDecision({
      id: Number(r.id), fromEmail: r.fromEmail, rating: Number(r.rating) || 0, sourceEmailId: r.sourceEmailId,
      complaintId: r.complaintId, googleReviewKey: r.googleReviewKey, googleReply: r.googleReply, respondedAt: r.respondedAt,
      status: String(r.status), notAReview: isOn(r.notAReview), duplicateOf: r.duplicateOf, markUndone: !!r.reviewMarkUndoneAt,
    });
    if (!d) continue;
    if (d.action === "mark") mark.push(r);
    else keep.push({ row: r, why: d.why });
  }
  return { mark, keep };
}

async function duplicatePlan(rows: Awaited<ReturnType<typeof loadRows>>) {
  const parse = await emailParser();
  const facts: DedupCleanupRow[] = rows.map((r) => ({
    ...dedupFactsOfRow(r, parse),
    notAReview: isOn(r.notAReview),
    duplicateOf: r.duplicateOf != null ? Number(r.duplicateOf) : null,
    markUndone: !!r.reviewMarkUndoneAt,
    locked: !!r.complaintId || !!String(r.googleReply ?? "").trim() || !!r.respondedAt,
  }));
  return planDuplicateCleanup(facts);
}

/** Pré-visualização (nada muda). */
export async function previewReviewCleanup(kind: ReviewCleanupKind): Promise<ReviewCleanupPreview> {
  const rows = await loadRows(kind);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const marked = rows
    .filter((r) => (kind === "not_review" ? isOn(r.notAReview) : r.duplicateOf != null))
    .slice(-LIST_MAX).reverse().map((r) => itemOf(r));
  if (kind === "not_review") {
    const p = notReviewPlan(rows);
    return {
      kind,
      mark: p.mark.slice(0, LIST_MAX).map((r) => itemOf(r)),
      keep: p.keep.slice(0, LIST_MAX).map(({ row, why }) => itemOf(row, { why })),
      marked,
    };
  }
  const p = await duplicatePlan(rows);
  return {
    kind,
    mark: p.mark.slice(0, LIST_MAX).map((m) => itemOf(byId.get(m.id)!, { duplicateOf: m.duplicateOf })),
    keep: p.keep.slice(0, LIST_MAX).map((k) => itemOf(byId.get(k.id)!, { duplicateOf: k.duplicateOf, why: k.why })),
    marked,
  };
}

/**
 * Aplica a limpeza às críticas escolhidas (`ids`) — só às que a regra de
 * AGORA ainda marca (o servidor volta a calcular; um id fora do plano é
 * ignorado). Devolve quantas ficaram marcadas.
 */
export async function applyReviewCleanup(kind: ReviewCleanupKind, ids: readonly number[], userId: number | null): Promise<{ marked: number; skipped: number }> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const wanted = new Set(ids.map(Number));
  const rows = await loadRows(kind);
  let marked = 0;
  if (kind === "not_review") {
    const p = notReviewPlan(rows);
    for (const r of p.mark) {
      if (!wanted.has(Number(r.id))) continue;
      const backup = JSON.stringify({ aiResponse: r.aiResponse ?? null, status: r.status });
      const res = await db.update(googleReviews).set({
        notAReview: 1,
        reviewMarkedAt: nowStr(),
        reviewMarkedById: userId,
        reviewMarkBackup: backup,
        // Limpa o rascunho (fica guardado na cópia) e nunca mais faz um automático.
        aiResponse: null,
        aiResponseApproved: 0,
        aiDraftAttemptedAt: sql`COALESCE(${googleReviews.aiDraftAttemptedAt}, ${nowStr()})` as any,
        ...(r.status === "ai_responded" ? { status: "pending_response" as const } : {}),
      }).where(and(eq(googleReviews.id, Number(r.id)), eq(googleReviews.notAReview, 0), isNull(googleReviews.duplicateOf)));
      if (Number((res as any)?.[0]?.affectedRows ?? 0) > 0) marked++;
    }
  } else {
    const p = await duplicatePlan(rows);
    for (const m of p.mark) {
      if (!wanted.has(m.id)) continue;
      const res = await db.update(googleReviews).set({ duplicateOf: m.duplicateOf, reviewMarkedAt: nowStr(), reviewMarkedById: userId })
        .where(and(eq(googleReviews.id, m.id), eq(googleReviews.notAReview, 0), isNull(googleReviews.duplicateOf)));
      if (Number((res as any)?.[0]?.affectedRows ?? 0) > 0) marked++;
    }
  }
  return { marked, skipped: Math.max(0, wanted.size - marked) };
}

/**
 * Desfaz a marca (`ids`; vazio = todas as deste tipo). Repõe o rascunho
 * guardado (se entretanto ninguém escreveu outro) e a limpeza não volta a
 * propor estas críticas.
 */
export async function undoReviewCleanup(kind: ReviewCleanupKind, ids: readonly number[], userId: number | null): Promise<{ undone: number }> {
  void userId;
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const markedCond = kind === "not_review" ? eq(googleReviews.notAReview, 1) : isNotNull(googleReviews.duplicateOf);
  const list = await db.select({
    id: googleReviews.id, aiResponse: googleReviews.aiResponse, status: googleReviews.status, backup: googleReviews.reviewMarkBackup,
  }).from(googleReviews).where(and(markedCond, ...(ids.length ? [sql`${googleReviews.id} IN (${sql.join(ids.map((i) => sql`${Number(i)}`), sql`, `)})`] : []))).limit(5000);
  let undone = 0;
  for (const r of list) {
    if (kind === "duplicate") {
      const res = await db.update(googleReviews).set({ duplicateOf: null, reviewMarkUndoneAt: nowStr() })
        .where(and(eq(googleReviews.id, r.id), isNotNull(googleReviews.duplicateOf)));
      if (Number((res as any)?.[0]?.affectedRows ?? 0) > 0) undone++;
      continue;
    }
    let backup: { aiResponse?: string | null; status?: string } = {};
    try { backup = r.backup ? JSON.parse(String(r.backup)) : {}; } catch { backup = {}; }
    const restoreDraft = !String(r.aiResponse ?? "").trim() && !!String(backup.aiResponse ?? "").trim();
    const res = await db.update(googleReviews).set({
      notAReview: 0,
      reviewMarkUndoneAt: nowStr(),
      reviewMarkBackup: null,
      ...(restoreDraft ? { aiResponse: backup.aiResponse!, aiResponseApproved: 0 } : {}),
      ...(restoreDraft && backup.status === "ai_responded" && r.status === "pending_response" ? { status: "ai_responded" as const } : {}),
    }).where(and(eq(googleReviews.id, r.id), eq(googleReviews.notAReview, 1)));
    if (Number((res as any)?.[0]?.affectedRows ?? 0) > 0) undone++;
  }
  return { undone };
}
