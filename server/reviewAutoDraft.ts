/**
 * Rascunho automático para cada crítica Google nova (IA `lite`), com o prompt
 * central `draftReviewReply` + sentimento + contexto da reclamação/reserva
 * ligada (só para o tom — nunca dados na resposta pública).
 *
 * O rascunho fica em `aiResponse` com `aiResponseApproved = 0`: publicar exige
 * uma pessoa ("Aprovar e publicar" na página das Críticas). 1 tentativa por
 * crítica (`aiDraftAttemptedAt`, reservada de forma atómica), lote pequeno por
 * corrida. Interruptor/orçamento → a reserva é libertada e nada falha.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { complaints, googleReviews } from "../drizzle/schema";
import { getDb } from "./db";
import { COMPLAINT_TYPE_LABEL_PT, reviewSentiment, type ComplaintType } from "../shared/commsAi";
import { isStopAiError } from "./complaintTriage";

const nowStr = () => new Date().toISOString().slice(0, 19).replace("T", " ");

const COMPLAINT_STATUS_PT: Record<string, string> = {
  new: "nova", analyzing: "em análise", waiting_client: "à espera do cliente", resolved: "resolvida", closed: "fechada", converted: "convertida",
};

/** Contexto interno da crítica (sem dados pessoais). */
async function reviewContext(db: any, r: any, sentiment: string): Promise<string[]> {
  const lines = [`Sentimento: ${sentiment}.`];
  if (r.complaintId) {
    const [c] = await db.select({ t: complaints.complaintType, s: complaints.complaintStatus, ref: complaints.reservationRef })
      .from(complaints).where(eq(complaints.id, r.complaintId)).limit(1);
    if (c) {
      lines.push(`Há uma reclamação interna sobre este caso (tipo: ${COMPLAINT_TYPE_LABEL_PT[c.t as ComplaintType] ?? "outro"}, estado: ${COMPLAINT_STATUS_PT[c.s] ?? c.s}); a equipa já está a tratar.`);
      if (c.ref) lines.push("A reserva do cliente está identificada.");
    }
  } else if (r.vehiclePlate) {
    try {
      const { deriveBookingForCase } = await import("./caseOps");
      const b = await deriveBookingForCase({ plate: r.vehiclePlate, atUtc: r.reviewDate ?? r.createdAt ?? null });
      if (b) lines.push("A reserva do cliente está identificada.");
    } catch { /* opcional */ }
  }
  return lines;
}

/** Rascunho de UMA crítica (já reservada). Devolve o código de erro, se houver. */
export async function autoDraftReview(reviewId: number, opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; error?: string }> {
  const db = await getDb();
  if (!db) return { ok: false, error: "db" };
  const [r] = await db.select().from(googleReviews).where(eq(googleReviews.id, reviewId)).limit(1);
  if (!r) return { ok: false, error: "not_found" };
  const sentiment = reviewSentiment(r.rating, r.reviewText);
  try {
    const { draftReviewReply } = await import("./_core/ai/reviewReply");
    const context = await reviewContext(db, r, sentiment);
    const text = await draftReviewReply(
      { rating: r.rating, reviewerName: r.reviewerName, reviewText: String(r.reviewText ?? "").slice(0, 2000) },
      { reviewId, feature: "review_auto_draft", context, timeoutMs: opts.timeoutMs ?? 15_000 },
    );
    // Só grava se ninguém escreveu/publicou entretanto.
    await db.update(googleReviews).set({
      aiResponse: text || null,
      aiResponseApproved: 0,
      aiSentiment: sentiment,
      ...(r.complaintId ? {} : { status: "ai_responded" as const }),
    }).where(and(eq(googleReviews.id, reviewId), isNull(googleReviews.aiResponse), isNull(googleReviews.googleReply)));
    return { ok: true };
  } catch (err) {
    const { aiErrorCode } = await import("./_core/ai/errors");
    await db.update(googleReviews).set({ aiSentiment: sentiment }).where(eq(googleReviews.id, reviewId));
    return { ok: false, error: aiErrorCode(err) + (isStopAiError(err) ? ":stop" : "") };
  }
}

/**
 * Críticas novas (últimos 14 dias) sem resposta nem rascunho → rascunho, no
 * máximo `limit` por corrida e dentro do prazo. Chamado no fim do sync do
 * Google Business Profile (cron a cada 10 min) e do leitor de email.
 */
export async function draftPendingReviewReplies(opts: { limit?: number; deadlineAt?: number } = {}): Promise<{ drafted: number; skipped?: string; errors: number }> {
  const out = { drafted: 0, errors: 0 } as { drafted: number; skipped?: string; errors: number };
  const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
  if (!(await aiFeatureAvailableFresh("review_auto_draft"))) return { ...out, skipped: "disabled" };
  const db = await getDb();
  if (!db) return out;
  const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
  const deadlineAt = opts.deadlineAt ?? Date.now() + 30_000;
  const ids = (await db.select({ id: googleReviews.id }).from(googleReviews).where(and(
    isNull(googleReviews.aiResponse),
    isNull(googleReviews.googleReply),
    isNull(googleReviews.aiDraftAttemptedAt),
    sql`${googleReviews.status} IN ('pending_response', 'converted_complaint')`,
    sql`${googleReviews.createdAt} >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 14 DAY)`,
  )).orderBy(sql`${googleReviews.id} DESC`).limit(limit)).map((r) => r.id);
  for (const id of ids) {
    if (Date.now() + 17_000 > deadlineAt) { out.skipped = "deadline"; break; }
    // Reserva atómica: duas corridas em paralelo nunca pagam a mesma crítica.
    const claim = await db.update(googleReviews).set({ aiDraftAttemptedAt: nowStr() })
      .where(and(eq(googleReviews.id, id), isNull(googleReviews.aiDraftAttemptedAt)));
    if (!Number((claim as any)?.[0]?.affectedRows ?? 0)) continue;
    const r = await autoDraftReview(id);
    if (r.ok) { out.drafted++; continue; }
    if (r.error?.endsWith(":stop")) {
      // Desligada / orçamento / sem fornecedor: liberta para a próxima vez.
      await db.update(googleReviews).set({ aiDraftAttemptedAt: null }).where(eq(googleReviews.id, id));
      out.skipped = r.error.replace(":stop", "");
      break;
    }
    out.errors++;
  }
  return out;
}
