import { createHash } from 'node:crypto';

export const accountPattern = /^accounts\/\d+$/;
export const locationPattern = /^locations\/\d+$/;
export const reviewPattern = /^accounts\/\d+\/locations\/\d+\/reviews\/[A-Za-z0-9_-]+$/;
const ratings: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export interface GoogleReview {
  reviewId: string;
  reviewer?: { displayName?: string; isAnonymous?: boolean };
  starRating: string;
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: { comment?: string; updateTime?: string };
}

export function normalizeReview(locationName: string, review: GoogleReview) {
  if (!locationPattern.test(locationName) || !/^[A-Za-z0-9_-]{1,255}$/.test(review.reviewId)) throw new Error('Identificador Google inválido.');
  const rating = ratings[review.starRating];
  const created = Date.parse(review.createTime), updated = Date.parse(review.updateTime);
  if (!rating || !Number.isFinite(created) || !Number.isFinite(updated)) throw new Error('Avaliação Google sem classificação ou datas válidas.');
  return {
    key: createHash('sha256').update(`${locationName}/${review.reviewId}`).digest('hex'),
    reviewerName: (review.reviewer?.displayName || 'Utilizador Google').slice(0, 200),
    rating, reviewText: review.comment || null,
    reviewDate: new Date(created).toISOString().slice(0, 19).replace('T', ' '),
    updated: new Date(updated).toISOString(),
    reply: review.reviewReply?.comment || null,
    replyAt: review.reviewReply?.updateTime && Number.isFinite(Date.parse(review.reviewReply.updateTime))
      ? new Date(review.reviewReply.updateTime).toISOString().slice(0, 19).replace('T', ' ') : null,
  };
}

export function safeError(error: unknown): string {
  // Tokens and query parameters must never reach status panels or logs.
  const message = error instanceof Error ? error.message : 'Falha na integração Google.';
  if (/Failed query:|ER_[A-Z_]+|sqlMessage|params:/i.test(message)) return 'Não foi possível guardar os dados. Tenta novamente.';
  return message.replace(/(?:ya29\.|1\/\/|GOCSPX-)[^\s"&]+/g, '[omitido]').slice(0, 500);
}

export function notificationLocation(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const type = d.notificationType || d.type;
  if (type !== 'NEW_REVIEW' && type !== 'UPDATED_REVIEW') return null;
  const review = d.reviewName || d.review_name;
  if (typeof review === 'string' && reviewPattern.test(review)) return review.split('/').slice(2, 4).join('/');
  const location = d.locationName || d.location_name;
  if (typeof location !== 'string') throw new Error('Notificação sem estabelecimento.');
  if (locationPattern.test(location)) return location;
  if (/^accounts\/\d+\/locations\/\d+$/.test(location)) return location.split('/').slice(2).join('/');
  throw new Error('Identificador de estabelecimento inválido.');
}
