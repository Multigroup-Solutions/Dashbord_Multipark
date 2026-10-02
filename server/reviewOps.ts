/**
 * Críticas Google — operações com efeito (P3 lote 16d).
 *
 * - Converter em reclamação numa só transação (crítica bloqueada): duplo
 *   clique, o botão e a importação ao mesmo tempo nunca abrem duas
 *   reclamações para a mesma crítica.
 * - Parque das críticas que chegam por EMAIL: o "sobre Y" do email é o título
 *   do perfil Google → o parque escolhido para esse perfil em Integrações.
 *   Só com correspondência exata; sem ela a crítica fica "Sem parque".
 */
import { eq, sql } from "drizzle-orm";
import { complaints, googleReviews } from "../drizzle/schema";
import { getDb } from "./db";
import { REVIEW_COMPLAINT_SLA_HOURS, reviewComplaintPriority } from "../shared/reviewRules";
import { findParkProjectId, normalizeParkName } from "../shared/projectTree";

const sqlNow = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

export async function convertReviewToComplaint(
  reviewId: number,
  actor: { id: number; name?: string | null },
  opts: { defaultProjectId?: number | null; via?: "manual" | "import" } = {},
): Promise<{ complaintId: number; alreadyConverted: boolean } | null> {
  const db = await getDb();
  if (!db) throw new Error("DB indisponível");
  const out = await db.transaction(async (tx) => {
    const [review] = await tx.select().from(googleReviews).where(eq(googleReviews.id, reviewId)).limit(1).for("update");
    if (!review) return null;
    if (review.complaintId) {
      // Estado desalinhado (ex.: alguém mexeu antes desta regra): repõe "Reclamação".
      if (review.status !== "converted_complaint") await tx.update(googleReviews).set({ status: "converted_complaint" }).where(eq(googleReviews.id, reviewId));
      return { complaintId: review.complaintId, alreadyConverted: true, review };
    }
    const stars = review.rating >= 1 ? `${review.rating}★` : "sem estrelas";
    const [res] = (await tx.insert(complaints).values({
      title: `Crítica Google ${stars} — ${review.reviewerName}`.slice(0, 255),
      description: review.reviewText || "Avaliação sem texto.",
      complaintType: "other",
      complaintStatus: "new",
      complaintPriority: reviewComplaintPriority(review.rating),
      clientName: review.reviewerName,
      clientEmail: review.reviewerEmail ?? null,
      vehiclePlate: review.vehiclePlate ?? null,
      projectId: review.projectId ?? opts.defaultProjectId ?? null,
      slaDeadline: sqlNow(Date.now() + REVIEW_COMPLAINT_SLA_HOURS * 3_600_000),
      createdById: actor.id,
    } as any)) as any;
    const complaintId = Number(res.insertId);
    await tx.update(googleReviews).set({ status: "converted_complaint", complaintId }).where(eq(googleReviews.id, reviewId));
    return { complaintId, alreadyConverted: false, review };
  });
  if (!out) return null;
  if (!out.alreadyConverted) {
    const { addComplaintMessage } = await import("./db");
    const r = out.review;
    await addComplaintMessage({
      complaintId: out.complaintId,
      message: `⭐ ${opts.via === "import" ? "Aberta ao importar a" : "Convertida da"} crítica Google #${r.id} (${r.rating >= 1 ? `${r.rating}★` : "sem estrelas"}) por ${actor.name ?? "—"}.${r.aiResponse ? `\n\nResposta preparada na crítica:\n${r.aiResponse}` : ""}`,
      isInternal: 1,
      authorId: actor.id,
      authorName: actor.name ?? null,
    }).catch((err: unknown) => console.warn("[reviews] nota da conversão:", String((err as any)?.message ?? err)));
    try {
      const { autoLinkComplaintBooking } = await import("./complaintDossier");
      await autoLinkComplaintBooking(out.complaintId);
    } catch { /* best-effort: a ligação faz-se à mão na reclamação */ }
  }
  return { complaintId: out.complaintId, alreadyConverted: out.alreadyConverted };
}

/** Título do perfil → parque. PURA: só correspondência exata (normalizada) e sem ambiguidade. */
export function projectForLocationTitle(parkName: string | null | undefined, locations: Array<{ title: string | null; projectId: number | null }>): number | null {
  const want = normalizeParkName(parkName);
  if (!want) return null;
  const ids = new Set(locations.filter((l) => l.projectId != null && normalizeParkName(l.title) === want).map((l) => Number(l.projectId)));
  return ids.size === 1 ? [...ids][0] : null;
}

/** Parque da crítica que veio por email. null = sem correspondência segura. Nunca lança. */
export async function projectIdForReviewPark(parkName: string | null | undefined): Promise<number | null> {
  if (!normalizeParkName(parkName)) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const res = (await db.execute(sql`SELECT title, projectId FROM google_business_locations WHERE projectId IS NOT NULL`)) as any;
    const byTitle = projectForLocationTitle(parkName, (res?.[0] ?? []) as any[]);
    if (byTitle != null) return byTitle;
    // Sem perfil com esse título: o nome do parque + cidade (o mesmo matcher das reservas).
    const { getProjects } = await import("./db");
    const { PARK_CONFIGS } = await import("./multipark");
    return findParkProjectId({ parkName }, (await getProjects()) as any, PARK_CONFIGS) ?? null;
  } catch (err) {
    console.warn("[reviews] parque da crítica por email:", String((err as any)?.message ?? err));
    return null;
  }
}
