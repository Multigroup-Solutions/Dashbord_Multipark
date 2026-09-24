/**
 * Rascunho de resposta a uma crítica — usado pelos 4 sítios que antes tinham
 * cada um o seu prompt (criar crítica, gerar resposta, email recebido,
 * importação do Gmail). Só o primeiro nome do cliente e o texto sem dados
 * pessoais vão para o fornecedor; a resposta pública nunca leva marcadores.
 */
import { firstName, redactPii } from "./pii";
import { reviewReplyInput, reviewReplySystem, reviewVariant } from "./prompts/reviewReply";
import { runAi } from "./run";

export interface ReviewForReply {
  rating?: number | null;
  reviewerName?: string | null;
  reviewText?: string | null;
}

export async function draftReviewReply(
  review: ReviewForReply,
  ctx: {
    userId?: number | null;
    reviewId?: number | null;
    timeoutMs?: number;
    /** Funcionalidade para interruptor/registo (omissão: review_reply; o rascunho automático usa review_auto_draft). */
    feature?: "review_reply" | "review_auto_draft";
    /** Linhas de contexto interno (sentimento, reclamação/reserva ligada) — sem dados pessoais. */
    context?: string[];
  } = {},
): Promise<string> {
  const variant = reviewVariant(review.rating);
  const red = redactPii(String(review.reviewText ?? "").slice(0, 2000));
  const r = await runAi({
    feature: ctx.feature ?? "review_reply",
    system: reviewReplySystem(variant),
    input: reviewReplyInput({ rating: review.rating, firstName: firstName(review.reviewerName), text: red.text, context: ctx.context?.map((l) => redactPii(l).text) }),
    maxTokens: 600,
    timeoutMs: ctx.timeoutMs ?? 20_000,
    userId: ctx.userId ?? null,
    entity: "google_review",
    entityId: ctx.reviewId ?? null,
  });
  return red.strip(r.output).replace(/^["“]|["”]$/g, "").trim().slice(0, 4000);
}
