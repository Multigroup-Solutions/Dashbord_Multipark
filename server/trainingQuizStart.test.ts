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
  /** Respostas por ordem para um select de uma tabela (simula outra instância a gravar entre dois selects). */
  queue: new Map<any, any[][]>(),
  execRows: [] as any[],
  nextId: 77,
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
  select: () => ({ from: (t: any) => chain(h.queue.get(t)?.length ? h.queue.get(t)!.shift()! : h.tables.get(t) ?? []) }),
  insert: (t: any) => ({ values: (v: any) => { h.inserts.push({ table: t, values: v }); return Promise.resolve([{ insertId: h.nextId }]); } }),
  update: (t: any) => ({ set: (v: any) => ({ where: () => { h.updates.push({ table: t, values: v }); const p: any = Promise.resolve([{ affectedRows: 1 }]); return p; } }) }),
  execute: async () => [h.execRows],
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
  saveLiveQuizQuestions: (...a: any[]) => h.live.save(...a),
}));

import { copyAiQuestionToBank, quizAttemptReview, recentAiQuizQuestions, startQuizAttempt, submitAttempt } from "./trainingAttempts";

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
  h.queue = new Map(); h.execRows = []; h.nextId = 77;
  h.inserts = []; h.updates = [];
  for (const f of Object.values(h.live)) f.mockReset();
  h.saveQuizAttempt.mockReset().mockResolvedValue({ id: 55 });
  h.recordProgress.mockReset().mockResolvedValue(undefined);
  h.live.save.mockResolvedValue({ questionIds: AI_QS.map((_, i) => 500 + i) });
});

describe("começar um quiz", () => {
  it("com a IA: perguntas novas, gravadas no servidor — o browser não recebe a resposta certa", async () => {
    h.live.available.mockResolvedValue(true);
    h.live.generate.mockImplementation(async () => {
      // quando a IA é chamada, a tentativa já está reservada
      expect(h.inserts.filter((x) => x.table === trainingAttemptSessions)).toHaveLength(1);
      return { result: { topicLabel: "Dashboard · Financeiro", questions: AI_QS }, reason: null };
    });
    const r = await startQuizAttempt(7, { area: "dashboard", subarea: "Financeiro", viewer, userId: 3 });
    expect(r.source).toBe("ai");
    expect(r.sessionId).toBe(77);
    expect(r.topic).toBe("Dashboard · Financeiro");
    expect(r.questions.map((q) => q.id)).toEqual(AI_QS.map((_, i) => 500 + i));
    const json = JSON.stringify(r);
    expect(json).not.toContain("correctOption");
    expect(json).not.toContain("Porque o manual diz.");
    expect(h.live.generate).toHaveBeenCalledWith(expect.objectContaining({ topic: expect.objectContaining({ area: "dashboard", subarea: "Financeiro" }), viewer, employeeId: 7, n: 10 }));
    expect(h.live.save).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 77, employeeId: 7, result: expect.objectContaining({ questions: AI_QS }) }));
    // a tentativa foi reservada ANTES da IA (conta logo no limite do dia), sem perguntas ainda
    const res = h.inserts.filter((x) => x.table === trainingAttemptSessions);
    expect(res).toHaveLength(1);
    expect(res[0].values).toMatchObject({ employeeId: 7, kind: "quiz", source: "ai", questionIds: "[]" });
  });

  it("a IA falha → perguntas fixas, com o aviso do porquê", async () => {
    h.live.available.mockResolvedValue(true);
    h.live.generate.mockRejectedValue(new Error("timeout"));
    const r = await startQuizAttempt(7, { topic: "fechar a caixa", viewer, userId: 3 });
    expect(r.source).toBe("bank");
    expect(r.notice).toMatch(/lista fixa/);
    expect(r.questions).toHaveLength(10);
    expect(JSON.stringify(r)).not.toContain("correctOption");
    // a MESMA tentativa reservada passa a levar as fixas (não se cria outra)
    expect(h.inserts.filter((x) => x.table === trainingAttemptSessions)).toHaveLength(1);
    const upd = h.updates.find((x) => x.table === trainingAttemptSessions && x.values.source === "bank")!;
    expect(JSON.parse(upd.values.questionIds)).toEqual(r.questions.map((q) => q.id));
    expect(r.sessionId).toBe(77);
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
    // a reserva fica anulada (não conta no limite do dia; nada se apaga)
    expect(h.updates.find((x) => x.table === trainingAttemptSessions)?.values).toMatchObject({ source: "void" });
  });

  it("vários «Jogar» ao mesmo tempo: só as primeiras do dia valem — a reserva a mais é anulada e não chama a IA", async () => {
    const now = new Date("2026-10-14T10:00:00Z");
    const today = (id: number) => ({ id, startedAt: "2026-10-14 09:00:00" });
    h.live.available.mockResolvedValue(true);
    h.nextId = 80;
    // 1.º select (antes de reservar): 4 do dia → pode. 2.º (depois de reservar): outra instância reservou a 79 entretanto.
    h.queue.set(trainingAttemptSessions, [[1, 2, 3, 4].map(today), [1, 2, 3, 4, 79, 80].map(today)]);
    await expect(startQuizAttempt(7, { viewer, userId: 3 }, now)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(h.live.generate).not.toHaveBeenCalled();
    expect(h.updates.find((x) => x.table === trainingAttemptSessions)?.values).toMatchObject({ source: "void" });
  });

  it("a reserva que ganhou a corrida segue para a IA", async () => {
    const now = new Date("2026-10-14T10:00:00Z");
    const today = (id: number) => ({ id, startedAt: "2026-10-14 09:00:00" });
    h.live.available.mockResolvedValue(true);
    h.live.generate.mockResolvedValue({ result: { topicLabel: "Tudo", questions: AI_QS }, reason: null });
    h.nextId = 79;
    h.queue.set(trainingAttemptSessions, [[1, 2, 3, 4].map(today), [1, 2, 3, 4, 79, 80].map(today)]);
    const r = await startQuizAttempt(7, { viewer, userId: 3 }, now);
    expect(r.source).toBe("ai");
    expect(r.sessionId).toBe(79);
  });

  it("o limite de jogos por dia é verificado ANTES de chamar a IA", async () => {
    const now = new Date("2026-10-14T10:00:00Z");
    h.tables.set(trainingAttemptSessions, Array.from({ length: 5 }, () => ({ startedAt: "2026-10-14 08:00:00" })));
    h.live.available.mockResolvedValue(true);
    await expect(startQuizAttempt(7, { viewer, userId: 3 }, now)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(h.live.generate).not.toHaveBeenCalled();
  });

  it("IA desligada: como antes — sem perguntas fixas o erro é esse (antes do limite), e uma só gravação com as perguntas", async () => {
    const now = new Date("2026-10-14T10:00:00Z");
    h.live.available.mockResolvedValue(false);
    h.tables.set(quizQuestions, []);
    h.tables.set(trainingAttemptSessions, Array.from({ length: 5 }, () => ({ startedAt: "2026-10-14 08:00:00" })));
    await expect(startQuizAttempt(7, { viewer, userId: 3 }, now)).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Ainda não há perguntas publicadas." });
    h.tables.set(quizQuestions, BANK);
    h.tables.set(trainingAttemptSessions, []);
    const r = await startQuizAttempt(7, { categoryId: null, viewer, userId: 3 }, now);
    const ins = h.inserts.filter((x) => x.table === trainingAttemptSessions);
    expect(ins).toHaveLength(1);
    expect(JSON.parse(ins[0].values.questionIds)).toEqual(r.questions.map((q) => q.id));
    expect(h.updates).toEqual([]);
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

  it("perguntas de OUTRA tentativa não contam (ids que não foram servidos nesta)", async () => {
    h.tables.set(trainingAttemptSessions, [session]);
    await expect(submitAttempt(7, 31, [{ questionId: 900, answer: "B" }, { questionId: 500, answer: "B" }, { questionId: 501, answer: "B" }])).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.saveQuizAttempt).not.toHaveBeenCalled();
  });

  it("reserva ainda sem perguntas (a IA está a preparar) → não se corrige nada", async () => {
    h.tables.set(trainingAttemptSessions, [{ ...session, questionIds: "[]" }]);
    await expect(submitAttempt(7, 31, [])).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("a ser preparada") });
    expect(h.saveQuizAttempt).not.toHaveBeenCalled();
  });

  it("reserva anulada → não encontrada (nem corrigir nem rever)", async () => {
    h.tables.set(trainingAttemptSessions, [{ ...session, source: "void", submittedAt: "2026-10-14 10:00:00" }]);
    await expect(submitAttempt(7, 31, [])).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(quizAttemptReview(7, 31)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rever: só depois de submetida e corrigida (antes, a resposta certa não sai)", async () => {
    h.tables.set(trainingAttemptSessions, [session]);
    h.tables.set(trainingQuizAiQuestions, rows);
    await expect(quizAttemptReview(7, 31)).rejects.toMatchObject({ code: "NOT_FOUND" });
    h.tables.set(trainingAttemptSessions, [{ ...session, submittedAt: "2026-10-14 10:05:00", resultId: 55, answersJson: JSON.stringify([{ questionId: 500, answer: "B" }]) }]);
    const r = await quizAttemptReview(7, 31);
    expect(r.review.map((x) => x.correctOption)).toEqual(["B", "B", "C"]);
    expect(r.review[0]).toMatchObject({ yourAnswer: "B", correct: true });
    await expect(quizAttemptReview(8, 31)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("perguntas da IA para quem gere — documentos restritos", () => {
  const viewerTl = { role: "team_leader", allCities: false, cityNames: ["Lisboa"] };
  const base = { sessionId: 31, question: "Q?", optionA: "a", optionB: "b", optionC: "c", optionD: "d", correctOption: "A", explanation: null, difficulty: "medium",
    sourceTitle: "Doc", sourceManualId: null, createdAt: "2026-10-14 10:00:00", topic: "Tudo", answersJson: null, employeeId: 7 };

  it("esconde as de documentos que quem vê não pode ver; marca as restritas que pode", async () => {
    h.tables.set(trainingQuizAiQuestions, [
      { ...base, id: 1, sourceKbDocId: null, restricted: 0 },          // manual / público
      { ...base, id: 2, sourceKbDocId: 10, restricted: 0 },            // documento público
      { ...base, id: 3, sourceKbDocId: 11, restricted: 1 },            // restrito que o TL vê
      { ...base, id: 4, sourceKbDocId: 12, restricted: 1 },            // restrito só para admin
      { ...base, id: 5, sourceKbDocId: null, restricted: 1 },          // sem fonte, jogo com material restrito
    ]);
    h.execRows = [
      { id: 10, visibilityRoles: null, visibilityCities: "[]", canSee: 1 },
      { id: 11, visibilityRoles: '["team_leader"]', visibilityCities: null, canSee: 1 },
      { id: 12, visibilityRoles: '["admin"]', visibilityCities: null, canSee: 0 },
    ];
    const list = await recentAiQuizQuestions(viewerTl);
    expect(list.map((q) => [q.id, q.restricted])).toEqual([[1, false], [2, false], [3, true]]);
    expect(JSON.stringify(list)).not.toContain("answersJson");
  });

  it("«Guardar nas fixas» de uma restrita: pede confirmação; sem poder ver o documento, nem com confirmação", async () => {
    h.tables.set(trainingQuizAiQuestions, [{ ...base, id: 3, sourceKbDocId: 11, restricted: 1 }]);
    h.tables.set(quizQuestions, []);
    h.execRows = [{ id: 11, visibilityRoles: '["team_leader"]', visibilityCities: null, canSee: 1 }];
    // a ficha de quem jogou está no âmbito
    const { employees } = await import("../drizzle/schema");
    h.tables.set(employees, [{ id: 7 }]);
    await expect(copyAiQuestionToBank(3, 1, viewerTl)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(h.inserts.filter((x) => x.table === quizQuestions)).toEqual([]);
    const ok = await copyAiQuestionToBank(3, 1, viewerTl, { confirmRestricted: true });
    expect(ok.restricted).toBe(true);
    expect(h.inserts.find((x) => x.table === quizQuestions)?.values).toMatchObject({ published: 0, sourceKbDocId: 11 });

    h.inserts = [];
    h.execRows = [{ id: 11, visibilityRoles: '["admin"]', visibilityCities: null, canSee: 0 }];
    await expect(copyAiQuestionToBank(3, 1, viewerTl, { confirmRestricted: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.inserts).toEqual([]);
  });

  it("«Guardar nas fixas» de uma pública: direto, como rascunho; repetida → aviso", async () => {
    const { employees } = await import("../drizzle/schema");
    h.tables.set(employees, [{ id: 7 }]);
    h.tables.set(trainingQuizAiQuestions, [{ ...base, id: 2, sourceKbDocId: 10, restricted: 0 }]);
    h.execRows = [{ id: 10, visibilityRoles: null, visibilityCities: null, canSee: 1 }];
    h.tables.set(quizQuestions, []);
    const r = await copyAiQuestionToBank(2, 1, viewerTl);
    expect(r.restricted).toBe(false);
    h.tables.set(quizQuestions, [{ id: 99 }]);
    await expect(copyAiQuestionToBank(2, 1, viewerTl)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
