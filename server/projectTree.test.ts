import { describe, expect, it } from "vitest";
import {
  allowedChildLevels, buildForest, createParkMatcher, duplicateSiblingNames, evaluateDelete, findOrphans,
  findParkProjectId, nodesInCycles, normalizeParkName, parkKey, planMissingParkNodes, siblingNameConflict,
  validatePlacement, wouldCreateCycle, type ProjectTreeNode, type ReferenceCount,
} from "../shared/projectTree";

// Árvore típica: Multipark → Lisboa/Porto/Faro → marcas → parques
const N = (id: number, name: string, level: string, parentId: number | null, isActive = 1): ProjectTreeNode => ({ id, name, level, parentId, isActive });
const tree: ProjectTreeNode[] = [
  N(1, "Multipark", "group", null),
  N(2, "Lisboa", "city", 1), N(3, "Porto", "city", 1), N(4, "Faro", "city", 1),
  N(10, "Airpark", "brand", 2), N(11, "Airpark", "brand", 3), N(12, "Airpark", "brand", 4),
  N(20, "Airpark Lisboa", "project", 10), N(21, "Airpark Porto", "project", 11), N(22, "Airpark Faro", "project", 12),
  N(23, "Top-Parking Lisboa", "project", 2), // exceção histórica: projeto direto na cidade
  N(24, "Lispark Lisboa", "project", 2),
  N(30, "Marketplace", "brand", 3),
  N(31, "Top Parking Porto", "project", 30),
  N(32, "Stop & Fly Park Porto", "project", 30),
  N(40, "Redpark Lisboa", "project", 10, 0), // inativo (fechado)
];

describe("normalizeParkName / parkKey", () => {
  it("normaliza acentos, hífens, & e espaços", () => {
    expect(normalizeParkName("  Stop  &  Fly-Park  ")).toBe("stop fly park");
    expect(normalizeParkName("Aérpark – Lisboa")).toBe("aerpark lisboa");
  });
  it("top-parking = top parking = TopParking, sem a cidade", () => {
    expect(parkKey("Top-Parking Lisboa")).toBe("topparking");
    expect(parkKey("top parking")).toBe("topparking");
    expect(parkKey("TopParking - Porto")).toBe("topparking");
    expect(parkKey("Airpark - Lisbon")).toBe("airpark");
  });
});

describe("matcher de parque (sync + backfill)", () => {
  const match = createParkMatcher(tree, [{ name: "Airpark", city: "Lisboa" }, { name: "Top Parking", city: "Porto" }]);
  it("marca + cidade (EN/PT) → projeto da cidade certa", () => {
    expect(match({ parkName: "Airpark", city: "lisbon" })).toBe(20);
    expect(match({ parkName: "Airpark", city: "Porto" })).toBe(21);
    expect(match({ parkName: "Airpark - Faro", city: null })).toBe(22);
  });
  it("cidade no parkName quando a coluna vem vazia", () => {
    expect(match({ parkName: "Stop & Fly Park Porto" })).toBe(32);
    expect(match({ parkName: "stop-fly park", city: "oporto" })).toBe(32);
  });
  it("top-parking em Lisboa (direto na cidade) e Top Parking no Porto (marketplace)", () => {
    expect(match({ parkName: "Top-Parking", city: "Lisboa" })).toBe(23);
    expect(match({ parkName: "Top Parking", city: "Porto" })).toBe(31);
  });
  it("sem cidade não adivinha (nunca cai num nó de marca/cidade qualquer)", () => {
    expect(match({ parkName: "Airpark" })).toBeUndefined();
    expect(match({ parkName: "Airpark", city: "Madrid" })).toBeUndefined();
  });
  it("ignora nós inativos e níveis que não são 'project'", () => {
    expect(match({ parkName: "Redpark", city: "Lisboa" })).toBeUndefined();
    expect(match({ parkName: "Marketplace", city: "Porto" })).toBeUndefined();
  });
  it("não faz match parcial", () => {
    expect(match({ parkName: "Airpark Premium", city: "Lisboa" })).toBeUndefined();
  });
  it("desempate determinístico: nome exato do PARK_CONFIGS e depois id mais baixo", () => {
    const dup = [...tree, N(50, "AirPark - Lisboa", "project", 2)];
    expect(findParkProjectId({ parkName: "airpark", city: "Lisboa" }, dup, [{ name: "Airpark", city: "Lisboa" }])).toBe(20);
    const dup2 = [...tree.filter(n => n.id !== 20), N(52, "Air-park", "project", 10), N(51, "AIR PARK", "project", 10)];
    expect(findParkProjectId({ parkName: "airpark", city: "Lisboa" }, dup2)).toBe(51);
  });
  it("nó com nome de outra cidade pendurado na cidade errada é ignorado", () => {
    const wrong = [...tree.filter(n => n.id !== 21), N(60, "Airpark Lisboa", "project", 11)];
    expect(findParkProjectId({ parkName: "Airpark", city: "Porto" }, wrong)).toBeUndefined();
  });
  it("não rebenta com ciclos na árvore", () => {
    const cyc = [...tree, N(70, "A", "brand", 71), N(71, "B", "brand", 70), N(72, "Boardingpark Lisboa", "project", 70)];
    expect(findParkProjectId({ parkName: "Boardingpark", city: "Lisboa" }, cyc)).toBeUndefined();
  });
});

describe("regras de nível/pai", () => {
  const byId = new Map(tree.map(n => [n.id, n]));
  it("níveis permitidos", () => {
    expect(allowedChildLevels(null)).toEqual(["group"]);
    expect(allowedChildLevels("group")).toEqual(["city"]);
    expect(allowedChildLevels("city")).toEqual(["brand", "project"]);
    expect(allowedChildLevels("brand")).toEqual(["project"]);
    expect(allowedChildLevels("project")).toEqual([]);
  });
  it("valida colocação", () => {
    expect(validatePlacement("city", byId.get(1), 1)).toBeNull();
    expect(validatePlacement("brand", byId.get(2), 2)).toBeNull();
    expect(validatePlacement("project", byId.get(2), 2)).toBeNull(); // Lispark/Top-Parking
    expect(validatePlacement("project", byId.get(10), 10)).toBeNull();
    expect(validatePlacement("brand", byId.get(1), 1)).toMatch(/não pode ficar dentro de Grupo/);
    expect(validatePlacement("city", null, null)).toMatch(/tem de ter um pai/);
    expect(validatePlacement("project", undefined, 999)).toBe("O nó pai não existe.");
    expect(validatePlacement("project", byId.get(20), 20)).toMatch(/não pode ficar dentro de Projeto/);
  });
  it("nome único por pai (case-insensitive)", () => {
    expect(siblingNameConflict(" airpark ", 2, tree)?.id).toBe(10);
    expect(siblingNameConflict("Airpark", 2, tree, 10)).toBeUndefined();
    expect(siblingNameConflict("Skypark", 2, tree)).toBeUndefined();
    expect(duplicateSiblingNames([...tree, N(80, "AIRPARK", "brand", 2)])).toEqual([{ parentId: 2, name: "Airpark", ids: [10, 80] }]);
  });
});

describe("mover sem ciclos", () => {
  const byId = new Map(tree.map(n => [n.id, n]));
  it("recusa mover para si próprio ou descendente", () => {
    expect(wouldCreateCycle(10, 20, byId)).toBe(true);
    expect(wouldCreateCycle(2, 10, byId)).toBe(true);
    expect(wouldCreateCycle(10, 10, byId)).toBe(true);
    expect(wouldCreateCycle(20, 11, byId)).toBe(false);
    expect(wouldCreateCycle(20, null, byId)).toBe(false);
  });
  it("termina mesmo com um ciclo pré-existente", () => {
    const cyc = new Map([...tree, N(70, "A", "brand", 71), N(71, "B", "brand", 70)].map(n => [n.id, n]));
    expect(wouldCreateCycle(20, 70, cyc)).toBe(true);
    expect(nodesInCycles(Array.from(cyc.values())).sort()).toEqual([70, 71]);
  });
});

describe("floresta / órfãos", () => {
  it("admin de cidade: raiz é a cidade visível", () => {
    const porto = tree.filter(n => [3, 11, 21, 30, 31, 32].includes(n.id));
    const forest = buildForest(porto);
    expect(forest.map(r => r.id)).toEqual([3]);
    expect(forest[0].children.map((c: any) => c.id).sort()).toEqual([11, 30]);
  });
  it("órfãos e ciclos aparecem na floresta sem loop infinito", () => {
    const nodes = [...tree, N(90, "Perdido", "project", 999), N(70, "A", "brand", 71), N(71, "B", "brand", 70)];
    expect(findOrphans(nodes).map(n => n.id)).toEqual([90]);
    const ids = new Set<number>();
    const walk = (ns: any[]) => ns.forEach(n => { ids.add(n.id); walk(n.children); });
    walk(buildForest(nodes));
    expect(ids.size).toBe(nodes.length);
  });
});

describe("plano de nós em falta", () => {
  it("marca própria debaixo da marca; marketplace debaixo de Marketplace (criado se faltar); fechados ignorados", () => {
    const { plan, skipped } = planMissingParkNodes(tree, [
      { name: "Airpark", city: "Lisboa" }, // já existe
      { name: "Skypark", city: "Lisboa" }, // marca em falta
      { name: "Boardingpark", city: "Porto" }, // Marketplace existe (30)
      { name: "Boardingpark", city: "Faro" }, // Marketplace em falta
      { name: "Top-Parking", city: "Lisboa", closed: true }, // existe (23)
      { name: "Readypark", city: "Lisboa", closed: true },
      { name: "Parkdirect", city: "Madrid" },
    ]);
    expect(plan).toEqual([
      { park: "Skypark", city: "lisboa", cityNodeId: 2, brandName: "Skypark", brandNodeId: null, projectName: "Skypark Lisboa" },
      { park: "Boardingpark", city: "porto", cityNodeId: 3, brandName: "Marketplace", brandNodeId: 30, projectName: "Boardingpark Porto" },
      { park: "Boardingpark", city: "faro", cityNodeId: 4, brandName: "Marketplace", brandNodeId: null, projectName: "Boardingpark Faro" },
    ]);
    expect(skipped.map(s => s.reason)).toEqual(["Parque fechado", "Cidade sem nó na árvore"]);
  });
  it("idempotente: depois de criar os nós o plano fica vazio e o matcher encontra-os", () => {
    const parks = [{ name: "Boardingpark", city: "Porto" }, { name: "Stop & Fly Park", city: "Porto" }];
    const first = planMissingParkNodes(tree, parks).plan;
    expect(first.map(p => p.projectName)).toEqual(["Boardingpark Porto"]);
    const after = [...tree, N(100, "Boardingpark Porto", "project", 30)];
    expect(planMissingParkNodes(after, parks).plan).toEqual([]);
    expect(findParkProjectId({ parkName: "boardingpark", city: "oporto" }, after)).toBe(100);
  });
});

describe("guarda de referências (desativar / apagar)", () => {
  const ref = (table: string, count: number, config = false): ReferenceCount => ({ table, label: table, count, config });
  it("desativar: recusa com filhos ativos ou configuração viva; histórico não bloqueia", () => {
    expect(evaluateDelete({ activeChildren: 0, totalChildren: 0, references: [ref("expenses", 12), ref("multipark_bookings", 300)] }))
      .toMatchObject({ canDeactivate: true, canHardDelete: false });
    const r = evaluateDelete({ activeChildren: 2, totalChildren: 2, references: [ref("employees", 3, true)] });
    expect(r.canDeactivate).toBe(false);
    expect(r.reasons).toEqual(["Tem 2 sub-nó(s) ativo(s) — desativa-os ou move-os primeiro.", "employees: 3"]);
  });
  it("apagar definitivamente só sem filhos (mesmo inativos) e com zero referências", () => {
    expect(evaluateDelete({ activeChildren: 0, totalChildren: 0, references: [ref("expenses", 0)] }).canHardDelete).toBe(true);
    expect(evaluateDelete({ activeChildren: 0, totalChildren: 1, references: [] }).canHardDelete).toBe(false);
    expect(evaluateDelete({ activeChildren: 0, totalChildren: 0, references: [ref("google_reviews", 1)] }).canHardDelete).toBe(false);
  });
});
