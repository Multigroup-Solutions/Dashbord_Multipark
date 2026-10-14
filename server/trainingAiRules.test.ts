/**
 * Formação com IA (14 out 2026) — regras puras:
 *  - áreas e subsecções: proposta para os conteúdos antigos, área gravada
 *    ganha, sugestões de subsecção, pesquisa por tema;
 *  - FAQs semanais: escolha dos documentos, sem repetir (as eliminadas contam);
 *  - quiz da IA: validação, opções baralhadas, sem repetir, trechos ao acaso e
 *    o que vai para o browser (nunca a resposta certa).
 */
import { describe, expect, it } from "vitest";
import {
  effectiveArea, guessTrainingArea, searchCatalog, searchTerms, subareaOptions, wordsMatch,
} from "../shared/trainingAreas";
import {
  FAQ_WEEKLY_MAX, aiQuestionAccess, cleanAiText, isDuplicateFaq, isPublicKbVisibility, liveQuestionRestricted, optionLooksMarked, parseStoredAnswers,
  pickExcerpts, pickFaqDocs, questionKeyOf, reservationWithinLimit, selectNewFaqs, shuffleOptions, toPlayerQuestion, validateLiveQuestions, type FaqDocCandidate,
} from "./trainingAiRules";

/** Gerador determinista (LCG) para os testes do acaso. */
const seeded = (seed: number) => {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 32; };
};

describe("áreas — proposta automática para os conteúdos que já existem", () => {
  it("os exemplos do Jorge ficam no sítio certo", () => {
    expect(guessTrainingArea({ title: "Fecho de caixa no fim do turno" })).toMatchObject({ area: "dashboard", subarea: "Financeiro" });
    expect(guessTrainingArea({ title: "Como fechar a caixa" })).toMatchObject({ area: "dashboard", subarea: "Financeiro" });
    expect(guessTrainingArea({ title: "Como entregar um carro ao cliente" })).toMatchObject({ area: "multipark", subarea: "Entregar um carro" });
    expect(guessTrainingArea({ title: "Ver as próximas reservas" })).toMatchObject({ area: "multipark", subarea: "Próximas reservas" });
  });
  it("operacional e comunicação", () => {
    expect(guessTrainingArea({ title: "Velocidade dentro do parque" })).toMatchObject({ area: "operacional", subarea: "Condução e manobras" });
    expect(guessTrainingArea({ title: "Onde ficam as chaves das viaturas" })).toMatchObject({ area: "operacional", subarea: "Chaves e viaturas" });
    expect(guessTrainingArea({ title: "Falar pelo Zello" })).toMatchObject({ area: "comunicacao", subarea: "Rádio (Zello)" });
    expect(guessTrainingArea({ title: "Responder a uma reclamação" })).toMatchObject({ area: "comunicacao", subarea: "Reclamações e críticas" });
  });
  it("a categoria também conta; sem pistas fica sem área (vai para Outros)", () => {
    expect(guessTrainingArea({ title: "Boas práticas", category: "Comunicação" })).toMatchObject({ area: "comunicacao" });
    expect(guessTrainingArea({ title: "Bem-vindo à Multipark" })).toMatchObject({ area: null, subarea: null });
  });
  it("só o texto (sem nada no título nem na categoria) precisa de mais certeza", () => {
    expect(guessTrainingArea({ title: "Introdução", content: "Fala sempre com o cliente com simpatia." }).area).toBeNull();
    expect(guessTrainingArea({ title: "Introdução", content: "Atendimento: fala com o cliente com simpatia; ao telefone sê breve; envia mensagem pelo WhatsApp e regista a reclamação." }).area).toBe("comunicacao");
  });
  it("a área gravada ganha à proposta; sem área gravada é proposta", () => {
    expect(effectiveArea({ title: "Fecho de caixa", area: "operacional", subarea: " Segurança  " })).toEqual({ area: "operacional", subarea: "Segurança", guessed: false });
    expect(effectiveArea({ title: "Fecho de caixa", area: null })).toEqual({ area: "dashboard", subarea: "Financeiro", guessed: true });
    // valor estranho na BD → tratado como não arrumado
    expect(effectiveArea({ title: "Fecho de caixa", area: "xpto" }).guessed).toBe(true);
    // "sem área" de propósito → Outros, e a app deixa de propor
    expect(effectiveArea({ title: "Fecho de caixa", area: "none", subarea: "x" })).toEqual({ area: null, subarea: null, guessed: false });
  });
  it("subsecções sugeridas: as por omissão e as em uso, sem repetir a mesma escrita de outra forma", () => {
    const opts = subareaOptions("dashboard", [
      { area: "dashboard", subarea: "financeiro" },
      { area: "dashboard", subarea: "Relatórios" },
      { area: "operacional", subarea: "Chaves" },
    ]);
    expect(opts).toContain("Financeiro");
    expect(opts).toContain("Relatórios");
    expect(opts).not.toContain("financeiro");
    expect(opts).not.toContain("Chaves");
  });
});

describe("procurar formação por tema (texto)", () => {
  const items = [
    { key: "m1", title: "Fecho de caixa", area: "dashboard", subarea: "Financeiro", text: "No fim do turno conta o dinheiro." },
    { key: "m2", title: "Entrega de viaturas", area: "multipark", subarea: "Entregar um carro", text: "Na app marca a entrega." },
    { key: "m3", title: "Entrada no parque", area: "operacional", subarea: "Condução e manobras", text: "Velocidade máxima 10 km/h." },
    { key: "v1", title: "Bem-vindo", area: null, subarea: null, text: "Apresentação da empresa." },
  ];
  it("«fechar a caixa» → Fecho de caixa em primeiro", () => {
    const hits = searchCatalog("quero aprender a fechar a caixa", items);
    expect(hits[0].item.key).toBe("m1");
    expect(hits.map((h) => h.item.key)).not.toContain("v1");
  });
  it("«entregar um carro» → Entrega de viaturas (e não «Entrada no parque»)", () => {
    const hits = searchCatalog("entregar um carro", items);
    expect(hits[0].item.key).toBe("m2");
    expect(wordsMatch("entrada", "entrega")).toBe(false);
    expect(wordsMatch("fecho", "fechar")).toBe(true);
  });
  it("a área e a subsecção também se procuram; palavras vazias não contam", () => {
    expect(searchCatalog("dashboard financeiro", items)[0].item.key).toBe("m1");
    expect(searchTerms("como é que eu faço a formação de")).toEqual([]);
    expect(searchCatalog("como é que eu faço", items)).toEqual([]);
  });
});

describe("FAQs semanais — escolha dos documentos", () => {
  const now = new Date("2026-10-14T09:30:00Z");
  const doc = (o: Partial<FaqDocCandidate> & { id: number }): FaqDocCandidate => ({ title: `Doc ${o.id}`, charCount: 5000, updatedAt: null, faqCount: 0, lastFaqAt: null, ...o });
  it("primeiro os ainda sem FAQ e os atualizados há pouco; no máximo 3", () => {
    const docs = [
      doc({ id: 1, updatedAt: "2026-06-01 10:00:00" }), // sem FAQ, antigo
      doc({ id: 2, updatedAt: "2026-10-12T08:00:00Z" }), // sem FAQ, recente
      doc({ id: 3, updatedAt: "2026-10-13 08:00:00", faqCount: 2, lastFaqAt: "2026-09-01 09:00:00" }), // mudou depois da última FAQ
      doc({ id: 4, updatedAt: "2026-10-10 08:00:00", faqCount: 0 }), // sem FAQ, recente
    ];
    // 2 e 4: sem FAQ e recentes; 3 (mudou há pouco) e 1 (sem FAQ, antigo) empatam → o mais recente primeiro.
    expect(pickFaqDocs(docs, now).map((d) => d.id)).toEqual([2, 4, 3]);
    expect(pickFaqDocs(docs, now, 5).map((d) => d.id)).toEqual([2, 4, 3, 1]);
  });
  it("sem mudanças desde a última FAQ não volta logo; documentos curtos nunca", () => {
    const docs = [
      doc({ id: 5, updatedAt: "2026-09-01 10:00:00", faqCount: 1, lastFaqAt: "2026-10-07 09:30:00" }),
      doc({ id: 6, charCount: 120 }),
    ];
    expect(pickFaqDocs(docs, now)).toEqual([]);
    // passados 28 dias, se ainda couber, volta como reserva
    const later = new Date("2026-11-10T09:30:00Z");
    expect(pickFaqDocs(docs, later).map((d) => d.id)).toEqual([5]);
    // cheio (1 por 3000 caracteres, mínimo 2) → não volta
    expect(pickFaqDocs([doc({ id: 7, charCount: 3000, updatedAt: "2026-01-01 00:00:00", faqCount: 2, lastFaqAt: "2026-02-01 00:00:00" })], later)).toEqual([]);
  });
});

describe("FAQs semanais — sem repetir (as eliminadas contam)", () => {
  const existing = [
    { question: "Que marcas fazem parte do grupo Multipark?", aiKey: null },
    // eliminada pelo Jorge: fica arquivada e com a marca da IA
    { question: "Pergunta editada depois", aiKey: questionKeyOf("Onde se deixam as chaves no fim do turno?") },
  ];
  it("igual, quase igual ou com a marca de uma eliminada → repetida", () => {
    expect(isDuplicateFaq("Quais são as marcas do grupo Multipark?", existing)).toBe(true);
    expect(isDuplicateFaq("Onde se deixam as chaves no fim do turno?", existing)).toBe(true);
    expect(isDuplicateFaq("Como se marca o ponto no telemóvel?", existing)).toBe(false);
  });
  it("uma de cada documento à vez, limpas, até 3, sem duas iguais", () => {
    const out = selectNewFaqs([
      { docId: 1, docTitle: "Chaves", items: [{ question: "Onde se deixam as chaves no fim do turno", answer: "No cofre da receção, sempre identificadas." }, { question: "Quem guarda o cofre das chaves?", answer: "O team leader de serviço guarda o cofre." }] },
      { docId: 2, docTitle: "Ponto", items: [{ question: "Como marco o ponto?", answer: "<b>No telemóvel</b>, no separador Ponto, ao chegar." }, { question: "Como marco o ponto?", answer: "Repetida dentro do lote." }] },
      { docId: 3, docTitle: "Caixa", items: [{ question: "Quando entrego o dinheiro ao líder?", answer: "No próprio dia, até às 6 h." }] },
    ], existing);
    expect(out).toHaveLength(FAQ_WEEKLY_MAX);
    expect(out.map((f) => f.docId)).toEqual([1, 2, 3]);
    expect(out[0].question).toBe("Quem guarda o cofre das chaves?");
    expect(out[1].answer).toBe("No telemóvel, no separador Ponto, ao chegar.");
    expect(out.every((f) => f.question.endsWith("?") && f.aiKey.length > 0)).toBe(true);
  });
  it("texto da IA sem HTML nem imagens, com tamanho máximo", () => {
    expect(cleanAiText("<script>x</script>Olá ![i](http://x/y.png) **tu**", 100)).not.toMatch(/<|!\[|\*\*/);
    expect(cleanAiText("a".repeat(50), 10)).toHaveLength(10);
  });
});

describe("quiz da IA — perguntas e o que vai para o browser", () => {
  const q = (question: string, over: Record<string, unknown> = {}) => ({
    question, optionA: "No cofre", optionB: "No carro", optionC: "Com o cliente", optionD: "No balcão", correctOption: "A", explanation: "Diz o manual.", difficulty: "easy", source: "S1", ...over,
  });
  it("valida, tira repetidas e as que a pessoa já teve, e baralha mantendo a certa", () => {
    const raw = [
      q("Onde ficam as chaves no fim do turno?"),
      q("Onde ficam as chaves no fim do turno?"), // repetida no lote
      q("Qual a velocidade máxima no parque?", { optionB: "No cofre" }), // opções repetidas
      q("Quem fecha a caixa ao fim do dia?"), // já a teve
      q("O que fazes antes de mover o carro?", { source: "S9" }), // trecho que não existe → sem fonte
      { question: "x" },
    ];
    const out = validateLiveQuestions(raw, { n: 10, recent: ["Quem fecha a caixa ao fim do dia?"], sourceTags: new Set(["S1"]), rand: seeded(3) });
    expect(out.map((x) => x.question)).toEqual(["Onde ficam as chaves no fim do turno?", "O que fazes antes de mover o carro?"]);
    for (const x of out) expect((x as any)[`option${x.correctOption}`]).toBe("No cofre");
    expect(out[1].sourceTag).toBeNull();
    expect(out[0].sourceTag).toBe("S1");
  });
  it("a letra certa não fica sempre a mesma", () => {
    const rand = seeded(42);
    const letters = new Set(Array.from({ length: 30 }, () => shuffleOptions(q("x?") as any, rand).correctOption));
    expect(letters.size).toBeGreaterThan(1);
  });
  it("cada jogo leva trechos diferentes (ao acaso), no máximo 2 do mesmo documento", () => {
    const ex = Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, section: null, text: `${"texto ".repeat(30)}${i}`, kbDocId: (i % 4) + 1 }));
    const a = pickExcerpts(ex, { maxChars: 1000, maxItems: 5, rand: seeded(1) }).map((e) => e.title);
    const b = pickExcerpts(ex, { maxChars: 1000, maxItems: 5, rand: seeded(7) }).map((e) => e.title);
    expect(a).not.toEqual(b);
    const perDoc = new Map<number, number>();
    for (const e of pickExcerpts(ex, { maxChars: 99_999, maxItems: 12, rand: seeded(2) })) perDoc.set(e.kbDocId!, (perDoc.get(e.kbDocId!) ?? 0) + 1);
    expect(Math.max(...perDoc.values())).toBeLessThanOrEqual(2);
  });
  it("para o browser vai a pergunta e as opções — nunca a resposta certa nem a explicação", () => {
    const p = toPlayerQuestion({ id: 3, question: "?", optionA: "a", optionB: "b", optionC: "c", optionD: "d", correctOption: "B", explanation: "porque", points: 10, difficulty: "easy" } as any);
    expect(Object.keys(p).sort()).toEqual(["difficulty", "id", "optionA", "optionB", "optionC", "optionD", "points", "question"]);
    expect(JSON.stringify(p)).not.toContain("porque");
  });
  it("respostas guardadas na tentativa (JSON) → lista limpa", () => {
    expect(parseStoredAnswers('[{"questionId":1,"answer":"a"},{"questionId":"x","answer":"B"},{"questionId":2,"answer":"E"}]')).toEqual([{ questionId: 1, answer: "A" }]);
    expect(parseStoredAnswers("não é json")).toEqual([]);
    expect(parseStoredAnswers(null)).toEqual([]);
  });
});

describe("auditoria (14 out 2026) — documentos restritos, reservas e opções marcadas", () => {
  it("documento de toda a gente: a mesma regra do SQL (NULL, '' ou '[]' nos papéis e nas cidades)", () => {
    expect(isPublicKbVisibility(null, null)).toBe(true);
    expect(isPublicKbVisibility("", "[]")).toBe(true);
    expect(isPublicKbVisibility([], " [] ")).toBe(true);
    expect(isPublicKbVisibility('["admin"]', null)).toBe(false);
    expect(isPublicKbVisibility(null, '["Porto"]')).toBe(false);
    // texto estranho (não é lista vazia) → restrito, como no SQL
    expect(isPublicKbVisibility("lixo", null)).toBe(false);
    expect(isPublicKbVisibility(["xpto"], null)).toBe(false);
  });

  it("pergunta restrita: com fonte conta o trecho; sem fonte, o pior caso do jogo", () => {
    const pub = new Map([["S1", true], ["S2", false]]);
    expect(liveQuestionRestricted("S1", pub)).toBe(false);
    expect(liveQuestionRestricted("S2", pub)).toBe(true);
    expect(liveQuestionRestricted(null, pub)).toBe(true);
    expect(liveQuestionRestricted("S9", pub)).toBe(true);
    expect(liveQuestionRestricted(null, new Map([["S1", true]]))).toBe(false);
  });

  it("quem gere vê: pública sim; restrita só com o documento que ela própria vê; sem fonte e restrita, nunca", () => {
    expect(aiQuestionAccess({ restricted: 0, sourceKbDocId: null }, null)).toBe("public");
    expect(aiQuestionAccess({ restricted: 1, sourceKbDocId: null }, null)).toBe("hidden");
    expect(aiQuestionAccess({ restricted: 0, sourceKbDocId: 4 }, { isPublic: true, viewerCanSee: true })).toBe("public");
    // o documento passou a restrito depois do jogo → conta o estado de agora
    expect(aiQuestionAccess({ restricted: 0, sourceKbDocId: 4 }, { isPublic: false, viewerCanSee: true })).toBe("restricted_visible");
    expect(aiQuestionAccess({ restricted: 1, sourceKbDocId: 4 }, { isPublic: false, viewerCanSee: false })).toBe("hidden");
    expect(aiQuestionAccess({ restricted: 1, sourceKbDocId: 4 }, null)).toBe("hidden");
  });

  it("reserva do quiz: só as primeiras do dia de Lisboa (por id) valem", () => {
    const now = new Date("2026-10-14T10:00:00Z");
    const rows = [1, 2, 3, 4, 7, 8].map((id) => ({ id, startedAt: "2026-10-14 09:00:00" }));
    expect(reservationWithinLimit(rows, 7, now, 5)).toBe(true);
    expect(reservationWithinLimit(rows, 8, now, 5)).toBe(false);
    // as de ontem (Lisboa) não contam: 23:30 UTC de 13 out = 00:30 de 14 em Lisboa → conta; 22:30 UTC → ontem
    const edge = [{ id: 1, startedAt: "2026-10-13 22:30:00" }, { id: 2, startedAt: "2026-10-13 23:30:00" }];
    expect(reservationWithinLimit(edge, 2, now, 1)).toBe(true);
  });

  it("opções «marcadas» como a certa", () => {
    for (const t of ["No cofre (correta)", "✓ No cofre", "No cofre ✔", "*No cofre", "No cofre [certa]", "No cofre (resposta certa)"]) expect(optionLooksMarked(t), t).toBe(true);
    for (const t of ["No cofre", "A resposta certa depende do turno", "Certamente no cofre", "5 * 2 minutos depois"]) expect(optionLooksMarked(t), t).toBe(false);
    const raw = [{ question: "Onde ficam as chaves?", optionA: "No cofre ✓", optionB: "No carro", optionC: "Com o cliente", optionD: "No balcão", correctOption: "A" }];
    expect(validateLiveQuestions(raw, { n: 5 })).toEqual([]);
  });
});
