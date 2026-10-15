/**
 * Plano MPV F7 (§6.2): ler UMA crítica na fonte antes de publicar a resposta
 * sozinha (e na verificação diária depois de publicar). Publicar substitui a
 * resposta que lá estiver, por isso nunca se publica sem esta leitura.
 *
 *  - Google ligada diretamente (OAuth): v4 `reviews.get` do nome do recurso;
 *  - senão, Windsor: leitura das avaliações desse perfil num intervalo curto
 *    (± 1 dia da data da crítica), filtrada pelo id da crítica.
 *
 * Só leitura. Os dois transportes são injetáveis (os testes nunca chamam a
 * Google nem a Windsor de verdade).
 */
import type { SourceRead } from '../../../shared/reviewAutoPublish';
import { reviewPattern, safeError, type GoogleReview } from './domain';

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export interface SourceReadDeps {
  /** A Google está ligada diretamente? */
  oauthConnected(): Promise<boolean>;
  windsorConfigured(): boolean;
  /** v4 reviews.get. */
  googleGet(reviewName: string): Promise<GoogleReview>;
  /** Avaliações do perfil `locations/N` entre as duas datas (AAAA-MM-DD), na forma da API da Google. */
  windsorList(location: string, dateFrom: string, dateTo: string): Promise<GoogleReview[]>;
}

/** Avaliação da API → o que a verificação precisa (null se não tiver estrelas válidas). PURA. */
export function sourceReadOf(r: GoogleReview | null | undefined): SourceRead {
  if (!r) return { ok: false, reason: 'a crítica já não aparece na fonte' };
  const rating = STARS[String(r.starRating ?? '')];
  if (!rating) return { ok: false, reason: 'a fonte não deu as estrelas' };
  return { ok: true, rating, text: r.comment ?? null, hasReply: !!String(r.reviewReply?.comment ?? '').trim() };
}

/** ± 1 dia (UTC) à volta da data da crítica. PURA. */
export function windsorWindowAround(reviewDate: string | null | undefined, nowMs: number): { dateFrom: string; dateTo: string } {
  const raw = String(reviewDate ?? '').trim();
  const t = raw ? Date.parse(`${raw.includes('T') ? raw : raw.replace(' ', 'T')}${/(Z|[+-]\d\d:?\d\d)$/.test(raw) ? '' : 'Z'}`) : NaN;
  const at = Number.isFinite(t) ? t : nowMs;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { dateFrom: day(at - 86_400_000), dateTo: day(Math.min(nowMs, at + 86_400_000)) };
}

export const realSourceReadDeps: SourceReadDeps = {
  oauthConnected: async () => (await import('./windsor')).oauthConnected(),
  windsorConfigured: () => !!process.env.WINDSOR_API_KEY?.trim(),
  googleGet: async (name) => {
    const [{ BusinessClient }, { accessToken }] = await Promise.all([import('./client'), import('./oauth')]);
    return new BusinessClient(await accessToken(), { timeoutMs: 10_000 }).review(name);
  },
  windsorList: async (location, dateFrom, dateTo) => {
    const w = await import('./windsor');
    const rows = await w.windsorGet({ fields: w.REVIEW_FIELDS, dateFrom, dateTo, accounts: [location], timeoutMs: 20_000 });
    return w.groupWindsorReviews(rows).get(location) ?? [];
  },
};

/**
 * Lê a crítica na fonte. Nunca lança: qualquer falha → `{ ok:false }` (e
 * quem chama NÃO publica).
 */
export async function readReviewAtSource(
  review: { googleReviewName: string | null | undefined; reviewDate?: string | null },
  deps: SourceReadDeps = realSourceReadDeps,
  nowMs: number = Date.now(),
): Promise<SourceRead> {
  const name = String(review.googleReviewName ?? '');
  if (!reviewPattern.test(name)) return { ok: false, reason: 'sem ligação ao Google' };
  try {
    if (await deps.oauthConnected()) return sourceReadOf(await deps.googleGet(name));
    if (!deps.windsorConfigured()) return { ok: false, reason: 'nem a Google nem a Windsor estão ligadas' };
    const parts = name.split('/');
    const location = `${parts[2]}/${parts[3]}`;
    const reviewId = parts[5];
    const win = windsorWindowAround(review.reviewDate, nowMs);
    const list = await deps.windsorList(location, win.dateFrom, win.dateTo);
    return sourceReadOf(list.find((r) => r.reviewId === reviewId) ?? null);
  } catch (error) {
    return { ok: false, reason: safeError(error).slice(0, 200) };
  }
}
