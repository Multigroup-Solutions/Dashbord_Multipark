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
 * pré-visualizar → aplicar → (desfazer), no âmbito de cidades de quem pede.
 * Nunca corre sozinha (D9).
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { googleReviews } from "../drizzle/schema";
import { getDb } from "./db";
import { projectScope } from "./cityScope";
import {
  findDuplicateOf, notAReviewDecision, planDuplicateCleanup, reviewDateMs, reviewTextKeyFromApi, reviewTextKeyFromEmail, reviewerNameKey,
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

/** O email original de uma crítica (corpo cru e remetente), quando ainda está guardado. */
export interface RawEmail { body: string | null; fromEmail: string | null }

type Parse = (body: string, subject: string) => { reviewerName?: string; rating: number };

/** Nome e estrelas de uma crítica de email, relidos do email (com o assunto) quando os guardados não servem. PURA. */
function emailNameAndRating(r: Pick<ReviewRowLite, "reviewerName" | "rating" | "reviewText">, parse: Parse, raw: RawEmail | null | undefined): { name: string; rating: number } {
  let name = r.reviewerName ?? "";
  let rating = Number(r.rating) || 0;
  const [subject = "", ...rest] = String(r.reviewText ?? "").replace(/\r/g, "").split("\n");
  const g = parse(raw?.body ?? rest.join("\n"), subject);
  if (!reviewerNameKey(name) && g.reviewerName) name = g.reviewerName;
  if (!(rating > 0) && g.rating > 0) rating = g.rating;
  return { name, rating };
}

/**
 * Factos de repetida de uma crítica guardada. Nas de email, o texto vem do
 * email ORIGINAL (`raw`), tirado pela positiva; sem o email guardado = sem
 * texto (nunca junta). Nas da API/Windsor, o texto já é só a crítica. PURA.
 */
export function dedupFactsOfRow(
  r: Pick<ReviewRowLite, "id" | "reviewerName" | "rating" | "reviewText" | "reviewDate" | "sourceEmailDate" | "createdAt" | "projectId" | "googleReviewKey" | "sourceEmailId">,
  parse: Parse,
  raw?: RawEmail | null,
): ReviewDedupFacts {
  const isEmail = !!r.sourceEmailId && !r.googleReviewKey;
  const { name, rating } = isEmail ? emailNameAndRating(r, parse, raw) : { name: r.reviewerName ?? "", rating: Number(r.rating) || 0 };
  return {
    id: Number(r.id),
    parkKey: r.projectId != null ? `p${r.projectId}` : null,
    rating,
    textKey: isEmail ? (raw?.body ? reviewTextKeyFromEmail(raw.body, name) : "") : reviewTextKeyFromApi(r.reviewText),
    name: reviewerNameKey(name),
    atMs: reviewDateMs(r.reviewDate, r.sourceEmailDate, r.createdAt),
    apiKey: !!r.googleReviewKey,
  };
}

/** O leitor dos emails da Google (com o assunto). */
export async function emailParser(): Promise<Parse> {
  const { parseGoogleReviewNotification } = await import("./emailParse");
  return (body: string, subject: string) => parseGoogleReviewNotification(body, subject);
}

const rowsOf = (res: any): any[] => (Array.isArray(res?.[0]) ? res[0] : Array.isArray(res) ? res : []);

/**
 * Os emails originais (corpo + remetente) pelo Message-ID: inbound_emails e,
 * se lá não estiver, mail_messages. Em lotes, sem JOIN entre colações.
 * `exec` = a BD ou uma transação.
 */
export async function loadRawEmails(exec: { execute: (q: any) => Promise<any> }, messageIds: readonly (string | null | undefined)[]): Promise<Map<string, RawEmail>> {
  const out = new Map<string, RawEmail>();
  const ids = [...new Set(messageIds.filter(Boolean).map(String))];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const list = sql.join(chunk.map((m) => sql`${m}`), sql`, `);
    for (const g of rowsOf(await exec.execute(sql`SELECT messageId, fromEmail, bodyText FROM inbound_emails WHERE messageId IN (${list})`))) {
      out.set(String(g.messageId), { body: g.bodyText ?? null, fromEmail: g.fromEmail ?? null });
    }
    const missing = chunk.filter((m) => !out.get(m)?.fromEmail || !out.get(m)?.body);
    if (!missing.length) continue;
    const list2 = sql.join(missing.map((m) => sql`${m}`), sql`, `);
    for (const g of rowsOf(await exec.execute(sql`SELECT rfcMessageId, fromEmail, bodyText FROM mail_messages WHERE rfcMessageId IN (${list2}) AND direction = 'in'`))) {
      const k = String(g.rfcMessageId);
      const prev = out.get(k);
      out.set(k, { body: prev?.body || g.bodyText || null, fromEmail: prev?.fromEmail || g.fromEmail || null });
    }
  }
  return out;
}

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
      WHERE (rating = ${n.rating} OR rating = 0) AND notAReview = 0 AND duplicateOf IS NULL
        ${projectId != null ? sql`AND (projectId = ${projectId} OR projectId IS NULL)` : sql``}
        AND COALESCE(reviewDate, sourceEmailDate, createdAt) BETWEEN DATE_SUB(${at}, INTERVAL ${REVIEW_DEDUP_WINDOW_HOURS} HOUR) AND DATE_ADD(${at}, INTERVAL ${REVIEW_DEDUP_WINDOW_HOURS} HOUR)
      ORDER BY id DESC LIMIT 200`);
    const rows = rowsOf(res);
    const parse = await emailParser();
    const raw = await loadRawEmails(db, rows.map((r) => r.sourceEmailId));
    const existing = rows.map((r) => dedupFactsOfRow(r, parse, r.sourceEmailId ? raw.get(String(r.sourceEmailId)) : null));
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
/** As mais recentes primeiro; uma limpeza lê no máximo estas. */
const SCAN_MAX = 20_000;

type LoadedRow = ReviewRowLite & { aiResponse: string | null; raw: RawEmail | null };

async function loadRows(kind: ReviewCleanupKind): Promise<LoadedRow[]> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const where = kind === "not_review" ? sql`sourceEmailId IS NOT NULL` : sql`rating >= 0`;
  const rows = rowsOf(await db.execute(sql`SELECT id, reviewerName, rating, reviewText, reviewDate, sourceEmailDate, createdAt, projectId, googleReviewKey,
      sourceEmailId, complaintId, googleReply, respondedAt, status, notAReview, duplicateOf, reviewMarkUndoneAt, aiResponse
    FROM google_reviews WHERE ${where} AND ${projectScope(googleReviews.projectId)} ORDER BY id DESC LIMIT ${SCAN_MAX}`));
  const raw = await loadRawEmails(db, rows.filter((r) => r.sourceEmailId && !r.googleReviewKey).map((r) => r.sourceEmailId));
  return rows.map((r) => ({ ...r, raw: r.sourceEmailId ? raw.get(String(r.sourceEmailId)) ?? null : null }));
}

function itemOf(r: LoadedRow, extra: Partial<ReviewCleanupItem> = {}): ReviewCleanupItem {
  const text = String(r.reviewText ?? "").replace(/\s+/g, " ").trim();
  return {
    id: Number(r.id),
    reviewerName: String(r.reviewerName ?? ""),
    rating: Number(r.rating) || 0,
    date: (r.reviewDate ?? r.sourceEmailDate ?? r.createdAt ?? null) as string | null,
    snippet: text.slice(0, 160),
    projectId: r.projectId != null ? Number(r.projectId) : null,
    fromEmail: r.raw?.fromEmail ?? null,
    duplicateOf: r.duplicateOf != null ? Number(r.duplicateOf) : null,
    hasDraft: !!String(r.aiResponse ?? "").trim(),
    ...extra,
  };
}

const isOn = (v: unknown) => v === true || Number(v) === 1;

async function notReviewPlan(rows: LoadedRow[]) {
  const parse = await emailParser();
  const mark: LoadedRow[] = [];
  const keep: Array<{ row: LoadedRow; why: string }> = [];
  for (const r of rows) {
    // Estrelas relidas do email (o leitor antigo perdia as do outro formato).
    const { rating } = emailNameAndRating(r, parse, r.raw);
    const d = notAReviewDecision({
      id: Number(r.id), fromEmail: r.raw?.fromEmail ?? null, rating, sourceEmailId: r.sourceEmailId,
      complaintId: r.complaintId, googleReviewKey: r.googleReviewKey, googleReply: r.googleReply, respondedAt: r.respondedAt,
      status: String(r.status), notAReview: isOn(r.notAReview), duplicateOf: r.duplicateOf, markUndone: !!r.reviewMarkUndoneAt,
    });
    if (!d) continue;
    if (d.action === "mark") mark.push(r);
    else keep.push({ row: r, why: d.why });
  }
  return { mark, keep };
}

async function duplicatePlan(rows: LoadedRow[]) {
  const parse = await emailParser();
  const facts: DedupCleanupRow[] = rows.map((r) => ({
    ...dedupFactsOfRow(r, parse, r.raw),
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
  const marked = rows.filter((r) => (kind === "not_review" ? isOn(r.notAReview) : r.duplicateOf != null)).slice(0, LIST_MAX).map((r) => itemOf(r));
  if (kind === "not_review") {
    const p = await notReviewPlan(rows);
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

const affected = (res: any) => Number(res?.[0]?.affectedRows ?? res?.affectedRows ?? 0);

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
    const p = await notReviewPlan(rows);
    for (const r of p.mark) {
      if (!wanted.has(Number(r.id))) continue;
      // Atómico: a cópia do rascunho é feita no MESMO UPDATE, antes de o limpar
      // (no MySQL as atribuições correm da esquerda para a direita).
      const res = await db.execute(sql`UPDATE google_reviews SET
          reviewMarkBackup = JSON_OBJECT('aiResponse', aiResponse, 'aiResponseApproved', aiResponseApproved, 'status', status, 'aiDraftAttemptedAt', aiDraftAttemptedAt),
          notAReview = 1, reviewMarkedAt = ${nowStr()}, reviewMarkedById = ${userId},
          aiResponse = NULL, aiResponseApproved = 0,
          aiDraftAttemptedAt = COALESCE(aiDraftAttemptedAt, ${nowStr()}),
          status = IF(status = 'ai_responded', 'pending_response', status)
        WHERE id = ${Number(r.id)} AND notAReview = 0 AND duplicateOf IS NULL AND ${projectScope(googleReviews.projectId)}`);
      if (affected(res) > 0) marked++;
    }
  } else {
    const p = await duplicatePlan(rows);
    for (const m of p.mark) {
      if (!wanted.has(m.id)) continue;
      const res = await db.update(googleReviews).set({ duplicateOf: m.duplicateOf, reviewMarkedAt: nowStr(), reviewMarkedById: userId })
        .where(and(eq(googleReviews.id, m.id), eq(googleReviews.notAReview, 0), isNull(googleReviews.duplicateOf), projectScope(googleReviews.projectId)));
      if (affected(res) > 0) marked++;
    }
  }
  return { marked, skipped: Math.max(0, wanted.size - marked) };
}

/** O que se guardou ao marcar "não é crítica" (JSON_OBJECT do UPDATE). PURA. */
export function parseMarkBackup(raw: unknown): { aiResponse: string | null; aiResponseApproved: number; status: string | null; aiDraftAttemptedAt: string | null; hasAttempted: boolean } {
  let o: any = {};
  try { o = typeof raw === "string" ? JSON.parse(raw) : raw && typeof raw === "object" ? raw : {}; } catch { o = {}; }
  return {
    aiResponse: typeof o.aiResponse === "string" && o.aiResponse.trim() ? o.aiResponse : null,
    aiResponseApproved: Number(o.aiResponseApproved) === 1 ? 1 : 0,
    status: typeof o.status === "string" ? o.status : null,
    aiDraftAttemptedAt: typeof o.aiDraftAttemptedAt === "string" && o.aiDraftAttemptedAt ? o.aiDraftAttemptedAt : null,
    hasAttempted: Object.prototype.hasOwnProperty.call(o, "aiDraftAttemptedAt"),
  };
}

/**
 * Desfaz a marca (`ids`; vazio = todas as deste tipo, no âmbito de quem
 * pede). Repõe o rascunho guardado, a aprovação e a "tentativa de rascunho"
 * (se fomos nós a pô-la), se entretanto ninguém escreveu outro; a limpeza não
 * volta a propor estas críticas. Devolve os ids desfeitos (para o registo).
 */
export async function undoReviewCleanup(kind: ReviewCleanupKind, ids: readonly number[]): Promise<{ undone: number; ids: number[] }> {
  const db = await getDb();
  if (!db) throw new Error("Base de dados indisponível");
  const markedCond = kind === "not_review" ? eq(googleReviews.notAReview, 1) : isNotNull(googleReviews.duplicateOf);
  const list = await db.select({
    id: googleReviews.id, aiResponse: googleReviews.aiResponse, status: googleReviews.status, backup: googleReviews.reviewMarkBackup,
  }).from(googleReviews).where(and(markedCond, projectScope(googleReviews.projectId),
    ...(ids.length ? [sql`${googleReviews.id} IN (${sql.join(ids.map((i) => sql`${Number(i)}`), sql`, `)})`] : []))).limit(5000);
  const done: number[] = [];
  for (const r of list) {
    if (kind === "duplicate") {
      const res = await db.update(googleReviews).set({ duplicateOf: null, reviewMarkUndoneAt: nowStr() })
        .where(and(eq(googleReviews.id, r.id), isNotNull(googleReviews.duplicateOf)));
      if (affected(res) > 0) done.push(r.id);
      continue;
    }
    const b = parseMarkBackup(r.backup);
    const restoreDraft = !String(r.aiResponse ?? "").trim() && !!b.aiResponse;
    const res = await db.update(googleReviews).set({
      notAReview: 0,
      reviewMarkUndoneAt: nowStr(),
      reviewMarkBackup: null,
      ...(restoreDraft ? { aiResponse: b.aiResponse!, aiResponseApproved: b.aiResponseApproved } : {}),
      ...(restoreDraft && b.status === "ai_responded" && r.status === "pending_response" ? { status: "ai_responded" as const } : {}),
      // A "tentativa de rascunho" que a marca pôs volta a NULL (a de antes fica).
      ...(b.hasAttempted && !b.aiDraftAttemptedAt ? { aiDraftAttemptedAt: null } : {}),
    }).where(and(eq(googleReviews.id, r.id), eq(googleReviews.notAReview, 1),
      // Atómico: só se ninguém mexeu na marca entre a leitura e agora.
      r.backup == null ? isNull(googleReviews.reviewMarkBackup) : eq(googleReviews.reviewMarkBackup, String(r.backup))));
    if (affected(res) > 0) done.push(r.id);
  }
  return { undone: done.length, ids: done };
}
