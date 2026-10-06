/**
 * P3 lote 28a — parques que NÃO são operados por nós (Jorge, 6 out 2026):
 * "Estes não são operados por nós. Todos os outros que estão na plataforma são
 * operados por nós." Casam pelo nome exato (só letras e números), nunca por
 * "contém"; ficam sempre fora da operação, além dos escolhidos em Definições.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { NOT_OPERATED_PARK_NAMES, isNotOperatedByName, unmatchedNotOperatedNames } from "../shared/multiparkParks";
import { excludeParks, isParkExcluded } from "../shared/reservasDoDia";
import { getNotOperatedParkIds } from "./multiparkDb/dayBookings";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("28a — lista dos parques que não operamos", () => {
  it("tem os 26 nomes do Jorge, todos diferentes", () => {
    expect(NOT_OPERATED_PARK_NAMES).toHaveLength(26);
    for (const n of NOT_OPERATED_PARK_NAMES) expect(isNotOperatedByName(n), n).toBe(true);
  });

  it("nome exato (sem acentos, maiúsculas, pontuação), com ou sem a cidade", () => {
    for (const n of ["TOP PARKING", "Top-Parking", "top parking lisboa", "Top Parking - Porto", "Check in Park", "CHECK-IN PARK", "Park & Fly"]) {
      expect(isNotOperatedByName(n), n).toBe(n !== "Park & Fly"); // "&" não é "and"
    }
    expect(isNotOperatedByName("Park and Fly Lisboa")).toBe(true);
    expect(isNotOperatedByName("Top Park Lisboa")).toBe(true);
    expect(isNotOperatedByName("Aeroporto Park")).toBe(true); // "aeroporto" não é palavra de cidade
  });

  it("nunca por 'contém': nomes parecidos e as marcas nossas ficam", () => {
    for (const n of ["Top Parking Express", "Easy Park", "Parking Terminal 2", "Smart Parking", "Boardingpark", "Airpark Lisboa", "Redpark Porto", "Skypark Faro", "Prime", "", null]) {
      expect(isNotOperatedByName(n as any), String(n)).toBe(false);
    }
    expect(isNotOperatedByName("Top Park")).toBe(true);
    expect(isNotOperatedByName("Top Parking")).toBe(true);
    expect(isNotOperatedByName("Easy Parking")).toBe(true);
    expect(isNotOperatedByName("Easy Park Estacionamento")).toBe(true);
  });

  it("excludeParks junta a lista por id (Definições) e a lista por nome; nada a tirar → o mesmo array", () => {
    const ps = [{ id: "a", name: "Airpark Lisboa" }, { id: "b", name: "Boardingpark" }, { id: "c", name: "Prime Park" }];
    expect(excludeParks(ps, ["b"]).map((p) => p.id)).toEqual(["a"]);
    expect(excludeParks(ps, []).map((p) => p.id)).toEqual(["a", "b"]);
    const ours = ps.slice(0, 2);
    expect(excludeParks(ours, null)).toBe(ours);
    expect(isParkExcluded({ id: "c", name: "Prime Park" }, new Set())).toBe(true);
    expect(isParkExcluded({ id: "b", name: "Boardingpark" }, ["b"])).toBe(true);
    expect(isParkExcluded({ id: "a", name: "Airpark" }, ["b"])).toBe(false);
  });

  it("avisa os nomes da lista sem parque na BD", () => {
    const left = unmatchedNotOperatedNames(["Top-Parking Lisboa", "Prime Park", "Airpark Lisboa"]);
    expect(left).not.toContain("Top Parking");
    expect(left).not.toContain("Prime Park");
    expect(left).toContain("Smart Park");
    expect(left).toHaveLength(24);
  });

  it("ids dos não operados (para o SQL das Ocorrências): lê os parques; falha → []", async () => {
    const query = vi.fn(async () => [
      { id: "p1", name: "Airpark", city: "Lisboa" }, { id: "p2", name: "Check-in Park", city: "Lisboa" }, { id: "p3", name: "Top Parking", city: "Porto" },
    ]);
    expect(await getNotOperatedParkIds(query as any)).toEqual(["p2", "p3"]);
    expect(String((query.mock.calls as any)[0][0])).toMatch(/FROM "Park"/);
  });

  it("ligações: Ocorrências (lista e parques tratados), Definições e descrição", () => {
    const routes = src("server/routers.ts");
    expect(routes).toContain("const excludedParkIds = [...new Set([...settingIds, ...(await getNotOperatedParkIds())])];");
    expect(routes).toContain("excluded: r.data.filter((p) => isParkExcluded(p, excluded)).map(row)");
    const settings = src("server/settingsRouter.ts");
    expect(settings).toContain("notOperated: isNotOperatedByName(p.name)");
    expect(settings).toContain("unmatchedNotOperated: unmatchedNotOperatedNames(");
    const page = src("client/src/pages/DefinicoesPage.tsx");
    expect(page).toContain("checked={p.notOperated || sel.has(p.id)} disabled={p.notOperated}");
    expect(page).toContain("não operado");
    expect(src("shared/appSettings.ts")).toContain("ficam SEMPRE fora os parques que não operamos");
  });
});
