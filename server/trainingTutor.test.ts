/**
 * Tutor da Formação: procura por palavras-chave, "pergunta ao formador" fora
 * do conteúdo, explicação pós-quiz com as respostas erradas, limite de
 * pedidos, histórico só do próprio e interruptor desligado. runAi simulado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  runAi: vi.fn(),
  store: {
    loadModule: vi.fn(),
    manualsForQuestions: vi.fn(),
    trainerUserId: vi.fn(),
    userName: vi.fn(),
    activityDays: vi.fn(),
    quizSession: vi.fn(),
    quizQuestionsByIds: vi.fn(),
    recentHistory: vi.fn(),
    saveTurn: vi.fn(),
    purgeOldHistory: vi.fn(),
    clearHistory: vi.fn(),
    recordQuestion: vi.fn(),
    questionStats: vi.fn(),
    moduleTitles: vi.fn(),
  },
}));

vi.mock("./_core/ai/run", () => ({ runAi: h.runAi }));
vi.mock("./trainingTutorStore", () => h.store);
vi.mock("./db", async (orig) => ({
  ...(await orig<object>()),
  getDb: async () => null,
  getUserPermissionOverrides: async () => ({}),
  getEmployeeByUserId: async () => ({ employee: { id: 7, projectId: 10, fullName: "Ana Costa" } }),
}));
vi.mock("./cityAccess", async (orig) => ({ ...(await orig<object>()), loadCityAccess: async () => ({ all: true, cityIds: [10], projectIds: [10], missingCostCenter: false }) }));

import { resetRateLimitMemoryForTests } from "./_core/ai/rateLimit";
import { AiBudgetExceededError } from "./_core/ai/errors";
import { explainQuiz, tutorAsk } from "./trainingTutor";
import { trainingTutorRouter } from "./trainingTutorRouter";
import {
  bestQuote, buildGreeting, chunkManual, chunkManuals, computeStreak, limitWords, questionKey, retrieveChunks,
} from "./trainingTutorRules";

const MANUAL = {
  id: 11,
  title: "Manual do condutor",
  content: [
    "Bem-vindo à equipa de valet.",
    "",
    "## Entrega das chaves",
    "As chaves são entregues ao cliente só depois de confirmar a reserva no terminal. Nunca deixes as chaves no carro.",
    "",
    "## Receção do cliente",
    "Cumprimenta o cliente pelo nome e confirma a matrícula do carro.",
    "",
    "## Fardamento",
    "Usa sempre o colete refletor e o crachá visível durante o turno.",
  ].join("\n"),
};

const KEYS = ["GEMINI_API_KEY", "LLM_API_KEY", "AI_ENABLED", "AI_TRAINING_TUTOR", "AI_TRAINING_TUTOR_PER_MINUTE", "AI_TRAINING_TUTOR_PER_DAY"];
let saved: Record<string, string | undefined> = {};
const user = { id: 123, role: "extra", name: "Ana Costa" };
const ctx = { type: "manual" as const, id: 11 };
const aiText = (text: string) => ({ output: text, text, provider: "gemini", model: "m", tier: "lite", usage: {}, costEur: 0, latencyMs: 1, attempts: 1 });

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.GEMINI_API_KEY = "test-key";
  resetRateLimitMemoryForTests();
  h.runAi.mockReset();
  for (const f of Object.values(h.store)) f.mockReset();
  h.store.loadModule.mockResolvedValue({ title: MANUAL.title, manuals: [MANUAL], createdBy: 5, categoryId: null, found: true });
  h.store.trainerUserId.mockResolvedValue(5);
  h.store.userName.mockResolvedValue("Marta Silva");
  h.store.recentHistory.mockResolvedValue([]);
  h.store.saveTurn.mockResolvedValue(undefined);
  h.store.recordQuestion.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ─── Regras puras ───────────────────────────────────────────────────────────

describe("tutor: trechos e procura", () => {
  it("parte o manual pelos títulos", () => {
    const chunks = chunkManual(MANUAL);
    expect(chunks.map((c) => c.heading)).toEqual(["Manual do condutor", "Entrega das chaves", "Receção do cliente", "Fardamento"]);
    expect(chunkManual({ id: 1, title: "Link", content: "https://exemplo.pt/x" })).toEqual([]);
  });

  it("a procura escolhe o trecho certo", () => {
    const chunks = chunkManuals([MANUAL, { id: 12, title: "Manual do terminal", content: "## Caixa\nFecha a caixa no fim do turno e conta o dinheiro." }]);
    const hits = retrieveChunks("Quando posso entregar as chaves ao cliente?", chunks);
    expect(hits[0].heading).toBe("Entrega das chaves");
    expect(hits.map((x) => x.heading)).not.toContain("Fardamento");
    expect(retrieveChunks("Que colete tenho de usar?", chunks)[0].heading).toBe("Fardamento");
    expect(retrieveChunks("Como fecho a caixa?", chunks)[0].manualId).toBe(12);
  });

  it("sem termos em comum = fora do conteúdo", () => {
    expect(retrieveChunks("Qual é o horário do refeitório?", chunkManuals([MANUAL]))).toEqual([]);
  });

  it("citação literal, cortes e chaves", () => {
    const [, entrega] = chunkManual(MANUAL);
    const q = bestQuote(entrega, "entregar chaves cliente reserva");
    expect(MANUAL.content).toContain(q);
    expect(q).toMatch(/chaves/);
    expect(limitWords(Array(200).fill("palavra").join(" "), 120).split(/\s+/).length).toBeLessThanOrEqual(121);
    expect(questionKey("  Como  ENTREGO as chaves?! ")).toBe("como entrego as chaves");
  });

  it("sequência de dias e saudação com o progresso", () => {
    expect(computeStreak(["2026-09-24", "2026-09-23", "2026-09-22", "2026-09-20"], "2026-09-24")).toBe(3);
    expect(computeStreak(["2026-09-23", "2026-09-22"], "2026-09-24")).toBe(2);
    expect(computeStreak(["2026-09-20"], "2026-09-24")).toBe(0);
    const g = buildGreeting({ firstName: "Ana", modulesDone: 2, modulesTotal: 5, streak: 3, nextStep: { itemType: "video", itemId: 1, title: "Segurança" }, contextType: "manual", contextTitle: "Manual do condutor" });
    expect(g).toContain("Olá, Ana!");
    expect(g).toContain("2 de 5 módulos");
    expect(g).toContain("3 dias seguidos");
    expect(g).toContain("«Segurança»");
  });
});

// ─── Pergunta ───────────────────────────────────────────────────────────────

describe("tutor: perguntas", () => {
  it("usa só os trechos relevantes, runAi lite do tutor, e guarda o histórico", async () => {
    h.runAi.mockResolvedValueOnce(aiText("Só depois de confirmares a reserva no terminal. «Nunca deixes as chaves no carro.»"));
    const r = await tutorAsk(user, 7, ctx, "Quando posso entregar as chaves ao cliente?");
    expect(r.outOfContent).toBe(false);
    expect(r.fallback).toBeNull();
    expect(r.sources[0]).toMatchObject({ manualId: 11, heading: "Entrega das chaves" });
    const call = h.runAi.mock.calls[0][0];
    expect(call.feature).toBe("training_tutor");
    expect(call.tier).toBeUndefined(); // nível do catálogo (lite)
    expect(call.system).toContain("CONTEÚDO DO MÓDULO: Manual do condutor");
    expect(call.input).toContain("secção «Entrega das chaves»");
    expect(call.input).not.toContain("colete refletor");
    expect(call.input).toContain("no máximo 120 palavras");
    expect(h.store.saveTurn).toHaveBeenCalledWith(expect.objectContaining({ userId: 123, employeeId: 7, ctx }));
    expect(h.store.recordQuestion).toHaveBeenCalledOnce();
  });

  it("fora do conteúdo → pergunta ao formador (com o nome), sem chamar a IA", async () => {
    const r = await tutorAsk(user, 7, ctx, "Qual é o horário do refeitório?");
    expect(r.outOfContent).toBe(true);
    expect(r.answer).toContain("Pergunta ao formador");
    expect(r.answer).toContain("Marta");
    expect(h.runAi).not.toHaveBeenCalled();
    expect(h.store.recordQuestion).toHaveBeenCalledWith(ctx, expect.any(String), expect.any(String), true, undefined);
  });

  it("o modelo diz SEM_RESPOSTA → pergunta ao formador (nunca inventa)", async () => {
    h.runAi.mockResolvedValueOnce(aiText("SEM_RESPOSTA"));
    const r = await tutorAsk(user, 7, ctx, "Posso entregar as chaves a um familiar do cliente?");
    expect(r.outOfContent).toBe(true);
    expect(r.answer).toContain("Pergunta ao formador");
  });

  it("dados pessoais saem antes da IA e do histórico", async () => {
    h.runAi.mockResolvedValueOnce(aiText("Confirma a reserva no terminal."));
    await tutorAsk(user, 7, ctx, "O cliente joao@x.pt pediu as chaves, entrego?");
    expect(h.runAi.mock.calls[0][0].input).not.toContain("joao@x.pt");
    expect(h.store.saveTurn.mock.calls[0][0].question).toContain("[EMAIL_1]");
    expect(h.store.recordQuestion.mock.calls[0][2]).not.toContain("joao@x.pt");
  });

  it("\"explicar melhor\" pede a versão longa e não conta de novo nas perguntas frequentes", async () => {
    h.runAi.mockResolvedValueOnce(aiText("Explicação longa."));
    await tutorAsk(user, 7, ctx, "Quando posso entregar as chaves?", { detail: true });
    expect(h.runAi.mock.calls[0][0].input).toContain("Explica melhor");
    expect(h.store.recordQuestion).not.toHaveBeenCalled();
  });

  it("orçamento esgotado → mensagem simpática (sem erro)", async () => {
    h.runAi.mockRejectedValueOnce(new AiBudgetExceededError());
    const r = await tutorAsk(user, 7, ctx, "Quando posso entregar as chaves?");
    expect(r.fallback).toBe("budget");
    expect(r.answer).toContain("Marta");
  });

  it("limite de pedidos por pessoa", async () => {
    process.env.AI_TRAINING_TUTOR_PER_MINUTE = "2";
    h.runAi.mockResolvedValue(aiText("Confirma a reserva."));
    await tutorAsk(user, 7, ctx, "Quando posso entregar as chaves?");
    await tutorAsk(user, 7, ctx, "Quando posso entregar as chaves?");
    await expect(tutorAsk(user, 7, ctx, "Quando posso entregar as chaves?")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(h.runAi).toHaveBeenCalledTimes(2);
    // Outra pessoa não é afetada.
    await expect(tutorAsk({ ...user, id: 124 }, 8, ctx, "Quando posso entregar as chaves?")).resolves.toMatchObject({ outOfContent: false });
  });

  it("interruptor desligado → recurso simpático, sem IA e sem gastar o limite", async () => {
    process.env.AI_TRAINING_TUTOR = "off";
    const r = await tutorAsk(user, 7, ctx, "Quando posso entregar as chaves?");
    expect(r.fallback).toBe("disabled");
    expect(r.answer).toContain("desligado");
    expect(h.runAi).not.toHaveBeenCalled();
    expect(h.store.saveTurn).not.toHaveBeenCalled();
  });

  it("limita o tamanho da pergunta", async () => {
    await expect(tutorAsk(user, 7, ctx, "x".repeat(501))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(trainingTutorRouter.createCaller({ user, req: { headers: {} }, res: {} } as any).ask({ context: ctx, question: "x".repeat(501) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.runAi).not.toHaveBeenCalled();
  });
});

// ─── Depois do quiz ─────────────────────────────────────────────────────────

describe("tutor: explicação do quiz", () => {
  const q1 = { id: 1, question: "Quando se entregam as chaves ao cliente?", optionA: "Depois de confirmar a reserva no terminal", optionB: "Logo à chegada", optionC: "Nunca", optionD: "Ao fim do dia", correctOption: "A", explanation: null, categoryId: null, sourceManualId: 11 };
  const q2 = { id: 2, question: "O que usas no turno?", optionA: "Nada", optionB: "Colete refletor e crachá", optionC: "Chapéu", optionD: "Luvas", correctOption: "B", explanation: "Faz parte do fardamento.", categoryId: null, sourceManualId: 11 };

  beforeEach(() => {
    h.store.quizSession.mockResolvedValue({ id: 50, employeeId: 7, kind: "quiz", categoryId: null, questionIds: "[1,2]", submittedAt: "2026-09-24 10:00:00" });
    h.store.quizQuestionsByIds.mockResolvedValue([q1, q2]);
    h.store.manualsForQuestions.mockResolvedValue([MANUAL]);
  });

  it("usa as respostas erradas e cita o manual", async () => {
    h.runAi.mockResolvedValueOnce({ output: { items: [{ questionId: 1, explanation: "Primeiro confirmas a reserva no terminal." }], encouragement: "Estás quase!" } });
    const r = await explainQuiz(user, 7, 50, [{ questionId: 1, answer: "B" }, { questionId: 2, answer: "B" }]);
    expect(r).toMatchObject({ correct: 1, total: 2, fallback: null, encouragement: "Estás quase!" });
    expect(r.items).toHaveLength(1);
    const it0 = r.items[0];
    expect(it0).toMatchObject({ questionId: 1, yourAnswer: "B. Logo à chegada", correctAnswer: "A. Depois de confirmar a reserva no terminal", explanation: "Primeiro confirmas a reserva no terminal." });
    expect(it0.quote?.heading).toBe("Entrega das chaves");
    expect(MANUAL.content).toContain(it0.quote!.text);
    expect(it0.review).toContain("Entrega das chaves");
    const call = h.runAi.mock.calls[0][0];
    expect(call.feature).toBe("training_tutor");
    expect(call.input).toContain("questionId 1");
    expect(call.input).toContain("Respondeste: B. Logo à chegada");
    expect(call.input).toContain(it0.quote!.text);
    expect(call.input).not.toContain("questionId 2");
  });

  it("só a tentativa do próprio", async () => {
    await expect(explainQuiz(user, 99, 50, [])).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.runAi).not.toHaveBeenCalled();
  });

  it("interruptor desligado → explicação do formador + trecho, sem IA", async () => {
    process.env.AI_TRAINING_TUTOR = "off";
    const r = await explainQuiz(user, 7, 50, [{ questionId: 1, answer: "A" }, { questionId: 2, answer: "C" }]);
    expect(r.fallback).toBe("disabled");
    expect(r.items[0]).toMatchObject({ questionId: 2, explanation: "Faz parte do fardamento." });
    expect(r.items[0].quote?.heading).toBe("Fardamento");
    expect(h.runAi).not.toHaveBeenCalled();
  });
});

// ─── Acessos ────────────────────────────────────────────────────────────────

describe("tutor: acessos", () => {
  const caller = (role = "extra", id = 123) => trainingTutorRouter.createCaller({ user: { id, role, name: "X" }, req: { headers: {} }, res: {} } as any);

  it("o formando só lê o próprio histórico (ignora userId do cliente)", async () => {
    h.store.recentHistory.mockResolvedValue([]);
    await caller("extra", 123).history({ context: ctx, userId: 999 } as any);
    expect(h.store.recentHistory).toHaveBeenCalledTimes(1);
    expect(h.store.recentHistory.mock.calls[0][0]).toBe(123);
    await caller("extra", 123).clearHistory({ context: ctx, userId: 999 } as any);
    expect(h.store.clearHistory).toHaveBeenCalledWith(123, ctx);
  });

  it("vista dos formadores: só quem gere a Formação (agregados)", async () => {
    await expect(caller("extra").trainerQuestions()).rejects.toMatchObject({ code: "FORBIDDEN" });
    h.store.questionStats.mockResolvedValue({
      modules: [{ contextType: "manual", contextId: 11, asks: 5, unanswered: 2, distinctQuestions: 2, lastAskedAt: "2026-09-24 10:00:00" }],
      questions: [{ contextType: "manual", contextId: 11, sampleText: "como entrego as chaves", askCount: 4, outOfContentCount: 0, lastAskedAt: "2026-09-24 10:00:00" }],
    });
    h.store.moduleTitles.mockResolvedValue(new Map([["manual:11", "Manual do condutor"]]));
    const r = await caller("admin").trainerQuestions({ days: 30 });
    expect(r[0]).toMatchObject({ title: "Manual do condutor", asks: 5, unanswered: 2 });
    expect(r[0].questions[0]).not.toHaveProperty("userId");
  });
});

describe("migração 0138 (tutor)", () => {
  it("idempotente e registada no arranque", async () => {
    const { MIGRATION_0138_STATEMENTS, IDEMPOTENT_ERROR_CODES_0138 } = await import("./migrations/migration_0138");
    for (const st of MIGRATION_0138_STATEMENTS) expect(st).toMatch(/^CREATE TABLE IF NOT EXISTS `training_tutor_/);
    expect(MIGRATION_0138_STATEMENTS.join("\n")).not.toMatch(/UPDATE|DROP|DELETE/i);
    expect(IDEMPOTENT_ERROR_CODES_0138.has("ER_TABLE_EXISTS_ERROR")).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(new URL("./db.ts", import.meta.url), "utf8")).toContain("migration_0138");
  });
});
