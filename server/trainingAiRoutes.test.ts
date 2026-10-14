/**
 * Formação com IA (14 out 2026) — as rotas: quem pode o quê e o que chega
 * ao servidor (o tema do quiz, quem joga). Os serviços estão simulados.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./cityAccess", async (original) => ({ ...(await original<object>()), loadCityAccess: async () => ({ all: false, cityIds: [10], cityNames: ["Porto"], projectIds: [10], missingCostCenter: false }) }));
const f = vi.hoisted(() => ({ startQuiz: vi.fn(), faqRun: vi.fn(), find: vi.fn(), catalog: vi.fn(), review: vi.fn() }));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserPermissionOverrides: async () => ({}),
  getEmployeeByUserId: async () => ({ employee: { id: 7, projectId: 10, fullName: "Colaborador teste" } }),
  resolveProjectIds: async () => [10],
  logActivity: vi.fn(),
}));
vi.mock("./trainingAttempts", () => ({ startQuizAttempt: f.startQuiz, quizAttemptReview: f.review }));
vi.mock("./trainingFaqAuto", () => ({ runKbFaqGeneration: f.faqRun, lastFaqRun: async () => null }));
vi.mock("./trainingCatalog", () => ({ findTraining: f.find, loadCatalog: f.catalog }));

import { appRouter } from "./routers";

const caller = (role = "extra") => appRouter.createCaller({ user: { id: 123, role }, req: { headers: {} }, res: {} } as any);

beforeEach(() => {
  vi.clearAllMocks();
  f.startQuiz.mockResolvedValue({ sessionId: 1, questions: [], source: "ai" });
  f.faqRun.mockResolvedValue({ ok: true, created: [], docs: [], errors: [], skipped: null });
  f.find.mockResolvedValue({ q: "x", mode: "text", results: [], kb: [] });
  f.catalog.mockResolvedValue([]);
  f.review.mockResolvedValue({ review: [] });
});

describe("rotas da formação com IA", () => {
  it("quiz: o tema e quem joga vão para o servidor; a tentativa é sempre da própria ficha", async () => {
    await caller().training.startQuiz({ area: "dashboard", subarea: "  Financeiro ", topic: "  " });
    expect(f.startQuiz).toHaveBeenCalledWith(7, expect.objectContaining({
      area: "dashboard", subarea: "Financeiro", topic: null, categoryId: null, userId: 123,
      viewer: expect.objectContaining({ role: "extra" }),
    }));
  });

  it("quiz: área desconhecida é recusada", async () => {
    await expect(caller().training.startQuiz({ area: "xpto" as any })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.startQuiz).not.toHaveBeenCalled();
  });

  it("rever uma tentativa: só a da própria ficha", async () => {
    await caller().training.quizAttemptReview({ sessionId: 5 });
    expect(f.review).toHaveBeenCalledWith(7, 5);
  });

  it("«Gerar agora» das FAQs: só quem gere a formação; corre como manual", async () => {
    await expect(caller("extra").training.generateFaqsNow()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("supervisor").training.generateFaqsNow()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.faqRun).not.toHaveBeenCalled();
    await caller("admin").training.generateFaqsNow();
    expect(f.faqRun).toHaveBeenCalledWith(expect.objectContaining({ trigger: "manual", userId: 123 }));
  });

  it("arrumar por área e ver as perguntas da IA: só quem gere", async () => {
    await expect(caller("extra").training.setAreas({ items: [{ itemType: "manual", id: 1, area: "dashboard", subarea: null }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("team_leader").training.aiQuizQuestions()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("extra").training.faqAutoStatus()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("procurar e catálogo: qualquer pessoa da formação; quem procura leva a sua visibilidade", async () => {
    await caller().training.findTraining({ q: "fechar a caixa" });
    expect(f.find).toHaveBeenCalledWith(expect.objectContaining({ q: "fechar a caixa", userId: 123, viewer: expect.objectContaining({ role: "extra" }) }));
    await caller().training.catalog();
    expect(f.catalog).toHaveBeenCalledOnce();
    await expect(caller().training.findTraining({ q: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
