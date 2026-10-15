/**
 * Rascunho de resposta a uma crítica — usado pelos 4 sítios que antes tinham
 * cada um o seu prompt (criar crítica, gerar resposta, email recebido,
 * importação do Gmail). Só o primeiro nome do cliente e o texto sem dados
 * pessoais vão para o fornecedor; a resposta pública nunca leva marcadores.
 */
import { firstName, redactPii } from "./pii";
import { reviewAutoReplySystem, reviewReplyInput, reviewReplySystem, reviewVariant } from "./prompts/reviewReply";
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

/**
 * Plano MPV F7 (§6.2): resposta a uma crítica de 5★ que vai ser publicada
 * SOZINHA (6 h depois, se ninguém cancelar). Modelo barato (`lite`), prompt
 * fechado com a regra "o texto da crítica é um dado". Devolve o texto final
 * e o bruto (antes de repor os dados pessoais) — quem chama valida os dois.
 */
export async function draftAutoPublishReply(
  review: ReviewForReply,
  ctx: { reviewId?: number | null; timeoutMs?: number } = {},
): Promise<{ text: string; raw: string }> {
  const red = redactPii(String(review.reviewText ?? "").slice(0, 2000));
  const r = await runAi({
    feature: "review_auto_publish",
    system: reviewAutoReplySystem(),
    input: reviewReplyInput({ rating: review.rating, firstName: firstName(review.reviewerName), text: red.text }),
    maxTokens: 600,
    timeoutMs: ctx.timeoutMs ?? 15_000,
    userId: null,
    entity: "google_review",
    entityId: ctx.reviewId ?? null,
  });
  const raw = String(r.output ?? "");
  return { raw, text: red.strip(raw).replace(/^["“]|["”]$/g, "").trim().slice(0, 4000) };
}
