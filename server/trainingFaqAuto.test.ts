/**
 * FAQs semanais da base de conhecimento (14 out 2026): interruptor desligado,
 * IA desligada, IA a falhar, sem repetir as eliminadas, até 3 por corrida e
 * "Gerar agora" sem depender do interruptor semanal. Dependências simuladas.
 */
import { describe, expect, it, vi } from "vitest";
import { runKbFaqGeneration, type FaqDeps } from "./trainingFaqAuto";
import { questionKeyOf } from "./trainingAiRules";

const now = new Date("2026-10-19T09:30:00Z");
const DOCS = [
  { id: 1, title: "Manual das chaves", charCount: 6000, updatedAt: "2026-10-18 10:00:00", faqCount: 0, lastFaqAt: null },
  { id: 2, title: "Fecho de caixa", charCount: 6000, updatedAt: "2026-10-17 10:00:00", faqCount: 0, lastFaqAt: null },
  { id: 3, title: "Ponto", charCount: 6000, updatedAt: "2026-10-16 10:00:00", faqCount: 0, lastFaqAt: null },
  { id: 4, title: "Shuttle", charCount: 6000, updatedAt: "2026-10-15 10:00:00", faqCount: 0, lastFaqAt: null },
];
const CANDIDATES: Record<number, Array<{ question: string; answer: string }>> = {
  1: [{ question: "Onde se deixam as chaves no fim do turno?", answer: "No cofre da receção, sempre identificadas." }, { question: "Quem abre o cofre das chaves?", answer: "O team leader de serviço abre o cofre." }],
  2: [{ question: "Quando se entrega o dinheiro ao líder?", answer: "No próprio dia, até às 6 h da manhã seguinte." }],
  3: [{ question: "Como marco o ponto no telemóvel?", answer: "No separador Ponto, quando chegas ao parque." }],
  4: [{ question: "De quanto em quanto tempo passa o shuttle?", answer: "De 15 em 15 minutos, entre as 5 h e a 1 h." }],
};

function deps(over: Partial<FaqDeps> = {}) {
  const inserted: any[] = [];
  const d: FaqDeps & { inserted: any[] } = {
    inserted,
    weeklyOn: vi.fn(async () => true),
    aiAvailable: vi.fn(async () => true),
    loadDocs: vi.fn(async () => DOCS),
    docText: vi.fn(async (id: number) => `Texto do documento ${id}. `.repeat(40)),
    existingFaqs: vi.fn(async () => [] as any[]),
    generate: vi.fn(async (doc: { id: number }) => CANDIDATES[doc.id] ?? []),
    insert: vi.fn(async (rows: readonly any[]) => { inserted.push(...rows); return rows.map((_, i) => 100 + i); }),
    saveRun: vi.fn(async () => undefined),
    log: vi.fn(async () => undefined),
    now: () => now,
    ...over,
  };
  return d;
}

describe("FAQs semanais da base de conhecimento", () => {
  it("interruptor semanal desligado (por omissão): não lê documentos nem chama a IA", async () => {
    const d = deps({ weeklyOn: vi.fn(async () => false) });
    const r = await runKbFaqGeneration({ trigger: "weekly" }, d);
    expect(r.skipped).toMatch(/desligado/);
    expect(r.ok).toBe(true);
    expect(d.loadDocs).not.toHaveBeenCalled();
    expect(d.generate).not.toHaveBeenCalled();
    expect(d.insert).not.toHaveBeenCalled();
  });

  it("«Gerar agora» (manual) não depende do interruptor semanal", async () => {
    const d = deps({ weeklyOn: vi.fn(async () => false) });
    const r = await runKbFaqGeneration({ trigger: "manual", userId: 9 }, d);
    expect(d.weeklyOn).not.toHaveBeenCalled();
    expect(r.created.length).toBeGreaterThan(0);
    expect(d.generate).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), expect.any(Array), 9);
  });

  it("IA desligada: não chama a IA e diz porquê", async () => {
    const d = deps({ aiAvailable: vi.fn(async () => false) });
    const r = await runKbFaqGeneration({ trigger: "weekly" }, d);
    expect(r.skipped).toMatch(/IA desligada/);
    expect(d.generate).not.toHaveBeenCalled();
    expect(d.insert).not.toHaveBeenCalled();
  });

  it("escolhe 3 documentos (os mais recentes sem FAQ) e publica até 3 FAQs, uma de cada", async () => {
    const d = deps();
    const r = await runKbFaqGeneration({ trigger: "weekly" }, d);
    expect(r.ok).toBe(true);
    expect(r.docs.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(d.inserted).toHaveLength(3);
    expect(d.inserted.map((x) => x.docId)).toEqual([1, 2, 3]);
    expect(d.inserted[0]).toMatchObject({ question: "Onde se deixam as chaves no fim do turno?", aiKey: questionKeyOf("Onde se deixam as chaves no fim do turno?") });
    expect(r.created.map((c) => c.id)).toEqual([100, 101, 102]);
    expect(d.log).toHaveBeenCalledOnce();
  });

  it("nunca repete uma FAQ eliminada (arquivada) — a próxima candidata do documento entra", async () => {
    const d = deps({
      existingFaqs: vi.fn(async () => [{ question: "Onde ficam as chaves ao fim do turno?", aiKey: questionKeyOf("Onde se deixam as chaves no fim do turno?"), sourceKbDocId: 1 }]),
    });
    await runKbFaqGeneration({ trigger: "weekly" }, d);
    const qs = d.inserted.map((x) => x.question);
    expect(qs).not.toContain("Onde se deixam as chaves no fim do turno?");
    expect(qs).toContain("Quem abre o cofre das chaves?");
    // a lista "não repitas" que vai para a IA começa pelas FAQs desse documento
    expect((d.generate as any).mock.calls[0][1][0]).toBe("Onde ficam as chaves ao fim do turno?");
  });

  it("a IA falha num documento: os outros entram e o erro fica registado", async () => {
    const d = deps({
      generate: vi.fn(async (doc: { id: number }) => { if (doc.id === 2) throw new Error("timeout"); return CANDIDATES[doc.id]; }),
    });
    const r = await runKbFaqGeneration({ trigger: "weekly" }, d);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("Fecho de caixa");
    expect(d.inserted.map((x) => x.docId)).toEqual([1, 3, 1]);
  });

  it("a IA falha em todos: nada é publicado e a corrida conta como falhada", async () => {
    const d = deps({ generate: vi.fn(async () => { throw new Error("rede"); }) });
    const r = await runKbFaqGeneration({ trigger: "weekly" }, d);
    expect(r.ok).toBe(false);
    expect(r.created).toEqual([]);
    expect(d.inserted).toEqual([]);
    expect(d.saveRun).toHaveBeenCalled();
  });

  it("sem documentos novos ou atualizados: não chama a IA", async () => {
    const d = deps({ loadDocs: vi.fn(async () => [{ id: 9, title: "Velho", charCount: 6000, updatedAt: "2026-01-01 00:00:00", faqCount: 2, lastFaqAt: "2026-10-01 00:00:00" }]) });
    const r = await runKbFaqGeneration({ trigger: "weekly" }, d);
    expect(r.skipped).toMatch(/sem documentos/);
    expect(d.generate).not.toHaveBeenCalled();
  });

  it("um erro inesperado (BD) não rebenta: fica ok:false com a mensagem", async () => {
    const d = deps({ loadDocs: vi.fn(async () => { throw new Error("Base de dados indisponível"); }) });
    const r = await runKbFaqGeneration({ trigger: "weekly" }, d);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("Base de dados");
  });
});
