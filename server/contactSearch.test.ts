import { describe, expect, it } from "vitest";
import { matchesContactQuery, normalizeSearchText } from "../shared/contactSearch";

describe("normalizeSearchText", () => {
  it("tira acentos, maiúsculas e espaços a mais", () => {
    expect(normalizeSearchText("  João   Gonçalves ")).toBe("joao goncalves");
    expect(normalizeSearchText(null)).toBe("");
  });
});

describe("matchesContactQuery", () => {
  const joao = { name: "João Gonçalves", phone: "+351912345678" };
  const semNome = { name: null, phone: "+447911123456" };

  it("pesquisa vazia passa tudo", () => {
    expect(matchesContactQuery("", joao)).toBe(true);
    expect(matchesContactQuery("   ", semNome)).toBe(true);
  });

  it("encontra por nome sem acentos nem maiúsculas", () => {
    expect(matchesContactQuery("joao", joao)).toBe(true);
    expect(matchesContactQuery("GONCAL", joao)).toBe(true);
    expect(matchesContactQuery("maria", joao)).toBe(false);
  });

  it("encontra por número só pelos dígitos", () => {
    expect(matchesContactQuery("912", joao)).toBe(true);
    expect(matchesContactQuery("912 345", joao)).toBe(true);
    expect(matchesContactQuery("+351912", joao)).toBe(true);
    expect(matchesContactQuery("00351 912", joao)).toBe(true);
    expect(matchesContactQuery("913", joao)).toBe(false);
  });

  it("várias palavras = todas têm de bater (nome OU número)", () => {
    expect(matchesContactQuery("joao 912", joao)).toBe(true);
    expect(matchesContactQuery("joao 913", joao)).toBe(false);
    expect(matchesContactQuery("goncalves joao", joao)).toBe(true);
  });

  it("contacto sem nome só é encontrado pelo número", () => {
    expect(matchesContactQuery("4479", semNome)).toBe(true);
    expect(matchesContactQuery("abc", semNome)).toBe(false);
  });

  it("sinais de pontuação sem dígitos nunca batem no número", () => {
    expect(matchesContactQuery("+", joao)).toBe(false);
  });
});
