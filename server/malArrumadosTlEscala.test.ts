/**
 * 14 out 2026 (Jorge):
 *  A) Passagem de turno → estado do parque: os mal arrumados resumidos por
 *     tipo ("Descoberto em COBERTO · 11 carros"), lista só ao abrir a linha.
 *  B) Extras-Dia: o TL de um turno só pode ser alguém cuja CONTA tem
 *     permissões de Team Leader — no seletor e ao guardar (API).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { groupMisplaced } from "../shared/garageFit";
import { canBeTeamLeader, teamLeaderRefusal, teamLeaderRefusalMessage } from "../shared/teamLeaderEligibility";
import { pickerSections, type PickerCandidate } from "../client/src/pages/extrasDia/PersonPicker";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

type Car = { id: string; plate: string; spotType: string; garage: string | null; phase: string; parkName: string | null; spot: string | null };
let n = 0;
const car = (spotType: string, garage: string | null, extra: Partial<Car> = {}): Car =>
  ({ id: String(++n), plate: `AA-${n}`, spotType, garage, phase: "in_park", parkName: "Redpark - Lisboa", spot: String(n), ...extra });

describe("A — mal arrumados resumidos por tipo", () => {
  it("uma linha por tipo × garagem, com a contagem; mal arrumados primeiro, depois os \"se der\"", () => {
    const cars = [
      ...Array.from({ length: 3 }, () => car("covered", "PD")),
      ...Array.from({ length: 2 }, () => car("uncovered", "COBERTO")),
      car("uncovered", " coberto "),
      ...Array.from({ length: 2 }, () => car("indoor", "PD")),
      car("indoor", "PD FORA"),
      car("covered", "PD FORA"),
      car("uncovered", "PD"), // ok — não entra
      car("covered", "COBERTO"), // ok
      car("indoor", "Garagem X"), // garagem desconhecida — nunca se adivinha
      car("uncovered", "COBERTO", { phase: "moving" }), // em movimento — não conta
    ];
    const g = groupMisplaced(cars);
    expect(g.map((x) => [x.fit, x.label, x.items.length])).toEqual([
      ["bad", "Descoberto em COBERTO", 3],
      ["bad", "Interior em PD", 2],
      ["bad", "Interior em PD FORA", 1],
      ["warn", "Toldo em PD (se der, coberta)", 3],
      ["warn", "Toldo em PD FORA (se der, coberta)", 1],
    ]);
  });
  it("dentro de cada linha, os carros vêm por parque e lugar (números por ordem)", () => {
    const g = groupMisplaced([
      car("indoor", "PD", { parkName: "Redpark - Lisboa", spot: "10" }),
      car("indoor", "PD", { parkName: "Airpark - Lisboa", spot: "7" }),
      car("indoor", "PD", { parkName: "Redpark - Lisboa", spot: "2" }),
    ]);
    expect(g[0].items.map((c) => `${c.parkName} ${c.spot}`)).toEqual(["Airpark - Lisboa 7", "Redpark - Lisboa 2", "Redpark - Lisboa 10"]);
  });
  it("sem nada mal arrumado → sem linhas", () => {
    expect(groupMisplaced([car("uncovered", "PD"), car("covered", "COBERTO")])).toEqual([]);
  });
  it("o ecrã mostra o resumo fechado por omissão e abre a lista ao clicar", () => {
    const ui = src("client/src/components/ShiftHandoverLiveState.tsx");
    expect(ui).toContain("groupMisplaced(cars)");
    expect(ui).toContain("aria-expanded={open}");
    expect(ui).toContain("new Set()"); // nenhuma linha aberta ao entrar
    expect(ui).toMatch(/Mal arrumados: /);
    expect(ui).toContain('toldo{warn === 1 ? "" : "s"} numa descoberta');
    // já não há uma pílula por carro
    expect(ui).not.toContain('"se der, coberta"}</Badge>');
  });
});

describe("B — TL da escala: só contas com permissões de Team Leader", () => {
  it("papel team_leader ou acima pode; extra, condutor e user não", () => {
    for (const role of ["team_leader", "supervisor", "frontoffice", "backoffice", "admin", "super_admin"]) {
      expect(canBeTeamLeader({ role, isActive: 1 }), role).toBe(true);
    }
    for (const role of ["extra", "condutor", "user", "", null]) {
      expect(teamLeaderRefusal({ role, isActive: 1 }), String(role)).toBe("role_below");
    }
  });
  it("um extra com a permissão de TL na conta pode; sem ela não; negada tira até a um TL", () => {
    expect(canBeTeamLeader({ role: "extra", isActive: 1 }, "grant")).toBe(true);
    expect(canBeTeamLeader({ role: "extra", isActive: 1 })).toBe(false);
    expect(teamLeaderRefusal({ role: "team_leader", isActive: 1 }, "deny")).toBe("denied");
  });
  it("sem conta ou com a conta desativada não pode (o posto da ficha não chega)", () => {
    expect(teamLeaderRefusal(null)).toBe("no_account");
    expect(teamLeaderRefusal(undefined, "grant")).toBe("no_account");
    expect(teamLeaderRefusal({ role: "supervisor", isActive: 0 })).toBe("inactive_account");
    expect(teamLeaderRefusal({ role: "extra", isActive: false }, "grant")).toBe("inactive_account");
  });
  it("as mensagens dizem o que fazer", () => {
    expect(teamLeaderRefusalMessage("Rui", "role_below")).toMatch(/^Rui não pode ser Team Leader: .*Permissões/);
    expect(teamLeaderRefusalMessage("Rui", "no_account")).toMatch(/Utilizadores/);
  });
  // o comportamento no servidor (lista e gravação) está em server/tlEscalaComportamento.test.ts
  it("o seletor do TL já não mostra o resto do RH", () => {
    const c = (id: number, fullName: string): PickerCandidate => ({ id, fullName, city: "lisbon" });
    const secs = pickerSections([c(1, "Ana TL")], "lisbon", "");
    expect(secs.map((s) => s.key)).toEqual(["here"]);
    const ui = src("client/src/pages/extrasDia/PersonPicker.tsx");
    expect(ui).not.toContain("ainda sem permissão de TL");
    // a página já não tem o atalho "Permitir ser TL" nem manda o resto do RH ao TL
    const page = src("client/src/pages/ExtrasDiaPage.tsx");
    expect(page).not.toMatch(/tlOthers|pickedOther|allowTeamLeader|Permitir ser TL/);
    expect(page).not.toContain("muda o posto no RH");
    expect(src("server/routers.ts")).not.toContain("muda o posto no RH para Team Leader");
  });
});
