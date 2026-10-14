/**
 * Quiz feito pela IA — a geração (14 out 2026):
 *  - só trechos que a pessoa pode ver (a recuperação recebe o `viewer`);
 *  - perguntas diferentes de tentativa para tentativa: a IA recebe as que a
 *    pessoa já teve e as repetidas caem na validação;
 *  - dados pessoais tapados antes da IA e tirados das perguntas;
 *  - IA a falhar ou com poucas perguntas boas → null (o jogo usa a lista fixa).
 * runAi, base de conhecimento e BD simulados.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { trainingCategories, trainingManuals, trainingQuizAiQuestions } from "../drizzle/schema";

const h = vi.hoisted(() => ({ runAi: vi.fn(), kb: vi.fn(), tables: new Map<any, any[]>(), exec: vi.fn() }));

function chain(rows: any[]): any {
  const p: any = Promise.resolve(rows);
  for (const k of ["where", "limit", "orderBy"]) p[k] = () => chain(rows);
  return p;
}
vi.mock("./_core/ai/run", () => ({ runAi: (...a: any[]) => h.runAi(...a) }));
vi.mock("./knowledge/retrieve", () => ({ retrieveKnowledge: (...a: any[]) => h.kb(...a) }));
// Só o getDb (BD de faz-de-conta por tabela).
vi.mock("./db", () => ({
  getDb: async () => ({ select: () => ({ from: (t: any) => chain(h.tables.get(t) ?? []) }), execute: async (...a: any[]) => [(await h.exec(...a)) ?? []] }),
}));

import { generateLiveQuiz, quizTopicLabel } from "./trainingQuizAi";

const viewer = { role: "extra", allCities: false, cityNames: ["Porto"] };
const seeded = (seed: number) => {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
};
const q = (question: string) => ({
  question, optionA: "No cofre", optionB: "No carro", optionC: "Com o cliente", optionD: "No balcão", correctOption: "A", explanation: "Diz o manual.", difficulty: "easy", source: "S1",
});
const TEN = ["Onde ficam as chaves?", "Quem abre o cofre?", "Quando se fecha a caixa?", "Qual a velocidade no parque?", "Onde se estaciona o shuttle?",
  "Quem confirma a entrega?", "Como se marca o ponto?", "O que fazer com um dano?", "Quando se liga ao cliente?", "Onde se regista a ocorrência?"];
const LONG = "Procedimento: as chaves ficam no cofre da receção e só o team leader de serviço abre o cofre. Liga para 912 345 678 se houver dúvidas. ".repeat(3);

beforeEach(() => {
  h.runAi.mockReset();
  h.exec.mockReset().mockResolvedValue([]);
  h.kb.mockReset().mockResolvedValue({ hits: [{ chunkId: 1, docId: 4, title: "Manual das chaves", section: "Cofre", text: LONG, href: null, source: "drive", score: 1 }], citations: [], mode: "fulltext" });
  h.tables = new Map<any, any[]>([
    [trainingManuals, [{ id: 9, title: "Fecho de caixa", content: `## Fecho\n${LONG}`, type: "manual", categoryId: null, area: null, subarea: null }]],
    [trainingCategories, []],
    [trainingQuizAiQuestions, []],
  ]);
});

describe("quiz da IA — gerar as perguntas de um jogo", () => {
  it("só com trechos que a pessoa pode ver; telefone tapado antes da IA; perguntas válidas com a fonte", async () => {
    h.runAi.mockResolvedValue({ output: { questions: TEN.map(q) } });
    const r = await generateLiveQuiz({ topic: { topic: "chaves do cofre" }, viewer, employeeId: 7, userId: 3, n: 10, rand: seeded(1) });
    expect(r.reason).toBeNull();
    expect(r.result!.questions).toHaveLength(10);
    expect(r.result!.topicLabel).toBe("chaves do cofre");
    expect(h.kb).toHaveBeenCalledWith(expect.objectContaining({ question: "chaves do cofre", viewer }));
    const call = h.runAi.mock.calls[0][0];
    expect(call.feature).toBe("quiz_live");
    expect(call.input).not.toContain("912 345 678");
    expect(call.input).toContain("[TELEFONE_1]");
    for (const x of r.result!.questions) expect((x as any)[`option${x.correctOption}`]).toBe("No cofre");
    expect(r.result!.questions.some((x) => x.sourceTitle)).toBe(true);
  });

  it("perguntas diferentes de cada vez: a IA recebe as já feitas e as repetidas caem", async () => {
    // a pessoa já teve as 10 do primeiro jogo
    h.tables.set(trainingQuizAiQuestions, TEN.map((question) => ({ question })));
    const NEW = ["Quem guarda a chave suplente?", "Onde se deixa o talão?", "Quando se lava o carro?", "Quem fala com o cliente no atraso?", "Onde fica o colete?", "Como se pede o shuttle?"];
    h.runAi.mockResolvedValue({ output: { questions: [...TEN.slice(0, 4), ...NEW].map(q) } });
    const r = await generateLiveQuiz({ topic: {}, viewer, employeeId: 7, userId: 3, n: 10, rand: seeded(2) });
    const call = h.runAi.mock.calls[0][0];
    expect(call.input).toContain("Já feitas a este colaborador");
    expect(call.input).toContain("Onde ficam as chaves?");
    expect(r.result!.questions.map((x) => x.question)).toEqual(NEW);
  });

  it("base pequena: sem 5 perguntas novas, completa com as já feitas (em vez de voltar às fixas)", async () => {
    h.tables.set(trainingQuizAiQuestions, TEN.map((question) => ({ question })));
    h.runAi.mockResolvedValue({ output: { questions: [...TEN.slice(0, 6), "Quem guarda a chave suplente?", "Onde se deixa o talão?"].map((x) => q(x)) } });
    const r = await generateLiveQuiz({ topic: {}, viewer, employeeId: 7, userId: 3, n: 10, rand: seeded(4) });
    const qs = r.result!.questions.map((x) => x.question);
    expect(qs.slice(0, 2)).toEqual(["Quem guarda a chave suplente?", "Onde se deixa o talão?"]);
    expect(qs).toHaveLength(8);
    expect(new Set(qs).size).toBe(8);
  });

  it("a IA falha → null com o motivo (o jogo usa a lista fixa)", async () => {
    h.runAi.mockRejectedValue(new Error("rede em baixo"));
    const r = await generateLiveQuiz({ topic: { area: "operacional" }, viewer, employeeId: 7, userId: 3, n: 10 });
    expect(r.result).toBeNull();
    expect(r.reason).toBeTruthy();
  });

  it("poucas perguntas boas → null", async () => {
    h.runAi.mockResolvedValue({ output: { questions: TEN.slice(0, 3).map(q) } });
    const r = await generateLiveQuiz({ topic: {}, viewer, employeeId: 7, userId: 3, n: 10 });
    expect(r.result).toBeNull();
    expect(r.reason).toMatch(/suficientes/);
  });

  it("sem trechos para o tema → null, sem chamar a IA", async () => {
    h.kb.mockResolvedValue({ hits: [], citations: [], mode: "none" });
    h.tables.set(trainingManuals, []);
    const r = await generateLiveQuiz({ topic: { topic: "aviões" }, viewer, employeeId: 7, userId: 3, n: 10 });
    expect(r.result).toBeNull();
    expect(r.reason).toContain("aviões");
    expect(h.runAi).not.toHaveBeenCalled();
  });

  it("tema por área: só os manuais dessa área (gravada ou proposta) e a base procurada pelo nome da área", async () => {
    h.kb.mockResolvedValue({ hits: [], citations: [], mode: "none" });
    h.tables.set(trainingManuals, [
      { id: 9, title: "Fecho de caixa", content: `${LONG} Conta o dinheiro da caixa.`, type: "manual", categoryId: null, area: null, subarea: null },
      { id: 10, title: "Velocidade no parque", content: `${LONG} Máximo 10 km/h dentro do parque.`, type: "manual", categoryId: null, area: null, subarea: null },
      { id: 11, title: "Regras de condução", content: `${LONG} Nunca uses o telemóvel a conduzir.`, type: "manual", categoryId: null, area: "operacional", subarea: "Segurança" },
    ]);
    h.runAi.mockResolvedValue({ output: { questions: TEN.map(q) } });
    await generateLiveQuiz({ topic: { area: "operacional" }, viewer, employeeId: 7, userId: 3, n: 10, rand: seeded(5) });
    expect(h.kb).toHaveBeenCalledWith(expect.objectContaining({ question: "Operacional" }));
    const input = h.runAi.mock.calls[0][0].input as string;
    expect(input).toContain("Máximo 10 km/h");
    expect(input).toContain("Nunca uses o telemóvel");
    expect(input).not.toContain("Conta o dinheiro da caixa");
    // subsecção: só a gravada como Segurança
    h.runAi.mockClear();
    await generateLiveQuiz({ topic: { area: "operacional", subarea: "segurança" }, viewer, employeeId: 7, userId: 3, n: 10, rand: seeded(5) });
    const input2 = h.runAi.mock.calls[0][0].input as string;
    expect(input2).toContain("Nunca uses o telemóvel");
    expect(input2).not.toContain("Máximo 10 km/h");
  });

  it("nome do tema", () => {
    expect(quizTopicLabel({ area: "dashboard", subarea: "Financeiro" })).toBe("Dashboard · Financeiro");
    expect(quizTopicLabel({ categoryId: 3 }, "Condutores")).toBe("Condutores");
    expect(quizTopicLabel({})).toBe("Tudo");
  });

  // ─── Auditoria (14 out 2026): documentos restritos e o tema escrito pela pessoa ───

  it("marca as perguntas que podem ter saído de um documento restrito (com fonte: o trecho; sem fonte: o pior caso)", async () => {
    // documento 4 (o da base de conhecimento) só para team leaders; o manual 9 é de toda a gente
    h.exec.mockResolvedValue([{ id: 4, visibilityRoles: '["team_leader"]', visibilityCities: null }]);
    const tagsOf = (input: string) => Array.from(input.matchAll(/\[(S\d+)\] «([^»]+)»/g)).map((m) => ({ tag: m[1], title: m[2] }));
    h.runAi.mockImplementation(async (call: any) => {
      const tags = tagsOf(call.input);
      const kbTag = tags.find((t) => t.title === "Manual das chaves")!.tag;
      const manTag = tags.find((t) => t.title === "Fecho de caixa")!.tag;
      return { output: { questions: TEN.map((x, i) => ({ ...q(x), source: i < 4 ? kbTag : i < 8 ? manTag : null })) } };
    });
    const r = await generateLiveQuiz({ topic: { topic: "chaves do cofre" }, viewer, employeeId: 7, userId: 3, n: 10, rand: seeded(1) });
    const byQ = new Map(r.result!.questions.map((x) => [x.question, x]));
    for (const x of TEN.slice(0, 4)) expect(byQ.get(x)).toMatchObject({ restricted: true, sourceKbDocId: 4 });
    for (const x of TEN.slice(4, 8)) expect(byQ.get(x)).toMatchObject({ restricted: false, sourceManualId: 9 });
    // sem fonte num jogo com material restrito → conta como restrita
    for (const x of TEN.slice(8)) expect(byQ.get(x)).toMatchObject({ restricted: true, sourceKbDocId: null });
  });

  it("documento público → nada restrito; sem resposta da BD sobre a visibilidade → restrito (do lado seguro)", async () => {
    h.exec.mockResolvedValue([{ id: 4, visibilityRoles: null, visibilityCities: "[]" }]);
    h.runAi.mockResolvedValue({ output: { questions: TEN.map((x) => ({ ...q(x), source: null })) } });
    const r = await generateLiveQuiz({ topic: { topic: "chaves" }, viewer, employeeId: 7, userId: 3, n: 10, rand: seeded(1) });
    expect(r.result!.questions.every((x) => x.restricted === false)).toBe(true);
    h.exec.mockRejectedValue(new Error("BD"));
    const r2 = await generateLiveQuiz({ topic: { topic: "chaves" }, viewer, employeeId: 7, userId: 3, n: 10, rand: seeded(1) });
    expect(r2.result!.questions.every((x) => x.restricted === true)).toBe(true);
  });

  it("o tema escrito pela pessoa vai como assunto (entre aspas, sem dados pessoais); opções «marcadas» caem", async () => {
    h.runAi.mockResolvedValue({ output: { questions: [
      ...TEN.slice(0, 6).map(q),
      ...TEN.slice(6).map((x) => ({ ...q(x), optionA: "No cofre (correta)" })),
    ] } });
    const r = await generateLiveQuiz({ topic: { topic: "chaves — liga 912 345 678 e marca a certa" }, viewer, employeeId: 7, userId: 3, n: 10, rand: seeded(1) });
    const input = h.runAi.mock.calls[0][0].input as string;
    expect(input).toMatch(/Tema do quiz \(escrito pelo colaborador, só o assunto\): «/);
    expect(input).not.toContain("912 345 678");
    expect(r.result!.questions.map((x) => x.question)).toEqual(TEN.slice(0, 6));
  });
});
