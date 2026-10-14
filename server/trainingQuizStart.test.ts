/**
 * Quiz feito pela IA (14 out 2026) — início e correção da tentativa:
 *  - com a IA: perguntas novas, gravadas no servidor; o browser não recebe a
 *    resposta certa;
 *  - IA a falhar / sem trechos / desligada → perguntas fixas (reserva), com aviso;
 *  - o limite diário vem antes de chamar a IA;
 *  - a correção é no servidor e usa as perguntas DESTA tentativa; as
 *    respostas ficam guardadas para rever.
 * BD simulada (drizzle de faz-de-conta, por tabela).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { quizQuestions, trainingAttemptSessions, trainingQuizAiQuestions } from "../drizzle/schema";

const h = vi.hoisted(() => ({
  tables: new Map<any, any[]>(),
  inserts: [] as Array<{ table: any; values: any }>,
  updates: [] as Array<{ table: any; values: any }>,
  live: { available: vi.fn(), generate: vi.fn(), save: vi.fn() },
  saveQuizAttempt: vi.fn(),
  recordProgress: vi.fn(),
}));

function chain(rows: any[]): any {
  const p: any = Promise.resolve(rows);
  for (const k of ["where", "limit", "orderBy", "innerJoin", "leftJoin", "groupBy"]) p[k] = () => chain(rows);
  return p;
}
const fakeDb = {
  select: () => ({ from: (t: any) => chain(h.tables.get(t) ?? []) }),
  insert: (t: any) => ({ values: (v: any) => { h.inserts.push({ table: t, values: v }); return Promise.resolve([{ insertId: 77 }]); } }),
  update: (t: any) => ({ set: (v: any) => ({ where: () => { h.updates.push({ table: t, values: v }); return Promise.resolve([{ affectedRows: 1 }]); } }) }),
};

vi.mock("./db", async (orig) => ({
  ...(await orig<object>()),
  getDb: async () => fakeDb,
  saveQuizAttempt: (...a: any[]) => h.saveQuizAttempt(...a),
  logActivity: async () => undefined,
}));
vi.mock("./trainingPaths", () => ({ recordProgress: (...a: any[]) => h.recordProgress(...a) }));
vi.mock("./trainingQuizAi", () => ({
  liveQuizAvailable: (...a: any[]) => h.live.available(...a),
  generateLiveQuiz: (...a: any[]) => h.live.generate(...a),
  saveLiveQuizSession: (...a: any[]) => h.live.save(...a),
}));

import { startQuizAttempt, submitAttempt } from "./trainingAttempts";

const viewer = { role: "extra", allCities: false, cityNames: ["Lisboa"] };
const BANK = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1, question: `Fixa ${i + 1}?`, optionA: "a", optionB: "b", optionC: "c", optionD: "d", correctOption: "A", explanation: "x", difficulty: "easy", points: 10, published: 1, categoryId: null, archivedAt: null,
}));
const AI_QS = Array.from({ length: 10 }, (_, i) => ({
  question: `Nova ${i + 1}?`, optionA: "Certa", optionB: "Errada 1", optionC: "Errada 2", optionD: "Errada 3", correctOption: "A" as const,
  explanation: "Porque o manual diz.", difficulty: "medium" as const, sourceTag: "S1", sourceKbDocId: 4, sourceManualId: null, sourceTitle: "Manual",
}));

beforeEach(() => {
  h.tables = new Map([[quizQuestions, BANK], [trainingAttemptSessions, []]]);
  h.inserts = []; h.updates = [];
  for (const f of Object.values(h.live)) f.mockReset();
  h.saveQuizAttempt.mockReset().mockResolvedValue({ id: 55 });
  h.recordProgress.mockReset().mockResolvedValue(undefined);
  h.live.save.mockResolvedValue({ sessionId: 31, questionIds: AI_QS.map((_, i) => 500 + i) });
});

describe("começar um quiz", () => {
  it("com a IA: perguntas novas, gravadas no servidor — o browser não recebe a resposta certa", async () => {
    h.live.available.mockResolvedValue(true);
    h.live.generate.mockResolvedValue({ result: { topicLabel: "Dashboard · Financeiro", questions: AI_QS }, reason: null });
    const r = await startQuizAttempt(7, { area: "dashboard", subarea: "Financeiro", viewer, userId: 3 });
    expect(r.source).toBe("ai");
    expect(r.sessionId).toBe(31);
    expect(r.topic).toBe("Dashboard · Financeiro");
    expect(r.questions.map((q) => q.id)).toEqual(AI_QS.map((_, i) => 500 + i));
    const json = JSON.stringify(r);
    expect(json).not.toContain("correctOption");
    expect(json).not.toContain("Porque o manual diz.");
    expect(h.live.generate).toHaveBeenCalledWith(expect.objectContaining({ topic: expect.objectContaining({ area: "dashboard", subarea: "Financeiro" }), viewer, employeeId: 7, n: 10 }));
    expect(h.live.save).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 7, result: expect.objectContaining({ questions: AI_QS }) }));
    // a lista fixa não foi usada
    expect(h.inserts.filter((x) => x.table === trainingAttemptSessions)).toEqual([]);
  });

  it("a IA falha → perguntas fixas, com o aviso do porquê", async () => {
    h.live.available.mockResolvedValue(true);
    h.live.generate.mockRejectedValue(new Error("timeout"));
    const r = await startQuizAttempt(7, { topic: "fechar a caixa", viewer, userId: 3 });
    expect(r.source).toBe("bank");
    expect(r.notice).toMatch(/lista fixa/);
    expect(r.questions).toHaveLength(10);
    expect(JSON.stringify(r)).not.toContain("correctOption");
    const ins = h.inserts.find((x) => x.table === trainingAttemptSessions)!;
    expect(ins.values).toMatchObject({ employeeId: 7, kind: "quiz", source: "bank" });
  });

  it("sem conteúdo para o tema → perguntas fixas e o motivo", async () => {
    h.live.available.mockResolvedValue(true);
    h.live.generate.mockResolvedValue({ result: null, reason: "Não encontrei conteúdo sobre «x» na base de conhecimento." });
    const r = await startQuizAttempt(7, { topic: "x", viewer, userId: 3 });
    expect(r.source).toBe("bank");
    expect(r.notice).toContain("Não encontrei conteúdo");
  });

  it("IA desligada → perguntas fixas, sem aviso (é o normal)", async () => {
    h.live.available.mockResolvedValue(false);
    const r = await startQuizAttempt(7, { viewer, userId: 3 });
    expect(r.source).toBe("bank");
    expect(r.notice).toBeNull();
    expect(h.live.generate).not.toHaveBeenCalled();
  });

  it("IA a falhar e sem perguntas fixas → erro que explica as duas coisas", async () => {
    h.tables.set(quizQuestions, []);
    h.live.available.mockResolvedValue(true);
    h.live.generate.mockResolvedValue({ result: null, reason: "A IA não fez perguntas suficientes desta vez." });
    await expect(startQuizAttempt(7, { viewer, userId: 3 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("perguntas fixas") });
  });

  it("o limite de jogos por dia é verificado ANTES de chamar a IA", async () => {
    const now = new Date("2026-10-14T10:00:00Z");
    h.tables.set(trainingAttemptSessions, Array.from({ length: 5 }, () => ({ startedAt: "2026-10-14 08:00:00" })));
    h.live.available.mockResolvedValue(true);
    await expect(startQuizAttempt(7, { viewer, userId: 3 }, now)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(h.live.generate).not.toHaveBeenCalled();
  });

  it("a forma antiga (só a categoria) continua a funcionar", async () => {
    h.live.available.mockResolvedValue(true);
    const r = await startQuizAttempt(7, 3);
    expect(r.source).toBe("bank");
    expect(h.live.available).not.toHaveBeenCalled();
  });
});

describe("corrigir um quiz feito pela IA (no servidor)", () => {
  const session = {
    id: 31, employeeId: 7, kind: "quiz", examId: null, categoryId: null, questionIds: JSON.stringify([500, 501, 502]),
    startedAt: "2026-10-14 09:59:00", deadlineAt: null, submittedAt: null, resultId: null, score: null, passed: null, source: "ai", topic: "Tudo", answersJson: null,
  };
  const rows = [500, 501, 502].map((id, i) => ({ id, sessionId: 31, question: `Q${i}?`, optionA: "a", optionB: "b", optionC: "c", optionD: "d", correctOption: i === 2 ? "C" : "B", explanation: "e", points: 10, sourceTitle: "Manual" }));

  it("usa as perguntas desta tentativa, corrige e guarda as respostas", async () => {
    h.tables.set(trainingAttemptSessions, [session]);
    h.tables.set(trainingQuizAiQuestions, rows);
    // a lista fixa tem ids iguais com outras respostas certas — não pode ser usada
    h.tables.set(quizQuestions, [500, 501, 502].map((id) => ({ ...BANK[0], id, correctOption: "D" })));
    const answers = [{ questionId: 500, answer: "B" as const }, { questionId: 501, answer: "A" as const }, { questionId: 502, answer: "C" as const }];
    const r = await submitAttempt(7, 31, answers, new Date("2026-10-14T10:05:00Z"));
    expect(r).toMatchObject({ kind: "quiz", correct: 2, total: 3, score: 20, percentage: 67 });
    expect(r.review.map((x) => x.correctOption)).toEqual(["B", "B", "C"]);
    expect(h.saveQuizAttempt).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 7, totalQuestions: 3, correctAnswers: 2, score: 20 }));
    const saved = h.updates.find((u) => u.table === trainingAttemptSessions && u.values.answersJson);
    expect(JSON.parse(saved!.values.answersJson)).toEqual(answers);
    // 67% < 70%: não conta para o percurso
    expect(h.recordProgress).not.toHaveBeenCalled();
  });

  it("tentativa de outra pessoa → não encontrada", async () => {
    h.tables.set(trainingAttemptSessions, [session]);
    await expect(submitAttempt(8, 31, [{ questionId: 500, answer: "B" }])).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
