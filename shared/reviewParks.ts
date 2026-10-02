/**
 * Críticas por PARQUE — regra única partilhada pela página das críticas
 * (lista agrupada, separador de parques, quadro do dashboard).
 *
 * Pedido do Jorge (2026-09-16): "quero as críticas todas da empresa juntas,
 * e depois separadas por parque, para podermos responder como deve ser".
 * Dentro de cada parque as que faltam responder vêm primeiro.
 *
 * "Respondida" e "fechada" seguem exatamente a regra de getGoogleReviewStats
 * (server/db.ts): rascunho da IA NÃO conta como resposta.
 */

export interface ReviewLike {
  id: number;
  projectId: number | null;
  rating: number;
  status: string;
  respondedAt: string | null;
  /** Reclamação aberta a partir da crítica (fecha-a aqui, mesmo que o estado diga outra coisa). */
  complaintId?: number | null;
  reviewDate?: string | null;
  createdAt?: string | null;
}

export interface ProjectLike {
  id: number;
  name: string;
}

export const NO_PARK_KEY = "none";
export const NO_PARK_LABEL = "Sem parque";

export function isReviewAnswered(r: Pick<ReviewLike, "respondedAt" | "status">): boolean {
  return r.respondedAt != null || r.status === "manually_responded";
}

/** Convertida (com reclamação) também conta como fechada, seja qual for o estado. */
export function isReviewConverted(r: Pick<ReviewLike, "status" | "complaintId">): boolean {
  return r.status === "converted_complaint" || r.complaintId != null;
}

export function isReviewClosed(r: Pick<ReviewLike, "status" | "complaintId">): boolean {
  return r.status === "dismissed" || isReviewConverted(r);
}

export function isReviewPending(r: Pick<ReviewLike, "respondedAt" | "status" | "complaintId">): boolean {
  return !isReviewAnswered(r) && !isReviewClosed(r);
}

/** Por responder primeiro; depois as mais recentes. */
export function compareForReply(a: ReviewLike, b: ReviewLike): number {
  const pa = isReviewPending(a) ? 0 : 1;
  const pb = isReviewPending(b) ? 0 : 1;
  if (pa !== pb) return pa - pb;
  const da = a.reviewDate ?? a.createdAt ?? "";
  const db = b.reviewDate ?? b.createdAt ?? "";
  return db.localeCompare(da);
}

export interface ParkGroup<T extends ReviewLike> {
  /** id do projeto como string, ou NO_PARK_KEY. */
  key: string;
  name: string;
  reviews: T[];
  total: number;
  pending: number;
  responded: number;
  complaints: number;
  /** Média só sobre críticas com estrelas; null se não houver. */
  avg: number | null;
}

/**
 * Agrupa por parque (projeto da crítica). Ordem dos grupos: mais pendentes
 * primeiro, depois por nome; "Sem parque" fica sempre no fim.
 */
export function groupReviewsByPark<T extends ReviewLike>(reviews: T[], projects: ProjectLike[]): ParkGroup<T>[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const groups = new Map<string, ParkGroup<T>>();
  for (const r of reviews) {
    const project = r.projectId != null ? byId.get(r.projectId) : undefined;
    const key = project ? String(project.id) : NO_PARK_KEY;
    let g = groups.get(key);
    if (!g) {
      g = { key, name: project ? project.name : NO_PARK_LABEL, reviews: [], total: 0, pending: 0, responded: 0, complaints: 0, avg: null };
      groups.set(key, g);
    }
    g.reviews.push(r);
  }
  for (const g of groups.values()) {
    g.reviews.sort(compareForReply);
    g.total = g.reviews.length;
    g.pending = g.reviews.filter(isReviewPending).length;
    g.responded = g.reviews.filter(isReviewAnswered).length;
    g.complaints = g.reviews.filter(isReviewConverted).length;
    const rated = g.reviews.filter((r) => r.rating >= 1);
    g.avg = rated.length ? Math.round((rated.reduce((s, r) => s + r.rating, 0) / rated.length) * 10) / 10 : null;
  }
  return [...groups.values()].sort((a, b) => {
    const na = a.key === NO_PARK_KEY ? 1 : 0;
    const nb = b.key === NO_PARK_KEY ? 1 : 0;
    if (na !== nb) return na - nb;
    if (a.pending !== b.pending) return b.pending - a.pending;
    return a.name.localeCompare(b.name);
  });
}
