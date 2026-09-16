import { describe, expect, it } from "vitest";
import { compareForReply, groupReviewsByPark, isReviewPending, NO_PARK_KEY, type ReviewLike } from "../shared/reviewParks";

const r = (p: Partial<ReviewLike> & { id: number }): ReviewLike => ({
  projectId: 1, rating: 5, status: "pending_response", respondedAt: null, reviewDate: "2026-09-01 10:00:00", ...p,
});
const projects = [{ id: 1, name: "Airpark Lisboa" }, { id: 2, name: "Airpark Porto" }, { id: 3, name: "Redpark Faro" }];

describe("críticas por parque", () => {
  it("pendente = não respondida e não fechada; rascunho da IA ainda é pendente", () => {
    expect(isReviewPending(r({ id: 1, status: "pending_response" }))).toBe(true);
    expect(isReviewPending(r({ id: 2, status: "ai_responded" }))).toBe(true);
    expect(isReviewPending(r({ id: 3, status: "manually_responded" }))).toBe(false);
    expect(isReviewPending(r({ id: 4, status: "pending_response", respondedAt: "2026-09-02 10:00:00" }))).toBe(false);
    expect(isReviewPending(r({ id: 5, status: "dismissed" }))).toBe(false);
    expect(isReviewPending(r({ id: 6, status: "converted_complaint" }))).toBe(false);
  });

  it("dentro do parque: por responder primeiro, depois as mais recentes", () => {
    const list = [
      r({ id: 1, status: "manually_responded", reviewDate: "2026-09-10 10:00:00" }),
      r({ id: 2, status: "pending_response", reviewDate: "2026-09-01 10:00:00" }),
      r({ id: 3, status: "pending_response", reviewDate: "2026-09-05 10:00:00" }),
    ].sort(compareForReply);
    expect(list.map((x) => x.id)).toEqual([3, 2, 1]);
  });

  it("agrupa por parque, calcula contagens e média só com estrelas", () => {
    const groups = groupReviewsByPark([
      r({ id: 1, projectId: 1, rating: 5, status: "manually_responded" }),
      r({ id: 2, projectId: 1, rating: 1, status: "converted_complaint" }),
      r({ id: 3, projectId: 1, rating: 0, status: "pending_response" }),
      r({ id: 4, projectId: 2, rating: 4 }),
      r({ id: 5, projectId: 2, rating: 4 }),
      r({ id: 6, projectId: null, rating: 3 }),
      r({ id: 7, projectId: 99, rating: 2 }), // projeto desconhecido → sem parque
    ], projects);
    expect(groups.map((g) => [g.key, g.name, g.total, g.pending, g.responded, g.complaints, g.avg])).toEqual([
      ["2", "Airpark Porto", 2, 2, 0, 0, 4],
      ["1", "Airpark Lisboa", 3, 1, 1, 1, 3],
      [NO_PARK_KEY, "Sem parque", 2, 2, 0, 0, 2.5],
    ]);
  });

  it("empate em pendentes desempata por nome; sem parque fica sempre no fim", () => {
    const groups = groupReviewsByPark([
      r({ id: 1, projectId: 3 }), r({ id: 2, projectId: 1 }), r({ id: 3, projectId: null }), r({ id: 4, projectId: null }),
    ], projects);
    expect(groups.map((g) => g.name)).toEqual(["Airpark Lisboa", "Redpark Faro", "Sem parque"]);
  });

  it("lista vazia dá zero grupos", () => {
    expect(groupReviewsByPark([], projects)).toEqual([]);
  });
});
