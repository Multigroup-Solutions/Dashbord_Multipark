/**
 * Procurar formação por tema (14 out 2026): por palavras sempre; com a IA,
 * escolhe pelo sentido só dentro do catálogo; IA a falhar, desligada ou no
 * limite → pesquisa por palavras. Dependências simuladas.
 */
import { describe, expect, it, vi } from "vitest";
import { catalogLine, findTraining, resolvePicks, shortText, type CatalogItem, type FindDeps } from "./trainingCatalog";

const item = (o: Partial<CatalogItem> & { id: number; title: string }): CatalogItem & { text: string } => ({
  key: `${o.itemType ?? "manual"}:${o.id}`, itemType: "manual", description: "", manualType: "manual", categoryId: null, categoryName: null,
  area: null, subarea: null, areaGuessed: true, durationMinutes: null, careerLevel: null, updatedAt: null, text: "", ...o,
});
const CATALOG = [
  item({ id: 1, title: "Fecho de caixa", area: "dashboard", subarea: "Financeiro", text: "No fim do turno contas o dinheiro e fechas a caixa." }),
  item({ id: 2, title: "Entrega de viaturas", area: "multipark", subarea: "Entregar um carro", text: "Na app marcas a entrega." }),
  item({ id: 3, itemType: "video", key: "video:3", title: "Passagem de turno", area: "dashboard", subarea: "Passagem de turno", text: "Como entregar o turno." }),
];
const viewer = { role: "extra", allCities: false, cityNames: ["Faro"] };

function deps(over: Partial<FindDeps> = {}): FindDeps {
  return {
    catalog: vi.fn(async () => CATALOG),
    aiAvailable: vi.fn(async () => true),
    rateOk: vi.fn(async () => true),
    aiPick: vi.fn(async () => [{ id: "m1", reason: "Explica como fechar a caixa no fim do turno." }]),
    kb: vi.fn(async () => [{ docId: 8, title: "Procedimento da caixa", section: null }]),
    ...over,
  };
}

describe("procurar formação por tema", () => {
  it("com a IA: «Faz esta formação» é a escolhida, com a razão; sem texto interno no resultado", async () => {
    const d = deps();
    const r = await findTraining({ q: "como fecho o dia?", userId: 3, viewer }, d);
    expect(r.mode).toBe("ai");
    expect(r.results[0]).toMatchObject({ id: 1, itemType: "manual", reason: "Explica como fechar a caixa no fim do turno." });
    expect(r.results[0]).not.toHaveProperty("text");
    expect(r.kb).toEqual([{ docId: 8, title: "Procedimento da caixa", section: null }]);
    expect(d.kb).toHaveBeenCalledWith("como fecho o dia?", viewer);
    // a IA só recebe linhas do catálogo (id | tipo | área | título | resumo)
    const lines = (d.aiPick as any).mock.calls[0][1] as string[];
    expect(lines).toContain(catalogLine(CATALOG[0]));
  });

  it("a IA falha → pesquisa por palavras", async () => {
    const r = await findTraining({ q: "fechar a caixa", userId: 3, viewer }, deps({ aiPick: vi.fn(async () => { throw new Error("timeout"); }) }));
    expect(r.mode).toBe("text");
    expect(r.results[0]).toMatchObject({ id: 1, reason: null });
  });

  it("IA desligada ou no limite de pedidos → pesquisa por palavras, sem chamar a IA", async () => {
    const off = deps({ aiAvailable: vi.fn(async () => false) });
    expect((await findTraining({ q: "entregar um carro", userId: 3, viewer }, off)).results[0]).toMatchObject({ id: 2 });
    expect(off.aiPick).not.toHaveBeenCalled();
    const limited = deps({ rateOk: vi.fn(async () => false) });
    expect((await findTraining({ q: "entregar um carro", userId: 3, viewer }, limited)).mode).toBe("text");
    expect(limited.aiPick).not.toHaveBeenCalled();
  });

  it("a IA não inventa: ids fora do catálogo são ignorados; sem nenhum válido fica a pesquisa por palavras", async () => {
    const r = await findTraining({ q: "fechar a caixa", userId: 3, viewer }, deps({ aiPick: vi.fn(async () => [{ id: "m99", reason: "x" }, { id: "1; DROP", reason: "y" }]) }));
    expect(r.mode).toBe("text");
    expect(r.results[0].id).toBe(1);
    expect(resolvePicks([{ id: "V3", reason: "ok" }, { id: "v3", reason: "repetido" }, { id: "m2", reason: "ok" }], CATALOG).map((p) => p.item.key)).toEqual(["video:3", "manual:2"]);
  });

  it("a base de conhecimento falha → continua com as formações", async () => {
    const r = await findTraining({ q: "fechar a caixa", userId: 3, viewer }, deps({ kb: vi.fn(async () => { throw new Error("BD"); }) }));
    expect(r.kb).toEqual([]);
    expect(r.results.length).toBeGreaterThan(0);
  });

  it("resumos sem Markdown e sem ligações soltas", () => {
    expect(shortText("## Título\n**Negrito** e texto", 100)).toBe("Título Negrito e texto");
    expect(shortText("https://view.genially.com/abc")).toBe("");
  });
});
