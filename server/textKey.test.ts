import { describe, expect, it } from "vitest";
import { emailKey, matchKey, matchWords, sameText, searchText, textMatches } from "../shared/textKey";
import { buildIdentityResolver } from "./activityHelpers";
import { isZelloGpsExcluded, zelloExclusionSet } from "../shared/appSettings";
import { matchesContactQuery } from "../shared/contactSearch";
import { parseSearch, matchScore } from "../shared/globalSearch";
import { nameTokens } from "../shared/crmIdentity";

describe("regra única de comparação de texto (decisão do dono)", () => {
  it("não contam acentos, maiúsculas, apóstrofos, traços, pontos nem espaços", () => {
    expect(matchKey("João d'Almeida-Sá")).toBe("joaodalmeidasa");
    expect(sameText("João d'Almeida-Sá", "JOAO DALMEIDA SA")).toBe(true);
    expect(sameText("  Zé   Ninguém. ", "ze ninguem")).toBe(true);
    expect(sameText("Ana", "Ana Maria")).toBe(false);
    expect(sameText("", "")).toBe(false);
    expect(matchKey("Çé Straße Øre")).toBe("cestrasseore");
  });
  it("palavras e pesquisa: o apóstrofo cola, o resto separa", () => {
    expect(matchWords("Maria d'Almeida-Sá")).toEqual(["maria", "dalmeida", "sa"]);
    expect(searchText("  João   D’Almeida ")).toBe("joao dalmeida");
    expect(textMatches("João d'Almeida-Sá", "dalmeida")).toBe(true);
    expect(textMatches("João d'Almeida-Sá", "almeidasa joao")).toBe(true);
    expect(textMatches("João", "pedro")).toBe(false);
  });
  it("email: sem espaços nem maiúsculas; pontos contam", () => {
    expect(emailKey("  Joao.Silva@Gmail.COM ")).toBe("joao.silva@gmail.com");
  });
});

describe("a regra aplicada a quem liga pessoas", () => {
  it("Atividade do Dia: agente escrito de outra maneira liga à mesma ficha", () => {
    const resolve = buildIdentityResolver(
      [{ id: 7, fullName: "João Almeida Sá", multiparkAgentUserId: null, multiparkAgentName: "João d'Almeida-Sá" }], [], [], ["SISTEMA"],
    );
    expect(resolve(null, "JOAO DALMEIDA SA")).toMatchObject({ kind: "colaborador", employeeId: 7 });
    expect(resolve(null, "sistema")).toEqual({ kind: "ignorado" });
    expect(resolve(null, "Rui-Sá")).toMatchObject({ kind: "por_ligar", key: "agent:ruisa" });
  });
  it("Zello: a lista de exclusões compara pela mesma regra", () => {
    const ex = zelloExclusionSet(["Consola Lisboa"]);
    expect(isZelloGpsExcluded("consola-lisboa", ex)).toBe(true);
    expect(isZelloGpsExcluded("CONSOLA  LISBOA", ex)).toBe(true);
  });
  it("pesquisas: contactos, pesquisa geral e nomes do CRM", () => {
    expect(matchesContactQuery("almeidasa", { name: "João Almeida-Sá", phone: null })).toBe(true);
    expect(matchesContactQuery("+", { name: "João", phone: "912" })).toBe(false);
    expect(parseSearch("Almeida-Sá").like).toBe("%almeida%sá%");
    expect(parseSearch("joao@x.pt").like).toBe("%joao@x.pt%");
    expect(matchScore("dalmeida", "João d'Almeida")).toBeGreaterThan(0);
    expect(nameTokens("Maria d'Almeida-Sá")).toEqual(["maria", "dalmeida", "sa"]);
  });
});
