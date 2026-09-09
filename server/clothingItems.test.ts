import { describe, expect, it } from "vitest";
import {
  CLOTHING_MAX_ITEMS,
  CLOTHING_MAX_QTY,
  countClothingItems,
  normalizeClothingItems,
  parseClothingItems,
  summarizeClothingItems,
} from "../shared/clothing";

describe("parseClothingItems", () => {
  it("null / vazio / JSON partido → []", () => {
    expect(parseClothingItems(null)).toEqual([]);
    expect(parseClothingItems("")).toEqual([]);
    expect(parseClothingItems("   ")).toEqual([]);
    expect(parseClothingItems("{nope")).toEqual([]);
    expect(parseClothingItems("{}")).toEqual([]);
  });

  it("lê JSON (string) e arrays já parseados; descarta linhas inválidas sem partir", () => {
    const raw = JSON.stringify([
      { type: "casaco", size: "M", qty: 2 },
      { type: "chapéu", size: "M", qty: 1 }, // tipo desconhecido
      { type: "colete", size: "XXXL", qty: 1 }, // tamanho desconhecido
      { type: "gorro", size: "Único", qty: 0 }, // qty inválida
      { type: "polar", size: "L", qty: "3" }, // qty como texto → aceite
      null,
      "x",
    ]);
    expect(parseClothingItems(raw)).toEqual([
      { type: "casaco", size: "M", qty: 2 },
      { type: "polar", size: "L", qty: 3 },
    ]);
    expect(parseClothingItems([{ type: "gorro", size: "Único", qty: 1 }])).toEqual([{ type: "gorro", size: "Único", qty: 1 }]);
  });

  it("respeita os tetos de quantidade e de linhas", () => {
    expect(parseClothingItems([{ type: "casaco", size: "M", qty: 5000 }])[0].qty).toBe(CLOTHING_MAX_QTY);
    const many = Array.from({ length: CLOTHING_MAX_ITEMS + 10 }, () => ({ type: "colete", size: "S", qty: 1 }));
    expect(parseClothingItems(many)).toHaveLength(CLOTHING_MAX_ITEMS);
  });
});

describe("normalizeClothingItems", () => {
  it("soma linhas repetidas (mesmo tipo+tamanho) e ordena por tipo e tamanho", () => {
    const out = normalizeClothingItems([
      { type: "casaco", size: "L", qty: 3 },
      { type: "colete", size: "S", qty: 2 },
      { type: "casaco", size: "M", qty: 1 },
      { type: "casaco", size: "M", qty: 1 },
    ]);
    expect(out).toEqual([
      { type: "colete", size: "S", qty: 2 },
      { type: "casaco", size: "M", qty: 2 },
      { type: "casaco", size: "L", qty: 3 },
    ]);
  });

  it("ignora quantidades não positivas", () => {
    expect(normalizeClothingItems([{ type: "gorro", size: "Único", qty: 0 }])).toEqual([]);
  });
});

describe("summarizeClothingItems / countClothingItems", () => {
  it("frase legível com singular/plural — o exemplo do Jorge", () => {
    const items = [
      { type: "casaco" as const, size: "M" as const, qty: 2 },
      { type: "casaco" as const, size: "L" as const, qty: 3 },
      { type: "colete" as const, size: "S" as const, qty: 2 },
      { type: "gorro" as const, size: "Único" as const, qty: 1 },
    ];
    expect(summarizeClothingItems(items)).toBe("2 coletes S, 2 casacos M, 3 casacos L, 1 gorro Único");
    expect(countClothingItems(items)).toBe(8);
  });

  it("vazio → string vazia e 0", () => {
    expect(summarizeClothingItems([])).toBe("");
    expect(countClothingItems([])).toBe(0);
  });
});
