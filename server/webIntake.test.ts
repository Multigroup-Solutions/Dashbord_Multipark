import { describe, expect, it } from "vitest";
import {
  SLOT_RANGES,
  mapWebsiteDay,
  normalizeEmail,
  parseFreeTextRange,
  planCostCenterAssignment,
  resolveApprovalCostCenter,
} from "./webIntake";
import type { ProjectNode } from "./employeeCity";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Joao.Silva@Gmail.COM ")).toBe("joao.silva@gmail.com");
  });
});

// ─── Aprovação: centro de custos (cidade) ───────────────────────────────────

const HIERARCHY: ProjectNode[] = [
  { id: 1, parentId: null, name: "Multipark", level: "group" },
  { id: 10, parentId: 1, name: "Lisboa", level: "city" },
  { id: 20, parentId: 1, name: "Porto", level: "city" },
  { id: 30, parentId: 1, name: "Faro", level: "city" },
  { id: 100, parentId: 10, name: "Airpark", level: "brand" },
  { id: 101, parentId: 100, name: "Airpark Lisboa Parque 1", level: "project" },
  { id: 900, parentId: null, name: "Marketing Geral", level: "project" },
];

describe("resolveApprovalCostCenter", () => {
  it("aceita um nó de cidade (o caso normal da UI)", () => {
    expect(resolveApprovalCostCenter(HIERARCHY, 20)).toEqual({ projectId: 20, projectName: "Porto", city: "porto" });
  });
  it("aceita um descendente da cidade e resolve a cidade pela árvore", () => {
    expect(resolveApprovalCostCenter(HIERARCHY, 101)).toEqual({
      projectId: 101,
      projectName: "Airpark Lisboa Parque 1",
      city: "lisboa",
    });
  });
  it("recusa um centro de custos inexistente", () => {
    expect(() => resolveApprovalCostCenter(HIERARCHY, 999)).toThrow(/inexistente/);
  });
  it("recusa um nó que não pertence a nenhuma cidade (ficaria invisível às cidades)", () => {
    expect(() => resolveApprovalCostCenter(HIERARCHY, 900)).toThrow(/não pertence a nenhuma cidade/);
    // o grupo raiz também não é uma cidade
    expect(() => resolveApprovalCostCenter(HIERARCHY, 1)).toThrow(/não pertence a nenhuma cidade/);
  });
});

describe("planCostCenterAssignment", () => {
  it("ficha criada agora: já nasceu com o centro de custos, nada a atribuir", () => {
    expect(planCostCenterAssignment(null, 10, true)).toEqual({ assign: false, outcome: "assigned_on_create" });
  });
  it("ficha existente sem centro de custos → atribui o escolhido", () => {
    expect(planCostCenterAssignment(null, 10, false)).toEqual({ assign: true, outcome: "assigned" });
    expect(planCostCenterAssignment(undefined, 10, false)).toEqual({ assign: true, outcome: "assigned" });
  });
  it("ficha existente já com o mesmo centro → nada a fazer", () => {
    expect(planCostCenterAssignment(10, 10, false)).toEqual({ assign: false, outcome: "already_same" });
  });
  it("ficha existente com OUTRO centro → mantém (a ficha é a fonte de verdade)", () => {
    expect(planCostCenterAssignment(20, 10, false)).toEqual({ assign: false, outcome: "kept_existing" });
  });
});

// ─── Slots do formulário do site ────────────────────────────────────────────

describe("SLOT_RANGES", () => {
  it("a manhã começa às 03h (site multidriver desde 2026-09-17)", () => {
    expect(SLOT_RANGES["03H-08H"]).toEqual({ from: 3, to: 8 });
    expect(SLOT_RANGES["03H-15H"]).toEqual({ from: 3, to: 15 });
  });
  it("os slots antigos 04H-* continuam aceites (submissões da versão anterior)", () => {
    expect(SLOT_RANGES["04H-08H"]).toEqual({ from: 4, to: 8 });
    expect(SLOT_RANGES["04H-15H"]).toEqual({ from: 4, to: 15 });
  });
  it("mapWebsiteDay aceita o slot novo da manhã", () => {
    expect(mapWebsiteDay(["03H-08H"], "")).toEqual({ morning: true, night: false, fromHour: 3, toHour: 8, note: null });
  });
});

describe("parseFreeTextRange", () => {
  it("parses 09H-18H", () => {
    expect(parseFreeTextRange("09H-18H")).toEqual({ from: 9, to: 18 });
  });
  it("parses '9 às 18'", () => {
    expect(parseFreeTextRange("9 às 18")).toEqual({ from: 9, to: 18 });
  });
  it("extends ranges crossing midnight", () => {
    expect(parseFreeTextRange("22H-02H")).toEqual({ from: 22, to: 26 });
  });
  it("rejects non-hours", () => {
    expect(parseFreeTextRange("talvez")).toBeNull();
    expect(parseFreeTextRange("99-105")).toBeNull();
  });
});

describe("mapWebsiteDay", () => {
  it("returns null for an empty day", () => {
    expect(mapWebsiteDay([], "")).toBeNull();
  });

  it("keeps 'NÃO' as a note only (day counts as answered but unavailable)", () => {
    expect(mapWebsiteDay([], "NÃO")).toEqual({ note: "NÃO" });
    expect(mapWebsiteDay([], "nao")).toEqual({ note: "nao" });
  });

  it("maps a single morning slot", () => {
    expect(mapWebsiteDay(["08H-15H"], "")).toEqual({
      morning: true,
      night: false,
      fromHour: 8,
      toHour: 15,
      note: null,
    });
  });

  it("maps a night slot crossing midnight (toHour stored mod 24)", () => {
    expect(mapWebsiteDay(["15H-01H"], "")).toEqual({
      morning: false,
      night: true,
      fromHour: 15,
      toHour: 1,
      note: null,
    });
  });

  it("unions multiple slots into one range with both shifts", () => {
    expect(mapWebsiteDay(["04H-08H", "18H-01H"], "")).toEqual({
      morning: true,
      night: true,
      fromHour: 4,
      toHour: 1,
      note: null,
    });
  });

  it("parses an hour range out of free text", () => {
    expect(mapWebsiteDay([], "09H-18H")).toEqual({
      morning: true,
      night: true,
      fromHour: 9,
      toHour: 18,
      note: "09H-18H",
    });
  });

  it("keeps uninterpretable free text as a note", () => {
    expect(mapWebsiteDay([], "só se for mesmo preciso")).toEqual({ note: "só se for mesmo preciso" });
  });

  it("ignores unknown slot codes but keeps valid ones", () => {
    expect(mapWebsiteDay(["XX", "04H-15H"], "")).toEqual({
      morning: true,
      night: false,
      fromHour: 4,
      toHour: 15,
      note: null,
    });
  });
});
