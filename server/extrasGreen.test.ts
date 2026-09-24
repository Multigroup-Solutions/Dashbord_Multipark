import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: async () => null, createEmployee: vi.fn() }));

import { cityScope } from "./cityScope";
import { cityTextVisible, currentCityKeys, currentDefaultCityId, projectVisible } from "./extrasCityFilter";
import { duplicateReason, identityKeys, importExtrasFromCsv } from "./extrasImport";
import { daysBetween, findStaleExtras, median } from "./extrasMetrics";

const porto = { all: false, defaultCityId: 50, cityName: "Porto", cityNames: ["Porto"], cityIds: [50], projectIds: [50, 65], missingCostCenter: false };

describe("10. filtro por cidade", () => {
  it("projeto fora do âmbito some; sem projeto ou sem âmbito fica visível", () => {
    expect(projectVisible(65, [50, 65])).toBe(true);
    expect(projectVisible(10, [50, 65])).toBe(false);
    expect(projectVisible(null, [50, 65])).toBe(true);
    expect(projectVisible(10, undefined)).toBe(true);
  });
  it("cidade escrita na candidatura", () => {
    expect(cityTextVisible("Lisboa", ["porto"])).toBe(false);
    expect(cityTextVisible("Vila Nova de Gaia", ["porto"])).toBe(true);
    expect(cityTextVisible("Madrid", ["porto"])).toBe(true); // não reconhecida → visível
    expect(cityTextVisible("Lisboa", undefined)).toBe(true);
  });
  it("cidades e cidade por omissão do utilizador", () => cityScope.run(porto, () => {
    expect(currentCityKeys()).toEqual(["porto"]);
    expect(currentDefaultCityId()).toBe(50);
  }));
  it("quem vê todas → sem filtro e lead sem cidade", () => {
    expect(currentCityKeys()).toBeUndefined();
    expect(currentDefaultCityId()).toBeNull();
  });
});

describe("11. importação CSV", () => {
  it("chaves de identidade normalizadas", () => {
    expect(identityKeys({ email: " Ana@X.PT ", nif: "123 456 789", phone: "912 345 678" })).toEqual([
      "email:ana@x.pt", "nif:123456789", "tel:+351912345678",
    ]);
    expect(identityKeys({ nif: "12" })).toEqual([]);
  });
  it("duplicado de ficha existente ou de outra linha do ficheiro", () => {
    const existing = new Map([["nif:123456789", { id: 7, fullName: "Ana" }]]);
    const seen = new Map([["tel:+351912345678", 3]]);
    expect(duplicateReason(["nif:123456789"], existing, seen)).toBe("Já existe a ficha Ana (#7) com o mesmo NIF.");
    expect(duplicateReason(["tel:+351912345678"], existing, seen)).toBe("Repete a linha 3 (mesmo telemóvel).");
    expect(duplicateReason(["email:x@y.pt"], existing, seen)).toBeNull();
  });
  it("sem cidade não importa nada", async () => {
    const r = await importExtrasFromCsv("nome,nivel\nAna,junior", 1, {});
    expect(r.created).toBe(0);
    expect(r.errors[0].reason).toMatch(/cidade/);
  });
});

describe("12/13. métricas e extras parados", () => {
  it("mediana", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 10])).toBe(3.5);
  });
  it("dias entre datas", () => expect(daysBetween("2026-06-01 10:00:00", "2026-09-24")).toBe(115));
  it("parados há mais de 90 dias; ficha nova sem trabalho ainda não conta", () => {
    const r = findStaleExtras(
      [
        { id: 1, fullName: "Ana", createdAt: "2025-01-01" },
        { id: 2, fullName: "Bruno", createdAt: "2025-01-01" },
        { id: 3, fullName: "Carla", createdAt: "2026-09-01" },
        { id: 4, fullName: "Duarte", createdAt: "2026-01-01" },
      ],
      { 1: "2026-09-20", 2: "2026-05-01" },
      "2026-09-24",
    );
    expect(r.map((x) => [x.fullName, x.lastWorked, x.idleDays])).toEqual([
      ["Duarte", null, 266],
      ["Bruno", "2026-05-01", 146],
    ]);
  });
});
