import { describe, expect, it } from "vitest";
import {
  AVAILABILITY_PAGE_SIZE,
  availabilityStatus,
  countAvailabilityStatuses,
  defaultOpenGroups,
  groupByCity,
  matchesAvailabilityStatus,
  visibleSlice,
} from "../shared/availabilityGroups";

const row = (id: number, city: "lisboa" | "porto" | "faro" | null, responded = false, availableDays = 0) => ({
  id, city, responded, availableDays,
});

describe("disponibilidade — estado de resposta", () => {
  it("distingue disponível, indisponível e sem resposta", () => {
    expect(availabilityStatus(row(1, null, true, 2))).toBe("available");
    expect(availabilityStatus(row(1, null, true, 0))).toBe("unavailable");
    expect(availabilityStatus(row(1, null, false, 0))).toBe("no_answer");
  });

  it("filtra e conta por estado", () => {
    const rows = [row(1, "lisboa", true, 3), row(2, "porto", true, 0), row(3, null), row(4, "faro")];
    expect(rows.filter((r) => matchesAvailabilityStatus(r, "no_answer")).map((r) => r.id)).toEqual([3, 4]);
    expect(rows.filter((r) => matchesAvailabilityStatus(r, "all"))).toHaveLength(4);
    expect(countAvailabilityStatuses(rows)).toEqual({ all: 4, available: 1, unavailable: 1, no_answer: 2 });
  });
});

describe("disponibilidade — secções por cidade", () => {
  const rows = [row(1, "porto"), row(2, null), row(3, "lisboa"), row(4, "porto"), row(5, "porto")];

  it("ordem fixa das cidades, sem grupos vazios, e mantém a ordem dentro do grupo", () => {
    const groups = groupByCity(rows);
    expect(groups.map((g) => g.key)).toEqual(["lisboa", "porto", "none"]);
    expect(groups[1].rows.map((r) => r.id)).toEqual([1, 4, 5]);
  });

  it("abre só a mais relevante: a do filtro, senão a maior; com pesquisa abre todas", () => {
    const groups = groupByCity(rows);
    expect([...defaultOpenGroups(groups)]).toEqual(["porto"]);
    expect([...defaultOpenGroups(groups, { preferred: "lisboa" })]).toEqual(["lisboa"]);
    expect([...defaultOpenGroups(groups, { preferred: "faro" })]).toEqual(["porto"]);
    expect([...defaultOpenGroups(groups, { searching: true })]).toEqual(["lisboa", "porto", "none"]);
    expect([...defaultOpenGroups([])]).toEqual([]);
  });

  it("mostrar mais: fatias limitadas e o que falta", () => {
    const many = Array.from({ length: 60 }, (_, i) => i);
    expect(visibleSlice(many, AVAILABILITY_PAGE_SIZE)).toMatchObject({ remaining: 35 });
    expect(visibleSlice(many, AVAILABILITY_PAGE_SIZE).visible).toHaveLength(25);
    expect(visibleSlice(many, 1000)).toMatchObject({ remaining: 0 });
    expect(visibleSlice(many, -5)).toMatchObject({ visible: [], remaining: 60 });
  });
});
