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
import { REVIEW_AUTO_DRAFT_MAX_AGE_DAYS, reviewAutoDraftEligible } from "../shared/reviewRules";

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
  // Plano MPV F6b: marcada como não-crítica ou repetida → sem rascunho automático.
  if (Number(r.notAReview ?? 0) === 1 || r.duplicateOf != null) return { ok: false, error: "marked" };
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
 * Crítica que chegou pelo leitor de email (alias criticas): a mesma regra dos
 * 14 dias, com a data do EMAIL (`emailAt`; sem ela, agora). Uma crítica antiga
 * (email antigo relido numa nova sincronização) nunca tem rascunho
 * automático e fica marcada como já tentada — senão o cron, que olha para
 * `createdAt` (= hoje), apanhava-a depois. "Gerar" à mão continua a funcionar.
 */
export async function autoDraftEmailReview(
  reviewId: number,
  emailAt: string | null | undefined,
  opts: { nowMs?: number; timeoutMs?: number } = {},
): Promise<{ drafted: boolean; skipped?: string }> {
  const db = await getDb();
  if (!db) return { drafted: false, skipped: "db" };
  const nowMs = opts.nowMs ?? Date.now();
  const at = emailAt ?? new Date(nowMs).toISOString().slice(0, 19).replace("T", " ");
  if (!reviewAutoDraftEligible({ reviewDate: at }, nowMs)) {
    await db.update(googleReviews).set({ aiDraftAttemptedAt: nowStr() })
      .where(and(eq(googleReviews.id, reviewId), isNull(googleReviews.aiDraftAttemptedAt)));
    return { drafted: false, skipped: "old" };
  }
  const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
  if (!(await aiFeatureAvailableFresh("review_auto_draft"))) return { drafted: false, skipped: "disabled" };
  // Reserva atómica (o cron pode estar a correr ao mesmo tempo).
  const claim = await db.update(googleReviews).set({ aiDraftAttemptedAt: nowStr() })
    .where(and(eq(googleReviews.id, reviewId), isNull(googleReviews.aiDraftAttemptedAt)));
  if (!Number((claim as any)?.[0]?.affectedRows ?? 0)) return { drafted: false, skipped: "claimed" };
  const r = await autoDraftReview(reviewId, { timeoutMs: opts.timeoutMs ?? 15_000 });
  return r.ok ? { drafted: true } : { drafted: false, skipped: r.error };
}

/**
 * Críticas novas (escritas nos últimos 14 dias — data da PRÓPRIA crítica; sem
 * ela, a do email que a trouxe; só sem as duas a da entrada cá; MPV R1) sem resposta nem rascunho → rascunho, no máximo
 * `limit` por corrida e dentro do prazo. Chamado no fim do sync do Google
 * Business Profile (cron a cada 10 min) e do leitor de email. As críticas
 * ANTIGAS entradas numa 1.ª importação de um perfil já vêm marcadas
 * (`aiDraftAttemptedAt`, ver `importReview`) e nunca chegam aqui; as recentes
 * dessa importação ficam livres e têm rascunho como as outras. O botão
 * "Gerar/Regenerar" de cada crítica continua a funcionar para as antigas.
 */
export async function draftPendingReviewReplies(opts: { limit?: number; deadlineAt?: number; nowMs?: number } = {}): Promise<{ drafted: number; skipped?: string; errors: number }> {
  const out = { drafted: 0, errors: 0 } as { drafted: number; skipped?: string; errors: number };
  const { aiFeatureAvailableFresh } = await import("./_core/ai/status");
  if (!(await aiFeatureAvailableFresh("review_auto_draft"))) return { ...out, skipped: "disabled" };
  const db = await getDb();
  if (!db) return out;
  const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
  const deadlineAt = opts.deadlineAt ?? Date.now() + 30_000;
  const cutoff = sql`DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${REVIEW_AUTO_DRAFT_MAX_AGE_DAYS} DAY)`;
  const rows = await db.select({ id: googleReviews.id, reviewDate: googleReviews.reviewDate, sourceEmailDate: googleReviews.sourceEmailDate, createdAt: googleReviews.createdAt })
    .from(googleReviews).where(and(
      isNull(googleReviews.aiResponse),
      isNull(googleReviews.googleReply),
      isNull(googleReviews.aiDraftAttemptedAt),
      // Plano MPV F6b: as que não são críticas e as repetidas nunca têm rascunho automático.
      eq(googleReviews.notAReview, 0),
      isNull(googleReviews.duplicateOf),
      sql`${googleReviews.status} IN ('pending_response', 'converted_complaint')`,
      // = COALESCE(reviewDate, sourceEmailDate, createdAt) >= corte, sem a
      // função à volta das colunas (forma pronta para índices; hoje não há
      // índice nestas colunas e a tabela é pequena, por isso é uma leitura da
      // tabela inteira).
      sql`(${googleReviews.reviewDate} >= ${cutoff}
        OR (${googleReviews.reviewDate} IS NULL AND ${googleReviews.sourceEmailDate} >= ${cutoff})
        OR (${googleReviews.reviewDate} IS NULL AND ${googleReviews.sourceEmailDate} IS NULL AND ${googleReviews.createdAt} >= ${cutoff}))`,
    )).orderBy(sql`${googleReviews.id} DESC`).limit(limit);
  // Segunda verificação (a mesma regra, pura): nunca um rascunho automático
  // para uma crítica antiga, mesmo que o SQL mude.
  const ids = rows.filter((r) => reviewAutoDraftEligible(r, opts.nowMs ?? Date.now())).map((r) => r.id);
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
