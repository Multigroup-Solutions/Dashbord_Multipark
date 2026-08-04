import { describe, expect, it } from "vitest";
import { matchCityKey } from "../shared/city";
import { resolveCityFromProjects, type ProjectNode } from "./employeeCity";

function node(id: number, name: string, level: string, parentId: number | null = null): ProjectNode {
  return { id, name, level, parentId };
}

/**
 * Hierarquia real da app (ver `seedHierarchy` em db.ts):
 *   Multipark (group) → Lisboa/Porto/Faro (city) → marca → parque
 */
const TREE = new Map<number, ProjectNode>(
  [
    node(1, "Multipark", "group"),
    node(10, "Lisboa", "city", 1),
    node(11, "Porto", "city", 1),
    node(12, "Faro", "city", 1),
    node(20, "Airpark", "brand", 10),
    node(21, "Skypark", "brand", 12),
    node(30, "Airpark Lisboa", "project", 20),
    node(31, "Skypark Faro", "project", 21),
    node(32, "Lispark Lisboa", "project", 10), // parque direto na cidade
    node(40, "Parque Solto", "project", null), // órfão, sem cidade acima
  ].map(n => [n.id, n]),
);

describe("matchCityKey", () => {
  it("reconhece as três cidades com e sem acentos/variantes", () => {
    expect(matchCityKey("Lisboa")).toBe("lisboa");
    expect(matchCityKey("LISBON")).toBe("lisboa");
    expect(matchCityKey("porto")).toBe("porto");
    expect(matchCityKey("Faro")).toBe("faro");
  });

  it("não confunde Portimão com Porto (fronteira de palavra)", () => {
    expect(matchCityKey("Portimão")).toBeNull();
    expect(matchCityKey("Rua de Portimão, 12")).toBeNull();
  });

  it("encontra a cidade dentro de texto livre (morada, nome de parque)", () => {
    expect(matchCityKey("Av. da Liberdade 100, 1250-096 Lisboa")).toBe("lisboa");
    expect(matchCityKey("Airpark Faro")).toBe("faro");
    expect(matchCityKey("Rua X, Porto")).toBe("porto");
  });

  it("devolve null para vazio, null e cidades fora do conjunto", () => {
    expect(matchCityKey(null)).toBeNull();
    expect(matchCityKey("")).toBeNull();
    expect(matchCityKey("Vila Nova de Gaia")).toBeNull();
    expect(matchCityKey("Coimbra")).toBeNull();
  });
});

describe("resolveCityFromProjects", () => {
  it("sobe a árvore parque → marca → cidade", () => {
    expect(resolveCityFromProjects(TREE, 30)).toBe("lisboa");
    expect(resolveCityFromProjects(TREE, 31)).toBe("faro");
  });

  it("resolve um parque ligado diretamente à cidade", () => {
    expect(resolveCityFromProjects(TREE, 32)).toBe("lisboa");
  });

  it("resolve quando o próprio nó É a cidade", () => {
    expect(resolveCityFromProjects(TREE, 11)).toBe("porto");
  });

  it("usa o nome do projeto como recurso quando não há nó de cidade acima", () => {
    const flat = new Map<number, ProjectNode>([[50, node(50, "Skypark Porto", "project", null)]]);
    expect(resolveCityFromProjects(flat, 50)).toBe("porto");
  });

  it("devolve null sem projeto, com projeto desconhecido ou sem cidade identificável", () => {
    expect(resolveCityFromProjects(TREE, null)).toBeNull();
    expect(resolveCityFromProjects(TREE, undefined)).toBeNull();
    expect(resolveCityFromProjects(TREE, 999)).toBeNull();
    expect(resolveCityFromProjects(TREE, 40)).toBeNull();
  });

  it("não entra em ciclo infinito com uma árvore mal formada", () => {
    const cyclic = new Map<number, ProjectNode>([
      [60, node(60, "A", "project", 61)],
      [61, node(61, "B", "project", 60)],
    ]);
    expect(resolveCityFromProjects(cyclic, 60)).toBeNull();
  });
});
