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
  /** 44c: título do perfil Google de onde veio (para achar a marca quando não há parque). */
  locationTitle?: string | null;
  reviewText?: string | null;
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
  /** "city" | "brand" | "park"… (44c: as marcas dão o grupo das críticas sem parque). */
  level?: string | null;
}

export const NO_PARK_KEY = "none";
export const NO_PARK_LABEL = "Sem parque";
/**
 * 44c (Jorge, 7 out 2026: "não pode haver Sem parque — o que é de marca é para
 * a marca, o que não é de marca é para o lixo"). O lixo não se apaga: fica num
 * grupo à parte, fechado, e não conta nas "por responder".
 */
export const TRASH_KEY = "trash";
export const TRASH_LABEL = "Lixo (sem parque nem marca)";

const fold = (x: string | null | undefined) => String(x ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Nomes das marcas (projetos de nível "brand"), sem repetir (a mesma marca em várias cidades). PURA. */
export function brandNames(projects: readonly ProjectLike[]): string[] {
  const seen = new Map<string, string>();
  for (const p of projects) if (p.level === "brand" && fold(p.name) && !seen.has(fold(p.name))) seen.set(fold(p.name), p.name);
  return [...seen.values()];
}

/** Marca de uma crítica sem parque: no título do perfil Google e, se não, no texto. null = sem marca. PURA. */
export function reviewBrandName(r: Pick<ReviewLike, "locationTitle" | "reviewText">, brands: readonly string[]): string | null {
  for (const source of [r.locationTitle, r.reviewText]) {
    const hay = ` ${fold(source)} `;
    if (hay.trim() === "") continue;
    const hit = brands.find((b) => fold(b) && hay.includes(` ${fold(b)} `));
    if (hit) return hit;
  }
  return null;
}

/** A crítica tem parque (projeto conhecido) ou, sem ele, marca? Senão vai para o lixo. PURA. */
export function isTrashReview(r: ReviewLike, projects: readonly ProjectLike[]): boolean {
  if (r.projectId != null && projects.some((p) => p.id === r.projectId)) return false;
  return reviewBrandName(r, brandNames(projects)) == null;
}

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
  /** 44c: grupo do lixo (sem parque nem marca). */
  trash?: boolean;
}

/**
 * Agrupa por parque (projeto da crítica). 44c: sem parque → a marca (achada no
 * perfil Google ou no texto); sem marca → o lixo. Ordem: mais pendentes
 * primeiro, depois por nome; o lixo fica sempre no fim.
 */
export function groupReviewsByPark<T extends ReviewLike>(reviews: T[], projects: ProjectLike[]): ParkGroup<T>[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const brands = brandNames(projects);
  const groups = new Map<string, ParkGroup<T>>();
  for (const r of reviews) {
    const project = r.projectId != null ? byId.get(r.projectId) : undefined;
    const brand = project ? null : reviewBrandName(r, brands);
    const key = project ? String(project.id) : brand ? `brand:${fold(brand)}` : TRASH_KEY;
    let g = groups.get(key);
    if (!g) {
      const name = project ? project.name : brand ? `${brand} (marca)` : TRASH_LABEL;
      g = { key, name, reviews: [], total: 0, pending: 0, responded: 0, complaints: 0, avg: null, ...(key === TRASH_KEY ? { trash: true } : {}) };
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
    const na = a.key === TRASH_KEY ? 1 : 0;
    const nb = b.key === TRASH_KEY ? 1 : 0;
    if (na !== nb) return na - nb;
    if (a.pending !== b.pending) return b.pending - a.pending;
    return a.name.localeCompare(b.name);
  });
}
